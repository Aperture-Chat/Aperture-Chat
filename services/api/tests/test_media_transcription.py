from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.media import PreparedAudio
from app.core.media_transcription import (
    is_gemini_flash_upstream,
    resolve_transcription_model,
)
from app.core.model_gateway import ModelGatewayClient
from app.main import app
from app.models.schemas import ModelCapabilities, ModelConfig
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str = "user-admin") -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _audio_model() -> ModelConfig:
    return ModelConfig(
        id="model-audio-test",
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="Gemini Flash Test",
        upstream_model_id="google/gemini-3.5-flash",
        context_window=1048576,
    )


def _activate_openrouter_with_model(model: ModelConfig) -> None:
    store = get_store()
    provider = store.providers["provider-openrouter"]
    provider.connected = True
    model.group_ids = sorted({g for m in store.models.values() for g in m.group_ids})
    store.models[model.id] = model
    store.create_provider_key(
        key_id="key-provider-openrouter-media",
        provider=provider,
        name=f"{provider.name} Media Key",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value="openrouter-media-test-key",
    )


def _fake_gateway(text: str) -> ModelGatewayClient:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "gen-media",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": text},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 20, "completion_tokens": 8, "total_tokens": 28},
            },
        )

    return ModelGatewayClient(transport=httpx.MockTransport(handler))


def test_chat_wav_attachment_stores_transcript(monkeypatch: pytest.MonkeyPatch) -> None:
    _activate_openrouter_with_model(_audio_model())
    monkeypatch.setattr(
        "app.core.media_transcription.get_model_gateway_client",
        lambda: _fake_gateway("The hearing is set for Tuesday."),
    )

    response = client.post(
        "/api/chat/attachments",
        files={"file": ("hearing.wav", b"RIFF-fake-wav-bytes", "audio/wav")},
        headers=headers(),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["kind"] == "Audio"
    assert "The hearing is set for Tuesday." in (body["text_preview"] or "")
    assert "Spoken words:" in (body["text_preview"] or "")


def test_chat_text_attachment_does_not_require_transcription() -> None:
    response = client.post(
        "/api/chat/attachments",
        files={"file": ("notes.txt", b"Matter notes", "text/plain")},
        headers=headers(),
    )
    assert response.status_code == 200
    assert response.json()["kind"] == "Text"
    assert response.json()["text_preview"] == "Matter notes"


def test_chat_media_without_audio_model_fails_honestly() -> None:
    response = client.post(
        "/api/chat/attachments",
        files={"file": ("hearing.wav", b"RIFF-fake-wav-bytes", "audio/wav")},
        headers=headers(),
    )
    assert response.status_code == 503
    assert "Gemini Flash" in response.json()["detail"]


def test_chat_video_without_ffmpeg_fails_honestly(monkeypatch: pytest.MonkeyPatch) -> None:
    _activate_openrouter_with_model(_audio_model())
    monkeypatch.setattr("app.core.media.ffmpeg_available", lambda: False)
    response = client.post(
        "/api/chat/attachments",
        files={"file": ("meeting.mp4", b"fake-mp4-bytes", "video/mp4")},
        headers=headers(),
    )
    assert response.status_code == 400
    assert "cannot process this media format" in response.json()["detail"]


def test_knowledge_wav_upload_indexes_transcript(monkeypatch: pytest.MonkeyPatch) -> None:
    _activate_openrouter_with_model(_audio_model())
    monkeypatch.setattr(
        "app.core.media_transcription.get_model_gateway_client",
        lambda: _fake_gateway("Client confirmed the closing date."),
    )

    upload = client.post(
        "/api/knowledge/knowledge-box-matters/documents",
        headers=headers(),
        files=[
            (
                "files",
                ("deposition.wav", b"RIFF-fake-wav-bytes", "audio/wav"),
            )
        ],
    )

    assert upload.status_code == 200
    document = next(
        item for item in upload.json()["documents"] if item["name"] == "deposition.wav"
    )
    assert document["status"] == "indexed"
    store = get_store()
    chunks = [
        chunk
        for chunk in store.knowledge_chunks_for("knowledge-box-matters")
        if chunk.document_id == document["id"]
    ]
    assert chunks
    assert any("Client confirmed the closing date." in chunk.text for chunk in chunks)
    assert any(chunk.locator == "transcript" for chunk in chunks)


def test_gemini_flash_detection_skips_image_and_tts_variants() -> None:
    assert is_gemini_flash_upstream("google/gemini-3.5-flash")
    assert is_gemini_flash_upstream("google/gemini-3-flash-preview")
    assert is_gemini_flash_upstream("google/gemini-2.5-flash")
    assert is_gemini_flash_upstream("google/gemini-2.5-flash-lite")
    assert not is_gemini_flash_upstream("google/gemini-3.1-flash-image-preview")
    assert not is_gemini_flash_upstream("google/gemini-3.1-flash-tts-preview")
    assert not is_gemini_flash_upstream("openai/gpt-4o")


def test_transcription_prefers_newer_gemini_flash_over_gpt4o() -> None:
    _activate_openrouter_with_model(_audio_model())
    store = get_store()
    groups = sorted({g for m in store.models.values() for g in m.group_ids})
    for model in (
        ModelConfig(
            id="model-gpt-4o-audio",
            provider_id="provider-openrouter",
            provider_name="OpenRouter",
            name="GPT-4o",
            upstream_model_id="openai/gpt-4o",
            context_window=128000,
            group_ids=groups,
            capabilities=ModelCapabilities(input_modalities=["text", "audio", "image"]),
        ),
        ModelConfig(
            id="model-flash-old",
            provider_id="provider-openrouter",
            provider_name="OpenRouter",
            name="Gemini 2.5 Flash",
            upstream_model_id="google/gemini-2.5-flash",
            context_window=1048576,
            group_ids=groups,
        ),
        ModelConfig(
            id="model-flash-preview",
            provider_id="provider-openrouter",
            provider_name="OpenRouter",
            name="Gemini 3 Flash Preview",
            upstream_model_id="google/gemini-3-flash-preview",
            context_window=1048576,
            group_ids=groups,
        ),
        ModelConfig(
            id="model-flash-lite",
            provider_id="provider-openrouter",
            provider_name="OpenRouter",
            name="Gemini 3.5 Flash Lite",
            upstream_model_id="google/gemini-3.5-flash-lite",
            context_window=1048576,
            group_ids=groups,
        ),
    ):
        store.models[model.id] = model

    selection = resolve_transcription_model(store, tenant_id="tenant-example")
    assert selection is not None
    assert selection[0].upstream_model_id == "google/gemini-3.5-flash"


def test_transcription_uses_gpt4o_only_as_last_resort() -> None:
    store = get_store()
    provider = store.providers["provider-openrouter"]
    provider.connected = True
    groups = sorted({g for m in store.models.values() for g in m.group_ids})
    gpt = ModelConfig(
        id="model-gpt-4o-only",
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="GPT-4o",
        upstream_model_id="openai/gpt-4o",
        context_window=128000,
        group_ids=groups,
        capabilities=ModelCapabilities(input_modalities=["text", "audio", "image"]),
    )
    store.models[gpt.id] = gpt
    store.create_provider_key(
        key_id="key-provider-openrouter-gpt4o-fallback",
        provider=provider,
        name="OpenRouter GPT-4o fallback",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value="openrouter-gpt4o-fallback-key",
    )
    selection = resolve_transcription_model(store, tenant_id="tenant-example")
    assert selection is not None
    assert selection[0].id == "model-gpt-4o-only"


def _silent_video_audio() -> PreparedAudio:
    return PreparedAudio(
        chunks=(),
        audio_format="mp3",
        duration_seconds=12.0,
        frames=(b"fake-jpeg-frame",),
        had_audio_track=False,
        used_ffmpeg=True,
    )


def _gateway_by_content(*, speech: str, visual: str) -> ModelGatewayClient:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.read().decode())
        content = body["messages"][-1]["content"]
        parts = content if isinstance(content, list) else []
        uses_images = any(
            isinstance(part, dict) and part.get("type") == "image_url" for part in parts
        )
        text = visual if uses_images else speech
        return httpx.Response(
            200,
            json={
                "id": "gen-media-multimodal",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": text},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 20, "completion_tokens": 8, "total_tokens": 28},
            },
        )

    return ModelGatewayClient(transport=httpx.MockTransport(handler))


def test_chat_silent_video_stores_visual_notes(monkeypatch: pytest.MonkeyPatch) -> None:
    _activate_openrouter_with_model(_audio_model())
    monkeypatch.setattr(
        "app.core.media_transcription.prepare_media_audio",
        lambda *args, **kwargs: _silent_video_audio(),
    )
    monkeypatch.setattr(
        "app.core.media_transcription.get_model_gateway_client",
        lambda: _gateway_by_content(
            speech="",
            visual="- A whiteboard lists the closing checklist.",
        ),
    )

    response = client.post(
        "/api/chat/attachments",
        files={"file": ("walkthrough.mp4", b"fake-mp4-bytes", "video/mp4")},
        headers=headers(),
    )

    assert response.status_code == 200
    preview = response.json()["text_preview"] or ""
    assert "Visual notes:" in preview
    assert "whiteboard lists the closing checklist" in preview
    assert "Spoken words: this file has no audio track." in preview


def test_knowledge_silent_video_indexes_visual_notes(monkeypatch: pytest.MonkeyPatch) -> None:
    _activate_openrouter_with_model(_audio_model())
    monkeypatch.setattr(
        "app.core.media_transcription.prepare_media_audio",
        lambda *args, **kwargs: _silent_video_audio(),
    )
    monkeypatch.setattr(
        "app.core.media_transcription.get_model_gateway_client",
        lambda: _gateway_by_content(
            speech="",
            visual="- Exhibit A is a signed term sheet.",
        ),
    )

    upload = client.post(
        "/api/knowledge/knowledge-box-matters/documents",
        headers=headers(),
        files=[("files", ("exhibit.mp4", b"fake-mp4-bytes", "video/mp4"))],
    )

    assert upload.status_code == 200
    document = next(item for item in upload.json()["documents"] if item["name"] == "exhibit.mp4")
    chunks = [
        chunk
        for chunk in get_store().knowledge_chunks_for("knowledge-box-matters")
        if chunk.document_id == document["id"]
    ]
    assert chunks
    assert any("Exhibit A is a signed term sheet" in chunk.text for chunk in chunks)
    assert any("Visual notes:" in chunk.text for chunk in chunks)


def test_chat_silent_video_without_visual_notes_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    _activate_openrouter_with_model(_audio_model())
    monkeypatch.setattr(
        "app.core.media_transcription.prepare_media_audio",
        lambda *args, **kwargs: _silent_video_audio(),
    )
    monkeypatch.setattr(
        "app.core.media_transcription.get_model_gateway_client",
        lambda: _gateway_by_content(speech="", visual=""),
    )

    response = client.post(
        "/api/chat/attachments",
        files={"file": ("blank.mp4", b"fake-mp4-bytes", "video/mp4")},
        headers=headers(),
    )
    assert response.status_code == 400
    assert "no visual notes" in response.json()["detail"]
