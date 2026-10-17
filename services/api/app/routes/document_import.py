"""Stateless document imports for the Drafts editor."""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from starlette.concurrency import run_in_threadpool

from app.core.config import get_settings
from app.core.pdf_document_import import PdfImportBusyError, PdfReadError, import_pdf_document
from app.core.uploads import validate_upload_within_limit
from app.models.document_import import DocumentImportResponse
from app.models.schemas import User
from app.routes.dependencies import current_user

router = APIRouter(prefix="/api/drafts/document-import", tags=["drafts"])


@router.post("/pdf")
async def import_pdf(
    file: UploadFile = File(...),
    actor: User = Depends(current_user),
) -> DocumentImportResponse:
    del actor  # Auth is the gate; conversion is stateless and per-request.
    settings = get_settings()
    filename = (file.filename or "document.pdf").strip() or "document.pdf"
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Upload a PDF file.",
        )
    await validate_upload_within_limit(
        file,
        settings.document_import_upload_max_bytes,
        detail=(
            f"'{filename}' exceeds the {settings.document_import_upload_max_mb} MB "
            "document import upload limit."
        ),
    )
    payload_bytes = await file.read()
    if not payload_bytes[:1029].lstrip().startswith(b"%PDF-"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The file is not a PDF.",
        )
    try:
        return await run_in_threadpool(import_pdf_document, filename, payload_bytes)
    except PdfReadError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    except PdfImportBusyError as exc:
        # Conversions are capped so they cannot exhaust the shared threadpool.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
            headers={"Retry-After": "10"},
        ) from exc
