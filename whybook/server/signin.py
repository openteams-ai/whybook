"""Sign in to a provider from the AI models panel: OpenRouter with PKCE, Hugging Face with a device code.

OpenRouter (research/model_access/sign-in.md, section 1). The panel opens
openrouter.ai/auth with a PKCE challenge. OpenRouter sends the browser back to
this server's callback with a code, and the server exchanges the code, with
the verifier that never left the server, for a key that the user owns and can
revoke on openrouter.ai. OpenRouter takes an https callback, or one on
localhost or 127.0.0.1 on any port. Elsewhere, the sign-in leaves the callback
out: OpenRouter shows the code, and the analyst pastes it into the panel. A
code lasts 10 minutes and serves once.

Hugging Face (section 2). With Whybook's own OAuth app
(``c.Whybook.huggingface_client_id``), a public app with the inference-api
scope, the server asks huggingface.co for a device code. The analyst approves
the code on huggingface.co, and the panel asks the server to poll until
Hugging Face gives the token. No redirect is needed, so it works on any
JupyterHub. No other application's client id is borrowed. The token lasts 8
hours, and the server renews it with the refresh token before a call
(``huggingface_token``). Without the app, the panel takes a token that the
analyst creates on huggingface.co.

The key or the token goes to ``keystore.py``. A flow in progress lives in
this process only: a restart ends it.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable
from urllib.parse import urlencode, urlparse

from tornado.httpclient import AsyncHTTPClient, HTTPClientError
from tornado.simple_httpclient import HTTPTimeoutError

from .keystore import KeyStore

OPENROUTER_AUTH = "https://openrouter.ai/auth"
OPENROUTER_EXCHANGE = "https://openrouter.ai/api/v1/auth/keys"
HUGGINGFACE_DEVICE = "https://huggingface.co/oauth/device"
HUGGINGFACE_TOKEN = "https://huggingface.co/oauth/token"
HUGGINGFACE_APPROVE = "https://huggingface.co/oauth/device"
DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
# OpenRouter's code lasts 10 minutes; a flow waits for it that long.
FLOW_SECONDS = 600
REQUEST_SECONDS = 20.0
# A Hugging Face token is renewed when it expires within this many seconds.
RENEW_SECONDS = 120

HUGGINGFACE_NO_CLIENT = (
    "Sign in with Hugging Face needs Whybook's Hugging Face OAuth app: set"
    " c.Whybook.huggingface_client_id, or WHYBOOK_HUGGINGFACE_CLIENT_ID, to its client id,"
    " and restart the server. A token pasted into the panel works without it."
)
HUGGINGFACE_EXPIRED = "the Hugging Face sign-in has expired. Sign in again in the AI models panel."

Fetch = Callable[..., Awaitable[Any]]


class SignInError(Exception):
    """A sign-in that failed, in words for the panel."""


def unreachable(company: str, error: Exception, then: str) -> SignInError:
    """A request that timed out or found nobody, as a sign-in error.

    tornado raises HTTPTimeoutError, an HTTPClientError and no OSError, for a
    request that passes its timeout, also with raise_error=False: it gave the
    routes an HTTP 500 until 29 September 2026.
    """
    if isinstance(error, (HTTPTimeoutError, TimeoutError)):
        return SignInError(f"{company} did not answer in time: {then}")
    return SignInError(f"{company} could not be reached: {getattr(error, 'strerror', None) or error}")


def challenge(verifier: str) -> str:
    """The S256 PKCE challenge of a verifier: base64url of its SHA-256, without padding (RFC 7636)."""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def callback_allowed(url: str) -> bool:
    """Whether OpenRouter takes this callback: https, or http on localhost or 127.0.0.1."""
    parsed = urlparse(url)
    return parsed.scheme == "https" or (parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1"))


@dataclass
class OpenRouterFlow:
    state: str
    verifier: str
    started: float = field(default_factory=time.monotonic)


@dataclass
class DeviceFlow:
    id: str
    device_code: str
    interval: int
    deadline: float


OPENROUTER_FLOWS: dict[str, OpenRouterFlow] = {}
DEVICE_FLOWS: dict[str, DeviceFlow] = {}


def _prune() -> None:
    now = time.monotonic()
    for state in [state for state, flow in OPENROUTER_FLOWS.items() if now - flow.started > FLOW_SECONDS]:
        del OPENROUTER_FLOWS[state]
    for flow_id in [flow_id for flow_id, flow in DEVICE_FLOWS.items() if now > flow.deadline]:
        del DEVICE_FLOWS[flow_id]


def openrouter_start(callback_base: str | None) -> dict[str, Any]:
    """Start a sign-in: the URL to open, and whether OpenRouter comes back or shows a code to paste.

    ``callback_base`` is this server's callback route as the browser reaches it;
    the flow's state is added to its path. None, or a URL that OpenRouter does
    not take, starts the sign-in with a code to paste.
    """
    _prune()
    state = secrets.token_urlsafe(16)
    verifier = secrets.token_urlsafe(48)
    params = {"code_challenge": challenge(verifier), "code_challenge_method": "S256"}
    mode = "code"
    if callback_base and callback_allowed(callback_base):
        params["callback_url"] = f"{callback_base.rstrip('/')}/{state}"
        mode = "callback"
    OPENROUTER_FLOWS[state] = OpenRouterFlow(state=state, verifier=verifier)
    return {"state": state, "url": f"{OPENROUTER_AUTH}?{urlencode(params)}", "mode": mode}


async def openrouter_exchange(state: str, code: str, keys: KeyStore | None = None, fetch: Fetch | None = None) -> dict[str, Any]:
    """Exchange the code of a sign-in for the user's key, and keep the key."""
    _prune()
    flow = OPENROUTER_FLOWS.pop(state, None)
    if flow is None:
        raise SignInError("This sign-in has expired or was used: sign in again.")
    code = (code or "").strip()
    if not code:
        raise SignInError("OpenRouter gave no code: sign in again.")
    fetch = fetch or AsyncHTTPClient().fetch
    body = {"code": code, "code_verifier": flow.verifier, "code_challenge_method": "S256"}
    try:
        response = await fetch(
            OPENROUTER_EXCHANGE,
            method="POST",
            headers={"Content-Type": "application/json"},
            body=json.dumps(body),
            request_timeout=REQUEST_SECONDS,
            raise_error=False,
        )
        data = json.loads(response.body or b"{}")
    except (OSError, HTTPClientError) as error:
        # The flow served once: a new sign-in starts again.
        raise unreachable("OpenRouter", error, "sign in again.") from error
    except ValueError as error:
        raise SignInError(f"OpenRouter could not be reached: {error}") from error
    key = data.get("key") if isinstance(data, dict) else None
    if response.code != 200 or not key:
        detail = data.get("error") if isinstance(data, dict) else None
        message = detail.get("message") if isinstance(detail, dict) else detail
        raise SignInError(f"OpenRouter did not give a key (HTTP {response.code}{': ' + str(message) if message else ''}): sign in again.")
    (keys or KeyStore()).set("openrouter", key, signin="openrouter", user_id=data.get("user_id"))
    return {"ok": True}


async def _post_form(url: str, form: dict[str, str], fetch: Fetch | None) -> tuple[int, Any]:
    fetch = fetch or AsyncHTTPClient().fetch
    try:
        response = await fetch(
            url,
            method="POST",
            headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"},
            body=urlencode(form),
            request_timeout=REQUEST_SECONDS,
            follow_redirects=False,
            raise_error=False,
        )
    except (OSError, HTTPClientError) as error:
        raise unreachable("Hugging Face", error, "try again.") from error
    try:
        return response.code, json.loads(response.body or b"{}")
    except ValueError:
        # A gateway's error page, not an OAuth answer.
        return response.code, {}


def _keep_huggingface(keys: KeyStore, data: dict[str, Any], refresh_token: str | None = None) -> None:
    """Keep a token of the device flow, with when it expires and the refresh token that renews it."""
    meta: dict[str, Any] = {"signin": "huggingface", "scope": data.get("scope", "")}
    if data.get("expires_in"):
        meta["expires_at"] = time.time() + int(data["expires_in"])
    if data.get("refresh_token") or refresh_token:
        meta["refresh_token"] = data.get("refresh_token") or refresh_token
    keys.set("huggingface", str(data["access_token"]), **meta)


async def huggingface_start(client_id: str, fetch: Fetch | None = None) -> dict[str, Any]:
    """Ask Hugging Face for a device code: the code to approve, where, and how often to poll."""
    if not client_id:
        raise SignInError(HUGGINGFACE_NO_CLIENT)
    _prune()
    status, data = await _post_form(HUGGINGFACE_DEVICE, {"client_id": client_id}, fetch)
    if status != 200 or not isinstance(data, dict) or not data.get("device_code") or not data.get("user_code"):
        detail = (data.get("error_description") or data.get("error")) if isinstance(data, dict) else None
        raise SignInError(f"Hugging Face did not start the sign-in (HTTP {status}{': ' + str(detail) if detail else ''}).")
    flow = DeviceFlow(
        id=secrets.token_urlsafe(12),
        device_code=str(data["device_code"]),
        interval=int(data.get("interval") or 5),
        deadline=time.monotonic() + int(data.get("expires_in") or 900),
    )
    DEVICE_FLOWS[flow.id] = flow
    return {
        "flow": flow.id,
        "user_code": data["user_code"],
        "verification_uri": data.get("verification_uri") or HUGGINGFACE_APPROVE,
        # The page with the code filled in, where Hugging Face gives one.
        "verification_uri_complete": data.get("verification_uri_complete"),
        "expires_in": int(data.get("expires_in") or 900),
        "interval": flow.interval,
    }


async def huggingface_poll(flow_id: str, client_id: str, keys: KeyStore | None = None, fetch: Fetch | None = None) -> dict[str, Any]:
    """Ask Hugging Face once whether the analyst approved the code: pending, done, expired, denied or an error.

    An answer that is not OAuth's, such as HTTP 502 from a gateway, counts as
    pending until the code expires (RFC 8628, section 3.5), as in huggingface_hub.
    """
    _prune()
    flow = DEVICE_FLOWS.get(flow_id)
    if flow is None:
        return {"status": "expired"}
    status, data = await _post_form(HUGGINGFACE_TOKEN, {"grant_type": DEVICE_GRANT, "device_code": flow.device_code, "client_id": client_id}, fetch)
    data = data if isinstance(data, dict) else {}
    if status == 200 and data.get("access_token"):
        DEVICE_FLOWS.pop(flow_id, None)
        _keep_huggingface(keys or KeyStore(), data)
        return {"status": "done"}
    error = data.get("error")
    if error is None or error == "authorization_pending":
        return {"status": "pending", "interval": flow.interval}
    if error == "slow_down":
        flow.interval += 5
        return {"status": "pending", "interval": flow.interval}
    DEVICE_FLOWS.pop(flow_id, None)
    if error == "expired_token":
        return {"status": "expired"}
    if error == "access_denied":
        return {"status": "denied"}
    detail = data.get("error_description") or error
    return {"status": "error", "message": f"Hugging Face refused the sign-in (HTTP {status}: {detail})."}


async def huggingface_token(client_id: str, keys: KeyStore | None = None, fetch: Fetch | None = None) -> str | None:
    """The Hugging Face token for a call, renewed first when it expires within two minutes.

    A token pasted into the panel does not expire here: Hugging Face refuses it
    when the analyst revokes it. A renewal that Hugging Face refuses forgets
    the token, so that the panel asks for a new sign-in.
    """
    keys = keys or KeyStore()
    token = keys.get("huggingface")
    expires_at = (keys.meta("huggingface") or {}).get("expires_at")
    if not token or not isinstance(expires_at, (int, float)) or expires_at - time.time() > RENEW_SECONDS:
        return token
    refresh_token = keys.get("huggingface", "refresh_token")
    if not refresh_token or not client_id:
        if expires_at > time.time():
            return token
        keys.delete("huggingface")
        raise SignInError(HUGGINGFACE_EXPIRED)
    status, data = await _post_form(HUGGINGFACE_TOKEN, {"grant_type": "refresh_token", "refresh_token": refresh_token, "client_id": client_id}, fetch)
    if status == 200 and isinstance(data, dict) and data.get("access_token"):
        _keep_huggingface(keys, data, refresh_token)
        return str(data["access_token"])
    if isinstance(data, dict) and data.get("error") in ("invalid_grant", "invalid_client", "unauthorized_client"):
        keys.delete("huggingface")
        raise SignInError(HUGGINGFACE_EXPIRED)
    raise SignInError(f"Hugging Face did not renew the sign-in (HTTP {status}). Try again, or sign in again in the AI models panel.")
