"""Per-tenant PWA manifest and install icons.

Mobile browsers fetch the web app manifest and home-screen icons without a
session, so these endpoints are intentionally unauthenticated and only expose
branding the sign-in screen already shows (/api/auth/options). Serving them
dynamically keeps installed home-screen apps honest: a tenant that replaces
the logo or product name gets its own icon and label, everyone else gets the
Aperture Chat defaults.
"""

from __future__ import annotations

import base64
import binascii
import json
from pathlib import Path
from urllib.parse import unquote_to_bytes

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse, Response

from app.models.schemas import Tenant
from app.core.tenancy import require_request_tenant

router = APIRouter(prefix="/api/pwa", tags=["pwa"])

DEFAULT_BRAND_NAME = "Aperture Chat"
DEFAULT_THEME_COLOR = "#087d8b"
# Manifest short_name is what Android shows under the icon; the spec
# recommends keeping it within roughly 12 characters.
SHORT_NAME_MAX_CHARS = 12

_STATIC_DIR = Path(__file__).resolve().parent.parent / "static" / "pwa"
_DEFAULT_ICON_SIZES = (180, 192, 512)
# Tenants can rebrand at any time, so icons carry only a short public TTL and
# the manifest revalidates on every fetch.
_ICON_CACHE_CONTROL = "public, max-age=300"
_MANIFEST_CACHE_CONTROL = "no-cache"


def _custom_icon_source(tenant: Tenant | None) -> str | None:
    if tenant is None:
        return None
    return (tenant.icon_url or "").strip() or (tenant.logo_url or "").strip() or None


def _decode_image_data_url(value: str) -> tuple[bytes, str] | None:
    """Decode a data:image/... URL into (content, media_type); None if unusable."""
    header, _, encoded = value.partition(",")
    if not encoded:
        return None
    parts = header[len("data:") :].split(";")
    media_type = parts[0].strip().lower() or "image/png"
    if not media_type.startswith("image/"):
        return None
    try:
        if "base64" in (part.strip().lower() for part in parts[1:]):
            content = base64.b64decode(encoded, validate=False)
        else:
            content = unquote_to_bytes(encoded)
    except (ValueError, binascii.Error):
        return None
    if not content:
        return None
    return content, media_type


def _icon_plan(tenant: Tenant | None) -> tuple[str, str | None]:
    """Resolve what the icon endpoints will actually serve so the manifest
    stays truthful: ('custom'|'default', media_type or None when unknown)."""
    source = _custom_icon_source(tenant)
    if source:
        if source.startswith("data:"):
            decoded = _decode_image_data_url(source)
            if decoded:
                return "custom", decoded[1]
            # A malformed upload falls back to the default mark below.
        elif source.startswith(("http://", "https://", "/")):
            return "custom", None
    return "default", "image/png"


def _short_name(name: str) -> str:
    if len(name) <= SHORT_NAME_MAX_CHARS:
        return name
    first_word = name.split()[0]
    return first_word[:SHORT_NAME_MAX_CHARS]


@router.get("/manifest.webmanifest")
def manifest(
    tenant: Tenant = Depends(require_request_tenant),
) -> Response:
    name = ((tenant.chat_brand_name if tenant else None) or "").strip() or DEFAULT_BRAND_NAME
    theme_color = ((tenant.primary_color if tenant else None) or "").strip() or DEFAULT_THEME_COLOR
    icon_kind, icon_media_type = _icon_plan(tenant)
    # Uploaded marks carry no mask-safe padding, so only the generated default
    # tiles advertise the maskable purpose.
    purpose = "any maskable" if icon_kind == "default" else "any"

    icons = []
    for size in (192, 512):
        icon: dict[str, str] = {
            "src": f"/api/pwa/icon-{size}.png",
            "sizes": f"{size}x{size}",
            "purpose": purpose,
        }
        if icon_media_type:
            icon["type"] = icon_media_type
        icons.append(icon)

    payload = {
        "id": "/",
        "name": name,
        "short_name": _short_name(name),
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "background_color": "#ffffff",
        "theme_color": theme_color,
        "icons": icons,
    }
    return Response(
        content=json.dumps(payload),
        media_type="application/manifest+json",
        headers={"Cache-Control": _MANIFEST_CACHE_CONTROL},
    )


@router.get("/icon-{size}.png")
def install_icon(
    size: int,
    tenant: Tenant = Depends(require_request_tenant),
) -> Response:
    if size not in _DEFAULT_ICON_SIZES:
        raise HTTPException(status_code=404, detail="Unknown icon size.")

    source = _custom_icon_source(tenant)
    if source:
        if source.startswith("data:"):
            decoded = _decode_image_data_url(source)
            if decoded:
                content, media_type = decoded
                return Response(
                    content=content,
                    media_type=media_type,
                    headers={"Cache-Control": _ICON_CACHE_CONTROL},
                )
        elif source.startswith(("http://", "https://", "/")):
            return RedirectResponse(source, status_code=302)

    return Response(
        content=(_STATIC_DIR / f"aperture-icon-{size}.png").read_bytes(),
        media_type="image/png",
        headers={"Cache-Control": _ICON_CACHE_CONTROL},
    )
