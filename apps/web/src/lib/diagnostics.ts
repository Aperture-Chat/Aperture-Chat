import type { IssueReportDiagnostics } from "./types";

/**
 * A small in-memory trail of what went wrong in this tab, so a problem report
 * can carry the error the person actually saw. Nothing is stored or sent
 * until someone submits a report with "Include technical details" checked,
 * and the server bounds and re-checks every field it receives.
 *
 * Only metadata is kept: error messages, script file names, and the method,
 * path, and status of failed API calls. Never request or response bodies.
 */

const MAX_ERRORS = 8;
const MAX_FAILURES = 10;

type ErrorEntry = { message: string; source?: string; at: string };
type FailureEntry = { method: string; path: string; status: number; at: string };

const recentErrors: ErrorEntry[] = [];
const failedRequests: FailureEntry[] = [];
let installed = false;

function push<T>(list: T[], entry: T, max: number) {
  list.push(entry);
  if (list.length > max) list.splice(0, list.length - max);
}

function scriptName(source: string | undefined): string | undefined {
  if (!source) return undefined;
  const clean = source.split(/[?#]/, 1)[0];
  return clean.slice(clean.lastIndexOf("/") + 1).slice(0, 120) || undefined;
}

export function recordClientError(message: unknown, source?: string) {
  const text = message instanceof Error ? `${message.name}: ${message.message}` : String(message ?? "");
  const trimmed = text.replace(/\s+/g, " ").trim().slice(0, 300);
  if (!trimmed) return;
  push(recentErrors, { message: trimmed, source: scriptName(source), at: new Date().toISOString() }, MAX_ERRORS);
}

export function recordApiFailure(method: string, path: string, status: number) {
  // The issue-report endpoints themselves are not useful evidence.
  if (path.startsWith("/api/issue-reports")) return;
  push(
    failedRequests,
    {
      method: method.toUpperCase(),
      path: path.split("?", 1)[0].slice(0, 200),
      status,
      at: new Date().toISOString(),
    },
    MAX_FAILURES,
  );
}

export function installDiagnosticsCapture() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (event) => {
    recordClientError(event.error ?? event.message, event.filename);
  });
  window.addEventListener("unhandledrejection", (event) => {
    recordClientError(event.reason);
  });
}

export function collectDiagnostics(): IssueReportDiagnostics {
  const prefersDark =
    typeof document !== "undefined" && document.documentElement.classList.contains("theme-dark");
  let timezone: string | undefined;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    timezone = undefined;
  }
  return {
    route: typeof window !== "undefined" ? window.location.pathname : undefined,
    viewport: typeof window !== "undefined" ? `${window.innerWidth}x${window.innerHeight}` : undefined,
    pixel_ratio: typeof window !== "undefined" ? window.devicePixelRatio : undefined,
    user_agent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
    language: typeof navigator !== "undefined" ? navigator.language : undefined,
    timezone,
    color_scheme: prefersDark ? "dark" : "light",
    online: typeof navigator !== "undefined" ? navigator.onLine : undefined,
    recent_errors: recentErrors.slice(),
    failed_requests: failedRequests.slice(),
  };
}

/** Test hook: start each test with an empty trail. */
export function resetDiagnosticsForTests() {
  recentErrors.length = 0;
  failedRequests.length = 0;
}
