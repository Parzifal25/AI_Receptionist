import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { SupabaseKnowledgeProvider } from "@halo/providers/knowledge/supabase-knowledge-provider";
import { ProviderKnowledgeResolver } from "@halo/runtime/knowledge-resolver";
import type { EmbeddingProvider } from "@halo/ports/embedding-provider";
import { requireDisposableDatabase } from "../../scripts/disposable-database.mjs";
import { BUSINESS_A, makeAgent, makeInput, makeRuntime, makeTrusted, reply, ScriptedLLM } from "../mocks/runtime-fakes";

/**
 * D14 — the PRODUCTION retrieval path against real PostgreSQL.
 *
 * AgentRuntime -> ProviderKnowledgeResolver -> SupabaseKnowledgeProvider
 * -> the governed RPCs of migration 0033, executed by psql AS service_role
 * (the role the production admin client uses). Editor and approver steps
 * run AS authenticated with a JWT subject, like the dashboard.
 *
 * Opt-in and destructive-safe: runs only with HALO_DISPOSABLE_DATABASE=1
 * and HALO_DISPOSABLE_DB_URL naming a loopback halo_check_<suffix>
 * database that already has every migration applied (for example right
 * after `npm run check:rls`). It seeds fresh, uniquely named tenants and
 * never touches a developer, shared or hosted database.
 */
const enabled = process.env.HALO_DISPOSABLE_DATABASE === "1" && Boolean(process.env.HALO_DISPOSABLE_DB_URL);
const url = enabled ? requireDisposableDatabase(undefined, process.env) : "";

function psql(sql: string): string {
  return execFileSync("psql", [url, "--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--set", "VERBOSITY=verbose", "--tuples-only", "--no-align", "--quiet"], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

const literal = (value: unknown): string => {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length && value.every((v) => typeof v === "number")) return `'[${value.join(",")}]'::vector`;
    return value.length ? `array[${value.map(literal).join(",")}]::uuid[]` : "'{}'::uuid[]";
  }
  return `'${String(value).replaceAll("'", "''")}'`;
};
const SET_RETURNING = new Set(["search_governed_knowledge", "match_governed_knowledge_chunks"]);

/** The subset of the Supabase client the provider uses, executed as service_role. */
function serviceRoleClient(): SupabaseClient {
  const run = (sql: string) => {
    try {
      return { data: JSON.parse(psql(`begin; set local role service_role;\n${sql}\ncommit;`) || "null"), error: null };
    } catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? error);
      return { data: null, error: { code: /ERROR:\s+([0-9A-Z]{5}):/.exec(stderr)?.[1], message: stderr.split("\n")[0] } };
    }
  };
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      const call = `public.${name}(${Object.entries(args).map(([k, v]) => `${k} => ${literal(v)}`).join(", ")})`;
      return run(SET_RETURNING.has(name) ? `select coalesce(json_agg(t), '[]'::json) from ${call} t;` : `select to_json(${call});`);
    },
    from: (table: string) => ({
      insert: async (rows: Array<Record<string, unknown>>) => {
        const columns = Object.keys(rows[0]);
        const values = rows.map((row) => `(${columns.map((c) => literal(row[c])).join(", ")})`).join(", ");
        const { error } = run(`insert into public.${table} (${columns.join(", ")}) values ${values}; select 'null';`);
        return { error };
      },
    }),
  } as unknown as SupabaseClient;
}

const asUser = (uid: string, sql: string) =>
  psql(`begin;\ndo $$ begin perform set_config('request.jwt.claim.sub', '${uid}', true); end $$;\nset local role authenticated;\n${sql}\ncommit;`);

/** A deterministic synthetic embedder: never a provider call. */
const embedder: EmbeddingProvider = { name: "synthetic", dimensions: 768, embed: async (texts: string[]) => texts.map(() => Array(768).fill(0.1)) } as unknown as EmbeddingProvider;

describe.skipIf(!enabled)("D14 governed retrieval through the production runtime path (disposable PostgreSQL)", () => {
  const tag = randomUUID().slice(0, 8);
  const ownerA = randomUUID(), memberA = randomUUID(), ownerB = randomUUID();
  const bizA = randomUUID(), bizB = randomUUID();
  let colSales = "", colSupport = "", colB = "", docId = "";
  const provider = new SupabaseKnowledgeProvider(serviceRoleClient(), embedder);

  const publish = async (uid: string, biz: string, doc: string | null, content: string, collection: string | null) => {
    const [document, revision] = asUser(uid, `select r.document_id || '|' || r.revision_id from public.knowledge_create_document_revision('${biz}', ${literal(doc)}, 'Panels ${tag}', ${literal(content)}, 'manual', '', ${literal(collection)}) r;`).split("|");
    const status = await provider.indexRevision({ businessId: biz, documentId: document, revisionId: revision, chunks: [content] });
    expect(status).toBe("ready");
    asUser(uid, `select public.knowledge_submit_revision('${revision}');`);
    return { document, revision };
  };
  const approve = (uid: string, revision: string) => asUser(uid, `select public.knowledge_review_revision('${revision}', true);`);

  async function turn(biz: string, message: string, collectionIds: string[] = []) {
    const llm = new ScriptedLLM([reply("Let me check that for you.")]);
    const harness = makeRuntime({ llm, knowledge: new ProviderKnowledgeResolver(provider) });
    const output = await harness.runtime.run(makeInput({
      trusted: makeTrusted({ businessId: biz }),
      agent: makeAgent({ business: { ...BUSINESS_A, id: biz }, config: { knowledge: { collectionIds, retrievalPolicy: "hybrid" } } as never }),
      userMessage: message,
    }));
    const retrieved = harness.sink.events.find((e) => e.type === "knowledge.retrieved");
    return { prompt: llm.calls[0]?.systemPrompt ?? "", output, retrieved: retrieved?.data as Record<string, unknown> };
  }

  beforeAll(() => {
    psql(`
      insert into auth.users (id, email) values ('${ownerA}', 'owner-a-${tag}@test'), ('${memberA}', 'member-a-${tag}@test'), ('${ownerB}', 'owner-b-${tag}@test');
      insert into businesses (id, name, slug) values ('${bizA}', 'Governed A ${tag}', 'governed-a-${tag}'), ('${bizB}', 'Governed B ${tag}', 'governed-b-${tag}');
      insert into business_members (business_id, user_id, role) values ('${bizA}', '${ownerA}', 'owner'), ('${bizA}', '${memberA}', 'member'), ('${bizB}', '${ownerB}', 'owner');`);
    colSales = asUser(ownerA, `insert into knowledge_collections (business_id, name) values ('${bizA}', 'Sales') returning id;`);
    colSupport = asUser(ownerA, `insert into knowledge_collections (business_id, name) values ('${bizA}', 'Support') returning id;`);
    colB = asUser(ownerB, `insert into knowledge_collections (business_id, name) values ('${bizB}', 'B') returning id;`);
  });

  it("does not put pending content into the model context, and reports a knowledge gap", async () => {
    const { document } = await publish(memberA, bizA, null, `Omegaword${tag} panels carry a twenty year warranty.`, colSales);
    docId = document;
    const result = await turn(bizA, `What is the omegaword${tag} warranty?`);
    expect(result.prompt).not.toContain("twenty year warranty");
    expect(result.retrieved).toMatchObject({ snippets: 0, degraded: false });
    expect(result.output.knowledgeGap).toBe(true);
  });

  it("serves approved content to the runtime of its own tenant only", async () => {
    const pending = asUser(ownerA, `select id from knowledge_document_revisions where document_id = '${docId}' and state = 'pending_review';`);
    approve(ownerA, pending);
    const own = await turn(bizA, `What is the omegaword${tag} warranty?`);
    expect(own.prompt).toContain("twenty year warranty");
    expect(own.output.knowledgeGap).toBe(false);
    const other = await turn(bizB, `What is the omegaword${tag} warranty?`);
    expect(other.prompt).not.toContain("twenty year warranty");
    expect(other.retrieved).toMatchObject({ snippets: 0 });
  });

  it("enforces the agent's collection binding: bound collection served, another collection excluded", async () => {
    expect((await turn(bizA, `omegaword${tag} warranty?`, [colSales])).prompt).toContain("twenty year warranty");
    const support = await turn(bizA, `omegaword${tag} warranty?`, [colSupport]);
    expect(support.prompt).not.toContain("twenty year warranty");
    expect(support.retrieved).toMatchObject({ snippets: 0, degraded: false });
  });

  it("denies (never widens) a binding to another tenant's collection; the turn degrades safely", async () => {
    const foreign = await turn(bizA, `What is the omegaword${tag} warranty?`, [colB]);
    expect(foreign.prompt).not.toContain("twenty year warranty");
    expect(foreign.retrieved).toMatchObject({ snippets: 0, degraded: true });
    expect(foreign.output.knowledgeGap).toBe(true);
  });

  it("switches atomically to a replacement revision with no old chunk in context", async () => {
    const { revision } = await publish(memberA, bizA, docId, `Omegaword${tag} panels now carry a thirty year warranty.`, null);
    expect((await turn(bizA, `omegaword${tag} warranty?`)).prompt).toContain("twenty year warranty");
    approve(ownerA, revision);
    const after = await turn(bizA, `omegaword${tag} warranty?`);
    expect(after.prompt).toContain("thirty year warranty");
    expect(after.prompt).not.toContain("twenty year warranty");
  });

  it("stops serving withdrawn content on the next turn", async () => {
    asUser(ownerA, `select public.knowledge_withdraw_document('${docId}');`);
    const result = await turn(bizA, `What is the omegaword${tag} warranty?`);
    expect(result.prompt).not.toContain("thirty year warranty");
    expect(result.output.knowledgeGap).toBe(true);
  });

  it("serves an approved FAQ through the same path, and only after approval", async () => {
    const revision = asUser(memberA, `select r.revision_id from public.faq_create_revision('${bizA}', null, 'Sigmaword${tag} hours?', 'Sigmaword${tag} hours are nine to five.', 'Hours') r;`);
    expect((await turn(bizA, `sigmaword${tag} hours?`)).prompt).not.toContain("nine to five");
    asUser(ownerA, `select public.faq_review_revision('${revision}', true);`);
    expect((await turn(bizA, `sigmaword${tag} hours?`)).prompt).toContain("nine to five");
    expect((await turn(bizA, `sigmaword${tag} hours?`, [colSales])).prompt).not.toContain("nine to five");
  });

  it("indexing refuses another tenant's revision through the production provider", async () => {
    const [document, revision] = asUser(memberA, `select r.document_id || '|' || r.revision_id from public.knowledge_create_document_revision('${bizA}', null, 'Draft ${tag}', 'Taword draft', 'manual', '', null) r;`).split("|");
    await expect(provider.indexRevision({ businessId: bizB, documentId: document, revisionId: revision, chunks: ["Taword draft"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
