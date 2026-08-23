"""Tests for the real OpenRouter integration.

httpx is mocked via httpx.MockTransport injected into our OpenRouterClient, so
no real network call is made and the real API key is never required, logged, or
asserted on. (Patching httpx.Client globally would collide with Starlette's
TestClient, which is itself built on httpx.)
"""

from __future__ import annotations

import json
import zipfile
from collections.abc import Iterator
from datetime import datetime
from io import BytesIO
from xml.sax.saxutils import escape

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.core.model_gateway import (
    ModelGatewayClient,
    get_model_gateway_client,
    resolve_model_route,
    supports_reasoning_effort,
)
from app.core.openrouter import OpenRouterClient, map_model
from app.core.web_search import WebSearchError, WebSearchResult
from app.main import app
from app.models.schemas import (
    McpHealthResponse,
    McpToolCallResponse,
    McpToolSummary,
    ModelConfig,
    Provider,
)
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str = "user-admin") -> dict[str, str]:
    values = {"x-aperture-user": user_id}
    if user_id == "user-owner":
        values["x-aperture-tenant"] = "example"
    return values


def _docx_bytes(paragraphs: list[str]) -> bytes:
    body = "".join(
        f"<w:p><w:r><w:t>{escape(paragraph)}</w:t></w:r></w:p>" for paragraph in paragraphs
    )
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "word/document.xml",
            (
                '<?xml version="1.0" encoding="UTF-8"?>'
                '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                f"<w:body>{body}</w:body>"
                "</w:document>"
            ),
        )
    return buffer.getvalue()


def _mcp_approval_tokens(
    user_id: str = "user-admin", config_id: str = "tool-hermes-agent-mcp"
) -> list[str]:
    resp = client.post(f"/api/tools/{config_id}/approve", headers=headers(user_id))
    assert resp.status_code == 200
    return [resp.json()["approval_token"]]


def _client(api_key: str | None, transport: httpx.BaseTransport | None = None) -> OpenRouterClient:
    return OpenRouterClient(
        api_key=api_key,
        base_url="https://openrouter.ai/api/v1",
        app_title="Aperture QA",
        app_referer="http://localhost:5173",
        transport=transport,
    )


def _gateway(transport: httpx.BaseTransport | None = None) -> ModelGatewayClient:
    return ModelGatewayClient(transport=transport)


def test_model_gateway_timeout_is_deployment_configurable(monkeypatch: pytest.MonkeyPatch) -> None:
    get_settings.cache_clear()
    monkeypatch.setenv("APERTURE_MODEL_GATEWAY_TIMEOUT_SECONDS", "777")
    try:
        client = get_model_gateway_client()
        assert client._timeout == 777
    finally:
        get_settings.cache_clear()


def _activate_provider(provider_id: str) -> None:
    store = get_store()
    provider = store.providers[provider_id]
    provider.connected = True
    platform_keys = sorted(
        (
            key
            for key in store.provider_keys.values()
            if key.provider_id == provider_id and key.tenant_id is None
        ),
        key=lambda key: key.id,
    )
    if platform_keys:
        for index, key in enumerate(platform_keys):
            key.status = "Active" if index == 0 else "Inactive"
        store.save_runtime_state(urgent=True)
    else:
        store.create_provider_key(
            key_id=f"key-{provider_id}-test",
            provider=provider,
            name=f"{provider.name} Test Key",
            environment="Test",
            status="Active",
            expires="Not set",
            secret_value=f"{provider.kind}-test-key",
        )


def _activate_local_provider() -> None:
    store = get_store()
    provider = Provider(
        id="provider-local-test",
        name="Local Test Gateway",
        kind="openai-compatible",
        region="Local",
        base_url="https://local.test/v1",
        auth_type="bearer",
        auth_metadata={"compatibility": "openai-chat-completions"},
        connected=True,
        model_count=1,
        enabled_model_count=1,
    )
    store.providers[provider.id] = provider
    store.models["local-test-legal-v1"] = ModelConfig(
        id="local-test-legal-v1",
        provider_id=provider.id,
        provider_name=provider.name,
        name="Local Test Legal v1",
        upstream_model_id="local-test-legal-v1",
        group_ids=["group-litigation"],
    )
    store.create_provider_key(
        key_id="key-local-primary",
        provider=provider,
        name="Local Test Primary",
        environment="Local",
        status="Active",
        expires="Not set",
        secret_value="local-test-key",
    )


def test_map_model_known_passthrough_and_unknown_fail_closed() -> None:
    default = "openai/gpt-4o-mini"
    assert map_model("gpt-4o", default) == "openai/gpt-4o"
    assert map_model("gpt-4o-mini", default) == "openai/gpt-4o-mini"
    assert map_model("gpt-4.1", default) == "openai/gpt-4.1"
    assert map_model("o3-mini", default) == "openai/o3-mini"
    # The compatibility default argument is deliberately ignored: an unknown
    # selection must never run a different deployment-default model.
    with pytest.raises(ValueError, match="Unknown OpenRouter model id"):
        map_model("local-test-legal-v1", default)
    with pytest.raises(ValueError, match="Unknown OpenRouter model id"):
        map_model("totally-unknown", default)
    # Explicit OpenRouter-style ids pass through unchanged.
    assert map_model("anthropic/claude-3.5-sonnet", default) == "anthropic/claude-3.5-sonnet"


def test_real_completion_translates_response_and_maps_model(monkeypatch) -> None:
    _activate_provider("provider-azure")
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["api_key_present"] = bool(request.headers.get("api-key"))
        captured["body"] = request.read().decode()
        return httpx.Response(
            200,
            json={
                "id": "gen-abc123",
                "model": "openai/gpt-4o-mini",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Hello from the model"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 11, "completion_tokens": 4, "total_tokens": 15},
            },
        )

    fake = _gateway(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "hi"}]},
        headers=headers(),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["object"] == "chat.completion"
    assert body["model"] == "gpt-4o-mini"
    assert body["choices"][0]["message"]["content"] == "Hello from the model"
    assert body["usage"]["total_tokens"] == 15

    # Azure uses deployment-specific URLs and does not send an OpenAI-style model field.
    sent = json.loads(captured["body"])
    assert "model" not in sent
    assert sent["stream"] is False
    assert captured["url"] == (
        "https://example-openai.openai.azure.com/openai/deployments/"
        "gpt-4o-mini/chat/completions?api-version=2024-10-21"
    )
    assert captured["api_key_present"] is True


def test_openai_provider_routes_through_configured_provider(monkeypatch) -> None:
    _activate_provider("provider-openai")
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["authorization_present"] = bool(request.headers.get("authorization"))
        captured["body"] = request.read().decode()
        return httpx.Response(
            200,
            json={
                "id": "gen-openai",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "OpenAI-routed answer"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 8, "completion_tokens": 3, "total_tokens": 11},
            },
        )

    fake = _gateway(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={"model": "gpt-4.1", "messages": [{"role": "user", "content": "hi"}]},
        headers=headers(),
    )

    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "OpenAI-routed answer"

    sent = json.loads(captured["body"])
    assert sent["model"] == "gpt-4.1"
    assert captured["url"] == "https://api.openai.com/v1/chat/completions"
    assert captured["authorization_present"] is True

    latest = get_store().audit_events[-1]
    assert latest.metadata["provider_id"] == "provider-openai"
    assert latest.metadata["provider"] == "OpenAI"
    assert latest.metadata["provider_kind"] == "openai"
    assert latest.metadata["upstream_model"] == "gpt-4.1"
    assert latest.metadata["provider_secret"] == "[redacted]"


def test_runtime_context_is_validated_audited_and_sent_to_model(monkeypatch) -> None:
    _activate_provider("provider-azure")
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.read().decode()
        return httpx.Response(
            200,
            json={
                "id": "gen-runtime",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Runtime-aware answer"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 20, "completion_tokens": 5, "total_tokens": 25},
            },
        )

    fake = _gateway(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o",
            "surface": "draft",
            "draft_title": "Client Update Draft",
            "client_started_at": "2026-07-03T02:30:00+00:00",
            "messages": [{"role": "user", "content": "Draft the client update."}],
            "knowledge_config_ids": ["knowledge-box-matters"],
            "tool_config_ids": ["tool-hermes-example"],
            "web_enabled": False,
            "agent_enabled": True,
            "citations_enabled": True,
            "attachment_names": ["brief.pdf"],
        },
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    body = response.json()
    assert [citation["source_name"] for citation in body["citations"]] == [
        "Client weekly update draft.md",
        "Complaint response outline.docx",
        "brief.pdf",
    ]
    assert body["citations"][0]["source_uri"].startswith("box://")
    assert "response deadline" in body["citations"][0]["snippet"]
    assert body["citations"][-1]["source_uri"] == "upload://brief.pdf"

    sent = json.loads(captured["body"])
    system_message = sent["messages"][0]
    assert system_message["role"] == "system"
    assert "Box Matter Knowledge" in system_message["content"]
    assert "Retrieved knowledge excerpts:" in system_message["content"]
    assert (
        "Client weekly update draft: lead with the response deadline" in system_message["content"]
    )
    assert "Complaint response outline: preserve objections" in system_message["content"]
    assert "Hermes Client Updates" in system_message["content"]
    assert "Web search" not in system_message["content"]
    assert "Agent workflow requested: yes" in system_message["content"]
    assert "brief.pdf" in system_message["content"]
    assert sent["messages"][1]["content"] == "Draft the client update."

    latest = get_store().audit_events[-1]
    runtime_context = latest.metadata["runtime_context"]
    assert latest.metadata["surface"] == "draft"
    assert latest.metadata["draft_title"] == "Client Update Draft"
    assert latest.metadata["client_started_at"] == "2026-07-03T02:30:00+00:00"
    assert latest.metadata["execution_started_at"] == runtime_context["execution_started_at"]
    datetime.fromisoformat(runtime_context["execution_started_at"])
    assert runtime_context["surface"] == "draft"
    assert runtime_context["draft_title"] == "Client Update Draft"
    assert runtime_context["client_started_at"] == "2026-07-03T02:30:00+00:00"
    assert runtime_context["message_count"] == 1
    assert runtime_context["knowledge_config_ids"] == ["knowledge-box-matters"]
    assert runtime_context["tool_config_ids"] == ["tool-hermes-example"]
    assert runtime_context["web_enabled"] is False
    assert runtime_context["agent_enabled"] is True
    assert "knowledge_hits" not in runtime_context
    assert "retrieval_query" not in runtime_context
    assert (
        runtime_context["knowledge_hit_refs"][0]["source_name"] == "Client weekly update draft.md"
    )
    assert "text" not in runtime_context["knowledge_hit_refs"][0]
    assert runtime_context["citations"][0]["source_name"] == "Client weekly update draft.md"
    assert runtime_context["citations"][-1]["source_type"] == "upload"


def test_openrouter_web_search_sends_web_plugin_and_returns_web_citations(monkeypatch) -> None:
    _activate_provider("provider-openrouter")
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.read().decode()
        return httpx.Response(
            200,
            json={
                "id": "gen-web",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": "The current source says the filing deadline moved.",
                            "annotations": [
                                {
                                    "type": "url_citation",
                                    "url_citation": {
                                        "url": "https://example.com/current-filing-deadline",
                                        "title": "Current filing deadline",
                                        "content": "The filing deadline moved after the latest court order.",
                                    },
                                }
                            ],
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 30, "completion_tokens": 8, "total_tokens": 38},
            },
        )

    fake = _gateway(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-openai-gpt-5-5",
            "messages": [
                {"role": "user", "content": "What changed with the filing deadline today?"}
            ],
            "web_enabled": True,
            "citations_enabled": True,
        },
        headers=headers("user-owner"),
    )

    assert response.status_code == 200
    sent = json.loads(captured["body"])
    assert sent["model"] == "openai/gpt-5.5"
    assert "plugins" not in sent
    assert sent["tools"] == [{"type": "openrouter:web_search", "parameters": {"max_results": 5}}]
    assert (
        "Web search: enabled through provider-hosted public web search"
        in sent["messages"][0]["content"]
    )

    body = response.json()
    assert (
        body["choices"][0]["message"]["content"]
        == "The current source says the filing deadline moved."
    )
    assert body["citations"][-1] == {
        "id": "cite-web-1",
        "source_name": "Current filing deadline",
        "source_type": "web",
        "source_uri": "https://example.com/current-filing-deadline",
        "snippet": "The filing deadline moved after the latest court order.",
        "page_start": None,
        "page_end": None,
        "locator": None,
        "chunk_id": None,
        "k_index": None,
    }
    assert get_store().audit_events[-1].metadata["runtime_context"]["web_enabled"] is True


def test_openrouter_anthropic_upstream_uses_server_side_web_search(monkeypatch) -> None:
    """Anthropic-family OpenRouter routes ride the openrouter:web_search
    server tool like every other upstream: OpenRouter searches on its side
    (natively for Anthropic models), nothing is injected into the
    conversation, and the platform engine must never run."""
    _activate_provider("provider-openrouter")
    store = get_store()
    store.models["openrouter-anthropic-claude-test"] = ModelConfig(
        id="openrouter-anthropic-claude-test",
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="Anthropic: Claude Test",
        upstream_model_id="anthropic/claude-3.5-sonnet",
        group_ids=["group-litigation"],
    )
    captured: dict[str, object] = {}

    def _platform_search_must_not_run(_settings):
        raise AssertionError("Platform web search must not run for OpenRouter routes.")

    monkeypatch.setattr(
        "app.routes.chat.web_search_client_from_config", _platform_search_must_not_run
    )

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.read().decode()
        return httpx.Response(
            200,
            json={
                "id": "gen-anthropic-web",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": "The deadline moved after the latest court order.",
                            "annotations": [
                                {
                                    "type": "url_citation",
                                    "url_citation": {
                                        "url": "https://example.com/current-filing-deadline",
                                        "title": "Current filing deadline",
                                        "content": "The filing deadline moved after the latest court order.",
                                    },
                                }
                            ],
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 24, "completion_tokens": 6, "total_tokens": 30},
            },
        )

    fake = _gateway(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-anthropic-claude-test",
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "Hi! How can I help?"},
                {"role": "user", "content": "What changed with the filing deadline today?"},
            ],
            "web_enabled": True,
            "citations_enabled": True,
        },
        headers=headers(),
    )

    assert response.status_code == 200
    sent = json.loads(captured["body"])
    assert sent["model"] == "anthropic/claude-3.5-sonnet"
    # The deprecated plugin field must never be sent; the server tool rides
    # the tools array and is dialect-safe for the assistant-turn history above.
    assert "plugins" not in sent
    assert sent["tools"] == [
        {"type": "openrouter:web_search", "parameters": {"max_results": 5}}
    ]
    assert [message["role"] for message in sent["messages"]] == [
        "system",
        "user",
        "assistant",
        "user",
    ]
    body = response.json()
    web_citations = [item for item in body["citations"] if item["source_type"] == "web"]
    assert web_citations[0]["source_uri"] == "https://example.com/current-filing-deadline"


def test_openrouter_draft_inline_edit_forces_provider_web_plugin(monkeypatch) -> None:
    _activate_provider("provider-openrouter")
    captured: dict[str, object] = {"request_count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["request_count"] = int(captured["request_count"]) + 1
        captured["body"] = request.read().decode()
        return httpx.Response(
            200,
            json={
                "id": "gen-inline-openrouter-web",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": "NASA's current Artemis II schedule reflects the latest mission update.",
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 22, "completion_tokens": 9, "total_tokens": 31},
            },
        )

    fake = _gateway(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)
    inline_prompt = "\n".join(
        [
            'You are editing a highlighted passage in the draft titled "Moon Brief".',
            "Rewrite only the highlighted passage according to the user's instruction.",
            "Return only the replacement text. Do not add headings, labels, explanations, bullets unless requested, or any surrounding document section.",
            "",
            "User instruction:",
            "Research the current Artemis II launch schedule and update this passage.",
            "",
            "Highlighted passage:",
            "Artemis II will launch soon.",
        ]
    )

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-openai-gpt-5-5",
            "messages": [{"role": "user", "content": inline_prompt}],
            "surface": "draft",
            "web_enabled": False,
            "citations_enabled": False,
        },
        headers=headers("user-owner"),
    )

    assert response.status_code == 200
    assert captured["request_count"] == 1
    sent = json.loads(str(captured["body"]))
    assert sent["tools"] == [{"type": "openrouter:web_search", "parameters": {"max_results": 5}}]
    assert (
        "Web search: enabled through provider-hosted public web search"
        in sent["messages"][0]["content"]
    )
    assert get_store().audit_events[-1].metadata["runtime_context"]["web_enabled"] is True


def test_openrouter_draft_inline_rewrite_skips_web_plugin(monkeypatch) -> None:
    _activate_provider("provider-openrouter")
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.read().decode()
        return httpx.Response(
            200,
            json={
                "id": "gen-inline-openrouter-direct",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": "The spaceship crossed deep space on its new course.",
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 18, "completion_tokens": 8, "total_tokens": 26},
            },
        )

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: _gateway(transport=httpx.MockTransport(handler)),
    )
    inline_prompt = "\n".join(
        [
            'You are editing a highlighted passage in the draft titled "Spaceship Note".',
            "Rewrite only the highlighted passage according to the user's instruction.",
            "Return only the replacement text.",
            "",
            "User instruction:",
            "Expand on the spaceship's journey.",
            "",
            "Highlighted passage:",
            "The ship crossed the stars.",
        ]
    )

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-openai-gpt-5-5",
            "messages": [{"role": "user", "content": inline_prompt}],
            "surface": "draft",
            "web_enabled": False,
            "citations_enabled": False,
        },
        headers=headers("user-owner"),
    )

    assert response.status_code == 200
    sent = json.loads(str(captured["body"]))
    assert "plugins" not in sent
    assert (
        "Web search: enabled through provider-hosted public web search"
        not in sent["messages"][0]["content"]
    )
    assert get_store().audit_events[-1].metadata["runtime_context"]["web_enabled"] is False


def test_non_openrouter_models_use_platform_web_search(monkeypatch) -> None:
    _activate_provider("provider-openai")
    captured: dict[str, object] = {}

    class FakeWebSearch:
        engine = "duckduckgo"

        def search(self, query: str) -> list[WebSearchResult]:
            captured["query"] = query
            return [
                WebSearchResult(
                    title="Current filing deadline",
                    url="https://example.com/current-filing-deadline",
                    snippet="The filing deadline moved after the latest court order.",
                )
            ]

    monkeypatch.setattr(
        "app.routes.chat.web_search_client_from_config", lambda _settings: FakeWebSearch()
    )

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.read().decode()
        return httpx.Response(
            200,
            json={
                "id": "gen-openai-web",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": "The deadline moved; see [W1].",
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 20, "completion_tokens": 6, "total_tokens": 26},
            },
        )

    fake = _gateway(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4.1",
            "messages": [
                {"role": "user", "content": "What changed with the filing deadline today?"}
            ],
            "web_enabled": True,
            "citations_enabled": True,
        },
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    assert captured["query"] == "What changed with the filing deadline today?"
    sent = json.loads(captured["body"])
    # Platform search injects prompt context; OpenRouter's plugin field never
    # goes to non-OpenRouter providers.
    assert "plugins" not in sent
    assert "tools" not in sent
    system_prompt = sent["messages"][0]["content"]
    assert "Live web search results (engine: duckduckgo" in system_prompt
    assert (
        "[W1] Current filing deadline (https://example.com/current-filing-deadline)"
        in system_prompt
    )

    body = response.json()
    web_citations = [item for item in body["citations"] if item["source_type"] == "web"]
    assert web_citations == [
        {
            "id": "cite-web-1",
            "source_name": "Current filing deadline",
            "source_type": "web",
            "source_uri": "https://example.com/current-filing-deadline",
            "snippet": "The filing deadline moved after the latest court order.",
            "page_start": None,
            "page_end": None,
            "locator": None,
            "chunk_id": None,
            "k_index": None,
        }
    ]


def test_draft_inline_edit_forces_real_web_search_with_focused_query(monkeypatch) -> None:
    _activate_provider("provider-openai")
    captured: dict[str, object] = {"request_count": 0}

    class FakeWebSearch:
        engine = "duckduckgo"

        def search(self, query: str) -> list[WebSearchResult]:
            captured["query"] = query
            return [
                WebSearchResult(
                    title="Artemis II mission update",
                    url="https://example.com/artemis-ii-update",
                    snippet="NASA published an updated Artemis II mission schedule.",
                )
            ]

    monkeypatch.setattr(
        "app.routes.chat.web_search_client_from_config", lambda _settings: FakeWebSearch()
    )

    def handler(request: httpx.Request) -> httpx.Response:
        captured["request_count"] = int(captured["request_count"]) + 1
        captured["body"] = request.read().decode()
        return httpx.Response(
            200,
            json={
                "id": "gen-inline-web",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": (
                                "```html\n<p><strong>Replacement:</strong> NASA's latest schedule places "
                                "Artemis II in its updated mission window.</p>"
                                "<script>removeDocument()</script>\n```"
                            ),
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 24, "completion_tokens": 10, "total_tokens": 34},
            },
        )

    fake = _gateway(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    inline_prompt = "\n".join(
        [
            'You are editing a highlighted passage in the draft titled "Moon Brief".',
            "Rewrite only the highlighted passage according to the user's instruction.",
            "Return only the replacement text. Do not add headings, labels, explanations, bullets unless requested, or any surrounding document section.",
            "",
            "User instruction:",
            "Research the current Artemis II launch schedule and update this passage.",
            "",
            "Highlighted passage:",
            "Artemis II will launch soon.",
        ]
    )
    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4.1",
            "messages": [{"role": "user", "content": inline_prompt}],
            "surface": "draft",
            # This is the legacy inline-editor payload that caused the bug.
            "web_enabled": False,
            "citations_enabled": False,
        },
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    assert captured["request_count"] == 1
    replacement = response.json()["choices"][0]["message"]["content"]
    assert replacement == (
        "NASA's latest schedule places Artemis II in its updated mission window."
    )
    assert "<" not in replacement
    assert captured["query"] == (
        "Research the current Artemis II launch schedule and update this passage. "
        "Context: Artemis II will launch soon."
    )
    assert "You are editing a highlighted passage" not in str(captured["query"])
    sent = json.loads(str(captured["body"]))
    assert "plugins" not in sent
    assert "Live web search results (engine: duckduckgo" in sent["messages"][0]["content"]
    audit_context = get_store().audit_events[-1].metadata["runtime_context"]
    assert audit_context["web_enabled"] is True


def test_draft_inline_edit_retries_advice_until_provider_returns_replacement(monkeypatch) -> None:
    _activate_provider("provider-openai")
    requests: list[dict[str, object]] = []

    class FakeWebSearch:
        engine = "duckduckgo"

        def search(self, _query: str) -> list[WebSearchResult]:
            return [
                WebSearchResult(
                    title="Artemis II update",
                    url="https://example.com/artemis-update",
                    snippet="NASA published the current Artemis II schedule.",
                )
            ]

    monkeypatch.setattr(
        "app.routes.chat.web_search_client_from_config", lambda _settings: FakeWebSearch()
    )

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.read().decode()))
        content = (
            "You should replace the highlighted passage with the current mission schedule."
            if len(requests) == 1
            else "NASA's current Artemis II schedule places the crewed mission in its updated window."
        )
        return httpx.Response(
            200,
            json={
                "id": f"inline-{len(requests)}",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": content},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30},
            },
        )

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: _gateway(transport=httpx.MockTransport(handler)),
    )
    inline_prompt = "\n".join(
        [
            'You are editing a highlighted passage in the draft titled "Moon Brief".',
            "Rewrite only the highlighted passage according to the user's instruction.",
            "Return only the replacement text.",
            "",
            "User instruction:",
            "Research and replace this with the current Artemis II schedule.",
            "",
            "Highlighted passage:",
            "Artemis II will launch soon.",
        ]
    )

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4.1",
            "messages": [{"role": "user", "content": inline_prompt}],
            "surface": "draft",
            "web_enabled": False,
            "citations_enabled": False,
        },
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    assert len(requests) == 2
    assert response.json()["choices"][0]["message"]["content"].startswith(
        "NASA's current Artemis II schedule"
    )
    correction_prompt = str(requests[1]["messages"][-1]["content"])
    assert "editing advice instead of usable replacement text" in correction_prompt
    assert "Return only the exact replacement passage" in correction_prompt


def test_page_number_removal_uses_provider_and_preserves_document_assets(monkeypatch) -> None:
    _activate_provider("provider-openrouter")
    captured: list[dict[str, object]] = []
    revised_document = """# Artemis II: Humanity's Return to the Moon

This is a 15-page paper-style draft.

## Introduction

Opening paragraph stays intact.

[NASA mission page](https://www.nasa.gov/mission/artemis-ii/?source=draft)

![Official Artemis II crew portrait](https://commons.wikimedia.org/wiki/Special:FilePath/Artemis%202%20Crew%20Portrait.jpg "Crew portrait")

## Mission Overview

Mission details stay intact.

### Crew

Crew details stay intact.
"""

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(json.loads(request.read().decode()))
        return httpx.Response(
            200,
            json={
                "id": "provider-revision",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": revised_document},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 800, "completion_tokens": 220, "total_tokens": 1020},
            },
        )

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: _gateway(transport=httpx.MockTransport(handler)),
    )
    current_document = """# Artemis II: Humanity's Return to the Moon

This is a 15-page paper-style draft.

Page 1

## Page 1 — Introduction

Opening paragraph stays intact.

[NASA mission page](https://www.nasa.gov/mission/artemis-ii/?source=draft)

![Official Artemis II crew portrait](https://commons.wikimedia.org/wiki/Special:FilePath/Artemis%202%20Crew%20Portrait.jpg "Crew portrait")

Page 2

## Page 2 — Mission Overview

Mission details stay intact.

### Page Three — Crew

Crew details stay intact.
"""
    revision_prompt = "\n\n".join(
        [
            "Document title: Artemis II",
            (
                "Revision request: Remove all the text from document that is counting pages "
                "and just leave the headers. I don't need to see page one, two, three, four, "
                "etc written in the document itself."
            ),
            "Drafting agent: Anthropic: Claude Opus 4.8",
            "Revise the current document as the deliverable.",
            f"Current document:\n{current_document}",
        ]
    )

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-openai-gpt-5-5",
            "messages": [{"role": "user", "content": revision_prompt}],
            "surface": "draft",
            "web_enabled": False,
            "citations_enabled": False,
            "max_completion_tokens": 12000,
        },
        headers=headers("user-owner"),
    )

    assert response.status_code == 200
    body = response.json()
    revised = body["choices"][0]["message"]["content"]
    assert body["id"] == "provider-revision"
    assert body["usage"]["total_tokens"] == 1020
    assert len(captured) == 1
    system_prompt = str(captured[0]["messages"][0]["content"])
    assert "Focused Drafts revision contract" in system_prompt
    assert "make only the requested change" in system_prompt
    assert "Preserve all 1 submitted Markdown image reference" in system_prompt
    assert "all 1 submitted hyperlink target" in system_prompt
    assert "15-page paper-style" in revised
    assert "Page 1\n" not in revised
    assert "Page 2\n" not in revised
    assert "## Introduction" in revised
    assert "## Mission Overview" in revised
    assert "### Crew" in revised
    assert "Opening paragraph stays intact." in revised
    assert "Mission details stay intact." in revised
    assert "Crew details stay intact." in revised
    assert "[NASA mission page](https://www.nasa.gov/mission/artemis-ii/?source=draft)" in revised
    assert (
        "![Official Artemis II crew portrait]"
        "(https://commons.wikimedia.org/wiki/Special:FilePath/"
        'Artemis%202%20Crew%20Portrait.jpg "Crew portrait")' in revised
    )
    assert get_store().audit_events[-1].action == "chat.completion"


def test_two_page_draft_expansion_retries_until_requested_growth_is_returned(
    monkeypatch,
) -> None:
    _activate_provider("provider-openrouter")
    requests: list[dict[str, object]] = []
    current_document = """# Operations Brief

The existing introduction explains the mission purpose and current operating context.

The background section preserves the original timeline, owners, and primary dependencies.

The analysis section explains the current approach, known risks, and expected outcomes.

The conclusion summarizes the existing recommendation and the next decision checkpoint.
"""
    added_analysis = " ".join(
        ["Additional operational analysis adds evidence owners milestones and safeguards."] * 90
    )
    expanded_document = (
        f"{current_document}\n\n## Expanded Analysis\n\n{added_analysis}\n\n"
        f"## Additional Recommendations\n\n{added_analysis}"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.read().decode()))
        content = current_document if len(requests) == 1 else expanded_document
        return httpx.Response(
            200,
            json={
                "id": f"expansion-{len(requests)}",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": content},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 80, "completion_tokens": 60, "total_tokens": 140},
            },
        )

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: _gateway(transport=httpx.MockTransport(handler)),
    )
    revision_prompt = "\n\n".join(
        [
            "Document title: Operations Brief",
            "Revision request: Make this two pages longer and expand on the content.",
            "Drafting agent: Anthropic: Claude Opus 4.8",
            "Revise the current document as the deliverable.",
            f"Current document:\n{current_document}",
        ]
    )

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-openai-gpt-5-5",
            "messages": [{"role": "user", "content": revision_prompt}],
            "surface": "draft",
            "web_enabled": False,
            "citations_enabled": False,
            "max_completion_tokens": 24000,
        },
        headers=headers("user-owner"),
    )

    assert response.status_code == 200
    assert len(requests) == 2
    revised = response.json()["choices"][0]["message"]["content"]
    assert "Expanded Analysis" in revised
    assert "Additional Recommendations" in revised
    correction_prompt = str(requests[1]["messages"][-1]["content"])
    assert "2 additional pages" in correction_prompt
    assert "700 additional words" in correction_prompt


def test_draft_revision_fails_closed_when_provider_repeatedly_drops_assets(monkeypatch) -> None:
    _activate_provider("provider-openrouter")
    request_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        request.read()
        return httpx.Response(
            200,
            json={
                "id": f"unsafe-revision-{request_count}",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": "# Revised document\n\nThe provider dropped every protected asset.",
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70},
            },
        )

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: _gateway(transport=httpx.MockTransport(handler)),
    )
    current_document = """# Existing document

[Research source](https://example.com/source)

![Evidence image](https://example.com/evidence.jpg "Evidence")
"""
    revision_prompt = "\n\n".join(
        [
            "Document title: Existing document",
            "Revision request: Remove the written page-number labels only.",
            "Drafting agent: OpenAI",
            "Revise the current document as the deliverable.",
            f"Current document:\n{current_document}",
        ]
    )

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-openai-gpt-5-5",
            "messages": [{"role": "user", "content": revision_prompt}],
            "surface": "draft",
            "web_enabled": False,
            "citations_enabled": False,
        },
        headers=headers("user-owner"),
    )

    assert response.status_code == 502
    assert request_count == 3
    assert "original document was left unchanged" in response.json()["detail"].lower()


def test_draft_revision_correction_pass_restores_dropped_assets(monkeypatch) -> None:
    _activate_provider("provider-openrouter")
    requests: list[dict[str, object]] = []
    protected_link = "https://example.com/source"
    protected_image = "https://example.com/evidence.jpg"

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.read().decode()))
        if len(requests) == 1:
            content = "# Revised document\n\nThe first pass dropped protected assets."
        else:
            content = (
                "# Revised document\n\n"
                f"[Research source]({protected_link})\n\n"
                f'![Evidence image]({protected_image} "Evidence")\n\n'
                "The focused edit is complete."
            )
        return httpx.Response(
            200,
            json={
                "id": f"revision-{len(requests)}",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": content},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70},
            },
        )

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: _gateway(transport=httpx.MockTransport(handler)),
    )
    current_document = (
        "# Existing document\n\n"
        f"[Research source]({protected_link})\n\n"
        f'![Evidence image]({protected_image} "Evidence")\n'
    )
    revision_prompt = "\n\n".join(
        [
            "Document title: Existing document",
            "Revision request: Remove the written page-number labels only.",
            "Drafting agent: OpenAI",
            "Revise the current document as the deliverable.",
            f"Current document:\n{current_document}",
        ]
    )

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-openai-gpt-5-5",
            "messages": [{"role": "user", "content": revision_prompt}],
            "surface": "draft",
            "web_enabled": False,
            "citations_enabled": False,
        },
        headers=headers("user-owner"),
    )

    assert response.status_code == 200
    assert len(requests) == 2
    revised = response.json()["choices"][0]["message"]["content"]
    assert protected_link in revised
    assert protected_image in revised
    correction_messages = requests[1]["messages"]
    correction_prompt = str(correction_messages[-1]["content"])
    assert "removed existing image references" in correction_prompt
    assert "removed existing hyperlinks" in correction_prompt


def test_start_over_revision_supersedes_document_without_preservation_block(monkeypatch) -> None:
    """A pivot ("changed my mind, new topic") replaces the document: no
    preservation retry demanding the old topic's assets, no fail-closed 502."""
    _activate_provider("provider-openrouter")
    requests: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.read().decode()))
        return httpx.Response(
            200,
            json={
                "id": f"pivot-{len(requests)}",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": (
                                "# Solar Microgrid Proposal\n\n"
                                "A wholly new proposal drafted from scratch about community solar "
                                "microgrids, with deployment phases, cost model, and governance."
                            ),
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 60, "completion_tokens": 30, "total_tokens": 90},
            },
        )

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: _gateway(transport=httpx.MockTransport(handler)),
    )
    current_document = (
        "# Office lease memo\n\n"
        "[Research source](https://example.com/source)\n\n"
        '![Evidence image](https://example.com/evidence.jpg "Evidence")\n\n'
        "Detailed lease analysis for the downtown office. The tenant improvements "
        "allowance covers build-out costs across the first two years of the term.\n\n"
        "Renewal options extend the lease at market rates with six months notice.\n\n"
        "Operating expense pass-throughs follow the standard base-year structure.\n"
    )
    revision_prompt = "\n\n".join(
        [
            "Document title: Office lease memo",
            "Revision request: I changed my mind — scrap this and write a proposal about solar microgrids instead.",
            "Drafting agent: OpenAI",
            "Revise the current document as the deliverable.",
            f"Current document:\n{current_document}",
        ]
    )

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-openai-gpt-5-5",
            "messages": [{"role": "user", "content": revision_prompt}],
            "surface": "draft",
            "web_enabled": False,
            "citations_enabled": False,
        },
        headers=headers("user-owner"),
    )

    assert response.status_code == 200
    # One provider call: the supersede request never triggers the preservation
    # or iteration correction loop.
    assert len(requests) == 1
    revised = response.json()["choices"][0]["message"]["content"]
    assert "Solar Microgrid Proposal" in revised
    assert "example.com/evidence.jpg" not in revised


def test_narrow_draft_revision_fails_closed_instead_of_replacing_document(monkeypatch) -> None:
    _activate_provider("provider-openrouter")
    requests: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.read().decode()))
        return httpx.Response(
            200,
            json={
                "id": f"replacement-{len(requests)}",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": (
                                "# A Different Document\n\n"
                                "This newly generated response ignores the existing Artemis report."
                            ),
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 60, "completion_tokens": 20, "total_tokens": 80},
            },
        )

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: _gateway(transport=httpx.MockTransport(handler)),
    )
    current_document = """# Artemis II Mission Report

Artemis II carries four astronauts around the Moon during the first crewed Artemis flight.

The mission tests Orion life support navigation communications and deep space operations.

Commander Reid Wiseman leads a crew that includes Victor Glover Christina Koch and Jeremy Hansen.

The Space Launch System sends Orion beyond low Earth orbit toward its lunar flyby trajectory.

Mission controllers evaluate spacecraft performance while preserving options for a safe return.

The flight supports later Artemis missions that will send astronauts to the lunar surface.
"""
    revision_prompt = "\n\n".join(
        [
            "Document title: Artemis II Mission Report",
            "Revision request: Remove only the written page-number labels from the headers.",
            "Drafting agent: OpenAI",
            "Revise the current document as the deliverable.",
            f"Current document:\n{current_document}",
        ]
    )

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-openai-gpt-5-5",
            "messages": [{"role": "user", "content": revision_prompt}],
            "surface": "draft",
            "web_enabled": False,
            "citations_enabled": False,
        },
        headers=headers("user-owner"),
    )

    assert response.status_code == 502
    assert len(requests) == 3
    assert "original document was left unchanged" in response.json()["detail"].lower()
    correction_prompt = str(requests[1]["messages"][-1]["content"])
    assert "omitted" in correction_prompt
    assert "not advice, commentary, html, or a new document" in correction_prompt.lower()


def test_web_search_respects_disabled_web_connector() -> None:
    _activate_provider("provider-openrouter")
    store = get_store()
    store.connectors["web"].tenant_enabled = False

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-openai-gpt-5-5",
            "messages": [{"role": "user", "content": "Search the web."}],
            "web_enabled": True,
        },
        headers=headers("user-owner"),
    )

    assert response.status_code == 400
    assert "Web search is turned off for this workspace" in response.json()["detail"]


def test_web_search_respects_disabled_web_connector_config_record() -> None:
    """The Admin UI toggle writes a connector-config record; enabled=false blocks web search."""
    _activate_provider("provider-openrouter")

    create = client.post(
        "/api/admin/connector-configs",
        json={"connector_id": "web", "enabled": False, "settings": {}},
        headers=headers("user-admin"),
    )
    assert create.status_code == 201

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-openai-gpt-5-5",
            "messages": [{"role": "user", "content": "Search the web."}],
            "web_enabled": True,
        },
        headers=headers("user-owner"),
    )

    assert response.status_code == 400
    assert "Web search is turned off for this workspace" in response.json()["detail"]


def test_web_connector_config_settings_drive_platform_search(monkeypatch) -> None:
    _activate_provider("provider-openai")
    captured: dict[str, object] = {}

    class FakeWebSearch:
        engine = "searxng"

        def search(self, query: str) -> list[WebSearchResult]:
            return [
                WebSearchResult(
                    title="Configured engine hit", url="https://example.com/hit", snippet="hit"
                )
            ]

    def fake_factory(settings):
        captured["settings"] = settings
        return FakeWebSearch()

    monkeypatch.setattr("app.routes.chat.web_search_client_from_config", fake_factory)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "gen-config-driven",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "ok"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {},
            },
        )

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: _gateway(transport=httpx.MockTransport(handler)),
    )

    create = client.post(
        "/api/admin/connector-configs",
        json={
            "connector_id": "web",
            "enabled": True,
            "settings": {
                "engine": "searxng",
                "searxng_base_url": "http://searxng.local:8080",
                "max_results": 3,
            },
        },
        headers=headers("user-admin"),
    )
    assert create.status_code == 201

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4.1",
            "messages": [{"role": "user", "content": "Search the web."}],
            "web_enabled": True,
        },
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    # The admin-saved connector settings reached the search client factory.
    assert captured["settings"] == {
        "engine": "searxng",
        "searxng_base_url": "http://searxng.local:8080",
        "max_results": 3,
    }


def test_web_connector_admin_test_endpoint_reports_engine_and_live_query(monkeypatch) -> None:
    class FakeWebSearch:
        engine = "searxng"

        def search(self, query: str) -> list[WebSearchResult]:
            return [
                WebSearchResult(
                    title="SearXNG works", url="https://example.com/searx", snippet="ok"
                )
            ]

    monkeypatch.setattr(
        "app.core.connector_auth.web_search_client_from_config",
        lambda settings: FakeWebSearch(),
    )

    create = client.post(
        "/api/admin/connector-configs",
        json={
            "connector_id": "web",
            "enabled": True,
            "settings": {"engine": "searxng", "searxng_base_url": "http://searxng.local:8080"},
        },
        headers=headers("user-admin"),
    )
    assert create.status_code == 201
    config_id = create.json()["id"]

    result = client.post(
        f"/api/admin/connector-configs/{config_id}/test", headers=headers("user-admin")
    )
    assert result.status_code == 200
    body = result.json()
    assert body["status"] == "ok"
    assert body["message"] == "Web search is working through searxng."
    check_names = [check["name"] for check in body["checks"]]
    assert check_names == ["Engine", "Live query"]
    assert "SearXNG works" in body["checks"][1]["detail"]


def test_web_connector_test_endpoint_is_incomplete_without_searxng_url() -> None:
    create = client.post(
        "/api/admin/connector-configs",
        json={
            "connector_id": "web",
            "enabled": True,
            "settings": {"engine": "searxng"},
        },
        headers=headers("user-admin"),
    )
    assert create.status_code == 201
    config_id = create.json()["id"]

    result = client.post(
        f"/api/admin/connector-configs/{config_id}/test", headers=headers("user-admin")
    )
    assert result.status_code == 200
    body = result.json()
    assert body["status"] == "incomplete"
    assert "SearXNG instance URL" in body["message"]


def test_platform_web_search_failure_returns_honest_503(monkeypatch) -> None:
    _activate_provider("provider-openai")

    class BrokenWebSearch:
        engine = "searxng"

        def search(self, query: str) -> list[WebSearchResult]:
            raise WebSearchError("SearXNG request failed: ConnectError")

    monkeypatch.setattr(
        "app.routes.chat.web_search_client_from_config", lambda _settings: BrokenWebSearch()
    )

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4.1",
            "messages": [{"role": "user", "content": "Search the web."}],
            "web_enabled": True,
        },
        headers=headers("user-admin"),
    )

    assert response.status_code == 503
    assert "Web search (searxng) is unavailable" in response.json()["detail"]


def test_agent_profile_discovers_mcp_tools_for_prompt_and_audit(monkeypatch) -> None:
    _activate_provider("provider-openrouter")
    captured: dict[str, object] = {}

    def fake_mcp_health(tool, timeout_seconds: float = 3.0) -> McpHealthResponse:
        return McpHealthResponse(
            tool_config_id=tool.id,
            name=tool.name,
            transport="stdio",
            command="hermes",
            status="ready",
            message="MCP server responded with 2 tools.",
            server_info={"name": "hermes", "version": "1.26.0"},
            tools=[
                McpToolSummary(name="messages_send", description="Send a message through Hermes."),
                McpToolSummary(name="events_wait", description="Wait for Hermes events."),
            ],
        )

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.read().decode()
        return httpx.Response(
            200,
            json={
                "id": "gen-agent-mcp",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "MCP-aware agent answer"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 30, "completion_tokens": 4, "total_tokens": 34},
            },
        )

    monkeypatch.setattr("app.routes.chat.check_mcp_server", fake_mcp_health)
    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: _gateway(transport=httpx.MockTransport(handler)),
    )

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "agent-client-update",
            "agent_profile_id": "agent-client-update",
            "messages": [{"role": "user", "content": "Use the agent companion."}],
            "agent_enabled": True,
            "approval_tokens": _mcp_approval_tokens(),
        },
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "MCP-aware agent answer"

    sent = json.loads(captured["body"])
    system_message = sent["messages"][0]["content"]
    assert "MCP servers:" in system_message
    assert "Hermes Agent MCP: ready; server hermes 1.26.0" in system_message
    assert "tools messages_send, events_wait" in system_message

    runtime_context = get_store().audit_events[-1].metadata["runtime_context"]
    assert runtime_context["mcp_tool_names"] == ["messages_send", "events_wait"]
    assert runtime_context["mcp_servers"][0]["tool_config_id"] == "tool-hermes-agent-mcp"
    assert runtime_context["mcp_servers"][0]["status"] == "ready"
    assert runtime_context["mcp_servers"][0]["tool_names"] == ["messages_send", "events_wait"]
    assert "tools" not in runtime_context["mcp_servers"][0]
    assert "command" not in runtime_context["mcp_servers"][0]


def test_admin_can_run_visible_agent_profile_without_platform_model_enablement(monkeypatch) -> None:
    _activate_provider("provider-openrouter")
    store = get_store()
    store.models["agent-admin-draft"] = ModelConfig(
        id="agent-admin-draft",
        tenant_id="tenant-example",
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="Admin Draft Agent",
        upstream_model_id="openai/gpt-4o-mini",
        platform_enabled=False,
        is_custom=True,
        created_by="Alex Morgan",
        visibility="tenant",
        meta_prompt="Use the tenant drafting workflow.",
    )

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.read().decode())
        assert body["model"] == "openai/gpt-4o-mini"
        return httpx.Response(
            200,
            json={
                "id": "gen-admin-agent",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Admin agent answer"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15},
            },
        )

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: _gateway(transport=httpx.MockTransport(handler)),
    )

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "agent-admin-draft",
            "agent_profile_id": "agent-admin-draft",
            "messages": [{"role": "user", "content": "Use the admin agent."}],
            "agent_enabled": True,
        },
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "Admin agent answer"


def test_agent_profile_invokes_configured_mcp_tool_for_chat_runtime(monkeypatch) -> None:
    _activate_provider("provider-openrouter")
    store = get_store()
    store.tool_configs["tool-hermes-agent-mcp"].settings["runtime_invocations"] = [
        {
            "tool_name": "lookup_matter",
            "label": "Matter lookup",
            "arguments": {"query": "{{query}}", "agent": "{{agent_profile_id}}"},
        }
    ]
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.read().decode()
        return httpx.Response(
            200,
            json={
                "id": "gen-mcp-invoke",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "MCP-informed answer"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 25, "completion_tokens": 4, "total_tokens": 29},
            },
        )

    def fake_mcp_health(tool, timeout_seconds: float = 3.0) -> McpHealthResponse:
        return McpHealthResponse(
            tool_config_id=tool.id,
            name=tool.name,
            transport="stdio",
            command="hermes",
            status="ready",
            message="MCP server responded with 1 tool.",
            tools=[McpToolSummary(name="lookup_matter", description="Look up a matter.")],
        )

    def fake_mcp_call(
        tool,
        *,
        tool_name: str,
        arguments: dict[str, object] | None = None,
        label: str | None = None,
    ):
        assert tool.id == "tool-hermes-agent-mcp"
        assert tool_name == "lookup_matter"
        assert arguments == {
            "query": "Use the agent companion to check matter 1042.",
            "agent": "agent-client-update",
        }
        return McpToolCallResponse(
            tool_config_id=tool.id,
            name=tool.name,
            transport="stdio",
            command="hermes",
            tool_name=tool_name,
            label=label,
            status="ready",
            message="MCP tool call completed.",
            result_text="Matter 1042 is active and assigned to Litigation.",
            structured_content={"matter": "1042", "status": "active"},
        )

    monkeypatch.setattr("app.routes.chat.check_mcp_server", fake_mcp_health)
    monkeypatch.setattr("app.routes.chat.call_mcp_tool", fake_mcp_call)
    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: _gateway(transport=httpx.MockTransport(handler)),
    )

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "agent-client-update",
            "agent_profile_id": "agent-client-update",
            "messages": [
                {"role": "user", "content": "Use the agent companion to check matter 1042."}
            ],
            "agent_enabled": True,
            "approval_tokens": _mcp_approval_tokens(),
        },
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["choices"][0]["message"]["content"] == "MCP-informed answer"
    sent = json.loads(captured["body"])
    system_message = sent["messages"][0]["content"]
    assert "MCP tool results:" in system_message
    assert "Matter 1042 is active and assigned to Litigation" in system_message
    assert body["citations"][-1] == {
        "id": "cite-mcp-1",
        "source_name": "Matter lookup",
        "source_type": "mcp",
        "source_uri": "mcp://tool-hermes-agent-mcp/lookup_matter",
        "snippet": "Matter 1042 is active and assigned to Litigation.",
        "page_start": None,
        "page_end": None,
        "locator": None,
        "chunk_id": None,
        "k_index": None,
    }

    runtime_context = get_store().audit_events[-1].metadata["runtime_context"]
    assert runtime_context["mcp_tool_results"] == [
        {
            "tool_config_id": "tool-hermes-agent-mcp",
            "server_name": "Hermes Agent MCP",
            "transport": "stdio",
            "tool_name": "lookup_matter",
            "label": "Matter lookup",
            "status": "ready",
            "message": "MCP tool call completed.",
            "is_error": False,
            "result_chars": len("Matter 1042 is active and assigned to Litigation."),
            "structured_content_type": "dict",
        }
    ]


def test_agent_profile_requires_user_approval_before_mcp_runtime() -> None:
    response = client.post(
        "/api/chat/complete",
        json={
            "model": "agent-client-update",
            "agent_profile_id": "agent-client-update",
            "messages": [{"role": "user", "content": "Use the agent companion."}],
            "agent_enabled": True,
        },
        headers=headers("user-admin"),
    )

    assert response.status_code == 403
    assert (
        response.json()["detail"] == "MCP tool approval required before running: Hermes Agent MCP."
    )


def test_hermes_companion_auto_attaches_tenant_mcp_tool(monkeypatch) -> None:
    _activate_provider("provider-azure")
    store = get_store()
    # Hermes is admin-approved and off by default; grant it for this test.
    store.groups["group-litigation"].permissions["hermes_companion"] = True
    store.models["agent-hermes-auto"] = ModelConfig(
        id="agent-hermes-auto",
        tenant_id="tenant-example",
        provider_id="provider-azure",
        provider_name="Azure OpenAI",
        name="Hermes Auto Agent",
        upstream_model_id="gpt-4o",
        group_ids=["group-litigation"],
        agentic_companion="hermes",
        tool_config_ids=[],
    )
    captured: dict[str, object] = {}

    def fake_mcp_health(tool, timeout_seconds: float = 3.0) -> McpHealthResponse:
        return McpHealthResponse(
            tool_config_id=tool.id,
            name=tool.name,
            transport="stdio",
            command="hermes",
            status="ready",
            message="MCP server responded with 1 tool.",
            tools=[McpToolSummary(name="conversations_list")],
        )

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.read().decode()
        return httpx.Response(
            200,
            json={
                "id": "gen-hermes-auto",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Hermes auto-attached"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 20, "completion_tokens": 3, "total_tokens": 23},
            },
        )

    monkeypatch.setattr("app.routes.chat.check_mcp_server", fake_mcp_health)
    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: _gateway(transport=httpx.MockTransport(handler)),
    )

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "agent-hermes-auto",
            "agent_profile_id": "agent-hermes-auto",
            "messages": [{"role": "user", "content": "Check companion tools."}],
            "agent_enabled": True,
            "approval_tokens": _mcp_approval_tokens(),
        },
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    runtime_context = get_store().audit_events[-1].metadata["runtime_context"]
    assert runtime_context["agentic_companion"] == "hermes"
    assert runtime_context["tool_config_ids"] == ["tool-hermes-agent-mcp"]
    assert runtime_context["mcp_tool_names"] == ["conversations_list"]
    assert "conversations_list" in json.loads(captured["body"])["messages"][0]["content"]


def test_knowledge_retrieval_still_informs_prompt_when_citations_are_disabled(monkeypatch) -> None:
    _activate_provider("provider-azure")
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.read().decode()
        return httpx.Response(
            200,
            json={
                "id": "gen-no-cites",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Risk-area answer"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 20, "completion_tokens": 5, "total_tokens": 25},
            },
        )

    fake = _gateway(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "What are the processor obligations?"}],
            "knowledge_config_ids": ["knowledge-box-matters"],
            "citations_enabled": False,
        },
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    assert response.json()["citations"] == []

    sent = json.loads(captured["body"])
    system_message = sent["messages"][0]["content"]
    assert "Retrieved knowledge excerpts:" in system_message
    assert "Complaint response outline: preserve objections" in system_message

    runtime_context = get_store().audit_events[-1].metadata["runtime_context"]
    assert runtime_context["citations_enabled"] is False
    assert runtime_context["citations"] == []
    assert (
        runtime_context["knowledge_hit_refs"][0]["source_name"] == "Complaint response outline.docx"
    )


def test_uploaded_attachment_ids_feed_runtime_prompt_citations_and_audit(monkeypatch) -> None:
    _activate_provider("provider-azure")
    payload = b"Notice period: 30 days\nGoverning law: Missouri"
    upload = client.post(
        "/api/chat/attachments",
        files={"file": ("notice.txt", payload, "text/plain")},
        headers=headers("user-admin"),
    )
    assert upload.status_code == 200
    attachment = upload.json()
    assert attachment["id"].startswith("upload-")
    assert attachment["source_uri"] == f"upload://{attachment['id']}"
    assert attachment["size_bytes"] == len(payload)
    assert "Notice period: 30 days" in attachment["text_preview"]

    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.read().decode()
        return httpx.Response(
            200,
            json={
                "id": "gen-upload",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Attachment-aware answer"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 20, "completion_tokens": 5, "total_tokens": 25},
            },
        )

    fake = _gateway(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "Summarize the notice."}],
            "attachment_ids": [attachment["id"]],
            "citations_enabled": True,
        },
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["citations"] == [
        {
            "id": f"cite-{attachment['id']}",
            "source_name": "notice.txt",
            "source_type": "upload",
            "source_uri": f"upload://{attachment['id']}",
            "snippet": f"Uploaded Text file ({len(payload)} B) available to this chat turn.",
            "page_start": None,
            "page_end": None,
            "locator": None,
            "chunk_id": None,
            "k_index": None,
        }
    ]

    sent = json.loads(captured["body"])
    system_message = sent["messages"][0]["content"]
    assert "User attachments: notice.txt" in system_message
    assert "Notice period: 30 days Governing law: Missouri" in system_message

    latest = get_store().audit_events[-1]
    runtime_context = latest.metadata["runtime_context"]
    assert runtime_context["attachment_ids"] == [attachment["id"]]
    assert runtime_context["attachments"][0]["source_uri"] == f"upload://{attachment['id']}"
    assert "attachment_previews" not in runtime_context


def test_uploaded_docx_attachment_extracts_text_for_runtime_prompt(monkeypatch) -> None:
    _activate_provider("provider-azure")
    payload = _docx_bytes(
        [
            "SpaceX IPO scenario matrix",
            "Base case revenue grows through Starlink and launch services.",
        ]
    )
    upload = client.post(
        "/api/chat/attachments",
        files={
            "file": (
                "spacex-scenario-matrix.docx",
                payload,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        },
        headers=headers("user-admin"),
    )
    assert upload.status_code == 200
    attachment = upload.json()
    assert attachment["kind"] == "Word"
    assert "SpaceX IPO scenario matrix" in attachment["text_preview"]

    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.read().decode()
        return httpx.Response(
            200,
            json={
                "id": "gen-upload-docx",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "DOCX-aware answer"},
                        "finish_reason": "stop",
                    }
                ],
            },
        )

    fake = _gateway(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "Tell me about this doc."}],
            "attachment_ids": [attachment["id"]],
        },
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    sent = json.loads(captured["body"])
    system_message = sent["messages"][0]["content"]
    assert "User attachments: spacex-scenario-matrix.docx" in system_message
    assert "Attachment text previews:" in system_message
    assert "Base case revenue grows through Starlink and launch services." in system_message


def test_uploaded_attachment_ids_are_owner_scoped() -> None:
    upload = client.post(
        "/api/chat/attachments",
        files={"file": ("private.txt", b"Private matter notes", "text/plain")},
        headers=headers("user-admin"),
    )
    assert upload.status_code == 200
    attachment_id = upload.json()["id"]

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "Use this file."}],
            "attachment_ids": [attachment_id],
        },
        headers=headers("user-casey"),
    )
    assert response.status_code == 404
    assert "Unknown or inaccessible attachment" in response.json()["detail"]


def test_runtime_context_rejects_unavailable_knowledge_and_unapproved_tool_use() -> None:
    store = get_store()
    store.models["agent-required-model"] = ModelConfig(
        id="agent-required-model",
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="Agent Required",
        upstream_model_id="openai/gpt-4o-mini",
        tool_config_ids=["tool-hermes-example"],
        group_ids=["group-litigation"],
    )
    store.users["user-casey"].group_ids = ["group-corporate"]
    forbidden_knowledge = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "Use the matter folder."}],
            "knowledge_config_ids": ["knowledge-box-matters"],
        },
        headers=headers("user-casey"),
    )
    assert forbidden_knowledge.status_code == 403
    assert "Knowledge access is restricted" in forbidden_knowledge.json()["detail"]

    missing_agent_workflow = client.post(
        "/api/chat/complete",
        json={
            "model": "agent-required-model",
            "messages": [{"role": "user", "content": "Send the update."}],
            "tool_config_ids": ["tool-hermes-example"],
            "agent_enabled": False,
        },
        headers=headers("user-admin"),
    )
    assert missing_agent_workflow.status_code == 403
    assert "requires an agent approval workflow" in missing_agent_workflow.json()["detail"]


def test_unconfigured_provider_returns_503_with_route_status() -> None:
    response = client.post(
        "/api/chat/complete",
        json={"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "hi"}]},
        headers=headers(),
    )

    assert response.status_code == 503
    detail = response.json()["detail"]
    assert "Azure OpenAI is not configured for live completions" in detail
    assert "Provider is disabled or not connected." in detail

    # Audit was still recorded, and never carries the real key.
    latest = get_store().audit_events[-1]
    assert latest.action == "chat.completion"
    assert latest.metadata["provider_id"] == "provider-azure"
    assert latest.metadata["provider"] == "Azure OpenAI"
    assert latest.metadata["provider_configured"] is False
    assert latest.metadata["provider_status"] == "Provider is disabled or not connected."
    assert latest.metadata["provider_secret"] == "[redacted]"


def test_tenant_credential_health_is_scoped_while_platform_disable_is_preserved() -> None:
    store = get_store()
    provider = store.providers["provider-openrouter"]
    provider.connected = False
    model = ModelConfig(
        id="scoped-openrouter-health-model",
        provider_id=provider.id,
        provider_name=provider.name,
        name="Scoped OpenRouter health model",
        upstream_model_id="openai/gpt-4o-mini",
        platform_enabled=True,
        group_ids=[],
    )
    key = store.create_provider_key(
        key_id="key-scoped-openrouter-health",
        provider=provider,
        name="Scoped health key",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value="scoped-health-test-secret",
        tenant_id="tenant-example",
    )

    tenant_route = resolve_model_route(store, model, tenant_id="tenant-example")
    platform_route = resolve_model_route(store, model, tenant_id=None)

    assert tenant_route.configured is True
    assert tenant_route.credential_key_id == key.id
    assert tenant_route.credential_tenant_id == "tenant-example"
    assert platform_route.configured is False
    assert platform_route.credential_key_id is None
    assert platform_route.secret_value is None
    assert platform_route.status_message == "Provider is disabled or not connected."


def test_unconfigured_provider_streaming_returns_503_before_streaming() -> None:
    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
        },
        headers=headers(),
    )

    assert response.status_code == 503
    assert "Azure OpenAI is not configured for live completions" in response.json()["detail"]


def test_upstream_network_error_returns_503(monkeypatch) -> None:
    _activate_provider("provider-azure")

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("network blocked in test")

    fake = _gateway(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "hi"}]},
        headers=headers(),
    )

    assert response.status_code == 503
    assert "Azure OpenAI did not return a completion" in response.json()["detail"]


def test_upstream_http_error_returns_503(monkeypatch) -> None:
    _activate_provider("provider-azure")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "upstream boom"})

    fake = _gateway(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "hi"}]},
        headers=headers(),
    )

    assert response.status_code == 503
    assert "Azure OpenAI did not return a completion" in response.json()["detail"]


def test_upstream_auth_error_marks_provider_key_invalid(monkeypatch) -> None:
    _activate_provider("provider-openrouter")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "invalid key"})

    fake = _gateway(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-openai-gpt-5-5",
            "messages": [{"role": "user", "content": "hi"}],
        },
        headers=headers("user-owner"),
    )

    assert response.status_code == 503
    detail = response.json()["detail"]
    assert "OpenRouter rejected its provider key with HTTP 401" in detail
    assert "model service connection needs attention" in detail
    assert "platform owner" not in detail.lower()
    store = get_store()
    assert store.providers["provider-openrouter"].connected is False
    assert store.providers["provider-openrouter"].status_message == detail
    assert store.provider_key_secret_for_provider("provider-openrouter") is None
    assert [
        key.status
        for key in store.provider_keys.values()
        if key.provider_id == "provider-openrouter"
    ] == ["Inactive"]


def test_tenant_auth_error_inactivates_only_exact_credential_scope(monkeypatch) -> None:
    store = get_store()
    provider = store.providers["provider-openrouter"]
    provider.connected = True
    provider.status_message = "Platform credential ready."
    provider.last_sync = "Platform sync preserved"
    model = ModelConfig(
        id="tenant-auth-scope-model",
        provider_id=provider.id,
        provider_name=provider.name,
        name="Tenant auth scope model",
        upstream_model_id="openai/gpt-4o-mini",
        platform_enabled=True,
        group_ids=["group-litigation"],
    )
    store.models[model.id] = model
    platform_key = store.create_provider_key(
        key_id="key-openrouter-platform-scope-test",
        provider=provider,
        name="Platform scope test key",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value="platform-scope-test-secret",
    )
    tenant_key = store.create_provider_key(
        key_id="key-openrouter-tenant-scope-test",
        provider=provider,
        name="Tenant scope test key",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value="tenant-scope-test-secret",
        tenant_id="tenant-example",
    )

    tenant_route = resolve_model_route(store, model, tenant_id="tenant-example")
    assert tenant_route.credential_key_id == tenant_key.id
    assert tenant_route.credential_tenant_id == "tenant-example"

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer tenant-scope-test-secret"
        return httpx.Response(401, json={"error": "invalid tenant key"})

    fake = _gateway(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": model.id,
            "messages": [{"role": "user", "content": "hi"}],
        },
        headers=headers("user-admin"),
    )

    assert response.status_code == 503
    assert provider.connected is True
    assert provider.status_message == "Platform credential ready."
    assert provider.last_sync == "Platform sync preserved"
    assert store.provider_keys[tenant_key.id].status == "Inactive"
    assert store.provider_keys[platform_key.id].status == "Active"
    assert (
        store.provider_key_secret_for_provider(
            provider.id,
            tenant_id="tenant-example",
        )
        is None
    )

    # A different tenant with no override still resolves the healthy platform
    # credential; explicitly disabling that platform scope remains authoritative.
    fallback_route = resolve_model_route(store, model, tenant_id="tenant-other")
    assert fallback_route.configured is True
    assert fallback_route.credential_key_id == platform_key.id
    assert fallback_route.credential_tenant_id is None

    provider.connected = False
    disabled_fallback = resolve_model_route(store, model, tenant_id="tenant-other")
    assert disabled_fallback.configured is False
    assert disabled_fallback.credential_key_id is None
    assert disabled_fallback.credential_tenant_id is None
    assert disabled_fallback.secret_value is None
    assert disabled_fallback.status_message == "Provider is disabled or not connected."


def test_upstream_forbidden_model_does_not_invalidate_provider_key(monkeypatch) -> None:
    _activate_provider("provider-openrouter")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": "model is forbidden"})

    fake = _gateway(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-openai-gpt-5-5",
            "messages": [{"role": "user", "content": "hi"}],
        },
        headers=headers("user-owner"),
    )

    assert response.status_code == 503
    assert "OpenRouter returned HTTP 403" in response.json()["detail"]
    store = get_store()
    assert store.providers["provider-openrouter"].connected is True
    assert store.provider_key_secret_for_provider("provider-openrouter") is not None
    assert [
        key.status
        for key in store.provider_keys.values()
        if key.provider_id == "provider-openrouter"
    ] == ["Active"]


def test_openrouter_route_uses_synced_upstream_model_id(monkeypatch) -> None:
    _activate_provider("provider-openrouter")
    store = get_store()
    store.models["openrouter-anthropic-claude-test"] = ModelConfig(
        id="openrouter-anthropic-claude-test",
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="Anthropic: Claude Test",
        upstream_model_id="anthropic/claude-3.5-sonnet",
        group_ids=["group-litigation"],
    )
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.read().decode()
        return httpx.Response(
            200,
            json={
                "id": "gen-openrouter",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "OpenRouter answer"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 8, "completion_tokens": 3, "total_tokens": 11},
            },
        )

    fake = _gateway(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-anthropic-claude-test",
            "messages": [{"role": "user", "content": "hi"}],
        },
        headers=headers(),
    )

    assert response.status_code == 200
    sent = json.loads(captured["body"])
    assert sent["model"] == "anthropic/claude-3.5-sonnet"
    assert sent["max_tokens"] == 8192


def test_platform_owner_cannot_chat_with_disabled_synced_provider_model(monkeypatch) -> None:
    _activate_provider("provider-openrouter")
    store = get_store()
    store.models["openrouter-disabled-owner-test"] = ModelConfig(
        id="openrouter-disabled-owner-test",
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="OpenRouter: Disabled Owner Test",
        upstream_model_id="meta-llama/llama-3.3-70b-instruct",
        platform_enabled=False,
        group_ids=[],
    )

    fake = _gateway(transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={})))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-disabled-owner-test",
            "messages": [{"role": "user", "content": "hi"}],
        },
        headers=headers("user-owner"),
    )

    assert response.status_code == 403


def test_non_owner_cannot_test_disabled_synced_provider_model(monkeypatch) -> None:
    _activate_provider("provider-openrouter")
    store = get_store()
    store.models["openrouter-disabled-owner-test"] = ModelConfig(
        id="openrouter-disabled-owner-test",
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="OpenRouter: Disabled Owner Test",
        upstream_model_id="meta-llama/llama-3.3-70b-instruct",
        platform_enabled=False,
        group_ids=["group-litigation"],
    )
    fake = _gateway(transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={})))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-disabled-owner-test",
            "messages": [{"role": "user", "content": "hi"}],
        },
        headers=headers("user-admin"),
    )

    assert response.status_code == 403


def test_chat_completion_uses_long_budget_and_continues_after_length_stop(monkeypatch) -> None:
    _activate_provider("provider-openrouter")
    store = get_store()
    store.models["openrouter-long-form"] = ModelConfig(
        id="openrouter-long-form",
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="OpenRouter Long Form",
        upstream_model_id="openai/gpt-5.5",
        context_window=128000,
        group_ids=["group-litigation"],
    )
    captured_bodies: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.read().decode())
        captured_bodies.append(body)
        first_call = len(captured_bodies) == 1
        return httpx.Response(
            200,
            json={
                "id": f"gen-openrouter-{len(captured_bodies)}",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": "Section 1 begins."
                            if first_call
                            else "Section 2 continues.",
                        },
                        "finish_reason": "length" if first_call else "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 100 if first_call else 80,
                    "completion_tokens": 12000 if first_call else 300,
                    "total_tokens": 12100 if first_call else 380,
                },
            },
        )

    fake = _gateway(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-long-form",
            "messages": [{"role": "user", "content": "Explain legal AI governance."}],
        },
        headers=headers(),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["choices"][0]["message"]["content"] == "Section 1 begins.\n\nSection 2 continues."
    assert body["choices"][0]["finish_reason"] == "stop"
    assert body["usage"]["completion_tokens"] == 12300
    assert len(captured_bodies) == 2
    assert captured_bodies[0]["model"] == "openai/gpt-5.5"
    assert captured_bodies[0]["max_tokens"] == 16000
    assert captured_bodies[1]["messages"][-2] == {
        "role": "assistant",
        "content": "Section 1 begins.",
    }
    assert captured_bodies[1]["messages"][-1]["content"].startswith("Continue exactly where")


def test_chat_completion_revises_outline_that_fails_long_form_request(monkeypatch) -> None:
    _activate_provider("provider-openrouter")
    store = get_store()
    store.models["openrouter-validator"] = ModelConfig(
        id="openrouter-validator",
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="OpenRouter Validator",
        upstream_model_id="openai/gpt-5.5",
        context_window=128000,
        group_ids=["group-litigation"],
    )
    captured_bodies: list[dict[str, object]] = []
    full_paper = " ".join(["Completed drafted paragraph with analysis and support."] * 120)

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.read().decode())
        captured_bodies.append(body)
        first_call = len(captured_bodies) == 1
        return httpx.Response(
            200,
            json={
                "id": f"gen-validator-{len(captured_bodies)}",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": "Outline\n1. Introduction\n2. Background\n3. Conclusion"
                            if first_call
                            else full_paper,
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 120,
                    "completion_tokens": 20 if first_call else 850,
                    "total_tokens": 140 if first_call else 970,
                },
            },
        )

    fake = _gateway(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-validator",
            "messages": [{"role": "user", "content": "Write a 2 page paper on Artemis II."}],
        },
        headers=headers(),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["choices"][0]["message"]["content"] == full_paper
    assert len(captured_bodies) == 2
    assert (
        "Hermes-light content validator found the draft incomplete"
        in captured_bodies[1]["messages"][-1]["content"]
    )
    assert "actual complete deliverable" in captured_bodies[1]["messages"][-1]["content"]


def test_chat_completion_never_injects_curated_image_content(monkeypatch) -> None:
    _activate_provider("provider-openrouter")
    store = get_store()
    store.models["openrouter-images"] = ModelConfig(
        id="openrouter-images",
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="OpenRouter Images",
        upstream_model_id="openai/gpt-5.5",
        context_window=128000,
        group_ids=["group-litigation"],
    )
    captured_bodies: list[dict[str, object]] = []
    prose = " ".join(
        ["Artemis II analysis paragraph with sufficient detail and source-aware mission context."]
        * 80
    )

    def handler(request: httpx.Request) -> httpx.Response:
        captured_bodies.append(json.loads(request.read().decode()))
        return httpx.Response(
            200,
            json={
                "id": f"gen-images-{len(captured_bodies)}",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": prose},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 80, "completion_tokens": 500, "total_tokens": 580},
            },
        )

    fake = _gateway(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-images",
            "messages": [
                {
                    "role": "user",
                    "content": "Write a 1 page paper on Artemis II and add images of the astronauts.",
                }
            ],
        },
        headers=headers(),
    )

    assert response.status_code == 200
    content = response.json()["choices"][0]["message"]["content"]
    # The backend never appends hardcoded image markdown: the answer is exactly
    # what the model returned (possibly after honest revision rounds).
    assert "Transferable Mission Images" not in content
    assert "Special:FilePath" not in content
    assert content == prose


def test_client_stream_parses_openrouter_sse() -> None:
    sse = (
        ": OPENROUTER PROCESSING\n\n"
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n'
        "data: [DONE]\n\n"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=sse.encode(), headers={"content-type": "text/event-stream"}
        )

    streamer = _client("sk-fake-not-real", transport=httpx.MockTransport(handler))
    deltas = list(
        streamer.stream(model="openai/gpt-4o-mini", messages=[{"role": "user", "content": "hi"}])
    )
    assert deltas == ["Hello", " world"]


def test_streaming_route_emits_sse_deltas_then_done(monkeypatch) -> None:
    _activate_provider("provider-azure")

    class FakeStreamingClient:
        def stream(
            self,
            *,
            route: object,
            messages: list[dict[str, str]],
            max_tokens: int | None = None,
            usage_sink: dict[str, object] | None = None,
        ) -> Iterator[str]:
            yield "Hello"
            yield " world"

    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: FakeStreamingClient())

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
        },
        headers=headers(),
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    body = response.text
    assert 'data: {"delta": "Hello"}' in body
    assert 'data: {"delta": " world"}' in body
    assert '"usage": null' in body
    assert "data: [DONE]" in body


def test_streaming_requests_and_reports_provider_usage(monkeypatch) -> None:
    _activate_local_provider()
    captured: dict[str, object] = {}
    sse = (
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n'
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}\n\n'
        "data: [DONE]\n\n"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.read().decode())
        return httpx.Response(
            200, content=sse.encode(), headers={"content-type": "text/event-stream"}
        )

    fake = _gateway(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "local-test-legal-v1",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
        },
        headers=headers(),
    )

    assert response.status_code == 200
    body = response.text
    assert 'data: {"delta": "Hello"}' in body
    assert '"usage": {"prompt_tokens": 12, "completion_tokens": 5, "total_tokens": 17}' in body
    sent = captured["body"]
    assert sent["stream_options"] == {"include_usage": True}


def test_unknown_model_returns_404() -> None:
    response = client.post(
        "/api/chat/complete",
        json={"model": "does-not-exist", "messages": [{"role": "user", "content": "hi"}]},
        headers=headers(),
    )
    assert response.status_code == 404


@pytest.mark.parametrize("path", ["/api/chat/complete", "/v1/chat/completions", "/v1/responses"])
def test_unknown_openrouter_alias_never_substitutes_deployment_default(
    path: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    model_id = "tenant-selected-alias-without-upstream"
    store.models[model_id] = ModelConfig(
        id=model_id,
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="Tenant selected alias without upstream",
        upstream_model_id=None,
        platform_enabled=True,
        group_ids=[],
    )

    def unexpected_credential_read(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("invalid selected model must fail before credential resolution")

    def unexpected_gateway_factory() -> None:
        raise AssertionError("invalid selected model must fail before provider I/O")

    monkeypatch.setattr(store, "provider_key_secret_for_provider", unexpected_credential_read)
    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        unexpected_gateway_factory,
    )
    if path.startswith("/v1/"):
        store.platform_settings.downstream_api_enabled = True
        next(iter(store.groups.values())).permissions["api_access"] = True

    response = client.post(
        path,
        json={"model": model_id, "messages": [{"role": "user", "content": "hi"}]},
        headers=headers("user-owner"),
    )

    assert response.status_code == 503
    assert response.json()["detail"] == (
        f"Selected model '{model_id}' has no explicit OpenRouter upstream model id."
    )
    assert get_settings().openrouter_default_model not in response.text


def test_local_provider_uses_local_upstream_model_without_openrouter_fallback(monkeypatch) -> None:
    _activate_local_provider()
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = request.read().decode()
        return httpx.Response(
            200,
            json={
                "id": "gen-local",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Local legal answer"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 8, "completion_tokens": 3, "total_tokens": 11},
            },
        )

    fake = _gateway(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={"model": "local-test-legal-v1", "messages": [{"role": "user", "content": "hi"}]},
        headers=headers(),
    )

    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "Local legal answer"

    sent = json.loads(captured["body"])
    assert sent["model"] == "local-test-legal-v1"
    assert captured["url"] == "https://local.test/v1/chat/completions"


def _reasoning_completion_handler(captured: dict[str, object]):
    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.read().decode()
        return httpx.Response(
            200,
            json={
                "id": "gen-reasoning",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Considered answer"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14},
            },
        )

    return handler


def test_reasoning_effort_maps_to_openrouter_reasoning_parameter(monkeypatch) -> None:
    _activate_provider("provider-openrouter")
    captured: dict[str, object] = {}
    fake = _gateway(transport=httpx.MockTransport(_reasoning_completion_handler(captured)))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-openai-gpt-5-5",
            "messages": [{"role": "user", "content": "Think hard about this."}],
            "reasoning_effort": "high",
        },
        headers=headers("user-owner"),
    )

    assert response.status_code == 200
    sent = json.loads(captured["body"])
    # OpenRouter takes the unified `reasoning` object, not `reasoning_effort`.
    assert sent["reasoning"] == {"effort": "high"}
    assert "reasoning_effort" not in sent
    # Smart keeps OpenRouter's default provider routing.
    assert "provider" not in sent


def test_minimal_reasoning_effort_is_the_fast_path_on_openrouter(monkeypatch) -> None:
    _activate_provider("provider-openrouter")
    captured: dict[str, object] = {}
    fake = _gateway(transport=httpx.MockTransport(_reasoning_completion_handler(captured)))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-openai-gpt-5-5",
            "messages": [{"role": "user", "content": "Quick answer please."}],
            "reasoning_effort": "minimal",
        },
        headers=headers("user-owner"),
    )

    assert response.status_code == 200
    sent = json.loads(captured["body"])
    # Fast mode: smallest reasoning spend plus throughput-priority routing.
    assert sent["reasoning"] == {"effort": "minimal"}
    assert sent["provider"] == {"sort": "throughput"}


def test_minimal_reasoning_effort_degrades_to_low_for_grok_on_openrouter(monkeypatch) -> None:
    _activate_provider("provider-openrouter")
    # Reuse the seeded OpenRouter route with a Grok upstream: xAI documents
    # only low/high effort, so fast mode must not forward "minimal".
    get_store().models["openrouter-openai-gpt-5-5"].upstream_model_id = "x-ai/grok-4.5"
    captured: dict[str, object] = {}
    fake = _gateway(transport=httpx.MockTransport(_reasoning_completion_handler(captured)))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-openai-gpt-5-5",
            "messages": [{"role": "user", "content": "Quick answer please."}],
            "reasoning_effort": "minimal",
        },
        headers=headers("user-owner"),
    )

    assert response.status_code == 200
    sent = json.loads(captured["body"])
    assert sent["reasoning"] == {"effort": "low"}
    # Fast mode still prefers throughput-priority provider routing.
    assert sent["provider"] == {"sort": "throughput"}


def test_minimal_reasoning_effort_degrades_to_low_off_gpt5(monkeypatch) -> None:
    _activate_provider("provider-openai")
    get_store().models["o3-mini"].platform_enabled = True
    captured: dict[str, object] = {}
    fake = _gateway(transport=httpx.MockTransport(_reasoning_completion_handler(captured)))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "o3-mini",
            "messages": [{"role": "user", "content": "Quick answer please."}],
            "reasoning_effort": "minimal",
        },
        headers=headers("user-owner"),
    )

    assert response.status_code == 200
    sent = json.loads(captured["body"])
    # o-series has no "minimal" on the direct OpenAI dialect.
    assert sent["reasoning_effort"] == "low"


def test_reasoning_effort_is_dropped_for_non_reasoning_models(monkeypatch) -> None:
    _activate_provider("provider-openrouter")
    captured: dict[str, object] = {}
    fake = _gateway(transport=httpx.MockTransport(_reasoning_completion_handler(captured)))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-openai-gpt-4o-mini",
            "messages": [{"role": "user", "content": "Quick answer please."}],
            "reasoning_effort": "high",
        },
        headers=headers("user-owner"),
    )

    assert response.status_code == 200
    sent = json.loads(captured["body"])
    # gpt-4o-mini has no reasoning control; the parameter must never reach it.
    assert "reasoning" not in sent
    assert "reasoning_effort" not in sent


def test_reasoning_effort_uses_openai_dialect_for_openai_provider(monkeypatch) -> None:
    _activate_provider("provider-openai")
    get_store().models["o3-mini"].platform_enabled = True
    captured: dict[str, object] = {}
    fake = _gateway(transport=httpx.MockTransport(_reasoning_completion_handler(captured)))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "o3-mini",
            "messages": [{"role": "user", "content": "Short answer please."}],
            "reasoning_effort": "low",
        },
        headers=headers("user-owner"),
    )

    assert response.status_code == 200
    sent = json.loads(captured["body"])
    assert sent["reasoning_effort"] == "low"
    assert "reasoning" not in sent


def test_reasoning_effort_rejects_unknown_values() -> None:
    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-openai-gpt-5-5",
            "messages": [{"role": "user", "content": "hi"}],
            "reasoning_effort": "maximum",
        },
        headers=headers("user-owner"),
    )
    assert response.status_code == 422


def test_supports_reasoning_effort_model_families() -> None:
    assert supports_reasoning_effort("openai/gpt-5.5")
    assert supports_reasoning_effort("o3-mini")
    assert supports_reasoning_effort("openai/o4-mini")
    assert supports_reasoning_effort("anthropic/claude-sonnet-4.6")
    assert supports_reasoning_effort("claude-opus-4-8")
    assert supports_reasoning_effort("claude-sonnet-5")
    # gpt-oss accepts reasoning_effort on OpenAI-compatible hosts (e.g. Groq).
    assert supports_reasoning_effort("openai/gpt-oss-120b")
    # Grok versions with effort control per OpenRouter supported_parameters.
    assert supports_reasoning_effort("x-ai/grok-4.5")
    assert supports_reasoning_effort("x-ai/grok-4.3")
    assert supports_reasoning_effort("x-ai/grok-4.20-multi-agent")
    assert not supports_reasoning_effort("gpt-4o")
    assert not supports_reasoning_effort("openai/gpt-4o-mini")
    assert not supports_reasoning_effort("gpt-4.1")
    assert not supports_reasoning_effort("anthropic/claude-3.5-sonnet")
    assert not supports_reasoning_effort("claude-haiku-4.5")
    # Grok 4.20 base and Grok Build list reasoning but not reasoning_effort.
    assert not supports_reasoning_effort("x-ai/grok-4.20")
    assert not supports_reasoning_effort("x-ai/grok-build-0.1")
    assert not supports_reasoning_effort(None)
    assert not supports_reasoning_effort("")


def test_fast_mode_style_note_applies_only_to_chat_surface(monkeypatch) -> None:
    _activate_provider("provider-openrouter")
    captured: dict[str, object] = {}
    fake = _gateway(transport=httpx.MockTransport(_reasoning_completion_handler(captured)))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: fake)

    # Chat surface at minimal effort gets the concise-answer style note.
    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-openai-gpt-5-5",
            "messages": [{"role": "user", "content": "Quick answer please."}],
            "reasoning_effort": "minimal",
        },
        headers=headers("user-owner"),
    )
    assert response.status_code == 200
    sent = json.loads(captured["body"])
    assert sent["messages"][0]["role"] == "system"
    assert "Fast mode" in sent["messages"][0]["content"]

    # Smart on the chat surface never gets the note.
    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-openai-gpt-5-5",
            "messages": [{"role": "user", "content": "Think hard about this."}],
            "reasoning_effort": "high",
        },
        headers=headers("user-owner"),
    )
    assert response.status_code == 200
    sent = json.loads(captured["body"])
    assert "Fast mode" not in sent["messages"][0]["content"]

    # Gateway (/v1) clients keep their prompts exactly as sent — even at
    # minimal effort the style note must never be injected. API access is
    # governed by the platform-owner ceiling, so enable that policy first.
    get_store().platform_settings.downstream_api_enabled = True
    next(iter(get_store().groups.values())).permissions["api_access"] = True
    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "openrouter-openai-gpt-5-5",
            "messages": [{"role": "user", "content": "Quick answer please."}],
            "reasoning_effort": "minimal",
        },
        headers=headers("user-owner"),
    )
    assert response.status_code == 200
    sent = json.loads(captured["body"])
    system_texts = [m["content"] for m in sent["messages"] if m.get("role") == "system"]
    assert all("Fast mode" not in text for text in system_texts)
    # The speed provisioning itself still applies on the gateway path.
    assert sent["reasoning"] == {"effort": "minimal"}
