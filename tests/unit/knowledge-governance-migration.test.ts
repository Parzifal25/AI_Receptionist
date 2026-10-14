import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentActivationErrors } from "@halo/core/domain/agents";
import { readyAgentConfig } from "../mocks/layer1-agent-config";

/**
 * D14 — static checks of migration 0033_knowledge_governance. These read the
 * SQL text; database behaviour (as real roles) is proven by
 * scripts/check-rls.mjs and scripts/check-migrations.mjs on a disposable DB.
 */
const migrationsDir = path.resolve(__dirname, "../../supabase/migrations");
const sql = readFileSync(path.join(migrationsDir, "0033_knowledge_governance.sql"), "utf8");
const code = sql.replace(/--.*$/gm, "");

describe("migration 0033_knowledge_governance (static)", () => {
  it("is the next contiguous, uniquely numbered migration and only adds", () => {
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    expect(files.map((f) => Number(f.slice(0, 4)))).toEqual(files.map((_, i) => i + 1));
    expect(files[32]).toBe("0033_knowledge_governance.sql");
    expect(code).not.toMatch(/\bdrop\s+(table|column|function)\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    // Only the obsolete member write policies are dropped; reads are kept.
    for (const [, policy] of code.matchAll(/drop policy if exists "([^"]+)"/g)) {
      expect(policy).toMatch(/^members (write|update|delete) (documents|faqs|chunks)$/);
    }
  });

  it("never infers approval for existing content", () => {
    expect(code).not.toMatch(/update\s+public\.(knowledge_document_revisions|faq_revisions)\s+set\s+state\s*=\s*'approved'[^;]*where\s+(?!id\s*=\s*rev\.id)/i);
    expect(code).not.toMatch(/insert into public\.(knowledge_document_revisions|faq_revisions)[^;]*'approved'/i);
    expect(code).toMatch(/alter column is_published set default false/);
  });

  it("keeps retrieval and indexing service-role only and governance RPCs off anon", () => {
    for (const fn of ["search_governed_knowledge", "match_governed_knowledge_chunks", "search_knowledge", "match_knowledge_chunks", "knowledge_begin_indexing", "knowledge_finish_indexing", "knowledge_governance_census", "knowledge_backfill_legacy"]) {
      expect(code).toMatch(new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated;`));
      expect(code).toMatch(new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`));
    }
    for (const fn of ["knowledge_create_document_revision", "knowledge_submit_revision", "knowledge_review_revision", "knowledge_withdraw_document", "faq_create_revision", "faq_review_revision", "faq_withdraw"]) {
      expect(code).toMatch(new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from public, anon;`));
    }
    expect(code).not.toMatch(/grant [^;]*on public\.(knowledge_document_revisions|faq_revisions) to [^;]*(insert|update|delete)/i);
  });

  it("pins every SECURITY DEFINER function to a fixed search_path", () => {
    const definers = [...code.matchAll(/create or replace function public\.(\w+)\([\s\S]*?as \$\$/g)].filter((m) => /security definer/.test(m[0]));
    expect(definers.length).toBeGreaterThan(15);
    for (const match of definers) expect(match[0], match[1]).toMatch(/set search_path = public/);
  });
});

describe("D14 agent collection bindings", () => {
  it("accepts well-formed collection ids (ownership is enforced at retrieval)", () => {
    const config = readyAgentConfig();
    config.knowledge.collectionIds = ["11111111-2222-4333-8444-555555555555"];
    expect(agentActivationErrors(config, "Versioned instructions")).toEqual([]);
  });

  it("rejects malformed collection ids before publication", () => {
    const config = readyAgentConfig();
    config.knowledge.collectionIds = ["sales"];
    expect(agentActivationErrors(config, "Versioned instructions")).toContain("knowledge.collectionIds.0: must be a collection id");
  });
});
