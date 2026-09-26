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
  LLMToolCall,
  LLMUsage,
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

/**
 * Phase 4.5 Sprint 3 — one scripted model call for `StreamingLLM`.
 * `failAfterTokens` throws `failWith` after that many text deltas (a stream
 * that died mid-reply); `omitDone` ends the stream with no finish event.
 */
export interface StreamStep {
  content: string;
  toolCalls?: LLMToolCall[];
  usage?: LLMUsage;
  failAfterTokens?: number;
  failWith?: Error;
  omitDone?: boolean;
}

export interface StreamingLLMOptions {
  /** Delay before the first delta (time to first token), real timers. */
  firstTokenMs?: number;
  /** Delay before every later text delta. */
  tokenMs?: number;
  /** Observes each text delta as it is yielded (index, text). */
  onToken?: (index: number, text: string) => void | Promise<void>;
  tools?: boolean;
  name?: string;
}

/** Splits text into word-with-trailing-space tokens, the shape real deltas take. */
export function wordTokens(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

/**
 * A streaming model with real (or fake-timer) pacing that honours
 * `abortSignal` — the fake the safe-streaming tests, the golden runner in
 * streaming mode and the latency harness share. `complete()` and `stream()`
 * consume the same script, so a turn that falls back from streaming to the
 * complete path reads the next step.
 */
export class StreamingLLM implements LLMProvider {
  readonly name: string;
  readonly calls: ScriptedCall[] = [];
  readonly streamCalls: ScriptedCall[] = [];
  private index = 0;

  constructor(private readonly script: Array<StreamStep | Error>, private readonly opts: StreamingLLMOptions = {}) {
    this.name = opts.name ?? "streaming-fake";
  }

  capabilities(): LLMCapabilities {
    return { streaming: true, tools: this.opts.tools ?? true, jsonMode: true, usage: true };
  }

  private step(): StreamStep | Error {
    const step = this.script[Math.min(this.index, this.script.length - 1)];
    this.index += 1;
    return step;
  }

  async complete(systemPrompt: string, messages: Array<ChatMessage | LLMMessage>, options: LLMCompletionOptions = {}): Promise<LLMResult> {
    this.calls.push({ systemPrompt, messages, options });
    const step = this.step();
    if (step instanceof Error) throw step;
    const delay = (this.opts.firstTokenMs ?? 0) + wordTokens(step.content).length * (this.opts.tokenMs ?? 0);
    await abortableSleep(delay, options.abortSignal);
    return {
      content: step.content.trim(),
      model: "streaming-fake",
      usage: step.usage ?? { promptTokens: 100, completionTokens: 20 },
      ...(step.toolCalls?.length ? { toolCalls: step.toolCalls, finishReason: "tool_calls" as const } : { finishReason: "stop" as const }),
    };
  }

  async *stream(systemPrompt: string, messages: Array<ChatMessage | LLMMessage>, options: LLMCompletionOptions = {}): AsyncIterable<LLMDelta> {
    this.streamCalls.push({ systemPrompt, messages, options });
    const step = this.step();
    if (step instanceof Error) throw step;
    const tokens = wordTokens(step.content);
    for (let i = 0; i < tokens.length; i++) {
      await abortableSleep(i === 0 ? (this.opts.firstTokenMs ?? 0) : (this.opts.tokenMs ?? 0), options.abortSignal);
      if (step.failAfterTokens !== undefined && i >= step.failAfterTokens) {
        throw step.failWith ?? new Error("stream interrupted");
      }
      await this.opts.onToken?.(i, tokens[i]);
      yield { type: "text", text: tokens[i] };
    }
    if (step.failAfterTokens !== undefined && step.failAfterTokens >= tokens.length) {
      throw step.failWith ?? new Error("stream interrupted");
    }
    for (const call of step.toolCalls ?? []) yield { type: "tool_call", call };
    yield { type: "usage", usage: step.usage ?? { promptTokens: 100, completionTokens: 20 } };
    if (!step.omitDone) yield { type: "done", finishReason: step.toolCalls?.length ? "tool_calls" : "stop" };
  }

  async isHealthy() {
    return true;
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
