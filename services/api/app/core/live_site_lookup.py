"""Question-time lookups on knowledge web sources.

When a chat turn searches a knowledge base that holds a web source with live
lookup on, the indexed pages may not contain what the person is asking about.
This module looks further on that site for the specific question: it ranks the
site's saved link inventory against the question, runs the site's own search
form when one was found, and (when a keyless platform search engine is
configured and the person turned on web search for the reply) adds
``site:<host>`` results. It then reads at most three pages
inside a tight time budget and returns the passages that best match the
question as ordinary knowledge chunks, so they get [K#] labels and citations.

Live pages are never written to the index, a lookup is skipped when the
indexed hits already contain every question term, and nothing here ever raises
into chat: any failure simply yields no live passages.
"""

from __future__ import annotations

import hashlib
import logging
import re
import time
from collections.abc import Callable, Iterable, Sequence
from concurrent.futures import Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import UTC, datetime
from itertools import islice
from typing import TYPE_CHECKING
from urllib.parse import unquote, urlsplit

from app.core.connector_availability import connector_enabled_for_tenant, tenant_connector_configs
from app.core.html_extract import PageLink, SearchForm
from app.core.knowledge_ingestion import chunk_text
from app.core.knowledge_walls import wall_group_ids
from app.core.policy import knowledge_chunk_visible_to_user as chunk_visible_to_actor
from app.core.site_crawl import normalize_url, same_site, site_keys, site_recipes
from app.core.sparse_vectors import normalize_search_token, sparse_text_vector
from app.core.web_fetch import FetchedWebSource, fetch_web_source
from app.core.web_search import WebSearchResult, web_search_client_from_config
from app.models.schemas import KnowledgeChunk, KnowledgeConfig, KnowledgeDocument, User

if TYPE_CHECKING:
    from app.repositories.seed import SeedStore

logger = logging.getLogger(__name__)

LIVE_LOOKUP_USER_AGENT = "ApertureChat-LiveLookup/0.1"
LIVE_PAGE_LOCATOR = "Live page"
_LIVE_PAGE_MAX_BYTES = 2 * 1024 * 1024
_LIVE_PAGE_MAX_CHARS = 200_000
_LIVE_PAGE_TIMEOUT_SECONDS = 4.0
_MAX_QUERY_TERMS = 12
_MAX_PHRASE_WORDS = 6
_PASSAGES_PER_PAGE = 2
# Only real search engines run site-scoped searches here. Keyed engines answer
# through a billed model call, which is not something to start on every turn.
_SITE_SEARCH_ENGINES = frozenset({"duckduckgo", "searxng"})

# Words that say what kind of question it is rather than what it is about.
_QUESTION_NOISE = frozenset(
    {
        "about", "according", "also", "any", "answer", "ask", "been", "being", "but", "can", "could",
        "current", "database", "describe", "did", "does", "explain", "find", "get", "give", "hello",
        "how", "info", "information", "into", "its", "just", "know", "latest", "like", "list", "look",
        "lookup", "more", "most", "need", "not", "okay", "our", "page", "please", "question", "see",
        "should", "show", "site", "some", "summarize", "summary", "sure", "tell", "than", "thank",
        "thanks", "their", "them", "then", "there", "they", "want", "was", "web", "webpage", "website",
        "were", "what", "when", "where", "which", "who", "whom", "whose", "why", "will", "would", "yes",
        "you", "your",
    }
)
_WORD = re.compile(r"[A-Za-z0-9]+")


@dataclass(frozen=True, slots=True)
class LiveSiteSource:
    """One web source a chat turn may look further on."""

    document: KnowledgeDocument
    start_url: str
    inventory: tuple[PageLink, ...] = ()
    indexed_urls: frozenset[str] = frozenset()
    search_form: SearchForm | None = None

    @property
    def keys(self) -> frozenset[str]:
        return site_keys(self.start_url, self.document.source_uri)

    @property
    def host(self) -> str:
        return min(self.keys, key=len, default="")


@dataclass(frozen=True, slots=True)
class LiveLookupLimits:
    max_fetches: int = 3
    max_passages: int = 3
    budget_seconds: float = 6.0
    min_followup_seconds: float = 1.5
    max_sources: int = 3


@dataclass(frozen=True, slots=True)
class LiveLookupResult:
    chunks: tuple[KnowledgeChunk, ...] = ()
    fetched_urls: tuple[str, ...] = ()


# -- query understanding ----------------------------------------------------


def _meaningful(word: str) -> str | None:
    lowered = word.lower()
    if lowered in _QUESTION_NOISE:
        return None
    token = normalize_search_token(lowered)
    return None if token is None or token in _QUESTION_NOISE else token


def query_terms(query: str) -> tuple[str, ...]:
    """Distinct search tokens that say what the question is about, in order."""

    terms: dict[str, None] = {}
    for match in _WORD.finditer(query or ""):
        token = _meaningful(match.group())
        if token is not None:
            terms[token] = None
        if len(terms) >= _MAX_QUERY_TERMS:
            break
    return tuple(terms)


def lookup_phrase(query: str) -> str:
    """The question reduced to the words a site's search box should receive."""

    words = (match.group() for match in _WORD.finditer(query or ""))
    kept = (word for word in words if word.isdigit() or _meaningful(word))
    return " ".join(islice(kept, _MAX_PHRASE_WORDS))


def _coverage(terms: Sequence[str], text: str) -> tuple[int, float]:
    tokens = sparse_text_vector(text)
    matched = [term for term in terms if term in tokens]
    return len(matched), sum(tokens[term] for term in matched)


def _passage_score(terms: Sequence[str], text: str) -> float:
    matched, frequency = _coverage(terms, text)
    if not matched:
        return 0.0
    return matched / len(terms) + 0.01 * min(frequency, 50)


def _link_score(terms: Sequence[str], text: str, url: str) -> float:
    anchor = sparse_text_vector(text)
    parts = urlsplit(url)
    location = sparse_text_vector(unquote(f"{parts.path} {parts.query}"))
    score = sum(1.0 if term in anchor else 0.75 if term in location else 0.0 for term in terms)
    return score / len(terms)


# -- lookup -----------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Candidate:
    url: str
    score: float
    source: LiveSiteSource
    listing: bool = False


@dataclass(frozen=True, slots=True)
class _LivePage:
    candidate: _Candidate
    fetched: FetchedWebSource


def live_site_lookup(
    query: str,
    sources: Sequence[LiveSiteSource],
    *,
    fetch_page: Callable[[str], FetchedWebSource],
    site_search: Callable[[str], list[WebSearchResult]] | None = None,
    limits: LiveLookupLimits = LiveLookupLimits(),
    clock: Callable[[], float] = time.monotonic,
) -> LiveLookupResult:
    """Read a few not-yet-indexed pages that match the question and return their best passages."""

    terms = query_terms(query)
    if not terms or not sources:
        return LiveLookupResult()
    pool = ThreadPoolExecutor(max_workers=limits.max_fetches + limits.max_sources, thread_name_prefix="live-site")
    try:
        lookup = _Lookup(terms, lookup_phrase(query), list(sources)[: limits.max_sources], fetch_page, limits, clock, pool)
        return lookup.run(site_search)
    finally:
        # Abandoned fetches end on their own per-request timeout.
        pool.shutdown(wait=False, cancel_futures=True)


class _Lookup:
    def __init__(
        self,
        terms: tuple[str, ...],
        phrase: str,
        sources: list[LiveSiteSource],
        fetch_page: Callable[[str], FetchedWebSource],
        limits: LiveLookupLimits,
        clock: Callable[[], float],
        pool: ThreadPoolExecutor,
    ) -> None:
        self.terms = terms
        self.phrase = phrase or " ".join(terms)
        self.sources = sources
        self.fetch_page = fetch_page
        self.limits = limits
        self.clock = clock
        self.pool = pool
        self.deadline = clock() + limits.budget_seconds
        self.attempted: set[str] = set()
        self.pages: list[_LivePage] = []

    def run(self, site_search: Callable[[str], list[WebSearchResult]] | None) -> LiveLookupResult:
        searches = self._start_searches(site_search)
        reserve = 1 if searches or any(source.search_form for source in self.sources) else 0
        self._fetch(self._first_wave()[: self.limits.max_fetches - reserve])
        if self.deadline - self.clock() >= self.limits.min_followup_seconds:
            followups = self._followups(self._search_candidates(searches))
            self._fetch(followups[: max(0, self.limits.max_fetches - len(self.attempted))])
        return self._result()

    def _start_searches(
        self, site_search: Callable[[str], list[WebSearchResult]] | None
    ) -> dict[Future[list[WebSearchResult]], LiveSiteSource]:
        if site_search is None:
            return {}
        return {
            self.pool.submit(site_search, f"site:{source.host} {self.phrase}"): source
            for source in self.sources
            if source.host
        }

    def _eligible(self, url: str, source: LiveSiteSource) -> str | None:
        normalized = normalize_url(url)
        if not normalized or normalized in source.indexed_urls or normalized in self.attempted:
            return None
        return normalized if same_site(normalized, source.keys) else None

    def _first_wave(self) -> list[_Candidate]:
        candidates: list[_Candidate] = []
        for source in self.sources:
            if source.search_form is not None:
                url = self._eligible(source.search_form.url_for(self.phrase), source)
                if url:
                    candidates.append(_Candidate(url, 10.0, source, listing=True))
            candidates.extend(self._ranked_links(source, source.inventory))
        return _best(candidates)

    def _ranked_links(self, source: LiveSiteSource, links: Iterable[PageLink], *, bonus: float = 0.0) -> list[_Candidate]:
        ranked: list[_Candidate] = []
        for link in links:
            url = self._eligible(link.url, source)
            score = _link_score(self.terms, link.text, link.url) if url else 0.0
            if url and score > 0:
                ranked.append(_Candidate(url, score + bonus, source))
        return ranked

    def _search_candidates(
        self, searches: dict[Future[list[WebSearchResult]], LiveSiteSource]
    ) -> list[_Candidate]:
        if not searches:
            return []
        timeout = max(0.0, self.deadline - self.clock() - self.limits.min_followup_seconds)
        done, _pending = wait(searches, timeout=timeout)
        candidates: list[_Candidate] = []
        for future in done:
            try:
                results = future.result()
            except Exception:  # noqa: BLE001 - a failed engine only means fewer candidates
                continue
            links = [PageLink(result.url, f"{result.title} {result.snippet}") for result in results]
            # The engine already judged these relevant, so they outrank bare links.
            candidates.extend(self._ranked_links(searches[future], links, bonus=0.5))
        return candidates

    def _followups(self, search_candidates: list[_Candidate]) -> list[_Candidate]:
        candidates = list(search_candidates)
        for page in self.pages:
            candidates.extend(self._ranked_links(page.candidate.source, page.fetched.links))
        return _best(candidates)

    def _fetch(self, candidates: list[_Candidate]) -> None:
        remaining = self.deadline - self.clock()
        if not candidates or remaining <= 0:
            return
        futures = {self.pool.submit(self.fetch_page, candidate.url): candidate for candidate in candidates}
        self.attempted.update(candidate.url for candidate in candidates)
        done, _pending = wait(futures, timeout=remaining)
        for future in sorted(done, key=lambda item: candidates.index(futures[item])):
            try:
                fetched = future.result()
            except Exception:  # noqa: BLE001 - one unreadable page never affects chat
                continue
            candidate = futures[future]
            if same_site(fetched.final_url, candidate.source.keys):
                self.pages.append(_LivePage(candidate, fetched))

    def _result(self) -> LiveLookupResult:
        scored: list[tuple[float, int, str, _LivePage]] = []
        for page_index, page in enumerate(self._cited_pages()):
            weight = 0.9 if page.candidate.listing else 1.0
            passages = [
                (_passage_score(self.terms, text) * weight, text)
                for text in chunk_text(page.fetched.text)
            ]
            passages = sorted((item for item in passages if item[0] > 0), key=lambda item: -item[0])
            scored.extend((score, page_index, text, page) for score, text in passages[:_PASSAGES_PER_PAGE])
        scored.sort(key=lambda item: (-item[0], item[1]))
        chunks = tuple(
            _live_chunk(
                page.candidate.source.document,
                page.candidate.url,
                _with_title(page.fetched.title, text),
                score=score,
                ordinal=ordinal,
            )
            for ordinal, (score, _index, text, page) in enumerate(scored[: self.limits.max_passages])
        )
        return LiveLookupResult(chunks=chunks, fetched_urls=tuple(page.candidate.url for page in self.pages))


    def _cited_pages(self) -> list[_LivePage]:
        """Pages whose passages may be cited.

        A site-search results page only stands in for the records it lists: once
        a record page from the same site matches the question, the listing adds
        navigation, not facts, so it is left out.
        """
        answered = {
            id(page.candidate.source)
            for page in self.pages
            if not page.candidate.listing
            and any(_passage_score(self.terms, text) > 0 for text in chunk_text(page.fetched.text))
        }
        return [
            page
            for page in self.pages
            if not (page.candidate.listing and id(page.candidate.source) in answered)
        ]


def _best(candidates: list[_Candidate]) -> list[_Candidate]:
    best: dict[str, _Candidate] = {}
    for candidate in candidates:
        if candidate.url not in best or candidate.score > best[candidate.url].score:
            best[candidate.url] = candidate
    return sorted(best.values(), key=lambda candidate: -candidate.score)


# Fields a chunk shares with its document (tenant, knowledge base, sharing, and
# any later access fields) are inherited so live passages obey the same access
# rules as indexed ones. Fields that describe the passage itself are not.
_PASSAGE_FIELDS = frozenset({"id", "name", "source_type", "source_uri", "updated_at"})
_INHERITED_FIELDS = tuple(
    sorted((set(KnowledgeChunk.model_fields) & set(KnowledgeDocument.model_fields)) - _PASSAGE_FIELDS)
)


def _with_title(title: str, text: str) -> str:
    return text if not title or text.startswith(title) else f"{title}\n\n{text}"


def _live_chunk(
    document: KnowledgeDocument, url: str, text: str, *, score: float, ordinal: int
) -> KnowledgeChunk:
    digest = hashlib.sha256(f"{document.id}\n{url}\n{text}".encode()).hexdigest()[:20]
    return KnowledgeChunk(
        **{name: getattr(document, name) for name in _INHERITED_FIELDS},
        id=f"live-{digest}",
        document_id=document.id,
        source_name=document.name,
        source_type="web",
        source_uri=url,
        text=text,
        ordinal=ordinal,
        score=round(score, 4),
        locator=LIVE_PAGE_LOCATOR,
        updated_at=datetime.now(UTC).isoformat(timespec="seconds"),
        # The document keeps its ethical wall as `wall`; passages carry the
        # group list, so a walled site's live pages stay behind the same wall.
        wall_group_ids=wall_group_ids(document.wall),
    )


# -- chat entry point ---------------------------------------------------------


def live_sources_from_configs(
    configs: Iterable[KnowledgeConfig],
    documents_for: Callable[[str], list[KnowledgeDocument]],
) -> list[LiveSiteSource]:
    """Web sources with live lookup on, from knowledge bases already access-checked."""

    sources: list[LiveSiteSource] = []
    for config in configs:
        recipes = [recipe for recipe in site_recipes(config.settings) if recipe.live_lookup]
        if not recipes:
            continue
        documents = {document.id: document for document in documents_for(config.id)}
        for recipe in recipes:
            document = documents.get(recipe.document_id)
            if document is not None:
                sources.append(
                    LiveSiteSource(
                        document=document,
                        start_url=recipe.url,
                        inventory=recipe.inventory,
                        indexed_urls=recipe.indexed_urls,
                        search_form=recipe.search_form,
                    )
                )
    return sources


def live_site_hits(
    store: SeedStore,
    actor: User,
    knowledge_configs: Sequence[KnowledgeConfig],
    query: str,
    *,
    known_hits: Sequence[KnowledgeChunk] = (),
    web_search: bool = False,
) -> list[KnowledgeChunk]:
    """Live passages for this chat turn; never raises.

    The site itself (its pages and its own search form) is always eligible.
    A third-party search engine only receives the question when the person
    turned on web search for this reply (``web_search``).
    """

    try:
        terms = query_terms(query)
        if not terms or not connector_enabled_for_tenant(store, "web", actor.tenant_id):
            return []
        sources = [
            source
            for source in live_sources_from_configs(knowledge_configs, store.knowledge_documents_for)
            if chunk_visible_to_actor(actor, _probe_chunk(source)) and not _covered(terms, source, known_hits)
        ]
        if not sources:
            return []
        result = live_site_lookup(
            query,
            sources,
            fetch_page=_fetch_live_page,
            site_search=_platform_site_search(store, actor.tenant_id) if web_search else None,
        )
        return [chunk for chunk in result.chunks if chunk_visible_to_actor(actor, chunk)]
    except Exception:  # noqa: BLE001 - live lookups are best effort by design
        logger.warning("Live site lookup failed; answering from the index only.", exc_info=True)
        return []


def _probe_chunk(source: LiveSiteSource) -> KnowledgeChunk:
    """An empty live chunk of this source, to ask the store's access rule before fetching."""

    return _live_chunk(source.document, source.start_url, "", score=0.0, ordinal=0)


def _covered(terms: Sequence[str], source: LiveSiteSource, known_hits: Sequence[KnowledgeChunk]) -> bool:
    """True when this site's indexed hits already contain every question term."""

    text = " ".join(hit.text for hit in known_hits if hit.document_id == source.document.id)
    return bool(text) and _coverage(terms, text)[0] == len(terms)


def _fetch_live_page(url: str) -> FetchedWebSource:
    return fetch_web_source(
        url,
        max_bytes=_LIVE_PAGE_MAX_BYTES,
        max_chars=_LIVE_PAGE_MAX_CHARS,
        timeout_seconds=_LIVE_PAGE_TIMEOUT_SECONDS,
        user_agent=LIVE_LOOKUP_USER_AGENT,
    )


def _platform_site_search(
    store: SeedStore, tenant_id: str | None
) -> Callable[[str], list[WebSearchResult]] | None:
    web_config = next(iter(tenant_connector_configs(store, "web", tenant_id)), None)
    client = web_search_client_from_config(dict(web_config.settings) if web_config else None)
    return client.search if client.engine in _SITE_SEARCH_ENGINES else None

