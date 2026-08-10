# Aperture Chat Documentation

This directory contains the public technical documentation and product images
for Aperture Chat.

## Start Here

- [Project overview](../README.md)
- [Contribution workflow](../CONTRIBUTING.md)
- [Architecture](architecture.md)
- [Docker deployment](DOCKER_RELEASE.md)
- [Security policy](../SECURITY.md)
- [License](../LICENSE)

## Repository Map

| Path | Purpose |
| --- | --- |
| `apps/web` | React and Vite frontend, tests, and static training media. |
| `services/api` | FastAPI backend, persistence, policy logic, provider routing, and tests. |
| `infra/caddy` | Caddy reverse-proxy configuration for container deployments. |
| `docs` | Public architecture, deployment, and product documentation. |
| `docker-compose.yml` | Source-build Compose stack for local development. |
| `docker-compose.release.yml` | Image-based Compose stack for tagged releases. |
| `.env.example` | Non-secret environment template. |

## Roles

- `PLATFORM_OWNER` manages platform-wide providers, model availability,
  organization settings, tenant boundaries, audit controls, and branding.
- `TENANT_ADMIN` manages tenant users, groups, connectors, knowledge bases,
  tools, policies, analytics, and model access.
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
