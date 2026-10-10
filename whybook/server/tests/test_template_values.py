"""A value that a template wrote is the template's, and not the AI's (design iteration 1.76, energy step 6).

The view marks a literal of code that a template wrote with no model call
as ``template`` (src/model/decisions.ts). The questions of its chip say who
chose it, and the model that suggests other values reads it.
"""

from whybook.server.questions import values
from whybook.server.questions.cells import CellInfo, Decision, decision_options, single_cell_questions
from whybook.server.questions.models import Context

JOIN = CellInfo(id="c2", label="[2]", source='homes = pd.read_csv("homes.csv")\nreadings_homes = readings.merge(homes, on="home_id", how="left")')


def left(provenance):
    return Decision(name="how", value='"left"', provenance=provenance, param="how", function="DataFrame.merge")


def test_the_questions_of_a_templates_value_say_that_the_template_chose_it():
    assert decision_options(JOIN, left("template"), Context())["note"] == "chosen by the template you picked"
    assert decision_options(JOIN, left("agent"), Context())["note"] == "chosen by AI"


def test_a_templates_value_is_not_offered_as_the_agents_choice():
    # "Is how = "left" the right choice?" is asked of the values of code that a
    # model wrote, or that does not record which wrote it (test_question_words.py).
    assert [option.effect for option in single_cell_questions(JOIN, Context()) if "checked it" in option.effect] == []
    agent = CellInfo(id="c2", label="[2]", source=JOIN.source, decisions=[left("agent")])
    template = CellInfo(id="c2", label="[2]", source=JOIN.source, decisions=[left("template")])
    assert [option.effect for option in single_cell_questions(agent, Context())] == ["Nobody checked it"]
    assert single_cell_questions(template, Context()) == []


def test_the_model_that_suggests_values_reads_who_chose_a_templates_value():
    state = values.prompt_state("how", '"left"', "how", "DataFrame.merge", "template", None, JOIN.source, keep_local=False)
    assert state["set_by"] == "written by a template that the analyst picked"
