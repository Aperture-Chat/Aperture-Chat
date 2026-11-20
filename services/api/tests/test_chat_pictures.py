from __future__ import annotations

import base64
import io

import pytest
from PIL import Image

from app.core import chat_pictures
from app.core.chat_pictures import Illustration, Missing, Photo, find_picture, picture_markdown
from app.core.licensed_pictures import LicensedPicture, PictureSearchUnavailable
from app.core.model_gateway import ModelGatewayError


def _jpeg_data_url() -> str:
    buffer = io.BytesIO()
    Image.new("RGB", (4, 4), (120, 80, 40)).save(buffer, "JPEG")
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


PHOTO = LicensedPicture(
    data_url=_jpeg_data_url(),
    alt="Napoleon Crossing the Alps",
    license="Public domain",
    artist="Jacques-Louis David",
    source_url="https://commons.wikimedia.org/wiki/File:David_-_Napoleon.jpg",
)


@pytest.fixture(autouse=True)
def image_dir(tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr("app.core.generated_images.generated_images_dir", lambda: tmp_path)
    return tmp_path


def _image_payload(data_url: str | None) -> dict:
    images = [{"image_url": {"url": data_url}}] if data_url else []
    return {"choices": [{"message": {"images": images}}], "usage": {"total_tokens": 9}}


def test_a_licensed_photo_is_stored_and_wins_over_an_illustration(image_dir) -> None:
    def illustrate(prompt: str) -> dict:
        raise AssertionError("no illustration when a photo exists")

    placed = find_picture("Napoleon crossing the Alps, 1800", illustrate, search=lambda query: [PHOTO])

    assert isinstance(placed, Photo)
    assert placed.picture is PHOTO
    assert (image_dir / placed.image_name).read_bytes()[:2] == b"\xff\xd8"


def test_no_photo_falls_back_to_an_illustration_from_the_image_model(image_dir) -> None:
    prompts: list[str] = []

    def illustrate(prompt: str) -> dict:
        prompts.append(prompt)
        return _image_payload(_jpeg_data_url())

    placed = find_picture("The Grande Armée retreating from Moscow, 1812", illustrate, search=lambda query: [])

    assert isinstance(placed, Illustration)
    assert (image_dir / placed.image_name).is_file()
    assert placed.provider_payload["usage"] == {"total_tokens": 9}
    assert "The Grande Armée retreating from Moscow, 1812" in prompts[0]
    assert "illustration" in prompts[0] and "not a photograph" in prompts[0]


def test_commons_being_down_still_tries_an_illustration() -> None:
    def down(query: str) -> list[LicensedPicture]:
        raise PictureSearchUnavailable("Wikimedia Commons could not be searched right now.")

    placed = find_picture("Elba", lambda prompt: _image_payload(_jpeg_data_url()), search=down)

    assert isinstance(placed, Illustration)


def test_nothing_found_without_an_image_model() -> None:
    assert find_picture("Elba", None, search=lambda query: []) == Missing(provider_payload=None)


def test_an_image_model_error_is_missing_with_nothing_to_bill() -> None:
    def failing(prompt: str) -> dict:
        raise ModelGatewayError("429 rate limited")

    assert find_picture("Elba", failing, search=lambda query: []) == Missing(provider_payload=None)


def test_an_image_model_that_returns_no_image_is_missing_but_still_billed() -> None:
    payload = _image_payload(None)

    assert find_picture("Elba", lambda prompt: payload, search=lambda query: []) == Missing(provider_payload=payload)


def test_photo_markdown_credits_the_author_license_and_source() -> None:
    text = picture_markdown("Napoleon crossing the Alps", Photo(PHOTO, "a.jpg"), "/img/a.jpg?token=t")

    # Chat captions an image with its alt text; the line under it is the credit.
    assert text == (
        "![Napoleon Crossing the Alps](/img/a.jpg?token=t)\n\n"
        "*Image: Jacques-Louis David · Public domain · Wikimedia Commons.* "
        "[Source](https://commons.wikimedia.org/wiki/File:David_-_Napoleon.jpg)"
    )


def test_illustration_markdown_says_it_is_ai_generated() -> None:
    text = picture_markdown("Retreat from Moscow, 1812", Illustration("b.png", {}), "/img/b.png?token=t")

    assert text == "![AI-generated illustration: Retreat from Moscow, 1812](/img/b.png?token=t)"


def test_missing_markdown_says_plainly_that_no_picture_was_found() -> None:
    assert picture_markdown("Elba", Missing(None), None) == (
        "*No freely licensed photo or AI illustration could be found for: Elba.*"
    )


def test_markdown_text_cannot_break_out_of_the_image_syntax() -> None:
    picture = LicensedPicture(PHOTO.data_url, "A [weird] *title*", "CC BY 4.0", "Someone", PHOTO.source_url)
    text = picture_markdown("x", Photo(picture, "c.jpg"), "/img/c.jpg")

    assert text.startswith("![A \\[weird\\] \\*title\\*](/img/c.jpg)")


def test_a_photo_is_searched_by_its_description() -> None:
    queries: list[str] = []
    find_picture("Coronation at Notre-Dame, 1804", None, search=lambda query: queries.append(query) or [])

    assert queries == ["Coronation at Notre-Dame, 1804"]
    assert chat_pictures.ILLUSTRATION_PROMPT.count("{description}") == 1


def test_a_source_link_with_parentheses_stays_one_link() -> None:
    picture = LicensedPicture(
        PHOTO.data_url, "Coronation", "Public domain", "David",
        "https://commons.wikimedia.org/wiki/File:Coronation_(1807).jpg",
    )
    text = picture_markdown("x", Photo(picture, "d.jpg"), "/img/d.jpg")

    assert text.endswith("[Source](https://commons.wikimedia.org/wiki/File:Coronation_%281807%29.jpg)")


def test_search_widens_from_the_description_to_its_key_words() -> None:
    assert chat_pictures.search_queries("Napoleon's childhood home in Ajaccio, Corsica, 1770s") == [
        "Napoleon's childhood home in Ajaccio, Corsica, 1770s",
        "Napoleon childhood home Ajaccio",
        "Napoleon childhood home",
    ]


def test_search_tries_no_query_twice() -> None:
    assert chat_pictures.search_queries("Elba") == ["Elba"]
    assert chat_pictures.search_queries("The Battle of Waterloo") == ["The Battle of Waterloo", "Battle Waterloo"]


def test_commons_is_asked_again_with_fewer_words_when_nothing_matches(monkeypatch: pytest.MonkeyPatch) -> None:
    asked: list[str] = []

    home = _picture("Maison natale de Napoléon, Ajaccio")

    def commons(query: str, *, limit: int) -> list[LicensedPicture]:
        asked.append(query)
        return [home] if query == "Napoleon childhood home" else []

    monkeypatch.setattr(chat_pictures, "find_licensed_pictures", commons)

    assert chat_pictures.search_commons("Napoleon's childhood home in Ajaccio, Corsica") == [home]
    assert asked == [
        "Napoleon's childhood home in Ajaccio, Corsica",
        "Napoleon childhood home Ajaccio",
        "Napoleon childhood home",
    ]


def test_an_unreadable_image_from_the_model_is_missing_but_still_billed() -> None:
    payload = {"choices": [{"message": {"images": ["junk", {"image_url": {"url": "data:image/gif;base64,R0lG"}}]}}]}

    assert find_picture("Elba", lambda prompt: payload, search=lambda query: []) == Missing(provider_payload=payload)


def _picture(alt: str, source: str = "https://commons.wikimedia.org/wiki/File:x.jpg") -> LicensedPicture:
    return LicensedPicture(PHOTO.data_url, alt, "Public domain", "Someone", source)


def test_a_photo_that_names_nothing_from_the_description_is_never_used(monkeypatch: pytest.MonkeyPatch) -> None:
    chaplin = _picture("Charlie Chaplin (cropped)")
    monkeypatch.setattr(chat_pictures, "find_licensed_pictures", lambda query, *, limit: [chaplin])

    assert chat_pictures.search_commons("Napoleon's childhood home in Ajaccio, Corsica") == []


def test_the_first_photo_naming_the_subject_is_used_accents_and_file_names_included(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sacre = _picture("Sacre de l'empereur Napoléon Ier, Paris")
    by_file = _picture("Le Monde illustré", "https://commons.wikimedia.org/wiki/File:French_army_in_Moscow_1812.jpg")
    monkeypatch.setattr(
        chat_pictures, "find_licensed_pictures", lambda query, *, limit: [_picture("Charlie Chaplin"), sacre]
    )
    assert chat_pictures.search_commons("Coronation of Napoleon, Paris, 1804") == [sacre]

    monkeypatch.setattr(chat_pictures, "find_licensed_pictures", lambda query, *, limit: [by_file])
    assert chat_pictures.search_commons("The French army leaving Moscow in 1812") == [by_file]


def test_key_terms_are_the_meaningful_words_of_the_whole_description() -> None:
    assert chat_pictures.key_terms("The French army retreating from Moscow, winter 1812") == {
        "french", "army", "retreating", "moscow", "winter"
    }


def test_a_photo_naming_only_one_word_of_a_longer_description_is_not_used(monkeypatch: pytest.MonkeyPatch) -> None:
    wedding = _picture("Mariage de Napoléon Joseph Charles Paul Bonaparte et Clotilde de Savoie")
    monkeypatch.setattr(chat_pictures, "find_licensed_pictures", lambda query, *, limit: [wedding])

    assert chat_pictures.search_commons("General Bonaparte leading troops across the Bridge of Arcole, 1796") == []


def test_word_forms_match_by_their_stem(monkeypatch: pytest.MonkeyPatch) -> None:
    retreat = _picture("Retreat of Napoleon Army from Moscow 1812")
    monkeypatch.setattr(chat_pictures, "find_licensed_pictures", lambda query, *, limit: [retreat])

    assert chat_pictures.search_commons("The French army retreating from Moscow, winter 1812") == [retreat]



def test_among_matching_photos_the_one_naming_the_most_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    church = _picture("Paris, Notre Dame -- 2014")
    sacre = _picture("Sacre de l'empereur Napoléon, Notre-Dame de Paris, 1804")
    monkeypatch.setattr(chat_pictures, "find_licensed_pictures", lambda query, *, limit: [church, sacre])

    assert chat_pictures.search_commons("Coronation of Napoleon in Notre-Dame, Paris, 1804") == [sacre]


def test_a_description_with_no_meaningful_words_never_takes_the_first_photo(monkeypatch: pytest.MonkeyPatch) -> None:
    anything = _picture("Charlie Chaplin")
    monkeypatch.setattr(chat_pictures, "find_licensed_pictures", lambda query, *, limit: [anything])

    assert chat_pictures.search_commons("1815") == []


def test_a_short_word_matches_only_itself_not_a_longer_word_it_begins(monkeypatch: pytest.MonkeyPatch) -> None:
    warsaw = _picture("Warsaw old town square")
    monkeypatch.setattr(chat_pictures, "find_licensed_pictures", lambda query, *, limit: [warsaw])

    assert chat_pictures.search_commons("War of 1812") == []


def test_an_image_model_error_is_logged(caplog: pytest.LogCaptureFixture) -> None:
    def failing(prompt: str) -> dict:
        raise ModelGatewayError("quota", status_code=429)

    with caplog.at_level("WARNING", logger="app.core.chat_pictures"):
        find_picture("A harbour", failing, search=lambda description: [])

    assert any("A harbour" in record.getMessage() for record in caplog.records)
