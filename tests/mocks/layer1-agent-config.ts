import { parseAgentConfig } from "@halo/core/domain/agents";

/** Synthetic complete draft, never a source of business approval. */
export function readyAgentConfig() {
  return parseAgentConfig({
    identity: { name: "Synthetic assistant" },
    objective: "Answer synthetic test enquiries",
    language: { primary: "en" },
    voice: { prompts: {
      greeting: "I am a synthetic automated assistant.", reprompt: "Please repeat.", goodbye: "Goodbye.",
      turnFailure: "The test turn failed.", transferAnnounce: "Starting a test transfer.", transferFailed: "The test transfer failed.",
    } },
  })!;
}
