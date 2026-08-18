import { apiRequest, pathId, type ApiMutationOptions } from "./http";
import { mapModelConfigRecordToDisplay } from "./bootstrap";
import { usageBudgetRequest, type TenantUsageBudgetSnapshot } from "./platform";
import type {
  AdminConnectorConfigCreateRequest,
  AdminConnectorConfigUpdateRequest,
  AdminContentFilterCreateRequest,
  AdminContentFilterUpdateRequest,
  ContentFilter,
  ContentFilterPreviewResult,
  ContentFilterRule,
  AdminGroupBulkCreateRequest,
  AdminGroupBulkDeleteRequest,
  AdminGroupBulkDeleteResponse,
  AdminGroupCreateRequest,
  AdminGroupUpdateRequest,
  AdminModelAccessUpdateRequest,
  AdminKnowledgeConfigCreateRequest,
  AdminKnowledgeConfigUpdateRequest,
  AdminPromptTemplateCreateRequest,
  AdminPromptTemplateUpdateRequest,
  AdminSkillFileCreateRequest,
  AdminSkillFileUpdateRequest,
  AdminSsoConfigCreateRequest,
  AdminSsoConfigUpdateRequest,
  AdminToolConfigCreateRequest,
  AdminToolConfigUpdateRequest,
  AdminUserCreateRequest,
  AdminUserDeactivateResponse,
  AdminUserDeleteResponse,
  AdminUserUpdateRequest,
  AuditEvent,
  ConnectorConfigRecord,
  Group,
  KnowledgeConfigRecord,
  ModelConfig,
  PlatformModelCreateRequest,
  PlatformModelUpdateRequest,
  PromptTemplate,
  AlertEmailStatus,
  AlertNotification,
  AlertRule,
  AlertRuleCreateRequest,
  AlertRuleUpdateRequest,
  ChatFeedbackRecord,
  RetentionBatchRequest,
  RetentionBatchResult,
  RetentionTaggedThread,
  SecurityAlert,
  TenantRetentionPolicy,
  TenantRetentionPolicyUpdateRequest,
  UsageRecord,
  UsageSummary,
  SkillFile,
  SsoConfigRecord,
  ToolConfigRecord,
  User,
  UserPromptRecord,
} from "../types";

export function createAdminUser(
  userId: string,
  payload: AdminUserCreateRequest,
  options: ApiMutationOptions = {},
): Promise<User> {
  return apiRequest<User>(userId, "/api/admin/users", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function listAdminUsers(userId: string, options: ApiMutationOptions = {}): Promise<User[]> {
  return apiRequest<User[]>(userId, "/api/admin/users", {
    signal: options.signal,
  });
}

export function approveAdminAccessRequest(
  userId: string,
  targetUserId: string,
  role: "USER" | "TEMP_USER" | "TENANT_ADMIN",
  options: ApiMutationOptions = {},
): Promise<User> {
  return apiRequest<User>(userId, `/api/admin/access-requests/${pathId(targetUserId)}/approve`, {
    method: "POST",
    body: { role },
    signal: options.signal,
  });
}

export function declineAdminAccessRequest(
  userId: string,
  targetUserId: string,
  options: ApiMutationOptions = {},
): Promise<void> {
  return apiRequest(userId, `/api/admin/access-requests/${pathId(targetUserId)}`, {
    method: "DELETE",
    signal: options.signal,
  }).then(() => undefined);
}

export function updateAdminUser(
  userId: string,
  targetUserId: string,
  payload: AdminUserUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<User> {
  return apiRequest<User>(userId, `/api/admin/users/${pathId(targetUserId)}`, {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

export function deactivateAdminUser(
  userId: string,
  targetUserId: string,
  options: ApiMutationOptions = {},
): Promise<AdminUserDeactivateResponse> {
  return apiRequest<AdminUserDeactivateResponse>(userId, `/api/admin/users/${pathId(targetUserId)}/deactivate`, {
    method: "POST",
    signal: options.signal,
  });
}

/** Permanently removes an account. Owners may delete admins and users;
 * tenant admins may delete regular users in their own tenant. */
export function deleteAdminUser(
  userId: string,
  targetUserId: string,
  options: ApiMutationOptions = {},
): Promise<AdminUserDeleteResponse> {
  return apiRequest<AdminUserDeleteResponse>(userId, `/api/admin/users/${pathId(targetUserId)}`, {
    method: "DELETE",
    signal: options.signal,
  });
}

export type AdminPasswordResetRequest = {
  password: string;
  temporary: boolean;
};

export type AdminPasswordResetResponse = {
  status: string;
  user_id: string;
  temporary: boolean;
};

/** Owner/admin sets a target account's password (role scoping enforced server-side). */
export function resetAdminUserPassword(
  userId: string,
  targetUserId: string,
  payload: AdminPasswordResetRequest,
  options: ApiMutationOptions = {},
): Promise<AdminPasswordResetResponse> {
  return apiRequest<AdminPasswordResetResponse>(userId, `/api/admin/users/${pathId(targetUserId)}/password`, {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function createAdminGroup(
  userId: string,
  payload: AdminGroupCreateRequest,
  options: ApiMutationOptions = {},
): Promise<Group> {
  return apiRequest<Group>(userId, "/api/admin/groups", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function bulkCreateAdminGroups(
  userId: string,
  payload: AdminGroupBulkCreateRequest,
  options: ApiMutationOptions = {},
): Promise<Group[]> {
  return apiRequest<Group[]>(userId, "/api/admin/groups/bulk", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function updateAdminGroup(
  userId: string,
  groupId: string,
  payload: AdminGroupUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<Group> {
  return apiRequest<Group>(userId, `/api/admin/groups/${pathId(groupId)}`, {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

export function deleteAdminGroup(
  userId: string,
  groupId: string,
  options: ApiMutationOptions = {},
): Promise<{ status: string; id: string }> {
  return apiRequest<{ status: string; id: string }>(userId, `/api/admin/groups/${pathId(groupId)}`, {
    method: "DELETE",
    signal: options.signal,
  });
}

export function bulkDeleteAdminGroups(
  userId: string,
  payload: AdminGroupBulkDeleteRequest,
  options: ApiMutationOptions = {},
): Promise<AdminGroupBulkDeleteResponse> {
  return apiRequest<AdminGroupBulkDeleteResponse>(userId, "/api/admin/groups/bulk-delete", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function updateAdminModelAccess(
  userId: string,
  modelId: string,
  payload: AdminModelAccessUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<ModelConfig> {
  return apiRequest<ModelConfig>(userId, `/api/admin/model-access/${pathId(modelId)}`, {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  }).then(mapModelConfigRecordToDisplay);
}

export function listAdminModelAccess(userId: string, options: ApiMutationOptions = {}): Promise<ModelConfig[]> {
  return apiRequest<ModelConfig[]>(userId, "/api/admin/model-access", {
    signal: options.signal,
  }).then((models) => models.map(mapModelConfigRecordToDisplay));
}

export function syncAdminModelAccess(userId: string, options: ApiMutationOptions = {}): Promise<ModelConfig[]> {
  return apiRequest<ModelConfig[]>(userId, "/api/admin/model-access-sync", {
    method: "POST",
    signal: options.signal,
  }).then((models) => models.map(mapModelConfigRecordToDisplay));
}

export function createAdminAgentProfile(
  userId: string,
  payload: PlatformModelCreateRequest,
  options: ApiMutationOptions = {},
): Promise<ModelConfig> {
  return apiRequest<ModelConfig>(userId, "/api/admin/agent-profiles", {
    method: "POST",
    body: payload,
    signal: options.signal,
  }).then(mapModelConfigRecordToDisplay);
}

export type HermesMemory = {
  id: string;
  tenant_id: string;
  profile_id: string;
  content: string;
  created_by: string;
  created_at: string;
  source_thread_id?: string | null;
};

/** Memories the Hermes companion saved for an agent profile, newest first. */
export function listHermesMemories(
  userId: string,
  modelId: string,
  options: ApiMutationOptions = {},
): Promise<HermesMemory[]> {
  return apiRequest<HermesMemory[]>(
    userId,
    `/api/admin/agent-profiles/${pathId(modelId)}/hermes-memories`,
    { signal: options.signal },
  );
}

export function deleteHermesMemory(
  userId: string,
  modelId: string,
  memoryId: string,
  options: ApiMutationOptions = {},
): Promise<{ status: string; id: string }> {
  return apiRequest(
    userId,
    `/api/admin/agent-profiles/${pathId(modelId)}/hermes-memories/${pathId(memoryId)}`,
    { method: "DELETE", signal: options.signal },
  );
}

export function updateAdminAgentProfile(
  userId: string,
  modelId: string,
  payload: PlatformModelUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<ModelConfig> {
  return apiRequest<ModelConfig>(userId, `/api/admin/agent-profiles/${pathId(modelId)}`, {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  }).then(mapModelConfigRecordToDisplay);
}

export function deleteAdminAgentProfile(
  userId: string,
  modelId: string,
  options: ApiMutationOptions = {},
): Promise<{ status: string; id: string }> {
  return apiRequest<{ status: string; id: string }>(userId, `/api/admin/agent-profiles/${pathId(modelId)}`, {
    method: "DELETE",
    signal: options.signal,
  });
}

export function listAdminAuditEvents(
  userId: string,
  options: ApiMutationOptions & { limit?: number } = {},
): Promise<AuditEvent[]> {
  const query = options.limit ? `?limit=${options.limit}` : "";
  return apiRequest<AuditEvent[]>(userId, `/api/admin/audit-events${query}`, {
    signal: options.signal,
  });
}

export function listAdminPromptActivity(
  userId: string,
  options: ApiMutationOptions & { targetUserId?: string; threadId?: string; limit?: number } = {},
): Promise<UserPromptRecord[]> {
  const params = new URLSearchParams();
  if (options.targetUserId) params.set("user_id", options.targetUserId);
  if (options.threadId) params.set("thread_id", options.threadId);
  if (options.limit) params.set("limit", String(options.limit));
  const query = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<UserPromptRecord[]>(userId, `/api/admin/prompt-activity${query}`, {
    signal: options.signal,
  });
}

export function listAdminSecurityAlerts(
  userId: string,
  options: ApiMutationOptions & {
    targetUserId?: string;
    includeAcknowledged?: boolean;
    limit?: number;
  } = {},
): Promise<SecurityAlert[]> {
  const params = new URLSearchParams();
  if (options.targetUserId) params.set("user_id", options.targetUserId);
  if (options.includeAcknowledged !== undefined) {
    params.set("include_acknowledged", String(options.includeAcknowledged));
  }
  if (options.limit) params.set("limit", String(options.limit));
  const query = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<SecurityAlert[]>(userId, `/api/admin/security-alerts${query}`, {
    signal: options.signal,
  });
}

export function updateAdminSecurityAlert(
  userId: string,
  alertId: string,
  payload: { acknowledged: boolean },
  options: ApiMutationOptions = {},
): Promise<SecurityAlert> {
  return apiRequest<SecurityAlert>(userId, `/api/admin/security-alerts/${pathId(alertId)}`, {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

export function getAdminUsageSummary(
  userId: string,
  options: ApiMutationOptions & { targetUserId?: string; fromDate?: string; throughDate?: string } = {},
): Promise<UsageSummary> {
  const params = new URLSearchParams();
  if (options.targetUserId) params.set("user_id", options.targetUserId);
  if (options.fromDate) params.set("from_date", options.fromDate);
  if (options.throughDate) params.set("through_date", options.throughDate);
  const query = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<UsageSummary>(userId, `/api/admin/usage-summary${query}`, {
    signal: options.signal,
  });
}

export function listAdminUsageRecords(
  userId: string,
  options: ApiMutationOptions & { targetUserId?: string; limit?: number } = {},
): Promise<UsageRecord[]> {
  const params = new URLSearchParams();
  if (options.targetUserId) params.set("user_id", options.targetUserId);
  if (options.limit) params.set("limit", String(options.limit));
  const query = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<UsageRecord[]>(userId, `/api/admin/usage-records${query}`, {
    signal: options.signal,
  });
}

export function listAdminAlertRules(userId: string, options: ApiMutationOptions = {}): Promise<AlertRule[]> {
  return apiRequest<AlertRule[]>(userId, "/api/admin/alert-rules", { signal: options.signal });
}

export function createAdminAlertRule(
  userId: string,
  payload: AlertRuleCreateRequest,
  options: ApiMutationOptions = {},
): Promise<AlertRule> {
  return apiRequest<AlertRule>(userId, "/api/admin/alert-rules", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function updateAdminAlertRule(
  userId: string,
  ruleId: string,
  payload: AlertRuleUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<AlertRule> {
  return apiRequest<AlertRule>(userId, `/api/admin/alert-rules/${pathId(ruleId)}`, {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

export function deleteAdminAlertRule(
  userId: string,
  ruleId: string,
  options: ApiMutationOptions = {},
): Promise<void> {
  return apiRequest<void>(userId, `/api/admin/alert-rules/${pathId(ruleId)}`, {
    method: "DELETE",
    signal: options.signal,
  });
}

export function listAdminAlertNotifications(
  userId: string,
  options: ApiMutationOptions & { limit?: number } = {},
): Promise<AlertNotification[]> {
  const query = options.limit ? `?limit=${options.limit}` : "";
  return apiRequest<AlertNotification[]>(userId, `/api/admin/alert-notifications${query}`, {
    signal: options.signal,
  });
}

export function setAdminAlertNotificationArchived(
  userId: string,
  notificationId: string,
  archived: boolean,
  options: ApiMutationOptions = {},
): Promise<AlertNotification> {
  return apiRequest<AlertNotification>(
    userId,
    `/api/admin/alert-notifications/${encodeURIComponent(notificationId)}`,
    {
      method: "PATCH",
      body: { archived },
      signal: options.signal,
    },
  );
}

export function getAdminAlertEmailStatus(
  userId: string,
  options: ApiMutationOptions = {},
): Promise<AlertEmailStatus> {
  return apiRequest<AlertEmailStatus>(userId, "/api/admin/alert-email-status", {
    signal: options.signal,
  });
}

export function createAdminConnectorConfig(
  userId: string,
  payload: AdminConnectorConfigCreateRequest,
  options: ApiMutationOptions = {},
): Promise<ConnectorConfigRecord> {
  return apiRequest<ConnectorConfigRecord>(userId, "/api/admin/connector-configs", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function updateAdminConnectorConfig(
  userId: string,
  configId: string,
  payload: AdminConnectorConfigUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<ConnectorConfigRecord> {
  return apiRequest<ConnectorConfigRecord>(userId, `/api/admin/connector-configs/${pathId(configId)}`, {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

export type ConnectorTestResult = SsoTestResult;

/** Live-verifies connector credentials server-side (token acquisition + API probe). */
export function testAdminConnectorConfig(
  userId: string,
  configId: string,
  options: ApiMutationOptions = {},
): Promise<ConnectorTestResult> {
  return apiRequest<ConnectorTestResult>(userId, `/api/admin/connector-configs/${pathId(configId)}/test`, {
    method: "POST",
    signal: options.signal,
  });
}

export function createAdminSsoConfig(
  userId: string,
  payload: AdminSsoConfigCreateRequest,
  options: ApiMutationOptions = {},
): Promise<SsoConfigRecord> {
  return apiRequest<SsoConfigRecord>(userId, "/api/admin/sso-configs", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export type SsoTestCheck = { name: string; status: string; detail: string };

export type SsoTestResult = {
  status: "ok" | "incomplete" | "failed" | "unsupported";
  message: string;
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
  checks?: SsoTestCheck[];
};

/** Live-verifies an OIDC configuration server-side (discovery document + JWKS). */
export function testAdminSsoConfig(
  userId: string,
  configId: string,
  options: ApiMutationOptions = {},
): Promise<SsoTestResult> {
  return apiRequest<SsoTestResult>(userId, `/api/admin/sso-configs/${pathId(configId)}/test`, {
    method: "POST",
    signal: options.signal,
  });
}

export function updateAdminSsoConfig(
  userId: string,
  configId: string,
  payload: AdminSsoConfigUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<SsoConfigRecord> {
  return apiRequest<SsoConfigRecord>(userId, `/api/admin/sso-configs/${pathId(configId)}`, {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

export function deleteAdminSsoConfig(
  userId: string,
  configId: string,
  options: ApiMutationOptions = {},
): Promise<void> {
  return apiRequest<void>(userId, `/api/admin/sso-configs/${pathId(configId)}`, {
    method: "DELETE",
    signal: options.signal,
  });
}

export function createAdminKnowledgeConfig(
  userId: string,
  payload: AdminKnowledgeConfigCreateRequest,
  options: ApiMutationOptions = {},
): Promise<KnowledgeConfigRecord> {
  return apiRequest<KnowledgeConfigRecord>(userId, "/api/admin/knowledge-configs", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function updateAdminKnowledgeConfig(
  userId: string,
  configId: string,
  payload: AdminKnowledgeConfigUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<KnowledgeConfigRecord> {
  return apiRequest<KnowledgeConfigRecord>(userId, `/api/admin/knowledge-configs/${pathId(configId)}`, {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

export function deleteAdminKnowledgeConfig(
  userId: string,
  configId: string,
  options: ApiMutationOptions = {},
): Promise<{ status: string; id: string }> {
  return apiRequest<{ status: string; id: string }>(userId, `/api/admin/knowledge-configs/${pathId(configId)}`, {
    method: "DELETE",
    signal: options.signal,
  });
}

export function createAdminToolConfig(
  userId: string,
  payload: AdminToolConfigCreateRequest,
  options: ApiMutationOptions = {},
): Promise<ToolConfigRecord> {
  return apiRequest<ToolConfigRecord>(userId, "/api/admin/tool-configs", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function updateAdminToolConfig(
  userId: string,
  configId: string,
  payload: AdminToolConfigUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<ToolConfigRecord> {
  return apiRequest<ToolConfigRecord>(userId, `/api/admin/tool-configs/${pathId(configId)}`, {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

export function deleteAdminToolConfig(
  userId: string,
  configId: string,
  options: ApiMutationOptions = {},
): Promise<{ status: string; id: string }> {
  return apiRequest<{ status: string; id: string }>(userId, `/api/admin/tool-configs/${pathId(configId)}`, {
    method: "DELETE",
    signal: options.signal,
  });
}

export function listAdminContentFilters(userId: string): Promise<ContentFilter[]> {
  return apiRequest<ContentFilter[]>(userId, "/api/admin/content-filters");
}

export function createAdminContentFilter(
  userId: string,
  payload: AdminContentFilterCreateRequest,
  options: ApiMutationOptions = {},
): Promise<ContentFilter> {
  return apiRequest<ContentFilter>(userId, "/api/admin/content-filters", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function updateAdminContentFilter(
  userId: string,
  filterId: string,
  payload: AdminContentFilterUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<ContentFilter> {
  return apiRequest<ContentFilter>(userId, `/api/admin/content-filters/${pathId(filterId)}`, {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

export function deleteAdminContentFilter(
  userId: string,
  filterId: string,
  options: ApiMutationOptions = {},
): Promise<{ status: string; id: string }> {
  return apiRequest<{ status: string; id: string }>(userId, `/api/admin/content-filters/${pathId(filterId)}`, {
    method: "DELETE",
    signal: options.signal,
  });
}

export function previewAdminContentFilter(
  userId: string,
  payload: { rules: ContentFilterRule[]; sample: string },
  options: ApiMutationOptions = {},
): Promise<ContentFilterPreviewResult> {
  return apiRequest<ContentFilterPreviewResult>(userId, "/api/admin/content-filters/preview", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function updateAdminModelContentFilters(
  userId: string,
  modelId: string,
  contentFilterIds: string[],
  options: ApiMutationOptions = {},
): Promise<ModelConfig> {
  return apiRequest<ModelConfig>(userId, `/api/admin/model-access/${pathId(modelId)}/content-filters`, {
    method: "PUT",
    body: { content_filter_ids: contentFilterIds },
    signal: options.signal,
  });
}

export function createAdminPromptTemplate(
  userId: string,
  payload: AdminPromptTemplateCreateRequest,
  options: ApiMutationOptions = {},
): Promise<PromptTemplate> {
  return apiRequest<PromptTemplate>(userId, "/api/admin/prompt-templates", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function updateAdminPromptTemplate(
  userId: string,
  templateId: string,
  payload: AdminPromptTemplateUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<PromptTemplate> {
  return apiRequest<PromptTemplate>(userId, `/api/admin/prompt-templates/${pathId(templateId)}`, {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

export function deleteAdminPromptTemplate(
  userId: string,
  templateId: string,
  options: ApiMutationOptions = {},
): Promise<{ status: string; id: string }> {
  return apiRequest<{ status: string; id: string }>(userId, `/api/admin/prompt-templates/${pathId(templateId)}`, {
    method: "DELETE",
    signal: options.signal,
  });
}

export function createAdminSkillFile(
  userId: string,
  payload: AdminSkillFileCreateRequest,
  options: ApiMutationOptions = {},
): Promise<SkillFile> {
  return apiRequest<SkillFile>(userId, "/api/admin/skill-files", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function updateAdminSkillFile(
  userId: string,
  skillId: string,
  payload: AdminSkillFileUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<SkillFile> {
  return apiRequest<SkillFile>(userId, `/api/admin/skill-files/${pathId(skillId)}`, {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

export function deleteAdminSkillFile(
  userId: string,
  skillId: string,
  options: ApiMutationOptions = {},
): Promise<{ status: string; id: string }> {
  return apiRequest<{ status: string; id: string }>(userId, `/api/admin/skill-files/${pathId(skillId)}`, {
    method: "DELETE",
    signal: options.signal,
  });
}

/**
 * Read-only tenant budget view for tenant admins. The tenant scope comes from
 * the signed-in admin's own account server-side; no tenant header is sent.
 * Shares the platform snapshot shape and Retry-After-aware error handling so
 * 429 semantics surface honestly instead of triggering client retries.
 */
export function getAdminUsageBudget(
  userId: string,
  options: ApiMutationOptions = {},
): Promise<TenantUsageBudgetSnapshot> {
  return usageBudgetRequest<TenantUsageBudgetSnapshot>(userId, "/api/admin/usage-budget", {
    signal: options.signal,
  });
}

/** One user/group token allocation inside the workspace ceiling. */
export type UsageAllocation = {
  principal_type: "user" | "group";
  principal_id: string;
  display_name: string;
  budget_period: "day" | "week" | "month";
  daily_token_limit: number;
  period_start: string;
  period_end: string;
  reported_tokens: number;
  metered_completions: number;
  updated_at: string;
  updated_by: string | null;
};

export type UsageAllocationsSnapshot = {
  usage_date: string;
  budget_unit: "tokens" | "usd";
  budget_period: "day" | "week" | "month";
  limit_value: number;
  daily_token_limit: number;
  allocations: UsageAllocation[];
};

export function getAdminUsageAllocations(
  userId: string,
  options: ApiMutationOptions = {},
): Promise<UsageAllocationsSnapshot> {
  return usageBudgetRequest<UsageAllocationsSnapshot>(userId, "/api/admin/usage-allocations", {
    signal: options.signal,
  });
}

export function setAdminUsageAllocation(
  userId: string,
  payload: {
    principal_type: "user" | "group";
    principal_id: string;
    budget_period: "day" | "week" | "month";
    daily_token_limit: number;
  },
  options: ApiMutationOptions = {},
): Promise<unknown> {
  return usageBudgetRequest(userId, "/api/admin/usage-allocations", {
    method: "PUT",
    body: payload,
    signal: options.signal,
  });
}

export function deleteAdminUsageAllocation(
  userId: string,
  principalType: "user" | "group",
  principalId: string,
  options: ApiMutationOptions = {},
): Promise<unknown> {
  return usageBudgetRequest(
    userId,
    `/api/admin/usage-allocations/${principalType}/${encodeURIComponent(principalId)}`,
    { method: "DELETE", signal: options.signal },
  );
}

export function listAdminChatFeedback(
  userId: string,
  options: ApiMutationOptions & { limit?: number } = {},
): Promise<ChatFeedbackRecord[]> {
  const query = options.limit ? `?limit=${options.limit}` : "";
  return apiRequest<ChatFeedbackRecord[]>(userId, `/api/admin/chat-feedback${query}`, {
    signal: options.signal,
  });
}

// --- data retention: policy and content-free tagged-thread drilldown --------

export function getAdminRetentionPolicy(
  userId: string,
  options: ApiMutationOptions = {},
): Promise<TenantRetentionPolicy> {
  return apiRequest<TenantRetentionPolicy>(userId, "/api/admin/retention/policy", {
    signal: options.signal,
  });
}

export function updateAdminRetentionPolicy(
  userId: string,
  payload: TenantRetentionPolicyUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<TenantRetentionPolicy> {
  return apiRequest<TenantRetentionPolicy>(userId, "/api/admin/retention/policy", {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

export function listAdminRetentionTaggedThreads(
  userId: string,
  options: ApiMutationOptions & { namespace?: string } = {},
): Promise<RetentionTaggedThread[]> {
  const query = options.namespace ? `?namespace=${encodeURIComponent(options.namespace)}` : "";
  return apiRequest<RetentionTaggedThread[]>(
    userId,
    `/api/admin/retention/tagged-threads${query}`,
    { signal: options.signal },
  );
}

export function listAdminRetentionThreads(
  userId: string,
  options: ApiMutationOptions & { limit?: number } = {},
): Promise<RetentionTaggedThread[]> {
  const query = options.limit ? `?limit=${options.limit}` : "";
  return apiRequest<RetentionTaggedThread[]>(userId, `/api/admin/retention/threads${query}`, {
    signal: options.signal,
  });
}

export function runAdminRetentionBatch(
  userId: string,
  payload: RetentionBatchRequest,
  options: ApiMutationOptions = {},
): Promise<RetentionBatchResult> {
  return apiRequest<RetentionBatchResult>(userId, "/api/admin/retention/batch", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}
