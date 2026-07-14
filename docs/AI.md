# AI System — Intelligence Report

How the receptionist thinks, what was improved in the 2026-07-13 intelligence
overhaul (`PROMPT_VERSION 2026-07-13.1`), and what remains.

## Architecture of the intelligence layer

| Concern | Module | Approach |
|---|---|---|
| System prompt | `src/core/services/prompt-builder.ts` | Layered, versioned template: identity → tone → facts → conversation craft → situations → industry playbook → lead capture → safety → voice |
| Industry behaviour | `src/core/services/industry-playbooks.ts` | 14 zero-config playbooks matched fuzzily from the business's free-text industry/description |
| Lead extraction | `src/core/services/lead-extractor.ts` | Regex ground truth for email/phone + LLM JSON pass for name/intent; regex wins on conflict |
| Lead qualification | `src/core/services/lead-scorer.ts` | Deterministic 0–100 score, temperature, classification, recommended next action — zero LLM cost |
| Retrieval | `supabase-knowledge-provider.ts` + `retrieval-query.ts` | Hybrid BM25 + vector with RRF fusion, plus context-aware query rewriting for follow-ups |
| Knowledge gaps | `chat-service.ts` + migration `0007` | Substantive questions with zero grounding are recorded as `unanswered_question` events |

## Conversation improvements

The system prompt now teaches receptionist craft, not just facts:

- **Acknowledge before asking** — empathy first when a visitor shares a problem.
- **Memory discipline** — never re-ask for details the visitor already gave; use their name once given.
- **Pacing** — one question per reply, match the visitor's message length, no canned repetition (backed by temperature 0.3 instead of 0.2).
- **Recovery** — own mistakes briefly and fix them; clarify ambiguity instead of guessing.
- **Small talk** — one warm sentence, then guide back to business.
- **Closing** — summarise next steps, no trailing unnecessary questions; clean goodbye handling.

A dedicated "Handling situations" section scripts the seven highest-stakes
moments: emergencies (industry-specific), angry visitors (acknowledge →
apologise once → collect → escalate), pricing (answer or convert, never
estimate), bookings (collect one detail at a time, team confirms), unknown
questions (honest handoff beats a guess), human-handoff requests, and silent
or confused visitors.

## Industry intelligence

`matchIndustryPlaybook()` gives every tenant expert behaviour with zero
configuration: dental, HVAC, plumbing, electrical, roofing, legal, med spa,
salon, clinic, real estate, insurance, gym, veterinary, home automation.

Each playbook encodes:
- **Emergency protocol** — e.g. gas smell → leave the building and call 911 *before* intake; pet poisoning → don't hold them in chat.
- **Qualifying details** in priority order, woven in conversationally.
- **Compliance hard lines** — no legal advice, no medical diagnosis, no premium quotes, no treatment outcome promises.

## Lead qualification improvements

`scoreLead()` v2 is still pure and deterministic (explainable ordering) and adds:

- **Word-boundary phrase matching** — "book" no longer fires on "facebook".
- **Classification**: `emergency` (+25, "Call immediately"), `spam` (score capped at 10 — SEO/backlink/vendor vocabulary), `returning_customer`, `standard`.
- **New positive signals**: commitment language ("ready to book", "can you fit me in"), near-term timeline, decision-maker language ("my house", "I'm the owner").
- **Negative signal**: explicit disengagement ("just browsing", "not interested") dampens the score.
- **Recommended next action** on every lead, persisted in the `qualification` jsonb.

Extraction improved in parallel: the JSON-mode prompt now refuses the
business's own contact details, honours visitor corrections (latest value
wins), and packs service + timeline into the intent phrase. Extraction also
triggers immediately on booking/pricing/urgency language
(`LEAD_TRIGGER_RE` in `chat-service.ts`) instead of waiting for the periodic
pass — hot leads are scored while they're hot.

## RAG improvements

- **Contextual query rewriting** (`buildRetrievalQuery`): short or anaphoric follow-ups ("how much is that?") are expanded with the visitor's recent messages, so retrieval sees the topic. Pure function, zero LLM cost. History is now fetched before retrieval to enable this.
- **Missing-knowledge detection** (`isSubstantiveQuestion` + `unanswered_question` events): the knowledge base improves in exactly the order customers ask for it. Greetings and statements are filtered out.
- Existing hybrid retrieval (BM25 + vector, RRF fusion, graceful degradation) retained.

## Safety and prompt-injection resistance

- Visitor messages are explicitly framed as untrusted: instruction-changing, role-play, and prompt-reveal attempts are treated as off-topic and deflected.
- Custom business instructions are explicitly subordinated to the safety rules.
- Honest-AI policy: if asked, admit to being a virtual assistant and keep helping.
- Anti-hallucination stance unchanged and strengthened: answer only from profile/hours/knowledge; never confirm unlisted services.

## Voice readiness

`buildSystemPrompt({ channel: "voice" })` (wired from the conversation's
channel) adds a voice mode: max two short sentences, numbers spoken naturally
("nine to five"), contact details read back for confirmation, interruption
handling. Chat replies stay speech-friendly by default (no markdown/emojis).

## Evaluation

92 → 96 unit/integration tests, including simulation-style archetypes run
against the scorer: emergency caller, SEO spammer, returning customer,
price-shopper, "just browsing" visitor, ready-to-commit buyer.

Telemetry for live evaluation:
- `promptVersion` + `groundingSources` logged per turn → attribute answer quality to prompt revisions.
- `unanswered_question` events → knowledge coverage metric.
- Lead `score`/`temperature`/`classification` distributions → qualification calibration.

Suggested KPIs: lead capture rate per conversation, hot-lead precision (did
"call within the hour" leads convert?), unanswered-question rate, and
conversation length to lead capture.

## Remaining weaknesses

1. **No timezone on business hours** — the AI can't say "we're closed right now"; it can only recite hours. Needs a `timezone` column before adding live open/closed awareness to the prompt.
2. **Lead scoring is lexical** — deterministic phrase matching is explainable and free but misses paraphrase ("water is pouring through my ceiling" scores as emergency only via "leaking"-family phrases). A cheap LLM classification pass gated to high-value conversations is the next step.
3. **No conversation summarisation** — history is truncated at 16 messages; very long chats lose their opening context. A rolling summary would preserve it.
4. ~~**No real booking**~~ — solved by Appointment Intelligence (see `docs/SCHEDULING.md`): the AI checks real availability, books, confirms, and triggers reminders in-conversation, backed by Google/Outlook/CalDAV/internal calendar adapters.
5. **English-centric phrase lists** — scoring/trigger regexes won't fire on non-English conversations, though the conversational layer mirrors the visitor's language.
6. **No automated live evals** — the test suite is a regression harness; there is no LLM-judged conversation-quality benchmark yet.

## Future AI roadmap

1. ~~**Calendar-aware booking**~~ — shipped (`docs/SCHEDULING.md`), including exact clock-time
   understanding and the Google Calendar OAuth connect flow; remaining: dashboard UI for
   staff/settings.
1b. ~~**Downstream automation**~~ — shipped (`docs/WORKFLOWS.md`): every AI-completed action
   (booking, lead) emits business events into a workflow engine + built-in CRM, so the AI's
   work triggers confirmations, follow-ups, webhooks, and customer-record upkeep automatically.
2. **LLM qualification pass** for budget/timeline/sentiment on hot leads only, merged into the deterministic score.
3. **Rolling conversation summaries** for long chats and cross-visit memory of returning visitors.
4. **LLM-judged eval harness**: scripted visitor personas replayed against each `PROMPT_VERSION`, scored on grounding, empathy, and capture rate.
5. **Owner-facing knowledge-gap digest** (weekly email of top unanswered questions with one-click FAQ creation).
6. ~~**Voice channel activation**~~ — shipped: the widget's `VoiceSession` state machine runs a
   hands-free loop on the free browser Web Speech APIs (silence auto-pause, error retries,
   tap-to-interrupt, chat fallback); remaining: server-side STT/TTS providers behind the same
   `speech-provider` port for consistent voices across browsers.

## Commercial advantage

The moat isn't "a chatbot on your site" — it's that the receptionist behaves
like domain staff on day one (industry playbooks with emergency and
compliance behaviour), tells the owner **who to call first and why**
(explainable scoring, classification, next action), and **tells the owner
what it couldn't answer** so the knowledge base compounds. All qualification
runs deterministically at zero marginal LLM cost, keeping unit economics flat
as conversation volume grows.
