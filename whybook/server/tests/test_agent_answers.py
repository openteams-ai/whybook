"""An agent's answer and its cells (design iteration 1.84).

Energy, step 11: the answer of run 2 ended with the markup of the model's
tool call, '</answer>' and '<parameter name="cells">["[4]","[5]"]', in the
answer card. The model, Claude Sonnet 5 through OpenRouter, closed the
answer with a wrong tag, so the parameter cells went into the answer's
text. The tests send that text through both drivers, the Claude Agent SDK
and Pydantic AI, with a fake model.

Energy, step 28: the first cell of run 4, "Inspect tariffs table fully",
only showed the tariffs table that the cell before it shows. run_cell
refuses a cell whose code only shows a frame of "variables", or what a cell
of the run shows at its end. No model runs.
"""

import sys

import pytest

from whybook.server import agent
from whybook.server.config import Whybook

from .test_agent import THRESHOLD, VISITS, claude_code_sdk, drive, request

# The answer of run 2 as the notebook kept it (energy, pass 2, step 11), with
# the model's own dashes written as escapes.
ANSWER = (
    "Neither sentinel class should be left as-is or simply deleted outright: both should be recoded to missing and then imputed,"
    " not silently dropped. The 999.9 rows [4] are clearly a sensor/placeholder error code — for every affected home the"
    " normal daily kwh_import is 3–55 kWh [5], so 999.9 is impossible; converting these to NaN and imputing (e.g. with the"
    " home's own interpolated/seasonal value) preserves the daily time series needed for modelling instead of leaving a 364-day"
    " gap. For the zero-import rows, only 2 of 5 also show positive export while import is exactly 0 kWh [5], which is"
    " physically implausible (can't export without any recorded import on a day with activity) and points to a stuck/missing"
    " meter read, so those should be treated as missing and imputed too; the remaining zero-import/zero-export rows look like"
    " genuine no-usage days and can be kept as true zeros. Because these cases are rare (4 sentinel + 5 zero rows out of"
    " 129,058, cells [1],[4]) outright deletion would barely affect aggregate estimates, but for home-level or time-series"
    " modelling, imputing preserves continuity and avoids biasing per-home totals."
)
MARKUP = '</answer>\n<parameter name="cells">["[4]","[5]"]'
FOLLOW_UP = [
    "data: What imputation method (interpolation vs. home/season median) best reconstructs these sentinel days without biasing the daily totals?",
    "data: Are there other sentinel-like codes (e.g. negative values or repeated identical readings) hiding elsewhere in kwh_peak/kwh_night/kwh_export?",
    "data: Do the affected homes share any common meter type, region, or install date that explains the sensor error?",
]
# The finish call of run 2: no cells, since they went into the answer.
FINISH = {"answer": ANSWER + MARKUP, "follow_up": FOLLOW_UP}
# The namespace of the tags of a tool call in the format of Claude's prompts.
NS = "antml" + ":"


def assert_clean(final):
    assert final["type"] == "result"
    assert final["answer"] == ANSWER
    assert final["cells"] == ["[4]", "[5]"]
    assert final["follow_up"] == FOLLOW_UP


async def test_the_markup_of_a_tool_call_leaves_the_answer_through_the_claude_agent_sdk(monkeypatch):
    from .test_claude import ResultMessage

    sdk = claude_code_sdk(lambda SystemMessage: [])

    class Client(sdk.ClaudeSDKClient):
        async def receive_response(self):
            # The CLI calls the tool of the in-process server, as Claude asked for it.
            tools = dict(zip(agent.TOOLS, self.options.mcp_servers["whybook"]["tools"]))
            await tools["finish"](FINISH)
            yield ResultMessage(is_error=False, subtype="success", errors=[], total_cost_usd=0.057662)

    sdk.ClaudeSDKClient = Client
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", sdk)
    found = await drive(agent.run_events(request(), Whybook(), agent.claude_driver), [])
    assert_clean(found[-1])


async def test_the_markup_of_a_tool_call_leaves_the_answer_through_pydantic_ai(monkeypatch):
    pytest.importorskip("pydantic_ai")
    from whybook.server import model_client

    from .test_model_client import OLLAMA, agent_model

    model = agent_model([("finish", FINISH)])
    monkeypatch.setattr(model_client, "build_model", lambda chosen, key: model)
    found = await drive(agent.run_events(request(), Whybook(), model_client.agent_driver(OLLAMA, None, agent.TOOLS)), [])
    assert_clean(found[-1])


@pytest.mark.parametrize(
    "arguments, expected",
    [
        # A parameter closed with the right tag, and the end of the call after it.
        (
            {"answer": 'Arm B has less pain ([2]).</parameter>\n<parameter name="follow_up">["causal: Does age explain it?"]</parameter>\n</invoke>'},
            {"answer": "Arm B has less pain ([2]).", "follow_up": ["causal: Does age explain it?"]},
        ),
        # A tag that opens the answer, and tags with the namespace.
        (
            {"answer": f'<answer>Yes ([3]).</answer><{NS}parameter name="cells">["[3]"]</{NS}parameter>'},
            {"answer": "Yes ([3]).", "cells": ["[3]"]},
        ),
        # The cells that the call gives win over those of the markup, and markup in a follow-up goes.
        (
            {"answer": 'Yes ([3]).</answer><parameter name="cells">["[9]"]', "cells": ["[3]"], "follow_up": ["causal: Why?</parameter>", "</parameter>"]},
            {"answer": "Yes ([3]).", "cells": ["[3]"], "follow_up": ["causal: Why?"]},
        ),
        # A parameter of the wrong type fills nothing.
        ({"answer": 'Yes ([3]).</answer><parameter name="cells">[3, 4]'}, {"answer": "Yes ([3])."}),
        # A "<" that is no tag stays, and so does a text without markup, as it came.
        ({"answer": "Pain is lower in arm B, p < 0.001 and x<5 ([2]). ", "cells": ["[2]"]}, {"answer": "Pain is lower in arm B, p < 0.001 and x<5 ([2]). ", "cells": ["[2]"]}),
        (None, {}),
    ],
)
def test_the_arguments_of_finish_lose_the_markup_and_keep_what_it_held(arguments, expected):
    assert agent.finish_arguments(arguments) == expected


TARIFFS = {
    "name": "tariffs",
    "kind": "dataframe",
    "type": "pandas.core.frame.DataFrame",
    "rows": 5,
    "columns": [{"label": "tariff", "tag": "cat", "levels": ["flat", "time of use"]}, {"label": "eur_per_kwh", "tag": "num", "min": 0.15, "max": 0.45}],
}


async def test_a_cell_that_only_shows_a_frame_of_the_notebook_is_refused_and_counts_no_cell():
    # Run 4 of energy, pass 2: its first cell showed the tariffs table again.
    bills = "import pandas as pd\n\nbills = tariffs.merge(rates, on='tariff')\nbills.head()"
    steps = [
        ("run_cell", {"title": "Inspect tariffs table fully", "code": "tariffs"}),
        ("run_cell", {"title": "Prices in full", "code": "import pandas as pd\n\nwith pd.option_context('display.max_rows', None):\n    print(tariffs.to_string())"}),
        ("run_cell", {"title": "Monthly bills", "code": bills}),
        ("run_cell", {"title": "Bills again", "code": "bills"}),
        ("finish", {"answer": "Switchers pay less ([15]).", "cells": ["[15]"]}),
    ]
    results = [{"status": "ok", "cell": "[15]"}]
    # One cell at most: the refused ones count none.
    found = await drive(agent.run_events(request(Whybook(agent_max_cells=1), variables=[VISITS, THRESHOLD, TARIFFS]), Whybook(), agent.scripted(steps)), results)
    assert [event["input"]["title"] for event in found if event["type"] == "tool"] == ["Monthly bills"]
    outcomes = found[-1]["results"]
    assert outcomes[0] == {
        "status": "refused",
        "error": (
            'No cell was added: the code only shows tariffs, a frame of "variables", which gives its columns and size.'
            " Cite the cell that makes it, and read what you need of tariffs in the cell that uses it."
        ),
    }
    assert outcomes[1]["status"] == "refused"
    assert outcomes[3] == {
        "status": "refused",
        "error": "No cell was added: the code only shows bills, which [15] shows already. Cite [15], and read what you need of bills in the cell that uses it.",
    }


async def test_a_cell_that_does_more_than_show_or_changes_what_it_shows_runs():
    steps = [
        ("run_cell", {"title": "Prices by period", "code": "tariffs.groupby('tariff').eur_per_kwh.mean()"}),
        ("run_cell", {"title": "Rows of visits", "code": "print('rows:', len(visits))"}),
        ("run_cell", {"title": "Bills", "code": "bills = tariffs.copy()\nbills"}),
        ("run_cell", {"title": "Rounded bills", "code": "bills = bills.round(2)"}),
        # The bills changed since [17] showed them.
        ("run_cell", {"title": "Bills", "code": "bills"}),
        # A frame that the run made without showing it.
        ("run_cell", {"title": "Rates", "code": "rates = tariffs.set_index('tariff')"}),
        ("run_cell", {"title": "Rates shown", "code": "rates.head()"}),
        # Another notebook reads its own copy of the frame.
        ("run_cell", {"title": "Tariffs in R", "code": "head(tariffs)", "notebook": "home_energy.R.ipynb"}),
        ("finish", {"answer": "done"}),
    ]
    results = [{"status": "ok", "cell": f"[{label}]"} for label in range(15, 23)]
    found = await drive(agent.run_events(request(variables=[VISITS, THRESHOLD, TARIFFS]), Whybook(), agent.scripted(steps)), results)
    assert len([event for event in found if event["type"] == "tool"]) == 8
    assert all(outcome["status"] == "ok" for outcome in found[-1]["results"])


@pytest.mark.parametrize(
    "code, shown",
    [
        ("tariffs", {"tariffs"}),
        ("import pandas as pd\ntariffs.head(10)", {"tariffs"}),
        ("pd.set_option('display.width', 200)\npd.options.display.max_rows = None\ndisplay(tariffs)", {"tariffs"}),
        ("library(dplyr)\nprint(head(tariffs))", {"tariffs"}),
        ("tariffs\nhomes.tail()", {"tariffs", "homes"}),
        ("tariffs.merge(homes)", set()),
        ("tariffs.groupby('tariff').head()", set()),
        ("x = tariffs\nx", set()),
        ("tariffs <- read.csv('tariffs.csv')", set()),
        ("print('rows:', len(tariffs))", set()),
        ("import pandas as pd", set()),
        ("", set()),
    ],
)
def test_what_a_cell_only_shows(code, shown):
    assert agent.only_shows(code) == shown
