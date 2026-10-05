"""Admin endpoints for personal-data protection and training datasets.

Both features govern one organization at a time and follow the retention
and memory administration scope: tenant admins manage their own tenant, and
a platform owner previewing the admin console manages the primary tenant.
Example content follows prompt-activity visibility, so a tenant admin never
reads or exports another administrator's conversations.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response

from app.core import clock
from app.core.personal_data import ALL_CATEGORIES, CATEGORY_LABELS, conceal, detector_catalog
from app.core.retention import SUBJECT_TAXONOMY
from app.core.training_capture import TASK_LABELS, TASK_TYPES, capture_thread, practice_area_label
from app.core.training_datasets import FORMAT_LABELS, SIGNAL_LABELS, export_bundle, overview, route, slug
from app.models.schemas import (
    PrivacyDetectionSummary,
    PrivacyPreviewRequest,
    PrivacyPreviewResponse,
    Role,
    TenantPrivacyPolicy,
    TenantPrivacyPolicyUpdateRequest,
    TrainingCapturePolicy,
    TrainingCapturePolicyUpdateRequest,
    TrainingDataset,
    TrainingDatasetWriteRequest,
    TrainingExample,
    TrainingExampleReviewRequest,
    TrainingScanResult,
    User,
)
from app.repositories.data_protection import new_dataset_id
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore
from app.routes.admin import _admin_visible_user_ids, _memory_admin_tenant_id
from app.routes.dependencies import current_user

router = APIRouter(prefix="/api/admin", tags=["data-protection"])

SCAN_PAGE_SIZE = 100
EXAMPLE_PAGE_LIMIT = 500


# --- personal-data protection --------------------------------------------------


@router.get("/privacy/policy")
def privacy_policy(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> TenantPrivacyPolicy:
    tenant_id = _memory_admin_tenant_id(actor, store)
    return store.data_protection_repository.privacy_policy(tenant_id)


@router.patch("/privacy/policy")
def update_privacy_policy(
    payload: TenantPrivacyPolicyUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> TenantPrivacyPolicy:
    tenant_id = _memory_admin_tenant_id(actor, store)
    repository = store.data_protection_repository
    policy = repository.privacy_policy(tenant_id)
    updates = {key: value for key, value in payload.model_dump(exclude_unset=True).items() if value is not None}
    if "categories" in updates:
        categories = [category for category in ALL_CATEGORIES if category in set(updates["categories"])]
        if not categories:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Choose at least one kind of personal data to conceal.",
            )
        updates["categories"] = categories
    merged = policy.model_copy(
        update={**updates, "updated_at": clock.now_iso(), "updated_by": actor.id}
    )
    saved = repository.save_privacy_policy(merged)
    store.record_audit(
        actor,
        "privacy.policy_updated",
        tenant_id,
        {
            "changed": sorted(updates),
            "enabled": saved.enabled,
            "categories": saved.categories,
            "conceal_from_model": saved.conceal_from_model,
        },
    )
    return saved


@router.get("/privacy/detectors")
def privacy_detectors(actor: User = Depends(current_user), store: SeedStore = Depends(get_store)) -> dict:
    _memory_admin_tenant_id(actor, store)
    return {
        "categories": [{"id": key, "label": label} for key, label in CATEGORY_LABELS.items()],
        "detectors": detector_catalog(),
    }


@router.post("/privacy/preview")
def preview_privacy(
    payload: PrivacyPreviewRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> PrivacyPreviewResponse:
    """Dry run on administrator-supplied text. Nothing is stored or audited
    with the sample, so admins can test with realistic synthetic values."""
    tenant_id = _memory_admin_tenant_id(actor, store)
    categories = payload.categories or store.data_protection_repository.privacy_policy(tenant_id).categories
    result = conceal(payload.sample, categories)
    return PrivacyPreviewResponse(
        concealed_sample=result.text,
        detections=[PrivacyDetectionSummary(**item) for item in result.labels()],
    )


# --- training capture ------------------------------------------------------------


@router.get("/training/policy")
def training_policy(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> TrainingCapturePolicy:
    tenant_id = _memory_admin_tenant_id(actor, store)
    return store.data_protection_repository.training_policy(tenant_id)


@router.patch("/training/policy")
def update_training_policy(
    payload: TrainingCapturePolicyUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> TrainingCapturePolicy:
    tenant_id = _memory_admin_tenant_id(actor, store)
    repository = store.data_protection_repository
    updates = {key: value for key, value in payload.model_dump(exclude_unset=True).items() if value is not None}
    if "excluded_group_ids" in updates:
        known = {group.id for group in store.groups.values() if group.tenant_id == tenant_id}
        unknown = set(updates["excluded_group_ids"]) - known
        if unknown:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Choose groups from this organization.")
    merged = repository.training_policy(tenant_id).model_copy(
        update={**updates, "updated_at": clock.now_iso(), "updated_by": actor.id}
    )
    saved = repository.save_training_policy(merged)
    store.record_audit(
        actor,
        "training.policy_updated",
        tenant_id,
        {"changed": sorted(updates), "enabled": saved.enabled, "require_review": saved.require_review},
    )
    return saved


@router.get("/training/taxonomy")
def training_taxonomy(actor: User = Depends(current_user), store: SeedStore = Depends(get_store)) -> dict:
    _memory_admin_tenant_id(actor, store)
    practice_areas: list[dict[str, str]] = []
    for primary, subtypes in SUBJECT_TAXONOMY.items():
        practice_areas.append({"key": primary, "label": practice_area_label(primary)})
        practice_areas.extend(
            {"key": f"{primary}/{subtype}", "label": practice_area_label(f"{primary}/{subtype}")}
            for subtype in subtypes
        )
    return {
        "practice_areas": practice_areas,
        "task_types": [{"key": key, "label": TASK_LABELS[key]} for key in TASK_TYPES],
        "signals": [{"key": key, "label": label} for key, label in SIGNAL_LABELS.items()],
        "formats": [{"key": key, "label": label} for key, label in FORMAT_LABELS.items()],
    }


def _group_names(store: SeedStore, tenant_id: str) -> dict[str, str]:
    return {group.id: group.name for group in store.groups.values() if group.tenant_id == tenant_id}


def _visible_examples(store: SeedStore, actor: User, tenant_id: str) -> list[TrainingExample]:
    examples = store.data_protection_repository.list_examples(tenant_id)
    if actor.role == Role.PLATFORM_OWNER:
        return examples
    visible = _admin_visible_user_ids(actor, store)
    return [example for example in examples if example.user_id in visible]


def _routed(store: SeedStore, actor: User, tenant_id: str) -> tuple[list[TrainingDataset], list[TrainingExample]]:
    datasets = store.data_protection_repository.list_datasets(tenant_id)
    return route(datasets, _visible_examples(store, actor, tenant_id))


@router.get("/training/overview")
def training_overview(actor: User = Depends(current_user), store: SeedStore = Depends(get_store)) -> dict:
    tenant_id = _memory_admin_tenant_id(actor, store)
    datasets, examples = _routed(store, actor, tenant_id)
    return {
        **overview(examples, datasets, _group_names(store, tenant_id)),
        "datasets": [dataset.model_dump(mode="json") for dataset in datasets],
    }


def _validated_dataset_fields(store: SeedStore, tenant_id: str, payload: TrainingDatasetWriteRequest) -> dict:
    valid_practices = {primary for primary in SUBJECT_TAXONOMY} | {
        f"{primary}/{subtype}" for primary, subtypes in SUBJECT_TAXONOMY.items() for subtype in subtypes
    }
    rules = payload.rules
    if set(rules.practice_areas) - valid_practices:
        raise HTTPException(status_code=422, detail="Choose practice areas from the subject taxonomy.")
    if set(rules.task_types) - set(TASK_TYPES):
        raise HTTPException(status_code=422, detail="Choose known work types.")
    if set(rules.group_ids) - set(_group_names(store, tenant_id)):
        raise HTTPException(status_code=422, detail="Choose departments from this organization.")
    if set(rules.model_ids) - set(store.models):
        raise HTTPException(status_code=422, detail="Choose models from this workspace.")
    name = " ".join(payload.name.split())
    if len(name) < 2:
        raise HTTPException(status_code=422, detail="Give the dataset a name.")
    return {
        "name": name,
        "description": payload.description.strip(),
        "format": payload.format,
        "rules": rules,
        "system_prompt": payload.system_prompt.strip(),
        "archived": payload.archived,
    }


@router.post("/training/datasets", status_code=201)
def create_training_dataset(
    payload: TrainingDatasetWriteRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> TrainingDataset:
    tenant_id = _memory_admin_tenant_id(actor, store)
    fields = _validated_dataset_fields(store, tenant_id, payload)
    now = clock.now()
    dataset = store.data_protection_repository.save_dataset(
        TrainingDataset(
            id=new_dataset_id(),
            tenant_id=tenant_id,
            created_by=actor.id,
            created_at=now,
            updated_at=now,
            **fields,
        )
    )
    store.record_audit(
        actor,
        "training.dataset_created",
        dataset.id,
        {"name": dataset.name, "format": dataset.format, "rules": dataset.rules.model_dump(mode="json")},
    )
    return dataset


@router.put("/training/datasets/{dataset_id}")
def update_training_dataset(
    dataset_id: str,
    payload: TrainingDatasetWriteRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> TrainingDataset:
    tenant_id = _memory_admin_tenant_id(actor, store)
    repository = store.data_protection_repository
    existing = repository.get_dataset(dataset_id, tenant_id=tenant_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Unknown dataset.")
    fields = _validated_dataset_fields(store, tenant_id, payload)
    saved = repository.save_dataset(existing.model_copy(update={**fields, "updated_at": clock.now()}))
    store.record_audit(
        actor,
        "training.dataset_updated",
        saved.id,
        {"name": saved.name, "format": saved.format, "archived": saved.archived, "rules": saved.rules.model_dump(mode="json")},
    )
    return saved


@router.delete("/training/datasets/{dataset_id}")
def delete_training_dataset(
    dataset_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    """Deletes the dataset definition only; its examples stay captured and
    keep routing to any other dataset whose rules they match."""
    tenant_id = _memory_admin_tenant_id(actor, store)
    repository = store.data_protection_repository
    existing = repository.get_dataset(dataset_id, tenant_id=tenant_id)
    if existing is None or not repository.delete_dataset(dataset_id, tenant_id=tenant_id):
        raise HTTPException(status_code=404, detail="Unknown dataset.")
    store.record_audit(actor, "training.dataset_deleted", dataset_id, {"name": existing.name})
    return {"status": "deleted", "id": dataset_id}


@router.get("/training/examples")
def training_examples(
    status_filter: Literal["pending", "approved", "excluded"] | None = Query(default=None, alias="status"),
    signal: Literal["positive", "negative", "correction"] | None = None,
    dataset_id: str | None = None,
    practice_area: str | None = None,
    unrouted: bool = False,
    limit: int = Query(default=100, ge=1, le=EXAMPLE_PAGE_LIMIT),
    offset: int = Query(default=0, ge=0),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict:
    tenant_id = _memory_admin_tenant_id(actor, store)
    _datasets, examples = _routed(store, actor, tenant_id)
    filtered = [
        example
        for example in examples
        if (status_filter is None or example.status == status_filter)
        and (signal is None or example.signal == signal)
        and (dataset_id is None or dataset_id in example.dataset_ids)
        and (
            practice_area is None
            or example.practice_area == practice_area
            or example.practice_area.startswith(f"{practice_area}/")
            or (practice_area == "" and not example.practice_area)
        )
        and (not unrouted or not example.dataset_ids)
    ]
    names = {user.id: user.display_name for user in store.users.values()}
    page = [
        example.model_copy(update={"user_name": names.get(example.user_id, "Former user")})
        for example in filtered[offset : offset + limit]
    ]
    return {"total": len(filtered), "items": [item.model_dump(mode="json") for item in page]}


@router.post("/training/examples/review")
def review_training_examples(
    payload: TrainingExampleReviewRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, int]:
    tenant_id = _memory_admin_tenant_id(actor, store)
    visible_ids = {example.id for example in _visible_examples(store, actor, tenant_id)}
    ids = [example_id for example_id in payload.example_ids if example_id in visible_ids]
    changed = store.data_protection_repository.review_examples(
        tenant_id=tenant_id, example_ids=ids, status=payload.status, reviewer_id=actor.id
    )
    store.record_audit(
        actor,
        "training.examples_reviewed",
        tenant_id,
        {"status": payload.status, "count": changed},
        runtime_state_changed=False,
    )
    return {"reviewed": changed}


@router.post("/training/scan")
def scan_training_chats(
    after: str = "",
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> TrainingScanResult:
    """Capture signals from chats saved before capture was turned on, one
    page at a time so a large organization never ties up a request."""
    tenant_id = _memory_admin_tenant_id(actor, store)
    if not store.data_protection_repository.training_policy(tenant_id).enabled:
        raise HTTPException(status_code=409, detail="Turn on training capture before scanning existing chats.")
    threads = store.application_state_repository.retention_scan_page(tenant_id, after=after, limit=SCAN_PAGE_SIZE)
    captured = sum(capture_thread(store, thread) for thread in threads)
    store.record_audit(
        actor,
        "training.chats_scanned",
        tenant_id,
        {"scanned": len(threads), "captured": captured},
        runtime_state_changed=False,
    )
    return TrainingScanResult(
        scanned=len(threads),
        captured=captured,
        next_after=threads[-1].id if len(threads) == SCAN_PAGE_SIZE else None,
    )


@router.get("/training/datasets/{dataset_id}/export")
def export_training_dataset(
    dataset_id: str,
    include_pending: bool = False,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> Response:
    tenant_id = _memory_admin_tenant_id(actor, store)
    dataset = store.data_protection_repository.get_dataset(dataset_id, tenant_id=tenant_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Unknown dataset.")
    tenant = store.tenants.get(tenant_id)
    generated_at = clock.now()
    bundle, stats = export_bundle(
        dataset,
        _visible_examples(store, actor, tenant_id),
        group_names=_group_names(store, tenant_id),
        organization=tenant.name if tenant is not None else tenant_id,
        generated_at=generated_at,
        include_pending=include_pending,
    )
    store.record_audit(
        actor,
        "training.dataset_exported",
        dataset.id,
        {"name": dataset.name, "format": dataset.format, "include_pending": include_pending, **stats},
    )
    filename = f"{slug(dataset.name)}-{generated_at.strftime('%Y%m%d-%H%M')}.zip"
    return Response(
        content=bundle,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )
