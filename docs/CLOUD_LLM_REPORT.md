# HALO cloud LLM routing — 2026-09-24

## 1. Existing architecture discovered

HALO already had an `LLMProvider` port, an OpenAI-compatible adapter with SSE streaming, native tool calls and token usage, a runtime adapter, structured turn events, bounded context, a closed tool registry, act-then-narrate validation, and a safe provider-outage reply. The factory selected one provider/model. Phone turns already observe deltas without sending them to TTS.

## 2. Environment variables used

Names only: `LLM_PROVIDER`, `GROQ_LLM_API_KEY`, `OPENROUTER_LLM_API_KEY`, `LLM_TIMEOUT_MS`. Local `.env.local` is ignored and untracked. It selects `LLM_PROVIDER=cloud`; no key was copied into source or reports. The existing `LLM_MODEL` setting is unused in cloud mode.

## 3. Provider/model configuration

Fixed order: Groq `openai/gpt-oss-120b` → Groq `qwen/qwen3.8-27b` → OpenRouter `anthropic/claude-sonnet-4.6` → OpenRouter `qwen/qwen3.8-27b`. The two OpenRouter entries are a fallback **provider** tier. All four exact IDs were present in authenticated model lists on 2026-09-24. Each returned HTTP 200 on a short completion and a structured native tool call. Groq lists Qwen 3.8 27B as **preview**, not a production model. Official model pages: [Groq GPT-OSS](https://console.groq.com/docs/model/openai/gpt-oss-120b), [Groq Qwen](https://console.groq.com/docs/model/qwen/qwen3.8-27b), [OpenRouter Claude](https://openrouter.ai/anthropic/claude-sonnet-4.6), [OpenRouter Qwen](https://openrouter.ai/qwen/qwen3.8-27b).

## 4. Why each model was selected

The order is the requested deterministic policy. GPT-OSS is the primary cloud model; Groq Qwen is its same-provider fallback; Claude is the first independent-provider candidate; OpenRouter Qwen is its last candidate. No quality-based or random selection is implemented.

## 5. Real smoke-test results

The synthetic Arunodhaya phone-turn harness uses the existing sales-call assembly, tenant policy, closed tools and response validator. Focused English, Telugu, Tenglish, objection, discount, negotiation, handoff and unauthorized-concession turns produced safe replies through Groq. A rapid 19-case batch exceeded Groq's current account rate limits after the first five cases; subsequent full-prompt OpenRouter attempts returned HTTP **402**. Those turns used HALO's existing provider-outage reply. The complete 19-case **live** evaluation therefore did not pass. The existing 50-conversation controlled golden corpus remains green with mocked models.

## 6. Telugu/Tenglish results

Telugu and Tenglish produced intelligible Telugu replies. The mixed-script turn was understood. Several replies asserted that solar would reduce the bill without a verified Arunodhaya saving figure. They gave no numeric saving, but the qualitative savings claim still needs a native speaker and business review before production approval. English sometimes switched to Telugu for the qualification question because the tenant's primary language is Telugu.

## 7. Tool-calling results

All four live models returned a parseable `classify_intent` tool call in a read-only probe. A full GPT-OSS handoff turn requested `request_human_handoff`; HALO's tool runtime authorized it and the reply promised a callback. The model had no direct executor or commercial authority. The existing mocked negotiation corpus tests rejection of unauthorized concessions; the live unauthorized-concession turn declined the ₹20,000 request without executing a tool.

## 8. Fallback results

Mocked tests verify ordered fallback, unchanged tool descriptors, rejection of non-provider failures, and discarding failed partial streams. Live Groq 429s moved to Groq Qwen. Two forced Groq connection failures moved to OpenRouter Claude on a short live request, with `fallbackCount=2`. OpenRouter HTTP 402 is classified as `billing_limit` and does not trigger a model retry because it is an account limit. Final exhaustion uses HALO's safe reply.

## 9. TTFT and total latency

Measured on live synthetic turns; these are model-call times, not production phone-call latency:

| Case | Provider/model | TTFT | Model latency |
| --- | --- | ---: | ---: |
| English | Groq GPT-OSS | 828 ms | 884 ms |
| Telugu | Groq GPT-OSS | 829 ms | 916 ms |
| Tenglish | Groq Qwen, after 429 | 323 ms | 429 ms for successful attempt |
| Objection | Groq GPT-OSS | 778 ms | 877 ms |
| Unauthorized concession | Groq GPT-OSS | 616 ms | 713 ms |
| Forced Groq failure | OpenRouter Claude | not streamed | 2,241 ms including two mocked failures |

Stream chunks remain buffered at the router until one candidate completes. This protects validation and prevents a failed partial candidate from leaking into a later answer. The provider request still streams and the router records actual first-token timing; downstream delta delivery is delayed until the answer is complete.

## 10. Token usage

The same synthetic first-turn prompt was 9,834 characters and 2,944 **estimated** tokens; native tool schemas are additional input. Provider-reported usage:

| Case | Input | Output | Total |
| --- | ---: | ---: | ---: |
| English/Groq GPT-OSS | 2,544 | 133 | 2,677 |
| Telugu/Groq GPT-OSS | 2,550 | 150 | 2,700 |
| Tenglish/Groq Qwen | 3,044 | 38 | 3,082 |
| Objection/Groq GPT-OSS | 2,543 | 168 | 2,711 |

The existing Sprint 2 script still reports separate English, Telugu and Tenglish estimates. No estimator weights or prompt-duplication cleanup changed.

## 11. Files changed

`packages/platform/env.ts`, `packages/ports/llm-provider.ts`, `packages/providers/llm/{factory,openai-compatible-provider,fallback-router}.ts`, `packages/runtime/{llm-adapter,agent-runtime,contracts,events}.ts`, `tests/unit/llm-fallback-router.test.ts`, `scripts/cloud-llm-smoke.ts`, this report, and ignored local `.env.local` / `.env.example`. No database or tenant data changed.

## 12. Tests passed

Typecheck, lint, architecture, neutrality, preflight with database check skipped, Sprint 2 token report, and the complete suite: **105 files / 1,061 tests** (`npx vitest run --maxWorkers=2`). A final fourth-candidate regression test was then added and its file passed **6/6** in a focused run. The full suite needed local socket access for voice integration tests; two workers avoided unrelated 5-second booking-test timeouts seen under higher concurrency. Migration and RLS scripts were not run because they target or rebuild databases; no migration or RLS file was touched.

## 13. Remaining blockers

1. OpenRouter returns **HTTP 402** on a full ~2.5K-token Arunodhaya prompt while short probes work. The secondary provider cannot yet carry a normal turn on this account. Check its credit/spend limit before production use.
2. Groq returned **HTTP 429** after several rapid ~2.5K-token turns. Confirm account limits and expected concurrency; the current keys do not sustain the 19-case rapid batch.
3. Groq Qwen is a preview model and may change or disappear. There is no silent substitute.
4. Live qualitative savings claims and language switching need business and Telugu-speaker review. The 19-case live evaluation could not complete under present account limits.

## 14. Recommendation for Sprint 3

Restore full-prompt OpenRouter capacity, then rerun the 19-case live harness at a rate the Groq account supports. Review any unverified solar savings claims with Arunodhaya and a Telugu speaker. After that, measure safe validated sentence delivery through real STT/TTS and a real call. Keep commercial decisions in HALO's policy/tool runtime.
