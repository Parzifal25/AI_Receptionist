"""Synthetic worker failures must retain categories without exception contents."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from worker import HaloWorkerSession


class WorkerLogPrivacyTests(unittest.IsolatedAsyncioTestCase):
    async def test_session_crash_and_untrusted_start_ids_do_not_leak(self):
        connection = HaloWorkerSession(None)
        connection._recv_start = AsyncMock(return_value={
            "event": "start", "streamId": "synthetic-private\nforged",
        })
        connection._run_session = AsyncMock(side_effect=RuntimeError("synthetic-private-token"))
        connection._teardown = AsyncMock()
        serializer = SimpleNamespace(parameters={
            "callId": "synthetic-private-customer", "haloControlUrl": "ws://synthetic/control",
        })
        with patch("worker.HaloMediaSerializer", return_value=serializer), patch.dict(
            "os.environ", {"HALO_CONTROL_URL": "ws://synthetic/control"}
        ), self.assertLogs("halo.worker", level="INFO") as captured:
            await connection.run()
        output = "\n".join(captured.output)
        self.assertIn("session crashed", output)
        self.assertNotIn("synthetic-private", output)
        connection._run_session.assert_awaited_once()
        connection._teardown.assert_awaited_once()

    def test_inference_frame_does_not_carry_upstream_exception(self):
        from local_speech import _error_frame
        try:
            raise RuntimeError("synthetic-private-token")
        except RuntimeError:
            frame = _error_frame("local_stt_failed", "inference")
        self.assertNotIn("synthetic-private", str(frame.exception))
        self.assertEqual(frame.exception.code, "inference")
        self.assertEqual(frame.exception.__traceback__.tb_frame.f_code.co_name, "_error_frame")
        self.assertIsNone(frame.exception.__traceback__.tb_next)
        self.assertIsNone(frame.exception.__cause__)
        self.assertIsNone(frame.exception.__context__)
