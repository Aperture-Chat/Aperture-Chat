"""AI page reading for knowledge uploads through the shared model gateway."""

from __future__ import annotations

from typing import Any

import pytest
from PIL import Image

from app.core import vision_ocr
from app.core.model_gateway import ModelGatewayError, ModelGatewayRoute
from app.core.usage_budget import UsageBudgetError
from app.core.vision_ocr import VisionPageReader, rank_vision_models
from app.models.schemas import ModelCapabilities, ModelConfig


def _model(model_id: str, upstream: str, **updates: Any) -> ModelConfig:
    values: dict[str, Any] = {
        "id": model_id,
        "provider_id": "provider-test",
        "provider_name": "Test provider",
        "name": model_id,
        "upstream_model_id": upstream,
    }
    values.update(updates)
    return ModelConfig(**values)


def _route(provider_kind: str = "openrouter", upstream: str = "google/gemini-3-flash") -> ModelGatewayRoute:
    return ModelGatewayRoute(
        provider_id="provider-test",
        provider_name="Test provider",
        provider_kind=provider_kind,
        auth_type="api-key",
        upstream_model=upstream,
        base_url="https://models.example.test/v1",
        configured=True,
        status_message="ready",
    )


class FakeGateway:
    def __init__(self, replies: list[Any]) -> None:
        self.replies = list(replies)
        self.calls: list[dict[str, Any]] = []

    def complete(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return {"choices": [{"message": {"content": reply}}], "usage": {"total_tokens": 10}}


class FakeUsage:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.settled: list[Any] = []

    def settle_provider_child(self, **kwargs: Any) -> None:
        if self.fail:
            raise UsageBudgetError("budget spent")
        self.settled.append(kwargs)


def _reader(gateway: FakeGateway, usage: FakeUsage | None = None, **kwargs: Any) -> VisionPageReader:
    usage = usage or FakeUsage()
    return VisionPageReader(
        model=_model("model-flash", "google/gemini-3-flash"),
        route=_route(),
        usage=lambda: usage,
        client=gateway,
        **kwargs,
    )


def _page() -> Image.Image:
    return Image.new("RGB", (2400, 3200), "white")


def test_reader_sends_the_page_image_and_returns_the_transcription() -> None:
    gateway = FakeGateway(["Handwritten: call Jordan Friday."])
    usage = FakeUsage()
    reader = _reader(gateway, usage)
    assert reader.read_page(_page(), mode="full", label="Page 1") == "Handwritten: call Jordan Friday."
    call = gateway.calls[0]
    content = call["messages"][1]["content"]
    assert content[0]["type"] == "text" and "Page 1" in content[0]["text"]
    image_url = content[1]["image_url"]["url"]
    assert image_url.startswith("data:image/jpeg;base64,")
    assert "handwriting" in call["messages"][0]["content"].lower()
    assert usage.settled[0]["attribution"].surface == "knowledge-ocr"
    assert reader.pages_read == 1


def test_reader_scales_large_pages_down_before_sending(monkeypatch: pytest.MonkeyPatch) -> None:
    sizes: list[tuple[int, int]] = []
    original = vision_ocr._jpeg_data_url

    def spy(image: Any) -> str:
        url = original(image)
        sizes.append(vision_ocr._fit(image).size)
        return url

    monkeypatch.setattr(vision_ocr, "_jpeg_data_url", spy)
    _reader(FakeGateway(["ok"])).read_page(_page(), mode="full", label="Page 1")
    assert max(sizes[0]) == vision_ocr.MAX_IMAGE_EDGE_PX


@pytest.mark.parametrize("answer", ["NONE", "none.", "  NONE  "])
def test_none_answer_means_nothing_on_the_page(answer: str) -> None:
    assert _reader(FakeGateway([answer])).read_page(_page(), mode="extras", label="Page 2") == ""


def test_extras_and_image_modes_use_their_own_instructions() -> None:
    gateway = FakeGateway(["a", "b", "c"])
    reader = _reader(gateway)
    for mode in ("full", "extras", "image"):
        reader.read_page(_page(), mode=mode, label="x")
    prompts = [call["messages"][0]["content"] for call in gateway.calls]
    assert len(set(prompts)) == 3
    assert "already" in prompts[1]


def test_page_budget_stops_further_calls() -> None:
    gateway = FakeGateway(["one", "two", "three"])
    reader = _reader(gateway, max_pages=2)
    results = [reader.read_page(_page(), mode="full", label=f"Page {n}") for n in (1, 2, 3)]
    assert results == ["one", "two", None]
    assert len(gateway.calls) == 2
    assert reader.skipped_for_budget == 1


def test_repeated_provider_failures_turn_the_reader_off() -> None:
    error = ModelGatewayError("upstream 500", status_code=500)
    gateway = FakeGateway([error, error, error, "never"])
    reader = _reader(gateway)
    assert [reader.read_page(_page(), mode="full", label="p") for _ in range(4)] == [None] * 4
    assert len(gateway.calls) == 3
    assert reader.failures == 3
    assert "could not read" in (reader.problem or "")


def test_usage_budget_exhaustion_turns_the_reader_off() -> None:
    gateway = FakeGateway(["first", "second"])
    reader = _reader(gateway, FakeUsage(fail=True))
    assert reader.read_page(_page(), mode="full", label="p") is None
    assert reader.read_page(_page(), mode="full", label="p") is None
    assert len(gateway.calls) == 1
    assert "usage" in (reader.problem or "").lower()


def test_reasoning_models_get_no_temperature_and_room_to_think() -> None:
    gateway = FakeGateway(["ok"])
    reader = VisionPageReader(
        model=_model("model-gpt5", "gpt-5.2"),
        route=_route("azure-foundry", "gpt-5.2"),
        usage=FakeUsage,
        client=gateway,
    )
    reader.read_page(_page(), mode="full", label="p")
    call = gateway.calls[0]
    assert "temperature" not in (call["options"] or {})
    assert call["max_tokens"] >= 8000


def test_plain_models_read_at_temperature_zero() -> None:
    gateway = FakeGateway(["ok"])
    reader = VisionPageReader(
        model=_model("model-4o", "gpt-4o"),
        route=_route("azure-foundry", "gpt-4o"),
        usage=FakeUsage,
        client=gateway,
    )
    reader.read_page(_page(), mode="full", label="p")
    assert gateway.calls[0]["options"]["temperature"] == 0


# ------------------------------------------------------------------ ranking


def test_ranking_prefers_gemini_flash_then_other_vision_models() -> None:
    models = [
        _model("claude", "anthropic/claude-sonnet-5"),
        _model("gpt41", "gpt-4.1"),
        _model("flash-old", "google/gemini-2.5-flash"),
        _model("flash-new", "google/gemini-3-flash"),
        _model("flash-lite", "google/gemini-3-flash-lite"),
        _model("text-only", "meta/llama-3.3-70b"),
        _model("imagegen", "google/gemini-3-flash-image"),
        _model(
            "declared-text",
            "acme/omni-1",
            capabilities=ModelCapabilities(input_modalities=["text"]),
        ),
    ]
    ranked = [model.id for model in rank_vision_models(models, tenant_id="tenant-example")]
    assert ranked[:3] == ["flash-new", "flash-lite", "flash-old"]
    assert set(ranked[3:]) == {"gpt41", "claude"}
    assert "text-only" not in ranked and "imagegen" not in ranked and "declared-text" not in ranked


def test_ranking_honors_a_pinned_model_and_skips_disabled_ones() -> None:
    models = [
        _model("flash", "google/gemini-3-flash"),
        _model("pinned", "gpt-4.1"),
        _model("off", "google/gemini-9-flash", platform_enabled=False),
        _model("restricted", "google/gemini-9-flash", tenant_restricted=True),
        _model("other-tenant", "google/gemini-9-flash", tenant_id="tenant-other"),
        _model("agent", "google/gemini-9-flash", is_custom=True),
    ]
    ranked = [
        model.id
        for model in rank_vision_models(models, tenant_id="tenant-example", preferred="gpt-4.1")
    ]
    assert ranked == ["pinned", "flash"]


def test_refused_usage_request_skips_ai_reading_without_calling_the_model() -> None:
    gateway = FakeGateway(["never"])

    def refuse() -> Any:
        raise UsageBudgetError("Daily token budget reached.")

    reader = VisionPageReader(
        model=_model("model-flash", "google/gemini-3-flash"),
        route=_route(),
        usage=refuse,
        client=gateway,
    )
    assert reader.read_page(_page(), mode="full", label="p") is None
    assert reader.read_page(_page(), mode="full", label="p") is None
    assert gateway.calls == []
    assert "Daily token budget reached." in (reader.problem or "")


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"choices": [{"message": {"content": [{"type": "text", "text": "Part one. "}, {"text": "Part two."}]}}]}, "Part one. Part two."),
        ({"choices": []}, ""),
        ({"choices": [{"message": {"content": None}}]}, ""),
        ("not a payload", ""),
    ],
)
def test_answer_text_reads_string_and_part_list_content(payload: Any, expected: str) -> None:
    assert vision_ocr._answer_text(payload) == expected


def test_reader_limits_are_floored() -> None:
    gateway = FakeGateway(["never"])
    reader = _reader(gateway, max_pages=0, concurrency=0)
    assert reader.concurrency == 1
    assert reader.read_page(_page(), mode="full", label="p") is None
    assert gateway.calls == []
    assert _reader(FakeGateway([]), max_pages=-3).max_pages == 0


def test_a_success_resets_the_failure_streak() -> None:
    error = ModelGatewayError("upstream 500", status_code=500)
    gateway = FakeGateway([error, error, "ok", error, error, "ok again"])
    reader = _reader(gateway)
    results = [reader.read_page(_page(), mode="full", label="p") for _ in range(6)]
    assert results == [None, None, "ok", None, None, "ok again"]
    assert reader.problem is None
    assert reader.failures == 4


def test_minimal_reasoning_is_only_requested_for_gemini_flash_on_openrouter() -> None:
    def options_for(provider_kind: str, upstream: str) -> dict[str, Any]:
        gateway = FakeGateway(["ok"])
        VisionPageReader(
            model=_model("m", upstream),
            route=_route(provider_kind, upstream),
            usage=FakeUsage,
            client=gateway,
        ).read_page(_page(), mode="full", label="p")
        return gateway.calls[0]["options"]

    assert options_for("openrouter", "google/gemini-3-flash")["reasoning"] == {"effort": "minimal"}
    assert "reasoning" not in options_for("openrouter", "openai/gpt-4o")
    assert "reasoning" not in options_for("azure-foundry", "google/gemini-3-flash")


def test_other_vision_models_keep_catalog_order() -> None:
    models = [_model("lite", "acme/vision-lite"), _model("gpt41", "gpt-4.1")]
    assert [model.id for model in rank_vision_models(models, tenant_id="tenant-example")] == [
        "lite",
        "gpt41",
    ]


def test_gemini_pro_ranks_between_flash_and_other_models() -> None:
    models = [
        _model("gpt41", "gpt-4.1"),
        _model("pro", "google/gemini-3-pro"),
        _model("flash", "google/gemini-3-flash"),
    ]
    ranked = [model.id for model in rank_vision_models(models, tenant_id="tenant-example")]
    assert ranked == ["flash", "pro", "gpt41"]


def test_vendor_prefix_does_not_decide_image_output() -> None:
    models = [_model("vendor", "image-labs/gpt-4.1")]
    assert [model.id for model in rank_vision_models(models, tenant_id="tenant-example")] == ["vendor"]


def test_unexpected_errors_count_as_failures_and_are_reported() -> None:
    gateway = FakeGateway([KeyError("choices"), KeyError("choices"), KeyError("choices")])
    reader = _reader(gateway)
    assert [reader.read_page(_page(), mode="full", label="p") for _ in range(3)] == [None] * 3
    assert reader.failures == 3
    assert "could not read pages" in (reader.problem or "")
