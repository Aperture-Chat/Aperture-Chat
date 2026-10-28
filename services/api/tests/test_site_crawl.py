"""Bounded same-site crawling: scope, normalization, robots.txt, sitemaps, and limits."""

from __future__ import annotations

import threading

import httpx
import pytest

from app.core.html_extract import PageLink, SearchForm
from app.core.site_crawl import (
    CrawlLimits,
    CrawlResult,
    CrawledPage,
    crawl_recipe_fields,
    crawl_site,
    crawlable_link,
    links_from_settings,
    links_to_settings,
    normalize_url,
    same_site,
    search_form_from_settings,
    search_form_to_settings,
    single_page_result,
    site_keys,
    site_recipes,
)
from app.core.web_fetch import FetchedWebSource, WebFetchError

HTML = "text/html"


def page(title: str, *links: tuple[str, str], body: str = "") -> str:
    anchors = "".join(f'<a href="{href}">{text}</a>' for href, text in links)
    return f"<html><head><title>{title}</title></head><body><nav>{anchors}</nav><main><p>{body or title} body text.</p></main></body></html>"


class SyntheticSite:
    """Serve path -> (status, content type, body); everything else is a 404."""

    def __init__(self, routes: dict[str, tuple[int, str, str] | str], *, on_request=None) -> None:
        self.routes = routes
        self.requests: list[str] = []
        self._lock = threading.Lock()
        self._on_request = on_request

    def __call__(self, request: httpx.Request) -> httpx.Response:
        with self._lock:
            self.requests.append(str(request.url))
        if self._on_request is not None:
            self._on_request(request)
        key = request.url.path + (f"?{request.url.query.decode()}" if request.url.query else "")
        route = self.routes.get(key, self.routes.get(request.url.path))
        if route is None:
            return httpx.Response(404, content=b"not found", request=request)
        if isinstance(route, str):
            route = (200, HTML, route)
        status, content_type, body = route
        if status in (301, 302):
            return httpx.Response(status, headers={"location": body}, request=request)
        return httpx.Response(status, headers={"content-type": content_type}, content=body.encode(), request=request)

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)

    def paths(self) -> list[str]:
        return [httpx.URL(url).path for url in self.requests]


def crawl(site: SyntheticSite, start: str = "https://www.site.test/", **limits: object) -> CrawlResult:
    return crawl_site(start, limits=CrawlLimits(**limits), transport=site.transport())


# -- URL policy ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("HTTPS://WWW.Site.TEST:443/a#frag", "https://www.site.test/a"),
        ("http://site.test:80", "http://site.test/"),
        ("https://site.test:8443/x", "https://site.test:8443/x"),
        ("https://site.test/a?utm_source=n&id=7&gclid=1&fbclid=2", "https://site.test/a?id=7"),
        ("https://site.test/a?page", "https://site.test/a?page"),
        ("https://user:secret@site.test/a", "https://site.test/a"),
        ("mailto:clerk@site.test", None),
        ("ftp://site.test/file", None),
        ("https:///no-host", None),
        ("https://site.test:notaport/", None),
    ],
)
def test_normalize_url(raw: str, expected: str | None) -> None:
    assert normalize_url(raw) == expected


def test_same_site_treats_www_as_the_same_host_only() -> None:
    keys = site_keys("https://www.site.test/start")

    assert same_site("https://site.test/a", keys)
    assert same_site("http://www.site.test/b", keys)
    assert not same_site("https://docs.site.test/c", keys)
    assert not same_site("https://other.test/", keys)
    assert not same_site("https://site.test:8443/", keys)


@pytest.mark.parametrize(
    ("url", "allowed"),
    [
        ("https://site.test/records/2024", True),
        ("https://site.test/reports/annual.pdf", True),
        ("https://site.test/forms/intake.docx", True),
        ("https://site.test/accounting/policy", True),
        ("https://site.test/login", False),
        ("https://site.test/users/sign-in?next=/", False),
        ("https://site.test/Logout", False),
        ("https://site.test/cart", False),
        ("https://site.test/shop/checkout/step-1", False),
        ("https://site.test/wp-login.php", False),
        ("https://site.test/index.php?action=login", False),
        ("https://site.test/images/photo.JPG", False),
        ("https://site.test/download/archive.zip", False),
        ("https://site.test/video/intro.mp4", False),
        ("https://site.test/legacy/brief.doc", False),
    ],
)
def test_crawlable_link_skips_sign_in_commerce_and_binary_media(url: str, allowed: bool) -> None:
    assert crawlable_link(url) is allowed


# -- crawling -----------------------------------------------------------------


def test_breadth_first_crawl_reads_same_site_pages_and_keeps_deeper_links_as_inventory() -> None:
    site = SyntheticSite(
        {
            "/": page(
                "Synthetic Registry",
                ("/datasets", "Datasets"),
                ("https://site.test/about#team", "About"),
                ("/datasets?utm_source=nav", "Datasets again"),
                ("/login", "Sign in"),
                ("/logo.png", "Logo"),
                ("https://elsewhere.test/", "Partner"),
            ),
            "/datasets": page("Datasets", ("/datasets/rivers", "River gauges")),
            "/about": page("About the registry"),
        }
    )

    result = crawl(site, max_depth=1)

    assert [(item.url, item.title, item.depth) for item in result.pages] == [
        ("https://www.site.test/", "Synthetic Registry", 0),
        ("https://www.site.test/datasets", "Datasets", 1),
        ("https://site.test/about", "About the registry", 1),
    ]
    assert result.inventory == (PageLink("https://www.site.test/datasets/rivers", "River gauges"),)
    assert result.site_name == "Synthetic Registry"
    assert "Datasets body text." in result.pages[1].text
    assert "/login" not in site.paths() and "/logo.png" not in site.paths()
    assert not any("elsewhere.test" in url for url in site.requests)
    assert result.failed == result.robots_blocked == 0


def test_depth_two_follows_links_from_second_level_pages() -> None:
    site = SyntheticSite(
        {
            "/": page("Home", ("/a", "A")),
            "/a": page("A", ("/a/b", "B")),
            "/a/b": page("B", ("/a/b/c", "C")),
        }
    )

    result = crawl(site, max_depth=2)

    assert [item.depth for item in result.pages] == [0, 1, 2]
    assert result.inventory == (PageLink("https://www.site.test/a/b/c", "C"),)


def test_robots_txt_blocks_paths_for_our_agent_and_blocked_links_stay_out_of_inventory() -> None:
    site = SyntheticSite(
        {
            "/robots.txt": (
                200,
                "text/plain",
                "User-agent: *\nDisallow: /\n\nUser-agent: ApertureChat-KnowledgeIndexer\nDisallow: /private\n",
            ),
            "/": page("Home", ("/public", "Public"), ("/private/report", "Private report"), ("/private/x", "X")),
            "/public": page("Public", ("/private/deeper", "Deeper")),
        }
    )

    result = crawl(site, max_depth=1)

    assert [item.url for item in result.pages] == ["https://www.site.test/", "https://www.site.test/public"]
    assert result.robots_blocked == 2
    assert result.inventory == ()
    assert not any(path.startswith("/private") for path in site.paths())


def test_unreachable_robots_txt_means_only_the_requested_page_is_read() -> None:
    site = SyntheticSite(
        {
            "/robots.txt": (503, "text/plain", "busy"),
            "/": page("Home", ("/a", "A"), ("/b", "B")),
        }
    )

    result = crawl(site, max_depth=1)

    assert [item.url for item in result.pages] == ["https://www.site.test/"]
    assert result.robots_blocked == 2
    assert result.inventory == ()


def test_sitemap_urls_seed_discovery_after_the_start_page_links() -> None:
    site = SyntheticSite(
        {
            "/robots.txt": (200, "text/plain", "Sitemap: https://www.site.test/maps/index.xml\n"),
            "/maps/index.xml": (
                200,
                "application/xml",
                "<sitemapindex><sitemap><loc>https://www.site.test/maps/pages.xml</loc></sitemap></sitemapindex>",
            ),
            "/maps/pages.xml": (
                200,
                "application/xml",
                "<urlset><url><loc>https://www.site.test/from-map?x=1&amp;y=2</loc></url>"
                "<url><loc>https://elsewhere.test/ignored</loc></url>"
                "<url><loc> https://www.site.test/linked </loc></url></urlset>",
            ),
            "/": page("Home", ("/linked", "Linked page")),
            "/linked": page("Linked"),
            "/from-map": page("Mapped"),
        }
    )

    result = crawl(site, max_depth=1)

    assert [item.url for item in result.pages] == [
        "https://www.site.test/",
        "https://www.site.test/linked",
        "https://www.site.test/from-map?x=1&y=2",
    ]
    assert not any("elsewhere.test" in url for url in site.requests)


def test_default_sitemap_location_is_tried_when_robots_names_none() -> None:
    site = SyntheticSite(
        {
            "/sitemap.xml": (200, "application/xml", "<urlset><url><loc>https://www.site.test/only-in-map</loc></url></urlset>"),
            "/": page("Home"),
            "/only-in-map": page("Hidden gem"),
        }
    )

    result = crawl(site, max_depth=1)

    assert [item.title for item in result.pages] == ["Home", "Hidden gem"]


def test_page_limit_stops_the_crawl_and_reports_unread_links() -> None:
    links = [(f"/item/{index}", f"Item {index}") for index in range(10)]
    routes: dict[str, tuple[int, str, str] | str] = {"/": page("Home", *links)}
    routes.update({href: page(text) for href, text in links})
    site = SyntheticSite(routes)

    result = crawl(site, max_depth=1, max_pages=4)

    assert len(result.pages) == 4
    assert result.stopped_reason == "page limit"
    assert result.not_fetched == 7
    assert len(result.inventory) == 7
    assert "stopped at the 4-page limit" in result.summary()


def test_one_bad_page_is_counted_and_never_raises() -> None:
    site = SyntheticSite(
        {
            "/": page("Home", ("/broken", "Broken"), ("/empty", "Empty"), ("/ok", "Fine")),
            "/broken": (500, HTML, "oops"),
            "/empty": (200, "application/octet-stream", ""),
            "/ok": page("Fine"),
        }
    )

    result = crawl(site, max_depth=1)

    assert [item.title for item in result.pages] == ["Home", "Fine"]
    assert result.failed == 2
    assert "2 could not be read" in result.summary()


def test_redirects_to_other_sites_and_duplicate_pages_are_skipped() -> None:
    site = SyntheticSite(
        {
            "/": page("Home", ("/out", "Out"), ("/alias", "Alias"), ("/real", "Real")),
            "/out": (302, HTML, "https://elsewhere.test/landing"),
            "/alias": (302, HTML, "https://www.site.test/real"),
            "/real": page("Real"),
        }
    )
    elsewhere = httpx.MockTransport(
        lambda request: httpx.Response(200, headers={"content-type": HTML}, content=page("Elsewhere").encode(), request=request)
    )

    def routed(request: httpx.Request) -> httpx.Response:
        if request.url.host == "elsewhere.test":
            return elsewhere.handle_request(request)
        return site(request)

    result = crawl_site("https://www.site.test/", limits=CrawlLimits(max_depth=1), transport=httpx.MockTransport(routed))

    assert [item.title for item in result.pages] == ["Home", "Real"]
    assert result.skipped == 2


def test_start_page_failure_raises_an_honest_error() -> None:
    site = SyntheticSite({"/": (404, HTML, "gone")})

    with pytest.raises(WebFetchError) as raised:
        crawl(site)

    assert raised.value.status_code == 502


def test_time_budget_stops_scheduling_new_pages() -> None:
    now = [0.0]

    def advance(_request: httpx.Request) -> None:
        now[0] += 50.0

    site = SyntheticSite({"/": page("Home", ("/a", "A"), ("/b", "B"))}, on_request=advance)

    result = crawl_site(
        "https://www.site.test/",
        limits=CrawlLimits(max_depth=1, time_budget_seconds=90),
        transport=site.transport(),
        clock=lambda: now[0],
    )

    assert [item.title for item in result.pages] == ["Home"]
    assert result.stopped_reason == "time limit"
    assert {link.url for link in result.inventory} == {"https://www.site.test/a", "https://www.site.test/b"}


def test_total_byte_budget_stops_the_crawl() -> None:
    filler = "x" * 4000
    site = SyntheticSite(
        {
            "/": page("Home", ("/a", "A"), ("/b", "B"), body=filler),
            "/a": page("A", body=filler),
            "/b": page("B", body=filler),
        }
    )

    result = crawl(site, max_depth=1, max_total_bytes=5000, max_workers=1)

    assert len(result.pages) == 2
    assert result.stopped_reason == "size limit"


def test_limits_are_clamped_to_safe_ranges() -> None:
    limits = CrawlLimits(max_pages=1000, max_depth=9, max_workers=20)
    assert (limits.max_pages, limits.max_depth, limits.max_workers) == (100, 3, 4)
    tiny = CrawlLimits(max_pages=0, max_depth=-1, max_workers=0)
    assert (tiny.max_pages, tiny.max_depth, tiny.max_workers) == (1, 0, 1)


def test_search_form_is_kept_only_when_it_stays_on_the_site() -> None:
    site = SyntheticSite(
        {
            "/": '<form action="https://search.elsewhere.test/"><input type="search" name="q"></form><a href="/b">B</a>',
            "/b": '<form action="/find"><input name="q"></form><p>B</p>',
        }
    )

    result = crawl(site, max_depth=1)

    assert result.search_form == SearchForm(action="https://www.site.test/find", param="q")


def test_single_page_result_builds_inventory_from_the_page_links() -> None:
    fetched = FetchedWebSource(
        requested_url="https://site.test/start",
        final_url="https://www.site.test/start",
        filename="start.html",
        content_type=HTML,
        text="Start text",
        byte_count=10,
        title="Start",
        links=(
            PageLink("https://www.site.test/start#top", "Top"),
            PageLink("https://site.test/next?utm_medium=x", "Next"),
            PageLink("https://site.test/login", "Sign in"),
            PageLink("https://other.test/", "Other"),
        ),
        search_form=SearchForm("https://site.test/search", "q"),
    )

    result = single_page_result("https://site.test/start", fetched)

    assert [(item.url, item.title, item.depth) for item in result.pages] == [("https://www.site.test/start", "Start", 0)]
    assert result.inventory == (PageLink("https://site.test/next", "Next"),)
    assert result.search_form == SearchForm("https://site.test/search", "q")
    assert result.summary() == "Read 1 page. 1 more same-site link is saved for live lookups."


def test_recipe_settings_round_trip_and_tolerate_junk() -> None:
    links = (PageLink("https://site.test/a", "A"), PageLink("https://site.test/b", ""))
    form = SearchForm("https://site.test/search", "q", (("lang", "en"),))

    assert links_from_settings(links_to_settings(links)) == links
    assert search_form_from_settings(search_form_to_settings(form)) == form
    assert links_from_settings([{"url": "javascript:alert(1)"}, "junk", {"text": "no url"}, None]) == ()
    assert links_from_settings("not a list") == ()
    assert search_form_from_settings({"action": "ftp://x", "param": "q"}) is None
    assert search_form_from_settings({"action": "https://site.test/s"}) is None
    assert search_form_from_settings(None) is None
    assert search_form_to_settings(None) is None


def test_crawl_recipe_fields_round_trip_through_site_recipes() -> None:
    result = CrawlResult(
        start_url="https://www.site.test/",
        site_name="Site",
        pages=(CrawledPage("https://www.site.test/", "Home", "", "Home", 0), CrawledPage("https://www.site.test/a", "A", "", "A", 1)),
        inventory=(PageLink("https://www.site.test/b", "B"),),
        search_form=SearchForm("https://www.site.test/search", "q"),
    )
    fields = crawl_recipe_fields(result, crawl_depth=2, max_pages=40, live_lookup=True)
    stored = {"document_id": "doc-1", "kind": "web", "name": "Site", "url": "https://site.test/", "refresh": True, **fields}

    [recipe] = site_recipes({"linked_sources": [stored, {"kind": "api", "document_id": "doc-api"}, "junk"]})

    assert fields["page_count"] == 2
    assert (recipe.document_id, recipe.crawl_depth, recipe.max_pages, recipe.live_lookup) == ("doc-1", 2, 40, True)
    assert recipe.inventory == result.inventory
    assert recipe.search_form == result.search_form
    assert recipe.indexed_urls == frozenset({"https://site.test/", "https://www.site.test/", "https://www.site.test/a"})


def test_site_recipes_default_legacy_and_invalid_values_safely() -> None:
    legacy = {"document_id": "doc-old", "kind": "web", "name": "Old", "url": "https://site.test/", "refresh": True}
    odd = {**legacy, "document_id": "doc-odd", "crawl_depth": True, "max_pages": 9999, "pages": "nope", "live_lookup": "yes"}

    old, weird = site_recipes({"linked_sources": [legacy, odd, {**legacy, "document_id": ""}]})

    assert (old.crawl_depth, old.max_pages, old.live_lookup, old.inventory, old.pages) == (0, 25, False, (), ())
    assert (weird.crawl_depth, weird.max_pages, weird.live_lookup, weird.pages) == (0, 100, False, ())
    assert site_recipes({}) == [] and site_recipes({"linked_sources": "x"}) == []
