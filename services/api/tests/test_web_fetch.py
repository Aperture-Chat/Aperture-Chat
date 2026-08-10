from __future__ import annotations

import httpx
import pytest

from app.core.web_fetch import WebFetchError, fetch_web_source


def test_fetch_web_source_extracts_html_with_bounded_metadata() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["user-agent"] == "TestFetcher/1.0"
        return httpx.Response(
            200,
            headers={"content-type": "text/html; charset=utf-8"},
            content=b"<html><body><h1>Closing checklist</h1><p>Approval required.</p></body></html>",
            request=request,
        )

    result = fetch_web_source(
        "https://example.test/diligence/checklist",
        user_agent="TestFetcher/1.0",
        transport=httpx.MockTransport(handler),
    )

    assert result.filename == "checklist.html"
    assert result.content_type == "text/html"
    assert "Closing checklist" in result.text
    assert "Approval required" in result.text
    assert result.byte_count > 0


@pytest.mark.parametrize(
    ("headers", "content"),
    [
        ({"content-length": "101", "content-type": "text/plain"}, b"small"),
        ({"content-type": "text/plain"}, b"x" * 101),
    ],
)
def test_fetch_web_source_rejects_declared_or_streamed_oversize_responses(
    headers: dict[str, str],
    content: bytes,
) -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, headers=headers, content=content, request=request)
    )

    with pytest.raises(WebFetchError) as exc_info:
        fetch_web_source(
            "https://example.test/large.txt",
            max_bytes=100,
            transport=transport,
        )

    assert exc_info.value.status_code == 413
    assert "100-byte fetch limit" in exc_info.value.detail


def test_fetch_web_source_blocks_metadata_addresses_before_request() -> None:
    called = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(200, content=b"should not run", request=request)

    with pytest.raises(WebFetchError) as exc_info:
        fetch_web_source(
            "http://169.254.169.254/latest/meta-data",
            transport=httpx.MockTransport(handler),
        )

    assert exc_info.value.status_code == 400
    assert "not permitted" in exc_info.value.detail
    assert called is False


def test_fetch_web_source_revalidates_redirects() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "example.test":
            return httpx.Response(
                302,
                headers={"location": "http://169.254.169.254/latest/meta-data"},
                request=request,
            )
        return httpx.Response(200, content=b"should not run", request=request)

    with pytest.raises(WebFetchError) as exc_info:
        fetch_web_source(
            "https://example.test/redirect",
            transport=httpx.MockTransport(handler),
        )

    assert exc_info.value.status_code == 400
    assert "redirected" in exc_info.value.detail


def test_fetch_web_source_failure_does_not_echo_query_credentials() -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(500, content=b"failure", request=request)
    )

    with pytest.raises(WebFetchError) as exc_info:
        fetch_web_source(
            "https://example.test/report?token=do-not-echo",
            transport=transport,
        )

    assert exc_info.value.status_code == 502
    assert "do-not-echo" not in exc_info.value.detail
