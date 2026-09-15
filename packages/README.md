# HALO Packages (`packages/*`)

This is the HALO Core workspace, extracted from the AI Receptionist monolith
(plan §2.3, §P1.1). The extraction is **move, do not improve**: files change
path and import specifier, nothing else.

## Dependency rule (plan §2.4 rule 2)

```
apps/  services/
   ↓
packages/*
```

- `packages/*` must **never** import from the application (`src/`, alias `@/*`)
  — enforced by the `no-restricted-imports` rule in `eslint.config.mjs` and by
  `scripts/check-neutral.mjs` (`npm run check:neutral`).
- HALO Core is business-agnostic: no `packages/*` file may reference a named
  industry or business — enforced by `npm run check:neutral` in CI.
  Business-specific content lives in tenant data, agent configuration,
  knowledge documents and app-layer seed content (`src/content/`).
- `packages/core` and `packages/ports` import nothing but each other and
  `packages/platform`.

## Packages (Phase 1 final state)

| Package | Contents |
| --- | --- |
| `packages/platform` | env, logger, crypto, ssrf, rate-limit, retry, ics, oauth-state, safe-redirect, cn |
| `packages/core` | domain models (types, scheduling, workflow, **agents**) + app-error |
| `packages/ports` | llm, embedding, knowledge, calendar, messaging, notification, speech, storage, ops |
| `packages/providers/*` | adapter implementations per port (llm, embedding, knowledge, calendar, messaging, notification, ops, speech, storage) |
| `packages/knowledge` | chunker, retrieval-query, **generic playbook mechanism (`playbooks.ts`)** |
| `packages/scheduling` | availability, booking service/orchestrator/draft, when-parser, timezone, appointment-state, repository |
| `packages/workflows` | engine, event-bus, action-registry, templates, store |
| `packages/crm` | crm-service, supabase store |
| `packages/lifecycle` | confirmation, reminders, manage, feedback, intake, no-show sweep, settings |
| `packages/analytics` | lifecycle + operations analytics |
| `packages/tenancy` | auth helpers (`requireBusiness`), supabase clients (admin/server/client) |
| `packages/agents` | agent repository, version lifecycle (draft → publish → rollback), **generic AgentResolver** |
| `packages/runtime` | **HALO Agent Runtime (Phase 2)**: contracts, channel profiles, context builder, conversation state, prompt composer, knowledge resolver, LLM adapter, tool registry/boundary, orchestration, response validator, memory, escalation, events (`docs/RUNTIME.md`). Depends only on core/ports/platform/knowledge; `stores/` is its persistence edge. Enforced by `npm run check:architecture`. |

## Agent model (Phase 1)

```
widget_key → receptionist (compatibility mapping, seeded by 0014)
           → agents (slug = receptionist id)
           → agent_versions (published live version)
           → ResolvedAgentContext → ChatService.respondForAgent(...)
```

- Prompt **content** comes from `agent_versions.prompt_template`
  (versioned in the database, published/rolled back without a deploy).
- Prompt **assembly + invariant safety rules** remain code-level, versioned by
  `PROMPT_ASSEMBLER_VERSION` in the app's `prompt-builder.ts`.
- The client never supplies agent or version identity; resolution is
  tenant-scoped end to end.
