"""The local TTS text pipeline — shared cases with the gateway.

STATUS: PASSING offline (no models). The cases live in
tests/fixtures/local-tts-text-cases.json and are also run by
tests/unit/voice/local-tts-text.test.ts: the Python and TypeScript pipelines
must say exactly the same words for the same line.

Run:  .venv/bin/python -m unittest discover -s services/pipecat-worker
"""

from __future__ import annotations

import json
import os
import re
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from local_tts_text import (  # noqa: E402
    PAUSE_MS,
    UnspeakableText,
    cardinal,
    normalize_for_speech,
    ordinal,
    pause_samples,
    plan_speech,
    trim_and_fade,
)

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tests", "fixtures", "local-tts-text-cases.json")
with open(FIXTURE, encoding="utf-8") as handle:
    CASES = json.load(handle)


class SharedFixtureTests(unittest.TestCase):
    def test_normalizes_and_segments_every_case(self):
        for case in CASES["cases"]:
            with self.subTest(text=case["text"]):
                self.assertEqual(normalize_for_speech(case["text"], case["base"], CASES["available"]), case["normalized"])
                self.assertEqual([list(s) for s in plan_speech(case["text"], case["base"], CASES["available"])], case["segments"])

    def test_refuses_text_no_installed_voice_can_speak(self):
        for case in CASES["errors"]:
            with self.subTest(text=case["text"]), self.assertRaises(UnspeakableText):
                plan_speech(case["text"], case["base"], case["available"])

    def test_cardinals_and_ordinals(self):
        for language in ("te", "en"):
            for n, words in CASES["cardinals"][language].items():
                self.assertEqual(cardinal(int(n), language), words)
            for n, words in CASES["ordinals"][language].items():
                self.assertEqual(ordinal(int(n), language), words)


class InvariantTests(unittest.TestCase):
    def test_no_digit_is_left_for_espeak(self):
        for case in CASES["cases"]:
            self.assertIsNone(re.search(r"[0-9]", normalize_for_speech(case["text"], case["base"], CASES["available"])), case["text"])

    def test_no_slash_currency_sign_or_bracket_is_left_for_espeak(self):
        for case in CASES["cases"]:
            self.assertIsNone(re.search(r"[/$₹()]", normalize_for_speech(case["text"], case["base"], CASES["available"])), case["text"])

    def test_a_booking_code_is_one_english_segment_in_either_language(self):
        for line, base in (("మీ బుకింగ్ కోడ్ AR-2041.", "te"), ("Your booking code is AR-2041.", "en")):
            holding = [language for language, text, _ in plan_speech(line, base, CASES["available"]) if "ay ar, two zero four one" in text]
            self.assertEqual(holding, ["en"], line)

    def test_a_phone_number_stays_inside_one_segment(self):
        segments = plan_speech("మీ ఫోన్ నంబర్ 9876543210, దయచేసి ఇది సరైనదేనా అని ఒకసారి చెప్పండి.", "te", CASES["available"])
        self.assertEqual(sum("తొమ్మిది ఎనిమిది ఏడు ఆరు ఐదు, నాలుగు మూడు రెండు ఒకటి సున్నా" in text for _, text, _ in segments), 1)

    def test_an_abbreviation_dot_is_not_a_sentence_end(self):
        self.assertEqual(plan_speech("Dr. Rao will call you.", "en", CASES["available"]), [("en", "Doctor Rao will call you.", "sentence")])


class JoiningTests(unittest.TestCase):
    def test_trims_keeps_a_margin_and_fades(self):
        samples = np.zeros(300, dtype=np.float32)
        samples[100:200] = 0.5
        shaped = trim_and_fade(samples, 1000, keep_ms=10, fade_ms=5)
        self.assertEqual(len(shaped), 120)
        self.assertEqual((shaped[0], shaped[-1], shaped[60]), (0.0, 0.0, 0.5))

    def test_a_silent_segment_is_left_alone(self):
        silence = np.zeros(50, dtype=np.float32)
        self.assertIs(trim_and_fade(silence, 1000), silence)

    def test_pause_length_follows_the_segment_ending(self):
        self.assertEqual(len(pause_samples("sentence", 8000)), 8000 * PAUSE_MS["sentence"] // 1000)
        self.assertEqual(len(pause_samples("switch", 8000, {"sentence": 0, "clause": 0, "switch": 20})), 160)


if __name__ == "__main__":
    unittest.main()
