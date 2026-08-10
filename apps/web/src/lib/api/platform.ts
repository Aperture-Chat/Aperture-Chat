import { apiBase, apiRequest, authHeaders, pathId, readApiError, type ApiMutationOptions } from "./http";
import { mapModelConfigRecordToDisplay } from "./bootstrap";
import type {
  AlertNotification,
  AlertRule,
  AlertRuleCreateRequest,
  AlertRuleUpdateRequest,
  AuditEvent,
  Connector,
  ElasticStatus,
  EmailSettings,
  EmailSettingsUpdateRequest,
  EmailTestResult,
  ModelConfig,
  PlatformModelCreateRequest,
  PlatformModelUpdateRequest,
  PlatformProviderCreateRequest,
  PlatformProviderKeyCreateRequest,
  PlatformProviderUpdateRequest,
  PlatformSettings,
  PlatformSettingsUpdateRequest,
  Provider,
  ProviderKey,
  ProviderKeySecret,
  ProviderModelSyncResult,
  SecurityAlert,
  Tenant,
  TenantBrandingUpdateRequest,
  UsageRecord,
  UsageSummary,
  UserPromptRecord,
} from "../types";

// --- Tenant lifecycle -------------------------------------------------------
// Response shapes mirror services/api/app/routes/platform.py. These types are
// deliberately local to this module: the tenant admin surface is owned by the
// platform console and nothing else consumes them yet.

/** `GET /api/platform/tenants` row: tenant identity plus scoped counters. */
export type PlatformTenantSummary = Tenant & {
  user_count: number;
  group_count: number;
  /** Active (non-revoked) SCIM tokens for this tenant. */
  scim_token_count: number;
};

export type PlatformTenantCreateRequest = {
  id?: string;
  name: string;
  slug: string;
  custom_domain?: string | null;
  primary_color?: string;
  logo_mark?: string;
  chat_brand_name?: string | null;
};

export type PlatformTenantUpdateRequest = {
  name?: string;
  slug?: string;
  custom_domain?: string | null;
};

/** List rows never carry the bearer value or its hash — only this metadata. */
export type ScimTokenSummary = {
  id: string;
  tenant_id: string;
  token_prefix: string;
  created_at: string;
  created_by: string;
  revoked_at: string | null;
};

/** The bearer value appears exactly once, in the successful create response. */
export type ScimTokenCreateResponse = ScimTokenSummary & {
  secret_value: string;
};

export function listPlatformTenants(
  userId: string,
  options: ApiMutationOptions = {},
): Promise<PlatformTenantSummary[]> {
  return apiRequest<PlatformTenantSummary[]>(userId, "/api/platform/tenants", {
    signal: options.signal,
  });
}

export function createPlatformTenant(
  userId: string,
  payload: PlatformTenantCreateRequest,
  options: ApiMutationOptions = {},
): Promise<PlatformTenantSummary> {
  return apiRequest<PlatformTenantSummary>(userId, "/api/platform/tenants", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function updatePlatformTenant(
  userId: string,
  tenantId: string,
  payload: PlatformTenantUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<PlatformTenantSummary> {
  return apiRequest<PlatformTenantSummary>(userId, `/api/platform/tenants/${pathId(tenantId)}`, {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

/** The backend rejects deleting the final tenant with HTTP 409; surface it. */
export function deletePlatformTenant(
  userId: string,
  tenantId: string,
  options: ApiMutationOptions = {},
): Promise<{ status: string; id: string }> {
  return apiRequest<{ status: string; id: string }>(userId, `/api/platform/tenants/${pathId(tenantId)}`, {
    method: "DELETE",
    signal: options.signal,
  });
}

export function listPlatformScimTokens(
  userId: string,
  tenantId: string,
  options: ApiMutationOptions = {},
): Promise<ScimTokenSummary[]> {
  return apiRequest<ScimTokenSummary[]>(userId, `/api/platform/tenants/${pathId(tenantId)}/scim-tokens`, {
    signal: options.signal,
  });
}

export function createPlatformScimToken(
  userId: string,
  tenantId: string,
  options: ApiMutationOptions = {},
): Promise<ScimTokenCreateResponse> {
  return apiRequest<ScimTokenCreateResponse>(userId, `/api/platform/tenants/${pathId(tenantId)}/scim-tokens`, {
    method: "POST",
    signal: options.signal,
  });
}

export function revokePlatformScimToken(
  userId: string,
  tenantId: string,
  tokenId: string,
  options: ApiMutationOptions = {},
): Promise<ScimTokenSummary> {
  return apiRequest<ScimTokenSummary>(
    userId,
    `/api/platform/tenants/${pathId(tenantId)}/scim-tokens/${pathId(tokenId)}`,
    { method: "DELETE", signal: options.signal },
  );
}

// --- Tenant usage budgets ---------------------------------------------------

/**
 * Budget snapshot returned by both `GET/PATCH /api/platform/usage-budget` and
 * the tenant-admin read-only `GET /api/admin/usage-budget`. Period boundaries
 * are UTC. Tokens and spend are provider-reported only; missing values remain
 * explicitly unmetered instead of being estimated.
 */
export type TenantUsageBudgetSnapshot = {
  tenant_id: string;
  budget_unit: "tokens" | "usd";
  budget_period: "day" | "week" | "month";
  limit_value: number;
  daily_token_limit: number;
  spend_limit_nanos: number;
  updated_at: string;
  updated_by: string | null;
  usage_date: string;
  period_start: string;
  period_end: string;
  reported_tokens: number;
  reported_tokens_overflowed: boolean;
  reported_cost_nanos: number;
  reported_cost_usd: number;
  reported_cost_overflowed: boolean;
  metered_completions: number;
  unmetered_completions: number;
  cost_metered_completions: number;
  cost_unmetered_completions: number;
};

/**
 * Budget request failure that preserves the backend's 429 semantics: when the
 * API rejects with `Retry-After`, the parsed seconds ride along so the UI can
 * state the real wait honestly. Callers must not auto-retry.
 */
export class UsageBudgetRequestError extends Error {
  status?: number;
  retryAfterSeconds: number | null;
  constructor(message: string, status?: number, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "UsageBudgetRequestError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Shared low-level budget request. `apiRequest` cannot carry the
 * `X-Aperture-Tenant` header or surface `Retry-After`, so budget endpoints go
 * through this thin fetch wrapper instead.
 */
export async function usageBudgetRequest<ResponseBody>(
  userId: string,
  path: string,
  init: { method?: "GET" | "PATCH" | "PUT" | "DELETE"; body?: unknown; tenantSlug?: string; signal?: AbortSignal } = {},
): Promise<ResponseBody> {
  const headers: Record<string, string> = authHeaders(userId);
  if (init.tenantSlug !== undefined) headers["X-Aperture-Tenant"] = init.tenantSlug;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new UsageBudgetRequestError("The request was cancelled before the API responded.");
    }
    throw new UsageBudgetRequestError("Could not reach the API. Check your connection and try again.");
  }

  if (!response.ok) {
    const retryAfterRaw = response.headers.get("Retry-After");
    const retryAfterSeconds = retryAfterRaw === null ? Number.NaN : Number.parseInt(retryAfterRaw, 10);
    throw new UsageBudgetRequestError(
      await readApiError(response),
      response.status,
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
    );
  }
  return (await response.json()) as ResponseBody;
}

/**
 * The backend requires `X-Aperture-Tenant` on every platform budget request —
 * there is deliberately no first-tenant or single-tenant fallback, so an empty
 * slug is rejected client-side before any request is sent.
 */
function requiredTenantSlug(tenantSlug: string): string {
  const normalized = tenantSlug.trim();
  if (!normalized) {
    throw new UsageBudgetRequestError("Select a tenant before reading or changing its usage budget.");
  }
  return normalized;
}

export async function getPlatformUsageBudget(
  userId: string,
  tenantSlug: string,
  options: ApiMutationOptions = {},
): Promise<TenantUsageBudgetSnapshot> {
  return usageBudgetRequest<TenantUsageBudgetSnapshot>(userId, "/api/platform/usage-budget", {
    tenantSlug: requiredTenantSlug(tenantSlug),
    signal: options.signal,
  });
}

export async function updatePlatformUsageBudget(
  userId: string,
  tenantSlug: string,
  payload: {
    budget_unit: "tokens" | "usd";
    budget_period: "day" | "week" | "month";
    limit_value: number;
  },
  options: ApiMutationOptions = {},
): Promise<TenantUsageBudgetSnapshot> {
  return usageBudgetRequest<TenantUsageBudgetSnapshot>(userId, "/api/platform/usage-budget", {
    method: "PATCH",
    body: payload,
    tenantSlug: requiredTenantSlug(tenantSlug),
    signal: options.signal,
  });
}

export function createPlatformProvider(
  userId: string,
  payload: PlatformProviderCreateRequest,
  options: ApiMutationOptions = {},
): Promise<Provider> {
  return apiRequest<Provider>(userId, "/api/platform/providers", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function updatePlatformProvider(
  userId: string,
  providerId: string,
  payload: PlatformProviderUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<Provider> {
  return apiRequest<Provider>(userId, `/api/platform/providers/${pathId(providerId)}`, {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

export function syncProviderModels(
  userId: string,
  providerId: string,
  options: ApiMutationOptions = {},
): Promise<ProviderModelSyncResult> {
  return apiRequest<ProviderModelSyncResult>(userId, `/api/platform/providers/${pathId(providerId)}/sync-models`, {
    method: "POST",
    signal: options.signal,
  }).then((result) => ({
    ...result,
    models: result.models.map(mapModelConfigRecordToDisplay),
  }));
}

export function revealProviderKey(
  userId: string,
  keyId: string,
  options: ApiMutationOptions = {},
): Promise<ProviderKeySecret> {
  return apiRequest<ProviderKeySecret>(userId, `/api/platform/provider-keys/${pathId(keyId)}/reveal`, {
    method: "POST",
    signal: options.signal,
  });
}

export function createProviderKey(
  userId: string,
  payload: PlatformProviderKeyCreateRequest,
  options: ApiMutationOptions = {},
): Promise<ProviderKey> {
  return apiRequest<ProviderKey>(userId, "/api/platform/provider-keys", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function rotateProviderKey(
  userId: string,
  keyId: string,
  options: ApiMutationOptions = {},
): Promise<ProviderKey> {
  return apiRequest<ProviderKey>(userId, `/api/platform/provider-keys/${pathId(keyId)}/rotate`, {
    method: "POST",
    signal: options.signal,
  });
}

export function deleteProviderKey(userId: string, keyId: string, options: ApiMutationOptions = {}): Promise<void> {
  return apiRequest<void>(userId, `/api/platform/provider-keys/${pathId(keyId)}`, {
    method: "DELETE",
    signal: options.signal,
  });
}

/** Permanently deletes a provider with its models and stored keys. `confirm`
 * must repeat the provider name exactly; the API rejects anything else. */
export function deletePlatformProvider(
  userId: string,
  providerId: string,
  confirm: string,
  options: ApiMutationOptions = {},
): Promise<{ status: string; id: string; models_deleted: number; keys_deleted: number }> {
  return apiRequest(userId, `/api/platform/providers/${pathId(providerId)}?confirm=${encodeURIComponent(confirm)}`, {
    method: "DELETE",
    signal: options.signal,
  });
}

export function listPlatformAuditEvents(
  userId: string,
  options: ApiMutationOptions & { limit?: number } = {},
): Promise<AuditEvent[]> {
  const query = options.limit ? `?limit=${options.limit}` : "";
  return apiRequest<AuditEvent[]>(userId, `/api/platform/audit-events${query}`, {
    signal: options.signal,
  });
}

export function listPlatformPromptActivity(
  userId: string,
  options: ApiMutationOptions & { targetUserId?: string; limit?: number } = {},
): Promise<UserPromptRecord[]> {
  const params = new URLSearchParams();
  if (options.targetUserId) params.set("user_id", options.targetUserId);
  if (options.limit) params.set("limit", String(options.limit));
  const query = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<UserPromptRecord[]>(userId, `/api/platform/prompt-activity${query}`, {
    signal: options.signal,
  });
}

export function listPlatformSecurityAlerts(
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
  return apiRequest<SecurityAlert[]>(userId, `/api/platform/security-alerts${query}`, {
    signal: options.signal,
  });
}

export function updatePlatformSecurityAlert(
  userId: string,
  alertId: string,
  payload: { acknowledged: boolean },
  options: ApiMutationOptions = {},
): Promise<SecurityAlert> {
  return apiRequest<SecurityAlert>(userId, `/api/platform/security-alerts/${pathId(alertId)}`, {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

export function getPlatformUsageSummary(
  userId: string,
  options: ApiMutationOptions & { targetUserId?: string; fromDate?: string; throughDate?: string } = {},
): Promise<UsageSummary> {
  const params = new URLSearchParams();
  if (options.targetUserId) params.set("user_id", options.targetUserId);
  if (options.fromDate) params.set("from_date", options.fromDate);
  if (options.throughDate) params.set("through_date", options.throughDate);
  const query = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<UsageSummary>(userId, `/api/platform/usage-summary${query}`, {
    signal: options.signal,
  });
}

export function listPlatformUsageRecords(
  userId: string,
  options: ApiMutationOptions & { targetUserId?: string; limit?: number } = {},
): Promise<UsageRecord[]> {
  const params = new URLSearchParams();
  if (options.targetUserId) params.set("user_id", options.targetUserId);
  if (options.limit) params.set("limit", String(options.limit));
  const query = params.toString() ? `?${params.toString()}` : "";
  return apiRequest<UsageRecord[]>(userId, `/api/platform/usage-records${query}`, {
    signal: options.signal,
  });
}

export function listPlatformAlertRules(userId: string, options: ApiMutationOptions = {}): Promise<AlertRule[]> {
  return apiRequest<AlertRule[]>(userId, "/api/platform/alert-rules", { signal: options.signal });
}

export function createPlatformAlertRule(
  userId: string,
  payload: AlertRuleCreateRequest,
  options: ApiMutationOptions = {},
): Promise<AlertRule> {
  return apiRequest<AlertRule>(userId, "/api/platform/alert-rules", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function updatePlatformAlertRule(
  userId: string,
  ruleId: string,
  payload: AlertRuleUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<AlertRule> {
  return apiRequest<AlertRule>(userId, `/api/platform/alert-rules/${pathId(ruleId)}`, {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

export function deletePlatformAlertRule(
  userId: string,
  ruleId: string,
  options: ApiMutationOptions = {},
): Promise<void> {
  return apiRequest<void>(userId, `/api/platform/alert-rules/${pathId(ruleId)}`, {
    method: "DELETE",
    signal: options.signal,
  });
}

export function listPlatformAlertNotifications(
  userId: string,
  options: ApiMutationOptions & { limit?: number } = {},
): Promise<AlertNotification[]> {
  const query = options.limit ? `?limit=${options.limit}` : "";
  return apiRequest<AlertNotification[]>(userId, `/api/platform/alert-notifications${query}`, {
    signal: options.signal,
  });
}

export function setPlatformAlertNotificationArchived(
  userId: string,
  notificationId: string,
  archived: boolean,
  options: ApiMutationOptions = {},
): Promise<AlertNotification> {
  return apiRequest<AlertNotification>(
    userId,
    `/api/platform/alert-notifications/${encodeURIComponent(notificationId)}`,
    {
      method: "PATCH",
      body: { archived },
      signal: options.signal,
    },
  );
}

export function getPlatformEmailSettings(
  userId: string,
  options: ApiMutationOptions = {},
): Promise<EmailSettings> {
  return apiRequest<EmailSettings>(userId, "/api/platform/email-settings", {
    signal: options.signal,
  });
}

export function updatePlatformEmailSettings(
  userId: string,
  payload: EmailSettingsUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<EmailSettings> {
  return apiRequest<EmailSettings>(userId, "/api/platform/email-settings", {
    method: "PUT",
    body: payload,
    signal: options.signal,
  });
}

export function sendPlatformEmailTest(
  userId: string,
  payload: { recipient: string },
  options: ApiMutationOptions = {},
): Promise<EmailTestResult> {
  return apiRequest<EmailTestResult>(userId, "/api/platform/email-settings/test", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function getPlatformSettings(userId: string, options: ApiMutationOptions = {}): Promise<PlatformSettings> {
  return apiRequest<PlatformSettings>(userId, "/api/platform/settings", {
    signal: options.signal,
  });
}

export function updatePlatformSettings(
  userId: string,
  payload: PlatformSettingsUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<PlatformSettings> {
  return apiRequest<PlatformSettings>(userId, "/api/platform/settings", {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

export function updatePlatformTenantBranding(
  userId: string,
  tenantId: string,
  payload: TenantBrandingUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<Tenant> {
  return apiRequest<Tenant>(userId, `/api/platform/tenants/${pathId(tenantId)}/branding`, {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

export function getPlatformElasticStatus(userId: string, options: ApiMutationOptions = {}): Promise<ElasticStatus> {
  return apiRequest<ElasticStatus>(userId, "/api/platform/elastic/status", {
    signal: options.signal,
  });
}

export function updatePlatformConnector(
  userId: string,
  connectorId: string,
  payload: Partial<
    Pick<
      Connector,
      | "name"
      | "category"
      | "platform_enabled"
      | "tenant_enabled"
      | "configured_by"
      | "scopes"
      | "secret_visible_to_admin"
    >
  >,
  options: ApiMutationOptions = {},
): Promise<Connector> {
  return apiRequest<Connector>(userId, `/api/platform/connectors/${pathId(connectorId)}`, {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

export function createPlatformModel(
  userId: string,
  payload: PlatformModelCreateRequest,
  options: ApiMutationOptions = {},
): Promise<ModelConfig> {
  return apiRequest<ModelConfig>(userId, "/api/platform/models", {
    method: "POST",
    body: payload,
    signal: options.signal,
  }).then(mapModelConfigRecordToDisplay);
}

export function updatePlatformModel(
  userId: string,
  modelId: string,
  payload: PlatformModelUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<ModelConfig> {
  return apiRequest<ModelConfig>(userId, `/api/platform/models/${pathId(modelId)}`, {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  }).then(mapModelConfigRecordToDisplay);
}

export function deletePlatformModel(
  userId: string,
  modelId: string,
  options: ApiMutationOptions = {},
): Promise<{ status: string; id: string }> {
  return apiRequest<{ status: string; id: string }>(userId, `/api/platform/models/${pathId(modelId)}`, {
    method: "DELETE",
    signal: options.signal,
  });
}
