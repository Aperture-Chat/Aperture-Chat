"""Image generation and dictation transcription through the model gateway.

The gateway is exercised with httpx.MockTransport so no real provider call is
made; storage is redirected to a temp directory so generated image files never
land in the repo data dir.
"""

from __future__ import annotations

import base64
import json
import time
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.model_gateway import ModelGatewayClient
from app.core.generated_images import save_generated_image
from app.core.sessions import sign_asset_token
from app.db.orm import TenantUsagePermitRow
from app.main import app
from app.models.schemas import ModelConfig, Tenant
from app.repositories.deps import get_store
from app.routes.chat import _is_image_generation_model, _requested_image_count

client = TestClient(app)

PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
PNG_DATA_URL = "data:image/png;base64," + base64.b64encode(PNG_BYTES).decode()


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


@pytest.fixture(autouse=True)
def isolated_image_dir(tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        "app.core.generated_images.get_settings",
        lambda: SimpleNamespace(runtime_state_path=str(tmp_path / "runtime_state.json")),
    )


def headers(user_id: str = "user-admin") -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _daily_usage():
    return get_store().usage_budget_repository.get_daily_usage(
        "tenant-example",
        datetime.now(UTC).date(),
    )


def _permit_statuses() -> list[str]:
    repository = get_store().usage_budget_repository
    with Session(repository.engine) as session:
        return list(
            session.scalars(
                select(TenantUsagePermitRow.status).order_by(TenantUsagePermitRow.acquired_at)
            )
        )


def _activate_openrouter_with_model(model: ModelConfig) -> None:
    store = get_store()
    provider = store.providers["provider-openrouter"]
    provider.connected = True
    # Non-owner access requires a group intersection; mirror a seeded model's groups.
    model.group_ids = sorted({g for m in store.models.values() for g in m.group_ids})
    store.models[model.id] = model
    store.create_provider_key(
        key_id="key-provider-openrouter-test",
        provider=provider,
        name=f"{provider.name} Test Key",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value="openrouter-test-key",
    )


def _image_model() -> ModelConfig:
    return ModelConfig(
        id="model-image-test",
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="Nano Banana Test",
        upstream_model_id="google/gemini-3.1-flash-image-preview",
        context_window=131072,
    )


def _audio_model() -> ModelConfig:
    return ModelConfig(
        id="model-audio-test",
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="Gemini Flash Test",
        upstream_model_id="google/gemini-3.5-flash",
        context_window=1048576,
    )


def test_image_model_detection_and_count_parsing() -> None:
    assert _is_image_generation_model(_image_model())
    assert not _is_image_generation_model(_audio_model())
    assert _requested_image_count("draw a lighthouse") == 1
    assert _requested_image_count("generate two images of a lighthouse") == 2
    assert _requested_image_count("make 3 pictures please") == 3
    assert _requested_image_count("a couple of illustrations") == 2
    # Clamped to the per-request cap.
    assert _requested_image_count("generate 12 images") == 4


def test_image_model_generates_and_serves_downloadable_images(monkeypatch) -> None:
    _activate_openrouter_with_model(_image_model())
    calls: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.read().decode())
        calls.append(body)
        return httpx.Response(
            200,
            json={
                "id": f"gen-img-{len(calls)}",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": "",
                            "images": [{"type": "image_url", "image_url": {"url": PNG_DATA_URL}}],
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            },
        )

    fake = ModelGatewayClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "model-image-test",
            "messages": [{"role": "user", "content": "generate three images of a lighthouse"}],
        },
        headers=headers(),
    )

    assert response.status_code == 200
    content = response.json()["choices"][0]["message"]["content"]

    # Three separate provider calls, each requesting image output.
    assert len(calls) == 3
    assert all(body["modalities"] == ["image", "text"] for body in calls)
    daily = _daily_usage()
    assert daily is not None
    assert daily.reported_tokens == 45
    assert daily.metered_completions == 3

    urls = [
        line.split("(", 1)[1].rstrip(")") for line in content.splitlines() if line.startswith("![")
    ]
    assert len(urls) == 3
    assert len(set(urls)) == 3

    for url in urls:
        assert url.startswith("/api/chat/generated-images/")
        inline = client.get(url)
        assert inline.status_code == 200
        assert inline.headers["content-type"] == "image/png"
        assert inline.content == PNG_BYTES
        download = client.get(f"{url}&download=1")
        assert "attachment" in download.headers["content-disposition"]


def test_generated_image_route_rejects_unknown_names() -> None:
    assert client.get("/api/chat/generated-images/not-a-real-name.png").status_code == 404
    assert client.get(f"/api/chat/generated-images/{'0' * 32}.png").status_code == 404


def test_deployed_generated_image_route_requires_valid_unexpired_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "test-generated-image-signing-secret"
    name = save_generated_image(PNG_DATA_URL)
    monkeypatch.setattr(
        "app.routes.chat.get_settings",
        lambda: SimpleNamespace(is_local_environment=False, secret_key=secret),
    )

    missing = client.get(f"/api/chat/generated-images/{name}")
    assert missing.status_code == 403

    token = sign_asset_token(name, secret)
    valid = client.get(f"/api/chat/generated-images/{name}?token={token}")
    assert valid.status_code == 200
    assert valid.content == PNG_BYTES

    issued_at = time.time()
    expiring = sign_asset_token(name, secret, ttl_seconds=1)
    monkeypatch.setattr("app.core.sessions.time.time", lambda: issued_at + 2)
    expired = client.get(f"/api/chat/generated-images/{name}?token={expiring}")
    assert expired.status_code == 403


def test_thread_list_refreshes_expired_generated_image_links_without_rewriting_history(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "test-generated-image-signing-secret"
    name = save_generated_image(PNG_DATA_URL)
    expired_token = sign_asset_token(name, secret, ttl_seconds=-1)
    expired_url = f"/api/chat/generated-images/{name}?token={expired_token}"
    monkeypatch.setattr(
        "app.routes.chat.get_settings",
        lambda: SimpleNamespace(is_local_environment=False, secret_key=secret),
    )

    saved = client.put(
        "/api/chat/threads/thread-expired-image",
        json={
            "tenant_id": "tenant-example",
            "title": "Archived generated image",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "archived": True,
            "messages": [
                {
                    "id": "prompt",
                    "role": "user",
                    "content": "Generate a lighthouse image.",
                    "createdAt": "10:00 AM",
                    "status": "ok",
                },
                {
                    "id": "image",
                    "role": "assistant",
                    "content": f"![Generated lighthouse]({expired_url})",
                    "createdAt": "10:01 AM",
                    "status": "ok",
                },
            ],
        },
        headers=headers("user-jane"),
    )
    assert saved.status_code == 200
    assert expired_url in get_store().chat_threads["thread-expired-image"].messages[1].content

    listed = client.get("/api/chat/threads", headers=headers("user-jane"))
    assert listed.status_code == 200
    returned_thread = next(thread for thread in listed.json() if thread["id"] == "thread-expired-image")
    returned_content = returned_thread["messages"][1]["content"]
    assert expired_url not in returned_content
    refreshed_url = returned_content.split("(", 1)[1].rstrip(")")
    assert client.get(refreshed_url).status_code == 200
    assert expired_url in get_store().chat_threads["thread-expired-image"].messages[1].content


def test_thread_list_never_mints_tokens_for_bare_or_forged_generated_image_links(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "test-generated-image-signing-secret"
    name = save_generated_image(PNG_DATA_URL)
    bare_url = f"/api/chat/generated-images/{name}"
    forged_token = sign_asset_token(name, "attacker-controlled-secret", ttl_seconds=3600)
    forged_url = f"/api/chat/generated-images/{name}?token={forged_token}"
    monkeypatch.setattr(
        "app.routes.chat.get_settings",
        lambda: SimpleNamespace(is_local_environment=False, secret_key=secret),
    )

    saved = client.put(
        "/api/chat/threads/thread-pasted-image-links",
        json={
            "tenant_id": "tenant-example",
            "title": "Pasted image links",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "messages": [
                {
                    "id": "bare",
                    "role": "user",
                    "content": f"Look at ![this]({bare_url}) please.",
                    "createdAt": "10:00 AM",
                    "status": "ok",
                },
                {
                    "id": "forged",
                    "role": "user",
                    "content": f"And ![this one]({forged_url}).",
                    "createdAt": "10:01 AM",
                    "status": "ok",
                },
            ],
        },
        headers=headers("user-jane"),
    )
    assert saved.status_code == 200

    listed = client.get("/api/chat/threads", headers=headers("user-jane"))
    assert listed.status_code == 200
    returned_thread = next(
        thread for thread in listed.json() if thread["id"] == "thread-pasted-image-links"
    )
    # A filename pasted without a server-signed token must never be laundered
    # into a working link, and a token signed with the wrong secret is forged.
    assert f"![this]({bare_url})" in returned_thread["messages"][0]["content"]
    assert f"![this one]({forged_url})" in returned_thread["messages"][1]["content"]


def test_image_model_with_no_images_fails_honestly(monkeypatch) -> None:
    _activate_openrouter_with_model(_image_model())

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "gen-none",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "I cannot draw that."},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {},
            },
        )

    fake = ModelGatewayClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "model-image-test",
            "messages": [{"role": "user", "content": "draw a lighthouse"}],
        },
        headers=headers(),
    )
    assert response.status_code == 503
    assert "returned no images" in response.json()["detail"]
    daily = _daily_usage()
    assert daily is not None
    assert daily.unmetered_completions == 1


def test_dictation_transcription_routes_audio_to_model(monkeypatch) -> None:
    _activate_openrouter_with_model(_audio_model())
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.read().decode())
        return httpx.Response(
            200,
            json={
                "id": "gen-dictation",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": "Schedule the review for Friday.",
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 40, "completion_tokens": 8, "total_tokens": 48},
            },
        )

    fake = ModelGatewayClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/transcriptions",
        files={"file": ("dictation.wav", b"RIFF-fake-wav-bytes", "audio/wav")},
        headers=headers(),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["text"] == "Schedule the review for Friday."
    assert body["model_id"] == "model-audio-test"

    sent = captured["body"]
    assert sent["model"] == "google/gemini-3.5-flash"
    assert sent["temperature"] == 0
    audio_part = sent["messages"][-1]["content"][0]
    assert audio_part["type"] == "input_audio"
    assert audio_part["input_audio"]["format"] == "wav"
    assert base64.b64decode(audio_part["input_audio"]["data"]) == b"RIFF-fake-wav-bytes"
    instruction_part = sent["messages"][-1]["content"][-1]
    assert instruction_part["type"] == "text"
    assert "never answer" in instruction_part["text"].lower()
    daily = _daily_usage()
    assert daily is not None
    assert daily.reported_tokens == 48
    assert daily.metered_completions == 1


def test_dictation_resolves_only_the_request_tenant_credential(monkeypatch) -> None:
    store = get_store()
    provider = store.providers["provider-openrouter"]
    provider.connected = False
    model = _audio_model()
    model.upstream_model_id = "google/gemini-99.9-flash"
    model.group_ids = ["group-litigation"]
    store.models[model.id] = model
    store.tenants["tenant-other"] = Tenant(
        id="tenant-other",
        name="Other Tenant",
        slug="other",
    )
    store.create_provider_key(
        key_id="key-dictation-other-tenant",
        provider=provider,
        name="Other tenant dictation key",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value="other-tenant-dictation-secret",
        tenant_id="tenant-other",
    )
    authorization_headers: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        authorization_headers.append(request.headers["authorization"])
        return httpx.Response(
            200,
            json={
                "id": "gen-tenant-dictation",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Scoped transcript."},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 8, "completion_tokens": 2, "total_tokens": 10},
            },
        )

    fake = ModelGatewayClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    unavailable = client.post(
        "/api/chat/transcriptions",
        files={"file": ("dictation.wav", b"RIFF-fake-wav-bytes", "audio/wav")},
        headers=headers("user-admin"),
    )
    assert unavailable.status_code == 503
    assert "No configured audio-capable model" in unavailable.json()["detail"]
    assert authorization_headers == []

    tenant_key = store.create_provider_key(
        key_id="key-dictation-request-tenant",
        provider=provider,
        name="Request tenant dictation key",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value="request-tenant-dictation-secret",
        tenant_id="tenant-example",
    )
    available = client.post(
        "/api/chat/transcriptions",
        files={"file": ("dictation.wav", b"RIFF-fake-wav-bytes", "audio/wav")},
        headers=headers("user-admin"),
    )

    assert available.status_code == 200
    assert available.json()["text"] == "Scoped transcript."
    assert available.json()["model_id"] == model.id
    assert authorization_headers == ["Bearer request-tenant-dictation-secret"]
    assert provider.connected is False
    assert store.provider_keys[tenant_key.id].status == "Active"


def test_dictation_invalid_success_payload_fails_permit_but_retains_usage_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _activate_openrouter_with_model(_audio_model())

    def handler(request: httpx.Request) -> httpx.Response:
        request.read()
        return httpx.Response(200, json=[])

    fake = ModelGatewayClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    with pytest.raises(AttributeError):
        client.post(
            "/api/chat/transcriptions",
            files={"file": ("dictation.wav", b"RIFF-fake-wav-bytes", "audio/wav")},
            headers=headers(),
        )

    assert _permit_statuses() == ["failed"]
    daily = _daily_usage()
    assert daily is not None
    assert daily.reported_tokens == 0
    assert daily.unmetered_completions == 1
    records = get_store().usage_records_filtered(tenant_id="tenant-example")
    assert len(records) == 1
    assert records[0].total_tokens is None


def test_dictation_rejects_unsupported_audio_type() -> None:
    _activate_openrouter_with_model(_audio_model())
    response = client.post(
        "/api/chat/transcriptions",
        files={"file": ("dictation.webm", b"fake", "audio/webm")},
        headers=headers(),
    )
    assert response.status_code == 400
    assert "Unsupported dictation audio type" in response.json()["detail"]
