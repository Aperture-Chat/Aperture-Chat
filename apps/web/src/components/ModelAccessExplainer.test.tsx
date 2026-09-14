import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ModelCatalogResponse } from "../lib/types";
import { ModelAccessExplainer } from "./ModelAccessExplainer";

const catalog: ModelCatalogResponse = {
  browsing_enabled: true,
  entries: [
    {
      model: { id: "m-ok", name: "Workhorse", provider_id: "p1", provider_name: "Example Provider", upstream_model_id: null, platform_enabled: true, is_custom: false, visibility: "organization", context_window: null },
      decision: { allowed: true, usable: true, reason_code: null, reason: "You can use this model.", gates: [], requestable: false },
      open_request: null,
    },
    {
      model: { id: "m-locked", name: "Frontier", provider_id: "p1", provider_name: "Example Provider", upstream_model_id: null, platform_enabled: true, is_custom: false, visibility: "organization", context_window: null },
      decision: { allowed: false, usable: false, reason_code: "group_grant", reason: "Not granted to any of your groups. An administrator can add you to a group that has this model.", gates: [], requestable: true },
      open_request: null,
    },
    {
      model: { id: "m-temp", name: "Restricted", provider_id: "p1", provider_name: "Example Provider", upstream_model_id: null, platform_enabled: true, is_custom: false, visibility: "organization", context_window: null },
      decision: { allowed: false, usable: false, reason_code: "temp_user_contract", reason: "Temporary accounts can use only the designated temporary-access models.", gates: [], requestable: false },
      open_request: null,
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("renders server reasons verbatim and only offers requests where the server allows", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/me/model-catalog")) return json(catalog);
    if (url.endsWith("/api/me/model-access-requests") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { model_id: string };
      const entry = catalog.entries.find((item) => item.model.id === body.model_id)!;
      return json({ ...entry, open_request: { id: "mar-1", tenant_id: "t", user_id: "u", model_id: body.model_id, status: "pending", note: null, created_at: "2026-09-13T00:00:00Z", updated_at: "2026-09-13T00:00:00Z", resolved_by_user_id: null, resolution_note: null, granted_group_id: null } }, 202);
    }
    if (url.includes("/api/me/model-access-requests/mar-1") && init?.method === "DELETE") {
      return json({ id: "mar-1", status: "withdrawn" });
    }
    return json({ detail: "unexpected" }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  const onClose = vi.fn();
  render(<ModelAccessExplainer userId="user-jane" onClose={onClose} />);

  const dialog = await screen.findByRole("dialog", { name: "Models in your organization" });
  expect(within(dialog).getByText("Workhorse")).toBeInTheDocument();
  expect(within(dialog).getByText(catalog.entries[1].decision.reason)).toBeInTheDocument();
  expect(within(dialog).getByText(catalog.entries[2].decision.reason)).toBeInTheDocument();

  const buttons = within(dialog).getAllByRole("button", { name: "Request access" });
  expect(buttons).toHaveLength(2);
  const enabled = buttons.filter((button) => !(button as HTMLButtonElement).disabled);
  expect(enabled).toHaveLength(1);

  fireEvent.click(enabled[0]);
  expect(await within(dialog).findByText(/Request sent for Frontier/)).toBeInTheDocument();
  const withdraw = await within(dialog).findByRole("button", { name: "Withdraw request" });
  expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/api/me/model-access-requests") && init?.method === "POST")).toBe(true);

  fireEvent.click(withdraw);
  await waitFor(() => expect(within(dialog).queryByRole("button", { name: "Withdraw request" })).not.toBeInTheDocument());
  expect(within(dialog).getAllByRole("button", { name: "Request access" })).toHaveLength(2);

  fireEvent.click(within(dialog).getByRole("button", { name: "Close model access dialog" }));
  expect(onClose).toHaveBeenCalledOnce();
});

test("shows an honest error when the server refuses a request", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/me/model-catalog")) return json(catalog);
    if (init?.method === "POST") return json({ detail: "Too many access requests. Try again shortly." }, 429);
    return json({}, 500);
  }));
  render(<ModelAccessExplainer userId="user-jane" onClose={vi.fn()} />);
  const dialog = await screen.findByRole("dialog", { name: "Models in your organization" });
  const enabled = within(dialog).getAllByRole("button", { name: "Request access" }).find((button) => !(button as HTMLButtonElement).disabled)!;
  fireEvent.click(enabled);
  expect(await within(dialog).findByText("Too many access requests. Try again shortly.")).toBeInTheDocument();
  expect(within(dialog).queryByRole("button", { name: "Withdraw request" })).not.toBeInTheDocument();
});

test("explains the owner kill switch when browsing is disabled", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ browsing_enabled: false, entries: [catalog.entries[0]] })));
  render(<ModelAccessExplainer userId="user-jane" onClose={vi.fn()} />);
  const dialog = await screen.findByRole("dialog", { name: "Models in your organization" });
  expect(await within(dialog).findByText(/shows only the models you can already use/)).toBeInTheDocument();
  expect(within(dialog).queryByRole("button", { name: "Request access" })).not.toBeInTheDocument();
});
