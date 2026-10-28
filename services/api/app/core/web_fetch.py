"""Bounded, SSRF-guarded extraction for operator- or user-supplied web URLs."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePosixPath
from urllib.parse import unquote, urlsplit

import httpx

from app.core.html_extract import HtmlPage, PageLink, SearchForm, parse_html
from app.core.knowledge_ingestion import decode_text, extract_text, is_html_source
from app.core.net_guard import REDIRECT_GUARD_HOOKS, EgressBlocked, validate_public_url

MAX_WEB_FETCH_BYTES = 5 * 1024 * 1024
MAX_WEB_FETCH_CHARS = 500_000
DEFAULT_USER_AGENT = "ApertureChat-WebFetcher/0.1"


@dataclass(frozen=True, slots=True)
class FetchedResource:
    """Raw bytes of one guarded GET, including error statuses."""

    requested_url: str
    final_url: str
    status_code: int
    content_type: str
    content: bytes


@dataclass(frozen=True, slots=True)
class FetchedWebSource:
    requested_url: str
    final_url: str
    filename: str
    content_type: str
    text: str
    byte_count: int
    # HTML pages only; other content types leave these empty.
    title: str = ""
    description: str = ""
    site_name: str = ""
    links: tuple[PageLink, ...] = ()
    search_form: SearchForm | None = None


class WebFetchError(RuntimeError):
    """Safe, HTTP-shaped failure returned by the shared web fetcher."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def fetch_web_resource(
    url: str,
    *,
    max_bytes: int = MAX_WEB_FETCH_BYTES,
    timeout_seconds: float = 10.0,
    user_agent: str = DEFAULT_USER_AGENT,
    transport: httpx.BaseTransport | None = None,
    read_error_body: bool = True,
) -> FetchedResource:
    """GET one public URL into a bounded buffer and return its status and bytes.

    Every redirect hop passes through the shared egress guard. HTTP error
    statuses are returned rather than raised so callers such as robots.txt
    readers can tell "missing" from "server error"; with ``read_error_body``
    off, an error response's body is not read at all.
    """

    requested_url = (url or "").strip()
    safe_label = _safe_url_label(requested_url)
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
                skip_body = response.status_code >= 400 and not read_error_body
                content = b"" if skip_body else _read_bounded(response, max(1, max_bytes), safe_label)
                return FetchedResource(
                    requested_url=requested_url,
                    final_url=str(response.url),
                    status_code=response.status_code,
                    content_type=(response.headers.get("content-type") or "").split(";", 1)[0].strip(),
                    content=content,
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


def fetch_web_source(
    url: str,
    *,
    max_bytes: int = MAX_WEB_FETCH_BYTES,
    max_chars: int = MAX_WEB_FETCH_CHARS,
    timeout_seconds: float = 10.0,
    user_agent: str = DEFAULT_USER_AGENT,
    transport: httpx.BaseTransport | None = None,
) -> FetchedWebSource:
    """Fetch one public URL and return bounded extracted text.

    The response is streamed into a bounded buffer so a missing or dishonest
    Content-Length cannot make an ad-hoc chat fetch consume unbounded memory.
    HTML responses also report their title, description, links, and search form.
    """

    resource = fetch_web_resource(
        url,
        max_bytes=max_bytes,
        timeout_seconds=timeout_seconds,
        user_agent=user_agent,
        transport=transport,
        read_error_body=False,
    )
    safe_label = _safe_url_label(resource.requested_url)
    if resource.status_code >= 400:
        raise WebFetchError(
            502,
            f"Web source fetch failed for {safe_label}: HTTP {resource.status_code}.",
        )
    filename = _source_filename(resource.final_url)
    content_type = resource.content_type
    text = extract_text(
        filename,
        resource.content,
        mime_type=content_type or None,
        max_chars=max(1, max_chars),
    )
    if not text or not text.strip():
        raise WebFetchError(
            422,
            f"Fetched {safe_label} but no indexable text could be extracted "
            f"(content type '{content_type or 'unknown'}').",
        )
    page = (
        parse_html(decode_text(resource.content), base_url=resource.final_url)
        if is_html_source(filename, content_type or None)
        else HtmlPage()
    )
    return FetchedWebSource(
        requested_url=resource.requested_url,
        final_url=resource.final_url,
        filename=filename,
        content_type=content_type,
        text=text,
        byte_count=len(resource.content),
        title=page.title,
        description=page.description,
        site_name=page.site_name,
        links=page.links,
        search_form=page.search_form,
    )


def _read_bounded(response: httpx.Response, max_bytes: int, safe_label: str) -> bytes:
    declared_length = _content_length(response)
    if declared_length is not None and declared_length > max_bytes:
        raise WebFetchError(
            413,
            f"Web source at {safe_label} exceeds the {max_bytes}-byte fetch limit.",
        )
    content = bytearray()
    for part in response.iter_bytes():
        content.extend(part)
        if len(content) > max_bytes:
            raise WebFetchError(
                413,
                f"Web source at {safe_label} exceeds the {max_bytes}-byte fetch limit.",
            )
    return bytes(content)


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
