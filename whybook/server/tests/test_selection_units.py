"""The rows picked in a plot, and the units of a column, in the prompts of an agent and of a one-cell answer (design iteration 1.95).

While the demo video of 7 October was recorded, the analyst picked the 65
people whose weight changed by 15.6 to 48.5 kg on a histogram and asked
"How many of them quit smoking, and how old were they?". The request
carried the rows as "about", which the agent's system prompt did not
explain, and the answer was about all 1,629 rows. In three takes out of
three the agent also wrote "units", "pounds" and "lb" for wt82_71, which is
in kilograms: the model gets the names and the kinds of the columns, and no
unit. The tests check what the prompts hold; no model runs, so no test shows
that a model follows them.
"""

import json
import sys

import pytest

from whybook.server import agent, solve
from whybook.server.config import Whybook
from whybook.server.questions.models import InvalidRequest
from whybook.server.solve import SolveRequest

from .test_agent import claude_code_sdk, drive, request

ABOUT = 'the rows of nhefs where 15.604805330000012 <= wt82_71 <= 48.53838568000002, picked in the plot "Distribution of wt82_71"'
ROWS = {"frame": "nhefs", "mask": 'nhefs["wt82_71"].between(15.604805330000012, 48.53838568000002)'}
SELECTED = 'nhefs[nhefs["wt82_71"].between(15.604805330000012, 48.53838568000002)]'
QUESTION = {"text": "How many of them quit smoking, and how old were they?", "type": "descriptive"}


def words(text):
    return " ".join(text.split())


def test_the_agent_s_task_line_names_the_rows_picked_and_the_code_that_selects_them():
    body = json.loads(request(question=QUESTION, about=ABOUT, rows=ROWS).prompt())
    assert body["task"] == (
        f"Answer the question with cells that you add and run. The question is about {ABOUT}: answer it for those rows alone,"
        f" not for every row of nhefs. Select them with {SELECTED}."
    )
    assert body["about"] == ABOUT
    assert body["rows"] == ROWS


def test_a_one_cell_answer_names_them_in_its_task_line_too():
    body = json.loads(SolveRequest.from_json({"question": QUESTION, "placement": "new", "about": ABOUT, "rows": ROWS}).prompt())
    assert body["task"].startswith(solve.PLACEMENT_PROMPTS["new"] + f" The question is about {ABOUT}: answer it for those rows alone")
    assert body["task"].endswith(f"Select them with {SELECTED}.")
    assert body["rows"] == ROWS


def test_a_pick_without_rows_is_named_in_the_task_line():
    about = "the column age of the table that cell [5] shows"
    assert json.loads(request(about=about).prompt())["task"] == f"Answer the question with cells that you add and run. The question is about {about}."
    # Without a pick, the task line is as it was.
    assert json.loads(request().prompt())["task"] == agent.TASK


def test_with_the_data_kept_here_the_mask_stays_here():
    for prompt in (
        request(keep_data_local=True, question=QUESTION, about=ABOUT, rows=ROWS).prompt(),
        solve.privacy.local_request(SolveRequest.from_json({"question": QUESTION, "placement": "new", "about": ABOUT, "rows": ROWS})).prompt(),
    ):
        body = json.loads(prompt)
        assert "rows" not in body
        assert "15.6" not in prompt and "48.5" not in prompt
        assert body["task"].endswith("The question is about the part of a table or a plot that the analyst picked, not about all the data.")


def test_rows_go_only_with_what_they_are_about_and_are_checked():
    assert SolveRequest.from_json({"question": QUESTION, "placement": "new", "rows": ROWS}).rows is None
    for rows in ({"frame": "nhefs"}, {"frame": "nhefs[0]", "mask": "x"}, {"frame": "nhefs", "mask": "x" * 1001}, "nhefs"):
        with pytest.raises(InvalidRequest, match="rows needs"):
            SolveRequest.from_json({"question": QUESTION, "placement": "new", "about": ABOUT, "rows": rows})


# What each rule says, in the prompts' words.
AGENT_RULES = {
    "rows picked": 'If "about" is present, the question is about what it names, such as rows picked in a plot, and not about all the data.',
    "the mask": '"rows" then gives the frame and the pandas mask of those rows: select them with it, as it is.',
    "units": 'Name a unit, such as kg or years, only when the data, a column\'s name, a file or an output gives it; otherwise write "in the units of" and the column\'s name.',
    "codebook": 'When "files" holds a codebook or a data dictionary, read what it says of the columns that the answer reports.',
}
CELL_RULES = {
    "rows picked": 'If "about" is present, it names what the analyst pointed at when asking, such as rows picked in a plot: the question is about that, and not about all the data.',
    "the mask": '"rows" then gives the frame and the pandas mask of those rows: select them with it, as it is.',
    "units": 'Name a unit, such as kg or years, only when the data, a column\'s name, a file or an output gives it. Otherwise write "in the units of" and the column\'s name.',
}


@pytest.mark.parametrize("rule", sorted(AGENT_RULES))
def test_the_agent_s_prompt_has_the_rule(rule):
    assert AGENT_RULES[rule] in words(request().system_prompt())


@pytest.mark.parametrize("rule", sorted(CELL_RULES))
def test_the_one_cell_prompt_has_the_rule_in_every_language(rule):
    for language in ("python", "r"):
        assert CELL_RULES[rule] in words(solve.system_prompt(language))


async def test_the_rules_and_the_rows_reach_the_model_through_the_claude_agent_sdk(monkeypatch):
    from .test_claude import ResultMessage

    sdk = claude_code_sdk(lambda SystemMessage: [ResultMessage(is_error=False, subtype="success", errors=[], total_cost_usd=0.01)])
    sent = []
    query = sdk.ClaudeSDKClient.query

    async def keep(self, prompt):
        sent.append(prompt)
        await query(self, prompt)

    sdk.ClaudeSDKClient.query = keep
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", sdk)
    await drive(agent.run_events(request(question=QUESTION, about=ABOUT, rows=ROWS), Whybook(), agent.claude_driver), [])
    system = words(sdk.options[-1].system_prompt)
    assert all(rule in system for rule in AGENT_RULES.values())
    assert f"Select them with {SELECTED}." in json.loads(sent[-1])["task"]
