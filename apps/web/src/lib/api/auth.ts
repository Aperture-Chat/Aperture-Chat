import {
  apiBase,
  apiRequest,
  authHeaders,
  isRecord,
  readApiError,
  ChatRequestError,
  type ApiMutationOptions,
} from "./http";
import { normalizeBootstrap } from "./bootstrap";
import type {
  AccountPasswordUpdateRequest,
  AccountApiKeyCreateResponse,
  AccountApiKeyStatus,
  AccountProfileUpdateRequest,
  AuthBootstrapOwnerRequest,
  AuthLoginRequest,
  AuthLoginResponse,
  AuthOptionsResponse,
  BootstrapData,
  User,
} from "../types";

/* ---------------------------------------------------------------------------
 * TOTP multi-factor authentication (browser challenge flow).
 *
 * These types mirror services/api/app/routes/auth.py and app/models/schemas.py
 * exactly. They are deliberately declared here rather than in lib/types.ts:
 * challenge tokens, enrollment secrets, and recovery codes are pre-session,
 * show-once credentials that must never leak into BootstrapData or any
 * persistent client store. All /api/auth responses are Cache-Control: no-store;
 * nothing below caches challenge state.
 * ------------------------------------------------------------------------- */

export type MfaMethod = "totp" | "recovery_code";
export type MfaPurpose = "verify" | "enroll";

/** HTTP 202 body from POST /api/auth/login (and the restored-status variant). */
export type MfaPreauthChallenge = {
  status: "mfa_required";
  challenge_token: string;
  purpose: MfaPurpose;
  expires_at: string;
  methods: MfaMethod[];
  attempts_remaining: number;
};

/** POST /api/auth/mfa/preauth/status response (never echoes the token). */
export type MfaPreauthStatus = {
  status: "mfa_required";
  purpose: MfaPurpose;
  expires_at: string;
  methods: MfaMethod[];
  attempts_remaining: number;
};

/** POST /api/auth/mfa/enroll response. Secret and URI appear only here. */
export type MfaEnrollmentStart = {
  enrollment_token: string;
  secret: string;
  provisioning_uri: string;
  expires_at: string;
};

/** GET /api/auth/mfa/status response for a signed session. */
export type MfaAccountStatus = {
  enabled: boolean;
  tenant_required: boolean;
  confirmed_at: string | null;
  recovery_codes_remaining: number;
  can_disable: boolean;
};

/** Login responses everywhere in this module carry a normalized bootstrap. */
export type NormalizedLoginResponse = Omit<AuthLoginResponse, "bootstrap"> & {
  bootstrap: BootstrapData;
};

export type AccessRequestCreate = {
  first_name: string;
  last_name: string;
  email: string;
};

export type AccessRequestResult = {
  status: "pending";
  message: string;
};

/** Public, pre-session access request. The API always returns the same pending
 * shape for an existing email so this cannot enumerate workspace accounts. */
export async function requestWorkspaceAccess(
  payload: AccessRequestCreate,
  options: ApiMutationOptions = {},
): Promise<AccessRequestResult> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/auth/access-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(payload),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ChatRequestError("Could not reach the access request service.");
  }
  if (!response.ok) {
    throw new ChatRequestError(await readApiError(response), response.status);
  }
  return (await response.json()) as AccessRequestResult;
}

/** POST /api/auth/mfa/enroll/confirm, split so the show-once recovery codes
 * cannot be forwarded accidentally alongside the session response. */
export type MfaEnrollmentConfirmation = {
  login: NormalizedLoginResponse;
  recovery_codes: string[];
};

/** MFA endpoints report 429 lockouts with a Retry-After header; surface it
 * honestly so the interface can render the server's wait, not a guess. */
export class MfaRequestError extends ChatRequestError {
  retryAfterSeconds?: number;
  constructor(message: string, status?: number, retryAfterSeconds?: number) {
    super(message, status);
    this.name = "MfaRequestError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function isMfaChallenge(value: unknown): value is MfaPreauthChallenge {
  return (
    isRecord(value) &&
    value.status === "mfa_required" &&
    typeof value.challenge_token === "string"
  );
}

async function mfaPost<ResponseBody>(
  path: string,
  body: unknown,
  options: ApiMutationOptions = {},
  extraHeaders?: Record<string, string>,
): Promise<ResponseBody> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      cache: "no-store",
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new MfaRequestError("The verification request was cancelled before the API responded.");
    }
    throw new MfaRequestError("Could not reach multi-factor verification. Check the API connection and try again.");
  }
  if (!response.ok) {
    const retryAfterHeader = response.headers.get("Retry-After");
    const parsedRetryAfter = retryAfterHeader === null ? Number.NaN : Number.parseInt(retryAfterHeader, 10);
    throw new MfaRequestError(
      await readApiError(response),
      response.status,
      Number.isFinite(parsedRetryAfter) && parsedRetryAfter >= 0 ? parsedRetryAfter : undefined,
    );
  }
  return (await response.json()) as ResponseBody;
}

/** Restore a pending challenge's honest server state (attempts, methods, expiry). */
export function fetchMfaPreauthStatus(
  challengeToken: string,
  options: ApiMutationOptions = {},
): Promise<MfaPreauthStatus> {
  return mfaPost<MfaPreauthStatus>("/api/auth/mfa/preauth/status", { challenge_token: challengeToken }, options);
}

/** Complete an existing-factor challenge with a TOTP or recovery code. */
export async function verifyMfaChallenge(
  payload: { challenge_token: string; method: MfaMethod; code: string },
  options: ApiMutationOptions = {},
): Promise<NormalizedLoginResponse> {
  const wire = await mfaPost<AuthLoginResponse>("/api/auth/mfa/preauth/verify", payload, options);
  return { ...wire, bootstrap: normalizeBootstrap(wire.bootstrap) };
}

/** Start required first-factor enrollment from a pre-session challenge token. */
export function startMfaEnrollmentWithChallenge(
  challengeToken: string,
  options: ApiMutationOptions = {},
): Promise<MfaEnrollmentStart> {
  return mfaPost<MfaEnrollmentStart>("/api/auth/mfa/enroll", { challenge_token: challengeToken }, options);
}

/** Start voluntary enrollment from a signed local session (password re-proof).
 * SSO sessions currently receive an honest 403 from the API. */
export function startVoluntaryMfaEnrollment(
  userId: string,
  currentPassword: string,
  options: ApiMutationOptions = {},
): Promise<MfaEnrollmentStart> {
  return mfaPost<MfaEnrollmentStart>(
    "/api/auth/mfa/enroll",
    { current_password: currentPassword },
    options,
    authHeaders(userId),
  );
}

/** Confirm enrollment with the first TOTP code. Returns the MFA-assured login
 * response plus the show-once recovery codes, kept separate on purpose. */
export async function confirmMfaEnrollment(
  payload: { enrollment_token: string; code: string },
  options: ApiMutationOptions = {},
): Promise<MfaEnrollmentConfirmation> {
  const wire = await mfaPost<AuthLoginResponse & { recovery_codes: string[] }>(
    "/api/auth/mfa/enroll/confirm",
    payload,
    options,
  );
  const { recovery_codes, ...login } = wire;
  return {
    login: { ...login, bootstrap: normalizeBootstrap(login.bootstrap) },
    recovery_codes,
  };
}

/* Signed-session MFA management. Exported for completeness; no management UI
 * is wired in this pass. */

export function loadMfaAccountStatus(
  userId: string,
  options: ApiMutationOptions = {},
): Promise<MfaAccountStatus> {
  return apiRequest<MfaAccountStatus>(userId, "/api/auth/mfa/status", { signal: options.signal });
}

export function regenerateMfaRecoveryCodes(
  userId: string,
  payload: { method: MfaMethod; code: string },
  options: ApiMutationOptions = {},
): Promise<{ recovery_codes: string[] }> {
  return apiRequest<{ recovery_codes: string[] }>(userId, "/api/auth/mfa/recovery-codes/regenerate", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function disableMfa(
  userId: string,
  payload: { method: MfaMethod; code: string },
  options: ApiMutationOptions = {},
): Promise<{ status: string }> {
  return apiRequest<{ status: string }>(userId, "/api/auth/mfa/disable", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

/* ---------------------------------------------------------------------------
 * Challenge hand-off channel.
 *
 * A 202 login response is not a session. The signed-out AuthScreen registers a
 * UI handler; when the API answers a login (or an OIDC return) with a pending
 * challenge, the challenge is delivered to that handler and the original
 * caller's promise stays open until the server issues a real session through
 * verify or enroll/confirm. Callers therefore keep the exact same
 * session-storage path they use for a plain 200 login. The challenge lives
 * only in memory here — never in browser storage, telemetry, or logs.
 * ------------------------------------------------------------------------- */

type MfaChallengeUiHandler = (challenge: MfaPreauthChallenge) => Promise<NormalizedLoginResponse>;

let mfaChallengeUiHandler: MfaChallengeUiHandler | null = null;
let queuedMfaDelivery: {
  challenge: MfaPreauthChallenge;
  resolve: (result: NormalizedLoginResponse) => void;
  reject: (error: unknown) => void;
} | null = null;

/** AuthScreen registers here on mount and passes null on unmount. */
export function registerMfaChallengeUiHandler(handler: MfaChallengeUiHandler | null): void {
  mfaChallengeUiHandler = handler;
  if (handler && queuedMfaDelivery) {
    const queued = queuedMfaDelivery;
    queuedMfaDelivery = null;
    handler(queued.challenge).then(queued.resolve, queued.reject);
  }
}

function deliverMfaChallenge(challenge: MfaPreauthChallenge): Promise<NormalizedLoginResponse> {
  if (mfaChallengeUiHandler) return mfaChallengeUiHandler(challenge);
  // The challenge view may register a tick later than the caller (effect
  // ordering); hold exactly one pending delivery for it.
  return new Promise((resolve, reject) => {
    if (queuedMfaDelivery) {
      queuedMfaDelivery.reject(
        new MfaRequestError("This sign-in was superseded by a newer verification challenge."),
      );
    }
    queuedMfaDelivery = { challenge, resolve, reject };
  });
}

/** Resume a pre-session challenge conveyed by the OIDC callback's #sso_mfa
 * fragment: re-read its honest server state, then run the challenge view. */
export async function completePresessionMfaChallenge(
  challengeToken: string,
): Promise<NormalizedLoginResponse> {
  const status = await fetchMfaPreauthStatus(challengeToken);
  return deliverMfaChallenge({
    status: "mfa_required",
    challenge_token: challengeToken,
    purpose: status.purpose,
    expires_at: status.expires_at,
    methods: status.methods,
    attempts_remaining: status.attempts_remaining,
  });
}

/** Absolute URL that begins the real OIDC redirect flow for a provider. */
export function ssoAuthorizeUrl(providerId: string): string {
  const returnTo = typeof window !== "undefined" ? window.location.origin : "";
  const query = returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : "";
  return `${apiBase}/api/auth/sso/${encodeURIComponent(providerId)}/authorize${query}`;
}

/** Redirect URI that admins must register with their identity provider. */
export function ssoRedirectUri(): string {
  return `${apiBase}/api/auth/sso/callback`;
}

/** Resume a session from a stored signed token (used after the SSO redirect). */
export async function resumeSession(
  token: string,
  options: ApiMutationOptions = {},
): Promise<Omit<AuthLoginResponse, "bootstrap"> & { bootstrap: BootstrapData }> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/auth/session`, {
      headers: { "x-aperture-session": token },
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ChatRequestError("The sign-in request was cancelled before the API responded.");
    }
    throw new ChatRequestError("Could not reach the API to finish sign-in. Check the connection and try again.");
  }
  if (!response.ok) {
    throw new ChatRequestError(await readApiError(response), response.status);
  }
  const wire = (await response.json()) as AuthLoginResponse;
  return { ...wire, bootstrap: normalizeBootstrap(wire.bootstrap) };
}

export async function loadAuthOptions(options: ApiMutationOptions = {}): Promise<AuthOptionsResponse> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/auth/options`, {
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ChatRequestError("The sign-in request was cancelled before the API responded.");
    }
    throw new ChatRequestError("Could not reach sign-in configuration. Check the API connection and try again.");
  }

  if (!response.ok) {
    throw new ChatRequestError(await readApiError(response), response.status);
  }
  return (await response.json()) as AuthOptionsResponse;
}

export async function loginWithAuth(
  payload: AuthLoginRequest,
  options: ApiMutationOptions = {},
): Promise<Omit<AuthLoginResponse, "bootstrap"> & { bootstrap: BootstrapData }> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ChatRequestError("The sign-in request was cancelled before the API responded.");
    }
    throw new ChatRequestError("Could not reach sign-in. Check the API connection and try again.");
  }

  if (!response.ok) {
    throw new ChatRequestError(await readApiError(response), response.status);
  }
  const wire = (await response.json()) as AuthLoginResponse | MfaPreauthChallenge;
  if (response.status === 202 && isMfaChallenge(wire)) {
    // Primary credentials passed but the tenant's TOTP policy stands between
    // this account and a session. Hand the challenge to the mounted challenge
    // view; this promise settles only with the server's verified login
    // response, so callers keep their existing session-storage path.
    return deliverMfaChallenge(wire);
  }
  const login = wire as AuthLoginResponse;
  return { ...login, bootstrap: normalizeBootstrap(login.bootstrap) };
}

export async function bootstrapPlatformOwner(
  payload: AuthBootstrapOwnerRequest,
  options: ApiMutationOptions = {},
): Promise<Omit<AuthLoginResponse, "bootstrap"> & { bootstrap: BootstrapData }> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/auth/bootstrap-owner`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ChatRequestError("The setup request was cancelled before the API responded.");
    }
    throw new ChatRequestError("Could not reach first-owner setup. Check the API connection and try again.");
  }

  if (!response.ok) {
    throw new ChatRequestError(await readApiError(response), response.status);
  }
  const wire = (await response.json()) as AuthLoginResponse;
  return { ...wire, bootstrap: normalizeBootstrap(wire.bootstrap) };
}

export function updateAccountProfile(
  userId: string,
  payload: AccountProfileUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<User> {
  return apiRequest<User>(userId, "/api/auth/profile", {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

export function markFirstRunGuideSeen(userId: string, options: ApiMutationOptions = {}): Promise<User> {
  return apiRequest<User>(userId, "/api/auth/first-run-guide/seen", {
    method: "POST",
    signal: options.signal,
  });
}

export function updateAccountPassword(
  userId: string,
  payload: AccountPasswordUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<{ status: string }> {
  return apiRequest<{ status: string }>(userId, "/api/auth/password", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function loadAccountApiKey(
  userId: string,
  options: ApiMutationOptions = {},
): Promise<AccountApiKeyStatus> {
  return apiRequest<AccountApiKeyStatus>(userId, "/api/auth/api-key", {
    signal: options.signal,
  });
}

export function createAccountApiKey(
  userId: string,
  options: ApiMutationOptions = {},
): Promise<AccountApiKeyCreateResponse> {
  return apiRequest<AccountApiKeyCreateResponse>(userId, "/api/auth/api-key", {
    method: "POST",
    signal: options.signal,
  });
}

export function revokeAccountApiKey(
  userId: string,
  options: ApiMutationOptions = {},
): Promise<AccountApiKeyStatus> {
  return apiRequest<AccountApiKeyStatus>(userId, "/api/auth/api-key", {
    method: "DELETE",
    signal: options.signal,
  });
}

/** Token caps that apply to the signed-in user for their configured UTC periods.
 * Empty caps means no finite allocation constrains this user. */
export type MyUsageBudgetCap = {
  scope: "user" | "group";
  label: string;
  budget_period: "day" | "week" | "month" | "lifetime";
  daily_token_limit: number;
  reported_tokens: number;
  period_start: string;
  period_end: string;
};

export type MyUsageBudget = {
  caps: MyUsageBudgetCap[];
  usage_date: string;
};

export function getMyUsageBudget(userId: string): Promise<MyUsageBudget> {
  return apiRequest<MyUsageBudget>(userId, "/api/auth/me/usage-budget");
}
