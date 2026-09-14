import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { PlatformSetupStatus } from "../lib/types";
import { PlatformSetupWizard } from "./PlatformSetupWizard";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function statusWith(overrides: Partial<Record<PlatformSetupStatus["steps"][number]["key"], Partial<PlatformSetupStatus["steps"][number]>>> = {}, ready = false): PlatformSetupStatus {
  const base = (key: PlatformSetupStatus["steps"][number]["key"], summary: string): PlatformSetupStatus["steps"][number] => ({
    key,
    state: "todo",
    summary,
    counts: {},
    providers: [],
    per_tenant: [],
    ...overrides[key],
  });
  return {
    ready_for_users: ready,
    generated_at: "2026-09-13T00:00:00Z",
    steps: [
      base("provider", "1 provider, 0 connected"),
      base("credential", "1 of 1 providers has an active platform key"),
      base("validate", "No provider has passed a live runtime test yet."),
      base("catalog", "No models in the catalog yet. Sync a connected provider."),
      base("enable", "Enable models once the catalog has synced."),
      base("grant", "Grant models to groups once some are enabled."),
    ],
  };
}

const provider = {
  id: "p1",
  name: "Example Provider",
  kind: "openai",
  connected: false,
  has_active_platform_key: true,
  supports_model_sync: true,
  model_count: 0,
  last_validation_status: null,
  last_validated_at: null,
  last_validation_model_id: null,
  last_synced_at: null,
  status_message: null,
};

test("renders server states verbatim and never marks a step done on a failed validation", async () => {
  let validated = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/platform/setup-status")) {
      return json(
        statusWith({
          provider: { state: "done" },
          credential: { state: "done" },
          validate: {
            state: validated ? "attention" : "todo",
            providers: [{ ...provider, last_validation_status: validated ? "failed" : null, status_message: validated ? "upstream 503" : null }],
          },
        }),
      );
    }
    if (url.endsWith("/api/platform/providers/p1/validate") && init?.method === "POST") {
      validated = true;
      return json({ detail: "Example Provider model sync succeeded, but live chat validation failed: upstream 503." }, 503);
    }
    return json({}, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  const onNavigate = vi.fn();
  render(<PlatformSetupWizard actorUserId="user-owner" onNavigate={onNavigate} />);

  const steps = await screen.findByRole("list", { name: "Setup steps" });
  const items = within(steps).getAllByRole("listitem");
  expect(items[0]).toHaveTextContent("Done");
  expect(items[2]).toHaveTextContent("To do");
  expect(screen.getByText("No provider has passed a live runtime test yet.")).toBeInTheDocument();
  expect(screen.getByText(/Not ready for users yet/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Validate now" }));
  expect(await screen.findByText(/live chat validation failed: upstream 503/)).toBeInTheDocument();
  await waitFor(() => expect(within(screen.getByRole("list", { name: "Setup steps" })).getAllByRole("listitem")[2]).toHaveTextContent("Needs attention"));
  expect(screen.getByText(/Failed ·/)).toBeInTheDocument();
  const validateCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/validate"));
  expect(validateCalls).toHaveLength(1);
  expect((validateCalls[0][1]?.headers as Record<string, string>)["x-aperture-user"]).toBe("user-owner");

  const grantStep = within(screen.getByRole("list", { name: "Setup steps" })).getAllByRole("listitem").at(-1)!;
  fireEvent.click(within(grantStep).getByRole("button", { name: /Open Model Access/ }));
  expect(onNavigate).toHaveBeenCalledWith({ kind: "admin", section: "model-access" });
});

test("a passing validation reports the returned model and latency, then refetches", async () => {
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/platform/setup-status")) {
      calls += 1;
      return json(statusWith({ validate: { providers: [provider] } }, true));
    }
    if (url.endsWith("/validate") && init?.method === "POST") {
      return json({ provider: { ...provider, connected: true }, model_id: "gpt-4o-mini", model_name: "gpt-4o-mini", latency_ms: 412 });
    }
    return json({}, 500);
  }));
  render(<PlatformSetupWizard actorUserId="user-owner" onNavigate={vi.fn()} />);
  expect(await screen.findByText(/Ready for users/)).toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "Validate now" }));
  expect(await screen.findByText("Example Provider: runtime test passed with gpt-4o-mini in 412 ms.")).toBeInTheDocument();
  await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
});
