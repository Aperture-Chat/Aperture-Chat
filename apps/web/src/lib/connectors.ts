import type { Connector, ToolConfig } from "./types";

/** Workspace kill switches: a connector must be enabled by BOTH the platform
 * owner and the tenant admin before users get the capability. Ids without a
 * governing switch default to available. */
export function connectorEnabled(connectors: Connector[], connectorId: string): boolean {
  const connector = connectors.find((item) => item.id === connectorId);
  if (!connector) return true;
  return connector.platform_enabled && connector.tenant_enabled;
}

/** True when a tool executes through the MCP runtime (and is therefore
 * governed by the "MCP Servers" workspace switch). */
export function isMcpRuntimeTool(tool: ToolConfig): boolean {
  if (tool.type === "mcp") return true;
  const endpoint = tool.endpoint?.toLowerCase() ?? "";
  const transport = tool.transport?.toLowerCase() ?? "";
  return Boolean(
    endpoint.startsWith("mcp://") ||
    endpoint.startsWith("stdio://") ||
    transport === "stdio" ||
    transport === "sse" ||
    transport === "http" ||
    tool.command,
  );
}
