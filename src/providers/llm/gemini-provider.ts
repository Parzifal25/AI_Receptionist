import type { ChatMessage } from "@/core/domain/types";
import type { LLMCompletionOptions, LLMProvider, LLMResult } from "@/core/ports/llm-provider";
import { AppError } from "@/core/errors/app-error";
import { logger } from "@/lib/logger";

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** Adapter for the Google Gemini generateContent API. */
export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  private readonly log = logger.child({ provider: this.name });

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = "https://generativelanguage.googleapis.com",
  ) {}

  async complete(
    systemPrompt: string,
    messages: ChatMessage[],
    options: LLMCompletionOptions = {},
  ): Promise<LLMResult> {
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
            contents: messages.map((m) => ({
              role: m.role === "assistant" ? "model" : "user",
              parts: [{ text: m.content }],
            })),
            generationConfig: {
              temperature: options.temperature ?? 0.4,
              maxOutputTokens: options.maxTokens ?? 512,
              responseMimeType: options.jsonMode ? "application/json" : "text/plain",
            },
          }),
          signal: options.abortSignal ?? AbortSignal.timeout(60_000),
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
    const content = data.candidates?.[0]?.content?.parts
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
