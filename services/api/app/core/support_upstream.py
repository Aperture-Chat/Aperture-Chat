"""Share support tickets with the Aperture Chat community intake hub.

Any deployment, self-hosted or not, can send a ticket upstream so it becomes a
GitHub issue on the project repository without holding a GitHub credential:

1. An owner (or, in Automatic mode, the scheduler) builds a share draft. The
   text is redacted here first: personal data, known people and organization
   names, private links and hosts, home-directory paths, and token-like
   strings are replaced with typed placeholders.
2. The deployment POSTs the draft to ``{support_hub_url}/api/support-hub/v1``.
   The hub re-redacts it (it never trusts a sender), queues it for maintainer
   review, and returns a receipt token that only lets this deployment read the
   report's status.
3. The scheduler polls the hub with that receipt and copies the GitHub issue
   number and open/closed state back onto the local ticket, posting a timeline
   entry the reporter can read.

Security-type tickets are never shared; those belong in a private advisory.
Screenshots never leave the deployment. When this deployment *is* the hub, the
same flow runs in-process instead of over HTTP.
"""

from __future__ import annotations

import logging
import re
import threading
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import quote, urlencode, urlsplit

import httpx

from app.core import clock
from app.core.config import Settings
from app.core.net_guard import EgressBlocked, validate_public_url
from app.core.personal_data import conceal, conceal_names, token
from app.models.schemas import (
    IssueReportEvent,
    IssueReportRecord,
    IssueReportUpstream,
    IssueReportUpstreamDraft,
    SupportHubPublicStatus,
    SupportHubReceipt,
    SupportHubSubmission,
    SupportSettings,
)
from app.repositories.support_tickets import new_event_id
from app.version import APP_VERSION

logger = logging.getLogger("aperture.support_upstream")

HUB_API_PREFIX = "/api/support-hub/v1"
MAINTAINERS_NAME = "Aperture Chat maintainers"
SECURITY_ADVISORY_PATH = "security/advisories/new"

KIND_LABELS = {
    "bug": "Problem",
    "feature": "Idea",
    "question": "Question",
    "feedback": "Feedback",
    "security": "Security concern",
}
PRIORITY_LABELS = {"low": "Low", "normal": "Normal", "high": "High", "urgent": "Urgent"}
ROLE_LABELS = {
    "USER": "User",
    "POWER_USER": "Power user",
    "TEMP_USER": "Temporary user",
    "AUDITOR": "Auditor",
    "AGENT_APPROVER": "Agent approver",
    "TENANT_ADMIN": "Tenant admin",
    "PLATFORM_OWNER": "Platform owner",
}
GITHUB_LABELS = {
    "bug": ["bug"],
    "feature": ["enhancement"],
    "question": ["question"],
    "feedback": ["feedback"],
}
_TITLE_PREFIXES = {"bug": "[Bug]: ", "feature": "[Feature]: ", "question": "[Question]: ", "feedback": "[Feedback]: "}

# Retry schedule for a send that failed (network, hub outage, rate limit).
_RETRY_DELAYS_SECONDS = (60, 300, 1800, 7200, 21600, 86400)
MAX_SEND_ATTEMPTS = 8

# Only these hosts survive redaction in shared text; every other link could
# point at a private deployment or document.
PUBLIC_HOSTS = frozenset(
    {"github.com", "www.github.com", "aperturechat.com", "www.aperturechat.com"}
)

_URL_PATTERN = re.compile(r"\b(?:https?://|www\.)[^\s<>()\[\]{}\"'`]+", re.IGNORECASE)
_PRIVATE_HOST_PATTERN = re.compile(
    r"\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
    r"(?:local|lan|internal|intranet|corp|home|localdomain|localhost)\b",
    re.IGNORECASE,
)
_USER_PATH_PATTERN = re.compile(r"(/Users/|/home/|[A-Za-z]:\\Users\\)([^/\\\s]+)")
# Long mixed letter/digit runs: session tokens, keys, signed URLs.
_TOKEN_PATTERN = re.compile(
    r"(?<![\w-])(?=[A-Za-z0-9_\-]*\d)(?=[A-Za-z0-9_\-]*[A-Za-z])[A-Za-z0-9_\-]{32,}(?![\w-])"
)
_ID_SEGMENT_PATTERN = re.compile(
    r"^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    r"|[a-z]+-[0-9a-z-]{6,}|[0-9a-z_-]*\d[0-9a-z_-]{5,}|\d+)$",
    re.IGNORECASE,
)

_send_lock = threading.Lock()


class SupportUpstreamError(Exception):
    """Sharing failed; the message is safe to show an owner."""


# --- Redaction -----------------------------------------------------------------


def redaction_terms(store, report: IssueReportRecord) -> tuple[list[str], list[str]]:
    """People and organization names this deployment knows about."""

    people: list[str] = [report.user_name]
    organizations: list[str] = []
    for user in list(store.users.values())[:5000]:
        if user.tenant_id != report.tenant_id and user.id != report.assignee_user_id:
            continue
        people.extend(
            name for name in (user.display_name, user.first_name, user.last_name) if name
        )
        if user.firm_name:
            organizations.append(user.firm_name)
    for tenant in store.tenants.values():
        organizations.append(tenant.name)
        brand = getattr(tenant, "chat_brand_name", None)
        if brand and brand.strip().casefold() != "aperture chat":
            organizations.append(brand)
    return [name for name in people if name], [name for name in organizations if name]


def own_hosts(settings: Settings) -> list[str]:
    hosts: list[str] = []
    for origin in settings.web_origin_list:
        host = (urlsplit(origin).hostname or "").lower()
        if host and host not in PUBLIC_HOSTS and host not in {"localhost", "127.0.0.1"}:
            hosts.append(host)
    return hosts


def redact_for_sharing(
    text: str,
    *,
    people: list[str] = (),  # type: ignore[assignment]
    organizations: list[str] = (),  # type: ignore[assignment]
    hosts: list[str] = (),  # type: ignore[assignment]
) -> tuple[str, int]:
    """Replace anything that could identify a person or deployment.

    Returns the redacted text and how many values were replaced. Placeholders
    use the same ``⟦LABEL⟧`` tokens as the privacy policy.
    """

    if not text:
        return "", 0
    concealed = conceal(text)
    result = concealed.text
    count = sum(concealed.counts.values())
    named = conceal_names(
        result,
        [(name, "NAME") for name in people] + [(name, "ORGANIZATION") for name in organizations],
    )
    result = named.text
    count += sum(named.counts.values())

    def replace_url(match: re.Match[str]) -> str:
        nonlocal count
        raw = match.group(0)
        candidate = raw if "://" in raw else f"https://{raw}"
        host = (urlsplit(candidate).hostname or "").lower()
        if host in PUBLIC_HOSTS:
            return raw
        count += 1
        return token("LINK")

    result = _URL_PATTERN.sub(replace_url, result)
    for host in sorted({host for host in hosts if host}, key=len, reverse=True):
        result, replaced = re.subn(rf"(?<![\w.-]){re.escape(host)}(?![\w-])", token("HOST"), result, flags=re.IGNORECASE)
        count += replaced
    result, replaced = _PRIVATE_HOST_PATTERN.subn(token("HOST"), result)
    count += replaced
    result, replaced = _USER_PATH_PATTERN.subn(lambda m: f"{m.group(1)}{token('USER')}", result)
    count += replaced
    result, replaced = _TOKEN_PATTERN.subn(token("TOKEN"), result)
    count += replaced
    return result, count


# --- Diagnostics -----------------------------------------------------------------


def _clip(value: Any, limit: int) -> str:
    return " ".join(str(value).split())[:limit] if isinstance(value, str | int | float) else ""


def normalize_route(path: Any) -> str:
    """``/chat/thread-4f2a…`` becomes ``/chat/:id``; queries never survive."""

    text = _clip(path, 300).split("?", 1)[0].split("#", 1)[0]
    if not text.startswith("/"):
        return ""
    segments = [
        ":id" if _ID_SEGMENT_PATTERN.match(segment) else segment[:40]
        for segment in text.split("/")
        if segment
    ]
    return "/" + "/".join(segments[:6])


def describe_user_agent(user_agent: str) -> tuple[str, str]:
    ua = user_agent or ""
    browser = ""
    for pattern, name in (
        (r"Edg/(\d+)", "Edge"),
        (r"OPR/(\d+)", "Opera"),
        (r"Firefox/(\d+)", "Firefox"),
        (r"Chrome/(\d+)", "Chrome"),
        (r"Version/(\d+)[\d.]* (?:Mobile/\S+ )?Safari/", "Safari"),
    ):
        match = re.search(pattern, ua)
        if match:
            browser = f"{name} {match.group(1)}"
            break
    os_name = ""
    for pattern, name in (
        (r"iPhone|iPad|iPod", "iOS"),
        (r"Android", "Android"),
        (r"CrOS", "ChromeOS"),
        (r"Windows NT", "Windows"),
        (r"Mac OS X|Macintosh", "macOS"),
        (r"Linux", "Linux"),
    ):
        if re.search(pattern, ua):
            os_name = name
            break
    return browser, os_name


def clean_client_diagnostics(raw: Any) -> dict[str, Any] | None:
    """Bound and shape what the browser sent; unknown keys are dropped."""

    if not isinstance(raw, dict):
        return None
    cleaned: dict[str, Any] = {}
    for key, limit in (
        ("route", 300),
        ("view", 40),
        ("viewport", 20),
        ("language", 20),
        ("timezone", 60),
        ("color_scheme", 10),
        ("user_agent", 400),
    ):
        value = _clip(raw.get(key), limit)
        if value:
            cleaned[key] = value
    if isinstance(raw.get("pixel_ratio"), int | float):
        cleaned["pixel_ratio"] = round(float(raw["pixel_ratio"]), 2)
    if isinstance(raw.get("online"), bool):
        cleaned["online"] = raw["online"]
    errors = []
    for item in raw.get("recent_errors") or []:
        if isinstance(item, dict) and _clip(item.get("message"), 300):
            errors.append(
                {
                    "message": _clip(item.get("message"), 300),
                    "source": _clip(item.get("source"), 120),
                    "at": _clip(item.get("at"), 40),
                }
            )
    if errors:
        cleaned["recent_errors"] = errors[-8:]
    failures = []
    for item in raw.get("failed_requests") or []:
        if not isinstance(item, dict):
            continue
        status = item.get("status")
        failures.append(
            {
                "method": _clip(item.get("method"), 8).upper(),
                "path": normalize_route(item.get("path")) or "",
                "status": status if isinstance(status, int) else 0,
                "at": _clip(item.get("at"), 40),
            }
        )
    if failures:
        cleaned["failed_requests"] = failures[-10:]
    return cleaned or None


def shareable_diagnostics(
    report: IssueReportRecord, *, people: list[str], organizations: list[str], hosts: list[str]
) -> dict[str, Any]:
    """The technical subset that may leave the deployment, redacted."""

    diagnostics = report.diagnostics or {}
    shared: dict[str, Any] = {"app_version": diagnostics.get("app_version") or APP_VERSION}
    if diagnostics.get("reporter_role"):
        shared["reporter_role"] = diagnostics["reporter_role"]
    route = normalize_route(diagnostics.get("route"))
    if route:
        shared["area"] = route
    browser, os_name = describe_user_agent(str(diagnostics.get("user_agent") or ""))
    if browser:
        shared["browser"] = browser
    if os_name:
        shared["os"] = os_name
    for key in ("viewport", "color_scheme"):
        if diagnostics.get(key):
            shared[key] = diagnostics[key]
    errors = []
    for item in diagnostics.get("recent_errors") or []:
        message, _ = redact_for_sharing(
            str(item.get("message") or ""), people=people, organizations=organizations, hosts=hosts
        )
        if message:
            errors.append(message[:300])
    if errors:
        shared["recent_errors"] = errors[-5:]
    failures = [
        f"{item.get('method', '')} {item.get('path', '')} → {item.get('status', 0)}".strip()
        for item in diagnostics.get("failed_requests") or []
        if item.get("path")
    ]
    if failures:
        shared["failed_requests"] = failures[-6:]
    return shared


def hub_diagnostics(raw: Any) -> dict[str, Any] | None:
    """Hub-side allowlist for diagnostics received from another deployment."""

    if not isinstance(raw, dict):
        return None
    cleaned: dict[str, Any] = {}
    for key in ("app_version", "reporter_role", "browser", "os", "viewport", "color_scheme"):
        value = _clip(raw.get(key), 60)
        if value:
            cleaned[key] = value
    area = normalize_route(raw.get("area"))
    if area:
        cleaned["area"] = area
    for key, limit in (("recent_errors", 5), ("failed_requests", 6)):
        values = [
            _clip(item, 300) for item in (raw.get(key) or []) if isinstance(item, str)
        ]
        values = [value for value in values if value]
        if values:
            cleaned[key] = values[-limit:]
    return cleaned or None


def diagnostics_summary(diagnostics: dict[str, Any] | None) -> str:
    if not diagnostics:
        return ""
    parts = []
    if diagnostics.get("app_version"):
        parts.append(f"Aperture Chat {diagnostics['app_version']}")
    browser = " on ".join(
        value for value in (diagnostics.get("browser"), diagnostics.get("os")) if value
    )
    if browser:
        parts.append(browser)
    if diagnostics.get("area"):
        parts.append(f"area {diagnostics['area']}")
    if diagnostics.get("reporter_role"):
        parts.append(f"role {diagnostics['reporter_role']}")
    return ", ".join(parts)


# --- GitHub issue formatting (shared with the hub) --------------------------------

_MENTION_PATTERN = re.compile(r"(?<![\w`])@(?=[A-Za-z0-9])")
_ISSUE_REF_PATTERN = re.compile(r"(?<![\w&/])#(?=\d)")


def neutralize_markdown(text: str) -> str:
    """Make sender text inert on GitHub.

    No raw HTML (tracking images, hidden comments), no @mentions that ping
    people, and no #123 references that spam other issues' timelines.
    """

    escaped = (text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    escaped = _MENTION_PATTERN.sub("@​", escaped)
    return _ISSUE_REF_PATTERN.sub("#​", escaped)


def github_title(kind: str, title: str) -> str:
    prefix = _TITLE_PREFIXES.get(kind, "")
    cleaned = " ".join((title or "").split())
    if prefix and cleaned.lower().startswith(prefix.lower().strip()):
        return cleaned[:240]
    return f"{prefix}{cleaned}"[:240]


def format_github_issue(
    *,
    kind: str,
    priority: str,
    body: str,
    diagnostics: dict[str, Any] | None,
    report_reference: str = "",
    deployment_reports: int = 1,
) -> str:
    lines = [neutralize_markdown(body.strip()), "", "---", ""]
    details = [f"**Type:** {KIND_LABELS.get(kind, kind)}"]
    if priority and priority != "normal":
        details.append(f"**Reported impact:** {PRIORITY_LABELS.get(priority, priority)}")
    lines.append(" · ".join(details))
    if diagnostics:
        environment = []
        if diagnostics.get("app_version"):
            environment.append(f"- Version: `{neutralize_markdown(str(diagnostics['app_version']))}`")
        if diagnostics.get("area"):
            environment.append(f"- Area: `{neutralize_markdown(str(diagnostics['area']))}`")
        browser = " on ".join(
            neutralize_markdown(str(value))
            for value in (diagnostics.get("browser"), diagnostics.get("os"))
            if value
        )
        if browser:
            environment.append(f"- Browser: {browser}")
        if diagnostics.get("viewport"):
            environment.append(f"- Window: {neutralize_markdown(str(diagnostics['viewport']))}")
        if diagnostics.get("reporter_role"):
            role = str(diagnostics["reporter_role"])
            environment.append(f"- Affected role: {neutralize_markdown(ROLE_LABELS.get(role, role))}")
        if environment:
            lines.extend(["", "**Environment**", *environment])
        for key, heading in (
            ("recent_errors", "Recent browser errors"),
            ("failed_requests", "Recent failed requests"),
        ):
            values = diagnostics.get(key) or []
            if values:
                lines.extend(["", f"**{heading}**", "```text"])
                lines.extend(str(value).replace("```", "'''") for value in values)
                lines.append("```")
    footer = (
        "_Sent from a deployment's in-app reporter through the Aperture Chat community "
        "hub. Personal and deployment details were removed before sending; screenshots "
        "stay on the reporting deployment._"
    )
    if deployment_reports > 1:
        footer += f" _This deployment has sent {deployment_reports} reports._"
    if report_reference:
        footer += f" _Hub reference: `{report_reference}`._"
    lines.extend(["", footer])
    return "\n".join(lines).strip() + "\n"


def github_new_issue_url(
    repository: str,
    *,
    kind: str,
    title: str,
    body: str,
    diagnostics: dict[str, Any] | None,
) -> str:
    """A prefilled issue-form link that needs no hub and no credential."""

    base = f"https://github.com/{repository.strip('/')}/issues/new"
    if kind == "security":
        return f"https://github.com/{repository.strip('/')}/{SECURITY_ADVISORY_PATH}"
    diagnostics = diagnostics or {}
    version = str(diagnostics.get("app_version") or "")
    environment = diagnostics_summary(diagnostics)
    body = body[:4000]
    if kind == "bug":
        role = {
            "USER": "User",
            "POWER_USER": "User",
            "TENANT_ADMIN": "Tenant admin",
            "PLATFORM_OWNER": "Platform owner",
        }.get(str(diagnostics.get("reporter_role") or ""), "Not role-specific")
        params = {
            "template": "bug_report.yml",
            "title": github_title(kind, title),
            "summary": body,
            "reproduce": "See the summary above.",
            "version": version,
            "role": role,
            "environment": environment,
        }
    elif kind == "question":
        params = {
            "template": "question.yml",
            "title": title,
            "question": body,
            "version": version,
        }
    else:
        params = {
            "template": "feature_request.yml",
            "title": github_title(kind, title),
            "problem": body,
            "proposal": "See the problem description above.",
        }
    return f"{base}?{urlencode({key: value for key, value in params.items() if value}, quote_via=quote)}"


# --- Draft + share ---------------------------------------------------------------


def hub_base_url(settings: Settings) -> str | None:
    url = (settings.support_hub_url or "").strip().rstrip("/")
    return url or None


def hub_is_self(support_settings: SupportSettings) -> bool:
    return support_settings.hub_enabled


def build_share_draft(
    store,
    settings: Settings,
    report: IssueReportRecord,
    *,
    include_diagnostics: bool = True,
    use_ai: bool = False,
) -> IssueReportUpstreamDraft:
    from app.core import support_ai

    support_settings = store.support_ticket_repository.get_settings()
    people, organizations = redaction_terms(store, report)
    hosts = own_hosts(settings)
    title, title_count = redact_for_sharing(
        report.subject, people=people, organizations=organizations, hosts=hosts
    )
    body, body_count = redact_for_sharing(
        report.body, people=people, organizations=organizations, hosts=hosts
    )
    diagnostics = (
        shareable_diagnostics(report, people=people, organizations=organizations, hosts=hosts)
        if include_diagnostics
        else None
    )
    ai_drafted = False
    ai_error: str | None = None
    if use_ai and report.kind != "security":
        model = support_ai.assistant_model(store, support_settings.ai_model_id)
        if model is None:
            ai_error = "Choose a support assistant model in Reports settings to draft with AI."
        else:
            try:
                drafted = support_ai.draft_public_issue(
                    store,
                    model,
                    kind_label=KIND_LABELS.get(report.kind, report.kind),
                    subject=title,
                    body=body,
                    area=(diagnostics or {}).get("area"),
                    errors=list((diagnostics or {}).get("recent_errors") or []),
                )
            except support_ai.SupportAiError as exc:
                ai_error = str(exc)
            else:
                # The model is an extra pass, never the only one.
                title, extra_title = redact_for_sharing(
                    drafted["title"], people=people, organizations=organizations, hosts=hosts
                )
                body, extra_body = redact_for_sharing(
                    compose_ai_body(drafted), people=people, organizations=organizations, hosts=hosts
                )
                title_count += extra_title
                body_count += extra_body
                ai_drafted = True
    repository = hub_repository_hint(store, settings)
    blocked_reason = None
    if report.kind == "security":
        blocked_reason = (
            "Security concerns are never posted publicly. Report it privately to the "
            "maintainers through a GitHub security advisory instead."
        )
    hub_url = hub_base_url(settings)
    if hub_url is None and not hub_is_self(support_settings) and blocked_reason is None:
        blocked_reason = "This deployment has no community hub configured (APERTURE_SUPPORT_HUB_URL)."
    if support_settings.upstream_mode == "off" and blocked_reason is None:
        blocked_reason = "Sharing with the maintainers is turned off in Reports settings."
    return IssueReportUpstreamDraft(
        title=title[:200],
        body=body[:12000],
        labels=GITHUB_LABELS.get(report.kind, []),
        diagnostics=diagnostics,
        preview_markdown=format_github_issue(
            kind=report.kind,
            priority=report.priority,
            body=body,
            diagnostics=diagnostics,
        ),
        redaction_count=title_count + body_count,
        ai_drafted=ai_drafted,
        ai_error=ai_error,
        github_new_issue_url=github_new_issue_url(
            repository, kind=report.kind, title=title, body=body, diagnostics=diagnostics
        ),
        hub_url=hub_url or "",
        hub_available=blocked_reason is None,
        blocked_reason=blocked_reason,
    )


def compose_ai_body(drafted: dict[str, Any]) -> str:
    parts = [drafted.get("summary") or ""]
    steps = drafted.get("steps") or []
    if steps:
        parts.append("**Steps to reproduce**\n" + "\n".join(f"{index}. {step}" for index, step in enumerate(steps, 1)))
    if drafted.get("expected"):
        parts.append(f"**Expected**\n{drafted['expected']}")
    if drafted.get("actual"):
        parts.append(f"**What happened**\n{drafted['actual']}")
    return "\n\n".join(part for part in parts if part.strip())


def hub_repository_hint(store, settings: Settings) -> str:
    support_settings = store.support_ticket_repository.get_settings()
    if support_settings.hub_enabled and support_settings.hub_repository.strip():
        return support_settings.hub_repository.strip().strip("/")
    return settings.platform_update_repository.strip().strip("/")


def queue_share(
    store,
    settings: Settings,
    report: IssueReportRecord,
    *,
    title: str,
    body: str,
    include_diagnostics: bool,
    shared_by_user_id: str | None,
    shared_by_name: str,
) -> IssueReportUpstream:
    """Record the exact (re-redacted) text to send and queue it.

    The server redacts again even though the owner reviewed a redacted draft:
    the browser may have sent anything.
    """

    people, organizations = redaction_terms(store, report)
    hosts = own_hosts(settings)
    safe_title, _ = redact_for_sharing(title, people=people, organizations=organizations, hosts=hosts)
    safe_body, _ = redact_for_sharing(body, people=people, organizations=organizations, hosts=hosts)
    diagnostics = (
        shareable_diagnostics(report, people=people, organizations=organizations, hosts=hosts)
        if include_diagnostics
        else None
    )
    now = clock.now()
    repository = store.support_ticket_repository
    support_settings = repository.get_settings()
    return repository.save_upstream(
        IssueReportUpstream(
            report_id=report.id,
            tenant_id=report.tenant_id,
            state="queued",
            hub_url="self" if hub_is_self(support_settings) else (hub_base_url(settings) or ""),
            shared_by_user_id=shared_by_user_id,
            shared_by_name=shared_by_name,
            sent_title=" ".join(safe_title.split())[:200],
            sent_body=safe_body[:12000],
            sent_diagnostics=diagnostics,
            attempts=0,
            next_attempt_at=now,
            queued_at=now,
            updated_at=now,
        )
    )


def queue_automatic_share(store, settings: Settings, report: IssueReportRecord) -> IssueReportUpstream | None:
    """Automatic mode: queue a new ticket with the deterministic redaction.

    The scheduler sends it within one pass and, when an assistant model is
    set, rewrites it with AI first (see :func:`send_link`).
    """

    if report.kind == "security":
        return None
    draft = build_share_draft(store, settings, report, include_diagnostics=True)
    if not draft.hub_available:
        return None
    return queue_share(
        store,
        settings,
        report,
        title=draft.title,
        body=draft.body,
        include_diagnostics=True,
        shared_by_user_id=None,
        shared_by_name="Automatic sharing",
    )


def _rewrite_automatic_share(
    store, settings: Settings, report: IssueReportRecord, link: IssueReportUpstream
) -> IssueReportUpstream:
    """Give an unattended share the AI privacy pass before its first send."""

    draft = build_share_draft(store, settings, report, include_diagnostics=True, use_ai=True)
    if not draft.ai_drafted:
        return link
    return store.support_ticket_repository.save_upstream(
        link.model_copy(
            update={"sent_title": draft.title, "sent_body": draft.body, "updated_at": clock.now()}
        )
    )


def _retry_delay(attempts: int) -> timedelta:
    index = min(max(attempts - 1, 0), len(_RETRY_DELAYS_SECONDS) - 1)
    return timedelta(seconds=_RETRY_DELAYS_SECONDS[index])


def _hub_client(settings: Settings, transport: httpx.BaseTransport | None) -> httpx.Client:
    return httpx.Client(
        timeout=settings.support_hub_timeout_seconds,
        # Never follow a redirect with a report body or receipt token.
        follow_redirects=False,
        transport=transport,
        headers={
            "Accept": "application/json",
            "User-Agent": f"aperture-chat/{APP_VERSION} (+support-hub)",
        },
    )


def _hub_endpoint(hub_url: str, path: str) -> str:
    url = f"{hub_url.rstrip('/')}{HUB_API_PREFIX}{path}"
    validate_public_url(url)
    return url


def _error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        payload = None
    if isinstance(payload, dict) and isinstance(payload.get("detail"), str):
        return payload["detail"][:300]
    return f"The hub answered HTTP {response.status_code}."


def hub_status(settings: Settings, *, transport: httpx.BaseTransport | None = None) -> dict[str, Any]:
    hub_url = hub_base_url(settings)
    if hub_url is None:
        return {"reachable": False, "accepting": False, "detail": "No hub is configured."}
    try:
        with _hub_client(settings, transport) as client:
            response = client.get(_hub_endpoint(hub_url, "/info"))
    except EgressBlocked as exc:
        return {"reachable": False, "accepting": False, "detail": str(exc)}
    except httpx.HTTPError:
        return {"reachable": False, "accepting": False, "detail": "The hub could not be reached."}
    if response.status_code != 200:
        return {"reachable": True, "accepting": False, "detail": _error_detail(response)}
    payload = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
    return {
        "reachable": True,
        "accepting": bool(payload.get("accepting")),
        "repository": payload.get("repository") if isinstance(payload.get("repository"), str) else None,
        "detail": None if payload.get("accepting") else "The hub is not accepting reports right now.",
    }


def send_link(
    store,
    settings: Settings,
    link: IssueReportUpstream,
    *,
    transport: httpx.BaseTransport | None = None,
) -> IssueReportUpstream:
    """Deliver one queued link. Failures are recorded, never raised."""

    repository = store.support_ticket_repository
    report = repository.get_report(link.report_id)
    now = clock.now()
    if report is None:
        return link
    if report.kind == "security":
        return repository.save_upstream(
            link.model_copy(
                update={
                    "state": "private",
                    "last_error": "Security concerns are never shared publicly.",
                    "next_attempt_at": None,
                    "updated_at": now,
                }
            )
        )
    support_settings = repository.get_settings()
    if link.attempts == 0 and link.shared_by_user_id is None and support_settings.ai_model_id:
        link = _rewrite_automatic_share(store, settings, report, link)
    submission = SupportHubSubmission(
        instance_id=support_settings.instance_id,
        instance_version=APP_VERSION[:32],
        kind=report.kind,
        priority=report.priority,
        title=link.sent_title if len(link.sent_title) >= 4 else f"Report: {link.sent_title}".strip(),
        body=link.sent_body if len(link.sent_body) >= 10 else f"{link.sent_body}\n\n(no further detail)",
        diagnostics=link.sent_diagnostics,
    )
    attempts = link.attempts + 1
    try:
        receipt = _submit(store, settings, submission, transport=transport)
    except SupportUpstreamError as exc:
        retry = attempts < MAX_SEND_ATTEMPTS
        updated = link.model_copy(
            update={
                "state": "failed",
                "attempts": attempts,
                "last_error": str(exc),
                "next_attempt_at": now + _retry_delay(attempts) if retry else None,
                "updated_at": now,
            }
        )
        logger.info("Support hub send failed for %s: %s", link.report_id, exc)
        return repository.save_upstream(updated)
    updated = link.model_copy(
        update={
            "state": _local_state(receipt.status),
            "hub_report_id": receipt.id,
            "receipt_token": receipt.token,
            "attempts": attempts,
            "last_error": None,
            "next_attempt_at": None,
            "sent_at": now,
            "checked_at": now,
            "updated_at": now,
        }
    )
    stored = repository.save_upstream(updated)
    _post_event(
        store,
        report,
        "Shared with the Aperture Chat maintainers. You'll see their progress here.",
        to_value="sent",
    )
    return stored


def _submit(
    store,
    settings: Settings,
    submission: SupportHubSubmission,
    *,
    transport: httpx.BaseTransport | None,
) -> SupportHubReceipt:
    support_settings = store.support_ticket_repository.get_settings()
    if hub_is_self(support_settings):
        from app.core import support_hub

        try:
            return support_hub.receive_submission(store, settings, submission, source="self")
        except support_hub.SupportHubRejected as exc:
            raise SupportUpstreamError(str(exc)) from exc
    hub_url = hub_base_url(settings)
    if hub_url is None:
        raise SupportUpstreamError("No community hub is configured.")
    try:
        with _hub_client(settings, transport) as client:
            response = client.post(
                _hub_endpoint(hub_url, "/reports"), json=submission.model_dump(mode="json")
            )
    except EgressBlocked as exc:
        raise SupportUpstreamError(str(exc)) from exc
    except httpx.HTTPError as exc:
        raise SupportUpstreamError("The community hub could not be reached.") from exc
    if response.status_code not in (200, 201):
        raise SupportUpstreamError(_error_detail(response))
    try:
        return SupportHubReceipt.model_validate(response.json())
    except ValueError as exc:
        raise SupportUpstreamError("The community hub sent an unreadable receipt.") from exc


def poll_link(
    store,
    settings: Settings,
    link: IssueReportUpstream,
    *,
    transport: httpx.BaseTransport | None = None,
) -> IssueReportUpstream:
    repository = store.support_ticket_repository
    now = clock.now()
    if not link.hub_report_id or not link.receipt_token:
        return repository.save_upstream(link.model_copy(update={"checked_at": now, "updated_at": now}))
    try:
        status = _fetch_status(store, settings, link, transport=transport)
    except SupportUpstreamError as exc:
        return repository.save_upstream(
            link.model_copy(update={"checked_at": now, "last_error": str(exc), "updated_at": now})
        )
    return apply_hub_status(store, link, status, now=now)


def _fetch_status(
    store,
    settings: Settings,
    link: IssueReportUpstream,
    *,
    transport: httpx.BaseTransport | None,
) -> SupportHubPublicStatus:
    if link.hub_url == "self":
        from app.core import support_hub

        status = support_hub.public_status(store, link.hub_report_id or "", link.receipt_token or "")
        if status is None:
            raise SupportUpstreamError("The hub no longer has this report.")
        return status
    try:
        with _hub_client(settings, transport) as client:
            response = client.get(
                _hub_endpoint(link.hub_url, f"/reports/{quote(link.hub_report_id or '', safe='')}"),
                headers={"Authorization": f"Bearer {link.receipt_token}"},
            )
    except EgressBlocked as exc:
        raise SupportUpstreamError(str(exc)) from exc
    except httpx.HTTPError as exc:
        raise SupportUpstreamError("The community hub could not be reached.") from exc
    if response.status_code != 200:
        raise SupportUpstreamError(_error_detail(response))
    try:
        return SupportHubPublicStatus.model_validate(response.json())
    except ValueError as exc:
        raise SupportUpstreamError("The community hub sent an unreadable status.") from exc


def _local_state(hub_status: str) -> str:
    return {
        "pending": "sent",
        "published": "published",
        "linked": "published",
        "declined": "declined",
        "spam": "declined",
        "private": "private",
    }.get(hub_status, "sent")


def apply_hub_status(
    store,
    link: IssueReportUpstream,
    status: SupportHubPublicStatus,
    *,
    now: datetime,
) -> IssueReportUpstream:
    """Copy the hub's view onto the link and tell the reporter what changed."""

    repository = store.support_ticket_repository
    report = repository.get_report(link.report_id)
    state = _local_state(status.status)
    issue_url = status.issue_url if (status.issue_url or "").startswith("https://github.com/") else None
    updated = link.model_copy(
        update={
            "state": state,
            "issue_number": status.issue_number,
            "issue_url": issue_url,
            "issue_state": status.issue_state,
            "issue_state_reason": status.issue_state_reason,
            "maintainer_note": (status.maintainer_note or None),
            "checked_at": now,
            "last_error": None,
            "updated_at": now,
        }
    )
    stored = repository.save_upstream(updated)
    if report is None:
        return stored
    message = _change_message(link, stored)
    if message:
        _post_event(store, report, message, to_value=state)
    return stored


def _change_message(before: IssueReportUpstream, after: IssueReportUpstream) -> str | None:
    number = after.issue_number
    if after.state == "declined" and before.state != "declined":
        note = f" Their note: {after.maintainer_note}" if after.maintainer_note else ""
        return f"The Aperture Chat maintainers reviewed this report and won't track it as an issue.{note}"
    if number and before.issue_number != number:
        return f"The maintainers are tracking this as GitHub issue #{number}."
    if number and before.issue_state != after.issue_state:
        if after.issue_state == "closed":
            if after.issue_state_reason == "completed":
                return (
                    f"GitHub issue #{number} was closed as completed. The fix arrives with a "
                    "future Aperture Chat release."
                )
            if after.issue_state_reason == "duplicate":
                return f"GitHub issue #{number} was closed as a duplicate of another tracked issue."
            return f"GitHub issue #{number} was closed as not planned."
        if after.issue_state == "open" and before.issue_state == "closed":
            return f"GitHub issue #{number} was reopened."
    return None


def _post_event(store, report: IssueReportRecord, body: str, *, to_value: str) -> None:
    store.support_ticket_repository.update_report(
        report.id,
        events=[
            IssueReportEvent(
                id=new_event_id(),
                report_id=report.id,
                tenant_id=report.tenant_id,
                kind="upstream",
                visibility="public",
                actor_name=MAINTAINERS_NAME,
                actor_kind="system",
                body=body,
                to_value=to_value,
                created_at=clock.now(),
            )
        ],
    )


def support_upstream_pass(
    store,
    settings: Settings,
    *,
    transport: httpx.BaseTransport | None = None,
    limit: int = 10,
) -> int:
    """Send queued links and refresh stale statuses. Returns links touched."""

    if not _send_lock.acquire(blocking=False):
        return 0
    try:
        repository = store.support_ticket_repository
        now = clock.now()
        due = repository.upstreams_due(
            now=now,
            poll_checked_before=now - timedelta(seconds=settings.support_hub_poll_interval_seconds),
            limit=limit,
        )
        for link in due:
            try:
                if link.state in ("queued", "failed"):
                    send_link(store, settings, link, transport=transport)
                else:
                    poll_link(store, settings, link, transport=transport)
            except Exception:  # noqa: BLE001 - one bad link must not stall the rest
                logger.exception("Support upstream processing failed for %s", link.report_id)
        return len(due)
    finally:
        _send_lock.release()


def send_now(
    store,
    settings: Settings,
    link: IssueReportUpstream,
    *,
    transport: httpx.BaseTransport | None = None,
) -> IssueReportUpstream:
    """Owner-triggered send or refresh, serialized with the scheduler."""

    with _send_lock:
        current = store.support_ticket_repository.get_upstream(link.report_id) or link
        if current.state in ("queued", "failed"):
            return send_link(store, settings, current, transport=transport)
        return poll_link(store, settings, current, transport=transport)
