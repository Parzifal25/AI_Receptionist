import { describe, expect, it } from "vitest";
import { PHONE_VOICE_PROFILE } from "@halo/runtime/channel-profile";
import type { SpeechStreamEvent } from "@halo/runtime/contracts";
import { SafeSpeechStream } from "@halo/runtime/speech-stream";

function stream() {
  const events: SpeechStreamEvent[] = [];
  const s = new SafeSpeechStream({
    sink: (e) => events.push(e),
    turnId: "turn-7",
    channel: PHONE_VOICE_PROFILE,
    claimPhrases: {},
    actions: () => [],
    startedAt: Date.now(),
  });
  const text = (t: string) => s.onDelta({ type: "text", text: t });
  return { s, events, text };
}

describe("SafeSpeechStream — invariants (Phase 4.5 Sprint 3)", () => {
  it("tags every event with its turn, so a channel can drop another turn's speech", () => {
    const { s, events, text } = stream();
    s.beginRound(true);
    text("First complete sentence here. Second one follows now. ");
    s.endRound(0);
    s.commit();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.turnId === "turn-7")).toBe(true);
  });

  it("commits once: a second commit releases nothing", () => {
    const { s, events, text } = stream();
    s.beginRound(true);
    text("A held sentence that is long enough. ");
    s.endRound(0);
    expect(s.commit()).toBe(true);
    expect(s.commit()).toBe(false);
    expect(events.filter((e) => e.type === "release")).toHaveLength(1);
  });

  it("never retracts what was released; revoke only discards held text", () => {
    const { s, events, text } = stream();
    s.beginRound(false);
    text("This sentence is heard right away. And this ");
    expect(s.releasedText).toBe("This sentence is heard right away.");
    s.revoke("stream_failed");
    expect(events.some((e) => e.type === "retract")).toBe(false);
    expect(s.releasedText).toBe("This sentence is heard right away.");
    expect(s.hasReleased).toBe(true);
  });

  it("a failed round drops the unfinished sentence instead of flushing it", () => {
    const { s, events, text } = stream();
    s.beginRound(false);
    text("One finished sentence goes first. The unfinished one is");
    s.failRound();
    const spoken = events.filter((e) => e.type === "segment").map((e) => (e as { text: string }).text);
    expect(spoken).toEqual(["One finished sentence goes first."]);
  });

  it("ignores everything after it is revoked", () => {
    const { s, events, text } = stream();
    s.beginRound(false);
    s.revoke("reply_rejected");
    text("Anything at all said after revocation. ");
    s.endRound(0);
    expect(events).toEqual([]);
    expect(s.outcome()).toMatchObject({ streamed: false, fallbackReason: "reply_rejected", segmentsEmitted: 0 });
  });
});
