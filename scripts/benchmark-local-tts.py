"""Local Telugu TTS benchmark: Piper Venkatesh vs Padmavathi on identical lines.

Benchmark only. Production routing and `models/voice-local/manifest.json` are
not read for voice selection and never written. Every model file is checked
against a pinned SHA-256 before use. Outputs go only to the git-ignored
`models/local-speech-benchmark/tts-te-voices/<label>/`.

    .venv/bin/python -I scripts/benchmark-local-tts.py --label legacy --pipeline legacy --stt
    .venv/bin/python -I scripts/benchmark-local-tts.py --label current --pipeline current --stt
    .venv/bin/python -I scripts/benchmark-local-tts.py --label switch-20 --pipeline current --pause switch=20 --stt
    .venv/bin/python -I scripts/benchmark-local-tts.py --label te-speed-0.9 --pipeline current --speed te=0.9 --stt
    .venv/bin/python -I scripts/benchmark-local-tts.py --label current --pipeline current --rescore
    .venv/bin/python -I scripts/benchmark-local-tts.py --label regression --pipeline current --phrases scripts/local-tts-regression-phrases.json

`--pipeline legacy` is a verbatim copy of the text routing and audio joining
the worker used before the 2026-10-14 text-pipeline change (script runs, clause
split above 60 characters, raw back-to-back concatenation). `--pipeline current`
uses `services/pipecat-worker/local_tts_text.py`, the code the worker runs.

`--stt` round-trips every WAV through the INSTALLED local recognizer
(sherpa-onnx Omnilingual 300M CTC int8) at 16 kHz and after an 8 kHz wire-band
round trip. That recognizer is weak on Telugu (see LOCAL_TELUGU_STT_HUMAN_REVIEW.md),
so its scores are a relative, machine-only regression signal between variants
on identical text. They are not intelligibility to a person. No network access.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import statistics
import sys
import time
import unicodedata
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx
import soxr

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services/pipecat-worker"))
PHRASES = ROOT / "scripts/local-tts-benchmark-phrases.json"
OUT_ROOT = ROOT / "models/local-speech-benchmark/tts-te-voices"
LOCAL = ROOT / "models/voice-local"
PADMAVATHI = ROOT / "models/local-speech-benchmark/voices/te_IN-padmavathi-medium"
DATA_DIR = LOCAL / "tts/espeak-ng-data"

# Pinned: (path, sha256). Venkatesh/Joe are the installed manifest voices;
# Padmavathi is rhasspy/piper-voices@c10ece1aade47bb51c153c893d14e5bf8e5b7117
# converted by setup_local_speech.convert_piper_voice.
PINNED = {
    "venkatesh": (LOCAL / "tts/te/model.onnx", "f84931d244c5ef4d7e1b62ed6a7664526dca06dad6c66a818e283563af440f70"),
    "padmavathi": (PADMAVATHI / "sherpa/model.onnx", "104d1d0b1d88bd243b3543a208bd98405c69e3d77f05a18055359ce867a5649b"),
    "padmavathi-source": (PADMAVATHI / "te_IN-padmavathi-medium.onnx", "414aa5960d91ceb6e45bbdf8c27fdc71af09f205130d7be4e99470f3c2cfa57d"),
    "joe": (LOCAL / "tts/en/model.onnx", "c9dc0dd883bd662937e8986af97efb25636c557469bde904dc4fcc9344cd2918"),
    "stt": (LOCAL / "stt/model.int8.onnx", "e3042b2f3b3ef0af2211bf99d2b4bf94a21f5ac0e9898827e7dd6d003a860e91"),
}
TELUGU_VOICES = {"venkatesh": LOCAL / "tts/te", "padmavathi": PADMAVATHI / "sherpa"}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def verify(names: list[str]) -> dict[str, str]:
    for name in names:
        path, expected = PINNED[name]
        if sha256(path) != expected:
            raise SystemExit(f"checksum mismatch for {name}: {path}; refusing to benchmark")
    return {name: PINNED[name][1] for name in names}


def load_voice(directory: Path, threads: int):
    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                model=str(directory / "model.onnx"), tokens=str(directory / "tokens.txt"), data_dir=str(DATA_DIR)
            ),
            num_threads=threads,
        ),
        max_num_sentences=1,
    )
    if not config.validate():
        raise SystemExit(f"invalid voice config: {directory}")
    return sherpa_onnx.OfflineTts(config)


# ---------------------------------------------------------------------------
# Legacy pipeline: verbatim copy of local_speech.py before 2026-10-14.
# ---------------------------------------------------------------------------
_L_TELUGU = re.compile(r"[ఀ-౿]")
_L_LATIN = re.compile(r"[A-Za-z]")
_L_CLAUSE_BREAK = re.compile(r"(?<=[,;:—–])\s+")
_L_SCRIPT_PIECES = re.compile(r"[ఀ-౿]+|[A-Za-z]+|[^A-Za-zఀ-౿]+")


def legacy_split_script_runs(text, base, available):
    runs = []
    for token in _L_SCRIPT_PIECES.findall(text):
        script = "te" if _L_TELUGU.match(token) else "en" if _L_LATIN.match(token) else None
        if runs and (script is None or runs[-1][0] is None or runs[-1][0] == script):
            previous_language, previous_text = runs[-1]
            runs[-1] = (previous_language or script, previous_text + token)
        else:
            runs.append((script, token))
    resolved = []
    for language, run in runs:
        language = language or base
        if language is None or language not in available:
            raise ValueError("no local voice can speak this text")
        if run.strip():
            resolved.append((language, run.strip()))
    return resolved


def legacy_split_clauses(text):
    if len(text) <= 60:
        return [text]
    pieces = []
    for part in _L_CLAUSE_BREAK.split(text):
        if pieces and len(pieces[-1]) < 25:
            pieces[-1] = f"{pieces[-1]} {part}"
        elif part.strip():
            pieces.append(part)
    return pieces


def legacy_plan(text, base, available):
    return [(language, clause, None) for language, run in legacy_split_script_runs(text, base, available) for clause in legacy_split_clauses(run)]


# ---------------------------------------------------------------------------
# Synthesis
# ---------------------------------------------------------------------------


def synthesize(voices, plan, speeds, shape, pause_for, rate):
    """Each segment at its language's speed. Returns (audio, first_audio_s, total_s, per-segment records)."""
    started = time.perf_counter()
    first = None
    parts: list[np.ndarray] = []
    records = []
    for language, text, pause in plan:
        seg_started = time.perf_counter()
        audio = voices[language].generate(text, sid=0, speed=speeds.get(language, 1.0))
        samples = np.asarray(audio.samples, dtype=np.float32)
        if audio.sample_rate != rate:
            raise SystemExit("voices must share one sample rate")
        raw_ms = len(samples) / rate * 1000
        if shape is not None:
            samples = shape(samples, rate)
        first = first if first is not None else time.perf_counter() - started
        parts.append(samples)
        if pause_for is not None:
            parts.append(pause_for(pause, rate))
        records.append({"language": language, "text": text, "pause": pause, "synth_ms": round((time.perf_counter() - seg_started) * 1000),
                        "raw_ms": round(raw_ms), "kept_ms": round(len(samples) / rate * 1000)})
    return (np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)), first, time.perf_counter() - started, records


def write_wav(path: Path, samples: np.ndarray, rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes((np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes())


def join_metrics(samples: np.ndarray, rate: int) -> dict:
    """Silence gaps (>= 30 ms below -40 dBFS, 10 ms frames) and the largest sample step."""
    frame = rate // 100
    frames = len(samples) // frame
    loud = [float(np.sqrt(np.mean(samples[i * frame:(i + 1) * frame] ** 2))) > 0.01 for i in range(frames)]
    gaps, run = [], 0
    first_loud = next((i for i, value in enumerate(loud) if value), None)
    last_loud = max((i for i, value in enumerate(loud) if value), default=None)
    if first_loud is not None:
        for value in loud[first_loud:last_loud + 1]:
            if value:
                if run >= 3:
                    gaps.append(run * 10)
                run = 0
            else:
                run += 1
    step = float(np.max(np.abs(np.diff(samples)))) if len(samples) > 1 else 0.0
    return {"gaps_ms": gaps, "lead_ms": (first_loud or 0) * 10, "tail_ms": (frames - 1 - last_loud) * 10 if last_loud is not None else 0,
            "max_step": round(step, 4), "peak": round(float(np.max(np.abs(samples))) if len(samples) else 0.0, 3)}


# ---------------------------------------------------------------------------
# Machine round trip (local recognizer only)
# ---------------------------------------------------------------------------


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFC", text.lower())
    text = re.sub(r"[^\w\sఀ-౿]", " ", text)
    text = "".join(ch for ch in text if ch not in "‌‍")
    return re.sub(r"\s+", " ", text).strip()


def edits(reference, hypothesis) -> int:
    previous = list(range(len(hypothesis) + 1))
    for row, ref_token in enumerate(reference, start=1):
        current = [row]
        for column, hyp_token in enumerate(hypothesis, start=1):
            current.append(min(current[-1] + 1, previous[column] + 1, previous[column - 1] + (ref_token != hyp_token)))
        previous = current
    return previous[-1]


DIGIT_WORDS = {
    "te": ["సున్నా", "ఒకటి", "రెండు", "మూడు", "నాలుగు", "ఐదు", "ఆరు", "ఏడు", "ఎనిమిది", "తొమ్మిది"],
    "en": ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"],
}


def expand_digits(hypothesis: str, language: str) -> str:
    """The recognizer sometimes writes a spoken digit as a numeral ("98765", "9ొమ్మిది"):
    count each numeral as the digit word of the phrase's language, so the voice is not
    blamed for the recognizer's spelling."""
    return re.sub(r"[0-9]", lambda m: f" {DIGIT_WORDS[language][int(m.group(0))]} ", hypothesis)


def score(row: dict, hyp: str) -> dict:
    norm = normalize(expand_digits(hyp, row["lang"]))
    refs = [normalize(row["ref"])] + ([normalize(row["ref_te"])] if row.get("ref_te") else [])
    ref = min(refs, key=lambda value: edits(list(value), list(norm)) / max(1, len(value)))
    return {"hyp": hyp, "char_errors": edits(list(ref), list(norm)), "ref_chars": len(ref),
            "critical_hits": critical_hits(row["critical"], norm), "critical_total": len(row["critical"])}


def critical_hits(critical: list[str], hypothesis: str) -> int:
    """Critical tokens found in spoken order (longest common subsequence)."""
    tokens = hypothesis.split()
    wanted = [set(normalize(option) for option in item.split("|")) for item in critical]
    table = [[0] * (len(tokens) + 1) for _ in range(len(wanted) + 1)]
    for i, options in enumerate(wanted, start=1):
        for j, token in enumerate(tokens, start=1):
            table[i][j] = table[i - 1][j - 1] + 1 if token in options else max(table[i - 1][j], table[i][j - 1])
    return table[-1][-1]


def round_trip(results: list[dict], out: Path, threads: int) -> None:
    stt_path, _ = PINNED["stt"]
    recognizer = sherpa_onnx.OfflineRecognizer.from_omnilingual_asr_ctc(
        model=str(stt_path), tokens=str(LOCAL / "stt/tokens.txt"), num_threads=threads
    )
    for row in results:
        if row.get("error"):
            continue
        with wave.open(str(out / row["wav"]), "rb") as source:
            rate = source.getframerate()
            audio = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(np.float32) / 32768
        audio16 = soxr.resample(audio, rate, 16000).astype(np.float32)
        audio8 = soxr.resample(soxr.resample(audio16, 16000, 8000), 8000, 16000).astype(np.float32)
        row["stt"] = {}
        for band, samples in (("16k", audio16), ("8k", audio8)):
            stream = recognizer.create_stream()
            stream.accept_waveform(16000, samples)
            recognizer.decode_stream(stream)
            row["stt"][band] = score(row, stream.result.text.strip())


def summarize(results: list[dict]) -> dict:
    summary = {}
    for voice in sorted({row["voice"] for row in results}):
        rows = [row for row in results if row["voice"] == voice and not row.get("error")]
        entry = {
            "phrases": len(rows),
            "failures": sum(1 for row in results if row["voice"] == voice and row.get("error")),
            "first_audio_ms_median": round(statistics.median(row["first_audio_ms"] for row in rows)) if rows else None,
            "first_audio_ms_max": max((row["first_audio_ms"] for row in rows), default=None),
            "total_ms_median": round(statistics.median(row["total_ms"] for row in rows)) if rows else None,
            "audio_s_total": round(sum(row["audio_ms"] for row in rows) / 1000, 2),
            "rtf_median": round(statistics.median(row["rtf"] for row in rows), 3) if rows else None,
        }
        for band in ("16k", "8k"):
            scored = [row["stt"][band] for row in rows if "stt" in row]
            if scored:
                entry[f"cer_{band}"] = round(100 * sum(s["char_errors"] for s in scored) / sum(s["ref_chars"] for s in scored), 1)
                entry[f"critical_{band}"] = f"{sum(s['critical_hits'] for s in scored)}/{sum(s['critical_total'] for s in scored)}"
        summary[voice] = entry
    return summary


def parse_overrides(values: list[str]) -> dict[str, float]:
    parsed = {}
    for value in values:
        key, _, number = value.partition("=")
        parsed[key] = float(number)
    return parsed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--label", required=True)
    parser.add_argument("--pipeline", choices=["legacy", "current"], required=True)
    parser.add_argument("--voices", default="venkatesh,padmavathi")
    parser.add_argument("--speed", action="append", default=[], help="speed override per voice language, e.g. te=0.9")
    parser.add_argument("--pause", action="append", default=[], help="current pipeline: kind=ms, e.g. switch=20")
    parser.add_argument("--shape", action="append", default=[], help="current pipeline: trim_threshold=, keep_ms=, fade_ms=")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--only", default="", help="comma-separated phrase ids")
    parser.add_argument("--phrases", type=Path, default=PHRASES, help="phrase file (default: the 28-line benchmark set)")
    parser.add_argument("--stt", action="store_true")
    parser.add_argument("--rescore", action="store_true", help="re-score the stored hypotheses of --label; synthesize nothing")
    args = parser.parse_args()
    if args.rescore:
        path = OUT_ROOT / args.label / "results.json"
        report = json.loads(path.read_text(encoding="utf-8"))
        phrases = {phrase["id"]: phrase for phrase in json.loads(args.phrases.read_text(encoding="utf-8"))["phrases"]}
        for row in report["results"]:
            phrase = phrases[row["id"]]
            row.update(ref=phrase["ref"], ref_te=phrase.get("ref_te"), critical=phrase["critical"])
            for band, scored in row.get("stt", {}).items():
                row["stt"][band] = score(row, scored["hyp"])
        report["summary"] = summarize(report["results"])
        path.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
        print(json.dumps(report["summary"], ensure_ascii=False, indent=1))
        return
    if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]*", args.label):
        raise SystemExit("label must be lowercase letters, digits, '.', '_' or '-'")

    voices_wanted = args.voices.split(",")
    checksums = verify([*voices_wanted, "joe"] + (["padmavathi-source"] if "padmavathi" in voices_wanted else []) + (["stt"] if args.stt else []))
    phrases = json.loads(args.phrases.read_text(encoding="utf-8"))["phrases"]
    if args.only:
        keep = set(args.only.split(","))
        phrases = [phrase for phrase in phrases if phrase["id"] in keep]

    config: dict = {"pipeline": args.pipeline, "threads": args.threads, "repeats": args.repeats,
                    "phrases": str(args.phrases.resolve().relative_to(ROOT))}
    if args.pipeline == "current":
        import local_tts_text as lt

        pauses = {**lt.PAUSE_MS, **parse_overrides(args.pause)}
        shape_options = {**lt.SHAPE_DEFAULTS, **parse_overrides(args.shape)}
        speeds = dict(lt.DEFAULT_SPEED)
        plan = lambda text, base, available: lt.plan_speech(text, base, available)  # noqa: E731
        shape = lambda samples, rate: lt.trim_and_fade(samples, rate, **shape_options)  # noqa: E731
        pause_for = lambda kind, rate: lt.pause_samples(kind, rate, pauses)  # noqa: E731
        config.update(pauses_ms=pauses, shape=shape_options, default_speed=speeds)
    else:
        speeds = {}
        plan, shape, pause_for = legacy_plan, None, None
    speeds = {**speeds, **parse_overrides(args.speed)}
    config["speed"] = {language: speeds.get(language, 1.0) for language in ("te", "en")}

    out = OUT_ROOT / args.label
    english = load_voice(LOCAL / "tts/en", args.threads)
    results = []
    load = os.getloadavg()[0]
    for voice_name in voices_wanted:
        telugu = load_voice(TELUGU_VOICES[voice_name], args.threads)
        voices = {"te": telugu, "en": english}
        telugu.generate("నమస్కారం", sid=0, speed=1.0)  # warm-up, not timed
        english.generate("Hello.", sid=0, speed=1.0)
        for phrase in phrases:
            row = {"voice": voice_name, "id": phrase["id"], "category": phrase["category"], "lang": phrase["lang"], "text": phrase["text"],
                   "ref": phrase["ref"], "ref_te": phrase.get("ref_te"), "critical": phrase["critical"]}
            try:
                segments = plan(phrase["text"], phrase["lang"], ["en", "te"])
                row["segments"] = [[language, text, pause] for language, text, pause in segments]
                timings = []
                for _ in range(args.repeats):
                    audio, first, total, records = synthesize(voices, segments, speeds, shape, pause_for, telugu.sample_rate)
                    timings.append((first, total))
                wav = f"{voice_name}/{phrase['id']}.wav"
                write_wav(out / wav, audio, telugu.sample_rate)
                row.update(
                    wav=wav,
                    first_audio_ms=round(statistics.median(t[0] for t in timings) * 1000),
                    total_ms=round(statistics.median(t[1] for t in timings) * 1000),
                    audio_ms=round(len(audio) / telugu.sample_rate * 1000),
                    records=records,
                    joins=join_metrics(audio, telugu.sample_rate),
                )
                row["rtf"] = round(row["total_ms"] / max(1, row["audio_ms"]), 3)
            except Exception as exc:  # noqa: BLE001 - a synthesis failure is a benchmark result
                row["error"] = f"{type(exc).__name__}: {exc}"
            results.append(row)
            print(f"{voice_name} {phrase['id']} " + (row.get("error") or f"first={row['first_audio_ms']}ms total={row['total_ms']}ms audio={row['audio_ms']}ms"), flush=True)
    if args.stt:
        round_trip(results, out, args.threads)
    summary = summarize(results)
    report = {
        "label": args.label,
        "command": " ".join([".venv/bin/python -I scripts/benchmark-local-tts.py", *sys.argv[1:]]),
        "when": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "sherpa_onnx": sherpa_onnx.__version__,
        "load_avg_1m_at_start": round(load, 2),
        "checksums": checksums,
        "config": config,
        "summary": summary,
        "results": results,
    }
    out.mkdir(parents=True, exist_ok=True)
    (out / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    print(f"wrote {out.relative_to(ROOT)}/results.json")


if __name__ == "__main__":
    main()
