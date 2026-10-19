import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { sampleData } from "../data/sampleData";
import type { BootstrapData, Connector } from "../lib/types";
import { ConnectorsPanel, ConnectorUpdateError, connectorSwitchedOn, type ConnectorConfigSavePayload, type ConnectorsPanelApi, type ConnectorsPanelStatus } from "./ConnectorsPanel";

function cloneData(): BootstrapData {
  const data = structuredClone(sampleData) as BootstrapData;
  data.me.role = "PLATFORM_OWNER";
  return data;
}

function renderPanel(api: ConnectorsPanelApi, initialData = cloneData(), onStatus?: (status: ConnectorsPanelStatus) => void) {
  function Harness() {
    const [data, setData] = useState<BootstrapData>(() => initialData);
    return <ConnectorsPanel data={data} onDataChange={setData} api={api} onStatus={onStatus} />;
  }
  return render(<Harness />);
}

function connectorBlock(name: string): HTMLElement {
  return screen.getByText(name).closest(".connector-config-block") as HTMLElement;
}

test("USER has no connector management controls", () => {
  const data = cloneData();
  data.me.role = "USER";
  renderPanel({}, data);
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Configure/ })).not.toBeInTheDocument();
});

test("TENANT_ADMIN manages switches, credentials, and attach-menu visibility", () => {
  const data = cloneData();
  data.me.role = "TENANT_ADMIN";
  renderPanel({}, data);
  expect(screen.getByRole("heading", { name: "Connectors" })).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Enable Box" })).toBeInTheDocument();
  expect(within(connectorBlock("Google Drive")).getByRole("button", { name: /Configure/ })).toBeInTheDocument();
  for (const name of ["Google Drive", "OneDrive / SharePoint / Outlook", "Box", "iManage"]) {
    expect(within(connectorBlock(name)).getByRole("button", { name: `Hide ${name} from the attach menu` })).toBeInTheDocument();
  }
  // Only cloud file sources live in the attach menu, so only they can hide.
  for (const name of ["Web Search", "MCP Servers", "Prompt Library"]) {
    expect(within(connectorBlock(name)).queryByRole("button", { name: /attach menu/ })).not.toBeInTheDocument();
  }
});

test("hiding a source keeps its switch and reports what people will see", async () => {
  const data = cloneData();
  data.me.role = "TENANT_ADMIN";
  const box = data.connectors.find((connector) => connector.id === "box") as Connector;
  const switchedOn = connectorSwitchedOn(box);
  const setConnectorHidden = vi.fn(async (_connector: Connector, hidden: boolean) => ({ hidden }));
  const statuses: ConnectorsPanelStatus[] = [];
  renderPanel({ setConnectorHidden }, data, (status) => statuses.push(status));

  fireEvent.click(screen.getByRole("button", { name: "Hide Box from the attach menu" }));
  await waitFor(() =>
    expect(statuses.at(-1)).toEqual({
      tone: "success",
      message: "Box is hidden. People in this workspace no longer see it in the attach menu.",
    }),
  );
  expect(setConnectorHidden).toHaveBeenCalledWith(expect.objectContaining({ id: "box" }), true);
  const block = connectorBlock("Box");
  expect(within(block).getByText("Hidden")).toBeInTheDocument();
  expect(within(block).getByRole("button", { name: "Show Box in the attach menu" })).toHaveAttribute("aria-pressed", "true");
  expect(within(block).getByRole("switch", { name: "Enable Box" })).toHaveAttribute("aria-checked", String(switchedOn));

  fireEvent.click(within(block).getByRole("button", { name: "Show Box in the attach menu" }));
  await waitFor(() => expect(setConnectorHidden).toHaveBeenLastCalledWith(expect.objectContaining({ id: "box" }), false));
  await waitFor(() => expect(within(connectorBlock("Box")).queryByText("Hidden")).not.toBeInTheDocument());
});

test("a refused hide leaves the source visible and reports the failure", async () => {
  const data = cloneData();
  data.me.role = "TENANT_ADMIN";
  const statuses: ConnectorsPanelStatus[] = [];
  renderPanel(
    { setConnectorHidden: async () => { throw new Error("Configuration is outside your tenant."); } },
    data,
    (status) => statuses.push(status),
  );
  fireEvent.click(screen.getByRole("button", { name: "Hide iManage from the attach menu" }));
  await waitFor(() =>
    expect(statuses.at(-1)).toEqual({ tone: "warning", message: "iManage was not changed. Configuration is outside your tenant." }),
  );
  expect(within(connectorBlock("iManage")).queryByText("Hidden")).not.toBeInTheDocument();
});

test("a closed platform ceiling locks the tenant admin switch but not the owner's", () => {
  const data = cloneData();
  data.me.role = "TENANT_ADMIN";
  data.connectors = data.connectors.map((connector) =>
    connector.id === "web" ? { ...connector, deployment_enabled: false } : connector,
  );
  const adminView = renderPanel({}, data);
  expect(within(connectorBlock("Web Search")).getByText("Off for all workspaces")).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Enable Web Search" })).toBeDisabled();
  expect(screen.getByRole("switch", { name: "Enable Web Search" })).toHaveAttribute("aria-checked", "false");
  adminView.unmount();

  data.me.role = "PLATFORM_OWNER";
  renderPanel({}, data);
  expect(screen.getByRole("switch", { name: "Enable Web Search" })).toBeEnabled();
});

test("only the owner closes and reopens the ceiling for every workspace", async () => {
  const adminData = cloneData();
  adminData.me.role = "TENANT_ADMIN";
  const adminView = renderPanel({}, adminData);
  expect(screen.queryByRole("button", { name: /for every workspace|in every workspace/ })).not.toBeInTheDocument();
  adminView.unmount();

  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
  const setConnectorCeiling = vi.fn(async (_connector: Connector, allowed: boolean) => ({
    platform_enabled: allowed,
    deployment_enabled: allowed,
  }));
  const statuses: ConnectorsPanelStatus[] = [];
  renderPanel({ setConnectorCeiling }, cloneData(), (status) => statuses.push(status));

  const close = within(connectorBlock("Box")).getByRole("button", { name: "Turn Box off for every workspace" });
  fireEvent.click(close);
  expect(setConnectorCeiling).not.toHaveBeenCalled();
  fireEvent.click(close);
  await waitFor(() => expect(setConnectorCeiling).toHaveBeenCalledWith(expect.objectContaining({ id: "box" }), false));
  await waitFor(() => expect(within(connectorBlock("Box")).getByText("Off for all workspaces")).toBeInTheDocument());
  expect(statuses.at(-1)).toEqual({ tone: "success", message: "Box is off for every workspace." });

  fireEvent.click(within(connectorBlock("Box")).getByRole("button", { name: "Allow Box in every workspace" }));
  await waitFor(() => expect(setConnectorCeiling).toHaveBeenLastCalledWith(expect.objectContaining({ id: "box" }), true));
  await waitFor(() => expect(within(connectorBlock("Box")).queryByText("Off for all workspaces")).not.toBeInTheDocument());
  expect(confirm).toHaveBeenCalledTimes(2);
  confirm.mockRestore();
});

test("missing and unconfirmed switch APIs do not fabricate a saved change", async () => {
  const statuses: ConnectorsPanelStatus[] = [];
  const missing = renderPanel({}, cloneData(), (status) => statuses.push(status));
  fireEvent.click(screen.getByRole("switch", { name: "Enable MCP Servers" }));
  expect(screen.getByRole("switch", { name: "Enable MCP Servers" })).toHaveAttribute("aria-checked", "true");
  expect(statuses.at(-1)?.message).toContain("was not changed");
  missing.unmount();

  renderPanel({ setConnectorEnabled: async () => undefined }, cloneData(), (status) => statuses.push(status));
  fireEvent.click(screen.getByRole("switch", { name: "Enable MCP Servers" }));
  await waitFor(() => expect(statuses.at(-1)?.message).toContain("did not confirm the saved state"));
  expect(screen.getByRole("switch", { name: "Enable MCP Servers" })).toHaveAttribute("aria-checked", "true");
  expect(statuses.some((status) => status.tone === "success")).toBe(false);
});

test("partial connector saves keep the confirmed server state and report the remaining failure", async () => {
  const statuses: ConnectorsPanelStatus[] = [];
  const message = "Box was turned off, but its saved credential record could not be updated. Retry after the connection recovers.";
  renderPanel({ setConnectorEnabled: async () => {
    throw new ConnectorUpdateError(message, { platform_enabled: false, tenant_enabled: false });
  } }, cloneData(), (status) => statuses.push(status));
  fireEvent.click(screen.getByRole("switch", { name: "Enable Box" }));
  await waitFor(() => expect(statuses.at(-1)).toEqual({ tone: "warning", message }));
  expect(screen.getByRole("switch", { name: "Enable Box" })).toHaveAttribute("aria-checked", "false");
});

test("failed credential saves keep the draft and block conflicting edits until the request finishes", async () => {
  const statuses: ConnectorsPanelStatus[] = [];
  let failSave: (reason: Error) => void = () => {};
  const saveConnectorConfig = vi.fn<NonNullable<ConnectorsPanelApi["saveConnectorConfig"]>>()
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { failSave = reject; }))
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(async (connector: Connector, payload: ConnectorConfigSavePayload) => ({
      connector: { tenant_config_id: "conncfg-graph-saved", auth_status: "configured" as const },
      record: { id: "conncfg-graph-saved", tenant_id: "tenant-example", connector_id: connector.id,
        enabled: true, auth_type: "client-credentials", scopes: [], settings: payload.settings ?? {},
        secret_set: true, masked_secret: "saved" },
    }));
  renderPanel({ saveConnectorConfig }, cloneData(), (status) => statuses.push(status));
  fireEvent.click(within(connectorBlock("OneDrive / SharePoint / Outlook")).getByRole("button", { name: /Configure/ }));
  const form = screen.getByTestId("connector-config-microsoft-graph");
  fireEvent.change(within(form).getByLabelText(/Directory \(tenant\) ID/), { target: { value: "tenant-synthetic" } });
  fireEvent.change(within(form).getByLabelText(/Application \(client\) ID/), { target: { value: "client-synthetic" } });
  const secret = within(form).getByLabelText(/Client secret/);
  fireEvent.change(secret, { target: { value: "synthetic-secret" } });
  fireEvent.click(within(form).getByRole("button", { name: /Save configuration/ }));
  expect(secret).toBeDisabled();
  expect(within(connectorBlock("Google Drive")).getByRole("button", { name: /Configure/ })).toBeDisabled();
  expect(screen.getByRole("switch", { name: "Enable MCP Servers" })).toBeDisabled();
  failSave(new Error("Connection interrupted."));
  await waitFor(() => expect(statuses.at(-1)?.message).toContain("Connection interrupted"));
  expect(secret).toHaveValue("synthetic-secret");
  expect(within(form).getByLabelText(/Application \(client\) ID/)).toHaveValue("client-synthetic");

  fireEvent.click(within(form).getByRole("button", { name: /Save configuration/ }));
  await waitFor(() => expect(statuses.at(-1)?.message).toContain("did not confirm the saved configuration"));
  expect(secret).toHaveValue("synthetic-secret");
  fireEvent.click(within(form).getByRole("button", { name: /Save configuration/ }));
  await waitFor(() => expect(statuses.at(-1)?.tone).toBe("success"));
  expect(saveConnectorConfig).toHaveBeenCalledTimes(3);
  expect(saveConnectorConfig.mock.calls.every(([, payload]) => payload.secret_value === "synthetic-secret")).toBe(true);
  expect(secret).toHaveValue("");
});

test("a failed configuration clear retains the current credential draft", async () => {
  const data = cloneData();
  data.connectors = data.connectors.map((connector) => connector.id === "google-drive"
    ? { ...connector, tenant_config_id: "conncfg-google-existing" } : connector);
  const statuses: ConnectorsPanelStatus[] = [];
  const saveConnectorConfig = vi.fn<NonNullable<ConnectorsPanelApi["saveConnectorConfig"]>>()
    .mockRejectedValue(new Error("Clear was not saved."));
  renderPanel({ saveConnectorConfig }, data, (status) => statuses.push(status));
  fireEvent.click(within(connectorBlock("Google Drive")).getByRole("button", { name: /Configure/ }));
  const form = screen.getByTestId("connector-config-google-drive");
  fireEvent.change(within(form).getByLabelText(/OAuth client ID/), { target: { value: "draft-client-id" } });
  fireEvent.change(within(form).getByLabelText(/OAuth client secret/), { target: { value: "draft-secret" } });
  fireEvent.click(within(form).getByRole("button", { name: "Clear configuration" }));
  await waitFor(() => expect(statuses.at(-1)?.message).toContain("Clear was not saved"));
  expect(saveConnectorConfig.mock.calls[0][1]).toMatchObject({ clear_secret: true, replace_settings: true });
  expect(within(form).getByLabelText(/OAuth client ID/)).toHaveValue("draft-client-id");
  expect(within(form).getByLabelText(/OAuth client secret/)).toHaveValue("draft-secret");
});

test("the switch writes this workspace's switch and reconciles with the server response", async () => {
  const data = cloneData();
  const box = data.connectors.find((connector) => connector.id === "box") as Connector;
  expect(connectorSwitchedOn(box)).toBe(true);
  const setConnectorEnabled = vi.fn(async (connector: Connector, enabled: boolean) => ({
    tenant_enabled: enabled,
    auth_status: enabled ? connector.auth_status : ("not-configured" as const),
  }));
  const statuses: ConnectorsPanelStatus[] = [];

  renderPanel({ setConnectorEnabled }, data, (status) => statuses.push(status));
  fireEvent.click(screen.getByRole("switch", { name: "Enable Box" }));

  await waitFor(() => expect(setConnectorEnabled).toHaveBeenCalledTimes(1));
  expect(setConnectorEnabled.mock.calls[0][0].id).toBe("box");
  expect(setConnectorEnabled.mock.calls[0][1]).toBe(false);
  expect(screen.getByRole("switch", { name: "Enable Box" })).toHaveAttribute("aria-checked", "false");
  await waitFor(() =>
    expect(statuses.at(-1)).toEqual({ tone: "success", message: "Box is now off for everyone in this workspace." }),
  );
});

test("a rejected switch change is reverted and reported", async () => {
  const setConnectorEnabled = vi.fn(async () => {
    throw new Error("Connector is disabled by platform policy.");
  });
  const statuses: ConnectorsPanelStatus[] = [];
  renderPanel({ setConnectorEnabled }, cloneData(), (status) => statuses.push(status));

  fireEvent.click(screen.getByRole("switch", { name: "Enable MCP Servers" }));
  await waitFor(() =>
    expect(statuses.at(-1)?.message).toBe("MCP Servers was not changed. Connector is disabled by platform policy."),
  );
  expect(screen.getByRole("switch", { name: "Enable MCP Servers" })).toHaveAttribute("aria-checked", "true");
});

test("switch-only connectors have no Configure button; credential connectors and web search do", () => {
  renderPanel({});
  expect(within(connectorBlock("MCP Servers")).queryByRole("button", { name: /Configure/ })).not.toBeInTheDocument();
  expect(within(connectorBlock("Prompt Library")).queryByRole("button", { name: /Configure/ })).not.toBeInTheDocument();
  expect(within(connectorBlock("Google Drive")).getByRole("button", { name: /Configure/ })).toBeInTheDocument();
  expect(within(connectorBlock("Web Search")).getByRole("button", { name: /Configure/ })).toBeInTheDocument();
});

test("connector configuration form saves provider credentials and runs a live test", async () => {
  const saveConnectorConfig = vi.fn(
    async (connector: Connector, payload: { auth_type?: string | null; settings?: Record<string, unknown> | null }) => ({
      connector: {
        tenant_config_id: "conncfg-graph-example",
        auth_status: "configured" as const,
      },
      record: {
        id: "conncfg-graph-example",
        tenant_id: "tenant-example",
        connector_id: connector.id,
        enabled: true,
        auth_type: String(payload.auth_type),
        scopes: [],
        settings: payload.settings ?? {},
        secret_set: true,
        masked_secret: "gr•••••et",
      },
    }),
  );
  const testConnectorConfig = vi.fn(async () => ({
    status: "ok" as const,
    message: "Connected to Microsoft Graph.",
    checks: [
      { name: "Authentication", status: "ok", detail: "Token issued by login.microsoftonline.com" },
      { name: "API access", status: "ok", detail: "Reached the tenant root site" },
    ],
  }));

  renderPanel({ saveConnectorConfig, testConnectorConfig });

  fireEvent.click(within(connectorBlock("OneDrive / SharePoint / Outlook")).getByRole("button", { name: /Configure/ }));
  fireEvent.change(screen.getByLabelText(/Directory \(tenant\) ID/), {
    target: { value: "11111111-2222-3333-4444-555555555555" },
  });
  fireEvent.change(screen.getByLabelText(/Application \(client\) ID/), { target: { value: "app-client-id" } });
  fireEvent.change(screen.getByLabelText(/Client secret/), { target: { value: "graph-secret" } });
  fireEvent.click(screen.getByRole("button", { name: /Save configuration/ }));

  await waitFor(() => expect(saveConnectorConfig).toHaveBeenCalledTimes(1));
  expect(saveConnectorConfig.mock.calls[0][0].id).toBe("microsoft-graph");
  expect(saveConnectorConfig.mock.calls[0][1]).toMatchObject({
    connector_id: "microsoft-graph",
    auth_type: "client-credentials",
    secret_value: "graph-secret",
    settings: expect.objectContaining({
      auth_mode: "client-credentials",
      tenant_id: "11111111-2222-3333-4444-555555555555",
      client_id: "app-client-id",
    }),
  });

  fireEvent.click(await screen.findByRole("button", { name: /Test connection/ }));
  await waitFor(() => expect(testConnectorConfig).toHaveBeenCalledWith("conncfg-graph-example"));
  expect((await screen.findAllByText("Connected to Microsoft Graph.")).length).toBeGreaterThan(0);
  expect(screen.getByText(/Reached the tenant root site/)).toBeInTheDocument();
});

test("iManage defaults to delegated user sign-in and keeps service credentials out of chat", () => {
  renderPanel({});
  fireEvent.click(within(connectorBlock("iManage")).getByRole("button", { name: /Configure/ }));
  const form = screen.getByTestId("connector-config-imanage");

  expect(within(form).getByLabelText("Authentication method")).toHaveValue("oauth-client");
  expect(within(form).getByRole("option", { name: "Each user signs in (recommended)" })).toBeInTheDocument();
  expect(within(form).getByText(/Chat users sign in individually/)).toBeInTheDocument();
  expect(within(form).queryByLabelText(/Service account username/)).not.toBeInTheDocument();

  fireEvent.change(within(form).getByLabelText("Authentication method"), { target: { value: "password" } });
  expect(within(form).getByLabelText(/Service account username/)).toBeInTheDocument();
  expect(within(form).getByRole("option", { name: "Service account for background sync" })).toBeInTheDocument();
});

test("connector form saves an intentionally cleared existing configuration", async () => {
  const data = cloneData();
  data.connectors = data.connectors.map((connector) =>
    connector.id === "google-drive" ? { ...connector, tenant_config_id: "conncfg-google-drive-example" } : connector,
  );
  const saveConnectorConfig = vi.fn(async (connector: Connector, payload: { settings?: Record<string, unknown> | null }) => ({
    connector: {
      tenant_config_id: "conncfg-google-drive-example",
      tenant_enabled: false,
      auth_status: "not-configured" as const,
    },
    record: {
      id: "conncfg-google-drive-example",
      tenant_id: "tenant-example",
      connector_id: connector.id,
      enabled: false,
      auth_type: "oauth-client",
      scopes: [],
      settings: payload.settings ?? {},
      secret_set: false,
      masked_secret: null,
    },
  }));

  renderPanel({ saveConnectorConfig }, data);
  fireEvent.click(within(connectorBlock("Google Drive")).getByRole("button", { name: /Configure/ }));
  const driveForm = screen.getByTestId("connector-config-google-drive");

  fireEvent.change(within(driveForm).getByLabelText(/OAuth client ID/), { target: { value: "" } });
  fireEvent.change(within(driveForm).getByLabelText(/Drive folder ID/), { target: { value: "" } });
  fireEvent.change(within(driveForm).getByLabelText(/Source label/), { target: { value: "" } });
  fireEvent.click(within(driveForm).getByRole("button", { name: /Save configuration/ }));

  await waitFor(() => expect(saveConnectorConfig).toHaveBeenCalledTimes(1));
  expect(saveConnectorConfig.mock.calls[0][1]).toMatchObject({
    connector_id: "google-drive",
    enabled: false,
    auth_type: "oauth-client",
    settings: {},
    replace_settings: true,
    clear_secret: true,
    clear_oauth: true,
    clear_service_password: true,
  });
});

test("connector form blocks saving when required provider fields are missing", async () => {
  const saveConnectorConfig = vi.fn();
  renderPanel({ saveConnectorConfig });

  fireEvent.click(within(connectorBlock("Box")).getByRole("button", { name: /Configure/ }));
  fireEvent.click(screen.getByRole("button", { name: /Save configuration/ }));

  expect(await screen.findByRole("alert")).toHaveTextContent(/Client ID.*Enterprise ID/);
  expect(saveConnectorConfig).not.toHaveBeenCalled();
});

test("connector form keeps field labels aligned with the shared selector layout", () => {
  renderPanel({});
  fireEvent.click(within(connectorBlock("Google Drive")).getByRole("button", { name: /Configure/ }));
  const driveForm = screen.getByTestId("connector-config-google-drive");
  expect(driveForm.querySelector(":scope > label.connector-config-selector select")).toBeInTheDocument();
  for (const mark of Array.from(driveForm.querySelectorAll(".required-mark"))) {
    expect(mark.parentElement).toHaveClass("connector-field-label");
  }
});

test("web search saves an engine choice and reports the configured engine", async () => {
  const saveConnectorConfig = vi.fn(async (connector: Connector, payload: { settings?: Record<string, unknown> | null }) => ({
    connector: { tenant_config_id: "conncfg-web", auth_status: "configured" as const, tenant_enabled: true },
    record: {
      id: "conncfg-web",
      tenant_id: "tenant-example",
      connector_id: connector.id,
      enabled: true,
      auth_type: "none",
      scopes: [],
      settings: payload.settings ?? {},
      secret_set: false,
      masked_secret: null,
    },
  }));
  renderPanel({ saveConnectorConfig });

  fireEvent.click(within(connectorBlock("Web Search")).getByRole("button", { name: /Configure/ }));
  const form = screen.getByTestId("connector-config-web");
  fireEvent.change(within(form).getByLabelText(/Search engine/), { target: { value: "searxng" } });
  fireEvent.click(within(form).getByRole("button", { name: /Save configuration/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/SearXNG instance URL/);

  fireEvent.change(within(form).getByLabelText(/SearXNG instance URL/), { target: { value: "http://search.example.test:8888" } });
  fireEvent.click(within(form).getByRole("button", { name: /Save configuration/ }));
  await waitFor(() => expect(saveConnectorConfig).toHaveBeenCalledTimes(1));
  expect(saveConnectorConfig.mock.calls[0][1]).toMatchObject({
    connector_id: "web",
    enabled: true,
    settings: { engine: "searxng", searxng_base_url: "http://search.example.test:8888", max_results: 5 },
  });
  expect(await screen.findByText("SearXNG")).toBeInTheDocument();
});
