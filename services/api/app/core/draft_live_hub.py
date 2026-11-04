"""In-process fan-out of shared-draft events, and who is in each draft now.

Routes publish from worker threads (sync endpoints run in a thread pool);
each subscriber is an asyncio queue drained by one event stream. Delivery
across processes is not attempted here: every stream also polls the
database for the live copy's ``seq`` (see the events route), so a second API
process only delays an update by one poll, it never loses one.

Presence is deliberately ephemeral. A participant exists exactly while its
event stream is open.
"""

from __future__ import annotations

import asyncio
import hashlib
from dataclasses import dataclass, field, replace
from threading import Lock
from typing import Any, Literal

PRESENCE_COLORS = 8
QUEUE_LIMIT = 64

FocusKind = Literal["block", "slide", "cell"]
DraftKey = tuple[str, str]  # (tenant_id, draft_id)


@dataclass(frozen=True, slots=True)
class PresenceFocus:
    """Where a participant is working: a document block index, a slide id,
    or a sheet cell (``ref`` = "<sheet id>!<cell>")."""

    kind: FocusKind
    ref: str

    def to_json(self) -> dict[str, str]:
        return {"kind": self.kind, "ref": self.ref}


@dataclass(frozen=True, slots=True)
class Participant:
    client_id: str
    user_id: str
    display_name: str
    color: int
    focus: PresenceFocus | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "client_id": self.client_id,
            "user_id": self.user_id,
            "display_name": self.display_name,
            "color": self.color,
            "focus": None if self.focus is None else self.focus.to_json(),
        }


def presence_color(user_id: str) -> int:
    """Stable per person, so everyone sees the same color for them."""

    return hashlib.sha256(user_id.encode("utf-8")).digest()[0] % PRESENCE_COLORS


@dataclass(eq=False)
class Subscription:
    key: DraftKey
    client_id: str
    queue: asyncio.Queue[dict[str, Any]]
    loop: asyncio.AbstractEventLoop
    # Set when the queue overflowed; the stream tells its client to resync.
    overflowed: bool = field(default=False)

    def offer(self, event: dict[str, Any]) -> None:
        try:
            self.queue.put_nowait(event)
        except asyncio.QueueFull:
            self.overflowed = True


class DraftLiveHub:
    def __init__(self) -> None:
        self._lock = Lock()
        self._subscriptions: dict[DraftKey, list[Subscription]] = {}
        self._participants: dict[DraftKey, dict[str, Participant]] = {}

    def subscribe(self, key: DraftKey, participant: Participant) -> Subscription:
        """Join a draft from inside the event stream's running loop."""

        subscription = Subscription(
            key=key,
            client_id=participant.client_id,
            queue=asyncio.Queue(maxsize=QUEUE_LIMIT),
            loop=asyncio.get_running_loop(),
        )
        with self._lock:
            self._subscriptions.setdefault(key, []).append(subscription)
            self._participants.setdefault(key, {})[participant.client_id] = participant
        self.publish_presence(key)
        return subscription

    def unsubscribe(self, subscription: Subscription) -> None:
        key = subscription.key
        with self._lock:
            remaining = [item for item in self._subscriptions.get(key, []) if item is not subscription]
            if remaining:
                self._subscriptions[key] = remaining
            else:
                self._subscriptions.pop(key, None)
            people = self._participants.get(key, {})
            if not any(item.client_id == subscription.client_id for item in remaining):
                people.pop(subscription.client_id, None)
            if not people:
                self._participants.pop(key, None)
        self.publish_presence(key)

    def participants(self, key: DraftKey) -> list[Participant]:
        with self._lock:
            people = list(self._participants.get(key, {}).values())
        return sorted(people, key=lambda person: (person.display_name.casefold(), person.client_id))

    def set_focus(
        self, key: DraftKey, *, client_id: str, user_id: str, focus: PresenceFocus | None
    ) -> bool:
        """Move one participant's focus. Only the participant's own user may
        move it; returns False for an unknown or foreign client id."""

        with self._lock:
            people = self._participants.get(key, {})
            current = people.get(client_id)
            if current is None or current.user_id != user_id:
                return False
            if current.focus == focus:
                return True
            people[client_id] = replace(current, focus=focus)
        self.publish_presence(key)
        return True

    def publish(self, key: DraftKey, event: dict[str, Any]) -> None:
        """Deliver ``event`` to every stream on ``key``. Safe from any thread."""

        with self._lock:
            targets = list(self._subscriptions.get(key, []))
        for subscription in targets:
            try:
                subscription.loop.call_soon_threadsafe(subscription.offer, event)
            except RuntimeError:
                # The stream's loop already closed; its finally block removes it.
                continue

    def publish_presence(self, key: DraftKey) -> None:
        self.publish(
            key,
            {"event": "presence", "data": {"participants": [p.to_json() for p in self.participants(key)]}},
        )


_HUB = DraftLiveHub()


def get_draft_live_hub() -> DraftLiveHub:
    return _HUB
