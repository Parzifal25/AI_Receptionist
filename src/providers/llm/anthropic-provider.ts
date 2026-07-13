import type { ChatMessage } from "@/core/domain/types";
import type { LLMCompletionOptions, LLMProvider, LLMResult } from "@/core/ports/llm-provider";
import { AppError } from "@/core/errors/app-error";
import { logger } from "@/lib/logger";

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Adapter for the Anthropic Messages API. */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private readonly log = logger.child({ provider: this.name });

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = "https://api.anthropic.com",
    private readonly timeoutMs: number = 60_000,
  ) {}

  async complete(
    systemPrompt: string,
    messages: ChatMessage[],
    options: LLMCompletionOptions = {},
  ): Promise<LLMResult> {
    // JSON mode is emulated by instruction; Anthropic reliably follows it.
    const system = options.jsonMode
      ? `${systemPrompt}\n\nRespond ONLY with a valid JSON object. No prose, no markdown fences.`
      : systemPrompt;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: options.maxTokens ?? 512,
          temperature: options.temperature ?? 0.4,
          system,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: options.abortSignal ?? AbortSignal.timeout(this.timeoutMs),
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

    const data = (await response.json()) as AnthropicResponse;
    const content = data.content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();
    if (!content) throw AppError.provider("AI service returned an empty response");

    return {
      content,
      model: this.model,
      usage:
        data.usage?.input_tokens !== undefined && data.usage?.output_tokens !== undefined
          ? { promptTokens: data.usage.input_tokens, completionTokens: data.usage.output_tokens }
          : undefined,
    };
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
