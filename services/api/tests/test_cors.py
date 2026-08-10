from __future__ import annotations

from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient
import pytest

from app.core.config import Settings, get_settings
from app.main import app
from app.routes import auth, connector_oauth


def _settings_with_origins(origins: str) -> Settings:
    return Settings(
        environment="test",
        secret_key="test-cors-signing-secret",
        web_origins=origins,
    )


def test_web_origin_list_normalizes_configured_origins() -> None:
    settings = _settings_with_origins(
        " https://chat.example.test/, http://127.0.0.1:5173///, ,https://admin.example.test "
    )

    assert settings.web_origin_list == [
        "https://chat.example.test",
        "http://127.0.0.1:5173",
        "https://admin.example.test",
    ]


def test_main_cors_uses_configured_web_origins() -> None:
    configured_origins = get_settings().web_origin_list
    assert configured_origins
    cors_middleware = next(
        middleware for middleware in app.user_middleware if middleware.cls is CORSMiddleware
    )
    assert cors_middleware.kwargs["allow_origins"] == configured_origins

    client = TestClient(app)
    allowed_origin = configured_origins[0]
    allowed = client.options(
        "/health",
        headers={
            "Origin": allowed_origin,
            "Access-Control-Request-Method": "GET",
        },
    )
    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == allowed_origin
    assert allowed.headers["access-control-allow-credentials"] == "true"

    denied = client.options(
        "/health",
        headers={
            "Origin": "https://not-configured.example.test",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert "access-control-allow-origin" not in denied.headers


def test_callback_origin_helpers_share_settings_parser(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = _settings_with_origins(
        " https://chat.example.test/,https://admin.example.test/ "
    )
    monkeypatch.setattr(auth, "get_settings", lambda: settings)
    monkeypatch.setattr(connector_oauth, "get_settings", lambda: settings)

    assert auth._allowed_web_origins() == settings.web_origin_list
    assert connector_oauth._web_origin() == settings.web_origin_list[0]
