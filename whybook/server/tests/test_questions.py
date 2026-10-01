import pytest

from whybook.server.questions import templates
from whybook.server.questions.models import AskedQuestion, Candidate, Context, Selection, Variable
from whybook.server.questions.rankers import jev_probabilities, jev_state, score_candidate

AGE = Variable("df['age']", "age", "numeric", parent="df", rows=100, missing=30)
INCOME = Variable("df['income']", "income", "numeric", parent="df", rows=100, missing=0)
SCHOOL = Variable("df['school']", "school", "categorical", parent="df", rows=100, unique=12)
SEX = Variable("df['sex']", "sex", "binary", parent="df", rows=100, unique=2)
VISITS = Variable("visits['age']", "age", "numeric", parent="visits", rows=50)
DF = Variable("df", "df", "dataframe", rows=100, n_columns=4)
ALPHA = Variable("alpha", "alpha", "constant", value="0.05")


def texts(selection):
    return {candidate.text for candidate in templates.generate(selection)}


def template_ids(selection):
    return {candidate.template for candidate in templates.generate(selection)}


def test_pair_of_numeric_columns():
    found = texts(Selection(AGE, INCOME))
    assert "Is age associated with income?" in found
    assert "Does income differ between the levels of age?" not in found


def test_pair_follows_the_template_order_whichever_is_clicked_first():
    assert "Does income differ between the levels of school?" in texts(Selection(INCOME, SCHOOL))
    assert "Does income differ between the levels of school?" in texts(Selection(SCHOOL, INCOME))


def test_symmetric_template_has_the_same_id_in_both_orders():
    forward = {c.id for c in templates.generate(Selection(AGE, INCOME)) if c.template == "association"}
    backward = {c.id for c in templates.generate(Selection(INCOME, AGE)) if c.template == "association"}
    assert forward == backward


def test_every_template_has_a_known_type():
    assert {t.type for t in templates.TEMPLATES} <= {"association", "causal", "quality", "model", "descriptive"}


def test_requirements_filter_templates():
    assert "missing_values" in template_ids(Selection(AGE, AGE))
    assert "missing_values" not in template_ids(Selection(INCOME, INCOME))
    assert "random_effect" in template_ids(Selection(SCHOOL, INCOME))
    assert "random_effect" not in template_ids(Selection(SEX, INCOME))
    assert "cross_table" in template_ids(Selection(AGE, VISITS))


def test_constant():
    assert texts(Selection(ALPHA, ALPHA)) == {"Why is alpha set to 0.05, and do the results depend on it?"}


def test_selection_from_json_rejects_unknown_kind():
    with pytest.raises(ValueError):
        Selection.from_json({"source": {"name": "x", "kind": "vector"}})


def test_variable_accepts_old_and_new_field_names():
    assert Variable.from_json({"name": "x", "kind": "numeric", "n_missing": 3}).missing == 3
    assert Variable.from_json({"name": "x", "kind": "numeric", "missing": 4, "unique": 9}).unique == 9


def test_context_reads_frames_with_rows():
    context = Context.from_json(
        {"unit": "id", "frames": {"big": {"rows": 900, "columns": {"id": "id"}}, "small": {"rows": 30, "columns": {"id": "id", "arm": "cat"}}}}
    )
    assert context.frames["small"] == {"id": "id", "arm": "cat"}
    assert context.unit_frame() == "small"


def scored(selection, context):
    """The template questions of a selection, scored by the rules and in their order."""
    candidates = templates.generate(selection)
    selected = {v.name: v for v in (selection.source, selection.target) if v is not None}
    for candidate in candidates:
        score_candidate(candidate, [selected[n] for n in candidate.variables if n in selected], context)
    return sorted(candidates, key=lambda c: c.probability or 0.0, reverse=True)


def test_the_rules_prefer_cleaning_a_column_with_missing_values():
    by_template = {c.template: c for c in scored(Selection(AGE), Context())}
    assert by_template["missing_values"].probability > by_template["transform"].probability
    assert "30% missing" in by_template["missing_values"].reasons


def test_the_rules_push_down_asked_questions():
    selection = Selection(AGE, INCOME)
    top = scored(selection, Context())[0]
    context = Context(asked=(AskedQuestion(top.id, top.text, top.type),), used=frozenset({"age", "income"}))
    second = scored(selection, context)
    assert second[0].id != top.id
    assert "already asked" in next(c for c in second if c.id == top.id).reasons


def test_score_keeps_the_candidates_own_reason_first():
    candidate = Candidate("x", "Does it?", "causal", "template", (), 0.5, reasons=["Open assumption in [4]"], code="pass")
    score_candidate(candidate, [], Context())
    assert candidate.reasons[0] == "Open assumption in [4]"
    assert "runs offline" in candidate.reasons
    assert "few causal questions so far" in candidate.reasons


def test_do_keeps_the_analysts_run_of_questions_and_wonder_leans_away_from_it():
    # The analyst asked a descriptive question last.
    last = AskedQuestion("x", "What does one row of df represent?", "descriptive")
    gaps = {}
    for mode in ("do", "report", "wonder"):
        context = Context(asked=(last,), mode=mode, last_type="descriptive")
        same = Candidate("a", "What is the median age?", "descriptive", "template", (), 0.5)
        other = Candidate("b", "Does age relate to income?", "model", "template", (), 0.5)
        score_candidate(same, [], context)
        score_candidate(other, [], context)
        gaps[mode] = same.probability - other.probability
        if mode == "do":
            assert "continues from the descriptive question asked last" in same.reasons
        if mode == "wonder":
            assert "a change from the descriptive question asked last" in other.reasons
    assert gaps["do"] > gaps["report"] > gaps["wonder"]


def test_the_models_that_propose_questions_read_the_mode():
    from whybook.server.questions.claude_questions import SYSTEM_PROMPT, local_state

    selection = Selection(AGE, INCOME)
    context = Context(mode="report")
    assert jev_state(selection, context)["mode"] == "report"
    assert local_state(selection, context, [])["mode"] == "report"
    for mode in ("do:", "report:", "wonder:"):
        assert mode in SYSTEM_PROMPT


@pytest.mark.parametrize("envelope", [False, True])
def test_jev_probabilities(envelope):
    body = {"model": "jev-1.13.0", "answers": {"q0": {"type": "noul", "noul": 0.2}, "q1": {"type": "noul", "noul": 0.9}}}
    if envelope:
        body = {"result": body, "success": True}
    assert jev_probabilities(body, 2) == [0.2, 0.9]


def test_the_branch_of_a_default_takes_the_value_that_its_function_accepts():
    from whybook.server.questions.cells import CellInfo, Decision, alternative_code

    cell = CellInfo(id="c3", label="[3]", source="kept = df.dropna()\nkept.shape")
    dropna = Decision(name="how", value='"any"', provenance="library_default", param="how", function="pandas.DataFrame.dropna")
    code = alternative_code(cell, dropna)
    assert 'df.dropna(how="all")' in code and '"left"' not in code
    import pandas as pd

    namespace = {"df": pd.DataFrame({"a": [1.0, None], "b": [None, None]})}
    exec(code, namespace)
    assert namespace["kept_how_all"].shape == (1, 2)
    merge = Decision(name="how", value='"inner"', provenance="library_default", param="how", function="pandas.merge")
    assert 'how="left"' in alternative_code(CellInfo(id="c4", label="[4]", source="both = pd.merge(a, b)"), merge)
