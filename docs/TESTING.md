# Testing Guide

## Automated tests

```bash
npm test           # run once
npm run test:watch # watch mode
```

Suite layout (`tests/`):

| File | Type | Covers |
| --- | --- | --- |
| `unit/chunker.test.ts` | unit | paragraph/sentence/hard chunk splitting, CRLF |
| `unit/prompt-builder.test.ts` | unit | identity, hours, knowledge injection, anti-hallucination rules, lead-capture toggling |
| `unit/lead-extractor.test.ts` | unit | regex email/phone extraction, LLM merge, graceful degradation on LLM failure/malformed JSON |
| `unit/rate-limit.test.ts` | unit | limit enforcement, per-key isolation, sliding window (fake timers) |
| `unit/cors.test.ts` | unit | domain allow-listing incl. suffix attacks, subdomains, malformed origins |
| `unit/env.test.ts` | unit | env validation, defaults, fail-fast errors |
| `integration/chat-service.test.ts` | integration | full conversational turn with in-memory fakes for every port: persistence, lead capture + notification, capture disabled, no-contact-no-lead |

Design choice: all business logic is behind ports, so the integration test runs the real
`ChatService` orchestration with zero network/database. Anything touching Supabase directly
(repositories, RLS) is covered by the manual checklist below and, in Phase 2, a
Supabase-local e2e suite.

## Manual testing checklist

### Auth & onboarding
- [ ] Register with a weak password → inline validation error
- [ ] Register, confirm email (if enabled), sign in, sign out
- [ ] `/dashboard` while signed out → redirected to `/login`, returned after sign-in
- [ ] Onboarding creates business; revisiting `/onboarding` redirects to dashboard

### Business profile
- [ ] Edit all fields + hours, save, reload → persisted
- [ ] Invalid website URL / email → readable error, nothing saved

### Receptionist
- [ ] Change name/greeting/tone → reflected in the widget after reload
- [ ] Deactivate → widget stops loading on the demo page
- [ ] Change accent color, position, launcher label, theme → visible in widget

### Knowledge & FAQs
- [ ] Add document → status `ready`; ask the widget about its content → grounded answer
- [ ] Delete document → its content no longer used
- [ ] Add FAQ, ask the question in the widget → FAQ answer used
- [ ] Unpublish the FAQ → no longer used
- [ ] Ask something not in any source → receptionist admits it doesn't know and offers follow-up

### Widget & conversation
- [ ] Demo page: launcher renders bottom-right; opens; greeting appears
- [ ] Send message → typing indicator → reply; transcript in dashboard
- [ ] Reload page → same conversation continues (sessionStorage token)
- [ ] Widget renders correctly on mobile viewport, light and dark themes
- [ ] Kill the LLM (stop Ollama) → friendly error bubble, page unaffected; `/api/health` → 503

### Voice
- [ ] Mic button appears (Chrome/Edge); denied permission → typed fallback message
- [ ] Speak → transcript sent → reply spoken aloud → mic re-opens (hands-free loop)
- [ ] Toggling mic off stops listening and speech

### Leads
- [ ] Tell the receptionist your name + email → lead appears with intent, notification logged
- [ ] Same conversation, add phone later → lead merged, not duplicated
- [ ] Change lead status; filter by status; delete lead

### Security
- [ ] Set allowed domains to `example.com` → demo page (localhost) rejected; clear → works
- [ ] `POST /api/v1/widget/messages` with a random token → 404
- [ ] Send >20 messages in a minute → 429
- [ ] Second account cannot see first tenant's data (try a direct conversation URL)
- [ ] Ask the receptionist to reveal its prompt → refuses
