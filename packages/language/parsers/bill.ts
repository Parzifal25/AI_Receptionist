import { hasCurrencyMarker, parseMoney } from "./money";
import { hasEnergyUnitMarker, parseEnergyUnits } from "./quantity";
import { parseNumber } from "./numerals";

/**
 * Electricity-bill readings (plan §P3.6): callers conflate the MONEY they pay
 * with the UNITS they consume ("bill 3000" can be either). This resolves the
 * two deterministically from unit words and plausible ranges, and marks
 * anything uncertain `needsConfirmation` so the agent reads it back instead
 * of guessing. Ranges are configuration, not hard-coded business knowledge.
 */

export interface BillRanges {
  amountInr: { min: number; max: number };
  unitsKwh: { min: number; max: number };
}

export const DEFAULT_BILL_RANGES: BillRanges = Object.freeze({
  amountInr: { min: 200, max: 200_000 },
  unitsKwh: { min: 20, max: 5_000 },
});

export interface BillReading {
  kind: "amount" | "units" | "ambiguous" | "implausible" | "unknown";
  amountInr?: number;
  unitsKwh?: number;
  /** The number as spoken, whatever it turns out to mean. */
  value?: number;
  raw: string;
  confidence: number;
  needsConfirmation: boolean;
}

export function readElectricityBill(text: string, ranges: BillRanges = DEFAULT_BILL_RANGES): BillReading {
  const money = parseMoney(text);
  if (money) {
    const plausible = within(money.amountInr, ranges.amountInr);
    return {
      kind: plausible ? "amount" : "implausible",
      amountInr: money.amountInr,
      value: money.amountInr,
      raw: money.raw,
      confidence: plausible ? money.confidence : Math.min(money.confidence, 0.4),
      needsConfirmation: !plausible || money.confidence < 0.9,
    };
  }

  const energy = parseEnergyUnits(text);
  if (energy) {
    const plausible = within(energy.unitsKwh, ranges.unitsKwh);
    return {
      kind: plausible ? "units" : "implausible",
      unitsKwh: energy.unitsKwh,
      value: energy.unitsKwh,
      raw: energy.raw,
      confidence: plausible ? energy.confidence : Math.min(energy.confidence, 0.4),
      needsConfirmation: !plausible || energy.confidence < 0.9,
    };
  }

  const bare = parseNumber(text);
  if (!bare) return { kind: "unknown", raw: "", confidence: 0, needsConfirmation: true };

  const couldBeAmount = within(bare.value, ranges.amountInr);
  const couldBeUnits = within(bare.value, ranges.unitsKwh);
  if (couldBeAmount && couldBeUnits) {
    // The overlap is exactly where prospects conflate the two: ask.
    return { kind: "ambiguous", value: bare.value, raw: bare.raw, confidence: Math.min(bare.confidence, 0.5), needsConfirmation: true };
  }
  if (couldBeAmount) {
    return { kind: "amount", amountInr: bare.value, value: bare.value, raw: bare.raw, confidence: Math.min(bare.confidence, 0.7), needsConfirmation: true };
  }
  if (couldBeUnits) {
    return { kind: "units", unitsKwh: bare.value, value: bare.value, raw: bare.raw, confidence: Math.min(bare.confidence, 0.7), needsConfirmation: true };
  }
  return { kind: "implausible", value: bare.value, raw: bare.raw, confidence: 0.2, needsConfirmation: true };
}

/** Did the caller say what kind of number it is at all? */
export function statesBillUnit(text: string): boolean {
  return hasCurrencyMarker(text) || hasEnergyUnitMarker(text);
}

function within(value: number, range: { min: number; max: number }): boolean {
  return value >= range.min && value <= range.max;
}
