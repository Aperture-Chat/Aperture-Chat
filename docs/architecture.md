# Aperture Chat Architecture

## Runtime shape

Aperture Chat consists of a React/TypeScript web application and a FastAPI API.
The source and release Compose stacks run API/web and optionally Caddy for
HTTPS. The image-based release stack also includes an updater sidecar.

Scheduled automations and audit-outbox delivery run inside the API process.
There is no separate worker service. Some stores, rate limits, and scheduling
coordination remain process-local: do not add API replicas merely because a
relational database is available.

## Frontend

- Signed-session bootstrap, first-owner setup, local/OIDC sign-in, access requests, and account security.
- Chat, model selection, attachments, connected sources, work traces, history, and session details.
- Drafts with document/deck switching, grouped formatting controls, templates, version comparison, history previews, archive/delete, and export.
- Agents (with Automations) and Library (Knowledge and Tools) workspaces with role-aware access.
- Tenant administration for users, groups, SSO, model restrictions, policies, knowledge, tools, and analytics.
- Platform-owner controls for providers, credentials, organizations, model availability, connectors, audit, branding, and release updates.
- Role-specific training and downloadable guides; access/sign-in guidance is available before authentication.

### Routes and deep links

The web application is a single-page app served with a history fallback, so
every path below resolves to `index.html` (nginx `try_files`, Vite dev server,
and Caddy `reverse_proxy` need no per-route configuration). Only `/api`, `/v1`,
`/scim/v2`, and `/health` are reserved for the API and edge.

| Path | Screen | Gate |
| --- | --- | --- |
| `/`, `/chat` | Chat (open conversation) | any signed-in role |
| `/chat/<threadId>` | A specific chat thread | must be in the actor's own thread list |
| `/drafts`, `/drafts/<draftId>` | Drafts workspace, optionally loading one server draft | owner-scoped by the API |
| `/agents`, `/automations` | Agents / Automations | any |
| `/library/knowledge`, `/library/tools` | Knowledge / Tools | any |
| `/admin/<section>` | Admin console tab (`users`, `groups`, `model-access`, `tools`, `sso`, `analytics`, `policies`, `audit`, `alerts`) | platform owner or tenant admin |
| `/platform/<section>` | Platform console tab (`setup`, `org-settings`, `models`, `providers`, `analytics`, `audit`, `alerts`) | platform owner |

The URL is a selector, never an authorization: a route outside the account's
role is replaced with the role's landing screen and an honest notice, thread
and draft ids are resolved through the actor's own scoped API calls, unknown
paths fall back to chat, and a deep link opened while signed out is restored
after sign-in only as a parsed route (never a raw redirect string). SSO
fragments and the development `?persona=` selector are consumed before routing
and are never written back into history.

## API and access boundaries

Application routes handle identity, administration, chat, drafting, knowledge,
connectors, agents, and automation runs. SCIM provisioning requires its configured
bearer token. `/v1/chat/completions` and `/v1/responses` expose gateway-compatible
runtime routes; they still enforce application authentication and model policy.

Tenant-owned resources are scoped before repository access. Platform-owner
operations that select a tenant must provide the required tenant context.
Private drafts remain scoped to their owner and tenant; updates use an expected
revision to reject conflicting writes rather than silently overwriting them.
A draft is either a sanitized HTML document or a slide deck stored as canonical
deck JSON (`draft_documents.kind`); the kind is fixed at creation and the
server canonicalizer (`app/models/deck_document.py`) is the authority for what
deck content may be persisted.
Tenant-admin prompt activity does not include platform-owner prompts merely
because the administrator has access to analytics.

Model access combines provider readiness, platform/tenant availability,
group or user grants, and explicit denials. Administrative catalog visibility
is separate from permission to execute a model.

### Search

Global search (`GET /api/search`, the Ctrl/⌘ K palette) narrows candidates
through a relational index inside the application database
(`search_index_entries`, per-tenant state in `search_index_state`). Chat
threads and drafts write their index row in the same transaction as the
record; agent profiles, automations, and matters are re-derived on every
scheduler tick, and a per-tenant backfill runs in the API process until the
tenant is marked ready. The index is never an authority: every candidate is
loaded again through the actor's own owner-scoped repository call and passed
through the same policy checks as the scan path, and the response reports
`index_state` (`ready`, `backfilling`, or `disabled` via
`APERTURE_SEARCH_INDEX_ENABLED=false`, which restores per-request scans).
Text matching currently uses a portable LIKE mode over pre-lowercased text on
both SQLite and Postgres; FTS5/tsvector acceleration is a follow-up. Platform
owners can inspect and rebuild the index under Org Settings. The palette also
offers role-gated commands (type `>`) and recently opened items kept in
`sessionStorage`.

## Providers and external services

The gateway supports OpenAI-compatible endpoints, OpenRouter, Azure OpenAI,
and Anthropic paths. Individual operations depend on provider/model capability;
configuration alone does not establish support for every chat, image, search,
or transcription operation.

Cloud-source clients include Box, Google Drive, Microsoft Graph sources
(OneDrive/SharePoint), and iManage. Authentication and source access depend on
the configured connector and upstream permissions. Uploaded knowledge supports
text extraction, optional local OCR, and a local dense-vector index; media
transcription can call the configured model provider.

Model requests, cloud-source access, and enabled web search can send data to
external services. Outbound guards block metadata/link-local destinations and
restrict private-network access; required internal hosts must be explicitly
allowed by operator configuration.

## Identity and secrets

Deployed environments require a unique, high-entropy signing secret and signed
sessions. Compose forces production security settings even in its local profile.
Development header authentication is limited to the environments allowed in
`app/core/config.py` and is disabled in deployed stacks.

Provider and connector credentials use encrypted secret references. Ordinary
responses expose masked previews; explicit credential reveal and management
require platform-owner authorization. Preserve the signing secret during
upgrades because it also participates in protecting stored credentials.

## Persistence

SQLAlchemy repositories and Alembic migrations manage relational application
state, including identity/configuration, sessions, chat, private drafts and
revisions, audit, and usage records. SQLite is the default application database.
Remaining runtime state and dedicated stores still exist alongside it.

| Configuration | Purpose |
| --- | --- |
| `APERTURE_APPLICATION_DB_PATH` | Default application SQLite path. |
| `APERTURE_DATABASE_URL` | Explicit alternative application database connection; PostgreSQL requires a reviewed migration. |
| `APERTURE_RUNTIME_STATE_PATH` | Remaining JSON runtime state and legacy import boundary. |
| `APERTURE_VECTOR_DB_PATH` | Dedicated local knowledge vector index. |
| `APERTURE_REVIEW_DB_PATH` | Dedicated Review Grid SQLite store; it does not move with the application database URL. |

The Compose data volume preserves local application files across API recreation.
Back up all configured databases, remaining state, uploaded/generated artifacts,
and private configuration together. A single copy of `runtime_state.json` is
not a complete backup. Use a consistent database backup method; do not copy a
live SQLite main file without its transaction state and assume it is complete.

The optional PostgreSQL profile starts a database service. It does not migrate
SQLite data or change API storage automatically. Review the explicit import and
transfer utilities under `services/api/app/db` before setting the connection
URL. Dedicated local stores and process-local scheduling still constrain scale.

## Releases and updates

Promotion follows `dev` to `test` to `main`, using merge commits. Each release
branch builds API/web images for amd64 and arm64, verifies the pair, and publishes
commit-addressed, branch, and version-qualified branch tags. Record digests for
reproducible deployment; rerunning a build can change a commit-addressed tag.

Main promotion requires inspectable test images. Stable publication verifies
the release tree against its inspected test parent and promotes those manifests
to the version and latest aliases without rebuilding.

The release updater is the only application service mounted to the Docker
socket. It has host-level control, so operators should review that access.
It updates API/web together, verifies health and version, and attempts recovery
when either fails. Recovery of images does not undo database migrations.
Source deployments retain their manual build/deploy workflow. See
[Docker deployment](DOCKER_RELEASE.md) for installation and upgrade instructions.
