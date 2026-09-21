# Arunodhaya agent

**Date:** 2026-09-21 · **Phase:** 4 · **Status:** configuration complete and
MOCK-VERIFIED; **no verified business facts supplied**; no real call placed.

---

## 1. Where it lives, and why that matters

Everything for this business is in `src/content/tenants/arunodhaya/`.
Nothing in `packages/` knows it exists. There is no
`if (business === "arunodhaya")` anywhere in HALO, and `npm run check:neutral`
fails the build if the words "arunodhaya" or "solar" appear under `packages/`.

Adding the next tenant is a sibling directory. That is the whole point: the
platform learns nothing about solar, and this agent gets no special path
through the runtime.

```
src/content/tenants/arunodhaya/
  agent.ts          identity, prompt template, voice lines, claim phrases
  qualification.ts  what to collect, in what order, in Telugu
  objections.ts     cues, acknowledgements, evidence, follow-ups
  negotiation.ts    commercial and negotiation policy  → ARUNODHAYA_NEGOTIATION_POLICY.md
  escalation.ts     when a person takes over
  knowledge.ts      facts, with an explicit verified / pending status
  supplied.ts       the ⟨SUPPLIED⟩ discipline
  index.ts          loads and validates the whole bundle, or refuses it
```

`src/core/services/voice/arunodhaya-call.ts` is the **only** file that names
the business. It hands the validated bundle to a generic `SalesCallAssembly`.

---

## 2. What the agent cannot do

This is the most important section, and it is deliberately first.

Arunodhaya has supplied **no verified commercial or product facts**. The
configuration therefore makes the following impossible rather than merely
discouraged:

| The agent cannot | Because |
| --- | --- |
| state any price | `priceDisclosure: "none"` and `quotes: []` |
| offer any discount | every discount `value` is `null`, which the authorization engine treats as UNSET, not as the agent's discretion |
| mention financing | every option is `verified: false` |
| answer "how much subsidy?", "what's the payback?", "which brand?", "how long to install?" | each is a `supplied_pending` fact, rendered into the prompt as a question it must NOT answer from general knowledge |
| claim a booking, a transfer or a concession | the act-then-narrate validator, now guarded in Telugu (§4) |

A test asserts there is no rupee, percent or per-kW figure anywhere in the
commercial configuration or the prompt template. The failure mode this exists
to prevent is a model filling a silent gap with a plausible-looking number
about someone else's business — which a customer would then act on.

The resulting agent qualifies the lead, answers what it can verify, and routes
every commercial question to a person. **That is the correct output of this
configuration today, not a degraded one.**

---

## 3. Language

Telugu is the primary language and English the fallback; code switching is
allowed, because that is how people actually speak on the phone in Hyderabad.
Nothing is translated by the platform.

- **Deterministic spoken lines** — greeting (with the AI disclosure),
  reprompt, goodbye, turn failure, transfer announcement, transfer failure —
  are authored in Telugu in `agent.ts`. A phone agent missing any of them is
  not answered at all; silence is a better failure than a Telugu caller
  hearing an English machine line.
- **Qualification questions** are authored per field in Telugu and English.
- **Objection cues** cover Telugu script, transliterated Telugu and English,
  matched as normalized substrings — Indic scripts have no usable `\b`, and
  "chala expensive andi" is one sentence in three registers.
- **Phrase hints** for STT cover the vocabulary that matters (సోలార్,
  కిలోవాట్, సబ్సిడీ, ఇన్వర్టర్, net metering, and the business name).
- **`endOfSpeechMs` is 900 ms**, not the 700 ms default, because Telugu
  speakers pause mid-sentence more than the English default assumes. This is a
  hypothesis tuned on mock audio and must be re-tuned on real calls.

### The English-regex trap

The platform's act-then-narrate guard was English regex. Over a Telugu reply it
matched nothing — it did not fail, it silently stopped guarding, which is how
an agent could claim a booking that never happened. Phase 4 made the guard
configurable per language, and this agent supplies:

- `actionClaimPhrases` — "బుక్ చేశాను", "slot confirm chesanu", "కనెక్ట్ చేశాను",
  "discount ichanu" … per claim kind;
- `safeFallbackReply` — the honest line spoken when a reply cannot be
  validated, in Telugu;
- `humanRequestPhrases` — "మనిషితో మాట్లాడాలి", "manishi tho matladali" … so
  escalation does not depend on an English regex that would never fire.

`claimGuardCoverage()` reports which claim kinds a non-English agent has no
guard for, rather than assuming it is fine.

---

## 4. Qualification

`qualification.ts` is a **starting configuration, not a business
requirement.** The engine asks one field at a time, never re-asks a filled
one, bounds attempts, and treats "I don't know" as a real answer. The model's
only job is to phrase the pending question naturally — which is what keeps it
from sounding like a form.

| Field | Type | Notes |
| --- | --- | --- |
| `name` | name | |
| `location` | text | free text; never read back (§5) |
| `property_type` | enum | independent house / apartment / commercial / agricultural |
| `ownership` | enum | owner / tenant — captured, **not** used to disqualify |
| `roof_availability` | enum | skipped entirely for an apartment |
| `monthly_bill` | energy_or_money | **read back**; rupees-vs-units is disambiguated, never guessed |
| `desired_capacity` | capacity_kw | optional, one attempt — most callers do not know |
| `timeline` | enum | immediate / ≤3 months / later this year / just exploring |
| `phone` | phone | **read back** |
| `callback_preference` | time | optional |

**Nothing disqualifies a caller.** Whether Arunodhaya sells to tenants, or to
apartments, or below some bill threshold, is their decision and they have not
made it. A guessed disqualifier silently throws away real leads, so
`disqualifyWhen` is left unset and a test asserts that.

`interestLevel` from the brief is deliberately *not* a question. Asking
someone how interested they are produces a number nobody believes; it is
derived from the disposition instead.

---

## 5. Defects the golden corpus found

Writing the 50-conversation corpus (§6) exposed three real defects in the
qualification engine, all invisible to the tests that already existed:

1. **Field scrambling.** A caller who answered the *next* question during a
   read-back had it stored against the field being confirmed, and every answer
   after that landed one field out — a lead with name "naade" and location
   "4000 rupees". Nothing errored. A correction must now be *signalled*: an
   explicit "no", or a bare number for a field where a number can only be a
   correction. Otherwise the utterance is released to the next question and
   the captured value is kept, unconfirmed.
2. **Free text was read back on every answer**, because its parser scores
   below the confirmation threshold — both the mechanical interrogation this
   design is meant to avoid, and the trigger for (1). Confidence-gated
   read-back now applies only to structured values, where being wrong is
   harmful and being right is checkable.
3. **An answered-but-unconfirmed field counted as "unresolved"**, which drove
   good calls towards a human.

Also fixed: a human request is surfaced *above* a pending read-back rather
than buried under it, and the do-not-call lexicon carries transliteration
variants — a DNC missed because of a doubled consonant is a compliance
failure, not a nicety.

---

## 6. Evaluation

`tests/golden/arunodhaya/conversations.ts` — 50 conversations: 10 Telugu,
10 Tenglish, 5 each of objection, negotiation, qualification, appointment,
handoff and failure/recovery. They run through the real pipeline (real
qualification engine, real negotiation policy, real tool registry, real
validator) with a scripted model.

Scripting the model is the point. Several conversations script one that
**misbehaves** — inventing a subsidy figure, claiming a booking, offering an
unauthorized discount, leaking the system prompt, calling a tool that does not
exist — and assert the deterministic layer stops it. That is the class of
failure a real-model evaluation cannot reproduce on demand.

```bash
npm run eval:arunodhaya      # scorecard + measured context size
npx vitest run tests/integration/arunodhaya-golden.test.ts
```

Current: **50/50**.

**Not scored, and not claimed:** Telugu naturalness, speech quality, and
whether a real model phrases the pending question well. Those need a real
model and native reviewers.

---

## 7. Tools

Only tools bound to an executor are ever offered to the model, and the names
come from the closed built-in registry:

- `request_human_handoff` — records the escalation. Whether a *live* transfer
  follows is decided by tenant configuration, never by the model. With no
  handoff number configured it returns no permitted claim and instructs the
  agent to promise a callback rather than a connection.
- `offer_concession` — re-checks the policy at execution time and returns
  `claimsPermitted: []` on refusal.
- `save_contact_details` — defined but **not bound** on this path: phone
  qualification captures contacts deterministically, so the model has no
  reason to propose it.

There is no booking tool bound yet. A model that claims a booking anyway is
caught by the validator, which `ap-01` and `ap-02` assert in Telugu and in
transliterated Telugu.

---

## 8. Escalation

`escalation.ts`. A live transfer happens only on an explicit request, and only
when the tenant configured a number; everything else is recorded for a
callback, because a failed live transfer is a worse experience than an honest
"we will call you". The agent can never say a caller is connected unless the
provider confirmed the bridge.

Configured triggers: complaints about existing work, commercial questions the
policy does not authorize, technical questions with no verified answer, an
objection raised past its budget, distress or an accusation of being misled,
and anything involving refunds, legal threats or government complaints.

---

## 9. Before this agent takes a real call

1. Arunodhaya supplies verified answers for the facts in `knowledge.ts`, each
   with a named source and a date.
2. The commercial policy is filled in and reviewed — see
   `docs/ARUNODHAYA_NEGOTIATION_POLICY.md`.
3. An STT and TTS vendor is chosen and scored on Telugu by native speakers
   over a real Indian phone line.
4. A DID is provisioned and bound to this agent and a **published** version.
5. `docs/PHASE4_REPORT.md` §15 is executed and its numbers recorded.
6. Recording authorization and DLT/DNC obligations are reviewed — both are
   **out of scope** of this phase and neither is implemented.
