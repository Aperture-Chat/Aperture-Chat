"""Authenticated remote-image proxy for document export embedding.

Draft pictures often live on hosts that do not send CORS headers (or that
redirect through hosts that don't), which taints the browser canvas and
silently drops the photo from Word/PDF exports. The web app rasterizes
export images through this endpoint instead, so downloaded documents can
embed exactly what the draft preview shows.
"""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator

from app.core.licensed_pictures import PictureSearchUnavailable, find_licensed_pictures
from app.core.net_guard import REDIRECT_GUARD_HOOKS, EgressBlocked, validate_public_url
from app.models.schemas import User
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore
from app.routes.dependencies import current_user

router = APIRouter(prefix="/api/assets", tags=["assets"])

MAX_IMAGE_BYTES = 15 * 1024 * 1024
MAX_REDIRECTS = 5
FETCH_TIMEOUT_SECONDS = 8.0

# Test hook: unit tests install an httpx.MockTransport here so proxy behavior
# is exercised without real network access.
transport: httpx.BaseTransport | None = None


@router.get("/image-proxy")
def proxy_export_image(
    url: str = Query(..., min_length=1, max_length=2000),
    _user: User = Depends(current_user),
) -> Response:
    try:
        validate_public_url(url)
    except EgressBlocked as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    request_headers = {
        "User-Agent": "ApertureChat-DocumentExport/1.0",
        "Accept": "image/*,*/*;q=0.5",
    }
    try:
        with httpx.Client(
            timeout=FETCH_TIMEOUT_SECONDS,
            follow_redirects=True,
            max_redirects=MAX_REDIRECTS,
            trust_env=False,
            headers=request_headers,
            # Re-validates every hop so a public URL cannot redirect the proxy
            # into metadata/internal address space.
            event_hooks=REDIRECT_GUARD_HOOKS,
            transport=transport,
        ) as client:
            with client.stream("GET", url) as response:
                if response.status_code != 200:
                    raise HTTPException(
                        status_code=502,
                        detail=f"Image host returned HTTP {response.status_code}",
                    )
                content_type = (
                    (response.headers.get("content-type") or "").split(";")[0].strip().lower()
                )
                if not content_type.startswith("image/"):
                    raise HTTPException(status_code=415, detail="The URL did not return an image")
                declared_length = response.headers.get("content-length")
                if declared_length and declared_length.isdigit() and int(declared_length) > MAX_IMAGE_BYTES:
                    raise HTTPException(status_code=413, detail="Image exceeds the 15 MB proxy limit")
                body = bytearray()
                for chunk in response.iter_bytes():
                    body.extend(chunk)
                    if len(body) > MAX_IMAGE_BYTES:
                        raise HTTPException(
                            status_code=413, detail="Image exceeds the 15 MB proxy limit"
                        )
                return Response(
                    content=bytes(body),
                    media_type=content_type,
                    headers={"Cache-Control": "private, max-age=300"},
                )
    except EgressBlocked as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except httpx.TooManyRedirects as error:
        raise HTTPException(status_code=502, detail="Image host redirected too many times") from error
    except httpx.HTTPError as error:
        raise HTTPException(
            status_code=502, detail="The image could not be fetched from its host"
        ) from error


class LicensedPictureRequest(BaseModel):
    query: str = Field(min_length=1, max_length=300)
    # The paper's subject, searched when the precise description finds nothing.
    subject: str | None = Field(default=None, max_length=120)
    limit: int = Field(default=1, ge=1, le=4)

    @field_validator("query")
    @classmethod
    def _real_words(cls, value: str) -> str:
        cleaned = " ".join(value.split())
        if len(cleaned) < 2:
            raise ValueError("Describe the picture to search for.")
        return cleaned


class LicensedPictureOut(BaseModel):
    data_url: str
    alt: str
    credit: str
    license: str
    artist: str
    source_url: str


class LicensedPictureResponse(BaseModel):
    pictures: list[LicensedPictureOut]


@router.post("/licensed-pictures")
def find_pictures(
    payload: LicensedPictureRequest,
    user: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> LicensedPictureResponse:
    """Freely licensed photos (Wikimedia Commons) ready to place in a draft,
    each with the credit line its license asks for. An empty list means
    nothing suitable was found, not an error."""

    # The words sent outside the deployment are recorded before they leave.
    store.record_audit(
        user,
        "assets.licensed_picture_search",
        "wikimedia-commons",
        {"query": payload.query, "subject": payload.subject},
    )
    try:
        found = find_licensed_pictures(
            payload.query, limit=payload.limit, subject=payload.subject, transport=transport
        )
    except PictureSearchUnavailable as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    return LicensedPictureResponse(
        pictures=[
            LicensedPictureOut(
                data_url=picture.data_url,
                alt=picture.alt,
                credit=picture.credit,
                license=picture.license,
                artist=picture.artist,
                source_url=picture.source_url,
            )
            for picture in found
        ]
    )
