"""The GitHub star request: asked a few days in, once more two weeks later, then never."""

from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient
import pytest

from app.core import clock
from app.core.config import get_settings
from app.core.star_prompt import answer_star_prompt, check_star_prompt
from app.main import app
from app.models.schemas import StarPrompt, StarPromptAsk
from app.repositories.deps import get_store

client = TestClient(app)
START = datetime(2026, 11, 1, 9, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_settings.cache_clear()
    get_store.cache_clear()
    yield
    get_store.cache_clear()
    get_settings.cache_clear()


def _days(count: float) -> datetime:
    return START + timedelta(days=count)


# --- The rule ---------------------------------------------------------------


def test_first_visit_starts_the_clock_without_asking() -> None:
    prompt, ask = check_star_prompt(None, START)

    assert ask is None
    assert prompt == StarPrompt(started_at=START)


def test_nothing_is_asked_in_the_first_three_days() -> None:
    prompt, _ = check_star_prompt(None, START)

    prompt, ask = check_star_prompt(prompt, _days(2.99))

    assert ask is None
    assert prompt.asks == []


def test_first_ask_comes_three_days_after_the_first_visit_and_is_recorded() -> None:
    prompt, _ = check_star_prompt(None, START)

    prompt, ask = check_star_prompt(prompt, _days(3))

    assert ask == 1
    assert prompt.asks == [StarPromptAsk(asked_at=_days(3))]


def test_an_ask_is_shown_once_even_if_it_is_never_answered() -> None:
    prompt, _ = check_star_prompt(None, START)
    prompt, _ = check_star_prompt(prompt, _days(3))

    prompt, ask = check_star_prompt(prompt, _days(4))

    assert ask is None
    assert len(prompt.asks) == 1


def test_second_ask_comes_two_weeks_after_the_first_ask() -> None:
    prompt, _ = check_star_prompt(None, START)
    prompt, _ = check_star_prompt(prompt, _days(5))
    prompt = answer_star_prompt(prompt, "later")

    early, ask_early = check_star_prompt(prompt, _days(5 + 13.9))
    prompt, ask = check_star_prompt(prompt, _days(5 + 14))

    assert ask_early is None
    assert early.asks == prompt.asks[:1]
    assert ask == 2
    assert len(prompt.asks) == 2


def test_never_asked_again_after_the_second_ask() -> None:
    prompt, _ = check_star_prompt(None, START)
    prompt, _ = check_star_prompt(prompt, _days(3))
    prompt, _ = check_star_prompt(prompt, _days(17))
    prompt = answer_star_prompt(prompt, "later")

    prompt, ask = check_star_prompt(prompt, _days(400))

    assert ask is None
    assert len(prompt.asks) == 2


def test_someone_who_went_to_star_is_not_asked_a_second_time() -> None:
    prompt, _ = check_star_prompt(None, START)
    prompt, _ = check_star_prompt(prompt, _days(3))
    prompt = answer_star_prompt(prompt, "star")

    prompt, ask = check_star_prompt(prompt, _days(60))

    assert ask is None
    assert prompt.asks == [StarPromptAsk(asked_at=_days(3), answer="star")]


def test_an_answer_lands_on_the_latest_ask_and_never_overwrites_one() -> None:
    prompt, _ = check_star_prompt(None, START)
    prompt, _ = check_star_prompt(prompt, _days(3))
    prompt = answer_star_prompt(prompt, "later")

    again = answer_star_prompt(prompt, "star")

    assert again.asks[-1].answer == "later"


def test_answering_the_second_ask_keeps_both_asks_as_they_were() -> None:
    prompt, _ = check_star_prompt(None, START)
    prompt, _ = check_star_prompt(prompt, _days(3))
    prompt = answer_star_prompt(prompt, "later")
    prompt, _ = check_star_prompt(prompt, _days(17))

    prompt = answer_star_prompt(prompt, "star")

    assert prompt.asks == [
        StarPromptAsk(asked_at=_days(3), answer="later"),
        StarPromptAsk(asked_at=_days(17), answer="star"),
    ]


def test_an_answer_without_an_open_ask_changes_nothing() -> None:
    assert answer_star_prompt(None, "star") is None
    prompt, _ = check_star_prompt(None, START)
    assert answer_star_prompt(prompt, "star") == prompt


# --- The endpoints ----------------------------------------------------------


def _at(monkeypatch: pytest.MonkeyPatch, when: datetime) -> None:
    monkeypatch.setattr(clock, "now", lambda: when)


def _check(user_id: str = "user-jane") -> dict:
    response = client.post("/api/auth/star-prompt/check", headers={"x-aperture-user": user_id})
    assert response.status_code == 200
    return response.json()


def _answer(answer: str, user_id: str = "user-jane") -> int:
    return client.post(
        "/api/auth/star-prompt/answer",
        headers={"x-aperture-user": user_id},
        json={"answer": answer},
    ).status_code


def test_endpoints_ask_twice_over_a_user_lifetime(monkeypatch: pytest.MonkeyPatch) -> None:
    _at(monkeypatch, START)
    assert _check() == {"ask": None}

    _at(monkeypatch, _days(3))
    assert _check() == {"ask": 1}
    assert _check() == {"ask": None}
    assert _answer("later") == 204

    _at(monkeypatch, _days(17))
    assert _check() == {"ask": 2}
    assert _answer("later") == 204

    _at(monkeypatch, _days(365))
    assert _check() == {"ask": None}

    stored = get_store().users["user-jane"].star_prompt
    assert stored is not None
    assert [ask.answer for ask in stored.asks] == ["later", "later"]


def test_each_user_keeps_their_own_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    _at(monkeypatch, START)
    _check("user-jane")

    _at(monkeypatch, _days(3))
    assert _check("user-jane") == {"ask": 1}
    assert _check("user-admin") == {"ask": None}


def test_answer_rejects_unknown_values() -> None:
    assert _answer("maybe") == 422


def test_star_prompt_requires_a_signed_in_user() -> None:
    response = client.post("/api/auth/star-prompt/check")
    assert response.status_code == 401


def test_users_saved_before_the_star_prompt_existed_still_load() -> None:
    from app.models.schemas import User
    from app.repositories.identity_config_sql import _model_from_payload

    legacy = User(id="user-legacy", email="legacy@example.test", display_name="Legacy").model_dump(mode="json")
    legacy.pop("star_prompt")

    loaded = _model_from_payload(User, legacy, "users")

    assert loaded.star_prompt is None
