// Signal cards shared by the owner and admin audit dashboards. Each builder
// takes records the console already loaded, so a card never claims more than
// the current snapshot shows.
import type { AgentRun, AuditEvent, Automation, Provider, ProviderKey, SecurityAlert, User } from "../lib/types";
import type { AuditSummaryItem } from "./AuditSummaryCard";
import { eventSeverity, isAfterHours, isGovernanceChange } from "./AuditInsights";

type Format = (value: string) => string;

/** Page sizes the consoles load audit data with. Audit Insights charts trends
 * across days, so events use the API maximum rather than its 200 default. */
export const AUDIT_EVENT_PAGE_SIZE = 1000;
export const AUDIT_ALERT_PAGE_SIZE = 150;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const KEY_EXPIRY_WINDOW_DAYS = 30;
// Placeholder last_active values the API writes before an account first signs in.
const NEVER_SIGNED_IN_MARKERS = new Set(["never", "pending", "provisioned via scim"]);
const CREDENTIAL_ACTIONS = new Set([
  "auth.mfa_enabled",
  "auth.mfa_disabled",
  "auth.mfa_recovery_codes_regenerated",
  "auth.password_updated",
  "auth.api_key_created",
  "auth.api_key_rotated",
  "auth.api_key_revoked",
  "admin.password_reset",
  "admin.user_mfa_reset",
  "admin.user_sessions_revoked",
]);

function describeEvent(event: AuditEvent, format: Format) {
  return `${event.actor_name || event.actor_id} · ${event.target_name || event.target || "No target"} · ${format(event.created_at)}${event.detail ? ` · ${event.detail}` : ""}`;
}

function eventRow(event: AuditEvent, format: Format) {
  return { label: event.action_type || event.action, detail: describeEvent(event, format) };
}

export function formatElapsed(ms: number) {
  if (ms < HOUR_MS) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < 2 * DAY_MS) return `${(ms / HOUR_MS).toFixed(ms < 10 * HOUR_MS ? 1 : 0)}h`;
  return `${Math.round(ms / DAY_MS)}d`;
}

export function warningEventsSignal(events: AuditEvent[], format: Format): AuditSummaryItem {
  const records = events.filter((event) => eventSeverity(event) === "warning");
  return {
    group: "security",
    label: "Warning events",
    value: String(records.length),
    detail: "elevated audit events",
    issue: false,
    description:
      "Warning-severity audit events in the loaded range: deletions, failed syncs, settings changes, deactivations, and API key activity.",
    sections: [
      {
        label: "Warning audit events",
        emptyText: "No warning-severity audit events are present in this snapshot.",
        items: records.map((event) => eventRow(event, format)),
      },
    ],
  };
}

export function alertResponseSignal(alerts: SecurityAlert[], users: User[], format: Format): AuditSummaryItem {
  const now = Date.now();
  const names = new Map(users.map((user) => [user.id, user.display_name || user.email]));
  const acknowledged = alerts
    .filter((alert) => alert.acknowledged && alert.acknowledged_at)
    .map((alert) => ({ alert, elapsed: Date.parse(alert.acknowledged_at!) - Date.parse(alert.created_at) }))
    .filter((row) => Number.isFinite(row.elapsed) && row.elapsed >= 0)
    .sort((a, b) => a.elapsed - b.elapsed);
  const median = acknowledged.length ? acknowledged[Math.floor((acknowledged.length - 1) / 2)].elapsed : null;
  const staleOpen = alerts
    .filter((alert) => !alert.acknowledged)
    .map((alert) => ({ alert, age: now - Date.parse(alert.created_at) }))
    .filter((row) => Number.isFinite(row.age) && row.age > DAY_MS)
    .sort((a, b) => b.age - a.age);
  return {
    group: "security",
    label: "Alert response",
    value: median === null ? "—" : formatElapsed(median),
    detail: median === null ? "no alerts acknowledged yet" : "median time to acknowledge",
    issue: staleOpen.length > 0,
    description:
      "How quickly DLP and misuse alerts are reviewed. Open alerts older than 24 hours are flagged so they do not go stale.",
    sections: [
      {
        label: "Open longer than 24 hours",
        emptyText: "Every open alert was raised within the last 24 hours.",
        items: staleOpen.map(({ alert, age }) => ({
          label: alert.rule_label,
          detail: `${alert.user_name || alert.user_id} · open ${formatElapsed(age)} · raised ${format(alert.created_at)}`,
        })),
      },
      {
        label: "Acknowledged alerts",
        emptyText: "No alerts with an acknowledgement time are loaded.",
        items: acknowledged.map(({ alert, elapsed }) => ({
          label: alert.rule_label,
          detail: `${alert.user_name || alert.user_id} · acknowledged by ${
            (alert.acknowledged_by && names.get(alert.acknowledged_by)) || alert.acknowledged_by || "unknown reviewer"
          } after ${formatElapsed(elapsed)}`,
        })),
      },
    ],
  };
}

export function afterHoursSignal(events: AuditEvent[], format: Format): AuditSummaryItem {
  const records = events.filter((event) => isGovernanceChange(event) && isAfterHours(event.created_at));
  const critical = records.filter((event) => eventSeverity(event) === "critical");
  return {
    group: "security",
    label: "After-hours changes",
    value: String(records.length),
    detail: "changes outside 7 AM–7 PM or on weekends",
    issue: critical.length > 0,
    description:
      "Configuration, access, and security changes made outside 7 AM–7 PM or on weekends, in your local time. Routine chat, sign-in, and knowledge traffic is excluded.",
    sections: [
      {
        label: "Critical after-hours changes",
        emptyText: "No critical changes were made after hours.",
        items: critical.map((event) => eventRow(event, format)),
      },
      {
        label: "Other after-hours changes",
        emptyText: "No other changes were made after hours.",
        items: records.filter((event) => eventSeverity(event) !== "critical").map((event) => eventRow(event, format)),
      },
    ],
  };
}

export function failedOperationsSignal(events: AuditEvent[], format: Format): AuditSummaryItem {
  const records = events.filter((event) => /(^|[._])failed$/.test(event.action));
  return {
    group: "security",
    label: "Failed operations",
    value: String(records.length),
    detail: "failed syncs, validations, and runs",
    issue: records.length > 0,
    description:
      "Audit events recording an operation that failed, such as provider or catalog syncs, runtime validations, email tests, and automation runs.",
    sections: [
      {
        label: "Failed operations",
        emptyText: "No failed operations are present in this snapshot.",
        items: records.map((event) => eventRow(event, format)),
      },
    ],
  };
}

export function roleChangesSignal(events: AuditEvent[], format: Format, formatRole: Format): AuditSummaryItem {
  const records = events.filter((event) => {
    const changed = event.metadata?.changed;
    return event.action === "admin.user_updated" && Array.isArray(changed) && changed.includes("role");
  });
  return {
    group: "identity",
    label: "Role changes",
    value: String(records.length),
    detail: "user role changes in range",
    issue: false,
    description:
      "Every recorded change to a user's role. Promotions widen access, so each change should match an approved request.",
    sections: [
      {
        label: "Role changes",
        emptyText: "No user roles were changed in this snapshot.",
        items: records.map((event) => {
          const role = typeof event.metadata?.role === "string" ? formatRole(event.metadata.role) : "";
          return {
            label: event.target_name || event.target || "Unknown user",
            detail: `${role ? `now ${role} · ` : ""}changed by ${event.actor_name || event.actor_id} · ${format(event.created_at)}`,
          };
        }),
      },
    ],
  };
}

export function credentialChangesSignal(events: AuditEvent[], format: Format): AuditSummaryItem {
  const records = events.filter((event) => CREDENTIAL_ACTIONS.has(event.action));
  const mfaRemoved = records.filter((event) => event.action === "auth.mfa_disabled" || event.action === "admin.user_mfa_reset");
  return {
    group: "identity",
    label: "Credential changes",
    value: String(records.length),
    detail: "MFA, password, session, and API key events",
    issue: mfaRemoved.length > 0,
    description:
      "Sign-in credential activity: MFA enrolment and removal, password changes and resets, revoked sessions, and personal API keys. Removing MFA is flagged.",
    sections: [
      {
        label: "MFA removed or reset",
        emptyText: "No account removed or reset multi-factor authentication.",
        items: mfaRemoved.map((event) => eventRow(event, format)),
      },
      {
        label: "Other credential events",
        emptyText: "No other credential events are present in this snapshot.",
        items: records.filter((event) => !mfaRemoved.includes(event)).map((event) => eventRow(event, format)),
      },
    ],
  };
}

export function accessRequestsSignal(users: User[], format: Format): AuditSummaryItem {
  const records = users.filter((user) => user.access_request_status === "pending" && !user.active);
  return {
    group: "identity",
    label: "Access requests",
    value: String(records.length),
    detail: "sign-up requests awaiting review",
    issue: records.length > 0,
    description: "People who requested access from the sign-in screen and are waiting for an administrator decision.",
    sections: [
      {
        label: "Pending access requests",
        emptyText: "No access requests are waiting for review.",
        items: records.map((user) => ({
          label: user.display_name || user.email,
          detail: `${user.email}${user.access_requested_at ? ` · requested ${format(user.access_requested_at)}` : ""}`,
        })),
      },
    ],
  };
}

export function passwordAdminsSignal(users: User[], requireSsoForAdmins: boolean): AuditSummaryItem {
  const active = users.filter((user) => user.active && user.auth_method === "local");
  const admins = active.filter((user) => user.role === "TENANT_ADMIN");
  const owners = active.filter((user) => user.role === "PLATFORM_OWNER");
  return {
    group: "identity",
    label: "Password-only admins",
    value: String(admins.length),
    detail: "tenant admins not using SSO",
    issue: requireSsoForAdmins && admins.length > 0,
    description: `Active administrators who sign in with a local password instead of single sign-on. The require-SSO-for-admins policy is currently ${
      requireSsoForAdmins ? "on, so these accounts are out of policy" : "off"
    }.`,
    sections: [
      {
        label: "Tenant admins on password sign-in",
        emptyText: "Every active tenant admin signs in through SSO or SCIM.",
        items: admins.map((user) => ({ label: user.display_name || user.email, detail: `${user.email} · last active ${user.last_active}` })),
      },
      ...(owners.length
        ? [
            {
              label: "Platform owners on password sign-in",
              emptyText: "",
              items: owners.map((user) => ({ label: user.display_name || user.email, detail: `${user.email} · last active ${user.last_active}` })),
            },
          ]
        : []),
    ],
  };
}

export function neverSignedInSignal(users: User[], formatRole: Format): AuditSummaryItem {
  const records = users.filter(
    (user) => user.active && NEVER_SIGNED_IN_MARKERS.has((user.last_active || "never").trim().toLowerCase()),
  );
  return {
    group: "identity",
    label: "Never signed in",
    value: String(records.length),
    detail: "active accounts with no sign-in",
    issue: false,
    description:
      "Active accounts that have not signed in yet. Unused accounts widen the attack surface; deactivate any that are no longer needed.",
    sections: [
      {
        label: "Active accounts without a sign-in",
        emptyText: "Every active account has signed in at least once.",
        items: records.map((user) => ({
          label: user.display_name || user.email,
          detail: `${user.email} · ${formatRole(user.role)} · ${user.auth_method || "sign-in method not recorded"} · ${user.last_active}`,
        })),
      },
    ],
  };
}

export function expiringKeysSignal(keys: ProviderKey[]): AuditSummaryItem {
  const now = Date.now();
  const records = keys
    .map((key) => {
      const normalized = key.expires.trim().toLowerCase();
      if (!normalized || normalized === "not set" || normalized === "never") return null;
      const parsed = Date.parse(key.expires);
      if (Number.isNaN(parsed)) return null;
      const expiresAt = new Date(parsed);
      expiresAt.setHours(23, 59, 59, 999);
      const remaining = expiresAt.getTime() - now;
      return remaining >= 0 && remaining <= KEY_EXPIRY_WINDOW_DAYS * DAY_MS ? { key, remaining } : null;
    })
    .filter((row): row is { key: ProviderKey; remaining: number } => row !== null)
    .sort((a, b) => a.remaining - b.remaining);
  return {
    group: "providers",
    label: "Keys expiring soon",
    value: String(records.length),
    detail: `provider keys expiring within ${KEY_EXPIRY_WINDOW_DAYS} days`,
    issue: records.length > 0,
    description:
      "Provider key metadata whose expiry date falls within the next 30 days, so secrets can be rotated before requests fail. Secret values are never included.",
    sections: [
      {
        label: "Keys nearing expiry",
        emptyText: `No tracked provider keys expire in the next ${KEY_EXPIRY_WINDOW_DAYS} days.`,
        items: records.map(({ key, remaining }) => ({
          label: key.name,
          detail: `${key.provider_name} · ${key.environment} · expires ${key.expires} (${formatElapsed(remaining)} left) · ${key.masked_value}`,
        })),
      },
    ],
  };
}

export function failedValidationsSignal(providers: Provider[], format: Format): AuditSummaryItem {
  const records = providers.filter(
    (provider) => provider.last_validation_status === "failed" || provider.last_validation_status === "auth_failed",
  );
  return {
    group: "providers",
    label: "Failed validations",
    value: String(records.length),
    detail: "providers failing their live test",
    issue: records.length > 0,
    description: "Providers whose most recent live runtime test failed, including authentication failures from rejected keys.",
    sections: [
      {
        label: "Providers failing validation",
        emptyText: "No provider's latest runtime test failed.",
        items: records.map((provider) => ({
          label: provider.name,
          detail: `${provider.kind} · ${provider.last_validation_status === "auth_failed" ? "authentication failed" : "runtime test failed"}${
            provider.last_validated_at ? ` · tested ${format(provider.last_validated_at)}` : ""
          }${provider.last_validation_model_id ? ` · ${provider.last_validation_model_id}` : ""}`,
        })),
      },
    ],
  };
}

export function pendingApprovalsSignal(agentRuns: AgentRun[], format: Format, group = "operations"): AuditSummaryItem {
  const records = agentRuns.flatMap((run) =>
    run.approvals.filter((approval) => approval.status === "Pending").map((approval) => ({ run, approval })),
  );
  return {
    group,
    label: "Approvals",
    value: String(records.length),
    detail: "agent actions awaiting review",
    issue: records.length > 0,
    description: "Pending approval gates raised by agent runs before a protected action can continue.",
    sections: [
      {
        label: "Pending approvals",
        emptyText: "No agent actions are currently waiting for approval.",
        items: records.map(({ run, approval }) => ({
          label: approval.title,
          detail: `${run.name} · requested by ${approval.requested_by} · ${format(approval.requested_at)}`,
        })),
      },
    ],
  };
}

export function automationFailuresSignal(automations: Automation[], format: Format, group = "operations"): AuditSummaryItem {
  const records = automations.filter((automation) => (automation.last_run_status || "").toLowerCase() === "failed");
  return {
    group,
    label: "Automation failures",
    value: String(records.length),
    detail: "automations whose last run failed",
    issue: records.length > 0,
    description: "Automations whose most recent run failed, with the failure detail recorded for that run when available.",
    sections: [
      {
        label: "Failing automations",
        emptyText: "No automation's latest run failed.",
        items: records.map((automation) => {
          const lastRun = automation.run_history?.find((run) => run.at === automation.last_run_at);
          return {
            label: automation.name,
            detail: [
              automation.enabled ? "enabled" : "paused",
              automation.last_run_at ? `failed ${format(automation.last_run_at)}` : "",
              automation.consecutive_failures ? `${automation.consecutive_failures} consecutive failure${automation.consecutive_failures === 1 ? "" : "s"}` : "",
              lastRun?.detail ?? "",
            ]
              .filter(Boolean)
              .join(" · "),
          };
        }),
      },
    ],
  };
}
