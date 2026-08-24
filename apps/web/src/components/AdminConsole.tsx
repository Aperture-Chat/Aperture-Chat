import { SelectControl } from "./SelectControl";
import * as Tabs from "@radix-ui/react-tabs";
import {
  Ban,
  BarChart3,
  BookOpen,
  Bot,
  Brain,
  Bug,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  DatabaseZap,
  Download,
  Eye,
  Filter,
  FolderPlus,
  KeyRound,
  LineChart,
  ListChecks,
  Lock,
  MessageSquareText,
  MessageSquare,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ServerCog,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Upload,
  Users,
  Wrench,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Fragment, Suspense, useEffect, useMemo, useRef, useState } from "react";

import { LazyChunkBoundary, lazyWithReload } from "../lib/lazyChunk";

const AdminDocumentationModal = lazyWithReload("admin-documentation", () =>
  import("./AdminTrainingVideos").then((module) => ({ default: module.AdminDocumentationModal })),
);
import { PasswordResetDialog } from "./PasswordResetDialog";
import { FeedbackConversationPreview, PromptActivityList } from "./PromptActivityList";
import { IssueReportPreview } from "./IssueReportPreview";
import { markdownToPlainText } from "../lib/markdown";
import { RetentionPanel, RetentionTagsView } from "./RetentionPanel";
import { AlertsConsole, type AlertsConsoleApi } from "./AlertsConsole";
import { AuditSummaryCard, type AuditSummaryItem } from "./AuditSummaryCard";
import { ModelFilterDialog, type ModelFilterDialogApi } from "./ModelFilterDialog";
import { CustomToolBuilder, type CustomToolBuilderApi } from "./CustomToolBuilder";

import type {
  AdminConnectorConfigUpdateRequest,
  AdminContentFilterCreateRequest,
  AdminContentFilterUpdateRequest,
  AdminSsoConfigCreateRequest,
  AdminSsoConfigUpdateRequest,
  AdminToolConfigCreateRequest,
  AdminToolConfigUpdateRequest,
  AuditEvent,
  BootstrapData,
  Connector,
  ConnectorConfigRecord,
  ContentFilter,
  ContentFilterPreviewResult,
  ContentFilterRule,
  CustomScriptRunResult,
  Group,
  MemoryUserStat,
  ModelConfig,
  Role,
  SecurityAlert,
  SsoConfig,
  TenantMemoryPolicy,
  TenantMemoryPolicyUpdateRequest,
  TenantRetentionPolicy,
  TenantRetentionPolicyUpdateRequest,
  ChatFeedbackRecord,
  IssueReportRecord,
  RetentionBatchRequest,
  RetentionBatchResult,
  RetentionTaggedThread,
  ToolConfig,
  ToolConfigRecord,
  User,
  AlertEmailStatus,
  AlertNotification,
  AlertRule,
  AlertRuleCreateRequest,
  AlertRuleUpdateRequest,
  UsageRecord,
  UsageSummary,
  UserPromptRecord,
} from "../lib/types";
import type { ConnectorTestResult, SsoTestResult, TenantUsageBudgetSnapshot } from "../lib/api";
import {
  deleteAdminUsageAllocation,
  getAdminUsageAllocations,
  getAdminUsageBudget,
  setAdminUsageAllocation,
  type UsageAllocationsSnapshot,
  mapToolConfigRecordToDisplay,
  ssoRedirectUri,
  UsageBudgetRequestError,
} from "../lib/api";
import {
  CHAT_FEEDBACK_UPDATED_EVENT,
  loadChatFeedback,
  type ChatFeedbackEvent,
} from "../lib/chatFeedback";
import { Panel, Pill, StableLabel, Toggle } from "./Primitives";
import { userIdentityTooltip } from "../lib/userIdentity";
import { modelLabLabel } from "../lib/modelAccess";
import { UserAvatar } from "./UserAvatar";
import {
  EMPTY_SECTION_SCOPE,
  SectionScopeFilter,
  sectionScopeMatch,
  timestampInDateRange,
  type SectionScope,
} from "./SectionScopeFilter";

const ROLE_ORDER: Role[] = ["USER", "TEMP_USER", "POWER_USER", "AUDITOR", "AGENT_APPROVER"];
const PLATFORM_OWNER_ASSIGNABLE_ROLES: Role[] = ["TENANT_ADMIN", ...ROLE_ORDER];
const ROLE_LABELS: Record<Role, string> = {
  PLATFORM_OWNER: "Platform Owner",
  TENANT_ADMIN: "Admin",
  TEMP_USER: "Temp User",
  POWER_USER: "Power User",
  AUDITOR: "Auditor",
  AGENT_APPROVER: "Agent Approver",
  USER: "User",
};

type ModelStatusFilter = "all" | "enabled" | "disabled";

const MODEL_STATUS_FILTER_OPTIONS: Array<{ value: ModelStatusFilter; label: string; tooltip: string }> = [
  { value: "all", label: "All", tooltip: "Show every model, enabled and disabled" },
  { value: "enabled", label: "Enabled", tooltip: "Show only models tenants can currently use" },
  { value: "disabled", label: "Disabled", tooltip: "Show only models that are turned off for the organization" },
];

type GroupPermission = {
  key: string;
  label: string;
  description: string;
  icon: LucideIcon;
};

const GROUP_PERMISSION_SECTIONS: Array<{ title: string; permissions: GroupPermission[] }> = [
  {
    title: "Enforced Runtime Access",
    permissions: [
      {
        key: "chat_access",
        icon: MessageSquare,
        label: "Can use chat",
        description: "Start conversations and use assigned models.",
      },
      {
        key: "knowledge_access",
        icon: BookOpen,
        label: "Can use knowledge",
        description: "Query approved knowledge bases.",
      },
      {
        key: "agents_access",
        icon: Bot,
        label: "Can use agents",
        description: "Run approved agent workspaces.",
      },
      {
        key: "tools_access",
        icon: Wrench,
        label: "Can use tools",
        description: "Invoke enabled tools and MCP actions.",
      },
      {
        key: "api_access",
        icon: KeyRound,
        label: "Can use API",
        description: "Create a personal key for approved models and agent harnesses.",
      },
      {
        key: "hermes_companion",
        icon: ServerCog,
        label: "Can use Hermes companion",
        description:
          "Build and run agent profiles with the Hermes learning companion (saves memories and skills, proposes automations). Off until approved.",
      },
      {
        key: "agent_authoring",
        icon: Bot,
        label: "Can build agents",
        description:
          "Create and edit their own private agent profiles from available models. Publishing to the organization stays admin-only. Requires service policy to allow user-built agents.",
      },
      {
        key: "knowledge_authoring",
        icon: BookOpen,
        label: "Can build knowledge bases",
        description:
          "Create and maintain their own private knowledge bases. Sharing with groups and organization-wide management stay admin-only.",
      },
      {
        key: "tool_authoring",
        icon: Wrench,
        label: "Can build tools",
        description:
          "Create and maintain their own private tools. Group sharing, stdio commands, and organization-wide management stay admin-only.",
      },
      {
        key: "memory_access",
        icon: Brain,
        label: "Can use memory",
        description: "Let the assistant learn and reuse this group's personal preferences.",
      },
    ],
  },
];

function modelNameMatchesSearch(model: ModelConfig, searchTerm: string) {
  return !searchTerm || model.name.toLowerCase().includes(searchTerm);
}

function toolAuthorizeUrl(tool: ToolConfig): string | null {
  const authorizationUrl = tool.oauth_authorization_url?.trim();
  const clientId = tool.client_id?.trim();
  if (!authorizationUrl || !clientId) return null;
  try {
    const url = new URL(authorizationUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set(
      "redirect_uri",
      tool.oauth_callback_url || `http://localhost:8000/api/tools/${tool.id}/oauth/callback`,
    );
    url.searchParams.set("state", tool.id);
    if (tool.scopes.length > 0) {
      url.searchParams.set("scope", tool.scopes.join(" "));
    }
    return url.toString();
  } catch {
    return null;
  }
}

const DEFAULT_GROUP_PERMISSIONS = Object.fromEntries(
  GROUP_PERMISSION_SECTIONS.flatMap((section) =>
    section.permissions.map((permission) => [
      permission.key,
      ![
        "api_access",
        "hermes_companion",
        "agent_authoring",
        "knowledge_authoring",
        "tool_authoring",
      ].includes(permission.key),
    ]),
  ),
) as Record<string, boolean>;

type AdminUserCreateInput = Pick<User, "email" | "display_name" | "role" | "group_ids" | "active"> & {
  id?: string;
  tenant_id?: string | null;
};
type AdminUserUpdateInput = Partial<Pick<User, "email" | "display_name" | "role" | "group_ids" | "active" | "tenant_id">>;
type AdminGroupCreateInput = Pick<
  Group,
  "name" | "distinguished_name" | "entra_object_id" | "synced" | "user_count" | "permissions"
> & {
  id?: string;
  tenant_id?: string | null;
};
type AdminGroupUpdateInput = Partial<
  Pick<Group, "name" | "distinguished_name" | "entra_object_id" | "synced" | "user_count" | "permissions">
>;
type AdminMutationContext = { actor: User; tenantId: string };
type ActionTone = "info" | "success" | "warning" | "danger";
type ActionStatus = { tone: ActionTone; message: string };
type AdminMutationOptions<T> = {
  pendingKey: string;
  helper?: () => Promise<T | void>;
  optimistic: () => void;
  reconcile?: (result: T) => void;
  localMessage: string;
  syncMessage: string;
  successMessage: string;
  failureMessage: string;
};

type RuntimeAuditRow = {
  id: string;
  surface: "chat" | "draft";
  title: string;
  detail: string;
  metadata: string;
  executedAt: string;
  actorRole: string;
  actorId: string;
  actorName: string;
};

type CsvValue = string | number | boolean | null | undefined;
type CsvColumn<T> = {
  header: string;
  value: (item: T) => CsvValue;
};

const ACTION_TONE_LABELS: Record<ActionTone, string> = {
  info: "Syncing",
  success: "Synced",
  warning: "Local",
  danger: "Error",
};

const RUNTIME_ANALYTICS_CSV_COLUMNS: Array<CsvColumn<RuntimeAuditRow>> = [
  { header: "id", value: (item) => item.id },
  { header: "actor_id", value: (item) => item.actorId },
  { header: "actor_name", value: (item) => item.actorName },
  { header: "surface", value: (item) => item.surface },
  { header: "title", value: (item) => item.title },
  { header: "detail", value: (item) => item.detail },
  { header: "metadata", value: (item) => item.metadata },
  { header: "executed_at", value: (item) => item.executedAt },
];

type FeedbackDisplayItem = ChatFeedbackEvent & { comment?: string };

const CHAT_FEEDBACK_CSV_COLUMNS: Array<CsvColumn<FeedbackDisplayItem>> = [
  { header: "id", value: (item) => item.id },
  { header: "created_at", value: (item) => item.created_at },
  { header: "rating", value: (item) => item.rating },
  { header: "comment", value: (item) => item.comment ?? "" },
  { header: "thread_id", value: (item) => item.thread_id },
  { header: "thread_title", value: (item) => item.thread_title },
  { header: "message_id", value: (item) => item.message_id },
  { header: "model_id", value: (item) => item.model_id },
  { header: "user_id", value: (item) => item.user_id },
  { header: "user_name", value: (item) => item.user_name },
  { header: "message_preview", value: (item) => item.message_preview },
];

const AUDIT_TRAIL_CSV_COLUMNS: Array<CsvColumn<AuditEvent>> = [
  { header: "id", value: (item) => item.id },
  { header: "created_at", value: (item) => item.created_at },
  { header: "tenant_id", value: (item) => item.tenant_id ?? "" },
  { header: "actor_id", value: (item) => item.actor_id },
  { header: "actor_name", value: (item) => item.actor_name },
  { header: "actor_role", value: (item) => item.actor_role },
  { header: "action", value: (item) => item.action },
  { header: "action_type", value: (item) => item.action_type },
  { header: "target", value: (item) => item.target },
  { header: "target_type", value: (item) => item.target_type },
  { header: "target_name", value: (item) => item.target_name },
  { header: "detail", value: (item) => item.detail },
  { header: "severity", value: (item) => item.severity ?? "" },
  { header: "severity_reason", value: (item) => item.severity_reason ?? "" },
  { header: "redacted", value: (item) => item.redacted },
  { header: "metadata_json", value: (item) => JSON.stringify(item.metadata ?? {}) },
];

const USAGE_RECORD_CSV_COLUMNS: Array<CsvColumn<UsageRecord>> = [
  { header: "id", value: (item) => item.id },
  { header: "created_at", value: (item) => item.created_at },
  { header: "user_id", value: (item) => item.user_id },
  { header: "user_name", value: (item) => item.user_name },
  { header: "user_role", value: (item) => item.user_role },
  { header: "model_id", value: (item) => item.model_id },
  { header: "provider_name", value: (item) => item.provider_name },
  { header: "surface", value: (item) => item.surface },
  { header: "message_count", value: (item) => item.message_count },
  { header: "prompt_tokens", value: (item) => item.prompt_tokens ?? "" },
  { header: "completion_tokens", value: (item) => item.completion_tokens ?? "" },
  { header: "total_tokens", value: (item) => item.total_tokens ?? "" },
  { header: "thread_id", value: (item) => item.thread_id ?? "" },
  { header: "source", value: (item) => item.source },
];

const PROMPT_ACTIVITY_CSV_COLUMNS: Array<CsvColumn<UserPromptRecord>> = [
  { header: "id", value: (item) => item.id },
  { header: "created_at", value: (item) => item.created_at_iso || item.created_at },
  { header: "user_id", value: (item) => item.user_id },
  { header: "user_name", value: (item) => item.user_name },
  { header: "user_email", value: (item) => item.user_email },
  { header: "user_role", value: (item) => item.user_role ?? "" },
  { header: "thread_id", value: (item) => item.thread_id },
  { header: "thread_title", value: (item) => item.thread_title },
  { header: "model_id", value: (item) => item.model_id },
  { header: "active_alert_count", value: (item) => item.alert_count },
  { header: "prompt", value: (item) => item.content },
  { header: "response", value: (item) => item.response_content ?? "" },
  { header: "response_status", value: (item) => item.response_status ?? "" },
  { header: "response_truncated", value: (item) => item.response_truncated ?? false },
];

function CsvExportControl<T>({
  label,
  filenameBase,
  items,
  getTimestamp,
  columns,
}: {
  label: string;
  filenameBase: string;
  items: T[];
  getTimestamp: (item: T) => string;
  columns: Array<CsvColumn<T>>;
}) {
  const [open, setOpen] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [throughDate, setThroughDate] = useState("");
  const filteredItems = useMemo(
    () => items.filter((item) => timestampInDateRange(getTimestamp(item), fromDate, throughDate)),
    [fromDate, getTimestamp, items, throughDate],
  );
  const rangeLabel = csvRangeLabel(fromDate, throughDate);

  function download() {
    downloadCsvFile(`${filenameBase}-${rangeLabel}.csv`, rowsToCsv(filteredItems, columns));
    setOpen(false);
  }

  return (
    <div className="csv-export-control">
      <button
        className="secondary-button compact"
        type="button"
        data-tooltip={`Choose a date range and download ${label} as CSV`}
        onClick={() => setOpen((value) => !value)}
      >
        <Download size={14} /> CSV
      </button>
      {open && (
        <div className="csv-export-popover" role="dialog" aria-label={`${label} CSV date range`}>
          <strong>Export {label}</strong>
          <label>
            From
            <input
              type="date"
              aria-label={`${label} start date`}
              value={fromDate}
              onChange={(event) => setFromDate(event.target.value)}
            />
          </label>
          <label>
            Through
            <input
              type="date"
              aria-label={`${label} end date`}
              value={throughDate}
              onChange={(event) => setThroughDate(event.target.value)}
            />
          </label>
          <div className="csv-export-actions">
            <button className="secondary-button compact" type="button" onClick={() => { setFromDate(""); setThroughDate(""); }}>
              All dates
            </button>
            <button className="primary-button compact" type="button" onClick={download}>
              Download {filteredItems.length.toLocaleString()} row{filteredItems.length === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export type AdminConsoleApi = {
  listAuditEvents?: (actorUserId: string, context: AdminMutationContext) => Promise<AuditEvent[] | void>;
  listPromptActivity?: (
    actorUserId: string,
    targetUserId: string | undefined,
    context: AdminMutationContext,
  ) => Promise<UserPromptRecord[] | void> | UserPromptRecord[] | void;
  /** Loads every saved exchange of one chat thread so the audit preview can
   * show the full conversation, not just the clicked record. */
  listThreadPromptActivity?: (
    actorUserId: string,
    threadId: string,
    context: AdminMutationContext,
  ) => Promise<UserPromptRecord[] | void> | UserPromptRecord[] | void;
  listSecurityAlerts?: (
    actorUserId: string,
    targetUserId: string | undefined,
    context: AdminMutationContext,
  ) => Promise<SecurityAlert[] | void> | SecurityAlert[] | void;
  acknowledgeSecurityAlert?: (
    actorUserId: string,
    alertId: string,
    acknowledged: boolean,
    context: AdminMutationContext,
  ) => Promise<SecurityAlert | void> | SecurityAlert | void;
  getUsageSummary?: (
    actorUserId: string,
    options: { targetUserId?: string; fromDate?: string; throughDate?: string },
    context: AdminMutationContext,
  ) => Promise<UsageSummary | void> | UsageSummary | void;
  listUsageRecords?: (
    actorUserId: string,
    targetUserId: string | undefined,
    context: AdminMutationContext,
  ) => Promise<UsageRecord[] | void> | UsageRecord[] | void;
  listAlertRules?: (actorUserId: string, context: AdminMutationContext) => Promise<AlertRule[] | void>;
  createAlertRule?: (
    actorUserId: string,
    payload: AlertRuleCreateRequest,
    context: AdminMutationContext,
  ) => Promise<AlertRule | void>;
  updateAlertRule?: (
    actorUserId: string,
    ruleId: string,
    patch: AlertRuleUpdateRequest,
    context: AdminMutationContext,
  ) => Promise<AlertRule | void>;
  deleteAlertRule?: (actorUserId: string, ruleId: string, context: AdminMutationContext) => Promise<void>;
  listAlertNotifications?: (
    actorUserId: string,
    context: AdminMutationContext,
  ) => Promise<AlertNotification[] | void>;
  setAlertNotificationArchived?: (
    actorUserId: string,
    notificationId: string,
    archived: boolean,
    context: AdminMutationContext,
  ) => Promise<AlertNotification | void>;
  getAlertEmailStatus?: (
    actorUserId: string,
    context: AdminMutationContext,
  ) => Promise<AlertEmailStatus | void>;
  createUser?: (actorUserId: string, payload: AdminUserCreateInput, context: AdminMutationContext) => Promise<User | void>;
  approveAccessRequest?: (
    actorUserId: string,
    userId: string,
    role: "USER" | "TEMP_USER" | "TENANT_ADMIN",
    context: AdminMutationContext,
  ) => Promise<User | void>;
  declineAccessRequest?: (actorUserId: string, userId: string, context: AdminMutationContext) => Promise<void>;
  updateUser?: (actorUserId: string, userId: string, patch: AdminUserUpdateInput, context: AdminMutationContext) => Promise<User | void>;
  deactivateUser?: (actorUserId: string, userId: string, context: AdminMutationContext) => Promise<User | void>;
  deleteUser?: (actorUserId: string, userId: string, context: AdminMutationContext) => Promise<void>;
  resetUserPassword?: (
    actorUserId: string,
    userId: string,
    payload: { password: string; temporary: boolean },
    context: AdminMutationContext,
  ) => Promise<void>;
  createGroup?: (actorUserId: string, payload: AdminGroupCreateInput, context: AdminMutationContext) => Promise<Group | void>;
  createGroups?: (
    actorUserId: string,
    payload: { groups: AdminGroupCreateInput[] },
    context: AdminMutationContext,
  ) => Promise<Group[] | void>;
  updateGroup?: (
    actorUserId: string,
    groupId: string,
    patch: AdminGroupUpdateInput,
    context: AdminMutationContext,
  ) => Promise<Group | void>;
  deleteGroup?: (actorUserId: string, groupId: string, context: AdminMutationContext) => Promise<void>;
  deleteGroups?: (actorUserId: string, groupIds: string[], context: AdminMutationContext) => Promise<string[] | void>;
  updateModelAccess?: (
    actorUserId: string,
    modelId: string,
    patch: { group_ids: string[] },
    context: AdminMutationContext & { model: ModelConfig },
  ) => Promise<ModelConfig | void>;
  listModelAccess?: (actorUserId: string, context: AdminMutationContext) => Promise<ModelConfig[] | void>;
  syncModelAccess?: (actorUserId: string, context: AdminMutationContext) => Promise<ModelConfig[] | void>;
  setConnectorEnabled?: (
    actorUserId: string,
    connectorId: string,
    enabled: boolean,
    context: AdminMutationContext & { connector: Connector },
  ) => Promise<Partial<Connector> | void>;
  saveConnectorConfig?: (
    actorUserId: string,
    connector: Connector,
    payload: AdminConnectorConfigUpdateRequest & { connector_id: string },
    context: AdminMutationContext,
  ) => Promise<{ connector: Partial<Connector>; record: ConnectorConfigRecord } | void>;
  testConnectorConfig?: (
    actorUserId: string,
    configId: string,
    context: AdminMutationContext,
  ) => Promise<ConnectorTestResult | void>;
  connectorOAuthUrl?: (actorUserId: string, configId: string) => Promise<string | void>;
  setToolEnabled?: (
    actorUserId: string,
    toolId: string,
    enabled: boolean,
    context: AdminMutationContext & { tool: ToolConfig },
  ) => Promise<Partial<ToolConfig> | void>;
  setSsoEnforced?: (
    actorUserId: string,
    configId: string,
    enforced: boolean,
    context: AdminMutationContext & { config: SsoConfig },
  ) => Promise<Partial<SsoConfig> | void>;
  createSsoConfig?: (
    actorUserId: string,
    payload: AdminSsoConfigCreateRequest,
    context: AdminMutationContext,
  ) => Promise<SsoConfig | void>;
  updateSsoConfig?: (
    actorUserId: string,
    configId: string,
    payload: AdminSsoConfigUpdateRequest,
    context: AdminMutationContext & { config: SsoConfig },
  ) => Promise<SsoConfig | void>;
  deleteSsoConfig?: (actorUserId: string, configId: string, context: AdminMutationContext) => Promise<void>;
  testSsoConfig?: (actorUserId: string, configId: string, context: AdminMutationContext) => Promise<SsoTestResult | void>;
  listContentFilters?: (actorUserId: string, context: AdminMutationContext) => Promise<ContentFilter[] | void>;
  createContentFilter?: (
    actorUserId: string,
    payload: AdminContentFilterCreateRequest,
    context: AdminMutationContext,
  ) => Promise<ContentFilter | void>;
  updateContentFilter?: (
    actorUserId: string,
    filterId: string,
    payload: AdminContentFilterUpdateRequest,
    context: AdminMutationContext,
  ) => Promise<ContentFilter | void>;
  deleteContentFilter?: (actorUserId: string, filterId: string, context: AdminMutationContext) => Promise<void>;
  previewContentFilter?: (
    actorUserId: string,
    payload: { rules: ContentFilterRule[]; sample: string },
    context: AdminMutationContext,
  ) => Promise<ContentFilterPreviewResult | void>;
  setModelContentFilters?: (
    actorUserId: string,
    modelId: string,
    contentFilterIds: string[],
    context: AdminMutationContext,
  ) => Promise<ModelConfig | void>;
  createToolConfig?: (
    actorUserId: string,
    payload: AdminToolConfigCreateRequest,
    context: AdminMutationContext,
  ) => Promise<ToolConfigRecord | void>;
  updateToolConfig?: (
    actorUserId: string,
    toolId: string,
    payload: AdminToolConfigUpdateRequest,
    context: AdminMutationContext,
  ) => Promise<ToolConfigRecord | void>;
  deleteToolConfig?: (actorUserId: string, toolId: string, context: AdminMutationContext) => Promise<void>;
  previewToolScript?: (
    actorUserId: string,
    payload: { script: string; input: string; timeout_seconds: number },
    context: AdminMutationContext,
  ) => Promise<CustomScriptRunResult | void>;
  // Memory administration is governance only. Nothing here returns memory text.
  getMemoryPolicy?: (actorUserId: string, context: AdminMutationContext) => Promise<TenantMemoryPolicy | void>;
  updateMemoryPolicy?: (
    actorUserId: string,
    patch: TenantMemoryPolicyUpdateRequest,
    context: AdminMutationContext,
  ) => Promise<TenantMemoryPolicy | void>;
  getMemoryStats?: (actorUserId: string, context: AdminMutationContext) => Promise<MemoryUserStat[] | void>;
  purgeUserMemories?: (
    actorUserId: string,
    userId: string,
    context: AdminMutationContext,
  ) => Promise<{ removed: number } | void>;
  // Data retention governance. Policy plus a content-free tagged-thread list.
  getRetentionPolicy?: (
    actorUserId: string,
    context: AdminMutationContext,
  ) => Promise<TenantRetentionPolicy | void>;
  updateRetentionPolicy?: (
    actorUserId: string,
    patch: TenantRetentionPolicyUpdateRequest,
    context: AdminMutationContext,
  ) => Promise<TenantRetentionPolicy | void>;
  listRetentionThreads?: (
    actorUserId: string,
    context: AdminMutationContext,
  ) => Promise<RetentionTaggedThread[] | void>;
  runRetentionBatch?: (
    actorUserId: string,
    payload: RetentionBatchRequest,
    context: AdminMutationContext,
  ) => Promise<RetentionBatchResult | void>;
  /** Server-side response sentiment with user notes. */
  listChatFeedback?: (
    actorUserId: string,
    context: AdminMutationContext,
  ) => Promise<ChatFeedbackRecord[] | void>;
  listIssueReports?: (
    actorUserId: string,
    context: AdminMutationContext,
  ) => Promise<IssueReportRecord[] | void>;
  loadIssueReportScreenshot?: (
    actorUserId: string,
    reportId: string,
  ) => Promise<Blob>;
};

type ConnectorFieldSpec = {
  key: string;
  label: string;
  placeholder?: string;
  hint?: string;
  /** Limit to specific auth modes; omitted = always shown. */
  modes?: string[];
  required?: boolean;
};

type ConnectorFormProfile = {
  authModes: Array<{ value: string; label: string }>;
  fields: ConnectorFieldSpec[];
  secretLabel: Record<string, string>;
  /** Google-style OAuth consent flow available for this mode. */
  oauthConnectMode?: string;
  /** Second secret (service-account password) collected for these modes. */
  passwordModes?: string[];
  setupNote?: string;
};

// Field sets mirror the backend connector_auth requirements. Service
// credentials can power background knowledge sync, while chat attachment
// access uses delegated tokens stored for each signed-in user. iManage never
// uses its service account in the chat picker.
const CONNECTOR_FORM_PROFILES: Record<string, ConnectorFormProfile> = {
  "google-drive": {
    authModes: [
      { value: "oauth-client", label: "Google OAuth (recommended)" },
      { value: "manual-token", label: "Paste access token (testing only)" },
    ],
    fields: [
      {
        key: "client_id",
        label: "OAuth client ID",
        modes: ["oauth-client"],
        required: true,
        placeholder: "1234567890-abc.apps.googleusercontent.com",
        hint: "Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 web client.",
      },
      {
        key: "folder_id",
        label: "Drive folder ID",
        placeholder: "1AbCdEfGhIjKlMnOpQrStUvWxYz",
        hint: "From the folder URL. Leave blank to index from the Drive root.",
      },
      { key: "source_label", label: "Source label", placeholder: "Policy Library" },
    ],
    secretLabel: { "oauth-client": "OAuth client secret", "manual-token": "Access token" },
    oauthConnectMode: "oauth-client",
    setupNote:
      "Scope requested: drive.readonly. Add {API base}/api/connector-oauth/callback as an authorized redirect URI on the OAuth client. The Connect Google Drive button here authorizes the workspace account used for knowledge sync; chat users connect their own Google account from the attach menu and only see their own files.",
  },
  "microsoft-graph": {
    authModes: [
      { value: "client-credentials", label: "App-only (client credentials, recommended)" },
      { value: "manual-token", label: "Paste access token (testing only)" },
    ],
    fields: [
      {
        key: "tenant_id",
        label: "Directory (tenant) ID",
        modes: ["client-credentials"],
        required: true,
        placeholder: "00000000-0000-0000-0000-000000000000",
        hint: "Entra admin center → App registrations → Overview.",
      },
      {
        key: "client_id",
        label: "Application (client) ID",
        modes: ["client-credentials"],
        required: true,
      },
      { key: "site_id", label: "SharePoint site ID", hint: "Optional; for SharePoint libraries." },
      { key: "drive_id", label: "Drive ID", hint: "Optional; for shared drives." },
      { key: "drive_item_id", label: "Root folder / item ID", hint: "Optional; item to index from." },
    ],
    secretLabel: { "client-credentials": "Client secret", "manual-token": "Access token" },
    setupNote:
      "Grant the app Files.Read.All (and Sites.Read.All for SharePoint) as application permissions and click 'Grant admin consent' in Entra — these power knowledge sync. For chat attachments, users sign in with their own Microsoft account: also add the same scopes as delegated permissions and register {API base}/api/connector-oauth/callback as a Web redirect URI.",
  },
  box: {
    authModes: [
      { value: "client-credentials", label: "Client Credentials Grant (recommended)" },
      { value: "developer-token", label: "Developer token (60-minute, testing only)" },
    ],
    fields: [
      { key: "client_id", label: "Client ID", modes: ["client-credentials"], required: true },
      {
        key: "enterprise_id",
        label: "Enterprise ID",
        modes: ["client-credentials"],
        required: true,
        hint: "Admin Console → Account & Billing. A Box admin must authorize the app in Platform Apps Manager (and re-authorize after scope changes).",
      },
      { key: "folder_id", label: "Folder ID", placeholder: "12345", hint: "Numeric folder ID from the Box folder URL." },
    ],
    secretLabel: { "client-credentials": "Client secret", "developer-token": "Developer token" },
    setupNote:
      "Create a Platform App with Server Authentication (CCG) in the Box Developer Console with read access to files and folders — this powers knowledge sync. For chat attachments, users sign in with their own Box account: also enable OAuth 2.0 (Authorization Code) on the app with {API base}/api/connector-oauth/callback as the redirect URI.",
  },
  imanage: {
    authModes: [
      { value: "oauth-client", label: "Each user signs in (recommended)" },
      { value: "password", label: "Service account for background sync" },
    ],
    fields: [
      {
        key: "base_url",
        label: "Instance URL",
        required: true,
        placeholder: "https://cloudimanage.com",
        hint: "Your iManage cloud or on-prem Work server URL.",
      },
      {
        key: "client_id",
        label: "API key (client ID)",
        modes: ["oauth-client", "password"],
        required: true,
        hint: "iManage Control Center → Settings → Applications.",
      },
      {
        key: "user_authorization_url",
        label: "User authorization URL",
        modes: ["oauth-client", "password"],
        placeholder: "Derived from the instance URL",
        hint: "Optional override for on-premises deployments. Default: {Instance URL}/auth/oauth2/authorize.",
      },
      {
        key: "user_token_url",
        label: "User token URL",
        modes: ["oauth-client", "password"],
        placeholder: "Derived from the instance URL",
        hint: "Optional override for on-premises deployments. Default: {Instance URL}/auth/oauth2/token.",
      },
      { key: "customer_id", label: "Customer ID", placeholder: "100" },
      { key: "library_id", label: "Library ID", placeholder: "ACTIVE" },
      { key: "workspace_id", label: "Workspace ID", hint: "Optional; workspace to index." },
      {
        key: "service_username",
        label: "Service account username",
        modes: ["password"],
        required: true,
        hint: "A dedicated iManage user the connector signs in as.",
      },
    ],
    secretLabel: { password: "API secret (client secret)", "oauth-client": "OAuth client secret" },
    passwordModes: ["password"],
    setupNote:
      "Register the app in iManage Control Center, allow refresh tokens, and register {API base}/api/connector-oauth/callback as its redirect URI. Chat users sign in individually and iManage enforces their own library, group, workspace, and document permissions. The service-account option is only for background knowledge sync; chat still requires each user's OAuth sign-in.",
  },
};

export function AdminConsole({
  data,
  onDataChange,
  adminApi,
  openDocumentationRequestKey,
}: {
  data: BootstrapData;
  onDataChange: (updater: (current: BootstrapData) => BootstrapData) => void;
  adminApi?: AdminConsoleApi;
  openDocumentationRequestKey?: number;
}) {
  // Mirrors the committed data so a mutation can capture the pre-optimistic
  // state synchronously and put it back when the server refuses the change.
  const dataRef = useRef(data);
  dataRef.current = data;
  const [selectedGroupId, setSelectedGroupId] = useState(defaultGroupFor(data)?.id ?? data.groups[0]?.id ?? "");
  const [userGroupFilter, setUserGroupFilter] = useState("all");
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [selectedGroupIdsForRemoval, setSelectedGroupIdsForRemoval] = useState<string[]>([]);
  const [showInvite, setShowInvite] = useState(false);
  const [showGroupCreate, setShowGroupCreate] = useState(false);
  const [invite, setInvite] = useState({ name: "", email: "", role: "USER" as Role });
  const [accessReviewRoles, setAccessReviewRoles] = useState<Record<string, "USER" | "TEMP_USER" | "TENANT_ADMIN">>({});
  const [groupDraft, setGroupDraft] = useState(emptyGroupDraft(data.currentTenant.id));
  const [bulkUserText, setBulkUserText] = useState("");
  const [modelAccessSearch, setModelAccessSearch] = useState("");
  const [modelStatusFilter, setModelStatusFilter] = useState<ModelStatusFilter>("all");
  const [modelProviderFilter, setModelProviderFilter] = useState<string[]>([]);
  const [modelLabFilter, setModelLabFilter] = useState<string[]>([]);
  const [modelRouteFilter, setModelRouteFilter] = useState("");
  const [openModelColumnFilter, setOpenModelColumnFilter] = useState<"provider" | "lab" | "route" | null>(null);
  const [openModelGroupId, setOpenModelGroupId] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<ActionStatus | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [expandedConnectorId, setExpandedConnectorId] = useState<string | null>(null);
  const [connectorTestResults, setConnectorTestResults] = useState<Record<string, ConnectorTestResult>>({});
  const [ssoTestResults, setSsoTestResults] = useState<Record<string, SsoTestResult>>({});
  const [showSsoCreate, setShowSsoCreate] = useState(false);
  const [showDocumentation, setShowDocumentation] = useState(false);
  const [passwordTarget, setPasswordTarget] = useState<User | null>(null);
  const [filterModelId, setFilterModelId] = useState<string | null>(null);
  const [toolBuilder, setToolBuilder] = useState<{ open: boolean; tool: ToolConfig | null }>({
    open: false,
    tool: null,
  });

  const [auditTrail, setAuditTrail] = useState<AuditEvent[] | null>(null);
  const [auditTrailError, setAuditTrailError] = useState<string | null>(null);
  const [auditTrailRefreshToken, setAuditTrailRefreshToken] = useState(0);
  const [runtimeScope, setRuntimeScope] = useState<SectionScope>(EMPTY_SECTION_SCOPE);
  const [feedbackScope, setFeedbackScope] = useState<SectionScope>(EMPTY_SECTION_SCOPE);
  const [activityScope, setActivityScope] = useState<SectionScope>(EMPTY_SECTION_SCOPE);
  const [usageScope, setUsageScope] = useState<SectionScope>(EMPTY_SECTION_SCOPE);
  const [promptScope, setPromptScope] = useState<SectionScope>(EMPTY_SECTION_SCOPE);
  const [securityScope, setSecurityScope] = useState<SectionScope>(EMPTY_SECTION_SCOPE);
  const [trailScope, setTrailScope] = useState<SectionScope>(EMPTY_SECTION_SCOPE);
  const [auditSeverityFilter, setAuditSeverityFilter] = useState("all");
  const [auditNamespaceFilter, setAuditNamespaceFilter] = useState("all");
  const [auditSearchQuery, setAuditSearchQuery] = useState("");
  const [promptActivity, setPromptActivity] = useState<UserPromptRecord[] | null>(null);
  const [promptActivityError, setPromptActivityError] = useState<string | null>(null);
  const [securityAlerts, setSecurityAlerts] = useState<SecurityAlert[] | null>(null);
  const [securityAlertsError, setSecurityAlertsError] = useState<string | null>(null);
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usageRecords, setUsageRecords] = useState<UsageRecord[]>([]);
  const [chatFeedback, setChatFeedback] = useState<ChatFeedbackEvent[]>(() => loadChatFeedback());
  const [serverFeedback, setServerFeedback] = useState<ChatFeedbackRecord[] | null>(null);
  const [feedbackRefreshTick, setFeedbackRefreshTick] = useState(0);
  const [feedbackPreview, setFeedbackPreview] = useState<FeedbackDisplayItem | null>(null);
  const [issueReports, setIssueReports] = useState<IssueReportRecord[]>([]);
  const [issueReportPreview, setIssueReportPreview] = useState<IssueReportRecord | null>(null);

  const [memoryPolicy, setMemoryPolicy] = useState<TenantMemoryPolicy | null>(data.memoryPolicy ?? null);
  const [memoryStats, setMemoryStats] = useState<MemoryUserStat[] | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [memoryRefreshToken, setMemoryRefreshToken] = useState(0);
  const [retentionPolicy, setRetentionPolicy] = useState<TenantRetentionPolicy | null>(null);
  const [retentionTagged, setRetentionTagged] = useState<RetentionTaggedThread[] | null>(null);
  const [retentionError, setRetentionError] = useState<string | null>(null);
  const [retentionRefreshToken, setRetentionRefreshToken] = useState(0);
  const [promptPanelView, setPromptPanelView] = useState<"prompts" | "tags">("prompts");
  // Matter labels and retention tags per thread, folded into the prompt
  // phrase search so client/matter numbers find their conversations.
  const promptSearchExtras = useMemo(() => {
    const map: Record<string, string> = {};
    for (const row of retentionTagged ?? []) {
      map[row.thread_id] = [
        row.matter_label ?? "",
        row.matter_id ?? "",
        ...row.tags.map((tag) => `${tag.namespace} ${tag.key} ${tag.value ?? ""}`),
      ].join(" ");
    }
    return map;
  }, [retentionTagged]);
  // The full governance panels stay hidden when service policy has not made
  // memory available, so admins are never offered a control that cannot act.
  const memoryTabVisible = Boolean(data.platformSettings?.memory_enabled);

  const mutationContext = useMemo<AdminMutationContext>(
    () => ({ actor: data.me, tenantId: data.currentTenant.id }),
    [data.currentTenant.id, data.me],
  );
  const filterDialogApi = useMemo<ModelFilterDialogApi | null>(() => {
    const api = adminApi;
    if (
      !api?.listContentFilters ||
      !api.createContentFilter ||
      !api.updateContentFilter ||
      !api.deleteContentFilter ||
      !api.previewContentFilter ||
      !api.setModelContentFilters
    ) {
      return null;
    }
    const requireResult = <T,>(result: T | void, what: string): T => {
      if (result === undefined) throw new Error(`The admin API did not return ${what}.`);
      return result;
    };
    return {
      listFilters: async () => (await api.listContentFilters!(data.me.id, mutationContext)) ?? [],
      createFilter: async (payload) =>
        requireResult(await api.createContentFilter!(data.me.id, payload, mutationContext), "the saved filter"),
      updateFilter: async (filterId, payload) =>
        requireResult(
          await api.updateContentFilter!(data.me.id, filterId, payload, mutationContext),
          "the saved filter",
        ),
      deleteFilter: async (filterId) => {
        await api.deleteContentFilter!(data.me.id, filterId, mutationContext);
      },
      previewFilter: async (rules, sample) =>
        requireResult(
          await api.previewContentFilter!(data.me.id, { rules, sample }, mutationContext),
          "the test result",
        ),
      setModelFilters: async (modelId, filterIds) =>
        requireResult(
          await api.setModelContentFilters!(data.me.id, modelId, filterIds, mutationContext),
          "the updated model",
        ),
    };
  }, [adminApi, data.me.id, mutationContext]);
  const toolBuilderApi = useMemo<CustomToolBuilderApi | null>(() => {
    const api = adminApi;
    if (!api?.createToolConfig || !api.updateToolConfig || !api.previewToolScript) return null;
    const requireResult = <T,>(result: T | void, what: string): T => {
      if (result === undefined) throw new Error(`The admin API did not return ${what}.`);
      return result;
    };
    return {
      createTool: async (payload) =>
        requireResult(await api.createToolConfig!(data.me.id, payload, mutationContext), "the saved tool"),
      updateTool: async (toolId, payload) =>
        requireResult(await api.updateToolConfig!(data.me.id, toolId, payload, mutationContext), "the saved tool"),
      previewScript: async (payload) =>
        requireResult(await api.previewToolScript!(data.me.id, payload, mutationContext), "the test result"),
    };
  }, [adminApi, data.me.id, mutationContext]);
  const filterDialogModel = filterModelId
    ? (data.models.find((model) => model.id === filterModelId) ?? null)
    : null;
  const listPromptActivity = adminApi?.listPromptActivity;
  const listThreadPromptActivity = adminApi?.listThreadPromptActivity;
  const listSecurityAlerts = adminApi?.listSecurityAlerts;
  const loadedModelCatalogKey = useRef<string | null>(null);
  const selectedGroup = data.groups.find((group) => group.id === selectedGroupId) ?? defaultGroupFor(data) ?? data.groups[0];
  const defaultGroup = defaultGroupFor(data);
  const roleOptions = assignableRoles(data.me);
  const pendingAccessRequests = useMemo(
    () => data.visibleUsers.filter((user) => user.access_request_status === "pending" && !user.active),
    [data.visibleUsers],
  );
  const accessApprovalRoles = useMemo<Array<"USER" | "TEMP_USER" | "TENANT_ADMIN">>(
    () => [
      "USER",
      "TEMP_USER",
      ...(data.me.role === "PLATFORM_OWNER" || data.platformSettings?.tenant_admins_can_create_admins
        ? (["TENANT_ADMIN"] as const)
        : []),
    ],
    [data.me.role, data.platformSettings?.tenant_admins_can_create_admins],
  );
  const pendingUserCount = useMemo(
    () => data.visibleUsers.filter((user) => user.access_request_status !== "pending" && isPendingPlatformUser(user)).length,
    [data.visibleUsers],
  );
  const adminVisibleModels = useMemo(() => data.models.filter((model) => model.platform_enabled), [data.models]);
  const modelAccessSearchTerm = modelAccessSearch.trim().toLowerCase();
  const activeModelCount = useMemo(
    () => adminVisibleModels.filter((model) => model.group_ids.length > 0).length,
    [adminVisibleModels],
  );
  const modelRouteTerm = modelRouteFilter.trim().toLowerCase();
  const modelAccessFacetBaseModels = useMemo(() => {
    const statusModels =
      modelStatusFilter === "all"
        ? adminVisibleModels
        : adminVisibleModels.filter((model) => (model.group_ids.length > 0) === (modelStatusFilter === "enabled"));
    const matchingModels = modelAccessSearchTerm
      ? statusModels.filter((model) => modelNameMatchesSearch(model, modelAccessSearchTerm))
      : statusModels;
    return modelRouteTerm
      ? matchingModels.filter((model) =>
          (model.upstream_model_id ?? model.name).toLowerCase().includes(modelRouteTerm),
        )
      : matchingModels;
  }, [adminVisibleModels, modelAccessSearchTerm, modelRouteTerm, modelStatusFilter]);
  const modelProviderOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const model of modelAccessFacetBaseModels) {
      if (modelLabFilter.length > 0 && !modelLabFilter.includes(modelLabLabel(model))) continue;
      counts.set(model.provider_name, (counts.get(model.provider_name) ?? 0) + 1);
    }
    for (const value of modelProviderFilter) {
      if (!counts.has(value)) counts.set(value, 0);
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }, [modelAccessFacetBaseModels, modelLabFilter, modelProviderFilter]);
  const modelLabOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const model of modelAccessFacetBaseModels) {
      if (modelProviderFilter.length > 0 && !modelProviderFilter.includes(model.provider_name)) continue;
      const lab = modelLabLabel(model);
      counts.set(lab, (counts.get(lab) ?? 0) + 1);
    }
    for (const value of modelLabFilter) {
      if (!counts.has(value)) counts.set(value, 0);
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }, [modelAccessFacetBaseModels, modelProviderFilter, modelLabFilter]);
  const filteredAdminVisibleModels = useMemo(
    () =>
      modelAccessFacetBaseModels.filter(
        (model) =>
          (modelProviderFilter.length === 0 || modelProviderFilter.includes(model.provider_name)) &&
          (modelLabFilter.length === 0 || modelLabFilter.includes(modelLabLabel(model))),
      ),
    [modelAccessFacetBaseModels, modelProviderFilter, modelLabFilter],
  );
  const hasModelAccessGroups = data.groups.length > 0;
  const displayedUsers = useMemo(() => {
    // Defense in depth: platform owners are filtered server-side, but never render
    // them in the tenant user list even if a stale payload includes one.
    const tenantUsers = data.visibleUsers.filter(
      (user) => user.role !== "PLATFORM_OWNER" && user.access_request_status !== "pending",
    );
    return userGroupFilter === "all"
      ? tenantUsers
      : tenantUsers.filter((user) => user.group_ids.includes(userGroupFilter));
  }, [data.visibleUsers, userGroupFilter]);
  const adminTabs = useMemo(
    () => [
      "Users",
      "Groups",
      "Model Access",
      "Connections",
      "SSO",
      "Analytics",
      "Policies",
      "Audit",
      "Alerts",
    ],
    [],
  );
  const adminAuditUsers = useMemo(
    () =>
      [...data.visibleUsers]
        .filter(
          (user) =>
            user.role !== "PLATFORM_OWNER" &&
            (data.me.role === "PLATFORM_OWNER" || user.id === data.me.id || user.role !== "TENANT_ADMIN"),
        )
        .sort((a, b) => a.display_name.localeCompare(b.display_name) || a.email.localeCompare(b.email)),
    [data.me.id, data.me.role, data.visibleUsers],
  );
  const adminVisibleUserIds = useMemo(() => new Set(adminAuditUsers.map((user) => user.id)), [adminAuditUsers]);
  const adminAuditUserOptions = useMemo(
    () => adminAuditUsers.map((user) => ({ id: user.id, label: user.display_name || user.email })),
    [adminAuditUsers],
  );
  const promptScopeUser = promptScope.userId === "all"
    ? null
    : adminAuditUsers.find((user) => user.id === promptScope.userId) ?? null;
  const usageScopeUser = usageScope.userId === "all"
    ? null
    : adminAuditUsers.find((user) => user.id === usageScope.userId) ?? null;
  const selectedUsageUserParam = usageScope.userId === "all" ? undefined : usageScope.userId;
  const adminVisibleAuditTrailRows = useMemo(
    () => (auditTrail ?? []).filter((item) => item.actor_role !== "PLATFORM_OWNER"),
    [auditTrail],
  );
  const runtimeAuditRows = useMemo(
    () => adminRuntimeAuditRows(adminVisibleAuditTrailRows),
    [adminVisibleAuditTrailRows],
  );
  const filteredRuntimeAuditRows = useMemo(
    () => runtimeAuditRows.filter((item) => sectionScopeMatch(runtimeScope, item.executedAt, item.actorId)),
    [runtimeScope, runtimeAuditRows],
  );
  // Server records (every user and device) win; the browser-local trail is
  // a fallback when the endpoint is not connected.
  const feedbackSource: FeedbackDisplayItem[] = serverFeedback ?? chatFeedback;
  const scopedChatFeedback = useMemo(
    () => feedbackSource.filter((item) => adminVisibleUserIds.has(item.user_id)),
    [adminVisibleUserIds, feedbackSource],
  );
  const filteredChatFeedback = useMemo(
    () => scopedChatFeedback.filter((item) => sectionScopeMatch(feedbackScope, item.created_at, item.user_id)),
    [feedbackScope, scopedChatFeedback],
  );
  const positiveFeedback = filteredChatFeedback.filter((item) => item.rating === "positive");
  const negativeFeedback = filteredChatFeedback.filter((item) => item.rating === "negative");
  const scopedIssueReports = useMemo(
    () => issueReports.filter((item) => adminVisibleUserIds.has(item.user_id)),
    [adminVisibleUserIds, issueReports],
  );
  const filteredIssueReports = useMemo(
    () => scopedIssueReports.filter((item) => sectionScopeMatch(feedbackScope, item.created_at, item.user_id)),
    [feedbackScope, scopedIssueReports],
  );
  const chatRuntimeRows = filteredRuntimeAuditRows.filter((item) => item.surface === "chat");
  const draftRuntimeRows = filteredRuntimeAuditRows.filter((item) => item.surface === "draft");
  const promptActivityRows = useMemo(
    () => (promptActivity ?? []).filter((item) => adminVisibleUserIds.has(item.user_id)),
    [adminVisibleUserIds, promptActivity],
  );
  const securityAlertRows = useMemo(
    () => (securityAlerts ?? []).filter((item) => adminVisibleUserIds.has(item.user_id)),
    [adminVisibleUserIds, securityAlerts],
  );
  const analyticsPromptActivityRows = useMemo(
    () =>
      promptActivityRows.filter((item) =>
        sectionScopeMatch(activityScope, item.created_at_iso || item.created_at, item.user_id),
      ),
    [activityScope, promptActivityRows],
  );
  const auditPromptActivityRows = useMemo(
    () =>
      promptActivityRows.filter((item) =>
        sectionScopeMatch(promptScope, item.created_at_iso || item.created_at, item.user_id),
      ),
    [promptScope, promptActivityRows],
  );
  const auditSecurityAlerts = useMemo(
    () => securityAlertRows.filter((item) => sectionScopeMatch(securityScope, item.created_at, item.user_id)),
    [securityScope, securityAlertRows],
  );
  const auditTrailRows = useMemo(
    () => adminVisibleAuditTrailRows.filter((item) => sectionScopeMatch(trailScope, item.created_at, item.actor_id)),
    [adminVisibleAuditTrailRows, trailScope],
  );
  const usageRecordsInScope = useMemo(
    () =>
      usageRecords.filter((record) =>
        timestampInDateRange(record.created_at, usageScope.fromDate, usageScope.throughDate),
      ),
    [usageRecords, usageScope],
  );
  const auditNamespaceOptions = useMemo(() => {
    const namespaces = new Set<string>();
    for (const event of auditTrailRows) namespaces.add(event.action.split(".")[0]);
    return [...namespaces].sort();
  }, [auditTrailRows]);
  const visibleAuditTrailRows = useMemo(
    () =>
      auditTrailRows.filter(
        (event) =>
          (auditSeverityFilter === "all" || auditEventSeverity(event) === auditSeverityFilter) &&
          (auditNamespaceFilter === "all" || event.action.split(".")[0] === auditNamespaceFilter) &&
          matchesAuditSearch(event, auditSearchQuery),
      ),
    [auditNamespaceFilter, auditSearchQuery, auditSeverityFilter, auditTrailRows],
  );
  const alertsApi = useMemo<AlertsConsoleApi | undefined>(() => {
    const api = adminApi;
    if (
      !api?.listAlertRules ||
      !api.createAlertRule ||
      !api.updateAlertRule ||
      !api.deleteAlertRule ||
      !api.listAlertNotifications
    ) {
      return undefined;
    }
    return {
      listRules: () => api.listAlertRules!(data.me.id, mutationContext),
      createRule: (payload: AlertRuleCreateRequest) => api.createAlertRule!(data.me.id, payload, mutationContext),
      updateRule: (ruleId: string, patch: AlertRuleUpdateRequest) =>
        api.updateAlertRule!(data.me.id, ruleId, patch, mutationContext),
      deleteRule: (ruleId: string) => api.deleteAlertRule!(data.me.id, ruleId, mutationContext),
      listNotifications: () => api.listAlertNotifications!(data.me.id, mutationContext),
      setNotificationArchived: api.setAlertNotificationArchived
        ? (notificationId: string, archived: boolean) =>
            api.setAlertNotificationArchived!(data.me.id, notificationId, archived, mutationContext)
        : undefined,
      getEmailStatus: api.getAlertEmailStatus
        ? () => api.getAlertEmailStatus!(data.me.id, mutationContext)
        : undefined,
    };
  }, [adminApi, data.me.id, mutationContext]);
  const alertActorOptions = useMemo(
    () => adminAuditUsers.map((user) => ({ id: user.id, label: user.display_name || user.email })),
    [adminAuditUsers],
  );
  const usageTrendRows = useMemo(
    () =>
      (usageSummary?.by_day ?? []).slice(-10).map((row) => ({
        dateKey: row.date,
        count: row.message_count,
        label: formatPromptTrendDate(row.date),
      })),
    [usageSummary],
  );
  const usageTrendLinePoints = useMemo(() => promptUsageTrendPoints(usageTrendRows), [usageTrendRows]);
  const usageModelBarRows = useMemo(() => {
    const rows = usageSummary?.by_model ?? [];
    const maxCount = Math.max(...rows.map((row) => row.message_count), 1);
    return rows.slice(0, 8).map((row) => ({ ...row, share: Math.round((row.message_count / maxCount) * 100) }));
  }, [usageSummary]);
  const promptActivityExportLabel = promptScopeUser
    ? `${promptScopeUser.display_name} prompt activity`
    : "all admin and user prompt activity";
  const promptActivityFilename = `aperture-admin-prompt-activity-${
    promptScopeUser ? csvFilenamePart(promptScopeUser.display_name || promptScopeUser.id) : "all-admin-users"
  }`;
  const modelActivityRows = useMemo(() => buildPromptModelActivityRows(analyticsPromptActivityRows), [analyticsPromptActivityRows]);
  const promptUsageTrendRows = useMemo(() => buildPromptUsageTrendRows(analyticsPromptActivityRows), [analyticsPromptActivityRows]);
  const promptUserRows = useMemo(() => buildPromptUserRows(analyticsPromptActivityRows), [analyticsPromptActivityRows]);
  const modelActivityLinePoints = useMemo(
    () => promptUsageTrendPoints(promptUsageTrendRows),
    [promptUsageTrendRows],
  );
  const unacknowledgedSecurityAlerts = auditSecurityAlerts.filter((alert) => !alert.acknowledged);
  const adminAuditSummary = useMemo(
    () => adminAuditSummaryCards(data, securityAlertRows, adminVisibleAuditTrailRows, promptActivityRows),
    [securityAlertRows, adminVisibleAuditTrailRows, data, promptActivityRows],
  );

  useEffect(() => {
    if (!openDocumentationRequestKey) return;
    setShowDocumentation(true);
  }, [openDocumentationRequestKey]);

  useEffect(() => {
    function refreshFeedback() {
      setChatFeedback(loadChatFeedback());
      setFeedbackRefreshTick((tick) => tick + 1);
    }
    window.addEventListener(CHAT_FEEDBACK_UPDATED_EVENT, refreshFeedback);
    return () => window.removeEventListener(CHAT_FEEDBACK_UPDATED_EVENT, refreshFeedback);
  }, []);

  useEffect(() => {
    const listChatFeedback = adminApi?.listChatFeedback;
    if (!listChatFeedback) return;
    let active = true;
    Promise.resolve(listChatFeedback(data.me.id, mutationContext))
      .then((records) => {
        if (active && records) setServerFeedback(records);
      })
      .catch(() => {
        // Server sentiment is additive; the browser-local view still renders.
      });
    return () => {
      active = false;
    };
  }, [adminApi?.listChatFeedback, auditTrailRefreshToken, data.me, feedbackRefreshTick, mutationContext]);

  useEffect(() => {
    const listIssueReports = adminApi?.listIssueReports;
    if (!listIssueReports) return;
    let active = true;
    Promise.resolve(listIssueReports(data.me.id, mutationContext))
      .then((records) => {
        if (active && records) setIssueReports(records);
      })
      .catch(() => {
        // Issue reporting is additive to analytics; other panels stay usable.
      });
    return () => {
      active = false;
    };
  }, [adminApi?.listIssueReports, auditTrailRefreshToken, data.me, mutationContext]);

  useEffect(() => {
    const listAuditEvents = adminApi?.listAuditEvents;
    if (!listAuditEvents) return;
    let active = true;
    listAuditEvents(data.me.id, { actor: data.me, tenantId: data.currentTenant.id })
      .then((events) => {
        if (!active || !events) return;
        setAuditTrail(events);
        setAuditTrailError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setAuditTrailError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [adminApi?.listAuditEvents, data.currentTenant.id, data.me, auditTrailRefreshToken]);

  useEffect(() => {
    const listPromptActivity = adminApi?.listPromptActivity;
    if (!listPromptActivity) return;
    let active = true;
    Promise.resolve(listPromptActivity(data.me.id, undefined, mutationContext))
      .then((records) => {
        if (!active || !records) return;
        setPromptActivity(records);
        setPromptActivityError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setPromptActivityError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [adminApi?.listPromptActivity, auditTrailRefreshToken, data.me, mutationContext]);

  useEffect(() => {
    const listSecurityAlerts = adminApi?.listSecurityAlerts;
    if (!listSecurityAlerts) return;
    let active = true;
    Promise.resolve(listSecurityAlerts(data.me.id, undefined, mutationContext))
      .then((alerts) => {
        if (!active || !alerts) return;
        setSecurityAlerts(alerts);
        setSecurityAlertsError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setSecurityAlertsError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [adminApi?.listSecurityAlerts, auditTrailRefreshToken, data.me, mutationContext]);

  useEffect(() => {
    const getUsageSummary = adminApi?.getUsageSummary;
    if (!getUsageSummary) return;
    let active = true;
    Promise.resolve(
      getUsageSummary(
        data.me.id,
        {
          targetUserId: selectedUsageUserParam,
          fromDate: usageScope.fromDate || undefined,
          throughDate: usageScope.throughDate || undefined,
        },
        mutationContext,
      ),
    )
      .then((summary) => {
        if (!active || !summary) return;
        setUsageSummary(summary);
        setUsageError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setUsageError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [
    adminApi?.getUsageSummary,
    auditTrailRefreshToken,
    data.me,
    mutationContext,
    selectedUsageUserParam,
    usageScope,
  ]);

  useEffect(() => {
    const listUsageRecords = adminApi?.listUsageRecords;
    if (!listUsageRecords) return;
    let active = true;
    Promise.resolve(listUsageRecords(data.me.id, selectedUsageUserParam, mutationContext))
      .then((records) => {
        if (!active || !records) return;
        setUsageRecords(records);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setUsageError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [adminApi?.listUsageRecords, auditTrailRefreshToken, data.me, mutationContext, selectedUsageUserParam]);

  useEffect(() => {
    if (!memoryTabVisible) return;
    const getMemoryPolicy = adminApi?.getMemoryPolicy;
    const getMemoryStats = adminApi?.getMemoryStats;
    if (!getMemoryPolicy && !getMemoryStats) return;
    let active = true;
    Promise.all([
      getMemoryPolicy ? getMemoryPolicy(data.me.id, mutationContext) : Promise.resolve(undefined),
      getMemoryStats ? getMemoryStats(data.me.id, mutationContext) : Promise.resolve(undefined),
    ])
      .then(([policy, stats]) => {
        if (!active) return;
        if (policy) setMemoryPolicy(policy);
        if (stats) setMemoryStats(stats);
        setMemoryError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setMemoryError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [
    adminApi?.getMemoryPolicy,
    adminApi?.getMemoryStats,
    data.me,
    memoryRefreshToken,
    memoryTabVisible,
    mutationContext,
  ]);

  useEffect(() => {
    const getRetentionPolicy = adminApi?.getRetentionPolicy;
    const listRetentionThreads = adminApi?.listRetentionThreads;
    if (!getRetentionPolicy && !listRetentionThreads) return;
    let active = true;
    Promise.all([
      getRetentionPolicy ? getRetentionPolicy(data.me.id, mutationContext) : Promise.resolve(undefined),
      listRetentionThreads
        ? listRetentionThreads(data.me.id, mutationContext)
        : Promise.resolve(undefined),
    ])
      .then(([policy, tagged]) => {
        if (!active) return;
        if (policy) setRetentionPolicy(policy);
        if (tagged) setRetentionTagged(tagged);
        setRetentionError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setRetentionError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [
    adminApi?.getRetentionPolicy,
    adminApi?.listRetentionThreads,
    data.me,
    retentionRefreshToken,
    mutationContext,
  ]);

  useEffect(() => {
    const listModelAccess = adminApi?.listModelAccess;
    const loadKey = `${data.me.id}:${data.currentTenant.id}`;
    if (!listModelAccess || loadedModelCatalogKey.current === loadKey) return;
    loadedModelCatalogKey.current = loadKey;
    let active = true;
    listModelAccess(data.me.id, { actor: data.me, tenantId: data.currentTenant.id })
      .then((models) => {
        if (!active || !models) return;
        onDataChange((current) => ({
          ...current,
          models: mergeSyncedModelCatalog(current.models, models),
        }));
      })
      .catch(() => {
        loadedModelCatalogKey.current = null;
      });
    return () => {
      active = false;
    };
  }, [adminApi?.listModelAccess, data.currentTenant.id, data.me, onDataChange]);

  useEffect(() => {
    if (!openModelColumnFilter) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".model-column-filter")) return;
      setOpenModelColumnFilter(null);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenModelColumnFilter(null);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openModelColumnFilter]);

  async function runAdminMutation<T>({
    pendingKey,
    helper,
    optimistic,
    reconcile,
    localMessage,
    syncMessage,
    successMessage,
    failureMessage,
  }: AdminMutationOptions<T>) {
    // These controls govern real access. A toggle that stays flipped after the
    // server refused the change tells an administrator that a permission was
    // granted when it was not, so every failure path restores what the server
    // actually holds.
    const snapshot = dataRef.current;
    const revert = () => onDataChange(() => snapshot);

    optimistic();
    if (!helper) {
      revert();
      setActionStatus({ tone: "danger", message: localMessage });
      return;
    }

    setPendingAction(pendingKey);
    setActionStatus({ tone: "info", message: syncMessage });
    try {
      const result = await helper();
      if (result) reconcile?.(result);
      setActionStatus({ tone: "success", message: successMessage });
    } catch (error) {
      revert();
      setActionStatus({
        tone: "danger",
        message: `${failureMessage} ${errorMessage(error)} Nothing was changed.`,
      });
    } finally {
      setPendingAction((current) => (current === pendingKey ? null : current));
    }
  }

  function applyUserPatch(userId: string, patch: Partial<User>) {
    onDataChange((current) => ({
      ...current,
      users: current.users.map((user) => (user.id === userId ? { ...user, ...patch } : user)),
      visibleUsers: current.visibleUsers.map((user) => (user.id === userId ? { ...user, ...patch } : user)),
    }));
  }

  function applyGroupPatch(groupId: string, patch: Partial<Group>) {
    onDataChange((current) => ({
      ...current,
      groups: current.groups.map((group) => (group.id === groupId ? { ...group, ...patch } : group)),
    }));
  }

  function applyConnectorPatch(connectorId: string, patch: Partial<Connector>) {
    onDataChange((current) => ({
      ...current,
      connectors: current.connectors.map((connector) =>
        connector.id === connectorId ? { ...connector, ...patch } : connector,
      ),
    }));
  }

  function applyToolPatch(toolId: string, patch: Partial<ToolConfig>) {
    onDataChange((current) => ({
      ...current,
      tools: current.tools.map((tool) => (tool.id === toolId ? { ...tool, ...patch } : tool)),
    }));
  }

  function applySsoPatch(configId: string, patch: Partial<SsoConfig>) {
    onDataChange((current) => ({
      ...current,
      ssoConfigs: current.ssoConfigs.map((config) => (config.id === configId ? { ...config, ...patch } : config)),
    }));
  }

  async function addUser() {
    const email = invite.email.trim();
    const name = invite.name.trim() || email.split("@")[0] || "New User";
    if (!email) return;
    if (!selectedGroup) {
      setActionStatus({
        tone: "warning",
        message: "Pick a starting group first — create one on the Groups tab if none exist yet.",
      });
      return;
    }
    const payload: AdminUserCreateInput = {
      tenant_id: data.currentTenant.id,
      email,
      display_name: name,
      role: invite.role,
      group_ids: [selectedGroup.id],
      active: true,
    };
    const createUser = adminApi?.createUser;

    if (!createUser) {
      setActionStatus({ tone: "danger", message: "User was not created because the admin user API is not connected." });
      return;
    }

    setPendingAction("add-user");
    setActionStatus({ tone: "info", message: "Creating user through the admin API..." });
    try {
      const createdUser = await createUser(data.me.id, payload, mutationContext);
      if (!createdUser) throw new Error("The admin API did not return the created user.");
      onDataChange((current) => ({
        ...current,
        users: upsertUsers(current.users, createdUser),
        visibleUsers: upsertUsers(current.visibleUsers, createdUser),
        groups: current.groups.map((group) =>
          group.id === selectedGroup.id ? { ...group, user_count: group.user_count + 1 } : group,
        ),
      }));
      setInvite({ name: "", email: "", role: "USER" });
      setShowInvite(false);
      setActionStatus({ tone: "success", message: `${createdUser.display_name} was created through the admin API.` });
    } catch (error) {
      setActionStatus({
        tone: "danger",
        message: `User was not created. ${errorMessage(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function approveAccessRequest(target: User) {
    const approve = adminApi?.approveAccessRequest;
    if (!approve) {
      setActionStatus({ tone: "danger", message: "Access requests cannot be approved because the admin API is not connected." });
      return;
    }
    const role = accessReviewRoles[target.id] ?? "USER";
    setPendingAction(`approve-access-${target.id}`);
    setActionStatus({ tone: "info", message: `Approving ${target.display_name}'s access request...` });
    try {
      const approved = await approve(data.me.id, target.id, role, mutationContext);
      if (!approved) throw new Error("The admin API did not return the approved account.");
      onDataChange((current) => ({
        ...current,
        users: upsertUsers(current.users, approved),
        visibleUsers: upsertUsers(current.visibleUsers, approved),
        groups: current.groups.map((group) =>
          approved.group_ids.includes(group.id) ? { ...group, user_count: group.user_count + 1 } : group,
        ),
      }));
      setActionStatus({
        tone: "success",
        message:
          role === "TEMP_USER"
            ? `${approved.display_name} was approved as a Temp User with Luna-only access and a 30,000-token grant.`
            : `${approved.display_name} was approved as ${ROLE_LABELS[role]}.`,
      });
    } catch (error) {
      setActionStatus({ tone: "danger", message: `Access was not approved. ${errorMessage(error)}` });
    } finally {
      setPendingAction(null);
    }
  }

  async function declineAccessRequest(target: User) {
    const decline = adminApi?.declineAccessRequest;
    if (!decline) {
      setActionStatus({ tone: "danger", message: "Access requests cannot be declined because the admin API is not connected." });
      return;
    }
    setPendingAction(`decline-access-${target.id}`);
    try {
      await decline(data.me.id, target.id, mutationContext);
      onDataChange((current) => ({
        ...current,
        users: current.users.filter((user) => user.id !== target.id),
        visibleUsers: current.visibleUsers.filter((user) => user.id !== target.id),
      }));
      setActionStatus({ tone: "success", message: `${target.display_name}'s access request was declined.` });
    } catch (error) {
      setActionStatus({ tone: "danger", message: `The request was not declined. ${errorMessage(error)}` });
    } finally {
      setPendingAction(null);
    }
  }

  /* Mirrors the API's scoping: owners may set any non-owner password; admins
   * only regular users' — never other admins, owners, or themselves. */
  function passwordResetAllowed(target: User): boolean {
    if (target.id === data.me.id || target.role === "PLATFORM_OWNER" || !target.active) return false;
    if (data.me.role === "PLATFORM_OWNER") return true;
    return data.me.role === "TENANT_ADMIN" && ROLE_ORDER.includes(target.role);
  }

  async function resetPassword(target: User, password: string, temporary: boolean) {
    const resetUserPassword = adminApi?.resetUserPassword;
    if (!resetUserPassword) {
      throw new Error("The admin password API is not connected.");
    }
    await resetUserPassword(data.me.id, target.id, { password, temporary }, mutationContext);
    // The API flips the account to local sign-in so the password is usable.
    onDataChange((current) => ({
      ...current,
      users: current.users.map((user) => (user.id === target.id ? { ...user, auth_method: "local" } : user)),
      visibleUsers: current.visibleUsers.map((user) =>
        user.id === target.id ? { ...user, auth_method: "local" } : user,
      ),
    }));
    setActionStatus({
      tone: "success",
      message: `${target.display_name}'s ${temporary ? "temporary " : ""}password was set through the admin API.`,
    });
  }

  async function deactivateSelected() {
    const targetUsers = data.visibleUsers.filter(
      (user) => selectedUserIds.includes(user.id) && user.active && canModifyUser(data.me, user),
    );
    if (targetUsers.length === 0) return;
    const selected = new Set(targetUsers.map((user) => user.id));
    const deactivateUser = adminApi?.deactivateUser;

    if (!deactivateUser) {
      setActionStatus({ tone: "danger", message: "Selected users were not deactivated because the admin user API is not connected." });
      return;
    }

    setPendingAction("deactivate-users");
    setActionStatus({ tone: "info", message: "Deactivating selected users through the admin API..." });
    try {
      const results = await Promise.all(targetUsers.map((user) => deactivateUser(data.me.id, user.id, mutationContext)));
      const returnedUsers = results.filter((user): user is User => Boolean(user));
      onDataChange((current) => ({
        ...current,
        users: current.users.map((user) => {
          const remoteUser = returnedUsers.find((item) => item.id === user.id);
          if (remoteUser) return { ...user, ...remoteUser };
          return selected.has(user.id) ? { ...user, active: false } : user;
        }),
        visibleUsers: current.visibleUsers.map((user) => {
          const remoteUser = returnedUsers.find((item) => item.id === user.id);
          if (remoteUser) return { ...user, ...remoteUser };
          return selected.has(user.id) ? { ...user, active: false } : user;
        }),
      }));
      setSelectedUserIds([]);
      setActionStatus({ tone: "success", message: "Selected users were deactivated through the admin API." });
    } catch (error) {
      setActionStatus({
        tone: "danger",
        message: `Selected users were not deactivated. ${errorMessage(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function updateUser(user: User, patch: AdminUserUpdateInput) {
    const updateUserRecord = adminApi?.updateUser;
    if (!updateUserRecord) {
      setActionStatus({ tone: "danger", message: "User was not updated because the admin user API is not connected." });
      return;
    }
    setPendingAction(`user-${user.id}`);
    setActionStatus({ tone: "info", message: "Syncing user update through the admin API..." });
    try {
      const remoteUser = await updateUserRecord(data.me.id, user.id, patch, mutationContext);
      applyUserPatch(user.id, remoteUser ?? patch);
      setActionStatus({ tone: "success", message: `${user.display_name} was updated through the admin API.` });
    } catch (error) {
      setActionStatus({
        tone: "danger",
        message: `${user.display_name} was not updated. ${errorMessage(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function deleteUserAccount(user: User) {
    const deleteUser = adminApi?.deleteUser;
    if (!deleteUser) {
      setActionStatus({ tone: "danger", message: "User was not deleted because the admin user API is not connected." });
      return;
    }
    setPendingAction(`user-${user.id}`);
    setActionStatus({ tone: "info", message: `Deleting ${user.display_name} through the admin API...` });
    try {
      await deleteUser(data.me.id, user.id, mutationContext);
      onDataChange((current) => ({
        ...current,
        users: current.users.filter((item) => item.id !== user.id),
        visibleUsers: current.visibleUsers.filter((item) => item.id !== user.id),
      }));
      setSelectedUserIds((current) => current.filter((id) => id !== user.id));
      setActionStatus({ tone: "success", message: `${user.display_name} was permanently deleted.` });
    } catch (error) {
      setActionStatus({
        tone: "danger",
        message: `${user.display_name} was not deleted. ${errorMessage(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function addGroup() {
    const name = groupDraft.name.trim();
    if (!name) {
      setActionStatus({ tone: "warning", message: "Group name is required before creating a group." });
      return;
    }
    const createGroup = adminApi?.createGroup;
    if (!createGroup) {
      setActionStatus({ tone: "danger", message: "Group was not created because the admin group API is not connected." });
      return;
    }
    setPendingAction("create-group");
    setActionStatus({ tone: "info", message: "Creating platform group through the admin API..." });
    try {
      const createdGroup = await createGroup(
        data.me.id,
        { ...groupDraft, name, tenant_id: data.currentTenant.id },
        mutationContext,
      );
      if (!createdGroup) throw new Error("The admin API did not return the created group.");
      onDataChange((current) => ({ ...current, groups: upsertGroups(current.groups, createdGroup) }));
      setSelectedGroupId(createdGroup.id);
      setGroupDraft(emptyGroupDraft(data.currentTenant.id));
      setShowGroupCreate(false);
      setActionStatus({ tone: "success", message: `${createdGroup.name} was added as a platform group.` });
    } catch (error) {
      setActionStatus({ tone: "danger", message: `Group was not created. ${errorMessage(error)}` });
    } finally {
      setPendingAction(null);
    }
  }

  async function removeGroup(groupId: string) {
    const group = data.groups.find((item) => item.id === groupId);
    if (group?.default_group) {
      setActionStatus({
        tone: "warning",
        message: "Default Users is protected by organization policy and cannot be removed.",
      });
      return;
    }
    const deleteGroup = adminApi?.deleteGroup;
    if (!group || !deleteGroup) {
      setActionStatus({ tone: "danger", message: "Group was not removed because the admin group API is not connected." });
      return;
    }
    setPendingAction(`delete-group-${group.id}`);
    setActionStatus({ tone: "info", message: `Removing ${group.name} through the admin API...` });
    try {
      await deleteGroup(data.me.id, group.id, mutationContext);
      removeGroupsFromState([group.id]);
      setActionStatus({ tone: "success", message: `${group.name} was removed from platform groups.` });
    } catch (error) {
      setActionStatus({ tone: "danger", message: `${group.name} was not removed. ${errorMessage(error)}` });
    } finally {
      setPendingAction(null);
    }
  }

  async function removeSelectedGroups() {
    const groupIds = selectedGroupIdsForRemoval.filter((groupId) =>
      data.groups.some((group) => group.id === groupId && !group.default_group),
    );
    if (!groupIds.length) return;
    const deleteGroups = adminApi?.deleteGroups;
    if (!deleteGroups) {
      setActionStatus({ tone: "danger", message: "Selected groups were not removed because the admin group API is not connected." });
      return;
    }
    setPendingAction("delete-groups");
    setActionStatus({ tone: "info", message: `Removing ${groupIds.length} selected groups through the admin API...` });
    try {
      const deletedGroupIds = await deleteGroups(data.me.id, groupIds, mutationContext);
      removeGroupsFromState(deletedGroupIds?.length ? deletedGroupIds : groupIds);
      setActionStatus({ tone: "success", message: `Removed ${groupIds.length} platform group${groupIds.length === 1 ? "" : "s"}.` });
    } catch (error) {
      setActionStatus({ tone: "danger", message: `Selected groups were not removed. ${errorMessage(error)}` });
    } finally {
      setPendingAction(null);
    }
  }

  function removeGroupsFromState(groupIds: string[]) {
    const groupIdSet = new Set(groupIds);
    onDataChange((current) => removeGroupsFromBootstrap(current, groupIdSet));
    setSelectedGroupIdsForRemoval((current) => current.filter((groupId) => !groupIdSet.has(groupId)));
    if (groupIdSet.has(selectedGroupId)) {
      const nextGroup = data.groups.find((group) => !groupIdSet.has(group.id));
      setSelectedGroupId(nextGroup?.id ?? "");
    }
    if (userGroupFilter !== "all" && groupIdSet.has(userGroupFilter)) {
      setUserGroupFilter("all");
    }
  }

  function toggleGroupSelectionForRemoval(groupId: string, selected: boolean) {
    const group = data.groups.find((item) => item.id === groupId);
    if (group?.default_group) return;
    setSelectedGroupIdsForRemoval((current) => {
      if (selected) return current.includes(groupId) ? current : [...current, groupId];
      return current.filter((id) => id !== groupId);
    });
  }

  function toggleGroupPermission(key: string, next: boolean) {
    if (!selectedGroup) return;
    const updateGroup = adminApi?.updateGroup;
    const permissions = permissionsForGroup(selectedGroup, { [key]: next });
    void runAdminMutation<Group>({
      pendingKey: `group-permission-${selectedGroup.id}-${key}`,
      optimistic: () => applyGroupPatch(selectedGroup.id, { permissions }),
      helper: updateGroup ? () => updateGroup(data.me.id, selectedGroup.id, { permissions }, mutationContext) : undefined,
      reconcile: (remoteGroup) => applyGroupPatch(selectedGroup.id, remoteGroup),
      localMessage: `${selectedGroup.name} permissions were not changed: the admin group API is unavailable in this build.`,
      syncMessage: `Syncing ${selectedGroup.name} group permissions through the admin API...`,
      successMessage: `${selectedGroup.name} group permissions synced with the admin API.`,
      failureMessage: `${selectedGroup.name} group permissions could not sync.`,
    });
  }

  function toggleDefaultGroupPolicyPermission(key: string, next: boolean) {
    if (!defaultGroup) {
      setActionStatus({
        tone: "warning",
        message: "Default user access was not changed because this organization has no Default Users group.",
      });
      return;
    }
    const updateGroup = adminApi?.updateGroup;
    const permissions = permissionsForGroup(defaultGroup, { [key]: next });
    void runAdminMutation<Group>({
      pendingKey: `policy-default-group-${key}`,
      optimistic: () => applyGroupPatch(defaultGroup.id, { permissions }),
      helper: updateGroup
        ? () => updateGroup(data.me.id, defaultGroup.id, { permissions }, mutationContext)
        : undefined,
      reconcile: (remoteGroup) => applyGroupPatch(defaultGroup.id, remoteGroup),
      localMessage: `Default user ${key.replaceAll("_", " ")} access was not changed: the admin group API is unavailable in this build.`,
      syncMessage: "Saving the default user policy through the admin API...",
      successMessage: "Default user policy saved.",
      failureMessage: "Default user policy could not be saved.",
    });
  }

  async function setUserGroupMembership(user: User, group: Group, next: boolean) {
    const currentMembership = user.group_ids.includes(group.id);
    if (currentMembership === next) return;
    const updateUserRecord = adminApi?.updateUser;
    if (!updateUserRecord) {
      setActionStatus({ tone: "danger", message: "Group membership was not updated because the admin user API is not connected." });
      return;
    }
    const nextGroupIds = next
      ? Array.from(new Set([...user.group_ids, group.id]))
      : user.group_ids.filter((groupId) => groupId !== group.id);
    const pendingKey = `group-user-${group.id}-${user.id}`;
    setPendingAction(pendingKey);
    setActionStatus({ tone: "info", message: `Syncing ${user.display_name} group membership...` });
    try {
      const remoteUser = await updateUserRecord(data.me.id, user.id, { group_ids: nextGroupIds }, mutationContext);
      const updatedUser = remoteUser ?? { ...user, group_ids: nextGroupIds };
      onDataChange((current) => {
        const currentUser =
          current.visibleUsers.find((item) => item.id === user.id) ?? current.users.find((item) => item.id === user.id);
        const wasMember = currentUser?.group_ids.includes(group.id) ?? currentMembership;
        const isMember = updatedUser.group_ids.includes(group.id);
        const delta = wasMember === isMember ? 0 : isMember ? 1 : -1;
        return {
          ...current,
          users: current.users.map((item) => (item.id === updatedUser.id ? { ...item, ...updatedUser } : item)),
          visibleUsers: current.visibleUsers.map((item) =>
            item.id === updatedUser.id ? { ...item, ...updatedUser } : item,
          ),
          groups: current.groups.map((item) =>
            item.id === group.id ? { ...item, user_count: Math.max(0, item.user_count + delta) } : item,
          ),
        };
      });
      setActionStatus({ tone: "success", message: `${user.display_name} group membership synced with the admin API.` });
    } catch (error) {
      setActionStatus({ tone: "danger", message: `${user.display_name} group membership could not sync. ${errorMessage(error)}` });
    } finally {
      setPendingAction((current) => (current === pendingKey ? null : current));
    }
  }

  async function importUsersToGroup(group: Group) {
    const emails = parseBulkUserEmails(bulkUserText);
    if (!emails.length) {
      setActionStatus({ tone: "warning", message: "Paste at least one user email before importing users into the group." });
      return;
    }

    const emailSet = new Set(emails.map((email) => email.toLowerCase()));
    const matchingUsers = data.visibleUsers.filter(
      (user) => user.role !== "PLATFORM_OWNER" && emailSet.has(user.email.toLowerCase()) && canModifyUser(data.me, user),
    );
    const usersToAdd = matchingUsers.filter((user) => !user.group_ids.includes(group.id));
    const matchedEmails = new Set(matchingUsers.map((user) => user.email.toLowerCase()));
    const missingEmails = emails.filter((email) => !matchedEmails.has(email.toLowerCase()));

    if (!usersToAdd.length) {
      setActionStatus({
        tone: missingEmails.length ? "warning" : "info",
        message: missingEmails.length
          ? `No matching platform users were found for ${missingEmails.join(", ")}.`
          : `All pasted users are already in ${group.name}.`,
      });
      return;
    }

    const updateUserRecord = adminApi?.updateUser;
    if (!updateUserRecord) {
      setActionStatus({ tone: "danger", message: "Users were not imported because the admin user API is not connected." });
      return;
    }

    const pendingKey = `group-import-${group.id}`;
    setPendingAction(pendingKey);
    setActionStatus({ tone: "info", message: `Adding ${usersToAdd.length} user${usersToAdd.length === 1 ? "" : "s"} to ${group.name}...` });
    try {
      const updatedUsers = await Promise.all(
        usersToAdd.map((user) => {
          const groupIds = Array.from(new Set([...user.group_ids, group.id]));
          return updateUserRecord(data.me.id, user.id, { group_ids: groupIds }, mutationContext).then(
            (remoteUser) => remoteUser ?? { ...user, group_ids: groupIds },
          );
        }),
      );
      const updatedById = new Map(updatedUsers.map((user) => [user.id, user]));
      onDataChange((current) => {
        const nextUsers = current.users.map((user) => {
          const updatedUser = updatedById.get(user.id);
          return updatedUser ? { ...user, ...updatedUser } : user;
        });
        const nextVisibleUsers = current.visibleUsers.map((user) => {
          const updatedUser = updatedById.get(user.id);
          return updatedUser ? { ...user, ...updatedUser } : user;
        });
        const memberCount = nextVisibleUsers.filter(
          (user) => user.role !== "PLATFORM_OWNER" && user.group_ids.includes(group.id),
        ).length;
        return {
          ...current,
          users: nextUsers,
          visibleUsers: nextVisibleUsers,
          groups: current.groups.map((item) => (item.id === group.id ? { ...item, user_count: memberCount } : item)),
        };
      });
      setBulkUserText("");
      const skipped = missingEmails.length ? ` ${missingEmails.length} email${missingEmails.length === 1 ? " was" : "s were"} not found.` : "";
      setActionStatus({ tone: "success", message: `Added ${updatedUsers.length} user${updatedUsers.length === 1 ? "" : "s"} to ${group.name}.${skipped}` });
    } catch (error) {
      setActionStatus({ tone: "danger", message: `Users were not imported into ${group.name}. ${errorMessage(error)}` });
    } finally {
      setPendingAction((current) => (current === pendingKey ? null : current));
    }
  }

  function updateModelGroups(
    model: ModelConfig,
    nextGroupIds: string[],
    messages: { sync: string; success: string; failure: string },
  ) {
    const updateModelAccess = adminApi?.updateModelAccess;
    const groupIds = Array.from(new Set(nextGroupIds)).filter((groupId) => data.groups.some((group) => group.id === groupId));

    void runAdminMutation<ModelConfig>({
      pendingKey: `model-access-${model.id}`,
      optimistic: () =>
        onDataChange((current) => ({
          ...current,
          models: current.models.map((item) =>
            item.id === model.id ? { ...item, group_ids: groupIds, tenant_restricted: true } : item,
          ),
        })),
      helper: updateModelAccess
        ? () => updateModelAccess(data.me.id, model.id, { group_ids: groupIds }, { ...mutationContext, model })
        : undefined,
      reconcile: (remoteModel) =>
        onDataChange((current) => ({
          ...current,
          models: current.models.map((item) => (item.id === remoteModel.id ? { ...item, ...remoteModel } : item)),
        })),
      localMessage: `${model.name} grant was not changed: the model access API is unavailable in this build.`,
      syncMessage: messages.sync,
      successMessage: messages.success,
      failureMessage: messages.failure,
    });
  }

  function toggleModelUserAccess(model: ModelConfig, next: boolean) {
    if (next && !hasModelAccessGroups) {
      setActionStatus({
        tone: "warning",
        message: `Create a tenant group before enabling ${model.name}. Model access is granted through group membership.`,
      });
      return;
    }
    const groupIds = next ? [defaultGroup?.id ?? data.groups[0]?.id].filter((groupId): groupId is string => Boolean(groupId)) : [];
    updateModelGroups(model, groupIds, {
      sync: `Syncing ${model.name} user access...`,
      success: `${model.name} user access synced with the admin API.`,
      failure: `${model.name} user access could not sync.`,
    });
  }

  function setModelGroupGrant(model: ModelConfig, groupId: string, next: boolean) {
    const grants = new Set(model.group_ids);
    if (next) grants.add(groupId);
    else grants.delete(groupId);
    updateModelGroups(model, Array.from(grants), {
      sync: `Syncing ${model.name} group access...`,
      success: `${model.name} group access synced with the admin API.`,
      failure: `${model.name} group access could not sync.`,
    });
  }

  async function syncModelAccess() {
    const syncCatalog = adminApi?.syncModelAccess;
    if (!syncCatalog) {
      setActionStatus({ tone: "danger", message: "Model catalog sync is not connected to the admin API." });
      return;
    }
    setPendingAction("sync-model-access");
    setActionStatus({ tone: "info", message: "Syncing model catalog through the admin API..." });
    try {
      const syncedModels = await syncCatalog(data.me.id, mutationContext);
      if (!syncedModels) throw new Error("The admin API did not return a model catalog.");
      onDataChange((current) => ({
        ...current,
        models: mergeSyncedModelCatalog(current.models, syncedModels),
      }));
      setActionStatus({
        tone: "success",
        message: `Synced ${syncedModels.length} model${syncedModels.length === 1 ? "" : "s"} into Model Access.`,
      });
    } catch (error) {
      setActionStatus({ tone: "danger", message: `Model catalog did not sync. ${errorMessage(error)}` });
    } finally {
      setPendingAction(null);
    }
  }

  function handleFilterModelUpdated(updated: ModelConfig) {
    onDataChange((current) => ({
      ...current,
      models: current.models.map((item) =>
        item.id === updated.id ? { ...item, content_filter_ids: updated.content_filter_ids ?? [] } : item,
      ),
    }));
  }

  function handleCustomToolSaved(record: ToolConfigRecord) {
    const display = mapToolConfigRecordToDisplay(record);
    onDataChange((current) => {
      const exists = current.tools.some((tool) => tool.id === display.id);
      return {
        ...current,
        tools: exists
          ? current.tools.map((tool) => (tool.id === display.id ? display : tool))
          : [...current.tools, display],
      };
    });
    setActionStatus({ tone: "success", message: `${display.name} saved and available to models and chat.` });
  }

  async function deleteCustomTool(tool: ToolConfig) {
    const deleteTool = adminApi?.deleteToolConfig;
    if (!deleteTool) {
      setActionStatus({ tone: "danger", message: "Tool deletion is not connected to the admin API." });
      return;
    }
    setPendingAction(`tool-delete-${tool.id}`);
    try {
      await deleteTool(data.me.id, tool.id, mutationContext);
      onDataChange((current) => ({ ...current, tools: current.tools.filter((item) => item.id !== tool.id) }));
      setActionStatus({ tone: "success", message: `${tool.name} deleted.` });
    } catch (error) {
      setActionStatus({ tone: "danger", message: `${tool.name} could not be deleted. ${errorMessage(error)}` });
    } finally {
      setPendingAction(null);
    }
  }

  function toggleConnector(connector: Connector, next: boolean) {
    const setConnectorEnabled = adminApi?.setConnectorEnabled;
    void runAdminMutation<Partial<Connector>>({
      pendingKey: `connector-${connector.id}`,
      optimistic: () =>
        applyConnectorPatch(connector.id, {
          tenant_enabled: next,
          sync_status: next ? connector.sync_status ?? "idle" : "idle",
        }),
      helper: setConnectorEnabled
        ? () => setConnectorEnabled(data.me.id, connector.id, next, { ...mutationContext, connector })
        : undefined,
      reconcile: (remoteConnector) => applyConnectorPatch(connector.id, remoteConnector),
      localMessage: `${connector.name} was not changed: the connector API is unavailable in this build.`,
      syncMessage: `Syncing ${connector.name} connector state through the admin API...`,
      successMessage: `${connector.name} connector state synced with the admin API.`,
      failureMessage: `${connector.name} connector state could not sync.`,
    });
  }

  async function saveConnectorConfiguration(
    connector: Connector,
    payload: AdminConnectorConfigUpdateRequest & { connector_id: string },
  ) {
    const saveConnectorConfig = adminApi?.saveConnectorConfig;
    if (!saveConnectorConfig) {
      setActionStatus({
        tone: "warning",
        message: `${connector.name} settings were not saved; the connector config API is not connected.`,
      });
      return;
    }
    setPendingAction(`connector-config-${connector.id}`);
    setActionStatus({ tone: "info", message: `Saving ${connector.name} configuration...` });
    try {
      const result = await saveConnectorConfig(data.me.id, connector, payload, mutationContext);
      if (result) {
        applyConnectorPatch(connector.id, result.connector);
        onDataChange((current) => {
          const exists = current.connectorConfigs.some((record) => record.id === result.record.id);
          return {
            ...current,
            connectorConfigs: exists
              ? current.connectorConfigs.map((record) => (record.id === result.record.id ? result.record : record))
              : [...current.connectorConfigs, result.record],
          };
        });
      }
      setActionStatus({ tone: "success", message: `${connector.name} configuration saved through the admin API.` });
    } catch (error) {
      setActionStatus({
        tone: "danger",
        message: `${connector.name} configuration was not saved: ${errorMessage(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function testConnectorConfiguration(connector: Connector) {
    const testConnectorConfig = adminApi?.testConnectorConfig;
    const configId = connector.tenant_config_id;
    if (!testConnectorConfig || !configId) {
      setActionStatus({
        tone: "warning",
        message: configId
          ? "The connector test API is not connected in this session."
          : `Save the ${connector.name} configuration first, then test the connection.`,
      });
      return;
    }
    setPendingAction(`connector-test-${connector.id}`);
    setConnectorTestResults((current) => {
      const next = { ...current };
      delete next[connector.id];
      return next;
    });
    try {
      const result = await testConnectorConfig(data.me.id, configId, mutationContext);
      if (result) {
        setConnectorTestResults((current) => ({ ...current, [connector.id]: result }));
        setActionStatus({
          tone: result.status === "ok" ? "success" : result.status === "incomplete" ? "info" : "warning",
          message: result.message,
        });
      }
    } catch (error) {
      setActionStatus({ tone: "danger", message: `${connector.name} connection test failed: ${errorMessage(error)}` });
    } finally {
      setPendingAction(null);
    }
  }

  async function startConnectorOAuth(connector: Connector) {
    const connectorOAuthUrl = adminApi?.connectorOAuthUrl;
    const configId = connector.tenant_config_id;
    if (!connectorOAuthUrl || !configId) {
      setActionStatus({
        tone: "warning",
        message: configId
          ? "The connector OAuth API is not connected in this session."
          : `Save the ${connector.name} configuration (client ID and secret) before connecting.`,
      });
      return;
    }
    setPendingAction(`connector-oauth-${connector.id}`);
    try {
      const url = await connectorOAuthUrl(data.me.id, configId);
      if (url) {
        window.location.assign(url);
        return;
      }
      setActionStatus({ tone: "warning", message: "The OAuth consent URL could not be created." });
    } catch (error) {
      setActionStatus({ tone: "danger", message: `Could not start the OAuth flow: ${errorMessage(error)}` });
    } finally {
      setPendingAction(null);
    }
  }

  function toggleTool(tool: ToolConfig, next: boolean) {
    const setToolEnabled = adminApi?.setToolEnabled;
    void runAdminMutation<Partial<ToolConfig>>({
      pendingKey: `tool-${tool.id}`,
      optimistic: () => applyToolPatch(tool.id, { enabled: next, status: next ? "ready" : "draft" }),
      helper: setToolEnabled ? () => setToolEnabled(data.me.id, tool.id, next, { ...mutationContext, tool }) : undefined,
      reconcile: (remoteTool) => applyToolPatch(tool.id, remoteTool),
      localMessage: `${tool.name} was not changed: the tool config API is unavailable in this build.`,
      syncMessage: `Syncing ${tool.name} tool state through the admin API...`,
      successMessage: `${tool.name} tool state synced with the admin API.`,
      failureMessage: `${tool.name} tool state could not sync.`,
    });
  }

  function toggleSsoEnforcement(config: SsoConfig, next: boolean) {
    const setSsoEnforced = adminApi?.setSsoEnforced;
    void runAdminMutation<Partial<SsoConfig>>({
      pendingKey: `sso-${config.id}`,
      optimistic: () => applySsoPatch(config.id, { enforced: next, status: next ? "enforced" : "ready" }),
      helper: setSsoEnforced ? () => setSsoEnforced(data.me.id, config.id, next, { ...mutationContext, config }) : undefined,
      reconcile: (remoteConfig) => applySsoPatch(config.id, remoteConfig),
      localMessage: `${config.name} SSO enforcement was not changed: the SSO API is unavailable in this build.`,
      syncMessage: `Syncing ${config.name} SSO enforcement through the admin API...`,
      successMessage: `${config.name} SSO enforcement synced with the admin API.`,
      failureMessage: `${config.name} SSO enforcement could not sync.`,
    });
  }

  // Owner-first waterfall: identity configuration is owner-only unless the
  // owner has explicitly delegated it in platform settings.
  const canManageSso =
    data.me.role === "PLATFORM_OWNER" || (data.platformSettings?.tenant_admins_can_manage_sso ?? false);

  function createSsoConfiguration(draft: SsoCreateDraft) {
    const createSsoConfig = adminApi?.createSsoConfig;
    const domains = draft.domains
      .split(/[\s,]+/)
      .map((domain) => domain.trim())
      .filter(Boolean);
    const localId = `sso-local-${data.ssoConfigs.length + 1}`;
    const localConfig: SsoConfig = {
      id: localId,
      name: draft.name,
      protocol: "OIDC",
      status: "ready",
      enforced: false,
      issuer: draft.issuer,
      client_id: draft.clientId,
      client_secret_set: Boolean(draft.clientSecret),
      domains: domains.length ? domains : ["tenant domain"],
      jit_provisioning: draft.jit,
      mapped_groups: {},
      last_tested: "Not tested yet",
      admin_notes: "Created from the Admin Console.",
    };
    void runAdminMutation<SsoConfig>({
      pendingKey: "sso:create",
      optimistic: () => {
        onDataChange((current) => ({ ...current, ssoConfigs: [...current.ssoConfigs, localConfig] }));
        setShowSsoCreate(false);
      },
      helper: createSsoConfig
        ? () =>
            createSsoConfig(
              data.me.id,
              {
                tenant_id: data.currentTenant.id,
                provider: draft.provider,
                issuer_url: draft.issuer,
                client_id: draft.clientId,
                client_secret: draft.clientSecret || null,
                enabled: true,
                settings: {
                  protocol: "OIDC",
                  status: "ready",
                  // Enforcement always starts off so a misconfigured provider
                  // can never lock the tenant out before a passing test.
                  enforced: false,
                  domains,
                  jit_provisioning: draft.jit,
                  admin_notes: "Created from the Admin Console.",
                },
              },
              mutationContext,
            )
        : undefined,
      reconcile: (config) => {
        if (!config) return;
        onDataChange((current) => ({
          ...current,
          ssoConfigs: current.ssoConfigs.map((item) => (item.id === localId ? config : item)),
        }));
      },
      localMessage: `${draft.name} was not saved: the SSO API is unavailable in this build.`,
      syncMessage: `Creating ${draft.name} through the admin API...`,
      successMessage: `${draft.name} SSO configuration created. Test the connection before enforcing it.`,
      failureMessage: `${draft.name} could not be created.`,
    });
  }

  function saveSsoGroupMappings(config: SsoConfig, mappedGroups: Record<string, string>) {
    const updateSsoConfig = adminApi?.updateSsoConfig;
    void runAdminMutation<SsoConfig>({
      pendingKey: `sso-mappings-${config.id}`,
      optimistic: () => applySsoPatch(config.id, { mapped_groups: mappedGroups }),
      helper: updateSsoConfig
        ? () => updateSsoConfig(data.me.id, config.id, { mapped_groups: mappedGroups }, { ...mutationContext, config })
        : undefined,
      reconcile: (remote) => remote && applySsoPatch(config.id, remote),
      localMessage: `${config.name} group mappings were not saved: the SSO API is unavailable in this build.`,
      syncMessage: `Saving ${config.name} group mappings...`,
      successMessage: `${config.name} group mappings saved.`,
      failureMessage: `${config.name} group mappings could not be saved.`,
    });
  }

  function removeSsoConfiguration(config: SsoConfig) {
    const deleteSsoConfig = adminApi?.deleteSsoConfig;
    void runAdminMutation<void>({
      pendingKey: `sso-delete-${config.id}`,
      optimistic: () =>
        onDataChange((current) => ({
          ...current,
          ssoConfigs: current.ssoConfigs.filter((item) => item.id !== config.id),
        })),
      helper: deleteSsoConfig ? () => deleteSsoConfig(data.me.id, config.id, mutationContext) : undefined,
      localMessage: `${config.name} was not removed: the SSO API is unavailable in this build.`,
      syncMessage: `Removing ${config.name} through the admin API...`,
      successMessage: `${config.name} SSO configuration removed.`,
      failureMessage: `${config.name} could not be removed.`,
    });
  }

  async function runSsoConnectionTest(config: SsoConfig) {
    const testSsoConfig = adminApi?.testSsoConfig;
    if (!testSsoConfig) {
      setActionStatus({
        tone: "warning",
        message: `Connect AdminConsoleApi.testSsoConfig to run live SSO connection tests.`,
      });
      return;
    }
    setPendingAction(`sso-test-${config.id}`);
    setActionStatus({ tone: "info", message: `Testing ${config.name} against the identity provider...` });
    try {
      const result = await testSsoConfig(data.me.id, config.id, mutationContext);
      if (result) {
        setSsoTestResults((current) => ({ ...current, [config.id]: result }));
        setActionStatus({
          tone: result.status === "ok" ? "success" : "warning",
          message:
            result.status === "ok"
              ? `${config.name} connection test passed.`
              : `${config.name} connection test returned ${result.status}.`,
        });
        if (result.status === "ok") applySsoPatch(config.id, { last_tested: "Just now" });
      }
    } catch (error) {
      setActionStatus({ tone: "danger", message: `${config.name} connection test failed. ${errorMessage(error)}` });
    } finally {
      setPendingAction((current) => (current === `sso-test-${config.id}` ? null : current));
    }
  }

  async function setSecurityAlertAcknowledged(alert: SecurityAlert, acknowledged: boolean) {
    const actionKey = `security-alert:${alert.id}`;
    const action = adminApi?.acknowledgeSecurityAlert;
    if (!action) {
      setActionStatus({
        tone: "warning",
        message: "Security alert review is not connected to the admin API in this session.",
      });
      return;
    }
    setPendingAction(actionKey);
    try {
      const saved = await action(data.me.id, alert.id, acknowledged, mutationContext);
      setSecurityAlerts((current) =>
        current?.map((item) => (item.id === alert.id ? saved ?? { ...item, acknowledged } : item)) ?? current,
      );
      setAuditTrailRefreshToken((token) => token + 1);
      setActionStatus({
        tone: "success",
        message: acknowledged
          ? `${alert.rule_label} alert acknowledged.`
          : `${alert.rule_label} alert returned to active review.`,
      });
    } catch (error) {
      setActionStatus({
        tone: "warning",
        message: `Security alert was not updated: ${errorMessage(error)}`,
      });
    } finally {
      setPendingAction((current) => (current === actionKey ? null : current));
    }
  }

  async function saveMemoryPolicy(patch: TenantMemoryPolicyUpdateRequest) {
    const updateMemoryPolicy = adminApi?.updateMemoryPolicy;
    if (!updateMemoryPolicy) {
      setActionStatus({ tone: "warning", message: "Memory policy was not saved; the admin memory API is not connected." });
      return;
    }
    const previous = memoryPolicy;
    setMemoryPolicy((current) => (current ? { ...current, ...patch } : current));
    setPendingAction("memory-policy");
    try {
      const saved = await updateMemoryPolicy(data.me.id, patch, mutationContext);
      if (saved) setMemoryPolicy(saved);
      setActionStatus({ tone: "success", message: "Memory policy saved." });
      setMemoryError(null);
    } catch (error) {
      setMemoryPolicy(previous);
      setActionStatus({ tone: "danger", message: `Memory policy was not saved. ${errorMessage(error)}` });
    } finally {
      setPendingAction((current) => (current === "memory-policy" ? null : current));
    }
  }

  async function saveRetentionPolicy(patch: TenantRetentionPolicyUpdateRequest) {
    const updateRetentionPolicy = adminApi?.updateRetentionPolicy;
    if (!updateRetentionPolicy) {
      setActionStatus({
        tone: "warning",
        message: "Retention policy was not saved; the admin retention API is not connected.",
      });
      return;
    }
    const previous = retentionPolicy;
    setRetentionPolicy((current) => (current ? { ...current, ...patch } : current));
    setPendingAction("retention-policy");
    try {
      const saved = await updateRetentionPolicy(data.me.id, patch, mutationContext);
      if (saved) setRetentionPolicy(saved);
      setActionStatus({ tone: "success", message: "Retention policy saved." });
      setRetentionError(null);
    } catch (error) {
      setRetentionPolicy(previous);
      setActionStatus({
        tone: "danger",
        message: `Retention policy was not saved. ${errorMessage(error)}`,
      });
    } finally {
      setPendingAction((current) => (current === "retention-policy" ? null : current));
    }
  }

  async function runRetentionBatchAction(
    action: "delete" | "archive",
    threadIds: string[],
  ): Promise<boolean> {
    const runRetentionBatch = adminApi?.runRetentionBatch;
    if (!runRetentionBatch) {
      setActionStatus({
        tone: "warning",
        message: "Nothing was changed; the admin retention API is not connected.",
      });
      return false;
    }
    setPendingAction("retention-batch");
    try {
      const result = await runRetentionBatch(
        data.me.id,
        { action, thread_ids: threadIds },
        mutationContext,
      );
      const disposed = result?.disposed ?? 0;
      const held = result?.skipped_held ?? 0;
      setActionStatus({
        tone: "success",
        message:
          action === "delete"
            ? `Deleted ${disposed} chat${disposed === 1 ? "" : "s"}.${held > 0 ? ` ${held} under an active legal hold ${held === 1 ? "was" : "were"} skipped.` : ""}`
            : `Archived ${disposed} chat${disposed === 1 ? "" : "s"}.`,
      });
      setRetentionRefreshToken((token) => token + 1);
      return true;
    } catch (error) {
      setActionStatus({
        tone: "danger",
        message: `The batch ${action} failed. ${errorMessage(error)}`,
      });
      return false;
    } finally {
      setPendingAction((current) => (current === "retention-batch" ? null : current));
    }
  }

  async function purgeMemoriesForUser(stat: MemoryUserStat) {
    const purgeUserMemories = adminApi?.purgeUserMemories;
    if (!purgeUserMemories) {
      setActionStatus({ tone: "warning", message: "Memory was not purged; the admin memory API is not connected." });
      return;
    }
    setPendingAction(`memory-purge-${stat.user_id}`);
    try {
      const result = await purgeUserMemories(data.me.id, stat.user_id, mutationContext);
      const removed = result?.removed ?? stat.count;
      setMemoryStats((current) =>
        current
          ? current.map((row) =>
              row.user_id === stat.user_id ? { ...row, count: 0, last_updated: null } : row,
            )
          : current,
      );
      setActionStatus({
        tone: "success",
        message: `Deleted ${removed} ${removed === 1 ? "memory" : "memories"} for ${stat.display_name}.`,
      });
    } catch (error) {
      setActionStatus({ tone: "danger", message: `Memory was not purged. ${errorMessage(error)}` });
    } finally {
      setPendingAction((current) => (current === `memory-purge-${stat.user_id}` ? null : current));
    }
  }

  return (
    <div className="console-page">
      <header className="console-header">
        <div>
          <h1>Admin Console</h1>
          <p>Manage accounts, groups, policy controls, model access, SSO, connections, and tenant audit state.</p>
        </div>
        <button
          className="text-icon-button owner-doc-button"
          type="button"
          data-tooltip="Open the admin training videos covering every console tab"
          onClick={() => setShowDocumentation(true)}
        >
          <BookOpen size={16} /> Documentation
        </button>
      </header>
      {showDocumentation && (
        <LazyChunkBoundary label="The admin documentation">
          <Suspense fallback={null}>
            <AdminDocumentationModal onClose={() => setShowDocumentation(false)} />
          </Suspense>
        </LazyChunkBoundary>
      )}
      {passwordTarget && (
        <PasswordResetDialog
          userName={passwordTarget.display_name}
          onClose={() => setPasswordTarget(null)}
          onSubmit={(password, temporary) => resetPassword(passwordTarget, password, temporary)}
        />
      )}
      {filterDialogModel && filterDialogApi && (
        <ModelFilterDialog
          model={filterDialogModel}
          api={filterDialogApi}
          onClose={() => setFilterModelId(null)}
          onModelUpdated={handleFilterModelUpdated}
        />
      )}
      {toolBuilder.open && toolBuilderApi && (
        <CustomToolBuilder
          tool={toolBuilder.tool}
          groups={data.groups}
          api={toolBuilderApi}
          onClose={() => setToolBuilder({ open: false, tool: null })}
          onSaved={handleCustomToolSaved}
          brandName={data.currentTenant.chat_brand_name ?? undefined}
        />
      )}

      {actionStatus && (
        <div className="inline-warning action-status-toast" role={actionStatus.tone === "danger" ? "alert" : "status"}>
          <Pill tone={actionStatus.tone}>{ACTION_TONE_LABELS[actionStatus.tone]}</Pill>
          <span className="action-status-message">{actionStatus.message}</span>
          <button
            className="icon-button action-status-close"
            type="button"
            aria-label="Dismiss notification"
            data-tooltip="Dismiss this status message from the admin console"
            onClick={() => setActionStatus(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}

      <Tabs.Root defaultValue="users" className="tabs-root">
        <Tabs.List className="tabs-list management-console-tabs" aria-label="Admin sections">
          {adminTabs.map((tab) => (
            <Tabs.Trigger
              key={tab}
              className="tab-trigger"
              value={tab === "Connections" ? "tools" : tab.toLowerCase().replaceAll(" ", "-")}
              data-tooltip={`Open the ${tab} section of the admin console`}
            >
              {tab}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="users" className="tab-content">
          <Panel
            className="users-panel user-management-panel"
            title={`Users (${displayedUsers.length})`}
            subtitle={
              pendingAccessRequests.length > 0
                ? `${pendingAccessRequests.length} access request${pendingAccessRequests.length === 1 ? "" : "s"} waiting for review.`
                : pendingUserCount > 0
                ? `${pendingUserCount} user${pendingUserCount === 1 ? "" : "s"} need a platform group before assigned resources unlock.`
                : "Default Users is the protected baseline for new accounts."
            }
            actions={
              <>
                <label className="compact-select-field">
                  <Search size={14} />
                  <SelectControl
                    aria-label="Filter users by group"
                    value={userGroupFilter}
                    onChange={(event) => {
                      setUserGroupFilter(event.target.value);
                      if (event.target.value !== "all") setSelectedGroupId(event.target.value);
                    }}
                  >
                    <option value="all">All groups</option>
                    {data.groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </SelectControl>
                </label>
                <button
                  className="primary-button"
                  type="button"
                  data-tooltip={showInvite ? "Close the new user form without creating an account" : "Open a form to create a new user account in this workspace"}
                  onClick={() => setShowInvite((value) => !value)}
                >
                  <Plus size={17} /> Add User
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  data-tooltip="Deactivate the selected users so they can no longer sign in"
                  onClick={() => void deactivateSelected()}
                  disabled={selectedUserIds.length === 0 || pendingAction === "deactivate-users"}
                >
                  <Trash2 size={16} /> Deactivate
                </button>
              </>
            }
          >
            {pendingAccessRequests.length > 0 && (
              <section className="access-request-queue" aria-labelledby="access-request-queue-title">
                <header className="access-request-queue-header">
                  <span className="access-request-queue-icon"><Clock3 size={18} /></span>
                  <div>
                    <h3 id="access-request-queue-title">Access requests</h3>
                    <span>{pendingAccessRequests.length} waiting for review</span>
                  </div>
                </header>
                <div className="access-request-list">
                  {pendingAccessRequests.map((request) => {
                    const reviewRole = accessReviewRoles[request.id] ?? "USER";
                    const approving = pendingAction === `approve-access-${request.id}`;
                    const declining = pendingAction === `decline-access-${request.id}`;
                    return (
                      <article className="access-request-card" key={request.id}>
                        <div className="access-request-person">
                          <UserAvatar user={request} className="mini-avatar" />
                          <div>
                            <strong>{request.display_name}</strong>
                            <span>{request.email}</span>
                            <small>{formatAccessRequestedAt(request.access_requested_at)}</small>
                          </div>
                        </div>
                        <label className="access-request-role">
                          <span>Approve as</span>
                          <SelectControl
                            aria-label={`Access level for ${request.display_name}`}
                            value={reviewRole}
                            disabled={approving || declining}
                            onChange={(event) =>
                              setAccessReviewRoles((current) => ({
                                ...current,
                                [request.id]: event.target.value as "USER" | "TEMP_USER" | "TENANT_ADMIN",
                              }))
                            }
                          >
                            {accessApprovalRoles.map((role) => (
                              <option key={role} value={role}>
                                {role === "TEMP_USER" ? "Temp User · Luna + 30K tokens" : ROLE_LABELS[role]}
                              </option>
                            ))}
                          </SelectControl>
                          <small>
                            {reviewRole === "TEMP_USER"
                              ? "Luna only; requests stop after 30,000 reported tokens."
                              : reviewRole === "TENANT_ADMIN"
                                ? "Can manage workspace users, access, and settings."
                                : "Receives the workspace's standard group-based access."}
                          </small>
                        </label>
                        <div className="access-request-actions">
                          <button
                            className="primary-button compact"
                            type="button"
                            disabled={approving || declining}
                            onClick={() => void approveAccessRequest(request)}
                          >
                            {approving ? <RefreshCw className="spin" size={14} /> : <Check size={14} />}
                            {approving ? "Approving…" : "Approve"}
                          </button>
                          <button
                            className="secondary-button compact"
                            type="button"
                            disabled={approving || declining}
                            onClick={() => void declineAccessRequest(request)}
                          >
                            <X size={14} /> {declining ? "Declining…" : "Decline"}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}
            {showInvite && (
              <div className="inline-form user-create-form">
                <label>
                  Name
                  <input value={invite.name} onChange={(event) => setInvite((state) => ({ ...state, name: event.target.value }))} />
                </label>
                <label>
                  Email
                  <input
                    value={invite.email}
                    type="email"
                    onChange={(event) => setInvite((state) => ({ ...state, email: event.target.value }))}
                  />
                </label>
                <label>
                  Role
                  <SelectControl
                    value={invite.role}
                    onChange={(event) => setInvite((state) => ({ ...state, role: event.target.value as Role }))}
                  >
                    {roleOptions.map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABELS[role]}
                      </option>
                    ))}
                  </SelectControl>
                </label>
                <label>
                  Starting group
                  <SelectControl
                    value={selectedGroup?.id ?? ""}
                    onChange={(event) => setSelectedGroupId(event.target.value)}
                    aria-label="Starting group"
                  >
                    {data.groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </SelectControl>
                </label>
                <button
                  className="primary-button form-submit-button"
                  type="button"
                  data-tooltip="Create this account and add the user to the starting group"
                  onClick={() => void addUser()}
                  disabled={!invite.email.trim() || pendingAction === "add-user"}
                >
                  Create Account
                </button>
              </div>
            )}

            <div className="table-scroll user-table-scroll">
              <table className="data-table user-table user-management-table">
                <colgroup>
                  <col className="user-table-select-col" />
                  <col className="user-table-name-col" />
                  <col className="user-table-email-col" />
                  <col className="user-table-role-col" />
                  <col className="user-table-groups-col" />
                  <col className="user-table-auth-col" />
                  <col className="user-table-status-col" />
                  <col className="user-table-active-col" />
                  <col className="user-table-actions-col" />
                </colgroup>
                <thead>
                  <tr>
                    <th />
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Groups</th>
                    <th>Auth</th>
                    <th>Status</th>
                    <th>Last Active</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedUsers.map((user) => {
                    const editable = canModifyUser(data.me, user);
                    const selected = selectedUserIds.includes(user.id);
                    const rowRoleOptions = roleOptions.includes(user.role) ? roleOptions : [user.role, ...roleOptions];
                    const accessStatus = userAccessStatus(user);
                    const userGroupNames = user.group_ids.map((groupId) => groupName(data, groupId));
                    const visibleGroupNames = userGroupNames.slice(0, 1);
                    const hiddenGroupCount = Math.max(0, userGroupNames.length - visibleGroupNames.length);
                    return (
                      <tr key={user.id} className={!editable ? "locked-row" : ""}>
                        <td data-label="Select">
                          <input
                            type="checkbox"
                            aria-label={`Select ${user.display_name}`}
                            checked={selected}
                            disabled={!editable || !user.active || pendingAction === "deactivate-users"}
                            onChange={(event) =>
                              setSelectedUserIds((current) =>
                                event.target.checked ? [...current, user.id] : current.filter((id) => id !== user.id),
                              )
                            }
                          />
                        </td>
                        <td data-label="Name">
                          <span
                            className="person-cell user-identity-cell"
                            tabIndex={0}
                            data-tooltip={userIdentityTooltip(user)}
                          >
                            <UserAvatar user={user} className="mini-avatar" />
                            <span>
                              <strong>{user.display_name}</strong>
                              {user.firm_name && <small>{user.firm_name}</small>}
                            </span>
                          </span>
                        </td>
                        <td data-label="Email">
                          <span className="table-email">{user.email}</span>
                        </td>
                        <td data-label="Role">
                          <SelectControl
                            className="role-select"
                            value={user.role}
                            disabled={!editable}
                            aria-label={`Role for ${user.display_name}`}
                            onChange={(event) => void updateUser(user, { role: event.target.value as Role })}
                          >
                            {rowRoleOptions.map((role) => (
                              <option key={role} value={role}>
                                {ROLE_LABELS[role]}
                              </option>
                            ))}
                          </SelectControl>
                        </td>
                        <td data-label="Groups">
                          <span className="group-chip-list" title={userGroupNames.join(", ") || "No groups"}>
                            {visibleGroupNames.length ? (
                              <>
                                {visibleGroupNames.map((group) => (
                                  <span className="group-chip" key={group}>
                                    {group}
                                  </span>
                                ))}
                                {hiddenGroupCount > 0 && (
                                  <span className="group-chip group-chip-count" aria-label={`${hiddenGroupCount} more groups`}>
                                    +{hiddenGroupCount}
                                  </span>
                                )}
                              </>
                            ) : (
                              <span className="muted-value">None</span>
                            )}
                          </span>
                        </td>
                        <td data-label="Auth">{user.auth_method ?? "sso"}</td>
                        <td data-label="Status">
                          <span className="status-enabled">
                            <span className={`dot ${accessStatus.dotClass}`} /> {accessStatus.label}
                          </span>
                        </td>
                        <td data-label="Last Active">{user.last_active}</td>
                        <td data-label="Actions">
                          <span className="user-row-actions">
                            <button
                              className="secondary-button compact"
                              type="button"
                              aria-label={`Password for ${user.display_name}`}
                              data-tooltip={
                                user.id === data.me.id
                                  ? "Change your own password from your account panel"
                                  : user.role === "PLATFORM_OWNER"
                                    ? "Platform owner passwords can only be changed by the owner themselves"
                                    : passwordResetAllowed(user)
                                      ? `Set a new or temporary password for ${user.display_name}`
                                      : "Administrator password resets are managed outside this console"
                              }
                              disabled={!passwordResetAllowed(user) || !adminApi?.resetUserPassword}
                              onClick={() => setPasswordTarget(user)}
                            >
                              <KeyRound size={14} />
                              Password
                            </button>
                            <button
                              className="secondary-button compact"
                              type="button"
                              aria-label={`${user.active ? "Deactivate" : "Activate"} ${user.display_name}`}
                              data-tooltip={
                                user.active
                                  ? `Deactivate ${user.display_name} and block their sign-in access`
                                  : `Reactivate ${user.display_name} so they can sign in again`
                              }
                              disabled={!editable || pendingAction === `user-${user.id}`}
                              onClick={() => void updateUser(user, { active: !user.active })}
                            >
                              {user.active ? <Ban size={14} /> : <CheckCircle2 size={14} />}
                              {user.active ? "Deactivate" : "Activate"}
                            </button>
                            <button
                              className="icon-button danger-lite-button"
                              type="button"
                              aria-label={`Delete ${user.display_name}`}
                              data-tooltip={
                                user.id === data.me.id
                                  ? "You cannot delete your own account"
                                  : user.role === "PLATFORM_OWNER"
                                    ? "Platform owner accounts cannot be deleted; deactivate them instead"
                                    : canDeleteUser(data.me, user)
                                      ? `Permanently delete ${user.display_name} and their chat history`
                                      : "Administrator account deletion is managed outside this console"
                              }
                              disabled={
                                !canDeleteUser(data.me, user) ||
                                !adminApi?.deleteUser ||
                                pendingAction === `user-${user.id}`
                              }
                              onClick={() => void deleteUserAccount(user)}
                            >
                              <Trash2 size={14} />
                            </button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        </Tabs.Content>

        <Tabs.Content value="groups" className="tab-content">
          <div className="admin-groups-grid">
            <GroupManagementPanel
              data={data}
              selectedGroupId={selectedGroup?.id}
              selectedGroupIdsForRemoval={selectedGroupIdsForRemoval}
              pendingAction={pendingAction}
              showCreate={showGroupCreate}
              groupDraft={groupDraft}
              bulkUserText={bulkUserText}
              onSelect={setSelectedGroupId}
              onToggleCreate={() => setShowGroupCreate((value) => !value)}
              onDraftChange={setGroupDraft}
              onBulkUserTextChange={setBulkUserText}
              onCreate={() => void addGroup()}
              onImportUsers={(group) => void importUsersToGroup(group)}
              onDelete={(groupId) => void removeGroup(groupId)}
              onDeleteSelected={() => void removeSelectedGroups()}
              onToggleRemoval={toggleGroupSelectionForRemoval}
              onPermissionChange={toggleGroupPermission}
              onUserMembershipChange={(user, group, next) => void setUserGroupMembership(user, group, next)}
            />
          </div>
        </Tabs.Content>

        <Tabs.Content value="model-access" className="tab-content">
          <Panel
            className="model-access-panel"
            title="Model Access"
            subtitle="Synced model catalog for this tenant. Turn models on for users and choose groups per model."
            actions={
              <div className="model-list-controls">
                <div className="status-filter" role="radiogroup" aria-label="Filter models by org status">
                  {MODEL_STATUS_FILTER_OPTIONS.map((option) => {
                    const count =
                      option.value === "all"
                        ? adminVisibleModels.length
                        : option.value === "enabled"
                          ? activeModelCount
                          : adminVisibleModels.length - activeModelCount;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={modelStatusFilter === option.value}
                        className={`status-filter-option${modelStatusFilter === option.value ? " is-selected" : ""}`}
                        data-tooltip={option.tooltip}
                        onClick={() => setModelStatusFilter(option.value)}
                      >
                        {option.label} <b>{count}</b>
                      </button>
                    );
                  })}
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  data-tooltip="Pull the latest model catalog into this tenant's Model Access list"
                  onClick={() => void syncModelAccess()}
                  disabled={pendingAction === "sync-model-access"}
                >
                  <RefreshCw size={16} /> Sync models
                </button>
              </div>
            }
          >
            <div className="model-access-toolbar model-access-summary-toolbar">
              <span className="waterfall-step">
                <strong>{adminVisibleModels.length}</strong> model{adminVisibleModels.length === 1 ? "" : "s"} synced to this tenant
              </span>
              <span className="waterfall-step">
                <strong>{activeModelCount}</strong> visible to users
              </span>
              <span className="waterfall-step">
                <strong>{data.groups.length}</strong> group{data.groups.length === 1 ? "" : "s"} available
              </span>
              <label className="search-box model-access-search">
                <Search size={16} />
                <input
                  aria-label="Search model names"
                  value={modelAccessSearch}
                  onChange={(event) => setModelAccessSearch(event.target.value)}
                  placeholder="Search model names"
                />
              </label>
            </div>
            {!hasModelAccessGroups && (
              <div className="inline-warning model-access-empty-groups" role="note">
                <ShieldCheck size={16} />
                <span>
                  <strong>Create a group before enabling models.</strong>
                  <small>
                    Model access is granted to groups. Users inherit a model only after they belong to an allowed
                    group, so user accounts alone will not turn these switches on.
                  </small>
                </span>
              </div>
            )}

            <div className="table-scroll">
              <table className="data-table model-access-table">
                <thead>
                  <tr>
                    <th>
                      <span className="model-column-header">
                        Model
                        <ModelColumnFilter
                          column="Model lab"
                          tooltip="Filter to models from specific labs like OpenAI, Anthropic, or Google"
                          open={openModelColumnFilter === "lab"}
                          activeCount={modelLabFilter.length}
                          onToggleOpen={() => setOpenModelColumnFilter((open) => (open === "lab" ? null : "lab"))}
                          onClear={() => setModelLabFilter([])}
                          options={modelLabOptions}
                          selected={modelLabFilter}
                          onToggleValue={(value) =>
                            setModelLabFilter((current) =>
                              current.includes(value)
                                ? current.filter((entry) => entry !== value)
                                : [...current, value],
                            )
                          }
                        />
                      </span>
                    </th>
                    <th>
                      <span className="model-column-header">
                        Provider
                        <ModelColumnFilter
                          column="Provider"
                          tooltip="Filter the list to specific providers"
                          open={openModelColumnFilter === "provider"}
                          activeCount={modelProviderFilter.length}
                          onToggleOpen={() =>
                            setOpenModelColumnFilter((open) => (open === "provider" ? null : "provider"))
                          }
                          onClear={() => setModelProviderFilter([])}
                          options={modelProviderOptions}
                          selected={modelProviderFilter}
                          onToggleValue={(value) =>
                            setModelProviderFilter((current) =>
                              current.includes(value)
                                ? current.filter((entry) => entry !== value)
                                : [...current, value],
                            )
                          }
                        />
                      </span>
                    </th>
                    <th>
                      <span className="model-column-header">
                        Runtime Route
                        <ModelColumnFilter
                          column="Runtime route"
                          tooltip="Filter runtime routes by text, like gpt-5 or preview"
                          open={openModelColumnFilter === "route"}
                          activeCount={modelRouteFilter.trim() ? 1 : 0}
                          onToggleOpen={() =>
                            setOpenModelColumnFilter((open) => (open === "route" ? null : "route"))
                          }
                          onClear={() => setModelRouteFilter("")}
                          text={modelRouteFilter}
                          onTextChange={setModelRouteFilter}
                        />
                      </span>
                    </th>
                    <th>User Access</th>
                    <th>Groups</th>
                    <th>Filters</th>
                    <th>Knowledge</th>
                    <th>Tools</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAdminVisibleModels.map((model) => {
                    const enabledForUsers = model.group_ids.length > 0;
                    const groupEditorOpen = openModelGroupId === model.id;
                    const pendingModelAccess = pendingAction === `model-access-${model.id}`;
                    const requiresGroupBeforeGrant = !enabledForUsers && !hasModelAccessGroups;
                    return (
                      <Fragment key={model.id}>
                        <tr>
                          <td data-label="Model">
                            <strong>{model.name}</strong>
                            <small className="table-subtext">{model.upstream_model_id ?? model.visibility ?? "tenant"}</small>
                          </td>
                          <td data-label="Provider">{model.provider_name}</td>
                          <td data-label="Runtime Route">{model.upstream_model_id ?? model.name}</td>
                          <td data-label="User Access">
                            <span className="model-grant-cell">
                              <Toggle
                                checked={enabledForUsers}
                                disabled={pendingModelAccess || requiresGroupBeforeGrant}
                                label={`Enable ${model.name} for users`}
                                tooltip={
                                  requiresGroupBeforeGrant
                                    ? `Create at least one tenant group before enabling ${model.name} for users`
                                    : enabledForUsers
                                      ? `Hide ${model.name} from all users in this tenant`
                                      : `Make ${model.name} available to the default group first`
                                }
                                onChange={(next) => toggleModelUserAccess(model, next)}
                              />
                              <em className={enabledForUsers ? "" : "restricted"}>
                                {enabledForUsers
                                  ? `Visible to ${model.group_ids.length} group${model.group_ids.length === 1 ? "" : "s"}`
                                  : hasModelAccessGroups
                                    ? "Hidden from users"
                                    : "Create a group first"}
                              </em>
                            </span>
                          </td>
                          <td data-label="Groups">
                            <span className="model-groups-cell">
                              <button
                                className="secondary-button compact model-groups-button"
                                type="button"
                                aria-label={
                                  hasModelAccessGroups
                                    ? `Edit groups for ${model.name}`
                                    : `No groups available for ${model.name}`
                                }
                                data-tooltip={
                                  hasModelAccessGroups
                                    ? `Choose which groups can see and use ${model.name}`
                                    : `Create a tenant group before choosing access for ${model.name}`
                                }
                                aria-expanded={groupEditorOpen}
                                aria-controls={`model-groups-${model.id}`}
                                disabled={!hasModelAccessGroups}
                                onClick={() => setOpenModelGroupId((current) => (current === model.id ? null : model.id))}
                              >
                                <Users size={14} />
                                {model.group_ids.length
                                  ? `${model.group_ids.length} groups`
                                  : hasModelAccessGroups
                                    ? "Choose groups"
                                    : "No groups yet"}
                                <ChevronDown size={14} />
                              </button>
                            </span>
                          </td>
                          <td data-label="Filters">
                            <button
                              className="secondary-button compact model-filters-button"
                              type="button"
                              aria-label={`Configure content filters for ${model.name}`}
                              data-tooltip={
                                filterDialogApi
                                  ? `Choose which security and DLP filters run on every ${model.name} conversation`
                                  : "Content filters are not connected to the admin API"
                              }
                              disabled={!filterDialogApi}
                              onClick={() => setFilterModelId(model.id)}
                            >
                              <SlidersHorizontal size={14} />
                              {model.content_filter_ids?.length
                                ? `${model.content_filter_ids.length} filter${model.content_filter_ids.length === 1 ? "" : "s"}`
                                : "Add filters"}
                            </button>
                          </td>
                          <td data-label="Knowledge">{model.knowledge_base_ids?.length ?? model.knowledge_config_ids?.length ?? 0} bases</td>
                          <td data-label="Tools">{model.tool_ids?.length ?? model.tool_config_ids?.length ?? 0} tools</td>
                        </tr>
                        {groupEditorOpen && (
                          <tr className="model-group-editor-row">
                            <td colSpan={8}>
                              <div className="model-group-editor" id={`model-groups-${model.id}`}>
                                <strong>Groups that can use {model.name}</strong>
                                <div className="model-group-check-grid">
                                  {data.groups.map((group) => (
                                    <label className="model-group-check" key={group.id}>
                                      <input
                                        type="checkbox"
                                        checked={model.group_ids.includes(group.id)}
                                        disabled={pendingAction === `model-access-${model.id}`}
                                        aria-label={`Allow ${model.name} for ${group.name}`}
                                        onChange={(event) => setModelGroupGrant(model, group.id, event.target.checked)}
                                      />
                                      <span>
                                        <strong>{group.name}</strong>
                                        <small>
                                          {groupMemberCount(data, group.id)} platform member
                                          {groupMemberCount(data, group.id) === 1 ? "" : "s"}
                                        </small>
                                      </span>
                                    </label>
                                  ))}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                  {filteredAdminVisibleModels.length === 0 && (
                    <tr>
                      <td colSpan={8}>
                        <span className="table-empty-state">
                          {modelProviderFilter.length > 0 || modelLabFilter.length > 0 || modelRouteTerm
                            ? "No models match the current column filters."
                            : modelStatusFilter === "all"
                              ? `No models match "${modelAccessSearch.trim()}".`
                              : `No ${modelStatusFilter} models match the current search.`}
                        </span>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
        </Tabs.Content>

        <Tabs.Content value="tools" className="tab-content">
          <div className="admin-tools-stack">
            <Panel
              title="Connectors"
              subtitle="Workspace-wide switches and credentials for platform-configured sources and tools. Off removes the capability from every user in this workspace — chat, pickers, and the tool library included."
            >
              {data.connectors.map((connector) => {
                const profile = CONNECTOR_FORM_PROFILES[connector.id];
                const isWebSearch = connector.id === "web";
                const record = data.connectorConfigs.find(
                  (config) => config.id === connector.tenant_config_id,
                );
                const expanded = expandedConnectorId === connector.id;
                return (
                  <div className="connector-config-block" key={connector.id}>
                    <div className="permission-row">
                      <span>
                        <KeyRound size={15} />
                        <strong className="connector-row-name">{connector.name}</strong>
                        {profile && (
                          <Pill tone={connector.auth_status === "configured" ? "success" : "warning"}>
                            {connector.auth_status === "configured"
                              ? "Credentials saved"
                              : record?.secret_set
                                ? "Saved · disabled"
                                : "Needs credentials"}
                          </Pill>
                        )}
                        {isWebSearch && (
                          <Pill tone={webSearchEnginePill(record).tone}>{webSearchEnginePill(record).label}</Pill>
                        )}
                      </span>
                      <span className="row-actions">
                        {(profile || isWebSearch) && (
                          <button
                            className="secondary-button compact"
                            type="button"
                            aria-expanded={expanded}
                            data-tooltip={
                              expanded
                                ? `Hide the ${connector.name} configuration form`
                                : `Set up credentials and connection settings for ${connector.name}`
                            }
                            onClick={() =>
                              setExpandedConnectorId((current) => (current === connector.id ? null : connector.id))
                            }
                          >
                            <Wrench size={14} /> Configure
                          </button>
                        )}
                        <Toggle
                          checked={connector.tenant_enabled}
                          disabled={!connector.platform_enabled}
                          label={`Enable ${connector.name}`}
                          tooltip={
                            connector.tenant_enabled
                              ? `Turn off ${connector.name} for this workspace`
                              : `Turn on ${connector.name} as a source for this workspace`
                          }
                          onChange={(next) => toggleConnector(connector, next)}
                        />
                      </span>
                    </div>
                    {isWebSearch && expanded && (
                      <WebSearchConfigForm
                        connector={connector}
                        record={record}
                        saving={pendingAction === `connector-config-${connector.id}`}
                        testing={pendingAction === `connector-test-${connector.id}`}
                        testResult={connectorTestResults[connector.id] ?? null}
                        onSave={(payload) => void saveConnectorConfiguration(connector, payload)}
                        onTest={() => void testConnectorConfiguration(connector)}
                      />
                    )}
                    {profile && expanded && (
                      <ConnectorConfigForm
                        connector={connector}
                        profile={profile}
                        record={record}
                        saving={pendingAction === `connector-config-${connector.id}`}
                        testing={pendingAction === `connector-test-${connector.id}`}
                        testResult={connectorTestResults[connector.id] ?? null}
                        onSave={(payload) => void saveConnectorConfiguration(connector, payload)}
                        onTest={() => void testConnectorConfiguration(connector)}
                        onOAuthConnect={() => void startConnectorOAuth(connector)}
                      />
                    )}
                  </div>
                );
              })}
            </Panel>
            <Panel
              title="Chat output actions"
              subtitle="Add admin-approved buttons to assistant responses, like export, format, or handoff actions. This does not add MCP servers or model-callable tools."
              actions={
                <button
                  className="secondary-button compact"
                  type="button"
                  data-tooltip={
                    toolBuilderApi
                      ? "Create a response action that appears on assistant messages"
                      : "Response actions are not connected to the admin API"
                  }
                  disabled={!toolBuilderApi}
                  onClick={() => setToolBuilder({ open: true, tool: null })}
                >
                  <Plus size={14} /> New response action
                </button>
              }
            >
              {data.tools.map((tool) => {
                const authorizeUrl = toolAuthorizeUrl(tool);
                return (
                  <div className="permission-row" key={tool.id}>
                    <span>
                      <Wrench size={15} />
                      {tool.name}
                      {tool.type === "custom_script" && <Pill tone="info">Response action</Pill>}
                    </span>
                    <span className="row-actions">
                      {tool.type === "custom_script" && (
                        <>
                          <button
                            className="secondary-button compact"
                            type="button"
                            aria-label={`Edit ${tool.name}`}
                            data-tooltip={`Edit the response action and script for ${tool.name}`}
                            disabled={!toolBuilderApi}
                            onClick={() => setToolBuilder({ open: true, tool })}
                          >
                            <Pencil size={14} /> Edit
                          </button>
                          <button
                            className="icon-button"
                            type="button"
                            aria-label={`Delete ${tool.name}`}
                            data-tooltip={`Delete the response action ${tool.name} for the whole workspace`}
                            disabled={pendingAction === `tool-delete-${tool.id}`}
                            onClick={() => void deleteCustomTool(tool)}
                          >
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                      {authorizeUrl && (
                        <a
                          className="secondary-button compact"
                          href={authorizeUrl}
                          target="_blank"
                          rel="noreferrer"
                          data-tooltip={`Open the ${tool.name} consent screen in a new tab to grant access`}
                        >
                          <KeyRound size={14} /> Authorize
                        </a>
                      )}
                      <Pill tone={tool.enabled ? "success" : "warning"}>{tool.enabled ? "Enabled" : "Draft"}</Pill>
                      <Toggle
                        checked={tool.enabled}
                        disabled={pendingAction === `tool-${tool.id}`}
                        label={`Enable ${tool.name}`}
                        tooltip={
                          tool.enabled
                            ? `Disable ${tool.name} so models and agents can no longer use it`
                            : `Enable ${tool.name} for models and agents in this workspace`
                        }
                        onChange={(next) => toggleTool(tool, next)}
                      />
                    </span>
                  </div>
                );
              })}
            </Panel>
          </div>
        </Tabs.Content>

        <Tabs.Content value="sso" className="tab-content">
          <Panel
            title="SSO and Provisioning"
            subtitle="Tenant identity providers with live connection tests, JIT provisioning, and IdP group mapping. Secrets stay vaulted server-side."
            actions={
              canManageSso ? (
                <button
                  className="secondary-button compact"
                  type="button"
                  data-tooltip="Add an OIDC identity provider for this tenant"
                  onClick={() => setShowSsoCreate((open) => !open)}
                >
                  <Plus size={14} />{" "}
                  <StableLabel
                    label={showSsoCreate ? "Close form" : "Add SSO configuration"}
                    reserve={["Close form", "Add SSO configuration"]}
                  />
                </button>
              ) : undefined
            }
          >
            {!canManageSso && (
              <div className="inline-warning" role="note">
                <Pill tone="warning">Policy</Pill>
                <span>
                  Organization policy makes SSO configuration read-only in this console.
                </span>
              </div>
            )}
            {showSsoCreate && canManageSso && (
              <SsoCreateForm
                pending={pendingAction === "sso:create"}
                onCancel={() => setShowSsoCreate(false)}
                onCreate={createSsoConfiguration}
              />
            )}
            {data.ssoConfigs.length === 0 && !showSsoCreate ? (
              <div className="audit-empty-state">
                <ShieldCheck size={20} />
                <span>
                  <strong>No SSO configurations for this tenant yet</strong>
                  <small>
                    {canManageSso
                      ? "Add an identity provider so this tenant can sign in through SSO with JIT provisioning and group mapping."
                      : "Identity-provider configuration is managed as part of the service policy."}
                  </small>
                </span>
              </div>
            ) : (
              <div className="settings-grid">
                {data.ssoConfigs.map((config) => (
                  <SsoConfigCard
                    key={config.id}
                    config={config}
                    groups={data.groups}
                    canManage={canManageSso}
                    pendingAction={pendingAction}
                    testResult={ssoTestResults[config.id]}
                    onToggleEnforce={(next) => toggleSsoEnforcement(config, next)}
                    onSaveMappings={(mappings) => saveSsoGroupMappings(config, mappings)}
                    onDelete={() => removeSsoConfiguration(config)}
                    onTest={() => void runSsoConnectionTest(config)}
                  />
                ))}
              </div>
            )}
          </Panel>
        </Tabs.Content>

        <Tabs.Content value="analytics" className="tab-content">
          <div className="analytics-console-grid">
            <Panel
              className="chat-feedback-panel"
              title={
                <>
                  <Clock3 size={18} /> Runtime Clock Metadata
                </>
              }
              subtitle="Organization-scoped execution timestamps captured from admin and user Chat and Draft completion events."
              actions={
                <CsvExportControl
                  label="admin runtime analytics"
                  filenameBase={
                    runtimeScope.userId === "all"
                      ? "aperture-admin-runtime-analytics"
                      : `aperture-admin-runtime-analytics-${runtimeScope.userId}`
                  }
                  items={filteredRuntimeAuditRows}
                  getTimestamp={(item) => item.executedAt}
                  columns={RUNTIME_ANALYTICS_CSV_COLUMNS}
                />
              }
              defaultCollapsed
            >
              <SectionScopeFilter
                label="Runtime events filter"
                scope={runtimeScope}
                onChange={setRuntimeScope}
                users={adminAuditUserOptions}
                allUsersLabel="All admins and users"
                selectedCount={filteredRuntimeAuditRows.length}
                totalCount={runtimeAuditRows.length}
              />
              <div className="feedback-summary-grid">
                <div className="feedback-summary-card">
                  <span>Runtime events</span>
                  <strong>{filteredRuntimeAuditRows.length}</strong>
                  <small>Admin and user Chat or Draft executions.</small>
                </div>
                <div className="feedback-summary-card">
                  <span>Chat</span>
                  <strong>{chatRuntimeRows.length}</strong>
                  <small>Main chat completions.</small>
                </div>
                <div className="feedback-summary-card">
                  <span>Drafts</span>
                  <strong>{draftRuntimeRows.length}</strong>
                  <small>Draft generation and revision calls.</small>
                </div>
              </div>

              {auditTrailError ? (
                <div className="audit-empty-state">
                  <ShieldAlert size={20} />
                  <span>
                    <strong>Runtime analytics could not be loaded</strong>
                    <small>{auditTrailError}</small>
                  </span>
                </div>
              ) : filteredRuntimeAuditRows.length > 0 ? (
                <div className="feedback-event-list scrollable-log-list" aria-label="Admin runtime clock events">
                  {filteredRuntimeAuditRows.map((item) => (
                    <div className="feedback-event-row" key={item.id}>
                      <span className="feedback-icon is-positive">
                        <Clock3 size={15} />
                      </span>
                      <span>
                        <strong>{item.title}</strong>
                        <small>{item.detail}</small>
                        <p>{item.metadata}</p>
                      </span>
                      <time dateTime={item.executedAt}>{formatAdminAuditTimestamp(item.executedAt)}</time>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="audit-empty-state">
                  <Clock3 size={20} />
                  <span>
                    <strong>No runtime clock events yet</strong>
                    <small>Admin-visible Chat and Draft executions will appear here after the next run.</small>
                  </span>
                </div>
              )}
            </Panel>

            <Panel
              className="chat-feedback-panel"
              title={
                <>
                  <MessageSquareText size={18} /> Chat Feedback
                </>
              }
              subtitle={
                serverFeedback !== null
                  ? "Thumbs ratings, written notes, and platform issue reports from tenant users."
                  : "Thumbs ratings recorded in this browser. Server-side feedback and issue reports load when the admin API is connected."
              }
              actions={
                <CsvExportControl
                  label="admin chat feedback analytics"
                  filenameBase="aperture-admin-chat-feedback"
                  items={filteredChatFeedback}
                  getTimestamp={(item) => item.created_at}
                  columns={CHAT_FEEDBACK_CSV_COLUMNS}
                />
              }
              defaultCollapsed
            >
              <SectionScopeFilter
                label="Chat feedback filter"
                scope={feedbackScope}
                onChange={setFeedbackScope}
                users={adminAuditUserOptions}
                allUsersLabel="All admins and users"
                selectedCount={filteredChatFeedback.length + filteredIssueReports.length}
                totalCount={scopedChatFeedback.length + scopedIssueReports.length}
              />
              <div className="feedback-summary-grid">
                <div className="feedback-summary-card">
                  <span>Total feedback</span>
                  <strong>{filteredChatFeedback.length}</strong>
                  <small>Captured from assistant response actions.</small>
                </div>
                <div className="feedback-summary-card">
                  <span>Positive</span>
                  <strong>{positiveFeedback.length}</strong>
                  <small>Thumbs up responses.</small>
                </div>
                <div className="feedback-summary-card">
                  <span>Negative</span>
                  <strong>{negativeFeedback.length}</strong>
                  <small>Thumbs down responses for review.</small>
                </div>
                <div className="feedback-summary-card">
                  <span>Issue reports</span>
                  <strong>{filteredIssueReports.length}</strong>
                  <small>Platform problems submitted through Help.</small>
                </div>
              </div>

              {filteredChatFeedback.length > 0 && (
                <div className="feedback-event-list scrollable-log-list" aria-label="Admin chat feedback events">
                  {filteredChatFeedback.map((item) => {
                    const isPositive = item.rating === "positive";
                    return (
                      <button
                        className="feedback-event-row is-clickable"
                        type="button"
                        key={item.id}
                        aria-label={`Preview feedback and conversation: ${item.thread_title}`}
                        onClick={() => setFeedbackPreview(item)}
                      >
                        <span className={isPositive ? "feedback-icon is-positive" : "feedback-icon is-negative"}>
                          {isPositive ? <ThumbsUp size={15} /> : <ThumbsDown size={15} />}
                        </span>
                        <span>
                          <strong>{isPositive ? "Positive sentiment" : "Negative sentiment"}</strong>
                          <small>
                            {item.thread_title} · {item.model_id} · {item.user_name}
                          </small>
                          <p>{markdownToPlainText(item.message_preview)}</p>
                          {item.comment ? (
                            <p className="feedback-comment">“{item.comment}”</p>
                          ) : null}
                        </span>
                        <span className="feedback-row-side">
                          <time>{formatFeedbackTimestamp(item.created_at)}</time>
                          <span className="prompt-activity-preview-label" aria-hidden="true">
                            <Eye size={14} /> Preview
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {filteredIssueReports.length > 0 && (
                <>
                  <h3 className="feedback-subsection-title">Reported platform issues</h3>
                  <div className="feedback-event-list scrollable-log-list" aria-label="Admin platform issue reports">
                    {filteredIssueReports.map((item) => (
                      <button
                        className="feedback-event-row is-clickable"
                        type="button"
                        key={item.id}
                        aria-label={`Preview issue report: ${item.subject}`}
                        onClick={() => setIssueReportPreview(item)}
                      >
                        <span className="feedback-icon is-issue-report"><Bug size={15} /></span>
                        <span>
                          <strong>{item.subject}</strong>
                          <small>{item.user_name}</small>
                          <p>{item.body}</p>
                          {item.screenshot_filename && (
                            <p className="issue-report-attachment-label">
                              <Paperclip size={13} /> {item.screenshot_filename}
                            </p>
                          )}
                        </span>
                        <span className="feedback-row-side">
                          <time>{formatFeedbackTimestamp(item.created_at)}</time>
                          <span className="prompt-activity-preview-label" aria-hidden="true">
                            <Eye size={14} /> Preview
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {filteredChatFeedback.length === 0 && filteredIssueReports.length === 0 && (
                <div className="audit-empty-state">
                  <MessageSquareText size={20} />
                  <span>
                    <strong>No feedback or issue reports submitted yet</strong>
                    <small>Response ratings and platform reports will appear here.</small>
                  </span>
                </div>
              )}
            </Panel>

            {feedbackPreview && (
              <FeedbackConversationPreview
                item={feedbackPreview}
                sentLabel={formatFeedbackTimestamp(feedbackPreview.created_at)}
                loadThreadRecords={
                  adminApi?.listThreadPromptActivity
                    ? (threadId) =>
                        Promise.resolve(
                          adminApi.listThreadPromptActivity!(data.me.id, threadId, mutationContext),
                        )
                    : undefined
                }
                onClose={() => setFeedbackPreview(null)}
              />
            )}
            {issueReportPreview && (
              <IssueReportPreview
                item={issueReportPreview}
                sentLabel={formatFeedbackTimestamp(issueReportPreview.created_at)}
                loadScreenshot={
                  adminApi?.loadIssueReportScreenshot
                    ? (reportId) => adminApi.loadIssueReportScreenshot!(data.me.id, reportId)
                    : undefined
                }
                onClose={() => setIssueReportPreview(null)}
              />
            )}
            <Panel
              className="model-activity-panel"
              title={
                <>
                  <BarChart3 size={18} /> Model Activity
                </>
              }
              subtitle="Saved admin and user prompt volume by model, date, and person for the selected range."
              actions={
                <button
                  className="secondary-button compact"
                  type="button"
                  data-tooltip="Reload admin-visible model activity from saved prompt records"
                  onClick={() => setAuditTrailRefreshToken((token) => token + 1)}
                >
                  <RefreshCw size={14} /> Refresh
                </button>
              }
              defaultCollapsed
            >
              <SectionScopeFilter
                label="Model activity filter"
                scope={activityScope}
                onChange={setActivityScope}
                users={adminAuditUserOptions}
                allUsersLabel="All admins and users"
                selectedCount={analyticsPromptActivityRows.length}
                totalCount={promptActivityRows.length}
              />
              {promptActivityError ? (
                <div className="audit-empty-state">
                  <ShieldAlert size={20} />
                  <span>
                    <strong>Model activity could not be loaded</strong>
                    <small>{promptActivityError}</small>
                  </span>
                </div>
              ) : !listPromptActivity ? (
                <div className="audit-empty-state">
                  <BarChart3 size={20} />
                  <span>
                    <strong>Model activity endpoint is not connected</strong>
                    <small>Usage charts load from saved prompt records when the admin API is available.</small>
                  </span>
                </div>
              ) : promptActivity === null ? (
                <div className="audit-empty-state">
                  <LineChart size={20} />
                  <span>
                    <strong>Model activity is loading</strong>
                    <small>Reading saved prompts for admins and users.</small>
                  </span>
                </div>
              ) : promptActivityRows.length === 0 ? (
                <div className="audit-empty-state">
                  <BarChart3 size={20} />
                  <span>
                    <strong>No model activity yet</strong>
                    <small>Saved tenant prompts will populate model and user usage charts.</small>
                  </span>
                </div>
              ) : analyticsPromptActivityRows.length === 0 ? (
                <div className="audit-empty-state">
                  <BarChart3 size={20} />
                  <span>
                    <strong>No model activity matches this filter</strong>
                    <small>Adjust this section's user or date filter to review older or newer prompt activity.</small>
                  </span>
                </div>
              ) : (
                <>
                  <div className="model-activity-chart-grid">
                    <section className="model-activity-card" aria-label="Admin model activity bar chart">
                      <div className="model-activity-chart-header">
                        <span>
                          <BarChart3 size={16} />
                          <strong>Prompts by model</strong>
                        </span>
                        <small>{analyticsPromptActivityRows.length.toLocaleString()} total prompts</small>
                      </div>
                      <div className="model-activity-bars">
                        {modelActivityRows.map((row) => (
                          <div className="model-activity-bar-row" key={row.modelId}>
                            <div>
                              <strong>{row.modelId}</strong>
                              <small>
                                {row.userCount} user{row.userCount === 1 ? "" : "s"} · latest{" "}
                                {formatAdminAuditTimestamp(row.latestAt)}
                              </small>
                            </div>
                            <span>{row.promptCount}</span>
                            <div className="model-activity-bar-track" aria-hidden="true">
                              <div className="model-activity-bar-fill" style={{ width: `${row.share}%` }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>

                    <section className="model-activity-card" aria-label="Admin model usage line chart">
                      <div className="model-activity-chart-header">
                        <span>
                          <LineChart size={16} />
                          <strong>Prompt trend</strong>
                        </span>
                        <small>
                          {promptUsageTrendRows.length} day{promptUsageTrendRows.length === 1 ? "" : "s"}
                        </small>
                      </div>
                      <div className="model-activity-line-chart">
                        <svg viewBox="0 0 320 140" role="img" aria-label="Admin prompt usage trend by day">
                          <path className="model-activity-line-grid" d="M18 18H302M18 70H302M18 122H302" />
                          {modelActivityLinePoints ? (
                            <>
                              <polyline className="model-activity-line" points={modelActivityLinePoints} />
                              {promptUsageTrendRows.map((row, index) => {
                                const point = promptUsageTrendPoint(row.count, index, promptUsageTrendRows);
                                return (
                                  <circle
                                    className="model-activity-line-point"
                                    cx={point.x}
                                    cy={point.y}
                                    key={row.dateKey}
                                    r="3.5"
                                  />
                                );
                              })}
                            </>
                          ) : null}
                        </svg>
                        <div className="model-activity-line-labels">
                          {promptUsageTrendRows.map((row) => (
                            <span key={row.dateKey}>
                              <strong>{row.count}</strong>
                              <small>{row.label}</small>
                            </span>
                          ))}
                        </div>
                      </div>
                    </section>
                  </div>

                  <section className="model-user-activity" aria-label="Admin users by prompt activity">
                    <div className="model-activity-chart-header">
                      <span>
                        <Users size={16} />
                        <strong>Users by prompt activity</strong>
                      </span>
                      <small>
                        {promptUserRows.length} active user{promptUserRows.length === 1 ? "" : "s"}
                      </small>
                    </div>
                    <div className="model-user-activity-list">
                      {promptUserRows.map((row) => (
                        <div className="model-user-activity-row" key={row.userId}>
                          <span>
                            <strong>{row.userName}</strong>
                            <small>
                              {row.modelCount} model{row.modelCount === 1 ? "" : "s"} used
                            </small>
                          </span>
                          <b>{row.promptCount}</b>
                        </div>
                      ))}
                    </div>
                  </section>
                </>
              )}
            </Panel>

            <Panel
              className="model-activity-panel"
              title={
                <>
                  <Users size={18} /> User Usage
                </>
              }
              subtitle="Durable usage for this organization's admins and users across chat, drafts, agents, automations, and the API gateway. Token counts are provider-reported only and stay blank when a provider reported none."
              actions={
                <>
                  <CsvExportControl
                    label="usage records"
                    filenameBase="aperture-admin-usage-records"
                    items={usageRecords}
                    getTimestamp={(item) => item.created_at}
                    columns={USAGE_RECORD_CSV_COLUMNS}
                  />
                  <button
                    className="secondary-button compact"
                    type="button"
                    data-tooltip="Reload usage records from the admin usage API"
                    onClick={() => setAuditTrailRefreshToken((token) => token + 1)}
                  >
                    <RefreshCw size={14} /> Refresh
                  </button>
                </>
              }
              defaultCollapsed
            >
              <SectionScopeFilter
                label="Usage filter"
                scope={usageScope}
                onChange={setUsageScope}
                users={adminAuditUserOptions}
                allUsersLabel="All admins and users"
                selectedCount={usageRecordsInScope.length}
                totalCount={usageRecords.length}
              />
              {usageError ? (
                <div className="audit-empty-state">
                  <ShieldAlert size={20} />
                  <span>
                    <strong>Usage analytics could not be loaded</strong>
                    <small>{usageError}</small>
                  </span>
                </div>
              ) : !adminApi?.getUsageSummary ? (
                <div className="audit-empty-state">
                  <BarChart3 size={20} />
                  <span>
                    <strong>Usage analytics endpoint is not connected</strong>
                    <small>Per-user usage loads from the admin usage API when it is available.</small>
                  </span>
                </div>
              ) : usageSummary === null ? (
                <div className="audit-empty-state">
                  <LineChart size={20} />
                  <span>
                    <strong>Usage analytics are loading</strong>
                    <small>Reading recorded completions for admins and users.</small>
                  </span>
                </div>
              ) : (
                <>
                  {usageSummary.totals.messages === 0 ? (
                    <div className="audit-empty-state">
                      <BarChart3 size={20} />
                      <span>
                        <strong>No usage recorded yet</strong>
                        <small>
                          Records appear as completions run. Prompts saved before usage tracking existed appear from
                          backfill with message counts only.
                        </small>
                      </span>
                    </div>
                  ) : (
                    <>
                      <div className="feedback-summary-grid usage-summary-grid">
                        <div className="feedback-summary-card">
                          <span>Messages</span>
                          <strong>{usageSummary.totals.messages.toLocaleString()}</strong>
                          <small>completions in range</small>
                        </div>
                        <div className="feedback-summary-card">
                          <span>Prompt tokens</span>
                          <strong>{formatTokenCount(usageSummary.totals.prompt_tokens)}</strong>
                          <small>{usageSummary.totals.prompt_tokens == null ? "not reported" : "provider-reported"}</small>
                        </div>
                        <div className="feedback-summary-card">
                          <span>Completion tokens</span>
                          <strong>{formatTokenCount(usageSummary.totals.completion_tokens)}</strong>
                          <small>{usageSummary.totals.completion_tokens == null ? "not reported" : "provider-reported"}</small>
                        </div>
                        <div className="feedback-summary-card">
                          <span>Total tokens</span>
                          <strong>{formatTokenCount(usageSummary.totals.total_tokens)}</strong>
                          <small>
                            {usageSummary.totals.tokens_reported_messages.toLocaleString()} of{" "}
                            {usageSummary.totals.messages.toLocaleString()} messages reported tokens
                          </small>
                        </div>
                        <div className="feedback-summary-card">
                          <span>Models used</span>
                          <strong>{usageSummary.totals.models_used.toLocaleString()}</strong>
                          <small>distinct models in range</small>
                        </div>
                      </div>

                      <div className="model-activity-chart-grid">
                        <section className="model-activity-card" aria-label="Usage by model bar chart">
                          <div className="model-activity-chart-header">
                            <span>
                              <BarChart3 size={16} />
                              <strong>Messages by model</strong>
                            </span>
                            <small>{usageSummary.by_model.length.toLocaleString()} models</small>
                          </div>
                          <div className="model-activity-bars">
                            {usageModelBarRows.map((row) => (
                              <div className="model-activity-bar-row" key={row.model_id}>
                                <div>
                                  <strong>{row.model_id}</strong>
                                  <small>
                                    {row.user_count} user{row.user_count === 1 ? "" : "s"}
                                    {row.total_tokens != null ? ` · ${formatTokenCount(row.total_tokens)} tokens` : ""}
                                  </small>
                                </div>
                                <span>{row.message_count}</span>
                                <div className="model-activity-bar-track" aria-hidden="true">
                                  <div className="model-activity-bar-fill" style={{ width: `${row.share}%` }} />
                                </div>
                              </div>
                            ))}
                          </div>
                        </section>

                        <section className="model-activity-card" aria-label="Usage trend line chart">
                          <div className="model-activity-chart-header">
                            <span>
                              <LineChart size={16} />
                              <strong>Message trend</strong>
                            </span>
                            <small>
                              {usageTrendRows.length} day{usageTrendRows.length === 1 ? "" : "s"}
                            </small>
                          </div>
                          <div className="model-activity-line-chart">
                            <svg viewBox="0 0 320 140" role="img" aria-label="Recorded usage trend by day">
                              <path className="model-activity-line-grid" d="M18 18H302M18 70H302M18 122H302" />
                              {usageTrendLinePoints ? (
                                <>
                                  <polyline className="model-activity-line" points={usageTrendLinePoints} />
                                  {usageTrendRows.map((row, index) => {
                                    const point = promptUsageTrendPoint(row.count, index, usageTrendRows);
                                    return (
                                      <circle
                                        className="model-activity-line-point"
                                        cx={point.x}
                                        cy={point.y}
                                        key={row.dateKey}
                                        r="3.5"
                                      />
                                    );
                                  })}
                                </>
                              ) : null}
                            </svg>
                            <div className="model-activity-line-labels">
                              {usageTrendRows.map((row) => (
                                <span key={row.dateKey}>
                                  <strong>{row.count}</strong>
                                  <small>{row.label}</small>
                                </span>
                              ))}
                            </div>
                          </div>
                        </section>
                      </div>

                      <section className="model-user-activity" aria-label="Usage by user">
                        <div className="model-activity-chart-header">
                          <span>
                            <Users size={16} />
                            <strong>Usage by user</strong>
                          </span>
                          <small>
                            {usageSummary.by_user.length.toLocaleString()} user
                            {usageSummary.by_user.length === 1 ? "" : "s"} · click a row to drill down
                          </small>
                        </div>
                        <div className="model-user-activity-list scrollable-log-list usage-user-list" role="list">
                          {usageSummary.by_user.map((row) => (
                            <button
                              className="model-user-activity-row usage-user-row"
                              key={row.user_id}
                              type="button"
                              role="listitem"
                              onClick={() =>
                                setUsageScope((scope) => ({
                                  ...scope,
                                  userId: scope.userId === row.user_id ? "all" : row.user_id,
                                }))
                              }
                              data-tooltip={`Show only ${row.user_name || row.user_id}'s usage`}
                            >
                              <span>
                                <strong>{row.user_name || row.user_id}</strong>
                                <small>
                                  {formatAdminAuditRole(row.user_role)} · {row.model_count} model
                                  {row.model_count === 1 ? "" : "s"} · {row.surfaces.join(", ")} · last active{" "}
                                  {formatAdminAuditTimestamp(row.last_active_at)}
                                </small>
                              </span>
                              <span className="usage-user-tokens">{formatTokenCount(row.total_tokens)} tokens</span>
                              <b>{row.message_count}</b>
                            </button>
                          ))}
                        </div>
                      </section>
                      {usageSummary.backfilled_record_count > 0 ? (
                        <p className="usage-token-muted">
                          {usageSummary.backfilled_record_count.toLocaleString()} older record
                          {usageSummary.backfilled_record_count === 1 ? "" : "s"} in range came from backfilled chat
                          history and may carry message counts only.
                        </p>
                      ) : null}
                    </>
                  )}
                </>
              )}
            </Panel>

            <TenantDailyBudgetPanel userId={data.me.id} />
            <UsageAllocationsPanel data={data} />
          </div>
        </Tabs.Content>

        <Tabs.Content value="policies" className="tab-content">
          <div className="admin-memory-stack">
            <AdminPolicyOverviewPanel
              data={data}
              defaultGroup={defaultGroup}
              memoryPolicy={memoryPolicy}
              pendingAction={pendingAction}
              onDefaultPermissionChange={toggleDefaultGroupPolicyPermission}
            />
            {memoryTabVisible ? (
              <MemoryAdminPanel
                policy={memoryPolicy}
                stats={memoryStats}
                error={memoryError}
                pendingAction={pendingAction}
                onPolicyChange={(patch) => void saveMemoryPolicy(patch)}
                onPurgeUser={(stat) => void purgeMemoriesForUser(stat)}
                onRefresh={() => setMemoryRefreshToken((token) => token + 1)}
              />
            ) : (
              <Panel
                title={<><Brain size={18} /> Memory governance</>}
                subtitle="Retention, automatic learning, and compliance purge controls become available when service policy permits memory."
                defaultCollapsed
              >
                <div className="policy-callout">
                  <Lock size={15} />
                  <span>Personalization memory is unavailable under the current service policy. Saved organization settings remain intact.</span>
                </div>
              </Panel>
            )}
            <RetentionPanel
              policy={retentionPolicy}
              error={retentionError}
              busy={pendingAction === "retention-policy"}
              onPolicyChange={(patch) => void saveRetentionPolicy(patch)}
            />
          </div>
        </Tabs.Content>

        <Tabs.Content value="audit" className="tab-content">
          <div className="audit-console-grid">
            <Panel
              title="Admin Audit"
              subtitle="Tenant security and governance signals for admin-visible users, prompts, connectors, SSO, models, and audit events."
            >
              <div className="audit-summary-grid">
                {adminAuditSummary.map((item) => (
                  <AuditSummaryCard item={item} key={item.label} />
                ))}
              </div>
            </Panel>

            <Panel
              title="Recent Governance Activity"
              subtitle="Current tenant snapshot for identity, user, model, and connector posture."
              defaultCollapsed
            >
              <div className="audit-row">
                <ListChecks size={17} />
                <span>
                  <strong>Identity</strong>
                  <small>{data.ssoConfigs.filter((config) => config.enforced).length} enforced SSO configuration</small>
                </span>
                <time>Now</time>
              </div>
              <div className="audit-row">
                <Users size={17} />
                <span>
                  <strong>Users</strong>
                  <small>{adminAuditUsers.filter((user) => user.active).length} active admins and users</small>
                </span>
                <time>Now</time>
              </div>
              <div className="audit-row">
                <Bot size={17} />
                <span>
                  <strong>Models</strong>
                  <small>{activeModelCount} tenant-available models with group access</small>
                </span>
                <time>Now</time>
              </div>
              <div className="audit-row">
                <Wrench size={17} />
                <span>
                  <strong>Connectors</strong>
                  <small>{data.connectors.filter((connector) => connector.tenant_enabled).length} tenant-enabled connectors</small>
                </span>
                <time>Now</time>
              </div>
            </Panel>

            <Panel
              title="User Prompt Activity"
              subtitle="Drill into saved prompts from this organization's admins and users by person, thread, model, and timestamp."
              actions={
                <>
                  <CsvExportControl
                    label={promptActivityExportLabel}
                    filenameBase={promptActivityFilename}
                    items={auditPromptActivityRows}
                    getTimestamp={(item) => item.created_at_iso || item.created_at}
                    columns={PROMPT_ACTIVITY_CSV_COLUMNS}
                  />
                  <button
                    className="secondary-button compact"
                    type="button"
                    data-tooltip="Reload prompt activity for the selected scope"
                    onClick={() => setAuditTrailRefreshToken((token) => token + 1)}
                  >
                    <RefreshCw size={14} /> Refresh monitor
                  </button>
                </>
              }
              defaultCollapsed
            >
              <div className="prompt-panel-view-switch" role="group" aria-label="Prompt panel view">
                <button
                  type="button"
                  className="secondary-button compact"
                  aria-pressed={promptPanelView === "prompts"}
                  onClick={() => setPromptPanelView("prompts")}
                >
                  Prompts
                </button>
                <button
                  type="button"
                  className="secondary-button compact"
                  aria-pressed={promptPanelView === "tags"}
                  onClick={() => setPromptPanelView("tags")}
                >
                  Tags
                </button>
              </div>
              {promptPanelView === "prompts" ? (
                <>
              <SectionScopeFilter
                label="Prompt activity filter"
                scope={promptScope}
                onChange={setPromptScope}
                users={adminAuditUserOptions}
                allUsersLabel="All admins and users"
                selectedCount={auditPromptActivityRows.length}
                totalCount={promptActivityRows.length}
              />
              {promptActivityError ? (
                <div className="audit-empty-state">
                  <ShieldAlert size={20} />
                  <span>
                    <strong>Prompt activity could not be loaded</strong>
                    <small>{promptActivityError}</small>
                  </span>
                </div>
              ) : !listPromptActivity ? (
                <div className="audit-empty-state">
                  <MessageSquareText size={20} />
                  <span>
                    <strong>Prompt activity endpoint is not connected</strong>
                    <small>Saved prompt records load from the admin API when it is available.</small>
                  </span>
                </div>
              ) : promptActivity === null ? (
                <div className="audit-empty-state">
                  <MessageSquareText size={20} />
                  <span>
                    <strong>Prompt activity is loading</strong>
                    <small>Reading saved chat prompts for the selected admin-visible scope.</small>
                  </span>
                </div>
              ) : promptActivityRows.length === 0 ? (
                <div className="audit-empty-state">
                  <MessageSquareText size={20} />
                  <span>
                    <strong>No saved prompts found</strong>
                    <small>Prompts appear here after an admin or user sends and saves chat activity.</small>
                  </span>
                </div>
              ) : auditPromptActivityRows.length === 0 ? (
                <div className="audit-empty-state">
                  <MessageSquareText size={20} />
                  <span>
                    <strong>No prompts match this filter</strong>
                    <small>Adjust this section's user or date filter to review older or newer prompt activity.</small>
                  </span>
                </div>
              ) : (
                <PromptActivityList
                  records={auditPromptActivityRows}
                  ariaLabel="Admin user prompt activity"
                  formatTimestamp={formatPromptRecordTimestamp}
                  extraThreadSearchText={promptSearchExtras}
                  loadThreadRecords={
                    listThreadPromptActivity
                      ? (threadId) => listThreadPromptActivity(data.me.id, threadId, mutationContext)
                      : undefined
                  }
                />
              )}
                </>
              ) : (
                <RetentionTagsView
                  tagged={retentionTagged}
                  error={retentionError}
                  busy={pendingAction === "retention-batch"}
                  onRefresh={() => setRetentionRefreshToken((token) => token + 1)}
                  loadThreadRecords={
                    adminApi?.listThreadPromptActivity
                      ? (threadId) =>
                          Promise.resolve(
                            adminApi.listThreadPromptActivity!(
                              data.me.id,
                              threadId,
                              mutationContext,
                            ),
                          )
                      : undefined
                  }
                  onBatchAction={
                    adminApi?.runRetentionBatch
                      ? (action, threadIds) => runRetentionBatchAction(action, threadIds)
                      : undefined
                  }
                />
              )}
            </Panel>

            <Panel
              title="Security Alerts"
              subtitle="DLP and malicious-behavior flags raised from admin and user prompts, with redacted snippets for review."
              defaultCollapsed
            >
              <SectionScopeFilter
                label="Security alert filter"
                scope={securityScope}
                onChange={setSecurityScope}
                users={adminAuditUserOptions}
                allUsersLabel="All admins and users"
                selectedCount={auditSecurityAlerts.length}
                totalCount={securityAlertRows.length}
              />
              <div className="audit-alert-summary">
                <Pill tone={unacknowledgedSecurityAlerts.length ? "warning" : "success"}>
                  {unacknowledgedSecurityAlerts.length} active
                </Pill>
                <Pill tone="neutral">
                  {auditSecurityAlerts.filter((alert) => alert.acknowledged).length} acknowledged
                </Pill>
              </div>

              {securityAlertsError ? (
                <div className="audit-empty-state">
                  <ShieldAlert size={20} />
                  <span>
                    <strong>Security alerts could not be loaded</strong>
                    <small>{securityAlertsError}</small>
                  </span>
                </div>
              ) : !listSecurityAlerts ? (
                <div className="audit-empty-state">
                  <ShieldAlert size={20} />
                  <span>
                    <strong>Security alert endpoint is not connected</strong>
                    <small>DLP and behavior alerts load from the admin API when it is available.</small>
                  </span>
                </div>
              ) : securityAlerts === null ? (
                <div className="audit-empty-state">
                  <ShieldAlert size={20} />
                  <span>
                    <strong>Security alerts are loading</strong>
                    <small>Reading DLP and misuse flags for the selected admin-visible scope.</small>
                  </span>
                </div>
              ) : securityAlertRows.length === 0 ? (
                <div className="audit-empty-state">
                  <ShieldCheck size={20} />
                  <span>
                    <strong>No security alerts for this scope</strong>
                    <small>Prompts matching DLP or malicious-behavior rules will appear here with redacted context.</small>
                  </span>
                </div>
              ) : auditSecurityAlerts.length === 0 ? (
                <div className="audit-empty-state">
                  <ShieldCheck size={20} />
                  <span>
                    <strong>No security alerts match this filter</strong>
                    <small>Adjust this section's user or date filter to review older or newer alert activity.</small>
                  </span>
                </div>
              ) : (
                <div className="security-alert-list scrollable-log-list" role="list" aria-label="Admin security alerts">
                  {auditSecurityAlerts.map((alert) => {
                    const actionKey = `security-alert:${alert.id}`;
                    return (
                      <div className={`security-alert-row${alert.acknowledged ? " is-acknowledged" : ""}`} role="listitem" key={alert.id}>
                        {alert.acknowledged ? <ShieldCheck size={17} /> : <ShieldAlert size={17} />}
                        <span>
                          <strong>{alert.rule_label}</strong>
                          <small>
                            {alert.user_name || alert.user_id} · {alert.model_id || "unknown model"} ·{" "}
                            {formatSecurityAlertTimestamp(alert.created_at)}
                          </small>
                          <p>{alert.snippet || "No snippet available."}</p>
                        </span>
                        <div className="security-alert-actions">
                          <Pill tone={alert.acknowledged ? "neutral" : securityAlertPillTone(alert)}>
                            {alert.acknowledged ? "Acknowledged" : alert.severity}
                          </Pill>
                          <button
                            className="secondary-button compact"
                            type="button"
                            disabled={!adminApi?.acknowledgeSecurityAlert || pendingAction === actionKey}
                            onClick={() => void setSecurityAlertAcknowledged(alert, !alert.acknowledged)}
                          >
                            {alert.acknowledged ? "Reopen" : "Acknowledge"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Panel>

            <Panel
              title="Audit Trail"
              subtitle="Append-only transaction log of this organization's admin, user, chat, and knowledge activity, newest first."
              defaultCollapsed
              actions={
                <>
                  <CsvExportControl
                    label="admin audit trail"
                    filenameBase="aperture-admin-audit-trail"
                    items={visibleAuditTrailRows}
                    getTimestamp={(item) => item.created_at}
                    columns={AUDIT_TRAIL_CSV_COLUMNS}
                  />
                  <button
                    className="secondary-button compact"
                    type="button"
                    data-tooltip="Reload the audit trail to show the newest tenant events"
                    onClick={() => setAuditTrailRefreshToken((token) => token + 1)}
                  >
                    <RefreshCw size={14} /> Refresh
                  </button>
                </>
              }
            >
              <SectionScopeFilter
                label="Audit trail filter"
                scope={trailScope}
                onChange={setTrailScope}
                users={adminAuditUserOptions}
                allUsersLabel="All admins and users"
                selectedCount={auditTrailRows.length}
                totalCount={adminVisibleAuditTrailRows.length}
              />
              {auditTrailError ? (
                <div className="audit-empty-state">
                  <ShieldAlert size={20} />
                  <span>
                    <strong>Audit trail could not be loaded</strong>
                    <small>{auditTrailError}</small>
                  </span>
                </div>
              ) : auditTrail === null ? (
                <div className="audit-empty-state">
                  <ListChecks size={20} />
                  <span>
                    <strong>Audit trail not connected</strong>
                    <small>Tenant events load from the admin audit API when it is available.</small>
                  </span>
                </div>
              ) : auditTrail.length === 0 ? (
                <div className="audit-empty-state">
                  <ListChecks size={20} />
                  <span>
                    <strong>No tenant audit events recorded yet</strong>
                    <small>User, group, grant, knowledge, and chat governance events will appear here as they happen.</small>
                  </span>
                </div>
              ) : auditTrailRows.length === 0 ? (
                <div className="audit-empty-state">
                  <ListChecks size={20} />
                  <span>
                    <strong>No audit events match this filter</strong>
                    <small>Adjust this section's user or date filter to review older or newer tenant events.</small>
                  </span>
                </div>
              ) : (
                <>
                  <div className="audit-filter-toolbar">
                    <SelectControl
                      value={auditSeverityFilter}
                      onChange={(event) => setAuditSeverityFilter(event.target.value)}
                      aria-label="Filter audit events by severity"
                      data-tooltip="Show only audit events at the selected severity"
                    >
                      <option value="all">All severities</option>
                      <option value="critical">Critical</option>
                      <option value="warning">Warning</option>
                      <option value="info">Info</option>
                    </SelectControl>
                    <SelectControl
                      value={auditNamespaceFilter}
                      onChange={(event) => setAuditNamespaceFilter(event.target.value)}
                      aria-label="Filter audit events by category"
                      data-tooltip="Show only audit events from the selected action category"
                    >
                      <option value="all">All categories</option>
                      {auditNamespaceOptions.map((namespace) => (
                        <option key={namespace} value={namespace}>
                          {namespace}
                        </option>
                      ))}
                    </SelectControl>
                    <input
                      className="audit-search-input"
                      type="search"
                      value={auditSearchQuery}
                      onChange={(event) => setAuditSearchQuery(event.target.value)}
                      placeholder="Search actions, people, targets…"
                      aria-label="Search audit events"
                    />
                    <span className="audit-filter-count">
                      {visibleAuditTrailRows.length} of {auditTrailRows.length} events
                    </span>
                  </div>
                  {visibleAuditTrailRows.length === 0 ? (
                    <div className="audit-empty-state">
                      <ListChecks size={20} />
                      <span>
                        <strong>No audit events match these filters</strong>
                        <small>Clear the severity, category, or search filters to see more events.</small>
                      </span>
                    </div>
                  ) : (
                    <div className="audit-trail-list scrollable-log-list" role="list" aria-label="Admin tenant audit events">
                      {visibleAuditTrailRows.map((event) => {
                        const severity = auditEventSeverity(event);
                        return (
                          <div className="audit-row" role="listitem" key={event.id}>
                            <ListChecks size={17} />
                            <span>
                              <strong>{event.action_type || event.action}</strong>
                              <small>
                                {event.actor_name} ({formatAdminAuditRole(event.actor_role)}) · {event.target_type}:{" "}
                                {event.target_name || event.target}
                                {event.detail ? ` · ${event.detail}` : ""}
                              </small>
                            </span>
                            <span
                              className="audit-severity-pill"
                              data-tooltip={event.severity_reason || "No elevated rule matched; routine activity."}
                            >
                              <Pill tone={auditSeverityPillTone(severity)}>{severity}</Pill>
                            </span>
                            <time dateTime={event.created_at}>{formatAdminAuditTimestamp(event.created_at)}</time>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </Panel>
          </div>
        </Tabs.Content>

        <Tabs.Content value="alerts" className="tab-content">
          <AlertsConsole variant="admin" api={alertsApi} actorOptions={alertActorOptions} />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}

function GroupManagementPanel({
  data,
  selectedGroupId,
  selectedGroupIdsForRemoval,
  pendingAction,
  showCreate,
  groupDraft,
  bulkUserText,
  onSelect,
  onToggleCreate,
  onDraftChange,
  onBulkUserTextChange,
  onCreate,
  onImportUsers,
  onDelete,
  onDeleteSelected,
  onToggleRemoval,
  onPermissionChange,
  onUserMembershipChange,
}: {
  data: BootstrapData;
  selectedGroupId?: string;
  selectedGroupIdsForRemoval: string[];
  pendingAction: string | null;
  showCreate: boolean;
  groupDraft: AdminGroupCreateInput;
  bulkUserText: string;
  onSelect: (groupId: string) => void;
  onToggleCreate: () => void;
  onDraftChange: (draft: AdminGroupCreateInput) => void;
  onBulkUserTextChange: (text: string) => void;
  onCreate: () => void;
  onImportUsers: (group: Group) => void;
  onDelete: (groupId: string) => void;
  onDeleteSelected: () => void;
  onToggleRemoval: (groupId: string, selected: boolean) => void;
  onPermissionChange: (key: string, next: boolean) => void;
  onUserMembershipChange: (user: User, group: Group, next: boolean) => void;
}) {
  const selectedGroup = data.groups.find((group) => group.id === selectedGroupId) ?? defaultGroupFor(data) ?? data.groups[0];
  const [groupDetailTab, setGroupDetailTab] = useState("users");
  const selectedPermissions = selectedGroup ? permissionsForGroup(selectedGroup) : defaultGroupPermissions();
  const selectedPlatformUsers = selectedGroup ? groupMemberCount(data, selectedGroup.id) : 0;
  const pendingUsers = data.visibleUsers.filter((user) => isPendingPlatformUser(user)).length;
  const removableSelectedCount = selectedGroupIdsForRemoval.filter((groupId) =>
    data.groups.some((group) => group.id === groupId && !group.default_group),
  ).length;

  return (
    <Panel
      className="group-list group-management-panel"
      title="Groups"
      subtitle="Create platform groups, assign users, and tune group permissions. Default Users stays protected for baseline access."
      actions={
        <button
          className="secondary-button compact"
          type="button"
          data-tooltip={showCreate ? "Close the group creation form without saving" : "Open a form to create a new platform group"}
          onClick={onToggleCreate}
        >
          {showCreate ? <X size={15} /> : <FolderPlus size={15} />}
          <StableLabel label={showCreate ? "Close" : "Add Group"} reserve={["Close", "Add Group"]} />
        </button>
      }
    >
      <div className="group-workspace">
        {showCreate && (
          <div className="group-section-panel">
            <div className="inline-form group-create-form">
              <label>
                Group name
                <input value={groupDraft.name} onChange={(event) => onDraftChange({ ...groupDraft, name: event.target.value })} />
              </label>
              <label>
                Optional SSO group ID
                <input
                  value={groupDraft.entra_object_id}
                  onChange={(event) => onDraftChange({ ...groupDraft, entra_object_id: event.target.value })}
                />
              </label>
              <button
                className="primary-button form-submit-button"
                type="button"
                data-tooltip="Create this group so you can assign users and permissions"
                onClick={onCreate}
                disabled={pendingAction === "create-group"}
              >
                <FolderPlus size={16} /> Create group
              </button>
            </div>
          </div>
        )}

        <div className="group-section-panel group-catalog-panel">
          <div className="group-toolbar">
            <span>
              {data.groups.length} platform group{data.groups.length === 1 ? "" : "s"} · {pendingUsers} unassigned user{pendingUsers === 1 ? "" : "s"}
            </span>
            <button
              className="secondary-button compact danger-lite-button"
              type="button"
              data-tooltip="Permanently delete the checked groups and their member assignments"
              onClick={onDeleteSelected}
              disabled={removableSelectedCount === 0 || pendingAction === "delete-groups"}
            >
              <Trash2 size={14} /> Remove selected
            </button>
          </div>

          <div className="managed-group-list">
            {data.groups.map((group) => {
              const markedForRemoval = selectedGroupIdsForRemoval.includes(group.id);
              const memberCount = groupMemberCount(data, group.id);
              const protectedDefault = Boolean(group.default_group);
              return (
                <div key={group.id} className={`group-card managed-group-card ${group.id === selectedGroupId ? "is-active" : ""}`}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${group.name} for removal`}
                    checked={markedForRemoval}
                    disabled={protectedDefault}
                    onChange={(event) => onToggleRemoval(group.id, event.target.checked)}
                  />
                  <button
                    className="group-card-main"
                    type="button"
                    data-tooltip={`Select ${group.name} to review its members and permissions`}
                    onClick={() => onSelect(group.id)}
                  >
                    <Users size={22} />
                    <span>
                      <strong>{group.name}</strong>
                      <small>{memberCount} platform member{memberCount === 1 ? "" : "s"}</small>
                    </span>
                    <Pill tone={protectedDefault ? "success" : "info"}>
                      {protectedDefault ? "Default group" : "Platform group"}
                    </Pill>
                  </button>
                  <button
                    className="secondary-button compact"
                    type="button"
                    data-tooltip={`Open ${group.name} settings to manage users, permissions, and imports`}
                    onClick={() => {
                      onSelect(group.id);
                      setGroupDetailTab("users");
                    }}
                  >
                    Manage
                  </button>
                  <button
                    className="icon-button danger-lite-button"
                    type="button"
                    aria-label={`Remove ${group.name}`}
                    data-tooltip={
                      protectedDefault
                        ? `${group.name} is the protected default group and cannot be deleted`
                        : `Permanently delete ${group.name} and its member assignments`
                    }
                    onClick={() => onDelete(group.id)}
                    disabled={protectedDefault || pendingAction === `delete-group-${group.id}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {selectedGroup ? (
          <section className="group-section-panel selected-group-panel" aria-label={`${selectedGroup.name} group settings`}>
            <header className="group-workspace-summary">
              <span>
                <strong>{selectedGroup.name}</strong>
                <small>
                  {selectedGroup.default_group
                    ? "Protected baseline group for fast user provisioning. Permissions and model grants remain adjustable."
                    : "Managed in this admin console. Optional SSO mappings only admit users into pending access."}
                </small>
              </span>
              <dl>
                <div>
                  <dt>Members</dt>
                  <dd>{selectedPlatformUsers}</dd>
                </div>
                <div>
                  <dt>Unassigned users</dt>
                  <dd>{pendingUsers}</dd>
                </div>
                <div>
                  <dt>Permissions on</dt>
                  <dd>{Object.values(selectedPermissions).filter(Boolean).length}</dd>
                </div>
              </dl>
              <Pill tone="success">{selectedGroup.default_group ? "Protected" : "Active"}</Pill>
            </header>

            <Tabs.Root value={groupDetailTab} onValueChange={setGroupDetailTab} className="group-section-tabs">
              <Tabs.List className="section-tabs-list" aria-label={`${selectedGroup.name} group controls`}>
                {["Users", "Permissions", "Import"].map((tab) => (
                  <Tabs.Trigger
                    key={tab}
                    className="section-tab-trigger"
                    value={tab.toLowerCase()}
                    data-tooltip={`Open the ${tab} settings for ${selectedGroup.name}`}
                  >
                    {tab}
                  </Tabs.Trigger>
                ))}
              </Tabs.List>

              <Tabs.Content value="users" className="section-tab-content">
                <GroupUsersSection
                  data={data}
                  group={selectedGroup}
                  pendingAction={pendingAction}
                  onUserMembershipChange={onUserMembershipChange}
                />
              </Tabs.Content>

              <Tabs.Content value="permissions" className="section-tab-content">
                <GroupPermissionsSection
                  group={selectedGroup}
                  pendingAction={pendingAction}
                  downstreamApiEnabled={Boolean(data.platformSettings?.downstream_api_enabled)}
                  onPermissionChange={onPermissionChange}
                />
              </Tabs.Content>

              <Tabs.Content value="import" className="section-tab-content">
                <GroupImportSection
                  group={selectedGroup}
                  bulkUserText={bulkUserText}
                  pendingAction={pendingAction}
                  onBulkUserTextChange={onBulkUserTextChange}
                  onImportUsers={onImportUsers}
                />
              </Tabs.Content>
            </Tabs.Root>
          </section>
        ) : (
          <section className="group-section-panel group-editor-empty">
            <strong>No group selected</strong>
            <span>Create a group to assign users and permissions.</span>
          </section>
        )}
      </div>
    </Panel>
  );
}

function GroupImportSection({
  group,
  bulkUserText,
  pendingAction,
  onBulkUserTextChange,
  onImportUsers,
}: {
  group: Group;
  bulkUserText: string;
  pendingAction: string | null;
  onBulkUserTextChange: (text: string) => void;
  onImportUsers: (group: Group) => void;
}) {
  return (
    <section className="group-section-panel group-import-panel" aria-label={`${group.name} import users`}>
      <div className="group-editor-section">
        <header>
          <strong>Import Users to {group.name}</strong>
          <small>Paste existing platform user emails. Users keep current groups and are added to this group.</small>
        </header>
        <div className="bulk-group-import">
          <label>
            User emails
            <textarea
              value={bulkUserText}
              onChange={(event) => onBulkUserTextChange(event.target.value)}
              placeholder="One email per line, or paste comma-separated emails"
              rows={4}
            />
          </label>
          <button
            className="secondary-button"
            type="button"
            data-tooltip={`Add every pasted email address as a member of ${group.name}`}
            onClick={() => onImportUsers(group)}
            disabled={pendingAction === `group-import-${group.id}`}
          >
            <Upload size={15} /> Add users to group
          </button>
        </div>
      </div>
    </section>
  );
}

function GroupUsersSection({
  data,
  group,
  pendingAction,
  onUserMembershipChange,
}: {
  data: BootstrapData;
  group?: Group;
  pendingAction: string | null;
  onUserMembershipChange: (user: User, group: Group, next: boolean) => void;
}) {
  if (!group) {
    return (
      <section className="group-section-panel group-editor-empty">
        <strong>No group selected</strong>
        <span>Create or import a group to edit users.</span>
      </section>
    );
  }

  const groupEditorUsers = data.visibleUsers.filter((user) => user.role !== "PLATFORM_OWNER");

  return (
    <section className="group-section-panel" aria-label={`${group.name} users`}>
      <div className="group-editor-section">
        <header>
          <strong>Platform Users</strong>
          <small>Toggle membership for users visible in this tenant.</small>
        </header>
        <div className="table-scroll group-user-table-scroll">
          <table className="data-table group-user-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Status</th>
                <th>Member</th>
              </tr>
            </thead>
            <tbody>
              {groupEditorUsers.map((user) => {
                const isMember = user.group_ids.includes(group.id);
                const pending = isPendingPlatformUser(user);
                const editable = canModifyUser(data.me, user);
                const pendingKey = `group-user-${group.id}-${user.id}`;
                return (
                  <tr key={user.id}>
                    <td data-label="User">
                      <span
                        className="person-cell compact-person-cell user-identity-cell"
                        tabIndex={0}
                        data-tooltip={userIdentityTooltip(user)}
                      >
                        <UserAvatar user={user} className="mini-avatar" />
                        <span>
                          <strong>{user.display_name}</strong>
                          <small>{user.email}</small>
                        </span>
                      </span>
                    </td>
                    <td data-label="Role">{ROLE_LABELS[user.role]}</td>
                    <td data-label="Status">
                      <Pill tone={isMember ? "success" : pending ? "warning" : "neutral"}>
                        {isMember ? "In group" : pending ? "Pending" : "Not in group"}
                      </Pill>
                    </td>
                    <td data-label="Member">
                      <Toggle
                        checked={isMember}
                        disabled={!editable || pendingAction === pendingKey}
                        label={`${isMember ? "Remove" : "Add"} ${user.display_name} ${isMember ? "from" : "to"} ${group.name}`}
                        tooltip={
                          isMember
                            ? `Remove ${user.display_name} from ${group.name} and its access`
                            : `Add ${user.display_name} to ${group.name} and grant its access`
                        }
                        onChange={(next) => onUserMembershipChange(user, group, next)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function GroupPermissionsSection({
  group,
  pendingAction,
  downstreamApiEnabled,
  onPermissionChange,
}: {
  group?: Group;
  pendingAction: string | null;
  downstreamApiEnabled: boolean;
  onPermissionChange: (key: string, next: boolean) => void;
}) {
  if (!group) {
    return (
      <section className="group-section-panel group-editor-empty">
        <strong>No group selected</strong>
        <span>Create or import a group to edit permissions.</span>
      </section>
    );
  }

  const permissions = permissionsForGroup(group);

  return (
    <section className="group-section-panel" aria-label={`${group.name} permissions`}>
      <div className="group-editor-section">
        <header>
          <strong>Group Permissions</strong>
          <small>Core permissions begin on. API access is opt-in for each group.</small>
        </header>
        <div className="group-permission-grid">
          {GROUP_PERMISSION_SECTIONS.map((section) => (
            <section className="permission-section" key={section.title}>
              <strong>{section.title}</strong>
              {section.permissions.map((permission) => {
                const Icon = permission.icon;
                const checked = Boolean(permissions[permission.key]);
                const blockedByServicePolicy =
                  permission.key === "api_access" && !downstreamApiEnabled && !checked;
                return (
                  <div className="permission-row detailed-permission-row" key={permission.key}>
                    <span>
                      <span className="perm-icon">
                        <Icon size={14} />
                      </span>
                      <span>
                        <strong>{permission.label}</strong>
                        <small>
                          {blockedByServicePolicy
                            ? "Downstream API access is unavailable under the current service policy."
                            : permission.description}
                        </small>
                      </span>
                    </span>
                    <Toggle
                      checked={checked}
                      disabled={
                        blockedByServicePolicy ||
                        pendingAction === `group-permission-${group.id}-${permission.key}`
                      }
                      label={permission.label}
                      tooltip={
                        blockedByServicePolicy
                          ? "Downstream API access is unavailable under the current service policy"
                          : checked
                          ? `Turn off "${permission.label}" to restrict ${group.name}`
                          : `Turn on "${permission.label}" for ${group.name}`
                      }
                      onChange={(next) => onPermissionChange(permission.key, next)}
                    />
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}

function canModifyUser(actor: User, target: User) {
  if (actor.role === "PLATFORM_OWNER") return true;
  if (actor.role !== "TENANT_ADMIN") return false;
  return target.tenant_id === actor.tenant_id && target.role !== "TENANT_ADMIN" && target.role !== "PLATFORM_OWNER";
}

/* Owners may delete admins and users; tenant admins may delete regular users
 * in their own tenant. Nobody deletes owners or their own account. The API
 * enforces the same boundary server-side. */
function canDeleteUser(actor: User, target: User) {
  if (target.id === actor.id || target.role === "PLATFORM_OWNER") return false;
  return canModifyUser(actor, target);
}

function adminRuntimeAuditRows(events: AuditEvent[]): RuntimeAuditRow[] {
  return events
    .map((event) => {
      const metadata = asRecord(event.metadata);
      const runtimeContext = asRecord(metadata.runtime_context);
      const action = event.action || "";
      const surfaceValue = stringValue(metadata.surface) || stringValue(runtimeContext.surface);
      const isChatCompletion = action === "chat.completion" || action === "gateway.chat_completion" || action === "gateway.responses";
      if (!isChatCompletion && !surfaceValue) return null;
      const surface: "chat" | "draft" = surfaceValue === "draft" ? "draft" : "chat";
      const executedAt =
        stringValue(metadata.execution_started_at) ||
        stringValue(runtimeContext.execution_started_at) ||
        event.created_at;
      const clientStartedAt = stringValue(metadata.client_started_at) || stringValue(runtimeContext.client_started_at);
      const provider = stringValue(metadata.provider) || stringValue(metadata.provider_name) || stringValue(metadata.provider_kind) || "provider";
      const draftTitle = stringValue(metadata.draft_title) || stringValue(runtimeContext.draft_title);
      const threadId = stringValue(metadata.thread_id) || stringValue(runtimeContext.thread_id);
      const messageCount = numberValue(metadata.message_count) ?? numberValue(runtimeContext.message_count);
      const target = surface === "draft" ? draftTitle || "Draft execution" : threadId || "Chat completion";
      return {
        id: event.id,
        surface,
        title: surface === "draft" ? "Draft execution" : "Chat completion",
        detail: `${event.actor_name || event.actor_id} · ${provider}${
          messageCount ? ` · ${messageCount} message${messageCount === 1 ? "" : "s"}` : ""
        }`,
        metadata: `${target}${clientStartedAt ? ` · client started ${formatAdminAuditTimestamp(clientStartedAt)}` : ""}`,
        executedAt,
        actorRole: event.actor_role,
        actorId: event.actor_id,
        actorName: event.actor_name || event.actor_id,
      };
    })
    .filter((item): item is RuntimeAuditRow => item !== null);
}

function adminAuditSummaryCards(
  data: BootstrapData,
  securityAlerts: SecurityAlert[],
  auditTrailRows: AuditEvent[],
  promptRows: UserPromptRecord[],
): AuditSummaryItem[] {
  const activeVisibleUsers = data.visibleUsers.filter((user) => user.active && user.role !== "PLATFORM_OWNER");
  const adminUsers = activeVisibleUsers.filter((user) => user.role === "TENANT_ADMIN");
  const regularUsers = activeVisibleUsers.filter((user) => user.role !== "TENANT_ADMIN");
  const connectorIssueRecords = data.connectors.filter((connector) => connector.tenant_enabled && connector.auth_status === "error");
  const ungroupedModelRecords = data.models.filter((model) => model.platform_enabled && model.group_ids.length === 0);
  const activePromptAlerts = securityAlerts.filter((alert) => !alert.acknowledged);
  const criticalEvents = auditTrailRows.filter((event) => auditEventSeverity(event) === "critical");

  return [
    {
      label: "Audit events",
      value: String(auditTrailRows.length),
      detail: "tenant events in range",
      issue: false,
      description: "Tenant-scoped audit events currently loaded for this organization's admin and user activity.",
      sections: [
        {
          label: "Audit events",
          emptyText: "No tenant audit events are present in the current range.",
          items: auditTrailRows.map((event) => ({
            label: event.action_type || event.action,
            detail: `${event.actor_name || event.actor_id} · ${event.target_name || event.target || "No target"} · ${formatAdminAuditTimestamp(event.created_at)}${event.detail ? ` · ${event.detail}` : ""}`,
          })),
        },
      ],
    },
    {
      label: "Critical events",
      value: String(criticalEvents.length),
      detail: "high-severity audit events",
      issue: criticalEvents.length > 0,
      description: "Critical-severity tenant audit events in the currently loaded admin audit range.",
      sections: [
        {
          label: "Critical audit events",
          emptyText: "No critical-severity audit events are present in this snapshot.",
          items: criticalEvents.map((event) => ({
            label: event.action_type || event.action,
            detail: `${event.actor_name || event.actor_id} · ${event.target_name || event.target || "No target"} · ${formatAdminAuditTimestamp(event.created_at)}${event.detail ? ` · ${event.detail}` : ""}`,
          })),
        },
      ],
    },
    {
      label: "Prompt watchlist",
      value: String(activePromptAlerts.length),
      detail: "active DLP or misuse alerts",
      issue: activePromptAlerts.length > 0,
      description: "Unacknowledged DLP and behavior alerts raised for users visible to this tenant administrator.",
      sections: [
        {
          label: "Active prompt alerts",
          emptyText: "No unacknowledged DLP or misuse alerts are active for admin-visible users.",
          items: activePromptAlerts.map((alert) => ({
            label: alert.rule_label,
            detail: `${alert.user_name || alert.user_id} · ${alert.model_id || "unknown model"} · ${alert.severity} ${alert.category} · ${alert.surface} · ${formatSecurityAlertTimestamp(alert.created_at)}${alert.snippet ? ` · ${alert.snippet}` : ""}`,
          })),
        },
      ],
    },
    {
      label: "Prompt volume",
      value: String(promptRows.length),
      detail: "saved prompts in scope",
      issue: false,
      description: "Saved prompt records in the current admin-visible scope, including the user, thread, model, and alert count.",
      sections: [
        {
          label: "Saved prompt records",
          emptyText: "No saved prompts are present in the current scope.",
          items: promptRows.map((record) => ({
            label: record.thread_title,
            detail: `${record.user_name || record.user_id} · ${record.model_id} · ${formatPromptRecordTimestamp(record)} · ${record.alert_count} alert${record.alert_count === 1 ? "" : "s"}`,
          })),
        },
      ],
    },
    {
      label: "Active admins",
      value: String(adminUsers.length),
      detail: "tenant admin accounts",
      issue: adminUsers.length === 0,
      description: "Active tenant-administrator accounts visible inside this organization.",
      sections: [
        {
          label: "Active tenant administrators",
          emptyText: "No active tenant admin accounts were found.",
          items: adminUsers.map((user) => ({
            label: user.display_name || user.email,
            detail: `${user.email} · ${user.auth_method || "authentication method not recorded"} · last active ${user.last_active}`,
          })),
        },
      ],
    },
    {
      label: "Active users",
      value: String(regularUsers.length),
      detail: "non-owner user accounts",
      issue: false,
      description: "Active non-owner user accounts visible to this tenant administrator.",
      sections: [
        {
          label: "Active non-owner users",
          emptyText: "No active non-owner users are visible to this administrator.",
          items: regularUsers.map((user) => ({
            label: user.display_name || user.email,
            detail: `${user.email} · ${formatAdminAuditRole(user.role)} · ${user.group_ids.length} group${user.group_ids.length === 1 ? "" : "s"} · last active ${user.last_active}`,
          })),
        },
      ],
    },
    {
      label: "Connector issues",
      value: String(connectorIssueRecords.length),
      detail: "tenant connectors in error",
      issue: connectorIssueRecords.length > 0,
      description: "Tenant-enabled connectors whose current authentication state is reporting an error.",
      sections: [
        {
          label: "Tenant connector authentication errors",
          emptyText: "No tenant-enabled connectors are currently reporting authentication errors.",
          items: connectorIssueRecords.map((connector) => ({
            label: connector.name,
            detail: `${connector.category} · ${connector.description || "Authentication error"} · last sync ${connector.last_sync || "not recorded"}`,
          })),
        },
      ],
    },
    {
      label: "Ungrouped models",
      value: String(ungroupedModelRecords.length),
      detail: "enabled models without groups",
      issue: ungroupedModelRecords.length > 0,
      description: "Enabled models without tenant group grants, which can make model access broader than intended.",
      sections: [
        {
          label: "Models without tenant group grants",
          emptyText: "Every enabled model has at least one tenant group grant, or no enabled models are present.",
          items: ungroupedModelRecords.map((model) => ({
            label: model.name,
            detail: `${model.provider_name || model.provider_id} · enabled · 0 group grants`,
          })),
        },
      ],
    },
  ];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatPromptRecordTimestamp(record: UserPromptRecord) {
  return formatAdminAuditTimestamp(record.created_at_iso || record.created_at);
}

function formatSecurityAlertTimestamp(value: string) {
  return formatAdminAuditTimestamp(value);
}

function securityAlertPillTone(alert: SecurityAlert): "warning" | "danger" | "info" {
  if (alert.severity.toLowerCase() === "high") return "danger";
  if (alert.category.toLowerCase() === "behavior") return "warning";
  return "info";
}

function formatTokenCount(value: number | null | undefined): string {
  // Token counts are provider-reported only; a missing value renders as a
  // dash, never a fabricated zero.
  return value == null ? "—" : value.toLocaleString();
}

function auditEventSeverity(event: AuditEvent): "info" | "warning" | "critical" {
  // Severity is derived server-side; events from older API builds fall back to info.
  const severity = (event.severity || "").toLowerCase();
  return severity === "critical" || severity === "warning" ? severity : "info";
}

function auditSeverityPillTone(severity: string): "neutral" | "warning" | "danger" {
  if (severity === "critical") return "danger";
  if (severity === "warning") return "warning";
  return "neutral";
}

function matchesAuditSearch(event: AuditEvent, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [event.action, event.action_type, event.actor_name, event.target_name, event.target, event.detail]
    .some((value) => (value || "").toLowerCase().includes(needle));
}

function buildPromptModelActivityRows(records: UserPromptRecord[]) {
  const byModel = new Map<
    string,
    {
      modelId: string;
      promptCount: number;
      userIds: Set<string>;
      latestAt: string;
      latestMs: number;
    }
  >();

  records.forEach((record) => {
    const modelId = record.model_id || "unknown model";
    const timestampValue = record.created_at_iso || record.created_at;
    const timestampMs = Date.parse(timestampValue);
    const safeTimestampMs = Number.isNaN(timestampMs) ? 0 : timestampMs;
    const existing = byModel.get(modelId);
    if (existing) {
      existing.promptCount += 1;
      existing.userIds.add(record.user_id);
      if (safeTimestampMs >= existing.latestMs) {
        existing.latestAt = timestampValue;
        existing.latestMs = safeTimestampMs;
      }
      return;
    }
    byModel.set(modelId, {
      modelId,
      promptCount: 1,
      userIds: new Set([record.user_id]),
      latestAt: timestampValue,
      latestMs: safeTimestampMs,
    });
  });

  const rows = Array.from(byModel.values()).sort(
    (a, b) => b.promptCount - a.promptCount || a.modelId.localeCompare(b.modelId),
  );
  const maxCount = Math.max(...rows.map((row) => row.promptCount), 1);
  return rows.slice(0, 8).map((row) => ({
    modelId: row.modelId,
    promptCount: row.promptCount,
    userCount: row.userIds.size,
    latestAt: row.latestAt,
    share: Math.max(8, Math.round((row.promptCount / maxCount) * 100)),
  }));
}

function buildPromptUsageTrendRows(records: UserPromptRecord[]) {
  const byDate = new Map<string, number>();
  records.forEach((record) => {
    const timestamp = Date.parse(record.created_at_iso || record.created_at);
    if (Number.isNaN(timestamp)) return;
    const dateKey = new Date(timestamp).toISOString().slice(0, 10);
    byDate.set(dateKey, (byDate.get(dateKey) ?? 0) + 1);
  });

  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-10)
    .map(([dateKey, count]) => ({
      dateKey,
      count,
      label: formatPromptTrendDate(dateKey),
    }));
}

function buildPromptUserRows(records: UserPromptRecord[]) {
  const byUser = new Map<
    string,
    {
      userId: string;
      userName: string;
      promptCount: number;
      modelIds: Set<string>;
    }
  >();

  records.forEach((record) => {
    const userId = record.user_id || record.user_email || "unknown-user";
    const userName = record.user_name || record.user_email || record.user_id || "Unknown user";
    const existing = byUser.get(userId);
    if (existing) {
      existing.promptCount += 1;
      existing.modelIds.add(record.model_id || "unknown model");
      return;
    }
    byUser.set(userId, {
      userId,
      userName,
      promptCount: 1,
      modelIds: new Set([record.model_id || "unknown model"]),
    });
  });

  return Array.from(byUser.values())
    .sort((a, b) => b.promptCount - a.promptCount || a.userName.localeCompare(b.userName))
    .slice(0, 6)
    .map((row) => ({
      userId: row.userId,
      userName: row.userName,
      promptCount: row.promptCount,
      modelCount: row.modelIds.size,
    }));
}

function promptUsageTrendPoint(count: number, index: number, rows: Array<{ count: number }>) {
  const left = 18;
  const top = 18;
  const plotWidth = 284;
  const plotHeight = 104;
  const maxCount = Math.max(...rows.map((row) => row.count), 1);
  const x = rows.length <= 1 ? left + plotWidth / 2 : left + (plotWidth * index) / (rows.length - 1);
  const y = top + plotHeight - (count / maxCount) * plotHeight;
  return {
    x: Number(x.toFixed(2)),
    y: Number(y.toFixed(2)),
  };
}

function promptUsageTrendPoints(rows: Array<{ count: number }>) {
  if (!rows.length) return "";
  return rows
    .map((row, index) => {
      const point = promptUsageTrendPoint(row.count, index, rows);
      return `${point.x},${point.y}`;
    })
    .join(" ");
}

function formatPromptTrendDate(dateKey: string) {
  const date = new Date(`${dateKey}T00:00:00+00:00`);
  if (Number.isNaN(date.getTime())) return dateKey;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

function csvFilenamePart(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "selected-user"
  );
}

function ModelColumnFilter({
  column,
  tooltip,
  open,
  activeCount,
  onToggleOpen,
  onClear,
  options,
  selected,
  onToggleValue,
  text,
  onTextChange,
}: {
  column: string;
  tooltip: string;
  open: boolean;
  activeCount: number;
  onToggleOpen: () => void;
  onClear: () => void;
  options?: Array<{ value: string; count: number }>;
  selected?: string[];
  onToggleValue?: (value: string) => void;
  text?: string;
  onTextChange?: (value: string) => void;
}) {
  return (
    <span className="model-column-filter">
      <button
        type="button"
        className={`column-filter-button${activeCount > 0 ? " is-active" : ""}`}
        aria-label={`Filter by ${column.toLowerCase()}`}
        aria-haspopup="true"
        aria-expanded={open}
        data-tooltip={tooltip}
        onClick={onToggleOpen}
      >
        <Filter size={12} />
        {activeCount > 0 && <b>{activeCount}</b>}
      </button>
      {open && (
        <div className="column-filter-popover" role="group" aria-label={`${column} filter`}>
          {onTextChange ? (
            <input
              aria-label={`${column} contains`}
              value={text ?? ""}
              placeholder="Contains…"
              autoFocus
              onChange={(event) => onTextChange(event.target.value)}
            />
          ) : (
            <div className="column-filter-options">
              {(options ?? []).map((option) => (
                <label key={option.value} className="column-filter-option">
                  <input
                    type="checkbox"
                    checked={selected?.includes(option.value) ?? false}
                    onChange={() => onToggleValue?.(option.value)}
                  />
                  <span>{option.value}</span>
                  <b>{option.count}</b>
                </label>
              ))}
            </div>
          )}
          <button
            type="button"
            className="column-filter-clear"
            disabled={activeCount === 0}
            data-tooltip={`Show every model again without the ${column.toLowerCase()} filter`}
            onClick={onClear}
          >
            Clear filter
          </button>
        </div>
      )}
    </span>
  );
}

function formatFeedbackTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Just now";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function csvRangeLabel(fromDate: string, throughDate: string) {
  if (fromDate && throughDate) return `${fromDate}_to_${throughDate}`;
  if (fromDate) return `from_${fromDate}`;
  if (throughDate) return `through_${throughDate}`;
  return "all-dates";
}

function rowsToCsv<T>(items: T[], columns: Array<CsvColumn<T>>) {
  const header = columns.map((column) => csvEscape(column.header)).join(",");
  const rows = items.map((item) => columns.map((column) => csvEscape(column.value(item))).join(","));
  return [header, ...rows].join("\r\n");
}

function csvEscape(value: CsvValue) {
  const text = value === null || typeof value === "undefined" ? "" : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadCsvFile(filename: string, csv: string) {
  const anchor = document.createElement("a");
  anchor.download = filename;
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  if (typeof URL.createObjectURL === "function") {
    const href = URL.createObjectURL(blob);
    anchor.href = href;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => {
      if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(href);
    }, 0);
    return;
  }
  anchor.href = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function formatAdminAuditTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatAccessRequestedAt(value?: string | null) {
  if (!value) return "Requested recently";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Requested recently";
  return `Requested ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)}`;
}

function formatAdminAuditRole(role: string) {
  return ROLE_LABELS[role as Role] ?? role;
}

function assignableRoles(actor: User): Role[] {
  return actor.role === "PLATFORM_OWNER" ? PLATFORM_OWNER_ASSIGNABLE_ROLES : ROLE_ORDER;
}

function upsertUsers(users: User[], nextUser: User) {
  if (users.some((user) => user.id === nextUser.id)) {
    return users.map((user) => (user.id === nextUser.id ? { ...user, ...nextUser } : user));
  }
  return [...users, nextUser];
}

function upsertGroups(groups: Group[], nextGroup: Group) {
  return upsertGroupReducer(groups, nextGroup);
}

function upsertGroupReducer(groups: Group[], nextGroup: Group) {
  if (groups.some((group) => group.id === nextGroup.id)) {
    return groups.map((group) => (group.id === nextGroup.id ? { ...group, ...nextGroup } : group));
  }
  return [...groups, nextGroup];
}

function removeGroupsFromBootstrap(data: BootstrapData, groupIds: Set<string>): BootstrapData {
  return {
    ...data,
    groups: data.groups.filter((group) => !groupIds.has(group.id)),
    users: data.users.map((user) => removeGroupsFromUser(user, groupIds)),
    visibleUsers: data.visibleUsers.map((user) => removeGroupsFromUser(user, groupIds)),
    models: data.models.map((model) => ({
      ...model,
      group_ids: model.group_ids.filter((groupId) => !groupIds.has(groupId)),
    })),
    knowledgeBases: data.knowledgeBases.map((knowledgeBase) =>
      groupIds.has(knowledgeBase.owner_group_id)
        ? { ...knowledgeBase, owner_group_id: "", acl: "Only creator" }
        : knowledgeBase,
    ),
  };
}

function removeGroupsFromUser(user: User, groupIds: Set<string>): User {
  return { ...user, group_ids: user.group_ids.filter((groupId) => !groupIds.has(groupId)) };
}

function defaultGroupPermissions() {
  return { ...DEFAULT_GROUP_PERMISSIONS };
}

function permissionsForGroup(group: Group, patch: Record<string, boolean> = {}) {
  return { ...DEFAULT_GROUP_PERMISSIONS, ...group.permissions, ...patch };
}

function mergeSyncedModelCatalog(currentModels: ModelConfig[], syncedModels: ModelConfig[]): ModelConfig[] {
  const syncedById = new Map(syncedModels.map((model) => [model.id, model]));
  const currentIds = new Set(currentModels.map((model) => model.id));
  const mergedCurrent = currentModels.map((model) => {
    const syncedModel = syncedById.get(model.id);
    if (syncedModel) return { ...model, ...syncedModel, platform_enabled: true };
    return model.platform_enabled ? { ...model, platform_enabled: false, group_ids: [] } : model;
  });
  const newModels = syncedModels.filter((model) => !currentIds.has(model.id)).map((model) => ({ ...model, platform_enabled: true }));
  return [...mergedCurrent, ...newModels];
}

function emptyGroupDraft(tenantId: string): AdminGroupCreateInput {
  return {
    tenant_id: tenantId,
    name: "",
    distinguished_name: "Platform-managed group",
    entra_object_id: "",
    synced: true,
    user_count: 0,
    permissions: defaultGroupPermissions(),
  };
}

function defaultGroupFor(data: BootstrapData) {
  return data.groups.find((group) => group.default_group);
}

function groupName(data: BootstrapData, groupId: string) {
  return data.groups.find((group) => group.id === groupId)?.name ?? groupId;
}

function groupMemberCount(data: BootstrapData, groupId: string) {
  return data.visibleUsers.filter((user) => user.role !== "PLATFORM_OWNER" && user.group_ids.includes(groupId)).length;
}

function isPendingPlatformUser(user: User) {
  return user.active && user.role !== "PLATFORM_OWNER" && user.group_ids.length === 0;
}

function userAccessStatus(user: User) {
  if (!user.active) return { label: "Inactive", dotClass: "red" };
  if (isPendingPlatformUser(user)) return { label: "Pending", dotClass: "yellow" };
  return { label: "Active", dotClass: "green" };
}

function parseBulkUserEmails(text: string) {
  return Array.from(
    new Set(
      text
        .split(/[\s,;]+/)
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.includes("@")),
    ),
  );
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error.";
}

/**
 * Budget failures keep the backend's exact detail; a 429 rejection surfaces
 * its real Retry-After wait. Nothing here retries automatically.
 */
function budgetErrorMessage(error: unknown): string {
  if (error instanceof UsageBudgetRequestError) {
    const base =
      error.status === 429
        ? `The backend rejected the request with HTTP 429: ${error.message}`
        : error.message;
    if (error.retryAfterSeconds !== null) {
      const seconds = error.retryAfterSeconds;
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const wait = seconds < 60 ? `${seconds}s` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
      return `${base} The backend accepts new work after ${wait} (next UTC day); nothing is retried automatically.`;
    }
    return base;
  }
  return errorMessage(error);
}

/**
 * Read-only view of this tenant's live UTC token-budget state from
 * `GET /api/admin/usage-budget`. Tenant admins cannot change the limit here —
 * only platform owners can, so no edit control is rendered.
 */
function TenantDailyBudgetPanel({ userId }: { userId: string }) {
  const [budget, setBudget] = useState<TenantUsageBudgetSnapshot | null>(null);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let active = true;
    setBudgetError(null);
    getAdminUsageBudget(userId)
      .then((snapshot) => {
        if (!active) return;
        setBudget(snapshot);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setBudget(null);
        setBudgetError(budgetErrorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [userId, refreshToken]);

  return (
    <Panel
      className="model-activity-panel tenant-budget-panel"
      title={
        <>
          <DatabaseZap size={18} /> Workspace Usage Budget
        </>
      }
      subtitle="Read-only view of the owner-managed workspace ceiling and its current UTC accounting period."
      defaultCollapsed
      actions={
        <button
          className="secondary-button compact"
          type="button"
          data-tooltip="Reload the live budget state from the admin API"
          onClick={() => setRefreshToken((token) => token + 1)}
        >
          <RefreshCw size={14} /> Refresh
        </button>
      }
    >
      {budgetError ? (
        <div className="audit-empty-state">
          <ShieldAlert size={20} />
          <span>
            <strong>Budget state could not be loaded</strong>
            <small>{budgetError}</small>
          </span>
        </div>
      ) : budget === null ? (
        <div className="audit-empty-state">
          <DatabaseZap size={20} />
          <span>
            <strong>Loading budget state</strong>
            <small>Reading this tenant's live UTC token counters.</small>
          </span>
        </div>
      ) : (
        <>
          <div className="feedback-summary-grid">
            <div className="feedback-summary-card">
              <span>{budget.budget_period === "day" ? "Daily" : budget.budget_period === "week" ? "Weekly" : "Monthly"} limit</span>
              <strong>
                {budget.limit_value === 0
                  ? "Unlimited"
                  : budget.budget_unit === "usd"
                    ? new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(budget.limit_value)
                    : `${budget.limit_value.toLocaleString()} tokens`}
              </strong>
              <small>A limit of 0 means unlimited.</small>
            </div>
            <div className="feedback-summary-card">
              <span>{budget.budget_unit === "usd" ? "Reported spend" : "Reported tokens"}</span>
              <strong>
                {budget.budget_unit === "usd"
                  ? new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(budget.reported_cost_usd)
                  : budget.reported_tokens.toLocaleString()}
              </strong>
              <small>UTC {budget.period_start} – {budget.period_end}.</small>
            </div>
            <div className="feedback-summary-card">
              <span>Reported completions</span>
              <strong>{(budget.budget_unit === "usd" ? budget.cost_metered_completions : budget.metered_completions).toLocaleString()}</strong>
              <small>Counted from exact provider {budget.budget_unit === "usd" ? "cost" : "token"} reports.</small>
            </div>
            <div className="feedback-summary-card">
              <span>Unreported completions</span>
              <strong>{(budget.budget_unit === "usd" ? budget.cost_unmetered_completions : budget.unmetered_completions).toLocaleString()}</strong>
              <small>Succeeded without a provider {budget.budget_unit === "usd" ? "cost" : "token"} report; never estimated.</small>
            </div>
          </div>
          {(budget.budget_unit === "usd" ? budget.reported_cost_overflowed : budget.reported_tokens_overflowed) && (
            <p className="inline-warning" role="alert">
              <ShieldAlert size={14} /> The reported {budget.budget_unit === "usd" ? "cost" : "token"} counter overflowed its storage bound; treat this period's total as a floor.
            </p>
          )}
          <p className="usage-token-muted">
            Limit last changed {formatAdminAuditTimestamp(budget.updated_at)}
            {budget.updated_by ? ` by ${budget.updated_by}` : ""}. This organization's top-level usage policy is
            managed at the service level.
          </p>
        </>
      )}
    </Panel>
  );
}

function ConnectorConfigForm({
  connector,
  profile,
  record,
  saving,
  testing,
  testResult,
  onSave,
  onTest,
  onOAuthConnect,
}: {
  connector: Connector;
  profile: ConnectorFormProfile;
  record?: ConnectorConfigRecord;
  saving: boolean;
  testing: boolean;
  testResult: ConnectorTestResult | null;
  onSave: (payload: AdminConnectorConfigUpdateRequest & { connector_id: string }) => void;
  onTest: () => void;
  onOAuthConnect: () => void;
}) {
  const settings = useMemo(() => record?.settings ?? {}, [record]);
  const storedAuthMode =
    typeof settings.auth_mode === "string" && profile.authModes.some((mode) => mode.value === settings.auth_mode)
      ? (settings.auth_mode as string)
      : null;
  // Existing empty deployments were seeded with iManage's password grant.
  // Present the safer delegated default until a real service credential exists.
  const initialAuthMode =
    connector.id === "imanage" && storedAuthMode === "password" && !record?.secret_set
      ? profile.authModes[0].value
      : storedAuthMode ?? profile.authModes[0].value;
  const [authMode, setAuthMode] = useState(initialAuthMode);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(() => readFieldValues(profile, settings));
  const [secretValue, setSecretValue] = useState("");
  const [servicePassword, setServicePassword] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setFieldValues(readFieldValues(profile, settings));
    setAuthMode(initialAuthMode);
    setSecretValue("");
    setServicePassword("");
    setValidationError(null);
  }, [profile, settings, initialAuthMode]);

  const visibleFields = profile.fields.filter((field) => !field.modes || field.modes.includes(authMode));
  const secretLabel = profile.secretLabel[authMode] ?? "Secret";
  const needsPassword = profile.passwordModes?.includes(authMode) ?? false;
  const oauthConnectAvailable = profile.oauthConnectMode === authMode;
  const secretSaved = Boolean(record?.secret_set);
  const oauthStatus = typeof settings.oauth_status === "string" ? settings.oauth_status : null;
  const hasSavedConfiguration = Boolean(record ?? connector.tenant_config_id);
  const visibleFieldsCleared = visibleFields.every((field) => !fieldValues[field.key]?.trim());
  const clearPayload: AdminConnectorConfigUpdateRequest & { connector_id: string } = {
    connector_id: connector.id,
    enabled: false,
    auth_type: authMode,
    settings: {},
    replace_settings: true,
    clear_secret: true,
    clear_oauth: true,
    clear_service_password: true,
  };

  const clearFormValues = () => {
    setFieldValues((current) => {
      const next = { ...current };
      for (const field of profile.fields) next[field.key] = "";
      return next;
    });
    setSecretValue("");
    setServicePassword("");
    setValidationError(null);
  };

  const submit = () => {
    if (hasSavedConfiguration && visibleFieldsCleared && !secretValue.trim() && !servicePassword.trim()) {
      setValidationError(null);
      onSave(clearPayload);
      clearFormValues();
      return;
    }
    const missing = visibleFields
      .filter((field) => field.required && !fieldValues[field.key]?.trim())
      .map((field) => field.label);
    if (!secretSaved && !secretValue.trim()) missing.push(secretLabel);
    if (missing.length > 0) {
      setValidationError(`Fill in: ${missing.join(", ")}.`);
      return;
    }
    setValidationError(null);
    const nextSettings: Record<string, string> = { auth_mode: authMode };
    for (const field of visibleFields) {
      nextSettings[field.key] = fieldValues[field.key]?.trim() ?? "";
    }
    const payload: AdminConnectorConfigUpdateRequest & { connector_id: string } = {
      connector_id: connector.id,
      auth_type: authMode,
      settings: nextSettings,
    };
    if (secretValue.trim()) payload.secret_value = secretValue.trim();
    if (needsPassword && servicePassword.trim()) payload.service_password = servicePassword.trim();
    onSave(payload);
    setSecretValue("");
    setServicePassword("");
  };

  const clearConfiguration = () => {
    if (!hasSavedConfiguration) {
      clearFormValues();
      return;
    }
    onSave(clearPayload);
    clearFormValues();
  };

  return (
    <div className="connector-config-form" data-testid={`connector-config-${connector.id}`}>
      <label className="connector-config-selector">
        <span className="connector-field-label">Authentication method</span>
        <SelectControl value={authMode} onChange={(event) => setAuthMode(event.target.value)}>
          {profile.authModes.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </SelectControl>
      </label>
      <div className="connector-config-grid">
        {visibleFields.map((field) => (
          <label key={field.key}>
            <span className="connector-field-label">
              {field.label}
              {field.required ? <span className="required-mark"> *</span> : null}
            </span>
            <input
              value={fieldValues[field.key] ?? ""}
              placeholder={field.placeholder}
              onChange={(event) =>
                setFieldValues((current) => ({ ...current, [field.key]: event.target.value }))
              }
            />
            {field.hint && <small className="field-hint">{field.hint}</small>}
          </label>
        ))}
        <label>
          <span className="connector-field-label">
            {secretLabel}
            {!secretSaved ? <span className="required-mark"> *</span> : null}
          </span>
          <input
            type="password"
            value={secretValue}
            placeholder={secretSaved ? "Saved — enter a new value to replace" : "Stored server-side only"}
            onChange={(event) => setSecretValue(event.target.value)}
          />
        </label>
        {needsPassword && (
          <label>
            <span className="connector-field-label">Service account password</span>
            <input
              type="password"
              value={servicePassword}
              placeholder="Stored server-side only"
              onChange={(event) => setServicePassword(event.target.value)}
            />
          </label>
        )}
      </div>
      {profile.setupNote && <p className="muted-note">{profile.setupNote}</p>}
      {validationError && (
        <p className="connector-config-error" role="alert">
          {validationError}
        </p>
      )}
      <div className="connector-config-actions">
        <button
          className="secondary-button compact"
          type="button"
          data-tooltip={`Save ${connector.name} settings and store the secret securely server-side`}
          disabled={saving}
          onClick={submit}
        >
          <CheckCircle2 size={14} />{" "}
          <StableLabel
            label={saving ? "Saving…" : "Save configuration"}
            reserve={["Saving…", "Save configuration"]}
          />
        </button>
        <button
          className="secondary-button compact"
          type="button"
          disabled={testing || !connector.tenant_config_id}
          data-tooltip={
            connector.tenant_config_id
              ? `Verify the saved ${connector.name} credentials with a live provider API call`
              : "Save the configuration first, then test the connection"
          }
          onClick={onTest}
        >
          <RefreshCw size={14} /> {testing ? "Testing…" : "Test connection"}
        </button>
        {oauthConnectAvailable && (
          <button
            className="secondary-button compact"
            type="button"
            disabled={!connector.tenant_config_id || !secretSaved}
            data-tooltip={
              connector.tenant_config_id && secretSaved
                ? `Open the ${connector.name} consent screen to grant access and store a refresh token`
                : "Save the client ID and secret first, then connect"
            }
            onClick={onOAuthConnect}
          >
            <KeyRound size={14} /> Connect {connector.name}
          </button>
        )}
        <button
          className="secondary-button compact"
          type="button"
          disabled={saving}
          data-tooltip={`Clear saved ${connector.name} fields and stored connector secrets`}
          onClick={clearConfiguration}
        >
          <Trash2 size={14} /> Clear configuration
        </button>
        {oauthStatus === "connected" && <Pill tone="success">OAuth connected</Pill>}
      </div>
      {testResult && (
        <div className={`sso-test-result sso-test-${testResult.status}`} role="status">
          <span className="sso-test-headline">
            {testResult.status === "ok" ? <ShieldCheck size={15} /> : <X size={15} />}
            {testResult.message}
          </span>
          {testResult.checks?.map((check) => (
            <span key={check.name} className={`sso-test-check sso-test-check-${check.status}`}>
              <strong>{check.name}:</strong> {check.detail}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function readFieldValues(profile: ConnectorFormProfile, settings: Record<string, unknown>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of profile.fields) {
    const raw = settings[field.key];
    values[field.key] = typeof raw === "string" ? raw : "";
  }
  return values;
}

const WEB_SEARCH_ENGINES = [
  { value: "duckduckgo", label: "DuckDuckGo (keyless, works out of the box)" },
  { value: "searxng", label: "SearXNG (self-hosted instance)" },
  { value: "openai", label: "OpenAI web search (uses your OpenAI provider key)" },
  { value: "anthropic", label: "Anthropic web search (uses your Anthropic provider key)" },
  { value: "openrouter", label: "OpenRouter web search (uses your OpenRouter provider key)" },
];

const KEYED_WEB_SEARCH_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
};

function webSearchEnginePill(record: ConnectorConfigRecord | undefined): {
  tone: "success" | "warning";
  label: string;
} {
  const settings = record?.settings ?? {};
  const engine = typeof settings.engine === "string" ? settings.engine : "";
  if (engine === "searxng") {
    const baseUrl = typeof settings.searxng_base_url === "string" ? settings.searxng_base_url.trim() : "";
    return baseUrl
      ? { tone: "success", label: "SearXNG" }
      : { tone: "warning", label: "SearXNG · URL missing" };
  }
  if (engine === "duckduckgo") return { tone: "success", label: "DuckDuckGo" };
  if (KEYED_WEB_SEARCH_LABELS[engine]) return { tone: "success", label: KEYED_WEB_SEARCH_LABELS[engine] };
  return { tone: "success", label: "DuckDuckGo · default" };
}

/** Web search needs an engine choice, not credentials, so it gets its own
 * form instead of the auth-mode/secret machinery the other connectors use. */
function WebSearchConfigForm({
  connector,
  record,
  saving,
  testing,
  testResult,
  onSave,
  onTest,
}: {
  connector: Connector;
  record?: ConnectorConfigRecord;
  saving: boolean;
  testing: boolean;
  testResult: ConnectorTestResult | null;
  onSave: (payload: AdminConnectorConfigUpdateRequest & { connector_id: string }) => void;
  onTest: () => void;
}) {
  const settings = useMemo(() => record?.settings ?? {}, [record]);
  const initialEngine =
    typeof settings.engine === "string" && WEB_SEARCH_ENGINES.some((option) => option.value === settings.engine)
      ? (settings.engine as string)
      : "duckduckgo";
  const [engine, setEngine] = useState(initialEngine);
  const [searxngBaseUrl, setSearxngBaseUrl] = useState(() =>
    typeof settings.searxng_base_url === "string" ? settings.searxng_base_url : "",
  );
  const [maxResults, setMaxResults] = useState(() => {
    const raw = settings.max_results;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return String(Math.trunc(raw));
    if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return raw.trim();
    return "5";
  });
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setEngine(initialEngine);
    setSearxngBaseUrl(typeof settings.searxng_base_url === "string" ? settings.searxng_base_url : "");
    setValidationError(null);
  }, [settings, initialEngine]);

  const submit = () => {
    if (engine === "searxng" && !searxngBaseUrl.trim()) {
      setValidationError("Set the SearXNG instance URL, or switch the engine to DuckDuckGo.");
      return;
    }
    const parsedMax = Number.parseInt(maxResults, 10);
    const boundedMax = Number.isFinite(parsedMax) ? Math.min(10, Math.max(1, parsedMax)) : 5;
    setValidationError(null);
    onSave({
      connector_id: connector.id,
      enabled: true,
      settings: {
        engine,
        searxng_base_url: engine === "searxng" ? searxngBaseUrl.trim() : "",
        max_results: boundedMax,
      },
    });
  };

  return (
    <div className="connector-config-form" data-testid="connector-config-web">
      <label>
        Search engine
        <SelectControl value={engine} onChange={(event) => setEngine(event.target.value)}>
          {WEB_SEARCH_ENGINES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectControl>
        {KEYED_WEB_SEARCH_LABELS[engine] && (
          <small className="field-hint">
            Runs a small {KEYED_WEB_SEARCH_LABELS[engine]}-hosted search per query using the{" "}
            {KEYED_WEB_SEARCH_LABELS[engine]} provider key already saved for model routing — no extra credential
            needed. Each search is billed to that account; use Test connection to verify the key works.
          </small>
        )}
      </label>
      <div className="connector-config-grid">
        {engine === "searxng" && (
          <label>
            SearXNG instance URL
            <span className="required-mark"> *</span>
            <input
              value={searxngBaseUrl}
              placeholder="http://localhost:8888"
              onChange={(event) => setSearxngBaseUrl(event.target.value)}
            />
            <small className="field-hint">
              The instance must allow JSON output: search.formats must include json in the SearXNG settings.
            </small>
          </label>
        )}
        <label>
          Results per search
          <input
            type="number"
            min={1}
            max={10}
            value={maxResults}
            onChange={(event) => setMaxResults(event.target.value)}
          />
          <small className="field-hint">Top results injected into the model prompt as cited context.</small>
        </label>
      </div>
      <p className="muted-note">
        Applies to models whose provider has no hosted web search of its own. OpenRouter-backed models always use
        OpenRouter&apos;s built-in web search (native provider search where the model family supports it) regardless
        of this engine choice. The enable toggle on this row turns web search on or off for the whole workspace.
      </p>
      {validationError && (
        <p className="connector-config-error" role="alert">
          {validationError}
        </p>
      )}
      <div className="connector-config-actions">
        <button
          className="secondary-button compact"
          type="button"
          data-tooltip="Save the search engine choice and result limit for this workspace"
          disabled={saving}
          onClick={submit}
        >
          <CheckCircle2 size={14} />{" "}
          <StableLabel
            label={saving ? "Saving…" : "Save configuration"}
            reserve={["Saving…", "Save configuration"]}
          />
        </button>
        <button
          className="secondary-button compact"
          type="button"
          disabled={testing || !connector.tenant_config_id}
          data-tooltip={
            connector.tenant_config_id
              ? "Run a real search query to verify the configured engine works"
              : "Save the configuration first, then test the connection"
          }
          onClick={onTest}
        >
          <RefreshCw size={14} /> {testing ? "Testing…" : "Test connection"}
        </button>
      </div>
      {testResult && (
        <div className={`sso-test-result sso-test-${testResult.status}`} role="status">
          <span className="sso-test-headline">
            {testResult.status === "ok" ? <ShieldCheck size={15} /> : <X size={15} />}
            {testResult.message}
          </span>
          {testResult.checks?.map((check) => (
            <span key={check.name} className={`sso-test-check sso-test-check-${check.status}`}>
              <strong>{check.name}:</strong> {check.detail}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

type SsoCreateDraft = {
  provider: string;
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  domains: string;
  jit: boolean;
};

const SSO_PROVIDER_PRESETS: Array<{ value: string; label: string; issuer: string; hint?: string }> = [
  {
    value: "entra-id",
    label: "Microsoft Entra ID",
    issuer: "https://login.microsoftonline.com/{tenant-id}/v2.0",
    hint: "Replace {tenant-id} with your directory ID",
  },
  { value: "google-workspace", label: "Google Workspace", issuer: "https://accounts.google.com" },
  { value: "okta", label: "Okta", issuer: "https://{your-domain}.okta.com" },
  { value: "custom-oidc", label: "Custom OIDC provider", issuer: "" },
];

function SsoCreateForm({
  pending,
  onCancel,
  onCreate,
}: {
  pending: boolean;
  onCancel: () => void;
  onCreate: (draft: SsoCreateDraft) => void;
}) {
  const [preset, setPreset] = useState(SSO_PROVIDER_PRESETS[0]);
  const [draft, setDraft] = useState<SsoCreateDraft>({
    provider: SSO_PROVIDER_PRESETS[0].value,
    name: SSO_PROVIDER_PRESETS[0].label,
    issuer: SSO_PROVIDER_PRESETS[0].issuer,
    clientId: "",
    clientSecret: "",
    domains: "",
    jit: true,
  });
  const canSubmit = draft.issuer.trim().length > 0 && draft.clientId.trim().length > 0 && !pending;

  function applyPreset(value: string) {
    const next = SSO_PROVIDER_PRESETS.find((option) => option.value === value) ?? SSO_PROVIDER_PRESETS[3];
    setPreset(next);
    setDraft((current) => ({
      ...current,
      provider: next.value,
      name: next.label === "Custom OIDC provider" ? current.name : next.label,
      issuer: next.issuer || current.issuer,
    }));
  }

  return (
    <div className="connector-config-form sso-create-form" data-testid="sso-create-form">
      <label className="connector-config-selector">
        <span className="connector-field-label">Identity provider</span>
        <SelectControl
          value={preset.value}
          aria-label="Identity provider preset"
          onChange={(event) => applyPreset(event.target.value)}
        >
          {SSO_PROVIDER_PRESETS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectControl>
        {preset.hint && <small className="field-hint">{preset.hint}</small>}
      </label>
      <div className="connector-config-grid">
        <label>
          <span className="connector-field-label">Display name</span>
          <input
            value={draft.name}
            aria-label="SSO display name"
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          />
        </label>
        <label>
          <span className="connector-field-label">
            Issuer URL<span className="required-mark"> *</span>
          </span>
          <input
            value={draft.issuer}
            aria-label="Issuer URL"
            placeholder="https://accounts.google.com"
            onChange={(event) => setDraft((current) => ({ ...current, issuer: event.target.value }))}
          />
          <small className="field-hint">
            Discovery is fetched from {"{issuer}"}/.well-known/openid-configuration
          </small>
        </label>
        <label>
          <span className="connector-field-label">
            Client ID<span className="required-mark"> *</span>
          </span>
          <input
            value={draft.clientId}
            aria-label="Client ID"
            onChange={(event) => setDraft((current) => ({ ...current, clientId: event.target.value }))}
          />
        </label>
        <label>
          <span className="connector-field-label">Client secret</span>
          <input
            type="password"
            value={draft.clientSecret}
            aria-label="Client secret"
            placeholder="Vaulted server-side, never shown again"
            onChange={(event) => setDraft((current) => ({ ...current, clientSecret: event.target.value }))}
          />
        </label>
        <label>
          <span className="connector-field-label">Allowed email domains</span>
          <input
            value={draft.domains}
            aria-label="Allowed email domains"
            placeholder="example.com, example.co.uk"
            onChange={(event) => setDraft((current) => ({ ...current, domains: event.target.value }))}
          />
          <small className="field-hint">Only accounts on these domains can sign in through this provider</small>
        </label>
      </div>
      <div className="permission-row">
        <span>Provision new users on first sign-in (JIT)</span>
        <Toggle
          checked={draft.jit}
          label="Provision new users on first sign-in"
          tooltip={
            draft.jit
              ? "Stop creating accounts automatically on first SSO sign-in"
              : "Create USER accounts automatically the first time someone on an allowed domain signs in"
          }
          onChange={(next) => setDraft((current) => ({ ...current, jit: next }))}
        />
      </div>
      <small className="field-hint sso-redirect-hint">
        Register this redirect URI with your identity provider: <code>{ssoRedirectUri()}</code>
      </small>
      <div className="connector-config-actions">
        <button
          className="primary-button form-submit-button"
          type="button"
          disabled={!canSubmit}
          data-tooltip="Create this SSO configuration for the tenant; enforcement stays off until you enable it"
          onClick={() => onCreate(draft)}
        >
          {pending ? "Creating…" : "Create SSO configuration"}
        </button>
        <button
          className="secondary-button compact"
          type="button"
          data-tooltip="Discard this form without creating a configuration"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function SsoConfigCard({
  config,
  groups,
  canManage,
  pendingAction,
  testResult,
  onToggleEnforce,
  onSaveMappings,
  onDelete,
  onTest,
}: {
  config: SsoConfig;
  groups: Group[];
  canManage: boolean;
  pendingAction: string | null;
  testResult?: SsoTestResult;
  onToggleEnforce: (next: boolean) => void;
  onSaveMappings: (mappings: Record<string, string>) => void;
  onDelete: () => void;
  onTest: () => void;
}) {
  const [mappingRows, setMappingRows] = useState<Array<{ claim: string; groupId: string }>>(() =>
    Object.entries(config.mapped_groups ?? {}).map(([claim, groupId]) => ({ claim, groupId })),
  );
  const testing = pendingAction === `sso-test-${config.id}`;
  const savingMappings = pendingAction === `sso-mappings-${config.id}`;

  function mappingsToRecord(): Record<string, string> {
    const record: Record<string, string> = {};
    for (const row of mappingRows) {
      const claim = row.claim.trim();
      if (claim && row.groupId) record[claim] = row.groupId;
    }
    return record;
  }

  return (
    <div className="settings-card" key={config.id}>
      <header>
        <strong>{config.name}</strong>
        <Pill tone={config.status === "ready" || config.status === "enforced" ? "success" : "warning"}>
          {config.status}
        </Pill>
      </header>
      <dl className="meta-list stacked">
        <div>
          <dt>Protocol</dt>
          <dd>{config.protocol}</dd>
        </div>
        <div>
          <dt>Issuer</dt>
          <dd>{config.issuer}</dd>
        </div>
        <div>
          <dt>Domains</dt>
          <dd>{config.domains.join(", ")}</dd>
        </div>
        <div>
          <dt>JIT provisioning</dt>
          <dd>{config.jit_provisioning ? "On — new users get the USER role" : "Off"}</dd>
        </div>
        <div>
          <dt>Last tested</dt>
          <dd>{config.last_tested}</dd>
        </div>
      </dl>
      <div className="sso-mapping-editor">
        <strong className="sso-mapping-title">IdP group mapping</strong>
        <small className="field-hint">
          Map identity-provider group or role claim values to tenant groups so JIT-provisioned users land with the
          right access.
        </small>
        {mappingRows.length === 0 && <small className="field-hint">No mappings yet.</small>}
        {mappingRows.map((row, index) => (
          <div className="sso-mapping-row" key={index}>
            <input
              value={row.claim}
              placeholder="IdP group value (e.g. legal-team)"
              aria-label={`IdP group value ${index + 1}`}
              disabled={!canManage}
              onChange={(event) =>
                setMappingRows((current) =>
                  current.map((item, i) => (i === index ? { ...item, claim: event.target.value } : item)),
                )
              }
            />
            <SelectControl
              value={row.groupId}
              aria-label={`Tenant group for mapping ${index + 1}`}
              disabled={!canManage}
              onChange={(event) =>
                setMappingRows((current) =>
                  current.map((item, i) => (i === index ? { ...item, groupId: event.target.value } : item)),
                )
              }
            >
              <option value="">Select tenant group</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </SelectControl>
            {canManage && (
              <button
                className="icon-button"
                type="button"
                aria-label={`Remove mapping ${index + 1}`}
                data-tooltip="Remove this group mapping row"
                onClick={() => setMappingRows((current) => current.filter((_, i) => i !== index))}
              >
                <X size={14} />
              </button>
            )}
          </div>
        ))}
        {canManage && (
          <div className="row-actions">
            <button
              className="secondary-button compact"
              type="button"
              data-tooltip="Add a row that maps an IdP group value to a tenant group"
              onClick={() => setMappingRows((current) => [...current, { claim: "", groupId: "" }])}
            >
              <Plus size={14} /> Add mapping
            </button>
            <button
              className="secondary-button compact"
              type="button"
              disabled={savingMappings}
              data-tooltip="Save these group mappings to the SSO configuration"
              onClick={() => onSaveMappings(mappingsToRecord())}
            >
              <StableLabel
                label={savingMappings ? "Saving…" : "Save mappings"}
                reserve={["Saving…", "Save mappings"]}
              />
            </button>
          </div>
        )}
      </div>
      <div className="permission-row">
        <span>Enforce for tenant sign-in</span>
        <Toggle
          checked={config.enforced}
          disabled={!canManage || pendingAction === `sso-${config.id}`}
          label={`Enforce ${config.name}`}
          tooltip={
            !canManage
              ? "Organization policy makes SSO configuration read-only in this console"
              : config.enforced
                ? `Stop requiring ${config.name} for tenant sign-in`
                : `Require everyone in this tenant to sign in through ${config.name} — test the connection first`
          }
          onChange={onToggleEnforce}
        />
      </div>
      {canManage && (
        <div className="connector-config-actions">
          <button
            className="secondary-button compact"
            type="button"
            disabled={testing}
            data-tooltip={`Run a live discovery and key check against ${config.name}`}
            onClick={onTest}
          >
            <RefreshCw size={14} /> {testing ? "Testing…" : "Test connection"}
          </button>
          <button
            className="secondary-button compact"
            type="button"
            disabled={pendingAction === `sso-delete-${config.id}`}
            data-tooltip={`Delete the ${config.name} configuration for this tenant`}
            onClick={onDelete}
          >
            <Trash2 size={14} /> Remove
          </button>
        </div>
      )}
      {testResult && (
        <div className={`sso-test-result sso-test-${testResult.status}`} role="status">
          <span className="sso-test-headline">
            {testResult.status === "ok" ? <ShieldCheck size={15} /> : <X size={15} />}
            {testResult.message}
          </span>
          {testResult.checks?.map((check) => (
            <span key={check.name} className={`sso-test-check sso-test-check-${check.status}`}>
              <strong>{check.name}:</strong> {check.detail}
            </span>
          ))}
        </div>
      )}
      <p className="muted-note">{config.mfa_notes || config.admin_notes}</p>
    </div>
  );
}


/** Admin-managed per-user/per-group token allocations inside the workspace
 * ceiling. Meters show exact reported usage for each UTC period; the
 * most restrictive applicable cap denies requests at admission time. */
function UsageAllocationsPanel({ data }: { data: BootstrapData }) {
  const userId = data.me.id;
  const [snapshot, setSnapshot] = useState<UsageAllocationsSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [principalKey, setPrincipalKey] = useState("");
  const [limitDraft, setLimitDraft] = useState("");
  const [periodDraft, setPeriodDraft] = useState<"day" | "week" | "month">("day");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setLoadError(null);
    getAdminUsageAllocations(userId)
      .then((next) => {
        if (active) setSnapshot(next);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setSnapshot(null);
        setLoadError(budgetErrorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [userId, refreshToken]);

  const memberUsers = data.users.filter((user) => user.role !== "PLATFORM_OWNER");
  const allocationKeys = new Set(
    (snapshot?.allocations ?? []).map(
      (allocation) => `${allocation.principal_type}:${allocation.principal_id}`,
    ),
  );
  const candidateOptions: Array<{ key: string; label: string }> = [
    ...data.groups.map((group) => ({ key: `group:${group.id}`, label: `Group · ${group.name}` })),
    ...memberUsers.map((user) => ({ key: `user:${user.id}`, label: `User · ${user.display_name}` })),
  ].filter((option) => !allocationKeys.has(option.key));

  const finiteSum = (snapshot?.allocations ?? [])
    .filter(
      (allocation) =>
        allocation.daily_token_limit > 0 && allocation.budget_period === snapshot?.budget_period,
    )
    .reduce((sum, allocation) => sum + allocation.daily_token_limit, 0);
  const oversubscribed =
    snapshot !== null &&
    snapshot.budget_unit === "tokens" &&
    snapshot.daily_token_limit > 0 &&
    finiteSum > snapshot.daily_token_limit;

  async function saveAllocation() {
    const [principalType, principalId] = principalKey.split(":", 2) as [
      "user" | "group",
      string,
    ];
    const parsed = Number(limitDraft.trim());
    if (!principalId) {
      setFormError("Choose a user or group first.");
      return;
    }
    if (!Number.isInteger(parsed) || parsed < 0) {
      setFormError("Enter a whole number of tokens (0 means no cap).");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await setAdminUsageAllocation(userId, {
        principal_type: principalType,
        principal_id: principalId,
        budget_period: periodDraft,
        daily_token_limit: parsed,
      });
      setPrincipalKey("");
      setLimitDraft("");
      setPeriodDraft("day");
      setRefreshToken((token) => token + 1);
    } catch (error) {
      setFormError(budgetErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function removeAllocation(principalType: "user" | "group", principalId: string) {
    try {
      await deleteAdminUsageAllocation(userId, principalType, principalId);
      setRefreshToken((token) => token + 1);
    } catch (error) {
      setLoadError(budgetErrorMessage(error));
    }
  }

  return (
    <Panel
      className="model-activity-panel usage-allocations-panel"
      title={
        <>
          <DatabaseZap size={18} /> Token Allocations
        </>
      }
      subtitle="Set per-user and per-group token caps with daily, weekly, or monthly UTC resets. The most restrictive applicable cap wins."
      defaultCollapsed
      actions={
        <button
          className="secondary-button compact"
          type="button"
          data-tooltip="Reload allocations and today's usage"
          onClick={() => setRefreshToken((token) => token + 1)}
        >
          <RefreshCw size={14} /> Refresh
        </button>
      }
    >
      {loadError && (
        <p className="inline-warning" role="alert">
          <ShieldAlert size={14} /> {loadError}
        </p>
      )}
      {snapshot && (
        <>
          {oversubscribed && (
            <p className="inline-warning" role="alert">
              <ShieldAlert size={14} /> Allocations total {finiteSum.toLocaleString()} tokens,
              more than the {snapshot.daily_token_limit.toLocaleString()}-token workspace
              ceiling. The ceiling still wins; the meters below stay honest.
            </p>
          )}
          <div className="table-scroll">
            <table className="usage-allocations-table">
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Token cap</th>
                  <th>Used in current period</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {snapshot.allocations.length === 0 && (
                  <tr>
                    <td colSpan={4} className="usage-token-muted">
                      No allocations yet. Everyone shares the workspace ceiling.
                    </td>
                  </tr>
                )}
                {snapshot.allocations.map((allocation) => {
                  const capped = allocation.daily_token_limit > 0;
                  const ratio = capped
                    ? Math.min(1, allocation.reported_tokens / allocation.daily_token_limit)
                    : 0;
                  return (
                    <tr key={`${allocation.principal_type}:${allocation.principal_id}`}>
                      <td data-label="Who">
                        <strong>{allocation.display_name}</strong>{" "}
                        <small>{allocation.principal_type === "group" ? "group" : "user"}</small>
                      </td>
                      <td data-label="Token Cap">
                        {capped ? allocation.daily_token_limit.toLocaleString() : "No cap"}{" "}
                        <small>per {allocation.budget_period}</small>
                      </td>
                      <td data-label="Used">
                        <span className="allocation-meter" aria-hidden="true">
                          <span
                            className={`allocation-meter-fill ${ratio >= 1 ? "is-exhausted" : ""}`}
                            style={{ width: `${Math.round(ratio * 100)}%` }}
                          />
                        </span>{" "}
                        {allocation.reported_tokens.toLocaleString()}
                        {capped ? ` / ${allocation.daily_token_limit.toLocaleString()}` : ""}
                        <small className="allocation-period-dates">
                          UTC {allocation.period_start} – {allocation.period_end}
                        </small>
                      </td>
                      <td data-label="Actions">
                        <button
                          className="secondary-button compact"
                          type="button"
                          aria-label={`Remove allocation for ${allocation.display_name}`}
                          data-tooltip="Remove this cap; the principal returns to the shared ceiling"
                          onClick={() =>
                            void removeAllocation(
                              allocation.principal_type,
                              allocation.principal_id,
                            )
                          }
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="allocation-add-row">
            <SelectControl
              aria-label="Allocation principal"
              value={principalKey}
              onChange={(event) => setPrincipalKey(event.target.value)}
            >
              <option value="">Choose a user or group…</option>
              {candidateOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </SelectControl>
            <input
              aria-label="Token cap"
              inputMode="numeric"
              placeholder="Token cap"
              value={limitDraft}
              onChange={(event) => setLimitDraft(event.target.value)}
            />
            <SelectControl
              aria-label="Allocation reset period"
              value={periodDraft}
              onChange={(event) => setPeriodDraft(event.target.value as "day" | "week" | "month")}
            >
              <option value="day">Per day</option>
              <option value="week">Per week</option>
              <option value="month">Per month</option>
            </SelectControl>
            <button
              className="primary-button compact"
              type="button"
              data-tooltip="Set this token cap and UTC reset period; it starts enforcing immediately"
              disabled={saving || !principalKey}
              onClick={() => void saveAllocation()}
            >
              {saving ? "Saving..." : "Set cap"}
            </button>
          </div>
          {formError && (
            <p className="inline-warning" role="alert">
              <ShieldAlert size={14} /> {formError}
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

function AdminPolicyOverviewPanel({
  data,
  defaultGroup,
  memoryPolicy,
  pendingAction,
  onDefaultPermissionChange,
}: {
  data: BootstrapData;
  defaultGroup?: Group;
  memoryPolicy: TenantMemoryPolicy | null;
  pendingAction: string | null;
  onDefaultPermissionChange: (key: string, next: boolean) => void;
}) {
  const settings = data.platformSettings;
  const downstreamApiEnabled = Boolean(settings?.downstream_api_enabled);
  const agentAuthoringEnabled = Boolean(settings?.users_can_create_models);
  const platformMemoryEnabled = Boolean(settings?.memory_enabled);
  const tenantMemoryEnabled = Boolean(memoryPolicy?.enabled);
  const defaultPermissions = defaultGroup ? permissionsForGroup(defaultGroup) : defaultGroupPermissions();

  return (
    <Panel
      className="tenant-policy-panel"
      title={<><SlidersHorizontal size={18} /> Policy Controls</>}
      subtitle="Simple organization controls that stay within service-wide availability."
      defaultCollapsed
    >
      <div className="policy-callout">
        <Lock size={15} />
        <span>
          Service policy defines which capabilities are available. The controls below can narrow access for this organization; unavailable capabilities remain locked.
        </span>
      </div>

      <div className="policy-toggle-stack">
        <AdminPolicyStatusRow
          title="Administrator accounts"
          detail={
            settings?.tenant_admins_can_create_admins
              ? "You may create and manage administrators for this organization."
              : "New administrator accounts require service approval."
          }
          status={settings?.tenant_admins_can_create_admins ? "Available" : "Service managed"}
          tone={settings?.tenant_admins_can_create_admins ? "success" : "neutral"}
        />
        <AdminPolicyStatusRow
          title="Admin sign-in policy"
          detail={
            settings?.require_sso_for_admins
              ? "SSO is required for administrator accounts by service policy."
              : "Explicitly provisioned admin accounts may use the platform sign-in path."
          }
          status={settings?.require_sso_for_admins ? "SSO required" : "Local allowed"}
          tone={settings?.require_sso_for_admins ? "warning" : "neutral"}
        />
        <AdminPolicyStatusRow
          title="SSO configuration"
          detail={
            settings?.tenant_admins_can_manage_sso
              ? "You may configure organization SSO mappings; secrets stay vaulted."
              : "SSO configuration is read-only under the current service policy."
          }
          status={settings?.tenant_admins_can_manage_sso ? "Available" : "Read only"}
          tone={settings?.tenant_admins_can_manage_sso ? "success" : "neutral"}
        />
        <AdminPolicyStatusRow
          title="New model defaults"
          detail={
            settings?.default_user_group_enabled
              ? "Newly available models begin with Default Users; you can narrow each model under Model Access."
              : "Newly available models require an explicit group grant under Model Access."
          }
          status={settings?.default_user_group_enabled ? "Default Users" : "Explicit grants"}
          tone="info"
        />
      </div>

      <div className="policy-callout">
        <ShieldCheck size={15} />
        <span>
          Downstream defaults apply to the protected Default Users group. Use Groups for exceptions, Model Access for available models, and Connections for available connectors.
        </span>
      </div>

      <div className="policy-toggle-stack">
        <AdminDefaultPolicyToggleRow
          title="Default users can use downstream API"
          detail={
            downstreamApiEnabled
              ? "Allow people in Default Users to create personal API keys for their approved models."
              : "Unavailable under the current service policy. The saved group grant is preserved."
          }
          checked={Boolean(defaultPermissions.api_access)}
          disabled={!defaultGroup || !downstreamApiEnabled || pendingAction === "policy-default-group-api_access"}
          label="Default users can use downstream API"
          onChange={(next) => onDefaultPermissionChange("api_access", next)}
        />
        <AdminDefaultPolicyToggleRow
          title="Default users can build agents"
          detail={
            agentAuthoringEnabled
              ? "Allow people in Default Users to build private agents from available models. Organization publishing stays admin-only."
              : "Unavailable under the current service policy. The saved group grant is preserved."
          }
          checked={Boolean(defaultPermissions.agent_authoring)}
          disabled={!defaultGroup || !agentAuthoringEnabled || pendingAction === "policy-default-group-agent_authoring"}
          label="Default users can build agents"
          onChange={(next) => onDefaultPermissionChange("agent_authoring", next)}
        />
        <AdminDefaultPolicyToggleRow
          title="Default users can build knowledge bases"
          detail="Allow people in Default Users to create and maintain their own private knowledge bases. Sharing with groups stays admin-only."
          checked={Boolean(defaultPermissions.knowledge_authoring)}
          disabled={!defaultGroup || pendingAction === "policy-default-group-knowledge_authoring"}
          label="Default users can build knowledge bases"
          onChange={(next) => onDefaultPermissionChange("knowledge_authoring", next)}
        />
        <AdminDefaultPolicyToggleRow
          title="Default users can build tools"
          detail="Allow people in Default Users to create and maintain their own private tools. Group sharing and stdio commands stay admin-only."
          checked={Boolean(defaultPermissions.tool_authoring)}
          disabled={!defaultGroup || pendingAction === "policy-default-group-tool_authoring"}
          label="Default users can build tools"
          onChange={(next) => onDefaultPermissionChange("tool_authoring", next)}
        />
        <AdminDefaultPolicyToggleRow
          title="Default users can use memory"
          detail={
            !platformMemoryEnabled
              ? "Unavailable under the current service policy. The saved group grant is preserved."
              : !tenantMemoryEnabled
                ? "Turn on Memory for this organization below before granting the default group access."
                : "Allow people in Default Users to save and recall private personalization memory."
          }
          checked={Boolean(defaultPermissions.memory_access)}
          disabled={
            !defaultGroup ||
            !platformMemoryEnabled ||
            !tenantMemoryEnabled ||
            pendingAction === "policy-default-group-memory_access"
          }
          label="Default users can use memory"
          onChange={(next) => onDefaultPermissionChange("memory_access", next)}
        />
      </div>
    </Panel>
  );
}

function AdminPolicyStatusRow({
  title,
  detail,
  status,
  tone,
}: {
  title: string;
  detail: string;
  status: string;
  tone: "neutral" | "success" | "warning" | "danger" | "info";
}) {
  return (
    <div className="permission-row policy-toggle-row">
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <Pill tone={tone}>{status}</Pill>
    </div>
  );
}

function AdminDefaultPolicyToggleRow({
  title,
  detail,
  checked,
  disabled,
  label,
  onChange,
}: {
  title: string;
  detail: string;
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="permission-row policy-toggle-row">
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <Toggle checked={checked} disabled={disabled} label={label} tooltip={detail} onChange={onChange} />
    </div>
  );
}

function MemoryAdminPanel({
  policy,
  stats,
  error,
  pendingAction,
  onPolicyChange,
  onPurgeUser,
  onRefresh,
}: {
  policy: TenantMemoryPolicy | null;
  stats: MemoryUserStat[] | null;
  error: string | null;
  pendingAction: string | null;
  onPolicyChange: (patch: TenantMemoryPolicyUpdateRequest) => void;
  onPurgeUser: (stat: MemoryUserStat) => void;
  onRefresh: () => void;
}) {
  const enabled = Boolean(policy?.enabled);
  const savingPolicy = pendingAction === "memory-policy";
  const withMemories = (stats ?? []).filter((stat) => stat.count > 0);
  const [confirmingPurgeId, setConfirmingPurgeId] = useState<string | null>(null);
  // Drafts hold in-progress typing so transient values like "3" while typing
  // "30" are never persisted; the policy PATCH only fires on blur or Enter.
  const [retentionDraft, setRetentionDraft] = useState<string | null>(null);
  const [maxMemoriesDraft, setMaxMemoriesDraft] = useState<string | null>(null);

  function commitRetention() {
    if (retentionDraft === null) return;
    const next = Number(retentionDraft);
    setRetentionDraft(null);
    if (Number.isFinite(next) && next >= 1 && next <= 3650 && next !== (policy?.retention_days ?? 365)) {
      onPolicyChange({ retention_days: next });
    }
  }

  function commitMaxMemories() {
    if (maxMemoriesDraft === null) return;
    const next = Number(maxMemoriesDraft);
    setMaxMemoriesDraft(null);
    if (Number.isFinite(next) && next >= 1 && next <= 2000 && next !== (policy?.max_memories_per_user ?? 200)) {
      onPolicyChange({ max_memories_per_user: next });
    }
  }

  return (
    <div className="admin-memory-stack">
      <Panel
        title={<><Brain size={18} /> Personalization Memory</>}
        subtitle="Let the assistant remember each person's stated preferences and reuse them on later turns."
        defaultCollapsed
      >
        <div className="permission-row policy-toggle-row">
          <span>
            <strong>Memory for this organization</strong>
            <small>
              {enabled
                ? "Users can build a private memory of their own preferences, and the assistant applies it on every turn."
                : "Nothing is stored or injected. Existing memories stay saved but are not used until you turn this back on."}
            </small>
          </span>
          <Toggle
            checked={enabled}
            disabled={savingPolicy}
            label="Memory for this organization"
            tooltip="Turn personalization memory on or off for everyone in this organization"
            onChange={(next) => onPolicyChange({ enabled: next })}
          />
        </div>
        <div className="permission-row policy-toggle-row">
          <span>
            <strong>Learn from conversations automatically</strong>
            <small>
              {policy?.auto_capture_enabled
                ? "The assistant may infer durable preferences after a reply is delivered. Users can still opt out individually."
                : "Only preferences a user states outright (\"remember that ...\") are saved."}
            </small>
          </span>
          <Toggle
            checked={Boolean(policy?.auto_capture_enabled)}
            disabled={savingPolicy || !enabled}
            label="Learn from conversations automatically"
            tooltip="Allow the assistant to infer preferences instead of only capturing explicit ones"
            onChange={(next) => onPolicyChange({ auto_capture_enabled: next })}
          />
        </div>
        <div className="memory-policy-numbers">
          <label>
            <span>Retention (days)</span>
            <input
              type="number"
              min={1}
              max={3650}
              value={retentionDraft ?? policy?.retention_days ?? 365}
              data-tooltip="Memories older than this are retired automatically"
              onChange={(event) => setRetentionDraft(event.target.value)}
              onBlur={commitRetention}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </label>
          <label>
            <span>Maximum memories per user</span>
            <input
              type="number"
              min={1}
              max={2000}
              value={maxMemoriesDraft ?? policy?.max_memories_per_user ?? 200}
              data-tooltip="Once a user passes this count the least useful unpinned memories are retired"
              onChange={(event) => setMaxMemoriesDraft(event.target.value)}
              onBlur={commitMaxMemories}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </label>
        </div>
        <div className="policy-callout">
          <Lock size={15} />
          <span>
            Memory content is private to the person it belongs to. You can see how many memories each user has and delete
            them for compliance, but administrators cannot read what any memory says.
          </span>
        </div>
      </Panel>

      <Panel
        title="Memory by User"
        subtitle="Counts only. Opening this list never reveals what any individual memory says."
        defaultCollapsed
        actions={
          <button
            className="secondary-button compact"
            type="button"
            data-tooltip="Reload memory counts for this organization"
            onClick={onRefresh}
          >
            <RefreshCw size={14} /> Refresh
          </button>
        }
      >
        {error ? (
          <div className="audit-empty-state">
            <ShieldCheck size={20} />
            <span>
              <strong>Memory data could not be loaded</strong>
              <small>{error}</small>
            </span>
          </div>
        ) : stats === null ? (
          <div className="audit-empty-state">
            <Brain size={20} />
            <span>
              <strong>Memory reporting not connected</strong>
              <small>Per-user counts load from the admin memory API when it is available.</small>
            </span>
          </div>
        ) : withMemories.length === 0 ? (
          <div className="audit-empty-state">
            <Brain size={20} />
            <span>
              <strong>No memories stored yet</strong>
              <small>Counts appear here as people use the assistant.</small>
            </span>
          </div>
        ) : (
          <div className="memory-stats-list" role="list" aria-label="Memory counts by user">
            {withMemories.map((stat) => (
              <div className="audit-row memory-stat-row" role="listitem" key={stat.user_id}>
                <Brain size={17} />
                <span>
                  <strong>{stat.display_name}</strong>
                  <small>
                    {stat.email} · {stat.count} {stat.count === 1 ? "memory" : "memories"}
                  </small>
                </span>
                {confirmingPurgeId === stat.user_id ? (
                  <span className="memory-purge-confirm">
                    <span>Purge all {stat.count}? This cannot be undone.</span>
                    <button
                      className="secondary-button compact"
                      type="button"
                      disabled={pendingAction === `memory-purge-${stat.user_id}`}
                      onClick={() => {
                        setConfirmingPurgeId(null);
                        onPurgeUser(stat);
                      }}
                    >
                      <Check size={14} /> Yes, purge
                    </button>
                    <button className="secondary-button compact" type="button" onClick={() => setConfirmingPurgeId(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    className="secondary-button compact"
                    type="button"
                    disabled={pendingAction === `memory-purge-${stat.user_id}`}
                    data-tooltip={`Delete every memory belonging to ${stat.display_name} without reading them`}
                    onClick={() => setConfirmingPurgeId(stat.user_id)}
                  >
                    <Trash2 size={14} /> Purge
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
