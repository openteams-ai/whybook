"""The chips of a file read and of the rows a cell shows, and where their questions go in "Worth asking next".

Design iterations 1.91 and 1.92, from the demo video of 7 October 2026. The
first cell of the video, ``nhefs = pd.read_csv("nhefs.csv")`` and
``nhefs.head()``, showed the chips ``header infer``, ``sep <no_default>``,
``n 5`` and ``na_values None``, and "Worth asking next" asked about the same
defaults first, through the whole analysis. The kernel's analysis runs in an
in-process IPython shell on the pain diary's state, as the kernel runs it.
"""

import pandas as pd
import pytest

from whybook.server.questions.cells import CellInfo, Decision, DecisionCall, alternative_code, decision_options, next_steps
from whybook.server.questions.models import Context

demo_only = pytest.mark.demo


def analyse(demo, source, **args):
    return demo.kernel("analyze_cells", {"cells": [{"id": "x", "source": source}], **args})["cells"]["x"]


def chips(analysis):
    return [(d["name"], d["value"]) for d in analysis["decisions"]]


def listed(analysis):
    return {signature["name"]: signature for signature in analysis["signatures"]}


# 1.91: the rows that a cell shows are no decision.


@demo_only
@pytest.mark.parametrize(
    "source",
    [
        "weekly.head(10)",
        "weekly.tail(4)",
        "weekly.sample(5)",
        "print(weekly.head(3))",
        "display(weekly.tail(3).round(2))",
        "weekly.head(3)['pain_score']",
        "print(weekly.to_string(max_rows=5))",
    ],
)
def test_the_rows_that_a_cell_only_shows_make_no_chip_and_go_to_no_model(demo, source):
    analysis = analyse(demo, source, signatures=True)
    assert chips(analysis) == []
    assert not set(listed(analysis)) & {"NDFrame.head", "NDFrame.tail", "NDFrame.sample", "DataFrame.to_string"}


@demo_only
def test_the_rows_that_a_name_keeps_or_a_file_gets_keep_their_chip(demo):
    analysis = analyse(demo, "top = weekly.head(12)\nfirst = weekly.head()\nweekly.sample(9).to_csv('sample.csv')", signatures=True)
    assert ("n", "12") in chips(analysis)
    assert ("n", "9") in chips(analysis)
    # The head that leaves n at its default is listed for the model.
    (head,) = listed(analysis)["NDFrame.head"]["calls"]
    assert (head["line"], head["defaulted"]) == (2, ["n"])


@demo_only
def test_a_call_that_picks_what_shows_keeps_its_own_chips(demo):
    """In weekly.sort_values(...).head(3) the sort chooses which rows show: it stays a choice, and the head does not."""
    analysis = analyse(demo, 'weekly.sort_values("pain_score", ascending=False).head(3)', signatures=True)
    assert chips(analysis) == [("ascending", "False")]
    assert "DataFrame.sort_values" in listed(analysis)
    assert "NDFrame.head" not in listed(analysis)


# 1.91: a marker for "not given" is the value that the call uses, or no chip.


@demo_only
def test_a_marker_default_is_the_default_that_the_documentation_gives(demo):
    source = '_c = pd.read_csv("nhefs.csv")\n_t = pd.read_table("nhefs.tsv")\n_m = weekly.merge(patients, on="patient_id")'
    signatures = listed(analyse(demo, source, signatures=True))
    defaults = {name: {p["name"]: p.get("default") for p in s["params"]} for name, s in signatures.items()}
    # pandas' signature holds <no_default>; its documentation says "default ','".
    assert defaults["read_csv"]["sep"] == "','"
    assert defaults["read_table"]["sep"] == "'\\t'"
    assert defaults["DataFrame.merge"]["copy"] == "False"
    # names and dtype_backend have no default in the documentation: no model reads them.
    assert "names" not in defaults["read_csv"]
    assert "dtype_backend" not in defaults["read_csv"]
    assert not [default for params in defaults.values() for default in params.values() if default and default.startswith("<no")]
    # Nor does a call leave them at their default.
    (call,) = signatures["read_csv"]["calls"]
    assert "sep" in call["defaulted"] and "names" not in call["defaulted"]


# 1.91: a string that names data, and a helper's value, are no chip.


@demo_only
def test_a_value_that_names_data_or_belongs_to_a_helper_is_no_chip(demo):
    """The video's [11] and [13] showed y wt82_71, sel_formula outcome_observed ~ qsmk + ... and _term qsmk:C(sex)[T.1]."""
    source = "\n".join(
        [
            'y = "pain_score"',
            'sel_formula = "pain_score ~ week + treatment_arm"',
            '_term = "treatment_arm[T.B]"',
            "alpha = 0.05",
            'label = "baseline"',
        ]
    )
    assert chips(analyse(demo, source)) == [("alpha", "0.05"), ("label", "'baseline'")]


# 1.92: what "Worth asking next" asks about a read.

HOMES = ("home_id", "region", "floor_area_m2", "heating", "occupants")
READ = CellInfo(
    "c1",
    "[1]",
    'import pandas as pd\n\nhomes = pd.read_csv("homes.csv")\nhomes.head()',
    defs=("homes", "pd"),
    decisions=(Decision("header", "'infer'", "library_default", param="header", function="pandas.read_csv", calls=(DecisionCall(3, 11, "homes"),)),),
)
MERGE = CellInfo(
    "c2",
    "[2]",
    'daily = readings.merge(homes, on="home_id")',
    defs=("daily",),
    uses=("readings", "homes"),
    decisions=(Decision("how", "'inner'", "library_default", param="how", function="DataFrame.merge", calls=(DecisionCall(1, 17, "homes"),)),),
)


def context(homes=HOMES, **more):
    frames = {
        "homes": {"rows": 360, "columns": {column: "num" for column in homes}},
        "readings": {"rows": 5000, "columns": {"home_id": "id", "date": "date", "kwh_import": "num", "tou_active": "bool"}},
        "daily": {"rows": 5000, "columns": {"home_id": "id", "kwh_import": "num"}},
    }
    return Context.from_json({"frames": frames, **more})


def texts(steps):
    return [step.text for step in steps]


HEADER = "Does header = 'infer' change the result of [1]?"
HOW = "Does how = 'inner' change the result of [2]?"


def test_the_assumptions_of_a_read_that_looks_right_come_after_every_other_question():
    steps = next_steps([READ, MERGE], context(outcome="kwh_import", unit="home_id"), {}, set())
    assert texts(steps)[0] == HOW
    # After the merge's choice, and after the columns not explored yet.
    assert texts(steps)[-1] == HEADER
    assert len(steps) > 2
    header = steps[-1]
    assert header.reasons[:2] == ["Open assumption in [1]", "how [1] reads a file, whose frame looks right"]
    assert header.probability < min(step.probability for step in steps[:-1])


def test_a_read_alone_is_still_asked_about():
    """Right after a file is loaded, its read is all that the notebook holds."""
    assert texts(next_steps([READ], context(), {}, set())) == [HEADER]


@pytest.mark.parametrize(
    ("columns", "sign"),
    [
        (("home_id;region;floor_area_m2;heating",), "homes has one column, whose name holds semicolons"),
        (("Unnamed: 0", "home_id", "region"), "homes has a column named Unnamed: 0"),
        (("Unnamed: 0", "Unnamed: 1", "home_id"), "homes has 2 columns named Unnamed"),
        (("1", "103.5", "2", "Gas"), "homes has numbers for column names: 1, 103.5, 2"),
    ],
)
def test_the_assumptions_of_a_read_that_looks_wrong_come_first_with_what_shows_it(columns, sign):
    steps = next_steps([READ, MERGE], context(homes=columns), {}, set())
    assert texts(steps)[:2] == [HEADER, HOW]
    assert steps[0].reasons[:2] == [sign, "Open assumption in [1]"]


def test_a_frame_that_a_read_got_wrong_gives_no_question_about_its_columns():
    """The one column of a file with semicolons was offered as "How does home_id;region;... relate to kwh_import?"."""
    steps = next_steps([READ, MERGE], context(homes=("home_id;region;floor_area_m2;heating",), outcome="kwh_import", unit="home_id"), {}, set())
    assert texts(steps)[0] == HEADER
    assert not [text for text in texts(steps) if "home_id;region" in text]
    # The columns of the frames that look right are still asked about.
    assert "How does date relate to kwh_import?" in texts(steps) or "How does tou_active relate to kwh_import?" in texts(steps)

def test_names_that_are_numbers_in_a_frame_with_names_look_right():
    """A frame of years beside a name, as a wide table has them, is no header read from the data."""
    steps = next_steps([READ, MERGE], context(homes=("region", "2024", "2025")), {}, set())
    assert texts(steps) == [HOW, HEADER]


def test_a_read_of_r_looks_wrong_by_the_same_signs():
    read = CellInfo(
        "c1",
        "[1]",
        'homes <- read.csv("homes.csv")',
        defs=("homes",),
        decisions=(Decision("na.strings", '"NA"', "library_default", param="na.strings", function="utils::read.csv", calls=(DecisionCall(1, 10, "homes"),)),),
    )
    right = next_steps([read, MERGE], context(), {}, set())
    assert texts(right) == [HOW, 'Does na.strings = "NA" change the result of [1]?']
    wrong = next_steps([read, MERGE], context(homes=("Unnamed: 0", "home_id")), {}, set())
    assert texts(wrong)[0] == 'Does na.strings = "NA" change the result of [1]?'



def test_of_two_choices_that_score_the_same_the_newest_cell_leads():
    """In the video, the open choices of [2] and [3] would stay first through the whole analysis, above the models fitted in [7] to [13]."""
    how = Decision("how", "'inner'", "library_default", param="how", function="DataFrame.merge")
    first = CellInfo("c1", "[1]", "w = d.merge(e, on='k')", decisions=(how,))
    newest = CellInfo("c2", "[2]", "v = d.merge(f, on='k')", decisions=(how,))
    steps = next_steps([first, newest], Context(), {}, set())
    assert texts(steps) == ["Does how = 'inner' change the result of [2]?", "Does how = 'inner' change the result of [1]?"]
    assert steps[0].probability == steps[1].probability


# The separator that the file uses, guessed from its first rows.


def test_the_separator_of_a_read_can_be_guessed_from_the_file(tmp_path, monkeypatch):
    cell = CellInfo("c1", "[1]", 'prices = pd.read_csv("prices.csv")', defs=("prices",))
    sep = Decision("sep", "','", "library_default", param="sep", function="read_csv", calls=(DecisionCall(1, 12, "prices"),))
    options = decision_options(cell, sep, Context())["options"]
    assert options[0]["text"] == "What if sep were None?"
    assert options[0]["effect"] == "None instead of ',' · guesses the separator from the first rows of the file"
    code = alternative_code(cell, sep)
    assert 'pd.read_csv("prices.csv", sep=None)' in code
    (tmp_path / "prices.csv").write_text("item;price;kept\napple;1.5;1\npear;2.25;0\n")
    monkeypatch.chdir(tmp_path)
    namespace = {"pd": pd}
    exec(code, namespace)  # noqa: S102  the view runs the same branch in the kernel
    branch = next(value for name, value in namespace.items() if name.startswith("prices_"))
    assert list(branch.columns) == ["item", "price", "kept"]


# The first question of the video's list, once the reads went down.


def test_a_default_that_a_model_found_gets_no_value_by_its_name_alone():
    """The video's model picked the optimizer `method` of Logit.fit in [12], and the branch tried method="spearman", a correlation's."""
    cell = CellInfo("c12", "[12]", 'fit = smf.logit("y ~ x", data=d).fit(disp=0)')
    found = {"by": None, "library": "statsmodels", "version": "0.15.0"}
    method = Decision.from_json(
        {"name": "method", "value": "'newton'", "provenance": "library_default", "param": "method", "function": "Logit.fit", "calls": [{"line": 1, "col": 36}], "found": found}
    )
    assert method.found
    assert alternative_code(cell, method) is None
    step = next(s for s in next_steps([CellInfo(cell.id, cell.label, cell.source, decisions=(method,))], Context(), {}, set()))
    assert (step.text, step.code) == ("Does method = 'newton' change the result of [12]?", None)
    result = decision_options(cell, method, Context())
    assert not [option for option in result["options"] if "spearman" in option["text"]]
    assert result["ask_model"] is True
    # The kernel's own default of a correlation keeps its other method.
    corr = Decision("method", "'pearson'", "library_default", param="method", function="DataFrame.corr")
    assert 'method="spearman"' in alternative_code(CellInfo("c1", "[1]", "r = d.corr()"), corr)
