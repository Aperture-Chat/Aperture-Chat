from __future__ import annotations

from datetime import UTC, datetime


NON_EXPIRING_PROVIDER_CREDENTIAL_VALUES = frozenset(
    {"not set", "never", "none", "n/a"}
)
PROVIDER_CREDENTIAL_EXPIRY_FORMATS = ("%b %d, %Y", "%Y-%m-%d")


class ProviderCredentialExpiryError(ValueError):
    """A provider credential expiry is neither a date nor an explicit sentinel."""


def parse_provider_credential_expiry(value: str) -> datetime | None:
    if not isinstance(value, str):
        raise ProviderCredentialExpiryError("Provider credential expiry must be a string.")
    normalized = value.strip()
    if normalized.casefold() in NON_EXPIRING_PROVIDER_CREDENTIAL_VALUES:
        return None
    for date_format in PROVIDER_CREDENTIAL_EXPIRY_FORMATS:
        try:
            return datetime.strptime(normalized, date_format).replace(tzinfo=UTC)
        except ValueError:
            continue
    raise ProviderCredentialExpiryError(
        "Provider credential expiry must be a supported date or explicit no-expiry value."
    )
