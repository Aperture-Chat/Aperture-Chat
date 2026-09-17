# Aperture Chat Documentation

This directory contains the public technical documentation and product images
for Aperture Chat.

## Start Here

- [Project overview](../README.md)
- [Contribution workflow](../CONTRIBUTING.md)
- [Architecture](architecture.md)
- [Docker deployment](DOCKER_RELEASE.md)
- [Training coverage and regeneration](TRAINING.md)
- [README images and capture maintenance](images/README.md)
- [Security policy](../SECURITY.md)
- [License](../LICENSE.md)

## Role Guides

- [User guide (PDF)](aperture-user-guide.pdf)
- [Administrator guide (PDF)](aperture-admin-guide.pdf)
- [Platform owner guide (PDF)](aperture-owner-guide.pdf)

These are the same downloadable guides shipped in the application's Help and
Documentation libraries. See [training publication](TRAINING.md) for their
source files, narrated walkthroughs, and verification procedure.

## Repository Map

| Path | Purpose |
| --- | --- |
| `apps/web` | React and Vite frontend, tests, and static training media. |
| `services/api` | FastAPI backend, SQL and local persistence, policy logic, provider routing, and tests. |
| `services/api/app/db` | Relational models, migration integration, and explicit import/transfer tools. |
| `infra/caddy` | Caddy reverse-proxy configuration for container deployments. |
| `docs` | Public architecture, deployment, and product documentation. |
| `docker-compose.yml` | Source-build Compose stack for local development. |
| `docker-compose.release.yml` | Image-based Compose stack for tagged releases, including the owner-driven updater. |
| `infra/updater/updater.sh` | Updater sidecar: pulls releases, recreates API/web, verifies both services, and attempts rollback. |
| `.env.example` | Non-secret environment template. |

## Roles

- `PLATFORM_OWNER` manages platform-wide providers, model availability,
  connector switches and credentials, organization settings, tenant boundaries,
  audit controls, and branding. The Platform console opens in **Org Settings**.
  Its **Documentation** center provides the owner PDF, narrated walkthroughs,
  and an Interactive platform guide for configuration advice.
- `TENANT_ADMIN` manages tenant users, groups, knowledge bases, tools, response actions, policies,
  analytics, and model access.
- `USER` uses the models, knowledge, tools, and workflows assigned to them.

Model access is layered through platform availability, tenant availability,
group or user grants, and explicit denials. Provider secrets are masked by
default and require platform-owner authorization to manage.

Every one of those gates is explainable: the model picker's "Why isn't a model
listed?" entry (`GET /api/me/model-catalog`) shows a signed-in person each
enabled model in their organization with the server's reason it is or is not
usable, and offers "Request access" where an administrator could change the
outcome. Requests (`/api/me/model-access-requests`) are advisory records, never
a grant. Administrators review them under Admin › Model Access, approving into
a group of their own tenant under the existing delegation ceiling, and can open
a read-only per-user access trace from Admin › Users. Platform owners can turn
catalog browsing off for users in Org Settings.

## Development Checks

With dependencies installed, run:

```bash
git diff --check
npm --workspace apps/web run typecheck
npm --workspace apps/web run test -- --run
npm run build:web
cd services/api && .venv/bin/python -m pytest -q
```

Review [CONTRIBUTING.md](../CONTRIBUTING.md) before opening a pull request. The
project uses small, staged promotions from `dev` to `test` to `main` so changes
can be reviewed in source and as inspectable container images.
