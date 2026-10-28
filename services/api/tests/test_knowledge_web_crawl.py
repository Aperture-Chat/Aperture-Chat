"""Add web pages: single-page reads, same-site crawls, Sync re-crawls, and recipes."""

from __future__ import annotations

from functools import partial

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core import site_crawl
from app.core import web_fetch
from app.main import app
from app.models.schemas import KnowledgeConfig
from app.repositories.deps import get_store
from app.routes import knowledge as knowledge_route

client = TestClient(app)
CONFIG_ID = "knowledge-web-crawl"
HEADERS = {"x-aperture-user": "user-admin"}


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def html_page(title: str, body: str, *links: tuple[str, str]) -> str:
    anchors = "".join(f'<a href="{href}">{text}</a>' for href, text in links)
    return (
        f"<html><head><title>{title}</title><meta name='description' content='{title} summary.'></head>"
        f"<body><nav>{anchors}</nav><main><h1>{title}</h1><p>{body}</p></main></body></html>"
    )


class Site:
    def __init__(self, routes: dict[str, tuple[int, str] | str]) -> None:
        self.routes = routes
        self.requests: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request.url.path)
        route = self.routes.get(request.url.path)
        if route is None:
            return httpx.Response(404, content=b"missing", request=request)
        status, body = (200, route) if isinstance(route, str) else route
        content_type = "text/plain" if request.url.path == "/robots.txt" else "text/html"
        return httpx.Response(status, headers={"content-type": content_type}, content=body.encode(), request=request)


def serve(monkeypatch: pytest.MonkeyPatch, site: Site) -> None:
    transport = httpx.MockTransport(site)
    real_fetch = web_fetch.fetch_web_source
    monkeypatch.setattr(
        knowledge_route,
        "fetch_web_source",
        lambda url, **kwargs: real_fetch(url, transport=transport, **kwargs),
    )
    monkeypatch.setattr(knowledge_route, "crawl_site", partial(site_crawl.crawl_site, transport=transport))


def web_config() -> KnowledgeConfig:
    config = KnowledgeConfig(
        id=CONFIG_ID,
        tenant_id="tenant-example",
        name="Public registry",
        source_type="web",
        enabled=True,
        owner_user_id="user-admin",
        acl_group_ids=["group-litigation"],
        settings={"status": "draft", "document_count": 0, "last_sync": "Not synced"},
    )
    get_store().knowledge_configs[config.id] = config
    return config


def registry_site() -> Site:
    return Site(
        {
            "/robots.txt": "User-agent: *\nDisallow: /staff\n",
            "/": html_page(
                "Synthetic Registry",
                "A public registry of made-up compounds.",
                ("/compounds", "Compounds"),
                ("/staff/directory", "Staff"),
                ("/login", "Sign in"),
            ),
            "/compounds": html_page(
                "Compounds",
                "Ethanol boils at 78 degrees Celsius.",
                ("/compounds/methanol", "Methanol record"),
            ),
        }
    )


def recipe(document_id: str) -> dict[str, object]:
    sources = get_store().knowledge_configs[CONFIG_ID].settings["linked_sources"]
    return next(item for item in sources if item["document_id"] == document_id)


def chunks_for(document_id: str) -> list:
    return [chunk for chunk in get_store().knowledge_chunks_for(CONFIG_ID) if chunk.document_id == document_id]


def test_single_page_add_uses_the_page_title_and_saves_its_links_for_live_lookups(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    web_config()
    site = registry_site()
    serve(monkeypatch, site)

    response = client.post(
        f"/api/knowledge/{CONFIG_ID}/web-sources",
        headers=HEADERS,
        json={"name": "", "url": "https://www.registry.test/"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["provider_message"].startswith("Fetched https://www.registry.test/ and indexed")
    assert body["provider_message"].endswith(" 2 more same-site links are saved for live lookups.")
    [document] = body["documents"]
    assert document["name"] == "Synthetic Registry"
    assert site.requests == ["/"]
    saved = recipe(document["id"])
    assert (saved["crawl_depth"], saved["live_lookup"], saved["page_count"]) == (0, True, 1)
    assert saved["pages"] == ["https://www.registry.test/"]
    assert [link["url"] for link in saved["inventory"]] == [
        "https://www.registry.test/compounds",
        "https://www.registry.test/staff/directory",
    ]
    [chunk] = chunks_for(document["id"])
    assert chunk.text.startswith("Synthetic Registry")
    assert "A public registry of made-up compounds." in chunk.text


def test_crawl_add_stores_one_site_document_whose_chunks_cite_each_page(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    web_config()
    site = registry_site()
    serve(monkeypatch, site)

    response = client.post(
        f"/api/knowledge/{CONFIG_ID}/web-sources",
        headers=HEADERS,
        json={"name": "", "url": "https://www.registry.test/", "crawl_depth": 1, "max_pages": 10},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    [document] = body["documents"]
    assert (document["name"], document["source_uri"], document["source_type"]) == (
        "Synthetic Registry",
        "https://www.registry.test/",
        "web",
    )
    chunks = chunks_for(document["id"])
    assert document["chunk_count"] == len(chunks) == 2
    assert [chunk.id for chunk in chunks] == [f"chunk-{document['id']}-1", f"chunk-{document['id']}-2"]
    assert [chunk.ordinal for chunk in chunks] == [0, 1]
    assert [chunk.source_uri for chunk in chunks] == [
        "https://www.registry.test/",
        "https://www.registry.test/compounds",
    ]
    assert [chunk.locator for chunk in chunks] == ["Synthetic Registry", "Compounds"]
    assert chunks[1].text.startswith("Compounds (https://www.registry.test/compounds) — Compounds summary.")
    assert chunks[1].text.count("Compounds summary.") == 1
    assert all(chunk.acl_group_ids == ["group-litigation"] for chunk in chunks)
    assert "/staff/directory" not in site.requests and "/login" not in site.requests
    message = body["provider_message"]
    assert message.startswith("Fetched https://www.registry.test/: Read 2 pages; 1 skipped by robots.txt.")
    assert "1 more same-site link is saved for live lookups." in message
    assert message.endswith("Indexed 2 passages.")
    saved = recipe(document["id"])
    assert (saved["crawl_depth"], saved["max_pages"], saved["page_count"], saved["live_lookup"]) == (1, 10, 2, True)
    assert saved["inventory"] == [{"url": "https://www.registry.test/compounds/methanol", "text": "Methanol record"}]
    audit = get_store().audit_events[-1]
    assert audit.action == "knowledge.web_source_added"
    assert audit.metadata["pages_read"] == 2
    assert audit.metadata["robots_blocked"] == 1
    assert audit.metadata["failed_pages"] == 0

    hits = get_store().retrieve_knowledge(get_store().users["user-admin"], [CONFIG_ID], "ethanol boils", limit=2)
    assert hits[0].source_uri == "https://www.registry.test/compounds"


def test_sync_recrawls_with_the_saved_settings_and_replaces_the_document_in_place(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    web_config()
    site = registry_site()
    serve(monkeypatch, site)
    added = client.post(
        f"/api/knowledge/{CONFIG_ID}/web-sources",
        headers=HEADERS,
        json={"name": "Registry", "url": "https://www.registry.test/", "crawl_depth": 1, "max_pages": 10, "live_lookup": False},
    )
    [document] = added.json()["documents"]
    site.routes["/compounds"] = html_page(
        "Compounds", "Ethanol now boils at 79 degrees.", ("/compounds/new", "New compound")
    )
    site.routes["/compounds/new"] = html_page("New compound", "Added later.")

    synced = client.post(f"/api/knowledge/{CONFIG_ID}/sync", headers=HEADERS, json={"force": True})

    assert synced.status_code == 200, synced.text
    body = synced.json()
    assert body["status"] == "synced"
    assert body["provider_message"].startswith("Refreshed 1 linked source.")
    assert "Registry: Read 2 pages; 1 skipped by robots.txt." in body["provider_message"]
    [refreshed] = body["documents"]
    assert refreshed["id"] == document["id"] and refreshed["name"] == "Registry"
    texts = " ".join(chunk.text for chunk in chunks_for(document["id"]))
    assert "79 degrees" in texts and "78 degrees" not in texts
    saved = recipe(document["id"])
    assert saved["live_lookup"] is False
    assert saved["inventory"] == [] and saved["site_search"] is None


def test_failed_recrawl_keeps_the_previous_site_content(monkeypatch: pytest.MonkeyPatch) -> None:
    web_config()
    site = registry_site()
    serve(monkeypatch, site)
    added = client.post(
        f"/api/knowledge/{CONFIG_ID}/web-sources",
        headers=HEADERS,
        json={"name": "Registry", "url": "https://www.registry.test/", "crawl_depth": 1},
    )
    [document] = added.json()["documents"]
    before = [chunk.text for chunk in chunks_for(document["id"])]
    site.routes["/"] = (503, "down")

    synced = client.post(f"/api/knowledge/{CONFIG_ID}/sync", headers=HEADERS)

    body = synced.json()
    assert body["status"] == "error"
    assert "Could not refresh Registry" in body["provider_message"]
    assert [chunk.text for chunk in chunks_for(document["id"])] == before


def test_deleting_a_site_document_forgets_its_recipe(monkeypatch: pytest.MonkeyPatch) -> None:
    web_config()
    serve(monkeypatch, registry_site())
    added = client.post(
        f"/api/knowledge/{CONFIG_ID}/web-sources",
        headers=HEADERS,
        json={"name": "Registry", "url": "https://www.registry.test/", "crawl_depth": 1},
    )
    [document] = added.json()["documents"]

    deleted = client.delete(f"/api/knowledge/{CONFIG_ID}/documents/{document['id']}", headers=HEADERS)

    assert deleted.status_code == 200
    assert get_store().knowledge_configs[CONFIG_ID].settings["linked_sources"] == []
    assert chunks_for(document["id"]) == []


@pytest.mark.parametrize(
    "options",
    [{"crawl_depth": 4}, {"crawl_depth": -1}, {"max_pages": 0}, {"max_pages": 101}],
)
def test_crawl_options_are_validated(options: dict[str, int]) -> None:
    web_config()

    response = client.post(
        f"/api/knowledge/{CONFIG_ID}/web-sources",
        headers=HEADERS,
        json={"name": "x", "url": "https://www.registry.test/", **options},
    )

    assert response.status_code == 422


def test_pasted_text_is_never_crawled_or_looked_up_live(monkeypatch: pytest.MonkeyPatch) -> None:
    web_config()
    site = registry_site()
    serve(monkeypatch, site)

    response = client.post(
        f"/api/knowledge/{CONFIG_ID}/web-sources",
        headers=HEADERS,
        json={"name": "", "url": "https://www.registry.test/", "text": "Pasted registry notes.", "crawl_depth": 2},
    )

    assert response.status_code == 200
    [document] = response.json()["documents"]
    assert document["name"] == "https://www.registry.test/"
    assert site.requests == []
    saved = recipe(document["id"])
    assert saved["refresh"] is False
    assert saved.get("live_lookup") is not True


def test_crawl_start_page_failure_creates_no_document(monkeypatch: pytest.MonkeyPatch) -> None:
    web_config()
    serve(monkeypatch, Site({"/": (500, "boom")}))

    response = client.post(
        f"/api/knowledge/{CONFIG_ID}/web-sources",
        headers=HEADERS,
        json={"name": "x", "url": "https://www.registry.test/", "crawl_depth": 1},
    )

    assert response.status_code == 502
    assert get_store().knowledge_documents_for(CONFIG_ID) == []
