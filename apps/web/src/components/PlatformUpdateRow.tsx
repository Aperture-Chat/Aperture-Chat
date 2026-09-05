import clsx from "clsx";
import {
  CircleArrowUp,
  CircleCheck,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { ChatRequestError } from "../lib/api/http";
import {
  applyPlatformUpdate,
  checkPlatformUpdates,
  getPlatformUpdateStatus,
} from "../lib/api/platformUpdates";
import { formatTimestamp } from "../lib/serverClock";
import { useModalFocus } from "../lib/useModalFocus";
import "./platform-update.css";
import type {
  PlatformReleaseInfo,
  PlatformUpdateStatus,
  PlatformUpdaterPhase,
  PlatformUpdaterRun,
} from "../lib/types";
import { Markdown } from "./Markdown";

/** The server caches release lookups for hours; this only picks up the
 * scheduler's refreshes and upgrades started from another browser. */
const IDLE_POLL_MS = 30 * 60 * 1000;
/** While an upgrade runs the API restarts underneath us, so poll quickly and
 * treat connection errors as "still restarting". */
const ACTIVE_POLL_MS = 2500;
/** A finished upgrade stays visible this long so the owner sees the outcome
 * even if they were away, then the row returns to its quiet state. */
const OUTCOME_VISIBLE_MS = 24 * 60 * 60 * 1000;
const HOVER_OPEN_DELAY_MS = 260;
const HOVER_CLOSE_DELAY_MS = 140;
const CARD_WIDTH = 400;
const CARD_MAX_HEIGHT = 520;
const VIEWPORT_MARGIN = 12;
const ANCHOR_GAP = 12;
const DISMISSED_RUN_KEY = "aperture-platform-update-dismissed-run";

const ACTIVE_PHASES = new Set<PlatformUpdaterPhase>([
  "requested",
  "accepted",
  "pulling",
  "applying",
  "verifying",
]);
const TERMINAL_PHASES = new Set<PlatformUpdaterPhase>(["succeeded", "failed", "rolled_back"]);

const PHASE_STEPS: { phases: PlatformUpdaterPhase[]; label: string }[] = [
  { phases: ["requested", "accepted"], label: "Handing the request to the updater" },
  { phases: ["pulling"], label: "Downloading the new release images" },
  { phases: ["applying"], label: "Restarting the API, then the web app" },
  { phases: ["verifying"], label: "Verifying the API health check" },
];

const PHASE_SHORT_LABEL: Record<PlatformUpdaterPhase, string> = {
  idle: "",
  requested: "Starting update…",
  accepted: "Preparing update…",
  pulling: "Downloading update…",
  applying: "Restarting services…",
  verifying: "Verifying update…",
  succeeded: "Update installed",
  failed: "Update failed",
  rolled_back: "Update rolled back",
};

type RowTone = "available" | "active" | "success" | "danger";

/**
 * Platform-owner-only sidebar row that appears when a newer GitHub release of
 * the platform exists. Hovering shows the release notes; clicking opens the
 * upgrade dialog, which hands the upgrade to the updater sidecar and follows
 * it through the API restart. Nothing renders for other roles or when the
 * deployment is current.
 */
export function PlatformUpdateRow({ userId, enabled }: { userId: string; enabled: boolean }) {
  const { status, unreachable, refresh, replaceStatus } = usePlatformUpdateStatus(userId, enabled);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(() => readDismissedRun());

  if (!enabled || !status) return null;

  const run = status.updater.run;
  const active = ACTIVE_PHASES.has(run.phase);
  const outcomeVisible =
    TERMINAL_PHASES.has(run.phase) &&
    !!run.id &&
    run.id !== dismissedRunId &&
    withinLast(run.finished_at, OUTCOME_VISIBLE_MS);
  if (!status.update_available && !active && !outcomeVisible) return null;

  const tone: RowTone = active
    ? "active"
    : outcomeVisible
      ? run.phase === "succeeded"
        ? "success"
        : "danger"
      : "available";
  const latest = status.releases[0] ?? null;
  const label =
    tone === "active"
      ? unreachable
        ? "Restarting services…"
        : PHASE_SHORT_LABEL[run.phase]
      : tone === "available"
        ? `${status.updater.configured && status.updater.connected ? "Update to" : "Release available:"} ${status.latest_version ?? latest?.version ?? "new version"}`
        : PHASE_SHORT_LABEL[run.phase];

  function dismissOutcome() {
    if (run.id) {
      writeDismissedRun(run.id);
      setDismissedRunId(run.id);
    }
    setDialogOpen(false);
  }

  return (
    <>
      <PlatformUpdateHoverCard status={status} tone={tone} unreachable={unreachable}>
        {(describedBy) => (
          <button
            className={clsx("minor-row", "platform-update-row", `is-${tone}`)}
            type="button"
            aria-label={label}
            aria-haspopup="dialog"
            aria-expanded={dialogOpen}
            aria-describedby={describedBy}
            onClick={() => setDialogOpen(true)}
          >
            <RowIcon tone={tone} />
            <span>{label}</span>
            {tone === "available" && <span className="platform-update-dot" aria-hidden="true" />}
          </button>
        )}
      </PlatformUpdateHoverCard>
      {dialogOpen &&
        createPortal(
          <PlatformUpdateDialog
            status={status}
            unreachable={unreachable}
            userId={userId}
            onClose={() => setDialogOpen(false)}
            onDismissOutcome={dismissOutcome}
            onRefresh={refresh}
            onStatus={replaceStatus}
          />,
          document.body,
        )}
    </>
  );
}

function RowIcon({ tone }: { tone: RowTone }) {
  if (tone === "active") return <LoaderCircle size={16} className="is-spinning" aria-hidden="true" />;
  if (tone === "success") return <CircleCheck size={16} aria-hidden="true" />;
  if (tone === "danger") return <TriangleAlert size={16} aria-hidden="true" />;
  return <CircleArrowUp size={16} aria-hidden="true" />;
}

// --- Data --------------------------------------------------------------------

function usePlatformUpdateStatus(userId: string, enabled: boolean) {
  const [status, setStatus] = useState<PlatformUpdateStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled || forbidden) return;
    try {
      const next = await getPlatformUpdateStatus(userId);
      if (!mountedRef.current) return;
      setStatus(next);
      setUnreachable(false);
    } catch (error) {
      if (!mountedRef.current) return;
      if (error instanceof ChatRequestError && (error.status === 401 || error.status === 403)) {
        setForbidden(true);
        return;
      }
      // Network drop or 5xx. Keep the last known status: during an upgrade
      // the API is expected to disappear for a minute.
      setUnreachable(true);
    }
  }, [enabled, forbidden, userId]);

  useEffect(() => {
    if (!enabled || forbidden) return;
    void refresh();
  }, [enabled, forbidden, refresh]);

  const active = status ? ACTIVE_PHASES.has(status.updater.run.phase) : false;
  useEffect(() => {
    if (!enabled || forbidden) return;
    const interval = window.setInterval(() => void refresh(), active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    return () => window.clearInterval(interval);
  }, [active, enabled, forbidden, refresh]);

  const replaceStatus = useCallback((next: PlatformUpdateStatus) => {
    setStatus(next);
    setUnreachable(false);
  }, []);

  return { status, unreachable, refresh, replaceStatus };
}

function readDismissedRun(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_RUN_KEY);
  } catch {
    return null;
  }
}

function writeDismissedRun(runId: string) {
  try {
    window.localStorage.setItem(DISMISSED_RUN_KEY, runId);
  } catch {
    // Private-browsing storage failures only cost the dismissal memory.
  }
}

function withinLast(iso: string | null | undefined, windowMs: number): boolean {
  if (!iso) return false;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return false;
  return Date.now() - time <= windowMs;
}

function formatPublished(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// --- Hover card ----------------------------------------------------------------

type CardPosition = { left: number; top: number; placement: "left" | "right" };

function PlatformUpdateHoverCard({
  children,
  status,
  tone,
  unreachable,
}: {
  children: (describedBy: string | undefined) => ReactNode;
  status: PlatformUpdateStatus;
  tone: RowTone;
  unreachable: boolean;
}) {
  const cardId = useId();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CardPosition>({
    left: VIEWPORT_MARGIN,
    top: VIEWPORT_MARGIN,
    placement: "right",
  });

  const clearTimers = useCallback(() => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  const scheduleOpen = useCallback(() => {
    clearTimers();
    openTimer.current = window.setTimeout(() => setOpen(true), HOVER_OPEN_DELAY_MS);
  }, [clearTimers]);

  const scheduleClose = useCallback(() => {
    clearTimers();
    closeTimer.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS);
  }, [clearTimers]);

  const closeNow = useCallback(() => {
    clearTimers();
    setOpen(false);
  }, [clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  const updatePosition = useCallback(() => {
    const anchor = wrapperRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const surface = anchor.closest<HTMLElement>(".sidebar")?.getBoundingClientRect() ?? rect;
    const width = Math.min(CARD_WIDTH, Math.max(260, window.innerWidth - VIEWPORT_MARGIN * 2));
    const height = Math.min(
      cardRef.current?.offsetHeight ?? CARD_MAX_HEIGHT,
      window.innerHeight - VIEWPORT_MARGIN * 2,
    );
    const rightSpace = window.innerWidth - surface.right - ANCHOR_GAP - VIEWPORT_MARGIN;
    const placement: CardPosition["placement"] = rightSpace >= Math.min(width, 300) ? "right" : "left";
    const desiredLeft = placement === "right" ? surface.right + ANCHOR_GAP : surface.left - ANCHOR_GAP - width;
    // Bottom-align with the row: the row sits near the bottom of the rail.
    const desiredTop = rect.bottom - height;
    setPosition({
      left: clamp(desiredLeft, VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
      top: clamp(desiredTop, VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN),
      placement,
    });
  }, []);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, status, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => updatePosition();
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeNow();
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("keydown", dismiss);
    };
  }, [closeNow, open, updatePosition]);

  return (
    <>
      <div
        className="platform-update-anchor"
        ref={wrapperRef}
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        onFocus={() => setOpen(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeNow();
        }}
        onClick={closeNow}
      >
        {children(open ? cardId : undefined)}
      </div>
      {open &&
        createPortal(
          <aside
            className={clsx("platform-update-card", `is-${position.placement}`, `is-${tone}`)}
            id={cardId}
            ref={cardRef}
            role="tooltip"
            style={{ left: position.left, top: position.top, width: CARD_WIDTH }}
            onMouseEnter={clearTimers}
            onMouseLeave={scheduleClose}
          >
            <HoverCardContent status={status} tone={tone} unreachable={unreachable} />
          </aside>,
          document.body,
        )}
    </>
  );
}

function HoverCardContent({
  status,
  tone,
  unreachable,
}: {
  status: PlatformUpdateStatus;
  tone: RowTone;
  unreachable: boolean;
}) {
  const run = status.updater.run;
  const latest = status.releases[0] ?? null;

  if (tone !== "available") {
    return (
      <>
        <div className="platform-update-card-header">
          <span className="platform-update-kicker">Platform update</span>
          <strong>
            {run.target_version ? `${PHASE_SHORT_LABEL[run.phase]} · ${run.target_version}` : PHASE_SHORT_LABEL[run.phase]}
          </strong>
          <span className="platform-update-meta">
            {unreachable && tone === "active"
              ? "The API is restarting; the connection will come back on its own."
              : run.message || "No further detail was reported."}
          </span>
        </div>
        <div className="platform-update-card-footer">
          <span>Click for progress and details</span>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="platform-update-card-header">
        <span className="platform-update-kicker">Platform update · owner only</span>
        <strong>{latest ? latest.name : `Version ${status.latest_version ?? ""}`}</strong>
        <span className="platform-update-meta">
          {latest?.published_at ? `Published ${formatPublished(latest.published_at)} · ` : ""}
          You are on {status.current_version}
          {status.releases.length > 1 ? ` · ${status.releases.length} releases behind` : ""}
        </span>
      </div>
      <div className="platform-update-card-scroll">
        {status.releases.length === 0 ? (
          <p className="platform-update-empty">Release notes were not published for this version.</p>
        ) : (
          status.releases.map((release) => (
            <section className="platform-update-release" key={release.version}>
              {status.releases.length > 1 && (
                <div className="platform-update-release-label">
                  <span>{release.version}</span>
                  {release.published_at && <small>{formatPublished(release.published_at)}</small>}
                </div>
              )}
              <ReleaseHighlights release={release} preview />
            </section>
          ))
        )}
      </div>
      <div className="platform-update-card-footer">
        <span>Click to review and install</span>
        <span>{status.updater.connected ? "One-click install ready" : "Manual steps shown in dialog"}</span>
      </div>
    </>
  );
}

function ReleaseHighlights({ release, preview = false }: { release: PlatformReleaseInfo; preview?: boolean }) {
  const content = release.highlights.trim() || release.notes.trim();
  if (!content) {
    return <p className="platform-update-empty">No release notes were provided for {release.version}.</p>;
  }
  return <Markdown content={content} deferDiagrams preview={preview} previewPageLimit={false} />;
}

// --- Dialog --------------------------------------------------------------------

function PlatformUpdateDialog({
  status,
  unreachable,
  userId,
  onClose,
  onDismissOutcome,
  onRefresh,
  onStatus,
}: {
  status: PlatformUpdateStatus;
  unreachable: boolean;
  userId: string;
  onClose: () => void;
  onDismissOutcome: () => void;
  onRefresh: () => Promise<void>;
  onStatus: (next: PlatformUpdateStatus) => void;
}) {
  const titleId = useId();
  const [busy, setBusy] = useState<"apply" | "check" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [fullNotesFor, setFullNotesFor] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const requestPendingRef = useRef(false);
  useModalFocus(dialogRef, true, onClose);

  const run = status.updater.run;
  const active = ACTIVE_PHASES.has(run.phase);
  const finished = TERMINAL_PHASES.has(run.phase);
  const latest = status.releases[0] ?? null;
  const targetVersion = latest?.version ?? status.latest_version ?? null;
  const updater = status.updater;
  const canInstall =
    status.update_available && !!targetVersion && updater.configured && updater.connected && !active && busy === null;

  async function install() {
    if (!canInstall || !targetVersion || requestPendingRef.current) return;
    requestPendingRef.current = true;
    setBusy("apply");
    setActionError(null);
    setNotice(null);
    try {
      const next = await applyPlatformUpdate(userId, targetVersion);
      onStatus(next);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The update could not be started.");
    } finally {
      requestPendingRef.current = false;
      setBusy(null);
    }
  }

  async function checkAgain() {
    if (requestPendingRef.current) return;
    requestPendingRef.current = true;
    setBusy("check");
    setActionError(null);
    setNotice(null);
    try {
      const next = await checkPlatformUpdates(userId);
      onStatus(next);
      setNotice(
        next.update_available
          ? `Release list refreshed. Newest release: ${next.latest_version ?? "unknown"}.`
          : `Release list refreshed. ${next.current_version} is the newest release.`,
      );
    } catch (error) {
      if (error instanceof ChatRequestError && error.status === 429) {
        setNotice(error.message);
        await onRefresh();
      } else {
        setActionError(error instanceof Error ? error.message : "The release check failed.");
      }
    } finally {
      requestPendingRef.current = false;
      setBusy(null);
    }
  }

  const heading = active
    ? `Updating to ${run.target_version ?? targetVersion ?? ""}`
    : finished
      ? run.phase === "succeeded"
        ? `Updated to ${run.target_version ?? ""}`
        : run.phase === "rolled_back"
          ? `Update to ${run.target_version ?? ""} rolled back`
          : `Update to ${run.target_version ?? ""} failed`
      : `Update to ${targetVersion ?? "the newest release"}`;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        className={clsx("modal platform-update-modal", `is-${active ? "active" : finished ? run.phase : "available"}`)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-icon platform-update-modal-icon">
            {active ? (
              <LoaderCircle size={20} className="is-spinning" />
            ) : finished && run.phase !== "succeeded" ? (
              <TriangleAlert size={20} />
            ) : finished ? (
              <CircleCheck size={20} />
            ) : (
              <CircleArrowUp size={20} />
            )}
          </span>
          <div>
            <h2 id={titleId}>{heading}</h2>
            <p>
              {active
                ? "The updater is applying the release. Keep this window open or come back later; the result is recorded either way."
                : finished
                  ? run.message
                  : `You are on ${status.current_version}. Installing a release keeps every account, chat, knowledge base, and setting; only the application containers change.`}
            </p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close update dialog"
            data-tooltip="Close this dialog"
            ref={closeButtonRef}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>

        <div className="modal-body platform-update-body">
          {(active || finished) && (
            <UpgradeProgress run={run} unreachable={unreachable} />
          )}

          {(active || finished) && updater.log_tail.trim() && (
            <div className="platform-update-log">
              <button className="platform-update-toggle" type="button" onClick={() => setShowLog((v) => !v)}>
                {showLog ? "Hide updater log" : "Show updater log"}
              </button>
              {showLog && <pre className="platform-update-code">{updater.log_tail.trim()}</pre>}
            </div>
          )}

          {status.update_available && status.releases.length > 0 && (
            <details
              className="platform-update-section platform-update-notes"
              open={!(active || finished)}
              key={active || finished ? "notes-collapsed" : "notes-open"}
            >
              <summary>
                <h3>What this update brings</h3>
              </summary>
              {status.releases.map((release) => (
                <article className="platform-update-release" key={release.version}>
                  <div className="platform-update-release-label">
                    <span>{release.name}</span>
                    {release.published_at && <small>Published {formatPublished(release.published_at)}</small>}
                    {release.url && (
                      <a className="platform-update-link" href={release.url} rel="noreferrer" target="_blank">
                        Release page <ExternalLink size={12} aria-hidden="true" />
                      </a>
                    )}
                  </div>
                  <ReleaseHighlights release={release} />
                  {release.notes.trim() && release.notes.trim() !== release.highlights.trim() && (
                    <button
                      className="platform-update-toggle"
                      type="button"
                      onClick={() => setFullNotesFor((current) => (current === release.version ? null : release.version))}
                    >
                      {fullNotesFor === release.version ? "Hide full release notes" : "Show full release notes"}
                    </button>
                  )}
                  {fullNotesFor === release.version && (
                    <div className="platform-update-full-notes">
                      <Markdown content={release.notes} deferDiagrams />
                    </div>
                  )}
                </article>
              ))}
            </details>
          )}

          {status.update_available && !active && !(finished && run.phase === "succeeded") && (
            <section className="platform-update-section">
              <h3>How the update runs</h3>
              <ol className="platform-update-steps">
                <li>The new images are downloaded first. If that fails, nothing changes.</li>
                <li>
                  The API and web app restart on the new release. Chats are temporarily unavailable;
                  interrupted replies may need to be sent again.
                </li>
                <li>
                  Both services are checked. If the update fails, the updater attempts to restore the
                  previous images and reports whether recovery succeeded.
                </li>
              </ol>
              <p className="muted-note">
                Existing data volumes are retained. Back up application data before updating;
                restoring previous images does not undo database migrations.
              </p>
            </section>
          )}

          {status.update_available && !active && !updater.configured && (
            <section className="platform-update-section platform-update-manual">
              <h3>Manual install on this deployment</h3>
              <p className="muted-note">
                This deployment was not started with the updater service (it is part of the release
                image stack, <code>docker-compose.release.yml</code>). Apply the release from the
                Docker host instead:
              </p>
              <pre className="platform-update-code">{manualInstallCommands(targetVersion)}</pre>
            </section>
          )}

          {status.update_available && !active && updater.configured && !updater.connected && (
            <p className="connector-config-error" role="alert">
              {updater.problem ?? "The updater sidecar is offline."} One-click install is unavailable until
              the <code>updater</code> service is running; the manual steps in{" "}
              <code>docs/DOCKER_RELEASE.md</code> still apply.
            </p>
          )}

          {actionError && (
            <p className="connector-config-error" role="alert">
              {actionError}
            </p>
          )}
          {notice && (
            <p className="platform-update-notice" role="status">
              {notice}
            </p>
          )}
        </div>

        <div className="modal-actions platform-update-actions">
          <span className="platform-update-checked">
            {status.checked_at ? `Release list checked ${formatTimestamp(status.checked_at)}` : "Release list not checked yet"}
            {status.check_error ? ` · ${status.check_error}` : ""}
          </span>
          {!active && (
            <button
              className="secondary-button"
              type="button"
              disabled={busy !== null}
              data-tooltip="Ask GitHub for the newest release list now"
              onClick={() => void checkAgain()}
            >
              <RefreshCw size={14} className={busy === "check" ? "is-spinning" : undefined} /> Check again
            </button>
          )}
          {finished && run.phase === "succeeded" ? (
            <>
              <button className="secondary-button" type="button" onClick={onDismissOutcome}>
                Dismiss
              </button>
              <button
                className="primary-button"
                type="button"
                data-tooltip="Reload the browser to load the new web build"
                onClick={() => window.location.reload()}
              >
                Reload now
              </button>
            </>
          ) : finished && !status.update_available ? (
            <button className="primary-button" type="button" onClick={onDismissOutcome}>
              Dismiss
            </button>
          ) : (
            <>
              <button className="secondary-button" type="button" onClick={onClose}>
                {active ? "Close" : "Not now"}
              </button>
              {status.update_available && !active && (
                <button
                  className="primary-button"
                  type="button"
                  disabled={!canInstall}
                  data-tooltip={
                    canInstall
                      ? `Download ${targetVersion} and restart the platform on it`
                      : "One-click install needs the updater service to be connected"
                  }
                  onClick={() => void install()}
                >
                  {busy === "apply" ? <LoaderCircle size={14} className="is-spinning" /> : <CircleArrowUp size={14} />}
                  {finished && run.phase !== "succeeded" ? `Retry ${targetVersion}` : `Install ${targetVersion}`}
                </button>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function UpgradeProgress({ run, unreachable }: { run: PlatformUpdaterRun; unreachable: boolean }) {
  const currentIndex = PHASE_STEPS.findIndex((step) => step.phases.includes(run.phase));
  const finished = TERMINAL_PHASES.has(run.phase);
  return (
    <ol className={clsx("platform-update-progress", `is-${run.phase}`)} aria-label="Update progress">
      {PHASE_STEPS.map((step, index) => {
        const state = finished
          ? run.phase === "succeeded"
            ? "done"
            : "stopped"
          : index < currentIndex
            ? "done"
            : index === currentIndex
              ? "current"
              : "pending";
        return (
          <li className={`is-${state}`} key={step.label}>
            <span className="platform-update-progress-marker" aria-hidden="true">
              {state === "done" ? <CircleCheck size={14} /> : state === "current" ? <LoaderCircle size={14} className="is-spinning" /> : null}
            </span>
            <span>
              {step.label}
              {state === "current" && (
                <small>
                  {unreachable && run.phase === "applying"
                    ? "The API is restarting; waiting for it to come back."
                    : run.message}
                </small>
              )}
            </span>
          </li>
        );
      })}
      {finished && (
        <li className={clsx("platform-update-progress-outcome", `is-${run.phase}`)}>
          <span className="platform-update-progress-marker" aria-hidden="true">
            {run.phase === "succeeded" ? <CircleCheck size={14} /> : <TriangleAlert size={14} />}
          </span>
          <span>
            {run.phase === "succeeded"
              ? `Finished ${formatTimestamp(run.finished_at)}`
              : run.phase === "rolled_back"
                ? `Rolled back to ${run.previous_version ?? "the previous release"} ${formatTimestamp(run.finished_at)}`
                : `Stopped ${formatTimestamp(run.finished_at)}`}
          </span>
        </li>
      )}
    </ol>
  );
}

function manualInstallCommands(targetVersion: string | null): string {
  const tag = targetVersion ?? "vX.Y.Z";
  return [
    `# in the project directory, set the new tag in .env`,
    `sed -i.bak 's/^APERTURE_IMAGE_TAG=.*/APERTURE_IMAGE_TAG=${tag}/' .env`,
    `docker compose -f docker-compose.release.yml pull api web`,
    `docker compose -f docker-compose.release.yml up -d api web`,
  ].join("\n");
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}
