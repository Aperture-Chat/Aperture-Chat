"""Bounded, SSRF-guarded extraction for operator- or user-supplied web URLs."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePosixPath
from urllib.parse import unquote, urlsplit

import httpx

from app.core.knowledge_ingestion import extract_text
from app.core.net_guard import REDIRECT_GUARD_HOOKS, EgressBlocked, validate_public_url

MAX_WEB_FETCH_BYTES = 5 * 1024 * 1024
MAX_WEB_FETCH_CHARS = 500_000


@dataclass(frozen=True, slots=True)
class FetchedWebSource:
    requested_url: str
    final_url: str
    filename: str
    content_type: str
    text: str
    byte_count: int


class WebFetchError(RuntimeError):
    """Safe, HTTP-shaped failure returned by the shared web fetcher."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def fetch_web_source(
    url: str,
    *,
    max_bytes: int = MAX_WEB_FETCH_BYTES,
    max_chars: int = MAX_WEB_FETCH_CHARS,
    timeout_seconds: float = 10.0,
    user_agent: str = "ApertureChat-WebFetcher/0.1",
    transport: httpx.BaseTransport | None = None,
) -> FetchedWebSource:
    """Fetch one public URL and return bounded extracted text.

    Every redirect hop passes through the shared egress guard. The response is
    streamed into a bounded buffer so a missing or dishonest Content-Length
    cannot make an ad-hoc chat fetch consume unbounded memory.
    """

    requested_url = (url or "").strip()
    safe_label = _safe_url_label(requested_url)
    safe_max_bytes = max(1, max_bytes)
    safe_max_chars = max(1, max_chars)
    try:
        validate_public_url(requested_url)
    except EgressBlocked as exc:
        raise WebFetchError(400, f"Web source URL is not permitted: {exc}") from exc

    try:
        with httpx.Client(
            timeout=timeout_seconds,
            follow_redirects=True,
            event_hooks=REDIRECT_GUARD_HOOKS,
            transport=transport,
        ) as web_client:
            with web_client.stream(
                "GET",
                requested_url,
                headers={"User-Agent": user_agent},
            ) as response:
                if response.status_code >= 400:
                    raise WebFetchError(
                        502,
                        f"Web source fetch failed for {safe_label}: HTTP {response.status_code}.",
                    )
                declared_length = _content_length(response)
                if declared_length is not None and declared_length > safe_max_bytes:
                    raise WebFetchError(
                        413,
                        f"Web source at {safe_label} exceeds the {safe_max_bytes}-byte fetch limit.",
                    )
                content = bytearray()
                for part in response.iter_bytes():
                    content.extend(part)
                    if len(content) > safe_max_bytes:
                        raise WebFetchError(
                            413,
                            f"Web source at {safe_label} exceeds the {safe_max_bytes}-byte fetch limit.",
                        )
                final_url = str(response.url)
                content_type = (
                    (response.headers.get("content-type") or "").split(";", 1)[0].strip()
                )
    except WebFetchError:
        raise
    except EgressBlocked as exc:
        raise WebFetchError(
            400,
            "Web source URL redirected to a destination that is not permitted: "
            f"{exc}",
        ) from exc
    except httpx.HTTPError as exc:
        raise WebFetchError(
            502,
            f"Web source fetch failed for {safe_label}: {exc}",
        ) from exc

    filename = _source_filename(final_url)
    text = extract_text(
        filename,
        bytes(content),
        mime_type=content_type or None,
        max_chars=safe_max_chars,
    )
    if not text or not text.strip():
        raise WebFetchError(
            422,
            f"Fetched {safe_label} but no indexable text could be extracted "
            f"(content type '{content_type or 'unknown'}').",
        )
    return FetchedWebSource(
        requested_url=requested_url,
        final_url=final_url,
        filename=filename,
        content_type=content_type,
        text=text,
        byte_count=len(content),
    )


def _content_length(response: httpx.Response) -> int | None:
    value = (response.headers.get("content-length") or "").strip()
    if not value:
        return None
    try:
        length = int(value)
    except ValueError:
        return None
    return max(0, length)


def _source_filename(url: str) -> str:
    path = unquote(urlsplit(url).path)
    name = PurePosixPath(path).name.replace("\x00", "").strip() or "web-page.html"
    if "." not in name:
        name = f"{name}.html"
    return name


def _safe_url_label(url: str) -> str:
    parsed = urlsplit(url)
    if not parsed.scheme or not parsed.hostname:
        return "the requested URL"
    host = parsed.hostname
    if ":" in host:
        host = f"[{host}]"
    try:
        port = parsed.port
    except ValueError:
        return "the requested URL"
    if port is not None:
        host = f"{host}:{port}"
    return f"{parsed.scheme}://{host}{parsed.path or '/'}"
