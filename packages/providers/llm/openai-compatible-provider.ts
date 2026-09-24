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
import { providerResponseError, type ProviderErrorBody } from "./provider-error";

interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIChatResponse extends ProviderErrorBody {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: OpenAIToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface OpenAIStreamChunk extends ProviderErrorBody {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

function mapFinishReason(reason: string | null | undefined): LLMFinishReason | undefined {
  switch (reason) {
    case "stop":
      return "stop";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "length":
      return "length";
    case undefined:
    case null:
      return undefined;
    default:
      return "other";
  }
}

function toWireMessages(messages: Array<ChatMessage | LLMMessage>): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const message = m as LLMMessage;
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments),
          },
        })),
      };
    }
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.toolCallId ?? "", content: message.content };
    }
    return { role: message.role, content: message.content };
  });
}

/**
 * Adapter for any OpenAI-compatible chat-completions API. One class covers
 * OpenAI, Groq, and Mistral — they differ only in base URL and API key.
 * Supports streaming (SSE) and native tool calls.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  private readonly log;

  constructor(
    readonly name: string,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly timeoutMs: number = 60_000,
  ) {
    this.log = logger.child({ provider: name });
  }

  capabilities(): LLMCapabilities {
    return { streaming: true, tools: true, jsonMode: true, usage: true };
  }

  private signal(options: LLMCompletionOptions): AbortSignal {
    const timeout = AbortSignal.timeout(Math.min(options.timeoutMs ?? this.timeoutMs, this.timeoutMs));
    return options.abortSignal ? AbortSignal.any([options.abortSignal, timeout]) : timeout;
  }

  private body(
    systemPrompt: string,
    messages: Array<ChatMessage | LLMMessage>,
    options: LLMCompletionOptions,
    stream: boolean,
  ): Record<string, unknown> {
    return {
      model: this.model,
      temperature: options.temperature ?? 0.4,
      max_tokens: options.maxTokens ?? 512,
      response_format: options.jsonMode ? { type: "json_object" } : undefined,
      messages: [{ role: "system", content: systemPrompt }, ...toWireMessages(messages)],
      ...(options.tools?.length
        ? {
            tools: options.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            tool_choice: "auto",
          }
        : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
  }

  private async request(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      const category = signal.aborted || (error instanceof Error && error.name === "TimeoutError")
        ? "timeout" : "connection";
      this.log.warn("llm request failed", { category });
      throw AppError.provider("AI service is unreachable", { category });
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as ProviderErrorBody;
      throw providerResponseError(response.status, body, response.headers);
    }
    return response;
  }

  async complete(
    systemPrompt: string,
    messages: Array<ChatMessage | LLMMessage>,
    options: LLMCompletionOptions = {},
  ): Promise<LLMResult> {
    const response = await this.request(this.body(systemPrompt, messages, options, false), this.signal(options));
    const data = (await response.json()) as OpenAIChatResponse;
    if (data.error) throw providerResponseError(Number(data.error.code) || 502, data, response.headers);
    const choice = data.choices?.[0];
    const content = choice?.message?.content?.trim() ?? "";
    const toolCalls: LLMToolCall[] = (choice?.message?.tool_calls ?? [])
      .filter((call) => call.function?.name)
      .map((call, i) => ({
        id: call.id ?? `call_${i}`,
        name: call.function!.name!,
        arguments: parseToolArguments(call.function!.arguments),
      }));
    if (!content && toolCalls.length === 0) throw AppError.provider("AI service returned an empty response");

    return {
      content,
      model: this.model,
      httpStatus: response.status,
      usage:
        data.usage?.prompt_tokens !== undefined && data.usage?.completion_tokens !== undefined
          ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens }
          : undefined,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(mapFinishReason(choice?.finish_reason) ? { finishReason: mapFinishReason(choice?.finish_reason) } : {}),
    };
  }

  async *stream(
    systemPrompt: string,
    messages: Array<ChatMessage | LLMMessage>,
    options: LLMCompletionOptions = {},
  ): AsyncIterable<LLMDelta> {
    const signal = this.signal(options);
    const response = await this.request(this.body(systemPrompt, messages, options, true), signal);
    if (!response.body) throw AppError.provider("AI service returned no stream");

    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: LLMFinishReason = "stop";
    let usage: LLMDelta | null = null;
    let finished = false;

    try {
    for await (const event of readSseEvents(response.body)) {
      if (event.data === "[DONE]") { finished = true; break; }
      let chunk: OpenAIStreamChunk;
      try {
        chunk = JSON.parse(event.data) as OpenAIStreamChunk;
      } catch {
        throw AppError.provider("AI service returned invalid stream data", { category: "invalid_response", status: response.status });
      }
      if (chunk.error) throw providerResponseError(Number(chunk.error.code) || 502, chunk, response.headers);
      if (chunk.usage?.prompt_tokens !== undefined && chunk.usage.completion_tokens !== undefined) {
        usage = {
          type: "usage",
          usage: { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens },
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.delta?.content) yield { type: "text", text: choice.delta.content };
      for (const call of choice.delta?.tool_calls ?? []) {
        const index = call.index ?? 0;
        const entry = pending.get(index) ?? { id: "", name: "", args: "" };
        if (call.id) entry.id = call.id;
        if (call.function?.name) entry.name = call.function.name;
        if (call.function?.arguments) entry.args += call.function.arguments;
        pending.set(index, entry);
      }
      const mapped = mapFinishReason(choice.finish_reason);
      if (mapped) { finishReason = mapped; finished = true; }
    }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw AppError.provider("AI stream interrupted", { category: signal.aborted ? "timeout" : "connection", status: response.status });
    }
    if (!finished) throw AppError.provider("AI service returned an incomplete stream", { category: "connection", status: response.status });

    for (const [index, entry] of [...pending.entries()].sort(([a], [b]) => a - b)) {
      if (!entry.name) continue;
      yield {
        type: "tool_call",
        call: { id: entry.id || `call_${index}`, name: entry.name, arguments: parseToolArguments(entry.args) },
      };
    }
    if (usage) yield usage;
    yield { type: "done", finishReason, httpStatus: response.status };
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(3_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
