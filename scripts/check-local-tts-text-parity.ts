/**
 * Differential check: the TypeScript and Python local-TTS text pipelines must
 * say the same words, segment the same way and fail on the same input.
 *
 * The shared fixture (tests/fixtures/local-tts-text-cases.json) pins chosen
 * cases; this script throws thousands of seeded random lines built from the
 * same kinds of fragments (codes, dates, times, prices, phones, abbreviations,
 * Telugu and English words, odd spacing and punctuation) at both and reports
 * every difference. No models, no network.
 *
 *   npx tsx scripts/check-local-tts-text-parity.ts [--lines 5000] [--seed 7]
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { normalizeForSpeech, pauseSamples, planSpeech, trimAndFade, UnspeakableTextError } from "../packages/providers/voice-vendors/local-tts-text";

const arg = (name: string, fallback: number) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : Number(process.argv[at + 1]);
};
const LINES = arg("lines", 5000), SEED = arg("seed", 7);

const FRAGMENTS = [
  "AR-2041", "AR2041", "HALO-7Q2X9", "A1", "2BHK", "10AM-6PM", "5PM", "COVID-19", "Ref. No. AR-2041", "No. 12", "Sr. No. 5",
  "03/24/2026", "24/03/2026", "12/31/2026", "03/04/2026", "31/02/2026", "29/02/2028", "2026-03-24", "2026/03/24", "24.03.2026",
  "March 24", "24th March", "Mar. 24, 2026", "5-2-40", "10:30", "10:30 AM", "10.30am", "17:30", "9 AM - 6 PM", "9-11 AM", "12 PM",
  "₹1,45,000", "Rs. 1,85,000", "Rs 500/-", "₹2.5 lakh", "₹2.5L", "₹2-3 lakh", "₹500 - ₹1,000", "₹1.50-₹2.50", "$100", "$12.50",
  "45,000/- రూపాయలు", "500 INR", "40%", "3.5 kW", "2.5", "1,000", "05", "1", "21", "2026",
  "9876543210", "+91 98480 12345", "+919848012345", "09848012345", "(040) 2345 6789", "040-2345-6789", "1800 425 1234",
  "Dr.", "Mr.", "Mrs.", "Ms.", "Opp.", "Mob.", "Ph:", "Rd.", "Rd", "Pvt. Ltd.", "e.g.", "i.e.", "etc.", "approx.", "vs", "డా.", "రూ. 500",
  "GST", "SMS", "OK", "UPI", "ID", "EMI", "**Note:**", "•",
  "మీకు", "నీకు", "మీ", "బుకింగ్", "కోడ్", "తేదీ", "న", "కి", "లో", "వరకు", "నుంచి", "తర్వాత", "రోజులు", "గంటలకు", "రూపాయలు", "మంది",
  "ఉదయం", "సాయంత్రం", "అయింది", "క్యాన్సిల్", "చేశాను", "౧౦", "appointmentకి", "AR-2041కి",
  "booking", "confirm", "cancel", "reschedule", "Saturday", "your", "is", "on", "at", "the", "to", "Hills",
  ",", ".", "?", "!", ";", ":", "—", "-", "/", "  ", " ", "‌",
];

let state = SEED >>> 0;
const next = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 2 ** 32;
};
const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)];

const AVAILABLE_SETS = [["en", "te"], ["en", "te"], ["en", "te"], ["en"], ["te"]];
const BASES = ["te", "en", null];
const cases = Array.from({ length: LINES }, () => {
  const parts = Array.from({ length: 1 + Math.floor(next() * 8) }, () => pick(FRAGMENTS));
  const text = parts.map(part => (next() < 0.25 ? part : `${part} `)).join("");
  return { text, base: pick(BASES), available: pick(AVAILABLE_SETS) };
});

type Outcome = { normalized: string; segments: string[][] } | { error: string };

function runTs(text: string, base: string | null, available: string[]): Outcome {
  try {
    return { normalized: normalizeForSpeech(text, base, available), segments: planSpeech(text, base, available).map(s => [s.language, s.text, s.pause]) };
  } catch (error) {
    if (error instanceof UnspeakableTextError) return { error: "unspeakable" };
    return { error: `crash: ${(error as Error).message}` };
  }
}

const PY = String.raw`
import json, sys
sys.path.insert(0, sys.argv[1])
import numpy as np
from local_tts_text import UnspeakableText, normalize_for_speech, pause_samples, plan_speech, trim_and_fade
job = json.load(sys.stdin)
out = []
for case in job["cases"]:
    try:
        segments = [list(s) for s in plan_speech(case["text"], case["base"], case["available"])]
        out.append({"normalized": normalize_for_speech(case["text"], case["base"], case["available"]), "segments": segments})
    except UnspeakableText:
        out.append({"error": "unspeakable"})
    except Exception as error:
        out.append({"error": "crash: " + str(error)})
lengths = []
for rate, ms in job["audio"]:
    samples = np.zeros(rate, dtype=np.float32)
    samples[rate // 3: rate // 2] = 0.5
    lengths.append([len(pause_samples("switch", rate, {"sentence": 0, "clause": 0, "switch": ms})), len(trim_and_fade(samples, rate, keep_ms=ms, fade_ms=ms / 5))])
json.dump({"cases": out, "audio": lengths}, sys.stdout, ensure_ascii=False)
`;

const AUDIO: [number, number][] = [];
for (const rate of [8000, 16000, 22050, 24000, 44100]) for (const ms of [5, 10, 12.5, 25, 40, 160, 280]) AUDIO.push([rate, ms]);

const root = join(__dirname, "..");
const python = spawnSync(join(root, ".venv/bin/python"), ["-I", "-c", PY, join(root, "services/pipecat-worker")], {
  input: JSON.stringify({ cases, audio: AUDIO }),
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
});
if (python.status !== 0) {
  console.error(python.stderr);
  process.exit(2);
}
const fromPython = JSON.parse(python.stdout) as { cases: unknown[]; audio: [number, number][] };

let mismatches = 0, unspeakable = 0, crashes = 0;
cases.forEach((c, i) => {
  const ts = runTs(c.text, c.base, c.available), py = fromPython.cases[i] as { error?: string };
  const tsError = "error" in ts ? ts.error : undefined;
  if (tsError === "unspeakable" && py.error === "unspeakable") unspeakable++;
  if (tsError?.startsWith("crash") || py.error?.startsWith("crash")) crashes++;
  if (JSON.stringify(ts) !== JSON.stringify(fromPython.cases[i])) {
    if (++mismatches <= 10) console.log(JSON.stringify({ case: c, ts, py: fromPython.cases[i] }, null, 1));
  }
});
AUDIO.forEach(([rate, ms], i) => {
  const samples = new Float32Array(rate);
  samples.fill(0.5, Math.floor(rate / 3), Math.floor(rate / 2));
  const ts = [pauseSamples("switch", rate, { sentence: 0, clause: 0, switch: ms }).length, trimAndFade(samples, rate, { keepMs: ms, fadeMs: ms / 5 }).length];
  if (JSON.stringify(ts) !== JSON.stringify(fromPython.audio[i])) {
    mismatches++;
    console.log(`audio ${rate} Hz ${ms} ms: ts ${ts} py ${fromPython.audio[i]}`);
  }
});
console.log(`${LINES} random lines (seed ${SEED}) + ${AUDIO.length} audio sizes: ${mismatches} mismatches; ${unspeakable} unspeakable in both; ${crashes} crashes.`);
process.exit(mismatches || crashes ? 1 : 0);
