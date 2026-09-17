import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { TenantRetentionPolicy } from "../lib/types";
import { RetentionGovernance } from "./RetentionGovernance";
import { previewAdminRetentionPolicy, updateAdminRetentionPolicy } from "../lib/api/admin";
vi.mock("../lib/api/admin", () => ({ previewAdminRetentionPolicy: vi.fn(), updateAdminRetentionPolicy: vi.fn() }));
const policy: TenantRetentionPolicy = { tenant_id: "synthetic", enabled: false, automation_enabled: false, chat_retention_days: 0, grace_days: 0, retention_basis: "last_activity", action: "purge", notify_admins: false, mcp_tagging_enabled: false, attachment_tagging_enabled: false, subject_tagging_enabled: false, external_tags_enabled: false, rules: [], updated_at: "" };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(updateAdminRetentionPolicy).mockResolvedValue(policy); vi.mocked(previewAdminRetentionPolicy).mockResolvedValue({ total: 12, eligible: 3, held: 2, kept: 4, preview_token: "reviewed", review_days: 7, automation_enabled: true }); });
test("default Forever stays inactive and changing the slider does not save or delete", () => {
    render(<RetentionGovernance actorUserId="synthetic" policy={policy} onSaved={vi.fn()}/>);
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuetext", "Forever");
    expect(screen.getByText("Automatic deletion off")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "7 years" }));
    expect(screen.getByRole("button", { name: "Save retention policy" })).toBeDisabled();
    expect(updateAdminRetentionPolicy).not.toHaveBeenCalled();
});
test("enabling requires a preview of the exact draft and passes the token to save", async () => {
    render(<RetentionGovernance actorUserId="synthetic" policy={policy} onSaved={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button", { name: "7 years" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview effect" }));
    await screen.findByText("Effect on 12 saved chats");
    expect(previewAdminRetentionPolicy).toHaveBeenCalledWith("synthetic", expect.objectContaining({ chat_retention_days: 2555, automation_enabled: true, grace_days: 7 }));
    fireEvent.click(screen.getByRole("button", { name: "Save retention policy" }));
    await waitFor(() => expect(updateAdminRetentionPolicy).toHaveBeenCalledWith("synthetic", expect.objectContaining({ preview_token: "reviewed", enabled: true })));
});
test("changing a reviewed duration invalidates its preview and Forever can disable immediately", async () => {
    render(<RetentionGovernance actorUserId="synthetic" policy={policy} onSaved={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button", { name: "5 years" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview effect" }));
    await screen.findByText("Effect on 12 saved chats");
    fireEvent.click(screen.getByRole("button", { name: "1 year" }));
    expect(screen.getByRole("button", { name: "Save retention policy" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Forever", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Save Forever" }));
    await waitFor(() => expect(updateAdminRetentionPolicy).toHaveBeenCalledWith("synthetic", expect.objectContaining({ enabled: false, automation_enabled: false, chat_retention_days: 0 })));
});
