"""No fake production transcripts and no carrier-controlled control URL."""
import json
import os
import unittest
from unittest.mock import AsyncMock, patch
from worker import _build_stt, _build_tts, FakeSTTService, FakeTTSService, HaloWorkerSession

class WorkerConfigurationTests(unittest.IsolatedAsyncioTestCase):
    def test_missing_credentials_do_not_select_fake_speech(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                _build_stt(None, None)
            with self.assertRaises(RuntimeError):
                _build_tts(None)

    def test_explicit_fake_mode_remains_available(self):
        with patch.dict(os.environ, {"HALO_SPEECH_PROVIDER": "fake"}, clear=True):
            self.assertIsInstance(_build_stt(None, []), FakeSTTService)
            self.assertIsInstance(_build_tts(None), FakeTTSService)

    async def test_untrusted_control_url_never_opens_a_session(self):
        class Socket:
            def __aiter__(self):
                return self.frames()
            async def frames(self):
                yield json.dumps({"event": "start", "parameters": {"haloControlUrl": "ws://attacker.invalid/control"}})
        connection = HaloWorkerSession(Socket())
        connection._run_session = AsyncMock()
        with patch.dict(os.environ, {"HALO_CONTROL_URL": "ws://trusted.invalid/control"}):
            await connection.run()
        connection._run_session.assert_not_awaited()
