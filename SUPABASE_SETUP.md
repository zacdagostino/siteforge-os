# Supabase Deployment

The configured application uses Supabase as its shared source of truth. Browser IndexedDB remains available only when `VITE_SITEFORGE_STORAGE=local` is explicitly set for offline development or automated UI tests.

## First deployment

1. Install or invoke the Supabase CLI, then authenticate it locally:

   ```bash
   npx supabase@latest login
   npx supabase@latest init
   npx supabase@latest link --project-ref gaoolaezwavpgsshyoim
   ```

2. Review the initial schema in `supabase/migrations/20260716000000_initial_siteforge_schema.sql`.

3. Apply it to the linked project:

   ```bash
   npx supabase@latest db push
   ```

4. Open the SiteForge app and sign in with the user created in Supabase Authentication. On first sign-in, name your organization. That call creates the owner membership used by Row Level Security policies.

## Current cloud workflow

- Email/password authentication gates cloud data access.
- Each signed-in user works inside an organization protected by Row Level Security.
- Creating a prospect uses a database transaction to create the business, website, initial audit, redesign/report placeholders, review tasks, and activity record together.
- Approving a business for outreach is enforced in the database and remains unavailable until both its audit and redesign concept are ready.
- Starting research creates one organization-scoped, homepage-only capture request. The browser only queues and reads the request; a separate server-side worker must claim it, crawl the public site, upload artifacts to the private bucket, and mark the run complete or failed.

## Capture worker

The worker lives in `worker/capture-worker.mjs`. It is intentionally separate from the Vite app and can use a Supabase service-role key only in its own server-side runtime.

1. Add `SITEFORGE_SUPABASE_URL` and `SITEFORGE_SUPABASE_SERVICE_ROLE_KEY` to your Codespaces or deployment secret store. Do not send the key in chat or place it in `.env.local`.
2. Run one queued job while setting up:

   ```bash
   npm run worker:capture -- --once
   ```

3. Run `npm run worker:capture` continuously only in an isolated worker environment with outbound network restrictions, CPU/memory/time limits, and no production deployment credentials.

The worker captures only the requested homepage, validates URLs and redirects, respects homepage `robots.txt` rules, stores HTML/screenshots/check output in the private bucket, and records extracted page text as unverified evidence.

## Security boundaries

- `.env.local` contains only browser-safe Vite variables and is ignored by Git.
- Do not put database passwords, Supabase secret keys, or service-role keys in any `VITE_` variable.
- The `siteforge-artifacts` bucket is private. A future crawler/worker uploads assets using a server-only secret key; the app reads them through authenticated access or short-lived signed URLs.
- Never give the browser the worker secret, a service-role key, arbitrary crawl URLs, or production publishing credentials. The worker should accept only queued SiteForge capture IDs and must enforce URL, network, size, timeout, and redirect limits before fetching a page.
- All application records are organisation scoped. Row Level Security denies access until a user has an organisation membership.
