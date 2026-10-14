"""Generate reviewer WAVs from the already-installed local speech manifest.

Run: .venv/bin/python scripts/generate-local-telugu-review-tts.py
Writes only under ignored models/local-speech-benchmark/tts-samples/review-packet/.
No models are downloaded.
"""

from __future__ import annotations

import json
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "models/voice-local"
OUT_DIR = ROOT / "models/local-speech-benchmark/tts-samples/review-packet"
TEXTS = {
    "te_short": ("te", "నమస్కారం, మీకు ఏ సమాచారం కావాలి?"),
    "te_long": ("te", "నమస్కారం. వచ్చే సోమవారం ఉదయం పది గంటలకు మీ సైట్ విజిట్‌ను నమోదు చేయాలా? దయచేసి తేదీ, సమయం సరైనవో చెప్పండి."),
    "te_name_date_time": ("te", "శ్రీలక్ష్మి రెడ్డి గారికి, మార్చి ఇరవై నాలుగో తేదీ ఉదయం పది గంటలకు అపాయింట్‌మెంట్ ఉంది."),
    "te_phone": ("te", "మీ ఫోన్ నంబర్ తొమ్మిది ఎనిమిది ఏడు ఆరు ఐదు నాలుగు మూడు రెండు ఒకటి సున్నా అని నమోదు చేశాను. ఇది సరైనదేనా?"),
    "te_booking": ("te", "శనివారం సాయంత్రం ఐదు గంటలకు సైట్ విజిట్ బుక్ చేయాలా? అవునంటేనే బుకింగ్ పూర్తి చేస్తాను."),
    "en_switch": ("en", "I will confirm the appointment time now."),
}


def main() -> None:
    manifest = json.loads((MODEL_DIR / "manifest.json").read_text(encoding="utf-8"))
    tts = manifest["tts"]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    engines = {}
    for language in {value[0] for value in TEXTS.values()}:
        voice = tts["voices"][language]
        model = sherpa_onnx.OfflineTtsModelConfig(
            vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                model=str(MODEL_DIR / voice["model"]),
                tokens=str(MODEL_DIR / voice["tokens"]),
                data_dir=str(MODEL_DIR / tts["dataDir"]),
            ),
            num_threads=4,
        )
        engines[language] = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=model, max_num_sentences=1))
    for item_id, (language, text) in TEXTS.items():
        audio = engines[language].generate(text, sid=0, speed=1.0)
        values = np.clip(np.asarray(audio.samples) * 32767, -32768, 32767).astype("<i2")
        target = OUT_DIR / f"{item_id}.wav"
        with wave.open(str(target), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(audio.sample_rate)
            output.writeframes(values.tobytes())
        print(f"{target.relative_to(ROOT)} voice={tts['voices'][language]['id']} rate={audio.sample_rate} text={text}")


if __name__ == "__main__":
    main()
