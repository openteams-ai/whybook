"""Speech engines that run in the Jupyter server: a spoken question to text.

research/voice-questions.md chose Moonshine v2 Streaming for short spoken
questions on a CPU: Medium Streaming gets 6.66% of words wrong on the Open ASR
Leaderboard and gives the text 258 ms after the speech on a MacBook M3, and
Small Streaming 7.84% and 148 ms. Both are English only, under the MIT
licence, and run through moonshine-voice (ONNX Runtime, no PyTorch).

The view records 16 kHz mono PCM and posts it as a WAV file, so the server
reads it with the standard library's ``wave`` module and needs no audio
decoder. The names the analyst works with (the drop's source and target, their
columns, the kernel's variables) go to the model as key terms, which Moonshine
favours while it decodes.

The server downloads a model only when the user presses Download for it, from
download.moonshine.ai, as moonshine-voice fetches it. One transcriber is
loaded at a time and one request runs at a time, in a worker thread, as
local_models.py does for llama.cpp.

An engine is one entry of ENGINES. To drop one, delete its entry here, its
module under src/model/speech/ with its line in src/model/speech/registry.ts,
and its choice in the oneOf of ``models.speech`` in schema/plugin.json.
"""

from __future__ import annotations

import array
import asyncio
import functools
import importlib.util
import io
import sys
import threading
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Iterable

# The language of the models offered: the English models are MIT licensed.
LANGUAGE = "en"
# A spoken question takes seconds; a minute of 16 kHz audio is 1.9 MB.
MAX_SECONDS = 60
# Moonshine measured that a long list costs accuracy: 1,000 terms that are
# never said raised Tiny Streaming's errors from 4.83% to 5.88%.
MAX_TERMS = 100
MAX_TERM_LENGTH = 60
INSTALL = "moonshine-voice is not installed: pip install -e '.[speech]'"


@dataclass(frozen=True)
class SpeechEngine:
    id: str
    label: str
    # The name of the model's architecture in moonshine_voice.ModelArch.
    arch: str
    size_mb: int
    note: str


ENGINES = {
    engine.id: engine
    for engine in [
        SpeechEngine(
            "moonshine-medium",
            "Moonshine Medium",
            "MEDIUM_STREAMING",
            269,
            "English; 6.66% of words wrong on the Open ASR Leaderboard, the text 258 ms after the speech on a MacBook M3",
        ),
        SpeechEngine(
            "moonshine-small",
            "Moonshine Small",
            "SMALL_STREAMING",
            142,
            "English; 7.84% of words wrong on the Open ASR Leaderboard, the text 148 ms after the speech on a MacBook M3",
        ),
    ]
}


class SpeechError(Exception):
    """A request that an engine cannot answer, with the HTTP status that says why."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def runtime_available() -> bool:
    # Checked without importing: moonshine_voice loads its native library when used.
    try:
        return importlib.util.find_spec("moonshine_voice") is not None
    except ValueError:
        # A module in sys.modules without a spec, which only a test puts there.
        return "moonshine_voice" in sys.modules


def _arch(engine: SpeechEngine) -> Any:
    from moonshine_voice import ModelArch

    return ModelArch[engine.arch]


def model_files(engine: SpeechEngine) -> tuple[Path, list[str]]:
    """Where moonshine-voice keeps the engine's model, and the names of its files.

    moonshine-voice downloads each file of a model to its cache directory,
    under the model's URL without the scheme (download.py,
    _download_manifest_group), and the URL is the catalog's download_url.
    """
    from moonshine_voice import download
    from moonshine_voice.download_file import get_cache_dir

    info = download.find_model_info(LANGUAGE, _arch(engine))
    root = Path(get_cache_dir()) / str(info["download_url"]).replace("https://", "")
    return root, list(download.get_components_for_model_info(info))


def model_dir(engine: SpeechEngine) -> Path | None:
    """The engine's model directory when every file of the model is there, or None."""
    root, names = model_files(engine)
    if names and all((root / name).exists() for name in names):
        return root
    return None


def download_command(engine: SpeechEngine) -> str:
    """The command that fetches the engine's model, as moonshine-voice's own download script takes it."""
    return f"python -m moonshine_voice.download --stt --language {LANGUAGE} --model-arch {int(_arch(engine))}"


def status() -> list[dict[str, Any]]:
    """The speech engines the view can offer, each with the reason it cannot run, if any."""
    entries = []
    for engine in ENGINES.values():
        reason = None
        missing = False
        if not runtime_available():
            reason = INSTALL
        else:
            try:
                missing = model_dir(engine) is None
            except Exception as error:  # noqa: BLE001  a broken install goes to the view
                reason = f"moonshine-voice cannot find the model: {error}"
            else:
                if missing:
                    reason = f"not downloaded: {download_command(engine)}"
        entries.append(
            {
                "id": engine.id,
                "label": engine.label,
                "kind": "speech",
                "size_mb": engine.size_mb,
                "note": engine.note,
                "source": "download.moonshine.ai",
                "available": reason is None,
                "reason": reason,
                "downloadable": missing,
            }
        )
    return entries


def read_wav(data: bytes) -> tuple[list[float], int]:
    """The samples of a WAV file of 16-bit mono PCM, from -1 to 1, and its sample rate."""
    try:
        with wave.open(io.BytesIO(data)) as wav:
            channels = wav.getnchannels()
            width = wav.getsampwidth()
            rate = wav.getframerate()
            frames = wav.getnframes()
            pcm = wav.readframes(frames)
    except (wave.Error, EOFError) as error:
        raise SpeechError(f"the recording must be a WAV file: {error}") from error
    if channels != 1 or width != 2:
        raise SpeechError(f"the recording must be mono 16-bit PCM, not {channels} channels of {8 * width} bits")
    if not 8000 <= rate <= 48000:
        raise SpeechError(f"the recording's sample rate must be from 8,000 to 48,000 Hz, not {rate}")
    if frames == 0:
        raise SpeechError("the recording is empty")
    if frames > MAX_SECONDS * rate:
        raise SpeechError(f"the recording is longer than {MAX_SECONDS} s", 413)
    samples = array.array("h")
    samples.frombytes(pcm[: len(pcm) - len(pcm) % 2])
    if sys.byteorder == "big":
        samples.byteswap()
    return [value / 32768.0 for value in samples], rate


def key_terms(terms: Iterable[Any]) -> list[str]:
    """The names to favour as Moonshine takes them: without commas, which separate them, each once, at most MAX_TERMS."""
    kept: dict[str, str] = {}
    for term in terms:
        text = " ".join(str(term).replace(",", " ").split())[:MAX_TERM_LENGTH].strip()
        if text and text.lower() not in kept:
            kept[text.lower()] = text
        if len(kept) >= MAX_TERMS:
            break
    return list(kept.values())


_lock = threading.Lock()
_loaded: tuple[str, Any] | None = None


def _unload() -> None:
    """Free the loaded transcriber, so that the next request loads its engine again."""
    global _loaded
    if _loaded is not None:
        close = getattr(_loaded[1], "close", None)
        _loaded = None
        if close is not None:
            close()


def _transcriber(engine: SpeechEngine) -> Any:
    """The engine's transcriber, loading it and freeing the one before when it is another."""
    global _loaded
    if _loaded is not None and _loaded[0] == engine.id:
        return _loaded[1]
    path = model_dir(engine)
    if path is None:
        raise SpeechError(f"{engine.label} is not downloaded: {download_command(engine)}", 409)
    from moonshine_voice import Transcriber

    _unload()
    transcriber = Transcriber(model_path=str(path), model_arch=_arch(engine))
    _loaded = (engine.id, transcriber)
    return transcriber


def transcribe(engine: SpeechEngine, samples: list[float], rate: int, terms: list[str]) -> str:
    """The words of a recording, with the names in play as key terms."""
    with _lock:
        transcriber = _transcriber(engine)
        # An empty list turns the favouring of the last request's names off.
        transcriber.set_keyterms(terms)
        transcript = transcriber.transcribe_without_streaming(samples, sample_rate=rate, flags=0)
    return " ".join(line.text.strip() for line in transcript.lines if line.text and line.text.strip())


async def ask_transcribe(engine_id: str, data: bytes, terms: Iterable[Any]) -> dict[str, Any]:
    """``transcribe`` in a worker thread, from the body of the view's request."""
    start = time.monotonic()
    engine = ENGINES.get(engine_id)
    if engine is None:
        raise SpeechError(f"unknown speech engine {engine_id!r}")
    if not runtime_available():
        raise SpeechError(INSTALL, 409)
    samples, rate = read_wav(data)
    text = await asyncio.to_thread(transcribe, engine, samples, rate, key_terms(terms))
    return {"text": text, "engine": engine.label, "elapsed": round(time.monotonic() - start, 2)}


async def download(engine_id: str) -> AsyncIterator[dict[str, Any]]:
    """Fetch an engine's model as moonshine-voice does, with progress events."""
    start = time.monotonic()
    engine = ENGINES.get(engine_id)
    if engine is None:
        yield {"type": "error", "message": f"unknown speech engine {engine_id!r}"}
        return
    if not runtime_available():
        yield {"type": "error", "message": INSTALL}
        return
    if model_dir(engine) is not None:
        yield {"type": "result", "model": engine.id, "elapsed": 0.0}
        return
    from moonshine_voice import get_model_for_language

    share: list[float | None] = [None]

    def progress(fraction: float, name: str) -> None:
        share[0] = fraction

    loop = asyncio.get_running_loop()
    # A download that the user stops by closing the view runs on to the end in its thread.
    fetch = loop.run_in_executor(None, functools.partial(get_model_for_language, LANGUAGE, _arch(engine), on_progress=progress))
    while not fetch.done():
        yield {
            "type": "progress",
            "stage": f"downloading {engine.label}",
            "progress": share[0],
            "elapsed": round(time.monotonic() - start, 1),
        }
        await asyncio.wait({fetch}, timeout=1.0)
    try:
        fetch.result()
    except Exception as error:  # noqa: BLE001  the failure goes to the view
        yield {"type": "error", "message": f"the download of {engine.label} failed: {error}"}
        return
    yield {"type": "result", "model": engine.id, "elapsed": round(time.monotonic() - start, 1)}
