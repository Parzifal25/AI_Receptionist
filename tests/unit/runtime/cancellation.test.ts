import { describe, expect, it } from "vitest";
import { PHONE_VOICE_PROFILE, channelProfile } from "@halo/runtime/channel-profile";
import { isRuntimeCancelled, RuntimeCancelledError } from "@halo/runtime/cancellation";
import { InMemoryConversationStateStore } from "@halo/runtime/conversation-state";
import type { SystemActionProvider } from "@halo/runtime/system-actions";
import { BUILTIN_TOOLS, ToolRegistry, type AnyToolExecutor } from "@halo/runtime/tools/registry";
import { FakeConversationStore, makeAgent, makeInput, makeRuntime, reply, ScriptedLLM } from "../../mocks/runtime-fakes";

describe("runtime cancellation (Phase 3 barge-in support)", () => {
  it("an already-aborted signal cancels before any work and persists nothing", async () => {
    const llm = new ScriptedLLM([reply("never")]);
    const conversations = new FakeConversationStore();
    const stateStore = new InMemoryConversationStateStore();
    const { runtime, sink } = makeRuntime({ llm, conversations, stateStore });
    const controller = new AbortController();
    controller.abort();
    await expect(runtime.run(makeInput({ signal: controller.signal }))).rejects.toBeInstanceOf(RuntimeCancelledError);
    expect(llm.calls).toHaveLength(0);
    expect(conversations.messages.size).toBe(0);
    expect(await stateStore.load("conv-1", "biz-a")).toBeNull();
    expect(sink.events.map((e) => e.type)).toContain("runtime.cancelled");
    expect(sink.events.map((e) => e.type)).not.toContain("runtime.failed");
  });

  it("aborting during the model call cancels promptly without a fallback reply or persistence", async () => {
    const controller = new AbortController();
    const llm = new ScriptedLLM([
      () =>
        new Promise((resolve) => {
          controller.abort();
          setTimeout(() => resolve(reply("too late")), 50);
        }),
    ]);
    const conversations = new FakeConversationStore();
    const { runtime } = makeRuntime({ llm, conversations });
    const error = await runtime.run(makeInput({ signal: controller.signal })).catch((e) => e);
    expect(isRuntimeCancelled(error)).toBe(true);
    expect((error as RuntimeCancelledError).stage).toBe("model");
    expect(conversations.messages.size).toBe(0);
  });

  it("passes a combined abort signal to the provider (deadline preserved)", async () => {
    const llm = new ScriptedLLM([reply("ok")]);
    const { runtime } = makeRuntime({ llm });
    await runtime.run(makeInput({ signal: new AbortController().signal }));
    const signal = llm.calls[0].options.abortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
  });

  it("a turn whose system action committed completes and persists despite the abort", async () => {
    const controller = new AbortController();
    const booked: SystemActionProvider = {
      name: "committing-action",
      async prepare() {
        controller.abort();
        return {
          sections: ["The appointment was booked."],
          actions: [{ source: "system", name: "appointment.book", status: "succeeded", claimsPermitted: ["appointment.book"], summary: "booked" }],
        };
      },
    };
    const llm = new ScriptedLLM([reply("You're booked for Monday.")]);
    const conversations = new FakeConversationStore();
    const { runtime } = makeRuntime({ llm, conversations, systemActions: [booked] });
    const output = await runtime.run(makeInput({ signal: controller.signal }));
    expect(output.reply).toBe("You're booked for Monday.");
    expect(conversations.messages.get("conv-1")).toHaveLength(2);
  });

  it("a turn whose tool succeeded ignores a later abort", async () => {
    const controller = new AbortController();
    const executor: AnyToolExecutor = async () => {
      controller.abort();
      return { ok: true, summary: "Handoff recorded.", claimsPermitted: ["handoff"] };
    };
    const agent = makeAgent();
    agent.config.tools.grantedToolIds = ["request_human_handoff"];
    const llm = new ScriptedLLM([
      reply("", { toolCalls: [{ id: "c1", name: "request_human_handoff", arguments: { reason: "person" } }] }),
      reply("A team member will call you back."),
    ]);
    const conversations = new FakeConversationStore();
    const { runtime } = makeRuntime({
      llm,
      conversations,
      registry: new ToolRegistry(BUILTIN_TOOLS, { request_human_handoff: executor }),
    });
    const output = await runtime.run(makeInput({ agent, signal: controller.signal, userMessage: "I want a person" }));
    expect(output.toolResults[0].status).toBe("succeeded");
    expect(conversations.messages.get("conv-1")).toHaveLength(2);
  });

  it("ships a phone-voice channel profile with interruption and short replies", () => {
    expect(channelProfile("phone-voice")).toBe(PHONE_VOICE_PROFILE);
    expect(PHONE_VOICE_PROFILE).toMatchObject({ channel: "phone", modality: "voice", supportsInterruption: true, supportsMarkdown: false });
    expect(PHONE_VOICE_PROFILE.maxReplyChars).toBeLessThanOrEqual(600);
    // Sprint 2 merged the phone profile's two delivery blocks into one, because
    // they restated each other. Assert the delivery guidance the caller depends
    // on, wherever the profile now carries it: read a number back before
    // relying on it, and yield the moment the caller talks over you.
    const delivery = `${PHONE_VOICE_PROFILE.formattingRules}\n${PHONE_VOICE_PROFILE.spokenDeliveryRules ?? ""}`;
    expect(delivery).toMatch(/confirm/i);
    expect(delivery).toMatch(/interrupt/i);
  });
});
