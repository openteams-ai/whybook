"""The names and values in a question's text, marked as code or as data (design iterations 1.145 and 1.146).

A parameter, a function, a constant, a fitted model and a value are code, in
backticks: the view shows them in the code font. A column, a frame, a table
and a file are data, between two asterisks: the view shows their exact names
in bold. A what-if question names the call it goes into, and a join reads as
its chip: "What if the merge with **patients** were an outer join?". A code
comment, the id of a question and the models that order and type questions
read the text without the marks.
"""

from whybook.server import codegen, sorting
from whybook.server.questions import ranking, starts, templates
from whybook.server.questions.cells import CellInfo, Decision, DecisionCall, decision_options, next_steps, question_id, what_if_text
from whybook.server.questions.claude_questions import LOCAL_SYSTEM_PROMPT, SYSTEM_PROMPT
from whybook.server.questions.marks import as_code, as_data, plain
from whybook.server.questions.models import AskedQuestion, Context, Selection, Variable

# Home energy [4]: two merges that leave how='inner', one decision of two calls.
DAILY = CellInfo("c4", "[4]", 'daily = (\n    readings.merge(homes, on="home_id")\n    .merge(weather, on=["region", "date"])\n)\ndaily.head()')
HOMES, WEATHER = DecisionCall(2, 13, "homes"), DecisionCall(3, 5, "weather")
HOW = Decision("how", "'inner'", "library_default", param="how", function="DataFrame.merge", calls=(HOMES, WEATHER))
# The pain diary demo's [5]: one merge with patients, how="left".
MERGE = CellInfo("c8", "[8]", 'model_data = weekly.merge(patients, on="patient_id", how="left")')
LEFT = Decision("how", "'left'", "literal", param="how", function="DataFrame.merge", calls=(DecisionCall(1, 20, "patients"),))


def test_a_name_or_a_value_goes_in_its_marks_and_comes_out_of_them():
    assert as_code("how") == "`how`"
    assert as_code('"outer"') == '`"outer"`'
    assert as_data("treatment_arm") == "**treatment_arm**"
    # A text that the marks would break, or an empty one, stays as it is.
    assert [as_code("a`b"), as_code("a\nb"), as_code("")] == ["a`b", "a\nb", ""]
    assert [as_data("a*b"), as_data(" a"), as_data("")] == ["a*b", " a", ""]
    assert plain('What if `how` were `"outer"` in the merge with **patients**?') == 'What if how were "outer" in the merge with patients?'
    # Asterisks with spaces around them, as in a power, are no mark.
    assert plain("Is x ** 2 or y ** 3 larger?") == "Is x ** 2 or y ** 3 larger?"


def test_a_join_reads_as_its_chip_and_names_the_frame_that_it_joins():
    [outer] = decision_options(MERGE, LEFT, Context())["options"]
    assert outer["text"] == "What if the merge with **patients** were an outer join?"
    # The view records the analyst's choice by the value, which the words do not give.
    assert outer["value"] == '"outer"'
    # The comment of its code has no marks.
    assert outer["code"].splitlines()[0] == "# What if the merge with patients were an outer join? A branch of [8], where it is 'left'."
    # The id is that of the text before 1.145 and 1.146: a notebook keeps the ids of the questions it asked.
    assert outer["id"] == question_id('What if how were "outer"?', "c8", "how")
    texts = [option["text"] for option in decision_options(DAILY, HOW, Context(), calls=(WEATHER,))["options"]]
    assert texts == ["What if the merge with **weather** were a left join?", "What if the merge with **weather** were an outer join?", "Choose `how` in [4], in the merge with **weather**"]
    assert what_if_text(HOW, "'outer'") == "What if both merges were outer joins?"
    assert codegen.comment("Choose `how` in [4], in the merge with **weather**") == "# Choose how in [4], in the merge with weather"


def test_another_decision_names_its_value_as_code_and_its_call():
    reml = Decision("reml", "True", "library_default", param="reml", function="MixedLM.fit", calls=(DecisionCall(4, 2, "model_data"),))
    assert what_if_text(reml, "False") == "What if `reml` were `False` in the `fit` of **model_data**?"
    # A call that names no frame, as a class's call does.
    c = Decision("C", "1.0", "library_default", param="C", function="LogisticRegression.__init__", calls=(DecisionCall(1, 12),))
    assert what_if_text(c, "1e6") == "What if `C` were `1e6` in the `LogisticRegression` call?"
    # A decision that lists no call, as a constant of a module: the question as before.
    days = Decision("MIN_DAYS", "14", "defaulted", param="min_days", function="weekly_means")
    assert what_if_text(days, "7") == "What if `MIN_DAYS` were `7`?"


def test_the_questions_of_one_call_name_the_call_and_keep_the_ids_of_their_texts_before():
    cell = CellInfo("c2", "[2]", 'homes = pd.read_csv("homes.csv")\nhomes', defs=("homes",))
    header = Decision("header", "'infer'", "library_default", param="header", function="read_csv", calls=(DecisionCall(1, 11, "homes"),))
    options = decision_options(cell, header, Context())["options"]
    assert [option["text"] for option in options] == [
        "What if `header` were `None` in the read of **homes**?",
        "What if `header` were `0` in the read of **homes**?",
        "Choose `header` in [2], in the read of **homes**",
    ]
    before = ["What if header were None?", "What if header were 0?", "Choose header in [2]"]
    assert [option["id"] for option in options] == [question_id(text, "c2", "header") for text in before]


def test_the_catalogue_marks_columns_as_data_and_a_constant_as_code():
    age = Variable("df['age']", "age", "numeric", parent="df", rows=100)
    income = Variable("df['income']", "income", "numeric", parent="df", rows=100)
    alpha = Variable("alpha", "alpha", "constant", value="0.05")
    assert "Is **age** associated with **income**?" in {candidate.text for candidate in templates.generate(Selection(age, income))}
    assert "Why is `alpha` set to `0.05`, and do the results depend on it?" in {candidate.text for candidate in templates.generate(Selection(alpha))}


def test_a_frame_named_as_its_rows_stays_a_word_and_another_is_data():
    assert starts.rows_of("visits", marked=True) == "visits"
    assert starts.rows_of("model_data", marked=True) == "rows of **model_data**"
    # The code that prints the count keeps the name without the marks.
    assert starts.rows_of("model_data") == "rows of model_data"


def test_the_models_that_order_and_type_questions_read_them_without_the_marks():
    request = ranking.request_from_json(
        {
            "model": "remote",
            "questions": [{"id": "q1", "text": "Is **age** associated with **income**?", "type": "association"}],
            "context": {"cells": ["What if the merge with **patients** were an outer join?"], "asked": [{"id": "q0", "text": "What if `reml` were `False` in the `fit` of **model_data**?", "type": "model"}]},
        }
    )
    assert request["questions"][0]["text"] == "Is age associated with income?"
    state = ranking.state_of(request)
    assert state["analysis_so_far"] == ["What if the merge with patients were an outer join?"]
    assert state["already_asked"] == ["What if reml were False in the fit of model_data?"]
    assert sorting.request_from_json({"text": "Does **age** differ by `site`?"})["text"] == "Does age differ by site?"


def test_a_question_asked_before_the_marks_is_not_offered_again():
    # The scorecard of the finance video stopped at max_iter=100 before it converged (design iteration 1.116).
    limit = Decision.from_json({"name": "max_iter", "value": "100", "provenance": "library_default", "param": "max_iter", "function": "LogisticRegression", "calls": [{"line": 1, "col": 12}], "when": "not_converged"})
    scorecard = CellInfo("c4", "[4]", "scorecard = LogisticRegression().fit(X, y)\nscorecard.coef_", decisions=(limit,))
    offered = [step.text for step in next_steps([scorecard], Context(), {}, set())]
    assert "Does `max_iter` = `100` change the result of [4]?" in offered
    # The notebook saved the question as it read before the marks.
    asked = Context(asked=(AskedQuestion("q0", "Does max_iter = 100 change the result of [4]?", "model"),))
    assert "Does `max_iter` = `100` change the result of [4]?" not in [step.text for step in next_steps([scorecard], asked, {}, set())]


def test_a_model_that_writes_questions_is_asked_for_the_marks_and_a_model_on_this_machine_is_not():
    assert "between two asterisks" in SYSTEM_PROMPT and "in backticks" in SYSTEM_PROMPT
    # The local models were measured on prompts without the request.
    assert "asterisks" not in LOCAL_SYSTEM_PROMPT and "in backticks" not in LOCAL_SYSTEM_PROMPT
