import { normalizeForMatching } from "../normalize";
import { parseNumber, type ParsedNumber } from "./numerals";

/**
 * Indian currency amounts in Telugu, Tenglish and English (plan §P3.6).
 * A money reading is only returned when the text actually carries a currency
 * marker — a bare number is NOT assumed to be rupees (see bill.ts, where
 * amount-vs-units is disambiguated and confirmed back).
 */

const CURRENCY_MARKERS = [
  "₹", "rs", "rs.", "inr", "rupee", "rupees", "rupay", "rupaya", "rupayalu", "roopayalu",
  "రూపాయి", "రూపాయలు", "రూ", "రూ.",
];

export function hasCurrencyMarker(text: string): boolean {
  const normalized = normalizeForMatching(text);
  return CURRENCY_MARKERS.some((marker) => normalized.includes(marker));
}

export interface ParsedMoney extends ParsedNumber {
  amountInr: number;
}

export function parseMoney(text: string): ParsedMoney | null {
  if (!hasCurrencyMarker(text)) return null;
  const number = parseNumber(text);
  if (!number) return null;
  return { ...number, amountInr: number.value };
}
