import json
import unittest
from halo_serializer import HaloMediaSerializer
from pipecat.audio.dtmf.types import KeypadEntry

class SerializerTests(unittest.IsolatedAsyncioTestCase):
    async def test_audio_has_wire_sample_rate(self):
        frame = await HaloMediaSerializer().deserialize(json.dumps({"event": "media", "payload": "/w=="}))
        self.assertEqual(frame.sample_rate, 8000)
        self.assertEqual(frame.audio, bytes([0, 0]))

    async def test_dtmf_uses_pipecat_enum(self):
        frame = await HaloMediaSerializer().deserialize(json.dumps({"event": "dtmf", "digit": "5"}))
        self.assertEqual(frame.button, KeypadEntry.FIVE)
        self.assertIn("5", str(frame))
        self.assertIsNone(await HaloMediaSerializer().deserialize(json.dumps({"event": "dtmf", "digit": "bad"})))

    async def test_malformed_frames_are_ignored(self):
        for value in ["[]", "null", '"text"', '{"event":"media","payload":"!"}']:
            self.assertIsNone(await HaloMediaSerializer().deserialize(value))

    async def test_twilio_wire_envelope_and_call_binding(self):
        start = {"event": "start", "start": {"streamSid": "MZ-test", "callSid": "CA-test",
            "customParameters": {"callId": "CA-test"},
            "mediaFormat": {"encoding": "audio/x-mulaw", "sampleRate": 8000, "channels": 1}}}
        serializer = HaloMediaSerializer(start_event=start)
        frame = await serializer.deserialize(json.dumps({"event": "media", "streamSid": "MZ-test", "media": {"payload": "/w=="}}))
        self.assertEqual(frame.audio, bytes([0, 0]))
        self.assertIsNone(await serializer.deserialize(json.dumps({"event": "media", "streamSid": "other", "media": {"payload": "/w=="}})))
        output = json.loads(serializer._serialize_audio(bytes([0, 0]))[0])
        self.assertEqual(output, {"event": "media", "streamSid": "MZ-test", "media": {"payload": "/w=="}})
        self.assertEqual(json.loads(serializer.encode_mark("played"))["mark"], {"name": "played"})
        start["start"]["callSid"] = "other"
        with self.assertRaises(ValueError):
            HaloMediaSerializer(start_event=start)
