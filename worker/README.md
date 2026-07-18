# Homepage Capture Worker

This worker is a separate, server-only process. It claims queued homepage-capture jobs, validates the public target, respects applicable `robots.txt` rules for the homepage, captures responsive screenshots, stores private artifacts, extracts limited source evidence, and runs an automated accessibility check.

## Required environment

Set these only in the worker runtime or Codespaces secret store. Do not put either value in `.env.local`, any `VITE_` variable, browser code, or a committed file.

```bash
SITEFORGE_SUPABASE_URL=https://your-project.supabase.co
SITEFORGE_SUPABASE_SERVICE_ROLE_KEY=your-server-only-key
```

Optional runtime settings:

```bash
SITEFORGE_WORKER_ID=siteforge-capture-1
SITEFORGE_CAPTURE_POLL_MS=5000
```

## Run

Process one queued capture and exit:

```bash
npm run worker:capture -- --once
```

Run continuously:

```bash
npm run worker:capture
```

The worker needs an isolated runtime with outbound network controls, memory and CPU limits, a read-only filesystem, no production deployment credentials, and access only to the private `siteforge-artifacts` bucket. The URL checks in code are a defense-in-depth layer, not a replacement for network egress policy.
