"""Deterministic personal-data detection shared by every privacy control.

One engine backs personal-data concealment, the built-in PII/HIPAA content
filter checksums, DLP prompt alerts, sensitive retention tagging, memory
rejection, and training-dataset de-identification, so an identifier that one
control recognizes is recognized by all of them.

Detection is shape plus validation: a regular expression finds candidates
and a checksum or range check (Luhn, SSN area rules, ABA, IBAN mod-97, VIN)
rejects look-alikes. No model is called and no value leaves the process.

Matching runs on a "shadow" copy of the text with zero-width characters
removed and full-width digits, Unicode dashes, and odd spaces folded to
ASCII, so "123‐45‐6789" or an SSN with zero-width joiners between digits is
still caught. Spans are mapped back to the original text, so concealment
replaces exactly what the person typed, invisible characters included.

Honest limits: names, free-text descriptions of health conditions, and
identifiers with no recognizable shape or label are not detected here.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from functools import lru_cache

TOKEN_OPEN = "⟦"
TOKEN_CLOSE = "⟧"
# Matches a concealment token so later passes (tagging, memory, the UI) can
# recognize a value that was already removed.
TOKEN_PATTERN = re.compile(r"⟦([A-Z][A-Z ]{1,30})⟧")

CATEGORY_LABELS: dict[str, str] = {
    "identity": "Government and personal IDs",
    "contact": "Contact details",
    "financial": "Financial accounts",
    "health": "Health identifiers (HIPAA)",
    "credentials": "Secrets and credentials",
    "network": "Network identifiers",
}
ALL_CATEGORIES: tuple[str, ...] = tuple(CATEGORY_LABELS)


def token(label: str) -> str:
    return f"{TOKEN_OPEN}{label}{TOKEN_CLOSE}"


# --- validators ---------------------------------------------------------------


def _digits(value: str) -> str:
    return re.sub(r"\D", "", value)


def luhn_valid(value: str) -> bool:
    digits = _digits(value)
    if not digits:
        return False
    total = 0
    for index, char in enumerate(reversed(digits)):
        number = int(char)
        if index % 2 == 1:
            number *= 2
            if number > 9:
                number -= 9
        total += number
    return total % 10 == 0


def card_valid(value: str) -> bool:
    """Luhn plus a plausible issuer prefix, so order and matter numbers that
    happen to pass Luhn (one in ten random numbers do) are not concealed."""
    digits = _digits(value)
    if not 13 <= len(digits) <= 19 or len(set(digits)) == 1:
        return False
    prefix_ok = digits[0] in "3456" or 2221 <= int(digits[:4]) <= 2720
    return prefix_ok and luhn_valid(digits)


def ssn_valid(value: str) -> bool:
    """SSA rules: area never 000, 666, or 900-999; group never 00; serial never 0000."""
    digits = _digits(value)
    if len(digits) != 9:
        return False
    area, group, serial = digits[:3], digits[3:5], digits[5:]
    return area not in {"000", "666"} and area[0] != "9" and group != "00" and serial != "0000"


def aba_valid(value: str) -> bool:
    digits = _digits(value)[-9:]
    if len(digits) != 9 or set(digits) == {"0"}:
        return False
    d = [int(char) for char in digits]
    checksum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])
    return checksum % 10 == 0


def iban_valid(value: str) -> bool:
    compact = re.sub(r"\s", "", value).upper()
    if not 15 <= len(compact) <= 34 or not re.fullmatch(r"[A-Z]{2}\d{2}[A-Z0-9]+", compact):
        return False
    rearranged = compact[4:] + compact[:4]
    numeric = "".join(str(int(char, 36)) for char in rearranged)
    return int(numeric) % 97 == 1


_VIN_VALUES = {
    **{str(n): n for n in range(10)},
    **dict(zip("ABCDEFGH", range(1, 9))),
    **dict(zip("JKLMN", range(1, 6))),
    "P": 7,
    "R": 9,
    **dict(zip("STUVWXYZ", range(2, 10))),
}
_VIN_WEIGHTS = (8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2)


def vin_valid(value: str) -> bool:
    """North American check digit, and a VIN must mix letters and digits."""
    vin = value.upper()
    if len(vin) != 17 or not re.search(r"\d", vin) or not re.search(r"[A-Z]", vin):
        return False
    try:
        total = sum(_VIN_VALUES[char] * weight for char, weight in zip(vin, _VIN_WEIGHTS))
    except KeyError:
        return False
    check = total % 11
    return vin[8] == ("X" if check == 10 else str(check))


def has_digit(value: str) -> bool:
    return any(char.isdigit() for char in value)


def _digit_count_between(low: int, high: int) -> Callable[[str], bool]:
    return lambda value: low <= len(_digits(value)) <= high


def _password_like(value: str) -> bool:
    """A disclosed secret, not the next English word ("password is required")."""
    return bool(re.search(r"[\d\W_]", value)) or (value.lower() != value and value.upper() != value)


def _ipv4_valid(value: str) -> bool:
    octets = value.split(".")
    return not (octets[0] in {"0", "127"} or value.startswith("255.255."))


VALIDATORS: dict[str, Callable[[str], bool]] = {
    "luhn": card_valid,
    "ssn": ssn_valid,
    "aba": aba_valid,
    "iban": iban_valid,
    "vin": vin_valid,
    "has_digit": has_digit,
}
VALIDATOR_LABELS: dict[str, str] = {
    "luhn": "Payment card checksum (Luhn + issuer prefix)",
    "ssn": "Social Security number ranges",
    "aba": "ABA routing checksum",
    "iban": "IBAN mod-97 checksum",
    "vin": "Vehicle identification check digit",
    "has_digit": "Value contains a digit",
}


_DIGIT_GROUP = re.compile(r"\d+")


def validated_subspan(
    text: str, start: int, end: int, validator: Callable[[str], bool]
) -> tuple[int, int] | None:
    """Longest run of whole digit groups in ``text[start:end]`` that passes.

    A greedy number pattern also swallows an expiry date or CVV written after
    a card ("4111 1111 1111 1111 12/27"), which then fails its checksum; the
    card inside must still be found. Groups are never split, so an unrelated
    long number cannot be carved into a passing window.
    """
    segment = text[start:end]
    groups = [(match.start(), match.end()) for match in _DIGIT_GROUP.finditer(segment)]
    best: tuple[int, int] | None = None
    for first in range(len(groups)):
        for last in range(len(groups) - 1, first - 1, -1):
            left, right = groups[first][0], groups[last][1]
            if best is not None and right - left <= best[1] - best[0]:
                break
            if validator(segment[left:right]):
                best = (left, right)
                break
    return (start + best[0], start + best[1]) if best is not None else None


# --- detectors ----------------------------------------------------------------


@dataclass(frozen=True)
class Detector:
    id: str
    label: str
    token: str
    category: str
    example: str
    # (pattern, group) pairs; the group's span is concealed, so a labelled
    # value such as "DOB: 01/02/1980" keeps its readable label.
    patterns: tuple[tuple[re.Pattern[str], int | str], ...]
    validator: Callable[[str], bool] | None = None
    # When the whole match fails validation, try the longest run of whole
    # digit groups inside it ("4111 1111 1111 1111 12/27" still holds a card).
    trim_groups: bool = False


def _p(source: str, flags: int = 0) -> re.Pattern[str]:
    return re.compile(source, flags)


_MONTH = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?"
_DATE = (
    r"(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}"
    rf"|(?i:{_MONTH})\s+\d{{1,2}}(?:st|nd|rd|th)?,?\s+\d{{4}}"
    rf"|\d{{1,2}}(?:st|nd|rd|th)?\s+(?i:{_MONTH}),?\s+\d{{4}})"
)
_LABEL_TAIL = r"\s*(?:number|no\.?|num|#)?\s*(?:is|was|:|#|=|-)?\s*"
_STREET_SUFFIX = (
    r"(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl"
    r"|Terrace|Ter|Circle|Cir|Parkway|Pkwy|Highway|Hwy|Square|Sq|Trail|Trl|Alley|Loop)"
)

DETECTORS: tuple[Detector, ...] = (
    Detector(
        id="ssn",
        label="US Social Security number",
        token="SSN",
        category="identity",
        example="123-45-6789",
        patterns=(
            (_p(r"(?<![\w-])\d{3}([- ])\d{2}\1\d{4}(?![\w-])"), 0),
            (_p(r"(?i:\b(?:ssn|social\s+security(?:\s+(?:number|no\.?|#))?|ss\s*#))\s*(?:is|:|#|=)?\s*(\d{9})(?!\d)"), 1),
        ),
        validator=ssn_valid,
    ),
    Detector(
        id="itin",
        label="Individual taxpayer ID (ITIN)",
        token="ITIN",
        category="identity",
        example="912-70-1234",
        patterns=(
            (_p(r"(?<![\w-])9\d{2}([- ])(?:5\d|6[0-5]|7\d|8[0-8]|9[0-2]|9[4-9])\1\d{4}(?![\w-])"), 0),
        ),
    ),
    Detector(
        id="passport",
        label="Passport number",
        token="PASSPORT",
        category="identity",
        example="Passport no. X1234567",
        patterns=((_p(rf"(?i:\bpassport){_LABEL_TAIL}([A-Z0-9]{{6,9}})\b", re.IGNORECASE), 1),),
        validator=has_digit,
    ),
    Detector(
        id="drivers_license",
        label="Driver's license number",
        token="DRIVER LICENSE",
        category="identity",
        example="Driver's license D1234-5678",
        patterns=(
            (
                _p(
                    rf"(?:(?i:\bdriv(?:er'?s?|ing)\s+licen[cs]e)|\bDL\b){_LABEL_TAIL}"
                    r"([A-Za-z0-9][A-Za-z0-9-]{4,16})\b"
                ),
                1,
            ),
        ),
        validator=lambda value: len(_digits(value)) >= 4,
    ),
    Detector(
        id="date_of_birth",
        label="Date of birth",
        token="DATE OF BIRTH",
        category="identity",
        example="DOB: 04/12/1986",
        patterns=(
            (
                _p(rf"(?i:\b(?:dob|d\.o\.b\.?|date\s+of\s+birth|birth\s*date|born(?:\s+on)?))\b\s*(?:is|was|:|-)?\s*{_DATE}"),
                1,
            ),
        ),
    ),
    Detector(
        id="vin",
        label="Vehicle identification number",
        token="VIN",
        category="identity",
        example="1HGCM82633A004352",
        patterns=((_p(r"\b[A-HJ-NPR-Z0-9]{17}\b"), 0),),
        validator=vin_valid,
    ),
    Detector(
        id="email",
        label="Email address",
        token="EMAIL",
        category="contact",
        example="jordan@example.com",
        patterns=((_p(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}\b"), 0),),
    ),
    Detector(
        id="phone",
        label="Phone number",
        token="PHONE",
        category="contact",
        example="(415) 555-0134",
        patterns=(
            (
                _p(
                    r"(?<![\w+])(?:\+?1[ .-]?)?(?:\([2-9]\d{2}\)\s?|[2-9]\d{2}[ .-])\d{3}[ .-]\d{4}"
                    r"(?:\s*(?:x|ext\.?|extension)\s*\d{1,6})?(?![\w-])"
                ),
                0,
            ),
            (
                _p(r"(?<![\w+])\+[2-9]\d{0,2}[ .-]?(?:\(\d{1,4}\)[ .-]?)?\d{1,4}(?:[ .-]?\d{2,4}){2,4}(?![\w-])"),
                0,
            ),
            (
                _p(rf"(?i:\b(?:phone|tel|telephone|mobile|cell|fax)){_LABEL_TAIL}(\+?\d[\d .()-]{{8,18}}\d)"),
                1,
            ),
        ),
        validator=_digit_count_between(10, 15),
    ),
    Detector(
        id="street_address",
        label="Street address",
        token="ADDRESS",
        category="contact",
        example="1200 Harbor View Drive, Apt 4B",
        patterns=(
            (
                _p(
                    r"\b\d{1,6}[A-Z]?\s+(?:(?:N|S|E|W|North|South|East|West)\.?\s+)?"
                    r"(?:[A-Z][A-Za-z0-9'.-]*\s+){0,3}[A-Z][A-Za-z0-9'.-]*\s+" + _STREET_SUFFIX + r"\b\.?"
                    r"(?:,?\s+(?:Apt|Apartment|Suite|Ste|Unit|Fl|Floor|#)\.?\s*#?[A-Za-z0-9-]{1,8})?"
                    r"(?:,\s*[A-Z][A-Za-z .'-]{1,30},?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?)?"
                ),
                0,
            ),
            (_p(r"(?i:\bP\.?\s?O\.?\s+Box\s+\d{1,8})\b"), 0),
        ),
    ),
    Detector(
        id="payment_card",
        label="Payment card number",
        token="CARD NUMBER",
        category="financial",
        example="4111 1111 1111 1111",
        patterns=((_p(r"(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])"), 0),),
        validator=card_valid,
        trim_groups=True,
    ),
    Detector(
        id="card_security_code",
        label="Card security code",
        token="CARD CODE",
        category="financial",
        example="CVV 123",
        patterns=((_p(r"(?i:\b(?:cvv2?|cvc2?|cid|card\s+security\s+code|security\s+code))\s*(?:is|:|#|=)?\s*(\d{3,4})(?!\d)"), 1),),
    ),
    Detector(
        id="bank_account",
        label="Bank account number",
        token="BANK ACCOUNT",
        category="financial",
        example="Account number 000123456789",
        patterns=(
            (
                _p(r"(?i:\b(?:bank\s+)?(?:account|acct)\s*(?:number|no\.?|num|#))\s*(?:is|:|#|=)?\s*(\d[\d -]{4,20}\d)"),
                1,
            ),
        ),
        validator=_digit_count_between(6, 17),
    ),
    Detector(
        id="routing_number",
        label="ABA routing number",
        token="ROUTING NUMBER",
        category="financial",
        example="Routing 021000021",
        patterns=((_p(rf"(?i:\b(?:aba|routing|rtn|transit)){_LABEL_TAIL}(\d{{9}})(?!\d)"), 1),),
        validator=aba_valid,
    ),
    Detector(
        id="iban",
        label="International bank account (IBAN)",
        token="IBAN",
        category="financial",
        example="GB82 WEST 1234 5698 7654 32",
        patterns=((_p(r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b"), 0),),
        validator=iban_valid,
    ),
    Detector(
        id="medical_record_number",
        label="Medical record number",
        token="MEDICAL RECORD",
        category="health",
        example="MRN: 00482913",
        patterns=(
            (
                _p(
                    r"(?i:\b(?:mrn|medical\s+record(?:\s*(?:number|no\.?|num|#))?|patient\s+(?:id|number|no\.?)))"
                    r"\s*(?:is|:|#|=)?\s*([A-Za-z0-9][A-Za-z0-9-]{3,15})\b"
                ),
                1,
            ),
        ),
        validator=has_digit,
    ),
    Detector(
        id="health_plan_id",
        label="Health plan member or subscriber ID",
        token="HEALTH PLAN ID",
        category="health",
        example="Member ID: XJH4429017",
        patterns=(
            (
                _p(
                    r"(?i:\b(?:member|subscriber|policy|insurance|beneficiary|medicaid|group)\s*(?:id|number|no\.?|num|#))"
                    r"\s*(?:is|:|#|=)?\s*([A-Za-z0-9][A-Za-z0-9-]{4,19})\b"
                ),
                1,
            ),
        ),
        validator=has_digit,
    ),
    Detector(
        id="medicare_mbi",
        label="Medicare beneficiary identifier",
        token="MEDICARE ID",
        category="health",
        example="1EG4-TE5-MK73",
        patterns=(
            (
                _p(
                    r"\b[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d-?[AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d-?"
                    r"[AC-HJKMNP-RT-Y]{2}\d{2}\b"
                ),
                0,
            ),
        ),
    ),
    Detector(
        id="private_key",
        label="Private key",
        token="PRIVATE KEY",
        category="credentials",
        example="-----BEGIN PRIVATE KEY-----",
        patterns=(
            (
                _p(r"-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]{0,6000}?(?:-----END [A-Z ]{0,30}PRIVATE KEY-----|\Z)"),
                0,
            ),
        ),
    ),
    Detector(
        id="api_key",
        label="API key or access token",
        token="API KEY",
        category="credentials",
        example="sk-live-…",
        patterns=(
            (
                _p(
                    r"\b(?:sk-[A-Za-z0-9_-]{20,200}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36,80}"
                    r"|github_pat_[A-Za-z0-9_]{22,200}|xox[abposr]-[A-Za-z0-9-]{10,200}"
                    r"|AIza[0-9A-Za-z_-]{35})\b"
                ),
                0,
            ),
            (_p(r"\beyJ[A-Za-z0-9_-]{10,400}\.[A-Za-z0-9_-]{10,400}\.[A-Za-z0-9_-]{10,400}"), 0),
            (_p(r"(?i:\bbearer)\s+([A-Za-z0-9._~+/-]{20,400}=*)"), 1),
        ),
    ),
    Detector(
        id="password",
        label="Disclosed password or PIN",
        token="PASSWORD",
        category="credentials",
        example="password: Hunter2!",
        patterns=(
            (
                # Lazy, so trailing sentence punctuation is not taken as part of the secret.
                _p(r"(?i:\b(?:password|passwd|pwd|passcode|pin)\b)\s*(?:is|:|=)\s*(\S{4,64}?)(?=[.,;:)\]]?(?:\s|$))"),
                1,
            ),
        ),
        validator=_password_like,
    ),
    Detector(
        id="ip_address",
        label="IP address",
        token="IP ADDRESS",
        category="network",
        example="203.0.113.42",
        patterns=(
            (_p(r"(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\d|\.\d)"), 0),
        ),
        validator=_ipv4_valid,
    ),
)

DETECTORS_BY_ID: dict[str, Detector] = {detector.id: detector for detector in DETECTORS}


# --- shadow normalization -----------------------------------------------------

_INVISIBLE = frozenset("\u200b\u200c\u200d\u2060\ufeff\u00ad\u180e\u2061\u2062\u2063\u2064")
_DASHES = frozenset("\u2010\u2011\u2012\u2013\u2014\u2015\u2212\ufe58\ufe63\uff0d")
_SPACES = frozenset("\u00a0\u2007\u202f\u2009\u200a\u3000")


def shadow_text(text: str) -> tuple[str, list[int] | None]:
    """ASCII-folded copy plus a map from shadow index to original index.

    Pure-ASCII text (the common case) is returned as-is with no map."""
    if text.isascii():
        return text, None
    out: list[str] = []
    index: list[int] = []
    for position, char in enumerate(text):
        if char in _INVISIBLE:
            continue
        if char.isascii():
            mapped = char
        elif char in _DASHES:
            mapped = "-"
        elif char in _SPACES:
            mapped = " "
        else:
            decimal = unicodedata.decimal(char, None)
            if decimal is not None:
                mapped = str(decimal)
            else:
                folded = unicodedata.normalize("NFKC", char)
                mapped = folded if len(folded) == 1 and folded.isascii() and folded.isalnum() else char
        out.append(mapped)
        index.append(position)
    return "".join(out), index


def original_span(index: list[int] | None, start: int, end: int) -> tuple[int, int]:
    if index is None:
        return start, end
    return index[start], index[end - 1] + 1


# --- detection and concealment -------------------------------------------------


@dataclass(frozen=True)
class Finding:
    start: int
    end: int
    detector: Detector


def _enabled_detectors(categories: Iterable[str] | None, detector_ids: Iterable[str] | None) -> list[Detector]:
    allowed_categories = set(categories) if categories is not None else None
    allowed_ids = set(detector_ids) if detector_ids is not None else None
    return [
        detector
        for detector in DETECTORS
        if (allowed_categories is None or detector.category in allowed_categories)
        and (allowed_ids is None or detector.id in allowed_ids)
    ]


def find_personal_data(
    text: str,
    categories: Iterable[str] | None = None,
    *,
    detector_ids: Iterable[str] | None = None,
) -> list[Finding]:
    """Non-overlapping findings in original-text coordinates, left to right."""
    if not text:
        return []
    shadow, index = shadow_text(text)
    candidates: list[tuple[int, int, int, Detector]] = []
    for priority, detector in enumerate(_enabled_detectors(categories, detector_ids)):
        for pattern, group in detector.patterns:
            for match in pattern.finditer(shadow):
                start, end = match.span(group)
                if start < 0 or start == end:
                    continue
                if TOKEN_OPEN in shadow[start:end] or TOKEN_CLOSE in shadow[start:end]:
                    # Never re-detect a placeholder (password: ⟦PASSWORD⟧).
                    continue
                if detector.validator is not None and not detector.validator(shadow[start:end]):
                    span = (
                        validated_subspan(shadow, start, end, detector.validator)
                        if detector.trim_groups
                        else None
                    )
                    if span is None:
                        continue
                    start, end = span
                candidates.append((start, end, priority, detector))
    # Earliest first; on a tie the longer span, then detector order, wins.
    candidates.sort(key=lambda item: (item[0], -(item[1] - item[0]), item[2]))
    findings: list[Finding] = []
    last_end = -1
    for start, end, _priority, detector in candidates:
        if start < last_end:
            continue
        original_start, original_end = original_span(index, start, end)
        findings.append(Finding(original_start, original_end, detector))
        last_end = end
    return findings


def contains_personal_data(
    text: str,
    categories: Iterable[str] | None = None,
    *,
    detector_ids: Iterable[str] | None = None,
) -> bool:
    return bool(find_personal_data(text, categories, detector_ids=detector_ids))


@dataclass
class Concealment:
    text: str
    counts: Counter[str] = field(default_factory=Counter)

    @property
    def total(self) -> int:
        return sum(self.counts.values())

    def labels(self) -> list[dict[str, object]]:
        return [
            {"id": detector_id, "label": DETECTORS_BY_ID[detector_id].label, "count": count}
            for detector_id, count in sorted(self.counts.items())
            if detector_id in DETECTORS_BY_ID
        ]


def _apply(text: str, findings: list[Finding]) -> Concealment:
    if not findings:
        return Concealment(text=text)
    parts: list[str] = []
    cursor = 0
    counts: Counter[str] = Counter()
    for finding in findings:
        parts.append(text[cursor : finding.start])
        parts.append(token(finding.detector.token))
        counts[finding.detector.id] += 1
        cursor = finding.end
    parts.append(text[cursor:])
    return Concealment(text="".join(parts), counts=counts)


_CACHEABLE_CHARS = 16_384


@lru_cache(maxsize=1024)
def _conceal_cached(text: str, categories: tuple[str, ...] | None) -> tuple[str, tuple[tuple[str, int], ...]]:
    result = _apply(text, find_personal_data(text, categories))
    return result.text, tuple(result.counts.items())


def conceal(text: str, categories: Iterable[str] | None = None) -> Concealment:
    """Replace every detected value with a typed token such as ``⟦SSN⟧``.

    Chat saves resend the whole conversation, so results for ordinary-size
    texts are memoized; unchanged messages are not re-scanned on every save.
    """
    if not text:
        return Concealment(text=text or "")
    if len(text) <= _CACHEABLE_CHARS:
        key = tuple(sorted(set(categories))) if categories is not None else None
        concealed, counts = _conceal_cached(text, key)
        return Concealment(text=concealed, counts=Counter(dict(counts)))
    return _apply(text, find_personal_data(text, categories))


def conceal_text(text: str, categories: Iterable[str] | None = None) -> str:
    return conceal(text, categories).text


def concealed_token_labels(text: str) -> set[str]:
    """Token labels already present, e.g. {"SSN"} for "SSN ⟦SSN⟧"."""
    return set(TOKEN_PATTERN.findall(text or ""))


class StreamingConcealer:
    """Conceal a streamed response without buffering all of it.

    Text is released only once it sits at least ``HOLD`` characters behind
    the newest delta, and a match that reaches into the held tail holds the
    cut back to its own start. Matches longer than ``HOLD`` are covered too:
    a private key that has not reached its END line matches to the end of the
    buffer, and the cut never falls inside a whitespace-free run (a JWT or
    key still arriving) shorter than ``MAX_TOKEN_RUN``. The joined output
    equals ``conceal`` of the full text.
    """

    HOLD = 320
    # Longest whitespace-free run held back whole (JWTs reach ~1,200 chars).
    MAX_TOKEN_RUN = 2048
    _CONTEXT = 64

    def __init__(self, categories: Iterable[str] | None = None) -> None:
        self._categories = list(categories) if categories is not None else None
        self._buffer = ""
        # Absolute offset of _buffer[0] and of the first unreleased character.
        self._base = 0
        self._released = 0
        self.counts: Counter[str] = Counter()

    def feed(self, delta: str) -> str:
        if not delta:
            return ""
        self._buffer += delta
        return self._drain(final=False)

    def flush(self) -> str:
        return self._drain(final=True)

    def _drain(self, *, final: bool) -> str:
        end = self._base + len(self._buffer)
        cut = end if final else end - self.HOLD
        if cut <= self._released:
            return ""
        offset = self._released - self._base
        findings = [
            finding
            for finding in find_personal_data(self._buffer, self._categories)
            if finding.start >= offset
        ]
        cut_local = cut - self._base
        for finding in findings:
            if finding.end > cut_local and finding.start < cut_local:
                cut_local = finding.start
        if not final and 0 < cut_local < len(self._buffer):
            # Tokens such as JWTs can outgrow HOLD before their pattern can
            # match, so never cut inside a whitespace-free run of plausible
            # secret length; release it once it is complete.
            if not self._buffer[cut_local - 1].isspace() and not self._buffer[cut_local].isspace():
                run_start = max(self._buffer.rfind(char, offset, cut_local) for char in " \n\t\r") + 1
                if run_start > offset and len(self._buffer) - run_start <= self.MAX_TOKEN_RUN:
                    cut_local = run_start
                elif run_start <= offset and len(self._buffer) - offset <= self.MAX_TOKEN_RUN:
                    cut_local = offset
        if cut_local <= offset:
            return ""
        inside = [
            Finding(finding.start - offset, finding.end - offset, finding.detector)
            for finding in findings
            if finding.end <= cut_local
        ]
        released = _apply(self._buffer[offset:cut_local], inside)
        self.counts.update(released.counts)
        self._released = self._base + cut_local
        # Keep a little released context for look-behind checks.
        keep_from = max(0, cut_local - self._CONTEXT)
        self._buffer = self._buffer[keep_from:]
        self._base += keep_from
        return released.text


def detector_catalog() -> list[dict[str, object]]:
    """What the engine detects, for the admin console. Never includes data."""
    return [
        {
            "id": detector.id,
            "label": detector.label,
            "token": detector.token,
            "category": detector.category,
            "category_label": CATEGORY_LABELS[detector.category],
            "example": detector.example,
        }
        for detector in DETECTORS
    ]


# --- name masking (training datasets only) --------------------------------------


def conceal_names(text: str, names: Iterable[tuple[str, str]]) -> Concealment:
    """Replace known names (workspace people, configured clients) with tokens.

    ``names`` is (name, token label) pairs. Matching is case-insensitive on
    whole words, longest names first so "Jordan Lee" wins over "Jordan".
    Names shorter than three characters are ignored to avoid shredding text.
    """
    unique: dict[str, str] = {}
    for name, label in names:
        cleaned = " ".join(str(name or "").split())
        if len(cleaned) >= 3 and cleaned.casefold() not in unique:
            unique[cleaned.casefold()] = label
    if not text or not unique:
        return Concealment(text=text or "")
    ordered = sorted(unique.items(), key=lambda item: -len(item[0]))
    counts: Counter[str] = Counter()
    result = text
    for name, label in ordered:
        pattern = re.compile(r"(?<!\w)" + r"\s+".join(map(re.escape, name.split())) + r"(?!\w)", re.IGNORECASE)
        result, replaced = pattern.subn(token(label), result)
        if replaced:
            counts[f"name:{label.lower()}"] += replaced
    return Concealment(text=result, counts=counts)
