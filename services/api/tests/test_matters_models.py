from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from app.models.matters import (
    DRAFT_SANITIZER_VERSION,
    MAX_DRAFT_CONTENT_BYTES,
    MAX_DRAFT_REVISIONS,
    MAX_MATTER_RETENTION_DAYS,
    DraftDocument,
    DraftRevision,
    DraftRevisionCapacity,
    DraftSnapshot,
    Matter,
    MatterDeletionJob,
    draft_content_sha256,
    sanitize_draft_html,
)


NOW = datetime(2026, 7, 20, 12, tzinfo=UTC)


def _matter(**overrides: object) -> Matter:
    values: dict[str, object] = {
        "id": "matter-a",
        "tenant_id": "tenant-a",
        "name": "Client  Matter\nOne",
        "retention_days": None,
        "created_by_user_id": "user-a",
        "version": 1,
        "created_at": NOW,
        "updated_at": NOW,
    }
    values.update(overrides)
    return Matter.model_validate(values)


def _revision(**overrides: object) -> DraftRevision:
    content = str(overrides.pop("content", "<p>Safe &amp; canonical.</p>"))
    values: dict[str, object] = {
        "draft_id": "draft-a",
        "tenant_id": "tenant-a",
        "owner_user_id": "user-a",
        "revision": 1,
        "title": "Draft A",
        "content": content,
        "content_sha256": draft_content_sha256(content),
        "sanitizer_version": DRAFT_SANITIZER_VERSION,
        "created_at": NOW,
    }
    values.update(overrides)
    return DraftRevision.model_validate(values)


def test_matter_retention_is_honest_nullable_metadata_only() -> None:
    assert _matter().retention_days is None
    assert _matter(retention_days=1).retention_days == 1
    assert _matter(retention_days=MAX_MATTER_RETENTION_DAYS).retention_days == (
        MAX_MATTER_RETENTION_DAYS
    )
    assert _matter().name == "Client Matter One"

    for invalid in (0, -1, MAX_MATTER_RETENTION_DAYS + 1, True, "30"):
        with pytest.raises(ValidationError):
            _matter(retention_days=invalid)


def test_matter_and_draft_models_reject_naive_or_backward_timestamps() -> None:
    with pytest.raises(ValidationError, match="timezone-aware"):
        _matter(created_at=NOW.replace(tzinfo=None))
    with pytest.raises(ValidationError, match="cannot precede"):
        _matter(updated_at=NOW - timedelta(seconds=1))

    with pytest.raises(ValidationError, match="cannot precede"):
        DraftDocument(
            id="draft-a",
            tenant_id="tenant-a",
            owner_user_id="user-a",
            title="Draft A",
            current_revision=1,
            created_at=NOW,
            updated_at=NOW - timedelta(seconds=1),
        )


def test_draft_html_sanitizer_is_canonical_idempotent_and_blocks_execution() -> None:
    raw = """
      <DIV onclick="steal()" STYLE="color: red; background-image: url(evil)">
        Hello &amp; <strong>safe</strong>
        <script><img src="/api/drafts/preserved-assets/inside-script"></script>
        <a href="javascript:alert(1)" target="_blank">bad link</a>
        <a href="https://example.com/path" target="_blank">safe link</a>
        <img src="https://tracker.example/pixel" onerror="steal()">
        <img src="/api/drafts/preserved-assets/image-1" alt="Saved image">
      </DIV>
    """
    sanitized = sanitize_draft_html(raw)

    assert "onclick" not in sanitized
    assert "script" not in sanitized
    assert "javascript" not in sanitized
    assert "tracker.example" not in sanitized
    assert "background-image" not in sanitized
    assert 'href="https://example.com/path"' in sanitized
    assert 'rel="noopener noreferrer"' in sanitized
    assert 'src="/api/drafts/preserved-assets/image-1"' in sanitized
    assert sanitize_draft_html(sanitized) == sanitized


def test_malformed_blocked_tag_nesting_fails_closed() -> None:
    malicious = (
        '<form><b></form><img src="/api/drafts/preserved-assets/should-not-return">'
        '<a href="https://example.com">also blocked</a>'
    )
    sanitized = sanitize_draft_html(malicious)
    assert sanitized == ""
    assert sanitize_draft_html(sanitized) == sanitized


def test_sanitizer_allows_only_bounded_inline_image_data() -> None:
    png = '<img src="data:image/png;base64,AAAA" alt="inline">'
    assert "data:image/png;base64,AAAA" in sanitize_draft_html(png)
    assert sanitize_draft_html('<img src="data:image/svg+xml;base64,PHN2Zz4=">') == "<img>"

    oversized = "é" * ((MAX_DRAFT_CONTENT_BYTES // 2) + 1)
    with pytest.raises(ValueError, match="UTF-8 bytes"):
        sanitize_draft_html(oversized)


def test_draft_revision_requires_canonical_content_and_matching_digest() -> None:
    revision = _revision()
    assert revision.content_sha256 == draft_content_sha256(revision.content)

    with pytest.raises(ValidationError, match="canonical sanitized HTML"):
        _revision(content='<p onclick="bad()">Not canonical</p>')
    with pytest.raises(ValidationError, match="digest"):
        _revision(content_sha256="0" * 64)
    with pytest.raises(ValidationError, match="sanitizer version"):
        _revision(sanitizer_version="sanitized-html-v2")


def test_draft_snapshot_rejects_cross_tenant_owner_or_revision_mismatch() -> None:
    document = DraftDocument(
        id="draft-a",
        tenant_id="tenant-a",
        owner_user_id="user-a",
        title="Draft A",
        current_revision=1,
        created_at=NOW,
        updated_at=NOW,
    )
    revision = _revision()
    assert DraftSnapshot(document=document, revision=revision).revision == revision

    with pytest.raises(ValidationError, match="inconsistent"):
        DraftSnapshot(
            document=document.model_copy(update={"current_revision": 2}),
            revision=revision,
        )


def test_draft_revision_capacity_is_a_hard_honest_bound() -> None:
    capacity = DraftRevisionCapacity(
        current_revision=MAX_DRAFT_REVISIONS,
        max_revisions=MAX_DRAFT_REVISIONS,
        remaining_revisions=0,
    )
    assert capacity.remaining_revisions == 0
    with pytest.raises(ValidationError):
        _revision(revision=MAX_DRAFT_REVISIONS + 1)
    with pytest.raises(ValidationError, match="inconsistent"):
        DraftRevisionCapacity(
            current_revision=1,
            max_revisions=MAX_DRAFT_REVISIONS,
            remaining_revisions=1,
        )


def test_matter_deletion_job_requires_restart_safe_stage_and_lease_state() -> None:
    pending = MatterDeletionJob(
        matter_id="matter-a",
        tenant_id="tenant-a",
        requested_by_user_id="user-a",
        requested_matter_version=1,
        status="pending",
        attempt_count=0,
        requested_at=NOW,
        updated_at=NOW,
    )
    running = pending.model_copy(
        update={
            "status": "running",
            "attempt_count": 1,
            "last_attempt_at": NOW,
            "lease_expires_at": NOW + timedelta(minutes=1),
        }
    )
    assert MatterDeletionJob.model_validate(running.model_dump()).status == "running"

    with pytest.raises(ValidationError, match="active lease"):
        MatterDeletionJob.model_validate(
            pending.model_copy(update={"status": "running"}).model_dump()
        )
    with pytest.raises(ValidationError, match="bounded error stage"):
        MatterDeletionJob.model_validate(
            pending.model_copy(update={"status": "failed", "attempt_count": 1}).model_dump()
        )
    with pytest.raises(ValidationError, match="every cleanup stage"):
        MatterDeletionJob.model_validate(
            pending.model_copy(update={"status": "ready", "attempt_count": 1}).model_dump()
        )

    cleared = running.model_copy(
        update={
            "status": "ready",
            "lease_expires_at": None,
            "application_refs_cleared_at": NOW,
            "review_refs_cleared_at": NOW,
            "knowledge_refs_cleared_at": NOW,
            "legacy_refs_cleared_at": NOW,
        }
    )
    ready = MatterDeletionJob.model_validate(cleared.model_dump())
    assert ready.all_references_cleared is True
    complete = ready.model_copy(update={"status": "complete", "completed_at": NOW})
    assert MatterDeletionJob.model_validate(complete.model_dump()).status == "complete"
