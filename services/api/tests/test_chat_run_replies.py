"""How a finished server run lands in the stored chat thread."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.core.chat_run_replies import (
    STOPPED_NOTICE,
    keep_settled_replies,
    reply_outcome,
    settle_messages,
)
from app.core.chat_runs import RunTranscript
from app.models.schemas import ChatMessage

COMPLETED = datetime(2026, 11, 5, 15, 0, 30, tzinfo=UTC)
CITATION = {
    "id": "citation-1",
    "source_name": "Matter policy",
    "source_type": "knowledge",
    "source_uri": "knowledge://matter-policy",
    "snippet": "Retention is seven years.",
}


def _done(**extra) -> dict:
    return {"done": True, "citations": [CITATION], "usage": {"prompt_tokens": 3, "completion_tokens": 5, "total_tokens": 8}, **extra}


def _pending(run_id: str = "run-1", **overrides) -> ChatMessage:
    fields = {
        "id": "msg-reply",
        "role": "assistant",
        "content": "Hel",
        "createdAt": "3:00 PM",
        "createdAtIso": "2026-11-05T15:00:00+00:00",
        "executedAt": "2026-11-05T15:00:00+00:00",
        "status": "pending",
        "metadata": {"runId": run_id, "clockSource": "server"},
        "activityTrace": [{"id": "route:model", "label": "Routed to GPT"}],
    }
    return ChatMessage.model_validate({**fields, **overrides})


def _user() -> ChatMessage:
    return ChatMessage(id="msg-user", role="user", content="Hello", createdAt="3:00 PM")


# --- outcome -----------------------------------------------------------


def test_a_finished_run_is_an_ok_reply_with_its_citations_and_usage() -> None:
    outcome = reply_outcome(
        RunTranscript(text="Hello world", activities=({"kind": "web", "results": 3, "engine": "searxng"},), done=_done()),
        base_text="",
        cancelled=False,
    )

    assert outcome.status == "ok"
    assert outcome.content == "Hello world"
    assert outcome.citations == [CITATION]
    assert outcome.usage == {"prompt_tokens": 3, "completion_tokens": 5, "total_tokens": 8}
    assert outcome.failure_notice is None
    assert outcome.activities == [{"kind": "web", "results": 3, "engine": "searxng"}]


def test_a_resumed_run_continues_the_text_already_delivered() -> None:
    joined = reply_outcome(RunTranscript(text="second half.", done=_done()), base_text="First half", cancelled=False)
    flowing = reply_outcome(RunTranscript(text="second half.", done=_done()), base_text="First half ", cancelled=False)

    assert joined.content == "First half\n\nsecond half."
    assert flowing.content == "First half second half."


def test_a_failure_after_real_text_keeps_the_text_and_notes_the_failure() -> None:
    outcome = reply_outcome(
        RunTranscript(text="Partial", error={"error": "Provider did not return a completion: timeout", "retryable": True}),
        base_text="",
        cancelled=False,
    )

    assert outcome.status == "error"
    assert outcome.content == "Partial"
    assert outcome.failure_notice == "Provider did not return a completion: timeout"


def test_a_failure_before_any_text_shows_the_failure_itself() -> None:
    outcome = reply_outcome(
        RunTranscript(error={"error": "Usage budget exhausted.", "retryable": False}),
        base_text="",
        cancelled=False,
    )

    assert outcome.status == "error"
    assert outcome.content == "Usage budget exhausted."
    assert outcome.failure_notice is None


def test_a_stopped_run_says_the_person_stopped_it() -> None:
    outcome = reply_outcome(
        RunTranscript(text="Partial", error={"error": "cancelled", "retryable": False, "cancelled": True}),
        base_text="",
        cancelled=True,
    )

    assert outcome.status == "error"
    assert outcome.content == "Partial"
    assert outcome.failure_notice == STOPPED_NOTICE


def test_a_run_that_ended_with_no_words_is_not_an_ok_reply() -> None:
    outcome = reply_outcome(RunTranscript(done=_done()), base_text="", cancelled=False)

    assert outcome.status == "error"
    assert outcome.content == "The model returned an empty response."


def test_a_run_with_no_ending_at_all_reads_as_ended_early() -> None:
    outcome = reply_outcome(RunTranscript(text="Half"), base_text="", cancelled=False)

    assert outcome.status == "error"
    assert outcome.content == "Half"
    assert outcome.failure_notice == "The response ended before it finished. Regenerate to run it again."


# --- settling the stored thread ------------------------------------------


def _ok_outcome():
    return reply_outcome(
        RunTranscript(text="Hello world", activities=({"kind": "knowledge", "passages": 2, "sources": 1},), done=_done()),
        base_text="",
        cancelled=False,
    )


def test_the_pending_reply_carrying_the_run_id_becomes_the_finished_reply() -> None:
    settled = settle_messages([_user(), _pending()], "run-1", _ok_outcome(), completed_at=COMPLETED)

    assert settled is not None
    user, reply = settled
    assert user == _user()
    assert reply.status == "ok"
    assert reply.content == "Hello world"
    assert [citation.source_name for citation in reply.citations] == ["Matter policy"]
    assert reply.usage == {"prompt_tokens": 3, "completion_tokens": 5, "total_tokens": 8}
    assert reply.completedAt == COMPLETED.isoformat()
    assert reply.durationMs == 30_000
    assert reply.activityTrace == _pending().activityTrace
    assert reply.metadata["runId"] == "run-1"
    assert reply.metadata["clockSource"] == "server"
    assert reply.metadata["serverSettled"] == {
        "activities": [{"kind": "knowledge", "passages": 2, "sources": 1}],
    }
    assert "failureNotice" not in reply.metadata


def test_a_failed_run_records_its_notice_on_the_reply() -> None:
    outcome = reply_outcome(
        RunTranscript(text="Partial", error={"error": "timeout", "retryable": True}), base_text="", cancelled=False
    )

    settled = settle_messages([_pending()], "run-1", outcome, completed_at=COMPLETED)

    assert settled is not None
    assert settled[0].status == "error"
    assert settled[0].metadata["failureNotice"] == "timeout"


def test_nothing_changes_when_no_pending_reply_carries_the_run_id() -> None:
    finished = _pending(status="ok", content="Done by the browser")

    assert settle_messages([_pending("run-2")], "run-1", _ok_outcome(), completed_at=COMPLETED) is None
    assert settle_messages([finished], "run-1", _ok_outcome(), completed_at=COMPLETED) is None
    assert settle_messages([_user()], "run-1", _ok_outcome(), completed_at=COMPLETED) is None
    assert settle_messages([_regenerated()], "run-9", _ok_outcome(), completed_at=COMPLETED) is None


def _version(version_id: str, run_id: str, status: str, content: str) -> dict:
    return {
        "id": version_id,
        "label": version_id,
        "content": content,
        "status": status,
        "citations": [],
        "executedAt": "2026-11-05T15:00:00+00:00",
        "activityTrace": [{"id": "route:model", "label": "Routed to GPT"}],
        "metadata": {"runId": run_id},
    }


def _regenerated(active_index: int = 1) -> ChatMessage:
    versions = [
        _version("version-1", "run-0", "ok", "First answer"),
        _version("version-2", "run-1", "pending", "Sec"),
    ]
    active = versions[active_index]
    return _pending(
        "run-0",
        content=active["content"],
        status=active["status"],
        metadata={
            "runId": "run-0",
            "responseVersions": versions,
            "activeResponseVersionIndex": active_index,
            "activeResponseVersionId": active["id"],
        },
    )


def test_a_regenerated_reply_settles_its_own_version_and_shows_it_when_active() -> None:
    settled = settle_messages([_regenerated()], "run-1", _ok_outcome(), completed_at=COMPLETED)

    assert settled is not None
    reply = settled[0]
    first, second = reply.metadata["responseVersions"]
    assert first == _version("version-1", "run-0", "ok", "First answer")
    assert second["status"] == "ok"
    assert second["content"] == "Hello world"
    assert second["citations"] == [CITATION]
    assert second["durationMs"] == 30_000
    assert second["metadata"]["serverSettled"]["activities"] == [{"kind": "knowledge", "passages": 2, "sources": 1}]
    assert reply.status == "ok"
    assert reply.content == "Hello world"
    assert reply.completedAt == COMPLETED.isoformat()


def test_a_regenerated_version_that_is_not_shown_settles_without_changing_what_is_shown() -> None:
    settled = settle_messages([_regenerated(active_index=0)], "run-1", _ok_outcome(), completed_at=COMPLETED)

    assert settled is not None
    reply = settled[0]
    assert reply.metadata["responseVersions"][1]["status"] == "ok"
    assert reply.status == "ok"
    assert reply.content == "First answer"


# --- browser saves after the server settled ----------------------------


def test_a_late_browser_save_cannot_reopen_a_reply_the_server_finished() -> None:
    stored = settle_messages([_user(), _pending()], "run-1", _ok_outcome(), completed_at=COMPLETED)
    assert stored is not None

    kept = keep_settled_replies([_user(), _pending()], stored)

    assert kept[1].status == "ok"
    assert kept[1].content == "Hello world"


def test_a_browser_save_for_a_newer_attempt_is_accepted() -> None:
    stored = settle_messages([_pending()], "run-1", _ok_outcome(), completed_at=COMPLETED)
    assert stored is not None
    retry = _pending("run-2", content="")

    assert keep_settled_replies([retry], stored) == [retry]


def test_a_browser_save_that_finishes_the_reply_replaces_the_server_copy() -> None:
    stored = settle_messages([_pending()], "run-1", _ok_outcome(), completed_at=COMPLETED)
    assert stored is not None
    finished = _pending(status="ok", content="Hello world", activityTrace=[{"id": "done:reply", "label": "Delivered"}])

    assert keep_settled_replies([finished], stored) == [finished]


def test_a_late_save_cannot_reopen_a_finished_regeneration() -> None:
    stored = settle_messages([_regenerated()], "run-1", _ok_outcome(), completed_at=COMPLETED)
    assert stored is not None

    kept = keep_settled_replies([_regenerated()], stored)

    assert kept[0].metadata["responseVersions"][1]["status"] == "ok"


def test_saves_without_run_ids_are_untouched() -> None:
    legacy_stored = ChatMessage(id="msg-reply", role="assistant", content="Done", createdAt="3:00 PM", status="ok")
    legacy_pending = ChatMessage(id="msg-reply", role="assistant", content="Do", createdAt="3:00 PM", status="pending")

    assert keep_settled_replies([legacy_pending], [legacy_stored]) == [legacy_pending]
    assert keep_settled_replies([_user()], []) == [_user()]


def test_the_runs_still_pending_in_a_save_are_listed_once_each() -> None:
    from app.core.chat_run_replies import pending_run_ids

    finished = _pending("run-0", status="ok")
    assert pending_run_ids([_user(), finished, _pending("run-1"), _regenerated()]) == ["run-1"]
    assert pending_run_ids([_user(), _pending("run-3")]) == ["run-3"]
    assert pending_run_ids([_user()]) == []


def test_a_reply_without_a_usable_start_time_records_no_duration() -> None:
    for executed_at in (None, "not a time", "2026-11-05T15:00:00"):
        reply = _pending(executedAt=executed_at)

        settled = settle_messages([reply], "run-1", _ok_outcome(), completed_at=COMPLETED)

        assert settled is not None
        assert settled[0].durationMs is None


def test_a_clock_that_shows_the_reply_finishing_early_records_no_negative_duration() -> None:
    reply = _pending(executedAt="2026-11-05T15:01:00+00:00")

    settled = settle_messages([reply], "run-1", _ok_outcome(), completed_at=COMPLETED)

    assert settled is not None
    assert settled[0].durationMs == 0


# --- clarifying questions ---------------------------------------------------

QUESTIONS = {
    "intro": "One question first.",
    "questions": [
        {"id": "q1", "question": "Which state?", "options": [{"label": "CA"}, {"label": "NY"}], "multiple": False, "recommended": 0}
    ],
}


def test_a_run_that_paused_to_ask_is_an_ok_reply_waiting_on_its_questions() -> None:
    outcome = reply_outcome(
        RunTranscript(text="One question first.\n\n", activities=({"kind": "ask", "questions": 1},), questions=QUESTIONS, done=_done(citations=[])),
        base_text="",
        cancelled=False,
    )

    assert outcome.status == "ok"
    assert outcome.content == ""
    assert outcome.failure_notice is None
    assert outcome.clarify == {"state": "waiting", **QUESTIONS}


def test_a_paused_reply_is_stored_with_its_questions_and_when_it_paused() -> None:
    outcome = reply_outcome(RunTranscript(questions=QUESTIONS, done=_done(citations=[])), base_text="", cancelled=False)

    messages = settle_messages([_user(), _pending(content="")], "run-1", outcome, completed_at=COMPLETED)

    assert messages is not None
    reply = messages[1]
    assert reply.status == "ok"
    assert reply.content == ""
    assert reply.metadata["clarify"] == {"state": "waiting", **QUESTIONS, "pausedAt": COMPLETED.isoformat()}


def test_time_spent_waiting_on_the_user_is_not_counted_as_work() -> None:
    outcome = reply_outcome(RunTranscript(text="Answer", done=_done()), base_text="", cancelled=False)
    answered = {"state": "answered", **QUESTIONS, "waitedMs": 20_000}
    pending = _pending(metadata={"runId": "run-1", "clarify": answered})

    messages = settle_messages([_user(), pending], "run-1", outcome, completed_at=COMPLETED)

    assert messages is not None
    assert messages[1].durationMs == 10_000
    assert messages[1].metadata["clarify"] == answered


@pytest.mark.parametrize("waited", [-5_000, True, "20000", None])
def test_a_malformed_waiting_time_is_not_taken_off_the_duration(waited: object) -> None:
    outcome = reply_outcome(RunTranscript(text="Answer", done=_done()), base_text="", cancelled=False)
    pending = _pending(metadata={"runId": "run-1", "clarify": {"state": "answered", **QUESTIONS, "waitedMs": waited}})

    messages = settle_messages([_user(), pending], "run-1", outcome, completed_at=COMPLETED)

    assert messages is not None
    assert messages[1].durationMs == 30_000
