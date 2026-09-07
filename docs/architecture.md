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
- Agents/Automations and Knowledge/Tools workspaces with role-aware access.
- Tenant administration for users, groups, SSO, model restrictions, policies, knowledge, tools, and analytics.
- Platform-owner controls for providers, credentials, organizations, model availability, connectors, audit, branding, and release updates.
- Role-specific training and downloadable guides; access/sign-in guidance is available before authentication.

## API and access boundaries

Application routes handle identity, administration, chat, drafting, knowledge,
connectors, agents, and automation runs. SCIM provisioning requires its configured
bearer token. `/v1/chat/completions` and `/v1/responses` expose gateway-compatible
runtime routes; they still enforce application authentication and model policy.

Tenant-owned resources are scoped before repository access. Platform-owner
operations that select a tenant must provide the required tenant context.
Private drafts remain scoped to their owner and tenant; updates use an expected
revision to reject conflicting writes rather than silently overwriting them.
Tenant-admin prompt activity does not include platform-owner prompts merely
because the administrator has access to analytics.

Model access combines provider readiness, platform/tenant availability,
group or user grants, and explicit denials. Administrative catalog visibility
is separate from permission to execute a model.

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
