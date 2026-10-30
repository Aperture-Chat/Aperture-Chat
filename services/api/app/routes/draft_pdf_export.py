"""Drafts PDF export: queue a build, follow it, download it, free it."""

from __future__ import annotations

import tempfile
import zlib
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from app.core.config import get_settings
from app.core.draft_pdf_exports import (
    DraftPdfExportBusy,
    DraftPdfExportLimit,
    DraftPdfExportNotFound,
    DraftPdfExportNotReady,
    DraftPdfExportService,
    ExportLimits,
    ExportOwner,
)
from app.core.uploads import read_upload_within_limit
from app.models.draft_pdf_export import DraftPdfExportJob, DraftPdfSource
from app.models.schemas import User
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore
from app.routes.dependencies import current_user

router = APIRouter(prefix="/api/drafts/pdf-exports", tags=["drafts"])

PER_USER_ACTIVE = 2
_UNREADABLE = "The document could not be read for PDF export."


@lru_cache(maxsize=1)
def get_draft_pdf_export_service() -> DraftPdfExportService:
    settings = get_settings()
    return DraftPdfExportService(
        Path(tempfile.gettempdir()) / "aperture-pdf-exports",
        ExportLimits(
            concurrency=settings.draft_pdf_export_concurrency,
            queue_max=settings.draft_pdf_export_queue_max,
            per_user_active=PER_USER_ACTIVE,
            timeout_seconds=settings.draft_pdf_export_timeout_seconds,
            retention_seconds=settings.draft_pdf_export_retention_minutes * 60,
        ),
    )


def _owner(actor: User) -> ExportOwner:
    return ExportOwner(tenant_id=actor.tenant_id, user_id=actor.id, display_name=actor.display_name)


def _decode_source(payload: bytes, limit: int, too_large: str) -> DraftPdfSource:
    """Parse the upload once, here. Gzip is inflated with the same ceiling as
    the upload itself, so a small compressed body cannot expand without bound."""
    data = payload
    if payload[:2] == b"\x1f\x8b":
        inflater = zlib.decompressobj(wbits=zlib.MAX_WBITS | 16)
        try:
            data = inflater.decompress(payload, limit + 1)
        except zlib.error as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, _UNREADABLE) from exc
        if len(data) > limit or inflater.unconsumed_tail:
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, too_large)
        if not inflater.eof:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, _UNREADABLE)
    try:
        return DraftPdfSource.model_validate_json(data)
    except ValidationError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, _UNREADABLE) from exc


@router.post("", status_code=status.HTTP_202_ACCEPTED)
async def start_pdf_export(
    source: UploadFile = File(...),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    service: DraftPdfExportService = Depends(get_draft_pdf_export_service),
) -> DraftPdfExportJob:
    limit_mb = get_settings().draft_pdf_export_source_max_mb
    limit = limit_mb * 1024 * 1024
    too_large = f"This document is larger than the {limit_mb} MB PDF export limit."
    payload = await read_upload_within_limit(source, limit, detail=too_large)
    document = await run_in_threadpool(_decode_source, payload, limit, too_large)
    del payload
    title = document.title

    async def record_export(job: DraftPdfExportJob) -> None:
        await run_in_threadpool(
            store.record_audit,
            actor,
            "draft.pdf_exported",
            job.id,
            {
                "title": title,
                "pages": job.page_count,
                "bytes": job.size_bytes,
                "conformance": job.conformance,
            },
        )

    try:
        return service.submit(_owner(actor), document, on_ready=record_export)
    except DraftPdfExportLimit as exc:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"You already have {PER_USER_ACTIVE} PDF exports in progress. "
            "Wait for one to finish, then try again.",
        ) from exc
    except DraftPdfExportBusy as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "The PDF renderer is busy with other exports. Try again in a minute.",
            headers={"Retry-After": "30"},
        ) from exc


@router.get("/{job_id}")
async def get_pdf_export(
    job_id: str,
    actor: User = Depends(current_user),
    service: DraftPdfExportService = Depends(get_draft_pdf_export_service),
) -> DraftPdfExportJob:
    try:
        return service.status(_owner(actor), job_id)
    except DraftPdfExportNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "PDF export not found.") from exc


@router.get("/{job_id}/file")
async def download_pdf_export(
    job_id: str,
    actor: User = Depends(current_user),
    service: DraftPdfExportService = Depends(get_draft_pdf_export_service),
) -> FileResponse:
    try:
        path, filename = service.ready_file(_owner(actor), job_id)
    except DraftPdfExportNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "PDF export not found.") from exc
    except DraftPdfExportNotReady as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, "This PDF is not ready yet.") from exc
    return FileResponse(
        path,
        media_type="application/pdf",
        filename=filename,
        headers={"Cache-Control": "no-store"},
    )


@router.delete("/{job_id}", status_code=status.HTTP_204_NO_CONTENT)
async def discard_pdf_export(
    job_id: str,
    actor: User = Depends(current_user),
    service: DraftPdfExportService = Depends(get_draft_pdf_export_service),
) -> Response:
    try:
        service.discard(_owner(actor), job_id)
    except DraftPdfExportNotFound as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "PDF export not found.") from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)
