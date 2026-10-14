# AGENTS.md — rules for coding agents working on HALO

Read before every task. The target design is `docs/HALO_Architecture.md` (blueprint v0.1, referred to as "the blueprint", cited by §). Open and settled decisions are in `docs/DECISIONS.md`. Where the code and the blueprint disagree, do not silently change either one: record the gap and let the owner decide.

## Roles (blueprint §36)
- The owner sets product and architecture. **Claude Code builds** and fixes; **Codex reviews and debugs** (architecture, bugs, security, races, realtime behaviour, unnecessary complexity) and edits code only when a task explicitly assigns it a fix.
- Neither agent invents architecture. An architecture change goes into `docs/DECISIONS.md` as PENDING and waits for owner approval.

## Engineering rules (blueprint §37, §41)
- HALO is multi-tenant. Every request and data access is tenant-scoped.
- HALO is independent of OpsCorp.
- Business-specific behaviour belongs in tenant configuration or adapters, never in the shared runtime.
- Provider integrations must be replaceable: vendor code stays behind ports and adapters.
- Use structured tools for actions. The LLM decides; deterministic tools act. Never narrate a booking, transfer or delivery unless the tool confirmed it (§33).
- Never fabricate business information. A missing business fact or commercial limit stays UNSET and visible; never default it.
- Minimize LLM context (§9, §35).
- Prefer simple architecture (§27, §41 principle 10).
- Run tests before completion.

## Repository rules
- `packages/*` is industry-neutral and never imports the app (`src/`, `@/*`). Business content lives in tenant data, agent config and `src/content`. Enforced by `npm run check:neutral`.
- Runtime trust boundaries (dependency direction, no egress or dynamic execution in the reasoning core, closed tool registry with schema-validated arguments, RLS on every migrated table) are enforced by `npm run check:architecture`. Extend through ports and adapters, not by loosening the gate.
- Migrations are additive. Never edit a migration that may have been applied anywhere; a new migration needs owner approval.
- Safety checks based on regex or word lists must be language-configurable (Telugu-first). An English-only guard silently stops guarding Telugu.
- Changing prompt-composer code requires bumping `PROMPT_COMPOSER_VERSION` in `packages/runtime/prompt-composer.ts`.
- Keep the TTS text normalizer twins in sync: `packages/providers/voice-vendors/local-tts-text.ts` and `services/pipecat-worker/local_tts_text.py`, checked with `scripts/check-local-tts-text-parity.ts`.
- Voice-session invariants (serialized turns, single playback, handoff ownership, commit-point cancellation) need a test for each one a change touches.
- The current stack (TypeScript/Node + Python Pipecat worker) and layout differ from blueprint §27/§28. These are open decisions D1/D2: do not start a rewrite or restructure.

## Safety (POA, non-negotiable)
- **$0 spend is a hard limit.** No paid provider, LLM, speech, carrier, messaging or calendar calls, no outbound calls, no deployments and no production or shared-database writes without a named owner, target and written authorization for that exact action. Keep `HALO_OUTBOUND_ENABLED=false` and messaging in `log` mode.
- The local Supabase stack for this repo uses ports **5532x**. Ports 5432x belong to another project: never touch them.
- `check:migrations` and `check:rls` are destructive. Run them only against a fresh disposable database named `halo_check_<suffix>`, passed as an argument or `HALO_DISPOSABLE_DB_URL`.
- Never print, log or commit secrets (`.env.local`, `.env.hosted.local` and similar; only `.env.example` is tracked; never put a real secret in it). Validate with synthetic data only.
- Preserve the working tree. Without explicit instruction: no commit, push, branch switch, stash, reset, checkout over changes, or `git clean`. Never commit tracked edits without the untracked files they import.

## Task workflow
1. Work from an owner-approved task card: ID, objective, files in scope, out of scope, prerequisites, acceptance, commands, rollback.
2. Stay in scope. Log discovered issues for the backlog unless they block acceptance. No drive-by refactors; never mix cleanup with feature work.
3. Files on an active card belong to the implementing agent; the other agent treats them as read-only until handoff.
4. Implement → run the gates → report → Codex reviews the diff → fix the findings. A dependent task starts only after the previous one passes review.

### Gates
```bash
npm run typecheck && npm run lint && npm test
npm run check:architecture && npm run check:neutral && npm run preflight:ci
npm run build    # writes .next/ and public/widget.js (both gitignored)
.venv/bin/python -m unittest discover -s services/pipecat-worker -p 'test_*.py'
# DB-touching tasks only, on a fresh disposable DB (see Safety):
npm run check:migrations && npm run check:rls
# when local-tts-text changes:
npx tsx scripts/check-local-tts-text-parity.ts --lines N --seed S
```

### Report format
Task ID · changed files (`git diff --stat` and new files) · commands run with exact results · failures with output · skipped checks and why · unresolved issues · anything found but not fixed. Label every claim with its evidence level: **source**, **local test**, **disposable DB**, **staging** or **production**. A mock is not provider proof, and a passing build is not deployment proof.
