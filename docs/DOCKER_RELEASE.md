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

## Guided VPS installation

Download and inspect the Docker bundle attached to a release that includes
`scripts/install-release.py`, then extract it. Docker Engine with Compose v2
and Python 3 must already be installed. Point a DNS hostname at the VPS and
make ports 80/443 available to the bundled Caddy proxy.

From the extracted bundle, prepare a new installation:

```bash
python3 scripts/install-release.py --directory ./deployment --domain chat.example.com --tag vX.Y.Z --start
```

Replace the hostname and tag with your deployment and reviewed release. The
script generates a private session secret and stable Compose project identity,
configures HTTPS origins, and starts API, web, Caddy, and the updater. Complete
the first-owner setup immediately. Omit `--start` to prepare and review the
configuration before running Docker. Existing directories are refused so the
installer cannot replace another installation's secrets or data configuration.

Forks can add `--repository your-org/your-repo --registry ghcr.io/your-org`.
Publish public stable `vX.Y.Z` releases and matching `aperture-chat-api` and
`aperture-chat-web` image tags in that registry. Update `services/api/pyproject.toml` and the matching package versions for each
release; persistent `APERTURE_RELEASE_VERSION` overrides no longer change the
reported running version. Release checks derive their API endpoint from the
selected repository unless `APERTURE_PLATFORM_UPDATE_RELEASES_URL` is explicitly
configured. Private release APIs and registry authentication require additional
operator configuration; the guided path assumes publicly readable artifacts.

### Enable updates on an existing installation

An older deployment without the sidecar cannot install that capability by
clicking its existing version notice. First back up its application data and
private configuration. Use a reviewed release containing updater support to
update the existing deployment files and API/web images once, keeping the same
Compose project name, volume names, secret, proxy configuration, and environment
settings. Add `infra/updater/updater.sh` and the release Compose updater service,
shared state volume, and API state-directory mount. Start the release stack
from that same directory and confirm the owner update panel reports the updater
ready. Do not run the fresh installer over an existing deployment or start a
new Compose project against old data without a reviewed migration.

Subsequent compatible API/web releases can be installed from the owner panel.
Changes to Compose services, the updater itself, or release-specific migrations
still require the steps in the release notes. Source-build installations keep
their source deployment workflow; the panel does not promise automatic updates
when no ready updater is connected.

## Build from Source

```bash
cp .env.example .env
docker compose --profile local build
docker compose --profile local up -d
docker compose --profile local ps
```

Open the configured local URL and complete the first-owner bootstrap flow. Keep
the generated owner credentials and application secrets in a password manager.

## Run Published Images

Set `APERTURE_IMAGE_TAG` to a published release tag in the project's `.env`,
then start the release stack from that project directory:

```bash
# Set APERTURE_IMAGE_TAG=vX.Y.Z in .env first.
docker compose -f docker-compose.release.yml --profile local pull
docker compose -f docker-compose.release.yml --profile local up -d
docker compose -f docker-compose.release.yml --profile local ps
```

These examples select the `local` profile for the API and web services. Use
`--profile vps` or `--profile prod` when the deployment also runs the bundled
Caddy proxy. Keep the same profile for pull, start, upgrade, and status commands.

If the container packages are private, authenticate Docker to GitHub Container
Registry with a token that has package-read access before pulling.

## Branch Images and Failed Publications

The branch-image workflow publishes `dev`, `test`, and `main` images. It first
builds both `<branch>-<full-commit-sha>` tags and verifies their build digests
and `linux/amd64` / `linux/arm64` manifests. Only then does it update the moving
branch aliases from those verified digests. A build or inspection failure
before promotion leaves the branch aliases untouched.

The job summary records both new image digests and the previous alias digests.
Alias updates across the API and web repositories are not atomic. Runs for the
same branch are serialized to avoid automatic cancellation between updates;
manual cancellation, registry failures, or another publisher can still leave
a mixed pair. On a promotion or final verification failure, the workflow
attempts to restore each existing alias that still points to the digest it
attempted to publish. Recovery is best effort: inspect both aliases and the
recorded digests before deploying after a failed run. For a first publication
there may be no previous alias, and the workflow does not delete manifests.

If recovery requires manual intervention, restore both aliases from the prior
digest pair recorded in the job summary, then inspect them again:

```bash
docker buildx imagetools create --tag ghcr.io/your-org/aperture-chat-api:dev ghcr.io/your-org/aperture-chat-api@sha256:PREVIOUS_API_DIGEST
docker buildx imagetools create --tag ghcr.io/your-org/aperture-chat-web:dev ghcr.io/your-org/aperture-chat-web@sha256:PREVIOUS_WEB_DIGEST
docker buildx imagetools inspect ghcr.io/your-org/aperture-chat-api:dev
docker buildx imagetools inspect ghcr.io/your-org/aperture-chat-web:dev
```

Replace the organization, branch, and digest placeholders with the recorded
values. Prefer the verified SHA tag pair for branch deployments; retain the
digest pair for exact reproducibility because a workflow rerun can rebuild a
SHA tag. The `test` to `main` promotion gate and release-only `latest` tags
continue to use the existing release workflow.

## Upgrade

1. Back up the persistent application-data volume.
2. Read the release notes for migrations or configuration changes.
3. Set `APERTURE_IMAGE_TAG` to the new immutable tag.
4. Pull and recreate the services without deleting volumes.
5. Verify health, sign-in, chat, and the relevant admin surfaces.

```bash
docker compose -f docker-compose.release.yml --profile local pull
docker compose -f docker-compose.release.yml --profile local up -d
docker compose -f docker-compose.release.yml --profile local ps
```

Do not use `docker compose down -v` during a normal upgrade; `-v` deletes the
persistent data volume.

### Update from the Platform Owner Sidebar

The release stack includes an `updater` sidecar. Platform owners can check for
a newer tagged GitHub release, read its notes, and start the update from the
sidebar. Tenant administrators and ordinary users cannot manage platform
updates. The source-build stack uses the manual source deployment workflow.

Start the release stack from its project directory so the updater's `${PWD}`
mount preserves the host paths in Compose. Keep `APERTURE_IMAGE_TAG` in the
project's writable `.env` file; a shell-only override cannot record the version
for later restarts. Projects with multiple Compose environment files must use
their operator's manual upgrade command to preserve all overrides.

Before starting an update, back up application data and read the release's
migration instructions. The updater records the running API and web image IDs,
pulls the new pair, saves a private `.env.aperture-updater.bak`, and updates the
tag atomically. It then recreates only API and web and checks both services.
Slow pulls continue to report progress. If applying or checking the new pair
fails, it attempts to restore the recorded image IDs and the previous tag.
An unsuccessful rollback is reported as requiring manual attention. Image
rollback does not undo database migrations or replace a data backup.

The updater has the Docker socket and a writable project-directory mount,
which grant it host-level control. The API has only the shared status/request
volume and never receives the Docker socket. Keep the project directory and
its environment-file backup private. Private registries also require Docker
credentials to be available inside the updater; a host-only Docker login is
not automatically shared with this container.

To deploy without the updater, name the services explicitly:

```bash
docker compose -f docker-compose.release.yml --profile local up -d api web
# Include caddy when using the vps or prod profile.
```

If the updater is already running, stop only that service before starting the
explicit service list. Inspect progress and any failure with:

```bash
docker compose -f docker-compose.release.yml --profile local logs --tail=100 updater
docker compose -f docker-compose.release.yml --profile local ps
```

Keep logs private: Docker output may contain deployment-specific details.
After a successful update, reload the browser and verify sign-in and the
provider-backed workflows used by your organization.

## Health and Logs

```bash
docker compose -f docker-compose.release.yml --profile local ps
docker compose -f docker-compose.release.yml --profile local logs --tail=200 api
docker compose -f docker-compose.release.yml --profile local logs --tail=200 web
```

Use the health URL configured for your deployment and confirm that the API,
web application, and reverse proxy are healthy before routing production
traffic.

## New Since v0.4.6

- Populated Drafts now treat whole-document formatting, tone, citation-style,
  and template requests as preservation-first revisions. Provider output is
  staged transactionally, checked for content and protected-asset retention,
  and cannot replace the current document unless replacement is explicit.
- Structured JSON and YAML summaries render as responsive visual diagrams in
  chat and transfer into Drafts as images, while response validation accepts
  only diagram sources the client can actually render.
- Tool Library status notices can be dismissed without interrupting the
  underlying connection or tool state.

## New Since v0.4.5

- Model routing is hardened following a CRAP and mutation-testing audit of the
  API, with expanded network-guard and OpenRouter chat coverage locking in the
  provider-routing contract.
- Every permanent branch (`dev`, `test`, `main`) now publishes and verifies
  immutable multi-architecture container images on each commit, and the
  test-to-main promotion gate confirms the inspected image pair exists before
  merge.
- Audit dashboard metrics become inspectable investigation cards: each opens
  an accessible dialog listing every record behind the metric, with filtering
  when a metric covers many records.
- Admin and platform console tables are responsive, stacking into labeled
  rows on narrow viewports, with matching retention panel styling.

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
