"""Questions about the text of a markdown cell, and the prompt that answers them."""

import json

from whybook.server.questions.cells import CellInfo, cell_questions, excerpt, states_numbers
from whybook.server.questions.models import Context
from whybook.server.solve import NOTE_TASK, PLACEMENT_PROMPTS, SolveRequest

SUMMARY = (
    "Pain falls over the six months in both arms, faster in arm B, by 0.32 points more per month. "
    "More patients stop keeping the diary in the first 12 weeks in arm A (26%) than in arm B (9%)."
)
CONTEXT = Context.from_json(
    {
        "outcome": "pain_score",
        "unit": "patient_id",
        "frames": {"patients": {"rows": 300, "columns": {"patient_id": "id", "site": "cat", "pain_score": "num"}}},
    }
)


def note(source=SUMMARY, **extra):
    return CellInfo.from_json({"id": "summary", "type": "markdown", "label": "§7 Summary", "source": source, **extra})


def test_a_text_with_numbers_asks_to_recompute_them_after_the_text():
    questions = cell_questions([note()], CONTEXT)
    texts = [question.text for question in questions]
    assert "Can each number in this text be recomputed from the data?" in texts
    assert "Do the claims in this text hold at every site?" in texts
    # A model answers each one: no template reads prose.
    assert all(question.code is None for question in questions)
    assert {question.placement.label for question in questions} == {"new cell after §7 Summary"}


def test_selected_words_are_quoted_in_the_question():
    words = note("by 0.32 points more per month", excerpt=True)
    texts = [question.text for question in cell_questions([words], CONTEXT)]
    assert "Can each number in “by 0.32 points more per month” be recomputed from the data?" in texts


def test_a_causal_verb_gets_its_own_question():
    texts = [question.text for question in cell_questions([note("Arm B reduces pain.")], CONTEXT)]
    assert "Does “reduces” claim a cause that the design does not show?" in texts
    # No number worth checking: no question about numbers.
    assert not any("number" in text for text in texts)


def test_a_text_selected_with_a_cell_is_checked_against_it():
    cell = CellInfo.from_json({"id": "effects", "label": "[19]", "source": "effects"})
    questions = cell_questions([note(), cell], CONTEXT)
    assert questions[0].text == "Does §7 Summary say what [19] shows?"


def test_small_whole_numbers_are_not_worth_checking():
    assert not states_numbers("in the first 12 weeks, 3 sites")
    assert states_numbers("26%") and states_numbers("0.32") and states_numbers("4,812 proteins")
    assert excerpt("Pain falls over the six months in both arms", 30) == "Pain falls over the six…"


def test_a_question_about_a_text_asks_the_model_to_check_the_text():
    cell = {"label": "§7 Summary", "kind": "markdown", "source": SUMMARY}
    question = {"text": "Can each number in this text be recomputed from the data?", "type": "quality"}
    body = json.loads(SolveRequest.from_json({"question": question, "placement": "new", "cell": cell}).prompt())
    assert body["task"] == NOTE_TASK
    assert body["cell"] == cell
    code = {"label": "[4]", "source": "weekly = diary.groupby('week').mean()"}
    body = json.loads(SolveRequest.from_json({"question": question, "placement": "new", "cell": code}).prompt())
    assert body["task"] == PLACEMENT_PROMPTS["new"]
    assert body["cell"]["kind"] == "code"
