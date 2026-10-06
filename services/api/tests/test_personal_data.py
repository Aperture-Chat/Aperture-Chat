"""The shared personal-data engine: detection, validation, evasion, streaming.

All values are synthetic, documented test numbers.
"""

from __future__ import annotations

import random

import pytest

from app.core.personal_data import (
    StreamingConcealer,
    aba_valid,
    card_valid,
    conceal,
    conceal_names,
    concealed_token_labels,
    contains_personal_data,
    detector_catalog,
    iban_valid,
    ssn_valid,
    vin_valid,
)


@pytest.mark.parametrize(
    ("text", "token"),
    [
        ("SSN 123-45-6789 on file", "⟦SSN⟧"),
        ("ssn: 123456789", "⟦SSN⟧"),
        ("ITIN 912-70-1234", "⟦ITIN⟧"),
        ("Passport no. X1234567", "⟦PASSPORT⟧"),
        ("Driver's license D1234-5678", "⟦DRIVER LICENSE⟧"),
        ("DOB: 04/12/1986", "⟦DATE OF BIRTH⟧"),
        ("born on March 3rd, 1990", "⟦DATE OF BIRTH⟧"),
        ("VIN 1HGCM82633A004352", "⟦VIN⟧"),
        ("write to jordan@example.com", "⟦EMAIL⟧"),
        ("call (415) 555-0134", "⟦PHONE⟧"),
        ("call +44 20 7946 0958", "⟦PHONE⟧"),
        ("lives at 1200 Harbor View Drive, Apt 4B", "⟦ADDRESS⟧"),
        ("card 4111 1111 1111 1111", "⟦CARD NUMBER⟧"),
        ("Account number 000123456789", "⟦BANK ACCOUNT⟧"),
        ("routing 021000021", "⟦ROUTING NUMBER⟧"),
        ("IBAN GB82 WEST 1234 5698 7654 32", "⟦IBAN⟧"),
        ("MRN: 00482913", "⟦MEDICAL RECORD⟧"),
        ("Member ID: XJH4429017", "⟦HEALTH PLAN ID⟧"),
        ("MBI 1EG4-TE5-MK73", "⟦MEDICARE ID⟧"),
        ("key sk-abcdefghijklmnopqrstuvwxyz123456", "⟦API KEY⟧"),
        ("password: Hunter2!", "⟦PASSWORD⟧"),
        ("from 203.0.113.42", "⟦IP ADDRESS⟧"),
    ],
)
def test_each_detector_conceals_its_identifier(text: str, token: str) -> None:
    result = conceal(text)
    assert token in result.text
    assert result.total >= 1


@pytest.mark.parametrize(
    "text",
    [
        "Area 000-12-3456 and 666-12-3456 are never issued",
        "Matter 2024-123-45-6789 is a docket number",
        "Order 1234 5678 9012 3456 fails the Luhn check",
        "routing 123456789 fails the ABA checksum",
        "Version 1.2.3 and loopback 127.0.0.1",
        "The password is required for this form.",
        "Random ABCDEFGHJKLMN1234 is not a VIN",
    ],
)
def test_look_alikes_are_left_alone(text: str) -> None:
    assert conceal(text).text == text


def test_evasion_characters_do_not_hide_values() -> None:
    zero_width = "SSN 1​23-45-67‍89"
    full_width = "SSN １２３-４５-６７８９"
    unicode_dash = "SSN 123–45–6789"
    for text in (zero_width, full_width, unicode_dash):
        result = conceal(text)
        assert result.text == "SSN ⟦SSN⟧", text


def test_concealment_is_idempotent_and_labels_are_readable() -> None:
    once = conceal("SSN 123-45-6789, card 4111 1111 1111 1111").text
    assert conceal(once).text == once
    assert concealed_token_labels(once) == {"SSN", "CARD NUMBER"}


def test_categories_scope_detection() -> None:
    text = "SSN 123-45-6789 and jordan@example.com"
    assert conceal(text, ["contact"]).text == "SSN 123-45-6789 and ⟦EMAIL⟧"
    assert conceal(text, ["identity"]).text == "SSN ⟦SSN⟧ and jordan@example.com"
    assert contains_personal_data(text, ["financial"]) is False


def test_validators() -> None:
    assert card_valid("4111 1111 1111 1111") and not card_valid("4111 1111 1111 1112")
    assert not card_valid("1111 1111 1111 1111")
    assert ssn_valid("123-45-6789") and not ssn_valid("900-12-3456")
    assert aba_valid("021000021") and not aba_valid("123456789")
    assert iban_valid("GB82 WEST 1234 5698 7654 32") and not iban_valid("GB82 WEST 1234 5698 7654 33")
    assert vin_valid("1HGCM82633A004352") and not vin_valid("1HGCM82633A004353")


def test_streaming_concealer_matches_whole_text_for_any_chunking() -> None:
    text = (
        "Intro " * 60
        + "the SSN is 123-45-6789 and the card 4111 1111 1111 1111 "
        + "filler words " * 40
        + "write to jordan@example.com or call (415) 555-0134."
        + " -----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8\n-----END PRIVATE KEY----- done"
    )
    expected = conceal(text).text
    rng = random.Random(7)
    for _ in range(25):
        concealer = StreamingConcealer()
        output = ""
        position = 0
        while position < len(text):
            step = rng.randint(1, 40)
            output += concealer.feed(text[position : position + step])
            position += step
        output += concealer.flush()
        assert output == expected


def test_streaming_concealer_never_releases_a_partial_identifier() -> None:
    concealer = StreamingConcealer()
    released = concealer.feed("x" * 400 + " card 4111 1111 ")
    assert "4111" not in released
    released += concealer.feed("1111 1111 is on file" + " y" * 200)
    released += concealer.flush()
    assert "4111" not in released and "⟦CARD NUMBER⟧" in released


def test_name_concealment_prefers_longest_and_skips_short_names() -> None:
    result = conceal_names(
        "Jordan Avery met Acme Holdings; jordan avery agreed. Al left.",
        [("Jordan Avery", "PERSON"), ("Acme Holdings", "CLIENT"), ("Al", "PERSON")],
    )
    assert result.text == "⟦PERSON⟧ met ⟦CLIENT⟧; ⟦PERSON⟧ agreed. Al left."


def test_catalog_describes_detectors_without_data() -> None:
    catalog = detector_catalog()
    ids = {item["id"] for item in catalog}
    assert {"ssn", "payment_card", "medical_record_number", "email"} <= ids
    assert all(set(item) == {"id", "label", "token", "category", "category_label", "example"} for item in catalog)


@pytest.mark.parametrize(
    "text",
    [
        "Visa 4111-1111-1111-1111 12/27",
        "Card: 4111 1111 1111 1111 12 27 CVV 123",
        "pay with 4111 1111 1111 1111 123",
    ],
)
def test_card_followed_by_expiry_or_code_is_still_found(text: str) -> None:
    concealed = conceal(text).text
    assert "⟦CARD NUMBER⟧" in concealed and "4111" not in concealed


def test_sentence_final_ip_and_card_code_are_concealed() -> None:
    assert conceal("My server is 203.0.113.42.").text == "My server is ⟦IP ADDRESS⟧."
    assert conceal("CVV: 123").text == "CVV: ⟦CARD CODE⟧"


def test_placeholders_are_never_detected_again() -> None:
    assert conceal("password: ⟦PASSWORD⟧").counts == {}


def test_streaming_holds_tokens_longer_than_the_hold_back() -> None:
    jwt = "eyJ" + "a" * 33 + "." + "b" * 334 + "." + "c" * 43
    text = "intro " * 50 + "token " + jwt + " trailing words " * 30
    for size in (1, 7, 16, 200):
        concealer = StreamingConcealer()
        output = "".join(concealer.feed(text[i : i + size]) for i in range(0, len(text), size)) + concealer.flush()
        assert output == conceal(text).text and "eyJ" not in output
