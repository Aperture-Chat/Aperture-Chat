import { SelectControl } from "./SelectControl";
import * as Tabs from "@radix-ui/react-tabs";
import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  BookOpen,
  Bot,
  CheckCircle2,
  ClipboardList,
  Copy,
  FileText,
  KeyRound,
  Lock,
  Mail,
  MessageSquare,
  MoreHorizontal,
  PenLine,
  Plus,
  RefreshCw,
  Search,
  ServerCog,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  agentAttachments,
  agentAudience,
  agentAudienceLabel,
  agentInitials,
  agentIssues,
  agentSummary,
  type AgentIssue,
} from "../lib/agentReadiness";
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
import { StableLabel, Toggle } from "./Primitives";
import { PromptEditorField } from "./PromptEditorField";

const AGENT_TAB_TOOLTIPS: Record<string, string> = {
  basics: "Set this agent's name, base model, and instructions",
  knowledge: "Choose which knowledge bases this agent can search for answers",
  tools: "Pick the MCP servers and tools this agent is allowed to use",
  prompts: "Attach template prompts and skill files to shape this agent's work",
  access: "Choose who can use this agent",
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

type AgentFilter = "all" | "mine" | "attention";

type AgentStarter = {
  key: string;
  name: string;
  summary: string;
  icon: LucideIcon;
  systemPrompt: string;
  metaPrompt: string;
};

/** Starting points for a new agent. They only pre-fill the name and
 * instructions in the editor; nothing is saved until the author saves. */
export const AGENT_STARTERS: AgentStarter[] = [
  {
    key: "research",
    name: "Research Analyst",
    summary: "Investigates a question and returns a sourced, balanced brief.",
    icon: Search,
    systemPrompt:
      "You are a research analyst. Investigate the question thoroughly, weigh competing evidence, and deliver a concise brief: a one-paragraph answer first, then key findings, open questions, and sources. Prefer primary sources and say plainly when evidence is thin or conflicting.",
    metaPrompt: "Cite a source for every factual claim. Separate facts from interpretation.",
  },
  {
    key: "meetings",
    name: "Meeting Summarizer",
    summary: "Turns notes or transcripts into decisions, owners, and deadlines.",
    icon: ClipboardList,
    systemPrompt:
      "You turn meeting notes and transcripts into a crisp summary. Return: a three-sentence overview, decisions made, action items as a table (owner, task, due date), and open questions. Never invent owners or dates; mark anything unclear as “unassigned” or “no date given”.",
    metaPrompt: "Keep the summary scannable. Use the attendees' own wording for decisions.",
  },
  {
    key: "policy",
    name: "Policy Q&A",
    summary: "Answers questions strictly from the policies you attach as knowledge.",
    icon: ShieldCheck,
    systemPrompt:
      "You answer questions about company policy using only the attached knowledge bases. Quote the relevant passage and name the document it came from. If the policies do not cover the question, say so and suggest who to ask instead of guessing.",
    metaPrompt: "Never speculate beyond the retrieved policy text. Flag outdated or conflicting policies.",
  },
  {
    key: "editor",
    name: "Writing Editor",
    summary: "Tightens drafts for clarity, tone, and structure without changing meaning.",
    icon: PenLine,
    systemPrompt:
      "You are a senior editor. Improve the text for clarity, concision, structure, and tone while preserving the author's meaning and voice. Return the revised text first, then a short list of the most important changes and why.",
    metaPrompt: "Prefer plain language and active voice. Do not add new claims.",
  },
  {
    key: "email",
    name: "Email Drafter",
    summary: "Drafts clear, professional replies that are ready to send.",
    icon: Mail,
    systemPrompt:
      "You draft professional emails. Match the requested tone, lead with the purpose, keep paragraphs short, and end with a clear next step. Offer a subject line. Ask for missing facts (names, dates, amounts) instead of inventing them.",
    metaPrompt: "Keep drafts under 200 words unless asked otherwise.",
  },
  {
    key: "data",
    name: "Data Explainer",
    summary: "Explains tables, metrics, and trends in plain language.",
    icon: BarChart3,
    systemPrompt:
      "You explain data to non-specialists. Describe what the numbers show, the most important trends and outliers, and what they might mean for the business, with the caveats a careful analyst would mention. Show calculations when you derive a figure.",
    metaPrompt: "State units and time periods explicitly. Never extrapolate without saying so.",
  },
];

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
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const selectedAgent =
    agentProfiles.find((agent) => agent.id === selectedAgentId) ?? null;
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [draft, setDraft] = useState<AgentDraft>(() =>
    draftFromAgent(null, defaultAgentBaseModel(baseModels), data),
  );
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AgentFilter>("all");
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  // Memories the Hermes companion has saved for the profile being edited.
  // null = not loaded (unsaved profile or fetch pending/failed).
  const [hermesMemories, setHermesMemories] = useState<HermesMemory[] | null>(null);
  const [hermesMemoryLoad, setHermesMemoryLoad] = useState<"loading" | "ready" | "error">("loading");
  const [hermesMemoryReload, setHermesMemoryReload] = useState(0);
  const [actionStatus, setActionStatus] = useState<{
    tone: "success" | "warning";
    message: string;
  } | null>(null);
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

  const issuesById = useMemo(() => {
    const map = new Map<string, AgentIssue[]>();
    for (const agent of agentProfiles) map.set(agent.id, agentIssues(agentAttachments(agent), data));
    return map;
  }, [agentProfiles, data]);
  const mineCount = agentProfiles.filter((agent) => agentProfileCreatorMatches(data, agent)).length;
  const attentionCount = agentProfiles.filter((agent) => (issuesById.get(agent.id) ?? []).length > 0).length;
  const normalizedQuery = query.trim().toLowerCase();
  const filteredAgents = agentProfiles
    .filter((agent) => {
      if (filter === "mine" && !agentProfileCreatorMatches(data, agent)) return false;
      if (filter === "attention" && !(issuesById.get(agent.id) ?? []).length) return false;
      if (!normalizedQuery) return true;
      return [agent.name, agent.system_prompt ?? "", agent.upstream_model_id ?? "", agent.provider_name ?? ""]
        .some((value) => value.toLowerCase().includes(normalizedQuery));
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const draftIssues = useMemo(() => agentIssues(draftAttachments(draft, baseModels), data), [baseModels, data, draft]);

  // A filter chip whose count dropped to zero would strand an empty view.
  useEffect(() => {
    if ((filter === "mine" && mineCount === 0) || (filter === "attention" && attentionCount === 0)) {
      setFilter("all");
    }
  }, [attentionCount, filter, mineCount]);

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

  function openAgentEditor(model: ModelConfig | null) {
    setSelectedAgentId(model?.id ?? null);
    setDraft(draftFromAgent(model, defaultAgentBaseModel(baseModels), data));
    setActionStatus(null);
    setOpenMenu(null);
    setIsEditorOpen(true);
  }

  function createNewDraft(starter?: AgentStarter) {
    setSelectedAgentId(null);
    const base = draftFromAgent(null, defaultAgentBaseModel(baseModels), data);
    setDraft(
      starter
        ? { ...base, name: starter.name, system_prompt: starter.systemPrompt, meta_prompt: starter.metaPrompt }
        : base,
    );
    setActionStatus(null);
    setOpenMenu(null);
    setIsEditorOpen(true);
  }

  function duplicateAgent(agent: ModelConfig) {
    const copy = draftFromAgent(agent, defaultAgentBaseModel(baseModels), data);
    setSelectedAgentId(null);
    setDraft({
      ...copy,
      id: null,
      name: `${agent.name} (copy)`,
      // A copy starts unlocked and, for granted authors, private to them.
      admin_delete_locked: false,
      visibility: isAgentAuthorRestricted ? "private" : copy.visibility,
    });
    setActionStatus({
      tone: "success",
      message: `Editing a copy of ${agent.name}. It is not saved until you create it.`,
    });
    setOpenMenu(null);
    setIsEditorOpen(true);
  }

  function closeEditor() {
    setIsEditorOpen(false);
    setOpenMenu(null);
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
      setDraft(draftFromAgent(model, baseModel, data));
      setActionStatus({
        tone: "success",
        message: draft.id ? `${model.name} saved.` : `${model.name} created. It is ready to use in chat.`,
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
    setOpenMenu(null);
    if (!agentId) return;
    const name = (targetAgent?.name ?? draft.name).trim() || "this agent";
    if (!window.confirm(`Delete ${name}? People using it in chat will lose access.`)) return;
    setPendingAction(`agent:delete:${agentId}`);
    try {
      await deleteAdminAgentProfile(data.me.id, agentId);
      onDataChange((current) => ({
        ...current,
        models: current.models.filter((item) => item.id !== agentId),
      }));
      setSelectedAgentId((current) => (current === agentId ? null : current));
      if (draft.id === agentId) setIsEditorOpen(false);
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
    setOpenMenu(null);
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
      onDataChange((current) => ({
        ...current,
        models: current.models.filter((item) => !deletedIdSet.has(item.id)),
      }));
      setSelectedAgentId((current) => (current && deletedIdSet.has(current) ? null : current));
      if (draft.id && deletedIdSet.has(draft.id)) setIsEditorOpen(false);
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

  const statusNotice = actionStatus && (
    <div
      className={`ws-notice ${actionStatus.tone === "success" ? "is-success" : "is-warning"} agent-action-status-toast`}
      role="status"
    >
      {actionStatus.tone === "success" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
      <span className="action-status-message">{actionStatus.message}</span>
      <button
        className="icon-button"
        type="button"
        aria-label="Dismiss notification"
        data-tooltip="Clear this status message from the screen"
        onClick={() => setActionStatus(null)}
      >
        <X size={14} />
      </button>
    </div>
  );

  const header = (
    <header className="console-header">
      <div>
        <h1>Agents</h1>
        <p>
          Build focused assistants with their own instructions, knowledge,
          and tools. Choose who can use them in your workspace.
        </p>
      </div>
      {sectionTabs}
    </header>
  );

  if (isEditorOpen) {
    const deleteLocked = agentDeleteLockedForAdmin(selectedAgent, data);
    const knowledgeCount = draft.knowledge_config_ids.length;
    const toolCount = draft.tool_config_ids.filter((id) => id !== hermesTool?.id).length;
    const promptCount = draft.prompt_template_ids.length + draft.skill_file_ids.length;
    const audience = agentAudience(draft.visibility);
    const everyoneValue: ModelConfig["visibility"] = draft.visibility === "organization" ? "organization" : "tenant";
    return (
      <div className="console-page agent-workspace-page agents-page">
        {header}
        <div className="agent-editor-view">
          <div className="agent-editor-head">
            <button
              className="agent-editor-back"
              type="button"
              aria-label="Close editor"
              data-tooltip="Return to all agents without saving"
              onClick={closeEditor}
            >
              <ArrowLeft size={16} /> All agents
            </button>
            <div className="agent-editor-title">
              <span className="ws-card-icon" aria-hidden="true">{agentInitials(draft.name || "New agent")}</span>
              <div>
                <h2>{draft.id ? draft.name || "Untitled agent" : "New agent"}</h2>
                <p>
                  {draft.id
                    ? canEditSelectedAgent
                      ? "Edit settings, then save to update it for everyone who uses it."
                      : "You can view this agent's settings but not change them."
                    : "Not saved yet. Give it a name, a model, and instructions."}
                </p>
              </div>
            </div>
            <div className="agent-editor-head-actions">
              {draft.id && (
                <button
                  className="secondary-button compact-button"
                  type="button"
                  data-tooltip="Start a chat with this agent answering your messages"
                  onClick={() => onUseInChat(draft.id!)}
                >
                  <MessageSquare size={15} /> Use in Chat
                </button>
              )}
              {draft.id && selectedAgent && (canAuthorAgents || canEditSelectedAgent) && (
                <OverflowMenu
                  id="editor"
                  label={`More actions for ${selectedAgent.name}`}
                  openMenu={openMenu}
                  setOpenMenu={setOpenMenu}
                >
                  {canAuthorAgents && (
                    <button type="button" role="menuitem" onClick={() => duplicateAgent(selectedAgent)}>
                      <Copy size={15} /> Duplicate
                    </button>
                  )}
                  {canEditSelectedAgent && (
                    <button
                      type="button"
                      role="menuitem"
                      className="is-danger"
                      disabled={pendingAction === `agent:delete:${draft.id}` || deleteLocked}
                      data-tooltip={
                        deleteLocked
                          ? "This agent is protected by organization policy and cannot be deleted"
                          : "Permanently remove this agent profile from the workspace"
                      }
                      onClick={() => void deleteAgentProfile()}
                    >
                      {deleteLocked ? <Lock size={15} /> : <Trash2 size={15} />}
                      <StableLabel
                        label={
                          pendingAction === `agent:delete:${draft.id}`
                            ? "Deleting..."
                            : deleteLocked
                              ? "Locked"
                              : "Delete Agent"
                        }
                        reserve={["Deleting...", "Locked", "Delete Agent"]}
                      />
                    </button>
                  )}
                </OverflowMenu>
              )}
            </div>
          </div>

          {statusNotice}

          <div className="agent-editor-card">
            <Tabs.Root
              key={draft.id ?? "new-agent"}
              defaultValue="basics"
              className="tabs-root agent-editor-tabs"
            >
              <Tabs.List
                className="tabs-list agent-tabs-list"
                aria-label="Agent profile editor sections"
              >
                {(
                  [
                    ["Profile", "basics", null],
                    ["Knowledge", "knowledge", knowledgeCount],
                    ["Tools", "tools", toolCount],
                    ["Prompts & Skills", "prompts", promptCount],
                    ["Access", "access", null],
                    ["Hermes", "hermes", null],
                  ] as Array<[string, string, number | null]>
                ).map(([label, value, count]) => (
                  <Tabs.Trigger
                    className="tab-trigger"
                    key={value}
                    value={value}
                    data-tooltip={AGENT_TAB_TOOLTIPS[value]}
                    aria-label={label}
                  >
                    {label}
                    {count ? <span className="agent-tab-count" aria-hidden="true">{count}</span> : null}
                  </Tabs.Trigger>
                ))}
              </Tabs.List>

              <Tabs.Content value="basics" className="tab-content agent-tab-content">
                <div className="agent-builder-form">
                  {!draft.id && canAuthorAgents && (
                    <div className="agent-starter-row">
                      <span className="ws-section-label">Start from a template</span>
                      <div className="ws-chips" role="group" aria-label="Agent templates">
                        {AGENT_STARTERS.map((starter) => (
                          <button
                            key={starter.key}
                            type="button"
                            className="ws-chip"
                            aria-pressed={draft.name === starter.name && draft.system_prompt === starter.systemPrompt}
                            data-tooltip={starter.summary}
                            onClick={() =>
                              updateDraft({
                                name: starter.name,
                                system_prompt: starter.systemPrompt,
                                meta_prompt: starter.metaPrompt,
                              })
                            }
                          >
                            <starter.icon size={13} /> {starter.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {draftIssues.length > 0 && (
                    <div className="agent-readiness" role="status">
                      <strong>
                        <AlertTriangle size={15} />{" "}
                        {draftIssues.some((issue) => issue.severity === "blocker")
                          ? "Chats with this agent will fail until this is fixed"
                          : "This agent is running with less than you configured"}
                      </strong>
                      <ul>
                        {draftIssues.map((issue, index) => (
                          <li key={`${issue.kind}-${index}`}>{issue.message}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <label>
                    Agent name
                    <input
                      value={draft.name}
                      placeholder="e.g. Research Analyst"
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
                    {isAgentAdmin && (
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
                    )}
                  </div>
                  <PromptEditorField
                    className="wide-field"
                    label="System prompt"
                    kind="system"
                    userId={data.me.id}
                    modelId={draft.base_model_id}
                    value={draft.system_prompt}
                    onChange={(system_prompt) => updateDraft({ system_prompt })}
                  />
                  <span className="agent-field-hint wide-field">
                    The agent's core instructions: its role, what it should produce, and what it must never do.
                  </span>
                  <PromptEditorField
                    className="wide-field"
                    label="Meta prompt"
                    kind="meta"
                    userId={data.me.id}
                    modelId={draft.base_model_id}
                    value={draft.meta_prompt}
                    onChange={(meta_prompt) => updateDraft({ meta_prompt })}
                  />
                  <span className="agent-field-hint wide-field">
                    Standing rules added after the instructions on every turn, such as tone, citation style, or format.
                  </span>
                </div>
              </Tabs.Content>

              <Tabs.Content value="knowledge" className="tab-content agent-tab-content">
                <p className="agent-tab-intro">
                  In agent mode, the agent searches these knowledge bases for every message and cites what it finds.
                </p>
                <SelectionGroup
                  title="Knowledge bases"
                  icon={<BookOpen size={16} />}
                  values={draft.knowledge_config_ids}
                  emptyText="No knowledge bases yet. Add one under Library → Knowledge, then attach it here."
                  options={data.knowledgeBases.map((item) => ({
                    id: item.id,
                    label: item.name,
                    detail: item.enabled
                      ? `${item.source} · ${item.document_count} ${plural(item.document_count, "file")} · ${item.status}`
                      : "Turned off — the agent answers without it until it is turned back on",
                    unavailable: !item.enabled,
                  }))}
                  onChange={(values) =>
                    updateDraft({ knowledge_config_ids: values })
                  }
                />
              </Tabs.Content>

              <Tabs.Content value="tools" className="tab-content agent-tab-content">
                <p className="agent-tab-intro">
                  Tools run only in chat with agent mode on. Tools that need approval ask the person chatting before they run.
                </p>
                <SelectionGroup
                  title="MCP servers and tools"
                  icon={<Wrench size={16} />}
                  values={draft.tool_config_ids.filter((id) => id !== hermesTool?.id)}
                  emptyText="No tools yet. Connect one under Library → Tools, then attach it here."
                  options={data.tools
                    .filter((item) => item.id !== hermesTool?.id)
                    .map((item) => ({
                      id: item.id,
                      label: item.name,
                      detail: item.enabled
                        ? `${item.type}${item.approval_required ? " · asks for approval" : ""}`
                        : "Turned off — chats with this agent are refused while it is attached",
                      unavailable: !item.enabled,
                    }))}
                  onChange={(values) =>
                    updateDraft({
                      tool_config_ids:
                        hermesTool?.id && draft.tool_config_ids.includes(hermesTool.id)
                          ? unique([...values, hermesTool.id])
                          : values,
                    })
                  }
                />
              </Tabs.Content>

              <Tabs.Content value="prompts" className="tab-content agent-tab-content">
                <p className="agent-tab-intro">
                  Attached templates and skill files are added to the agent's instructions on every turn.
                </p>
                <SelectionGroup
                  title="Template prompts"
                  icon={<FileText size={16} />}
                  values={draft.prompt_template_ids}
                  emptyText="No prompt templates yet. Create one under Library → Tools."
                  options={data.promptTemplates.map((item) => ({
                    id: item.id,
                    label: item.name,
                    detail: item.enabled
                      ? `${item.category} · ${item.variables.length} ${plural(item.variables.length, "variable")}`
                      : "Turned off — chats with this agent are refused while it is attached",
                    unavailable: !item.enabled,
                  }))}
                  onChange={(values) =>
                    updateDraft({ prompt_template_ids: values })
                  }
                />
                <SelectionGroup
                  title="Skill files"
                  icon={<ServerCog size={16} />}
                  values={draft.skill_file_ids}
                  emptyText="No skill files yet. Create one under Library → Tools."
                  options={data.skillFiles.map((item) => ({
                    id: item.id,
                    label: item.name,
                    detail: item.enabled
                      ? `${item.category} · v${item.version}`
                      : "Turned off — chats with this agent are refused while it is attached",
                    unavailable: !item.enabled,
                  }))}
                  onChange={(values) => updateDraft({ skill_file_ids: values })}
                />
              </Tabs.Content>

              <Tabs.Content value="access" className="tab-content agent-tab-content">
                {isAgentAuthorRestricted ? (
                  <div className="agent-companion-row">
                    <span>
                      <Lock size={17} />
                      <strong>Private — only you can use this agent.</strong>
                      <small>
                        Agents you build stay private to your account. Ask an admin to
                        share this agent with a group.
                      </small>
                    </span>
                  </div>
                ) : (
                  <div className="agent-builder-form agent-access-form">
                    <label className="agent-access-select">
                      Visibility
                      <SelectControl
                        aria-label="Visibility"
                        value={audience === "everyone" ? everyoneValue : draft.visibility}
                        onChange={(event) =>
                          updateDraft({
                            visibility: event.target
                              .value as ModelConfig["visibility"],
                          })
                        }
                      >
                        <option value={everyoneValue}>Everyone in the organization</option>
                        <option value="group">Selected groups</option>
                        <option value="private">Only the creator</option>
                      </SelectControl>
                      <span className="agent-field-hint">
                        {audience === "everyone"
                          ? "Anyone in this organization can pick this agent in chat."
                          : audience === "groups"
                            ? "Only members of the groups checked below can use this agent."
                            : "Only the person who created this agent can use it. Admins can still manage it."}
                      </span>
                    </label>
                    {audience === "groups" && (
                      <SelectionGroup
                        title="Allowed groups"
                        icon={<KeyRound size={16} />}
                        values={draft.group_ids}
                        emptyText="No groups exist yet. Create one under Admin → Users & groups."
                        options={data.groups.map((item) => ({
                          id: item.id,
                          label: item.name,
                          detail: `${item.user_count} ${plural(item.user_count, "user")}`,
                        }))}
                        onChange={(values) => updateDraft({ group_ids: values })}
                      />
                    )}
                  </div>
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

              <Tabs.Content value="hermes" className="tab-content agent-tab-content">
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
                      automatically. Proposed automations are created paused under Agents ·
                      Automations until you review and turn them on.
                    </p>
                  </div>
                )}
              </Tabs.Content>
            </Tabs.Root>
            {canEditSelectedAgent && (
              <div className="agent-editor-foot">
                <span className="agent-editor-foot-note">
                  {isAgentAuthorRestricted
                    ? "Saved privately to your account."
                    : `Who can use it: ${agentAudienceLabel(draft.visibility).toLowerCase()}.`}
                </span>
                <span className="ws-spacer" />
                <button className="secondary-button compact-button" type="button" onClick={closeEditor}>
                  Cancel
                </button>
                <button
                  className="primary-button compact-button"
                  type="button"
                  data-tooltip={
                    isAgentAuthorRestricted
                      ? "Save this agent profile to your own private workspace"
                      : "Save your changes so this agent is available to the people you chose"
                  }
                  onClick={() => void saveAgentProfile()}
                  disabled={pendingAction === "agent:save" || !selectedBaseModelAvailable || !draft.name.trim()}
                >
                  <StableLabel
                    label={pendingAction === "agent:save" ? "Saving..." : draft.id ? "Save Profile" : "Create agent"}
                    reserve={["Saving...", "Save Profile", "Create agent"]}
                  />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="console-page agent-workspace-page agents-page">
      {header}

      {statusNotice}

      {authoringBlockedReason && (
        <div className="ws-notice policy-callout">
          <Lock size={15} />
          <span>
            <strong>Building agents is not available to you.</strong>{" "}
            {authoringBlockedReason}
          </span>
        </div>
      )}

      {agentProfiles.length > 0 && (
        <div className="ws-toolbar">
          <label className="ws-search">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              value={query}
              placeholder="Search agents"
              aria-label="Search agents"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="ws-chips" role="group" aria-label="Filter agents">
            <button type="button" className="ws-chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
              All <span className="ws-chip-count">{agentProfiles.length}</span>
            </button>
            {mineCount > 0 && mineCount < agentProfiles.length && (
              <button type="button" className="ws-chip" aria-pressed={filter === "mine"} onClick={() => setFilter("mine")}>
                Created by me <span className="ws-chip-count">{mineCount}</span>
              </button>
            )}
            {attentionCount > 0 && (
              <button
                type="button"
                className="ws-chip"
                aria-pressed={filter === "attention"}
                onClick={() => setFilter("attention")}
              >
                <AlertTriangle size={13} /> Needs attention <span className="ws-chip-count">{attentionCount}</span>
              </button>
            )}
          </div>
          <div className="ws-toolbar-actions">
            {canAuthorAgents && (
              <button
                className="primary-button compact-button"
                type="button"
                data-tooltip={
                  isAgentAuthorRestricted
                    ? "Create a private agent profile with its own model, tools, and prompts"
                    : "Create a new agent profile with its own model, tools, and prompts"
                }
                onClick={() => createNewDraft()}
              >
                <Plus size={16} /> New Agent
              </button>
            )}
            {isAgentAdmin && (
              <OverflowMenu
                id="toolbar"
                label="More agent actions"
                openMenu={openMenu}
                setOpenMenu={setOpenMenu}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="is-danger"
                  data-tooltip="Delete every agent profile in this workspace so you can start fresh"
                  disabled={pendingAction === "agent:clear"}
                  onClick={() => void clearAgentProfiles()}
                >
                  <Trash2 size={15} />
                  {pendingAction === "agent:clear" ? "Clearing..." : "Clear Agents"}
                </button>
              </OverflowMenu>
            )}
          </div>
        </div>
      )}

      {agentProfiles.length === 0 ? (
        <div className="ws-empty">
          <span className="ws-empty-icon"><Bot size={24} /></span>
          <h2>{canAuthorAgents ? "Build your first agent" : "No agents are shared with you yet"}</h2>
          <p>
            {canAuthorAgents
              ? "An agent is an assistant with its own instructions, knowledge, and tools. Start from a template below or from scratch; nothing is saved until you create it."
              : "When an admin shares an agent with you, it appears here and in the chat model picker."}
          </p>
          {canAuthorAgents && (
            <>
              <div className="ws-empty-actions">
                <button className="primary-button compact-button" type="button" onClick={() => createNewDraft()}>
                  <Plus size={16} /> New Agent
                </button>
              </div>
              <div className="ws-starters" role="group" aria-label="Agent templates">
                {AGENT_STARTERS.map((starter) => (
                  <button
                    key={starter.key}
                    type="button"
                    className="ws-starter"
                    onClick={() => createNewDraft(starter)}
                  >
                    <span className="ws-starter-icon"><starter.icon size={16} /></span>
                    <span>
                      <strong>{starter.name}</strong>
                      <small>{starter.summary}</small>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      ) : filteredAgents.length === 0 ? (
        <p className="ws-no-results">No agents match your search.</p>
      ) : (
        <div className="ws-card-grid agent-card-grid">
          {filteredAgents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              data={data}
              issues={issuesById.get(agent.id) ?? []}
              hermesToolId={hermesTool?.id}
              canEdit={canAuthorProfile(agent)}
              canDuplicate={canAuthorAgents}
              deleteLocked={agentDeleteLockedForAdmin(agent, data)}
              isDeleting={pendingAction === `agent:delete:${agent.id}` || pendingAction === "agent:clear"}
              openMenu={openMenu}
              setOpenMenu={setOpenMenu}
              onChat={() => onUseInChat(agent.id)}
              onEdit={() => openAgentEditor(agent)}
              onDuplicate={() => duplicateAgent(agent)}
              onDelete={() => void deleteAgentProfile(agent)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentCard({
  agent,
  data,
  issues,
  hermesToolId,
  canEdit,
  canDuplicate,
  deleteLocked,
  isDeleting,
  openMenu,
  setOpenMenu,
  onChat,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  agent: ModelConfig;
  data: BootstrapData;
  issues: AgentIssue[];
  hermesToolId?: string;
  canEdit: boolean;
  canDuplicate: boolean;
  deleteLocked: boolean;
  isDeleting: boolean;
  openMenu: string | null;
  setOpenMenu: (value: string | null) => void;
  onChat: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const attachments = agentAttachments(agent);
  const knowledge = knowledgeSummary(attachments.knowledge_config_ids, data);
  const toolCount = attachments.tool_config_ids.filter((id) => id !== hermesToolId).length;
  const skillCount = attachments.skill_file_ids.length;
  const templateCount = attachments.prompt_template_ids.length;
  const summary = agentSummary(agent.system_prompt);
  const baseModel = data.models.find(
    (model) =>
      !isAgentProfile(model) &&
      model.provider_id === agent.provider_id &&
      (model.upstream_model_id ?? model.name) === (agent.upstream_model_id ?? agent.name),
  );
  const modelLabel = baseModel?.name ?? agent.upstream_model_id ?? agent.provider_name ?? "Model";
  const hasMenu = canDuplicate || canEdit;
  return (
    <article className={`ws-card agent-card ${issues.length ? "is-attention" : ""}`} aria-label={agent.name}>
      <div className="ws-card-head">
        <span className="ws-card-icon" aria-hidden="true">{agentInitials(agent.name)}</span>
        <div>
          <h3 className="ws-card-title">{agent.name}</h3>
          <p className="ws-card-meta">
            {modelLabel} · {agentAudienceLabel(agent.visibility)}
          </p>
        </div>
      </div>
      <div className="ws-card-body">
        <p className={`agent-card-desc ${summary ? "" : "is-empty"}`}>
          {summary || "No instructions yet — it behaves like its base model."}
        </p>
        <ul className="ws-facts" aria-label={`${agent.name} capabilities`}>
          <li className="ws-fact">
            <BookOpen size={13} /> {knowledge.baseCount} knowledge · {knowledge.documentCount} {plural(knowledge.documentCount, "file")}
          </li>
          <li className="ws-fact">
            <Wrench size={13} /> {toolCount} {plural(toolCount, "tool")}
          </li>
          {templateCount > 0 && (
            <li className="ws-fact">
              <FileText size={13} /> {templateCount} {plural(templateCount, "template")}
            </li>
          )}
          {skillCount > 0 && (
            <li className="ws-fact">
              <ServerCog size={13} /> {skillCount} {plural(skillCount, "skill")}
            </li>
          )}
          {agent.agentic_companion === "hermes" && (
            <li className="ws-fact">
              <Sparkles size={13} /> Hermes
            </li>
          )}
        </ul>
        {issues.length > 0 && (
          <ul className="agent-card-issues">
            {issues.slice(0, 2).map((issue, index) => (
              <li key={`${issue.kind}-${index}`}>
                <AlertTriangle size={13} /> {issue.message}
              </li>
            ))}
            {issues.length > 2 && <li>+{issues.length - 2} more — open the agent to review.</li>}
          </ul>
        )}
      </div>
      <div className="ws-card-foot">
        <button
          className="primary-button compact-button"
          type="button"
          data-tooltip={`Jump into a chat with ${agent.name} answering your messages`}
          onClick={onChat}
          disabled={isDeleting}
        >
          <MessageSquare size={15} /> Chat
        </button>
        {canEdit && (
          <button
            className="secondary-button compact-button"
            type="button"
            data-tooltip={`Open ${agent.name} in the editor to change its settings`}
            onClick={onEdit}
            disabled={isDeleting}
          >
            <PenLine size={15} /> Edit
          </button>
        )}
        <span className="ws-spacer" />
        {issues.length ? (
          <span className="ws-badge is-warn">Needs attention</span>
        ) : (
          <span className="ws-badge is-ok">Ready</span>
        )}
        {hasMenu && (
          <OverflowMenu
            id={`card:${agent.id}`}
            label={`More actions for ${agent.name}`}
            openMenu={openMenu}
            setOpenMenu={setOpenMenu}
            up
          >
            {canDuplicate && (
              <button type="button" role="menuitem" onClick={onDuplicate}>
                <Copy size={15} /> Duplicate
              </button>
            )}
            {canEdit && (
              <button
                type="button"
                role="menuitem"
                className="is-danger"
                onClick={onDelete}
                disabled={isDeleting || deleteLocked}
                data-tooltip={
                  deleteLocked
                    ? `${agent.name} is protected by organization policy and cannot be deleted`
                    : `Permanently remove ${agent.name} from this workspace`
                }
              >
                {deleteLocked ? <Lock size={15} /> : <Trash2 size={15} />}
                {isDeleting && !deleteLocked ? "Deleting..." : deleteLocked ? "Locked" : "Delete"}
              </button>
            )}
          </OverflowMenu>
        )}
      </div>
    </article>
  );
}

/** A "⋯" button with a small action menu. One menu is open at a time; it
 * closes on outside click, Escape, or after an action runs. */
export function OverflowMenu({
  id,
  label,
  openMenu,
  setOpenMenu,
  up = false,
  children,
}: {
  id: string;
  label: string;
  openMenu: string | null;
  setOpenMenu: (value: string | null) => void;
  up?: boolean;
  children: ReactNode;
}) {
  const open = openMenu === id;
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpenMenu]);
  return (
    <div className="ws-overflow" ref={rootRef}>
      <button
        className="icon-button"
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tooltip={label}
        onClick={() => setOpenMenu(open ? null : id)}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div className={`ws-overflow-menu ${up ? "is-up" : ""}`} role="menu" aria-label={label}>
          {children}
        </div>
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
  emptyText,
}: {
  title: string;
  icon: ReactNode;
  values: string[];
  options: Array<{ id: string; label: string; detail: string; unavailable?: boolean }>;
  onChange: (values: string[]) => void;
  emptyText?: string;
}) {
  // An attached item the viewer can no longer see (deleted, or not shared)
  // would otherwise be invisible and impossible to detach.
  const known = new Set(options.map((option) => option.id));
  const missing = values
    .filter((id) => !known.has(id))
    .map((id) => ({
      id,
      label: "Unavailable item",
      detail: "Deleted or not shared with you — uncheck to remove it",
      unavailable: true,
    }));
  const allOptions = [...options, ...missing];
  return (
    <fieldset className="agent-selection-group">
      <legend>
        {icon} {title}
      </legend>
      {allOptions.length === 0 ? (
        <div className="agent-choice-empty">{emptyText ?? "Nothing to choose from yet."}</div>
      ) : (
        <div className="agent-choice-grid">
          {allOptions.map((option) => (
            <label key={option.id} className={option.unavailable ? "is-unavailable" : undefined}>
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
      )}
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

/** The draft's attachments in the shape the readiness checks read. The
 * provider comes from the chosen base model, so switching models re-checks. */
function draftAttachments(draft: AgentDraft, baseModels: ModelConfig[]) {
  const baseModel = baseModels.find((model) => model.id === draft.base_model_id);
  return {
    // An unchosen model is reported by the model field itself, not here.
    provider_id: baseModel?.provider_id ?? "",
    knowledge_config_ids: draft.knowledge_config_ids,
    tool_config_ids: draft.tool_config_ids,
    prompt_template_ids: draft.prompt_template_ids,
    skill_file_ids: draft.skill_file_ids,
  };
}

/** A new agent starts empty: nothing is attached until its author chooses
 * it, so an agent never silently inherits knowledge, templates, or skills. */
function draftFromAgent(
  agent: ModelConfig | null,
  fallbackBaseModel: ModelConfig | undefined,
  data: BootstrapData,
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
  return {
    id: agent?.id ?? null,
    name: agent?.name ?? "",
    base_model_id: baseModel?.id ?? "",
    visibility: agent?.visibility ?? "tenant",
    group_ids:
      agent?.group_ids ?? (data.groups[0]?.id ? [data.groups[0].id] : []),
    knowledge_config_ids: agent ? modelKnowledgeIds(agent) : [],
    tool_config_ids: agent ? modelToolIds(agent) : [],
    system_prompt: agent?.system_prompt ?? "",
    meta_prompt: agent?.meta_prompt ?? "",
    agentic_companion: agent?.agentic_companion === "hermes" ? "hermes" : null,
    prompt_template_ids: agent?.prompt_template_ids ?? [],
    skill_file_ids: agent?.skill_file_ids ?? [],
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
    baseCount: ids.length,
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
