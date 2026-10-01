"""What a reviewer would ask about the whole notebook: the route of the Check-up section's question (design iteration 1.67).

The view asks it when the analyst presses Ask, with the code cells, what the
rules found, and the notebook's context. No test calls a model: each fakes
the call and reads the prompt that would have gone.
"""

import json

import pytest
from tornado.httpclient import HTTPClientError

from whybook.server import claude, local_models
from whybook.server.questions import review

CELLS = [
    {
        "id": "c1",
        "label": "[1]",
        "title": "Load the visits",
        "code": "visits = pd.read_csv('visits.csv')",
        "outputs": [],
        "text": "",
    },
    {
        "id": "c2",
        "label": "[2]",
        "title": "Mixed model",
        "code": "fit = smf.mixedlm('pain ~ arm * week', visits, groups='patient').fit()\nfit.summary()",
        "outputs": ["table", "log"],
        "text": "arm[T.B]  -0.857  0.160",
    },
]
FINDINGS = ["[2] fits fit, a mixed model, and no cell reads its residuals."]
CONTEXT = {
    "mode": "report",
    "outcome": "pain",
    "unit": "patient",
    "frames": {"visits": {"columns": {"pain": "num", "arm": "cat", "week": "int", "patient": "id"}, "rows": 5837}},
    "asked": [{"id": "q1", "text": "Does pain fall with week?", "type": "association"}],
}
ANSWER = {
    "questions": [
        {"text": "Is the arm effect the same without the patients who left early?", "type": "causal", "cell": "[2]", "why": "Dropout can differ by arm."},
        {"text": "Does pain fall with week?", "type": "association", "cell": "[2]", "why": "Asked before."},
        {"text": "Are the visits of each patient evenly spaced?", "type": "quality", "cell": "[9]", "why": "A label the notebook lacks."},
    ]
}


@pytest.fixture
def prompts(monkeypatch):
    """The prompts that would go to the connected model, which answers with ANSWER."""
    seen = []

    async def structured_call(prompt, *, schema, system_prompt, config, effort, images=None):
        seen.append({"prompt": json.loads(prompt), "system": system_prompt, "schema": schema})
        yield {"type": "progress", "stage": "thinking", "elapsed": 0.1}
        yield {"type": "result", "output": ANSWER, "model": "fake-model", "cost_usd": 0.004, "elapsed": 0.3}

    monkeypatch.setattr(claude, "structured_call", structured_call)
    monkeypatch.setattr(claude, "readiness", lambda config: {"available": True, "cli": "claude", "credential": "ANTHROPIC_API_KEY", "reason": None, "setup": None})
    return seen


async def post(jp_fetch, body):
    response = await jp_fetch("whybook", "questions", "review", method="POST", body=json.dumps(body))
    return [json.loads(line) for line in response.body.decode().splitlines()]


async def test_the_model_reads_the_cells_and_the_rules_findings_and_asks_about_cells(jp_fetch, prompts):
    events = await post(jp_fetch, {"model": "remote", "cells": CELLS, "findings": FINDINGS, "context": CONTEXT})
    sent = prompts[0]["prompt"]
    assert [cell["label"] for cell in sent["cells"]] == ["[1]", "[2]"]
    assert sent["cells"][1]["title"] == "Mixed model"
    assert sent["cells"][1]["code"].startswith("fit = smf.mixedlm(")
    assert sent["cells"][1]["outputs"] == ["table", "log"]
    assert sent["cells"][1]["prints"] == "arm[T.B]  -0.857  0.160"
    # A cell that prints nothing has no text to read.
    assert "prints" not in sent["cells"][0]
    assert sent["findings"] == FINDINGS
    assert sent["frames"]["visits"]["rows"] == 5837
    assert sent["outcome"] == "pain" and sent["unit"] == "patient"
    assert sent["already_asked"] == ["Does pain fall with week?"]
    assert "do not repeat them" in prompts[0]["system"]
    assert events[0]["type"] == "progress"
    result = events[-1]
    assert result["type"] == "result" and result["cost_usd"] == 0.004
    # A question asked before is left out, and a label that the notebook lacks names no cell.
    assert [(question["text"], question["cell"]) for question in result["questions"]] == [
        ("Is the arm effect the same without the patients who left early?", "[2]"),
        ("Are the visits of each patient evenly spaced?", None),
    ]
    assert {question["origin"] for question in result["questions"]} == {"claude"}
    assert all(question["id"].startswith("review:") for question in result["questions"])


async def test_with_the_data_kept_here_the_model_reads_no_output_text(jp_fetch, prompts):
    await post(jp_fetch, {"model": "remote", "cells": CELLS, "findings": FINDINGS, "context": CONTEXT, "keep_data_local": True})
    sent = prompts[0]["prompt"]
    assert all("prints" not in cell for cell in sent["cells"])
    # The code and the kinds of the outputs still go: they are what the model reviews.
    assert sent["cells"][1]["code"].startswith("fit = smf.mixedlm(")
    assert sent["cells"][1]["outputs"] == ["table", "log"]


async def test_at_most_five_questions(jp_fetch, prompts, monkeypatch):
    many = {"questions": [{"text": f"Question {n} about the model?", "type": "model", "cell": "[2]", "why": "why"} for n in range(8)]}

    async def structured_call(prompt, *, schema, system_prompt, config, effort, images=None):
        yield {"type": "result", "output": many, "model": "fake-model", "elapsed": 0.1}

    monkeypatch.setattr(claude, "structured_call", structured_call)
    events = await post(jp_fetch, {"model": "remote", "cells": CELLS, "findings": [], "context": {}})
    assert len(events[-1]["questions"]) == 5


async def test_an_answer_that_breaks_the_schema_is_an_error(jp_fetch, prompts, monkeypatch):
    async def structured_call(prompt, *, schema, system_prompt, config, effort, images=None):
        yield {"type": "result", "output": {"questions": [{"text": "Why?"}]}, "model": "fake-model", "elapsed": 0.1}

    monkeypatch.setattr(claude, "structured_call", structured_call)
    events = await post(jp_fetch, {"model": "remote", "cells": CELLS, "findings": [], "context": {}})
    assert events[-1]["type"] == "error"
    assert "did not come in the form asked for" in events[-1]["message"]


@pytest.mark.parametrize(
    "body",
    [
        {"model": "remote", "cells": [], "context": {}},
        {"model": "remote", "context": {}},
        {"model": "remote", "cells": [{"label": "[1]"}], "context": {}},
        {"model": "somewhere", "cells": CELLS, "context": {}},
    ],
)
async def test_bad_requests_are_refused(jp_fetch, prompts, body):
    with pytest.raises(HTTPClientError) as error:
        await post(jp_fetch, body)
    assert error.value.code == 400
    assert prompts == []


async def test_a_local_model_reads_the_last_cells_shorter_under_a_grammar_of_the_labels(jp_fetch, monkeypatch):
    seen = {}

    async def ask_json(model_id, system, user, schema, max_tokens, threads, stage, check="fast"):
        seen.update(model=model_id, user=user, schema=schema, check=check)
        output = {"questions": [{"text": "Does the arm effect hold without age", "type": "model", "cell": "[2]", "why": "age differs by arm"}]}
        yield {"type": "result", "output": output, "model": "Gemma 4 E2B", "cost_usd": 0.0, "elapsed": 2.0}

    monkeypatch.setattr(local_models, "ask_json", ask_json)
    monkeypatch.setattr(local_models, "model_of", lambda model_id, spec=None: type("Model", (), {"id": model_id})())
    cells = [{**CELLS[1], "id": f"c{n}", "label": f"[{n}]", "code": "x = 1\n" * 200} for n in range(1, 21)]
    events = await post(jp_fetch, {"model": "gemma-4-e2b", "cells": cells, "findings": [], "context": CONTEXT, "json_check": "standard"})
    assert seen["model"] == "gemma-4-e2b" and seen["check"] == "standard"
    assert [cell["label"] for cell in seen["user"]["cells"]] == [f"[{n}]" for n in range(9, 21)]
    assert all(len(cell["code"]) == review.LOCAL_CODE_CHARS for cell in seen["user"]["cells"])
    # A local model reads the text of the outputs: the data stays on this machine.
    assert seen["user"]["cells"][0]["prints"] == "arm[T.B]  -0.857  0.160"
    assert seen["schema"]["properties"]["questions"]["items"]["properties"]["cell"]["enum"] == sorted(f"[{n}]" for n in range(1, 21))
    assert events[-1]["questions"][0]["origin"] == "local"
    assert events[-1]["questions"][0]["cell"] == "[2]"
