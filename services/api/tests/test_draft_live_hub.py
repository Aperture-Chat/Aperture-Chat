"""Fan-out and presence for people editing the same draft."""

from __future__ import annotations

import asyncio
from threading import Thread

from app.core.draft_live_hub import (
    PRESENCE_COLORS,
    QUEUE_LIMIT,
    DraftLiveHub,
    Participant,
    PresenceFocus,
    presence_color,
)

KEY = ("tenant-a", "draft-1")


def _person(client_id: str, user_id: str, name: str) -> Participant:
    return Participant(client_id=client_id, user_id=user_id, display_name=name, color=presence_color(user_id))


async def _drain(queue: asyncio.Queue) -> list[dict]:
    await asyncio.sleep(0)
    events = []
    while not queue.empty():
        events.append(queue.get_nowait())
    return events


def _names(event: dict) -> list[str]:
    return [person["display_name"] for person in event["data"]["participants"]]


def test_everyone_in_a_draft_hears_events_published_from_another_thread() -> None:
    async def scenario() -> None:
        hub = DraftLiveHub()
        ana = hub.subscribe(KEY, _person("client-ana-01", "user-ana", "Ana"))
        ben = hub.subscribe(KEY, _person("client-ben-01", "user-ben", "Ben"))
        elsewhere = hub.subscribe(("tenant-a", "draft-2"), _person("client-cy-001", "user-cy", "Cy"))
        await _drain(ana.queue), await _drain(ben.queue), await _drain(elsewhere.queue)

        sender = Thread(target=hub.publish, args=(KEY, {"event": "live", "data": {"seq": 3}}))
        sender.start()
        sender.join()

        assert await _drain(ana.queue) == [{"event": "live", "data": {"seq": 3}}]
        assert await _drain(ben.queue) == [{"event": "live", "data": {"seq": 3}}]
        assert await _drain(elsewhere.queue) == []

    asyncio.run(scenario())


def test_presence_lists_who_is_here_and_drops_them_when_they_leave() -> None:
    async def scenario() -> None:
        hub = DraftLiveHub()
        ben = hub.subscribe(KEY, _person("client-ben-01", "user-ben", "Ben"))
        assert _names((await _drain(ben.queue))[-1]) == ["Ben"]
        ana = hub.subscribe(KEY, _person("client-ana-01", "user-ana", "Ana"))
        assert _names((await _drain(ben.queue))[-1]) == ["Ana", "Ben"]

        hub.unsubscribe(ana)
        assert _names((await _drain(ben.queue))[-1]) == ["Ben"]
        hub.unsubscribe(ben)
        assert hub.participants(KEY) == []

    asyncio.run(scenario())


def test_a_participant_can_move_only_their_own_focus() -> None:
    async def scenario() -> None:
        hub = DraftLiveHub()
        hub.subscribe(KEY, _person("client-ana-01", "user-ana", "Ana"))
        cell = PresenceFocus(kind="cell", ref="sheet-1!B4")

        assert hub.set_focus(KEY, client_id="client-ana-01", user_id="user-ben", focus=cell) is False
        assert hub.set_focus(KEY, client_id="client-ana-01", user_id="user-ana", focus=cell) is True
        assert hub.participants(KEY)[0].to_json()["focus"] == {"kind": "cell", "ref": "sheet-1!B4"}
        # Saying the same place again is fine, and announces nothing new.
        assert hub.set_focus(KEY, client_id="client-ana-01", user_id="user-ana", focus=cell) is True
        assert hub.set_focus(KEY, client_id="client-gone-01", user_id="user-ana", focus=None) is False

    asyncio.run(scenario())


def test_a_reconnect_with_the_same_client_id_keeps_the_participant_until_both_leave() -> None:
    async def scenario() -> None:
        hub = DraftLiveHub()
        first = hub.subscribe(KEY, _person("client-ana-01", "user-ana", "Ana"))
        second = hub.subscribe(KEY, _person("client-ana-01", "user-ana", "Ana"))

        hub.unsubscribe(first)
        assert [p.client_id for p in hub.participants(KEY)] == ["client-ana-01"]
        hub.unsubscribe(second)
        assert hub.participants(KEY) == []

    asyncio.run(scenario())


def test_a_stream_that_falls_behind_is_told_to_resync_instead_of_growing_forever() -> None:
    async def scenario() -> None:
        hub = DraftLiveHub()
        slow = hub.subscribe(KEY, _person("client-ana-01", "user-ana", "Ana"))
        for seq in range(QUEUE_LIMIT + 5):
            hub.publish(KEY, {"event": "live", "data": {"seq": seq}})
        await asyncio.sleep(0)

        assert slow.queue.qsize() == QUEUE_LIMIT
        assert slow.overflowed is True

    asyncio.run(scenario())


def test_presence_colors_are_stable_and_in_range() -> None:
    assert presence_color("user-ana") == presence_color("user-ana")
    assert {presence_color(f"user-{n}") for n in range(200)} == set(range(PRESENCE_COLORS))
