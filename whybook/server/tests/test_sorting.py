"""Typed questions sorted by a model, and more questions from a local model.

Jev is answered by a fake fetch, and the local models by a fake llama_cpp:
nothing leaves the machine and no model loads.
"""

import importlib.machinery
import json
import sys
import types

import pytest
from tornado.httpclient import HTTPClientError

from whybook.server import local_models, sorting
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


def test_jev_gets_the_question_as_state_and_a_choice_per_decision():
    request = sorting.request_from_json({"text": "Add age", "cell": "fit = ols()", "places": ["new", "edit", "preview"]})
    body = sorting.jev_body(request, "jev-latest")
    assert body["model"] == "jev-latest"
    assert body["state"] == {"question": "Add age", "cell": "fit = ols()"}
    assert body["questions"]["type"]["type"] == "choice"
    assert list(body["questions"]["type"]["criteria"]) == ["descriptive", "association", "causal", "model", "quality"]
    # Only the places the view can use are offered.
    assert list(body["questions"]["place"]["criteria"]) == ["new", "edit", "preview"]
    # With one place or none there is nothing to choose.
    alone = sorting.jev_body(sorting.request_from_json({"text": "Add age", "places": ["new"]}), "jev-latest")
    assert "place" not in alone["questions"]


def test_jev_needs_a_key():
    assert sorting.jev_status(Whybook(typesafe_api_key="")) == {
        "available": False,
        "reason": "needs a TypeSafe API key on the server: TYPESAFE_API_KEY",
    }
    assert sorting.jev_status(Whybook(typesafe_api_key="key"))["available"] is True


async def test_jev_is_asked_through_the_typesafe_api():
    calls = []

    async def fetch(url, **options):
        calls.append((url, options))
        answers = {
            "type": {"type": "choice", "choice": "model", "confidence": 0.6, "probabilities": {"model": 0.7, "causal": 0.3}},
            "place": {"type": "choice", "choice": "edit", "confidence": 0.8, "probabilities": {"edit": 0.9, "new": 0.1}},
        }
        return types.SimpleNamespace(body=json.dumps({"model": "jev-1.13.0", "usage": {}, "answers": answers}))

    config = Whybook(typesafe_api_key="key", typesafe_base_url="https://jev.example/")
    request = sorting.request_from_json({"text": "Add age", "places": ["new", "edit"]})
    sorted_ = await sorting.ask_jev(request, config, fetch)
    url, options = calls[0]
    assert url == "https://jev.example/v1/systemone"
    assert options["headers"]["Authorization"] == "Bearer key"
    assert json.loads(options["body"])["model"] == "jev-latest"
    assert sorted_["type"] == {"choice": "model", "probabilities": {"model": 0.7, "causal": 0.3}}
    assert sorted_["place"]["choice"] == "edit"
    assert sorted_["model"] == "jev-1.13.0"


def test_an_answer_that_is_not_a_choice_is_refused():
    with pytest.raises(ValueError):
        sorting.jev_answers({"answers": {"type": {"type": "noul", "noul": 0.2}}})


async def test_the_route_refuses_jev_without_a_key_and_unknown_models(jp_fetch, monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "questions", "sort", method="POST", body=json.dumps({"text": "Add age", "model": "jev"}))
    assert error.value.code == 409
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "questions", "sort", method="POST", body=json.dumps({"text": "Add age", "model": "remote"}))
    assert error.value.code == 400
    status = json.loads((await jp_fetch("whybook", "status")).body)
    assert status["jev"]["available"] is False


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

