"""Chat replies that ask for pictures get them placed while they stream."""

from __future__ import annotations

import base64
import io
import json
import re
import time

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.core.chat_pictures import Missing, Photo
from app.core.licensed_pictures import LicensedPicture
from app.core.model_gateway import ModelGatewayError, ModelGatewayRoute
from app.main import app
from app.models.schemas import ModelConfig
from app.repositories.deps import get_store

client = TestClient(app)
PROMPT = "Write a short history of Napoleon with pictures from different periods of his life."


@pytest.fixture(autouse=True)
def reset_store(tmp_path, monkeypatch: pytest.MonkeyPatch):
    get_store.cache_clear()
    monkeypatch.setattr("app.core.generated_images.generated_images_dir", lambda: tmp_path)
    monkeypatch.setattr("app.routes.chat._resolve_gateway_route", _route)
    yield
    get_store.cache_clear()


def _route(_store, model, *, tenant_id: str | None) -> ModelGatewayRoute:
    return ModelGatewayRoute(
        provider_id="provider-test",
        provider_name="Test Provider",
        provider_kind="openai-compatible",
        auth_type="bearer",
        upstream_model=model.upstream_model_id or "openai/gpt-4o-mini",
        base_url="https://provider.invalid/v1",
        configured=True,
        status_message="Configured",
        secret_value="test-only-secret",
    )


def _jpeg_data_url() -> str:
    buffer = io.BytesIO()
    Image.new("RGB", (4, 4), (10, 20, 30)).save(buffer, "JPEG")
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


PHOTO = LicensedPicture(
    data_url=_jpeg_data_url(),
    alt="Napoleon Crossing the Alps",
    license="Public domain",
    artist="Jacques-Louis David",
    source_url="https://commons.wikimedia.org/wiki/File:David_Napoleon.jpg",
)


class _NoResults:
    engine = "test"

    def search(self, query):
        return []


def _reply(
    monkeypatch: pytest.MonkeyPatch, chunks, prompt: str = PROMPT, *, web: bool = True
) -> tuple[str, list[dict], list]:
    sent: list[dict] = []

    def stream(*args, **kwargs):
        sent.append(kwargs)
        return iter(chunks)

    monkeypatch.setattr("app.routes.chat._gateway_stream", stream)
    monkeypatch.setattr("app.routes.chat._platform_web_search_client", lambda *args: _NoResults())
    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": prompt}],
            "stream": True,
            "web_enabled": web,
        },
        headers={"x-aperture-user": "user-jane"},
    )
    assert response.status_code == 200, response.text
    events = [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ") and line != "data: [DONE]"
    ]
    text = "".join(event.get("delta", "") for event in events)
    return text, sent, events


def _system_text(sent: list[dict]) -> str:
    return "\n".join(str(message.get("content")) for message in sent[0]["messages"])


def test_a_picture_spot_streams_as_a_stored_licensed_photo_with_its_credit(monkeypatch: pytest.MonkeyPatch) -> None:
    looked_up: list[str] = []

    def photo(description, illustrate, **kwargs):
        looked_up.append(description)
        from app.core.generated_images import save_generated_image

        return Photo(PHOTO, save_generated_image(PHOTO.data_url))

    monkeypatch.setattr("app.routes.chat.find_picture", photo)

    text, sent, events = _reply(
        monkeypatch, ["Napoleon rose fast.\n", "[[Picture: Napoleon crossing ", "the Alps, 1800]]\n", "He was crowned in 1804."]
    )

    assert looked_up == ["Napoleon crossing the Alps, 1800"]
    assert "[[Picture" not in text
    assert re.search(
        r"!\[Napoleon Crossing the Alps\]\(/api/chat/generated-images/[0-9a-f]{32}\.jpg\?token=[^)\s]+\)", text
    )
    assert "Image: Jacques-Louis David · Public domain · Wikimedia Commons." in text
    assert text.index("Napoleon rose fast.") < text.index("![") < text.index("He was crowned in 1804.")
    # The model was told to mark spots, not to apologise for missing image URLs.
    system = _system_text(sent)
    assert "[[Picture:" in system
    assert "say so in one short line" not in system
    checks = [event["activity"] for event in events if event.get("activity", {}).get("phase") == "checked"]
    assert checks[0]["checks"] == [{"label": "Include pictures", "met": True}]
    audits = [e for e in get_store().audit_events_newest_first() if e.action == "assets.licensed_picture_search"]
    assert audits and audits[0].metadata["query"] == "Napoleon crossing the Alps, 1800"


def test_without_a_photo_the_best_image_model_draws_an_illustration_and_is_billed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    store.models["image-test"] = ModelConfig(
        id="image-test",
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="Image Test",
        upstream_model_id="google/gemini-3.1-flash-image-preview",
        group_ids=["group-litigation"],
    )
    prompts: list[tuple[str, str]] = []

    class ImageClient:
        def generate_images(self, *, route, messages, max_tokens=None, image_only=False):
            prompts.append((route.upstream_model, messages[-1]["content"]))
            return {
                "choices": [{"message": {"images": [{"image_url": {"url": _jpeg_data_url()}}]}}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 7, "total_tokens": 12},
            }

    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: ImageClient())
    monkeypatch.setattr("app.core.chat_pictures.find_licensed_pictures", lambda query, limit: [])

    text, _sent, _events = _reply(monkeypatch, ["Retreat.\n", "[[Picture: The retreat from Moscow, 1812]]\n"])

    assert prompts and prompts[0][0] == "google/gemini-3.1-flash-image-preview"
    assert "The retreat from Moscow, 1812" in prompts[0][1]
    assert re.search(r"!\[AI-generated illustration: The retreat from Moscow, 1812\]\(/api/chat/generated-images/", text)
    usage = [record for record in store.usage_records_newest_first() if record.model_id == "image-test"]
    assert usage and usage[0].surface == "image" and usage[0].total_tokens == 12
    audit = [event for event in store.audit_events_newest_first() if event.action == "chat.images_generated"]
    assert audit and audit[0].target == "image-test"


def test_a_spot_with_nothing_found_says_so_in_the_reply(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.routes.chat.find_picture", lambda description, illustrate, **kwargs: Missing(None))

    text, _sent, _events = _reply(monkeypatch, ["[[Picture: Elba harbour, 1814]]\n", "Exile."])

    assert "*No freely licensed photo or AI illustration could be found for: Elba harbour, 1814.*" in text
    assert text.endswith("Exile.")


def test_a_reply_that_asked_for_no_pictures_leaves_spot_like_text_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    def never(description, illustrate, **kwargs):
        raise AssertionError("no lookup without a picture request")

    monkeypatch.setattr("app.routes.chat.find_picture", never)

    text, sent, _events = _reply(monkeypatch, ["[[Picture: x y z]]\n"], prompt="Explain wiki link syntax.")

    assert text == "[[Picture: x y z]]\n"
    assert "Aperture places a freely licensed photo" not in _system_text(sent)


def _checks(events: list) -> list:
    return [event["activity"] for event in events if event.get("activity", {}).get("phase") == "checked"]


def test_with_web_off_no_photo_is_searched_for_and_the_reply_says_why(monkeypatch: pytest.MonkeyPatch) -> None:
    def no_search(query, limit):
        raise AssertionError("Commons is searched only with Web on")

    monkeypatch.setattr("app.core.chat_pictures.find_licensed_pictures", no_search)

    text, _sent, _events = _reply(monkeypatch, ["[[Picture: Elba harbour, 1814]]\n", "Exile."], web=False)

    assert "Elba harbour, 1814" in text and "Web" in text
    assert "[[Picture" not in text
    searches = [e for e in get_store().audit_events_newest_first() if e.action == "assets.licensed_picture_search"]
    assert searches == []


def test_pictures_are_not_reported_as_included_when_none_was_placed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.routes.chat.find_picture", lambda description, illustrate, **kwargs: Missing(None))

    _text, _sent, events = _reply(monkeypatch, ["[[Picture: Elba harbour, 1814]]\n", "Exile."])

    assert _checks(events)[0]["checks"] == [{"label": "Include pictures", "met": False}]


def test_text_after_a_pending_picture_is_not_lost_when_the_provider_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    def slow(description, illustrate, **kwargs):
        time.sleep(0.5)
        return Missing(None)

    def chunks():
        yield "Intro.\n"
        yield "[[Picture: Waterloo, 1815]]\n"
        yield "Second paragraph.\n"
        raise ModelGatewayError("upstream refused", status_code=400)

    monkeypatch.setattr("app.routes.chat.find_picture", slow)

    text, _sent, events = _reply(monkeypatch, chunks())

    assert "Second paragraph." in text
    assert "Waterloo, 1815" in text and "[[Picture" not in text
    errors = [event for event in events if "error" in event]
    assert errors and "upstream refused" in errors[0]["error"]


class _Usage:
    def __init__(self, *, exact: bool = False) -> None:
        self.requires_exact_metering = exact
        self.settled: list[dict] = []

    def settle_provider_child(self, **kwargs) -> None:
        self.settled.append(kwargs)


def _chat_pictures(monkeypatch: pytest.MonkeyPatch, usage: _Usage, find) -> object:
    from app.models.schemas import ChatCompletionRequest
    from app.routes.chat import _ChatPictures

    store = get_store()
    model = next(iter(store.models.values()))
    request = ChatCompletionRequest(model=model.id, messages=[{"role": "user", "content": PROMPT}], stream=True)
    monkeypatch.setattr("app.routes.chat.find_picture", find)
    return _ChatPictures(store, store.users["user-jane"], request, (model, _route(store, model, tenant_id=None)), usage, True)


def _illustrated(description, illustrate, **kwargs):
    from app.core.chat_pictures import Illustration
    from app.core.generated_images import save_generated_image

    return Illustration(save_generated_image(_jpeg_data_url()), {"usage": {"total_tokens": 9}})


def test_under_exact_metering_no_illustration_is_attempted(monkeypatch: pytest.MonkeyPatch) -> None:
    offered: list = []

    def find(description, illustrate, **kwargs):
        offered.append(illustrate)
        return Missing(None)

    pictures = _chat_pictures(monkeypatch, _Usage(exact=True), find)
    pictures.spots.feed("[[Picture: Elba harbour]]\n")
    list(pictures.spots.close(tick_seconds=0.01))

    assert offered == [None]


def test_an_illustration_never_shown_is_still_billed_and_audited_once(monkeypatch: pytest.MonkeyPatch) -> None:
    usage = _Usage()
    pictures = _chat_pictures(monkeypatch, usage, _illustrated)
    pictures.spots.feed("[[Picture: Elba harbour]]\n")

    pictures.settle_outstanding()
    pictures.settle_outstanding()

    assert len(usage.settled) == 1 and usage.settled[0]["attribution"].surface == "image"
    audits = [e for e in get_store().audit_events_newest_first() if e.action == "chat.images_generated"]
    assert len(audits) == 1


def test_an_illustration_shown_is_not_billed_again_when_the_reply_closes(monkeypatch: pytest.MonkeyPatch) -> None:
    usage = _Usage()
    pictures = _chat_pictures(monkeypatch, usage, _illustrated)
    pictures.spots.feed("[[Picture: Elba harbour]]\n")
    list(pictures.spots.close(tick_seconds=0.01))

    pictures.settle_outstanding()

    assert len(usage.settled) == 1
