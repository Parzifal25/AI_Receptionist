import type { ChatMessage } from "@halo/core/domain/types";
import type {
  LLMCapabilities,
  LLMCompletionOptions,
  LLMDelta,
  LLMFinishReason,
  LLMMessage,
  LLMProvider,
  LLMResult,
  LLMToolCall,
} from "@halo/ports/llm-provider";
import { AppError } from "@halo/core/errors/app-error";
import { logger } from "@halo/platform/logger";
import { parseToolArguments, readSseEvents } from "./sse";

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

type AnthropicStreamEvent =
  | { type: "message_start"; message?: { usage?: { input_tokens?: number } } }
  | { type: "content_block_start"; index: number; content_block: { type: string; id?: string; name?: string; text?: string } }
  | { type: "content_block_delta"; index: number; delta: { type: string; text?: string; partial_json?: string } }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta?: { stop_reason?: string | null }; usage?: { output_tokens?: number } }
  | { type: "message_stop" }
  | { type: string };

function mapStopReason(reason: string | null | undefined): LLMFinishReason | undefined {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case undefined:
    case null:
      return undefined;
    default:
      return "other";
  }
}

/**
 * Anthropic requires alternating user/assistant turns; tool results are
 * `tool_result` blocks inside a USER message, and consecutive results are
 * grouped into one message.
 */
function toWireMessages(messages: Array<ChatMessage | LLMMessage>): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = [];
  for (const raw of messages) {
    const m = raw as LLMMessage;
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content };
      const last = wire[wire.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) && (last.content as Array<{ type: string }>).every((b) => b.type === "tool_result")) {
        (last.content as unknown[]).push(block);
      } else {
        wire.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      wire.push({
        role: "assistant",
        content: [
          ...(m.content ? [{ type: "text", text: m.content }] : []),
          ...m.toolCalls.map((call) => ({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: typeof call.arguments === "string" ? parseToolArguments(call.arguments) : call.arguments,
          })),
        ],
      });
      continue;
    }
    wire.push({ role: m.role, content: m.content });
  }
  return wire;
}

/** Adapter for the Anthropic Messages API, with streaming and native tool use. */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private readonly log = logger.child({ provider: this.name });

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = "https://api.anthropic.com",
    private readonly timeoutMs: number = 60_000,
  ) {}

  capabilities(): LLMCapabilities {
    // JSON mode is emulated by instruction (reliable in practice).
    return { streaming: true, tools: true, jsonMode: true, usage: true };
  }

  private signal(options: LLMCompletionOptions): AbortSignal {
    if (options.abortSignal) return options.abortSignal;
    return AbortSignal.timeout(Math.min(options.timeoutMs ?? this.timeoutMs, this.timeoutMs));
  }

  private body(
    systemPrompt: string,
    messages: Array<ChatMessage | LLMMessage>,
    options: LLMCompletionOptions,
    stream: boolean,
  ): Record<string, unknown> {
    const system = options.jsonMode
      ? `${systemPrompt}\n\nRespond ONLY with a valid JSON object. No prose, no markdown fences.`
      : systemPrompt;
    return {
      model: this.model,
      max_tokens: options.maxTokens ?? 512,
      temperature: options.temperature ?? 0.4,
      system,
      messages: toWireMessages(messages),
      ...(options.tools?.length
        ? {
            tools: options.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }
        : {}),
      ...(stream ? { stream: true } : {}),
    };
  }

  private async request(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      this.log.error("anthropic request failed", { error });
      throw AppError.provider("AI service is unreachable");
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      this.log.error("anthropic returned error", { status: response.status, body: text.slice(0, 500) });
      throw AppError.provider("AI service returned an error");
    }
    return response;
  }

  async complete(
    systemPrompt: string,
    messages: Array<ChatMessage | LLMMessage>,
    options: LLMCompletionOptions = {},
  ): Promise<LLMResult> {
    const response = await this.request(this.body(systemPrompt, messages, options, false), this.signal(options));
    const data = (await response.json()) as AnthropicResponse;
    const blocks = data.content ?? [];
    const content = blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();
    const toolCalls: LLMToolCall[] = blocks
      .filter((block) => block.type === "tool_use" && block.name)
      .map((block, i) => ({
        id: block.id ?? `toolu_${i}`,
        name: block.name!,
        arguments:
          block.input && typeof block.input === "object" && !Array.isArray(block.input)
            ? (block.input as Record<string, unknown>)
            : JSON.stringify(block.input ?? {}),
      }));
    if (!content && toolCalls.length === 0) throw AppError.provider("AI service returned an empty response");

    const finishReason = mapStopReason(data.stop_reason);
    return {
      content,
      model: this.model,
      usage:
        data.usage?.input_tokens !== undefined && data.usage?.output_tokens !== undefined
          ? { promptTokens: data.usage.input_tokens, completionTokens: data.usage.output_tokens }
          : undefined,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(finishReason ? { finishReason } : {}),
    };
  }

  async *stream(
    systemPrompt: string,
    messages: Array<ChatMessage | LLMMessage>,
    options: LLMCompletionOptions = {},
  ): AsyncIterable<LLMDelta> {
    const response = await this.request(this.body(systemPrompt, messages, options, true), this.signal(options));
    if (!response.body) throw AppError.provider("AI service returned no stream");

    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let finishReason: LLMFinishReason = "stop";

    for await (const sse of readSseEvents(response.body)) {
      let event: AnthropicStreamEvent;
      try {
        event = JSON.parse(sse.data) as AnthropicStreamEvent;
      } catch {
        continue;
      }
      switch (event.type) {
        case "message_start": {
          const e = event as Extract<AnthropicStreamEvent, { type: "message_start" }>;
          inputTokens = e.message?.usage?.input_tokens;
          break;
        }
        case "content_block_start": {
          const e = event as Extract<AnthropicStreamEvent, { type: "content_block_start" }>;
          if (e.content_block.type === "tool_use") {
            toolBlocks.set(e.index, { id: e.content_block.id ?? `toolu_${e.index}`, name: e.content_block.name ?? "", json: "" });
          } else if (e.content_block.type === "text" && e.content_block.text) {
            yield { type: "text", text: e.content_block.text };
          }
          break;
        }
        case "content_block_delta": {
          const e = event as Extract<AnthropicStreamEvent, { type: "content_block_delta" }>;
          if (e.delta.type === "text_delta" && e.delta.text) yield { type: "text", text: e.delta.text };
          else if (e.delta.type === "input_json_delta") {
            const block = toolBlocks.get(e.index);
            if (block) block.json += e.delta.partial_json ?? "";
          }
          break;
        }
        case "content_block_stop": {
          const e = event as Extract<AnthropicStreamEvent, { type: "content_block_stop" }>;
          const block = toolBlocks.get(e.index);
          if (block && block.name) {
            toolBlocks.delete(e.index);
            yield { type: "tool_call", call: { id: block.id, name: block.name, arguments: parseToolArguments(block.json) } };
          }
          break;
        }
        case "message_delta": {
          const e = event as Extract<AnthropicStreamEvent, { type: "message_delta" }>;
          outputTokens = e.usage?.output_tokens ?? outputTokens;
          const mapped = mapStopReason(e.delta?.stop_reason);
          if (mapped) finishReason = mapped;
          break;
        }
        default:
          break;
      }
    }
    if (inputTokens !== undefined && outputTokens !== undefined) {
      yield { type: "usage", usage: { promptTokens: inputTokens, completionTokens: outputTokens } };
    }
    yield { type: "done", finishReason };
  }

  async isHealthy(): Promise<boolean> {
    // Anthropic has no unauthenticated ping; a models list works as a probe.
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(3_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
