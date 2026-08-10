import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AuthScreen } from "./AuthScreen";
import { sampleData } from "../data/sampleData";
import { loginWithAuth, setSessionToken } from "../lib/api";
import type { NormalizedLoginResponse } from "../lib/api";
import type { AuthLoginRequest } from "../lib/types";

/* Backend-shaped fixtures. Tokens satisfy the API's 32-char minimum. */
const CHALLENGE_TOKEN = "challenge-token-0123456789abcdef-0123456789abcdef";
const ENROLLMENT_TOKEN = "enrollment-token-0123456789abcdef-0123456789abcdef";
const ENROLLMENT_SECRET = "JBSWY3DPEHPK3PXP";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  setSessionToken(null);
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function mfaChallengeBody(overrides: Record<string, unknown> = {}) {
  return {
    status: "mfa_required",
    challenge_token: CHALLENGE_TOKEN,
    purpose: "verify",
    expires_at: "2026-07-20T12:00:00Z",
    methods: ["totp", "recovery_code"],
    attempts_remaining: 5,
    ...overrides,
  };
}

function serverLoginBody(sessionTokenValue: string) {
  const jane = sampleData.users.find((user) => user.id === "user-jane") ?? sampleData.me;
  return {
    user: jane,
    session: {
      user_id: jane.id,
      auth_method: "local",
      sso_config_id: null,
      token: sessionTokenValue,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      mfa_assured: true,
      mfa_factor_generation: 1,
    },
    bootstrap: {
      ...sampleData,
      me: jane,
      providerKeys: [],
      visibleUsers: sampleData.users.filter((user) => user.role !== "PLATFORM_OWNER"),
    },
    must_change_password: false,
  };
}

/** Route fetches by first matching path. Order matters: put the most specific
 * paths (e.g. enroll/confirm before enroll) first. */
function stubFetchRoutes(
  routes: Array<[string, (init?: RequestInit) => Response | Promise<Response>]>,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [path, handler] of routes) {
      if (url.includes(path)) return handler(init);
    }
    return jsonResponse({ detail: "unmatched route" }, 503);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Mirrors App.tsx handleAuthLogin: run loginWithAuth and store the exact
 * server-provided session token — the session-store path under test. */
function renderChallengeCapableAuthScreen() {
  const completedLogins: NormalizedLoginResponse[] = [];
  const loginErrors: unknown[] = [];
  const onLocalLogin = vi.fn(async (payload?: AuthLoginRequest) => {
    if (!payload) return;
    try {
      const result = await loginWithAuth(payload);
      setSessionToken(result.session?.token ?? null);
      completedLogins.push(result);
    } catch (error) {
      loginErrors.push(error);
    }
  });
  render(
    <AuthScreen
      authOptions={{ local_auth_enabled: true, password_auth_enabled: true, providers: [] }}
      onLocalLogin={onLocalLogin}
    />,
  );
  return { completedLogins, loginErrors };
}

async function signInWithPassword() {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "jane@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
  fireEvent.click(screen.getByRole("button", { name: /Sign in/ }));
}

function localStorageDump(): string {
  const entries: Record<string, string | null> = {};
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key) entries[key] = window.localStorage.getItem(key);
  }
  return JSON.stringify(entries);
}

test("HTTP 202 login renders the challenge view with server methods and attempts", async () => {
  stubFetchRoutes([["/api/auth/login", () => jsonResponse(mfaChallengeBody(), 202)]]);
  renderChallengeCapableAuthScreen();

  await signInWithPassword();

  expect(await screen.findByRole("heading", { name: "Two-step verification" })).toBeInTheDocument();
  expect(screen.getByText("5 attempts remaining")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Use a recovery code instead" })).toBeInTheDocument();
  // The pre-session challenge token must never reach browser storage.
  expect(localStorageDump()).not.toContain(CHALLENGE_TOKEN);
  expect(window.localStorage.getItem("aperture-session-token")).toBeNull();
});

test("recovery-code entry is hidden when the server omits the method", async () => {
  stubFetchRoutes([
    ["/api/auth/login", () => jsonResponse(mfaChallengeBody({ methods: ["totp"] }), 202)],
  ]);
  renderChallengeCapableAuthScreen();

  await signInWithPassword();

  expect(await screen.findByRole("heading", { name: "Two-step verification" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Use a recovery code instead" })).not.toBeInTheDocument();
});

test("verify success stores the exact server session through the login path", async () => {
  const fetchMock = stubFetchRoutes([
    ["/api/auth/login", () => jsonResponse(mfaChallengeBody(), 202)],
    ["/api/auth/mfa/preauth/verify", () => jsonResponse(serverLoginBody("mfa-verified-session-token"))],
  ]);
  const { completedLogins } = renderChallengeCapableAuthScreen();

  await signInWithPassword();
  fireEvent.change(await screen.findByLabelText("Authenticator code"), {
    target: { value: "123456" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Verify and continue" }));

  await waitFor(() => expect(completedLogins).toHaveLength(1));
  expect(completedLogins[0].session.token).toBe("mfa-verified-session-token");
  expect(window.localStorage.getItem("aperture-session-token")).toBe("mfa-verified-session-token");
  // The verify request carried the challenge token, method, and code.
  const verifyCall = fetchMock.mock.calls.find(([input]) =>
    String(input).includes("/api/auth/mfa/preauth/verify"),
  );
  expect(verifyCall).toBeDefined();
  expect(JSON.parse(String(verifyCall?.[1]?.body))).toEqual({
    challenge_token: CHALLENGE_TOKEN,
    method: "totp",
    code: "123456",
  });
  // Challenge state is cleared once the server issues the session.
  expect(screen.queryByRole("heading", { name: "Two-step verification" })).not.toBeInTheDocument();
});

test("required enrollment shows the secret and QR once and demands acknowledgement", async () => {
  stubFetchRoutes([
    [
      "/api/auth/mfa/enroll/confirm",
      () =>
        jsonResponse({
          ...serverLoginBody("enrolled-session-token"),
          recovery_codes: ["1111-2222", "3333-4444"],
        }),
    ],
    [
      "/api/auth/mfa/enroll",
      () =>
        jsonResponse(
          {
            enrollment_token: ENROLLMENT_TOKEN,
            secret: ENROLLMENT_SECRET,
            provisioning_uri: "otpauth://totp/Aperture%20Chat:jane@example.com?secret=JBSWY3DPEHPK3PXP",
            expires_at: "2026-07-20T12:10:00Z",
          },
          201,
        ),
    ],
    ["/api/auth/login", () => jsonResponse(mfaChallengeBody({ purpose: "enroll", methods: ["totp"] }), 202)],
  ]);
  const { completedLogins } = renderChallengeCapableAuthScreen();

  await signInWithPassword();
  expect(
    await screen.findByRole("heading", { name: "Set up two-step verification" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Begin authenticator setup" }));

  // Show-once secret + QR with explicit acknowledgement before confirm.
  expect(await screen.findByText(ENROLLMENT_SECRET)).toBeInTheDocument();
  expect(document.querySelector(".auth-mfa-secret-panel svg")).not.toBeNull();
  const confirmButton = screen.getByRole("button", { name: "Verify and enable MFA" });
  fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: "654321" } });
  expect(confirmButton).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(confirmButton).toBeEnabled();
  fireEvent.click(confirmButton);

  // Recovery codes shown once; continuing requires explicit acknowledgement.
  expect(await screen.findByRole("heading", { name: "Save your recovery codes" })).toBeInTheDocument();
  expect(screen.getByText("1111-2222")).toBeInTheDocument();
  expect(screen.getByText("3333-4444")).toBeInTheDocument();
  expect(screen.queryByText(ENROLLMENT_SECRET)).not.toBeInTheDocument();
  const continueButton = screen.getByRole("button", { name: "Continue to workspace" });
  expect(continueButton).toBeDisabled();
  expect(completedLogins).toHaveLength(0);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(continueButton);

  await waitFor(() => expect(completedLogins).toHaveLength(1));
  expect(completedLogins[0].session.token).toBe("enrolled-session-token");
  expect(window.localStorage.getItem("aperture-session-token")).toBe("enrolled-session-token");
  // Show-once values are gone from the document and were never persisted.
  expect(screen.queryByText("1111-2222")).not.toBeInTheDocument();
  expect(localStorageDump()).not.toContain(ENROLLMENT_SECRET);
  expect(localStorageDump()).not.toContain("1111-2222");
});

test("a 429 lockout renders the server Retry-After and blocks submission", async () => {
  stubFetchRoutes([
    ["/api/auth/login", () => jsonResponse(mfaChallengeBody(), 202)],
    [
      "/api/auth/mfa/preauth/verify",
      () =>
        jsonResponse(
          { detail: "Too many attempts. Verification is temporarily locked." },
          429,
          { "Retry-After": "37" },
        ),
    ],
  ]);
  renderChallengeCapableAuthScreen();

  await signInWithPassword();
  fireEvent.change(await screen.findByLabelText("Authenticator code"), {
    target: { value: "000000" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Verify and continue" }));

  expect(
    await screen.findByText(/Too many attempts\. Verification is temporarily locked\. Try again in 3[0-7]s\./),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Verify and continue" })).toBeDisabled();
});

test("a failed code refreshes honest challenge state from the server", async () => {
  stubFetchRoutes([
    ["/api/auth/login", () => jsonResponse(mfaChallengeBody(), 202)],
    ["/api/auth/mfa/preauth/verify", () => jsonResponse({ detail: "Invalid code." }, 401)],
    [
      "/api/auth/mfa/preauth/status",
      () =>
        jsonResponse({
          status: "mfa_required",
          purpose: "verify",
          expires_at: "2026-07-20T12:00:00Z",
          methods: ["totp"],
          attempts_remaining: 2,
        }),
    ],
  ]);
  renderChallengeCapableAuthScreen();

  await signInWithPassword();
  expect(await screen.findByText("5 attempts remaining")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: "999999" } });
  fireEvent.click(screen.getByRole("button", { name: "Verify and continue" }));

  expect(await screen.findByText("Invalid code.")).toBeInTheDocument();
  // Attempts and surviving methods come from the server, not a local counter.
  expect(await screen.findByText("2 attempts remaining")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Use a recovery code instead" })).not.toBeInTheDocument();
});
