"""Platform update detection and the hand-off to the updater sidecar.

Two independent halves live here:

1. **Release detection.** The API compares its own build version
   (``app.version.APP_VERSION``) against the public GitHub Releases of the
   repository and caches the newer releases, including their notes, so the
   owner console can show what an upgrade brings. The check is cheap and
   rate-aware: the scheduler refreshes it on a multi-hour interval and a
   manual "check now" is throttled.

2. **Updater hand-off.** The API never talks to the Docker socket. When the
   owner approves an upgrade it writes a small request file into a directory
   shared with the ``updater`` sidecar (``infra/updater/updater.sh``), which
   holds the socket, pulls the new images, recreates the services in order,
   verifies health, and rolls back on failure. The sidecar reports progress
   back through the same directory. Every file is plain ``key=value`` lines so
   the sidecar needs nothing beyond a POSIX shell.

Normal API requests require a platform owner and a published stable release;
the sidecar independently validates the ``vX.Y.Z`` tag before using it. Keeping
the Docker socket out of the API separates deployment execution from request
handling. The shared writable state directory is still a trust boundary, not
isolation from a fully compromised API process.
"""

from __future__ import annotations

import logging
import math
import os
import re
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any
from uuid import uuid4

import httpx

from app.core import clock
from app.core.config import Settings
from app.core.net_guard import REDIRECT_GUARD_HOOKS, EgressBlocked, validate_public_url
from app.models.schemas import (
    PlatformReleaseInfo,
    PlatformUpdaterRun,
    PlatformUpdaterStatus,
    PlatformUpdateStatus,
)
from app.version import APP_VERSION

if TYPE_CHECKING:  # pragma: no cover - typing only
    from app.repositories.seed import SeedStore

logger = logging.getLogger("aperture.platform_updates")

VersionTuple = tuple[int, int, int]

# Strict release identity: an optional leading "v" and three numeric parts.
# Pre-release suffixes are deliberately rejected; only stable releases are
# ever offered as upgrades.
RELEASE_TAG_PATTERN = re.compile(r"^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$")
_HEADING_PATTERN = re.compile(r"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
# Lines that start a new Markdown block and therefore must never be glued to
# the line above them when unwrapping hard-wrapped release notes.
_BLOCK_START_PATTERN = re.compile(r"^\s*(?:[-*+]\s+|\d{1,3}[.)]\s+|#{1,6}\s|>|\||```|~~~|---+\s*$|\*\*\*+\s*$)")
_HIGHLIGHT_HEADINGS = ("highlights", "what's new", "what’s new", "changes", "changelog")
_TRAILING_HEADINGS = {"published images", "deploy", "deployment", "install"}
_SAFE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$")

MAX_RELEASES_RETURNED = 10
MAX_NOTES_CHARS = 20_000
MAX_KV_VALUE_CHARS = 2_000
LOG_TAIL_CHARS = 4_000
FORCED_CHECK_MIN_INTERVAL_SECONDS = 60.0
FAILED_CHECK_RETRY_SECONDS = 300.0

# --- Sidecar protocol (mirrored by infra/updater/updater.sh) -----------------
HEARTBEAT_FILE = "heartbeat"
REQUEST_FILE = "request"
# API-owned failure state survives subsequent polling after an unclaimed
# request is removed. The sidecar's status file remains exclusively its own.
REQUEST_FAILURE_FILE = "request-failure"
STATUS_FILE = "status"
LOG_FILE = "log"
HEARTBEAT_STALE_AFTER_SECONDS = 45.0
# A request the sidecar has not acknowledged after this long is abandoned so
# the owner can retry once the sidecar is back.
REQUEST_UNCLAIMED_TIMEOUT_SECONDS = 180.0
# A run whose status has not advanced for this long is reported as failed so
# a sidecar that died mid-upgrade cannot block the console indefinitely.
RUN_STALL_TIMEOUT_SECONDS = 45 * 60.0
ACTIVE_PHASES = frozenset({"requested", "accepted", "pulling", "applying", "verifying"})
TERMINAL_PHASES = frozenset({"succeeded", "failed", "rolled_back"})
KNOWN_PHASES = ACTIVE_PHASES | TERMINAL_PHASES | {"idle"}
# The deployment runs one API worker, whose request and scheduler threads must
# inspect and update the shared request file as one operation. The sidecar
# retains a request until its accepted status is visible, closing the handoff.
_UPDATER_STATE_LOCK = threading.RLock()


class UpdateCheckError(Exception):
    """The release lookup failed; the message is safe to show an owner."""


class UpdateCheckRateLimited(Exception):
    """A forced check was requested too soon after the previous attempt."""


class UpdaterUnavailable(Exception):
    """The sidecar is not configured or not currently reachable."""


class UpdaterBusy(Exception):
    """An upgrade is already pending or running."""


# --- Versions ----------------------------------------------------------------


def parse_version(text: str | None) -> VersionTuple | None:
    match = RELEASE_TAG_PATTERN.match((text or "").strip())
    if match is None:
        return None
    major, minor, patch = (int(part) for part in match.groups())
    return (major, minor, patch)


def format_version(version: VersionTuple) -> str:
    return f"v{version[0]}.{version[1]}.{version[2]}"


def current_version_tuple(settings: Settings) -> VersionTuple:
    # Compare the running build, never a persistent environment override that
    # survives image upgrades and can repeatedly advertise an installed release.
    built = parse_version(APP_VERSION)
    if built is None:  # pragma: no cover - guarded by test_app_version_is_release_shaped
        raise RuntimeError(f"APP_VERSION {APP_VERSION!r} is not a vX.Y.Z release version.")
    return built


def current_version(settings: Settings) -> str:
    return format_version(current_version_tuple(settings))


# --- Release notes -----------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Release:
    version: str
    version_tuple: VersionTuple
    name: str
    url: str
    published_at: str | None
    notes: str
    highlights: str

    def to_info(self) -> PlatformReleaseInfo:
        return PlatformReleaseInfo(
            version=self.version,
            name=self.name,
            url=self.url,
            published_at=self.published_at,
            highlights=self.highlights,
            notes=self.notes,
        )


def unwrap_soft_lines(text: str) -> str:
    """Join hard-wrapped Markdown lines so bullets and paragraphs render whole.

    Release notes are authored at ~80 columns (bullet continuation lines are
    indented two spaces). The web renderer keeps line breaks inside blocks, so
    without this a single bullet would appear as a bullet plus loose lines.
    Code fences, headings, list markers, quotes, tables, and blank lines are
    left exactly as written.
    """
    out: list[str] = []
    in_code = False
    for raw in text.splitlines():
        stripped = raw.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_code = not in_code
            out.append(raw)
            continue
        if in_code or not stripped:
            out.append(raw if in_code else "")
            continue
        previous = out[-1] if out else ""
        joinable = (
            previous.strip() != ""
            and not _BLOCK_START_PATTERN.match(raw)
            and _HEADING_PATTERN.match(previous) is None
            and not previous.strip().startswith("|")
            and not previous.strip().startswith(">")
        )
        if joinable:
            out[-1] = f"{previous.rstrip()} {stripped}"
        else:
            out.append(raw)
    return "\n".join(out)


def extract_highlights(body: str) -> str:
    """Return the Markdown under a release's Highlights heading.

    The release workflow writes ``## Highlights`` followed by the changelog
    bullets and then deployment boilerplate. When a release has no such
    heading the body is returned minus its title line and any trailing
    deployment sections, so hand-written notes still read well.
    """
    lines = body.splitlines()
    collected: list[str] = []
    capturing = False
    for line in lines:
        heading = _HEADING_PATTERN.match(line)
        if heading is not None:
            if capturing:
                break
            title = heading.group(2).strip().lower()
            if any(title.startswith(prefix) for prefix in _HIGHLIGHT_HEADINGS):
                capturing = True
            continue
        if capturing:
            collected.append(line)
    text = "\n".join(collected).strip()
    if text:
        return text

    fallback: list[str] = []
    for line in lines:
        heading = _HEADING_PATTERN.match(line)
        if heading is not None:
            if heading.group(2).strip().lower() in _TRAILING_HEADINGS:
                break
            if len(heading.group(1)) == 1:
                continue
        fallback.append(line)
    return "\n".join(fallback).strip()


def parse_release_payload(payload: Any) -> list[Release]:
    """Turn the GitHub ``/releases`` list into stable releases, newest first."""
    if not isinstance(payload, list):
        raise UpdateCheckError("Release lookup returned an unexpected response shape.")
    seen: set[VersionTuple] = set()
    releases: list[Release] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        if item.get("draft") or item.get("prerelease"):
            continue
        version = parse_version(str(item.get("tag_name") or ""))
        if version is None or version in seen:
            continue
        seen.add(version)
        body = unwrap_soft_lines(str(item.get("body") or "")[:MAX_NOTES_CHARS])
        html_url = str(item.get("html_url") or "")
        if not html_url.startswith("https://"):
            html_url = ""
        published = item.get("published_at")
        releases.append(
            Release(
                version=format_version(version),
                version_tuple=version,
                name=str(item.get("name") or format_version(version)).strip(),
                url=html_url,
                published_at=str(published) if isinstance(published, str) and published else None,
                notes=body,
                highlights=extract_highlights(body),
            )
        )
    releases.sort(key=lambda release: release.version_tuple, reverse=True)
    return releases


def fetch_releases(
    settings: Settings,
    *,
    transport: httpx.BaseTransport | None = None,
) -> list[Release]:
    url = settings.platform_update_releases_url or (
        f"https://api.github.com/repos/{settings.platform_update_repository.strip('/')}/releases"
    )
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": f"aperture-chat/{APP_VERSION} (platform update check)",
    }
    try:
        validate_public_url(url)
        with httpx.Client(
            timeout=settings.platform_update_request_timeout_seconds,
            transport=transport,
            follow_redirects=True,
            event_hooks=REDIRECT_GUARD_HOOKS,
        ) as client:
            response = client.get(url, headers=headers, params={"per_page": 20})
        response.raise_for_status()
        payload = response.json()
    except EgressBlocked as exc:
        raise UpdateCheckError(f"Release lookup blocked: {exc}") from exc
    except httpx.HTTPStatusError as exc:
        raise UpdateCheckError(
            f"Release lookup failed with HTTP {exc.response.status_code}."
        ) from exc
    except httpx.HTTPError as exc:
        raise UpdateCheckError(f"Release lookup failed: {type(exc).__name__}.") from exc
    except ValueError as exc:
        raise UpdateCheckError("Release lookup returned invalid JSON.") from exc
    return parse_release_payload(payload)


# --- Cached check ------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class UpdateCheckSnapshot:
    checked_at: datetime | None = None
    releases: tuple[Release, ...] = ()
    error: str | None = None
    last_attempt_at: datetime | None = None


@dataclass
class _UpdateCheckState:
    checked_at: datetime | None = None
    releases: tuple[Release, ...] = ()
    error: str | None = None
    last_attempt_at: datetime | None = None
    refreshing: bool = False
    fetcher: Any = field(default=fetch_releases)

    def snapshot(self) -> UpdateCheckSnapshot:
        return UpdateCheckSnapshot(
            checked_at=self.checked_at,
            releases=self.releases,
            error=self.error,
            last_attempt_at=self.last_attempt_at,
        )


class UpdateChecker:
    """Process-wide cache of the last release lookup.

    ``refresh`` never raises for lookup failures: the error is recorded and the
    previous good result is kept, so a GitHub outage can never hide the console
    or spam the log. Only one thread performs a lookup at a time; concurrent
    callers get the current snapshot immediately.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state = _UpdateCheckState()

    def snapshot(self) -> UpdateCheckSnapshot:
        with self._lock:
            return self._state.snapshot()

    def reset(self, fetcher: Any = fetch_releases) -> None:
        with self._lock:
            self._state = _UpdateCheckState(fetcher=fetcher)

    def _is_stale(self, now: datetime, settings: Settings) -> bool:
        state = self._state
        if state.checked_at is None and state.last_attempt_at is None:
            return True
        if state.last_attempt_at is not None and state.error is not None:
            return (now - state.last_attempt_at).total_seconds() >= FAILED_CHECK_RETRY_SECONDS
        if state.checked_at is None:
            return True
        return (
            now - state.checked_at
        ).total_seconds() >= settings.platform_update_check_interval_seconds

    def refresh(self, settings: Settings, *, force: bool = False) -> UpdateCheckSnapshot:
        if not settings.platform_update_check_enabled:
            return self.snapshot()
        now = clock.now()
        with self._lock:
            state = self._state
            if state.refreshing:
                return state.snapshot()
            if force:
                if (
                    state.last_attempt_at is not None
                    and (now - state.last_attempt_at).total_seconds()
                    < FORCED_CHECK_MIN_INTERVAL_SECONDS
                ):
                    raise UpdateCheckRateLimited(
                        "A release check already ran in the last minute. Try again shortly."
                    )
            elif not self._is_stale(now, settings):
                return state.snapshot()
            state.refreshing = True
            state.last_attempt_at = now
            fetcher = state.fetcher
        try:
            releases = tuple(fetcher(settings))
        except UpdateCheckError as exc:
            logger.warning("Platform update check failed: %s", exc)
            with self._lock:
                self._state.error = str(exc)
        except Exception:  # noqa: BLE001 - the checker must never take the API down
            logger.exception("Platform update check crashed")
            with self._lock:
                self._state.error = "Release lookup failed unexpectedly."
        else:
            with self._lock:
                self._state.releases = releases
                self._state.checked_at = now
                self._state.error = None
        finally:
            with self._lock:
                self._state.refreshing = False
        return self.snapshot()


update_checker = UpdateChecker()


# --- Sidecar bridge ----------------------------------------------------------


def _read_kv_file(path: Path) -> dict[str, str]:
    """Parse ``key=value`` lines; malformed lines are ignored, values bounded."""
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    values: dict[str, str] = {}
    for line in raw.splitlines():
        key, separator, value = line.partition("=")
        key = key.strip()
        if not separator or not key or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        values[key] = value.strip()[:MAX_KV_VALUE_CHARS]
    return values


def _write_kv_file(path: Path, values: dict[str, str]) -> None:
    """Atomically replace ``path`` so the sidecar never reads a partial file."""
    lines = []
    for key, value in values.items():
        clean = str(value).replace("\r", " ").replace("\n", " ").strip()
        lines.append(f"{key}={clean}")
    temp = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    temp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.replace(temp, path)


def _iso_from_unix(value: str) -> str | None:
    try:
        return datetime.fromtimestamp(int(float(value)), tz=UTC).isoformat()
    except (ValueError, OverflowError, OSError):
        return None


def _optional(values: dict[str, str], key: str) -> str | None:
    value = values.get(key, "").strip()
    return value or None


def _safe_id(value: str | None) -> str | None:
    if value and _SAFE_ID_PATTERN.match(value):
        return value
    return None


class UpdaterBridge:
    """File-based handshake with the privileged updater sidecar."""

    def __init__(self, state_dir: str | os.PathLike[str] | None) -> None:
        text = str(state_dir or "").strip()
        self.state_dir: Path | None = Path(text) if text else None

    @property
    def configured(self) -> bool:
        return self.state_dir is not None

    def _path(self, name: str) -> Path:
        assert self.state_dir is not None
        return self.state_dir / name

    def heartbeat(self) -> tuple[bool, str | None, str | None, str | None]:
        """Return ``(connected, last_heartbeat_iso, project, problem)``."""
        if self.state_dir is None:
            return False, None, None, None
        values = _read_kv_file(self._path(HEARTBEAT_FILE))
        if not values:
            return False, None, None, "The updater sidecar has not reported in yet."
        timestamp = values.get("ts", "")
        last_seen = _iso_from_unix(timestamp)
        project = _optional(values, "project")
        try:
            age = clock.now().timestamp() - float(timestamp)
        except ValueError:
            age = float("inf")
        if last_seen is None or not math.isfinite(age) or age < -5:
            return False, last_seen, project, "The updater sidecar reported an invalid heartbeat."
        if age > HEARTBEAT_STALE_AFTER_SECONDS:
            return False, last_seen, project, "The updater sidecar has stopped reporting."
        if values.get("ready", "0") != "1":
            problem = _optional(values, "ready_message") or "The updater sidecar is not ready."
            return False, last_seen, project, problem
        return True, last_seen, project, None

    def run_status(self) -> PlatformUpdaterRun:
        with _UPDATER_STATE_LOCK:
            return self._run_status()

    def _run_status(self) -> PlatformUpdaterRun:
        if self.state_dir is None:
            return PlatformUpdaterRun()
        status = _read_kv_file(self._path(STATUS_FILE))
        run = PlatformUpdaterRun(
            id=_safe_id(_optional(status, "id")),
            phase=status.get("phase", "idle") if status.get("phase") in KNOWN_PHASES else "idle",
            target_version=_normalized_version(_optional(status, "target_version")),
            previous_version=_normalized_version(_optional(status, "previous_version")),
            requested_by=_optional(status, "requested_by"),
            message=status.get("message", ""),
            started_at=_optional(status, "started_at"),
            updated_at=_optional(status, "updated_at"),
            finished_at=_optional(status, "finished_at"),
        )
        if (
            run.phase in ACTIVE_PHASES
            and _older_than(run.updated_at, RUN_STALL_TIMEOUT_SECONDS)
            and not self.heartbeat()[0]
        ):
            run = run.model_copy(
                update={
                    "phase": "failed",
                    "message": "The upgrade stopped reporting progress. Check the services "
                    "with docker compose ps before trying again.",
                    "finished_at": clock.now_iso(),
                }
            )
        pending = self._pending_request()
        if pending is None:
            failed = _read_kv_file(self._path(REQUEST_FAILURE_FILE))
            if (
                failed.get("phase") == "failed"
                and _safe_id(failed.get("id"))
                and failed.get("id") != run.id
                and run.phase not in ACTIVE_PHASES
            ):
                return PlatformUpdaterRun.model_validate(failed)
            return run
        if pending.get("id") == run.id:
            return run
        # A request the sidecar has not acknowledged yet. Surface it so the
        # console can show "waiting", and abandon it if nothing ever claims it.
        requested_at = _optional(pending, "requested_at")
        stale = True
        if requested_at:
            try:
                requested_time = datetime.fromisoformat(requested_at.replace("Z", "+00:00"))
                if requested_time.tzinfo is not None:
                    age = (clock.now() - requested_time).total_seconds()
                    stale = age < -5 or age > REQUEST_UNCLAIMED_TIMEOUT_SECONDS
            except ValueError:
                pass
        if stale:
            failed_run = PlatformUpdaterRun(
                id=_safe_id(pending.get("id")),
                phase="failed",
                target_version=_normalized_version(_optional(pending, "target_version")),
                previous_version=_normalized_version(_optional(pending, "previous_version")),
                requested_by=_optional(pending, "requested_by"),
                message="The updater sidecar did not pick up the request. Check that the "
                "updater service is running, then try again.",
                started_at=requested_at,
                updated_at=clock.now_iso(),
                finished_at=clock.now_iso(),
            )
            # Keep the outcome for the console and audit reconciliation. Do not
            # replace `status`: a late sidecar acknowledgment still takes priority.
            try:
                _write_kv_file(
                    self._path(REQUEST_FAILURE_FILE),
                    failed_run.model_dump(exclude_none=True),
                )
            except OSError:
                logger.warning("Could not persist the unclaimed updater request failure")
            self._discard_request()
            return failed_run
        return PlatformUpdaterRun(
            id=_safe_id(pending.get("id")),
            phase="requested",
            target_version=_normalized_version(_optional(pending, "target_version")),
            previous_version=_normalized_version(_optional(pending, "previous_version")),
            requested_by=_optional(pending, "requested_by"),
            message="Waiting for the updater to accept the request.",
            started_at=requested_at,
            updated_at=requested_at,
        )

    def log_tail(self, max_chars: int = LOG_TAIL_CHARS) -> str:
        if self.state_dir is None:
            return ""
        try:
            text = self._path(LOG_FILE).read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""
        return text[-max_chars:] if len(text) > max_chars else text

    def _pending_request(self) -> dict[str, str] | None:
        values = _read_kv_file(self._path(REQUEST_FILE))
        return values or None

    def _discard_request(self) -> None:
        try:
            self._path(REQUEST_FILE).unlink()
        except OSError:
            pass

    def status(self) -> PlatformUpdaterStatus:
        if self.state_dir is None:
            return PlatformUpdaterStatus(configured=False)
        connected, last_seen, project, problem = self.heartbeat()
        return PlatformUpdaterStatus(
            configured=True,
            connected=connected,
            last_heartbeat_at=last_seen,
            project=project,
            problem=problem,
            run=self.run_status(),
            log_tail=self.log_tail(),
        )

    def write_request(
        self,
        *,
        target_version: str,
        previous_version: str,
        requested_by: str,
    ) -> str:
        with _UPDATER_STATE_LOCK:
            return self._write_request(
                target_version=target_version,
                previous_version=previous_version,
                requested_by=requested_by,
            )

    def _write_request(
        self,
        *,
        target_version: str,
        previous_version: str,
        requested_by: str,
    ) -> str:
        if self.state_dir is None:
            raise UpdaterUnavailable("The updater sidecar is not configured for this deployment.")
        if parse_version(target_version) is None:
            raise ValueError("target_version must look like vX.Y.Z")
        connected, _last_seen, _project, problem = self.heartbeat()
        if not connected:
            raise UpdaterUnavailable(problem or "The updater sidecar is offline.")
        run = self.run_status()
        if run.phase in ACTIVE_PHASES:
            raise UpdaterBusy("An upgrade is already in progress.")
        self.state_dir.mkdir(parents=True, exist_ok=True)
        request_id = f"upd-{uuid4().hex[:16]}"
        _write_kv_file(
            self._path(REQUEST_FILE),
            {
                "id": request_id,
                "target_version": target_version,
                "previous_version": previous_version,
                "requested_by": requested_by,
                "requested_at": clock.now_iso(),
            },
        )
        try:
            self._path(REQUEST_FAILURE_FILE).unlink(missing_ok=True)
        except OSError:
            logger.warning("Could not clear the previous updater request failure")
        return request_id

    def audit_marker(self, run_id: str) -> Path:
        return self._path(f"outcome.{run_id}.audited")


def _normalized_version(text: str | None) -> str | None:
    parsed = parse_version(text)
    return format_version(parsed) if parsed is not None else None


def _older_than(timestamp: str | None, seconds: float) -> bool:
    if not timestamp:
        return False
    try:
        moment = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        return False
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return (clock.now() - moment).total_seconds() > seconds


# --- Status assembly and scheduler hooks --------------------------------------


def releases_page_url(settings: Settings) -> str:
    return f"https://github.com/{settings.platform_update_repository.strip('/')}/releases"


def build_update_status(settings: Settings, *, refresh: bool = True) -> PlatformUpdateStatus:
    snapshot = update_checker.refresh(settings) if refresh else update_checker.snapshot()
    running = current_version_tuple(settings)
    newer = [release for release in snapshot.releases if release.version_tuple > running]
    latest = snapshot.releases[0] if snapshot.releases else None
    return PlatformUpdateStatus(
        current_version=format_version(running),
        latest_version=latest.version if latest else None,
        update_available=bool(newer),
        releases=[release.to_info() for release in newer[:MAX_RELEASES_RETURNED]],
        checked_at=snapshot.checked_at.isoformat() if snapshot.checked_at else None,
        check_error=snapshot.error,
        check_enabled=settings.platform_update_check_enabled,
        repository=settings.platform_update_repository,
        releases_page_url=releases_page_url(settings),
        updater=UpdaterBridge(settings.platform_updater_state_dir).status(),
    )


def refresh_platform_update_check(settings: Settings) -> None:
    """Scheduler entry point: refresh the cache only when it is stale.

    Skipped under pytest like the scheduler task itself, so route and
    scheduler tests never reach the network.
    """
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return
    update_checker.refresh(settings)


def reconcile_updater_outcome(store: SeedStore, settings: Settings) -> None:
    """Record one audit event per finished upgrade the sidecar reported.

    The sidecar cannot write audit records itself, and the API process that
    requested the upgrade is replaced mid-flight, so the outcome is attributed
    to the owner who requested it the first time any API process sees the
    terminal status.
    """
    bridge = UpdaterBridge(settings.platform_updater_state_dir)
    if not bridge.configured:
        return
    run = bridge.run_status()
    if run.id is None or run.phase not in TERMINAL_PHASES:
        return
    marker = bridge.audit_marker(run.id)
    if marker.exists():
        return
    actor = store.users.get(run.requested_by) if run.requested_by else None
    if actor is not None:
        store.record_audit(
            actor,
            f"platform.update_{run.phase}",
            run.target_version or "",
            {
                "request_id": run.id,
                "from_version": run.previous_version,
                "to_version": run.target_version,
                "message": run.message,
                "finished_at": run.finished_at,
            },
        )
    try:
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch()
    except OSError:
        logger.warning("Could not persist updater audit marker for %s", run.id)


__all__ = [
    "ACTIVE_PHASES",
    "Release",
    "TERMINAL_PHASES",
    "UpdateCheckError",
    "UpdateCheckRateLimited",
    "UpdateChecker",
    "UpdaterBridge",
    "UpdaterBusy",
    "UpdaterUnavailable",
    "build_update_status",
    "current_version",
    "extract_highlights",
    "fetch_releases",
    "format_version",
    "parse_release_payload",
    "parse_version",
    "reconcile_updater_outcome",
    "refresh_platform_update_check",
    "releases_page_url",
    "unwrap_soft_lines",
    "update_checker",
]
