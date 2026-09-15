import type { ChatMessage } from "@halo/core/domain/types";
import type {
  LLMCapabilities,
  LLMCompletionOptions,
  LLMMessage,
  LLMProvider,
  LLMResult,
} from "@halo/ports/llm-provider";
import { AppError } from "@halo/core/errors/app-error";
import { logger } from "@halo/platform/logger";
import { flattenToolMessages } from "./ollama-provider";

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * Adapter for the Google Gemini generateContent API. Completion only in
 * Phase 2: streaming and native function calling are declared unsupported
 * (the runtime falls back to completion and the orchestrator-mediated
 * action path) rather than emulated.
 */
export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  private readonly log = logger.child({ provider: this.name });

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = "https://generativelanguage.googleapis.com",
    private readonly timeoutMs: number = 60_000,
  ) {}

  capabilities(): LLMCapabilities {
    return { streaming: false, tools: false, jsonMode: true, usage: true };
  }

  async complete(
    systemPrompt: string,
    messages: Array<ChatMessage | LLMMessage>,
    options: LLMCompletionOptions = {},
  ): Promise<LLMResult> {
    const signal =
      options.abortSignal ?? AbortSignal.timeout(Math.min(options.timeoutMs ?? this.timeoutMs, this.timeoutMs));
    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}/v1beta/models/${this.model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: flattenToolMessages(messages).map((m) => ({
              role: m.role === "assistant" ? "model" : "user",
              parts: [{ text: m.content }],
            })),
            generationConfig: {
              temperature: options.temperature ?? 0.4,
              maxOutputTokens: options.maxTokens ?? 512,
              responseMimeType: options.jsonMode ? "application/json" : "text/plain",
            },
          }),
          signal,
        },
      );
    } catch (error) {
      this.log.error("gemini request failed", { error });
      throw AppError.provider("AI service is unreachable");
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      this.log.error("gemini returned error", { status: response.status, body: text.slice(0, 500) });
      throw AppError.provider("AI service returned an error");
    }

    const data = (await response.json()) as GeminiResponse;
    const candidate = data.candidates?.[0];
    const content = candidate?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim();
    if (!content) throw AppError.provider("AI service returned an empty response");

    return {
      content,
      model: this.model,
      usage:
        data.usageMetadata?.promptTokenCount !== undefined &&
        data.usageMetadata?.candidatesTokenCount !== undefined
          ? {
              promptTokens: data.usageMetadata.promptTokenCount,
              completionTokens: data.usageMetadata.candidatesTokenCount,
            }
          : undefined,
      finishReason: candidate?.finishReason === "MAX_TOKENS" ? "length" : "stop",
    };
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1beta/models`, {
        headers: { "x-goog-api-key": this.apiKey },
        signal: AbortSignal.timeout(3_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
