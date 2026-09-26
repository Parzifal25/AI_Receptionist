import { describe, expect, it } from "vitest";
import { SentenceAssembler } from "@halo/runtime/response-assembler";

/** Feed `text` in the given pieces; return every segment including the flush. */
function assemble(pieces: string[]): string[] {
  const a = new SentenceAssembler();
  const out: string[] = [];
  for (const piece of pieces) out.push(...a.push(piece));
  out.push(...a.flush());
  return out;
}

/** Deterministic pseudo-random split of `text` into 1–6 character pieces. */
function randomPieces(text: string, seed: number): string[] {
  const pieces: string[] = [];
  let state = seed;
  for (let i = 0; i < text.length; ) {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    const size = 1 + (state % 6);
    pieces.push(text.slice(i, i + size));
    i += size;
  }
  return pieces;
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

describe("SentenceAssembler — boundaries (Phase 4.5 Sprint 3)", () => {
  it("decides a '.' boundary when the next visible character arrives, '?' and '!' at the whitespace", () => {
    const a = new SentenceAssembler();
    expect(a.push("Sure, I can help with that.")).toEqual([]);
    // Whitespace alone cannot tell "that. What" from "Rs. 2,000": wait one more character.
    expect(a.push(" ")).toEqual([]);
    expect(a.push("W")).toEqual(["Sure, I can help with that."]);
    expect(a.push("hat is your monthly bill?")).toEqual([]);
    expect(a.push(" ")).toEqual(["What is your monthly bill?"]);
    expect(a.flush()).toEqual([]);
  });

  it("never treats the end of the buffer as a boundary (decimals, prices)", () => {
    const a = new SentenceAssembler();
    expect(a.push("A typical home needs about 3.")).toEqual([]);
    expect(a.push("5 kW of panels on the roof. ")).toEqual([]);
    expect(a.push("Shall")).toEqual(["A typical home needs about 3.5 kW of panels on the roof."]);
  });

  it("does not split after an abbreviation, before a number, or before a lowercase word", () => {
    expect(assemble(["The survey fee is Rs. 2,000 for your area. Shall I note it?"])).toEqual([
      "The survey fee is Rs. 2,000 for your area.",
      "Shall I note it?",
    ]);
    expect(assemble(["సర్వే ఫీజు రూ. 500 మాత్రమే అండి. మీ పేరు చెప్తారా?"])).toEqual([
      "సర్వే ఫీజు రూ. 500 మాత్రమే అండి.",
      "మీ పేరు చెప్తారా?",
    ]);
    expect(assemble(["Our engineer K. Ravi will call. It takes approx. two days."])).toEqual([
      "Our engineer K. Ravi will call.",
      "It takes approx. two days.",
    ]);
    expect(assemble(["You pay about 20. 5 of that is tax."])).toEqual(["You pay about 20. 5 of that is tax."]);
  });

  it("never emits the fragments the brief forbids", () => {
    const text = "Yes, okay, ₹20,000 is the figure you mentioned. Tomorrow at 10 works for a callback from the team.";
    for (let seed = 1; seed <= 50; seed++) {
      for (const segment of assemble(randomPieces(text, seed))) {
        expect(segment).not.toMatch(/^(?:Yes,|Okay,|₹20,|Tomorrow at)$/);
        expect(segment.length).toBeGreaterThanOrEqual(12);
      }
    }
  });

  it("holds a short sentence and merges it forward instead of speaking it alone", () => {
    expect(assemble(["సరే. మీ నెలవారీ కరెంట్ బిల్ ఎంత వస్తుంది?"])).toEqual(["సరే. మీ నెలవారీ కరెంట్ బిల్ ఎంత వస్తుంది?"]);
    expect(assemble(["Yes. But first, may I have your name please?"])).toEqual(["Yes. But first, may I have your name please?"]);
  });

  it("uses the danda and newlines as boundaries", () => {
    expect(assemble(["మా టీమ్ మీకు ఫోన్ చేస్తుంది। మీ పేరు చెప్తారా?"])).toEqual([
      "మా టీమ్ మీకు ఫోన్ చేస్తుంది।",
      "మీ పేరు చెప్తారా?",
    ]);
    expect(assemble(["First line of the reply\nSecond line of the reply"])).toEqual([
      "First line of the reply",
      "Second line of the reply",
    ]);
  });

  it("never cuts inside a sentence, however long", () => {
    const long = `We look at ${"your roof, your shading, your bill and your sanctioned load, ".repeat(8)}before recommending a size.`;
    expect(assemble([long])).toEqual([normalize(long)]);
  });
});

describe("SentenceAssembler — invariants", () => {
  const corpus = [
    "సరే. మీ నెలవారీ కరెంట్ బిల్ ఎంత వస్తుంది? మా టీమ్ మీకు ఫోన్ చేస్తుంది.",
    "Sare andi, meeru cheppina time ki team call chestaru. Mee peru cheppandi?",
    "Hello! The survey fee is Rs. 2,000.   It covers 3.5 kW systems.\n\nShall I note your number?",
    "అవును, కానీ ముందు వివరాలు చెప్పండి. మీ ఇల్లు సొంతమా? Rent aa?",
    "Okay.",
    "",
  ];

  it("joins back to the whitespace-normalized text: nothing dropped, nothing reordered", () => {
    for (const text of corpus) expect(assemble([text]).join(" ")).toBe(normalize(text));
  });

  it("produces the same segments however the provider chunked the tokens", () => {
    for (const text of corpus) {
      const whole = assemble([text]);
      for (let seed = 1; seed <= 40; seed++) expect(assemble(randomPieces(text, seed))).toEqual(whole);
      expect(assemble([...text])).toEqual(whole);
    }
  });

  it("flush emits the undecided tail once, and a spent assembler returns nothing", () => {
    const a = new SentenceAssembler();
    expect(a.push("One full sentence here. ")).toEqual([]);
    expect(a.flush()).toEqual(["One full sentence here."]);
    expect(a.flush()).toEqual([]);
  });
});
