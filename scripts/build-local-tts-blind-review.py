"""Blinded Venkatesh-vs-Padmavathi listening packet from existing benchmark audio.

Benchmark only: reads the WAVs that `scripts/benchmark-local-tts.py` wrote for
`--source <label>` and writes, all under the git-ignored `models/` tree,

    models/local-speech-benchmark/blind-review/<name>/clips/*.wav   give to reviewers
    models/local-speech-benchmark/blind-review/<name>/REVIEW_SHEET.md
    models/local-speech-benchmark/blind-review/<name>/clips.sha256
    models/local-speech-benchmark/blind-review-keys/<name>.key.json  keep away from reviewers

Part A is a forced choice on the మీకు/నీకు lines (no text shown); Part B pairs
the two voices on the same booking-critical line, A/B order random per pair.
Clips are gain-matched on active-speech RMS so loudness does not pick the
winner. Nothing is synthesized and nothing is scored here: results come only
from people filling in the sheet. The two voices differ in perceived gender,
so blinding hides the label, not the voice.

    .venv/bin/python -I scripts/build-local-tts-blind-review.py --source b6-current --name b6 --seed 20261014
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
VOICE_ROOT = ROOT / "models/local-speech-benchmark/tts-te-voices"
PACKET_ROOT = ROOT / "models/local-speech-benchmark/blind-review"
KEY_ROOT = ROOT / "models/local-speech-benchmark/blind-review-keys"
VOICES = ("venkatesh", "padmavathi")

# Part A: the respectful/informal pronoun contrast, heard without the text.
CONTRAST = ["c01-meeku", "c02-neeku", "c03-meeku-monday", "c04-neeku-monday"]
# Part B: booking-critical lines (phone digits, date, times, confirmation, cancellation).
PAIRS = ["d01-phone-digits", "t01-date-numeric", "t03-time-colon", "t05-time-range", "b01-booking-te", "b02-booking-confirm", "x01-cancel-te"]

TARGET_RMS_DBFS = -23.0
PEAK_CEILING_DBFS = -1.0


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as source:
        if source.getnchannels() != 1 or source.getsampwidth() != 2:
            raise SystemExit(f"expected 16-bit mono: {path}")
        rate = source.getframerate()
        return np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(np.float32) / 32768, rate


def write_wav(path: Path, samples: np.ndarray, rate: int) -> None:
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes((np.clip(samples, -1.0, 1.0) * 32767).round().astype("<i2").tobytes())


def active_rms(samples: np.ndarray, rate: int) -> float:
    """RMS over 10 ms frames louder than -40 dBFS (the speech, not the pauses)."""
    frame = rate // 100
    frames = samples[: len(samples) // frame * frame].reshape(-1, frame)
    energy = np.sqrt(np.mean(frames ** 2, axis=1))
    loud = frames[energy > 0.01]
    return float(np.sqrt(np.mean(loud ** 2))) if len(loud) else 0.0


def match_level(samples: np.ndarray, rate: int) -> tuple[np.ndarray, dict]:
    rms = active_rms(samples, rate)
    if rms == 0.0:
        raise SystemExit("silent clip; refusing to build a packet with it")
    gain = 10 ** (TARGET_RMS_DBFS / 20) / rms
    peak = float(np.max(np.abs(samples)))
    ceiling = 10 ** (PEAK_CEILING_DBFS / 20)
    limited = peak * gain > ceiling
    if limited:
        gain = ceiling / peak
    return samples * gain, {"gain_db": round(20 * np.log10(gain), 2), "peak_limited": limited,
                            "active_rms_dbfs_before": round(20 * np.log10(rms), 2)}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sheet(name: str, source: dict, part_a: list[dict], part_b: list[dict], phrases: dict) -> str:
    lines = [
        f"# Blinded Telugu TTS listening sheet — packet `{name}`",
        "",
        "Reviewer: ____________  Telugu: native / fluent / other ______  Date: ________  "
        "Playback: headphones / phone speaker / laptop",
        "",
        "Two Telugu voices are being compared. You are not told which clip is which voice. Do not try to find out, "
        "and do not discuss clips with other reviewers until everyone has handed in their sheet. Play each clip as "
        "often as you need. Write what you actually heard, not what you expect.",
        "",
        "## Part A — which word do you hear? (no text)",
        "",
        "Each clip starts with either మీకు (respectful “to you”) or నీకు (informal “to you”). Mark what you hear "
        "first. If you cannot tell, mark *unclear*; do not guess.",
        "",
        "| Clip | మీకు | నీకు | unclear | Rest of the sentence understood? (yes / partly / no) | Notes |",
        "| --- | :---: | :---: | :---: | --- | --- |",
    ]
    lines += [f"| `{clip['clip']}` | ☐ | ☐ | ☐ |  |  |" for clip in part_a]
    lines += [
        "",
        "## Part B — booking lines, two versions each",
        "",
        "For each item, play `-1` and `-2` **without reading the text** and write down the digits, date and time "
        "you heard. Then read the text and score each version 1 (unusable) – 5 (fine for a real customer call).",
        "",
    ]
    for item in part_b:
        phrase = phrases[item["phrase"]]
        lines += [
            f"### {item['item']}",
            "",
            f"Without the text — heard in `{item['item']}-1`: ______________________  "
            f"in `{item['item']}-2`: ______________________",
            "",
            f"Text: {phrase['text']}  ",
            f"Should be heard as: {phrase['ref']}",
            "",
            "| Clip | Intelligible | Pronunciation | Natural | Pace | Every digit / date / time / booking word correct? | Words wrong or unclear |",
            "| --- | ---: | ---: | ---: | ---: | --- | --- |",
            f"| `{item['item']}-1` | /5 | /5 | /5 | /5 | yes / no |  |",
            f"| `{item['item']}-2` | /5 | /5 | /5 | /5 | yes / no |  |",
            "",
            "Preferred: `-1` / `-2` / no preference.  Telugu wording itself natural? yes / no — better wording: ______",
            "",
        ]
    lines += [
        "## Overall",
        "",
        "- Could either voice be used for real customer calls? ______",
        "- Anything that would mislead a caller (wrong digit, date, time, మీకు/నీకు, cancel vs. confirm)? ______",
        "- English words in these clips are spoken by a separate English voice. Is the switch acceptable? ______",
        "",
        f"Source: benchmark label `{source['label']}` ({source['when']}), sherpa-onnx {source['sherpa_onnx']}. "
        "Clip checksums: `clips.sha256`. The voice key is held by the person running the review.",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", required=True, help="benchmark label under tts-te-voices/")
    parser.add_argument("--name", required=True)
    parser.add_argument("--seed", type=int, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]*", args.name):
        raise SystemExit("name must be lowercase letters, digits, '.', '_' or '-'")

    source_dir = VOICE_ROOT / args.source
    report = json.loads((source_dir / "results.json").read_text(encoding="utf-8"))
    if report["config"].get("pipeline") != "current":
        raise SystemExit("source must be a current-pipeline run")
    rows = {(row["voice"], row["id"]): row for row in report["results"]}
    for voice in VOICES:
        for phrase in CONTRAST + PAIRS:
            row = rows.get((voice, phrase))
            if row is None or row.get("error"):
                raise SystemExit(f"{voice}/{phrase} missing or failed in {args.source}")
    phrases = {row["id"]: {"text": row["text"], "ref": row["ref"]} for row in report["results"]}

    rng = random.Random(args.seed)
    part_a = [{"voice": voice, "phrase": phrase} for phrase in CONTRAST for voice in VOICES]
    rng.shuffle(part_a)
    for index, clip in enumerate(part_a, start=1):
        clip["clip"] = f"A{index:02d}"
    order = PAIRS[:]
    rng.shuffle(order)
    part_b = []
    for index, phrase in enumerate(order, start=1):
        voices = list(VOICES)
        rng.shuffle(voices)
        part_b.append({"item": f"B{index:02d}", "phrase": phrase, "1": voices[0], "2": voices[1]})

    out = PACKET_ROOT / args.name
    clips_dir = out / "clips"
    if out.exists():
        raise SystemExit(f"{out.relative_to(ROOT)} exists; choose a new --name")
    clips_dir.mkdir(parents=True)
    KEY_ROOT.mkdir(parents=True, exist_ok=True)

    key_clips = []
    jobs = [(clip["clip"], clip["voice"], clip["phrase"]) for clip in part_a]
    jobs += [(f"{item['item']}-{side}", item[side], item["phrase"]) for item in part_b for side in ("1", "2")]
    for clip, voice, phrase in jobs:
        source_wav = source_dir / rows[(voice, phrase)]["wav"]
        samples, rate = read_wav(source_wav)
        levelled, level = match_level(samples, rate)
        target = clips_dir / f"{clip}.wav"
        write_wav(target, levelled, rate)
        key_clips.append({"clip": clip, "voice": voice, "phrase": phrase, "source": str(source_wav.relative_to(ROOT)),
                          "source_sha256": sha256(source_wav), "clip_sha256": sha256(target),
                          "duration_s": round(len(samples) / rate, 2), **level})

    (out / "clips.sha256").write_text("".join(f"{c['clip_sha256']}  clips/{c['clip']}.wav\n" for c in sorted(key_clips, key=lambda c: c["clip"])))
    source_meta = {"label": args.source, "when": report["when"], "sherpa_onnx": report["sherpa_onnx"], "command": report["command"]}
    (out / "REVIEW_SHEET.md").write_text(sheet(args.name, source_meta, part_a, part_b, phrases), encoding="utf-8")
    key = {"packet": args.name, "seed": args.seed, "source": source_meta, "level": {"target_active_rms_dbfs": TARGET_RMS_DBFS,
           "peak_ceiling_dbfs": PEAK_CEILING_DBFS}, "part_a": part_a, "part_b": part_b, "clips": key_clips}
    key_path = KEY_ROOT / f"{args.name}.key.json"
    key_path.write_text(json.dumps(key, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    total = sum(c["duration_s"] for c in key_clips)
    print(f"{len(key_clips)} clips, {total:.1f} s of audio, {sum(c['peak_limited'] for c in key_clips)} peak-limited")
    print(f"give reviewers: {out.relative_to(ROOT)}/clips/ + REVIEW_SHEET.md")
    print(f"keep: {key_path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
