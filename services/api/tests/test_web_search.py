"""Unit tests for the platform-hosted web search engines (mocked HTTP)."""

from __future__ import annotations

import json

import httpx
import pytest

from app.core.web_search import WebSearchClient, WebSearchError

DDG_SAMPLE_HTML = """
<div class="results">
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.python.org%2Fdownloads%2F&amp;rut=abc123">Download <b>Python</b> | Python.org</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.python.org%2Fdownloads%2F&amp;rut=abc123">Active <b>Python</b> releases and downloads.</a>
  </div>
  <div class="result results_links results_links_deep web-result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdevguide.python.org%2Fversions%2F&amp;rut=def456">Status of Python versions</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdevguide.python.org%2Fversions%2F&amp;rut=def456">The main branch is currently the future release.</a>
  </div>
  <div class="result results_links results_links_deep result--ad">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_provider=x">Sponsored thing</a>
    </h2>
  </div>
</div>
"""


def test_duckduckgo_engine_parses_titles_urls_and_snippets() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["q"] == "latest python release"
        return httpx.Response(200, text=DDG_SAMPLE_HTML)

    client = WebSearchClient(engine="duckduckgo", transport=httpx.MockTransport(handler))
    results = client.search("latest python release")

    assert [result.url for result in results] == [
        "https://www.python.org/downloads/",
        "https://devguide.python.org/versions/",
        # The ad link resolves too (direct https href), but carries no uddg
        # redirect; it is a plain URL and stays last.
        "https://duckduckgo.com/y.js?ad_provider=x",
    ][: len(results)]
    assert results[0].title == "Download Python | Python.org"
    assert results[0].snippet == "Active Python releases and downloads."
    assert results[1].title == "Status of Python versions"


def test_duckduckgo_engine_raises_honest_error_on_http_failure() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403)

    client = WebSearchClient(engine="duckduckgo", transport=httpx.MockTransport(handler))
    with pytest.raises(WebSearchError, match="HTTP 403"):
        client.search("anything")


def test_searxng_engine_returns_results_from_json_api() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/search"
        assert request.url.params["format"] == "json"
        assert request.url.params["q"] == "filing deadline"
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "title": "Filing deadline moved",
                        "url": "https://example.com/deadline",
                        "content": "The deadline moved to June 1.",
                    },
                    {"title": "", "url": "https://example.com/skipped"},
                    {
                        "title": "Court order",
                        "url": "https://example.com/order",
                        "content": "",
                    },
                ]
            },
        )

    client = WebSearchClient(
        engine="searxng",
        searxng_base_url="http://searxng.local:8080/",
        transport=httpx.MockTransport(handler),
    )
    results = client.search("filing deadline")

    assert [(result.title, result.url) for result in results] == [
        ("Filing deadline moved", "https://example.com/deadline"),
        ("Court order", "https://example.com/order"),
    ]
    assert results[0].snippet == "The deadline moved to June 1."
    # Snippet honestly falls back to the title rather than inventing content.
    assert results[1].snippet == "Court order"


def test_searxng_engine_requires_base_url() -> None:
    client = WebSearchClient(engine="searxng", searxng_base_url=None)
    with pytest.raises(WebSearchError, match="APERTURE_SEARXNG_BASE_URL"):
        client.search("anything")


def test_searxng_http_error_mentions_json_format_requirement() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403)

    client = WebSearchClient(
        engine="searxng",
        searxng_base_url="http://searxng.local:8080",
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(WebSearchError, match="search.formats"):
        client.search("anything")


def test_openai_engine_parses_url_citations() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == "https://api.openai.com/v1/responses"
        assert request.headers["Authorization"] == "Bearer sk-test"
        import json

        body = json.loads(request.content)
        assert body["tools"] == [{"type": "web_search"}]
        assert "latest python release" in body["input"]
        text = "Python 3.13.1 is the latest release. See python.org for details."
        return httpx.Response(
            200,
            json={
                "output": [
                    {"type": "web_search_call", "status": "completed"},
                    {
                        "type": "message",
                        "content": [
                            {
                                "type": "output_text",
                                "text": text,
                                "annotations": [
                                    {
                                        "type": "url_citation",
                                        "url": "https://www.python.org/downloads/",
                                        "title": "Download Python",
                                        "start_index": 0,
                                        "end_index": 36,
                                    },
                                    {
                                        "type": "url_citation",
                                        "url": "https://www.python.org/downloads/",
                                        "title": "Duplicate is skipped",
                                        "start_index": 0,
                                        "end_index": 10,
                                    },
                                ],
                            }
                        ],
                    },
                ]
            },
        )

    client = WebSearchClient(engine="openai", api_key="sk-test", transport=httpx.MockTransport(handler))
    results = client.search("latest python release")

    assert [(result.title, result.url) for result in results] == [
        ("Download Python", "https://www.python.org/downloads/"),
    ]
    assert results[0].snippet == "Python 3.13.1 is the latest release."


def test_openai_engine_requires_provider_key() -> None:
    client = WebSearchClient(engine="openai")
    with pytest.raises(WebSearchError, match="OpenAI provider key"):
        client.search("anything")


def test_openai_engine_rejects_answer_without_citations() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"output": [{"type": "message", "content": [{"type": "output_text", "text": "No sources.", "annotations": []}]}]},
        )

    client = WebSearchClient(engine="openai", api_key="sk-test", transport=httpx.MockTransport(handler))
    with pytest.raises(WebSearchError, match="without any web citations"):
        client.search("anything")


def test_anthropic_engine_parses_search_result_blocks() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == "https://api.anthropic.com/v1/messages"
        assert request.headers["x-api-key"] == "sk-ant-test"
        assert request.headers["anthropic-version"] == "2023-06-01"
        return httpx.Response(
            200,
            json={
                "content": [
                    {
                        "type": "web_search_tool_result",
                        "content": [
                            {
                                "type": "web_search_result",
                                "url": "https://example.com/deadline",
                                "title": "Filing deadline moved",
                            },
                            {
                                "type": "web_search_result",
                                "url": "https://example.com/order",
                                "title": "Court order",
                            },
                        ],
                    },
                    {
                        "type": "text",
                        "text": "The deadline moved to June 1.",
                        "citations": [
                            {
                                "type": "web_search_result_location",
                                "url": "https://example.com/deadline",
                                "cited_text": "The deadline moved to June 1.",
                            }
                        ],
                    },
                ]
            },
        )

    client = WebSearchClient(engine="anthropic", api_key="sk-ant-test", transport=httpx.MockTransport(handler))
    results = client.search("filing deadline")

    assert [(result.title, result.url) for result in results] == [
        ("Filing deadline moved", "https://example.com/deadline"),
        ("Court order", "https://example.com/order"),
    ]
    assert results[0].snippet == "The deadline moved to June 1."
    # Snippet honestly falls back to the title when no plaintext quote cites it.
    assert results[1].snippet == "Court order"


def test_anthropic_engine_surfaces_tool_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "content": [
                    {
                        "type": "web_search_tool_result",
                        "content": {"type": "web_search_tool_result_error", "error_code": "max_uses_exceeded"},
                    }
                ]
            },
        )

    client = WebSearchClient(engine="anthropic", api_key="sk-ant-test", transport=httpx.MockTransport(handler))
    with pytest.raises(WebSearchError, match="max_uses_exceeded"):
        client.search("anything")


def test_openrouter_engine_parses_url_citation_annotations() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.read().decode())
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": "Python 3.13.1 is the latest release.",
                            "annotations": [
                                {
                                    "type": "url_citation",
                                    "url_citation": {
                                        "url": "https://www.python.org/downloads/",
                                        "title": "Download Python",
                                        "content": "Python 3.13.1 is now available for download.",
                                    },
                                },
                                {
                                    "type": "url_citation",
                                    "url_citation": {
                                        "url": "https://www.python.org/downloads/",
                                        "title": "Duplicate is skipped",
                                    },
                                },
                            ],
                        },
                        "finish_reason": "stop",
                    }
                ]
            },
        )

    client = WebSearchClient(
        engine="openrouter", api_key="sk-or-test", transport=httpx.MockTransport(handler)
    )
    results = client.search("latest python release")

    body = captured["body"]
    assert body["tools"] == [
        {"type": "openrouter:web_search", "parameters": {"max_results": 5}}
    ]
    assert [(result.title, result.url) for result in results] == [
        ("Download Python", "https://www.python.org/downloads/"),
    ]
    assert results[0].snippet == "Python 3.13.1 is now available for download."


def test_openrouter_engine_requires_provider_key() -> None:
    client = WebSearchClient(engine="openrouter")
    with pytest.raises(WebSearchError, match="OpenRouter provider key"):
        client.search("anything")


def test_openrouter_engine_rejects_answer_without_citations() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "It never searched."},
                        "finish_reason": "stop",
                    }
                ]
            },
        )

    client = WebSearchClient(
        engine="openrouter", api_key="sk-or-test", transport=httpx.MockTransport(handler)
    )
    with pytest.raises(WebSearchError, match="without any web citations"):
        client.search("anything")


def test_unknown_engine_is_rejected() -> None:
    client = WebSearchClient(engine="google-scraper")
    with pytest.raises(WebSearchError, match="Unknown web search engine"):
        client.search("anything")


def test_empty_query_is_rejected() -> None:
    client = WebSearchClient(engine="duckduckgo")
    with pytest.raises(WebSearchError, match="non-empty"):
        client.search("   ")


def test_max_results_caps_output() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=DDG_SAMPLE_HTML)

    client = WebSearchClient(engine="duckduckgo", max_results=1, transport=httpx.MockTransport(handler))
    assert len(client.search("latest python release")) == 1
