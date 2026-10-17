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
from io import BytesIO
from pathlib import Path
from urllib.parse import unquote_to_bytes

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse, Response
from PIL import Image, UnidentifiedImageError

from app.models.schemas import Tenant
from app.core.tenancy import require_request_tenant

router = APIRouter(prefix="/api/pwa", tags=["pwa"])

DEFAULT_BRAND_NAME = "Aperture Chat"
DEFAULT_THEME_COLOR = "#087d8b"
# Splash-screen color: the paper tone of the default icon tile and the light
# theme's surfaces (--surface in apps/web/src/workspace-refresh.css).
DEFAULT_BACKGROUND_COLOR = "#f9f7f2"
# Manifest short_name is what Android shows under the icon; the spec
# recommends keeping it within roughly 12 characters.
SHORT_NAME_MAX_CHARS = 12

_STATIC_DIR = Path(__file__).resolve().parent.parent / "static" / "pwa"
_DEFAULT_ICON_SIZES = (180, 192, 512)
# Tenants can rebrand at any time, so icons carry only a short public TTL and
# the manifest revalidates on every fetch.
_ICON_CACHE_CONTROL = "public, max-age=300"
_MANIFEST_CACHE_CONTROL = "no-cache"
# A home-screen icon must be roughly square; a wordmark shrunk to fit is
# unreadable. Mirrors COMPACT_BRAND_MAX_RATIO in apps/web/src/lib/brandIcon.ts.
_COMPACT_ICON_MAX_RATIO = 1.6
# Inline SVG is served from this origin, so it must never run script or load
# anything if someone opens the icon URL directly.
_SVG_ICON_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "X-Content-Type-Options": "nosniff",
}

CustomIcon = tuple[bytes, str] | str


def _custom_icon(tenant: Tenant | None) -> CustomIcon | None:
    """The tenant's install icon: decoded (content, media_type) for an inline
    upload, a URL to redirect to for a hosted icon, or None for the default.

    The separate icon wins. Without a usable one, an uploaded logo stands in
    only when it is roughly square; a hosted logo is skipped because its
    proportions cannot be checked without fetching it."""
    if tenant is None:
        return None
    icon = (tenant.icon_url or "").strip()
    if icon.startswith("data:"):
        decoded = _decode_image_data_url(icon)
        if decoded:
            return decoded
    elif icon.startswith(("http://", "https://", "/")):
        return icon
    logo = (tenant.logo_url or "").strip()
    if logo.startswith("data:"):
        return _decode_image_data_url(logo)
    return None


def _decode_image_data_url(value: str) -> tuple[bytes, str] | None:
    """Decode a roughly square data:image/... URL into (content, media_type);
    None if unusable as an install icon."""
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
    if media_type != "image/svg+xml":
        # Read the dimensions only; the stored artwork is served unchanged.
        try:
            with Image.open(BytesIO(content)) as image:
                width, height = image.size
        except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError):
            return None
        if (
            width <= 0
            or height <= 0
            or width > height * _COMPACT_ICON_MAX_RATIO
            or height > width * _COMPACT_ICON_MAX_RATIO
        ):
            return None
    return content, media_type


def _icon_plan(tenant: Tenant | None) -> tuple[str, str | None]:
    """Resolve what the icon endpoints will actually serve so the manifest
    stays truthful: ('custom'|'default', media_type or None when unknown)."""
    icon = _custom_icon(tenant)
    if isinstance(icon, tuple):
        return "custom", icon[1]
    if icon:
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
        "background_color": DEFAULT_BACKGROUND_COLOR,
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

    icon = _custom_icon(tenant)
    if isinstance(icon, tuple):
        content, media_type = icon
        headers = {"Cache-Control": _ICON_CACHE_CONTROL}
        if media_type == "image/svg+xml":
            headers.update(_SVG_ICON_HEADERS)
        return Response(content=content, media_type=media_type, headers=headers)
    if icon:
        return RedirectResponse(icon, status_code=302)

    return Response(
        content=(_STATIC_DIR / f"aperture-icon-{size}.png").read_bytes(),
        media_type="image/png",
        headers={"Cache-Control": _ICON_CACHE_CONTROL},
    )
