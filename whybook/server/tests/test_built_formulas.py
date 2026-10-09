"""The formula of a cell that builds it from strings, as the line under a card's chips shows it.

The cells of the survey video build their formulas as
``'sad_or_hopeless ~ frequent_use + ' + ' + '.join(f'C({v})' for v in vars_model[5:])``.
The analysis listed the string alone, so the card read
"sad_or_hopeless ~ frequent_use +" and stopped. It now reads the formula
whole, from the values that it is built from (kernel_code/analyze_cells.py).
"""

import pytest

pytestmark = pytest.mark.demo


def formulas(demo, source):
    return demo.kernel("analyze_cells", {"cells": [{"id": "x", "source": source}]})["cells"]["x"]["formulas"]


def test_a_formula_built_from_a_list_that_the_cell_writes_is_read_whole(demo):
    # [35] of the survey video, with its list cut to five names.
    source = (
        "vars_model = ['sad_or_hopeless', 'social_media', 'weight', 'sex', 'grade']\n"
        "formula = 'sad_or_hopeless ~ frequent_use + ' + ' + '.join(f'C({v})' for v in vars_model[3:])\n"
        "fit = smf.glm(formula, data=dat).fit()"
    )
    assert formulas(demo, source) == ["sad_or_hopeless ~ frequent_use + C(sex) + C(grade)"]
    joined = "covariates = ['age', 'site']\nformula = 'pain_score ~ treatment_arm + ' + ' + '.join(covariates)"
    assert formulas(demo, joined) == ["pain_score ~ treatment_arm + age + site"]
    # The names that a condition keeps, as in a take of the survey video.
    kept = (
        "adj = ['sex', 'grade', 'race_ethnicity']\n"
        "formula_sex = 'sad_or_hopeless ~ high_social * C(sex) + ' + ' + '.join(f'C({v})' for v in adj if v != 'sex')"
    )
    assert formulas(demo, kept) == ["sad_or_hopeless ~ high_social * C(sex) + C(grade) + C(race_ethnicity)"]
    # An f-string, and a name in quotes.
    quoted = "outcome = 'pain_score'\nterms = ['sleep hours']\nformula = f'{outcome} ~ treatment_arm + ' + ' + '.join(f'Q({t!r})' for t in terms)"
    assert formulas(demo, quoted) == ["pain_score ~ treatment_arm + Q('sleep hours')"]


def test_a_list_of_another_cell_is_the_kernels(demo):
    demo.run("adjusted_for = ['age', 'site']")
    try:
        # [37] of the survey video reads the list of [35].
        source = "formula = 'pain_score ~ treatment_arm + ' + ' + '.join(adjusted_for)"
        assert formulas(demo, source) == ["pain_score ~ treatment_arm + age + site"]
    finally:
        demo.run("del adjusted_for")


def test_what_the_code_adds_is_said_in_words_where_its_names_are_not_known(demo):
    # Before the cell that makes the list runs.
    source = "formula = 'pain_score ~ treatment_arm + ' + ' + '.join(not_yet_made)"
    assert formulas(demo, source) == ["pain_score ~ treatment_arm + the names of not_yet_made"]
    in_braces = "formula = f\"pain_score ~ treatment_arm + {' + '.join(not_yet_made)}\""
    assert formulas(demo, in_braces) == ["pain_score ~ treatment_arm + the names of not_yet_made"]
    # A list that is known, of names that a function of the analyst writes.
    counted = "covariates = ['age', 'site']\nformula = 'pain_score ~ treatment_arm + ' + ' + '.join(term(c) for c in covariates)"
    assert formulas(demo, counted) == ["pain_score ~ treatment_arm + the 2 names of covariates"]


def test_a_name_that_the_cell_adds_to_is_the_kernels_value(demo):
    source = "built = 'pain_score ~ treatment_arm'\nfor extra in ['age', 'site']:\n    built += ' + ' + extra"
    demo.run(source)
    try:
        assert formulas(demo, source) == ["pain_score ~ treatment_arm + age + site"]
    finally:
        demo.run("del built, extra")


def test_a_piece_that_cannot_be_read_whole_is_no_formula(demo):
    # The names of a function are its own.
    source = "def fit(covariates):\n    return smf.ols('pain_score ~ treatment_arm + ' + ' + '.join(covariates), data=weekly).fit()"
    assert formulas(demo, source) == []
    # Some names of a list, which a condition that runs code picks: no count can say how many.
    picked = "adj = ['sex', 'grade']\nformula = 'pain_score ~ treatment_arm + ' + ' + '.join(v for v in adj if keep(v))"
    assert formulas(demo, picked) == []
    # A formula written whole stays as it is.
    assert formulas(demo, 'fit = smf.ols("pain_score ~ week", data=weekly).fit()') == ["pain_score ~ week"]
