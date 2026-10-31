# Docker Deployment

Aperture Chat ships a source-build Compose stack for development and an
image-based Compose stack for tagged releases. Runtime data and secrets stay
outside image layers.

## Requirements

- Docker Engine with Compose v2
- A writable Docker volume for application data
- A private `.env` created from `.env.example`, with a unique, high-entropy `APERTURE_SECRET_KEY` of at least 32 characters
- A reviewed `APERTURE_IMAGE_TAG` when using the image-based release stack

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
# Set APERTURE_SECRET_KEY in .env before starting Docker.
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
# From the extracted release bundle or repository root:
# Copy .env.example to .env if it does not exist.
# Set APERTURE_IMAGE_TAG=vX.Y.Z and a strong APERTURE_SECRET_KEY first.
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

Version-qualified branch tags follow `v<version>-<branch>`, for example
`v0.5.4-dev`, `v0.5.4-test`, and `v0.5.4-main`. Both the API and web package
use these tags. They advance with subsequent commits carrying that version;
use the recorded digest pair to pin an exact build. The workflow verifies the
version-qualified pair before moving the plain branch aliases. Stable
`v0.5.4` and `latest` remain exclusive to the tagged main release.

## Persistent storage and backups

Application state is split across a relational database (SQLite by default),
remaining JSON state, and dedicated local stores. Preserve the full configured
data volume, uploaded/generated files, signing secret, and private Compose
configuration. Backing up only `runtime_state.json` is insufficient. Use a
consistent database backup or stop writes during the backup; copying a live
SQLite main file alone can omit WAL transactions.

The volume also holds `knowledge_originals/`, a copy of every uploaded and
connector-synced knowledge file plus its cached rendition, so it grows with the
knowledge bases. Files stored there are readable by anyone with access to the
volume, the same as the databases.

The optional `postgres` profile starts PostgreSQL but does not migrate data or
switch the API. Review the dry-run/import procedures in
`services/api/app/db/transfer_database.py`, then configure
`APERTURE_DATABASE_URL` only after a verified transfer. Dedicated vector/Review
Grid stores and process-local scheduling remain separate. Keep the application
at its supported single-process deployment shape; adding PostgreSQL does not
by itself enable multiple API replicas.

## Upgrade

1. Back up the persistent application-data volume.
2. Read the release notes for migrations or configuration changes.
3. Set `APERTURE_IMAGE_TAG` to the reviewed release tag and record the API/web manifest digests.
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

## New Since v0.5.17

- **Document viewer for knowledge sources.** Citations and Knowledge Library
  names open the document itself at the cited page. Uploads and connector syncs
  now keep the original file on the data volume (`knowledge_originals/`), so
  plan for that growth; documents indexed earlier still open, as text, at their
  cited passage until they are uploaded or synced again.
- The API image now includes headless LibreOffice (Writer, Calc, Impress), and
  grows by about 450 MB, to about 2.9 GB. It converts Office, RTF, and OpenDocument
  files on first view, one at a time, using up to
  `APERTURE_KNOWLEDGE_RENDITION_MEMORY_MB`
  (default 4096, minimum 2048) of address space, for at most
  `APERTURE_KNOWLEDGE_RENDITION_TIMEOUT_SECONDS` (default 120). No migration.
- Conversions run as the image's unprivileged `aperture-render` account, which
  cannot read the data volume, so the API must start as root to drop to it, as the
  shipped image does. If it runs under another `user:`, or the data directory can
  be entered by anyone else, documents open as text with a notice. Both compose
  files set `APERTURE_ENVIRONMENT=production`. A container started by hand with no
  environment defaults to `local`, where that refusal does not apply, so do not
  rely on it outside a laptop. `scripts/prove-rendition-image.sh` builds the image
  and proves the conversion sandbox inside it, on the LibreOffice it ships.
- **Citations list only what the reply used.** A knowledge document appears as a
  source only when the reply cites it, and web results the reply did not cite
  are marked as consulted. Citations gain new stored fields. No migration, but
  the fields are forward-only: v0.5.17 refuses to load any chat row that holds
  them, so rolling back to v0.5.17 needs the data volume backup taken before the
  upgrade as well as the older images. This release reads rows from newer
  versions, so later field additions will not repeat this.
- **Search finds the passage that answers.** A term past three mentions in a
  passage no longer adds to its score, so naming what was asked beats repeating
  one word. Existing indexes need no rebuild.
- **Chat offers the slide deck editor for more requests.** Requests for slides,
  a deck, or anything PowerPoint are recognized by their grammar, including
  typos, and pasted text no longer triggers an offer as often.
- **Account drawer rebuilt.** Profile, workspace consoles, View as, security, API
  access, this month's usage, and archived chats share one design, and every
  item was validated. `GET /api/auth/me/usage-summary` is new. `POST
  /api/auth/api-key` now returns 409 over a live key unless the request sends
  `{"replace": true}`. The web and API images must ship together.
- **Drafts stays in view.** Documents scroll in their own pane above 560 px, so
  the page navigator and status bar stay on screen and the page count follows
  the scroll. Documents and decks use the same work trace as chat. Library file
  rows gain a Preview button that opens the document viewer.
- **The sidebar collapses with one smooth motion**, from a short bar on its edge.
- **Training covers everything above.** The library grows to 71 lessons with
  spreadsheets, checking sources, code in chat, editing tables and diagrams, and
  ethical walls, and 27 lessons are re-narrated. The three PDF guides are rebuilt.

## New Since v0.5.16

- **Spreadsheets in Drafts.** Drafts gains a third format beside Document and
  Deck: an Excel-style workbook with multiple sheets, a formula engine with
  hundreds of Excel functions, dynamic arrays, and structured table
  references, tables with a style gallery, pivot tables, charts, conditional
  formatting, data validation, filters, sorting, named ranges, notes, freeze
  panes, find, and column and row autofit. Workbooks open from and export to
  `.xlsx` and `.csv`, start from templates (budget, sales tracker, project
  plan, invoice, expenses, loan, inventory), keep saved versions with a
  side-by-side compare, and have a **Spreadsheet Assistant** that edits a
  selection or builds whole tables and shows its work trace. Chat requests for
  budgets, trackers, or tables offer **Build this as a spreadsheet?**.
- **Real PDF export.** The Export panel's new **PDF document** builds the file
  on the server: headless Chromium lays out the saved version offline with
  JavaScript off, and the API finishes it as **PDF/A-2b** with embedded fonts,
  searchable text, bookmarks from the headings, tagged structure, and a
  linearized file. Exports run as jobs with progress and **Cancel**, sized for
  documents of thousands of pages, and each one is audited as
  `draft.pdf_exported`. **Print / Save as PDF** is now **Print**.
- **Editable chat tables and Transfer.** Tables in chat replies can be edited
  in place (Tab and Enter move between cells; add or delete rows and columns;
  undo), and edits save into the reply. **Transfer to Drafts** asks for a Word
  document, slide deck, or spreadsheet and suggests one; a spreadsheet
  transfer puts each table on its own sheet with a frozen header.
- **Live work trace.** A reply's work trace reveals its steps one at a time
  while it runs, and the thinking row becomes **Thought for Ns** in place.
- **Phones.** Every screen fits an iPhone: no sideways scrolling or page
  zoom-out from wide tables or long links, larger touch targets, a fixed app
  bar on console pages, no iOS zoom when a field takes focus, and the
  selection toolbar below the highlight on touch screens.
- **Clean titles and menus.** AI-written chat and draft titles no longer show
  markdown, search snippets drop stray headings, and the remaining native
  dropdowns use the platform's themed select.
- One database migration, `20261029_0028`, adds the `spreadsheet` draft kind.
  On SQLite it rebuilds the draft tables with foreign keys off so every
  revision is kept; back up the data volume before upgrading as usual.
- The API image now includes Chromium's headless shell and metric-compatible
  fonts (Liberation, Carlito, Caladea, Noto Color Emoji) for the PDF export,
  so it is larger. Very long PDF exports need roughly 2–4 GB of memory.
  Optional settings: `APERTURE_DRAFT_PDF_EXPORT_SOURCE_MAX_MB`,
  `APERTURE_DRAFT_PDF_EXPORT_CONCURRENCY`, `APERTURE_DRAFT_PDF_EXPORT_QUEUE_MAX`,
  `APERTURE_DRAFT_PDF_EXPORT_TIMEOUT_SECONDS`, and
  `APERTURE_DRAFT_PDF_EXPORT_RETENTION_MINUTES`. Upgrading from v0.5.16
  changes both the API and web images.
- API and web images publish as `v0.5.18-dev`, `v0.5.18-test`, and
  `v0.5.18-main`. Stable `v0.5.18` and `latest` promote inspected test images
  without rebuilding.

## New Since v0.5.15

- **Knowledge that keeps what files carry.** Uploads keep their own
  properties (Office core and custom properties, Microsoft Purview
  sensitivity labels, PDF and email headers, photo EXIF without location),
  and connectors add Box metadata, SharePoint columns, Google Drive
  properties, and iManage profile fields. Properties are searchable and shown
  beside every cited passage. Extraction also keeps Word headers, footers,
  footnotes, and comments, slide speaker notes, PDF reviewer comments and
  filled form fields, and email attachments.
- **Handwriting and pictures.** Scanned pages, stamps, and handwriting are
  read by the workspace's best image-capable model (for example Gemini Flash
  on OpenRouter or GPT-4.1 on Azure AI Foundry), metered as `knowledge-ocr`,
  with Tesseract as the fallback. Each knowledge base can switch this off to
  keep pages on the server.
- **Ethical walls.** A file whose metadata has an **Ethical wall** or
  **Information barrier** field naming a group is limited to that group's
  members, administrators and platform owners included; administrators can
  also set a wall per document. A wall naming no known group admits nobody.
- **Web sites, not just pages.** Adding a web page can bring in the linked
  pages of the same site (robots.txt and sign-in pages respected, up to 100
  pages), cite each exact page, and, when a question needs a page that was
  not read up front, look it up on that site live (its links and its own
  search box) and cite it without storing it.
- **Code in chat.** Code blocks are colored with highlight.js, can be edited
  in place and saved into the message, and offer **AI edit** on a highlighted
  selection with a line-by-line review. **Download** names the file from its
  contents, and HTML previews open in a canvas at the right edge.
- **Diagrams and work trace.** Structure diagrams gain eight themes,
  connector and corner styles, draggable cards, bendable arrows, per-card
  colors, and **Reset layout**; PNG, Word, and Drafts exports keep the font
  chat used. A work trace shows what a reply is doing while it streams.
- **Decks and Drafts.** Decks gain seven theme designs and statement,
  big-number, and picture-with-bullets layouts. The Export panel starts with
  **Save your edits first** when edits are unsaved, one save status sits
  beside **Insert** in both document and deck toolbars, and the visual
  redline is restyled and draws fill-in blanks as lines.
- **Carved controls.** Dropdowns, code blocks, and the Transfer to Drafts
  button use the carved tactile style, and dark-mode wells are deeper.
- Fixes: Word export downloads the document when the browser or desktop host
  refuses file-system access instead of leaving an empty file, a saved
  version no longer reads **Editing** right after saving, and inline AI
  edits keep blank lines.
- No database migrations. Optional settings:
  `APERTURE_KNOWLEDGE_VISION_OCR_ENABLED` (default on),
  `APERTURE_KNOWLEDGE_VISION_OCR_MAX_PAGES`,
  `APERTURE_KNOWLEDGE_VISION_OCR_CONCURRENCY`, and
  `APERTURE_KNOWLEDGE_VISION_OCR_MODEL`. Upgrading from v0.5.15 changes both
  the API and web images.
- API and web images publish as `v0.5.16-dev`, `v0.5.16-test`, and
  `v0.5.16-main`. Stable `v0.5.16` and `latest` promote inspected test images
  without rebuilding.

## New Since v0.5.14

- **Optional WorkOS sign-in with your own account.** Single sign-on can now
  run through WorkOS AuthKit: choose **Protocol › WorkOS AuthKit** in
  **Platform console › Org Settings › Single Sign-On** (or **Identity
  provider › WorkOS (AuthKit)** in **Admin console › SSO**) and enter your
  own WorkOS client ID and API key, plus an optional organization ID. The
  sign-in screen shows **Sign in with WorkOS**, the typed email prefills the
  WorkOS page, **Test connection** checks the key, client ID, and
  organization with WorkOS, and WorkOS role slugs map to workspace groups.
  The code is redeemed server side with PKCE and the WorkOS access token is
  verified before the usual domain, provisioning, MFA, and enforcement rules
  apply. Nothing is shared: every deployment uses its own WorkOS account, and
  a deployment that never saves WorkOS keys never contacts WorkOS. Setup and
  design are in `docs/WORKOS_SSO.md`.
- **Training for the current interface.** Every walkthrough in Help and in
  the consoles' Documentation was recaptured from the current interface:
  the warm light palette, tactile buttons and toggles, and the Aperture Chat
  wordmark and icon. The library now holds 65 lessons and 704 scenes (about
  170 minutes); 31 narration tracks were regenerated and checked against
  their scripts with speech recognition.
- **Nine new lessons.** Users: **Report a problem and follow it up**,
  **Hand a chat request to Drafts**, **Open a Word or PDF file and keep its
  formatting**, **Start from a template and set the page layout**, and
  **Edit slides: layouts, pictures, and text**. Administrators: **Manage
  workspace connectors** and **Work reported problems in Reports**. Platform
  owners: **Share reports with the Aperture Chat maintainers** and **Single
  sign-on with WorkOS**.
- **Lessons that follow the current layout.** Connector setup is taught in
  **Admin console › Connections**, and the owner lesson is now **Policies,
  budget, and the connector ceiling** (Off for all / Allow all). Branding
  teaches the separate Logo and Icon cards; the deck lesson teaches the slide
  panel and fit check; knowledge, tools, agents, groups, policies, SSO, and
  alerts lessons show the current locks, permissions, and templates.
- **Guides.** The User, Administrator, and Platform Owner PDFs are
  regenerated with sections for every new lesson (including **Single
  sign-on: WorkOS AuthKit with your own account**), the current tab counts and
  permissions, and the shipped icon on the cover. The README screenshots and
  product tour show the current interface.
- Fixes: bold text in an automation's run output no longer renders as
  separate headings, the Tools library's MCP Servers and Prompt Library
  notices point to **Admin console › Connections › Connectors**, and new SSO
  configurations keep the display name you type.
- No database migrations. WorkOS needs no environment variables: owners
  enter their keys in Single Sign-On. `APERTURE_WORKOS_API_BASE_URL` exists
  only to point tests at the WorkOS emulator. Upgrading from v0.5.14 changes
  both the API and web images.
- API and web images publish as `v0.5.15-dev`, `v0.5.15-test`, and
  `v0.5.15-main`. Stable `v0.5.15` and `latest` promote inspected test images
  without rebuilding.

## New Since v0.5.13

- **Problem reports become support tickets.** **Help › Report a problem**
  files a problem, idea, question, feedback, or security concern with an
  optional screenshot (choose, paste, drop, or capture the screen) and
  opt-in technical details that show exactly what they add. Each
  organization numbers its tickets, and the reporter's unfinished draft
  survives closing the drawer.
- **A Reports tab to work them.** Admins (in the Admin console) and owners
  (in the Platform console) set status, priority, type, and assignee, reply
  publicly, add internal notes reporters never see, and filter to **Needs
  reply**. Tenant admins see only the people they administer. Every change is
  audited under `support.*`, and the new **Support-reports template** in
  **Alerts** emails admins about new tickets, replies, and reopens.
- **Reporters follow their tickets.** **Help › My reports** shows public
  replies, status changes, and GitHub progress, with a dot on **Help** for
  news. Reporters can reply while a ticket is open and reopen it once it is
  resolved or closed. With SMTP configured they are also emailed.
- **Optional sharing with the maintainers.** Owners can send a redacted copy
  of a ticket to the community hub, which files it as a GitHub issue on the
  project repository and reports its status back, so no deployment needs a
  GitHub token. **Review each report** is the default: nothing leaves until
  an owner reviews and sends it. **Share automatically** and **Off** are in
  **Platform console › Reports › Settings**. Personal data, people and
  organization names, private hostnames, and token-like strings are replaced
  with placeholders before sending; security concerns and screenshots never
  leave. See [Support tickets](SUPPORT_TICKETS.md).
- **Write in Drafts from chat.** When a chat message asks for a document or a
  slide deck, an inline card offers **Write in Drafts** or **Continue in
  chat**. Drafts starts the document or deck with the same model, web,
  knowledge, files, and earlier conversation, with no retyping.
- **Inline AI edits keep the formatting.** When an instruction does not ask
  for a new look or shape, such as "fill the blank lines", only the changed
  words are written back into the original text, so tab stops, underlines,
  and blank-line fields from imported Word documents survive. The **Edit with
  AI** composer follows the workspace accent.
- **Tactile controls.** Buttons and toggles across the platform share the
  Drafts Document/Deck rail style: choices sit in a recessed track with the
  selected one lit, primary actions are lit keys, and everyday buttons press
  in. Panels, menus, and dialogs have crisp edges. Layout is unchanged.
- Fixes: Drafts with a long, request-derived title no longer stay **Local
  only — server save failed** (titles are clamped to the 240-character
  limit, and subjects stop at the first sentence); Word exports with long
  titles no longer save as empty files from Chrome's save picker; a reply a
  provider withholds with its content filter is reported as an error that
  names the provider instead of being saved as the document; and history
  papers are no longer formatted as legal instruments.
- New setting: `APERTURE_SUPPORT_HUB_URL` (default
  `https://chat.aperturechat.com`) names the community hub. Leave it blank to
  turn hub sharing off; nothing is sent while sharing is in review mode until
  an owner approves a report.
- Database migration `20261021_0027` adds the ticket fields, ticket timeline,
  hub link, support settings, and hub intake queue. Existing reports become
  **Received** tickets marked as seen. Back up the data volume before
  upgrading; rolling back to v0.5.13 needs that backup as well as the older
  images.
- Training videos and guide PDFs show the earlier report form and control
  style until the next training recapture.
- API and web images publish as `v0.5.14-dev`, `v0.5.14-test`, and
  `v0.5.14-main`. Stable `v0.5.14` and `latest` promote inspected test images
  without rebuilding.

## New Since v0.5.12

- **Connectors move to Admin → Connections.** Workspace admins manage their
  own workspace's connectors there (the switch, credentials, Test, and the
  Google Drive workspace sign-in), and platform owners use the same panel.
  The Connectors panel is no longer in **Platform → Org Settings**.
- **Hide a cloud source without turning it off.** Each of Google Drive,
  OneDrive / SharePoint, Box, and iManage has a **Hide** button that takes it
  out of the chat and Drafts attach menus for that workspace. Knowledge sync
  keeps working on its credentials, and the cloud attachment API refuses a
  hidden source. When every source is hidden, the attach menu drops its
  "Attach from source" heading.
- **The owner keeps the deployment ceiling.** Turning a connector off in the
  platform catalog still turns it off for every workspace: tenant admins see
  "Off for all workspaces" and cannot reopen it, and owners get an **Off for
  all / Allow all** control on each row. Web search, MCP, and Prompt Library
  switches are read per workspace everywhere, including the OpenAI-compatible
  `/v1` routes and automation steps.
- **Risky self-service is off for regular users by default.** Adding their
  own MCP connections (**Can build tools**), API sources (the new **Can add
  API sources** grant, which also needs **Can build knowledge bases**), and
  Hermes agents and connections (**Can use Hermes companion**) stay off for
  standard users until a tenant admin grants them per group. Ungranted
  controls are shown locked with an explanation. MCP connections shared by
  admins stay usable, and admins and owners keep Hermes access to build and
  test profiles. Revoking API sources pauses their refreshes and keeps what
  was already indexed.
- **Tighter boundaries.** A user's own knowledge base can no longer sync
  through a workspace connector's account; custom script tools, including
  test runs, are admin-only, and a standard user's older script can be paused
  or renamed but only an admin turns it back on; Hermes memory authors see
  and delete only memories from their own chats, and a private Hermes profile
  keeps what it learns as its own memories instead of tenant-wide skills.
- Fixes: editing an automation's steps no longer returns a 500 error.
- No database migrations. The connector `hidden` flag and the
  `api_source_authoring` group permission are forward-only: an older image
  rejects records that contain them, so rolling back to v0.5.12 needs the data
  volume backup taken before the upgrade as well as the older images.
- The owner "Policies, budget, and connectors" lesson and the admin
  Connections lesson still show connectors under Org Settings until the next
  training recapture.
- API and web images publish as `v0.5.13-dev`, `v0.5.13-test`, and
  `v0.5.13-main`. Stable `v0.5.13` and `latest` promote inspected test images
  without rebuilding.

## New Since v0.5.11

- **Deck panels slide out from the left.** In the Drafts deck editor, **Add
  slide**, **Change layout**, **Slide picture**, and **Edit slide with AI**
  open as one panel along the editor's left edge instead of popping up from
  the bottom. Each has a close button and closes on Escape, the slide moves
  over so it stays in view, the panel's width can be dragged and is
  remembered, and on phones the panel fills the screen. The layout gallery
  shows live previews with jump buttons for each group. Themes, brand
  templates, deck starters, and slide backgrounds are unchanged.
- **Slide text formatting toolbar.** Clicking into slide text shows a small
  toolbar above the box: Ask AI, font size steps and a size list, bold,
  italic, underline, strikethrough, theme colors, list level, and clear
  formatting. Highlighted text formats only that text; with nothing
  highlighted the whole box is formatted. Shift+Cmd/Ctrl+> and < step the
  size, Alt+F10 moves into the toolbar, and the toolbar warns when text no
  longer fits its box. Formatting carries into the PowerPoint export.
- **Slide pictures.** The picture panel previews the picture in its slide,
  takes uploads, drag and drop, or a description to search the web with
  and choose from the results, and has editable alt text that is exported to
  PowerPoint. A slide whose layout has no picture is offered layouts with a
  picture that keep its text.
- **Text shrinks to fit, and AI decks check their own fit.** A text box that
  holds more than it can show shrinks its text on the slide, and the
  PowerPoint export opens with the same shrink. After the AI writes or revises
  a deck, and before an **Edit slide with AI** suggestion is shown, every box
  is measured the way the editor and export draw it; overflowing slides go
  back to the model with what is too large (at most two rounds, kept only when
  they measure better). Deck prompts now state each box's capacity, and every
  deck prompt is kept free of long-document instructions.
- **Open in editor keeps Word and PDF formatting.** A Word or PDF file opened
  as a draft keeps its paper size, margins, fonts and sizes, line and
  paragraph spacing, alignment, indents, tab stops, tables, lists, and its
  headers, footers, and page numbers, including a different first page. Word
  files are read in the browser. PDFs are converted by the new authenticated
  `POST /api/drafts/document-import/pdf` route, which stores nothing and is
  capped at `APERTURE_DOCUMENT_IMPORT_UPLOAD_MAX_MB` (default 40). Headers and
  footers are drawn on every page of the editor, and the Word download and
  print use the document's own page setup.
- **Real document templates.** Drafts templates are set in proper formats
  (legal agreement, letter, memorandum, court filing, business report,
  academic paper, screenplay, and standard document) with numbered clauses,
  signature blocks, and exhibits where they belong. **Legal Contract** is now
  a complete services agreement, and **Mutual NDA** and **Contract
  Amendment** are new. Choosing a template on a blank draft places it;
  choosing one on an existing draft restyles its layout without changing its
  text.
- **Layout in plain English.** Asking the assistant for a layout such as
  "Times New Roman 12 pt, double spaced, 1-inch margins, page numbers at the
  bottom center" sets the page exactly. A request that asks only for layout is
  applied in the editor without a model call.
- **Platform Branding takes a separate logo and icon.** **Platform → Org
  Settings → Platform Branding** has Logo and Icon cards (upload, drop, or an
  https URL, and Remove). Full-width spaces show the logo; the browser tab,
  collapsed sidebar, and home-screen install icon show the icon. Wide art is
  never squeezed into an icon, and the platform name is optional so a logo
  that contains the name can stand alone.
- **New default Aperture Chat wordmark and icon** for the sidebar, sign-in,
  favicon, and install icons, and a warmer single-tone light palette. Dark
  mode is unchanged. Existing uploaded branding is kept.
- Fixes: a Markdown line of four or more underscores is a fill-in line, not a
  page break; `###` headings keep their level; template matching uses whole
  words; signature lines follow margin changes; pages no longer keep
  repaginating after edits; Word exports no longer end with a blank page after
  a final table; editing a bulleted slide box keeps its bullets and levels;
  and PDF processing is serialized so knowledge OCR and PDF imports cannot
  crash each other.
- No database migrations and no deck or draft schema change. Draft saves now
  accept table column widths and the spacing, border, and indent styles that
  imported documents carry; rolling the API back to v0.5.11 would make stored
  draft revisions that contain them fail its content check.
- Training videos, PDF guides, and README screenshots still show the previous
  deck panels and logo; they are recaptured separately.
- API and web images publish as `v0.5.12-dev`, `v0.5.12-test`, and
  `v0.5.12-main`. Stable `v0.5.12` and `latest` promote inspected test images
  without rebuilding.

## New Since v0.5.10

- **Diagrams render reliably everywhere.** Chat, hover previews, Drafts,
  automation output, and drafts created by automations now make the same
  decision about every diagram block, so a diagram that draws in chat draws
  the same way after **Transfer to Drafts**, export, or reload.
- Diagrams the model writes in other notations are drawn instead of shown as
  code: Graphviz (`dot`), PlantUML, arrow chains (`A → B → C`), numbered
  **Layer**/**Step** lists, and box-drawing art are converted to Mermaid.
  Mermaid sources are normalized before rendering (model `%%{init}%%` and
  theme directives are dropped and `classDef` colors map to the palette by
  meaning), and common syntax mistakes are repaired only when Mermaid rejects
  the original.
- **One visual theme** for Mermaid charts, structure charts, timelines, mind
  maps, and fallbacks, in light and dark mode. Timelines and mind maps use
  Aperture's own renderers, which keep every word of each label (Mermaid's
  mind map dropped words before parentheses and misplaced text).
- **Drafts keep their diagrams.** Saving a draft preserves diagram figures and
  their source, so a diagram can still be edited later; edits to a converted
  drawing are saved back as Mermaid. Drafts created by automations turn
  diagram blocks into diagrams when they open. Diagram images are drawn at 2×
  for sharp print and Word export, and converting a draft to slides carries
  rendered diagrams as image slides.
- Automation run output renders formatting, tables, and diagrams the way the
  chat it is delivered to does, instead of plain text.
- Models are told to draw every visual as a structure chart or Mermaid block,
  never as text, and not to append JSON or YAML metadata blocks to prose
  answers unless asked.
- Code and diagram toolbars use the interface font again (they had fallen back
  to the monospace font).
- No database migrations. Draft saves now accept `figure` and `figcaption`
  with validated `data-diagram-*` attributes; rolling the API back to an
  earlier release would make stored draft revisions that contain diagram
  figures fail its content check.
- API and web images publish as `v0.5.11-dev`, `v0.5.11-test`, and
  `v0.5.11-main`. Stable `v0.5.11` and `latest` promote inspected test images
  without rebuilding.

## New Since v0.5.9

- **Personal Data Protection** (**Admin → Policies**) conceals Social Security
  numbers, card and bank numbers, contact details, health identifiers, secrets,
  and other personal data in chats, model replies, User Prompt Activity,
  feedback, alerts, tags, memories, search, and the Elastic export. Each value
  becomes a typed placeholder such as `⟦SSN⟧`. **Hide values from the model
  too** also conceals prompts and attached file text before the provider call.
  Detection runs inside the deployment and uses checksums (Luhn, SSA ranges,
  ABA, IBAN, VIN) to reject look-alikes. Off by default.
- **Training Datasets** (**Admin → Datasets**) captures de-identified ratings
  and corrections, routes them by practice area, department, and kind of work,
  and lets administrators review examples and download `sft`, `preference`,
  or `kto` JSONL bundles for fine-tuning an open-weight model. Sensitive chats
  and excluded groups are never captured, and examples follow their chat
  through deletion and retention. Off by default.
- **Hardening:** the PII/HIPAA content-filter preset adds ITIN, passport,
  driver's license, Medicare MBI, VIN, address, and IP rules; card and routing
  rules are checksum-verified; filters match through zero-width and full-width
  evasion; attached file text is now screened by input filters; streamed
  `/v1/chat/completions` responses pass output filters; and memory refuses
  identity, financial, health, and credential data.
  See `docs/PRIVACY_AND_TRAINING_DATA.md`.
- **Training** is rebuilt so every one of the 53 lessons runs a complete loop,
  from the first click to a visible result, and covers every path the product
  offers. Each lesson now has a written guide beside the video with **Before
  you begin**, **Step by step**, **Check it worked**, and **Troubleshooting**
  tabs, instruction cards for steps outside the product, and the libraries are
  grouped into curriculum tracks. All narration and about 450 frames are new.
- **Single sign-on** training becomes a five-lesson track: an end-to-end setup
  against a real identity provider, **Microsoft Entra ID**, **Okta**, and
  **Google Workspace** with the built-in presets, and a go-live lesson that
  maps groups, enforces SSO, and shows the expected refusals.
- Three new lessons teach the privacy features: **Protect personal data** and
  **Build training datasets from ratings and corrections** for administrators,
  and **Personal data in your chats** for users (56 lessons in total).
- The user, administrator, and owner guides are regenerated with each lesson's
  written procedure (78, 124, and 178 pages). `docs/TRAINING.md` documents the
  training methodology.
- **SSO fixes:** the SSO panel now shows an absolute redirect URI in
  same-origin deployments (it previously showed a relative path that identity
  providers reject), and the OIDC token exchange prefers
  `client_secret_basic`, retrying once with `client_secret_post` when the
  provider answers `invalid_client`. Okta apps configured for basic
  authentication now complete sign-in.
- This release adds one database migration (`20261004_0026`, personal data
  policies, training datasets, and training examples). Back up the complete
  application data volume before upgrading.
- API and web images publish as `v0.5.10-dev`, `v0.5.10-test`, and
  `v0.5.10-main`. Stable `v0.5.10` and `latest` promote inspected test images
  without rebuilding.

## New Since v0.5.8

- **Elastic Analytics** moves from server-only settings to **Platform → Org
  Settings → Elastic Analytics**: an endpoint or Elastic Cloud ID, a vaulted
  API key, and an index prefix, with **Save and check**, connection checks,
  **Sync now**, and **Re-send everything**. The export now sends five streams
  (audit, usage, chats with their messages, uploaded documents, and users).
  Tags, legal holds, archiving, matters, and retention state stay current, and
  deleted chats and users are flagged rather than erased. The
  `APERTURE_ELASTIC_URL`, new `APERTURE_ELASTIC_CLOUD_ID`, and
  `APERTURE_ELASTIC_API_KEY` server values remain fallbacks for blank fields.
- **Alerts** can email on chosen prompt detections. A **Prompt-injection
  template** and an **Only these detections** filter target one detector,
  rules that could never fire are rejected, and emails name the detection
  without including the flagged text. SMTP now verifies the relay's TLS
  certificate, adds `Date` and `Message-ID` headers, and retries failed
  deliveries with backoff. `/v1/responses` prompts are scanned like chat
  prompts, and **Send test email** waits until SMTP edits are saved.
- **Audit** dashboards for administrators and owners group signals by what
  needs attention, add **Audit Insights** trend charts, and open the matching
  records from any chart mark or signal row.
- **Drafts**: the paperclip's **From this device** menu adds **Open in
  editor**, which opens a Word, Markdown, or text file as the document or a
  PowerPoint file as the deck.
- Training adds the owner **Elastic Analytics export** lesson and refreshes the
  owner and administrator audit and alert lessons and the **Draft documents**
  lesson, with new narration and screenshots. The user, administrator, and
  owner guides are regenerated.
- This release adds one database migration (`20261002_0025`, Elastic export
  stream cursors). Back up the complete application data volume before
  upgrading.
- API and web images publish as `v0.5.9-dev`, `v0.5.9-test`, and `v0.5.9-main`.
  Stable `v0.5.9` and `latest` promote inspected test images without rebuilding.

## New Since v0.5.7

- **Session details** (ⓘ in a chat's top bar) now ends with a **Symbol
  shortcuts** list of the five characters you can type in the message box
  and what each one pulls in: `/` prompts and MCP connections, `@` agents,
  `#` knowledge bases and files, `$` skill files, and `>` automations.
- **Chat Feedback** rows in the administrator and owner consoles show the
  reply as readable text. Markdown, HTML tags and entities, and math source
  are flattened (for example, `E=mc^2` reads as E=mc²).
- The **Composer symbol shortcuts** lesson is renamed **Symbol shortcuts:
  / @ # $ >** and grows from four scenes to seven, one per symbol menu plus
  the Resources browser. **Session details and context** gains a scene for
  the new list. Both are re-narrated with new screenshots, and the user,
  administrator, and owner guides describe what each symbol menu does.
- This release adds no database migrations. Back up the complete application
  data volume before upgrading as usual.
- API and web images publish as `v0.5.8-dev`, `v0.5.8-test`, and `v0.5.8-main`.
  Stable `v0.5.8` and `latest` promote inspected test images without rebuilding.

## New Since v0.5.6

- Drafts has one **Edit with AI** composer for documents and slides. Select
  text and choose **Ask AI** (or press Ctrl/⌘+J) to rewrite a passage, or
  place the cursor to write new text there. Actions, tones, translations, or a
  typed instruction stream a suggestion you review as **Changes** or
  **Result** before choosing **Replace**, **Insert below**, **Try again**, or
  **Discard**; follow-up instructions refine the same suggestion. Nothing
  reaches the page until you accept it, and accepted edits appear in the AI
  edit trail.
- In decks, **Edit slide with AI** rewrites a whole slide (improve, punchier,
  shorter, speaker notes, better layout, split into two, spelling, tone, or
  translation) and shows before/after thumbnails before **Apply to slide**.
- The document editor adds a floating selection toolbar, a `/` command menu,
  Markdown shortcuts, find and replace, a heading outline, and a status bar
  with page, word, character, and reading-time counts and zoom from 50% to
  200%. Tables and pictures get their own toolbars; picture size and
  alignment carry into Word export. Pasted content keeps its structure but
  drops the source's fonts and colors, and heading sizes now step down
  properly from Heading 1 to Heading 3. A keyboard shortcut list opens from
  the status bar.
- The deck editor adds a **Layouts** and **Themes** strip above the slide,
  a **Deck starters & brand themes** drawer, a slide sorter, snapping guides
  for text boxes, and **Presenter view** with a timer, next slide, and notes.
- The Drafts assistant rail shows a status line, context chips, and starter
  requests, with **Document history** at its top. On narrower screens it
  becomes a drawer that opens from a pull tab on its edge. History entries
  show whether each item is a document or a deck.
- Fixed: asking AI to edit a passage near words like "source" or "current"
  no longer forces a web search, which had caused errors and repeated
  retries.
- The **Draft documents**, **Build a slide deck**, and **Save, organize, and
  recover your drafts** lessons are re-narrated with new screenshots, and the
  user, administrator, and owner guides and README images are refreshed. The
  deck AI image frame still shows the earlier toolbar.
- This release adds no database migrations. Back up the complete application
  data volume before upgrading as usual.
- API and web images publish as `v0.5.7-dev`, `v0.5.7-test`, and `v0.5.7-main`.
  Stable `v0.5.7` and `latest` promote inspected test images without rebuilding.

## New Since v0.5.5

- The sign-in screen is simpler. Under the Sign in button there is one
  "Trouble signing in?" link and a "New to <workspace>?" section with a
  full-width Request access button, replacing the old "Need an account?" row,
  which looked clickable but was not, and a separate help block. The screen
  also gets a softer backdrop and brand accents, and the access request form
  wording is fixed.
- The access and sign-in walkthrough now starts on the sign-in page, with new
  scenes for opening the workspace address and finding Request access. Its
  narration and screenshots are refreshed, along with the README sign-in image.
- Aperture Chat is now released under the MIT License (replacing the Aperture
  Chat Community Source License 1.1), and `NOTICE.md` is no longer part of the
  release bundle. `SECURITY.md` lists a direct security contact email.
- This release adds no database migrations. Back up the complete application
  data volume before upgrading as usual.
- API and web images publish as `v0.5.6-dev`, `v0.5.6-test`, and `v0.5.6-main`.
  Stable `v0.5.6` and `latest` promote inspected test images without rebuilding.

## New Since v0.5.4

- Agents and Automations are redesigned. Agent cards show the model, who can
  use the agent, attached knowledge and tools, and a readiness check. Start
  from a template, duplicate, search, and filter. New agents no longer start
  with knowledge, templates, or skills pre-attached.
- An automation step that uses an agent now applies that agent's instructions,
  skills, and knowledge (agent tools remain chat-only). Results are delivered
  to a new chat or a new draft, and every run, including Run now, is recorded
  in a run history of the last 10 runs.
- Each schedule has its own time zone and a live preview of its next runs.
  Invalid cron expressions are rejected when an automation is saved or enabled
  instead of silently never firing, and a scheduled automation pauses itself
  after three failed runs in a row.
- Library Knowledge and Tools share the Agents design. A knowledge base can
  combine uploaded files, web pages, and API sources (GET or POST with an
  optional credential or provider sign-in). Sync re-fetches web pages and API
  sources and leaves uploaded files untouched; API requests pass the outbound
  guards and refuse redirects so credentials never follow them.
- Uploads become keyword-searchable as soon as their text is extracted, and a
  background worker adds semantic vectors afterwards. The Library shows
  indexing progress and upload limits, and scanned pages are OCR'd in parallel.
  Optional settings: `APERTURE_KNOWLEDGE_DENSE_BACKGROUND`,
  `APERTURE_KNOWLEDGE_EMBEDDING_THREADS` (now defaults to half the CPU cores,
  between 2 and 4), and `APERTURE_KNOWLEDGE_OCR_WORKERS`.
- MCP connections are tested before they are saved, and a saved access token
  can be cleared. Changing a local (stdio) server's launch command stays
  platform-owner-only. Chat sends only the tools the current user may run, so
  one restricted tool no longer fails a whole Agent-mode reply.
- Refreshed README screenshots and product tour for the current interface.
- This release adds no database migrations. Back up the complete application
  data volume before upgrading as usual.
- API and web images publish as `v0.5.5-dev`, `v0.5.5-test`, and `v0.5.5-main`.
  Stable `v0.5.5` and `latest` promote inspected test images without rebuilding.

## New Since v0.5.3

- The sidebar is simpler: Search sits under New chat, Agents and Library have
  their own entries, and chat history lives under a CHATS heading that each
  person can hide. A single More actions menu on each chat pins, moves, or
  archives it. Console links, Help, and the theme buttons sit at the bottom.
- Unread markers follow a read position saved with each account, so chats read
  in one browser no longer appear unread in another.
- Release-update notices remain visible only to platform owners. The admin
  role picker matches the rest of the console.
- Refreshed user, administrator, and owner training screens, narration, and
  downloadable PDF guides for the new sidebar.
- Back up the complete application data volume before upgrading. This release
  adds the chat read-position migration, which marks existing chats as read
  through their latest message. Image rollback does not undo migrations.
- API and web images publish as `v0.5.4-dev`, `v0.5.4-test`, and `v0.5.4-main`.
  Stable `v0.5.4` and `latest` promote inspected test images without rebuilding.

## New Since v0.5.2

- Added tenant-scoped chat retention governance with previewed policies, explicit
  enablement, classification review, named legal holds, and scheduled cleanup.
  Existing installations keep automatic deletion disabled until an administrator
  enables it; Forever and legal holds take precedence over automatic deletion.
- Added an atomic deletion ledger so stale workspace saves cannot restore deleted
  conversations, while retaining uploads referenced by surviving chats.
- Refined the owner and admin consoles, retention navigation, search-index controls,
  and first-run routing; removed the redundant platform setup wizard.
- Refreshed user, administrator, and owner training decks, narration, screenshots,
  and downloadable PDF guides for the current application.
- Includes all v0.5.2 drafting, model-access, search, and workspace improvements
  listed below, which were previously available on the development branch.
- Back up the complete application data volume before upgrading. This release
  includes the retention deletion-ledger migration, plus the v0.5.2 migrations
  when upgrading from v0.5.1. Image rollback does not undo database migrations.
- API and web images publish as `v0.5.3-dev`, `v0.5.3-test`, and `v0.5.3-main`.
  Stable `v0.5.3` and `latest` promote inspected test images without rebuilding.
  See [retention scope and behavior](RETENTION.md) before enabling cleanup.

## New Since v0.5.1

- Draft history reliably opens saved documents and decks, with visible loading
  and retry states. Restored documents automatically rebuild page breaks and
  show page counts outside the editable body; generated page labels are removed.
- Deck editing offers more starting layouts and theme previews while preserving
  slide content. Model favorites and selection controls fit the drafting rail.
- Local-work reminders can be cleared without deleting drafts or chats, or hidden
  for an account in a browser. Archived drafts leave the reminder list.
- Model access explanations, request tracking, and administrator decisions make
  provider and policy restrictions easier to understand without bypassing them.
- A guided platform setup view, persistent workspace routes, and searchable
  commands improve navigation and configuration.
- A tenant-scoped relational search index supports global search and owner
  rebuild/status controls while retaining live-record authorization checks.
- Document and deck storage, model-access requests, and the search index add
  database migrations. Back up the complete application data before upgrading.
  The SQLite deck migration preserves existing draft revisions; schema rollback
  and image rollback do not restore data that was lost before this fix.
- API and web images publish as `v0.5.2-dev`, `v0.5.2-test`, and `v0.5.2-main`.
  Stable `v0.5.2` and `latest` promote the inspected test images without rebuilding.

## New Since v0.5.0

- Optional theme schedules switch between light and dark mode at the times
  chosen by each user. The schedule control shares the existing theme row.
- Dictation uses a faster transcription path and avoids repeated model discovery
  on each recording, reducing the delay after stopping.
- Send options brings reply settings and searchable resources into one compact
  menu. MCP connections have one selection state and one summary, with clear
  in-chat shortcut guidance and layouts that fit phone screens and keyboards.
- The mobile composer places attachment and active-tool controls together,
  keeping the full toolbar on one row when space permits.
- Model favorites stay available on each row, search previews render safe
  Markdown, and theme changes honor reduced-motion preferences.
- Access and sign-in guidance is available before login without discarding the
  access request form. The signed-in Help playlist begins with chat guidance.
- API and web images are published as `v0.5.1-dev`, `v0.5.1-test`, and
  `v0.5.1-main`; stable `v0.5.1` promotes the inspected test image pair.
- No new database migrations are introduced in this patch release.

## New Since v0.4.7

- Version 0.5.0 brings the latest workspace, training, document, and slide-deck
  changes into one release, including MLA layout, cleaner reference styling,
  draft history preview/archive/delete, and compact formatting controls.
- Section switches use a shared sliding indicator and stable positioning.
  Mobile switches, status labels, user actions, model search, and prompt
  dialogs now fit compact screens; chat tools have a dedicated chip row.
- Training videos offer an explicit fullscreen control and expand when a
  phone rotates to landscape, with an in-page fallback when native fullscreen
  is unavailable.
- Each release branch publishes version-qualified API and web image pairs:
  `v0.5.0-dev`, `v0.5.0-test`, and `v0.5.0-main`. Stable `v0.5.0` and `latest`
  are published only after the inspected test build reaches main.
- Draft archive persistence includes migration `20260905_0019_draft_archive`.
  Follow the normal backup and migration procedure when upgrading.

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
[promotion and releases](RELEASING.md) for the full branch and review workflow.
