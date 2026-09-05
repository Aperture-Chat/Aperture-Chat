import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AccountSecurity } from "./AccountSecurity";
import { sampleData } from "../data/sampleData";
import { getSessionToken, setSessionToken } from "../lib/api";
import type { User } from "../lib/types";

const localUser: User = { ...sampleData.users.find((user) => user.id === "user-jane")!, auth_method: "local" };
const disabled = { enabled: false, tenant_required: false, confirmed_at: null, recovery_codes_remaining: 0, can_disable: false };
const enabled = { enabled: true, tenant_required: false, confirmed_at: "2026-09-04T12:00:00Z", recovery_codes_remaining: 10, can_disable: true };
const codes = ["AAAA-BBBB-CCCC-DDDD-EEEE-FFFF", "GGGG-HHHH-JJJJ-KKKK-MMMM-NNNN"];
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
function routes(handlers: Array<[string, (init?: RequestInit) => Response | Promise<Response>]>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const route = handlers.find(([path]) => String(input).endsWith(path));
    return route ? route[1](init) : json({ detail: "Unavailable" }, 503);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); setSessionToken(null); window.localStorage.clear(); });

test("local authenticator setup requires password, verified code, and saved recovery codes", async () => {
  setSessionToken("before-enrollment");
  const guard = vi.fn();
  const fetchMock = routes([
    ["/api/auth/mfa/status", () => json(disabled)],
    ["/api/auth/mfa/enroll", () => json({ enrollment_token: "show-once-enrollment", secret: "JBSWY3DPEHPK3PXP", provisioning_uri: "otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP", expires_at: "2026-09-04T13:00:00Z" }, 201)],
    ["/api/auth/mfa/enroll/confirm", () => json({ user: localUser, bootstrap: { ...sampleData, me: localUser }, session: { user_id: localUser.id, auth_method: "local", token: "after-enrollment", mfa_assured: true }, recovery_codes: codes })],
  ]);
  render(<AccountSecurity user={localUser} onCloseGuardChange={guard} />);
  fireEvent.click(await screen.findByRole("button", { name: "Set up authenticator" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue setup" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Enter your current password");
  expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/enroll"))).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "valid-account-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue setup" }));
  expect(await screen.findByText("Setup key")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Verify authenticator" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "I added this account to my authenticator." }));
  fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Verify authenticator" }));
  expect(await screen.findByText("Save your recovery codes")).toBeInTheDocument();
  expect(getSessionToken()).toBe("after-enrollment");
  expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
  expect(guard).toHaveBeenLastCalledWith(true);
  expect(screen.queryByText("JBSWY3DPEHPK3PXP")).not.toBeInTheDocument();
  expect(JSON.stringify(window.localStorage)).not.toContain(codes[0]);
  fireEvent.click(screen.getByRole("checkbox", { name: "I stored these recovery codes somewhere safe." }));
  expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByText(codes[0])).not.toBeInTheDocument();
});

test("organization-required MFA hides disable but permits recovery-code replacement", async () => {
  routes([["/api/auth/mfa/status", () => json({ ...enabled, tenant_required: true, can_disable: false })]]);
  render(<AccountSecurity user={localUser} onSignOut={vi.fn()} />);
  expect(await screen.findByText(/Required by your organization/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Turn off verification" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Replace recovery codes" })).toBeEnabled();
});

test("SSO users receive truthful identity-provider guidance instead of unsupported enrollment", async () => {
  const fetchMock = routes([["/api/auth/mfa/status", () => json(disabled)]]);
  render(<AccountSecurity user={{ ...localUser, auth_method: "sso" }} />);
  expect(await screen.findByText(/Your organization manages sign-in/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Set up authenticator" })).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("turning off MFA requires explicit proof and signs out only after confirmed success", async () => {
  setSessionToken("assured-session");
  const onSignOut = vi.fn();
  let valid = false;
  const fetchMock = routes([
    ["/api/auth/mfa/status", () => json(enabled)],
    ["/api/auth/mfa/disable", () => valid ? json({ status: "disabled" }) : json({ detail: "The verification code is invalid." }, 401)],
  ]);
  render(<AccountSecurity user={localUser} onSignOut={onSignOut} />);
  fireEvent.click(await screen.findByRole("button", { name: "Turn off verification" }));
  fireEvent.click(screen.getByRole("button", { name: "Turn off and sign out" }));
  expect(onSignOut).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: "000000" } });
  fireEvent.click(screen.getByRole("button", { name: "Turn off and sign out" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("invalid");
  expect(getSessionToken()).toBe("assured-session");
  valid = true;
  fireEvent.click(screen.getByRole("button", { name: "Use a recovery code instead" }));
  fireEvent.change(screen.getByLabelText("Recovery code"), { target: { value: codes[0] } });
  fireEvent.click(screen.getByRole("button", { name: "Turn off and sign out" }));
  await waitFor(() => expect(onSignOut).toHaveBeenCalledOnce());
  expect(getSessionToken()).toBeNull();
  expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toEqual({ method: "recovery_code", code: codes[0] });
});

test("replacement codes remain one-time visible until explicitly acknowledged", async () => {
  routes([
    ["/api/auth/mfa/status", () => json(enabled)],
    ["/api/auth/mfa/recovery-codes/regenerate", () => json({ recovery_codes: codes })],
  ]);
  const guard = vi.fn();
  render(<AccountSecurity user={localUser} onCloseGuardChange={guard} />);
  fireEvent.click(await screen.findByRole("button", { name: "Replace recovery codes" }));
  expect(screen.getByText(/Your old recovery codes will stop working/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Create new recovery codes" }));
  expect(await screen.findByText(codes[0])).toBeInTheDocument();
  expect(guard).toHaveBeenLastCalledWith(true);
  expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Copy recovery codes" }));
  expect(await screen.findByRole("status")).toHaveTextContent(/Copy was unavailable|Codes copied/);
});

test("security status failure is retriable and never appears as verification disabled", async () => {
  let available = false;
  routes([["/api/auth/mfa/status", () => available ? json(enabled) : json({ detail: "Security settings unavailable." }, 503)]]);
  render(<AccountSecurity user={localUser} />);
  const retry = await screen.findByRole("button", { name: "Retry security settings" });
  expect(screen.queryByText("Off")).not.toBeInTheDocument();
  available = true;
  fireEvent.click(retry);
  expect(await screen.findByText("On")).toBeInTheDocument();
});

test("changing accounts removes in-progress enrollment secrets", async () => {
  routes([
    ["/api/auth/mfa/status", () => json(disabled)],
    ["/api/auth/mfa/enroll", () => json({ enrollment_token: "private-token", secret: "PRIVATE-SHOW-ONCE-KEY", provisioning_uri: "otpauth://totp/Example?secret=ABC", expires_at: "2026-09-04T13:00:00Z" }, 201)],
  ]);
  const { rerender } = render(<AccountSecurity user={localUser} />);
  fireEvent.click(await screen.findByRole("button", { name: "Set up authenticator" }));
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "valid-account-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue setup" }));
  expect(await screen.findByText("PRIVATE-SHOW-ONCE-KEY")).toBeInTheDocument();
  rerender(<AccountSecurity user={{ ...localUser, id: "another-user" }} />);
  expect(screen.queryByText("PRIVATE-SHOW-ONCE-KEY")).not.toBeInTheDocument();
});

test("enrollment completion cannot restore a signed-out account after the panel unmounts", async () => {
  setSessionToken("session-before-setup");
  let confirm!: (response: Response) => void;
  routes([
    ["/api/auth/mfa/status", () => json(disabled)],
    ["/api/auth/mfa/enroll", () => json({ enrollment_token: "private-enrollment", secret: "PRIVATE-KEY", provisioning_uri: "otpauth://totp/Example?secret=ABC", expires_at: "2026-09-04T13:00:00Z" }, 201)],
    ["/api/auth/mfa/enroll/confirm", () => new Promise<Response>((resolve) => { confirm = resolve; })],
  ]);
  const guard = vi.fn();
  const { unmount } = render(<AccountSecurity user={localUser} onCloseGuardChange={guard} />);
  fireEvent.click(await screen.findByRole("button", { name: "Set up authenticator" }));
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "account-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue setup" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "I added this account to my authenticator." }));
  fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Verify authenticator" }));
  unmount();
  setSessionToken(null);
  confirm(json({ user: localUser, bootstrap: { ...sampleData, me: localUser }, session: { user_id: localUser.id, auth_method: "local", token: "late-session", mfa_assured: true }, recovery_codes: codes }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(getSessionToken()).toBeNull();
  expect(guard).toHaveBeenLastCalledWith(false);
});
