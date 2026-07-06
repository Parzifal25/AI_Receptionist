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

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.abortSignal ?? AbortSignal.timeout(60_000),
      });
    } catch (error) {
      this.log.error("ollama request failed", { error });
      throw AppError.provider("AI service is unreachable");
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      this.log.error("ollama returned error", { status: response.status, body: text.slice(0, 500) });
      throw AppError.provider("AI service returned an error");
    }

    const data = (await response.json()) as OllamaChatResponse;
    const content = data.message?.content?.trim();
    if (!content) throw AppError.provider("AI service returned an empty response");

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
