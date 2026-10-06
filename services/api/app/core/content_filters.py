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

from app.core.personal_data import VALIDATORS, original_span, shadow_text, validated_subspan
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


def _rule(
    rule_id: str,
    label: str,
    pattern: str,
    *,
    action: str = "redact",
    applies_to: str = "both",
    validator: str | None = None,
) -> ContentFilterRule:
    return ContentFilterRule(
        id=rule_id, label=label, pattern=pattern, action=action, applies_to=applies_to, validator=validator
    )


_BUILTIN_FILTERS: tuple[ContentFilter, ...] = (
    ContentFilter(
        id="cf-preset-pii-hipaa",
        tenant_id=None,
        name="PII / HIPAA",
        description=(
            "Redacts personally identifiable and protected health information: "
            "SSNs and ITINs, contact details and street addresses, dates of birth, "
            "passport and driver's license numbers, medical record numbers, health "
            "plan and Medicare IDs, vehicle IDs, and IP addresses. Matching ignores "
            "zero-width characters and look-alike digits, and checksums reject "
            "numbers that only resemble an identifier."
        ),
        builtin=True,
        rules=[
            _rule("ssn", "US Social Security number", r"(?<![\w-])\d{3}([- ])\d{2}\1\d{4}(?![\w-])", validator="ssn"),
            _rule(
                "ssn-labelled",
                "US Social Security number",
                r"(?i)\b(?:ssn|social\s+security(?:\s+(?:number|no\.?|#))?|ss\s*#)\s*(?:is|:|#|=)?\s*(?P<value>\d{9})(?!\d)",
                validator="ssn",
            ),
            _rule(
                "itin",
                "Individual taxpayer ID (ITIN)",
                r"(?<![\w-])9\d{2}([- ])(?:5\d|6[0-5]|7\d|8[0-8]|9[0-2]|9[4-9])\1\d{4}(?![\w-])",
            ),
            _rule(
                "us-phone",
                "US phone number",
                r"\b(?:\+1[ .-]?)?(?:\(\d{3}\)\s?|\d{3}[ .-])\d{3}[ .-]\d{4}\b",
            ),
            _rule(
                "intl-phone",
                "International phone number",
                r"(?<![\w+])\+[2-9]\d{0,2}[ .-]?(?:\(\d{1,4}\)[ .-]?)?\d{1,4}(?:[ .-]?\d{2,4}){2,4}(?![\w-])",
            ),
            _rule("email-address", "Email address", r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
            _rule(
                "street-address",
                "Street address",
                r"\b\d{1,6}[A-Z]?\s+(?:(?:N|S|E|W|North|South|East|West)\.?\s+)?(?:[A-Z][A-Za-z0-9'.-]*\s+){0,3}"
                r"[A-Z][A-Za-z0-9'.-]*\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way"
                r"|Place|Pl|Terrace|Ter|Circle|Cir|Parkway|Pkwy|Highway|Hwy|Square|Sq|Trail|Trl)\b\.?"
                r"(?:,?\s+(?:Apt|Apartment|Suite|Ste|Unit|#)\.?\s*#?[A-Za-z0-9-]{1,8})?",
            ),
            _rule(
                "date-of-birth",
                "Date of birth",
                r"(?i)\b(?:dob|date of birth|birth ?date|born(?: on)?)\b[^\n]{0,16}?"
                r"(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}"
                r"|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})",
            ),
            _rule(
                "passport-number",
                "Passport number",
                r"(?i)\bpassport\s*(?:number|no\.?|#)?\s*[:#]?\s*(?P<value>[A-Z0-9]{6,9})\b",
                validator="has_digit",
            ),
            _rule(
                "drivers-license",
                "Driver's license number",
                r"(?i)\bdriv(?:er'?s?|ing)\s+licen[cs]e\s*(?:number|no\.?|#)?\s*[:#]?\s*(?P<value>[A-Z0-9][A-Z0-9-]{4,16})\b",
                validator="has_digit",
            ),
            _rule(
                "medical-record-number",
                "Medical record number",
                r"(?i)\b(?:mrn|medical record (?:number|no\.?)|patient (?:id|number))\b[:# ]*(?P<value>[A-Z0-9-]{5,14})\b",
                validator="has_digit",
            ),
            _rule(
                "health-plan-member-id",
                "Health plan member or subscriber ID",
                r"(?i)\b(?:member|subscriber|policy|beneficiary)\s*(?:id|number|no\.?)\b[:# ]*(?P<value>[A-Z0-9-]{6,16})\b",
                validator="has_digit",
            ),
            _rule(
                "medicare-mbi",
                "Medicare beneficiary identifier",
                r"\b[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d-?[AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d-?[AC-HJKMNP-RT-Y]{2}\d{2}\b",
            ),
            _rule("vehicle-id", "Vehicle identification number", r"\b[A-HJ-NPR-Z0-9]{17}\b", validator="vin"),
            _rule(
                "ip-address",
                "IP address",
                r"(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\d|\.\d)",
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
            "Redacts regulated financial identifiers: payment card numbers (Luhn "
            "checked), bank account and ABA routing numbers (checksum verified), "
            "IBANs (mod-97 verified), SWIFT/BIC codes, and employer tax IDs."
        ),
        builtin=True,
        rules=[
            _rule("payment-card", "Payment card number", r"(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])", validator="luhn"),
            _rule(
                "aba-routing",
                "ABA routing number",
                r"(?i)\b(?:aba|routing)\s*(?:number|no\.?|#)?\s*[:#]?\s*(?P<value>\d{9})\b",
                validator="aba",
            ),
            _rule(
                "bank-account",
                "Bank account number",
                r"(?i)\b(?:account|acct)\s*(?:number|no\.?|#)\s*[:#]?\s*\d{6,17}\b",
            ),
            _rule("iban", "IBAN", r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b", validator="iban"),
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
        if rule.validator is not None and rule.validator not in VALIDATORS:
            raise ValueError(
                f"Rule '{rule.id}' validator must be one of: {', '.join(sorted(VALIDATORS))}."
            )


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


def _rule_spans(compiled: re.Pattern[str], rule: ContentFilterRule, text: str) -> list[tuple[int, int]]:
    """Validated match spans in ``text`` coordinates.

    Matching runs on the personal-data engine's shadow copy, so zero-width
    characters, full-width digits, and Unicode dashes cannot slip a value
    past a rule; spans map back to the original text, invisible characters
    included. A rule's validator (when set) must accept the named ``value``
    group, or the whole match when the pattern has no such group.
    """
    shadow, index = shadow_text(text)
    validator = VALIDATORS.get(rule.validator) if rule.validator else None
    spans: list[tuple[int, int]] = []
    for match in compiled.finditer(shadow):
        if match.start() == match.end():
            continue
        start, end = match.start(), match.end()
        if validator is not None:
            if "value" in compiled.groupindex and match.group("value"):
                if not validator(match.group("value")):
                    continue
            elif not validator(match.group(0)):
                # A greedy number pattern can swallow an expiry date or CVV
                # after a card; keep the longest run of whole digit groups
                # that still passes instead of dropping the match.
                span = validated_subspan(shadow, start, end, validator)
                if span is None:
                    continue
                start, end = span
        spans.append(original_span(index, start, end))
    return spans


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
            spans = _rule_spans(compiled, rule, evaluation.text)
            if not spans:
                continue
            match = ContentRuleMatch(
                filter_id=content_filter.id,
                filter_name=content_filter.name,
                rule_id=rule.id,
                label=rule.label,
                action=rule.action,
                match_count=len(spans),
            )
            if rule.action == "block":
                evaluation.blocked.append(match)
            else:
                marker = _REDACTION_TEMPLATE.format(label=rule.label)
                parts: list[str] = []
                cursor = 0
                for start, end in spans:
                    parts.append(evaluation.text[cursor:start])
                    parts.append(marker)
                    cursor = end
                parts.append(evaluation.text[cursor:])
                evaluation.text = "".join(parts)
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
