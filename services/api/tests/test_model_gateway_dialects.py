"""Provider-dialect parity tests.

Every provider dialect must forward the capabilities a model actually
supports: tools, sampling options, streaming, and reasoning effort. These
tests pin the Anthropic Messages translation (the dialect that historically
dropped capabilities) and the capability-metadata gating captured at model
sync. httpx.MockTransport keeps everything offline.
"""

from __future__ import annotations

import json

import httpx

import pytest

from app.core.model_discovery import ModelDiscoveryError, discover_provider_models
from app.core.model_gateway import (
    ModelGatewayClient,
    ModelGatewayError,
    ModelGatewayRoute,
    _route_status,
    default_provider_base_url,
    provider_dialect,
    supports_image_input,
    supports_reasoning_effort,
)
from app.models.schemas import Provider


def _anthropic_route(supported_parameters: frozenset[str] = frozenset()) -> ModelGatewayRoute:
    return ModelGatewayRoute(
        provider_id="provider-anthropic-test",
        provider_name="Anthropic Test",
        provider_kind="anthropic",
        auth_type="api-key",
        upstream_model="claude-opus-4-8",
        base_url="https://api.anthropic.com",
        configured=True,
        status_message="ready",
        secret_value="sk-ant-test",
        auth_metadata={},
        supported_parameters=supported_parameters,
    )


def _anthropic_response_handler(captured: dict[str, object], body: dict[str, object]):
    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["headers"] = dict(request.headers)
        captured["body"] = json.loads(request.read().decode())
        return httpx.Response(200, json=body)

    return handler


def test_anthropic_dialect_forwards_tools_options_and_agent_messages() -> None:
    captured: dict[str, object] = {}
    upstream_body = {
        "id": "msg-test",
        "content": [
            {"type": "text", "text": "Checking the weather."},
            {"type": "tool_use", "id": "toolu-1", "name": "get_weather", "input": {"city": "Reno"}},
        ],
        "stop_reason": "tool_use",
        "usage": {"input_tokens": 12, "output_tokens": 5},
    }
    gateway = ModelGatewayClient(transport=httpx.MockTransport(_anthropic_response_handler(captured, upstream_body)))

    result = gateway.complete(
        route=_anthropic_route(),
        messages=[
            {"role": "system", "content": "Be terse."},
            {"role": "user", "content": "Weather in Reno?"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "toolu-0",
                        "type": "function",
                        "function": {"name": "get_weather", "arguments": '{"city": "Reno"}'},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "toolu-0", "content": "72F sunny"},
        ],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Look up weather",
                    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
                },
            }
        ],
        tool_choice="auto",
        options={
            "temperature": 0.4,
            "top_p": 0.9,
            "stop": ["END"],
            "seed": 7,
            "response_format": {"type": "json_object"},
        },
    )

    sent = captured["body"]
    assert captured["path"] == "/v1/messages"
    assert captured["headers"]["x-api-key"] == "sk-ant-test"
    # Tools arrive in the Anthropic shape with the schema preserved.
    assert sent["tools"] == [
        {
            "name": "get_weather",
            "description": "Look up weather",
            "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}},
        }
    ]
    assert sent["tool_choice"] == {"type": "auto"}
    # Sampling knobs Anthropic accepts are forwarded; ones it rejects are dropped.
    assert sent["temperature"] == 0.4
    assert sent["top_p"] == 0.9
    assert sent["stop_sequences"] == ["END"]
    assert "seed" not in sent
    assert "response_format" not in sent
    # The agent loop round-trips: assistant tool calls and tool results become blocks.
    assistant_turn = sent["messages"][1]
    assert assistant_turn["content"][0]["type"] == "tool_use"
    assert assistant_turn["content"][0]["input"] == {"city": "Reno"}
    tool_turn = sent["messages"][2]
    assert tool_turn["role"] == "user"
    assert tool_turn["content"][0] == {"type": "tool_result", "tool_use_id": "toolu-0", "content": "72F sunny"}

    # The response comes back in the OpenAI shape, tool calls included.
    message = result["choices"][0]["message"]
    assert message["content"] == "Checking the weather."
    assert message["tool_calls"][0]["function"]["name"] == "get_weather"
    assert json.loads(message["tool_calls"][0]["function"]["arguments"]) == {"city": "Reno"}
    assert result["choices"][0]["finish_reason"] == "tool_calls"
    assert result["usage"] == {"prompt_tokens": 12, "completion_tokens": 5, "total_tokens": 17}


def _anthropic_sse(events: list[dict[str, object]]) -> bytes:
    lines = []
    for event in events:
        lines.append(f"event: {event['type']}")
        lines.append(f"data: {json.dumps(event)}")
        lines.append("")
    return ("\n".join(lines) + "\n").encode()


def test_anthropic_streaming_translates_to_openai_chunks() -> None:
    events = [
        {"type": "message_start", "message": {"usage": {"input_tokens": 9}}},
        {"type": "ping"},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text"}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hel"}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "lo"}},
        {
            "type": "content_block_start",
            "index": 1,
            "content_block": {"type": "tool_use", "id": "toolu-9", "name": "lookup"},
        },
        {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": '{"q":'}},
        {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": '"x"}'}},
        {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 4}},
        {"type": "message_stop"},
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.read().decode())["stream"] is True
        return httpx.Response(200, content=_anthropic_sse(events))

    gateway = ModelGatewayClient(transport=httpx.MockTransport(handler))

    chunks = list(
        gateway.stream_events(
            route=_anthropic_route(),
            messages=[{"role": "user", "content": "hi"}],
            tools=[{"type": "function", "function": {"name": "lookup", "parameters": {"type": "object"}}}],
        )
    )
    text = "".join(
        (chunk["choices"][0]["delta"].get("content") or "")
        for chunk in chunks
        if chunk.get("choices")
    )
    assert text == "Hello"
    tool_deltas = [
        delta
        for chunk in chunks
        for delta in (chunk["choices"][0]["delta"].get("tool_calls") or [])
    ]
    assert tool_deltas[0]["id"] == "toolu-9"
    assert tool_deltas[0]["function"]["name"] == "lookup"
    assert "".join(delta["function"]["arguments"] for delta in tool_deltas) == '{"q":"x"}'
    final = chunks[-1]
    assert final["choices"][0]["finish_reason"] == "tool_calls"
    assert final["usage"] == {"prompt_tokens": 9, "completion_tokens": 4, "total_tokens": 13}

    # The plain-text stream() wrapper carries deltas, keepalives, and usage.
    usage_sink: dict[str, object] = {}
    def stream_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=_anthropic_sse(events))

    gateway = ModelGatewayClient(transport=httpx.MockTransport(stream_handler))
    pieces = list(
        gateway.stream(
            route=_anthropic_route(),
            messages=[{"role": "user", "content": "hi"}],
            usage_sink=usage_sink,
        )
    )
    assert "".join(pieces) == "Hello"
    assert usage_sink["completion_tokens"] == 4
    assert usage_sink["finish_reason"] == "tool_calls"


def test_supported_parameters_metadata_overrides_family_heuristics() -> None:
    # Catalog data wins in both directions when present.
    assert supports_reasoning_effort("vendor/never-heard-of-it", frozenset({"reasoning_effort", "tools"}))
    assert not supports_reasoning_effort("openai/gpt-5.5", frozenset({"temperature", "tools"}))
    # Without catalog data, the family heuristics still apply.
    assert supports_reasoning_effort("openai/gpt-5.5", frozenset())
    assert not supports_reasoning_effort("vendor/never-heard-of-it", frozenset())


def _catalog_provider(kind: str, **auth_metadata: str) -> Provider:
    return Provider(
        id=f"provider-{kind}-cat",
        name=f"{kind.title()} Catalog",
        kind=kind,
        region="US",
        base_url=None,
        auth_type="bearer",
        auth_metadata=dict(auth_metadata),
        connected=True,
    )


def test_openrouter_discovery_captures_capability_metadata() -> None:
    catalog = {
        "data": [
            {
                "id": "vendor/full-caps",
                "name": "Vendor Full Caps",
                "context_length": 200000,
                "supported_parameters": ["Reasoning_Effort", "tools", "temperature"],
                "architecture": {
                    "input_modalities": ["text", "image", "audio"],
                    "output_modalities": ["text"],
                },
            },
            {"id": "vendor/no-caps", "name": "Vendor No Caps", "context_length": 8000},
        ]
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params.get("zdr") == "true"
        return httpx.Response(200, json=catalog)

    models, source = discover_provider_models(
        _catalog_provider("openrouter"),
        "sk-or-test",
        transport=httpx.MockTransport(handler),
    )
    assert source == "openrouter:/models?zdr=true"
    full = next(model for model in models if model.id == "vendor/full-caps")
    assert full.capabilities is not None
    assert full.capabilities.supported_parameters == ["reasoning_effort", "tools", "temperature"]
    assert full.capabilities.input_modalities == ["text", "image", "audio"]
    bare = next(model for model in models if model.id == "vendor/no-caps")
    assert bare.capabilities is None


def test_anthropic_discovery_lists_catalog_models() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/models"
        assert request.headers["x-api-key"] == "sk-ant-test"
        assert request.headers["anthropic-version"]
        return httpx.Response(
            200,
            json={
                "data": [
                    {"id": "claude-opus-4-8", "display_name": "Claude Opus 4.8", "type": "model"},
                    {"id": "claude-sonnet-4-6", "display_name": "Claude Sonnet 4.6", "type": "model"},
                ]
            },
        )

    models, source = discover_provider_models(
        _catalog_provider("anthropic"),
        "sk-ant-test",
        transport=httpx.MockTransport(handler),
    )
    assert source == "anthropic:/v1/models"
    assert [model.id for model in models] == ["claude-opus-4-8", "claude-sonnet-4-6"]
    assert models[0].name == "Claude Opus 4.8"


def _openai_shape_response() -> dict[str, object]:
    return {
        "id": "chatcmpl-test",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4},
    }


def _capture_handler(captured: dict[str, object]):
    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["params"] = dict(request.url.params)
        captured["headers"] = dict(request.headers)
        captured["body"] = json.loads(request.read().decode())
        return httpx.Response(200, json=_openai_shape_response())

    return handler


def test_azure_foundry_dialect_targets_inference_endpoint_with_api_key() -> None:
    """Azure AI Foundry: OpenAI payload with the model in the body, api-key
    header, and the api-version query the /models inference endpoint needs."""
    captured: dict[str, object] = {}
    gateway = ModelGatewayClient(transport=httpx.MockTransport(_capture_handler(captured)))
    route = ModelGatewayRoute(
        provider_id="provider-foundry-test",
        provider_name="Azure Foundry Test",
        provider_kind="azure-foundry",
        auth_type="api-key",
        upstream_model="Phi-4",
        base_url="https://myres.services.ai.azure.com/models",
        configured=True,
        status_message="ready",
        secret_value="az-foundry-secret",
        auth_metadata={"api_version": "2025-01-01-preview"},
        supported_parameters=frozenset(),
    )

    result = gateway.complete(route=route, messages=[{"role": "user", "content": "hi"}])

    assert str(captured["url"]).startswith("https://myres.services.ai.azure.com/models/chat/completions?")
    assert captured["params"]["api-version"] == "2025-01-01-preview"
    assert captured["headers"]["api-key"] == "az-foundry-secret"
    assert "authorization" not in captured["headers"]
    # Unlike azure-openai's per-deployment URLs, Foundry takes the model in the body.
    assert captured["body"]["model"] == "Phi-4"
    assert result["choices"][0]["message"]["content"] == "ok"


def test_azure_foundry_defaults_api_version_when_unset() -> None:
    captured: dict[str, object] = {}
    gateway = ModelGatewayClient(transport=httpx.MockTransport(_capture_handler(captured)))
    route = ModelGatewayRoute(
        provider_id="provider-foundry-test",
        provider_name="Azure Foundry Test",
        provider_kind="azure-foundry",
        auth_type="api-key",
        upstream_model="Phi-4",
        base_url="https://myres.services.ai.azure.com/models",
        configured=True,
        status_message="ready",
        secret_value="az-foundry-secret",
        auth_metadata={},
        supported_parameters=frozenset(),
    )

    gateway.complete(route=route, messages=[{"role": "user", "content": "hi"}])

    assert captured["params"]["api-version"] == "2024-05-01-preview"


def test_gcp_dialect_routes_through_gemini_openai_surface() -> None:
    """GCP rides Gemini's OpenAI-compatibility endpoint with a Bearer API key."""
    captured: dict[str, object] = {}
    gateway = ModelGatewayClient(transport=httpx.MockTransport(_capture_handler(captured)))
    route = ModelGatewayRoute(
        provider_id="provider-gcp-test",
        provider_name="GCP Test",
        provider_kind="gcp",
        auth_type="bearer",
        upstream_model="gemini-2.5-pro",
        base_url="https://generativelanguage.googleapis.com/v1beta/openai",
        configured=True,
        status_message="ready",
        secret_value="AIza-test-key",
        auth_metadata={},
        supported_parameters=frozenset(),
    )

    result = gateway.complete(
        route=route,
        messages=[{"role": "user", "content": "hi"}],
        options={"temperature": 0.2},
    )

    assert str(captured["url"]) == "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    assert captured["headers"]["authorization"] == "Bearer AIza-test-key"
    assert captured["body"]["model"] == "gemini-2.5-pro"
    assert captured["body"]["temperature"] == 0.2
    assert result["choices"][0]["message"]["content"] == "ok"


def test_gcp_discovery_lists_gemini_catalog() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1beta/openai/models"
        assert request.headers["authorization"] == "Bearer AIza-test-key"
        return httpx.Response(
            200,
            json={
                "data": [
                    {"id": "models/gemini-2.5-pro", "object": "model"},
                    {"id": "models/gemini-2.5-flash", "object": "model"},
                ]
            },
        )

    provider = Provider(
        id="provider-gcp-test",
        name="GCP Catalog",
        kind="gcp",
        region="US",
        base_url="https://generativelanguage.googleapis.com/v1beta/openai",
        auth_type="bearer",
        auth_metadata={},
        connected=True,
    )
    models, source = discover_provider_models(
        provider,
        "AIza-test-key",
        transport=httpx.MockTransport(handler),
    )
    assert source == "models"
    assert [model.id for model in models] == ["models/gemini-2.5-pro", "models/gemini-2.5-flash"]


def _openai_route(upstream_model: str) -> ModelGatewayRoute:
    return ModelGatewayRoute(
        provider_id="provider-openai-test",
        provider_name="OpenAI Test",
        provider_kind="openai",
        auth_type="api-key",
        upstream_model=upstream_model,
        base_url="https://api.openai.com/v1",
        configured=True,
        status_message="ready",
        secret_value="sk-openai-test",
        auth_metadata={"header_name": "Authorization"},
        supported_parameters=frozenset(),
    )


def test_openai_responses_only_models_route_to_responses_endpoint() -> None:
    """Pro-tier reasoning models 404 on /chat/completions; they must ride
    the Responses API with the translated payload shape."""
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["headers"] = dict(request.headers)
        captured["body"] = json.loads(request.read().decode())
        return httpx.Response(
            200,
            json={
                "id": "resp-test",
                "status": "completed",
                "output": [
                    {"type": "reasoning", "summary": []},
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "Hello there."}],
                    },
                ],
                "usage": {"input_tokens": 8, "output_tokens": 120, "total_tokens": 128},
            },
        )

    gateway = ModelGatewayClient(transport=httpx.MockTransport(handler))
    result = gateway.complete(
        route=_openai_route("gpt-5.5-pro"),
        messages=[
            {"role": "system", "content": "Be helpful."},
            {"role": "user", "content": "hi"},
        ],
        options={"temperature": 0.7, "reasoning_effort": "high"},
    )

    assert captured["url"] == "https://api.openai.com/v1/responses"
    assert captured["headers"]["authorization"] == "Bearer sk-openai-test"
    body = captured["body"]
    assert body["model"] == "gpt-5.5-pro"
    assert body["input"] == [
        {"role": "system", "content": "Be helpful."},
        {"role": "user", "content": "hi"},
    ]
    # Responses defaults to server-side storage; the gateway opts out so
    # provider-side data handling matches the chat-completions dialect.
    assert body["store"] is False
    assert body["reasoning"] == {"effort": "high"}
    # Reasoning-only models reject sampling knobs; they must not be forwarded.
    assert "temperature" not in body
    assert "messages" not in body

    assert result["choices"][0]["message"]["content"] == "Hello there."
    assert result["choices"][0]["finish_reason"] == "stop"
    assert result["usage"] == {"prompt_tokens": 8, "completion_tokens": 120, "total_tokens": 128}


def test_openai_non_responses_models_keep_chat_completions() -> None:
    captured: dict[str, object] = {}
    gateway = ModelGatewayClient(transport=httpx.MockTransport(_capture_handler(captured)))

    gateway.complete(route=_openai_route("gpt-4o-mini"), messages=[{"role": "user", "content": "hi"}])

    assert str(captured["url"]) == "https://api.openai.com/v1/chat/completions"
    assert "messages" in captured["body"]


def _responses_sse(events: list[dict[str, object]]) -> bytes:
    lines = []
    for event in events:
        lines.append(f"event: {event['type']}")
        lines.append(f"data: {json.dumps(event)}")
        lines.append("")
    return ("\n".join(lines) + "\n").encode()


def test_openai_responses_streaming_translates_to_openai_chunks() -> None:
    events = [
        {"type": "response.created", "response": {"id": "resp-1"}},
        {"type": "response.in_progress", "response": {"id": "resp-1"}},
        {"type": "response.output_item.added", "output_index": 0, "item": {"type": "reasoning"}},
        {"type": "response.output_text.delta", "item_id": "msg-1", "delta": "Hel"},
        {"type": "response.output_text.delta", "item_id": "msg-1", "delta": "lo"},
        {
            "type": "response.output_item.added",
            "output_index": 1,
            "item": {"type": "function_call", "id": "fc-1", "call_id": "call-9", "name": "lookup"},
        },
        {"type": "response.function_call_arguments.delta", "item_id": "fc-1", "delta": '{"q":'},
        {"type": "response.function_call_arguments.delta", "item_id": "fc-1", "delta": '"x"}'},
        {
            "type": "response.completed",
            "response": {
                "id": "resp-1",
                "status": "completed",
                "usage": {"input_tokens": 9, "output_tokens": 40, "total_tokens": 49},
            },
        },
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/responses"
        assert json.loads(request.read().decode())["stream"] is True
        return httpx.Response(200, content=_responses_sse(events))

    gateway = ModelGatewayClient(transport=httpx.MockTransport(handler))
    chunks = list(
        gateway.stream_events(
            route=_openai_route("gpt-5.5-pro"),
            messages=[{"role": "user", "content": "hi"}],
            tools=[{"type": "function", "function": {"name": "lookup", "parameters": {"type": "object"}}}],
        )
    )
    text = "".join(
        (chunk["choices"][0]["delta"].get("content") or "")
        for chunk in chunks
        if chunk.get("choices")
    )
    assert text == "Hello"
    tool_deltas = [
        delta
        for chunk in chunks
        for delta in (chunk["choices"][0]["delta"].get("tool_calls") or [])
    ]
    assert tool_deltas[0]["id"] == "call-9"
    assert tool_deltas[0]["function"]["name"] == "lookup"
    assert "".join(delta["function"]["arguments"] for delta in tool_deltas) == '{"q":"x"}'
    final = chunks[-1]
    assert final["choices"][0]["finish_reason"] == "tool_calls"
    assert final["usage"] == {"prompt_tokens": 9, "completion_tokens": 40, "total_tokens": 49}

    # The plain-text stream() wrapper carries deltas, keepalives, and usage.
    usage_sink: dict[str, object] = {}
    gateway = ModelGatewayClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, content=_responses_sse(events)))
    )
    pieces = list(
        gateway.stream(
            route=_openai_route("gpt-5.5-pro"),
            messages=[{"role": "user", "content": "hi"}],
            usage_sink=usage_sink,
        )
    )
    assert "".join(piece for piece in pieces if piece) == "Hello"
    assert usage_sink["completion_tokens"] == 40
    assert usage_sink["finish_reason"] == "tool_calls"


def test_openai_responses_agent_history_round_trips() -> None:
    """Assistant tool calls and tool results translate to function_call and
    function_call_output items so agent loops work on the Responses dialect."""
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.read().decode())
        return httpx.Response(
            200,
            json={
                "id": "resp-2",
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "72F and sunny."}],
                    }
                ],
                "usage": {"input_tokens": 20, "output_tokens": 6, "total_tokens": 26},
            },
        )

    gateway = ModelGatewayClient(transport=httpx.MockTransport(handler))
    gateway.complete(
        route=_openai_route("o3-pro"),
        messages=[
            {"role": "user", "content": "Weather in Reno?"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call-0",
                        "type": "function",
                        "function": {"name": "get_weather", "arguments": '{"city": "Reno"}'},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call-0", "content": "72F sunny"},
        ],
        tools=[
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Look up weather",
                    "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
                },
            }
        ],
        tool_choice="auto",
    )

    body = captured["body"]
    assert body["input"][1] == {
        "type": "function_call",
        "call_id": "call-0",
        "name": "get_weather",
        "arguments": '{"city": "Reno"}',
    }
    assert body["input"][2] == {
        "type": "function_call_output",
        "call_id": "call-0",
        "output": "72F sunny",
    }
    # Responses function tools are flattened, not nested under "function".
    assert body["tools"] == [
        {
            "type": "function",
            "name": "get_weather",
            "description": "Look up weather",
            "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
        }
    ]
    assert body["tool_choice"] == "auto"


def _vendor_route(kind: str, *, base_url: str | None, auth_metadata: dict | None = None) -> ModelGatewayRoute:
    return ModelGatewayRoute(
        provider_id=f"provider-{kind}-test",
        provider_name=f"{kind.title()} Test",
        provider_kind=kind,
        auth_type="bearer",
        upstream_model="vendor-model-1",
        base_url=base_url,
        configured=True,
        status_message="ready",
        secret_value="sk-vendor-test",
        auth_metadata=auth_metadata or {},
        supported_parameters=frozenset(),
    )


def test_known_vendor_kinds_route_openai_dialect_with_bearer() -> None:
    """Any registered vendor kind (xai, mistral, deepseek, ...) must route
    chat/completions with Bearer auth - key-only plug and play."""
    for kind in ("xai", "mistral", "deepseek", "together", "fireworks", "cerebras", "nvidia"):
        captured: dict[str, object] = {}
        gateway = ModelGatewayClient(transport=httpx.MockTransport(_capture_handler(captured)))
        base_url = default_provider_base_url(kind)
        assert base_url, f"{kind} should have a default base URL"
        result = gateway.complete(
            route=_vendor_route(kind, base_url=base_url),
            messages=[{"role": "user", "content": "hi"}],
        )
        assert str(captured["url"]).endswith("/chat/completions"), kind
        assert captured["headers"]["authorization"] == "Bearer sk-vendor-test", kind
        assert captured["body"]["model"] == "vendor-model-1", kind
        assert result["choices"][0]["message"]["content"] == "ok", kind


def test_unknown_provider_kind_defaults_to_openai_dialect() -> None:
    """A kind the platform has never heard of must still route through the
    industry-standard OpenAI dialect instead of failing closed."""
    captured: dict[str, object] = {}
    gateway = ModelGatewayClient(transport=httpx.MockTransport(_capture_handler(captured)))

    result = gateway.complete(
        route=_vendor_route("acme-frontier-labs", base_url="https://api.acme.example/v1"),
        messages=[{"role": "user", "content": "hi"}],
    )

    assert str(captured["url"]) == "https://api.acme.example/v1/chat/completions"
    assert captured["headers"]["authorization"] == "Bearer sk-vendor-test"
    assert result["choices"][0]["message"]["content"] == "ok"


def test_dialect_override_routes_unknown_kind_through_anthropic() -> None:
    """auth_metadata.dialect lets a custom provider declare what it speaks."""
    captured: dict[str, object] = {}
    upstream_body = {
        "id": "msg-1",
        "content": [{"type": "text", "text": "hello"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 2, "output_tokens": 3},
    }
    gateway = ModelGatewayClient(
        transport=httpx.MockTransport(_anthropic_response_handler(captured, upstream_body))
    )

    result = gateway.complete(
        route=_vendor_route(
            "acme-claude-gateway",
            base_url="https://claude-proxy.acme.example",
            auth_metadata={"dialect": "anthropic"},
        ),
        messages=[{"role": "user", "content": "hi"}],
    )

    assert captured["path"] == "/v1/messages"
    assert captured["headers"]["x-api-key"] == "sk-vendor-test"
    assert result["choices"][0]["message"]["content"] == "hello"


def test_provider_dialect_mapping() -> None:
    assert provider_dialect("openai") == "openai"
    assert provider_dialect("anthropic") == "anthropic"
    assert provider_dialect("azure-openai") == "azure-openai"
    assert provider_dialect("mistral") == "openai"
    assert provider_dialect("brand-new-vendor") == "openai"
    assert provider_dialect("brand-new-vendor", {"dialect": "anthropic"}) == "anthropic"
    assert provider_dialect("amazon-bedrock", {"dialect": "openai"}) == "openai"


def _plain_provider(kind: str, *, base_url: str | None = None, auth_metadata: dict | None = None) -> Provider:
    return Provider(
        id=f"provider-{kind}",
        name=kind.title(),
        kind=kind,
        region="US",
        base_url=base_url,
        auth_type="bearer",
        auth_metadata=auth_metadata or {},
        connected=True,
    )


def test_route_status_plug_and_play_rules() -> None:
    # A known vendor kind with only a key is ready once the default base URL
    # is resolved (resolve_model_route passes the resolved URL in).
    assert (
        _route_status(
            _plain_provider("xai"),
            base_url=default_provider_base_url("xai"),
            secret_value="sk-x",
            credential_tenant_id=None,
        )
        == "ready"
    )
    # Unknown kinds are routable, not "unsupported".
    assert (
        _route_status(
            _plain_provider("acme-frontier-labs", base_url="https://api.acme.example/v1"),
            base_url="https://api.acme.example/v1",
            secret_value="sk-x",
            credential_tenant_id=None,
        )
        == "ready"
    )
    # Bedrock's native API fails closed with an actionable message...
    bedrock_status = _route_status(
        _plain_provider("amazon-bedrock", base_url="https://bedrock.us-east-1.amazonaws.com"),
        base_url="https://bedrock.us-east-1.amazonaws.com",
        secret_value="sk-x",
        credential_tenant_id=None,
    )
    assert "SigV4" in bedrock_status
    # ...unless the owner routes it through its OpenAI-compatible endpoint.
    assert (
        _route_status(
            _plain_provider(
                "amazon-bedrock",
                base_url="https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1",
                auth_metadata={"dialect": "openai"},
            ),
            base_url="https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1",
            secret_value="bedrock-api-key",
            credential_tenant_id=None,
        )
        == "ready"
    )
    # A typo'd or unrecognized dialect override must not slip through the
    # SigV4 gate — it would post OpenAI JSON at a signed-request endpoint.
    typo_status = _route_status(
        _plain_provider(
            "amazon-bedrock",
            base_url="https://bedrock.us-east-1.amazonaws.com",
            auth_metadata={"dialect": "native"},
        ),
        base_url="https://bedrock.us-east-1.amazonaws.com",
        secret_value="sk-x",
        credential_tenant_id=None,
    )
    assert "SigV4" in typo_status


def test_responses_stream_without_terminal_event_is_an_error_not_a_reply() -> None:
    """A dropped connection after the 2xx must never surface partial or empty
    text as a successful completion."""
    truncated = [
        {"type": "response.created", "response": {"id": "resp-cut"}},
        {"type": "response.output_text.delta", "item_id": "msg-1", "delta": "Half an ans"},
    ]
    gateway = ModelGatewayClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, content=_responses_sse(truncated))
        )
    )
    with pytest.raises(ModelGatewayError, match="without completing"):
        list(
            gateway.stream_events(
                route=_openai_route("gpt-5.5-pro"),
                messages=[{"role": "user", "content": "hi"}],
            )
        )


def test_responses_content_filter_incompletion_is_reported_honestly() -> None:
    """Provider-side suppression must surface as content_filter, matching the
    chat-completions dialect, never as a normal stop."""
    events = [
        {"type": "response.output_text.delta", "item_id": "msg-1", "delta": "Part"},
        {
            "type": "response.incomplete",
            "response": {
                "id": "resp-filtered",
                "status": "incomplete",
                "incomplete_details": {"reason": "content_filter"},
                "usage": {"input_tokens": 5, "output_tokens": 2, "total_tokens": 7},
            },
        },
    ]
    gateway = ModelGatewayClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, content=_responses_sse(events))
        )
    )
    chunks = list(
        gateway.stream_events(
            route=_openai_route("gpt-5.5-pro"),
            messages=[{"role": "user", "content": "hi"}],
        )
    )
    assert chunks[-1]["choices"][0]["finish_reason"] == "content_filter"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "resp-filtered",
                "status": "incomplete",
                "incomplete_details": {"reason": "content_filter"},
                "output": [
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": "Part"}],
                    }
                ],
                "usage": {"input_tokens": 5, "output_tokens": 2, "total_tokens": 7},
            },
        )

    gateway = ModelGatewayClient(transport=httpx.MockTransport(handler))
    payload = gateway.complete(
        route=_openai_route("gpt-5.5-pro"),
        messages=[{"role": "user", "content": "hi"}],
    )
    assert payload["choices"][0]["finish_reason"] == "content_filter"


def test_vision_heuristic_matches_o_series_capabilities() -> None:
    """o1/o3/o4 are multimodal except the text-only o1-mini, o1-preview, and
    o3-mini; provider-reported modalities always win over the heuristic."""
    assert supports_image_input("o1") is True
    assert supports_image_input("o1-pro") is True
    assert supports_image_input("o3") is True
    assert supports_image_input("o3-pro") is True
    assert supports_image_input("o4-mini") is True
    assert supports_image_input("o1-mini") is False
    assert supports_image_input("o1-preview") is False
    assert supports_image_input("o3-mini") is False
    assert supports_image_input("o3-mini-high") is False
    assert supports_image_input("o3-mini", ["text", "image"]) is True
    assert supports_image_input("o3", ["text"]) is False


def test_discovery_works_for_vendor_and_unknown_kinds() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer sk-test"
        return httpx.Response(200, json={"data": [{"id": "model-a"}, {"id": "model-b"}]})

    # Known vendor kind: default base URL fills in automatically.
    models, source = discover_provider_models(
        _plain_provider("mistral"),
        "sk-test",
        transport=httpx.MockTransport(handler),
    )
    assert source == "models"
    assert [model.id for model in models] == ["model-a", "model-b"]

    # Unknown kind with an explicit base URL syncs through GET /models too.
    models, _ = discover_provider_models(
        _plain_provider("acme-frontier-labs", base_url="https://api.acme.example/v1"),
        "sk-test",
        transport=httpx.MockTransport(handler),
    )
    assert [model.id for model in models] == ["model-a", "model-b"]

    # Bedrock native stays honestly unsupported for discovery.
    with pytest.raises(ModelDiscoveryError):
        discover_provider_models(
            _plain_provider("amazon-bedrock", base_url="https://bedrock.us-east-1.amazonaws.com"),
            "sk-test",
            transport=httpx.MockTransport(handler),
        )


def test_openrouter_allowed_provider_block_explains_the_real_fix() -> None:
    """A blocked-provider 404 must name the blocker, not dump raw JSON.

    OpenRouter answers 404 "No allowed providers are available for the selected
    model" when the connected account's allowed-provider list excludes every
    upstream serving the model (live: Grok is served only by xai, which the
    account excluded). Raw, it reads like the model does not exist.
    """
    body = json.dumps(
        {
            "error": {
                "message": "No allowed providers are available for the selected model.",
                "code": 404,
                "metadata": {
                    "available_providers": ["xai"],
                    "requested_providers": ["groq", "azure", "cerebras"],
                },
            }
        }
    )
    route = _vendor_route("openrouter", base_url="https://openrouter.ai/api/v1")
    gateway = ModelGatewayClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(404, text=body))
    )

    with pytest.raises(ModelGatewayError) as excinfo:
        gateway.complete(route=route, messages=[{"role": "user", "content": "hi"}])

    message = str(excinfo.value)
    assert "allowed-providers list excludes" in message
    assert "Only xai serves it" in message
    assert "groq, azure, cerebras" in message
    assert "Allowed Providers" in message
    # The unreadable raw payload no longer leads the message.
    assert not message.startswith("Openrouter Test returned HTTP 404")


def test_unrelated_404_still_surfaces_the_raw_upstream_detail() -> None:
    """Only the blocked-provider shape is rewritten; other 404s keep their body."""
    route = _vendor_route("openrouter", base_url="https://openrouter.ai/api/v1")
    gateway = ModelGatewayClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(404, text='{"error":{"message":"No endpoints found."}}')
        )
    )

    with pytest.raises(ModelGatewayError) as excinfo:
        gateway.complete(route=route, messages=[{"role": "user", "content": "hi"}])

    assert "No endpoints found." in str(excinfo.value)
