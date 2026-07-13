import { z } from "zod";

/**
 * Server-side environment schema. Validated once at first access so a
 * misconfigured deployment fails fast with a readable error instead of
 * failing deep inside a request handler.
 */
const serverEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),

  // AI provider selection — swap providers via env, never via code changes.
  LLM_PROVIDER: z.enum(["ollama", "openai", "anthropic", "gemini", "groq", "mistral"]).default("ollama"),
  LLM_MODEL: z.string().default("llama3.1"),
  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().url().optional(),

  OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434"),
  // CPU-hosted local models (the Ollama default) routinely take longer than
  // a hosted API to finish a completion — raise this if health checks or
  // chat turns are timing out against a local model on modest hardware.
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  EMBEDDING_PROVIDER: z.enum(["ollama", "openai", "none"]).default("none"),
  EMBEDDING_MODEL: z.string().default("nomic-embed-text"),

  // Shared secret authorizing scheduled jobs (e.g. the data-retention cron).
  CRON_SECRET: z.string().min(16).optional(),

  // Outbound messaging (booking confirmations, reminders). "log" delivers to
  // the application log; real gateways (Twilio, ...) plug in via the factory.
  MESSAGING_PROVIDER: z.enum(["log"]).default("log"),

  // OAuth app credentials for tenant calendar connections (optional until a
  // tenant connects the corresponding provider).
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),

  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | null = null;

export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid server environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test helper — clears the memoized env so tests can vary process.env. */
export function resetEnvCacheForTests(): void {
  cached = null;
}
