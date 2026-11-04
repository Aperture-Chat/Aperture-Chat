"""Dictation through dedicated speech-to-text models and fallbacks.

Speech models (Whisper, gpt-4o-transcribe) answer on the provider's
``/audio/transcriptions`` route, not chat completions. OpenAI-compatible
providers such as Groq take the model in the multipart body; Azure OpenAI
takes the deployment in the path; an Azure AI Foundry resource serves speech
through its OpenAI v1 route because the Foundry ``/models`` inference
endpoint has no audio route. Gateways are exercised with httpx.MockTransport,
so no real provider is called.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from email.parser import BytesParser
from email.policy import default as default_policy

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.media_transcription import resolve_transcription_model
from app.core.model_gateway import (
    ModelGatewayClient,
    ModelGatewayConfigurationError,
    ModelGatewayRoute,
    supports_image_input,
)
from app.main import app
from app.models.schemas import ModelCapabilities, ModelConfig, Provider
from app.repositories.deps import get_store

client = TestClient(app)
WAV = b"RIFF-fake-wav-bytes"


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str = "user-admin") -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _route(kind: str, base_url: str, upstream: str, **auth_metadata) -> ModelGatewayRoute:
    return ModelGatewayRoute(
        provider_id=f"provider-{kind}",
        provider_name=kind.title(),
        provider_kind=kind,
        auth_type="bearer" if kind in {"openai-compatible", "openai"} else "api-key",
        upstream_model=upstream,
        base_url=base_url,
        configured=True,
        status_message="ready",
        secret_value="speech-secret",
        auth_metadata=auth_metadata,
    )


def _multipart_fields(request: httpx.Request) -> dict[str, bytes]:
    raw = request.read()
    message = BytesParser(policy=default_policy).parsebytes(
        b"Content-Type: " + request.headers["content-type"].encode() + b"\r\n\r\n" + raw
    )
    return {
        part.get_param("name", header="content-disposition"): part.get_payload(decode=True)
        for part in message.iter_parts()
    }


def _capture_speech(text: str, usage: dict | None = None):
    seen: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(
            {
                "url": str(request.url),
                "headers": dict(request.headers),
                "fields": _multipart_fields(request),
            }
        )
        body: dict[str, object] = {"text": text}
        if usage is not None:
            body["usage"] = usage
        return httpx.Response(200, json=body)

    return seen, ModelGatewayClient(transport=httpx.MockTransport(handler))


# --- gateway: one speech route per provider dialect ---------------------------


def test_openai_compatible_speech_posts_model_and_file_to_audio_transcriptions() -> None:
    seen, gateway = _capture_speech("Call the clerk.")
    route = _route("openai-compatible", "https://api.groq.com/openai/v1", "whisper-large-v3-turbo")

    payload = gateway.transcribe_speech(route=route, audio=WAV, audio_format="wav")

    assert payload["text"] == "Call the clerk."
    assert seen[0]["url"] == "https://api.groq.com/openai/v1/audio/transcriptions"
    assert seen[0]["headers"]["authorization"] == "Bearer speech-secret"
    assert seen[0]["headers"]["content-type"].startswith("multipart/form-data")
    fields = seen[0]["fields"]
    assert fields["model"] == b"whisper-large-v3-turbo"
    assert fields["file"] == WAV
    assert fields["response_format"] == b"json"


def test_azure_openai_speech_names_the_deployment_in_the_path() -> None:
    seen, gateway = _capture_speech("Filed.")
    route = _route(
        "azure-openai",
        "https://firm.openai.azure.com/openai",
        "whisper",
        api_version="2024-10-21",
    )

    gateway.transcribe_speech(route=route, audio=WAV, audio_format="wav")

    assert seen[0]["url"] == (
        "https://firm.openai.azure.com/openai/deployments/whisper/audio/transcriptions"
        "?api-version=2024-10-21"
    )
    assert seen[0]["headers"]["api-key"] == "speech-secret"
    assert "authorization" not in seen[0]["headers"]
    assert "model" not in seen[0]["fields"]
    assert seen[0]["fields"]["file"] == WAV


def test_azure_openai_gpt4o_transcribe_uses_an_api_version_that_serves_it() -> None:
    seen, gateway = _capture_speech("Filed.")
    old = _route(
        "azure-openai",
        "https://firm.openai.azure.com/openai",
        "gpt-4o-mini-transcribe",
        api_version="2024-10-21",
    )
    newer = _route(
        "azure-openai",
        "https://firm.openai.azure.com/openai",
        "gpt-4o-transcribe",
        api_version="2025-04-01-preview",
    )

    gateway.transcribe_speech(route=old, audio=WAV, audio_format="wav")
    gateway.transcribe_speech(route=newer, audio=WAV, audio_format="wav")

    assert seen[0]["url"].endswith(
        "/deployments/gpt-4o-mini-transcribe/audio/transcriptions?api-version=2025-03-01-preview"
    )
    assert seen[1]["url"].endswith(
        "/deployments/gpt-4o-transcribe/audio/transcriptions?api-version=2025-04-01-preview"
    )


def test_azure_foundry_speech_uses_the_resource_openai_v1_route() -> None:
    seen, gateway = _capture_speech("Filed.")
    route = _route(
        "azure-foundry",
        "https://firm.services.ai.azure.com/models",
        "gpt-4o-mini-transcribe",
    )

    gateway.transcribe_speech(route=route, audio=WAV, audio_format="mp3")

    assert seen[0]["url"] == (
        "https://firm.services.ai.azure.com/openai/v1/audio/transcriptions?api-version=preview"
    )
    assert seen[0]["headers"]["api-key"] == "speech-secret"
    assert seen[0]["fields"]["model"] == b"gpt-4o-mini-transcribe"
    assert seen[0]["fields"]["file"] == WAV


def test_azure_chat_and_speech_share_the_deployment_and_api_version() -> None:
    urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        request.read()
        urls.append(str(request.url))
        if request.url.path.endswith("/audio/transcriptions"):
            return httpx.Response(200, json={"text": "ok"})
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    gateway = ModelGatewayClient(transport=httpx.MockTransport(handler))
    route = _route(
        "azure-openai",
        "https://firm.openai.azure.com/openai",
        "catalog-name",
        api_version="2024-06-01",
        deployment_id="whisper-east",
    )

    gateway.complete(route=route, messages=[{"role": "user", "content": "hi"}])
    gateway.transcribe_speech(route=route, audio=WAV, audio_format="wav")

    assert urls == [
        "https://firm.openai.azure.com/openai/deployments/whisper-east/chat/completions"
        "?api-version=2024-06-01",
        "https://firm.openai.azure.com/openai/deployments/whisper-east/audio/transcriptions"
        "?api-version=2024-06-01",
    ]


def test_providers_without_a_speech_route_refuse_before_any_request() -> None:
    seen, gateway = _capture_speech("never")
    for route in (
        _route("openrouter", "https://openrouter.ai/api/v1", "openai/whisper-1"),
        _route("anthropic", "https://api.anthropic.com", "whisper"),
    ):
        with pytest.raises(ModelGatewayConfigurationError):
            gateway.transcribe_speech(route=route, audio=WAV, audio_format="wav")
    assert seen == []


def test_speech_models_never_count_as_image_capable() -> None:
    assert not supports_image_input("gpt-4o-transcribe")
    assert not supports_image_input("gpt-4o-mini-transcribe")
    assert not supports_image_input("openai/whisper-1")
    assert supports_image_input("gpt-4o")


# --- ranking: what dictation picks from a real-looking catalog ----------------


def _groups() -> list[str]:
    return sorted({g for m in get_store().models.values() for g in m.group_ids})


def _connect_openrouter() -> None:
    store = get_store()
    provider = store.providers["provider-openrouter"]
    provider.connected = True
    store.create_provider_key(
        key_id="key-openrouter-speech",
        provider=provider,
        name="OpenRouter speech",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value="openrouter-speech-key",
    )


def _add_provider(provider: Provider, secret: str) -> Provider:
    store = get_store()
    store.providers[provider.id] = provider
    store.create_provider_key(
        key_id=f"key-{provider.id}",
        provider=provider,
        name=f"{provider.name} key",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value=secret,
    )
    return provider


def _model(provider: Provider, upstream: str, *, audio: bool = False, name: str | None = None) -> ModelConfig:
    model = ModelConfig(
        id=f"{provider.id}-{upstream.replace('/', '-').replace('.', '-')}",
        provider_id=provider.id,
        provider_name=provider.name,
        name=name or upstream,
        upstream_model_id=upstream,
        platform_enabled=False,
        group_ids=_groups(),
        capabilities=ModelCapabilities(
            input_modalities=["text", "image", "video", "audio"], output_modalities=["text"]
        )
        if audio
        else None,
    )
    get_store().models[model.id] = model
    return model


_SPEECH_PROVIDERS = {
    "groq": ("Groq", "openai-compatible", "https://api.groq.com/openai/v1", "bearer"),
    "foundry": ("Azure AI Foundry", "azure-foundry", "https://firm.services.ai.azure.com/models", "api-key"),
}


def _speech_provider(slug: str) -> Provider:
    name, kind, base_url, auth_type = _SPEECH_PROVIDERS[slug]
    provider = Provider(
        id=f"provider-{slug}", name=name, kind=kind, region="US", base_url=base_url, auth_type=auth_type
    )
    return _add_provider(provider, f"{slug}-speech-secret")


def _groq() -> Provider:
    return _speech_provider("groq")


def _foundry() -> Provider:
    return _speech_provider("foundry")


def _openrouter_audio_catalog() -> dict[str, ModelConfig]:
    """The live OpenRouter ZDR catalog after Gemini left it (Nov 2026)."""

    _connect_openrouter()
    openrouter = get_store().providers["provider-openrouter"]
    return {
        name: _model(openrouter, upstream, audio=True)
        for name, upstream in (
            ("pro", "xiaomi/mimo-v2.6-pro"),
            ("flash", "xiaomi/mimo-v2.6-flash"),
            ("small", "thinkingmachines/inkling-small"),
        )
    }


def test_dictation_prefers_a_speech_model_over_audio_chat_fallbacks() -> None:
    _openrouter_audio_catalog()
    groq = _groq()
    _model(groq, "whisper-large-v3", name="Groq accurate")
    turbo = _model(groq, "whisper-large-v3-turbo", name="Groq fast")

    selection = resolve_transcription_model(get_store(), tenant_id="tenant-example", prefer_fast=True)

    assert selection is not None
    assert selection[0].id == turbo.id
    assert selection[1].provider_kind == "openai-compatible"


def test_audio_chat_fallback_takes_a_fast_model_before_a_pro_one() -> None:
    catalog = _openrouter_audio_catalog()

    selection = resolve_transcription_model(get_store(), tenant_id="tenant-example", prefer_fast=True)

    assert selection is not None
    assert selection[0].id == catalog["flash"].id


def test_audio_chat_fallback_takes_a_standard_tier_before_a_pro_one() -> None:
    _connect_openrouter()
    openrouter = get_store().providers["provider-openrouter"]
    _model(openrouter, "vendor/omni-pro", audio=True)
    standard = _model(openrouter, "vendor/omni", audio=True)

    selection = resolve_transcription_model(get_store(), tenant_id="tenant-example", prefer_fast=True)

    assert selection is not None
    assert selection[0].id == standard.id


def test_audio_models_that_draw_images_are_never_transcribers() -> None:
    _connect_openrouter()
    openrouter = get_store().providers["provider-openrouter"]
    painter = _model(openrouter, "vendor/omni-painter", audio=True)
    painter.capabilities = ModelCapabilities(
        input_modalities=["text", "audio"], output_modalities=["image", "text"]
    )

    assert resolve_transcription_model(get_store(), tenant_id="tenant-example", prefer_fast=True) is None


def test_speech_choice_does_not_depend_on_catalog_order() -> None:
    groq = _groq()
    first = _model(groq, "whisper-1")
    second = _model(groq, "whisper-large-v3")
    picked = resolve_transcription_model(get_store(), tenant_id="tenant-example", prefer_fast=True)
    get_store().models.pop(first.id)
    get_store().models[first.id] = first

    reordered = resolve_transcription_model(get_store(), tenant_id="tenant-example", prefer_fast=True)

    assert picked is not None and reordered is not None
    assert picked[0].id == reordered[0].id == second.id


def test_diarization_models_are_left_out_of_dictation() -> None:
    foundry = _foundry()
    _model(foundry, "gpt-4o-transcribe-diarize")
    whisper = _model(foundry, "whisper")

    selection = resolve_transcription_model(get_store(), tenant_id="tenant-example", prefer_fast=True)

    assert selection is not None
    assert selection[0].id == whisper.id


def test_gemini_flash_still_leads_when_the_catalog_has_it() -> None:
    _connect_openrouter()
    openrouter = get_store().providers["provider-openrouter"]
    lite = _model(openrouter, "google/gemini-3.5-flash-lite")
    _model(_groq(), "whisper-large-v3-turbo")

    selection = resolve_transcription_model(get_store(), tenant_id="tenant-example", prefer_fast=True)

    assert selection is not None
    assert selection[0].id == lite.id


def test_speech_models_on_a_provider_without_a_speech_route_are_skipped() -> None:
    _connect_openrouter()
    openrouter = get_store().providers["provider-openrouter"]
    _model(openrouter, "openai/whisper-1")

    assert resolve_transcription_model(get_store(), tenant_id="tenant-example", prefer_fast=True) is None


def test_azure_deployment_named_by_its_display_name_is_found() -> None:
    foundry = _foundry()
    deployment = _model(foundry, "speech-prod", name="Whisper (firm deployment)")

    selection = resolve_transcription_model(get_store(), tenant_id="tenant-example", prefer_fast=True)

    assert selection is not None
    assert selection[0].id == deployment.id


# --- the dictation route end to end -------------------------------------------


def _daily_usage():
    return get_store().usage_budget_repository.get_daily_usage(
        "tenant-example", datetime.now(UTC).date()
    )


def test_dictation_through_groq_whisper_returns_the_spoken_words(monkeypatch) -> None:
    _openrouter_audio_catalog()
    turbo = _model(_groq(), "whisper-large-v3-turbo")
    seen, gateway = _capture_speech("Move the deposition to Thursday.")
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: gateway)

    response = client.post(
        "/api/chat/transcriptions",
        files={"file": ("dictation.wav", WAV, "audio/wav")},
        headers=headers(),
    )

    assert response.status_code == 200, response.text
    assert response.json() == {
        "text": "Move the deposition to Thursday.",
        "model_id": turbo.id,
        "model_name": turbo.name,
    }
    assert seen[0]["url"] == "https://api.groq.com/openai/v1/audio/transcriptions"
    assert seen[0]["headers"]["authorization"] == "Bearer groq-speech-secret"


def test_the_microphone_uses_the_fast_ranking(monkeypatch) -> None:
    _connect_openrouter()
    openrouter = get_store().providers["provider-openrouter"]
    _model(openrouter, "google/gemini-3.5-flash")
    lite = _model(openrouter, "google/gemini-3.5-flash-lite")
    sent: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.read())["model"])
        return _chat_reply("Noted.")

    gateway = ModelGatewayClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: gateway)

    response = client.post(
        "/api/chat/transcriptions",
        files={"file": ("dictation.wav", WAV, "audio/wav")},
        headers=headers(),
    )

    assert response.status_code == 200, response.text
    assert response.json()["model_id"] == lite.id
    assert sent == ["google/gemini-3.5-flash-lite"]


def test_dictation_through_azure_foundry_meters_reported_tokens(monkeypatch) -> None:
    deployment = _model(_foundry(), "gpt-4o-mini-transcribe")
    seen, gateway = _capture_speech(
        "Send the engagement letter.",
        usage={"type": "tokens", "input_tokens": 30, "output_tokens": 6, "total_tokens": 36},
    )
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: gateway)

    response = client.post(
        "/api/chat/transcriptions",
        files={"file": ("dictation.wav", WAV, "audio/wav")},
        headers=headers(),
    )

    assert response.status_code == 200, response.text
    assert response.json()["text"] == "Send the engagement letter."
    assert response.json()["model_id"] == deployment.id
    assert seen[0]["url"].startswith("https://firm.services.ai.azure.com/openai/v1/audio/transcriptions")
    assert seen[0]["headers"]["api-key"] == "foundry-speech-secret"
    daily = _daily_usage()
    assert daily is not None
    assert daily.reported_tokens == 36


def _chat_reply(text: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text}}],
            "usage": {"prompt_tokens": 9, "completion_tokens": 3, "total_tokens": 12},
        },
    )


def _rate_limited() -> httpx.Response:
    return httpx.Response(
        429,
        json={"error": {"message": "Provider returned error", "code": 429}},
    )


def test_dictation_moves_to_the_next_model_when_one_is_rate_limited(monkeypatch) -> None:
    catalog = _openrouter_audio_catalog()
    turbo = _model(_groq(), "whisper-large-v3-turbo")
    hosts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        request.read()
        hosts.append(request.url.host)
        if request.url.host == "api.groq.com":
            return _rate_limited()
        return _chat_reply("Draft the reply brief.")

    gateway = ModelGatewayClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: gateway)

    response = client.post(
        "/api/chat/transcriptions",
        files={"file": ("dictation.wav", WAV, "audio/wav")},
        headers=headers(),
    )

    assert response.status_code == 200, response.text
    assert response.json()["text"] == "Draft the reply brief."
    assert response.json()["model_id"] == catalog["flash"].id
    assert hosts == ["api.groq.com", "openrouter.ai"]
    audit = next(
        event
        for event in reversed(get_store().audit_events)
        if event.action == "chat.dictation_transcribed"
    )
    assert audit.target == catalog["flash"].id
    assert turbo.upstream_model_id in str(audit.metadata.get("skipped_models"))


def _dictate_while_rate_limited(monkeypatch) -> tuple[str, list[str]]:
    attempts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        request.read()
        attempts.append(request.url.host)
        return _rate_limited()

    gateway = ModelGatewayClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: gateway)
    response = client.post(
        "/api/chat/transcriptions",
        files={"file": ("dictation.wav", WAV, "audio/wav")},
        headers=headers(),
    )
    assert response.status_code == 503
    detail = response.json()["detail"]
    assert "{" not in detail
    assert detail.endswith("Try the microphone again in a moment.")
    return detail, attempts


def test_dictation_names_the_one_rate_limited_model_plainly(monkeypatch) -> None:
    _connect_openrouter()
    _model(get_store().providers["provider-openrouter"], "xiaomi/mimo-v2.6-pro", audio=True)

    detail, attempts = _dictate_while_rate_limited(monkeypatch)

    assert detail.startswith("Dictation is busy right now: OpenRouter is rate-limiting xiaomi/mimo-v2.6-pro.")
    assert attempts == ["openrouter.ai"]


def test_dictation_says_every_model_tried_is_busy(monkeypatch) -> None:
    _connect_openrouter()
    openrouter = get_store().providers["provider-openrouter"]
    _model(openrouter, "xiaomi/mimo-v2.6-pro", audio=True)
    _model(_groq(), "whisper-large-v3-turbo")

    detail, attempts = _dictate_while_rate_limited(monkeypatch)

    assert "every speech model it tried is rate-limited" in detail
    assert attempts == ["api.groq.com", "openrouter.ai"]


def test_dictation_stops_after_three_models(monkeypatch) -> None:
    _openrouter_audio_catalog()
    _model(_groq(), "whisper-large-v3-turbo")

    _detail, attempts = _dictate_while_rate_limited(monkeypatch)

    assert attempts == ["api.groq.com", "openrouter.ai", "openrouter.ai"]


def test_video_stills_are_not_sent_to_a_speech_deployment(monkeypatch) -> None:
    from app.core.media import PreparedAudio

    _model(_foundry(), "gpt-4o-mini-stt", name="Transcribe (mini)")
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        request.read()
        paths.append(request.url.path)
        return httpx.Response(200, json={"text": "The closing is on Friday."})

    monkeypatch.setattr(
        "app.core.media_transcription.prepare_media_audio",
        lambda *args, **kwargs: PreparedAudio(
            chunks=(b"fake-mp3",),
            audio_format="mp3",
            duration_seconds=4.0,
            frames=(b"fake-jpeg-frame",),
            had_audio_track=True,
            used_ffmpeg=True,
        ),
    )
    monkeypatch.setattr(
        "app.core.media_transcription.get_model_gateway_client",
        lambda: ModelGatewayClient(transport=httpx.MockTransport(handler)),
    )

    response = client.post(
        "/api/chat/attachments",
        files={"file": ("walkthrough.mp4", b"fake-mp4-bytes", "video/mp4")},
        headers=headers(),
    )

    assert response.status_code == 200, response.text
    preview = response.json()["text_preview"] or ""
    assert "The closing is on Friday." in preview
    assert "Visual notes: skipped because the transcription model does not accept image input." in preview
    assert paths == ["/openai/v1/audio/transcriptions"]


def test_dictation_does_not_retry_a_request_the_provider_rejected(monkeypatch) -> None:
    _openrouter_audio_catalog()
    attempts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        request.read()
        attempts.append(request.url.path)
        return httpx.Response(400, json={"error": {"message": "audio format not supported"}})

    gateway = ModelGatewayClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: gateway)

    response = client.post(
        "/api/chat/transcriptions",
        files={"file": ("dictation.wav", WAV, "audio/wav")},
        headers=headers(),
    )

    assert response.status_code == 503
    assert "could not transcribe the dictation" in response.json()["detail"]
    assert "audio format not supported" in response.json()["detail"]
    assert len(attempts) == 1
