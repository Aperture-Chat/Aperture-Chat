"""Structured HTML extraction: metadata, main content, tables, links, search forms."""

from __future__ import annotations

from app.core.html_extract import PageLink, SearchForm, parse_html

ARTICLE_PAGE = """
<!doctype html>
<html>
<head>
  <title>Retention Schedule &amp; Holds | Example Records Office</title>
  <meta name="description" content="How long the office keeps synthetic case files.">
  <meta property="og:site_name" content="Example Records Office">
  <meta name="author" content="Avery Example">
  <meta property="article:published_time" content="2026-03-04T09:00:00Z">
  <link rel="canonical" href="/records/retention">
  <style>.hidden { display: none }</style>
  <script>window.tracking = "do-not-index";</script>
</head>
<body>
  <header><a href="/">Home</a></header>
  <nav>
    <a href="/records">Records</a>
    <a href="/about#team">About us</a>
    <a href="mailto:clerk@example.test">Email the clerk</a>
    <a href="javascript:void(0)">Menu</a>
  </nav>
  <main>
    <h1>Retention Schedule &amp; Holds</h1>
    <p>Closed files are kept for <b>seven</b> years.</p>
    <ul><li>Litigation holds pause deletion</li><li>Holds are reviewed yearly</li></ul>
    <table>
      <tr><th>Record type</th><th>Years</th></tr>
      <tr><td>Synthetic case file</td><td>7</td></tr>
    </table>
    <img src="/chart.png" alt="Retention timeline chart">
    <aside>Related: subscribe to our newsletter</aside>
    <noscript>Enable JavaScript to see more</noscript>
    <p>See the <a href="records/holds?utm_source=x">hold procedure</a>.</p>
  </main>
  <footer>Copyright Example Records Office</footer>
</body>
</html>
"""


def test_title_and_metadata_come_from_head_tags() -> None:
    page = parse_html(ARTICLE_PAGE, base_url="https://www.example.test/records/retention-page")

    assert page.title == "Retention Schedule & Holds | Example Records Office"
    assert page.description == "How long the office keeps synthetic case files."
    assert page.site_name == "Example Records Office"
    assert page.author == "Avery Example"
    assert page.published == "2026-03-04T09:00:00Z"
    assert page.canonical_url == "https://www.example.test/records/retention"


def test_main_region_is_preferred_and_boilerplate_and_scripts_are_dropped() -> None:
    page = parse_html(ARTICLE_PAGE, base_url="https://www.example.test/records/retention-page")
    lines = page.body.split("\n\n")

    assert "# Retention Schedule & Holds" in lines
    assert "Closed files are kept for seven years." in lines
    assert "- Litigation holds pause deletion" in lines
    assert "- Holds are reviewed yearly" in lines
    assert "Record type | Years" in lines
    assert "Synthetic case file | 7" in lines
    assert "[Image: Retention timeline chart]" in page.body
    for dropped in ("do-not-index", "newsletter", "Copyright", "Enable JavaScript", "Email the clerk"):
        assert dropped not in page.body


def test_text_puts_the_title_first_without_repeating_a_matching_heading() -> None:
    page = parse_html(
        "<title>Closing checklist</title><main><h1>Closing checklist</h1><p>Approval required.</p></main>"
    )

    assert page.text.split("\n\n") == ["Closing checklist", "Approval required."]


def test_text_includes_byline_and_description_when_present() -> None:
    page = parse_html(ARTICLE_PAGE, base_url="https://www.example.test/records/retention-page")
    paragraphs = page.text.split("\n\n")

    assert paragraphs[0] == "Retention Schedule & Holds | Example Records Office"
    assert paragraphs[1] == "Author: Avery Example · Published: 2026-03-04T09:00:00Z"
    assert paragraphs[2] == "How long the office keeps synthetic case files."
    assert paragraphs[3] == "# Retention Schedule & Holds"


def test_every_http_link_is_absolute_with_anchor_text_and_without_fragments() -> None:
    page = parse_html(ARTICLE_PAGE, base_url="https://www.example.test/records/retention-page")

    assert page.links == (
        PageLink("https://www.example.test/", "Home"),
        PageLink("https://www.example.test/records", "Records"),
        PageLink("https://www.example.test/about", "About us"),
        PageLink("https://www.example.test/records/records/holds?utm_source=x", "hold procedure"),
    )


def test_relative_links_are_skipped_without_a_base_url_and_base_tag_is_respected() -> None:
    assert parse_html('<a href="/relative">Rel</a><a href="https://a.test/x">Abs</a>').links == (
        PageLink("https://a.test/x", "Abs"),
    )
    based = parse_html(
        '<head><base href="https://cdn.test/docs/"></head><a href="guide.pdf">Guide</a>',
        base_url="https://site.test/",
    )
    assert based.links == (PageLink("https://cdn.test/docs/guide.pdf", "Guide"),)


def test_duplicate_links_keep_the_first_url_and_gain_anchor_text_from_later_ones() -> None:
    page = parse_html(
        '<a href="/a"><img src="i.png" alt=""></a><a href="/a">Annual report</a><a href="/a">Other</a>',
        base_url="https://site.test/",
    )

    assert page.links == (PageLink("https://site.test/a", "Annual report"),)


def test_image_alt_names_an_image_only_link() -> None:
    page = parse_html('<a href="/logo"><img alt="Company logo"></a>', base_url="https://site.test/")

    assert page.links == (PageLink("https://site.test/logo", "Company logo"),)


def test_without_a_main_region_navigation_text_is_kept() -> None:
    page = parse_html("<nav><a href='/x'>Opening hours</a></nav><div>Mon to Fri</div>")

    assert page.body.split("\n\n") == ["Opening hours", "Mon to Fri"]


def test_role_main_marks_the_main_region_and_hidden_elements_are_dropped() -> None:
    page = parse_html(
        "<div>Site banner</div>"
        "<div role='main'><div><p>Docket entry 12</p></div><p hidden>Draft note</p></div>"
        "<div>Trailing promo</div>"
    )

    assert page.body == "Docket entry 12"


def test_json_ld_fills_missing_metadata() -> None:
    page = parse_html(
        """<script type="application/ld+json">
        {"@graph": [{"@type": "WebSite"}, {"@type": "Article", "headline": "Synthetic Ruling",
         "description": "A made-up ruling.", "datePublished": "2026-01-02",
         "author": [{"@type": "Person", "name": "Jordan Sample"}]}]}
        </script><p>Body</p>"""
    )

    assert page.title == "Synthetic Ruling"
    assert page.description == "A made-up ruling."
    assert page.published == "2026-01-02"
    assert page.author == "Jordan Sample"
    assert "Synthetic Ruling" not in page.body


def test_broken_json_ld_is_ignored() -> None:
    page = parse_html('<script type="application/ld+json">{not json</script><p>Still here</p>')

    assert page.title == ""
    assert page.body == "Still here"


def test_nested_tables_flatten_into_the_outer_cell() -> None:
    page = parse_html(
        "<table><tr><td>Outer<table><tr><td>inner</td></tr></table></td><td><p>B</p></td></tr></table>"
    )

    assert page.body == "Outer inner | B"


def test_get_search_form_is_detected_with_hidden_fields() -> None:
    page = parse_html(
        """<form action="/search" role="search">
             <input type="hidden" name="lang" value="en">
             <input type="search" name="q" placeholder="Search records">
             <button>Go</button>
           </form>""",
        base_url="https://site.test/home",
    )

    assert page.search_form == SearchForm(
        action="https://site.test/search", param="q", fixed=(("lang", "en"),)
    )
    assert page.search_form.url_for("case 42") == "https://site.test/search?lang=en&q=case+42"


def test_login_and_post_forms_are_not_search_forms() -> None:
    page = parse_html(
        """<form action="/login"><input name="user"><input type="password" name="pw"></form>
           <form method="post" action="/search"><input name="q"></form>
           <form action="/contact"><input name="name"><input name="email"></form>""",
        base_url="https://site.test/",
    )

    assert page.search_form is None


def test_search_form_action_query_is_replaced_like_a_browser_get_submission() -> None:
    page = parse_html(
        '<form action="/find?old=1"><input name="term"></form>', base_url="https://site.test/"
    )

    assert page.search_form is not None
    assert page.search_form.url_for("gallium") == "https://site.test/find?term=gallium"


def test_plain_text_input_without_a_search_signal_is_not_a_search_form() -> None:
    page = parse_html('<form action="/subscribe"><input name="newsletter"></form>', base_url="https://site.test/")

    assert page.search_form is None
