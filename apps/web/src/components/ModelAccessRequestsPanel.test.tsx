import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { sampleData } from "../data/sampleData";
import type { AdminModelAccessRequestView } from "../lib/types";
import { ModelAccessRequestsPanel } from "./ModelAccessRequestsPanel";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const view: AdminModelAccessRequestView = {
  request: { id: "mar-9", tenant_id: sampleData.currentTenant.id, user_id: "user-jane", model_id: "frontier", status: "pending", note: "For the memo", created_at: "2026-09-13T00:00:00Z", updated_at: "2026-09-13T00:00:00Z", resolved_by_user_id: null, resolution_note: null, granted_group_id: null },
  requester_display_name: "Jane Smith",
  requester_email: "jane.smith@example.com",
  requester_group_ids: [sampleData.groups[0].id],
  model_name: "Frontier",
  model_provider_name: "Example Provider",
  eligible_group_ids: [sampleData.groups[1]?.id ?? sampleData.groups[0].id],
  can_grant_new_group: true,
  decision: { allowed: false, usable: false, reason_code: "group_grant", reason: "Not granted to any of your groups.", gates: [], requestable: true },
};

test("approving sends the chosen group and reports the server's post-state", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/admin/model-access-requests?")) return json([view]);
    if (url.endsWith("/mar-9/approve")) {
      return json({ request: { ...view.request, status: "approved" }, decision: { allowed: true, usable: true, reason_code: null, reason: "You can use this model.", gates: [], requestable: false } });
    }
    return json({}, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  const onResolved = vi.fn();
  render(<ModelAccessRequestsPanel actorUserId="user-admin" groups={sampleData.groups} onResolved={onResolved} />);

  expect(await screen.findByText("Jane Smith")).toBeInTheDocument();
  expect(screen.getByText(/Server reason: Not granted/)).toBeInTheDocument();
  const select = screen.getByLabelText("Group for Jane Smith") as HTMLSelectElement;
  expect(select.value).toBe(view.eligible_group_ids[0]);
  fireEvent.change(select, { target: { value: sampleData.groups[0].id } });
  expect(screen.getByText(/does not carry the model yet/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  expect(await screen.findByText(/can now use Frontier through/)).toBeInTheDocument();
  const approveCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/mar-9/approve"))!;
  expect(JSON.parse(String(approveCall[1]?.body))).toEqual({ group_id: sampleData.groups[0].id });
  expect((approveCall[1]?.headers as Record<string, string>)["x-aperture-user"]).toBe("user-admin");
  await waitFor(() => expect(screen.queryByText("Jane Smith")).not.toBeInTheDocument());
  expect(onResolved).toHaveBeenCalledOnce();
  expect(screen.getByText("No pending access requests.")).toBeInTheDocument();
});

test("a refused approval keeps the request in the queue with the server message", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/admin/model-access-requests?")) return json([view]);
    if (url.endsWith("/approve")) return json({ detail: "Tenant admins can only assign groups from their tenant." }, 403);
    return json({}, 500);
  }));
  render(<ModelAccessRequestsPanel actorUserId="user-admin" groups={sampleData.groups} />);
  fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  expect(await screen.findByText("Tenant admins can only assign groups from their tenant.")).toBeInTheDocument();
  expect(screen.getByText("Jane Smith")).toBeInTheDocument();
});
