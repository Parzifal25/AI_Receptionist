import { describe, expect, it } from "vitest";
import { readElectricityBill } from "@halo/language/parsers/bill";
import { extractName, parseIndianMobile, parsePincode } from "@halo/language/parsers/contact";
import { hasCurrencyMarker, parseMoney } from "@halo/language/parsers/money";
import { parseCapacityKw, parseEnergyUnits } from "@halo/language/parsers/quantity";
import { hasTimeExpression, toEnglishTimeGloss } from "@halo/language/parsers/time-expressions";
import { detectLanguage } from "@halo/language/detect";
import { matchIntents, TELUGU_LEXICON } from "@halo/language/lexicon";
import { selectLanguagePack, TELUGU_PACK } from "@halo/language/language-pack";

describe("money", () => {
  it("requires a currency marker and parses Indian amounts", () => {
    expect(parseMoney("3000")).toBeNull();
    expect(parseMoney("Rs 3000")!.amountInr).toBe(3000);
    expect(parseMoney("₹2,500 per month")!.amountInr).toBe(2500);
    expect(parseMoney("మూడు వేల రూపాయలు")!.amountInr).toBe(3000);
    expect(parseMoney("1.5 lakh rupees")!.amountInr).toBe(150000);
    expect(hasCurrencyMarker("bill 3000 vastundi")).toBe(false);
  });
});

describe("energy units and capacity", () => {
  it("parses units only when a unit word is present", () => {
    expect(parseEnergyUnits("300 units")!.unitsKwh).toBe(300);
    expect(parseEnergyUnits("మూడు వందల యూనిట్లు")!.unitsKwh).toBe(300);
    expect(parseEnergyUnits("300")).toBeNull();
  });

  it("parses kW, corrects the common 'kv' ASR error and refuses to convert kVA", () => {
    expect(parseCapacityKw("3 kw")!.kw).toBe(3);
    expect(parseCapacityKw("three kilowatt")!.kw).toBe(3);
    expect(parseCapacityKw("5 కిలోవాట్")!.kw).toBe(5);
    const corrected = parseCapacityKw("3 kv system")!;
    expect(corrected).toMatchObject({ kw: 3, corrected: "kv→kW" });
    expect(corrected.confidence).toBeLessThan(0.95);
    const kva = parseCapacityKw("5 kva inverter")!;
    expect(kva.ambiguousUnit).toBe("kva");
    expect(kva.confidence).toBeLessThanOrEqual(0.4);
    expect(parseCapacityKw("3000")).toBeNull();
  });
});

describe("electricity bill: amount vs units", () => {
  it("uses the caller's own unit words when they gave them", () => {
    expect(readElectricityBill("Rs 3000 per month")).toMatchObject({ kind: "amount", amountInr: 3000 });
    expect(readElectricityBill("మా బిల్లు మూడు వేల రూపాయలు")).toMatchObject({ kind: "amount", amountInr: 3000 });
    expect(readElectricityBill("300 units")).toMatchObject({ kind: "units", unitsKwh: 300 });
  });

  it("flags the overlap where prospects conflate rupees and units", () => {
    const ambiguous = readElectricityBill("bill 400");
    expect(ambiguous.kind).toBe("ambiguous");
    expect(ambiguous.needsConfirmation).toBe(true);
    expect(ambiguous.value).toBe(400);
  });

  it("resolves bare numbers outside the overlap, still asking for confirmation", () => {
    expect(readElectricityBill("bill 12000")).toMatchObject({ kind: "amount", amountInr: 12000, needsConfirmation: true });
    expect(readElectricityBill("30 every month")).toMatchObject({ kind: "units", unitsKwh: 30, needsConfirmation: true });
  });

  it("marks implausible readings instead of accepting them", () => {
    expect(readElectricityBill("Rs 5 per month").kind).toBe("implausible");
    expect(readElectricityBill("bill 99,00,000").kind).toBe("implausible");
    expect(readElectricityBill("naaku teliyadu")).toMatchObject({ kind: "unknown", needsConfirmation: true });
  });
});

describe("contact details", () => {
  it("parses Indian mobile numbers in every form callers use", () => {
    expect(parseIndianMobile("9876543210")!.e164).toBe("+919876543210");
    expect(parseIndianMobile("+91 98765 43210")!.e164).toBe("+919876543210");
    expect(parseIndianMobile("098765-43210")!.e164).toBe("+919876543210");
    expect(parseIndianMobile("నా నంబర్ ౯౮౭౬౫౪౩౨౧౦")!.e164).toBe("+919876543210");
    const spoken = parseIndianMobile("nine eight seven six five four three two one zero")!;
    expect(spoken.e164).toBe("+919876543210");
    expect(spoken.confidence).toBeLessThan(0.9);
  });

  it("rejects anything that is not a valid Indian mobile", () => {
    expect(parseIndianMobile("123456789")).toBeNull();
    expect(parseIndianMobile("5876543210")).toBeNull();
    expect(parseIndianMobile("no number here")).toBeNull();
  });

  it("parses pincodes and rejects near-misses", () => {
    expect(parsePincode("500081")!.pincode).toBe("500081");
    expect(parsePincode("my pin is ౫౦౦౦౮౧")!.pincode).toBe("500081");
    expect(parsePincode("050008")).toBeNull();
    expect(parsePincode("9876543210")).toBeNull();
  });

  it("keeps names exactly as spoken and strips honorifics only for matching", () => {
    const telugu = extractName("నా పేరు రమేష్ గారు")!;
    expect(telugu.raw).toBe("రమేష్ గారు");
    expect(telugu.honorific).toBe("గారు");
    expect(telugu.forMatching).toBe("రమేష్");
    expect(extractName("my name is K. Ramesh")!.raw).toBe("K. Ramesh");
    expect(extractName("naa peru Srinivas")!.raw).toContain("Srinivas");
    const bare = extractName("Lakshmi")!;
    expect(bare.raw).toBe("Lakshmi");
    expect(bare.confidence).toBeLessThan(0.9);
    expect(extractName("I want to know about solar panels for my house right now")).toBeNull();
  });
});

describe("intent lexicons", () => {
  it.each([
    ["అవును సరే", "affirm"],
    ["avunu", "affirm"],
    ["వద్దండి", "deny"],
    ["not interested", "deny"],
    ["నాకు తెలియదు", "dont_know"],
    ["malli cheppandi", "repeat"],
    ["నాకు మనిషితో మాట్లాడాలి", "human"],
    ["మళ్ళీ కాల్ చేయకండి", "do_not_call"],
    ["remove my number", "do_not_call"],
    ["రాంగ్ నంబర్", "wrong_number"],
    ["ippudu kudaradu", "call_back_later"],
  ])("detects %s as %s", (text, intent) => {
    expect(matchIntents(text, TELUGU_LEXICON).map((m) => m.intent)).toContain(intent);
  });

  it("finds nothing in unrelated text", () => {
    expect(matchIntents("solar panel warranty", TELUGU_LEXICON).map((m) => m.intent)).not.toContain("affirm");
  });
});

describe("language detection", () => {
  it.each([
    ["సోలార్ ప్యానెల్ వారంటీ ఎన్ని సంవత్సరాలు?", "te", false],
    ["మా current bill 3000 vastundi", "te", true],
    ["solar panel warranty enni years?", "te", true],
    ["what is the warranty period", "en", false],
  ])("detects %s", (text, primary, codeSwitched) => {
    const detection = detectLanguage(text);
    expect(detection.primary).toBe(primary);
    expect(detection.isCodeSwitched).toBe(codeSwitched);
  });

  it("reports unknown for empty input", () => {
    expect(detectLanguage("   ").primary).toBe("unknown");
  });
});

describe("time expressions", () => {
  it("glosses Telugu time language into what the scheduling parser understands", () => {
    expect(toEnglishTimeGloss("రేపు ఉదయం 10 గంటలకు")).toBe("tomorrow morning 10 o'clock");
    expect(toEnglishTimeGloss("ఎల్లుండి సాయంత్రం")).toBe("day after tomorrow evening");
    expect(toEnglishTimeGloss("repu madhyanam")).toBe("tomorrow afternoon");
    expect(toEnglishTimeGloss("సోమవారం")).toBe("monday");
    expect(hasTimeExpression("రేపు")).toBe(true);
    expect(hasTimeExpression("tomorrow at 4pm")).toBe(true);
    expect(hasTimeExpression("నాకు సోలార్ కావాలి")).toBe(false);
  });
});

describe("language pack selection", () => {
  it("serves Telugu tags from the Telugu pack", () => {
    expect(selectLanguagePack("te-IN")).toMatchObject({ supported: true });
    expect(selectLanguagePack("te-IN").pack).toBe(TELUGU_PACK);
    expect(selectLanguagePack("te-IN").pack.has("అవును", "affirm")).toBe(true);
  });

  it("degrades LOUDLY for a language with no pack", () => {
    const selection = selectLanguagePack("ta-IN");
    expect(selection.supported).toBe(false);
    expect(selection.downgrade).toEqual({ requested: "ta-IN", servedBy: "en", reason: "no_language_pack" });
  });
});
