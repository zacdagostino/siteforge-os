# Protected Workers

These are separate, server-only processes. The capture worker claims website-capture jobs, validates public targets, respects applicable `robots.txt` rules, discovers crawlable internal pages, captures responsive screenshots, stores private artifacts, extracts source evidence, and runs automated accessibility checks. The audit worker reads only those saved private artifacts and produces editable, evidence-linked findings. The asset-analysis worker sends each captured public image and its saved page context to a vision model, then saves private, editable suggestions for human review. It also collects deterministic, reviewable brand-colour evidence from SVG logo fills/strokes, logo-image pixels, CSS variables, and repeated rendered interface controls. The builder worker runs Codex in a disposable workspace to create a private website preview from an approved Build Manifest.

## Runtime

Use Node.js 22 or later. The worker relies on the native WebSocket implementation required by the Supabase client.

## Capture scope

Each run discovers public, crawlable same-origin HTML pages breadth-first, beginning at the homepage.
It captures up to 100 pages by default, never submits forms, and does not attempt to access
authenticated content. Set `SITEFORGE_CAPTURE_MAX_PAGES` between `1` and `250` to change the
bounded page limit.

Pages are saved incrementally: each completed page publishes its page record, three responsive
screenshots, source artifacts, and direct observations before the worker continues. The workspace
shows the current capture phase and URL, then reveals that new private evidence immediately. A
workspace cancellation request is cooperative: the worker finishes its current safe step, avoids
starting another page or asset, and leaves any already saved evidence private and clearly partial.

## Required environment

Set these only in the worker runtime or Codespaces secret store. Do not put either value in `.env.local`, any `VITE_` variable, browser code, or a committed file.

```bash
SITEFORGE_SUPABASE_URL=https://your-project.supabase.co
SITEFORGE_SUPABASE_SERVICE_ROLE_KEY=your-server-only-key
OPENAI_API_KEY=your-server-only-openai-key
# Optional dedicated key for Codex build jobs. OPENAI_API_KEY is used when this is absent.
SITEFORGE_CODEX_API_KEY=your-server-only-openai-key
```

Optional runtime settings:

```bash
SITEFORGE_WORKER_ID=siteforge-capture-1
SITEFORGE_CAPTURE_POLL_MS=5000
SITEFORGE_ASSET_VISION_MODEL=gpt-5
SITEFORGE_CODEX_MODEL=gpt-5.6
SITEFORGE_CODEX_BIN=codex
```

## Run

For normal local use, run this once instead of starting a worker for every job. It starts the web
app plus the capture, audit, and asset-analysis workers together:

```bash
npm run start:local
```

Keep that terminal open while you work. Every eligible job you create in the app is then claimed
automatically. Press `Ctrl + C` once to stop the app and all workers together.

To run only the background workers without the web app:

```bash
npm run workers
```

Process one queued capture and exit:

```bash
npm run worker:capture -- --once
```

Run continuously:

```bash
npm run worker:capture
```

Process one queued audit after clicking **Generate audit** in the app:

```bash
npm run worker:audit -- --once
```

Run the audit worker continuously:

```bash
npm run worker:audit
```

Process one queued visual-asset analysis after clicking **Analyse assets** in the app:

```bash
npm run worker:assets -- --once
```

Run the visual-asset worker continuously:

```bash
npm run worker:assets
```

Process one queued private website build:

```bash
npm run worker:builder -- --once
```

Run the private website builder continuously:

```bash
npm run worker:builder
```

Asset descriptions are suggestions, not verified facts. The worker instructs the model to describe only what is visible and to treat page context as non-evidentiary. It does not approve an asset, publish anything, contact a business, or assert business ownership, credentials, relationships, projects, locations, or claims. Review and approve each asset in the **Assets** tab before its description can enter a redesign brief.

The audit worker does not crawl the public web or contact a business. It can only analyse a completed capture that was explicitly attached to its queued audit.

The builder worker reads only an approved Build Manifest, a private dossier for every selected captured page, and human-approved source assets. It copies a locked static website foundation into a temporary Git workspace, invokes `codex exec --json --sandbox workspace-write`, then runs a static build, responsive browser captures, and axe checks. Every selected source page has a required deterministic output path and a source-provenance marker; a missing or incorrect mapping fails the quality check. Codex may improve and condense captured copy, but must retain material services, operations, actions, forms/tools, legal content, and resources without strengthening claims. The worker persists a safe build timeline and uploads changed draft files while Codex works. Workspace members can open that short-lived working draft only after a generated homepage exists; it is explicitly unvalidated, blocks remote connections and form submissions, and disappears when the run ends. The worker saves finished source, output files, screenshots, event logs, and quality results privately. It never deploys the generated site, sends outreach, submits preview forms, or grants a prospect access. Production runners must be isolated containers with no deployment credentials and no outbound access except the Codex request path; the local worker is for trusted development only.

The worker needs an isolated runtime with outbound network controls, memory and CPU limits, a read-only filesystem, no production deployment credentials, and access only to the private `siteforge-artifacts` bucket. The URL checks in code are a defense-in-depth layer, not a replacement for network egress policy.
