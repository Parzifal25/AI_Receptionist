"""W4.3 delivery and cancellation contracts, actual MediaGate with fake frames."""
import asyncio
import unittest
from halo_client import SpeakRequest
from pipecat.frames.frames import TTSSpeakFrame, TTSStartedFrame, TTSAudioRawFrame, TTSStoppedFrame
from pipecat.processors.frame_processor import FrameDirection
import test_media_gate as harness
from test_media_gate import pcm, RATE

class ChunkPipelineTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = harness.MediaGateTests.asyncSetUp
    sent = harness.MediaGateTests.sent
    _wait_armed = harness.MediaGateTests._wait_armed

    async def asyncTearDown(self):
        await self.gate.close()
        await self.gate.cleanup()
        await self.sink.cleanup()

    async def start(self):
        self.pending = []
        self.mark_order = []
        def starter(playback_id, index):
            self.mark_order.append(index)
            future = asyncio.get_running_loop().create_future()
            self.pending.append(future)
            return future
        self.gate.set_playout_starter(starter)
        await self.gate.on_speak(SpeakRequest(playback_id='pb', kind='reply', turn_id='t', chunks=['First.', 'Second.', 'Third.'], interruptible=True))
        await self._wait_armed()

    async def synth(self, index):
        ctx = f'ctx-{index}'
        await self.gate.process_frame(TTSStartedFrame(context_id=ctx), FrameDirection.DOWNSTREAM)
        await self.gate.process_frame(TTSAudioRawFrame(audio=pcm(100), sample_rate=RATE, num_channels=1, context_id=ctx), FrameDirection.DOWNSTREAM)
        await self.gate.process_frame(TTSStoppedFrame(context_id=ctx), FrameDirection.DOWNSTREAM)
        await asyncio.sleep(.03)

    async def test_prefetch_is_one_chunk_and_never_confirms_delivery_before_mark(self):
        await self.start()
        await self.synth(0)
        self.assertEqual([0], self.mark_order)
        self.assertEqual(2, sum(isinstance(f, TTSSpeakFrame) for f in self.task.frames))
        self.assertEqual([], self.sent('playback_chunk_played'))
        await self.synth(1)
        self.assertEqual(2, sum(isinstance(f, TTSSpeakFrame) for f in self.task.frames))
        self.pending[0].set_result(True)
        await asyncio.sleep(.03)
        self.assertEqual([0, 1], self.mark_order)
        self.assertEqual(3, sum(isinstance(f, TTSSpeakFrame) for f in self.task.frames))
        self.assertEqual([0], [m['args'][1] for m in self.sent('playback_chunk_played')])
        await self.synth(2)
        self.pending[1].set_result(True)
        await asyncio.sleep(.03)
        self.pending[2].set_result(True)
        await asyncio.sleep(.03)
        self.assertEqual([0, 1, 2], [m['args'][1] for m in self.sent('playback_chunk_played')])
        self.assertEqual('completed', self.sent('playback_stopped')[-1]['args'][1])

    async def test_interrupt_cancels_pending_mark_and_drops_prefetched_audio(self):
        await self.start()
        await self.synth(0)
        await self.gate.on_stop_playback('pb', 'caller_speech')
        await asyncio.sleep(.03)
        self.assertTrue(self.pending[0].cancelled())
        self.assertEqual([], self.sent('playback_chunk_played'))
        before = len(self.sink.frames)
        await self.gate.process_frame(TTSAudioRawFrame(audio=pcm(100), sample_rate=RATE, num_channels=1, context_id='ctx-1'), FrameDirection.DOWNSTREAM)
        self.assertEqual(before, len(self.sink.frames))
        self.assertEqual(['interrupted'], [m['args'][1] for m in self.sent('playback_stopped')])

    async def test_failed_mark_never_reports_completed(self):
        await self.start()
        await self.synth(0)
        self.pending[0].set_result(False)
        await asyncio.sleep(.03)
        self.assertEqual([], self.sent('playback_chunk_played'))
        self.assertEqual(['failed'], [m['args'][1] for m in self.sent('playback_stopped')])

    async def test_close_cancels_pending_mark(self):
        await self.start()
        await self.synth(0)
        await self.gate.close()
        await asyncio.sleep(.03)
        self.assertTrue(self.pending[0].cancelled())
        self.assertEqual([], self.sent('playback_chunk_played'))

    async def test_mark_exception_clears_prefetch_without_logging_vendor_payload(self):
        await self.start()
        with self.assertLogs("halo.gate", level="ERROR") as captured:
            await self.synth(0)
            self.pending[0].set_exception(RuntimeError("synthetic-private-customer-text"))
            await asyncio.sleep(.03)
        self.assertNotIn("synthetic-private-customer-text", " ".join(captured.output))
        self.assertEqual(['failed'], [m['args'][1] for m in self.sent('playback_stopped')])
        self.assertEqual([], self.sent('playback_chunk_played'))
        self.assertIsNone(self.gate._active)


if __name__ == '__main__': unittest.main()
