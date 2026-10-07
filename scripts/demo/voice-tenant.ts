/**
 * Seed a voice-ready development tenant from a JSON description.
 *
 *   npm run demo:voice-tenant                       # scripts/demo/voice-tenant.example.json
 *   npm run demo:voice-tenant -- --file my-tenant.json
 *
 * Generic: nothing here names a business. The tenant, its agent configuration,
 * its deterministic voice lines and its voice route all come from the file, so
 * the next tenant is another file, not another script.
 *
 * It provisions through the platform's own mechanisms rather than raw rows:
 *
 *   - the tenant is created by `create_business_with_owner`, called as a real
 *     signed-in owner — the onboarding path, which also provisions settings,
 *     the receptionist (and its public widget key) and the agent with a
 *     published version 1;
 *   - the voice configuration is a NEW agent version created and published by
 *     `AgentVersioningService`. Published versions are immutable (0013), so a
 *     changed file becomes the next version; an unchanged file publishes
 *     nothing;
 *   - the voice route is the tenant's `phone_numbers` row for the deployment's
 *     TELEPHONY_PROVIDER, pointing at that same agent. A browser call reaches
 *     the agent this route resolves to (services/voice-gateway/index.ts).
 *
 * Idempotent: re-running changes nothing unless the file changed. Refuses a
 * database that is not local unless `--allow-remote` is passed. Reads the
 * Supabase URL and keys from the environment and prints no credential.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { parseAgentConfig } from "@halo/core/domain/agents";
import { SupabaseAgentRepository } from "@halo/agents/agent-repository";
import { AgentVersioningService } from "@halo/agents/agent-versioning";
import { REQUIRED_VOICE_PROMPTS } from "@halo/voice/session-config";

const day = z.object({ open: z.string(), close: z.string(), closed: z.boolean() });
const tenantFile = z.object({
  business: z.object({
    name: z.string().min(1).max(120),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/),
    description: z.string().default(""),
    industry: z.string().default(""),
    address: z.string().default(""),
    businessHours: z.record(z.string(), day).default({}),
  }),
  /** Owner account used for onboarding; created when it does not exist. */
  ownerEmail: z.string().email(),
  /** E.164 route the tenant's voice agent answers on. */
  voiceRoute: z.string().regex(/^\+[1-9]\d{7,14}$/),
  receptionist: z.object({ name: z.string().min(1).max(80), language: z.string().min(2), greeting: z.string().min(1) }),
  /** An `AgentConfig` block, validated by the platform's own parser. */
  agent: z.record(z.string(), z.unknown()),
});

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? (process.argv[index + 1] ?? null) : null;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function isLocal(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "host.docker.internal";
}

/** Key-order independent: jsonb does not preserve the order a config was written in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
}

function must<R extends { data: unknown; error: { message: string } | null }>(result: R, what: string): NonNullable<R["data"]> {
  if (result.error || result.data === null || result.data === undefined) {
    throw new Error(`${what} failed${result.error ? `: ${result.error.message}` : ""}`);
  }
  return result.data as NonNullable<R["data"]>;
}

/** Onboards the tenant as its owner, exactly as the dashboard does. */
async function onboard(admin: SupabaseClient, url: string, email: string, name: string, slug: string): Promise<string> {
  // A fresh random password each run: the script signs in once and forgets it.
  // The owner resets it through the normal flow if they want the dashboard.
  const password = randomBytes(24).toString("base64url");
  const users = must(await admin.auth.admin.listUsers({ page: 1, perPage: 1000 }), "owner lookup").users;
  const existing = users.find((user) => user.email === email);
  if (existing) must(await admin.auth.admin.updateUserById(existing.id, { password }), "owner update");
  else must(await admin.auth.admin.createUser({ email, password, email_confirm: true }), "owner creation");

  const owner = createClient(url, env("NEXT_PUBLIC_SUPABASE_ANON_KEY"), { auth: { autoRefreshToken: false, persistSession: false } });
  must(await owner.auth.signInWithPassword({ email, password }), "owner sign-in");
  return must(await owner.rpc("create_business_with_owner", { business_name: name, business_slug: slug }), "tenant onboarding") as string;
}

async function main(): Promise<void> {
  const url = env("NEXT_PUBLIC_SUPABASE_URL");
  if (!isLocal(url) && !process.argv.includes("--allow-remote")) {
    throw new Error(`refusing to seed a non-local database (${new URL(url).hostname}); pass --allow-remote if you really mean it`);
  }
  const file = path.resolve(arg("file") ?? "scripts/demo/voice-tenant.example.json");
  const tenant = tenantFile.parse(JSON.parse(readFileSync(file, "utf8")));

  // Validate the whole agent block first: a configuration the gateway would
  // refuse to answer must not be published.
  const config = parseAgentConfig(tenant.agent);
  if (!config) throw new Error("agent: not a valid agent configuration");
  const missing = REQUIRED_VOICE_PROMPTS.filter((key) => !config.voice.prompts[key]?.trim());
  if (missing.length > 0) throw new Error(`agent: voice prompts missing: ${missing.join(", ")}`);

  const admin = createClient(url, env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } });

  const found = await admin.from("businesses").select("id").eq("slug", tenant.business.slug).maybeSingle();
  if (found.error) throw new Error(`tenant lookup failed: ${found.error.message}`);
  const created = !found.data;
  const businessId = found.data?.id ?? (await onboard(admin, url, tenant.ownerEmail, tenant.business.name, tenant.business.slug));

  must(await admin.from("businesses").update({
    name: tenant.business.name, description: tenant.business.description, industry: tenant.business.industry,
    address: tenant.business.address, business_hours: tenant.business.businessHours,
  }).eq("id", businessId).select("id").single(), "business update");

  const receptionist = must(await admin.from("receptionists").update({
    name: tenant.receptionist.name, language: tenant.receptionist.language, greeting: tenant.receptionist.greeting,
    voice_enabled: true, is_active: true,
  }).eq("business_id", businessId).select("id, widget_key").single(), "receptionist update");

  // The widget resolves its agent by slug = receptionist id (0021). The voice
  // route below points at that same agent, so chat and voice share one agent.
  const versioning = new AgentVersioningService(new SupabaseAgentRepository(admin));
  const agent = await versioning.findBySlug(businessId, receptionist.id);
  if (!agent) throw new Error("onboarding did not provision an agent for this tenant");

  const live = await versioning.getLiveVersion(agent.id, businessId);
  let version = live;
  if (!live || canonical(live.config) !== canonical(config)) {
    const draft = await versioning.createDraftVersion({
      agentId: agent.id, businessId, config,
      promptTemplate: config.instructions.promptTemplate,
      promptVersion: `voice-tenant-${new Date().toISOString().slice(0, 10)}`,
    });
    version = await versioning.publishVersion(agent.id, businessId, draft.version);
  }

  const provider = process.env.TELEPHONY_PROVIDER ?? "fake";
  must(await admin.from("phone_numbers").upsert({
    business_id: businessId, agent_id: agent.id, provider, e164: tenant.voiceRoute, status: "active", label: "voice route",
  }, { onConflict: "provider,e164" }).select("id").single(), "voice route");

  const app = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  console.log([
    `tenant         ${tenant.business.name} (${created ? "created" : "existing"})  ${businessId}`,
    `agent          ${agent.id}`,
    `live version   v${version!.version}${version === live ? " (unchanged)" : " (published now)"}  language ${config.language.primary}`,
    `voice route    ${provider} ${tenant.voiceRoute}`,
    `widget key     ${receptionist.widget_key}  (public identifier, not a secret)`,
    `open           ${app}/widget-demo?key=${receptionist.widget_key}`,
  ].join("\n"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
