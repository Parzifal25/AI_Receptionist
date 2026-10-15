import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAgentConfig } from "@halo/core/domain/agents";
import { makeAgent, makeInput, makeRuntime, reply, ScriptedLLM } from "../mocks/runtime-fakes";

/**
 * W2.3 / G2.10 — `guardrails.piiRules` is inert. A configured rule must not
 * look enforced: these tests pin that it changes nothing, and fail the day
 * code starts reading it, so enforcement cannot arrive without updating the
 * documentation (packages/core/domain/agents.ts, HALO_Architecture.md §11).
 */

const ROOT = join(__dirname, "..", "..");
const SCHEMA_FILE = "packages/core/domain/agents.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("guardrails.piiRules is inert (W2.3)", () => {
  it("is accepted and stored, defaulting to empty", () => {
    expect(parseAgentConfig({})?.guardrails.piiRules).toEqual({});
    expect(parseAgentConfig({ guardrails: { piiRules: { maskPhone: true } } })?.guardrails.piiRules).toEqual({ maskPhone: true });
  });

  it("changes nothing a turn does: same prompt, same reply, same persisted transcript", async () => {
    const message = "Call me on +91 98490 11223 or ravi@example.test";
    async function turn(piiRules: Record<string, unknown>) {
      const agent = makeAgent();
      agent.config.guardrails.piiRules = piiRules;
      const llm = new ScriptedLLM([reply("Noted, we will call +91 98490 11223.")]);
      const { runtime, conversations } = makeRuntime({ llm });
      const output = await runtime.run(makeInput({ agent, userMessage: message }));
      return { prompt: llm.calls[0].systemPrompt, messages: llm.calls[0].messages, reply: output.reply, stored: conversations.messages.get("conv-1") };
    }
    const without = await turn({});
    const withRules = await turn({ maskPhone: true, maskEmail: true, redact: ["phone", "email"] });
    expect(withRules).toEqual(without);
    // Nothing was masked: the rule is not enforced.
    expect(JSON.stringify(withRules.stored)).toContain("98490 11223");
  });

  it("is read nowhere outside its schema and tenant content", () => {
    const readers = ["packages", "src", "services"]
      .flatMap((dir) => sourceFiles(join(ROOT, dir)))
      .map((path) => relative(ROOT, path))
      .filter((path) => path !== SCHEMA_FILE && !path.startsWith("src/content/"))
      .filter((path) => readFileSync(join(ROOT, path), "utf8").includes("piiRules"));
    expect(readers).toEqual([]);
  });
});
