"""Optional AI assistance for support tickets.

Two narrow jobs, both run on the model the platform owner picks in the
Reports settings (there is no implicit default model):

* ``draft_public_issue``: rewrite a ticket as a public GitHub issue with every
  person, organization, and deployment detail removed. Text is redacted
  deterministically *before* the model sees it and again after it answers, so
  the model is an extra privacy pass, never the only one.
* ``triage_hub_report``: on the community hub, summarize an incoming report,
  suggest labels and a title, estimate spam likelihood, flag security-sensitive
  content, and pick a likely duplicate from GitHub search results.

Both return plain dicts and raise :class:`SupportAiError` with a message that
is safe to show an owner. Nothing here is required for the ticket system to
work.
"""

from __future__ import annotations

import json
import re
from typing import Any

from app.core.model_gateway import (
    ModelGatewayError,
    get_model_gateway_client,
    resolve_model_route,
)
from app.models.schemas import ModelConfig, SupportModelOption

DRAFT_MAX_TOKENS = 900
TRIAGE_MAX_TOKENS = 700

_DRAFT_SYSTEM_PROMPT = """\
You turn an internal support ticket into a PUBLIC GitHub issue for the \
open-source Aperture Chat project. Anyone on the internet will be able to read it.

Remove everything that could identify a person, organization, customer, client \
matter, deployment, or host: names, company and product names other than \
Aperture Chat, email addresses, URLs, IP addresses, file names that look \
private, and any quoted chat or document content. Placeholders such as \
⟦EMAIL⟧ or ⟦NAME⟧ are already-removed values; keep them out of the issue.

Keep the technical facts maintainers need: what the person was doing, what \
happened, what they expected, exact error messages, and the area of the app. \
Never invent steps, versions, or errors that are not in the ticket.

Reply with one JSON object and nothing else:
{"title": "...", "summary": "...", "steps": ["..."], "expected": "...", "actual": "..."}
Use "" or [] for anything the ticket does not say. The title is at most 90 \
characters and describes the problem, not the person."""

_TRIAGE_SYSTEM_PROMPT = """\
You triage community reports for the open-source Aperture Chat project before \
a maintainer reviews them. Reports arrive from many independent deployments and \
were redacted before sending.

Reply with one JSON object and nothing else:
{"summary": "one or two sentences",
 "suggested_title": "at most 90 characters",
 "kind": "bug" | "feature" | "question" | "feedback",
 "labels": ["bug" | "enhancement" | "question" | "documentation"],
 "severity": "low" | "normal" | "high" | "critical",
 "spam_likelihood": 0.0 to 1.0,
 "contains_sensitive_data": true | false,
 "security_sensitive": true | false,
 "duplicate_of": <issue number from the candidate list, or null>,
 "notes": "short reasoning for the maintainer"}

security_sensitive means the report describes a vulnerability or exploit that \
belongs in a private security advisory, not a public issue. \
contains_sensitive_data means personal, customer, or credential data survived \
redaction. Only choose duplicate_of from the candidates you are given."""


class SupportAiError(Exception):
    """AI assistance failed; the message is safe to show a platform owner."""


def model_options(store) -> list[SupportModelOption]:
    """Platform-wide models an owner may assign to support assistance."""

    options = [
        SupportModelOption(id=model.id, name=model.name or model.id)
        for model in store.models.values()
        if model.tenant_id is None and model.platform_enabled and not model.is_custom
    ]
    return sorted(options, key=lambda option: option.name.casefold())


def assistant_model(store, model_id: str | None) -> ModelConfig | None:
    if not model_id:
        return None
    model = store.models.get(model_id)
    if model is None or model.tenant_id is not None or not model.platform_enabled:
        return None
    return model


def draft_public_issue(
    store,
    model: ModelConfig,
    *,
    kind_label: str,
    subject: str,
    body: str,
    area: str | None,
    errors: list[str],
) -> dict[str, Any]:
    lines = [f"Type: {kind_label}", f"Subject: {subject}", "Description:", body]
    if area:
        lines.append(f"Area of the app: {area}")
    if errors:
        lines.append("Recent errors shown to the person:")
        lines.extend(f"- {error}" for error in errors)
    payload = _complete_json(
        store,
        model,
        system=_DRAFT_SYSTEM_PROMPT,
        user="\n".join(lines),
        max_tokens=DRAFT_MAX_TOKENS,
    )
    title = _text(payload.get("title"), 200)
    if len(title) < 4:
        raise SupportAiError("The assistant did not return a usable title.")
    steps = payload.get("steps")
    return {
        "title": title,
        "summary": _text(payload.get("summary"), 4000),
        "steps": [_text(step, 500) for step in steps if _text(step, 500)][:12]
        if isinstance(steps, list)
        else [],
        "expected": _text(payload.get("expected"), 2000),
        "actual": _text(payload.get("actual"), 2000),
    }


def triage_hub_report(
    store,
    model: ModelConfig,
    *,
    kind: str,
    title: str,
    body: str,
    diagnostics_summary: str,
    candidates: list[dict[str, Any]],
) -> dict[str, Any]:
    candidate_lines = [
        f"#{item['number']} [{item.get('state', 'open')}] {item.get('title', '')}"
        for item in candidates
        if isinstance(item.get("number"), int)
    ]
    user = "\n".join(
        [
            f"Reported type: {kind}",
            f"Title: {title}",
            "Report:",
            body[:8000],
            "",
            f"Environment: {diagnostics_summary or 'not provided'}",
            "",
            "Possible duplicates from GitHub search:",
            *(candidate_lines or ["(none found)"]),
        ]
    )
    payload = _complete_json(
        store, model, system=_TRIAGE_SYSTEM_PROMPT, user=user, max_tokens=TRIAGE_MAX_TOKENS
    )
    candidate_numbers = {
        item["number"] for item in candidates if isinstance(item.get("number"), int)
    }
    duplicate = payload.get("duplicate_of")
    labels = payload.get("labels")
    return {
        "summary": _text(payload.get("summary"), 1000),
        "suggested_title": _text(payload.get("suggested_title"), 200),
        "kind": payload.get("kind")
        if payload.get("kind") in {"bug", "feature", "question", "feedback"}
        else kind,
        "labels": sorted(
            {
                label
                for label in (labels if isinstance(labels, list) else [])
                if label in {"bug", "enhancement", "question", "documentation"}
            }
        ),
        "severity": payload.get("severity")
        if payload.get("severity") in {"low", "normal", "high", "critical"}
        else "normal",
        "spam_likelihood": _probability(payload.get("spam_likelihood")),
        "contains_sensitive_data": payload.get("contains_sensitive_data") is True,
        "security_sensitive": payload.get("security_sensitive") is True,
        # Never trust a number the model made up.
        "duplicate_of": duplicate
        if isinstance(duplicate, int) and duplicate in candidate_numbers
        else None,
        "notes": _text(payload.get("notes"), 1000),
        "model_id": model.id,
    }


def _complete_json(
    store, model: ModelConfig, *, system: str, user: str, max_tokens: int
) -> dict[str, Any]:
    try:
        route = resolve_model_route(store, model, tenant_id=None)
        if not route.configured:
            raise SupportAiError(
                f"The support assistant model '{model.name or model.id}' is not connected: "
                f"{route.status_message}"
            )
        response = get_model_gateway_client().complete(
            route=route,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            max_tokens=max_tokens,
        )
    except ModelGatewayError as exc:
        raise SupportAiError(f"The support assistant model could not answer: {exc}") from exc
    content = _message_content(response)
    parsed = _parse_json_object(content)
    if parsed is None:
        raise SupportAiError("The support assistant did not return valid JSON.")
    return parsed


def _message_content(response: dict[str, Any]) -> str:
    try:
        content = response["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return ""
    if isinstance(content, list):
        return "".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )
    return content if isinstance(content, str) else ""


_FENCE_PATTERN = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)


def _parse_json_object(content: str) -> dict[str, Any] | None:
    text = _FENCE_PATTERN.sub("", (content or "").strip())
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        value = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def _text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    # Short fields (titles) collapse to one line; longer ones keep paragraphs.
    return " ".join(value.split())[:limit] if limit <= 200 else value.strip()[:limit]


def _probability(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return 0.0
    return round(min(1.0, max(0.0, float(value))), 2)
