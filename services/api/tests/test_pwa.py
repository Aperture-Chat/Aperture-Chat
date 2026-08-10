from __future__ import annotations

import base64

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.schemas import Tenant
from app.repositories.deps import get_store

client = TestClient(app)

# Smallest valid PNG (1x1 transparent pixel) for exercising data-URL uploads.
TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
TINY_PNG_DATA_URL = "data:image/png;base64," + base64.b64encode(TINY_PNG).decode()


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def _tenant() -> Tenant:
    return next(iter(get_store().tenants.values()))


def _reset_branding(tenant: Tenant) -> None:
    tenant.chat_brand_name = None
    tenant.logo_url = None
    tenant.icon_url = None
    tenant.primary_color = "#087d8b"


def test_manifest_serves_aperture_defaults_without_auth() -> None:
    _reset_branding(_tenant())
    response = client.get("/api/pwa/manifest.webmanifest")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/manifest+json")
    payload = response.json()
    assert payload["name"] == "Aperture Chat"
    assert payload["short_name"] == "Aperture"
    assert payload["display"] == "standalone"
    assert payload["start_url"] == "/"
    assert payload["theme_color"] == "#087d8b"
    assert [icon["src"] for icon in payload["icons"]] == [
        "/api/pwa/icon-192.png",
        "/api/pwa/icon-512.png",
    ]
    assert all(icon["purpose"] == "any maskable" for icon in payload["icons"])


def test_manifest_reflects_custom_tenant_branding() -> None:
    tenant = _tenant()
    _reset_branding(tenant)
    tenant.chat_brand_name = "Contoso Legal Workspace"
    tenant.primary_color = "#12355b"
    tenant.icon_url = TINY_PNG_DATA_URL
    payload = client.get("/api/pwa/manifest.webmanifest").json()
    assert payload["name"] == "Contoso Legal Workspace"
    assert payload["short_name"] == "Contoso"
    assert payload["theme_color"] == "#12355b"
    # Uploaded marks carry no mask-safe padding, so maskable is not advertised.
    assert all(icon["purpose"] == "any" for icon in payload["icons"])
    assert all(icon["type"] == "image/png" for icon in payload["icons"])


def test_icon_serves_decoded_custom_data_url() -> None:
    tenant = _tenant()
    _reset_branding(tenant)
    tenant.icon_url = TINY_PNG_DATA_URL
    response = client.get("/api/pwa/icon-192.png")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.content == TINY_PNG


def test_icon_redirects_to_remote_custom_url() -> None:
    tenant = _tenant()
    _reset_branding(tenant)
    tenant.logo_url = "https://cdn.example.com/brand/mark.png"
    response = client.get("/api/pwa/icon-512.png", follow_redirects=False)
    assert response.status_code == 302
    assert response.headers["location"] == "https://cdn.example.com/brand/mark.png"


def test_icon_falls_back_to_default_when_data_url_is_malformed() -> None:
    tenant = _tenant()
    _reset_branding(tenant)
    tenant.icon_url = "data:text/plain;base64,bm90LWFuLWltYWdl"
    response = client.get("/api/pwa/icon-192.png")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.content.startswith(b"\x89PNG")
    # The manifest stays consistent with what the icon endpoint serves.
    payload = client.get("/api/pwa/manifest.webmanifest").json()
    assert all(icon["purpose"] == "any maskable" for icon in payload["icons"])


def test_unknown_icon_size_is_rejected() -> None:
    assert client.get("/api/pwa/icon-256.png").status_code == 404


def test_default_icons_exist_at_declared_sizes() -> None:
    _reset_branding(_tenant())
    for size in (180, 192, 512):
        response = client.get(f"/api/pwa/icon-{size}.png")
        assert response.status_code == 200
        assert response.content.startswith(b"\x89PNG")
