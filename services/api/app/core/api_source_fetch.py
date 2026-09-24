"""Fetch and flatten data from an API knowledge source.

An API source is a single HTTP request (GET or POST) against a public endpoint
with an optional credential. The response is converted into readable text so
it can be chunked and searched like any other knowledge document. Every request
passes the shared egress guard, redirects are refused (a redirect could carry a
credential header to another host), and the body is read into a bounded
buffer.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from app.core.knowledge_ingestion import extract_text
from app.core.net_guard import EgressBlocked, validate_public_url

MAX_API_FETCH_BYTES = 10 * 1024 * 1024
MAX_API_FETCH_CHARS = 2_000_000
MAX_JSON_LINES = 200_000
ALLOWED_METHODS = frozenset({"GET", "POST"})
# Headers the client must not override: hop-by-hop, framing, or identity.
_RESERVED_HEADERS = frozenset(
    {"host", "content-length", "transfer-encoding", "connection", "cookie", "upgrade"}
)
_HEADER_NAME = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$")


class ApiSourceError(RuntimeError):
    """Safe, HTTP-shaped failure for an API source request."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True, slots=True)
class ApiSourceRequest:
    base_url: str
    path: str = ""
    method: str = "GET"
    headers: dict[str, str] = field(default_factory=dict)
    body: str | None = None
    # Credential placement. ``query`` credentials are added to the request but
    # never to the stored or displayed URL.
    credential_header: tuple[str, str] | None = None
    credential_query: tuple[str, str] | None = None


@dataclass(frozen=True, slots=True)
class FetchedApiSource:
    display_url: str
    content_type: str
    text: str
    byte_count: int
    truncated: bool


def build_api_url(base_url: str, path: str = "") -> str:
    """Join a base URL and an optional path or query suffix."""
    base = (base_url or "").strip()
    suffix = (path or "").strip()
    if not suffix:
        return base
    if suffix.startswith(("http://", "https://")):
        return suffix
    if suffix.startswith("?"):
        return f"{base}{'&' if '?' in base else '?'}{suffix[1:]}"
    return f"{base.rstrip('/')}/{suffix.lstrip('/')}"


def parse_header_lines(value: str | None) -> dict[str, str]:
    """Parse ``Name: value`` lines into request headers, rejecting unsafe names."""
    headers: dict[str, str] = {}
    for raw_line in (value or "").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        name, separator, header_value = line.partition(":")
        name = name.strip()
        if not separator or not _HEADER_NAME.match(name):
            raise ApiSourceError(400, f"Header line '{line[:60]}' must look like 'Name: value'.")
        if name.lower() in _RESERVED_HEADERS:
            raise ApiSourceError(400, f"The {name} header is set automatically and can't be overridden.")
        cleaned_value = header_value.strip()
        if "\r" in cleaned_value or "\n" in cleaned_value:
            raise ApiSourceError(400, f"Header {name} contains a line break.")
        headers[name] = cleaned_value
    return headers


def fetch_api_source(
    request: ApiSourceRequest,
    *,
    max_bytes: int = MAX_API_FETCH_BYTES,
    max_chars: int = MAX_API_FETCH_CHARS,
    timeout_seconds: float = 20.0,
    transport: httpx.BaseTransport | None = None,
) -> FetchedApiSource:
    method = (request.method or "GET").strip().upper()
    if method not in ALLOWED_METHODS:
        raise ApiSourceError(400, "API sources support GET and POST requests.")
    url = build_api_url(request.base_url, request.path)
    display_url = _display_url(url)
    try:
        validate_public_url(url)
    except EgressBlocked as exc:
        raise ApiSourceError(400, f"API URL is not permitted: {exc}") from exc

    headers = {"Accept": "application/json, text/plain;q=0.9, */*;q=0.5"}
    headers.update(request.headers)
    if request.credential_header is not None:
        headers[request.credential_header[0]] = request.credential_header[1]
    params: list[tuple[str, str]] = []
    if request.credential_query is not None:
        params.append(request.credential_query)
    content: bytes | None = None
    if method == "POST" and request.body:
        content = request.body.encode("utf-8")
        headers.setdefault("Content-Type", "application/json")

    safe_max_bytes = max(1, max_bytes)
    try:
        with httpx.Client(timeout=timeout_seconds, follow_redirects=False, transport=transport) as client:
            with client.stream(
                method,
                url,
                headers=headers,
                params=params or None,
                content=content,
            ) as response:
                if 300 <= response.status_code < 400:
                    location = response.headers.get("location") or "another address"
                    raise ApiSourceError(
                        502,
                        f"{display_url} redirected to {_display_url(location)}. "
                        "Use the final address as the API URL.",
                    )
                if response.status_code >= 400:
                    response.read()
                    snippet = _error_snippet(response.text)
                    raise ApiSourceError(
                        502,
                        f"{display_url} returned HTTP {response.status_code}"
                        + (f": {snippet}" if snippet else "."),
                    )
                body = bytearray()
                for part in response.iter_bytes():
                    body.extend(part)
                    if len(body) > safe_max_bytes:
                        raise ApiSourceError(
                            413,
                            f"The response from {display_url} is larger than "
                            f"{safe_max_bytes // (1024 * 1024)} MB.",
                        )
                content_type = (response.headers.get("content-type") or "").split(";", 1)[0].strip()
    except ApiSourceError:
        raise
    except EgressBlocked as exc:
        raise ApiSourceError(400, f"API URL is not permitted: {exc}") from exc
    except httpx.HTTPError as exc:
        raise ApiSourceError(502, f"Could not reach {display_url}: {exc}") from exc

    text, truncated = response_text(bytes(body), content_type, url, max_chars=max_chars)
    if not text.strip():
        raise ApiSourceError(
            422,
            f"{display_url} responded, but the response had no readable text "
            f"(content type '{content_type or 'unknown'}').",
        )
    return FetchedApiSource(
        display_url=display_url,
        content_type=content_type,
        text=text,
        byte_count=len(body),
        truncated=truncated,
    )


def response_text(
    body: bytes,
    content_type: str,
    url: str,
    *,
    max_chars: int = MAX_API_FETCH_CHARS,
) -> tuple[str, bool]:
    """Turn an API response into searchable text; returns (text, truncated)."""
    looks_json = content_type.endswith("json") or content_type.endswith("+json")
    if looks_json or (not content_type and body.lstrip()[:1] in (b"{", b"[")):
        try:
            payload = json.loads(body.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            payload = None
        if payload is not None:
            text = json_to_text(payload)
            return text[:max_chars], len(text) > max_chars
    filename = PurePosixPath(urlsplit(url).path).name or "api-response.txt"
    text = extract_text(filename, body, mime_type=content_type or None, max_chars=max_chars) or ""
    return text, len(text) >= max_chars


def json_to_text(value: Any) -> str:
    """Flatten JSON into ``path: value`` lines, one paragraph per list record.

    Paragraph breaks between records let the chunker keep each record intact,
    so a search hit carries a whole record rather than a fragment of several.
    """
    lines: list[str] = []

    def emit(prefix: str, item: Any) -> None:
        if len(lines) >= MAX_JSON_LINES:
            return
        if isinstance(item, dict):
            if not item:
                return
            for key, child in item.items():
                emit(f"{prefix}.{key}" if prefix else str(key), child)
        elif isinstance(item, list):
            scalar_items = [child for child in item if not isinstance(child, (dict, list))]
            if len(scalar_items) == len(item):
                if item:
                    lines.append(f"{prefix}: {', '.join(_scalar(child) for child in item)}")
                return
            for index, child in enumerate(item):
                emit(f"{prefix}[{index}]" if prefix else f"[{index}]", child)
                if isinstance(child, dict) and lines and lines[-1] != "":
                    lines.append("")
        else:
            lines.append(f"{prefix}: {_scalar(item)}" if prefix else _scalar(item))

    emit("", value)
    return "\n".join(lines).strip()


def _scalar(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _display_url(url: str) -> str:
    """Drop userinfo and fragments; query values are kept only for the path's own params."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return "the API"
    netloc = parts.hostname or ""
    if parts.port:
        netloc = f"{netloc}:{parts.port}"
    query = urlencode(
        [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True)]
    )
    return urlunsplit((parts.scheme, netloc, parts.path, query, ""))


def _error_snippet(text: str) -> str:
    cleaned = " ".join((text or "").split())
    return cleaned[:200]
