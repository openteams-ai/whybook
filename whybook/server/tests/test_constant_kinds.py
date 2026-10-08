"""Other values of a constant, by the kind of constant (design iteration 1.18).

The names and values come from the demos (examples/) and from the public
notebooks of research/ranking-placement.md, in ~/.cache/future-work/notebooks,
where one has the kind: each case names its notebook. No public notebook of
the corpora counts weeks or hours in a constant, so those two names are made up.
"""

import json

import pytest

from whybook.server import claude, local_models, privacy
from whybook.server.questions import values
from whybook.server.questions.cells import CellInfo, Decision, decision_options, suggested_values
from whybook.server.questions.models import Context

# (name, value, param, function, provenance, the code of the cell, the kind, the two values, where the name comes from)
KINDS = [
    ("MIN_DAYS", "14", "min_days", "drop_sparse", "defaulted", "weekly = diary.pipe(drop_sparse)", "days", ["7", "21"], "examples/pain_diary/prep.py"),
    ("days_back", "15", None, None, "literal", "days_back = 15", "days", ["14", "21"], "pmc/Emergent-Behaviors-in-Biology/covid19, Coronavirus Figures.ipynb"),
    ("N_WEEKS", "4", None, None, "literal", "N_WEEKS = 4", "weeks", ["2", "8"], "made up"),
    ("months_to", "24", None, None, "literal", "months_to = 24", "months", ["12", "36"], "pmc/NYUMedML/ObesityPY, presentation_figures_04052018.ipynb"),
    ("HOURS", "6", None, None, "literal", "HOURS = 6", "hours", ["3", "12"], "made up"),
    ("window", "10", "window", "rolling", "literal", "rmsd = frame.rolling(window=10).mean()", "window", ["5", "20"], "pmc/LBC-LNBio/pyKVFinder, md-analysis.ipynb"),
    ("window_size", "1000", None, None, "literal", "window_size = 1000", "window", ["500", "2000"], "pmc/bioinfohk/evangelist, ncbi.ipynb"),
    ("lags", "40", "lags", "plot_acf", "literal", "fig = sm.graphics.tsa.plot_acf(dta.values.squeeze(), lags=40)", "lag", ["20", "80"], "libraries/statsmodels, statespace_arma_0.ipynb"),
    ("alpha", "0.05", None, None, "literal", "alpha = 0.05", "significance", ["0.01", "0.1"], "examples/students.ipynb"),
    ("threshold", "0.2", None, None, "literal", "threshold = 0.2", "threshold", ["0.1", "0.3"], "pmc/brainiak/brainiak-tutorials, 10-isc.ipynb"),
    ("core_cutoff", "0.85", None, None, "literal", "core_cutoff = 0.85", "threshold", ["0.8", "0.9"], "pmc/OmkarSaMo/Pangenome_Sec_Met, 6_clb_associated_genes.ipynb"),
    ("MIN_COVERAGE", "0.9", "min_coverage", "drop_gappy", "defaulted", "readings = drop_gappy(readings)", "share", ["0.8", "0.95"], "examples/home_energy/energy.py"),
    ("test_size", "0.2", "test_size", "train_test_split", "literal", "X_train, X_test = train_test_split(X, test_size=0.2)", "share", ["0.1", "0.3"], "newsrooms/the-markup/investigation-amazon-brands, 2-random-forest-analysis.ipynb"),
    ("validation_split_in_percent", "20", None, None, "literal", "validation_split_in_percent = 20", "percent", ["10", "30"], "pmc/HenriquesLab/ZeroCostDL4Mic, U-Net_3D_ZeroCostDL4Mic.ipynb"),
    ("year", "2019", None, None, "literal", "year = 2019", "year", ["2018", "2020"], "newsrooms/BuzzFeedNews/2022-04-registries, AZ_subs.ipynb"),
    ("start_year", "1930", None, None, "literal", "start_year = 1930", "year", ["1929", "1931"], "newsrooms/datadesk/houston-flood-zone-analysis, 04_analysis.ipynb"),
    ("N_PATIENTS", "318", None, None, "literal", "N_PATIENTS = 318", "count", ["160", "640"], "examples/pain_diary/prep.py"),
    ("n_boot", "1000", "n_boot", "ribbon", "literal", 'whybook.ribbon(weekly, x="week", y="pain_score", ci="bootstrap", n_boot=1000)', "count", ["500", "2000"], "examples/pain_diary/pain_diary_cohort.ipynb"),
    ("bins", "40", "bins", "hist", "literal", 'whybook.hist(slopes, x="pain_slope", bins=40)', "count", ["20", "80"], "examples/pain_diary/pain_diary_cohort_6h.ipynb"),
    ("K", "5", None, None, "literal", "K = 5", "count", ["4", "6"], "textbooks/intro-stat-learning/ISLP_labs, Ch06-varselect-lab.ipynb"),
    ("n_splits", "5", "n_splits", "KFold", "literal", "cv = KFold(n_splits=5)", "count", ["3", "10"], "made up; KFold's own parameter"),
    ("SEED", "20260922", None, None, "literal", "SEED = 20260922\nrng = np.random.default_rng(SEED)", "seed", ["0", "1"], "examples/pain_diary/prep.py"),
    ("random_seed", "303", None, None, "literal", "random_seed = 303", "seed", ["0", "1"], "newsrooms/the-markup/investigation-amazon-brands, 2-random-forest-analysis.ipynb"),
    ("reml", "True", "reml", "MixedLM.fit", "library_default", "fit = model.fit()", "flag", ["False"], "the library defaults of analyze_cells.py"),
    ("how", "'inner'", "how", "DataFrame.merge", "library_default", "both = weekly.merge(patients)", "choice", ['"left"', '"outer"'], "the library defaults of analyze_cells.py"),
    ("ci", "'normal'", "ci", "whybook.plots.ribbon", "library_default", "whybook.ribbon(weekly)", "choice", ['"bootstrap"'], "the library defaults of analyze_cells.py"),
    ("cov_type", "'HC3'", "cov_type", "fit", "agent", "fit = smf.ols(formula, data=model_data).fit(cov_type='HC3')", "covariance", ["'nonrobust'", "'HC1'"], "the NHEFS demo video, take v2take3"),
    ("cov_type", "'HC1'", "cov_type", "fit", "literal", "fit = smf.ols(formula, data=d).fit(cov_type='HC1')", "covariance", ["'nonrobust'", "'HC3'"], "made up"),
    ("cov_type", '"nonrobust"', "cov_type", "fit", "library_default", "fit = smf.ols(formula, data=d).fit()", "covariance", ['"HC1"', '"HC3"'], "statsmodels' default"),
]


@pytest.mark.parametrize("name, value, param, function, provenance, source, kind, expected, origin", KINDS, ids=[case[0] for case in KINDS])
def test_each_kind_of_constant_steps_in_its_own_units(name, value, param, function, provenance, source, kind, expected, origin):
    found = values.suggest(name, value, param, function, provenance, source)
    assert found.kind == kind
    assert [item.text for item in found.values] == expected
    # Every value says what it means, and the kind has words for the analyst.
    assert all(item.why for item in found.values)
    assert found.label and found.rule


def test_the_reasons_name_the_unit_of_time_and_the_level():
    days = values.suggest("MIN_DAYS", "14", "min_days", "drop_sparse", "defaulted")
    assert [item.why for item in days.values] == ["a week", "three weeks"]
    assert (days.label, days.rule) == ("a count of days", "common lengths of time")
    alpha = values.suggest("ALPHA", "0.05", source="ALPHA = 0.05\nsignificant = [p for p in p_values if p < ALPHA]")
    assert [item.why for item in alpha.values] == ["a stricter level: fewer false positives", "a looser level: fewer missed effects"]
    share = values.suggest("MIN_COVERAGE", "0.9", "min_coverage", "drop_gappy", "defaulted")
    assert [item.why for item in share.values] == ["a smaller share: 80%", "a larger share: 95%"]


def test_where_the_value_goes_tells_a_significance_level_from_an_opacity_and_a_rate():
    """An alpha of 0.05 in a test is a significance level; in a plot it is an opacity, and next to a gradient a learning rate."""
    tested = values.suggest("alpha", "0.05", "alpha", "multipletests", "literal", "rejected = multipletests(pvals, alpha=0.05)")
    assert tested.kind == "significance"
    # gallery/jdwittenauer/ipython-notebooks, ML-Exercise1.ipynb: a learning rate of 0.01.
    rate = values.suggest("alpha", "0.01", source="alpha = 0.01\niters = 1000\ng, cost = gradientDescent(X, y, theta, alpha, iters)")
    assert rate.kind is None
    # pmc/protonzilla/Light-Potentials-in-Field: alpha = 0.5, an opacity; and one at 0.05 passed to a plot.
    assert values.suggest("alpha", "0.05", "alpha", "scatter", "literal", "plt.scatter(x, y, alpha=0.05)").kind is None
    assert values.suggest("ALPHA", "0.05", source="ALPHA = 0.05\nplt.scatter(x, y, alpha=ALPHA)").kind is None
    # gallery/agconti/kaggle-titanic, Titanic.ipynb: alpha_level = 0.65 is an opacity, no confidence level.
    assert values.suggest("alpha_level", "0.65", source="alpha_level = 0.65").kind is None


def test_a_count_of_days_in_the_code_around_it_counts_days():
    """The name alone does not say it; timedelta(days=N) does."""
    found = values.suggest("N", "30", source="N = 30\nstart = end - timedelta(days=N)")
    assert found.kind == "days"
    assert [item.text for item in found.values] == ["21", "60"]


def test_a_pandas_frequency_steps_to_the_next_units():
    assert [item.text for item in values.suggest("rule", "'W'", "rule", "resample", "literal").values] == ["'D'", "'MS'"]
    assert [item.text for item in values.suggest("window", "'7D'", "window", "rolling", "literal").values] == ["'3D'", "'14D'"]


def test_no_rule_knows_a_temperature_and_the_fallback_is_the_rule_of_before():
    """examples/home_energy/energy.py: BASE_TEMP_C = 15.5, the base of heating degree days. And
    examples/students.ipynb: per_school=30, the pupils per school of make_students."""
    temperature = values.suggest("BASE_TEMP_C", "15.5", "base", "add_degree_days", "defaulted", "daily = add_degree_days(daily)")
    assert temperature.kind is None
    assert [item.text for item in temperature.values] == ["7.75", "31.0"]
    pupils = values.suggest("per_school", "30", "per_school", "make_students", "defaulted", "students = make_students()")
    assert pupils.kind is None
    assert [item.text for item in pupils.values] == ["15", "45"]
    # A string that no rule knows has no fallback: the model suggests, or the analyst types.
    assert values.suggest("distr", "'logit'", "distr", "from_formula", "literal").values == ()
    # Another file is not a value to guess: no rule and no model.
    assert values.suggest("filepath_or_buffer", "'homes.csv'", "filepath_or_buffer", "read_csv", "literal").kind == "file"


BASE = Decision("BASE_TEMP_C", "15.5", "defaulted", param="base", function="add_degree_days", source_file="energy.py", source_line=12)
DAILY = CellInfo("c3", "[3]", "daily = add_degree_days(daily)\ndaily.head()", decisions=(BASE,))


def test_the_options_say_the_kind_and_whether_a_model_should_choose():
    weekly = CellInfo("c2", "[2]", "weekly = weekly_means(diary)\nweekly.head()")
    days = Decision("MIN_DAYS", "14", "defaulted", param="min_days", function="weekly_means", source_file="prep.py", source_line=12)
    result = decision_options(weekly, days, Context())
    assert (result["kind"], result["rule"], result["ask_model"]) == ("a count of days", "common lengths of time", False)
    unknown = decision_options(DAILY, BASE, Context())
    assert unknown["kind"] is None and unknown["ask_model"] is True
    # Until a model answers, or without one, the values are half and double.
    assert [o["text"] for o in unknown["options"] if o["template"] == "what_if_value"] == ["What if BASE_TEMP_C were 7.75?", "What if BASE_TEMP_C were 31.0?"]


def test_the_standard_errors_of_a_statsmodels_fit_need_no_model():
    # In two of three takes of the NHEFS video, the model's values for
    # cov_type='HC3' did not come, and the chip offered no other value.
    cell = CellInfo("c14", "[14]", "fit = smf.ols(formula, data=model_data).fit(cov_type='HC3')")
    hc3 = Decision("cov_type", "'HC3'", "agent", param="cov_type", function="fit")
    result = decision_options(cell, hc3, Context())
    assert result["ask_model"] is False
    assert [o["text"] for o in result["options"] if o["template"] == "what_if_value"] == [
        "What if cov_type were 'nonrobust'?",
        "What if cov_type were 'HC1'?",
    ]
    # A covariance of another library, such as linearmodels', is no
    # statsmodels one: a model reads it.
    clustered = Decision("cov_type", "'clustered'", "agent", param="cov_type", function="fit")
    assert decision_options(cell, clustered, Context())["ask_model"] is True


def test_the_values_a_model_suggested_become_branches_and_a_sweep():
    suggested = suggested_values([{"value": "12.0", "why": "the UK convention"}, {"value": "18", "why": "the US convention"}, {"value": "15.5", "why": "the same"}])
    # A sweep sums up the frames that the cell makes, as the kernel lists them.
    result = decision_options(DAILY, BASE, Context(frames={"daily": {"hdd": "num"}}), suggested=suggested)
    offered = [o for o in result["options"] if o["template"] == "what_if_value"]
    # The current value is not offered again.
    assert [o["text"] for o in offered] == ["What if BASE_TEMP_C were 12.0?", "What if BASE_TEMP_C were 18?"]
    assert offered[0]["effect"] == "12.0 instead of 15.5 (÷1.29) · the UK convention"
    assert "daily_if_12_0 = add_degree_days(daily, base=12.0)" in offered[0]["code"]
    # The model's values leave the kind to the view, which has the model's words.
    assert "kind" not in result and "ask_model" not in result
    assert [o["text"] for o in result["options"] if o["template"] == "what_if_sweep"] == ["Compare BASE_TEMP_C = 12.0, 15.5, 18 in one table"]


def test_a_model_reads_the_code_without_the_value_when_the_data_stays_here():
    source = "MIN_DAYS = 14\nweekly = drop_sparse(diary, min_days=MIN_DAYS)\nlong = weekly[weekly.days > 14]"
    kept = values.prompt_state("MIN_DAYS", "14", None, None, "literal", None, source, keep_local=True)
    assert "value" not in kept
    assert kept["cell"] == "MIN_DAYS = ...\nweekly = drop_sparse(diary, min_days=MIN_DAYS)\nlong = weekly[weekly.days > ...]"
    assert "14" not in json.dumps(kept)
    loose = values.prompt_state("MIN_DAYS", "14", None, None, "literal", None, source, keep_local=False)
    assert loose["value"] == "14" and loose["cell"] == source


def test_the_code_without_a_value_keeps_other_numbers_and_signs():
    assert privacy.without_value("y = -3\nz = 3 - 3\nw = f(-3, [1, -3])", "-3") == "y = ...\nz = 3 - 3\nw = f(..., [1, ...])"
    assert privacy.without_value("x = f(df, how='inner')\ny = 'inner join'", "'inner'") == "x = f(df, how=...)\ny = 'inner join'"
    # 14 and 14.0 are one value.
    assert privacy.without_value("a = 14.0\nb = 140", "14") == "a = ...\nb = 140"


def test_only_python_literals_other_than_the_value_are_usable():
    found = values.usable(
        [
            {"value": "7", "why": "a week"},
            {"value": "7.0", "why": "a week again"},
            {"value": "os.system('ls')", "why": "not a value"},
            {"value": "14", "why": "the current value"},
            {"value": 21, "why": "a number, not a text"},
            {"value": '"left"', "why": "a string"},
        ],
        "14",
    )
    assert [item.text for item in found] == ["7", "21", '"left"']


@pytest.fixture
def fake_model(monkeypatch):
    """The connected model, faked: it answers with ``answer["output"]`` and keeps each prompt."""
    seen = {"prompts": [], "answer": {"kind": "a base temperature in degrees C", "values": [{"value": "12.0", "why": "the UK convention"}, {"value": "18.0", "why": "the US convention"}]}}

    async def structured_call(prompt, *, schema, system_prompt, config, effort, images=None):
        seen["prompts"].append(json.loads(prompt))
        seen["system"] = system_prompt
        # ``answers``, when set, gives one answer for each call in turn.
        answer = seen["answers"].pop(0) if seen.get("answers") else seen["answer"]
        yield {"type": "progress", "stage": "thinking", "elapsed": 0.1}
        yield {"type": "result", "output": answer, "model": "fake-model", "cost_usd": 0.0004, "elapsed": 0.2}

    monkeypatch.setattr(claude, "structured_call", structured_call)
    monkeypatch.setattr(claude, "readiness", lambda config: {"available": True, "cli": "claude", "credential": "ANTHROPIC_API_KEY", "reason": None, "setup": None})
    return seen


async def post(jp_fetch, *path, body):
    response = await jp_fetch("whybook", *path, method="POST", body=json.dumps(body))
    return response.body.decode()


def body(**extra):
    return {"cell": {"id": "c3", "label": "[3]", "source": "daily = add_degree_days(daily)\ndaily.head()"}, "decision": {"name": "BASE_TEMP_C", "value": "15.5", "provenance": "defaulted", "param": "base", "function": "add_degree_days", "source": {"file": "energy.py", "line": 12}}, **extra}


async def test_the_model_suggests_values_with_a_kind_and_the_view_builds_their_branches(jp_fetch, fake_model):
    events = [json.loads(line) for line in (await post(jp_fetch, "decision", "values", body=body(model="remote"))).splitlines()]
    assert [event["type"] for event in events] == ["progress", "result"]
    result = events[-1]
    assert result["kind"] == "a base temperature in degrees C"
    assert result["values"] == [{"value": "12.0", "why": "the UK convention"}, {"value": "18.0", "why": "the US convention"}]
    # What the call cost goes to the view, which counts it with the notebook's answers.
    assert (result["model"], result["cost_usd"]) == ("fake-model", 0.0004)
    prompt = fake_model["prompts"][0]
    assert (prompt["constant"], prompt["value"], prompt["parameter"], prompt["defined_in"]) == ("BASE_TEMP_C", "15.5", "base", "energy.py:12")
    assert fake_model["system"].rstrip().endswith('each with "value" and "why". Never send one value on its own.')
    # The view sends the values back, and the server writes the branches.
    options = json.loads(await post(jp_fetch, "decision", body=body(suggested=result["values"])))["options"]
    assert [o["text"] for o in options if o["template"] == "what_if_value"] == ["What if BASE_TEMP_C were 12.0?", "What if BASE_TEMP_C were 18.0?"]


async def test_with_the_data_on_this_machine_the_model_gets_no_value(jp_fetch, fake_model):
    cell = {"id": "c1", "label": "[1]", "source": "BASE_TEMP_C = 15.5\ndaily = add_degree_days(daily, base=BASE_TEMP_C)"}
    decision = {"name": "BASE_TEMP_C", "value": "15.5", "provenance": "literal"}
    await post(jp_fetch, "decision", "values", body={"cell": cell, "decision": decision, "model": "remote", "keep_data_local": True})
    prompt = fake_model["prompts"][-1]
    assert "value" not in prompt and "15.5" not in json.dumps(prompt)
    assert prompt["cell"] == "BASE_TEMP_C = ...\ndaily = add_degree_days(daily, base=BASE_TEMP_C)"


async def test_two_answers_without_a_usable_value_are_an_error_that_keeps_the_cost_of_both(jp_fetch, fake_model):
    fake_model["answer"] = {"kind": "a temperature", "values": [{"value": "import os", "why": "no value"}, {"value": "15.5", "why": "the same"}]}
    events = [json.loads(line) for line in (await post(jp_fetch, "decision", "values", body=body(model="remote"))).splitlines()]
    assert len(fake_model["prompts"]) == 2
    assert events[-1] == {"type": "error", "message": values.NO_VALUES, "cost_usd": 0.0008, "elapsed": 0.4, "model": "fake-model"}


async def test_an_answer_without_a_usable_value_is_asked_once_more(jp_fetch, fake_model):
    # The fast model of the demo videos answered 2 calls in 10 with no value
    # that can go into the code, and the chip's questions fell back to none.
    fake_model["answers"] = [
        {"kind": "a covariance", "values": [{"value": "import os", "why": "no value"}]},
        {"kind": "a base temperature in degrees C", "values": [{"value": "12.0", "why": "the UK convention"}]},
    ]
    events = [json.loads(line) for line in (await post(jp_fetch, "decision", "values", body=body(model="remote"))).splitlines()]
    assert len(fake_model["prompts"]) == 2
    assert events[-1]["type"] == "result"
    assert events[-1]["values"] == [{"value": "12.0", "why": "the UK convention"}]
    # What both calls cost goes to the view.
    assert (events[-1]["cost_usd"], events[-1]["elapsed"]) == (0.0008, 0.4)


async def test_a_local_model_reads_the_value(jp_fetch, monkeypatch):
    seen = {}

    async def ask_json(model_id, system, user, schema, max_tokens, threads, stage, check="fast"):
        seen.update(model=model_id, user=user, schema=schema)
        yield {"type": "progress", "stage": stage, "elapsed": 0.0}
        yield {"type": "result", "output": {"kind": "a temperature", "values": [{"value": "14", "why": "cooler"}, {"value": "17", "why": "warmer"}]}, "model": "Gemma 4 E2B", "cost_usd": 0.0, "elapsed": 3.0}

    monkeypatch.setattr(local_models, "ask_json", ask_json)
    monkeypatch.setattr(local_models, "model_of", lambda model_id, spec=None: type("Model", (), {"id": model_id})())
    events = [json.loads(line) for line in (await post(jp_fetch, "decision", "values", body=body(model="gemma-4-e2b", keep_data_local=True))).splitlines()]
    assert events[-1]["values"] == [{"value": "14", "why": "cooler"}, {"value": "17", "why": "warmer"}]
    # A model on this machine reads the value, with the data kept here.
    assert seen["model"] == "gemma-4-e2b" and seen["user"]["value"] == "15.5"
    assert seen["schema"]["properties"]["values"]["maxItems"] == 3


async def test_a_key_is_no_constant_to_ask_about(jp_fetch, fake_model):
    from tornado.httpclient import HTTPClientError

    secret = {"cell": {"id": "c1", "label": "[1]", "source": "TOKEN = 'hf_abcdefghijklmnopqrstu'"}, "decision": {"name": "HF_TOKEN", "value": "'hf_abcdefghijklmnopqrstu'", "provenance": "literal"}}
    with pytest.raises(HTTPClientError) as error:
        await post(jp_fetch, "decision", "values", body=secret)
    assert error.value.code == 400
    assert fake_model["prompts"] == []


def test_a_share_changes_by_points_and_a_temperature_by_a_rounded_factor():
    """examples/home_energy: the what-if values of MIN_COVERAGE and BASE_TEMP_C as the chip lists them.

    The fallback rule would give 0.45 and 1.8 for the share, 1.8 being past
    its bound, and "(÷2)" and "(×2)" for every decimal.
    """
    daily = CellInfo("c4", "[4]", "daily = readings.pipe(drop_gappy).pipe(add_degree_days)")
    coverage = Decision("MIN_COVERAGE", "0.9", "defaulted", param="min_coverage", function="drop_gappy", source_file="energy.py", source_line=16)
    effects = [o["effect"] for o in decision_options(daily, coverage, Context())["options"] if o["template"] == "what_if_value"]
    assert effects == ["0.8 instead of 0.9 (−0.1) · a smaller share: 80%", "0.95 instead of 0.9 (+0.05) · a larger share: 95%"]
    fallback = [o["effect"] for o in decision_options(daily, BASE, Context())["options"] if o["template"] == "what_if_value"]
    assert fallback == ["7.75 instead of 15.5 (÷2)", "31.0 instead of 15.5 (×2)"]
