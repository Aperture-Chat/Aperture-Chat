"""Rule-based DLP and misuse scanning for chat prompts.

Every rule here is a transparent, deterministic pattern — no model calls, no
scoring theater. Findings carry a redacted snippet so reviewers get context
without the alert itself re-exposing the sensitive value. False positives are
acceptable: alerts are a review queue for admins, never an automatic block.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_SNIPPET_RADIUS = 32
_MASK = "•••••"


@dataclass(frozen=True)
class DlpRule:
    id: str
    label: str
    category: str  # "dlp" (sensitive data) or "behavior" (misuse patterns)
    severity: str  # "high" | "medium"
    pattern: re.Pattern[str]
    mask_match: bool  # redact the matched value in the snippet


@dataclass(frozen=True)
class DlpFinding:
    rule_id: str
    label: str
    category: str
    severity: str
    snippet: str


def _luhn_valid(digits: str) -> bool:
    total = 0
    for index, char in enumerate(reversed(digits)):
        value = int(char)
        if index % 2 == 1:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return total % 10 == 0


DLP_RULES: tuple[DlpRule, ...] = (
    DlpRule(
        id="ssn",
        label="US Social Security number",
        category="dlp",
        severity="high",
        pattern=re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),
        mask_match=True,
    ),
    DlpRule(
        id="credit-card",
        label="Payment card number",
        category="dlp",
        severity="high",
        pattern=re.compile(r"\b(?:\d[ -]?){13,19}\b"),
        mask_match=True,
    ),
    DlpRule(
        id="private-key",
        label="Private key material",
        category="dlp",
        severity="high",
        pattern=re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
        mask_match=False,
    ),
    DlpRule(
        id="api-credential",
        label="API key or access token",
        category="dlp",
        severity="high",
        pattern=re.compile(
            r"\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36,}"
            r"|github_pat_[A-Za-z0-9_]{22,}|xox[abposr]-[A-Za-z0-9-]{10,}"
            r"|AIza[0-9A-Za-z_-]{35})\b"
        ),
        mask_match=True,
    ),
    DlpRule(
        id="password-disclosure",
        label="Password shared in prompt",
        category="dlp",
        severity="medium",
        pattern=re.compile(
            r"\b(?:password|passwd|pwd)\b\s*(?:is|[:=])\s*\S{6,}", re.IGNORECASE
        ),
        mask_match=True,
    ),
    DlpRule(
        id="prompt-injection",
        label="Prompt-injection attempt",
        category="behavior",
        severity="medium",
        pattern=re.compile(
            r"(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|your\s+)?(?:previous|prior|earlier|above)\s+"
            r"(?:instructions?|prompts?|rules?|directives?)",
            re.IGNORECASE,
        ),
        mask_match=False,
    ),
    DlpRule(
        id="system-prompt-probe",
        label="System-prompt extraction attempt",
        category="behavior",
        severity="medium",
        pattern=re.compile(
            r"(?:reveal|print|show|repeat|output|dump)\b[^.\n]{0,40}\b(?:system prompt|hidden instructions?|initial instructions?)",
            re.IGNORECASE,
        ),
        mask_match=False,
    ),
    DlpRule(
        id="credential-probe",
        label="Attempt to extract platform credentials",
        category="behavior",
        severity="high",
        pattern=re.compile(
            r"(?:reveal|print|show|tell me|what is|dump|leak)\b[^.\n]{0,50}"
            r"\b(?:api[ _-]?keys?|provider keys?|signing secrets?|\.env\b|environment variables?)",
            re.IGNORECASE,
        ),
        mask_match=False,
    ),
)


def _redacted_snippet(text: str, start: int, end: int, mask: bool) -> str:
    before = text[max(0, start - _SNIPPET_RADIUS) : start]
    matched = _MASK if mask else text[start:end]
    after = text[end : end + _SNIPPET_RADIUS]
    snippet = f"{before}{matched}{after}".replace("\n", " ").strip()
    prefix = "…" if start - _SNIPPET_RADIUS > 0 else ""
    suffix = "…" if end + _SNIPPET_RADIUS < len(text) else ""
    return f"{prefix}{snippet}{suffix}"


def scan_prompt(text: str) -> list[DlpFinding]:
    """Scan one prompt; at most one finding per rule to keep alerts readable."""
    findings: list[DlpFinding] = []
    if not text:
        return findings
    for rule in DLP_RULES:
        for match in rule.pattern.finditer(text):
            if rule.id == "credit-card":
                digits = re.sub(r"\D", "", match.group(0))
                if not 13 <= len(digits) <= 19 or not _luhn_valid(digits):
                    continue
            findings.append(
                DlpFinding(
                    rule_id=rule.id,
                    label=rule.label,
                    category=rule.category,
                    severity=rule.severity,
                    snippet=_redacted_snippet(text, match.start(), match.end(), rule.mask_match),
                )
            )
            break
    return findings
