# Deployment Guide

The app is a standard Next.js App Router project — it deploys anywhere Next.js runs. The
reference deployment is **Vercel + Supabase**.

## 1. Supabase (production project)

1. Create a dedicated production project (never share the dev project).
2. Run `supabase/migrations/0001_init.sql` in the SQL editor (or `supabase db push`).
3. Authentication:
   - Enable email confirmation.
   - Set **Site URL** to your production domain and add
     `https://yourdomain.com/auth/callback` to the redirect allow list.

## 2. AI provider

Ollama is a development default. In production use a hosted provider:

```
LLM_PROVIDER=groq                # or openai / anthropic / gemini / mistral
LLM_MODEL=llama-3.3-70b-versatile
LLM_API_KEY=...
```

(Ollama also works in production if you run it on infrastructure reachable from your deployment
via `OLLAMA_BASE_URL` — a GPU box behind a private network.)

## 3. Vercel

```bash
vercel link
vercel env add   # add every variable from .env.example, for Production
vercel --prod
```

Notes:

- `npm run build` bundles `public/widget.js` before `next build` — no extra step.
- The widget is served from your app origin: customers embed
  `https://yourdomain.com/widget.js`. Vercel's CDN caches static `public/` assets
  automatically.
- The in-memory rate limiter is per-instance. Under Fluid Compute this is acceptable at launch;
  swap in a Redis-backed `RateLimiter` (Upstash via Vercel Marketplace) when you scale out —
  the interface in `src/lib/rate-limit.ts` is already async for exactly this.

## 4. Post-deploy verification

1. `curl https://yourdomain.com/api/health` → `{"status":"ok"}`.
2. Register → onboard → configure receptionist → add an FAQ.
3. Open the install page, load the demo, exchange a message and a voice turn.
4. Confirm the conversation and (if you shared contact info) the lead in the dashboard.
5. Add your website's domain in settings and confirm an unlisted origin is rejected.

## Production checklist

- [ ] Dedicated Supabase production project; migration applied; email confirmation on
- [ ] All env vars set in the hosting platform (no `.env` files in the image)
- [ ] `SUPABASE_SERVICE_ROLE_KEY` present **only** as a server-side secret
- [ ] Hosted LLM provider configured with billing alerts
- [ ] `NEXT_PUBLIC_APP_URL` = production URL (drives embed snippets + auth emails)
- [ ] `/api/health` wired to uptime monitoring
- [ ] Log drain configured (structured JSON logs are aggregator-ready)
- [ ] Error tracking (Sentry or similar) added to `error.tsx` handlers
- [ ] Custom domain + HTTPS
- [ ] Backup policy confirmed on Supabase (PITR on paid tiers)
- [ ] Rate limiter upgraded to Redis if running multiple instances
