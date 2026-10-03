"""The analysis of R cells, run in an R kernel through jupyter_client as the view runs it.

Design iteration 1.79: kernel_code/r/analyze_cells.R reads each R cell with
R's own parser and gives the message of kernel_code/analyze_cells.py, so the
view draws the chips of an R cell as it draws those of a Python cell: the
constants that a cell assigns at the top level, the arguments that its calls
pass, and the defaults of a table of R functions that change results. It
also gives the names a cell defines and uses, the columns it touches and its
formulas, and with ``signatures`` the formals of the functions of R's
packages that it calls, for "Find more defaults with AI" (1.53).

The tests share one R kernel, which starts in a folder of its own, and empty
its global environment before each test. They skip unless jupyter_client
finds an R kernelspec, such as xeus-r's xr (TESTING.md). lme4 and car are
not installed in the R environment of this machine: their functions come
from the table, which needs no package.
"""

from __future__ import annotations

import json
import queue
import re
import shutil
from pathlib import Path

import pytest
from jupyter_client.kernelspec import KernelSpecManager
from jupyter_client.manager import start_new_kernel

HERE = Path(__file__).parent
KERNEL_CODE = HERE.parent / "kernel_code" / "r"
EXAMPLES = HERE.parents[2] / "examples"
# The real SAS notebook and its R version are in the repository that holds
# whybook as a submodule, beside the SAS kernel that whybook does not ship.
REAL_SAS = HERE.parents[3] / "research" / "sas_kernel" / "sgf2019_gaines"
MIME = "application/vnd.whybook.result+json"
SECRETS = json.loads((HERE / "data" / "secret_names.json").read_text())["cases"]


def r_kernelspec() -> str | None:
    """An installed R kernelspec that runs without a provisioner, such as xeus-r's xr; None without one."""
    for name, folder in sorted(KernelSpecManager().find_kernel_specs().items()):
        try:
            spec = json.loads((Path(folder) / "kernel.json").read_text())
        except (OSError, ValueError):
            continue
        if (spec.get("language") or "").lower() == "r" and "kernel_provisioner" not in (spec.get("metadata") or {}):
            return name
    return None


R_KERNEL = r_kernelspec()
pytestmark = pytest.mark.skipif(R_KERNEL is None, reason="no R kernelspec: TESTING.md has the commands for xeus-r")


def call(name: str, args: dict) -> str:
    """The code that the R adapter of the view sends (src/model/languages.ts): the program, its call with JSON arguments, and its removal."""
    code = (KERNEL_CODE / f"{name}.R").read_text()
    payload = json.dumps(json.dumps(args))
    return (
        f"{code}\ntryCatch(.whybook_{name}(jsonlite::fromJSON({payload}, simplifyVector = FALSE)),\n"
        f'  error = function(e) IRdisplay::publish_mimebundle(list("{MIME}" = list(error = conditionMessage(e)))),\n'
        f'  finally = rm(list = ".whybook_{name}", envir = globalenv()))\n'
    )


class Kernel:
    """One R kernel, and the folder it runs in."""

    def __init__(self, client, folder: Path):
        self.client = client
        self.folder = folder

    def execute(self, code: str, silent: bool = False) -> tuple[list, list]:
        """Run code; the results it displays with the view's MIME type, and its errors."""
        msg_id = self.client.execute(code, silent=silent, store_history=False)
        results, errors = [], []
        while True:
            try:
                msg = self.client.get_iopub_msg(timeout=120)
            except queue.Empty:
                raise AssertionError("the R kernel did not answer in 120 s") from None
            if msg["parent_header"].get("msg_id") != msg_id:
                continue
            kind, content = msg["msg_type"], msg["content"]
            if kind in ("display_data", "execute_result") and MIME in content["data"]:
                results.append(content["data"][MIME])
            elif kind == "error":
                errors.append(f"{content['ename']}: {content['evalue']}")
            elif kind == "status" and content["execution_state"] == "idle":
                return results, errors

    def run(self, code: str) -> None:
        """Run a cell, as Run does, and fail on its error."""
        _, errors = self.execute(code)
        assert errors == []

    def analyse(self, cells: list[str], **args) -> dict:
        """The analysis of each cell, by its id: c0, c1 and on."""
        body = {"cells": [{"id": f"c{index}", "source": source} for index, source in enumerate(cells)], **args}
        results, errors = self.execute(call("analyze_cells", body), silent=True)
        assert errors == [] and len(results) == 1
        assert "error" not in results[0], results[0].get("error")
        return results[0]["cells"]

    def one(self, source: str, **args) -> dict:
        return self.analyse([source], **args)["c0"]


@pytest.fixture(scope="module")
def r(tmp_path_factory):
    folder = tmp_path_factory.mktemp("r-analysis")
    manager, client = start_new_kernel(kernel_name=R_KERNEL, cwd=str(folder))
    try:
        yield Kernel(client, folder)
    finally:
        client.stop_channels()
        manager.shutdown_kernel(now=True)


@pytest.fixture(autouse=True)
def empty(r):
    """Each test starts from an empty global environment."""
    r.run("rm(list = ls(all.names = TRUE), envir = globalenv())")


def chips(analysis: dict) -> list[tuple]:
    """Each decision as (provenance, name, value, function, the lines of its calls)."""
    return [
        (decision["provenance"], decision["name"], decision["value"], decision["function"], [call["line"] for call in decision.get("calls", [])])
        for decision in analysis["decisions"]
    ]


VISITS = """visits <- data.frame(
  patient = rep(1:4, each = 3),
  week = rep(c(0, 4, 8), times = 4),
  arm = factor(rep(c("A", "B"), each = 6)),
  pain = c(6, 5, 4, 7, 6, 6, 5, 3, 2, 6, 4, 3)
)"""


def test_a_constant_an_explicit_argument_and_a_known_default_are_chips(r):
    r.run(VISITS)
    analysis = r.one(
        "MIN_DAYS <- 14\n"
        "fit <- lme4::lmer(pain ~ week + (1 | patient), data = visits, REML = FALSE)\n"
        "fit0 <- lme4::lmer(pain ~ week + (1 | patient), data = visits)"
    )
    # The defaults first, then the values written in the cell, in the order of the code.
    assert chips(analysis) == [
        ("library_default", "na.action", "na.omit", "lme4::lmer", [2, 3]),
        ("library_default", "REML", "TRUE", "lme4::lmer", [3]),
        ("literal", "MIN_DAYS", "14", None, []),
        ("literal", "REML", "FALSE", "lme4::lmer", [2]),
    ]
    reml = analysis["decisions"][1]
    assert reml["param"] == "REML"
    assert reml["note"] == "REML fit: likelihoods cannot compare models with different fixed effects"
    # Each call is named where the cell names the function, with the frame it works on.
    assert reml["calls"] == [{"line": 3, "col": 14, "target": "visits"}]
    # A constant has no call, and names no parameter or function.
    constant = analysis["decisions"][2]
    assert (constant["param"], constant["function"], "calls" in constant) == (None, None, False)
    # Week and patient are numbers: the coding of factors changes nothing in this model.
    assert "contrasts" not in [decision["name"] for decision in analysis["decisions"]]


def test_a_cell_shows_at_most_six_decisions(r):
    source = "\n".join(f"x{index} <- {index}" for index in range(9))
    assert [decision["name"] for decision in r.one(source)["decisions"]] == ["x0", "x1", "x2", "x3", "x4", "x5"]
    assert len(r.one(source, max_decisions=8)["decisions"]) == 8


# A cell for each row of the table, and the default it shows: name, value,
# function. The frames come from SETUP.
SETUP = VISITS + """
other <- data.frame(patient = 1:3, site = c("x", "y", "z"))
p <- c(0.01, 0.02, 0.04)
counts <- matrix(c(12, 5, 7, 9), nrow = 2)
lm_fit <- lm(pain ~ week, data = visits)
glm_fit <- glm(I(pain > 4) ~ week, family = binomial, data = visits)"""
TABLE = [
    ("t.test(pain ~ arm, data = visits)", ("var.equal", "FALSE", "stats::t.test")),
    ("merge(visits, other)", ("all", "FALSE", "base::merge")),
    ("cor(visits$week, visits$pain)", ("method", '"pearson"', "stats::cor")),
    ("cor.test(visits$week, visits$pain)", ("method", '"pearson"', "stats::cor.test")),
    ("quantile(visits$pain, 0.9)", ("type", "7", "stats::quantile")),
    ("p.adjust(p)", ("method", '"holm"', "stats::p.adjust")),
    ('read.csv("visits.csv")', ("na.strings", '"NA"', "utils::read.csv")),
    # The first line names the columns, as read.table does not (design iteration 1.86).
    ('read.csv("visits.csv")', ("header", "TRUE", "utils::read.csv")),
    ('read.csv2("visits.csv")', ("header", "TRUE", "utils::read.csv2")),
    ('read.delim("visits.txt")', ("header", "TRUE", "utils::read.delim")),
    ('read.table("visits.txt")', ("header", "FALSE", "utils::read.table")),
    ("glm(pain ~ week, data = visits)", ("family", "gaussian", "stats::glm")),
    ("lm(pain ~ arm + week, data = visits)", ("contrasts", '"contr.treatment"', "stats::lm")),
    ("lm(pain ~ week, data = visits)", ("na.action", "na.omit", "stats::lm")),
    ("anova(lm_fit)", ("SS", "Type I", "stats::anova")),
    ("car::Anova(lm_fit)", ("type", '"II"', "car::Anova")),
    ("chisq.test(counts)", ("correct", "TRUE", "stats::chisq.test")),
    ("prop.test(c(12, 7), c(20, 20))", ("correct", "TRUE", "stats::prop.test")),
    ("predict(glm_fit, newdata = visits)", ("type", '"link"', "stats::predict")),
    ("table(visits$arm)", ("useNA", '"no"', "base::table")),
    ("glmer(I(pain > 4) ~ week + (1 | patient), data = visits, family = binomial)", ("nAGQ", "1L", "lme4::glmer")),
]


@pytest.mark.parametrize(("source", "expected"), TABLE, ids=[source for source, _ in TABLE])
def test_each_default_of_the_table_is_a_chip(r, source, expected):
    r.run(SETUP)
    found = [(decision["name"], decision["value"], decision["function"]) for decision in r.one(source)["decisions"] if decision["provenance"] == "library_default"]
    assert expected in found


def test_a_default_of_the_table_names_its_package_and_that_packages_version(r):
    """The popover says "default in utils 4.4.3" (design iteration 1.86)."""
    header = next(decision for decision in r.one('read.csv("visits.csv")')["decisions"] if decision["name"] == "header")
    assert header["library"] == "utils"
    assert re.fullmatch(r"\d+\.\d+(\.\d+)?", header["version"]), header


# Calls where the default of the table does not apply, and the default left out.
NOT_SHOWN = [
    ("t.test(visits$pain)", "var.equal"),  # one sample
    ("t.test(visits$pain, visits$week, paired = TRUE)", "var.equal"),
    ("merge(visits, other, all.x = TRUE)", "all"),  # a left join
    ("anova(lm_fit, lm(pain ~ week + arm, data = visits))", "SS"),  # two models compared
    ("predict(lm_fit)", "type"),  # a linear model predicts on the scale of its outcome
    ("lm(pain ~ week, data = visits)", "contrasts"),  # no factor in the model
    ("merge(visits, other)", "all"),  # the analyst's own merge, which SETUP_MERGE defines
]
SETUP_MERGE = "merge <- function(x, y) x"


@pytest.mark.parametrize(("index", "source", "left_out"), [(index, *case) for index, case in enumerate(NOT_SHOWN)], ids=[source for source, _ in NOT_SHOWN])
def test_a_default_that_does_not_apply_is_no_chip(r, index, source, left_out):
    r.run(SETUP)
    if index == len(NOT_SHOWN) - 1:
        r.run(SETUP_MERGE)
    names = [decision["name"] for decision in r.one(source)["decisions"] if decision["provenance"] == "library_default"]
    assert left_out not in names


def test_arguments_bind_to_formals_by_name_by_a_start_of_a_name_and_by_position(r):
    r.run(SETUP)
    analysis = r.one(
        "q <- quantile(visits$pain, 0.9)\n"
        "tt <- t.test(pain ~ arm, data = visits, var = TRUE)\n"
        "adjusted <- p.adjust(p, 'BH')"
    )
    assert chips(analysis) == [
        ("library_default", "type", "7", "stats::quantile", [1]),
        ("literal", "probs", "0.9", "stats::quantile", [1]),
        # var is the start of var.equal alone, as R matches it: no default left.
        ("literal", "var.equal", "TRUE", "stats::t.test", [2]),
        ("literal", "method", "'BH'", "stats::p.adjust", [3]),
    ]


def test_a_pipe_passes_the_first_argument(r):
    r.run(SETUP)
    analysis = r.one("joined <- visits |> merge(other, by = 'patient')\nfit <- visits |> lm(pain ~ arm, data = _)")
    merge, contrasts, na_action = analysis["decisions"][:3]
    # The frame that the pipe passes is x: the merge joins other.
    assert (merge["name"], merge["calls"][0]["target"]) == ("all", "other")
    # data = _ takes the frame, whose arm is a factor.
    assert (contrasts["name"], contrasts["calls"][0]["target"]) == ("contrasts", "visits")
    assert na_action["name"] == "na.action"


def test_the_chips_of_the_values_a_cell_writes(r):
    r.run(SETUP)
    analysis = r.one(
        'raw <- read.csv("data/visits.csv", stringsAsFactors = TRUE)\n'
        "fit <- glm(I(pain > 4) ~ week, family = binomial(link = \"probit\"), data = visits)\n"
        "s <- sample(1:10, size = 3, replace = TRUE)\n"
        "big <- quantile(visits$pain, probs = c(0.1, 0.5, 0.9), type = 6)\n"
        "neg <- scale(visits$pain, center = -1.5)\n"
        "picked <- merge(visits, other, by = 'patient')\n"
        "print(round(mean(visits$pain), 2))",
        max_decisions=20,
    )
    literals = [(name, value) for provenance, name, value, _, _ in chips(analysis) if provenance == "literal"]
    assert literals == [
        # The file a reader reads, which the chip shows by its name.
        ("file", '"data/visits.csv"'),
        ("stringsAsFactors", "TRUE"),
        # The family of a model is a choice, written as code.
        ("family", 'binomial(link = "probit")'),
        ("link", '"probit"'),
        ("size", "3"),
        ("replace", "TRUE"),
        ("probs", "c(0.1, 0.5, 0.9)"),
        ("type", "6"),
        ("center", "-1.5"),
    ]
    # by names a column, sample's x holds data, and print and round choose nothing.
    names = [decision["name"] for decision in analysis["decisions"]]
    assert {"by", "x", "digits"}.isdisjoint(names)
    read = next(decision for decision in analysis["decisions"] if decision["name"] == "file")
    assert (read["function"], read["calls"][0]["target"]) == ("utils::read.csv", "visits")


HELPERS = """MIN_WEEK <- 4

# Weekly pain of each patient
weekly_pain <- function(d, from = MIN_WEEK, slope = "week", drop = TRUE) {
  d[d$week >= from, ]
}
"""


def test_a_function_of_the_analysts_file_shows_the_defaults_it_leaves(r):
    (r.folder / "helpers.R").write_text(HELPERS)
    r.run(VISITS + '\nsource("helpers.R")\nin_cell <- function(d, n = 2) d')
    analysis = r.one("w <- weekly_pain(visits, drop = FALSE)\nmine <- in_cell(visits)")
    # The constant that a default names, with its line of the file, then a value written as the default.
    assert chips(analysis) == [
        ("defaulted", "MIN_WEEK", "4", "weekly_pain", [1]),
        ("defaulted", "slope", '"week"', "weekly_pain", [1]),
        ("literal", "drop", "FALSE", "weekly_pain", [1]),
    ]
    constant, slope = analysis["decisions"][:2]
    assert (constant["param"], constant["source"]) == ("from", {"file": "helpers.R", "line": 1})
    assert (slope["param"], slope["source"]) == ("slope", {"file": "helpers.R", "line": None})
    # The function's first lines, after the line of the constant.
    assert analysis["attachments"] == [
        {
            "file": "helpers.R",
            "symbol": "weekly_pain",
            "start": 4,
            "end": 6,
            "lines": [[1, "MIN_WEEK <- 4"], [None, "\u2026"], [4, 'weekly_pain <- function(d, from = MIN_WEEK, slope = "week", drop = TRUE) {'], [5, "  d[d$week >= from, ]"], [6, "}"]],
            "highlight": [1],
        }
    ]
    # A function that a cell defines comes from no file: its defaults are no chips.
    assert "in_cell" in analysis["uses"] and "n" not in [decision["name"] for decision in analysis["decisions"]]
    # source() reads the file, as an import does, and chooses nothing.
    assert r.one('source("helpers.R")')["decisions"] == []


def test_the_names_that_label_a_table_are_no_chips(r):
    r.run(SETUP)
    analysis = r.one('both <- rbind(cbind(model = "all", arm = "A"), cbind(model = "no east", arm = "B"))\nd2 <- data.frame(site = "x", n = 3)')
    assert analysis["decisions"] == []


def test_calls_that_leave_the_same_default_share_one_decision(r):
    r.run(SETUP)
    analysis = r.one("a <- merge(visits, other)\nb <- merge(other, visits)\nc <- merge(visits, other, all = TRUE)")
    joins = [(decision["provenance"], decision["value"], [(call["line"], call["target"]) for call in decision["calls"]]) for decision in analysis["decisions"]]
    assert joins == [
        ("library_default", "FALSE", [(1, "other"), (2, "visits")]),
        ("literal", "TRUE", [(3, "other")]),
    ]


def test_names_defined_and_used_columns_and_formulas(r):
    r.run(SETUP + "\nMIN_WEEK <- 2")
    analysis = r.one(
        "visits$late <- visits$week >= MIN_WEEK\n"
        "later <- subset(visits, week >= MIN_WEEK)\n"
        "fit2 <- lm(pain ~ arm * late, data = later)\n"
        "helper <- function(x) { inner <- x + 1; inner * MIN_WEEK }\n"
        "for (i in 1:2) total <- i\n"
        "assign('made', 3)"
    )
    # A name assigned in a function's body is the function's own.
    assert analysis["defs"] == ["fit2", "helper", "i", "later", "made", "total", "visits"]
    # The names of the kernel that the cell reads; visits changes in place, so it is read too.
    assert analysis["uses"] == ["MIN_WEEK", "visits"]
    # The columns: after $, in a formula, and as bare names, as subset reads them.
    assert analysis["columns"] == {"visits": ["arm", "pain", "week"]}
    assert analysis["formulas"] == ["pain ~ arm * late"]
    assert analysis["attachments"] == []


def test_a_frame_built_from_its_values_names_no_column(r):
    r.run('arms <- data.frame(arm = c("A", "B"), size = c(10, 12))')
    analysis = r.one('arms <- data.frame(arm = c("A", "B", "size"), size = c(10, 12, 3))')
    assert analysis["columns"] == {}


def test_the_lines_and_columns_of_a_call_count_utf8_bytes_as_python_does(r):
    r.run(SETUP)
    source = 'note <- "é"; m <- merge(visits, other)\n\tq <- quantile(visits$pain, 0.5)'
    analysis = r.one(source, max_decisions=10)
    places = {decision["function"]: (decision["calls"][0]["line"], decision["calls"][0]["col"]) for decision in analysis["decisions"] if decision.get("calls")}
    first, second = source.split("\n")
    assert places["base::merge"] == (1, len(first[: first.index("merge")].encode("utf-8")))
    assert places["stats::quantile"] == (2, len(second[: second.index("quantile")].encode("utf-8")))


def test_a_cell_that_does_not_parse_says_so_and_lists_nothing(r):
    analysis = r.one("fit <- lm(y ~ x,")
    assert analysis["error"].startswith("Parse error:")
    assert {key: analysis[key] for key in ("defs", "uses", "formulas", "columns", "decisions", "attachments")} == {
        "defs": [], "uses": [], "formulas": [], "columns": {}, "decisions": [], "attachments": []
    }
    # An empty cell lists nothing, and is no error.
    assert r.one("")["decisions"] == [] and "error" not in r.one("")


def test_the_analysis_leaves_no_names_behind_and_runs_nothing_of_the_cell(r):
    r.run(SETUP)
    before, _ = r.execute('IRdisplay::publish_mimebundle(list("%s" = list(names = ls(globalenv(), all.names = TRUE))))' % MIME)
    r.one("stop('ran')\nwritten <- 1\nfile.create('touched.txt')")
    after, _ = r.execute('IRdisplay::publish_mimebundle(list("%s" = list(names = ls(globalenv(), all.names = TRUE))))' % MIME)
    assert after == before
    assert not (r.folder / "touched.txt").exists()


def r_value(value) -> str:
    """A value of the shared cases as R writes it."""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, str):
        return json.dumps(value)
    return repr(value)


@pytest.fixture(scope="module")
def secret_chips(r):
    """The analysis of a cell for each shared case, `name <- value`, in one request."""
    r.run("rm(list = ls(all.names = TRUE), envir = globalenv())")
    return r.analyse([f"{case['name']} <- {r_value(case['value'])}" for case in SECRETS])


@pytest.mark.parametrize("index", range(len(SECRETS)), ids=[f"{case['name']}={case['value']!r}" for case in SECRETS])
def test_a_constant_that_holds_a_secret_is_no_chip(secret_chips, index):
    case = SECRETS[index]
    decisions = [(decision["name"], decision["value"]) for decision in secret_chips[f"c{index}"]["decisions"]]
    assert decisions == ([] if case["secret"] else [(case["name"], r_value(case["value"]))])


@pytest.fixture(scope="module")
def secret_listing(r):
    """What the R listing (kernel_code/r/inspect_variables.R) says of each shared case, `name <- value`, alone in the global environment."""
    listed = []
    for case in SECRETS:
        r.run("rm(list = ls(all.names = TRUE), envir = globalenv())")
        r.run(f"{case['name']} <- {r_value(case['value'])}")
        results, errors = r.execute(call("inspect_variables", {"known": {}}), silent=True)
        assert errors == [] and len(results) == 1
        [variable] = results[0]["variables"]
        listed.append(variable)
    return listed


@pytest.mark.parametrize("index", range(len(SECRETS)), ids=[f"{case['name']}={case['value']!r}" for case in SECRETS])
def test_the_r_listing_shows_a_secret_by_its_length_only(secret_listing, index):
    # The view keeps the listing in the notebook and sends it with every
    # request to a model, so it holds what the Python listing holds
    # (test_secret_names.py): a secret's length, never its text.
    case = SECRETS[index]
    listed = secret_listing[index]
    if case["secret"]:
        assert listed == {"name": case["name"], "label": case["name"], "kind": "constant", "type": "character", "secret": True, "length": len(case["value"])}
    else:
        assert (listed["kind"], listed["value"], "secret" in listed) == ("constant", r_value(case["value"]), False)


def test_the_r_listing_shows_a_long_text_by_its_length_as_python_does(r):
    query = "SELECT * FROM visits WHERE " + "arm = 1 OR " * 8 + "arm = 2"
    r.run(f"query <- {json.dumps(query)}")
    results, _ = r.execute(call("inspect_variables", {"known": {}}), silent=True)
    [listed] = results[0]["variables"]
    assert listed == {"name": "query", "label": "query", "kind": "other", "type": "character", "length": len(query)}


def test_the_signatures_of_the_functions_a_cell_calls(r):
    r.run(SETUP + "\nmine <- function(d, n = 3) head(d, n)")
    source = "m <- merge(visits, other, by = 'patient')\ntt <- t.test(pain ~ arm, data = visits)\nraw <- read.csv('visits.csv')\nfirst <- mine(visits)"
    assert "signatures" not in r.one(source)
    listed = {entry["name"]: entry for entry in r.one(source, signatures=True)["signatures"]}
    # The analyst's own function is left out; the method that the frame picks stands for merge.
    assert list(listed) == ["base::merge", "stats::t.test", "utils::read.csv"]
    merge = listed["base::merge"]
    assert {key: merge[key] for key in ("function", "module", "library", "language")} == {
        "function": "base::merge.data.frame", "module": "base", "library": "base", "language": "R"
    }
    r_version = r.execute('IRdisplay::publish_mimebundle(list("%s" = list(v = as.character(getRversion()))))' % MIME)[0][0]["v"]
    assert merge["version"] == r_version
    params = {param["name"]: param["default"] for param in merge["params"]}
    assert (params["all"], params["sort"], params["suffixes"]) == ("FALSE", "TRUE", '".x"')
    assert merge["calls"][0]["target"] == "other" and "by" not in merge["calls"][0]["defaulted"]
    assert "all" in merge["calls"][0]["defaulted"]
    # The formula method passes the rest to the default method, whose formals count too:
    # the first of match.arg's choices is the default.
    ttest = listed["stats::t.test"]
    assert ttest["function"] == "stats::t.test.formula"
    defaults = {param["name"]: param["default"] for param in ttest["params"]}
    assert (defaults["alternative"], defaults["var.equal"], defaults["na.action"]) == ('"two.sided"', "FALSE", "na.pass")
    # read.csv passes its ... to read.table, whose na.strings is a default of the read.
    read = {param["name"]: param["default"] for param in listed["utils::read.csv"]["params"]}
    assert (read["header"], read["na.strings"]) == ("TRUE", '"NA"')
    assert len(r.one(source, signatures=True, max_signatures=1)["signatures"]) == 1


@pytest.mark.demo
@pytest.mark.skipif(not REAL_SAS.is_dir(), reason="the real SAS notebook is in research/sas_kernel of the repository around whybook")
def test_the_r_version_of_the_real_sas_notebook_gets_its_chips(r):
    folder = REAL_SAS
    for name in ("titanicTrainClean.csv", "titanicTestClean.csv"):
        shutil.copy(folder / name, r.folder / name)
    notebook = json.loads((folder / "jupyterReport.R.ipynb").read_text())
    cells = ["".join(cell["source"]) for cell in notebook["cells"] if cell["cell_type"] == "code"]
    for source in cells:
        r.run(source)
    analysis = r.analyse(cells)
    # The header of both reads is a chip, and a cell shows six: the family comes last.
    assert [(provenance, name, value) for provenance, name, value, _, _ in chips(analysis["c0"])] == [
        ("library_default", "header", "TRUE"),
        ("library_default", "na.strings", '"NA"'),
        ("library_default", "contrasts", '"contr.treatment"'),
        ("library_default", "na.action", "na.omit"),
        ("literal", "file", '"titanicTrainClean.csv"'),
        ("literal", "file", '"titanicTestClean.csv"'),
    ]
    assert analysis["c0"]["formulas"] == ["survived ~ sex * age + pclass + fare + famSize"]
    assert chips(analysis["c2"]) == [("literal", "type", '"response"', "stats::predict", [1])]
