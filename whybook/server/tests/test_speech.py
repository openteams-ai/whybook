"""Speech engines with a fake moonshine_voice, a fake cache and synthetic audio: no model loads."""

import array
import enum
import importlib.machinery
import io
import json
import math
import sys
import time
import types
import wave
from pathlib import Path

import pytest
from tornado.httpclient import HTTPClientError

from whybook.server import speech

MEDIUM = speech.ENGINES["moonshine-medium"]
SMALL = speech.ENGINES["moonshine-small"]
# The files of a model in the fake catalog; moonshine-voice 0.1.5 lists eight.
FILES = ["encoder.ort", "decoder_kv.ort", "tokenizer.bin"]
SCHEMA = Path(__file__).parents[3] / "schema" / "plugin.json"


class FakeArch(enum.IntEnum):
    """moonshine_voice.ModelArch of moonshine-voice 0.1.5."""

    TINY = 0
    BASE = 1
    TINY_STREAMING = 2
    BASE_STREAMING = 3
    SMALL_STREAMING = 4
    MEDIUM_STREAMING = 5


class FakeTranscriber:
    """Answers every recording with ``answer`` and records what it was given."""

    made: list["FakeTranscriber"] = []
    answer = [" Does pain differ", "by site? "]

    def __init__(self, model_path, model_arch, **options):
        self.model_path = model_path
        self.model_arch = model_arch
        self.keyterms = None
        self.calls = []
        self.closed = False
        FakeTranscriber.made.append(self)

    def set_keyterms(self, keyterms):
        self.keyterms = list(keyterms) if keyterms else []

    def transcribe_without_streaming(self, audio_data, sample_rate=16000, flags=0):
        self.calls.append({"samples": list(audio_data), "sample_rate": sample_rate, "keyterms": self.keyterms})
        return types.SimpleNamespace(lines=[types.SimpleNamespace(text=text) for text in FakeTranscriber.answer])

    def close(self):
        self.closed = True


def model_url(arch):
    size = "medium" if arch == FakeArch.MEDIUM_STREAMING else "small"
    return f"https://download.moonshine.ai/model/{size}-streaming-en/quantized_26_08_21"


def model_root(cache, engine):
    return cache / model_url(FakeArch[engine.arch]).replace("https://", "")


def put_model(cache, engine):
    """The engine's files in the cache, as moonshine-voice lays them out."""
    root = model_root(cache, engine)
    root.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        (root / name).write_bytes(b"ORT")
    return root


@pytest.fixture
def fake(tmp_path, monkeypatch):
    """A moonshine_voice whose catalog, cache and transcriber are fakes; returns the cache and the downloads asked for."""
    downloads = []

    def get_model_for_language(language="en", model_arch=None, *, cache_root=None, on_progress=None):
        downloads.append((language, int(model_arch)))
        if on_progress is not None:
            on_progress(0.5, "encoder.ort")
        time.sleep(0.05)
        engine = next(engine for engine in speech.ENGINES.values() if FakeArch[engine.arch] == model_arch)
        root = put_model(tmp_path, engine)
        if on_progress is not None:
            on_progress(1.0, "tokenizer.bin")
        return str(root), model_arch

    module = types.ModuleType("moonshine_voice")
    module.__spec__ = importlib.machinery.ModuleSpec("moonshine_voice", None)
    module.ModelArch = FakeArch
    module.Transcriber = FakeTranscriber
    module.get_model_for_language = get_model_for_language
    download = types.ModuleType("moonshine_voice.download")
    download.find_model_info = lambda language, arch: {"model_arch": arch, "download_url": model_url(arch), "language": language}
    download.get_components_for_model_info = lambda info: list(FILES)
    download_file = types.ModuleType("moonshine_voice.download_file")
    download_file.get_cache_dir = lambda app_name="moonshine_voice": tmp_path
    module.download = download
    module.download_file = download_file
    monkeypatch.setitem(sys.modules, "moonshine_voice", module)
    monkeypatch.setitem(sys.modules, "moonshine_voice.download", download)
    monkeypatch.setitem(sys.modules, "moonshine_voice.download_file", download_file)
    monkeypatch.setattr(speech, "_loaded", None)
    monkeypatch.setattr(FakeTranscriber, "made", [])
    return types.SimpleNamespace(cache=tmp_path, downloads=downloads)


def sine_wav(seconds=0.5, rate=16000, channels=1, width=2, frequency=440.0):
    """A synthetic recording: a sine at half the full scale."""
    frames = int(seconds * rate)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(width)
        wav.setframerate(rate)
        if width == 2:
            values = array.array("h")
            for index in range(frames):
                value = int(0.5 * 32767 * math.sin(2 * math.pi * frequency * index / rate))
                values.extend([value] * channels)
            if sys.byteorder == "big":
                values.byteswap()
            wav.writeframes(values.tobytes())
        else:
            wav.writeframes(bytes([128]) * frames * channels * width)
    return buffer.getvalue()


def test_without_moonshine_voice_no_engine_can_run(monkeypatch):
    monkeypatch.setattr(speech, "runtime_available", lambda: False)
    entries = speech.status()
    assert [entry["id"] for entry in entries] == ["moonshine-medium", "moonshine-small"]
    assert {entry["reason"] for entry in entries} == {"moonshine-voice is not installed: pip install -e '.[speech]'"}
    assert not any(entry["available"] or entry["downloadable"] for entry in entries)


def test_a_model_not_in_the_cache_gives_the_command_that_fetches_it(fake):
    put_model(fake.cache, MEDIUM)
    status = {entry["id"]: entry for entry in speech.status()}
    assert status["moonshine-medium"]["available"] is True
    assert status["moonshine-medium"]["reason"] is None
    assert status["moonshine-medium"]["downloadable"] is False
    assert speech.model_dir(MEDIUM) == model_root(fake.cache, MEDIUM)
    assert status["moonshine-small"]["available"] is False
    assert status["moonshine-small"]["reason"] == "not downloaded: python -m moonshine_voice.download --stt --language en --model-arch 4"
    assert status["moonshine-small"]["downloadable"] is True
    assert [status[key]["size_mb"] for key in status] == [269, 142]
    assert status["moonshine-small"]["source"] == "download.moonshine.ai"


def test_a_model_with_a_file_missing_is_not_downloaded(fake):
    root = put_model(fake.cache, MEDIUM)
    (root / "tokenizer.bin").unlink()
    assert speech.model_dir(MEDIUM) is None


def test_the_recording_is_read_from_a_wav_file():
    samples, rate = speech.read_wav(sine_wav())
    assert rate == 16000
    assert len(samples) == 8000
    assert samples[0] == 0
    assert max(samples) == pytest.approx(0.5, abs=0.001)
    # A quarter of a period of 440 Hz is 9.09 samples at 16 kHz.
    assert samples[9] == pytest.approx(0.5 * math.sin(2 * math.pi * 440 * 9 / 16000), abs=0.001)
    assert speech.read_wav(sine_wav(rate=48000))[1] == 48000


@pytest.mark.parametrize(
    "data, status, message",
    [
        (b"hello", 400, "must be a WAV file"),
        (sine_wav(channels=2), 400, "mono 16-bit PCM, not 2 channels of 16 bits"),
        (sine_wav(width=1), 400, "not 1 channels of 8 bits"),
        (sine_wav(rate=96000, seconds=0.1), 400, "from 8,000 to 48,000 Hz"),
        (sine_wav(seconds=0), 400, "empty"),
        (sine_wav(seconds=61, rate=8000), 413, "longer than 60 s"),
    ],
    # The recordings are bytes: each case's id names what is wrong with it.
    ids=["not a WAV file", "two channels", "8-bit", "96 kHz", "empty", "61 s"],
)
def test_a_recording_that_is_not_mono_16_bit_pcm_is_refused(data, status, message):
    with pytest.raises(speech.SpeechError, match=message) as error:
        speech.read_wav(data)
    assert error.value.status == status


def test_key_terms_have_no_commas_or_repeats_and_are_at_most_a_hundred():
    assert speech.key_terms(["pain score", " IL8 ", "site,", "Pain  Score", "", "treatment, arm"]) == [
        "pain score",
        "IL8",
        "site",
        "treatment arm",
    ]
    assert len(speech.key_terms(f"name {index}" for index in range(300))) == 100
    assert speech.key_terms(["x" * 80]) == ["x" * 60]


async def test_a_recording_is_written_as_text_with_the_names_as_key_terms(fake):
    root = put_model(fake.cache, MEDIUM)
    result = await speech.ask_transcribe("moonshine-medium", sine_wav(), ["pain score", "IL8", "site,", "Pain Score"])
    assert result["text"] == "Does pain differ by site?"
    assert result["engine"] == "Moonshine Medium"
    [transcriber] = FakeTranscriber.made
    assert transcriber.model_path == str(root)
    assert transcriber.model_arch == FakeArch.MEDIUM_STREAMING
    [call] = transcriber.calls
    assert call["keyterms"] == ["pain score", "IL8", "site"]
    assert call["sample_rate"] == 16000
    assert len(call["samples"]) == 8000


async def test_the_transcriber_loads_once_and_gives_way_to_another_engine(fake):
    put_model(fake.cache, MEDIUM)
    put_model(fake.cache, SMALL)
    await speech.ask_transcribe("moonshine-medium", sine_wav(), ["pain score"])
    await speech.ask_transcribe("moonshine-medium", sine_wav(), [])
    [medium] = FakeTranscriber.made
    # A request without names turns off the names of the one before.
    assert [call["keyterms"] for call in medium.calls] == [["pain score"], []]
    await speech.ask_transcribe("moonshine-small", sine_wav(), [])
    assert medium.closed is True
    assert [transcriber.model_arch for transcriber in FakeTranscriber.made] == [FakeArch.MEDIUM_STREAMING, FakeArch.SMALL_STREAMING]


async def test_an_engine_whose_model_is_missing_or_unknown_is_refused(fake, monkeypatch):
    with pytest.raises(speech.SpeechError, match="Moonshine Small is not downloaded: python -m moonshine_voice.download") as error:
        await speech.ask_transcribe("moonshine-small", sine_wav(), [])
    assert error.value.status == 409
    with pytest.raises(speech.SpeechError, match="unknown speech engine 'whisper'"):
        await speech.ask_transcribe("whisper", sine_wav(), [])
    monkeypatch.setattr(speech, "runtime_available", lambda: False)
    with pytest.raises(speech.SpeechError, match=r"pip install -e '\.\[speech\]'") as error:
        await speech.ask_transcribe("moonshine-medium", sine_wav(), [])
    assert error.value.status == 409


async def test_a_download_fetches_the_model_as_moonshine_voice_does(fake):
    events = [event async for event in speech.download("moonshine-small")]
    assert events[-1] == {"type": "result", "model": "moonshine-small", "elapsed": pytest.approx(0.0, abs=5)}
    assert all(event["type"] == "progress" and event["stage"] == "downloading Moonshine Small" for event in events[:-1])
    assert fake.downloads == [("en", 4)]
    assert speech.model_dir(SMALL) == model_root(fake.cache, SMALL)
    # A second press finds the files and fetches nothing.
    again = [event async for event in speech.download("moonshine-small")]
    assert again == [{"type": "result", "model": "moonshine-small", "elapsed": 0.0}]
    assert fake.downloads == [("en", 4)]


async def test_a_download_without_moonshine_voice_says_how_to_install_it(monkeypatch):
    monkeypatch.setattr(speech, "runtime_available", lambda: False)
    events = [event async for event in speech.download("moonshine-medium")]
    assert events == [{"type": "error", "message": "moonshine-voice is not installed: pip install -e '.[speech]'"}]
    assert [event async for event in speech.download("whisper")] == [{"type": "error", "message": "unknown speech engine 'whisper'"}]


def test_the_settings_offer_every_engine_of_the_server():
    """Each engine is one value of models.speech: dropping one drops it there too."""
    schema = json.loads(SCHEMA.read_text())
    choices = [choice["const"] for choice in schema["properties"]["models"]["properties"]["speech"]["oneOf"]]
    assert set(speech.ENGINES) <= set(choices)
    assert choices[0] == "off"


async def transcribe(jp_fetch, body, *params):
    return await jp_fetch(
        "whybook",
        "speech",
        "transcribe",
        method="POST",
        body=body,
        headers={"Content-Type": "audio/wav"},
        params=list(params),
    )


async def test_the_route_writes_a_recording_as_text(jp_fetch, fake):
    put_model(fake.cache, MEDIUM)
    response = await transcribe(jp_fetch, sine_wav(), ("engine", "moonshine-medium"), ("term", "pain score"), ("term", "IL8"))
    result = json.loads(response.body)
    assert result["text"] == "Does pain differ by site?"
    assert FakeTranscriber.made[0].calls[0]["keyterms"] == ["pain score", "IL8"]


@pytest.mark.parametrize(
    "engine, body, code, message",
    [
        ("whisper", sine_wav(), 400, "unknown speech engine"),
        ("moonshine-medium", b"not a recording", 400, "must be a WAV file"),
        ("moonshine-small", sine_wav(), 409, "Moonshine Small is not downloaded"),
    ],
    # The recordings are bytes: each case's id names the engine and what is refused.
    ids=["unknown engine", "not a WAV file", "model not downloaded"],
)
async def test_the_route_refuses_what_it_cannot_write(jp_fetch, fake, engine, body, code, message):
    put_model(fake.cache, MEDIUM)
    with pytest.raises(HTTPClientError) as error:
        await transcribe(jp_fetch, body, ("engine", engine))
    assert error.value.code == code
    assert message in json.loads(error.value.response.body)["message"]


async def test_the_status_route_lists_the_engines_and_the_download_route_fetches_one(jp_fetch, fake):
    response = await jp_fetch("whybook", "status")
    engines = {entry["id"]: entry for entry in json.loads(response.body)["speech_engines"]}
    assert engines["moonshine-medium"]["downloadable"] is True
    response = await jp_fetch("whybook", "speech", "download", method="POST", body=json.dumps({"engine": "moonshine-medium"}))
    events = [json.loads(line) for line in response.body.decode().splitlines()]
    assert events[-1]["type"] == "result"
    assert fake.downloads == [("en", 5)]
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "speech", "download", method="POST", body=json.dumps({"engine": "whisper"}))
    assert error.value.code == 400
