# Arunodhaya learning loop

**Date:** 2026-09-21 · **Phase:** 4 · **Status:** DESIGNED. The evaluation
harness and the versioned-configuration mechanism exist; the review and
deployment steps are process, not code, and have not been exercised on real
calls.

---

## 1. The rule

**The production agent never modifies itself.**

No prompt rewrites itself from a transcript. No policy widens itself because a
call was lost. No fact is promoted from "the model said it" to "the business
says it". Nothing learned from a call reaches production without a person
having looked at it and a new agent version having been published and
evaluated.

This is not caution for its own sake. An agent that tunes itself towards
closing rates learns to promise things, and the promises are about someone
else's money. The loop below is slower on purpose, and every step that could
be automated but is not is marked.

---

## 2. The loop

```text
  calls
    │  recorded as structured facts, never free-form model output
    ▼
  transcripts + outcomes + events        ← calls, call_transcript_turns,
    │                                      conversation_outcomes, call_events
    ▼
  objection & failure analysis           ← aggregate, not per-call
    │
    ▼
  HUMAN REVIEW  ◀── the only place a business fact or a limit is created
    │
    ├──▶ knowledge update      (a ⟨SUPPLIED⟩ fact becomes verified, with a source)
    ├──▶ policy update         (a concession, a floor, a prohibition)
    ├──▶ qualification update  (a field, an order, a disqualifier)
    ├──▶ objection update      (a cue that was missed, an answer that failed)
    └──▶ prompt update         (behaviour only — never a fact)
    │
    ▼
  new agent_version (draft)              ← immutable once published
    │
    ▼
  EVALUATION: golden corpus + the calls that motivated the change
    │
    ▼
  publish → agents.live_version_id       ← the next call routes to it
    │
    ▼
  watch: dispositions, escalation rate, validator violations, knowledge gaps
```

---

## 3. What each stage actually reads

### Calls → evidence

Phase 3 already records everything this needs, tenant-scoped, with no
transcript text in logs:

| Table | Carries |
| --- | --- |
| `calls` | direction, state, hangup cause, duration, usage, agent version |
| `call_transcript_turns` | both sides verbatim, with `delivery` — so an interrupted reply is visibly partial |
| `conversation_outcomes` | disposition, reason, the qualification snapshot, escalation, DNC |
| `call_events` | per-stage latency, barge-ins, provider errors, no text |
| `conversation_state` | slots, qualification, negotiation request count, last objection |

The negotiation provider writes `negotiation_requests` and `last_objection`
into conversation state precisely so objection analysis is a query rather than
a re-reading of transcripts.

### Evidence → analysis

Questions the data answers without a model in the loop:

- Which objections are raised most, and which are raised **more than once in
  the same call**? (The second is the signal that an answer is not landing.)
- Which calls ended `not_qualified` with which fields unresolved?
- Which questions hit `knowledgeGap` — a substantive question that retrieved
  nothing?
- How often did a concession get refused, and for which reason?
- How often did the validator reject a reply, and for which claim kind?
- Where did callers hang up, relative to the pending question?

`knowledgeGap` and the validator's violation kinds are the two highest-value
signals, because both mean "the agent reached for something it did not have".

### Analysis → human review

The only step that creates a business fact or a limit. A reviewer decides:

- Is this a **missing fact**? → supply it in `knowledge.ts` with a source and
  a date, and flip `supplied_pending` → `verified`.
- Is this a **missing authorization**? → set a value in `negotiation.ts`, with
  the floor set first, and record who approved it.
- Is this a **missing cue**? → add the phrase to `objections.ts` or the
  language lexicon. Cheap, safe, and the most common real fix.
- Is this a **behaviour problem**? → change the prompt template. **Only
  behaviour.** A fact in a prompt is a fact nobody can audit or expire.
- Is this a **platform defect**? → it belongs in `packages/`, with a
  regression test, not in tenant configuration.

**Never automate this step.** The whole loop's integrity rests on a person
being accountable for each fact and each limit.

### Review → version → evaluation

Every change produces a new `agent_versions` row. Versions are immutable once
published (`published_at` is set once and never changed), so "what was this
agent authorized to offer on the day of that call?" is always answerable.

Before publishing:

```bash
npm run eval:arunodhaya          # 50 golden conversations, must stay 50/50
npm run phase4:context           # context size did not quietly grow
npx vitest run                   # the whole suite
npm run check:neutral            # nothing tenant-specific leaked into packages/
```

Plus: **add a golden conversation for the call that motivated the change.**
A fix without a conversation that would have caught it is a fix that will
regress. The corpus grows with the agent; that is the mechanism by which the
agent improves without learning anything at runtime.

### Publish → watch

After publishing, compare against the previous version:

| Metric | Source | A regression looks like |
| --- | --- | --- |
| disposition mix | `conversation_outcomes` | `qualified` down, `no_outcome` up |
| escalation rate | outcomes + `escalated` | up without a matching complaint rise |
| validator violations | runtime events | up at all — it means the model is reaching further |
| knowledge gaps | runtime events | up on a topic just "fixed" |
| unresolved fields | outcomes | a specific field spiking = the question is wrong |
| turn latency | `call_events` | p95 up after a prompt grew |

A version that regresses is rolled back by repointing
`agents.live_version_id`. Because versions are immutable, rollback is a
pointer change, not a restoration.

---

## 4. What is explicitly NOT in this loop

- **No online learning, no RLHF, no fine-tuning on call data.** A model tuned
  on this business's calls learns its habits, including the bad ones, and
  cannot be audited or rolled back the way a configuration change can.
- **No automatic prompt rewriting**, including "the model suggests an
  improvement". A suggestion is input to review, never an output of it.
- **No automatic fact extraction from transcripts.** A fact a customer was
  told is not evidence that the fact is true.
- **No automatic widening of the commercial policy.** Lost deals are not
  evidence that a discount was warranted.
- **No A/B test that varies what the agent may promise.** Varying phrasing is
  legitimate; varying authorization is an experiment on customers' money.

---

## 5. Current state

| Piece | Status |
| --- | --- |
| Structured call evidence (transcripts, outcomes, events, state) | IMPLEMENTED (Phase 3), MOCK-VERIFIED |
| Objection and negotiation signals in conversation state | IMPLEMENTED, MOCK-VERIFIED |
| Golden corpus as the evaluation gate | IMPLEMENTED — 50/50 |
| Context-size measurement | IMPLEMENTED |
| Immutable versioned configuration | IMPLEMENTED (Phase 1), VERIFIED |
| Analysis queries and a review surface | **NOT IMPLEMENTED** — today this is a SQL-and-a-spreadsheet exercise |
| Real call data to analyse | **BLOCKED** — no call has been placed |
| Native-speaker review of Telugu quality | **BLOCKED** — no vendor, no panel |

The loop is designed and its mechanical parts exist. It has never run, because
its input does not exist yet.
