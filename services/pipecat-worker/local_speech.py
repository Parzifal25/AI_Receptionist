"""Local, credential-free speech for the Pipecat worker — HALO Phase B.

STATUS: IMPLEMENTED and run with real models on a 4-core laptop CPU. Quality
is BELOW the Sarvam reference, measurably so for Telugu STT; the numbers and
what was and was not verified are in docs/LOCAL_SPEECH.md. Selecting `local`
is an availability decision, not a quality claim.

Both services sit behind the same Pipecat `STTService` / `TTSService`
interfaces the Sarvam services implement, so nothing outside `_build_stt` /
`_build_tts` in worker.py knows which one is running.

*   Runtime: sherpa-onnx (in-process ONNX Runtime; no service, no network).
*   STT: an offline CTC model. It is NOT a streaming recognizer: one final
    per VAD-endpointed utterance, no interim results, no confidence.
*   TTS: Piper VITS voices, one per language. Each HALO chunk is written out
    for speech and cut into segments by local_tts_text.py (numbers, dates,
    times and prices as words; one segment per sentence, clause or script
    run): Telugu-script text goes to the Telugu voice and Latin-script text
    to the English voice, because the Telugu voice mispronounces English
    words written in Latin letters. Each segment's own edge silence is
    trimmed and an explicit pause inserted after it.
*   Models are loaded once per process and shared by every call. Inference
    runs on worker threads so the event loop keeps pacing audio.

Which models are used is decided by `manifest.json` in VOICE_LOCAL_MODEL_DIR
(written by setup_local_speech.py), never by a default in this file.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import threading
import time
import wave
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, Callable, Optional

import numpy as np
from pipecat.audio.utils import create_file_resampler
from pipecat.frames.frames import ErrorFrame, Frame, TranscriptionFrame, TTSAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.settings import STTSettings, TTSSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.services.tts_service import TTSService

from local_tts_text import DEFAULT_SPEED, UnspeakableText, pause_samples, split_clauses, trim_and_fade  # noqa: F401 - split_clauses re-exported
from local_tts_text import plan_speech as _plan_speech
from local_tts_text import split_script_runs as _split_script_runs

log = logging.getLogger("halo.worker.local_speech")

MANIFEST_VERSION = 1
DEFAULT_THREADS = 4
# One caller utterance. Longer segments are dropped, not truncated: half an
# utterance transcribed confidently is worse than a reprompt.
MAX_SEGMENT_S = 30.0
# Shorter than this is a click or a cough, not something to answer.
MIN_SEGMENT_S = 0.25
STT_TIMEOUT_S = 20.0
# One HALO chunk, all of it. Below the gate's own chunk timeout (15 s), so a
# slow synthesis ends as this service's recoverable error, not a silent stall.
TTS_TIMEOUT_S = 12.0



class LocalSpeechConfigError(RuntimeError):
    """The deployment is misconfigured (no model directory, missing file).

    Raised at build time so the session fails closed. Never a reason to fall
    back to another provider: a fallback would hide the misconfiguration.
    """


class LocalSpeechError(Exception):
    """A local inference failure, with an honest `recoverable` flag."""

    def __init__(self, code: str, message: str, recoverable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.recoverable = recoverable


# ---------------------------------------------------------------------------
# Manifest and engine
# ---------------------------------------------------------------------------


def load_manifest(model_dir: Optional[str]) -> dict[str, Any]:
    """Read and validate the model manifest; every referenced file must exist."""
    if not model_dir:
        raise LocalSpeechConfigError("VOICE_LOCAL_MODEL_DIR is required when the local speech provider is selected")
    path = os.path.join(model_dir, "manifest.json")
    try:
        with open(path, encoding="utf-8") as handle:
            manifest = json.load(handle)
    except (OSError, ValueError) as exc:
        raise LocalSpeechConfigError(f"local speech manifest is unreadable: {path}") from exc
    if not isinstance(manifest, dict) or manifest.get("version") != MANIFEST_VERSION:
        raise LocalSpeechConfigError("local speech manifest has an unsupported version")
    stt, tts = manifest.get("stt"), manifest.get("tts")
    if not isinstance(stt, dict) or stt.get("engine") != "sherpa-onnx" or stt.get("type") != "omnilingual-ctc":
        raise LocalSpeechConfigError("local speech manifest names an unsupported STT model")
    if not isinstance(tts, dict) or tts.get("engine") != "sherpa-onnx" or tts.get("type") != "vits-piper":
        raise LocalSpeechConfigError("local speech manifest names an unsupported TTS model")
    voices = tts.get("voices")
    if not isinstance(voices, dict) or not voices:
        raise LocalSpeechConfigError("local speech manifest configures no TTS voice")
    required = [stt.get("model"), stt.get("tokens")]
    for voice in voices.values():
        required += [voice.get("model"), voice.get("tokens")]
    for relative in required:
        if not isinstance(relative, str) or not os.path.isfile(os.path.join(model_dir, relative)):
            raise LocalSpeechConfigError(f"local speech model file is missing: {relative}")
    if not os.path.isdir(os.path.join(model_dir, str(tts.get("dataDir")))):
        raise LocalSpeechConfigError("local speech phonemizer data directory is missing")
    return manifest


class LocalSpeechEngine:
    """The loaded models. Blocking: call from a worker thread, never the loop."""

    def __init__(self, model_dir: str, threads: int = DEFAULT_THREADS) -> None:
        self.model_dir = model_dir
        self.threads = threads
        self.manifest = load_manifest(model_dir)
        self._recognizer: Any = None
        self._voices: dict[str, Any] = {}
        self._stt_lock = threading.Lock()
        self._tts_lock = threading.Lock()
        # One inference at a time across STT and TTS. Each already uses every
        # configured thread; running both at once on a small CPU made each
        # several times slower and starved the audio pacer (measured live).
        self._inference = threading.Lock()

    @property
    def languages(self) -> list[str]:
        return sorted(self.manifest["tts"]["voices"])

    @property
    def stt_sample_rate(self) -> int:
        return int(self.manifest["stt"]["sampleRate"])

    def _path(self, relative: str) -> str:
        return os.path.join(self.model_dir, relative)

    def load_stt(self) -> None:
        with self._stt_lock:
            if self._recognizer is not None:
                return
            import sherpa_onnx

            started = time.perf_counter()
            stt = self.manifest["stt"]
            self._recognizer = sherpa_onnx.OfflineRecognizer.from_omnilingual_asr_ctc(
                model=self._path(stt["model"]), tokens=self._path(stt["tokens"]), num_threads=self.threads
            )
            log.info("local_stt loaded model=%s load_ms=%d", stt.get("id"), (time.perf_counter() - started) * 1000)

    def load_tts(self) -> None:
        with self._tts_lock:
            import sherpa_onnx

            tts = self.manifest["tts"]
            for language, voice in tts["voices"].items():
                if language in self._voices:
                    continue
                started = time.perf_counter()
                config = sherpa_onnx.OfflineTtsConfig(
                    model=sherpa_onnx.OfflineTtsModelConfig(
                        vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                            model=self._path(voice["model"]),
                            tokens=self._path(voice["tokens"]),
                            data_dir=self._path(tts["dataDir"]),
                        ),
                        num_threads=self.threads,
                    ),
                    max_num_sentences=1,
                )
                if not config.validate():
                    raise LocalSpeechConfigError(f"local TTS voice is invalid: {voice.get('id')}")
                self._voices[language] = sherpa_onnx.OfflineTts(config)
                log.info(
                    "local_tts loaded voice=%s language=%s load_ms=%d",
                    voice.get("id"),
                    language,
                    (time.perf_counter() - started) * 1000,
                )

    def transcribe(self, samples: np.ndarray, sample_rate: int) -> str:
        self.load_stt()
        with self._inference:
            stream = self._recognizer.create_stream()
            stream.accept_waveform(sample_rate, samples)
            self._recognizer.decode_stream(stream)
            return str(stream.result.text).strip()

    def synthesize(
        self, language: str, text: str, speed: float, should_stop: Callable[[], bool]
    ) -> tuple[np.ndarray, int]:
        self.load_tts()
        voice = self._voices.get(language)
        if voice is None:
            raise LocalSpeechError("unsupported_language", f"no local voice for language {language!r}", False)
        with self._inference:
            if should_stop():
                return np.zeros(0, dtype=np.float32), voice.sample_rate
            # The callback runs after each sentence; returning 0 abandons the
            # rest, which is how a barge-in stops paying for unheard audio.
            audio = voice.generate(text, sid=0, speed=speed, callback=lambda _samples, _progress: 0 if should_stop() else 1)
            return np.asarray(audio.samples, dtype=np.float32), int(audio.sample_rate)


_ENGINES: dict[tuple[str, int], LocalSpeechEngine] = {}
_ENGINES_LOCK = threading.Lock()


def get_engine(model_dir: Optional[str] = None, threads: Optional[int] = None) -> LocalSpeechEngine:
    """The process-wide engine for a model directory (weights are loaded once)."""
    directory = model_dir or os.environ.get("VOICE_LOCAL_MODEL_DIR", "")
    if not directory:
        raise LocalSpeechConfigError("VOICE_LOCAL_MODEL_DIR is required when the local speech provider is selected")
    try:
        count = int(threads if threads is not None else os.environ.get("VOICE_LOCAL_THREADS", DEFAULT_THREADS))
    except ValueError as exc:
        raise LocalSpeechConfigError("VOICE_LOCAL_THREADS must be an integer") from exc
    if not 1 <= count <= 64:
        raise LocalSpeechConfigError("VOICE_LOCAL_THREADS must be between 1 and 64")
    key = (os.path.abspath(directory), count)
    with _ENGINES_LOCK:
        if key not in _ENGINES:
            _ENGINES[key] = LocalSpeechEngine(key[0], count)
        return _ENGINES[key]


# ---------------------------------------------------------------------------
# Text routing
# ---------------------------------------------------------------------------


def base_language(language: Any, available: list[str]) -> Optional[str]:
    """`te-IN` → `te`, when a voice for it is installed."""
    code = str(getattr(language, "value", language) or "").split("-")[0].lower()
    return code if code in available else None


def split_script_runs(text: str, base: Optional[str], available: list[str]) -> list[tuple[str, str]]:
    """local_tts_text.split_script_runs, failing as a non-recoverable LocalSpeechError."""
    try:
        return _split_script_runs(text, base, available)
    except UnspeakableText as exc:
        raise LocalSpeechError("unsupported_language", str(exc), False) from exc


def plan_speech(text: str, base: Optional[str], available: list[str]) -> list[tuple[str, str, str]]:
    """local_tts_text.plan_speech, failing as a non-recoverable LocalSpeechError."""
    try:
        return _plan_speech(text, base, available)
    except UnspeakableText as exc:
        raise LocalSpeechError("unsupported_language", str(exc), False) from exc


def _error_frame(error: str, code: str, message: str, cause: BaseException) -> ErrorFrame:
    """A recoverable inference failure. Pipecat reads the exception's
    traceback when it reports the frame, so the cause's is carried over."""
    return ErrorFrame(error=error, exception=LocalSpeechError(code, message, True).with_traceback(cause.__traceback__))


def _float_to_pcm16(samples: np.ndarray) -> bytes:
    return (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


# ---------------------------------------------------------------------------
# Pipecat services
# ---------------------------------------------------------------------------


class LocalSTTService(SegmentedSTTService):
    """Offline STT over VAD segments: one final per caller utterance."""

    def __init__(self, *, engine: Any, sample_rate: int, timeout_s: float = STT_TIMEOUT_S, **kwargs) -> None:
        super().__init__(sample_rate=sample_rate, settings=STTSettings(model=None, language=None), **kwargs)
        self._engine = engine
        self._timeout_s = timeout_s
        self._overflow = False
        self._segments: asyncio.Queue[bytes] = asyncio.Queue()
        self._decoder: Optional[asyncio.Task] = None

    async def start(self, frame) -> None:
        await super().start(frame)
        if self._decoder is None:
            self._decoder = self.create_task(self._decode_segments(), "local_stt_decode")

    async def stop(self, frame) -> None:
        await super().stop(frame)
        await self._stop_decoder()

    async def cancel(self, frame) -> None:
        await super().cancel(frame)
        await self._stop_decoder()

    async def _stop_decoder(self) -> None:
        decoder, self._decoder = self._decoder, None
        if decoder is not None:
            await self.cancel_task(decoder)

    async def _decode_segments(self) -> None:
        """Decode utterances in order, OFF the frame path.

        The base class decodes inside the VAD handler, which holds up every
        frame behind it for the length of the decode — including the line
        HALO wants spoken next, which travels through this processor on its
        way to the TTS. With a multi-second local decode that stalled a
        playback until it timed out (seen in the first live run).
        """
        while True:
            segment = await self._segments.get()
            await self.process_generator(self.run_stt(segment))

    async def process_audio_frame(self, frame, direction: FrameDirection) -> None:
        if self._overflow:
            return
        if len(self._audio_buffer) + len(frame.audio) > self.sample_rate * 2 * MAX_SEGMENT_S:
            self._audio_buffer.clear()
            self._overflow = True
            log.warning("local_stt segment dropped reason=too_long limit_s=%d", MAX_SEGMENT_S)
            return
        await super().process_audio_frame(frame, direction)

    async def _handle_user_stopped_speaking(self, frame) -> None:
        self._user_speaking = False
        pcm = bytes(self._audio_buffer)
        self._audio_buffer.clear()
        if self._overflow:
            self._overflow = False
            return
        content = io.BytesIO()
        with wave.open(content, "wb") as wav:
            wav.setsampwidth(2)
            wav.setnchannels(1)
            wav.setframerate(self.sample_rate)
            wav.writeframes(pcm)
        self._segments.put_nowait(content.getvalue())

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Optional[Frame], None]:
        with wave.open(io.BytesIO(audio), "rb") as wav:
            rate = wav.getframerate()
            pcm = wav.readframes(wav.getnframes())
        seconds = len(pcm) / (2 * rate)
        if seconds < MIN_SEGMENT_S:
            return
        started = time.perf_counter()
        try:
            # The wire is 8 kHz; the model is not. Resampled here, with the
            # resampler the rest of the pipeline uses, rather than inside the
            # recognizer (which logs to stderr for every utterance it resamples).
            model_rate = int(self._engine.stt_sample_rate)
            if rate != model_rate:
                pcm = await create_file_resampler().resample(pcm, rate, model_rate)
            samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
            text = await asyncio.wait_for(asyncio.to_thread(self._engine.transcribe, samples, model_rate), self._timeout_s)
        except asyncio.TimeoutError as exc:
            log.error("local_stt failed code=timeout audio_ms=%d timeout_s=%.0f", seconds * 1000, self._timeout_s)
            yield _error_frame("local_stt_timeout", "timeout", "local STT timed out", exc)
            return
        except LocalSpeechConfigError:
            raise
        except Exception as exc:  # noqa: BLE001 - inference faults must not kill the pipeline
            log.exception("local_stt failed code=inference audio_ms=%d", seconds * 1000)
            yield _error_frame("local_stt_failed", "inference", str(exc)[:200], exc)
            return
        decode_ms = (time.perf_counter() - started) * 1000
        # Transcript text is caller content: lengths only, never the words.
        log.info(
            "local_stt final audio_ms=%d decode_ms=%d rtf=%.2f chars=%d",
            seconds * 1000,
            decode_ms,
            decode_ms / 1000 / seconds,
            len(text),
        )
        if text:
            # language stays None: the model reports none, and guessing one
            # would be read downstream as a detection it never made.
            yield TranscriptionFrame(
                text=text, user_id="", timestamp=datetime.now(timezone.utc).isoformat(), language=None
            )


class LocalTTSService(TTSService):
    """Piper voices through sherpa-onnx, one HALO chunk per `run_tts`."""

    def __init__(
        self,
        *,
        engine: Any,
        sample_rate: int,
        language: Any = None,
        speaking_rate: Optional[float] = None,
        timeout_s: float = TTS_TIMEOUT_S,
        **kwargs,
    ) -> None:
        super().__init__(
            sample_rate=sample_rate,
            push_start_frame=True,
            push_stop_frames=True,
            # Pipecat ends a playback that has produced no audio for this long
            # (3 s by default). Local synthesis releases nothing until a whole
            # clause is done, and on a busy CPU that took longer: the playback
            # was closed empty and the call was hung up (seen live). The
            # deadline that applies is this service's own timeout.
            stop_frame_timeout_s=timeout_s + 1.0,
            settings=TTSSettings(model=None, voice=None, language=language),
            **kwargs,
        )
        self._engine = engine
        # None: each voice speaks at its DEFAULT_SPEED (1.0 unless tuned).
        self._speed = min(2.0, max(0.5, float(speaking_rate))) if speaking_rate else None
        self._timeout_s = timeout_s

    def language_to_service_language(self, language) -> Optional[str]:
        return str(getattr(language, "value", language))

    async def _end_failed_context(self, context_id: str) -> None:
        """Close a playback that failed, now. Pipecat closes a context itself
        only once audio has flowed; without this a failed line would sit open
        until the idle timeout while the caller hears nothing."""
        if self.audio_context_available(context_id):
            await self.remove_audio_context(context_id)

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Optional[Frame], None]:
        stop = threading.Event()
        started = time.perf_counter()
        first_audio_ms: Optional[float] = None
        audio_ms = 0.0
        try:
            languages = list(self._engine.languages)
            segments = plan_speech(text, base_language(self._settings.language, languages), languages)
            resampler = create_file_resampler()
            for language, segment, pause in segments:
                speed = self._speed if self._speed is not None else DEFAULT_SPEED.get(language, 1.0)
                samples, rate = await asyncio.wait_for(
                    asyncio.to_thread(self._engine.synthesize, language, segment, speed, stop.is_set),
                    max(0.1, self._timeout_s - (time.perf_counter() - started)),
                )
                if not len(samples):
                    continue
                # The voice's own edge silence goes; the pause for how the segment ends replaces it.
                samples = np.concatenate([trim_and_fade(samples, rate), pause_samples(pause, rate)])
                pcm = await resampler.resample(_float_to_pcm16(samples), rate, self.sample_rate)
                if first_audio_ms is None:
                    first_audio_ms = (time.perf_counter() - started) * 1000
                audio_ms += len(pcm) / (2 * self.sample_rate) * 1000
                yield TTSAudioRawFrame(audio=pcm, sample_rate=self.sample_rate, num_channels=1, context_id=context_id)
            log.info(
                "local_tts synthesized chars=%d segments=%d first_audio_ms=%d total_ms=%d audio_ms=%d",
                len(text),
                len(segments),
                first_audio_ms or 0,
                (time.perf_counter() - started) * 1000,
                audio_ms,
            )
        except asyncio.TimeoutError as exc:
            log.error("local_tts failed code=timeout chars=%d timeout_s=%.0f", len(text), self._timeout_s)
            yield _error_frame("local_tts_timeout", "timeout", "local TTS timed out", exc)
            await self._end_failed_context(context_id)
        except LocalSpeechConfigError:
            raise
        except LocalSpeechError as exc:
            log.error("local_tts failed code=%s chars=%d", exc.code, len(text))
            yield ErrorFrame(error=f"local_tts_{exc.code}", exception=exc)
            await self._end_failed_context(context_id)
        except Exception as exc:  # noqa: BLE001 - inference faults must not kill the pipeline
            log.exception("local_tts failed code=inference chars=%d", len(text))
            yield _error_frame("local_tts_failed", "inference", str(exc)[:200], exc)
            await self._end_failed_context(context_id)
        finally:
            # Reached on completion and on a barge-in cancelling this generator:
            # either way an in-flight synthesis stops at its next sentence.
            stop.set()
