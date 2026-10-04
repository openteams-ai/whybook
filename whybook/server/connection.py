"""The model that writes cells and answers: which provider and model the analyst connected.

The view's settings give a task either a local model, run in the server by
``local_models.py``, or "remote", the model connected here. That model is,
by provider:

- ``none``: no model connected, where nothing is saved.
- ``claude-code``: Claude through the Claude Agent SDK and the Claude Code
  login (``claude.py``), for development only, under Anthropic's terms. It is
  offered only when the server starts with ``--Whybook.claude_code_login=True``,
  and it is then the default.
- ``openrouter`` and ``huggingface``: a hosted model of many companies, after
  a sign-in in the AI models panel (``signin.py``), or for Hugging Face a token
  pasted there.
- ``anthropic``, ``openai``, ``google`` and ``mistral``: the models of one
  company, with an API key pasted into the panel. Keys and tokens stay in
  ``keystore.py``.
- ``ollama``, ``lmstudio``, ``llamacpp`` and ``vllm``: a server on this
  machine, found on its default port (``providers.py``).
- ``openai-compatible``: any other server with an OpenAI-compatible API, at a
  URL the analyst types, which says whether it runs on this machine.

Every provider but the Claude Code login goes through Pydantic AI (``model_client.py``).
The choice is kept in ``connection.json`` in Whybook's data folder, so a
sign-in or a new model takes effect without a restart. Whether the model runs
on this machine decides what it may read when the data stays here
(``privacy.py``).
"""

from __future__ import annotations

import copy
import dataclasses
import os
from dataclasses import dataclass
from typing import Any, AsyncIterator

from . import claude, model_client, signin, tiers
from .config import Whybook
from .keystore import KeyStore, data_dir, read_json, write_private


@dataclass(frozen=True)
class Provider:
    id: str
    label: str
    # True when its model runs on this machine; None when the analyst says.
    local: bool | None
    # The base URL of its OpenAI-compatible API, with /v1 for a local server.
    base_url: str | None
    # How the analyst gets a key: a sign-in, or a key pasted into the panel when needs_key is set.
    signin: str | None = None
    needs_key: bool = False
    dev_only: bool = False


PROVIDERS: dict[str, Provider] = {
    provider.id: provider
    for provider in (
        Provider("none", "No model connected", local=False, base_url=None),
        Provider("claude-code", "Claude, with the Claude Code login", local=False, base_url=None, dev_only=True),
        Provider("openrouter", "OpenRouter", local=False, base_url="https://openrouter.ai/api/v1", signin="openrouter", needs_key=True),
        Provider("huggingface", "Hugging Face", local=False, base_url="https://router.huggingface.co/v1", signin="huggingface", needs_key=True),
        Provider("anthropic", "Anthropic", local=False, base_url="https://api.anthropic.com", needs_key=True),
        Provider("openai", "OpenAI", local=False, base_url="https://api.openai.com/v1", needs_key=True),
        Provider("google", "Google Gemini", local=False, base_url="https://generativelanguage.googleapis.com", needs_key=True),
        Provider("mistral", "Mistral AI", local=False, base_url="https://api.mistral.ai", needs_key=True),
        Provider("ollama", "Ollama", local=True, base_url="http://127.0.0.1:11434/v1"),
        Provider("lmstudio", "LM Studio", local=True, base_url="http://localhost:1234/v1"),
        Provider("llamacpp", "llama.cpp server", local=True, base_url="http://127.0.0.1:8080/v1"),
        Provider("vllm", "vLLM", local=True, base_url="http://localhost:8000/v1"),
        Provider("openai-compatible", "An OpenAI-compatible server", local=None, base_url=None),
    )
}

SETUP_MODELS = model_client.SETUP_MODELS
# The providers that take a key pasted into the panel, with a check that costs nothing.
PASTED_KEYS = ("huggingface", "anthropic", "openai", "google", "mistral")
# The servers that take a key typed with their URL, since a server may ask for one.
TYPED_KEYS = ("openai-compatible", "lmstudio", "llamacpp", "vllm")
SETUP_CONNECT = "Connect one in the AI models panel."
DEV_ONLY = "the Claude Code login is for development only, under Anthropic's terms"
SETUP_DEV_ONLY = "Start the server with --Whybook.claude_code_login=True, or connect another model in the AI models panel."


@dataclass(frozen=True)
class Connection:
    """The provider, its model, and for a server the URL and whether it runs on this machine."""

    provider: str = "none"
    model: str | None = None
    base_url: str | None = None
    local: bool = False

    @classmethod
    def from_json(cls, data: Any) -> Connection:
        """A connection from the view or the file; unknown providers and bad values raise ValueError."""
        if not isinstance(data, dict):
            raise ValueError("a connection is an object")
        provider = data.get("provider")
        if provider not in PROVIDERS:
            raise ValueError(f"unknown provider {provider!r}")
        model = data.get("model")
        if model is not None and (not isinstance(model, str) or not model.strip() or len(model) > 200):
            raise ValueError("the model is a name of at most 200 characters")
        base_url = data.get("base_url")
        known = PROVIDERS[provider]
        if provider == "none":
            return cls()
        if provider == "openai-compatible":
            if not isinstance(base_url, str) or not base_url.startswith(("http://", "https://")):
                raise ValueError("an OpenAI-compatible server needs its URL, starting with http:// or https://")
            local = data.get("local") is True
        else:
            # A local server on another port keeps its own URL; the others use the catalogue's.
            if base_url is not None and (not known.local or not isinstance(base_url, str) or not base_url.startswith(("http://", "https://"))):
                raise ValueError(f"{known.label} takes no URL" if not known.local else "a URL starts with http:// or https://")
            local = bool(known.local)
        return cls(provider=provider, model=model.strip() if isinstance(model, str) else None, base_url=base_url.rstrip("/") if base_url else None, local=local)

    def to_json(self) -> dict[str, Any]:
        return dataclasses.asdict(self)

    @property
    def url(self) -> str | None:
        """The base URL that calls go to."""
        return self.base_url or PROVIDERS[self.provider].base_url

    def label(self, config: Whybook | None = None) -> str:
        """The model as the view names it: "OpenRouter: anthropic/claude-sonnet-5"."""
        provider = PROVIDERS[self.provider]
        if self.provider == "none":
            return provider.label
        if self.provider == "claude-code":
            model = config.claude_model if config is not None else None
            return f"Claude: {model}" if model else "Claude, with the Claude Code login"
        name = "Server at " + (self.url or "") if self.provider == "openai-compatible" else provider.label
        return f"{name}: {self.model}" if self.model else name


def connection_path() -> str:
    return os.path.join(data_dir(), "connection.json")


def load(config: Whybook | None = None) -> Connection:
    """The saved connection. Where none is saved, or the file is broken: the Claude Code
    login when the server offers it (``c.Whybook.claude_code_login``), else no model."""
    data = read_json(connection_path())
    try:
        if data:
            return Connection.from_json(data)
    except ValueError:
        pass
    return Connection(provider="claude-code") if config is not None and config.claude_code_login else Connection()


def unavailable(connection: Connection, config: Whybook) -> tuple[str, str] | None:
    """Why the connection cannot be used at all, and what to do, or None: no model, or a login the server does not offer."""
    if connection.provider == "none":
        return "no model is connected", SETUP_CONNECT
    if connection.provider == "claude-code" and not config.claude_code_login:
        return DEV_ONLY, SETUP_DEV_ONLY
    return None


def save(connection: Connection) -> None:
    write_private(connection_path(), connection.to_json())


def key_name(connection: Connection) -> str:
    """The name of the connection's key in the store.

    A key typed for a server belongs to the URL it was typed for, so that it
    goes to no other server: "vllm http://localhost:8000/v1". A sign-in's key,
    or a company's, belongs to the provider. A server's key that an older
    version saved is kept under the provider alone, and goes to no server.
    """
    if connection.provider in TYPED_KEYS:
        return f"{connection.provider} {connection.url}"
    return connection.provider


def key_for(connection: Connection, keys: KeyStore | None = None) -> str | None:
    return (keys or KeyStore()).get(key_name(connection))


def key_state(connection: Connection, keys: KeyStore | None = None) -> dict[str, Any] | None:
    """What the panel shows of the connection's saved key: when it was saved, whether a provider checked it, and when one last refused it."""
    meta = (keys or KeyStore()).meta(key_name(connection))
    if not meta:
        return None
    return {"saved": meta.get("saved"), "checked": meta.get("checked") is not False, "refused": meta.get("refused")}


def note_check(connection: Connection, key: str | None, took: bool) -> None:
    """Keep what a call with the saved key showed: the provider took it, which clears a mark of a key saved without a check or refused before, or it refused it."""
    if not key:
        return
    keys = KeyStore()
    if took:
        keys.confirm(key_name(connection), key)
    else:
        keys.refuse(key_name(connection), key)


async def fresh_key(connection: Connection, config: Whybook, keys: KeyStore | None = None) -> str | None:
    """The key for a call: a Hugging Face sign-in's token is renewed first when it expires.

    Raises ``signin.SignInError`` when Hugging Face does not renew it.
    """
    if connection.provider == "huggingface":
        return await signin.huggingface_token(config.huggingface_client_id, keys)
    return key_for(connection, keys)


def missing_key(provider: Provider) -> tuple[str, str]:
    """Why a provider without its key cannot answer, and how to get the key."""
    if provider.signin:
        return f"not signed in to {provider.label}", f"Sign in with {provider.label} in the AI models panel."
    article = "an" if provider.label[0] in "AEIOU" else "a"
    return f"no {provider.label} API key is saved", f"Paste {article} {provider.label} API key in the AI models panel."


def priced(connection: Connection) -> bool:
    """Whether a price of the connection's models is known: the Claude Code CLI knows its own, and Pydantic AI those of ``model_client.PRICED``.

    A newer model of such a provider may still have no price; its answers then have no cost.
    """
    return connection.provider == "claude-code" or connection.provider in model_client.PRICED


def runs_locally(config: Whybook | None = None) -> bool:
    """Whether the connected model runs on this machine, so that it may read the data when it stays here."""
    return load(config).local


def for_request(config: Whybook, body: Any) -> Whybook:
    """The config for the calls of one request, with what the view chose for them.

    A request turns zero data retention off with ``"zero_data_retention": false``,
    unless the server pins it (``c.Whybook.openrouter_zdr``). Its ``model``
    names the remote model of its task: a tier or a model of the connected
    provider (tiers.py), which ``structured_call`` and ``agent_driver`` use in
    place of the connected model. The server's own config stays as it is: the
    request gets a copy, which every call of the request reads, an agent's run
    included.
    """
    if not isinstance(body, dict):
        return config
    retention = body.get("zero_data_retention") is False and not config.openrouter_zdr and config.zero_data_retention
    model = body.get("model")
    task = model if tiers.is_remote(model) and model != config.task_model else None
    if not retention and task is None:
        return config
    own = copy.copy(config)
    if retention:
        own.zero_data_retention = False
    if task is not None:
        own.task_model = task
    return own


def task_connection(connection: Connection, config: Whybook) -> Connection:
    """The connection that answers the task of a request: the connected one, with the model that the task's choice names.

    Raises ``tiers.OtherProvider`` with the reason when the choice names a
    model of another provider, and ValueError when it names nothing.
    """
    try:
        model = tiers.model_for(config.task_model, connection.provider)
    except tiers.OtherProvider:
        _, owner, chosen = tiers.parse(config.task_model)
        other = PROVIDERS[owner].label if owner in PROVIDERS else owner
        raise tiers.OtherProvider(
            f"the task is set to {chosen}, a model of {other}, and the connected model is {connection.label()}."
            " Choose the task's model again in the AI models panel"
        ) from None
    return dataclasses.replace(connection, model=model) if model else connection


def readiness(config: Whybook) -> dict[str, Any]:
    """Whether the connected model can answer, read without a call to it: what is missing and how to set it up.

    The fields of ``claude.readiness``, with the provider, the model, the label
    the view shows, and whether the model runs on this machine.
    """
    connection = load(config)
    about = {
        "provider": connection.provider,
        "model": connection.model,
        "label": connection.label(config),
        "local": connection.local,
        # Whether a price of the provider's models is known, so that an answer has a cost and a cost cap holds it.
        "priced": priced(connection),
    }
    missing = {"available": False, "cli": None, "credential": None, **about}
    blocked = unavailable(connection, config)
    if blocked:
        return {**missing, "reason": blocked[0], "setup": blocked[1]}
    if connection.provider == "claude-code":
        return {**claude.readiness(config), **about, "model": config.claude_model}
    provider = PROVIDERS[connection.provider]
    if not model_client.is_installed():
        return {**missing, "reason": "pydantic-ai-slim is not installed on the server", "setup": SETUP_MODELS}
    if not model_client.is_installed(provider.id):
        return {**missing, "reason": f"the {model_client.sdk_of(provider.id)} package, which {provider.label} needs, is not installed on the server", "setup": SETUP_MODELS}
    if provider.needs_key and not KeyStore().has(key_name(connection)):
        reason, how = missing_key(provider)
        return {**missing, "reason": reason, "setup": how}
    if not connection.model:
        return {**missing, "reason": f"no model of {about['label']} is chosen", "setup": "Choose one in the AI models panel."}
    return {"available": True, "cli": None, "credential": provider.label, "reason": None, "setup": None, **about}


async def structured_call(
    prompt: str,
    *,
    schema: dict[str, Any],
    system_prompt: str,
    config: Whybook,
    effort: str,
    images: list[dict[str, str]] | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Ask the connected model for JSON that matches ``schema``, with the events of ``claude.structured_call``.

    The model is the one that the request's task chose (``task_connection``):
    the connected model, or another model of its provider, with the same key.
    """
    connection = load(config)
    blocked = unavailable(connection, config)
    if blocked:
        yield {"type": "error", "message": f"No AI model answered: {blocked[0]}. {blocked[1]}"}
        return
    try:
        connection = task_connection(connection, config)
    except ValueError as error:
        yield {"type": "error", "message": f"No AI model answered: {error}."}
        return
    if connection.provider == "claude-code":
        if connection.model and connection.model != config.claude_model:
            # A model of the Claude Code login that the task names.
            config = copy.copy(config)
            config.claude_model = connection.model
        async for event in claude.structured_call(prompt, schema=schema, system_prompt=system_prompt, config=config, effort=effort, images=images):
            yield with_provider(event, connection)
        return
    try:
        key = await fresh_key(connection, config)
    except signin.SignInError as error:
        yield {"type": "error", "message": f"No AI model answered: {error}"}
        return
    async for event in model_client.structured_call(
        connection, key, prompt, schema=schema, system_prompt=system_prompt, config=config, effort=effort, images=images
    ):
        if event.get("type") == "result":
            note_check(connection, key, took=True)
        elif event.get("type") == "error" and event.pop("key_refused", False):
            note_check(connection, key, took=False)
        yield with_provider(event, connection)


def with_provider(event: dict[str, Any], connection: Connection) -> dict[str, Any]:
    """A result with the provider that answered, which the notebook records with the model."""
    return {**event, "provider": connection.provider} if event.get("type") == "result" else event


def agent_driver(config: Whybook) -> Any:
    """The driver of an agent run on the connected model (``agent.Driver``)."""
    from . import agent

    connection = load(config)
    blocked = unavailable(connection, config)
    if not blocked:
        try:
            connection = task_connection(connection, config)
        except ValueError as error:
            blocked = (str(error), "")
    if blocked:
        why = f"No AI model answered: {blocked[0]}. {blocked[1]}".strip()

        async def refuse(run: Any, request: Any, config: Whybook) -> dict[str, Any]:
            raise RuntimeError(why)

        return refuse
    if connection.provider == "claude-code":

        async def by_claude(run: Any, request: Any, config: Whybook) -> dict[str, Any]:
            # Looked up at each run, so that a test can put a script in its place.
            return with_provider(await agent.claude_driver(run, request, config), connection)

        return by_claude

    async def drive(run: Any, request: Any, config: Whybook) -> dict[str, Any]:
        try:
            key = await fresh_key(connection, config)
        except signin.SignInError as error:
            raise RuntimeError(f"No AI model answered: {error}") from error
        try:
            result = await model_client.agent_driver(connection, key, agent.TOOLS)(run, request, config)
        except model_client.KeyRefusedError:
            note_check(connection, key, took=False)
            raise
        note_check(connection, key, took=True)
        return with_provider(result, connection)

    return drive


def reason(message: str, config: Whybook) -> str:
    """Why a call to the connected model failed, in words the analyst can act on: named after the task's model."""
    connection = load(config)
    try:
        connection = task_connection(connection, config)
    except ValueError:
        pass
    if connection.provider == "claude-code":
        return claude.reason(message, config)
    return model_client.reason(message, connection.label(config), connection.url, config, model_client.signs_in(connection))
