"""Transparent rule-based severity classification for audit events.

Severity is derived on read (never stored) so the taxonomy can evolve without
migrating persisted events. Rules are an ordered table — first match wins —
and every classification carries a human-readable reason so admin and owner
audit surfaces can show *why* an event was flagged instead of presenting an
opaque score.
"""

from __future__ import annotations

from collections.abc import Mapping

SEVERITY_INFO = "info"
SEVERITY_WARNING = "warning"
SEVERITY_CRITICAL = "critical"
SEVERITY_LEVELS: tuple[str, ...] = (SEVERITY_INFO, SEVERITY_WARNING, SEVERITY_CRITICAL)

_SEVERITY_RANK = {level: rank for rank, level in enumerate(SEVERITY_LEVELS)}

Metadata = Mapping[str, object]


def severity_at_least(value: str, minimum: str) -> bool:
    return _SEVERITY_RANK.get(value, 0) >= _SEVERITY_RANK.get(minimum, 0)


def _role_changed(metadata: Metadata) -> bool:
    changed = metadata.get("changed")
    return isinstance(changed, list) and "role" in changed


def _prompt_flag_high(metadata: Metadata) -> bool:
    return str(metadata.get("severity", "")).lower() == "high"


_CRITICAL_ACTIONS: dict[str, str] = {
    "platform.provider_key_revealed": "A stored provider key secret was revealed.",
    "platform.provider_key_deleted": "A provider key was deleted.",
    "platform.provider_key_rejected": "A provider key was rejected during validation.",
    "admin.user_deleted": "A user account was permanently deleted.",
    "admin.password_reset": "An account password was reset by an administrator.",
    "admin.sso_config_created": "Single sign-on configuration was created.",
    "admin.sso_config_updated": "Single sign-on configuration was changed.",
    "admin.sso_config_deleted": "Single sign-on configuration was removed.",
    "security.content_filter_blocked": "A prompt was blocked by a content filter.",
    "auth.bootstrap_owner_created": "A platform owner account was bootstrapped.",
}

_WARNING_ACTIONS: dict[str, str] = {
    "admin.user_deactivated": "A user account was deactivated.",
    "scim.user_deactivated": "A user account was deactivated via SCIM.",
    "admin.model_access_updated": "Model access grants were changed.",
    "admin.content_filter_created": "A content filter rule was created.",
    "admin.content_filter_updated": "A content filter rule was changed.",
    "admin.model_content_filters_updated": "Model content-filter assignments were changed.",
    "platform.settings_updated": "Platform settings were changed.",
    "platform.email_settings_updated": "Alert email (SMTP) settings were changed.",
    "auth.api_key_created": "A personal API key was created.",
    "auth.api_key_rotated": "A personal API key was rotated.",
    "auth.api_key_revoked": "A personal API key was revoked.",
    "security.content_filter_redacted": "A prompt was redacted by a content filter.",
    "automation.run_failed": "A scheduled automation run failed.",
    "automation.run_skipped": "A scheduled automation run was skipped.",
    "chat.completion_refused": "A chat request was refused before any provider call ran.",
}

_INFO_SECURITY_ACTIONS = {"security.alert_acknowledged", "security.alert_reopened"}

# Suffixes that mark destructive or failing governance events regardless of
# namespace, so newly added actions degrade to a sensible severity.
_WARNING_SUFFIXES: tuple[tuple[str, str], ...] = (
    ("_deleted", "A governed resource was deleted."),
    ("_sync_failed", "A provider or catalog sync failed."),
    ("_validation_failed", "Runtime validation failed."),
    ("_failed", "An operation failed."),
)


def classify_audit_event(action: str, metadata: Metadata | None = None) -> tuple[str, str]:
    """Return ``(severity, reason)`` for an audit action.

    Ordered rules, first match wins; unknown actions are routine ``info``.
    """

    metadata = metadata or {}

    if action == "admin.user_updated" and _role_changed(metadata):
        return SEVERITY_CRITICAL, "A user's role was changed (possible privilege escalation)."
    if action == "security.prompt_flagged":
        if _prompt_flag_high(metadata):
            return SEVERITY_CRITICAL, "A prompt was flagged by a high-severity security rule."
        return SEVERITY_WARNING, "A prompt was flagged by a security rule."

    reason = _CRITICAL_ACTIONS.get(action)
    if reason:
        return SEVERITY_CRITICAL, reason

    reason = _WARNING_ACTIONS.get(action)
    if reason:
        return SEVERITY_WARNING, reason

    if action.startswith("security.") and action not in _INFO_SECURITY_ACTIONS:
        return SEVERITY_WARNING, "Security subsystem activity."

    for suffix, suffix_reason in _WARNING_SUFFIXES:
        if action.endswith(suffix):
            return SEVERITY_WARNING, suffix_reason

    return SEVERITY_INFO, "No elevated rule matched; routine activity."


def decorate_audit_events(events: list) -> list:
    """Return copies decorated with derived severity fields."""

    decorated = []
    for event in events:
        severity, reason = classify_audit_event(event.action, event.metadata)
        decorated.append(
            event.model_copy(
                update={"severity": severity, "severity_reason": reason}
            )
        )
    return decorated


__all__ = [
    "SEVERITY_LEVELS",
    "SEVERITY_INFO",
    "SEVERITY_WARNING",
    "SEVERITY_CRITICAL",
    "classify_audit_event",
    "decorate_audit_events",
    "severity_at_least",
]
