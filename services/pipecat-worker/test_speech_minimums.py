"""W4.1 / G6.4 — the worker honours HALO's VAD and barge-in minimums.

The worker parsed `vad.minSpeechMs` and `bargeIn.minSpeechMs` from `ready`
but never applied them: Silero ran on its own start threshold and any VAD
start cut the agent off, so a cough or a backchannel ("hmm") interrupted it.
These tests drive the gate with frames (no network, no pipeline) and check
the VAD builder's parameters.

    .venv/bin/python -m unittest discover -s services/pipecat-worker -p 'test_speech_minimums.py'
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from halo_client import SessionIdentity, SpeakRequest, VoiceConfig
from pipecat.frames.frames import (
    InputAudioRawFrame,
    InterimTranscriptionFrame,
    InterruptionFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TranscriptionFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection
import test_media_gate as gate_harness  # module import: its TestCase must not be re-collected here
from test_media_gate import RATE, pcm
from worker import _build_vad

IDENTITY = SessionIdentity.from_json({
    "tenantId": "t-1", "agentId": "a-1", "agentVersionId": "av-1", "agentVersion": 1,
    "callId": "call-1", "sessionId": "call-1", "conversationId": "conv-1",
    "correlationId": "11111111-1111-4111-8111-111111111111",
})


def voice(vad_min: int = 120, barge_min: int = 250, hangover: int = 900) -> VoiceConfig:
    return VoiceConfig.from_json({
        "language": "te-IN",
        "vad": {"minSpeechMs": vad_min, "endHangoverMs": hangover},
        "bargeIn": {"enabled": True, "minSpeechMs": barge_min},
        "maxCallDurationMs": 600000,
    })


class SpeechMinimumTests(unittest.IsolatedAsyncioTestCase):
    """Borrows the media-gate harness (not its tests); each test configures the session first."""

    asyncSetUp = gate_harness.MediaGateTests.asyncSetUp
    _drain = gate_harness.MediaGateTests._drain
    sent = gate_harness.MediaGateTests.sent
    _wait_armed = gate_harness.MediaGateTests._wait_armed

    async def _playing(self, cfg: VoiceConfig) -> None:
        await self.gate.on_ready(IDENTITY, cfg)
        await self.gate.on_speak(SpeakRequest(playback_id="pb-1", kind="reply", turn_id="t1",
                                              chunks=["a long reply"], interruptible=True))
        await self._wait_armed()
        await self.gate.process_frame(TTSStartedFrame(context_id="ctx-1"), FrameDirection.DOWNSTREAM)
        await self.gate.process_frame(
            TTSAudioRawFrame(audio=pcm(100), sample_rate=RATE, num_channels=1, context_id="ctx-1"),
            FrameDirection.DOWNSTREAM,
        )

    async def _caller_audio(self, ms: int) -> None:
        for _ in range(ms // 20):
            await self.gate.process_frame(
                InputAudioRawFrame(audio=pcm(20), sample_rate=RATE, num_channels=1), FrameDirection.DOWNSTREAM
            )

    def _interruptions(self) -> int:
        stopped = [m for m in self.sent("playback_stopped") if m["args"][1] == "interrupted"]
        frames = [f for f in self.task.frames if isinstance(f, InterruptionFrame)]
        self.assertEqual(len(stopped), len(frames))
        return len(stopped)

    async def test_short_speech_does_not_interrupt_the_agent(self):
        await self._playing(voice(vad_min=120, barge_min=250))
        await self.gate.process_frame(VADUserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await self._caller_audio(100)  # 120 + 100 = 220 ms < 250
        await self.gate.process_frame(VADUserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await self._caller_audio(400)  # silence after the cough must not count
        await self._drain(0.05)
        self.assertEqual(0, self._interruptions())
        # HALO is still told about the speech: it owns turn-taking.
        self.assertEqual(1, len(self.sent("speech_started")))
        self.assertEqual(1, len(self.sent("speech_stopped")))
        await self.gate.close()

    async def test_sustained_speech_interrupts_exactly_once(self):
        await self._playing(voice(vad_min=120, barge_min=250))
        await self.gate.process_frame(VADUserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await self._caller_audio(120)  # 120 + 120 = 240 ms: not yet
        await self._drain(0.02)
        self.assertEqual(0, self._interruptions())
        await self._caller_audio(20)  # 260 ms: sustained
        await self._caller_audio(400)  # still talking: no second cut
        await self._drain(0.05)
        self.assertEqual(1, self._interruptions())
        await self.gate.close()

    async def test_a_transcript_during_speech_interrupts_at_once_and_is_kept(self):
        await self._playing(voice(vad_min=120, barge_min=600))
        await self.gate.process_frame(VADUserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await self._caller_audio(40)
        await self.gate.process_frame(
            InterimTranscriptionFrame(text="aagandi", user_id="", timestamp=""), FrameDirection.DOWNSTREAM
        )
        await self._drain(0.02)
        self.assertEqual(1, self._interruptions())
        await self.gate.process_frame(
            TranscriptionFrame(text="aagandi okka nimisham", user_id="", timestamp=""), FrameDirection.DOWNSTREAM
        )
        await self.gate.process_frame(VADUserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await self._drain(0.02)
        finals = [m for m in self.sent("transcript") if m["kwargs"].get("final")]
        self.assertEqual(["aagandi okka nimisham"], [m["args"][0] for m in finals])
        self.assertEqual(1, self._interruptions())
        await self.gate.close()

    async def test_a_final_transcript_alone_also_interrupts_before_it_is_held(self):
        await self._playing(voice(vad_min=120, barge_min=600))
        await self.gate.process_frame(VADUserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await self.gate.process_frame(
            TranscriptionFrame(text="vaddu", user_id="", timestamp=""), FrameDirection.DOWNSTREAM
        )
        await self.gate.process_frame(VADUserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await self._drain(0.02)
        self.assertEqual(1, self._interruptions())
        finals = [m for m in self.sent("transcript") if m["kwargs"].get("final")]
        self.assertEqual(["vaddu"], [m["args"][0] for m in finals])
        await self.gate.close()

    async def test_a_minimum_no_longer_than_the_vad_start_cuts_at_once(self):
        await self._playing(voice(vad_min=200, barge_min=150))
        await self.gate.process_frame(VADUserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await self._drain(0.02)
        self.assertEqual(1, self._interruptions())
        await self.gate.close()

    async def test_non_interruptible_lines_still_survive_sustained_speech(self):
        await self.gate.on_ready(IDENTITY, voice(vad_min=120, barge_min=250))
        await self.gate.on_speak(SpeakRequest(playback_id="pb-h", kind="policy", turn_id=None,
                                              chunks=["handoff line"], interruptible=False))
        await self._wait_armed()
        await self.gate.process_frame(TTSStartedFrame(context_id="ctx-h"), FrameDirection.DOWNSTREAM)
        await self.gate.process_frame(VADUserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await self._caller_audio(1000)
        await self._drain(0.02)
        self.assertEqual(0, self._interruptions())
        await self.gate.close()


class VadParameterTests(unittest.TestCase):
    def test_vad_start_and_stop_come_from_halo_config(self):
        params = _build_vad(voice(vad_min=180, hangover=650)).params
        self.assertAlmostEqual(0.18, params.start_secs)
        self.assertAlmostEqual(0.65, params.stop_secs)

    def test_a_zero_minimum_keeps_the_vad_default(self):
        params = _build_vad(voice(vad_min=0, hangover=0)).params
        self.assertAlmostEqual(0.2, params.start_secs)


if __name__ == "__main__":
    unittest.main()
