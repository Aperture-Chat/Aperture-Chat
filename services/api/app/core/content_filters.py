"""Per-model content filters: deterministic regex rules that block or redact.

Unlike the advisory DLP monitor (``app/core/dlp.py``), these filters are
enforcement. A matching "block" rule refuses the request or withholds the
model output; a matching "redact" rule rewrites the text before it crosses
the platform boundary. Filters are declarative rule sets — no admin-authored
code ever runs in the chat path, which keeps custom filters auditable and
safe to evaluate inline.

Two presets ship built in (PII/HIPAA and financial-regulatory). They live in
code, not runtime state, so they are always available, read-only, and
attached to no model until an admin turns them on.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Iterable

from app.models.schemas import ContentFilter, ContentFilterRule, ModelConfig

if TYPE_CHECKING:
    from app.repositories.seed import SeedStore

MAX_RULES_PER_FILTER = 40
MAX_PATTERN_LENGTH = 400
MAX_NAME_LENGTH = 120
MAX_DESCRIPTION_LENGTH = 500
MAX_PREVIEW_SAMPLE_CHARS = 20_000

RULE_ACTIONS = ("redact", "block")
RULE_SCOPES = ("input", "output", "both")

BUILTIN_FILTER_ID_PREFIX = "cf-preset-"

_REDACTION_TEMPLATE = "[REDACTED · {label}]"


def _rule(rule_id: str, label: str, pattern: str, *, action: str = "redact", applies_to: str = "both") -> ContentFilterRule:
    return ContentFilterRule(id=rule_id, label=label, pattern=pattern, action=action, applies_to=applies_to)


_BUILTIN_FILTERS: tuple[ContentFilter, ...] = (
    ContentFilter(
        id="cf-preset-pii-hipaa",
        tenant_id=None,
        name="PII / HIPAA",
        description=(
            "Redacts common personally identifiable and protected health "
            "information: SSNs, contact details, dates of birth, medical "
            "record numbers, and health plan member IDs."
        ),
        builtin=True,
        rules=[
            _rule("ssn", "US Social Security number", r"\b\d{3}-\d{2}-\d{4}\b"),
            _rule(
                "us-phone",
                "US phone number",
                r"\b(?:\+1[ .-]?)?(?:\(\d{3}\)\s?|\d{3}[ .-])\d{3}[ .-]\d{4}\b",
            ),
            _rule("email-address", "Email address", r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
            _rule(
                "date-of-birth",
                "Date of birth",
                r"(?i)\b(?:dob|date of birth|birth ?date)\b[^\n]{0,16}?\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}",
            ),
            _rule(
                "medical-record-number",
                "Medical record number",
                r"(?i)\b(?:mrn|medical record (?:number|no\.?))\b[:# ]*[A-Z0-9-]{5,14}\b",
            ),
            _rule(
                "health-plan-member-id",
                "Health plan member or subscriber ID",
                r"(?i)\b(?:member|subscriber|policy)\s*(?:id|number|no\.?)\b[:# ]*[A-Z0-9-]{6,16}\b",
            ),
        ],
        created_by=None,
        updated_at="Built in",
    ),
    ContentFilter(
        id="cf-preset-financial",
        tenant_id=None,
        name="Financial Regulatory",
        description=(
            "Redacts regulated financial identifiers: payment card numbers, "
            "bank account and ABA routing numbers, IBANs, SWIFT/BIC codes, "
            "and employer tax IDs."
        ),
        builtin=True,
        rules=[
            _rule("payment-card", "Payment card number", r"\b(?:\d[ -]?){13,19}\b"),
            _rule(
                "aba-routing",
                "ABA routing number",
                r"(?i)\b(?:aba|routing)\s*(?:number|no\.?|#)?\s*[:#]?\s*\d{9}\b",
            ),
            _rule(
                "bank-account",
                "Bank account number",
                r"(?i)\b(?:account|acct)\s*(?:number|no\.?|#)\s*[:#]?\s*\d{6,17}\b",
            ),
            _rule("iban", "IBAN", r"\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b"),
            _rule(
                "swift-bic",
                "SWIFT/BIC code",
                r"(?i)\b(?:swift|bic)\b[:# ]*[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b",
            ),
            _rule(
                "ein-tax-id",
                "Employer tax ID (EIN)",
                r"(?i)\b(?:ein|tax id|taxpayer id)\b[^\n]{0,10}?\d{2}-\d{7}\b",
            ),
        ],
        created_by=None,
        updated_at="Built in",
    ),
)


def builtin_content_filters() -> list[ContentFilter]:
    """Deep copies so callers can never mutate the in-code presets."""
    return [preset.model_copy(deep=True) for preset in _BUILTIN_FILTERS]


def is_builtin_filter_id(filter_id: str) -> bool:
    return filter_id.startswith(BUILTIN_FILTER_ID_PREFIX)


def validate_content_filter_rules(rules: Iterable[ContentFilterRule]) -> None:
    """Reject rule sets that cannot be enforced honestly. Raises ValueError."""
    rules = list(rules)
    if not rules:
        raise ValueError("A content filter needs at least one rule.")
    if len(rules) > MAX_RULES_PER_FILTER:
        raise ValueError(f"A content filter is limited to {MAX_RULES_PER_FILTER} rules.")
    seen_ids: set[str] = set()
    for rule in rules:
        if not rule.id.strip():
            raise ValueError("Every rule needs an id.")
        if rule.id in seen_ids:
            raise ValueError(f"Duplicate rule id '{rule.id}'.")
        seen_ids.add(rule.id)
        if not rule.label.strip():
            raise ValueError(f"Rule '{rule.id}' needs a label; it appears in redaction markers and audit events.")
        if not rule.pattern.strip():
            raise ValueError(f"Rule '{rule.id}' needs a regular expression pattern.")
        if len(rule.pattern) > MAX_PATTERN_LENGTH:
            raise ValueError(f"Rule '{rule.id}' pattern exceeds {MAX_PATTERN_LENGTH} characters.")
        if rule.action not in RULE_ACTIONS:
            raise ValueError(f"Rule '{rule.id}' action must be one of: {', '.join(RULE_ACTIONS)}.")
        if rule.applies_to not in RULE_SCOPES:
            raise ValueError(f"Rule '{rule.id}' scope must be one of: {', '.join(RULE_SCOPES)}.")
        try:
            compiled = re.compile(rule.pattern)
        except re.error as exc:
            raise ValueError(f"Rule '{rule.id}' has an invalid pattern: {exc}") from exc
        if compiled.search(""):
            raise ValueError(f"Rule '{rule.id}' pattern matches empty text and would redact everything.")


@dataclass(frozen=True)
class ContentRuleMatch:
    filter_id: str
    filter_name: str
    rule_id: str
    label: str
    action: str
    match_count: int


@dataclass
class FilterEvaluation:
    text: str
    blocked: list[ContentRuleMatch] = field(default_factory=list)
    redactions: list[ContentRuleMatch] = field(default_factory=list)


def evaluate_content_filters(
    filters: Iterable[ContentFilter],
    text: str,
    scope: str,
) -> FilterEvaluation:
    """Run every rule that applies to ``scope`` ("input" or "output") over ``text``.

    Redactions are applied to the returned text; block matches are reported but
    the text is not otherwise altered for them — callers refuse the traffic.
    Rules that fail to compile (possible only for hand-edited runtime state)
    are skipped rather than silently passing content through a broken filter:
    the surviving rules still run.
    """
    evaluation = FilterEvaluation(text=text)
    if not text:
        return evaluation
    for content_filter in filters:
        for rule in content_filter.rules:
            if rule.applies_to != "both" and rule.applies_to != scope:
                continue
            try:
                compiled = re.compile(rule.pattern)
            except re.error:
                continue
            matches = compiled.findall(evaluation.text)
            if not matches:
                continue
            match = ContentRuleMatch(
                filter_id=content_filter.id,
                filter_name=content_filter.name,
                rule_id=rule.id,
                label=rule.label,
                action=rule.action,
                match_count=len(matches),
            )
            if rule.action == "block":
                evaluation.blocked.append(match)
            else:
                evaluation.text = compiled.sub(_REDACTION_TEMPLATE.format(label=rule.label), evaluation.text)
                evaluation.redactions.append(match)
    return evaluation


def resolve_model_content_filters(store: "SeedStore", model: ModelConfig) -> list[ContentFilter]:
    """The filters attached to a model, resolving builtin ids from code."""
    if not model.content_filter_ids:
        return []
    builtin_by_id = {preset.id: preset for preset in _BUILTIN_FILTERS}
    resolved: list[ContentFilter] = []
    for filter_id in model.content_filter_ids:
        builtin = builtin_by_id.get(filter_id)
        if builtin is not None:
            resolved.append(builtin)
            continue
        stored = store.content_filters.get(filter_id)
        if stored is not None:
            resolved.append(stored)
    return resolved


def filters_have_output_rules(filters: Iterable[ContentFilter]) -> bool:
    return any(
        rule.applies_to in ("output", "both")
        for content_filter in filters
        for rule in content_filter.rules
    )
