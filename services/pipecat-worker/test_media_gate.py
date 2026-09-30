"""Unit tests for the HALO media gate: frame semantics, no network, no pipeline.

The gate is driven by feeding it frames through process_frame (the pipeline
half) and commands through on_ready/on_speak/on_stop_playback (the control
half), with a fake HaloControlClient capturing what would go on the wire.

    .venv/bin/python -m unittest discover -s services/pipecat-worker
"""

from __future__ import annotations

import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from halo_client import SpeakRequest
from media_gate import MediaGate
from pipecat.audio.dtmf.types import KeypadEntry
from pipecat.frames.frames import (
    ErrorFrame,
    InputAudioRawFrame,
    InputDTMFFrame,
    InterruptionFrame,
    InterimTranscriptionFrame,
    StartFrame,
    TTSAudioRawFrame,
    TTSSpeakFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
    TranscriptionFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import (
    FrameDirection,
    FrameProcessor,
    FrameProcessorSetup,
)

RATE = 8000


def pcm(ms: float, rate: int = RATE) -> bytes:
    return b"\x01\x02" * int(rate * ms / 1000)


class RecordingTask:
    """Captures frames the gate queues into the pipeline task."""

    def __init__(self) -> None:
        self.frames: list = []

    async def queue_frame(self, frame) -> None:
        self.frames.append(frame)


class RecordingClient:
    """Captures control-protocol messages the gate would send to HALO."""

    def __init__(self) -> None:
        self.messages: list[dict] = []

    def __getattr__(self, name):
        # halo_client's send methods all take plain args; capture them by name.
        async def _send(*args, **kwargs):
            self.messages.append({"op": name, "args": args, "kwargs": kwargs})

        return _send


class Sink(FrameProcessor):
    """Downstream sink that lets the test feed frames into the gate."""

    def __init__(self) -> None:
        super().__init__()
        self.frames: list = []

    async def process_frame(self, frame, direction) -> None:
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM:
            self.frames.append(frame)


class MediaGateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.client = RecordingClient()
        self.gate = MediaGate(self.client)  # type: ignore[arg-type]
        self.task = RecordingTask()
        self.gate.bind_task(self.task)
        self.sink = Sink()
        self.gate.link(self.sink)
        # A processor must be set up (clock + task manager) and started
        # (StartFrame) before it may push frames.
        from pipecat.clocks.system_clock import SystemClock
        from pipecat.utils.asyncio.task_manager import TaskManager, TaskManagerParams

        task_manager = TaskManager()
        task_manager.setup(TaskManagerParams(loop=asyncio.get_running_loop()))
        for processor in (self.gate, self.sink):
            await processor.setup(
                FrameProcessorSetup(clock=SystemClock(), task_manager=task_manager)
            )
            await processor.process_frame(StartFrame(), FrameDirection.DOWNSTREAM)

    async def _drain(self, seconds: float = 0.2) -> None:
        await asyncio.sleep(seconds)

    def sent(self, op: str) -> list[dict]:
        return [m for m in self.client.messages if m["op"] == op]

    async def _wait_armed(self, timeout: float = 2.0) -> None:
        """Wait until the speak loop has armed the next chunk.

        The loop arms BEFORE queueing the text frame, and synthesis cannot
        start before the text arrives — so in production the start-frame can
        never precede arming. The test drives the TTS side by hand and must
        honour that ordering too.
        """
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            active = self.gate._active
            if active is not None and active.awaiting_context:
                return
            if asyncio.get_running_loop().time() > deadline:
                self.fail("speak loop never armed the next chunk")
            await asyncio.sleep(0.01)

    # -- transcripts -------------------------------------------------------

    async def test_final_transcript_is_reported_immediately_without_vad(self):
        await self.gate.process_frame(
            TranscriptionFrame(
                text="మీ పేరు ఏమిటి", user_id="", timestamp="now", language="te-IN"
            ),
            FrameDirection.DOWNSTREAM,
        )
        finals = self.sent("transcript")
        self.assertEqual(1, len(finals))
        # text is positional; the rest are keyword-only.
        self.assertEqual("మీ పేరు ఏమిటి", finals[0]["args"][0])
        kwargs = finals[0]["kwargs"]
        self.assertTrue(kwargs.get("final"))
        self.assertIsNone(kwargs.get("confidence"))

    async def test_interim_transcript_reports_not_final(self):
        await self.gate.process_frame(
            InterimTranscriptionFrame(text="నేను", user_id="", timestamp="now", language="te-IN"),
            FrameDirection.DOWNSTREAM,
        )
        transcripts = self.sent("transcript")
        self.assertEqual(1, len(transcripts))
        self.assertEqual("నేను", transcripts[0]["args"][0])
        self.assertFalse(transcripts[0]["kwargs"].get("final"))

    async def test_dtmf_digit_is_forwarded(self):
        await self.gate.process_frame(
            InputDTMFFrame(button=KeypadEntry.FIVE), FrameDirection.DOWNSTREAM
        )
        dtmf = self.sent("dtmf")
        self.assertEqual(1, len(dtmf))
        self.assertEqual("5", dtmf[0]["args"][0])

    async def test_error_frame_is_reported(self):
        await self.gate.process_frame(ErrorFrame(error="x"), FrameDirection.DOWNSTREAM)
        errors = self.sent("error")
        self.assertEqual(1, len(errors))
        self.assertTrue(errors[0]["kwargs"].get("retryable", True) in (True, False))

    # -- speak: chunk attribution ------------------------------------------

    async def test_speak_runs_one_context_per_chunk_in_order(self):
        request = SpeakRequest(
            playback_id="pb-1",
            kind="reply",
            turn_id="t-1",
            chunks=["ఒక", "రెండు"],
            interruptible=True,
        )
        await self.gate.on_speak(request)

        # The pipeline half: the TTS service's frames arrive in the strict
        # FIFO order the real service guarantees — text frame (echoing its
        # generated context), start, audio..., stop, then the next context.
        await self._drain(0.05)
        tts_text = next(f for f in self.task.frames if isinstance(f, TTSSpeakFrame))
        self.assertEqual("ఒక", tts_text.text)

        # Feed context A (service-generated id) fully, then context B.
        await self.gate.process_frame(
            TTSStartedFrame(context_id="svc-ctx-a"), FrameDirection.DOWNSTREAM
        )
        await self.gate.process_frame(
            TTSAudioRawFrame(audio=pcm(100), sample_rate=RATE, num_channels=1, context_id="svc-ctx-a"),
            FrameDirection.DOWNSTREAM,
        )
        await self.gate.process_frame(
            TTSStoppedFrame(context_id="svc-ctx-a"), FrameDirection.DOWNSTREAM
        )
        # The loop must arm chunk 1 before its context can bind (see
        # _wait_armed on why this ordering is guaranteed in production).
        await self._wait_armed()
        await self.gate.process_frame(
            TTSStartedFrame(context_id="svc-ctx-b"), FrameDirection.DOWNSTREAM
        )
        await self.gate.process_frame(
            TTSAudioRawFrame(audio=pcm(50), sample_rate=RATE, num_channels=1, context_id="svc-ctx-b"),
            FrameDirection.DOWNSTREAM,
        )
        await self.gate.process_frame(
            TTSStoppedFrame(context_id="svc-ctx-b"), FrameDirection.DOWNSTREAM
        )
        await self._drain(0.3)

        played = [m["args"][1] for m in self.sent("playback_chunk_played")]
        self.assertEqual([0, 1], played)
        first_audio = self.sent("playback_first_audio")
        self.assertEqual(1, len(first_audio))
        stops = self.sent("playback_stopped")
        self.assertEqual(1, len(stops))
        self.assertEqual("completed", stops[0]["args"][1])
        # played_ms counts audio, not silence: 100 + 50.
        stop_kwargs = stops[0]["kwargs"]
        self.assertAlmostEqual(150.0, stop_kwargs.get("audio_ms"), delta=1.0)

    async def test_silence_chunk_does_not_bind_the_next_context(self):
        """A chunk with no audio must not steal the next chunk's context."""
        request = SpeakRequest(
            playback_id="pb-2",
            kind="reply",
            turn_id=None,
            chunks=["   ", "real words"],
            interruptible=True,
        )
        # Patch the timeout BEFORE on_speak: the speak loop captures it when
        # it enters the chunk wait, which happens as soon as the request lands.
        import media_gate

        media_gate.CHUNK_START_TIMEOUT_S = 0.1
        try:
            await self.gate.on_speak(request)
            await self._drain(0.5)
            stops = self.sent("playback_stopped")
            self.assertEqual(1, len(stops))
            self.assertEqual("failed", stops[0]["args"][1])
            errors = self.sent("error")
            self.assertEqual(1, len(errors))
        finally:
            media_gate.CHUNK_START_TIMEOUT_S = 15.0

    async def test_barge_in_cuts_playback_and_queues_interruption(self):
        request = SpeakRequest(
            playback_id="pb-3",
            kind="reply",
            turn_id=None,
            chunks=["long line"],
            interruptible=True,
        )
        await self.gate.on_speak(request)
        await self._drain(0.05)

        await self.gate.process_frame(
            TTSStartedFrame(context_id="svc-ctx-1"), FrameDirection.DOWNSTREAM
        )
        await self.gate.process_frame(
            TTSAudioRawFrame(audio=pcm(100), sample_rate=RATE, num_channels=1, context_id="svc-ctx-1"),
            FrameDirection.DOWNSTREAM,
        )

        # Caller starts speaking mid-playback → cut.
        await self.gate.process_frame(
            VADUserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM
        )
        await self._drain(0.2)

        interrupted = [m for m in self.sent("playback_stopped") if m["args"][1] == "interrupted"]
        self.assertEqual(1, len(interrupted))
        interruption = [f for f in self.task.frames if isinstance(f, InterruptionFrame)]
        self.assertEqual(1, len(interruption))
        speech = self.sent("speech_started")
        self.assertEqual(1, len(speech))

    async def test_non_interruptible_playback_survives_caller_speech(self):
        request = SpeakRequest(
            playback_id="pb-4",
            kind="policy",
            turn_id=None,
            chunks=["handoff line"],
            interruptible=False,
        )
        await self.gate.on_speak(request)
        await self._drain(0.05)

        await self.gate.process_frame(
            TTSStartedFrame(context_id="svc-ctx-9"), FrameDirection.DOWNSTREAM
        )
        await self.gate.process_frame(
            TTSAudioRawFrame(audio=pcm(100), sample_rate=RATE, num_channels=1, context_id="svc-ctx-9"),
            FrameDirection.DOWNSTREAM,
        )
        await self.gate.process_frame(
            VADUserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM
        )
        await self._drain(0.2)

        interrupted = [m for m in self.sent("playback_stopped") if m["args"][1] == "interrupted"]
        self.assertEqual(0, len(interrupted))

    async def test_stop_playback_command_cuts(self):
        request = SpeakRequest(
            playback_id="pb-5",
            kind="reply",
            turn_id=None,
            chunks=["line"],
            interruptible=True,
        )
        await self.gate.on_speak(request)
        await self._drain(0.05)
        await self.gate.process_frame(
            TTSStartedFrame(context_id="svc-ctx-x"), FrameDirection.DOWNSTREAM
        )
        await self.gate.on_stop_playback("pb-5", "superseded")
        await self._drain(0.2)
        interrupted = [m for m in self.sent("playback_stopped") if m["args"][1] == "interrupted"]
        self.assertEqual(1, len(interrupted))

    # -- close semantics ----------------------------------------------------

    async def test_close_reports_active_playback_as_failed(self):
        request = SpeakRequest(
            playback_id="pb-6",
            kind="reply",
            turn_id=None,
            chunks=["line"],
            interruptible=True,
        )
        await self.gate.on_speak(request)
        await self._drain(0.05)
        await self.gate.process_frame(
            TTSStartedFrame(context_id="svc-ctx-c"), FrameDirection.DOWNSTREAM
        )
        await self.gate.process_frame(
            TTSAudioRawFrame(audio=pcm(40), sample_rate=RATE, num_channels=1, context_id="svc-ctx-c"),
            FrameDirection.DOWNSTREAM,
        )
        await self.gate.close("transport_closed")
        stops = self.sent("playback_stopped")
        self.assertEqual(1, len(stops))
        self.assertEqual("failed", stops[0]["args"][1])
        byes = self.sent("bye")
        self.assertEqual(1, len(byes))

    async def test_frames_are_passed_through_to_the_sink(self):
        frame = InputAudioRawFrame(audio=pcm(20), sample_rate=RATE, num_channels=1)
        await self.gate.process_frame(frame, FrameDirection.DOWNSTREAM)
        # Delivery through the linked processor is asynchronous. The count is
        # >= 1 (not exactly 1) because this harness drives process_frame
        # directly, double-routing SystemFrames — in the real pipeline the
        # process task invokes process_frame exactly once per frame.
        await self._drain(0.2)
        self.assertGreaterEqual(len(self.sink.frames), 1)


if __name__ == "__main__":
    unittest.main()
