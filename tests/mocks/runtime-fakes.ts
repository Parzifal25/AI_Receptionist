import type { ChatMessage } from "@halo/core/domain/types";
import { DEFAULT_BRANDING, type Business, type Receptionist } from "@halo/core/domain/types";
import { defaultAgentConfig, type AgentConfig } from "@halo/core/domain/agents";
import type {
  LLMCapabilities,
  LLMCompletionOptions,
  LLMDelta,
  LLMMessage,
  LLMProvider,
  LLMResult,
} from "@halo/ports/llm-provider";
import type { KnowledgeProvider } from "@halo/ports/knowledge-provider";
import { AgentRuntime, type AgentRuntimeDeps } from "@halo/runtime/agent-runtime";
import { WEB_CHAT_PROFILE } from "@halo/runtime/channel-profile";
import type { ResolvedAgentRuntimeContext, RuntimeInput, TrustedRequestContext } from "@halo/runtime/contracts";
import { InMemoryConversationStateStore } from "@halo/runtime/conversation-state";
import { CollectingEventSink } from "@halo/runtime/events";
import { ProviderKnowledgeResolver } from "@halo/runtime/knowledge-resolver";
import type { ConversationStore, ToolTranscriptRecord } from "@halo/runtime/system-actions";

/**
 * Shared fakes for Agent Runtime tests: a scripted model, an in-memory
 * transcript store, and builders for trusted/agent contexts.
 */

export const BUSINESS_A: Business = {
  id: "biz-a",
  name: "Acme Services",
  slug: "acme",
  description: "A local services business",
  industry: "",
  website: "",
  phone: "+1 555 0100",
  email: "",
  address: "",
  businessHours: { mon: { open: "09:00", close: "17:00", closed: false } },
  logoUrl: "",
};

export const BUSINESS_B: Business = { ...BUSINESS_A, id: "biz-b", name: "Other Tenant", slug: "other" };

export const RECEPTIONIST_A: Receptionist = {
  id: "rec-a",
  businessId: "biz-a",
  name: "Riley",
  greeting: "Hi",
  tone: "friendly",
  language: "en",
  customInstructions: "",
  widgetKey: "widget-key-a",
  isActive: true,
  leadCaptureEnabled: false,
  voiceEnabled: false,
  branding: DEFAULT_BRANDING,
};

export function makeAgent(overrides: Partial<ResolvedAgentRuntimeContext> & { config?: Partial<AgentConfig> } = {}): ResolvedAgentRuntimeContext {
  const config = { ...defaultAgentConfig(), ...(overrides.config ?? {}) } as AgentConfig;
  return {
    business: BUSINESS_A,
    agentId: "agent-a",
    agentVersionId: "av-a-1",
    agentVersion: 1,
    promptTemplate: "You are Riley, the assistant for Acme Services.",
    model: undefined,
    receptionist: RECEPTIONIST_A,
    ...overrides,
    config,
  };
}

export function makeTrusted(overrides: Partial<TrustedRequestContext> = {}): TrustedRequestContext {
  return {
    businessId: "biz-a",
    conversationId: "conv-1",
    agentId: "agent-a",
    agentVersionId: "av-a-1",
    turnId: "turn-1",
    ...overrides,
  };
}

export type ScriptStep = LLMResult | Error | ((call: ScriptedCall) => Promise<LLMResult> | LLMResult);

export interface ScriptedCall {
  systemPrompt: string;
  messages: Array<ChatMessage | LLMMessage>;
  options: LLMCompletionOptions;
}

/** A model that answers from a script, one step per call; records every call. */
export class ScriptedLLM implements LLMProvider {
  readonly name: string;
  readonly calls: ScriptedCall[] = [];
  readonly streamCalls: ScriptedCall[] = [];
  private index = 0;

  constructor(
    private readonly script: ScriptStep[],
    private readonly caps: LLMCapabilities = { streaming: false, tools: true, jsonMode: true, usage: true },
    name = "scripted",
  ) {
    this.name = name;
  }

  capabilities(): LLMCapabilities {
    return this.caps;
  }

  private next(call: ScriptedCall): Promise<LLMResult> {
    const step = this.script[Math.min(this.index, this.script.length - 1)];
    this.index += 1;
    if (step instanceof Error) return Promise.reject(step);
    if (typeof step === "function") return Promise.resolve(step(call));
    return Promise.resolve(step);
  }

  async complete(systemPrompt: string, messages: Array<ChatMessage | LLMMessage>, options: LLMCompletionOptions = {}) {
    const call = { systemPrompt, messages, options };
    this.calls.push(call);
    return this.next(call);
  }

  async *stream(systemPrompt: string, messages: Array<ChatMessage | LLMMessage>, options: LLMCompletionOptions = {}): AsyncIterable<LLMDelta> {
    const call = { systemPrompt, messages, options };
    this.streamCalls.push(call);
    const result = await this.next(call);
    for (const word of result.content.split(" ")) yield { type: "text", text: `${word} ` };
    for (const toolCall of result.toolCalls ?? []) yield { type: "tool_call", call: toolCall };
    if (result.usage) yield { type: "usage", usage: result.usage };
    yield { type: "done", finishReason: result.finishReason ?? "stop" };
  }

  async isHealthy() {
    return true;
  }
}

export function reply(content: string, extra: Partial<LLMResult> = {}): LLMResult {
  return { content, model: "fake-model", usage: { promptTokens: 100, completionTokens: 20 }, ...extra };
}

export class FakeConversationStore implements ConversationStore {
  readonly messages = new Map<string, ChatMessage[]>();
  readonly toolRecords: ToolTranscriptRecord[] = [];
  readonly tenants = new Map<string, string>();
  failAppend = false;

  seed(conversationId: string, businessId: string, messages: ChatMessage[]) {
    this.messages.set(conversationId, messages.slice());
    this.tenants.set(conversationId, businessId);
  }

  async loadHistory(conversationId: string, businessId: string, limit: number) {
    if (this.tenants.has(conversationId) && this.tenants.get(conversationId) !== businessId) return [];
    return (this.messages.get(conversationId) ?? []).slice(-limit);
  }

  async appendMessages(conversationId: string, businessId: string, messages: ChatMessage[]) {
    if (this.failAppend) throw new Error("append failed");
    this.tenants.set(conversationId, businessId);
    this.messages.set(conversationId, [...(this.messages.get(conversationId) ?? []), ...messages]);
  }

  async appendToolRecords(_conversationId: string, _businessId: string, records: ToolTranscriptRecord[]) {
    this.toolRecords.push(...records);
  }
}

export function emptyKnowledgeProvider(snippets: KnowledgeProvider["search"] extends (...a: never[]) => Promise<infer R> ? R : never = []): KnowledgeProvider {
  return {
    name: "fake-knowledge",
    async search() {
      return snippets;
    },
    async indexDocument() {},
    async removeDocument() {},
  };
}

export function makeRuntime(overrides: Partial<AgentRuntimeDeps> & { llm?: LLMProvider } = {}) {
  const llm = overrides.llm ?? new ScriptedLLM([reply("Hello there.")]);
  const conversations = (overrides.conversations as FakeConversationStore) ?? new FakeConversationStore();
  const stateStore = (overrides.stateStore as InMemoryConversationStateStore) ?? new InMemoryConversationStateStore();
  const sink = new CollectingEventSink();
  const runtime = new AgentRuntime({
    knowledge: new ProviderKnowledgeResolver(emptyKnowledgeProvider()),
    events: sink,
    ...overrides,
    llm,
    conversations,
    stateStore,
  });
  return { runtime, llm, conversations, stateStore, sink };
}

export function makeInput(overrides: Partial<RuntimeInput> = {}): RuntimeInput {
  return {
    trusted: makeTrusted(),
    agent: makeAgent(),
    channel: WEB_CHAT_PROFILE,
    userMessage: "hello",
    now: new Date("2026-09-15T10:00:00Z"),
    ...overrides,
  };
}
