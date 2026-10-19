import { Ban, CheckCircle2, Eye, EyeOff, KeyRound, RefreshCw, ShieldCheck, Trash2, Wrench, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ConnectorTestResult } from "../lib/api/admin";
import { connectorDeploymentAllowed, connectorSwitchedOn } from "../lib/connectors";
import type {
  AdminConnectorConfigUpdateRequest,
  BootstrapData,
  Connector,
  ConnectorConfigRecord,
} from "../lib/types";
import { Panel, Pill, StableLabel, Toggle } from "./Primitives";
import { SelectControl } from "./SelectControl";

/* Workspace surface for every connector: the on/off switch that governs chat
 * pickers, the / palette, the tool library, and the API; the vendor
 * credentials that power knowledge sync; and whether a cloud file source is
 * offered in the attach menus at all. It lives in the admin console's
 * Connections tab and writes the current workspace's own connector records.
 * The catalog flags above them stay the platform owner's ceiling. */

export type ConnectorsPanelStatus = {
  tone: "success" | "warning" | "info";
  message: string;
};

export type ConnectorConfigSavePayload = AdminConnectorConfigUpdateRequest & { connector_id: string };

/** A later phase failed after the API already committed this connector state. */
export class ConnectorUpdateError extends Error {
  constructor(message: string, public readonly savedConnector: Partial<Connector>) {
    super(message);
    this.name = "ConnectorUpdateError";
  }
}

export type ConnectorsPanelApi = {
  /** Flips this workspace's switch on its connector record, creating the
   * record when needed. A platform owner turning a connector on also lifts a
   * closed deployment ceiling. */
  setConnectorEnabled?: (connector: Connector, enabled: boolean) => Promise<Partial<Connector> | void>;
  /** Hides a cloud file source from this workspace's attach menus, or shows it
   * again, without changing whether it is on. */
  setConnectorHidden?: (connector: Connector, hidden: boolean) => Promise<Partial<Connector> | void>;
  /** Platform owner only: opens or closes the deployment ceiling, which turns
   * a connector off in every workspace until the owner allows it again. */
  setConnectorCeiling?: (connector: Connector, allowed: boolean) => Promise<Partial<Connector> | void>;
  saveConnectorConfig?: (
    connector: Connector,
    payload: ConnectorConfigSavePayload,
  ) => Promise<{ connector: Partial<Connector>; record: ConnectorConfigRecord } | void>;
  testConnectorConfig?: (configId: string) => Promise<ConnectorTestResult | void>;
  connectorOAuthUrl?: (configId: string) => Promise<string | void>;
};

type ConnectorFieldSpec = {
  key: string;
  label: string;
  placeholder?: string;
  hint?: string;
  /** Limit to specific auth modes; omitted = always shown. */
  modes?: string[];
  required?: boolean;
};

type ConnectorFormProfile = {
  authModes: Array<{ value: string; label: string }>;
  fields: ConnectorFieldSpec[];
  secretLabel: Record<string, string>;
  /** Google-style OAuth consent flow available for this mode. */
  oauthConnectMode?: string;
  /** Second secret (service-account password) collected for these modes. */
  passwordModes?: string[];
  setupNote?: string;
};

// Field sets mirror the backend connector_auth requirements. Service
// credentials can power background knowledge sync, while chat attachment
// access uses delegated tokens stored for each signed-in user. iManage never
// uses its service account in the chat picker.
export const CONNECTOR_FORM_PROFILES: Record<string, ConnectorFormProfile> = {
  "google-drive": {
    authModes: [
      { value: "oauth-client", label: "Google OAuth (recommended)" },
      { value: "manual-token", label: "Paste access token (testing only)" },
    ],
    fields: [
      {
        key: "client_id",
        label: "OAuth client ID",
        modes: ["oauth-client"],
        required: true,
        placeholder: "1234567890-abc.apps.googleusercontent.com",
        hint: "Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 web client.",
      },
      {
        key: "folder_id",
        label: "Drive folder ID",
        placeholder: "1AbCdEfGhIjKlMnOpQrStUvWxYz",
        hint: "From the folder URL. Leave blank to index from the Drive root.",
      },
      { key: "source_label", label: "Source label", placeholder: "Policy Library" },
    ],
    secretLabel: { "oauth-client": "OAuth client secret", "manual-token": "Access token" },
    oauthConnectMode: "oauth-client",
    setupNote:
      "Scope requested: drive.readonly. Add {API base}/api/connector-oauth/callback as an authorized redirect URI on the OAuth client. The Connect Google Drive button here authorizes the workspace account used for knowledge sync; chat users connect their own Google account from the attach menu and only see their own files.",
  },
  "microsoft-graph": {
    authModes: [
      { value: "client-credentials", label: "App-only (client credentials, recommended)" },
      { value: "manual-token", label: "Paste access token (testing only)" },
    ],
    fields: [
      {
        key: "tenant_id",
        label: "Directory (tenant) ID",
        modes: ["client-credentials"],
        required: true,
        placeholder: "00000000-0000-0000-0000-000000000000",
        hint: "Entra admin center → App registrations → Overview.",
      },
      {
        key: "client_id",
        label: "Application (client) ID",
        modes: ["client-credentials"],
        required: true,
      },
      { key: "site_id", label: "SharePoint site ID", hint: "Optional; for SharePoint libraries." },
      { key: "drive_id", label: "Drive ID", hint: "Optional; for shared drives." },
      { key: "drive_item_id", label: "Root folder / item ID", hint: "Optional; item to index from." },
    ],
    secretLabel: { "client-credentials": "Client secret", "manual-token": "Access token" },
    setupNote:
      "Grant the app Files.Read.All (and Sites.Read.All for SharePoint) as application permissions and click 'Grant admin consent' in Entra — these power knowledge sync. For chat attachments, users sign in with their own Microsoft account: also add the same scopes as delegated permissions and register {API base}/api/connector-oauth/callback as a Web redirect URI.",
  },
  box: {
    authModes: [
      { value: "client-credentials", label: "Client Credentials Grant (recommended)" },
      { value: "developer-token", label: "Developer token (60-minute, testing only)" },
    ],
    fields: [
      { key: "client_id", label: "Client ID", modes: ["client-credentials"], required: true },
      {
        key: "enterprise_id",
        label: "Enterprise ID",
        modes: ["client-credentials"],
        required: true,
        hint: "Admin Console → Account & Billing. A Box admin must authorize the app in Platform Apps Manager (and re-authorize after scope changes).",
      },
      { key: "folder_id", label: "Folder ID", placeholder: "12345", hint: "Numeric folder ID from the Box folder URL." },
    ],
    secretLabel: { "client-credentials": "Client secret", "developer-token": "Developer token" },
    setupNote:
      "Create a Platform App with Server Authentication (CCG) in the Box Developer Console with read access to files and folders — this powers knowledge sync. For chat attachments, users sign in with their own Box account: also enable OAuth 2.0 (Authorization Code) on the app with {API base}/api/connector-oauth/callback as the redirect URI.",
  },
  imanage: {
    authModes: [
      { value: "oauth-client", label: "Each user signs in (recommended)" },
      { value: "password", label: "Service account for background sync" },
    ],
    fields: [
      {
        key: "base_url",
        label: "Instance URL",
        required: true,
        placeholder: "https://cloudimanage.com",
        hint: "Your iManage cloud or on-prem Work server URL.",
      },
      {
        key: "client_id",
        label: "API key (client ID)",
        modes: ["oauth-client", "password"],
        required: true,
        hint: "iManage Control Center → Settings → Applications.",
      },
      {
        key: "user_authorization_url",
        label: "User authorization URL",
        modes: ["oauth-client", "password"],
        placeholder: "Derived from the instance URL",
        hint: "Optional override for on-premises deployments. Default: {Instance URL}/auth/oauth2/authorize.",
      },
      {
        key: "user_token_url",
        label: "User token URL",
        modes: ["oauth-client", "password"],
        placeholder: "Derived from the instance URL",
        hint: "Optional override for on-premises deployments. Default: {Instance URL}/auth/oauth2/token.",
      },
      { key: "customer_id", label: "Customer ID", placeholder: "100" },
      { key: "library_id", label: "Library ID", placeholder: "ACTIVE" },
      { key: "workspace_id", label: "Workspace ID", hint: "Optional; workspace to index." },
      {
        key: "service_username",
        label: "Service account username",
        modes: ["password"],
        required: true,
        hint: "A dedicated iManage user the connector signs in as.",
      },
    ],
    secretLabel: { password: "API secret (client secret)", "oauth-client": "OAuth client secret" },
    passwordModes: ["password"],
    setupNote:
      "Register the app in iManage Control Center, allow refresh tokens, and register {API base}/api/connector-oauth/callback as its redirect URI. Chat users sign in individually and iManage enforces their own library, group, workspace, and document permissions. The service-account option is only for background knowledge sync; chat still requires each user's OAuth sign-in.",
  },
};

/** Cloud file sources behind the chat and Drafts attach menus; only these can
 * be hidden. Mirrors ATTACHABLE_CONNECTOR_IDS in the API. */
export function connectorCanBeHidden(connectorId: string): boolean {
  return connectorId in CONNECTOR_FORM_PROFILES;
}

export { connectorSwitchedOn };

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error.";
}

export function ConnectorsPanel({
  data,
  onDataChange,
  api,
  onStatus,
  defaultCollapsed = false,
}: {
  data: BootstrapData;
  onDataChange: (updater: (current: BootstrapData) => BootstrapData) => void;
  api?: ConnectorsPanelApi;
  onStatus?: (status: ConnectorsPanelStatus) => void;
  defaultCollapsed?: boolean;
}) {
  const [expandedConnectorId, setExpandedConnectorId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ConnectorTestResult>>({});

  const report = (status: ConnectorsPanelStatus) => onStatus?.(status);

  function applyConnectorPatch(connectorId: string, patch: Partial<Connector>) {
    onDataChange((current) => ({
      ...current,
      connectors: current.connectors.map((connector) =>
        connector.id === connectorId ? { ...connector, ...patch } : connector,
      ),
    }));
  }

  async function toggleConnector(connector: Connector, next: boolean) {
    if (pendingAction) return;
    if (!api?.setConnectorEnabled) {
      report({ tone: "warning", message: `${connector.name} was not changed; the connector API is not connected.` });
      return;
    }
    const previous: Partial<Connector> = {
      platform_enabled: connector.platform_enabled,
      tenant_enabled: connector.tenant_enabled,
      deployment_enabled: connector.deployment_enabled,
      sync_status: connector.sync_status,
      auth_status: connector.auth_status,
    };
    setPendingAction(`connector-${connector.id}`);
    applyConnectorPatch(connector.id, {
      tenant_enabled: next,
      // An owner turning a connector on also reopens the deployment ceiling.
      ...(next && data.me.role === "PLATFORM_OWNER" ? { deployment_enabled: true } : {}),
      sync_status: next ? connector.sync_status ?? "idle" : "idle",
    });
    try {
      const remote = await api.setConnectorEnabled(connector, next);
      if (!remote) throw new Error("The connector API did not confirm the saved state.");
      applyConnectorPatch(connector.id, remote);
      report({
        tone: "success",
        message: `${connector.name} is now ${next ? "on" : "off"} for everyone in this workspace.`,
      });
    } catch (error) {
      if (error instanceof ConnectorUpdateError) {
        applyConnectorPatch(connector.id, { ...previous, ...error.savedConnector });
        report({ tone: "warning", message: error.message });
      } else {
        applyConnectorPatch(connector.id, previous);
        report({ tone: "warning", message: `${connector.name} was not changed. ${errorMessage(error)}` });
      }
    } finally {
      setPendingAction(null);
    }
  }

  async function toggleConnectorHidden(connector: Connector, hidden: boolean) {
    if (pendingAction) return;
    if (!api?.setConnectorHidden) {
      report({ tone: "warning", message: `${connector.name} was not changed; the connector API is not connected.` });
      return;
    }
    setPendingAction(`connector-hidden-${connector.id}`);
    try {
      const remote = await api.setConnectorHidden(connector, hidden);
      if (!remote) throw new Error("The connector API did not confirm the saved state.");
      applyConnectorPatch(connector.id, remote);
      report({
        tone: "success",
        message: hidden
          ? `${connector.name} is hidden. People in this workspace no longer see it in the attach menu.`
          : `${connector.name} is back in the attach menu for people in this workspace.`,
      });
    } catch (error) {
      report({ tone: "warning", message: `${connector.name} was not changed. ${errorMessage(error)}` });
    } finally {
      setPendingAction(null);
    }
  }

  async function setConnectorCeiling(connector: Connector, allowed: boolean) {
    if (pendingAction) return;
    if (!api?.setConnectorCeiling) {
      report({ tone: "warning", message: `${connector.name} was not changed; the connector API is not connected.` });
      return;
    }
    if (
      !allowed &&
      !window.confirm(
        `Turn ${connector.name} off for every workspace? Workspace admins can't turn it back on until you allow it again.`,
      )
    ) {
      return;
    }
    setPendingAction(`connector-ceiling-${connector.id}`);
    try {
      const remote = await api.setConnectorCeiling(connector, allowed);
      if (!remote) throw new Error("The connector API did not confirm the saved state.");
      applyConnectorPatch(connector.id, remote);
      report({
        tone: "success",
        message: allowed
          ? `${connector.name} is allowed in every workspace again. Each workspace's own switch decides whether it is on.`
          : `${connector.name} is off for every workspace.`,
      });
    } catch (error) {
      report({ tone: "warning", message: `${connector.name} was not changed. ${errorMessage(error)}` });
    } finally {
      setPendingAction(null);
    }
  }

  async function saveConnectorConfiguration(connector: Connector, payload: ConnectorConfigSavePayload) {
    if (pendingAction) return false;
    if (!api?.saveConnectorConfig) {
      report({
        tone: "warning",
        message: `${connector.name} settings were not saved; the connector config API is not connected.`,
      });
      return false;
    }
    setPendingAction(`connector-config-${connector.id}`);
    report({ tone: "info", message: `Saving ${connector.name} configuration...` });
    try {
      const result = await api.saveConnectorConfig(connector, payload);
      if (!result) throw new Error("The connector API did not confirm the saved configuration.");
      applyConnectorPatch(connector.id, result.connector);
      onDataChange((current) => {
        const exists = current.connectorConfigs.some((record) => record.id === result.record.id);
        return {
          ...current,
          connectorConfigs: exists
            ? current.connectorConfigs.map((record) => (record.id === result.record.id ? result.record : record))
            : [...current.connectorConfigs, result.record],
        };
      });
      report({ tone: "success", message: `${connector.name} configuration saved.` });
      return true;
    } catch (error) {
      report({ tone: "warning", message: `${connector.name} configuration was not saved: ${errorMessage(error)}` });
      return false;
    } finally {
      setPendingAction(null);
    }
  }

  async function testConnectorConfiguration(connector: Connector) {
    if (pendingAction) return;
    const configId = connector.tenant_config_id;
    if (!api?.testConnectorConfig || !configId) {
      report({
        tone: "warning",
        message: configId
          ? "The connector test API is not connected in this session."
          : `Save the ${connector.name} configuration first, then test the connection.`,
      });
      return;
    }
    setPendingAction(`connector-test-${connector.id}`);
    setTestResults((current) => {
      const next = { ...current };
      delete next[connector.id];
      return next;
    });
    try {
      const result = await api.testConnectorConfig(configId);
      if (result) {
        setTestResults((current) => ({ ...current, [connector.id]: result }));
        report({
          tone: result.status === "ok" ? "success" : result.status === "incomplete" ? "info" : "warning",
          message: result.message,
        });
      } else {
        report({ tone: "warning", message: `${connector.name} connection test returned no result. Try again.` });
      }
    } catch (error) {
      report({ tone: "warning", message: `${connector.name} connection test failed: ${errorMessage(error)}` });
    } finally {
      setPendingAction(null);
    }
  }

  async function startConnectorOAuth(connector: Connector) {
    if (pendingAction) return;
    const configId = connector.tenant_config_id;
    if (!api?.connectorOAuthUrl || !configId) {
      report({
        tone: "warning",
        message: configId
          ? "The connector OAuth API is not connected in this session."
          : `Save the ${connector.name} configuration (client ID and secret) before connecting.`,
      });
      return;
    }
    setPendingAction(`connector-oauth-${connector.id}`);
    try {
      const url = await api.connectorOAuthUrl(configId);
      if (url) {
        window.location.assign(url);
        return;
      }
      report({ tone: "warning", message: "The OAuth consent URL could not be created." });
    } catch (error) {
      report({ tone: "warning", message: `Could not start the OAuth flow: ${errorMessage(error)}` });
    } finally {
      setPendingAction(null);
    }
  }

  const isOwner = data.me.role === "PLATFORM_OWNER";
  if (!isOwner && data.me.role !== "TENANT_ADMIN") return null;

  return (
    <Panel
      title="Connectors"
      subtitle="Sources and tools for this workspace. Off removes a connector everywhere: chat, pickers, the tool library, and the API. Hide only takes a cloud source out of the attach menu, so people don't see it as an option."
      defaultCollapsed={defaultCollapsed}
    >
      {/* One list child keeps the panel's body padding from repeating on every row. */}
      <div className="connector-config-list">
        {data.connectors.map((connector) => {
          const profile = CONNECTOR_FORM_PROFILES[connector.id];
          const isWebSearch = connector.id === "web";
          const record = data.connectorConfigs.find((config) => config.id === connector.tenant_config_id);
          const expanded = expandedConnectorId === connector.id;
          const switchedOn = connectorSwitchedOn(connector);
          const ceilingClosed = !connectorDeploymentAllowed(connector);
          const hideable = connectorCanBeHidden(connector.id);
          const hidden = Boolean(connector.hidden);
          return (
            <div className="connector-config-block" key={connector.id}>
              <div className="permission-row">
                <span>
                  <KeyRound size={15} />
                  <strong className="connector-row-name">{connector.name}</strong>
                  {profile && (
                    <Pill tone={connector.auth_status === "configured" ? "success" : "warning"}>
                      {connector.auth_status === "configured"
                        ? "Credentials saved"
                        : record?.secret_set
                          ? "Saved · disabled"
                          : "Needs credentials"}
                    </Pill>
                  )}
                  {isWebSearch && (
                    <Pill tone={webSearchEnginePill(record).tone}>{webSearchEnginePill(record).label}</Pill>
                  )}
                  {ceilingClosed && <Pill tone="neutral">Off for all workspaces</Pill>}
                  {hidden && <Pill tone="info">Hidden</Pill>}
                </span>
                <span className="row-actions">
                  {(profile || isWebSearch) && (
                    <button
                      className="secondary-button compact"
                      type="button"
                      disabled={Boolean(pendingAction)}
                      aria-expanded={expanded}
                      data-tooltip={
                        expanded
                          ? `Hide the ${connector.name} configuration form`
                          : `Set up credentials and connection settings for ${connector.name}`
                      }
                      onClick={() =>
                        setExpandedConnectorId((current) => (current === connector.id ? null : connector.id))
                      }
                    >
                      <Wrench size={14} /> Configure
                    </button>
                  )}
                  {hideable && (
                    <button
                      className="secondary-button compact connector-visibility-button"
                      type="button"
                      disabled={Boolean(pendingAction)}
                      aria-pressed={hidden}
                      aria-label={
                        hidden ? `Show ${connector.name} in the attach menu` : `Hide ${connector.name} from the attach menu`
                      }
                      data-tooltip={
                        hidden
                          ? `Offer ${connector.name} in the attach menu again for people in this workspace`
                          : `Take ${connector.name} out of the attach menu so people in this workspace don't see it. Its on/off switch and credentials stay as they are.`
                      }
                      onClick={() => void toggleConnectorHidden(connector, !hidden)}
                    >
                      {hidden ? <Eye size={14} /> : <EyeOff size={14} />}{" "}
                      <StableLabel label={hidden ? "Show" : "Hide"} reserve={["Hide", "Show"]} />
                    </button>
                  )}
                  {isOwner && (
                    <button
                      className="secondary-button compact connector-ceiling-button"
                      type="button"
                      disabled={Boolean(pendingAction)}
                      aria-label={
                        ceilingClosed
                          ? `Allow ${connector.name} in every workspace`
                          : `Turn ${connector.name} off for every workspace`
                      }
                      data-tooltip={
                        ceilingClosed
                          ? `Let workspace admins use ${connector.name} again. Each workspace's own switch still decides.`
                          : `Turn ${connector.name} off in every workspace. Workspace admins can't turn it back on until you allow it again.`
                      }
                      onClick={() => void setConnectorCeiling(connector, ceilingClosed)}
                    >
                      {ceilingClosed ? <ShieldCheck size={14} /> : <Ban size={14} />}{" "}
                      <StableLabel label={ceilingClosed ? "Allow all" : "Off for all"} reserve={["Allow all", "Off for all"]} />
                    </button>
                  )}
                  <Toggle
                    checked={switchedOn}
                    disabled={Boolean(pendingAction) || (ceilingClosed && !isOwner)}
                    label={`Enable ${connector.name}`}
                    tooltip={
                      ceilingClosed && !isOwner
                        ? `The platform owner has turned ${connector.name} off for every workspace`
                        : switchedOn
                          ? `Turn off ${connector.name} for everyone in this workspace`
                          : ceilingClosed
                            ? `Turn on ${connector.name} for this workspace and allow it across the deployment`
                            : `Turn on ${connector.name} as a source for everyone in this workspace`
                    }
                    onChange={(next) => void toggleConnector(connector, next)}
                  />
                </span>
              </div>
              {isWebSearch && expanded && (
                <WebSearchConfigForm
                  connector={connector}
                  record={record}
                  saving={pendingAction === `connector-config-${connector.id}`}
                  testing={pendingAction === `connector-test-${connector.id}`}
                  busy={Boolean(pendingAction)}
                  testResult={testResults[connector.id] ?? null}
                  onSave={(payload) => saveConnectorConfiguration(connector, payload)}
                  onTest={() => void testConnectorConfiguration(connector)}
                />
              )}
              {profile && expanded && (
                <ConnectorConfigForm
                  connector={connector}
                  profile={profile}
                  record={record}
                  saving={pendingAction === `connector-config-${connector.id}`}
                  testing={pendingAction === `connector-test-${connector.id}`}
                  busy={Boolean(pendingAction)}
                  testResult={testResults[connector.id] ?? null}
                  onSave={(payload) => saveConnectorConfiguration(connector, payload)}
                  onTest={() => void testConnectorConfiguration(connector)}
                  onOAuthConnect={() => void startConnectorOAuth(connector)}
                />
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function ConnectorConfigForm({
  connector,
  profile,
  record,
  saving,
  testing,
  busy,
  testResult,
  onSave,
  onTest,
  onOAuthConnect,
}: {
  connector: Connector;
  profile: ConnectorFormProfile;
  record?: ConnectorConfigRecord;
  saving: boolean;
  testing: boolean;
  busy: boolean;
  testResult: ConnectorTestResult | null;
  onSave: (payload: ConnectorConfigSavePayload) => Promise<boolean>;
  onTest: () => void;
  onOAuthConnect: () => void;
}) {
  const settings = useMemo(() => record?.settings ?? {}, [record]);
  const storedAuthMode =
    typeof settings.auth_mode === "string" && profile.authModes.some((mode) => mode.value === settings.auth_mode)
      ? (settings.auth_mode as string)
      : null;
  // Existing empty deployments were seeded with iManage's password grant.
  // Present the safer delegated default until a real service credential exists.
  const initialAuthMode =
    connector.id === "imanage" && storedAuthMode === "password" && !record?.secret_set
      ? profile.authModes[0].value
      : storedAuthMode ?? profile.authModes[0].value;
  const [authMode, setAuthMode] = useState(initialAuthMode);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(() => readFieldValues(profile, settings));
  const [secretValue, setSecretValue] = useState("");
  const [servicePassword, setServicePassword] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setFieldValues(readFieldValues(profile, settings));
    setAuthMode(initialAuthMode);
    setSecretValue("");
    setServicePassword("");
    setValidationError(null);
  }, [profile, settings, initialAuthMode]);

  const visibleFields = profile.fields.filter((field) => !field.modes || field.modes.includes(authMode));
  const secretLabel = profile.secretLabel[authMode] ?? "Secret";
  const needsPassword = profile.passwordModes?.includes(authMode) ?? false;
  const oauthConnectAvailable = profile.oauthConnectMode === authMode;
  const secretSaved = Boolean(record?.secret_set);
  const oauthStatus = typeof settings.oauth_status === "string" ? settings.oauth_status : null;
  const hasSavedConfiguration = Boolean(record ?? connector.tenant_config_id);
  const visibleFieldsCleared = visibleFields.every((field) => !fieldValues[field.key]?.trim());
  const clearPayload: ConnectorConfigSavePayload = {
    connector_id: connector.id,
    enabled: false,
    auth_type: authMode,
    settings: {},
    replace_settings: true,
    clear_secret: true,
    clear_oauth: true,
    clear_service_password: true,
  };

  const clearFormValues = () => {
    setFieldValues((current) => {
      const next = { ...current };
      for (const field of profile.fields) next[field.key] = "";
      return next;
    });
    setSecretValue("");
    setServicePassword("");
    setValidationError(null);
  };

  const submit = async () => {
    if (busy) return;
    if (hasSavedConfiguration && visibleFieldsCleared && !secretValue.trim() && !servicePassword.trim()) {
      setValidationError(null);
      if (await onSave(clearPayload)) clearFormValues();
      return;
    }
    const missing = visibleFields
      .filter((field) => field.required && !fieldValues[field.key]?.trim())
      .map((field) => field.label);
    if (!secretSaved && !secretValue.trim()) missing.push(secretLabel);
    if (missing.length > 0) {
      setValidationError(`Fill in: ${missing.join(", ")}.`);
      return;
    }
    setValidationError(null);
    const nextSettings: Record<string, string> = { auth_mode: authMode };
    for (const field of visibleFields) {
      nextSettings[field.key] = fieldValues[field.key]?.trim() ?? "";
    }
    const payload: ConnectorConfigSavePayload = {
      connector_id: connector.id,
      auth_type: authMode,
      settings: nextSettings,
    };
    if (secretValue.trim()) payload.secret_value = secretValue.trim();
    if (needsPassword && servicePassword.trim()) payload.service_password = servicePassword.trim();
    if (await onSave(payload)) {
      setSecretValue("");
      setServicePassword("");
    }
  };

  const clearConfiguration = async () => {
    if (busy) return;
    if (!hasSavedConfiguration) {
      clearFormValues();
      return;
    }
    if (await onSave(clearPayload)) clearFormValues();
  };

  return (
    <div className="connector-config-form" data-testid={`connector-config-${connector.id}`}>
      <label className="connector-config-selector">
        <span className="connector-field-label">Authentication method</span>
        <SelectControl value={authMode} disabled={busy} onChange={(event) => setAuthMode(event.target.value)}>
          {profile.authModes.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </SelectControl>
      </label>
      <div className="connector-config-grid">
        {visibleFields.map((field) => (
          <label key={field.key}>
            <span className="connector-field-label">
              {field.label}
              {field.required ? <span className="required-mark"> *</span> : null}
            </span>
            <input
              disabled={busy}
              value={fieldValues[field.key] ?? ""}
              placeholder={field.placeholder}
              onChange={(event) =>
                setFieldValues((current) => ({ ...current, [field.key]: event.target.value }))
              }
            />
            {field.hint && <small className="field-hint">{field.hint}</small>}
          </label>
        ))}
        <label>
          <span className="connector-field-label">
            {secretLabel}
            {!secretSaved ? <span className="required-mark"> *</span> : null}
          </span>
          <input
            type="password"
            disabled={busy}
            value={secretValue}
            placeholder={secretSaved ? "Saved — enter a new value to replace" : "Stored server-side only"}
            onChange={(event) => setSecretValue(event.target.value)}
          />
        </label>
        {needsPassword && (
          <label>
            <span className="connector-field-label">Service account password</span>
            <input
              type="password"
              disabled={busy}
              value={servicePassword}
              placeholder="Stored server-side only"
              onChange={(event) => setServicePassword(event.target.value)}
            />
          </label>
        )}
      </div>
      {profile.setupNote && <p className="muted-note">{profile.setupNote}</p>}
      {validationError && (
        <p className="connector-config-error" role="alert">
          {validationError}
        </p>
      )}
      <div className="connector-config-actions">
        <button
          className="secondary-button compact"
          type="button"
          data-tooltip={`Save ${connector.name} settings and store the secret securely server-side`}
          disabled={busy}
          onClick={submit}
        >
          <CheckCircle2 size={14} />{" "}
          <StableLabel
            label={saving ? "Saving…" : "Save configuration"}
            reserve={["Saving…", "Save configuration"]}
          />
        </button>
        <button
          className="secondary-button compact"
          type="button"
          disabled={busy || !connector.tenant_config_id}
          data-tooltip={
            connector.tenant_config_id
              ? `Verify the saved ${connector.name} credentials with a live provider API call`
              : "Save the configuration first, then test the connection"
          }
          onClick={onTest}
        >
          <RefreshCw size={14} /> {testing ? "Testing…" : "Test connection"}
        </button>
        {oauthConnectAvailable && (
          <button
            className="secondary-button compact"
            type="button"
            disabled={busy || !connector.tenant_config_id || !secretSaved}
            data-tooltip={
              connector.tenant_config_id && secretSaved
                ? `Open the ${connector.name} consent screen to grant access and store a refresh token`
                : "Save the client ID and secret first, then connect"
            }
            onClick={onOAuthConnect}
          >
            <KeyRound size={14} /> Connect {connector.name}
          </button>
        )}
        <button
          className="secondary-button compact"
          type="button"
          disabled={busy}
          data-tooltip={`Clear saved ${connector.name} fields and stored connector secrets`}
          onClick={clearConfiguration}
        >
          <Trash2 size={14} /> Clear configuration
        </button>
        {oauthStatus === "connected" && <Pill tone="success">OAuth connected</Pill>}
      </div>
      {testResult && <ConnectorTestResultView result={testResult} />}
    </div>
  );
}

function ConnectorTestResultView({ result }: { result: ConnectorTestResult }) {
  return (
    <div className={`sso-test-result sso-test-${result.status}`} role="status">
      <span className="sso-test-headline">
        {result.status === "ok" ? <ShieldCheck size={15} /> : <X size={15} />}
        {result.message}
      </span>
      {result.checks?.map((check) => (
        <span key={check.name} className={`sso-test-check sso-test-check-${check.status}`}>
          <strong>{check.name}:</strong> {check.detail}
        </span>
      ))}
    </div>
  );
}

function readFieldValues(profile: ConnectorFormProfile, settings: Record<string, unknown>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of profile.fields) {
    const raw = settings[field.key];
    values[field.key] = typeof raw === "string" ? raw : "";
  }
  return values;
}

const WEB_SEARCH_ENGINES = [
  { value: "duckduckgo", label: "DuckDuckGo (keyless, works out of the box)" },
  { value: "searxng", label: "SearXNG (self-hosted instance)" },
  { value: "openai", label: "OpenAI web search (uses your OpenAI provider key)" },
  { value: "anthropic", label: "Anthropic web search (uses your Anthropic provider key)" },
  { value: "openrouter", label: "OpenRouter web search (uses your OpenRouter provider key)" },
];

const KEYED_WEB_SEARCH_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
};

function webSearchEnginePill(record: ConnectorConfigRecord | undefined): {
  tone: "success" | "warning";
  label: string;
} {
  const settings = record?.settings ?? {};
  const engine = typeof settings.engine === "string" ? settings.engine : "";
  if (engine === "searxng") {
    const baseUrl = typeof settings.searxng_base_url === "string" ? settings.searxng_base_url.trim() : "";
    return baseUrl
      ? { tone: "success", label: "SearXNG" }
      : { tone: "warning", label: "SearXNG · URL missing" };
  }
  if (engine === "duckduckgo") return { tone: "success", label: "DuckDuckGo" };
  if (KEYED_WEB_SEARCH_LABELS[engine]) return { tone: "success", label: KEYED_WEB_SEARCH_LABELS[engine] };
  return { tone: "success", label: "DuckDuckGo · default" };
}

/** Web search needs an engine choice, not credentials, so it gets its own
 * form instead of the auth-mode/secret machinery the other connectors use. */
function WebSearchConfigForm({
  connector,
  record,
  saving,
  testing,
  busy,
  testResult,
  onSave,
  onTest,
}: {
  connector: Connector;
  record?: ConnectorConfigRecord;
  saving: boolean;
  testing: boolean;
  busy: boolean;
  testResult: ConnectorTestResult | null;
  onSave: (payload: ConnectorConfigSavePayload) => Promise<boolean>;
  onTest: () => void;
}) {
  const settings = useMemo(() => record?.settings ?? {}, [record]);
  const initialEngine =
    typeof settings.engine === "string" && WEB_SEARCH_ENGINES.some((option) => option.value === settings.engine)
      ? (settings.engine as string)
      : "duckduckgo";
  const [engine, setEngine] = useState(initialEngine);
  const [searxngBaseUrl, setSearxngBaseUrl] = useState(() =>
    typeof settings.searxng_base_url === "string" ? settings.searxng_base_url : "",
  );
  const [maxResults, setMaxResults] = useState(() => {
    const raw = settings.max_results;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return String(Math.trunc(raw));
    if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return raw.trim();
    return "5";
  });
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setEngine(initialEngine);
    setSearxngBaseUrl(typeof settings.searxng_base_url === "string" ? settings.searxng_base_url : "");
    setValidationError(null);
  }, [settings, initialEngine]);

  const submit = () => {
    if (busy) return;
    if (engine === "searxng" && !searxngBaseUrl.trim()) {
      setValidationError("Set the SearXNG instance URL, or switch the engine to DuckDuckGo.");
      return;
    }
    const parsedMax = Number.parseInt(maxResults, 10);
    const boundedMax = Number.isFinite(parsedMax) ? Math.min(10, Math.max(1, parsedMax)) : 5;
    setValidationError(null);
    void onSave({
      connector_id: connector.id,
      enabled: true,
      settings: {
        engine,
        searxng_base_url: engine === "searxng" ? searxngBaseUrl.trim() : "",
        max_results: boundedMax,
      },
    });
  };

  return (
    <div className="connector-config-form" data-testid="connector-config-web">
      <label>
        Search engine
        <SelectControl value={engine} disabled={busy} onChange={(event) => setEngine(event.target.value)}>
          {WEB_SEARCH_ENGINES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectControl>
        {KEYED_WEB_SEARCH_LABELS[engine] && (
          <small className="field-hint">
            Runs a small {KEYED_WEB_SEARCH_LABELS[engine]}-hosted search per query using the{" "}
            {KEYED_WEB_SEARCH_LABELS[engine]} provider key already saved for model routing — no extra credential
            needed. Each search is billed to that account; use Test connection to verify the key works.
          </small>
        )}
      </label>
      <div className="connector-config-grid">
        {engine === "searxng" && (
          <label>
            SearXNG instance URL
            <span className="required-mark"> *</span>
            <input
              disabled={busy}
              value={searxngBaseUrl}
              placeholder="http://localhost:8888"
              onChange={(event) => setSearxngBaseUrl(event.target.value)}
            />
            <small className="field-hint">
              The instance must allow JSON output: search.formats must include json in the SearXNG settings.
            </small>
          </label>
        )}
        <label>
          Results per search
          <input
            type="number"
            disabled={busy}
            min={1}
            max={10}
            value={maxResults}
            onChange={(event) => setMaxResults(event.target.value)}
          />
          <small className="field-hint">Top results injected into the model prompt as cited context.</small>
        </label>
      </div>
      <p className="muted-note">
        Applies to models whose provider has no hosted web search of its own. OpenRouter-backed models always use
        OpenRouter&apos;s built-in web search (native provider search where the model family supports it) regardless
        of this engine choice. The enable toggle on this row turns web search on or off for this workspace.
      </p>
      {validationError && (
        <p className="connector-config-error" role="alert">
          {validationError}
        </p>
      )}
      <div className="connector-config-actions">
        <button
          className="secondary-button compact"
          type="button"
          data-tooltip="Save the search engine choice and result limit for this workspace"
          disabled={busy}
          onClick={submit}
        >
          <CheckCircle2 size={14} />{" "}
          <StableLabel
            label={saving ? "Saving…" : "Save configuration"}
            reserve={["Saving…", "Save configuration"]}
          />
        </button>
        <button
          className="secondary-button compact"
          type="button"
          disabled={busy || !connector.tenant_config_id}
          data-tooltip={
            connector.tenant_config_id
              ? "Run a real search query to verify the configured engine works"
              : "Save the configuration first, then test the connection"
          }
          onClick={onTest}
        >
          <RefreshCw size={14} /> {testing ? "Testing…" : "Test connection"}
        </button>
      </div>
      {testResult && <ConnectorTestResultView result={testResult} />}
    </div>
  );
}
