# Hosted Supabase environment

`.env.hosted.local` is a gitignored overlay for project `AI_Receptionist`
(`riwgdqogswoewfduajcl`, Sydney). It does not replace `.env.local`. Fill its
anon and service-role key fields from this project's Supabase Dashboard. Keep
the service-role key private; it bypasses RLS. The client-side auth flow uses
the anon key and the server-side repositories use the service-role key.

The Next.js app reads `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY` in `packages/tenancy/supabase/{client,server}.ts`
and `src/proxy.ts`. Server-side stores use those same values plus
`SUPABASE_SERVICE_ROLE_KEY` through `packages/tenancy/supabase/admin.ts`.
The voice gateway uses the same platform environment. The Pipecat worker does
not create a Supabase client; it connects to the voice gateway using
`HALO_CONTROL_URL`.

To start the app with the hosted overlay, use:

```sh
node --env-file=.env.hosted.local node_modules/next/dist/bin/next dev
```

Node's env-file values do not replace variables already exported in the shell.
For hosted runs, ensure Supabase variables are not exported from a local shell
profile. Do not start the normal `npm run dev` command for this configuration;
Next.js loads `.env.local` automatically.

The read-only REST endpoint check returned HTTP 401, which confirms DNS, TLS,
and network reachability. Auth and tenant-isolation checks have not been run
against the hosted project. They require two dedicated synthetic Supabase Auth
users in separate test tenants and their passwords, plus the project's anon
and service-role keys. Do not use production user accounts or real tenant
data. Existing mocked tenant/auth tests passing locally are not hosted evidence.
