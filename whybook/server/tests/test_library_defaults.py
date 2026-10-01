"""The defaults that a model picks from a function's signature, and that the server keeps per library version.

Design iteration 1.53, "Find more defaults with AI" (whybook/server/library_defaults.py).
No model is called: the connected model and the local model are faked.
"""

import json

import pytest
from tornado.httpclient import HTTPClientError

from whybook.server import claude, connection, library_defaults, local_models

GROUPBY = {
    "function": "pandas.core.frame.DataFrame.groupby",
    "name": "DataFrame.groupby",
    "module": "pandas.core.frame",
    "library": "pandas",
    "version": "3.0.6",
    "params": [
        {"name": "by", "default": "None"},
        {"name": "level", "default": "None"},
        {"name": "as_index", "default": "True"},
        {"name": "sort", "default": "True"},
        {"name": "group_keys", "default": "True"},
        {"name": "observed", "default": "True"},
        {"name": "dropna", "default": "True"},
    ],
}
# A function whose defaults hold a frame and a key, as the kernel lists them.
FIT = {
    "function": "fakestats.fit",
    "name": "fit",
    "module": "fakestats",
    "library": "fakestats",
    "version": "2.1.0",
    "params": [
        {"name": "weights", "default": "<DataFrame 3 × 2>", "data": True},
        {"name": "token", "default": "'hf_" + "Q" * 34 + "'"},
        {"name": "alpha", "default": "0.05"},
    ],
}
# A function of R, as the R kernel lists it (kernel_code/r/analyze_cells.R):
# its package, its formals, whose names hold dots, and its language.
TTEST = {
    "function": "stats::t.test.formula",
    "name": "stats::t.test",
    "module": "stats",
    "library": "stats",
    "version": "4.4.3",
    "language": "R",
    "params": [
        {"name": "na.action", "default": "na.pass"},
        {"name": "alternative", "default": '"two.sided"'},
        {"name": "var.equal", "default": "FALSE"},
        {"name": "conf.level", "default": "0.95"},
    ],
}
WELCH = "Welch's test: the two groups may have different variances."
DROPNA = "Rows whose key is missing are left out of the groups."
SORT = "The groups come in the order of their keys."


@pytest.fixture
def fake_model(monkeypatch):
    """The connected model, faked: it answers with ``answer`` and keeps each prompt."""
    seen = {"prompts": [], "answer": {"picks": [{"param": "dropna", "why": DROPNA}, {"param": "sort", "why": SORT}]}}

    async def structured_call(prompt, *, schema, system_prompt, config, effort, images=None):
        seen["prompts"].append(json.loads(prompt))
        seen["system"] = system_prompt
        seen["schema"] = schema
        yield {"type": "progress", "stage": "thinking", "elapsed": 0.1}
        yield {"type": "result", "output": seen["answer"], "model": "fake-model", "cost_usd": 0.0003, "elapsed": 0.4}

    monkeypatch.setattr(claude, "structured_call", structured_call)
    monkeypatch.setattr(claude, "readiness", lambda config: {"available": True, "cli": "claude", "credential": "ANTHROPIC_API_KEY", "reason": None, "setup": None})
    return seen


async def post(jp_fetch, *path, body):
    response = await jp_fetch("whybook", *path, method="POST", body=json.dumps(body))
    return response.body.decode()


async def ask(jp_fetch, function, **extra):
    text = await post(jp_fetch, "defaults", "ask", body={"function": function, "model": "remote", **extra})
    return [json.loads(line) for line in text.splitlines()]


def stored(whybook_data):
    return json.loads((whybook_data / library_defaults.STORE).read_text())


async def test_the_model_picks_defaults_in_order_and_the_server_keeps_them_for_the_version(jp_fetch, fake_model, whybook_data):
    events = await ask(jp_fetch, GROUPBY)
    assert [event["type"] for event in events] == ["progress", "result"]
    result = events[-1]
    assert result["picks"] == [{"param": "dropna", "why": DROPNA}, {"param": "sort", "why": SORT}]
    assert (result["by"]["choice"], result["by"]["model"]) == ("remote", "fake-model")
    # What the call cost goes to the view, which counts it with the notebook's calls.
    assert (result["model"], result["cost_usd"]) == ("fake-model", 0.0003)
    # The model reads the signature: the function, its library's version and each default.
    prompt = fake_model["prompts"][0]
    assert prompt == {
        "language": "Python",
        "function": "DataFrame.groupby",
        "module": "pandas.core.frame",
        "library": "pandas",
        "version": "3.0.6",
        "parameters": [{"name": param["name"], "default": param["default"]} for param in GROUPBY["params"]],
    }
    assert fake_model["system"].rstrip().endswith('each with\n"param", a name from the list of parameters, and "why". Never send one pick on its own.')
    # Kept in Whybook's data folder, by library and version.
    kept = stored(whybook_data)["libraries"]["pandas"]["3.0.6"]["pandas.core.frame.DataFrame.groupby"]
    assert kept["picks"] == result["picks"] and kept["by"]["model"] == "fake-model"

    # The same function of the same version: the kept answer, and no call.
    again = await ask(jp_fetch, GROUPBY)
    assert again == [{"type": "result", "kept": True, "function": GROUPBY["function"], "library": "pandas", "version": "3.0.6", "picks": result["picks"], "by": result["by"]}]
    assert len(fake_model["prompts"]) == 1
    # The lookup reads the kept answers without a model: another version has none.
    newer = {**GROUPBY, "version": "3.1.0"}
    answers = json.loads(await post(jp_fetch, "defaults", body={"functions": [GROUPBY, newer]}))["answers"]
    assert [(answer["version"], answer["picks"]) for answer in answers] == [("3.0.6", result["picks"])]
    await ask(jp_fetch, newer)
    assert len(fake_model["prompts"]) == 2
    assert set(stored(whybook_data)["libraries"]["pandas"]) == {"3.0.6", "3.1.0"}


async def test_with_the_data_on_this_machine_a_default_that_holds_data_goes_without_its_value(jp_fetch, fake_model):
    fake_model["answer"] = {"picks": [{"param": "alpha", "why": "The level of the interval."}]}
    await ask(jp_fetch, FIT, keep_data_local=True)
    # Signatures and defaults are code: the other defaults go, the frame does not.
    assert fake_model["prompts"][0]["parameters"] == [{"name": "weights"}, {"name": "alpha", "default": "0.05"}]
    # Without the setting, the frame goes as its type and size, which is all the kernel sent.
    await ask(jp_fetch, {**FIT, "version": "2.2.0"})
    assert fake_model["prompts"][1]["parameters"] == [{"name": "weights", "default": "<DataFrame 3 × 2>"}, {"name": "alpha", "default": "0.05"}]


async def test_a_default_that_looks_like_a_key_goes_to_no_model(jp_fetch, fake_model, whybook_data):
    fake_model["answer"] = {"picks": [{"param": "token", "why": "Not a parameter that the model read."}, {"param": "alpha", "why": "The level of the interval."}]}
    events = await ask(jp_fetch, FIT)
    prompt = json.dumps(fake_model["prompts"][0])
    assert "hf_" not in prompt and "token" not in prompt
    # A pick of it is dropped, and the server keeps neither it nor its name.
    assert events[-1]["picks"] == [{"param": "alpha", "why": "The level of the interval."}]
    kept = stored(whybook_data)["libraries"]["fakestats"]["2.1.0"]["fakestats.fit"]
    assert kept["params"] == ["weights", "alpha"]


async def test_no_default_that_changes_the_result_is_an_answer_too(jp_fetch, fake_model, whybook_data):
    fake_model["answer"] = {"picks": []}
    assert (await ask(jp_fetch, GROUPBY))[-1]["picks"] == []
    assert (await ask(jp_fetch, GROUPBY))[-1]["kept"] is True
    assert len(fake_model["prompts"]) == 1


async def test_picks_that_name_no_parameter_are_an_error_that_keeps_its_cost_and_nothing_is_kept(jp_fetch, fake_model, whybook_data):
    fake_model["answer"] = {"picks": [{"param": "how", "why": "Not a parameter of groupby."}, {"param": "sort", "why": ""}]}
    events = await ask(jp_fetch, GROUPBY)
    assert events[-1] == {"type": "error", "message": library_defaults.NO_PICKS, "cost_usd": 0.0003, "elapsed": 0.4, "model": "fake-model"}
    assert not (whybook_data / library_defaults.STORE).exists()


async def test_the_answer_keeps_three_picks_each_once_and_only_of_the_signature(jp_fetch, fake_model):
    fake_model["answer"] = {
        "picks": [
            {"param": "dropna", "why": DROPNA},
            {"param": "dropna", "why": "Again."},
            {"param": "how", "why": "Not of groupby."},
            {"param": "sort", "why": SORT},
            {"param": "observed", "why": "Only the groups that occur."},
            {"param": "group_keys", "why": "A fourth one."},
        ]
    }
    picks = (await ask(jp_fetch, GROUPBY))[-1]["picks"]
    assert [pick["param"] for pick in picks] == ["dropna", "sort", "observed"]


async def test_without_a_connected_model_the_server_refuses_and_asks_nothing(jp_fetch, fake_model):
    connection.save(connection.Connection())
    with pytest.raises(HTTPClientError) as error:
        await ask(jp_fetch, GROUPBY)
    assert error.value.code == 409
    assert fake_model["prompts"] == []


async def test_a_local_model_reads_every_default_under_a_grammar_of_the_signature(jp_fetch, monkeypatch, whybook_data):
    seen = {}

    async def ask_json(model_id, system, user, schema, max_tokens, threads, stage, check="fast"):
        seen.update(model=model_id, user=user, schema=schema)
        yield {"type": "progress", "stage": stage, "elapsed": 0.0}
        yield {"type": "result", "output": {"picks": [{"param": "alpha", "why": "The level of the interval."}]}, "model": "Gemma 4 E2B", "file": "gemma.gguf", "cost_usd": 0.0, "elapsed": 2.0}

    monkeypatch.setattr(local_models, "ask_json", ask_json)
    monkeypatch.setattr(local_models, "model_of", lambda model_id, spec=None: type("Model", (), {"id": model_id})())
    events = await ask(jp_fetch, FIT, model="gemma-4-e2b", keep_data_local=True)
    assert events[-1]["picks"] == [{"param": "alpha", "why": "The level of the interval."}]
    assert events[-1]["by"]["choice"] == "gemma-4-e2b" and events[-1]["by"]["file"] == "gemma.gguf"
    # A model on this machine reads the frame's type and size too; the key goes to no model.
    assert seen["user"]["parameters"] == [{"name": "weights", "default": "<DataFrame 3 × 2>"}, {"name": "alpha", "default": "0.05"}]
    items = seen["schema"]["properties"]["picks"]
    # The key's parameter is not a name to pick either.
    assert items["maxItems"] == 3 and items["items"]["properties"]["param"]["enum"] == ["weights", "alpha"]
    assert "fakestats" in stored(whybook_data)["libraries"]


async def test_an_r_function_goes_to_the_model_with_its_language_and_names_with_dots(jp_fetch, fake_model, whybook_data):
    fake_model["answer"] = {"picks": [{"param": "var.equal", "why": WELCH}, {"param": "na.action", "why": "Missing values are kept."}]}
    events = await ask(jp_fetch, TTEST)
    assert events[-1]["picks"] == [{"param": "var.equal", "why": WELCH}, {"param": "na.action", "why": "Missing values are kept."}]
    # The prompt names the language, and the system prompt says what that is.
    prompt = fake_model["prompts"][0]
    assert (prompt["language"], prompt["function"], prompt["library"], prompt["version"]) == ("R", "stats::t.test", "stats", "4.4.3")
    assert [param["name"] for param in prompt["parameters"]] == ["na.action", "alternative", "var.equal", "conf.level"]
    assert '"language" names the language of the library, Python or R.' in " ".join(fake_model["system"].split())
    # Kept under R's package and version, by the function as the kernel names it.
    kept = stored(whybook_data)["libraries"]["stats"]["4.4.3"]["stats::t.test.formula"]
    assert kept["params"] == ["na.action", "alternative", "var.equal", "conf.level"]
    answers = json.loads(await post(jp_fetch, "defaults", body={"functions": [TTEST]}))["answers"]
    assert [answer["picks"][0]["param"] for answer in answers] == ["var.equal"]
    assert (await ask(jp_fetch, TTEST))[-1]["kept"] is True
    assert len(fake_model["prompts"]) == 1


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"function": "pandas.merge"},
        {"function": {**GROUPBY, "library": ""}},
        {"function": {**GROUPBY, "params": [{"name": "not a name"}]}},
        {"function": {**GROUPBY, "language": "Julia"}},
    ],
)
async def test_a_request_without_a_whole_function_is_refused(jp_fetch, fake_model, body):
    with pytest.raises(HTTPClientError) as error:
        await post(jp_fetch, "defaults", "ask", body=body)
    assert error.value.code == 400
    assert fake_model["prompts"] == []


async def test_a_broken_store_reads_as_empty_and_the_next_answer_mends_it(jp_fetch, fake_model, whybook_data):
    whybook_data.mkdir(parents=True, exist_ok=True)
    (whybook_data / library_defaults.STORE).write_text('{"libraries": {"pandas": ["not", "a", "map"]}}')
    assert json.loads(await post(jp_fetch, "defaults", body={"functions": [GROUPBY]}))["answers"] == []
    await ask(jp_fetch, GROUPBY)
    assert "3.0.6" in stored(whybook_data)["libraries"]["pandas"]


# Design iteration 1.86: the prompt asks for parameters worth a chip, and its version is part of what the server keeps.


async def test_the_prompt_asks_for_the_parameters_that_are_worth_a_chip_and_says_that_none_is_a_good_answer(jp_fetch, fake_model):
    await ask(jp_fetch, GROUPBY)
    system = " ".join(fake_model["system"].split())
    # A pick is a chip beside the cell, for a default that can change a number, a test or which rows are used.
    assert "shows each pick as a chip" in system
    assert "can change a number in the result, the outcome of a test, or which rows are used" in system
    # What only names, orders, formats or copies is never a pick, and no pick is an answer.
    assert "Never pick a parameter that only names, orders, formats or copies" in system
    assert "Picking none is a good answer" in system
    assert "pick at most 3" in system


async def test_an_answer_of_an_older_prompt_is_not_read_and_the_function_is_asked_again(jp_fetch, fake_model, whybook_data):
    first = await ask(jp_fetch, GROUPBY)
    entry = stored(whybook_data)["libraries"]["pandas"]["3.0.6"]["pandas.core.frame.DataFrame.groupby"]
    assert entry["prompt"] == library_defaults.PROMPT_VERSION
    # The answer that the server kept before the prompt had a version has none.
    old = stored(whybook_data)
    del old["libraries"]["pandas"]["3.0.6"]["pandas.core.frame.DataFrame.groupby"]["prompt"]
    (whybook_data / library_defaults.STORE).write_text(json.dumps(old))
    assert json.loads(await post(jp_fetch, "defaults", body={"functions": [GROUPBY]}))["answers"] == []
    # The model is asked again, with no word of the kept answer, and the new answer replaces it.
    fake_model["answer"] = {"picks": []}
    again = await ask(jp_fetch, GROUPBY)
    assert len(fake_model["prompts"]) == 2
    assert again[-1]["type"] == "result" and "kept" not in again[-1] and again[-1]["picks"] == []
    assert stored(whybook_data)["libraries"]["pandas"]["3.0.6"]["pandas.core.frame.DataFrame.groupby"]["picks"] == []
    # The answer of today's prompt is kept: no model, and no pick, which is an answer too.
    third = await ask(jp_fetch, GROUPBY)
    assert third == [{"type": "result", "kept": True, "function": GROUPBY["function"], "library": "pandas", "version": "3.0.6", "picks": [], "by": again[-1]["by"]}]
    assert len(fake_model["prompts"]) == 2
    assert first[-1]["picks"] != []


async def test_an_answer_of_another_prompt_version_is_asked_again_whichever_way_the_version_differs(jp_fetch, fake_model, whybook_data, monkeypatch):
    await ask(jp_fetch, GROUPBY)
    monkeypatch.setattr(library_defaults, "PROMPT_VERSION", library_defaults.PROMPT_VERSION + 1)
    assert json.loads(await post(jp_fetch, "defaults", body={"functions": [GROUPBY]}))["answers"] == []
    await ask(jp_fetch, GROUPBY)
    assert len(fake_model["prompts"]) == 2
