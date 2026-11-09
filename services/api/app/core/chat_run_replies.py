"""How a finished chat run lands in the stored thread.

A reply in flight is a *unit*: the assistant message itself or, after a
regeneration, one of its response versions. The browser tags the unit with
the id of the run generating it (``metadata.runId``). When the run ends, the
server settles only the unit that still carries that id and is still
pending, so a reply the browser already finished, a newer attempt, or a
deleted message is never overwritten.

Saves race the other way too: a browser closed mid-reply may deliver its
last in-flight save after the server settled the reply.
``keep_settled_replies`` keeps such a stale save from reopening it.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from app.core.chat_runs import RunTranscript
from app.models.schemas import ChatMessage

STOPPED_NOTICE = (
    "You stopped this response before it finished. Regenerate or resend the message to run it again."
)
ENDED_EARLY_NOTICE = "The response ended before it finished. Regenerate to run it again."
EMPTY_REPLY_NOTICE = "The model returned an empty response."


@dataclass(frozen=True)
class ReplyOutcome:
    status: Literal["ok", "error"]
    content: str
    citations: list[dict[str, Any]]
    usage: dict[str, int] | None
    failure_notice: str | None
    activities: list[dict[str, Any]]
    # Set when the reply paused to ask the user: what it asked, waiting on answers.
    clarify: dict[str, Any] | None = None


def join_segment(base: str, text: str) -> str:
    """The browser's segment join: flow on after whitespace, else a new paragraph."""
    if not base or not text:
        return base or text
    joiner = "" if base.endswith(("\n", " ")) else "\n\n"
    return f"{base}{joiner}{text}"


def reply_outcome(transcript: RunTranscript, *, base_text: str, cancelled: bool) -> ReplyOutcome:
    """The reply a run produced, as the browser would have recorded it."""
    content = join_segment(base_text, transcript.text)
    activities = list(transcript.activities)
    if transcript.done is not None and transcript.questions is not None:
        # The reply is written once the user answers; until then it has no text.
        waiting = {"state": "waiting", **transcript.questions}
        return ReplyOutcome("ok", "", [], transcript.done.get("usage"), None, activities, waiting)
    if transcript.done is not None and content:
        return ReplyOutcome(
            status="ok",
            content=content,
            citations=list(transcript.done.get("citations") or []),
            usage=transcript.done.get("usage"),
            failure_notice=None,
            activities=activities,
        )
    notice = _failure_notice(transcript, cancelled)
    if not content:
        return ReplyOutcome("error", notice, [], None, None, activities)
    return ReplyOutcome("error", content, [], None, notice, activities)


def _failure_notice(transcript: RunTranscript, cancelled: bool) -> str:
    if cancelled:
        return STOPPED_NOTICE
    if transcript.done is not None:
        return EMPTY_REPLY_NOTICE
    message = (transcript.error or {}).get("error")
    return message if isinstance(message, str) and message.strip() else ENDED_EARLY_NOTICE


def settle_messages(
    messages: list[ChatMessage],
    run_id: str,
    outcome: ReplyOutcome,
    *,
    completed_at: datetime,
) -> list[ChatMessage] | None:
    """The thread's messages with the run's reply settled; None if it is not pending there."""
    settled = False
    result: list[ChatMessage] = []
    for message in messages:
        revised = _settle_message(message, run_id, outcome, completed_at)
        settled = settled or revised is not None
        result.append(revised or message)
    return result if settled else None


def _versions(message: ChatMessage) -> list[dict[str, Any]]:
    raw = message.metadata.get("responseVersions")
    if not isinstance(raw, list):
        return []
    return [version for version in raw if isinstance(version, dict)]


def _unit_run_id(unit_metadata: object) -> str | None:
    run_id = unit_metadata.get("runId") if isinstance(unit_metadata, dict) else None
    return run_id if isinstance(run_id, str) else None


def _settle_message(
    message: ChatMessage, run_id: str, outcome: ReplyOutcome, completed_at: datetime
) -> ChatMessage | None:
    if message.role != "assistant":
        return None
    versions = _versions(message)
    if versions:
        return _settle_version(message, versions, run_id, outcome, completed_at)
    if _unit_run_id(message.metadata) != run_id or message.status != "pending":
        return None
    fields = _settled_fields(message.executedAt, message.metadata, outcome, completed_at)
    return ChatMessage.model_validate({**message.model_dump(), **fields})


def _settle_version(
    message: ChatMessage,
    versions: list[dict[str, Any]],
    run_id: str,
    outcome: ReplyOutcome,
    completed_at: datetime,
) -> ChatMessage | None:
    index = _pending_version_index(versions, run_id)
    if index is None:
        return None
    version = versions[index]
    fields = _settled_fields(version.get("executedAt"), version.get("metadata") or {}, outcome, completed_at)
    settled_versions = [*versions[:index], {**version, **fields}, *versions[index + 1 :]]
    metadata = {**message.metadata, "responseVersions": settled_versions}
    shown = message.metadata.get("activeResponseVersionIndex") == index
    mirror = _shown_fields(fields, metadata) if shown else {"metadata": metadata}
    return ChatMessage.model_validate({**message.model_dump(), **mirror})


def _pending_version_index(versions: list[dict[str, Any]], run_id: str) -> int | None:
    for position, version in enumerate(versions):
        if _unit_run_id(version.get("metadata")) == run_id and version.get("status") == "pending":
            return position
    return None


def _shown_fields(fields: dict[str, Any], metadata: dict[str, Any]) -> dict[str, Any]:
    """What the message shows when its active version is the one settled."""
    shown = {key: value for key, value in fields.items() if key != "metadata"}
    notice = fields["metadata"].get("failureNotice")
    without_notice = {key: value for key, value in metadata.items() if key != "failureNotice"}
    return {**shown, "metadata": {**without_notice, **({"failureNotice": notice} if notice else {})}}


def _settled_fields(
    executed_at: object,
    metadata: dict[str, Any],
    outcome: ReplyOutcome,
    completed_at: datetime,
) -> dict[str, Any]:
    kept = {key: value for key, value in metadata.items() if key != "failureNotice"}
    notice = {"failureNotice": outcome.failure_notice} if outcome.failure_notice else {}
    paused = {"clarify": {**outcome.clarify, "pausedAt": completed_at.isoformat()}} if outcome.clarify else {}
    return {
        "content": outcome.content,
        "status": outcome.status,
        "citations": outcome.citations,
        "usage": outcome.usage,
        "completedAt": completed_at.isoformat(),
        "durationMs": _duration_ms(executed_at, completed_at, _waited_ms(metadata)),
        "metadata": {**kept, **notice, **paused, "serverSettled": {"activities": outcome.activities}},
    }


def _waited_ms(metadata: dict[str, Any]) -> int:
    """How long the reply sat paused on the user's answers, which is not work."""
    clarify = metadata.get("clarify")
    waited = clarify.get("waitedMs") if isinstance(clarify, dict) else None
    return max(0, waited) if isinstance(waited, int) and not isinstance(waited, bool) else 0


def _duration_ms(executed_at: object, completed_at: datetime, waited_ms: int = 0) -> int | None:
    if not isinstance(executed_at, str):
        return None
    try:
        started = datetime.fromisoformat(executed_at)
    except ValueError:
        return None
    if started.tzinfo is None:
        return None
    return max(0, round((completed_at - started).total_seconds() * 1000) - waited_ms)


def _reply_units(message: ChatMessage) -> Iterator[tuple[str, object]]:
    """Each (run id, status) the message's reply units carry."""
    if message.role != "assistant":
        return
    versions = _versions(message)
    units: list[tuple[object, object]] = (
        [(version.get("metadata"), version.get("status")) for version in versions]
        if versions
        else [(message.metadata, message.status)]
    )
    for unit_metadata, status in units:
        run_id = _unit_run_id(unit_metadata)
        if run_id is not None:
            yield run_id, status


def pending_run_ids(messages: list[ChatMessage]) -> list[str]:
    """The runs a save still shows as generating, each once, in order."""
    found: dict[str, None] = {}
    for message in messages:
        for run_id, status in _reply_units(message):
            if status == "pending":
                found.setdefault(run_id)
    return list(found)


def keep_settled_replies(incoming: list[ChatMessage], stored: list[ChatMessage]) -> list[ChatMessage]:
    """A save's messages, keeping stored ones whose run already settled."""
    stored_by_id = {message.id: message for message in stored}
    return [_newer_of(message, stored_by_id.get(message.id)) for message in incoming]


def _newer_of(incoming: ChatMessage, stored: ChatMessage | None) -> ChatMessage:
    if stored is None:
        return incoming
    stored_status = dict(_reply_units(stored))
    for run_id, status in _reply_units(incoming):
        if status == "pending" and stored_status.get(run_id, "pending") != "pending":
            return stored
    return incoming
