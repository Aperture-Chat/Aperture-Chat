"""Server-side chat read positions.

Each thread stores the id of the newest message its owner has seen. A thread
is unread while its last message is an assistant reply with a different id.
Keeping this on the server lets every browser agree on what is unread instead
of each device guessing from its own storage.
"""

from __future__ import annotations

from collections.abc import Sequence


def later_read_marker(
    message_ids: Sequence[str],
    current: str | None,
    incoming: str | None,
) -> str | None:
    """Return whichever read marker points further into the thread.

    Read position only moves forward, so a stale save from another browser
    cannot bring back an unread dot. A marker whose message no longer exists
    yields to one that does.
    """

    if not incoming or incoming == current:
        return current
    if incoming not in message_ids:
        return current
    if not current or current not in message_ids:
        return incoming
    ids = list(message_ids)
    return incoming if ids.index(incoming) >= ids.index(current) else current
