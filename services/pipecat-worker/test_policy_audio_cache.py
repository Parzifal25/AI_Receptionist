"""W4.9: fixed policy replay, startup, and codec boundaries; no provider calls."""
import asyncio
import base64
import json
import unittest
from unittest.mock import AsyncMock, patch
from halo_client import SpeakRequest
from media_gate import _audio_ms
from policy_audio_cache import PolicyAudioCache
from pipecat.frames.frames import TTSSpeakFrame, TTSStartedFrame, TTSAudioRawFrame, TTSStoppedFrame
from pipecat.processors.frame_processor import FrameDirection
import test_media_gate as harness
import test_speech_minimums as speech
from test_media_gate import pcm, RATE

class PolicyAudioTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = harness.MediaGateTests.asyncSetUp
    sent = harness.MediaGateTests.sent
    _wait_armed = harness.MediaGateTests._wait_armed

    async def asyncTearDown(self):
        await self.gate.close()
        await self.gate.cleanup()
        await self.sink.cleanup()

    async def prime(self):
        await self.gate.on_ready(speech.IDENTITY, speech.voice())
        await self.gate.on_speak(SpeakRequest('p1', 'policy', None, ['fixed greeting'], True))
        await self._wait_armed()
        await self.gate.process_frame(TTSStartedFrame(context_id='ctx'), FrameDirection.DOWNSTREAM)
        await self.gate.process_frame(TTSAudioRawFrame(audio=pcm(100), sample_rate=RATE, num_channels=1, context_id='ctx'), FrameDirection.DOWNSTREAM)
        await self.gate.process_frame(TTSStoppedFrame(context_id='ctx'), FrameDirection.DOWNSTREAM)
        await asyncio.sleep(.03)

    async def test_cache_hit_still_needs_its_own_mark_and_uses_a_new_audio_context(self):
        pending = []
        def start(*args):
            future = asyncio.get_running_loop().create_future(); pending.append(future); return future
        self.gate.set_playout_starter(start)
        await self.prime()
        pending[0].set_result(True); await asyncio.sleep(.03)
        before = self.gate._tts_characters
        await self.gate.on_speak(SpeakRequest('p2', 'policy', None, ['fixed greeting'], True))
        await asyncio.sleep(.03)
        self.assertEqual(1, sum(isinstance(f, TTSSpeakFrame) for f in self.task.frames))
        self.assertEqual(before, self.gate._tts_characters)
        self.assertEqual(['p1'], [m['args'][0] for m in self.sent('playback_chunk_played')])
        self.assertEqual(2, len(pending))
        pending[1].set_result(True); await asyncio.sleep(.03)
        self.assertEqual(['p1', 'p2'], [m['args'][0] for m in self.sent('playback_chunk_played')])
        audio = [f for f in self.sink.frames if isinstance(f, TTSAudioRawFrame)]
        self.assertEqual(2, len(audio)); self.assertNotEqual(audio[0].context_id, audio[1].context_id)

    async def test_reply_and_other_language_never_reuse_fixed_policy_audio(self):
        await self.prime()
        await self.gate.on_speak(SpeakRequest('reply', 'reply', 'turn', ['fixed greeting'], True))
        await self._wait_armed()
        self.assertEqual(2, sum(isinstance(f, TTSSpeakFrame) for f in self.task.frames))
        await self.gate.on_stop_playback('reply', 'test'); await asyncio.sleep(.03)
        await self.gate.on_speak(SpeakRequest('english', 'policy', None, ['fixed greeting'], True, language='en-IN'))
        await self._wait_armed()
        self.assertEqual(3, sum(isinstance(f, TTSSpeakFrame) for f in self.task.frames))

    async def test_fallback_and_close_clear_cached_audio(self):
        await self.prime()
        self.assertTrue(self.gate._policy_audio._rows)
        self.gate.forget_tts_language()
        self.assertFalse(self.gate._policy_audio._rows)
        await self.gate.close()
        self.assertFalse(self.gate._policy_audio._rows)

    async def test_a_separate_call_does_not_inherit_audio_even_with_the_same_tenant_voice(self):
        await self.prime()
        second = harness.MediaGateTests(); await second.asyncSetUp()
        try:
            await second.gate.on_ready(speech.IDENTITY, speech.voice())
            await second.gate.on_speak(SpeakRequest('other-call', 'policy', None, ['fixed greeting'], True))
            await second._wait_armed()
            self.assertEqual(1, sum(isinstance(f, TTSSpeakFrame) for f in second.task.frames))
            self.assertEqual([], second.sent('playback_chunk_played'))
        finally:
            await second.gate.close(); await second.gate.cleanup(); await second.sink.cleanup()

    async def test_early_greeting_waits_for_binding_and_can_be_cancelled_before_startup(self):
        self.gate._task = None; self.gate._task_ready.clear()
        await self.gate.on_speak(SpeakRequest('early', 'policy', None, ['fixed greeting'], True))
        await asyncio.sleep(.03)
        self.assertEqual([], self.task.frames)
        await self.gate.on_stop_playback('early', 'cancelled')
        self.gate.bind_task(self.task); await asyncio.sleep(.03)
        self.assertEqual([], self.task.frames)
        self.assertEqual(['interrupted'], [m['args'][1] for m in self.sent('playback_stopped')])

    async def test_fallback_during_synthesis_discards_the_partial_cache_capture(self):
        await self.gate.on_ready(speech.IDENTITY, speech.voice())
        await self.gate.on_speak(SpeakRequest('partial-policy', 'policy', None, ['fixed greeting'], True))
        await self._wait_armed()
        await self.gate.process_frame(TTSStartedFrame(context_id='partial'), FrameDirection.DOWNSTREAM)
        await self.gate.process_frame(TTSAudioRawFrame(audio=pcm(100), sample_rate=RATE, num_channels=1, context_id='partial'), FrameDirection.DOWNSTREAM)
        self.gate.forget_tts_language()
        await self.gate.process_frame(TTSStoppedFrame(context_id='partial'), FrameDirection.DOWNSTREAM)
        await asyncio.sleep(.03)
        self.assertFalse(self.gate._policy_audio._rows)


class CacheBoundsTests(unittest.TestCase):
    def test_lru_is_bounded_and_different_tenant_voice_keys_never_match(self):
        cache = PolicyAudioCache(max_entries=2, max_bytes=16)
        frames = [(b'1234', RATE, 1, 'mulaw')]
        cache.put(('tenant-a', 'voice-a'), frames)
        self.assertIsNone(cache.get(('tenant-b', 'voice-a')))
        self.assertIsNone(cache.get(('tenant-a', 'voice-b')))
        cache.put(('b',), frames); cache.put(('c',), frames)
        self.assertIsNone(cache.get(('tenant-a', 'voice-a')))
        self.assertLessEqual(cache._bytes, 16)
        cache.put(('huge',), [(b'x' * 129000, RATE, 1, 'pcm16')])
        self.assertIsNone(cache.get(('huge',)))

class WireCodecTests(unittest.IsolatedAsyncioTestCase):
    async def test_pinned_sarvam_adapter_preserves_requested_codec_with_settings_and_tags_frames(self):
        from sarvam_wire_tts import SarvamWireTTSService
        from pipecat.services.sarvam.tts import SarvamTTSService
        service = SarvamWireTTSService(api_key='synthetic', output_codec='mulaw', settings=SarvamTTSService.Settings(model='bulbul:v2'))
        self.assertEqual('mulaw', service._output_audio_codec)
        from pipecat.services.tts_service import InterruptibleTTSService
        from pipecat.frames.frames import StartFrame
        service._sample_rate = RATE
        service._connect = AsyncMock()
        with patch.object(InterruptibleTTSService, 'start', new=AsyncMock()):
            await service.start(StartFrame(audio_out_sample_rate=RATE))
        service._connect.assert_awaited_once()  # startup, before any speak request
        socket = type('Socket', (), {'send': AsyncMock()})()
        service._websocket = socket
        await service._send_config()
        self.assertEqual('mulaw', json.loads(socket.send.call_args.args[0])['data']['output_audio_codec'])
        frame = TTSAudioRawFrame(audio=b'\xff' * 800, sample_rate=RATE, num_channels=1, context_id='ctx')
        with patch.object(SarvamTTSService, 'append_to_audio_context', new=AsyncMock()) as append:
            await service.append_to_audio_context('ctx', frame)
            append.assert_awaited_once()
        self.assertEqual('mulaw', frame.metadata['halo_audio_encoding'])
        self.assertEqual(800, frame.num_frames)
        self.assertEqual(100, _audio_ms(frame.audio, RATE, 'mulaw'))

    async def test_raw_mulaw_serializer_is_bit_exact_and_pcm_path_remains_unchanged(self):
        from halo_serializer import HaloMediaSerializer
        from halo_codec import pcm16_to_mulaw
        serializer = HaloMediaSerializer(start_event={'event':'start', 'callId':'c', 'parameters':{}})
        audio = bytes(range(256)) * 4
        packets = serializer._serialize_audio(audio, 'mulaw')
        decoded = b''.join(base64.b64decode(json.loads(p)['payload']) for p in packets)
        self.assertEqual(audio, decoded)
        pcm_packets = serializer._serialize_audio(pcm(100))
        self.assertEqual(pcm16_to_mulaw(pcm(100)), b''.join(base64.b64decode(json.loads(p)['payload']) for p in pcm_packets))
        with self.assertRaises(ValueError): serializer._serialize_audio(audio, 'unknown')

if __name__ == '__main__': unittest.main()
