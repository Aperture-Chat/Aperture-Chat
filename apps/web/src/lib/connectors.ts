import type { Connector, ToolConfig } from "./types";

/** The platform owner's ceiling over every workspace: both catalog flags. */
export function connectorDeploymentAllowed(connector: Connector): boolean {
  return connector.deployment_enabled ?? (connector.platform_enabled && connector.tenant_enabled);
}

/** A connector is reachable in this workspace only when the platform ceiling
 * is open and the workspace's own switch is on. */
export function connectorSwitchedOn(connector: Connector): boolean {
  return connectorDeploymentAllowed(connector) && connector.tenant_enabled;
}

/** Workspace kill switches: a connector must be allowed by the platform owner
 * and switched on by the workspace admins before users get the capability.
 * Ids without a governing switch default to available. */
export function connectorEnabled(connectors: Connector[], connectorId: string): boolean {
  const connector = connectors.find((item) => item.id === connectorId);
  if (!connector) return true;
  return connectorSwitchedOn(connector);
}

/** Cloud file sources the workspace admins took out of the attach menus. The
 * API refuses them too, so leaving them out is the honest menu. */
export function connectorHidden(connectors: Connector[], connectorId: string): boolean {
  return Boolean(connectors.find((item) => item.id === connectorId)?.hidden);
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
