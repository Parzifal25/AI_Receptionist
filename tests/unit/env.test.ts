import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getServerEnv, resetEnvCacheForTests } from "@/lib/env";

const REQUIRED = {
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
};

describe("getServerEnv", () => {
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    saved = { ...process.env };
    resetEnvCacheForTests();
  });

  afterEach(() => {
    process.env = saved;
    resetEnvCacheForTests();
  });

  it("parses a valid environment with defaults", () => {
    Object.assign(process.env, REQUIRED);
    const env = getServerEnv();
    expect(env.LLM_PROVIDER).toBe("ollama");
    expect(env.OLLAMA_BASE_URL).toBe("http://localhost:11434");
    expect(env.EMBEDDING_PROVIDER).toBe("none");
  });

  it("fails fast with a readable error when required vars are missing", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => getServerEnv()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("rejects unknown LLM providers", () => {
    Object.assign(process.env, REQUIRED, { LLM_PROVIDER: "skynet" });
    expect(() => getServerEnv()).toThrow(/LLM_PROVIDER/);
  });
});
