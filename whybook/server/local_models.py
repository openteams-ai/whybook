"""Models that run in the Jupyter server, on the analyst's machine.

The view offers five local models (MODELS), and the analyst can add any other
GGUF model in the settings (customLocalModels): the view sends those to the
server (register_custom), and they show after the five. The five are chosen
again at each release, from the models that research/local-models.md
measures, for the target machine of research/local-hardware.md: a laptop with
16 GB, where about 4 GB go to the model and its cache, so a file of up to
about 3 GB.

- For the target laptop, the three best models in files of 2 to 3 GB:
  Ministral 3 3B, Gemma 4 E2B and Qwen3 4B.
- One step down, for machines with 8 GB: MiniCPM5 2B, a file of 1.6 GB that
  labels tables as well as the three.
- One step up, for machines with 24 GB or more: Gemma 4 E4B.

Qwen3.5 0.8B described 2 of 12 held-out tables right, and is no longer
offered.

They run through llama.cpp (llama-cpp-python) from GGUF files in the Hugging
Face cache. The server downloads a model only when the user presses Download
for it: for the five, only the file of MODELS at its commit, checked against
its SHA-256. Without huggingface_hub, a missing model shows the command that
fetches it.

A table's labels take two calls, the method that research/local-models.md
recommends ("description, then choose"): the first writes the description,
and the second picks one of the headlines that code writes from the table's
facts (table_facts.py), or none. With it, no model of the benchmark wrote a
headline that its table contradicts.

One model is loaded at a time, and one request runs at a time, in a worker
thread: a llama.cpp context is not safe to share between threads.

The same models can write more questions for a drop, sort a question that the
analyst types into its type (``classify``), as the Jev-style classifier of
research/local_predictors/jev_local.py does, and order offered questions
(``rank_questions``).
"""

from __future__ import annotations

import asyncio
import ctypes
import datetime
import functools
import hashlib
import importlib.metadata
import importlib.util
import json
import logging
import math
import mmap
import os
import re
import shutil
import struct
import threading
import time
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, AsyncIterator

from . import cell_titles, table_facts

log = logging.getLogger(__name__)

# Word counts in the grammar, as research/local_models/patterns.py found:
# asked in words for "one to three words", a small model writes a sentence.
WORD = r'[^ "\\\n\r\t]{1,20}'
DESCRIPTION = r"^[a-z0-9][a-z0-9-]{0,15}( [a-z0-9][a-z0-9-]{0,15}){0,2}$"
HEADLINE = rf"^({WORD}( {WORD}){{0,3}})?$"
LABEL_SCHEMA = {
    "type": "object",
    "properties": {"description": {"type": "string", "pattern": DESCRIPTION}, "headline": {"type": "string", "pattern": HEADLINE}},
    "required": ["description", "headline"],
}

LABEL_PROMPT = """\
You label tables in a data analysis notebook. Each table shows as a small
tile, and your labels are all that the reader sees of it. Give:
"description": what the table holds, in one to three lower-case words, such as
"hourly sensor readings" or "orders by region";
"headline": the one result a reader should see first, in at most four words,
such as "2 outliers" or "sales peak in May". Leave it
empty when the table is raw data or no result stands out. Read the numbers
before you write it: the headline must be true of the table shown.
Answer with one JSON object with the keys "description" and "headline"."""

# The first call of a label stops once the description is written: the
# description comes first in its JSON, so greedy decoding writes the one that
# the whole answer would have, without the cost of a headline that is not used.
LABEL_STOP = ['"headline"']
DESCRIPTION_TEXT = re.compile(r'"description"\s*:\s*"((?:[^"\\]|\\.)*)"')

# The second call: a turn appended to the conversation of the first, whose
# system prompt already says what a headline is.
FOLLOW_CHOOSE = """\
Code wrote these candidate headlines from exact facts of the whole table:
{candidates}
Now give "headline": the one candidate that a reader should see first, word
for word, or empty when the table is raw data or no candidate states a result
worth showing. Answer with one JSON object with the key "headline"."""


def choose_schema(candidates: list[str]) -> dict[str, Any]:
    """The grammar of the second call: one of the candidates, or none."""
    return {"type": "object", "properties": {"headline": {"type": "string", "enum": [*candidates, ""]}}, "required": ["headline"]}


FRAME_PROMPT = """\
You summarise one data frame of a data analysis notebook for an analyst who
has many of them. Give "summary": one sentence of at most 25 words that says
what one row is and what the frame holds. Use only what the name, the size and
the columns show. Answer with one JSON object with the key "summary"."""
SUMMARY = rf"^{WORD}( {WORD}){{0,29}}$"
FRAME_SCHEMA = {
    "type": "object",
    "properties": {"summary": {"type": "string", "pattern": SUMMARY}},
    "required": ["summary"],
}

TITLE_PROMPT = """\
You write the title of one code cell of a data analysis notebook, as an analyst
writes it over the cell. Give "title": at most 8 words that name what the cell
makes or asks, in sentence case and without a full stop. Write a noun phrase or
a question, not an instruction: "Weekly pain per patient, by arm", not
"Calculate weekly pain"; "Mixed model: does arm change the trajectory?", not
"Fit a mixed model". Name the data and the result, not the functions. When the
current title still says what the code does, give it back unchanged. Answer
with one JSON object with the key "title"."""
TITLE = rf"^{WORD}( {WORD}){{0,9}}$"
TITLE_SCHEMA = {
    "type": "object",
    "properties": {"title": {"type": "string", "pattern": TITLE}},
    "required": ["title"],
}

# Where a model stands among the five: the three best for the target laptop,
# one step down and one step up. A model of the settings is "custom".
TIERS = ("recommended", "smaller", "larger", "custom")


@dataclass(frozen=True)
class LocalModel:
    id: str
    label: str
    repo: str
    file: str
    # None for a model of the settings whose file is not on the machine yet.
    size_mb: int | None
    note: str
    tier: str = "recommended"
    # The commit of the repository and the SHA-256 of the file: the download
    # takes that commit, and deletes a file whose SHA-256 differs.
    revision: str | None = None
    sha256: str | None = None
    # A chat template that thinks unless told otherwise is rendered with
    # enable_thinking=False, as the benchmark ran it. The grammar allows no
    # thinking block, and False is the template's own way to answer without one.
    thinking_off: bool = False
    # A GGUF file on this machine, for a model of the settings, in place of a repository.
    path: str | None = None


# The notes give the labels measured with the method of label(), over the 20
# test tables and the 12 held-out tables of research/local-models.md, graded
# by hand and blind to the model by Claude Opus 5.5; and the median time of a
# table on the test machine's 4 CPU threads.
MODELS = {
    model.id: model
    for model in [
        LocalModel(
            "ministral-3-3b",
            "Ministral 3 3B",
            "mistralai/Ministral-3-3B-Instruct-2512-GGUF",
            "Ministral-3-3B-Instruct-2512-Q4_K_M.gguf",
            2147,
            "descriptions right for 28 of 32 test tables, headlines for 26, none false; about 25 s a table on 4 CPU threads;"
            " the server keeps a copy of its file, 2.1 GB more, that llama-cpp-python 0.3.35 can read",
            revision="eb599d408350ea2bb60452cb86be7c7b2fc28227",
            sha256="9ed150d4367e68df0ac8e1540f6ddc65b42d0ee26378329d1ecbca60f93fc5f8",
        ),
        LocalModel(
            "gemma-4-e2b",
            "Gemma 4 E2B",
            "ggml-org/gemma-4-E2B-it-GGUF",
            "gemma-4-E2B-it-Q4_0.gguf",
            2841,
            "descriptions right for 25 of 32 test tables, headlines for 25, none false; about 10 s a table on 4 CPU threads",
            revision="b4243c156154b6dca9324415f8c7ccc098b4aed1",
            sha256="424921f1fc149888b7a368d73e95af5fea8c94c0e7d065711965e5fd50ac40ce",
        ),
        LocalModel(
            "qwen3-4b",
            "Qwen3 4B",
            "Qwen/Qwen3-4B-GGUF",
            "Qwen3-4B-Q4_K_M.gguf",
            2497,
            "descriptions right for 24 of 32 test tables, headlines for 24, none false; about 22 s a table on 4 CPU threads",
            revision="bc640142c66e1fdd12af0bd68f40445458f3869b",
            sha256="7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
            thinking_off=True,
        ),
        LocalModel(
            "minicpm5-2b",
            "MiniCPM5 2B",
            "openbmb/MiniCPM5-2B-GGUF",
            "MiniCPM5-2B-Q4_K_M.gguf",
            1561,
            "descriptions right for 25 of 32 test tables, headlines for 26, none false; about 9 s a table on 4 CPU threads",
            tier="smaller",
            revision="2079a22f3beaa4e306449978533478fe0522f4b3",
            sha256="ec2d5801640099e97d8d7e8003ad4d81f336e757811f03a26173dddf386602fd",
            thinking_off=True,
        ),
        LocalModel(
            "gemma-4-e4b",
            "Gemma 4 E4B",
            "ggml-org/gemma-4-E4B-it-GGUF",
            "gemma-4-E4B-it-Q4_0.gguf",
            4591,
            "descriptions right for 31 of 32 test tables, headlines for 26, none false; about 50 s a table on 4 CPU threads",
            tier="larger",
            revision="b8093469224f83f5c38f691eb906c380e9e63114",
            sha256="a555b900214b477d8880e7832e0b8925e139b0159640036b09fe472b6f2097f2",
        ),
    ]
}

# The models of the settings, by id, as the view last sent them.
CUSTOM: dict[str, LocalModel] = {}
MAX_CUSTOM = 20
REPO = re.compile(r"^[A-Za-z0-9][\w.-]*/[\w.-]+$")
FILE = re.compile(r"^[\w.-]+(/[\w.-]+)*\.gguf$")
REVISION = re.compile(r"^[\w.-]{1,64}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")


class LocalModelError(Exception):
    pass


def custom_id(name: str) -> str:
    """The id of a model of the settings, from its name: src/model/models.ts computes the same."""
    slug = re.sub(r"[^a-z0-9.]+", "-", name.lower()).strip("-")[:40]
    return f"custom:{slug or 'model'}"


def custom_model(spec: Any) -> LocalModel:
    """A model of the settings, from what the analyst wrote there; raises LocalModelError."""
    if not isinstance(spec, dict):
        raise LocalModelError("a custom local model is an object with a name")
    name = " ".join(spec["name"].split()) if isinstance(spec.get("name"), str) else ""
    if not name or len(name) > 60:
        raise LocalModelError("a custom local model needs a name of at most 60 characters")
    note = " ".join(str(spec.get("note") or "").split())[:200] or "added in the settings; not measured"
    revision, sha256 = spec.get("revision") or None, (spec.get("sha256") or "").lower() or None
    if revision is not None and not (isinstance(revision, str) and REVISION.match(revision)):
        raise LocalModelError(f"{name}: the revision is a commit or a branch of the repository")
    if sha256 is not None and not SHA256.match(sha256):
        raise LocalModelError(f"{name}: the SHA-256 is 64 hexadecimal digits")
    if spec.get("path"):
        path = os.path.expanduser(str(spec["path"]))
        if not os.path.isabs(path) or not path.endswith(".gguf"):
            raise LocalModelError(f"{name}: the path is the absolute path of a .gguf file")
        size = round(os.path.getsize(path) / 1e6) if os.path.isfile(path) else None
        return LocalModel(custom_id(name), name, "", os.path.basename(path), size, note, "custom", None, sha256, True, path)
    repo, file = str(spec.get("repo") or ""), str(spec.get("file") or "")
    if not REPO.match(repo) or not FILE.match(file) or ".." in file:
        raise LocalModelError(f"{name}: give a Hugging Face repository and a .gguf file in it, or the path of a GGUF file")
    model = LocalModel(custom_id(name), name, repo, file, None, note, "custom", revision, sha256, True)
    path = model_path(model)
    return replace(model, size_mb=round(path.stat().st_size / 1e6)) if path else model


def register_custom(specs: Any) -> list[str]:
    """Take the models of the settings in place of the ones before; the problems of those left out."""
    models: dict[str, LocalModel] = {}
    problems = []
    for spec in (specs if isinstance(specs, list) else [])[:MAX_CUSTOM]:
        try:
            model = custom_model(spec)
        except LocalModelError as error:
            problems.append(str(error))
            continue
        # Two names with one id take the next free number, as models.ts does.
        model_id, number = model.id, 2
        while model_id in models:
            model_id, number = f"{model.id}-{number}", number + 1
        models[model_id] = replace(model, id=model_id)
    CUSTOM.clear()
    CUSTOM.update(models)
    return problems


# Models of other tasks that a download and a lookup find, and the lists of
# the tasks do not show: the guard models of guard/models.py.
EXTRA: dict[str, LocalModel] = {}


def model_of(model_id: Any, spec: Any = None) -> LocalModel | None:
    """The local model of an id, or None. A request for a model of the settings
    carries its spec, so the model runs after the server restarts; raises
    LocalModelError for a spec that is wrong."""
    if not isinstance(model_id, str):
        return None
    if model_id in MODELS:
        return MODELS[model_id]
    if model_id in EXTRA:
        return EXTRA[model_id]
    if model_id.startswith("custom:") and spec is not None:
        CUSTOM[model_id] = replace(custom_model(spec), id=model_id)
    return CUSTOM.get(model_id)


def all_models() -> list[LocalModel]:
    return [*MODELS.values(), *CUSTOM.values()]


def file_of(model: LocalModel) -> str:
    """The model's file as its repository and file name, which the view keeps with what the model wrote."""
    return model.path or f"{model.repo}/{model.file}"


def hub_cache() -> Path:
    """Where Hugging Face keeps its downloads, as huggingface_hub finds it."""
    if os.environ.get("HF_HUB_CACHE"):
        return Path(os.environ["HF_HUB_CACHE"])
    if os.environ.get("HF_HOME"):
        return Path(os.environ["HF_HOME"]) / "hub"
    return Path.home() / ".cache" / "huggingface" / "hub"


def copies_dir() -> Path:
    """Where the server keeps the copies of model files that it rewrites: see readable_path."""
    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "whybook" / "models"


def model_path(model: LocalModel) -> Path | None:
    """The model's file on this machine, or None: from its pinned commit first, then from any other."""
    if model.path:
        path = Path(model.path)
        return path if path.is_file() else None
    snapshots = hub_cache() / ("models--" + model.repo.replace("/", "--")) / "snapshots"
    names = ([model.revision] if model.revision else []) + [snapshot.name for snapshot in sorted(snapshots.glob("*"), reverse=True)]
    for name in names:
        candidate = snapshots / name / model.file
        if candidate.exists():
            return candidate
    return None


def runtime_available() -> bool:
    # Checked without importing: llama_cpp loads its shared library on import.
    return importlib.util.find_spec("llama_cpp") is not None


def hub_available() -> bool:
    return importlib.util.find_spec("huggingface_hub") is not None


def fetch_command(model: LocalModel) -> str:
    """The command that fetches a model's file."""
    return f"hf download {model.repo} {model.file}" + (f" --revision {model.revision}" if model.revision else "")


def status(models: list[LocalModel] | None = None) -> list[dict[str, Any]]:
    """The local models the view can offer, each with the reason it cannot run, if any.

    A model whose download runs is not available until its file is checked,
    and the view does not offer to download it again.
    """
    entries = []
    for model in all_models() if models is None else models:
        job = DOWNLOADS.get(model.id)
        running = job is not None and not job.done()
        missing = running or model_path(model) is None
        reason = None
        if not runtime_available():
            reason = "llama-cpp-python is not installed: pip install 'whybook[local]'"
        elif running:
            reason = job.reason
        elif missing and job is not None and job.error:
            reason = f"the last download failed: {job.error}"
        elif missing:
            reason = f"no file at {model.path}" if model.path else f"not downloaded: {fetch_command(model)}"
        entries.append(
            {
                "id": model.id,
                "label": model.label,
                "kind": "local",
                "tier": model.tier,
                "size_mb": model.size_mb,
                "note": model.note,
                "repo": model.repo or None,
                "path": model.path,
                "available": reason is None,
                "reason": reason,
                "downloadable": missing and not running and not model.path and hub_available(),
            }
        )
    return entries


# The GGUF value types, and the size in bytes of each, strings and arrays apart.
_GGUF_SIZES = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}
_GGUF_STRING, _GGUF_ARRAY, _GGUF_INT32, _GGUF_FLOAT32 = 8, 9, 5, 6


def _gguf_string(buf: Any, offset: int) -> tuple[str, int]:
    (length,) = struct.unpack_from("<Q", buf, offset)
    return bytes(buf[offset + 8 : offset + 8 + length]).decode("utf-8", "replace"), offset + 8 + length


def _gguf_after(buf: Any, offset: int, kind: int) -> int:
    if kind == _GGUF_STRING:
        return _gguf_string(buf, offset)[1]
    if kind == _GGUF_ARRAY:
        element, count = struct.unpack_from("<IQ", buf, offset)
        offset += 12
        if element == _GGUF_STRING:
            for _ in range(count):
                offset = _gguf_string(buf, offset)[1]
            return offset
        return offset + _GGUF_SIZES[element] * count
    return offset + _GGUF_SIZES[kind]


def _scores_at(buf: Any) -> tuple[int, int, int] | None:
    """Where the token scores of a GGUF header are: the offset of their array, its element type and count."""
    if bytes(buf[:4]) != b"GGUF":
        return None
    _, _, pairs = struct.unpack_from("<IQQ", buf, 4)
    offset = 24
    for _ in range(pairs):
        key, offset = _gguf_string(buf, offset)
        (kind,) = struct.unpack_from("<I", buf, offset)
        offset += 4
        if key == "tokenizer.ggml.scores" and kind == _GGUF_ARRAY:
            element, count = struct.unpack_from("<IQ", buf, offset)
            return offset, element, count
        offset = _gguf_after(buf, offset, kind)
    return None


def _int_scores(path: Path) -> bool:
    """Whether the file stores its token scores as 32-bit integers, as Mistral AI's Ministral 3 files do."""
    try:
        with open(path, "rb") as handle, mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as buf:
            found = _scores_at(buf)
    except (OSError, ValueError, KeyError, struct.error):
        return False
    return found is not None and found[1] == _GGUF_INT32


def readable_path(path: Path) -> Path:
    """The file for llama.cpp: ``path``, or a copy with its token scores as 32-bit floats.

    The llama.cpp of llama-cpp-python 0.3.35 (4df29be4) refuses integer scores:
    it came after ggml-org/llama.cpp#27075, and before #27260 read them again.
    Both types take 4 bytes, so the copy keeps the layout of the file, and a
    float holds each score exactly (research/local-models.md, "Models of 3B to
    12B", and research/local_models/patch_scores.py).
    """
    if not _int_scores(path):
        return path
    real = Path(os.path.realpath(path))
    copy = copies_dir() / f"{hashlib.sha256(str(real).encode()).hexdigest()[:12]}-{real.stem}.scores-f32.gguf"
    if copy.exists():
        return copy
    copy.parent.mkdir(parents=True, exist_ok=True)
    partial = copy.with_suffix(".partial")
    try:
        shutil.copyfile(real, partial)
        with open(partial, "r+b") as handle, mmap.mmap(handle.fileno(), 0) as buf:
            offset, _, count = _scores_at(buf)
            values = struct.unpack_from(f"<{count}i", buf, offset + 12)
            if values and max(abs(value) for value in values) > 2**24:
                raise LocalModelError(f"{path.name} has a token score too large for a float to hold exactly")
            struct.pack_into("<I", buf, offset, _GGUF_FLOAT32)
            struct.pack_into(f"<{count}f", buf, offset + 12, *(float(value) for value in values))
            buf.flush()
        partial.replace(copy)
    except BaseException:
        # A copy is as large as the model: 2.1 GB for Ministral 3.
        partial.unlink(missing_ok=True)
        raise
    return copy


# One model is loaded, and one request runs, at a time. A request of several
# items (_each) holds the lock for all of them, so that two tasks on two
# models do not load a model for each answer; the calls of one item take it
# again in the same thread.
_lock = threading.RLock()
_loaded: tuple[str, Any] | None = None
# The state after the part of the classifier's prompt that every question shares.
_saved: dict[tuple[str, tuple[int, ...]], bytes] = {}


def _thinking_off(llm: Any) -> None:
    """Render the model's own chat template with enable_thinking=False.

    llama-cpp-python 0.3.35 renders the template of the GGUF file with a fixed
    set of variables (llama_chat_format.Jinja2ChatFormatter), and
    create_chat_completion passes it no others. This handler is the one that
    Llama builds from the template, with one variable more, as
    research/local_models/bench.py (thinking_off) ran the benchmark.
    """
    if getattr(llm, "chat_format", None) != "chat_template.default":
        return
    from llama_cpp.llama_chat_format import Jinja2ChatFormatter

    class Formatter(Jinja2ChatFormatter):
        def __call__(self, **kwargs: Any) -> Any:
            return super().__call__(enable_thinking=False, **kwargs)

    eos, bos = llm.token_eos(), llm.token_bos()
    llm.chat_handler = Formatter(
        template=llm.metadata["tokenizer.chat_template"],
        eos_token=llm._model.token_get_text(eos) if eos != -1 else "",
        bos_token=llm._model.token_get_text(bos) if bos != -1 else "",
        stop_token_ids=[eos],
    ).to_chat_handler()


def _llm(model: LocalModel, threads: int) -> Any:
    """The loaded model, loading it and freeing the one before when it is another."""
    global _loaded
    if _loaded is not None and _loaded[0] == model.id:
        return _loaded[1]
    path = model_path(model)
    job = DOWNLOADS.get(model.id)
    if job is not None and not job.done():
        # Its file may be there, not yet checked against its SHA-256.
        raise LocalModelError(f"{model.label} is still downloading: try again when it is done")
    if path is None:
        raise LocalModelError(f"{model.label} has no file at {model.path}" if model.path else f"{model.label} is not downloaded: {fetch_command(model)}")
    from llama_cpp import Llama

    _unload()
    llm = Llama(model_path=str(readable_path(path)), n_ctx=4096, n_threads=threads, n_threads_batch=threads, n_batch=512, verbose=False)
    if model.thinking_off:
        _thinking_off(llm)
    _install_fast_check(llm)
    _loaded = (model.id, llm)
    return llm


def _unload() -> None:
    """Free the loaded model, so that the next request loads it again."""
    global _loaded
    if _loaded is not None:
        close = getattr(_loaded[1], "close", None)
        _loaded = None
        if close is not None:
            close()
    _saved.clear()


def words(text: Any, limit: int) -> str:
    """The first ``limit`` words of ``text``, on one line: a description. A headline is never cut (table_facts.headline)."""
    return " ".join(str(text or "").split()[:limit])[:48]


# How a local model's answer is held to its JSON rules, a grammar. With
# "standard", llama-cpp-python checks every token of the vocabulary against
# the grammar before it picks one: 262,144 tokens for Gemma 4 E2B. With
# "fast", the grammar is asked about the picked token alone, and the whole
# vocabulary is checked only when the grammar refuses that token, as
# llama.cpp's own sampler does. With greedy decoding both pick the same
# tokens; "fast" cut Gemma's time per label from 1.95 to 1.28 s
# (research/local-models.md, "The grammar's time").
JSON_CHECKS = ("fast", "standard")
# "fast" replaces a part of llama-cpp-python's sampling that is not public
# API. It was measured with this version.
FAST_CHECK_TESTED = "0.3.35"
# What "fast" uses of llama_cpp beyond Llama.
_FAST_NEEDS = (
    "llama_get_logits_ith",
    "llama_sampler_accept",
    "llama_sampler_apply",
    "llama_sampler_free",
    "llama_sampler_init_grammar",
    "llama_token_data",
    "llama_token_data_array",
    "llama_token_data_p",
)
# Why "fast" failed in this process, if it did: the server then uses
# "standard" until it restarts.
_fast_failure: str | None = None


class _CheckFirst:
    """Greedy sampling that asks the grammar about the picked token first.

    research/local_models/fastgrammar.py, where it was measured. It stands in
    for the sampler that Llama._init_sampler builds, and Llama.sample calls
    ``sample(ctx, idx)`` for each token.
    """

    def __init__(self, llm: Any, grammar: Any) -> None:
        import llama_cpp
        import numpy as np

        self.counts = llm.whybook_fast_counts
        self.n_vocab = llm.n_vocab()
        # Kept for __del__, which may run while Python shuts down and can no longer import.
        self._free = llama_cpp.llama_sampler_free
        self.grammar = llama_cpp.llama_sampler_init_grammar(
            llm._model.vocab, grammar._grammar.encode("utf-8"), grammar._root.encode("utf-8")
        )
        if not self.grammar:
            raise LocalModelError("llama.cpp could not build the grammar")
        self.one = (llama_cpp.llama_token_data * 1)()
        self.full = (llama_cpp.llama_token_data * self.n_vocab)()
        self.view = np.ctypeslib.as_array(self.full)
        self.ids = np.arange(self.n_vocab, dtype=np.int32)

    def _apply(self, data: Any, size: int) -> None:
        import llama_cpp

        cur = llama_cpp.llama_token_data_array(data=ctypes.cast(data, llama_cpp.llama_token_data_p), size=size, selected=-1, sorted=False)
        llama_cpp.llama_sampler_apply(self.grammar, ctypes.byref(cur))

    def sample(self, ctx: Any, idx: int = -1) -> int:
        import llama_cpp
        import numpy as np

        logits = np.ctypeslib.as_array(llama_cpp.llama_get_logits_ith(ctx.ctx, idx), shape=(self.n_vocab,))
        token = int(np.argmax(logits))
        self.one[0].id, self.one[0].logit, self.one[0].p = token, float(logits[token]), 0.0
        self._apply(self.one, 1)
        self.counts["checked"] += 1
        if self.one[0].logit == -np.inf:
            self.counts["refused"] += 1
            self.view["id"] = self.ids
            self.view["logit"] = logits
            self.view["p"] = 0.0
            self._apply(self.full, self.n_vocab)
            token = int(self.view["id"][np.argmax(self.view["logit"])])
        llama_cpp.llama_sampler_accept(self.grammar, token)
        return token

    def __del__(self) -> None:
        if getattr(self, "grammar", None):
            self._free(self.grammar)
            self.grammar = None


def _llama_cpp_version() -> str:
    try:
        return importlib.metadata.version("llama_cpp_python")
    except importlib.metadata.PackageNotFoundError:
        return "unknown"


def _fast_failed(problem: str) -> None:
    global _fast_failure
    _fast_failure = f"{problem}, with llama-cpp-python {_llama_cpp_version()} (measured with {FAST_CHECK_TESTED})"


def fast_check_warning() -> str | None:
    """Why local models use the standard JSON check where the settings chose the fast one, if they do."""
    if _fast_failure is None:
        return None
    return f"The fast JSON check failed: {_fast_failure}. Local models use the standard check, which gives the same answers more slowly."


def _install_fast_check(llm: Any) -> None:
    """Let greedy calls with a grammar sample through _CheckFirst while ``llm.whybook_fast`` is set."""
    import llama_cpp

    llm.whybook_fast = False
    llm.whybook_fast_counts = {"checked": 0, "refused": 0}
    missing = [name for name in _FAST_NEEDS if not hasattr(llama_cpp, name)]
    original = getattr(llm, "_init_sampler", None)
    if not callable(original):
        missing.append("Llama._init_sampler")
    if missing:
        if _fast_failure is None:
            _fast_failed(f"llama_cpp has no {', '.join(missing)}")
        return

    def init_sampler(*args: Any, **kwargs: Any) -> Any:
        if (
            llm.whybook_fast
            and not args
            and kwargs.get("grammar") is not None
            and kwargs.get("temp") == 0.0
            and kwargs.get("logits_processor") is None
            and kwargs.get("repeat_penalty", 1.0) == 1.0
        ):
            return _CheckFirst(llm, kwargs["grammar"])
        return original(*args, **kwargs)

    llm._init_sampler = init_sampler


def _generate(llm: Any, messages: list[dict[str, str]], schema: dict[str, Any], max_tokens: int, fast: bool, stop: list[str] | None = None) -> str:
    llm.whybook_fast = fast
    extra = {"stop": stop} if stop else {}
    try:
        out = llm.create_chat_completion(
            messages=messages, response_format={"type": "json_object", "schema": schema}, temperature=0.0, max_tokens=max_tokens, **extra
        )
    finally:
        llm.whybook_fast = False
    return out["choices"][0]["message"]["content"] or "{}"


def _read(model: LocalModel, text: str, read: Any) -> dict[str, Any]:
    try:
        return read(text)
    except ValueError as error:
        raise LocalModelError(f"{model.label} did not answer with JSON: {error}") from error


def _description_of(text: str) -> dict[str, Any]:
    """The description of an answer that stopped before its headline: '{"description": "orders by region", '."""
    found = DESCRIPTION_TEXT.search(text)
    if found is None:
        raise ValueError(f"no description in {text[:60]!r}")
    return {"description": json.loads(f'"{found.group(1)}"')}


def _answer(
    model: LocalModel,
    messages: list[dict[str, str]],
    schema: dict[str, Any],
    max_tokens: int,
    threads: int,
    check: str = "fast",
    stop: list[str] | None = None,
    read: Any = json.loads,
) -> dict[str, Any]:
    """The model's answer to one request, held to ``schema`` by a grammar, as ``read`` reads it.

    When the fast check raises, or writes an answer that ``read`` refuses, the
    request runs again with the standard check. If that one works, the fast
    check is off until the server restarts, and fast_check_warning() says why.
    """
    with _lock:
        llm = _llm(model, threads)
        if check != "fast" or _fast_failure is not None:
            return _read(model, _generate(llm, messages, schema, max_tokens, False, stop), read)
        counts = llm.whybook_fast_counts
        checked = counts["checked"]
        try:
            text = _generate(llm, messages, schema, max_tokens, True, stop)
        except Exception as error:  # noqa: BLE001  any failure of the fast check falls back
            problem = f"{type(error).__name__}: {error}"
            # The failure may leave the model's context in any state.
            _unload()
            llm = _llm(model, threads)
        else:
            if counts["checked"] == checked:
                # llama-cpp-python did not sample through the fast check, so
                # this answer came from the standard one.
                _fast_failed("llama-cpp-python did not call it")
                return _read(model, text, read)
            try:
                return read(text)
            except ValueError:
                problem = "its answer was not JSON"
        value = _read(model, _generate(llm, messages, schema, max_tokens, False, stop), read)
        # The standard check worked where the fast one did not.
        _fast_failed(problem)
        return value


def _complete(
    model: LocalModel, system: str, user: Any, schema: dict[str, Any], max_tokens: int, threads: int, check: str = "fast"
) -> dict[str, Any]:
    """The model's JSON answer to a system prompt and one message."""
    messages = [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(user, indent=1)}]
    return _answer(model, messages, schema, max_tokens, threads, check)


def label(model: LocalModel, table: dict[str, Any], threads: int, check: str = "fast") -> dict[str, str]:
    """A description and a headline for one table, in two calls: "description, then choose".

    The first call is the prompt that table_notes.py gives Claude, stopped once
    the description is written. The second asks, in the same conversation, for
    one of the headlines that table_facts.candidates() writes, or none: the
    grammar allows nothing else. With no candidate, the headline stays empty
    and there is no second call. The second call starts with the tokens of the
    first, and llama-cpp-python evaluates only what follows them.
    """
    user = {"code": table["code"][-600:], "table": table["table"][:1500], "rows": table["rows"], "columns": table["columns"]}
    messages = [{"role": "system", "content": LABEL_PROMPT}, {"role": "user", "content": json.dumps(user, indent=1)}]
    description = str(_answer(model, messages, LABEL_SCHEMA, 48, threads, check, stop=LABEL_STOP, read=_description_of)["description"])
    try:
        info = table_facts.table_facts({"text": table["table"], "code": table["code"], "rows": table["rows"], "columns": table["columns"]})
        # Each candidate shows whole on the tile, or is not offered.
        candidates = [text for text in table_facts.candidates(info) if table_facts.headline(text) == text]
    except Exception:  # noqa: BLE001  a table that the facts code cannot read keeps its description, with no headline
        log.warning("no facts for table %s", table["id"], exc_info=True)
        candidates = []
    headline = ""
    if candidates:
        follow = [
            *messages,
            {"role": "assistant", "content": json.dumps({"description": description})},
            {"role": "user", "content": FOLLOW_CHOOSE.format(candidates="\n".join(json.dumps(text, ensure_ascii=False) for text in candidates))},
        ]
        chosen = str(_answer(model, follow, choose_schema(candidates), 64, threads, check).get("headline") or "")
        headline = chosen if chosen in candidates else ""
    return {"id": table["id"], "description": words(description, 3), "headline": table_facts.headline(headline)}


def summarise(model: LocalModel, frame: dict[str, Any], threads: int, check: str = "fast") -> dict[str, str]:
    """A summary of one sentence for one data frame, as frame_notes.py asks Claude for it."""
    user = {key: frame[key] for key in ("name", "rows", "columns", "first_columns")}
    value = _complete(model, FRAME_PROMPT, user, FRAME_SCHEMA, 64, threads, check)
    return {"id": frame["id"], "summary": " ".join(str(value.get("summary") or "").split()[:30])}


def title(model: LocalModel, cell: dict[str, Any], threads: int, check: str = "fast") -> dict[str, str]:
    """A title of a few words for one code cell, as cell_titles.py asks Claude for it."""
    user = {"code": cell["code"][:1500], "current_title": cell["title"]}
    value = _complete(model, TITLE_PROMPT, user, TITLE_SCHEMA, 48, threads, check)
    return {"id": cell["id"], "title": cell_titles.title_of(value.get("title"))}


def _chat(llm: Any, system: str, user: str) -> str:
    """The prompt as the model's own chat template writes it, ready for the answer."""
    import jinja2
    from jinja2.sandbox import ImmutableSandboxedEnvironment

    def fail(message: str) -> None:
        raise jinja2.exceptions.TemplateError(message)

    env = ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True, loader=jinja2.BaseLoader())
    env.globals["raise_exception"] = fail
    env.globals["strftime_now"] = lambda fmt: datetime.datetime.now().strftime(fmt)
    template = env.from_string(llm.metadata["tokenizer.chat_template"])
    bos = llm.detokenize([llm.token_bos()], special=True).decode() if llm.token_bos() >= 0 else ""
    eos = llm.detokenize([llm.token_eos()], special=True).decode()
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    return template.render(messages=messages, add_generation_prompt=True, enable_thinking=False, bos_token=bos, eos_token=eos)


def _tokens(llm: Any, text: str) -> list[int]:
    return llm.tokenize(text.encode(), add_bos=False, special=True)


def _letter_scores(llm: Any, model: LocalModel, prompt: str, body: str, letters: str, cache: dict) -> list[float]:
    """The logit of each letter where the answer of a prompt that ends in "Answer: (" starts.

    Nothing is generated. The part of the prompt before ``body`` is kept in
    ``cache`` after its first evaluation and restored after that: Qwen3.5
    (partly recurrent) and Gemma 4 (sliding window) cannot cut a cache back.
    Call it with the lock held; it leaves the context empty.
    """
    import llama_cpp

    tokens = _tokens(llm, prompt)
    shared = _tokens(llm, prompt[: prompt.index(body)])
    if tokens[: len(shared)] != shared:
        shared = []
    ctx = llm._ctx.ctx
    memory = llama_cpp.llama_get_memory(ctx)
    llama_cpp.llama_memory_clear(memory, True)
    llm.n_tokens = 0
    key = (model.id, tuple(shared))
    if shared and key in cache:
        data = cache[key]
        buffer = (ctypes.c_uint8 * len(data)).from_buffer_copy(data)
        llama_cpp.llama_state_seq_set_data(ctx, buffer, len(data), 0)
        llm.input_ids[: len(shared)] = shared
        llm.n_tokens = len(shared)
    elif shared:
        llm.eval(shared)
        size = llama_cpp.llama_state_seq_get_size(ctx, 0)
        buffer = (ctypes.c_uint8 * size)()
        written = llama_cpp.llama_state_seq_get_data(ctx, buffer, size, 0)
        cache[key] = bytes(buffer[:written])
    llm.eval(tokens[llm.n_tokens :])
    logits = llm._ctx.get_logits()
    scores = []
    for letter in letters:
        whole = _tokens(llm, prompt + letter)
        rest = whole[len(tokens) :] if whole[: len(tokens)] == tokens else _tokens(llm, letter)
        scores.append(float(logits[rest[0]]))
    # The next request starts from an empty context, as create_chat_completion expects.
    llama_cpp.llama_memory_clear(memory, True)
    llm.n_tokens = 0
    return scores


def _softmax(scores: list[float]) -> list[float]:
    top = max(scores)
    weights = [math.exp(score - top) for score in scores]
    total = sum(weights)
    return [weight / total for weight in weights]


def classify(model: LocalModel, text: str, threads: int) -> dict[str, Any]:
    """The probability of each type of a typed question, read where the answer starts.

    The prompt lists the types, each with a letter and a meaning, with one
    solved example per type, and ends with "Answer: (", so that the next token
    is a letter: the fewshot variant of research/local-predictors-2.md. The
    part of the prompt before the question is the same for every question,
    and its state is kept for the next one.
    """
    from .sorting import TYPE_EXAMPLES, TYPE_INSTRUCTION, TYPES

    names = list(TYPES)
    letters = "ABCDEFGH"[: len(names)]
    letter_of = dict(zip(names, letters))
    solved = "\n\n".join(f"Question: {question}\nAnswer: ({letter_of[kind]})" for question, kind in TYPE_EXAMPLES)
    system = f"Answer with the letter of one option.\n\nExamples of questions and their answers:\n\n{solved}"
    options = "\n".join(f"({letter}) {name}: {TYPES[name]}" for letter, name in zip(letters, names))
    body = f"Question: {' '.join(text.split())}"
    with _lock:
        llm = _llm(model, threads)
        prompt = _chat(llm, system, f"{TYPE_INSTRUCTION}\n{options}\n\n{body}") + "Answer: ("
        scores = _letter_scores(llm, model, prompt, body, letters, _saved)
    probabilities = {name: round(weight, 4) for name, weight in zip(names, _softmax(scores))}
    return {"type": {"choice": max(probabilities, key=probabilities.get), "probabilities": probabilities}, "place": None, "model": model.label}


RANK_INSTRUCTION = """\
A data analyst works in a notebook. The state of the analysis:
{state}

Which of these questions does the analyst ask next?
{options}"""
RANK_LETTERS = "ABCDEFGHIJKL"


def rank_questions(model: LocalModel, state: str, questions: list[str], threads: int) -> list[float]:
    """The probability that the analyst asks each question next, read where the answer starts.

    The questions come as lettered options after the state, and the prompt
    ends with "Answer: (", so that the next token is a letter: the "letters"
    variant of research/ranking-placement.md, "Language models as rankers". On
    60 drops rebuilt from public notebooks, Gemma 4 E2B then put first a
    question of the analyst's type for 45.0% of them, where one yes-or-no
    reading per question gave 30.0% and the rules 28.3%. The questions after
    the twelfth get 0.
    """
    shown = questions[: len(RANK_LETTERS)]
    if not shown:
        return []
    letters = RANK_LETTERS[: len(shown)]
    options = "\n".join(f"({letter}) {' '.join(text.split())}" for letter, text in zip(letters, shown))
    with _lock:
        llm = _llm(model, threads)
        prompt = _chat(llm, "Answer with the letter of one option.", RANK_INSTRUCTION.format(state=state, options=options)) + "Answer: ("
        scores = _letter_scores(llm, model, prompt, options, letters, {})
    return [round(weight, 4) for weight in _softmax(scores)] + [0.0] * (len(questions) - len(shown))


async def ask_rank(model_id: str, state: str, questions: list[str], threads: int) -> dict[str, Any]:
    """``rank_questions`` in a worker thread."""
    start = time.monotonic()
    model = model_of(model_id)
    if model is None:
        raise LocalModelError(f"no local model named {model_id}")
    if not runtime_available():
        raise LocalModelError("llama-cpp-python is not installed on the server")
    loop = asyncio.get_running_loop()
    probabilities = await loop.run_in_executor(None, rank_questions, model, state, questions, threads)
    return {"probabilities": probabilities, "model": model.label, "file": file_of(model), "elapsed": round(time.monotonic() - start, 2)}


async def ask_classify(model_id: str, text: str, threads: int) -> dict[str, Any]:
    """``classify`` in a worker thread."""
    start = time.monotonic()
    model = model_of(model_id)
    if model is None:
        raise LocalModelError(f"no local model named {model_id}")
    if not runtime_available():
        raise LocalModelError("llama-cpp-python is not installed on the server")
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, classify, model, text, threads)
    return {**result, "elapsed": round(time.monotonic() - start, 2)}


async def ask_json(
    model_id: str, system: str, user: Any, schema: dict[str, Any], max_tokens: int, threads: int, stage: str, check: str = "fast"
) -> AsyncIterator[dict[str, Any]]:
    """One JSON answer from a local model, with the events of claude.structured_call."""
    start = time.monotonic()
    model = model_of(model_id)
    if model is None:
        yield {"type": "error", "message": f"no local model named {model_id}"}
        return
    if not runtime_available():
        yield {"type": "error", "message": "llama-cpp-python is not installed on the server"}
        return
    yield {"type": "progress", "stage": stage, "elapsed": 0.0}
    loop = asyncio.get_running_loop()
    try:
        output = await loop.run_in_executor(None, _complete, model, system, user, schema, max_tokens, threads, check)
    except Exception as error:  # noqa: BLE001  the model's failure goes to the view
        yield {"type": "error", "message": str(error), "elapsed": round(time.monotonic() - start, 1)}
        return
    yield {"type": "result", "output": output, **_ran(model, check), "elapsed": round(time.monotonic() - start, 1)}


def _ran(model: LocalModel, check: str) -> dict[str, Any]:
    """What a result event says of the run: the model, its file, and a warning when the fast check fell back."""
    warning = fast_check_warning() if check == "fast" else None
    return {"model": model.label, "file": file_of(model), "cost_usd": 0.0, **({"warning": warning} if warning else {})}


def _partial_bytes(model: LocalModel) -> int:
    """How much of the model's file huggingface_hub has written so far."""
    blobs = hub_cache() / ("models--" + model.repo.replace("/", "--")) / "blobs"
    return sum(path.stat().st_size for path in blobs.glob("*.incomplete")) if blobs.exists() else 0


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while block := handle.read(8 << 20):
            digest.update(block)
    return digest.hexdigest()


def _checked(model: LocalModel, path: Path) -> None:
    """Delete a downloaded file whose SHA-256 is not the one of MODELS, and raise; prepare the one that is."""
    if model.sha256:
        found = _sha256(path)
        if found != model.sha256:
            real = Path(os.path.realpath(path))
            path.unlink(missing_ok=True)
            real.unlink(missing_ok=True)
            raise LocalModelError(f"the file has the SHA-256 {found}, not {model.sha256}, and was deleted")
    readable_path(path)


@dataclass
class Download:
    """The download of a model's file and its check, in one job of the server.

    A page reload closes the stream of the view that pressed Download, and
    the job goes on to the check. A check in that stream, after its last
    event, would leave an unchecked file on a reload, which the status would
    offer as available. The stream only reports the job, and the next status
    or download reads it.
    """

    model: LocalModel
    task: asyncio.Task | None = None
    # "downloading", then "checking": the stages, in order.
    stages: list[str] = field(default_factory=lambda: ["downloading"])
    total: int | None = None
    error: str | None = None
    finished: threading.Event = field(default_factory=threading.Event)

    @property
    def stage(self) -> str:
        return self.stages[-1]

    @property
    def reason(self) -> str:
        """Why the model cannot run yet, as the status says it."""
        return "downloading" if self.stage == "downloading" else "checking the download"

    def done(self) -> bool:
        return self.finished.is_set()

    def progress(self, stage: str, start: float) -> dict[str, Any]:
        done = _partial_bytes(self.model) if stage == "downloading" else 0
        fraction = min(done / self.total, 1.0) if stage == "downloading" and self.total else None
        return {"type": "progress", "stage": f"{stage} {self.model.label}", "progress": fraction, "elapsed": round(time.monotonic() - start, 1)}


# The downloads of this server, by model: the one that runs, or how the last one ended.
DOWNLOADS: dict[str, Download] = {}


async def _download_and_check(job: Download) -> None:
    """Fetch the file at its commit into the Hugging Face cache, then check it: the job, whoever reads its stream."""
    model = job.model
    try:
        from huggingface_hub import get_hf_file_metadata, hf_hub_download, hf_hub_url

        pinned = {"revision": model.revision} if model.revision else {}
        loop = asyncio.get_running_loop()
        try:
            metadata = await loop.run_in_executor(None, functools.partial(get_hf_file_metadata, hf_hub_url(model.repo, model.file, **pinned)))
            job.total = metadata.size
        except Exception:  # noqa: BLE001  the size only drives the progress bar
            job.total = model.size_mb * 1_000_000 if model.size_mb else None
        # huggingface_hub cannot be interrupted: the transfer runs on to its end in its thread.
        path = Path(await loop.run_in_executor(None, functools.partial(hf_hub_download, model.repo, model.file, cache_dir=str(hub_cache()), **pinned)))
        job.stages.append("checking")
        await loop.run_in_executor(None, _checked, model, path)
    except Exception as error:  # noqa: BLE001  the failure goes to the view and the status
        job.error = str(error)
    finally:
        job.finished.set()


async def download(model_id: str) -> AsyncIterator[dict[str, Any]]:
    """Fetch a model's file at its commit into the Hugging Face cache, with progress events.

    The file of a model of MODELS is then checked against its SHA-256. A file
    that stores its token scores as integers gets its copy with float scores
    (readable_path), so that the first label does not wait for it. Both run
    in a job (Download) that does not depend on this stream: a second view,
    or the same one after a reload, follows the job that runs.
    """
    start = time.monotonic()
    model = model_of(model_id)
    if model is None:
        yield {"type": "error", "message": f"no local model named {model_id}"}
        return
    if model.path:
        yield {"type": "error", "message": f"{model.label} is a file on this machine, and the server downloads only from Hugging Face"}
        return
    loop = asyncio.get_running_loop()
    job = DOWNLOADS.get(model.id)
    if job is None or job.done() or job.task is None or job.task.get_loop() is not loop:
        if model_path(model) is not None:
            yield {"type": "result", "model": model.id, "elapsed": 0.0}
            return
        if not hub_available():
            yield {"type": "error", "message": "huggingface_hub is not installed: pip install 'whybook[local]'"}
            return
        job = Download(model)
        job.task = asyncio.ensure_future(_download_and_check(job))
        DOWNLOADS[model.id] = job
    shown = 0
    while True:
        # Each stage once, and the download's progress each second.
        stages = job.stages[shown:]
        shown += len(stages)
        for stage in stages or ([] if job.done() else [job.stage]):
            yield job.progress(stage, start)
        if job.done():
            break
        await asyncio.wait({job.task}, timeout=1.0)
    if job.error:
        yield {"type": "error", "message": f"the download of {model.label} failed: {job.error}"}
        return
    yield {"type": "result", "model": model.id, "elapsed": round(time.monotonic() - start, 1)}


async def ask_local(model_id: str, tables: list[dict[str, Any]], threads: int, check: str = "fast") -> AsyncIterator[dict[str, Any]]:
    """Label the tables one at a time, with the events of claude.structured_call."""
    async for event in _each(model_id, tables, threads, check, label, "labelling table", "tables"):
        yield event


async def ask_local_frames(model_id: str, frames: list[dict[str, Any]], threads: int, check: str = "fast") -> AsyncIterator[dict[str, Any]]:
    """Summarise the frames one at a time, with the events of claude.structured_call."""
    async for event in _each(model_id, frames, threads, check, summarise, "summarising frame", "frames"):
        yield event


async def ask_local_titles(model_id: str, cells: list[dict[str, Any]], threads: int, check: str = "fast") -> AsyncIterator[dict[str, Any]]:
    """Title the cells one at a time, with the events of claude.structured_call."""
    async for event in _each(model_id, cells, threads, check, title, "titling cell", "cells"):
        yield event


async def _each(
    model_id: str, items: list[dict[str, Any]], threads: int, check: str, work: Any, stage: str, key: str
) -> AsyncIterator[dict[str, Any]]:
    """The items of one request, one after another in one worker thread that holds the model's lock for all of them.

    Labels on one model and titles on another, asked at the same time, then
    load each model once, where taking the lock per item loaded a model for
    each answer. When the view stops reading, the thread stops after the item
    it is on, and the next request gets the lock.
    """
    start = time.monotonic()
    model = model_of(model_id)
    if model is None:
        yield {"type": "error", "message": f"no local model named {model_id}"}
        return
    if not runtime_available():
        yield {"type": "error", "message": "llama-cpp-python is not installed on the server"}
        return
    loop = asyncio.get_running_loop()
    events: asyncio.Queue = asyncio.Queue()
    stopped = threading.Event()

    def send(event: dict[str, Any]) -> None:
        try:
            loop.call_soon_threadsafe(events.put_nowait, {**event, "elapsed": round(time.monotonic() - start, 1)})
        except RuntimeError:  # the server closed the loop
            stopped.set()

    def run() -> None:
        notes = []
        send({"type": "progress", "stage": f"{stage} 1 of {len(items)}"})
        try:
            with _lock:
                for index, item in enumerate(items):
                    if stopped.is_set():
                        return
                    if index:
                        send({"type": "progress", "stage": f"{stage} {index + 1} of {len(items)}"})
                    notes.append(work(model, item, threads, check))
            send({"type": "result", key: notes, **_ran(model, check)})
        except Exception as error:  # noqa: BLE001  the model's failure goes to the view
            send({"type": "error", "message": str(error)})

    loop.run_in_executor(None, run)
    try:
        while True:
            event = await events.get()
            yield event
            if event["type"] in ("result", "error"):
                return
    finally:
        stopped.set()
