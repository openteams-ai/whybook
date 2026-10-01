"""Library defaults that can change a result, picked by a model from a function's signature.

Design iteration 1.53, the view's setting "Find more defaults with AI", on
by default since 1 October 2026. The kernel reads the signature of each
library function that a cell calls, and lists the parameters that each call
leaves at their defaults (kernel_code/analyze_cells.py, ``signatures``, and
in R kernel_code/r/analyze_cells.R, whose functions say ``"language": "R"``).
Here the model chosen for More questions reads one function's signature: it
picks the parameters whose default can change the result, puts them in order
and says why each one matters. The prompt names the function's language. The
view shows the picks as chips on the cells that leave them at their defaults,
marked as a model's choice.

An answer is kept per library and version, in ``library_defaults.json`` in
Whybook's data folder (keystore.data_dir), so the same function of the same
version is asked about once, whatever the notebook. ``kept`` reads the
answers without a model; ``model_picks`` and ``local_picks`` ask. Each kept
answer names the version of the prompt that asked for it (``PROMPT_VERSION``,
design iteration 1.86): after the prompt changes, the answers of the old one
are not read, and each function is asked about again.

Signatures and defaults are code, not data: with "Keep data on this machine",
a model elsewhere still reads the function, its parameters and their
defaults, all but the value of a default that holds data, such as a frame,
which the kernel writes as its type and size (``"data": true``). A default
that looks like a key, a token or a password goes to no model.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import threading
import time
from dataclasses import dataclass
from typing import Any, AsyncIterator

from . import claude, connection, local_models, privacy
from .config import Whybook
from .keystore import data_dir, read_json, write_private
from .questions.models import InvalidRequest

STORE = "library_defaults.json"
# What the server keeps and reads of one request: a function's parameters and
# the functions of one lookup.
MAX_PARAMS = 80
MAX_FUNCTIONS = 200
# The picks of one function that the view shows, at most.
MAX_PICKS = 3
# A parameter's name, in Python or in R, where a name may hold dots: na.strings.
NAME = re.compile(r"^[A-Za-z_.][A-Za-z0-9_.]*$")
# The languages whose kernels list signatures; a function that names none is Python's.
LANGUAGES = ("Python", "R")

# The version of SYSTEM_PROMPT that a kept answer was asked with: 1 until 1
# October 2026, when a pick had to be a parameter worth a chip and none was a
# good answer. Raise it with each change of the prompt that can change a pick.
PROMPT_VERSION = 2

# One thread writes the file at a time; each write reads it again first.
_lock = threading.Lock()


def store_path() -> str:
    return os.path.join(data_dir(), STORE)


def _text(data: dict[str, Any], key: str, limit: int, required: bool = True) -> str | None:
    value = data.get(key)
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise InvalidRequest(f"a function needs its {key}, as text of at most {limit} characters")
    return value.strip()


@dataclass(frozen=True)
class Param:
    """A parameter with a default: the default as code, and whether it holds data, such as a frame."""

    name: str
    default: str | None = None
    data: bool = False


@dataclass(frozen=True)
class Function:
    """A library function as the kernel lists it: ``pandas.core.frame.DataFrame.groupby``, pandas 3.0.6."""

    function: str
    name: str
    module: str
    library: str
    version: str | None
    params: tuple[Param, ...] = ()
    language: str = "Python"

    @classmethod
    def from_json(cls, data: Any) -> Function:
        if not isinstance(data, dict):
            raise InvalidRequest("a function is an object")
        params = data.get("params", [])
        if not isinstance(params, list):
            raise InvalidRequest("the parameters of a function are a list")
        language = data.get("language", "Python")
        if language not in LANGUAGES:
            raise InvalidRequest(f"a function's language is one of {', '.join(LANGUAGES)}")
        read = []
        for param in params[:MAX_PARAMS]:
            if not isinstance(param, dict) or not isinstance(param.get("name"), str) or not NAME.match(param["name"]):
                raise InvalidRequest("a parameter needs a name")
            default = param.get("default")
            text = default[:200] if isinstance(default, str) else None
            if text is not None and privacy.looks_secret(param["name"], text):
                # A key, a token or a password is no default to show: the
                # kernel leaves it out, and the server does too, for the
                # prompt, a local model's grammar and the picks it keeps.
                continue
            read.append(Param(param["name"], text, param.get("data") is True))
        return cls(
            function=_text(data, "function", 300),
            name=_text(data, "name", 200),
            module=_text(data, "module", 200),
            library=_text(data, "library", 100),
            version=_text(data, "version", 100, required=False),
            params=tuple(read),
            language=language,
        )

    @property
    def names(self) -> list[str]:
        return [param.name for param in self.params]


def functions_from_json(body: Any) -> list[Function]:
    """The functions of a lookup: ``{"functions": [...]}``."""
    functions = body.get("functions") if isinstance(body, dict) else None
    if not isinstance(functions, list) or len(functions) > MAX_FUNCTIONS:
        raise InvalidRequest(f"the body needs a list of at most {MAX_FUNCTIONS} functions")
    return [Function.from_json(item) for item in functions]


def _entry(store: dict[str, Any], function: Function) -> Any:
    """The kept answer for a function of one version of its library, asked with the prompt of today; None for an older prompt's."""
    libraries = store.get("libraries")
    versions = libraries.get(function.library) if isinstance(libraries, dict) else None
    functions = versions.get(function.version or "") if isinstance(versions, dict) else None
    entry = functions.get(function.function) if isinstance(functions, dict) else None
    # An answer kept before the prompt had a version came from version 1.
    if isinstance(entry, dict) and entry.get("prompt", 1) != PROMPT_VERSION:
        return None
    return entry


def kept(functions: list[Function]) -> list[dict[str, Any]]:
    """The answers kept for these functions, without a model: each with its function, library and version, picks and model."""
    store = read_json(store_path())
    found = []
    for function in functions:
        entry = _entry(store, function)
        if not isinstance(entry, dict):
            continue
        picks = usable(entry.get("picks"), function)
        if picks is None:
            continue
        found.append({"function": function.function, "library": function.library, "version": function.version, "picks": picks, "by": entry.get("by")})
    return found


def keep(function: Function, picks: list[dict[str, str]], by: dict[str, Any]) -> None:
    """Keep a model's answer for a function of one version of its library."""
    with _lock:
        store = read_json(store_path())
        libraries = store["libraries"] if isinstance(store.get("libraries"), dict) else {}
        if not isinstance(libraries.get(function.library), dict):
            libraries[function.library] = {}
        versions = libraries[function.library]
        if not isinstance(versions.get(function.version or ""), dict):
            versions[function.version or ""] = {}
        versions[function.version or ""][function.function] = {"picks": picks, "by": by, "params": function.names, "prompt": PROMPT_VERSION}
        write_private(store_path(), {"version": 1, "libraries": libraries})


SYSTEM_PROMPT = """\
You read the signature of one function of a library, which a cell of an analyst's notebook
calls. "language" names the language of the library, Python or R. Each parameter listed has a
default. A call that does not pass a parameter runs with its default: a value that nobody chose
on purpose.

The view shows each pick as a chip beside the cell, for the analyst to see and to change. Pick a
parameter only when its default can change a number in the result, the outcome of a test, or
which rows are used, and an analyst would want to see it as a chip: which rows are kept or
dropped, how missing values count, which estimate, test or interval is computed, how values are
read, matched or converted, and what is random.

Never pick a parameter that only names, orders, formats or copies: labels, titles, names of
columns or of an index, the order of rows, the number of digits, printing, copying, updating in
place, resetting an index, threads or speed.

Most functions have no such parameter. Picking none is a good answer, and so is a short list: pick
at most 3, and only parameters that you would be sure to show.

Put the picks in order: the parameter whose default most often changes a result comes first.

"why" says in at most 20 words what the default does to the result, for a note beside the value,
such as "Rows whose key is missing are left out of the groups." Do not repeat the parameter's
name.

A parameter without a default value holds data: its value stays on the analyst's machine.

Answer once, with one JSON object whose one key is "picks": a list of objects, each with
"param", a name from the list of parameters, and "why". Never send one pick on its own."""

SCHEMA = {
    "type": "object",
    "properties": {
        "picks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"param": {"type": "string"}, "why": {"type": "string"}},
                "required": ["param", "why"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["picks"],
    "additionalProperties": False,
}


def local_schema(function: Function) -> dict[str, Any]:
    """The grammar of a local model's answer: names from the signature, and a reason of at most 20 words."""
    word = local_models.WORD
    return {
        "type": "object",
        "properties": {
            "picks": {
                "type": "array",
                "maxItems": MAX_PICKS,
                "items": {
                    "type": "object",
                    "properties": {
                        "param": {"type": "string", "enum": function.names or [""]},
                        "why": {"type": "string", "pattern": rf"^{word}( {word}){{0,19}}$"},
                    },
                    "required": ["param", "why"],
                },
            }
        },
        "required": ["picks"],
    }


def prompt_state(function: Function, keep_local: bool) -> dict[str, Any]:
    """What a model reads of a function: its names, its library's version, and its parameters with their defaults.

    With the data on this machine, a model elsewhere does not read the value
    of a default that holds data. A default that looks like a key is not in
    the function at all (Function.from_json).
    """
    params = []
    for param in function.params:
        item: dict[str, Any] = {"name": param.name}
        if param.default is not None and not (param.data and keep_local):
            item["default"] = param.default
        params.append(item)
    state = {
        "language": function.language,
        "function": function.name,
        "module": function.module,
        "library": function.library,
        "version": function.version,
        "parameters": params,
    }
    return {key: value for key, value in state.items() if value is not None}


def usable(picks: Any, function: Function) -> list[dict[str, str]] | None:
    """The picks of an answer that name a parameter of the signature, each once and at most MAX_PICKS.

    None when the answer holds no list, or when every pick names a parameter
    that the signature lacks: the model then answered about something else.
    An empty list is an answer: no default can change the result.
    """
    if not isinstance(picks, list):
        return None
    names = set(function.names)
    found: list[dict[str, str]] = []
    for pick in picks:
        if not isinstance(pick, dict):
            continue
        param = pick.get("param")
        why = " ".join(str(pick.get("why") or "").split())[:200]
        if param not in names or not why or any(item["param"] == param for item in found):
            continue
        found.append({"param": param, "why": why})
        if len(found) == MAX_PICKS:
            break
    if picks and not found:
        return None
    return found


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


NO_PICKS = "The AI model's answer named no parameter of the function."


async def _picked(events: AsyncIterator[dict[str, Any]], function: Function, choice: str, schema: dict[str, Any] | None) -> AsyncIterator[dict[str, Any]]:
    """The events of a model's answer, its result with the usable picks, which the server keeps."""
    async for event in events:
        if event["type"] == "result":
            output = event.pop("output", None)
            picks = None
            if schema is None or not claude.matches(output, schema):
                picks = usable(output.get("picks") if isinstance(output, dict) else None, function)
            if picks is None:
                # What the call cost stays with the error, so the view counts it.
                yield {"type": "error", "message": NO_PICKS, **{key: event[key] for key in ("cost_usd", "elapsed", "model") if key in event}}
                return
            by = {"choice": choice, "model": event.get("model"), **({"file": event["file"]} if event.get("file") else {}), "at": _now()}
            await asyncio.to_thread(keep, function, picks, by)
            event.update(picks=picks, by=by)
        yield event


async def model_picks(function: Function, config: Whybook, keep_local: bool = False) -> AsyncIterator[dict[str, Any]]:
    """Stream progress events, then a result event with the connected model's ``picks`` and ``by``."""
    prompt = json.dumps(prompt_state(function, keep_local), indent=1)
    events = connection.structured_call(prompt, schema=SCHEMA, system_prompt=SYSTEM_PROMPT, config=config, effort=config.question_effort)
    async for event in _picked(events, function, "remote", SCHEMA):
        yield event


async def local_picks(model_id: str, function: Function, threads: int, check: str = "fast") -> AsyncIterator[dict[str, Any]]:
    """Stream progress events, then a result event with a local model's ``picks``. A model on this machine reads every default."""
    events = local_models.ask_json(model_id, SYSTEM_PROMPT, prompt_state(function, keep_local=False), local_schema(function), 400, threads, "reading a signature", check)
    async for event in _picked(events, function, model_id, None):
        yield event


async def kept_answer(answer: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
    """An answer that the server kept, as the one event of a stream: ``kept`` says that no model was asked, and the view counts no call."""
    yield {"type": "result", "kept": True, **answer}
