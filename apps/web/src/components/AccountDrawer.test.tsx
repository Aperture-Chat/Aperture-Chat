import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { sampleData } from "../data/sampleData";
import { ChatRequestError, setSessionToken } from "../lib/api";
import type { BootstrapData, ChatThread, Role, User } from "../lib/types";
import { AppShell } from "./AppShell";

type ShellProps = ComponentProps<typeof AppShell>;

const usage = {
  period_start: "2026-10-01",
  period_end: "2026-10-31",
  resets_at: "2026-11-01T00:00:00Z",
  requests: 7,
  chats: 3,
  total_tokens: 4200,
  tokens_reported_requests: 7,
};
const mfaOff = { enabled: false, tenant_required: false, confirmed_at: null, recovery_codes_remaining: 0, can_disable: false };
const mfaOn = { enabled: true, tenant_required: false, confirmed_at: null, recovery_codes_remaining: 10, can_disable: true };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockApi(routes: Record<string, () => Response | Promise<Response>> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const route = Object.keys(routes).find((path) => url.endsWith(path));
    if (route) return routes[route]();
    if (url.endsWith("/api/auth/me/usage-summary")) return json(usage);
    if (url.endsWith("/api/auth/mfa/status")) return json(mfaOff);
    return json({ caps: [], usage_date: "2026-10-30" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function shellProps(me: Partial<User>, actualRole: Role, overrides: Partial<ShellProps> = {}): ShellProps {
  const data = structuredClone(sampleData) as BootstrapData;
  data.me = { ...data.me, auth_method: "local", ...me };
  return {
    data,
    actualRole,
    viewAsRole: null,
    onViewAsRoleChange: vi.fn(),
    currentView: "chat",
    onViewChange: vi.fn(),
    darkMode: false,
    onToggleDarkMode: vi.fn(),
    threads: [],
    activeChatId: "chat-new",
    onOpenChat: vi.fn(),
    onNewChat: vi.fn(),
    onTogglePin: vi.fn(),
    onArchiveThread: vi.fn(),
    onRestoreThread: vi.fn(),
    onDeleteThread: vi.fn(),
    onMoveThreadToFolder: vi.fn(),
    onSignOut: vi.fn(),
    ...overrides,
  } as ShellProps;
}

function openAccount(me: Partial<User> = {}, actualRole: Role = "TENANT_ADMIN", overrides: Partial<ShellProps> = {}) {
  const props = shellProps({ role: actualRole, ...me }, actualRole, overrides);
  const view = render(<AppShell {...props}><div>Workspace</div></AppShell>);
  fireEvent.click(screen.getByRole("button", { name: /Account:/ }));
  return { ...view, props, drawer: screen.getByRole("dialog", { name: "Account" }) };
}

function thread(id: string, extra: Partial<ChatThread> = {}): ChatThread {
  return {
    id, tenant_id: "tenant-example", owner_user_id: "user-admin", title: `Thread ${id}`,
    model_id: "openrouter-openai-gpt-4o-mini", group_id: "group-litigation", pinned: false,
    used_agent: false, updated_at: "Just now", messages: [], ...extra,
  } as ChatThread;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSessionToken(null);
  window.localStorage.clear();
});

test("usage comes from the server ledger, never from the messages in this browser", async () => {
  mockApi();
  const old = thread("old", {
    archived: true,
    messages: Array.from({ length: 40 }, (_, index) => ({
      id: `m-${index}`, role: index % 2 ? "assistant" : "user", content: "Older chat text.", createdAt: "9:00 AM", status: "ok",
    })) as ChatThread["messages"],
  });
  const { drawer } = openAccount({}, "TENANT_ADMIN", { threads: [old] });

  const section = within(drawer).getByRole("region", { name: "Usage this month" });
  expect(await within(section).findByText("Requests")).toBeInTheDocument();
  expect(within(section).getByText("7")).toBeInTheDocument();
  expect(within(section).getByText("Chats")).toBeInTheDocument();
  expect(within(section).getByText("3")).toBeInTheDocument();
  expect(within(section).getByText("Tokens")).toBeInTheDocument();
  expect(within(section).getByText("4,200")).toBeInTheDocument();
  expect(within(drawer).queryByText("prompts")).not.toBeInTheDocument();
  expect(within(drawer).queryByText("est. tokens")).not.toBeInTheDocument();
});

test("usage says when the month resets, and reads the date in UTC", async () => {
  mockApi();
  const { drawer } = openAccount();

  expect(await within(drawer).findByText("Resets Nov 1 UTC")).toBeInTheDocument();
});

test("usage shows Not reported instead of inventing a token count", async () => {
  mockApi({ "/api/auth/me/usage-summary": () => json({ ...usage, total_tokens: null, tokens_reported_requests: 0 }) });
  const { drawer } = openAccount();

  expect(await within(drawer).findByText("Not reported")).toBeInTheDocument();
});

test("usage says how much of the token total is backed by provider reports", async () => {
  mockApi({ "/api/auth/me/usage-summary": () => json({ ...usage, tokens_reported_requests: 5 }) });
  const { drawer } = openAccount();

  expect(await within(drawer).findByText(/Tokens reported for 5 of 7 requests\./)).toBeInTheDocument();
});

test("usage says it is loading, not failed, while it waits", () => {
  mockApi({ "/api/auth/me/usage-summary": () => new Promise<Response>(() => {}) });
  const { drawer } = openAccount();

  expect(within(drawer).getByText("Loading usage…")).toBeInTheDocument();
  expect(within(drawer).queryByText("Usage is unavailable right now.")).not.toBeInTheDocument();
});

test("a usage failure says so instead of showing zeros", async () => {
  mockApi({ "/api/auth/me/usage-summary": () => json({ detail: "nope" }, 503) });
  const { drawer } = openAccount();

  await waitFor(() => expect(within(drawer).queryByText("Loading usage…")).not.toBeInTheDocument());
  expect(within(drawer).getByText("Usage is unavailable right now.")).toBeInTheDocument();
  expect(within(drawer).queryByText("Requests")).not.toBeInTheDocument();
});

test("a usage response that cannot be read counts as a failure, not a crash", async () => {
  mockApi({ "/api/auth/me/usage-summary": () => json({ caps: [] }) });
  const { drawer } = openAccount();

  expect(await within(drawer).findByText("Usage is unavailable right now.")).toBeInTheDocument();
});

test("usage refreshes when a reply finishes while the drawer stays open", async () => {
  let requests = 1;
  const fetchMock = mockApi({ "/api/auth/me/usage-summary": () => json({ ...usage, requests: requests }) });
  const pending = thread("a", { messages: [{ id: "r", role: "assistant", content: "", createdAt: "9:00 AM", status: "pending" }] as ChatThread["messages"] });
  const props = shellProps({ role: "TENANT_ADMIN" }, "TENANT_ADMIN", { threads: [pending] });
  const { rerender } = render(<AppShell {...props}><div /></AppShell>);
  fireEvent.click(screen.getByRole("button", { name: /Account:/ }));
  const section = within(screen.getByRole("dialog", { name: "Account" })).getByRole("region", { name: "Usage this month" });
  expect(await within(section).findByText("1")).toBeInTheDocument();

  requests = 2;
  const finished = thread("a", { messages: [{ id: "r", role: "assistant", content: "Done", createdAt: "9:00 AM", status: "ok" }] as ChatThread["messages"] });
  rerender(<AppShell {...props} threads={[finished]}><div /></AppShell>);

  expect(await within(section).findByText("2")).toBeInTheDocument();
  expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/usage-summary"))).toHaveLength(2);
});

test("a role preview does not change the Role shown for the signed-in account", () => {
  mockApi();
  const { drawer } = openAccount({ role: "USER" }, "PLATFORM_OWNER", { viewAsRole: "USER" });

  const facts = within(drawer).getByRole("list", { name: "Account details" });
  expect(within(facts).getByText("Platform Owner")).toBeInTheDocument();
  expect(within(drawer).getByText(/Previewing User/)).toBeInTheDocument();
});

test("sign-in method reads in plain words", () => {
  mockApi();
  const { drawer, unmount } = openAccount({ auth_method: "local" });
  expect(within(within(drawer).getByRole("list", { name: "Account details" })).getByText("Password")).toBeInTheDocument();
  unmount();

  const sso = openAccount({ auth_method: "sso" });
  expect(within(within(sso.drawer).getByRole("list", { name: "Account details" })).getByText("Single sign-on")).toBeInTheDocument();
  expect(within(sso.drawer).queryByText("local")).not.toBeInTheDocument();
});

test("SSO accounts do not get a password control", () => {
  mockApi();
  const { drawer } = openAccount({ auth_method: "sso" });

  expect(within(drawer).queryByText("Password")).not.toBeInTheDocument();
  expect(within(drawer).queryByRole("button", { name: /Change password/ })).not.toBeInTheDocument();
});

test("the firm field is labelled as a firm, not a position", () => {
  mockApi();
  const { drawer } = openAccount({ firm_name: "Example Corporation Founder" });

  const identity = within(drawer).getByRole("region", { name: "Your profile" });
  expect(within(identity).getByText("Firm")).toBeInTheDocument();
  expect(within(identity).queryByText("Position")).not.toBeInTheDocument();
});

test("the security summary is live before the panel opens and follows changes made inside it", async () => {
  let status = mfaOn;
  mockApi({
    "/api/auth/mfa/status": () => json(status),
    "/api/auth/mfa/recovery-codes/regenerate": () => {
      status = { ...mfaOn, recovery_codes_remaining: 2 };
      return json({ recovery_codes: ["AAAA-1", "BBBB-2"] });
    },
  });
  const { drawer } = openAccount();

  expect(await within(drawer).findByText("On · 10 recovery codes left")).toBeInTheDocument();

  fireEvent.click(within(drawer).getByRole("button", { name: "Manage security" }));
  fireEvent.click(await within(drawer).findByRole("button", { name: "Replace recovery codes" }));
  fireEvent.change(within(drawer).getByLabelText("Authenticator code"), { target: { value: "123456" } });
  fireEvent.click(within(drawer).getByRole("button", { name: "Create new recovery codes" }));

  expect(await within(drawer).findByText("On · 2 recovery codes left")).toBeInTheDocument();
});

test("an account without two-step verification says it is off", async () => {
  mockApi();
  const { drawer } = openAccount();

  expect(await within(drawer).findByText("Off")).toBeInTheDocument();
});

test("a running security flow makes every other drawer control inert", async () => {
  let finish!: (response: Response) => void;
  mockApi({
    "/api/auth/mfa/status": () => json(mfaOn),
    "/api/auth/mfa/recovery-codes/regenerate": () => new Promise<Response>((resolve) => { finish = resolve; }),
  });
  const { drawer } = openAccount();
  fireEvent.click(within(drawer).getByRole("button", { name: "Manage security" }));
  fireEvent.click(await within(drawer).findByRole("button", { name: "Replace recovery codes" }));
  fireEvent.change(within(drawer).getByLabelText("Authenticator code"), { target: { value: "123456" } });
  fireEvent.click(within(drawer).getByRole("button", { name: "Create new recovery codes" }));

  await waitFor(() => expect(within(drawer).getByRole("button", { name: "Close security" })).toBeDisabled());
  expect(within(drawer).getByRole("button", { name: /Sign out/ }).closest("[inert]")).not.toBeNull();
  expect(within(drawer).getByRole("button", { name: /Change password/ }).closest("[inert]")).not.toBeNull();
  expect(within(drawer).getByRole("button", { name: /Edit account profile/ }).closest("[inert]")).not.toBeNull();
  expect(within(drawer).getByLabelText("Authenticator code").closest("[inert]")).toBeNull();

  await act(async () => { finish(json({ recovery_codes: ["AAAA-1"] })); });
});

test("View as is a rail of short labels that returns to the real role", () => {
  mockApi();
  const onViewAsRoleChange = vi.fn();
  const { drawer } = openAccount({}, "PLATFORM_OWNER", { onViewAsRoleChange });

  const rail = within(drawer).getByRole("radiogroup", { name: "Preview role" });
  expect(within(rail).getAllByRole("radio").map((option) => option.textContent)).toEqual(["Owner", "Admin", "User"]);
  expect(within(rail).getByRole("radio", { name: "Owner" })).toHaveAttribute("aria-checked", "true");

  fireEvent.click(within(rail).getByRole("radio", { name: "User" }));
  expect(onViewAsRoleChange).toHaveBeenLastCalledWith("USER");
});

test("the rail hands back to the real role when a preview ends", () => {
  mockApi();
  const onViewAsRoleChange = vi.fn();
  const { drawer } = openAccount({ role: "USER" }, "PLATFORM_OWNER", { viewAsRole: "USER", onViewAsRoleChange });

  const rail = within(drawer).getByRole("radiogroup", { name: "Preview role" });
  fireEvent.click(within(rail).getByRole("radio", { name: "Owner" }));

  expect(onViewAsRoleChange).toHaveBeenLastCalledWith(null);
});

test("people without a preview choice do not see View as", () => {
  mockApi();
  const { drawer } = openAccount({ role: "USER" }, "USER");

  expect(within(drawer).queryByText("View as")).not.toBeInTheDocument();
  expect(within(drawer).queryByRole("radiogroup", { name: "Preview role" })).not.toBeInTheDocument();
});

test("permanent delete asks inside the row and only then deletes", () => {
  mockApi();
  const confirm = vi.spyOn(window, "confirm");
  const onDeleteThread = vi.fn();
  const archived = thread("gone", { archived: true, title: "Old matter" });
  const { drawer } = openAccount({}, "TENANT_ADMIN", { threads: [archived], onDeleteThread });

  fireEvent.click(within(drawer).getByRole("button", { name: /View archived chats/ }));
  fireEvent.click(within(drawer).getByRole("button", { name: "Permanently delete Old matter" }));
  expect(onDeleteThread).not.toHaveBeenCalled();
  expect(within(drawer).getByText(/cannot be undone/)).toBeInTheDocument();

  fireEvent.click(within(drawer).getByRole("button", { name: "Keep Old matter" }));
  expect(within(drawer).queryByText(/cannot be undone/)).not.toBeInTheDocument();
  expect(onDeleteThread).not.toHaveBeenCalled();

  fireEvent.click(within(drawer).getByRole("button", { name: "Permanently delete Old matter" }));
  fireEvent.click(within(drawer).getByRole("button", { name: "Delete Old matter forever" }));
  expect(onDeleteThread).toHaveBeenCalledWith("gone");
  expect(confirm).not.toHaveBeenCalled();
});

test("answering Keep puts focus back on the key that asked", async () => {
  mockApi();
  const status = { enabled: true, has_key: true, masked_value: "sk-…abcd", created_at: "2026-10-01T00:00:00Z", last_used_at: null };
  const archived = thread("gone", { archived: true, title: "Old matter" });
  const { drawer } = openAccount({}, "TENANT_ADMIN", {
    threads: [archived], onApiKeyLoad: vi.fn().mockResolvedValue(status), onApiKeyCreate: vi.fn(), onApiKeyRevoke: vi.fn(),
  });

  fireEvent.click(within(drawer).getByRole("button", { name: /View archived chats/ }));
  fireEvent.click(within(drawer).getByRole("button", { name: "Permanently delete Old matter" }));
  expect(within(drawer).getByRole("button", { name: "Keep Old matter" })).toHaveFocus();
  fireEvent.click(within(drawer).getByRole("button", { name: "Keep Old matter" }));
  expect(within(drawer).getByRole("button", { name: "Permanently delete Old matter" })).toHaveFocus();

  fireEvent.click(await within(drawer).findByText("API access"));
  fireEvent.click(await within(drawer).findByRole("button", { name: "Rotate key" }));
  fireEvent.click(within(drawer).getByRole("button", { name: "Keep key" }));
  expect(within(drawer).getByRole("button", { name: "Rotate key" })).toHaveFocus();
  fireEvent.click(within(drawer).getByRole("button", { name: "Revoke" }));
  fireEvent.click(within(drawer).getByRole("button", { name: "Keep key" }));
  expect(within(drawer).getByRole("button", { name: "Revoke" })).toHaveFocus();
});

test("closing a form puts focus back on the key that opened it", async () => {
  mockApi();
  const onProfileUpdate = vi.fn().mockResolvedValue(undefined);
  const { drawer } = openAccount({}, "TENANT_ADMIN", { onProfileUpdate, onPasswordUpdate: vi.fn() });

  fireEvent.click(within(drawer).getByRole("button", { name: /Edit account profile/ }));
  fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
  expect(within(drawer).getByRole("button", { name: /Edit account profile/ })).toHaveFocus();

  fireEvent.click(within(drawer).getByRole("button", { name: /Edit account profile/ }));
  fireEvent.click(within(drawer).getByRole("button", { name: "Save profile" }));
  await waitFor(() => expect(within(drawer).getByRole("button", { name: /Edit account profile/ })).toHaveFocus());

  fireEvent.click(within(drawer).getByRole("button", { name: "Change password" }));
  fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
  expect(within(drawer).getByRole("button", { name: "Change password" })).toHaveFocus();
});

test("the profile editor replaces the summary, so one avatar shows", () => {
  mockApi();
  const { drawer } = openAccount({}, "TENANT_ADMIN", { onProfileUpdate: vi.fn() });
  expect(drawer.querySelectorAll(".avatar")).toHaveLength(1);

  fireEvent.click(within(drawer).getByRole("button", { name: /Edit account profile/ }));

  expect(drawer.querySelectorAll(".avatar")).toHaveLength(1);
  expect(within(drawer).queryByRole("list", { name: "Account details" })).not.toBeInTheDocument();
});

test("usage explains what a request is", async () => {
  mockApi();
  const { drawer } = openAccount();

  expect(await within(drawer).findByText(/including automatic chat titles/)).toBeInTheDocument();
});

test("an empty archive explains itself when opened", () => {
  mockApi();
  const { drawer } = openAccount();

  expect(within(drawer).getByText("Chats you archive are kept here")).toBeInTheDocument();
  fireEvent.click(within(drawer).getByRole("button", { name: /View archived chats/ }));

  expect(within(drawer).getByText(/No archived chats\./)).toBeInTheDocument();
  expect(within(drawer).queryByRole("list", { name: "Archived chats" })).not.toBeInTheDocument();
});

test("archived chats report their count and restore through the shell", () => {
  mockApi();
  const onRestoreThread = vi.fn();
  const threads = [thread("a", { archived: true }), thread("b", { archived: true }), thread("c")];
  const { drawer } = openAccount({}, "TENANT_ADMIN", { threads, onRestoreThread });

  expect(within(drawer).getByText("2 archived chats")).toBeInTheDocument();
  fireEvent.click(within(drawer).getByRole("button", { name: /View archived chats/ }));
  fireEvent.click(within(drawer).getByRole("button", { name: "Restore Thread a" }));

  expect(onRestoreThread).toHaveBeenCalledWith("a");
});

test("rotating and revoking an API key ask inside the card first", async () => {
  mockApi();
  const confirm = vi.spyOn(window, "confirm");
  const status = { enabled: true, has_key: true, masked_value: "sk-…abcd", created_at: "2026-10-01T00:00:00Z", last_used_at: null };
  const onApiKeyRevoke = vi.fn().mockResolvedValue({ ...status, has_key: false, masked_value: null });
  const onApiKeyCreate = vi.fn().mockResolvedValue({ ...status, secret_value: "sk-new" });
  const { drawer } = openAccount({}, "TENANT_ADMIN", {
    onApiKeyLoad: vi.fn().mockResolvedValue(status), onApiKeyCreate, onApiKeyRevoke,
  });
  fireEvent.click(await within(drawer).findByText("API access"));

  fireEvent.click(await within(drawer).findByRole("button", { name: "Revoke" }));
  expect(onApiKeyRevoke).not.toHaveBeenCalled();
  fireEvent.click(within(drawer).getByRole("button", { name: "Keep key" }));
  expect(within(drawer).queryByText(/lose access immediately/)).not.toBeInTheDocument();

  fireEvent.click(within(drawer).getByRole("button", { name: "Rotate key" }));
  expect(onApiKeyCreate).not.toHaveBeenCalled();
  fireEvent.click(within(drawer).getByRole("button", { name: "Replace key" }));
  await waitFor(() => expect(onApiKeyCreate).toHaveBeenCalledOnce());
  expect(await within(drawer).findByDisplayValue("sk-new")).toBeInTheDocument();

  fireEvent.click(within(drawer).getByRole("button", { name: "Revoke" }));
  fireEvent.click(within(drawer).getByRole("button", { name: "Revoke key" }));
  await waitFor(() => expect(onApiKeyRevoke).toHaveBeenCalledOnce());
  expect(confirm).not.toHaveBeenCalled();
});

test("a lifetime token grant does not read as used this lifetime", async () => {
  mockApi({
    "/api/auth/me/usage-budget": () => json({
      usage_date: "2026-10-30",
      caps: [{ scope: "user", label: "Temporary access grant", budget_period: "lifetime", daily_token_limit: 1000, reported_tokens: 250, period_start: "2026-10-01", period_end: "2026-10-30" }],
    }),
  });
  const { drawer } = openAccount();

  expect(await within(drawer).findByText("Temporary token grant")).toBeInTheDocument();
  expect(within(drawer).getByText("250 of 1,000 used")).toBeInTheDocument();
  expect(within(drawer).queryByText(/lifetime/)).not.toBeInTheDocument();
});

test("a period cap names its period", async () => {
  mockApi({
    "/api/auth/me/usage-budget": () => json({
      usage_date: "2026-10-30",
      caps: [{ scope: "group", label: "Litigation", budget_period: "week", daily_token_limit: 5000, reported_tokens: 1200, period_start: "2026-10-26", period_end: "2026-11-01" }],
    }),
  });
  const { drawer } = openAccount();

  expect(await within(drawer).findByText("Litigation · weekly")).toBeInTheDocument();
  expect(within(drawer).getByText("1,200 of 5,000 used this week")).toBeInTheDocument();
});

test("an uploaded photo stays out of the photo URL field", () => {
  mockApi();
  const { drawer } = openAccount({ avatar_url: "data:image/png;base64,AAAA" }, "TENANT_ADMIN", { onProfileUpdate: vi.fn() });
  fireEvent.click(within(drawer).getByRole("button", { name: /Edit account profile/ }));

  const field = within(drawer).getByLabelText("Profile photo URL") as HTMLInputElement;
  expect(field.value).toBe("");
  expect(field.placeholder).toBe("Using an uploaded photo");
});

test("saving a profile with a blank display name is refused with a message", () => {
  mockApi();
  const onProfileUpdate = vi.fn();
  const { drawer } = openAccount({}, "TENANT_ADMIN", { onProfileUpdate });
  fireEvent.click(within(drawer).getByRole("button", { name: /Edit account profile/ }));

  fireEvent.change(within(drawer).getByLabelText("Display name"), { target: { value: "   " } });
  fireEvent.click(within(drawer).getByRole("button", { name: "Save profile" }));

  expect(within(drawer).getByText("Enter a display name.")).toBeInTheDocument();
  expect(onProfileUpdate).not.toHaveBeenCalled();
});

test("emptying optional profile fields asks the server to clear them", async () => {
  mockApi();
  const onProfileUpdate = vi.fn().mockResolvedValue(undefined);
  const { drawer } = openAccount(
    { phone: "+1 555 0100", firm_name: "Harbor", website_url: "https://example.test", bio: "Hello", avatar_url: "/photo.png" },
    "TENANT_ADMIN",
    { onProfileUpdate },
  );
  fireEvent.click(within(drawer).getByRole("button", { name: /Edit account profile/ }));

  for (const label of ["Phone number", "Firm or organization", "Website", "Bio"]) {
    fireEvent.change(within(drawer).getByLabelText(label), { target: { value: "" } });
  }
  fireEvent.click(within(drawer).getByRole("button", { name: "Remove" }));
  fireEvent.click(within(drawer).getByRole("button", { name: "Save profile" }));

  await waitFor(() =>
    expect(onProfileUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ phone: "", firm_name: "", website_url: "", bio: "", avatar_url: "" }),
    ),
  );
});

test.each([
  ["", "new-password-456", "new-password-456", "Enter your current password."],
  ["old-password-123", "eleven-char", "eleven-char", "Use a password with at least 12 characters."],
  ["old-password-123", "new-password-456", "new-password-789", "The new passwords do not match."],
])("a bad password form is refused before it reaches the server (%s, %s)", (current, next, confirm, message) => {
  mockApi();
  const onPasswordUpdate = vi.fn();
  const { drawer } = openAccount({}, "TENANT_ADMIN", { onPasswordUpdate });

  fireEvent.click(within(drawer).getByRole("button", { name: /Change password/ }));
  fireEvent.change(within(drawer).getByLabelText("Current password"), { target: { value: current } });
  fireEvent.change(within(drawer).getByLabelText("New password"), { target: { value: next } });
  fireEvent.change(within(drawer).getByLabelText("Confirm new password"), { target: { value: confirm } });
  fireEvent.click(within(drawer).getByRole("button", { name: "Update password" }));

  expect(within(drawer).getByText(message)).toBeInTheDocument();
  expect(onPasswordUpdate).not.toHaveBeenCalled();
});

test("a twelve character password is long enough", async () => {
  mockApi();
  const onPasswordUpdate = vi.fn().mockResolvedValue(undefined);
  const { drawer } = openAccount({}, "TENANT_ADMIN", { onPasswordUpdate });

  fireEvent.click(within(drawer).getByRole("button", { name: /Change password/ }));
  fireEvent.change(within(drawer).getByLabelText("Current password"), { target: { value: "old-password-123" } });
  fireEvent.change(within(drawer).getByLabelText("New password"), { target: { value: "twelve-chars" } });
  fireEvent.change(within(drawer).getByLabelText("Confirm new password"), { target: { value: "twelve-chars" } });
  fireEvent.click(within(drawer).getByRole("button", { name: "Update password" }));

  await waitFor(() => expect(onPasswordUpdate).toHaveBeenCalledOnce());
});

test("a server refusal stays on the password form", async () => {
  mockApi();
  const onPasswordUpdate = vi.fn().mockRejectedValue(new Error("Current password is incorrect."));
  const { drawer } = openAccount({}, "TENANT_ADMIN", { onPasswordUpdate });

  fireEvent.click(within(drawer).getByRole("button", { name: /Change password/ }));
  fireEvent.change(within(drawer).getByLabelText("Current password"), { target: { value: "wrong-password" } });
  fireEvent.change(within(drawer).getByLabelText("New password"), { target: { value: "new-password-456" } });
  fireEvent.change(within(drawer).getByLabelText("Confirm new password"), { target: { value: "new-password-456" } });
  fireEvent.click(within(drawer).getByRole("button", { name: "Update password" }));

  expect(await within(drawer).findByText("Current password is incorrect.")).toBeInTheDocument();
  expect(within(drawer).getByLabelText("Current password")).toBeInTheDocument();
  expect(within(drawer).getByRole("button", { name: "Update password" })).toBeEnabled();
});

function submitPhoto(drawer: HTMLElement, value: string) {
  fireEvent.click(within(drawer).getByRole("button", { name: /Edit account profile/ }));
  fireEvent.change(within(drawer).getByLabelText("Profile photo URL"), { target: { value } });
  fireEvent.click(within(drawer).getByRole("button", { name: "Save profile" }));
}

test.each([
  ["javascript:alert(1)"],
  ["ftp://example.test/photo.png"],
  ["not a url"],
])("a photo address that is not an image reference is refused: %s", (value) => {
  mockApi();
  const onProfileUpdate = vi.fn();
  const { drawer } = openAccount({}, "TENANT_ADMIN", { onProfileUpdate });

  submitPhoto(drawer, value);

  expect(within(drawer).getByText("Use an http(s), relative, or uploaded image for your profile photo.")).toBeInTheDocument();
  expect(onProfileUpdate).not.toHaveBeenCalled();
});

test.each([["/uploads/photo.png"], ["https://example.test/photo.png"], ["http://example.test/photo.png"]])(
  "a real photo address is accepted: %s",
  async (value) => {
    mockApi();
    const onProfileUpdate = vi.fn().mockResolvedValue(undefined);
    const { drawer } = openAccount({}, "TENANT_ADMIN", { onProfileUpdate });

    submitPhoto(drawer, value);

    await waitFor(() => expect(onProfileUpdate).toHaveBeenCalledWith(expect.objectContaining({ avatar_url: value })));
  },
);

test("an uploaded photo that is not base64 is refused", () => {
  mockApi();
  const onProfileUpdate = vi.fn();
  const { drawer } = openAccount({ avatar_url: "data:image/png,not-base64" }, "TENANT_ADMIN", { onProfileUpdate });

  fireEvent.click(within(drawer).getByRole("button", { name: /Edit account profile/ }));
  fireEvent.click(within(drawer).getByRole("button", { name: "Save profile" }));

  expect(within(drawer).getByText("Uploaded profile photo data is invalid.")).toBeInTheDocument();
  expect(onProfileUpdate).not.toHaveBeenCalled();
});

test("a file that is not an image is refused at selection", () => {
  mockApi();
  const { drawer } = openAccount({}, "TENANT_ADMIN", { onProfileUpdate: vi.fn() });
  fireEvent.click(within(drawer).getByRole("button", { name: /Edit account profile/ }));

  const input = drawer.querySelector<HTMLInputElement>('input[type="file"]');
  fireEvent.change(input as HTMLInputElement, { target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] } });

  expect(within(drawer).getByText("Choose an image file for your profile photo.")).toBeInTheDocument();
});

test("a server refusal keeps the profile editor open with its message", async () => {
  mockApi();
  const onProfileUpdate = vi.fn().mockRejectedValue(new Error("Website must use an http(s) URL."));
  const { drawer } = openAccount({}, "TENANT_ADMIN", { onProfileUpdate });

  fireEvent.click(within(drawer).getByRole("button", { name: /Edit account profile/ }));
  fireEvent.click(within(drawer).getByRole("button", { name: "Save profile" }));

  expect(await within(drawer).findByText("Website must use an http(s) URL.")).toBeInTheDocument();
  expect(within(drawer).getByRole("button", { name: "Save profile" })).toBeEnabled();
});

test("the admin console row reports waiting model access requests", () => {
  mockApi();
  const props = shellProps({ role: "TENANT_ADMIN" }, "TENANT_ADMIN");
  props.data.modelAccessRequestCount = 1;
  const view = render(<AppShell {...props}><div /></AppShell>);
  fireEvent.click(screen.getByRole("button", { name: /Account:/ }));
  const drawer = screen.getByRole("dialog", { name: "Account" });

  expect(within(drawer).getByText("1 model access request waiting")).toBeInTheDocument();
  expect(within(drawer).getByLabelText("1 pending model access requests")).toBeInTheDocument();
  view.unmount();

  const many = shellProps({ role: "TENANT_ADMIN" }, "TENANT_ADMIN");
  many.data.modelAccessRequestCount = 3;
  render(<AppShell {...many}><div /></AppShell>);
  fireEvent.click(screen.getByRole("button", { name: /Account:/ }));

  expect(within(screen.getByRole("dialog", { name: "Account" })).getByText("3 model access requests waiting")).toBeInTheDocument();
});

test("with no requests waiting the admin console describes itself", () => {
  mockApi();
  const props = shellProps({ role: "TENANT_ADMIN" }, "TENANT_ADMIN");
  props.data.modelAccessRequestCount = 0;
  render(<AppShell {...props}><div /></AppShell>);
  fireEvent.click(screen.getByRole("button", { name: /Account:/ }));
  const drawer = screen.getByRole("dialog", { name: "Account" });

  expect(within(drawer).getByText("Users, groups, model access, and connections")).toBeInTheDocument();
  expect(within(drawer).queryByLabelText(/pending model access requests/)).not.toBeInTheDocument();
});

test("the console in use is marked current", () => {
  mockApi();
  const { drawer } = openAccount({}, "TENANT_ADMIN", { currentView: "admin" });

  expect(within(drawer).getByRole("button", { name: /^Admin console/ })).toHaveAttribute("aria-current", "page");
});

test("a successful password change clears the form and leaves it closed", async () => {
  mockApi();
  const onPasswordUpdate = vi.fn().mockResolvedValue(undefined);
  const { drawer } = openAccount({}, "TENANT_ADMIN", { onPasswordUpdate });

  fireEvent.click(within(drawer).getByRole("button", { name: /Change password/ }));
  fireEvent.change(within(drawer).getByLabelText("Current password"), { target: { value: "old-password-123" } });
  fireEvent.change(within(drawer).getByLabelText("New password"), { target: { value: "new-password-456" } });
  fireEvent.change(within(drawer).getByLabelText("Confirm new password"), { target: { value: "new-password-456" } });
  fireEvent.click(within(drawer).getByRole("button", { name: "Update password" }));

  await waitFor(() => expect(drawer.querySelector(".account-live-region")).toHaveTextContent("Password updated."));
  expect(within(drawer).queryByLabelText("Current password")).not.toBeInTheDocument();
});

test("a refused permanent delete keeps the row and shows the server's reason", async () => {
  mockApi();
  const onDeleteThread = vi.fn().mockRejectedValue(new Error("This chat is protected by a legal hold."));
  const archived = thread("held", { archived: true, title: "Held matter" });
  const { drawer } = openAccount({}, "TENANT_ADMIN", { threads: [archived], onDeleteThread });

  fireEvent.click(within(drawer).getByRole("button", { name: /View archived chats/ }));
  fireEvent.click(within(drawer).getByRole("button", { name: "Permanently delete Held matter" }));
  fireEvent.click(within(drawer).getByRole("button", { name: "Delete Held matter forever" }));

  const alert = await within(drawer).findByRole("alert");
  expect(alert).toHaveTextContent("This chat is protected by a legal hold.");
  expect(within(drawer).getByText("Held matter")).toBeInTheDocument();
  expect(within(drawer).getByText("1 archived chat")).toBeInTheDocument();
  expect(within(drawer).getByRole("button", { name: "Permanently delete Held matter" })).toHaveFocus();
});

test("a delete in flight holds the row and blocks a second press", async () => {
  mockApi();
  let finish!: () => void;
  const onDeleteThread = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const archived = thread("gone", { archived: true, title: "Old matter" });
  const { drawer } = openAccount({}, "TENANT_ADMIN", { threads: [archived], onDeleteThread });

  fireEvent.click(within(drawer).getByRole("button", { name: /View archived chats/ }));
  fireEvent.click(within(drawer).getByRole("button", { name: "Permanently delete Old matter" }));
  const forever = within(drawer).getByRole("button", { name: "Delete Old matter forever" });
  fireEvent.click(forever);

  expect(forever).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(forever);
  expect(onDeleteThread).toHaveBeenCalledOnce();
  await act(async () => { finish(); });
  await waitFor(() => expect(within(drawer).getByRole("button", { name: "Hide archived chats" })).toHaveFocus());
});

const liveKey = { enabled: true, has_key: true, masked_value: "sk-…abcd", created_at: "2026-10-01T00:00:00Z", last_used_at: null };

test("a failed key status read offers Retry and never a way to replace the key", async () => {
  mockApi();
  const onApiKeyLoad = vi.fn().mockRejectedValueOnce(new Error("Service unavailable.")).mockResolvedValue(liveKey);
  const onApiKeyCreate = vi.fn();
  const props = shellProps({ role: "TENANT_ADMIN" }, "TENANT_ADMIN", { onApiKeyLoad, onApiKeyCreate });
  props.data.platformSettings = { ...props.data.platformSettings, downstream_api_enabled: true } as BootstrapData["platformSettings"];
  render(<AppShell {...props}><div /></AppShell>);
  fireEvent.click(screen.getByRole("button", { name: /Account:/ }));
  const drawer = screen.getByRole("dialog", { name: "Account" });
  fireEvent.click(await within(drawer).findByText("API access"));

  expect(await within(drawer).findByRole("alert")).toHaveTextContent("Service unavailable.");
  expect(within(drawer).queryByRole("button", { name: "Create key" })).not.toBeInTheDocument();
  expect(within(drawer).queryByRole("button", { name: "Rotate key" })).not.toBeInTheDocument();

  fireEvent.click(within(drawer).getByRole("button", { name: "Try again" }));

  expect(await within(drawer).findByRole("button", { name: "Rotate key" })).toBeInTheDocument();
  expect(within(drawer).queryByRole("alert")).not.toBeInTheDocument();
  expect(onApiKeyCreate).not.toHaveBeenCalled();
});

test("while the key status loads it says so and offers nothing to press", async () => {
  mockApi();
  const props = shellProps({ role: "TENANT_ADMIN" }, "TENANT_ADMIN", { onApiKeyLoad: () => new Promise(() => {}), onApiKeyCreate: vi.fn() });
  props.data.platformSettings = { ...props.data.platformSettings, downstream_api_enabled: true } as BootstrapData["platformSettings"];
  render(<AppShell {...props}><div /></AppShell>);
  fireEvent.click(screen.getByRole("button", { name: /Account:/ }));
  const drawer = screen.getByRole("dialog", { name: "Account" });
  fireEvent.click(within(drawer).getByText("API access"));

  expect(within(drawer).getByText("Checking your API access…")).toBeInTheDocument();
  expect(within(drawer).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  expect(within(drawer).queryByRole("button", { name: "Create key" })).not.toBeInTheDocument();
});

test("only the explicit Replace flow asks the server to replace a key", async () => {
  mockApi();
  const onApiKeyCreate = vi.fn().mockResolvedValue({ ...liveKey, secret_value: "sk-new" });
  const first = openAccount({}, "TENANT_ADMIN", {
    onApiKeyLoad: vi.fn().mockResolvedValue({ enabled: true, has_key: false }), onApiKeyCreate, onApiKeyRevoke: vi.fn(),
  });
  fireEvent.click(await within(first.drawer).findByText("API access"));
  fireEvent.click(await within(first.drawer).findByRole("button", { name: "Create key" }));
  await waitFor(() => expect(onApiKeyCreate).toHaveBeenLastCalledWith({ replace: false }));
  first.unmount();

  const second = openAccount({}, "TENANT_ADMIN", { onApiKeyLoad: vi.fn().mockResolvedValue(liveKey), onApiKeyCreate, onApiKeyRevoke: vi.fn() });
  fireEvent.click(await within(second.drawer).findByText("API access"));
  fireEvent.click(await within(second.drawer).findByRole("button", { name: "Rotate key" }));
  fireEvent.click(within(second.drawer).getByRole("button", { name: "Replace key" }));
  await waitFor(() => expect(onApiKeyCreate).toHaveBeenLastCalledWith({ replace: true }));
});

test("a stale Create key is refused, shows the live key, and offers the confirm", async () => {
  mockApi();
  const conflict = new ChatRequestError("You already have an API key. Rotate it to replace it.", 409);
  const onApiKeyCreate = vi.fn().mockRejectedValue(conflict);
  const onApiKeyLoad = vi.fn().mockResolvedValueOnce({ enabled: true, has_key: false }).mockResolvedValue(liveKey);
  const { drawer } = openAccount({}, "TENANT_ADMIN", { onApiKeyLoad, onApiKeyCreate, onApiKeyRevoke: vi.fn() });
  fireEvent.click(await within(drawer).findByText("API access"));

  fireEvent.click(await within(drawer).findByRole("button", { name: "Create key" }));

  const rotate = await within(drawer).findByRole("button", { name: "Rotate key" });
  expect(within(drawer).getByRole("alert")).toHaveTextContent("You already have an API key.");
  expect(within(drawer).getByText("sk-…abcd")).toBeInTheDocument();
  expect(within(drawer).queryByRole("textbox", { name: "New API key" })).not.toBeInTheDocument();
  await waitFor(() => expect(rotate).toHaveFocus());
});

test("any other create failure says why and leaves the status alone", async () => {
  mockApi();
  const onApiKeyCreate = vi.fn().mockRejectedValue(new ChatRequestError("Service unavailable.", 503));
  const onApiKeyLoad = vi.fn().mockResolvedValue({ enabled: true, has_key: false });
  const { drawer } = openAccount({}, "TENANT_ADMIN", { onApiKeyLoad, onApiKeyCreate, onApiKeyRevoke: vi.fn() });
  fireEvent.click(await within(drawer).findByText("API access"));
  const calls = onApiKeyLoad.mock.calls.length;

  fireEvent.click(await within(drawer).findByRole("button", { name: "Create key" }));

  expect(await within(drawer).findByRole("alert")).toHaveTextContent("Service unavailable.");
  expect(onApiKeyLoad).toHaveBeenCalledTimes(calls);
});

test("the first status load leaves focus where it is", async () => {
  mockApi();
  const { drawer } = openAccount({}, "TENANT_ADMIN", { onApiKeyLoad: vi.fn().mockResolvedValue(liveKey), onApiKeyCreate: vi.fn(), onApiKeyRevoke: vi.fn() });

  const rotate = await within(drawer).findByRole("button", { name: "Rotate key", hidden: true });

  expect(rotate).not.toHaveFocus();
});

test("Try again keeps focus in the panel, whichever way it goes", async () => {
  mockApi();
  const onApiKeyLoad = vi.fn()
    .mockRejectedValueOnce(new Error("Service unavailable."))
    .mockRejectedValueOnce(new Error("Still unavailable."))
    .mockResolvedValue(liveKey);
  const props = shellProps({ role: "TENANT_ADMIN" }, "TENANT_ADMIN", { onApiKeyLoad, onApiKeyCreate: vi.fn(), onApiKeyRevoke: vi.fn() });
  props.data.platformSettings = { ...props.data.platformSettings, downstream_api_enabled: true } as BootstrapData["platformSettings"];
  render(<AppShell {...props}><div /></AppShell>);
  fireEvent.click(screen.getByRole("button", { name: /Account:/ }));
  const drawer = screen.getByRole("dialog", { name: "Account" });
  fireEvent.click(await within(drawer).findByText("API access"));

  fireEvent.click(await within(drawer).findByRole("button", { name: "Try again" }));
  await within(drawer).findByText("Still unavailable.");
  await waitFor(() => expect(within(drawer).getByRole("button", { name: "Try again" })).toHaveFocus());

  fireEvent.click(within(drawer).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(within(drawer).getByRole("button", { name: "Rotate key" })).toHaveFocus());
});

test("Escape during a replacement waits, and the new secret is always shown", async () => {
  mockApi();
  let finish!: (value: unknown) => void;
  const onApiKeyCreate = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
  const { drawer } = openAccount({}, "TENANT_ADMIN", { onApiKeyLoad: vi.fn().mockResolvedValue(liveKey), onApiKeyCreate, onApiKeyRevoke: vi.fn() } as Partial<ShellProps>);
  fireEvent.click(await within(drawer).findByText("API access"));
  fireEvent.click(await within(drawer).findByRole("button", { name: "Rotate key" }));
  const replace = within(drawer).getByRole("button", { name: "Replace key" });
  fireEvent.click(replace);

  expect(replace).toHaveAttribute("aria-disabled", "true");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.getByRole("dialog", { name: "Account" })).toBeInTheDocument();
  expect(within(drawer).getByRole("button", { name: "Close", exact: true })).toBeDisabled();

  await act(async () => { finish({ ...liveKey, secret_value: "sk-new" }); });

  expect(await within(drawer).findByRole("textbox", { name: "New API key" })).toHaveValue("sk-new");
  await waitFor(() => expect(within(drawer).getByRole("button", { name: "Close", exact: true })).toBeEnabled());
});

test("Escape during a delete waits, so a refusal is still seen", async () => {
  mockApi();
  let refuse!: (reason: Error) => void;
  const onDeleteThread = vi.fn(() => new Promise<void>((_resolve, reject) => { refuse = reject; }));
  const archived = thread("held", { archived: true, title: "Held matter" });
  const { drawer } = openAccount({}, "TENANT_ADMIN", { threads: [archived], onDeleteThread });

  fireEvent.click(within(drawer).getByRole("button", { name: /View archived chats/ }));
  fireEvent.click(within(drawer).getByRole("button", { name: "Permanently delete Held matter" }));
  fireEvent.click(within(drawer).getByRole("button", { name: "Delete Held matter forever" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.getByRole("dialog", { name: "Account" })).toBeInTheDocument();

  await act(async () => { refuse(new Error("This chat is protected by a legal hold.")); });

  expect(await within(drawer).findByRole("alert")).toHaveTextContent("legal hold");
});

test("Escape from outside a clean form closes the form, not the drawer", () => {
  mockApi();
  const { drawer } = openAccount({}, "TENANT_ADMIN", { onPasswordUpdate: vi.fn() });
  fireEvent.click(within(drawer).getByRole("button", { name: "Change password" }));
  (document.activeElement as HTMLElement).blur();

  fireEvent.keyDown(document, { key: "Escape" });

  expect(within(drawer).queryByLabelText("Current password")).not.toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "Account" })).toBeInTheDocument();
});

test("Escape never discards typed text, wherever focus is", () => {
  mockApi();
  const { drawer } = openAccount({}, "TENANT_ADMIN", { onPasswordUpdate: vi.fn(), onProfileUpdate: vi.fn() });

  fireEvent.click(within(drawer).getByRole("button", { name: "Change password" }));
  fireEvent.change(within(drawer).getByLabelText("New password"), { target: { value: "half-typed" } });
  expect(within(drawer).queryByText("Unsaved changes. Choose Cancel to discard them.")).not.toBeInTheDocument();
  within(drawer).getByRole("button", { name: "Close password form" }).focus();
  fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });

  expect(within(drawer).getByLabelText("New password")).toHaveValue("half-typed");
  expect(screen.getByRole("dialog", { name: "Account" })).toBeInTheDocument();
  expect(within(drawer).getByText("Unsaved changes. Choose Cancel to discard them.")).toBeInTheDocument();

  fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
  fireEvent.click(within(drawer).getByRole("button", { name: /Edit account profile/ }));
  fireEvent.change(within(drawer).getByLabelText("Bio"), { target: { value: "half-typed bio" } });
  (document.activeElement as HTMLElement).blur();
  fireEvent.keyDown(document, { key: "Escape" });

  expect(within(drawer).getByLabelText("Bio")).toHaveValue("half-typed bio");
  expect(screen.getByRole("dialog", { name: "Account" })).toBeInTheDocument();
});

test("the innermost layer closes first, whichever opened last", () => {
  mockApi();
  const archived = thread("gone", { archived: true, title: "Old matter" });
  const { drawer } = openAccount({}, "TENANT_ADMIN", { threads: [archived], onPasswordUpdate: vi.fn() });

  fireEvent.click(within(drawer).getByRole("button", { name: "Change password" }));
  fireEvent.click(within(drawer).getByRole("button", { name: /View archived chats/ }));
  fireEvent.click(within(drawer).getByRole("button", { name: "Permanently delete Old matter" }));

  fireEvent.keyDown(document, { key: "Escape" });
  expect(within(drawer).queryByText(/cannot be undone/)).not.toBeInTheDocument();
  expect(within(drawer).getByLabelText("Current password")).toBeInTheDocument();

  fireEvent.keyDown(document, { key: "Escape" });
  expect(within(drawer).queryByLabelText("Current password")).not.toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "Account" })).toBeInTheDocument();

  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Account" })).not.toBeInTheDocument();
});

test("after replacing a key focus lands on Copy, which is the main action now", async () => {
  mockApi();
  const onApiKeyCreate = vi.fn().mockResolvedValue({ ...liveKey, secret_value: "sk-new" });
  const { drawer } = openAccount({}, "TENANT_ADMIN", { onApiKeyLoad: vi.fn().mockResolvedValue(liveKey), onApiKeyCreate, onApiKeyRevoke: vi.fn() });
  fireEvent.click(await within(drawer).findByText("API access"));

  const rotate = await within(drawer).findByRole("button", { name: "Rotate key" });
  expect(rotate).toHaveClass("secondary-button");
  fireEvent.click(rotate);
  fireEvent.click(within(drawer).getByRole("button", { name: "Replace key" }));

  const copy = await within(drawer).findByRole("button", { name: "Copy API key" });
  await waitFor(() => expect(copy).toHaveFocus());
  expect(copy).toHaveClass("primary-button");
});

test("creating a first key is the lit action", async () => {
  mockApi();
  const { drawer } = openAccount({}, "TENANT_ADMIN", {
    onApiKeyLoad: vi.fn().mockResolvedValue({ enabled: true, has_key: false }), onApiKeyCreate: vi.fn(), onApiKeyRevoke: vi.fn(),
  });
  fireEvent.click(await within(drawer).findByText("API access"));

  expect(await within(drawer).findByRole("button", { name: "Create key" })).toHaveClass("primary-button");
});

test("after revoking a key focus lands on Create key, and the confirm reads as destructive", async () => {
  mockApi();
  const onApiKeyRevoke = vi.fn().mockResolvedValue({ ...liveKey, has_key: false, masked_value: null });
  const { drawer } = openAccount({}, "TENANT_ADMIN", { onApiKeyLoad: vi.fn().mockResolvedValue(liveKey), onApiKeyCreate: vi.fn(), onApiKeyRevoke });
  fireEvent.click(await within(drawer).findByText("API access"));

  fireEvent.click(await within(drawer).findByRole("button", { name: "Revoke" }));
  const confirm = within(drawer).getByRole("button", { name: "Revoke key" });
  expect(confirm).toHaveClass("danger-button");
  fireEvent.click(confirm);

  await waitFor(() => expect(within(drawer).getByRole("button", { name: "Create key" })).toHaveFocus());
});

test("a refused key change returns focus to the key that asked and says why", async () => {
  mockApi();
  const onApiKeyRevoke = vi.fn().mockRejectedValue(new Error("Could not reach the server."));
  const { drawer } = openAccount({}, "TENANT_ADMIN", { onApiKeyLoad: vi.fn().mockResolvedValue(liveKey), onApiKeyCreate: vi.fn(), onApiKeyRevoke });
  fireEvent.click(await within(drawer).findByText("API access"));

  fireEvent.click(await within(drawer).findByRole("button", { name: "Revoke" }));
  fireEvent.click(within(drawer).getByRole("button", { name: "Revoke key" }));

  expect(await within(drawer).findByRole("alert")).toHaveTextContent("Could not reach the server.");
  await waitFor(() => expect(within(drawer).getByRole("button", { name: "Revoke" })).toHaveFocus());
});

test("opening a form moves focus into it, and Change stays as its toggle", () => {
  mockApi();
  const { drawer } = openAccount({}, "TENANT_ADMIN", { onProfileUpdate: vi.fn(), onPasswordUpdate: vi.fn() });

  const change = within(drawer).getByRole("button", { name: "Change password" });
  expect(change).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(change);
  expect(within(drawer).getByLabelText("Current password")).toHaveFocus();
  expect(within(drawer).getByRole("button", { name: "Close password form" })).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(within(drawer).getByRole("button", { name: "Close password form" }));
  expect(within(drawer).queryByLabelText("Current password")).not.toBeInTheDocument();

  fireEvent.click(within(drawer).getByRole("button", { name: /Edit account profile/ }));
  expect(within(drawer).getByLabelText("Display name")).toHaveFocus();
});

test("Escape closes only the innermost layer", () => {
  mockApi();
  const onDeleteThread = vi.fn();
  const archived = thread("gone", { archived: true, title: "Old matter" });
  const { drawer } = openAccount({}, "TENANT_ADMIN", { threads: [archived], onDeleteThread, onProfileUpdate: vi.fn(), onPasswordUpdate: vi.fn() });
  const dialogIsOpen = () => screen.queryByRole("dialog", { name: "Account" }) !== null;

  fireEvent.click(within(drawer).getByRole("button", { name: "Change password" }));
  fireEvent.keyDown(within(drawer).getByLabelText("Current password"), { key: "Escape" });
  expect(within(drawer).queryByLabelText("Current password")).not.toBeInTheDocument();
  expect(dialogIsOpen()).toBe(true);

  fireEvent.click(within(drawer).getByRole("button", { name: /Edit account profile/ }));
  fireEvent.keyDown(within(drawer).getByLabelText("Display name"), { key: "Escape" });
  expect(within(drawer).queryByLabelText("Display name")).not.toBeInTheDocument();
  expect(dialogIsOpen()).toBe(true);

  fireEvent.click(within(drawer).getByRole("button", { name: /View archived chats/ }));
  fireEvent.click(within(drawer).getByRole("button", { name: "Permanently delete Old matter" }));
  fireEvent.keyDown(within(drawer).getByRole("button", { name: "Keep Old matter" }), { key: "Escape" });
  expect(within(drawer).queryByText(/cannot be undone/)).not.toBeInTheDocument();
  expect(onDeleteThread).not.toHaveBeenCalled();
  expect(dialogIsOpen()).toBe(true);

  fireEvent.keyDown(within(drawer).getByRole("button", { name: "Permanently delete Old matter" }), { key: "Escape" });
  expect(dialogIsOpen()).toBe(false);
});

test("the confirm scrolls itself into view", () => {
  mockApi();
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  const archived = thread("gone", { archived: true, title: "Old matter" });
  const { drawer } = openAccount({}, "TENANT_ADMIN", { threads: [archived] });

  fireEvent.click(within(drawer).getByRole("button", { name: /View archived chats/ }));
  fireEvent.click(within(drawer).getByRole("button", { name: "Permanently delete Old matter" }));

  expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

test("large token totals stay on one line and keep the exact value on hand", async () => {
  mockApi({ "/api/auth/me/usage-summary": () => json({ ...usage, total_tokens: 18264512 }) });
  const { drawer } = openAccount();

  const figure = await within(drawer).findByText("18.3M");
  expect(figure.closest("dd")).toHaveAttribute("title", "18,264,512");
  expect(within(drawer).getByText("18,264,512")).toHaveClass("sr-only");
});

test("each usage figure names itself before its value", async () => {
  mockApi();
  const { drawer } = openAccount();
  await within(drawer).findByText("Requests");

  const list = within(drawer).getByRole("region", { name: "Usage this month" }).querySelector("dl");
  for (const pair of Array.from(list?.children ?? [])) {
    expect(pair.children[0].tagName).toBe("DT");
    expect(pair.children[1].tagName).toBe("DD");
  }
});

test("a meter says which cap it measures, and a spent cap warns", async () => {
  mockApi({
    "/api/auth/me/usage-budget": () => json({
      usage_date: "2026-10-30",
      caps: [
        { scope: "user", label: "Your budget", budget_period: "month", daily_token_limit: 5000, reported_tokens: 5000, period_start: "2026-10-01", period_end: "2026-10-31" },
        { scope: "group", label: "Litigation", budget_period: "week", daily_token_limit: 5000, reported_tokens: 1000, period_start: "2026-10-26", period_end: "2026-11-01" },
      ],
    }),
  });
  const { drawer } = openAccount();

  const spent = await within(drawer).findByRole("meter", { name: "Monthly tokens" });
  expect(spent).toHaveAttribute("aria-valuenow", "100");
  expect(spent.closest(".account-meter")).toHaveClass("is-spent");
  const open = within(drawer).getByRole("meter", { name: "Litigation · weekly" });
  expect(open).toHaveAttribute("aria-valuenow", "20");
  expect(open.closest(".account-meter")).not.toHaveClass("is-spent");
});

test("no recovery codes left is a warning", async () => {
  mockApi({ "/api/auth/mfa/status": () => json({ ...mfaOn, recovery_codes_remaining: 0 }) });
  const { drawer } = openAccount();

  expect(await within(drawer).findByText("On · No recovery codes left")).toHaveClass("account-warning");
});

test("results are announced, and errors interrupt", async () => {
  mockApi();
  const onPasswordUpdate = vi.fn().mockRejectedValueOnce(new Error("Current password is incorrect.")).mockResolvedValue(undefined);
  const { drawer } = openAccount({}, "TENANT_ADMIN", { onPasswordUpdate });

  fireEvent.click(within(drawer).getByRole("button", { name: /Change password/ }));
  fireEvent.change(within(drawer).getByLabelText("Current password"), { target: { value: "old-password-123" } });
  fireEvent.change(within(drawer).getByLabelText("New password"), { target: { value: "new-password-456" } });
  fireEvent.change(within(drawer).getByLabelText("Confirm new password"), { target: { value: "new-password-456" } });
  fireEvent.click(within(drawer).getByRole("button", { name: "Update password" }));
  expect(await within(drawer).findByRole("alert")).toHaveTextContent("Current password is incorrect.");

  fireEvent.click(within(drawer).getByRole("button", { name: "Update password" }));
  await waitFor(() => expect(drawer.querySelector(".account-live-region")).toHaveTextContent("Password updated."));
});

test("a broken-up email can wrap after the @ sign", () => {
  mockApi();
  const { drawer } = openAccount({ email: "jordan.whitfield@harborvalepartners.example" });

  const email = within(drawer).getByText("jordan.whitfield@harborvalepartners.example");
  expect(email.querySelector("wbr")).not.toBeNull();
});
