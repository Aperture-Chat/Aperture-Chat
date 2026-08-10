"""Tenant- and source-ACL-protected Review Grid API."""

from __future__ import annotations

import csv
import io
import re
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Response, status
from openpyxl import Workbook

from app.core.policy import (
    assert_group_permission,
    assert_knowledge_access,
    assert_model_access,
)
from app.core.review_runner import ReviewRunConfigurationError, ReviewRunner
from app.core.review_store import (
    ReviewConflict,
    ReviewLimitExceeded,
    ReviewStore,
)
from app.core.usage_budget import UsageBudgetError
from app.core.usage_budget_runtime import (
    UsageProviderExecutionRefused,
    UsageTenantScopeError,
    map_usage_budget_error,
)
from app.models.review import (
    ReviewCell,
    ReviewCellResponse,
    ReviewCitation,
    ReviewMatrix,
    ReviewMatrixCreateRequest,
    ReviewMatrixDetail,
    ReviewMatrixUpdateRequest,
    ReviewRunAccepted,
    review_now,
)
from app.models.schemas import KnowledgeConfig, KnowledgeDocument, Role, User
from app.repositories.deps import get_store
from app.repositories.review_deps import get_review_runner, get_review_store
from app.repositories.seed import SeedStore
from app.routes.dependencies import current_user


router = APIRouter(prefix="/api/review", tags=["review"])


def _usage_budget_http_exception(
    error: UsageBudgetError | UsageProviderExecutionRefused | UsageTenantScopeError,
) -> HTTPException:
    if isinstance(error, UsageTenantScopeError):
        return HTTPException(status_code=error.status_code, detail=error.detail)
    if isinstance(error, UsageProviderExecutionRefused):
        return HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Usage accounting could not safely verify this request. "
                "No new provider execution is authorized."
            ),
        )
    failure = map_usage_budget_error(error)
    return HTTPException(
        status_code=failure.status_code,
        detail=failure.detail,
        headers=dict(failure.headers),
    )


@router.get("/matrices", response_model=list[ReviewMatrix])
def list_matrices(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    review_store: ReviewStore = Depends(get_review_store),
) -> list[ReviewMatrix]:
    matrices: list[ReviewMatrix] = []
    for matrix in review_store.list_matrices(owner_user_id=actor.id):
        try:
            _authorize_matrix(matrix, actor, store)
        except HTTPException:
            # Revoked knowledge access hides the matrix from collection views;
            # direct access returns the corresponding honest 403/404.
            continue
        matrices.append(matrix)
    return matrices


@router.post("/matrices", response_model=ReviewMatrix, status_code=status.HTTP_201_CREATED)
def create_matrix(
    payload: ReviewMatrixCreateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    review_store: ReviewStore = Depends(get_review_store),
) -> ReviewMatrix:
    tenant_id, _ = _validate_selection(
        actor,
        store,
        payload.knowledge_config_ids,
        payload.document_ids,
    )
    _assert_model(actor, store, payload.model_id, tenant_id)
    now = review_now()
    matrix = ReviewMatrix(
        id=f"review-{uuid4()}",
        tenant_id=tenant_id,
        owner_user_id=actor.id,
        name=payload.name.strip(),
        knowledge_config_ids=payload.knowledge_config_ids,
        document_ids=payload.document_ids,
        columns=payload.columns,
        model_id=payload.model_id,
        matter_id=None,
        created_at=now,
        updated_at=now,
    )
    try:
        return review_store.create_matrix(matrix)
    except ReviewConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.get("/matrices/{matrix_id}", response_model=ReviewMatrixDetail)
def get_matrix(
    matrix_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    review_store: ReviewStore = Depends(get_review_store),
) -> ReviewMatrixDetail:
    matrix = _get_authorized_matrix(matrix_id, actor, store, review_store)
    return ReviewMatrixDetail(
        matrix=matrix,
        cells=[
            ReviewCellResponse.from_stored(cell)
            for cell in review_store.cells_for_matrix(matrix.id)
        ],
    )


@router.patch("/matrices/{matrix_id}", response_model=ReviewMatrix)
def update_matrix(
    matrix_id: str,
    payload: ReviewMatrixUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    review_store: ReviewStore = Depends(get_review_store),
) -> ReviewMatrix:
    current = _get_authorized_matrix(matrix_id, actor, store, review_store)
    changes = payload.model_dump(exclude_unset=True)
    changes.pop("matter_id", None)
    analysis_fields = {"knowledge_config_ids", "document_ids", "columns", "model_id"}
    destructive_change = bool(analysis_fields.intersection(changes))
    candidate = current.model_copy(update={**changes, "updated_at": review_now()})
    if destructive_change:
        candidate = candidate.model_copy(
            update={"status": "draft", "started_at": None, "completed_at": None}
        )
    # model_copy does not revalidate cross-field caps, so round-trip through
    # validation before any durable mutation.
    candidate = ReviewMatrix.model_validate(candidate.model_dump())
    _validate_selection(
        actor,
        store,
        candidate.knowledge_config_ids,
        candidate.document_ids,
    )
    _assert_model(actor, store, candidate.model_id, candidate.tenant_id)
    try:
        return review_store.update_matrix(
            candidate,
            clear_cells=destructive_change,
            expected_updated_at=current.updated_at,
        )
    except ReviewConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.delete("/matrices/{matrix_id}")
def delete_matrix(
    matrix_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    review_store: ReviewStore = Depends(get_review_store),
) -> dict[str, str]:
    # Owners may delete an orphaned matrix after a source/config was removed;
    # deletion reveals no stored answers and still enforces owner+tenant scope.
    matrix = _get_owned_matrix(matrix_id, actor, review_store)
    try:
        review_store.delete_matrix(matrix.id)
    except ReviewConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return {"status": "deleted", "id": matrix.id}


@router.post(
    "/matrices/{matrix_id}/run",
    response_model=ReviewRunAccepted,
    status_code=status.HTTP_202_ACCEPTED,
)
def run_matrix(
    matrix_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    review_store: ReviewStore = Depends(get_review_store),
    runner: ReviewRunner = Depends(get_review_runner),
) -> ReviewRunAccepted:
    matrix = _get_authorized_matrix(matrix_id, actor, store, review_store)
    _validate_selection(actor, store, matrix.knowledge_config_ids, matrix.document_ids)
    _assert_model(actor, store, matrix.model_id, matrix.tenant_id)
    try:
        return runner.start_matrix(matrix.id, actor)
    except ReviewLimitExceeded as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(exc),
            headers={"Retry-After": "5"},
        ) from exc
    except ReviewConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except (UsageBudgetError, UsageProviderExecutionRefused, UsageTenantScopeError) as exc:
        raise _usage_budget_http_exception(exc) from exc
    except ReviewRunConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc


@router.post(
    "/matrices/{matrix_id}/cells/{cell_id}/rerun",
    response_model=ReviewRunAccepted,
    status_code=status.HTTP_202_ACCEPTED,
)
def rerun_cell(
    matrix_id: str,
    cell_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    review_store: ReviewStore = Depends(get_review_store),
    runner: ReviewRunner = Depends(get_review_runner),
) -> ReviewRunAccepted:
    matrix = _get_authorized_matrix(matrix_id, actor, store, review_store)
    _validate_selection(actor, store, matrix.knowledge_config_ids, matrix.document_ids)
    _assert_model(actor, store, matrix.model_id, matrix.tenant_id)
    if review_store.get_cell(matrix.id, cell_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown review cell.")
    try:
        return runner.rerun_cell(matrix.id, cell_id, actor)
    except ReviewLimitExceeded as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(exc),
            headers={"Retry-After": "5"},
        ) from exc
    except ReviewConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except (UsageBudgetError, UsageProviderExecutionRefused, UsageTenantScopeError) as exc:
        raise _usage_budget_http_exception(exc) from exc
    except ReviewRunConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc


@router.get("/matrices/{matrix_id}/export.csv")
def export_matrix_csv(
    matrix_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    review_store: ReviewStore = Depends(get_review_store),
) -> Response:
    matrix = _get_authorized_matrix(matrix_id, actor, store, review_store)
    headers, rows = _export_rows(matrix, review_store.cells_for_matrix(matrix.id), store)
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow([_spreadsheet_safe(value) for value in headers])
    writer.writerows([[_spreadsheet_safe(value) for value in row] for row in rows])
    return Response(
        content=output.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{_export_name(matrix.name)}.csv"'},
    )


@router.get("/matrices/{matrix_id}/export.xlsx")
def export_matrix_xlsx(
    matrix_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    review_store: ReviewStore = Depends(get_review_store),
) -> Response:
    matrix = _get_authorized_matrix(matrix_id, actor, store, review_store)
    headers, rows = _export_rows(matrix, review_store.cells_for_matrix(matrix.id), store)
    workbook = Workbook(write_only=True)
    worksheet = workbook.create_sheet("Review")
    worksheet.append([_spreadsheet_safe(value) for value in headers])
    for row in rows:
        worksheet.append([_spreadsheet_safe(value) for value in row])
    output = io.BytesIO()
    workbook.save(output)
    return Response(
        content=output.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{_export_name(matrix.name)}.xlsx"'},
    )


def _get_authorized_matrix(
    matrix_id: str,
    actor: User,
    store: SeedStore,
    review_store: ReviewStore,
) -> ReviewMatrix:
    matrix = _get_owned_matrix(matrix_id, actor, review_store)
    _authorize_matrix(matrix, actor, store)
    return matrix


def _get_owned_matrix(
    matrix_id: str,
    actor: User,
    review_store: ReviewStore,
) -> ReviewMatrix:
    matrix = review_store.get_matrix(matrix_id)
    if matrix is None or matrix.owner_user_id != actor.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown review matrix.")
    if actor.role != Role.PLATFORM_OWNER and actor.tenant_id != matrix.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Review matrix tenant is out of scope.",
        )
    return matrix


def _authorize_matrix(matrix: ReviewMatrix, actor: User, store: SeedStore) -> None:
    if actor.role != Role.PLATFORM_OWNER and actor.tenant_id != matrix.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Review matrix tenant is out of scope.",
        )
    _validate_selection(
        actor,
        store,
        matrix.knowledge_config_ids,
        matrix.document_ids,
    )


def _validate_selection(
    actor: User,
    store: SeedStore,
    config_ids: list[str],
    document_ids: list[str],
) -> tuple[str, dict[str, KnowledgeDocument]]:
    configs = _validated_configs(actor, store, config_ids)
    tenant_id = configs[0].tenant_id
    documents: dict[str, KnowledgeDocument] = {}
    for config in configs:
        for document in store.knowledge_documents_for(config.id):
            if document.id in document_ids:
                documents[document.id] = document
    missing = [document_id for document_id in document_ids if document_id not in documents]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown or inaccessible review document '{missing[0]}'.",
        )
    for document in documents.values():
        if document.tenant_id != tenant_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Every review document must belong to the matrix tenant.",
            )
        if (
            actor.role != Role.PLATFORM_OWNER
            and document.acl_group_ids
            and not set(actor.group_ids).intersection(document.acl_group_ids)
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Review document access is restricted by source ACL policy.",
            )
    return tenant_id, documents


def _validated_configs(
    actor: User,
    store: SeedStore,
    config_ids: list[str],
) -> list[KnowledgeConfig]:
    assert_group_permission(actor, store.groups, "knowledge_access", "Knowledge access")
    configs: list[KnowledgeConfig] = []
    for config_id in config_ids:
        config = store.knowledge_configs.get(config_id)
        if config is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Unknown knowledge configuration '{config_id}'.",
            )
        assert_knowledge_access(actor, config)
        configs.append(config)
    tenant_ids = {config.tenant_id for config in configs}
    if len(tenant_ids) != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Every review knowledge configuration must belong to one tenant.",
        )
    return configs


def _assert_model(actor: User, store: SeedStore, model_id: str, tenant_id: str) -> None:
    model = store.models.get(model_id)
    if model is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown review model.")
    assert_model_access(actor, model)
    if model.tenant_id is not None and model.tenant_id != tenant_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Review model tenant is out of scope for the selected knowledge.",
        )


def _export_rows(
    matrix: ReviewMatrix,
    cells: list[ReviewCell],
    store: SeedStore,
) -> tuple[list[str], list[list[str]]]:
    documents = {
        document.id: document
        for config_id in matrix.knowledge_config_ids
        for document in store.knowledge_documents_for(config_id)
        if document.id in matrix.document_ids
    }
    cells_by_key = {(cell.document_id, cell.column_id): cell for cell in cells}
    headers = ["Document", *[column.label for column in matrix.columns], "Sources"]
    rows: list[list[str]] = []
    for document_id in matrix.document_ids:
        document = documents.get(document_id)
        row = [document.name if document is not None else document_id]
        source_labels: list[str] = []
        seen_sources: set[tuple[str, str, int | None, str | None]] = set()
        for column in matrix.columns:
            cell = cells_by_key.get((document_id, column.id))
            if cell is None:
                row.append("")
                continue
            row.append(cell.answer or (f"ERROR: {cell.error}" if cell.error else cell.status))
            for citation in cell.citations:
                key = (column.id, citation.chunk_id, citation.page_start, citation.locator)
                if key in seen_sources:
                    continue
                seen_sources.add(key)
                source_labels.append(_citation_label(citation, column.label))
        row.append("; ".join(source_labels))
        rows.append(row)
    return headers, rows


def _citation_label(citation: ReviewCitation, column_label: str) -> str:
    locations: list[str] = []
    if citation.page_start is not None:
        if citation.page_end is not None and citation.page_end != citation.page_start:
            locations.append(f"pp. {citation.page_start}-{citation.page_end}")
        else:
            locations.append(f"p. {citation.page_start}")
    if citation.locator:
        locations.append(citation.locator)
    suffix = f" ({', '.join(locations)})" if locations else ""
    return (
        f"{column_label}: [K{citation.k_index}] "
        f"{citation.source_name}{suffix} {citation.source_uri}"
    )


def _export_name(name: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", name.strip()).strip("-.")
    return value or "review-matrix"


def _spreadsheet_safe(value: str) -> str:
    return f"'{value}" if value.startswith(("=", "+", "-", "@")) else value
