"""Alert-rule evaluation over durable audit history.

Called synchronously from ``SeedStore.record_audit`` after the audit event has
been committed. Evaluation never sends email or records audit events. Alert
cooldowns and queued notifications are persisted directly in the application
database; delivery happens later in the scheduler.
"""

from __future__ import annotations

import logging
import re
from datetime import timedelta
from uuid import uuid4

from app.core.audit_severity import SEVERITY_LEVELS, classify_audit_event, severity_at_least
from app.core.dlp import DLP_RULES
from app.models.schemas import AlertNotification, AlertRule, AuditEvent
from app.repositories.application_state import ApplicationStateRepository

logger = logging.getLogger("aperture.alerting")

ALERT_NOTIFICATIONS_MAX = 2000

EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def validate_recipients(recipients: list[str]) -> list[str]:
    cleaned: list[str] = []
    for recipient in recipients:
        address = recipient.strip()
        if not address:
            continue
        if not EMAIL_PATTERN.match(address):
            raise ValueError(f"'{address}' is not a valid email address.")
        if address not in cleaned:
            cleaned.append(address)
    return cleaned


def validate_min_severity(value: str) -> str:
    severity = value.strip().lower()
    if severity not in SEVERITY_LEVELS:
        raise ValueError(f"min_severity must be one of {', '.join(SEVERITY_LEVELS)}.")
    return severity


def normalize_action_patterns(patterns: list[str]) -> list[str]:
    cleaned: list[str] = []
    for pattern in patterns:
        value = pattern.strip()
        if not value:
            continue
        if not re.fullmatch(r"[a-z0-9_.*-]+", value, flags=re.IGNORECASE):
            raise ValueError(f"'{value}' is not a valid action pattern.")
        if value not in cleaned:
            cleaned.append(value)
    return cleaned

PROMPT_FLAG_ACTION = "security.prompt_flagged"

# Prompt-security detections an alert rule can narrow to. Every id is a rule in
# app/core/dlp.py, so a rule can only target a detector that actually runs.
PROMPT_DETECTORS: dict[str, str] = {rule.id: rule.label for rule in DLP_RULES}
_PROMPT_DETECTOR_SEVERITY: dict[str, str] = {rule.id: rule.severity for rule in DLP_RULES}


def validate_detector_ids(
    detector_ids: list[str],
    *,
    action_patterns: list[str],
    min_severity: str,
) -> list[str]:
    """Reject detections that do not exist or that the rule could never see.

    A rule that narrows to detections but whose patterns exclude the prompt
    flag, or whose minimum severity sits above every chosen detector, would be
    saved as an alert that can never fire.
    """

    cleaned: list[str] = []
    for value in detector_ids:
        detector_id = value.strip()
        if not detector_id:
            continue
        if detector_id not in PROMPT_DETECTORS:
            raise ValueError(
                f"'{detector_id}' is not a prompt-security detection. "
                f"Choose from: {', '.join(PROMPT_DETECTORS)}."
            )
        if detector_id not in cleaned:
            cleaned.append(detector_id)
    if not cleaned:
        return cleaned
    if not matches_action_patterns(PROMPT_FLAG_ACTION, action_patterns):
        raise ValueError(
            f"Detections only apply to {PROMPT_FLAG_ACTION} events. Add "
            f"{PROMPT_FLAG_ACTION} or security.* to the action patterns, or clear the detections."
        )
    reachable = [
        classify_audit_event(
            PROMPT_FLAG_ACTION, {"severity": _PROMPT_DETECTOR_SEVERITY[detector_id]}
        )[0]
        for detector_id in cleaned
    ]
    if not any(severity_at_least(severity, min_severity) for severity in reachable):
        raise ValueError(
            "None of the chosen detections can reach the minimum severity "
            f"'{min_severity}'. Lower the minimum severity or choose other detections."
        )
    return cleaned


# Honest, user-visible templates the consoles offer as a one-click prefill —
# never auto-created server-side.
SUSPICIOUS_ACTIVITY_TEMPLATE = {
    "name": "Suspicious activity",
    "description": "Security flags, content-filter hits, and elevated-severity governance events.",
    "action_patterns": ["security.*"],
    "min_severity": "warning",
    "threshold_count": 1,
    "window_minutes": 60,
    "cooldown_minutes": 15,
}

PROMPT_INJECTION_TEMPLATE = {
    "name": "Prompt injection",
    "description": (
        "Prompts that try to override instructions, extract the system prompt, "
        "or pull platform credentials."
    ),
    "action_patterns": [PROMPT_FLAG_ACTION],
    "detector_ids": ["prompt-injection", "system-prompt-probe", "credential-probe"],
    "min_severity": "warning",
    "threshold_count": 1,
    "window_minutes": 60,
    "cooldown_minutes": 10,
}


def matches_action_patterns(action: str, patterns: list[str]) -> bool:
    if not patterns:
        return True
    for pattern in patterns:
        cleaned = pattern.strip()
        if not cleaned:
            continue
        if cleaned == "*":
            return True
        if cleaned.endswith(".*") and action.startswith(cleaned[:-1]):
            return True
        if cleaned.endswith("*") and action.startswith(cleaned[:-1]):
            return True
        if action == cleaned:
            return True
    return False


def _tenant_rule_can_see(rule: AlertRule, event: AuditEvent) -> bool:
    """Tenant rules mirror the admin audit trail exactly: same tenant, no
    platform.* actions, and never platform-owner activity."""
    if event.tenant_id is None or event.tenant_id != rule.tenant_id:
        return False
    if event.action.startswith("platform."):
        return False
    if event.actor_role == "PLATFORM_OWNER":
        return False
    return True


def _event_matches_rule(rule: AlertRule, event: AuditEvent, severity: str) -> bool:
    if rule.scope == "tenant" and not _tenant_rule_can_see(rule, event):
        return False
    if not matches_action_patterns(event.action, rule.action_patterns):
        return False
    if not severity_at_least(severity, rule.min_severity):
        return False
    if rule.actor_ids and event.actor_id not in rule.actor_ids:
        return False
    if rule.detector_ids and (
        event.action != PROMPT_FLAG_ACTION
        or event.metadata.get("rule_id") not in rule.detector_ids
    ):
        return False
    return True


def _repository(store) -> ApplicationStateRepository:
    repository = getattr(store, "application_state_repository", None)
    if not isinstance(repository, ApplicationStateRepository):
        raise RuntimeError("Application SQL state repository is not initialized.")
    return repository


def _count_matching_in_window(
    repository: ApplicationStateRepository,
    rule: AlertRule,
    event: AuditEvent,
) -> int:
    window_start = event.created_at - timedelta(minutes=rule.window_minutes)
    count = 0
    candidates = repository.list_audit(
        tenant_id=rule.tenant_id if rule.scope == "tenant" else None,
        tenant_visible=rule.scope == "tenant",
        created_from=window_start,
        created_through=event.created_at,
        newest_first=True,
    )
    for candidate in candidates:
        candidate_severity, _ = classify_audit_event(candidate.action, candidate.metadata)
        if _event_matches_rule(rule, candidate, candidate_severity):
            count += 1
    return count


def _metadata_text(event: AuditEvent, key: str) -> str:
    value = event.metadata.get(key)
    return value.strip() if isinstance(value, str) else ""


def _notification_summary(store, rule: AlertRule, event: AuditEvent) -> str:
    """Readable one-line context for the delivery log and the alert email.

    Built only from already-redacted audit fields. Prompt flags name the
    detection, surface, and model, never the flagged text itself.
    """

    if event.action == PROMPT_FLAG_ACTION and _metadata_text(event, "rule_label"):
        parts = [_metadata_text(event, "rule_label")]
        detector_severity = _metadata_text(event, "severity")
        if detector_severity:
            parts.append(f"{detector_severity} detector")
        surface = _metadata_text(event, "surface")
        if surface:
            parts.append(f"via {surface}")
        model_id = _metadata_text(event, "model_id")
        if model_id:
            parts.append(f"model {model_id}")
    else:
        parts = [event.action_type or event.action]
        target = event.target_name or event.target
        if target:
            parts.append(target)
        if event.detail:
            # detail is already redacted and capped at 200 chars by record_audit.
            parts.append(event.detail)
    if rule.scope == "platform" and event.tenant_id:
        # Owners watch every organization; name the one the event came from.
        tenant = getattr(store, "tenants", {}).get(event.tenant_id)
        parts.append(f"org {getattr(tenant, 'name', None) or event.tenant_id}")
    return " · ".join(parts)


def evaluate_audit_event(store, event: AuditEvent) -> list[AlertNotification]:
    """Match ``event`` against every enabled rule and queue notifications.

    Queue-only by design: no email, no audit records, and no JSON runtime-state
    saves. The re-entrancy flag is defense in depth so a future edit that
    audits from inside evaluation cannot recurse.
    """

    if getattr(store, "_evaluating_alerts", False):
        return []
    store._evaluating_alerts = True
    try:
        repository = _repository(store)
        created: list[AlertNotification] = []
        severity, _reason = classify_audit_event(event.action, event.metadata)
        for rule in list(store.alert_rules.values()):
            if not rule.enabled:
                continue
            if not _event_matches_rule(rule, event, severity):
                continue
            runtime = repository.get_alert_rule_runtime(rule.id)
            last_triggered_at = runtime.last_triggered_at if runtime is not None else None
            if last_triggered_at is not None and rule.cooldown_minutes > 0:
                cooldown_until = last_triggered_at + timedelta(minutes=rule.cooldown_minutes)
                if event.created_at < cooldown_until:
                    continue
            matched_count = 1
            if rule.threshold_count > 1:
                matched_count = _count_matching_in_window(repository, rule, event)
                if matched_count < rule.threshold_count:
                    continue
            notification = AlertNotification(
                id=f"alertnotif-{uuid4()}",
                rule_id=rule.id,
                rule_name=rule.name,
                scope=rule.scope,
                tenant_id=rule.tenant_id,
                event_id=event.id,
                event_action=event.action,
                event_severity=severity,
                actor_id=event.actor_id,
                actor_name=event.actor_name,
                summary=_notification_summary(store, rule, event),
                matched_count=matched_count,
                recipients=list(rule.recipients),
                status="queued" if rule.recipients else "logged",
                status_detail="" if rule.recipients else "No email recipients; logged in-app only.",
                created_at=event.created_at,
            )
            stored = repository.record_alert_trigger(
                notification,
                expected_last_triggered_at=last_triggered_at,
                last_triggered_at=event.created_at,
                max_records=ALERT_NOTIFICATIONS_MAX,
            )
            if stored is None:
                continue
            # Keep immediate rule responses truthful without making the JSON
            # config cache authoritative; SeedStore excludes this field from
            # v3 snapshots and rehydrates it from SQL on restart.
            rule.last_triggered_at = event.created_at
            created.append(stored)
        return created
    finally:
        store._evaluating_alerts = False
