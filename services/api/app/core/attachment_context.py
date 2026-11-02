"""How much of an attached file goes to the model on a turn, and which part.

A person who attaches a document means the document, so a file sent with the
message goes whole when it fits. One that does not fit keeps its opening and
then the passages the question names, and the prompt says it is partial. A file
from an earlier turn costs tokens on every later message, so it only gives what
the question names, the way a knowledge base does.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from app.core.vector_store import rank_passages
from app.models.schemas import KnowledgeChunk

CHARS_PER_TOKEN = 4
# Attachments may fill a third of the window: the conversation, the system
# prompt, and the reply need the rest.
WINDOW_SHARE = 3
MAX_TURN_CHARS = 200_000
# For a model that does not report a window.
UNKNOWN_WINDOW_CHARS = 24_000
EARLIER_TURN_PASSAGES = 6
OPENING_SHARE = 0.2
# Below this a passage only shares the baseline score: no word of the question
# is in it.
_MATCHED_SCORE = 0.1


@dataclass(frozen=True, slots=True)
class PassageSelection:
    passages: list[KnowledgeChunk]
    complete: bool


def attachment_turn_budget(context_window: int | None) -> int:
    if not context_window:
        return UNKNOWN_WINDOW_CHARS
    return min(context_window * CHARS_PER_TOKEN // WINDOW_SHARE, MAX_TURN_CHARS)


def share_budget(sizes: Sequence[int], budget: int) -> list[int]:
    """Each file's share, smallest first, so what a small file leaves goes on to
    the files that can use it."""
    shares = [0] * len(sizes)
    remaining = budget
    waiting = len(sizes)
    for index in sorted(range(len(sizes)), key=lambda item: sizes[item]):
        shares[index] = min(sizes[index], remaining // waiting)
        remaining -= shares[index]
        waiting -= 1
    return shares


def _fits(chunk: KnowledgeChunk, used: int, budget: int) -> bool:
    return used + len(chunk.text) <= budget


def _opening(chunks: Sequence[KnowledgeChunk], budget: int) -> list[KnowledgeChunk]:
    """At least the first passage, so a very long one is still seen."""
    chosen = [chunks[0]]
    used = len(chunks[0].text)
    for chunk in chunks[1:]:
        if not _fits(chunk, used, budget):
            break
        chosen.append(chunk)
        used += len(chunk.text)
    return chosen


def select_passages(
    chunks: Sequence[KnowledgeChunk], question: str, budget_chars: int
) -> PassageSelection:
    if not chunks:
        return PassageSelection([], True)
    if sum(len(chunk.text) for chunk in chunks) <= budget_chars:
        return PassageSelection(list(chunks), True)
    chosen = _opening(chunks, int(budget_chars * OPENING_SHARE))
    used = sum(len(chunk.text) for chunk in chosen)
    taken = {chunk.id for chunk in chosen}
    remaining = [chunk for chunk in chunks if chunk.id not in taken]
    # Ties rank in reading order, so a question that names nothing reads on.
    for chunk in rank_passages(remaining, question):
        if _fits(chunk, used, budget_chars):
            chosen.append(chunk)
            used += len(chunk.text)
    return PassageSelection(sorted(chosen, key=lambda chunk: chunk.ordinal), False)


def earlier_turn_passages(
    chunks: Sequence[KnowledgeChunk], question: str
) -> list[KnowledgeChunk]:
    ranked = rank_passages(chunks, question)
    return [chunk for chunk in ranked if chunk.score > _MATCHED_SCORE][:EARLIER_TURN_PASSAGES]
