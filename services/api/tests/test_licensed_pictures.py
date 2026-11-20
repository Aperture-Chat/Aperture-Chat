"""Licensed pictures for documents: Wikimedia Commons search, license filter,
and embeddable JPEGs. Every network call goes through httpx.MockTransport."""

from __future__ import annotations

import base64
import io

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.core import licensed_pictures
from app.main import app
from app.repositories.deps import get_store
from app.routes import assets

client = TestClient(app)


def _png(width: int = 2400, height: int = 1600) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (120, 90, 60)).save(buffer, "PNG")
    return buffer.getvalue()


def _page(index: int, name: str, license_name: str, *, artist: str = "<a href='x'>Jane Doe</a>", mime: str = "image/png") -> dict:
    return {
        "index": index,
        "title": f"File:{name}",
        "imageinfo": [
            {
                "url": f"https://upload.wikimedia.org/full/{name}",
                "thumburl": f"https://upload.wikimedia.org/thumb/{name}",
                "descriptionurl": f"https://commons.wikimedia.org/wiki/File:{name}",
                "mime": mime,
                "extmetadata": {
                    "LicenseShortName": {"value": license_name},
                    "Artist": {"value": artist},
                    "ImageDescription": {"value": f"<p>{name} description</p>"},
                    "AttributionRequired": {"value": "true"},
                },
            }
        ],
    }


def _commons(pages: list[dict], seen: list[httpx.Request] | None = None) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        if request.url.host == "commons.wikimedia.org":
            return httpx.Response(200, json={"query": {"pages": pages}})
        if request.url.host == "upload.wikimedia.org":
            return httpx.Response(200, content=_png(), headers={"content-type": "image/png"})
        return httpx.Response(404)

    return httpx.MockTransport(handler)


@pytest.fixture(autouse=True)
def _reset_transport():
    get_store.cache_clear()
    yield
    assets.transport = None
    get_store.cache_clear()


def _find(query: str, limit: int = 2) -> httpx.Response:
    return client.post(
        "/api/assets/licensed-pictures",
        json={"query": query, "limit": limit},
        headers={"x-aperture-user": "user-admin"},
    )


def test_finds_freely_licensed_photos_as_embeddable_jpegs_with_their_credit() -> None:
    seen: list[httpx.Request] = []
    assets.transport = _commons(
        [
            _page(2, "Napoleon_coronation.png", "CC BY-SA 4.0"),
            _page(1, "Napoleon_Brienne.png", "Public domain", artist="Unknown author"),
        ],
        seen,
    )

    response = _find("Napoleon at Brienne military school")

    assert response.status_code == 200, response.text
    pictures = response.json()["pictures"]
    # Commons' own relevance order, not the order the API listed the pages in.
    assert [picture["source_url"] for picture in pictures] == [
        "https://commons.wikimedia.org/wiki/File:Napoleon_Brienne.png",
        "https://commons.wikimedia.org/wiki/File:Napoleon_coronation.png",
    ]
    first = pictures[0]
    assert first["license"] == "Public domain"
    assert first["credit"] == "Unknown author · Public domain · Wikimedia Commons"
    assert pictures[1]["credit"] == "Jane Doe · CC BY-SA 4.0 · Wikimedia Commons"
    assert first["data_url"].startswith("data:image/jpeg;base64,")
    picture = Image.open(io.BytesIO(base64.b64decode(first["data_url"].split(",", 1)[1])))
    assert picture.format == "JPEG"
    assert max(picture.size) <= 1024
    assert len(first["data_url"]) < 400_000
    search = next(request for request in seen if request.url.host == "commons.wikimedia.org")
    assert "Napoleon at Brienne military school" in search.url.params["gsrsearch"]
    assert search.headers["user-agent"].startswith("Aperture-Chat/")


def test_leaves_out_pictures_whose_license_is_not_free_or_not_stated() -> None:
    assets.transport = _commons(
        [
            _page(1, "Non_commercial.png", "CC BY-NC 2.0"),
            _page(2, "No_derivatives.png", "CC BY-ND 4.0"),
            _page(3, "Unstated.png", ""),
            _page(4, "Vector.svg", "CC0", mime="image/svg+xml"),
            _page(5, "Free.png", "CC0"),
        ]
    )

    pictures = _find("anything", limit=4).json()["pictures"]

    assert [picture["license"] for picture in pictures] == ["CC0"]


def test_an_empty_search_is_an_empty_list_and_an_unreachable_commons_is_an_error() -> None:
    assets.transport = _commons([])
    assert _find("nothing matches").json() == {"pictures": []}

    assets.transport = httpx.MockTransport(lambda request: httpx.Response(503))
    failed = _find("Napoleon")
    assert failed.status_code == 502
    assert "Wikimedia Commons" in failed.json()["detail"]


def test_a_search_that_finds_nothing_tries_the_broader_subject_next() -> None:
    searches: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "commons.wikimedia.org":
            searches.append(request.url.params["gsrsearch"])
            broad = request.url.params["gsrsearch"].startswith("Ruth Bader Ginsburg filetype")
            return httpx.Response(200, json={"query": {"pages": [_page(1, "RBG_portrait.png", "Public domain")] if broad else []}})
        return httpx.Response(200, content=_png(), headers={"content-type": "image/png"})

    assets.transport = httpx.MockTransport(handler)
    response = client.post(
        "/api/assets/licensed-pictures",
        json={"query": "Ruth Bader Ginsburg at Columbia Law School", "subject": "Ruth Bader Ginsburg", "limit": 1},
        headers={"x-aperture-user": "user-admin"},
    )

    assert [picture["source_url"] for picture in response.json()["pictures"]] == [
        "https://commons.wikimedia.org/wiki/File:RBG_portrait.png"
    ]
    assert searches == ["Ruth Bader Ginsburg at Columbia Law School filetype:bitmap", "Ruth Bader Ginsburg filetype:bitmap"]


def test_requires_a_signed_in_user_and_a_real_query() -> None:
    assert client.post("/api/assets/licensed-pictures", json={"query": "Napoleon"}).status_code == 401
    assert _find(" ").status_code == 422
    assert _find("Napoleon", limit=9).status_code == 422


def _serving(pages: list[dict], image: httpx.Response) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "commons.wikimedia.org":
            return httpx.Response(200, json={"query": {"pages": pages}})
        return image

    return httpx.MockTransport(handler)


def test_a_download_that_redirects_off_wikimedia_is_not_followed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "commons.wikimedia.org":
            return httpx.Response(200, json={"query": {"pages": [_page(1, "Moved.png", "CC0")]}})
        if request.url.host == "upload.wikimedia.org":
            return httpx.Response(302, headers={"location": "https://elsewhere.example/picture.png"})
        return httpx.Response(200, content=_png(), headers={"content-type": "image/png"})

    assets.transport = httpx.MockTransport(handler)
    assert _find("anything").json() == {"pictures": []}


def test_an_oversized_download_or_an_enormous_picture_is_skipped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(licensed_pictures, "MAX_DOWNLOAD_BYTES", 1000)
    assets.transport = _serving([_page(1, "Big.png", "CC0")], httpx.Response(200, content=_png()))
    assert _find("anything").json() == {"pictures": []}

    monkeypatch.setattr(licensed_pictures, "MAX_DOWNLOAD_BYTES", 12 * 1024 * 1024)
    monkeypatch.setattr(licensed_pictures, "MAX_SOURCE_PIXELS", 1000)
    assert _find("anything").json() == {"pictures": []}


def test_a_source_page_off_commons_is_refused() -> None:
    page = _page(1, "Elsewhere.png", "CC0")
    page["imageinfo"][0]["descriptionurl"] = "https://example.com/File:Elsewhere.png"
    assets.transport = _commons([page])
    assert _find("anything").json() == {"pictures": []}


def test_each_search_is_audited_with_what_was_sent() -> None:
    assets.transport = _commons([_page(1, "Napoleon.png", "Public domain")])
    _find("Napoleon at Brienne")
    events = [event for event in get_store().audit_events if event.action == "assets.licensed_picture_search"]
    assert len(events) == 1
    assert "Napoleon at Brienne" in str(events[0].metadata) or "Napoleon at Brienne" in str(events[0])


def test_an_artwork_title_drops_the_wikidata_labels_commons_appends() -> None:
    page = _page(1, "Napoleon_Alps.png", "Public domain")
    page["imageinfo"][0]["extmetadata"]["ObjectName"] = {
        "value": 'Napoleon Crossing the Alps label QS:Les," Napoleón cruzando los Alpes " label QS:Lde,"x"'
    }
    assets.transport = _commons([page])

    assert _find("Napoleon crossing the Alps", limit=1).json()["pictures"][0]["alt"] == "Napoleon Crossing the Alps"


def test_a_title_loses_its_language_label_and_is_kept_to_a_caption_length() -> None:
    page = _page(1, "Sacre.png", "Public domain")
    page["imageinfo"][0]["extmetadata"]["ObjectName"] = {
        "value": "French: Sacre de l'empereur Napoléon Ier et couronnement de l'impératrice Joséphine dans la "
        "cathédrale Notre-Dame de Paris, le 2 décembre 1804 Coronation of Emperor Napoleon I and Crowning of "
        "the Empress Josephine in Notre-Dame Cathedral on December 2, 1804"
    }
    assets.transport = _commons([page])

    alt = _find("Coronation of Napoleon", limit=1).json()["pictures"][0]["alt"]

    assert alt.startswith("Sacre de l'empereur Napoléon Ier")
    assert len(alt) <= 120 and alt.endswith("…")
