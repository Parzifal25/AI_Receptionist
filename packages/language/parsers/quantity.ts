import { normalizeForMatching } from "../normalize";
import { parseNumber, type ParsedNumber } from "./numerals";

/**
 * Energy quantities and system capacity (plan §P3.6). Business-agnostic: the
 * units are physical, not industry-specific.
 */

const ENERGY_MARKERS = ["kwh", "kw h", "unit", "units", "యూనిట్", "యూనిట్లు", "yunit", "yunits", "yunitlu"];

/** kW spellings, including the common ASR confusion "kv" for "kW". */
const CAPACITY_MARKERS: Array<{ token: string; corrected?: string }> = [
  { token: "kilowatt" },
  { token: "kilo watt" },
  { token: "kw" },
  { token: "కిలోవాట్" },
  { token: "కిలో వాట్" },
  { token: "kv", corrected: "kv→kW" },
  { token: "కేవి", corrected: "kv→kW" },
];

/** kVA is apparent power, not kW: never silently treated as capacity. */
const KVA_MARKERS = ["kva", "kilovolt ampere", "కేవీఏ"];

export function hasEnergyUnitMarker(text: string): boolean {
  const normalized = ` ${normalizeForMatching(text)} `;
  return ENERGY_MARKERS.some((marker) => normalized.includes(` ${marker} `) || normalized.includes(`${marker} `));
}

export interface ParsedCapacity extends ParsedNumber {
  kw: number;
  /** Set when an ASR-style spelling was corrected, so it can be confirmed back. */
  corrected?: string;
  /** The caller said kVA; capacity is NOT assumed (ask, never convert). */
  ambiguousUnit?: "kva";
}

export function parseCapacityKw(text: string): ParsedCapacity | null {
  const normalized = ` ${normalizeForMatching(text)} `;
  const number = parseNumber(text);
  if (!number) return null;
  if (KVA_MARKERS.some((m) => normalized.includes(m))) {
    return { ...number, kw: number.value, ambiguousUnit: "kva", confidence: Math.min(number.confidence, 0.4) };
  }
  const marker = CAPACITY_MARKERS.find(
    (m) => normalized.includes(` ${m.token} `) || normalized.includes(`${number.value}${m.token} `) || normalized.includes(` ${m.token}`),
  );
  if (!marker) return null;
  return {
    ...number,
    kw: number.value,
    ...(marker.corrected ? { corrected: marker.corrected, confidence: Math.min(number.confidence, 0.7) } : {}),
  };
}

export interface ParsedEnergy extends ParsedNumber {
  unitsKwh: number;
}

export function parseEnergyUnits(text: string): ParsedEnergy | null {
  if (!hasEnergyUnitMarker(text)) return null;
  const number = parseNumber(text);
  return number ? { ...number, unitsKwh: number.value } : null;
}
