"""What the AI models panel lists: the servers found on this machine, and the models of each provider.

Every request goes from the Jupyter server, not from the browser, so the
browser's CORS rules do not apply and a key never reaches the browser. On a
remote JupyterHub, localhost is the user's pod, so only servers inside it are
found. Nothing here calls a model: listing models and checking a key cost
nothing (research/model-access.md, "A test when saved").
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Awaitable, Callable
from urllib.parse import urlparse

from tornado.httpclient import AsyncHTTPClient, HTTPClientError
from tornado.simple_httpclient import HTTPTimeoutError

from .connection import PROVIDERS, TYPED_KEYS

# The servers looked for on their default ports (research/model_access/sign-in.md, section 8).
LOCAL = ("ollama", "lmstudio", "llamacpp", "vllm")
# A server on this machine answers at once; one that does not is not there.
PROBE_SECONDS = 0.8
LIST_SECONDS = 15.0
OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models"
OPENROUTER_ZDR = "https://openrouter.ai/api/v1/endpoints/zdr"
OPENROUTER_KEY = "https://openrouter.ai/api/v1/key"
HUGGINGFACE_MODELS = "https://router.huggingface.co/v1/models"
HUGGINGFACE_WHOAMI = "https://huggingface.co/api/whoami-v2"
ANTHROPIC_MODELS = "https://api.anthropic.com/v1/models?limit=1000"
OPENAI_MODELS = "https://api.openai.com/v1/models"
GOOGLE_MODELS = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000"
MISTRAL_MODELS = "https://api.mistral.ai/v1/models"

# The companies that serve models through Hugging Face's router, by the name that picks them ("model:ovhcloud").
HUGGINGFACE_COMPANIES = {
    "baseten": "Baseten",
    "cerebras": "Cerebras",
    "cohere": "Cohere",
    "deepinfra": "DeepInfra",
    "featherless-ai": "Featherless AI",
    "fireworks-ai": "Fireworks",
    "groq": "Groq",
    "hf-inference": "Hugging Face",
    "novita": "Novita",
    "nscale": "Nscale",
    "ovhcloud": "OVHcloud",
    "publicai": "PublicAI",
    "scaleway": "Scaleway",
    "together": "Together AI",
    "zai-org": "Z.ai",
}
# OpenAI lists every model of the account: the ones for chat start so, and the others hold one of these words.
OPENAI_CHAT = ("gpt-", "chatgpt-", "o1", "o3", "o4")
OPENAI_NOT_CHAT = ("audio", "realtime", "transcribe", "tts", "image", "search", "instruct", "embedding", "moderation")
GOOGLE_NOT_CHAT = ("tts", "image", "audio", "embedding")

Fetch = Callable[..., Awaitable[Any]]

log = logging.getLogger(__name__)


class ProviderError(Exception):
    """A provider that could not be reached or refused, in words for the panel.

    ``check`` says how a check of a key ended, so that the panel offers the
    right way on: "refused" when the provider refused the key, "unchecked"
    when it could not check it. None for any other failure.
    """

    check: str | None = None


class KeyRefused(ProviderError):
    """The provider refused the key: HTTP 401 or 403, or 400 from Google. It may take a minute to accept a key it just made."""

    check = "refused"


class NotChecked(ProviderError):
    """The provider could not check the key: no answer in time, no connection, or an error of its own."""

    check = "unchecked"


# A key is printable ASCII with no space. A key pasted from wrapped text holds a
# line break, and tornado's error for such a header holds the whole line, key
# included: the key is refused first, and no message on these paths holds it.
KEY_REFUSED = "The key has a line break, a space or another character that keys do not have. Copy it again."


def key_problem(key: str) -> str | None:
    """Why a pasted or typed key cannot go in a request, in words that do not repeat it; None for a key that can."""
    return None if key and all("!" <= char <= "~" for char in key) else KEY_REFUSED


async def get_json(url: str, *, timeout: float, headers: dict[str, str] | None = None, fetch: Fetch | None = None) -> Any:
    fetch = fetch or AsyncHTTPClient().fetch
    response = await fetch(url, method="GET", headers=headers or {}, connect_timeout=timeout, request_timeout=timeout)
    return json.loads(response.body)


async def discover(fetch: Fetch | None = None) -> list[dict[str, Any]]:
    """The model servers that answer on this machine, each with the models it serves."""

    async def probe(provider_id: str) -> dict[str, Any] | None:
        provider = PROVIDERS[provider_id]
        try:
            models = await local_models(provider_id, provider.base_url or "", timeout=PROBE_SECONDS, fetch=fetch)
        except Exception:  # noqa: BLE001  nothing answers there
            return None
        return {"provider": provider_id, "label": provider.label, "base_url": provider.base_url, "models": models}

    found = await asyncio.gather(*(probe(provider_id) for provider_id in LOCAL))
    return [server for server in found if server]


async def local_models(provider_id: str, base_url: str, *, timeout: float = LIST_SECONDS, key: str | None = None, fetch: Fetch | None = None) -> list[dict[str, Any]]:
    """The models a server serves: Ollama's pulled models, or the /models of an OpenAI-compatible API."""
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    if provider_id == "ollama":
        data = await get_json(base_url.removesuffix("/v1") + "/api/tags", timeout=timeout, fetch=fetch)
        return [
            {"id": item["name"], "label": item["name"], "note": size_note(item.get("size"))}
            for item in data.get("models", [])
            if isinstance(item, dict) and item.get("name")
        ]
    data = await get_json(base_url.rstrip("/") + "/models", timeout=timeout, headers=headers, fetch=fetch)
    return [{"id": item["id"], "label": item["id"], "note": None} for item in data.get("data", []) if isinstance(item, dict) and item.get("id")]


def size_note(size: Any) -> str | None:
    return f"{size / 1e9:.1f} GB" if isinstance(size, (int, float)) and size > 0 else None


def price_note(pricing: Any) -> str | None:
    """OpenRouter's price per million tokens, in and out: "$3 in, $15 out per million tokens", or "free"."""
    if not isinstance(pricing, dict):
        return None
    try:
        prompt, completion = float(pricing.get("prompt", 0)) * 1e6, float(pricing.get("completion", 0)) * 1e6
    except (TypeError, ValueError):
        return None
    if prompt == 0 and completion == 0:
        return "free"
    return f"${prompt:g} in, ${completion:g} out per million tokens"


# OpenRouter's price of each model of its list, per token in US dollars, for
# the models whose price genai-prices lacks (model_client.list_price): kept
# for an hour after the server reads the list.
PRICES_SECONDS = 3600.0
PRICES_RETRY_SECONDS = 300.0
PRICE_KEYS = ("prompt", "completion", "input_cache_read")
_prices: dict[str, dict[str, float]] = {}
_prices_read: list[float] = []


def keep_prices(data: Any) -> None:
    """Keep the prices of OpenRouter's list of models: ``{"prompt", "completion", "input_cache_read"?}`` of each, per token."""
    prices: dict[str, dict[str, float]] = {}
    for item in data.get("data", []) if isinstance(data, dict) else []:
        pricing = item.get("pricing") if isinstance(item, dict) else None
        if not isinstance(pricing, dict) or not item.get("id"):
            continue
        price: dict[str, float] = {}
        for key in PRICE_KEYS:
            try:
                value = float(pricing.get(key))
            except (TypeError, ValueError):
                continue
            if value >= 0:
                price[key] = value
        if "prompt" in price and "completion" in price:
            prices[str(item["id"])] = price
    if prices:
        _prices.clear()
        _prices.update(prices)
        _prices_read[:] = [time.monotonic()]


async def openrouter_price(model: str, fetch: Fetch | None = None) -> dict[str, float] | None:
    """OpenRouter's list price of one model, per token, or None when the list does not have it or cannot be read.

    The server reads the list again an hour after it last did; a list that
    cannot be read leaves the prices it read before.
    """
    if not _prices_read or time.monotonic() - _prices_read[0] > PRICES_SECONDS:
        try:
            keep_prices(await get_json(OPENROUTER_MODELS, timeout=LIST_SECONDS, fetch=fetch))
        except Exception as error:  # noqa: BLE001  the answer then has no cost, as before
            log.warning("OpenRouter's list of models, for its prices, could not be read: %s", error)
            # The next call tries again in five minutes, not at once.
            _prices_read[:] = [time.monotonic() - PRICES_SECONDS + PRICES_RETRY_SECONDS]
    return _prices.get(model)


async def openrouter_models(zdr: bool = True, fetch: Fetch | None = None) -> list[dict[str, Any]]:
    """OpenRouter's models that take tools, which Whybook's answers and agent need; the lists need no key.

    With zero data retention (the view's setting, or ``c.Whybook.openrouter_zdr``
    for every user), only the models that have a provider keeping no data and
    taking tools: the others would refuse every request.
    """
    data = await get_json(OPENROUTER_MODELS, timeout=LIST_SECONDS, fetch=fetch)
    # The prices of the list, for the models whose price genai-prices lacks.
    keep_prices(data)
    allowed = None
    if zdr:
        endpoints = await get_json(OPENROUTER_ZDR, timeout=LIST_SECONDS, fetch=fetch)
        allowed = {
            endpoint.get("model_id")
            for endpoint in (endpoints.get("data", []) if isinstance(endpoints, dict) else [])
            if isinstance(endpoint, dict) and "tools" in (endpoint.get("supported_parameters") or [])
        }
    models = []
    for item in data.get("data", []):
        if not isinstance(item, dict) or not item.get("id"):
            continue
        if "tools" not in (item.get("supported_parameters") or []):
            continue
        if allowed is not None and item["id"] not in allowed:
            continue
        models.append({"id": item["id"], "label": item.get("name") or item["id"], "note": price_note(item.get("pricing"))})
    return sorted(models, key=lambda model: model["label"].lower())


def million_note(pricing: Any) -> str | None:
    """Hugging Face's price in dollars per million tokens: "$0.42 in, $3 out per million tokens"."""
    if not isinstance(pricing, dict) or not isinstance(pricing.get("input"), (int, float)) or not isinstance(pricing.get("output"), (int, float)):
        return None
    return f"${pricing['input']:g} in, ${pricing['output']:g} out per million tokens"


async def huggingface_models(fetch: Fetch | None = None) -> list[dict[str, Any]]:
    """The models of Hugging Face's router, once for each company that serves it with tools; the list needs no token.

    The id picks the company ("Qwen/Qwen3.8-27B:ovhcloud"), which decides who
    reads the requests and the price. Without it, the router picks the fastest
    company, which may not take tools.
    """
    data = await get_json(HUGGINGFACE_MODELS, timeout=LIST_SECONDS, fetch=fetch)
    models = []
    for item in data.get("data", []) if isinstance(data, dict) else []:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        for served in item.get("providers") or []:
            if not isinstance(served, dict) or not served.get("provider") or served.get("status") != "live" or not served.get("supports_tools"):
                continue
            company = HUGGINGFACE_COMPANIES.get(served["provider"], served["provider"])
            models.append({"id": f"{item['id']}:{served['provider']}", "label": f"{item['id']} on {company}", "note": million_note(served.get("pricing"))})
    return sorted(models, key=lambda model: model["label"].lower())


async def anthropic_models(key: str, fetch: Fetch | None = None) -> list[dict[str, Any]]:
    """Anthropic's models, newest first, as the API lists them."""
    data = await get_json(ANTHROPIC_MODELS, timeout=LIST_SECONDS, headers={"x-api-key": key, "anthropic-version": "2023-06-01"}, fetch=fetch)
    return [
        {"id": item["id"], "label": item.get("display_name") or item["id"], "note": None}
        for item in data.get("data", [])
        if isinstance(item, dict) and item.get("id")
    ]


async def openai_models(key: str, fetch: Fetch | None = None) -> list[dict[str, Any]]:
    """OpenAI's models for chat, newest first. The list gives no capabilities, so the names decide."""
    data = await get_json(OPENAI_MODELS, timeout=LIST_SECONDS, headers={"Authorization": f"Bearer {key}"}, fetch=fetch)
    items = [
        item
        for item in data.get("data", [])
        if isinstance(item, dict)
        and isinstance(item.get("id"), str)
        and item["id"].startswith(OPENAI_CHAT)
        and not any(word in item["id"] for word in OPENAI_NOT_CHAT)
    ]
    items.sort(key=lambda item: item.get("created") or 0, reverse=True)
    return [{"id": item["id"], "label": item["id"], "note": None} for item in items]


async def google_models(key: str, fetch: Fetch | None = None) -> list[dict[str, Any]]:
    """Google's Gemini models that write text (``generateContent``), in the order of the API."""
    data = await get_json(GOOGLE_MODELS, timeout=LIST_SECONDS, headers={"x-goog-api-key": key}, fetch=fetch)
    models = []
    for item in data.get("models", []):
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            continue
        name = item["name"].removeprefix("models/")
        if "generateContent" not in (item.get("supportedGenerationMethods") or []) or any(word in name for word in GOOGLE_NOT_CHAT):
            continue
        models.append({"id": name, "label": item.get("displayName") or name, "note": None})
    return models


async def mistral_models(key: str, fetch: Fetch | None = None) -> list[dict[str, Any]]:
    """Mistral AI's models for chat that call tools, by name; an alias such as mistral-large-latest is listed too."""
    data = await get_json(MISTRAL_MODELS, timeout=LIST_SECONDS, headers={"Authorization": f"Bearer {key}"}, fetch=fetch)
    seen: dict[str, dict[str, Any]] = {}
    for item in data.get("data", []):
        if not isinstance(item, dict) or not item.get("id"):
            continue
        capabilities = item.get("capabilities") if isinstance(item.get("capabilities"), dict) else {}
        if capabilities.get("completion_chat") and capabilities.get("function_calling"):
            seen[item["id"]] = {"id": item["id"], "label": item["id"], "note": None}
    return sorted(seen.values(), key=lambda model: model["id"])


# The providers whose models are listed with the analyst's key.
KEYED_LISTS = {"anthropic": anthropic_models, "openai": openai_models, "google": google_models, "mistral": mistral_models}


async def models(
    provider_id: str, *, key: str | None, base_url: str | None, zdr: bool = True, fetch: Fetch | None = None, typed: bool = False
) -> list[dict[str, Any]]:
    """The models of a provider as the panel lists them: ``{"id", "label", "note"}``.

    ``typed`` is True for a key that the analyst typed and that is not saved:
    a refusal then names "this key", and else "the saved key". Raises
    KeyRefused, NotChecked or another ProviderError, whose words name the
    provider and hold no part of the key.
    """
    label = PROVIDERS[provider_id].label if provider_id in PROVIDERS else provider_id
    provider = PROVIDERS.get(provider_id)
    if provider is None or provider_id in ("claude-code", "none"):
        raise ProviderError(f"no model list for {provider_id!r}")
    url = base_url or provider.base_url
    if provider_id in KEYED_LISTS and not key:
        raise ProviderError(f"{label}: paste its API key first")
    if not url:
        raise ProviderError(f"{label}: the server's URL is needed")
    try:
        if provider_id == "openrouter":
            return await openrouter_models(zdr, fetch)
        if provider_id == "huggingface":
            return await huggingface_models(fetch)
        if provider_id in KEYED_LISTS:
            return await KEYED_LISTS[provider_id](key, fetch)
        return await local_models(provider_id, url, key=key, fetch=fetch)
    except Exception as error:  # noqa: BLE001  each failure in words for the panel
        raise failure(error, provider_id, url, typed=typed) from None


def refused(provider_id: str, error: HTTPClientError) -> bool:
    """Whether a provider refused the key: HTTP 401 or 403, or 400 from Google, whose answer says "API key not valid"."""
    return error.code in (401, 403) or (provider_id == "google" and error.code == 400)


def speaker(provider_id: str, url: str) -> str:
    """Who answered, at the start of a sentence: the provider's name, or the URL of a server of the analyst's own."""
    return f"The server at {url}" if provider_id == "openai-compatible" else PROVIDERS[provider_id].label


def failure(error: Exception, provider_id: str, url: str, *, typed: bool) -> ProviderError:
    """A request to a provider that failed, in words for the panel, with how a check of its key ended.

    The words come from the error's kind and code, never from its text, which
    can quote the request and its headers, key included; the caller raises the
    result ``from None`` for the same reason.
    """
    who = speaker(provider_id, url)
    host = urlparse(url).netloc or url
    if isinstance(error, ProviderError):
        return error
    if isinstance(error, (HTTPTimeoutError, asyncio.TimeoutError, TimeoutError)):
        return NotChecked(f"{host} did not answer in {LIST_SECONDS:g} s")
    if isinstance(error, HTTPClientError):
        if error.code == 599:
            # tornado's code for a request that lost its connection.
            return NotChecked(f"{host} could not be reached")
        if refused(provider_id, error):
            return KeyRefused(f"{who} refused {'this key' if typed else 'the saved key'} (HTTP {error.code})")
        if error.code >= 500 or error.code == 429:
            # The provider's own trouble, or its rate limit: the key is not checked.
            return NotChecked(f"{who} answered HTTP {error.code}")
        return ProviderError(f"{who} answered HTTP {error.code}")
    if isinstance(error, UnicodeError):
        return ProviderError(KEY_REFUSED)
    if isinstance(error, OSError):
        if provider_id in LOCAL or provider_id in TYPED_KEYS:
            return NotChecked(f"{PROVIDERS[provider_id].label}: nothing answered at {url}: is the server running?")
        # The system's words, such as "Name or service not known", and never the request's.
        return NotChecked(f"{host} could not be reached: {error.strerror or 'no connection'}")
    if isinstance(error, ValueError):
        return NotChecked(f"{who} did not answer with JSON")
    return ProviderError(f"{who} could not be asked for its models")


def check_url(provider_id: str) -> str:
    """The URL that checks a pasted key: the company's list of models, or Hugging Face's whoami."""
    return {"huggingface": HUGGINGFACE_WHOAMI, "anthropic": ANTHROPIC_MODELS, "openai": OPENAI_MODELS, "google": GOOGLE_MODELS, "mistral": MISTRAL_MODELS}[provider_id]


async def check_key(provider_id: str, key: str, fetch: Fetch | None = None) -> None:
    """Check a pasted key at no cost: the company lists its models with it, or Hugging Face says whose token it is.

    Raises KeyRefused when the provider refuses the key, and NotChecked when it
    cannot check it. The message of a failure, and the exception it comes
    from, hold no part of the key: an error of the request can quote its headers.
    """
    problem = key_problem(key)
    if problem:
        raise ProviderError(problem)
    try:
        if provider_id == "huggingface":
            await get_json(HUGGINGFACE_WHOAMI, timeout=LIST_SECONDS, headers={"Authorization": f"Bearer {key}"}, fetch=fetch)
        else:
            await KEYED_LISTS[provider_id](key, fetch)
    except Exception as error:  # noqa: BLE001  each failure in words for the panel
        raise failure(error, provider_id, check_url(provider_id), typed=True) from None


def lists_with_key(provider_id: str) -> bool:
    """Whether the list of a provider's models takes the saved key, so that listing them checks it."""
    return provider_id in KEYED_LISTS or provider_id in TYPED_KEYS


async def lists_without_key(provider_id: str, url: str, fetch: Fetch | None = None) -> bool:
    """Whether a server lists its models without a key: it then asks for none, and takes any key, as vLLM without --api-key does.

    Any failure counts as a server that needs its key: the key passed its check.
    """
    try:
        await local_models(provider_id, url, fetch=fetch)
    except Exception:  # noqa: BLE001  refused, or no answer: the key may be needed
        return False
    return True


async def check_openrouter_key(key: str, fetch: Fetch | None = None) -> dict[str, Any]:
    """What OpenRouter says of a key, at no cost: its limit, the amount left and the usage."""
    try:
        data = await get_json(OPENROUTER_KEY, timeout=LIST_SECONDS, headers={"Authorization": f"Bearer {key}"}, fetch=fetch)
    except Exception as error:  # noqa: BLE001  each failure in words for the panel
        if isinstance(error, HTTPClientError) and error.code in (401, 403):
            raise KeyRefused("OpenRouter refused the key: sign in again") from None
        raise failure(error, "openrouter", OPENROUTER_KEY, typed=False) from None
    info = data.get("data") if isinstance(data, dict) else None
    info = info if isinstance(info, dict) else {}
    return {key_name: info.get(key_name) for key_name in ("label", "limit", "limit_remaining", "usage", "is_free_tier") if key_name in info}
