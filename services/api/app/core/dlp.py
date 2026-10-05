"""Rule-based DLP and misuse scanning for chat prompts.

Every rule here is a transparent, deterministic pattern — no model calls, no
scoring theater. Findings carry a redacted snippet so reviewers get context
without the alert itself re-exposing the sensitive value. False positives are
acceptable: alerts are a review queue for admins, never an automatic block.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.core.personal_data import card_valid, conceal_text, shadow_text, ssn_valid

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
    # Conceal each side in full before cutting the window, so a value that
    # straddles the window edge is never left half-visible.
    before = conceal_text(text[:start])[-_SNIPPET_RADIUS:]
    matched = _MASK if mask else text[start:end]
    after = conceal_text(text[end:])[:_SNIPPET_RADIUS]
    snippet = f"{before}{matched}{after}".replace("\n", " ").strip()
    prefix = "…" if start - _SNIPPET_RADIUS > 0 else ""
    suffix = "…" if end + _SNIPPET_RADIUS < len(text) else ""
    return f"{prefix}{snippet}{suffix}"


# Range and checksum checks shared with the personal-data engine, so an
# alert fires on the same values concealment and content filters act on.
_RULE_VALIDATORS = {"ssn": ssn_valid, "credit-card": card_valid}


def scan_prompt(text: str) -> list[DlpFinding]:
    """Scan one prompt; at most one finding per rule to keep alerts readable.

    Rules run on the engine's shadow copy, so zero-width characters,
    full-width digits, and Unicode dashes cannot hide a value from review.
    Snippets come from that normalized copy, with the matched value masked
    and any other personal data in the surrounding context concealed.
    """
    findings: list[DlpFinding] = []
    if not text:
        return findings
    shadow, _index = shadow_text(text)
    for rule in DLP_RULES:
        validator = _RULE_VALIDATORS.get(rule.id)
        for match in rule.pattern.finditer(shadow):
            if validator is not None and not validator(match.group(0)):
                continue
            findings.append(
                DlpFinding(
                    rule_id=rule.id,
                    label=rule.label,
                    category=rule.category,
                    severity=rule.severity,
                    snippet=_redacted_snippet(shadow, match.start(), match.end(), rule.mask_match),
                )
            )
            break
    return findings
