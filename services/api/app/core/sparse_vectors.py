from __future__ import annotations

import re
from collections import defaultdict


SEARCH_STOPWORDS = frozenset(
    {
        "and",
        "are",
        "for",
        "from",
        "has",
        "have",
        "that",
        "the",
        "this",
        "with",
    }
)


def sparse_text_vector(value: str) -> dict[str, float]:
    """Return the stable sparse-vector representation used by knowledge search."""

    vector: dict[str, float] = defaultdict(float)
    for raw_token in re.findall(r"[a-zA-Z0-9]+", value.lower()):
        token = normalize_search_token(raw_token)
        if token is not None:
            vector[token] += 1.0
    return dict(vector)


def normalize_search_token(token: str) -> str | None:
    if len(token) <= 2 or token in SEARCH_STOPWORDS:
        return None
    if len(token) > 4 and token.endswith("s"):
        return token[:-1]
    return token
