/** Real local PostgREST + Postgres, real widget routes/runtime, synthetic LLM HTTP.
 * Requires scripts/fixtures/chat-integration.sql on a fresh disposable instance.
 * Never loads .env.local. No external network destinations are permitted.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { NextRequest } from "next/server";

export async function runChatLocalIntegration() {
  assert.equal(process.env.HALO_DISPOSABLE_DATABASE, "1", "explicit disposable opt-in required");
  // A restore exercise may point this same application-path harness at a
  // second, explicitly named fixture. Never accept a general service URL.
  const restoredDatabase = process.env.HALO_LOCAL_RESTORED_DATABASE;
  if (restoredDatabase) assert.match(restoredDatabase, /^halo_check_restore_[a-z0-9_]+$/);
  const rest = restoredDatabase ? "http://127.0.0.1:55444" : "http://127.0.0.1:55442";
  const rawFetch = globalThis.fetch;
  const sign = (role: string, sub?: string) => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ role, sub, exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url");
    const signature = createHmac("sha256", "halo-disposable-synthetic-jwt-secret-20261013").update(`${header}.${payload}`).digest("base64url");
    return `${header}.${payload}.${signature}`;
  };
  const serviceToken = sign("service_role");
  const db = async (path: string, init: RequestInit = {}, token = serviceToken) => {
    const response = await rawFetch(`${rest}/${path}`, {
      signal: AbortSignal.timeout(5000), ...init, headers: { "content-type": "application/json", Authorization: `Bearer ${token}`, Prefer: "return=representation", ...init.headers },
    });
    assert(response.ok, `local database request failed: ${response.status} ${await response.clone().text()}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  assert.equal(await db("rpc/halo_integration_target", { method: "POST", body: "{}" }), `${restoredDatabase ?? "halo_check_integrations"}:synthetic-chat-20261013`);
  let modelCalls = 0;
  let mode: "ok" | "outage" | "slow" = "ok";
  let failDatabase = false;
  let failTranscript = false;
  let outboundAttempts = 0;
  const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith("/rest/v1/")) {
      if (failDatabase || (failTranscript && req.method === "POST" && req.url.includes("/messages"))) {
        res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ message: "synthetic database outage" })); return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const response = await rawFetch(`${rest}/${req.url.slice("/rest/v1/".length)}`, {
        method: req.method, headers: { "content-type": "application/json", Authorization: req.headers.authorization ?? "", Accept: req.headers.accept ?? "application/json", Prefer: String(req.headers.prefer ?? "") },
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    if (req.url === "/v1/chat/completions") {
      modelCalls++;
      let body = ""; for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      assert.equal(req.headers.authorization, "Bearer synthetic-llm-key");
      if (mode === "outage") { res.writeHead(503); res.end('{}'); return; }
      if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 300));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "Our synthetic opening hours are nine to five." }, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 10 } })); return;
    }
    outboundAttempts++; res.writeHead(403); res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== base && url.origin !== rest) { outboundAttempts++; throw new Error("External requests prohibited by integration harness"); }
    return rawFetch(input, init);
  }) as typeof fetch;
  // Override all provider selectors; credentials in the developer shell are never used.
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: base, NEXT_PUBLIC_SUPABASE_ANON_KEY: sign("anon"), SUPABASE_SERVICE_ROLE_KEY: serviceToken,
    NEXT_PUBLIC_APP_URL: base, LLM_PROVIDER: "groq", LLM_BASE_URL: `${base}/v1`, LLM_API_KEY: "synthetic-llm-key",
    LLM_MODEL: "synthetic-model", LLM_TIMEOUT_MS: "100", EMBEDDING_PROVIDER: "none", MESSAGING_PROVIDER: "log",
    HALO_OUTBOUND_ENABLED: "false", LOG_LEVEL: "error",
  });
  delete process.env.HALO_MODEL_ROUTES;
  const checks: string[] = [];
  const pass = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
  try {
    const { POST: start } = await import("../src/app/api/v1/widget/conversations/route");
    const { POST: message } = await import("../src/app/api/v1/widget/messages/route");
    const tenants = await db("businesses?slug=in.(halo-integration-a,halo-integration-b)&order=slug");
    assert.equal(tenants.length, 2);
    const [a, b] = tenants;
    const previousUsageIds = new Set((await db(`usage_events?business_id=eq.${a.id}&event_type=eq.message_sent`)).map((row: { id: number }) => row.id));
    const invalidAuth = await rawFetch(`${rest}/businesses?select=id`, { headers: { Authorization: "Bearer invalid-synthetic-jwt" }, signal: AbortSignal.timeout(5000) });
    assert.equal(invalidAuth.status, 401);
    pass("PostgREST rejects invalid authentication signature");
    const [receptionist] = await db(`receptionists?business_id=eq.${a.id}`);
    const request = (body: unknown, origin = "https://halo.example.invalid", signal?: AbortSignal) => new NextRequest(`${base}/api/v1/widget/test`, {
      method: "POST", headers: { "content-type": "application/json", origin, "x-forwarded-for": "192.0.2.1" }, body: JSON.stringify(body), signal,
    });
    assert.equal((await start(request({ widgetKey: receptionist.widget_key }, "https://denied.invalid"))).status, 403);
    pass("origin allowlist before conversation creation");
    const created = await start(request({ widgetKey: receptionist.widget_key })); assert.equal(created.status, 201);
    const { data: { visitorToken } } = await created.json();
    const [conversation] = await db(`conversations?visitor_token=eq.${visitorToken}`);
    assert.equal(conversation.business_id, a.id); assert(conversation.agent_id && conversation.agent_version_id);
    pass("conversation created with pinned tenant/agent/version in real database");
    assert.equal((await message(request({ visitorToken: "unknown-token-0000000000", message: "hello" }))).status, 404);
    assert.equal((await message(request({ visitorToken, message: " " }))).status, 400);
    assert.equal(modelCalls, 0); pass("invalid input and unauthorized visitor token make no LLM request");
    for (const text of ["What are your opening hours?", "And those hours again?"]) {
      const response = await message(request({ visitorToken, message: text, agentId: "untrusted", agentVersionId: "untrusted" }));
      assert.equal(response.status, 200); assert.match((await response.json()).data.reply, /nine to five/);
    }
    assert.equal(modelCalls, 2);
    assert(requests[1].messages.some((m) => m.role === "user" && m.content === "What are your opening hours?"));
    assert(requests[0].messages[0].content.includes("Synthetic opening hours"));
    const transcript = await db(`messages?conversation_id=eq.${conversation.id}`); assert.equal(transcript.length, 4);
    const [continued] = await db(`conversations?id=eq.${conversation.id}`); assert.equal(continued.message_count, 4);
    const state = await db(`conversation_state?conversation_id=eq.${conversation.id}`); assert.equal(state.length, 1);
    pass("two-turn runtime, real knowledge retrieval, transcript/state and continuity; synthetic LLM HTTP");
    const usage = (await db(`usage_events?business_id=eq.${a.id}&event_type=eq.message_sent`)).filter((row: { id: number }) => !previousUsageIds.has(row.id));
    assert.equal(usage.length, 2); assert(usage.every((e: { metadata: { totalTokens: number; provider: string } }) => e.metadata.totalTokens === 40 && e.metadata.provider === "groq"));
    pass("usage attribution persisted under correct tenant (synthetic token counts)");
    const otherUser = sign("authenticated", "b1000000-0000-4000-8000-000000000001");
    assert.deepEqual(await db(`conversations?id=eq.${conversation.id}`, {}, otherUser), []);
    const visible = await db("businesses?select=id", {}, otherUser); assert.deepEqual(visible, [{ id: b.id }]);
    pass("signed local JWT authorization and actual PostgREST RLS isolate second tenant; no Auth login claim");
    const beforeOutage = modelCalls; mode = "outage";
    const outage = await message(request({ visitorToken, message: "Are you open?" })); assert.equal(outage.status, 200);
    assert.doesNotMatch((await outage.json()).data.reply, /Our synthetic opening hours/);
    assert(modelCalls - beforeOutage <= 2); mode = "ok";
    pass("provider 503 yields bounded retry and honest fallback");
    failDatabase = true; const beforeDb = modelCalls;
    assert.equal((await message(request({ visitorToken, message: "hello" }))).status, 500);
    assert.equal(modelCalls, beforeDb); failDatabase = false;
    pass("database lookup outage fails before inference");
    failTranscript = true;
    assert.equal((await message(request({ visitorToken, message: "What are your hours?" }))).status, 500); failTranscript = false;
    pass("transcript write failure never returns success");
    mode = "slow";
    const slow = await message(request({ visitorToken, message: "What are your hours?" })); assert.equal(slow.status, 200);
    assert.doesNotMatch((await slow.json()).data.reply, /Our synthetic opening hours/); mode = "ok";
    pass("actual HTTP timeout cannot return late LLM success");
    const cancel = new AbortController(); cancel.abort(); const beforeCancel = modelCalls;
    assert.equal((await message(request({ visitorToken, message: "hello" }, undefined, cancel.signal))).status, 499);
    assert.equal(modelCalls, beforeCancel); pass("cancelled web request performs no model work");
    mode = "slow";
    const inFlightCancel = new AbortController();
    const rowsBeforeCancel = (await db(`messages?conversation_id=eq.${conversation.id}`)).length;
    const cancelTimer = setTimeout(() => inFlightCancel.abort(), 50);
    try {
      assert.equal((await message(request({ visitorToken, message: "What are your hours?" }, undefined, inFlightCancel.signal))).status, 499);
    } finally { clearTimeout(cancelTimer); }
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal((await db(`messages?conversation_id=eq.${conversation.id}`)).length, rowsBeforeCancel);
    mode = "ok";
    pass("in-flight cancellation cannot persist a late successful response");
    await db(`conversations?id=eq.${conversation.id}`, { method: "PATCH", body: JSON.stringify({ message_count: 200 }) });
    const beforeLimit = modelCalls;
    assert.equal((await message(request({ visitorToken, message: "hello" }))).status, 409); assert.equal(modelCalls, beforeLimit);
    pass("conversation usage ceiling stops inference");
    assert.equal(outboundAttempts, 0);
    for (const table of ["appointments", "workflow_runs", "calls", "leads"]) assert.equal((await db(`${table}?business_id=eq.${a.id}`)).length, 0);
    pass("disabled booking, workflows, speech, telephony and notifications have no external side effects");
    const result = { checksPassed: checks.length, checks, real: ["Postgres", "PostgREST", "JWT verification", "RLS", "Supabase adapters"], synthetic: ["LLM", "Auth users/JWT issuer"], externalRequests: outboundAttempts };
    writeFileSync("/tmp/halo-chat-integration-result.json", JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result));
  } finally {
    globalThis.fetch = rawFetch;
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

