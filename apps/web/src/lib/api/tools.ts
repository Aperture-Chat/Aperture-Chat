import { apiBase, apiRequest, pathId, type ApiMutationOptions } from "./http";
import type {
  CustomScriptRunResult,
  McpHealthResult,
  McpToolCallRequest,
  McpToolCallResult,
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
