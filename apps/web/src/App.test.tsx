import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { AuthScreen } from "./components/AuthScreen";
import { sampleData } from "./data/sampleData";
import { mapConnectorConfigRecordToConnector, setSessionToken } from "./lib/api";
import type { ConnectorConfigRecord } from "./lib/types";

const SESSION_STORAGE_KEY = "aperture-session-user-id";
const DARK_MODE_STORAGE_KEY = "aperture-dark-mode";

function fileListForInput(files: File[]): FileList {
  const fileList = {
    length: files.length,
    item: (index: number) => files[index] ?? null,
    ...files,
  };
  return fileList as unknown as FileList;
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(SESSION_STORAGE_KEY, "user-admin");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.localStorage.clear();
  window.history.pushState({}, "", "/");
});

test("renders Aperture Chat shell with intentional empty chat history", async () => {
  render(<App />);
  // Scope to the sidebar logo: the transient session-restore screen also
  // shows the brand name while bootstrap data loads.
  expect(
    await screen.findByText("Aperture Chat", { selector: ".logo-word" }),
  ).toBeInTheDocument();
  expect(screen.queryByText("Group access enforced")).not.toBeInTheDocument();
  expect(
    screen.queryByText("Review a contract for risk"),
  ).not.toBeInTheDocument();
  expect(
    await screen.findByRole("button", { name: "Select model" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByLabelText("Open session controls"),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Session info" }));
  expect(await screen.findByText("Session details")).toBeInTheDocument();
  expect(screen.getByText("Session summary")).toBeInTheDocument();
  expect(
    screen.queryByText("Secrets hidden by org policy"),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("View full audit log")).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Open session controls"),
  ).not.toBeInTheDocument();
  // No demo chats are seeded — Pinned/Recent show on-brand empty states.
  const sidebar = document.querySelector(".sidebar") as HTMLElement;
  fireEvent.click(within(sidebar).getByRole("button", { name: "Chats" }));
  fireEvent.click(within(sidebar).getByRole("button", { name: "Pinned" }));
  fireEvent.click(within(sidebar).getByRole("button", { name: "Recent" }));
  expect(
    await screen.findByText("No recent chats."),
  ).toBeInTheDocument();
  expect(screen.getByText("No pinned chats.")).toBeInTheDocument();
});

test("persists dark mode preference across app reloads", async () => {
  const firstRender = render(<App />);

  fireEvent.click(await screen.findByRole("button", { name: "Dark mode" }));

  expect(window.localStorage.getItem(DARK_MODE_STORAGE_KEY)).toBe("true");
  expect(document.documentElement).toHaveClass("theme-dark");
  expect(
    await screen.findByRole("button", { name: "Light mode" }),
  ).toBeInTheDocument();

  firstRender.unmount();
  render(<App />);

  expect(await screen.findByRole("button", { name: "Light mode" })).toBeInTheDocument();
  expect(document.documentElement).toHaveClass("theme-dark");
});

test("connector config mapping does not mark metadata-only connectors as configured", () => {
  const record: ConnectorConfigRecord = {
    id: "conncfg-test",
    tenant_id: "tenant-example",
    connector_id: "box",
    enabled: true,
    auth_type: "developer-token",
    scopes: ["root_readwrite"],
    settings: {
      folder_id: "12345",
      sync_status: "idle",
      last_sync: "Never",
    },
    secret_set: false,
    masked_secret: null,
  };

  expect(mapConnectorConfigRecordToConnector(record)).toMatchObject({
    auth_status: "needs-credentials",
    sync_status: "idle",
    last_sync: "Never",
  });
});

test("opens the document assistant from the Drafts navigation item", async () => {
  render(<App />);

  fireEvent.click(await screen.findByRole("button", { name: "Drafts" }));

  expect(
    await screen.findByRole("heading", { name: "Document Assistant" }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Document title")).toHaveValue("Untitled Draft");
  expect(screen.getByRole("textbox", { name: "Document body" }).textContent).toBe("");

  fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
  expect(
    await screen.findByRole("heading", { name: /Good (morning|afternoon|evening), |Burning the midnight oil, / }),
  ).toBeInTheDocument();
});

test("reopens Drafts navigation as a clean new draft unless history restores one", async () => {
  render(<App />);

  const draftsButton = await screen.findByRole("button", { name: "Drafts" });
  fireEvent.click(draftsButton);

  const editedText = "Manual draft text that should not persist by nav.";
  const editor = await screen.findByRole("textbox", { name: "Document body" });
  editor.innerHTML = `<p>${editedText}</p>`;
  fireEvent.input(editor);
  expect(screen.getByText("Draft edited manually.")).toBeInTheDocument();

  fireEvent.click(draftsButton);

  const freshEditor = await screen.findByRole("textbox", { name: "Document body" });
  expect(screen.getByLabelText("Document title")).toHaveValue("Untitled Draft");
  expect(freshEditor.textContent).toBe("");
  expect(freshEditor).not.toHaveTextContent(editedText);
  expect(screen.queryByText("Draft edited manually.")).not.toBeInTheDocument();
});

test("uses tenant branding for the empty chat workspace", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/bootstrap")) {
      return new Response(
        JSON.stringify({
          ...sampleData,
          currentTenant: {
            ...sampleData.currentTenant,
            chat_brand_name: "ChatFortAI Chat",
            logo_url: "/brand-logo.png",
            icon_url: "/brand-icon.png",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("unavailable", { status: 503 });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  expect(
    await screen.findByRole("heading", {
      name: /Good (morning|afternoon|evening), |Burning the midnight oil, /,
    }),
  ).toBeInTheDocument();
  // The tenant brand now lives in the tagline (the heading is the greeting).
  expect(screen.getByText(/ask ChatFortAI Chat anything/)).toBeInTheDocument();
  const emptyLogo =
    document.querySelector<HTMLImageElement>(".empty-brand-logo");
  expect(emptyLogo).toHaveAttribute("src", "/brand-icon.png");
  await waitFor(() => expect(document.title).toBe("ChatFortAI Chat"));
});

test("uses auth-options tenant branding on the sign-in screen", async () => {
  window.localStorage.removeItem(SESSION_STORAGE_KEY);
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/auth/options")) {
      return new Response(
        JSON.stringify({
          local_auth_enabled: true,
          password_auth_enabled: true,
          bootstrap_required: false,
          providers: [],
          tenant_branding: {
            ...sampleData.currentTenant,
            chat_brand_name: "Example AI",
            logo_url: "/example-logo.png",
            icon_url: "/example-icon.png",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("unavailable", { status: 503 });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  expect(await screen.findByText("Example AI")).toBeInTheDocument();
  expect(
    screen.getByText("Use your work identity so Example AI can load your tenant role, groups, and enabled tools."),
  ).toBeInTheDocument();
  const authLogo = document.querySelector<HTMLImageElement>(".auth-brand-mark img");
  expect(authLogo).toHaveAttribute("src", "/example-icon.png");
  await waitFor(() => expect(document.title).toBe("Example AI"));
});

test("Continue with SSO sends the browser to the identity provider's authorize URL", async () => {
  const redirectSpy = vi.fn();
  render(
    <AuthScreen
      authOptions={{
        local_auth_enabled: true,
        providers: [
          {
            id: "sso-entra-example",
            name: "Microsoft Entra ID",
            provider: "entra",
            protocol: "OIDC",
            tenant_id: "tenant-example",
            domains: ["example.com"],
            enforced: true,
            start_url: "/api/auth/sso/sso-entra-example/authorize",
          },
        ],
      }}
      onSsoRedirect={redirectSpy}
    />,
  );

  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "jane.smith@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Continue with SSO/i }));

  expect(redirectSpy).toHaveBeenCalledTimes(1);
  const target = String(redirectSpy.mock.calls[0][0]);
  expect(target).toContain("/api/auth/sso/sso-entra-example/authorize");
  expect(target).toContain("return_to=");
});

test("SSO stays a redirect even when the email domain mismatches (with an honest warning)", async () => {
  const redirectSpy = vi.fn();
  render(
    <AuthScreen
      authOptions={{
        local_auth_enabled: true,
        providers: [
          {
            id: "sso-entra-example",
            name: "Microsoft Entra ID",
            provider: "entra",
            protocol: "OIDC",
            tenant_id: "tenant-example",
            domains: ["example.com"],
            enforced: true,
          },
        ],
      }}
      onSsoRedirect={redirectSpy}
    />,
  );

  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "someone@other-company.test" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Continue with SSO/i }));

  expect(redirectSpy).not.toHaveBeenCalled();
  expect(await screen.findByRole("alert")).toHaveTextContent(/configured for example.com/i);
});

test("returning from the SSO callback with a session token signs the user in", async () => {
  window.localStorage.clear();
  setSessionToken(null);
  const jane =
    sampleData.users.find((user) => user.id === "user-jane") ?? sampleData.me;
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/auth/session")) {
        const headers = new Headers(init?.headers);
        if (headers.get("x-aperture-session") !== "signed-test-session-token") {
          return new Response(JSON.stringify({ detail: "Session is invalid or expired." }), { status: 401 });
        }
        return new Response(
          JSON.stringify({
            user: jane,
            session: {
              user_id: jane.id,
              auth_method: "sso",
              sso_config_id: "sso-entra-example",
            },
            bootstrap: {
              ...sampleData,
              me: jane,
              providerKeys: [],
              visibleUsers: sampleData.users.filter(
                (user) => user.role !== "PLATFORM_OWNER",
              ),
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/auth/first-run-guide/seen")) {
        return new Response(
          JSON.stringify({ ...jane, first_run_guide_seen_at: "2026-07-05T00:00:00.000Z" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/auth/options")) {
        return new Response(
          JSON.stringify({ local_auth_enabled: true, providers: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unavailable", { status: 503 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  window.history.pushState({}, "", "/#sso_session=signed-test-session-token");

  render(<App />);

  await waitFor(() =>
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBe(jane.id),
  );
  expect(await screen.findByLabelText("Message")).toBeInTheDocument();
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/auth/first-run-guide/seen"))).toBe(true),
  );
  expect(screen.queryByRole("dialog", { name: "Help" })).not.toBeInTheDocument();
  expect(window.localStorage.getItem("aperture-session-token")).toBe("signed-test-session-token");
  expect(window.location.hash).toBe("");
  setSessionToken(null);
});

test("returning with a stored session token resumes and rotates it", async () => {
  window.localStorage.clear();
  window.localStorage.setItem(SESSION_STORAGE_KEY, "user-jane");
  setSessionToken("stale-but-valid-session-token");
  const jane =
    sampleData.users.find((user) => user.id === "user-jane") ?? sampleData.me;
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/auth/session")) {
        const headers = new Headers(init?.headers);
        const presented = headers.get("x-aperture-session");
        if (
          presented !== "stale-but-valid-session-token" &&
          presented !== "rotated-session-token"
        ) {
          return new Response(
            JSON.stringify({ detail: "Session is invalid or expired." }),
            { status: 401 },
          );
        }
        return new Response(
          JSON.stringify({
            user: jane,
            session: {
              user_id: jane.id,
              auth_method: "local",
              sso_config_id: null,
              token: "rotated-session-token",
              expires_at: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
            },
            bootstrap: {
              ...sampleData,
              me: jane,
              providerKeys: [],
              visibleUsers: sampleData.users.filter(
                (user) => user.role !== "PLATFORM_OWNER",
              ),
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/auth/options")) {
        return new Response(
          JSON.stringify({ local_auth_enabled: true, providers: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unavailable", { status: 503 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  expect(await screen.findByLabelText("Message")).toBeInTheDocument();
  await waitFor(() =>
    expect(window.localStorage.getItem("aperture-session-token")).toBe(
      "rotated-session-token",
    ),
  );
  expect(
    fetchMock.mock.calls.some(([input]) =>
      String(input).includes("/api/bootstrap"),
    ),
  ).toBe(false);
  setSessionToken(null);
});

test("first admin sign-in lands on chat without auto-opened documentation", async () => {
  window.localStorage.clear();
  setSessionToken(null);
  const admin = sampleData.me;
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/auth/session")) {
        const headers = new Headers(init?.headers);
        if (headers.get("x-aperture-session") !== "admin-doc-session") {
          return new Response(JSON.stringify({ detail: "Session is invalid or expired." }), { status: 401 });
        }
        return new Response(
          JSON.stringify({
            user: admin,
            session: {
              user_id: admin.id,
              auth_method: "sso",
              sso_config_id: "sso-entra-example",
            },
            bootstrap: {
              ...sampleData,
              me: admin,
              providerKeys: [],
              visibleUsers: sampleData.users.filter((user) => user.role !== "PLATFORM_OWNER"),
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/auth/first-run-guide/seen")) {
        return new Response(
          JSON.stringify({ ...admin, first_run_guide_seen_at: "2026-07-05T00:00:00.000Z" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/auth/options")) {
        return new Response(
          JSON.stringify({ local_auth_enabled: true, providers: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unavailable", { status: 503 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  window.history.pushState({}, "", "/#sso_session=admin-doc-session");

  render(<App />);

  expect(await screen.findByLabelText("Message")).toBeInTheDocument();
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/auth/first-run-guide/seen"))).toBe(true),
  );
  expect(screen.queryByRole("dialog", { name: "Admin console documentation" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Admin Console" })).not.toBeInTheDocument();
  setSessionToken(null);
});

test("durable first-run guide marker prevents repeat user help on later sign-ins", async () => {
  window.localStorage.clear();
  setSessionToken(null);
  const jane =
    sampleData.users.find((user) => user.id === "user-jane") ?? sampleData.me;
  const janeWithSeenGuide = {
    ...jane,
    first_run_guide_seen_at: "2026-07-05T00:00:00.000Z",
  };
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/auth/session")) {
        const headers = new Headers(init?.headers);
        if (headers.get("x-aperture-session") !== "repeat-user-session") {
          return new Response(JSON.stringify({ detail: "Session is invalid or expired." }), { status: 401 });
        }
        return new Response(
          JSON.stringify({
            user: janeWithSeenGuide,
            session: {
              user_id: jane.id,
              auth_method: "sso",
              sso_config_id: "sso-entra-example",
            },
            bootstrap: {
              ...sampleData,
              me: janeWithSeenGuide,
              providerKeys: [],
              visibleUsers: sampleData.users.filter((user) => user.role !== "PLATFORM_OWNER"),
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/auth/options")) {
        return new Response(
          JSON.stringify({ local_auth_enabled: true, providers: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unavailable", { status: 503 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  window.history.pushState({}, "", "/#sso_session=repeat-user-session");

  render(<App />);

  expect(await screen.findByLabelText("Message")).toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: "Help" })).not.toBeInTheDocument();
  expect(screen.queryByText("Learn Aperture Chat")).not.toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/auth/first-run-guide/seen"))).toBe(false);
  setSessionToken(null);
});

test("an SSO error returned by the callback is shown honestly on the sign-in screen", async () => {
  window.localStorage.clear();
  setSessionToken(null);
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/auth/options")) {
      return new Response(
        JSON.stringify({ local_auth_enabled: true, providers: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("unavailable", { status: 503 });
  });
  vi.stubGlobal("fetch", fetchMock);
  window.history.pushState(
    {},
    "",
    "/#sso_error=ID%20token%20validation%20failed%3A%20Invalid%20audience",
  );

  render(<App />);

  expect(await screen.findByRole("alert")).toHaveTextContent(
    /ID token validation failed/i,
  );
});

test("signed-out owners can sign in locally before SSO is configured", async () => {
  window.localStorage.clear();
  const owner =
    sampleData.users.find((user) => user.id === "user-owner") ?? sampleData.me;
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/auth/options")) {
        return new Response(
          JSON.stringify({
            local_auth_enabled: true,
            bootstrap_required: false,
            password_auth_enabled: true,
            providers: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/auth/login")) {
        return new Response(
          JSON.stringify({
            user: owner,
            session: {
              user_id: owner.id,
              auth_method: "local",
              sso_config_id: null,
            },
            bootstrap: {
              ...sampleData,
              me: owner,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/auth/first-run-guide/seen")) {
        return new Response(
          JSON.stringify({ ...owner, first_run_guide_seen_at: "2026-07-05T00:00:00.000Z" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unavailable", { status: 503 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  expect(
    await screen.findByRole("heading", { name: "Sign in to continue" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Password sign-in remains available until SSO is configured and enforced."),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("Display name")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /^Sign in$/i }),
  ).toBeEnabled();

  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "owner@aperture.local" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "owner-password-123" },
  });
  fireEvent.submit(screen.getByRole("button", { name: /^Sign in$/i }).closest("form") as HTMLFormElement);

  await waitFor(() =>
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBe(owner.id),
  );
  expect(await screen.findByLabelText("Message")).toBeInTheDocument();
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/auth/first-run-guide/seen"))).toBe(true),
  );
  expect(screen.queryByRole("dialog", { name: "Platform owner documentation" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Platform Owner Console" })).not.toBeInTheDocument();
  const loginCall = fetchMock.mock.calls.find(([input]) =>
    String(input).includes("/api/auth/login"),
  );
  expect(loginCall?.[1]).toMatchObject({
    method: "POST",
    body: JSON.stringify({
      email: "owner@aperture.local",
      display_name: null,
      auth_method: "local",
      provider_id: null,
      password: "owner-password-123",
    }),
  });
});

test("first-run setup creates the initial platform owner", async () => {
  window.localStorage.clear();
  const owner =
    sampleData.users.find((user) => user.id === "user-owner") ?? sampleData.me;
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/auth/options")) {
        return new Response(
          JSON.stringify({
            local_auth_enabled: false,
            bootstrap_required: true,
            password_auth_enabled: false,
            providers: [],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (url.includes("/api/auth/bootstrap-owner")) {
        return new Response(
          JSON.stringify({
            user: {
              ...owner,
              email: "owner@example.test",
              display_name: "Owner User",
            },
            session: {
              user_id: owner.id,
              auth_method: "local",
              sso_config_id: null,
            },
            bootstrap: {
              ...sampleData,
              me: {
                ...owner,
                email: "owner@example.test",
                display_name: "Owner User",
              },
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unavailable", { status: 503 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  expect(await screen.findByRole("heading", { name: "Create the first platform owner" })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "owner@example.test" },
  });
  fireEvent.change(screen.getByLabelText("Display name"), {
    target: { value: "Owner User" },
  });
  fireEvent.change(screen.getByLabelText("Create password"), {
    target: { value: "long-owner-password" },
  });
  fireEvent.change(screen.getByLabelText("Confirm password"), {
    target: { value: "long-owner-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Create platform owner/i }));

  await waitFor(() =>
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBe(owner.id),
  );
  expect(await screen.findByRole("heading", { name: "Platform Owner Console" })).toBeInTheDocument();
  const loginCall = fetchMock.mock.calls.find(([input]) =>
    String(input).includes("/api/auth/bootstrap-owner"),
  );
  expect(loginCall?.[1]).toMatchObject({
    method: "POST",
    body: JSON.stringify({
      email: "owner@example.test",
      display_name: "Owner User",
      password: "long-owner-password",
    }),
  });
});

test("stale persona session clears back to first-run setup", async () => {
  window.localStorage.setItem(SESSION_STORAGE_KEY, "user-profile-qa-owner");
  window.history.pushState({}, "", "/?persona=user-profile-qa-owner&qa=profile");
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/bootstrap")) {
      return new Response(JSON.stringify({ detail: "Unknown or inactive user" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/auth/options")) {
      return new Response(
        JSON.stringify({
          local_auth_enabled: true,
          bootstrap_required: true,
          password_auth_enabled: false,
          providers: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response([], { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  expect(await screen.findByRole("heading", { name: "Create the first platform owner" })).toBeInTheDocument();
  expect(
    screen.queryByText("That saved session is no longer active. Sign in again or create the first platform owner."),
  ).not.toBeInTheDocument();
  expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  expect(window.location.search).toBe("?qa=profile");
});

test("owner persona shortcut opens the platform owner workspace", async () => {
  window.history.pushState({}, "", "/?persona=owner");
  const owner =
    sampleData.users.find((user) => user.id === "user-owner") ?? sampleData.me;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/bootstrap")) {
      return new Response(
        JSON.stringify({
          ...sampleData,
          me: owner,
          visibleUsers: sampleData.users.filter(
            (user) => user.role !== "PLATFORM_OWNER",
          ),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response([], { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  expect(await screen.findByText("Aperture Platform Owner")).toBeInTheDocument();
  await waitFor(() =>
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBe("user-owner"),
  );
  const bootstrapCall = fetchMock.mock.calls.find(([input]) =>
    String(input).includes("/api/bootstrap"),
  );
  expect(bootstrapCall?.[1]).toMatchObject({
    headers: { "x-aperture-user": "user-owner" },
  });
});

test("restoring a saved session never paints the sample placeholder account", async () => {
  let releaseBootstrap: () => void = () => {};
  const bootstrapGate = new Promise<void>((resolve) => {
    releaseBootstrap = resolve;
  });
  const realUser = {
    ...sampleData.me,
    display_name: "Taylor Example",
    email: "matthew@example.com",
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/bootstrap")) {
      await bootstrapGate;
      return new Response(JSON.stringify({ ...sampleData, me: realUser }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response([], { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  // While the resume request is in flight the workspace shell must not render
  // with the bundled sample identity.
  expect(await screen.findByText("Restoring your session")).toBeInTheDocument();
  expect(screen.queryByText("Alex Morgan")).not.toBeInTheDocument();

  releaseBootstrap();

  expect(await screen.findByText("Taylor Example")).toBeInTheDocument();
  expect(screen.queryByText("Alex Morgan")).not.toBeInTheDocument();
});

test("a failed session restore shows honest recovery instead of the sample workspace", async () => {
  // Match production: the dev/demo sample fallback is disabled.
  vi.stubEnv("DEV", false);
  let bootstrapAvailable = false;
  const realUser = { ...sampleData.me, display_name: "Taylor Example" };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/bootstrap")) {
      if (!bootstrapAvailable) {
        return new Response(JSON.stringify({ detail: "The API is unavailable." }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ...sampleData, me: realUser }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response([], { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  expect(
    await screen.findByText("Your workspace could not be loaded"),
  ).toBeInTheDocument();
  expect(screen.getByText("The API is unavailable.")).toBeInTheDocument();
  expect(screen.queryByText("Alex Morgan")).not.toBeInTheDocument();
  expect(screen.queryByText("Example Corporation")).not.toBeInTheDocument();

  bootstrapAvailable = true;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));

  expect(await screen.findByText("Taylor Example")).toBeInTheDocument();
  expect(screen.queryByText("Alex Morgan")).not.toBeInTheDocument();
});

test("account profile save updates the active shell identity", async () => {
  const updatedUser = {
    ...sampleData.me,
    display_name: "Taylor Example",
    bio: "AI automation and legal workflow builder.",
    firm_name: "Meridian Advisory LLP",
    website_url: "https://meridian.example.com",
    phone: "+1 555 0100",
    avatar_url: "https://example.com/matthew.png",
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/bootstrap")) {
      return new Response(JSON.stringify(sampleData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/auth/profile")) {
      return new Response(JSON.stringify(updatedUser), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response([], { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  fireEvent.click(await screen.findByText("Alex Morgan"));
  fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
  fireEvent.change(screen.getByLabelText("Username"), {
    target: { value: updatedUser.display_name },
  });
  fireEvent.change(screen.getByLabelText("Phone number"), {
    target: { value: updatedUser.phone },
  });
  fireEvent.change(screen.getByLabelText("Firm or organization"), {
    target: { value: updatedUser.firm_name },
  });
  fireEvent.change(screen.getByLabelText("Website"), {
    target: { value: updatedUser.website_url },
  });
  fireEvent.change(screen.getByLabelText("Profile photo URL"), {
    target: { value: updatedUser.avatar_url },
  });
  fireEvent.change(screen.getByLabelText("Bio"), {
    target: { value: updatedUser.bio },
  });
  fireEvent.click(screen.getByRole("button", { name: /Save profile/ }));

  await waitFor(() => expect(screen.getAllByText("Taylor Example").length).toBeGreaterThan(0));
  expect(
    screen.getByRole("button", { name: "Account: Taylor Example, Admin" }).querySelector("img"),
  ).toHaveAttribute("src", updatedUser.avatar_url);
  const profileCall = fetchMock.mock.calls.find(([input]) => String(input).includes("/api/auth/profile"));
  expect(profileCall?.[1]).toMatchObject({
    method: "PATCH",
    headers: { "x-aperture-user": "user-admin", "Content-Type": "application/json" },
    body: JSON.stringify({
      display_name: "Taylor Example",
      firm_name: "Meridian Advisory LLP",
      website_url: "https://meridian.example.com",
      phone: "+1 555 0100",
      bio: "AI automation and legal workflow builder.",
      avatar_url: "https://example.com/matthew.png",
    }),
  });
});

test("platform owner previewing as user keeps grant-based model access in chat", async () => {
  window.localStorage.clear();
  window.localStorage.setItem(SESSION_STORAGE_KEY, "user-owner");
  const owner = sampleData.users.find((user) => user.id === "user-owner")!;
  const catalogOnlyModel = {
    ...sampleData.models.find((model) => model.id === "openrouter-openai-gpt-4o-mini")!,
    id: "openrouter-catalog-only-owner-test",
    name: "OpenRouter: Catalog Only Owner Test",
    upstream_model_id: "meta-llama/llama-3.3-70b-instruct",
    platform_enabled: false,
    group_ids: ["group-default-users"],
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/bootstrap")) {
      return new Response(
        JSON.stringify({
          ...sampleData,
          me: owner,
          models: [...sampleData.models, catalogOnlyModel],
          visibleUsers: sampleData.users.filter(
            (user) => user.role !== "PLATFORM_OWNER",
          ),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("unavailable", { status: 503 });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  // Owner chat uses the approved runtime catalog; the full provider catalog
  // stays in owner governance surfaces.
  const ownerModelButton = await screen.findByRole("button", {
    name: "Select model",
  });
  expect(ownerModelButton).toBeInTheDocument();
  fireEvent.click(ownerModelButton);
  expect(screen.queryByText("OpenRouter: Catalog Only Owner Test")).not.toBeInTheDocument();
  fireEvent.keyDown(document, { key: "Escape" });

  fireEvent.click(screen.getByText("Aperture Platform Owner"));
  const previewGroup = await screen.findByRole("group", {
    name: "Preview role",
  });
  fireEvent.click(within(previewGroup).getByRole("button", { name: "User" }));

  // Previewing as a user must reflect grant-based access, not an ungranted
  // pseudo-user: the granted Client Update Agent stays selectable.
  const modelButton = await screen.findByRole("button", {
    name: "Select model",
  });
  expect(modelButton).toHaveTextContent("Client Update Agent");
  expect(screen.queryByText("No models connected")).not.toBeInTheDocument();
});

test("chat keeps provider setup errors out of the empty chat surface", async () => {
  window.localStorage.clear();
  window.localStorage.setItem(SESSION_STORAGE_KEY, "user-owner");
  const owner = sampleData.users.find((user) => user.id === "user-owner")!;
  const providerStatus =
    "OpenRouter rejected its provider key with HTTP 401. The model service connection needs attention. Contact your support administrator before using this model.";
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/bootstrap")) {
      return new Response(
        JSON.stringify({
          ...sampleData,
          me: owner,
          providers: sampleData.providers.map((provider) => ({
            ...provider,
            connected: false,
            status_message: provider.id === "provider-openrouter" ? providerStatus : provider.status_message,
          })),
          visibleUsers: sampleData.users.filter((user) => user.role !== "PLATFORM_OWNER"),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("unavailable", { status: 503 });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  expect(await screen.findByRole("button", { name: "No connected models" })).toBeDisabled();
  expect(screen.getByPlaceholderText("Connect a model provider to start chatting...")).toBeInTheDocument();
  expect(screen.queryByText("No usable model provider is connected")).not.toBeInTheDocument();
  expect(screen.queryByText(providerStatus)).not.toBeInTheDocument();
});

test("knowledge bases load documents and sync through the knowledge API", async () => {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/bootstrap")) {
        return new Response(
          JSON.stringify({
            ...sampleData,
            connectorConfigs: [
              {
                id: "conncfg-box-example",
                tenant_id: "tenant-example",
                connector_id: "box",
                enabled: true,
                auth_type: "developer-token",
                scopes: ["root_readwrite"],
                settings: {
                  root_folder: "/Clients/Example",
                  folder_id: "12345",
                },
                secret_set: true,
                masked_secret: "bo********en",
              },
            ],
            knowledgeConfigs: [
              {
                id: "knowledge-box-matters",
                tenant_id: "tenant-example",
                name: "Box Matter Knowledge",
                source_type: "box",
                connector_config_id: "conncfg-box-example",
                enabled: true,
                acl_group_ids: ["group-litigation"],
                secret_set: true,
                masked_secret: "bo********en",
                settings: {
                  description:
                    "Box matter pleadings, discovery, and client update work product.",
                  source: "Box Matter Folders",
                  status: "synced",
                  document_count: 1,
                  last_sync: "Loaded from API",
                  acl: "Groups: Litigation",
                  provider_status: "cached",
                  provider_message: "Cached indexed inventory loaded.",
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/knowledge/knowledge-box-matters/documents")) {
        return new Response(
          JSON.stringify([
            {
              id: "doc-box-motion",
              knowledge_config_id: "knowledge-box-matters",
              tenant_id: "tenant-example",
              name: "Box motion to compel outline.docx",
              source_uri: "box://files/987",
              source_type: "box",
              status: "indexed",
              chunk_count: 18,
              acl_group_ids: ["group-litigation"],
              updated_at: "2 minutes ago",
              citation_required: true,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/knowledge/knowledge-box-matters/sync")) {
        return new Response(
          JSON.stringify({
            status: "synced",
            synced_at: "Jan 2, 2026, 4:05 PM UTC",
            provider_status: "live",
            provider_message: "Box returned 1 file records from folder 12345.",
            config: {
              id: "knowledge-box-matters",
              tenant_id: "tenant-example",
              name: "Box Matter Knowledge",
              source_type: "box",
              connector_config_id: "conncfg-box-example",
              enabled: true,
              acl_group_ids: ["group-litigation"],
              secret_set: true,
              settings: {
                description:
                  "Box matter pleadings, discovery, and client update work product.",
                source: "Box Matter Folders",
                status: "synced",
                document_count: 1,
                last_sync: "Jan 2, 2026, 4:05 PM UTC",
                acl: "Groups: Litigation",
                provider_status: "live",
                provider_message:
                  "Box returned 1 file records from folder 12345.",
              },
            },
            documents: [
              {
                id: "doc-box-987",
                knowledge_config_id: "knowledge-box-matters",
                tenant_id: "tenant-example",
                name: "Live Box motion.docx",
                source_uri: "box://files/987",
                source_type: "box",
                status: "indexed",
                chunk_count: 21,
                acl_group_ids: ["group-litigation"],
                updated_at: "Jan 2, 2026, 4:05 PM UTC",
                citation_required: true,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unavailable", { status: 500 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  const primaryNav = await screen.findByRole("navigation", { name: "Primary" });
  fireEvent.click(
    within(primaryNav).getByRole("button", { name: "Knowledge/Tools" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Library" }),
  ).toBeInTheDocument();

  const boxRow = screen
    .getByText("Box Matter Knowledge")
    .closest("tr") as HTMLElement;
  fireEvent.click(within(boxRow).getByRole("button", { name: "Show Data" }));
  expect(
    await screen.findByText("Box motion to compel outline.docx"),
  ).toBeInTheDocument();
  expect(screen.getByText(/box:\/\/files\/987/)).toBeInTheDocument();

  fireEvent.click(within(boxRow).getByRole("button", { name: "Sync" }));
  expect(
    await screen.findByText(/synced 1 documents through the knowledge API/i),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Box returned 1 file records from folder 12345."),
  ).toBeInTheDocument();
  expect(screen.getByText("Box Matter Folders")).toBeInTheDocument();
  expect(await screen.findByText("Live Box motion.docx")).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getByText("Jan 2, 2026, 4:05 PM UTC")).toBeInTheDocument();
  });

  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining("/api/knowledge/knowledge-box-matters/sync"),
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ force: true }),
    }),
  );
});

test("knowledge external connection setup lives in the API data tab", async () => {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/bootstrap")) {
        return new Response(JSON.stringify(sampleData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (
        url.includes("/api/knowledge/knowledge-box-matters/documents") &&
        init?.method !== "POST"
      ) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("unavailable", { status: 500 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  const primaryNav = await screen.findByRole("navigation", { name: "Primary" });
  fireEvent.click(
    within(primaryNav).getByRole("button", { name: "Knowledge/Tools" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Library" }),
  ).toBeInTheDocument();

  const boxRow = screen
    .getByText("Box Matter Knowledge")
    .closest("tr") as HTMLElement;
  expect(
    within(boxRow).queryByRole("button", { name: /Configure/ }),
  ).not.toBeInTheDocument();

  fireEvent.click(within(boxRow).getByRole("button", { name: "Show Data" }));
  fireEvent.click(await screen.findByRole("tab", { name: "API" }));

  expect(screen.getByText("API source")).toBeInTheDocument();
  expect(screen.getByLabelText("Source label")).toBeInTheDocument();
  expect(screen.getByLabelText("Resource, folder, or path")).toBeInTheDocument();
  expect(screen.getByLabelText("Method")).toHaveValue("GET");
  expect(screen.getByLabelText("Header notes")).toBeInTheDocument();
  expect(screen.getByLabelText("Auth type")).toBeInTheDocument();
  expect(screen.queryByText(/connector setup/i)).not.toBeInTheDocument();
});

test("creates a knowledge base with its first web data source", async () => {
  const requests: Array<{ url: string; init?: RequestInit; body?: unknown }> =
    [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      requests.push({ url, init, body });

      if (url.includes("/api/bootstrap")) {
        return new Response(JSON.stringify(sampleData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (
        url.includes("/api/admin/knowledge-configs") &&
        init?.method === "POST"
      ) {
        return new Response(
          JSON.stringify({
            id: body.id,
            tenant_id: "tenant-example",
            name: body.name,
            source_type: body.source_type,
            connector_config_id: body.connector_config_id,
            enabled: body.enabled,
            acl_group_ids: body.acl_group_ids,
            owner_user_id: body.owner_user_id,
            secret_set: false,
            masked_secret: null,
            settings: body.settings,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }

      if (
        url.includes("/web-sources") &&
        init?.method === "POST"
      ) {
        const createRequest = requests.find(
          (request) =>
            request.url.includes("/api/admin/knowledge-configs") &&
            request.init?.method === "POST",
        );
        const createBody = createRequest?.body as Record<string, any>;
        return new Response(
          JSON.stringify({
            config: {
              id: createBody.id,
              tenant_id: "tenant-example",
              name: createBody.name,
              source_type: createBody.source_type,
              connector_config_id: null,
              enabled: true,
              acl_group_ids: createBody.acl_group_ids,
              owner_user_id: createBody.owner_user_id,
              secret_set: false,
              masked_secret: null,
              settings: {
                ...createBody.settings,
                status: "ready",
                document_count: 1,
                last_sync: "Just now",
              },
            },
            documents: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("unavailable", { status: 500 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  const primaryNav = await screen.findByRole("navigation", { name: "Primary" });
  fireEvent.click(
    within(primaryNav).getByRole("button", { name: "Knowledge/Tools" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Add Knowledge Base" }),
  );

  expect(
    await screen.findByRole("form", { name: "Create knowledge base" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: /Document uploads/ }));
  const createFileInput = screen.getByLabelText("Choose documents");
  expect(createFileInput).toBeInTheDocument();
  const firstCreateFile = new File(["First indexed note"], "first-note.txt", {
    type: "text/plain",
  });
  const secondCreateFile = new File(
    ["Second indexed note"],
    "second-note.txt",
    { type: "text/plain" },
  );
  fireEvent.change(createFileInput, {
    target: {
      files: fileListForInput([firstCreateFile, secondCreateFile]),
    },
  });
  expect(screen.getByText("Ready to index")).toBeInTheDocument();
  expect(screen.getByText("first-note.txt")).toBeInTheDocument();
  expect(screen.getByText("second-note.txt")).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Remove first-note.txt" }),
  );
  expect(screen.queryByText("first-note.txt")).not.toBeInTheDocument();
  expect(screen.getByText("second-note.txt")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: /Web links/ }));
  expect(screen.getByLabelText("Web address")).toBeInTheDocument();
  expect(screen.getByLabelText(/Source name/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: /API Connect/ }));
  expect(screen.getByLabelText("Base URL")).toBeInTheDocument();
  expect(screen.getByLabelText("Authentication")).toHaveValue("api-key");
  expect(screen.getByLabelText("API key")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: /Web links/ }));
  fireEvent.change(screen.getByLabelText("Web address"), {
    target: { value: "https://example.com/outside-counsel" },
  });
  fireEvent.change(screen.getByLabelText(/Source name/), {
    target: { value: "Outside Counsel Guidelines" },
  });
  expect(screen.queryByLabelText("Source label")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Description")).not.toBeInTheDocument();
  expect(screen.queryByText("Enable after creation")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Who can use it?")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("Knowledge base name"), {
    target: { value: "Outside Counsel Policy Library" },
  });
  fireEvent.change(screen.getByLabelText("Who can use it?"), {
    target: { value: "group-corporate" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Create with data source" }),
  );

  expect(
    await screen.findByText(
      "Outside Counsel Policy Library was created with its data source ready.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Outside Counsel Policy Library"),
  ).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Web sources" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByText("Web source")).toBeInTheDocument();

  const createRequest = requests.find(
    (request) =>
      request.url.includes("/api/admin/knowledge-configs") &&
      request.init?.method === "POST",
  );
  expect(createRequest?.body).toMatchObject({
    name: "Outside Counsel Policy Library",
    source_type: "web",
    connector_config_id: null,
    enabled: true,
    acl_group_ids: ["group-corporate"],
    owner_user_id: "user-admin",
    settings: {
      description:
        "Web URLs and extracted notes indexed into the vector knowledge API.",
      source: "Curated web sources",
      source_type_label: "Web links",
      status: "draft",
      document_count: 0,
      last_sync: "Not synced",
      acl: "Groups: Corporate",
    },
  });

  const webSourceRequest = requests.find(
    (request) =>
      request.url.includes("/web-sources") &&
      request.init?.method === "POST",
  );
  expect(webSourceRequest?.body).toEqual({
    name: "Outside Counsel Guidelines",
    url: "https://example.com/outside-counsel",
    text: null,
  });
});

test("uploads knowledge documents and reports indexed chunks", async () => {
  const uploadRequests: Array<{ fileNames: string[] }> = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/bootstrap")) {
        return new Response(JSON.stringify(sampleData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (
        url.includes("/api/knowledge/kb-litigation-playbook/documents") &&
        init?.method === "POST"
      ) {
        const form = init.body as FormData;
        uploadRequests.push({
          fileNames: form
            .getAll("files")
            .map((entry) =>
              entry instanceof File ? entry.name : String(entry),
            ),
        });
        return new Response(
          JSON.stringify({
            status: "synced",
            synced_at: "Jun 28, 2026, 2:12 PM UTC",
            provider_status: "live",
            provider_message: "Uploaded and indexed 1 document source.",
            config: {
              id: "kb-litigation-playbook",
              tenant_id: "tenant-example",
              name: "Litigation Playbook",
              source_type: "microsoft-graph",
              connector_config_id: "conncfg-graph-example",
              enabled: true,
              acl_group_ids: ["group-litigation"],
              secret_set: true,
              settings: {
                description:
                  "Pleadings, discovery templates, matter strategy notes, and cited legal guidance.",
                source: "SharePoint Litigation Library",
                status: "synced",
                document_count: 2,
                last_sync: "Jun 28, 2026, 2:12 PM UTC",
                acl: "AD Group: Litigation",
                provider_status: "live",
                provider_message: "Uploaded and indexed 1 document source.",
              },
            },
            documents: [
              {
                id: "doc-responsive-pleading",
                knowledge_config_id: "kb-litigation-playbook",
                tenant_id: "tenant-example",
                name: "Responsive pleading template.docx",
                source_uri:
                  "graph://sites/example-litigation/pleadings/responsive-pleading-template.docx",
                source_type: "microsoft-graph",
                status: "indexed",
                chunk_count: 31,
                acl_group_ids: ["group-litigation"],
                updated_at: "Jun 28, 2026, 7:26 AM UTC",
                citation_required: true,
              },
              {
                id: "doc-client-update",
                knowledge_config_id: "kb-litigation-playbook",
                tenant_id: "tenant-example",
                name: "client-update.txt",
                source_uri:
                  "upload://knowledge/kb-litigation-playbook/client-update.txt",
                source_type: "upload",
                status: "indexed",
                chunk_count: 7,
                acl_group_ids: ["group-litigation"],
                updated_at: "Jun 28, 2026, 2:12 PM UTC",
                citation_required: true,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/api/knowledge/kb-litigation-playbook/documents")) {
        return new Response(
          JSON.stringify([
            {
              id: "doc-responsive-pleading",
              knowledge_config_id: "kb-litigation-playbook",
              tenant_id: "tenant-example",
              name: "Responsive pleading template.docx",
              source_uri:
                "graph://sites/example-litigation/pleadings/responsive-pleading-template.docx",
              source_type: "microsoft-graph",
              status: "indexed",
              chunk_count: 31,
              acl_group_ids: ["group-litigation"],
              updated_at: "Jun 28, 2026, 7:26 AM UTC",
              citation_required: true,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("unavailable", { status: 500 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  const primaryNav = await screen.findByRole("navigation", { name: "Primary" });
  fireEvent.click(
    within(primaryNav).getByRole("button", { name: "Knowledge/Tools" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Library" }),
  ).toBeInTheDocument();
  const row = (await screen.findByText("Litigation Playbook")).closest(
    "tr",
  ) as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Show Data" }));

  const fileInput = (await screen.findByLabelText(
    "Upload documents to Litigation Playbook",
    {
      selector: "input",
    },
  )) as HTMLInputElement;
  const file = new File(
    ["Client update should lead with response deadline."],
    "client-update.txt",
    {
      type: "text/plain",
    },
  );
  expect(fileInput).toBeEnabled();
  fireEvent.change(fileInput, { target: { files: fileListForInput([file]) } });

  await waitFor(() =>
    expect(uploadRequests).toEqual([{ fileNames: ["client-update.txt"] }]),
  );
  expect(
    await screen.findByText(
      /Current index: 2 documents, 38 searchable chunks/i,
    ),
  ).toBeInTheDocument();
  expect(await screen.findByText("client-update.txt")).toBeInTheDocument();
});

test("knowledge API source shows OAuth client metadata fields and saves them", async () => {
  const requests: Array<{ url: string; init?: RequestInit; body?: unknown }> =
    [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const body =
        typeof init?.body === "string"
          ? JSON.parse(init.body as string)
          : undefined;
      requests.push({ url, init, body });

      if (url.includes("/api/bootstrap")) {
        return new Response(JSON.stringify(sampleData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (
        url.includes("/api/knowledge/kb-litigation-playbook/documents") &&
        init?.method !== "POST"
      ) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (
        url.includes("/api/knowledge/kb-litigation-playbook/api-sources") &&
        init?.method === "POST"
      ) {
        return new Response(
          JSON.stringify({
            status: "synced",
            synced_at: "Jun 30, 2026, 9:20 AM UTC",
            provider_status: "live",
            provider_message:
              "Registered API source Matter API and stored the credential in the backend vault.",
            config: {
              id: "kb-litigation-playbook",
              tenant_id: "tenant-example",
              name: "Litigation Playbook",
              source_type: "microsoft-graph",
              connector_config_id: "conncfg-graph-example",
              enabled: true,
              acl_group_ids: ["group-litigation"],
              secret_set: true,
              settings: {
                description:
                  "Pleadings, discovery templates, matter strategy notes, and cited legal guidance.",
                source: "SharePoint Litigation Library",
                status: "synced",
                document_count: 12,
                last_sync: "Jun 30, 2026, 9:20 AM UTC",
                acl: "AD Group: Litigation",
                provider_status: "live",
                provider_message:
                  "Registered API source Matter API and stored the credential in the backend vault.",
              },
            },
            documents: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("unavailable", { status: 500 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  const primaryNav = await screen.findByRole("navigation", { name: "Primary" });
  fireEvent.click(
    within(primaryNav).getByRole("button", { name: "Knowledge/Tools" }),
  );

  const litigationRow = (await screen.findByText("Litigation Playbook")).closest(
    "tr",
  ) as HTMLElement;
  fireEvent.click(
    within(litigationRow).getByRole("button", { name: "Show Data" }),
  );

  expect(
    await screen.findByLabelText("Add sources to Litigation Playbook"),
  ).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Documents" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  fireEvent.click(screen.getByRole("tab", { name: "API" }));

  const sourceCards = Array.from(
    document.querySelectorAll("details.knowledge-source-details"),
  );
  const apiDetails = sourceCards.find((details) =>
    details.textContent?.includes("API source"),
  ) as HTMLDetailsElement;
  expect(apiDetails).toBeTruthy();
  expect(apiDetails).toHaveClass("knowledge-api-source-details");
  expect(apiDetails.closest(".knowledge-detail-grid")).toHaveClass("is-api-tab");

  expect(within(apiDetails).getByLabelText("Name").closest("label")).toHaveClass(
    "knowledge-api-name-field",
  );
  fireEvent.change(within(apiDetails).getByLabelText("Name"), {
    target: { value: "Matter API" },
  });
  expect(within(apiDetails).getByLabelText("Base URL").closest("label")).toHaveClass(
    "knowledge-api-wide-field",
  );
  fireEvent.change(within(apiDetails).getByLabelText("Base URL"), {
    target: { value: "https://api.matter.example.com" },
  });
  expect(within(apiDetails).getByLabelText("Source label").closest("label")).toHaveClass(
    "knowledge-api-wide-field",
  );
  expect(within(apiDetails).getByLabelText("Method").closest("label")).toHaveClass(
    "knowledge-api-method-field",
  );
  expect(within(apiDetails).getByLabelText("API key")).toBeInTheDocument();
  expect(within(apiDetails).getByLabelText("Key name")).toHaveValue(
    "X-API-Key",
  );
  expect(within(apiDetails).getByLabelText("Send as")).toHaveValue("header");
  fireEvent.change(within(apiDetails).getByLabelText("Auth type"), {
    target: { value: "bearer-token" },
  });
  expect(within(apiDetails).getByLabelText("Bearer token")).toBeInTheDocument();
  expect(within(apiDetails).getByLabelText("Authorization header")).toHaveValue(
    "Authorization: Bearer [stored token]",
  );
  fireEvent.change(within(apiDetails).getByLabelText("Auth type"), {
    target: { value: "oauth-client" },
  });

  expect(
    within(apiDetails).getByLabelText("OAuth client ID"),
  ).toBeInTheDocument();
  expect(
    within(apiDetails).getByLabelText("OAuth client secret"),
  ).toBeInTheDocument();
  expect(within(apiDetails).getByLabelText("Token URL")).toBeInTheDocument();
  expect(within(apiDetails).getByLabelText("Redirect URI")).toHaveValue(
    "http://localhost:8000/api/knowledge/kb-litigation-playbook/oauth/callback",
  );

  fireEvent.change(within(apiDetails).getByLabelText("OAuth client ID"), {
    target: { value: "matter-client-id" },
  });
  fireEvent.change(within(apiDetails).getByLabelText("OAuth client secret"), {
    target: { value: "matter-client-secret" },
  });
  fireEvent.change(within(apiDetails).getByLabelText("Authorization URL"), {
    target: { value: "https://login.example.com/oauth/authorize" },
  });
  fireEvent.change(within(apiDetails).getByLabelText("Token URL"), {
    target: { value: "https://login.example.com/oauth/token" },
  });
  fireEvent.change(within(apiDetails).getByLabelText("Scopes"), {
    target: { value: "matters.read, documents.read" },
  });
  fireEvent.change(within(apiDetails).getByLabelText("Audience or tenant"), {
    target: { value: "tenant-example" },
  });
  fireEvent.click(
    within(apiDetails).getByRole("button", { name: /save api source/i }),
  );

  expect(
    await screen.findByText(
      "Litigation Playbook API source saved and indexed.",
    ),
  ).toBeInTheDocument();

  const apiSourceRequest = requests.find(
    (request) =>
      request.url.includes("/api/knowledge/kb-litigation-playbook/api-sources") &&
      request.init?.method === "POST",
  );
  expect(apiSourceRequest?.body).toMatchObject({
    name: "Matter API",
    base_url: "https://api.matter.example.com",
    auth_type: "oauth-client",
    secret_value: "matter-client-secret",
    client_id: "matter-client-id",
    authorization_url: "https://login.example.com/oauth/authorize",
    token_url: "https://login.example.com/oauth/token",
    callback_url:
      "http://localhost:8000/api/knowledge/kb-litigation-playbook/oauth/callback",
    scopes: ["matters.read", "documents.read"],
    audience: "tenant-example",
  });
});

test("deletes a single indexed knowledge document", async () => {
  const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const responsiveDocument = {
    id: "doc-responsive-pleading",
    knowledge_config_id: "kb-litigation-playbook",
    tenant_id: "tenant-example",
    name: "Responsive pleading template.docx",
    source_uri:
      "graph://sites/example-litigation/pleadings/responsive-pleading-template.docx",
    source_type: "microsoft-graph",
    status: "indexed",
    chunk_count: 31,
    acl_group_ids: ["group-litigation"],
    updated_at: "Jun 28, 2026, 7:26 AM UTC",
    citation_required: true,
  };
  const discoveryDocument = {
    id: "doc-discovery-playbook",
    knowledge_config_id: "kb-litigation-playbook",
    tenant_id: "tenant-example",
    name: "Discovery objections playbook.pdf",
    source_uri:
      "graph://sites/example-litigation/discovery/discovery-objections-playbook.pdf",
    source_type: "microsoft-graph",
    status: "indexed",
    chunk_count: 53,
    acl_group_ids: ["group-litigation"],
    updated_at: "Jun 28, 2026, 7:26 AM UTC",
    citation_required: true,
  };
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push({ url, init });

      if (url.includes("/api/bootstrap")) {
        return new Response(JSON.stringify(sampleData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (
        url.includes(
          "/api/knowledge/kb-litigation-playbook/documents/doc-responsive-pleading",
        ) &&
        init?.method === "DELETE"
      ) {
        return new Response(
          JSON.stringify({
            status: "synced",
            synced_at: "Jun 28, 2026, 2:20 PM UTC",
            provider_status: "live",
            provider_message:
              "Deleted Responsive pleading template.docx from the knowledge index.",
            config: {
              id: "kb-litigation-playbook",
              tenant_id: "tenant-example",
              name: "Litigation Playbook",
              source_type: "microsoft-graph",
              connector_config_id: "conncfg-graph-example",
              enabled: true,
              acl_group_ids: ["group-litigation"],
              secret_set: true,
              settings: {
                description:
                  "Pleadings, discovery templates, matter strategy notes, and cited legal guidance.",
                source: "SharePoint Litigation Library",
                status: "synced",
                document_count: 1,
                last_sync: "Jun 28, 2026, 2:20 PM UTC",
                acl: "AD Group: Litigation",
                provider_status: "live",
                provider_message:
                  "Deleted Responsive pleading template.docx from the knowledge index.",
              },
            },
            documents: [discoveryDocument],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/api/knowledge/kb-litigation-playbook/documents")) {
        return new Response(
          JSON.stringify([responsiveDocument, discoveryDocument]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response("unavailable", { status: 500 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  const primaryNav = await screen.findByRole("navigation", { name: "Primary" });
  fireEvent.click(
    within(primaryNav).getByRole("button", { name: "Knowledge/Tools" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Library" }),
  ).toBeInTheDocument();
  const row = (await screen.findByText("Litigation Playbook")).closest(
    "tr",
  ) as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Show Data" }));

  const documentList = await screen.findByRole("list", {
    name: "Litigation Playbook indexed document inventory",
  });
  expect(documentList).toHaveClass("knowledge-document-list");
  expect(
    within(documentList).getByText("Responsive pleading template.docx"),
  ).toBeInTheDocument();
  expect(within(documentList).queryByText("indexed")).not.toBeInTheDocument();
  expect(within(documentList).queryByText("31 chunks")).not.toBeInTheDocument();
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Delete Responsive pleading template.docx",
    }),
  );

  await waitFor(() =>
    expect(
      requests.some(
        (request) =>
          request.url.includes(
            "/api/knowledge/kb-litigation-playbook/documents/doc-responsive-pleading",
          ) && request.init?.method === "DELETE",
      ),
    ).toBe(true),
  );
  expect(confirmSpy).toHaveBeenCalledWith(
    "Delete Responsive pleading template.docx? This removes the document and its indexed chunks.",
  );
  expect(
    await screen.findByText(
      /Current index: 1 documents, 53 searchable chunks/i,
    ),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", {
      name: "Delete Responsive pleading template.docx",
    }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText("Discovery objections playbook.pdf"),
  ).toBeInTheDocument();
  confirmSpy.mockRestore();
});

test("deletes a knowledge base through the admin API", async () => {
  const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push({ url, init });

      if (url.includes("/api/bootstrap")) {
        return new Response(JSON.stringify(sampleData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (
        url.includes("/api/admin/knowledge-configs/kb-litigation-playbook") &&
        init?.method === "DELETE"
      ) {
        return new Response(
          JSON.stringify({ status: "deleted", id: "kb-litigation-playbook" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response("unavailable", { status: 500 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  const primaryNav = await screen.findByRole("navigation", { name: "Primary" });
  fireEvent.click(
    within(primaryNav).getByRole("button", { name: "Knowledge/Tools" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Library" }),
  ).toBeInTheDocument();
  const row = (await screen.findByText("Litigation Playbook")).closest(
    "tr",
  ) as HTMLElement;
  const deleteButton = within(row).getByRole("button", { name: "Delete" });
  expect(deleteButton).toBeEnabled();
  fireEvent.click(deleteButton);
  expect(confirmSpy).toHaveBeenCalledWith(
    "Delete Litigation Playbook? This removes the knowledge base, indexed documents, and model links from the tenant catalog.",
  );

  await waitFor(() =>
    expect(
      requests.some(
        (request) =>
          request.url.includes(
            "/api/admin/knowledge-configs/kb-litigation-playbook",
          ) && request.init?.method === "DELETE",
      ),
    ).toBe(true),
  );
  expect(
    await screen.findByText(
      "Litigation Playbook deleted from the admin knowledge API.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("SharePoint Litigation Library"),
  ).not.toBeInTheDocument();
  confirmSpy.mockRestore();
});

test("clears all knowledge bases through the admin API", async () => {
  const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push({ url, init });

      if (url.includes("/api/bootstrap")) {
        return new Response(JSON.stringify(sampleData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (
        url.includes("/api/admin/knowledge-configs/") &&
        init?.method === "DELETE"
      ) {
        const id = url.split("/api/admin/knowledge-configs/")[1];
        return new Response(JSON.stringify({ status: "deleted", id }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("unavailable", { status: 500 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  const primaryNav = await screen.findByRole("navigation", { name: "Primary" });
  fireEvent.click(
    within(primaryNav).getByRole("button", { name: "Knowledge/Tools" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Library" }),
  ).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Clear Knowledge" }));
  expect(confirmSpy).toHaveBeenCalledWith(
    `Delete all ${sampleData.knowledgeBases.length} knowledge bases? This removes the knowledge bases, indexed documents, and model links from the tenant catalog.`,
  );

  await waitFor(() =>
    expect(
      requests.filter(
        (request) =>
          request.url.includes("/api/admin/knowledge-configs/") &&
          request.init?.method === "DELETE",
      ),
    ).toHaveLength(sampleData.knowledgeBases.length),
  );
  expect(
    await screen.findByText(
      `Cleared ${sampleData.knowledgeBases.length} knowledge bases.`,
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText("Litigation Playbook")).not.toBeInTheDocument();
  expect(screen.queryByText("Box Matter Knowledge")).not.toBeInTheDocument();
  expect(screen.queryByText("Corporate Policy Library")).not.toBeInTheDocument();
  confirmSpy.mockRestore();
});

test("deletes a tool configuration through the admin API", async () => {
  const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push({ url, init });

      if (url.includes("/api/bootstrap")) {
        return new Response(JSON.stringify(sampleData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (
        url.includes("/api/admin/tool-configs/tool-agent-workflow") &&
        init?.method === "DELETE"
      ) {
        return new Response(
          JSON.stringify({ status: "deleted", id: "tool-agent-workflow" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response("unavailable", { status: 500 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  const primaryNav = await screen.findByRole("navigation", { name: "Primary" });
  fireEvent.click(within(primaryNav).getByRole("button", { name: "Knowledge/Tools" }));
  fireEvent.click(
    within(await screen.findByRole("group", { name: "Library sections" })).getByRole("button", {
      name: "Tools",
    }),
  );
  const toolRow = await screen.findByText("Agent Workflow Runner");
  const row = toolRow.closest("tr") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Configure MCP" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete tool" }));

  expect(
    await screen.findByText(
      "Agent Workflow Runner deleted from the admin tool API.",
    ),
  ).toBeInTheDocument();
  expect(confirmSpy).toHaveBeenCalledWith(
    "Delete Agent Workflow Runner? This removes the tool configuration from the tenant catalog.",
  );
  expect(
    requests.some(
      (request) =>
        request.url.includes("/api/admin/tool-configs/tool-agent-workflow") &&
        request.init?.method === "DELETE",
    ),
  ).toBe(true);
  expect(screen.queryByText("/api/agents/runs")).not.toBeInTheDocument();
  confirmSpy.mockRestore();
});

test("saves MCP tool settings without agent prompt or skill attachments", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      requests.push({ url, init });

      if (url.includes("/api/bootstrap")) {
        return new Response(JSON.stringify(sampleData), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (
        url.includes("/api/admin/tool-configs/tool-hermes-agent-mcp") &&
        init?.method === "PATCH"
      ) {
        const body = JSON.parse(String(init.body)) as {
          name: string;
          tool_type: string;
          endpoint_url: string | null;
          approval_required: boolean;
          allowed_group_ids: string[];
          settings: Record<string, unknown>;
        };
        return new Response(
          JSON.stringify({
            id: "tool-hermes-agent-mcp",
            tenant_id: sampleData.currentTenant.id,
            enabled: true,
            secret_set: true,
            masked_secret: "Existing secret retained",
            name: body.name,
            tool_type: body.tool_type,
            endpoint_url: body.endpoint_url,
            approval_required: body.approval_required,
            allowed_group_ids: body.allowed_group_ids,
            settings: body.settings,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response("unavailable", { status: 500 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  const primaryNav = await screen.findByRole("navigation", { name: "Primary" });
  fireEvent.click(within(primaryNav).getByRole("button", { name: "Knowledge/Tools" }));
  fireEvent.click(
    within(await screen.findByRole("group", { name: "Library sections" })).getByRole("button", {
      name: "Tools",
    }),
  );
  expect(screen.getByRole("tab", { name: "Connections" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("tab", { name: "Prompts" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Skills" })).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Prompt Template Library" }),
  ).not.toBeInTheDocument();
  const toolRow = await screen.findByText("Hermes Agent MCP");
  const row = toolRow.closest("tr") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Configure MCP" }));
  expect(screen.queryByText("Agent attachments")).not.toBeInTheDocument();
  expect(screen.getByText("Allowed groups")).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: /Litigation/i })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: /Finance Team/i })).toBeChecked();
  expect(screen.getByText("Require approval before MCP calls")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Pauses each invocation until an authorized user approves the tool run.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByText("Expose as Hermes companion")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Makes this server available to Hermes companion workflows that coordinate multi-step agent work.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("switch", { name: "Require approval before MCP calls" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("switch", { name: "Expose as Hermes companion" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("group", { name: "Skill files" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("group", { name: "Template prompts" }),
  ).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Save tool" }));

  await waitFor(() =>
    expect(
      requests.some(
        (request) =>
          request.url.includes(
            "/api/admin/tool-configs/tool-hermes-agent-mcp",
          ) && request.init?.method === "PATCH",
      ),
    ).toBe(true),
  );
  const saveRequest = requests.find(
    (request) =>
      request.url.includes("/api/admin/tool-configs/tool-hermes-agent-mcp") &&
      request.init?.method === "PATCH",
  );
  const payload = JSON.parse(String(saveRequest?.init?.body)) as {
    settings: Record<string, unknown>;
  };
  expect(payload.settings.skill_files).toBeUndefined();
  expect(payload.settings.prompt_templates).toBeUndefined();
  expect(payload.settings.runtime_invocations).toEqual([]);
  expect(payload.settings.hermes_companion).toBe(true);
  expect(
    JSON.parse(String(saveRequest?.init?.body)).allowed_group_ids,
  ).toEqual(["group-litigation", "group-finance"]);
});
