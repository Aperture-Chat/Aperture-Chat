"""User-owned personalization memory.

Every route here operates on the caller's own memories and nothing else. There
is no path -- for admins or for platform owners -- through which one account
reads another's memory content; the content-free admin surfaces live in
``routes/admin.py`` instead.

Cross-user lookups deliberately answer 404 rather than 403 so a caller cannot
probe for the existence of somebody else's memory.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.core import clock
from app.core.memory import (
    build_memory,
    enforce_caps,
    looks_sensitive,
    memory_state_for,
    normalize_content,
)
from app.models.schemas import (
    MemoryCollectionResponse,
    User,
    UserMemory,
    UserMemoryCreateRequest,
    UserMemorySettings,
    UserMemorySettingsUpdateRequest,
    UserMemoryUpdateRequest,
)
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore
from app.routes.dependencies import current_user

router = APIRouter(prefix="/api/memory", tags=["memory"])


def _require_memory_enabled(store: SeedStore, actor: User):
    state = memory_state_for(store, actor)
    if not state.enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=state.reason or "Memory is not available for your account.",
        )
    return state


def _audit_metadata(memory: UserMemory) -> dict[str, object]:
    """Audit records identify a memory without ever recording its content."""
    return {"memory_id": memory.id, "kind": memory.kind.value, "source": memory.source}


@router.get("", response_model=MemoryCollectionResponse)
def list_memories(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> MemoryCollectionResponse:
    """The caller's own memories plus why memory is (or is not) active.

    Readable even when memory is disabled so the manager can explain the state
    and still let someone review or delete what was stored before it was
    turned off.
    """
    state = memory_state_for(store, actor)
    return MemoryCollectionResponse(
        state=state.as_response(),
        settings=store.user_memory_settings_for(actor.id),
        memories=store.memories_for_user(actor),
    )


@router.post("", response_model=UserMemory, status_code=status.HTTP_201_CREATED)
def create_memory(
    payload: UserMemoryCreateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> UserMemory:
    state = _require_memory_enabled(store, actor)
    content = normalize_content(payload.content)
    if len(content) < 4:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Write a little more so the memory is useful later.",
        )
    if looks_sensitive(content):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Memories cannot contain credentials, keys, or sensitive identifiers.",
        )
    # Pinned memories are exempt from eviction, so once they fill the cap no
    # insert can ever be reclaimed — reject up front instead of growing the
    # store past the tenant limit forever.
    cap = max(state.policy.max_memories_per_user, 1)
    pinned_active = sum(
        1 for existing in store.memories_for_user(actor) if existing.active and existing.pinned
    )
    if pinned_active >= cap:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "Pinned memories already fill your memory limit. "
                "Unpin or forget one before saving more."
            ),
        )
    memory = build_memory(
        actor=actor,
        content=content,
        kind=payload.kind,
        source="explicit",
        policy=state.policy,
        confidence=1.0,
        pinned=payload.pinned,
    )
    if memory is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="That memory kind is disabled by your organization's policy.",
        )
    store.user_memories[memory.id] = memory
    for retired in enforce_caps(store.memories_for_user(actor), state.policy):
        record = store.user_memories.get(retired.id)
        if record is not None and record.id != memory.id:
            record.active = False
    store.save_runtime_state()
    store.record_audit(actor, "memory.created", memory.id, _audit_metadata(memory))
    return memory


@router.get("/settings", response_model=UserMemorySettings)
def memory_settings(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> UserMemorySettings:
    return store.user_memory_settings_for(actor.id)


@router.patch("/settings", response_model=UserMemorySettings)
def update_memory_settings(
    payload: UserMemorySettingsUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> UserMemorySettings:
    settings = store.user_memory_settings_for(actor.id)
    updates = payload.model_dump(exclude_unset=True)
    for field, value in updates.items():
        if value is not None:
            setattr(settings, field, value)
    saved = store.save_user_memory_settings(settings)
    store.record_audit(
        actor,
        "memory.settings_updated",
        actor.id,
        {"enabled": saved.enabled, "auto_capture_enabled": saved.auto_capture_enabled},
    )
    return saved


@router.post("/purge")
def purge_memories(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, int]:
    """Forget everything. Available even when memory is switched off."""
    settings = store.user_memory_settings_for(actor.id)
    removed = store.purge_user_memories(actor.id)
    # purge_user_memories drops the settings row too; the user's own on/off
    # choice should survive a purge.
    store.save_user_memory_settings(settings)
    store.record_audit(actor, "memory.purged", actor.id, {"removed": removed})
    return {"removed": removed}


# Parameterised routes come last so /settings and /purge are never captured as
# a memory id.
@router.patch("/{memory_id}", response_model=UserMemory)
def update_memory(
    memory_id: str,
    payload: UserMemoryUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> UserMemory:
    memory = store.memory_for_user(actor, memory_id)
    if memory is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown memory.")
    record = store.user_memories[memory_id]

    if payload.content is not None:
        content = normalize_content(payload.content)
        if len(content) < 4:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Write a little more so the memory is useful later.",
            )
        if looks_sensitive(content):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Memories cannot contain credentials, keys, or sensitive identifiers.",
            )
        record.content = content
        # An edited memory is a stated one, so it earns full confidence.
        record.source = "explicit"
        record.confidence = 1.0
    if payload.kind is not None:
        record.kind = payload.kind
    if payload.pinned is not None:
        record.pinned = payload.pinned
    record.updated_at = clock.now_iso()

    store.save_runtime_state()
    store.record_audit(actor, "memory.updated", record.id, _audit_metadata(record))
    return store.memory_for_user(actor, memory_id)


@router.delete("/{memory_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_memory(
    memory_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> None:
    memory = store.memory_for_user(actor, memory_id)
    if memory is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown memory.")
    store.deactivate_user_memory(memory_id)
    store.record_audit(actor, "memory.deleted", memory_id, _audit_metadata(memory))
