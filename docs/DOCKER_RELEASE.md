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

## New Since v0.4.4

- Users can report platform issues from Help with a subject, detailed message,
  and optional screenshot. Tenant admins and platform owners can review the
  reports alongside response-feedback analytics. Migration 20260820_0018.
- Prompt editors now expand into focused writing surfaces and share the chat
  prompt improver, progress rail, and one-click restore behavior across chat,
  agent system/meta prompts, and reusable prompt templates.
- Knowledge-base visibility now enforces user-only access strictly and labels
  group-shared collections with the assigned group instead of a single user.
- Mermaid plus structured JSON and real YAML diagrams remain visual when a
  response is transferred into Drafts. Mixed responses hydrate every diagram,
  and one malformed figure no longer blocks the rest.

## New Since v0.4.3

- Response sentiment goes server-side: thumbs ratings and an optional
  written note (inline, dismissible composer under every reply) persist per
  user and message, and the console Chat Feedback panels show every user's
  feedback with a click-through preview of the full rendered conversation,
  the note, and the rated exchange highlighted. Migration 20260817_0017.
- Drafts gains the chat-style model menu: a fully clickable trigger and a
  star that pins a persistent default drafting model.

## New Since v0.4.2

- Data retention program: chats gain authoritative retention clocks, and a
  per-tenant policy can tag them by MCP connection, file uploads, and an
  LLM-classified subject taxonomy (all off by default). Migration
  20260816_0016 backfills thread clocks from message history on upgrade.
- The audit User Prompt Activity panel adds a Prompts | Tags switcher with
  phrase search, client/matter-number search, full-conversation previews,
  and batch archive/delete that always skips chats under an active legal
  hold. The prompt preview now shows a thread's complete history.
- Temporary users: an access-request sign-up flow and lifetime token grants
  with exact, fail-closed metering.
- Training decks add narrated "Data retention and tagging" walkthroughs for
  the admin and owner consoles.

## New Since v0.4.1

- Chat replies stay resumable after a hard refresh: pending bubbles are kept,
  partial streams persist, and a silent SSE socket reconnects instead of
  dropping the answer.
- Mermaid and structure diagrams always render as visuals in chat, and
  Transfer to Drafts rasterizes those figures so the document keeps the image.
- Composer prompt-improver rail and streaming visualizer polish.

## New Since v0.3.14

- Chat and knowledge uploads transcribe audio and video with Gemini Flash.
  Videos without a soundtrack still produce visual notes from extracted stills.
- The API image includes ffmpeg so MP4/MOV and similar formats can be processed
  on the same path as composer dictation.
- Drafting workspace: structural inline AI edits, quieter status chrome, and
  related document-craft adjustments from the v0.4.0 line.
- Role guides include identity-provider and troubleshooting appendices.

## Test Promotion Images

Pull requests promoted from `dev` to `test` publish immutable review images.
The promotion pull request records their exact digests so reviewers can inspect
the same containers that are later considered for `main`. See
[CONTRIBUTING.md](../CONTRIBUTING.md) for the full branch and review workflow.
