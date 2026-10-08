"""Which defaults that a model picked make a chip: design iteration 1.102.

"Find more defaults with AI" (1.53) asks a model which parameters of a
library function can change a result when a cell leaves them at their
defaults, and each pick showed as a chip. The takes of the demo videos showed
many that no analyst asks about: ``subset None`` and ``drop_cols None`` of a
formula model, ``deep True`` of ``copy``, ``dtype None``, ``method newton``
of a logistic fit. The owner: "Depends on whether they provide value. If they
don't then they should not show." The server leaves out the picks of
parameters that name what a call works on, change what it computes rather
than how it estimates, keep the books, only stop or warn, tune an optimizer
or only draw (library_defaults.worth_a_chip), in the answers that it kept and
in new ones, and keeps each answer as the model gave it.

The picks are those that the videos' model made while the takes were
recorded (data/found_defaults_takes.json). No model is called: the connected
model is faked.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from whybook.server import claude, library_defaults

TAKES = json.loads((Path(__file__).parent / "data" / "found_defaults_takes.json").read_text())["functions"]
BY = {"choice": "remote", "model": "openrouter:inception/mercury-2.5", "at": "2026-10-07T16:30:14Z"}

# The picks of the takes that no analyst asks about, by function and parameter.
NOISE = [
    ("statsmodels.base.model.Model.from_formula", "subset"),
    ("statsmodels.base.model.Model.from_formula", "drop_cols"),
    ("pandas.core.generic.NDFrame.copy", "deep"),
    ("pandas.read_csv", "dtype"),
    ("pandas.core.frame.DataFrame.__init__", "index"),
    ("pandas.core.frame.DataFrame.__init__", "data"),
    ("pandas.core.frame.DataFrame.__init__", "dtype"),
    ("numpy.sqrt", "dtype"),
    ("numpy.sqrt", "out"),
    ("numpy.sqrt", "where"),
    ("statsmodels.discrete.discrete_model.Logit.fit", "method"),
    ("statsmodels.discrete.discrete_model.Logit.fit", "maxiter"),
    ("statsmodels.discrete.discrete_model.Logit.fit", "start_params"),
    ("stats::lm", "method"),
    ("pandas.core.frame.DataFrame.drop", "axis"),
    ("pandas.core.frame.DataFrame.drop", "labels"),
    ("pandas.core.frame.DataFrame.drop", "inplace"),
    ("pandas.core.frame.DataFrame.dropna", "axis"),
    ("pandas.core.frame.DataFrame.dropna", "subset"),
    ("pandas.core.frame.DataFrame.groupby", "by"),
    ("pandas.core.frame.DataFrame.groupby", "as_index"),
    ("pandas.core.series.Series.groupby", "observed"),
    ("pandas.core.generic.NDFrame.fillna", "limit"),
    ("pandas.core.generic.NDFrame.astype", "errors"),
    ("pandas.to_numeric", "errors"),
    ("pandas.to_numeric", "downcast"),
    ("pandas.core.frame.DataFrame.sort_values", "ascending"),
    ("pandas.core.frame.DataFrame.sort_values", "na_position"),
    ("pandas.core.frame.DataFrame.apply", "axis"),
    ("pandas.core.frame.DataFrame.to_dict", "orient"),
    ("pandas.core.frame.DataFrame.query", "engine"),
    ("pandas.core.base.IndexOpsMixin.value_counts", "normalize"),
    ("pandas.core.series.Series.eq", "level"),
    ("pandas.core.indexes.multi.MultiIndex.from_frame", "names"),
    ("pandas.cut", "duplicates"),
    ("statsmodels.base.model.Results.predict", "exog"),
    ("statsmodels.base.model.Results.predict", "transform"),
    ("statsmodels.tools.tools.add_constant", "prepend"),
    ("statsmodels.genmod.families.family.Binomial.__init__", "check_link"),
    ("statsmodels.genmod.generalized_linear_model.GLM.fit", "maxiter"),
    ("statsmodels.base.model.LikelihoodModelResults.cov_params", "r_matrix"),
    ("numpy.random._generator.Generator.multivariate_normal", "size"),
    ("numpy.random._generator.Generator.multivariate_normal", "check_valid"),
    ("re.findall", "flags"),
    ("whybook.plots.hist", "bins"),
    ("whybook.plots.bars", "y"),
    ("whybook.explore.who_is_in", "most"),
    ("matplotlib.pyplot.subplots", "nrows"),
    ("matplotlib.axes._axes.Axes.hist", "density"),
    ("matplotlib.axes._axes.Axes.hist", "range"),
    ("stats::glm", "model"),
    ("stats::qt", "lower.tail"),
    ("base::matrix", "byrow"),
    ("base::sapply", "simplify"),
]

# The picks of the takes that are worth a chip: how missing values count,
# which estimate, test or interval, a tolerance, the model of the errors,
# which rows are kept, a reference level.
WORTH = [
    ("statsmodels.regression.linear_model.RegressionModel.fit", "cov_type"),
    ("statsmodels.regression.linear_model.RegressionModel.fit", "use_t"),
    ("statsmodels.regression.linear_model.RegressionResults.conf_int", "alpha"),
    ("statsmodels.stats.contrast.ContrastResults.conf_int", "alpha"),
    ("statsmodels.genmod.generalized_linear_model.GLM.__init__", "family"),
    ("statsmodels.genmod.generalized_linear_model.GLM.__init__", "missing"),
    ("statsmodels.genmod.generalized_linear_model.GLM.__init__", "freq_weights"),
    ("statsmodels.genmod.generalized_linear_model.GLM.fit", "scale"),
    ("statsmodels.genmod.families.family.Poisson.__init__", "link"),
    ("statsmodels.genmod.families.family.Binomial.__init__", "link"),
    ("statsmodels.base.model.LikelihoodModelResults.wald_test", "use_f"),
    ("pandas.read_csv", "sep"),
    ("pandas.read_csv", "na_values"),
    ("pandas.core.frame.DataFrame.groupby", "dropna"),
    ("pandas.core.base.IndexOpsMixin.value_counts", "dropna"),
    ("pandas.core.series.Series.sum", "skipna"),
    ("pandas.core.series.Series.sum", "min_count"),
    ("pandas.core.series.Series.var", "ddof"),
    ("pandas.core.series.Series.corr", "method"),
    ("pandas.core.series.Series.eq", "fill_value"),
    ("pandas.core.frame.DataFrame.merge", "validate"),
    ("pandas.core.frame.DataFrame.set_index", "verify_integrity"),
    ("pandas.core.frame.DataFrame.reindex", "method"),
    ("pandas.core.frame.DataFrame.nlargest", "keep"),
    ("pandas.concat", "join"),
    ("pandas.cut", "right"),
    ("pandas.cut", "include_lowest"),
    ("pandas.get_dummies", "drop_first"),
    ("pandas.get_dummies", "dummy_na"),
    ("pandas.core.series.Series.quantile", "interpolation"),
    ("numpy.quantile", "method"),
    ("numpy.average", "weights"),
    ("numpy.allclose", "rtol"),
    ("numpy.linalg.pinv", "rcond"),
    ("scipy.stats._stats_py.pearsonr", "alternative"),
    ("patsy.highlevel.dmatrices", "NA_action"),
    ("stats::confint.lm", "level"),
    ("stats::glm", "family"),
    ("stats::lm", "contrasts"),
    ("utils::read.csv", "na.strings"),
    ("base::factor", "exclude"),
    ("base::table", "useNA"),
    ("base::merge.data.frame", "all"),
    ("whybook.explore.compare_levels", "unit"),
]


def function_json(item: dict) -> dict:
    """A function as the view sends it: as the kernel lists it, without its calls."""
    return {key: value for key, value in item.items() if key != "picks"}


def keep_takes(whybook_data: Path, functions: list[dict]) -> None:
    """The server's store with the answers of the takes, as the server kept them."""
    libraries: dict = {}
    for item in functions:
        versions = libraries.setdefault(item["library"], {})
        kept = versions.setdefault(item["version"] or "", {})
        kept[item["function"]] = {"picks": item["picks"], "by": BY, "params": [param["name"] for param in item["params"]], "prompt": library_defaults.PROMPT_VERSION}
    whybook_data.mkdir(parents=True, exist_ok=True)
    (whybook_data / library_defaults.STORE).write_text(json.dumps({"version": 1, "libraries": libraries}))


async def lookup(jp_fetch, functions: list[dict]) -> dict[str, list[str]]:
    """The picks that the server sends for these functions, without a model, by function."""
    response = await jp_fetch("whybook", "defaults", method="POST", body=json.dumps({"functions": [function_json(item) for item in functions]}))
    answers = json.loads(response.body.decode())["answers"]
    return {answer["function"]: [pick["param"] for pick in answer["picks"]] for answer in answers}


def take(function: str) -> dict:
    return next(item for item in TAKES if item["function"] == function)


def test_the_fixture_holds_every_pick_of_the_lists():
    picked = {(item["function"], pick["param"]) for item in TAKES for pick in item["picks"]}
    assert [pair for pair in NOISE + WORTH if pair not in picked] == []


async def test_the_noise_of_the_takes_makes_no_chip_and_the_picks_worth_one_stay(jp_fetch, whybook_data):
    keep_takes(whybook_data, TAKES)
    sent = await lookup(jp_fetch, TAKES)
    # Every function keeps its answer, also one whose every pick is noise:
    # no pick is an answer, so no model is asked about it again.
    assert set(sent) == {item["function"] for item in TAKES}
    assert sent["pandas.core.generic.NDFrame.copy"] == []
    assert sent["statsmodels.base.model.Model.from_formula"] == []
    assert [(function, param) for function, param in NOISE if param in sent[function]] == []
    assert [(function, param) for function, param in WORTH if param not in sent[function]] == []
    # The picks that stay keep the model's order and its reasons.
    assert sent["pandas.read_csv"] == ["sep", "na_values"]
    assert sent["statsmodels.discrete.discrete_model.Logit.fit"] == []
    assert sent["statsmodels.genmod.generalized_linear_model.GLM.fit"] == ["cov_type", "scale"]


async def test_the_cards_of_the_takes_lose_their_noise(jp_fetch, whybook_data):
    # The functions of two cards of the final takes, with the picks that their chips showed:
    # [14] of the NHEFS video showed subset None ×2, method newton and alpha 0.05;
    # [31] of the survey video, prepend True, link None and dtype None.
    ipw = [take(name) for name in (
        "statsmodels.base.model.Model.from_formula",
        "statsmodels.discrete.discrete_model.Logit.fit",
        "statsmodels.base.model.Results.predict",
        "statsmodels.regression.linear_model.RegressionModel.fit",
        "statsmodels.regression.linear_model.RegressionResults.conf_int",
        "pandas.core.frame.DataFrame.__init__",
    )]
    refit = [take(name) for name in (
        "pandas.get_dummies",
        "statsmodels.tools.tools.add_constant",
        "statsmodels.genmod.generalized_linear_model.GLM.__init__",
        "statsmodels.genmod.families.family.Binomial.__init__",
        "pandas.core.frame.DataFrame.to_numpy",
        "numpy.zeros",
    )]
    keep_takes(whybook_data, ipw + refit)
    sent = await lookup(jp_fetch, ipw + refit)
    assert {name: picks for name, picks in sent.items() if picks} == {
        "statsmodels.regression.linear_model.RegressionModel.fit": ["cov_type", "use_t"],
        "statsmodels.regression.linear_model.RegressionResults.conf_int": ["alpha"],
        "pandas.get_dummies": ["drop_first", "dummy_na"],
        "statsmodels.genmod.generalized_linear_model.GLM.__init__": ["family", "missing", "freq_weights"],
        "statsmodels.genmod.families.family.Binomial.__init__": ["link"],
    }


@pytest.fixture
def fake_model(monkeypatch):
    """The connected model, faked: it answers with ``answer`` and keeps each prompt."""
    seen = {"prompts": [], "answer": {"picks": []}}

    async def structured_call(prompt, *, schema, system_prompt, config, effort, images=None):
        seen["prompts"].append(json.loads(prompt))
        yield {"type": "result", "output": seen["answer"], "model": "fake-model", "cost_usd": 0.0003, "elapsed": 0.4}

    monkeypatch.setattr(claude, "structured_call", structured_call)
    monkeypatch.setattr(claude, "readiness", lambda config: {"available": True, "cli": "claude", "credential": "ANTHROPIC_API_KEY", "reason": None, "setup": None})
    return seen


async def ask(jp_fetch, function: dict) -> list[dict]:
    response = await jp_fetch("whybook", "defaults", "ask", method="POST", body=json.dumps({"function": function_json(function), "model": "remote"}))
    return [json.loads(line) for line in response.body.decode().splitlines()]


async def test_a_new_answer_leaves_out_the_picks_that_make_no_chip_and_the_server_keeps_it_as_it_came(jp_fetch, fake_model, whybook_data):
    logit = take("statsmodels.discrete.discrete_model.Logit.fit")
    fake_model["answer"] = {"picks": logit["picks"]}
    events = await ask(jp_fetch, logit)
    # The optimizer of a fit makes no chip: no pick is an answer, not an error.
    assert events[-1]["type"] == "result" and events[-1]["picks"] == []
    kept = json.loads((whybook_data / library_defaults.STORE).read_text())["libraries"]["statsmodels"]["0.15.0"][logit["function"]]
    assert [pick["param"] for pick in kept["picks"]] == ["method", "maxiter", "start_params"]
    # The kept answer goes the same way, with no new call.
    again = await ask(jp_fetch, logit)
    assert again[-1]["kept"] is True and again[-1]["picks"] == []
    assert len(fake_model["prompts"]) == 1

    fit = take("statsmodels.regression.linear_model.RegressionModel.fit")
    fake_model["answer"] = {"picks": fit["picks"]}
    picks = (await ask(jp_fetch, fit))[-1]["picks"]
    assert picks == fit["picks"]


async def test_the_model_still_reads_every_parameter(jp_fetch, fake_model):
    # What 1.53 sends does not change: the rule is applied to the answer.
    frame = take("pandas.core.frame.DataFrame.__init__")
    await ask(jp_fetch, frame)
    assert [param["name"] for param in fake_model["prompts"][0]["parameters"]] == ["data", "index", "dtype"]


def function(name: str, params: dict[str, str], language: str = "Python") -> dict:
    """A function as the kernel lists it, with every parameter picked: a class by its own name, an R function with its package."""
    module, _, short = name.rpartition("::" if language == "R" else ".")
    if short == "__init__":
        module, _, short = module.rpartition(".")
    library = module.split(".")[0] if language == "Python" else module
    return {
        "function": name,
        "name": short if language == "Python" else name,
        "module": module,
        "library": library,
        "version": "1.0",
        **({"language": language} if language != "Python" else {}),
        "params": [{"name": key, "default": value} for key, value in params.items()],
        "picks": [{"param": key, "why": "The model's reason."} for key in params],
    }


# Functions that no take calls, with every parameter picked, and those that make a chip.
OTHERS = [
    (
        function("pandas.to_datetime", {"errors": "'raise'", "dayfirst": "False", "utc": "False", "cache": "True", "unit": "None"}),
        ["dayfirst", "utc", "unit"],
    ),
    (
        function("pandas.core.frame.DataFrame.drop_duplicates", {"subset": "None", "keep": "'first'", "inplace": "False", "ignore_index": "False"}),
        ["keep"],
    ),
    (
        function("pandas.core.frame.DataFrame.pivot_table", {"aggfunc": "'mean'", "fill_value": "None", "margins": "False", "dropna": "True", "observed": "True", "sort": "True"}),
        ["aggfunc", "fill_value", "dropna"],
    ),
    (
        function("pandas.core.frame.DataFrame.rename", {"copy": "None", "inplace": "False", "level": "None", "errors": "'ignore'"}),
        ["errors"],
    ),
    (
        function("sklearn.linear_model._logistic.LogisticRegression.__init__", {"penalty": "'l2'", "class_weight": "None", "random_state": "None", "solver": "'lbfgs'", "max_iter": "100", "n_jobs": "None", "verbose": "0", "warm_start": "False", "tol": "0.0001"}),
        ["penalty", "class_weight", "random_state", "tol"],
    ),
    (
        function("scipy.stats._stats_py.ttest_ind", {"axis": "0", "equal_var": "True", "nan_policy": "'propagate'", "alternative": "'two-sided'", "keepdims": "False"}),
        ["equal_var", "nan_policy", "alternative"],
    ),
    (
        function("scipy.stats._distn_infrastructure.rv_continuous.fit", {"method": "'MLE'"}),
        ["method"],
    ),
    (
        function("statsmodels.regression.mixed_linear_model.MixedLM.fit", {"reml": "True", "method": "None", "start_params": "None", "niter_sa": "0", "do_cg": "True"}),
        ["reml"],
    ),
    (
        function("statsmodels.genmod.generalized_linear_model.GLM.fit", {"method": "'IRLS'", "tol": "1e-08", "scale": "None", "cov_type": "'nonrobust'"}),
        ["tol", "scale", "cov_type"],
    ),
    (
        function("seaborn.categorical.barplot", {"estimator": "'mean'", "errorbar": "('ci', 95)", "n_boot": "1000", "seed": "None", "palette": "None", "legend": "'auto'", "width": "0.8"}),
        ["estimator", "errorbar", "n_boot", "seed"],
    ),
    (
        function("stats::t.test.default", {"alternative": 'c("two.sided", "less", "greater")', "var.equal": "FALSE", "conf.level": "0.95"}, language="R"),
        ["alternative", "var.equal", "conf.level"],
    ),
    (
        function("stats::glm", {"family": "gaussian", "method": '"glm.fit"', "model": "TRUE", "x": "FALSE", "control": "list(...)"}, language="R"),
        ["family"],
    ),
]


@pytest.mark.parametrize("item, worth", OTHERS, ids=[item["function"] for item, _ in OTHERS])
def test_the_rule_holds_for_functions_that_no_take_calls(item, worth):
    function = library_defaults.Function.from_json(function_json(item))
    assert [param.name for param in function.params if library_defaults.worth_a_chip(function, param)] == worth


async def test_the_view_gets_three_picks_that_make_a_chip_when_the_model_sent_more(jp_fetch, fake_model):
    # Three noise picks first, then four worth a chip: the noise takes no place.
    item = next(item for item, _ in OTHERS if item["name"] == "LogisticRegression")
    fake_model["answer"] = {"picks": [{"param": name, "why": "The model's reason."} for name in ("solver", "max_iter", "n_jobs", "penalty", "class_weight", "random_state", "tol")]}
    picks = (await ask(jp_fetch, item))[-1]["picks"]
    assert [pick["param"] for pick in picks] == ["penalty", "class_weight", "random_state"]
