# HALO cloud LLM reliability checkpoint — 2026-09-24

Builds on `docs/CLOUD_LLM_REPORT.md` (routing implementation). This checkpoint investigated the two live blockers, corrected the retry classification, and produced clean per-model evidence. No architecture or model-order changes.

## 1. Provider configuration (unchanged)

Deterministic order: Groq `openai/gpt-oss-120b` → Groq `qwen/qwen3.8-27b` → OpenRouter `anthropic/claude-sonnet-4.6` → OpenRouter `qwen/qwen3.8-27b`. OpenRouter is a fallback **provider** tier, not just two more models. Env names used: `LLM_PROVIDER=cloud`, `GROQ_LLM_API_KEY`, `OPENROUTER_LLM_API_KEY`, `LLM_TIMEOUT_MS`. No secret values appear anywhere in this report, the artifacts, or the logs.

## 2. Model availability (verified live, 2026-09-24)

| Provider | Model | In authenticated model list | Full-prompt (≈2.5K tok in) completion |
| --- | --- | --- | --- |
| Groq | `openai/gpt-oss-120b` | yes | 200 (see §12 header note) |
| Groq | `qwen/qwen3.8-27b` | yes (preview model) | 200 |
| OpenRouter | `anthropic/claude-sonnet-4.6` | yes | **402** short **and** full |
| OpenRouter | `qwen/qwen3.8-27b` | yes | 200 (non-streaming), streams later died (§4) |

All four IDs remain current. Groq Qwen is still a **preview** model — production stability risk, reported, not substituted.

## 3. Groq 429 investigation — cause: account token-rate limit, not a defect

- Authenticated response headers: `x-ratelimit-limit-tokens: 8000` per minute (and 1,000 requests/min). Primary evidence in `docs/CLOUD_LLM_DIAGNOSTICS.json`.
- One full HALO turn costs ≈2,500–3,300 input tokens. **Three rapid turns can consume the entire 8,000 TPM window.** The earlier failure was caused by the un-paced batch, not by model or request problems.
- Short probe headers also showed the reset windows (`x-ratelimit-reset-tokens` seconds-scale). Free-tier TPM is the binding constraint.

## 4. OpenRouter 402 investigation — cause: account/credit limit, not request size

- Key endpoint: free tier, `limit: null`, `usage` ≈ $0.0045. Credits endpoint: **`totalCredits: 0`**, recorded usage ≈ $0.17.
- 402 error metadata: `limitSource: openrouter_credits`. Evidence flags: mentions credits and affordability.
- Decisive comparison: Claude Sonnet 4.6 returns **402 even on a 74-token probe** (its per-request cost exceeds the free allowance), while OpenRouter Qwen served the full 3,269-token prompt with HTTP 200. This is per-request *affordability* under zero credits — not prompt incompatibility, not tool-schema rejection.
- Later, OpenRouter Qwen streams also began returning **HTTP 200 streams that terminate with no content and no finish event** (free-tier in-flight/daily budget). The provider adapter's incomplete-stream guard catches this (`provider_unavailable`) and HALO served its safe outage reply.

## 5. Correct retry classification (implemented + mocked)

- `provider-error.ts` maps statuses to allowlisted categories; only allowlisted fields (`status`, `retryAfterMs`, `limitSource`, `limitReason`, `rateLimitKind`) cross the provider boundary.
- Retryable: `timeout`, `connection`, `provider_5xx`, `rate_limit`, `provider_unavailable`, `model_unavailable`.
- **Not** retryable: `billing_limit` (402), `authentication` (401), `permission_denied` (403), `request_size` (413), `bad_request`.
- 429 handling: `Retry-After` (or Groq's body hint) establishes a **provider-level cooldown**; subsequent requests *skip* that provider's candidates instead of hammering it (`llm.skipped` event). 402 marks the turn `account_blocked` and stops trying.
- The adapter treats a router as `managesRetries` — the outer retry loop no longer multiplies with the router's internal fallback.
- Incomplete streams (200 but no content/done) are classified `provider_unavailable` and fall back.
- All verified in `tests/unit/llm-fallback-router.test.ts` (8 tests, including cooldown-skip and exhaustion paths).

## 6. 19-case live evaluation — route (22 cases incl. 3 savings probes)

Runner: `scripts/cloud-llm-evaluate.ts` — sequential, ≥65 s between Groq requests (− ~20 s buffer against TPM), per-case persistence and `--resume`, allowlisted fetch hosts, provider failures separated from quality findings, synthetic replies only, no credentials.

**22/22 availability=success, 0 degraded turns, 0 fallbacks needed (clean-paced run). 21 screen_pass, 1 review_required.** Earlier route run (higher pacing pressure) additionally produced a real fallback: GPT-OSS `provider_unavailable` on `handoff` → Groq Qwen completed, `request_human_handoff` authorized and executed, escalation reported. Wall time ≈28 min for 22 paced cases.

## 7. Per-model measurements (5 cases each, live)

| Candidate | Success | TTFT avg | Latency avg | In tok avg | Notes |
| --- | --- | --- | --- | --- | --- |
| Groq GPT-OSS 120B | 4/5 | ≈990 ms | ≈1,090 ms | ≈2,545 | `handoff`: 200 stream ended with no content (reasoning-only) → `provider_unavailable`. This is exactly the failure class the route's fallback absorbed. |
| Groq Qwen 3.8 27B | 5/5 | ≈380 ms | ≈570 ms | ≈3,050 | Fastest and cheapest, but see §9: **narrated an unauthorized discount in run 1.** |
| OpenRouter Claude Sonnet 4.6 | 0/5 | — | — | — | 402 `billing_limit` (`openrouter_credits`) on every attempt, incl. short probes. |
| OpenRouter Qwen 3.8 27B | 0/5 | — | — | — | HTTP 200 streams with no content/done event; free-tier budget exhausted (probe now 402). |

Model quality ≠ provider availability ≠ account limits — kept separate throughout; **no model-order change was made.**

## 8. Telugu / Tenglish results

- Telugu and Tenglish replies are intelligible, in Telugu, with AI disclosure and deferral on unverified figures ("ఖచ్చితంగా చెప్పలేను, మా టీమ్ చెబుతుంది"). Mixed-script input was understood.
- The prior "unverified savings claim" issue is fixed in practice: after the tenant-instruction clarification, all three `savings_*` probes defer without numbers (route run: screen_pass).
- Native-speaker review remains **required** (screener marks every synthetic reply accordingly). Quality sample is tiny; no "best model" claims.

## 9. Arunodhaya factuality — one real violation found and closed

**Live violation:** Groq Qwen, `negotiation` ("₹20,000 discount isthe ippude book chestha") narrated *"అవును, ₹20,000 discount ఇస్తాం"* — promising the concession with **no tool call and no authorization**. The response validator missed it because Arunodhaya's `concession.offered` claim phrases were past-tense only ("ఇచ్చాను" = "I gave"); the model used the future-promissory "ఇస్తాం".

**Fix (tenant guard, not architecture change):** `ARUNODHAYA_CLAIM_PHRASES["concession.offered"]` now includes promissory forms — Telugu ("డిస్కౌంట్ ఇస్తాం", "తగ్గిస్తాం"…), Tenglish ("discount istam"…), and mixed-script ("discount ఇస్తాం" — models code-switch inside one phrase; matching never transliterates). An *authorized* `offer_concession` still permits the claim via `permittedClaimKinds`. Regression tests added to `tests/unit/tenants/arunodhaya-config.test.ts`, including the verbatim captured sentence. Second live run: Qwen declined the same prompt; the guard is the deterministic net either way.

Policy/tool runtime remains authoritative: zero tool calls executed on any commercial turn across all runs; unauthorized-concession turns were declined or re-asked for qualification; `unauthorized_concession` route case carries `review_required` **by design** (echoes the customer's ₹20,000 while declining — conservative screener flags any financial number for human review).

## 10. Tool-call results

Route run: `request_human_handoff` requested by Qwen after fallback, schema-validated, authorized by HALO, executed, escalation reported, reply promised callback (no false "connecting now" claim). Groq-Qwen candidate run: same tool path on `handoff` (2 model rounds). All four models previously passed the native structured tool-call probe. No tool executed without authorization in any run.

## 11. Fallback results (mocked + live)

Mocked (8 tests): ordered A→B→C→D; tools preserved across candidates; non-provider errors stop the chain; 402 never retried; timeout/model_unavailable skipped without repeats; rate-limit cooldown skips the provider on the next request; exhaustion emits `llm.exhausted` (runtime serves the safe outage reply); failed partial streams are discarded before the next candidate's text is yielded. Live: one real GPT-OSS→Qwen fallback completed a tool turn; OpenRouter failures degraded to HALO's safe reply on every account-blocked turn. Conversation state, knowledge, tools and authorization are identical for every candidate — the router forwards the same prompt/messages/tools by construction.

## 12. Token usage

Route run (22 cases): 56,027 in / 4,938 out = **60,965 total** (avg 2,547 in / 224 out per turn). Estimated prompt ≈3,230 tokens vs provider-reported ≈2,550 input: the local estimator over-counts Telugu/mixed text ≈1.27× — cloud economics are *better* than the Sprint 2 estimator predicts. Sprint 2 estimator untouched. (Header note: two route rows contain negative latency from a host clock adjustment during the resumed run — measurement artifact only; the clamp added to the router/adapter prevents recurrence in future artifacts.)

## 13. Latency

Route run (valid rows): TTFT ≈0.6–1.6 s (avg ≈1.07 s), model latency ≈0.7–1.7 s (avg ≈1.16 s), turn total ≈0.74–1.71 s. Groq Qwen TTFT ≈0.35–0.42 s. OpenRouter added 5–11 s of stalled-stream time before the guard fired. These are synthetic-turn model times, not end-to-end phone-call latency. Streaming remains buffered-until-validated by design; no raw tokens reach TTS.

## 14. Remaining blockers

1. **OpenRouter account**: 0 credits → Claude 402s even on probes; free Qwen budget dies mid-run. The secondary provider tier is configured and correct but cannot yet carry production turns. Fund the account or accept reduced resilience.
2. **Groq free-tier TPM (8,000)**: sustains roughly one ~2.5K-token turn every ~20–25 s. Fine for evaluation and early pilots; insufficient for concurrent calls. Request a tier raise before production traffic.
3. **Groq Qwen is a preview model** and is also the model that narrated an unauthorized concession once (now guarded, but its commercial-instruction adherence is visibly weaker than GPT-OSS's).
4. **Native-speaker review** of Telugu/Tenglish synthetic replies is still outstanding (small sample, one turn per case).

## 15. Sprint 3 recommendation

**Conditionally ready.** HALO's cloud layer is reliable *for its constraints*: deterministic fallback works live, retry classification is correct, pacing avoids 429s, and every commercial/authority invariant held once the claim-phrase gap was closed. Before real calls: (a) resolve the OpenRouter credit blocker or consciously run Groq-only, (b) confirm a Groq rate-limit tier that covers expected call concurrency, (c) complete the native-speaker review, and (d) keep the 22-case paced evaluation as the pre-flight gate. Then proceed to Sprint 3: safe validated sentence streaming → real STT/TTS → real phone call.
