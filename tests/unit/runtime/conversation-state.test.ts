import { describe, expect, it } from "vitest";
import {
  applyStatePatch,
  conversationStateSchema,
  emptyConversationState,
  hasStateContent,
  InMemoryConversationStateStore,
  parseConversationState,
  STATE_LIMITS,
} from "@halo/runtime/conversation-state";

describe("conversation state — schema and patches (Phase 2, WS4)", () => {
  it("starts empty and carries no content", () => {
    const state = emptyConversationState();
    expect(conversationStateSchema.safeParse(state).success).toBe(true);
    expect(hasStateContent(state)).toBe(false);
  });

  it("merges slots key-by-key, deletes with null, and replaces scalars", () => {
    let state = applyStatePatch(emptyConversationState(), {
      intent: "appointment",
      slots: { visitor_name: "Sam", visitor_phone: "555" },
    });
    state = applyStatePatch(state, { slots: { visitor_phone: null, service: "AC repair" } });
    expect(state.intent).toBe("appointment");
    expect(state.slots).toEqual({ visitor_name: "Sam", service: "AC repair" });
    expect(hasStateContent(state)).toBe(true);
  });

  it("is deterministic: the same patches in the same order yield the same state", () => {
    const a = applyStatePatch(applyStatePatch(emptyConversationState(), { slots: { a: "1" } }), { intent: "x" });
    const b = applyStatePatch(applyStatePatch(emptyConversationState(), { slots: { a: "1" } }), { intent: "x" });
    expect(a).toEqual(b);
  });

  it("rejects invalid patches (bad slot key, oversized value, unknown escalation reason)", () => {
    const base = emptyConversationState();
    expect(() => applyStatePatch(base, { slots: { "Bad Key": "x" } })).toThrow();
    expect(() => applyStatePatch(base, { slots: { ok: "x".repeat(STATE_LIMITS.maxSlotValueChars + 1) } })).toThrow();
    expect(() =>
      applyStatePatch(base, { escalation: { status: "triggered", reason: "because" as never, at: null } }),
    ).toThrow();
  });

  it("bounds the number of slots deterministically (existing keys win)", () => {
    const many = Object.fromEntries(Array.from({ length: STATE_LIMITS.maxSlots + 5 }, (_, i) => [`k${i}`, "v"]));
    const state = applyStatePatch(emptyConversationState(), { slots: many });
    expect(Object.keys(state.slots)).toHaveLength(STATE_LIMITS.maxSlots);
    expect(state.slots.k0).toBe("v");
  });

  it("parse returns null for malformed or foreign-version rows instead of serving them", () => {
    expect(parseConversationState({ version: 2 })).toBeNull();
    expect(parseConversationState("garbage")).toBeNull();
    expect(parseConversationState({ ...emptyConversationState(), slots: { "x y": "1" } })).toBeNull();
  });
});

describe("InMemoryConversationStateStore — tenant scoping", () => {
  it("never returns another tenant's state for the same conversation id", async () => {
    const store = new InMemoryConversationStateStore();
    await store.save("conv-1", "biz-a", applyStatePatch(emptyConversationState(), { intent: "secret" }));
    expect(await store.load("conv-1", "biz-b")).toBeNull();
    expect((await store.load("conv-1", "biz-a"))?.intent).toBe("secret");
    await expect(store.save("conv-1", "biz-b", emptyConversationState())).rejects.toThrow(/another tenant/);
  });
});
