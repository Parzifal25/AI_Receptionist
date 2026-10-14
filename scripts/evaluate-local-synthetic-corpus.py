"""Fresh, explicitly synthetic STT check; never counts as human Telugu evidence.

Run: .venv/bin/python scripts/evaluate-local-synthetic-corpus.py
Uses only models/voice-local/ and the ignored Sarvam-TTS benchmark corpus.
No network access and no output files are created.
"""

from __future__ import annotations

import json
import re
import unicodedata
import wave
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import sherpa_onnx
import soxr

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "models/voice-local"
CORPUS_DIR = ROOT / "models/local-speech-benchmark/corpus"


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFC", text.lower())
    text = re.sub(r"[^\w\sఀ-౿]", " ", text)
    text = "".join(ch for ch in text if ch not in "‌‍")
    return re.sub(r"\s+", " ", text).strip()


def script_counts(texts: list[str]) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for text in texts:
        for char in text:
            if not char.isalpha() and unicodedata.category(char)[0] != "M":
                continue
            code = ord(char)
            counts["telugu" if 0x0C00 <= code <= 0x0C7F else "latin" if code < 0x250 else "other"] += 1
    return dict(counts)


def edits(reference: list[str], hypothesis: list[str]) -> int:
    previous = list(range(len(hypothesis) + 1))
    for row, ref_token in enumerate(reference, start=1):
        current = [row]
        for column, hyp_token in enumerate(hypothesis, start=1):
            current.append(min(
                current[-1] + 1,
                previous[column] + 1,
                previous[column - 1] + (ref_token != hyp_token),
            ))
        previous = current
    return previous[-1]


def main() -> None:
    manifest = json.loads((MODEL_DIR / "manifest.json").read_text(encoding="utf-8"))
    corpus = json.loads((CORPUS_DIR / "corpus.json").read_text(encoding="utf-8"))
    if len(corpus) != 9 or any(item.get("source") != "Sarvam TTS (synthetic)" for item in corpus):
        raise ValueError("Expected exactly the nine manifest-listed synthetic Sarvam TTS clips")
    stt = manifest["stt"]
    recognizer = sherpa_onnx.OfflineRecognizer.from_omnilingual_asr_ctc(
        model=str(MODEL_DIR / stt["model"]), tokens=str(MODEL_DIR / stt["tokens"]), num_threads=4
    )
    rows: dict[tuple[str, str], list[tuple[str, str, str]]] = defaultdict(list)
    print(f"model={stt['id']} runtime={stt['engine']} model_rate={stt['sampleRate']} threads=4")
    for clip in corpus:
        path = CORPUS_DIR / clip["path"].split("corpus/", 1)[-1]
        with wave.open(str(path), "rb") as source:
            if source.getnchannels() != 1 or source.getsampwidth() != 2:
                raise ValueError(f"Expected mono PCM16: {path}")
            audio = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(np.float32) / 32768
            source_rate = source.getframerate()
        if abs(len(audio) / source_rate - clip["seconds"]) > 0.02:
            raise ValueError(f"Manifest duration mismatch for {path}")
        audio16 = soxr.resample(audio, source_rate, stt["sampleRate"]).astype(np.float32)
        audio8 = soxr.resample(soxr.resample(audio16, stt["sampleRate"], 8000), 8000, stt["sampleRate"]).astype(np.float32)
        ref = clip["ref"]
        refs = [normalize(ref)]
        if clip.get("ref_te"):
            refs.append(normalize(clip["ref_te"]))
        for band, audio in (("16k", audio16), ("8k_wire", audio8)):
            stream = recognizer.create_stream()
            stream.accept_waveform(stt["sampleRate"], audio)
            recognizer.decode_stream(stream)
            hyp = stream.result.text.strip()
            hyp_norm = normalize(hyp) or "∅"
            best_ref = min(refs, key=lambda value: edits(list(value), list(hyp_norm)) / max(1, len(value)))
            key = {"te": "telugu", "mix": "tenglish", "en": "english"}[clip["lang"]]
            rows[(band, key)].append((best_ref, hyp_norm, hyp))
            print(f"{clip['id']} band={band} source={clip['source']} ref={ref!r} hyp={hyp!r}")

    for (band, group), group_rows in rows.items():
        refs = [r[0] for r in group_rows]
        hyps = [r[1] for r in group_rows]
        scripts = script_counts([r[2] for r in group_rows])
        total = sum(scripts.values()) or 1
        shares = {key: round(value / total, 3) for key, value in scripts.items()}
        word_errors = sum(edits(ref.split(), hyp.split()) for ref, hyp in zip(refs, hyps))
        char_errors = sum(edits(list(ref), list(hyp)) for ref, hyp in zip(refs, hyps))
        reference_words = sum(len(ref.split()) for ref in refs)
        reference_chars = sum(len(ref) for ref in refs)
        print(
            f"SUMMARY {band}/{group} n={len(group_rows)} WER={100 * word_errors / max(1, reference_words):.1f}% "
            f"CER={100 * char_errors / max(1, reference_chars):.1f}% "
            f"word_errors={word_errors}/{reference_words} char_errors={char_errors}/{reference_chars} script_shares={shares}"
        )
    print("SCOPE synthetic Sarvam-TTS audio only; no human-audio acceptance inference.")


if __name__ == "__main__":
    main()
