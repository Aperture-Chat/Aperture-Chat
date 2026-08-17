# Data Retention & Tagging Plan

Status: APPROVED Aug 16 2026; Phase 1 (Foundations) and the Phase 2 core are
implemented and live on the dev instance, uncommitted: generic MCP
auto-tagging, a shared RetentionPanel in BOTH consoles (admin Policies tab +
owner Org Settings tab) with full-conversation preview per tagged chat, and
hold-aware batch delete / clock-preserving batch archive (dry-confirm UI,
POST /api/admin/retention/batch). Aug 16 additions: attachment tagging
(`attachment_tagging_enabled`, coarse attachments:document|image tags, with a
legacy-omission backfill in _model_from_payload) and GET
/api/admin/retention/threads listing EVERY tenant chat (tags merged, archived
flag) so batch actions cover untagged chats. Aug 17 restructure: the policy
panel is toggles-only (now including `subject_tagging_enabled` — one LLM
classification per conversation into the curated SUBJECT_TAXONOMY in
core/retention.py, via the chat's own model); the chat list moved into the
Audit tab's User Prompt Activity panel as a "Prompts | Tags" sub-tab
(RetentionTagsView: bounded scrollable list, text search, tag-namespace
filter, conversation preview, batch archive/delete). Phase 2 remainder
(manual tagging, external tags import API, sidebar badge) and Phases 3-5 not
started.
Scope owner: Matthew Lopez. This file is the source of truth for scope and
acceptance once approved, following the established plan-file workflow.

## 1. Goal

Give Aperture Chat a records-management capability suitable for law firms and
financial services:

1. **Tagging** — chats carry metadata tags so cohorts can be identified later.
   Tags come from three sources: automatic (a chat used a given MCP connection,
   e.g. Box), external (Purview / Elastic labels passed down), and manual
   (admin applies a tag in the console).
2. **Retention policies** — a tenant-level policy (e.g. 1 / 3 / 7 years) plus
   per-tag rules that make old chats eligible for disposition automatically.
3. **Batch targeted disposition** — admins find tagged/aged chats in the
   console and archive or purge them in bulk, with a dry-run-first workflow.
4. **Legal holds** — holds override every policy; nothing under hold is ever
   disposed.
5. **Single pane of glass** — external classification systems (Purview,
   Elastic) feed tags in; Aperture's rules remain authoritative; disposition
   evidence flows out through the existing audit/Elastic pipeline.

Everything is fail-closed: feature default-off, `0` disables, no matching
rule ⇒ the chat is retained.

## 2. Current state (verified against the codebase, Aug 16 2026)

What already exists and is reused:

- **A retention purge framework already runs** for audit and usage history:
  `PlatformSettings.audit_retention_days` / `usage_retention_days`
  (`services/api/app/models/schemas.py:222-234`), evaluated by
  `services/api/app/core/scheduler.py` (`_active_retention_settings`,
  `_retention_cutoff`, `purge_retained_audit_history`,
  `purge_retained_usage_history`, `RETENTION_PURGE_BATCH_LIMIT = 500`).
  Policy is re-read from SQL every pass; `0` disables; purges are bounded
  oldest-first batches with per-task `try/except`. **Chat retention copies
  this shape.**
- **Matter retention is metadata-only today** — `services/api/app/models/matters.py:99`:
  "Metadata only until A7 retention enforcement." This plan IS that
  enforcement for matter-linked chats.
- **Memory retention** (`TenantMemoryPolicy.retention_days`) is the template
  for a per-tenant policy object, its admin GET/PATCH routes
  (`services/api/app/routes/admin.py:2476-2513`), and the console
  draft/commit numeric editor (`AdminConsole.tsx:6979-7072`).
- **Audit pipeline**: single write path `SeedStore.record_audit`
  (`seed.py:2603`) → `append_audit_with_outbox` (audit row + **Elastic outbox
  row in one transaction**). Severity is derived on read; actions ending in
  `_deleted` are classified as governed deletions for free
  (`core/audit_severity.py:73`). Metadata is redacted; the house rule is
  counts-only, never content.
- **Dry-run precedents**: `db/transfer_database.py` (dry-run default; execute
  requires the dry-run's digest and re-verifies it) and the content-filter
  preview route (`routes/admin.py:1216`).
- **Bulk-delete side-effect pattern**: `purge_a5_user` / `purge_a5_tenant`
  collect doomed attachment ids inside the transaction and unlink preview
  files only after commit (`application_state.py:3366/3469`).
- **MCP**: an MCP server is a `ToolConfig` with `tool_type == "mcp"`
  (`schemas.py:1137`). During completion, `_resolve_runtime_context`
  (`routes/chat.py:4115-4131`) has both `request.thread_id` and the resolved
  MCP servers/tool results (`tool_config_id`, `server_name`, `tool_name`) in
  scope. `_schedule_memory_followup` (`chat.py:4210`) is the
  do-bookkeeping-after-the-response-flushes pattern to copy.
- **Scheduler wiring**: single asyncio loop started in `main.py` lifespan,
  30s interval (floor 5s) — a "nightly" job needs its own last-run watermark
  inside the pass.
- **Mailer**: `core/mailer.py`, SMTP password from the vault; legal callers
  are the scheduler pass and explicit test-send only. (SMTP is unconfigured
  on live — notifications degrade to `logged`, same as alert delivery.)

Gaps this plan must close (all verified):

- **`chat_threads` has no real timestamp.** `updated_at` is a display label
  ("Just now", `orm.py:1039-1041`); there is no `created_at`. The only real
  clock is `ChatMessage.createdAtIso` inside the messages JSON blob.
  Backfill precedent: `seed.py:2735` `_backfill_usage_records`.
- **No tag/label/classification concept exists anywhere** for chats,
  messages, attachments, or users.
- **Threads are client-authored.** `PUT /api/chat/threads/{id}` deletes and
  re-inserts the row from the payload; only `matter_id` is explicitly
  preserved (`application_state.py:1250-1258`). Any new server-owned column
  on `chat_threads` must be carried over the same way — or live in a side
  table, which is immune by construction.
- **`chat_attachments` has no `thread_id`** — the association only exists in
  the messages JSON, so a thread purge cannot find its attachments via SQL.
  `tenant_id`/`owner_user_id` are nullable on attachments (orphans escape
  owner-scoped purges).
- **Preview files leak** on plain thread delete: `delete_attachment_preview`
  is only called from `purge_a5_user`/`purge_a5_tenant`.
- The existing `archived` boolean is **view management only** — archived
  chats are still searched (`routes/search.py`) and never expire. It is not
  a compliance archive and this plan does not overload it.
- Chat attachments never enter the vector store, so chat purge needs no
  vector cleanup — except matter-linked knowledge, which the matter deletion
  job already handles.

## 3. Design

### 3.1 Schema (one Alembic migration, `20260816_0016_chat_retention`, head after `20260807_0015`)

1. **Real timestamps on `chat_threads`**: `created_at` and
   `last_activity_at`, both `UTCDateTime` (`orm.py:66` decorator), nullable
   during backfill then enforced server-set. Backfill from
   `min/max(messages[].createdAtIso)`; threads with no parseable ISO get the
   migration timestamp (honest fallback, recorded in the migration
   docstring). Index `(tenant_id, last_activity_at)`. Server sets
   `last_activity_at` on every thread upsert — never trusted from the client
   payload. The public `updated_at` display string is untouched.
2. **New table `chat_thread_tags`** (side table — client thread PUTs can
   never clobber it): `id`, `tenant_id` (FK, cascade), `thread_id` (FK
   `chat_threads.id`, `ondelete="CASCADE"`), `namespace`
   (`mcp` | `purview` | `elastic` | `manual` | custom), `key`, `value`
   (nullable), `source` (`auto` | `manual` | `external`), `applied_at`
   (UTCDateTime), `applied_by`. Unique `(thread_id, namespace, key)`;
   index `(tenant_id, namespace, key)`.
3. **`chat_attachments.thread_id`** (nullable FK, `ondelete="SET NULL"`),
   backfilled by walking each thread's messages JSON; set going forward when
   an attachment is referenced from a message. This makes "purge a thread and
   its attachments" a SQL join instead of a JSON crawl.
4. **Disposition state on `chat_threads`**: `disposition_state`
   (`NULL` | `'pending'`) + `disposition_pending_since` (UTCDateTime) for the
   grace window. Both must be preserved across the client upsert exactly like
   `matter_id` (three sites: `application_state.py:1250`, `chat.py:377`,
   `chat.py:673`).
5. **Legal holds**: `retention_holds` (`id`, `tenant_id`, `name`, `reason`,
   `created_by`, `created_at`, `released_at` nullable, `released_by`) and
   join table `retention_hold_threads` (`hold_id`, `thread_id`). Membership
   is materialized when the hold is created from a selection/query so it is
   stable and auditable. Disposition predicate: `NOT EXISTS` an active hold.

SQLite deployments require `render_as_batch=True` (already configured in
`alembic/env.py`); `downgrade()` implemented as always in this repo.

### 3.2 Tenant retention policy (new stored model)

`TenantRetentionPolicy`, singleton per tenant, modeled exactly on
`TenantMemoryPolicy`:

- `enabled: bool = False` — master switch.
- `chat_retention_days: int` (`ge=0, le=36_500`, `0` = disabled) — tenant
  default.
- `retention_basis: "last_activity" | "created"` (default `last_activity`).
- `action: "purge" | "archive_then_purge"` (default `purge`).
- `grace_days: int` (default 0 = immediate) — pending window before
  disposition, during which admins are notified and can hold/exempt.
- `notify_admins: bool` — email a counts-only summary when threads enter
  pending (via existing mailer; degrades to logged when SMTP unconfigured).
- `mcp_tagging_enabled: bool = False` — the "devs can easily turn on
  metadata tagging" switch.
- `external_tags_enabled: bool = False` — accept Purview/Elastic imports.
- `rules: list[RetentionRule]` — `{id, tag_namespace, tag_key (optional,
  absent = whole namespace), retention_days, action, note}`.
- `last_swept_at` — the scheduler's daily watermark.

**Resolution semantics (records-management standard, matches Purview):
longest retention wins.** A thread's effective retention =
`max(tenant default, every matching tag rule, matter retention_days when
matter-linked)`, considering only values > 0. Eligible for disposition only
when `basis timestamp + effective retention < now` AND no active hold AND at
least one applicable retention value exists. External labels can therefore
never *shorten* local policy — only extend it.

⚠️ Deployment note (identity-config crash-loop hazard): a new stored model
must go through the full canonical-payload recipe — schema + ORM payload row +
snapshot machinery in `identity_config_sql.py` (5 registration sites) +
`db/import_identity_config.py` (4 sites) + store accessors in `seed.py` —
with `_model_from_payload` backfills so existing DBs don't crash-loop, and a
`compose run --rm` dry-run against a copy of the live DB before deploy.

### 3.3 Tagging engine

- **Auto MCP tagging**: in both completion routes, after the response is
  scheduled to flush (Starlette `BackgroundTasks`, same pattern as
  `_schedule_memory_followup`), gated on `policy.mcp_tagging_enabled`: for
  every entry in `mcp_tool_results`, upsert tag
  `namespace="mcp", key=<tool_config_id>, value=<server_name>`.
  Tag on **any invocation attempt**, not just `status == "ready"` — data may
  have been exposed on any call, and over-inclusion is the safe direction for
  retention. (Citations are explicitly NOT the signal: they are lossy —
  only `ready` results become citations and `_citations_actually_referenced`
  filters them further.) Audit `chat.retention_tag_applied`, counts-only.
- **Manual tagging**: bulk action in the console explorer (below);
  `namespace="manual"`, `source="manual"`, `applied_by` = acting admin.
- **External import**: `POST /api/admin/retention/tags/import` — body is a
  list of `{thread_id, namespace, key, value}` assignments; every thread id
  validated tenant-scoped; whole batch audited with counts. This is the
  landing zone for Purview label pass-down and Elastic-driven selections
  (§3.6). Gated on `external_tags_enabled`.
- Wire exposure: `ChatSession` gains a read-only, server-populated
  `retention_tags` projection (list of `{namespace, key, value}`) for list
  endpoints + bootstrap, ignored on upsert input. UI badge slots already
  exist next to the `used_agent` badge (`AppShell.tsx:651/1402/2375`).

### 3.4 Scheduler disposition job

`sweep_chat_retention(store, settings)` added to `scheduler_pass` in its own
`try/except`, following `purge_retained_audit_history` exactly, plus a daily
watermark (`last_swept_at`) since the pass runs every 30s. Per tenant with an
enabled policy:

1. **Mark stage**: batched query (limit 500, oldest-first by basis
   timestamp) for threads past effective retention, not under hold, not
   already pending → set `disposition_state='pending'`,
   `disposition_pending_since=now`; queue admin notification if configured;
   audit `chat.thread_disposition_pending` (counts + rule ids).
2. **Dispose stage**: threads pending longer than `grace_days` →
   - if `archive_then_purge`: write a gzip JSON bundle
     (thread + messages + attachment metadata + preview files per config
     `archive_include_attachments`, default true) to
     `<data>/chat_archives/<tenant>/<yyyy>/<thread_id>.json.gz` with a
     SHA-256 manifest;
   - hard-delete the thread row, its attachment rows (via new `thread_id`
     join), and unlink preview files **after commit** (the `purge_a5_*`
     collect-then-unlink pattern);
   - audit `chat.thread_retention_deleted` (suffix `_deleted` ⇒ derived
     severity for free) with counts, effective rule, archive digest — never
     content. This audit row is the destruction certificate.

Interplay to enforce in validation/UI: warn when
`audit_retention_days` (if > 0) is shorter than chat retention — otherwise
the platform would eventually purge its own destruction records.

Also in scope here: fix the standing preview-file leak so plain
`DELETE /api/chat/threads/{id}` unlinks previews too.

### 3.5 Console — batch targeted disposition

New **"Data Retention"** tab in `adminTabs` (auto-derives
`value="data-retention"`), mirrored into the owner `PlatformConsole` per the
admin-parity convention. Panels (first open, rest `defaultCollapsed`, all via
the shared `Panel` primitive):

1. **Retention Policy** — policy editor (draft/commit numeric idiom from
   `MemoryAdminPanel`), rules list with AlertRule-style CRUD, and the
   MCP-tagging / external-tags toggles. Locked-state fallback panel when
   platform policy forbids, per the existing `policy-callout` pattern.
2. **Tagged Chats explorer** — `SectionScopeFilter` (user + date range) plus
   tag namespace/key filters. Backing endpoint
   `GET /api/admin/retention/threads` returns metadata-only rows (id, title,
   owner, tags, `last_activity_at`, matter link, hold/pending state) — never
   message content, honoring the counts-only house rule. Multi-select
   checkboxes (the groups bulk-remove pattern) with bulk actions:
   apply/remove tag, place/release hold, archive, purge.
3. **Disposition preview & execute** — dry-run first:
   `POST /api/admin/retention/preview` (a selection or "everything eligible
   now") returns `{count, per-rule breakdown, sample rows, digest}`;
   `POST /api/admin/retention/execute` **requires that digest** and
   re-verifies the selection still matches (the `transfer_database`
   gate), plus the inline two-step "Yes, purge / Cancel" confirm (the memory
   purge idiom — no `window.confirm` in this codebase).
4. **Legal Holds** — list / create-from-selection / release; release is
   audited with actor and reason.
5. **Disposition History** — audit-derived list filtered to retention
   actions, `CsvExportControl` for evidence export.

Frontend plumbing follows the established chain: `types.ts` (snake_case wire
types + `...UpdateRequest = Partial<...>`) → `lib/api/admin.ts` functions →
optional methods on `AdminConsoleApi` → `App.tsx` adapter → panel JSX.
Panels unmount children when collapsed, so fetches live in the console
parent, not the panel body.

### 3.6 Purview / Elastic interop (single pane of glass)

Foundation first, connectors later — the tag namespaces and import API make
external systems first-class without coupling to any of them:

- **Purview inbound**, two realistic paths:
  1. *File-borne labels*: documents fetched through MCP (Box, SharePoint)
     can carry MIP/Purview sensitivity-label metadata. The MCP tagging hook
     inspects structured tool results for known label fields (configurable
     mapping: label GUID/name → `purview:<key>` tag, optionally bound to a
     retention rule).
  2. *Pushed assignments*: a Purview/Graph integration job (external script
     now, packaged connector later) calls the tags-import API.
- **Elastic**: retention tag and disposition audit events already ride the
  existing `append_audit_with_outbox` Elastic outbox — Elastic-side
  dashboards see the full retention lifecycle with zero new plumbing.
  Inbound, an Elastic query's resulting thread ids are pushed through the
  same import API.
- **Authority**: Aperture's rules are always authoritative. External labels
  only add tags; longest-wins resolution means a passed-down label can extend
  but never shorten retention. That is what makes this a safe single pane of
  glass for firms running Purview-first or Elastic-first programs.

### 3.7 Compliance posture (law firm / financial services)

- Fail-closed everywhere: default-off, `0` disables, no-rule ⇒ retained.
- Legal hold is absolute and wins over every rule; holds and releases are
  audited with actor and reason.
- Matter retention becomes enforced as a floor for matter-linked chats
  (closing the "metadata only until A7 retention enforcement" note).
- Defensible disposition: dry-run digest gate, grace window with
  notification, immutable counts-only destruction records, evidence CSV.
- Tenant isolation on every new query and on the import API.
- No message content in audit metadata, admin lists, or notifications.

## 4. Phases

Each phase syncs to the live dev instance for review before any commit, per
the working agreement.

- **Phase 1 — Foundations.** Migration 0016 (timestamps + backfill, tags
  table, `chat_attachments.thread_id` + backfill, disposition columns, holds
  tables), upsert preservation of the new server-owned columns,
  preview-leak fix, `TenantRetentionPolicy` stored model through the full
  canonical-payload recipe, GET/PATCH policy routes. Tests: migration
  backfill (incl. no-ISO fallback), repository CRUD, upsert-preservation,
  crash-loop-safe payload backfill.
- **Phase 2 — Tagging.** MCP auto-tag background task + policy gate, manual
  tagging, external import API, `retention_tags` wire projection + sidebar
  badge, Tagged Chats explorer panel (read-only). Tests: tag-on-invocation
  incl. error results, client-PUT cannot clobber tags, tenant-scope
  validation on import.
- **Phase 3 — Enforcement.** Scheduler sweep (mark → notify → dispose),
  archive bundles, matter-floor + hold predicates, daily watermark.
  Tests mirror `test_a7_retention_scheduler.py` /
  `test_a7_retention_repository.py` (the `_silence_other_scheduler_work`
  harness is directly reusable).
- **Phase 4 — Console disposition.** Policy editor, bulk actions,
  dry-run/execute with digest gate, Legal Holds panel, Disposition History +
  CSV, owner-console parity.
- **Phase 5 — Interop polish.** Purview label-mapping config, MIP metadata
  sniffing in MCP results, packaged import examples, evidence-export
  formats.

## 5. Open decisions (recommendation first)

1. **Retention basis default**: `last_activity` (recommended — an active
   matter thread shouldn't expire under its participants) vs `created`
   (stricter Purview-style "event date" semantics). Both supported; this is
   just the default.
2. **Archive semantics**: export-bundle-then-delete (recommended — the
   existing `archived` flag is view-only and still searched, so it cannot
   serve compliance archiving) vs a cold `archived`-like flag.
3. **UI location**: dedicated "Data Retention" tab (recommended — keeps the
   Audit tab stable and uncluttered) vs new panels inside the Audit tab
   where the annotation was made.
4. **MCP tag granularity**: tag with `tool_config_id` only (recommended;
   server-level, matches "chats that touched Box") vs per-tool-name tags.
5. **Scope of disposition**: chats + their attachments only (recommended;
   usage/audit/memory each already have their own retention knobs) vs also
   cascading to usage records for purged threads.

## 6. Risks & mitigations

- **Backfill cost on large `chat_threads` tables** — batched migration,
  tested against a copy of the live DB (`compose run --rm` dry-run first).
- **Client-authored upsert clobbering server columns** — the delete-and-
  reinsert upsert makes every new projected column a hazard; tags/holds live
  in side tables (immune), timestamps/disposition columns get explicit
  `matter_id`-style preservation with dedicated tests at all three sites.
- **Destroying destruction records** — UI validation warning when audit
  retention < chat retention.
- **SMTP unconfigured on live** — notifications degrade to `logged` status
  like alert deliveries; disposition never blocks on mail.
- **Scheduler cadence** — sweep is watermark-gated to daily; every stage is
  an idempotent bounded batch, safe across restarts (mirrors the leased
  matter-deletion job philosophy without its complexity).
