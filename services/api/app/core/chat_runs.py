"""Chat runs: replies the server generates whether or not anyone is watching.

A chat reply used to live inside the browser's HTTP request, so reloading,
closing the tab, or a dropped connection ended the generation. A run is owned
by the server instead. The request that starts it, and any page that comes
back later, only *follow* it:

- the generation runs on its own thread and records every Server-Sent Event
  it produces, in order;
- a follower reads those frames from any position, so a page that reloads
  receives everything so far as one snapshot and then the live frames, and a
  dropped connection resumes after the last frame it saw;
- when the generation ends, ``on_finish`` settles the reply into the stored
  thread (see ``app.core.chat_run_replies``), and the run is kept for a while
  so late followers still see how it ended;
- stopping is explicit (``cancel``): a follower that disconnects stops only
  its own watching. A stop can arrive before its run exists (the request is
  still gathering context), so it is remembered and the run, once started,
  ends without generating.

The registry lives in the API process, which runs as a single worker. A run
is lost if the process restarts; the browser then continues the reply from
the text it already has, as it did before runs existed.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any

logger = logging.getLogger(__name__)

KEEPALIVE_FRAME = ": keep-alive\n\n"
DONE_DATA = "[DONE]"
CANCELLED_ERROR = "The response was cancelled before it finished."
ENDED_EARLY_ERROR = "The response stream ended before it finished."


@dataclass(frozen=True)
class RunTranscript:
    """What a run has said so far."""

    text: str = ""
    activities: tuple[dict[str, Any], ...] = ()
    concealed_prompt: str | None = None
    # The questions a reply paused on (app.core.clarifying_questions).
    questions: dict[str, Any] | None = None
    done: dict[str, Any] | None = None
    error: dict[str, Any] | None = None


def _payload(data: str) -> dict[str, Any] | None:
    if data == DONE_DATA:
        return None
    parsed = json.loads(data)
    return parsed if isinstance(parsed, dict) else None


def is_terminal(data: str) -> bool:
    """Whether a frame ends the reply: completion, failure, or the marker."""
    payload = _payload(data)
    return payload is None or "error" in payload or payload.get("done") is True


@dataclass
class _Fold:
    text: list[str] = field(default_factory=list)
    activities: list[dict[str, Any]] = field(default_factory=list)
    concealed_prompt: str | None = None
    questions: dict[str, Any] | None = None
    done: dict[str, Any] | None = None
    error: dict[str, Any] | None = None

    def add(self, payload: dict[str, Any]) -> None:
        if "error" in payload:
            self.error = payload
        elif payload.get("done") is True:
            self.done = payload
        delta = payload.get("delta")
        if isinstance(delta, str):
            self.text.append(delta)
        activity = payload.get("activity")
        if isinstance(activity, dict):
            self.activities.append(activity)
        privacy = payload.get("privacy")
        if isinstance(privacy, dict) and isinstance(privacy.get("concealed_prompt"), str):
            self.concealed_prompt = privacy["concealed_prompt"]
        questions = payload.get("questions")
        if isinstance(questions, dict):
            self.questions = questions


def transcript_of(frames: Sequence[str]) -> RunTranscript:
    """Fold recorded frames into the reply they describe."""
    fold = _Fold()
    for data in frames:
        payload = _payload(data)
        if payload is not None:
            fold.add(payload)
    return RunTranscript(
        text="".join(fold.text),
        activities=tuple(fold.activities),
        concealed_prompt=fold.concealed_prompt,
        questions=fold.questions,
        done=fold.done,
        error=fold.error,
    )


def _frame_data(frame: str) -> str | None:
    """The data of one generated SSE frame; None for keep-alive comments."""
    if not frame.startswith("data:"):
        return None
    return frame[len("data:") :].strip()


def _sse(position: int, data: str) -> str:
    return f"id: {position}\ndata: {data}\n\n"


class ChatRunConflict(Exception):
    """A run id that already belongs to someone else."""


class ChatRun:
    """One reply's generation and everything it has produced so far."""

    def __init__(self, run_id: str, *, owner_id: str, thread_id: str, base_text: str) -> None:
        self.id = run_id
        self.owner_id = owner_id
        self.thread_id = thread_id
        # Text a resumed reply already had before this run continued it.
        self.base_text = base_text
        # When generation ended, on the wall clock the reply records.
        self.ended_at: datetime | None = None
        self.finished_at: float | None = None
        self._frames: list[str] = []
        self._finished = False
        self._cancel = threading.Event()
        self._changed = threading.Condition()

    @property
    def cancel_requested(self) -> bool:
        return self._cancel.is_set()

    @property
    def finished(self) -> bool:
        with self._changed:
            return self._finished

    def request_cancel(self) -> None:
        self._cancel.set()

    def append(self, data: str) -> None:
        with self._changed:
            self._frames.append(data)
            self._changed.notify_all()

    def has_ending(self) -> bool:
        with self._changed:
            return any(is_terminal(data) for data in self._frames)

    def finish(self, at: float) -> None:
        with self._changed:
            self._finished = True
            self.finished_at = at
            self._changed.notify_all()

    def read(self, after: int, timeout: float) -> tuple[list[str], bool]:
        """Frames after position ``after``, waiting up to ``timeout`` for one.

        ``finished`` is read together with the frames, so when it is True
        no frame will ever follow the ones returned.
        """
        with self._changed:
            if len(self._frames) <= after and not self._finished:
                self._changed.wait(timeout)
            return self._frames[after:], self._finished

    def recorded(self) -> list[str]:
        """Every frame recorded so far, without waiting for more."""
        with self._changed:
            return list(self._frames)

    def wait(self, timeout: float) -> bool:
        with self._changed:
            return self._changed.wait_for(lambda: self._finished, timeout)

    def transcript(self) -> RunTranscript:
        return transcript_of(self.recorded())


class ChatRunRegistry:
    """The process's chat runs, by id."""

    def __init__(
        self,
        *,
        retention_seconds: float = 1800.0,
        keepalive_seconds: float = 10.0,
        max_finished: int = 500,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._retention_seconds = retention_seconds
        self._keepalive_seconds = keepalive_seconds
        self._max_finished = max_finished
        self._monotonic = monotonic
        self._runs: dict[str, ChatRun] = {}
        # Stops that arrived before their run started, by (owner, run id).
        self._early_stops: dict[tuple[str, str], float] = {}
        self._lock = threading.Lock()

    def find(self, run_id: str, owner_id: str) -> ChatRun | None:
        """The caller's run with this id; someone else's run is not found."""
        with self._lock:
            self._prune()
            run = self._runs.get(run_id)
        return run if run is not None and run.owner_id == owner_id else None

    def start(
        self,
        run_id: str,
        *,
        owner_id: str,
        thread_id: str,
        base_text: str,
        frames: Callable[[], Iterator[str]],
        on_finish: Callable[[ChatRun], None],
    ) -> tuple[ChatRun, bool]:
        """Start generating, or return the caller's run already under this id.

        Returns the run and whether this call started it. ``frames`` is only
        called when it did, so a repeated request never generates twice.
        """
        with self._lock:
            self._prune()
            existing = self._runs.get(run_id)
            if existing is not None:
                if existing.owner_id != owner_id:
                    raise ChatRunConflict(run_id)
                return existing, False
            run = ChatRun(run_id, owner_id=owner_id, thread_id=thread_id, base_text=base_text)
            if self._early_stops.pop((owner_id, run_id), None) is not None:
                run.request_cancel()
            self._runs[run_id] = run
        # A daemon thread: a run never holds the API process open at shutdown.
        worker = threading.Thread(target=self._generate, args=(run, frames, on_finish), daemon=True)
        worker.name = f"chat-run-{run_id}"
        worker.start()
        return run, True

    def cancel(self, run_id: str, owner_id: str) -> ChatRun | None:
        """Stop the caller's run, or keep it from starting if it has not yet.

        Returns the run when one was under way. Someone else's run under the
        same id is never touched.
        """
        with self._lock:
            self._prune()
            run = self._runs.get(run_id)
            if run is None or run.owner_id != owner_id:
                self._early_stops[(owner_id, run_id)] = self._monotonic()
                return None
        run.request_cancel()
        return run

    def follow(self, run: ChatRun, *, after: int = 0, snapshot: bool = False) -> Iterator[str]:
        """The run's frames after position ``after``, live until it ends.

        With ``snapshot``, a follower starting from the beginning receives the
        reply so far as one frame instead of every delta again.
        """
        position = max(0, after)
        if snapshot and position == 0:
            frames = run.recorded()
            body = next((index for index, data in enumerate(frames) if is_terminal(data)), len(frames))
            if body:
                yield _sse(body, json.dumps({"snapshot": self._snapshot(run, frames[:body])}))
                position = body
        while True:
            frames, finished = run.read(position, timeout=self._keepalive_seconds)
            for data in frames:
                position += 1
                yield _sse(position, data)
            if finished:
                return
            if not frames:
                yield KEEPALIVE_FRAME

    @staticmethod
    def _snapshot(run: ChatRun, frames: Sequence[str]) -> dict[str, Any]:
        transcript = transcript_of(frames)
        snapshot: dict[str, Any] = {
            "base": run.base_text,
            "text": transcript.text,
            "activities": list(transcript.activities),
            "concealed_prompt": transcript.concealed_prompt,
        }
        if transcript.questions is not None:
            snapshot["questions"] = transcript.questions
        return snapshot

    def _generate(
        self,
        run: ChatRun,
        make_frames: Callable[[], Iterator[str]],
        on_finish: Callable[[ChatRun], None],
    ) -> None:
        _record(run, make_frames)
        if not run.has_ending():
            run.append(json.dumps(self._ending(run)))
        run.ended_at = datetime.now(UTC)
        try:
            on_finish(run)
        except Exception:
            logger.exception("Chat run %s could not save its reply", run.id)
        run.finish(self._monotonic())

    @staticmethod
    def _ending(run: ChatRun) -> dict[str, Any]:
        if run.cancel_requested:
            return {"error": CANCELLED_ERROR, "retryable": False, "cancelled": True}
        return {"error": ENDED_EARLY_ERROR, "retryable": True}

    def _prune(self) -> None:
        """Forget what is past the retention window, then the oldest finished
        runs beyond the cap. Runs still generating are always kept."""
        now = self._monotonic()
        window = self._retention_seconds
        self._early_stops = {key: at for key, at in self._early_stops.items() if now - at <= window}
        finished = sorted(
            (run.finished_at, run_id) for run_id, run in self._runs.items() if run.finished_at is not None
        )
        recent = [run_id for finished_at, run_id in finished if now - finished_at <= window]
        keep = set(recent[max(0, len(recent) - self._max_finished) :])
        for _, run_id in finished:
            if run_id not in keep:
                del self._runs[run_id]


def _record(run: ChatRun, make_frames: Callable[[], Iterator[str]]) -> None:
    """Record the generation's frames until it ends or is stopped."""
    frames: Iterator[str] | None = None
    try:
        frames = iter(()) if run.cancel_requested else make_frames()
        for frame in frames:
            if run.cancel_requested:
                break
            data = _frame_data(frame)
            if data is not None:
                run.append(data)
    except Exception:
        logger.exception("Chat run %s failed while generating", run.id)
    finally:
        _close(run, frames)


def _close(run: ChatRun, frames: Iterator[str] | None) -> None:
    # Closing a stopped generation raises GeneratorExit inside it, which
    # settles provider usage and closes the provider stream.
    close = getattr(frames, "close", None)
    if close is None:
        return
    try:
        close()
    except Exception:
        logger.exception("Chat run %s did not close cleanly", run.id)


@lru_cache(maxsize=1)
def get_chat_run_registry() -> ChatRunRegistry:
    """The API process's one registry."""
    return ChatRunRegistry()
