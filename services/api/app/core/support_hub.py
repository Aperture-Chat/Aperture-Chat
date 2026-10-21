"""Community intake hub: receive reports from any deployment, file GitHub issues.

One deployment (the project's own, by default) turns this on in the owner
console and stores a GitHub token with Issues read/write on the project
repository. Every other deployment then shares reports with it over a small
public API, so no self-hosted install ever needs a GitHub credential:

* ``POST /api/support-hub/v1/reports`` accepts a redacted report and returns a
  receipt token. Reports land in a review queue (``pending``); security-type
  reports are held privately and are never published.
* ``GET /api/support-hub/v1/reports/{id}`` with ``Authorization: Bearer
  <receipt>`` returns only status: queue state, GitHub issue number/URL, and
  open/closed state. Only the token's SHA-256 is stored.
* Owners review the queue (optionally with AI triage: summary, labels, spam
  likelihood, duplicate detection against GitHub search), then publish as a
  new issue, add the report to an existing issue, or decline. With
  auto-publish on, clean reports are filed without review.

The public endpoint is the abuse surface, so it re-redacts every field,
accepts strict shapes only, rate-limits per sender address and per deployment
using durable counts, caps the pending queue, and neutralizes markdown before
anything reaches GitHub.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import re
import secrets
from datetime import timedelta
from typing import Any
from urllib.parse import quote

import httpx

from app.core import clock
from app.core.config import Settings
from app.core.support_upstream import (
    diagnostics_summary,
    format_github_issue,
    github_title,
    hub_diagnostics,
    redact_for_sharing,
)
from app.models.schemas import (
    SupportHubPublicStatus,
    SupportHubReceipt,
    SupportHubReport,
    SupportHubSubmission,
    SupportSettings,
    User,
)
from app.repositories.support_tickets import new_hub_report_id
from app.version import APP_VERSION

logger = logging.getLogger("aperture.support_hub")

GITHUB_API = "https://api.github.com"
SECRET_NAMESPACE = "support"
SECRET_RECORD = "github"

# Durable, per-window intake limits. Counts come from the queue table itself,
# so they survive restarts and apply across workers sharing the database.
SOURCE_LIMITS = ((timedelta(hours=1), 10), (timedelta(days=1), 30))
INSTANCE_LIMITS = ((timedelta(hours=1), 20), (timedelta(days=1), 60))
MAX_PENDING = 1000
ALLOWED_LABELS = frozenset({"bug", "enhancement", "question", "documentation", "feedback"})
AUTO_PUBLISH_MAX_SPAM = 0.4

_CONTROL_PATTERN = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class SupportHubRejected(Exception):
    """The hub refused a submission. ``status_code`` maps to the HTTP answer."""

    def __init__(self, message: str, *, status_code: int = 400, retry_after: int | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.retry_after = retry_after


class GitHubError(Exception):
    """A GitHub API call failed; the message is safe to show an owner."""


# --- Settings ----------------------------------------------------------------------


def hub_repository(support_settings: SupportSettings, settings: Settings) -> str:
    return (
        support_settings.hub_repository.strip().strip("/")
        or settings.platform_update_repository.strip().strip("/")
    )


def github_token(store) -> str | None:
    return store.configuration_secret(SECRET_NAMESPACE, SECRET_RECORD)


def accepting_reports(store) -> bool:
    return store.support_ticket_repository.get_settings().hub_enabled


# --- Intake ------------------------------------------------------------------------


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _source_hash(store, source: str) -> str:
    # Salted with this hub's random instance id so a leaked table does not
    # map back to sender IP addresses with a lookup table.
    salt = store.support_ticket_repository.get_settings().instance_id
    return _hash(f"{salt}:{source}")


def _clean(text: str) -> str:
    return _CONTROL_PATTERN.sub("", text or "").strip()


def receive_submission(
    store,
    settings: Settings,
    submission: SupportHubSubmission,
    *,
    source: str,
) -> SupportHubReceipt:
    """Validate, redact, rate-limit, and queue one report."""

    del settings
    repository = store.support_ticket_repository
    if not accepting_reports(store):
        raise SupportHubRejected(
            "This deployment does not accept community reports.", status_code=404
        )
    now = clock.now()
    local = source == "self"
    source_hash = None if local else _source_hash(store, source)
    if not local:
        for window, limit in SOURCE_LIMITS:
            if repository.count_hub_reports_since(since=now - window, source_hash=source_hash) >= limit:
                raise SupportHubRejected(
                    "Too many reports from this address. Try again later.",
                    status_code=429,
                    retry_after=int(window.total_seconds()),
                )
        for window, limit in INSTANCE_LIMITS:
            if (
                repository.count_hub_reports_since(
                    since=now - window, instance_id=submission.instance_id
                )
                >= limit
            ):
                raise SupportHubRejected(
                    "Too many reports from this deployment. Try again later.",
                    status_code=429,
                    retry_after=int(window.total_seconds()),
                )
        if repository.hub_status_counts().get("pending", 0) >= MAX_PENDING:
            raise SupportHubRejected(
                "The report queue is full. Try again later.", status_code=503, retry_after=3600
            )
    # Never trust a sender's redaction.
    title, _ = redact_for_sharing(" ".join(_clean(submission.title).split()))
    body, _ = redact_for_sharing(_clean(submission.body))
    if len(title) < 4 or len(body) < 10:
        raise SupportHubRejected("The report needs a title and a description.")
    token = secrets.token_urlsafe(32)
    report = repository.create_hub_report(
        SupportHubReport(
            id=new_hub_report_id(),
            receipt_hash=_hash(token),
            instance_id=submission.instance_id,
            instance_version=_clean(submission.instance_version)[:32],
            source_hash=source_hash,
            kind=submission.kind,
            priority=submission.priority,
            title=title[:200],
            body=body[:12000],
            diagnostics=hub_diagnostics(submission.diagnostics),
            status="private" if submission.kind == "security" else "pending",
            received_at=now,
            updated_at=now,
        )
    )
    return SupportHubReceipt(id=report.id, token=token, status=report.status)


def public_status(store, report_id: str, token: str) -> SupportHubPublicStatus | None:
    report = store.support_ticket_repository.get_hub_report(report_id)
    if report is None or not token or not hmac.compare_digest(report.receipt_hash, _hash(token)):
        return None
    return SupportHubPublicStatus(
        id=report.id,
        status=report.status,
        issue_number=report.issue_number,
        issue_url=report.issue_url,
        issue_state=report.issue_state,
        issue_state_reason=report.issue_state_reason,
        maintainer_note=report.maintainer_note if report.status in ("declined", "spam") else None,
        updated_at=report.updated_at,
    )


# --- GitHub ------------------------------------------------------------------------


class GitHubClient:
    def __init__(
        self,
        token: str | None,
        repository: str,
        *,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 15.0,
    ) -> None:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository or ""):
            raise GitHubError("The hub repository must look like owner/name.")
        self.repository = repository
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": f"aperture-chat/{APP_VERSION} (+support-hub)",
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self._client = httpx.Client(
            base_url=GITHUB_API,
            headers=headers,
            timeout=timeout,
            transport=transport,
            follow_redirects=False,
        )

    def __enter__(self) -> GitHubClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self._client.close()

    def _request(
        self, method: str, path: str, *, json: Any = None, params: dict[str, Any] | None = None
    ) -> Any:
        try:
            response = self._client.request(method, path, json=json, params=params)
        except httpx.HTTPError as exc:
            raise GitHubError("GitHub could not be reached.") from exc
        if response.status_code in (200, 201):
            return response.json()
        if response.status_code == 401:
            raise GitHubError("GitHub rejected the token. Paste a new one in Reports settings.")
        if response.status_code in (403, 429):
            if response.headers.get("x-ratelimit-remaining") == "0":
                raise GitHubError("GitHub's rate limit was reached. The hub retries later.")
            raise GitHubError(
                "The token can't do that. It needs Issues read and write on the repository."
            )
        if response.status_code == 404:
            raise GitHubError(f"GitHub could not find {self.repository} or that issue.")
        if response.status_code == 410:
            raise GitHubError("Issues are turned off on the repository.")
        if response.status_code == 422:
            raise GitHubError("GitHub rejected the issue text.")
        raise GitHubError(f"GitHub answered HTTP {response.status_code}.")

    def repository_info(self) -> dict[str, Any]:
        payload = self._request("GET", f"/repos/{self.repository}")
        return {
            "full_name": payload.get("full_name") or self.repository,
            "has_issues": bool(payload.get("has_issues", True)),
            "private": bool(payload.get("private", False)),
        }

    def create_issue(self, *, title: str, body: str, labels: list[str]) -> dict[str, Any]:
        payload = self._request(
            "POST",
            f"/repos/{self.repository}/issues",
            json={"title": title, "body": body, "labels": labels},
        )
        return _issue_fields(payload)

    def add_comment(self, number: int, body: str) -> None:
        self._request("POST", f"/repos/{self.repository}/issues/{number}/comments", json={"body": body})

    def get_issue(self, number: int) -> dict[str, Any]:
        payload = self._request("GET", f"/repos/{self.repository}/issues/{number}")
        if payload.get("pull_request"):
            raise GitHubError(f"#{number} is a pull request, not an issue.")
        return _issue_fields(payload)

    def search_issues(self, text: str, *, limit: int = 5) -> list[dict[str, Any]]:
        terms = _search_terms(text)
        if not terms:
            return []
        payload = self._request(
            "GET",
            "/search/issues",
            params={"q": f"{terms} repo:{self.repository} is:issue", "per_page": limit},
        )
        items = payload.get("items") if isinstance(payload, dict) else None
        return [_issue_fields(item) for item in (items or [])[:limit] if isinstance(item, dict)]


def _issue_fields(payload: dict[str, Any]) -> dict[str, Any]:
    url = payload.get("html_url")
    return {
        "number": payload.get("number") if isinstance(payload.get("number"), int) else None,
        "title": str(payload.get("title") or "")[:200],
        "state": payload.get("state") if payload.get("state") in ("open", "closed") else None,
        "state_reason": str(payload.get("state_reason") or "")[:32] or None,
        "url": url if isinstance(url, str) and url.startswith("https://github.com/") else None,
    }


_STOP_WORDS = frozenset(
    "the and for with that this from when what have does not into after before then "
    "there their your about while just like cannot can't doesn't won't still every".split()
)


def _search_terms(text: str) -> str:
    words = [
        word
        for word in re.findall(r"[A-Za-z][A-Za-z0-9]{3,}", re.sub(r"⟦\w+⟧", " ", text or ""))
        if word.lower() not in _STOP_WORDS
    ]
    unique: list[str] = []
    for word in words:
        if word.lower() not in {item.lower() for item in unique}:
            unique.append(word)
    return " ".join(unique[:6])


def github_client(store, settings: Settings, *, transport: httpx.BaseTransport | None = None) -> GitHubClient:
    support_settings = store.support_ticket_repository.get_settings()
    return GitHubClient(
        github_token(store),
        hub_repository(support_settings, settings),
        transport=transport,
        timeout=settings.support_hub_timeout_seconds,
    )


def _require_token(store) -> None:
    if not github_token(store):
        raise GitHubError("Add a GitHub token in Reports settings before publishing.")


# --- Maintainer actions --------------------------------------------------------------


def _issue_body(store, report: SupportHubReport, body: str) -> str:
    counts = store.support_ticket_repository.hub_instance_counts([report.instance_id])
    return format_github_issue(
        kind=report.kind,
        priority=report.priority,
        body=body,
        diagnostics=report.diagnostics,
        report_reference=report.id,
        deployment_reports=counts.get(report.instance_id, 1),
    )


def preview_issue(store, report: SupportHubReport) -> str:
    return _issue_body(store, report, report.body)


def publish(
    store,
    settings: Settings,
    report: SupportHubReport,
    *,
    actor_name: str,
    title: str,
    body: str,
    labels: list[str],
    transport: httpx.BaseTransport | None = None,
) -> SupportHubReport:
    if report.kind == "security" or report.status == "private":
        raise GitHubError("Security reports are never published as public issues.")
    if report.status in ("published", "linked"):
        raise GitHubError("This report is already on GitHub.")
    _require_token(store)
    safe_title, _ = redact_for_sharing(" ".join(title.split()))
    safe_body, _ = redact_for_sharing(body)
    chosen_labels = sorted({label for label in labels if label in ALLOWED_LABELS})
    with github_client(store, settings, transport=transport) as client:
        issue = client.create_issue(
            title=github_title(report.kind, safe_title),
            body=_issue_body(store, report, safe_body),
            labels=[*chosen_labels, "in-app report"],
        )
    now = clock.now()
    return store.support_ticket_repository.save_hub_report(
        report.model_copy(
            update={
                "status": "published",
                "title": safe_title[:200],
                "issue_number": issue["number"],
                "issue_url": issue["url"],
                "issue_state": issue["state"] or "open",
                "issue_state_reason": issue["state_reason"],
                "issue_checked_at": now,
                "reviewed_by_name": actor_name,
                "reviewed_at": now,
                "updated_at": now,
            }
        )
    )


def link_existing(
    store,
    settings: Settings,
    report: SupportHubReport,
    *,
    actor_name: str,
    issue_number: int,
    comment: str,
    transport: httpx.BaseTransport | None = None,
) -> SupportHubReport:
    if report.kind == "security" or report.status == "private":
        raise GitHubError("Security reports are never added to public issues.")
    _require_token(store)
    note, _ = redact_for_sharing(comment.strip())
    with github_client(store, settings, transport=transport) as client:
        issue = client.get_issue(issue_number)
        body = "Another deployment reported this through the in-app reporter.\n\n"
        if note:
            body += f"{note}\n\n"
        body += _issue_body(store, report, report.body)
        client.add_comment(issue_number, body)
    now = clock.now()
    return store.support_ticket_repository.save_hub_report(
        report.model_copy(
            update={
                "status": "linked",
                "issue_number": issue_number,
                "issue_url": issue["url"],
                "issue_state": issue["state"],
                "issue_state_reason": issue["state_reason"],
                "issue_checked_at": now,
                "reviewed_by_name": actor_name,
                "reviewed_at": now,
                "updated_at": now,
            }
        )
    )


def decline(
    store, report: SupportHubReport, *, actor_name: str, reason: str, spam: bool
) -> SupportHubReport:
    now = clock.now()
    note, _ = redact_for_sharing(" ".join(reason.split()))
    return store.support_ticket_repository.save_hub_report(
        report.model_copy(
            update={
                "status": "spam" if spam else "declined",
                # Sent back to the reporting deployment, so it stays redacted.
                "maintainer_note": note[:1000] or None,
                "reviewed_by_name": actor_name,
                "reviewed_at": now,
                "updated_at": now,
            }
        )
    )


def return_to_queue(store, report: SupportHubReport) -> SupportHubReport:
    if report.status not in ("declined", "spam"):
        raise GitHubError("Only declined reports can return to the queue.")
    return store.support_ticket_repository.save_hub_report(
        report.model_copy(
            update={
                "status": "private" if report.kind == "security" else "pending",
                "maintainer_note": None,
                "updated_at": clock.now(),
            }
        )
    )


def run_triage(
    store,
    settings: Settings,
    report: SupportHubReport,
    *,
    transport: httpx.BaseTransport | None = None,
) -> SupportHubReport:
    """Find likely duplicates and, with a model, summarize and label."""

    from app.core import support_ai

    support_settings = store.support_ticket_repository.get_settings()
    triage: dict[str, Any] = {"generated_at": clock.now().isoformat()}
    candidates: list[dict[str, Any]] = []
    try:
        with github_client(store, settings, transport=transport) as client:
            candidates = client.search_issues(f"{report.title} {report.body[:400]}")
    except GitHubError as exc:
        triage["search_error"] = str(exc)
    triage["candidates"] = candidates
    model = (
        support_ai.assistant_model(store, support_settings.ai_model_id)
        if support_settings.hub_ai_triage
        else None
    )
    if model is not None:
        try:
            triage.update(
                support_ai.triage_hub_report(
                    store,
                    model,
                    kind=report.kind,
                    title=report.title,
                    body=report.body,
                    diagnostics_summary=diagnostics_summary(report.diagnostics),
                    candidates=candidates,
                )
            )
        except support_ai.SupportAiError as exc:
            triage["ai_error"] = str(exc)
    return store.support_ticket_repository.save_hub_report(
        report.model_copy(update={"triage": triage, "updated_at": clock.now()})
    )


def sync_issue(
    store,
    settings: Settings,
    report: SupportHubReport,
    *,
    transport: httpx.BaseTransport | None = None,
) -> SupportHubReport:
    now = clock.now()
    if report.issue_number is None:
        return report
    try:
        with github_client(store, settings, transport=transport) as client:
            issue = client.get_issue(report.issue_number)
    except GitHubError as exc:
        logger.info("GitHub sync failed for %s: %s", report.id, exc)
        return store.support_ticket_repository.save_hub_report(
            report.model_copy(update={"issue_checked_at": now})
        )
    changed = (issue["state"], issue["state_reason"]) != (report.issue_state, report.issue_state_reason)
    return store.support_ticket_repository.save_hub_report(
        report.model_copy(
            update={
                "issue_state": issue["state"],
                "issue_state_reason": issue["state_reason"],
                "issue_url": issue["url"] or report.issue_url,
                "issue_checked_at": now,
                **({"updated_at": now} if changed else {}),
            }
        )
    )


def _auto_publishable(report: SupportHubReport, *, ai_required: bool) -> bool:
    if report.status != "pending" or report.kind == "security":
        return False
    triage = report.triage or {}
    if ai_required and "spam_likelihood" not in triage:
        return False
    return not (
        triage.get("security_sensitive")
        or triage.get("contains_sensitive_data")
        or triage.get("duplicate_of")
        or float(triage.get("spam_likelihood") or 0.0) > AUTO_PUBLISH_MAX_SPAM
    )


def support_hub_pass(
    store, settings: Settings, *, transport: httpx.BaseTransport | None = None
) -> None:
    repository = store.support_ticket_repository
    support_settings = repository.get_settings()
    if not support_settings.hub_enabled:
        return
    for report in repository.hub_reports_needing_triage(limit=2):
        try:
            run_triage(store, settings, report, transport=transport)
        except Exception:  # noqa: BLE001 - triage is advisory
            logger.exception("Hub triage failed for %s", report.id)
    if support_settings.hub_auto_publish and github_token(store):
        ai_required = bool(support_settings.hub_ai_triage and support_settings.ai_model_id)
        for report in repository.list_hub_reports(status="pending", limit=10):
            if report.triage is None or not _auto_publishable(report, ai_required=ai_required):
                continue
            try:
                publish(
                    store,
                    settings,
                    report,
                    actor_name="Auto-publish",
                    title=report.title,
                    body=report.body,
                    labels=list((report.triage or {}).get("labels") or [])
                    or {"bug": ["bug"], "feature": ["enhancement"], "question": ["question"]}.get(
                        report.kind, ["feedback"]
                    ),
                    transport=transport,
                )
            except GitHubError as exc:
                logger.info("Auto-publish failed for %s: %s", report.id, exc)
                break
    if github_token(store):
        now = clock.now()
        for report in repository.hub_reports_for_sync(
            checked_before=now - timedelta(seconds=settings.support_hub_github_sync_interval_seconds),
            limit=20,
        ):
            sync_issue(store, settings, report, transport=transport)


def audit_hub_action(store, actor: User, action: str, report: SupportHubReport, **extra: object) -> None:
    store.record_audit(
        actor,
        action,
        report.id,
        {
            "title": f"Community report {report.id[-8:]}",
            "kind": report.kind,
            "status": report.status,
            **({"issue_number": report.issue_number} if report.issue_number else {}),
            **extra,
        },
        runtime_state_changed=False,
    )


def issue_url_for(repository: str, number: int) -> str:
    return f"https://github.com/{quote(repository, safe='/')}/issues/{number}"
