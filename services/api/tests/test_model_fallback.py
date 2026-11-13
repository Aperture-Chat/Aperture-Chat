from __future__ import annotations

from app.core.model_fallback import fallback_order, vendor_of
from app.models.schemas import ModelConfig


def _model(model_id: str, upstream: str | None, provider: str = "provider-openrouter") -> ModelConfig:
    return ModelConfig(
        id=model_id,
        provider_id=provider,
        provider_name="OpenRouter",
        name=model_id,
        upstream_model_id=upstream,
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
    assert fallback_order(ASTRA, [SOL, OPUS, HAIKU]) == [OPUS, HAIKU, SOL]


def test_the_model_itself_and_its_upstream_twins_are_left_out() -> None:
    twin = _model("astra-copy", "OpenAI/GPT-6-Astra")
    assert fallback_order(ASTRA, [ASTRA, twin, OPUS]) == [OPUS]


def test_the_same_vendor_is_still_a_choice_when_nothing_else_is() -> None:
    assert fallback_order(ASTRA, [SOL]) == [SOL]


def test_no_candidates_means_no_fallback() -> None:
    assert fallback_order(ASTRA, []) == []
