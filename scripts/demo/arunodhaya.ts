/**
 * HALO Phase 4 — seed / reset the Arunodhaya demo tenant (plan P4-08).
 *
 *   npx tsx scripts/demo/arunodhaya.ts seed  [--url <postgres-url>] [--did +91…]
 *   npx tsx scripts/demo/arunodhaya.ts reset [--url <postgres-url>] --yes
 *
 * Safety, in order of how badly each could go wrong:
 *
 *   - `reset` DEACTIVATES; it does not erase. Published agent versions are
 *     immutable by database trigger (0013) — a cascade delete of the tenant
 *     is refused by Postgres, and that refusal is correct: a published
 *     version is the record of what this agent was authorized to say on the
 *     day of a given call, and a demo reset is not a reason to lose it.
 *     So reset archives the agent, clears its live version and disables the
 *     DID. The tenant stops serving traffic immediately, `seed` brings it
 *     back, and the history survives. It is scoped to this one tenant slug,
 *     never touches another tenant, and still requires `--yes`.
 *   - Both refuse a database that is not local unless `--allow-remote` is
 *     passed, because the obvious accident is running this against
 *     production with a copied connection string.
 *   - `seed` is idempotent: fixed ids, every write an upsert. Running it
 *     twice changes nothing, so it is safe to re-run after a migration.
 *   - The published version is IMMUTABLE by trigger (0013). Seeding a
 *     changed configuration therefore creates a NEW version and repoints
 *     `live_version_id`; it never edits a published row, which is what makes
 *     "what was this agent authorized to say on that date?" answerable.
 *
 * It talks to Postgres through `psql` rather than the Supabase client, so it
 * needs no Supabase credentials and works against the throwaway database
 * `check:migrations` uses.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { requireArunodhaya, ARUNODHAYA_TENANT_SLUG } from "../../src/content/tenants/arunodhaya";

const DEFAULT_URL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";

/** Fixed ids: the whole point is that re-running changes nothing. */
const IDS = {
  business: "a4114044-0000-4000-8000-000000000001",
  agent: "a4114044-0000-4000-8000-000000000002",
  phoneNumber: "a4114044-0000-4000-8000-000000000003",
} as const;

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? (process.argv[index + 1] ?? null) : null;
}

function has(flag: string): boolean {
  return process.argv.includes(`--${flag}`);
}

function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "host.docker.internal";
  } catch {
    return false;
  }
}

function psql(url: string, sql: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "halo-demo-"));
  const file = path.join(dir, "demo.sql");
  writeFileSync(file, sql, "utf8");
  return execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-X", "-q", "-f", file], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/** Dollar-quoting: JSON and Telugu both pass through untouched. */
function lit(value: string): string {
  const tag = "$halo$";
  if (value.includes(tag)) throw new Error("value contains the quoting tag");
  return `${tag}${value}${tag}`;
}

function seedSql(did: string, handoff: string | null): string {
  const bundle = requireArunodhaya();
  const config = JSON.stringify(bundle.config);
  const promptVersion = `arunodhaya-${new Date().toISOString().slice(0, 10)}`;
  const handoffSql = handoff ? lit(handoff) : "null";

  return `
begin;

insert into public.businesses (id, name, slug, description, industry, phone, address)
values (
  '${IDS.business}', ${lit("Arunodhaya Solar")}, ${lit(ARUNODHAYA_TENANT_SLUG)},
  ${lit("Rooftop solar installation. Demo tenant for HALO Phase 4.")},
  ${lit("solar")}, ${lit(did)}, ${lit("Hyderabad, Telangana")}
)
on conflict (id) do update set name = excluded.name, description = excluded.description;

insert into public.agents (id, business_id, type, slug, display_name, status, default_channel)
values (
  '${IDS.agent}', '${IDS.business}', 'qualification',
  ${lit(bundle.agentSlug)}, ${lit("Arunodhaya Solar assistant")}, 'active', 'phone'
)
on conflict (id) do update set display_name = excluded.display_name, status = 'active';

-- A published version is immutable, so a changed configuration becomes the
-- NEXT version rather than an edit. Unchanged configuration inserts nothing.
with next as (
  select coalesce(max(version), 0) + 1 as v from public.agent_versions where agent_id = '${IDS.agent}'
), current as (
  select config from public.agent_versions
  where agent_id = '${IDS.agent}' and published_at is not null
  order by version desc limit 1
)
insert into public.agent_versions (agent_id, business_id, version, config, prompt_template, prompt_version, model, published_at)
select '${IDS.agent}', '${IDS.business}', next.v, ${lit(config)}::jsonb,
       ${lit(bundle.config.instructions.promptTemplate)}, ${lit(promptVersion)}, '{}'::jsonb, now()
from next
where not exists (select 1 from current where current.config = ${lit(config)}::jsonb);

update public.agents set live_version_id = (
  select id from public.agent_versions
  where agent_id = '${IDS.agent}' and published_at is not null
  order by version desc limit 1
) where id = '${IDS.agent}';

insert into public.phone_numbers (id, business_id, agent_id, provider, e164, handoff_number, status, label)
values (
  '${IDS.phoneNumber}', '${IDS.business}', '${IDS.agent}',
  ${lit(process.env.TELEPHONY_PROVIDER ?? "fake")}, ${lit(did)}, ${handoffSql}, 'active', ${lit("demo DID")}
)
on conflict (id) do update set e164 = excluded.e164, handoff_number = excluded.handoff_number, status = 'active';

commit;

select a.slug as agent, av.version as live_version, pn.e164 as did,
       coalesce(pn.handoff_number, '(none)') as handoff
from public.agents a
join public.agent_versions av on av.id = a.live_version_id
join public.phone_numbers pn on pn.agent_id = a.id
where a.id = '${IDS.agent}';
`;
}

/**
 * Scoped to this tenant only; a slug mismatch changes nothing.
 *
 * Deliberately not a delete. `agent_versions` is immutable by trigger, so
 * Postgres refuses the cascade — and rightly: erasing the published
 * configuration would erase the answer to "what was this agent allowed to
 * offer during that call?". Stopping traffic is what a reset actually needs.
 */
const RESET_SQL = `
begin;

update public.phone_numbers pn set status = 'disabled'
from public.businesses b
where pn.business_id = b.id and b.id = '${IDS.business}' and b.slug = ${lit(ARUNODHAYA_TENANT_SLUG)};

update public.agents a set status = 'archived', live_version_id = null
from public.businesses b
where a.business_id = b.id and b.id = '${IDS.business}' and b.slug = ${lit(ARUNODHAYA_TENANT_SLUG)};

commit;

select a.slug as agent, a.status, coalesce(a.live_version_id::text, '(none)') as live_version,
       pn.e164 as did, pn.status as did_status,
       (select count(*) from public.agent_versions v where v.agent_id = a.id) as versions_kept
from public.agents a
join public.phone_numbers pn on pn.agent_id = a.id
where a.business_id = '${IDS.business}';
`;

function main(): void {
  const mode = process.argv[2];
  const url = arg("url") ?? process.env.DATABASE_URL ?? DEFAULT_URL;

  if (!isLocal(url) && !has("allow-remote")) {
    console.error(`refusing to touch a non-local database (${new URL(url).hostname}).`);
    console.error("pass --allow-remote if you really mean it.");
    process.exit(1);
  }

  if (mode === "seed") {
    const did = arg("did") ?? "+919999900001";
    if (!/^\+[1-9]\d{7,14}$/.test(did)) {
      console.error(`--did must be E.164, got "${did}"`);
      process.exit(1);
    }
    const handoff = arg("handoff");
    // Loads and validates the whole bundle first: a configuration that would
    // be refused at runtime must not reach the database.
    requireArunodhaya();
    console.log(psql(url, seedSql(did, handoff)));
    console.log("seeded. re-running changes nothing unless the configuration changed.");
    return;
  }

  if (mode === "reset") {
    if (!has("yes")) {
      console.error(`this archives the "${ARUNODHAYA_TENANT_SLUG}" agent and disables its number.`);
      console.error("published versions are kept — they are immutable by design. re-run with --yes.");
      process.exit(1);
    }
    console.log(psql(url, RESET_SQL));
    console.log("reset: the agent is archived and the number disabled. versions kept; no other tenant touched.");
    return;
  }

  console.error("usage: arunodhaya.ts seed|reset [--url <postgres-url>] [--did +91…] [--handoff +91…] [--yes]");
  process.exit(1);
}

main();
