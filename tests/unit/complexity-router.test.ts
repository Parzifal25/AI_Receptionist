import { describe, expect, it, vi } from "vitest";
import type { LLMProvider } from "@halo/ports/llm-provider";
import { AppError } from "@halo/core/errors/app-error";
import { ComplexityLLMRouter } from "@halo/providers/llm/complexity-router";
import { classifyTurn } from "@halo/runtime/turn-complexity";
import { invokeModel } from "@halo/runtime/llm-adapter";

function candidate(name: string) {
  const provider: LLMProvider = {
    name, isHealthy: async () => true,
    capabilities: () => ({ streaming: true, tools: true, jsonMode: true, usage: true }),
    complete: vi.fn(async () => ({ content: "ok", model: name })),
    async *stream() { yield { type: "text", text: "ok" }; yield { type: "done", finishReason: "stop" }; },
  };
  return { model: name, provider };
}

describe("complexity routing", () => {
  it.each([ ["Hello", "simple"], ["సరే", "simple"], ["sare", "simple"],
    ["Explain your service", "medium"], ["Can I have a discount?", "complex"],
    ["ధర తగ్గించండి", "complex"], ["rate tagginchandi", "complex"] ])("classifies %s", (text, tier) => {
    expect(classifyTurn(text)).toBe(tier);
  });
  it("selects the configured tier and retains tool descriptors", async () => {
    const cheap = candidate("local"), middle = candidate("hosted"), strong = candidate("strong");
    const router = new ComplexityLLMRouter({ simple: [cheap], medium: [middle], complex: [strong] });
    const options = { routingTier: "simple" as const, tools: [{ name: "lookup", description: "lookup", parameters: {} }] };
    expect((await router.complete("policy", [], options)).model).toBe("local");
    expect(cheap.provider.complete).toHaveBeenCalledWith("policy", [], expect.objectContaining(options));
    expect(middle.provider.complete).not.toHaveBeenCalled();
    expect((await router.complete("policy", [], { routingTier: "complex" })).model).toBe("strong");
  });
  it("shares account billing cooldown across tiers and falls back to a different provider", async () => {
    const billed = candidate("billed"), alternative = candidate("alternative");
    vi.mocked(billed.provider.complete).mockRejectedValue(AppError.provider("unavailable", { category: "billing_limit" }));
    const router = new ComplexityLLMRouter({ simple: [billed, alternative], medium: [billed, alternative], complex: [billed, alternative] });
    await router.complete("policy", [], { routingTier: "simple" });
    await router.complete("policy", [], { routingTier: "complex" });
    expect(billed.provider.complete).toHaveBeenCalledTimes(1);
    expect(alternative.provider.complete).toHaveBeenCalledTimes(2);
  });
  it("rejects a direct provider stream without a completion marker", async () => {
    const { provider } = candidate("partial");
    provider.stream = async function* () { yield { type: "text", text: "Your appointment is booked" }; };
    await expect(invokeModel({ provider, systemPrompt: "policy", messages: [], options: {},
      deadlineAt: Date.now() + 1000, purpose: "reply", onDelta: () => {} })).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
});

it("does not downgrade short confirmations in an active workflow", () => {
  expect(classifyTurn("yes", { pendingConfirmation: { toolName: "appointment.book" } })).toBe("complex");
  expect(classifyTurn("ok", { workflowStep: "negotiate" })).toBe("complex");
  expect(classifyTurn("hi", { escalation: { status: "requested" } })).toBe("complex");
});
it("reports unhealthy if any configured tier cannot serve traffic", async () => {
  const healthy = candidate("healthy"), broken = candidate("broken");
  broken.provider.isHealthy = async () => false;
  const router = new ComplexityLLMRouter({ simple: [healthy], medium: [healthy], complex: [broken] });
  expect(await router.isHealthy()).toBe(false);
});
it("uses version-authored cues for another language", () => {
  const policy = { simplePhrases: ["hola"], complexPhrases: ["descuento"] };
  expect(classifyTurn("hola!", undefined, policy)).toBe("simple");
  expect(classifyTurn("un descuento", undefined, policy)).toBe("complex");
  expect(classifyTurn("hello", undefined, policy)).toBe("medium");
  expect(classifyTurn("hola", { workflowStep: "approval" }, policy)).toBe("complex");
});
