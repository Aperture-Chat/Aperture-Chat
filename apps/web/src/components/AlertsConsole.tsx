import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  BellRing,
  Download,
  ListChecks,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { Panel, Pill } from "./Primitives";
import { SelectControl } from "./SelectControl";
import type {
  AlertEmailStatus,
  AlertNotification,
  AlertRule,
  AlertRuleCreateRequest,
  AlertRuleUpdateRequest,
  EmailSettings,
  EmailSettingsUpdateRequest,
  EmailTestResult,
} from "../lib/types";

/**
 * Shared Alerts tab for the Admin and Owner consoles (same pattern as the
 * shared PromptActivityList). The admin variant manages tenant-scope rules and
 * sees a read-only email-delivery status; the owner variant manages
 * platform-scope rules, sees every rule labeled by scope, and owns the SMTP
 * configuration. All states are honest: delivery rows show real sent/failed/
 * not-configured statuses and the real SMTP error text.
 */

export type AlertsConsoleApi = {
  listRules: () => Promise<AlertRule[] | void> | AlertRule[] | void;
  createRule: (payload: AlertRuleCreateRequest) => Promise<AlertRule | void> | AlertRule | void;
  updateRule: (
    ruleId: string,
    patch: AlertRuleUpdateRequest,
  ) => Promise<AlertRule | void> | AlertRule | void;
  deleteRule: (ruleId: string) => Promise<void> | void;
  listNotifications: () => Promise<AlertNotification[] | void> | AlertNotification[] | void;
  setNotificationArchived?: (
    notificationId: string,
    archived: boolean,
  ) => Promise<AlertNotification | void> | AlertNotification | void;
  getEmailStatus?: () => Promise<AlertEmailStatus | void> | AlertEmailStatus | void;
  getEmailSettings?: () => Promise<EmailSettings | void> | EmailSettings | void;
  updateEmailSettings?: (
    patch: EmailSettingsUpdateRequest,
  ) => Promise<EmailSettings | void> | EmailSettings | void;
  sendEmailTest?: (recipient: string) => Promise<EmailTestResult | void> | EmailTestResult | void;
};

export type AlertActorOption = { id: string; label: string };

const SEVERITY_OPTIONS = [
  { value: "info", label: "Info and above (all events)" },
  { value: "warning", label: "Warning and above" },
  { value: "critical", label: "Critical only" },
] as const;

const ACTION_PATTERN_HINT =
  "Exact actions or prefixes: security.*, admin.*, auth.*, chat.*, platform.*, agent.*, automation.*, knowledge.*, tool.*, scim.*, hermes.*";

const SUSPICIOUS_TEMPLATE = {
  name: "Suspicious activity",
  description: "Security flags, content-filter hits, and elevated-severity governance events.",
  actionPatterns: "security.*",
  minSeverity: "warning",
  thresholdCount: "1",
  windowMinutes: "60",
  cooldownMinutes: "15",
} as const;

type RuleDraft = {
  name: string;
  description: string;
  actionPatterns: string;
  minSeverity: string;
  actorId: string;
  thresholdCount: string;
  windowMinutes: string;
  cooldownMinutes: string;
  recipients: string;
  enabled: boolean;
};

const EMPTY_DRAFT: RuleDraft = {
  name: "",
  description: "",
  actionPatterns: "",
  minSeverity: "warning",
  actorId: "any",
  thresholdCount: "1",
  windowMinutes: "60",
  cooldownMinutes: "60",
  recipients: "",
  enabled: true,
};

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function draftFromRule(rule: AlertRule): RuleDraft {
  return {
    name: rule.name,
    description: rule.description,
    actionPatterns: rule.action_patterns.join(", "),
    minSeverity: rule.min_severity,
    actorId: rule.actor_ids[0] ?? "any",
    thresholdCount: String(rule.threshold_count),
    windowMinutes: String(rule.window_minutes),
    cooldownMinutes: String(rule.cooldown_minutes),
    recipients: rule.recipients.join(", "),
    enabled: rule.enabled,
  };
}

function payloadFromDraft(draft: RuleDraft): AlertRuleCreateRequest {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    enabled: draft.enabled,
    action_patterns: splitList(draft.actionPatterns),
    min_severity: draft.minSeverity,
    actor_ids: draft.actorId === "any" ? [] : [draft.actorId],
    threshold_count: Math.max(1, Number.parseInt(draft.thresholdCount, 10) || 1),
    window_minutes: Math.max(1, Number.parseInt(draft.windowMinutes, 10) || 60),
    cooldown_minutes: Math.max(0, Number.parseInt(draft.cooldownMinutes, 10) || 0),
    recipients: splitList(draft.recipients),
  };
}

function ruleCriteriaSummary(rule: AlertRule): string {
  const patterns = rule.action_patterns.length ? rule.action_patterns.join(", ") : "any action";
  const severity = `≥ ${rule.min_severity}`;
  const actors = rule.actor_ids.length
    ? `${rule.actor_ids.length} watched user${rule.actor_ids.length === 1 ? "" : "s"}`
    : "any actor";
  const threshold =
    rule.threshold_count > 1 ? `≥ ${rule.threshold_count} in ${rule.window_minutes}m` : "every match";
  return `${patterns} · ${severity} · ${actors} · ${threshold}`;
}

function notificationPillTone(
  status: string,
): "success" | "info" | "danger" | "warning" | "neutral" {
  if (status === "sent") return "success";
  if (status === "queued") return "info";
  if (status === "failed") return "danger";
  if (status === "not_configured") return "warning";
  return "neutral";
}

function notificationStatusLabel(status: string): string {
  if (status === "not_configured") return "email not configured";
  if (status === "logged") return "logged in-app";
  return status;
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const NOTIFICATION_CSV_COLUMNS: Array<{ header: string; value: (item: AlertNotification) => string | number }> = [
  { header: "id", value: (item) => item.id },
  { header: "created_at", value: (item) => item.created_at },
  { header: "rule_id", value: (item) => item.rule_id },
  { header: "rule_name", value: (item) => item.rule_name },
  { header: "scope", value: (item) => item.scope },
  { header: "event_action", value: (item) => item.event_action },
  { header: "event_severity", value: (item) => item.event_severity },
  { header: "actor_name", value: (item) => item.actor_name },
  { header: "summary", value: (item) => item.summary },
  { header: "matched_count", value: (item) => item.matched_count },
  { header: "recipients", value: (item) => item.recipients.join("; ") },
  { header: "status", value: (item) => item.status },
  { header: "status_detail", value: (item) => item.status_detail },
  { header: "attempts", value: (item) => item.attempts },
  { header: "delivered_at", value: (item) => item.delivered_at ?? "" },
];

function notificationsToCsv(items: AlertNotification[]): string {
  const escape = (value: string | number) => {
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const header = NOTIFICATION_CSV_COLUMNS.map((column) => escape(column.header)).join(",");
  const rows = items.map((item) =>
    NOTIFICATION_CSV_COLUMNS.map((column) => escape(column.value(item))).join(","),
  );
  return [header, ...rows].join("\n");
}

function downloadNotificationsCsv(items: AlertNotification[], variant: "admin" | "owner") {
  const blob = new Blob([notificationsToCsv(items)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `aperture-${variant}-alert-deliveries.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

type SettingsDraft = {
  host: string;
  port: string;
  security: string;
  username: string;
  password: string;
  fromAddress: string;
};

export function AlertsConsole({
  variant,
  api,
  actorOptions,
}: {
  variant: "admin" | "owner";
  api?: AlertsConsoleApi;
  actorOptions: AlertActorOption[];
}) {
  const [refreshToken, setRefreshToken] = useState(0);
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<AlertNotification[] | null>(null);
  const [notificationsError, setNotificationsError] = useState<string | null>(null);
  const [emailStatus, setEmailStatus] = useState<AlertEmailStatus | null>(null);
  const [emailSettings, setEmailSettings] = useState<EmailSettings | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft | null>(null);
  const [settingsNotice, setSettingsNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [testRecipient, setTestRecipient] = useState("");
  const [testResult, setTestResult] = useState<EmailTestResult | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  const setNotificationArchived = api?.setNotificationArchived;
  const archiveNotification = useCallback(
    async (notification: AlertNotification, archived: boolean) => {
      if (!setNotificationArchived) return;
      const actionKey = `notification:${notification.id}:archive`;
      setPendingAction(actionKey);
      try {
        const updated = await Promise.resolve(setNotificationArchived(notification.id, archived));
        setNotifications((current) =>
          (current ?? []).map((item) =>
            item.id === notification.id ? (updated ?? { ...item, archived }) : item,
          ),
        );
        setNotificationsError(null);
      } catch (error: unknown) {
        setNotificationsError(errorText(error));
      } finally {
        setPendingAction(null);
      }
    },
    [setNotificationArchived],
  );

  useEffect(() => {
    const listRules = api?.listRules;
    if (!listRules) return;
    let active = true;
    Promise.resolve(listRules())
      .then((loaded) => {
        if (!active || !loaded) return;
        setRules(loaded);
        setRulesError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setRulesError(errorText(error));
      });
    return () => {
      active = false;
    };
  }, [api?.listRules, refreshToken]);

  useEffect(() => {
    const listNotifications = api?.listNotifications;
    if (!listNotifications) return;
    let active = true;
    Promise.resolve(listNotifications())
      .then((loaded) => {
        if (!active || !loaded) return;
        setNotifications(loaded);
        setNotificationsError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setNotificationsError(errorText(error));
      });
    return () => {
      active = false;
    };
  }, [api?.listNotifications, refreshToken]);

  useEffect(() => {
    const getEmailStatus = api?.getEmailStatus;
    const getEmailSettings = api?.getEmailSettings;
    let active = true;
    if (variant === "owner" && getEmailSettings) {
      Promise.resolve(getEmailSettings())
        .then((settings) => {
          if (!active || !settings) return;
          setEmailSettings(settings);
          setEmailError(null);
          setSettingsDraft((current) =>
            current ?? {
              host: settings.host,
              port: String(settings.port),
              security: settings.security,
              username: settings.username,
              password: "",
              fromAddress: settings.from_address,
            },
          );
        })
        .catch((error: unknown) => {
          if (!active) return;
          setEmailError(errorText(error));
        });
    } else if (variant === "admin" && getEmailStatus) {
      Promise.resolve(getEmailStatus())
        .then((status) => {
          if (!active || !status) return;
          setEmailStatus(status);
          setEmailError(null);
        })
        .catch((error: unknown) => {
          if (!active) return;
          setEmailError(errorText(error));
        });
    }
    return () => {
      active = false;
    };
  }, [api?.getEmailStatus, api?.getEmailSettings, refreshToken, variant]);

  const actorLabelById = useMemo(
    () => new Map(actorOptions.map((option) => [option.id, option.label])),
    [actorOptions],
  );

  const openCreateForm = (template?: typeof SUSPICIOUS_TEMPLATE) => {
    setEditingRuleId(null);
    setDraft(
      template
        ? {
            ...EMPTY_DRAFT,
            name: template.name,
            description: template.description,
            actionPatterns: template.actionPatterns,
            minSeverity: template.minSeverity,
            thresholdCount: template.thresholdCount,
            windowMinutes: template.windowMinutes,
            cooldownMinutes: template.cooldownMinutes,
          }
        : EMPTY_DRAFT,
    );
    setFormError(null);
    setFormOpen(true);
  };

  const openEditForm = (rule: AlertRule) => {
    setEditingRuleId(rule.id);
    setDraft(draftFromRule(rule));
    setFormError(null);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingRuleId(null);
    setDraft(EMPTY_DRAFT);
    setFormError(null);
  };

  const submitRule = async () => {
    if (!api) return;
    if (!draft.name.trim()) {
      setFormError("A rule name is required.");
      return;
    }
    const payload = payloadFromDraft(draft);
    setPendingAction("rule:save");
    try {
      if (editingRuleId) {
        await api.updateRule(editingRuleId, payload);
      } else {
        await api.createRule(payload);
      }
      closeForm();
      refresh();
    } catch (error: unknown) {
      setFormError(errorText(error));
    } finally {
      setPendingAction(null);
    }
  };

  const toggleRule = async (rule: AlertRule) => {
    if (!api) return;
    setPendingAction(`rule:${rule.id}:toggle`);
    try {
      await api.updateRule(rule.id, { enabled: !rule.enabled });
      refresh();
    } catch (error: unknown) {
      setRulesError(errorText(error));
    } finally {
      setPendingAction(null);
    }
  };

  const removeRule = async (rule: AlertRule) => {
    if (!api) return;
    setPendingAction(`rule:${rule.id}:delete`);
    try {
      await api.deleteRule(rule.id);
      refresh();
    } catch (error: unknown) {
      setRulesError(errorText(error));
    } finally {
      setPendingAction(null);
    }
  };

  const saveEmailSettings = async () => {
    if (!api?.updateEmailSettings || !settingsDraft) return;
    setPendingAction("email:save");
    setSettingsNotice(null);
    try {
      const patch: EmailSettingsUpdateRequest = {
        host: settingsDraft.host.trim(),
        port: Math.min(65535, Math.max(1, Number.parseInt(settingsDraft.port, 10) || 587)),
        security: settingsDraft.security,
        username: settingsDraft.username.trim(),
        from_address: settingsDraft.fromAddress.trim(),
      };
      if (settingsDraft.password) patch.password = settingsDraft.password;
      const saved = await api.updateEmailSettings(patch);
      if (saved) {
        setEmailSettings(saved);
        setSettingsDraft((current) => (current ? { ...current, password: "" } : current));
      }
      setSettingsNotice({ tone: "success", text: "SMTP settings saved." });
    } catch (error: unknown) {
      setSettingsNotice({ tone: "danger", text: errorText(error) });
    } finally {
      setPendingAction(null);
    }
  };

  const sendTestEmail = async () => {
    if (!api?.sendEmailTest || !testRecipient.trim()) return;
    setPendingAction("email:test");
    setTestResult(null);
    try {
      const result = await api.sendEmailTest(testRecipient.trim());
      if (result) setTestResult(result);
      refresh();
    } catch (error: unknown) {
      setTestResult({ status: "failed", detail: errorText(error) });
    } finally {
      setPendingAction(null);
    }
  };

  const ruleRows = rules ?? [];
  const notificationRows = notifications ?? [];
  const archivedNotificationCount = notificationRows.filter((item) => item.archived).length;
  const visibleNotificationRows = showArchived
    ? notificationRows
    : notificationRows.filter((item) => !item.archived);
  const connected = Boolean(api?.listRules);

  return (
    <div className="audit-console-grid">
      <Panel
        title={
          <>
            <Mail size={18} /> Email Delivery
          </>
        }
        subtitle={
          variant === "owner"
            ? "SMTP settings for alert emails. The password is stored in the encrypted vault and never shown again."
            : "Where alert emails stand for this workspace. Alerts are always logged in-app regardless of email."
        }
      >
        {emailError ? (
          <div className="audit-empty-state">
            <ShieldAlert size={20} />
            <span>
              <strong>Email delivery state could not be loaded</strong>
              <small>{emailError}</small>
            </span>
          </div>
        ) : variant === "admin" ? (
          !api?.getEmailStatus ? (
            <div className="audit-empty-state">
              <Mail size={20} />
              <span>
                <strong>Email status endpoint is not connected</strong>
                <small>Delivery status loads from the admin API when it is available.</small>
              </span>
            </div>
          ) : emailStatus === null ? (
            <div className="audit-empty-state">
              <Mail size={20} />
              <span>
                <strong>Checking email delivery status</strong>
                <small>Reading the platform email configuration state.</small>
              </span>
            </div>
          ) : (
            <div className="alert-email-status">
              <Pill tone={emailStatus.configured ? "success" : "warning"}>
                {emailStatus.configured ? "Email configured" : "Email not configured"}
              </Pill>
              <p>{emailStatus.message}</p>
              {emailStatus.configured && emailStatus.from_address ? (
                <small>Alert emails are sent from {emailStatus.from_address}.</small>
              ) : null}
            </div>
          )
        ) : !api?.getEmailSettings ? (
          <div className="audit-empty-state">
            <Mail size={20} />
            <span>
              <strong>Email settings endpoint is not connected</strong>
              <small>SMTP configuration loads from the platform API when it is available.</small>
            </span>
          </div>
        ) : settingsDraft === null ? (
          <div className="audit-empty-state">
            <Mail size={20} />
            <span>
              <strong>Email settings are loading</strong>
              <small>Reading the stored SMTP configuration.</small>
            </span>
          </div>
        ) : (
          <>
            <div className="connector-config-grid">
              <label>
                <span className="connector-field-label">SMTP host</span>
                <input
                  value={settingsDraft.host}
                  aria-label="SMTP host"
                  placeholder="smtp.example.com"
                  onChange={(event) =>
                    setSettingsDraft((current) => (current ? { ...current, host: event.target.value } : current))
                  }
                />
              </label>
              <label>
                <span className="connector-field-label">Port</span>
                <input
                  value={settingsDraft.port}
                  aria-label="SMTP port"
                  inputMode="numeric"
                  onChange={(event) =>
                    setSettingsDraft((current) => (current ? { ...current, port: event.target.value } : current))
                  }
                />
              </label>
              <label>
                <span className="connector-field-label">Security</span>
                <SelectControl
                  value={settingsDraft.security}
                  aria-label="SMTP security mode"
                  onChange={(event) =>
                    setSettingsDraft((current) => (current ? { ...current, security: event.target.value } : current))
                  }
                >
                  <option value="starttls">STARTTLS</option>
                  <option value="ssl">SSL/TLS</option>
                  <option value="none">None (unencrypted)</option>
                </SelectControl>
              </label>
              <label>
                <span className="connector-field-label">Username</span>
                <input
                  value={settingsDraft.username}
                  aria-label="SMTP username"
                  autoComplete="off"
                  onChange={(event) =>
                    setSettingsDraft((current) => (current ? { ...current, username: event.target.value } : current))
                  }
                />
              </label>
              <label>
                <span className="connector-field-label">Password</span>
                <input
                  type="password"
                  value={settingsDraft.password}
                  aria-label="SMTP password"
                  autoComplete="new-password"
                  placeholder={
                    emailSettings?.password_set
                      ? `Stored (${emailSettings.masked_password || "vaulted"}) — enter to replace`
                      : "Vaulted server-side, never shown again"
                  }
                  onChange={(event) =>
                    setSettingsDraft((current) => (current ? { ...current, password: event.target.value } : current))
                  }
                />
              </label>
              <label>
                <span className="connector-field-label">From address</span>
                <input
                  value={settingsDraft.fromAddress}
                  aria-label="Alert from address"
                  placeholder="alerts@your-domain.com"
                  onChange={(event) =>
                    setSettingsDraft((current) =>
                      current ? { ...current, fromAddress: event.target.value } : current,
                    )
                  }
                />
              </label>
            </div>
            <div className="alert-email-actions">
              <button
                className="primary-button compact"
                type="button"
                disabled={pendingAction === "email:save"}
                data-tooltip="Save the SMTP configuration for alert emails"
                onClick={() => void saveEmailSettings()}
              >
                {pendingAction === "email:save" ? "Saving…" : "Save Email Settings"}
              </button>
              {settingsNotice ? <Pill tone={settingsNotice.tone}>{settingsNotice.text}</Pill> : null}
            </div>
            <div className="alert-email-test-row">
              <input
                value={testRecipient}
                aria-label="Test email recipient"
                placeholder="you@your-domain.com"
                onChange={(event) => setTestRecipient(event.target.value)}
              />
              <button
                className="secondary-button compact"
                type="button"
                disabled={pendingAction === "email:test" || !testRecipient.trim()}
                data-tooltip="Send a real test email through the saved SMTP settings"
                onClick={() => void sendTestEmail()}
              >
                <Send size={14} /> {pendingAction === "email:test" ? "Sending…" : "Send test email"}
              </button>
              {testResult ? (
                <Pill tone={testResult.status === "sent" ? "success" : "danger"}>{testResult.detail}</Pill>
              ) : null}
            </div>
            {emailSettings?.last_test_status ? (
              <small className="usage-token-muted">
                Last test {formatTimestamp(emailSettings.last_test_at)}: {emailSettings.last_test_status}
              </small>
            ) : null}
          </>
        )}
      </Panel>

      <Panel
        title={
          <>
            <BellRing size={18} /> Alert Rules
          </>
        }
        subtitle={
          variant === "owner"
            ? "Platform-wide watch rules over audit activity. Tenant rules created by admins are listed with their scope."
            : "Watch rules over this organization's admin and user audit activity."
        }
        actions={
          <>
            <button
              className="secondary-button compact"
              type="button"
              data-tooltip="Prefill a rule that watches security flags and elevated-severity events"
              onClick={() => openCreateForm(SUSPICIOUS_TEMPLATE)}
            >
              <ShieldAlert size={14} /> Suspicious-activity template
            </button>
            <button
              className="primary-button compact"
              type="button"
              data-tooltip="Create a custom alert rule"
              onClick={() => openCreateForm()}
            >
              <Plus size={14} /> New rule
            </button>
          </>
        }
      >
        {formOpen ? (
          <div className="alert-rule-form">
            <div className="connector-config-grid">
              <label>
                <span className="connector-field-label">
                  Rule name<span className="required-mark"> *</span>
                </span>
                <input
                  value={draft.name}
                  aria-label="Alert rule name"
                  onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                />
              </label>
              <label>
                <span className="connector-field-label">Description</span>
                <input
                  value={draft.description}
                  aria-label="Alert rule description"
                  onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                />
              </label>
              <label>
                <span className="connector-field-label">Action patterns</span>
                <input
                  value={draft.actionPatterns}
                  aria-label="Action patterns"
                  placeholder="security.*, admin.user_deleted"
                  onChange={(event) => setDraft((current) => ({ ...current, actionPatterns: event.target.value }))}
                />
                <small className="field-hint">{ACTION_PATTERN_HINT}. Empty matches every action.</small>
              </label>
              <label>
                <span className="connector-field-label">Minimum severity</span>
                <SelectControl
                  value={draft.minSeverity}
                  aria-label="Minimum severity"
                  onChange={(event) => setDraft((current) => ({ ...current, minSeverity: event.target.value }))}
                >
                  {SEVERITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </SelectControl>
              </label>
              <label>
                <span className="connector-field-label">Watched user</span>
                <SelectControl
                  value={draft.actorId}
                  aria-label="Watched user"
                  onChange={(event) => setDraft((current) => ({ ...current, actorId: event.target.value }))}
                >
                  <option value="any">Any actor</option>
                  {actorOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </SelectControl>
              </label>
              <label>
                <span className="connector-field-label">Fire when</span>
                <div className="alert-threshold-row">
                  <input
                    className="alert-threshold-input"
                    value={draft.thresholdCount}
                    aria-label="Threshold count"
                    inputMode="numeric"
                    onChange={(event) => setDraft((current) => ({ ...current, thresholdCount: event.target.value }))}
                  />
                  <span>matches within</span>
                  <input
                    className="alert-threshold-input"
                    value={draft.windowMinutes}
                    aria-label="Window minutes"
                    inputMode="numeric"
                    onChange={(event) => setDraft((current) => ({ ...current, windowMinutes: event.target.value }))}
                  />
                  <span>min</span>
                </div>
                <small className="field-hint">Set matches to 1 to alert on every matching event.</small>
              </label>
              <label>
                <span className="connector-field-label">Cooldown (minutes)</span>
                <input
                  value={draft.cooldownMinutes}
                  aria-label="Cooldown minutes"
                  inputMode="numeric"
                  onChange={(event) => setDraft((current) => ({ ...current, cooldownMinutes: event.target.value }))}
                />
                <small className="field-hint">Quiet period after a trigger before this rule can fire again.</small>
              </label>
              <label>
                <span className="connector-field-label">Email recipients</span>
                <input
                  value={draft.recipients}
                  aria-label="Email recipients"
                  placeholder="soc@your-domain.com, admin@your-domain.com"
                  onChange={(event) => setDraft((current) => ({ ...current, recipients: event.target.value }))}
                />
                <small className="field-hint">
                  Comma-separated. Leave empty to log alerts in-app without email.
                </small>
              </label>
            </div>
            {formError ? <Pill tone="danger">{formError}</Pill> : null}
            <div className="alert-email-actions">
              <button
                className="primary-button compact"
                type="button"
                disabled={pendingAction === "rule:save"}
                onClick={() => void submitRule()}
              >
                {pendingAction === "rule:save"
                  ? "Saving…"
                  : editingRuleId
                    ? "Save Rule"
                    : "Create Rule"}
              </button>
              <button className="secondary-button compact" type="button" onClick={closeForm}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        {rulesError ? (
          <div className="audit-empty-state">
            <ShieldAlert size={20} />
            <span>
              <strong>Alert rules could not be loaded</strong>
              <small>{rulesError}</small>
            </span>
          </div>
        ) : !connected ? (
          <div className="audit-empty-state">
            <BellRing size={20} />
            <span>
              <strong>Alert rules endpoint is not connected</strong>
              <small>Rules load from the alerting API when it is available.</small>
            </span>
          </div>
        ) : rules === null ? (
          <div className="audit-empty-state">
            <BellRing size={20} />
            <span>
              <strong>Alert rules are loading</strong>
              <small>Reading stored alert rules.</small>
            </span>
          </div>
        ) : ruleRows.length === 0 && !formOpen ? (
          <div className="audit-empty-state">
            <BellRing size={20} />
            <span>
              <strong>No alert rules yet</strong>
              <small>
                Create a rule — or start from the suspicious-activity template — to get alerted when matching audit
                events occur.
              </small>
            </span>
          </div>
        ) : (
          <div className="audit-trail-list" role="list" aria-label="Alert rules">
            {ruleRows.map((rule) => (
              <div className="audit-row alert-rule-row" role="listitem" key={rule.id}>
                <BellRing size={17} />
                <span>
                  <strong>
                    {rule.name}
                    {rule.actor_ids.length === 1 && actorLabelById.has(rule.actor_ids[0])
                      ? ` · ${actorLabelById.get(rule.actor_ids[0])}`
                      : ""}
                  </strong>
                  <small className="alert-rule-criteria">
                    {ruleCriteriaSummary(rule)} ·{" "}
                    {rule.recipients.length
                      ? `${rule.recipients.length} recipient${rule.recipients.length === 1 ? "" : "s"}`
                      : "in-app only"}
                    {rule.last_triggered_at ? ` · last fired ${formatTimestamp(rule.last_triggered_at)}` : ""}
                  </small>
                </span>
                <span className="alert-rule-actions">
                  {variant === "owner" ? (
                    <Pill tone={rule.scope === "platform" ? "info" : "neutral"}>{rule.scope}</Pill>
                  ) : null}
                  <Pill tone={rule.enabled ? "success" : "neutral"}>{rule.enabled ? "enabled" : "disabled"}</Pill>
                  <button
                    className="secondary-button compact"
                    type="button"
                    disabled={pendingAction === `rule:${rule.id}:toggle`}
                    data-tooltip={rule.enabled ? "Disable this rule" : "Enable this rule"}
                    onClick={() => void toggleRule(rule)}
                  >
                    {rule.enabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    className="secondary-button compact"
                    type="button"
                    data-tooltip="Edit this rule"
                    onClick={() => openEditForm(rule)}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    className="secondary-button compact danger"
                    type="button"
                    disabled={pendingAction === `rule:${rule.id}:delete`}
                    data-tooltip="Delete this rule"
                    onClick={() => void removeRule(rule)}
                  >
                    <Trash2 size={14} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title={
          <>
            <ListChecks size={18} /> Alert Deliveries
          </>
        }
        subtitle="Every alert trigger and its real delivery status — sent, queued, failed with the actual SMTP error, not configured, or logged in-app. Archiving hides a delivery from this list without deleting its history."
        actions={
          <>
            {(archivedNotificationCount > 0 || showArchived) && (
              <button
                className="secondary-button compact"
                type="button"
                aria-pressed={showArchived}
                data-tooltip={
                  showArchived
                    ? "Hide archived deliveries from the list again"
                    : "Show the archived deliveries alongside the active ones"
                }
                onClick={() => setShowArchived((value) => !value)}
              >
                <Archive size={14} />{" "}
                {showArchived ? "Hide archived" : `Show archived (${archivedNotificationCount})`}
              </button>
            )}
            <button
              className="secondary-button compact"
              type="button"
              disabled={notificationRows.length === 0}
              data-tooltip="Download the loaded alert deliveries as CSV, archived included"
              onClick={() => downloadNotificationsCsv(notificationRows, variant)}
            >
              <Download size={14} /> CSV
            </button>
            <button
              className="secondary-button compact"
              type="button"
              data-tooltip="Reload alert rules and deliveries"
              onClick={refresh}
            >
              <RefreshCw size={14} /> Refresh
            </button>
          </>
        }
      >
        {notificationsError ? (
          <div className="audit-empty-state">
            <ShieldAlert size={20} />
            <span>
              <strong>Alert deliveries could not be loaded</strong>
              <small>{notificationsError}</small>
            </span>
          </div>
        ) : !api?.listNotifications ? (
          <div className="audit-empty-state">
            <ListChecks size={20} />
            <span>
              <strong>Alert deliveries endpoint is not connected</strong>
              <small>The delivery log loads from the alerting API when it is available.</small>
            </span>
          </div>
        ) : notifications === null ? (
          <div className="audit-empty-state">
            <ListChecks size={20} />
            <span>
              <strong>Alert deliveries are loading</strong>
              <small>Reading the alert delivery log.</small>
            </span>
          </div>
        ) : notificationRows.length === 0 ? (
          <div className="audit-empty-state">
            <ListChecks size={20} />
            <span>
              <strong>No alerts have fired yet</strong>
              <small>When an enabled rule matches audit activity, its trigger and delivery status appear here.</small>
            </span>
          </div>
        ) : visibleNotificationRows.length === 0 ? (
          <div className="audit-empty-state">
            <Archive size={20} />
            <span>
              <strong>Every delivery is archived</strong>
              <small>
                {archivedNotificationCount.toLocaleString()} archived deliver
                {archivedNotificationCount === 1 ? "y" : "ies"} — use Show archived to review or restore them.
              </small>
            </span>
          </div>
        ) : (
          <div className="audit-trail-list scrollable-log-list" role="list" aria-label="Alert deliveries">
            {visibleNotificationRows.map((notification) => {
              const archivePending = pendingAction === `notification:${notification.id}:archive`;
              return (
                <div
                  className={`audit-row alert-delivery-row${notification.archived ? " is-archived" : ""}`}
                  role="listitem"
                  key={notification.id}
                >
                  <BellRing size={17} />
                  <span>
                    <strong>{notification.rule_name}</strong>
                    <small>
                      {notification.summary} · {notification.actor_name || notification.actor_id}
                      {notification.matched_count > 1 ? ` · ${notification.matched_count} events in window` : ""}
                      {notification.recipients.length ? ` · to ${notification.recipients.join(", ")}` : ""}
                      {notification.status_detail ? ` · ${notification.status_detail}` : ""}
                      {notification.attempts > 1 ? ` · ${notification.attempts} attempts` : ""}
                    </small>
                  </span>
                  <span className="security-alert-actions">
                    <Pill tone={notificationPillTone(notification.status)}>
                      {notification.archived ? "Archived" : notificationStatusLabel(notification.status)}
                    </Pill>
                    {setNotificationArchived && (
                      <button
                        className="secondary-button compact"
                        type="button"
                        disabled={archivePending}
                        aria-label={
                          notification.archived
                            ? `Restore ${notification.rule_name} delivery`
                            : `Archive ${notification.rule_name} delivery`
                        }
                        data-tooltip={
                          notification.archived
                            ? "Bring this delivery back into the default list"
                            : "Hide this delivery from the default list; its history is kept"
                        }
                        onClick={() => void archiveNotification(notification, !notification.archived)}
                      >
                        {notification.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}{" "}
                        {notification.archived ? "Restore" : "Archive"}
                      </button>
                    )}
                  </span>
                  <time dateTime={notification.created_at}>{formatTimestamp(notification.created_at)}</time>
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}
