export const apiBase = normalizeApiBase(import.meta.env.VITE_API_BASE_URL);
export const DEFAULT_CHAT_TIMEOUT_MS = normalizedPositiveNumber(import.meta.env.VITE_CHAT_TIMEOUT_MS, 75 * 60 * 1000);

function normalizeApiBase(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

function normalizedPositiveNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}


// Signed session tokens are issued by the API on every login (local or SSO) and
// replace trust in the plain user-id header. The user-id header is still sent for
// backward compatibility with dev-mode APIs (APERTURE_DEV_HEADER_AUTH_ENABLED).
const SESSION_TOKEN_STORAGE_KEY = "aperture-session-token";
let sessionToken: string | null = null;
try {
  sessionToken = window.localStorage.getItem(SESSION_TOKEN_STORAGE_KEY);
} catch {
  sessionToken = null;
}

export function setSessionToken(token: string | null): void {
  sessionToken = token;
  try {
    if (token) {
      window.localStorage.setItem(SESSION_TOKEN_STORAGE_KEY, token);
    } else {
      window.localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
    }
  } catch {
    // Private-browsing storage failures fall back to in-memory tokens.
  }
}

export function getSessionToken(): string | null {
  return sessionToken;
}

export function authHeaders(userId: string): Record<string, string> {
  const headers: Record<string, string> = { "x-aperture-user": userId };
  if (sessionToken) headers["x-aperture-session"] = sessionToken;
  return headers;
}

export class ChatRequestError extends Error {
  status?: number;
  partialText?: string;
  /**
   * True when retrying or resuming the request could plausibly succeed —
   * network drops, premature stream ends, and provider failures the API
   * marked retryable. Deterministic failures (auth, validation, unknown
   * model) stay false so they surface immediately instead of looping.
   */
  resumable: boolean;
  constructor(message: string, status?: number, partialText?: string, resumable = false) {
    super(message);
    this.name = "ChatRequestError";
    this.status = status;
    this.partialText = partialText;
    this.resumable = resumable;
  }
}

export type ApiMutationOptions = { signal?: AbortSignal };

type ApiRequestInit = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

export async function apiRequest<ResponseBody>(
  userId: string,
  path: string,
  { method = "GET", body, signal, headers: requestHeaders }: ApiRequestInit = {},
): Promise<ResponseBody> {
  // Request-scoped context (for example the active platform-owner tenant)
  // may be added by a focused API helper, but it can never replace the real
  // signed-session headers owned by this module.
  const headers: Record<string, string> = {
    ...requestHeaders,
    ...authHeaders(userId),
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ChatRequestError("The request was cancelled before the API responded.");
    }
    throw new ChatRequestError("Could not reach the API. Check your connection and try again.");
  }

  if (!response.ok) {
    throw new ChatRequestError(await readApiError(response), response.status);
  }
  if (response.status === 204) return undefined as ResponseBody;
  return (await response.json()) as ResponseBody;
}

export async function readApiError(response: Response): Promise<string> {
  const fallback = `Request failed with ${response.status}`;
  try {
    const payload = (await response.clone().json()) as unknown;
    if (isRecord(payload)) {
      const detail = payload.detail;
      if (typeof detail === "string") return detail;
      if (detail !== undefined) return JSON.stringify(detail);
    }
  } catch {
    // Fall through to the text body/fallback.
  }
  try {
    const text = await response.text();
    return text.trim() || fallback;
  } catch {
    return fallback;
  }
}

export function pathId(id: string) {
  return encodeURIComponent(id);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
