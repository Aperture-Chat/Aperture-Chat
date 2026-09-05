import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PlatformUpdateStatus } from "../lib/types";
import { PlatformUpdateRow } from "./PlatformUpdateRow";

const HIGHLIGHTS = "- Owners can upgrade from the sidebar.\n- Release notes render before installing.";

function status(overrides: Partial<PlatformUpdateStatus> = {}): PlatformUpdateStatus {
  return {
    current_version: "v9.0.0",
    latest_version: "v9.1.0",
    update_available: true,
    releases: [
      {
        version: "v9.1.0",
        name: "Aperture Chat v9.1.0",
        url: "https://github.com/Aperture-Chat/Aperture-Chat/releases/tag/v9.1.0",
        published_at: "2026-09-03T10:00:00Z",
        highlights: HIGHLIGHTS,
        notes: `# Aperture Chat v9.1.0\n\n## Highlights\n\n${HIGHLIGHTS}\n\n## Deploy\n\nrun things\n`,
      },
    ],
    checked_at: "2026-09-03T11:00:00Z",
    check_error: null,
    check_enabled: true,
    repository: "Aperture-Chat/Aperture-Chat",
    releases_page_url: "https://github.com/Aperture-Chat/Aperture-Chat/releases",
    updater: {
      configured: true,
      connected: true,
      last_heartbeat_at: "2026-09-03T11:00:00Z",
      project: "aperture-chat",
      problem: null,
      run: { phase: "idle", message: "" },
      log_tail: "",
    },
    ...overrides,
  };
}

type FetchCall = { url: string; method: string; body: unknown };
const calls: FetchCall[] = [];

function mockApi(handler: (call: FetchCall) => PlatformUpdateStatus | { status: number; detail: string }) {
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: FetchCall = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const result = handler(call);
    if ("detail" in result && "status" in result && typeof result.status === "number") {
      return new Response(JSON.stringify({ detail: result.detail }), {
        status: result.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

beforeEach(() => {
  calls.length = 0;
  window.localStorage.clear();
  vi.mocked(globalThis.fetch).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

test("renders nothing and never calls the API when the viewer is not a platform owner", async () => {
  mockApi(() => status());
  const { container } = render(<PlatformUpdateRow userId="user-admin" enabled={false} />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(container).toBeEmptyDOMElement();
  expect(calls).toHaveLength(0);
});

test("renders nothing when the deployment is already on the newest release", async () => {
  mockApi(() => status({ update_available: false, releases: [], latest_version: "v9.0.0" }));
  const { container } = render(<PlatformUpdateRow userId="user-owner" enabled />);
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0].url).toBe("http://localhost:8000/api/platform/updates");
  expect(container).toBeEmptyDOMElement();
});

test("stays hidden when the API refuses the status", async () => {
  mockApi(() => ({ status: 403, detail: "This action requires service-level privileges." }));
  const { container } = render(<PlatformUpdateRow userId="user-admin" enabled />);
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(container).toBeEmptyDOMElement();
});

test.each([
  {},
  { updater: { run: null } },
  { ...status(), releases: [{ version: "v9.1.0", notes: null }] },
])("malformed optional update status cannot crash the surrounding workspace: %j", async (invalid) => {
  mockApi(() => invalid as PlatformUpdateStatus);
  render(<><p>Workspace remains available</p><PlatformUpdateRow userId="user-owner" enabled /></>);
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(screen.getByText("Workspace remains available")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Update to/ })).not.toBeInTheDocument();
});

test("shows the update row with release notes on hover for platform owners", async () => {
  mockApi(() => status());
  render(<PlatformUpdateRow userId="user-owner" enabled />);

  const row = await screen.findByRole("button", { name: /Update to v9\.1\.0/ });
  expect(row).toHaveAttribute("aria-haspopup", "dialog");

  fireEvent.focus(row);
  const card = await screen.findByRole("tooltip");
  expect(within(card).getByText("Aperture Chat v9.1.0")).toBeInTheDocument();
  expect(within(card).getByText(/You are on v9\.0\.0/)).toBeInTheDocument();
  expect(within(card).getByText("Owners can upgrade from the sidebar.")).toBeInTheDocument();
  expect(within(card).getByText("One-click install ready")).toBeInTheDocument();
  expect(row).toHaveAttribute("aria-describedby", card.id);
});

test("clicking the row opens the dialog and installing hands the upgrade to the updater", async () => {
  const requested = status({
    updater: {
      ...status().updater,
      run: {
        id: "upd-1",
        phase: "requested",
        target_version: "v9.1.0",
        previous_version: "v9.0.0",
        message: "Waiting for the updater to accept the request.",
      },
    },
  });
  mockApi((call) => (call.method === "POST" && call.url.endsWith("/apply") ? requested : status()));
  render(<PlatformUpdateRow userId="user-owner" enabled />);

  fireEvent.click(await screen.findByRole("button", { name: /Update to v9\.1\.0/ }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByRole("heading", { name: "Update to v9.1.0" })).toBeInTheDocument();
  expect(within(dialog).getByText("What this update brings")).toBeInTheDocument();
  expect(within(dialog).getByText("Release notes render before installing.")).toBeInTheDocument();
  expect(within(dialog).getByRole("link", { name: /Release page/ })).toHaveAttribute(
    "href",
    "https://github.com/Aperture-Chat/Aperture-Chat/releases/tag/v9.1.0",
  );
  expect(within(dialog).getByText("How the update runs")).toBeInTheDocument();

  const install = within(dialog).getByRole("button", { name: "Install v9.1.0" });
  expect(install).toBeEnabled();
  fireEvent.click(install);

  await waitFor(() => {
    const apply = calls.find((call) => call.url.endsWith("/api/platform/updates/apply"));
    expect(apply).toBeDefined();
    expect(apply?.method).toBe("POST");
    expect(apply?.body).toEqual({ target_version: "v9.1.0" });
  });
  await waitFor(() =>
    expect(within(dialog).getByRole("heading", { name: "Updating to v9.1.0" })).toBeInTheDocument(),
  );
  expect(within(dialog).getByRole("list", { name: "Update progress" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Starting update…/ })).toBeInTheDocument();
});

test("without the updater sidecar the install button is disabled and manual steps are shown", async () => {
  mockApi(() =>
    status({
      updater: {
        configured: false,
        connected: false,
        run: { phase: "idle", message: "" },
        log_tail: "",
      },
    }),
  );
  render(<PlatformUpdateRow userId="user-owner" enabled />);
  fireEvent.click(await screen.findByRole("button", { name: /Release available: v9\.1\.0/ }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByRole("button", { name: "Install v9.1.0" })).toBeDisabled();
  expect(within(dialog).getByText("Manual install on this deployment")).toBeInTheDocument();
  expect(within(dialog).getByText(/APERTURE_IMAGE_TAG=v9\.1\.0/)).toBeInTheDocument();
});

test("an offline sidecar explains itself and blocks one-click install", async () => {
  mockApi(() =>
    status({
      updater: {
        configured: true,
        connected: false,
        problem: "The updater sidecar has stopped reporting.",
        run: { phase: "idle", message: "" },
        log_tail: "",
      },
    }),
  );
  render(<PlatformUpdateRow userId="user-owner" enabled />);
  fireEvent.click(await screen.findByRole("button", { name: /Release available: v9\.1\.0/ }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByRole("button", { name: "Install v9.1.0" })).toBeDisabled();
  expect(within(dialog).getByRole("alert")).toHaveTextContent("The updater sidecar has stopped reporting.");
});

test("a completed upgrade stays visible until dismissed and offers a reload", async () => {
  const finishedAt = new Date().toISOString();
  mockApi(() =>
    status({
      current_version: "v9.1.0",
      latest_version: "v9.1.0",
      update_available: false,
      releases: [],
      updater: {
        ...status().updater,
        run: {
          id: "upd-done",
          phase: "succeeded",
          target_version: "v9.1.0",
          previous_version: "v9.0.0",
          message: "Upgrade to v9.1.0 complete.",
          finished_at: finishedAt,
        },
      },
    }),
  );
  const reload = vi.fn();
  const originalLocation = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, reload },
  });
  try {
    const { container } = render(<PlatformUpdateRow userId="user-owner" enabled />);
    fireEvent.click(await screen.findByRole("button", { name: /Update installed/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Updated to v9.1.0" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Reload now" }));
    expect(reload).toHaveBeenCalledTimes(1);

    fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(window.localStorage.getItem("aperture-platform-update-dismissed-run")).toBe("upd-done");
  } finally {
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  }
});

test("a failed upgrade surfaces the message and allows a retry", async () => {
  mockApi(() =>
    status({
      updater: {
        ...status().updater,
        run: {
          id: "upd-bad",
          phase: "rolled_back",
          target_version: "v9.1.0",
          previous_version: "v9.0.0",
          message: "The v9.1.0 API did not become healthy within 300s. Rolled back to v9.0.0.",
          finished_at: new Date().toISOString(),
        },
        log_tail: "pull complete\nhealth check timed out",
      },
    }),
  );
  render(<PlatformUpdateRow userId="user-owner" enabled />);
  fireEvent.click(await screen.findByRole("button", { name: /Update rolled back/ }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(/did not become healthy/)).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "Retry v9.1.0" })).toBeEnabled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Show updater log" }));
  expect(within(dialog).getByText(/health check timed out/)).toBeInTheDocument();
});

test("check again reports the throttle message instead of an error", async () => {
  mockApi((call) =>
    call.url.endsWith("/check")
      ? { status: 429, detail: "A release check already ran in the last minute. Try again shortly." }
      : status(),
  );
  render(<PlatformUpdateRow userId="user-owner" enabled />);
  fireEvent.click(await screen.findByRole("button", { name: /Update to v9\.1\.0/ }));
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: /Check again/ }));
  await waitFor(() =>
    expect(within(dialog).getByRole("status")).toHaveTextContent("already ran in the last minute"),
  );
  expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
});
