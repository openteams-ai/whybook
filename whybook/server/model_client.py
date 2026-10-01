"""Calls to any model through Pydantic AI: OpenRouter, Hugging Face, Anthropic, OpenAI, Google, Mistral AI, and servers with an OpenAI-compatible API.

This is the one module that imports ``pydantic_ai`` (research/model-access.md,
"Keep every Pydantic AI type inside the one module"). The rest of the server
sees the events of ``claude.structured_call`` and the agent driver of
``agent.py``. Pydantic AI is imported when a call starts, so that the server
runs without the ``models`` extra.

- A structured call asks for JSON through an output tool made from the raw
  schema (``StructuredDict``). ``claude.matches`` checks the answer, and the
  model is asked again, twice at most, when it does not match.
- An agent run gives the model the tools of ``agent.TOOLS`` from their JSON
  schemas, one call at a time, and ``finish`` as the output. Each tool call
  waits for the view, as in ``agent.claude_driver``.
- Limits: 4 requests for a call and ``agent_max_turns`` for a run. The cost
  caps apply to the providers whose prices Pydantic AI knows (``PRICED``); a
  local model has no price, and Hugging Face's price depends on the company
  that serves the model. A run's cap is ``agent_budget_usd``, or what is left
  under the notebook's cap when that is lower (``agent.AgentRequest.cap``).
"""

from __future__ import annotations

import ast
import base64
import importlib.util
import json
import logging
import re
import time
import warnings
from typing import Any, AsyncIterator, Awaitable, Callable

from . import claude
from .config import EFFORT_LEVELS, Whybook

log = logging.getLogger(__name__)

Event = dict[str, Any]

# The effort of Whybook's settings as Pydantic AI's `thinking` setting takes it.
THINKING = dict(zip(EFFORT_LEVELS, ["low", "medium", "high", "xhigh", "xhigh"]))
# Hosted providers whose models Pydantic AI knows by name, so that the thinking setting reaches them.
KNOWN_MODELS = ("openrouter", "anthropic", "openai", "google", "mistral")
# Providers whose prices Pydantic AI knows (genai-prices), so that a cost cap applies.
PRICED = ("openrouter", "anthropic", "openai", "google", "mistral")
# The SDK that a provider's calls need, besides pydantic-ai-slim; the others need openai.
SDKS = {"anthropic": "anthropic", "google": "google.genai", "mistral": "mistralai"}
# How often the thought line may change, in seconds.
THOUGHT_EVERY = 0.4


def sdk_of(provider: str) -> str:
    return SDKS.get(provider, "openai")


def is_installed(provider: str | None = None) -> bool:
    """Whether pydantic-ai-slim is installed, with the SDK of a provider's calls when one is given."""
    # Checked without importing: Pydantic AI takes a second to import.
    names = ["pydantic_ai", sdk_of(provider)] if provider else ["pydantic_ai"]
    try:
        return all(importlib.util.find_spec(name) is not None for name in names)
    except ModuleNotFoundError:  # google is not there, for google.genai
        return False


def router_profile(model: str) -> Any:
    """The profile of a model that Hugging Face's router serves, from the company in its name: "Qwen/Qwen3.8-27B:ovhcloud".

    As Pydantic AI's providers of open models do it (``NebiusProvider``): the
    profile of the model's family, over the one of an OpenAI-compatible API.
    """
    from pydantic_ai.profiles import merge_profile
    from pydantic_ai.profiles.deepseek import deepseek_model_profile
    from pydantic_ai.profiles.google import google_model_profile
    from pydantic_ai.profiles.harmony import harmony_model_profile
    from pydantic_ai.profiles.meta import meta_model_profile
    from pydantic_ai.profiles.mistral import mistral_model_profile
    from pydantic_ai.profiles.moonshotai import moonshotai_model_profile
    from pydantic_ai.profiles.openai import OpenAIJsonSchemaTransformer, OpenAIModelProfile
    from pydantic_ai.profiles.qwen import qwen_model_profile

    families = {
        "deepseek-ai": deepseek_model_profile,
        "google": google_model_profile,
        "meta-llama": meta_model_profile,
        "mistralai": mistral_model_profile,
        "moonshotai": moonshotai_model_profile,
        "openai": harmony_model_profile,  # gpt-oss
        "qwen": qwen_model_profile,
    }
    base = OpenAIModelProfile(json_schema_transformer=OpenAIJsonSchemaTransformer)
    name = model.split(":", 1)[0].lower()
    if "/" not in name:
        return base
    company, name = name.split("/", 1)
    family = families.get(company)
    return merge_profile(base, family(name) if family else None)


def build_model(connection: Any, key: str | None) -> Any:
    """The Pydantic AI model of a connection (``connection.Connection``)."""
    import pydantic_ai
    from pydantic_ai.usage import CostNotFoundWarning

    # The first run would print an advertisement for Logfire to the server's log.
    pydantic_ai.BANNER_ENABLED = False
    # A model newer than genai-prices has no price: its run has no cost cap, and the view shows no cost.
    warnings.filterwarnings("ignore", category=CostNotFoundWarning)
    provider, model, url = connection.provider, connection.model, connection.url
    if provider == "openrouter":
        from pydantic_ai.models.openrouter import OpenRouterModel
        from pydantic_ai.providers.openrouter import OpenRouterProvider

        return OpenRouterModel(model, provider=OpenRouterProvider(api_key=key, app_title="Whybook"))
    if provider == "anthropic":
        from pydantic_ai.models.anthropic import AnthropicModel
        from pydantic_ai.providers.anthropic import AnthropicProvider

        return AnthropicModel(model, provider=AnthropicProvider(api_key=key))
    if provider == "google":
        from pydantic_ai.models.google import GoogleModel
        from pydantic_ai.providers.google import GoogleProvider

        return GoogleModel(model, provider=GoogleProvider(api_key=key))
    if provider == "mistral":
        from pydantic_ai.models.mistral import MistralModel
        from pydantic_ai.providers.mistral import MistralProvider

        return MistralModel(model, provider=MistralProvider(api_key=key))
    if provider == "openai":
        # The Responses API, as Pydantic AI's "openai:" models use it.
        from pydantic_ai.models.openai import OpenAIResponsesModel
        from pydantic_ai.providers.openai import OpenAIProvider

        return OpenAIResponsesModel(model, provider=OpenAIProvider(api_key=key))
    if provider == "ollama":
        from pydantic_ai.models.ollama import OllamaModel
        from pydantic_ai.providers.ollama import OllamaProvider

        return OllamaModel(model, provider=OllamaProvider(base_url=url))
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    if provider == "huggingface":
        # The router's OpenAI-compatible API: "model:company" picks the company that serves it.
        return OpenAIChatModel(model, provider=OpenAIProvider(base_url=url, api_key=key), profile=router_profile(model))
    if provider == "vllm":
        from pydantic_ai.providers.vllm import VLLMProvider

        return OpenAIChatModel(model, provider=VLLMProvider(base_url=url, api_key=key or "none"))
    # llama.cpp, LM Studio and any other server: an API key only when the server asks for one.
    return OpenAIChatModel(model, provider=OpenAIProvider(base_url=url, api_key=key or "none"))


def missing_key(connection: Any, key: str | None) -> str | None:
    """Why a call cannot start without a key, or None: a hosted provider needs the key of a sign-in or a pasted key."""
    from .connection import PROVIDERS, missing_key as why

    provider = PROVIDERS[connection.provider]
    if provider.needs_key and not key:
        reason, how = why(provider)
        return f"No AI model answered: {reason}. {how}"
    return None


def refuses_output_tools(error: Exception) -> bool:
    """Whether Pydantic AI refused a thinking setting with an output tool, as for Claude Haiku 4.5 and Opus 5.5."""
    text = str(error).lower()
    return "output tool" in text and "thinking" in text


def signs_in(connection: Any) -> bool:
    """Whether the analyst gets the provider's key by a sign-in, rather than by pasting it."""
    from .connection import PROVIDERS

    provider = PROVIDERS[connection.provider]
    return bool(provider.signin) or not provider.needs_key


def model_settings(connection: Any, config: Whybook, effort: str | None) -> dict[str, Any]:
    settings: dict[str, Any] = {}
    if effort and connection.provider in KNOWN_MODELS:
        settings["thinking"] = THINKING.get(effort, "medium")
    if connection.provider == "openrouter" and config.zdr:
        # Only the providers that keep no prompt or answer (research/model-access.md):
        # the server's lock, or the setting of the view that sent the request.
        settings["openrouter_provider"] = {"zdr": True}
    return settings


def cost_limit(connection: Any, budget: float) -> float | None:
    return budget if connection.provider in PRICED else None


def genai_priced(connection: Any) -> bool:
    """Whether genai-prices, by which Pydantic AI prices each answer and holds a run to its cost cap, knows the connection's model."""
    from genai_prices import Usage, calc_price

    try:
        calc_price(Usage(input_tokens=1, output_tokens=1), connection.model, provider_id=connection.provider)
    except LookupError:
        return False
    return True


async def list_price(connection: Any, fetch: Any = None) -> dict[str, float] | None:
    """OpenRouter's list price, per token, of a model that genai-prices does not know, such as Gemini 3.8 Flash on 1 October 2026.

    Its answers then cost the tokens at that price, and its calls stop at
    a number of tokens that the cap can pay for (``token_cap``). None for
    another provider, a model that genai-prices knows, or a list that cannot
    be read: the answers then have no cost, as before.
    """
    if connection.provider != "openrouter" or not connection.model or genai_priced(connection):
        return None
    from . import providers

    return await providers.openrouter_price(connection.model, fetch)


def cost_by_list(usage: Any, price: dict[str, float]) -> float:
    """What the tokens of a run cost at a list price, in US dollars: the tokens read from the provider's cache at its price for them."""
    cached = min(getattr(usage, "cache_read_tokens", 0) or 0, usage.input_tokens or 0)
    read = price.get("input_cache_read", price["prompt"])
    total = ((usage.input_tokens or 0) - cached) * price["prompt"] + cached * read + (usage.output_tokens or 0) * price["completion"]
    return round(total, 8)


def token_cap(price: dict[str, float] | None, budget: float) -> int | None:
    """The tokens of a run that its cap can pay for at a list price, each at the dearer of the two prices; None without a price."""
    dearest = max(price["prompt"], price["completion"]) if price else 0.0
    return max(1, int(budget / dearest)) if dearest > 0 else None


def model_name(result: Any, connection: Any) -> str:
    """The model that answered, as the notebook's metadata records it: "openrouter:anthropic/claude-sonnet-5"."""
    response = getattr(result, "response", None)
    name = getattr(response, "model_name", None) or connection.model
    return f"{connection.provider}:{name}"


def cost_of(result: Any) -> float | None:
    """The cost of a run in USD, added up over its responses; None when a price is unknown."""
    total = 0.0
    for message in result.all_messages():
        if getattr(message, "kind", None) != "response":
            continue
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                total += float(message.cost().total_price)
        except Exception:  # noqa: BLE001  genai-prices has no price for this model
            return None
    return round(total, 6)


class Progress:
    """The view's progress events from Pydantic AI's stream: the stage, and the last line of the model's thinking."""

    def __init__(self, elapsed: Callable[[], float]) -> None:
        self.elapsed = elapsed
        self.thoughts: dict[int, str] = {}
        self.shown: str | None = None
        self.shown_at = 0.0
        self.stage: str | None = None

    def of(self, event: Any) -> list[Event]:
        from pydantic_ai.messages import (
            OutputToolResultEvent,
            PartDeltaEvent,
            PartStartEvent,
            RetryPromptPart,
            TextPart,
            ThinkingPart,
            ThinkingPartDelta,
            ToolCallPart,
        )

        events: list[Event] = []
        if isinstance(event, PartStartEvent):
            if isinstance(event.part, ThinkingPart):
                self.thoughts[event.index] = event.part.content or ""
                events += self.thought(event.index)
            elif isinstance(event.part, (TextPart, ToolCallPart)):
                events += self.at("writing")
        elif isinstance(event, PartDeltaEvent) and isinstance(event.delta, ThinkingPartDelta):
            self.thoughts[event.index] = self.thoughts.get(event.index, "") + (event.delta.content_delta or "")
            events += self.thought(event.index)
        elif isinstance(event, OutputToolResultEvent) and isinstance(event.part, RetryPromptPart):
            events += self.at("retrying")
        return events

    def at(self, stage: str) -> list[Event]:
        if stage == self.stage:
            return []
        self.stage = stage
        return [{"type": "progress", "stage": stage, "elapsed": self.elapsed()}]

    def thought(self, index: int) -> list[Event]:
        lines = [line.strip().strip("*#").strip() for line in self.thoughts.get(index, "").splitlines()]
        lines = [line for line in lines if line]
        if not lines:
            return self.at("thinking")
        line = lines[-1]
        if len(line) > claude.THOUGHT_CHARS:
            line = line[: claude.THOUGHT_CHARS - 1].rsplit(" ", 1)[0] + "…"
        now = time.monotonic()
        if line == self.shown or now - self.shown_at < THOUGHT_EVERY:
            return []
        self.shown, self.shown_at, self.stage = line, now, "thinking"
        return [{"type": "progress", "stage": "thinking", "message": line, "elapsed": self.elapsed()}]


def user_content(prompt: str, images: list[dict[str, str]] | None) -> Any:
    """The prompt, with each picture before it as bytes: ``{"media_type", "data"}`` in base64."""
    if not images:
        return prompt
    from pydantic_ai import BinaryContent

    return [*(BinaryContent(data=base64.b64decode(image["data"]), media_type=image["media_type"]) for image in images), prompt]


async def structured_call(
    connection: Any,
    key: str | None,
    prompt: str,
    *,
    schema: dict[str, Any],
    system_prompt: str,
    config: Whybook,
    effort: str,
    images: list[dict[str, str]] | None = None,
) -> AsyncIterator[Event]:
    """Ask the connected model for JSON that matches ``schema``: ``progress`` events, then one ``result`` or ``error``."""
    start = time.monotonic()

    def elapsed() -> float:
        return round(time.monotonic() - start, 1)

    if not is_installed():
        yield {"type": "error", "message": f"No AI model answered: pydantic-ai-slim is not installed on the server. {SETUP_MODELS}"}
        return
    missing = missing_key(connection, key)
    if missing:
        yield {"type": "error", "message": missing}
        return
    from pydantic_ai import Agent, ModelRetry, StructuredDict, UsageLimits
    from pydantic_ai.run import AgentRunResultEvent
    from pydantic_ai.usage import RunUsage

    # Pydantic AI adds each response's price here, so that a call that fails
    # after it reached the model still says what it cost. A model that
    # genai-prices lacks costs its tokens at OpenRouter's list price.
    usage = RunUsage()
    price = await list_price(connection)

    def spent() -> float | None:
        if usage.cost is not None:
            return round(float(usage.cost), 8)
        return cost_by_list(usage, price) if price else None

    # What the schema check found in the last answer that broke it, for the error when no answer fits.
    broken: list[str] = []

    def check(value: Any) -> Any:
        problems = claude.matches(value, schema)
        if problems:
            broken[:] = problems[:3]
            raise ModelRetry("The answer does not match the schema: " + "; ".join(problems[:4]))
        return value

    progress = Progress(elapsed)
    yield {"type": "progress", "stage": "starting", "elapsed": elapsed()}
    result = None
    try:
        agent = Agent(
            build_model(connection, key),
            output_type=StructuredDict(schema, name="answer", description="The answer, as the schema asks."),
            system_prompt=system_prompt,
            retries={"tools": 1, "output": 2},
        )
        agent.output_validator(check)
        async with agent.run_stream_events(
            user_content(prompt, images),
            model_settings=model_settings(connection, config, effort),
            usage=usage,
            usage_limits=UsageLimits(
                request_limit=4,
                cost_limit=cost_limit(connection, config.claude_budget_usd),
                # Without a price of genai-prices, the cap holds as a number of tokens.
                total_tokens_limit=token_cap(price, config.claude_budget_usd),
            ),
        ) as events:
            async for event in events:
                for update in progress.of(event):
                    yield update
                if isinstance(event, AgentRunResultEvent):
                    result = event.result
    except Exception as error:  # noqa: BLE001  the failure goes to the view in plain words
        log.warning("the call to %s failed: %s", connection.provider, error)
        message = reason(str(error), connection.label(config), connection.url, config, signs_in(connection))
        if broken and "output retries" in str(error).lower():
            # Pydantic AI's "Exceeded maximum output retries (2)": every answer broke the schema.
            message = f"The AI model did not answer in the form asked for: {'; '.join(broken)}."
        failed = {"type": "error", "message": message, "elapsed": elapsed()}
        if key_refused(str(error)):
            # For connection.structured_call, which marks the saved key as refused and drops the flag.
            failed["key_refused"] = True
        yield {**failed, "cost_usd": spent()} if spent() is not None else failed
        return
    if result is None:
        yield {"type": "error", "message": "The AI model ended without an answer.", "elapsed": elapsed()}
        return
    # The prices of the messages, else what the call's usage added up.
    cost = cost_of(result)
    yield {"type": "result", "output": result.output, "model": model_name(result, connection), "cost_usd": cost if cost is not None else spent(), "elapsed": elapsed()}


def agent_driver(connection: Any, key: str | None, tools: dict[str, dict[str, Any]]) -> Callable[[Any, Any, Whybook], Awaitable[dict[str, Any]]]:
    """An agent driver (``agent.Driver``) on the connected model: the tools of ``agent.TOOLS``, and ``finish`` as the output."""

    async def drive(run: Any, request: Any, config: Whybook) -> dict[str, Any]:
        if not is_installed():
            raise RuntimeError(f"No AI model answered: pydantic-ai-slim is not installed on the server. {SETUP_MODELS}")
        missing = missing_key(connection, key)
        if missing:
            raise RuntimeError(missing)
        from pydantic_ai import Agent, ModelRetry, StructuredDict, Tool, ToolOutput, UsageLimits
        from pydantic_ai.exceptions import UserError
        from pydantic_ai.messages import PartEndEvent, TextPart
        from pydantic_ai.run import AgentRunResultEvent
        from pydantic_ai.usage import RunUsage

        from .agent import CapReached

        def handler(name: str) -> Callable[..., Awaitable[dict[str, Any]]]:
            async def call(**arguments: Any) -> dict[str, Any]:
                # Pydantic AI does not check a raw schema's arguments: the counts of explore are checked here.
                if name == "explore" and not 2 <= len(arguments.get("branches") or []) <= 4:
                    raise ModelRetry("explore takes 2 to 4 branches")
                return await run.call(name, arguments)

            return call

        finish = tools["finish"]
        agent = Agent(
            build_model(connection, key),
            tools=[
                # One call at a time: the cells go into the notebook in order.
                Tool.from_schema(handler(name), name=name, description=spec["description"], json_schema=spec["schema"], sequential=True)
                for name, spec in tools.items()
                if name != "finish"
            ],
            output_type=ToolOutput(StructuredDict(finish["schema"], name="finish"), name="finish", description=finish["description"]),
            system_prompt=request.system_prompt(),
            retries={"tools": 2, "output": 2},
        )
        progress = Progress(lambda: 0.0)
        run.emit({"type": "progress", "stage": "starting", "elapsed": 0.0})
        # The server's cap of a run, or what is left under the notebook's cap, whichever is lower.
        cap, by = request.cap(config)
        # Pydantic AI adds each response's price to this object as the run goes, so that a run
        # that stops or fails still says what it cost. A model that genai-prices lacks costs
        # its tokens at OpenRouter's list price, and its run stops at the tokens the cap pays for.
        usage = RunUsage()
        price = await list_price(connection)

        def meter() -> float | None:
            if usage.cost is not None:
                return float(usage.cost)
            return cost_by_list(usage, price) if price else None

        run.meter = meter

        async def attempt(settings: dict[str, Any]) -> Any:
            result = None
            async with agent.run_stream_events(
                request.prompt(),
                model_settings=settings,
                usage=usage,
                usage_limits=UsageLimits(
                    request_limit=config.agent_max_turns, cost_limit=cost_limit(connection, cap), total_tokens_limit=token_cap(price, cap)
                ),
            ) as events:
                async for event in events:
                    if isinstance(event, PartEndEvent) and isinstance(event.part, TextPart) and event.part.content.strip():
                        run.emit({"type": "text", "text": event.part.content.strip()})
                    for update in progress.of(event):
                        if update.get("message"):
                            run.emit(update)
                    if isinstance(event, AgentRunResultEvent):
                        result = event.result
            return result

        settings = model_settings(connection, config, config.agent_effort)
        try:
            try:
                result = await attempt(settings)
            except UserError as error:
                # Some models take a thinking setting or an output tool such as finish, not
                # both, and Pydantic AI refuses before any request: the run goes again without thinking.
                if "thinking" not in settings or not refuses_output_tools(error):
                    raise
                log.info("the agent on %s runs without thinking: %s", connection.model, error)
                result = await attempt({name: value for name, value in settings.items() if name != "thinking"})
        except Exception as error:
            log.warning("the agent run on %s failed: %s", connection.provider, error)
            text = str(error)
            if "request_limit" in text:
                raise RuntimeError(f"the agent reached its limit of {config.agent_max_turns} turns before it finished (c.Whybook.agent_max_turns).") from error
            # The cap as a cost, or as the tokens that it pays for at a list price.
            if "cost_limit" in text or "total_tokens_limit" in text:
                raise CapReached(cap, by, run.spent(), f"{connection.provider}:{connection.model}") from error
            failed = KeyRefusedError if key_refused(text) else RuntimeError
            raise failed(reason(text, connection.label(config), connection.url, config, signs_in(connection))) from error
        from .agent import answer_fields

        answer = result.output if result is not None and isinstance(result.output, dict) else {}
        run.answer = answer
        return {
            "type": "result",
            **answer_fields(answer),
            "model": model_name(result, connection) if result is not None else connection.model,
            # The prices of the messages, else what the run's usage added up, as its cap counted.
            "cost_usd": (cost_of(result) if result is not None else None) or run.spent(),
        }

    return drive


SETUP_MODELS = 'Install the models extra of whybook, pip install -e ".[models]", and restart the server.'

# The words of a provider's error for a key that it refuses: HTTP 401, or a company's own words.
# HTTP 403 is not among them: OpenRouter sends it for a prompt that its moderation flags,
# and other companies for a region or a permission, so its words are shown instead.
REFUSED_WORDS = ("status_code: 401", "unauthorized", "invalid api key", "api key not valid", "api_key_invalid", "authentication_error")
# The longest that a provider's words of a refusal go to the view.
WORDS_CHARS = 400


class KeyRefusedError(RuntimeError):
    """An agent's run that the provider refused for its key: ``connection.agent_driver`` marks the saved key as refused."""


def key_refused(message: str) -> bool:
    """Whether a call failed because the provider refused its key, from the words of its error."""
    lowered = message.lower()
    return any(word in lowered for word in REFUSED_WORDS)


def http_status(message: str) -> int | None:
    """The HTTP status of a provider's answer, from the words of Pydantic AI's error: "status_code: 429, ..."."""
    found = re.search(r"status_code: (\d{3})", message)
    return int(found.group(1)) if found else None


def provider_words(message: str) -> str | None:
    """What the provider wrote in a refusal, from the error that Pydantic AI raises, or None when it holds no words.

    ``status_code: 429, model_name: m, body: {'message': 'Provider returned error',
    'metadata': {'raw': 'm is temporarily rate-limited upstream. ...', 'provider_name': 'Azure'}}``
    gives "Azure: m is temporarily rate-limited upstream. ...": through
    OpenRouter, the company that refused, and its words. The words of a
    company's own API are in ``error.message`` or ``message``. They are cut to
    WORDS_CHARS, and a key in them is replaced.
    """
    from .privacy import SECRET_PREFIX

    at = message.find("body: ")
    if at < 0:
        # A refusal in a stream comes as the provider's words alone.
        words, company = (None if http_status(message) else message), None
    else:
        raw = message[at + len("body: ") :].strip()
        try:
            body: Any = ast.literal_eval(raw)
        except (ValueError, SyntaxError):
            body = raw
        words, company = _words_of(body)
    if not words or not words.strip():
        return None
    words = " ".join(SECRET_PREFIX.sub("[a key]", words).split())
    if len(words) > WORDS_CHARS:
        words = words[: WORDS_CHARS - 1].rsplit(" ", 1)[0] + "…"
    named = company and words.lower().startswith((f"{company.lower()}:", f"{company.lower()} "))
    return f"{company}: {words}" if company and not named else words


def _words_of(body: Any) -> tuple[str | None, str | None]:
    """The words and the company of a refusal's body: OpenRouter's upstream words first, then a company's error message."""
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except ValueError:
            return body, None
    if not isinstance(body, dict):
        return None, None
    metadata = body.get("metadata") if isinstance(body.get("metadata"), dict) else {}
    company = metadata.get("provider_name") if isinstance(metadata.get("provider_name"), str) else None
    if isinstance(metadata.get("raw"), str) and metadata["raw"].strip():
        return metadata["raw"], company
    error = body.get("error")
    if isinstance(error, dict) and isinstance(error.get("message"), str):
        return error["message"], company
    for key in ("message", "detail", "error"):
        if isinstance(body.get(key), str) and body[key].strip():
            return body[key], company
    return None, company


def reason(message: str, label: str, url: str | None, config: Whybook | None, signs_in: bool = True) -> str:
    """Why a call failed, in words the analyst can act on. The server log keeps the message as it came.

    ``signs_in`` is False for a provider whose key is pasted into the panel.
    """
    lowered = message.lower()
    # A cap that Pydantic AI holds as a cost, or as the tokens it pays for at a list price (token_cap).
    if "cost_limit" in lowered or "cost limit" in lowered or "total_tokens_limit" in lowered:
        budget = getattr(config, "claude_budget_usd", 0.5)
        return f"the call reached its cost cap (c.Whybook.claude_budget_usd, ${budget:.2f}, or c.Whybook.agent_budget_usd for an agent)."
    if "request_limit" in lowered or "request limit" in lowered:
        return "the model did not answer in the form asked for within the calls allowed."
    if "data policy" in lowered or "zero data retention" in lowered or "zdr" in lowered:
        # The server's lock, or the analyst's setting, which they can turn off.
        how = (
            "The server requires it (c.Whybook.openrouter_zdr): choose another model."
            if getattr(config, "openrouter_zdr", False)
            else 'Choose another model, or turn off "Zero data retention" in the AI models panel.'
        )
        return f"No AI model answered: no provider of {label} keeps no data of a request (zero data retention). {how}"
    if "connection refused" in lowered or "connecterror" in lowered or "connection error" in lowered or "all connection attempts failed" in lowered:
        return f"No AI model answered: nothing answered at {url} for {label}. Start the server, or choose another model in the AI models panel."
    if key_refused(message):
        return f"No AI model answered: {label} refused the key. {'Sign in again' if signs_in else 'Paste a new key'} in the AI models panel."
    status = http_status(message)
    if status in (403, 429) or "rate limit" in lowered or "rate-limited" in lowered or "resource_exhausted" in lowered:
        # The provider's own words, which say whose limit it is and what to do.
        words = provider_words(message)
        code = f" (HTTP {status})" if status else ""
        if words:
            return f"No AI model answered: {label} refused the request{code}: {words}" + ("" if words.endswith((".", "!", "?", "…")) else ".")
        if status == 403:
            return f"No AI model answered: {label} refused the request (HTTP 403)."
        return f"No AI model answered: {label} refuses more requests for now (HTTP 429: a rate limit, or the account's spending limit). Wait, or check the account's limits."
    if "status_code: 402" in lowered or "insufficient credits" in lowered or "no credit" in lowered:
        return f"No AI model answered: the account behind {label} has no credit left."
    if "model_not_supported" in lowered or "status_code: 404" in lowered or "model not found" in lowered:
        return f"No AI model answered: {label} does not serve this model. Choose another in the AI models panel."
    return message
