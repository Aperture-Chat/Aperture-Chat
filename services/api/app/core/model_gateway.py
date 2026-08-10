"""Provider-aware model gateway runtime.

The platform owner model catalog is the source of truth for runtime routing:
``ModelConfig.provider_id`` selects the provider record, the provider record
selects the upstream API shape, and the provider vault supplies credentials.
Secret values stay inside this module and are never included in route metadata
returned to callers or audit events.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlencode

import httpx

from app.core.config import get_settings
from app.core.openrouter import map_model
from app.models.schemas import ModelConfig, Provider
from app.repositories.seed import SeedStore

logger = logging.getLogger("aperture.model_gateway")

DEFAULT_TIMEOUT_SECONDS = 120.0
# Non-streaming completions block until the provider finishes; reasoning
# models can legitimately take many minutes, so reads get a high floor while
# connect/write keep the configured base.
NONSTREAM_READ_TIMEOUT_SECONDS = 1800.0
# Yielded by the stream methods when the upstream sends a keep-alive comment
# instead of content (OpenRouter does this while the model is thinking).
# Consumers forward it to keep their own connections fresh; it carries no text.
STREAM_KEEPALIVE = ""
DEFAULT_ANTHROPIC_VERSION = "2023-06-01"
DEFAULT_COMPLETION_TOKEN_BUDGET = 8192
OPENAI_COMPATIBLE_KINDS = {
    "openai",
    "openai-compatible",
    "open-webui",
    "openrouter",
    "ollama",
    "local",
    # Groq speaks the OpenAI dialect; accepting the kind directly keeps a
    # provider registered as "groq" routable instead of silently unsupported.
    "groq",
    # GCP routes through Google's OpenAI-compatibility surface for the Gemini
    # API (https://generativelanguage.googleapis.com/v1beta/openai) with a
    # Bearer API key. Vertex AI proper needs OAuth service accounts, which the
    # single-key provider vault does not model.
    "gcp",
    # Vendors whose public APIs are OpenAI chat-completions compatible with a
    # Bearer API key. Registering any of these kinds routes directly; the
    # matching default base URLs below make them key-only plug and play.
    "xai",
    "grok",
    "mistral",
    "deepseek",
    "together",
    "together-ai",
    "fireworks",
    "perplexity",
    "cerebras",
    "sambanova",
    "moonshot",
    "kimi",
    "dashscope",
    "qwen",
    "zhipu",
    "z-ai",
    "minimax",
    "nvidia",
    "nim",
    "deepinfra",
    "hyperbolic",
    "novita",
    "baseten",
    "lmstudio",
    "lm-studio",
    "vllm",
    "litellm",
    "cohere",
    "ai21",
}

# Kinds the gateway must refuse instead of guessing: Amazon Bedrock's native
# InvokeModel API needs AWS SigV4 request signing, which the single-secret
# provider vault cannot produce. Owners can still route Bedrock through its
# OpenAI-compatible endpoint with a Bedrock API key by setting
# auth_metadata.dialect = "openai".
UNSUPPORTED_PROVIDER_KINDS = {"amazon-bedrock", "bedrock"}

# Default upstream endpoints for known kinds so registering a provider takes
# a kind plus an API key. An explicit base_url always wins.
DEFAULT_PROVIDER_BASE_URLS = {
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com",
    "openrouter": "https://openrouter.ai/api/v1",
    "gcp": "https://generativelanguage.googleapis.com/v1beta/openai",
    "groq": "https://api.groq.com/openai/v1",
    "xai": "https://api.x.ai/v1",
    "grok": "https://api.x.ai/v1",
    "mistral": "https://api.mistral.ai/v1",
    "deepseek": "https://api.deepseek.com/v1",
    "together": "https://api.together.xyz/v1",
    "together-ai": "https://api.together.xyz/v1",
    "fireworks": "https://api.fireworks.ai/inference/v1",
    "perplexity": "https://api.perplexity.ai",
    "cerebras": "https://api.cerebras.ai/v1",
    "sambanova": "https://api.sambanova.ai/v1",
    "moonshot": "https://api.moonshot.ai/v1",
    "kimi": "https://api.moonshot.ai/v1",
    "dashscope": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "qwen": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "zhipu": "https://api.z.ai/api/paas/v4",
    "z-ai": "https://api.z.ai/api/paas/v4",
    "minimax": "https://api.minimax.io/v1",
    "nvidia": "https://integrate.api.nvidia.com/v1",
    "nim": "https://integrate.api.nvidia.com/v1",
    "deepinfra": "https://api.deepinfra.com/v1/openai",
    "hyperbolic": "https://api.hyperbolic.xyz/v1",
    "novita": "https://api.novita.ai/v3/openai",
    "cohere": "https://api.cohere.ai/compatibility/v1",
    "ai21": "https://api.ai21.com/studio/v1",
    "ollama": "http://localhost:11434/v1",
}


def provider_dialect(kind: str, auth_metadata: dict[str, Any] | None = None) -> str:
    """The wire dialect a provider speaks: openai, anthropic, azure-openai,
    or azure-foundry.

    auth_metadata.dialect overrides the kind-based mapping so custom or
    unlisted providers can declare what they speak. Unknown kinds default to
    the OpenAI chat-completions dialect - the industry-standard surface
    almost every vendor exposes - so a new provider is routable the day it
    is registered, and a provider that genuinely speaks something else fails
    with the upstream's real error instead of a blanket "unsupported kind".
    """
    override = str((auth_metadata or {}).get("dialect") or "").strip().lower()
    if override in {"openai", "openai-compatible"}:
        return "openai"
    if override == "anthropic":
        return "anthropic"
    normalized = _provider_kind(kind)
    if normalized in {"azure-openai", "azure-foundry", "anthropic"}:
        return normalized
    return "openai"


def default_provider_base_url(kind: str) -> str | None:
    return DEFAULT_PROVIDER_BASE_URLS.get(_provider_kind(kind))

# Azure AI Foundry's model-inference endpoint takes the OpenAI payload with
# the model in the body (unlike azure-openai's per-deployment URLs) but keeps
# Azure's api-key header and api-version query parameter.
DEFAULT_AZURE_FOUNDRY_API_VERSION = "2024-05-01-preview"

# OpenAI serves some model families only on the Responses API; sending them
# to /chat/completions returns HTTP 404 ("This is not a chat model"). The
# pro-tier reasoning models (o1-pro, o3-pro, gpt-5-pro, gpt-5.5-pro and dated
# variants), the deep-research models, and the codex family are all
# Responses-only on direct OpenAI. Aggregators (OpenRouter, Groq, ...) expose
# everything through the chat dialect, so this gate applies to kind "openai"
# only.
_OPENAI_RESPONSES_ONLY_MODELS = re.compile(
    r"^(?:o[134](?:-mini)?|gpt-5(?:[.-]\d+)?)-pro(?:-|$)"
    r"|-deep-research(?:-|$)"
    r"|(?:^|-)codex(?:-|$)"
)


def _uses_openai_responses(route: ModelGatewayRoute) -> bool:
    if _provider_kind(route.provider_kind) != "openai":
        return False
    tail = (route.upstream_model or "").strip().lower().rsplit("/", 1)[-1]
    return bool(_OPENAI_RESPONSES_ONLY_MODELS.search(tail))

# Model families with controllable reasoning depth. OpenAI o-series (o1/o3/o4)
# and the GPT-5 family accept `reasoning_effort`; Claude Opus 4.5+, Sonnet
# 4.6+, and the Claude 5 family accept `output_config.effort`; xAI Grok 4.3+,
# 4.5, and 4.20 Multi-Agent accept effort via OpenRouter's unified reasoning
# parameter (Grok 4.20 base and Grok Build list `reasoning` but not
# `reasoning_effort` in OpenRouter's supported_parameters, so they stay out).
# Non-reasoning models (e.g. gpt-4o) reject these parameters upstream, so
# effort is only attached when the upstream model matches.
_OPENAI_REASONING_MODELS = re.compile(r"(?:^|[^a-z0-9])(?:o[134](?:[^a-z0-9]|$)|gpt-5|gpt-oss)")
_ANTHROPIC_REASONING_MODELS = re.compile(
    r"claude-(?:opus-4[.-][5-9]|sonnet-4[.-][6-9]|(?:opus|sonnet|fable|mythos)-5)"
)
_XAI_REASONING_MODELS = re.compile(r"grok-4[.-](?:[3-9](?:[^0-9]|$)|20-multi-agent)")


def supports_reasoning_effort(
    upstream_model_id: str | None,
    supported_parameters: frozenset[str] | set[str] = frozenset(),
) -> bool:
    # Provider-reported capability data is authoritative when present: it
    # covers families the regexes never will (Gemini, Qwen, future vendors)
    # and keeps effort away from versions that genuinely lack it.
    if supported_parameters:
        return "reasoning_effort" in supported_parameters
    model = (upstream_model_id or "").strip().lower()
    if not model:
        return False
    # OpenRouter-style ids carry a vendor prefix ("openai/gpt-5.5").
    tail = model.rsplit("/", 1)[-1]
    return bool(
        _OPENAI_REASONING_MODELS.search(tail)
        or _ANTHROPIC_REASONING_MODELS.search(tail)
        or _XAI_REASONING_MODELS.search(tail)
    )


# Model families that accept image (vision) input. Modern Claude, GPT-4o/4.1/
# 5.x, o1/o3/o4, Gemini, Grok 4, and Pixtral are natively multimodal; "vision"
# and "-vl" suffixes cover Llama vision and Qwen-VL style ids. o1-mini,
# o1-preview, and o3-mini are the text-only exceptions in the o-series
# (o4-mini is multimodal).
_VISION_INPUT_MODELS = re.compile(
    r"(?:^|[^a-z0-9])(?:claude|gemini|pixtral|gpt-4o|gpt-4-turbo|gpt-4\.1|gpt-5"
    r"|o(?:4|[13](?!-mini(?:[^a-z0-9]|$)|-preview(?:[^a-z0-9]|$)))(?:[^a-z0-9]|$)"
    r"|grok-4|vl(?:[^a-z0-9]|$))"
    r"|vision"
)


def supports_image_input(
    upstream_model_id: str | None,
    input_modalities: Iterable[str] = (),
) -> bool:
    """True when the upstream model accepts image input.

    Provider-reported input modalities are authoritative when present; absent
    data falls back to family heuristics, mirroring supports_reasoning_effort.
    """
    reported = {str(modality).strip().lower() for modality in input_modalities}
    reported.discard("")
    if reported:
        return "image" in reported
    model = (upstream_model_id or "").strip().lower()
    if not model:
        return False
    tail = model.rsplit("/", 1)[-1]
    return bool(_VISION_INPUT_MODELS.search(tail))


class ModelGatewayError(RuntimeError):
    """Raised when the selected upstream provider cannot return a completion."""

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code

    @property
    def retryable(self) -> bool:
        """True when a retry could plausibly succeed.

        Network-level failures carry no status code, and 429/5xx are transient
        by contract. Other client errors are deterministic and retrying would
        just repeat the failure.
        """
        return self.status_code is None or self.status_code == 429 or self.status_code >= 500


class ModelGatewayConfigurationError(ModelGatewayError):
    """Raised when the model catalog references an invalid provider route."""

    @property
    def retryable(self) -> bool:
        return False


class ModelGatewayAuthError(ModelGatewayError):
    """Raised when the upstream provider rejects the configured credential."""

    def __init__(self, provider_name: str, status_code: int) -> None:
        self.provider_name = provider_name
        super().__init__(
            f"{provider_name} rejected the configured provider key with HTTP {status_code}",
            status_code=status_code,
        )

    @property
    def retryable(self) -> bool:
        return False


@dataclass(frozen=True)
class ModelGatewayRoute:
    provider_id: str
    provider_name: str
    provider_kind: str
    auth_type: str
    upstream_model: str
    base_url: str | None
    configured: bool
    status_message: str
    secret_value: str | None = field(default=None, repr=False, compare=False)
    credential_key_id: str | None = field(default=None, repr=False, compare=False)
    credential_tenant_id: str | None = field(default=None, repr=False, compare=False)
    auth_metadata: dict[str, Any] = field(default_factory=dict, repr=False)
    # Provider-reported parameters the upstream model accepts (lowercase),
    # captured at model sync. Empty means "not reported", so gates fall back
    # to family heuristics rather than treating it as "supports nothing".
    supported_parameters: frozenset[str] = field(default_factory=frozenset, repr=False)

    def audit_metadata(self) -> dict[str, object]:
        return {
            "provider_id": self.provider_id,
            "provider": self.provider_name,
            "provider_kind": self.provider_kind,
            "upstream_model": self.upstream_model,
            "provider_configured": self.configured,
            "provider_status": self.status_message,
        }


class ModelGatewayClient:
    def __init__(
        self,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._timeout = timeout
        self._transport = transport

    def _completion_timeout(self) -> httpx.Timeout:
        """Non-streaming calls block until the provider finishes.

        Reasoning models can legitimately take many minutes, so reads get a
        high floor while connect/write keep the configured base timeout.
        """
        return httpx.Timeout(self._timeout, read=max(self._timeout, NONSTREAM_READ_TIMEOUT_SECONDS))

    def _stream_timeout(self) -> httpx.Timeout:
        """Streams carry no read timeout at all.

        A thinking model sends nothing for stretches, and only the user
        closing the chat should end the request — closing our response
        generator tears the upstream connection down with it.
        """
        return httpx.Timeout(self._timeout, read=None)

    def complete(
        self,
        *,
        route: ModelGatewayRoute,
        messages: list[dict[str, Any]],
        max_tokens: int | None = None,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | dict[str, Any] | None = None,
        options: dict[str, Any] | None = None,
        plugins: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        if not route.configured:
            raise ModelGatewayConfigurationError(route.status_message)
        dialect = _route_dialect(route)
        if dialect == "anthropic":
            return self._complete_anthropic(
                route=route,
                messages=messages,
                max_tokens=max_tokens,
                tools=tools,
                tool_choice=tool_choice,
                options=options,
            )
        if dialect in {"azure-openai", "azure-foundry"}:
            return self._complete_openai_compatible(
                route=route,
                messages=messages,
                include_model=dialect == "azure-foundry",
                max_tokens=max_tokens,
                tools=tools,
                tool_choice=tool_choice,
                options=options,
                plugins=plugins,
            )
        if _uses_openai_responses(route):
            return self._complete_openai_responses(
                route=route,
                messages=messages,
                max_tokens=max_tokens,
                tools=tools,
                tool_choice=tool_choice,
                options=options,
            )
        return self._complete_openai_compatible(
            route=route,
            messages=messages,
            include_model=True,
            max_tokens=max_tokens,
            tools=tools,
            tool_choice=tool_choice,
            options=options,
            plugins=plugins,
        )

    def stream(
        self,
        *,
        route: ModelGatewayRoute,
        messages: list[dict[str, str]],
        max_tokens: int | None = None,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | dict[str, Any] | None = None,
        options: dict[str, Any] | None = None,
        plugins: list[dict[str, Any]] | None = None,
        usage_sink: dict[str, Any] | None = None,
    ) -> Iterator[str]:
        if not route.configured:
            raise ModelGatewayConfigurationError(route.status_message)
        dialect = _route_dialect(route)
        if dialect in {"azure-openai", "azure-foundry"}:
            yield from self._stream_openai_compatible(
                route=route,
                messages=messages,
                include_model=dialect == "azure-foundry",
                max_tokens=max_tokens,
                tools=tools,
                tool_choice=tool_choice,
                options=options,
                plugins=plugins,
                usage_sink=usage_sink,
            )
            return
        if dialect == "anthropic":
            yield from self._chunks_as_text(
                self._stream_anthropic_events(
                    route=route,
                    messages=messages,
                    max_tokens=max_tokens,
                    tools=tools,
                    tool_choice=tool_choice,
                    options=options,
                ),
                usage_sink,
            )
            return
        if _uses_openai_responses(route):
            yield from self._chunks_as_text(
                self._stream_openai_responses_events(
                    route=route,
                    messages=messages,
                    max_tokens=max_tokens,
                    tools=tools,
                    tool_choice=tool_choice,
                    options=options,
                ),
                usage_sink,
            )
            return
        yield from self._stream_openai_compatible(
            route=route,
            messages=messages,
            include_model=True,
            max_tokens=max_tokens,
            tools=tools,
            tool_choice=tool_choice,
            options=options,
            plugins=plugins,
            usage_sink=usage_sink,
        )

    @staticmethod
    def _chunks_as_text(
        chunks: Iterator[Any],
        usage_sink: dict[str, Any] | None,
    ) -> Iterator[str]:
        """Reduce a translated OpenAI-chunk stream to text deltas.

        Shared by the dialects that stream non-OpenAI wire formats (Anthropic
        Messages, OpenAI Responses); usage and finish reasons land in the
        sink exactly like the native chat-completions stream.
        """
        for chunk in chunks:
            if chunk is _DIALECT_KEEPALIVE:
                yield STREAM_KEEPALIVE
                continue
            if usage_sink is not None:
                usage = chunk.get("usage")
                if "usage" in chunk:
                    usage_sink["_raw_usage"] = usage
                if isinstance(usage, dict) and usage:
                    usage_sink.update(usage)
            choices = chunk.get("choices") or []
            if choices and usage_sink is not None:
                finish_reason = choices[0].get("finish_reason")
                if isinstance(finish_reason, str) and finish_reason:
                    usage_sink["finish_reason"] = finish_reason
            delta = (choices[0].get("delta") or {}).get("content") if choices else None
            if delta:
                yield delta

    def stream_events(
        self,
        *,
        route: ModelGatewayRoute,
        messages: list[dict[str, Any]],
        max_tokens: int | None = None,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | dict[str, Any] | None = None,
        options: dict[str, Any] | None = None,
        plugins: list[dict[str, Any]] | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Yield full OpenAI SSE chunks, including tool-call deltas."""
        if not route.configured:
            raise ModelGatewayConfigurationError(route.status_message)
        if _route_dialect(route) == "anthropic":
            # Anthropic SSE events are translated into OpenAI-shape chunks so
            # every consumer (chat SSE, agent workflows, /v1 proxy) works the
            # same regardless of the provider dialect.
            for chunk in self._stream_anthropic_events(
                route=route,
                messages=messages,
                max_tokens=max_tokens,
                tools=tools,
                tool_choice=tool_choice,
                options=options,
            ):
                if chunk is not _DIALECT_KEEPALIVE:
                    yield chunk
            return
        if _uses_openai_responses(route):
            for chunk in self._stream_openai_responses_events(
                route=route,
                messages=messages,
                max_tokens=max_tokens,
                tools=tools,
                tool_choice=tool_choice,
                options=options,
            ):
                if chunk is not _DIALECT_KEEPALIVE:
                    yield chunk
            return
        yield from self._stream_openai_compatible_events(
            route=route,
            messages=messages,
            include_model=_route_dialect(route) != "azure-openai",
            max_tokens=max_tokens,
            tools=tools,
            tool_choice=tool_choice,
            options=options,
            plugins=plugins,
        )

    def generate_images(
        self,
        *,
        route: ModelGatewayRoute,
        messages: list[dict[str, Any]],
        max_tokens: int | None = None,
    ) -> dict[str, Any]:
        """Request a completion from an image-output model.

        OpenAI-compatible providers (including OpenRouter) accept the standard
        chat/completions shape with ``modalities`` requesting image output; the
        generated images come back base64-encoded on the assistant message.
        """
        if not route.configured:
            raise ModelGatewayConfigurationError(route.status_message)
        if _route_dialect(route) != "openai":
            raise ModelGatewayError(
                f"Image generation is not supported for provider kind '{route.provider_kind}'."
            )
        payload: dict[str, Any] = {
            "model": route.upstream_model,
            "messages": messages,
            "stream": False,
            "modalities": ["image", "text"],
        }
        _apply_completion_token_budget(payload, route, max_tokens)
        try:
            with httpx.Client(
                timeout=self._completion_timeout(), transport=self._transport
            ) as client:
                response = client.post(
                    _chat_completions_url(route), headers=_headers(route), json=payload
                )
                response.raise_for_status()
                return response.json()
        except httpx.HTTPStatusError as exc:
            raise _status_error_from_exc(route, exc) from exc
        except httpx.HTTPError as exc:
            raise ModelGatewayError(
                f"{route.provider_name} request failed: {type(exc).__name__}"
            ) from exc

    def _complete_openai_compatible(
        self,
        *,
        route: ModelGatewayRoute,
        messages: list[dict[str, Any]],
        include_model: bool,
        max_tokens: int | None,
        tools: list[dict[str, Any]] | None,
        tool_choice: str | dict[str, Any] | None,
        options: dict[str, Any] | None,
        plugins: list[dict[str, Any]] | None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"messages": messages, "stream": False}
        if include_model:
            payload["model"] = route.upstream_model
        if tools:
            payload["tools"] = tools
        if tool_choice is not None:
            payload["tool_choice"] = tool_choice
        if options:
            payload.update(options)
        if plugins:
            payload["plugins"] = plugins
        _apply_reasoning_effort(payload, route)
        _apply_completion_token_budget(payload, route, max_tokens)
        try:
            with httpx.Client(
                timeout=self._completion_timeout(), transport=self._transport
            ) as client:
                response = client.post(
                    _chat_completions_url(route), headers=_headers(route), json=payload
                )
                response.raise_for_status()
                return response.json()
        except httpx.HTTPStatusError as exc:
            raise _status_error_from_exc(route, exc) from exc
        except httpx.HTTPError as exc:
            raise ModelGatewayError(
                f"{route.provider_name} request failed: {type(exc).__name__}"
            ) from exc

    def _stream_openai_compatible(
        self,
        *,
        route: ModelGatewayRoute,
        messages: list[dict[str, str]],
        include_model: bool,
        max_tokens: int | None,
        tools: list[dict[str, Any]] | None,
        tool_choice: str | dict[str, Any] | None,
        options: dict[str, Any] | None,
        plugins: list[dict[str, Any]] | None,
        usage_sink: dict[str, Any] | None = None,
    ) -> Iterator[str]:
        payload: dict[str, Any] = {"messages": messages, "stream": True}
        if include_model:
            payload["model"] = route.upstream_model
            if usage_sink is not None:
                # Ask the provider to report real token usage on the final
                # chunk (Azure deployments on older API versions reject the
                # parameter, so it stays scoped to model-addressed providers).
                payload["stream_options"] = {"include_usage": True}
        if tools:
            payload["tools"] = tools
        if tool_choice is not None:
            payload["tool_choice"] = tool_choice
        if options:
            payload.update(options)
        if plugins:
            payload["plugins"] = plugins
        _apply_reasoning_effort(payload, route)
        _apply_completion_token_budget(payload, route, max_tokens)
        try:
            with httpx.Client(timeout=self._stream_timeout(), transport=self._transport) as client:
                with client.stream(
                    "POST",
                    _chat_completions_url(route),
                    headers=_headers(route),
                    json=payload,
                ) as response:
                    if response.status_code >= 400:
                        # Read the body while the stream context is still
                        # open; after raise_for_status propagates it is gone.
                        try:
                            body = response.read().decode("utf-8", "replace")
                        except Exception:
                            body = ""
                        raise _status_error(route, response.status_code, body.strip())
                    for line in response.iter_lines():
                        if line.startswith(":"):
                            # Upstream keep-alive comment (OpenRouter emits
                            # these while the model is still thinking).
                            # Surface it so consumers can keep their own
                            # connections fresh instead of reading silence.
                            yield STREAM_KEEPALIVE
                            continue
                        chunk = _parse_openai_stream_chunk(line)
                        if chunk is _STREAM_DONE:
                            return
                        if not isinstance(chunk, dict):
                            continue
                        if usage_sink is not None:
                            usage = chunk.get("usage")
                            if "usage" in chunk:
                                usage_sink["_raw_usage"] = usage
                            if isinstance(usage, dict) and usage:
                                usage_sink.update(usage)
                            annotations = _openai_stream_annotations(chunk)
                            if annotations:
                                existing_annotations = usage_sink.get("annotations")
                                collected = (
                                    existing_annotations
                                    if isinstance(existing_annotations, list)
                                    else []
                                )
                                collected.extend(annotations)
                                usage_sink["annotations"] = collected
                        choices = chunk.get("choices") or []
                        if choices and usage_sink is not None:
                            finish_reason = choices[0].get("finish_reason")
                            if isinstance(finish_reason, str) and finish_reason:
                                # Recorded so the chat route can continue a
                                # response the provider cut at the token budget.
                                usage_sink["finish_reason"] = finish_reason
                        delta = (choices[0].get("delta") or {}).get("content") if choices else None
                        if delta:
                            yield delta
        except httpx.HTTPStatusError as exc:
            raise _status_error_from_exc(route, exc) from exc
        except httpx.HTTPError as exc:
            raise ModelGatewayError(
                f"{route.provider_name} stream failed: {type(exc).__name__}"
            ) from exc

    def _stream_openai_compatible_events(
        self,
        *,
        route: ModelGatewayRoute,
        messages: list[dict[str, Any]],
        include_model: bool,
        max_tokens: int | None,
        tools: list[dict[str, Any]] | None,
        tool_choice: str | dict[str, Any] | None,
        options: dict[str, Any] | None,
        plugins: list[dict[str, Any]] | None,
    ) -> Iterator[dict[str, Any]]:
        payload: dict[str, Any] = {"messages": messages, "stream": True}
        if include_model:
            payload["model"] = route.upstream_model
        if tools:
            payload["tools"] = tools
        if tool_choice is not None:
            payload["tool_choice"] = tool_choice
        if options:
            payload.update(options)
        if plugins:
            payload["plugins"] = plugins
        _apply_reasoning_effort(payload, route)
        _apply_completion_token_budget(payload, route, max_tokens)
        try:
            with httpx.Client(timeout=self._stream_timeout(), transport=self._transport) as client:
                with client.stream(
                    "POST",
                    _chat_completions_url(route),
                    headers=_headers(route),
                    json=payload,
                ) as response:
                    if response.status_code >= 400:
                        # Read the body while the stream context is still
                        # open; after raise_for_status propagates it is gone.
                        try:
                            body = response.read().decode("utf-8", "replace")
                        except Exception:
                            body = ""
                        raise _status_error(route, response.status_code, body.strip())
                    for line in response.iter_lines():
                        if not line or not line.startswith("data:"):
                            continue
                        data = line[len("data:") :].strip()
                        if data == "[DONE]":
                            return
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        if isinstance(chunk, dict):
                            yield chunk
        except httpx.HTTPStatusError as exc:
            raise _status_error_from_exc(route, exc) from exc
        except httpx.HTTPError as exc:
            raise ModelGatewayError(
                f"{route.provider_name} stream failed: {type(exc).__name__}"
            ) from exc

    def _complete_anthropic(
        self,
        *,
        route: ModelGatewayRoute,
        messages: list[dict[str, Any]],
        max_tokens: int | None,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | dict[str, Any] | None = None,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload = _anthropic_payload(
            route,
            messages,
            max_tokens=max_tokens,
            tools=tools,
            tool_choice=tool_choice,
            options=options,
        )
        try:
            with httpx.Client(
                timeout=self._completion_timeout(), transport=self._transport
            ) as client:
                response = client.post(
                    _anthropic_messages_url(route), headers=_headers(route), json=payload
                )
                response.raise_for_status()
                return _translate_anthropic_response(response.json(), route)
        except httpx.HTTPStatusError as exc:
            raise _status_error_from_exc(route, exc) from exc
        except httpx.HTTPError as exc:
            raise ModelGatewayError(
                f"{route.provider_name} request failed: {type(exc).__name__}"
            ) from exc

    def _stream_anthropic_events(
        self,
        *,
        route: ModelGatewayRoute,
        messages: list[dict[str, Any]],
        max_tokens: int | None,
        tools: list[dict[str, Any]] | None,
        tool_choice: str | dict[str, Any] | None,
        options: dict[str, Any] | None,
    ) -> Iterator[Any]:
        """Stream an Anthropic Messages request as OpenAI-shape chunks.

        Text deltas, tool-call deltas, usage, and finish reasons are all
        translated so consumers never need to know the provider dialect.
        Yields _DIALECT_KEEPALIVE for upstream pings.
        """
        payload = _anthropic_payload(
            route,
            messages,
            max_tokens=max_tokens,
            tools=tools,
            tool_choice=tool_choice,
            options=options,
        )
        payload["stream"] = True
        input_tokens = 0
        tool_block_indexes: dict[int, int] = {}
        try:
            with httpx.Client(timeout=self._stream_timeout(), transport=self._transport) as client:
                with client.stream(
                    "POST",
                    _anthropic_messages_url(route),
                    headers=_headers(route),
                    json=payload,
                ) as response:
                    if response.status_code >= 400:
                        # Read the body while the stream context is still
                        # open; after raise_for_status propagates it is gone.
                        try:
                            body = response.read().decode("utf-8", "replace")
                        except Exception:
                            body = ""
                        raise _status_error(route, response.status_code, body.strip())
                    for line in response.iter_lines():
                        if not line or not line.startswith("data:"):
                            continue
                        try:
                            event = json.loads(line[len("data:") :].strip())
                        except json.JSONDecodeError:
                            continue
                        if not isinstance(event, dict):
                            continue
                        event_type = event.get("type")
                        if event_type == "ping":
                            yield _DIALECT_KEEPALIVE
                            continue
                        if event_type == "message_start":
                            usage = (event.get("message") or {}).get("usage") or {}
                            input_tokens = int(usage.get("input_tokens") or 0)
                            continue
                        if event_type == "content_block_start":
                            block = event.get("content_block") or {}
                            if block.get("type") == "tool_use":
                                call_index = len(tool_block_indexes)
                                tool_block_indexes[int(event.get("index") or 0)] = call_index
                                yield _openai_chunk(
                                    route,
                                    delta={
                                        "tool_calls": [
                                            {
                                                "index": call_index,
                                                "id": block.get("id"),
                                                "type": "function",
                                                "function": {
                                                    "name": block.get("name"),
                                                    "arguments": "",
                                                },
                                            }
                                        ]
                                    },
                                )
                            continue
                        if event_type == "content_block_delta":
                            delta = event.get("delta") or {}
                            if delta.get("type") == "text_delta" and delta.get("text"):
                                yield _openai_chunk(route, delta={"content": delta["text"]})
                            elif delta.get("type") == "input_json_delta":
                                call_index = tool_block_indexes.get(int(event.get("index") or 0))
                                if call_index is not None:
                                    yield _openai_chunk(
                                        route,
                                        delta={
                                            "tool_calls": [
                                                {
                                                    "index": call_index,
                                                    "function": {
                                                        "arguments": delta.get("partial_json") or ""
                                                    },
                                                }
                                            ]
                                        },
                                    )
                            continue
                        if event_type == "message_delta":
                            stop_reason = (event.get("delta") or {}).get("stop_reason")
                            usage = event.get("usage") or {}
                            output_tokens = int(usage.get("output_tokens") or 0)
                            yield _openai_chunk(
                                route,
                                delta={},
                                finish_reason=_openai_finish_reason(stop_reason),
                                usage={
                                    "prompt_tokens": input_tokens,
                                    "completion_tokens": output_tokens,
                                    "total_tokens": input_tokens + output_tokens,
                                },
                            )
                            continue
        except httpx.HTTPStatusError as exc:
            raise _status_error_from_exc(route, exc) from exc
        except httpx.HTTPError as exc:
            raise ModelGatewayError(
                f"{route.provider_name} stream failed: {type(exc).__name__}"
            ) from exc

    def _complete_openai_responses(
        self,
        *,
        route: ModelGatewayRoute,
        messages: list[dict[str, Any]],
        max_tokens: int | None,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | dict[str, Any] | None = None,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload = _openai_responses_payload(
            route,
            messages,
            max_tokens=max_tokens,
            tools=tools,
            tool_choice=tool_choice,
            options=options,
        )
        try:
            with httpx.Client(
                timeout=self._completion_timeout(), transport=self._transport
            ) as client:
                response = client.post(
                    _openai_responses_url(route), headers=_headers(route), json=payload
                )
                response.raise_for_status()
                return _translate_openai_responses_payload(response.json(), route)
        except httpx.HTTPStatusError as exc:
            raise _status_error_from_exc(route, exc) from exc
        except httpx.HTTPError as exc:
            raise ModelGatewayError(
                f"{route.provider_name} request failed: {type(exc).__name__}"
            ) from exc

    def _stream_openai_responses_events(
        self,
        *,
        route: ModelGatewayRoute,
        messages: list[dict[str, Any]],
        max_tokens: int | None,
        tools: list[dict[str, Any]] | None,
        tool_choice: str | dict[str, Any] | None,
        options: dict[str, Any] | None,
    ) -> Iterator[Any]:
        """Stream an OpenAI Responses request as chat-completions chunks.

        Text deltas, tool-call deltas, usage, and finish reasons are all
        translated so consumers never need to know the provider dialect.
        Yields _DIALECT_KEEPALIVE for lifecycle/reasoning events that carry
        no user-visible content but prove the model is still working.
        """
        payload = _openai_responses_payload(
            route,
            messages,
            max_tokens=max_tokens,
            tools=tools,
            tool_choice=tool_choice,
            options=options,
        )
        payload["stream"] = True
        tool_call_indexes: dict[str, int] = {}
        saw_terminal_event = False
        try:
            with httpx.Client(timeout=self._stream_timeout(), transport=self._transport) as client:
                with client.stream(
                    "POST",
                    _openai_responses_url(route),
                    headers=_headers(route),
                    json=payload,
                ) as response:
                    if response.status_code >= 400:
                        # Read the body while the stream context is still
                        # open; after raise_for_status propagates it is gone.
                        try:
                            body = response.read().decode("utf-8", "replace")
                        except Exception:
                            body = ""
                        raise _status_error(route, response.status_code, body.strip())
                    for line in response.iter_lines():
                        if not line or not line.startswith("data:"):
                            continue
                        try:
                            event = json.loads(line[len("data:") :].strip())
                        except json.JSONDecodeError:
                            continue
                        if not isinstance(event, dict):
                            continue
                        event_type = str(event.get("type") or "")
                        if event_type == "response.output_text.delta":
                            delta = str(event.get("delta") or "")
                            if delta:
                                yield _openai_chunk(route, delta={"content": delta})
                            continue
                        if event_type == "response.output_item.added":
                            item = event.get("item") or {}
                            if isinstance(item, dict) and item.get("type") == "function_call":
                                call_index = len(tool_call_indexes)
                                tool_call_indexes[str(item.get("id") or "")] = call_index
                                yield _openai_chunk(
                                    route,
                                    delta={
                                        "tool_calls": [
                                            {
                                                "index": call_index,
                                                "id": str(
                                                    item.get("call_id") or item.get("id") or ""
                                                ),
                                                "type": "function",
                                                "function": {
                                                    "name": str(item.get("name") or ""),
                                                    "arguments": "",
                                                },
                                            }
                                        ]
                                    },
                                )
                            else:
                                yield _DIALECT_KEEPALIVE
                            continue
                        if event_type == "response.function_call_arguments.delta":
                            call_index = tool_call_indexes.get(str(event.get("item_id") or ""))
                            if call_index is not None:
                                yield _openai_chunk(
                                    route,
                                    delta={
                                        "tool_calls": [
                                            {
                                                "index": call_index,
                                                "function": {
                                                    "arguments": str(event.get("delta") or "")
                                                },
                                            }
                                        ]
                                    },
                                )
                            continue
                        if event_type in {"response.completed", "response.incomplete"}:
                            final = event.get("response") or {}
                            usage = final.get("usage") or {}
                            prompt_tokens = int(usage.get("input_tokens") or 0)
                            completion_tokens = int(usage.get("output_tokens") or 0)
                            total_tokens = int(
                                usage.get("total_tokens") or (prompt_tokens + completion_tokens)
                            )
                            if event_type == "response.incomplete":
                                finish_reason = _responses_incomplete_finish_reason(
                                    final.get("incomplete_details")
                                )
                            else:
                                finish_reason = "tool_calls" if tool_call_indexes else "stop"
                            saw_terminal_event = True
                            yield _openai_chunk(
                                route,
                                delta={},
                                finish_reason=finish_reason,
                                usage={
                                    "prompt_tokens": prompt_tokens,
                                    "completion_tokens": completion_tokens,
                                    "total_tokens": total_tokens,
                                },
                            )
                            continue
                        if event_type in {"response.failed", "error"}:
                            # An in-stream failure must surface as an error,
                            # never as a silently truncated response.
                            raise ModelGatewayError(
                                f"{route.provider_name} stream failed: "
                                f"{_responses_stream_error_message(event)}"
                            )
                        # Lifecycle and reasoning-progress events
                        # (response.created, response.in_progress,
                        # response.reasoning_summary_text.delta, ...) carry no
                        # chat content but prove the model is alive.
                        yield _DIALECT_KEEPALIVE
                    if not saw_terminal_event:
                        # The Responses API guarantees a terminal event. A
                        # stream that just stops (dropped connection, proxy
                        # truncation after the 2xx) must never present its
                        # partial text as a completed reply.
                        raise ModelGatewayError(
                            f"{route.provider_name} stream ended without completing "
                            "the response."
                        )
        except httpx.HTTPStatusError as exc:
            raise _status_error_from_exc(route, exc) from exc
        except httpx.HTTPError as exc:
            raise ModelGatewayError(
                f"{route.provider_name} stream failed: {type(exc).__name__}"
            ) from exc


def _openai_chunk(
    route: ModelGatewayRoute,
    *,
    delta: dict[str, Any],
    finish_reason: str | None = None,
    usage: dict[str, int] | None = None,
) -> dict[str, Any]:
    chunk: dict[str, Any] = {
        "object": "chat.completion.chunk",
        "model": route.upstream_model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }
    if usage is not None:
        chunk["usage"] = usage
    return chunk


def _openai_finish_reason(stop_reason: Any) -> str:
    if stop_reason == "tool_use":
        return "tool_calls"
    if stop_reason == "max_tokens":
        return "length"
    return "stop"


def _status_error_from_exc(
    route: ModelGatewayRoute, exc: httpx.HTTPStatusError
) -> ModelGatewayError:
    try:
        detail = exc.response.text.strip()
    except Exception:
        detail = ""
    return _status_error(route, exc.response.status_code, detail)


def _status_error(
    route: ModelGatewayRoute, status_code: int, detail: str = ""
) -> ModelGatewayError:
    if status_code == 401:
        return ModelGatewayAuthError(route.provider_name, status_code)
    routing_block = _provider_routing_block_message(route, status_code, detail)
    if routing_block is not None:
        return ModelGatewayError(routing_block, status_code=status_code)
    # The upstream error body names the actual rejection reason (parameter,
    # token limit, dialect rule); without it a 4xx is undiagnosable.
    suffix = f": {detail[:300]}" if detail else ""
    return ModelGatewayError(
        f"{route.provider_name} returned HTTP {status_code}{suffix}",
        status_code=status_code,
    )


def _provider_routing_block_message(
    route: ModelGatewayRoute, status_code: int, detail: str
) -> str | None:
    """Explain OpenRouter's "No allowed providers" 404 in actionable terms.

    OpenRouter answers with this 404 when the connected account's allowed-provider
    list excludes every upstream that serves the requested model. Raw, the body is
    a truncated JSON blob that reads like the model is missing. Naming the blocked
    upstream and where to change it turns a dead end into one clear next step.
    """
    if status_code != 404 or "no allowed providers" not in detail.lower():
        return None
    available: list[str] = []
    allowed: list[str] = []
    try:
        metadata = json.loads(detail).get("error", {}).get("metadata", {})
        if isinstance(metadata, dict):
            raw_available = metadata.get("available_providers")
            raw_allowed = metadata.get("requested_providers")
            if isinstance(raw_available, list):
                available = [str(item) for item in raw_available if str(item).strip()]
            if isinstance(raw_allowed, list):
                allowed = [str(item) for item in raw_allowed if str(item).strip()]
    except (ValueError, AttributeError):
        pass

    model_label = route.upstream_model or "this model"
    message = (
        f"{model_label} is not runnable on the connected {route.provider_name} account: "
        "its allowed-providers list excludes every upstream that serves this model."
    )
    if available:
        message += f" Only {', '.join(available)} serves it"
        if allowed:
            message += f", while the account allows {', '.join(allowed)}"
        message += "."
    message += (
        f" Add the missing provider under {route.provider_name} account settings "
        "(Settings → Allowed Providers), or pick a different model."
    )
    return message


def resolve_model_route(
    store: SeedStore,
    model: ModelConfig,
    *,
    tenant_id: str | None = None,
) -> ModelGatewayRoute:
    provider = store.providers.get(model.provider_id)
    if provider is None:
        raise ModelGatewayConfigurationError(
            f"Model '{model.id}' references unknown provider '{model.provider_id}'."
        )

    upstream_model = _upstream_model(provider, model)
    # Validate the selected model before reading a credential or constructing a
    # provider request. Invalid catalog aliases fail closed instead of silently
    # substituting a deployment-wide default model.
    secret = store.provider_key_secret_for_provider(provider.id, tenant_id=tenant_id)
    # Known kinds get their vendor default endpoint so a provider registered
    # with just a kind and a key is immediately routable.
    base_url = (provider.base_url or "").strip() or default_provider_base_url(provider.kind)
    status_message = _route_status(
        provider,
        base_url=base_url,
        secret_value=secret.secret_value if secret else None,
        credential_tenant_id=secret.tenant_id if secret else None,
    )
    return ModelGatewayRoute(
        provider_id=provider.id,
        provider_name=provider.name,
        provider_kind=provider.kind,
        auth_type=provider.auth_type,
        upstream_model=upstream_model,
        base_url=base_url,
        configured=status_message == "ready",
        status_message=status_message,
        secret_value=secret.secret_value if secret else None,
        credential_key_id=secret.id if secret else None,
        credential_tenant_id=secret.tenant_id if secret else None,
        auth_metadata=dict(provider.auth_metadata),
        supported_parameters=frozenset(model.capabilities.supported_parameters)
        if model.capabilities
        else frozenset(),
    )


def _route_status(
    provider: Provider,
    *,
    base_url: str | None,
    secret_value: str | None,
    credential_tenant_id: str | None,
) -> str:
    kind = _provider_kind(provider.kind)
    # Every other kind routes through a dialect (unknown kinds default to the
    # OpenAI dialect), so only genuinely un-routable providers fail closed.
    # For those, only a dialect override the gateway actually recognizes
    # counts — "native", a typo, or any other value would silently fall
    # through to OpenAI JSON posted at a SigV4 endpoint.
    if kind in UNSUPPORTED_PROVIDER_KINDS and str(
        provider.auth_metadata.get("dialect") or ""
    ).strip().lower() not in {"openai", "openai-compatible", "anthropic"}:
        return (
            "Amazon Bedrock's native API needs AWS SigV4 request signing, which the "
            "gateway does not support. Point the base URL at Bedrock's OpenAI-compatible "
            "endpoint with a Bedrock API key and set auth_metadata.dialect to 'openai' "
            "to route it."
        )
    # ``connected`` is the platform credential's explicit/global state. A
    # tenant-scoped active credential has its own readiness and must not be
    # disabled because another scope changed the shared provider health bit.
    if not provider.connected and credential_tenant_id is None:
        return "Provider is disabled or not connected."
    if not base_url:
        return "Provider base URL is missing."
    if not secret_value:
        return "Provider key is not configured in the platform vault."
    return "ready"


def _upstream_model(provider: Provider, model: ModelConfig) -> str:
    if model.upstream_model_id:
        return model.upstream_model_id

    explicit_map = provider.auth_metadata.get("model_map")
    if isinstance(explicit_map, dict):
        mapped = explicit_map.get(model.id) or explicit_map.get(model.name)
        if isinstance(mapped, str) and mapped.strip():
            return mapped.strip()

    explicit_model = provider.auth_metadata.get("upstream_model")
    if isinstance(explicit_model, str) and explicit_model.strip():
        return explicit_model.strip()

    if _provider_kind(provider.kind) == "openrouter" and model.id:
        try:
            return map_model(model.id)
        except ValueError as exc:
            raise ModelGatewayConfigurationError(
                f"Selected model '{model.id}' has no explicit OpenRouter upstream model id."
            ) from exc

    return model.name or model.id


def _chat_completions_url(route: ModelGatewayRoute) -> str:
    base_url = (route.base_url or "").rstrip("/")
    if not base_url:
        raise ModelGatewayConfigurationError("Provider base URL is missing.")

    if _provider_kind(route.provider_kind) == "azure-openai":
        api_version = str(route.auth_metadata.get("api_version") or "2024-10-21")
        deployment = str(
            route.auth_metadata.get("deployment_id")
            or route.auth_metadata.get("deployment")
            or route.upstream_model
        )
        return f"{base_url}/deployments/{deployment}/chat/completions?{urlencode({'api-version': api_version})}"

    if _provider_kind(route.provider_kind) == "azure-foundry":
        api_version = str(
            route.auth_metadata.get("api_version") or DEFAULT_AZURE_FOUNDRY_API_VERSION
        )
        path = (
            base_url if base_url.endswith("/chat/completions") else f"{base_url}/chat/completions"
        )
        return f"{path}?{urlencode({'api-version': api_version})}"

    if base_url.endswith("/chat/completions"):
        return base_url
    return f"{base_url}/chat/completions"


def _openai_responses_url(route: ModelGatewayRoute) -> str:
    base_url = (route.base_url or "").rstrip("/")
    if not base_url:
        raise ModelGatewayConfigurationError("Provider base URL is missing.")
    if base_url.endswith("/chat/completions"):
        base_url = base_url[: -len("/chat/completions")].rstrip("/")
    if base_url.endswith("/responses"):
        return base_url
    return f"{base_url}/responses"


def _openai_responses_payload(
    route: ModelGatewayRoute,
    messages: list[dict[str, Any]],
    *,
    max_tokens: int | None,
    tools: list[dict[str, Any]] | None = None,
    tool_choice: str | dict[str, Any] | None = None,
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": route.upstream_model,
        "input": _responses_input_items(messages),
        "max_output_tokens": _completion_token_budget(route, max_tokens),
        # The Responses API persists responses server-side by default; chat
        # completions never did. Opt out so provider-side data handling stays
        # identical across both dialects.
        "store": False,
    }
    translated_tools = [_responses_tool(tool) for tool in tools or []]
    translated_tools = [tool for tool in translated_tools if tool is not None]
    if translated_tools:
        payload["tools"] = translated_tools
        translated_choice = _responses_tool_choice(tool_choice)
        if translated_choice is not None:
            payload["tool_choice"] = translated_choice
        if (options or {}).get("parallel_tool_calls") is False:
            payload["parallel_tool_calls"] = False

    # Responses-only OpenAI models are all reasoning models: they reject the
    # sampling knobs (temperature, top_p, seed) and the Responses API has no
    # stop/response_format equivalent for this shape, so only the reasoning
    # effort survives translation instead of being forwarded to fail upstream.
    effort = (options or {}).get("reasoning_effort")
    if (
        isinstance(effort, str)
        and effort
        and supports_reasoning_effort(route.upstream_model, route.supported_parameters)
    ):
        payload["reasoning"] = {"effort": effort}
    return payload


def _responses_input_items(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """OpenAI-shape chat messages translated to Responses input items.

    Assistant tool calls become function_call items and tool results become
    function_call_output items so multi-round agent loops run identically on
    the Responses dialect.
    """
    items: list[dict[str, Any]] = []
    for message in messages:
        role = str(message.get("role") or "user")
        content = message.get("content")
        if role == "tool":
            items.append(
                {
                    "type": "function_call_output",
                    "call_id": str(message.get("tool_call_id") or ""),
                    "output": str(content or ""),
                }
            )
            continue
        if role == "assistant":
            text = _responses_flatten_text(content)
            if text:
                items.append({"role": "assistant", "content": text})
            tool_calls = message.get("tool_calls")
            if isinstance(tool_calls, list):
                for call in tool_calls:
                    if not isinstance(call, dict):
                        continue
                    function = call.get("function") or {}
                    items.append(
                        {
                            "type": "function_call",
                            "call_id": str(call.get("id") or ""),
                            "name": str(function.get("name") or ""),
                            "arguments": str(function.get("arguments") or "{}"),
                        }
                    )
            continue
        if role == "system":
            items.append({"role": "system", "content": _responses_flatten_text(content)})
            continue
        items.append({"role": "user", "content": _responses_user_content(content)})
    if not items:
        items.append({"role": "user", "content": ""})
    return items


def _responses_flatten_text(content: Any) -> str:
    if isinstance(content, list):
        return "".join(
            str(part.get("text") or "")
            for part in content
            if isinstance(part, dict) and part.get("type") in {"text", "output_text"}
        )
    return str(content or "")


def _responses_user_content(content: Any) -> str | list[dict[str, Any]]:
    """User content translated part-by-part to the Responses dialect.

    OpenAI-chat image_url parts (the platform attaches uploaded images as
    base64 data URLs) become input_image parts; text parts become input_text;
    already-Responses-shaped parts pass through unchanged.
    """
    if not isinstance(content, list):
        return str(content or "")
    parts: list[dict[str, Any]] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        part_type = part.get("type")
        if part_type == "text":
            text = str(part.get("text") or "")
            if text:
                parts.append({"type": "input_text", "text": text})
        elif part_type == "image_url":
            raw = part.get("image_url")
            url = str((raw or {}).get("url") or "") if isinstance(raw, dict) else str(raw or "")
            if url:
                parts.append({"type": "input_image", "image_url": url})
        else:
            parts.append(part)
    return parts or ""


def _responses_tool(tool: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(tool, dict):
        return None
    function = tool.get("function") if tool.get("type") == "function" else tool
    if not isinstance(function, dict):
        return None
    name = str(function.get("name") or "").strip()
    if not name:
        return None
    parameters = function.get("parameters")
    return {
        "type": "function",
        "name": name,
        "description": str(function.get("description") or ""),
        "parameters": parameters
        if isinstance(parameters, dict)
        else {"type": "object", "properties": {}},
    }


def _responses_tool_choice(
    tool_choice: str | dict[str, Any] | None,
) -> str | dict[str, Any] | None:
    if tool_choice is None:
        return None
    if isinstance(tool_choice, str):
        return tool_choice if tool_choice in {"auto", "none", "required"} else None
    function = tool_choice.get("function") if isinstance(tool_choice, dict) else None
    name = str((function or {}).get("name") or "").strip()
    if name:
        return {"type": "function", "name": name}
    return None


def _translate_openai_responses_payload(
    payload: dict[str, Any], route: ModelGatewayRoute
) -> dict[str, Any]:
    if str(payload.get("status") or "") == "failed":
        error = payload.get("error") or {}
        message = str(error.get("message") or "") if isinstance(error, dict) else ""
        raise ModelGatewayError(
            f"{route.provider_name} response failed: {message or 'unknown provider error'}"
        )
    text = ""
    tool_calls: list[dict[str, Any]] = []
    for item in payload.get("output") or []:
        if not isinstance(item, dict):
            continue
        item_type = item.get("type")
        if item_type == "message":
            for part in item.get("content") or []:
                if isinstance(part, dict) and part.get("type") == "output_text":
                    text += str(part.get("text") or "")
        elif item_type == "function_call":
            tool_calls.append(
                {
                    "id": str(item.get("call_id") or item.get("id") or ""),
                    "type": "function",
                    "function": {
                        "name": str(item.get("name") or ""),
                        "arguments": str(item.get("arguments") or "{}"),
                    },
                }
            )
    usage = payload.get("usage") or {}
    prompt_tokens = int(usage.get("input_tokens") or 0)
    completion_tokens = int(usage.get("output_tokens") or 0)
    total_tokens = int(usage.get("total_tokens") or (prompt_tokens + completion_tokens))
    finish_reason = "tool_calls" if tool_calls else "stop"
    if str(payload.get("status") or "") == "incomplete":
        finish_reason = _responses_incomplete_finish_reason(payload.get("incomplete_details"))
    message: dict[str, Any] = {"role": "assistant", "content": text}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return {
        "id": payload.get("id"),
        "model": route.upstream_model,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
        },
    }


def _responses_incomplete_finish_reason(details: Any) -> str:
    """Map an incomplete Responses run to an honest finish reason.

    ``content_filter`` must surface as such — reporting a provider-suppressed
    reply as a normal "stop" would present filtered output as a complete
    answer with no signal anything was withheld.
    """
    reason = str((details or {}).get("reason") or "") if isinstance(details, dict) else ""
    if reason == "max_output_tokens":
        return "length"
    if reason == "content_filter":
        return "content_filter"
    return "stop"


def _responses_stream_error_message(event: dict[str, Any]) -> str:
    error = event.get("error")
    if not isinstance(error, dict):
        final = event.get("response")
        error = final.get("error") if isinstance(final, dict) else None
    if isinstance(error, dict):
        message = str(error.get("message") or "")
        if message:
            return message[:300]
    message = str(event.get("message") or "")
    return message[:300] if message else "unknown provider error"


def _anthropic_messages_url(route: ModelGatewayRoute) -> str:
    base_url = (route.base_url or "https://api.anthropic.com").rstrip("/")
    if base_url.endswith("/messages"):
        return base_url
    return f"{base_url}/v1/messages" if not base_url.endswith("/v1") else f"{base_url}/messages"


def _headers(route: ModelGatewayRoute) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    secret = route.secret_value or ""
    kind = _provider_kind(route.provider_kind)
    dialect = _route_dialect(route)
    if dialect == "anthropic":
        headers["x-api-key"] = secret
        headers["anthropic-version"] = str(
            route.auth_metadata.get("anthropic_version") or DEFAULT_ANTHROPIC_VERSION
        )
        return headers
    if kind == "openrouter":
        settings = get_settings()
        if settings.openrouter_app_referer:
            headers["HTTP-Referer"] = settings.openrouter_app_referer
        if settings.openrouter_app_title:
            headers["X-Title"] = settings.openrouter_app_title

    header_name = str(route.auth_metadata.get("header_name") or "").strip()
    auth_type = route.auth_type.lower()
    if not header_name:
        # OpenAI-style APIs (including every unknown kind that falls back to
        # the OpenAI dialect) accept Authorization: Bearer; honoring the
        # generic "api-key" default here caused silent 401s for providers
        # created through the console with the default auth type. Azure is
        # the only dialect whose convention is the bare api-key header.
        if dialect in {"azure-openai", "azure-foundry"} and auth_type not in {"bearer", "oauth"}:
            header_name = "api-key"
        else:
            header_name = "Authorization"

    if header_name.lower() == "authorization" or auth_type in {"bearer", "oauth"}:
        headers[header_name] = (
            secret if secret.lower().startswith("bearer ") else f"Bearer {secret}"
        )
    else:
        headers[header_name] = secret
    return headers


def _anthropic_payload(
    route: ModelGatewayRoute,
    messages: list[dict[str, Any]],
    *,
    max_tokens: int | None,
    tools: list[dict[str, Any]] | None = None,
    tool_choice: str | dict[str, Any] | None = None,
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    system_messages: list[str] = []
    anthropic_messages: list[dict[str, Any]] = []
    for message in messages:
        role = message.get("role") or "user"
        if role == "system":
            system_messages.append(str(message.get("content") or ""))
            continue
        translated = _anthropic_message(message)
        if translated is not None:
            anthropic_messages.append(translated)
    if not anthropic_messages:
        anthropic_messages.append({"role": "user", "content": ""})

    payload: dict[str, Any] = {
        "model": route.upstream_model,
        "messages": anthropic_messages,
        "max_tokens": _completion_token_budget(route, max_tokens),
    }
    if system_messages:
        payload["system"] = "\n\n".join(system_messages)
    translated_tools = [_anthropic_tool(tool) for tool in tools or []]
    translated_tools = [tool for tool in translated_tools if tool is not None]
    if translated_tools:
        payload["tools"] = translated_tools
        translated_choice = _anthropic_tool_choice(tool_choice)
        if translated_choice is not None:
            payload["tool_choice"] = translated_choice
        if (options or {}).get("parallel_tool_calls") is False:
            payload.setdefault("tool_choice", {"type": "auto"})["disable_parallel_tool_use"] = True

    # Anthropic accepts the standard sampling knobs under its own names;
    # parameters its API rejects (seed, response_format, penalties) are
    # dropped instead of being forwarded to fail upstream.
    generation = options or {}
    if isinstance(generation.get("temperature"), (int, float)):
        payload["temperature"] = generation["temperature"]
    if isinstance(generation.get("top_p"), (int, float)):
        payload["top_p"] = generation["top_p"]
    stop = generation.get("stop")
    if isinstance(stop, str) and stop:
        payload["stop_sequences"] = [stop]
    elif isinstance(stop, list):
        sequences = [entry for entry in stop if isinstance(entry, str) and entry]
        if sequences:
            payload["stop_sequences"] = sequences

    effort = generation.get("reasoning_effort")
    if (
        isinstance(effort, str)
        and effort
        and supports_reasoning_effort(route.upstream_model, route.supported_parameters)
    ):
        # Anthropic's effort scale has no "minimal"; the fast path maps to
        # its lowest level (thinking already stays off below "high").
        payload["output_config"] = {"effort": "low" if effort == "minimal" else effort}
        if effort == "high":
            # Deeper reasoning: let the model decide when and how much to think.
            payload["thinking"] = {"type": "adaptive"}
    return payload


def _anthropic_message(message: dict[str, Any]) -> dict[str, Any] | None:
    """One OpenAI-shape chat message translated to the Anthropic dialect.

    Assistant tool calls become tool_use blocks and tool results become
    tool_result blocks so multi-round agent loops run identically on direct
    Anthropic providers.
    """
    role = message.get("role") or "user"
    content = message.get("content")
    if role == "tool":
        return {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": str(message.get("tool_call_id") or ""),
                    "content": str(content or ""),
                }
            ],
        }
    if role == "assistant":
        tool_calls = message.get("tool_calls")
        if isinstance(tool_calls, list) and tool_calls:
            blocks: list[dict[str, Any]] = []
            if isinstance(content, str) and content:
                blocks.append({"type": "text", "text": content})
            for call in tool_calls:
                if not isinstance(call, dict):
                    continue
                function = call.get("function") or {}
                try:
                    parsed_input = json.loads(function.get("arguments") or "{}")
                except json.JSONDecodeError:
                    parsed_input = {}
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": str(call.get("id") or ""),
                        "name": str(function.get("name") or ""),
                        "input": parsed_input if isinstance(parsed_input, dict) else {},
                    }
                )
            return {"role": "assistant", "content": blocks}
        return {"role": "assistant", "content": str(content or "")}
    return {"role": "user", "content": _anthropic_user_content(content)}


def _anthropic_user_content(content: Any) -> str | list[dict[str, Any]]:
    """User content translated part-by-part to the Anthropic dialect.

    OpenAI-shape image_url parts (the platform attaches uploaded images as
    base64 data URLs) become Anthropic image source blocks; text parts map
    one-to-one; already-Anthropic-shaped blocks pass through unchanged.
    """
    if not isinstance(content, list):
        return str(content or "")
    blocks: list[dict[str, Any]] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        part_type = part.get("type")
        if part_type == "text":
            text = str(part.get("text") or "")
            if text:
                blocks.append({"type": "text", "text": text})
        elif part_type == "image_url":
            raw = part.get("image_url")
            url = str((raw or {}).get("url") or "") if isinstance(raw, dict) else str(raw or "")
            block = _anthropic_image_block(url)
            if block is not None:
                blocks.append(block)
        else:
            blocks.append(part)
    return blocks or ""


_IMAGE_DATA_URL = re.compile(r"^data:(?P<media>[^;,]+);base64,(?P<data>.+)$", re.DOTALL)


def _anthropic_image_block(url: str) -> dict[str, Any] | None:
    if not url:
        return None
    match = _IMAGE_DATA_URL.match(url)
    if match:
        return {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": match.group("media").strip().lower(),
                "data": match.group("data"),
            },
        }
    if url.startswith(("http://", "https://")):
        return {"type": "image", "source": {"type": "url", "url": url}}
    return None


def _anthropic_tool(tool: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(tool, dict):
        return None
    function = tool.get("function") if tool.get("type") == "function" else tool
    if not isinstance(function, dict):
        return None
    name = str(function.get("name") or "").strip()
    if not name:
        return None
    parameters = function.get("parameters")
    return {
        "name": name,
        "description": str(function.get("description") or ""),
        "input_schema": parameters
        if isinstance(parameters, dict)
        else {"type": "object", "properties": {}},
    }


def _anthropic_tool_choice(tool_choice: str | dict[str, Any] | None) -> dict[str, Any] | None:
    if tool_choice is None:
        return None
    if isinstance(tool_choice, str):
        mapped = {"auto": "auto", "none": "none", "required": "any"}.get(tool_choice)
        return {"type": mapped} if mapped else None
    function = tool_choice.get("function") if isinstance(tool_choice, dict) else None
    name = str((function or {}).get("name") or "").strip()
    if name:
        return {"type": "tool", "name": name}
    return None


def _translate_anthropic_response(
    payload: dict[str, Any], route: ModelGatewayRoute
) -> dict[str, Any]:
    content_parts = payload.get("content") or []
    text = ""
    tool_calls: list[dict[str, Any]] = []
    if isinstance(content_parts, list):
        for part in content_parts:
            if not isinstance(part, dict):
                continue
            if part.get("type") in {None, "text"}:
                text += str(part.get("text") or "")
            elif part.get("type") == "tool_use":
                tool_calls.append(
                    {
                        "id": str(part.get("id") or ""),
                        "type": "function",
                        "function": {
                            "name": str(part.get("name") or ""),
                            "arguments": json.dumps(
                                part.get("input") if isinstance(part.get("input"), dict) else {}
                            ),
                        },
                    }
                )
    usage = payload.get("usage") or {}
    input_tokens = int(usage.get("input_tokens") or 0)
    output_tokens = int(usage.get("output_tokens") or 0)
    message: dict[str, Any] = {"role": "assistant", "content": text}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return {
        "id": payload.get("id"),
        "model": route.upstream_model,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": _openai_finish_reason(payload.get("stop_reason")),
            }
        ],
        "usage": {
            "prompt_tokens": input_tokens,
            "completion_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
        },
    }


def _supports_minimal_effort(upstream_model_id: str | None) -> bool:
    """Only the GPT-5 family accepts "minimal" natively on direct OpenAI
    dialects; everything else degrades to "low" (OpenRouter normalizes
    per-provider itself, so this gate only applies off-OpenRouter)."""
    tail = (upstream_model_id or "").strip().lower().rsplit("/", 1)[-1]
    return "gpt-5" in tail


def _apply_reasoning_effort(payload: dict[str, Any], route: ModelGatewayRoute) -> None:
    """Translate the app-level reasoning_effort into the provider's dialect.

    The parameter is dropped entirely for models without reasoning control so
    non-reasoning upstreams (e.g. gpt-4o) never see a parameter they reject.
    "minimal" is the fast path: the smallest reasoning spend the model
    supports, plus throughput-priority provider routing on OpenRouter.
    """
    effort = payload.pop("reasoning_effort", None)
    if not isinstance(effort, str) or not effort:
        return
    if not supports_reasoning_effort(route.upstream_model, route.supported_parameters):
        return
    if _provider_kind(route.provider_kind) == "openrouter":
        # OpenRouter's unified reasoning parameter, normalized per provider
        # (live-verified: "minimal" accepted for both OpenAI and Anthropic
        # upstreams; Anthropic maps it to its smallest thinking budget).
        # xAI documents only low/high effort, so the fast path sends the
        # smallest level Grok supports instead of trusting normalization.
        fast_path = effort == "minimal"
        tail = (route.upstream_model or "").strip().lower().rsplit("/", 1)[-1]
        if fast_path and tail.startswith("grok-"):
            effort = "low"
        payload["reasoning"] = {"effort": effort}
        if fast_path:
            # Fast mode also prefers the highest-throughput provider for
            # multi-provider models instead of the default price-led routing.
            payload.setdefault("provider", {})["sort"] = "throughput"
    else:
        # Direct xAI rejects reasoning_effort on its always-reasoning Grok 4
        # family (only OpenRouter's unified parameter normalizes it), so on
        # the native API effort rides only on catalog-confirmed support.
        if (
            _provider_kind(route.provider_kind) in {"xai", "grok"}
            and "reasoning_effort" not in route.supported_parameters
        ):
            return
        if effort == "minimal" and not _supports_minimal_effort(route.upstream_model):
            effort = "low"
        payload["reasoning_effort"] = effort


def _apply_completion_token_budget(
    payload: dict[str, Any],
    route: ModelGatewayRoute,
    max_tokens: int | None,
) -> None:
    param = _completion_token_parameter(route)
    payload[param] = _completion_token_budget(route, max_tokens)


def _completion_token_budget(route: ModelGatewayRoute, max_tokens: int | None) -> int:
    if max_tokens is not None:
        return max(256, int(max_tokens))
    configured = route.auth_metadata.get("max_completion_tokens") or route.auth_metadata.get(
        "max_tokens"
    )
    if configured is not None:
        try:
            return max(256, int(configured))
        except (TypeError, ValueError):
            pass
    return DEFAULT_COMPLETION_TOKEN_BUDGET


def _completion_token_parameter(route: ModelGatewayRoute) -> str:
    configured = str(
        route.auth_metadata.get("max_tokens_param")
        or route.auth_metadata.get("completion_token_parameter")
        or ""
    ).strip()
    if configured in {"max_tokens", "max_completion_tokens"}:
        return configured
    kind = _provider_kind(route.provider_kind)
    if kind == "openai":
        return "max_completion_tokens"
    return "max_tokens"


_STREAM_DONE = object()

# Marker yielded by the dialect event translators (Anthropic Messages, OpenAI
# Responses) for upstream pings/progress events so text streams can surface
# keep-alives while chunk streams drop them.
_DIALECT_KEEPALIVE = object()


def _parse_openai_stream_chunk(line: str) -> Any:
    """Parsed SSE chunk dict, _STREAM_DONE, or None for non-data lines."""
    if not line or not line.startswith("data:"):
        return None
    data = line[len("data:") :].strip()
    if data == "[DONE]":
        return _STREAM_DONE
    try:
        return json.loads(data)
    except json.JSONDecodeError:
        return None


def _openai_stream_annotations(chunk: dict[str, Any]) -> list[dict[str, Any]]:
    """Collect provider citation annotations without coupling them to text deltas."""

    containers: list[object] = [chunk]
    choices = chunk.get("choices")
    if isinstance(choices, list):
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            containers.extend((choice, choice.get("delta"), choice.get("message")))

    annotations: list[dict[str, Any]] = []
    for container in containers:
        if not isinstance(container, dict):
            continue
        raw_annotations = container.get("annotations")
        if not isinstance(raw_annotations, list):
            continue
        annotations.extend(
            dict(annotation) for annotation in raw_annotations if isinstance(annotation, dict)
        )
    return annotations


def _provider_kind(kind: str) -> str:
    return kind.strip().lower()


def _route_dialect(route: ModelGatewayRoute) -> str:
    return provider_dialect(route.provider_kind, route.auth_metadata)


def get_model_gateway_client() -> ModelGatewayClient:
    return ModelGatewayClient(timeout=get_settings().model_gateway_timeout_seconds)
