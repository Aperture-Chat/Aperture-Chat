import { apiBase, authHeaders } from "./api";

export type ServerTime = { iso: string; unix: number; timezone: string };
export type PlatformTimestamp = ServerTime & { label: string; source: "server" | "local-fallback" };

/**
 * Authoritative platform time from the API. Prefer this over the device clock
 * for anything the platform records or schedules, so run-time metadata is
 * consistent regardless of a user's local clock.
 */
export async function fetchServerTime(userId: string, signal?: AbortSignal): Promise<ServerTime> {
  const response = await fetch(`${apiBase}/api/time`, { headers: authHeaders(userId), signal });
  if (!response.ok) throw new Error(`Could not read platform time (HTTP ${response.status}).`);
  return (await response.json()) as ServerTime;
}

export async function platformTimestamp(userId: string, signal?: AbortSignal): Promise<PlatformTimestamp> {
  try {
    const server = await fetchServerTime(userId, signal);
    return { ...server, label: formatTimeLabel(server.iso), source: "server" };
  } catch {
    const fallback = new Date();
    const unix = Math.floor(fallback.getTime() / 1000);
    return {
      iso: fallback.toISOString(),
      unix,
      timezone: "local-fallback",
      label: formatTimeLabel(fallback.toISOString()),
      source: "local-fallback",
    };
  }
}

export function formatTimeLabel(iso: string | null | undefined): string {
  if (!iso) return "Just now";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Just now";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Render an ISO timestamp in the viewer's locale and timezone. Returns "—" for
 * empty input so callers can pass optional timestamps directly.
 */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
