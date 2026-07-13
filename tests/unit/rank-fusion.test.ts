import { describe, expect, it } from "vitest";
import { fuseByReciprocalRank, normalizeQuery } from "@/providers/knowledge/supabase-knowledge-provider";
import type { KnowledgeSnippet } from "@/core/domain/types";

function snip(refId: string, source: "chunk" | "faq" = "chunk"): KnowledgeSnippet {
  return { source, refId, title: `title-${refId}`, content: `content-${refId}`, score: 0 };
}

describe("fuseByReciprocalRank", () => {
  it("keeps FAQ hits that only appear in the keyword list", () => {
    const keyword = [snip("faq1", "faq"), snip("chunkA")];
    const vector = [snip("chunkB"), snip("chunkC")];

    const fused = fuseByReciprocalRank([keyword, vector], 6);
    const ids = fused.map((s) => s.refId);

    expect(ids).toContain("faq1");
    expect(fused.find((s) => s.refId === "faq1")?.source).toBe("faq");
  });

  it("reinforces items that appear in both lists", () => {
    const keyword = [snip("shared"), snip("kOnly")];
    const vector = [snip("shared"), snip("vOnly")];

    const fused = fuseByReciprocalRank([keyword, vector], 6);

    // "shared" ranks first because it accrues score from both lists.
    expect(fused[0].refId).toBe("shared");
  });

  it("de-duplicates by refId", () => {
    const keyword = [snip("x"), snip("y")];
    const vector = [snip("x"), snip("y")];

    const fused = fuseByReciprocalRank([keyword, vector], 6);

    expect(fused).toHaveLength(2);
    expect(new Set(fused.map((s) => s.refId)).size).toBe(2);
  });

  it("respects the limit", () => {
    const keyword = [snip("a"), snip("b"), snip("c"), snip("d")];
    const fused = fuseByReciprocalRank([keyword, []], 2);
    expect(fused).toHaveLength(2);
  });

  it("returns empty for empty inputs", () => {
    expect(fuseByReciprocalRank([[], []], 6)).toEqual([]);
  });

  it("ranks earlier positions above later ones within a single list", () => {
    const keyword = [snip("first"), snip("second"), snip("third")];
    const fused = fuseByReciprocalRank([keyword], 6);
    expect(fused.map((s) => s.refId)).toEqual(["first", "second", "third"]);
  });
});

describe("normalizeQuery", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeQuery("  what   are\tyour\nhours ")).toBe("what are your hours");
  });

  it("strips control characters", () => {
    const withControls = `hel${String.fromCharCode(0)}lo${String.fromCharCode(7)}world`;
    expect(normalizeQuery(withControls)).toBe("hel lo world");
  });

  it("caps length at 400 characters", () => {
    expect(normalizeQuery("a".repeat(1000)).length).toBe(400);
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeQuery("   \n\t  ")).toBe("");
  });
});
