"""Local models with a fake llama_cpp and a fake Hugging Face cache: no model loads."""

import asyncio
import importlib.machinery
import json
import re
import struct
import sys
import threading
import time
import types

import pytest
from tornado.httpclient import AsyncHTTPClient, HTTPClientError, HTTPRequest

from whybook.server import local_models

GEMMA = local_models.MODELS["gemma-4-e2b"]
QWEN = local_models.MODELS["qwen3-4b"]
# Code writes no candidate headline for this table, so its label takes one call.
TABLE = {"id": "a1", "code": "fit.summary()", "table": "Coef. P>|z|\nage -0.003 0.779", "rows": 2, "columns": 2}
CORRELATION = {
    "id": "c1",
    "code": "weekly.corr()",
    "table": "            week  pain_score\nweek        1.00       -0.61\npain_score -0.61        1.00",
    "rows": 2,
    "columns": 2,
}


class StandardSampler:
    """The sampler of llama-cpp-python, which checks the whole vocabulary."""

    def sample(self, ctx, idx=-1):
        return 0


class FakeCheckFirst:
    """Stands in for local_models._CheckFirst, which needs a real llama.cpp."""

    fails = None

    def __init__(self, llm, grammar):
        self.counts = llm.whybook_fast_counts

    def sample(self, ctx, idx=-1):
        if FakeCheckFirst.fails:
            raise FakeCheckFirst.fails
        self.counts["checked"] += 1
        return 0


class FakeLlama:
    """Answers every request with ``answer`` and records what it was asked.

    Like llama-cpp-python 0.3.35, it builds a sampler with _init_sampler for
    each request and samples each token through it; ``samplers`` records the
    kind of each request's sampler. ``fast_answer``, when set, is the answer
    written through the fast check. A request whose grammar allows a list of
    headlines gets ``choice`` of them, and the answer stops before its first
    stop string, as llama-cpp-python cuts it.
    """

    made: list["FakeLlama"] = []
    answer = json.dumps({"description": "mixed model coefficient table", "headline": "arm B lowers pain by 0.86"})
    fast_answer = None
    choice = 0

    def __init__(self, model_path, **options):
        self.model_path = model_path
        self.options = options
        self.messages = []
        self.schemas = []
        self.stops = []
        self.samplers = []
        self.closed = False
        FakeLlama.made.append(self)

    def _init_sampler(self, temp=0.8, repeat_penalty=1.0, logits_processor=None, grammar=None):
        return StandardSampler()

    def create_chat_completion(self, messages, response_format, temperature, max_tokens, stop=None):
        self.messages.append(messages)
        self.schemas.append(response_format["schema"])
        self.stops.append(stop)
        sampler = self._init_sampler(temp=temperature, repeat_penalty=1.0, logits_processor=None, grammar="root ::= object")
        self.samplers.append(type(sampler).__name__)
        for _ in range(3):
            sampler.sample(None, -1)
        fast = isinstance(sampler, FakeCheckFirst) and FakeLlama.fast_answer is not None
        answer = FakeLlama.fast_answer if fast else FakeLlama.answer
        headlines = response_format["schema"]["properties"].get("headline", {}).get("enum")
        if headlines is not None:
            answer = json.dumps({"headline": headlines[FakeLlama.choice]})
        for text in stop or []:
            answer = answer.split(text)[0]
        return {"choices": [{"message": {"content": answer}}]}

    def close(self):
        self.closed = True


@pytest.fixture
def jp_server_config(jp_server_config):
    config = dict(jp_server_config)
    config["Whybook"] = {"describe_tables": False}
    return config


@pytest.fixture
def fake(tmp_path, monkeypatch):
    """An empty Hugging Face cache and a llama_cpp whose Llama is FakeLlama."""
    module = types.ModuleType("llama_cpp")
    module.__spec__ = importlib.machinery.ModuleSpec("llama_cpp", None)
    module.Llama = FakeLlama
    for name in local_models._FAST_NEEDS:
        setattr(module, name, object())
    monkeypatch.setitem(sys.modules, "llama_cpp", module)
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg"))
    monkeypatch.setattr(local_models, "_loaded", None)
    monkeypatch.setattr(local_models, "_fast_failure", None)
    monkeypatch.setattr(local_models, "_CheckFirst", FakeCheckFirst)
    monkeypatch.setattr(local_models, "_llama_cpp_version", lambda: "0.9.0")
    monkeypatch.setattr(local_models, "CUSTOM", {})
    monkeypatch.setattr(local_models, "DOWNLOADS", {})
    monkeypatch.setattr(FakeLlama, "made", [])
    monkeypatch.setattr(FakeLlama, "fast_answer", None)
    monkeypatch.setattr(FakeLlama, "choice", 0)
    monkeypatch.setattr(FakeCheckFirst, "fails", None)
    return tmp_path


def download(hub, model, content=b"GGUF"):
    """The model's file in the fake cache, at its commit, as huggingface_hub lays it out."""
    snapshot = hub / ("models--" + model.repo.replace("/", "--")) / "snapshots" / (model.revision or "abc123")
    snapshot.mkdir(parents=True, exist_ok=True)
    (snapshot / model.file).write_bytes(content)
    return snapshot / model.file


@pytest.fixture
def fake_hub(fake, monkeypatch):
    """A huggingface_hub whose download puts the file in the fake cache; returns its calls."""
    module = types.ModuleType("huggingface_hub")
    module.__spec__ = importlib.machinery.ModuleSpec("huggingface_hub", None)
    calls = []
    module.hf_hub_url = lambda repo, file, revision="main": f"https://huggingface.co/{repo}/resolve/{revision}/{file}"
    module.get_hf_file_metadata = lambda url: types.SimpleNamespace(size=4)

    def hf_hub_download(repo, file, cache_dir, revision=None):
        calls.append((repo, file, cache_dir, revision))
        model = next(model for model in local_models.all_models() if model.repo == repo)
        return str(download(fake, model))

    module.hf_hub_download = hf_hub_download
    monkeypatch.setitem(sys.modules, "huggingface_hub", module)
    return calls


def test_a_model_not_in_the_cache_gives_the_command_that_fetches_it(fake):
    path = download(fake, GEMMA)
    status = {entry["id"]: entry for entry in local_models.status()}
    assert status["gemma-4-e2b"]["available"] is True
    assert status["gemma-4-e2b"]["reason"] is None
    assert local_models.model_path(GEMMA) == path
    assert status["qwen3-4b"]["available"] is False
    # The command fetches the file at the commit that the view pins.
    assert status["qwen3-4b"]["reason"] == (
        "not downloaded: hf download Qwen/Qwen3-4B-GGUF Qwen3-4B-Q4_K_M.gguf --revision bc640142c66e1fdd12af0bd68f40445458f3869b"
    )


def test_without_the_runtime_no_model_is_available(fake, monkeypatch):
    download(fake, GEMMA)
    monkeypatch.setattr(local_models, "runtime_available", lambda: False)
    assert {entry["reason"] for entry in local_models.status()} == {"llama-cpp-python is not installed: pip install -e '.[local]'"}


@pytest.mark.parametrize(
    "description, fits",
    [("orders by region", True), ("hourly sensor readings", True), ("a table of the orders by region", False), ("Orders", False)],
)
def test_the_grammar_holds_a_description_to_three_lower_case_words(description, fits):
    assert bool(re.match(local_models.DESCRIPTION, description)) is fits


def test_the_grammar_holds_a_headline_to_four_words():
    assert re.match(local_models.HEADLINE, "sales peak in May")
    assert re.match(local_models.HEADLINE, "")
    assert not re.match(local_models.HEADLINE, "sales peak in early May")


async def test_a_local_model_labels_each_table_and_loads_once(fake):
    download(fake, GEMMA)
    tables = [TABLE, {**TABLE, "id": "b2"}]
    events = [event async for event in local_models.ask_local("gemma-4-e2b", tables, threads=2)]
    assert [event["type"] for event in events] == ["progress", "progress", "result"]
    assert events[1]["stage"] == "labelling table 2 of 2"
    # The description is cut to three words, as the grammar would; with no candidate, no headline.
    assert events[-1]["tables"] == [
        {"id": "a1", "description": "mixed model coefficient", "headline": ""},
        {"id": "b2", "description": "mixed model coefficient", "headline": ""},
    ]
    assert events[-1]["model"] == "Gemma 4 E2B"
    # The view keeps the exact file with the labels.
    assert events[-1]["file"] == "ggml-org/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-Q4_0.gguf"
    assert events[-1]["cost_usd"] == 0.0
    assert len(FakeLlama.made) == 1
    assert FakeLlama.made[0].options["n_threads"] == 2
    # Code writes no candidate for this table: one call, which stops after the description.
    assert FakeLlama.made[0].stops == [['"headline"'], ['"headline"']]
    assert FakeLlama.made[0].messages[0][0]["content"] == local_models.LABEL_PROMPT


async def test_an_answer_that_is_not_json_is_an_error(fake, monkeypatch):
    download(fake, QWEN)
    monkeypatch.setattr(FakeLlama, "answer", '{"description": "cut off')
    events = [event async for event in local_models.ask_local("qwen3-4b", [TABLE], threads=2)]
    assert events[-1]["type"] == "error"
    assert events[-1]["message"].startswith("Qwen3 4B did not answer with JSON")


async def test_a_model_that_is_not_downloaded_is_an_error(fake):
    events = [event async for event in local_models.ask_local("gemma-4-e2b", [TABLE], threads=2)]
    assert events[-1] == {
        "type": "error",
        "message": "Gemma 4 E2B is not downloaded: hf download ggml-org/gemma-4-E2B-it-GGUF gemma-4-E2B-it-Q4_0.gguf"
        " --revision b4243c156154b6dca9324415f8c7ccc098b4aed1",
        "elapsed": events[-1]["elapsed"],
    }


async def label_once(check="fast"):
    events = [event async for event in local_models.ask_local("gemma-4-e2b", [TABLE], threads=2, check=check)]
    return events[-1]


async def test_the_fast_check_samples_each_token_of_a_label(fake):
    download(fake, GEMMA)
    result = await label_once()
    assert result["tables"][0]["description"] == "mixed model coefficient"
    assert FakeLlama.made[0].samplers == ["FakeCheckFirst"]
    assert "warning" not in result
    assert local_models.fast_check_warning() is None


async def test_the_standard_check_keeps_the_sampler_of_llama_cpp(fake):
    download(fake, GEMMA)
    result = await label_once("standard")
    assert FakeLlama.made[0].samplers == ["StandardSampler"]
    assert "warning" not in result


async def test_a_fast_check_that_raises_gives_way_to_the_standard_one(fake):
    download(fake, GEMMA)
    FakeCheckFirst.fails = AttributeError("'LlamaContext' object has no attribute 'ctx'")
    result = await label_once()
    # The answer comes from the standard check, in a model loaded again.
    assert result["tables"][0]["description"] == "mixed model coefficient"
    first, second = FakeLlama.made
    assert first.closed and first.samplers == ["FakeCheckFirst"]
    assert second.samplers == ["StandardSampler"]
    assert result["warning"] == (
        "The fast JSON check failed: AttributeError: 'LlamaContext' object has no attribute 'ctx',"
        " with llama-cpp-python 0.9.0 (measured with 0.3.35). Local models use the standard check,"
        " which gives the same answers more slowly."
    )
    # The next request does not try the fast check again.
    FakeCheckFirst.fails = None
    again = await label_once()
    assert second.samplers == ["StandardSampler", "StandardSampler"]
    assert again["warning"] == result["warning"]
    # With the standard check chosen, there is nothing to warn about.
    assert "warning" not in await label_once("standard")


async def test_an_answer_of_the_fast_check_that_is_not_json_gives_way_to_the_standard_one(fake, monkeypatch):
    download(fake, GEMMA)
    monkeypatch.setattr(FakeLlama, "fast_answer", '{"description": "mixed')
    result = await label_once()
    assert result["tables"][0]["description"] == "mixed model coefficient"
    assert FakeLlama.made[0].samplers == ["FakeCheckFirst", "StandardSampler"]
    assert "its answer was not JSON, with llama-cpp-python 0.9.0" in result["warning"]


async def test_a_model_that_fails_with_both_checks_leaves_the_fast_check_on(fake, monkeypatch):
    download(fake, GEMMA)
    monkeypatch.setattr(FakeLlama, "answer", '{"description": "cut off')
    monkeypatch.setattr(FakeLlama, "fast_answer", '{"description": "cut off')
    result = await label_once()
    assert result["type"] == "error"
    assert result["message"].startswith("Gemma 4 E2B did not answer with JSON")
    assert local_models.fast_check_warning() is None


async def test_llama_cpp_that_does_not_call_the_fast_check_brings_a_warning(fake, monkeypatch):
    download(fake, GEMMA)

    def positional(self, *args, **kwargs):
        # A later version might build its sampler with other arguments.
        return StandardSampler()

    monkeypatch.setattr(FakeLlama, "_init_sampler", positional)

    def create(self, messages, response_format, temperature, max_tokens, stop=None):
        self.messages.append(messages)
        sampler = self._init_sampler(40, 0.95, temperature)
        self.samplers.append(type(sampler).__name__)
        return {"choices": [{"message": {"content": FakeLlama.answer.split((stop or ["\0"])[0])[0]}}]}

    monkeypatch.setattr(FakeLlama, "create_chat_completion", create)
    result = await label_once()
    # The answer of the standard sampler stands, and is not asked again.
    assert result["tables"][0]["description"] == "mixed model coefficient"
    assert FakeLlama.made[0].samplers == ["StandardSampler"]
    assert "llama-cpp-python did not call it" in result["warning"]


async def test_llama_cpp_without_the_parts_the_fast_check_needs_uses_the_standard_one(fake):
    download(fake, GEMMA)
    del sys.modules["llama_cpp"].llama_get_logits_ith
    result = await label_once()
    assert FakeLlama.made[0].samplers == ["StandardSampler"]
    assert result["warning"].startswith("The fast JSON check failed: llama_cpp has no llama_get_logits_ith, with")


async def post_tables(jp_fetch, model, **extra):
    body = {"model": model, "tables": [{"id": "a1", "code": "fit.summary()", "text": "Coef.\nage -0.003"}], **extra}
    response = await jp_fetch("whybook", "tables", "describe", method="POST", body=json.dumps(body))
    return [json.loads(line) for line in response.body.decode().splitlines()]


async def test_the_routes_take_the_json_check_of_the_settings(jp_fetch, fake):
    download(fake, GEMMA)
    await post_tables(jp_fetch, "gemma-4-e2b", json_check="standard")
    await post_tables(jp_fetch, "gemma-4-e2b")
    assert FakeLlama.made[0].samplers == ["StandardSampler", "FakeCheckFirst"]
    with pytest.raises(HTTPClientError) as error:
        await post_tables(jp_fetch, "gemma-4-e2b", json_check="quick")
    assert error.value.code == 400
    frames = {"model": "gemma-4-e2b", "json_check": "standard", "frames": [{"id": "f1", "name": "df", "rows": 3, "n_columns": 1, "columns": [{"name": "age", "type": "int64"}]}]}
    response = await jp_fetch("whybook", "frames", "describe", method="POST", body=json.dumps(frames))
    assert json.loads(response.body.decode().splitlines()[-1])["type"] == "result"
    assert FakeLlama.made[0].samplers[-1] == "StandardSampler"


async def test_the_status_reports_a_failed_fast_check(jp_fetch, fake):
    download(fake, GEMMA)
    status = json.loads((await jp_fetch("whybook", "status")).body)
    assert status["json_check_warning"] is None
    FakeCheckFirst.fails = TypeError("sample() takes 2 positional arguments")
    await label_once()
    status = json.loads((await jp_fetch("whybook", "status")).body)
    assert status["json_check_warning"].startswith("The fast JSON check failed: TypeError: sample()")


async def test_the_server_reports_its_local_models(jp_fetch, fake):
    download(fake, GEMMA)
    status = json.loads((await jp_fetch("whybook", "status")).body)
    assert [(entry["id"], entry["tier"], entry["available"]) for entry in status["local_models"]] == [
        ("ministral-3-3b", "recommended", False),
        ("gemma-4-e2b", "recommended", True),
        ("qwen3-4b", "recommended", False),
        ("minicpm5-2b", "smaller", False),
        ("gemma-4-e4b", "larger", False),
    ]
    assert status["remote_model"] is None


async def test_a_local_model_runs_when_the_remote_one_is_turned_off(jp_fetch, fake):
    # The test server sets c.Whybook.describe_tables = False.
    download(fake, GEMMA)
    events = await post_tables(jp_fetch, "gemma-4-e2b")
    assert events[-1]["type"] == "result"
    assert events[-1]["tables"][0]["id"] == "a1"
    with pytest.raises(HTTPClientError) as error:
        await post_tables(jp_fetch, "remote")
    assert error.value.code == 403
    with pytest.raises(HTTPClientError) as error:
        await post_tables(jp_fetch, "gpt-7")
    assert error.value.code == 400


async def test_download_fetches_the_pinned_file_at_its_commit_and_checks_it(fake, fake_hub, monkeypatch):
    assert {entry["downloadable"] for entry in local_models.status()} == {True}
    # The fake file is b"GGUF": its SHA-256 stands in for the pinned one.
    monkeypatch.setattr(local_models, "_sha256", lambda path: QWEN.sha256)
    events = [event async for event in local_models.download("qwen3-4b")]
    assert [event["stage"] for event in events if event["type"] == "progress"][-1] == "checking Qwen3 4B"
    assert events[-1]["type"] == "result"
    assert fake_hub == [("Qwen/Qwen3-4B-GGUF", "Qwen3-4B-Q4_K_M.gguf", str(fake), "bc640142c66e1fdd12af0bd68f40445458f3869b")]
    status = {entry["id"]: entry for entry in local_models.status()}
    assert status["qwen3-4b"]["available"] is True
    assert status["qwen3-4b"]["downloadable"] is False
    # A second press finds the file and fetches nothing.
    again = [event async for event in local_models.download("qwen3-4b")]
    assert [event["type"] for event in again] == ["result"]
    assert len(fake_hub) == 1


async def test_a_downloaded_file_whose_sha256_differs_is_deleted(fake, fake_hub):
    events = [event async for event in local_models.download("qwen3-4b")]
    assert events[-1]["type"] == "error"
    assert events[-1]["message"].startswith("the download of Qwen3 4B failed: the file has the SHA-256 ")
    assert events[-1]["message"].endswith(f"not {QWEN.sha256}, and was deleted")
    assert local_models.model_path(QWEN) is None


async def test_without_huggingface_hub_no_download_is_offered(fake, monkeypatch):
    monkeypatch.setattr(local_models, "hub_available", lambda: False)
    assert {entry["downloadable"] for entry in local_models.status()} == {False}
    events = [event async for event in local_models.download("gemma-4-e2b")]
    assert events == [{"type": "error", "message": "huggingface_hub is not installed: pip install -e '.[local]'"}]


async def test_the_download_route_takes_only_known_models(jp_fetch, fake, fake_hub, monkeypatch):
    monkeypatch.setattr(local_models, "_sha256", lambda path: GEMMA.sha256)
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "models", "download", method="POST", body=json.dumps({"model": "../../etc/passwd"}))
    assert error.value.code == 400
    response = await jp_fetch("whybook", "models", "download", method="POST", body=json.dumps({"model": "gemma-4-e2b"}))
    events = [json.loads(line) for line in response.body.decode().splitlines()]
    assert events[-1]["type"] == "result"
    assert fake_hub[0][:2] == ("ggml-org/gemma-4-E2B-it-GGUF", "gemma-4-E2B-it-Q4_0.gguf")


@pytest.fixture
def slow_hub(fake, monkeypatch):
    """A huggingface_hub whose download waits for ``release``, then writes a file that is not the pinned one."""
    release = threading.Event()
    module = types.ModuleType("huggingface_hub")
    module.__spec__ = importlib.machinery.ModuleSpec("huggingface_hub", None)
    module.hf_hub_url = lambda repo, file, revision="main": f"https://huggingface.co/{repo}/resolve/{revision}/{file}"
    module.get_hf_file_metadata = lambda url: types.SimpleNamespace(size=20)

    def hf_hub_download(repo, file, cache_dir, revision=None):
        release.calls.append(file)
        release.wait(10)
        return str(download(fake, QWEN, content=b"GGUF not the pinned file"))

    release.calls = []
    module.hf_hub_download = hf_hub_download
    monkeypatch.setitem(sys.modules, "huggingface_hub", module)
    yield release
    release.set()


async def settled():
    """Wait until the download job of Qwen3 4B has ended."""
    for _ in range(200):
        job = local_models.DOWNLOADS.get(QWEN.id)
        if job is None or job.done():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("the download job did not end")


async def test_a_page_that_goes_away_during_a_download_leaves_the_check_to_run(fake, slow_hub):
    events = local_models.download("qwen3-4b")
    assert (await events.__anext__())["type"] == "progress"
    # What BaseHandler.stream does when the analyst reloads the page.
    await events.aclose()
    # While the job runs, the model is neither available nor offered again.
    status = {entry["id"]: entry for entry in local_models.status()}["qwen3-4b"]
    assert (status["available"], status["downloadable"], status["reason"]) == (False, False, "downloading")
    slow_hub.set()
    await settled()
    # The file whose SHA-256 is not the pinned one is deleted, as when the page stays.
    assert local_models.model_path(QWEN) is None
    status = {entry["id"]: entry for entry in local_models.status()}["qwen3-4b"]
    assert status["available"] is False and status["reason"].startswith("the last download failed: the file has the SHA-256 ")
    # The next press of Download starts again, and reads what the job says.
    again = local_models.download("qwen3-4b")
    assert (await again.__anext__())["type"] == "progress"
    await again.aclose()


async def test_a_second_view_follows_the_download_that_runs(fake, slow_hub, monkeypatch):
    monkeypatch.setattr(local_models, "_sha256", lambda path: QWEN.sha256)
    first = local_models.download("qwen3-4b")
    assert (await first.__anext__())["type"] == "progress"
    await first.aclose()
    second = local_models.download("qwen3-4b")
    assert (await second.__anext__())["type"] == "progress"
    slow_hub.set()
    events = [event async for event in second]
    assert events[-1] == {"type": "result", "model": "qwen3-4b", "elapsed": events[-1]["elapsed"]}
    # One download for both views.
    assert slow_hub.calls == [QWEN.file]
    assert local_models.model_path(QWEN) is not None
    assert {entry["id"]: entry for entry in local_models.status()}["qwen3-4b"]["available"] is True


async def test_the_route_checks_the_file_when_the_page_reloads(jp_fetch, jp_http_port, jp_base_url, jp_auth_header, fake, slow_hub):
    first_line = asyncio.get_running_loop().create_future()

    def on_chunk(chunk):
        if not first_line.done():
            first_line.set_result(chunk)
        # The page goes away: tornado closes the connection when a streaming callback raises.
        raise ConnectionAbortedError("the page went away")

    url = f"http://localhost:{jp_http_port}{jp_base_url}whybook/models/download"
    request = HTTPRequest(url, method="POST", body=json.dumps({"model": "qwen3-4b"}), headers=jp_auth_header, streaming_callback=on_chunk, request_timeout=30)
    client = AsyncHTTPClient(force_instance=True)
    fetch = asyncio.ensure_future(client.fetch(request, raise_error=False))
    assert json.loads((await asyncio.wait_for(first_line, 10)).decode().splitlines()[0])["type"] == "progress"
    try:
        await asyncio.wait_for(fetch, 5)
    except Exception:  # noqa: BLE001  the request that the page left
        pass
    client.close()
    # The server writes its next progress line and finds the connection closed.
    await asyncio.sleep(1.5)
    slow_hub.set()
    await settled()
    assert local_models.model_path(QWEN) is None


# "Description, then choose": the method of research/local-models.md.


async def test_a_label_takes_a_description_then_one_of_the_headlines_that_code_wrote(fake):
    download(fake, GEMMA)
    events = [event async for event in local_models.ask_local("gemma-4-e2b", [CORRELATION], threads=2)]
    assert events[-1]["tables"] == [{"id": "c1", "description": "mixed model coefficient", "headline": "week and pain_score: -0.61"}]
    llm = FakeLlama.made[0]
    first, second = llm.messages
    # The first call stops after the description; the second, in the same conversation, may only pick a candidate.
    assert llm.stops == [['"headline"'], None]
    assert second[: len(first)] == first
    assert second[len(first)] == {"role": "assistant", "content": json.dumps({"description": "mixed model coefficient table"})}
    assert '"week and pain_score: -0.61"' in second[-1]["content"]
    assert llm.schemas[1]["properties"]["headline"]["enum"] == ["week and pain_score: -0.61", ""]


async def test_a_model_that_picks_no_candidate_leaves_the_headline_empty(fake, monkeypatch):
    download(fake, GEMMA)
    # The second entry of the grammar's list is the empty headline.
    monkeypatch.setattr(FakeLlama, "choice", 1)
    events = [event async for event in local_models.ask_local("gemma-4-e2b", [CORRELATION], threads=2)]
    assert events[-1]["tables"][0]["headline"] == ""


async def test_a_table_that_the_facts_code_cannot_read_keeps_its_description(fake, monkeypatch):
    download(fake, GEMMA)

    def fail(case):
        raise IndexError("a layout that parse() does not know")

    monkeypatch.setattr(local_models.table_facts, "table_facts", fail)
    events = [event async for event in local_models.ask_local("gemma-4-e2b", [CORRELATION], threads=2)]
    assert events[-1]["tables"] == [{"id": "c1", "description": "mixed model coefficient", "headline": ""}]
    assert len(FakeLlama.made[0].messages) == 1


LONG_NAMES = {
    "id": "c2",
    "code": "trial[['pain_score_baseline', 'pain_score_week_12']].corr()",
    "table": "                     pain_score_baseline  pain_score_week_12\n"
    "pain_score_baseline                 1.00               -0.45\n"
    "pain_score_week_12                 -0.45                1.00",
    "rows": 2,
    "columns": 2,
}


async def test_a_headline_that_a_local_model_picks_shows_whole(fake):
    download(fake, GEMMA)
    events = [event async for event in local_models.ask_local("gemma-4-e2b", [LONG_NAMES], threads=2)]
    # Cut to 48 characters, it read "-0.4" for r = -0.45.
    assert events[-1]["tables"][0]["headline"] == "pain_score_baseline and pain_score_week_12: -0.45"


def facts(text, code, rows, columns):
    return local_models.table_facts.table_facts({"text": text, "code": code, "rows": rows, "columns": columns})


def test_a_comparison_counts_the_rows_where_both_values_are_present():
    text = "      before  after\nsite               \nA        5.0    4.0\nB        6.0    5.5\nC        NaN    3.0\nD        7.0    6.0"
    info = facts(text, "pain.groupby('site')[['before', 'after']].mean()", 4, 2)
    assert [line for line in info.lines if "is lower than" in line] == ["after is lower than before in 3 of 3 rows: A, B and D"]
    # Site C has no "before": 3 of 3, not 3/4.
    assert [text for text in local_models.table_facts.candidates(info) if "/" in text] == ["after lower 3/3", "before higher 3/3"]


def test_a_describe_table_gets_no_headline():
    import numpy as np
    import pandas as pd

    rng = np.random.default_rng(0)
    visits = pd.DataFrame({"pain": rng.normal(5, 1.5, 200).round(1), "sleep": rng.normal(7, 1, 200).round(1)})
    # Each row is another statistic: "count most pain" would compare a count with a mean.
    for text, code in [
        (visits.describe().to_string(), "visits[['pain', 'sleep']].describe()"),
        (visits.describe().T.to_string(), "summary"),
        (visits.groupby(visits["pain"] > 5)["sleep"].describe().to_string(), "visits.groupby(visits['pain'] > 5)['sleep'].describe()"),
    ]:
        assert local_models.table_facts.candidates(facts(text, code, 8, 2)) == []


def test_the_candidates_are_those_of_the_benchmark():
    info = local_models.table_facts.table_facts({"text": CORRELATION["table"], "code": CORRELATION["code"], "rows": 2, "columns": 2})
    assert info.kind == "correlation"
    assert local_models.table_facts.candidates(info) == ["week and pain_score: -0.61"]
    raw = local_models.table_facts.table_facts({"text": "   a  b\n0  1  2\n1  3  4", "code": "df.head()", "rows": 2, "columns": 2})
    assert raw.kind == "raw" and local_models.table_facts.candidates(raw) == []


# The models that the settings add: customLocalModels.


def gguf(path, scores, element=5):
    """A GGUF header with a name and token scores of one type: 5 is a 32-bit integer, 6 a float."""
    def string(text):
        data = text.encode()
        return struct.pack("<Q", len(data)) + data

    body = string("general.name") + struct.pack("<I", 8) + string("tiny")
    kind = "i" if element == 5 else "f"
    body += string("tokenizer.ggml.scores") + struct.pack("<IIQ", 9, element, len(scores)) + struct.pack(f"<{len(scores)}{kind}", *scores)
    path.write_bytes(b"GGUF" + struct.pack("<IQQ", 3, 0, 2) + body + b"\0" * 32)
    return path


def test_a_model_of_the_settings_takes_an_id_from_its_name(fake, tmp_path, monkeypatch):
    monkeypatch.setattr(local_models, "hub_available", lambda: True)
    local = gguf(tmp_path / "tiny.gguf", [1.0, 2.0], element=6)
    problems = local_models.register_custom(
        [
            {"name": "My Llama 3.2 (3B)", "repo": "ggml-org/Llama-3.2-3B-GGUF", "file": "llama-3.2-3b-q4_k_m.gguf", "revision": "main"},
            {"name": "My Llama 3.2 (3B)", "path": str(local), "note": "the one on the lab machine"},
            {"name": "", "repo": "a/b", "file": "c.gguf"},
            {"name": "No file", "repo": "a/b"},
            {"name": "Relative", "path": "models/x.gguf"},
            {"name": "Escape", "repo": "a/b", "file": "../../x.gguf"},
        ]
    )
    assert problems == [
        "a custom local model needs a name of at most 60 characters",
        "No file: give a Hugging Face repository and a .gguf file in it, or the path of a GGUF file",
        "Relative: the path is the absolute path of a .gguf file",
        "Escape: give a Hugging Face repository and a .gguf file in it, or the path of a GGUF file",
    ]
    status = {entry["id"]: entry for entry in local_models.status()}
    remote, here = status["custom:my-llama-3.2-3b"], status["custom:my-llama-3.2-3b-2"]
    assert (remote["tier"], remote["available"], remote["downloadable"], remote["size_mb"]) == ("custom", False, True, None)
    assert remote["reason"] == "not downloaded: hf download ggml-org/Llama-3.2-3B-GGUF llama-3.2-3b-q4_k_m.gguf --revision main"
    assert (here["available"], here["downloadable"], here["note"]) == (True, False, "the one on the lab machine")
    # The ids follow src/model/custommodels.ts, which computes them for the settings.
    assert local_models.custom_id("  Qwen3   8B, mine!  ") == "custom:qwen3-8b-mine"
    assert local_models.custom_id("???") == "custom:model"


async def test_a_request_for_a_model_of_the_settings_brings_its_spec(jp_fetch, fake, tmp_path):
    local = gguf(tmp_path / "tiny.gguf", [1.0, 2.0], element=6)
    spec = {"name": "Tiny", "path": str(local)}
    # The status request of the view registers the models of its settings.
    response = await jp_fetch("whybook", "status", method="POST", body=json.dumps({"custom_local_models": [spec, {"name": 3}]}))
    status = json.loads(response.body)
    assert status["local_models"][-1]["id"] == "custom:tiny"
    assert status["custom_model_problems"] == ["a custom local model needs a name of at most 60 characters"]
    # After a restart the server knows none of them, and the request's spec is enough.
    local_models.CUSTOM.clear()
    events = await post_tables(jp_fetch, "custom:tiny", model_spec=spec)
    assert events[-1]["type"] == "result"
    assert events[-1]["model"] == "Tiny"
    assert events[-1]["file"] == str(local)
    assert FakeLlama.made[-1].model_path == str(local)
    with pytest.raises(HTTPClientError) as error:
        await post_tables(jp_fetch, "custom:tiny", model_spec={"name": "Tiny", "path": "tiny.gguf"})
    assert error.value.code == 400


async def test_a_model_of_the_settings_on_this_machine_is_not_downloaded(fake, tmp_path):
    local_models.register_custom([{"name": "Tiny", "path": str(tmp_path / "missing.gguf")}])
    [entry] = [entry for entry in local_models.status() if entry["tier"] == "custom"]
    assert entry["reason"] == f"no file at {tmp_path / 'missing.gguf'}"
    events = [event async for event in local_models.download("custom:tiny")]
    assert events == [{"type": "error", "message": "Tiny is a file on this machine, and the server downloads only from Hugging Face"}]


# Files that store their token scores as integers, as Mistral AI's Ministral 3 files do.


def test_a_file_with_integer_token_scores_is_read_from_a_copy_with_float_scores(fake, tmp_path):
    source = gguf(tmp_path / "ministral.gguf", [0, -3, 12, 2**20])
    copy = local_models.readable_path(source)
    assert copy != source and copy.parent == local_models.copies_dir()
    assert copy.stat().st_size == source.stat().st_size
    with open(copy, "rb") as handle:
        data = handle.read()
    offset, element, count = local_models._scores_at(data)
    assert (element, count) == (6, 4)
    assert struct.unpack_from("<4f", data, offset + 12) == (0.0, -3.0, 12.0, 2.0**20)
    # The copy is written once.
    stamp = copy.stat().st_mtime_ns
    assert local_models.readable_path(source) == copy and copy.stat().st_mtime_ns == stamp
    # A file with float scores, or with none, is read as it is.
    floats = gguf(tmp_path / "gemma.gguf", [1.5, 2.5], element=6)
    assert local_models.readable_path(floats) == floats
    assert local_models.readable_path(download(fake, GEMMA)) == local_models.model_path(GEMMA)


async def test_ministral_loads_from_the_copy(fake):
    ministral = local_models.MODELS["ministral-3-3b"]
    download(fake, ministral)
    path = local_models.model_path(ministral)
    gguf(path, [1, 2, 3])
    events = [event async for event in local_models.ask_local("ministral-3-3b", [TABLE], threads=2)]
    assert events[-1]["type"] == "result"
    assert FakeLlama.made[0].model_path.endswith(".scores-f32.gguf")


# Chat templates that think unless told otherwise.


def test_qwen3_renders_its_template_with_thinking_off_and_gemma_as_it_is(fake, monkeypatch):
    rendered = []

    class Formatter:
        def __init__(self, template, eos_token, bos_token, stop_token_ids):
            self.template = template

        def __call__(self, **kwargs):
            rendered.append(kwargs)

        def to_chat_handler(self):
            return self

    chat_format = types.ModuleType("llama_cpp.llama_chat_format")
    chat_format.Jinja2ChatFormatter = Formatter
    monkeypatch.setitem(sys.modules, "llama_cpp.llama_chat_format", chat_format)
    monkeypatch.setattr(FakeLlama, "chat_format", "chat_template.default", raising=False)
    monkeypatch.setattr(FakeLlama, "metadata", {"tokenizer.chat_template": "{{ messages }}"}, raising=False)
    monkeypatch.setattr(FakeLlama, "token_eos", lambda self: 1, raising=False)
    monkeypatch.setattr(FakeLlama, "token_bos", lambda self: -1, raising=False)
    monkeypatch.setattr(FakeLlama, "_model", types.SimpleNamespace(token_get_text=lambda token: "</s>"), raising=False)
    for model in (QWEN, GEMMA):
        download(fake, model)
    qwen = local_models._llm(QWEN, 2)
    qwen.chat_handler(messages=[])
    assert rendered == [{"enable_thinking": False, "messages": []}]
    gemma = local_models._llm(GEMMA, 2)
    assert not hasattr(gemma, "chat_handler")


# One model loads at a time: a request keeps it for all of its items.


async def test_two_requests_on_two_local_models_load_each_model_once(fake, monkeypatch):
    download(fake, GEMMA)
    download(fake, QWEN)
    real = local_models._generate

    def slow(*args, **kwargs):
        # A label takes seconds on a laptop: long enough for the other request to ask in between.
        time.sleep(0.02)
        return real(*args, **kwargs)

    monkeypatch.setattr(local_models, "_generate", slow)

    async def labels():
        return [event async for event in local_models.ask_local("gemma-4-e2b", [{**TABLE, "id": f"t{index}"} for index in range(3)], threads=2)]

    async def titles():
        cells = [{"id": f"c{index}", "code": "weekly = diary.groupby('week').mean()", "title": ""} for index in range(3)]
        return [event async for event in local_models.ask_local_titles("qwen3-4b", cells, threads=2)]

    labelled, titled = await asyncio.gather(labels(), titles())
    assert [event["type"] for event in labelled] == ["progress"] * 3 + ["result"]
    assert [event["type"] for event in titled] == ["progress"] * 3 + ["result"]
    # Until 29 September 2026 each item took the lock on its own, and the two models took turns: 6 loads of 2 to 3 GB.
    assert sorted(llm.model_path.rsplit("/", 1)[-1] for llm in FakeLlama.made) == sorted([GEMMA.file, QWEN.file])


async def test_a_request_that_the_view_leaves_stops_after_its_item(fake, monkeypatch):
    download(fake, GEMMA)
    real = local_models._generate
    monkeypatch.setattr(local_models, "_generate", lambda *args, **kwargs: (time.sleep(0.05), real(*args, **kwargs))[1])
    events = local_models.ask_local("gemma-4-e2b", [{**TABLE, "id": f"t{index}"} for index in range(5)], threads=2)
    assert (await events.__anext__())["stage"] == "labelling table 1 of 5"
    # What BaseHandler.stream does when the page goes away.
    await events.aclose()
    for _ in range(100):
        if local_models._lock.acquire(blocking=False):
            local_models._lock.release()
            break
        await asyncio.sleep(0.02)
    # One table at most, of two calls: the lock is free for the next request.
    assert sum(len(llm.messages) for llm in FakeLlama.made) <= 2


def test_a_copy_that_fails_leaves_no_partial_file(fake, tmp_path):
    # A score too large for a float: the copy of the file, as large as the model, goes.
    source = gguf(tmp_path / "big.gguf", [1, 2**25])
    with pytest.raises(local_models.LocalModelError):
        local_models.readable_path(source)
    assert sorted(path.name for path in local_models.copies_dir().glob("*")) == []
