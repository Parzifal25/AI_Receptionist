import base64
import io
import json
import unittest
import wave
from unittest.mock import AsyncMock, patch
from pipecat.frames.frames import ErrorFrame, TranscriptionFrame, TTSAudioRawFrame
from self_hosted_speech import SelfHostedSTT, SelfHostedTTS, endpoint

class SelfHostedSpeechTests(unittest.IsolatedAsyncioTestCase):
    async def test_stt_sends_pcm_contract_and_returns_only_valid_final(self):
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(8000)
            wav.writeframes(b'\x00\x01' * 80)
        service = SelfHostedSTT({"baseUrl": "http://speech.local"}, "en", 8000)
        with patch('self_hosted_speech.request', AsyncMock(return_value=(json.dumps({"text": "hello"}).encode(), {}))) as request:
            frames = [f async for f in service.run_stt(buffer.getvalue())]
        self.assertIsInstance(frames[0], TranscriptionFrame)
        self.assertEqual(frames[0].text, 'hello')
        self.assertEqual(base64.b64decode(request.call_args.args[2]['audio']), b'\x00\x01' * 80)

    async def test_tts_checks_rate_before_releasing_any_audio(self):
        service = SelfHostedTTS({"baseUrl": "http://speech.local"}, "en", "voice", 1, 8000)
        with patch('self_hosted_speech.request', AsyncMock(return_value=(b'\x00\x01', {"Content-Type": "audio/pcm", "x-audio-sample-rate": "16000"}))):
            frames = [f async for f in service.run_tts('hello', 'context')]
        self.assertTrue(all(not isinstance(f, TTSAudioRawFrame) for f in frames))
        self.assertIsInstance(frames[0], ErrorFrame)

    async def test_valid_tts_preserves_rate_and_context(self):
        service = SelfHostedTTS({"baseUrl": "http://speech.local"}, "en", None, None, 16000)
        with patch('self_hosted_speech.request', AsyncMock(return_value=(b'\x00\x01', {"Content-Type": "audio/pcm", "x-audio-sample-rate": "16000"}))):
            frames = [f async for f in service.run_tts('hello', 'context')]
        self.assertEqual(frames[0].sample_rate, 16000)
        self.assertEqual(frames[0].context_id, 'context')

    def test_rejects_credentials_and_redirectable_endpoint_suffixes(self):
        for url in ('file:///tmp/model', 'http://user:pass@host', 'http://host?redirect=other'):
            with self.assertRaises(ValueError):
                endpoint({"baseUrl": url}, 'transcribe')
