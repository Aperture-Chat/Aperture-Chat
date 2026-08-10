from __future__ import annotations

import base64
import hashlib
import hmac
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

PASSWORD_HASH_SCHEME = "pbkdf2_sha256"
PASSWORD_HASH_ITERATIONS = 310_000


class SecretVault:
    """Authenticated local secret vault with read-only legacy compatibility.

    New values use AES-256-GCM with a key derived from the deployment signing
    secret. Legacy XOR/HMAC tokens remain decryptable only so SeedStore can
    migrate them to v2 at startup. A managed KMS remains the preferred
    deployment boundary for installations that require external key custody.
    """

    V2_PREFIX = "v2."
    V2_INFO = b"aperture-vault-v2"
    V2_AAD = b"aperture-secret-vault"
    V3_PREFIX = "v3."
    V3_INFO = b"aperture-vault-v3"
    V3_AAD_PREFIX = b"aperture-secret-vault:v3:"

    def __init__(self, secret_key: str) -> None:
        encoded_secret = secret_key.encode("utf-8")
        self._legacy_key = hashlib.sha256(encoded_secret).digest()
        self._key = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=None,
            info=self.V2_INFO,
        ).derive(encoded_secret)
        self._scoped_key = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=None,
            info=self.V3_INFO,
        ).derive(encoded_secret)

    def encrypt(self, value: str) -> str:
        nonce = os.urandom(12)
        payload = AESGCM(self._key).encrypt(nonce, value.encode("utf-8"), self.V2_AAD)
        token = base64.urlsafe_b64encode(nonce + payload).decode("ascii")
        return f"{self.V2_PREFIX}{token}"

    def decrypt(self, token: str) -> str:
        if token.startswith(self.V2_PREFIX):
            return self._decrypt_v2(token.removeprefix(self.V2_PREFIX))
        return self._decrypt_legacy(token)

    def encrypt_scoped(self, value: str, *, aad: bytes) -> str:
        """Encrypt one value under mandatory caller-derived v3 context.

        This is intentionally separate from the compatibility ``decrypt``
        path. Security-sensitive consumers such as MFA must never accept a v2
        or legacy ciphertext when row identity is part of the integrity
        boundary.
        """

        associated_data = self._scoped_associated_data(aad)
        nonce = os.urandom(12)
        payload = AESGCM(self._scoped_key).encrypt(
            nonce,
            value.encode("utf-8"),
            associated_data,
        )
        token = base64.urlsafe_b64encode(nonce + payload).decode("ascii")
        return f"{self.V3_PREFIX}{token}"

    def decrypt_scoped(self, token: str, *, aad: bytes) -> str:
        """Decrypt only a v3 ciphertext under mandatory authoritative AAD."""

        if not isinstance(token, str) or not token.startswith(self.V3_PREFIX):
            raise ValueError("Scoped secret token must use the v3 format")
        associated_data = self._scoped_associated_data(aad)
        encoded = token.removeprefix(self.V3_PREFIX)
        try:
            raw = base64.urlsafe_b64decode(encoded.encode("ascii"))
            nonce, payload = raw[:12], raw[12:]
            if len(nonce) != 12 or len(payload) < 16:
                raise ValueError("Scoped secret token is malformed")
            plaintext = AESGCM(self._scoped_key).decrypt(
                nonce,
                payload,
                associated_data,
            )
            return plaintext.decode("utf-8")
        except (InvalidTag, UnicodeDecodeError, ValueError) as exc:
            raise ValueError("Scoped secret token failed integrity check") from exc

    def _scoped_associated_data(self, aad: bytes) -> bytes:
        if not isinstance(aad, bytes) or not aad or len(aad) > 1024:
            raise ValueError("Scoped secret AAD must contain between 1 and 1024 bytes")
        return self.V3_AAD_PREFIX + aad

    def _decrypt_v2(self, token: str) -> str:
        try:
            raw = base64.urlsafe_b64decode(token.encode("ascii"))
            nonce, payload = raw[:12], raw[12:]
            if len(nonce) != 12 or len(payload) < 16:
                raise ValueError("Secret token is malformed")
            plaintext = AESGCM(self._key).decrypt(nonce, payload, self.V2_AAD)
            return plaintext.decode("utf-8")
        except (InvalidTag, UnicodeDecodeError, ValueError) as exc:
            raise ValueError("Secret token failed integrity check") from exc

    def _decrypt_legacy(self, token: str) -> str:
        raw = base64.urlsafe_b64decode(token.encode("ascii"))
        nonce, tag, payload = raw[:16], raw[16:48], raw[48:]
        expected = hmac.new(self._legacy_key, nonce + payload, hashlib.sha256).digest()
        if not hmac.compare_digest(tag, expected):
            raise ValueError("Secret token failed integrity check")
        stream = self._keystream(nonce, len(payload))
        return bytes(a ^ b for a, b in zip(payload, stream, strict=True)).decode("utf-8")

    def _keystream(self, nonce: bytes, length: int) -> bytes:
        blocks: list[bytes] = []
        counter = 0
        while sum(len(block) for block in blocks) < length:
            blocks.append(
                hmac.new(
                    self._legacy_key,
                    nonce + counter.to_bytes(4, "big"),
                    hashlib.sha256,
                ).digest()
            )
            counter += 1
        return b"".join(blocks)[:length]


def mask_secret(value: str) -> str:
    if len(value) <= 8:
        return "••••••••"
    return f"{value[:3]}••••••••{value[-4:]}"


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        PASSWORD_HASH_ITERATIONS,
    )
    return "$".join(
        [
            PASSWORD_HASH_SCHEME,
            str(PASSWORD_HASH_ITERATIONS),
            base64.urlsafe_b64encode(salt).decode("ascii"),
            base64.urlsafe_b64encode(digest).decode("ascii"),
        ],
    )


def verify_password(password: str, encoded_hash: str | None) -> bool:
    if not encoded_hash:
        return False
    try:
        scheme, iterations_raw, salt_raw, digest_raw = encoded_hash.split("$", 3)
        if scheme != PASSWORD_HASH_SCHEME:
            return False
        iterations = int(iterations_raw)
        salt = base64.urlsafe_b64decode(salt_raw.encode("ascii"))
        expected = base64.urlsafe_b64decode(digest_raw.encode("ascii"))
    except (ValueError, TypeError):
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(actual, expected)


def redact_metadata(metadata: dict[str, object]) -> dict[str, object]:
    return {key: _redact_value(key, value) for key, value in metadata.items()}


# Keys that trip the substring match below while holding nothing secret. A
# token *budget* is a number an auditor needs: redacting it meant the trail
# recorded who changed a usage cap but never what they changed it to.
_NON_SECRET_KEYS = frozenset(
    {
        "completion_tokens",
        "daily_token_limit",
        "max_completion_tokens",
        "max_tokens",
        "prompt_tokens",
        "reported_tokens",
        "token_limit",
        "total_tokens",
    }
)


def _redact_value(key: str, value: object) -> object:
    lowered = key.lower()
    if lowered in _NON_SECRET_KEYS:
        return value
    if any(
        token in lowered
        for token in (
            "key",
            "secret",
            "token",
            "password",
            "seed",
            "recovery",
            "totp",
            "challenge",
            "enrollment",
            "ciphertext",
            "provisioning",
        )
    ):
        return "[redacted]"
    if isinstance(value, dict):
        return {str(child_key): _redact_value(str(child_key), child_value) for child_key, child_value in value.items()}
    if isinstance(value, list):
        return [_redact_value(key, item) for item in value]
    return value
