import { it } from "vitest";
import { runChatLocalIntegration } from "./chat-local-integration";

it("exercises chat routes with disposable real PostgREST and a synthetic LLM", runChatLocalIntegration, 30_000);
