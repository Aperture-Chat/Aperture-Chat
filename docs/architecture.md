# Aperture Chat Architecture

## System Overview

Aperture Chat is organized as a web application and an API service. The current implementation is optimized for a realistic first container release candidate: the UI, route contracts, policy rules, clean first-owner bootstrap, runtime persistence, an in-process scheduler for automations, and tests are in place, while several production adapters still use local or placeholder behavior.

## Runtime Shape

- `apps/web`: React + Vite + TypeScript UI matching the approved Aperture Chat reference screens.
- `services/api`: FastAPI API, policy enforcement, SCIM surface, model gateway facade, JSON/sqlite runtime store, and security tests.
- Docker services: web, api, and Caddy. There is deliberately no separate worker container: runtime state is a single-process store, so background work (scheduled automations, Elastic delivery) runs as an asyncio task inside the api process (`app/core/scheduler.py`).

## Frontend

The web app owns the complete product shell:

- Auth screen and session bootstrap.
- Chat workspace, composer, model selector, attachments, and session detail drawer.
- Tenant admin console for users, groups, model access, connectors, SSO, knowledge, tools, and analytics.
- Platform owner console for providers, model catalog, API key vault, org settings, audit, and training content.
- Agent workspace for run status, approvals, logs, exports, and source-aware workflows.

The UI is expected to hold up across narrow, wide, short, and mobile viewports. Dense admin panels should use responsive grids, table scrollers, or card layouts instead of forcing page-level horizontal scrolling.

## API

The API exposes application routes plus OpenAI-compatible runtime routes:

- Auth and bootstrap routes load role-aware app state.
- Platform routes manage providers, provider keys, models, connectors, Elastic status, and model discovery.
- Admin routes manage tenant users, groups, model access, connector configs, SSO configs, knowledge configs, tool configs, and analytics.
- Chat routes handle sessions, threads, attachments, and completions.
- Knowledge routes list documents and trigger sync operations.
- Agent routes mutate persisted agent runs and approval state; automation schedules (once/weekly/cron, UTC) are executed by the in-process scheduler through the same chain runner as "Run now".
- SCIM routes provide the initial identity-management surface.
- `/v1/chat/completions` and `/v1/responses` are internal gateway-compatible routes.

## Tenant Isolation

Every tenant-owned object must carry `tenant_id`. The API policy layer denies cross-tenant access before service logic. PostgreSQL row-level security should mirror the same rule when SQL persistence replaces the seeded repository.

## Model Gateway

The model gateway is intentionally internal so Aperture can replace liteLLM for tenant deployments. It exposes OpenAI-compatible `/v1/chat/completions` and `/v1/responses` routes while enforcing platform, tenant, group, and explicit deny policies before any provider adapter is called.

Provider adapters currently cover OpenAI-compatible APIs, OpenRouter-style routing, Azure OpenAI chat completions, and Anthropic messages. Broader vendor discovery and runtime validation remain future work.

## Secret Handling

Provider and connector secrets are stored as encrypted secret references. Normal API responses return masked previews only. Reveal, rotate, and delete actions are available only to platform owners and must emit audit events. Secret values must never be logged, returned in bootstrap payloads, or exposed to tenant admins.

## Knowledge And Connectors

Knowledge configuration and sync routes exist now. Text extraction covers common document and text-like inputs, and Box has the first concrete API client pattern. Google Drive, OneDrive, and iManage are represented in the configuration surface but still need production clients, OAuth/token handling, ACL-preserving metadata, and background ingestion.

## Hermes Jobs

Hermes is represented as native job infrastructure: runs, steps, artifacts, approvals, notifications, and logs. Production adapters can call an external Hermes runtime over SDK/webhook without exposing provider secrets to logs or tenant admins.

## Persistence Boundary

The first Docker release persists API state on the `aperture-api-data` volume:
`runtime_state.json` carries tenants, users, password hashes, provider/model
metadata, encrypted secret references, chats, knowledge metadata, tools,
prompts, automations, audits, and agent runs; `knowledge_vectors.sqlite3` stores
the local vector index; `.signing_secret` stores the generated local session
secret when `APERTURE_SECRET_KEY` is blank in a local environment.

The compose stack contains only services the application actually uses: web,
api, and (for public deployments) Caddy. If SQL persistence, queues, or object
storage ever replace the JSON/sqlite store, their services should be added at
the same time as the code that consumes them — never before.

## Release Boundary

The Dockerfiles, source-build compose file, image-based release compose file,
and tag-driven GitHub Actions workflow now define the first release candidate.
A fresh compose volume starts in blank first-owner mode because release seed
flags are false in `.env.example` and forced false for the API service in both
compose files. The target-host runbook lives in
[DOCKER_RELEASE.md](DOCKER_RELEASE.md).
