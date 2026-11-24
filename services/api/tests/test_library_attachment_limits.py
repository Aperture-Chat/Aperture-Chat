"""Attached prompts and skills reach the model whole up to 65,000 characters."""

from __future__ import annotations

from app.models.schemas import ModelConfig
from app.routes.chat import _runtime_prompt


def _model() -> ModelConfig:
    return ModelConfig(
        id="agent-limits",
        tenant_id="tenant-example",
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="Limits Agent",
        upstream_model_id="openai/gpt-4o-mini",
    )


def test_long_skill_file_reaches_the_prompt_whole() -> None:
    skill = "Rule " + "a" * 59_990 + " END-OF-SKILL"
    prompt = _runtime_prompt(_model(), {"skill_files": [{"name": "Long skill", "content": skill}]})
    assert f"- Long skill: {skill}" in prompt


def test_long_prompt_template_reaches_the_prompt_whole() -> None:
    template = "Draft " + "b" * 59_990 + " END-OF-PROMPT"
    prompt = _runtime_prompt(
        _model(), {"prompt_templates": [{"name": "Long prompt", "content": template}]}
    )
    assert f"- Long prompt: {template}" in prompt


def test_skill_beyond_65000_characters_is_cut_with_an_ellipsis() -> None:
    prompt = _runtime_prompt(_model(), {"skill_files": [{"name": "Huge", "content": "c" * 70_000}]})
    assert "- Huge: " + "c" * 64_997 + "..." in prompt
    assert "c" * 64_998 not in prompt
