"""The way to use models that the server sets for every user (c.Whybook.way_to_use_models).

Whybook's screen "Three ways to use models" asks each user where models run,
unless the server's configuration decides. The status tells the view what the
server decides, and whether the local models can run at all. With
"all-local", the server refuses every model outside this machine and its
network. No model is called, and no host name is looked up: the tests answer
for the resolver.
"""

import json

import pytest
from tornado.httpclient import HTTPClientError
from traitlets import TraitError

from whybook.server import connection, decision_models, local_models, model_client, network, privacy, providers
from whybook.server.config import Whybook
from whybook.server.connection import Connection
from whybook.server.keystore import KeyStore

ALL_LOCAL = Whybook(way_to_use_models="all-local")
SETUP = 'The server sets c.Whybook.way_to_use_models = "all-local": in the AI models panel, connect a model server on this machine or in its network.'
ONLY_NETWORK = 'The server allows only models on this machine or in its network: c.Whybook.way_to_use_models = "all-local".'


@pytest.fixture
def way():
    """The server's way to use models: a test sets it with parametrize."""
    return ""


@pytest.fixture
def jp_server_config(jp_server_config, way):
    return {**jp_server_config, "Whybook": {"way_to_use_models": way}}


@pytest.fixture(autouse=True)
def resolver(monkeypatch):
    """The addresses of the host names of a test, in place of this machine's resolver, which no test asks."""
    names: dict[str, list[str]] = {}

    def addresses(host, port):
        if host not in names:
            raise OSError(f"no address for {host}")
        return names[host]

    monkeypatch.setattr(network, "addresses", addresses)
    monkeypatch.setattr(network, "_names", {})
    return names


async def status(jp_fetch) -> dict:
    return json.loads((await jp_fetch("whybook", "status")).body)


async def refused(jp_fetch, *path, body) -> tuple[int, str]:
    """The code and the message of a request that the server refuses."""
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", *path, method="POST", body=json.dumps(body))
    return error.value.code, json.loads(error.value.response.body)["message"]


def test_each_user_chooses_unless_the_server_sets_the_way():
    assert Whybook().way_to_use_models == ""
    assert Whybook().data_stays_here is False
    assert Whybook(keep_data_local=True).data_stays_here is True
    assert Whybook(way_to_use_models="remote").data_stays_here is False
    assert Whybook(way_to_use_models="data-stays-here").data_stays_here is True
    assert Whybook(way_to_use_models="all-local").data_stays_here is True
    assert [Whybook(way_to_use_models=way).network_only for way in ("", "remote", "data-stays-here", "all-local")] == [False, False, False, True]


def test_the_ways_have_the_ids_of_the_screen():
    # "frontier" was the first way's id before it became "remote".
    with pytest.raises(TraitError):
        Whybook(way_to_use_models="frontier")


@pytest.mark.parametrize("value", ["data-stays-here", "all-local"])
def test_a_way_that_keeps_the_data_here_keeps_it_for_every_request(value):
    config = Whybook(way_to_use_models=value)
    assert privacy.keep_local(config, {}) is True
    assert privacy.keep_local(config, {"keep_data_local": False}) is True


def test_the_remote_way_leaves_the_choice_to_each_request():
    assert privacy.keep_local(Whybook(way_to_use_models="remote"), {}) is False
    assert privacy.keep_local(Whybook(way_to_use_models="remote"), {"keep_data_local": True}) is True


async def test_the_status_says_that_each_user_chooses(jp_fetch):
    found = await status(jp_fetch)
    assert found["way_to_use_models"] == ""
    assert found["keep_data_local"] is False


@pytest.mark.parametrize("way, keeps", [("remote", False), ("data-stays-here", True), ("all-local", True)])
async def test_the_status_names_the_way_that_the_server_sets(jp_fetch, way, keeps):
    found = await status(jp_fetch)
    assert found["way_to_use_models"] == way
    # With True, the view shows "Keep data on this machine" checked and greyed.
    assert found["keep_data_local"] is keeps


@pytest.mark.parametrize("installed", [True, False])
async def test_the_status_says_whether_the_local_models_can_run(jp_fetch, monkeypatch, installed):
    monkeypatch.setattr(local_models, "runtime_available", lambda: installed)
    found = await status(jp_fetch)
    assert found["local_runtime"] is installed


def test_a_server_on_this_machine_or_in_its_network_is_known_by_its_address(resolver):
    resolver["llm.lab.example"] = ["10.2.0.15"]
    resolver["gpu.lab.example"] = ["10.2.0.16", "fd00::16"]
    resolver["mixed.example"] = ["10.2.0.17", "203.0.113.17"]
    resolver["api.example"] = ["203.0.113.5"]
    inside = [
        "http://localhost:11434/v1",
        "http://ollama.localhost/v1",
        "http://127.0.0.1:8080/v1",
        "http://[::1]:8000/v1",
        "http://10.1.2.3:8000/v1",
        "http://172.20.0.4/v1",
        "https://192.168.1.20/v1",
        "http://169.254.10.1/v1",
        "http://[fd12::5]/v1",
        "http://[fe80::1]/v1",
        "http://[::ffff:192.168.0.9]/v1",
        "http://llm.lab.example:8000/v1",
        "http://gpu.lab.example/v1",
    ]
    outside = [
        "https://openrouter.ai/api/v1",
        "http://203.0.113.5/v1",
        "http://172.32.0.1/v1",
        "http://100.64.0.1/v1",
        "http://mixed.example/v1",
        "http://api.example/v1",
        "ftp://10.0.0.1/v1",
        "not a URL",
        None,
    ]
    assert [url for url in inside if not network.on_network(url)] == []
    assert [url for url in outside if network.on_network(url)] == []


def test_the_answer_for_a_host_name_holds_for_five_minutes(resolver, monkeypatch):
    resolver["llm.lab.example"] = ["10.2.0.15"]
    assert network.on_network("http://llm.lab.example/v1")
    resolver["llm.lab.example"] = ["203.0.113.15"]
    assert network.on_network("http://llm.lab.example/v1")
    later = network.time.monotonic() + network.KEEP + 1
    monkeypatch.setattr(network.time, "monotonic", lambda: later)
    assert not network.on_network("http://llm.lab.example/v1")


@pytest.mark.parametrize(
    "data, reason",
    [
        ({"provider": "openrouter", "model": "anthropic/claude-sonnet-5"}, "OpenRouter runs outside this machine and its network"),
        ({"provider": "huggingface", "model": "m"}, "Hugging Face runs outside this machine and its network"),
        ({"provider": "anthropic", "model": "claude-sonnet-5"}, "Anthropic runs outside this machine and its network"),
        ({"provider": "claude-code"}, "Claude runs outside this machine and its network"),
        # A local server at another URL, or a server that the analyst says runs here, is known by its address.
        ({"provider": "ollama", "model": "q", "base_url": "http://203.0.113.5:11434/v1"}, "Ollama runs outside this machine and its network"),
        (
            {"provider": "openai-compatible", "model": "m", "base_url": "http://203.0.113.5:8000/v1", "local": True},
            "The server at http://203.0.113.5:8000/v1 runs outside this machine and its network",
        ),
        ({"provider": "ollama", "model": "qwen3:8b"}, None),
        ({"provider": "openai-compatible", "model": "m", "base_url": "http://10.2.0.15:8000/v1", "local": False}, None),
        ({"provider": "none"}, None),
    ],
)
def test_all_local_refuses_every_model_outside_this_machine_and_its_network(data, reason):
    chosen = Connection.from_json(data)
    assert connection.outside(chosen, ALL_LOCAL) == reason
    if reason:
        assert connection.unavailable(chosen, ALL_LOCAL) == (reason, SETUP)
    # The other ways refuse none of them.
    assert connection.outside(chosen, Whybook(way_to_use_models="data-stays-here")) is None


def test_a_hosted_model_saved_before_cannot_run_and_the_panel_says_why():
    connection.save(Connection.from_json({"provider": "openrouter", "model": "anthropic/claude-sonnet-5"}))
    KeyStore().set("openrouter", "sk-or-v1-test", signin="openrouter")
    assert connection.readiness(Whybook())["available"] is True
    found = connection.readiness(ALL_LOCAL)
    assert (found["available"], found["reason"], found["setup"]) == (False, "OpenRouter runs outside this machine and its network", SETUP)


async def test_all_local_refuses_a_hosted_model_before_any_call(monkeypatch):
    connection.save(Connection.from_json({"provider": "openrouter", "model": "anthropic/claude-sonnet-5"}))
    KeyStore().set("openrouter", "sk-or-v1-test", signin="openrouter")
    calls = []

    async def no_call(*args, **kwargs):
        calls.append(args)
        yield {"type": "result", "output": {}}

    monkeypatch.setattr(model_client, "structured_call", no_call)
    events = [event async for event in connection.structured_call("A prompt", schema={}, system_prompt="", config=ALL_LOCAL, effort="low")]
    assert events == [{"type": "error", "message": f"No AI model answered: OpenRouter runs outside this machine and its network. {SETUP}"}]
    driver = connection.agent_driver(ALL_LOCAL)
    with pytest.raises(RuntimeError, match="OpenRouter runs outside this machine and its network"):
        await driver(None, None, ALL_LOCAL)
    assert calls == []


async def test_all_local_refuses_the_decision_models_that_answer_outside():
    KeyStore().set("openrouter", "sk-or-v1-test", signin="openrouter")
    found = decision_models.status(ALL_LOCAL)
    assert [model for model, state in found.items() if state["available"]] == []
    assert found["clef"]["reason"] == decision_models.OUTSIDE
    with pytest.raises(ValueError, match="runs outside this machine and its network"):
        await decision_models.ask(decision_models.MODELS["clef"], {}, ALL_LOCAL)
    # Jev through TypeSafe's API at an address in the network may answer, and the request goes there, past the OpenRouter key.
    inside = Whybook(way_to_use_models="all-local", typesafe_api_key="ts-test", typesafe_base_url="http://10.0.0.7:9000")
    assert decision_models.status(inside)["jev"]["available"] is True
    sent = []

    class Response:
        body = json.dumps({"answers": {"a": 1.0}})

    async def fetch(url, **options):
        sent.append(url)
        return Response()

    answer = await decision_models.ask(decision_models.MODELS["jev"], {"question": "q"}, inside, fetch)
    assert sent == ["http://10.0.0.7:9000/v1/systemone"] and answer["answers"] == {"a": 1.0}


@pytest.mark.parametrize("way", ["all-local"])
async def test_the_routes_refuse_hosted_providers_and_say_why(jp_fetch, way):
    state = json.loads((await jp_fetch("whybook", "connection")).body)
    assert state["network_only"] is True
    # The tests offer the Claude Code login, which the server then refuses.
    assert (state["readiness"]["available"], state["readiness"]["reason"]) == (False, "Claude runs outside this machine and its network")
    assert await refused(jp_fetch, "connection", body={"provider": "openrouter", "model": "anthropic/claude-sonnet-5"}) == (
        403,
        f"OpenRouter runs outside this machine and its network. {ONLY_NETWORK}",
    )
    code, message = await refused(
        jp_fetch, "connection", body={"provider": "openai-compatible", "model": "m", "base_url": "http://203.0.113.5:8000/v1", "local": True}
    )
    assert (code, message) == (403, f"The server at http://203.0.113.5:8000/v1 runs outside this machine and its network. {ONLY_NETWORK}")
    assert (await refused(jp_fetch, "connection", "models", body={"provider": "openrouter"}))[0] == 403
    assert (await refused(jp_fetch, "auth", "key", body={"provider": "anthropic", "key": "sk-ant-test"})) == (
        403,
        f"Anthropic runs outside this machine and its network. {ONLY_NETWORK}",
    )
    assert (await refused(jp_fetch, "auth", "openrouter", body={}))[0] == 403
    assert (await refused(jp_fetch, "auth", "huggingface", body={}))[0] == 403
    assert KeyStore().get("anthropic") is None and connection.load().provider == "none"


@pytest.mark.parametrize("way", ["all-local"])
async def test_all_local_saves_a_server_on_this_machine(jp_fetch, monkeypatch, way):
    async def listed(provider, *, key, base_url, **options):
        return [{"id": "qwen3:8b", "label": "qwen3:8b", "note": None}]

    monkeypatch.setattr(providers, "models", listed)
    state = json.loads(
        (await jp_fetch("whybook", "connection", method="POST", body=json.dumps({"provider": "ollama", "model": "qwen3:8b"}))).body
    )
    assert state["connection"]["provider"] == "ollama"
    assert state["readiness"]["available"] is True
