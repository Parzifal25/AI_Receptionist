"""Small real-model spot check for the ignored local speech artifacts.

Run with: .venv/bin/python scripts/check-local-speech-inference.py
No files are downloaded or written.
"""

from __future__ import annotations

import json
import time
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx


ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "models/voice-local"
CORPUS = ROOT / "models/local-speech-benchmark/corpus"


def main() -> None:
    manifest = json.loads((MODEL_DIR / "manifest.json").read_text(encoding="utf-8"))
    stt = manifest["stt"]
    recognizer = sherpa_onnx.OfflineRecognizer.from_omnilingual_asr_ctc(
        model=str(MODEL_DIR / stt["model"]),
        tokens=str(MODEL_DIR / stt["tokens"]),
        num_threads=4,
    )

    for name in ("te-1.wav", "en-7.wav", "mix-4.wav"):
        with wave.open(str(CORPUS / name), "rb") as source:
            samples = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(np.float32) / 32768
            sample_rate = source.getframerate()
        started = time.perf_counter()
        stream = recognizer.create_stream()
        stream.accept_waveform(sample_rate, samples)
        recognizer.decode_stream(stream)
        elapsed = time.perf_counter() - started
        print(f"STT {name}: input_s={len(samples) / sample_rate:.2f} decode_s={elapsed:.3f} text={stream.result.text!r}")

    tts = manifest["tts"]
    examples = {
        "te": "నమస్కారం, మీకు ఏ సమాచారం కావాలి?",
        "en": "Sure, I can help you with the installation details.",
    }
    for language, text in examples.items():
        voice = tts["voices"][language]
        model = sherpa_onnx.OfflineTtsModelConfig(
            vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                model=str(MODEL_DIR / voice["model"]),
                tokens=str(MODEL_DIR / voice["tokens"]),
                data_dir=str(MODEL_DIR / tts["dataDir"]),
            ),
            num_threads=4,
        )
        engine = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=model, max_num_sentences=1))
        started = time.perf_counter()
        audio = engine.generate(text, sid=0, speed=1.0)
        elapsed = time.perf_counter() - started
        duration = len(audio.samples) / audio.sample_rate
        print(f"TTS {language}: synth_s={elapsed:.3f} output_s={duration:.2f} sample_rate={audio.sample_rate}")


if __name__ == "__main__":
    main()
