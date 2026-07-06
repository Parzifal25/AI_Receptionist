# AI Receptionist

A multi-tenant SaaS platform where businesses create an AI receptionist and embed it into any
website with a single script tag. Visitors chat or **speak** naturally with the receptionist; it
answers from the business's own knowledge base, admits what it doesn't know, and captures leads.

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
- **Conversation history** — full transcripts with linked leads
- **Settings** — allowed embed domains, lead notifications
- **Analytics** — usage event stream + overview stats (charts arrive Phase 2)
- **Security** — Postgres Row Level Security per tenant, rate limiting, CORS allow-listing,
  Zod validation on every input, secrets never reach the browser

## Quickstart

```bash
git clone <repo> && cd ai-receptionist
npm install
cp .env.example .env.local          # fill in Supabase + LLM values
# apply supabase/migrations/0001_init.sql to your Supabase project
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
| [docs/TESTING.md](docs/TESTING.md) | Automated tests + manual testing checklist |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phase 2+, known limitations, technical debt |

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Next.js dev server |
| `npm run build` | Build widget + production app |
| `npm run build:widget` | Bundle only `public/widget.js` |
| `npm test` | Run the Vitest suite |
| `npm run lint` | ESLint |

## Tech stack

Next.js (App Router) · React · TypeScript · Tailwind CSS · Supabase (Postgres, Auth, Storage,
RLS) · Zod · Vitest · esbuild · Ollama (dev LLM, swappable)

## License

Proprietary — © AI Receptionist.
