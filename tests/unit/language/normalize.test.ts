import { describe, expect, it } from "vitest";
import { foldDigits, hasTeluguScript, normalizeForMatching, normalizeText, scriptCounts } from "@halo/language/normalize";

describe("normalization (matching only, never storage)", () => {
  it("folds Telugu, Devanagari and Arabic-Indic digits to ASCII", () => {
    expect(foldDigits("౩౦౦౦")).toBe("3000");
    expect(foldDigits("३०००")).toBe("3000");
    expect(foldDigits("٣٠٠٠")).toBe("3000");
    expect(foldDigits("bill ౨౫౦౦ వచ్చింది")).toBe("bill 2500 వచ్చింది");
  });

  it("applies NFC and strips zero-width joiners for matching", () => {
    const decomposed = "కా".normalize("NFD");
    expect(normalizeText(decomposed)).toBe("కా".normalize("NFC"));
    expect(normalizeText("సోలార్‌ప్యానెల్")).toBe("సోలార్ప్యానెల్");
  });

  it("collapses whitespace and lower-cases only for matching", () => {
    expect(normalizeText("  Solar   PANELS  ")).toBe("Solar PANELS");
    expect(normalizeForMatching("  Solar   PANELS  ")).toBe("solar panels");
  });

  it("classifies scripts for code-switch detection", () => {
    expect(hasTeluguScript("నా bill")).toBe(true);
    expect(hasTeluguScript("my bill")).toBe(false);
    const counts = scriptCounts("మా current bill 3000");
    expect(counts.telugu).toBeGreaterThan(0);
    expect(counts.latin).toBe(11);
  });
});
