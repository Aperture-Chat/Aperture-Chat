export type Role = "PLATFORM_OWNER" | "TENANT_ADMIN" | "TEMP_USER" | "POWER_USER" | "AUDITOR" | "AGENT_APPROVER" | "USER";

export type User = {
  id: string;
  tenant_id?: string | null;
  email: string;
  display_name: string;
  bio?: string | null;
  firm_name?: string | null;
  website_url?: string | null;
  phone?: string | null;
  avatar_url?: string | null;
  role: Role;
  entra_object_id?: string | null;
  group_ids: string[];
  active: boolean;
  last_active: string;
  auth_method?: "local" | "sso" | "scim";
  first_run_guide_seen_at?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  access_request_status?: "pending" | "approved" | null;
  access_requested_at?: string | null;
  access_reviewed_at?: string | null;
};

export type Tenant = {
  id: string;
  name: string;
  slug: string;
  custom_domain?: string | null;
  primary_color: string;
  logo_mark: string;
  chat_brand_name?: string | null;
  logo_url?: string | null;
  icon_url?: string | null;
  gradient_start?: string | null;
  gradient_end?: string | null;
  text_color?: string | null;
};

export type Provider = {
  id: string;
  name: string;
  kind: string;
  region: string;
  connected: boolean;
  model_count: number;
  enabled_model_count: number;
  last_sync: string;
  base_url?: string | null;
  auth_type?: string | null;
  auth_metadata?: ConfigSettings;
  status_message?: string;
};

/** Provider-reported capability metadata captured at model sync. Empty or
 * missing means "not reported", not "not supported" — gates fall back to
 * family heuristics when absent. */
export type ModelCapabilities = {
  supported_parameters?: string[];
  input_modalities?: string[];
  output_modalities?: string[];
};

export type ModelConfig = {
  id: string;
  provider_id: string;
  provider_name: string;
  name: string;
  upstream_model_id?: string | null;
  platform_enabled: boolean;
  tenant_restricted: boolean;
  group_ids: string[];
  notes?: string | null;
  is_custom?: boolean;
  created_by?: string;
  system_prompt?: string;
  meta_prompt?: string;
  knowledge_base_ids?: string[];
  tool_ids?: string[];
  knowledge_config_ids?: string[];
  tool_config_ids?: string[];
  context_window?: number;
  visibility?: "organization" | "tenant" | "group" | "private";
  agentic_companion?: "hermes" | "none" | string | null;
  prompt_template_ids?: string[];
  skill_file_ids?: string[];
  admin_delete_locked?: boolean;
  content_filter_ids?: string[];
  capabilities?: ModelCapabilities | null;
};

export type PromptTemplate = {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  content: string;
  category: string;
  variables: string[];
  group_ids: string[];
  enabled: boolean;
  updated_at: string;
};

export type SkillFile = {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  content: string;
  category: string;
  format: string;
  version: string;
  group_ids: string[];
  enabled: boolean;
  updated_at: string;
};

export type ProviderKey = {
  id: string;
  provider_id: string;
  provider_name: string;
  name: string;
  environment: string;
  status: string;
  last_rotated: string;
  expires: string;
  masked_value: string;
};

export type PlatformSettings = {
  downstream_api_enabled: boolean;
  require_sso_for_admins: boolean;
  users_can_create_models: boolean;
  tenant_admins_can_manage_sso: boolean;
  tenant_admins_can_create_admins: boolean;
  default_user_group_enabled: boolean;
  memory_enabled: boolean;
};

export type PlatformSettingsUpdateRequest = Partial<PlatformSettings>;

export type MemoryKind = "preference" | "directive" | "profile" | "project" | "fact";

export type UserMemory = {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  kind: MemoryKind;
  content: string;
  source: string;
  source_thread_id?: string | null;
  confidence: number;
  pinned: boolean;
  use_count: number;
  last_used_at?: string | null;
  expires_at?: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

/** Which enablement tier is blocking memory, so the UI can explain rather than guess. */
export type MemoryState = {
  enabled: boolean;
  capture_enabled: boolean;
  platform_enabled: boolean;
  tenant_enabled: boolean;
  group_allowed: boolean;
  user_enabled: boolean;
  reason?: string | null;
};

export type UserMemorySettings = {
  user_id: string;
  enabled: boolean;
  auto_capture_enabled: boolean;
};

export type UserMemorySettingsUpdateRequest = Partial<Omit<UserMemorySettings, "user_id">>;

export type MemoryCollection = {
  state: MemoryState;
  settings: UserMemorySettings;
  memories: UserMemory[];
};

export type UserMemoryCreateRequest = {
  content: string;
  kind?: MemoryKind;
  pinned?: boolean;
};

export type UserMemoryUpdateRequest = {
  content?: string;
  kind?: MemoryKind;
  pinned?: boolean;
};

export type TenantMemoryPolicy = {
  tenant_id: string;
  enabled: boolean;
  auto_capture_enabled: boolean;
  retention_days: number;
  max_memories_per_user: number;
  excluded_kinds: MemoryKind[];
  updated_at: string;
  updated_by?: string | null;
};

export type TenantMemoryPolicyUpdateRequest = {
  enabled?: boolean;
  auto_capture_enabled?: boolean;
  retention_days?: number;
  max_memories_per_user?: number;
  excluded_kinds?: MemoryKind[];
};

export type RetentionRule = {
  id: string;
  tag_namespace: string;
  tag_key?: string | null;
  retention_days: number;
  action: "purge" | "archive_then_purge" | string;
  note?: string;
};

export type TenantRetentionPolicy = {
  tenant_id: string;
  enabled: boolean;
  chat_retention_days: number;
  retention_basis: "last_activity" | "created" | string;
  action: "purge" | "archive_then_purge" | string;
  grace_days: number;
  notify_admins: boolean;
  mcp_tagging_enabled: boolean;
  attachment_tagging_enabled: boolean;
  subject_tagging_enabled: boolean;
  external_tags_enabled: boolean;
  rules: RetentionRule[];
  last_swept_at?: string | null;
  updated_at: string;
  updated_by?: string | null;
};

export type TenantRetentionPolicyUpdateRequest = {
  enabled?: boolean;
  chat_retention_days?: number;
  retention_basis?: "last_activity" | "created";
  action?: "purge" | "archive_then_purge";
  grace_days?: number;
  notify_admins?: boolean;
  mcp_tagging_enabled?: boolean;
  attachment_tagging_enabled?: boolean;
  subject_tagging_enabled?: boolean;
  external_tags_enabled?: boolean;
  rules?: RetentionRule[];
};

export type ChatThreadTag = {
  id: string;
  tenant_id: string;
  thread_id: string;
  namespace: string;
  key: string;
  value?: string | null;
  source: "auto" | "manual" | "external" | string;
  applied_at: string;
  applied_by?: string | null;
};

/** Admin retention drilldown row. Carries thread metadata only, never content. */
export type RetentionTaggedThread = {
  thread_id: string;
  title?: string | null;
  owner_user_id?: string | null;
  archived?: boolean;
  /** Matter linkage, label only, so legal teams can search by client/matter number. */
  matter_id?: string | null;
  matter_label?: string | null;
  tags: ChatThreadTag[];
};

/** Server-side response sentiment; one record per (user, message). */
export type ChatFeedbackRecord = {
  id: string;
  tenant_id: string;
  user_id: string;
  user_name: string;
  thread_id: string;
  thread_title: string;
  message_id: string;
  // The database check constraint pins exactly these two values.
  rating: "positive" | "negative";
  comment: string;
  message_preview: string;
  model_id: string;
  created_at: string;
  updated_at: string;
};

export type ChatFeedbackSubmitRequest = {
  thread_id: string;
  message_id: string;
  rating: "positive" | "negative";
  /** Omitted = leave any existing note unchanged. */
  comment?: string;
  message_preview?: string;
  thread_title?: string;
  model_id?: string;
};

export type IssueReportRecord = {
  id: string;
  tenant_id: string;
  user_id: string;
  user_name: string;
  subject: string;
  body: string;
  screenshot_filename?: string | null;
  screenshot_mime_type?: string | null;
  screenshot_size_bytes?: number | null;
  created_at: string;
};

export type RetentionBatchRequest = {
  action: "delete" | "archive";
  thread_ids: string[];
};

export type RetentionBatchResult = {
  action: string;
  requested: number;
  disposed: number;
  skipped_held: number;
  skipped_missing: number;
};

/** Admin-facing memory reporting. Carries counts only, never memory content. */
export type MemoryUserStat = {
  user_id: string;
  display_name: string;
  email: string;
  count: number;
  last_updated?: string | null;
};

export type MemorySavedNotice = {
  id: string;
  kind: MemoryKind;
  content: string;
};

export type TenantBrandingUpdateRequest = {
  chat_brand_name?: string | null;
  logo_url?: string | null;
  icon_url?: string | null;
  logo_mark?: string | null;
  primary_color?: string | null;
  custom_domain?: string | null;
  gradient_start?: string | null;
  gradient_end?: string | null;
  text_color?: string | null;
};

export type ElasticStatus = {
  configured: boolean;
  connected: boolean;
  endpoint?: string | null;
  lastSync?: string;
  eventsBuffered: number;
  message?: string;
};

export type AuditEvent = {
  id: string;
  tenant_id?: string | null;
  actor_id: string;
  actor_name: string;
  actor_role: string;
  action: string;
  action_type: string;
  target: string;
  target_type: string;
  target_name: string;
  detail: string;
  created_at: string;
  redacted: boolean;
  metadata: Record<string, unknown>;
  severity?: "info" | "warning" | "critical" | string;
  severity_reason?: string;
};

export type SecurityAlert = {
  id: string;
  tenant_id?: string | null;
  user_id: string;
  user_name: string;
  rule_id: string;
  rule_label: string;
  category: "dlp" | "behavior" | string;
  severity: "high" | "medium" | string;
  snippet: string;
  model_id: string;
  thread_id?: string | null;
  surface: "chat" | "draft" | string;
  created_at: string;
  acknowledged: boolean;
  acknowledged_by?: string | null;
  acknowledged_at?: string | null;
};

export type UserPromptRecord = {
  id: string;
  user_id: string;
  user_name: string;
  user_email: string;
  user_role?: Role;
  thread_id: string;
  thread_title: string;
  model_id: string;
  content: string;
  created_at: string;
  created_at_iso?: string | null;
  response_message_id?: string | null;
  response_content?: string | null;
  response_created_at?: string | null;
  response_created_at_iso?: string | null;
  response_status?: string | null;
  response_truncated?: boolean;
  response_images?: string[];
  alert_count: number;
};

export type UsageRecord = {
  id: string;
  tenant_id?: string | null;
  user_id: string;
  user_name: string;
  user_role: string;
  model_id: string;
  provider_name: string;
  surface: string;
  message_count: number;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  thread_id?: string | null;
  source: "live" | "backfill" | string;
  created_at: string;
};

export type UsageTotals = {
  messages: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  active_users: number;
  models_used: number;
  tokens_reported_messages: number;
};

export type UsageUserRow = {
  user_id: string;
  user_name: string;
  user_role: string;
  message_count: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  model_count: number;
  surfaces: string[];
  last_active_at: string;
};

export type UsageModelRow = {
  model_id: string;
  provider_name: string;
  message_count: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  user_count: number;
  last_used_at: string;
};

export type UsageDayRow = {
  date: string;
  message_count: number;
  total_tokens: number | null;
};

export type UsageSurfaceRow = {
  surface: string;
  message_count: number;
};

export type UsageSummary = {
  totals: UsageTotals;
  by_user: UsageUserRow[];
  by_model: UsageModelRow[];
  by_day: UsageDayRow[];
  by_surface: UsageSurfaceRow[];
  backfilled_record_count: number;
};

export type AlertRule = {
  id: string;
  scope: "platform" | "tenant" | string;
  tenant_id?: string | null;
  name: string;
  description: string;
  enabled: boolean;
  action_patterns: string[];
  min_severity: "info" | "warning" | "critical" | string;
  actor_ids: string[];
  threshold_count: number;
  window_minutes: number;
  cooldown_minutes: number;
  recipients: string[];
  created_by: string;
  created_by_name: string;
  created_at: string;
  updated_at: string;
  last_triggered_at?: string | null;
};

export type AlertRuleCreateRequest = {
  name: string;
  description?: string;
  enabled?: boolean;
  action_patterns?: string[];
  min_severity?: string;
  actor_ids?: string[];
  threshold_count?: number;
  window_minutes?: number;
  cooldown_minutes?: number;
  recipients?: string[];
};

export type AlertRuleUpdateRequest = Partial<AlertRuleCreateRequest>;

export type AlertNotification = {
  id: string;
  rule_id: string;
  rule_name: string;
  scope: "platform" | "tenant" | string;
  tenant_id?: string | null;
  event_id: string;
  event_action: string;
  event_severity: string;
  actor_id: string;
  actor_name: string;
  summary: string;
  matched_count: number;
  recipients: string[];
  status: "queued" | "sent" | "failed" | "not_configured" | "logged" | string;
  status_detail: string;
  attempts: number;
  archived?: boolean;
  created_at: string;
  delivered_at?: string | null;
};

export type EmailSettings = {
  host: string;
  port: number;
  security: "starttls" | "ssl" | "none" | string;
  username: string;
  from_address: string;
  password_set: boolean;
  masked_password: string;
  last_test_at?: string | null;
  last_test_status?: string | null;
  updated_at?: string | null;
};

export type EmailSettingsUpdateRequest = {
  host?: string;
  port?: number;
  security?: string;
  username?: string;
  password?: string;
  from_address?: string;
};

export type EmailTestResult = {
  status: "sent" | "failed" | string;
  detail: string;
};

export type AlertEmailStatus = {
  configured: boolean;
  from_address: string;
  message: string;
};

export type ProviderKeySecret = ProviderKey & {
  secret_value: string;
};

export type PlatformProviderKeyCreateRequest = {
  id?: string | null;
  provider_id: string;
  name: string;
  environment?: string;
  status?: string;
  expires?: string;
  secret_value: string;
};

export type Group = {
  id: string;
  tenant_id: string;
  name: string;
  distinguished_name: string;
  entra_object_id: string;
  synced: boolean;
  user_count: number;
  default_group?: boolean;
  permissions: Record<string, boolean>;
};

export type Connector = {
  id: string;
  tenant_config_id?: string;
  name: string;
  category: string;
  platform_enabled: boolean;
  tenant_enabled: boolean;
  configured_by: Role;
  scopes: string[];
  secret_visible_to_admin: boolean;
  auth_status?: "not-configured" | "configured" | "needs-admin" | "needs-credentials" | "error";
  sync_status?: "idle" | "syncing" | "synced" | "error";
  last_sync?: string;
  description?: string;
};

export type SsoConfig = {
  id: string;
  name: string;
  protocol: "OIDC" | "SAML" | "SCIM";
  status: "not-configured" | "ready" | "enforced" | "error";
  enforced: boolean;
  issuer: string;
  client_id?: string | null;
  client_secret_set?: boolean;
  masked_client_secret?: string | null;
  redirect_url?: string | null;
  entity_id?: string | null;
  saml_login_url?: string | null;
  saml_logout_url?: string | null;
  saml_certificate?: string | null;
  duo_api_hostname?: string | null;
  scim_base_url?: string | null;
  role_claim?: string | null;
  group_claim?: string | null;
  domains: string[];
  mfa_provider?: string | null;
  mfa_methods?: string[];
  mfa_enforced?: boolean;
  mfa_notes?: string | null;
  qr_enrollment_uri?: string | null;
  jit_provisioning?: boolean;
  /** Off (default): the IdP's own MFA is trusted; on: platform TOTP is added. */
  require_platform_mfa?: boolean;
  /** IdP group/claim value -> tenant group id, editable by tenant admins. */
  mapped_groups?: Record<string, string>;
  last_tested: string;
  admin_notes: string;
};

export type KnowledgeBase = {
  id: string;
  name: string;
  description: string;
  source: string;
  connector_id: string;
  connector_config_id?: string | null;
  status: "draft" | "syncing" | "synced" | "stale" | "error";
  document_count: number;
  last_sync: string;
  provider_status?: "live" | "cached" | "error" | string;
  provider_message?: string | null;
  acl: string;
  owner_group_id: string;
  owner_user_id?: string | null;
  enabled: boolean;
};

export type KnowledgeDocument = {
  id: string;
  knowledge_config_id: string;
  tenant_id: string;
  name: string;
  source_uri: string;
  source_type: string;
  status: "indexed" | "syncing" | "error" | string;
  chunk_count: number;
  acl_group_ids: string[];
  updated_at: string;
  citation_required: boolean;
};

export type KnowledgeSyncResult = {
  config: KnowledgeConfigRecord;
  documents: KnowledgeDocument[];
  status: KnowledgeBase["status"] | string;
  synced_at: string;
  provider_status?: string;
  provider_message?: string | null;
};

export type ToolConfig = {
  id: string;
  name: string;
  description: string;
  type: "mcp" | "function" | "connector" | "workflow" | "prompt-library" | "skill-library" | "custom_script";
  status: "draft" | "ready" | "error";
  enabled: boolean;
  approval_required: boolean;
  allowed_group_ids: string[];
  /** Set only for user-authored tools; admin-created tools leave this unset. */
  owner_user_id?: string | null;
  scopes: string[];
  connected_model_ids: string[];
  endpoint?: string;
  transport?: "stdio" | "http" | "sse" | string;
  auth_type?: string;
  client_id?: string;
  oauth_authorization_url?: string;
  oauth_token_url?: string;
  oauth_callback_url?: string;
  command?: string;
  args?: string[];
  skill_files?: string[];
  prompt_templates?: string[];
  hermes_companion?: boolean;
  runtime_invocations?: McpRuntimeInvocation[];
  script?: string;
  timeout_seconds?: number;
};

export type McpToolSummary = {
  name: string;
  description?: string | null;
  input_schema?: Record<string, unknown> | null;
};

export type McpRuntimeInvocation = {
  tool_name: string;
  label?: string | null;
  arguments?: Record<string, unknown>;
};

export type McpHealthResult = {
  tool_config_id: string;
  name: string;
  transport: string;
  command?: string | null;
  status: "ready" | "error" | "unsupported" | string;
  message: string;
  tools: McpToolSummary[];
  server_info: Record<string, unknown>;
};

export type McpToolCallRequest = {
  tool_name: string;
  label?: string | null;
  arguments?: Record<string, unknown>;
};

export type McpToolCallResult = {
  tool_config_id: string;
  name: string;
  transport: string;
  command?: string | null;
  tool_name: string;
  label?: string | null;
  status: "ready" | "error" | "unsupported" | "skipped" | string;
  message: string;
  result_text?: string | null;
  structured_content?: unknown;
  is_error: boolean;
};

export type AdminUserCreateRequest = {
  id?: string | null;
  tenant_id?: string | null;
  email: string;
  display_name: string;
  role?: Role;
  entra_object_id?: string | null;
  group_ids?: string[];
  active?: boolean;
};

export type AdminUserUpdateRequest = {
  tenant_id?: string | null;
  email?: string | null;
  display_name?: string | null;
  role?: Role | null;
  entra_object_id?: string | null;
  group_ids?: string[] | null;
  active?: boolean | null;
};

export type AdminUserDeactivateResponse = {
  status: "deactivated";
  user_id: string;
};

export type AdminUserDeleteResponse = {
  status: "deleted";
  user_id: string;
};

export type AdminGroupCreateRequest = {
  id?: string | null;
  tenant_id?: string | null;
  name: string;
  distinguished_name?: string | null;
  entra_object_id?: string | null;
  synced?: boolean;
  user_count?: number;
  permissions?: Record<string, boolean>;
};

export type AdminGroupUpdateRequest = Partial<
  Pick<Group, "name" | "distinguished_name" | "entra_object_id" | "synced" | "user_count" | "permissions">
>;

export type AdminGroupBulkCreateRequest = {
  groups: AdminGroupCreateRequest[];
};

export type AdminGroupBulkDeleteRequest = {
  group_ids: string[];
};

export type AdminGroupBulkDeleteResponse = {
  deleted_group_ids: string[];
};

export type AdminModelAccessUpdateRequest = {
  group_ids: string[];
};

export type PlatformProviderCreateRequest = {
  id?: string | null;
  name: string;
  kind: string;
  region: string;
  base_url?: string | null;
  auth_type?: string;
  auth_metadata?: ConfigSettings;
  connected?: boolean;
  model_count?: number;
  enabled_model_count?: number;
  last_sync?: string;
  status_message?: string | null;
};

export type PlatformProviderUpdateRequest = Partial<
  Pick<
    Provider,
    | "name"
    | "kind"
    | "region"
    | "base_url"
    | "auth_type"
    | "auth_metadata"
    | "connected"
    | "model_count"
    | "enabled_model_count"
    | "last_sync"
    | "status_message"
  >
>;

export type ProviderModelSyncResult = {
  provider: Provider;
  models: ModelConfig[];
  imported_count: number;
  updated_count: number;
  removed_count: number;
  source: string;
  message: string;
};

export type PlatformModelCreateRequest = {
  id?: string | null;
  provider_id: string;
  name: string;
  upstream_model_id?: string | null;
  system_prompt?: string | null;
  meta_prompt?: string | null;
  knowledge_config_ids?: string[];
  tool_config_ids?: string[];
  platform_enabled?: boolean;
  tenant_restricted?: boolean;
  group_ids?: string[];
  notes?: string | null;
  is_custom?: boolean;
  created_by?: string | null;
  context_window?: number | null;
  visibility?: string;
  agentic_companion?: string | null;
  prompt_template_ids?: string[];
  skill_file_ids?: string[];
  admin_delete_locked?: boolean;
};

export type PlatformModelUpdateRequest = {
  provider_id?: string | null;
  name?: string | null;
  upstream_model_id?: string | null;
  system_prompt?: string | null;
  meta_prompt?: string | null;
  knowledge_config_ids?: string[] | null;
  tool_config_ids?: string[] | null;
  platform_enabled?: boolean | null;
  tenant_restricted?: boolean | null;
  group_ids?: string[] | null;
  notes?: string | null;
  is_custom?: boolean | null;
  created_by?: string | null;
  context_window?: number | null;
  visibility?: string | null;
  agentic_companion?: string | null;
  prompt_template_ids?: string[] | null;
  skill_file_ids?: string[] | null;
  admin_delete_locked?: boolean | null;
};

export type ConfigSettings = Record<string, unknown>;

export type TenantScopedConfigRecord = {
  id: string;
  tenant_id: string;
  enabled: boolean;
  settings: ConfigSettings;
  secret_set: boolean;
  masked_secret?: string | null;
};

export type ConnectorConfigRecord = TenantScopedConfigRecord & {
  connector_id: string;
  auth_type: string;
  scopes: string[];
};

export type SsoConfigRecord = TenantScopedConfigRecord & {
  provider: string;
  issuer_url: string;
  client_id: string;
  scopes: string[];
  mapped_groups: Record<string, string>;
};

export type KnowledgeConfigRecord = TenantScopedConfigRecord & {
  name: string;
  source_type: string;
  connector_config_id?: string | null;
  acl_group_ids: string[];
  owner_user_id?: string | null;
};

export type ToolConfigRecord = TenantScopedConfigRecord & {
  name: string;
  tool_type: string;
  endpoint_url?: string | null;
  approval_required: boolean;
  allowed_group_ids: string[];
  owner_user_id?: string | null;
};

export type AdminConnectorConfigCreateRequest = {
  id?: string | null;
  tenant_id?: string | null;
  connector_id: string;
  enabled?: boolean;
  auth_type?: string;
  scopes?: string[];
  settings?: ConfigSettings;
  secret_value?: string | null;
  service_password?: string | null;
};

export type AdminConnectorConfigUpdateRequest = {
  connector_id?: string | null;
  enabled?: boolean | null;
  auth_type?: string | null;
  scopes?: string[] | null;
  settings?: ConfigSettings | null;
  secret_value?: string | null;
  service_password?: string | null;
  replace_settings?: boolean | null;
  clear_secret?: boolean | null;
  clear_oauth?: boolean | null;
  clear_service_password?: boolean | null;
};

export type AdminSsoConfigCreateRequest = {
  id?: string | null;
  tenant_id?: string | null;
  provider: string;
  issuer_url: string;
  client_id: string;
  enabled?: boolean;
  scopes?: string[];
  mapped_groups?: Record<string, string>;
  settings?: ConfigSettings;
  client_secret?: string | null;
};

export type AdminSsoConfigUpdateRequest = {
  provider?: string | null;
  issuer_url?: string | null;
  client_id?: string | null;
  enabled?: boolean | null;
  scopes?: string[] | null;
  mapped_groups?: Record<string, string> | null;
  settings?: ConfigSettings | null;
  client_secret?: string | null;
};

export type AdminKnowledgeConfigCreateRequest = {
  id?: string | null;
  tenant_id?: string | null;
  name: string;
  source_type: string;
  connector_config_id?: string | null;
  enabled?: boolean;
  acl_group_ids?: string[];
  owner_user_id?: string | null;
  settings?: ConfigSettings;
  secret_value?: string | null;
};

export type AdminKnowledgeConfigUpdateRequest = {
  name?: string | null;
  source_type?: string | null;
  connector_config_id?: string | null;
  enabled?: boolean | null;
  acl_group_ids?: string[] | null;
  owner_user_id?: string | null;
  settings?: ConfigSettings | null;
  secret_value?: string | null;
};

export type AdminToolConfigCreateRequest = {
  id?: string | null;
  tenant_id?: string | null;
  name: string;
  tool_type: string;
  endpoint_url?: string | null;
  enabled?: boolean;
  approval_required?: boolean;
  allowed_group_ids?: string[];
  settings?: ConfigSettings;
  secret_value?: string | null;
};

export type AdminToolConfigUpdateRequest = {
  name?: string | null;
  tool_type?: string | null;
  endpoint_url?: string | null;
  enabled?: boolean | null;
  approval_required?: boolean | null;
  allowed_group_ids?: string[] | null;
  settings?: ConfigSettings | null;
  secret_value?: string | null;
};

export type ContentFilterRule = {
  id: string;
  label: string;
  pattern: string;
  action: "redact" | "block";
  applies_to: "input" | "output" | "both";
};

export type ContentFilter = {
  id: string;
  tenant_id?: string | null;
  name: string;
  description: string;
  builtin: boolean;
  rules: ContentFilterRule[];
  created_by?: string | null;
  updated_at: string;
};

export type AdminContentFilterCreateRequest = {
  id?: string | null;
  tenant_id?: string | null;
  name: string;
  description?: string;
  rules: ContentFilterRule[];
};

export type AdminContentFilterUpdateRequest = {
  name?: string | null;
  description?: string | null;
  rules?: ContentFilterRule[] | null;
};

export type ContentFilterRuleMatchSummary = {
  rule_id: string;
  label: string;
  action: string;
  match_count: number;
};

export type ContentFilterPreviewResult = {
  matches: ContentFilterRuleMatchSummary[];
  redacted_sample: string;
  would_block: boolean;
};

export type CustomScriptRunResult = {
  tool_config_id: string;
  name: string;
  status: "ok" | "error" | "timeout" | string;
  output: string;
  error: string;
  exit_code?: number | null;
  duration_ms: number;
  truncated: boolean;
};

export type AdminPromptTemplateCreateRequest = {
  id?: string | null;
  tenant_id?: string | null;
  name: string;
  description?: string;
  content: string;
  category?: string;
  variables?: string[];
  group_ids?: string[];
  enabled?: boolean;
};

export type AdminPromptTemplateUpdateRequest = {
  name?: string | null;
  description?: string | null;
  content?: string | null;
  category?: string | null;
  variables?: string[] | null;
  group_ids?: string[] | null;
  enabled?: boolean | null;
};

export type AdminSkillFileCreateRequest = {
  id?: string | null;
  tenant_id?: string | null;
  name: string;
  description?: string;
  content: string;
  category?: string;
  format?: string;
  version?: string;
  group_ids?: string[];
  enabled?: boolean;
};

export type AdminSkillFileUpdateRequest = {
  name?: string | null;
  description?: string | null;
  content?: string | null;
  category?: string | null;
  format?: string | null;
  version?: string | null;
  group_ids?: string[] | null;
  enabled?: boolean | null;
};

export type ChatSession = {
  id: string;
  tenant_id: string;
  owner_user_id?: string | null;
  title: string;
  model_id: string;
  group_id: string;
  pinned: boolean;
  archived?: boolean;
  folder_id?: string | null;
  used_agent: boolean;
  updated_at: string;
};

export type ChatRole = "user" | "assistant" | "system";

export type ChatAttachment = {
  id?: string | null;
  tenant_id?: string | null;
  owner_user_id?: string | null;
  name: string;
  size: string;
  kind: string;
  mime_type?: string | null;
  size_bytes?: number | null;
  source_type?: string | null;
  source_uri?: string | null;
  status?: string | null;
  uploaded_at?: string | null;
  text_preview?: string | null;
};

export type CloudAttachmentItem = {
  id: string;
  name: string;
  kind: string;
  item_type: string;
  mime_type?: string | null;
  size: string;
  size_bytes?: number | null;
  source_type: string;
  source_uri: string;
  modified_at?: string | null;
};

export type ChatCitation = {
  id: string;
  source_name: string;
  source_type: string;
  source_uri: string;
  snippet: string;
  /** One-based page range inside the source document. Absent/null for legacy
   * chunks — the UI must never fabricate a page when these are missing. */
  page_start?: number | null;
  page_end?: number | null;
  /** Non-page location hint (e.g. "Sheet: Q3"); null for legacy chunks. */
  locator?: string | null;
  /** Stable id of the retrieved chunk; distinct chunks from the same source
   * remain distinct citations. */
  chunk_id?: string | null;
  /** One-based stable index matching the exact [K#] label in the model
   * prompt. Absent for non-knowledge citations (web, uploads, MCP). */
  k_index?: number | null;
};

export type ChatActivityTraceStep = {
  id: string;
  label: string;
  detail?: string;
};

export type ChatFeedbackRating = "positive" | "negative";

/** Provider-reported token usage for one assistant reply. Absent when the
 * provider did not report usage — never estimated client-side. */
export type ChatTokenUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  createdAtIso?: string | null;
  executedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown>;
  status?: "pending" | "error" | "ok";
  attachments?: ChatAttachment[];
  citations?: ChatCitation[];
  activityTrace?: ChatActivityTraceStep[];
  startedAtMs?: number;
  usage?: ChatTokenUsage | null;
  /** How many of the user's own memories personalized this reply. */
  memoryUsed?: number;
  /** Memories captured from the message that produced this reply. */
  memorySaved?: MemorySavedNotice[];
};

export type ChatThread = ChatSession & {
  messages: ChatMessage[];
};

export type AgentRun = {
  id: string;
  tenant_id: string;
  name: string;
  status: string;
  started_by: string;
  started_at: string;
  is_sample?: boolean;
  sources: string[];
  steps: Array<{
    id: string;
    label: string;
    status: string;
    detail: string;
    timestamp?: string | null;
  }>;
  artifacts: Array<{
    id: string;
    name: string;
    kind: string;
    size: string;
    created_at: string;
  }>;
  approvals: Array<{
    id: string;
    title: string;
    requested_by: string;
    requested_at: string;
    status: string;
  }>;
  logs: Array<{ time: string; step: string; event: string }>;
};

export type BootstrapData = {
  me: User;
  currentTenant: Tenant;
  providers: Provider[];
  models: ModelConfig[];
  groups: Group[];
  users: User[];
  visibleUsers: User[];
  providerKeys: ProviderKey[];
  connectors: Connector[];
  connectorConfigs: ConnectorConfigRecord[];
  ssoConfigs: SsoConfig[];
  knowledgeBases: KnowledgeBase[];
  tools: ToolConfig[];
  promptTemplates: PromptTemplate[];
  skillFiles: SkillFile[];
  chatSessions: ChatSession[];
  agentRuns: AgentRun[];
  automations: Automation[];
  /** Read-only org policy booleans surfaced by the bootstrap API. */
  platformSettings?: PlatformSettings;
  /** Memory availability and preferences. Never memory content. */
  memoryState?: MemoryState;
  memorySettings?: UserMemorySettings;
  memoryPolicy?: TenantMemoryPolicy;
  /** Resolved authoring capabilities for the current user. */
  authoringState?: AuthoringState;
};

export type AuthoringState = {
  knowledge_enabled: boolean;
  tools_enabled: boolean;
};

export type AutomationStep = {
  model_id: string;
  instruction: string;
};

export type Automation = {
  id: string;
  tenant_id: string;
  name: string;
  surface: "chat" | "draft";
  trigger_type: "once" | "daily" | "weekly" | "cron";
  run_at?: string | null;
  weekly_day?: string | null;
  time_of_day?: string | null;
  cron_expression?: string | null;
  prompt: string;
  steps: AutomationStep[];
  enabled: boolean;
  created_by?: string | null;
  created_at?: string;
  updated_at?: string;
  last_run_at?: string | null;
  last_run_status?: string | null;
};

export type AutomationRunResult = {
  automation: Automation;
  transcript: Array<{
    step: number;
    model_id: string;
    model_name: string;
    instruction: string;
    output: string;
    /** True when the provider stopped this step at its token limit. */
    truncated?: boolean;
  }>;
  final_output: string;
};

export type BootstrapWireData = Partial<
  Omit<BootstrapData, "connectors" | "connectorConfigs" | "ssoConfigs" | "knowledgeBases" | "tools">
> & {
  connectors?: Connector[];
  connectorConfigs?: ConnectorConfigRecord[];
  ssoConfigs?: Array<SsoConfig | SsoConfigRecord>;
  knowledgeBases?: KnowledgeBase[];
  knowledgeConfigs?: KnowledgeConfigRecord[];
  tools?: ToolConfig[];
  toolConfigs?: ToolConfigRecord[];
};

export type AuthProviderOption = {
  id: string;
  name: string;
  provider: string;
  protocol: string;
  tenant_id: string;
  domains: string[];
  enforced: boolean;
  mfa_methods?: string[];
  mfa_enforced?: boolean;
  mfa_notes?: string | null;
  start_url?: string | null;
};

export type AuthOptionsResponse = {
  local_auth_enabled: boolean;
  bootstrap_required?: boolean;
  password_auth_enabled?: boolean;
  providers: AuthProviderOption[];
  tenant_branding?: Tenant | null;
};

export type AuthLoginRequest = {
  email: string;
  display_name?: string | null;
  provider_id?: string | null;
  auth_method?: "sso" | "local";
  password?: string | null;
  group_ids?: string[];
};

export type AuthBootstrapOwnerRequest = {
  email: string;
  display_name: string;
  password: string;
};

export type AccountProfileUpdateRequest = {
  display_name?: string | null;
  bio?: string | null;
  firm_name?: string | null;
  website_url?: string | null;
  phone?: string | null;
  avatar_url?: string | null;
};

export type AccountPasswordUpdateRequest = {
  current_password: string;
  new_password: string;
};

export type AccountApiKeyStatus = {
  enabled: boolean;
  has_key: boolean;
  masked_value?: string | null;
  created_at?: string | null;
  last_used_at?: string | null;
};

export type AccountApiKeyCreateResponse = AccountApiKeyStatus & {
  secret_value: string;
};

// --- Platform updates (platform owner only) ---------------------------------
// Mirrors services/api/app/models/schemas.py PlatformUpdateStatus.

export type PlatformReleaseInfo = {
  version: string;
  name: string;
  url: string;
  published_at?: string | null;
  /** Markdown of the release's Highlights section (or the whole body). */
  highlights: string;
  notes: string;
};

export type PlatformUpdaterPhase =
  | "idle"
  | "requested"
  | "accepted"
  | "pulling"
  | "applying"
  | "verifying"
  | "succeeded"
  | "failed"
  | "rolled_back";

export type PlatformUpdaterRun = {
  id?: string | null;
  phase: PlatformUpdaterPhase;
  target_version?: string | null;
  previous_version?: string | null;
  requested_by?: string | null;
  message: string;
  started_at?: string | null;
  updated_at?: string | null;
  finished_at?: string | null;
};

export type PlatformUpdaterStatus = {
  /** The API has a shared state directory for the updater sidecar. */
  configured: boolean;
  /** The sidecar reported a fresh heartbeat and can drive Compose. */
  connected: boolean;
  last_heartbeat_at?: string | null;
  project?: string | null;
  problem?: string | null;
  run: PlatformUpdaterRun;
  log_tail: string;
};

export type PlatformUpdateStatus = {
  current_version: string;
  latest_version?: string | null;
  update_available: boolean;
  /** Releases newer than the running build, newest first. */
  releases: PlatformReleaseInfo[];
  checked_at?: string | null;
  check_error?: string | null;
  check_enabled: boolean;
  repository: string;
  releases_page_url: string;
  updater: PlatformUpdaterStatus;
};

export type AuthLoginResponse = {
  user: User;
  session: {
    user_id: string;
    auth_method: string;
    sso_config_id?: string | null;
    token?: string | null;
    expires_at?: number | null;
    mfa_assured?: boolean;
    mfa_factor_generation?: number | null;
  };
  bootstrap: BootstrapWireData;
  /** True when the account signed in with an admin-issued temporary password. */
  must_change_password?: boolean;
};
