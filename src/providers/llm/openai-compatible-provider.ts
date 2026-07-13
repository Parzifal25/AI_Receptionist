import type { ChatMessage } from "@/core/domain/types";
import type { LLMCompletionOptions, LLMProvider, LLMResult } from "@/core/ports/llm-provider";
import { AppError } from "@/core/errors/app-error";
import { logger } from "@/lib/logger";

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Adapter for any OpenAI-compatible chat-completions API. One class covers
 * OpenAI, Groq, and Mistral — they differ only in base URL and API key.
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

  async complete(
    systemPrompt: string,
    messages: ChatMessage[],
    options: LLMCompletionOptions = {},
  ): Promise<LLMResult> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: options.temperature ?? 0.4,
          max_tokens: options.maxTokens ?? 512,
          response_format: options.jsonMode ? { type: "json_object" } : undefined,
          messages: [
            { role: "system", content: systemPrompt },
            ...messages.map((m) => ({ role: m.role, content: m.content })),
          ],
        }),
        signal: options.abortSignal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      this.log.error("llm request failed", { error });
      throw AppError.provider("AI service is unreachable");
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      this.log.error("llm returned error", { status: response.status, body: text.slice(0, 500) });
      throw AppError.provider("AI service returned an error");
    }

    const data = (await response.json()) as OpenAIChatResponse;
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw AppError.provider("AI service returned an empty response");

    return {
      content,
      model: this.model,
      usage:
        data.usage?.prompt_tokens !== undefined && data.usage?.completion_tokens !== undefined
          ? {
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
            }
          : undefined,
    };
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
