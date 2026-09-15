# HALO Agent Runtime (Phase 2)

The Agent Runtime is the generic, channel-independent reasoning and
orchestration layer under `packages/runtime/`. The web chat widget is its
first channel; phone, WhatsApp and future business-specific agents reuse it
unchanged through a `ChannelProfile` and a channel adapter.

This document describes what is implemented as of Phase 2 — the code is the
source of truth; where the two disagree, fix the document.

## Pipeline

```
Trusted request context (route: widget key → receptionist → conversation row → agent version)
  │
  ▼
AgentRuntime.run(RuntimeInput)                                  packages/runtime/agent-runtime.ts
  ├─ load conversation state           ConversationStateStore   (degrade: empty state)
  ├─ load history                       ConversationStore        (user/assistant rows only)
  ├─ KnowledgeResolver.resolve          query rewrite → search → filter → budget   (degrade: none)
  ├─ SystemActionProviders.prepare      deterministic act-before-narrate (scheduling engine)
  ├─ selectTools                        granted ∩ bound ∩ channel ∩ precondition ∩ provider capability
  ├─ buildConversationContext           bounded, deterministic (ContextLimits)
  ├─ composePrompt                      persisted agent content + code-level Rules
  ├─ bounded model / tool loop          ≤ maxToolRounds; intents validated → authorized → executed once
  ├─ validateReply                      act-then-narrate, channel constraints, leak check
  │     └─ one corrective regeneration → honest safe fallback
  ├─ decideEscalation                   typed EscalationDecision
  ├─ updateMemory                       rolling recap, counters, escalation state
  ├─ persist transcript (+ tool rows) and state
  ├─ TurnHooks                          application post-turn work (lead capture, knowledge gaps)
  └─ RuntimeOutput { reply, state, actions, toolIntents/Results, validation, escalation, usage, events, timings, degraded }
```

`ChatService` (`src/core/services/chat-service.ts`) is the web-chat adapter:
it binds the application's trusted services to the runtime and keeps the
public surface (`respondForAgent`, deprecated `respond`) and the route
envelope `{ data: { reply } }` unchanged.

## Contracts (`packages/runtime/contracts.ts`)

| Contract | Purpose |
| --- | --- |
| `TrustedRequestContext` | tenant, conversation, agent, version, `turnId`; server-built only |
| `ResolvedAgentRuntimeContext` | business + agent/version identity + validated `AgentConfig` + persisted `promptTemplate` + model config |
| `ChannelProfile` | constraints per channel: reply length, markdown, interruption, confirmation, tool execution, latency, formatting rules |
| `RuntimeInput` / `RuntimeOutput` | the runtime boundary |
| `ConversationContext` | the ephemeral, bounded per-turn context |
| `ToolDescriptor` / `ToolIntent` / `ToolAuthorization` / `ToolResult` / `ActionRecord` | the four separated stages of an action |
| `ValidationOutcome` | verdict on the delivered reply |
| `EscalationDecision` | typed, channel-neutral handoff decision |
| `UsageMetadata` / `ModelCallUsage` | normalized per-turn usage; never fabricated |
| `RuntimeEvent` / `RuntimeEventSink` | tenant-safe structured telemetry |

## Trust model

- Tenant, agent and version identity come only from `TrustedRequestContext`
  and `ResolvedAgentRuntimeContext`, which routes build from rows they looked
  up themselves. The runtime re-checks that both agree on the tenant and the
  version and refuses (`FORBIDDEN`) on mismatch before doing anything.
- The model sees a system prompt, the recent transcript and the offered tool
  descriptors. It never sees tenant ids, credentials, authorization internals
  or unrelated tenants' data.
- The model may only *propose* actions. `toToolIntent` validates the name
  against a closed registry and the arguments against a strict zod schema
  (unknown keys such as `businessId`, `url`, `apiKey` are dropped);
  `authorizeIntent` applies application policy; `executeIntent` runs the
  application-bound executor with the trusted context; the outcome becomes a
  `ToolResult`/`ActionRecord`. Only then may the reply narrate it.
- There is no dynamic execution or egress in `packages/runtime` (enforced by
  `npm run check:architecture`): no `eval`, `Function`, `child_process`, `vm`,
  `fetch` or `process.env`.

## Channel profiles (`channel-profile.ts`)

Phase 2 ships `web-chat` and `web-voice` (the existing browser speech
accessory — not telephony). Adding a channel means adding a profile, never a
branch inside the runtime. The composer renders `formattingRules` as
"How you converse" and `spokenDeliveryRules` as "Voice mode".

## Context builder (`context-builder.ts`)

Deterministic and bounded by `ContextLimits` (defaults):

| Limit | Default |
| --- | ---: |
| recent verbatim messages | 16 |
| history fetched for recap | 40 |
| chars per message | 2000 |
| recap chars | 1200 |
| knowledge snippets / chars | 6 / 7200 |
| tool descriptors | 8 |
| customer facts | 8 |
| total variable context chars | 32 000 |

Over budget, it degrades in a fixed order: knowledge → recap → oldest history
(never below the last two messages), recording what was trimmed in
`budget.trimmed`.

## Conversation state (`conversation-state.ts`, migration 0019)

Typed (zod) working memory per conversation: intent, slots, qualification,
pending confirmation, workflow step, last tool intent, escalation status,
recap and counters. Updated only through `applyStatePatch` (bounded,
deterministic, validated). Stored in `conversation_state` (one row per
conversation, tenant-scoped, RLS members-read, service-role write).

It is separate from durable business state (appointments, leads, customers —
untouched) and from `booking_drafts` (still the scheduling engine's own
authority). Loads and saves are bounded by `stateTimeoutMs` (2 s) and degrade,
never fail the turn.

## Prompt composer (`prompt-composer.ts`)

Pure function. Section order: identity (persisted template) → business facts
→ customer → conversation state → recap → knowledge → channel → situations →
extras (tenant/app doctrine) → capabilities → **Rules** (code-level) → custom
instructions → verified system actions (ground truth, last).

- `PROMPT_COMPOSER_VERSION` (code) and `agent_versions.version` (content) are
  separate and both logged per turn.
- Retrieved knowledge and the recap are labelled as information, not
  instructions. Custom instructions are declared subordinate to the Rules.
- `src/core/services/prompt-builder.ts` delegates to the composer; the
  receptionist compatibility path supplies its persona/tone/playbook as a
  `PromptDoctrine`.

## Knowledge resolver (`knowledge-resolver.ts`)

`ProviderKnowledgeResolver` wraps the existing `KnowledgeProvider`: query
rewrite (`retrieval-query.ts`), tenant-scoped search, optional minimum score,
count and character budget, source labels. Limitations carried to Phase 3:
`collectionIds` are accepted but not applied (the port has no collection
parameter), and query preparation is English-centric.

## LLM port and adapter (`packages/ports/llm-provider.ts`, `llm-adapter.ts`)

The port gained optional `capabilities()` and `stream()`, tool descriptors,
tool calls, finish reasons and a per-call `timeoutMs` hint. Providers declare
what they support:

| Provider | streaming | native tools | notes |
| --- | --- | --- | --- |
| OpenAI-compatible (OpenAI, Groq, Mistral) | yes (SSE) | yes | tool transcripts serialized on the wire |
| Anthropic | yes (SSE) | yes | tool results grouped into one user message |
| Ollama | yes (NDJSON) | no (model-dependent; declared false) | tool turns flattened to text |
| Gemini | no | no | completion only |

`invokeModel` chooses streaming only when the provider supports it **and** a
delta consumer is present (the web route has none, so it completes); offers
native tools only to capable providers (otherwise emits
`tool.capability_downgraded`); races every call against the turn deadline;
retries only transient provider errors (never timeouts) per an explicit
policy (default: no retry); and normalizes usage without estimating.

## Tool boundary (`tools/registry.ts`, `tools/boundary.ts`)

Closed registry of two built-in tools, both mapped onto behaviour the product
already had and bound by the application (`src/core/services/lead-capture.ts`):

- `request_human_handoff` — records a typed escalation; permits **no** "I've
  told the team" claim on the web channel (nobody has been contacted yet).
- `save_contact_details` — persists through the existing lead path.

Tools are offered only when granted in `agent_versions.config.tools.grantedToolIds`
(default: none, so existing agents behave exactly as before), bound, allowed
by the channel, precondition-met and the provider takes native tools.
Duplicate intents (same turn, same name, same canonical arguments) are
rejected, never re-executed; executor failures are typed results, never
retried. Tool turns are transcribed as `messages.role = 'tool'` rows, which
history reads exclude.

The scheduling engine is not a model tool: it runs as a `SystemActionProvider`
(`packages/scheduling/booking-runtime-adapter.ts`) before the model, and its
typed outcome decides which claims the reply may make.

## Orchestration bounds (`RuntimePolicy`)

| Bound | Default |
| --- | ---: |
| tool rounds per turn | 2 (final call always without tools) |
| intents per round | 3 |
| turn deadline for model work | 120 s |
| state store load/save | 2 s each |
| corrective regenerations | 1 |
| model retry attempts | 1 (no retry) |

Model calls per turn ≤ rounds + 1 + regenerations.

## Response validator (`response-validator.ts`)

Enforces act-then-narrate as a check: claims of `appointment.book`,
`appointment.reschedule`, `appointment.cancel` and `handoff` are allowed only
when a succeeded `ActionRecord` permits that kind this turn. Also: empty
reply, leaked prompt markers, markdown on channels without it (stripped),
maximum length (trimmed at a sentence boundary). Repair ladder: transform →
one corrective regeneration → honest canned fallback (never a success claim).
`contact.saved` claims are typed but not enforced in Phase 2 (automatic lead
capture runs after the turn).

## Memory (`memory-manager.ts`)

Extractive rolling recap of messages that left the 16-message window, folded
oldest-first, capped at 1200 chars, refreshed when ≥ 4 messages have left the
window; stored text is sanitized (no fake section headers or role prefixes)
and labelled as data by the composer. No model call. Cross-conversation
customer recall is not implemented; the application may pass an authorized
`CustomerContext` explicitly.

## Escalation (`escalation-manager.ts`)

Deterministic, typed reasons: `explicit_human_request`,
`repeated_misunderstanding` (3 unanswered questions), `unsupported_request`
(rejected tool), `sensitive_situation` (tenant-configured
`guardrails.escalationTriggers`), `action_failed` (unrecoverable system
action), `low_confidence` (fallback reply). Recorded in state, emitted as
`escalation.triggered` once per conversation, and — from the web route — as
the business event `conversation.escalated` for tenant workflows. No transfer
or paging is performed.

## Events and usage

Every turn emits `runtime.started`, `knowledge.retrieved`, `context.built`,
`model.requested/completed/failed`, `tool.intent_proposed/rejected`,
`tool.capability_downgraded`, `action.executed/failed`, `response.validated`,
`memory.updated`, `escalation.triggered`, `runtime.completed/failed` with
counts, names, codes and durations only. The default sink logs them; the
route also records usage and latency on the existing `message_sent` usage
event.

## What Phase 2 deliberately does not do

- No telephony, no audio, no WebSockets, no voice gateway.
- No SSE streaming to the widget: the validator must see the whole reply
  before it is shown (act-then-narrate), so the route stays JSON. Streaming
  exists at the port/adapter level for future channels.
- No general Tool Runtime: two built-in tools, no custom code, no HTTP or
  database tools.
- No collection-scoped or multilingual retrieval (Phase 3).
- No billing; usage is captured, not priced.

## Validation

```bash
npm run typecheck && npm run lint && npm test
npm run check:neutral && npm run check:architecture
npm run check:migrations && npm run check:rls   # needs Postgres
npm run perf:baseline                            # runtime overhead, scripted model
```
