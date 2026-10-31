import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AppShell } from "./AppShell";
import { sampleData } from "../data/sampleData";
import { setSessionToken } from "../lib/api";
import type { BootstrapData } from "../lib/types";

const recoveryCodes = ["AAAA-BBBB-CCCC-DDDD-EEEE-FFFF"];
function json(body: unknown) { return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }); }
function renderAccount(onRequestSignOut?: () => void) {
  const data = structuredClone(sampleData) as BootstrapData;
  data.me = { ...data.me, auth_method: "local", role: "PLATFORM_OWNER" };
  const onSignOut = vi.fn();
  const onViewChange = vi.fn();
  const onViewAsRoleChange = vi.fn();
  render(<AppShell data={data} actualRole="PLATFORM_OWNER" viewAsRole={null} onViewAsRoleChange={onViewAsRoleChange}
    currentView="chat" onViewChange={onViewChange} darkMode={false} onToggleDarkMode={vi.fn()}
    threads={[]} activeChatId="chat-new" onOpenChat={vi.fn()} onNewChat={vi.fn()} onTogglePin={vi.fn()}
    onArchiveThread={vi.fn()} onRestoreThread={vi.fn()} onDeleteThread={vi.fn()} onMoveThreadToFolder={vi.fn()}
    onSignOut={onSignOut} onRequestSignOut={onRequestSignOut}><div>Workspace</div></AppShell>);
  fireEvent.click(screen.getByRole("button", { name: /Account:/ }));
  return { onSignOut, onViewChange, onViewAsRoleChange };
}
function mockSecurity(regenerate: () => Response | Promise<Response> = () => json({ recovery_codes: recoveryCodes })) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/auth/mfa/status")) return json({ enabled: true, tenant_required: false, confirmed_at: null, recovery_codes_remaining: 10, can_disable: true });
    if (url.endsWith("/api/auth/mfa/recovery-codes/regenerate")) return regenerate();
    return json({ caps: [], usage_date: "2026-09-04" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); setSessionToken(null); window.localStorage.clear(); });

test("security-driven sign-out bypasses the voluntary workspace recovery guard", async () => {
  mockSecurity();
  const onRequestSignOut = vi.fn();
  const { onSignOut } = renderAccount(onRequestSignOut);
  fireEvent.click(screen.getByRole("button", { name: "Manage security" }));
  fireEvent.click(await screen.findByRole("button", { name: "Turn off verification" }));
  fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Turn off and sign out" }));
  await waitFor(() => expect(onSignOut).toHaveBeenCalledOnce());
  expect(onRequestSignOut).not.toHaveBeenCalled();
});

test("the security panel stays collapsed until asked, with its summary already live", async () => {
  mockSecurity();
  renderAccount();
  expect(screen.getByRole("button", { name: "Manage security" })).toHaveAttribute("aria-expanded", "false");
  expect(await screen.findByText("On · 10 recovery codes left")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Two-step verification" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Manage security" }));
  expect(await screen.findByRole("button", { name: "Replace recovery codes" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close security" }));
  expect(screen.queryByRole("heading", { name: "Two-step verification" })).not.toBeInTheDocument();
});

test("pending security mutations and unsaved recovery codes guard all drawer exits", async () => {
  let finish!: (response: Response) => void;
  mockSecurity(() => new Promise<Response>((resolve) => { finish = resolve; }));
  const { onSignOut, onViewChange, onViewAsRoleChange } = renderAccount();
  fireEvent.click(screen.getByRole("button", { name: "Manage security" }));
  fireEvent.click(await screen.findByRole("button", { name: "Replace recovery codes" }));
  fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: "123456" } });
  const account = screen.getByRole("dialog", { name: "Account" });
  const signOut = within(account).getByRole("button", { name: /Sign out/ });
  const consoleButton = within(account).getByRole("button", { name: /Platform owner console Providers/ });
  const previewButton = within(account).getByRole("radio", { name: "User" });
  fireEvent.click(screen.getByRole("button", { name: "Create new recovery codes" }));
  expect(screen.getByRole("button", { name: "Close security" })).toBeDisabled();
  expect(within(account).getByRole("button", { name: "Close", exact: true })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Close drawer" })).toBeDisabled();
  const blockedUnload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(blockedUnload);
  expect(blockedUnload.defaultPrevented).toBe(true);
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  fireEvent.click(signOut);
  fireEvent.click(consoleButton);
  fireEvent.click(previewButton);
  expect(onSignOut).not.toHaveBeenCalled();
  expect(onViewChange).not.toHaveBeenCalled();
  expect(onViewAsRoleChange).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "Account" })).toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: /Search/ })).not.toBeInTheDocument();
  finish(json({ recovery_codes: recoveryCodes }));
  expect(await screen.findByText(recoveryCodes[0])).toBeInTheDocument();
  expect(within(account).getByRole("button", { name: "Close", exact: true })).toBeDisabled();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.getByRole("dialog", { name: "Account" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "I stored these recovery codes somewhere safe." }));
  await waitFor(() => expect(within(account).getByRole("button", { name: "Close", exact: true })).toBeEnabled());
  const acknowledgedUnload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(acknowledgedUnload);
  expect(acknowledgedUnload.defaultPrevented).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(within(account).getByRole("button", { name: "Close", exact: true }));
  expect(screen.queryByRole("dialog", { name: "Account" })).not.toBeInTheDocument();
});

function mockEnrollment() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/auth/mfa/status")) return json({ enabled: false, tenant_required: false, confirmed_at: null, recovery_codes_remaining: 0, can_disable: false });
    return json({ caps: [], usage_date: "2026-09-04" });
  }));
}

test("Escape leaves an untouched security step without leaving the drawer", async () => {
  mockEnrollment();
  renderAccount();
  const account = screen.getByRole("dialog", { name: "Account" });
  fireEvent.click(within(account).getByRole("button", { name: "Manage security" }));
  fireEvent.click(await within(account).findByRole("button", { name: "Set up authenticator" }));
  await within(account).findByLabelText("Current password");
  (document.activeElement as HTMLElement).blur();

  fireEvent.keyDown(document, { key: "Escape" });

  expect(await within(account).findByRole("button", { name: "Set up authenticator" })).toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "Account" })).toBeInTheDocument();
});

test("Escape keeps a password typed into a security step", async () => {
  mockEnrollment();
  renderAccount();
  const account = screen.getByRole("dialog", { name: "Account" });
  fireEvent.click(within(account).getByRole("button", { name: "Manage security" }));
  fireEvent.click(await within(account).findByRole("button", { name: "Set up authenticator" }));
  fireEvent.change(await within(account).findByLabelText("Current password"), { target: { value: "half-typed" } });

  fireEvent.keyDown(document, { key: "Escape" });

  expect(within(account).getByLabelText("Current password")).toHaveValue("half-typed");
  expect(within(account).getByText("Unsaved changes. Choose Cancel to discard them.")).toBeInTheDocument();
});
