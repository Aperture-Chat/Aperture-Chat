"""Deliver durable audit-outbox events to Elasticsearch when configured.

Every audit event is committed with an ordered SQL outbox row. When
APERTURE_ELASTIC_URL and APERTURE_ELASTIC_API_KEY are set, the in-process
scheduler flushes pending rows to Elastic's ``_bulk`` API; otherwise the
platform console honestly reports the export as not configured and rows stay
pending.

The Elastic endpoint is operator-level environment configuration (never user
input), so it is not subject to the user-input egress guard. Delivery is
at-least-once: rows are marked delivered only after a completely successful
batch response, so a crash or transient failure can cause a retry.
"""

from __future__ import annotations

import json
import logging

import httpx

from app.core import clock
from app.core.config import Settings
from app.repositories.application_state import ApplicationStateRepository
from app.repositories.seed import SeedStore

logger = logging.getLogger("aperture.elastic")

ELASTIC_INDEX = "aperture-audit"
FLUSH_BATCH_LIMIT = 500
REQUEST_TIMEOUT_SECONDS = 15.0


def elastic_configured(settings: Settings) -> bool:
    return bool(settings.elastic_url and settings.elastic_api_key)


def flush_elastic_events(
    store: SeedStore,
    settings: Settings,
    *,
    transport: httpx.BaseTransport | None = None,
) -> int:
    """Send buffered events to Elastic. Returns the number delivered.

    Failures never raise: outbox rows stay pending, the error is recorded on
    the store for the status endpoint, and the next scheduler pass retries.
    """
    if not elastic_configured(settings):
        return 0
    repository = _repository(store)
    batch = repository.pending_outbox(limit=FLUSH_BATCH_LIMIT)
    if not batch:
        return 0
    lines: list[str] = []
    for row in batch:
        lines.append(json.dumps({"index": {"_index": ELASTIC_INDEX}}))
        lines.append(json.dumps(row.payload, default=str))
    body = "\n".join(lines) + "\n"
    url = (settings.elastic_url or "").rstrip("/") + "/_bulk"
    try:
        with httpx.Client(timeout=REQUEST_TIMEOUT_SECONDS, transport=transport) as client:
            response = client.post(
                url,
                content=body,
                headers={
                    "Authorization": f"ApiKey {settings.elastic_api_key}",
                    "Content-Type": "application/x-ndjson",
                },
            )
        response.raise_for_status()
        payload = response.json()
        if payload.get("errors"):
            raise RuntimeError("Elastic bulk response reported item-level errors.")
        delivered_at = clock.now()
        delivered = repository.mark_outbox_delivered(
            (row.sequence for row in batch),
            delivered_at=delivered_at,
        )
    except Exception as exc:  # noqa: BLE001 - delivery must never crash the scheduler
        store.elastic_last_delivery_error = str(exc)
        logger.warning(
            "Elastic delivery failed; %d attempted events remain pending: %s",
            len(batch),
            exc,
        )
        return 0
    store.elastic_last_delivery_at = delivered_at.isoformat()
    store.elastic_last_delivery_error = None
    if delivered != len(batch):
        logger.warning(
            "Elastic accepted %d events, but only %d pending outbox rows were marked delivered.",
            len(batch),
            delivered,
        )
    return delivered


def _repository(store: SeedStore) -> ApplicationStateRepository:
    repository = getattr(store, "application_state_repository", None)
    if not isinstance(repository, ApplicationStateRepository):
        raise RuntimeError("Application SQL state repository is not initialized.")
    return repository
