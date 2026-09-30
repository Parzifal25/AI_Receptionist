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
