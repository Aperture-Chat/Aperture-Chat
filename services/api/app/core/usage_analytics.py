"""Pure aggregation over durable usage records, shared by admin and platform routes.

Token sums are ``None`` (never zero) when no record in scope carried
provider-reported tokens, and ``tokens_reported_messages`` states how much of
the message volume has real token data behind it.
"""

from __future__ import annotations

from typing import Any

from app.models.schemas import UsageRecord


def filter_usage_records(
    records: list[UsageRecord],
    *,
    tenant_id: str | None = None,
    visible_user_ids: set[str] | None = None,
    user_id: str | None = None,
    from_date: str | None = None,
    through_date: str | None = None,
) -> list[UsageRecord]:
    """Scope records by tenant, visibility, user, and inclusive ISO date bounds."""

    selected: list[UsageRecord] = []
    for record in records:
        if tenant_id is not None and record.tenant_id != tenant_id:
            continue
        if visible_user_ids is not None and record.user_id not in visible_user_ids:
            continue
        if user_id is not None and record.user_id != user_id:
            continue
        record_date = record.created_at.date().isoformat()
        if from_date and record_date < from_date:
            continue
        if through_date and record_date > through_date:
            continue
        selected.append(record)
    return selected


def _sum_tokens(records: list[UsageRecord], field: str) -> int | None:
    values = [getattr(record, field) for record in records]
    reported = [value for value in values if value is not None]
    return sum(reported) if reported else None


def _tokens_reported(record: UsageRecord) -> bool:
    return any(
        value is not None
        for value in (record.prompt_tokens, record.completion_tokens, record.total_tokens)
    )


def build_usage_summary(records: list[UsageRecord]) -> dict[str, Any]:
    total_messages = sum(record.message_count for record in records)

    by_user: dict[str, dict[str, Any]] = {}
    by_model: dict[str, dict[str, Any]] = {}
    by_day: dict[str, dict[str, Any]] = {}
    by_surface: dict[str, int] = {}

    for record in records:
        created_iso = record.created_at.isoformat()

        user_row = by_user.setdefault(
            record.user_id,
            {
                "user_id": record.user_id,
                "user_name": record.user_name,
                "user_role": record.user_role,
                "message_count": 0,
                "prompt_tokens": None,
                "completion_tokens": None,
                "total_tokens": None,
                "models": set(),
                "surfaces": set(),
                "last_active_at": created_iso,
            },
        )
        user_row["message_count"] += record.message_count
        if record.user_name:
            user_row["user_name"] = record.user_name
        if record.user_role:
            user_row["user_role"] = record.user_role
        user_row["models"].add(record.model_id)
        user_row["surfaces"].add(record.surface)
        if created_iso > user_row["last_active_at"]:
            user_row["last_active_at"] = created_iso
        for field in ("prompt_tokens", "completion_tokens", "total_tokens"):
            value = getattr(record, field)
            if value is not None:
                user_row[field] = (user_row[field] or 0) + value

        model_row = by_model.setdefault(
            record.model_id,
            {
                "model_id": record.model_id,
                "provider_name": record.provider_name,
                "message_count": 0,
                "prompt_tokens": None,
                "completion_tokens": None,
                "total_tokens": None,
                "users": set(),
                "last_used_at": created_iso,
            },
        )
        model_row["message_count"] += record.message_count
        if record.provider_name:
            model_row["provider_name"] = record.provider_name
        model_row["users"].add(record.user_id)
        if created_iso > model_row["last_used_at"]:
            model_row["last_used_at"] = created_iso
        for field in ("prompt_tokens", "completion_tokens", "total_tokens"):
            value = getattr(record, field)
            if value is not None:
                model_row[field] = (model_row[field] or 0) + value

        day = record.created_at.date().isoformat()
        day_row = by_day.setdefault(day, {"date": day, "message_count": 0, "total_tokens": None})
        day_row["message_count"] += record.message_count
        if record.total_tokens is not None:
            day_row["total_tokens"] = (day_row["total_tokens"] or 0) + record.total_tokens

        by_surface[record.surface] = by_surface.get(record.surface, 0) + record.message_count

    user_rows = sorted(by_user.values(), key=lambda row: (-row["message_count"], row["user_name"]))
    for row in user_rows:
        row["model_count"] = len(row.pop("models"))
        row["surfaces"] = sorted(row["surfaces"])

    model_rows = sorted(by_model.values(), key=lambda row: (-row["message_count"], row["model_id"]))
    for row in model_rows:
        row["user_count"] = len(row.pop("users"))

    return {
        "totals": {
            "messages": total_messages,
            "prompt_tokens": _sum_tokens(records, "prompt_tokens"),
            "completion_tokens": _sum_tokens(records, "completion_tokens"),
            "total_tokens": _sum_tokens(records, "total_tokens"),
            "active_users": len(by_user),
            "models_used": len(by_model),
            "tokens_reported_messages": sum(
                record.message_count for record in records if _tokens_reported(record)
            ),
        },
        "by_user": user_rows,
        "by_model": model_rows,
        "by_day": sorted(by_day.values(), key=lambda row: row["date"]),
        "by_surface": sorted(
            ({"surface": surface, "message_count": count} for surface, count in by_surface.items()),
            key=lambda row: (-row["message_count"], row["surface"]),
        ),
        "backfilled_record_count": sum(1 for record in records if record.source == "backfill"),
    }
