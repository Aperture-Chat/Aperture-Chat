# Docker Deployment

Aperture Chat ships a source-build Compose stack for development and an
image-based Compose stack for tagged releases. Runtime data and secrets stay
outside image layers.

## Requirements

- Docker Engine with Compose v2
- A writable Docker volume for application data
- A non-secret copy of `.env.example` configured for the deployment

Never commit a populated `.env`, database, provider credential, session secret,
or exported runtime volume.

## Build from Source

```bash
cp .env.example .env
docker compose build
docker compose up -d
docker compose ps
```

Open the configured local URL and complete the first-owner bootstrap flow. Keep
the generated owner credentials and application secrets in a password manager.

## Run Published Images

Set `APERTURE_IMAGE_TAG` to a published release tag, then start the release
stack:

```bash
export APERTURE_IMAGE_TAG=vX.Y.Z
docker compose -f docker-compose.release.yml pull
docker compose -f docker-compose.release.yml up -d
docker compose -f docker-compose.release.yml ps
```

If the container packages are private, authenticate Docker to GitHub Container
Registry with a token that has package-read access before pulling.

## Upgrade

1. Back up the persistent application-data volume.
2. Read the release notes for migrations or configuration changes.
3. Set `APERTURE_IMAGE_TAG` to the new immutable tag.
4. Pull and recreate the services without deleting volumes.
5. Verify health, sign-in, chat, and the relevant admin surfaces.

```bash
docker compose -f docker-compose.release.yml pull
docker compose -f docker-compose.release.yml up -d
docker compose -f docker-compose.release.yml ps
```

Do not use `docker compose down -v` during a normal upgrade; `-v` deletes the
persistent data volume.

## Health and Logs

```bash
docker compose ps
docker compose logs --tail=200 aperture-api
docker compose logs --tail=200 aperture-web
```

Use the health URL configured for your deployment and confirm that the API,
web application, and reverse proxy are healthy before routing production
traffic.

## Test Promotion Images

Pull requests promoted from `dev` to `test` publish immutable review images.
The promotion pull request records their exact digests so reviewers can inspect
the same containers that are later considered for `main`. See
[CONTRIBUTING.md](../CONTRIBUTING.md) for the full branch and review workflow.
