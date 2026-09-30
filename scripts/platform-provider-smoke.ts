/** One bounded synthetic completion; never logs content, credentials or provider bodies. */
import { existsSync } from "node:fs";
import { getLLMProvider } from "@halo/providers/llm/factory";
import { isAppError } from "@halo/core/errors/app-error";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
async function main() {
  const provider = getLLMProvider();
  const started = Date.now();
  const result = await provider.complete("You are a connectivity probe. Reply briefly.", [{ role: "user", content: "Say OK." }], { maxTokens: 64, temperature: 0 });
  console.log(JSON.stringify({ provider: provider.name, model: result.model, nonempty: Boolean(result.content.trim()),
    latencyMs: Date.now() - started, usage: result.usage ?? null, verification: "real-provider" }));
}
void main().catch(error => {
  console.log(JSON.stringify({ verification: "blocked", code: isAppError(error) ? error.code : "CONFIGURATION_OR_PROVIDER" }));
  process.exitCode = 1;
});
