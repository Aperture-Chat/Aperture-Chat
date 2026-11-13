"""Which model answers when a provider's safety filter keeps withholding one.

The filter belongs to whoever serves the model (Azure, for the OpenAI models
it hosts), not to the request: another vendor's model, served elsewhere,
answers the same request. A model from the same vendor is a weaker choice,
since the same upstream may serve it, and the same upstream model is no
choice at all.
"""

from __future__ import annotations

from collections.abc import Iterable

from app.models.schemas import ModelConfig


def vendor_of(model: ModelConfig) -> str:
    """Who makes the model: the upstream id's prefix (``openai`` in
    ``openai/gpt-6-astra``), else the provider it is configured under."""
    upstream = (model.upstream_model_id or "").strip().lower()
    return upstream.split("/", 1)[0] if "/" in upstream else model.provider_id


def _upstream(model: ModelConfig) -> str:
    return (model.upstream_model_id or model.id).strip().lower()


def fallback_order(current: ModelConfig, candidates: Iterable[ModelConfig]) -> list[ModelConfig]:
    """The candidates that may answer instead of ``current``, best first.

    Another vendor's models come before the same vendor's; each group keeps
    the order the candidates were given in. The same upstream model is left out.
    """
    others = [model for model in candidates if model.id != current.id and _upstream(model) != _upstream(current)]
    vendor = vendor_of(current)
    return sorted(others, key=lambda model: vendor_of(model) == vendor)
