import { describe, expect, it } from "vitest";
import { chunkText } from "@halo/knowledge/chunker";

describe("chunkText", () => {
  it("returns empty array for empty input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n  ")).toEqual([]);
  });

  it("returns a single chunk when text fits", () => {
    expect(chunkText("Short document.")).toEqual(["Short document."]);
  });

  it("splits on paragraph boundaries", () => {
    const paragraphA = "A".repeat(700);
    const paragraphB = "B".repeat(700);
    const chunks = chunkText(`${paragraphA}\n\n${paragraphB}`, 1000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(paragraphA);
    expect(chunks[1]).toBe(paragraphB);
  });

  it("splits long paragraphs on sentences", () => {
    const sentence = "This is a sentence about the business. ";
    const text = sentence.repeat(60); // ~2400 chars, no paragraph breaks
    const chunks = chunkText(text, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1000);
  });

  it("hard-splits pathological unpunctuated text", () => {
    const text = "x".repeat(5000);
    const chunks = chunkText(text, 1000);
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1000);
  });

  it("normalizes CRLF", () => {
    const chunks = chunkText("line one\r\n\r\nline two", 1000);
    expect(chunks).toEqual(["line one\n\nline two"]);
  });
});
