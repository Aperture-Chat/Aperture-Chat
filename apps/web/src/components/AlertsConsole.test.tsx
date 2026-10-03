import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { AlertsConsole, type AlertsConsoleApi } from "./AlertsConsole";
import type { AlertRule, EmailSettings } from "../lib/types";

const savedSettings: EmailSettings = {
  host: "smtp.example.com",
  port: 587,
  security: "starttls",
  username: "mailer@example.com",
  from_address: "alerts@example.com",
  password_set: true,
  masked_password: "••••alue",
  last_test_at: null,
  last_test_status: null,
  updated_at: null,
};

function ownerApi(overrides: Partial<AlertsConsoleApi> = {}): AlertsConsoleApi {
  return {
    listRules: vi.fn(async () => []),
    createRule: vi.fn(async () => undefined),
    updateRule: vi.fn(async () => undefined),
    deleteRule: vi.fn(async () => undefined),
    listNotifications: vi.fn(async () => []),
    getEmailSettings: vi.fn(async () => savedSettings),
    updateEmailSettings: vi.fn(async () => savedSettings),
    sendEmailTest: vi.fn(async () => ({ status: "sent", detail: "Test email sent to soc@example.com." })),
    ...overrides,
  };
}

test("prompt-injection template creates a detection-scoped rule", async () => {
  const api = ownerApi();
  render(<AlertsConsole variant="owner" api={api} actorOptions={[]} />);

  fireEvent.click(await screen.findByRole("button", { name: /Prompt-injection template/ }));
  expect(screen.getByLabelText("Action patterns")).toHaveValue("security.prompt_flagged");
  expect(screen.getByLabelText("Only alert on Prompt injection")).toBeChecked();
  expect(screen.getByLabelText("Only alert on System-prompt extraction")).toBeChecked();
  expect(screen.getByLabelText("Only alert on Credential extraction")).toBeChecked();
  expect(screen.getByLabelText("Only alert on US Social Security number")).not.toBeChecked();

  // Narrow further: drop the credential probe, keep the other two.
  fireEvent.click(screen.getByLabelText("Only alert on Credential extraction"));
  fireEvent.change(screen.getByLabelText("Email recipients"), { target: { value: "soc@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Rule" }));

  await waitFor(() => expect(api.createRule).toHaveBeenCalled());
  expect(api.createRule).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "Prompt injection",
      action_patterns: ["security.prompt_flagged"],
      detector_ids: ["prompt-injection", "system-prompt-probe"],
      min_severity: "warning",
      recipients: ["soc@example.com"],
    }),
  );
});

test("rule rows name the detections they are limited to", async () => {
  const rule: AlertRule = {
    id: "alertrule-1",
    scope: "platform",
    tenant_id: null,
    name: "Prompt injection",
    description: "",
    enabled: true,
    action_patterns: ["security.prompt_flagged"],
    detector_ids: ["prompt-injection", "system-prompt-probe"],
    min_severity: "warning",
    actor_ids: [],
    threshold_count: 1,
    window_minutes: 60,
    cooldown_minutes: 10,
    recipients: ["soc@example.com"],
    created_by: "user-owner",
    created_by_name: "Owner",
    created_at: "2026-10-02T12:00:00+00:00",
    updated_at: "2026-10-02T12:00:00+00:00",
  };
  render(<AlertsConsole variant="owner" api={ownerApi({ listRules: vi.fn(async () => [rule]) })} actorOptions={[]} />);

  expect(
    await screen.findByText(/only Prompt injection, System-prompt extraction · ≥ warning/),
  ).toBeInTheDocument();
});

test("test email is blocked while SMTP edits are unsaved", async () => {
  const api = ownerApi();
  render(<AlertsConsole variant="owner" api={api} actorOptions={[]} />);

  const host = await screen.findByLabelText("SMTP host");
  fireEvent.change(screen.getByLabelText("Test email recipient"), { target: { value: "soc@example.com" } });
  const sendButton = screen.getByRole("button", { name: /Send test email/ });
  expect(sendButton).toBeEnabled();

  fireEvent.change(host, { target: { value: "smtp.other.example.com" } });
  expect(sendButton).toBeDisabled();
  expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument();

  fireEvent.change(host, { target: { value: "smtp.example.com" } });
  expect(sendButton).toBeEnabled();
  fireEvent.click(sendButton);
  await waitFor(() => expect(api.sendEmailTest).toHaveBeenCalledWith("soc@example.com"));
});
