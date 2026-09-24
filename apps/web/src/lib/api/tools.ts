import { apiBase, apiRequest, pathId, type ApiMutationOptions } from "./http";
import type {
  CustomScriptRunResult,
  McpHealthResult,
  McpToolCallRequest,
  McpToolCallResult,
  ToolConfig,
  ToolConfigRecord,
  User,
} from "../types";

export function runCustomScriptTool(
  userId: string,
  toolId: string,
  input: string,
  options: ApiMutationOptions = {},
): Promise<CustomScriptRunResult> {
  return apiRequest<CustomScriptRunResult>(userId, `/api/tools/${pathId(toolId)}/run-script`, {
    method: "POST",
    body: { input },
    signal: options.signal,
  });
}

export function previewAdminToolScript(
  userId: string,
  payload: { script: string; input: string; timeout_seconds: number },
  options: ApiMutationOptions = {},
): Promise<CustomScriptRunResult> {
  return apiRequest<CustomScriptRunResult>(userId, "/api/admin/tool-configs/script-preview", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function toolOAuthCallbackUrl(configId: string): string {
  return `${apiBase}/api/tools/${pathId(configId)}/oauth/callback`;
}

/** The provider redirect URL as an absolute address. With an empty
 * VITE_API_BASE_URL the API shares the web origin, so the relative path is
 * resolved against the current site; providers reject relative URLs. */
export function toolOAuthRedirectUrl(configId: string): string {
  const path = toolOAuthCallbackUrl(configId);
  try {
    return new URL(path, window.location.origin).toString();
  } catch {
    return path;
  }
}

export type ToolOAuthAuthorizeResponse = {
  authorize_url: string;
  state: string;
  redirect_uri?: string;
};

/** Ask the API for a provider sign-in URL carrying server-signed state; the
 * callback rejects any state it did not mint. Admins only. */
export function getToolOAuthAuthorizeUrl(
  userId: string,
  configId: string,
  options: ApiMutationOptions = {},
): Promise<ToolOAuthAuthorizeResponse> {
  return apiRequest<ToolOAuthAuthorizeResponse>(
    userId,
    `/api/tools/${pathId(configId)}/oauth/authorize-url`,
    { signal: options.signal },
  );
}

/** Disconnect a tool from its OAuth provider (deletes the stored token). */
export function clearToolOAuthToken(userId: string, configId: string): Promise<ToolConfigRecord> {
  return apiRequest<ToolConfigRecord>(userId, `/api/tools/${pathId(configId)}/oauth/token`, {
    method: "DELETE",
  });
}

/** Remove a tool's saved access token / client secret from the vault. */
export function clearToolSecret(userId: string, configId: string): Promise<ToolConfigRecord> {
  return apiRequest<ToolConfigRecord>(userId, `/api/admin/tool-configs/${pathId(configId)}/secret`, {
    method: "DELETE",
  });
}

/** The admin tool catalog, used to refresh a record after an out-of-band
 * change such as a provider sign-in finishing in another window. */
export function listAdminToolConfigs(userId: string): Promise<ToolConfigRecord[]> {
  return apiRequest<ToolConfigRecord[]>(userId, "/api/admin/tool-configs");
}

/** Client mirror of the API's tool_access_allowed policy (app/core/policy.py):
 * whether `user` may use `tool` in chat and agents. The server stays the
 * authority; this only keeps the client from requesting tools it will skip. */
export function toolUsableBy(user: Pick<User, "id" | "role" | "group_ids" | "tenant_id">, tool: ToolConfig): boolean {
  if (!tool.enabled) return false;
  if (user.role === "PLATFORM_OWNER") return true;
  const allowedGroups = tool.allowed_group_ids ?? [];
  if (user.role !== "TENANT_ADMIN" && (user.group_ids ?? []).length === 0) return false;
  if (allowedGroups.length > 0 && !allowedGroups.some((groupId) => (user.group_ids ?? []).includes(groupId))) {
    return false;
  }
  if (tool.owner_user_id && allowedGroups.length === 0) {
    return tool.owner_user_id === user.id || user.role === "TENANT_ADMIN";
  }
  return true;
}

// Exchange a user's approval of an approval-required MCP tool for a short-lived
// signed token the chat runtime accepts as proof of approval.
export async function approveMcpTool(userId: string, configId: string): Promise<string> {
  const response = await apiRequest<{
    tool_config_id: string;
    name: string;
    approval_token: string;
  }>(userId, `/api/tools/${pathId(configId)}/approve`, { method: "POST" });
  return response.approval_token;
}

export function checkToolMcpHealth(
  userId: string,
  configId: string,
  options: ApiMutationOptions = {},
): Promise<McpHealthResult> {
  return apiRequest<McpHealthResult>(userId, `/api/tools/${pathId(configId)}/mcp/health`, {
    method: "POST",
    signal: options.signal,
  });
}

export function callToolMcp(
  userId: string,
  configId: string,
  payload: McpToolCallRequest,
  options: ApiMutationOptions = {},
): Promise<McpToolCallResult> {
  return apiRequest<McpToolCallResult>(userId, `/api/tools/${pathId(configId)}/mcp/call`, {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}
