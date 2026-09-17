"""Extractors and maintenance for the relational search index.

Two maintenance paths keep ``search_index_entries`` current inside the one API
process:

* Write hooks: the chat and draft repositories write their index row in the
  same transaction as the record, so those large SQL collections can never be
  half-indexed.
* Reconcile pass: the small in-memory store collections (agent profiles,
  automations, matters, review grids) are re-derived on every scheduler tick
  and during a backfill, which also prunes rows whose source disappeared.

Nothing here decides authorization; it only derives searchable text.
"""

from __future__ import annotations

import logging
import re
from datetime import UTC, datetime
from html import unescape
from typing import TYPE_CHECKING

from sqlalchemy import select

from app.core import clock
from app.core.policy import is_workspace_agent_profile
from app.db.orm import DraftDocumentRow, DraftRevisionRow
from app.models.deck_document import deck_plain_text
from app.models.matters import DraftDocument, DraftRevision, Matter
from app.models.review import ReviewMatrix
from app.models.schemas import Automation, ChatThread, ModelConfig
from app.repositories.search_index import SearchIndexEntry, SearchIndexState

if TYPE_CHECKING:
    from app.repositories.seed import SeedStore

logger = logging.getLogger("aperture.search_index")

_HTML_TAG_PATTERN = re.compile(r"<[^>]+>")
# Hermes companion transcripts are fenced in assistant replies and are not
# something a person typed or would search for.
_HERMES_FENCE_PATTERN = re.compile(r"```hermes[^\n]*\n.*?```", re.DOTALL)


def _parse_time(value: object) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
        except ValueError:
            pass
    return clock.now()


# --- extractors ------------------------------------------------------------------


def entry_for_thread(thread: ChatThread, *, updated_at: datetime | None = None) -> SearchIndexEntry:
    parts: list[str] = []
    for message in thread.messages:
        if message.role not in {"user", "assistant"}:
            continue
        content = _HERMES_FENCE_PATTERN.sub(" ", message.content or "")
        if content.strip():
            parts.append(content)
    return SearchIndexEntry(
        tenant_id=thread.tenant_id,
        kind="chat",
        resource_id=thread.id,
        owner_user_id=thread.owner_user_id,
        visibility="owner",
        matter_id=thread.matter_id,
        archived=thread.archived,
        title=thread.title,
        body="\n".join(parts),
        source_updated_at=updated_at or _parse_time(thread.updated_at),
    )


def draft_plain_text(document: DraftDocument, revision: DraftRevision) -> str:
    if document.kind == "deck":
        return " ".join(deck_plain_text(revision.content).split())
    return " ".join(unescape(_HTML_TAG_PATTERN.sub(" ", revision.content)).split())


def entry_for_draft(document: DraftDocument, revision: DraftRevision) -> SearchIndexEntry:
    return SearchIndexEntry(
        tenant_id=document.tenant_id,
        kind="draft",
        resource_id=document.id,
        owner_user_id=document.owner_user_id,
        visibility="owner",
        matter_id=document.matter_id,
        archived=document.archived,
        title=document.title,
        body=draft_plain_text(document, revision),
        source_updated_at=document.updated_at,
    )


def entry_for_agent(model: ModelConfig, *, tenant_id: str) -> SearchIndexEntry:
    return SearchIndexEntry(
        tenant_id=tenant_id,
        kind="agent",
        resource_id=model.id,
        owner_user_id=None,
        visibility="private" if (model.visibility or "").lower() == "private" else "groups"
        if (model.visibility or "").lower() not in {"organization", "tenant", ""}
        else "tenant",
        acl_group_ids=tuple(model.group_ids),
        title=model.name,
        body="\n".join(value for value in (model.notes, model.meta_prompt) if value),
        source_updated_at=clock.now(),
    )


def entry_for_automation(automation: Automation) -> SearchIndexEntry:
    return SearchIndexEntry(
        tenant_id=automation.tenant_id,
        kind="automation",
        resource_id=automation.id,
        owner_user_id=automation.created_by,
        visibility="owner",
        title=automation.name,
        body="\n".join([automation.prompt, *(step.instruction for step in automation.steps)]),
        source_updated_at=_parse_time(automation.updated_at),
    )


def entry_for_matter(matter: Matter) -> SearchIndexEntry:
    return SearchIndexEntry(
        tenant_id=matter.tenant_id,
        kind="matter",
        resource_id=matter.id,
        owner_user_id=matter.created_by_user_id,
        visibility="matter",
        matter_id=matter.id,
        title=matter.name,
        body="",
        source_updated_at=matter.updated_at,
    )


def entry_for_review(matrix: ReviewMatrix) -> SearchIndexEntry:
    return SearchIndexEntry(
        tenant_id=matrix.tenant_id,
        kind="review",
        resource_id=matrix.id,
        owner_user_id=matrix.owner_user_id,
        visibility="owner",
        matter_id=matrix.matter_id,
        title=matrix.name,
        body="\n".join(
            [*(column.label for column in matrix.columns), *(column.question for column in matrix.columns)]
        ),
        source_updated_at=matrix.updated_at,
    )


# --- maintenance ----------------------------------------------------------------


def reconcile_store_collections(store: SeedStore, *, tenant_id: str | None = None) -> int:
    """Re-derive agent, automation, and matter rows from the store; prune the rest."""

    repository = store.search_index_repository
    tenants = [tenant_id] if tenant_id else list(store.tenants)
    written = 0
    for tid in tenants:
        agents = [
            entry_for_agent(model, tenant_id=tid)
            for model in store.models.values()
            if is_workspace_agent_profile(model) and (model.tenant_id is None or model.tenant_id == tid)
        ]
        automations = [
            entry_for_automation(automation)
            for automation in store.automations.values()
            if automation.tenant_id == tid
        ]
        written += repository.upsert_many([*agents, *automations])
        repository.prune_kind(tenant_id=tid, kind="agent", keep_resource_ids=[e.resource_id for e in agents])
        repository.prune_kind(
            tenant_id=tid, kind="automation", keep_resource_ids=[e.resource_id for e in automations]
        )
        matters = [
            entry_for_matter(matter)
            for matter in store.matter_draft_repository.list_all_matters(tenant_id=tid)
        ]
        written += repository.upsert_many(matters)
        repository.prune_kind(tenant_id=tid, kind="matter", keep_resource_ids=[e.resource_id for e in matters])
    return written


def backfill_tenant(store: SeedStore, tenant_id: str, *, batch: int = 200) -> SearchIndexState:
    """Idempotent full (re)index of one tenant from the live records."""

    repository = store.search_index_repository
    application = store.application_state_repository

    thread_ids: list[str] = []
    offset = 0
    while True:
        threads = application.list_chat_threads(tenant_id=tenant_id, limit=batch, offset=offset)
        if not threads:
            break
        repository.upsert_many(entry_for_thread(thread) for thread in threads)
        thread_ids.extend(thread.id for thread in threads)
        offset += len(threads)
        if len(threads) < batch:
            break
    repository.prune_kind(tenant_id=tenant_id, kind="chat", keep_resource_ids=thread_ids)

    draft_ids: list[str] = []
    session = store.matter_draft_repository._sessions()
    try:
        offset = 0
        while True:
            rows = list(
                session.scalars(
                    select(DraftDocumentRow)
                    .where(DraftDocumentRow.tenant_id == tenant_id)
                    .order_by(DraftDocumentRow.id)
                    .offset(offset)
                    .limit(batch)
                )
            )
            if not rows:
                break
            entries: list[SearchIndexEntry] = []
            for row in rows:
                revision_row = session.get(
                    DraftRevisionRow, {"draft_id": row.id, "revision": row.current_revision}
                )
                if revision_row is None:
                    continue
                try:
                    entries.append(entry_for_draft(row.to_model(), revision_row.to_model()))
                except ValueError:
                    logger.warning("Skipping draft %s during search backfill: invalid stored content", row.id)
                    continue
                draft_ids.append(row.id)
            repository.upsert_many(entries)
            offset += len(rows)
            if len(rows) < batch:
                break
    finally:
        session.close()
    repository.prune_kind(tenant_id=tenant_id, kind="draft", keep_resource_ids=draft_ids)

    reconcile_store_collections(store, tenant_id=tenant_id)
    return repository.mark_backfilled(tenant_id, fts_mode="like")


def search_index_pass(store: SeedStore) -> None:
    """Scheduler tick: backfill tenants that are not ready, reconcile the rest."""

    repository = store.search_index_repository
    ready = {state.tenant_id for state in repository.states() if state.ready}
    for tenant_id in list(store.tenants):
        if tenant_id in ready:
            continue
        backfill_tenant(store, tenant_id)
    if ready:
        reconcile_store_collections(store)
