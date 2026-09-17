"""Reviewable retention decisions, without sending content to a classifier.

Detection is deliberately advisory: administrator-confirmed identities and
explicit matter links are policy inputs; suggested mentions never trigger purge.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from app.core import clock
from app.core.retention import effective_retention_days
from app.models.schemas import (
    ChatThreadTag,
    TenantRetentionPolicy,
    TenantRetentionPolicyUpdateRequest,
)

SENSITIVE_LABELS = {
    "ssn": "Possible Social Security number",
    "payment_card": "Possible payment card",
    "email": "Email address",
}


def merged_policy(
    policy: TenantRetentionPolicy, patch: TenantRetentionPolicyUpdateRequest
) -> TenantRetentionPolicy:
    updates = patch.model_dump(exclude_unset=True, exclude={"preview_token"})
    merged = TenantRetentionPolicy.model_validate(
        {**policy.model_dump(), **{k: v for k, v in updates.items() if v is not None}}
    )
    source_ids = [source.id for source in merged.sources]
    if len(source_ids) != len(set(source_ids)):
        raise ValueError("Each retention source must have a unique ID")
    if len(merged.rules) > 200:
        raise ValueError("At most 200 retention rules are supported")
    if any(rule.tag_namespace.startswith("suggested_") for rule in merged.rules):
        raise ValueError("Suggestions must be confirmed before they can govern retention")
    if merged.automation_enabled and merged.enabled and merged.grace_days < 7:
        raise ValueError("Automatic deletion requires a review window of at least 7 days")
    return merged


def normalized(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def detected_tags(policy: TenantRetentionPolicy, texts: list[str]) -> set[tuple[str, str, str]]:
    # Scan each complete saved message separately. Never combine fragments into
    # a spurious identifier, and never put matched PII values into tag metadata.
    found: set[tuple[str, str, str]] = set()
    patterns = [
        (
            source,
            [
                re.compile(r"(?<!\w)" + re.escape(normalized(alias)) + r"(?!\w)")
                for alias in [source.name, *source.aliases]
            ],
        )
        for source in policy.sources
    ]
    for raw in texts:
        value = normalized(raw)
        for source, aliases in patterns:
            if any(pattern.search(value) for pattern in aliases):
                found.add((f"suggested_{source.kind}", source.id, source.name))
        if policy.sensitive_tagging_enabled:
            if re.search(r"\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b", value):
                found.add(("suggested_sensitive", "ssn", SENSITIVE_LABELS["ssn"]))
            if re.search(r"\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b", value):
                found.add(("suggested_sensitive", "email", SENSITIVE_LABELS["email"]))
            for candidate in re.findall(r"(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)", value):
                digits = re.sub(r"\D", "", candidate)
                numbers = [int(d) for d in digits[::-1]]
                checksum = sum(
                    n if i % 2 == 0 else (2 * n - 9 if n > 4 else 2 * n)
                    for i, n in enumerate(numbers)
                )
                if len(set(digits)) > 1 and checksum % 10 == 0:
                    found.add(
                        ("suggested_sensitive", "payment_card", SENSITIVE_LABELS["payment_card"])
                    )
    return found


def scan_thread(store, thread, policy: TenantRetentionPolicy) -> int:
    if not policy.sources and not policy.sensitive_tagging_enabled:
        return 0
    texts = [thread.title, *[message.content for message in thread.messages]]
    existing = {
        (tag.namespace, tag.key)
        for tag in store.list_chat_thread_tags(tenant_id=thread.tenant_id, thread_id=thread.id)
    }
    applied = 0
    for namespace, key, label in detected_tags(policy, texts):
        confirmed = namespace.removeprefix("suggested_")
        if (
            (namespace, key) in existing
            or (confirmed, key) in existing
            or (f"dismissed_{confirmed}", key) in existing
        ):
            continue
        store.apply_chat_thread_tag(
            ChatThreadTag(
                id=f"tag-{uuid4()}",
                tenant_id=thread.tenant_id,
                thread_id=thread.id,
                namespace=namespace,
                key=key,
                value=label,
                source="auto",
                applied_at=clock.now(),
            )
        )
        applied += 1
    return applied


def decision(
    policy: TenantRetentionPolicy,
    row,
    tags,
    *,
    held: bool,
    matter_days: int | None = None,
    now: datetime | None = None,
) -> dict:
    now = now or clock.now()
    # Runtime connection/upload labels are factual. Model subjects and mention
    # candidates cannot establish a destructive retention rule without review.
    pairs = [
        (tag.namespace, tag.key)
        for tag in tags
        if not tag.namespace.startswith(("suggested_", "dismissed_"))
        and (tag.source in ("manual", "external") or tag.namespace in ("mcp", "attachments"))
    ]
    if row.matter_id:
        pairs.append(("matter", row.matter_id))
    days = effective_retention_days(policy, tags=pairs, matter_retention_days=matter_days)
    basis = row.created_at if policy.retention_basis == "created" else row.last_activity_at
    eligible = basis + timedelta(days=days) if days is not None and basis is not None else None
    pending = row.disposition_pending_since
    policy_time = (
        datetime.fromisoformat(policy.updated_at.replace("Z", "+00:00"))
        if policy.updated_at
        else None
    )
    if policy_time and policy_time.tzinfo is None:
        policy_time = policy_time.replace(tzinfo=UTC)
    # A policy revision always starts a fresh review window, even if a prior
    # policy had already queued the thread for deletion.
    review_start = (
        max(value for value in (pending, policy_time) if value is not None)
        if pending or policy_time
        else None
    )
    delete_at = review_start + timedelta(days=max(7, policy.grace_days)) if review_start else None
    eligible_now = bool(eligible and eligible <= now and not held)
    status = (
        "Legal hold"
        if held
        else "Keep"
        if eligible is None
        else "Awaiting automation"
        if not policy.automation_enabled
        else "Review window"
        if eligible_now
        else "Scheduled"
    )
    return {
        "eligible_at": eligible,
        "eligible": eligible_now,
        "held": held,
        "pending_since": pending,
        "delete_at": delete_at,
        "retention_status": status,
    }


def preview(store, policy: TenantRetentionPolicy) -> dict:
    decisions = store.application_state_repository.retention_overview(policy)
    current = store.tenant_retention_policy(policy.tenant_id)
    counts = {
        "total": len(decisions),
        "eligible": sum(item["eligible"] for item in decisions.values()),
        "held": sum(item["held"] for item in decisions.values()),
        "kept": sum(item["eligible_at"] is None for item in decisions.values()),
    }
    # Bind the approval to the exact policy, current revision, and current
    # candidate set. Concurrent changes require another preview.
    material = {
        "policy": policy.model_dump(mode="json"),
        "revision": current.updated_at,
        "eligible": sorted(key for key, value in decisions.items() if value["eligible"]),
        "held": sorted(key for key, value in decisions.items() if value["held"]),
    }
    token = hashlib.sha256(json.dumps(material, sort_keys=True).encode()).hexdigest()
    return {
        **counts,
        "preview_token": token,
        "review_days": max(7, policy.grace_days),
        "automation_enabled": policy.enabled and policy.automation_enabled,
    }


def retention_pass(store, now: datetime) -> dict[str, int]:
    """Bounded, rechecked disposition. Runs under the store's mutation lock."""
    result = {"deleted": 0, "reviewing": 0}
    with store._store_lock:
        snapshot = store.identity_config_repository.load_active_snapshot()
        if snapshot is None:
            return result
        for policy in snapshot.collections["tenant_retention_policies"]:
            if not policy.enabled or not policy.automation_enabled:
                continue
            decisions = store.application_state_repository.retention_overview(policy, now=now)
            for thread_id, info in decisions.items():
                if result["deleted"] + result["reviewing"] >= 100:
                    return result
                if not info["eligible"] and info["pending_since"] is None:
                    continue
                outcome = store.application_state_repository.dispose_retained_thread(
                    thread_id, policy, now
                )
                if outcome in result:
                    result[outcome] += 1
    return result
