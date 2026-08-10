import { sampleData } from "../../data/sampleData";
import {
  apiBase,
  authHeaders,
  readApiError,
  isRecord,
  ChatRequestError,
} from "./http";
import type {
  BootstrapData,
  BootstrapWireData,
  Connector,
  ConnectorConfigRecord,
  Group,
  KnowledgeBase,
  KnowledgeConfigRecord,
  ModelConfig,
  PlatformSettings,
  SsoConfig,
  SsoConfigRecord,
  ToolConfig,
  ToolConfigRecord,
} from "../types";

export async function loadBootstrap(userId: string): Promise<BootstrapData> {
  try {
    const response = await fetch(`${apiBase}/api/bootstrap`, {
      headers: authHeaders(userId),
    });
    if (!response.ok) {
      const message = await readApiError(response);
      if (response.status === 401 || response.status === 403 || !demoFallbackEnabled()) {
        throw new ChatRequestError(message, response.status);
      }
      throw new Error(message);
    }
    return normalizeBootstrap((await response.json()) as BootstrapWireData);
  } catch (error) {
    if (error instanceof ChatRequestError) throw error;
    if (!demoFallbackEnabled()) {
      throw new ChatRequestError("Could not load platform configuration. Check the API connection and sign in again.");
    }
    const fallbackUser = sampleData.users.find((user) => user.id === userId) ?? sampleData.me;
    // sampleData is authored in display shape already; running it through the
    // wire normalizer distorts it (mapModelConfigRecordToDisplay coerces any
    // model with a system prompt or attachments into a custom agent profile).
    return {
      ...sampleData,
      me: fallbackUser,
      providerKeys: fallbackUser.role === "PLATFORM_OWNER" ? sampleData.providerKeys : [],
      // Tenant-scoped user lists intentionally hide platform owners for every role.
      visibleUsers: sampleData.users.filter((user) => user.role !== "PLATFORM_OWNER"),
    };
  }
}

/** Whether the bundled sample workspace may stand in for API data. Dev and
 * demo builds only: production must never present the sample identity as a
 * signed-in account. */
export function demoFallbackEnabled() {
  return import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEMO_FALLBACK === "true";
}

export function mapConnectorConfigRecordToConnector(record: ConnectorConfigRecord, connector?: Connector): Connector {
  // "Configured" requires a stored credential; scopes or settings alone are
  // just metadata and must not claim a working connection.
  const authStatus = record.enabled ? (record.secret_set ? "configured" : "needs-credentials") : "not-configured";
  return {
    id: connector?.id ?? record.connector_id,
    tenant_config_id: record.id,
    name: connector?.name ?? titleFromSlug(record.connector_id),
    category: connector?.category ?? "content",
    platform_enabled: connector?.platform_enabled ?? true,
    tenant_enabled: record.enabled,
    configured_by: connector?.configured_by ?? "TENANT_ADMIN",
    scopes: record.scopes.length > 0 ? record.scopes : (connector?.scopes ?? []),
    secret_visible_to_admin: false,
    auth_status: authStatus,
    sync_status: connectorSyncStatus(record.settings) ?? (record.enabled ? "synced" : "idle"),
    last_sync: stringSetting(record.settings, "last_sync") ?? (record.enabled ? "Loaded from API" : "Not synced"),
    description:
      stringSetting(record.settings, "description") ??
      connector?.description ??
      `${titleFromSlug(record.auth_type)} connector configuration.`,
  };
}

/** Capability switches with no vendor credential: their on/off truth is the
 * catalog record itself, so a missing tenant config must not imply
 * "disabled". Credential connectors (Drive, Box, iManage…) stay inferred. */
const SWITCH_CONNECTOR_IDS = new Set([
  "web",
  "mcp",
  "prompt-library",
  "knowledge-ingestion",
  "document-templates",
  "audit-analytics",
]);

export function mapConnectorCatalogWithConfigs(connectors: Connector[], configs: ConnectorConfigRecord[]): Connector[] {
  const configByConnector = new Map(configs.map((config) => [config.connector_id, config]));
  const seen = new Set<string>();
  const mapped = connectors.map((connector) => {
    const config = configByConnector.get(connector.id);
    if (!config) {
      // Web search is keyless and available by default: without a tenant
      // record the platform default engine applies, so the toggle honestly
      // reflects the catalog state instead of "needs credentials".
      if (connector.id === "web") {
        return {
          ...connector,
          auth_status: "configured",
          sync_status: "idle",
          last_sync: connector.last_sync ?? "Platform default engine",
        } satisfies Connector;
      }
      if (SWITCH_CONNECTOR_IDS.has(connector.id)) {
        // Preserve the catalog's tenant_enabled — the admin switch is the
        // record of truth for these, with or without a tenant config row.
        return {
          ...connector,
          sync_status: "idle",
          last_sync: connector.last_sync ?? "Not synced",
        } satisfies Connector;
      }
      return {
        ...connector,
        tenant_enabled: false,
        auth_status: connector.platform_enabled ? "needs-admin" : "not-configured",
        sync_status: "idle",
        last_sync: connector.last_sync ?? "Not configured",
      } satisfies Connector;
    }
    seen.add(config.connector_id);
    return mapConnectorConfigRecordToConnector(config, connector);
  });

  for (const config of configs) {
    if (!seen.has(config.connector_id)) mapped.push(mapConnectorConfigRecordToConnector(config));
  }
  return mapped;
}

export function mapSsoConfigRecordToDisplay(record: SsoConfigRecord, index = 0): SsoConfig {
  const enforced = Boolean(record.enabled && (record.settings.enforced ?? true));
  return {
    id: record.id || `sso-${index}`,
    name: ssoProviderName(record.provider),
    protocol: ssoProtocol(record),
    status: ssoStatus(record, enforced),
    enforced,
    issuer: record.issuer_url,
    client_id: record.client_id,
    client_secret_set: record.secret_set,
    masked_client_secret: record.masked_secret,
    redirect_url: stringSetting(record.settings, "redirect_url") ?? stringSetting(record.settings, "acs_url"),
    entity_id: stringSetting(record.settings, "entity_id") ?? stringSetting(record.settings, "audience"),
    saml_login_url: stringSetting(record.settings, "saml_login_url"),
    saml_logout_url: stringSetting(record.settings, "saml_logout_url"),
    saml_certificate: stringSetting(record.settings, "saml_certificate"),
    duo_api_hostname: stringSetting(record.settings, "duo_api_hostname"),
    scim_base_url: stringSetting(record.settings, "scim_base_url"),
    role_claim: stringSetting(record.settings, "role_claim"),
    group_claim: stringSetting(record.settings, "group_claim"),
    domains: stringArraySetting(record.settings, "domains").length
      ? stringArraySetting(record.settings, "domains")
      : ["tenant domain"],
    mfa_provider: stringSetting(record.settings, "mfa_provider"),
    mfa_methods: stringArraySetting(record.settings, "mfa_methods"),
    mfa_enforced: Boolean(record.settings.mfa_enforced),
    mfa_notes: stringSetting(record.settings, "mfa_notes"),
    qr_enrollment_uri: stringSetting(record.settings, "qr_enrollment_uri"),
    jit_provisioning: Boolean(record.settings.jit_provisioning),
    require_platform_mfa: Boolean(record.settings.require_platform_mfa),
    mapped_groups: record.mapped_groups ?? {},
    last_tested: stringSetting(record.settings, "last_tested") ?? "Loaded from API",
    admin_notes:
      stringSetting(record.settings, "admin_notes") ??
      "Backend SSO configuration loaded without exposing client secrets.",
  };
}

export type KnowledgeConfigMappingContext = {
  connectorConfigs?: ConnectorConfigRecord[];
  connectors?: Connector[];
  groups?: Group[];
};

export function mapKnowledgeConfigRecordToKnowledgeBase(
  record: KnowledgeConfigRecord,
  context: KnowledgeConfigMappingContext = {},
): KnowledgeBase {
  const connectorConfig = context.connectorConfigs?.find((config) => config.id === record.connector_config_id);
  const connectorId = connectorConfig?.connector_id ?? record.source_type;
  const connector = context.connectors?.find((item) => item.id === connectorId);
  const groups = record.acl_group_ids
    .map((groupId) => context.groups?.find((group) => group.id === groupId)?.name ?? groupId)
    .filter(Boolean);

  return {
    id: record.id,
    name: record.name,
    description:
      stringSetting(record.settings, "description") ??
      `${connector?.name ?? titleFromSlug(record.source_type)} knowledge configuration.`,
    source:
      stringSetting(record.settings, "source") ??
      stringSetting(record.settings, "source_label") ??
      connector?.name ??
      titleFromSlug(record.source_type),
    connector_id: connectorId,
    connector_config_id: record.connector_config_id,
    status: knowledgeStatus(record.settings) ?? (record.enabled ? "synced" : "draft"),
    document_count: numberSetting(record.settings, "document_count") ?? 0,
    last_sync: stringSetting(record.settings, "last_sync") ?? (record.enabled ? "Loaded from API" : "Not synced"),
    provider_status: stringSetting(record.settings, "provider_status"),
    provider_message: stringSetting(record.settings, "provider_message"),
    acl: stringSetting(record.settings, "acl") ?? (groups.length ? `Groups: ${groups.join(", ")}` : "Only creator"),
    owner_group_id: record.acl_group_ids[0] ?? "",
    owner_user_id: record.owner_user_id,
    enabled: record.enabled,
  };
}

export function mapToolConfigRecordToDisplay(record: ToolConfigRecord): ToolConfig {
  const args = arrayOfStrings(record.settings.args);
  return {
    id: record.id,
    name: record.name,
    description:
      stringSetting(record.settings, "description") ?? `${titleFromSlug(record.tool_type)} tool configuration.`,
    type: toolType(record.tool_type),
    status: toolStatus(record.settings) ?? (record.enabled ? "ready" : "draft"),
    enabled: record.enabled,
    approval_required: record.approval_required,
    allowed_group_ids: record.allowed_group_ids,
    owner_user_id: record.owner_user_id,
    scopes: stringArraySetting(record.settings, "scopes"),
    connected_model_ids: stringArraySetting(record.settings, "connected_model_ids"),
    endpoint: record.endpoint_url ?? stringSetting(record.settings, "endpoint"),
    transport: stringSetting(record.settings, "transport"),
    auth_type: stringSetting(record.settings, "auth_type"),
    client_id: stringSetting(record.settings, "client_id"),
    oauth_authorization_url: stringSetting(record.settings, "oauth_authorization_url"),
    oauth_token_url: stringSetting(record.settings, "oauth_token_url"),
    oauth_callback_url: stringSetting(record.settings, "oauth_callback_url"),
    command: stringSetting(record.settings, "command"),
    args,
    skill_files: stringArraySetting(record.settings, "skill_files"),
    prompt_templates: stringArraySetting(record.settings, "prompt_templates"),
    hermes_companion: Boolean(record.settings.hermes_companion),
    runtime_invocations: runtimeInvocationsSetting(record.settings, "runtime_invocations"),
    script: stringSetting(record.settings, "script"),
    timeout_seconds:
      typeof record.settings.timeout_seconds === "number" ? record.settings.timeout_seconds : undefined,
  };
}

export function mapModelConfigRecordToDisplay(record: ModelConfig): ModelConfig {
  const raw = record as unknown as Record<string, unknown>;
  const knowledgeIds = arrayOfStrings(raw.knowledge_base_ids ?? raw.knowledge_config_ids);
  const toolIds = arrayOfStrings(raw.tool_ids ?? raw.tool_config_ids);
  const promptTemplateIds = arrayOfStrings(raw.prompt_template_ids);
  const skillFileIds = arrayOfStrings(raw.skill_file_ids);
  const visibility = raw.visibility;
  return {
    ...record,
    upstream_model_id:
      typeof raw.upstream_model_id === "string" && raw.upstream_model_id.trim() ? raw.upstream_model_id : record.name,
    system_prompt: record.system_prompt ?? (typeof raw.meta_prompt === "string" ? raw.meta_prompt : undefined),
    knowledge_base_ids: knowledgeIds,
    tool_ids: toolIds,
    knowledge_config_ids: knowledgeIds,
    tool_config_ids: toolIds,
    prompt_template_ids: promptTemplateIds,
    skill_file_ids: skillFileIds,
    content_filter_ids: arrayOfStrings(raw.content_filter_ids),
    agentic_companion: typeof raw.agentic_companion === "string" ? raw.agentic_companion : record.agentic_companion,
    is_custom: Boolean(
      record.is_custom || record.system_prompt || raw.meta_prompt || knowledgeIds.length || toolIds.length,
    ),
    visibility:
      visibility === "organization" || visibility === "tenant" || visibility === "group" || visibility === "private"
        ? visibility
        : record.tenant_restricted
          ? "tenant"
          : "organization",
  };
}

export function normalizeBootstrap(data: BootstrapWireData): BootstrapData {
  const groups = data.groups ?? sampleData.groups;
  const connectorConfigs = Array.isArray(data.connectorConfigs) ? data.connectorConfigs : [];
  const connectors =
    data.connectorConfigs !== undefined
      ? mapConnectorCatalogWithConfigs(data.connectors ?? sampleData.connectors, connectorConfigs)
      : (data.connectors ?? sampleData.connectors);

  return {
    me: data.me ?? sampleData.me,
    currentTenant: data.currentTenant ?? sampleData.currentTenant,
    providers: data.providers ?? sampleData.providers,
    models: (data.models ?? sampleData.models).map(mapModelConfigRecordToDisplay),
    groups,
    users: data.users ?? sampleData.users,
    visibleUsers: data.visibleUsers ?? data.users ?? sampleData.visibleUsers,
    providerKeys: data.providerKeys ?? [],
    connectors,
    connectorConfigs,
    ssoConfigs: normalizeSsoConfigs(data.ssoConfigs),
    knowledgeBases: Array.isArray(data.knowledgeConfigs)
      ? data.knowledgeConfigs.map((record) =>
          mapKnowledgeConfigRecordToKnowledgeBase(record, {
            connectorConfigs,
            connectors,
            groups,
          }),
        )
      : (data.knowledgeBases ?? sampleData.knowledgeBases),
    tools: Array.isArray(data.toolConfigs)
      ? data.toolConfigs.map((record) => mapToolConfigRecordToDisplay(record))
      : (data.tools ?? sampleData.tools),
    promptTemplates: data.promptTemplates ?? sampleData.promptTemplates,
    skillFiles: data.skillFiles ?? sampleData.skillFiles,
    chatSessions: data.chatSessions ?? sampleData.chatSessions,
    agentRuns: data.agentRuns ?? sampleData.agentRuns,
    automations: Array.isArray(data.automations) ? data.automations : sampleData.automations,
    platformSettings: normalizePlatformSettings(data.platformSettings),
    // Availability and the caller's own settings only — memory content is
    // fetched lazily by its owner and never rides in the bootstrap payload.
    memoryState: data.memoryState,
    memorySettings: data.memorySettings,
    memoryPolicy: data.memoryPolicy,
    authoringState: data.authoringState,
  };
}

function normalizePlatformSettings(value: BootstrapWireData["platformSettings"]): PlatformSettings | undefined {
  if (!value) return undefined;
  return {
    ...value,
    downstream_api_enabled: value.downstream_api_enabled ?? false,
    default_user_group_enabled: value.default_user_group_enabled ?? true,
    memory_enabled: value.memory_enabled ?? false,
  };
}

function normalizeSsoConfigs(value: unknown): BootstrapData["ssoConfigs"] {
  if (!Array.isArray(value)) return sampleData.ssoConfigs;
  return value.map((item, index) => {
    if (isRecord(item) && typeof item.name === "string" && typeof item.issuer === "string") {
      return item as SsoConfig;
    }
    return mapSsoConfigRecordToDisplay(item as SsoConfigRecord, index);
  });
}

function stringSetting(settings: Record<string, unknown>, key: string): string | undefined {
  const value = settings[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberSetting(settings: Record<string, unknown>, key: string): number | undefined {
  const value = settings[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArraySetting(settings: Record<string, unknown>, key: string): string[] {
  const value = settings[key];
  return arrayOfStrings(value);
}

function runtimeInvocationsSetting(settings: Record<string, unknown>, key: string): ToolConfig["runtime_invocations"] {
  const value = settings[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((item) => ({
      tool_name: typeof item.tool_name === "string" ? item.tool_name : typeof item.name === "string" ? item.name : "",
      label: typeof item.label === "string" ? item.label : null,
      arguments: isRecord(item.arguments) ? item.arguments : {},
    }))
    .filter((item) => item.tool_name.trim());
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function titleFromSlug(value: string): string {
  return value
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function ssoProviderName(provider: string): string {
  const labels: Record<string, string> = {
    "entra-id": "Microsoft Entra ID",
    entra: "Microsoft Entra ID",
    okta: "Okta",
    auth0: "Auth0",
    scim: "SCIM Provisioning",
  };
  return labels[provider.toLowerCase()] ?? titleFromSlug(provider);
}

function ssoProtocol(record: SsoConfigRecord): SsoConfig["protocol"] {
  const configured = stringSetting(record.settings, "protocol")?.toUpperCase();
  if (configured === "SAML" || configured === "SCIM" || configured === "OIDC") return configured;
  const source = `${record.provider} ${record.issuer_url}`.toLowerCase();
  if (source.includes("saml")) return "SAML";
  if (source.includes("scim")) return "SCIM";
  return "OIDC";
}

function ssoStatus(record: SsoConfigRecord, enforced: boolean): SsoConfig["status"] {
  const configured = stringSetting(record.settings, "status");
  if (
    configured === "not-configured" ||
    configured === "ready" ||
    configured === "enforced" ||
    configured === "error"
  ) {
    return configured;
  }
  if (!record.enabled) return "not-configured";
  return enforced ? "enforced" : "ready";
}

function connectorSyncStatus(settings: Record<string, unknown>): Connector["sync_status"] | undefined {
  const configured = stringSetting(settings, "sync_status");
  if (configured === "idle" || configured === "syncing" || configured === "synced" || configured === "error") {
    return configured;
  }
  return undefined;
}

function knowledgeStatus(settings: Record<string, unknown>): KnowledgeBase["status"] | undefined {
  const configured = stringSetting(settings, "status");
  if (
    configured === "draft" ||
    configured === "syncing" ||
    configured === "synced" ||
    configured === "stale" ||
    configured === "error"
  ) {
    return configured;
  }
  return undefined;
}

function toolStatus(settings: Record<string, unknown>): ToolConfig["status"] | undefined {
  const configured = stringSetting(settings, "status");
  if (configured === "draft" || configured === "ready" || configured === "error") return configured;
  return undefined;
}

function toolType(type: string): ToolConfig["type"] {
  const normalized = type.toLowerCase();
  if (
    normalized === "mcp" ||
    normalized === "function" ||
    normalized === "connector" ||
    normalized === "workflow" ||
    normalized === "prompt-library" ||
    normalized === "skill-library" ||
    normalized === "custom_script"
  ) {
    return normalized;
  }
  if (normalized === "webhook" || normalized === "agent" || normalized === "flow") return "workflow";
  return "connector";
}
