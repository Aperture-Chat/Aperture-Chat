"""Deck brand-template parsing.

POST /api/drafts/deck-template/parse accepts one .pptx/.potx upload and
returns extracted brand data (theme colors, fonts, logo/background candidates,
slide text). The endpoint is a stateless transform: nothing is stored
server-side; the client keeps the result on the user's device.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from starlette.concurrency import run_in_threadpool

from app.core.config import get_settings
from app.core.deck_template_parse import parse_deck_template
from app.core.uploads import validate_upload_within_limit
from app.models.decks import DeckTemplateParseResponse
from app.models.schemas import User
from app.routes.dependencies import current_user

router = APIRouter(prefix="/api/drafts/deck-template", tags=["drafts"])

_ALLOWED_EXTENSIONS = (".pptx", ".potx")
_MACRO_EXTENSIONS = (".pptm", ".potm", ".ppsm")
_ZIP_MAGIC = b"PK\x03\x04"


@router.post("/parse")
async def parse_brand_template(
    file: UploadFile = File(...),
    actor: User = Depends(current_user),
) -> DeckTemplateParseResponse:
    del actor  # Auth is the gate; parsing is per-user stateless work.
    settings = get_settings()
    filename = (file.filename or "template.pptx").strip() or "template.pptx"
    lowered = filename.lower()
    if lowered.endswith(_MACRO_EXTENSIONS):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Macro-enabled presentations are not accepted. Save as .pptx or .potx first.",
        )
    if not lowered.endswith(_ALLOWED_EXTENSIONS):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Upload a .pptx or .potx PowerPoint template.",
        )
    await validate_upload_within_limit(
        file,
        settings.deck_template_upload_max_bytes,
        detail=(
            f"'{filename}' exceeds the {settings.deck_template_upload_max_mb} MB "
            "brand-template upload limit."
        ),
    )
    payload_bytes = await file.read()
    if not payload_bytes.startswith(_ZIP_MAGIC):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The file is not a PowerPoint package.",
        )
    try:
        return await run_in_threadpool(parse_deck_template, filename, payload_bytes)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
