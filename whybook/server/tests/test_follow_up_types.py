"""The agent writes each follow-up question with one of the five types (design iteration 1.100).

The finish tool asked for "its type, a colon and the question" and named no
type. Of the 55 follow-ups of the agent's runs in the takes of the demo
video of 7 October 2026, 13 carried one of the five, 20 a type of the
model's own, such as "robustness:" or "missing-data:", and 22 none; the view
showed each of the 42 as Descriptive. The prompt of a one-cell answer names
the five, and its 18 follow-ups in the takes carried one each.
"""

from whybook.server import agent, solve
from whybook.server.questions.models import TYPES

TYPES_LINE = "The type is association, causal, quality (data quality), model (a model check) or descriptive."


def test_the_agent_names_the_five_types_of_a_follow_up_as_a_one_cell_answer_does():
    described = agent.TOOLS["finish"]["schema"]["properties"]["follow_up"]["description"]
    assert described.startswith("Up to 3 questions the answer raises, each as its type, a colon and the question,")
    assert 'such as "association: Does sleep relate to pain?".' in described
    assert described.endswith(TYPES_LINE)
    assert all(kind in described for kind in TYPES)
    # The one-cell prompt says it in the same words.
    assert TYPES_LINE in " ".join(solve.SYSTEM_TEMPLATE.split())
