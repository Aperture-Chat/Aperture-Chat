import * as Tabs from "@radix-ui/react-tabs";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Blocks,
  CheckCircle2,
  Copy,
  FileText,
  Globe,
  KeyRound,
  Lock,
  PenLine,
  Play,
  PlugZap,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  Unplug,
  Users,
  Workflow,
  X,
  XCircle,
} from "lucide-react";
import { StableLabel, Toggle } from "./Primitives";
import { SelectControl } from "./SelectControl";
import { OverflowMenu } from "./AgentWorkspaceConsole";
import { ToolLibraryManager } from "./ToolLibraryManager";
import { connectorEnabled, isMcpRuntimeTool } from "../lib/connectors";
import { copyCodeToClipboard } from "../lib/clipboard";
import {
  callToolMcp,
  checkToolMcpHealth,
  clearToolOAuthToken,
  clearToolSecret,
  createAdminToolConfig,
  deleteAdminToolConfig,
  getToolOAuthAuthorizeUrl,
  listAdminToolConfigs,
  mapToolConfigRecordToDisplay,
  toolOAuthRedirectUrl,
  toolUsableBy,
  updateAdminToolConfig,
} from "../lib/api";
import type {
  AdminToolConfigUpdateRequest,
  BootstrapData,
  ConfigSettings,
  McpHealthResult,
  McpRuntimeInvocation,
  McpToolCallResult,
  ToolConfig,
  ToolConfigRecord,
} from "../lib/types";

type DataUpdater = (updater: (current: BootstrapData) => BootstrapData) => void;
type Tone = "success" | "warning" | "danger";
type ActionStatus = { tone: Tone; message: string } | null;
type ConnectionFilter = "all" | "on" | "off" | "setup";
type TransportChoice = "http" | "sse" | "stdio";
type AuthChoice = "none" | "bearer" | "oauth";

type ToolDraft = {
  name: string;
  description: string;
  endpoint: string;
  /** Raw saved value ("" when unset, which the runtime treats as stdio). */
  transport: string;
  authType: string;
  clientId: string;
  oauthAuthorizationUrl: string;
  oauthTokenUrl: string;
  scopesText: string;
  command: string;
  argsText: string;
  runtimeInvocationsText: string;
  secret: string;
  approvalRequired: boolean;
  hermesCompanion: boolean;
  allowedGroupIds: string[];
};

const HTTP_TRANSPORTS = new Set(["http", "https", "streamable-http", "streamable_http"]);
const SSE_TRANSPORTS = new Set(["sse", "http+sse", "http-sse"]);
const TEST_INPUT = "Test from Aperture";

/** Library > Tools: MCP connections plus the Prompt and Skill libraries. */
export function ToolsLibrary({
  data,
  onDataChange,
}: {
  data: BootstrapData;
  onDataChange: DataUpdater;
}) {
  const [tab, setTab] = useState<"connections" | "prompts" | "skills">("connections");
  const isAdmin = data.me.role === "TENANT_ADMIN" || data.me.role === "PLATFORM_OWNER";
  const promptLibraryAvailable = connectorEnabled(data.connectors, "prompt-library");
  const tabs: Array<[string, typeof tab]> = [
    ["Connections", "connections"],
    ["Prompts", "prompts"],
    ["Skills", "skills"],
  ];

  return (
    <div className="tools-library">
      <div className="ws-segmented tools-subnav" role="tablist" aria-label="Tool workspace sections">
        {tabs.map(([label, value]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            data-state={tab === value ? "active" : "inactive"}
            onClick={() => setTab(value)}
          >
            {value === "connections" ? <PlugZap size={14} /> : value === "prompts" ? <FileText size={14} /> : <Blocks size={14} />}
            {label}
          </button>
        ))}
      </div>
      {tab === "connections" && <ConnectionsView data={data} onDataChange={onDataChange} />}
      {tab === "prompts" &&
        (promptLibraryAvailable || isAdmin ? (
          <>
            {!promptLibraryAvailable && (
              <div className="ws-notice is-warning" role="status">
                <AlertTriangle size={16} />
                <span>
                  The Prompt Library is turned off for this workspace, so people can't see or use these prompts. Turn it
                  back on in Platform console → Org Settings → Connectors.
                </span>
              </div>
            )}
            <ToolLibraryManager mode="template" data={data} onDataChange={onDataChange} />
          </>
        ) : (
          <div className="ws-empty">
            <span className="ws-empty-icon">
              <FileText size={24} />
            </span>
            <h2>The Prompt Library is turned off</h2>
            <p>Your workspace administrators have turned off shared prompts.</p>
          </div>
        ))}
      {tab === "skills" && <ToolLibraryManager mode="skill" data={data} onDataChange={onDataChange} />}
    </div>
  );
}

function ConnectionsView({ data, onDataChange }: { data: BootstrapData; onDataChange: DataUpdater }) {
  const me = data.me;
  const isOwner = me.role === "PLATFORM_OWNER";
  const isAdmin = isOwner || me.role === "TENANT_ADMIN";
  const canAuthor = isAdmin || Boolean(data.authoringState?.tools_enabled);
  const canManage = (tool: ToolConfig) => isAdmin || (canAuthor && tool.owner_user_id === me.id);
  const mcpAvailable = connectorEnabled(data.connectors, "mcp");

  // Admins see the whole catalog so they can manage it. Everyone else sees
  // the connections they can actually use plus their own; MCP connections
  // disappear for them while the workspace MCP switch is off.
  const rows = useMemo(() => {
    if (isAdmin) return data.tools;
    return data.tools.filter(
      (tool) =>
        (tool.owner_user_id === me.id || toolUsableBy(me, tool)) && (mcpAvailable || !isMcpRuntimeTool(tool)),
    );
  }, [data.tools, isAdmin, mcpAvailable, me]);

  const [status, setStatus] = useState<ActionStatus>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ConnectionFilter>("all");
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ kind: "create" } | { kind: "edit"; toolId: string } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ToolDraft>>({});
  const [healthResults, setHealthResults] = useState<Record<string, McpHealthResult>>({});
  const [callResults, setCallResults] = useState<Record<string, McpToolCallResult>>({});
  const [signInStarted, setSignInStarted] = useState<{ toolId: string; fallbackUrl?: string } | null>(null);

  useEffect(() => {
    if (!status || status.tone === "danger") return;
    const timeoutId = window.setTimeout(() => setStatus(null), 20_000);
    return () => window.clearTimeout(timeoutId);
  }, [status]);

  const counts = useMemo(
    () => ({
      all: rows.length,
      on: rows.filter((tool) => tool.enabled).length,
      off: rows.filter((tool) => !tool.enabled).length,
      setup: rows.filter((tool) => connectionIssues(tool).length > 0).length,
    }),
    [rows],
  );
  const visibleRows = rows.filter((tool) => {
    if (filter === "on" && !tool.enabled) return false;
    if (filter === "off" && tool.enabled) return false;
    if (filter === "setup" && connectionIssues(tool).length === 0) return false;
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [tool.name, visibleDescription(tool), connectionTypeLabel(tool), tool.endpoint ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });

  function replaceTool(saved: ToolConfig) {
    onDataChange((current) => ({
      ...current,
      tools: current.tools.map((tool) => (tool.id === saved.id ? saved : tool)),
    }));
  }

  function draftFor(tool: ToolConfig): ToolDraft {
    return drafts[tool.id] ?? draftFromTool(tool);
  }

  function updateDraft(tool: ToolConfig, patch: Partial<ToolDraft>) {
    setDrafts((current) => ({ ...current, [tool.id]: { ...(current[tool.id] ?? draftFromTool(tool)), ...patch } }));
  }

  function resetDraft(toolId: string) {
    setDrafts((current) => {
      const next = { ...current };
      delete next[toolId];
      return next;
    });
  }

  function openEditor(tool: ToolConfig) {
    setStatus(null);
    setEditor({ kind: "edit", toolId: tool.id });
  }

  function closeEditor() {
    if (editor?.kind === "edit") {
      const tool = data.tools.find((item) => item.id === editor.toolId);
      if (tool && drafts[tool.id] && isDirty(tool, drafts[tool.id], isOwner, isAdmin)) {
        if (!window.confirm(`Discard your unsaved changes to ${tool.name}?`)) return;
      }
      resetDraft(editor.toolId);
    }
    setSignInStarted(null);
    setEditor(null);
  }

  async function setEnabled(tool: ToolConfig, enabled: boolean) {
    setPending(`toggle:${tool.id}`);
    // Optimistic, with rollback: the switch must never show a state the
    // server refused.
    onDataChange((current) => ({
      ...current,
      tools: current.tools.map((item) => (item.id === tool.id ? { ...item, enabled } : item)),
    }));
    try {
      const record = await updateAdminToolConfig(me.id, tool.id, { enabled });
      replaceTool(mapToolConfigRecordToDisplay(record));
      const issues = connectionIssues(tool);
      setStatus(
        enabled && issues.length
          ? { tone: "warning", message: `${tool.name} is on, but it still needs setup: ${issues.join("; ")}.` }
          : { tone: "success", message: `${tool.name} is ${enabled ? "on" : "off"}.` },
      );
    } catch (error) {
      onDataChange((current) => ({
        ...current,
        tools: current.tools.map((item) => (item.id === tool.id ? { ...item, enabled: tool.enabled } : item)),
      }));
      setStatus({
        tone: "danger",
        message: `${tool.name} was not turned ${enabled ? "on" : "off"}: ${errorMessage(error)}`,
      });
    } finally {
      setPending(null);
    }
  }

  async function saveTool(tool: ToolConfig) {
    const draft = draftFor(tool);
    if (!draft.name.trim()) {
      setStatus({ tone: "warning", message: "Give the connection a name before saving." });
      return;
    }
    const built = buildUpdatePayload(tool, draft, { isOwner, isAdmin });
    if (built.error) {
      setStatus({ tone: "warning", message: built.error });
      return;
    }
    if (!built.dirty) return;
    setPending(`save:${tool.id}`);
    try {
      const record = await updateAdminToolConfig(me.id, tool.id, built.payload);
      const saved = mapToolConfigRecordToDisplay(record);
      replaceTool(saved);
      resetDraft(tool.id);
      setStatus({ tone: "success", message: `${saved.name} saved.` });
    } catch (error) {
      setStatus({ tone: "danger", message: `${tool.name} was not saved: ${errorMessage(error)}` });
    } finally {
      setPending(null);
    }
  }

  async function deleteTool(tool: ToolConfig) {
    setOpenMenu(null);
    if (!window.confirm(`Delete ${tool.name}? Agents that use it lose access to it. This can't be undone.`)) return;
    setPending(`delete:${tool.id}`);
    try {
      await deleteAdminToolConfig(me.id, tool.id);
      onDataChange((current) => ({
        ...current,
        tools: current.tools.filter((item) => item.id !== tool.id),
        models: current.models.map((model) => ({
          ...model,
          tool_config_ids: model.tool_config_ids?.filter((toolId) => toolId !== tool.id),
          tool_ids: model.tool_ids?.filter((toolId) => toolId !== tool.id),
        })),
      }));
      resetDraft(tool.id);
      setEditor((current) => (current?.kind === "edit" && current.toolId === tool.id ? null : current));
      setStatus({ tone: "success", message: `${tool.name} was deleted.` });
    } catch (error) {
      setStatus({ tone: "danger", message: `${tool.name} was not deleted: ${errorMessage(error)}` });
    } finally {
      setPending(null);
    }
  }

  async function createConnection(input: { name: string; url: string; transport: TransportChoice; command: string; argsText: string }) {
    setPending("create");
    try {
      const record = await createAdminToolConfig(me.id, {
        name: input.name.trim(),
        tool_type: "mcp",
        endpoint_url: input.transport === "stdio" ? null : input.url.trim(),
        // Off until someone tests it and turns it on; asking before each use
        // is the safe default for a new server.
        enabled: false,
        approval_required: true,
        allowed_group_ids: [],
        settings:
          input.transport === "stdio"
            ? { transport: "stdio", command: input.command.trim(), args: parseArgs(input.argsText) }
            : { transport: input.transport },
      });
      const saved = mapToolConfigRecordToDisplay(record);
      onDataChange((current) => ({ ...current, tools: [...current.tools, saved] }));
      setEditor({ kind: "edit", toolId: saved.id });
      setStatus({
        tone: "success",
        message: `${saved.name} was added and is off. Test it below, choose who can use it, then turn it on.`,
      });
    } catch (error) {
      setStatus({ tone: "danger", message: `The connection was not added: ${errorMessage(error)}` });
    } finally {
      setPending(null);
    }
  }

  async function runHealthCheck(tool: ToolConfig) {
    setPending(`health:${tool.id}`);
    try {
      const result = await checkToolMcpHealth(me.id, tool.id);
      setHealthResults((current) => ({ ...current, [tool.id]: result }));
    } catch (error) {
      setHealthResults((current) => ({
        ...current,
        [tool.id]: {
          tool_config_id: tool.id,
          name: tool.name,
          transport: effectiveTransport(tool),
          status: "error",
          message: errorMessage(error),
          tools: [],
          server_info: {},
        },
      }));
    } finally {
      setPending(null);
    }
  }

  async function runToolCall(tool: ToolConfig, invocation: McpRuntimeInvocation) {
    setPending(`call:${tool.id}`);
    try {
      const result = await callToolMcp(me.id, tool.id, {
        tool_name: invocation.tool_name,
        label: invocation.label,
        arguments: substituteArguments(invocation.arguments ?? {}, {
          query: TEST_INPUT,
          user_message: TEST_INPUT,
          agent_profile_id: "library-test",
          agent_profile_name: "Library test",
        }),
      });
      setCallResults((current) => ({ ...current, [tool.id]: result }));
    } catch (error) {
      setCallResults((current) => ({
        ...current,
        [tool.id]: {
          tool_config_id: tool.id,
          name: tool.name,
          transport: effectiveTransport(tool),
          tool_name: invocation.tool_name,
          label: invocation.label,
          status: "error",
          message: errorMessage(error),
          is_error: true,
        },
      }));
    } finally {
      setPending(null);
    }
  }

  async function connectProvider(tool: ToolConfig) {
    // Open the window during the click so pop-up blockers allow it, then
    // point it at the server-signed sign-in URL once the API returns it.
    const popup = window.open("about:blank", "_blank");
    if (popup) {
      try {
        popup.opener = null;
      } catch {
        /* Some browsers make opener read-only; the provider page is still isolated by origin. */
      }
    }
    setPending(`oauth:${tool.id}`);
    try {
      const { authorize_url } = await getToolOAuthAuthorizeUrl(me.id, tool.id);
      if (popup && !popup.closed) {
        popup.location.href = authorize_url;
        setSignInStarted({ toolId: tool.id });
      } else {
        setSignInStarted({ toolId: tool.id, fallbackUrl: authorize_url });
      }
      setStatus(null);
    } catch (error) {
      popup?.close();
      setStatus({ tone: "danger", message: `Couldn't start sign-in for ${tool.name}: ${errorMessage(error)}` });
    } finally {
      setPending(null);
    }
  }

  async function refreshSignIn(tool: ToolConfig) {
    setPending(`oauth-refresh:${tool.id}`);
    try {
      const records = await listAdminToolConfigs(me.id);
      const record = records.find((item: ToolConfigRecord) => item.id === tool.id);
      if (!record) throw new Error("This connection no longer exists.");
      const saved = mapToolConfigRecordToDisplay(record);
      replaceTool(saved);
      if (saved.oauth_token_stored) {
        setSignInStarted(null);
        setStatus({ tone: "success", message: `${tool.name} is signed in.` });
      } else {
        setStatus({
          tone: "warning",
          message: `${tool.name} isn't signed in yet. Finish signing in in the other window, then check again.`,
        });
      }
    } catch (error) {
      setStatus({ tone: "danger", message: `Couldn't check sign-in for ${tool.name}: ${errorMessage(error)}` });
    } finally {
      setPending(null);
    }
  }

  async function disconnectProvider(tool: ToolConfig) {
    if (!window.confirm(`Disconnect ${tool.name} from its provider? Aperture deletes the saved sign-in token.`)) return;
    setPending(`oauth-clear:${tool.id}`);
    try {
      replaceTool(mapToolConfigRecordToDisplay(await clearToolOAuthToken(me.id, tool.id)));
      setStatus({ tone: "success", message: `${tool.name} was disconnected from its provider.` });
    } catch (error) {
      setStatus({ tone: "danger", message: `${tool.name} was not disconnected: ${errorMessage(error)}` });
    } finally {
      setPending(null);
    }
  }

  async function removeSecret(tool: ToolConfig, label: string) {
    if (!window.confirm(`Remove the saved ${label} for ${tool.name}?`)) return;
    setPending(`secret-clear:${tool.id}`);
    try {
      replaceTool(mapToolConfigRecordToDisplay(await clearToolSecret(me.id, tool.id)));
      setStatus({ tone: "success", message: `The saved ${label} for ${tool.name} was removed.` });
    } catch (error) {
      setStatus({ tone: "danger", message: `The ${label} was not removed: ${errorMessage(error)}` });
    } finally {
      setPending(null);
    }
  }

  const statusNotice = status && (
    <div className={`ws-notice is-${status.tone}`} role={status.tone === "danger" ? "alert" : "status"}>
      {status.tone === "success" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
      <span>{status.message}</span>
      <button
        className="icon-button"
        type="button"
        aria-label="Dismiss notification"
        data-tooltip="Clear this message"
        onClick={() => setStatus(null)}
      >
        <X size={14} />
      </button>
    </div>
  );

  if (editor?.kind === "create") {
    return (
      <CreateConnectionForm
        canUseCommand={isOwner}
        pending={pending === "create"}
        statusNotice={statusNotice}
        onCancel={() => setEditor(null)}
        onSubmit={(input) => void createConnection(input)}
      />
    );
  }

  const editingTool = editor?.kind === "edit" ? data.tools.find((tool) => tool.id === editor.toolId) : undefined;
  if (editingTool) {
    return (
      <ConnectionEditor
        tool={editingTool}
        data={data}
        draft={draftFor(editingTool)}
        perms={{ isOwner, isAdmin, canManage: canManage(editingTool) }}
        pending={pending}
        health={healthResults[editingTool.id]}
        call={callResults[editingTool.id]}
        signInStarted={signInStarted?.toolId === editingTool.id ? signInStarted : null}
        statusNotice={statusNotice}
        openMenu={openMenu}
        setOpenMenu={setOpenMenu}
        onDraft={(patch) => updateDraft(editingTool, patch)}
        onDiscard={() => resetDraft(editingTool.id)}
        onClose={closeEditor}
        onSave={() => void saveTool(editingTool)}
        onToggle={(next) => void setEnabled(editingTool, next)}
        onDelete={() => void deleteTool(editingTool)}
        onTest={() => void runHealthCheck(editingTool)}
        onRun={(invocation) => void runToolCall(editingTool, invocation)}
        onConnect={() => void connectProvider(editingTool)}
        onRefreshSignIn={() => void refreshSignIn(editingTool)}
        onDisconnect={() => void disconnectProvider(editingTool)}
        onRemoveSecret={(label) => void removeSecret(editingTool, label)}
      />
    );
  }

  return (
    <div className="tools-connections">
      {statusNotice}
      {!mcpAvailable && (
        <div className="ws-notice is-warning" role="status">
          <AlertTriangle size={16} />
          <span>
            {isAdmin
              ? "MCP servers are turned off for this workspace, so nobody can use these connections until the MCP Servers connector is turned back on (Platform console → Org Settings → Connectors)."
              : "MCP servers are turned off for this workspace."}
          </span>
        </div>
      )}
      {!isAdmin && (
        <div className="ws-notice" role="note">
          <Lock size={15} />
          <span>
            {canAuthor
              ? "Connections you add are private to you. An administrator can share them with groups and run connection tests."
              : "Connections are managed by your administrators. These are the ones you can use in Agent mode."}
          </span>
        </div>
      )}

      {rows.length > 0 && (
        <div className="ws-toolbar">
          <label className="ws-search">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              value={query}
              placeholder="Search connections"
              aria-label="Search connections"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="ws-chips" role="group" aria-label="Filter connections">
            {(
              [
                ["all", "All"],
                ["on", "On"],
                ["off", "Off"],
                ["setup", "Needs setup"],
              ] as Array<[ConnectionFilter, string]>
            )
              .filter(([key]) => key !== "setup" || counts.setup > 0 || filter === "setup")
              .map(([key, label]) => (
                <button key={key} type="button" className="ws-chip" aria-pressed={filter === key} onClick={() => setFilter(key)}>
                  {key === "setup" && <AlertTriangle size={13} />}
                  {label} <span className="ws-chip-count">{counts[key]}</span>
                </button>
              ))}
          </div>
          {canAuthor && (
            <div className="ws-toolbar-actions">
              <button className="primary-button compact-button" type="button" onClick={() => setEditor({ kind: "create" })}>
                <Plus size={16} /> Add connection
              </button>
            </div>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="ws-empty">
          <span className="ws-empty-icon">
            <PlugZap size={24} />
          </span>
          <h2>{canAuthor ? "Connect your first tool" : "No connections are shared with you yet"}</h2>
          <p>
            {canAuthor
              ? "A connection lets agents call an external tool server through the Model Context Protocol (MCP). Add the server's address, test it, then choose who can use it. Nothing is saved until you add it."
              : "When an administrator shares a connection with one of your groups, it appears here and in Agent mode."}
          </p>
          {canAuthor && (
            <div className="ws-empty-actions">
              <button className="primary-button compact-button" type="button" onClick={() => setEditor({ kind: "create" })}>
                <Plus size={16} /> Add connection
              </button>
            </div>
          )}
        </div>
      ) : visibleRows.length === 0 ? (
        <p className="ws-no-results">No connections match your search.</p>
      ) : (
        <div className="ws-card-grid tools-card-grid">
          {visibleRows.map((tool) => (
            <ConnectionCard
              key={tool.id}
              tool={tool}
              data={data}
              canManage={canManage(tool)}
              health={healthResults[tool.id]}
              busy={Boolean(pending?.endsWith(`:${tool.id}`))}
              openMenu={openMenu}
              setOpenMenu={setOpenMenu}
              onOpen={() => openEditor(tool)}
              onToggle={(next) => void setEnabled(tool, next)}
              onDelete={() => void deleteTool(tool)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ConnectionCard({
  tool,
  data,
  canManage,
  health,
  busy,
  openMenu,
  setOpenMenu,
  onOpen,
  onToggle,
  onDelete,
}: {
  tool: ToolConfig;
  data: BootstrapData;
  canManage: boolean;
  health?: McpHealthResult;
  busy: boolean;
  openMenu: string | null;
  setOpenMenu: (value: string | null) => void;
  onOpen: () => void;
  onToggle: (next: boolean) => void;
  onDelete: () => void;
}) {
  const issues = connectionIssues(tool);
  const description = visibleDescription(tool);
  const approval = approvalSummary(tool);
  const signIn = signInSummary(tool);
  const where = connectionLocation(tool);
  return (
    <article
      className={`ws-card tools-card ${issues.length ? "is-attention" : ""} ${tool.enabled ? "" : "is-muted"}`}
      aria-label={tool.name}
    >
      <div className="ws-card-head">
        <span className="ws-card-icon" aria-hidden="true">
          <ConnectionIcon tool={tool} />
        </span>
        <div>
          <h3 className="ws-card-title">{tool.name}</h3>
          <p className="ws-card-meta">
            {connectionTypeLabel(tool)}
            {where ? ` · ${where}` : ""}
          </p>
        </div>
        <StatusBadge tool={tool} health={health} />
      </div>
      <div className="ws-card-body">
        {description && <p className="lib-card-desc">{description}</p>}
        <ul className="ws-facts" aria-label={`${tool.name} details`}>
          <li className="ws-fact">
            <Users size={13} /> {accessSummary(tool, data)}
          </li>
          {approval && (
            <li className="ws-fact">
              <ShieldCheck size={13} /> {approval}
            </li>
          )}
          {signIn && (
            <li className="ws-fact">
              <KeyRound size={13} /> {signIn}
            </li>
          )}
          {tool.type === "mcp" && tool.hermes_companion && (
            <li className="ws-fact">
              <Sparkles size={13} /> Hermes companion
            </li>
          )}
        </ul>
        {issues.length > 0 && (
          <ul className="lib-card-issues">
            {issues.map((issue) => (
              <li key={issue}>
                <AlertTriangle size={13} /> {issue}
              </li>
            ))}
          </ul>
        )}
      </div>
      {canManage && (
        <div className="ws-card-foot">
          <span className="lib-switch-inline">
            <Toggle
              checked={tool.enabled}
              disabled={busy}
              label={`Turn ${tool.name} on or off`}
              tooltip={tool.enabled ? `Turn off ${tool.name}` : `Turn on ${tool.name}`}
              onChange={onToggle}
            />
            <span aria-hidden="true">{tool.enabled ? "On" : "Off"}</span>
          </span>
          <span className="ws-spacer" />
          {tool.type !== "custom_script" && (
            <button className="secondary-button compact-button" type="button" onClick={onOpen} disabled={busy} aria-label={`Edit ${tool.name}`}>
              <PenLine size={15} /> Edit
            </button>
          )}
          <OverflowMenu id={`card:${tool.id}`} label={`More actions for ${tool.name}`} openMenu={openMenu} setOpenMenu={setOpenMenu} up>
            <button type="button" role="menuitem" className="is-danger" disabled={busy} onClick={onDelete}>
              <Trash2 size={15} /> Delete
            </button>
          </OverflowMenu>
        </div>
      )}
      {tool.type === "custom_script" && canManage && (
        <p className="lib-card-note">Edit this response action's script in Admin → Tools.</p>
      )}
    </article>
  );
}

function StatusBadge({
  tool,
  health,
  problemsOnly = false,
}: {
  tool: ToolConfig;
  health?: McpHealthResult;
  /** Next to an on/off switch, plain On/Off would only repeat the switch. */
  problemsOnly?: boolean;
}) {
  if (connectionIssues(tool).length) return <span className="ws-badge is-warn">Needs setup</span>;
  if (health && health.status !== "ready") return <span className="ws-badge is-danger">Last test failed</span>;
  if (problemsOnly) return null;
  return tool.enabled ? <span className="ws-badge is-ok">On</span> : <span className="ws-badge is-muted">Off</span>;
}

function ConnectionIcon({ tool, size = 18 }: { tool: ToolConfig; size?: number }) {
  if (tool.type === "custom_script") return <Terminal size={size} />;
  if (isMcpRuntimeTool(tool)) {
    const transport = effectiveTransport(tool);
    if (transport === "stdio") return <Terminal size={size} />;
    if (SSE_TRANSPORTS.has(transport)) return <Radio size={size} />;
    return <Globe size={size} />;
  }
  if (tool.type === "prompt-library" || tool.type === "skill-library") return <FileText size={size} />;
  if (tool.type === "workflow") return <Workflow size={size} />;
  return <Blocks size={size} />;
}

function CreateConnectionForm({
  canUseCommand,
  pending,
  statusNotice,
  onCancel,
  onSubmit,
}: {
  canUseCommand: boolean;
  pending: boolean;
  statusNotice: ReactNode;
  onCancel: () => void;
  onSubmit: (input: { name: string; url: string; transport: TransportChoice; command: string; argsText: string }) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState<TransportChoice>("http");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const urlProblem = transport !== "stdio" && url.trim() && !isHttpUrl(url) ? "Use a full address starting with https://" : null;
  const ready = Boolean(name.trim()) && (transport === "stdio" ? Boolean(command.trim()) : Boolean(url.trim()) && !urlProblem);

  return (
    <div className="agent-editor-view tools-editor-view">
      <div className="agent-editor-head">
        <button className="agent-editor-back" type="button" onClick={onCancel} disabled={pending} data-tooltip="Return to all connections without adding one">
          <ArrowLeft size={16} /> All connections
        </button>
        <div className="agent-editor-title">
          <span className="ws-card-icon" aria-hidden="true">
            <PlugZap size={18} />
          </span>
          <div>
            <h2>Add a connection</h2>
            <p>Connect an MCP server. It starts turned off, so you can test it before anyone uses it.</p>
          </div>
        </div>
      </div>
      {statusNotice}
      <form
        className="agent-editor-card"
        aria-label="Add a connection"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !pending) onSubmit({ name, url, transport, command, argsText });
        }}
      >
        <div className="tab-content tools-tab">
          <p className="agent-tab-intro">Name it for the people who will use it, then tell Aperture where the server is.</p>
          <div className="tools-tab-fields">
            <label className="lib-field">
              Name
              <input value={name} autoFocus placeholder="e.g. Matter search" onChange={(event) => setName(event.target.value)} />
            </label>
            <div className="lib-field">
              <span id="create-connection-type">How Aperture connects</span>
              <div className="ws-segmented" role="group" aria-labelledby="create-connection-type">
                <button type="button" aria-pressed={transport === "http"} onClick={() => setTransport("http")}>
                  <Globe size={14} /> HTTP
                </button>
                <button type="button" aria-pressed={transport === "sse"} onClick={() => setTransport("sse")}>
                  <Radio size={14} /> SSE
                </button>
                {canUseCommand && (
                  <button type="button" aria-pressed={transport === "stdio"} onClick={() => setTransport("stdio")}>
                    <Terminal size={14} /> Local command
                  </button>
                )}
              </div>
              <small className="lib-field-hint">{transportHint(transport)}</small>
            </div>
            {transport === "stdio" ? (
              <>
                <label className="lib-field">
                  Command
                  <input value={command} placeholder="e.g. hermes" onChange={(event) => setCommand(event.target.value)} />
                </label>
                <Field label="Arguments" hint="Separate arguments with commas.">
                  {(control) => (
                    <input {...control} value={argsText} placeholder="e.g. mcp, serve" onChange={(event) => setArgsText(event.target.value)} />
                  )}
                </Field>
              </>
            ) : (
              <Field label="Server URL" error={urlProblem}>
                {(control) => (
                  <input
                    {...control}
                    value={url}
                    type="url"
                    inputMode="url"
                    placeholder={transport === "sse" ? "https://mcp.example.com/sse" : "https://mcp.example.com/mcp"}
                    aria-invalid={Boolean(urlProblem)}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                )}
              </Field>
            )}
          </div>
        </div>
        <div className="agent-editor-foot">
          <span className="agent-editor-foot-note">Sign-in, access, and approvals are set on the next screen.</span>
          <span className="ws-spacer" />
          <button className="secondary-button compact-button" type="button" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button className="primary-button compact-button" type="submit" disabled={!ready || pending}>
            <StableLabel label={pending ? "Adding..." : "Add connection"} reserve={["Adding...", "Add connection"]} />
          </button>
        </div>
      </form>
    </div>
  );
}

function ConnectionEditor({
  tool,
  data,
  draft,
  perms,
  pending,
  health,
  call,
  signInStarted,
  statusNotice,
  openMenu,
  setOpenMenu,
  onDraft,
  onDiscard,
  onClose,
  onSave,
  onToggle,
  onDelete,
  onTest,
  onRun,
  onConnect,
  onRefreshSignIn,
  onDisconnect,
  onRemoveSecret,
}: {
  tool: ToolConfig;
  data: BootstrapData;
  draft: ToolDraft;
  perms: { isOwner: boolean; isAdmin: boolean; canManage: boolean };
  pending: string | null;
  health?: McpHealthResult;
  call?: McpToolCallResult;
  signInStarted: { toolId: string; fallbackUrl?: string } | null;
  statusNotice: ReactNode;
  openMenu: string | null;
  setOpenMenu: (value: string | null) => void;
  onDraft: (patch: Partial<ToolDraft>) => void;
  onDiscard: () => void;
  onClose: () => void;
  onSave: () => void;
  onToggle: (next: boolean) => void;
  onDelete: () => void;
  onTest: () => void;
  onRun: (invocation: McpRuntimeInvocation) => void;
  onConnect: () => void;
  onRefreshSignIn: () => void;
  onDisconnect: () => void;
  onRemoveSecret: (label: string) => void;
}) {
  const { isOwner, isAdmin, canManage } = perms;
  const readOnly = !canManage;
  const isMcp = isMcpRuntimeTool(tool);
  const built = buildUpdatePayload(tool, draft, { isOwner, isAdmin });
  const dirty = built.dirty;
  const issues = connectionIssues(tool);
  const transport = normalizedTransport(draft.transport || effectiveTransport(tool));
  const savedTransport = normalizedTransport(effectiveTransport(tool));
  const savedRunsCommand = savedTransport === "stdio" && Boolean(tool.command?.trim());
  // Only the platform owner may change what runs on the server; for everyone
  // else a service-managed command connection keeps its launch settings.
  const connectionLocked = !isOwner && savedRunsCommand;
  const authChoice = authChoiceOf(draft.authType);
  const savedAuthChoice = authChoiceOf(tool.auth_type ?? "none");
  const redirectUrl = tool.oauth_callback_url && isHttpUrl(tool.oauth_callback_url) ? tool.oauth_callback_url : toolOAuthRedirectUrl(tool.id);
  const savedInvocations = normalizeInvocations(tool.runtime_invocations ?? []);
  const [tab, setTab] = useState("connection");
  const [invocationIndex, setInvocationIndex] = useState(0);
  const selectedInvocation = savedInvocations[Math.min(invocationIndex, Math.max(savedInvocations.length - 1, 0))];
  const [copied, setCopied] = useState(false);
  const busy = Boolean(pending?.endsWith(`:${tool.id}`));
  const testBlocked = !isAdmin
    ? "Only administrators can run connection tests."
    : dirty
      ? "Save changes to test them."
      : null;
  const signInBlocked = !isAdmin
    ? "Ask an administrator to connect this to its provider."
    : dirty
      ? "Save changes before connecting."
      : !tool.oauth_authorization_url?.trim() || !tool.client_id?.trim()
        ? "Add the authorization URL and client ID, then save."
        : null;
  const secretLabel = authChoice === "oauth" ? "client secret" : "access token";
  const tabs: Array<[string, string, ReactNode]> = [
    ["connection", "Connection", <PlugZap size={15} key="i" />],
    ...(isMcp ? ([["signin", "Sign-in", <KeyRound size={15} key="i" />]] as Array<[string, string, ReactNode]>) : []),
    ["access", "Access & approval", <Users size={15} key="i" />],
    ...(isMcp
      ? ([
          ["test", "Test", <Play size={15} key="i" />],
          ["advanced", "Advanced", <Settings2 size={15} key="i" />],
        ] as Array<[string, string, ReactNode]>)
      : []),
  ];

  return (
    <div className="agent-editor-view tools-editor-view">
      <div className="agent-editor-head">
        <button
          className="agent-editor-back"
          type="button"
          onClick={onClose}
          aria-label="Back to all connections"
          data-tooltip="Return to all connections"
        >
          <ArrowLeft size={16} /> All connections
        </button>
        <div className="agent-editor-title">
          <span className="ws-card-icon" aria-hidden="true">
            <ConnectionIcon tool={tool} />
          </span>
          <div>
            <h2>{tool.name}</h2>
            <p>
              {connectionTypeLabel(tool)} · {accessSummary(tool, data)}
            </p>
          </div>
        </div>
        <div className="agent-editor-head-actions">
          <StatusBadge tool={tool} health={health} problemsOnly={canManage} />
          {canManage && (
            <span className="lib-switch-inline">
              <Toggle
                checked={tool.enabled}
                disabled={busy}
                label={`Turn ${tool.name} on or off`}
                tooltip={tool.enabled ? `Turn off ${tool.name}` : `Turn on ${tool.name}`}
                onChange={onToggle}
              />
              <span aria-hidden="true">{tool.enabled ? "On" : "Off"}</span>
            </span>
          )}
          {canManage && (
            <OverflowMenu id="editor" label={`More actions for ${tool.name}`} openMenu={openMenu} setOpenMenu={setOpenMenu}>
              <button type="button" role="menuitem" className="is-danger" disabled={busy} onClick={onDelete}>
                <Trash2 size={15} /> Delete connection
              </button>
            </OverflowMenu>
          )}
        </div>
      </div>

      {statusNotice}
      {issues.length > 0 && (
        <div className="ws-notice is-warning">
          <AlertTriangle size={15} />
          <span>
            <strong>Needs setup:</strong> {issues.join("; ")}.
          </span>
        </div>
      )}

      <div className="agent-editor-card">
        <Tabs.Root className="tabs-root agent-editor-tabs" value={tab} onValueChange={setTab}>
          <Tabs.List className="tabs-list agent-tabs-list" aria-label={`${tool.name} sections`}>
            {tabs.map(([value, label, icon]) => (
              <Tabs.Trigger className="tab-trigger" key={value} value={value} aria-label={label}>
                {icon} {label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>

          <Tabs.Content className="tab-content tools-tab" value="connection">
            <p className="agent-tab-intro">What this connection is and where Aperture reaches it.</p>
            <label className="lib-field">
              Name
              <input value={draft.name} readOnly={readOnly} onChange={(event) => onDraft({ name: event.target.value })} />
            </label>
            <label className="lib-field">
              Description
              <textarea
                rows={2}
                value={draft.description}
                readOnly={readOnly}
                placeholder="What this connection lets agents do"
                onChange={(event) => onDraft({ description: event.target.value })}
              />
            </label>
            {isMcp ? (
              <>
                <div className="lib-field">
                  <span id={`connection-type-${tool.id}`}>How Aperture connects</span>
                  <div className="ws-segmented" role="group" aria-labelledby={`connection-type-${tool.id}`}>
                    {(
                      [
                        ["http", "HTTP", <Globe size={14} key="i" />],
                        ["sse", "SSE", <Radio size={14} key="i" />],
                        ["stdio", "Local command", <Terminal size={14} key="i" />],
                      ] as Array<[TransportChoice, string, ReactNode]>
                    )
                      .filter(([value]) => value !== "stdio" || isOwner || savedTransport === "stdio")
                      .map(([value, label, icon]) => (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={transport === value}
                          disabled={readOnly || connectionLocked || (value === "stdio" && !isOwner)}
                          onClick={() => onDraft({ transport: value })}
                        >
                          {icon} {label}
                        </button>
                      ))}
                  </div>
                  <small className="lib-field-hint">{transportHint(transport)}</small>
                </div>
                {transport === "stdio" ? (
                  <>
                    <label className="lib-field">
                      Command
                      <input
                        value={draft.command}
                        readOnly={readOnly || !isOwner}
                        placeholder="e.g. hermes"
                        onChange={(event) => onDraft({ command: event.target.value })}
                      />
                    </label>
                    <Field
                      label="Arguments"
                      hint={
                        isOwner
                          ? "Separate arguments with commas. The command runs on Aperture's server."
                          : "This connection runs a program on Aperture's server. Only the service owner can change how it starts."
                      }
                    >
                      {(control) => (
                        <input
                          {...control}
                          value={draft.argsText}
                          readOnly={readOnly || !isOwner}
                          placeholder="e.g. mcp, serve"
                          onChange={(event) => onDraft({ argsText: event.target.value })}
                        />
                      )}
                    </Field>
                  </>
                ) : (
                  <label className="lib-field">
                    Server URL
                    <input
                      value={draft.endpoint}
                      type="url"
                      inputMode="url"
                      readOnly={readOnly}
                      placeholder={transport === "sse" ? "https://mcp.example.com/sse" : "https://mcp.example.com/mcp"}
                      onChange={(event) => onDraft({ endpoint: event.target.value })}
                    />
                  </label>
                )}
              </>
            ) : (
              <div className="lib-field">
                <span>Type</span>
                <p className="lib-field-static">
                  {connectionTypeLabel(tool)}
                  {tool.endpoint ? <code>{tool.endpoint}</code> : null}
                </p>
                <small className="lib-field-hint">Built into Aperture; only its name, description, and access can be changed here.</small>
              </div>
            )}
          </Tabs.Content>

          {isMcp && (
            <Tabs.Content className="tab-content tools-tab" value="signin">
              <p className="agent-tab-intro">How Aperture proves who it is to this server. Saved secrets are never shown again.</p>
              <div className="lib-field">
                <span id={`auth-mode-${tool.id}`}>Sign-in method</span>
                <div className="ws-segmented" role="group" aria-labelledby={`auth-mode-${tool.id}`}>
                  {(
                    [
                      ["none", "None"],
                      ["bearer", "Access token"],
                      ["oauth", "OAuth"],
                    ] as Array<[AuthChoice, string]>
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={authChoice === value}
                      disabled={readOnly}
                      onClick={() =>
                        onDraft({
                          authType:
                            value === savedAuthChoice
                              ? (tool.auth_type ?? "none")
                              : value === "oauth"
                                ? "oauth-2.1-static"
                                : value === "bearer"
                                  ? "bearer-token"
                                  : "none",
                        })
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {authChoice === "none" && <small className="lib-field-hint">The server is called without credentials.</small>}
              </div>
              {authChoice === "oauth" && (
                <>
                  <div className="lib-field-row">
                    <label className="lib-field">
                      Client ID
                      <input value={draft.clientId} readOnly={readOnly} onChange={(event) => onDraft({ clientId: event.target.value })} />
                    </label>
                    <SecretField
                      label="Client secret"
                      stored={Boolean(tool.secret_set)}
                      value={draft.secret}
                      readOnly={readOnly}
                      busy={pending === `secret-clear:${tool.id}`}
                      onChange={(secret) => onDraft({ secret })}
                      onRemove={() => onRemoveSecret(secretLabel)}
                    />
                  </div>
                  <label className="lib-field">
                    Authorization URL
                    <input
                      value={draft.oauthAuthorizationUrl}
                      readOnly={readOnly}
                      placeholder="https://provider.example.com/oauth/authorize"
                      onChange={(event) => onDraft({ oauthAuthorizationUrl: event.target.value })}
                    />
                  </label>
                  <label className="lib-field">
                    Token URL
                    <input
                      value={draft.oauthTokenUrl}
                      readOnly={readOnly}
                      placeholder="https://provider.example.com/oauth/token"
                      onChange={(event) => onDraft({ oauthTokenUrl: event.target.value })}
                    />
                  </label>
                  <Field label="Scopes to request" hint="Sent to the provider as the OAuth scope when signing in. Separate with spaces.">
                    {(control) => (
                      <input
                        {...control}
                        value={draft.scopesText}
                        readOnly={readOnly}
                        placeholder="e.g. files.read offline_access"
                        onChange={(event) => onDraft({ scopesText: event.target.value })}
                      />
                    )}
                  </Field>
                  <div className="lib-field">
                    <span>Redirect URL</span>
                    <div className="lib-copy-field">
                      <input value={redirectUrl} readOnly aria-label="Redirect URL" />
                      <button
                        type="button"
                        className="secondary-button compact-button"
                        onClick={() =>
                          void copyCodeToClipboard(redirectUrl).then(
                            () => setCopied(true),
                            () => setCopied(false),
                          )
                        }
                      >
                        <Copy size={14} /> {copied ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <small className="lib-field-hint">Register this address with your provider as an allowed redirect URL.</small>
                  </div>
                  <div className="lib-signin-status">
                    {tool.oauth_token_stored ? (
                      <>
                        <span className="ws-badge is-ok">Signed in — token saved</span>
                        <span className="ws-spacer" />
                        {isAdmin && (
                          <button type="button" className="secondary-button compact-button" disabled={busy} onClick={onDisconnect}>
                            <Unplug size={14} /> Disconnect
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <span className="ws-badge is-warn">Not signed in</span>
                        <span className="ws-spacer" />
                        <button
                          type="button"
                          className="secondary-button compact-button"
                          disabled={busy || Boolean(signInBlocked)}
                          data-tooltip={signInBlocked ?? "Open the provider's sign-in page in a new window"}
                          onClick={onConnect}
                        >
                          <KeyRound size={14} />{" "}
                          <StableLabel
                            label={pending === `oauth:${tool.id}` ? "Opening..." : "Connect with provider"}
                            reserve={["Opening...", "Connect with provider"]}
                          />
                        </button>
                      </>
                    )}
                  </div>
                  {!tool.oauth_token_stored && signInBlocked && <small className="lib-field-hint">{signInBlocked}</small>}
                  {signInStarted && (
                    <div className="ws-notice" role="status">
                      <KeyRound size={15} />
                      <span>
                        {signInStarted.fallbackUrl ? (
                          <>
                            Your browser blocked the sign-in window.{" "}
                            <a href={signInStarted.fallbackUrl} target="_blank" rel="noreferrer noopener">
                              Open the provider's sign-in page
                            </a>
                            , finish signing in, then check the status.
                          </>
                        ) : (
                          "Finish signing in in the window that opened, then check the status here."
                        )}
                      </span>
                      <button type="button" className="secondary-button compact-button" disabled={busy} onClick={onRefreshSignIn}>
                        <RefreshCw size={14} /> Check status
                      </button>
                    </div>
                  )}
                </>
              )}
              {authChoice === "bearer" && (
                <SecretField
                  label="Access token"
                  stored={Boolean(tool.secret_set)}
                  value={draft.secret}
                  readOnly={readOnly}
                  busy={pending === `secret-clear:${tool.id}`}
                  hint="Sent as an Authorization: Bearer header (local commands receive it as MCP_BEARER_TOKEN)."
                  onChange={(secret) => onDraft({ secret })}
                  onRemove={() => onRemoveSecret(secretLabel)}
                />
              )}
            </Tabs.Content>
          )}

          <Tabs.Content className="tab-content tools-tab" value="access">
            <p className="agent-tab-intro">Who can use this connection, and whether each use needs a yes first.</p>
            <fieldset className="lib-field lib-fieldset">
              <legend>Who can use it</legend>
              {isAdmin ? (
                data.groups.length === 0 ? (
                  <small className="lib-field-hint">
                    No groups are synced yet, so this is available to {tool.owner_user_id ? "its creator" : "everyone in the workspace"}.
                  </small>
                ) : (
                  <>
                    <div className="lib-check-grid">
                      {data.groups.map((group) => (
                        <label className="lib-check" key={group.id}>
                          <input
                            type="checkbox"
                            disabled={readOnly}
                            checked={draft.allowedGroupIds.includes(group.id)}
                            onChange={(event) =>
                              onDraft({
                                allowedGroupIds: event.target.checked
                                  ? Array.from(new Set([...draft.allowedGroupIds, group.id]))
                                  : draft.allowedGroupIds.filter((id) => id !== group.id),
                              })
                            }
                          />
                          <span>
                            <strong>{group.name}</strong>
                            <small>
                              {group.user_count} {group.user_count === 1 ? "person" : "people"}
                            </small>
                          </span>
                        </label>
                      ))}
                    </div>
                    <small className="lib-field-hint">
                      {tool.owner_user_id
                        ? "Leave every group unchecked to keep it private to the person who created it."
                        : "Leave every group unchecked to make it available to everyone in the workspace."}
                    </small>
                  </>
                )
              ) : (
                <p className="lib-field-static">{accessSummary(tool, data)}. Sharing with groups is managed by administrators.</p>
              )}
            </fieldset>
            <div className="lib-switch-row">
              <Toggle
                checked={draft.approvalRequired}
                disabled={readOnly}
                label="Ask before each use"
                onChange={(next) => onDraft({ approvalRequired: next })}
              />
              <span>
                <strong>Ask before each use</strong>
                <small>
                  {isMcp
                    ? "Before Aperture calls this connection, the person sending the message is asked to approve it in chat."
                    : "Only available in Agent mode, where each use can be approved."}
                </small>
              </span>
            </div>
            {tool.type === "mcp" && (
              <div className="lib-switch-row">
                <Toggle
                  checked={draft.hermesCompanion}
                  disabled={readOnly}
                  label="Available to Hermes companion"
                  onChange={(next) => onDraft({ hermesCompanion: next })}
                />
                <span>
                  <strong>Available to Hermes companion</strong>
                  <small>Agents that use the Hermes companion get this connection automatically, for people allowed to use it.</small>
                  {draft.hermesCompanion && draft.approvalRequired && (
                    <small className="lib-field-hint is-warning">
                      Because it asks before each use, Hermes uses it only in agents that list it as a tool, after the person
                      sending the message approves it. Otherwise it is skipped for that message.
                    </small>
                  )}
                </span>
              </div>
            )}
          </Tabs.Content>

          {isMcp && (
            <Tabs.Content className="tab-content tools-tab" value="test">
              <p className="agent-tab-intro">Runs from Aperture's server against the saved settings. Results are shown here only.</p>
              <div className="lib-test-actions">
                <button
                  type="button"
                  className="secondary-button compact-button"
                  disabled={Boolean(testBlocked) || busy}
                  data-tooltip={testBlocked ?? "Connect to the server and list the tools it offers"}
                  onClick={onTest}
                >
                  <PlugZap size={15} />{" "}
                  <StableLabel
                    label={pending === `health:${tool.id}` ? "Testing..." : "Test connection"}
                    reserve={["Testing...", "Test connection"]}
                  />
                </button>
                {savedInvocations.length > 1 && (
                  <SelectControl
                    className="lib-inline-select"
                    aria-label="Tool call to run"
                    value={String(Math.min(invocationIndex, savedInvocations.length - 1))}
                    onChange={(event) => setInvocationIndex(Number(event.target.value))}
                  >
                    {savedInvocations.map((invocation, index) => (
                      <option key={`${invocation.tool_name}-${index}`} value={String(index)}>
                        {invocation.label || invocation.tool_name}
                      </option>
                    ))}
                  </SelectControl>
                )}
                <button
                  type="button"
                  className="secondary-button compact-button"
                  disabled={Boolean(testBlocked) || busy || !selectedInvocation}
                  data-tooltip={
                    testBlocked ??
                    (selectedInvocation
                      ? `Call ${selectedInvocation.tool_name} once with the sample text "${TEST_INPUT}"`
                      : "Add a tool call under Advanced and save to run it")
                  }
                  onClick={() => selectedInvocation && onRun(selectedInvocation)}
                >
                  <Play size={15} />{" "}
                  <StableLabel
                    label={
                      pending === `call:${tool.id}`
                        ? "Running..."
                        : selectedInvocation
                          ? `Run ${selectedInvocation.label || selectedInvocation.tool_name}`
                          : "Run tool call"
                    }
                    reserve={["Running...", "Run tool call"]}
                  />
                </button>
              </div>
              <small className="lib-field-hint">
                {testBlocked ??
                  (selectedInvocation
                    ? `The tool call uses the sample text "${TEST_INPUT}" in place of {{query}}.`
                    : "To try a tool call, add one under Advanced and save.")}
              </small>
              {health && <HealthResult result={health} />}
              {call && <CallResult result={call} />}
            </Tabs.Content>
          )}

          {isMcp && (
            <Tabs.Content className="tab-content tools-tab" value="advanced">
              <p className="agent-tab-intro">
                Tool calls Aperture makes automatically on each Agent-mode message: a JSON list of the server's tools and their
                arguments. Use {"{{query}}"} for the person's message.
              </p>
              <Field label="Tool calls (JSON)" error={built.invocationError}>
                {(control) => (
                  <textarea
                    {...control}
                    className="lib-code"
                    rows={8}
                    value={draft.runtimeInvocationsText}
                    readOnly={readOnly}
                    spellCheck={false}
                    aria-invalid={Boolean(built.invocationError)}
                    placeholder={`[{"tool_name": "search", "label": "Search", "arguments": {"query": "{{query}}"}}]`}
                    onChange={(event) => onDraft({ runtimeInvocationsText: event.target.value })}
                  />
                )}
              </Field>
            </Tabs.Content>
          )}
        </Tabs.Root>

        {canManage && (
          <div className="agent-editor-foot">
            <span className="agent-editor-foot-note">{dirty ? "You have unsaved changes." : "All changes saved."}</span>
            <span className="ws-spacer" />
            {dirty && (
              <button className="secondary-button compact-button" type="button" disabled={busy} onClick={onDiscard}>
                Discard changes
              </button>
            )}
            <button
              className="primary-button compact-button"
              type="button"
              disabled={!dirty || busy || !draft.name.trim() || Boolean(built.invocationError)}
              onClick={onSave}
            >
              <StableLabel label={pending === `save:${tool.id}` ? "Saving..." : "Save changes"} reserve={["Saving...", "Save changes"]} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** A labelled control whose hint/error is linked by aria-describedby rather
 * than nested in the label (which would bloat the control's name). */
function Field({
  label,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: (control: { id: string; "aria-describedby"?: string }) => ReactNode;
}) {
  const id = useId();
  const hintId = useId();
  const message = error || hint;
  return (
    <div className="lib-field">
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-describedby": message ? hintId : undefined })}
      {message && (
        <small id={hintId} className={`lib-field-hint ${error ? "is-error" : ""}`}>
          {message}
        </small>
      )}
    </div>
  );
}

function SecretField({
  label,
  stored,
  value,
  readOnly,
  busy,
  hint,
  onChange,
  onRemove,
}: {
  label: string;
  stored: boolean;
  value: string;
  readOnly: boolean;
  busy: boolean;
  hint?: string;
  onChange: (value: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="lib-field">
      <div className="lib-field-label-row">
        <span>{label}</span>
        {stored ? <span className="ws-badge is-ok">Saved</span> : <span className="ws-badge is-muted">Not saved</span>}
      </div>
      <div className="lib-copy-field">
        <input
          type="password"
          autoComplete="new-password"
          aria-label={label}
          value={value}
          readOnly={readOnly}
          placeholder={stored ? "Saved — enter a new value to replace it" : `Paste the ${label.toLowerCase()}`}
          onChange={(event) => onChange(event.target.value)}
        />
        {stored && !readOnly && (
          <button type="button" className="secondary-button compact-button" disabled={busy} onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      {hint && <small className="lib-field-hint">{hint}</small>}
    </div>
  );
}

function HealthResult({ result }: { result: McpHealthResult }) {
  const ok = result.status === "ready";
  return (
    <div className={`lib-result ${ok ? "is-ok" : "is-fail"}`} role="status">
      <strong>
        {ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
        {ok
          ? `Connected — ${result.tools.length} ${result.tools.length === 1 ? "tool" : "tools"} available`
          : "Connection test failed"}
      </strong>
      <p>{result.message}</p>
      {result.tools.length > 0 && (
        <ul className="ws-facts" aria-label="Tools the server offers">
          {result.tools.map((tool) => (
            <li className="ws-fact" key={tool.name} title={tool.description ?? undefined}>
              {tool.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CallResult({ result }: { result: McpToolCallResult }) {
  const ok = result.status === "ready" && !result.is_error;
  const structured =
    result.structured_content === undefined || result.structured_content === null
      ? null
      : typeof result.structured_content === "string"
        ? result.structured_content
        : JSON.stringify(result.structured_content, null, 2);
  return (
    <div className={`lib-result ${ok ? "is-ok" : "is-fail"}`} role="status">
      <strong>
        {ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
        {`${result.label || result.tool_name}: ${ok ? "succeeded" : "failed"}`}
      </strong>
      <p>{result.message}</p>
      {result.result_text && <pre>{result.result_text}</pre>}
      {structured && <pre>{structured}</pre>}
    </div>
  );
}

/* ---------- Pure helpers (exported for tests) ---------- */

function draftFromTool(tool: ToolConfig): ToolDraft {
  return {
    name: tool.name,
    description: visibleDescription(tool),
    endpoint: tool.endpoint ?? "",
    transport: tool.transport ?? "",
    authType: tool.auth_type ?? "none",
    clientId: tool.client_id ?? "",
    oauthAuthorizationUrl: tool.oauth_authorization_url ?? "",
    oauthTokenUrl: tool.oauth_token_url ?? "",
    scopesText: (tool.scopes ?? []).join(" "),
    command: tool.command ?? "",
    argsText: (tool.args ?? []).join(", "),
    runtimeInvocationsText: tool.runtime_invocations?.length
      ? JSON.stringify(normalizeInvocations(tool.runtime_invocations), null, 2)
      : "",
    secret: "",
    approvalRequired: tool.approval_required,
    hermesCompanion: Boolean(tool.hermes_companion),
    allowedGroupIds: tool.allowed_group_ids ?? [],
  };
}

function isDirty(tool: ToolConfig, draft: ToolDraft, isOwner: boolean, isAdmin: boolean): boolean {
  return buildUpdatePayload(tool, draft, { isOwner, isAdmin }).dirty;
}

/** The PATCH body for a draft: only the fields that actually changed, so a
 * save never re-sends (and the server never re-validates) untouched settings
 * such as a service-managed stdio command. */
export function buildUpdatePayload(
  tool: ToolConfig,
  draft: ToolDraft,
  { isOwner, isAdmin }: { isOwner: boolean; isAdmin: boolean },
): { payload: AdminToolConfigUpdateRequest; dirty: boolean; error?: string; invocationError?: string } {
  const payload: AdminToolConfigUpdateRequest = {};
  const settings: ConfigSettings = {};
  const isMcp = isMcpRuntimeTool(tool);

  if (draft.name.trim() !== tool.name) payload.name = draft.name.trim();
  if (draft.description.trim() !== visibleDescription(tool)) settings.description = draft.description.trim();
  if (draft.approvalRequired !== tool.approval_required) payload.approval_required = draft.approvalRequired;
  if (isAdmin && !sameSet(draft.allowedGroupIds, tool.allowed_group_ids ?? [])) {
    payload.allowed_group_ids = draft.allowedGroupIds;
  }

  let invocationError: string | undefined;
  if (isMcp) {
    if (draft.endpoint.trim() !== (tool.endpoint ?? "")) payload.endpoint_url = draft.endpoint.trim();
    if (draft.transport !== (tool.transport ?? "")) settings.transport = draft.transport;
    if (draft.authType !== (tool.auth_type ?? "none")) settings.auth_type = draft.authType;
    if (draft.clientId.trim() !== (tool.client_id ?? "")) settings.client_id = draft.clientId.trim();
    if (draft.oauthAuthorizationUrl.trim() !== (tool.oauth_authorization_url ?? "")) {
      settings.oauth_authorization_url = draft.oauthAuthorizationUrl.trim();
    }
    if (draft.oauthTokenUrl.trim() !== (tool.oauth_token_url ?? "")) settings.oauth_token_url = draft.oauthTokenUrl.trim();
    const scopes = parseScopes(draft.scopesText);
    if (!sameList(scopes, tool.scopes ?? [])) settings.scopes = scopes;
    if (isOwner) {
      if (draft.command.trim() !== (tool.command ?? "").trim()) settings.command = draft.command.trim();
      const args = parseArgs(draft.argsText);
      if (!sameList(args, tool.args ?? [])) settings.args = args;
    }
    try {
      const invocations = parseRuntimeInvocationsJson(draft.runtimeInvocationsText);
      if (JSON.stringify(invocations) !== JSON.stringify(normalizeInvocations(tool.runtime_invocations ?? []))) {
        settings.runtime_invocations = invocations;
      }
    } catch (error) {
      invocationError = errorMessage(error);
    }
  }
  if (tool.type === "mcp" && draft.hermesCompanion !== Boolean(tool.hermes_companion)) {
    settings.hermes_companion = draft.hermesCompanion;
  }
  if (draft.secret.trim()) payload.secret_value = draft.secret.trim();

  const dirty = Object.keys(payload).length > 0 || Object.keys(settings).length > 0;
  // Providers need an absolute redirect URL; older saves stored a relative
  // path (or nothing). Fill it in alongside a real change, never on its own.
  if (dirty && isMcp && authChoiceOf(draft.authType) === "oauth" && !isHttpUrl(tool.oauth_callback_url ?? "")) {
    settings.oauth_callback_url = toolOAuthRedirectUrl(tool.id);
  }
  if (Object.keys(settings).length > 0) payload.settings = settings;
  return {
    payload,
    dirty: dirty || Boolean(invocationError),
    ...(invocationError ? { error: `Automatic tool calls: ${invocationError}`, invocationError } : {}),
  };
}

/** Problems that stop a connection from working at all (not merely off). */
export function connectionIssues(tool: ToolConfig): string[] {
  if (!isMcpRuntimeTool(tool)) return [];
  const issues: string[] = [];
  const transport = normalizedTransport(effectiveTransport(tool));
  if (transport === "stdio") {
    if (!tool.command?.trim()) issues.push("No command to run");
  } else if (transport === "http" || transport === "sse") {
    const url = (tool.endpoint ?? "").trim();
    if (!url) issues.push("No server URL");
    else if (!isHttpUrl(url)) issues.push("Server URL must start with https://");
  } else {
    issues.push(`Unknown connection type "${transport}"`);
  }
  const auth = authChoiceOf(tool.auth_type ?? "none");
  if (auth === "bearer" && !tool.secret_set) issues.push("No access token saved");
  if (auth === "oauth" && !tool.oauth_token_stored) issues.push("Not signed in to the provider");
  return issues;
}

function effectiveTransport(tool: ToolConfig): string {
  const saved = (tool.transport ?? "").trim().toLowerCase();
  if (saved) return saved;
  // The MCP runtime treats a missing transport as a local (stdio) command.
  return "stdio";
}

function normalizedTransport(value: string): string {
  const lowered = value.trim().toLowerCase();
  if (HTTP_TRANSPORTS.has(lowered)) return "http";
  if (SSE_TRANSPORTS.has(lowered)) return "sse";
  return lowered || "stdio";
}

function transportHint(transport: string): string {
  if (transport === "stdio") return "Aperture starts a program on its own server and talks to it directly.";
  if (transport === "sse") return "For older MCP servers that stream over Server-Sent Events.";
  return "Streamable HTTP, the standard for hosted MCP servers.";
}

export function connectionTypeLabel(tool: ToolConfig): string {
  if (tool.type === "custom_script") return "Response action";
  if (isMcpRuntimeTool(tool)) {
    const transport = normalizedTransport(effectiveTransport(tool));
    if (transport === "stdio") return "MCP server (local command)";
    if (transport === "sse") return "MCP server (SSE)";
    if (transport === "http") return "MCP server (HTTP)";
    return `MCP server (${transport})`;
  }
  switch (tool.type) {
    case "prompt-library":
      return "Prompt library";
    case "skill-library":
      return "Skill library";
    case "workflow":
      return "Workflow";
    case "function":
      return "Built-in function";
    default:
      return "Built-in connector";
  }
}

function connectionLocation(tool: ToolConfig): string {
  if (isMcpRuntimeTool(tool) && normalizedTransport(effectiveTransport(tool)) === "stdio") {
    return tool.command?.trim() ?? "";
  }
  const endpoint = (tool.endpoint ?? "").trim();
  if (!isHttpUrl(endpoint)) return "";
  try {
    return new URL(endpoint).host;
  } catch {
    return "";
  }
}

export function accessSummary(tool: ToolConfig, data: BootstrapData): string {
  const groupIds = tool.allowed_group_ids ?? [];
  if (groupIds.length) {
    const names = groupIds.map((id) => data.groups.find((group) => group.id === id)?.name ?? "Unknown group");
    return names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${names.length - 2} more`;
  }
  if (tool.owner_user_id) {
    if (tool.owner_user_id === data.me.id) return "Only you";
    const owner = [...(data.visibleUsers ?? []), ...(data.users ?? [])].find((user) => user.id === tool.owner_user_id);
    return owner ? `Only ${owner.display_name}` : "Only its creator";
  }
  return "Everyone in the workspace";
}

function approvalSummary(tool: ToolConfig): string | null {
  if (isMcpRuntimeTool(tool)) return tool.approval_required ? "Asks before each use" : "Runs without asking";
  return tool.approval_required ? "Agent mode only" : null;
}

/** Positive sign-in state for the card; a missing token or sign-in is
 * already listed as a setup issue, so it isn't repeated here. */
function signInSummary(tool: ToolConfig): string | null {
  if (!isMcpRuntimeTool(tool)) return null;
  const auth = authChoiceOf(tool.auth_type ?? "none");
  if (auth === "bearer" && tool.secret_set) return "Access token saved";
  if (auth === "oauth" && tool.oauth_token_stored) return "Signed in";
  return null;
}

function authChoiceOf(authType: string): AuthChoice {
  const lowered = authType.trim().toLowerCase();
  if (lowered.includes("oauth")) return "oauth";
  if (lowered === "bearer-token" || lowered === "bearer") return "bearer";
  return "none";
}

/** Settings store no description for many tools; the display mapper then
 * invents "<Type> tool configuration." — never show that as if authored. */
function visibleDescription(tool: ToolConfig): string {
  const description = (tool.description ?? "").trim();
  return /^[A-Z][\w ]* tool configuration\.$/.test(description) ? "" : description;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

function parseArgs(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseScopes(value: string): string[] {
  return Array.from(new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean)));
}

function sameList(first: string[], second: string[]): boolean {
  return first.length === second.length && first.every((item, index) => item === second[index]);
}

function sameSet(first: string[], second: string[]): boolean {
  const a = new Set(first);
  const b = new Set(second);
  return a.size === b.size && [...a].every((item) => b.has(item));
}

function normalizeInvocations(invocations: McpRuntimeInvocation[]): McpRuntimeInvocation[] {
  return invocations.map((invocation) => ({
    tool_name: invocation.tool_name.trim(),
    label: invocation.label?.trim() ? invocation.label.trim() : null,
    arguments: invocation.arguments ?? {},
  }));
}

function parseRuntimeInvocationsJson(value: string): McpRuntimeInvocation[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("this isn't valid JSON.");
  }
  if (!Array.isArray(parsed)) throw new Error("use a JSON list, like [ {...} ].");
  return parsed.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`item ${index + 1} must be an object.`);
    }
    const record = item as Record<string, unknown>;
    const toolName = typeof record.tool_name === "string" ? record.tool_name.trim() : "";
    if (!toolName) throw new Error(`item ${index + 1} needs a "tool_name".`);
    const rawArguments = record.arguments;
    if (rawArguments !== undefined && (typeof rawArguments !== "object" || rawArguments === null || Array.isArray(rawArguments))) {
      throw new Error(`item ${index + 1} "arguments" must be an object.`);
    }
    return {
      tool_name: toolName,
      label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : null,
      arguments: (rawArguments as Record<string, unknown> | undefined) ?? {},
    };
  });
}

function substituteArguments(value: Record<string, unknown>, substitutions: Record<string, string>): Record<string, unknown> {
  const substitute = (item: unknown): unknown => {
    if (typeof item === "string") {
      return Object.entries(substitutions).reduce((result, [key, replacement]) => result.replaceAll(`{{${key}}}`, replacement), item);
    }
    if (Array.isArray(item)) return item.map(substitute);
    if (typeof item === "object" && item !== null) {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, entry]) => [key, substitute(entry)]));
    }
    return item;
  };
  return substitute(value) as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error.";
}
