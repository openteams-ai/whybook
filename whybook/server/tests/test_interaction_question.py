"""A column dropped on a model's cell asks whether the effect differs by it (design iteration 1.94).

While the demo video of 7 October was recorded, sex dropped on an agent's
adjusted model of NHEFS, ``wt82_71 ~ qsmk + C(sex) + C(race) + ...``,
offered six questions and none about effect modification: "Does the effect
of qsmk differ by sex?" had to be typed. The frame here is like NHEFS: its
columns, coded as NHEFS codes them, with an effect of qsmk of 4 kg for
sex 0 and 2 kg for sex 1. Each test runs the code that it gets.
"""

import numpy as np
import pandas as pd
import pytest
import statsmodels.formula.api as smf

import whybook
from whybook import explore
from whybook.server import codegen
from whybook.server.questions.drops import DropRequest, drop_options

COVARIATES = ["qsmk", "sex", "race", "age", "education", "smokeintensity", "smokeyrs", "exercise", "active", "wt71", "wt82_71"]
FORMULA = "wt82_71 ~ qsmk + C(sex) + C(race) + age + C(education) + smokeintensity + smokeyrs + C(exercise) + C(active) + wt71"

# The cell of the video's notebook that fitted the model, as the agent wrote it.
ADJUSTED = f"""import pandas as pd
import statsmodels.formula.api as smf

_covars = {COVARIATES!r}
_model_data_full = nhefs[_covars].dropna().copy()
_fit_full = smf.ols("{FORMULA}", data=_model_data_full).fit()
_ci_full = _fit_full.conf_int().loc["qsmk"]
print(f"Complete-case N: {{len(_model_data_full)}}")
print(f"Adjusted qsmk effect (kg): {{_fit_full.params['qsmk']:.2f}}")
"""

# The inverse probability weighting of the video: the propensity of qsmk, then the weighted model of wt82_71.
WEIGHTED = """import statsmodels.formula.api as smf_ipw_branch

_model_data_ipw = nhefs[["wt82_71", "qsmk", "sex", "race", "age", "wt71"]].dropna().copy()
_propensity_fit_ipw = smf_ipw_branch.logit("qsmk ~ C(sex) + C(race) + age + wt71", data=_model_data_ipw).fit(disp=False)
_propensity_ipw = _propensity_fit_ipw.predict(_model_data_ipw)
_weights_ipw = (1 / _propensity_ipw).where(_model_data_ipw["qsmk"].eq(1), 1 / (1 - _propensity_ipw))
_weighted_fit_ipw = smf_ipw_branch.wls("wt82_71 ~ qsmk", data=_model_data_ipw, weights=_weights_ipw).fit(cov_type="HC0")
del _model_data_ipw, _propensity_fit_ipw, _propensity_ipw, _weights_ipw, smf_ipw_branch
print(_weighted_fit_ipw.params["qsmk"])
"""


def nhefs(rows=1200, seed=11):
    """A frame like NHEFS: 0/1 codes for qsmk, sex and race, 1 to 5 for education, 0 to 2 for exercise and active, and 4% of wt82_71 missing."""
    rng = np.random.default_rng(seed)
    frame = pd.DataFrame(
        {
            "seqn": np.arange(233, 233 + rows),
            "qsmk": rng.binomial(1, 0.26, rows),
            "sex": rng.binomial(1, 0.51, rows),
            "race": rng.binomial(1, 0.13, rows),
            "age": rng.integers(25, 75, rows),
            "education": rng.integers(1, 6, rows),
            "income": rng.integers(11, 23, rows).astype(float),
            "smokeintensity": rng.integers(1, 60, rows),
            "smokeyrs": rng.integers(1, 60, rows),
            "exercise": rng.integers(0, 3, rows),
            "active": rng.integers(0, 3, rows),
            "wt71": rng.normal(71, 15, rows).round(2),
        }
    )
    effect = np.where(frame["sex"] == 0, 4.0, 2.0)
    frame["wt82_71"] = (effect * frame["qsmk"] - 0.1 * (frame["age"] - 45) + rng.normal(0, 3, rows)).round(3)
    frame.loc[rng.choice(rows, rows // 25, replace=False), "wt82_71"] = np.nan
    return frame


def kind(frame, label):
    unique = int(frame[label].nunique())
    return "binary" if unique == 2 else "numeric"


def column(frame, label, name="nhefs"):
    return {"name": f"{name}[{label!r}]", "label": label, "kind": kind(frame, label), "parent": name, "rows": len(frame), "unique": int(frame[label].nunique())}


def context(frame, name="nhefs", **frames):
    listed = {name: frame, **frames}
    return {
        "frames": {key: {"rows": len(value), "columns": {c: ("num" if value[c].dtype.kind == "f" else "int") for c in value.columns}} for key, value in listed.items()},
        "outcome": "wt82_71",
        "unit": "seqn",
        "used": COVARIATES,
        "asked": [],
    }


def model_cell(source, cell_id="c8", label="[8]", columns=None):
    model = codegen.fitted_models(source)
    return {
        "id": cell_id,
        "label": label,
        "source": source,
        "defs": codegen.defined_names(source),
        "uses": ["nhefs"],
        "formulas": [found.call.formula for found in model],
        "columns": {"nhefs": columns if columns is not None else COVARIATES},
    }


def options(source, cell, ctx):
    result = drop_options(DropRequest.from_json({"source": source, "target": {"cell": cell}, "cells": [cell], "context": ctx}))
    return result["options"]


def question(found, text):
    return next((option for option in found if option["text"] == text), None)


def test_sex_dropped_on_the_adjusted_model_asks_whether_the_effect_of_qsmk_differs_by_sex(capsys):
    frame = nhefs()
    found = options(column(frame, "sex"), model_cell(ADJUSTED), context(frame))
    asked = question(found, "Does the effect of qsmk on wt82_71 differ by sex?")
    assert asked is not None, [option["text"] for option in found]
    # First, above the association of sex with the outcome: it runs at once, as a branch.
    assert found[0] is asked
    assert asked["type"] == "causal"
    assert asked["placement"]["kind"] == "branch" and asked["placement"]["label"] == "branch of [8] · runs in parallel"
    assert asked["effect"] == "Refits with qsmk × sex: the effect in each level"
    code = asked["code"]
    # The cell up to its fit, with qsmk crossed with sex, under names of its own, and none of its prints.
    assert 'smf.ols("wt82_71 ~ qsmk * C(sex) + C(race) + age + C(education) + smokeintensity + smokeyrs + C(exercise) + C(active) + wt71", data=_model_data_full_by_sex).fit()' in code
    assert "_fit_full =" not in code and "print(" not in code
    assert code.splitlines()[-1] == 'whybook.effect_by(_fit_full_by_sex, "qsmk", "sex")'
    namespace = {"nhefs": frame}
    exec(code, namespace)  # noqa: S102  the view runs the same code in a subshell of the kernel
    # The numbers are those of the model fitted by hand, as the agent's cell [13] of the video computed them.
    by_hand = smf.ols(FORMULA.replace("qsmk + C(sex)", "qsmk * C(sex)"), data=frame[COVARIATES].dropna()).fit()
    term = "qsmk:C(sex)[T.1]"
    printed = capsys.readouterr().out.splitlines()
    first = by_hand.params["qsmk"]
    second = by_hand.params["qsmk"] + by_hand.params[term]
    assert printed[0] == f"Effect of qsmk on wt82_71: {first:.4g} where sex is 0, {second:.4g} where sex is 1."
    low, high = by_hand.conf_int().loc[term]
    assert printed[1] == f"Interaction of qsmk and sex: {by_hand.params[term]:.4g} (95% CI {low:.4g} to {high:.4g}), p {explore._p(by_hand.pvalues[term])}."
    # The effect of 4 kg in sex 0 and 2 kg in sex 1 that the frame holds.
    assert 3 < first < 5.5 and 0.5 < second < 3.5


def test_the_exposure_or_the_outcome_dropped_on_its_model_asks_no_such_question():
    frame = nhefs()
    for label in ("qsmk", "wt82_71"):
        found = options(column(frame, label), model_cell(ADJUSTED), context(frame))
        assert not [option for option in found if option["text"].startswith("Does the effect")], label


@pytest.mark.parametrize("kind", ["id", "text"])
def test_a_unit_s_id_or_a_text_asks_no_such_question(kind):
    frame = nhefs()
    found = options({**column(frame, "seqn"), "kind": kind}, model_cell(ADJUSTED), context(frame))
    assert not [option for option in found if option["text"].startswith("Does the effect")]


def test_a_number_dropped_on_the_model_gives_the_effect_at_its_quartiles(capsys):
    frame = nhefs()
    asked = question(options(column(frame, "age"), model_cell(ADJUSTED), context(frame)), "Does the effect of qsmk on wt82_71 differ by age?")
    assert asked["effect"] == "Refits with qsmk × age: the effect at its quartiles"
    assert '"wt82_71 ~ qsmk * age + C(sex) + C(race) + C(education) + ' in asked["code"]
    exec(asked["code"], {"nhefs": frame})  # noqa: S102
    printed = capsys.readouterr().out.splitlines()
    assert printed[0].startswith("Effect of qsmk on wt82_71: ") and printed[0].endswith(", its quartiles.")
    assert printed[1].startswith("Interaction of qsmk and age: ")


def test_a_column_that_the_model_s_data_may_lack_goes_to_a_model():
    # _model_data_full holds the columns of _covars alone: income is not among them.
    frame = nhefs()
    asked = question(options(column(frame, "income"), model_cell(ADJUSTED), context(frame)), "Does the effect of qsmk on wt82_71 differ by income?")
    assert asked["code"] is None
    assert asked["effect"] == "AI writes the branch"


def test_a_column_new_to_a_model_of_a_listed_frame_joins_it_first(capsys):
    frame = nhefs()
    people = frame[["seqn", "income"]]
    weights = frame.drop(columns="income")
    source = 'fit = smf.ols("wt82_71 ~ qsmk + age", data=weights).fit()\nfit.summary().tables[1]'
    cell = {**model_cell(source), "uses": ["weights", "smf"]}
    ctx = context(weights, name="weights", people=people)
    asked = question(options(column(people, "income", name="people"), cell, ctx), "Does the effect of qsmk on wt82_71 differ by income?")
    assert asked["effect"] == "Adds income to the model, crossed with qsmk"
    assert '_fit_data_by_income = _fit_data_by_income.merge(people.groupby("seqn", as_index=False, observed=True)["income"].mean(), on="seqn", how="left")' in asked["code"]
    assert 'fit_by_income = smf.ols("wt82_71 ~ qsmk * income + age", data=_fit_data_by_income).fit()' in asked["code"]
    exec(asked["code"], {"weights": weights, "people": people, "smf": smf})  # noqa: S102
    assert capsys.readouterr().out.startswith("Effect of qsmk on wt82_71: ")


def test_the_weighted_model_of_an_ipw_cell_is_the_one_crossed(capsys):
    # The cell fits the propensity of qsmk first: the model of the outcome is the last.
    frame = nhefs()
    asked = question(options(column(frame, "sex"), model_cell(WEIGHTED, columns=["wt82_71", "qsmk", "sex", "race", "age", "wt71"]), context(frame)), "Does the effect of qsmk on wt82_71 differ by sex?")
    assert asked is not None
    assert 'smf_ipw_branch.wls("wt82_71 ~ qsmk * C(sex)", data=_model_data_ipw_by_sex, weights=_weights_ipw_by_sex).fit(cov_type="HC0")' in asked["code"]
    # The branch stops after the fit: the cell's del and print come after it.
    assert "del " not in asked["code"] and "print(" not in asked["code"]
    exec(asked["code"], {"nhefs": frame})  # noqa: S102
    assert capsys.readouterr().out.splitlines()[1].startswith("Interaction of qsmk and sex: ")


def test_a_model_that_crosses_them_already_is_read_as_it_is(capsys):
    frame = nhefs()
    source = 'crossed_fit = smf.ols("wt82_71 ~ qsmk * C(sex) + age", data=nhefs).fit()\ncrossed_fit.summary().tables[1]'
    asked = question(options(column(frame, "sex"), model_cell(source), context(frame)), "Does the effect of qsmk on wt82_71 differ by sex?")
    assert asked["placement"]["kind"] == "new"
    assert asked["effect"] == "Reads the interaction in [8]"
    assert asked["code"].splitlines()[1:] == ["import whybook", "", 'whybook.effect_by(crossed_fit, "qsmk", "sex")']
    namespace = {"nhefs": frame, "smf": smf}
    exec(source, namespace)  # noqa: S102
    exec(asked["code"], namespace)  # noqa: S102
    assert capsys.readouterr().out.startswith("Effect of qsmk on wt82_71: ")


@pytest.mark.parametrize(
    ("formula", "label", "levels", "crossed"),
    [
        (FORMULA, "sex", True, FORMULA.replace("qsmk + C(sex)", "qsmk * C(sex)")),
        # A column new to the model: C() for a column of levels, as it is for a number.
        ("y ~ qsmk + age", "race", True, "y ~ qsmk * C(race) + age"),
        ("y ~ qsmk + age", "income", False, "y ~ qsmk * income + age"),
        # A column written without C() alone in its term gets C(); in a term with another column, it keeps its text.
        ("y ~ arm + sex", "sex", True, "y ~ arm * C(sex)"),
        ("y ~ arm + age * sex", "sex", True, "y ~ arm * sex + age * sex"),
        # An exposure in a term with another column: the cross goes at the end.
        ("pain_score ~ treatment_arm * month + age", "site", True, "pain_score ~ treatment_arm * month + age + treatment_arm * C(site)"),
        ("pain_score ~ treatment_arm * month + age", "age", False, "pain_score ~ treatment_arm * month + treatment_arm * age"),
        ("y ~ 0 + arm_b * month + age", "sex", True, "y ~ 0 + arm_b * month + age + arm_b * C(sex)"),
        ('y ~ Q("dose mg") + sex', "sex", True, 'y ~ Q("dose mg") * C(sex)'),
    ],
)
def test_the_exposure_is_the_first_column_of_the_right_side(formula, label, levels, crossed):
    assert codegen.cross_exposure(formula, label, levels).formula == crossed


@pytest.mark.parametrize(
    ("formula", "label"),
    [
        ("y ~ qsmk + sex", "qsmk"),  # the exposure itself
        ("y ~ qsmk + sex", "y"),  # the outcome
        ("y ~ np.log(dose) + sex", "sex"),  # an exposure that transforms its column
        ("y ~ x - 1", "sex"),  # a term that removes another
        ("y ~ x + C(sex) + sex", "sex"),  # a column written two ways
    ],
)
def test_no_cross_where_the_formula_gives_none(formula, label):
    assert codegen.cross_exposure(formula, label, True) is None


def test_a_formula_that_crosses_them_already_stays():
    found = codegen.cross_exposure("kwh_import ~ hdd * heating + occupants", "heating", True)
    assert (found.formula, found.exposure, found.crossed) == ("kwh_import ~ hdd * heating + occupants", "hdd", True)


def test_fitted_models_lists_each_fit_with_its_lines():
    source = 'import statsmodels.formula.api as smf\nm = smf.mixedlm("y ~ x", d,\n    groups="g")\nfit = m.fit(reml=False)\nother = smf.ols("y ~ x", data=d).fit()\nfor b in [1, 2]:\n    looped = smf.ols("y ~ x", data=d).fit()\n'
    found = codegen.fitted_models(source)
    assert [(model.fit, model.call.function, model.call.data, model.start, model.end) for model in found] == [("fit", "mixedlm", "d", 2, 4), ("other", "ols", "d", 5, 5)]


# The helper that the code calls: whybook.effect_by.


def fitted(formula, frame=None, method=smf.ols, **keywords):
    data = (frame if frame is not None else nhefs())[COVARIATES].dropna()
    return method(formula, data=data, **keywords).fit(**({} if method is not smf.logit else {"disp": False}))


def test_effect_by_gives_a_row_per_level_with_the_model_s_own_interval():
    fit = fitted("wt82_71 ~ qsmk * C(sex) + age")
    table = whybook.effect_by(fit, "qsmk", "sex")
    assert list(table.columns) == ["rows", "effect of qsmk", "95% CI", "p"]
    assert table.index.name == "sex" and list(table.index) == ["0", "1"]
    test = fit.t_test("qsmk + qsmk:C(sex)[T.1] = 0")
    assert table.loc["1", "effect of qsmk"] == pytest.approx(float(test.effect[0]), rel=1e-3)
    low, high = test.conf_int(alpha=0.05)[0]
    assert table.loc["1", "95% CI"] == f"{low:.4g} to {high:.4g}"
    assert table["rows"].sum() == fit.nobs


def test_effect_by_tests_the_terms_of_three_levels_together(capsys):
    fit = fitted("wt82_71 ~ qsmk * C(exercise) + age")
    table = whybook.effect_by(fit, "qsmk", "exercise")
    assert list(table.index) == ["0", "1", "2"]
    joint = fit.wald_test("qsmk:C(exercise)[T.1] = 0, qsmk:C(exercise)[T.2] = 0", scalar=True)
    line = capsys.readouterr().out.splitlines()[1]
    assert line.startswith(f"Interaction of qsmk and exercise, 2 terms: F = {float(joint.statistic):.3g} on 2 and ")


def test_effect_by_gives_odds_ratios_for_a_logistic_model():
    frame = nhefs()
    frame["gained"] = (frame["wt82_71"] > 5).astype(int)
    fit = smf.logit("gained ~ qsmk * C(sex) + age", data=frame.dropna()).fit(disp=False)
    table = whybook.effect_by(fit, "qsmk", "sex")
    assert "odds ratio" in table.columns
    assert table.loc["0", "odds ratio"] == pytest.approx(np.exp(fit.params["qsmk"]), rel=1e-3)


def test_effect_by_reads_a_mixed_model():
    frame = nhefs()
    fit = smf.mixedlm("wt82_71 ~ qsmk * C(sex) + age", data=frame.dropna(), groups="education").fit()
    table = whybook.effect_by(fit, "qsmk", "sex")
    assert table.loc["0", "effect of qsmk"] == pytest.approx(fit.params["qsmk"], rel=1e-3)


def test_effect_by_says_when_the_model_does_not_cross_them():
    with pytest.raises(ValueError, match="does not cross qsmk with sex"):
        whybook.effect_by(fitted("wt82_71 ~ qsmk + C(sex) + age"), "qsmk", "sex")


# The kept state of the pain diary demo: its mixed model, lmm_fit = smf.mixedlm("pain_score ~ treatment_arm * month + age", ...).


def demo_options(demo, frame, label):
    body = {"source": demo.column(frame, label), "target": {"cell": demo.cell("lmm")}, "cells": demo.cells_json(), "context": demo.context()}
    return drop_options(DropRequest.from_json(body))["options"]


@pytest.mark.demo
def test_site_dropped_on_the_demo_s_mixed_model_crosses_the_arm_with_site(demo, capsys):
    asked = question(demo_options(demo, "patients", "site"), "Does the effect of treatment_arm on pain_score differ by site?")
    assert asked["placement"]["kind"] == "branch"
    assert asked["effect"] == "Adds site to the model, crossed with treatment_arm"
    assert '"pain_score ~ treatment_arm * month + age + treatment_arm * C(site)",' in asked["code"]
    # The branch builds its own frame and fit, as a branch must: they run at the same time as the cell.
    assert "model_data_by_site = weekly.merge(" in asked["code"] and "lmm_fit_by_site = smf.mixedlm(" in asked["code"]
    capsys.readouterr()
    demo.run(asked["code"])
    printed = capsys.readouterr().out.splitlines()
    assert printed[0].startswith("Effect of treatment_arm (B against A) on pain_score: from ") and printed[0].endswith(", over 4 levels.")
    assert printed[1].startswith("Interaction of treatment_arm and site, 3 terms: chi-square = ")


@pytest.mark.demo
def test_il6_dropped_on_the_demo_s_mixed_model_is_joined_on_the_patient_first(demo):
    asked = question(demo_options(demo, "olink", "IL6"), "Does the effect of treatment_arm on pain_score differ by IL6?")
    assert "_lmm_fit_data_by_il6 = _lmm_fit_data_by_il6.merge(olink.groupby(" in asked["code"]
    assert "data=_lmm_fit_data_by_il6," in asked["code"]
    demo.run(asked["code"])


@pytest.mark.demo
@pytest.mark.parametrize(("frame", "label"), [("weekly", "treatment_arm"), ("weekly", "week"), ("weekly", "pain_score"), ("patients", "patient_id")])
def test_the_arm_time_the_outcome_and_the_unit_ask_no_such_question(demo, frame, label):
    assert not [option for option in demo_options(demo, frame, label) if option["text"].startswith("Does the effect")]
