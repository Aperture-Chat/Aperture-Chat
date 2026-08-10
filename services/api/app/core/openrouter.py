"""Thin OpenRouter client for the Aperture model gateway.

The OpenRouter API key is server-side only. It is sent solely in the upstream
``Authorization`` header and is never returned to callers, written to logs, or
stored in audit metadata.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from typing import Any

import httpx

from app.core.config import Settings, get_settings

logger = logging.getLogger("aperture.openrouter")

DEFAULT_TIMEOUT_SECONDS = 60.0

# Maps Aperture's app-level model ids to OpenRouter "provider/model" ids.
_MODEL_MAP: dict[str, str] = {
    "gpt-4o": "openai/gpt-4o",
    "gpt-4o-mini": "openai/gpt-4o-mini",
    "gpt-4.1": "openai/gpt-4.1",
    "o3-mini": "openai/o3-mini",
}


class OpenRouterError(RuntimeError):
    """Raised when the OpenRouter upstream call fails or returns bad data."""


def map_model(model_id: str, _default_model: str | None = None) -> str:
    """Translate an incoming model id into an OpenRouter model id.

    Known app ids map to their OpenRouter equivalents. Ids that already look like
    OpenRouter ids (``provider/model``) pass through unchanged. Unknown local ids
    and tenant aliases fail closed: a caller's selected model is a routing
    contract and must never be replaced by the deployment default. The optional
    second argument is accepted only for compatibility with older internal
    callers; it is deliberately never used as a fallback.
    """

    normalized = model_id.strip()
    if normalized in _MODEL_MAP:
        return _MODEL_MAP[normalized]
    if "/" in normalized:
        return normalized
    raise ValueError(f"Unknown OpenRouter model id '{model_id}'.")


class OpenRouterClient:
    def __init__(
        self,
        *,
        api_key: str | None,
        base_url: str,
        app_title: str,
        app_referer: str,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._app_title = app_title
        self._app_referer = app_referer
        self._timeout = timeout
        # `transport` is an injection seam for tests (httpx.MockTransport);
        # production leaves it None so httpx uses its default network transport.
        self._transport = transport

    @property
    def configured(self) -> bool:
        """True when an API key is present and a real call can be attempted."""

        return bool(self._api_key)

    def _headers(self) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        # OpenRouter attribution headers (optional, non-secret).
        if self._app_referer:
            headers["HTTP-Referer"] = self._app_referer
        if self._app_title:
            headers["X-Title"] = self._app_title
        return headers

    def complete(self, *, model: str, messages: list[dict[str, str]]) -> dict[str, Any]:
        """Non-streaming chat completion. Returns the raw OpenRouter JSON body."""

        url = f"{self._base_url}/chat/completions"
        payload = {"model": model, "messages": messages, "stream": False}
        try:
            with httpx.Client(timeout=self._timeout, transport=self._transport) as client:
                response = client.post(url, headers=self._headers(), json=payload)
                response.raise_for_status()
                return response.json()
        except httpx.HTTPStatusError as exc:
            # Note: never include headers/key; status code + reason only.
            raise OpenRouterError(f"OpenRouter returned HTTP {exc.response.status_code}") from exc
        except httpx.HTTPError as exc:
            raise OpenRouterError(f"OpenRouter request failed: {type(exc).__name__}") from exc

    def stream(self, *, model: str, messages: list[dict[str, str]]) -> Iterator[str]:
        """Streaming chat completion. Yields assistant text deltas as they arrive."""

        url = f"{self._base_url}/chat/completions"
        payload = {"model": model, "messages": messages, "stream": True}
        try:
            with httpx.Client(timeout=self._timeout, transport=self._transport) as client:
                with client.stream("POST", url, headers=self._headers(), json=payload) as response:
                    response.raise_for_status()
                    for line in response.iter_lines():
                        delta = _parse_stream_line(line)
                        if delta is _STREAM_DONE:
                            return
                        if delta:
                            yield delta
        except httpx.HTTPStatusError as exc:
            raise OpenRouterError(f"OpenRouter returned HTTP {exc.response.status_code}") from exc
        except httpx.HTTPError as exc:
            raise OpenRouterError(f"OpenRouter stream failed: {type(exc).__name__}") from exc


_STREAM_DONE = object()


def _parse_stream_line(line: str) -> Any:
    """Parse a single OpenRouter SSE line into a delta string.

    Returns the text delta, ``None`` for lines to skip (comments, keep-alives,
    empty deltas), or the ``_STREAM_DONE`` sentinel on ``data: [DONE]``.
    """

    if not line or not line.startswith("data:"):
        return None
    data = line[len("data:") :].strip()
    if data == "[DONE]":
        return _STREAM_DONE
    try:
        chunk = json.loads(data)
    except json.JSONDecodeError:
        return None
    choices = chunk.get("choices") or []
    if not choices:
        return None
    return (choices[0].get("delta") or {}).get("content")


def build_client(settings: Settings) -> OpenRouterClient:
    return OpenRouterClient(
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
        app_title=settings.openrouter_app_title,
        app_referer=settings.openrouter_app_referer,
    )


def get_openrouter_client() -> OpenRouterClient:
    """Build a client from current settings. Cheap; httpx connections are per-call."""

    return build_client(get_settings())
