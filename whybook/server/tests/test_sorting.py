"""User questions sorted by a model, and more questions from a local model.

The decision models are answered by a fake fetch, and the local models by a
fake llama_cpp: nothing leaves the machine and no model loads.
"""

import importlib.machinery
import json
import os
import sys
import types

import pytest
from tornado.httpclient import HTTPClientError

from whybook.server import decision_models, local_models, sorting
from whybook.server.keystore import KeyStore
from whybook.server.config import Whybook
from whybook.server.questions import claude_questions
from whybook.server.questions.models import Context, InvalidRequest, Selection

AGE = {"name": "df['age']", "label": "age", "kind": "numeric", "parent": "df", "rows": 100, "missing": 30}
INCOME = {"name": "df['income']", "label": "income", "kind": "numeric", "parent": "df", "rows": 100, "missing": 0}


def test_the_request_keeps_the_question_the_first_lines_of_its_cell_and_known_places():
    cell = "\n".join(f"line {number}" for number in range(30))
    request = sorting.request_from_json({"text": "  Add age\n as a covariate ", "cell": cell, "places": ["new", "edit", "somewhere"]})
    assert request["text"] == "Add age as a covariate"
    assert request["cell"].splitlines() == [f"line {number}" for number in range(20)]
    assert request["places"] == ["new", "edit"]
    with pytest.raises(InvalidRequest):
        sorting.request_from_json({"text": "  "})


def test_a_decision_model_gets_the_question_as_state_and_a_choice_per_decision():
    request = sorting.request_from_json({"text": "Add age", "cell": "fit = ols()", "places": ["new", "edit", "preview"]})
    body = sorting.decision_body(request)
    assert body["state"] == {"question": "Add age", "cell": "fit = ols()"}
    assert body["questions"]["type"]["type"] == "choice"
    assert list(body["questions"]["type"]["criteria"]) == ["descriptive", "association", "causal", "model", "quality"]
    # Only the places the view can use are offered.
    assert list(body["questions"]["place"]["criteria"]) == ["new", "edit", "preview"]
    # With one place or none there is nothing to choose.
    alone = sorting.decision_body(sorting.request_from_json({"text": "Add age", "places": ["new"]}))
    assert "place" not in alone["questions"]


def test_a_decision_model_needs_an_openrouter_key_or_its_makers_api():
    found = decision_models.status(Whybook(typesafe_api_key=""))
    assert set(found) == set(decision_models.MODELS)
    assert all(not state["available"] for state in found.values())
    assert found["solar-decide"]["reason"] == "needs an OpenRouter key: sign in with OpenRouter in the AI models panel"
    # Jev also answers through TypeSafe's own API.
    assert decision_models.status(Whybook(typesafe_api_key="key"))["jev"]["available"] is True
    KeyStore().set("openrouter", "sk-or-test")
    found = decision_models.status(Whybook())
    assert found["solar-decide"] == {"label": "Solar Decide by Upstage", "available": True, "reason": None}
    # With zero data retention on, a model with no such endpoint is not offered.
    assert found["luna-decisions"]["available"] is False
    assert "zero data retention" in found["luna-decisions"]["reason"]
    assert decision_models.status(Whybook(zero_data_retention=False))["luna-decisions"]["available"] is True


def answers_of(place="edit"):
    return {
        "type": {"type": "choice", "choice": "model", "confidence": 0.6, "probabilities": {"model": 0.7, "causal": 0.3}},
        "place": {"type": "choice", "choice": place, "confidence": 0.8, "probabilities": {place: 0.9, "new": 0.1}},
    }


async def test_a_decision_model_is_asked_through_openrouter_with_zero_data_retention():
    calls = []

    async def fetch(url, **options):
        calls.append((url, options))
        return types.SimpleNamespace(body=json.dumps({"model": "upstage/solar-decide-20260928", "usage": {"cost": 0.00006}, "answers": answers_of()}))

    KeyStore().set("openrouter", "sk-or-test")
    request = sorting.request_from_json({"text": "Add age", "places": ["new", "edit"]})
    sorted_ = await sorting.ask(decision_models.MODELS["solar-decide"], request, Whybook(), fetch)
    url, options = calls[0]
    assert url == "https://openrouter.ai/api/v1/systemone"
    assert options["headers"]["Authorization"] == "Bearer sk-or-test"
    sent = json.loads(options["body"])
    assert sent["model"] == "upstage/solar-decide"
    assert sent["provider"] == {"zdr": True}
    assert sent["state"] == {"question": "Add age"}
    assert sorted_["type"] == {"choice": "model", "probabilities": {"model": 0.7, "causal": 0.3}}
    assert sorted_["place"]["choice"] == "edit"
    assert sorted_["model"] == "upstage/solar-decide-20260928"
    assert sorted_["cost_usd"] == 0.00006
    # With zero data retention off, OpenRouter may route to any endpoint.
    await sorting.ask(decision_models.MODELS["solar-decide"], request, Whybook(zero_data_retention=False), fetch)
    assert "provider" not in json.loads(calls[1][1]["body"])


async def test_jev_goes_through_typesafes_api_when_there_is_no_openrouter_key():
    calls = []

    async def fetch(url, **options):
        calls.append((url, options))
        return types.SimpleNamespace(body=json.dumps({"model": "jev-1.13.0", "usage": {}, "answers": answers_of()}))

    config = Whybook(typesafe_api_key="key", typesafe_base_url="https://jev.example/")
    request = sorting.request_from_json({"text": "Add age", "places": ["new", "edit"]})
    sorted_ = await sorting.ask(decision_models.MODELS["jev"], request, config, fetch)
    url, options = calls[0]
    assert url == "https://jev.example/v1/systemone"
    assert options["headers"]["Authorization"] == "Bearer key"
    assert json.loads(options["body"])["model"] == "jev-latest"
    assert sorted_["model"] == "jev-1.13.0"
    # Another decision model has no API of its own here.
    with pytest.raises(ValueError, match="OpenRouter key"):
        await sorting.ask(decision_models.MODELS["clef"], request, config, fetch)


def test_an_answer_that_is_not_a_choice_is_refused():
    with pytest.raises(ValueError):
        sorting.decision_answers({"type": {"type": "noul", "noul": 0.2}})


def test_a_choice_of_the_settings_names_its_decision_model():
    assert decision_models.model_of("decision:clef").label == "Clef by Cloudflare"
    assert decision_models.model_of("jev").id == "jev"
    assert decision_models.model_of("decision:unknown") is None
    assert decision_models.model_of("gemma-4-e2b") is None


async def test_the_route_refuses_a_decision_model_without_a_key_and_unknown_models(jp_fetch, monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "questions", "sort", method="POST", body=json.dumps({"text": "Add age", "model": "decision:jev"}))
    assert error.value.code == 409
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "questions", "sort", method="POST", body=json.dumps({"text": "Add age", "model": "remote"}))
    assert error.value.code == 400
    status = json.loads((await jp_fetch("whybook", "status")).body)
    assert status["decision_models"]["jev"]["available"] is False


@pytest.fixture
def typesafe_key_in_the_environment(monkeypatch):
    monkeypatch.setenv("TYPESAFE_API_KEY", "ts-test-0000")


async def test_the_typesafe_key_of_the_environment_reaches_no_kernel(typesafe_key_in_the_environment, jp_fetch):
    # Every kernel that the server starts inherits its environment: the server keeps the key and takes it out.
    status = json.loads((await jp_fetch("whybook", "status")).body)
    assert status["decision_models"]["jev"]["available"] is True
    assert "TYPESAFE_API_KEY" not in os.environ


class FakeContext:
    def __init__(self, llm):
        self.ctx = object()
        self._llm = llm

    def get_logits(self):
        # One token per character: the letter "D" (model) gets the largest logit.
        logits = [0.0] * 256
        text = "".join(chr(token) for token in self._llm.input_ids[: self._llm.n_tokens])
        if "Which of these questions does the analyst ask next?" in text:
            # An order of questions: the letter of a question about a typo is unlikely.
            options = [line for line in text.splitlines() if line[:1] == "(" and line[2:4] == ") "]
            for line in options:
                logits[ord(line[1])] = -1.0 if "typo" in line else 1.0
            return logits
        for letter, value in zip("ABCDE", (1.0, 0.5, 0.2, 3.0, 0.1)):
            logits[ord(letter)] = value
        return logits


class FakeChatLlama:
    """Tokens are characters; eval records what it evaluates."""

    made: list["FakeChatLlama"] = []

    def __init__(self, model_path, **options):
        self.metadata = {"tokenizer.chat_template": "{% for m in messages %}<{{ m.role }}>{{ m.content }}\n{% endfor %}<assistant>"}
        self.n_tokens = 0
        self.input_ids = [0] * 8192
        self.evaluated = []
        self._ctx = FakeContext(self)
        self.answer = "{}"
        FakeChatLlama.made.append(self)

    def token_bos(self):
        return -1

    def token_eos(self):
        return 0

    def detokenize(self, tokens, special=False):
        return b"</s>"

    def tokenize(self, text, add_bos=False, special=True):
        return [min(ord(char), 255) for char in text.decode()]

    def eval(self, tokens):
        self.evaluated.append(len(tokens))
        self.input_ids[self.n_tokens : self.n_tokens + len(tokens)] = tokens
        self.n_tokens += len(tokens)

    def create_chat_completion(self, messages, response_format, temperature, max_tokens):
        return {"choices": [{"message": {"content": self.answer}}]}


@pytest.fixture
def fake_llama(tmp_path, monkeypatch):
    """A llama_cpp with FakeChatLlama and the state functions, and the models in a fake cache."""
    module = types.ModuleType("llama_cpp")
    module.__spec__ = importlib.machinery.ModuleSpec("llama_cpp", None)
    module.Llama = FakeChatLlama
    module.saved = []
    module.restored = []
    module.llama_get_memory = lambda ctx: "memory"
    module.llama_memory_clear = lambda memory, data: None
    module.llama_state_seq_get_size = lambda ctx, seq: 4

    def get_data(ctx, buffer, size, seq):
        buffer[:4] = list(b"STAT")
        module.saved.append(size)
        return 4

    module.llama_state_seq_get_data = get_data
    module.llama_state_seq_set_data = lambda ctx, buffer, size, seq: module.restored.append(bytes(buffer))
    monkeypatch.setitem(sys.modules, "llama_cpp", module)
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path))
    monkeypatch.setattr(local_models, "_loaded", None)
    monkeypatch.setattr(local_models, "_saved", {})
    monkeypatch.setattr(local_models, "_fast_failure", None)
    monkeypatch.setattr(FakeChatLlama, "made", [])
    for model in local_models.MODELS.values():
        snapshot = tmp_path / ("models--" + model.repo.replace("/", "--")) / "snapshots" / "abc123"
        snapshot.mkdir(parents=True)
        (snapshot / model.file).write_bytes(b"GGUF")
    return module


def test_a_local_model_types_a_question_from_the_letters_where_the_answer_starts(fake_llama):
    first = local_models.classify(local_models.MODELS["gemma-4-e2b"], "Should age enter the model?", 4)
    assert first["type"]["choice"] == "model"
    assert abs(sum(first["type"]["probabilities"].values()) - 1) < 1e-3
    assert first["place"] is None
    llm = FakeChatLlama.made[0]
    # The start that every question shares is evaluated once, and its state kept.
    assert fake_llama.saved == [4] and fake_llama.restored == []
    shared, question = llm.evaluated
    # The next question starts from the kept state: only its own tokens are evaluated.
    local_models.classify(local_models.MODELS["gemma-4-e2b"], "Is age related to income?", 4)
    assert fake_llama.restored == [b"STAT"]
    assert llm.evaluated[-1] < shared + question


async def test_the_route_sorts_with_a_local_model(jp_fetch, fake_llama):
    response = await jp_fetch("whybook", "questions", "sort", method="POST", body=json.dumps({"text": "Should age enter the model?", "model": "minicpm5-2b"})
    )
    sorted_ = json.loads(response.body)
    assert sorted_["type"]["choice"] == "model"
    assert sorted_["model"] == "MiniCPM5 2B"
    # What the call cost, which the view keeps: nothing, on this machine.
    assert sorted_["cost_usd"] == 0.0


async def test_the_route_gives_a_local_decision_model_the_cell_and_the_places(jp_fetch, monkeypatch):
    calls = []

    async def ask(model_id, text, threads, cell=None, places=None):
        calls.append((model_id, text, cell, places))
        return {"type": {"choice": "model", "probabilities": {"model": 1.0}}, "place": {"choice": "edit", "probabilities": {"edit": 0.6, "new": 0.4}}, "model": "JevK5 v0.3 (4B)"}

    monkeypatch.setattr(local_models, "ask_classify", ask)
    body = {"text": "Add age", "model": "jevk5-4b", "cell": "fit = ols('pain ~ site', d)", "places": ["new", "edit", "teleport"]}
    sorted_ = json.loads((await jp_fetch("whybook", "questions", "sort", method="POST", body=json.dumps(body))).body)
    # The places that the server does not know are left out.
    assert calls == [("jevk5-4b", "Add age", "fit = ols('pain ~ site', d)", ["new", "edit"])]
    assert sorted_["place"]["choice"] == "edit"
    assert sorted_["cost_usd"] == 0.0


async def test_a_local_model_writes_more_questions_without_the_ones_already_there(fake_llama):
    selection = Selection.from_json({"source": AGE, "target": INCOME})
    context = Context.from_json({"asked": [{"id": "q1", "text": "Is age associated with income?", "type": "association"}]})
    answer = {
        "questions": [
            {"text": "Is age associated with income?", "type": "association", "why": "asked before", "priority": 0.9},
            {"text": "Could site confound age and income?", "type": "causal", "why": "site may drive both", "priority": 1.4},
        ]
    }
    local_models._llm(local_models.MODELS["gemma-4-e2b"], 4).answer = json.dumps(answer)
    events = [event async for event in claude_questions.generate_local("gemma-4-e2b", selection, context, [], 4)]
    assert [event["type"] for event in events] == ["progress", "result"]
    [question] = events[-1]["questions"]
    assert question["text"] == "Could site confound age and income?"
    assert question["origin"] == "local"
    assert question["id"].startswith("local:")
    # The priority is held between 0 and 1.
    assert question["probability"] == 1.0


async def test_the_route_writes_more_questions_with_a_local_model(jp_fetch, fake_llama):
    local_models._llm(local_models.MODELS["gemma-4-e2b"], 4).answer = json.dumps(
        {"questions": [{"text": "Does income vary with age by site?", "type": "association", "why": "a site effect", "priority": 0.5}]}
    )
    body = {"selection": {"source": AGE, "target": INCOME}, "context": {}, "model": "gemma-4-e2b"}
    response = await jp_fetch("whybook", "questions", "claude", method="POST", body=json.dumps(body))
    events = [json.loads(line) for line in response.body.decode().splitlines()]
    assert events[-1]["questions"][0]["text"] == "Does income vary with age by site?"
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "questions", "claude", method="POST", body=json.dumps({**body, "model": "qwen9"}))
    assert error.value.code == 400


def test_a_local_model_orders_questions_by_the_letter_it_would_pick(fake_llama):
    state = "Selected: {\"name\": \"age\"}\nCells so far: [1] Load\nAsked already: nothing\nMode: wonder"
    questions = ["Is age associated with income?", "Is there a typo in the title?", "Does age differ by site?"]
    probabilities = local_models.rank_questions(local_models.MODELS["gemma-4-e2b"], state, questions, 4)
    # The letters of the three options, 1 to -1 to 1: the question about a typo comes last.
    assert probabilities == [0.4683, 0.0634, 0.4683]
    llm = FakeChatLlama.made[0]
    # One reading for all the questions: the state, then the lettered options.
    assert len(llm.evaluated) == 2
    # Letters go to the first twelve questions; the others keep their place after them.
    many = [f"Question {number}?" for number in range(14)]
    assert local_models.rank_questions(local_models.MODELS["gemma-4-e2b"], state, many, 4)[12:] == [0.0, 0.0]
    assert local_models.rank_questions(local_models.MODELS["gemma-4-e2b"], state, [], 4) == []



def test_a_decision_model_reads_its_makers_prompt():
    decider = local_models.DECISION["decider-2b"]
    keys, texts = ["q0", "q1"], ["Summarise age", "Is age related to income?"]
    prompt = local_models.decision_prompt(None, decider, "Selected: age", local_models.NEXT_QUESTION, keys, texts)
    # decider: its plain layout, with no chat template, ending where the letter starts.
    assert prompt == (
        "Context:\nSelected: age\n\nQuestion: Which of these questions does the analyst ask next?\n"
        "Options:\n(A) Summarise age\n(B) Is age related to income?\nAnswer: ("
    )
    jevk5 = local_models.DECISION["jevk5-4b"]
    prompt = local_models.decision_prompt(None, jevk5, {"question": "Add age"}, "Sort it", ["model", "causal"], ["a model", "an effect"])
    # JevK5: the system prompt of its card, the evidence, the criterion and the options as JSON.
    assert prompt.startswith(f"<|im_start|>system\n{local_models.JEVK5_SYSTEM}<|im_end|>\n<|im_start|>user\n")
    assert prompt.endswith("<|im_start|>assistant\n<think>\n\n</think>\n\n")
    sent = json.loads(prompt.split("<|im_start|>user\n")[1].split("<|im_end|>")[0])
    assert sent == {
        "evidence": {"question": "Add age"},
        "criterion": "Sort it",
        "options": [{"letter": "A", "description": "model: a model"}, {"letter": "B", "description": "causal: an effect"}],
    }
    # Cygnet: the shim's layout, in the model's own chat template.
    cygnet = local_models.DECISION["gemma-4-12b-cygnet"]
    prompt = local_models.decision_prompt(FakeChatLlama("x"), cygnet, "Selected: age", local_models.NEXT_QUESTION, keys, texts)
    assert prompt.startswith(f"<system>{local_models.CYGNET_SYSTEM}\n<user>Selected: age\n\n")
    assert "Options:\nA. Summarise age\nB. Is age related to income?\n\nAnswer with the letter of exactly one option, and nothing else:" in prompt


def test_a_decision_model_orders_the_questions_and_types_every_question_with_its_cell(monkeypatch):
    calls = []

    def read(model, evidence, instruction, keys, texts, threads):
        calls.append((model.id, evidence, instruction, keys, texts))
        return [0.1, 0.7, 0.05, 0.1, 0.05][: len(texts)]

    monkeypatch.setattr(local_models, "decision_read", read)
    jevk5 = local_models.DECISION["jevk5-4b"]
    assert local_models.rank_questions(jevk5, "Selected: age", ["Summarise age", "Is age related to income?"], 4) == [0.1, 0.7]
    assert calls[-1] == ("jevk5-4b", "Selected: age", local_models.NEXT_QUESTION, ["q0", "q1"], ["Summarise age", "Is age related to income?"])
    found = local_models.classify(jevk5, "Add  age", 4, cell="fit = ols()")
    assert found["type"]["choice"] == "association"
    assert found["place"] is None
    model_id, evidence, instruction, keys, _ = calls[-1]
    assert evidence == {"question": "Add age", "cell": "fit = ols()"}
    assert instruction == sorting.TYPE_INSTRUCTION
    assert keys == list(sorting.TYPES)
    # With the places that the view offers, one more read gives the place, as research asked it.
    found = local_models.classify(jevk5, "Add age", 4, cell="fit = ols()", places=["new", "edit", "branch", "preview"])
    _, evidence, instruction, keys, texts = calls[-1]
    assert (instruction, keys, texts) == (sorting.PLACE_INSTRUCTION, list(sorting.PLACES), list(sorting.PLACES.values()))
    assert evidence == {"question": "Add age", "cell": "fit = ols()"}
    assert found["place"] == {"choice": "new", "probabilities": {"edit": 0.1, "new": 0.7, "branch": 0.05, "preview": 0.1}}
    # Only the places offered, and none when one place is all there is.
    local_models.classify(jevk5, "Show age", 4, cell="# notes", places=["preview", "new"])
    assert calls[-1][3] == ["new", "preview"]
    reads = len(calls)
    assert local_models.classify(jevk5, "Show age", 4, places=["new"])["place"] is None
    assert len(calls) == reads + 1


def test_the_decision_models_do_typed_questions_and_the_order_alone():
    found = {entry["id"]: entry for entry in local_models.status(local_models.all_models())}
    for model_id in ("jevk5-4b", "jevk5-2b", "decider-2b", "decider-4b", "gemma-4-12b-cygnet"):
        assert found[model_id]["tasks"] == ["typed", "ranking"]
        assert found[model_id]["decision"] is True
        assert found[model_id]["tier"] == "decision"
        assert local_models.DECISION[model_id].revision and local_models.DECISION[model_id].sha256
    assert found["gemma-4-e2b"]["tasks"] is None and found["gemma-4-e2b"]["decision"] is False
    # A model of the settings whose file names a decision model gets its maker's prompt.
    added = local_models.custom_model({"name": "JevK5", "repo": "someone/JevK5-GGUF", "file": "jevk5-4b-v0.3-Q8_0.gguf"})
    assert added.layout == "jevk5" and added.tasks == ("typed", "ranking")
    other = local_models.custom_model({"name": "Mine", "repo": "someone/Mine-GGUF", "file": "mine-Q4_K_M.gguf"})
    assert other.layout == "chat" and other.tasks is None


class FakeLetterLlama(FakeChatLlama):
    """One token per byte, each decoding to its character, with logits for three letters."""

    def n_vocab(self):
        return 256

    def detokenize(self, tokens, special=False):
        return bytes(tokens)


def test_cygnets_read_sums_the_probability_of_each_letter(fake_llama):
    import ctypes

    llm = FakeLetterLlama("x")
    logits = (ctypes.c_float * 256)()
    for letter, value in zip("ABC", (2.0, 1.0, 0.0)):
        logits[ord(letter)] = value
    llm._ctx.get_logits = lambda: logits
    weights = local_models._letter_mass(llm, local_models.DECISION["gemma-4-12b-cygnet"], "prompt", "ABC")
    assert [round(weight, 4) for weight in weights] == [0.6652, 0.2447, 0.09]
