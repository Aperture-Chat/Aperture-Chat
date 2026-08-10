"""Uploaded images must reach image-capable models as real vision content.

The sanitized WebP preview is the only stored copy of an upload, so it is
also the payload forwarded to providers: OpenAI-compatible routes receive
``image_url`` data-URL parts and the Anthropic dialect translates them to
image source blocks.
"""

from __future__ import annotations

from io import BytesIO
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.core import attachment_previews
from app.core.model_gateway import _anthropic_message, supports_image_input
from app.main import app
from app.repositories.deps import get_store
from app.routes.chat import (
    _audit_runtime_context,
    _messages_with_attachment_images,
    _resolve_context_chat_attachments,
)

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        attachment_previews,
        "get_settings",
        lambda: SimpleNamespace(runtime_state_path=str(tmp_path / "runtime_state.json")),
    )
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str = "user-admin") -> dict[str, str]:
    return {"x-aperture-user": user_id}


def image_bytes() -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (640, 480), color=(18, 130, 142)).save(buffer, format="JPEG", quality=94)
    return buffer.getvalue()


def upload_image(name: str = "receipt.jpeg") -> dict:
    response = client.post(
        "/api/chat/attachments",
        files={"file": (name, image_bytes(), "image/jpeg")},
        headers=headers(),
    )
    assert response.status_code == 200
    return response.json()


def test_supports_image_input_prefers_reported_modalities() -> None:
    assert supports_image_input("mistral-large", ["text", "image"]) is True
    # Reported text-only wins even for a family the heuristics would accept.
    assert supports_image_input("anthropic/claude-sonnet-5", ["text"]) is False


@pytest.mark.parametrize(
    "upstream_model",
    [
        "anthropic/claude-sonnet-5",
        "openai/gpt-5.5",
        "gpt-4o-mini",
        "google/gemini-2.5-pro",
        "meta-llama/llama-3.2-90b-vision-instruct",
        "qwen/qwen2.5-vl-72b-instruct",
    ],
)
def test_supports_image_input_family_heuristics_accept(upstream_model: str) -> None:
    assert supports_image_input(upstream_model) is True


@pytest.mark.parametrize(
    "upstream_model",
    ["deepseek/deepseek-chat", "gpt-oss-120b", "mistral-large-2411", "", None],
)
def test_supports_image_input_family_heuristics_reject(upstream_model: str | None) -> None:
    assert supports_image_input(upstream_model) is False


def test_attachment_preview_data_url_round_trips_uploaded_image() -> None:
    attachment = upload_image()
    data_url = attachment_previews.attachment_preview_data_url(attachment["id"])
    assert data_url is not None
    assert data_url.startswith("data:image/webp;base64,")
    assert attachment_previews.attachment_preview_data_url("upload-missing") is None


def test_images_attach_to_latest_user_turn_as_multimodal_parts() -> None:
    messages = [
        {"role": "user", "content": "Here is the receipt."},
        {"role": "assistant", "content": "Got it."},
        {"role": "user", "content": "What is the total?"},
    ]
    result = _messages_with_attachment_images(
        messages, [{"name": "receipt.jpeg", "data_url": "data:image/webp;base64,QUJD"}]
    )
    assert result[0] == messages[0]
    assert result[1] == messages[1]
    assert result[2]["role"] == "user"
    assert result[2]["content"] == [
        {"type": "text", "text": "What is the total?"},
        {"type": "image_url", "image_url": {"url": "data:image/webp;base64,QUJD"}},
    ]
    # The source list the caller passed in is never mutated.
    assert messages[2]["content"] == "What is the total?"


def test_image_only_send_becomes_pure_image_parts() -> None:
    result = _messages_with_attachment_images(
        [{"role": "user", "content": ""}],
        [{"name": "receipt.jpeg", "data_url": "data:image/webp;base64,QUJD"}],
    )
    assert result[0]["content"] == [
        {"type": "image_url", "image_url": {"url": "data:image/webp;base64,QUJD"}}
    ]


def test_anthropic_dialect_translates_image_url_parts() -> None:
    translated = _anthropic_message(
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "What is in this photo?"},
                {"type": "image_url", "image_url": {"url": "data:image/webp;base64,QUJD"}},
                {"type": "image_url", "image_url": {"url": "https://example.com/photo.png"}},
            ],
        }
    )
    assert translated == {
        "role": "user",
        "content": [
            {"type": "text", "text": "What is in this photo?"},
            {
                "type": "image",
                "source": {"type": "base64", "media_type": "image/webp", "data": "QUJD"},
            },
            {"type": "image", "source": {"type": "url", "url": "https://example.com/photo.png"}},
        ],
    }


def test_anthropic_dialect_keeps_plain_string_content() -> None:
    assert _anthropic_message({"role": "user", "content": "hello"}) == {
        "role": "user",
        "content": "hello",
    }


def test_context_attachments_resolve_leniently_but_stay_owner_scoped() -> None:
    attachment = upload_image()
    store = get_store()
    owner = store.users["user-admin"]
    resolved = _resolve_context_chat_attachments(
        store, owner, [attachment["id"], "upload-deleted-long-ago"]
    )
    assert [item.id for item in resolved] == [attachment["id"]]

    stranger = store.users["user-casey"]
    assert _resolve_context_chat_attachments(store, stranger, [attachment["id"]]) == []


def test_audit_context_records_image_names_never_payloads() -> None:
    audited = _audit_runtime_context(
        {
            "attachment_images": [
                {"name": "receipt.jpeg", "data_url": "data:image/webp;base64,QUJD"}
            ],
            "image_attachment_count": 1,
            "image_input_supported": True,
        }
    )
    assert audited["attachment_image_names"] == ["receipt.jpeg"]
    assert "attachment_images" not in audited
    assert "QUJD" not in str(audited)
