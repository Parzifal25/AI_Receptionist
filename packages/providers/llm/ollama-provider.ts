import type { ChatMessage } from "@halo/core/domain/types";
import type {
  LLMCapabilities,
  LLMCompletionOptions,
  LLMDelta,
  LLMFinishReason,
  LLMMessage,
  LLMProvider,
  LLMResult,
} from "@halo/ports/llm-provider";
import { AppError } from "@halo/core/errors/app-error";
import { logger } from "@halo/platform/logger";
import { readNdjson } from "./sse";

interface OllamaChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  done?: boolean;
  done_reason?: string;
}

/**
 * Providers without native tool support still receive transcripts that may
 * contain tool-call turns (from a run on a capable provider). They are
 * flattened into plain text so the conversation stays coherent.
 */
export function flattenToolMessages(
  messages: Array<ChatMessage | LLMMessage>,
): Array<{ role: "user" | "assistant"; content: string }> {
  return messages.map((raw) => {
    const m = raw as LLMMessage;
    if (m.role === "tool") return { role: "user", content: `[Action result] ${m.content}` };
    if (m.role === "assistant" && m.toolCalls?.length) {
      const calls = m.toolCalls.map((c) => c.name).join(", ");
      return { role: "assistant", content: m.content || `[Requested actions: ${calls}]` };
    }
    return { role: m.role === "assistant" ? "assistant" : "user", content: m.content };
  });
}

/** Development-default LLM provider backed by a local Ollama instance. */
export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  private readonly log = logger.child({ provider: this.name });

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs: number = 60_000,
  ) {}

  capabilities(): LLMCapabilities {
    // Native tool calling is model-dependent on Ollama; declared false so
    // the runtime uses the orchestrator-mediated path honestly.
    return { streaming: true, tools: false, jsonMode: true, usage: true };
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
  ) {
    return {
      model: this.model,
      stream,
      format: options.jsonMode ? "json" : undefined,
      options: {
        temperature: options.temperature ?? 0.4,
        num_predict: options.maxTokens ?? 512,
      },
      messages: [{ role: "system", content: systemPrompt }, ...flattenToolMessages(messages)],
    };
  }

  private async request(
    body: ReturnType<OllamaProvider["body"]>,
    signal: AbortSignal,
    diagnostics: { promptChars: number; maxTokens: number; startedAt: number },
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      const elapsedMs = Date.now() - diagnostics.startedAt;
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      this.log.error(timedOut ? "ollama request timed out" : "ollama request failed", {
        error: error instanceof Error ? error.message : error,
        elapsedMs,
        timeoutMs: this.timeoutMs,
        model: this.model,
        promptChars: diagnostics.promptChars,
        maxTokens: diagnostics.maxTokens,
      });
      throw AppError.provider(timedOut ? "AI service took too long to respond" : "AI service is unreachable");
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      this.log.error("ollama returned error", {
        status: response.status,
        body: text.slice(0, 500),
        elapsedMs: Date.now() - diagnostics.startedAt,
      });
      throw AppError.provider("AI service returned an error");
    }
    return response;
  }

  private diagnostics(systemPrompt: string, messages: Array<ChatMessage | LLMMessage>, options: LLMCompletionOptions) {
    return {
      promptChars: systemPrompt.length + messages.reduce((n, m) => n + m.content.length, 0),
      maxTokens: options.maxTokens ?? 512,
      startedAt: Date.now(),
    };
  }

  async complete(
    systemPrompt: string,
    messages: Array<ChatMessage | LLMMessage>,
    options: LLMCompletionOptions = {},
  ): Promise<LLMResult> {
    const diagnostics = this.diagnostics(systemPrompt, messages, options);
    const response = await this.request(this.body(systemPrompt, messages, options, false), this.signal(options), diagnostics);
    const data = (await response.json()) as OllamaChatResponse;
    const content = data.message?.content?.trim();
    if (!content) throw AppError.provider("AI service returned an empty response");

    const elapsedMs = Date.now() - diagnostics.startedAt;
    if (elapsedMs > this.timeoutMs * 0.5) {
      // Didn't time out, but close enough to warn — the next slightly
      // longer prompt or a busier host will tip this into a hard timeout.
      this.log.warn("ollama response was slow", { elapsedMs, timeoutMs: this.timeoutMs, promptChars: diagnostics.promptChars });
    }

    return {
      content,
      model: this.model,
      usage:
        data.prompt_eval_count !== undefined && data.eval_count !== undefined
          ? { promptTokens: data.prompt_eval_count, completionTokens: data.eval_count }
          : undefined,
      finishReason: data.done_reason === "length" ? "length" : "stop",
    };
  }

  async *stream(
    systemPrompt: string,
    messages: Array<ChatMessage | LLMMessage>,
    options: LLMCompletionOptions = {},
  ): AsyncIterable<LLMDelta> {
    const diagnostics = this.diagnostics(systemPrompt, messages, options);
    const response = await this.request(this.body(systemPrompt, messages, options, true), this.signal(options), diagnostics);
    if (!response.body) throw AppError.provider("AI service returned no stream");
    let finishReason: LLMFinishReason = "stop";
    let usage: LLMDelta | null = null;
    for await (const raw of readNdjson(response.body)) {
      const chunk = raw as OllamaChatResponse;
      if (chunk.message?.content) yield { type: "text", text: chunk.message.content };
      if (chunk.done) {
        if (chunk.done_reason === "length") finishReason = "length";
        if (chunk.prompt_eval_count !== undefined && chunk.eval_count !== undefined) {
          usage = { type: "usage", usage: { promptTokens: chunk.prompt_eval_count, completionTokens: chunk.eval_count } };
        }
      }
    }
    if (usage) yield usage;
    yield { type: "done", finishReason };
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
