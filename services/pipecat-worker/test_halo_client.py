"""Protocol tests for the HALO control client.

Pure Python, no Pipecat and no network: a fake connection stands in for the
WebSocket. These pin the wire format the TypeScript side validates, so a
change on either side that breaks the other fails here or there.

    python3 -m unittest discover -s services/pipecat-worker
"""

from __future__ import annotations

import asyncio
import json
import unittest

from halo_client import Handlers, HaloControlClient, SpeakRequest

READY = {
    "type": "ready",
    "protocol": "1.0",
    "session": {
        "tenantId": "biz-1",
        "agentId": "agent-1",
        "agentVersionId": "av-1",
        "agentVersion": 3,
        "callId": "call-1",
        "sessionId": "call-1",
        "conversationId": "conv-1",
        "correlationId": "corr-1",
    },
    "voice": {
        "language": "te-IN",
        "alternativeLanguages": ["en-IN"],
        "phraseHints": ["solar"],
        "vad": {"minSpeechMs": 120, "endHangoverMs": 900},
        "bargeIn": {"enabled": True, "minSpeechMs": 250},
        "maxCallDurationMs": 600000,
    },
}


class FakeConnection:
    def __init__(self, inbound):
        self.sent = []
        self._inbound = list(inbound)
        self.closed = False

    async def send(self, message):
        self.sent.append(json.loads(message))

    async def recv(self):
        if not self._inbound:
            raise ConnectionError("closed")
        frame = self._inbound.pop(0)
        return frame if isinstance(frame, (str, bytes)) else json.dumps(frame)

    async def close(self):
        self.closed = True


def build(inbound):
    events = {"ready": [], "speak": [], "stop": [], "hangup": []}

    async def on_ready(identity, voice):
        events["ready"].append((identity, voice))

    async def on_speak(request: SpeakRequest):
        events["speak"].append(request)

    async def on_stop(playback_id, reason):
        events["stop"].append((playback_id, reason))

    async def on_hangup(reason):
        events["hangup"].append(reason)

    conn = FakeConnection(inbound)
    client = HaloControlClient(
        conn,
        provider_call_id="CA-1",
        from_number="+919800000001",
        to_number="+914000000001",
        token="1780000000.deadbeef",
        handlers=Handlers(on_ready=on_ready, on_speak=on_speak, on_stop_playback=on_stop, on_hangup=on_hangup),
    )
    return client, conn, events


class HaloClientTest(unittest.TestCase):
    def test_hello_presents_the_token_and_the_signed_numbers(self):
        client, conn, _ = build([])
        asyncio.run(client.run())
        hello = conn.sent[0]
        self.assertEqual(hello["type"], "hello")
        self.assertEqual(hello["protocol"], "1.0")
        self.assertEqual(hello["providerCallId"], "CA-1")
        self.assertEqual(hello["to"], "+914000000001")
        self.assertEqual(hello["token"], "1780000000.deadbeef")

    def test_ready_is_parsed_into_identity_and_media_config(self):
        client, _, events = build([READY])
        asyncio.run(client.run())
        identity, voice = events["ready"][0]
        self.assertEqual(identity.tenant_id, "biz-1")
        self.assertEqual(identity.call_id, "call-1")
        self.assertEqual(voice.language, "te-IN")
        self.assertEqual(voice.vad_end_hangover_ms, 900)
        self.assertTrue(voice.barge_in_enabled)

    def test_speak_carries_pre_chunked_tenant_content(self):
        speak = {
            "type": "speak",
            "playbackId": "pb-1",
            "kind": "policy",
            "turnId": None,
            "chunks": ["నమస్కారం.", "మీకు రెండు నిమిషాలు వీలవుతుందా?"],
            "interruptible": True,
        }
        client, _, events = build([READY, speak])
        asyncio.run(client.run())
        request = events["speak"][0]
        self.assertEqual(request.playback_id, "pb-1")
        self.assertEqual(len(request.chunks), 2)
        self.assertTrue(request.interruptible)

    def test_hangup_ends_the_loop(self):
        client, _, events = build([READY, {"type": "hangup", "reason": "agent_completed"}, READY])
        asyncio.run(client.run())
        self.assertEqual(events["hangup"], ["agent_completed"])
        # Nothing after the hangup is processed.
        self.assertEqual(len(events["ready"]), 1)

    def test_malformed_binary_and_unknown_frames_are_ignored_not_fatal(self):
        client, _, events = build([b"\x00\x01", "{", {"type": "wat"}, READY])
        asyncio.run(client.run())
        self.assertEqual(len(events["ready"]), 1)

    def test_oversized_frames_are_dropped(self):
        client, _, events = build(["x" * 40000, READY])
        asyncio.run(client.run())
        self.assertEqual(len(events["ready"]), 1)

    def test_confidence_is_null_when_the_vendor_reports_none(self):
        client, conn, _ = build([])
        asyncio.run(client.hello())
        asyncio.run(client.transcript("naaku solar kavali", final=True, utterance_id="u1", language="te-IN"))
        frame = conn.sent[-1]
        self.assertIsNone(frame["confidence"])
        self.assertEqual(frame["utteranceId"], "u1")

    def test_transcript_text_is_bounded(self):
        client, conn, _ = build([])
        asyncio.run(client.transcript("అ" * 5000, final=True))
        self.assertEqual(len(conn.sent[-1]["text"]), 2000)

    def test_playback_reports_are_what_the_caller_actually_heard(self):
        client, conn, _ = build([])
        asyncio.run(client.playback_first_audio("pb-1"))
        asyncio.run(client.playback_chunk_played("pb-1", 0))
        asyncio.run(client.playback_stopped("pb-1", "interrupted", audio_ms=420.0))
        phases = [f["phase"] for f in conn.sent]
        self.assertEqual(phases, ["first_audio", "chunk_played", "stopped"])
        self.assertEqual(conn.sent[-1]["reason"], "interrupted")

    def test_no_frame_carries_identity_upward(self):
        client, conn, _ = build([])
        asyncio.run(client.hello())
        asyncio.run(client.speech_started())
        asyncio.run(client.transcript("hi", final=True))
        asyncio.run(client.bye("caller_hangup"))
        for frame in conn.sent[1:]:  # hello legitimately carries call identity
            for forbidden in ("tenantId", "agentId", "agentVersionId", "conversationId"):
                self.assertNotIn(forbidden, frame)


if __name__ == "__main__":
    unittest.main()
