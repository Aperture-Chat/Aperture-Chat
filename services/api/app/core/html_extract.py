"""Structured, dependency-free HTML extraction for knowledge indexing and crawling.

One pass of the standard-library parser produces the page's metadata (title,
description, site name, canonical URL, author, published date), its readable
text, every outbound http(s) link with its anchor text, and a GET search form
when the page has one.

Readable text prefers the main region (``<main>``, ``<article>``, or
``role="main"``) when the page marks one; navigation, footers, and asides are
then treated as boilerplate. Pages without a main region keep all visible text
so nothing on a simple page is lost. Scripts, styles, templates, SVG, and
hidden elements never contribute text. Headings become markdown-style lines,
list items become ``- item`` lines, and table rows become ``cell | cell``
lines, each separated by a blank line so the chunker keeps them intact.

Links are collected from the whole document, including navigation, because
navigation is where a site's other sections are found.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Any, Callable
from urllib.parse import urldefrag, urlencode, urljoin, urlsplit, urlunsplit

MAX_PAGE_LINKS = 2000
_MAX_ANCHOR_CHARS = 200
_MAX_JSON_LD_CHARS = 200_000

_SKIP_TAGS = frozenset(
    {"canvas", "datalist", "iframe", "noscript", "object", "script", "select", "style", "svg", "template"}
)
_VOID_TAGS = frozenset(
    {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
)
_BLOCK_TAGS = frozenset(
    {
        "address", "article", "aside", "blockquote", "body", "caption", "dd", "details", "dialog", "div",
        "dl", "dt", "fieldset", "figcaption", "figure", "footer", "header", "hgroup", "hr", "main", "nav",
        "ol", "p", "pre", "section", "summary", "ul",
    }
)
_HEADING_LEVELS = {f"h{level}": level for level in range(1, 7)}
_BOILERPLATE_TAGS = frozenset({"aside", "footer", "nav"})
_BOILERPLATE_ROLES = frozenset({"complementary", "contentinfo", "navigation"})
_MAIN_TAGS = frozenset({"article", "main"})
_TEXT_INPUT_TYPES = frozenset({"", "search", "text"})
_NON_SEARCH_INPUT_TYPES = frozenset({"email", "file", "password", "textarea"})
_SEARCH_PARAM_NAMES = frozenset(
    {"k", "keyword", "keywords", "kw", "q", "qs", "query", "s", "search", "search_query", "searchterm", "term"}
)
_SEARCH_PATH_WORDS = ("search", "find", "lookup", "query")
_LD_NON_CONTENT_TYPES = frozenset(
    {"breadcrumblist", "imageobject", "organization", "person", "searchaction", "website"}
)

# Metadata keys in priority order; ``<title>`` and JSON-LD fill gaps after these.
_TITLE_KEYS = ("og:title", "twitter:title", "citation_title", "dc.title")
_DESCRIPTION_KEYS = ("description", "og:description", "twitter:description", "dc.description")
_SITE_NAME_KEYS = ("og:site_name", "application-name")
_AUTHOR_KEYS = ("author", "article:author", "citation_author", "dc.creator", "byl")
_PUBLISHED_KEYS = (
    "article:published_time",
    "citation_publication_date",
    "citation_date",
    "datepublished",
    "date",
    "pubdate",
    "dc.date",
    "og:published_time",
)


@dataclass(frozen=True, slots=True)
class PageLink:
    """An absolute http(s) link and the text a reader would click."""

    url: str
    text: str = ""


@dataclass(frozen=True, slots=True)
class SearchForm:
    """A GET search form: submitting ``param=<query>`` to ``action`` runs the site's search."""

    action: str
    param: str
    fixed: tuple[tuple[str, str], ...] = ()

    def url_for(self, query: str) -> str:
        # A GET submission replaces the action's own query string, as browsers do.
        parts = urlsplit(self.action)
        query_string = urlencode([*self.fixed, (self.param, query)])
        return urlunsplit((parts.scheme, parts.netloc, parts.path, query_string, ""))


@dataclass(frozen=True, slots=True)
class HtmlPage:
    title: str = ""
    description: str = ""
    site_name: str = ""
    canonical_url: str = ""
    author: str = ""
    published: str = ""
    body: str = ""
    links: tuple[PageLink, ...] = ()
    search_form: SearchForm | None = None

    @property
    def text(self) -> str:
        """Indexable text: title first, then byline, description, and the body."""

        blocks = self.body.split("\n\n") if self.body else []
        if self.title and blocks and _heading_text(blocks[0]) == self.title.casefold():
            blocks = blocks[1:]
        byline = " · ".join(
            f"{label}: {value}"
            for label, value in (("Author", self.author), ("Published", self.published))
            if value
        )
        description = self.description if self.description not in self.body else ""
        return "\n\n".join(part for part in (self.title, byline, description, *blocks) if part)


def parse_html(html: str, *, base_url: str | None = None) -> HtmlPage:
    """Parse one HTML document. Relative links resolve against ``base_url``."""

    parser = _Extractor(base_url)
    try:
        parser.feed(html)
        parser.close()
    except Exception:  # noqa: BLE001 - keep whatever a malformed document yielded
        pass
    return parser.page()


def _collapse(value: str) -> str:
    return " ".join(value.split())


def _heading_text(block: str) -> str:
    return block.lstrip("#").strip().casefold()


def _is_hidden(attributes: dict[str, str]) -> bool:
    style = attributes.get("style", "").replace(" ", "").lower()
    return (
        "hidden" in attributes
        or attributes.get("aria-hidden", "").lower() == "true"
        or "display:none" in style
    )


def _effect(tag: str, attributes: dict[str, str]) -> str:
    """How an element changes extraction while it is open: skip, boiler, main, or nothing."""

    if tag in _SKIP_TAGS or _is_hidden(attributes):
        return "skip"
    role = attributes.get("role", "").lower()
    if tag in _BOILERPLATE_TAGS or role in _BOILERPLATE_ROLES:
        return "boiler"
    if tag in _MAIN_TAGS or role == "main":
        return "main"
    return ""


def _http_url(url: str) -> str | None:
    absolute, _fragment = urldefrag(url)
    parts = urlsplit(absolute)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    return absolute


@dataclass(slots=True)
class _Open:
    tag: str
    effect: str
    content: bool


@dataclass(frozen=True, slots=True)
class _Block:
    text: str
    main: bool
    boiler: bool


@dataclass(frozen=True, slots=True)
class _Field:
    kind: str
    name: str
    value: str
    hint: str


@dataclass(slots=True)
class _FormDraft:
    action: str | None
    method: str
    search_hint: bool
    fields: list[_Field] = field(default_factory=list)

    def search_form(self) -> SearchForm | None:
        text_field = self._single_text_field()
        if self.method != "get" or not self.action or text_field is None:
            return None
        if not self._looks_like_search(text_field):
            return None
        fixed = tuple((item.name, item.value) for item in self.fields if item.kind == "hidden" and item.name)
        return SearchForm(action=self.action, param=text_field.name, fixed=fixed)

    def _single_text_field(self) -> _Field | None:
        """The form's only free-text field, or None when it has none, several, or a password."""
        if any(item.kind in _NON_SEARCH_INPUT_TYPES for item in self.fields):
            return None
        text_fields = [item for item in self.fields if item.kind in _TEXT_INPUT_TYPES and item.name]
        return text_fields[0] if len(text_fields) == 1 else None

    def _looks_like_search(self, text_field: _Field) -> bool:
        path = urlsplit(self.action or "").path.lower()
        return (
            self.search_hint
            or text_field.kind == "search"
            or text_field.name.lower() in _SEARCH_PARAM_NAMES
            or "search" in text_field.hint
            or any(word in path for word in _SEARCH_PATH_WORDS)
        )


class _Extractor(HTMLParser):
    def __init__(self, base_url: str | None) -> None:
        super().__init__(convert_charrefs=True)
        self._page_url = _http_url(base_url or "") or ""
        self._base = self._page_url
        self._stack: list[_Open] = []
        self._depth = {"skip": 0, "boiler": 0, "main": 0}
        self._blocks: list[_Block] = []
        self._buffer: list[str] = []
        self._prefix = ""
        self._table_depth = 0
        self._row: list[str] | None = None
        self._cell: list[str] | None = None
        self._anchor: tuple[str, list[str]] | None = None
        self._links: dict[str, str] = {}
        self._meta: dict[str, str] = {}
        self._canonical = ""
        self._title = ""
        self._title_parts: list[str] | None = None
        self._json_ld: list[str] | None = None
        self._json_ld_values: dict[str, str] = {}
        self._form: _FormDraft | None = None
        self._search_form: SearchForm | None = None

    # -- parser callbacks -------------------------------------------------

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {name.lower(): value or "" for name, value in attrs}
        head_handler = _HEAD_HANDLERS.get(tag)
        if head_handler is not None:
            head_handler(self, attributes)
            return
        effect = _effect(tag, attributes)
        content = self._depth["skip"] == 0 and effect != "skip"
        # Content handlers run before the element's effect starts, so text
        # flushed at a region boundary keeps the region it was written in.
        if content:
            self._open_content(tag, attributes)
        if tag not in _VOID_TAGS:
            self._stack.append(_Open(tag, effect, content))
            if effect:
                self._depth[effect] += 1
        if tag == "script" and "ld+json" in attributes.get("type", "").lower():
            self._json_ld = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._end_title()
            return
        if not any(open_element.tag == tag for open_element in self._stack):
            return
        while self._stack:
            open_element = self._stack.pop()
            self._close(open_element)
            if open_element.tag == tag:
                break

    def handle_data(self, data: str) -> None:
        if self._title_parts is not None:
            self._title_parts.append(data)
        elif self._json_ld is not None:
            if sum(len(part) for part in self._json_ld) < _MAX_JSON_LD_CHARS:
                self._json_ld.append(data)
        elif self._depth["skip"] == 0:
            self._append(data)

    def page(self) -> HtmlPage:
        while self._stack:
            self._close(self._stack.pop())
        self._flush()
        self._finish_anchor()
        return HtmlPage(
            title=self._title or self._first_meta(_TITLE_KEYS) or self._json_ld_values.get("title", ""),
            description=self._first_meta(_DESCRIPTION_KEYS) or self._json_ld_values.get("description", ""),
            site_name=self._first_meta(_SITE_NAME_KEYS),
            canonical_url=self._canonical,
            author=self._first_meta(_AUTHOR_KEYS, skip_urls=True) or self._json_ld_values.get("author", ""),
            published=self._first_meta(_PUBLISHED_KEYS) or self._json_ld_values.get("published", ""),
            body="\n\n".join(self._body_blocks()),
            links=tuple(PageLink(url, text) for url, text in self._links.items()),
            search_form=self._search_form,
        )

    # -- head metadata ----------------------------------------------------

    def _start_title(self, _attributes: dict[str, str]) -> None:
        if self._depth["skip"] == 0 and not self._title and self._title_parts is None:
            self._title_parts = []

    def _end_title(self) -> None:
        if self._title_parts is not None:
            self._title = _collapse("".join(self._title_parts))
            self._title_parts = None

    def _meta_tag(self, attributes: dict[str, str]) -> None:
        key = (attributes.get("property") or attributes.get("name") or attributes.get("itemprop") or "")
        key = key.strip().lower()
        content = _collapse(attributes.get("content", ""))
        if key and content and key not in self._meta:
            self._meta[key] = content

    def _link_tag(self, attributes: dict[str, str]) -> None:
        rel = attributes.get("rel", "").lower().split()
        if "canonical" in rel and not self._canonical:
            self._canonical = _http_url(urljoin(self._base, attributes.get("href", "").strip())) or ""

    def _base_tag(self, attributes: dict[str, str]) -> None:
        base = _http_url(urljoin(self._page_url, attributes.get("href", "").strip()))
        if base:
            self._base = base

    def _first_meta(self, keys: tuple[str, ...], *, skip_urls: bool = False) -> str:
        for key in keys:
            value = self._meta.get(key, "")
            if value and not (skip_urls and value.startswith(("http://", "https://"))):
                return value
        return ""

    # -- element content --------------------------------------------------

    def _open_content(self, tag: str, attributes: dict[str, str]) -> None:
        handler = _START_HANDLERS.get(tag)
        if handler is not None:
            handler(self, tag, attributes)
        elif tag in _BLOCK_TAGS:
            self._flush()

    def _close(self, open_element: _Open) -> None:
        if open_element.content:
            handler = _END_HANDLERS.get(open_element.tag)
            if handler is not None:
                handler(self)
            elif open_element.tag in _BLOCK_TAGS or open_element.tag in _HEADING_LEVELS:
                self._flush()
        if open_element.effect:
            self._depth[open_element.effect] -= 1
        if open_element.tag == "script" and self._json_ld is not None:
            self._json_ld_values = _json_ld_metadata("".join(self._json_ld))
            self._json_ld = None

    def _start_heading(self, tag: str, _attributes: dict[str, str]) -> None:
        self._flush()
        if self._cell is None:
            self._prefix = "#" * _HEADING_LEVELS[tag] + " "

    def _start_item(self, _tag: str, _attributes: dict[str, str]) -> None:
        self._flush()
        if self._cell is None:
            self._prefix = "- "

    def _line_break(self, _tag: str, _attributes: dict[str, str]) -> None:
        self._append(" ")

    def _image(self, _tag: str, attributes: dict[str, str]) -> None:
        alt = _collapse(attributes.get("alt", ""))
        if not alt:
            return
        self._write(f" [Image: {alt}] ")
        if self._anchor is not None:
            self._anchor[1].append(f" {alt} ")

    def _start_anchor(self, _tag: str, attributes: dict[str, str]) -> None:
        self._finish_anchor()
        href = attributes.get("href", "").strip()
        url = _http_url(urljoin(self._base, href)) if href else None
        if url and url != self._page_url:
            self._anchor = (url, [])

    def _end_anchor(self) -> None:
        self._finish_anchor()

    def _finish_anchor(self) -> None:
        if self._anchor is None:
            return
        url, parts = self._anchor
        self._anchor = None
        text = _collapse("".join(parts))[:_MAX_ANCHOR_CHARS]
        if url in self._links:
            if text and not self._links[url]:
                self._links[url] = text
        elif len(self._links) < MAX_PAGE_LINKS:
            self._links[url] = text

    # -- tables -----------------------------------------------------------

    def _start_table(self, _tag: str, _attributes: dict[str, str]) -> None:
        self._flush()
        self._table_depth += 1

    def _end_table(self) -> None:
        if self._table_depth == 1:
            self._finish_row()
        self._table_depth = max(0, self._table_depth - 1)

    def _start_row(self, _tag: str, _attributes: dict[str, str]) -> None:
        if self._table_depth == 1:
            self._finish_row()
            self._row = []

    def _end_row(self) -> None:
        if self._table_depth == 1:
            self._finish_row()

    def _start_cell(self, _tag: str, _attributes: dict[str, str]) -> None:
        if self._table_depth == 1:
            self._finish_cell()
            if self._row is None:
                self._row = []
            self._cell = []

    def _end_cell(self) -> None:
        if self._table_depth == 1:
            self._finish_cell()

    def _finish_cell(self) -> None:
        if self._cell is not None and self._row is not None:
            self._row.append(_collapse("".join(self._cell)))
        self._cell = None

    def _finish_row(self) -> None:
        self._finish_cell()
        row, self._row = self._row, None
        if row and any(row):
            self._emit(" | ".join(row))

    # -- forms ------------------------------------------------------------

    def _start_form(self, _tag: str, attributes: dict[str, str]) -> None:
        if self._form is not None:
            return
        markers = " ".join(attributes.get(name, "") for name in ("role", "id", "class")).lower()
        self._form = _FormDraft(
            action=_http_url(urljoin(self._base, attributes.get("action", "").strip())),
            method=(attributes.get("method") or "get").strip().lower(),
            search_hint="search" in markers,
        )
        self._flush()

    def _form_field(self, tag: str, attributes: dict[str, str]) -> None:
        if self._form is None:
            return
        kind = "textarea" if tag == "textarea" else attributes.get("type", "").strip().lower()
        hint = " ".join(attributes.get(name, "") for name in ("placeholder", "aria-label", "title", "id"))
        self._form.fields.append(
            _Field(kind=kind, name=attributes.get("name", "").strip(), value=attributes.get("value", ""), hint=hint.lower())
        )

    def _end_form(self) -> None:
        self._flush()
        form, self._form = self._form, None
        if form is not None and self._search_form is None:
            self._search_form = form.search_form()

    # -- text blocks ------------------------------------------------------

    def _append(self, text: str) -> None:
        self._write(text)
        if self._anchor is not None:
            self._anchor[1].append(text)

    def _write(self, text: str) -> None:
        if self._cell is not None:
            self._cell.append(text)
        else:
            self._buffer.append(text)

    def _flush(self) -> None:
        if self._cell is not None:
            self._cell.append(" ")
            return
        text = _collapse("".join(self._buffer))
        self._buffer.clear()
        if text:
            self._emit(self._prefix + text)
            self._prefix = ""

    def _emit(self, text: str) -> None:
        self._blocks.append(_Block(text, self._depth["main"] > 0, self._depth["boiler"] > 0))

    def _body_blocks(self) -> list[str]:
        if any(block.main for block in self._blocks):
            return [block.text for block in self._blocks if block.main and not block.boiler]
        return [block.text for block in self._blocks]


_HEAD_HANDLERS: dict[str, Callable[[_Extractor, dict[str, str]], None]] = {
    "base": _Extractor._base_tag,
    "link": _Extractor._link_tag,
    "meta": _Extractor._meta_tag,
    "title": _Extractor._start_title,
}
_START_HANDLERS: dict[str, Callable[[_Extractor, str, dict[str, str]], None]] = {
    "a": _Extractor._start_anchor,
    "br": _Extractor._line_break,
    "form": _Extractor._start_form,
    "img": _Extractor._image,
    "input": _Extractor._form_field,
    "li": _Extractor._start_item,
    "table": _Extractor._start_table,
    "td": _Extractor._start_cell,
    "textarea": _Extractor._form_field,
    "th": _Extractor._start_cell,
    "tr": _Extractor._start_row,
    **{tag: _Extractor._start_heading for tag in _HEADING_LEVELS},
}
_END_HANDLERS: dict[str, Callable[[_Extractor], None]] = {
    "a": _Extractor._end_anchor,
    "form": _Extractor._end_form,
    "li": _Extractor._flush,
    "table": _Extractor._end_table,
    "td": _Extractor._end_cell,
    "th": _Extractor._end_cell,
    "tr": _Extractor._end_row,
}


def _json_ld_metadata(raw: str) -> dict[str, str]:
    """Article-like metadata from a JSON-LD block, or nothing when it is not valid JSON."""

    try:
        data = json.loads(raw)
    except ValueError:
        return {}
    values: dict[str, str] = {}
    for item in _json_ld_items(data):
        candidates = {
            "title": _ld_text(item.get("headline")) or _ld_content_name(item),
            "description": _ld_text(item.get("description")),
            "published": _ld_text(item.get("datePublished")),
            "author": _ld_author(item.get("author")),
        }
        for key, value in candidates.items():
            if value and key not in values:
                values[key] = value
    return values


def _json_ld_items(data: Any) -> list[dict[str, Any]]:
    items = data if isinstance(data, list) else [data]
    expanded: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        graph = item.get("@graph")
        if isinstance(graph, list):
            expanded.extend(entry for entry in graph if isinstance(entry, dict))
        else:
            expanded.append(item)
    return expanded


def _ld_text(value: Any) -> str:
    return _collapse(value) if isinstance(value, str) else ""


def _ld_content_name(item: dict[str, Any]) -> str:
    kinds = item.get("@type")
    kind_list = kinds if isinstance(kinds, list) else [kinds]
    if any(str(kind).lower() in _LD_NON_CONTENT_TYPES for kind in kind_list):
        return ""
    return _ld_text(item.get("name"))


def _ld_author(value: Any) -> str:
    authors = value if isinstance(value, list) else [value]
    names = [
        _ld_text(author.get("name")) if isinstance(author, dict) else _ld_text(author)
        for author in authors
    ]
    return ", ".join(name for name in names if name)
