"""Question-time live lookups on knowledge web sources."""

from __future__ import annotations

import threading
import time

import pytest

from app.core import live_site_lookup as live
from app.core.config import get_settings
from app.core.html_extract import PageLink, SearchForm
from app.core.live_site_lookup import (
    LiveLookupLimits,
    LiveSiteSource,
    live_site_hits,
    live_site_lookup,
    live_sources_from_configs,
    lookup_phrase,
    query_terms,
)
from app.core.web_fetch import FetchedWebSource, WebFetchError
from app.core.web_search import WebSearchError, WebSearchResult
from app.models.schemas import KnowledgeChunk, KnowledgeConfig, KnowledgeDocument, Role, User
from app.repositories.deps import get_store


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def site_document(**overrides: object) -> KnowledgeDocument:
    values: dict[str, object] = {
        "id": "doc-web-registry",
        "knowledge_config_id": "kb-registry",
        "tenant_id": "tenant-example",
        "name": "Synthetic Registry",
        "source_uri": "https://www.registry.test/",
        "source_type": "web",
        "acl_group_ids": ["group-litigation"],
        "updated_at": "Oct 1, 2026, 9:00 AM UTC",
    }
    values.update(overrides)
    return KnowledgeDocument(**values)


def source(**overrides: object) -> LiveSiteSource:
    values: dict[str, object] = {
        "document": site_document(),
        "start_url": "https://www.registry.test/",
        "inventory": (
            PageLink("https://www.registry.test/about", "About the registry"),
            PageLink("https://www.registry.test/compounds/ethanol", "Ethanol properties"),
            PageLink("https://www.registry.test/compounds/methanol", "Methanol data"),
        ),
        "indexed_urls": frozenset({"https://www.registry.test/"}),
    }
    values.update(overrides)
    return LiveSiteSource(**values)


class FakeSite:
    """Synthetic pages keyed by URL; unknown URLs fail like a 404."""

    def __init__(self, pages: dict[str, tuple[str, str] | FetchedWebSource], *, delay: dict[str, float] | None = None) -> None:
        self.pages = pages
        self.delay = delay or {}
        self.calls: list[str] = []
        self._lock = threading.Lock()

    def __call__(self, url: str) -> FetchedWebSource:
        with self._lock:
            self.calls.append(url)
        time.sleep(self.delay.get(url, 0))
        page = self.pages.get(url)
        if page is None:
            raise WebFetchError(502, f"Web source fetch failed for {url}: HTTP 404.")
        if isinstance(page, FetchedWebSource):
            return page
        title, text = page
        return FetchedWebSource(url, url, "page.html", "text/html", text, len(text), title=title)


ETHANOL_PAGE = (
    "Ethanol properties",
    "Ethanol properties\n\nEthanol has a boiling point of 78.37 degrees Celsius at sea level.\n\n"
    "Unrelated paragraph about the registry newsletter.",
)


# -- query understanding ----------------------------------------------------


def test_query_terms_keep_meaningful_words_only() -> None:
    assert query_terms("What is the boiling point of ethanol according to the database?") == (
        "boiling",
        "point",
        "ethanol",
    )
    assert query_terms("Thanks! Can you tell me more?") == ()
    assert query_terms("") == ()


def test_lookup_phrase_keeps_short_numbers_for_site_search_boxes() -> None:
    assert lookup_phrase("Please find case 42 filed by Harbor Logistics") == "case 42 filed Harbor Logistics"


# -- ranking and fetching ---------------------------------------------------


def test_best_inventory_page_is_fetched_and_returned_as_a_cited_live_passage() -> None:
    site = FakeSite({"https://www.registry.test/compounds/ethanol": ETHANOL_PAGE})

    result = live_site_lookup("What is the boiling point of ethanol?", [source()], fetch_page=site)

    assert site.calls[0] == "https://www.registry.test/compounds/ethanol"
    assert "https://www.registry.test/about" not in site.calls
    [chunk] = result.chunks
    assert "boiling point of 78.37 degrees" in chunk.text
    assert chunk.text.startswith("Ethanol properties")
    assert chunk.source_uri == "https://www.registry.test/compounds/ethanol"
    assert chunk.locator == "Live page"
    assert chunk.source_type == "web"
    assert chunk.source_name == "Synthetic Registry"
    assert (chunk.knowledge_config_id, chunk.document_id, chunk.tenant_id) == (
        "kb-registry",
        "doc-web-registry",
        "tenant-example",
    )
    assert chunk.acl_group_ids == ["group-litigation"]
    assert chunk.id.startswith("live-") and chunk.score > 0
    assert result.fetched_urls == ("https://www.registry.test/compounds/ethanol",)


def test_live_chunk_ids_are_stable_for_the_same_passage() -> None:
    site = FakeSite({"https://www.registry.test/compounds/ethanol": ETHANOL_PAGE})

    first = live_site_lookup("ethanol boiling point", [source()], fetch_page=site)
    second = live_site_lookup("ethanol boiling point", [source()], fetch_page=site)

    assert [chunk.id for chunk in first.chunks] == [chunk.id for chunk in second.chunks]


def test_already_indexed_pages_are_never_fetched_live() -> None:
    site = FakeSite({"https://www.registry.test/compounds/ethanol": ETHANOL_PAGE})
    indexed = source(indexed_urls=frozenset({"https://www.registry.test/compounds/ethanol"}))

    result = live_site_lookup("ethanol boiling point", [indexed], fetch_page=site)

    assert "https://www.registry.test/compounds/ethanol" not in site.calls
    assert result.chunks == ()


def test_no_meaningful_terms_or_no_matching_links_fetches_nothing() -> None:
    site = FakeSite({})

    assert live_site_lookup("thanks!", [source()], fetch_page=site).chunks == ()
    assert live_site_lookup("quarterly zoning permits", [source()], fetch_page=site).chunks == ()
    assert live_site_lookup("ethanol", [], fetch_page=site).chunks == ()
    assert site.calls == []


def test_pages_whose_text_does_not_match_return_nothing() -> None:
    site = FakeSite({"https://www.registry.test/compounds/ethanol": ("Ethanol", "Navigation only. Contact us.")})

    result = live_site_lookup("ethanol boiling point", [source()], fetch_page=site)

    assert site.calls == ["https://www.registry.test/compounds/ethanol"]
    assert result.chunks == ()


def test_site_search_form_runs_the_query_and_follows_the_best_result_link() -> None:
    form = SearchForm("https://www.registry.test/search", "q")
    results_page = FetchedWebSource(
        "https://www.registry.test/search?q=melting+point+gallium",
        "https://www.registry.test/search?q=melting+point+gallium",
        "search.html",
        "text/html",
        "Search results\n\n2 results for gallium melting point",
        60,
        title="Search results",
        links=(
            PageLink("https://www.registry.test/help", "Help"),
            PageLink("https://www.registry.test/elements/31", "Gallium (Ga) element record"),
            PageLink("https://elsewhere.test/gallium", "Gallium elsewhere"),
        ),
    )
    site = FakeSite(
        {
            "https://www.registry.test/search?q=melting+point+gallium": results_page,
            "https://www.registry.test/elements/31": (
                "Gallium",
                "Gallium record\n\nGallium has a melting point of 29.76 degrees Celsius.",
            ),
        }
    )

    result = live_site_lookup(
        "What is the melting point of gallium?",
        [source(inventory=(), search_form=form)],
        fetch_page=site,
    )

    assert site.calls == [
        "https://www.registry.test/search?q=melting+point+gallium",
        "https://www.registry.test/elements/31",
    ]
    texts = [chunk.text for chunk in result.chunks]
    assert any("melting point of 29.76" in text for text in texts)
    # The record answered, so the results listing is not cited as well.
    assert [chunk.source_uri for chunk in result.chunks] == ["https://www.registry.test/elements/31"]


def test_results_listing_is_cited_when_no_record_page_answers() -> None:
    form = SearchForm("https://www.registry.test/search", "q")
    site = FakeSite(
        {
            "https://www.registry.test/search?q=melting+point+gallium": (
                "Search results",
                "Gallium | melting point 29.76 degrees Celsius | Group 13",
            ),
        }
    )
    result = live_site_lookup(
        "What is the melting point of gallium?",
        [source(inventory=(), search_form=form)],
        fetch_page=site,
    )
    assert [chunk.source_uri for chunk in result.chunks] == [
        "https://www.registry.test/search?q=melting+point+gallium"
    ]


def test_platform_search_engine_adds_site_scoped_results() -> None:
    queries: list[str] = []

    def search(query: str) -> list[WebSearchResult]:
        queries.append(query)
        return [
            WebSearchResult("Other site", "https://elsewhere.test/ethanol", "ethanol boiling"),
            WebSearchResult(
                "Ethanol safety sheet", "https://registry.test/sheets/ethanol?utm_source=s", "Boiling point data"
            ),
        ]

    site = FakeSite(
        {
            "https://registry.test/sheets/ethanol": (
                "Ethanol safety sheet",
                "Ethanol safety sheet\n\nBoiling point: 78 C. Flash point: 13 C.",
            )
        }
    )

    result = live_site_lookup(
        "ethanol boiling point",
        [source(inventory=())],
        fetch_page=site,
        site_search=search,
    )

    assert queries == ["site:registry.test ethanol boiling point"]
    assert site.calls == ["https://registry.test/sheets/ethanol"]
    assert result.chunks and result.chunks[0].source_uri == "https://registry.test/sheets/ethanol"


def test_total_fetches_are_capped_at_three() -> None:
    inventory = tuple(PageLink(f"https://www.registry.test/ethanol/{index}", f"Ethanol {index}") for index in range(8))
    site = FakeSite({link.url: ("Ethanol", "Ethanol boiling point details.") for link in inventory})

    live_site_lookup("ethanol boiling point", [source(inventory=inventory)], fetch_page=site)

    assert len(site.calls) == 3


def test_slow_pages_are_abandoned_at_the_time_budget() -> None:
    slow = "https://www.registry.test/compounds/ethanol"
    site = FakeSite({slow: ETHANOL_PAGE}, delay={slow: 1.0})

    started = time.monotonic()
    result = live_site_lookup(
        "ethanol boiling point",
        [source()],
        fetch_page=site,
        limits=LiveLookupLimits(budget_seconds=0.2),
    )

    assert time.monotonic() - started < 0.8
    assert result.chunks == ()


def test_failures_never_raise_into_chat() -> None:
    def broken_fetch(_url: str) -> FetchedWebSource:
        raise RuntimeError("parser exploded")

    def broken_search(_query: str) -> list[WebSearchResult]:
        raise WebSearchError("engine down")

    result = live_site_lookup(
        "ethanol boiling point", [source()], fetch_page=broken_fetch, site_search=broken_search
    )

    assert result.chunks == ()


def test_pages_that_redirect_off_the_site_are_ignored() -> None:
    url = "https://www.registry.test/compounds/ethanol"
    moved = FetchedWebSource(url, "https://elsewhere.test/ethanol", "e.html", "text/html", ETHANOL_PAGE[1], 10)

    result = live_site_lookup("ethanol boiling point", [source()], fetch_page=FakeSite({url: moved}))

    assert result.chunks == ()


# -- reading stored recipes -------------------------------------------------


def registry_config(recipe: dict[str, object]) -> KnowledgeConfig:
    return KnowledgeConfig(
        id="kb-registry",
        tenant_id="tenant-example",
        name="Registry",
        source_type="web",
        enabled=True,
        owner_user_id="user-admin",
        acl_group_ids=["group-litigation"],
        settings={"linked_sources": [recipe]},
    )


RECIPE: dict[str, object] = {
    "document_id": "doc-web-registry",
    "kind": "web",
    "name": "Synthetic Registry",
    "url": "https://www.registry.test/",
    "refresh": True,
    "live_lookup": True,
    "pages": ["https://www.registry.test/", "https://www.registry.test/about"],
    "inventory": [{"url": "https://www.registry.test/compounds/ethanol", "text": "Ethanol properties"}],
    "site_search": {"action": "https://www.registry.test/search", "param": "q", "fixed": []},
}


def test_live_sources_come_from_web_recipes_with_live_lookup_on() -> None:
    off = {**RECIPE, "document_id": "doc-off", "live_lookup": False}
    legacy = {key: value for key, value in RECIPE.items() if key != "live_lookup"}
    missing_document = {**RECIPE, "document_id": "doc-gone"}
    config = registry_config(RECIPE)
    config.settings["linked_sources"] = [RECIPE, off, {**legacy, "document_id": "doc-legacy"}, missing_document]
    documents = [site_document(), site_document(id="doc-off"), site_document(id="doc-legacy")]

    [found] = live_sources_from_configs([config], lambda _config_id: documents)

    assert found.document.id == "doc-web-registry"
    assert found.inventory == (PageLink("https://www.registry.test/compounds/ethanol", "Ethanol properties"),)
    assert found.indexed_urls == frozenset({"https://www.registry.test/", "https://www.registry.test/about"})
    assert found.search_form == SearchForm("https://www.registry.test/search", "q")


def _install_registry(store, recipe: dict[str, object] = RECIPE) -> KnowledgeConfig:
    config = registry_config(recipe)
    store.knowledge_configs[config.id] = config
    store.knowledge_documents[config.id] = [site_document()]
    store.knowledge_chunks[config.id] = []
    return config


def _lawyer(**overrides: object) -> User:
    values: dict[str, object] = {
        "id": "user-synthetic",
        "tenant_id": "tenant-example",
        "email": "synthetic@example.test",
        "display_name": "Synthetic User",
        "role": Role.USER,
        "group_ids": ["group-litigation"],
    }
    values.update(overrides)
    return User(**values)


def test_live_site_hits_fetches_for_a_visible_site_document(monkeypatch: pytest.MonkeyPatch) -> None:
    store = get_store()
    config = _install_registry(store)
    site = FakeSite({"https://www.registry.test/compounds/ethanol": ETHANOL_PAGE})
    monkeypatch.setattr(live, "_fetch_live_page", site)
    monkeypatch.setattr(live, "_platform_site_search", lambda _store, _tenant: None)

    hits = live_site_hits(store, _lawyer(), [config], "ethanol boiling point")

    assert [hit.source_uri for hit in hits] == ["https://www.registry.test/compounds/ethanol"]


def test_live_site_hits_respects_document_acl_and_the_web_switch(monkeypatch: pytest.MonkeyPatch) -> None:
    store = get_store()
    config = _install_registry(store)
    site = FakeSite({"https://www.registry.test/compounds/ethanol": ETHANOL_PAGE})
    monkeypatch.setattr(live, "_fetch_live_page", site)
    monkeypatch.setattr(live, "_platform_site_search", lambda _store, _tenant: None)

    assert live_site_hits(store, _lawyer(group_ids=["group-corporate"]), [config], "ethanol boiling point") == []
    assert live_site_hits(store, _lawyer(tenant_id="tenant-other"), [config], "ethanol boiling point") == []
    monkeypatch.setattr(live, "connector_enabled_for_tenant", lambda *_args: False)
    assert live_site_hits(store, _lawyer(), [config], "ethanol boiling point") == []
    assert site.calls == []


def test_live_site_hits_skips_sources_the_indexed_hits_already_cover(monkeypatch: pytest.MonkeyPatch) -> None:
    store = get_store()
    config = _install_registry(store)
    site = FakeSite({"https://www.registry.test/compounds/ethanol": ETHANOL_PAGE})
    monkeypatch.setattr(live, "_fetch_live_page", site)
    monkeypatch.setattr(live, "_platform_site_search", lambda _store, _tenant: None)
    covering = KnowledgeChunk(
        id="chunk-doc-web-registry-1",
        knowledge_config_id="kb-registry",
        document_id="doc-web-registry",
        tenant_id="tenant-example",
        source_name="Synthetic Registry",
        source_uri="https://www.registry.test/",
        source_type="web",
        text="Ethanol boiling point is listed on the home page.",
        updated_at="now",
    )

    hits = live_site_hits(store, _lawyer(), [config], "ethanol boiling point", known_hits=[covering])

    assert hits == []
    assert site.calls == []


def test_live_site_hits_never_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    store = get_store()
    config = _install_registry(store)

    def explode(*_args: object, **_kwargs: object) -> object:
        raise RuntimeError("unexpected")

    monkeypatch.setattr(live, "live_site_lookup", explode)
    monkeypatch.setattr(live, "_platform_site_search", lambda _store, _tenant: None)

    assert live_site_hits(store, _lawyer(), [config], "ethanol boiling point") == []


def test_platform_site_search_uses_only_keyless_engines(monkeypatch: pytest.MonkeyPatch) -> None:
    store = get_store()
    monkeypatch.setattr(get_settings(), "web_search_engine", "duckduckgo")
    assert live._platform_site_search(store, "tenant-example") is not None
    monkeypatch.setattr(get_settings(), "web_search_engine", "openai")
    assert live._platform_site_search(store, "tenant-example") is None


def test_platform_search_engine_runs_only_when_the_turn_allows_web_search(monkeypatch: pytest.MonkeyPatch) -> None:
    store = get_store()
    config = _install_registry(store, {**RECIPE, "inventory": []})
    queries: list[str] = []

    def engine(query: str) -> list[WebSearchResult]:
        queries.append(query)
        return []

    monkeypatch.setattr(live, "_fetch_live_page", FakeSite({}))
    monkeypatch.setattr(live, "_platform_site_search", lambda _store, _tenant: engine)

    live_site_hits(store, _lawyer(), [config], "ethanol boiling point")
    assert queries == []
    live_site_hits(store, _lawyer(), [config], "ethanol boiling point", web_search=True)
    assert queries == ["site:registry.test ethanol boiling point"]


def test_live_pages_of_a_walled_site_stay_behind_its_wall(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.models.schemas import KnowledgeDocumentWall

    store = get_store()
    config = _install_registry(store)
    store.knowledge_documents[config.id] = [
        site_document(wall=KnowledgeDocumentWall(source="manual", group_ids=["group-falcon"]))
    ]
    site = FakeSite({"https://www.registry.test/compounds/ethanol": ETHANOL_PAGE})
    monkeypatch.setattr(live, "_fetch_live_page", site)
    monkeypatch.setattr(live, "_platform_site_search", lambda _store, _tenant: None)

    assert live_site_hits(store, _lawyer(), [config], "ethanol boiling point") == []
    assert site.calls == []
    hits = live_site_hits(
        store, _lawyer(group_ids=["group-litigation", "group-falcon"]), [config], "ethanol boiling point"
    )
    assert hits and all(hit.wall_group_ids == ["group-falcon"] for hit in hits)


def _listing_with_record(record_text: str) -> list[str]:
    form = SearchForm("https://www.registry.test/search", "q")
    results_page = FetchedWebSource(
        "https://www.registry.test/search?q=melting+point+gallium",
        "https://www.registry.test/search?q=melting+point+gallium",
        "search.html",
        "text/html",
        "Results: gallium melting point 29.76 degrees Celsius",
        60,
        title="Search results",
        links=(PageLink("https://www.registry.test/elements/31", "Gallium melting point record"),),
    )
    site = FakeSite(
        {
            "https://www.registry.test/search?q=melting+point+gallium": results_page,
            "https://www.registry.test/elements/31": ("Record", record_text),
        }
    )
    result = live_site_lookup(
        "What is the melting point of gallium?",
        [source(inventory=(), search_form=form)],
        fetch_page=site,
    )
    return [chunk.source_uri for chunk in result.chunks]


def test_a_record_page_that_misses_the_question_keeps_the_listing() -> None:
    assert _listing_with_record("Opening hours and contact details.") == [
        "https://www.registry.test/search?q=melting+point+gallium"
    ]


def test_a_record_page_that_partly_answers_replaces_the_listing() -> None:
    assert _listing_with_record("Gallium begins melting near body temperature.") == [
        "https://www.registry.test/elements/31"
    ]
