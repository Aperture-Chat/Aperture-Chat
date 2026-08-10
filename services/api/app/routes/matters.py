"""Membership-gated matter workspaces and private server draft snapshots.

This router deliberately depends on the relational M9 repository instead of
the browser/SeedStore caches. Matter membership is always an additional gate;
it never broadens access to another user's chats, folders, or drafts.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status

from app.models.matters import (
    MAX_DRAFT_CONTENT_BYTES,
    MAX_DRAFT_LIST_LIMIT,
    DraftDocument,
    DraftCreateRequest,
    DraftPutRequest,
    DraftRevisionCapacity,
    DraftSnapshot,
    Matter,
    MatterCreateRequest,
    MatterDeletionJob,
    MatterDeletionResponse,
    MatterMembership,
    MatterMemberMutationRequest,
    MatterUpdateRequest,
    matter_now,
)
from app.core.policy import knowledge_access_allowed
from app.core.review_store import ReviewConflict
from app.models.schemas import Role, User
from app.repositories.deps import get_store
from app.repositories.matters import (
    DraftConflict,
    DraftRevisionLimitExceeded,
    MatterAccessDenied,
    MatterConflict,
    MatterDraftRepository,
    MatterNotFound,
    MatterPersistenceUnavailable,
    MatterRepositoryError,
    PrivateResourceNotFound,
)
from app.repositories.seed import SeedStore
from app.routes.dependencies import current_user


router = APIRouter(tags=["matters"])


@dataclass(frozen=True, slots=True)
class MatterActorScope:
    actor: User
    tenant_id: str
    store: SeedStore


def get_matter_draft_repository(
    store: SeedStore = Depends(get_store),
) -> MatterDraftRepository:
    """Bind M9 persistence to the same relational engine as chat state."""

    return MatterDraftRepository(store.application_state_repository.engine)


@dataclass(frozen=True, slots=True)
class ReviewMatterService:
    """Review-store operations the matters router needs, injected so tests
    never touch the process-wide review database."""

    get_matrix: object
    set_matter: object
    clear_references: object


def get_review_matter_service() -> ReviewMatterService:
    from app.repositories.review_deps import (
        clear_review_matter_references,
        get_review_store,
        set_review_matrix_matter,
    )

    return ReviewMatterService(
        get_matrix=lambda matrix_id: get_review_store().get_matrix(matrix_id),
        set_matter=set_review_matrix_matter,
        clear_references=clear_review_matter_references,
    )


def current_matter_scope(
    tenant_slug: str | None = Header(default=None, alias="X-Aperture-Tenant"),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> MatterActorScope:
    """Resolve one tenant without granting platform-owner membership bypass."""

    requested_slug = (tenant_slug or "").strip()
    if actor.role == Role.PLATFORM_OWNER:
        if not requested_slug:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="X-Aperture-Tenant is required for platform-owner matters and drafts.",
            )
        selected = store.tenant_by_slug(requested_slug)
        if selected is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Unknown tenant slug.",
            )
        return MatterActorScope(actor=actor, tenant_id=selected.id, store=store)
    if actor.tenant_id is None or not actor.tenant_id.strip():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="A tenant-scoped account is required for matters and drafts.",
        )
    actor_tenant = store.tenants.get(actor.tenant_id)
    if actor_tenant is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Unknown tenant scope.",
        )
    if requested_slug:
        selected = store.tenant_by_slug(requested_slug)
        if selected is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Unknown tenant slug.",
            )
        if selected.id != actor.tenant_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="The requested tenant is outside the authenticated tenant scope.",
            )
    return MatterActorScope(actor=actor, tenant_id=actor.tenant_id, store=store)


@router.get("/api/matters")
def list_matters(
    limit: int = Query(default=MAX_DRAFT_LIST_LIMIT, ge=1, le=MAX_DRAFT_LIST_LIMIT),
    offset: int = Query(default=0, ge=0),
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: MatterDraftRepository = Depends(get_matter_draft_repository),
) -> list[Matter]:
    with _repository_errors():
        return repository.list_matters(
            tenant_id=scope.tenant_id,
            actor_user_id=scope.actor.id,
            limit=limit,
            offset=offset,
        )
    raise AssertionError("unreachable")


@router.post("/api/matters", status_code=status.HTTP_201_CREATED)
def create_matter(
    payload: MatterCreateRequest,
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: MatterDraftRepository = Depends(get_matter_draft_repository),
) -> Matter:
    if payload.member_user_ids and scope.actor.role not in {
        Role.TENANT_ADMIN,
        Role.PLATFORM_OWNER,
    }:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only tenant administrators may add members to a matter.",
        )
    for member_user_id in payload.member_user_ids:
        _require_active_tenant_member_target(scope, member_user_id)
    with _repository_errors():
        return repository.create_matter(
            tenant_id=scope.tenant_id,
            name=payload.name,
            creator_user_id=scope.actor.id,
            member_user_ids=payload.member_user_ids,
            retention_days=payload.retention_days,
        )
    raise AssertionError("unreachable")


@router.get("/api/matters/{matter_id}")
def get_matter(
    matter_id: str,
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: MatterDraftRepository = Depends(get_matter_draft_repository),
) -> Matter:
    with _repository_errors():
        return repository.get_matter(
            matter_id,
            tenant_id=scope.tenant_id,
            actor_user_id=scope.actor.id,
        )
    raise AssertionError("unreachable")


@router.put("/api/matters/{matter_id}")
def update_matter(
    matter_id: str,
    payload: MatterUpdateRequest,
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: MatterDraftRepository = Depends(get_matter_draft_repository),
) -> Matter:
    update_values: dict[str, object] = {}
    if payload.name is not None:
        update_values["name"] = payload.name
    if "retention_days" in payload.model_fields_set:
        update_values["retention_days"] = payload.retention_days
    if not update_values:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Matter updates require a name or retention_days field.",
        )
    with _repository_errors():
        _require_matter_manager(scope, repository, matter_id)
        return repository.update_matter(
            matter_id,
            tenant_id=scope.tenant_id,
            actor_user_id=scope.actor.id,
            expected_version=payload.expected_version,
            **update_values,
        )
    raise AssertionError("unreachable")


@router.get("/api/matters/{matter_id}/members")
def list_matter_members(
    matter_id: str,
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: MatterDraftRepository = Depends(get_matter_draft_repository),
) -> list[MatterMembership]:
    with _repository_errors():
        return repository.list_memberships(
            matter_id,
            tenant_id=scope.tenant_id,
            actor_user_id=scope.actor.id,
        )
    raise AssertionError("unreachable")


@router.put("/api/matters/{matter_id}/members/{member_user_id}")
def add_matter_member(
    matter_id: str,
    member_user_id: str,
    payload: MatterMemberMutationRequest,
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: MatterDraftRepository = Depends(get_matter_draft_repository),
) -> Matter:
    with _repository_errors():
        _require_membership_manager(scope, repository, matter_id)
        _require_active_tenant_member_target(scope, member_user_id)
        return repository.add_member(
            matter_id,
            tenant_id=scope.tenant_id,
            actor_user_id=scope.actor.id,
            member_user_id=member_user_id,
            expected_version=payload.expected_version,
        )
    raise AssertionError("unreachable")


@router.delete("/api/matters/{matter_id}/members/{member_user_id}")
def remove_matter_member(
    matter_id: str,
    member_user_id: str,
    expected_version: int = Query(ge=1),
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: MatterDraftRepository = Depends(get_matter_draft_repository),
) -> Matter:
    with _repository_errors():
        _require_membership_manager(scope, repository, matter_id)
        return repository.remove_member(
            matter_id,
            tenant_id=scope.tenant_id,
            actor_user_id=scope.actor.id,
            member_user_id=member_user_id,
            expected_version=expected_version,
        )
    raise AssertionError("unreachable")


_ASSIGNABLE_RESOURCE_TYPES = (
    "chat-threads",
    "chat-folders",
    "knowledge-configs",
    "review-matrices",
)


def _require_assignable_matter(
    scope: MatterActorScope,
    repository: MatterDraftRepository,
    matter_id: str,
) -> Matter:
    """Membership-gated matter lookup that refuses mid-deletion assignment."""

    matter = repository.get_matter(
        matter_id,
        tenant_id=scope.tenant_id,
        actor_user_id=scope.actor.id,
    )
    job = repository.get_matter_deletion_job(
        matter_id,
        tenant_id=scope.tenant_id,
        actor_user_id=scope.actor.id,
    )
    if job is not None and job.status != "complete":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This matter is being deleted and cannot accept assignments.",
        )
    return matter


def _require_reference_boundary(
    current_matter_id: str | None,
    url_matter_id: str,
    *,
    assigning: bool,
) -> None:
    """Keep every mutation inside the URL matter's membership boundary.

    Assigning may only claim an unassigned resource (or re-assert the same
    matter); clearing may only unlink a resource that is actually in the URL
    matter. Anything else would mutate another matter's workspace without
    that matter's membership gate.
    """

    if assigning:
        if current_matter_id is not None and current_matter_id != url_matter_id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This resource is assigned to another matter; unlink it there first.",
            )
        return
    if current_matter_id != url_matter_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This resource is not assigned to this matter.",
        )


def _apply_matter_resource_reference(
    scope: MatterActorScope,
    repository: MatterDraftRepository,
    review_service: ReviewMatterService,
    resource_type: str,
    resource_id: str,
    url_matter_id: str,
    matter_id: str | None,
) -> dict[str, object]:
    """Set or clear one owned resource's matter reference.

    Matter membership was already verified by the caller; this enforces the
    resource-level scope so membership never widens resource access.
    """

    store = scope.store
    actor = scope.actor
    assigning = matter_id is not None
    if resource_type == "chat-threads":
        repository.bind_chat_thread(
            resource_id,
            tenant_id=scope.tenant_id,
            owner_user_id=actor.id,
            matter_id=matter_id,
            boundary_matter_id=url_matter_id,
        )
        return {"resource_type": resource_type, "id": resource_id, "matter_id": matter_id}
    if resource_type == "chat-folders":
        repository.bind_chat_folder(
            resource_id,
            tenant_id=scope.tenant_id,
            owner_user_id=actor.id,
            matter_id=matter_id,
            boundary_matter_id=url_matter_id,
        )
        return {"resource_type": resource_type, "id": resource_id, "matter_id": matter_id}
    if resource_type == "knowledge-configs":
        config = store.knowledge_configs.get(resource_id)
        if config is None or config.tenant_id != scope.tenant_id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Knowledge configuration not found.",
            )
        if not knowledge_access_allowed(actor, config):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Knowledge access is restricted by tenant, group, or source ACL policy.",
            )
        _require_reference_boundary(config.matter_id, url_matter_id, assigning=assigning)
        config.matter_id = matter_id
        store.record_audit(
            actor,
            "matter.knowledge_config_reference_updated",
            config.id,
            {"matter_id": matter_id},
        )
        return {"resource_type": resource_type, "id": config.id, "matter_id": config.matter_id}
    if resource_type == "review-matrices":
        matrix = review_service.get_matrix(resource_id)
        if (
            matrix is None
            or matrix.owner_user_id != actor.id
            or matrix.tenant_id != scope.tenant_id
        ):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Review matrix not found.",
            )
        _require_reference_boundary(matrix.matter_id, url_matter_id, assigning=assigning)
        try:
            updated = review_service.set_matter(
                resource_id, tenant_id=scope.tenant_id, matter_id=matter_id
            )
        except ReviewConflict as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=str(exc),
            ) from exc
        return {
            "resource_type": resource_type,
            "id": updated.id,
            "matter_id": updated.matter_id,
        }
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="Unknown matter resource type.",
    )


@router.put("/api/matters/{matter_id}/resources/{resource_type}/{resource_id}")
def assign_matter_resource(
    matter_id: str,
    resource_type: str,
    resource_id: str,
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: MatterDraftRepository = Depends(get_matter_draft_repository),
    review_service: ReviewMatterService = Depends(get_review_matter_service),
) -> dict[str, object]:
    if resource_type not in _ASSIGNABLE_RESOURCE_TYPES:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Unknown matter resource type.",
        )
    with _repository_errors():
        _require_assignable_matter(scope, repository, matter_id)
        return _apply_matter_resource_reference(
            scope,
            repository,
            review_service,
            resource_type,
            resource_id,
            matter_id,
            matter_id,
        )
    raise AssertionError("unreachable")


@router.delete("/api/matters/{matter_id}/resources/{resource_type}/{resource_id}")
def clear_matter_resource(
    matter_id: str,
    resource_type: str,
    resource_id: str,
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: MatterDraftRepository = Depends(get_matter_draft_repository),
    review_service: ReviewMatterService = Depends(get_review_matter_service),
) -> dict[str, object]:
    if resource_type not in _ASSIGNABLE_RESOURCE_TYPES:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Unknown matter resource type.",
        )
    with _repository_errors():
        repository.get_matter(
            matter_id,
            tenant_id=scope.tenant_id,
            actor_user_id=scope.actor.id,
        )
        return _apply_matter_resource_reference(
            scope,
            repository,
            review_service,
            resource_type,
            resource_id,
            matter_id,
            None,
        )
    raise AssertionError("unreachable")


@router.get("/api/matters/{matter_id}/deletion")
def get_matter_deletion(
    matter_id: str,
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: MatterDraftRepository = Depends(get_matter_draft_repository),
) -> MatterDeletionJob:
    with _repository_errors():
        job = repository.get_matter_deletion_job(
            matter_id,
            tenant_id=scope.tenant_id,
            actor_user_id=scope.actor.id,
        )
        if job is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Matter deletion job not found.",
            )
        return job
    raise AssertionError("unreachable")


@router.delete("/api/matters/{matter_id}")
def delete_matter(
    matter_id: str,
    response: Response,
    expected_version: int = Query(ge=1),
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: MatterDraftRepository = Depends(get_matter_draft_repository),
    review_service: ReviewMatterService = Depends(get_review_matter_service),
) -> MatterDeletionResponse:
    """Advance only cleanup stages whose real work this route can perform."""

    with _repository_errors():
        existing_job = repository.get_matter_deletion_job(
            matter_id,
            tenant_id=scope.tenant_id,
            actor_user_id=scope.actor.id,
        )
        if existing_job is None or existing_job.status != "complete":
            _require_matter_manager(scope, repository, matter_id)
        job = repository.request_matter_deletion(
            matter_id,
            tenant_id=scope.tenant_id,
            actor_user_id=scope.actor.id,
            expected_version=expected_version,
        )
        if job.status == "complete":
            response.status_code = status.HTTP_200_OK
            return MatterDeletionResponse(job=job)
        if job.status == "ready":
            completed = repository.finalize_matter_deletion(
                matter_id,
                tenant_id=scope.tenant_id,
            )
            response.status_code = status.HTTP_200_OK
            return MatterDeletionResponse(job=completed)
        if (
            job.status == "running"
            and job.lease_expires_at is not None
            and job.lease_expires_at > matter_now()
        ):
            response.status_code = status.HTTP_202_ACCEPTED
            return MatterDeletionResponse(job=job)

        job = repository.claim_matter_deletion(
            matter_id,
            tenant_id=scope.tenant_id,
        )
        if job.status == "running":
            try:
                repository.clear_application_matter_references(
                    matter_id,
                    tenant_id=scope.tenant_id,
                    expected_attempt=job.attempt_count,
                )
            except MatterRepositoryError:
                try:
                    repository.mark_matter_deletion_failed(
                        matter_id,
                        tenant_id=scope.tenant_id,
                        stage="application",
                        expected_attempt=job.attempt_count,
                    )
                except MatterRepositoryError:
                    # The original failure is the useful one. A concurrent
                    # reclaim can legitimately fence this best-effort marker.
                    pass
                raise

            def _clear_review_stage() -> None:
                review_service.clear_references(matter_id)

            def _clear_knowledge_stage() -> None:
                scope.store.clear_matter_knowledge_references(matter_id)

            def _verify_legacy_stage() -> None:
                remaining = scope.store.count_matter_references(matter_id)
                if remaining:
                    raise MatterConflict(
                        f"{remaining} legacy matter references remain after nulling."
                    )

            for stage_name, stage_work in (
                ("review", _clear_review_stage),
                ("knowledge", _clear_knowledge_stage),
                ("legacy", _verify_legacy_stage),
            ):
                try:
                    stage_work()
                    job = repository.mark_matter_deletion_stage_cleared(
                        matter_id,
                        tenant_id=scope.tenant_id,
                        stage=stage_name,
                        expected_attempt=job.attempt_count,
                    )
                except Exception:
                    try:
                        repository.mark_matter_deletion_failed(
                            matter_id,
                            tenant_id=scope.tenant_id,
                            stage=stage_name,
                            expected_attempt=job.attempt_count,
                        )
                    except MatterRepositoryError:
                        # Keep the stage's own failure as the reported error.
                        pass
                    raise

            if job.status == "ready":
                completed = repository.finalize_matter_deletion(
                    matter_id,
                    tenant_id=scope.tenant_id,
                )
                response.status_code = status.HTTP_200_OK
                return MatterDeletionResponse(job=completed)
            persisted = repository.get_matter_deletion_job(
                matter_id,
                tenant_id=scope.tenant_id,
                actor_user_id=scope.actor.id,
            )
            if persisted is None:
                raise MatterNotFound("Matter deletion job disappeared.")
            response.status_code = status.HTTP_202_ACCEPTED
            return MatterDeletionResponse(job=persisted)

        completed = repository.finalize_matter_deletion(
            matter_id,
            tenant_id=scope.tenant_id,
        )
        response.status_code = status.HTTP_200_OK
        return MatterDeletionResponse(job=completed)
    raise AssertionError("unreachable")


@router.get("/api/drafts")
def list_drafts(
    matter_id: str | None = Query(default=None, min_length=1, max_length=255),
    limit: int = Query(default=MAX_DRAFT_LIST_LIMIT, ge=1, le=MAX_DRAFT_LIST_LIMIT),
    offset: int = Query(default=0, ge=0),
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: MatterDraftRepository = Depends(get_matter_draft_repository),
) -> list[DraftDocument]:
    with _repository_errors():
        return repository.list_draft_documents(
            tenant_id=scope.tenant_id,
            owner_user_id=scope.actor.id,
            matter_id=matter_id,
            limit=limit,
            offset=offset,
        )
    raise AssertionError("unreachable")


@router.get("/api/drafts/{draft_id}")
def get_draft(
    draft_id: str,
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: MatterDraftRepository = Depends(get_matter_draft_repository),
) -> DraftSnapshot:
    with _repository_errors():
        return repository.get_draft(
            draft_id,
            tenant_id=scope.tenant_id,
            owner_user_id=scope.actor.id,
        )
    raise AssertionError("unreachable")


@router.post("/api/drafts", status_code=status.HTTP_201_CREATED)
def create_draft(
    payload: DraftCreateRequest,
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: MatterDraftRepository = Depends(get_matter_draft_repository),
) -> DraftSnapshot:
    """Create a private draft with a non-caller-controlled identifier."""

    _require_draft_content_bound(payload.content)
    with _repository_errors():
        return repository.create_draft(
            tenant_id=scope.tenant_id,
            owner_user_id=scope.actor.id,
            title=payload.title,
            content=payload.content,
            matter_id=payload.matter_id,
        )
    raise AssertionError("unreachable")


@router.put("/api/drafts/{draft_id}")
def put_draft(
    draft_id: str,
    payload: DraftPutRequest,
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: MatterDraftRepository = Depends(get_matter_draft_repository),
) -> DraftSnapshot:
    if payload.content is not None:
        _require_draft_content_bound(payload.content)
    with _repository_errors():
        if "title" in payload.model_fields_set and payload.title is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Draft title cannot be null.",
            )
        if "content" in payload.model_fields_set and payload.content is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Draft content cannot be null.",
            )
        update_values: dict[str, object] = {}
        if "matter_id" in payload.model_fields_set:
            update_values["matter_id"] = payload.matter_id
        if (
            payload.title is None
            and payload.content is None
            and "matter_id" not in payload.model_fields_set
        ):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Draft updates require title, content, or matter_id.",
            )
        return repository.update_draft(
            draft_id,
            tenant_id=scope.tenant_id,
            owner_user_id=scope.actor.id,
            expected_revision=payload.expected_revision,
            title=payload.title,
            content=payload.content,
            **update_values,
        )
    raise AssertionError("unreachable")


@router.delete("/api/drafts/{draft_id}")
def delete_draft(
    draft_id: str,
    expected_revision: int = Query(
        ...,
        ge=1,
        description="Revision the caller intends to delete; guards against racing edits.",
    ),
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: MatterDraftRepository = Depends(get_matter_draft_repository),
) -> DraftDocument:
    """Delete one of the caller's own drafts.

    Without this a draft list is append-only for the life of the account, and
    the hard revision cap means a heavily edited draft can never be replaced.
    Deletion is revision-checked like every other draft write, so it cannot
    discard an edit the caller has not seen.
    """
    with _repository_errors():
        return repository.delete_draft(
            draft_id,
            tenant_id=scope.tenant_id,
            owner_user_id=scope.actor.id,
            expected_revision=expected_revision,
        )
    raise AssertionError("unreachable")


@router.get("/api/drafts/{draft_id}/capacity")
def get_draft_capacity(
    draft_id: str,
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: MatterDraftRepository = Depends(get_matter_draft_repository),
) -> DraftRevisionCapacity:
    with _repository_errors():
        return repository.draft_revision_capacity(
            draft_id,
            tenant_id=scope.tenant_id,
            owner_user_id=scope.actor.id,
        )
    raise AssertionError("unreachable")


def _require_draft_content_bound(content: str) -> None:
    if len(content.encode("utf-8")) > MAX_DRAFT_CONTENT_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"Draft content is limited to {MAX_DRAFT_CONTENT_BYTES} UTF-8 bytes.",
        )


def _require_matter_manager(
    scope: MatterActorScope,
    repository: MatterDraftRepository,
    matter_id: str,
) -> Matter:
    matter = repository.get_matter(
        matter_id,
        tenant_id=scope.tenant_id,
        actor_user_id=scope.actor.id,
    )
    if matter.created_by_user_id == scope.actor.id or scope.actor.role in {
        Role.TENANT_ADMIN,
        Role.PLATFORM_OWNER,
    }:
        return matter
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Only the matter creator or an explicitly assigned administrator may manage it.",
    )


def _require_membership_manager(
    scope: MatterActorScope,
    repository: MatterDraftRepository,
    matter_id: str,
) -> None:
    if scope.actor.role not in {Role.TENANT_ADMIN, Role.PLATFORM_OWNER}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only tenant administrators may manage matter membership.",
        )
    repository.get_matter(
        matter_id,
        tenant_id=scope.tenant_id,
        actor_user_id=scope.actor.id,
    )


def _require_active_tenant_member_target(
    scope: MatterActorScope,
    member_user_id: str,
) -> None:
    target = scope.store.users.get(member_user_id)
    if target is None or not target.active or target.tenant_id != scope.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Unknown active user in the selected tenant.",
        )


@contextmanager
def _repository_errors() -> Iterator[None]:
    try:
        yield
    except (MatterNotFound, PrivateResourceNotFound) as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Matter or private draft not found.",
        ) from exc
    except MatterAccessDenied as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Explicit matter membership is required.",
        ) from exc
    except DraftRevisionLimitExceeded as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc
    except (MatterConflict, DraftConflict) as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc
    except MatterPersistenceUnavailable as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Matter persistence is temporarily unavailable.",
        ) from exc
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Matter or draft input is invalid.",
        ) from exc
