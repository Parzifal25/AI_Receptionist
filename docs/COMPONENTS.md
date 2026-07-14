# Folder Structure & Component Documentation

## Repository layout

```
ai-receptionist/
├── docs/                        # all documentation
├── public/
│   └── widget.js                # built widget bundle (generated — do not edit)
├── scripts/
│   └── build-widget.mjs         # esbuild bundling for the widget
├── supabase/
│   └── migrations/0001_init.sql # full schema + RLS + functions + storage bucket
├── src/
│   ├── app/                     # Next.js App Router (presentation)
│   │   ├── (auth)/              #   login, register (+ shared card layout)
│   │   ├── api/
│   │   │   ├── health/          #   liveness + LLM probe
│   │   │   └── v1/widget/       #   public widget API: config, conversations,
│   │   │                        #   messages, leads
│   │   ├── auth/callback/       #   Supabase code exchange
│   │   ├── dashboard/           #   all dashboard pages (+ error boundary)
│   │   ├── onboarding/          #   first-business creation
│   │   ├── widget-demo/         #   customer-site simulation page
│   │   ├── error.tsx            #   root error boundary
│   │   └── not-found.tsx
│   ├── components/
│   │   ├── ui/                  # Button, Input/Textarea/Label/Select, Card family,
│   │   │                        # Badge, EmptyState, FormError/FormSuccess
│   │   └── error-boundary.tsx   # class-based boundary for client trees
│   ├── core/                    # framework-free application core
│   │   ├── domain/types.ts      #   entities (Business, Receptionist, Lead, …)
│   │   ├── errors/app-error.ts  #   typed error taxonomy → HTTP mapping
│   │   ├── ports/               #   LLM, Embedding, Knowledge, Speech, Storage,
│   │   │                        #   Notification provider interfaces
│   │   └── services/            #   chat-service, widget-repository,
│   │                            #   prompt-builder, lead-extractor, chunker
│   ├── features/                # feature modules (server actions + client forms)
│   │   ├── auth/  business/  receptionist/  knowledge/  faqs/
│   │   ├── leads/  settings/  install/  dashboard/
│   ├── lib/                     # infrastructure utilities
│   │   ├── api/                 #   respond.ts (envelope + error mapping), cors.ts
│   │   ├── supabase/            #   client.ts (browser), server.ts (RLS),
│   │   │                        #   admin.ts (service role, server-only)
│   │   ├── auth.ts              #   requireUser / requireBusiness
│   │   ├── env.ts               #   Zod-validated environment
│   │   ├── logger.ts            #   structured JSON logger
│   │   ├── rate-limit.ts        #   sliding-window limiter
│   │   └── cn.ts
│   ├── providers/               # port adapters
│   │   ├── llm/                 #   ollama, openai-compatible, anthropic, gemini + factory
│   │   ├── embedding/           #   ollama + factory (or disabled)
│   │   ├── knowledge/           #   supabase (FTS/pgvector) + factory
│   │   ├── speech/              #   browser Web Speech API (client-side)
│   │   ├── storage/             #   supabase storage
│   │   └── notification/        #   structured-log provider
│   └── proxy.ts                 # middleware: session refresh + route protection
├── tests/                       # vitest unit + integration suites
└── widget/src/                  # embeddable widget source (bundled by esbuild)
    ├── index.ts                 #   bootstrap from <script data-key>
    ├── api.ts                   #   fetch client for the widget API
    ├── widget.ts                #   shadow-DOM UI, chat + voice wiring
    ├── voice-session.ts         #   voice state machine (silence, retries, barge-in)
    └── styles.ts                #   isolated CSS with branding variables
```

## Feature modules

Each feature under `src/features/<name>/` owns:

- **`actions.ts`** — `"use server"` mutations: Zod-validate → `requireBusiness()` (auth +
  tenant) → RLS-scoped write → `revalidatePath`. They return `{ error, message }` consumed by
  `useActionState` forms.
- **form components** — client components rendering the feature's UI with the shared
  primitives.

| Feature | Server actions | UI |
| --- | --- | --- |
| `auth` | signIn, signUp, signOut | `AuthForm` (login/register modes) |
| `business` | createBusiness (onboarding RPC), updateBusinessProfile | `OnboardingForm`, `ProfileForm` (hours grid) |
| `receptionist` | updateReceptionist | `ReceptionistForm` (personality, capabilities, branding) |
| `knowledge` | createDocument, updateDocument, deleteDocument (chunk + index) | `DocumentEditor` (create/edit modes) |
| `faqs` | createFaq, updateFaq, toggleFaqPublished, deleteFaq | `FaqEditor` |
| `leads` | updateLeadStatus, deleteLead | table on `dashboard/leads` |
| `settings` | updateSettings (admin-gated) | `SettingsForm` |
| `install` | — | `CopySnippet` |
| `dashboard` | — | `DashboardNav` |

## Shared UI primitives (`src/components/ui`)

- **`Button`** — variants `primary | secondary | danger | ghost`, sizes `sm | md`
- **`Input` / `Textarea` / `Select` / `Label`** — consistent field styling, dark-mode aware
- **`Card` / `CardHeader` / `CardBody`** — standard content container
- **`Badge`** — tones `slate | green | blue | amber | red`
- **`EmptyState`** — first-run guidance blocks
- **`FormError` / `FormSuccess`** — action-state feedback with ARIA roles

## Widget

`widget/src` is bundled by esbuild (IIFE, es2019, minified, ~12 KB) to `public/widget.js`. It
imports the **same** `BrowserSpeechProvider` used by the app via the `@` alias — one speech
implementation, one port. The widget:

- reads `data-key` from its own script tag and derives the API origin from `script.src`
- fetches config, renders launcher + panel in a **closed shadow root**
- persists the visitor token in `sessionStorage` (conversation survives reloads)
- voice mode: `VoiceSession` state machine (`idle → listening → processing → speaking → listening`)
  drives the hands-free loop — silence detection with auto-pause, transient-error retries,
  tap-to-interrupt while speaking, and graceful fallback to chat when the mic is blocked,
  missing, or the browser lacks Web Speech support (fully unit-tested against a fake provider)
- fails silently if misconfigured — it can never break a customer's page
