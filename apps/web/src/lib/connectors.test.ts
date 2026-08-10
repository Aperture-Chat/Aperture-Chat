import { expect, test } from "vitest";
import { sampleData } from "../data/sampleData";
import { connectorEnabled } from "./connectors";
import { mapConnectorCatalogWithConfigs } from "./api/bootstrap";
import type { Connector } from "./types";

function connector(id: string, overrides: Partial<Connector> = {}): Connector {
  return {
    ...(sampleData.connectors.find((item) => item.id === "mcp") as Connector),
    id,
    name: id,
    ...overrides,
  };
}

test("connectorEnabled requires both the platform and tenant switches", () => {
  expect(connectorEnabled([connector("mcp")], "mcp")).toBe(true);
  expect(connectorEnabled([connector("mcp", { tenant_enabled: false })], "mcp")).toBe(false);
  expect(connectorEnabled([connector("mcp", { platform_enabled: false })], "mcp")).toBe(false);
  // Ids without a governing switch default to available.
  expect(connectorEnabled([], "mcp")).toBe(true);
});

test("switch connectors keep their catalog state without a tenant config record", () => {
  const mapped = mapConnectorCatalogWithConfigs(
    [
      connector("mcp", { tenant_enabled: false }),
      connector("prompt-library", { tenant_enabled: true }),
      connector("box", { tenant_enabled: true }),
    ],
    [],
  );
  const byId = new Map(mapped.map((item) => [item.id, item]));
  // The admin switch is the record of truth for capability connectors —
  // off stays off and on stays on.
  expect(byId.get("mcp")?.tenant_enabled).toBe(false);
  expect(byId.get("prompt-library")?.tenant_enabled).toBe(true);
  // Credential connectors without a tenant record still read as not set up.
  expect(byId.get("box")?.tenant_enabled).toBe(false);
  expect(byId.get("box")?.auth_status).toBe("needs-admin");
});
