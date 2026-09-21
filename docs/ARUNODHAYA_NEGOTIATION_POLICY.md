# Arunodhaya negotiation policy

**Date:** 2026-09-21 · **Phase:** 4 · **Status:** mechanism IMPLEMENTED and
MOCK-VERIFIED; **every commercial value is unset** because none has been
supplied. The agent can currently authorize nothing that involves money.

---

## 1. The separation this exists to enforce

> **CONVERSATIONAL STRATEGY** — how to talk to a customer who pushes back:
> acknowledge, understand, explain value, ask a useful question.
> **The model does this.**
>
> **BUSINESS AUTHORIZATION** — what may actually be offered, at what number,
> under what conditions, and what may never be promised.
> **Only `packages/negotiation/authorization.ts` does this.**

The model may negotiate. It may not authorize. It proposes a concession *by
id*; application code checks it against the policy and either performs it or
refuses; only a verified result may be narrated.

Nothing about this required fine-tuning a model to bargain, and that would
have been the wrong tool: a model tuned to concede concedes when it should
not, and there is no way to audit what it agreed to afterwards.

---

## 2. Nothing has a default value

A concession whose `value` is `null`, a quote whose `amount` is `null` and a
financing option with `verified: false` are all **UNAVAILABLE**. Not "small",
not "at the agent's discretion" — unavailable.

This is the single most important design decision in the file. A policy that
"helpfully" defaulted to 5% would be a fabricated commercial commitment made
by a piece of software about a real business. Until Arunodhaya supplies
verified numbers, the honest behaviour is to explain, ask, and escalate.

A malformed policy is **refused outright** rather than partially applied: half
a commercial policy is worse than none, because the half that usually fails to
load is the constraints.

---

## 3. Current state — Arunodhaya

| Setting | Value | Consequence |
| --- | --- | --- |
| `priceDisclosure` | `none` | no price, range, subsidy, payback or saving may be stated |
| `quotes` | `[]` | there is no figure to disclose even if the mode changed |
| `free_site_survey` | authorized | the one thing the agent may offer; it carries no figure, because it is a statement about process, not money ⟨SUPPLIED: remove if surveys are charged⟩ |
| `standard_discount` | `value: null`, `requiresApproval: true` | unavailable ⟨SUPPLIED⟩ |
| `manager_approved_discount` | `value: null`, `requiresApproval: true` | unavailable ⟨SUPPLIED⟩ |
| `floors.minAmount` | `null` | ⟨SUPPLIED⟩ — safe only because no discount is authorized |
| `floors.maxDiscountPercent` | `null` | ⟨SUPPLIED⟩ — must be set before authorizing any |
| `financing.emi` | `verified: false` | never mentioned ⟨SUPPLIED⟩ |
| `escalation.requestsBeforeHuman` | `2` | two pushes with nothing to offer → offer a person |
| `escalation.escalateOnUnlistedRequest` | `true` | a request for something not listed goes to a person |
| `escalation.humanApprovalAbovePercent` | `null` | ⟨SUPPLIED⟩ — meaningless until a discount exists |

### Prohibited promises

Rendered verbatim into the prompt every turn. They are the specific promises a
solar sales conversation drifts towards, and each is a claim about money or
government policy this agent has no authority to make:

- ఎంత సబ్సిడీ వస్తుందో ఖచ్చితంగా చెప్పకండి — అది ప్రభుత్వ నిర్ణయం.
- ఎన్ని సంవత్సరాల్లో డబ్బు తిరిగి వస్తుందో హామీ ఇవ్వకండి.
- నెలకి ఎంత ఆదా అవుతుందో లెక్క చెప్పకండి.
- ఏ ధరా, ఏ తగ్గింపూ మీరే నిర్ణయించి చెప్పకండి.
- ఇన్‌స్టలేషన్ ఎప్పటికి పూర్తవుతుందో తేదీ ఇవ్వకండి.
- ఈ ఆఫర్ ఈరోజే అయిపోతుంది అని చెప్పకండి.
- Never state a price, discount, subsidy amount, payback period or monthly saving.
- Never say an offer expires today or that the customer must decide now.
- Never agree to a customer's number because they insisted.

---

## 4. The flow

The brief's sequence, and where each step actually happens:

| Step | Owner |
| --- | --- |
| customer objection | `matchObjections` — tenant cue phrases, deterministic |
| → understand | the objection's identity, how often it has been raised, and what it means (`endsQualification`) |
| → value explanation | the tenant's acknowledgement, then **only** the verified facts the objection cites. With nothing verified, the agent says so |
| → authorized option | `availableConcessions` — everything allowed right now, with the tenant's exact wording |
| → verify | `offer_concession` re-runs `authorizeConcession` at execution time |
| → narrate | the reply may claim it only because the tool returned `claimsPermitted: ["concession.offered"]`; the validator enforces that, in Telugu |

### Refusal reasons

Deliberately specific, because the agent is told which one applies and what it
may say instead. "No" with a reason is usable in a conversation; a bare "no"
makes the model improvise.

| Reason | What the agent is told |
| --- | --- |
| `unknown` | not something the business has authorized; offer to have someone confirm what is possible |
| `no_authorized_value` | the business has not set a figure for this yet |
| `condition_unmet` | it depends on a field qualification has not established |
| `already_offered` | it has already been offered on this call |
| `needs_human_approval` | a member of the team has to approve it |

A refusal returns `claimsPermitted: []`, so a reply that claims the concession
anyway is rejected and regenerated. **A model that ignores the prompt still
cannot commit the business.**

---

## 5. Objections

`src/content/tenants/arunodhaya/objections.ts`, covering the brief's list:

| id | Raised as | Ends qualification |
| --- | --- | --- |
| `too_expensive` | "చాలా ఖరీదు", "chala expensive", "price is high" | no |
| `need_to_discuss` | "ఆయనతో మాట్లాడాలి", "husband tho matladali" | no |
| `just_checking` | "ఊరికే అడుగుతున్నా", "just checking" | no |
| `already_have_quote` | "వేరే కంపెనీ", "already have a quote" | no |
| `no_budget` | "బడ్జెట్ లేదు", "can't afford" | no |
| `distrust` | "నమ్మకం లేదు", "solar companies ni nammakam ledu" | no |
| `call_later` | "తరువాత చేయండి", "busy right now" | **yes** |

Each carries an acknowledgement, the verified facts that may answer it, one
follow-up question, and a repeat budget. Past that budget the agent is told to
**stop re-explaining** and offer a person: repetition means the answer is not
landing, and a third attempt is pressure, not persuasion.

The prompt closes every turn with: *never pressure, never imply an offer
expires unless the policy says so, and never agree to something because the
customer insists. An unauthorized "yes" is worse than an honest "let me
check."*

---

## 6. Turning it on

1. Arunodhaya supplies each figure, with the name of who approved it and the
   date. Those go in `source`.
2. Set `floors.maxDiscountPercent` and `floors.minAmount` **before** setting
   any concession value. The loader refuses a policy whose concession exceeds
   its own floor.
3. Replace each `⟨SUPPLIED⟩` script with the words the business wants said, in
   Telugu and English.
4. Change `priceDisclosure` only when at least one quote has a verified
   amount — the loader refuses it otherwise.
5. Publish a **new agent version** and run the golden corpus plus new
   negotiation conversations against it.

**Never edit these numbers on a live version.** A price change is a versioned
configuration change with an evaluation attached — see
`docs/ARUNODHAYA_LEARNING_LOOP.md`. Editing in place is exactly the failure
this structure exists to prevent: nobody can say afterwards what the agent was
authorized to offer on the day of a given call.
