import { SelectControl } from "./SelectControl";
import * as Tabs from "@radix-ui/react-tabs";
import {
  Bot,
  BookOpen,
  Check,
  FileText,
  KeyRound,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  ServerCog,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  createAdminAgentProfile,
  deleteAdminAgentProfile,
  deleteHermesMemory,
  listHermesMemories,
  mapModelConfigRecordToDisplay,
  syncAdminModelAccess,
  updateAdminAgentProfile,
  type HermesMemory,
} from "../lib/api";
import {
  agentProfileCreatorMatches,
  isAgentProfile,
  usableModels,
  visibleAgentProfiles,
} from "../lib/modelAccess";
import type {
  BootstrapData,
  ModelConfig,
  ProviderKey,
} from "../lib/types";
import { Panel, Pill, StableLabel, Toggle } from "./Primitives";
import { PromptEditorField } from "./PromptEditorField";

const AGENT_TAB_TOOLTIPS: Record<string, string> = {
  basics: "Set this agent's name, base model, visibility, and prompts",
  knowledge: "Choose which knowledge bases this agent can search for answers",
  tools: "Pick the MCP servers and tools this agent is allowed to use",
  prompts: "Attach template prompts and skill files to shape this agent's work",
  access: "Control which groups can use this agent and lock deletion",
  hermes: "Turn the Hermes agent companion on or off for this profile",
};

type AgentDraft = {
  id: string | null;
  name: string;
  base_model_id: string;
  visibility: ModelConfig["visibility"];
  group_ids: string[];
  knowledge_config_ids: string[];
  tool_config_ids: string[];
  system_prompt: string;
  meta_prompt: string;
  agentic_companion: string | null;
  prompt_template_ids: string[];
  skill_file_ids: string[];
  admin_delete_locked: boolean;
};

export function AgentWorkspaceConsole({
  data,
  onDataChange,
  onUseInChat,
  sectionTabs,
}: {
  data: BootstrapData;
  onDataChange: (updater: (current: BootstrapData) => BootstrapData) => void;
  onUseInChat: (modelId: string) => void;
  sectionTabs?: ReactNode;
}) {
  const agentProfiles = useMemo(
    () => visibleAgentProfiles(data),
    [data],
  );
  const baseModels = useMemo(() => availableAgentBaseModels(data), [data]);
  const syncableProviders = useMemo(
    () =>
      data.providers.filter(
        (provider) =>
          provider.connected ||
          providerHasActiveKey(data.providerKeys, provider.id),
      ),
    [data.providerKeys, data.providers],
  );
  const hermesTool = data.tools.find(
    (tool) => tool.hermes_companion || tool.id.includes("hermes-agent"),
  );
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    agentProfiles[0]?.id ?? null,
  );
  const selectedAgent =
    agentProfiles.find((agent) => agent.id === selectedAgentId) ?? null;
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [draft, setDraft] = useState<AgentDraft>(() =>
    draftFromAgent(
      selectedAgent ?? agentProfiles[0] ?? null,
      baseModels[0],
      data,
      hermesTool?.id,
    ),
  );
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  // Memories the Hermes companion has saved for the profile being edited.
  // null = not loaded (unsaved profile or fetch pending/failed).
  const [hermesMemories, setHermesMemories] = useState<HermesMemory[] | null>(null);
  const [hermesMemoryLoad, setHermesMemoryLoad] = useState<"loading" | "ready" | "error">("loading");
  const [hermesMemoryReload, setHermesMemoryReload] = useState(0);
  // Mirror of the API's hermes_companion_allowed policy: the companion is an
  // admin-granted, off-by-default group permission. The API enforces the same
  // gate on save and at chat runtime.
  const hermesAllowed =
    data.me.role === "PLATFORM_OWNER"
      ? data.groups.some((group) => Boolean(group.permissions.hermes_companion))
      : data.me.group_ids.some((groupId) =>
          Boolean(data.groups.find((group) => group.id === groupId)?.permissions.hermes_companion),
        );
  // Mirror of the API's agent_authoring_allowed policy: admins always author,
  // and a standard user needs the organization ceiling plus an explicit group
  // grant. The API enforces the same gate on create, update, and delete.
  const isAgentAdmin = data.me.role === "PLATFORM_OWNER" || data.me.role === "TENANT_ADMIN";
  const canAuthorAgents =
    isAgentAdmin ||
    (Boolean(data.platformSettings?.users_can_create_models) &&
      data.me.group_ids.some((groupId) =>
        Boolean(data.groups.find((group) => group.id === groupId)?.permissions.agent_authoring),
      ));
  // Granted non-admins save private, self-owned profiles; say so instead of
  // implying the agent becomes available workspace-wide.
  const isAgentAuthorRestricted = canAuthorAgents && !isAgentAdmin;
  // Granted users author only the profiles they created; admins edit any
  // profile inside their scope.
  const canAuthorProfile = (agent: ModelConfig | null) =>
    canAuthorAgents && (isAgentAdmin || agentProfileCreatorMatches(data, agent));
  const canEditSelectedAgent = !draft.id ? canAuthorAgents : canAuthorProfile(selectedAgent);
  const selectedBaseModelAvailable = baseModels.some((model) => model.id === draft.base_model_id);
  // Say which of the two gates is closed rather than silently hiding the
  // authoring controls, so the missing button is never a mystery.
  const authoringBlockedReason = canAuthorAgents
    ? null
    : data.platformSettings?.users_can_create_models
      ? "Your groups do not include the Can build agents permission yet. An admin can grant it under Admin → Users & groups."
      : "Building your own agents is unavailable under the current service policy. When available, an admin can grant Can build agents to a group.";

  useEffect(() => {
    let cancelled = false;
    if (!draft.id || draft.agentic_companion !== "hermes") {
      setHermesMemories(null);
      return;
    }
    setHermesMemories(null);
    setHermesMemoryLoad("loading");
    listHermesMemories(data.me.id, draft.id)
      .then((memories) => {
        if (!cancelled) {
          setHermesMemories(memories);
          setHermesMemoryLoad("ready");
        }
      })
      .catch(() => {
        if (!cancelled) setHermesMemoryLoad("error");
      });
    return () => {
      cancelled = true;
    };
  }, [data.me.id, draft.id, draft.agentic_companion, hermesMemoryReload]);

  async function removeHermesMemory(memoryId: string) {
    if (!draft.id) return;
    try {
      await deleteHermesMemory(data.me.id, draft.id, memoryId);
      setHermesMemories((current) =>
        current ? current.filter((memory) => memory.id !== memoryId) : current,
      );
    } catch {
      setActionStatus({
        tone: "warning",
        message: "Could not delete that Hermes memory. Try again.",
      });
    }
  }
  const [actionStatus, setActionStatus] = useState<{
    tone: "success" | "warning";
    message: string;
  } | null>(null);

  function selectAgent(model: ModelConfig | null) {
    setSelectedAgentId(model?.id ?? null);
    setDraft(draftFromAgent(model, defaultAgentBaseModel(baseModels), data, hermesTool?.id));
    setActionStatus(null);
    setIsEditorOpen(false);
  }

  function openAgentEditor(model: ModelConfig | null) {
    setSelectedAgentId(model?.id ?? null);
    setDraft(draftFromAgent(model, defaultAgentBaseModel(baseModels), data, hermesTool?.id));
    setActionStatus(null);
    setIsEditorOpen(true);
  }

  function createNewDraft() {
    setSelectedAgentId(null);
    setDraft({
      ...draftFromAgent(null, defaultAgentBaseModel(baseModels), data, hermesTool?.id),
      name: "New Workspace Agent",
    });
    setActionStatus(null);
    setIsEditorOpen(true);
  }

  function updateDraft(patch: Partial<AgentDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function syncAgentModelCatalog() {
    if (!syncableProviders.length) {
      setActionStatus({
        tone: "warning",
        message: "No connected model providers are available to sync.",
      });
      return;
    }
    setPendingAction("agent:models-sync");
    try {
      const models = await syncAdminModelAccess(data.me.id);
      const syncedData = mergeAdminModelCatalogForAgents(data, models);
      const syncedBaseModels = availableAgentBaseModels(syncedData);
      onDataChange((current) => mergeAdminModelCatalogForAgents(current, models));
      setDraft((current) => {
        // Catalog refresh must never silently reroute an existing agent.
        if (current.id || current.base_model_id) {
          return current;
        }
        return { ...current, base_model_id: defaultAgentBaseModel(syncedBaseModels)?.id ?? "" };
      });
      setIsEditorOpen(true);
      setActionStatus({
        tone: "success",
        message: "Agent model catalog synced.",
      });
    } catch (error) {
      setActionStatus({
        tone: "warning",
        message: `Agent model catalog sync failed: ${agentActionErrorMessage(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function saveAgentProfile() {
    const baseModel = baseModels.find((model) => model.id === draft.base_model_id);
    const name = draft.name.trim();
    if (!baseModel || !name) {
      setActionStatus({
        tone: "warning",
        message:
          "Select a base AI model and enter an agent name before saving.",
      });
      return;
    }
    const toolConfigIds =
      draft.agentic_companion === "hermes" && hermesTool?.id
        ? unique([...draft.tool_config_ids, hermesTool.id])
        : draft.tool_config_ids.filter((id) => id !== hermesTool?.id);
    const payload = {
      provider_id: baseModel.provider_id,
      name,
      upstream_model_id: baseModel.upstream_model_id ?? baseModel.name,
      system_prompt: draft.system_prompt,
      meta_prompt: draft.meta_prompt,
      knowledge_config_ids: draft.knowledge_config_ids,
      tool_config_ids: toolConfigIds,
      tenant_restricted: draft.visibility !== "organization",
      group_ids: draft.group_ids,
      is_custom: true,
      context_window: baseModel.context_window ?? 128000,
      visibility: draft.visibility,
      agentic_companion: draft.agentic_companion,
      prompt_template_ids: draft.prompt_template_ids,
      skill_file_ids: draft.skill_file_ids,
      admin_delete_locked: draft.admin_delete_locked,
    } satisfies Partial<ModelConfig>;

    setPendingAction("agent:save");
    try {
      const saved = draft.id
        ? await updateAdminAgentProfile(data.me.id, draft.id, payload)
        : await createAdminAgentProfile(data.me.id, {
            id: `agent-${Date.now()}`,
            provider_id: payload.provider_id!,
            name: payload.name!,
            upstream_model_id: payload.upstream_model_id,
            system_prompt: payload.system_prompt,
            meta_prompt: payload.meta_prompt,
            knowledge_config_ids: payload.knowledge_config_ids,
            tool_config_ids: payload.tool_config_ids,
            platform_enabled: true,
            tenant_restricted: payload.tenant_restricted,
            group_ids: payload.group_ids,
            notes: `${draft.agentic_companion === "hermes" ? "Hermes companion enabled. " : ""}Agent profile.`,
            is_custom: true,
            created_by: data.me.display_name,
            context_window: payload.context_window,
            visibility: payload.visibility,
            agentic_companion: payload.agentic_companion,
            prompt_template_ids: payload.prompt_template_ids,
            skill_file_ids: payload.skill_file_ids,
            admin_delete_locked: payload.admin_delete_locked,
          });
      const model = mapModelConfigRecordToDisplay(saved);
      onDataChange((current) => ({
        ...current,
        models: current.models.some((item) => item.id === model.id)
          ? current.models.map((item) => (item.id === model.id ? model : item))
          : [...current.models, model],
      }));
      setSelectedAgentId(model.id);
      setDraft(draftFromAgent(model, baseModel, data, hermesTool?.id));
      setIsEditorOpen(true);
      setActionStatus({
        tone: "success",
        message: `${model.name} saved through the agent profile API.`,
      });
    } catch (error) {
      setActionStatus({
        tone: "warning",
        message: `Agent profile was not saved: ${agentActionErrorMessage(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function deleteAgentProfile(targetAgent?: ModelConfig) {
    const agentId = targetAgent?.id ?? draft.id;
    if (!agentId) return;
    const name = (targetAgent?.name ?? draft.name).trim() || "this agent";
    if (!window.confirm(`Delete ${name}?`)) return;
    setPendingAction(`agent:delete:${agentId}`);
    try {
      await deleteAdminAgentProfile(data.me.id, agentId);
      const nextAgent =
        agentProfiles.find((agent) => agent.id !== agentId) ?? null;
      onDataChange((current) => ({
        ...current,
        models: current.models.filter((item) => item.id !== agentId),
      }));
      setSelectedAgentId((current) =>
        current === agentId ? (nextAgent?.id ?? null) : current,
      );
      if (draft.id === agentId) {
        setDraft(
          draftFromAgent(nextAgent, baseModels[0], data, hermesTool?.id),
        );
        setIsEditorOpen(false);
      }
      setActionStatus({ tone: "success", message: `${name} was deleted.` });
    } catch (error) {
      setActionStatus({
        tone: "warning",
        message: `Agent profile was not deleted: ${agentActionErrorMessage(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function clearAgentProfiles() {
    if (!agentProfiles.length) {
      setActionStatus({
        tone: "warning",
        message: "No agent profiles are configured yet.",
      });
      return;
    }
    const confirmed = window.confirm(
      `Delete all ${agentProfiles.length} agent profile${agentProfiles.length === 1 ? "" : "s"}? This clears the workspace agent list so you can create new profiles.`,
    );
    if (!confirmed) return;
    setPendingAction("agent:clear");
    const deletedIds: string[] = [];
    const failures: string[] = [];
    for (const agent of agentProfiles) {
      try {
        await deleteAdminAgentProfile(data.me.id, agent.id);
        deletedIds.push(agent.id);
      } catch (error) {
        failures.push(
          `${agent.name}: ${agentActionErrorMessage(error)}`,
        );
      }
    }
    if (deletedIds.length) {
      const deletedIdSet = new Set(deletedIds);
      const nextAgent =
        agentProfiles.find((agent) => !deletedIdSet.has(agent.id)) ?? null;
      onDataChange((current) => ({
        ...current,
        models: current.models.filter((item) => !deletedIdSet.has(item.id)),
      }));
      setSelectedAgentId((current) =>
        current && deletedIdSet.has(current) ? (nextAgent?.id ?? null) : current,
      );
      if (draft.id && deletedIdSet.has(draft.id)) {
        setDraft(
          draftFromAgent(nextAgent, baseModels[0], data, hermesTool?.id),
        );
        setIsEditorOpen(false);
      }
    }
    if (failures.length) {
      setActionStatus({
        tone: "warning",
        message: `Deleted ${deletedIds.length} agent profile${deletedIds.length === 1 ? "" : "s"}. Failed: ${failures.join("; ")}`,
      });
    } else {
      setActionStatus({
        tone: "success",
        message: `Cleared ${deletedIds.length} agent profile${deletedIds.length === 1 ? "" : "s"}.`,
      });
    }
    setPendingAction(null);
  }

  return (
    <div className="console-page agent-workspace-page">
      <header className="console-header">
        <div>
          <h1>Agents</h1>
          <p>
            Build focused assistants with their own instructions, knowledge,
            and tools. Choose who can use them in your workspace.
          </p>
        </div>
        {sectionTabs}
        <div className="console-actions">
          {isAgentAdmin && (
            <button
              className="danger-button"
              type="button"
              data-tooltip="Delete every agent profile in this workspace so you can start fresh"
              onClick={() => void clearAgentProfiles()}
              disabled={!agentProfiles.length || pendingAction === "agent:clear"}
            >
              <Trash2 size={16} />{" "}
              {pendingAction === "agent:clear" ? "Clearing..." : "Clear Agents"}
            </button>
          )}
          {canAuthorAgents && (
            <button
              className="secondary-button"
              type="button"
              data-tooltip={
                isAgentAuthorRestricted
                  ? "Create a private agent profile with its own model, tools, and prompts"
                  : "Create a new agent profile with its own model, tools, and prompts"
              }
              onClick={createNewDraft}
            >
              <Plus size={16} /> New Agent
            </button>
          )}
        </div>
      </header>

      {actionStatus && (
        <div
          className="inline-warning action-status-toast agent-action-status-toast"
          role="status"
        >
          <Pill tone={actionStatus.tone}>
            {actionStatus.tone === "success" ? "Saved" : "Action"}
          </Pill>
          <span className="action-status-message">{actionStatus.message}</span>
          <button
            className="icon-button action-status-close"
            type="button"
            aria-label="Dismiss notification"
            data-tooltip="Clear this status message from the screen"
            onClick={() => setActionStatus(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {authoringBlockedReason && (
        <div className="policy-callout">
          <Lock size={15} />
          <span>
            <strong>Building agents is not available to you.</strong>{" "}
            {authoringBlockedReason}
          </span>
        </div>
      )}

      <Panel
        className="agent-profiles-panel"
        title="Agent Profiles"
        subtitle={`${agentProfiles.length} configured profile${agentProfiles.length === 1 ? "" : "s"}`}
      >
        <div className="agent-profile-list">
          {agentProfiles.map((agent) => {
            const summary = knowledgeSummary(modelKnowledgeIds(agent), data);
            const deleteLocked = agentDeleteLockedForAdmin(agent, data);
            const isDeleting =
              pendingAction === `agent:delete:${agent.id}` ||
              pendingAction === "agent:clear";
            return (
              <div
                className={`agent-profile-card ${agent.id === selectedAgentId ? "is-active" : ""}`}
                key={agent.id}
              >
                <button
                  className="agent-profile-main"
                  type="button"
                  data-tooltip={`Select ${agent.name} and review its models, knowledge, and tools`}
                  onClick={() => selectAgent(agent)}
                >
                  <span className="agent-profile-icon">
                    <Bot size={18} />
                  </span>
                  <span>
                    <strong>{agent.name}</strong>
                    <small>
                      {agent.provider_name} · {summary.baseCount} knowledge ·{" "}
                      {summary.documentCount} files ·{" "}
                      {modelToolIds(agent).length} tools
                      {agent.agentic_companion === "hermes" ? " · Hermes" : ""}
                    </small>
                  </span>
                  {agent.id === selectedAgentId && <Check size={16} />}
                </button>
                <div className="agent-profile-actions">
                  {canAuthorProfile(agent) && (
                    <button
                      className="secondary-button compact-button"
                      type="button"
                      data-tooltip={`Open ${agent.name} in the editor to change its settings`}
                      onClick={() => openAgentEditor(agent)}
                      disabled={isDeleting}
                    >
                      <Pencil size={15} /> Edit
                    </button>
                  )}
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    data-tooltip={`Jump into a chat with ${agent.name} answering your messages`}
                    onClick={() => onUseInChat(agent.id)}
                    disabled={isDeleting}
                  >
                    <Sparkles size={15} /> Chat
                  </button>
                  {canAuthorProfile(agent) && (
                    <button
                      className="danger-button compact-button"
                      type="button"
                      onClick={() => void deleteAgentProfile(agent)}
                      disabled={isDeleting || deleteLocked}
                      data-tooltip={
                        deleteLocked
                          ? `${agent.name} is protected by organization policy and cannot be deleted`
                          : `Permanently remove ${agent.name} from this workspace`
                      }
                    >
                      <Trash2 size={15} />{" "}
                      {pendingAction === `agent:delete:${agent.id}`
                        ? "Deleting..."
                        : deleteLocked
                          ? "Locked"
                          : "Delete"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {agentProfiles.length === 0 && (
            <div className="empty-state compact">
              No agent profiles are configured yet.
            </div>
          )}
        </div>
      </Panel>

      {isEditorOpen && (
        <Panel className="agent-editor-panel" collapsible={false}>
          <div className="agent-editor-shell">
            <div className="agent-editor-toolbar">
              <div className="agent-editor-actions">
                {draft.id && (
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    data-tooltip="Jump into a chat with this agent answering your messages"
                    onClick={() => onUseInChat(draft.id!)}
                  >
                    <Sparkles size={15} /> Use in Chat
                  </button>
                )}
                {draft.id && canEditSelectedAgent && (
                  <button
                    className="danger-button compact-button"
                    type="button"
                    onClick={() => void deleteAgentProfile()}
                    disabled={
                      pendingAction === `agent:delete:${draft.id}` ||
                      agentDeleteLockedForAdmin(selectedAgent, data)
                    }
                    data-tooltip={
                      agentDeleteLockedForAdmin(selectedAgent, data)
                        ? "This agent is protected by organization policy and cannot be deleted"
                        : "Permanently remove this agent profile from the workspace"
                    }
                  >
                    <Trash2 size={15} />{" "}
                    <StableLabel
                      label={
                        pendingAction === `agent:delete:${draft.id}`
                          ? "Deleting..."
                          : agentDeleteLockedForAdmin(selectedAgent, data)
                            ? "Locked"
                            : "Delete Agent"
                      }
                      reserve={["Deleting...", "Locked", "Delete Agent"]}
                    />
                  </button>
                )}
                {canEditSelectedAgent && (
                  <button
                    className="primary-button compact-button"
                    type="button"
                    data-tooltip={
                      isAgentAuthorRestricted
                        ? "Save this agent profile to your own private workspace"
                        : "Save your changes so this agent is available across the workspace"
                    }
                    onClick={() => void saveAgentProfile()}
                    disabled={pendingAction === "agent:save" || !selectedBaseModelAvailable || !draft.name.trim()}
                  >
                    <Save size={15} />{" "}
                    <StableLabel
                      label={pendingAction === "agent:save" ? "Saving..." : "Save Profile"}
                      reserve={["Saving...", "Save Profile"]}
                    />
                  </button>
                )}
                <button
                  className="icon-button"
                  type="button"
                  aria-label="Close editor"
                  data-tooltip="Close the agent editor and return to the profile list"
                  onClick={() => setIsEditorOpen(false)}
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <Tabs.Root
              defaultValue="basics"
              className="tabs-root agent-editor-tabs"
            >
              <Tabs.List
                className="tabs-list agent-tabs-list"
                aria-label="Agent profile editor sections"
              >
                {[
                  ["Profile", "basics"],
                  ["Knowledge", "knowledge"],
                  ["Tools", "tools"],
                  ["Prompts & Skills", "prompts"],
                  ["Access", "access"],
                  ["Hermes", "hermes"],
                ].map(([label, value]) => (
                  <Tabs.Trigger
                    className="tab-trigger"
                    key={value}
                    value={value}
                    data-tooltip={AGENT_TAB_TOOLTIPS[value]}
                  >
                    {label}
                  </Tabs.Trigger>
                ))}
              </Tabs.List>

            <Tabs.Content
              value="basics"
              className="tab-content agent-tab-content"
            >
              <div className="agent-builder-form">
                <label>
                  Agent name
                  <input
                    value={draft.name}
                    onChange={(event) =>
                      updateDraft({ name: event.target.value })
                    }
                  />
                </label>
                <div className="agent-model-field">
                  <label>
                    AI model
                    <SelectControl
                      aria-label="AI model"
                      value={draft.base_model_id}
                      onChange={(event) =>
                        updateDraft({ base_model_id: event.target.value })
                      }
                    >
                      {!selectedBaseModelAvailable && (
                        <option value={draft.base_model_id}>
                          {draft.id
                            ? `${selectedAgent?.upstream_model_id ?? "Saved model"} (unavailable)`
                            : baseModels.length ? "Choose an available model" : "No connected models available"}
                        </option>
                      )}
                      {baseModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name} · {model.provider_name}
                        </option>
                      ))}
                    </SelectControl>
                    {!selectedBaseModelAvailable && (
                      <span className="field-hint" role="status">
                        {draft.id
                          ? "This agent's saved model is unavailable. Restore model access or explicitly select a replacement before saving."
                          : "Connect and enable a model, then choose it here before saving."}
                      </span>
                    )}
                  </label>
                  <button
                    className="secondary-button compact agent-model-sync-button"
                    type="button"
                    data-tooltip="Refresh the list of AI models from your connected providers"
                    onClick={() => void syncAgentModelCatalog()}
                    disabled={
                      pendingAction === "agent:models-sync" ||
                      !syncableProviders.length
                    }
                  >
                    <RefreshCw size={13} />{" "}
                    {pendingAction === "agent:models-sync"
                      ? "Syncing..."
                      : "Sync models"}
                  </button>
                </div>
                <label>
                  Visibility
                  {isAgentAuthorRestricted ? (
                    <span className="field-hint">
                      Private — only you can use this agent. An admin can share
                      it more widely.
                    </span>
                  ) : (
                    <SelectControl
                      value={draft.visibility}
                      onChange={(event) =>
                        updateDraft({
                          visibility: event.target
                            .value as ModelConfig["visibility"],
                        })
                      }
                    >
                      <option value="organization">Organization</option>
                      <option value="tenant">Tenant</option>
                      <option value="group">Group</option>
                      <option value="private">Private</option>
                    </SelectControl>
                  )}
                </label>
                <PromptEditorField
                  className="wide-field"
                  label="System prompt"
                  kind="system"
                  userId={data.me.id}
                  modelId={draft.base_model_id}
                  value={draft.system_prompt}
                  onChange={(system_prompt) => updateDraft({ system_prompt })}
                />
                <PromptEditorField
                  className="wide-field"
                  label="Meta prompt"
                  kind="meta"
                  userId={data.me.id}
                  modelId={draft.base_model_id}
                  value={draft.meta_prompt}
                  onChange={(meta_prompt) => updateDraft({ meta_prompt })}
                />
              </div>
            </Tabs.Content>

            <Tabs.Content
              value="knowledge"
              className="tab-content agent-tab-content"
            >
              <SelectionGroup
                title="Knowledge bases"
                icon={<BookOpen size={16} />}
                values={draft.knowledge_config_ids}
                options={data.knowledgeBases.map((item) => ({
                  id: item.id,
                  label: item.name,
                  detail: `${item.source} · ${item.document_count} ${plural(item.document_count, "file")} · ${item.status}`,
                }))}
                onChange={(values) =>
                  updateDraft({ knowledge_config_ids: values })
                }
              />
            </Tabs.Content>

            <Tabs.Content
              value="tools"
              className="tab-content agent-tab-content"
            >
              <SelectionGroup
                title="MCP servers and tools"
                icon={<Wrench size={16} />}
                values={draft.tool_config_ids}
                options={data.tools.map((item) => ({
                  id: item.id,
                  label: item.name,
                  detail: `${item.type}${item.hermes_companion ? " · Hermes" : ""}`,
                }))}
                onChange={(values) => updateDraft({ tool_config_ids: values })}
              />
            </Tabs.Content>

            <Tabs.Content
              value="prompts"
              className="tab-content agent-tab-content"
            >
              <SelectionGroup
                title="Template prompts"
                icon={<FileText size={16} />}
                values={draft.prompt_template_ids}
                options={data.promptTemplates.map((item) => ({
                  id: item.id,
                  label: item.name,
                  detail: `${item.category} · ${item.variables.length} ${plural(item.variables.length, "variable")}`,
                }))}
                onChange={(values) =>
                  updateDraft({ prompt_template_ids: values })
                }
              />
              <SelectionGroup
                title="Skill files"
                icon={<ServerCog size={16} />}
                values={draft.skill_file_ids}
                options={data.skillFiles.map((item) => ({
                  id: item.id,
                  label: item.name,
                  detail: `${item.category} · v${item.version}`,
                }))}
                onChange={(values) => updateDraft({ skill_file_ids: values })}
              />
            </Tabs.Content>

            <Tabs.Content
              value="access"
              className="tab-content agent-tab-content"
            >
              {isAgentAuthorRestricted ? (
                <div className="empty-state compact">
                  Agents you build stay private to your account. Ask an admin to
                  share this agent with a group.
                </div>
              ) : (
                <SelectionGroup
                  title="Allowed groups"
                  icon={<KeyRound size={16} />}
                  values={draft.group_ids}
                  options={data.groups.map((item) => ({
                    id: item.id,
                    label: item.name,
                    detail: `${item.user_count} users`,
                  }))}
                  onChange={(values) => updateDraft({ group_ids: values })}
                />
              )}
              {data.me.role === "PLATFORM_OWNER" && (
                <div className="agent-companion-row">
                  <span>
                    <KeyRound size={17} />
                    <strong>Lock admin deletion</strong>
                    <small>Keep this agent available even when tenant admins clear or delete profiles.</small>
                  </span>
                  <Toggle
                    checked={draft.admin_delete_locked}
                    label="Lock admin deletion"
                    onChange={(enabled) => updateDraft({ admin_delete_locked: enabled })}
                  />
                </div>
              )}
            </Tabs.Content>

            <Tabs.Content
              value="hermes"
              className="tab-content agent-tab-content"
            >
              {!hermesAllowed && (
                <div className="agent-companion-row">
                  <span>
                    <ServerCog size={17} />
                    <strong>Hermes agent companion</strong>
                    <small>
                      Disabled for this workspace. An admin can enable the "Can use
                      Hermes companion" permission under Admin · Users &amp; groups.
                    </small>
                  </span>
                </div>
              )}
              {hermesAllowed && (
              <div className="agent-companion-row">
                <span>
                  <ServerCog size={17} />
                  <strong>Hermes agent companion</strong>
                  <small>
                    {draft.agentic_companion === "hermes"
                      ? "Active: saves memories and skills from real conversations, applies them to future runs, and proposes automations for review."
                      : "Off for this agent profile."}
                  </small>
                </span>
                <Toggle
                  checked={draft.agentic_companion === "hermes"}
                  label="Enable Hermes companion"
                  onChange={(enabled) =>
                    updateDraft({
                      agentic_companion: enabled ? "hermes" : null,
                      tool_config_ids:
                        enabled && hermesTool?.id
                          ? unique([...draft.tool_config_ids, hermesTool.id])
                          : draft.tool_config_ids.filter(
                              (id) => id !== hermesTool?.id,
                            ),
                    })
                  }
                />
              </div>
              )}
              {hermesAllowed && draft.agentic_companion === "hermes" && (
                <div className="hermes-learning-panel">
                  <strong className="hermes-learning-title">Learned memories</strong>
                  {!draft.id ? (
                    <p className="hermes-learning-empty">
                      Save the profile, then chat with it in agent mode — memories Hermes
                      saves will appear here.
                    </p>
                  ) : hermesMemoryLoad === "loading" ? (
                    <p className="hermes-learning-empty" role="status">Loading saved memories…</p>
                  ) : hermesMemoryLoad === "error" ? (
                    <div className="hermes-learning-empty">
                      <p role="alert">Saved memories could not be loaded. Try again to see what this agent has learned.</p>
                      <button className="secondary-button compact-button" type="button" onClick={() => setHermesMemoryReload((current) => current + 1)}>
                        <RefreshCw size={14} /> Retry memories
                      </button>
                    </div>
                  ) : !hermesMemories || hermesMemories.length === 0 ? (
                    <p className="hermes-learning-empty">
                      No memories saved yet. Hermes records them from real conversations;
                      nothing is pre-filled.
                    </p>
                  ) : (
                    <ul className="hermes-memory-list">
                      {hermesMemories.map((memory) => (
                        <li key={memory.id}>
                          <span>{memory.content}</span>
                          <button
                            type="button"
                            aria-label="Delete Hermes memory"
                            data-tooltip="Delete this saved memory"
                            onClick={() => void removeHermesMemory(memory.id)}
                          >
                            <X size={13} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="hermes-learning-note">
                    Skills Hermes saves appear in Library · Skills and attach to this profile
                    automatically. Proposed automations are created disabled under Agents ·
                    Automations until you review and enable them.
                  </p>
                </div>
              )}
            </Tabs.Content>
            </Tabs.Root>
          </div>
        </Panel>
      )}
    </div>
  );
}

function SelectionGroup({
  title,
  icon,
  values,
  options,
  onChange,
}: {
  title: string;
  icon: ReactNode;
  values: string[];
  options: Array<{ id: string; label: string; detail: string }>;
  onChange: (values: string[]) => void;
}) {
  return (
    <fieldset className="agent-selection-group">
      <legend>
        {icon} {title}
      </legend>
      <div className="agent-choice-grid">
        {options.map((option) => (
          <label key={option.id}>
            <input
              type="checkbox"
              checked={values.includes(option.id)}
              onChange={(event) =>
                onChange(
                  toggleSelection(values, option.id, event.target.checked),
                )
              }
            />
            <span>
              <strong>{option.label}</strong>
              <small>{option.detail}</small>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Default the editor to a mainstream flagship model instead of whatever sorts
 * first alphabetically (often an obscure catalog entry). */
function defaultAgentBaseModel(models: ModelConfig[]): ModelConfig | undefined {
  const preferred = [/gpt-5/i, /claude/i, /gpt-4o/i, /gemini/i];
  for (const pattern of preferred) {
    const match = models.find(
      (model) => pattern.test(model.name) || pattern.test(model.upstream_model_id ?? ""),
    );
    if (match) return match;
  }
  return models[0];
}

function availableAgentBaseModels(data: BootstrapData): ModelConfig[] {
  return usableModels(data)
    .filter((model) => !isAgentProfile(model))
    .sort((a, b) => {
      const providerCompare = (a.provider_name ?? "").localeCompare(
        b.provider_name ?? "",
      );
      return providerCompare || a.name.localeCompare(b.name);
    });
}

function mergeAdminModelCatalogForAgents(
  current: BootstrapData,
  models: ModelConfig[],
): BootstrapData {
  const nextById = new Map(current.models.map((model) => [model.id, model]));
  for (const model of models.map(mapModelConfigRecordToDisplay)) {
    nextById.set(model.id, model);
  }
  return { ...current, models: Array.from(nextById.values()) };
}

function providerHasActiveKey(
  keys: ProviderKey[],
  providerId: string,
): boolean {
  return keys.some(
    (key) =>
      key.provider_id === providerId &&
      key.status.toLowerCase() === "active" &&
      !providerKeyExpired(key.expires),
  );
}

function providerKeyExpired(expires: string): boolean {
  const normalized = expires.trim().toLowerCase();
  if (!normalized || normalized === "not set" || normalized === "never")
    return false;
  const parsed = Date.parse(expires);
  if (Number.isNaN(parsed)) return false;
  const expiresAt = new Date(parsed);
  expiresAt.setHours(23, 59, 59, 999);
  return expiresAt.getTime() < Date.now();
}

function agentDeleteLockedForAdmin(
  agent: ModelConfig | null,
  data: BootstrapData,
): boolean {
  return data.me.role !== "PLATFORM_OWNER" && Boolean(agent?.admin_delete_locked);
}

function agentActionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown error";
  if (/only platform owners/i.test(message)) {
    return "This action is not available for this agent profile.";
  }
  return message;
}

function draftFromAgent(
  agent: ModelConfig | null,
  fallbackBaseModel: ModelConfig | undefined,
  data: BootstrapData,
  hermesToolId: string | undefined,
): AgentDraft {
  const baseModel =
    agent
      ? data.models.find(
          (model) =>
            !isAgentProfile(model) &&
            model.provider_id === agent.provider_id &&
            (model.upstream_model_id ?? model.name) ===
              (agent.upstream_model_id ?? agent.name),
        )
      : fallbackBaseModel;
  const toolIds = agent
    ? modelToolIds(agent)
    : hermesToolId
      ? [hermesToolId]
      : [];
  return {
    id: agent?.id ?? null,
    name: agent?.name ?? "New Workspace Agent",
    base_model_id: baseModel?.id ?? "",
    visibility: agent?.visibility ?? "tenant",
    group_ids:
      agent?.group_ids ?? (data.groups[0]?.id ? [data.groups[0].id] : []),
    knowledge_config_ids: agent
      ? modelKnowledgeIds(agent)
      : data.knowledgeBases
          .filter((kb) => kb.enabled)
          .slice(0, 2)
          .map((kb) => kb.id),
    tool_config_ids: toolIds,
    system_prompt:
      agent?.system_prompt ??
      "You are a source-grounded workspace agent. Use connected knowledge and tools only when they are configured for this tenant.",
    meta_prompt:
      agent?.meta_prompt ??
      "Keep internal reasoning separate, cite retrieved sources, and require approval before external communications.",
    agentic_companion: agent?.agentic_companion === "hermes" ? "hermes" : null,
    prompt_template_ids:
      agent?.prompt_template_ids ??
      data.promptTemplates
        .filter((template) => template.enabled)
        .slice(0, 2)
        .map((template) => template.id),
    skill_file_ids:
      agent?.skill_file_ids ??
      data.skillFiles
        .filter((skill) => skill.enabled)
        .slice(0, 2)
        .map((skill) => skill.id),
    admin_delete_locked: Boolean(agent?.admin_delete_locked),
  };
}

function modelKnowledgeIds(model: ModelConfig): string[] {
  return model.knowledge_config_ids ?? model.knowledge_base_ids ?? [];
}

function modelToolIds(model: ModelConfig): string[] {
  return model.tool_config_ids ?? model.tool_ids ?? [];
}

function knowledgeSummary(
  ids: string[],
  data: BootstrapData,
): { baseCount: number; documentCount: number } {
  const selected = ids
    .map((id) => data.knowledgeBases.find((item) => item.id === id))
    .filter((item): item is BootstrapData["knowledgeBases"][number] =>
      Boolean(item),
    );
  return {
    baseCount: selected.length,
    documentCount: selected.reduce(
      (total, item) => total + item.document_count,
      0,
    ),
  };
}

function toggleSelection(
  values: string[],
  value: string,
  selected: boolean,
): string[] {
  return selected
    ? unique([...values, value])
    : values.filter((item) => item !== value);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
