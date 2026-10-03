import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { AuditInsights } from "./AuditInsights";
import { AuditSummaryBoard, type AuditSummaryItem } from "./AuditSummaryCard";
import {
  afterHoursSignal,
  alertResponseSignal,
  expiringKeysSignal,
  failedOperationsSignal,
  neverSignedInSignal,
  roleChangesSignal,
} from "./auditSignals";
import type { AuditEvent, ProviderKey, SecurityAlert, User } from "../lib/types";

const format = (value: string) => value;
const roleLabel = (role: string) => (role === "TENANT_ADMIN" ? "Tenant Admin" : role);

function localIso(daysAgo: number, hour: number) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, 15, 0, 0);
  return date.toISOString();
}

function auditEvent(overrides: Partial<AuditEvent>): AuditEvent {
  return {
    id: overrides.id ?? "event",
    actor_id: "user-alex",
    actor_name: "Alex Morgan",
    actor_role: "TENANT_ADMIN",
    action: "admin.group_updated",
    action_type: "GROUP_UPDATED",
    target: "group-1",
    target_type: "group",
    target_name: "Litigation",
    detail: "",
    created_at: localIso(0, 10),
    redacted: false,
    metadata: {},
    severity: "info",
    ...overrides,
  };
}

function securityAlert(overrides: Partial<SecurityAlert>): SecurityAlert {
  return {
    id: overrides.id ?? "alert",
    user_id: "user-jane",
    user_name: "Jane Smith",
    rule_id: "ssn",
    rule_label: "Social Security number",
    category: "dlp",
    severity: "high",
    snippet: "[redacted]",
    model_id: "gpt-4o",
    surface: "chat",
    created_at: localIso(0, 11),
    acknowledged: false,
    ...overrides,
  };
}

const events = [
  auditEvent({
    id: "role",
    action: "admin.user_updated",
    action_type: "USER_UPDATED",
    target_name: "Jane Smith",
    severity: "critical",
    metadata: { changed: ["role"], role: "TENANT_ADMIN" },
  }),
  auditEvent({
    id: "sync",
    action: "platform.provider_models_sync_failed",
    action_type: "PROVIDER_SYNC_FAILED",
    created_at: localIso(0, 22),
    severity: "warning",
  }),
  auditEvent({
    id: "chat",
    actor_id: "user-jane",
    actor_name: "Jane Smith",
    actor_role: "USER",
    action: "chat.completion",
    action_type: "CHAT_COMPLETION",
    created_at: localIso(3, 9),
  }),
  auditEvent({ id: "old", created_at: localIso(20, 9) }),
];

const alerts = [
  securityAlert({ id: "ssn" }),
  securityAlert({
    id: "jailbreak",
    user_id: "user-sam",
    user_name: "Sam Lee",
    rule_id: "jailbreak",
    rule_label: "Jailbreak attempt",
    category: "behavior",
    severity: "medium",
    created_at: localIso(2, 9),
    acknowledged: true,
    acknowledged_at: localIso(2, 11),
  }),
];

test("audit insights chart the selected range and open the records behind a mark", () => {
  render(<AuditInsights events={events} alerts={alerts} formatTimestamp={format} />);

  expect(screen.getByText("3 audit events · 2 security alerts")).toBeInTheDocument();
  for (const chart of ["Audit events by day", "Security alerts by day", "Alert breakdown", "Most active people", "Activity by area", "Activity by hour"]) {
    expect(screen.getByRole("region", { name: chart })).toBeInTheDocument();
  }

  const byDay = screen.getByRole("region", { name: "Audit events by day" });
  fireEvent.click(within(byDay).getByRole("button", { name: /^2 events · .*1 critical, 1 warning, 0 info/ }));
  const dayDialog = screen.getByRole("dialog");
  expect(within(dayDialog).getByText("Review the records behind this chart.")).toBeInTheDocument();
  expect(within(dayDialog).getByText("USER_UPDATED")).toBeInTheDocument();
  expect(within(dayDialog).getByText("PROVIDER_SYNC_FAILED")).toBeInTheDocument();
  expect(within(dayDialog).queryByText("CHAT_COMPLETION")).not.toBeInTheDocument();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  const breakdown = screen.getByRole("region", { name: "Alert breakdown" });
  fireEvent.click(within(breakdown).getByRole("radio", { name: "By person" }));
  fireEvent.click(within(breakdown).getByRole("button", { name: /^Sam Lee: 1 \(0 open · 1 acknowledged\)/ }));
  const personDialog = screen.getByRole("dialog", { name: "Sam Lee" });
  const acknowledgedSection = within(personDialog).getByText("Acknowledged alerts").closest("section")!;
  expect(within(acknowledgedSection).getByText("Jailbreak attempt")).toBeInTheDocument();
  fireEvent.click(within(personDialog).getByRole("button", { name: "Close Sam Lee investigation" }));

  fireEvent.click(screen.getByRole("radio", { name: "30 days" }));
  expect(screen.getByText("4 audit events · 2 security alerts")).toBeInTheDocument();
});

test("audit insights warn when the loaded page cannot cover the whole range", () => {
  render(<AuditInsights events={events} alerts={alerts} formatTimestamp={format} eventLimit={4} />);

  expect(screen.queryByText(/Earlier days may be incomplete/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "30 days" }));
  expect(screen.getByText(/Earlier days may be incomplete: the newest 4 audit events reach back only to/)).toBeInTheDocument();
});

test("audit signals derive response time, after-hours changes, and failures from loaded records", () => {
  const staleOpen = securityAlert({ id: "stale", created_at: localIso(3, 9) });
  const response = alertResponseSignal([...alerts, staleOpen], [], format);
  expect(response.value).toBe("2.0h");
  expect(response.detail).toBe("median time to acknowledge");
  expect(response.issue).toBe(true);
  expect(response.sections[0].items.map((item) => item.label)).toEqual(["Social Security number"]);

  // Wednesday Sep 30 2026, built from local parts so the hour is local time.
  const weekday = (hour: number) => new Date(2026, 8, 30, hour, 0).toISOString();
  const afterHours = afterHoursSignal(
    [
      auditEvent({ id: "late", action: "platform.settings_updated", created_at: weekday(22) }),
      auditEvent({ id: "day", action: "platform.settings_updated", created_at: weekday(10) }),
      auditEvent({ id: "late-chat", action: "chat.completion", created_at: weekday(23) }),
    ],
    format,
  );
  expect(afterHours.value).toBe("1");
  expect(afterHours.issue).toBe(false);

  const failures = failedOperationsSignal(events, format);
  expect(failures.value).toBe("1");
  expect(failures.sections[0].items[0].label).toBe("PROVIDER_SYNC_FAILED");

  const roles = roleChangesSignal(events, format, roleLabel);
  expect(roles.sections[0].items[0]).toMatchObject({ label: "Jane Smith", detail: expect.stringContaining("now Tenant Admin") });
});

test("audit signals flag expiring keys and accounts that never signed in", () => {
  const inDays = (days: number) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const key = (name: string, expires: string): ProviderKey => ({
    id: name,
    provider_id: "openai",
    provider_name: "OpenAI",
    name,
    environment: "Production",
    status: "Active",
    last_rotated: "2026-09-01",
    expires,
    masked_value: "sk-...abcd",
  });
  const expiring = expiringKeysSignal([key("Soon", inDays(10)), key("Later", inDays(90)), key("Expired", inDays(-3)), key("Open", "Not set")]);
  expect(expiring.value).toBe("1");
  expect(expiring.issue).toBe(true);
  expect(expiring.sections[0].items[0].label).toBe("Soon");

  const user = (id: string, lastActive: string, active = true): User => ({
    id,
    email: `${id}@example.test`,
    display_name: id,
    role: "USER",
    group_ids: [],
    active,
    last_active: lastActive,
  });
  const never = neverSignedInSignal([user("fresh", "Never"), user("scim", "Provisioned via SCIM"), user("seen", "Now"), user("gone", "Never", false)], roleLabel);
  expect(never.sections[0].items.map((item) => item.label)).toEqual(["fresh", "scim"]);
});

test("signal board opens groups that need attention, folds clear ones, and remembers the layout", () => {
  window.localStorage.removeItem("aperture-audit-board-layout");
  const signal = (label: string, group: string, issue: boolean): AuditSummaryItem => ({
    label,
    group,
    issue,
    value: issue ? "3" : "0",
    detail: `${label.toLowerCase()} detail`,
    description: `${label} description`,
    sections: [{ label: `${label} records`, emptyText: "None.", items: [] }],
  });
  const groups = [
    { id: "security", label: "Security signals" },
    { id: "identity", label: "Identity & access" },
  ];
  const items = [
    signal("Critical events", "security", true),
    signal("Warning events", "security", false),
    signal("Role changes", "identity", false),
  ];
  const { unmount } = render(<AuditSummaryBoard items={items} groups={groups} />);

  expect(screen.getByText("1 of 3 signals need attention")).toBeInTheDocument();
  const security = screen.getByRole("region", { name: "Security signals" });
  const identity = screen.getByRole("region", { name: "Identity & access" });
  expect(within(security).getByRole("button", { name: /Security signals/ })).toHaveAttribute("aria-expanded", "true");
  expect(within(security).getByRole("button", { name: /^Critical events: 3/ })).toHaveClass("audit-signal-row", "is-issue");
  const identityToggle = within(identity).getByRole("button", { name: /Identity & access/ });
  expect(identityToggle).toHaveAttribute("aria-expanded", "false");
  expect(within(identity).getByText("Clear")).toBeInTheDocument();
  expect(within(identity).queryByRole("button", { name: /^Role changes/ })).not.toBeInTheDocument();

  fireEvent.click(identityToggle);
  expect(within(identity).getByRole("button", { name: /^Role changes: 0/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
  expect(document.querySelectorAll(".audit-signal-row")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
  expect(document.querySelectorAll(".audit-signal-row")).toHaveLength(3);

  fireEvent.click(screen.getByRole("radio", { name: "Cards" }));
  expect(document.querySelectorAll(".audit-summary-card")).toHaveLength(3);
  expect(window.localStorage.getItem("aperture-audit-board-layout")).toBe("cards");
  unmount();
  render(<AuditSummaryBoard items={items} groups={groups} />);
  expect(screen.getByRole("radio", { name: "Cards" })).toHaveAttribute("aria-checked", "true");
  window.localStorage.removeItem("aperture-audit-board-layout");
});
