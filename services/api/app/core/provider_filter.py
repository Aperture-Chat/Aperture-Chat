"""When a provider's safety filter answers in the model's place.

Some upstreams (Azure, for the OpenAI models it hosts) run their own content
filter. When it trips, the provider drops the model's reply and sends stock
text instead, usually with ``finish_reason: content_filter``. That text reads
like the model declining, but the model never said it, and the same request
often passes on the next try. A turn withheld this way is asked again, and
the stand-in is never shown as the answer.
"""

from __future__ import annotations

from typing import Literal

# What the provider sends in place of the reply it withheld.
STAND_IN_REPLY = "I'm sorry, but I cannot assist with that request."
# How many more times a withheld turn is asked before the reply gives up.
MAX_FILTER_RETRIES = 2

_APOSTROPHES = str.maketrans({"’": "'", "‘": "'"})


def _plain(text: str) -> str:
    return " ".join(text.translate(_APOSTROPHES).casefold().split())


_STAND_IN = _plain(STAND_IN_REPLY)


def filter_reported(finish_reason: object) -> bool:
    """Whether the provider said its filter ended the turn."""
    return str(finish_reason or "").strip().lower() == "content_filter"


def is_stand_in(text: str) -> bool:
    """Whether a turn's whole text is the provider's stand-in reply."""
    return _plain(text) == _STAND_IN


def withheld(finish_reason: object, text: str) -> bool:
    """Whether the provider's filter stood in for the model on this turn."""
    return filter_reported(finish_reason) or is_stand_in(text)


def after_unshown_turn(finish_reason: object, text: str, retries: int) -> Literal["deliver", "ask_again", "fail"]:
    """What becomes of a turn none of which has been shown yet.

    A withheld turn is asked again while tries remain. After that, a turn the
    provider reported as filtered fails with the reason; the stand-in words
    without that report may be the model's own, so they are delivered.
    """
    if not withheld(finish_reason, text):
        return "deliver"
    if retries < MAX_FILTER_RETRIES:
        return "ask_again"
    return "fail" if filter_reported(finish_reason) else "deliver"


class StandInGate:
    """Holds back a turn's opening words while they could still be the
    stand-in, so a withheld turn never reaches the page before it is known
    to be one. Anything else is let through at the first word that differs.
    """

    def __init__(self) -> None:
        self._held = ""
        self._open = False

    @property
    def opened(self) -> bool:
        """Whether any of this turn's text has been let through."""
        return self._open

    def feed(self, delta: str) -> str:
        """The text now safe to show, given the next piece of the turn."""
        if self._open:
            return delta
        self._held += delta
        if _STAND_IN.startswith(_plain(self._held)):
            return ""
        return self.release()

    def release(self) -> str:
        """Let through what is held; the turn was the model's own."""
        held, self._held, self._open = self._held, "", True
        return held
