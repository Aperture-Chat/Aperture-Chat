"""When to ask someone to star Aperture Chat on GitHub.

Each person is asked at most twice: a few days after their first visit, and
once more two weeks after that. Someone who went to star the project is not
asked again. A showing counts once it is handed out, answered or not, so the
request never repeats on reload.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from app.models.schemas import StarPrompt, StarPromptAnswer, StarPromptAsk

FIRST_ASK_AFTER = timedelta(days=3)
SECOND_ASK_AFTER = timedelta(days=14)


def _next_ask(prompt: StarPrompt, now: datetime) -> int | None:
    asks = prompt.asks
    if not asks:
        return 1 if now >= prompt.started_at + FIRST_ASK_AFTER else None
    if len(asks) == 1 and asks[0].answer != "star":
        return 2 if now >= asks[0].asked_at + SECOND_ASK_AFTER else None
    return None


def check_star_prompt(prompt: StarPrompt | None, now: datetime) -> tuple[StarPrompt, int | None]:
    """Start the clock on a first visit; hand out and record an ask that is due."""
    if prompt is None:
        return StarPrompt(started_at=now), None
    ask = _next_ask(prompt, now)
    if ask is None:
        return prompt, None
    return prompt.model_copy(update={"asks": [*prompt.asks, StarPromptAsk(asked_at=now)]}), ask


def answer_star_prompt(prompt: StarPrompt | None, answer: StarPromptAnswer) -> StarPrompt | None:
    """Record the answer to the latest ask, if it is still open."""
    if prompt is None or not prompt.asks or prompt.asks[-1].answer is not None:
        return prompt
    answered = prompt.asks[-1].model_copy(update={"answer": answer})
    return prompt.model_copy(update={"asks": [*prompt.asks[:-1], answered]})
