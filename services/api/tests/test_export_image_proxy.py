from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.repositories.deps import get_store
from app.routes import assets

client = TestClient(app)

JPEG_BYTES = b"\xff\xd8\xff\xe0fake-jpeg-body"


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


@pytest.fixture(autouse=True)
def reset_transport() -> None:
    yield
    assets.transport = None


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def test_image_proxy_requires_authentication() -> None:
    response = client.get(
        "/api/assets/image-proxy", params={"url": "https://images.example/photo.jpg"}
    )
    assert response.status_code == 401


def test_image_proxy_rejects_non_http_schemes() -> None:
    response = client.get(
        "/api/assets/image-proxy",
        params={"url": "file:///etc/passwd"},
        headers=headers("user-owner"),
    )
    assert response.status_code == 400


def test_image_proxy_blocks_metadata_addresses_in_every_environment() -> None:
    response = client.get(
        "/api/assets/image-proxy",
        params={"url": "http://169.254.169.254/latest/meta-data"},
        headers=headers("user-owner"),
    )
    assert response.status_code == 400


def test_image_proxy_returns_image_bytes() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        assert request.url == httpx.URL("https://images.example/photo.jpg")
        return httpx.Response(200, content=JPEG_BYTES, headers={"content-type": "image/jpeg"})

    assets.transport = httpx.MockTransport(respond)
    response = client.get(
        "/api/assets/image-proxy",
        params={"url": "https://images.example/photo.jpg"},
        headers=headers("user-owner"),
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/jpeg")
    assert response.content == JPEG_BYTES


def test_image_proxy_follows_redirects_like_wikimedia_file_paths() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.host == "commons.example":
            return httpx.Response(301, headers={"location": "https://upload.example/photo.jpg"})
        assert request.url == httpx.URL("https://upload.example/photo.jpg")
        return httpx.Response(200, content=JPEG_BYTES, headers={"content-type": "image/jpeg"})

    assets.transport = httpx.MockTransport(respond)
    response = client.get(
        "/api/assets/image-proxy",
        params={"url": "https://commons.example/wiki/Special:FilePath/photo.jpg"},
        headers=headers("user-owner"),
    )
    assert response.status_code == 200
    assert response.content == JPEG_BYTES


def test_image_proxy_blocks_redirects_into_metadata_space() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "http://169.254.169.254/internal.png"})

    assets.transport = httpx.MockTransport(respond)
    response = client.get(
        "/api/assets/image-proxy",
        params={"url": "https://public.example/photo.jpg"},
        headers=headers("user-owner"),
    )
    assert response.status_code == 400


def test_image_proxy_rejects_non_image_content() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"<html></html>", headers={"content-type": "text/html"})

    assets.transport = httpx.MockTransport(respond)
    response = client.get(
        "/api/assets/image-proxy",
        params={"url": "https://images.example/not-an-image"},
        headers=headers("user-owner"),
    )
    assert response.status_code == 415


def test_image_proxy_rejects_oversized_images() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"x" * (assets.MAX_IMAGE_BYTES + 1),
            headers={"content-type": "image/jpeg"},
        )

    assets.transport = httpx.MockTransport(respond)
    response = client.get(
        "/api/assets/image-proxy",
        params={"url": "https://images.example/huge.jpg"},
        headers=headers("user-owner"),
    )
    assert response.status_code == 413
