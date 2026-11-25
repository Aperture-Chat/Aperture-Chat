"""Which model answers when the one a person chose cannot.

A model can fail to answer for reasons that have nothing to do with the
request: its provider's safety filter keeps withholding the reply, the
upstream that hosts it turns it away, the connection drops, or it returns
nothing. Another model the person may use answers instead, and the one picked
is the nearest in ability that is least likely to fail the same way.

Ability is read from what the catalog reports, never from a list of model
names, so the choice holds as models come and go: the listed price (vendors
price their strongest models highest), the size word a small model carries in
its name, and what a model can read. Another vendor's model comes before the
same vendor's, since the same upstream may serve both, and the same upstream
model is no choice at all.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable

from app.core.model_gateway import (
    ModelGatewayAuthError,
    ModelGatewayConfigurationError,
    ModelGatewayError,
    ModelUpstreamUnavailable,
)
from app.models.schemas import ModelConfig

# Why another model answers, as the audit trail records it.
FALLBACK_FOR_FILTER = "provider_content_filter"
FALLBACK_FOR_UNAVAILABLE = "provider_unavailable"
FALLBACK_FOR_FAILURE = "model_failed"
FALLBACK_FOR_EMPTY = "empty_reply"

# A stand-in is comfortable down to a quarter of the first model's price.
COMFORT_FACTOR = 4.0
# How far apart two models are taken to be when either lists no price.
_UNLISTED_GAP = math.log(COMFORT_FACTOR)
# The words vendors put in the names of their small, fast models.
_SMALL_WORDS = frozenset({"mini", "nano", "lite", "tiny", "micro", "small", "flash", "haiku", "instant"})
_NAME_WORD = re.compile(r"[a-z0-9]+")


def reason_to_switch(failure: ModelGatewayError) -> str | None:
    """Why another model answers after this failure; None when none should.

    A rejected key or a broken route is left for an admin: it is not the
    model's failure, and it is said plainly instead of worked around.
    """
    if isinstance(failure, (ModelGatewayAuthError, ModelGatewayConfigurationError)):
        return None
    if isinstance(failure, ModelUpstreamUnavailable):
        return FALLBACK_FOR_UNAVAILABLE
    return FALLBACK_FOR_FAILURE


def vendor_of(model: ModelConfig) -> str:
    """Who makes the model: the upstream id's prefix (``openai`` in
    ``openai/gpt-6-astra``), else the provider it is configured under."""
    upstream = (model.upstream_model_id or "").strip().lower()
    return upstream.split("/", 1)[0] if "/" in upstream else model.provider_id


def _upstream(model: ModelConfig) -> str:
    return (model.upstream_model_id or model.id).strip().lower()


def _is_small(model: ModelConfig) -> bool:
    named = f"{model.name} {model.upstream_model_id or ''}".lower()
    return not _SMALL_WORDS.isdisjoint(_NAME_WORD.findall(named))


def _price(model: ModelConfig) -> float | None:
    return model.capabilities.output_price if model.capabilities else None


def _reads(model: ModelConfig) -> set[str]:
    return set(model.capabilities.input_modalities) if model.capabilities else set()


def _falls_short(current: ModelConfig, model: ModelConfig) -> bool:
    """Whether ``model`` is clearly less able than ``current``: a small model
    for a full-size one, one priced far below it, or one that cannot read a
    kind of input (pictures, files) the first can."""
    if _is_small(model) and not _is_small(current):
        return True
    price, wanted = _price(model), _price(current)
    if price is not None and wanted is not None and price * COMFORT_FACTOR < wanted:
        return True
    reads = _reads(model)
    return bool(reads) and not _reads(current) <= reads


def _gap(current: ModelConfig, model: ModelConfig) -> float:
    """How far apart in price the two are, as a ratio on a log scale."""
    price, wanted = _price(model), _price(current)
    if price is None or wanted is None:
        return _UNLISTED_GAP
    return abs(math.log(price / wanted))


def fallback_order(current: ModelConfig, candidates: Iterable[ModelConfig]) -> list[ModelConfig]:
    """The candidates that may answer instead of ``current``, best first.

    A model about as able as ``current`` comes before one that falls short of
    it; then another vendor's before the same vendor's; then the nearest in
    price. Equals keep the order they were given in. The same upstream model
    is left out.
    """
    others = [model for model in candidates if model.id != current.id and _upstream(model) != _upstream(current)]
    vendor = vendor_of(current)
    return sorted(
        others,
        key=lambda model: (_falls_short(current, model), vendor_of(model) == vendor, _gap(current, model)),
    )
