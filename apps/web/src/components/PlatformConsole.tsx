import { SelectControl } from "./SelectControl";
import { ProviderBrandLogo } from "./providerIcons";
import { ConnectorsPanel, type ConnectorsPanelApi } from "./ConnectorsPanel";
import * as Tabs from "@radix-ui/react-tabs";
import { QRCodeSVG } from "qrcode.react";
import {
  BarChart3,
  BookOpen,
  Bot,
  Bug,
  ChevronDown,
  Clock3,
  Copy,
  DatabaseZap,
  Download,
  Edit3,
  Eye,
  Filter,
  KeyRound,
  LineChart,
  ListChecks,
  Lock,
  Mail,
  MessageSquareText,
  Palette,
  Paperclip,
  Plus,
  QrCode,
  RotateCcw,
  Save,
  Search,
  ServerCog,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Upload,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { Fragment, Suspense, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";

import { LazyChunkBoundary, lazyWithReload } from "../lib/lazyChunk";
import type {
  AuditEvent,
  BootstrapData,
  Connector,
  ElasticStatus,
  ModelConfig,
  PlatformProviderKeyCreateRequest,
  PlatformSettings,
  PlatformSettingsUpdateRequest,
  Provider,
  ProviderKey,
  ProviderKeySecret,
  ProviderModelSyncResult,
  Role,
  SecurityAlert,
  SsoConfig,
  Tenant,
  TenantBrandingUpdateRequest,
  AlertNotification,
  AlertRule,
  AlertRuleCreateRequest,
  AlertRuleUpdateRequest,
  EmailSettings,
  EmailSettingsUpdateRequest,
  ChatFeedbackRecord,
  IssueReportRecord,
  EmailTestResult,
  RetentionBatchRequest,
  RetentionBatchResult,
  RetentionTaggedThread,
  TenantRetentionPolicy,
  TenantRetentionPolicyUpdateRequest,
  UsageRecord,
  UsageSummary,
  UserPromptRecord,
  User as PlatformUser,
  AdminSsoConfigCreateRequest,
  AdminSsoConfigUpdateRequest,
  AdminUserCreateRequest,
  AdminUserUpdateRequest,
} from "../lib/types";
import {
  CHAT_FEEDBACK_UPDATED_EVENT,
  loadChatFeedback,
  type ChatFeedbackEvent,
} from "../lib/chatFeedback";
import { ssoRedirectUri, type SsoTestResult } from "../lib/api";
import {
  getPlatformUsageBudget,
  updatePlatformUsageBudget,
  UsageBudgetRequestError,
  type TenantUsageBudgetSnapshot,
} from "../lib/api/platform";
import { modelLabLabel } from "../lib/modelAccess";
import { userIdentityTooltip } from "../lib/userIdentity";
import { ApertureMark, Panel, Pill, StableLabel, Toggle } from "./Primitives";
import { UserAvatar } from "./UserAvatar";
import {
  EMPTY_SECTION_SCOPE,
  SectionScopeFilter,
  sectionScopeMatch,
  timestampInDateRange,
  type SectionScope,
} from "./SectionScopeFilter";

const OwnerDocumentationModal = lazyWithReload("owner-documentation", () =>
  import("./OwnerTrainingVideos").then((module) => ({ default: module.OwnerDocumentationModal })),
);
import { PasswordResetDialog } from "./PasswordResetDialog";
import { FeedbackConversationPreview, PromptActivityList } from "./PromptActivityList";
import { IssueReportPreview } from "./IssueReportPreview";
import { markdownToPlainText } from "../lib/markdown";
import { RetentionPanel, RetentionTagsView } from "./RetentionPanel";
import { AlertsConsole, type AlertsConsoleApi } from "./AlertsConsole";
import { AuditSummaryCard, type AuditSummaryItem } from "./AuditSummaryCard";

type ActionStatus = {
  tone: "success" | "warning" | "info";
  message: string;
};

type RuntimeAuditRow = {
  id: string;
  surface: "chat" | "draft";
  title: string;
  detail: string;
  metadata: string;
  executedAt: string;
  actorId: string;
  actorName: string;
};

type CsvValue = string | number | boolean | null | undefined;
type CsvColumn<T> = {
  header: string;
  value: (item: T) => CsvValue;
};

type ProviderDraftState = {
  name: string;
  kind: string;
  region: string;
  base_url: string;
  auth_type: string;
  header_name: string;
  api_version: string;
  deployment_id: string;
  catalog_scope: string;
  secret_value: string;
  key_name: string;
  key_environment: string;
  key_expires: string;
};

type ProviderConnectionDraftState = Omit<
  ProviderDraftState,
  "secret_value" | "key_name" | "key_environment" | "key_expires"
>;

type ModelEditDraftState = {
  name: string;
  upstream_model_id: string;
  notes: string;
  context_window: string;
  system_prompt: string;
  meta_prompt: string;
};

type RevealedKeyDialogState = {
  key: ProviderKey;
  secretValue: string;
};

type ProviderDeleteDialogState = {
  provider: Provider;
  modelCount: number;
  keyCount: number;
  typedName: string;
  error: string | null;
  pending: boolean;
};

type CopyStatus = "idle" | "copied" | "failed";

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
  const filteredItems = items.filter((item) => timestampInDateRange(getTimestamp(item), fromDate, throughDate));
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
        aria-label={`Export ${label} CSV`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tooltip={`Choose a date range and download ${label} as CSV`}
        onClick={() => setOpen((value) => !value)}
      >
        <Download size={14} /> CSV
      </button>
      {open && (
        <div className="csv-export-popover" role="dialog" aria-label={`${label} CSV date range`}>
          <div>
            <strong>CSV date range</strong>
            <small>{filteredItems.length.toLocaleString()} of {items.length.toLocaleString()} rows selected</small>
          </div>
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
            <button
              className="secondary-button compact"
              type="button"
              onClick={() => {
                setFromDate("");
                setThroughDate("");
              }}
            >
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

type TenantPolicyState = {
  downstreamApiEnabled: boolean;
  usersCanCreateModels: boolean;
  requireSsoForAdmins: boolean;
  tenantAdminsCanManageSso: boolean;
  tenantAdminsCanCreateAdmins: boolean;
  defaultUserGroupEnabled: boolean;
  memoryEnabled: boolean;
};

const POLICY_FIELD_BY_KEY: Record<keyof TenantPolicyState, keyof PlatformSettings> = {
  downstreamApiEnabled: "downstream_api_enabled",
  usersCanCreateModels: "users_can_create_models",
  requireSsoForAdmins: "require_sso_for_admins",
  tenantAdminsCanManageSso: "tenant_admins_can_manage_sso",
  tenantAdminsCanCreateAdmins: "tenant_admins_can_create_admins",
  defaultUserGroupEnabled: "default_user_group_enabled",
  memoryEnabled: "memory_enabled",
};

type OwnerUserDraftState = {
  display_name: string;
  email: string;
  role: Extract<Role, "PLATFORM_OWNER" | "TENANT_ADMIN" | "USER">;
};

type BrandingDraftState = {
  chat_brand_name: string;
  logo_url: string;
  icon_url: string;
  primary_color: string;
  custom_domain: string;
  gradient_start: string;
  gradient_end: string;
  text_color: string;
};

const DEFAULT_BRANDING: BrandingDraftState = {
  chat_brand_name: "Aperture Chat",
  logo_url: "",
  icon_url: "",
  primary_color: "#087d8b",
  custom_domain: "chat.example.com",
  gradient_start: "",
  gradient_end: "",
  text_color: "",
};

const HEX_COLOR_INPUT_RE = /^#[0-9a-fA-F]{6}$/;

// Keep uploaded marks small enough to live inline in tenant state: the mark is
// rendered at 24-34px, so 256px is plenty and keeps the data URL a few KB.
const BRANDING_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
const BRANDING_MARK_MAX_EDGE = 256;
// A raw (non-resized) data URL must stay inside the API's 400k-char branding
// cap; base64 inflates ~4/3, so 250 KB of PNG is the safe ceiling.
const BRANDING_RAW_FALLBACK_MAX_BYTES = 250 * 1024;

async function downscalePngToDataUrl(file: File): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, BRANDING_MARK_MAX_EDGE / Math.max(bitmap.width, bitmap.height, 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

function readFileAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(typeof reader.result === "string" && reader.result ? reader.result : null);
    });
    reader.addEventListener("error", () => resolve(null));
    reader.readAsDataURL(file);
  });
}

type OwnerSsoDraftState = {
  name: string;
  protocol: SsoConfig["protocol"];
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  entityId: string;
  samlLoginUrl: string;
  samlLogoutUrl: string;
  samlCertificate: string;
  duoApiHostname: string;
  scimBaseUrl: string;
  groupClaim: string;
  domains: string;
  mfaProvider: string;
  mfaMethods: string;
  qrEnrollmentUri: string;
  enforced: boolean;
  jitProvisioning: boolean;
  requirePlatformMfa: boolean;
};

const PROVIDER_KIND_OPTIONS = [
  "openai",
  "anthropic",
  "azure-openai",
  "azure-foundry",
  "gcp",
  "amazon-bedrock",
  "xai",
  "mistral",
  "deepseek",
  "groq",
  "together",
  "fireworks",
  "perplexity",
  "cerebras",
  "sambanova",
  "moonshot",
  "nvidia",
  "deepinfra",
  "cohere",
  "open-webui",
  "openrouter",
  "ollama",
  "openai-compatible",
  "local",
];

// Amazon Bedrock's native API needs AWS SigV4 signing, which the gateway
// cannot produce from a single vaulted secret. Every other kind routes: known
// kinds use their dialect, and unknown kinds ride the OpenAI-compatible
// dialect by default, mirroring the API gateway's routing rules.
const RUNTIME_UNSUPPORTED_PROVIDER_KINDS = new Set(["amazon-bedrock", "bedrock"]);

const OPENROUTER_CATALOG_SCOPE_OPTIONS = [
  { value: "zdr", label: "ZDR models" },
  { value: "user", label: "Key-scoped models" },
];

const TAB_TOOLTIPS: Record<string, string> = {
  models: "Review and control which models this workspace is allowed to use",
  providers: "Register providers and manage their connections and API keys",
  "org-settings": "Manage roles, SSO, branding, policies, budgets, and platform connectors",
  analytics: "View runtime execution timestamps and chat feedback trends",
  audit: "Inspect governance signals and the append-only audit trail",
  alerts: "Define alert rules and review email delivery of suspicious-activity notifications",
};

type ModelStatusFilter = "all" | "enabled" | "disabled";

const MODEL_STATUS_FILTER_OPTIONS: Array<{ value: ModelStatusFilter; label: string; tooltip: string }> = [
  { value: "all", label: "All", tooltip: "Show every model, enabled and disabled" },
  { value: "enabled", label: "Enabled", tooltip: "Show only models tenants can currently use" },
  { value: "disabled", label: "Disabled", tooltip: "Show only models that are turned off for the organization" },
];

const MODEL_CATALOG_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function compareModelsByCatalogName(a: ModelConfig, b: ModelConfig) {
  return (
    MODEL_CATALOG_COLLATOR.compare(a.name, b.name) ||
    MODEL_CATALOG_COLLATOR.compare(a.provider_name, b.provider_name) ||
    MODEL_CATALOG_COLLATOR.compare(a.upstream_model_id ?? "", b.upstream_model_id ?? "") ||
    MODEL_CATALOG_COLLATOR.compare(a.id, b.id)
  );
}

type EnrollmentQrValidation = {
  valid: boolean;
  value: string;
  message: string;
};

const TOTP_SECRET_PATTERN = /^[A-Z2-7]+=*$/i;

function validateEnrollmentQrValue(rawValue: string): EnrollmentQrValidation {
  const value = rawValue.trim();
  if (!value) {
    return {
      valid: false,
      value,
      message: "Add an enrollment URI to generate a scannable QR code.",
    };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      valid: false,
      value,
      message: "Enter a valid otpauth:// TOTP/HOTP URI or identity-provider enrollment URL.",
    };
  }

  const protocol = url.protocol.toLowerCase();
  if (protocol === "otpauth:") {
    const method = url.hostname.toLowerCase();
    const secret = (url.searchParams.get("secret") ?? "").replace(/\s/g, "");
    const normalizedSecret = secret.replace(/=+$/g, "");
    const hasValidMethod = method === "totp" || method === "hotp";
    const hasValidSecret = normalizedSecret.length >= 16 && TOTP_SECRET_PATTERN.test(secret);
    if (hasValidMethod && hasValidSecret) {
      return { valid: true, value, message: "" };
    }
    return {
      valid: false,
      value,
      message: "Use a valid TOTP/HOTP URI with a base32 secret of at least 16 characters.",
    };
  }

  if (protocol === "https:" || protocol === "duo:" || protocol === "duoapi:") {
    return { valid: true, value, message: "" };
  }

  return {
    valid: false,
    value,
    message: "Use otpauth://, https://, or a Duo enrollment URI.",
  };
}

// Parent code can adapt future API helpers to these hooks without importing draft endpoints here.
export type PlatformConsoleActions = ConnectorsPanelApi & {
  createProvider?: (provider: Provider) => Promise<Provider | void> | Provider | void;
  updateProvider?: (providerId: string, patch: Partial<Provider>) => Promise<Provider | void> | Provider | void;
  createProviderKey?: (payload: PlatformProviderKeyCreateRequest) => Promise<ProviderKey | void> | ProviderKey | void;
  syncProviderModels?: (providerId: string) => Promise<ProviderModelSyncResult | void> | ProviderModelSyncResult | void;
  updateModel?: (modelId: string, patch: Partial<ModelConfig>) => Promise<ModelConfig | void> | ModelConfig | void;
  revealProviderKey?: (keyId: string) => Promise<ProviderKeySecret | void> | ProviderKeySecret | void;
  rotateProviderKey?: (keyId: string) => Promise<ProviderKey | void> | ProviderKey | void;
  deleteProviderKey?: (keyId: string) => Promise<void> | void;
  deleteProvider?: (
    providerId: string,
    confirm: string,
  ) => Promise<{ models_deleted: number; keys_deleted: number } | void> | void;
  updateConnector?: (connectorId: string, patch: Partial<Connector>) => Promise<Connector | void> | Connector | void;
  createUser?: (payload: AdminUserCreateRequest) => Promise<PlatformUser | void> | PlatformUser | void;
  updateUser?: (userId: string, patch: AdminUserUpdateRequest) => Promise<PlatformUser | void> | PlatformUser | void;
  deactivateUser?: (userId: string) => Promise<void> | void;
  deleteUser?: (userId: string) => Promise<void> | void;
  resetUserPassword?: (userId: string, payload: { password: string; temporary: boolean }) => Promise<void> | void;
  listAuditEvents?: () => Promise<AuditEvent[] | void> | AuditEvent[] | void;
  listPromptActivity?: (userId?: string) => Promise<UserPromptRecord[] | void> | UserPromptRecord[] | void;
  /** Loads every saved exchange of one chat thread so the audit preview can
   * show the full conversation, not just the clicked record. */
  listThreadPromptActivity?: (threadId: string) => Promise<UserPromptRecord[] | void> | UserPromptRecord[] | void;
  // Data retention governance for the sole tenant. Metadata only.
  getRetentionPolicy?: () => Promise<TenantRetentionPolicy | void>;
  updateRetentionPolicy?: (
    patch: TenantRetentionPolicyUpdateRequest,
  ) => Promise<TenantRetentionPolicy | void>;
  listRetentionThreads?: () => Promise<RetentionTaggedThread[] | void>;
  /** Server-side response sentiment with user notes. */
  listChatFeedback?: () => Promise<ChatFeedbackRecord[] | void>;
  listIssueReports?: () => Promise<IssueReportRecord[] | void>;
  loadIssueReportScreenshot?: (reportId: string) => Promise<Blob>;
  runRetentionBatch?: (payload: RetentionBatchRequest) => Promise<RetentionBatchResult | void>;
  listSecurityAlerts?: (userId?: string) => Promise<SecurityAlert[] | void> | SecurityAlert[] | void;
  acknowledgeSecurityAlert?: (
    alertId: string,
    acknowledged: boolean,
  ) => Promise<SecurityAlert | void> | SecurityAlert | void;
  getUsageSummary?: (options?: {
    targetUserId?: string;
    fromDate?: string;
    throughDate?: string;
  }) => Promise<UsageSummary | void> | UsageSummary | void;
  listUsageRecords?: (userId?: string) => Promise<UsageRecord[] | void> | UsageRecord[] | void;
  listAlertRules?: () => Promise<AlertRule[] | void>;
  createAlertRule?: (payload: AlertRuleCreateRequest) => Promise<AlertRule | void>;
  updateAlertRule?: (ruleId: string, patch: AlertRuleUpdateRequest) => Promise<AlertRule | void>;
  deleteAlertRule?: (ruleId: string) => Promise<void>;
  listAlertNotifications?: () => Promise<AlertNotification[] | void>;
  setAlertNotificationArchived?: (
    notificationId: string,
    archived: boolean,
  ) => Promise<AlertNotification | void>;
  getEmailSettings?: () => Promise<EmailSettings | void>;
  updateEmailSettings?: (patch: EmailSettingsUpdateRequest) => Promise<EmailSettings | void>;
  sendEmailTest?: (recipient: string) => Promise<EmailTestResult | void>;
  updateSsoConfig?: (configId: string, patch: AdminSsoConfigUpdateRequest) => Promise<SsoConfig | void> | SsoConfig | void;
  createSsoConfig?: (payload: AdminSsoConfigCreateRequest) => Promise<SsoConfig | void> | SsoConfig | void;
  testSsoConfig?: (configId: string) => Promise<SsoTestResult | void> | SsoTestResult | void;
  getPlatformSettings?: () => Promise<PlatformSettings | void> | PlatformSettings | void;
  updatePlatformSettings?: (patch: PlatformSettingsUpdateRequest) => Promise<PlatformSettings | void> | PlatformSettings | void;
  updateTenantBranding?: (tenantId: string, patch: TenantBrandingUpdateRequest) => Promise<Tenant | void> | Tenant | void;
  getElasticStatus?: () => Promise<ElasticStatus | void> | ElasticStatus | void;
};

export function PlatformConsole({
  data,
  onDataChange,
  platformActions,
  openDocumentationRequestKey,
  openProvidersRequestKey,
  onOpenAdminDocumentation,
  onOpenUserHelp,
}: {
  data: BootstrapData;
  onDataChange: (updater: (current: BootstrapData) => BootstrapData) => void;
  platformActions?: PlatformConsoleActions;
  openDocumentationRequestKey?: number;
  openProvidersRequestKey?: number;
  onOpenAdminDocumentation?: () => void;
  onOpenUserHelp?: () => void;
}) {
  // Defaults mirror the backend platform-settings record; the effect below
  // replaces them with the persisted server state when the API is connected.
  const [tenantPolicies, setTenantPolicies] = useState<TenantPolicyState>({
    downstreamApiEnabled: false,
    usersCanCreateModels: false,
    requireSsoForAdmins: false,
    tenantAdminsCanManageSso: true,
    tenantAdminsCanCreateAdmins: false,
    defaultUserGroupEnabled: true,
    memoryEnabled: false,
  });
  const [ownerUserDraft, setOwnerUserDraft] = useState<OwnerUserDraftState>({
    display_name: "",
    email: "",
    role: "USER",
  });
  const [brandingDraft, setBrandingDraft] = useState<BrandingDraftState>({
    chat_brand_name: data.currentTenant.chat_brand_name ?? DEFAULT_BRANDING.chat_brand_name,
    logo_url: data.currentTenant.logo_url ?? DEFAULT_BRANDING.logo_url,
    icon_url: data.currentTenant.icon_url ?? DEFAULT_BRANDING.icon_url,
    primary_color: data.currentTenant.primary_color ?? DEFAULT_BRANDING.primary_color,
    custom_domain: data.currentTenant.custom_domain ?? DEFAULT_BRANDING.custom_domain,
    gradient_start: data.currentTenant.gradient_start ?? DEFAULT_BRANDING.gradient_start,
    gradient_end: data.currentTenant.gradient_end ?? DEFAULT_BRANDING.gradient_end,
    text_color: data.currentTenant.text_color ?? DEFAULT_BRANDING.text_color,
  });
  /* Branding feedback renders inside the branding panel: the console-level
   * notice sits above the tab stack, off-screen when the panel is in view. */
  const [brandingStatus, setBrandingStatus] = useState<ActionStatus | null>(null);
  const [brandingUploadPending, setBrandingUploadPending] = useState(false);
  // In-flight PNG processing; Apply awaits this so the image is never dropped.
  const brandingUploadRef = useRef<Promise<string | null> | null>(null);
  // Mirrors committed data so an optimistic owner-console change can be undone
  // when the server refuses it. These controls govern provider credentials,
  // roles and model availability, so showing an un-persisted value as applied
  // would misreport who has access to what.
  const dataRef = useRef(data);
  dataRef.current = data;

  /** Snapshot now; call the result to put the console back if the save fails. */
  function beginOptimisticChange(): () => void {
    const snapshot = dataRef.current;
    return () => onDataChange(() => snapshot);
  }
  const [ownerSsoDraft, setOwnerSsoDraft] = useState<OwnerSsoDraftState>({
    name: data.ssoConfigs[0]?.name ?? "Microsoft Entra ID",
    protocol: data.ssoConfigs[0]?.protocol ?? "OIDC",
    issuer: data.ssoConfigs[0]?.issuer ?? "",
    clientId: data.ssoConfigs[0]?.client_id ?? "",
    clientSecret: "",
    redirectUrl: data.ssoConfigs[0]?.redirect_url ?? "",
    entityId: data.ssoConfigs[0]?.entity_id ?? "",
    samlLoginUrl: data.ssoConfigs[0]?.saml_login_url ?? "",
    samlLogoutUrl: data.ssoConfigs[0]?.saml_logout_url ?? "",
    samlCertificate: data.ssoConfigs[0]?.saml_certificate ?? "",
    duoApiHostname: data.ssoConfigs[0]?.duo_api_hostname ?? "",
    scimBaseUrl: data.ssoConfigs[0]?.scim_base_url ?? "",
    groupClaim: data.ssoConfigs[0]?.group_claim ?? "groups",
    domains: data.ssoConfigs[0]?.domains.join(", ") ?? "",
    mfaProvider: data.ssoConfigs[0]?.mfa_provider ?? "Microsoft Authenticator",
    mfaMethods: data.ssoConfigs[0]?.mfa_methods?.join(", ") ?? "Microsoft Authenticator, Duo Mobile",
    qrEnrollmentUri: data.ssoConfigs[0]?.qr_enrollment_uri ?? "",
    // New baselines default to non-enforced so an owner cannot lock out local
    // sign-in before the provider has been tested.
    enforced: data.ssoConfigs[0]?.enforced ?? false,
    jitProvisioning: data.ssoConfigs[0]?.jit_provisioning ?? true,
    // Off by default: the identity provider's own MFA is the second factor.
    requirePlatformMfa: data.ssoConfigs[0]?.require_platform_mfa ?? false,
  });
  const [ssoTestResult, setSsoTestResult] = useState<SsoTestResult | null>(null);
  // Honest default: disconnected until the backend reports configured env credentials.
  const [elasticStatus, setElasticStatus] = useState<ElasticStatus | null>(null);
  const [activeSection, setActiveSection] = useState(openProvidersRequestKey ? "providers" : "org-settings");
  const [showProviderForm, setShowProviderForm] = useState(false);
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<ActionStatus | null>(null);
  const [passwordTarget, setPasswordTarget] = useState<PlatformUser | null>(null);
  const [revealedKeyDialog, setRevealedKeyDialog] = useState<RevealedKeyDialogState | null>(null);
  const [providerDeleteDialog, setProviderDeleteDialog] = useState<ProviderDeleteDialogState | null>(
    null,
  );
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  const [expandedModelIds, setExpandedModelIds] = useState<Record<string, boolean>>({});
  const [modelEditDrafts, setModelEditDrafts] = useState<Record<string, ModelEditDraftState>>({});
  const [expandedProviderIds, setExpandedProviderIds] = useState<Record<string, boolean>>({});
  const [providerEditDrafts, setProviderEditDrafts] = useState<Record<string, ProviderConnectionDraftState>>({});
  const [showDocumentation, setShowDocumentation] = useState(false);
  const [chatFeedback, setChatFeedback] = useState<ChatFeedbackEvent[]>(() => loadChatFeedback());
  const [serverFeedback, setServerFeedback] = useState<ChatFeedbackRecord[] | null>(null);
  const [feedbackRefreshTick, setFeedbackRefreshTick] = useState(0);
  const [feedbackPreview, setFeedbackPreview] = useState<FeedbackDisplayItem | null>(null);
  const [issueReports, setIssueReports] = useState<IssueReportRecord[]>([]);
  const [issueReportPreview, setIssueReportPreview] = useState<IssueReportRecord | null>(null);
  const [modelSearch, setModelSearch] = useState("");
  const [modelStatusFilter, setModelStatusFilter] = useState<ModelStatusFilter>("all");
  // Column facets for the model list: empty selections mean "no filter".
  const [modelProviderFilter, setModelProviderFilter] = useState<string[]>([]);
  const [modelLabFilter, setModelLabFilter] = useState<string[]>([]);
  const [modelRouteFilter, setModelRouteFilter] = useState("");
  const [openModelColumnFilter, setOpenModelColumnFilter] = useState<"provider" | "lab" | "route" | null>(null);
  const [expandedProviderKeyIds, setExpandedProviderKeyIds] = useState<Record<string, boolean>>({});
  const [providerDraft, setProviderDraft] = useState<ProviderDraftState>({
    name: "",
    kind: "openai-compatible",
    region: "Global",
    base_url: "",
    auth_type: "bearer",
    header_name: "Authorization",
    api_version: "",
    deployment_id: "",
    catalog_scope: "",
    secret_value: "",
    key_name: "",
    key_environment: "Production",
    key_expires: "Not set",
  });
  const [keyDraft, setKeyDraft] = useState({
    provider_id: data.providers[0]?.id ?? "",
    name: "",
    environment: "Production",
    expires: "Not set",
    secret_value: "",
  });
  const [auditTrail, setAuditTrail] = useState<AuditEvent[] | null>(null);
  const [auditTrailError, setAuditTrailError] = useState<string | null>(null);
  const [auditTrailRefreshToken, setAuditTrailRefreshToken] = useState(0);
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
  // Every analytics and audit section carries its own user + date scope, so
  // filtering one panel never silently narrows a different panel or export.
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
  const runtimeAuditRows = useMemo(() => platformRuntimeAuditRows(auditTrail ?? []), [auditTrail]);
  const filteredRuntimeAuditRows = useMemo(
    () => runtimeAuditRows.filter((item) => sectionScopeMatch(runtimeScope, item.executedAt, item.actorId)),
    [runtimeScope, runtimeAuditRows],
  );
  // Server records (every user and device) win; the browser-local trail is
  // a fallback when the endpoint is not connected.
  const feedbackSource: FeedbackDisplayItem[] = serverFeedback ?? chatFeedback;
  const filteredChatFeedback = useMemo(
    () => feedbackSource.filter((item) => sectionScopeMatch(feedbackScope, item.created_at, item.user_id)),
    [feedbackScope, feedbackSource],
  );
  const positiveFeedback = filteredChatFeedback.filter((item) => item.rating === "positive");
  const negativeFeedback = filteredChatFeedback.filter((item) => item.rating === "negative");
  const filteredIssueReports = useMemo(
    () => issueReports.filter((item) => sectionScopeMatch(feedbackScope, item.created_at, item.user_id)),
    [feedbackScope, issueReports],
  );
  const chatRuntimeRows = filteredRuntimeAuditRows.filter((item) => item.surface === "chat");
  const draftRuntimeRows = filteredRuntimeAuditRows.filter((item) => item.surface === "draft");
  // Every user is auditable here, peer platform owners included: owners hold
  // each other accountable, so one owner's prompts and outputs are visible to
  // the others. Tenant admin surfaces still never expose owner activity.
  const auditUsers = useMemo(
    () =>
      [...data.users]
        .sort((a, b) => a.display_name.localeCompare(b.display_name) || a.email.localeCompare(b.email)),
    [data.users],
  );
  const auditUserIds = useMemo(() => new Set(auditUsers.map((user) => user.id)), [auditUsers]);
  const promptScopeUser = promptScope.userId === "all"
    ? null
    : auditUsers.find((user) => user.id === promptScope.userId) ?? null;
  const promptActivityRows = useMemo(
    () => (promptActivity ?? []).filter((record) => auditUserIds.has(record.user_id)),
    [auditUserIds, promptActivity],
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
    () => (securityAlerts ?? []).filter((item) => sectionScopeMatch(securityScope, item.created_at, item.user_id)),
    [securityScope, securityAlerts],
  );
  const auditTrailRows = useMemo(
    () => (auditTrail ?? []).filter((item) => sectionScopeMatch(trailScope, item.created_at, item.actor_id)),
    [trailScope, auditTrail],
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
    const actions = platformActions;
    if (
      !actions?.listAlertRules ||
      !actions.createAlertRule ||
      !actions.updateAlertRule ||
      !actions.deleteAlertRule ||
      !actions.listAlertNotifications
    ) {
      return undefined;
    }
    return {
      listRules: () => actions.listAlertRules!(),
      createRule: (payload: AlertRuleCreateRequest) => actions.createAlertRule!(payload),
      updateRule: (ruleId: string, patch: AlertRuleUpdateRequest) => actions.updateAlertRule!(ruleId, patch),
      deleteRule: (ruleId: string) => actions.deleteAlertRule!(ruleId),
      listNotifications: () => actions.listAlertNotifications!(),
      setNotificationArchived: actions.setAlertNotificationArchived
        ? (notificationId: string, archived: boolean) =>
            actions.setAlertNotificationArchived!(notificationId, archived)
        : undefined,
      getEmailSettings: actions.getEmailSettings ? () => actions.getEmailSettings!() : undefined,
      updateEmailSettings: actions.updateEmailSettings
        ? (patch: EmailSettingsUpdateRequest) => actions.updateEmailSettings!(patch)
        : undefined,
      sendEmailTest: actions.sendEmailTest ? (recipient: string) => actions.sendEmailTest!(recipient) : undefined,
    };
  }, [platformActions]);
  const alertActorOptions = useMemo(
    () => [...data.users]
      .sort((a, b) => a.display_name.localeCompare(b.display_name) || a.email.localeCompare(b.email))
      .map((user) => ({ id: user.id, label: user.display_name || user.email })),
    [data.users],
  );
  const selectedUsageUserParam = usageScope.userId === "all" ? undefined : usageScope.userId;
  // The usage picker covers the same population: owner, admin, and user
  // activity are all tracked here.
  const usageUsers = auditUsers;
  const auditUserOptions = useMemo(
    () => auditUsers.map((user) => ({ id: user.id, label: user.display_name || user.email })),
    [auditUsers],
  );
  const usageUserOptions = useMemo(
    () => usageUsers.map((user) => ({ id: user.id, label: user.display_name || user.email })),
    [usageUsers],
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
  const usageRecordsInScope = useMemo(
    () =>
      usageRecords.filter((record) =>
        timestampInDateRange(record.created_at, usageScope.fromDate, usageScope.throughDate),
      ),
    [usageRecords, usageScope],
  );
  const promptActivityExportLabel = promptScopeUser
    ? `${promptScopeUser.display_name} prompt activity`
    : "all user prompt activity";
  const promptActivityFilename = `aperture-prompt-activity-${
    promptScopeUser ? csvFilenamePart(promptScopeUser.display_name || promptScopeUser.id) : "all-users"
  }`;
  const modelActivityRows = useMemo(() => buildPromptModelActivityRows(analyticsPromptActivityRows), [analyticsPromptActivityRows]);
  const promptUsageTrendRows = useMemo(() => buildPromptUsageTrendRows(analyticsPromptActivityRows), [analyticsPromptActivityRows]);
  const promptUserRows = useMemo(() => buildPromptUserRows(analyticsPromptActivityRows), [analyticsPromptActivityRows]);
  const modelActivityLinePoints = useMemo(
    () => promptUsageTrendPoints(promptUsageTrendRows),
    [promptUsageTrendRows],
  );
  const unacknowledgedSecurityAlerts = auditSecurityAlerts.filter((alert) => !alert.acknowledged);

  useEffect(() => {
    if (!openProvidersRequestKey) return;
    setActiveSection("providers");
    setShowDocumentation(false);
  }, [openProvidersRequestKey]);

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

  const listChatFeedback = platformActions?.listChatFeedback;
  useEffect(() => {
    if (!listChatFeedback) return;
    let active = true;
    Promise.resolve(listChatFeedback())
      .then((records) => {
        if (active && records) setServerFeedback(records);
      })
      .catch(() => {
        // Server sentiment is additive; the browser-local view still renders.
      });
    return () => {
      active = false;
    };
  }, [listChatFeedback, auditTrailRefreshToken, feedbackRefreshTick]);

  const listIssueReports = platformActions?.listIssueReports;
  useEffect(() => {
    if (!listIssueReports) return;
    let active = true;
    Promise.resolve(listIssueReports())
      .then((records) => {
        if (active && records) setIssueReports(records);
      })
      .catch(() => {
        // Issue reporting is additive to analytics; other panels stay usable.
      });
    return () => {
      active = false;
    };
  }, [listIssueReports, auditTrailRefreshToken]);

  const listAuditEvents = platformActions?.listAuditEvents;
  useEffect(() => {
    if (!listAuditEvents) return;
    let active = true;
    Promise.resolve(listAuditEvents())
      .then((events) => {
        if (!active || !events) return;
        setAuditTrail(events);
        setAuditTrailError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setAuditTrailError(formatActionError(error));
      });
    return () => {
      active = false;
    };
  }, [listAuditEvents, auditTrailRefreshToken]);

  const listPromptActivity = platformActions?.listPromptActivity;
  const listThreadPromptActivity = platformActions?.listThreadPromptActivity;
  useEffect(() => {
    if (!listPromptActivity) return;
    let active = true;
    // Loads every user's prompts once; each section narrows client-side so
    // one panel's user picker never changes another panel's data.
    Promise.resolve(listPromptActivity(undefined))
      .then((records) => {
        if (!active || !records) return;
        setPromptActivity(records);
        setPromptActivityError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setPromptActivityError(formatActionError(error));
      });
    return () => {
      active = false;
    };
  }, [listPromptActivity, auditTrailRefreshToken]);

  const getRetentionPolicy = platformActions?.getRetentionPolicy;
  const listRetentionThreads = platformActions?.listRetentionThreads;
  useEffect(() => {
    if (!getRetentionPolicy && !listRetentionThreads) return;
    let active = true;
    Promise.all([
      getRetentionPolicy ? getRetentionPolicy() : Promise.resolve(undefined),
      listRetentionThreads ? listRetentionThreads() : Promise.resolve(undefined),
    ])
      .then(([policy, tagged]) => {
        if (!active) return;
        if (policy) setRetentionPolicy(policy);
        if (tagged) setRetentionTagged(tagged);
        setRetentionError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setRetentionError(formatActionError(error));
      });
    return () => {
      active = false;
    };
  }, [getRetentionPolicy, listRetentionThreads, retentionRefreshToken]);

  async function saveRetentionPolicy(patch: TenantRetentionPolicyUpdateRequest) {
    const updateRetentionPolicy = platformActions?.updateRetentionPolicy;
    if (!updateRetentionPolicy) {
      setActionStatus({
        tone: "warning",
        message: "Retention policy was not saved; the retention API is not connected.",
      });
      return;
    }
    const previous = retentionPolicy;
    setRetentionPolicy((current) => (current ? { ...current, ...patch } : current));
    setPendingAction("retention-policy");
    try {
      const saved = await updateRetentionPolicy(patch);
      if (saved) setRetentionPolicy(saved);
      setActionStatus({ tone: "success", message: "Retention policy saved." });
      setRetentionError(null);
    } catch (error) {
      setRetentionPolicy(previous);
      setActionStatus({
        tone: "warning",
        message: `Retention policy was not saved. ${formatActionError(error)}`,
      });
    } finally {
      setPendingAction((current) => (current === "retention-policy" ? null : current));
    }
  }

  async function runRetentionBatchAction(
    action: "delete" | "archive",
    threadIds: string[],
  ): Promise<boolean> {
    const runRetentionBatch = platformActions?.runRetentionBatch;
    if (!runRetentionBatch) {
      setActionStatus({
        tone: "warning",
        message: "Nothing was changed; the retention API is not connected.",
      });
      return false;
    }
    setPendingAction("retention-batch");
    try {
      const result = await runRetentionBatch({ action, thread_ids: threadIds });
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
        tone: "warning",
        message: `The batch ${action} failed. ${formatActionError(error)}`,
      });
      return false;
    } finally {
      setPendingAction((current) => (current === "retention-batch" ? null : current));
    }
  }

  const listSecurityAlerts = platformActions?.listSecurityAlerts;
  useEffect(() => {
    if (!listSecurityAlerts) return;
    let active = true;
    Promise.resolve(listSecurityAlerts(undefined))
      .then((alerts) => {
        if (!active || !alerts) return;
        setSecurityAlerts(alerts);
        setSecurityAlertsError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setSecurityAlertsError(formatActionError(error));
      });
    return () => {
      active = false;
    };
  }, [listSecurityAlerts, auditTrailRefreshToken]);

  const getUsageSummaryAction = platformActions?.getUsageSummary;
  useEffect(() => {
    if (!getUsageSummaryAction) return;
    let active = true;
    Promise.resolve(
      getUsageSummaryAction({
        targetUserId: selectedUsageUserParam,
        fromDate: usageScope.fromDate || undefined,
        throughDate: usageScope.throughDate || undefined,
      }),
    )
      .then((summary) => {
        if (!active || !summary) return;
        setUsageSummary(summary);
        setUsageError(null);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setUsageError(formatActionError(error));
      });
    return () => {
      active = false;
    };
  }, [getUsageSummaryAction, usageScope, selectedUsageUserParam, auditTrailRefreshToken]);

  const listUsageRecordsAction = platformActions?.listUsageRecords;
  useEffect(() => {
    if (!listUsageRecordsAction) return;
    let active = true;
    Promise.resolve(listUsageRecordsAction(selectedUsageUserParam))
      .then((records) => {
        if (!active || !records) return;
        setUsageRecords(records);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setUsageError(formatActionError(error));
      });
    return () => {
      active = false;
    };
  }, [listUsageRecordsAction, selectedUsageUserParam, auditTrailRefreshToken]);

  const getPlatformSettingsAction = platformActions?.getPlatformSettings;
  useEffect(() => {
    if (!getPlatformSettingsAction) return;
    let active = true;
    Promise.resolve(getPlatformSettingsAction())
      .then((settings) => {
        if (!active || !settings) return;
        setTenantPolicies({
          downstreamApiEnabled: settings.downstream_api_enabled,
          usersCanCreateModels: settings.users_can_create_models,
          requireSsoForAdmins: settings.require_sso_for_admins,
          tenantAdminsCanManageSso: settings.tenant_admins_can_manage_sso,
          tenantAdminsCanCreateAdmins: Boolean(settings.tenant_admins_can_create_admins),
          defaultUserGroupEnabled: settings.default_user_group_enabled,
          memoryEnabled: Boolean(settings.memory_enabled),
        });
      })
      .catch(() => {
        // Server settings stay at their defaults when the API is unreachable.
      });
    return () => {
      active = false;
    };
  }, [getPlatformSettingsAction]);

  const getElasticStatusAction = platformActions?.getElasticStatus;
  useEffect(() => {
    if (!getElasticStatusAction) return;
    let active = true;
    Promise.resolve(getElasticStatusAction())
      .then((status) => {
        if (!active || !status) return;
        setElasticStatus(status);
      })
      .catch(() => {
        // Without a status response the panel stays in its disconnected default.
      });
    return () => {
      active = false;
    };
  }, [getElasticStatusAction]);
  const modelSearchTerm = modelSearch.trim().toLowerCase();
  const enabledModelCount = useMemo(
    () => data.models.filter((model) => model.platform_enabled).length,
    [data.models],
  );
  const modelRouteTerm = modelRouteFilter.trim().toLowerCase();
  // Status + search + route narrowing shared by the column facets, so each
  // facet's option counts reflect the other active filters (standard faceted
  // filtering: a facet never narrows its own option list).
  const facetBaseModels = useMemo(() => {
    const statusModels =
      modelStatusFilter === "all"
        ? data.models
        : data.models.filter((model) => model.platform_enabled === (modelStatusFilter === "enabled"));
    const matchingModels = modelSearchTerm
      ? statusModels.filter((model) =>
          [
            model.name,
            model.upstream_model_id ?? "",
            model.provider_name,
            model.notes ?? "",
            model.visibility ?? "",
          ]
            .join(" ")
            .toLowerCase()
            .includes(modelSearchTerm),
        )
      : statusModels;
    return modelRouteTerm
      ? matchingModels.filter((model) =>
          (model.upstream_model_id ?? model.name).toLowerCase().includes(modelRouteTerm),
        )
      : matchingModels;
  }, [data.models, modelSearchTerm, modelStatusFilter, modelRouteTerm]);
  const modelProviderOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const model of facetBaseModels) {
      if (modelLabFilter.length > 0 && !modelLabFilter.includes(modelLabLabel(model))) continue;
      counts.set(model.provider_name, (counts.get(model.provider_name) ?? 0) + 1);
    }
    for (const value of modelProviderFilter) {
      if (!counts.has(value)) counts.set(value, 0);
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }, [facetBaseModels, modelLabFilter, modelProviderFilter]);
  const modelLabOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const model of facetBaseModels) {
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
  }, [facetBaseModels, modelProviderFilter, modelLabFilter]);
  const visibleModels = useMemo(() => {
    const facetedModels = facetBaseModels.filter(
      (model) =>
        (modelProviderFilter.length === 0 || modelProviderFilter.includes(model.provider_name)) &&
        (modelLabFilter.length === 0 || modelLabFilter.includes(modelLabLabel(model))),
    );
    return [...facetedModels].sort(compareModelsByCatalogName);
  }, [facetBaseModels, modelProviderFilter, modelLabFilter]);
  // The dashboard reads the full data set; the per-section scopes below it
  // never narrow these headline numbers.
  const auditSummary = platformAuditSummary(data, securityAlerts ?? [], auditTrail ?? []);
  const recentAuditRows = platformAuditRows(data);

  // Close the open column-filter popover on outside click / Escape.
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

  async function toggleModel(modelId: string, platform_enabled: boolean) {
    const revertOptimistic = beginOptimisticChange();
    const model = data.models.find((item) => item.id === modelId);
    const actionKey = `model:${modelId}:toggle`;
    const patch = { platform_enabled };

    setPendingAction(actionKey);
    onDataChange((current) =>
      updateModels(
        current,
        current.models.map((item) =>
          item.id === modelId
            ? {
                ...item,
                ...patch,
                group_ids:
                  platform_enabled && tenantPolicies.defaultUserGroupEnabled
                    ? withDefaultGroupGrant(current, item.group_ids)
                    : item.group_ids,
              }
            : item,
        ),
      ),
    );

    try {
      const savedModel = await platformActions?.updateModel?.(modelId, patch);
      if (savedModel) {
        onDataChange((current) => updateModels(current, current.models.map((item) => (item.id === modelId ? savedModel : item))));
      }
      setActionStatus({
        tone: platformActions?.updateModel ? "success" : "info",
        message: platformActions?.updateModel
          ? `${model?.name ?? "Model"} availability saved through the platform API.`
          : `${model?.name ?? "Model"} availability saved locally; updateModel helper is not connected yet.`,
      });
    } catch (error) {
      revertOptimistic();
      setActionStatus({
        tone: "warning",
        message: `${model?.name ?? "Model"} availability was not changed. ${formatActionError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function addProvider() {
    const name = providerDraft.name.trim();
    if (!name) return;
    const secret = providerDraft.secret_value.trim();
    const createProvider = platformActions?.createProvider;
    const createProviderKey = platformActions?.createProviderKey;
    if (!createProvider || (secret && !createProviderKey)) {
      setActionStatus({
        tone: "warning",
        message: "Provider was not added because the provider or key API is not connected. Your form is still available to retry.",
      });
      return;
    }
    const kind = providerDraft.kind.trim() || "openai-compatible";
    const nextProvider: Provider = {
      id: `provider-${Date.now()}`,
      name,
      kind,
      region: providerDraft.region.trim() || "Global",
      connected: false,
      model_count: 0,
      enabled_model_count: 0,
      last_sync: "Not synced",
      base_url: providerDraft.base_url.trim() || undefined,
      auth_type: providerDraft.auth_type.trim() || defaultAuthTypeForKind(kind),
      auth_metadata: providerAuthMetadata(providerDraft),
      status_message: "Add a key and validate the connection before routing live model calls.",
    };
    let createdProvider: Provider | undefined;

    setPendingAction("provider:create");
    try {
      const savedProvider = await createProvider(nextProvider);
      if (!savedProvider) throw new Error("The provider API did not return the saved provider. Refresh before retrying.");
      createdProvider = mergeProviderRuntimeStatus(savedProvider, nextProvider);
      const provider = createdProvider;
      let savedKey: ProviderKey | undefined;
      if (secret) {
        const keyPayload: PlatformProviderKeyCreateRequest = {
          provider_id: provider.id,
          name: providerDraft.key_name.trim() || `${provider.name} Primary`,
          environment: providerDraft.key_environment.trim() || "Production",
          expires: providerDraft.key_expires.trim() || "Not set",
          secret_value: secret,
        };
        const result = await createProviderKey!(keyPayload);
        if (!result) throw new Error("The key API did not return the saved key. Refresh before retrying.");
        savedKey = result;
      }
      const providerWithKeyState = {
        ...provider,
        connected: false,
        last_sync: savedKey ? "Runtime validation pending" : "Not synced",
        status_message: savedKey
          ? "Key saved; runtime validation must pass before chat can use this provider."
          : "Provider saved; add a key before routing live model calls.",
      };
      let syncResult: ProviderModelSyncResult | void = undefined;
      let syncError: unknown = undefined;
      if (savedKey && platformActions?.syncProviderModels) {
        try {
          syncResult = await platformActions.syncProviderModels(provider.id);
        } catch (error) {
          syncError = error;
        }
      }
      const providerForState = syncResult?.provider ?? {
        ...providerWithKeyState,
        last_sync: syncError ? "Runtime test failed" : providerWithKeyState.last_sync,
        status_message: syncError ? formatActionError(syncError) : providerWithKeyState.status_message,
      };
      onDataChange((current) => {
        const next = {
          ...current,
          providers: [...current.providers.filter((item) => item.id !== provider.id), providerForState],
          providerKeys: savedKey ? upsertProviderKey(current.providerKeys, savedKey) : current.providerKeys,
        };
        return syncResult ? applyProviderModelSync(next, syncResult) : next;
      });
      setActionStatus({
        tone: syncError ? "warning" : "success",
        message: syncError
          ? `${provider.name} provider and key were saved, but model sync failed: ${formatActionError(syncError)}`
          : syncResult
            ? syncSummary(syncResult)
            : savedKey
              ? `${provider.name} provider and masked key metadata saved through the platform API. Validate the connection before chatting.`
              : `${provider.name} provider saved through the platform API; add a key before model calls can route live.`,
      });
    } catch (error) {
      if (createdProvider) {
        // Registration and key storage are separate requests. Keep the real
        // provider so retrying the key cannot create a duplicate provider.
        const provider = {
          ...createdProvider,
          connected: false,
          last_sync: "Key setup incomplete",
          status_message: "Provider saved; key setup needs attention.",
        };
        onDataChange((current) => ({
          ...current,
          providers: [...current.providers.filter((item) => item.id !== provider.id), provider],
        }));
        setExpandedProviderKeyIds((current) => ({ ...current, [provider.id]: true }));
        setKeyDraft({
          provider_id: provider.id,
          name: providerDraft.key_name.trim() || `${provider.name} Primary`,
          environment: providerDraft.key_environment.trim() || "Production",
          expires: providerDraft.key_expires.trim() || "Not set",
          secret_value: secret,
        });
        setShowKeyForm(true);
        setActionStatus({
          tone: "warning",
          message: `${provider.name} was created, but its key setup did not finish. Retry in API Keys below. ${formatActionError(error)}`,
        });
      } else {
        setActionStatus({
          tone: "warning",
          message: `${name} was not added. Your form is still available to retry. ${formatActionError(error)}`,
        });
      }
    } finally {
      setPendingAction(null);
      if (createdProvider) {
        setProviderDraft({
          name: "",
          kind: "openai-compatible",
          region: "Global",
          base_url: "",
          auth_type: "bearer",
          header_name: "Authorization",
          api_version: "",
          deployment_id: "",
          catalog_scope: defaultCatalogScopeForKind("openai-compatible"),
          secret_value: "",
          key_name: "",
          key_environment: "Production",
          key_expires: "Not set",
        });
        setShowProviderForm(false);
      }
    }
  }

  async function addProviderKey() {
    const provider = data.providers.find((item) => item.id === keyDraft.provider_id) ?? data.providers[0];
    const secret = keyDraft.secret_value.trim();
    if (!provider || !secret) return;
    const keyPayload: PlatformProviderKeyCreateRequest = {
      provider_id: provider.id,
      name: keyDraft.name.trim() || `${provider.name} Primary`,
      environment: keyDraft.environment.trim() || "Production",
      expires: keyDraft.expires.trim() || "Not set",
      secret_value: secret,
    };

    setPendingAction("key:create");
    try {
      if (!platformActions?.createProviderKey) throw new Error("The provider key API is not connected.");
      const savedKey = await platformActions.createProviderKey(keyPayload);
      if (!savedKey) throw new Error("The key API did not return the saved key. Refresh before retrying.");
      let syncResult: ProviderModelSyncResult | void = undefined;
      let syncError: unknown = undefined;
      if (platformActions?.syncProviderModels) {
        try {
          syncResult = await platformActions.syncProviderModels(provider.id);
        } catch (error) {
          syncError = error;
        }
      }
      onDataChange((current) => {
        const providerPatch = syncResult?.provider;
        const next = {
          ...current,
          providerKeys: upsertProviderKey(current.providerKeys, savedKey),
          providers: current.providers.map((item) =>
            item.id === provider.id
              ? providerPatch ?? {
                  ...item,
                  connected: false,
                  last_sync: syncError ? "Runtime test failed" : "Runtime validation pending",
                  status_message: syncError
                    ? formatActionError(syncError)
                    : "Key saved; runtime validation must pass before chat can use this provider.",
                }
              : item,
          ),
        };
        return syncResult ? applyProviderModelSync(next, syncResult) : next;
      });
      setActionStatus({
        tone: syncError ? "warning" : "success",
        message: syncError
          ? `${provider.name} key was saved, but model sync failed: ${formatActionError(syncError)}`
          : syncResult
            ? syncSummary(syncResult)
            : `${provider.name} key saved through the platform vault API.`,
      });
      setShowKeyForm(false);
      setKeyDraft({ provider_id: provider.id, name: "", environment: "Production", expires: "Not set", secret_value: "" });
    } catch (error) {
      setActionStatus({
        tone: "warning",
        message: `${provider.name} key was not saved. Backend create failed: ${formatActionError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function syncProvider(provider: Provider) {
    const actionKey = `provider:${provider.id}:sync`;
    const localPatch: Partial<Provider> = {
      status_message: "Refreshing provider model catalog...",
    };

    setPendingAction(actionKey);
    onDataChange((current) => updateProvider(current, provider.id, localPatch));

    try {
      if (!platformActions?.syncProviderModels) {
        throw new Error("Model discovery is unavailable. Reconnect to the platform and try again.");
      }
      const syncResult = await platformActions.syncProviderModels(provider.id);
      if (!syncResult) {
        throw new Error("The platform returned no model catalog. Try the sync again.");
      }
      // Only a validated server result can change connection or catalog state.
      onDataChange((current) => applyProviderModelSync(current, syncResult));
      setActionStatus({
        tone: "success",
        message: syncSummary(syncResult),
      });
    } catch (error) {
      onDataChange((current) =>
        updateProvider(current, provider.id, {
          status_message: `Model sync failed: ${formatActionError(error)}`,
        }),
      );
      setActionStatus({
        tone: "warning",
        message: `${provider.name} model sync failed: ${formatActionError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  function toggleProviderEditor(provider: Provider) {
    const expanded = !expandedProviderIds[provider.id];
    setExpandedProviderIds((current) => ({ ...current, [provider.id]: expanded }));
    if (expanded) {
      setProviderEditDrafts((current) => ({
        ...current,
        [provider.id]: current[provider.id] ?? providerConnectionDraftFromProvider(provider),
      }));
    }
  }

  function updateProviderEditDraft(provider: Provider, patch: Partial<ProviderConnectionDraftState>) {
    setProviderEditDrafts((current) => ({
      ...current,
      [provider.id]: {
        ...providerConnectionDraftFromProvider(provider),
        ...current[provider.id],
        ...patch,
      },
    }));
  }

  function updateProviderEditKind(provider: Provider, kind: string) {
    setProviderEditDrafts((current) => {
      const draft = {
        ...providerConnectionDraftFromProvider(provider),
        ...current[provider.id],
      };
      const baseWasDefault = draft.base_url.trim() === defaultBaseUrlForKind(draft.kind, "");
      return {
        ...current,
        [provider.id]: {
          ...draft,
          kind,
          auth_type: defaultAuthTypeForKind(kind),
          header_name: defaultHeaderForKind(kind),
          base_url: !draft.base_url.trim() || baseWasDefault ? defaultBaseUrlForKind(kind, "") : draft.base_url,
          catalog_scope: defaultCatalogScopeForKind(kind),
        },
      };
    });
  }

  async function saveProviderConnection(provider: Provider) {
    const revertOptimistic = beginOptimisticChange();
    const draft = providerEditDrafts[provider.id] ?? providerConnectionDraftFromProvider(provider);
    const kind = draft.kind.trim() || "openai-compatible";
    const name = draft.name.trim() || provider.name;
    const patch: Partial<Provider> = {
      name,
      kind,
      region: draft.region.trim() || "Global",
      base_url: draft.base_url.trim(),
      auth_type: draft.auth_type.trim() || defaultAuthTypeForKind(kind),
      auth_metadata: providerConnectionAuthMetadata({ ...draft, kind }),
      status_message: isRuntimeSupportedProviderKind(kind)
        ? "Connection settings saved; run Sync Models to refresh the model catalog."
        : "Connection metadata saved; runtime gateway adapter still needs implementation.",
    };
    const actionKey = `provider:${provider.id}:edit`;

    setPendingAction(actionKey);
    onDataChange((current) => updateProvider(current, provider.id, patch));
    try {
      const savedProvider = await platformActions?.updateProvider?.(provider.id, patch);
      if (savedProvider) {
        onDataChange((current) => updateProvider(current, provider.id, savedProvider));
      }
      setExpandedProviderIds((current) => ({ ...current, [provider.id]: false }));
      setActionStatus({
        tone: platformActions?.updateProvider ? "success" : "info",
        message: platformActions?.updateProvider
          ? `${name} connection saved through the platform API.`
          : `${name} connection saved locally; updateProvider helper is not connected yet.`,
      });
    } catch (error) {
      revertOptimistic();
      setActionStatus({
        tone: "warning",
        message: `${name} connection was not changed. ${formatActionError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  function toggleProviderKeys(providerId: string) {
    setExpandedProviderKeyIds((current) => {
      const open = !current[providerId];
      if (!open) setShowKeyForm(false);
      return { ...current, [providerId]: open };
    });
  }

  function beginNewProviderKey(provider: Provider) {
    const alreadyOpenHere = showKeyForm && keyDraft.provider_id === provider.id;
    if (alreadyOpenHere) {
      setShowKeyForm(false);
      return;
    }
    setKeyDraft({
      provider_id: provider.id,
      name: "",
      environment: "Production",
      expires: "Not set",
      secret_value: "",
    });
    setShowKeyForm(true);
  }

  function beginReplacementProviderKey(key: ProviderKey) {
    setKeyDraft({
      provider_id: key.provider_id,
      name: `${key.provider_name} Replacement`,
      environment: key.environment || "Production",
      expires: "Not set",
      secret_value: "",
    });
    setShowKeyForm(true);
    setExpandedProviderKeyIds((current) => ({ ...current, [key.provider_id]: true }));
    setRevealedKeyDialog((current) => (current?.key.id === key.id ? null : current));
    setCopyStatus("idle");
    setActionStatus({
      tone: "info",
      message: `Create the replacement key in ${key.provider_name}, paste it here, and ${data.currentTenant.chat_brand_name?.trim() || DEFAULT_BRANDING.chat_brand_name} will sync and test it before enabling chat.`,
    });
  }

  async function revealProviderKey(key: ProviderKey) {
    const actionKey = `key:${key.id}:reveal`;
    setPendingAction(actionKey);
    try {
      const secret = await platformActions?.revealProviderKey?.(key.id);
      if (secret) {
        onDataChange((current) => updateProviderKey(current, key.id, secret));
        setRevealedKeyDialog({ key: { ...key, ...secret }, secretValue: secret.secret_value });
        setCopyStatus("idle");
      }
      setActionStatus({
        tone: platformActions?.revealProviderKey ? "success" : "info",
        message: platformActions?.revealProviderKey
          ? `${key.provider_name} key revealed through the platform vault API.`
          : `${key.provider_name} key reveal is unavailable because revealProviderKey helper is not connected yet.`,
      });
    } catch (error) {
      setActionStatus({
        tone: "warning",
        message: `${key.provider_name} key was not revealed. Backend reveal failed: ${formatActionError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function deleteProviderKey(key: ProviderKey) {
    const actionKey = `key:${key.id}:delete`;
    setPendingAction(actionKey);
    try {
      await platformActions?.deleteProviderKey?.(key.id);
      onDataChange((current) => removeProviderKey(current, key.id));
      setRevealedKeyDialog((current) => (current?.key.id === key.id ? null : current));
      setCopyStatus("idle");
      setActionStatus({
        tone: platformActions?.deleteProviderKey ? "success" : "info",
        message: platformActions?.deleteProviderKey
          ? `${key.provider_name} key deleted from the platform vault.`
          : `${key.provider_name} key removed locally; deleteProviderKey helper is not connected yet.`,
      });
    } catch (error) {
      setActionStatus({
        tone: "warning",
        message: `${key.provider_name} key was not deleted. Backend delete failed: ${formatActionError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function copyRevealedKey() {
    if (!revealedKeyDialog) return;

    try {
      await navigator.clipboard.writeText(revealedKeyDialog.secretValue);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  async function updateTenantPolicy(key: keyof TenantPolicyState, next: boolean) {
    const previous = tenantPolicies[key];
    setTenantPolicies((current) => ({ ...current, [key]: next }));
    const updatePlatformSettingsAction = platformActions?.updatePlatformSettings;
    if (!updatePlatformSettingsAction) {
      setActionStatus({
        tone: "warning",
        message: "Policy changed for this session only; the platform settings API is not connected.",
      });
      return;
    }
    setPendingAction(`policy:${key}`);
    try {
      const saved = await updatePlatformSettingsAction({ [POLICY_FIELD_BY_KEY[key]]: next });
      if (saved) {
        setTenantPolicies({
          downstreamApiEnabled: saved.downstream_api_enabled,
          usersCanCreateModels: saved.users_can_create_models,
          requireSsoForAdmins: saved.require_sso_for_admins,
          tenantAdminsCanManageSso: saved.tenant_admins_can_manage_sso,
          tenantAdminsCanCreateAdmins: Boolean(saved.tenant_admins_can_create_admins),
          defaultUserGroupEnabled: saved.default_user_group_enabled,
          memoryEnabled: Boolean(saved.memory_enabled),
        });
        onDataChange((current) => ({ ...current, platformSettings: saved }));
      }
      setActionStatus({
        tone: "success",
        message:
          key === "downstreamApiEnabled"
            ? next
              ? "Downstream API access is enabled for owners and admins. Standard users still require an administrator grant."
              : "Downstream API access is disabled platform-wide. Existing keys are preserved but cannot authenticate."
            : key === "requireSsoForAdmins"
            ? next
              ? "Admin accounts must now sign in through SSO; local admin sign-in is rejected."
              : "Admin accounts may sign in locally again."
            : key === "tenantAdminsCanManageSso"
              ? next
                ? "Tenant admins can manage SSO configurations."
                : "SSO configuration changes are now restricted to platform owners."
              : key === "tenantAdminsCanCreateAdmins"
                ? next
                  ? "Tenant admins can create and manage other tenant admins under owner policy."
                  : "Tenant admin creation is now restricted to platform owners."
                : key === "defaultUserGroupEnabled"
                  ? next
                    ? "Enabled models will include the protected default group by default."
                    : "Enabled models will no longer auto-include the default group."
                  : key === "usersCanCreateModels"
                    ? next
                      ? "Users can build their own agents once an admin grants Can build agents to their group."
                      : "Agent creation is now restricted to tenant admins and platform owners."
                  : key === "memoryEnabled"
                    ? next
                      ? "Tenant admins can now enable personalization memory for their organization."
                      : "Personalization memory is off platform-wide; tenant memory policies are inert."
                : "Policy saved.",
      });
    } catch (error) {
      setTenantPolicies((current) => ({ ...current, [key]: previous }));
      setActionStatus({
        tone: "warning",
        message: `Policy was not saved: ${formatActionError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function createOwnerManagedUser() {
    const revertOptimistic = beginOptimisticChange();
    const displayName = ownerUserDraft.display_name.trim();
    const email = ownerUserDraft.email.trim();
    if (!displayName || !email) return;
    const isPlatformOwner = ownerUserDraft.role === "PLATFORM_OWNER";

    const localUser: PlatformUser = {
      id: `user-${email.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || Date.now()}`,
      tenant_id: isPlatformOwner ? null : data.currentTenant.id,
      email,
      display_name: displayName,
      role: ownerUserDraft.role,
      group_ids: [],
      active: true,
      last_active: "Invited now",
      auth_method: "sso",
    };
    const payload: AdminUserCreateRequest = {
      id: localUser.id,
      tenant_id: isPlatformOwner ? null : data.currentTenant.id,
      display_name: displayName,
      email,
      role: ownerUserDraft.role,
      active: true,
      group_ids: [],
    };

    setPendingAction("owner-user:create");
    onDataChange((current) => upsertPlatformUser(current, localUser));
    try {
      const savedUser = await platformActions?.createUser?.(payload);
      if (savedUser) {
        onDataChange((current) => upsertPlatformUser(current, savedUser));
      }
      setOwnerUserDraft({ display_name: "", email: "", role: "USER" });
      setActionStatus({
        tone: platformActions?.createUser ? "success" : "info",
        message: platformActions?.createUser
          ? `${displayName} account created through the admin API.`
          : `${displayName} account added locally; createUser helper is not connected yet.`,
      });
    } catch (error) {
      revertOptimistic();
      setActionStatus({
        tone: "warning",
        message: `${displayName} account was not created. ${formatActionError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function updateOwnerManagedUserRole(user: PlatformUser, role: OwnerUserDraftState["role"]) {
    const revertOptimistic = beginOptimisticChange();
    const patch: AdminUserUpdateRequest = { role };
    setPendingAction(`owner-user:${user.id}:role`);
    onDataChange((current) => upsertPlatformUser(current, { ...user, role }));
    try {
      const savedUser = await platformActions?.updateUser?.(user.id, patch);
      if (savedUser) {
        onDataChange((current) => upsertPlatformUser(current, savedUser));
      }
      setActionStatus({
        tone: platformActions?.updateUser ? "success" : "info",
        message: platformActions?.updateUser
          ? `${user.display_name} role saved through the admin API.`
          : `${user.display_name} role saved locally; updateUser helper is not connected yet.`,
      });
    } catch (error) {
      revertOptimistic();
      setActionStatus({
        tone: "warning",
        message: `${user.display_name} role was not changed. ${formatActionError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  /** Two-step owner deletion: acknowledge the exact cascade, then retype the
   * provider name. The typed name is what the API verifies, so a stray click
   * or a replayed request cannot destroy a provider. */
  function openProviderDeleteDialog(provider: Provider) {
    if (!platformActions?.deleteProvider) {
      setActionStatus({
        tone: "warning",
        message: "Provider delete is not connected to the platform API in this build.",
      });
      return;
    }
    // This used to chain window.confirm() into window.prompt(). Browsers
    // suppress a second dialog from the same gesture (and Chrome offers
    // "prevent additional dialogs" after the first), so the name prompt often
    // never appeared and the handler returned silently -- the delete looked
    // broken. An in-app dialog cannot be suppressed and can report why a
    // refused delete was refused.
    setProviderDeleteDialog({
      provider,
      modelCount: data.models.filter((model) => model.provider_id === provider.id).length,
      keyCount: data.providerKeys.filter((key) => key.provider_id === provider.id).length,
      typedName: "",
      error: null,
      pending: false,
    });
  }

  async function confirmProviderDelete() {
    const dialog = providerDeleteDialog;
    if (!dialog || !platformActions?.deleteProvider) return;
    const provider = dialog.provider;
    if (dialog.typedName.trim() !== provider.name) {
      setProviderDeleteDialog((current) =>
        current ? { ...current, error: `Type ${provider.name} exactly to confirm.` } : current,
      );
      return;
    }

    setProviderDeleteDialog((current) => (current ? { ...current, pending: true, error: null } : current));
    setPendingAction(`provider:${provider.id}:delete`);
    try {
      const result = await platformActions.deleteProvider(provider.id, provider.name);
      // Only prune local state once the API confirms; a refused delete (for
      // example a provider still used by an automation) must leave the console
      // showing what really exists.
      onDataChange((current) => ({
        ...current,
        providers: current.providers.filter((item) => item.id !== provider.id),
        models: current.models.filter((model) => model.provider_id !== provider.id),
        providerKeys: current.providerKeys.filter((key) => key.provider_id !== provider.id),
      }));
      const counts =
        result && typeof result === "object"
          ? ` (${result.models_deleted} model(s), ${result.keys_deleted} key(s))`
          : "";
      setActionStatus({
        tone: "success",
        message: `${provider.name} was permanently deleted${counts}.`,
      });
      setProviderDeleteDialog(null);
    } catch (error) {
      // Keep the dialog open and show the server's reason there. A provider
      // still referenced by an automation is refused by name, and that detail
      // is only useful next to the control the owner just used.
      const detail = formatActionError(error);
      setProviderDeleteDialog((current) =>
        current ? { ...current, pending: false, error: detail } : current,
      );
      setActionStatus({
        tone: "warning",
        message: `${provider.name} was not deleted. ${detail}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function removeOwnerManagedUser(user: PlatformUser) {
    const revertOptimistic = beginOptimisticChange();
    if (user.role === "PLATFORM_OWNER") {
      const confirmed = window.confirm(
        `Deactivate ${user.display_name}'s platform owner account? Owner accounts cannot be deleted, so this revokes their access until another owner reactivates them.`,
      );
      if (!confirmed) return;
      setPendingAction(`owner-user:${user.id}:remove`);
      onDataChange((current) => upsertPlatformUser(current, { ...user, active: false, last_active: "Deactivated now" }));
      try {
        await platformActions?.deactivateUser?.(user.id);
        setActionStatus({
          tone: platformActions?.deactivateUser ? "success" : "info",
          message: platformActions?.deactivateUser
            ? `${user.display_name} deactivated through the admin API.`
            : `${user.display_name} deactivated locally; deactivateUser helper is not connected yet.`,
        });
      } catch (error) {
        revertOptimistic();
        setActionStatus({
          tone: "warning",
          message: `${user.display_name} was not deactivated. ${formatActionError(error)}`,
        });
      } finally {
        setPendingAction(null);
      }
      return;
    }
    const confirmed = window.confirm(
      `Permanently delete ${user.display_name}'s account? This removes their access, sessions, and history and cannot be undone.`,
    );
    if (!confirmed) return;
    setPendingAction(`owner-user:${user.id}:remove`);
    try {
      await platformActions?.deleteUser?.(user.id);
      onDataChange((current) => removePlatformUser(current, user.id));
      setActionStatus({
        tone: platformActions?.deleteUser ? "success" : "info",
        message: platformActions?.deleteUser
          ? `${user.display_name} was permanently deleted through the admin API.`
          : `${user.display_name} was removed locally; deleteUser helper is not connected yet.`,
      });
    } catch (error) {
      setActionStatus({
        tone: "warning",
        message: `${user.display_name} was not deleted. Backend delete failed: ${formatActionError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function applyBranding() {
    // A just-picked PNG may still be resizing; wait for it and fold the result
    // in so Apply never silently saves without the image. A failed upload has
    // its warning showing — stop so "saved" does not replace it.
    const pendingUpload = brandingUploadRef.current;
    let draft = brandingDraft;
    if (pendingUpload) {
      const uploadedMark = await pendingUpload;
      if (!uploadedMark) return;
      draft = { ...brandingDraft, logo_url: uploadedMark, icon_url: uploadedMark };
    }

    const brandName = draft.chat_brand_name.trim() || DEFAULT_BRANDING.chat_brand_name;
    const logoUrl = draft.logo_url.trim();
    const iconUrl = draft.icon_url.trim();
    const markUrl = iconUrl || logoUrl;
    const accentColor = draft.primary_color.trim() || DEFAULT_BRANDING.primary_color;
    const gradientStart = draft.gradient_start.trim();
    const gradientEnd = draft.gradient_end.trim();
    const textColor = draft.text_color.trim();

    const invalidColor = [accentColor, gradientStart, gradientEnd, textColor]
      .filter(Boolean)
      .find((color) => !HEX_COLOR_INPUT_RE.test(color));
    if (invalidColor) {
      setBrandingStatus({
        tone: "warning",
        message: `"${invalidColor}" is not a 6-digit hex color like #087d8b. Fix it before applying.`,
      });
      return;
    }
    if (Boolean(gradientStart) !== Boolean(gradientEnd)) {
      setBrandingStatus({
        tone: "warning",
        message: "Set both gradient colors (or clear both) so the sidebar gradient has a start and an end.",
      });
      return;
    }

    const patch = {
      chat_brand_name: brandName,
      logo_url: logoUrl || null,
      icon_url: iconUrl || null,
      logo_mark: markUrl ? "custom" : "aperture",
      primary_color: accentColor,
      custom_domain: draft.custom_domain.trim() || DEFAULT_BRANDING.custom_domain,
      gradient_start: gradientStart || null,
      gradient_end: gradientEnd || null,
      text_color: textColor || null,
    } satisfies TenantBrandingUpdateRequest;
    // Live preview stays instant; the backend save makes it survive reload.
    onDataChange((current) => ({
      ...current,
      currentTenant: { ...current.currentTenant, ...patch },
    }));
    await persistBranding(patch, `${brandName} branding`);
  }

  async function resetBranding() {
    // Discard any in-flight PNG so the next Apply cannot resurrect it.
    brandingUploadRef.current = null;
    setBrandingDraft(DEFAULT_BRANDING);
    const patch = {
      chat_brand_name: DEFAULT_BRANDING.chat_brand_name,
      logo_url: null,
      icon_url: null,
      logo_mark: "aperture",
      primary_color: DEFAULT_BRANDING.primary_color,
      custom_domain: DEFAULT_BRANDING.custom_domain,
      gradient_start: null,
      gradient_end: null,
      text_color: null,
    } satisfies TenantBrandingUpdateRequest;
    onDataChange((current) => ({
      ...current,
      currentTenant: { ...current.currentTenant, ...patch },
    }));
    await persistBranding(patch, "Default Aperture Chat branding");
  }

  async function persistBranding(patch: TenantBrandingUpdateRequest, label: string) {
    const updateTenantBranding = platformActions?.updateTenantBranding;
    if (!updateTenantBranding) {
      setBrandingStatus({
        tone: "info",
        message: `${label} applied to the platform preview (session only; branding API not connected).`,
      });
      return;
    }
    setPendingAction("branding:save");
    try {
      const savedTenant = await updateTenantBranding(data.currentTenant.id, patch);
      if (savedTenant) {
        onDataChange((current) => ({ ...current, currentTenant: savedTenant }));
      }
      setBrandingStatus({
        tone: "success",
        message: `${label} saved through the platform API and will persist across reloads.`,
      });
    } catch (error) {
      setBrandingStatus({
        tone: "warning",
        message: `${label} applied to this session only. Backend save failed: ${formatActionError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  function uploadBrandingImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    if (file.type !== "image/png") {
      setBrandingStatus({ tone: "warning", message: "Upload a PNG image for the platform logo and browser icon." });
      return;
    }
    if (file.size > BRANDING_UPLOAD_MAX_BYTES) {
      setBrandingStatus({
        tone: "warning",
        message: "That PNG is larger than 4 MB. Export a smaller logo and try again.",
      });
      return;
    }

    setBrandingUploadPending(true);
    setBrandingStatus({ tone: "info", message: `Preparing ${file.name}…` });
    const upload = (async (): Promise<string | null> => {
      // Downscale before storing: the mark renders at 24-34px, and the result
      // is persisted inline with tenant state, so keep the data URL small.
      let result: string | null = null;
      if (typeof createImageBitmap === "function") {
        result = await downscalePngToDataUrl(file);
      }
      if (!result) {
        // No bitmap/canvas support here: only accept files whose raw data URL
        // already fits within the server-side branding size cap.
        if (file.size > BRANDING_RAW_FALLBACK_MAX_BYTES) {
          setBrandingStatus({
            tone: "warning",
            message: "This browser cannot resize the PNG. Upload a logo under 250 KB instead.",
          });
          return null;
        }
        result = await readFileAsDataUrl(file);
      }
      if (!result) {
        setBrandingStatus({ tone: "warning", message: "The PNG upload could not be read." });
        return null;
      }
      setBrandingDraft((state) => ({
        ...state,
        logo_url: result,
        icon_url: result,
      }));
      setBrandingStatus({ tone: "info", message: `${file.name} is ready. Apply branding to update the platform shell and favicon.` });
      return result;
    })();
    brandingUploadRef.current = upload;
    void upload.finally(() => {
      // The draft now holds the data URL (or the upload failed); later manual
      // edits to the URL fields must win over this finished upload.
      if (brandingUploadRef.current === upload) {
        brandingUploadRef.current = null;
      }
      setBrandingUploadPending(false);
    });
  }

  async function saveOwnerSsoSettings() {
    const domains = ownerSsoDraft.domains
      .split(",")
      .map((domain) => domain.trim())
      .filter(Boolean);
    const mfaMethods = ownerSsoDraft.mfaMethods
      .split(",")
      .map((method) => method.trim())
      .filter(Boolean);
    const currentConfig = data.ssoConfigs[0];
    const updateSsoConfig = platformActions?.updateSsoConfig;
    const createSsoConfig = platformActions?.createSsoConfig;
    if (currentConfig ? !updateSsoConfig : !createSsoConfig) {
      setActionStatus({
        tone: "warning",
        message: "SSO baseline changed for this session only; the SSO API is not connected.",
      });
      return;
    }
    setPendingAction("owner-sso:save");
    try {
      const secretValue = ownerSsoDraft.clientSecret.trim();
      const ssoPatch: AdminSsoConfigUpdateRequest = {
        provider: providerSlugFromName(ownerSsoDraft.name.trim() || currentConfig?.name || "OIDC"),
        issuer_url: ownerSsoDraft.issuer.trim() || currentConfig?.issuer || "",
        client_id: ownerSsoDraft.clientId.trim() || currentConfig?.client_id || "",
        enabled: true,
        settings: {
          protocol: ownerSsoDraft.protocol,
          enforced: ownerSsoDraft.enforced,
          client_secret_set: secretValue.length > 0 || Boolean(currentConfig?.client_secret_set),
          mfa_enforced: mfaMethods.length > 0,
          mfa_provider: ownerSsoDraft.mfaProvider.trim(),
          mfa_methods: mfaMethods,
          mfa_notes: mfaMethods.length
            ? "MFA is enforced by the SSO identity provider; users are redirected to the configured challenge."
            : "",
          redirect_url: ownerSsoDraft.redirectUrl.trim(),
          acs_url: ownerSsoDraft.redirectUrl.trim(),
          entity_id: ownerSsoDraft.entityId.trim(),
          saml_login_url: ownerSsoDraft.samlLoginUrl.trim(),
          saml_logout_url: ownerSsoDraft.samlLogoutUrl.trim(),
          saml_certificate: ownerSsoDraft.samlCertificate.trim(),
          duo_api_hostname: ownerSsoDraft.duoApiHostname.trim(),
          duo_redirect_uri: ownerSsoDraft.redirectUrl.trim(),
          scim_base_url: ownerSsoDraft.scimBaseUrl.trim(),
          group_claim: ownerSsoDraft.groupClaim.trim() || "groups",
          qr_enrollment_uri: ownerSsoDraft.qrEnrollmentUri.trim(),
          jit_provisioning: ownerSsoDraft.jitProvisioning,
          require_platform_mfa: ownerSsoDraft.requirePlatformMfa,
          status: ownerSsoDraft.enforced ? "enforced" : "ready",
          domains,
          last_tested: "Saved now",
          admin_notes: currentConfig?.admin_notes ?? "Created from the owner Org Settings panel.",
        },
      };
      if (secretValue) {
        ssoPatch.client_secret = secretValue;
      }
      const saved = currentConfig
        ? await updateSsoConfig?.(currentConfig.id, ssoPatch)
        : await createSsoConfig?.({
            provider: ssoPatch.provider ?? "oidc",
            issuer_url: ssoPatch.issuer_url ?? "",
            client_id: ssoPatch.client_id ?? "",
            enabled: true,
            settings: ssoPatch.settings ?? {},
            client_secret: ssoPatch.client_secret ?? null,
          });
      if (saved) {
        onDataChange((current) => ({
          ...current,
          ssoConfigs: currentConfig
            ? current.ssoConfigs.map((config, index) => (index === 0 ? saved : config))
            : [saved, ...current.ssoConfigs],
        }));
      }
      setActionStatus({
        tone: "success",
        message: `${ownerSsoDraft.name.trim() || saved?.name || "SSO"} baseline saved through the admin SSO API.`,
      });
    } catch (error) {
      setActionStatus({
        tone: "warning",
        message: `SSO baseline was not saved: ${formatActionError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function testOwnerSsoConnection() {
    const currentConfig = data.ssoConfigs[0];
    const testSsoConfig = platformActions?.testSsoConfig;
    if (!currentConfig || !testSsoConfig) {
      setActionStatus({
        tone: "warning",
        message: currentConfig
          ? "The SSO test API is not connected in this session."
          : "No backend SSO configuration exists yet. Save the SSO baseline first.",
      });
      return;
    }
    setPendingAction("owner-sso:test");
    setSsoTestResult(null);
    try {
      const result = await testSsoConfig(currentConfig.id);
      if (result) {
        setSsoTestResult(result);
        setActionStatus({
          tone: result.status === "ok" ? "success" : result.status === "incomplete" ? "info" : "warning",
          message: result.message,
        });
      }
    } catch (error) {
      setActionStatus({
        tone: "warning",
        message: `SSO connection test failed: ${formatActionError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  function toggleModelDetails(modelId: string) {
    const model = data.models.find((item) => item.id === modelId);
    setExpandedModelIds((current) => ({ ...current, [modelId]: !current[modelId] }));
    if (model) {
      setModelEditDrafts((current) => ({
        ...current,
        [modelId]: current[modelId] ?? modelEditDraftFromModel(model),
      }));
    }
  }

  function updateModelEditDraft(modelId: string, patch: Partial<ModelEditDraftState>) {
    const model = data.models.find((item) => item.id === modelId);
    setModelEditDrafts((current) => ({
      ...current,
      [modelId]: {
        ...(current[modelId] ?? (model ? modelEditDraftFromModel(model) : emptyModelEditDraft())),
        ...patch,
      },
    }));
  }

  async function saveModelDetails(model: ModelConfig) {
    const revertOptimistic = beginOptimisticChange();
    const draft = modelEditDrafts[model.id] ?? modelEditDraftFromModel(model);
    const name = draft.name.trim();
    if (!name) {
      setActionStatus({ tone: "warning", message: "Model display name is required before saving." });
      return;
    }

    const contextWindow = Number.parseInt(draft.context_window.replace(/[,\s]/g, ""), 10);
    const patch: Partial<ModelConfig> = {
      name,
      upstream_model_id: draft.upstream_model_id.trim() || name,
      notes: draft.notes.trim() || null,
      system_prompt: draft.system_prompt,
      meta_prompt: draft.meta_prompt,
      context_window: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined,
    };
    const actionKey = `model:${model.id}:details`;

    setPendingAction(actionKey);
    onDataChange((current) =>
      updateModels(current, current.models.map((item) => (item.id === model.id ? { ...item, ...patch } : item))),
    );

    try {
      const savedModel = await platformActions?.updateModel?.(model.id, patch);
      const nextModel = savedModel ?? { ...model, ...patch };
      if (savedModel) {
        onDataChange((current) => updateModels(current, current.models.map((item) => (item.id === model.id ? savedModel : item))));
      }
      setModelEditDrafts((current) => ({ ...current, [model.id]: modelEditDraftFromModel(nextModel) }));
      setActionStatus({
        tone: platformActions?.updateModel ? "success" : "info",
        message: platformActions?.updateModel
          ? `${nextModel.name} model details saved through the platform API.`
          : `${nextModel.name} model details saved locally; updateModel helper is not connected yet.`,
      });
    } catch (error) {
      revertOptimistic();
      setActionStatus({
        tone: "warning",
        message: `${name} model details were not saved. ${formatActionError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function setSecurityAlertAcknowledged(alert: SecurityAlert, acknowledged: boolean) {
    const actionKey = `security-alert:${alert.id}`;
    const action = platformActions?.acknowledgeSecurityAlert;
    if (!action) {
      setActionStatus({
        tone: "warning",
        message: "Security alert review is not connected to the platform API in this session.",
      });
      return;
    }
    setPendingAction(actionKey);
    try {
      const saved = await action(alert.id, acknowledged);
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
        message: `Security alert was not updated: ${formatActionError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="console-page">
      <header className="console-header">
        <div>
          <h1>Platform Owner Console</h1>
          <p>Organization-level controls for providers, model availability, secrets, SSO, connectors, and audit.</p>
        </div>
        <div className="console-actions">
          <button
            className="text-icon-button owner-doc-button"
            type="button"
            data-tooltip="Open the owner training videos and setup documentation"
            onClick={() => setShowDocumentation(true)}
          >
            <BookOpen size={17} /> Documentation
          </button>
        </div>
      </header>

      {actionStatus && (
        <div className="secure-notice dismissible-notice" role="status">
          {actionStatus.tone === "warning" ? <ShieldAlert size={18} /> : <ShieldCheck size={18} />}
          <span>{actionStatus.message}</span>
          <button
            className="notice-dismiss-button"
            type="button"
            aria-label="Dismiss notification"
            data-tooltip="Clear this status message from the console"
            onClick={() => setActionStatus(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}

      <Tabs.Root
        value={activeSection}
        className="tabs-root"
        onValueChange={(value) => {
          setActiveSection(value);
          if (value === "audit") setAuditTrailRefreshToken((token) => token + 1);
        }}
      >
        <Tabs.List className="tabs-list management-console-tabs" aria-label="Platform owner sections">
          {[
            ["Org Settings", "org-settings"],
            ["Models", "models"],
            ["Providers", "providers"],
            ["Analytics", "analytics"],
            ["Audit", "audit"],
            ["Alerts", "alerts"],
          ].map(([tab, value]) => (
            <Tabs.Trigger key={value} className="tab-trigger" value={value} data-tooltip={TAB_TOOLTIPS[value]}>
              {tab}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="models" className="tab-content">
          <div className="console-main-col">
            <Panel
              title="Organization Model Availability"
              subtitle="Sync provider catalogs and control which API models can flow down to tenant admins."
              actions={
                <div className="model-list-controls">
                  <div className="status-filter" role="radiogroup" aria-label="Filter models by org status">
                    {MODEL_STATUS_FILTER_OPTIONS.map((option) => {
                      const count =
                        option.value === "all"
                          ? data.models.length
                          : option.value === "enabled"
                            ? enabledModelCount
                            : data.models.length - enabledModelCount;
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
                  <div className="search-box">
                    <Search size={16} />
                    <input
                      aria-label="Search models"
                      value={modelSearch}
                      onChange={(event) => setModelSearch(event.target.value)}
                      placeholder="Search models"
                    />
                  </div>
                </div>
              }
            >
                <div className="model-list" role="table" aria-label="Organization model availability">
                  <div className="model-list-header" role="row">
                    <span role="columnheader" className="model-column-header">
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
                    <span role="columnheader" className="model-column-header">
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
                    <span role="columnheader" className="model-column-header">
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
                    <span role="columnheader">Org Status</span>
                    <span role="columnheader">Details</span>
                  </div>
                  {visibleModels.map((model) => {
                    const expanded = Boolean(expandedModelIds[model.id]);
                    const knowledgeIds = modelKnowledgeIds(model);
                    const toolIds = modelToolIds(model);
                    const editDraft = modelEditDrafts[model.id] ?? modelEditDraftFromModel(model);
                    return (
                      <div className={`model-list-item${expanded ? " is-expanded" : ""}`} role="rowgroup" key={model.id}>
                        <div className="model-list-row" role="row">
                          <div className="model-cell model-provider-cell" role="cell">
                            <span className="model-cell-label">Provider</span>
                            <strong>{model.provider_name}</strong>
                          </div>
                          <div className="model-cell model-name-cell" role="cell">
                            <span className="model-cell-label">Model</span>
                            <strong>{model.name}</strong>
                            <small>
                              {model.is_custom ? "Custom preset" : "Provider model"} · {model.visibility ?? "organization"}
                            </small>
                          </div>
                          <div className="model-cell model-route-cell" role="cell">
                            <span className="model-cell-label">Runtime Route</span>
                            <span className="model-route-value">{model.upstream_model_id ?? model.name}</span>
                            <small>{model.provider_id}</small>
                          </div>
                          <div className="model-cell model-status-cell" role="cell">
                            <span className="model-cell-label">Org Status</span>
                            <span className={model.platform_enabled ? "status-enabled" : "status-disabled"}>
                              <Toggle
                                checked={model.platform_enabled}
                                disabled={pendingAction === `model:${model.id}:toggle`}
                                label={`Org status for ${model.name}`}
                                tooltip={
                                  model.platform_enabled
                                    ? `Disable ${model.name} so tenants can no longer use it`
                                    : `Enable ${model.name} so tenant admins can grant access to it`
                                }
                                onChange={(next) => toggleModel(model.id, next)}
                              />{" "}
                              {model.platform_enabled ? "Enabled" : "Disabled"}
                            </span>
                          </div>
                          <div className="model-cell model-actions-cell" role="cell">
                            <button
                              className="secondary-button model-details-button"
                              type="button"
                              aria-expanded={expanded}
                              aria-controls={`model-details-${model.id}`}
                              data-tooltip={
                                expanded
                                  ? `Collapse the editable details for ${model.name}`
                                  : `Open the name, routing, prompts, and notes for ${model.name}`
                              }
                              onClick={() => toggleModelDetails(model.id)}
                            >
                              <Edit3 size={16} /> Edit details <ChevronDown className="details-chevron" size={15} />
                            </button>
                          </div>
                        </div>
                        {expanded && (
                          <div className="model-list-details" id={`model-details-${model.id}`}>
                            <div className="inline-form model-detail-editor" aria-label={`${model.name} editable details`}>
                              <label>
                                Display name
                                <input
                                  value={editDraft.name}
                                  onChange={(event) => updateModelEditDraft(model.id, { name: event.target.value })}
                                />
                              </label>
                              <label>
                                Runtime route
                                <input
                                  value={editDraft.upstream_model_id}
                                  onChange={(event) => updateModelEditDraft(model.id, { upstream_model_id: event.target.value })}
                                />
                              </label>
                              <label>
                                Context window
                                <input
                                  inputMode="numeric"
                                  value={editDraft.context_window}
                                  onChange={(event) => updateModelEditDraft(model.id, { context_window: event.target.value })}
                                  placeholder="128000"
                                />
                              </label>
                              <label className="wide-field">
                                Notes
                                <textarea
                                  value={editDraft.notes}
                                  onChange={(event) => updateModelEditDraft(model.id, { notes: event.target.value })}
                                  placeholder="Provider catalog note, zero-retention eligibility, tenant guidance, or routing caveat."
                                />
                              </label>
                              <label className="wide-field">
                                System prompt
                                <textarea
                                  value={editDraft.system_prompt}
                                  onChange={(event) => updateModelEditDraft(model.id, { system_prompt: event.target.value })}
                                />
                              </label>
                              <label className="wide-field">
                                Meta prompt
                                <textarea
                                  value={editDraft.meta_prompt}
                                  onChange={(event) => updateModelEditDraft(model.id, { meta_prompt: event.target.value })}
                                />
                              </label>
                              <button
                                className="primary-button form-submit-button"
                                type="button"
                                data-tooltip={`Save the updated name, routing, prompts, and notes for ${model.name}`}
                                onClick={() => saveModelDetails(model)}
                                disabled={!editDraft.name.trim() || pendingAction === `model:${model.id}:details`}
                              >
                                <Save size={16} />
                                <StableLabel
                                  label={pendingAction === `model:${model.id}:details` ? "Saving..." : "Save details"}
                                  reserve={["Saving...", "Save details"]}
                                />
                              </button>
                            </div>
                            <dl className="model-detail-grid">
                              <div>
                                <dt>Prompt</dt>
                                <dd>{modelPromptLabel(model)}</dd>
                              </div>
                              <div>
                                <dt>Knowledge</dt>
                                <dd>{knowledgeIds.length ? knowledgeIds.join(", ") : "None"}</dd>
                              </div>
                              <div>
                                <dt>Tools</dt>
                                <dd>{toolIds.length ? toolIds.join(", ") : "None"}</dd>
                              </div>
                              <div>
                                <dt>Context</dt>
                                <dd>{model.context_window ? `${model.context_window.toLocaleString()} tokens` : "Not provided"}</dd>
                              </div>
                              <div className="wide-detail">
                                <dt>Notes</dt>
                                <dd>{model.notes ?? "No notes"}</dd>
                              </div>
                              {(model.system_prompt || model.meta_prompt) && (
                                <div className="wide-detail">
                                  <dt>Prompt text</dt>
                                  <dd>{[model.system_prompt, model.meta_prompt].filter(Boolean).join(" ")}</dd>
                                </div>
                              )}
                            </dl>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {visibleModels.length === 0 && (
                    <div className="model-list-empty" role="row">
                      {modelProviderFilter.length > 0 || modelLabFilter.length > 0 || modelRouteTerm
                        ? "No models match the current column filters."
                        : modelStatusFilter === "all"
                          ? "No models match the current search."
                          : modelSearchTerm
                            ? `No ${modelStatusFilter} models match the current search.`
                            : `No models are currently ${modelStatusFilter}.`}
                    </div>
                  )}
                </div>
            </Panel>
          </div>
        </Tabs.Content>

        <Tabs.Content value="providers" className="tab-content">
          <Panel
            key={`provider-connections-${openProvidersRequestKey ?? 0}`}
            className="provider-connections-panel"
            title="Provider Connections"
            subtitle="OpenAI, Anthropic, Azure OpenAI, Azure Foundry, GCP (Gemini), Bedrock, Open WebUI, and OpenAI-compatible gateways can be registered here. Open API Keys on a provider to view, reveal, replace, or delete its vaulted credentials."
            actions={
              <button
                className="primary-button"
                type="button"
                data-tooltip={
                  showProviderForm
                    ? "Close the new provider form without saving"
                    : "Open a form to register a new AI provider connection"
                }
                onClick={() => setShowProviderForm((value) => !value)}
                aria-expanded={showProviderForm}
                aria-controls="provider-builder-form"
                disabled={pendingAction === "provider:create"}
              >
                <Plus size={16} /> {showProviderForm ? "Close form" : "Add Provider"}
              </button>
            }
          >
            {data.providers.length === 0 && !showProviderForm && (
              <div className="provider-setup-empty">
                <h3>Connect your first model provider</h3>
                <p>Add a provider and its credentials to make models available in this workspace.</p>
                <ol>
                  <li>Add the connection details supplied by your provider.</li>
                  <li>Validate the connection, then sync its model catalog.</li>
                  <li>Enable models and give the right groups access.</li>
                </ol>
              </div>
            )}
            {showProviderForm && (
              <fieldset className="inline-form provider-builder-form" id="provider-builder-form" disabled={pendingAction === "provider:create"} aria-label="New provider">
                <label>
                  Name
                  <input
                    value={providerDraft.name}
                    onChange={(event) => setProviderDraft((state) => ({ ...state, name: event.target.value }))}
                    placeholder="Provider name"
                  />
                </label>
                <label>
                  Kind
                  <SelectControl
                    value={providerDraft.kind}
                    onChange={(event) => {
                      const kind = event.target.value;
                      setProviderDraft((state) => ({
                        ...state,
                        kind,
                        auth_type: defaultAuthTypeForKind(kind),
                        header_name: defaultHeaderForKind(kind),
                        base_url:
                          !state.base_url.trim() || state.base_url.trim() === defaultBaseUrlForKind(state.kind, "")
                            ? defaultBaseUrlForKind(kind, "")
                            : state.base_url,
                        catalog_scope: defaultCatalogScopeForKind(kind),
                      }));
                    }}
                  >
                    {PROVIDER_KIND_OPTIONS.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </SelectControl>
                </label>
                <label>
                  Region
                  <input value={providerDraft.region} onChange={(event) => setProviderDraft((state) => ({ ...state, region: event.target.value }))} />
                </label>
                <label className="wide-field">
                  Base URL
                  <input
                    value={providerDraft.base_url}
                    onChange={(event) => setProviderDraft((state) => ({ ...state, base_url: event.target.value }))}
                    placeholder="https://api.openai.com/v1"
                  />
                </label>
                <label>
                  Auth type
                  <SelectControl
                    value={providerDraft.auth_type}
                    onChange={(event) => setProviderDraft((state) => ({ ...state, auth_type: event.target.value }))}
                  >
                    {["bearer", "api-key", "oauth", "managed-identity"].map((authType) => (
                      <option key={authType} value={authType}>
                        {authType}
                      </option>
                    ))}
                  </SelectControl>
                </label>
                <label>
                  Header
                  <input
                    value={providerDraft.header_name}
                    onChange={(event) => setProviderDraft((state) => ({ ...state, header_name: event.target.value }))}
                    placeholder="Authorization"
                  />
                </label>
                <label>
                  API version
                  <input
                    value={providerDraft.api_version}
                    onChange={(event) => setProviderDraft((state) => ({ ...state, api_version: event.target.value }))}
                    placeholder="Azure API version"
                  />
                </label>
                <label>
                  Deployment
                  <input
                    value={providerDraft.deployment_id}
                    onChange={(event) => setProviderDraft((state) => ({ ...state, deployment_id: event.target.value }))}
                    placeholder="Azure deployment"
                  />
                </label>
                {providerDraft.kind === "openrouter" && (
                  <label>
                    Catalog scope
                    <SelectControl
                      value={providerDraft.catalog_scope || defaultCatalogScopeForKind(providerDraft.kind)}
                      onChange={(event) => setProviderDraft((state) => ({ ...state, catalog_scope: event.target.value }))}
                    >
                      {OPENROUTER_CATALOG_SCOPE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </SelectControl>
                  </label>
                )}
                <label>
                  Key name
                  <input
                    value={providerDraft.key_name}
                    onChange={(event) => setProviderDraft((state) => ({ ...state, key_name: event.target.value }))}
                    placeholder="Production primary"
                  />
                </label>
                <label>
                  Environment
                  <input
                    value={providerDraft.key_environment}
                    onChange={(event) => setProviderDraft((state) => ({ ...state, key_environment: event.target.value }))}
                  />
                </label>
                <label>
                  Expires
                  <input
                    value={providerDraft.key_expires}
                    onChange={(event) => setProviderDraft((state) => ({ ...state, key_expires: event.target.value }))}
                    placeholder="Jun 27, 2027"
                  />
                </label>
                <label className="wide-field">
                  API key or secret
                  <input
                    type="password"
                    value={providerDraft.secret_value}
                    onChange={(event) => setProviderDraft((state) => ({ ...state, secret_value: event.target.value }))}
                    placeholder="Saved to the provider vault"
                  />
                </label>
                <button
                  className="primary-button form-submit-button"
                  type="button"
                  data-tooltip="Register this provider and store its key in the platform vault"
                  onClick={addProvider}
                  disabled={!providerDraft.name.trim() || pendingAction === "provider:create"}
                >
                  <StableLabel
                    label={pendingAction === "provider:create" ? "Saving..." : "Save Provider"}
                    reserve={["Saving...", "Save Provider"]}
                  />
                </button>
              </fieldset>
            )}
            <div className="provider-grid provider-grid-wide">
              {data.providers.map((provider) => {
                const providerEditorOpen = Boolean(expandedProviderIds[provider.id]);
                const providerKeysOpen = Boolean(expandedProviderKeyIds[provider.id]);
                const providerKeys = data.providerKeys.filter((key) => key.provider_id === provider.id);
                const editDraft = providerEditDrafts[provider.id] ?? providerConnectionDraftFromProvider(provider);
                return (
                  <div
                    className={`provider-card${providerEditorOpen || providerKeysOpen ? " is-expanded" : ""}`}
                    key={provider.id}
                  >
                    <div className={`provider-logo ${provider.kind.includes("openai") ? "" : "teal"}`}>
                      <ProviderBrandLogo name={provider.name} kind={provider.kind} />
                    </div>
                    <div className="provider-summary">
                      <h2>{provider.name}</h2>
                      <Pill tone={provider.connected && isRuntimeSupportedProviderKind(provider.kind) ? "success" : "warning"}>
                        {provider.connected
                          ? isRuntimeSupportedProviderKind(provider.kind)
                            ? "Connected"
                            : "Adapter needed"
                          : providerHasActiveKey(data.providerKeys, provider.id) ? "Needs validation" : "Needs key"}
                      </Pill>
                      <dl>
                        <div>
                          <dt>Kind</dt>
                          <dd>{provider.kind}</dd>
                        </div>
                        <div>
                          <dt>Region</dt>
                          <dd>{provider.region}</dd>
                        </div>
                        <div>
                          <dt>Models</dt>
                          <dd>
                            {provider.enabled_model_count} of {provider.model_count}
                          </dd>
                        </div>
                        {provider.kind === "openrouter" && (
                          <div>
                            <dt>Catalog</dt>
                            <dd>{openRouterCatalogScopeLabel(openRouterCatalogScopeFromProvider(provider))}</dd>
                          </div>
                        )}
                      </dl>
                      <p className="muted-note">{provider.status_message ?? provider.base_url ?? "Provider configured"}</p>
                    </div>
                    <div className="provider-actions">
                      <button
                        className="secondary-button"
                        type="button"
                        aria-expanded={providerEditorOpen}
                        aria-controls={`provider-connection-${provider.id}`}
                        data-tooltip={
                          providerEditorOpen
                            ? `Close the connection editor for ${provider.name}`
                            : `Edit the endpoint and auth settings for ${provider.name}`
                        }
                        onClick={() => toggleProviderEditor(provider)}
                      >
                        <Edit3 size={16} /> Edit Connection
                      </button>
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => syncProvider(provider)}
                        disabled={pendingAction === `provider:${provider.id}:sync` || !providerHasActiveKey(data.providerKeys, provider.id)}
                        data-tooltip={
                          providerHasActiveKey(data.providerKeys, provider.id)
                            ? `Refresh the model catalog from ${provider.name} into the platform`
                            : `Add an active key for ${provider.name} before models can be synced`
                        }
                      >
                        <RotateCcw size={16} /> {pendingAction === `provider:${provider.id}:sync` ? "Syncing..." : "Sync Models"}
                      </button>
                      <button
                        className="secondary-button"
                        type="button"
                        aria-label={`API keys for ${provider.name}`}
                        aria-expanded={providerKeysOpen}
                        aria-controls={`provider-keys-${provider.id}`}
                        data-tooltip={
                          providerKeysOpen
                            ? `Hide the vaulted API keys for ${provider.name}`
                            : `View, reveal, replace, or delete the vaulted API keys for ${provider.name}`
                        }
                        onClick={() => toggleProviderKeys(provider.id)}
                      >
                        <KeyRound size={16} /> API Keys <b className="provider-key-count">{providerKeys.length}</b>
                      </button>
                      <button
                        className="secondary-button is-danger"
                        type="button"
                        aria-label={`Delete provider ${provider.name}`}
                        disabled={pendingAction === `provider:${provider.id}:delete`}
                        data-tooltip={`Permanently delete ${provider.name} with its models and vaulted keys`}
                        onClick={() => openProviderDeleteDialog(provider)}
                      >
                        <Trash2 size={16} />{" "}
                        {pendingAction === `provider:${provider.id}:delete` ? "Deleting..." : "Delete"}
                      </button>
                    </div>
                    {providerEditorOpen && (
                      <div
                        className="inline-form provider-connection-editor"
                        id={`provider-connection-${provider.id}`}
                        aria-label={`${provider.name} connection settings`}
                      >
                        <label>
                          Name
                          <input
                            value={editDraft.name}
                            onChange={(event) => updateProviderEditDraft(provider, { name: event.target.value })}
                          />
                        </label>
                        <label>
                          Kind
                          <SelectControl value={editDraft.kind} onChange={(event) => updateProviderEditKind(provider, event.target.value)}>
                            {PROVIDER_KIND_OPTIONS.map((kind) => (
                              <option key={kind} value={kind}>
                                {kind}
                              </option>
                            ))}
                          </SelectControl>
                        </label>
                        <label>
                          Region
                          <input
                            value={editDraft.region}
                            onChange={(event) => updateProviderEditDraft(provider, { region: event.target.value })}
                          />
                        </label>
                        <label className="wide-field">
                          Base URL
                          <input
                            value={editDraft.base_url}
                            onChange={(event) => updateProviderEditDraft(provider, { base_url: event.target.value })}
                            placeholder="https://api.openai.com/v1"
                          />
                        </label>
                        <label>
                          Auth type
                          <SelectControl
                            value={editDraft.auth_type}
                            onChange={(event) => updateProviderEditDraft(provider, { auth_type: event.target.value })}
                          >
                            {["bearer", "api-key", "oauth", "managed-identity"].map((authType) => (
                              <option key={authType} value={authType}>
                                {authType}
                              </option>
                            ))}
                          </SelectControl>
                        </label>
                        <label>
                          Header
                          <input
                            value={editDraft.header_name}
                            onChange={(event) => updateProviderEditDraft(provider, { header_name: event.target.value })}
                            placeholder="Authorization"
                          />
                        </label>
                        <label>
                          API version
                          <input
                            value={editDraft.api_version}
                            onChange={(event) => updateProviderEditDraft(provider, { api_version: event.target.value })}
                            placeholder="Azure API version"
                          />
                        </label>
                        <label>
                          Deployment
                          <input
                            value={editDraft.deployment_id}
                            onChange={(event) => updateProviderEditDraft(provider, { deployment_id: event.target.value })}
                            placeholder="Azure deployment"
                          />
                        </label>
                        {editDraft.kind === "openrouter" && (
                          <label>
                            Catalog scope
                            <SelectControl
                              value={editDraft.catalog_scope || defaultCatalogScopeForKind(editDraft.kind)}
                              onChange={(event) => updateProviderEditDraft(provider, { catalog_scope: event.target.value })}
                            >
                              {OPENROUTER_CATALOG_SCOPE_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </SelectControl>
                          </label>
                        )}
                        <div className="provider-editor-actions">
                          <button
                            className="primary-button form-submit-button"
                            type="button"
                            data-tooltip={`Apply the updated connection settings for ${provider.name}`}
                            onClick={() => saveProviderConnection(provider)}
                            disabled={!editDraft.name.trim() || pendingAction === `provider:${provider.id}:edit`}
                          >
                            <Save size={16} />
                            <StableLabel
                              label={pendingAction === `provider:${provider.id}:edit` ? "Saving..." : "Save Connection"}
                              reserve={["Saving...", "Save Connection"]}
                            />
                          </button>
                          <button
                            className="secondary-button"
                            type="button"
                            data-tooltip={`Close the editor without saving connection changes for ${provider.name}`}
                            onClick={() => toggleProviderEditor(provider)}
                          >
                            <X size={16} /> Cancel
                          </button>
                        </div>
                      </div>
                    )}
                    {providerKeysOpen && (
                      <div
                        className="provider-keys"
                        id={`provider-keys-${provider.id}`}
                        aria-label={`${provider.name} API keys`}
                      >
                        <div className="provider-keys-head">
                          <h3>
                            <KeyRound size={15} /> API Key Vault
                          </h3>
                          <button
                            className="secondary-button"
                            type="button"
                            data-tooltip={
                              showKeyForm && keyDraft.provider_id === provider.id
                                ? `Close the new key form for ${provider.name} without saving`
                                : `Add a ${provider.name} API key to the platform vault`
                            }
                            onClick={() => beginNewProviderKey(provider)}
                          >
                            <Plus size={15} /> Add Key
                          </button>
                        </div>
                        {showKeyForm && keyDraft.provider_id === provider.id && (
                          <div className="inline-form key-builder-form">
                            <label>
                              Key name
                              <input
                                value={keyDraft.name}
                                onChange={(event) => setKeyDraft((state) => ({ ...state, name: event.target.value }))}
                                placeholder="Production primary"
                              />
                            </label>
                            <label>
                              Environment
                              <input
                                value={keyDraft.environment}
                                onChange={(event) => setKeyDraft((state) => ({ ...state, environment: event.target.value }))}
                              />
                            </label>
                            <label>
                              Expires
                              <input
                                value={keyDraft.expires}
                                onChange={(event) => setKeyDraft((state) => ({ ...state, expires: event.target.value }))}
                                placeholder="Jun 27, 2027"
                              />
                            </label>
                            <label className="wide-field">
                              API key or secret
                              <input
                                type="password"
                                value={keyDraft.secret_value}
                                onChange={(event) => setKeyDraft((state) => ({ ...state, secret_value: event.target.value }))}
                                placeholder="Saved to the provider vault"
                              />
                            </label>
                            <button
                              className="primary-button form-submit-button"
                              type="button"
                              data-tooltip={`Encrypt and store this ${provider.name} API key in the platform vault`}
                              onClick={addProviderKey}
                              disabled={!keyDraft.secret_value.trim() || pendingAction === "key:create"}
                            >
                              <StableLabel
                                label={pendingAction === "key:create" ? "Saving..." : "Save Key"}
                                reserve={["Saving...", "Save Key"]}
                              />
                            </button>
                          </div>
                        )}
                        {providerKeys.length === 0 ? (
                          <p className="muted-note">
                            No API keys are stored for {provider.name}. Add a key so models can sync and chat can
                            route through this provider.
                          </p>
                        ) : (
                          <div className="table-scroll">
                            <table className="data-table key-table">
                              <thead>
                                <tr>
                                  <th>Key Name</th>
                                  <th>Environment</th>
                                  <th>Status</th>
                                  <th>Last Rotated</th>
                                  <th>Expires</th>
                                  <th>Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {providerKeys.map((key) => {
                                  const effectiveStatus = providerKeyEffectiveStatus(key);
                                  const isExpired = effectiveStatus === "Expired";
                                  const isActive = effectiveStatus.toLowerCase() === "active";
                                  return (
                                    <tr key={key.id}>
                                      <td data-label="Key Name">
                                        {key.name} <span className="masked">{key.masked_value}</span>
                                      </td>
                                      <td data-label="Environment">{key.environment}</td>
                                      <td data-label="Status">
                                        <span className={isActive ? "status-enabled" : "status-disabled"}>
                                          <span className={isActive ? "dot green" : "dot red"} /> {effectiveStatus}
                                        </span>
                                      </td>
                                      <td data-label="Last Rotated">{key.last_rotated}</td>
                                      <td data-label="Expires">{key.expires}</td>
                                      <td className="table-actions" data-label="Actions">
                                        <button
                                          type="button"
                                          aria-label={`Reveal ${key.name}`}
                                          onClick={() => revealProviderKey(key)}
                                          disabled={isExpired || pendingAction === `key:${key.id}:reveal`}
                                          data-tooltip={
                                            isExpired
                                              ? `Add a replacement for ${key.name}; expired keys cannot be revealed`
                                              : `Show the full secret value of ${key.name} for copying`
                                          }
                                        >
                                          <Eye size={15} />{" "}
                                          <span className="action-label">
                                            {pendingAction === `key:${key.id}:reveal` ? "Revealing..." : "Reveal"}
                                          </span>
                                        </button>
                                        <button
                                          type="button"
                                          aria-label={`Add replacement key for ${key.name}`}
                                          onClick={() => beginReplacementProviderKey(key)}
                                          data-tooltip={`Paste a provider-generated replacement key for ${key.name}`}
                                        >
                                          <KeyRound size={15} /> <span className="action-label">Replace</span>
                                        </button>
                                        <button
                                          className="danger-icon-button"
                                          type="button"
                                          aria-label={`Delete ${key.name}`}
                                          onClick={() => deleteProviderKey(key)}
                                          disabled={pendingAction === `key:${key.id}:delete`}
                                          data-tooltip={`Permanently remove ${key.name} from the platform vault`}
                                        >
                                          <Trash2 size={15} />{" "}
                                          <span className="action-label">
                                            {pendingAction === `key:${key.id}:delete` ? "Deleting..." : "Delete"}
                                          </span>
                                        </button>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Panel>
        </Tabs.Content>

        <Tabs.Content value="org-settings" className="tab-content">
          <div className="org-settings-stack">
            <RoleBoundaryPanel
              data={data}
              userDraft={ownerUserDraft}
              setUserDraft={setOwnerUserDraft}
              pendingAction={pendingAction}
              onCreateUser={() => void createOwnerManagedUser()}
              onUpdateUserRole={(user, role) => void updateOwnerManagedUserRole(user, role)}
              onRemoveUser={(user) => void removeOwnerManagedUser(user)}
              onResetPassword={setPasswordTarget}
            />
            <SsoRequirementsPanel
              ssoDraft={ownerSsoDraft}
              setSsoDraft={setOwnerSsoDraft}
              onSaveSso={saveOwnerSsoSettings}
              onTestSso={() => void testOwnerSsoConnection()}
              testResult={ssoTestResult}
              testing={pendingAction === "owner-sso:test"}
              brandName={data.currentTenant.chat_brand_name?.trim() || DEFAULT_BRANDING.chat_brand_name}
            />
            <PlatformBrandingPanel
              brandingDraft={brandingDraft}
              setBrandingDraft={setBrandingDraft}
              onApplyBranding={applyBranding}
              onResetBranding={resetBranding}
              onUploadBrandingImage={uploadBrandingImage}
              status={brandingStatus}
              onDismissStatus={() => setBrandingStatus(null)}
              saving={pendingAction === "branding:save"}
              uploadPending={brandingUploadPending}
            />
            <TenantPolicyPanel
              policies={tenantPolicies}
              pendingAction={pendingAction}
              onPolicyChange={(key, next) => void updateTenantPolicy(key, next)}
            />
            <DeploymentBudgetPanel userId={data.me.id} tenantSlug={data.currentTenant.slug} />
            <ConnectorsPanel
              data={data}
              onDataChange={onDataChange}
              api={platformActions}
              onStatus={setActionStatus}
              defaultCollapsed
            />
            <ElasticPanel elasticStatus={elasticStatus} />
            <RetentionPanel
              policy={retentionPolicy}
              error={retentionError}
              busy={pendingAction === "retention-policy"}
              onPolicyChange={(patch) => void saveRetentionPolicy(patch)}
            />
          </div>
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
              subtitle="Authoritative execution timestamps captured from Chat and Draft completion audit events."
              actions={
                <CsvExportControl
                  label="runtime analytics"
                  filenameBase={
                    runtimeScope.userId === "all"
                      ? "aperture-runtime-analytics"
                      : `aperture-runtime-analytics-${runtimeScope.userId}`
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
                users={auditUserOptions}
                selectedCount={filteredRuntimeAuditRows.length}
                totalCount={runtimeAuditRows.length}
              />
              <div className="feedback-summary-grid">
                <div className="feedback-summary-card">
                  <span>Runtime events</span>
                  <strong>{filteredRuntimeAuditRows.length}</strong>
                  <small>Chat and Draft executions with clock metadata.</small>
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
                <div className="feedback-event-list scrollable-log-list" aria-label="Runtime clock events">
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
                      <time dateTime={item.executedAt}>{formatAuditTimestamp(item.executedAt)}</time>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="audit-empty-state">
                  <Clock3 size={20} />
                  <span>
                    <strong>No runtime clock events yet</strong>
                    <small>Chat completions and Draft executions will appear here after the next run.</small>
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
                  ? "Thumbs ratings, written notes, and platform issue reports from every user."
                  : "Thumbs ratings recorded in this browser. Server-side feedback and issue reports load when the platform API is connected."
              }
              actions={
                  <CsvExportControl
                    label="chat feedback analytics"
                    filenameBase="aperture-chat-feedback"
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
                users={auditUserOptions}
                selectedCount={filteredChatFeedback.length + filteredIssueReports.length}
                totalCount={feedbackSource.length + issueReports.length}
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
                <div className="feedback-event-list scrollable-log-list" aria-label="Chat feedback events">
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
                          <small>{item.thread_title} · {item.model_id} · {item.user_name}</small>
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
                  <div className="feedback-event-list scrollable-log-list" aria-label="Platform issue reports">
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
                  listThreadPromptActivity
                    ? (threadId) => Promise.resolve(listThreadPromptActivity(threadId))
                    : undefined
                }
                onClose={() => setFeedbackPreview(null)}
              />
            )}
            {issueReportPreview && (
              <IssueReportPreview
                item={issueReportPreview}
                sentLabel={formatFeedbackTimestamp(issueReportPreview.created_at)}
                loadScreenshot={platformActions?.loadIssueReportScreenshot}
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
              subtitle="Saved prompt volume by model, date, and user for the filter selected below."
              actions={
                <button
                  className="secondary-button compact"
                  type="button"
                  data-tooltip="Reload model activity from saved prompt records"
                  onClick={() => setAuditTrailRefreshToken((token) => token + 1)}
                >
                  <RotateCcw size={14} /> Refresh
                </button>
              }
              defaultCollapsed
            >
              <SectionScopeFilter
                label="Model activity filter"
                scope={activityScope}
                onChange={setActivityScope}
                users={auditUserOptions}
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
                    <small>Usage charts load from saved prompt records when the platform API is available.</small>
                  </span>
                </div>
              ) : promptActivity === null ? (
                <div className="audit-empty-state">
                  <LineChart size={20} />
                  <span>
                    <strong>Model activity is loading</strong>
                    <small>Reading saved prompts for the selected audit scope.</small>
                  </span>
                </div>
              ) : analyticsPromptActivityRows.length === 0 ? (
                <div className="audit-empty-state">
                  <BarChart3 size={20} />
                  <span>
                    <strong>No model activity yet</strong>
                    <small>Saved prompts will populate model and user usage charts.</small>
                  </span>
                </div>
              ) : (
                <>
                  <div className="model-activity-chart-grid">
                    <section className="model-activity-card" aria-label="Model activity bar chart">
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
                                {row.userCount} user{row.userCount === 1 ? "" : "s"} · latest {formatAuditTimestamp(row.latestAt)}
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

                    <section className="model-activity-card" aria-label="Model usage line chart">
                      <div className="model-activity-chart-header">
                        <span>
                          <LineChart size={16} />
                          <strong>Prompt trend</strong>
                        </span>
                        <small>{promptUsageTrendRows.length} day{promptUsageTrendRows.length === 1 ? "" : "s"}</small>
                      </div>
                      <div className="model-activity-line-chart">
                        <svg viewBox="0 0 320 140" role="img" aria-label="Prompt usage trend by day">
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

                  <section className="model-user-activity" aria-label="Users by prompt activity">
                    <div className="model-activity-chart-header">
                      <span>
                        <Users size={16} />
                        <strong>Users by prompt activity</strong>
                      </span>
                      <small>{promptUserRows.length} active user{promptUserRows.length === 1 ? "" : "s"}</small>
                    </div>
                    <div className="model-user-activity-list scrollable-log-list usage-user-list">
                      {promptUserRows.map((row) => (
                        <div className="model-user-activity-row" key={row.userId}>
                          <span>
                            <strong>{row.userName}</strong>
                            <small>{row.modelCount} model{row.modelCount === 1 ? "" : "s"} used</small>
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
              subtitle="Durable per-user usage from real completions across chat, drafts, agents, automations, and the API gateway. Token counts are provider-reported only and stay blank when a provider reported none. Includes platform owners, admins, and users."
              actions={
                <>
                  <CsvExportControl
                    label="usage records"
                    filenameBase="aperture-platform-usage-records"
                    items={usageRecords}
                    getTimestamp={(item) => item.created_at}
                    columns={USAGE_RECORD_CSV_COLUMNS}
                  />
                  <button
                    className="secondary-button compact"
                    type="button"
                    data-tooltip="Reload usage records from the platform usage API"
                    onClick={() => setAuditTrailRefreshToken((token) => token + 1)}
                  >
                    <RotateCcw size={14} /> Refresh
                  </button>
                </>
              }
              defaultCollapsed
            >
              <SectionScopeFilter
                label="Usage filter"
                scope={usageScope}
                onChange={setUsageScope}
                users={usageUserOptions}
                allUsersLabel="All owners, admins, and users"
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
              ) : !getUsageSummaryAction ? (
                <div className="audit-empty-state">
                  <BarChart3 size={20} />
                  <span>
                    <strong>Usage analytics endpoint is not connected</strong>
                    <small>Per-user usage loads from the platform usage API when it is available.</small>
                  </span>
                </div>
              ) : usageSummary === null ? (
                <div className="audit-empty-state">
                  <LineChart size={20} />
                  <span>
                    <strong>Usage analytics are loading</strong>
                    <small>Reading recorded completions across the platform.</small>
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
                          <label className="compact-select-field">
                            <Users size={14} />
                            <SelectControl
                              aria-label="Focus usage on one user"
                              value={usageScope.userId}
                              onChange={(event) => setUsageScope((scope) => ({ ...scope, userId: event.target.value }))}
                              data-tooltip="Show usage for a single owner, admin, or user"
                            >
                              <option value="all">All users ranked</option>
                              {usageUsers.map((user) => (
                                <option key={user.id} value={user.id}>
                                  {user.display_name || user.email}
                                </option>
                              ))}
                            </SelectControl>
                          </label>
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
                                  {formatAuditRole(row.user_role)} · {row.model_count} model
                                  {row.model_count === 1 ? "" : "s"} · {row.surfaces.join(", ")} · last active{" "}
                                  {formatAuditTimestamp(row.last_active_at)}
                                </small>
                              </span>
                              <span className="usage-user-tokens">{formatTokenCount(row.total_tokens)} tokens</span>
                              <b>{row.message_count}</b>
                            </button>
                          ))}
                        </div>
                        <small className="usage-token-muted">
                          {usageSummary.by_user.length.toLocaleString()} user
                          {usageSummary.by_user.length === 1 ? "" : "s"} in range · pick a user from the selector, or
                          click a row to focus it.
                        </small>
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
          </div>
        </Tabs.Content>

        <Tabs.Content value="audit" className="tab-content">
          <div className="audit-console-grid">
            <Panel title="Owner Audit" subtitle="Security and governance signals for provider, model, key, prompt, connector, and agent activity.">
              <div className="audit-summary-grid">
                {auditSummary.map((item) => (
                  <AuditSummaryCard item={item} key={item.label} />
                ))}
              </div>
            </Panel>

            <Panel
              title="Recent Governance Activity"
              subtitle="Latest owner-relevant events derived from the current platform snapshot."
              defaultCollapsed
            >
              {recentAuditRows.map((row) => (
                <div className="audit-row" key={row.id}>
                  <ListChecks size={17} />
                  <span>
                    <strong>{row.title}</strong>
                    <small>{row.detail}</small>
                  </span>
                  <time>{row.time}</time>
                </div>
              ))}
            </Panel>

            <Panel
              title="User Prompt Activity"
              subtitle="Drill into saved user prompts by person, thread, model, and timestamp."
              defaultCollapsed
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
                    <RotateCcw size={14} /> Refresh monitor
                  </button>
                </>
              }
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
                users={auditUserOptions}
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
                    <small>Saved prompt records load from the platform API when it is available.</small>
                  </span>
                </div>
              ) : promptActivity === null ? (
                <div className="audit-empty-state">
                  <MessageSquareText size={20} />
                  <span>
                    <strong>Prompt activity is loading</strong>
                    <small>Reading saved chat prompts for the selected scope.</small>
                  </span>
                </div>
              ) : promptActivity.length === 0 ? (
                <div className="audit-empty-state">
                  <MessageSquareText size={20} />
                  <span>
                    <strong>No saved prompts found</strong>
                    <small>Prompts appear here after a user sends and saves chat activity.</small>
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
                  ariaLabel="User prompt activity"
                  formatTimestamp={formatPromptRecordTimestamp}
                  extraThreadSearchText={promptSearchExtras}
                  loadThreadRecords={listThreadPromptActivity}
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
                    listThreadPromptActivity
                      ? (threadId) => Promise.resolve(listThreadPromptActivity(threadId))
                      : undefined
                  }
                  onBatchAction={
                    platformActions?.runRetentionBatch
                      ? (action, threadIds) => runRetentionBatchAction(action, threadIds)
                      : undefined
                  }
                />
              )}
            </Panel>

            <Panel
              title="Security Alerts"
              subtitle="DLP and malicious-behavior flags raised from actual prompts, with redacted snippets for review."
              defaultCollapsed
            >
              <SectionScopeFilter
                label="Security alert filter"
                scope={securityScope}
                onChange={setSecurityScope}
                users={auditUserOptions}
                selectedCount={auditSecurityAlerts.length}
                totalCount={(securityAlerts ?? []).length}
              />
              <div className="audit-alert-summary">
                <Pill tone={unacknowledgedSecurityAlerts.length ? "warning" : "success"}>
                  {unacknowledgedSecurityAlerts.length} active
                </Pill>
                <Pill tone="neutral">{auditSecurityAlerts.filter((alert) => alert.acknowledged).length} acknowledged</Pill>
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
                    <small>DLP and behavior alerts load from the platform API when it is available.</small>
                  </span>
                </div>
              ) : securityAlerts === null ? (
                <div className="audit-empty-state">
                  <ShieldAlert size={20} />
                  <span>
                    <strong>Security alerts are loading</strong>
                    <small>Reading DLP and misuse flags for the selected scope.</small>
                  </span>
                </div>
              ) : securityAlerts.length === 0 ? (
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
                <div className="security-alert-list scrollable-log-list" role="list" aria-label="Security alerts">
                  {auditSecurityAlerts.map((alert) => {
                    const actionKey = `security-alert:${alert.id}`;
                    return (
                      <div className={`security-alert-row${alert.acknowledged ? " is-acknowledged" : ""}`} role="listitem" key={alert.id}>
                        {alert.acknowledged ? <ShieldCheck size={17} /> : <ShieldAlert size={17} />}
                        <span>
                          <strong>{alert.rule_label}</strong>
                          <small>
                            {alert.user_name || alert.user_id} · {alert.model_id || "unknown model"} · {formatSecurityAlertTimestamp(alert.created_at)}
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
                            disabled={!platformActions?.acknowledgeSecurityAlert || pendingAction === actionKey}
                            onClick={() => setSecurityAlertAcknowledged(alert, !alert.acknowledged)}
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
              subtitle="Append-only transaction log of platform and tenant mutations, newest first."
              defaultCollapsed
              actions={
                <>
                  <CsvExportControl
                    label="audit trail"
                    filenameBase="aperture-audit-trail"
                    items={visibleAuditTrailRows}
                    getTimestamp={(item) => item.created_at}
                    columns={AUDIT_TRAIL_CSV_COLUMNS}
                  />
                  <button
                    className="secondary-button compact"
                    type="button"
                    data-tooltip="Reload the latest audit events from the platform API"
                    onClick={() => setAuditTrailRefreshToken((token) => token + 1)}
                  >
                    <RotateCcw size={14} /> Refresh
                  </button>
                </>
              }
            >
              <SectionScopeFilter
                label="Audit trail filter"
                scope={trailScope}
                onChange={setTrailScope}
                users={auditUserOptions}
                selectedCount={auditTrailRows.length}
                totalCount={(auditTrail ?? []).length}
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
                    <small>Transaction events load from the platform audit API when it is available.</small>
                  </span>
                </div>
              ) : auditTrail.length === 0 ? (
                <div className="audit-empty-state">
                  <ListChecks size={20} />
                  <span>
                    <strong>No audit events recorded yet</strong>
                    <small>Provider, model, key, user, and grant mutations will appear here as they happen.</small>
                  </span>
                </div>
              ) : auditTrailRows.length === 0 ? (
                <div className="audit-empty-state">
                  <ListChecks size={20} />
                  <span>
                    <strong>No audit events match this filter</strong>
                    <small>Adjust this section's user or date filter to review older or newer platform events.</small>
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
                    <div className="audit-trail-list scrollable-log-list" role="list" aria-label="Audit events">
                      {visibleAuditTrailRows.map((event) => {
                        const severity = auditEventSeverity(event);
                        return (
                          <div className="audit-row" role="listitem" key={event.id}>
                            <ListChecks size={17} />
                            <span>
                              <strong>{event.action_type || event.action}</strong>
                              <small>
                                {event.actor_name} ({formatAuditRole(event.actor_role)}) · {event.target_type}:{" "}
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
                            <time dateTime={event.created_at}>{formatAuditTimestamp(event.created_at)}</time>
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
          <AlertsConsole variant="owner" api={alertsApi} actorOptions={alertActorOptions} />
        </Tabs.Content>
      </Tabs.Root>
      {providerDeleteDialog && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => {
            if (!providerDeleteDialog.pending) setProviderDeleteDialog(null);
          }}
        >
          <section
            className="modal confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`Delete provider ${providerDeleteDialog.provider.name}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="key-reveal-header">
              <div>
                <span className="modal-kicker">Permanent deletion</span>
                <h2>Delete {providerDeleteDialog.provider.name}?</h2>
                <p>
                  This also deletes {providerDeleteDialog.modelCount} model
                  {providerDeleteDialog.modelCount === 1 ? "" : "s"} and{" "}
                  {providerDeleteDialog.keyCount} vaulted key
                  {providerDeleteDialog.keyCount === 1 ? "" : "s"}. It cannot be undone.
                </p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close delete provider dialog"
                data-tooltip="Close without deleting this provider"
                disabled={providerDeleteDialog.pending}
                onClick={() => setProviderDeleteDialog(null)}
              >
                <X size={17} />
              </button>
            </div>
            <label className="confirm-dialog-field">
              <span>Type {providerDeleteDialog.provider.name} to confirm</span>
              <input
                autoFocus
                value={providerDeleteDialog.typedName}
                aria-label="Confirm provider name"
                // Without an explicit tooltip the global helper builds one from
                // the label, and this label is already an instruction: it came
                // out as "Enter Type OpenAI to confirm in Delete provider
                // OpenAI." and covered the field it was describing.
                data-tooltip={`Retype ${providerDeleteDialog.provider.name} exactly to enable deletion`}
                placeholder={providerDeleteDialog.provider.name}
                disabled={providerDeleteDialog.pending}
                onChange={(event) =>
                  setProviderDeleteDialog((current) =>
                    current ? { ...current, typedName: event.target.value, error: null } : current,
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") void confirmProviderDelete();
                }}
              />
            </label>
            {providerDeleteDialog.error && (
              <p className="muted-note" role="alert">
                {providerDeleteDialog.error}
              </p>
            )}
            <div className="modal-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={providerDeleteDialog.pending}
                onClick={() => setProviderDeleteDialog(null)}
              >
                Cancel
              </button>
              <button
                className="secondary-button is-danger"
                type="button"
                aria-label={`Confirm delete provider ${providerDeleteDialog.provider.name}`}
                disabled={
                  providerDeleteDialog.pending ||
                  providerDeleteDialog.typedName.trim() !== providerDeleteDialog.provider.name
                }
                onClick={() => void confirmProviderDelete()}
              >
                <Trash2 size={15} />{" "}
                {providerDeleteDialog.pending ? "Deleting..." : "Delete provider"}
              </button>
            </div>
          </section>
        </div>
      )}

      {revealedKeyDialog && (
        <div
          className="modal-backdrop key-reveal-backdrop"
          role="presentation"
          onClick={() => setRevealedKeyDialog(null)}
        >
          <section
            className="modal key-reveal-popout"
            role="dialog"
            aria-modal="true"
            aria-label={`${revealedKeyDialog.key.name} revealed key`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="key-reveal-header">
              <div>
                <span className="modal-kicker">Vault reveal</span>
                <h2>{revealedKeyDialog.key.name}</h2>
                <p>
                  {revealedKeyDialog.key.provider_name} - {revealedKeyDialog.key.environment}
                </p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close revealed key"
                data-tooltip="Close this dialog and hide the revealed secret"
                onClick={() => setRevealedKeyDialog(null)}
              >
                <X size={17} />
              </button>
            </div>

            <div className="key-reveal-value" aria-label={`${revealedKeyDialog.key.name} revealed key value`}>
              {revealedKeyDialog.secretValue}
            </div>

            <div className="key-reveal-actions">
              <button
                className="primary-button"
                type="button"
                aria-label={`Copy ${revealedKeyDialog.key.name} key`}
                data-tooltip={`Copy the revealed ${revealedKeyDialog.key.name} secret to your clipboard`}
                onClick={copyRevealedKey}
              >
                <Copy size={15} /> {copyStatus === "copied" ? "Copied" : "Copy key"}
              </button>
              <button
                className="secondary-button"
                type="button"
                data-tooltip="Hide the revealed secret and return to the vault"
                onClick={() => setRevealedKeyDialog(null)}
              >
                Done
              </button>
            </div>
            {copyStatus === "failed" && (
              <p className="key-reveal-help">Clipboard access is unavailable. Select the key text to copy it manually.</p>
            )}
          </section>
        </div>
      )}
      {showDocumentation && (
        <LazyChunkBoundary label="The owner documentation">
          <Suspense fallback={<OwnerDocumentationLoadingModal onClose={() => setShowDocumentation(false)} />}>
            <OwnerDocumentationModal
              onClose={() => setShowDocumentation(false)}
              onOpenAdminDocumentation={onOpenAdminDocumentation}
              onOpenUserHelp={onOpenUserHelp}
            />
          </Suspense>
        </LazyChunkBoundary>
      )}
      {passwordTarget && (
        <PasswordResetDialog
          userName={passwordTarget.display_name}
          onClose={() => setPasswordTarget(null)}
          onSubmit={async (password, temporary) => {
            const resetUserPassword = platformActions?.resetUserPassword;
            if (!resetUserPassword) {
              throw new Error("The platform password API is not connected.");
            }
            await resetUserPassword(passwordTarget.id, { password, temporary });
            setActionStatus({
              tone: "success",
              message: `${passwordTarget.display_name}'s ${temporary ? "temporary " : ""}password was set through the admin API.`,
            });
          }}
        />
      )}
    </div>
  );
}

function OwnerDocumentationLoadingModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal owner-doc-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="owner-doc-loading-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-icon">
            <BookOpen size={22} />
          </span>
          <div>
            <h2 id="owner-doc-loading-title">Loading documentation videos</h2>
            <p>Preparing the owner training player.</p>
          </div>
        </div>
      </section>
    </div>
  );
}

function RoleBoundaryPanel({
  data,
  userDraft,
  setUserDraft,
  pendingAction,
  onCreateUser,
  onUpdateUserRole,
  onRemoveUser,
  onResetPassword,
}: {
  data: BootstrapData;
  userDraft: OwnerUserDraftState;
  setUserDraft: (updater: (current: OwnerUserDraftState) => OwnerUserDraftState) => void;
  pendingAction: string | null;
  onCreateUser: () => void;
  onUpdateUserRole: (user: PlatformUser, role: OwnerUserDraftState["role"]) => void;
  onRemoveUser: (user: PlatformUser) => void;
  onResetPassword: (user: PlatformUser) => void;
}) {
  const ownerManagedRoleOptions: Array<{ value: OwnerUserDraftState["role"]; label: string }> = [
    { value: "USER", label: "User" },
    { value: "TENANT_ADMIN", label: "Admin" },
    { value: "PLATFORM_OWNER", label: "Platform owner" },
  ];
  const managedUsers = data.users.filter((user) => user.role === "PLATFORM_OWNER" || user.role === "TENANT_ADMIN" || user.role === "USER");
  const activeOwnerCount = managedUsers.filter((user) => user.role === "PLATFORM_OWNER" && user.active).length;
  const activeAdminCount = managedUsers.filter((user) => user.role === "TENANT_ADMIN" && user.active).length;

  return (
    <Panel
      className="owner-control-panel"
      title={<><Shield size={18} /> Role Boundary</>}
      subtitle="Create owner, admin, and user accounts. Owners create owners, admins, and users; tenant-admin delegation stays policy-controlled."
      defaultCollapsed
    >
      <div className="owner-section owner-section-connected">
          <div className="inline-form owner-management-form">
            <label>
              Display name
              <input
                value={userDraft.display_name}
                onChange={(event) => setUserDraft((state) => ({ ...state, display_name: event.target.value }))}
                placeholder="New account name"
              />
            </label>
            <label>
              Email
              <input
                type="email"
                value={userDraft.email}
                onChange={(event) => setUserDraft((state) => ({ ...state, email: event.target.value }))}
                placeholder="name@company.com"
              />
            </label>
            <label>
              Role
              <SelectControl
                value={userDraft.role}
                onChange={(event) => setUserDraft((state) => ({ ...state, role: event.target.value as OwnerUserDraftState["role"] }))}
              >
                {ownerManagedRoleOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </SelectControl>
            </label>
            <button
              className="primary-button form-submit-button"
              type="button"
              data-tooltip="Create a new account with the selected role and platform access"
              onClick={onCreateUser}
              disabled={!userDraft.display_name.trim() || !userDraft.email.trim() || pendingAction === "owner-user:create"}
            >
              <UserPlus size={15} /> {pendingAction === "owner-user:create" ? "Creating..." : "Create account"}
            </button>
          </div>
          <div className="owner-user-list">
            {managedUsers.map((user) => {
              // Owners are also admins, so the last tenant admin is removable
              // while any active owner remains — only the owner floor holds.
              // Deleting an already-inactive admin never lowers the active count.
              const lastAdministrator =
                user.role === "TENANT_ADMIN" && user.active && activeAdminCount <= 1 && activeOwnerCount === 0;
              const roleChangeDisabled =
                !user.active ||
                pendingAction === `owner-user:${user.id}:role` ||
                (user.role === "PLATFORM_OWNER" && activeOwnerCount <= 1) ||
                lastAdministrator;
              const isCurrentUser = user.id === data.me.id;
              const removeDisabled =
                pendingAction === `owner-user:${user.id}:remove` ||
                isCurrentUser ||
                (user.role === "PLATFORM_OWNER" && (!user.active || activeOwnerCount <= 1)) ||
                lastAdministrator;
              const removeTitle = isCurrentUser
                ? "Accounts cannot remove themselves. Ask another owner."
                : user.role === "PLATFORM_OWNER"
                  ? !user.active
                    ? "Owner accounts cannot be deleted, and this owner is already deactivated"
                    : activeOwnerCount <= 1
                      ? "At least one active platform owner must remain, so this account cannot be removed"
                      : `Deactivate ${user.display_name}'s owner account after confirmation`
                  : lastAdministrator
                    ? "At least one active administrator must remain, so this account cannot be removed"
                    : `Permanently delete ${user.display_name}'s account after confirmation`;
              const ownerHasLocalPassword = user.role === "PLATFORM_OWNER" && user.auth_method === "local";
              const passwordDisabled = !user.active || isCurrentUser || ownerHasLocalPassword;
              const passwordTooltip = !user.active
                ? "Reactivate the account before setting its password"
                : isCurrentUser
                  ? "Change your own password from the account panel"
                  : ownerHasLocalPassword
                    ? "This owner already has a local password and changes it from the account panel"
                    : user.role === "PLATFORM_OWNER"
                      ? `Set the first temporary password for ${user.display_name}`
                      : `Set a new or temporary password for ${user.display_name}`;
              return (
                <div
                  className="owner-user-row"
                  key={user.id}
                  data-tooltip={userIdentityTooltip(user)}
                >
                  <UserAvatar user={user} className="mini-avatar" />
                  <span
                    className="owner-user-identity"
                    tabIndex={0}
                    data-tooltip={userIdentityTooltip(user)}
                  >
                    <strong>{user.display_name}</strong>
                    <small>{user.email}</small>
                    {user.firm_name && <small>{user.firm_name}</small>}
                  </span>
                  <SelectControl
                    aria-label={`Role for ${user.display_name}`}
                    value={user.role}
                    disabled={roleChangeDisabled}
                    onChange={(event) => onUpdateUserRole(user, event.target.value as OwnerUserDraftState["role"])}
                  >
                    {ownerManagedRoleOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </SelectControl>
                  <button
                    className="secondary-button"
                    type="button"
                    aria-label={`Set a password for ${user.display_name}`}
                    disabled={passwordDisabled}
                    data-tooltip={passwordTooltip}
                    onClick={() => onResetPassword(user)}
                  >
                    <KeyRound size={14} />
                  </button>
                  <button
                    className="secondary-button danger-lite-button"
                    type="button"
                    aria-label={`Remove ${user.display_name}`}
                    disabled={removeDisabled}
                    onClick={() => onRemoveUser(user)}
                    data-tooltip={removeTitle}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      <div className="policy-callout">
        <Lock size={15} />
        <span>
          <strong>Clear separation of duties.</strong> Platform owners manage provider secrets, owner accounts, admin delegation, SSO baselines, and platform branding.
        </span>
      </div>
    </Panel>
  );
}

const SSO_ISSUER_PRESETS: Array<{ label: string; issuer: string; hint: string }> = [
  {
    label: "Microsoft Entra ID",
    issuer: "https://login.microsoftonline.com/{tenant-id}/v2.0",
    hint: "Prefill the Entra issuer URL, then replace {tenant-id} with your directory ID",
  },
  {
    label: "Google Workspace",
    issuer: "https://accounts.google.com",
    hint: "Prefill the Google issuer; register the redirect URI in Google Cloud Console",
  },
  {
    label: "Okta",
    issuer: "https://{your-org}.okta.com",
    hint: "Prefill the Okta issuer template, then swap in your own org URL",
  },
];

function SsoRequirementsPanel({
  ssoDraft,
  setSsoDraft,
  onSaveSso,
  onTestSso,
  testResult,
  testing,
  brandName,
}: {
  ssoDraft: OwnerSsoDraftState;
  setSsoDraft: (updater: (current: OwnerSsoDraftState) => OwnerSsoDraftState) => void;
  onSaveSso: () => void;
  onTestSso: () => void;
  testResult: SsoTestResult | null;
  testing: boolean;
  brandName: string;
}) {
  const qrValidation = validateEnrollmentQrValue(ssoDraft.qrEnrollmentUri);
  const isOidc = ssoDraft.protocol === "OIDC";
  const redirectUri = ssoRedirectUri();
  const [copiedRedirect, setCopiedRedirect] = useState(false);

  const copyRedirectUri = () => {
    void navigator.clipboard?.writeText(redirectUri).then(() => {
      setCopiedRedirect(true);
      window.setTimeout(() => setCopiedRedirect(false), 2000);
    });
  };

  return (
    <Panel
      className="sso-requirements-panel"
      title={<><Mail size={18} /> Single Sign-On</>}
      subtitle="Live OIDC sign-in: users are redirected to your identity provider, and ID tokens are cryptographically verified before a session is issued."
      defaultCollapsed
    >
      <div className="owner-section owner-section-connected">
        <div className="owner-form-grid sso-readiness-grid">
          <label>
            Provider name
            <input value={ssoDraft.name} onChange={(event) => setSsoDraft((state) => ({ ...state, name: event.target.value }))} />
          </label>
          <label>
            Protocol
            <SelectControl
              value={ssoDraft.protocol}
              onChange={(event) => setSsoDraft((state) => ({ ...state, protocol: event.target.value as SsoConfig["protocol"] }))}
            >
              <option value="OIDC">OIDC (supported)</option>
              {/* SAML stays visible so a stored SAML config remains honest and
                  readable, but it cannot be chosen: the runtime does not
                  implement SAML login (auth options report it as deferred). */}
              <option value="SAML" disabled>
                SAML — Deferred, not a working sign-in path
              </option>
              <option value="SCIM">SCIM</option>
            </SelectControl>
            {ssoDraft.protocol === "SAML" && (
              <Pill tone="warning" icon={<ShieldAlert size={12} />}>
                Deferred — not a working sign-in path
              </Pill>
            )}
          </label>

          {isOidc && (
            <div className="sso-issuer-presets wide-field" role="group" aria-label="Issuer presets">
              {SSO_ISSUER_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className="chip-button"
                  data-tooltip={preset.hint}
                  onClick={() =>
                    setSsoDraft((state) => ({ ...state, name: preset.label, issuer: preset.issuer }))
                  }
                >
                  {preset.label}
                </button>
              ))}
            </div>
          )}

          <label className="wide-field">
            Issuer URL
            <input
              value={ssoDraft.issuer}
              onChange={(event) => setSsoDraft((state) => ({ ...state, issuer: event.target.value }))}
              placeholder="https://login.microsoftonline.com/{tenant-id}/v2.0"
            />
            <small className="field-hint">
              The discovery document is fetched from {"{issuer}"}/.well-known/openid-configuration.
            </small>
          </label>
          <label>
            Client ID
            <input value={ssoDraft.clientId} onChange={(event) => setSsoDraft((state) => ({ ...state, clientId: event.target.value }))} />
          </label>
          <label>
            Client secret {ssoDraft.protocol === "SCIM" ? "/ SCIM token" : ""}
            <input
              type="password"
              value={ssoDraft.clientSecret}
              onChange={(event) => setSsoDraft((state) => ({ ...state, clientSecret: event.target.value }))}
              placeholder="Saved server-side only"
            />
          </label>

          {isOidc ? (
            <div className="sso-redirect-uri wide-field">
              <span className="sso-redirect-label">Redirect URI to register with your identity provider</span>
              <span className="sso-redirect-value">
                <code>{redirectUri}</code>
                <button
                  type="button"
                  className="icon-button"
                  onClick={copyRedirectUri}
                  aria-label="Copy redirect URI"
                  data-tooltip="Copy this redirect URI to register with your identity provider"
                >
                  <Copy size={14} /> {copiedRedirect ? "Copied" : "Copy"}
                </button>
              </span>
            </div>
          ) : (
            <label>
              Redirect URI / ACS URL
              <input
                value={ssoDraft.redirectUrl}
                onChange={(event) => setSsoDraft((state) => ({ ...state, redirectUrl: event.target.value }))}
                placeholder="https://.../auth/callback"
              />
            </label>
          )}

          {!isOidc && (
            <>
              <label>
                Entity ID / audience
                <input
                  value={ssoDraft.entityId}
                  onChange={(event) => setSsoDraft((state) => ({ ...state, entityId: event.target.value }))}
                  placeholder="api://aperture-chat"
                />
              </label>
              <label>
                SAML login URL
                <input
                  value={ssoDraft.samlLoginUrl}
                  onChange={(event) => setSsoDraft((state) => ({ ...state, samlLoginUrl: event.target.value }))}
                  placeholder="https://login.microsoftonline.com/.../saml2"
                />
              </label>
              <label>
                SAML logout URL
                <input
                  value={ssoDraft.samlLogoutUrl}
                  onChange={(event) => setSsoDraft((state) => ({ ...state, samlLogoutUrl: event.target.value }))}
                  placeholder="https://login.microsoftonline.com/.../saml2"
                />
              </label>
              <label className="wide-field">
                SAML signing certificate
                <textarea
                  value={ssoDraft.samlCertificate}
                  onChange={(event) => setSsoDraft((state) => ({ ...state, samlCertificate: event.target.value }))}
                  placeholder="Paste the Base64 or PEM signing certificate from the identity provider."
                />
              </label>
              <p className="muted-note wide-field">
                <ShieldAlert size={14} /> SAML settings are stored for future support, but live sign-in currently
                requires an OIDC provider. Entra ID, Okta, and Google Workspace all support OIDC apps.
              </p>
              <label>
                SCIM base URL
                <input
                  value={ssoDraft.scimBaseUrl}
                  onChange={(event) => setSsoDraft((state) => ({ ...state, scimBaseUrl: event.target.value }))}
                  placeholder="https://.../scim/v2"
                />
              </label>
              <label>
                Duo API hostname
                <input
                  value={ssoDraft.duoApiHostname}
                  onChange={(event) => setSsoDraft((state) => ({ ...state, duoApiHostname: event.target.value }))}
                  placeholder="api-xxxxxxxx.duosecurity.com"
                />
              </label>
            </>
          )}

          <label className="wide-field">
            Allowed email domains
            <input
              value={ssoDraft.domains}
              onChange={(event) => setSsoDraft((state) => ({ ...state, domains: event.target.value }))}
              placeholder="example.com, example.co.uk"
            />
            <small className="field-hint">
              Only accounts on these domains can sign in through this provider. Comma-separated.
            </small>
          </label>
          <label>
            Group claim
            <input value={ssoDraft.groupClaim} onChange={(event) => setSsoDraft((state) => ({ ...state, groupClaim: event.target.value }))} />
            <small className="field-hint">
              Token claim listing the user's IdP groups. Map claim values to workspace groups in
              the Admin console's SSO tab; membership follows the claim on every sign-in.
            </small>
          </label>
          <label>
            Authenticator app
            <SelectControl
              value={ssoDraft.mfaProvider}
              onChange={(event) => setSsoDraft((state) => ({ ...state, mfaProvider: event.target.value }))}
            >
              <option value="Microsoft Authenticator">Microsoft Authenticator</option>
              <option value="Duo Mobile">Duo Mobile</option>
              <option value="Identity provider">Identity provider</option>
            </SelectControl>
          </label>
          <label>
            MFA methods enforced by provider
            <input
              value={ssoDraft.mfaMethods}
              onChange={(event) => setSsoDraft((state) => ({ ...state, mfaMethods: event.target.value }))}
              placeholder="Microsoft Authenticator, Duo Mobile"
            />
          </label>
          <label className="wide-field">
            QR enrollment URI
            <input
              value={ssoDraft.qrEnrollmentUri}
              onChange={(event) => setSsoDraft((state) => ({ ...state, qrEnrollmentUri: event.target.value }))}
              placeholder="otpauth://... or https://idp.example.com/mfa/enroll"
            />
          </label>
          <div className="sso-qr-panel wide-field">
            <span>
              <QrCode size={17} />
              <span>
                <strong>Authenticator enrollment QR</strong>
                <small>Duo and Microsoft Authenticator accept standards-based TOTP URIs or enrollment URLs issued by the identity provider.</small>
              </span>
            </span>
            {qrValidation.valid ? (
              <QRCodeSVG className="sso-qr-code" value={qrValidation.value} size={118} level="M" includeMargin />
            ) : (
              <div className="sso-qr-empty">{qrValidation.message}</div>
            )}
          </div>
          <div className="permission-row owner-toggle-row">
            <span>
              Provision new users on first sign-in (JIT)
              <small>New accounts on the allowed domains are created automatically with the USER role.</small>
            </span>
            <Toggle
              checked={ssoDraft.jitProvisioning}
              label="Provision new users on first sign-in"
              tooltip={
                ssoDraft.jitProvisioning
                  ? "Stop creating accounts automatically on first SSO sign-in"
                  : "Create accounts automatically when allowed users first sign in"
              }
              onChange={(next) => setSsoDraft((state) => ({ ...state, jitProvisioning: next }))}
            />
          </div>
          <div className="permission-row owner-toggle-row">
            <span>
              Require the platform authenticator after SSO
              <small>
                Off: your identity provider's own MFA (e.g. Conditional Access) is trusted as the
                second factor. On: users also enroll the platform authenticator app.
              </small>
            </span>
            <Toggle
              checked={ssoDraft.requirePlatformMfa}
              label="Require the platform authenticator after SSO"
              tooltip={
                ssoDraft.requirePlatformMfa
                  ? "Trust the identity provider's MFA and stop double-challenging SSO users"
                  : "Add the platform authenticator app on top of the identity provider's MFA"
              }
              onChange={(next) => setSsoDraft((state) => ({ ...state, requirePlatformMfa: next }))}
            />
          </div>
          <div className="permission-row owner-toggle-row">
            <span>
              Enforce SSO for these domains
              <small>Blocks local password sign-in for the allowed domains once the provider is ready.</small>
            </span>
            <Toggle
              checked={ssoDraft.enforced}
              label="Enforce SSO for these domains"
              tooltip={
                ssoDraft.enforced
                  ? "Allow local password sign-in again for the allowed domains"
                  : "Block local password sign-in so allowed domains must use SSO"
              }
              onChange={(next) => setSsoDraft((state) => ({ ...state, enforced: next }))}
            />
          </div>

          <div className="sso-action-row wide-field">
            <button
              className="secondary-button form-submit-button"
              type="button"
              data-tooltip="Save this SSO baseline so users can sign in through your provider"
              onClick={onSaveSso}
            >
              <Save size={15} /> Save SSO
            </button>
            <button
              className="secondary-button form-submit-button"
              type="button"
              onClick={onTestSso}
              disabled={testing || !isOidc}
              data-tooltip={
                isOidc
                  ? "Fetch the issuer's discovery document and signing keys to verify setup"
                  : "Switch the protocol to OIDC to run a live connection test"
              }
            >
              <DatabaseZap size={15} /> {testing ? "Testing…" : "Test connection"}
            </button>
          </div>

          {testResult && (
            <div
              className={`sso-test-result wide-field sso-test-${testResult.status}`}
              role="status"
            >
              <span className="sso-test-headline">
                {testResult.status === "ok" ? <ShieldCheck size={15} /> : <ShieldAlert size={15} />}
                {testResult.message}
              </span>
              {testResult.checks?.map((check) => (
                <span key={check.name} className={`sso-test-check sso-test-check-${check.status}`}>
                  <strong>{check.name}:</strong> {check.detail}
                </span>
              ))}
            </div>
          )}

          <p className="muted-note wide-field">
            Secrets are vaulted server-side and never returned to the browser. Sign-in redirects users to the
            identity provider; {brandName} validates the returned ID token (signature, issuer, audience, nonce,
            expiry) before creating a session.
          </p>
        </div>
      </div>
    </Panel>
  );
}

function BrandingColorField({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string;
  value: string;
  fallback: string;
  onChange: (next: string) => void;
}) {
  const trimmed = value.trim();
  const pickerValue = HEX_COLOR_INPUT_RE.test(trimmed) ? trimmed : fallback;
  return (
    <label>
      {label}
      <span className="branding-color-field">
        <input
          type="color"
          aria-label={`${label} picker`}
          value={pickerValue}
          onChange={(event) => onChange(event.target.value)}
        />
        <input
          aria-label={label}
          value={value}
          placeholder={fallback}
          maxLength={7}
          onChange={(event) => onChange(event.target.value)}
        />
      </span>
    </label>
  );
}

function PlatformBrandingPanel({
  brandingDraft,
  setBrandingDraft,
  onApplyBranding,
  onResetBranding,
  onUploadBrandingImage,
  status,
  onDismissStatus,
  saving,
  uploadPending,
}: {
  brandingDraft: BrandingDraftState;
  setBrandingDraft: (updater: (current: BrandingDraftState) => BrandingDraftState) => void;
  onApplyBranding: () => void;
  onResetBranding: () => void;
  onUploadBrandingImage: (event: ChangeEvent<HTMLInputElement>) => void;
  status: ActionStatus | null;
  onDismissStatus: () => void;
  saving: boolean;
  uploadPending: boolean;
}) {
  const previewName = brandingDraft.chat_brand_name || DEFAULT_BRANDING.chat_brand_name;
  const previewText = HEX_COLOR_INPUT_RE.test(brandingDraft.text_color.trim())
    ? brandingDraft.text_color.trim()
    : undefined;
  return (
    <Panel
      className="platform-branding-panel"
      title={<><Palette size={18} /> Platform Branding</>}
      subtitle="Set the product name, logo, icon, and theme colors used everywhere the brand appears."
      defaultCollapsed
    >
      <div className="owner-section owner-section-connected">
        <div className="branding-preview">
          <span className="brand-logo-preview">
            {brandingDraft.icon_url || brandingDraft.logo_url ? (
              <img src={brandingDraft.icon_url || brandingDraft.logo_url} alt="" />
            ) : (
              <ApertureMark size={24} />
            )}
          </span>
          <span>
            <strong style={previewText ? { color: previewText } : undefined}>{previewName}</strong>
            <small className="branding-preview-text" style={previewText ? { color: previewText } : undefined}>
              Interface text
            </small>
          </span>
        </div>
        <div className="owner-form-grid">
          <label>
            Platform name
            <input
              value={brandingDraft.chat_brand_name}
              maxLength={60}
              onChange={(event) => setBrandingDraft((state) => ({ ...state, chat_brand_name: event.target.value }))}
            />
          </label>
          <label>
            Platform logo URL
            <input
              aria-label="Platform logo URL"
              value={brandingDraft.logo_url}
              onChange={(event) => setBrandingDraft((state) => ({ ...state, logo_url: event.target.value }))}
              placeholder="https://..."
            />
          </label>
          <label>
            Browser icon URL
            <input
              value={brandingDraft.icon_url}
              onChange={(event) => setBrandingDraft((state) => ({ ...state, icon_url: event.target.value }))}
              placeholder="https://.../favicon.svg"
            />
          </label>
          <label>
            Platform domain
            <input
              aria-label="Platform domain"
              value={brandingDraft.custom_domain}
              maxLength={253}
              onChange={(event) => setBrandingDraft((state) => ({ ...state, custom_domain: event.target.value }))}
            />
            <small className="muted-note">
              Recorded for admins and the API. Point DNS and TLS at this deployment separately; saving here does not
              change routing.
            </small>
          </label>
          <div className="branding-theme-fields wide-field">
            <strong className="branding-theme-heading">Theme colors</strong>
            <small className="muted-note">
              Accent restyles buttons, toggles, links, and highlights in both light and dark mode. The gradient
              recolors the sidebar rail — pick darker stops so the light sidebar text stays readable. Text color
              applies to the light theme.
            </small>
            <div className="branding-theme-grid">
              <BrandingColorField
                label="Accent color"
                value={brandingDraft.primary_color}
                fallback={DEFAULT_BRANDING.primary_color}
                onChange={(next) => setBrandingDraft((state) => ({ ...state, primary_color: next }))}
              />
              <BrandingColorField
                label="Sidebar gradient start"
                value={brandingDraft.gradient_start}
                fallback="#063243"
                onChange={(next) => setBrandingDraft((state) => ({ ...state, gradient_start: next }))}
              />
              <BrandingColorField
                label="Sidebar gradient end"
                value={brandingDraft.gradient_end}
                fallback="#001f2b"
                onChange={(next) => setBrandingDraft((state) => ({ ...state, gradient_end: next }))}
              />
              <BrandingColorField
                label="Interface text color"
                value={brandingDraft.text_color}
                fallback="#0c1a26"
                onChange={(next) => setBrandingDraft((state) => ({ ...state, text_color: next }))}
              />
            </div>
            <small className="muted-note">
              Leave a color field empty to keep the platform default for that surface.
            </small>
          </div>
          {status && (
            <div className="secure-notice dismissible-notice branding-status-notice wide-field" role="status">
              {status.tone === "warning" ? <ShieldAlert size={18} /> : <ShieldCheck size={18} />}
              <span>{status.message}</span>
              <button
                className="notice-dismiss-button"
                type="button"
                aria-label="Dismiss branding status"
                data-tooltip="Clear this branding status message"
                onClick={onDismissStatus}
              >
                <X size={15} />
              </button>
            </div>
          )}
          <div className="branding-actions wide-field">
            <label
              className="secondary-button branding-file-button"
              data-tooltip="Choose a PNG to use as the platform logo and browser icon"
            >
              <Upload size={15} /> {uploadPending ? "Preparing…" : "Upload PNG"}
              <input type="file" accept="image/png" onChange={onUploadBrandingImage} disabled={uploadPending} />
            </label>
            <button
              className="secondary-button"
              type="button"
              data-tooltip="Restore the default Aperture Chat name, logo, color, and domain"
              onClick={onResetBranding}
              disabled={saving}
            >
              <RotateCcw size={15} /> Reset defaults
            </button>
          </div>
          <button
            className="primary-button form-submit-button"
            type="button"
            data-tooltip="Save this branding so it appears everywhere across the platform"
            onClick={onApplyBranding}
            disabled={saving}
            aria-busy={saving}
          >
            <Save size={15} /> {saving ? "Saving…" : "Apply branding"}
          </button>
        </div>
      </div>
    </Panel>
  );
}

function TenantPolicyPanel({
  policies,
  pendingAction,
  onPolicyChange,
}: {
  policies: TenantPolicyState;
  pendingAction: string | null;
  onPolicyChange: (key: keyof TenantPolicyState, next: boolean) => void;
}) {
  return (
    <Panel
      className="tenant-policy-panel"
      title={<><Lock size={18} /> Policy Controls</>}
      subtitle="Organization-level enforcement for admins, users, SSO, and agent creation."
      defaultCollapsed
    >
      <div className="policy-toggle-stack">
        <div className="permission-row policy-toggle-row">
          <span>
            <strong>Only owners can create platform owners</strong>
            <small>Always enforced by the platform: platform-owner accounts can only be created or promoted by another owner.</small>
          </span>
          <Pill tone="success">Always on</Pill>
        </div>
        <PolicyToggleRow
          title="Downstream API access"
          detail={
            policies.downstreamApiEnabled
              ? "Owners and tenant admins can create personal pass-through keys now. Standard users still require an administrator-managed Can use API grant."
              : "Personal pass-through keys are disabled platform-wide. Existing keys remain stored but cannot authenticate, and admins cannot grant new user access."
          }
          checked={policies.downstreamApiEnabled}
          disabled={pendingAction === "policy:downstreamApiEnabled"}
          label="Downstream API access"
          onChange={(next) => onPolicyChange("downstreamApiEnabled", next)}
        />
        <PolicyToggleRow
          title="Tenant admins can create admins"
          detail={
            policies.tenantAdminsCanCreateAdmins
              ? "Tenant admins may create and manage other tenant admins inside this tenant; platform-owner creation remains owner-only."
              : "Tenant admins can create standard users only. Owner approval is required for admin or platform-owner creation."
          }
          checked={policies.tenantAdminsCanCreateAdmins}
          disabled={pendingAction === "policy:tenantAdminsCanCreateAdmins"}
          label="Tenant admins can create admins"
          onChange={(next) => onPolicyChange("tenantAdminsCanCreateAdmins", next)}
        />
        <PolicyToggleRow
          title="Require SSO for admins"
          detail={
            policies.requireSsoForAdmins
              ? "Password fallback is rejected for admin-role accounts; SSO is required."
              : "Admin accounts can use platform credentials only when explicitly provisioned. Turn on to require the configured identity provider."
          }
          checked={policies.requireSsoForAdmins}
          disabled={pendingAction === "policy:requireSsoForAdmins"}
          label="Require SSO for admins"
          onChange={(next) => onPolicyChange("requireSsoForAdmins", next)}
        />
        <PolicyToggleRow
          title="Tenant admins can manage SSO mappings"
          detail={
            policies.tenantAdminsCanManageSso
              ? "Tenant admins can create and update SSO configurations (secrets stay vaulted)."
              : "SSO configuration changes are rejected for tenant admins; only platform owners may change them."
          }
          checked={policies.tenantAdminsCanManageSso}
          disabled={pendingAction === "policy:tenantAdminsCanManageSso"}
          label="Tenant admins can manage SSO mappings"
          onChange={(next) => onPolicyChange("tenantAdminsCanManageSso", next)}
        />
        <PolicyToggleRow
          title="Default group for enabled models"
          detail={
            policies.defaultUserGroupEnabled
              ? "Newly enabled models automatically include the protected Default Users group. Admins can still remove that group from individual models."
              : "Newly enabled models do not automatically include Default Users. Admins must grant groups per model."
          }
          checked={policies.defaultUserGroupEnabled}
          disabled={pendingAction === "policy:defaultUserGroupEnabled"}
          label="Default group for enabled models"
          onChange={(next) => onPolicyChange("defaultUserGroupEnabled", next)}
        />
        <PolicyToggleRow
          title="Users can build their own agents"
          detail={
            policies.usersCanCreateModels
              ? "Users with the Can build agents group permission create and edit private agent profiles from owner-approved models. Publishing to the organization, group sharing, and platform enablement stay admin-only."
              : "Only tenant admins and platform owners can create or edit agent profiles. Turn on to let admins grant Can build agents to specific groups."
          }
          checked={policies.usersCanCreateModels}
          disabled={pendingAction === "policy:usersCanCreateModels"}
          label="Users can build their own agents"
          onChange={(next) => onPolicyChange("usersCanCreateModels", next)}
        />
        <PolicyToggleRow
          title="Personalization memory"
          detail={
            policies.memoryEnabled
              ? "Tenant admins may switch memory on for their organization. Each user's memories stay private to them; admins and owners see counts and can purge, never content."
              : "Memory is off everywhere and no personal context is stored or injected. Tenant admins cannot enable it while this is off."
          }
          checked={policies.memoryEnabled}
          disabled={pendingAction === "policy:memoryEnabled"}
          label="Personalization memory"
          onChange={(next) => onPolicyChange("memoryEnabled", next)}
        />
      </div>
      <div className="policy-callout">
        <Lock size={15} />
        <span>Active policies define the organization ceiling. Tenant admins can only operate inside these boundaries.</span>
      </div>
    </Panel>
  );
}

function ElasticPanel({ elasticStatus }: { elasticStatus: ElasticStatus | null }) {
  const configured = Boolean(elasticStatus?.configured);
  return (
    <Panel
      className="elastic-settings-panel"
      title={<><DatabaseZap size={18} /> Elastic Analytics</>}
      subtitle="Optional export of platform analytics and audit events to your Elastic cluster."
      defaultCollapsed
    >
      <div className="elastic-card">
        <DatabaseZap size={26} />
        <div>
          <strong>{configured ? "Configured from backend environment" : "Not configured"}</strong>
          <span>
            {elasticStatus?.message ??
              "Elastic analytics export is not configured. Set APERTURE_ELASTIC_URL and APERTURE_ELASTIC_API_KEY to enable it."}
          </span>
        </div>
      </div>
      <p className="muted-note">
        Export is configured from the backend environment so the API key never
        passes through a browser. Set <code>APERTURE_ELASTIC_URL</code> (or
        <code>APERTURE_ELASTIC_CLOUD_ID</code>) and{" "}
        <code>APERTURE_ELASTIC_API_KEY</code>, then restart the API. Buffered
        events below are delivered once the cluster is reachable.
      </p>
      <dl className="meta-list">
        <div>
          <dt>Buffered events</dt>
          <dd>{elasticStatus?.eventsBuffered ?? 0}</dd>
        </div>
        <div>
          <dt>Export status</dt>
          <dd>{elasticStatus ? (configured ? "Ready to export" : "Not connected") : "Status unavailable"}</dd>
        </div>
      </dl>
    </Panel>
  );
}

function PolicyToggleRow({
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
  disabled?: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="permission-row policy-toggle-row">
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <Toggle
        checked={checked}
        disabled={disabled}
        label={label}
        tooltip={`Turn ${checked ? "off" : "on"} the "${title}" policy for the whole platform`}
        onChange={onChange}
      />
    </div>
  );
}

function emptyModelEditDraft(): ModelEditDraftState {
  return {
    name: "",
    upstream_model_id: "",
    notes: "",
    context_window: "",
    system_prompt: "",
    meta_prompt: "",
  };
}

function modelEditDraftFromModel(model: ModelConfig): ModelEditDraftState {
  return {
    name: model.name,
    upstream_model_id: model.upstream_model_id ?? model.name,
    notes: model.notes ?? "",
    context_window: model.context_window ? String(model.context_window) : "",
    system_prompt: model.system_prompt ?? "",
    meta_prompt: model.meta_prompt ?? "",
  };
}

function platformAuditSummary(
  data: BootstrapData,
  securityAlerts: SecurityAlert[],
  auditTrailRows: AuditEvent[],
): AuditSummaryItem[] {
  const criticalEventRecords = auditTrailRows.filter((event) => auditEventSeverity(event) === "critical");
  const enabledModelRecords = data.models.filter((model) => model.platform_enabled);
  const disabledModelRecords = data.models.filter((model) => !model.platform_enabled);
  const connectedProviderRecords = data.providers.filter((provider) => provider.connected);
  const disconnectedProviderRecords = data.providers.filter((provider) => !provider.connected);
  const enabledConnectorRecords = data.connectors.filter((connector) => connector.platform_enabled);
  const disabledConnectorRecords = data.connectors.filter((connector) => !connector.platform_enabled);
  const pendingApprovalRecords = data.agentRuns.flatMap((run) =>
    run.approvals
      .filter((approval) => approval.status === "Pending")
      .map((approval) => ({ run, approval })),
  );
  const expiredKeyRecords = data.providerKeys.filter((key) => providerKeyEffectiveStatus(key) === "Expired");
  const connectorIssueRecords = data.connectors.filter((connector) => connector.auth_status === "error");
  const unscopedModelRecords = data.models.filter((model) => model.platform_enabled && model.group_ids.length === 0);
  const privilegedOwnerRecords = data.users.filter((user) => user.active && user.role === "PLATFORM_OWNER");
  const staleProviderRecords = data.providers.filter((provider) => provider.connected && provider.last_sync === "Not synced");
  const promptWatchlistRecords = securityAlerts.filter((alert) => !alert.acknowledged);
  const providersMissingActiveKeys = connectedProviderRecords.filter((provider) => !providerHasActiveKey(data.providerKeys, provider.id));
  const modelNamesById = new Map(data.models.map((model) => [model.id, model.name]));
  const enabledModels = enabledModelRecords.length;
  const connectedProviders = connectedProviderRecords.length;
  const enabledConnectors = enabledConnectorRecords.length;
  const pendingApprovals = pendingApprovalRecords.length;
  const expiredKeys = expiredKeyRecords.length;
  const connectorIssues = connectorIssueRecords.length;
  const unscopedModels = unscopedModelRecords.length;
  const privilegedOwners = privilegedOwnerRecords.length;
  const staleProviders = staleProviderRecords.length;
  const promptWatchlist = promptWatchlistRecords.length;
  return [
    {
      label: "Critical events",
      value: String(criticalEventRecords.length),
      detail: "high-severity audit events",
      issue: criticalEventRecords.length > 0,
      description: "Critical-severity audit events in the currently loaded owner audit range.",
      sections: [
        {
          label: "Critical audit events",
          emptyText: "No critical-severity audit events are present in this snapshot.",
          items: criticalEventRecords.map((event) => ({
            label: event.action_type || event.action,
            detail: `${event.actor_name || event.actor_id} · ${event.target_name || event.target || "No target"} · ${formatAuditTimestamp(event.created_at)}${event.detail ? ` · ${event.detail}` : ""}`,
          })),
        },
      ],
    },
    {
      label: "Provider posture",
      value: `${connectedProviders}/${data.providers.length}`,
      detail: "provider connections active",
      issue: data.providers.length > 0 && connectedProviders < data.providers.length,
      description: "Provider posture compares every registered provider with the connections currently available to the platform.",
      sections: [
        {
          label: "Disconnected providers",
          emptyText: "Every registered provider is connected.",
          items: disconnectedProviderRecords.map((provider) => ({
            label: provider.name,
            detail: `${provider.kind} · ${provider.region} · ${provider.status_message || "Connection inactive"}`,
          })),
        },
        {
          label: "Connected providers",
          emptyText: "No providers are currently connected.",
          items: connectedProviderRecords.map((provider) => ({
            label: provider.name,
            detail: `${provider.kind} · ${provider.region} · last sync ${provider.last_sync}`,
          })),
        },
      ],
    },
    {
      label: "Model ceiling",
      value: `${enabledModels}/${data.models.length}`,
      detail: "models enabled for tenant access",
      issue: data.models.length > 0 && enabledModels === 0,
      description: "Model ceiling shows which synchronized models the platform currently permits tenants to use.",
      sections: [
        {
          label: "Enabled models",
          emptyText: "No models are enabled for tenant access.",
          items: enabledModelRecords.map((model) => ({
            label: model.name,
            detail: `${model.provider_name || model.provider_id} · ${model.group_ids.length} group limit${model.group_ids.length === 1 ? "" : "s"}`,
          })),
        },
        {
          label: "Disabled models",
          emptyText: "No synchronized models are disabled.",
          items: disabledModelRecords.map((model) => ({
            label: model.name,
            detail: `${model.provider_name || model.provider_id} · unavailable to tenants`,
          })),
        },
      ],
    },
    {
      label: "Vault metadata",
      value: String(data.providerKeys.length),
      detail: "masked provider keys tracked",
      issue: data.providers.some((provider) => provider.connected) && data.providerKeys.length === 0,
      description: "Vault metadata audits masked key records only; secret values are never included in this investigation.",
      sections: [
        {
          label: "Tracked key metadata",
          emptyText: "No masked provider-key records are tracked.",
          items: data.providerKeys.map((key) => ({
            label: key.name,
            detail: `${key.provider_name} · ${key.environment} · ${key.status} · ${key.masked_value} · expires ${key.expires}`,
          })),
        },
        {
          label: "Connected providers missing an active key",
          emptyText: "Every connected provider has an active tracked key.",
          items: providersMissingActiveKeys.map((provider) => ({
            label: provider.name,
            detail: "Connected provider with no active key metadata.",
          })),
        },
      ],
    },
    {
      label: "Approvals",
      value: String(pendingApprovals),
      detail: "agent actions awaiting review",
      issue: pendingApprovals > 0,
      description: "Pending approval gates raised by agent runs before a protected action can continue.",
      sections: [
        {
          label: "Pending approvals",
          emptyText: "No agent actions are currently waiting for owner approval.",
          items: pendingApprovalRecords.map(({ run, approval }) => ({
            label: approval.title,
            detail: `${run.name} · requested by ${approval.requested_by} · ${formatAuditTimestamp(approval.requested_at)}`,
          })),
        },
      ],
    },
    {
      label: "Connectors",
      value: `${enabledConnectors}/${data.connectors.length}`,
      detail: "platform-enabled connectors",
      issue: false,
      description: "Connector posture shows which catalog connectors are available for tenant configuration at the platform layer.",
      sections: [
        {
          label: "Platform-enabled connectors",
          emptyText: "No connectors are enabled at the platform layer.",
          items: enabledConnectorRecords.map((connector) => ({
            label: connector.name,
            detail: `${connector.category} · tenant ${connector.tenant_enabled ? "enabled" : "disabled"} · ${connector.auth_status || "status unavailable"}`,
          })),
        },
        {
          label: "Not platform-enabled",
          emptyText: "Every catalog connector is platform-enabled.",
          items: disabledConnectorRecords.map((connector) => ({
            label: connector.name,
            detail: `${connector.category} · unavailable for tenant configuration`,
          })),
        },
      ],
    },
    {
      label: "Expired keys",
      value: String(expiredKeys),
      detail: "provider secrets needing replacement",
      issue: expiredKeys > 0,
      description: "Provider key metadata whose effective status indicates that the secret must be replaced. Secret values are never included.",
      sections: [
        {
          label: "Expired key metadata",
          emptyText: "No tracked provider keys are expired.",
          items: expiredKeyRecords.map((key) => ({
            label: key.name,
            detail: `${key.provider_name} · ${key.environment} · expired ${key.expires} · ${key.masked_value}`,
          })),
        },
      ],
    },
    {
      label: "Connector issues",
      value: String(connectorIssues),
      detail: "connectors reporting auth errors",
      issue: connectorIssues > 0,
      description: "Platform connectors whose current authentication state is reporting an error.",
      sections: [
        {
          label: "Authentication errors",
          emptyText: "No platform connectors are currently reporting authentication errors.",
          items: connectorIssueRecords.map((connector) => ({
            label: connector.name,
            detail: `${connector.category} · ${connector.description || "Authentication error"} · last sync ${connector.last_sync || "not recorded"}`,
          })),
        },
      ],
    },
    {
      label: "Unscoped models",
      value: String(unscopedModels),
      detail: "enabled models without group limits",
      issue: unscopedModels > 0,
      description: "Enabled models with no group boundary attached; these models can be available more broadly than intended.",
      sections: [
        {
          label: "Models without group limits",
          emptyText: "Every enabled model has a group limit, or no enabled models are present.",
          items: unscopedModelRecords.map((model) => ({
            label: model.name,
            detail: `${model.provider_name || model.provider_id} · enabled · 0 group limits`,
          })),
        },
      ],
    },
    {
      label: "Privileged owners",
      value: String(privilegedOwners),
      detail: "active platform-owner accounts",
      issue: privilegedOwners === 0 || privilegedOwners > 2,
      description: "Active accounts holding the platform-owner role and its organization-wide privileges.",
      sections: [
        {
          label: "Active platform owners",
          emptyText: "No active platform-owner accounts were found; at least one owner should remain active.",
          items: privilegedOwnerRecords.map((user) => ({
            label: user.display_name || user.email,
            detail: `${user.email} · ${user.auth_method || "authentication method not recorded"} · last active ${user.last_active}`,
          })),
        },
      ],
    },
    {
      label: "Stale syncs",
      value: String(staleProviders),
      detail: "connected providers not synced yet",
      issue: staleProviders > 0,
      description: "Connected providers that have not yet recorded a successful model or metadata synchronization.",
      sections: [
        {
          label: "Providers awaiting first sync",
          emptyText: "All connected providers have recorded sync metadata.",
          items: staleProviderRecords.map((provider) => ({
            label: provider.name,
            detail: `${provider.kind} · ${provider.region} · ${provider.status_message || "No sync recorded"}`,
          })),
        },
      ],
    },
    {
      label: "Prompt watchlist",
      value: String(promptWatchlist),
      detail: "active DLP or misuse alerts",
      issue: promptWatchlist > 0,
      description: "Unacknowledged DLP and behavior alerts raised from saved chat or drafting activity.",
      sections: [
        {
          label: "Active prompt alerts",
          emptyText: "No unacknowledged DLP or misuse alerts are active.",
          items: promptWatchlistRecords.map((alert) => ({
            label: alert.rule_label,
            detail: `${alert.user_name || alert.user_id} · ${modelNamesById.get(alert.model_id) ?? alert.model_id} · ${alert.severity} ${alert.category} · ${alert.surface} · ${formatSecurityAlertTimestamp(alert.created_at)}${alert.snippet ? ` · ${alert.snippet}` : ""}`,
          })),
        },
      ],
    },
  ];
}

function platformRuntimeAuditRows(events: AuditEvent[]): RuntimeAuditRow[] {
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
        detail: `${event.actor_name || event.actor_id} · ${provider}${messageCount ? ` · ${messageCount} message${messageCount === 1 ? "" : "s"}` : ""}`,
        metadata: `${target}${clientStartedAt ? ` · client started ${formatAuditTimestamp(clientStartedAt)}` : ""}`,
        executedAt,
        actorId: event.actor_id,
        actorName: event.actor_name || event.actor_id,
      };
    })
    .filter((item): item is RuntimeAuditRow => item !== null);
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

function platformAuditRows(data: BootstrapData) {
  const rows = [
    {
      id: "models",
      title: "Model availability reviewed",
      detail: `${data.models.filter((model) => model.platform_enabled).length} enabled models; ${
        data.models.filter((model) => !model.platform_enabled).length
      } disabled models.`,
      time: "Current snapshot",
    },
    {
      id: "providers",
      title: "Provider catalog status",
      detail: `${data.providers.length} providers registered; ${data.providers.filter((provider) => provider.connected).length} connected.`,
      time: mostRecentProviderSync(data.providers),
    },
    {
      id: "keys",
      title: "Provider key vault metadata",
      detail: `${data.providerKeys.length} masked keys available to platform owners; reveal actions remain explicit.`,
      time: "Current snapshot",
    },
    {
      id: "connectors",
      title: "Connector availability",
      detail: `${data.connectors.filter((connector) => connector.platform_enabled).length} platform-enabled connectors and ${
        data.connectors.filter((connector) => connector.auth_status === "error").length
      } connector errors.`,
      time: "Current snapshot",
    },
  ];

  const agentRun = data.agentRuns[0];
  if (agentRun) {
    rows.push({
      id: `agent-${agentRun.id}`,
      title: "Agent approval activity",
      detail: `${agentRun.name}: ${agentRun.status}. ${agentRun.approvals.filter((approval) => approval.status === "Pending").length} pending approval.`,
      time: agentRun.started_at,
    });
  }

  return rows;
}

function mostRecentProviderSync(providers: Provider[]): string {
  const synced = providers.find((provider) => provider.last_sync && provider.last_sync !== "Not synced");
  return synced?.last_sync ?? "Not synced";
}

function recalculateProviderCounts(providers: Provider[], models: ModelConfig[]) {
  return providers.map((provider) => {
    const providerModels = models.filter((model) => model.provider_id === provider.id);
    return {
      ...provider,
      model_count: providerModels.length,
      enabled_model_count: providerModels.filter((model) => model.platform_enabled).length,
    };
  });
}

function updateModels(current: BootstrapData, models: ModelConfig[]): BootstrapData {
  return {
    ...current,
    models,
    providers: recalculateProviderCounts(current.providers, models),
  };
}

function withDefaultGroupGrant(data: BootstrapData, groupIds: string[]): string[] {
  const defaultGroup = data.groups.find((group) => group.default_group);
  if (!defaultGroup) return groupIds;
  return Array.from(new Set([...groupIds, defaultGroup.id]));
}

function applyProviderModelSync(current: BootstrapData, result: ProviderModelSyncResult): BootstrapData {
  const providerModels = result.models;
  const nextModels = [
    ...current.models.filter((model) => model.provider_id !== result.provider.id),
    ...providerModels,
  ];
  const providers = current.providers.some((provider) => provider.id === result.provider.id)
    ? current.providers.map((provider) => (provider.id === result.provider.id ? result.provider : provider))
    : [...current.providers, result.provider];
  return {
    ...current,
    models: nextModels,
    providers: recalculateProviderCounts(providers, nextModels),
  };
}

function updateProvider(current: BootstrapData, providerId: string, patch: Partial<Provider>): BootstrapData {
  const nextProviderName = typeof patch.name === "string" && patch.name.trim() ? patch.name : null;
  return {
    ...current,
    providers: current.providers.map((provider) => (provider.id === providerId ? { ...provider, ...patch } : provider)),
    models: nextProviderName
      ? current.models.map((model) =>
          model.provider_id === providerId ? { ...model, provider_name: nextProviderName } : model,
        )
      : current.models,
    providerKeys: nextProviderName
      ? current.providerKeys.map((key) =>
          key.provider_id === providerId ? { ...key, provider_name: nextProviderName } : key,
        )
      : current.providerKeys,
  };
}

function updateProviderKey(current: BootstrapData, keyId: string, patch: Partial<ProviderKey>): BootstrapData {
  return {
    ...current,
    providerKeys: current.providerKeys.map((key) => (key.id === keyId ? { ...key, ...patch } : key)),
  };
}

function removeProviderKey(current: BootstrapData, keyId: string): BootstrapData {
  return {
    ...current,
    providerKeys: current.providerKeys.filter((key) => key.id !== keyId),
  };
}

function providerHasActiveKey(keys: ProviderKey[], providerId: string): boolean {
  return keys.some((key) => key.provider_id === providerId && providerKeyEffectiveStatus(key).toLowerCase() === "active");
}

function providerKeyEffectiveStatus(key: ProviderKey): string {
  return providerKeyIsExpired(key.expires) ? "Expired" : key.status;
}

function providerKeyIsExpired(expires: string): boolean {
  const normalized = expires.trim().toLowerCase();
  if (!normalized || normalized === "not set" || normalized === "never") return false;
  const parsed = Date.parse(expires);
  if (Number.isNaN(parsed)) return false;
  const expiresAt = new Date(parsed);
  expiresAt.setHours(23, 59, 59, 999);
  return expiresAt.getTime() < Date.now();
}

function syncSummary(result: ProviderModelSyncResult): string {
  const changes = [
    result.imported_count ? `${result.imported_count} added` : "",
    result.updated_count ? `${result.updated_count} refreshed` : "",
    result.removed_count ? `${result.removed_count} removed` : "",
  ].filter(Boolean);
  return changes.length ? `${result.message} ${changes.join(", ")}.` : result.message;
}

function providerAuthMetadata(draft: ProviderDraftState): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  const headerName = draft.header_name.trim();
  if (headerName) metadata.header_name = headerName;
  const apiVersion = draft.api_version.trim();
  if (apiVersion) metadata.api_version = apiVersion;
  const deploymentId = draft.deployment_id.trim();
  if (deploymentId) metadata.deployment_id = deploymentId;
  const catalogScope = openRouterCatalogScopeFromDraft(draft);
  if (catalogScope) metadata.catalog_scope = catalogScope;
  if (draft.kind === "amazon-bedrock") {
    metadata.adapter_status = "pending";
    metadata.runtime_note = "Bedrock provider metadata is stored; gateway invocation requires AWS SigV4 adapter work.";
  }
  return metadata;
}

function providerConnectionAuthMetadata(draft: ProviderConnectionDraftState): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  const headerName = draft.header_name.trim();
  if (headerName) metadata.header_name = headerName;
  const apiVersion = draft.api_version.trim();
  if (apiVersion) metadata.api_version = apiVersion;
  const deploymentId = draft.deployment_id.trim();
  if (deploymentId) metadata.deployment_id = deploymentId;
  const catalogScope = openRouterCatalogScopeFromDraft(draft);
  if (catalogScope) metadata.catalog_scope = catalogScope;
  if (draft.kind === "amazon-bedrock") {
    metadata.adapter_status = "pending";
    metadata.runtime_note = "Bedrock provider metadata is stored; gateway invocation requires AWS SigV4 adapter work.";
  }
  return metadata;
}

function providerConnectionDraftFromProvider(provider: Provider): ProviderConnectionDraftState {
  const metadata = provider.auth_metadata ?? {};
  return {
    name: provider.name,
    kind: provider.kind,
    region: provider.region,
    base_url: provider.base_url ?? "",
    auth_type: provider.auth_type ?? defaultAuthTypeForKind(provider.kind),
    header_name: String(metadata.header_name ?? defaultHeaderForKind(provider.kind)),
    api_version: String(metadata.api_version ?? ""),
    deployment_id: String(metadata.deployment_id ?? ""),
    catalog_scope: openRouterCatalogScopeFromProvider(provider),
  };
}

function openRouterCatalogScopeFromDraft(draft: Pick<ProviderDraftState, "kind" | "catalog_scope">): string {
  if (draft.kind.trim().toLowerCase() !== "openrouter") return "";
  return normalizeOpenRouterCatalogScope(draft.catalog_scope);
}

function openRouterCatalogScopeFromProvider(provider: Provider): string {
  if (provider.kind.trim().toLowerCase() !== "openrouter") return "";
  return normalizeOpenRouterCatalogScope(String(provider.auth_metadata?.catalog_scope ?? ""));
}

function normalizeOpenRouterCatalogScope(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized === "user" ? "user" : "zdr";
}

function openRouterCatalogScopeLabel(value: string): string {
  return value === "user" ? "Key-scoped" : "ZDR";
}

function defaultAuthTypeForKind(kind: string): string {
  const normalized = kind.trim().toLowerCase();
  if (normalized === "azure-openai" || normalized === "azure-foundry" || normalized === "anthropic") return "api-key";
  if (normalized === "amazon-bedrock") return "managed-identity";
  return "bearer";
}

function defaultHeaderForKind(kind: string): string {
  const normalized = kind.trim().toLowerCase();
  if (normalized === "azure-openai" || normalized === "azure-foundry") return "api-key";
  if (normalized === "anthropic") return "x-api-key";
  if (normalized === "amazon-bedrock") return "";
  return "Authorization";
}

// Mirrors DEFAULT_PROVIDER_BASE_URLS in services/api model_gateway so the
// console pre-fills the same endpoint the runtime would default to.
const DEFAULT_PROVIDER_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  openrouter: "https://openrouter.ai/api/v1",
  "open-webui": "https://open-webui.example.com/api",
  "azure-openai": "https://{resource}.openai.azure.com/openai",
  "azure-foundry": "https://{resource}.services.ai.azure.com/models",
  gcp: "https://generativelanguage.googleapis.com/v1beta/openai",
  groq: "https://api.groq.com/openai/v1",
  xai: "https://api.x.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  perplexity: "https://api.perplexity.ai",
  cerebras: "https://api.cerebras.ai/v1",
  sambanova: "https://api.sambanova.ai/v1",
  moonshot: "https://api.moonshot.ai/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  cohere: "https://api.cohere.ai/compatibility/v1",
  ollama: "http://localhost:11434/v1",
};

function defaultBaseUrlForKind(kind: string, currentBaseUrl: string): string {
  if (currentBaseUrl.trim()) return currentBaseUrl;
  return DEFAULT_PROVIDER_BASE_URLS[kind.trim().toLowerCase()] ?? "";
}

function defaultCatalogScopeForKind(kind: string): string {
  return kind.trim().toLowerCase() === "openrouter" ? "zdr" : "";
}

function isRuntimeSupportedProviderKind(kind: string): boolean {
  return !RUNTIME_UNSUPPORTED_PROVIDER_KINDS.has(kind.trim().toLowerCase());
}

function mergeProviderRuntimeStatus(provider: Provider, fallback: Provider): Provider {
  return {
    ...fallback,
    ...provider,
    auth_metadata: provider.auth_metadata ?? fallback.auth_metadata,
    status_message: provider.status_message ?? fallback.status_message,
  };
}

function upsertProviderKey(keys: ProviderKey[], key: ProviderKey): ProviderKey[] {
  if (keys.some((item) => item.id === key.id)) return keys.map((item) => (item.id === key.id ? key : item));
  return [...keys, key];
}

function upsertPlatformUser(current: BootstrapData, user: PlatformUser): BootstrapData {
  return {
    ...current,
    users: upsertUserList(current.users, user),
    visibleUsers:
      user.role === "PLATFORM_OWNER"
        ? current.visibleUsers.filter((item) => item.id !== user.id)
        : upsertUserList(current.visibleUsers, user),
  };
}

function removePlatformUser(current: BootstrapData, userId: string): BootstrapData {
  return {
    ...current,
    users: current.users.filter((item) => item.id !== userId),
    visibleUsers: current.visibleUsers.filter((item) => item.id !== userId),
  };
}

function upsertUserList(users: PlatformUser[], user: PlatformUser): PlatformUser[] {
  if (users.some((item) => item.id === user.id)) {
    return users.map((item) => (item.id === user.id ? { ...item, ...user } : item));
  }
  return [...users, user];
}

function formatPromptRecordTimestamp(record: UserPromptRecord) {
  return formatAuditTimestamp(record.created_at_iso || record.created_at);
}

function formatSecurityAlertTimestamp(value: string) {
  return formatAuditTimestamp(value);
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

function securityAlertPillTone(alert: SecurityAlert): "warning" | "danger" | "info" {
  if (alert.severity.toLowerCase() === "high") return "danger";
  if (alert.category.toLowerCase() === "behavior") return "warning";
  return "info";
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
    const date = new Date(timestamp);
    const dateKey = date.toISOString().slice(0, 10);
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

function promptUsageTrendPoint(
  count: number,
  index: number,
  rows: Array<{ count: number }>,
) {
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
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "selected-user";
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
  const rows = items.map((item) =>
    columns.map((column) => csvEscape(column.value(item))).join(","),
  );
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

function formatAuditTimestamp(value: string) {
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

function formatAuditRole(role: string) {
  const labels: Record<string, string> = {
    PLATFORM_OWNER: "Platform Owner",
    TENANT_ADMIN: "Tenant Admin",
    POWER_USER: "Power User",
    AUDITOR: "Auditor",
    AGENT_APPROVER: "Agent Approver",
    USER: "User",
  };
  return labels[role] ?? role;
}

function providerSlugFromName(name: string) {
  const normalized = name.trim().toLowerCase();
  if (normalized.includes("entra") || normalized.includes("microsoft")) return "entra-id";
  if (normalized.includes("okta")) return "okta";
  if (normalized.includes("auth0")) return "auth0";
  if (normalized.includes("scim")) return "scim";
  return normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sso";
}

function formatUserRole(role: Role) {
  return formatAuditRole(role);
}

function toggleSelection(values: string[], value: string, checked: boolean): string[] {
  if (checked) return values.includes(value) ? values : [...values, value];
  return values.filter((item) => item !== value);
}

/** Header-cell filter for the model list: a small funnel toggle opening a
 * popover with either multi-select checkboxes (provider, model lab) or a
 * contains-text input (runtime routes, which are unique per model). */
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

function modelKnowledgeIds(model: ModelConfig): string[] {
  return model.knowledge_base_ids ?? model.knowledge_config_ids ?? [];
}

function modelToolIds(model: ModelConfig): string[] {
  return model.tool_ids ?? model.tool_config_ids ?? [];
}

function modelPromptLabel(model: ModelConfig): string {
  if (model.system_prompt && model.meta_prompt) return "System + meta";
  if (model.system_prompt) return "System";
  if (model.meta_prompt) return "Meta";
  return "Default";
}

function formatActionError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "unknown error";
}

/**
 * Budget failures keep the backend's exact detail and, for 429 rejections,
 * state the real Retry-After wait. No automatic retry ever happens here.
 */
function formatUsageBudgetError(error: unknown): string {
  if (error instanceof UsageBudgetRequestError) {
    const base =
      error.status === 429
        ? `The backend rejected the request with HTTP 429: ${error.message}`
        : error.message;
    if (error.retryAfterSeconds !== null) {
      return `${base} The backend accepts new work after ${formatRetryAfterSeconds(error.retryAfterSeconds)} (the active UTC reset boundary); nothing is retried automatically.`;
    }
    return base;
  }
  return formatActionError(error);
}

function formatRetryAfterSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatUtcTimestamp(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
}


type BudgetUnit = "tokens" | "usd";
type BudgetPeriod = "day" | "week" | "month";

const BUDGET_PERIOD_LABELS: Record<BudgetPeriod, string> = {
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
};

/** Single-tenant posture: the deployment IS the tenant, so the owner's
 * workspace ceiling pins to it without a tenant picker. */
function DeploymentBudgetPanel({ userId, tenantSlug }: { userId: string; tenantSlug: string }) {
  const [budget, setBudget] = useState<TenantUsageBudgetSnapshot | null>(null);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [limitDraft, setLimitDraft] = useState("");
  const [unitDraft, setUnitDraft] = useState<BudgetUnit>("tokens");
  const [periodDraft, setPeriodDraft] = useState<BudgetPeriod>("day");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBudgetError(null);
    getPlatformUsageBudget(userId, tenantSlug)
      .then((snapshot) => {
        if (cancelled) return;
        setBudget(snapshot);
        setLimitDraft(String(snapshot.limit_value));
        setUnitDraft(snapshot.budget_unit);
        setPeriodDraft(snapshot.budget_period);
      })
      .catch((error) => {
        if (!cancelled) setBudgetError(formatUsageBudgetError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [userId, tenantSlug]);

  async function saveLimit() {
    const parsed = Number(limitDraft.trim());
    if (!Number.isFinite(parsed) || parsed < 0) {
      setBudgetError("Enter a nonnegative budget amount (0 means unlimited).");
      return;
    }
    if (unitDraft === "tokens" && !Number.isInteger(parsed)) {
      setBudgetError("Token allowances must be entered as a whole number.");
      return;
    }
    if (unitDraft === "usd" && !/^\d+(?:\.\d{1,2})?$/.test(limitDraft.trim())) {
      setBudgetError("Dollar budgets may include up to two decimal places.");
      return;
    }
    setSaving(true);
    setBudgetError(null);
    setNotice(null);
    try {
      const snapshot = await updatePlatformUsageBudget(userId, tenantSlug, {
        budget_unit: unitDraft,
        budget_period: periodDraft,
        limit_value: parsed,
      });
      setBudget(snapshot);
      setLimitDraft(String(snapshot.limit_value));
      setUnitDraft(snapshot.budget_unit);
      setPeriodDraft(snapshot.budget_period);
      const periodLabel = BUDGET_PERIOD_LABELS[snapshot.budget_period].toLowerCase();
      setNotice(
        parsed === 0
          ? "Workspace ceiling saved as unlimited. Admin user and group allocations still apply."
          : snapshot.budget_unit === "usd"
            ? `Workspace ceiling saved at ${new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(parsed)} ${periodLabel}.`
            : `Workspace ceiling saved at ${parsed.toLocaleString()} tokens ${periodLabel}.`,
      );
    } catch (error) {
      setBudgetError(formatUsageBudgetError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel
      className="tenant-budget-panel"
      title="Workspace Usage Budget"
      subtitle="Set the workspace ceiling by tokens or provider-reported spend, then choose when it resets. Admins can add per-user and per-group token allocations below this policy."
      defaultCollapsed
    >
      {budgetError && (
        <p className="form-error" role="alert">
          {budgetError}
        </p>
      )}
      {budget ? (
        <div className="budget-editor">
          <div className="budget-control-grid">
            <label className="budget-field">
              <span>Budget measure</span>
              <SelectControl
                aria-label="Budget measure"
                value={unitDraft}
                onChange={(event) => setUnitDraft(event.target.value as BudgetUnit)}
              >
                <option value="tokens">Token allowance</option>
                <option value="usd">Dollar amount (USD)</option>
              </SelectControl>
              <small>
                {unitDraft === "tokens"
                  ? "Uses exact provider-reported token totals."
                  : "Uses exact provider-reported cost; unreported cost is shown separately."}
              </small>
            </label>
            <label className="budget-field">
              <span>Reset period</span>
              <SelectControl
                aria-label="Budget reset period"
                value={periodDraft}
                onChange={(event) => setPeriodDraft(event.target.value as BudgetPeriod)}
              >
                <option value="day">Every day</option>
                <option value="week">Every week</option>
                <option value="month">Every month</option>
              </SelectControl>
              <small>UTC calendar period; weeks begin Monday.</small>
            </label>
            <label className="budget-field budget-amount-field">
              <span>{unitDraft === "usd" ? "Dollar limit" : "Token limit"}</span>
              <div className="budget-amount-control">
                {unitDraft === "usd" && <span aria-hidden="true">$</span>}
                <input
                  aria-label={unitDraft === "usd" ? "Dollar budget limit" : "Token budget limit"}
                  inputMode={unitDraft === "usd" ? "decimal" : "numeric"}
                  placeholder="0"
                  value={limitDraft}
                  onChange={(event) => setLimitDraft(event.target.value)}
                />
                <span>{unitDraft === "usd" ? "USD" : "tokens"}</span>
              </div>
              <small>Enter 0 for an unlimited workspace ceiling.</small>
            </label>
          </div>
          <div className="budget-usage-card" aria-live="polite">
            <span>{BUDGET_PERIOD_LABELS[budget.budget_period]} usage</span>
            <strong>
              {budget.budget_unit === "usd"
                ? new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(budget.reported_cost_usd)
                : `${budget.reported_tokens.toLocaleString()} tokens`}
            </strong>
            <small>
              UTC {budget.period_start} – {budget.period_end} ·{" "}
              {budget.budget_unit === "usd"
                ? `${budget.cost_metered_completions.toLocaleString()} cost-reported · ${budget.cost_unmetered_completions.toLocaleString()} cost-unreported`
                : `${budget.metered_completions.toLocaleString()} token-reported · ${budget.unmetered_completions.toLocaleString()} token-unreported`}
            </small>
          </div>
          <button
            className="primary-button budget-save-button"
            type="button"
            data-tooltip="Save the workspace usage ceiling and reset period"
            disabled={saving}
            onClick={() => void saveLimit()}
          >
            {saving ? "Saving…" : "Save budget policy"}
          </button>
          {notice && <p className="form-hint" role="status">{notice}</p>}
        </div>
      ) : (
        !budgetError && <p className="form-hint">Loading the workspace budget…</p>
      )}
    </Panel>
  );
}
