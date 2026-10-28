"""Bounded, polite same-site crawl for knowledge web sources.

Starting from the page a user added, the crawler reads pages on the same site
(the same host, with a leading ``www.`` ignored) breadth first. It respects
robots.txt for every page except the one the user asked for, seeds discovery
from the site's sitemap, and stays inside hard limits on pages, depth, time,
concurrency, and downloaded bytes. A page that fails is counted, never raised;
only a failure of the requested page itself is an error.

Every fetch goes through :mod:`app.core.web_fetch`, so the SSRF egress guard
checks each request and redirect hop, including robots.txt and sitemaps. No
cookies or credentials are ever sent; userinfo in discovered links is dropped.

Worker threads only fetch. All crawl state lives in the calling thread, so
there is a single writer and nothing is shared between workers.
"""

from __future__ import annotations

import html
import re
import time
from collections import deque
from collections.abc import Callable, Iterable
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from functools import partial
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

import httpx

from app.core.html_extract import PageLink, SearchForm
from app.core.knowledge_ingestion import decode_text
from app.core.web_fetch import (
    FetchedResource,
    FetchedWebSource,
    WebFetchError,
    fetch_web_resource,
    fetch_web_source,
)

CRAWLER_USER_AGENT = "ApertureChat-KnowledgeIndexer/0.1"
DEFAULT_MAX_PAGES = 25
MAX_PAGES_CAP = 100
DEFAULT_MAX_DEPTH = 1
MAX_DEPTH_CAP = 3
MAX_CRAWL_WORKERS = 4
MAX_INVENTORY_LINKS = 300
_MAX_DISCOVERED_LINKS = 5000
_MAX_ROBOTS_BYTES = 512 * 1024
_MAX_SITEMAP_BYTES = 5 * 1024 * 1024
_MAX_SITEMAP_FILES = 4
_DEFAULT_PORTS = {"http": 80, "https": 443}

_TRACKING_PARAMS = frozenset({"dclid", "fbclid", "gclid", "igshid", "mc_cid", "mc_eid", "msclkid", "yclid"})
# Media, archives, fonts, and assets are never indexable. PDFs, current Office
# formats, and text files are, so they are crawled like pages.
_SKIP_EXTENSIONS = frozenset(
    {
        ".7z", ".apk", ".avi", ".avif", ".bin", ".bmp", ".css", ".dmg", ".doc", ".eot", ".exe", ".flac",
        ".gif", ".gz", ".ico", ".iso", ".jpeg", ".jpg", ".js", ".json", ".m4a", ".m4v", ".mkv", ".mov",
        ".mp3", ".mp4", ".mpeg", ".msi", ".ogg", ".otf", ".png", ".ppt", ".rar", ".rss", ".svg", ".tar",
        ".tgz", ".tif", ".tiff", ".ttf", ".wav", ".webm", ".webp", ".woff", ".woff2", ".xls", ".xml", ".zip",
    }
)
_SIGN_IN_OR_COMMERCE_PATH = re.compile(
    r"(?:^|/)(?:log-?in|log-?out|sign-?in|sign-?out|sign-?up|register|cart|basket|checkout|"
    r"my-?account|account|wp-admin|wp-login\.php|auth|oauth2?|sso|password-reset)(?:/|$|\.)",
    re.IGNORECASE,
)
_SIGN_IN_QUERY = re.compile(
    r"(?:^|&)(?:action|do|mode)=(?:log-?in|log-?out|sign-?in|sign-?out|register)(?:&|$)",
    re.IGNORECASE,
)
_SITEMAP_LOC = re.compile(r"<loc>\s*([^<]+?)\s*</loc>", re.IGNORECASE)


def _clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, int(value)))


@dataclass(frozen=True, slots=True)
class CrawlLimits:
    """Crawl bounds; out-of-range values are clamped to the safe range."""

    max_pages: int = DEFAULT_MAX_PAGES
    max_depth: int = DEFAULT_MAX_DEPTH
    fetch_timeout_seconds: float = 10.0
    time_budget_seconds: float = 90.0
    max_workers: int = MAX_CRAWL_WORKERS
    max_total_bytes: int = 40 * 1024 * 1024
    max_inventory: int = MAX_INVENTORY_LINKS
    max_sitemap_urls: int = 500

    def __post_init__(self) -> None:
        object.__setattr__(self, "max_pages", _clamp(self.max_pages, 1, MAX_PAGES_CAP))
        object.__setattr__(self, "max_depth", _clamp(self.max_depth, 0, MAX_DEPTH_CAP))
        object.__setattr__(self, "max_workers", _clamp(self.max_workers, 1, MAX_CRAWL_WORKERS))


@dataclass(frozen=True, slots=True)
class CrawledPage:
    url: str
    title: str
    description: str
    text: str
    depth: int


@dataclass(frozen=True, slots=True)
class CrawlResult:
    start_url: str
    site_name: str
    pages: tuple[CrawledPage, ...]
    inventory: tuple[PageLink, ...] = ()
    search_form: SearchForm | None = None
    robots_blocked: int = 0
    failed: int = 0
    skipped: int = 0
    not_fetched: int = 0
    stopped_reason: str = ""
    max_pages: int = DEFAULT_MAX_PAGES

    def summary(self, *, include_inventory: bool = True) -> str:
        """An honest one- or two-sentence account of what was read and skipped."""

        count = len(self.pages)
        read = f"Read {count} page{'' if count == 1 else 's'}{self._stop_note()}"
        notes = [
            f"{number} {label}"
            for number, label in (
                (self.robots_blocked, "skipped by robots.txt"),
                (self.failed, "could not be read"),
                (self.skipped, "skipped as duplicates or redirects off the site"),
            )
            if number
        ]
        sentence = "; ".join([read, *notes]) + "."
        note = self.inventory_note() if include_inventory else ""
        return f"{sentence} {note}" if note else sentence

    def inventory_note(self) -> str:
        saved = len(self.inventory)
        if not saved:
            return ""
        return f"{saved} more same-site link{' is' if saved == 1 else 's are'} saved for live lookups."

    def _stop_note(self) -> str:
        return {
            "page limit": f" (stopped at the {self.max_pages}-page limit)",
            "time limit": " (stopped at the time limit)",
            "size limit": " (stopped at the download size limit)",
        }.get(self.stopped_reason, "")


# -- URL policy ---------------------------------------------------------------


def normalize_url(url: str) -> str | None:
    """Canonical form for crawl dedupe, or None for anything but http(s) URLs.

    Lowercases scheme and host, drops default ports, fragments, userinfo, and
    tracking parameters. Other query strings are kept byte for byte.
    """

    try:
        parts = urlsplit((url or "").strip())
        port = parts.port
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    host = parts.hostname
    if scheme not in _DEFAULT_PORTS or not host:
        return None
    netloc = f"[{host}]" if ":" in host else host
    if port is not None and port != _DEFAULT_PORTS[scheme]:
        netloc = f"{netloc}:{port}"
    return urlunsplit((scheme, netloc, parts.path or "/", _without_tracking(parts.query), ""))


def _without_tracking(query: str) -> str:
    pairs = parse_qsl(query, keep_blank_values=True)
    kept = [(key, value) for key, value in pairs if not _is_tracking(key)]
    return query if len(kept) == len(pairs) else urlencode(kept)


def _is_tracking(key: str) -> bool:
    lowered = key.lower()
    return lowered.startswith("utm_") or lowered in _TRACKING_PARAMS


def _site_key(url: str) -> str | None:
    normalized = normalize_url(url)
    if normalized is None:
        return None
    netloc = urlsplit(normalized).netloc
    return netloc[4:] if netloc.startswith("www.") else netloc


def site_keys(*urls: str) -> frozenset[str]:
    """The site identities of the given URLs (host and port, ``www.`` ignored)."""

    return frozenset(key for key in (_site_key(url) for url in urls) if key)


def same_site(url: str, keys: frozenset[str]) -> bool:
    return _site_key(url) in keys


def crawlable_link(url: str) -> bool:
    """False for sign-in, account, and commerce flows and for non-text media."""

    parts = urlsplit(url)
    path = unquote(parts.path)
    if PurePosixPath(path).suffix.lower() in _SKIP_EXTENSIONS:
        return False
    return not (_SIGN_IN_OR_COMMERCE_PATH.search(path) or _SIGN_IN_QUERY.search(parts.query))


def site_link_inventory(
    keys: frozenset[str],
    links: Iterable[PageLink],
    *,
    exclude: Iterable[str] = (),
    allowed: Callable[[str], bool] | None = None,
    limit: int = MAX_INVENTORY_LINKS,
) -> tuple[PageLink, ...]:
    """Normalized, deduplicated same-site links worth fetching later, in order."""

    excluded = set(exclude)
    inventory: dict[str, str] = {}
    for link in links:
        url = _inventory_url(link, keys, excluded, allowed)
        if not url:
            continue
        if url in inventory:
            inventory[url] = inventory[url] or link.text
        elif len(inventory) < limit:
            inventory[url] = link.text
    return tuple(PageLink(url, text) for url, text in inventory.items())


def _inventory_url(
    link: PageLink,
    keys: frozenset[str],
    excluded: set[str],
    allowed: Callable[[str], bool] | None,
) -> str | None:
    url = normalize_url(link.url)
    if not url or url in excluded or not same_site(url, keys) or not crawlable_link(url):
        return None
    return url if allowed is None or allowed(url) else None


# -- robots.txt and sitemaps --------------------------------------------------


@dataclass(frozen=True, slots=True)
class RobotsRules:
    parser: RobotFileParser
    user_agent: str

    def allows(self, url: str) -> bool:
        return self.parser.can_fetch(self.user_agent, url)

    @property
    def sitemaps(self) -> tuple[str, ...]:
        return tuple(self.parser.site_maps() or ())


def read_robots(
    origin: str, fetch_resource: Callable[[str], FetchedResource], user_agent: str
) -> RobotsRules:
    """RFC 9309: a missing file allows everything; an unreachable one allows nothing."""

    parser = RobotFileParser()
    try:
        resource = fetch_resource(f"{origin}/robots.txt")
    except WebFetchError:
        parser.disallow_all = True
        return RobotsRules(parser, user_agent)
    if resource.status_code >= 500:
        parser.disallow_all = True
    elif resource.status_code >= 300:
        parser.allow_all = True
    else:
        parser.parse(decode_text(resource.content).splitlines())
    return RobotsRules(parser, user_agent)


def read_sitemap_urls(
    sitemap_urls: Iterable[str],
    fetch_resource: Callable[[str], FetchedResource],
    *,
    keys: frozenset[str],
    allowed: Callable[[str], bool],
    max_urls: int,
    has_time: Callable[[], bool],
) -> list[str]:
    """Page URLs listed by the site's sitemaps, following one level of sitemap index."""

    pending = deque(sitemap_urls)
    found: list[str] = []
    files = 0
    while pending and files < _MAX_SITEMAP_FILES and len(found) < max_urls and has_time():
        sitemap_url = pending.popleft()
        if not same_site(sitemap_url, keys) or sitemap_url.endswith(".gz") or not allowed(sitemap_url):
            continue
        files += 1
        body = _sitemap_body(sitemap_url, fetch_resource)
        locations = [html.unescape(match) for match in _SITEMAP_LOC.findall(body)]
        if "<sitemapindex" in body[:2000].lower():
            pending.extend(locations)
        else:
            found.extend(locations)
    return found[:max_urls]


def _sitemap_body(url: str, fetch_resource: Callable[[str], FetchedResource]) -> str:
    try:
        resource = fetch_resource(url)
    except WebFetchError:
        return ""
    return decode_text(resource.content) if resource.status_code < 300 else ""


# -- crawl --------------------------------------------------------------------


def crawl_site(
    start_url: str,
    *,
    limits: CrawlLimits = CrawlLimits(),
    user_agent: str = CRAWLER_USER_AGENT,
    transport: httpx.BaseTransport | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> CrawlResult:
    """Crawl the site around ``start_url``. Raises WebFetchError only if that page fails."""

    fetch_page = partial(
        fetch_web_source,
        user_agent=user_agent,
        timeout_seconds=limits.fetch_timeout_seconds,
        transport=transport,
    )
    fetch_resource = partial(
        fetch_web_resource,
        max_bytes=_MAX_SITEMAP_BYTES,
        user_agent=user_agent,
        timeout_seconds=limits.fetch_timeout_seconds,
        transport=transport,
    )
    return _Crawl(start_url, limits, fetch_page, fetch_resource, clock, user_agent).run()


def single_page_result(requested_url: str, fetched: FetchedWebSource) -> CrawlResult:
    """Describe a one-page read the same way a crawl is described."""

    final_url = normalize_url(fetched.final_url) or fetched.final_url
    keys = site_keys(requested_url, fetched.final_url)
    form = fetched.search_form
    return CrawlResult(
        start_url=requested_url,
        site_name=fetched.site_name or fetched.title,
        pages=(CrawledPage(final_url, fetched.title, fetched.description, fetched.text, 0),),
        inventory=site_link_inventory(
            keys, fetched.links, exclude={final_url, normalize_url(requested_url) or ""}
        ),
        search_form=form if form is not None and same_site(form.action, keys) else None,
        max_pages=1,
    )


class _Crawl:
    def __init__(
        self,
        start_url: str,
        limits: CrawlLimits,
        fetch_page: Callable[[str], FetchedWebSource],
        fetch_resource: Callable[[str], FetchedResource],
        clock: Callable[[], float],
        user_agent: str,
    ) -> None:
        self.start_url = start_url.strip()
        self.limits = limits
        self.fetch_page = fetch_page
        self.fetch_resource = fetch_resource
        self.clock = clock
        self.user_agent = user_agent
        self.deadline = clock() + limits.time_budget_seconds
        self.keys = site_keys(self.start_url)
        self.robots = RobotsRules(RobotFileParser(), user_agent)
        self.queue: deque[tuple[str, int]] = deque()
        self.order: dict[str, int] = {}
        self.discovered: dict[str, str] = {}
        self.fetched: set[str] = set()
        self.blocked: set[str] = set()
        self.pages: list[tuple[int, int, CrawledPage]] = []
        self.search_form: SearchForm | None = None
        self.site_name = ""
        self.total_bytes = 0
        self.failed = 0
        self.skipped = 0
        self.stopped_reason = ""

    def run(self) -> CrawlResult:
        start = self.fetch_page(self.start_url)
        self.keys = site_keys(self.start_url, start.final_url)
        origin = _origin(start.final_url)
        self.robots = read_robots(origin, self.fetch_resource, self.user_agent)
        self.site_name = start.site_name or start.title
        self._accept(self.start_url, 0, start)
        if self.limits.max_depth > 0:
            self._seed_from_sitemaps(origin)
        self._drain()
        return self._result()

    def _remaining(self) -> float:
        return self.deadline - self.clock()

    def _seed_from_sitemaps(self, origin: str) -> None:
        sitemap_urls = self.robots.sitemaps or (f"{origin}/sitemap.xml",)
        for location in read_sitemap_urls(
            sitemap_urls,
            self.fetch_resource,
            keys=self.keys,
            allowed=self.robots.allows,
            max_urls=self.limits.max_sitemap_urls,
            has_time=lambda: self._remaining() > 0,
        ):
            self._discover(PageLink(location, ""), 1)

    def _discover(self, link: PageLink, depth: int) -> None:
        url = normalize_url(link.url)
        if not url or not same_site(url, self.keys) or not crawlable_link(url):
            return
        if url in self.discovered:
            self.discovered[url] = self.discovered[url] or link.text
        elif len(self.discovered) < _MAX_DISCOVERED_LINKS:
            self.discovered[url] = link.text
        if url in self.order or depth > self.limits.max_depth:
            return
        self.order[url] = len(self.order)
        self.queue.append((url, depth))

    def _accept(self, url: str, depth: int, fetched: FetchedWebSource) -> None:
        final_url = normalize_url(fetched.final_url) or url
        if not same_site(final_url, self.keys) or final_url in self.fetched:
            self.skipped += 1
            return
        self.fetched.update({final_url, url})
        self.order.setdefault(final_url, len(self.order))
        self.total_bytes += fetched.byte_count
        page = CrawledPage(final_url, fetched.title, fetched.description, fetched.text, depth)
        self.pages.append((depth, self.order.get(url, self.order[final_url]), page))
        self._consider_search_form(fetched.search_form)
        for link in fetched.links:
            self._discover(link, depth + 1)

    def _consider_search_form(self, form: SearchForm | None) -> None:
        if self.search_form is None and form is not None:
            if same_site(form.action, self.keys) and self.robots.allows(form.action):
                self.search_form = form

    def _drain(self) -> None:
        pool = ThreadPoolExecutor(max_workers=self.limits.max_workers, thread_name_prefix="site-crawl")
        in_flight: dict[Future[FetchedWebSource], tuple[str, int]] = {}
        try:
            while True:
                self._schedule(pool, in_flight)
                if not in_flight:
                    return
                done, _pending = wait(in_flight, timeout=max(0.0, self._remaining()), return_when=FIRST_COMPLETED)
                if not done:
                    self.stopped_reason = "time limit"
                    return
                for future in done:
                    url, depth = in_flight.pop(future)
                    self._collect(url, depth, future)
        finally:
            # Abandoned fetches finish on their own per-request timeout.
            pool.shutdown(wait=False, cancel_futures=True)

    def _schedule(
        self, pool: ThreadPoolExecutor, in_flight: dict[Future[FetchedWebSource], tuple[str, int]]
    ) -> None:
        while self.queue and len(in_flight) < self.limits.max_workers:
            reason = self._stop_reason(len(in_flight))
            if reason:
                self.stopped_reason = reason
                return
            url, depth = self.queue.popleft()
            if url in self.fetched:
                continue
            if not self.robots.allows(url):
                self.blocked.add(url)
                continue
            in_flight[pool.submit(self.fetch_page, url)] = (url, depth)

    def _stop_reason(self, in_flight: int) -> str:
        if len(self.pages) + in_flight >= self.limits.max_pages:
            return "page limit"
        if self.total_bytes >= self.limits.max_total_bytes:
            return "size limit"
        if self._remaining() <= 0:
            return "time limit"
        return ""

    def _collect(self, url: str, depth: int, future: Future[FetchedWebSource]) -> None:
        try:
            fetched = future.result()
        except Exception:  # noqa: BLE001 - one bad page never ends the crawl
            self.failed += 1
            return
        self._accept(url, depth, fetched)

    def _result(self) -> CrawlResult:
        unread = [
            PageLink(url, text)
            for url, text in self.discovered.items()
            if url not in self.fetched and url not in self.blocked
        ]
        inventory = site_link_inventory(
            self.keys, unread, allowed=self.robots.allows, limit=self.limits.max_inventory
        )
        return CrawlResult(
            start_url=self.start_url,
            site_name=self.site_name,
            pages=tuple(page for _depth, _order, page in sorted(self.pages, key=lambda item: item[:2])),
            inventory=inventory,
            search_form=self.search_form,
            robots_blocked=len(self.blocked),
            failed=self.failed,
            skipped=self.skipped,
            not_fetched=sum(1 for link in unread if self.robots.allows(link.url)),
            stopped_reason=self.stopped_reason,
            max_pages=self.limits.max_pages,
        )


def _origin(url: str) -> str:
    parts = urlsplit(normalize_url(url) or url)
    return f"{parts.scheme}://{parts.netloc}"


# -- linked-source recipe fields ----------------------------------------------


def links_to_settings(links: Iterable[PageLink]) -> list[dict[str, str]]:
    return [{"url": link.url, "text": link.text} for link in links]


def links_from_settings(raw: Any, *, limit: int = MAX_INVENTORY_LINKS) -> tuple[PageLink, ...]:
    if not isinstance(raw, list):
        return ()
    links: list[PageLink] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        url = normalize_url(str(item.get("url") or ""))
        if url:
            links.append(PageLink(url, str(item.get("text") or "")))
        if len(links) >= limit:
            break
    return tuple(links)


def search_form_to_settings(form: SearchForm | None) -> dict[str, Any] | None:
    if form is None:
        return None
    return {"action": form.action, "param": form.param, "fixed": [list(pair) for pair in form.fixed]}


def search_form_from_settings(raw: Any) -> SearchForm | None:
    if not isinstance(raw, dict):
        return None
    action = normalize_url(str(raw.get("action") or ""))
    param = str(raw.get("param") or "").strip()
    if not action or not param:
        return None
    fixed = tuple(
        (str(pair[0]), str(pair[1]))
        for pair in raw.get("fixed") or ()
        if isinstance(pair, (list, tuple)) and len(pair) == 2
    )
    return SearchForm(action=action, param=param, fixed=fixed)


LINKED_SOURCES_KEY = "linked_sources"


@dataclass(frozen=True, slots=True)
class SiteRecipe:
    """The crawl and live-lookup fields of one stored web-source refresh recipe."""

    document_id: str
    url: str
    crawl_depth: int
    max_pages: int
    live_lookup: bool
    inventory: tuple[PageLink, ...]
    pages: tuple[str, ...]
    search_form: SearchForm | None

    @property
    def indexed_urls(self) -> frozenset[str]:
        return frozenset(url for url in (normalize_url(value) for value in (self.url, *self.pages)) if url)


def crawl_recipe_fields(
    result: CrawlResult, *, crawl_depth: int, max_pages: int, live_lookup: bool
) -> dict[str, Any]:
    """Recipe fields that let Sync repeat this read and live lookups look further."""

    # The inventory and search form only serve live lookups, so a source with
    # live lookup off does not carry them in its settings.
    return {
        "crawl_depth": crawl_depth,
        "max_pages": max_pages,
        "live_lookup": live_lookup,
        "page_count": len(result.pages),
        "pages": [page.url for page in result.pages],
        "inventory": links_to_settings(result.inventory) if live_lookup else [],
        "site_search": search_form_to_settings(result.search_form) if live_lookup else None,
    }


def site_recipe(raw: Any) -> SiteRecipe | None:
    """Parse a stored web recipe; recipes saved before crawling existed read as one page."""

    if not isinstance(raw, dict) or raw.get("kind") != "web":
        return None
    pages = raw.get("pages")
    return SiteRecipe(
        document_id=str(raw.get("document_id") or ""),
        url=str(raw.get("url") or ""),
        crawl_depth=_int_setting(raw.get("crawl_depth"), 0, 0, MAX_DEPTH_CAP),
        max_pages=_int_setting(raw.get("max_pages"), DEFAULT_MAX_PAGES, 1, MAX_PAGES_CAP),
        live_lookup=raw.get("live_lookup") is True,
        inventory=links_from_settings(raw.get("inventory")),
        pages=tuple(url for url in pages if isinstance(url, str)) if isinstance(pages, list) else (),
        search_form=search_form_from_settings(raw.get("site_search")),
    )


def site_recipes(settings: dict[str, Any]) -> list[SiteRecipe]:
    raw = settings.get(LINKED_SOURCES_KEY)
    if not isinstance(raw, list):
        return []
    recipes = (site_recipe(item) for item in raw)
    return [recipe for recipe in recipes if recipe is not None and recipe.document_id]


def _int_setting(value: Any, default: int, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return default
    return _clamp(value, low, high)
