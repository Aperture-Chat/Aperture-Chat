# Aperture Chat Agent Workflow

This repository is a public, source-available project. Treat every tracked file,
generated artifact, screenshot, log excerpt, and example as information that can
be read by anyone.

## Public-repository boundary

- Never commit credentials, tokens, private hostnames, IP addresses, SSH
  identities, local absolute paths, customer data, runtime databases, or
  production logs.
- Keep environment-specific instructions in an ignored `AGENTS.local.md` or
  another private system. Use placeholders such as `your-host` and
  `https://your-instance.example` in tracked examples.
- Automated contributors may consult local-only instructions for authorized
  operations, but must never copy, quote, summarize, or reveal SSH key paths,
  host details, or other deployment secrets in tracked files, commits, logs,
  screenshots, issue text, pull requests, or chat output.
- Use synthetic data for screenshots and recordings. Review visual assets for
  names, account details, keys, and private infrastructure before committing.
- Do not add generated success states, fabricated provider responses, or other
  behavior that makes the product appear more complete than it is.

## Contribution flow

Follow [CONTRIBUTING.md](CONTRIBUTING.md). In summary:

1. External contributors work from a fork and open a pull request to `dev`.
2. Organization contributors start from `dev` and should use a short-lived
   branch for anything beyond a very small change.
3. Keep changes narrow and iterative. A pull request should normally contain
   one feature, one fix, or one cohesive maintenance task.
4. Promotion follows `dev` -> `test` -> `main`. Do not bypass a stage.
5. A `test` commit must have inspectable API and web container images before it
   can be promoted to `main`.
6. Do not merge while automated or human review is still active.

## Change quality

- Explain what changed, why it changed, risks, and validation in the pull
  request. Good notes are required.
- Add comments where intent, security boundaries, or non-obvious tradeoffs
  would otherwise be unclear. Do not narrate obvious code.
- For visible changes, add screenshots or a short clip when practical. Use
  synthetic accounts and redact sensitive data.
- Update source, tests, documentation, and configuration together when a change
  affects their shared contract.
- Preserve unrelated work and avoid broad rewrites that make review difficult.

## Validation

Run checks proportional to the change. At minimum:

```bash
git diff --check
npm --workspace apps/web run typecheck
npm --workspace apps/web run test -- --run
npm run build:web
cd services/api && .venv/bin/python -m pytest -q
```

Use the relevant subset for documentation-only changes. Container validation
and promotion requirements are documented in [CONTRIBUTING.md](CONTRIBUTING.md).

## Guardrails

- Never reset volumes, erase runtime data, rewrite shared history, force-push,
  or change repository visibility without explicit owner approval.
- Keep platform-owner, tenant-admin, and user authorization boundaries intact.
- Respect [LICENSE.md](LICENSE.md) and preserve [NOTICE.md](NOTICE.md) in public
 forks and distributions.

## Cursor Cloud specific instructions

Two services make up the product; both run bare-metal for development (no Docker
needed). Standard install/lint/test/build commands live in the README
"Development" section and [CONTRIBUTING.md](CONTRIBUTING.md) "Local validation" —
use those. Notes below are the non-obvious environment caveats.

- **Web** (`apps/web`, React 19 + Vite): `npm run dev:web` serves on
 `http://localhost:5173` and proxies `/api`, `/v1`, `/scim/v2`, and `/health` to
 the API at `127.0.0.1:8000` (see `apps/web/vite.config.ts`). Open the app at
 `5173`, not `8000`.
- **API** (`services/api`, FastAPI + Python 3.12): run from `services/api` with
 `.venv/bin/uvicorn app.main:app --reload --port 8000`. SQLite is the default
 store, so no external database is required; runtime state persists under
 `services/api/data/` (gitignored). Alembic migrations run automatically on
 startup.

- **Node baseline is 24.** The base image's default `node` (`/exec-daemon/node`)
 is v22; v24 is installed via `nvm` and takes precedence. If `node --version`
 ever reports v22 in a shell, run `nvm use 24`. `npm ci` still works on v22, but
 `npm run check:node-baseline` only validates config files, not the runtime.

- **API test gotcha (important).** `config.py` always loads the repo-root `.env`.
 The `.env` copied from `.env.example` is tuned for a clean release/first-run
 posture and sets `APERTURE_DEV_HEADER_AUTH_ENABLED=false`,
 `APERTURE_SEED_PLATFORM_OWNER_ENABLED=false`, and
 `APERTURE_SEED_DEMO_DATA_ENABLED=false`. The pytest suite (like CI, which runs
 with no `.env`) depends on those defaults being **on** and otherwise fails ~30
 auth/usage/API-key tests with 401s. Run the API tests either with no repo-root
 `.env`, or by overriding the flags (real env vars win over `.env`):
 `APERTURE_DEV_HEADER_AUTH_ENABLED=true APERTURE_SEED_PLATFORM_OWNER_ENABLED=true APERTURE_SEED_DEMO_DATA_ENABLED=true .venv/bin/python -m pytest`.
 The web suite (`npm run test:web -- --run`) has no such dependency.

- **Provider keys and first-run.** With no `.env` present the API auto-seeds a
 platform owner and demo data; the committed-style `.env` instead opens the app
 in first-run mode where the initial platform owner is created from the sign-in
 screen (creation is a real, persisted action). Live model chat/image/search
 needs a provider key (e.g. `OPENROUTER_API_KEY`); without one those surfaces
 return honest "not configured" errors, but account creation, auth, and
 workspace navigation work fully offline.

- **Optional media/knowledge deps.** OCR ingestion uses `tesseract` and audio
 transcription uses `ffmpeg` (both installed at the OS level). Dense knowledge
 embeddings download `BAAI/bge-small-en-v1.5` via `fastembed` to
 `/opt/aperture-models` on first ingestion (needs outbound network); this is not
 exercised by startup or the hello-world flow.
