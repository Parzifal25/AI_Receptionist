# Security Model

## Tenancy isolation

Two enforcement domains, both scoped by `business_id`:

1. **Dashboard (RLS-enforced).** All dashboard reads/writes run as the signed-in user with the
   anon key. Every tenant table has RLS enabled with policies built on two `SECURITY DEFINER`
   helpers — `is_business_member(business_id)` and `is_business_admin(business_id)` — so a user
   can never read or mutate another tenant's rows, even if application code has a bug. Server
   actions additionally filter by `business_id` (defense in depth).

2. **Widget API (code-enforced, service role).** Website visitors have no Supabase identity, so
   the widget API uses the service-role client — but *only* inside `WidgetRepository`, whose
   every method requires a tenant proof:
   - **Widget key** (public, in the embed snippet): grants only "read branding/greeting" and
     "start a conversation". It cannot read any stored data.
   - **Visitor token** (48 hex chars, `gen_random_bytes(24)`, unique): minted per conversation,
     held in the visitor's `sessionStorage`, and is the only way to append to or continue that
     conversation. Tokens are unguessable and single-conversation-scoped.

   The service-role key is imported through `src/lib/supabase/admin.ts`, which is marked
   `server-only` — the build fails if any client component ever imports it.

## What the browser never receives

- Supabase service-role key (server only, build-enforced)
- LLM API keys (server only)
- System prompts / retrieved knowledge context (the model is instructed not to reveal them, and
  they are never serialized to the client)
- Other conversations' data (visitor tokens scope access to one conversation)
- Calendar OAuth tokens / CalDAV credentials — `calendar_connections` has **no RLS policies at
  all** (service-role only, by design); nothing short of the service role or direct database
  access can read them, and they never appear in any dashboard or widget API response

## Prompt-injection resistance

Visitor messages are explicitly framed in the system prompt as untrusted input, not instructions:
attempts to make the receptionist "ignore your instructions," roleplay a different persona, or
reveal its configuration are treated as off-topic and deflected back to the business. A
business's own custom instructions are likewise subordinated to the safety rules, so a
misconfigured custom instruction can't override anti-hallucination or scope-of-service
constraints. Covered by `tests/unit/prompt-builder.test.ts`.

## Input validation

Every mutation — server action or API route — parses its input with Zod before touching the
database: length limits, format checks (email, hex colors, domains, UUIDs), and enum
whitelists. Database `CHECK` constraints back the same limits at the storage layer.

## Rate limiting

Sliding-window limiter (`src/lib/rate-limit.ts`): widget config 60/min/IP, session + lead
creation 10/min/IP, messages 20/min per IP **and** per visitor token (so minting new tokens
doesn't reset the budget). The limiter interface is async so a Redis implementation can replace
the in-memory one for multi-instance deployments without changing call sites.

## Embed-domain allow-listing

Businesses can restrict which domains may embed their widget (settings → allowed domains).
Enforcement compares the request `Origin` hostname (exact or subdomain match) at config fetch
and conversation creation. Empty list = allow all, the sensible default while installing.

## Widget isolation

The widget renders in a **closed shadow root**: host-page CSS/JS cannot reach into it, and it
cannot leak styles out. All text content is inserted with `textContent`; the only `innerHTML`
usage is static SVG icons and HTML-escaped branding strings.

## On Subresource Integrity (SRI) for the embed snippet

The embed snippet deliberately omits `integrity=` hashes. SRI pins an exact file hash, which
would break every widget auto-update (each deploy would invalidate every customer's snippet) —
this is why Intercom, Crisp and Stripe.js snippets also omit SRI. The widget is served
first-party from the app's own origin (not a third-party CDN), so the trust boundary is the
same as the API the widget talks to. If a separate CDN origin is introduced later, revisit with
versioned, hash-pinned bundles as an opt-in for enterprise customers.

## Agent runtime boundaries (Phase 2)

- **Server-authoritative identity.** Tenant, agent and agent version reach the runtime only in
  a `TrustedRequestContext` built by the route from rows it looked up (widget key → receptionist
  → conversation row → tenant-scoped version lookup). The runtime refuses a context whose
  tenant or version disagrees with the resolved agent. The request body cannot name an agent or
  version; a conversation row pointing at another tenant's version cannot resolve it.
- **The model proposes, application code decides.** Model tool calls become `ToolIntent`s only
  after the name matches a closed registry and the arguments validate against a strict schema
  (unknown keys such as ids, URLs or keys are dropped). Authorization (granted, bound,
  channel, precondition, confirmation, duplicate) is application policy; execution runs
  application-bound executors with the trusted context; a failure is a typed result, never
  retried. There are exactly two built-in tools, none granted by default.
- **No code or network from the reasoning core.** `packages/runtime` contains no `eval`,
  `Function`, `child_process`, `vm`, `fetch` or `process.env` — enforced by
  `npm run check:architecture`, together with dependency direction (runtime → ports/core/platform
  only; providers never import the runtime) and RLS on every migrated table.
- **Act-then-narrate is checked, not just prompted.** The validator rejects replies claiming a
  booking, reschedule, cancellation or handoff unless a verified action of that kind happened
  this turn; one corrective regeneration, then an honest fallback that never claims success.
- **Bounded everything.** Recent history 16 messages, recap 1200 chars, knowledge 6 snippets /
  7200 chars, tool descriptors 8, total context 32 000 chars; ≤ 2 tool rounds, ≤ 3 intents per
  round, 120 s turn deadline, 2 s state-store timeout, 1 regeneration.
- **Memory is data, not instruction.** The recap and retrieved documents are labelled as
  information in the prompt; stored text is sanitized so it cannot masquerade as a prompt
  section or a role. Conversation state is tenant-scoped (`conversation_state`, RLS members-read,
  service-role write); no other tenant's history or state can reach a prompt.
- **Tenant-safe telemetry.** Runtime events carry counts, names, codes and durations — never
  message text, prompts, secrets or contact details.

## Workflow automation surface

- **Inbound webhook trigger** (`POST /api/hooks/:businessId`): disabled until the tenant sets
  `business_settings.workflow_webhook_secret`; the token is compared timing-safely; bodies are
  capped at 32 KB and must be JSON. The event only fires that tenant's `webhook.received`
  workflows — payloads are data, never instructions.
- **Outbound webhooks** (`call_webhook` action): full SSRF guard (`src/lib/ssrf.ts`) —
  HTTPS-only, and the hostname is DNS-resolved with every answer checked against
  loopback/private/link-local (incl. cloud metadata)/CGNAT/unspecified ranges before any
  request is made; redirects are never followed (a 3xx is a failed delivery), so a public host
  can't bounce the request into a private one. 30 s default timeout; correlation headers
  instead of secrets in the body. Residual: DNS rebinding between check and fetch — pin the
  resolved IP with a custom agent if tenant threat models ever warrant it.
- **OAuth connect flow** (Google Calendar): HMAC-signed state bound to the business + CSRF
  nonce cookie, 10-minute TTL, admin-only; tokens live in `calendar_connections`, a table with
  **no** RLS policies (service-role only) so they can never reach a browser session.
- **Workflow tables**: dashboard users get read-only RLS access (observability); all writes go
  through the service role with tenant scoping in code.

## Secrets & configuration

All secrets flow through environment variables validated by `src/lib/env.ts`. `.env*` files are
git-ignored; `.env.example` documents every variable without values.

## Abuse containment

- Message length capped at 2 000 chars; LLM output capped via `maxTokens`.
- Conversation history sent to the model is capped at the last 16 messages.
- The system prompt instructs the model to refuse off-topic use (visitors trying to use the
  widget as a free general-purpose chatbot).
- All AI provider failures map to an opaque `PROVIDER_ERROR` — no stack traces or internals in
  responses; full detail goes to structured server logs only.
