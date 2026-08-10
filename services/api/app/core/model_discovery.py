"""Provider model discovery for platform-owner model sync.

Secrets stay server-side. Discovery sends the active vaulted provider key only to
the configured provider endpoint and returns normalized model metadata for the
platform catalog.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from app.core.model_gateway import (
    UNSUPPORTED_PROVIDER_KINDS,
    default_provider_base_url,
    provider_dialect,
)
from app.models.schemas import ModelCapabilities, Provider

DEFAULT_DISCOVERY_TIMEOUT_SECONDS = 30.0
OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"


@dataclass(frozen=True)
class DiscoveredModel:
    id: str
    name: str
    context_window: int | None = None
    notes: str | None = None
    capabilities: ModelCapabilities | None = None


class ModelDiscoveryError(RuntimeError):
    def __init__(self, message: str, *, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


def discover_provider_models(
    provider: Provider,
    secret_value: str | None,
    *,
    transport: httpx.BaseTransport | None = None,
    timeout: float = DEFAULT_DISCOVERY_TIMEOUT_SECONDS,
) -> tuple[list[DiscoveredModel], str]:
    kind = provider.kind.strip().lower()
    if kind == "openrouter":
        return _discover_openrouter(provider, secret_value, transport=transport, timeout=timeout)
    if kind in UNSUPPORTED_PROVIDER_KINDS and not str(provider.auth_metadata.get("dialect") or "").strip():
        raise ModelDiscoveryError(f"{provider.name} does not expose a supported model discovery API yet.", status_code=400)
    dialect = provider_dialect(kind, provider.auth_metadata)
    if dialect == "anthropic":
        return _discover_anthropic(provider, secret_value, transport=transport, timeout=timeout)
    if dialect in {"azure-openai", "azure-foundry"}:
        raise ModelDiscoveryError(f"{provider.name} does not expose a supported model discovery API yet.", status_code=400)
    # Everything on the OpenAI dialect - including unknown kinds that default
    # to it - lists models via GET {base}/models with the provider's auth
    # header, so an owner can sync any newly registered provider.
    return _discover_openai_compatible(provider, secret_value, transport=transport, timeout=timeout)


def _discover_openrouter(
    provider: Provider,
    secret_value: str | None,
    *,
    transport: httpx.BaseTransport | None,
    timeout: float,
) -> tuple[list[DiscoveredModel], str]:
    if not secret_value:
        raise ModelDiscoveryError("OpenRouter model sync requires an active provider key.", status_code=400)

    base_url = _openrouter_base_url(provider)
    headers = _bearer_headers(secret_value)
    if _openrouter_catalog_scope(provider) == "zdr":
        zdr_catalog = _fetch_model_payload(
            f"{base_url}/models",
            headers=headers,
            params={"zdr": "true"},
            transport=transport,
            timeout=timeout,
        )
        return (
            _normalize_openrouter_models(zdr_catalog, "Synced from OpenRouter ZDR-filtered catalog."),
            "openrouter:/models?zdr=true",
        )

    user_catalog = _fetch_model_payload(
        f"{base_url}/models/user",
        headers=headers,
        transport=transport,
        timeout=timeout,
        allow_missing=True,
    )
    if user_catalog is not None:
        return (
            _normalize_openrouter_models(
                user_catalog,
                "Synced from OpenRouter key-scoped catalog; provider preferences, privacy settings, and guardrails applied.",
            ),
            "openrouter:/models/user",
        )

    zdr_catalog = _fetch_model_payload(
        f"{base_url}/models",
        headers=headers,
        params={"zdr": "true"},
        transport=transport,
        timeout=timeout,
    )
    return (
        _normalize_openrouter_models(zdr_catalog, "Synced from OpenRouter ZDR-filtered catalog."),
        "openrouter:/models?zdr=true",
    )


def _discover_openai_compatible(
    provider: Provider,
    secret_value: str | None,
    *,
    transport: httpx.BaseTransport | None,
    timeout: float,
) -> tuple[list[DiscoveredModel], str]:
    catalog = _fetch_model_payload(
        f"{_base_url(provider, default_provider_base_url(provider.kind))}/models",
        headers=_provider_headers(provider, secret_value),
        transport=transport,
        timeout=timeout,
    )
    return (_normalize_openai_compatible_models(catalog, f"Synced from {provider.name} /models catalog."), "models")


ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com"
ANTHROPIC_DEFAULT_VERSION = "2023-06-01"


def _discover_anthropic(
    provider: Provider,
    secret_value: str | None,
    *,
    transport: httpx.BaseTransport | None,
    timeout: float,
) -> tuple[list[DiscoveredModel], str]:
    """Sync the Anthropic model catalog (GET /v1/models).

    Anthropic authenticates with ``x-api-key`` plus a version header rather
    than a bearer token, and its catalog reports no capability metadata, so
    feature gates for these models rely on the family heuristics.
    """
    if not secret_value:
        raise ModelDiscoveryError(f"{provider.name} model sync requires an active provider key.", status_code=400)
    base = (provider.base_url or ANTHROPIC_DEFAULT_BASE_URL).strip().rstrip("/")
    if not base.endswith("/v1"):
        base = f"{base}/v1"
    version = str(provider.auth_metadata.get("anthropic_version") or ANTHROPIC_DEFAULT_VERSION)
    catalog = _fetch_model_payload(
        f"{base}/models",
        headers={"x-api-key": secret_value, "anthropic-version": version, "Content-Type": "application/json"},
        params={"limit": "1000"},
        transport=transport,
        timeout=timeout,
    )
    return (
        _dedupe_models(
            DiscoveredModel(
                id=str(item.get("id") or "").strip(),
                name=str(item.get("display_name") or item.get("id") or "").strip(),
                context_window=_int_value(item.get("context_length") or item.get("context_window")),
                notes=f"Synced from {provider.name} /v1/models catalog.",
            )
            for item in catalog or []
        ),
        "anthropic:/v1/models",
    )


def _fetch_model_payload(
    url: str,
    *,
    headers: dict[str, str],
    params: dict[str, str] | None = None,
    transport: httpx.BaseTransport | None = None,
    timeout: float,
    allow_missing: bool = False,
) -> list[dict[str, Any]] | None:
    try:
        with httpx.Client(timeout=timeout, transport=transport) as client:
            response = client.get(url, headers=headers, params=params)
        if allow_missing and response.status_code in {404, 405}:
            return None
        response.raise_for_status()
        payload = response.json()
    except httpx.HTTPStatusError as exc:
        upstream_status = exc.response.status_code
        raise ModelDiscoveryError(
            f"Provider model sync failed with HTTP {upstream_status}.",
            status_code=upstream_status if upstream_status in {400, 401, 403} else 502,
        ) from exc
    except httpx.HTTPError as exc:
        raise ModelDiscoveryError(f"Provider model sync failed: {type(exc).__name__}.", status_code=502) from exc
    except ValueError as exc:
        raise ModelDiscoveryError("Provider model sync returned invalid JSON.", status_code=502) from exc

    data = payload.get("data") if isinstance(payload, dict) else payload
    if not isinstance(data, list):
        raise ModelDiscoveryError("Provider model sync did not return a model list.", status_code=502)
    return [item for item in data if isinstance(item, dict)]


def _normalize_openrouter_models(items: list[dict[str, Any]], notes: str) -> list[DiscoveredModel]:
    return _dedupe_models(
        DiscoveredModel(
            id=str(item.get("id") or "").strip(),
            name=str(item.get("name") or item.get("id") or "").strip(),
            context_window=_int_value(item.get("context_length") or item.get("context_window")),
            notes=notes,
            capabilities=_capabilities_from_catalog(item),
        )
        for item in items
    )


def _normalize_openai_compatible_models(items: list[dict[str, Any]], notes: str) -> list[DiscoveredModel]:
    return _dedupe_models(
        DiscoveredModel(
            id=str(item.get("id") or "").strip(),
            name=str(item.get("name") or item.get("id") or "").strip(),
            context_window=_int_value(item.get("context_length") or item.get("context_window")),
            notes=notes,
            capabilities=_capabilities_from_catalog(item),
        )
        for item in items
    )


def _capabilities_from_catalog(item: dict[str, Any]) -> ModelCapabilities | None:
    """Capability metadata from a provider catalog entry, if reported.

    OpenRouter lists ``supported_parameters`` plus ``architecture`` input and
    output modalities; plain OpenAI-compatible ``/models`` catalogs usually
    report none of these, in which case the model carries no capability
    record and feature gates fall back to family heuristics.
    """
    supported = _string_list(item.get("supported_parameters"))
    architecture = item.get("architecture") if isinstance(item.get("architecture"), dict) else {}
    input_modalities = _string_list(architecture.get("input_modalities"))
    output_modalities = _string_list(architecture.get("output_modalities"))
    if not supported and not input_modalities and not output_modalities:
        return None
    return ModelCapabilities(
        supported_parameters=supported,
        input_modalities=input_modalities,
        output_modalities=output_modalities,
    )


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    normalized = [str(entry).strip().lower() for entry in value if isinstance(entry, str) and entry.strip()]
    return list(dict.fromkeys(normalized))


def _dedupe_models(models: Any) -> list[DiscoveredModel]:
    seen: set[str] = set()
    normalized: list[DiscoveredModel] = []
    for model in models:
        if not model.id or model.id in seen:
            continue
        seen.add(model.id)
        normalized.append(model)
    return normalized


def _provider_headers(provider: Provider, secret_value: str | None) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if not secret_value:
        return headers
    header_name = str(provider.auth_metadata.get("header_name") or "").strip()
    auth_type = (provider.auth_type or "").strip().lower()
    if not header_name or header_name.lower() == "authorization" or auth_type in {"bearer", "oauth"}:
        headers["Authorization"] = f"Bearer {secret_value}"
        return headers
    headers[header_name] = secret_value
    return headers


def _bearer_headers(secret_value: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {secret_value}", "Content-Type": "application/json"}


def _base_url(provider: Provider, fallback: str | None = None) -> str:
    base = (provider.base_url or fallback or "").strip()
    if not base:
        raise ModelDiscoveryError(f"{provider.name} needs a base URL before model sync can run.", status_code=400)
    return base.rstrip("/")


def _openrouter_base_url(provider: Provider) -> str:
    base = _base_url(provider, OPENROUTER_DEFAULT_BASE_URL)
    if base.rstrip("/").lower() == "https://openrouter.ai":
        return f"{base}/api/v1"
    return base


def _openrouter_catalog_scope(provider: Provider) -> str:
    scope = str(provider.auth_metadata.get("catalog_scope") or "").strip().lower()
    return "user" if scope == "user" else "zdr"


def _int_value(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None
