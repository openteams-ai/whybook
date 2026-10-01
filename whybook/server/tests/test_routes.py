import json

import pytest
from tornado.httpclient import HTTPClientError

AGE = {"name": "df['age']", "label": "age", "kind": "numeric", "parent": "df", "tag": "int", "rows": 100, "missing": 30}
INCOME = {"name": "df['income']", "label": "income", "kind": "numeric", "parent": "df", "tag": "num", "rows": 100, "missing": 0}
CONTEXT = {
    "outcome": "income",
    "unit": "person_id",
    "frames": {"df": {"rows": 100, "columns": {"person_id": "id", "age": "int", "income": "num", "site": "cat"}}},
}
CELL = {
    "id": "c1",
    "label": "[1]",
    "source": 'fit = smf.ols("income ~ site", data=df).fit()',
    "defs": ["fit"],
    "uses": ["df", "smf"],
    "formulas": ["income ~ site"],
    "columns": {"df": ["income", "site"]},
    "decisions": [],
}


async def post(jp_fetch, *path, body):
    response = await jp_fetch("whybook", *path, method="POST", body=json.dumps(body))
    return json.loads(response.body)


async def test_status(jp_fetch):
    response = await jp_fetch("whybook", "status")
    payload = json.loads(response.body)
    assert payload["ranker"] == "heuristic"
    assert payload["jev_configured"] in (True, False)
    assert payload["describe_tables"] is True
    # The connected model: the Claude Code login until the analyst connects another (connection.py).
    assert set(payload["claude"]) == {"available", "cli", "credential", "reason", "setup", "provider", "model", "label", "local", "priced"}
    assert payload["claude"]["provider"] == "claude-code"
    assert payload["claude"]["local"] is False
    assert payload["claude_available"] is payload["claude"]["available"]


async def test_status_says_why_the_remote_model_cannot_answer(jp_fetch, monkeypatch):
    from whybook.server import claude

    # Neither the CLI nor its credential is looked for by a call to the model.
    monkeypatch.setattr(claude, "credential", lambda environ=None: None)
    payload = json.loads((await jp_fetch("whybook", "status")).body)
    assert payload["claude_available"] is False
    assert payload["claude"]["reason"] in (
        "the Claude Code CLI is missing on the server",
        "the Claude Code CLI on the server has no credential: no ANTHROPIC_API_KEY and no login",
    )
    assert payload["claude"]["setup"]


async def test_table_notes_need_the_tables(jp_fetch):
    # Checked before any call to Claude.
    with pytest.raises(HTTPClientError) as error:
        await post(jp_fetch, "tables", "describe", body={"tables": []})
    assert error.value.code == 400


async def test_drop_a_column_onto_a_model_cell(jp_fetch):
    payload = await post(jp_fetch, "drop", body={"source": AGE, "target": {"cell": CELL}, "cells": [CELL], "context": CONTEXT})
    assert payload["title"] == "age onto [1]"
    covariate = next(o for o in payload["options"] if o["text"] == "Add age as a covariate")
    assert covariate["code"] == 'fit = smf.ols("income ~ site + age", data=df).fit()'
    assert covariate["placement"]["kind"] == "edit"
    assert all(o["type"] in ("association", "causal", "quality", "model", "descriptive") for o in payload["options"])


async def test_drop_needs_a_target(jp_fetch):
    with pytest.raises(HTTPClientError) as error:
        await post(jp_fetch, "drop", body={"source": AGE, "target": {}})
    assert error.value.code == 400


async def test_cell_questions_need_a_cell(jp_fetch):
    with pytest.raises(HTTPClientError) as error:
        await post(jp_fetch, "cell-questions", body={"cells": []})
    assert error.value.code == 400


async def test_next_steps(jp_fetch):
    payload = await post(jp_fetch, "next", body={"cells": [CELL], "context": CONTEXT, "groups": {}, "dismissed": []})
    texts = [q["text"] for q in payload["questions"]]
    assert "How does age relate to income?" in texts


async def test_solve_rejects_a_question_without_text(jp_fetch):
    with pytest.raises(HTTPClientError) as error:
        await post(jp_fetch, "solve", body={"question": {}, "selection": {"source": AGE}})
    assert error.value.code == 400


async def test_solve_rejects_an_edit_without_a_cell(jp_fetch):
    with pytest.raises(HTTPClientError) as error:
        await post(jp_fetch, "solve", body={"question": {"text": "Add age"}, "placement": "edit"})
    assert error.value.code == 400


async def test_solve_takes_a_table_dragged_from_the_databases_panel(jp_fetch, jp_root_dir, monkeypatch):
    import sqlite3
    from contextlib import closing

    from whybook.server import solve

    with closing(sqlite3.connect(jp_root_dir / "clinic.sqlite")) as db:
        db.execute("CREATE TABLE visits (patient_id TEXT, crp REAL)")
        db.commit()
    prompts = []

    async def answer(prompt, **_):
        prompts.append(json.loads(prompt))
        yield {"type": "result", "output": {"summary": "s", "code": "x = 1", "assumptions": [], "follow_up": []}}

    monkeypatch.setattr(solve.claude, "structured_call", answer)
    table = {"kind": "table", "name": "visits", "label": "visits", "path": "clinic.sqlite", "kernel_path": "clinic.sqlite", "table": "visits"}
    response = await jp_fetch("whybook", "solve", method="POST", body=json.dumps({"question": {"text": "What could visits add to this analysis?"}, "selection": {"source": table, "target": None}})
    )
    events = [json.loads(line) for line in response.body.decode().splitlines()]
    assert events[-1]["type"] == "result"
    assert [c["name"] for c in prompts[0]["selected"][0]["columns"]] == ["patient_id", "crp"]


async def test_databases_lists_sqlite_files_under_the_root(jp_fetch, jp_root_dir):
    import sqlite3
    from contextlib import closing

    with closing(sqlite3.connect(jp_root_dir / "clinic.sqlite")) as db:
        db.execute("CREATE TABLE visits (patient_id TEXT)")
        db.commit()
    listed = json.loads((await jp_fetch("whybook", "databases")).body)
    assert [d["path"] for d in listed["databases"]] == ["clinic.sqlite"]
    response = await jp_fetch("whybook", "databases", "tables", params={"path": "clinic.sqlite"})
    assert [t["name"] for t in json.loads(response.body)["tables"]] == ["visits"]


async def test_database_paths_outside_the_root_are_refused(jp_fetch):
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "databases", "tables", params={"path": "../outside.db"})
    assert error.value.code == 403


async def test_decision_offers_what_if_branches(jp_fetch):
    cell = {"id": "c2", "label": "[2]", "source": "weekly = weekly_means(diary)", "defs": ["weekly"], "uses": ["diary"]}
    decision = {"name": "MIN_DAYS", "value": "14", "provenance": "defaulted", "param": "min_days", "function": "weekly_means"}
    payload = await post(jp_fetch, "decision", body={"cell": cell, "decision": decision, "context": {}})
    assert [o["text"] for o in payload["options"]][:2] == ["What if MIN_DAYS were 7?", "What if MIN_DAYS were 21?"]
    with pytest.raises(HTTPClientError) as error:
        await post(jp_fetch, "decision", body={"cell": cell, "decision": decision, "value": "10 +"})
    assert error.value.code == 400


async def test_decision_takes_the_call_that_a_value_goes_into(jp_fetch):
    cell = {"id": "c4", "label": "[4]", "source": "both = visits.merge(patients, on='id').merge(labs, on='id')"}
    calls = [{"line": 1, "col": 14, "target": "patients"}, {"line": 1, "col": 39, "target": "labs"}]
    decision = {"name": "how", "value": "'inner'", "provenance": "library_default", "param": "how", "function": "DataFrame.merge", "calls": calls}
    payload = await post(jp_fetch, "decision", body={"cell": cell, "decision": decision, "context": {}, "calls": calls[1:]})
    first = payload["options"][0]
    assert first["text"] == 'What if how were "left" in the merge with labs?'
    assert "visits.merge(patients, on='id').merge(labs, on='id', how=\"left\")" in first["code"]
    # A call that the decision does not cover is refused.
    with pytest.raises(HTTPClientError) as error:
        await post(jp_fetch, "decision", body={"cell": cell, "decision": decision, "calls": [{"line": 2, "col": 0}]})
    assert error.value.code == 400
