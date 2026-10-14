"""Local speech and provider routing — HALO Phase B.

STATUS: PASSING offline with a stand-in engine (no model files needed). The
last class runs the REAL models and is skipped unless VOICE_LOCAL_MODEL_DIR
points at a directory provisioned by setup_local_speech.py.

Pins:
*   the local STT/TTS services honour the Pipecat service contract the gate
    depends on (one final per VAD segment; started → audio → stopped at the
    wire rate);
*   the configured provider is the one built, and the Sarvam path is built
    exactly as before when no fallback is configured;
*   a fallback is taken only for a recoverable provider failure — never for
    a missing credential, a missing model or an unclassified error.

Run:  .venv/bin/python -m unittest discover -s services/pipecat-worker
"""

from __future__ import annotations

import asyncio
import os
import sys
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pipecat.frames.frames import (  # noqa: E402
    ErrorFrame,
    InputAudioRawFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSSpeakFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
    TTSUpdateSettingsFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.service_switcher import ServiceSwitcher  # noqa: E402
from pipecat.services.settings import TTSSettings  # noqa: E402
from pipecat.tests.utils import SleepFrame, run_test  # noqa: E402

import worker  # noqa: E402
from halo_client import VoiceConfig  # noqa: E402
from local_tts_text import PAUSE_MS  # noqa: E402
from local_speech import (  # noqa: E402
    LocalSpeechConfigError,
    LocalSpeechError,
    LocalSTTService,
    LocalTTSService,
    get_engine,
    split_clauses,
    split_script_runs,
)
from speech_fallback import RecoverableFailover, is_recoverable  # noqa: E402

RATE = 8000
VOICE = VoiceConfig(
    language="te-IN",
    alternative_languages=["en-IN"],
    phrase_hints=[],
    vad_min_speech_ms=120,
    vad_end_hangover_ms=700,
    barge_in_enabled=True,
    barge_in_min_speech_ms=250,
    max_call_duration_ms=900_000,
)


class StandInEngine:
    """Deterministic engine: no models, records what the services asked for."""

    languages = ["en", "te"]
    stt_sample_rate = 16000

    def __init__(self, transcript: str = "నమస్కారం", fail: Exception | None = None) -> None:
        self.transcript, self.fail = transcript, fail
        self.heard: list[tuple[int, int]] = []
        self.spoken: list[tuple[str, str]] = []

    def load_stt(self) -> None: ...

    def load_tts(self) -> None: ...

    def transcribe(self, samples, sample_rate):
        if self.fail:
            raise self.fail
        self.heard.append((len(samples), sample_rate))
        return self.transcript

    def synthesize(self, language, text, speed, should_stop):
        if self.fail:
            raise self.fail
        self.spoken.append((language, text))
        return np.full(22050 // 2, 0.1, dtype=np.float32), 22050  # 0.5 s at the voice's native rate


def audio(seconds: float) -> InputAudioRawFrame:
    return InputAudioRawFrame(audio=b"\x01\x00" * int(RATE * seconds), sample_rate=RATE, num_channels=1)


def of(frames, kind):
    return [frame for frame in frames if isinstance(frame, kind)]


class ScriptRoutingTests(unittest.TestCase):
    voices = ["en", "te"]

    def test_routes_each_script_to_its_voice(self):
        self.assertEqual(
            split_script_runs("మీ office timings ఏంటి, Sunday open ఉంటుందా?", "te", self.voices),
            [("te", "మీ"), ("en", "office timings"), ("te", "ఏంటి,"), ("en", "Sunday open"), ("te", "ఉంటుందా?")],
        )
        self.assertEqual(split_script_runs("appointmentకి", "te", self.voices), [("en", "appointment"), ("te", "కి")])

    def test_script_neutral_text_uses_the_line_language(self):
        self.assertEqual(split_script_runs("98480 12345", "en", self.voices), [("en", "98480 12345")])
        self.assertEqual(split_script_runs("10 గంటలకు", "en", self.voices), [("te", "10 గంటలకు")])

    def test_long_sentences_are_spoken_clause_by_clause(self):
        self.assertEqual(split_clauses("Hello, how can I help you today?"), ["Hello, how can I help you today?"])
        long = "We repair washing machines, refrigerators and air conditioners, and we are open Monday to Saturday."
        clauses = split_clauses(long)
        self.assertEqual(" ".join(clauses), long)  # nothing dropped or reordered
        self.assertGreater(len(clauses), 1)
        self.assertTrue(all(len(clause) >= 25 for clause in clauses[:-1]))

    def test_refuses_text_no_installed_voice_can_speak(self):
        with self.assertRaises(LocalSpeechError) as raised:
            split_script_runs("నమస్కారం", "en", ["en"])
        self.assertFalse(raised.exception.recoverable)
        with self.assertRaises(LocalSpeechError):
            split_script_runs("12345", None, self.voices)


class LocalSttContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_one_final_per_vad_segment_at_the_wire_rate(self):
        engine = StandInEngine()
        down, _ = await run_test(
            LocalSTTService(engine=engine, sample_rate=RATE),
            frames_to_send=[VADUserStartedSpeakingFrame(), audio(1.0), VADUserStoppedSpeakingFrame(), SleepFrame(0.2)],
        )
        finals = of(down, TranscriptionFrame)
        self.assertEqual([frame.text for frame in finals], ["నమస్కారం"])
        self.assertIsNone(finals[0].language)  # the model reports none; none is invented
        # One second of 8 kHz wire audio reaches the model at the model's rate.
        self.assertEqual([rate for _, rate in engine.heard], [16000])
        self.assertAlmostEqual(engine.heard[0][0] / 16000, 1.0, delta=0.02)

    async def test_a_click_is_not_transcribed(self):
        engine = StandInEngine()
        down, _ = await run_test(
            LocalSTTService(engine=engine, sample_rate=RATE),
            frames_to_send=[VADUserStartedSpeakingFrame(), audio(0.1), VADUserStoppedSpeakingFrame(), SleepFrame(0.1)],
        )
        self.assertEqual(of(down, TranscriptionFrame), [])
        self.assertEqual(engine.heard, [])

    async def test_inference_failure_is_a_recoverable_error_not_a_crash(self):
        engine = StandInEngine(fail=RuntimeError("onnx fault"))
        down, up = await run_test(
            LocalSTTService(engine=engine, sample_rate=RATE),
            frames_to_send=[VADUserStartedSpeakingFrame(), audio(1.0), VADUserStoppedSpeakingFrame(), SleepFrame(0.2)],
        )
        errors = of(up, ErrorFrame)
        self.assertEqual(len(errors), 1)
        self.assertFalse(errors[0].fatal)
        self.assertTrue(is_recoverable(errors[0]))
        self.assertEqual(of(down, TranscriptionFrame), [])


    async def test_a_slow_decode_does_not_hold_up_the_line_halo_wants_spoken(self):
        import threading

        release = threading.Event()

        class SlowEngine(StandInEngine):
            def transcribe(self, samples, sample_rate):
                release.wait(5)
                return super().transcribe(samples, sample_rate)

        # A speak frame queued right after the utterance must pass through the
        # STT processor while the decode is still running.
        speak = TTSSpeakFrame(text="next line", append_to_context=False)
        down, _ = await run_test(
            LocalSTTService(engine=SlowEngine(), sample_rate=RATE),
            frames_to_send=[VADUserStartedSpeakingFrame(), audio(1.0), VADUserStoppedSpeakingFrame(), speak, SleepFrame(0.3)],
        )
        release.set()
        self.assertIn(speak, down)
        self.assertEqual(of(down, TranscriptionFrame), [])  # the call ended while it was still decoding


class LocalTtsContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_chunk_becomes_started_audio_stopped_at_the_wire_rate(self):
        engine = StandInEngine()
        down, _ = await run_test(
            LocalTTSService(engine=engine, sample_rate=RATE, language="te-IN"),
            frames_to_send=[TTSSpeakFrame(text="నమస్కారం", append_to_context=False), SleepFrame(0.3)],
        )
        kinds = [type(f) for f in down if isinstance(f, (TTSStartedFrame, TTSAudioRawFrame, TTSStoppedFrame))]
        self.assertEqual(kinds[0], TTSStartedFrame)
        self.assertEqual(kinds[-1], TTSStoppedFrame)
        chunks = of(down, TTSAudioRawFrame)
        self.assertTrue(chunks)
        for chunk in chunks:
            self.assertEqual((chunk.sample_rate, chunk.num_channels, len(chunk.audio) % 2), (RATE, 1, 0))
        # 0.5 s from the voice plus the pause after an unpunctuated line, resampled 22.05 kHz → 8 kHz.
        expected = 0.5 + PAUSE_MS["clause"] / 1000
        self.assertAlmostEqual(sum(len(c.audio) for c in chunks) / (2 * RATE), expected, delta=0.02)
        self.assertEqual(engine.spoken, [("te", "నమస్కారం")])

    async def test_language_switch_and_mixed_script_select_voices(self):
        engine = StandInEngine()
        await run_test(
            LocalTTSService(engine=engine, sample_rate=RATE, language="te-IN"),
            frames_to_send=[
                TTSSpeakFrame(text="10", append_to_context=False),
                TTSUpdateSettingsFrame(delta=TTSSettings(language="en-IN")),
                TTSSpeakFrame(text="10", append_to_context=False),
                TTSSpeakFrame(text="Solar కి", append_to_context=False),
                SleepFrame(0.4),
            ],
        )
        # The number is said in the line's language, so it reaches that language's voice as words.
        self.assertEqual(engine.spoken, [("te", "పది"), ("en", "ten"), ("en", "Solar"), ("te", "కి")])

    async def test_unspeakable_text_is_a_non_recoverable_error(self):
        engine = StandInEngine()
        engine.languages = ["en"]
        down, up = await run_test(
            LocalTTSService(engine=engine, sample_rate=RATE, language="en-IN"),
            frames_to_send=[TTSSpeakFrame(text="నమస్కారం", append_to_context=False), SleepFrame(0.2)],
        )
        errors = of(up, ErrorFrame)
        self.assertEqual(len(errors), 1)
        self.assertFalse(is_recoverable(errors[0]))
        self.assertEqual(engine.spoken, [])
        # The failed playback is closed at once (started → stopped, no audio),
        # so the gate reports it failed instead of waiting out a timeout.
        self.assertEqual(of(down, TTSAudioRawFrame), [])
        self.assertEqual(len(of(down, TTSStoppedFrame)), 1)


class ProviderRoutingTests(unittest.TestCase):
    def build(self, env, profile=None):
        with patch.dict(os.environ, env, clear=True), patch.object(worker, "_local_engine", lambda *a, **k: StandInEngine()):
            return worker._build_stt(VOICE, None, profile), worker._build_tts(VOICE, profile)

    def test_selects_the_configured_provider(self):
        stt, tts = self.build({"VOICE_STT_PROVIDER": "local", "VOICE_TTS_PROVIDER": "local"})
        self.assertIsInstance(stt, LocalSTTService)
        self.assertIsInstance(tts, LocalTTSService)
        stt, tts = self.build({"VOICE_STT_PROVIDER": "local", "VOICE_TTS_PROVIDER": "fake"})
        self.assertIsInstance(stt, LocalSTTService)
        self.assertIsInstance(tts, worker.FakeTTSService)
        # The per-kind names win over the older worker-wide one.
        stt, _ = self.build({"HALO_SPEECH_PROVIDER": "fake", "VOICE_STT_PROVIDER": "local"})
        self.assertIsInstance(stt, LocalSTTService)

    def test_sarvam_path_is_built_exactly_as_before(self):
        from pipecat.services.sarvam.stt import SarvamSTTService
        from pipecat.services.sarvam.tts import SarvamTTSService

        for env in ({"SARVAM_API_KEY": "k", "VOICE_TTS_DEFAULT_VOICE": "anushka"},
                    {"SARVAM_API_KEY": "k", "VOICE_TTS_DEFAULT_VOICE": "anushka", "VOICE_STT_PROVIDER": "sarvam", "VOICE_TTS_PROVIDER": "sarvam"}):
            stt, tts = self.build(env)
            # Bare vendor services: no switcher, no wrapper, nothing local loaded.
            self.assertIs(type(stt), SarvamSTTService)
            self.assertIs(type(tts), SarvamTTSService)
            self.assertEqual(stt.sample_rate or RATE, RATE)

    def test_fallback_is_a_switcher_with_the_primary_active(self):
        stt, tts = self.build({"SARVAM_API_KEY": "k", "VOICE_TTS_DEFAULT_VOICE": "anushka",
                               "VOICE_STT_FALLBACK_PROVIDER": "local", "VOICE_TTS_FALLBACK_PROVIDER": "local"})
        for switcher, local in ((stt, LocalSTTService), (tts, LocalTTSService)):
            self.assertIsInstance(switcher, ServiceSwitcher)
            self.assertIsInstance(switcher.strategy, RecoverableFailover)
            self.assertIs(switcher.strategy.active_service, switcher.services[0])
            self.assertIn("Sarvam", type(switcher.services[0]).__name__)
            self.assertIsInstance(switcher.services[1], local)

    def test_configuration_errors_never_fall_back(self):
        # No Sarvam credential: the fallback must not paper over it.
        with self.assertRaises(RuntimeError):
            self.build({"VOICE_STT_FALLBACK_PROVIDER": "local", "VOICE_TTS_FALLBACK_PROVIDER": "local"})
        with self.assertRaises(RuntimeError):
            self.build({}, {"stt": {"provider": "sarvam", "fallback": {"provider": "fake"}}, "tts": {"provider": "fake"}})
        with self.assertRaises(RuntimeError):
            self.build({"VOICE_STT_PROVIDER": "whisper-somewhere"})
        with self.assertRaises(RuntimeError):
            self.build({"VOICE_STT_PROVIDER": "local", "VOICE_STT_FALLBACK_PROVIDER": "local"})
        # No model directory: local refuses to build instead of using a fake.
        with patch.dict(os.environ, {"VOICE_STT_PROVIDER": "local"}, clear=True):
            with self.assertRaises(LocalSpeechConfigError):
                worker._build_stt(VOICE, None)
        with patch.dict(os.environ, {"VOICE_STT_PROVIDER": "local", "VOICE_LOCAL_MODEL_DIR": "/nonexistent"}, clear=True):
            with self.assertRaises(LocalSpeechConfigError):
                worker._build_stt(VOICE, None)


class FallbackDecisionTests(unittest.IsolatedAsyncioTestCase):
    def test_only_transient_provider_failures_are_recoverable(self):
        class ApiError(Exception):
            def __init__(self, status_code):
                self.status_code = status_code

        recoverable = [
            ErrorFrame(error="Failed to connect to Sarvam: timeout"),
            ErrorFrame(error="Sarvam API error", exception=ApiError(503)),
            ErrorFrame(error="Sarvam API error", exception=ApiError(429)),
            ErrorFrame(error="x", exception=ConnectionResetError()),
            ErrorFrame(error="x", exception=LocalSpeechError("timeout", "t", True)),
        ]
        not_recoverable = [
            ErrorFrame(error="Sarvam API error", exception=ApiError(401)),
            ErrorFrame(error="Sarvam API error: 403 Forbidden: invalid api key"),
            ErrorFrame(error="x", exception=LocalSpeechError("unsupported_language", "u", False)),
            ErrorFrame(error="x", exception=KeyError("bug")),  # a programming error
            ErrorFrame(error="something unexpected"),  # unclassified is not "recoverable"
            ErrorFrame(error="connection lost", fatal=True),
        ]
        self.assertEqual([is_recoverable(e) for e in recoverable], [True] * len(recoverable))
        self.assertEqual([is_recoverable(e) for e in not_recoverable], [False] * len(not_recoverable))

    async def test_switches_once_on_a_recoverable_failure_and_never_wraps(self):
        primary, fallback = LocalSTTService(engine=StandInEngine(), sample_rate=RATE), LocalSTTService(engine=StandInEngine(), sample_rate=RATE)
        strategy = RecoverableFailover([primary, fallback])
        switched = []

        async def on_switched(_strategy, service):
            switched.append(service)

        strategy.add_event_handler("on_service_switched", on_switched)
        self.assertIsNone(await strategy.handle_error(ErrorFrame(error="403 forbidden")))
        self.assertIs(strategy.active_service, primary)
        self.assertIs(await strategy.handle_error(ErrorFrame(error="Failed to connect")), fallback)
        self.assertIs(strategy.active_service, fallback)
        # The fallback failing does not bounce the call back to the primary.
        self.assertIsNone(await strategy.handle_error(ErrorFrame(error="Failed to connect")))
        self.assertIs(strategy.active_service, fallback)
        await asyncio.sleep(0.05)  # the switch notification is dispatched as a task
        self.assertEqual(switched, [fallback])


    async def test_a_live_pipeline_moves_to_the_fallback_after_a_recoverable_failure(self):
        from speech_fallback import with_fallback

        broken, healthy = StandInEngine(fail=ConnectionError("provider unreachable")), StandInEngine(transcript="from the fallback")
        switcher = with_fallback(LocalSTTService(engine=broken, sample_rate=RATE), LocalSTTService(engine=healthy, sample_rate=RATE))
        utterance = [VADUserStartedSpeakingFrame(), audio(1.0), VADUserStoppedSpeakingFrame(), SleepFrame(0.3)]
        down, up = await run_test(switcher, frames_to_send=[*utterance, *utterance])
        # The failed utterance is reported, not replayed; the next one is heard by the fallback.
        self.assertEqual(len(of(up, ErrorFrame)), 1)
        self.assertEqual([frame.text for frame in of(down, TranscriptionFrame)], ["from the fallback"])
        self.assertIs(switcher.strategy.active_service, switcher.services[1])
        self.assertEqual(len(healthy.heard), 1)

    async def test_a_live_pipeline_stays_on_the_primary_after_a_non_recoverable_failure(self):
        from speech_fallback import with_fallback

        engine, backup = StandInEngine(), StandInEngine()
        engine.languages = ["en"]  # cannot speak Telugu: a capability gap, not an outage
        switcher = with_fallback(
            LocalTTSService(engine=engine, sample_rate=RATE, language="en-IN"),
            LocalTTSService(engine=backup, sample_rate=RATE, language="en-IN"),
        )
        await run_test(
            switcher,
            frames_to_send=[TTSSpeakFrame(text="నమస్కారం", append_to_context=False), SleepFrame(0.2),
                            TTSSpeakFrame(text="hello", append_to_context=False), SleepFrame(0.3)],
        )
        self.assertIs(switcher.strategy.active_service, switcher.services[0])
        self.assertEqual(engine.spoken, [("en", "hello")])
        self.assertEqual(backup.spoken, [])


REAL_MODELS = os.environ.get("VOICE_LOCAL_MODEL_DIR", "")


@unittest.skipUnless(os.path.isfile(os.path.join(REAL_MODELS, "manifest.json")), "needs provisioned local models")
class RealModelTests(unittest.IsolatedAsyncioTestCase):
    """Real inference: what the local voice says, the local recognizer hears."""

    async def test_spoken_english_and_telugu_are_recognized(self):
        import difflib
        import re

        engine = get_engine(REAL_MODELS)
        # As the worker does at startup: a call never pays for the model load.
        engine.load_stt()
        engine.load_tts()
        for language, text in (
            ("en-IN", "Hello, I would like to book an appointment."),
            ("te-IN", "నమస్కారం, నాకు అపాయింట్మెంట్ కావాలి."),
        ):
            down, _ = await run_test(
                LocalTTSService(engine=engine, sample_rate=RATE, language=language),
                frames_to_send=[TTSSpeakFrame(text=text, append_to_context=False), SleepFrame(4.0)],
            )
            pcm = b"".join(frame.audio for frame in of(down, TTSAudioRawFrame))
            self.assertGreater(len(pcm), RATE)  # more than half a second of speech
            heard, _ = await run_test(
                LocalSTTService(engine=engine, sample_rate=RATE),
                frames_to_send=[
                    VADUserStartedSpeakingFrame(),
                    InputAudioRawFrame(audio=pcm, sample_rate=RATE, num_channels=1),
                    VADUserStoppedSpeakingFrame(),
                    SleepFrame(6.0),
                ],
            )
            transcript = " ".join(frame.text for frame in of(heard, TranscriptionFrame))
            # Close, not exact: the local recognizer drops the odd vowel
            # length at wire band (docs/LOCAL_SPEECH.md has the measured rates).
            plain = lambda value: re.sub(r"[^\w\s\u0c00-\u0c7f]", "", value.lower()).strip()
            similarity = difflib.SequenceMatcher(None, plain(text), plain(transcript)).ratio()
            self.assertGreater(similarity, 0.8, transcript)


if __name__ == "__main__":
    unittest.main()
