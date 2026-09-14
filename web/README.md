# career-ops web (alpha)

An **experimental, opt-in web UI** for career-ops. It is a local-first *view* over
the exact same files the CLI reads and writes (`data/pipeline.md`,
`data/applications.md`, `reports/`, `config/`): no parallel engine, no separate
database, no server. If you never run it, nothing about your CLI workflow changes.

> **Status: alpha.** Expect rough edges. Feedback →
> [Discussion #1142](https://github.com/career-ops-hq/career-ops/discussions/1142) ·
> roadmap context → [Discussion #156](https://github.com/career-ops-hq/career-ops/discussions/156).

## Quick start

Requires Node 22+ (see [Tests](#tests) — `npm test`'s glob discovery needs it).

```bash
cd web
npm ci
npm run dev
```

Open http://localhost:3000. The app reads the career-ops checkout it lives in
(the parent directory) — your existing CV, pipeline and reports appear as-is.

## What works today

- **Pipeline** — your tracker as a sortable, filterable table; status changes
  write back through the core's own scripts.
- **Explore** — the free reverse-ATS scan with an honest partial-dataset
  indicator, plus AI-assisted discovery (bring your own CLI/keys, including Grok Build CLI).
- **Apply** — assisted form prefill with a hard rule inherited from the core:
  **it never submits for you** — you always press the button.
- **Today / Analytics / CV / Config** — action queue, funnel, CV editing with
  preview, settings.

## Safety

- **Local-first:** the local web app runs entirely on your machine — no cloud,
  no account needed. Your CV and data stay in your own files.
- **Never auto-submits:** the apply flow drafts and prefills; submitting is
  always a human action.
- **CV generation never asks the agent to write:** the `pdf` worker tailors your
  CV and emits it inline in a `<<cv-html>>` envelope; the backend parses that
  envelope, writes the HTML, and renders the PDF itself. Job postings and
  evaluation reports are untrusted input that reaches this agent, so the safest
  thing is for it to hold no write tool at all — on Claude Code every write-capable
  tool is disallowed for this mode (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`
  and `Bash`). Other CLIs are invoked with a bare prompt and keep their own default
  tool access, so on those the agent still *holds* write tools — what the pipeline
  guarantees is that the CV which gets rendered is the one the backend parsed out of
  the envelope, never a file an agent wrote behind it.
- **Additive:** the web is isolated from the core's packaging, CI and release
  automation. The CLI works exactly the same without it.

## Deploying (e.g. Render) with MongoDB persistence

The web app is local-first: it reads and writes the files in the checkout
(`data/`, `reports/`, `config/`, `cv.md`, …). Those files are gitignored, so
on an ephemeral host (Render re-wipes the instance filesystem on every
redeploy) the app would boot empty and lose whatever it wrote. Instead of a
mounted disk you can keep the durable copy in a **MongoDB** (a free Atlas M0
cluster is enough): `src/lib/mongo-sync.mjs` pulls the tracked files from
Mongo at boot (seeding the empty filesystem) and flushes changed files back
every ~30 s, including a best-effort flush on SIGTERM.

1. Deploy `web/` as a Node web service (on Render: Root Directory `web`,
   build `npm ci && npm run build`, start `npm run start`, health check
   `/api/version`; a ready-made blueprint lives in `render.yaml` at the repo
   root).
2. Set env vars:
   - `MONGODB_URI` — your connection string (enables sync; unset = pure
     local-first, no-op).
   - `CAREER_OPS_WEB_ALLOWED_HOSTS` / `CAREER_OPS_ALLOWED_ORIGINS` — your
     deploy hostname/origin, or the loopback-only API guard 403s everything
     (see `src/lib/origin-guard.mjs`).
   - Optional: `CAREER_OPS_MONGO_DB` (default `career-ops`),
     `CAREER_OPS_MONGO_COLLECTION` (default `files`),
     `CAREER_OPS_MONGO_SYNC_INTERVAL_MS` (default `30000`),
     `CAREER_OPS_MONGO_PULL=always` (force-overwrite local files with the
     cloud copy; default `seed` only writes into an empty checkout).
3. First boot of an empty instance restores your data from Mongo; from then
   on every change is pushed back within one sync interval. On Render's
   **free** plan (512 MB, no disk support) the instance spins down after
   ~15 min idle — the next request pays a cold start, then Mongo restores
   your data at boot; nothing is lost.

Guard rails: only the personal, gitignored surface is synced (never code or
secrets); `.gitkeep`, `*.tmp-*` and `*.bak-*` scratch files stay out; files
over 8 MB are skipped with a log line. Repo-owned scaffolding inside the
tracked dirs (e.g. `writing-samples/README.md`) is never synced and never
counts as "has data". Safety: seed mode never clobbers a checkout that
already has data, and a skipped seed never deletes remote docs. Run a
**single instance** — the sync is last-write-wins and two instances would
race. Note also that agent-driven features (AI scan/eval/tailor, PDF
rendering) need CLIs/Chromium/LaTeX the native Node runtime lacks; use a
Docker deploy for those.

**AI without a CLI (key engine):** deployed hosts have no agent CLIs, so the
"Use an AI tool you have" engine can't work there. Config → **"Paste an AI
key"** unlocks a key-based engine — Gemini (grounded with live Google
Search), OpenRouter, Groq, NVIDIA NIM, OpenAI, plus **Custom / local** (any
OpenAI-compatible base URL: Ollama, LM Studio, vLLM, your own gateway; key
optional; a missing local model is auto-pulled Ollama-style when supported).
Model blank = **auto**: a free-first model chain per provider with
**automatic switching** on rate-limits/outages (hops are narrated into the
live trace; a stream is never swapped mid-sentence). Stored server-side in
`config/ai-keys.json` (gitignored, Mongo-synced; the browser never keeps the
key). It powers AI search (`/api/explore/ai` streams the provider through the
same `<<offer:>>` grammar the CLI produces), and **Evaluate** on job pages
(`/api/run` spawns the core's own key runner, `openrouter-runner.mjs`, with
the stored key — OpenAI-wire generic, Gemini via its official OpenAI-compat
bridge). A "Test key" button verifies credentials before saving. CV
tailor/PDF and portal fixes remain agentic and still need a CLI on the host.

**Troubleshooting:** the platform health check uses `/healthz`, which lives
outside the `/api` origin guard, so deploys pass even with zero config. If
the *browser* 403s on every action instead, the guard is doing its job: set
`CAREER_OPS_WEB_ALLOWED_HOSTS` and `CAREER_OPS_ALLOWED_ORIGINS` to your
actual deploy hostname/origin. (Historically the health check pointed at
`/api/version` and fresh deploys "Timed Out" until those vars existed —
never wire a host's probe into a guarded route.) If the logs show
`mongo-sync: pull skipped — checkout not empty`, you're on a pre-`058682b`
build (fresh clones' scaffolding used to block the seed pull) or your
checkout genuinely has data; `CAREER_OPS_MONGO_PULL=always` force-restores.

## Development

```bash
npm run dev          # dev server (Turbopack)
npm test             # unit suites (node --test, no framework)
npx tsc --noEmit     # typecheck
npm run build        # production build
```

Set `CAREER_OPS_ROOT=/path/to/checkout` in `web/.env.local` to point the app at
a different career-ops directory (useful for testing against sample data).

`/api` is gated by the same-origin + loopback guard in `src/lib/origin-guard.mjs`.
Two opt-ins widen it, both unset by default and both in `web/.env.local`:
`CAREER_OPS_WEB_ALLOWED_HOSTS` names extra non-loopback hosts the dashboard may
answer on, and `CAREER_OPS_ALLOWED_ORIGINS` names origins allowed to call the
API from outside the app — a comma- or space-separated list, no trailing slash.
The second is what a local companion client needs: a browser extension calls
from a `chrome-extension://` origin, which Fetch Metadata always reports as
`cross-site`, so the guard refuses it unless the id is named here. The host
layer still applies to an allowlisted origin.

### Tests

Suites live in `web/tests/`, mirroring the path of what they test under
`web/src/` — so `src/lib/clean-chips.mjs` is tested by
`tests/lib/clean-chips.test.mjs`. Name the file `{module}.test.mjs`.

`npm test` discovers them with a glob (`tests/**/*.test.mjs`), so a new suite
needs **no registration** — just add the file. **Requires Node ≥ 22**: earlier
versions don't expand CLI globs for `node --test`, so `npm test` prints
`Could not find '…'`, runs nothing and exits 1. Hence `engines.node` in
`web/package.json` — a higher floor than `next` itself asks for.

Three constraints follow from all this:

- **Keep tests out of `src/`.** `src/` is the Next.js app's own tree, scanned by
  `next build`'s file tracing and `tsc --noEmit`; test files there entangle
  fixtures with build and route conventions.
- **Use `.mjs`, not `.ts`.** There is no test framework and no TypeScript loader
  by design — `node --test` cannot run a `.ts` suite, so one would look like
  coverage and never execute. Extract the logic under test into a plain `.mjs`
  module (the pattern `src/lib/pdf-paths.mjs` and `src/lib/pdf-render.mjs`
  already follow) and import it from the test.
- **Web suites use `node:test`; core suites don't.** Here you write
  `import { test } from "node:test"` with `node:assert/strict`. The root
  `tests/` suite deliberately uses neither — it has its own `pass`/`fail`
  helpers, because [#1440](https://github.com/career-ops-hq/career-ops/issues/1440)
  requires the core suite to run on a bare clone with "no framework, not even
  `node:test`". Don't carry either style across the boundary.

`tests/web-test-layout.test.mjs` in the **root** suite enforces all of the above
on every PR, including that `npm test` never goes back to listing suites by name
([#2360](https://github.com/career-ops-hq/career-ops/issues/2360)).
