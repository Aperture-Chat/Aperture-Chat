"""A chat run belongs to the server: watchers come and go, the work goes on."""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Iterator

import pytest

from app.core.chat_runs import ChatRun, ChatRunConflict, ChatRunRegistry


def _data(frame: str) -> object:
    payload = frame.split("data: ", 1)[1].strip()
    return payload if payload == "[DONE]" else json.loads(payload)


def _content_frames(frames: list[str]) -> list[str]:
    return [frame for frame in frames if not frame.startswith(":")]


def _gated_reply(gate: threading.Event) -> Iterator[str]:
    yield 'data: {"activity": {"kind": "knowledge", "passages": 2, "sources": 1}}\n\n'
    yield 'data: {"delta": "Hello"}\n\n'
    gate.wait(5)
    yield ": keep-alive\n\n"
    yield 'data: {"delta": " world"}\n\n'
    yield 'data: {"done": true, "citations": [], "usage": null}\n\n'
    yield "data: [DONE]\n\n"


def _start(registry: ChatRunRegistry, frames, finished: list[ChatRun], run_id: str = "run-1"):
    return registry.start(
        run_id,
        owner_id="user-jane",
        thread_id="thread-1",
        base_text="",
        frames=frames,
        on_finish=finished.append,
    )


def test_a_watcher_sees_each_frame_live_with_its_position_and_the_stream_ends_with_the_run() -> None:
    gate = threading.Event()
    finished: list[ChatRun] = []
    registry = ChatRunRegistry(keepalive_seconds=0.05)
    run, created = _start(registry, lambda: _gated_reply(gate), finished)
    assert created is True

    watcher = registry.follow(run, after=0)
    assert next(watcher).startswith("id: 1\n")
    assert next(watcher) == 'id: 2\ndata: {"delta": "Hello"}\n\n'
    gate.set()
    rest = _content_frames(list(watcher))

    assert rest == [
        'id: 3\ndata: {"delta": " world"}\n\n',
        'id: 4\ndata: {"done": true, "citations": [], "usage": null}\n\n',
        "id: 5\ndata: [DONE]\n\n",
    ]
    assert finished == [run]


def test_the_run_finishes_after_every_watcher_has_gone() -> None:
    gate = threading.Event()
    finished: list[ChatRun] = []
    registry = ChatRunRegistry(keepalive_seconds=0.05)
    run, _ = _start(registry, lambda: _gated_reply(gate), finished)

    watcher = registry.follow(run, after=0)
    next(watcher)
    watcher.close()
    gate.set()

    assert run.wait(5) is True
    assert run.transcript().text == "Hello world"
    assert run.transcript().done is not None
    assert finished == [run]


def test_a_quiet_run_keeps_its_watchers_alive() -> None:
    gate = threading.Event()
    registry = ChatRunRegistry(keepalive_seconds=0.01)
    run, _ = _start(registry, lambda: _gated_reply(gate), [])

    watcher = registry.follow(run, after=2)
    assert next(watcher) == ": keep-alive\n\n"
    gate.set()
    assert _content_frames(list(watcher))[-1] == "id: 5\ndata: [DONE]\n\n"


def test_a_page_that_comes_back_gets_everything_so_far_in_one_snapshot() -> None:
    gate = threading.Event()
    gate.set()
    registry = ChatRunRegistry(keepalive_seconds=0.05)
    run, _ = registry.start(
        "run-1",
        owner_id="user-jane",
        thread_id="thread-1",
        base_text="Earlier part",
        frames=lambda: _gated_reply(gate),
        on_finish=lambda _run: None,
    )
    assert run.wait(5)

    frames = _content_frames(list(registry.follow(run, after=0, snapshot=True)))

    assert frames[0].startswith("id: 3\n")
    assert _data(frames[0]) == {
        "snapshot": {
            "base": "Earlier part",
            "text": "Hello world",
            "activities": [{"kind": "knowledge", "passages": 2, "sources": 1}],
            "concealed_prompt": None,
        }
    }
    assert [_data(frame) for frame in frames[1:]] == [
        {"done": True, "citations": [], "usage": None},
        "[DONE]",
    ]


def test_a_watcher_that_reconnects_continues_after_the_last_frame_it_saw() -> None:
    gate = threading.Event()
    gate.set()
    registry = ChatRunRegistry(keepalive_seconds=0.05)
    run, _ = _start(registry, lambda: _gated_reply(gate), [])
    assert run.wait(5)

    frames = _content_frames(list(registry.follow(run, after=3)))

    assert [frame.split("\n", 1)[0] for frame in frames] == ["id: 4", "id: 5"]


def test_cancel_closes_the_provider_stream_and_ends_the_run_with_a_cancellation() -> None:
    closed = threading.Event()
    started = threading.Event()

    def endless() -> Iterator[str]:
        try:
            yield 'data: {"delta": "Partial"}\n\n'
            started.set()
            while True:
                yield ": keep-alive\n\n"
                closed.wait(0.01)
        except GeneratorExit:
            closed.set()
            raise

    finished: list[ChatRun] = []
    registry = ChatRunRegistry(keepalive_seconds=0.05)
    run, _ = _start(registry, endless, finished)
    assert started.wait(5)

    assert registry.cancel("run-1", "user-jane") is run

    assert run.wait(5)
    assert closed.is_set()
    assert run.cancel_requested is True
    transcript = run.transcript()
    assert transcript.text == "Partial"
    assert transcript.error == {
        "error": "The response was cancelled before it finished.",
        "retryable": False,
        "cancelled": True,
    }
    assert finished == [run]


def test_a_crashed_generation_ends_with_a_retryable_error_watchers_can_act_on() -> None:
    def crashing() -> Iterator[str]:
        yield 'data: {"delta": "Half"}\n\n'
        raise RuntimeError("provider socket vanished")

    registry = ChatRunRegistry(keepalive_seconds=0.05)
    run, _ = _start(registry, crashing, [])

    assert run.wait(5)
    assert run.transcript().error == {
        "error": "The response stream ended before it finished.",
        "retryable": True,
    }


def test_a_settle_failure_still_finishes_the_run() -> None:
    gate = threading.Event()
    gate.set()

    def failing_settle(_run: ChatRun) -> None:
        raise RuntimeError("database unavailable")

    registry = ChatRunRegistry(keepalive_seconds=0.05)
    run, _ = registry.start(
        "run-1",
        owner_id="user-jane",
        thread_id="thread-1",
        base_text="",
        frames=lambda: _gated_reply(gate),
        on_finish=failing_settle,
    )

    assert run.wait(5) is True


def test_starting_a_run_twice_attaches_to_the_first_instead_of_generating_again() -> None:
    gate = threading.Event()
    calls: list[int] = []

    def counted() -> Iterator[str]:
        calls.append(1)
        return _gated_reply(gate)

    registry = ChatRunRegistry(keepalive_seconds=0.05)
    first, created_first = _start(registry, counted, [])
    second, created_second = _start(registry, counted, [])
    gate.set()
    assert first.wait(5)

    assert (created_first, created_second) == (True, False)
    assert second is first
    assert calls == [1]


def test_a_run_id_is_never_shared_across_people() -> None:
    gate = threading.Event()
    gate.set()
    registry = ChatRunRegistry(keepalive_seconds=0.05)
    run, _ = _start(registry, lambda: _gated_reply(gate), [])

    assert registry.find("run-1", "user-jane") is run
    assert registry.find("run-1", "user-casey") is None
    with pytest.raises(ChatRunConflict):
        registry.start(
            "run-1",
            owner_id="user-casey",
            thread_id="thread-2",
            base_text="",
            frames=lambda: _gated_reply(gate),
            on_finish=lambda _run: None,
        )


def test_finished_runs_are_forgotten_after_the_retention_window() -> None:
    now = [100.0]
    gate = threading.Event()
    gate.set()
    registry = ChatRunRegistry(keepalive_seconds=0.05, retention_seconds=60, monotonic=lambda: now[0])
    run, _ = _start(registry, lambda: _gated_reply(gate), [])
    assert run.wait(5)

    now[0] = 160.0
    assert registry.find("run-1", "user-jane") is run
    now[0] = 160.5
    assert registry.find("run-1", "user-jane") is None


def test_only_the_newest_finished_runs_are_kept_when_too_many_pile_up() -> None:
    now = [0.0]
    gate = threading.Event()
    gate.set()
    registry = ChatRunRegistry(keepalive_seconds=0.05, max_finished=2, monotonic=lambda: now[0])
    for index, run_id in enumerate(["run-c", "run-b", "run-a"]):
        now[0] = float(index)
        run, _ = _start(registry, lambda: _gated_reply(gate), [], run_id=run_id)
        assert run.wait(5)

    assert registry.find("run-c", "user-jane") is None
    assert registry.find("run-b", "user-jane") is not None
    assert registry.find("run-a", "user-jane") is not None


def test_a_run_still_generating_is_never_forgotten() -> None:
    gate = threading.Event()
    registry = ChatRunRegistry(keepalive_seconds=0.05, retention_seconds=0, max_finished=0)
    run, _ = _start(registry, lambda: _gated_reply(gate), [])

    assert registry.find("run-1", "user-jane") is run
    gate.set()
    assert run.wait(5)


def test_a_stop_that_arrives_before_its_run_starts_keeps_it_from_generating() -> None:
    calls: list[int] = []

    def never_called() -> Iterator[str]:
        calls.append(1)
        yield 'data: {"delta": "Should not run"}\n\n'

    finished: list[ChatRun] = []
    registry = ChatRunRegistry(keepalive_seconds=0.05)
    assert registry.cancel("run-1", "user-jane") is None

    run, created = _start(registry, never_called, finished)

    assert created is True
    assert run.wait(5)
    assert calls == []
    assert run.transcript().error == {
        "error": "The response was cancelled before it finished.",
        "retryable": False,
        "cancelled": True,
    }
    assert finished == [run]


def test_someone_elses_stop_never_touches_a_run() -> None:
    gate = threading.Event()
    registry = ChatRunRegistry(keepalive_seconds=0.05)
    run, _ = _start(registry, lambda: _gated_reply(gate), [])

    assert registry.cancel("run-1", "user-casey") is None
    gate.set()

    assert run.wait(5)
    assert run.cancel_requested is False
    assert run.transcript().done is not None


def test_a_remembered_stop_is_forgotten_after_the_retention_window() -> None:
    now = [100.0]
    gate = threading.Event()
    gate.set()
    registry = ChatRunRegistry(keepalive_seconds=0.05, retention_seconds=60, monotonic=lambda: now[0])
    registry.cancel("run-1", "user-jane")
    registry.cancel("run-2", "user-jane")

    now[0] = 160.0
    remembered, _ = _start(registry, lambda: _gated_reply(gate), [], run_id="run-2")
    now[0] = 160.5
    forgotten, _ = _start(registry, lambda: _gated_reply(gate), [])

    assert remembered.wait(5) and forgotten.wait(5)
    assert remembered.cancel_requested is True
    assert forgotten.transcript().done is not None


def test_a_transcript_keeps_the_concealed_prompt_and_ignores_unknown_frames() -> None:
    from app.core.chat_runs import transcript_of

    transcript = transcript_of(
        [
            '{"privacy": {"concealed_prompt": "Email [EMAIL_1]"}}',
            '{"privacy": {"other": true}}',
            "[1, 2]",
            '{"delta": "Hi"}',
            "[DONE]",
        ]
    )

    assert transcript.concealed_prompt == "Email [EMAIL_1]"
    assert transcript.text == "Hi"


def test_a_generation_that_cannot_close_still_finishes_the_run() -> None:
    class Unclosable:
        def __iter__(self):
            return self

        def __next__(self) -> str:
            raise StopIteration

        def close(self) -> None:
            raise RuntimeError("socket already gone")

    registry = ChatRunRegistry(keepalive_seconds=0.05)
    run, _ = _start(registry, Unclosable, [])

    assert run.wait(5)
    assert run.transcript().error is not None


def test_a_generation_that_reports_its_own_failure_ends_with_that_failure() -> None:
    def failing() -> Iterator[str]:
        yield 'data: {"delta": "Half"}\n\n'
        yield 'data: {"error": "Provider did not return a completion: 529", "retryable": true}\n\n'

    registry = ChatRunRegistry(keepalive_seconds=0.05)
    run, _ = _start(registry, failing, [])
    assert run.wait(5)

    assert run.transcript().error == {"error": "Provider did not return a completion: 529", "retryable": True}
    snapshot, *rest = _content_frames(list(registry.follow(run, after=0, snapshot=True)))
    assert _data(snapshot)["snapshot"]["text"] == "Half"
    assert [_data(frame) for frame in rest] == [run.transcript().error]


def test_a_watcher_of_a_quiet_run_waits_instead_of_spinning() -> None:
    gate = threading.Event()
    registry = ChatRunRegistry(keepalive_seconds=0.05)
    run, _ = _start(registry, lambda: _gated_reply(gate), [])
    assert next(registry.follow(run, after=0)).startswith("id: 1")
    time.sleep(0.05)

    started = time.monotonic()
    frames, finished = run.read(2, timeout=0.3)
    waited = time.monotonic() - started
    gate.set()

    assert (frames, finished) == ([], False)
    assert waited >= 0.25
    assert run.wait(5)


def test_a_snapshot_of_a_run_with_nothing_yet_does_not_wait() -> None:
    gate = threading.Event()
    registry = ChatRunRegistry(keepalive_seconds=0.05)

    def silent() -> Iterator[str]:
        gate.wait(5)
        yield "data: [DONE]\n\n"

    run, _ = _start(registry, silent, [])
    started = time.monotonic()
    first = next(registry.follow(run, after=0, snapshot=True))
    waited = time.monotonic() - started
    gate.set()

    assert first == ": keep-alive\n\n"
    assert waited < 0.5
    assert run.wait(5)


def test_a_run_never_holds_the_server_open_at_shutdown() -> None:
    gate = threading.Event()
    registry = ChatRunRegistry(keepalive_seconds=0.05)
    _start(registry, lambda: _gated_reply(gate), [])

    workers = [thread for thread in threading.enumerate() if thread.name == "chat-run-run-1"]
    gate.set()

    assert workers and all(thread.daemon for thread in workers)
