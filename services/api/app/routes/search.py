"""Actor-scoped global search across Aperture workspace records.

The endpoint deliberately composes existing authorization rules instead of
building a second search-only index. That keeps results honest while the
relational search index described in the competitive plan is introduced in
later persistence milestones. Personal chat search includes both active and
archived conversations and matches their titles and message text.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from html import unescape
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.core.policy import (
    agent_profile_access_allowed,
    group_permission_allowed,
    is_platform_owner,
    is_tenant_admin,
    is_workspace_agent_profile,
    knowledge_access_allowed,
)
from app.core.review_store import ReviewStore
from app.models.matters import MAX_DRAFT_LIST_LIMIT, DraftSnapshot
from app.models.review import ReviewMatrix
from app.models.schemas import Automation, ChatThread, ModelConfig, User
from app.repositories.deps import get_store
from app.repositories.matters import (
    MatterAccessDenied,
    MatterDraftRepository,
    MatterNotFound,
    MatterRepositoryError,
)
from app.repositories.review_deps import get_review_store
from app.repositories.seed import SeedStore
from app.routes.dependencies import current_user
from app.routes.matters import (
    MatterActorScope,
    current_matter_scope,
    get_matter_draft_repository,
)

router = APIRouter(prefix="/api/search", tags=["search"])

SearchKind = Literal[
    "chat",
    "knowledge",
    "review",
    "agent",
    "automation",
    "matter",
    "draft",
]
_TOKEN_PATTERN = re.compile(r"[a-zA-Z0-9]+")
_HTML_TAG_PATTERN = re.compile(r"<[^>]+>")
# Knowledge hits are filtered for a literal term match after retrieval, so the
# candidate pool is wider than the page of results the caller asked for.
_KNOWLEDGE_CANDIDATE_FACTOR = 8
_KNOWLEDGE_CANDIDATE_CAP = 200


class GlobalSearchHit(BaseModel):
    id: str
    kind: SearchKind
    title: str
    snippet: str = ""
    score: float = 0
    navigation: dict[str, str] = Field(default_factory=dict)
    metadata: dict[str, object] = Field(default_factory=dict)


class GlobalSearchSection(BaseModel):
    kind: SearchKind
    title: str
    results: list[GlobalSearchHit] = Field(default_factory=list)


class GlobalSearchResponse(BaseModel):
    query: str
    sections: list[GlobalSearchSection]


@router.get("")
def global_search(
    q: str = Query(min_length=1, max_length=200),
    limit: int = Query(default=8, ge=1, le=25),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    review_store: ReviewStore = Depends(get_review_store),
    matter_scope: MatterActorScope = Depends(current_matter_scope),
    matter_repository: MatterDraftRepository = Depends(get_matter_draft_repository),
) -> GlobalSearchResponse:
    query = " ".join(q.split())
    if not query:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Search query must not be blank.",
        )

    try:
        matter_results = _search_matters(
            matter_repository,
            matter_scope,
            query,
            limit,
        )
        draft_results = _search_drafts(
            matter_repository,
            matter_scope,
            query,
            limit,
        )
    except MatterRepositoryError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Matter and draft search is temporarily unavailable.",
        ) from exc

    sections = [
        GlobalSearchSection(
            kind="chat",
            title="Previous chats",
            results=_search_threads(store.chat_threads_for(actor), query, limit),
        ),
        GlobalSearchSection(
            kind="knowledge",
            title="Documents & knowledge",
            results=_search_knowledge(store, actor, query, limit),
        ),
        GlobalSearchSection(
            kind="review",
            title="Review Grids",
            results=_search_review_matrices(review_store, store, actor, query, limit),
        ),
        GlobalSearchSection(
            kind="agent",
            title="Agents",
            results=_search_agent_profiles(store, actor, query, limit),
        ),
        GlobalSearchSection(
            kind="automation",
            title="Automations",
            results=_search_automations(store, actor, query, limit),
        ),
        GlobalSearchSection(
            kind="matter",
            title="Matters",
            results=matter_results,
        ),
        GlobalSearchSection(
            kind="draft",
            title="Drafts",
            results=draft_results,
        ),
    ]
    return GlobalSearchResponse(query=query, sections=sections)


def _search_threads(threads: Iterable[ChatThread], query: str, limit: int) -> list[GlobalSearchHit]:
    results: list[GlobalSearchHit] = []
    for thread in threads:
        message_text = "\n".join(message.content for message in thread.messages)
        searchable = f"{thread.title}\n{message_text}"
        score = _lexical_score(searchable, query)
        if score <= 0:
            continue
        snippet = _matching_snippet(message_text, query) or thread.title
        results.append(
            GlobalSearchHit(
                id=thread.id,
                kind="chat",
                title=thread.title,
                snippet=snippet,
                score=score,
                navigation={"view": "chat", "thread_id": thread.id},
                metadata={
                    "model_id": thread.model_id,
                    "updated_at": thread.updated_at,
                    "archived": thread.archived,
                },
            )
        )
    return _rank(results, limit)


def _search_matters(
    repository: MatterDraftRepository,
    scope: MatterActorScope,
    query: str,
    limit: int,
) -> list[GlobalSearchHit]:
    """Search only matter metadata admitted by explicit membership."""

    results: list[GlobalSearchHit] = []
    for matter in repository.list_matters(
        tenant_id=scope.tenant_id,
        actor_user_id=scope.actor.id,
        limit=MAX_DRAFT_LIST_LIMIT,
    ):
        score = _lexical_score(matter.name, query)
        if score <= 0:
            continue
        results.append(
            GlobalSearchHit(
                id=matter.id,
                kind="matter",
                title=matter.name,
                snippet=_matching_snippet(matter.name, query),
                score=score,
                navigation={"view": "matters", "matter_id": matter.id},
                metadata={
                    "retention_days": matter.retention_days,
                    "version": matter.version,
                    "updated_at": matter.updated_at,
                },
            )
        )
    return _rank(results, limit)


def _search_drafts(
    repository: MatterDraftRepository,
    scope: MatterActorScope,
    query: str,
    limit: int,
) -> list[GlobalSearchHit]:
    """Search current owner-private drafts and recheck linked matter access."""

    results: list[GlobalSearchHit] = []
    snapshots = repository.search_drafts(
        query,
        tenant_id=scope.tenant_id,
        owner_user_id=scope.actor.id,
        limit=MAX_DRAFT_LIST_LIMIT,
    )
    for snapshot in snapshots:
        document = snapshot.document
        if document.matter_id is not None and not _matter_membership_allows_draft(
            repository,
            scope,
            document.matter_id,
        ):
            continue
        plain_content = _draft_plain_text(snapshot)
        searchable = f"{document.title}\n{plain_content}"
        score = _lexical_score(searchable, query)
        if score <= 0:
            continue
        content_score = _lexical_score(plain_content, query)
        navigation = {"view": "drafts", "draft_id": document.id}
        if document.matter_id is not None:
            navigation["matter_id"] = document.matter_id
        results.append(
            GlobalSearchHit(
                id=document.id,
                kind="draft",
                title=document.title,
                snippet=(
                    _matching_snippet(plain_content, query) if content_score > 0 else document.title
                ),
                score=score,
                navigation=navigation,
                metadata={
                    "matter_id": document.matter_id,
                    "current_revision": document.current_revision,
                    "updated_at": document.updated_at,
                },
            )
        )
    return _rank(results, limit)


def _matter_membership_allows_draft(
    repository: MatterDraftRepository,
    scope: MatterActorScope,
    matter_id: str,
) -> bool:
    try:
        repository.get_matter(
            matter_id,
            tenant_id=scope.tenant_id,
            actor_user_id=scope.actor.id,
        )
    except (MatterAccessDenied, MatterNotFound):
        return False
    return True


def _draft_plain_text(snapshot: DraftSnapshot) -> str:
    without_tags = _HTML_TAG_PATTERN.sub(" ", snapshot.revision.content)
    return " ".join(unescape(without_tags).split())


def _search_review_matrices(
    review_store: ReviewStore,
    store: SeedStore,
    actor: User,
    query: str,
    limit: int,
) -> list[GlobalSearchHit]:
    results: list[GlobalSearchHit] = []
    for matrix in review_store.list_matrices(owner_user_id=actor.id):
        if not _review_matrix_visible(matrix, store, actor):
            continue
        searchable = "\n".join(
            [
                matrix.name,
                *(column.label for column in matrix.columns),
                *(column.question for column in matrix.columns),
            ]
        )
        score = _lexical_score(searchable, query)
        if score <= 0:
            continue
        results.append(
            GlobalSearchHit(
                id=matrix.id,
                kind="review",
                title=matrix.name,
                snippet=_matching_snippet(searchable, query),
                score=score,
                navigation={"view": "review", "matrix_id": matrix.id},
                metadata={
                    "status": matrix.status,
                    "model_id": matrix.model_id,
                    "document_count": len(matrix.document_ids),
                    "column_count": len(matrix.columns),
                    "updated_at": matrix.updated_at,
                },
            )
        )
    return _rank(results, limit)


def _review_matrix_visible(
    matrix: ReviewMatrix,
    store: SeedStore,
    actor: User,
) -> bool:
    if not is_platform_owner(actor) and actor.tenant_id != matrix.tenant_id:
        return False
    if not group_permission_allowed(actor, store.groups, "knowledge_access"):
        return False

    configs = []
    for config_id in matrix.knowledge_config_ids:
        config = store.knowledge_configs.get(config_id)
        if config is None or config.tenant_id != matrix.tenant_id:
            return False
        if not knowledge_access_allowed(actor, config):
            return False
        configs.append(config)

    documents = {
        document.id: document
        for config in configs
        for document in store.knowledge_documents_for(config.id)
        if document.id in matrix.document_ids
    }
    if set(documents) != set(matrix.document_ids):
        return False
    for document in documents.values():
        if document.tenant_id != matrix.tenant_id:
            return False
        if (
            not is_platform_owner(actor)
            and not is_tenant_admin(actor)
            and document.acl_group_ids
            and not set(actor.group_ids).intersection(document.acl_group_ids)
        ):
            return False
    return True


def _search_knowledge(
    store: SeedStore,
    actor: User,
    query: str,
    limit: int,
) -> list[GlobalSearchHit]:
    if not group_permission_allowed(actor, store.groups, "knowledge_access"):
        return []
    config_ids = sorted(
        config.id
        for config in store.knowledge_configs.values()
        if knowledge_access_allowed(actor, config)
    )
    if not config_ids:
        return []

    results: list[GlobalSearchHit] = []
    seen_chunk_ids: set[str] = set()
    # Dense retrieval always returns nearest neighbours, and its similarity
    # score does not separate relevant from irrelevant: a nonsense query scores
    # higher than a real one against the same corpus. Grounding a chat answer
    # still wants those neighbours, but a search box must not pad every query
    # with unrelated documents, so a hit has to contain something the user
    # typed. Because that test is applied after retrieval, ask for a wider
    # candidate pool than we intend to show -- otherwise a real match sitting
    # just outside the top-k is filtered away and the section looks empty.
    candidate_limit = min(limit * _KNOWLEDGE_CANDIDATE_FACTOR, _KNOWLEDGE_CANDIDATE_CAP)
    for chunk in store.retrieve_knowledge(actor, config_ids, query, limit=candidate_limit):
        # SeedStore intentionally retains a 0.1 deterministic fallback for chat
        # grounding. Global search must not present that as a real match.
        if chunk.score <= 0.1 or chunk.id in seen_chunk_ids:
            continue
        if not _lexical_score(f"{chunk.source_name}\n{chunk.text}", query):
            continue
        seen_chunk_ids.add(chunk.id)
        navigation = {
            "view": "library",
            "knowledge_config_id": chunk.knowledge_config_id,
            "document_id": chunk.document_id,
        }
        if chunk.page_start is not None:
            navigation["page"] = str(chunk.page_start)
        metadata: dict[str, object] = {
            "knowledge_config_id": chunk.knowledge_config_id,
            "document_id": chunk.document_id,
            "source_uri": chunk.source_uri,
            "source_type": chunk.source_type,
            "page_start": chunk.page_start,
            "page_end": chunk.page_end,
            "locator": chunk.locator,
        }
        results.append(
            GlobalSearchHit(
                id=chunk.id,
                kind="knowledge",
                title=chunk.source_name,
                snippet=_clip(chunk.text),
                score=chunk.score,
                navigation=navigation,
                metadata=metadata,
            )
        )
    return _rank(results, limit)


def _search_agent_profiles(
    store: SeedStore,
    actor: User,
    query: str,
    limit: int,
) -> list[GlobalSearchHit]:
    results: list[GlobalSearchHit] = []
    for model in store.models.values():
        if not is_workspace_agent_profile(model) or not agent_profile_access_allowed(actor, model):
            continue
        model_tenant_id = getattr(model, "tenant_id", None)
        if (
            model_tenant_id is not None
            and not is_platform_owner(actor)
            and model_tenant_id != actor.tenant_id
        ):
            continue
        searchable = "\n".join(
            value for value in (model.name, model.notes, model.meta_prompt) if value
        )
        score = _lexical_score(searchable, query)
        if score <= 0:
            continue
        results.append(_agent_hit(model, score))
    return _rank(results, limit)


def _agent_hit(model: ModelConfig, score: float) -> GlobalSearchHit:
    return GlobalSearchHit(
        id=model.id,
        kind="agent",
        title=model.name,
        snippet=_clip(model.notes or model.meta_prompt or ""),
        score=score,
        navigation={"view": "agents", "agent_profile_id": model.id},
        metadata={
            "visibility": model.visibility,
            "created_by": model.created_by,
        },
    )


def _search_automations(
    store: SeedStore,
    actor: User,
    query: str,
    limit: int,
) -> list[GlobalSearchHit]:
    results: list[GlobalSearchHit] = []
    for automation in _visible_automations(store, actor):
        searchable = "\n".join(
            [automation.name, automation.prompt, *(step.instruction for step in automation.steps)]
        )
        score = _lexical_score(searchable, query)
        if score <= 0:
            continue
        results.append(_automation_hit(automation, score))
    return _rank(results, limit)


def _visible_automations(store: SeedStore, actor: User) -> list[Automation]:
    if is_platform_owner(actor):
        return list(store.automations.values())
    same_tenant = [
        automation
        for automation in store.automations.values()
        if automation.tenant_id == actor.tenant_id
    ]
    if is_tenant_admin(actor):
        return same_tenant
    return [automation for automation in same_tenant if automation.created_by == actor.id]


def _automation_hit(automation: Automation, score: float) -> GlobalSearchHit:
    return GlobalSearchHit(
        id=automation.id,
        kind="automation",
        title=automation.name,
        snippet=_clip(automation.prompt),
        score=score,
        navigation={"view": "automations", "automation_id": automation.id},
        metadata={
            "surface": automation.surface,
            "enabled": automation.enabled,
            "updated_at": automation.updated_at,
        },
    )


def _rank(results: list[GlobalSearchHit], limit: int) -> list[GlobalSearchHit]:
    results.sort(key=lambda item: (-item.score, item.title.casefold(), item.id))
    return results[:limit]


def _lexical_score(value: str, query: str) -> float:
    searchable = value.casefold()
    normalized_query = query.casefold()
    terms = {term.casefold() for term in _TOKEN_PATTERN.findall(query)}
    score = float(sum(searchable.count(term) for term in terms))
    if normalized_query in searchable:
        score += 4.0
    return score


def _matching_snippet(value: str, query: str) -> str:
    if not value:
        return ""
    folded = value.casefold()
    index = folded.find(query.casefold())
    if index < 0:
        terms = [term.casefold() for term in _TOKEN_PATTERN.findall(query)]
        indexes = [folded.find(term) for term in terms if folded.find(term) >= 0]
        index = min(indexes, default=0)
    start = max(0, index - 90)
    end = min(len(value), index + 210)
    prefix = "..." if start else ""
    suffix = "..." if end < len(value) else ""
    return f"{prefix}{' '.join(value[start:end].split())}{suffix}"


def _clip(value: str, limit: int = 300) -> str:
    normalized = " ".join(value.split())
    if len(normalized) <= limit:
        return normalized
    return f"{normalized[: limit - 3].rstrip()}..."
