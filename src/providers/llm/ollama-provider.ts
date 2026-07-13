import type { ChatMessage } from "@/core/domain/types";
import type { LLMCompletionOptions, LLMProvider, LLMResult } from "@/core/ports/llm-provider";
import { AppError } from "@/core/errors/app-error";
import { logger } from "@/lib/logger";

interface OllamaChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
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

  async complete(
    systemPrompt: string,
    messages: ChatMessage[],
    options: LLMCompletionOptions = {},
  ): Promise<LLMResult> {
    const body = {
      model: this.model,
      stream: false,
      format: options.jsonMode ? "json" : undefined,
      options: {
        temperature: options.temperature ?? 0.4,
        num_predict: options.maxTokens ?? 512,
      },
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    };

    // Diagnostic context for slow/timed-out CPU inference: prompt size and
    // wall-clock duration are the two levers that actually explain a stall
    // (model size and host CPU are fixed at request time).
    const promptChars = systemPrompt.length + messages.reduce((n, m) => n + m.content.length, 0);
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.abortSignal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      this.log.error(timedOut ? "ollama request timed out" : "ollama request failed", {
        error: error instanceof Error ? error.message : error,
        elapsedMs,
        timeoutMs: this.timeoutMs,
        model: this.model,
        promptChars,
        maxTokens: options.maxTokens ?? 512,
      });
      throw AppError.provider(
        timedOut
          ? "AI service took too long to respond"
          : "AI service is unreachable",
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      this.log.error("ollama returned error", {
        status: response.status,
        body: text.slice(0, 500),
        elapsedMs: Date.now() - startedAt,
      });
      throw AppError.provider("AI service returned an error");
    }

    const data = (await response.json()) as OllamaChatResponse;
    const content = data.message?.content?.trim();
    if (!content) throw AppError.provider("AI service returned an empty response");

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > this.timeoutMs * 0.5) {
      // Didn't time out, but close enough to warn — the next slightly
      // longer prompt or a busier host will tip this into a hard timeout.
      this.log.warn("ollama response was slow", { elapsedMs, timeoutMs: this.timeoutMs, promptChars });
    }

    return {
      content,
      model: this.model,
      usage:
        data.prompt_eval_count !== undefined && data.eval_count !== undefined
          ? { promptTokens: data.prompt_eval_count, completionTokens: data.eval_count }
          : undefined,
    };
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
