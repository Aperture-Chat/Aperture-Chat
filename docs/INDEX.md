# Aperture Chat Documentation

This directory contains the public technical documentation and product images
for Aperture Chat.

## Start Here

- [Project overview](../README.md)
- [Contribution workflow](../CONTRIBUTING.md)
- [Architecture](architecture.md)
- [Docker deployment](DOCKER_RELEASE.md)
- [Training coverage and regeneration](TRAINING.md)
- [Security policy](../SECURITY.md)
- [License](../LICENSE)

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
| `services/api` | FastAPI backend, persistence, policy logic, provider routing, and tests. |
| `infra/caddy` | Caddy reverse-proxy configuration for container deployments. |
| `docs` | Public architecture, deployment, and product documentation. |
| `docker-compose.yml` | Source-build Compose stack for local development. |
| `docker-compose.release.yml` | Image-based Compose stack for tagged releases, including the owner-driven updater. |
| `infra/updater/updater.sh` | Updater sidecar: pulls releases, recreates API/web, verifies both services, and attempts rollback. |
| `.env.example` | Non-secret environment template. |

## Roles

- `PLATFORM_OWNER` manages platform-wide providers, model availability,
  connector switches and credentials, organization settings, tenant boundaries,
  audit controls, and branding.
- `TENANT_ADMIN` manages tenant users, groups, knowledge bases, tools, response actions, policies,
  analytics, and model access.
- `USER` uses the models, knowledge, tools, and workflows assigned to them.

Model access is layered through platform availability, tenant availability,
group or user grants, and explicit denials. Provider secrets are masked by
default and require platform-owner authorization to manage.

## Development Checks

With dependencies installed, run:

```bash
npm --workspace apps/web run typecheck
npm --workspace apps/web run test -- --run
npm run build:web
cd services/api && .venv/bin/python -m pytest -q
```

Review [CONTRIBUTING.md](../CONTRIBUTING.md) before opening a pull request. The
project uses small, staged promotions from `dev` to `test` to `main` so changes
can be reviewed in source and as inspectable container images.
