"""Platform-hosted web search that works with any model provider.

Unlike OpenRouter's native web plugin (which only exists on OpenRouter
routes), this module runs the search inside Aperture itself and the results
are injected into the model prompt as runtime context — so any provider the
gateway can reach gets real web search with real citations.

Engines:
- ``searxng``: a self-hosted SearXNG instance's JSON API. Point
  ``APERTURE_WEB_SEARCH_ENGINE=searxng`` and ``APERTURE_SEARXNG_BASE_URL`` at
  the container once it exists.
- ``duckduckgo`` (default): keyless search against DuckDuckGo's HTML
  endpoint. Zero setup, so the pipeline is testable before SearXNG is
  deployed. Parsing is defensive; failures raise ``WebSearchError`` rather
  than returning fabricated results.
- ``openai``: OpenAI's hosted web search via the Responses API. Reuses the
  workspace's stored OpenAI provider key; results come from the response's
  ``url_citation`` annotations, so every result is a real cited source.
- ``anthropic``: Anthropic's hosted web search via the Messages API search
  tool. Reuses the workspace's stored Anthropic provider key; results come
  from the returned ``web_search_result`` blocks.
- ``openrouter``: OpenRouter's hosted web search via the openrouter:web_search
  server tool on a small routed model. Reuses the workspace's stored
  OpenRouter provider key; results come from ``url_citation`` annotations.
"""

from __future__ import annotations

import html as html_module
import re
from dataclasses import dataclass
from urllib.parse import parse_qs, urlparse

import httpx

from app.core.config import get_settings
from app.core.net_guard import EgressBlocked, validate_public_url

DUCKDUCKGO_HTML_URL = "https://html.duckduckgo.com/html/"
OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"

# OpenRouter's web search server tool (docs, August 2026): request field
# `tools: [{"type": "openrouter:web_search", ...}]` supersedes the deprecated
# `plugins: [{"id": "web"}]` plugin. OpenRouter executes the search on its
# side - the upstream provider's native search where one exists (Anthropic,
# OpenAI, Google, xAI), Exa otherwise - and returns the same standardized
# url_citation annotations for every model family. Because nothing is
# injected into the conversation itself, it is dialect-safe for the
# Anthropic-family upstreams that rejected the old plugin's mid-history
# system message. Shared by chat requests and automation chain steps.
OPENROUTER_WEB_SEARCH_TOOL: dict[str, object] = {
    "type": "openrouter:web_search",
    "parameters": {"max_results": 5},
}
ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages"
OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_OPENAI_SEARCH_MODEL = "gpt-4o-mini"
DEFAULT_ANTHROPIC_SEARCH_MODEL = "claude-3-5-haiku-latest"
DEFAULT_OPENROUTER_SEARCH_MODEL = "openai/gpt-4o-mini"

# Engines that ride an existing provider credential instead of their own
# secret: engine value -> provider ``kind`` whose stored key is reused.
KEYED_SEARCH_ENGINE_KINDS = {
    "openai": "openai",
    "anthropic": "anthropic",
    "openrouter": "openrouter",
}
KEYED_SEARCH_ENGINE_LABELS = {
    "openai": "OpenAI",
    "anthropic": "Anthropic",
    "openrouter": "OpenRouter",
}
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36 ApertureChat/1.0"
)

_DDG_RESULT_LINK = re.compile(
    r'class="result__a"[^>]*href="(?P<href>[^"]+)"[^>]*>(?P<title>.*?)</a>',
    re.DOTALL,
)
_DDG_RESULT_SNIPPET = re.compile(
    r'class="result__snippet"[^>]*>(?P<snippet>.*?)</a>',
    re.DOTALL,
)
_TAG = re.compile(r"<[^>]+>")


class WebSearchError(Exception):
    """Raised when a live web search cannot be completed honestly."""


@dataclass(frozen=True)
class WebSearchResult:
    title: str
    url: str
    snippet: str


class WebSearchClient:
    def __init__(
        self,
        *,
        engine: str,
        searxng_base_url: str | None = None,
        max_results: int = 5,
        timeout_seconds: float = 12.0,
        transport: httpx.BaseTransport | None = None,
        api_key: str | None = None,
    ) -> None:
        self.engine = (engine or "duckduckgo").strip().lower()
        self._searxng_base_url = (searxng_base_url or "").strip().rstrip("/") or None
        self._max_results = max(1, max_results)
        self._timeout = timeout_seconds
        self._transport = transport
        self.api_key = (api_key or "").strip() or None

    def search(self, query: str) -> list[WebSearchResult]:
        cleaned = " ".join(query.split()).strip()
        if not cleaned:
            raise WebSearchError("Web search needs a non-empty query.")
        # Search engines work best with question-sized input; long prompts are
        # truncated rather than rejected so long-form requests still search.
        cleaned = cleaned[:400]
        if self.engine == "searxng":
            return self._search_searxng(cleaned)
        if self.engine == "duckduckgo":
            return self._search_duckduckgo(cleaned)
        if self.engine == "openai":
            return self._search_openai(cleaned)
        if self.engine == "anthropic":
            return self._search_anthropic(cleaned)
        if self.engine == "openrouter":
            return self._search_openrouter(cleaned)
        raise WebSearchError(
            f"Unknown web search engine '{self.engine}'. Supported engines: "
            "searxng, duckduckgo, openai, anthropic, openrouter."
        )

    def _require_api_key(self) -> str:
        if not self.api_key:
            label = KEYED_SEARCH_ENGINE_LABELS.get(self.engine, self.engine)
            raise WebSearchError(
                f"{label} web search needs an active {label} provider key. Add one under "
                "Providers, or switch the Web Search connector to a keyless engine."
            )
        return self.api_key

    def _search_searxng(self, query: str) -> list[WebSearchResult]:
        if not self._searxng_base_url:
            raise WebSearchError(
                "SearXNG is selected as the web search engine but APERTURE_SEARXNG_BASE_URL is not set."
            )
        try:
            validate_public_url(self._searxng_base_url)
        except EgressBlocked as exc:
            raise WebSearchError(f"SearXNG URL is not reachable by egress policy: {exc}") from exc
        try:
            with httpx.Client(timeout=self._timeout, transport=self._transport) as client:
                response = client.get(
                    f"{self._searxng_base_url}/search",
                    params={"q": query, "format": "json", "safesearch": "1"},
                    headers={"User-Agent": USER_AGENT},
                )
                response.raise_for_status()
                payload = response.json()
        except httpx.HTTPStatusError as exc:
            raise WebSearchError(
                f"SearXNG returned HTTP {exc.response.status_code}. Confirm the instance allows "
                "JSON output (search.formats must include json)."
            ) from exc
        except (httpx.HTTPError, ValueError) as exc:
            raise WebSearchError(f"SearXNG request failed: {type(exc).__name__}") from exc

        raw_results = payload.get("results")
        if not isinstance(raw_results, list):
            raise WebSearchError("SearXNG response did not contain a results list.")
        results: list[WebSearchResult] = []
        for item in raw_results:
            if not isinstance(item, dict):
                continue
            url = str(item.get("url") or "").strip()
            title = " ".join(str(item.get("title") or "").split()).strip()
            snippet = " ".join(str(item.get("content") or "").split()).strip()
            if not url or not title:
                continue
            results.append(WebSearchResult(title=title, url=url, snippet=snippet or title))
            if len(results) >= self._max_results:
                break
        if not results:
            raise WebSearchError(
                "SearXNG returned no results for this query. Retry, or switch the Web "
                "Search connector to another engine."
            )
        return results

    def _search_duckduckgo(self, query: str) -> list[WebSearchResult]:
        try:
            with httpx.Client(
                timeout=self._timeout,
                transport=self._transport,
                follow_redirects=True,
            ) as client:
                response = client.get(
                    DUCKDUCKGO_HTML_URL,
                    params={"q": query},
                    headers={"User-Agent": USER_AGENT},
                )
                response.raise_for_status()
                page = response.text
        except httpx.HTTPStatusError as exc:
            raise WebSearchError(f"DuckDuckGo returned HTTP {exc.response.status_code}.") from exc
        except httpx.HTTPError as exc:
            raise WebSearchError(f"DuckDuckGo request failed: {type(exc).__name__}") from exc

        links = _DDG_RESULT_LINK.finditer(page)
        snippets = [_clean_html_fragment(match.group("snippet")) for match in _DDG_RESULT_SNIPPET.finditer(page)]
        results: list[WebSearchResult] = []
        for index, match in enumerate(links):
            url = _resolve_ddg_href(match.group("href"))
            title = _clean_html_fragment(match.group("title"))
            if not url or not title:
                continue
            snippet = snippets[index] if index < len(snippets) else ""
            results.append(WebSearchResult(title=title, url=url, snippet=snippet or title))
            if len(results) >= self._max_results:
                break
        if not results:
            # DuckDuckGo's HTML endpoint serves a bot-wall page with HTTP 200
            # when it rate-limits automated callers. Parsing that page yields
            # zero results; answering without the web while claiming search
            # ran would be a silent lie, so fail honestly instead.
            raise WebSearchError(
                "DuckDuckGo returned a page with no parseable results (it rate-limits "
                "automated queries). Retry, or switch the Web Search connector to "
                "another engine."
            )
        return results


    def _search_openai(self, query: str) -> list[WebSearchResult]:
        api_key = self._require_api_key()
        try:
            with httpx.Client(timeout=self._timeout, transport=self._transport) as client:
                response = client.post(
                    OPENAI_RESPONSES_URL,
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "User-Agent": USER_AGENT,
                    },
                    json={
                        "model": DEFAULT_OPENAI_SEARCH_MODEL,
                        "input": query,
                        "instructions": (
                            "Search the web for the user's query and answer briefly. "
                            "Cite every source you rely on."
                        ),
                        "tools": [{"type": "web_search"}],
                    },
                )
                response.raise_for_status()
                payload = response.json()
        except httpx.HTTPStatusError as exc:
            hint = " Confirm the OpenAI provider key is valid." if exc.response.status_code in (401, 403) else ""
            raise WebSearchError(
                f"OpenAI web search returned HTTP {exc.response.status_code}.{hint}"
            ) from exc
        except (httpx.HTTPError, ValueError) as exc:
            raise WebSearchError(f"OpenAI web search request failed: {type(exc).__name__}") from exc

        results: list[WebSearchResult] = []
        seen: set[str] = set()
        for item in payload.get("output") or []:
            if not isinstance(item, dict) or item.get("type") != "message":
                continue
            for part in item.get("content") or []:
                if not isinstance(part, dict) or part.get("type") != "output_text":
                    continue
                text = str(part.get("text") or "")
                for annotation in part.get("annotations") or []:
                    if not isinstance(annotation, dict) or annotation.get("type") != "url_citation":
                        continue
                    url = str(annotation.get("url") or "").strip()
                    title = " ".join(str(annotation.get("title") or "").split()).strip() or url
                    if not url or url in seen:
                        continue
                    seen.add(url)
                    end = annotation.get("end_index")
                    snippet = ""
                    if isinstance(end, int) and 0 < end <= len(text):
                        # The annotation span covers the citation link itself
                        # ("([domain](url))"), which carries no information.
                        # The claim the citation supports is the prose leading
                        # into it, so capture that sentence instead.
                        snippet = _claim_before_citation(text, end)
                    results.append(WebSearchResult(title=title, url=url, snippet=snippet or title))
                    if len(results) >= self._max_results:
                        return results
        if not results:
            raise WebSearchError(
                "OpenAI answered without any web citations, so there are no verifiable results."
            )
        return results

    def _search_anthropic(self, query: str) -> list[WebSearchResult]:
        api_key = self._require_api_key()
        try:
            with httpx.Client(timeout=self._timeout, transport=self._transport) as client:
                response = client.post(
                    ANTHROPIC_MESSAGES_URL,
                    headers={
                        "x-api-key": api_key,
                        "anthropic-version": "2023-06-01",
                        "User-Agent": USER_AGENT,
                    },
                    json={
                        "model": DEFAULT_ANTHROPIC_SEARCH_MODEL,
                        "max_tokens": 1024,
                        "messages": [
                            {
                                "role": "user",
                                "content": f"Search the web and briefly summarize current results for: {query}",
                            }
                        ],
                        "tools": [
                            {"type": "web_search_20250305", "name": "web_search", "max_uses": 1}
                        ],
                    },
                )
                response.raise_for_status()
                payload = response.json()
        except httpx.HTTPStatusError as exc:
            hint = " Confirm the Anthropic provider key is valid." if exc.response.status_code in (401, 403) else ""
            raise WebSearchError(
                f"Anthropic web search returned HTTP {exc.response.status_code}.{hint}"
            ) from exc
        except (httpx.HTTPError, ValueError) as exc:
            raise WebSearchError(f"Anthropic web search request failed: {type(exc).__name__}") from exc

        # Text blocks cite sources with plaintext quotes; the tool-result
        # blocks carry the result list itself (their content is encrypted).
        cited_text_by_url: dict[str, str] = {}
        for block in payload.get("content") or []:
            if not isinstance(block, dict) or block.get("type") != "text":
                continue
            for citation in block.get("citations") or []:
                if not isinstance(citation, dict):
                    continue
                url = str(citation.get("url") or "").strip()
                cited = " ".join(str(citation.get("cited_text") or "").split()).strip()
                if url and cited and url not in cited_text_by_url:
                    cited_text_by_url[url] = cited

        results: list[WebSearchResult] = []
        seen = set()
        for block in payload.get("content") or []:
            if not isinstance(block, dict) or block.get("type") != "web_search_tool_result":
                continue
            block_content = block.get("content")
            if isinstance(block_content, dict) and block_content.get("type") == "web_search_tool_result_error":
                raise WebSearchError(
                    f"Anthropic web search failed: {block_content.get('error_code') or 'unknown error'}."
                )
            for item in block_content if isinstance(block_content, list) else []:
                if not isinstance(item, dict) or item.get("type") != "web_search_result":
                    continue
                url = str(item.get("url") or "").strip()
                title = " ".join(str(item.get("title") or "").split()).strip() or url
                if not url or url in seen:
                    continue
                seen.add(url)
                snippet = cited_text_by_url.get(url, "")
                results.append(WebSearchResult(title=title, url=url, snippet=snippet or title))
                if len(results) >= self._max_results:
                    return results
        if not results:
            raise WebSearchError(
                "Anthropic answered without running a web search, so there are no verifiable results."
            )
        return results

    def _search_openrouter(self, query: str) -> list[WebSearchResult]:
        """One openrouter:web_search server-tool call on a small routed model.

        OpenRouter executes the search on its side and standardizes results as
        url_citation annotations, so this engine works regardless of which
        provider serves the workspace's chat models.
        """
        api_key = self._require_api_key()
        try:
            with httpx.Client(timeout=self._timeout, transport=self._transport) as client:
                response = client.post(
                    OPENROUTER_CHAT_COMPLETIONS_URL,
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "User-Agent": USER_AGENT,
                    },
                    json={
                        "model": DEFAULT_OPENROUTER_SEARCH_MODEL,
                        "messages": [
                            {
                                "role": "system",
                                "content": (
                                    "You are a web search assistant. Always call the web "
                                    "search tool for the user's query before answering, then "
                                    "answer briefly and cite every source you rely on."
                                ),
                            },
                            {"role": "user", "content": query},
                        ],
                        "tools": [
                            {
                                "type": "openrouter:web_search",
                                "parameters": {"max_results": self._max_results},
                            }
                        ],
                    },
                )
                response.raise_for_status()
                payload = response.json()
        except httpx.HTTPStatusError as exc:
            hint = (
                " Confirm the OpenRouter provider key is valid."
                if exc.response.status_code in (401, 403)
                else ""
            )
            raise WebSearchError(
                f"OpenRouter web search returned HTTP {exc.response.status_code}.{hint}"
            ) from exc
        except (httpx.HTTPError, ValueError) as exc:
            raise WebSearchError(
                f"OpenRouter web search request failed: {type(exc).__name__}"
            ) from exc

        choices = payload.get("choices") if isinstance(payload, dict) else None
        message = choices[0].get("message") if isinstance(choices, list) and choices else None
        message = message if isinstance(message, dict) else {}
        text = str(message.get("content") or "")
        results: list[WebSearchResult] = []
        seen: set[str] = set()
        for annotation in message.get("annotations") or []:
            if not isinstance(annotation, dict) or annotation.get("type") != "url_citation":
                continue
            raw = annotation.get("url_citation")
            raw = raw if isinstance(raw, dict) else annotation
            url = str(raw.get("url") or "").strip()
            title = " ".join(str(raw.get("title") or "").split()).strip() or url
            if not url or url in seen:
                continue
            seen.add(url)
            snippet = " ".join(str(raw.get("content") or "").split()).strip()
            if not snippet:
                end = raw.get("end_index")
                if isinstance(end, int) and 0 < end <= len(text):
                    snippet = _claim_before_citation(text, end)
            results.append(WebSearchResult(title=title, url=url, snippet=snippet or title))
            if len(results) >= self._max_results:
                return results
        if not results:
            raise WebSearchError(
                "OpenRouter answered without any web citations, so there are no verifiable results."
            )
        return results


def _claim_before_citation(text: str, citation_end: int, *, window: int = 400) -> str:
    """Extract the sentence a citation supports from OpenAI response text.

    Responses place ``([domain](url))`` markers directly after the statement
    they back, so the informative content is the prose ending at the marker.
    Markdown link syntax is stripped so the snippet reads as plain content.
    """
    fragment = text[max(0, citation_end - window) : citation_end]
    # Remove citation markers and unwrap ordinary markdown links.
    fragment = re.sub(r"\(?\[[^\]]*\]\((?:https?|mailto)[^)]*\)\)?", "", fragment)
    fragment = " ".join(fragment.split())
    # Start at a sentence boundary when one exists reasonably far back, so the
    # snippet does not open mid-word from the hard window cut.
    match = None
    for match in re.finditer(r"[.!?]\s+", fragment[: max(0, len(fragment) - 40)]):
        pass
    if match is not None:
        fragment = fragment[match.end() :]
    return fragment.strip(" -–—:;,")


def _clean_html_fragment(fragment: str) -> str:
    return " ".join(html_module.unescape(_TAG.sub(" ", fragment)).split()).strip()


def _resolve_ddg_href(href: str) -> str | None:
    """DDG wraps results as //duckduckgo.com/l/?uddg=<encoded-url>&rut=...; ads lack uddg."""
    raw = html_module.unescape(href).strip()
    if raw.startswith("http://") or raw.startswith("https://"):
        return raw
    if raw.startswith("//"):
        raw = f"https:{raw}"
    try:
        parsed = urlparse(raw)
    except ValueError:
        return None
    target = parse_qs(parsed.query).get("uddg", [None])[0]
    if target and (target.startswith("http://") or target.startswith("https://")):
        return target
    return None


def get_web_search_client() -> WebSearchClient:
    return web_search_client_from_config(None)


def web_search_client_from_config(config_settings: dict[str, object] | None) -> WebSearchClient:
    """Build a client from an admin-saved Web Search connector config.

    Admin settings (engine, searxng_base_url, max_results) override the
    APERTURE_WEB_SEARCH_* environment defaults; anything unset falls through.
    """
    settings = get_settings()
    config = config_settings or {}
    engine = str(config.get("engine") or "").strip() or settings.web_search_engine
    searxng_base_url = str(config.get("searxng_base_url") or "").strip() or settings.searxng_base_url
    max_results = settings.web_search_max_results
    raw_max = config.get("max_results")
    if isinstance(raw_max, (int, float)) and int(raw_max) > 0:
        max_results = int(raw_max)
    elif isinstance(raw_max, str) and raw_max.strip().isdigit():
        max_results = int(raw_max.strip())
    return WebSearchClient(
        engine=engine,
        searxng_base_url=searxng_base_url,
        max_results=max_results,
        timeout_seconds=settings.web_search_timeout_seconds,
    )


def resolve_search_provider_key(store, engine: str, tenant_id: str | None = None) -> str | None:
    """Reuse the workspace's stored model-routing credential for keyed engines.

    Providers pointed at the vendor default endpoint are preferred over ones
    with a custom base URL, whose keys may not work against the vendor API.
    The store is duck-typed (SeedStore) to keep this module import-light.
    """
    kind = KEYED_SEARCH_ENGINE_KINDS.get((engine or "").strip().lower())
    if not kind:
        return None
    providers = [
        provider
        for provider in store.providers.values()
        if provider.kind.strip().lower() == kind
    ]
    providers.sort(key=lambda provider: (bool((provider.base_url or "").strip()), provider.id))
    for provider in providers:
        secret = store.provider_key_secret_for_provider(provider.id, tenant_id=tenant_id)
        if secret is not None and secret.secret_value:
            return secret.secret_value
    return None
