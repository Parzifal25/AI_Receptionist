# AI Receptionist

A multi-tenant SaaS platform where businesses create an AI receptionist and embed it into any
website with a single script tag. Visitors chat or **speak** naturally with the receptionist; it
answers from the business's own knowledge base, admits what it doesn't know, captures leads,
books real appointments against real calendars, and feeds a built-in CRM and workflow
automation platform — every booking and lead can trigger emails, SMS, webhooks (Slack, Zapier,
n8n, Make, …), follow-ups, and CRM updates.

```html
<script src="https://yourapp.com/widget.js" data-key="YOUR_WIDGET_KEY" async></script>
```

## Features (Phase 1)

- **Business dashboard** — auth, onboarding, business profile with opening hours
- **Receptionist configuration** — name, greeting, tone, language, custom instructions, on/off
- **Knowledge base** — paste documents; automatically chunked and indexed for retrieval
- **FAQ management** — publish/unpublish, categories; answered word-perfect
- **Embeddable widget** — 12 KB, shadow-DOM isolated, light/dark/auto themes, brandable, floats
  bottom-right or bottom-left
- **Chat + voice** — browser speech recognition & synthesis with a hands-free voice loop
- **AI conversation** — grounded, anti-hallucination prompting; provider-agnostic LLM layer
  (Ollama in dev; OpenAI / Anthropic / Gemini / Groq / Mistral by env change alone)
- **Lead capture** — conversational extraction (regex + LLM) and explicit capture endpoint
- **Appointment booking** — real availability, Google Calendar sync (OAuth connect from
  Settings), double-booking-proof, reminders, exact-time understanding ("tomorrow at 10 AM")
- **Workflow automation** — business events trigger tenant-defined workflows: conditions,
  templated actions (email/SMS/WhatsApp/webhooks), retries, dead-letter queue, execution
  history, scheduled follow-ups, inbound webhook + manual triggers
- **Built-in CRM** — automatic customer records from every lead/booking, dedupe + merge,
  pipeline stages, activity timeline, revenue attribution
- **Customer lifecycle** — HTML/ICS/WhatsApp confirmations, self-service reschedule/cancel/
  check-in links, intake forms, day-of tracking (checked in → in progress → completed),
  automatic no-shows, thank-yous, satisfaction surveys, review/upsell/rebook journeys,
  lifecycle analytics
- **Conversation history** — full transcripts with linked leads
- **Settings** — allowed embed domains, lead notifications, and the customer-lifecycle
  editor (prep instructions, intake form builder, reminder schedules, review link)
- **Analytics** — usage event stream, overview stats, and a lifecycle dashboard (conversion,
  no-shows, reminder success, CLV, repeat rate, peak hours, AI success rate)
- **Security** — Postgres Row Level Security per tenant, rate limiting, CORS allow-listing,
  Zod validation on every input, secrets never reach the browser

## Quickstart

```bash
git clone <repo> && cd ai-receptionist
npm install
cp .env.example .env.local          # fill in Supabase + LLM values
# apply every file in supabase/migrations/ (0001 → 0009), in order
ollama pull llama3.1                # dev-default LLM
npm run dev
```

Full setup instructions: **[docs/INSTALLATION.md](docs/INSTALLATION.md)**

## Documentation

| Document | Contents |
| --- | --- |
| [docs/INSTALLATION.md](docs/INSTALLATION.md) | Local setup: Supabase, Ollama, env, migrations |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Clean architecture, provider system, data flow, diagram |
| [docs/API.md](docs/API.md) | Public widget API reference |
| [docs/COMPONENTS.md](docs/COMPONENTS.md) | Folder structure, features, UI components |
| [docs/SECURITY.md](docs/SECURITY.md) | Tenancy model, RLS, widget token design, rate limits |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production deployment (Vercel + Supabase) + checklist |
| [docs/SCHEDULING.md](docs/SCHEDULING.md) | Appointment intelligence: booking engine, calendars, reminders |
| [docs/WORKFLOWS.md](docs/WORKFLOWS.md) | Workflow automation platform + built-in CRM |
| [docs/LIFECYCLE.md](docs/LIFECYCLE.md) | Customer lifecycle: confirmations, self-service, day-of tracking, surveys, analytics |
| [docs/AI.md](docs/AI.md) | AI intelligence: prompting, retrieval, lead extraction |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Day-2 runbook: cron jobs, queues, monitoring |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptom-first diagnosis (calendar, voice, booking, workflows) |
| [docs/TESTING.md](docs/TESTING.md) | Automated tests + manual testing checklist |
| [docs/RUNTIME.md](docs/RUNTIME.md) | HALO Agent Runtime (Phase 2): pipeline, contracts, trust model, bounds |
| [docs/PERFORMANCE_BASELINE.md](docs/PERFORMANCE_BASELINE.md) | Runtime latency baseline and largest levers |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phase 2+, known limitations, technical debt |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | Release history |

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Next.js dev server |
| `npm run build` | Build widget + production app |
| `npm run build:widget` | Bundle only `public/widget.js` |
| `npm test` | Run the Vitest suite |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript, no emit |
| `npm run preflight` | Production configuration gate (DB probe; `preflight:ci` skips it) |
| `npm run check:migrations` | Apply migrations to a throwaway Postgres + schema-drift check |

## Tech stack

Next.js (App Router) · React · TypeScript · Tailwind CSS · Supabase (Postgres, Auth, Storage,
RLS) · Zod · Vitest · esbuild · Ollama (dev LLM, swappable)

## License

Proprietary — © AI Receptionist.
