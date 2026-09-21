# HALO Voice — Token and Context Budget (Phase 3)

On a call the caller is waiting **in silence**. Prompt size is the part of
time-to-first-token we directly control, and it is paid on *every turn* of every
call. So context size is a latency feature first and a cost feature second.

This document describes the budget the phone channel actually uses. It is a
re-budgeting of the **existing** Phase 2 layered context builder
(`packages/runtime/context-builder.ts`), not a second code path.

## 1. The layers

The builder already assembles context in bounded layers. Voice keeps all of
them and re-sizes each one:

| Layer | What it carries | Bounded by |
| --- | --- | --- |
| **Static** | agent identity, objective, policies, channel formatting + spoken-delivery rules, safety rules | the prompt template and `ChannelProfile`; composed once per turn, never accumulated |
| **Structured** | conversation state, escalation status, customer facts, verified actions | `maxCustomerFacts` |
| **Recent** | the recent turn window (user/assistant only; tool rows excluded) | `maxRecentMessages`, `maxMessageChars` |
| **Memory** | rolling summary of everything older | `maxSummaryChars` |
| **Retrieved** | knowledge snippets for *this* question | `maxKnowledgeSnippets`, `maxKnowledgeChars` |
| **Tools** | descriptors from the closed registry | `maxToolDescriptors` |

A final `maxTotalChars` ceiling trims in a fixed order — knowledge first, then
the summary, then the oldest messages (never below two) — so overflow degrades
predictably instead of truncating whatever happens to be last.

## 2. The voice budget

`VOICE_CONTEXT_LIMITS`, defined beside `DEFAULT_CONTEXT_LIMITS`:

| Limit | Chat default | **Voice** | Why |
| --- | --- | --- | --- |
| `maxRecentMessages` | 16 | **10** | spoken turns are short; the summary carries the rest |
| `maxHistoryFetch` | 40 | **24** | smaller fetch, less to trim |
| `maxMessageChars` | 2,000 | **600** | replies are capped at 450 spoken chars |
| `maxSummaryChars` | 1,200 | **800** | |
| `maxKnowledgeSnippets` | 6 | **3** | an agent can speak one or two facts per turn |
| `maxKnowledgeChars` | 7,200 | **2,400** | the single biggest win |
| `maxToolDescriptors` | 8 | **8 (unchanged)** | see below |
| `maxCustomerFacts` | 8 | **6** | |
| `maxTotalChars` | 32,000 | **9,000** | hard ceiling for a spoken turn |

### Why tool descriptors are NOT trimmed

Trimming knowledge costs *detail* — the agent knows slightly less. Dropping a
tool descriptor removes a *capability* the tenant configured, silently, and the
model cannot ask for a tool it was never shown. The registry is closed and small
(two built-ins plus tenant tools), so the saving would be marginal and the
failure mode is bad. This exemption is pinned by a test.

## 3. Measured effect

Built on a realistic mid-call context (30 prior turns, 8 retrieved snippets of
900 chars each), comparing the two limit sets through the same builder:

| | Chat budget | Voice budget |
| --- | --- | --- |
| Total chars | 9,335 | **4,877** |
| Recent messages | 16 | 10 |
| Knowledge snippets | 6 | 3 |

**A 47.8% reduction** on identical input — roughly 2,300 → 1,200 tokens at ~4
chars/token. Note the chat budget did not reach its own 32,000 ceiling on this
fixture; with richer knowledge the gap widens. The comparison is regression-
tested (`tests/unit/runtime/context-builder.test.ts`), so the budget cannot
silently drift back.

## 4. What voice deliberately avoids

- **Full transcript replay.** Only the recent window plus a rolling summary.
- **Re-sending static instructions per turn.** The prompt is composed from the
  agent version each turn; there is no accumulating instruction block.
- **Irrelevant tools.** The registry is closed; the model can only select from
  what it is shown, and it can never name an arbitrary tool.
- **Duplicate knowledge.** Retrieval is per-question, capped by count *and*
  characters, and skipped entirely when the turn is not a substantive question
  (`isSubstantiveQuestion`).
- **Unbounded memory.** The summary has a hard character cap.
- **Raw client metadata** in the prompt.

## 5. Not yet done (honest status)

- **Prompt caching is not used.** The static layer is stable within a call and
  is a natural cache prefix; no provider-side caching is wired. NOT IMPLEMENTED.
- **No token-level accounting of the prompt.** The budget is enforced in
  characters, and token usage is recorded only as reported by the provider
  (never estimated). The char-to-token ratio above is an approximation and is
  labelled as one.
- **Per-tenant budget overrides** are possible through `RuntimePolicy` but no UI
  or configuration surface exposes them.
- The limits are **reasoned defaults, not empirically tuned** against call
  quality. Tuning them needs real calls, which needs provider credentials
  (see `docs/PHASE3_REPORT.md`, blockers).
