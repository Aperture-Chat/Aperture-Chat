from __future__ import annotations

import pytest

from app.core.model_fallback import (
    FALLBACK_FOR_FAILURE,
    FALLBACK_FOR_UNAVAILABLE,
    fallback_order,
    reason_to_switch,
    vendor_of,
)
from app.core.model_gateway import (
    ModelGatewayAuthError,
    ModelGatewayConfigurationError,
    ModelGatewayError,
    ModelUpstreamUnavailable,
)
from app.models.schemas import ModelCapabilities, ModelConfig


def _model(
    model_id: str,
    upstream: str | None,
    provider: str = "provider-openrouter",
    *,
    price: float | None = None,
    reads: list[str] | None = None,
) -> ModelConfig:
    reported = price is not None or reads is not None
    return ModelConfig(
        id=model_id,
        provider_id=provider,
        provider_name="OpenRouter",
        name=model_id,
        upstream_model_id=upstream,
        capabilities=ModelCapabilities(output_price=price, input_modalities=reads or []) if reported else None,
    )


ASTRA = _model("astra", "openai/gpt-6-astra")
SOL = _model("sol", "openai/gpt-6.1-sol")
OPUS = _model("opus", "anthropic/claude-opus-5.5")
HAIKU = _model("haiku", "anthropic/claude-haiku-5.5")


def test_vendor_is_the_upstream_prefix() -> None:
    assert vendor_of(ASTRA) == "openai"
    assert vendor_of(_model("x", "Anthropic/Claude")) == "anthropic"


def test_vendor_without_a_prefix_is_the_provider() -> None:
    assert vendor_of(_model("local", "llama3", provider="provider-ollama")) == "provider-ollama"
    assert vendor_of(_model("local", None, provider="provider-ollama")) == "provider-ollama"


def test_another_vendor_comes_first_in_the_given_order() -> None:
    sonnet = _model("sonnet", "anthropic/claude-sonnet-5.5")

    assert fallback_order(ASTRA, [SOL, OPUS, sonnet]) == [OPUS, sonnet, SOL]


def test_a_small_model_stands_in_only_after_every_full_size_one() -> None:
    # Its own vendor's full-size model is nearer in ability than another's small one.
    assert fallback_order(ASTRA, [HAIKU, SOL, OPUS]) == [OPUS, SOL, HAIKU]


@pytest.mark.parametrize(
    ("name", "upstream", "small"),
    [
        ("candidate", "openai/gpt-6-mini", True),
        ("candidate", "openai/gpt-6-nano", True),
        ("candidate", "google/gemini-4-flash", True),
        ("candidate", "google/gemini-4-flash-lite", True),
        ("candidate", "mistralai/mistral-small-4", True),
        ("candidate", "groq/llama-5-8b-instant", True),
        ("candidate", "vendor/Tiny-1", True),
        ("candidate", "vendor/micro_2", True),
        # A deployment says nothing in its id; the name it is shown by does.
        ("GPT-6 Mini (East)", "vendor/prod-east-2", True),
        # A size word inside another word is not one.
        ("candidate", "google/gemini-4-pro", False),
        ("candidate", "minimax/minimax-m3", False),
        ("candidate", "vendor/flashback-2", False),
        ("Geminiflash", "vendor/prod-east-2", False),
    ],
)
def test_a_small_model_is_known_by_a_size_word_standing_alone_in_its_name(name: str, upstream: str, small: bool) -> None:
    candidate = _model("candidate", upstream)
    candidate.name = name
    # SOL is the first model's own vendor: it follows another vendor's
    # full-size model, and comes before any small one.
    expected = [SOL, candidate] if small else [candidate, SOL]

    assert fallback_order(ASTRA, [candidate, SOL]) == expected
    assert fallback_order(ASTRA, [SOL, candidate]) == expected


def test_a_small_model_takes_any_model_as_its_equal_or_better() -> None:
    mini = _model("mini", "openai/gpt-6-mini")

    assert fallback_order(mini, [HAIKU, OPUS]) == [HAIKU, OPUS]


@pytest.mark.parametrize(
    ("first_price", "listed", "order"),
    [
        (12.0, {"deep": 40.0, "opus": 25.0, "sonnet": 15.0}, ["sonnet", "opus", "deep"]),
        (25.0, {"sol": 12.0, "deep": 40.0}, ["deep", "sol"]),
        # A model with no listed price sits between the near and the far.
        (12.0, {"far": 120.0, "unlisted": None, "near": 15.0}, ["near", "unlisted", "far"]),
        # Without the first model's price, the given order stands.
        (None, {"opus": 25.0, "sonnet": 15.0}, ["opus", "sonnet"]),
    ],
)
def test_the_nearest_in_price_comes_first_among_other_vendors_models(
    first_price: float | None, listed: dict[str, float | None], order: list[str]
) -> None:
    first = _model("first", "openai/first", price=first_price)
    candidates = [_model(name, f"vendor-{name}/{name}", price=price) for name, price in listed.items()]

    assert [model.id for model in fallback_order(first, candidates)] == order


def test_a_model_far_cheaper_than_the_first_stands_in_last() -> None:
    opus = _model("opus", "anthropic/claude-opus-5.5", price=25.0)
    budget = _model("budget", "openai/gpt-6-core", price=6.0)
    sibling = _model("sibling", "anthropic/claude-sonnet-5.5", price=15.0)

    # A quarter of the price is still comfortable; less is not.
    assert fallback_order(opus, [budget, sibling]) == [sibling, budget]
    budget.capabilities.output_price = 6.25
    assert fallback_order(opus, [budget, sibling]) == [budget, sibling]


def test_a_model_that_cannot_read_what_the_first_reads_stands_in_last() -> None:
    sol = _model("sol", "openai/gpt-6.2-sol", reads=["text", "image", "file"])
    blind = _model("blind", "deepseek/deepseek-v5", reads=["text"])
    sighted = _model("sighted", "openai/gpt-6-astra", reads=["text", "file", "image", "audio"])
    silent = _model("silent", "anthropic/claude-opus-5.5")

    assert fallback_order(sol, [blind, sighted, silent]) == [silent, sighted, blind]
    # One that reads exactly what the first reads is its equal.
    same = _model("same", "google/gemini-4-pro", reads=["file", "image", "text"])
    assert fallback_order(sol, [blind, same]) == [same, blind]


# --- Which failures another model answers ---------------------------------


@pytest.mark.parametrize(
    "failure",
    [
        ModelGatewayError("Test Router request failed: ConnectError"),
        ModelGatewayError("Test Router returned HTTP 500: boom", status_code=500),
        ModelGatewayError("Test Router returned HTTP 429: slow down", status_code=429),
        ModelGatewayError("Test Router returned HTTP 404: no such model", status_code=404),
    ],
)
def test_a_model_that_fails_is_answered_for_by_another(failure: ModelGatewayError) -> None:
    assert reason_to_switch(failure) == FALLBACK_FOR_FAILURE == "model_failed"


def test_an_upstream_that_would_not_serve_the_model_keeps_its_own_reason() -> None:
    refusal = ModelUpstreamUnavailable("Azure could not serve it", status_code=502, served_by="Azure")

    assert reason_to_switch(refusal) == FALLBACK_FOR_UNAVAILABLE


@pytest.mark.parametrize(
    "failure",
    [ModelGatewayAuthError("Test Router", 401), ModelGatewayConfigurationError("Provider base URL is missing.")],
)
def test_a_rejected_key_or_a_broken_route_is_left_for_an_admin(failure: ModelGatewayError) -> None:
    assert reason_to_switch(failure) is None


def test_the_model_itself_and_its_upstream_twins_are_left_out() -> None:
    twin = _model("astra-copy", "OpenAI/GPT-6-Astra")
    assert fallback_order(ASTRA, [ASTRA, twin, OPUS]) == [OPUS]


def test_the_same_vendor_is_still_a_choice_when_nothing_else_is() -> None:
    assert fallback_order(ASTRA, [SOL]) == [SOL]


def test_no_candidates_means_no_fallback() -> None:
    assert fallback_order(ASTRA, []) == []


# --- Models saved before a price was recorded ------------------------------


def _stored(model: ModelConfig) -> dict:
    return model.model_dump(mode="json")


def test_a_model_saved_before_prices_were_recorded_still_loads() -> None:
    from app.repositories.identity_config_sql import _model_from_payload

    legacy = _stored(_model("sol", "openai/gpt-6.2-sol", reads=["text", "image"]))
    legacy["capabilities"].pop("output_price")

    loaded = _model_from_payload(ModelConfig, legacy, "models")

    assert loaded.capabilities is not None
    assert loaded.capabilities.output_price is None
    assert loaded.capabilities.input_modalities == ["text", "image"]


@pytest.mark.parametrize("model", [ASTRA, _model("opus", "anthropic/claude-opus-5.5", price=25.0)], ids=["bare", "priced"])
def test_a_model_saved_as_it_is_now_loads_unchanged(model: ModelConfig) -> None:
    from app.repositories.identity_config_sql import _model_from_payload

    assert _model_from_payload(ModelConfig, _stored(model), "models") == model


def test_a_stored_model_with_a_field_nobody_knows_is_still_refused() -> None:
    from app.repositories.identity_config_sql import IdentityConfigCorruptionError, _model_from_payload

    tampered = _stored(_model("sol", "openai/gpt-6.2-sol", reads=["text"]))
    tampered["capabilities"].pop("output_price")
    tampered["capabilities"]["surprise"] = True

    with pytest.raises(IdentityConfigCorruptionError):
        _model_from_payload(ModelConfig, tampered, "models")
