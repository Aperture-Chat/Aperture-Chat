import { SelectControl } from "./SelectControl";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  Bot,
  FileText,
  FolderSync,
  KeyRound,
  PlugZap,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { DismissibleNotice, Panel, Pill, StableLabel, Toggle } from "./Primitives";
import { connectorEnabled, isMcpRuntimeTool } from "../lib/connectors";
import { MEDIA_UPLOAD_EXTENSIONS } from "../lib/mediaUploads";
import { ToolLibraryManager } from "./ToolLibraryManager";
import {
  createAdminKnowledgeConfig,
  createAdminToolConfig,
  callToolMcp,
  checkToolMcpHealth,
  deleteAdminKnowledgeConfig,
  deleteKnowledgeDocument,
  addKnowledgeApiSource,
  addKnowledgeWebSource,
  deleteAdminToolConfig,
  listKnowledgeDocuments,
  knowledgeApiSourceOAuthCallbackUrl,
  mapKnowledgeConfigRecordToKnowledgeBase,
  mapToolConfigRecordToDisplay,
  toolOAuthCallbackUrl,
  updateAdminKnowledgeConfig,
  updateAdminToolConfig,
  syncKnowledgeBase,
  uploadKnowledgeDocuments,
} from "../lib/api";
import type {
  BootstrapData,
  ConnectorConfigRecord,
  KnowledgeBase,
  KnowledgeConfigRecord,
  KnowledgeDocument,
  McpHealthResult,
  McpRuntimeInvocation,
  McpToolCallResult,
  ToolConfig,
} from "../lib/types";

type KnowledgeSourceDraft = {
  name: string;
  url: string;
  text: string;
  authType: string;
  secret: string;
  sourceLabel: string;
  resourceId: string;
  requestMethod: string;
  headerNotes: string;
  apiKeyName: string;
  apiKeyPlacement: string;
  clientId: string;
  oauthAuthorizationUrl: string;
  oauthTokenUrl: string;
  scopesText: string;
  audience: string;
};

type KnowledgeDataTab = "documents" | "web" | "api";

type KnowledgeCreateDraft = {
  name: string;
  sourceType: string;
  ownerGroupId: string;
};

type KnowledgeSourceRetry = {
  knowledgeBase: KnowledgeBase;
  sourceType: string;
  files: File[];
  webDraft: KnowledgeSourceDraft;
  apiDraft: KnowledgeSourceDraft;
};

type ToolDraft = {
  name: string;
  endpoint: string;
  transport: string;
  authType: string;
  clientId: string;
  oauthAuthorizationUrl: string;
  oauthTokenUrl: string;
  command: string;
  argsText: string;
  scopesText: string;
  runtimeInvocationsText: string;
  secret: string;
  approvalRequired: boolean;
  hermesCompanion: boolean;
  allowedGroupIds: string[];
};

type KnowledgeConnectorProfile = {
  rootSettingKeys: string[];
  labelSettingKeys: string[];
};

function toolOAuthAuthorizeUrl(toolId: string, draft: ToolDraft): string | null {
  const authorizationUrl = draft.oauthAuthorizationUrl.trim();
  const clientId = draft.clientId.trim();
  if (!authorizationUrl || !clientId) return null;
  try {
    const url = new URL(authorizationUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", toolOAuthCallbackUrl(toolId));
    url.searchParams.set("state", toolId);
    const scopes = parseDelimitedList(draft.scopesText);
    if (scopes.length > 0) {
      url.searchParams.set("scope", scopes.join(" "));
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function LibraryConsole({
  data,
  view,
  onDataChange,
  sectionTabs,
}: {
  data: BootstrapData;
  view: "knowledge" | "tools";
  onDataChange: (updater: (current: BootstrapData) => BootstrapData) => void;
  sectionTabs?: ReactNode;
}) {
  const isKnowledge = view === "knowledge";
  const knowledgeRows = data.knowledgeBases;
  const canConfigure =
    data.me.role === "TENANT_ADMIN" || data.me.role === "PLATFORM_OWNER";
  // Tenant policy grants let standard users author private, self-owned
  // records; the server enforces the same grants and ownership.
  const canCreateKnowledge = canConfigure || Boolean(data.authoringState?.knowledge_enabled);
  const canCreateTools = canConfigure || Boolean(data.authoringState?.tools_enabled);
  const canManageKnowledgeRow = (item: KnowledgeBase) =>
    canConfigure || (canCreateKnowledge && item.owner_user_id === data.me.id);
  const canManageToolRow = (item: ToolConfig) =>
    canConfigure || (canCreateTools && item.owner_user_id === data.me.id);
  const mcpAvailable = connectorEnabled(data.connectors, "mcp");
  const promptLibraryAvailable = connectorEnabled(data.connectors, "prompt-library");
  // Workspace kill switches: users never see MCP-runtime connections while the
  // MCP Servers switch is off; admins keep them listed so they can manage and
  // re-enable them.
  const toolRows =
    isKnowledge || mcpAvailable || canConfigure
      ? data.tools
      : data.tools.filter((tool) => !isMcpRuntimeTool(tool));
  const [actionStatus, setActionStatus] = useState<{
    tone: "success" | "warning" | "danger";
    message: string;
  } | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [expandedKnowledgeId, setExpandedKnowledgeId] = useState<string | null>(
    null,
  );
  const [knowledgeDataTabs, setKnowledgeDataTabs] = useState<
    Record<string, KnowledgeDataTab>
  >({});
  const [showKnowledgeCreate, setShowKnowledgeCreate] = useState(false);
  const [knowledgeCreateDraft, setKnowledgeCreateDraft] =
    useState<KnowledgeCreateDraft>(() =>
      createDefaultKnowledgeCreateDraft(),
    );
  const [knowledgeCreateFiles, setKnowledgeCreateFiles] = useState<File[]>([]);
  const [knowledgeCreateFileError, setKnowledgeCreateFileError] = useState<
    string | null
  >(null);
  const [knowledgeCreateWebDraft, setKnowledgeCreateWebDraft] =
    useState<KnowledgeSourceDraft>(() => emptyKnowledgeSourceDraft());
  const [knowledgeCreateApiDraft, setKnowledgeCreateApiDraft] =
    useState<KnowledgeSourceDraft>(() => emptyKnowledgeSourceDraft());
  const [webSourceDrafts, setWebSourceDrafts] = useState<
    Record<string, KnowledgeSourceDraft>
  >({});
  const [apiSourceDrafts, setApiSourceDrafts] = useState<
    Record<string, KnowledgeSourceDraft>
  >({});
  const [knowledgeSourceRetries, setKnowledgeSourceRetries] = useState<Record<string, KnowledgeSourceRetry>>({});
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null);
  const [toolWorkspaceTab, setToolWorkspaceTab] = useState<
    "connections" | "prompts" | "skills"
  >("connections");
  const [toolDrafts, setToolDrafts] = useState<Record<string, ToolDraft>>({});
  const [toolHealthResults, setToolHealthResults] = useState<
    Record<string, McpHealthResult>
  >({});
  const [toolCallResults, setToolCallResults] = useState<
    Record<string, McpToolCallResult>
  >({});
  const [knowledgeDocuments, setKnowledgeDocuments] = useState<
    Record<string, KnowledgeDocument[]>
  >({});
  const [documentErrors, setDocumentErrors] = useState<Record<string, string>>(
    {},
  );

  const selectedKnowledgeCreateSource = knowledgeCreateSourceOption(
    knowledgeCreateDraft.sourceType,
  );
  const knowledgeCreateUsesApiInput =
    selectedKnowledgeCreateSource.value === "api";

  useEffect(() => {
    if (!actionStatus) return;
    const timeoutId = window.setTimeout(() => setActionStatus(null), 30_000);
    return () => window.clearTimeout(timeoutId);
  }, [actionStatus]);

  function updateWebSourceDraft(
    item: KnowledgeBase,
    patch: Partial<KnowledgeSourceDraft>,
  ) {
    setWebSourceDrafts((current) => ({
      ...current,
      [item.id]: {
        ...(current[item.id] ?? emptyKnowledgeSourceDraft()),
        ...patch,
      },
    }));
  }

  function updateApiSourceDraft(
    item: KnowledgeBase,
    patch: Partial<KnowledgeSourceDraft>,
  ) {
    setApiSourceDrafts((current) => ({
      ...current,
      [item.id]: {
        ...(current[item.id] ?? emptyKnowledgeSourceDraft()),
        ...patch,
      },
    }));
  }

  async function uploadKnowledgeFiles(
    item: KnowledgeBase,
    files: FileList | null,
  ) {
    const selectedFiles = Array.from(files ?? []);
    if (!selectedFiles.length) return;
    setPendingAction(`knowledge:${item.id}:upload`);
    try {
      const result = await uploadKnowledgeDocuments(
        data.me.id,
        item.id,
        selectedFiles,
      );
      applyKnowledgeSyncResult(item, result);
      const chunkCount = totalKnowledgeChunks(result.documents);
      setActionStatus({
        tone: "success",
        message: `${item.name} indexed ${selectedFiles.length} uploaded document${
          selectedFiles.length === 1 ? "" : "s"
        }. Current index: ${result.documents.length} documents, ${chunkCount} searchable chunks.`,
      });
    } catch (error) {
      setActionStatus({
        tone: "danger",
        message: `${item.name} upload failed: ${formatAppError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function saveWebSource(item: KnowledgeBase) {
    const draft = webSourceDrafts[item.id] ?? emptyKnowledgeSourceDraft();
    if (!draft.url.trim()) {
      setActionStatus({
        tone: "warning",
        message: "A web source URL is required before saving.",
      });
      return;
    }
    setPendingAction(`knowledge:${item.id}:web-source`);
    try {
      const result = await addKnowledgeWebSource(data.me.id, item.id, {
        name: draft.name.trim() || draft.url.trim(),
        url: draft.url.trim(),
        text: draft.text.trim() || null,
      });
      applyKnowledgeSyncResult(item, result);
      setWebSourceDrafts((current) => ({
        ...current,
        [item.id]: emptyKnowledgeSourceDraft(),
      }));
      setActionStatus({
        tone: "success",
        message: `${item.name} web source saved and indexed.`,
      });
    } catch (error) {
      setActionStatus({
        tone: "danger",
        message: `${item.name} web source failed: ${formatAppError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function saveApiSource(item: KnowledgeBase) {
    const draft = apiSourceDrafts[item.id] ?? emptyKnowledgeSourceDraft();
    if (!draft.url.trim()) {
      setActionStatus({
        tone: "warning",
        message: "An API base URL is required before saving.",
      });
      return;
    }
    setPendingAction(`knowledge:${item.id}:api-source`);
    try {
      const scopes = parseDelimitedList(draft.scopesText);
      const isOAuthClient = draft.authType === "oauth-client";
      const result = await addKnowledgeApiSource(data.me.id, item.id, {
        name: draft.name.trim() || draft.url.trim(),
        base_url: draft.url.trim(),
        auth_type: draft.authType.trim() || "api-key",
        secret_value: draft.secret.trim() || null,
        description: draft.text.trim() || null,
        source_label: draft.sourceLabel.trim() || null,
        resource_id: draft.resourceId.trim() || null,
        request_method: draft.requestMethod.trim() || null,
        header_notes: draft.headerNotes.trim() || null,
        ...(draft.authType === "api-key"
          ? {
              credential_name: draft.apiKeyName.trim() || "X-API-Key",
              credential_location: draft.apiKeyPlacement.trim() || "header",
            }
          : {}),
        ...(isOAuthClient
          ? {
              client_id: draft.clientId.trim() || null,
              authorization_url: draft.oauthAuthorizationUrl.trim() || null,
              token_url: draft.oauthTokenUrl.trim() || null,
              callback_url: knowledgeApiSourceOAuthCallbackUrl(item.id),
              scopes,
              audience: draft.audience.trim() || null,
            }
          : {}),
      });
      applyKnowledgeSyncResult(item, result);
      setApiSourceDrafts((current) => ({
        ...current,
        [item.id]: emptyKnowledgeSourceDraft(),
      }));
      setActionStatus({
        tone: "success",
        message: `${item.name} API source saved and indexed.`,
      });
    } catch (error) {
      setActionStatus({
        tone: "danger",
        message: `${item.name} API source failed: ${formatAppError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  function applyKnowledgeSyncResult(
    item: KnowledgeBase,
    result: { config: KnowledgeConfigRecord; documents: KnowledgeDocument[] },
  ) {
    const saved = mapKnowledgeConfigRecordToKnowledgeBase(result.config, {
      connectors: data.connectors,
      connectorConfigs: data.connectorConfigs,
      groups: data.groups,
      users: data.visibleUsers ?? data.users,
    });
    setKnowledgeDocuments((current) => ({
      ...current,
      [item.id]: result.documents,
    }));
    setDocumentErrors((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    setKnowledgeSourceRetries((current) => omitRecordKey(current, item.id));
    setExpandedKnowledgeId(item.id);
    onDataChange((current) => replaceKnowledgeBase(current, item.id, saved));
  }

  function revealKnowledgeDetails(target: HTMLElement) {
    const tableScroller = target.closest(".table-scroll");
    if (tableScroller instanceof HTMLElement) {
      tableScroller.scrollLeft = 0;
    }
  }

  function toggleKnowledgeCreate() {
    if (!canCreateKnowledge) {
      setActionStatus({
        tone: "warning",
        message: "This view is read-only for your current role.",
      });
      return;
    }
    setShowKnowledgeCreate((current) => {
      if (!current) {
        setKnowledgeCreateDraft(createDefaultKnowledgeCreateDraft());
        setKnowledgeCreateFiles([]);
        setKnowledgeCreateFileError(null);
        setKnowledgeCreateWebDraft(emptyKnowledgeSourceDraft());
        setKnowledgeCreateApiDraft(emptyKnowledgeSourceDraft());
      }
      return !current;
    });
  }

  function updateKnowledgeCreateDraft(patch: Partial<KnowledgeCreateDraft>) {
    setKnowledgeCreateDraft((current) => ({ ...current, ...patch }));
  }

  function updateKnowledgeCreateSource(sourceType: string) {
    setKnowledgeCreateDraft((current) => {
      const previousSource = knowledgeCreateSourceOption(current.sourceType);
      const nextSource = knowledgeCreateSourceOption(sourceType);
      return {
        ...current,
        sourceType: nextSource.value,
        name:
          !current.name.trim() || current.name === previousSource.defaultName
            ? nextSource.defaultName
            : current.name,
      };
    });
  }

  async function importCreatedKnowledgeSource(attempt: KnowledgeSourceRetry) {
    const saved = attempt.knowledgeBase;
    const source = knowledgeCreateSourceOption(attempt.sourceType);
    let sourceResult: {
      config: KnowledgeConfigRecord;
      documents: KnowledgeDocument[];
    } | null = null;
    let sourceSuccessMessage = `${saved.name} data source was saved. Review its status below.`;
    if (source.value === "upload") {
      sourceResult = await uploadKnowledgeDocuments(
        data.me.id,
        saved.id,
        attempt.files,
      );
      const chunkCount = totalKnowledgeChunks(sourceResult.documents);
      sourceSuccessMessage = `${saved.name} indexed ${sourceResult.documents.length} document${
        sourceResult.documents.length === 1 ? "" : "s"
      } into ${chunkCount} searchable chunk${chunkCount === 1 ? "" : "s"}.`;
    } else if (source.value === "web") {
      sourceResult = await addKnowledgeWebSource(data.me.id, saved.id, {
        name:
          attempt.webDraft.name.trim() ||
          attempt.webDraft.url.trim(),
        url: attempt.webDraft.url.trim(),
        text: attempt.webDraft.text.trim() || null,
      });
    } else if (source.value === "api") {
      const draft = attempt.apiDraft;
      const scopes = parseDelimitedList(draft.scopesText);
      const isOAuthClient = draft.authType === "oauth-client";
      sourceResult = await addKnowledgeApiSource(data.me.id, saved.id, {
        name: draft.name.trim() || draft.url.trim(),
        base_url: draft.url.trim(),
        auth_type: draft.authType.trim() || "api-key",
        secret_value: draft.secret.trim() || null,
        description: draft.text.trim() || null,
        source_label:
          draft.sourceLabel.trim() || source.defaultSource || null,
        resource_id: draft.resourceId.trim() || null,
        request_method: draft.requestMethod.trim() || null,
        header_notes: draft.headerNotes.trim() || null,
        ...(draft.authType === "api-key"
          ? {
              credential_name: draft.apiKeyName.trim() || "X-API-Key",
              credential_location:
                draft.apiKeyPlacement.trim() || "header",
            }
          : {}),
        ...(isOAuthClient
          ? {
              client_id: draft.clientId.trim() || null,
              authorization_url:
                draft.oauthAuthorizationUrl.trim() || null,
              token_url: draft.oauthTokenUrl.trim() || null,
              callback_url: knowledgeApiSourceOAuthCallbackUrl(saved.id),
              scopes,
              audience: draft.audience.trim() || null,
            }
          : {}),
      });
    }

    if (sourceResult) {
      applyKnowledgeSyncResult(saved, sourceResult);
    }
    setActionStatus({ tone: "success", message: sourceSuccessMessage });
  }

  async function retryCreatedKnowledgeSource(item: KnowledgeBase) {
    const attempt = knowledgeSourceRetries[item.id];
    if (!attempt) return;
    const actionKey = `knowledge:${item.id}:source-retry`;
    setPendingAction(actionKey);
    try {
      await importCreatedKnowledgeSource({
        ...attempt,
        webDraft: webSourceDrafts[item.id] ?? attempt.webDraft,
        apiDraft: apiSourceDrafts[item.id] ?? attempt.apiDraft,
      });
    } catch (error) {
      setActionStatus({
        tone: "warning",
        message: `${item.name} source import did not finish. The saved knowledge base and retry details are still available. ${formatAppError(error)}`,
      });
    } finally {
      setPendingAction((current) => current === actionKey ? null : current);
    }
  }

  async function createKnowledgeBase() {
    if (!canCreateKnowledge) {
      setActionStatus({
        tone: "warning",
        message: "This view is read-only for your current role.",
      });
      return;
    }
    const source = knowledgeCreateSourceOption(knowledgeCreateDraft.sourceType);
    const name = knowledgeCreateDraft.name.trim();
    if (!name) {
      setActionStatus({
        tone: "warning",
        message: "Knowledge base name is required before saving.",
      });
      return;
    }
    if (source.value === "upload" && knowledgeCreateFiles.length === 0) {
      setActionStatus({
        tone: "warning",
        message: "Choose at least one document to create this knowledge base.",
      });
      return;
    }
    if (source.value === "web" && !knowledgeCreateWebDraft.url.trim()) {
      setActionStatus({
        tone: "warning",
        message: "Enter a web link to create this knowledge base.",
      });
      return;
    }
    if (knowledgeCreateUsesApiInput && !knowledgeCreateApiDraft.url.trim()) {
      setActionStatus({
        tone: "warning",
        message: "Enter an API base URL to create this knowledge base.",
      });
      return;
    }
    const aclGroupIds = knowledgeCreateDraft.ownerGroupId
      ? [knowledgeCreateDraft.ownerGroupId]
      : [];
    const acl = knowledgeAclLabel(data, knowledgeCreateDraft.ownerGroupId);
    const id = `knowledge-${source.value.replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;

    setPendingAction("feature:create");
    try {
      const record = await createAdminKnowledgeConfig(data.me.id, {
        id,
        name,
        source_type: source.value,
        connector_config_id: null,
        enabled: true,
        acl_group_ids: aclGroupIds,
        owner_user_id: data.me.id,
        settings: {
          description: source.defaultDescription,
          source: source.defaultSource,
          source_type_label: source.label,
          status: "draft",
          document_count: 0,
          last_sync: "Not synced",
          acl,
        },
      });
      const saved = mapKnowledgeConfigRecordToKnowledgeBase(record, {
        connectors: data.connectors,
        connectorConfigs: data.connectorConfigs,
        groups: data.groups,
        users: data.visibleUsers ?? data.users,
      });
      onDataChange((current) => ({
        ...current,
        knowledgeBases: [...current.knowledgeBases, saved],
      }));
      setKnowledgeDocuments((current) => ({ ...current, [saved.id]: [] }));
      setDocumentErrors((current) => {
        const next = { ...current };
        delete next[saved.id];
        return next;
      });
      setExpandedKnowledgeId(saved.id);
      setKnowledgeDataTabs((current) => ({
        ...current,
        [saved.id]: knowledgeDataTabForCreateSource(source),
      }));

      const sourceAttempt: KnowledgeSourceRetry = {
        knowledgeBase: saved,
        sourceType: source.value,
        files: [...knowledgeCreateFiles],
        webDraft: { ...knowledgeCreateWebDraft },
        apiDraft: { ...knowledgeCreateApiDraft },
      };
      try {
        await importCreatedKnowledgeSource(sourceAttempt);
        setShowKnowledgeCreate(false);
      } catch (sourceError) {
        setKnowledgeSourceRetries((current) => ({ ...current, [saved.id]: sourceAttempt }));
        setWebSourceDrafts((current) => ({ ...current, [saved.id]: sourceAttempt.webDraft }));
        setApiSourceDrafts((current) => ({ ...current, [saved.id]: sourceAttempt.apiDraft }));
        setShowKnowledgeCreate(false);
        setActionStatus({
          tone: "warning",
          message: `${saved.name} was created, but its data source could not be added. Retry the source import below; no second knowledge base is needed. ${formatAppError(sourceError)}`,
        });
        return;
      }
    } catch (error) {
      setActionStatus({
        tone: "danger",
        message: `Knowledge base was not created: ${formatAppError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function addFeature() {
    if (!canCreateTools) {
      setActionStatus({
        tone: "warning",
        message: "This view is read-only for your current role.",
      });
      return;
    }
    const primaryGroup = data.groups[0];
    const id = `tool-custom-${Date.now()}`;
    setPendingAction("feature:create");

    const fallback: ToolConfig = {
      id,
      name: "New MCP Tool",
      description:
        "Draft tool awaiting endpoint, schema discovery, and approval policy.",
      type: "mcp",
      status: "draft",
      enabled: false,
      approval_required: true,
      allowed_group_ids: primaryGroup?.id ? [primaryGroup.id] : [],
      scopes: ["tenant.tool"],
      connected_model_ids: [],
      endpoint: "mcp://new-tool",
    };
    try {
      const record = await createAdminToolConfig(data.me.id, {
        id,
        name: fallback.name,
        tool_type: fallback.type,
        endpoint_url: fallback.endpoint,
        enabled: fallback.enabled,
        approval_required: fallback.approval_required,
        allowed_group_ids: fallback.allowed_group_ids,
        settings: {
          description: fallback.description,
          scopes: fallback.scopes,
          connected_model_ids: fallback.connected_model_ids,
          status: fallback.status,
        },
      });
      const saved = mapToolConfigRecordToDisplay(record);
      onDataChange((current) => ({
        ...current,
        tools: [...current.tools, saved],
      }));
      setExpandedToolId(saved.id);
      setToolDrafts((current) => ({ ...current, [saved.id]: toolDraftFromConfig(saved, data) }));
      setActionStatus({
        tone: "success",
        message: `${saved.name} created. Configure its connection below, then test it before enabling.`,
      });
    } catch (error) {
      setActionStatus({
        tone: "danger",
        message: `Tool was not created. Try Add Tool again. ${formatAppError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function toggleKnowledgeBase(item: KnowledgeBase, enabled: boolean) {
    const patch: Partial<KnowledgeBase> = {
      enabled,
      status: enabled ? item.status : "draft",
    };
    setPendingAction(`knowledge:${item.id}`);
    onDataChange((current) => replaceKnowledgeBase(current, item.id, patch));
    try {
      const record = await updateAdminKnowledgeConfig(data.me.id, item.id, {
        enabled,
        settings: {
          description: item.description,
          source: item.source,
          status: patch.status,
          document_count: item.document_count,
          last_sync: enabled ? item.last_sync : "Not synced",
          acl: item.acl,
        },
      });
      const saved = mapKnowledgeConfigRecordToKnowledgeBase(record, {
        connectors: data.connectors,
        groups: data.groups,
        users: data.visibleUsers ?? data.users,
      });
      onDataChange((current) => replaceKnowledgeBase(current, item.id, saved));
      setActionStatus({
        tone: "success",
        message: `${saved.name} synced with the admin knowledge API.`,
      });
    } catch (error) {
      setActionStatus({
        tone: "danger",
        message: `${item.name} changed locally only. Backend update failed: ${formatAppError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function loadKnowledgeDocuments(item: KnowledgeBase) {
    if (expandedKnowledgeId === item.id) {
      setExpandedKnowledgeId(null);
      return;
    }
    setExpandedKnowledgeId(item.id);
    setKnowledgeDataTabs((current) => ({
      ...current,
      [item.id]: current[item.id] ?? "documents",
    }));
    if (knowledgeDocuments[item.id]) return;

    setPendingAction(`knowledge:${item.id}:documents`);
    setDocumentErrors((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    try {
      const documents = await listKnowledgeDocuments(data.me.id, item.id);
      setKnowledgeDocuments((current) => ({
        ...current,
        [item.id]: documents,
      }));
      setActionStatus({
        tone: "success",
        message: `${item.name} document inventory loaded from the knowledge API.`,
      });
    } catch (error) {
      const message = formatAppError(error);
      setDocumentErrors((current) => ({ ...current, [item.id]: message }));
      setActionStatus({
        tone: "danger",
        message: `${item.name} documents could not load: ${message}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function syncKnowledge(item: KnowledgeBase) {
    if (!canManageKnowledgeRow(item)) {
      setActionStatus({
        tone: "warning",
        message: "Only administrators or the knowledge base owner can sync knowledge.",
      });
      return;
    }
    setPendingAction(`knowledge:${item.id}:sync`);
    onDataChange((current) =>
      replaceKnowledgeBase(current, item.id, {
        status: "syncing",
        last_sync: "Syncing...",
      }),
    );
    try {
      const result = await syncKnowledgeBase(data.me.id, item.id);
      const saved = mapKnowledgeConfigRecordToKnowledgeBase(result.config, {
        connectors: data.connectors,
        groups: data.groups,
        users: data.visibleUsers ?? data.users,
      });
      setKnowledgeDocuments((current) => ({
        ...current,
        [item.id]: result.documents,
      }));
      setDocumentErrors((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      setExpandedKnowledgeId(item.id);
      onDataChange((current) => replaceKnowledgeBase(current, item.id, saved));
      setActionStatus({
        tone: "success",
        message:
          `${saved.name} synced ${result.documents.length} documents through the knowledge API. ${
            result.provider_message ?? saved.provider_message ?? ""
          }`.trim(),
      });
    } catch (error) {
      onDataChange((current) =>
        replaceKnowledgeBase(current, item.id, {
          status: "error",
          last_sync: item.last_sync,
        }),
      );
      setActionStatus({
        tone: "danger",
        message: `${item.name} sync failed: ${formatAppError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function deleteIndexedDocument(
    item: KnowledgeBase,
    document: KnowledgeDocument,
  ) {
    if (!canManageKnowledgeRow(item)) {
      setActionStatus({
        tone: "warning",
        message: "This view is read-only for your current role.",
      });
      return;
    }
    const confirmed = window.confirm(
      `Delete ${document.name}? This removes the document and its indexed chunks.`,
    );
    if (!confirmed) return;
    setPendingAction(`knowledge:${item.id}:document-delete:${document.id}`);
    try {
      const result = await deleteKnowledgeDocument(
        data.me.id,
        item.id,
        document.id,
      );
      applyKnowledgeSyncResult(item, result);
      setActionStatus({
        tone: "success",
        message: `${document.name} deleted from ${item.name}. Current index: ${result.documents.length} documents, ${totalKnowledgeChunks(
          result.documents,
        )} searchable chunks.`,
      });
    } catch (error) {
      setActionStatus({
        tone: "danger",
        message: `${document.name} delete failed: ${formatAppError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function deleteKnowledgeBase(item: KnowledgeBase) {
    if (!canManageKnowledgeRow(item)) {
      setActionStatus({
        tone: "warning",
        message: "This view is read-only for your current role.",
      });
      return;
    }
    const confirmed = window.confirm(
      `Delete ${item.name}? This removes the knowledge base, indexed documents, and model links from the tenant catalog.`,
    );
    if (!confirmed) return;
    setPendingAction(`knowledge:${item.id}:delete`);
    try {
      await deleteAdminKnowledgeConfig(data.me.id, item.id);
      onDataChange((current) => ({
        ...current,
        knowledgeBases: current.knowledgeBases.filter(
          (knowledge) => knowledge.id !== item.id,
        ),
        models: current.models.map((model) => ({
          ...model,
          knowledge_base_ids: model.knowledge_base_ids?.filter(
            (knowledgeId) => knowledgeId !== item.id,
          ),
          knowledge_config_ids: model.knowledge_config_ids?.filter(
            (knowledgeId) => knowledgeId !== item.id,
          ),
        })),
      }));
      setExpandedKnowledgeId((current) =>
        current === item.id ? null : current,
      );
      setKnowledgeDocuments((current) => omitRecordKey(current, item.id));
      setDocumentErrors((current) => omitRecordKey(current, item.id));
      setWebSourceDrafts((current) => omitRecordKey(current, item.id));
      setApiSourceDrafts((current) => omitRecordKey(current, item.id));
      setKnowledgeSourceRetries((current) => omitRecordKey(current, item.id));
      setActionStatus({
        tone: "success",
        message: `${item.name} deleted from the admin knowledge API.`,
      });
    } catch (error) {
      setActionStatus({
        tone: "danger",
        message: `${item.name} delete failed: ${formatAppError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function clearKnowledgeBases() {
    if (!canConfigure) {
      setActionStatus({
        tone: "warning",
        message: "This view is read-only for your current role.",
      });
      return;
    }
    if (!data.knowledgeBases.length) {
      setActionStatus({
        tone: "warning",
        message: "No knowledge bases are configured yet.",
      });
      return;
    }
    const confirmed = window.confirm(
      `Delete all ${data.knowledgeBases.length} knowledge base${data.knowledgeBases.length === 1 ? "" : "s"}? This removes the knowledge bases, indexed documents, and model links from the tenant catalog.`,
    );
    if (!confirmed) return;

    setPendingAction("knowledge:clear");
    const deletedIds: string[] = [];
    const failures: string[] = [];
    for (const item of data.knowledgeBases) {
      try {
        await deleteAdminKnowledgeConfig(data.me.id, item.id);
        deletedIds.push(item.id);
      } catch (error) {
        failures.push(`${item.name}: ${formatAppError(error)}`);
      }
    }

    if (deletedIds.length) {
      const deletedIdSet = new Set(deletedIds);
      onDataChange((current) => ({
        ...current,
        knowledgeBases: current.knowledgeBases.filter(
          (knowledge) => !deletedIdSet.has(knowledge.id),
        ),
        models: current.models.map((model) => ({
          ...model,
          knowledge_base_ids: model.knowledge_base_ids?.filter(
            (knowledgeId) => !deletedIdSet.has(knowledgeId),
          ),
          knowledge_config_ids: model.knowledge_config_ids?.filter(
            (knowledgeId) => !deletedIdSet.has(knowledgeId),
          ),
        })),
      }));
      setExpandedKnowledgeId((current) =>
        current && deletedIdSet.has(current) ? null : current,
      );
      setKnowledgeDocuments((current) => omitRecordKeys(current, deletedIdSet));
      setDocumentErrors((current) => omitRecordKeys(current, deletedIdSet));
      setWebSourceDrafts((current) => omitRecordKeys(current, deletedIdSet));
      setApiSourceDrafts((current) => omitRecordKeys(current, deletedIdSet));
      setKnowledgeSourceRetries((current) => omitRecordKeys(current, deletedIdSet));
    }

    if (failures.length) {
      setActionStatus({
        tone: "danger",
        message: `Deleted ${deletedIds.length} knowledge base${deletedIds.length === 1 ? "" : "s"}. Failed: ${failures.join("; ")}`,
      });
    } else {
      setActionStatus({
        tone: "success",
        message: `Cleared ${deletedIds.length} knowledge base${deletedIds.length === 1 ? "" : "s"}.`,
      });
    }
    setPendingAction(null);
  }

  function toggleToolDetails(item: ToolConfig) {
    setExpandedToolId((current) => (current === item.id ? null : item.id));
    setToolDrafts((current) => ({
      ...current,
      [item.id]: current[item.id] ?? toolDraftFromConfig(item, data),
    }));
  }

  function updateToolDraft(item: ToolConfig, patch: Partial<ToolDraft>) {
    setToolDrafts((current) => ({
      ...current,
      [item.id]: {
        ...(current[item.id] ?? toolDraftFromConfig(item, data)),
        ...patch,
      },
    }));
  }

  async function saveToolDetails(item: ToolConfig) {
    const draft = toolDrafts[item.id] ?? toolDraftFromConfig(item, data);
    if (!draft.name.trim()) {
      setActionStatus({
        tone: "warning",
        message: "Tool name is required before saving.",
      });
      return;
    }
    setPendingAction(`tool:${item.id}:details`);
    try {
      const scopes = parseDelimitedList(draft.scopesText);
      const runtimeInvocations = parseRuntimeInvocationsJson(
        draft.runtimeInvocationsText,
      );
      const record = await updateAdminToolConfig(data.me.id, item.id, {
        name: draft.name.trim(),
        tool_type: draft.hermesCompanion ? "mcp" : item.type,
        endpoint_url: draft.endpoint.trim() || null,
        approval_required: draft.approvalRequired,
        allowed_group_ids: draft.allowedGroupIds,
        settings: {
          description: item.description,
          status: item.enabled ? "ready" : "draft",
          scopes,
          connected_model_ids: item.connected_model_ids,
          transport: draft.transport,
          auth_type: draft.authType,
          client_id: draft.clientId.trim(),
          oauth_authorization_url: draft.oauthAuthorizationUrl.trim(),
          oauth_token_url: draft.oauthTokenUrl.trim(),
          oauth_callback_url: toolOAuthCallbackUrl(item.id),
          command: draft.command.trim(),
          args: parseDelimitedList(draft.argsText),
          runtime_invocations: runtimeInvocations,
          hermes_companion: draft.hermesCompanion,
        },
        ...(draft.secret.trim() ? { secret_value: draft.secret.trim() } : {}),
      });
      const saved = mapToolConfigRecordToDisplay(record);
      onDataChange((current) => replaceTool(current, item.id, saved));
      setToolDrafts((current) => ({
        ...current,
        [item.id]: toolDraftFromConfig(saved, data),
      }));
      setActionStatus({
        tone: "success",
        message: `${saved.name} MCP/tool settings saved through the admin API.`,
      });
    } catch (error) {
      setActionStatus({
        tone: "danger",
        message: `${item.name} tool save failed: ${formatAppError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function deleteTool(item: ToolConfig) {
    if (!canManageToolRow(item)) {
      setActionStatus({
        tone: "warning",
        message: "This view is read-only for your current role.",
      });
      return;
    }
    const confirmed = window.confirm(
      `Delete ${item.name}? This removes the tool configuration from the tenant catalog.`,
    );
    if (!confirmed) return;
    setPendingAction(`tool:${item.id}:delete`);
    try {
      await deleteAdminToolConfig(data.me.id, item.id);
      onDataChange((current) => ({
        ...current,
        tools: current.tools.filter((tool) => tool.id !== item.id),
        models: current.models.map((model) => ({
          ...model,
          tool_config_ids: model.tool_config_ids?.filter(
            (toolId) => toolId !== item.id,
          ),
          tool_ids: model.tool_ids?.filter((toolId) => toolId !== item.id),
        })),
      }));
      setExpandedToolId((current) => (current === item.id ? null : current));
      setToolDrafts((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      setToolHealthResults((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      setToolCallResults((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      setActionStatus({
        tone: "success",
        message: `${item.name} deleted from the admin tool API.`,
      });
    } catch (error) {
      setActionStatus({
        tone: "danger",
        message: `${item.name} delete failed: ${formatAppError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function runToolHealthCheck(item: ToolConfig) {
    setPendingAction(`tool:${item.id}:health`);
    try {
      const result = await checkToolMcpHealth(data.me.id, item.id);
      setToolHealthResults((current) => ({ ...current, [item.id]: result }));
      setActionStatus({
        tone: result.status === "ready" ? "success" : "warning",
        message: `${item.name} MCP check: ${result.message}`,
      });
    } catch (error) {
      setActionStatus({
        tone: "danger",
        message: `${item.name} MCP check failed: ${formatAppError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function runToolRuntimeCall(item: ToolConfig) {
    const draft = toolDrafts[item.id] ?? toolDraftFromConfig(item, data);
    let invocation: McpRuntimeInvocation | undefined;
    try {
      invocation = parseRuntimeInvocationsJson(draft.runtimeInvocationsText)[0];
    } catch (error) {
      setActionStatus({
        tone: "warning",
        message: `${item.name} runtime call config is invalid: ${formatAppError(error)}`,
      });
      return;
    }
    if (!invocation) {
      setActionStatus({
        tone: "warning",
        message:
          "Add at least one runtime invocation before running an MCP tool call.",
      });
      return;
    }
    setPendingAction(`tool:${item.id}:call`);
    try {
      const result = await callToolMcp(data.me.id, item.id, {
        tool_name: invocation.tool_name,
        label: invocation.label,
        arguments: substituteRuntimeInvocationArguments(
          invocation.arguments ?? {},
          {
            query: "Manual MCP runtime check",
            user_message: "Manual MCP runtime check",
            agent_profile_id: "tools-panel",
            agent_profile_name: "Tools panel",
          },
        ),
      });
      setToolCallResults((current) => ({ ...current, [item.id]: result }));
      setActionStatus({
        tone: result.status === "ready" ? "success" : "warning",
        message: `${item.name} MCP call ${result.status}: ${result.message}`,
      });
    } catch (error) {
      setActionStatus({
        tone: "danger",
        message: `${item.name} MCP call failed: ${formatAppError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function toggleTool(item: ToolConfig, enabled: boolean) {
    const patch: Partial<ToolConfig> = {
      enabled,
      status: enabled ? "ready" : "draft",
    };
    setPendingAction(`tool:${item.id}`);
    onDataChange((current) => replaceTool(current, item.id, patch));
    try {
      const record = await updateAdminToolConfig(data.me.id, item.id, {
        enabled,
        endpoint_url: item.endpoint,
        settings: {
          description: item.description,
          scopes: item.scopes,
          connected_model_ids: item.connected_model_ids,
          transport: item.transport,
          command: item.command,
          auth_type: item.auth_type,
          client_id: item.client_id,
          oauth_authorization_url: item.oauth_authorization_url,
          oauth_token_url: item.oauth_token_url,
          oauth_callback_url: item.oauth_callback_url,
          args: item.args ?? [],
          runtime_invocations: item.runtime_invocations ?? [],
          hermes_companion: Boolean(item.hermes_companion),
          status: patch.status,
        },
      });
      const saved = mapToolConfigRecordToDisplay(record);
      onDataChange((current) => replaceTool(current, item.id, saved));
      setActionStatus({
        tone: "success",
        message: `${saved.name} synced with the admin tool API.`,
      });
    } catch (error) {
      setActionStatus({
        tone: "danger",
        message: `${item.name} changed locally only. Backend update failed: ${formatAppError(error)}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="console-page feature-console-page">
      <header className="console-header">
        <div>
          <h1>Library</h1>
          <p>
            {isKnowledge
              ? "Organize the documents and sources your assistants can search. Access follows your workspace permissions."
              : "Connect the tools your assistants can use, with access and approvals set by your workspace."}
          </p>
        </div>
        {sectionTabs}
      </header>
      {actionStatus && (
        <div
          className="inline-warning feature-action-toast"
          role={actionStatus.tone === "danger" ? "alert" : "status"}
        >
          <Pill tone={actionStatus.tone}>
            {actionStatus.tone === "success" ? "Complete" : "Needs attention"}
          </Pill>
          <span>{actionStatus.message}</span>
          <button
            className="icon-button feature-action-toast-close"
            type="button"
            aria-label="Dismiss status"
            data-tooltip="Clear this status message from the screen"
            onClick={() => setActionStatus(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
      <div className="feature-grid">
        <Panel
          title={
            isKnowledge ? "Knowledge Bases" : "Tools Library and Connectors"
          }
          subtitle={
            isKnowledge
              ? `${data.currentTenant.name} tenant controls`
              : `${data.currentTenant.name} tenant prompts, skills, and connector controls`
          }
          actions={
            isKnowledge ? (
              <>
                <button
                  className="danger-button"
                  type="button"
                  data-tooltip="Delete every knowledge base in this tenant in one step"
                  onClick={() => void clearKnowledgeBases()}
                  disabled={
                    !canConfigure ||
                    !data.knowledgeBases.length ||
                    pendingAction === "knowledge:clear"
                  }
                >
                  <Trash2 size={16} />{" "}
                  {pendingAction === "knowledge:clear"
                    ? "Clearing..."
                    : "Clear Knowledge"}
                </button>
                <button
                  className="primary-button"
                  type="button"
                  data-tooltip={
                    showKnowledgeCreate
                      ? "Close the creator form without saving a new knowledge base"
                      : "Open a form to create a new knowledge base for this tenant"
                  }
                  onClick={toggleKnowledgeCreate}
                  disabled={
                    !canCreateKnowledge ||
                    pendingAction === "feature:create" ||
                    pendingAction === "knowledge:clear"
                  }
                >
                  <StableLabel
                    label={
                      pendingAction === "feature:create"
                        ? "Saving..."
                        : showKnowledgeCreate
                          ? "Close Creator"
                          : "Add Knowledge Base"
                    }
                    reserve={["Saving...", "Close Creator", "Add Knowledge Base"]}
                  />
                </button>
              </>
            ) : toolWorkspaceTab === "connections" ? (
              <button
                className="primary-button"
                type="button"
                data-tooltip="Add a new connector or MCP tool for this workspace"
                onClick={() => void addFeature()}
                disabled={!canCreateTools || pendingAction === "feature:create"}
              >
                <StableLabel
                  label={pendingAction === "feature:create" ? "Saving..." : "Add Tool"}
                  reserve={["Saving...", "Add Tool"]}
                />
              </button>
            ) : undefined
          }
        >
          {!isKnowledge && (
            <div className="tabs-root tool-console-tabs">
              <div
                className="tabs-list"
                role="tablist"
                aria-label="Tool workspace sections"
              >
                {[
                  ["Connections", "connections"],
                  ["Prompts", "prompts"],
                  ["Skills", "skills"],
                ].map(([label, value]) => (
                  <button
                    className="tab-trigger"
                    type="button"
                    role="tab"
                    key={value}
                    aria-selected={toolWorkspaceTab === value}
                    data-state={
                      toolWorkspaceTab === value ? "active" : "inactive"
                    }
                    data-tooltip={`Switch to the ${label} section of the tool workspace`}
                    onClick={() =>
                      setToolWorkspaceTab(value as typeof toolWorkspaceTab)
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {!isKnowledge && toolWorkspaceTab === "prompts" && (
            promptLibraryAvailable || canConfigure ? (
              <>
                {!promptLibraryAvailable && (
                  <DismissibleNotice id="prompt-library-off-admin">
                    The Prompt Library is turned off for this workspace — users cannot see or use
                    these prompts until it is re-enabled at the service level (Platform console → Org Settings →
                    Connectors).
                  </DismissibleNotice>
                )}
                <ToolLibraryManager
                  mode="template"
                  data={data}
                  onDataChange={onDataChange}
                />
              </>
            ) : (
              <DismissibleNotice id="prompt-library-off">
                The Prompt Library is turned off for this workspace.
              </DismissibleNotice>
            )
          )}
          {!isKnowledge && toolWorkspaceTab === "skills" && (
            <ToolLibraryManager
              mode="skill"
              data={data}
              onDataChange={onDataChange}
            />
          )}
          {(isKnowledge || toolWorkspaceTab === "connections") && (
            <>
              {!isKnowledge && !mcpAvailable && (
                <DismissibleNotice id="mcp-connections-off">
                  MCP servers are turned off for this workspace
                  {canConfigure
                    ? " — users cannot see or run these connections until they are re-enabled at the service level (Platform console → Org Settings → Connectors)."
                    : ", so MCP connections are unavailable."}
                </DismissibleNotice>
              )}
              {isKnowledge && showKnowledgeCreate && (
                <form
                  className="knowledge-create-panel"
                  aria-label="Create knowledge base"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void createKnowledgeBase();
                  }}
                >
                  <fieldset className="knowledge-create-source-picker">
                    <legend>What do you want to add?</legend>
                    <p>
                      Choose where the information lives, then add the first
                      data source below.
                    </p>
                    <div className="knowledge-create-source-options">
                      {KNOWLEDGE_CREATE_SOURCES.map((source) => (
                        <label
                          className={`knowledge-create-source-option${
                            knowledgeCreateDraft.sourceType === source.value
                              ? " is-selected"
                              : ""
                          }`}
                          key={source.value}
                        >
                          <input
                            type="radio"
                            name="knowledge-source-type"
                            value={source.value}
                            checked={
                              knowledgeCreateDraft.sourceType === source.value
                            }
                            onChange={() =>
                              updateKnowledgeCreateSource(source.value)
                            }
                            disabled={pendingAction === "feature:create"}
                          />
                          <span>
                            <strong>{source.label}</strong>
                            <small>{source.helper}</small>
                          </span>
                        </label>
                      ))}
                    </div>
                    {selectedKnowledgeCreateSource.value === "upload" && (
                      <section
                        className="knowledge-create-source-input"
                        aria-label="Add documents"
                      >
                        <div className="knowledge-create-source-input-heading">
                          <strong>Add documents</strong>
                          <small>
                            PDF, Word, images, audio, video, and text-based files
                            up to 250 MB each. Scanned pages use local OCR.
                            Audio is transcribed and video stills are described
                            with Gemini Flash before content is chunked and
                            indexed, including videos that have no audio track.
                          </small>
                        </div>
                        <div className="knowledge-create-upload-controls">
                          <label className="secondary-button knowledge-file-button">
                            <Upload size={16} />
                            <span>
                              {knowledgeCreateFiles.length
                                ? "Choose different files"
                                : "Choose files"}
                            </span>
                            <input
                              accept={KNOWLEDGE_UPLOAD_ACCEPT}
                              aria-label="Choose documents"
                              type="file"
                              multiple
                              onChange={(event) => {
                                const selectedFiles = Array.from(
                                  event.currentTarget.files ?? [],
                                );
                                const supportedFiles = selectedFiles.filter(
                                  isSupportedKnowledgeUpload,
                                );
                                const rejectedFiles = selectedFiles.filter(
                                  (file) => !isSupportedKnowledgeUpload(file),
                                );
                                setKnowledgeCreateFiles(supportedFiles);
                                setKnowledgeCreateFileError(
                                  rejectedFiles.length
                                    ? `${rejectedFiles.length} unsupported or oversized file${
                                        rejectedFiles.length === 1 ? " was" : "s were"
                                      } skipped.`
                                    : null,
                                );
                                event.currentTarget.value = "";
                              }}
                              disabled={pendingAction === "feature:create"}
                            />
                          </label>
                          <small>
                            Select one or several files. You can remove any item
                            before indexing.
                          </small>
                        </div>
                        {knowledgeCreateFileError && (
                          <div
                            className="knowledge-create-file-error"
                            role="alert"
                          >
                            <Pill tone="warning">File skipped</Pill>
                            <span>{knowledgeCreateFileError}</span>
                          </div>
                        )}
                        {knowledgeCreateFiles.length > 0 && (
                          <div
                            className="knowledge-create-file-selection"
                            aria-live="polite"
                          >
                            <div className="knowledge-create-file-selection-header">
                              <strong>Ready to index</strong>
                              <span>
                                {knowledgeCreateFiles.length} file
                                {knowledgeCreateFiles.length === 1 ? "" : "s"}
                                {" · "}
                                {formatKnowledgeFileSize(
                                  knowledgeCreateFiles.reduce(
                                    (total, file) => total + file.size,
                                    0,
                                  ),
                                )}
                              </span>
                            </div>
                            <ul className="knowledge-create-file-list">
                              {knowledgeCreateFiles.map((file, index) => (
                                <li
                                  key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                                >
                                  <span className="knowledge-create-file-icon">
                                    <FileText size={16} />
                                  </span>
                                  <span className="knowledge-create-file-copy">
                                    <strong title={file.name}>{file.name}</strong>
                                    <small>
                                      {formatKnowledgeFileSize(file.size)} ·
                                      Ready
                                    </small>
                                  </span>
                                  <button
                                    className="icon-button knowledge-create-file-remove"
                                    type="button"
                                    aria-label={`Remove ${file.name}`}
                                    data-tooltip={`Remove ${file.name} from this upload`}
                                    onClick={() =>
                                      setKnowledgeCreateFiles((current) =>
                                        current.filter(
                                          (_candidate, candidateIndex) =>
                                            candidateIndex !== index,
                                        ),
                                      )
                                    }
                                    disabled={
                                      pendingAction === "feature:create"
                                    }
                                  >
                                    <X size={15} />
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </section>
                    )}
                    {selectedKnowledgeCreateSource.value === "web" && (
                      <section
                        className="knowledge-create-source-input"
                        aria-label="Add a web link"
                      >
                        <div className="knowledge-create-source-input-heading">
                          <strong>Add a web link</strong>
                          <small>
                            The page and optional note will be indexed when the
                            knowledge base is created.
                          </small>
                        </div>
                        <div className="knowledge-create-source-fields">
                          <label>
                            Web address
                            <input
                              type="url"
                              value={knowledgeCreateWebDraft.url}
                              onChange={(event) =>
                                setKnowledgeCreateWebDraft((current) => ({
                                  ...current,
                                  url: event.target.value,
                                }))
                              }
                              placeholder="https://example.com/page"
                              disabled={pendingAction === "feature:create"}
                            />
                          </label>
                          <label>
                            Source name <span>Optional</span>
                            <input
                              value={knowledgeCreateWebDraft.name}
                              onChange={(event) =>
                                setKnowledgeCreateWebDraft((current) => ({
                                  ...current,
                                  name: event.target.value,
                                }))
                              }
                              placeholder="Client policy page"
                              disabled={pendingAction === "feature:create"}
                            />
                          </label>
                          <label className="knowledge-create-wide-field">
                            Note <span>Optional</span>
                            <textarea
                              value={knowledgeCreateWebDraft.text}
                              onChange={(event) =>
                                setKnowledgeCreateWebDraft((current) => ({
                                  ...current,
                                  text: event.target.value,
                                }))
                              }
                              placeholder="Add context about what this page contains"
                              disabled={pendingAction === "feature:create"}
                            />
                          </label>
                        </div>
                      </section>
                    )}
                    {knowledgeCreateUsesApiInput && (
                      <section
                        className="knowledge-create-source-input"
                        aria-label="Connect an API"
                      >
                        <div className="knowledge-create-source-input-heading">
                          <strong>Connect an API</strong>
                          <small>
                            Enter the endpoint and authentication this knowledge
                            base should use.
                          </small>
                        </div>
                        <div className="knowledge-create-source-fields knowledge-create-api-fields">
                          <label>
                            Base URL
                            <input
                              type="url"
                              value={knowledgeCreateApiDraft.url}
                              onChange={(event) =>
                                setKnowledgeCreateApiDraft((current) => ({
                                  ...current,
                                  url: event.target.value,
                                }))
                              }
                              placeholder="https://api.example.com"
                              disabled={pendingAction === "feature:create"}
                            />
                          </label>
                          <label>
                            Connection name <span>Optional</span>
                            <input
                              value={knowledgeCreateApiDraft.name}
                              onChange={(event) =>
                                setKnowledgeCreateApiDraft((current) => ({
                                  ...current,
                                  name: event.target.value,
                                }))
                              }
                              placeholder="Matter API"
                              disabled={pendingAction === "feature:create"}
                            />
                          </label>
                          <label>
                            Resource, folder, or path <span>Optional</span>
                            <input
                              value={knowledgeCreateApiDraft.resourceId}
                              onChange={(event) =>
                                setKnowledgeCreateApiDraft((current) => ({
                                  ...current,
                                  resourceId: event.target.value,
                                }))
                              }
                              placeholder="/matters/{id} or folder-id"
                              disabled={pendingAction === "feature:create"}
                            />
                          </label>
                          <label>
                            Authentication
                            <SelectControl
                              value={knowledgeCreateApiDraft.authType}
                              onChange={(event) =>
                                setKnowledgeCreateApiDraft((current) => ({
                                  ...current,
                                  authType: event.target.value,
                                }))
                              }
                              disabled={pendingAction === "feature:create"}
                            >
                              <option value="api-key">API key</option>
                              <option value="bearer-token">Bearer token</option>
                              <option value="oauth-client">OAuth client</option>
                            </SelectControl>
                          </label>
                          {knowledgeCreateApiDraft.authType !==
                          "oauth-client" ? (
                            <label className="knowledge-create-wide-field">
                              {knowledgeCreateApiDraft.authType === "api-key"
                                ? "API key"
                                : "Bearer token"}
                              <input
                                type="password"
                                autoComplete="new-password"
                                value={knowledgeCreateApiDraft.secret}
                                onChange={(event) =>
                                  setKnowledgeCreateApiDraft((current) => ({
                                    ...current,
                                    secret: event.target.value,
                                  }))
                                }
                                placeholder="Stored securely after creation"
                                disabled={pendingAction === "feature:create"}
                              />
                            </label>
                          ) : (
                            <div className="knowledge-create-oauth-fields knowledge-create-wide-field">
                              <label>
                                Client ID
                                <input
                                  value={knowledgeCreateApiDraft.clientId}
                                  onChange={(event) =>
                                    setKnowledgeCreateApiDraft((current) => ({
                                      ...current,
                                      clientId: event.target.value,
                                    }))
                                  }
                                />
                              </label>
                              <label>
                                Client secret
                                <input
                                  type="password"
                                  autoComplete="new-password"
                                  value={knowledgeCreateApiDraft.secret}
                                  onChange={(event) =>
                                    setKnowledgeCreateApiDraft((current) => ({
                                      ...current,
                                      secret: event.target.value,
                                    }))
                                  }
                                />
                              </label>
                              <label>
                                Authorization URL
                                <input
                                  type="url"
                                  value={
                                    knowledgeCreateApiDraft.oauthAuthorizationUrl
                                  }
                                  onChange={(event) =>
                                    setKnowledgeCreateApiDraft((current) => ({
                                      ...current,
                                      oauthAuthorizationUrl:
                                        event.target.value,
                                    }))
                                  }
                                />
                              </label>
                              <label>
                                Token URL
                                <input
                                  type="url"
                                  value={knowledgeCreateApiDraft.oauthTokenUrl}
                                  onChange={(event) =>
                                    setKnowledgeCreateApiDraft((current) => ({
                                      ...current,
                                      oauthTokenUrl: event.target.value,
                                    }))
                                  }
                                />
                              </label>
                              <label className="knowledge-create-wide-field">
                                Scopes
                                <input
                                  value={knowledgeCreateApiDraft.scopesText}
                                  onChange={(event) =>
                                    setKnowledgeCreateApiDraft((current) => ({
                                      ...current,
                                      scopesText: event.target.value,
                                    }))
                                  }
                                  placeholder="read:documents, read:matters"
                                />
                              </label>
                            </div>
                          )}
                          <details className="knowledge-create-advanced knowledge-create-wide-field">
                            <summary>Advanced options</summary>
                            <div className="knowledge-create-source-fields">
                              <label>
                                Request method
                                <SelectControl
                                  value={
                                    knowledgeCreateApiDraft.requestMethod
                                  }
                                  onChange={(event) =>
                                    setKnowledgeCreateApiDraft((current) => ({
                                      ...current,
                                      requestMethod: event.target.value,
                                    }))
                                  }
                                >
                                  <option value="GET">GET</option>
                                  <option value="POST">POST</option>
                                  <option value="PUT">PUT</option>
                                  <option value="PATCH">PATCH</option>
                                </SelectControl>
                              </label>
                              <label>
                                Source label <span>Optional</span>
                                <input
                                  value={knowledgeCreateApiDraft.sourceLabel}
                                  onChange={(event) =>
                                    setKnowledgeCreateApiDraft((current) => ({
                                      ...current,
                                      sourceLabel: event.target.value,
                                    }))
                                  }
                                />
                              </label>
                              <label className="knowledge-create-wide-field">
                                Header notes <span>Optional</span>
                                <textarea
                                  value={knowledgeCreateApiDraft.headerNotes}
                                  onChange={(event) =>
                                    setKnowledgeCreateApiDraft((current) => ({
                                      ...current,
                                      headerNotes: event.target.value,
                                    }))
                                  }
                                  placeholder="Content-Type: application/json"
                                />
                              </label>
                            </div>
                          </details>
                        </div>
                      </section>
                    )}
                  </fieldset>
                  <div className="knowledge-create-details">
                    <label>
                      Knowledge base name
                      <input
                        value={knowledgeCreateDraft.name}
                        onChange={(event) =>
                          updateKnowledgeCreateDraft({
                            name: event.target.value,
                          })
                        }
                        placeholder="Matter knowledge base"
                        disabled={pendingAction === "feature:create"}
                      />
                    </label>
                    <label>
                      Who can use it?
                      <SelectControl
                        value={knowledgeCreateDraft.ownerGroupId}
                        onChange={(event) =>
                          updateKnowledgeCreateDraft({
                            ownerGroupId: event.target.value,
                          })
                        }
                        disabled={pendingAction === "feature:create"}
                      >
                        <option value="">Only me</option>
                        {data.groups.map((group) => (
                          <option key={group.id} value={group.id}>
                            {group.name}
                          </option>
                        ))}
                      </SelectControl>
                    </label>
                  </div>
                  <div className="knowledge-create-actions">
                    <p>
                      {knowledgeCreateActionSummary(
                        selectedKnowledgeCreateSource,
                      )}
                    </p>
                    <button
                      className="secondary-button"
                      type="button"
                      data-tooltip="Close the form and discard the new knowledge base details"
                      onClick={() => setShowKnowledgeCreate(false)}
                    >
                      Cancel
                    </button>
                    <button
                      className="primary-button"
                      type="submit"
                      data-tooltip="Create this knowledge base with the source and access you chose"
                      disabled={pendingAction === "feature:create"}
                    >
                      <StableLabel
                        label={
                          pendingAction === "feature:create"
                            ? selectedKnowledgeCreateSource.value === "upload"
                              ? "Uploading and indexing..."
                              : "Creating..."
                            : "Create with data source"
                        }
                        reserve={[
                          "Uploading and indexing...",
                          "Creating...",
                          "Create with data source",
                        ]}
                      />
                    </button>
                  </div>
                </form>
              )}
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Status</th>
                      <th>Security</th>
                      <th>Enabled</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(isKnowledge ? knowledgeRows : toolRows).map((item) => {
                      const sourceLabel = isKnowledge
                        ? (item as KnowledgeBase).source
                        : ((item as ToolConfig).endpoint ?? "");
                      const securityLabel = isKnowledge
                        ? (item as KnowledgeBase).acl
                        : toolSecuritySummary(item as ToolConfig, data);
                      const knowledgeItem = item as KnowledgeBase;
                      const documentList = isKnowledge
                        ? knowledgeDocuments[knowledgeItem.id]
                        : undefined;
                      const documentError = isKnowledge
                        ? documentErrors[knowledgeItem.id]
                        : undefined;
                      const webDraft = isKnowledge
                        ? (webSourceDrafts[knowledgeItem.id] ??
                          emptyKnowledgeSourceDraft())
                        : undefined;
                      const apiDraft = isKnowledge
                        ? (apiSourceDrafts[knowledgeItem.id] ??
                          emptyKnowledgeSourceDraft())
                        : undefined;
                      const activeKnowledgeDataTab = isKnowledge
                        ? (knowledgeDataTabs[knowledgeItem.id] ?? "documents")
                        : "documents";
                      const documentSummary = isKnowledge
                        ? summarizeKnowledgeDocuments(
                            documentList,
                            knowledgeItem,
                          )
                        : undefined;
                      const toolItem = item as ToolConfig;
                      const toolDraft = !isKnowledge
                        ? (toolDrafts[toolItem.id] ??
                          toolDraftFromConfig(toolItem, data))
                        : undefined;
                      const toolHealth = !isKnowledge
                        ? toolHealthResults[toolItem.id]
                        : undefined;
                      const toolCall = !isKnowledge
                        ? toolCallResults[toolItem.id]
                        : undefined;
                      const showKnowledgeDetails =
                        isKnowledge && expandedKnowledgeId === knowledgeItem.id;
                      const showToolDetails =
                        !isKnowledge && expandedToolId === toolItem.id;
                      const rowPending =
                        pendingAction === "knowledge:clear" ||
                        pendingAction?.startsWith(
                          `${isKnowledge ? "knowledge" : "tool"}:${item.id}`,
                        );
                      return (
                        <Fragment key={item.id}>
                          <tr>
                            <td>
                              <strong>{item.name}</strong>
                              <small className="table-subtext">
                                {sourceLabel}
                              </small>
                            </td>
                            <td>
                              <span
                                className={`dot ${item.status === "ready" || item.status === "synced" ? "green" : ""}`}
                              />{" "}
                              {item.status}
                            </td>
                            <td>{securityLabel}</td>
                            <td>
                              <Toggle
                                checked={item.enabled}
                                disabled={
                                  (isKnowledge
                                    ? !canManageKnowledgeRow(item as KnowledgeBase)
                                    : !canManageToolRow(item as ToolConfig)) || rowPending
                                }
                                label={`Enable ${item.name}`}
                                onChange={(next) =>
                                  isKnowledge
                                    ? void toggleKnowledgeBase(
                                        item as KnowledgeBase,
                                        next,
                                      )
                                    : void toggleTool(item as ToolConfig, next)
                                }
                              />
                            </td>
                            <td>
                              {isKnowledge ? (
                                <div className="table-actions">
                                  <button
                                    className="ghost-button"
                                    type="button"
                                    data-tooltip={
                                      expandedKnowledgeId === knowledgeItem.id
                                        ? `Hide the indexed data and sources for ${item.name}`
                                        : `Show the indexed documents and sources for ${item.name}`
                                    }
                                    onClick={(event) => {
                                      revealKnowledgeDetails(
                                        event.currentTarget,
                                      );
                                      void loadKnowledgeDocuments(
                                        knowledgeItem,
                                      );
                                    }}
                                    disabled={
                                      pendingAction ===
                                      `knowledge:${knowledgeItem.id}:documents`
                                    }
                                  >
                                    {expandedKnowledgeId === knowledgeItem.id
                                      ? "Hide Data"
                                      : "Show Data"}
                                  </button>
                                  <button
                                    className="secondary-button compact"
                                    type="button"
                                    data-tooltip={`Re-index ${item.name} so it reflects the latest source content`}
                                    onClick={(event) => {
                                      revealKnowledgeDetails(
                                        event.currentTarget,
                                      );
                                      void syncKnowledge(knowledgeItem);
                                    }}
                                    disabled={
                                      !canManageKnowledgeRow(knowledgeItem) ||
                                      pendingAction ===
                                        `knowledge:${knowledgeItem.id}:sync`
                                    }
                                  >
                                    {pendingAction ===
                                    `knowledge:${knowledgeItem.id}:sync`
                                      ? "Syncing..."
                                      : "Sync"}
                                  </button>
                                  <button
                                    className="danger-button compact"
                                    type="button"
                                    data-tooltip={`Permanently delete ${item.name} and its indexed content`}
                                    onClick={() =>
                                      void deleteKnowledgeBase(knowledgeItem)
                                    }
                                    disabled={
                                      !canManageKnowledgeRow(knowledgeItem) || rowPending
                                    }
                                  >
                                    <Trash2 size={14} />{" "}
                                    {pendingAction ===
                                    `knowledge:${knowledgeItem.id}:delete`
                                      ? "Deleting..."
                                      : "Delete"}
                                  </button>
                                </div>
                              ) : (
                                <div className="table-actions">
                                  <button
                                    className="ghost-button"
                                    type="button"
                                    data-tooltip={
                                      showToolDetails
                                        ? `Hide the MCP configuration panel for ${item.name}`
                                        : `Open connection, auth, and runtime settings for ${item.name}`
                                    }
                                    onClick={() =>
                                      toggleToolDetails(item as ToolConfig)
                                    }
                                    disabled={rowPending}
                                  >
                                    {showToolDetails
                                      ? "Hide Config"
                                      : "Configure MCP"}
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                          {showKnowledgeDetails && (
                            <tr className="knowledge-document-row">
                              <td colSpan={5}>
                                <div className="knowledge-documents-panel">
                                  {knowledgeSourceRetries[knowledgeItem.id] && (
                                    <div className="inline-warning" role="status">
                                      <span>
                                        Source import needs attention. Your selected documents and source details are retained while this page stays open.
                                        {knowledgeSourceRetries[knowledgeItem.id].files.length > 0 && ` Selected: ${knowledgeSourceRetries[knowledgeItem.id].files.map((file) => file.name).join(", ")}.`}
                                      </span>
                                      <button
                                        className="secondary-button compact-button"
                                        type="button"
                                        disabled={pendingAction?.startsWith(`knowledge:${knowledgeItem.id}`)}
                                        onClick={() => void retryCreatedKnowledgeSource(knowledgeItem)}
                                      >
                                        <FolderSync size={14} /> {pendingAction === `knowledge:${knowledgeItem.id}:source-retry` ? "Retrying..." : "Retry source import"}
                                      </button>
                                    </div>
                                  )}
                                  {expandedKnowledgeId === knowledgeItem.id &&
                                    webDraft &&
                                    apiDraft && (
                                    <div
                                      className="knowledge-data-panel-shell"
                                      aria-label={`${knowledgeItem.name} data sources`}
                                    >
                                      <div
                                        className="knowledge-data-tabs"
                                        role="tablist"
                                        aria-label={`${knowledgeItem.name} data type`}
                                      >
                                        {(
                                          [
                                            ["documents", "Documents"],
                                            ["web", "Web sources"],
                                            ["api", "API"],
                                          ] as const
                                        ).map(([tab, label]) => (
                                          <button
                                            key={tab}
                                            type="button"
                                            role="tab"
                                            aria-selected={
                                              activeKnowledgeDataTab === tab
                                            }
                                            className={
                                              activeKnowledgeDataTab === tab
                                                ? "is-active"
                                                : ""
                                            }
                                            data-tooltip={`Switch to the ${label} view for ${knowledgeItem.name}`}
                                            onClick={() =>
                                              setKnowledgeDataTabs(
                                                (current) => ({
                                                  ...current,
                                                  [knowledgeItem.id]: tab,
                                                }),
                                              )
                                            }
                                          >
                                            {label}
                                          </button>
                                        ))}
                                      </div>
                                    <div
                                      className={`knowledge-detail-grid${
                                        activeKnowledgeDataTab === "api" ? " is-api-tab" : ""
                                      }`}
                                    >
                                      {activeKnowledgeDataTab ===
                                        "documents" &&
                                        documentSummary && (
                                          <section
                                            className="knowledge-index-column"
                                            aria-label={`${knowledgeItem.name} indexed documents`}
                                          >
                                            <div className="knowledge-documents-header knowledge-index-overview">
                                              <div>
                                                <strong>
                                                  Indexed documents
                                                </strong>
                                                <small>
                                                  {
                                                    documentSummary.documentCount
                                                  }{" "}
                                                  documents
                                                  {documentSummary.chunkCount !==
                                                  null
                                                    ? ` · ${documentSummary.chunkCount} chunks`
                                                    : ""}{" "}
                                                  · Last sync{" "}
                                                  {knowledgeItem.last_sync}
                                                </small>
                                              </div>
                                            </div>
                                            {knowledgeItem.provider_message && (
                                              <div className="knowledge-provider-note">
                                                {knowledgeItem.provider_message}
                                              </div>
                                            )}
                                            {documentError && (
                                              <div
                                                className="inline-warning"
                                                role="alert"
                                              >
                                                <Pill tone="danger">Error</Pill>
                                                <span>{documentError}</span>
                                              </div>
                                            )}
                                            {!documentError &&
                                              !documentList && (
                                                <div className="empty-state compact">
                                                  {pendingAction ===
                                                  `knowledge:${knowledgeItem.id}:documents`
                                                    ? "Loading document inventory..."
                                                    : "Document inventory has not been loaded yet."}
                                                </div>
                                              )}
                                            {documentList &&
                                              documentList.length === 0 && (
                                                <div className="empty-state compact">
                                                  No indexed documents are
                                                  available for this base.
                                                </div>
                                              )}
                                            {documentList &&
                                              documentList.length > 0 && (
                                                <div className="knowledge-document-list-shell">
                                                  <div className="knowledge-document-list-toolbar">
                                                    <span>
                                                      {documentList.length.toLocaleString()}{" "}
                                                      indexed sources
                                                    </span>
                                                    <span>
                                                      Scroll to review
                                                    </span>
                                                  </div>
                                                  <div
                                                    className="knowledge-document-list"
                                                    role="list"
                                                    tabIndex={0}
                                                    aria-label={`${knowledgeItem.name} indexed document inventory`}
                                                  >
                                                    {documentList.map(
                                                      (document) => {
                                                        const deletePending =
                                                          pendingAction ===
                                                          `knowledge:${knowledgeItem.id}:document-delete:${document.id}`;
                                                        return (
                                                          <div
                                                            className="knowledge-document"
                                                            role="listitem"
                                                            key={document.id}
                                                          >
                                                            <div className="knowledge-document-main">
                                                              <strong
                                                                data-tooltip={`Full document name: ${document.name}`}
                                                              >
                                                                {document.name}
                                                              </strong>
                                                              <small
                                                                className="knowledge-document-source-line"
                                                                data-tooltip={`Indexed from ${document.source_uri}`}
                                                              >
                                                                {
                                                                  document.source_type
                                                                }{" "}
                                                                ·{" "}
                                                                {
                                                                  document.source_uri
                                                                }
                                                              </small>
                                                            </div>
                                                            <div className="knowledge-document-meta">
                                                              <span>
                                                                {
                                                                  document.updated_at
                                                                }
                                                              </span>
                                                            </div>
                                                            <button
                                                              className="icon-button document-delete-button"
                                                              type="button"
                                                              aria-label={`Delete ${document.name}`}
                                                              data-tooltip={`Remove ${document.name} from this knowledge base's index`}
                                                              onClick={() =>
                                                                void deleteIndexedDocument(
                                                                  knowledgeItem,
                                                                  document,
                                                                )
                                                              }
                                                              disabled={
                                                                !canManageKnowledgeRow(knowledgeItem) ||
                                                                deletePending
                                                              }
                                                            >
                                                              <Trash2
                                                                size={14}
                                                              />
                                                            </button>
                                                          </div>
                                                        );
                                                      },
                                                    )}
                                                  </div>
                                                </div>
                                              )}
                                          </section>
                                        )}
                                      {webDraft && apiDraft && (
                                        <div
                                          className="knowledge-source-ingestion"
                                          aria-label={`Add sources to ${knowledgeItem.name}`}
                                        >
                                          {activeKnowledgeDataTab ===
                                            "documents" && (
                                          <div className="knowledge-source-card knowledge-upload-card">
                                            <div className="knowledge-source-card-heading">
                                              <strong>Upload documents</strong>
                                              <small>
                                                Index local documents, images, audio, or
                                                video. Speech is transcribed and video
                                                stills are described even when there is
                                                no audio track.
                                              </small>
                                            </div>
                                            <label
                                              className="secondary-button knowledge-file-button"
                                                data-tooltip={`Choose local files to index into ${knowledgeItem.name}. Audio is transcribed and video stills are described first.`}
                                            >
                                              <Upload size={14} />
                                              <span>
                                                {pendingAction ===
                                                `knowledge:${knowledgeItem.id}:upload`
                                                  ? "Indexing..."
                                                  : "Upload files"}
                                              </span>
                                              <input
                                                aria-label={`Upload documents to ${knowledgeItem.name}`}
                                                type="file"
                                                multiple
                                                onChange={(event) => {
                                                  void uploadKnowledgeFiles(
                                                    knowledgeItem,
                                                    event.target.files,
                                                  );
                                                  event.currentTarget.value =
                                                    "";
                                                }}
                                                disabled={
                                                  pendingAction ===
                                                  `knowledge:${knowledgeItem.id}:upload`
                                                }
                                              />
                                            </label>
                                          </div>
                                            )}
                                          {activeKnowledgeDataTab === "web" && (
                                          <details
                                            className="knowledge-source-card knowledge-source-details"
                                            open
                                          >
                                            <summary data-tooltip="Show or hide the form for adding a web page as a source">
                                              <span>
                                                <strong>Web source</strong>
                                                <small>
                                                  URL and indexed note
                                                </small>
                                              </span>
                                            </summary>
                                            <div className="knowledge-source-details-body">
                                              <label>
                                                Name
                                                <input
                                                  value={webDraft.name}
                                                  onChange={(event) =>
                                                    updateWebSourceDraft(
                                                      knowledgeItem,
                                                      {
                                                        name: event.target
                                                          .value,
                                                      },
                                                    )
                                                  }
                                                  placeholder="Client status page"
                                                />
                                              </label>
                                              <label>
                                                URL
                                                <input
                                                  value={webDraft.url}
                                                  onChange={(event) =>
                                                    updateWebSourceDraft(
                                                      knowledgeItem,
                                                      {
                                                        url: event.target.value,
                                                      },
                                                    )
                                                  }
                                                  placeholder="https://..."
                                                />
                                              </label>
                                              <label>
                                                Indexed note
                                                <textarea
                                                  value={webDraft.text}
                                                  onChange={(event) =>
                                                    updateWebSourceDraft(
                                                      knowledgeItem,
                                                      {
                                                        text: event.target
                                                          .value,
                                                      },
                                                    )
                                                  }
                                                  placeholder="Optional source note or extracted text"
                                                />
                                              </label>
                                              <button
                                                className="secondary-button"
                                                type="button"
                                                data-tooltip={`Index this web page and note into ${knowledgeItem.name}`}
                                                onClick={() =>
                                                  void saveWebSource(
                                                    knowledgeItem,
                                                  )
                                                }
                                                disabled={
                                                  pendingAction ===
                                                  `knowledge:${knowledgeItem.id}:web-source`
                                                }
                                              >
                                                <FolderSync size={14} /> Save
                                                web source
                                              </button>
                                            </div>
                                          </details>
                                          )}
                                          {activeKnowledgeDataTab === "api" && (
                                          <details
                                            className="knowledge-source-card knowledge-source-details knowledge-api-source-details"
                                            open
                                          >
                                            <summary data-tooltip="Show or hide the form for connecting an API data source">
                                              <span>
                                                <strong>API source</strong>
                                                <small>
                                                  Endpoint metadata and auth
                                                </small>
                                              </span>
                                            </summary>
                                            <div className="knowledge-source-details-body">
                                              <label className="knowledge-api-name-field">
                                                Name
                                                <input
                                                  value={apiDraft.name}
                                                  onChange={(event) =>
                                                    updateApiSourceDraft(
                                                      knowledgeItem,
                                                      {
                                                        name: event.target
                                                          .value,
                                                      },
                                                    )
                                                  }
                                                  placeholder="Matter API"
                                                />
                                              </label>
                                              <label className="knowledge-api-wide-field knowledge-api-base-field">
                                                Base URL
                                                <input
                                                  value={apiDraft.url}
                                                  onChange={(event) =>
                                                    updateApiSourceDraft(
                                                      knowledgeItem,
                                                      {
                                                        url: event.target.value,
                                                      },
                                                    )
                                                  }
                                                  placeholder="https://api.example.com"
                                                />
                                              </label>
                                              <label className="knowledge-api-wide-field knowledge-api-source-label-field">
                                                Source label
                                                <input
                                                  value={apiDraft.sourceLabel}
                                                  onChange={(event) =>
                                                    updateApiSourceDraft(
                                                      knowledgeItem,
                                                      {
                                                        sourceLabel:
                                                          event.target.value,
                                                      },
                                                    )
                                                  }
                                                  placeholder="SharePoint Litigation Library"
                                                />
                                              </label>
                                              <label className="knowledge-api-wide-field knowledge-api-resource-field">
                                                Resource, folder, or path
                                                <input
                                                  value={apiDraft.resourceId}
                                                  onChange={(event) =>
                                                    updateApiSourceDraft(
                                                      knowledgeItem,
                                                      {
                                                        resourceId:
                                                          event.target.value,
                                                      },
                                                    )
                                                  }
                                                  placeholder="site-id, folder-id, workspace, or /matters/{id}"
                                                />
                                              </label>
                                              <label className="knowledge-api-method-field">
                                                Method
                                                <SelectControl
                                                  value={apiDraft.requestMethod}
                                                  onChange={(event) =>
                                                    updateApiSourceDraft(
                                                      knowledgeItem,
                                                      {
                                                        requestMethod:
                                                          event.target.value,
                                                      },
                                                    )
                                                  }
                                                >
                                                  <option value="GET">GET</option>
                                                  <option value="POST">POST</option>
                                                  <option value="PUT">PUT</option>
                                                  <option value="PATCH">PATCH</option>
                                                </SelectControl>
                                              </label>
                                              <label className="knowledge-api-text-field knowledge-api-header-field">
                                                Header notes
                                                <textarea
                                                  className="compact-textarea"
                                                  value={apiDraft.headerNotes}
                                                  onChange={(event) =>
                                                    updateApiSourceDraft(
                                                      knowledgeItem,
                                                      {
                                                        headerNotes:
                                                          event.target.value,
                                                      },
                                                    )
                                                  }
                                                  placeholder={"Content-Type: application/json\nDo not put secrets here"}
                                                />
                                              </label>
                                              <label className="knowledge-api-auth-type-field">
                                                Auth type
                                                <SelectControl
                                                  value={apiDraft.authType}
                                                  onChange={(event) =>
                                                    updateApiSourceDraft(
                                                      knowledgeItem,
                                                      {
                                                        authType:
                                                          event.target.value,
                                                      },
                                                    )
                                                  }
                                                >
                                                  <option value="api-key">
                                                    API key
                                                  </option>
                                                  <option value="bearer-token">
                                                    Bearer token
                                                  </option>
                                                  <option value="oauth-client">
                                                    OAuth client
                                                  </option>
                                                </SelectControl>
                                              </label>
                                              {apiDraft.authType ===
                                              "oauth-client" ? (
                                                <div className="knowledge-oauth-fields knowledge-api-auth-panel">
                                                  <label>
                                                    OAuth client ID
                                                    <input
                                                      value={apiDraft.clientId}
                                                      onChange={(event) =>
                                                        updateApiSourceDraft(
                                                          knowledgeItem,
                                                          {
                                                            clientId:
                                                              event.target
                                                                .value,
                                                          },
                                                        )
                                                      }
                                                      placeholder="client-id"
                                                    />
                                                  </label>
                                                  <label>
                                                    OAuth client secret
                                                    <input
                                                      type="password"
                                                      value={apiDraft.secret}
                                                      onChange={(event) =>
                                                        updateApiSourceDraft(
                                                          knowledgeItem,
                                                          {
                                                            secret:
                                                              event.target
                                                                .value,
                                                          },
                                                        )
                                                      }
                                                      placeholder="Stored in backend vault"
                                                    />
                                                  </label>
                                                  <label>
                                                    Authorization URL
                                                    <input
                                                      value={
                                                        apiDraft.oauthAuthorizationUrl
                                                      }
                                                      onChange={(event) =>
                                                        updateApiSourceDraft(
                                                          knowledgeItem,
                                                          {
                                                            oauthAuthorizationUrl:
                                                              event.target
                                                                .value,
                                                          },
                                                        )
                                                      }
                                                      placeholder="https://provider.example.com/oauth/authorize"
                                                    />
                                                  </label>
                                                  <label>
                                                    Token URL
                                                    <input
                                                      value={
                                                        apiDraft.oauthTokenUrl
                                                      }
                                                      onChange={(event) =>
                                                        updateApiSourceDraft(
                                                          knowledgeItem,
                                                          {
                                                            oauthTokenUrl:
                                                              event.target
                                                                .value,
                                                          },
                                                        )
                                                      }
                                                      placeholder="https://provider.example.com/oauth/token"
                                                    />
                                                  </label>
                                                  <label className="readonly-field">
                                                    Redirect URI
                                                    <input
                                                      value={knowledgeApiSourceOAuthCallbackUrl(
                                                        knowledgeItem.id,
                                                      )}
                                                      readOnly
                                                    />
                                                  </label>
                                                  <label>
                                                    Scopes
                                                    <textarea
                                                      className="compact-textarea"
                                                      value={
                                                        apiDraft.scopesText
                                                      }
                                                      onChange={(event) =>
                                                        updateApiSourceDraft(
                                                          knowledgeItem,
                                                          {
                                                            scopesText:
                                                              event.target
                                                                .value,
                                                          },
                                                        )
                                                      }
                                                      placeholder={"read:matters\nread:documents"}
                                                    />
                                                  </label>
                                                  <label>
                                                    Audience or tenant
                                                    <textarea
                                                      className="compact-textarea"
                                                      value={apiDraft.audience}
                                                      onChange={(event) =>
                                                        updateApiSourceDraft(
                                                          knowledgeItem,
                                                          {
                                                            audience:
                                                              event.target
                                                                .value,
                                                          },
                                                        )
                                                      }
                                                      placeholder={"Optional audience, tenant, or resource\nTenant IDs or resource URIs can go here"}
                                                    />
                                                  </label>
                                                </div>
                                              ) : (
                                                <div className="knowledge-auth-fields knowledge-api-auth-panel">
                                                  <label>
                                                    {apiCredentialLabel(
                                                      apiDraft.authType,
                                                    )}
                                                    <input
                                                      type="password"
                                                      value={apiDraft.secret}
                                                      onChange={(event) =>
                                                        updateApiSourceDraft(
                                                          knowledgeItem,
                                                          {
                                                            secret:
                                                              event.target
                                                                .value,
                                                          },
                                                        )
                                                      }
                                                      placeholder="Stored in backend vault"
                                                    />
                                                  </label>
                                                  {apiDraft.authType ===
                                                  "api-key" ? (
                                                    <>
                                                      <label>
                                                        Key name
                                                        <input
                                                          value={
                                                            apiDraft.apiKeyName
                                                          }
                                                          onChange={(event) =>
                                                            updateApiSourceDraft(
                                                              knowledgeItem,
                                                              {
                                                                apiKeyName:
                                                                  event.target
                                                                    .value,
                                                              },
                                                            )
                                                          }
                                                          placeholder="X-API-Key"
                                                        />
                                                      </label>
                                                      <label>
                                                        Send as
                                                        <SelectControl
                                                          value={
                                                            apiDraft.apiKeyPlacement
                                                          }
                                                          onChange={(event) =>
                                                            updateApiSourceDraft(
                                                              knowledgeItem,
                                                              {
                                                                apiKeyPlacement:
                                                                  event.target
                                                                    .value,
                                                              },
                                                            )
                                                          }
                                                        >
                                                          <option value="header">
                                                            Header
                                                          </option>
                                                          <option value="query">
                                                            Query parameter
                                                          </option>
                                                        </SelectControl>
                                                      </label>
                                                    </>
                                                  ) : (
                                                    <label className="readonly-field">
                                                      Authorization header
                                                      <input
                                                        value="Authorization: Bearer [stored token]"
                                                        readOnly
                                                      />
                                                    </label>
                                                  )}
                                                </div>
                                              )}
                                              <label className="knowledge-api-text-field knowledge-api-description-field">
                                                Indexed description
                                                <textarea
                                                  value={apiDraft.text}
                                                  onChange={(event) =>
                                                    updateApiSourceDraft(
                                                      knowledgeItem,
                                                      {
                                                        text: event.target
                                                          .value,
                                                      },
                                                    )
                                                  }
                                                />
                                              </label>
                                              <button
                                                className="secondary-button knowledge-api-save-button"
                                                type="button"
                                                data-tooltip={`Save this API connection so ${knowledgeItem.name} can index from it`}
                                                onClick={() =>
                                                  void saveApiSource(
                                                    knowledgeItem,
                                                  )
                                                }
                                                disabled={
                                                  pendingAction ===
                                                  `knowledge:${knowledgeItem.id}:api-source`
                                                }
                                              >
                                                <KeyRound size={14} /> Save API
                                                source
                                              </button>
                                            </div>
                                          </details>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                          {showToolDetails && toolDraft && (
                            <tr className="knowledge-document-row tool-config-row">
                              <td colSpan={5}>
                                <div className="tool-config-panel">
                                  <div className="knowledge-documents-header">
                                    <div>
                                      <strong>
                                        MCP and tool configuration
                                      </strong>
                                      <small>
                                        {toolItem.endpoint ??
                                          "No endpoint configured"}
                                      </small>
                                    </div>
                                  </div>
                                  <div className="tool-config-sections">
                                    <details
                                      className="tool-config-section"
                                      open
                                    >
                                      <summary data-tooltip="Show or hide the endpoint and launch settings for this tool">
                                        <span>
                                          <strong>Connection</strong>
                                          <small>
                                            {toolDraft.transport} endpoint and
                                            launch settings
                                          </small>
                                        </span>
                                      </summary>
                                      <div className="tool-config-form">
                                        <label>
                                          Name
                                          <input
                                            value={toolDraft.name}
                                            onChange={(event) =>
                                              updateToolDraft(toolItem, {
                                                name: event.target.value,
                                              })
                                            }
                                          />
                                        </label>
                                        <label>
                                          Endpoint URL
                                          <input
                                            value={toolDraft.endpoint}
                                            onChange={(event) =>
                                              updateToolDraft(toolItem, {
                                                endpoint: event.target.value,
                                              })
                                            }
                                            placeholder="mcp://server or https://..."
                                          />
                                        </label>
                                        <label>
                                          Transport
                                          <SelectControl
                                            value={toolDraft.transport}
                                            onChange={(event) =>
                                              updateToolDraft(toolItem, {
                                                transport: event.target.value,
                                              })
                                            }
                                          >
                                            <option value="stdio">stdio</option>
                                            <option value="http">http</option>
                                            <option value="sse">sse</option>
                                          </SelectControl>
                                        </label>
                                        <label>
                                          Command
                                          <input
                                            value={toolDraft.command}
                                            onChange={(event) =>
                                              updateToolDraft(toolItem, {
                                                command: event.target.value,
                                              })
                                            }
                                            placeholder="hermes"
                                          />
                                        </label>
                                        <label>
                                          Args
                                          <textarea
                                            className="compact-textarea"
                                            value={toolDraft.argsText}
                                            onChange={(event) =>
                                              updateToolDraft(toolItem, {
                                                argsText: event.target.value,
                                              })
                                            }
                                            placeholder="mcp, serve"
                                          />
                                        </label>
                                        <label>
                                          Scopes
                                          <textarea
                                            className="compact-textarea"
                                            value={toolDraft.scopesText}
                                            onChange={(event) =>
                                              updateToolDraft(toolItem, {
                                                scopesText: event.target.value,
                                              })
                                            }
                                            placeholder="mcp.invoke, knowledge.read"
                                          />
                                        </label>
                                      </div>
                                    </details>
                                    <details className="tool-config-section">
                                      <summary data-tooltip="Show or hide the credentials and OAuth settings for this tool">
                                        <span>
                                          <strong>Authentication</strong>
                                          <small>
                                            {toolDraft.authType === "none"
                                              ? "No auth configured"
                                              : toolDraft.authType}
                                          </small>
                                        </span>
                                      </summary>
                                      <div className="tool-config-form">
                                        <label>
                                          Auth mode
                                          <SelectControl
                                            value={toolDraft.authType}
                                            onChange={(event) =>
                                              updateToolDraft(toolItem, {
                                                authType: event.target.value,
                                              })
                                            }
                                          >
                                            <option value="none">None</option>
                                            <option value="bearer-token">
                                              Bearer token
                                            </option>
                                            <option value="oauth-2.1-static">
                                              OAuth 2.1 static
                                            </option>
                                          </SelectControl>
                                        </label>
                                        <label>
                                          Client ID
                                          <input
                                            value={toolDraft.clientId}
                                            onChange={(event) =>
                                              updateToolDraft(toolItem, {
                                                clientId: event.target.value,
                                              })
                                            }
                                            placeholder="OAuth client ID"
                                          />
                                        </label>
                                        <label>
                                          Client secret / token
                                          <input
                                            type="password"
                                            value={toolDraft.secret}
                                            onChange={(event) =>
                                              updateToolDraft(toolItem, {
                                                secret: event.target.value,
                                              })
                                            }
                                            placeholder="Existing secret retained"
                                          />
                                        </label>
                                        <label>
                                          Authorization URL
                                          <input
                                            value={
                                              toolDraft.oauthAuthorizationUrl
                                            }
                                            onChange={(event) =>
                                              updateToolDraft(toolItem, {
                                                oauthAuthorizationUrl:
                                                  event.target.value,
                                              })
                                            }
                                            placeholder="https://provider.example.com/oauth/authorize"
                                          />
                                        </label>
                                        <label>
                                          Token URL
                                          <input
                                            value={toolDraft.oauthTokenUrl}
                                            onChange={(event) =>
                                              updateToolDraft(toolItem, {
                                                oauthTokenUrl:
                                                  event.target.value,
                                              })
                                            }
                                            placeholder="https://provider.example.com/oauth/token"
                                          />
                                        </label>
                                        <label className="wide-field readonly-field">
                                          Callback URL
                                          <input
                                            value={toolOAuthCallbackUrl(
                                              toolItem.id,
                                            )}
                                            readOnly
                                          />
                                        </label>
                                        <div className="wide-field">
                                          {(() => {
                                            const authorizeUrl =
                                              toolOAuthAuthorizeUrl(
                                                toolItem.id,
                                                toolDraft,
                                              );
                                            return authorizeUrl ? (
                                              <a
                                                className="secondary-button compact"
                                                href={authorizeUrl}
                                                target="_blank"
                                                rel="noreferrer"
                                                data-tooltip="Open the provider's consent page to grant this tool access"
                                              >
                                                <KeyRound size={14} />{" "}
                                                Authorize with provider
                                              </a>
                                            ) : (
                                              <small className="muted-note">
                                                Save an authorization URL and
                                                client ID to enable the OAuth
                                                authorize link. Tokens returned
                                                to the callback are passed to
                                                the MCP runtime as
                                                MCP_OAUTH_ACCESS_TOKEN.
                                              </small>
                                            );
                                          })()}
                                        </div>
                                      </div>
                                    </details>
                                    <details className="tool-config-section">
                                      <summary data-tooltip="Show or hide invocation, approval, and runtime settings for this tool">
                                        <span>
                                          <strong>Runtime</strong>
                                          <small>
                                            Invocations, approval, and Hermes
                                            behavior
                                          </small>
                                        </span>
                                      </summary>
                                      <div className="tool-config-form tool-runtime-form">
                                        <fieldset className="tool-checkbox-field wide-field">
                                          <legend>Allowed groups</legend>
                                          <div className="tool-checkbox-list">
                                            {data.groups.length === 0 ? (
                                              <small className="tool-empty-copy">
                                                No synced groups are available;
                                                this tool is tenant-wide.
                                              </small>
                                            ) : (
                                              data.groups.map((group) => (
                                                <label
                                                  className="tool-checkbox-option"
                                                  key={group.id}
                                                >
                                                  <input
                                                    type="checkbox"
                                                    checked={toolDraft.allowedGroupIds.includes(
                                                      group.id,
                                                    )}
                                                    onChange={(event) =>
                                                      updateToolDraft(
                                                        toolItem,
                                                        {
                                                          allowedGroupIds:
                                                            event.target.checked
                                                              ? Array.from(
                                                                  new Set([
                                                                    ...toolDraft.allowedGroupIds,
                                                                    group.id,
                                                                  ]),
                                                                )
                                                              : toolDraft.allowedGroupIds.filter(
                                                                  (id) =>
                                                                    id !==
                                                                    group.id,
                                                                ),
                                                        },
                                                      )
                                                    }
                                                  />
                                                  <span>
                                                    <strong>
                                                      {group.name}
                                                    </strong>
                                                    <small>
                                                      {group.user_count} users
                                                      ·{" "}
                                                      {
                                                        group.distinguished_name
                                                      }
                                                    </small>
                                                  </span>
                                                </label>
                                              ))
                                            )}
                                          </div>
                                          <small className="tool-empty-copy">
                                            Leave every group unchecked to make
                                            this enabled tool available to every
                                            active user in the tenant.
                                          </small>
                                        </fieldset>
                                        <label className="wide-field">
                                          Runtime MCP invocations
                                          <textarea
                                            className="code-textarea"
                                            value={
                                              toolDraft.runtimeInvocationsText
                                            }
                                            onChange={(event) =>
                                              updateToolDraft(toolItem, {
                                                runtimeInvocationsText:
                                                  event.target.value,
                                              })
                                            }
                                            placeholder={`[{"tool_name":"lookup_matter","label":"Matter lookup","arguments":{"query":"{{query}}"}}]`}
                                          />
                                          <small className="tool-empty-copy">
                                            JSON array of{" "}
                                            {"{ tool_name, label, arguments }"}{" "}
                                            objects. Use {"{{query}}"} inside
                                            arguments to inject the caller's
                                            input.
                                          </small>
                                        </label>
                                        <div className="tool-toggle-stack">
                                          <div className="tool-runtime-toggle-row">
                                            <Toggle
                                              checked={
                                                toolDraft.approvalRequired
                                              }
                                              label="Require approval before MCP calls"
                                              tooltip="Require a human approval step before this MCP tool can run from chat, agents, or automations."
                                              onChange={(next) =>
                                                updateToolDraft(toolItem, {
                                                  approvalRequired: next,
                                                })
                                              }
                                            />
                                            <span>
                                              <strong>
                                                Require approval before MCP calls
                                              </strong>
                                              <small>
                                                Pauses each invocation until an
                                                authorized user approves the
                                                tool run.
                                              </small>
                                            </span>
                                          </div>
                                          <div className="tool-runtime-toggle-row">
                                            <Toggle
                                              checked={
                                                toolDraft.hermesCompanion
                                              }
                                              label="Expose as Hermes companion"
                                              tooltip="Expose this MCP tool to Hermes-style agent companion runs in addition to normal chat tool use."
                                              onChange={(next) =>
                                                updateToolDraft(toolItem, {
                                                  hermesCompanion: next,
                                                })
                                              }
                                            />
                                            <span>
                                              <strong>
                                                Expose as Hermes companion
                                              </strong>
                                              <small>
                                                Makes this server available to
                                                Hermes companion workflows that
                                                coordinate multi-step agent
                                                work.
                                              </small>
                                            </span>
                                          </div>
                                        </div>
                                        <div className="tool-section-actions">
                                          <button
                                            className="secondary-button"
                                            type="button"
                                            data-tooltip={
                                              toolDraft.transport === "stdio"
                                                ? `Check the saved ${toolItem.name} command and list the tools it offers`
                                                : `Connect to the saved ${toolItem.name} ${toolDraft.transport.toUpperCase()} endpoint and list the tools it offers`
                                            }
                                            onClick={() =>
                                              void runToolHealthCheck(toolItem)
                                            }
                                            disabled={
                                              pendingAction ===
                                              `tool:${toolItem.id}:health`
                                            }
                                          >
                                            <PlugZap size={15} />{" "}
                                            {pendingAction ===
                                            `tool:${toolItem.id}:health`
                                              ? "Testing..."
                                              : "Test saved MCP"}
                                          </button>
                                          <button
                                            className="secondary-button"
                                            type="button"
                                            data-tooltip={`Run the first saved runtime invocation against ${toolItem.name}`}
                                            onClick={() =>
                                              void runToolRuntimeCall(toolItem)
                                            }
                                            disabled={
                                              pendingAction ===
                                              `tool:${toolItem.id}:call`
                                            }
                                          >
                                            <Bot size={15} />{" "}
                                            {pendingAction ===
                                            `tool:${toolItem.id}:call`
                                              ? "Running..."
                                              : "Run saved MCP call"}
                                          </button>
                                        </div>
                                        <small className="tool-empty-copy wide-field">
                                          MCP tests run against the last saved
                                          configuration. Save this tool before
                                          testing changes to transport, command,
                                          args, auth, or runtime invocations.
                                        </small>
                                      </div>
                                    </details>
                                    <div className="tool-config-actions">
                                      <button
                                        className="danger-button"
                                        type="button"
                                        data-tooltip={`Permanently remove ${toolItem.name} and its configuration`}
                                        onClick={() =>
                                          void deleteTool(toolItem)
                                        }
                                        disabled={
                                          pendingAction ===
                                          `tool:${toolItem.id}:delete`
                                        }
                                      >
                                        <Trash2 size={15} />{" "}
                                        {pendingAction ===
                                        `tool:${toolItem.id}:delete`
                                          ? "Deleting..."
                                          : "Delete tool"}
                                      </button>
                                      <button
                                        className="primary-button form-submit-button"
                                        type="button"
                                        data-tooltip={`Save the connection, auth, and runtime settings for ${toolItem.name}`}
                                        onClick={() =>
                                          void saveToolDetails(toolItem)
                                        }
                                        disabled={
                                          pendingAction ===
                                          `tool:${toolItem.id}:details`
                                        }
                                      >
                                        <Save size={15} />{" "}
                                        <StableLabel
                                          label={
                                            pendingAction ===
                                            `tool:${toolItem.id}:details`
                                              ? "Saving..."
                                              : "Save tool"
                                          }
                                          reserve={["Saving...", "Save tool"]}
                                        />
                                      </button>
                                    </div>
                                    {toolHealth && (
                                      <div
                                        className={`mcp-health-result is-${toolHealth.status}`}
                                      >
                                        <div>
                                          <strong>
                                            {toolHealth.status === "ready"
                                              ? "MCP server responded"
                                              : "MCP check result"}
                                          </strong>
                                          <small>{toolHealth.message}</small>
                                        </div>
                                        {Object.keys(
                                          toolHealth.server_info ?? {},
                                        ).length > 0 && (
                                          <small>
                                            Server:{" "}
                                            {compactJson(
                                              toolHealth.server_info,
                                            )}
                                          </small>
                                        )}
                                        {(toolHealth.tools ?? []).length >
                                          0 && (
                                          <div className="mcp-tool-list">
                                            {(toolHealth.tools ?? []).map(
                                              (tool) => (
                                                <span key={tool.name}>
                                                  {tool.name}
                                                </span>
                                              ),
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                    {toolCall && (
                                      <div
                                        className={`mcp-health-result is-${toolCall.status}`}
                                      >
                                        <div>
                                          <strong>
                                            {toolCall.label ||
                                              toolCall.tool_name}
                                          </strong>
                                          <small>{toolCall.message}</small>
                                        </div>
                                        {toolCall.result_text && (
                                          <small>{toolCall.result_text}</small>
                                        )}
                                        {toolCall.structured_content !==
                                          undefined &&
                                          toolCall.structured_content !==
                                            null && (
                                            <small>
                                              Structured:{" "}
                                              {compactJson(
                                                toolCall.structured_content,
                                              )}
                                            </small>
                                          )}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                    {(isKnowledge ? knowledgeRows : toolRows).length === 0 && (
                      <tr>
                        <td className="table-empty-cell" colSpan={5}>
                          {isKnowledge
                            ? "No knowledge bases yet. Add Knowledge Base creates a searchable collection for chat."
                            : "No connections yet. Add Tool registers an MCP connection for models and agents."}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}

function replaceKnowledgeBase(
  data: BootstrapData,
  id: string,
  patch: Partial<KnowledgeBase>,
): BootstrapData {
  return {
    ...data,
    knowledgeBases: data.knowledgeBases.map((kb) =>
      kb.id === id ? { ...kb, ...patch } : kb,
    ),
  };
}

function toolSecuritySummary(tool: ToolConfig, data: BootstrapData): string {
  const approval = tool.approval_required
    ? "Approval required"
    : "No approval required";
  const allowedGroupIds = tool.allowed_group_ids ?? [];
  if (!allowedGroupIds.length) {
    return `${approval} · All tenant users`;
  }
  const groupNames = allowedGroupIds.map(
    (groupId) =>
      data.groups.find((group) => group.id === groupId)?.name ?? groupId,
  );
  return `${approval} · Groups: ${groupNames.join(", ")}`;
}

function summarizeKnowledgeDocuments(
  documents: KnowledgeDocument[] | undefined,
  item: KnowledgeBase,
) {
  return {
    documentCount: documents?.length ?? item.document_count,
    chunkCount: documents ? totalKnowledgeChunks(documents) : null,
  };
}

function totalKnowledgeChunks(documents: KnowledgeDocument[]): number {
  return documents.reduce((total, document) => total + document.chunk_count, 0);
}

function omitRecordKey<T>(
  record: Record<string, T>,
  key: string,
): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function omitRecordKeys<T>(
  record: Record<string, T>,
  keys: Set<string>,
): Record<string, T> {
  const next = { ...record };
  keys.forEach((key) => {
    delete next[key];
  });
  return next;
}

function replaceTool(
  data: BootstrapData,
  id: string,
  patch: Partial<ToolConfig>,
): BootstrapData {
  return {
    ...data,
    tools: data.tools.map((tool) =>
      tool.id === id ? { ...tool, ...patch } : tool,
    ),
  };
}

function emptyKnowledgeSourceDraft(): KnowledgeSourceDraft {
  return {
    name: "",
    url: "",
    text: "",
    authType: "api-key",
    secret: "",
    sourceLabel: "",
    resourceId: "",
    requestMethod: "GET",
    headerNotes: "",
    apiKeyName: "X-API-Key",
    apiKeyPlacement: "header",
    clientId: "",
    oauthAuthorizationUrl: "",
    oauthTokenUrl: "",
    scopesText: "",
    audience: "",
  };
}

function toolDraftFromConfig(
  tool: ToolConfig,
  data?: BootstrapData,
): ToolDraft {
  return {
    name: tool.name,
    endpoint: tool.endpoint ?? "",
    transport: tool.transport ?? (tool.type === "mcp" ? "stdio" : "http"),
    authType: tool.auth_type ?? "none",
    clientId: tool.client_id ?? "",
    oauthAuthorizationUrl: tool.oauth_authorization_url ?? "",
    oauthTokenUrl: tool.oauth_token_url ?? "",
    command: tool.command ?? "",
    argsText: (tool.args ?? []).join(", "),
    scopesText: tool.scopes.join(", "),
    runtimeInvocationsText: JSON.stringify(
      tool.runtime_invocations ?? [],
      null,
      2,
    ),
    secret: "",
    approvalRequired: tool.approval_required,
    hermesCompanion: Boolean(tool.hermes_companion),
    allowedGroupIds: tool.allowed_group_ids ?? [],
  };
}

function parseDelimitedList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function parseRuntimeInvocationsJson(value: string): McpRuntimeInvocation[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Runtime invocations must be a JSON array.");
  }
  return parsed.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`Runtime invocation ${index + 1} must be an object.`);
    }
    const record = item as Record<string, unknown>;
    const toolName =
      typeof record.tool_name === "string" ? record.tool_name.trim() : "";
    if (!toolName) {
      throw new Error(`Runtime invocation ${index + 1} requires tool_name.`);
    }
    const rawArguments = record.arguments;
    if (
      rawArguments !== undefined &&
      (typeof rawArguments !== "object" ||
        rawArguments === null ||
        Array.isArray(rawArguments))
    ) {
      throw new Error(
        `Runtime invocation ${index + 1} arguments must be an object.`,
      );
    }
    return {
      tool_name: toolName,
      label:
        typeof record.label === "string" && record.label.trim()
          ? record.label.trim()
          : null,
      arguments: (rawArguments as Record<string, unknown> | undefined) ?? {},
    };
  });
}

function substituteRuntimeInvocationArguments(
  value: Record<string, unknown>,
  substitutions: Record<string, string>,
): Record<string, unknown> {
  const substituted = substituteRuntimeInvocationValue(value, substitutions);
  return typeof substituted === "object" &&
    substituted !== null &&
    !Array.isArray(substituted)
    ? (substituted as Record<string, unknown>)
    : {};
}

function substituteRuntimeInvocationValue(
  value: unknown,
  substitutions: Record<string, string>,
): unknown {
  if (typeof value === "string") {
    return Object.entries(substitutions).reduce(
      (result, [key, replacement]) =>
        result.replaceAll(`{{${key}}}`, replacement),
      value,
    );
  }
  if (Array.isArray(value))
    return value.map((item) =>
      substituteRuntimeInvocationValue(item, substitutions),
    );
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        substituteRuntimeInvocationValue(item, substitutions),
      ]),
    );
  }
  return value;
}

function connectorConfigForKnowledge(
  data: BootstrapData,
  item: KnowledgeBase,
): ConnectorConfigRecord | undefined {
  if (item.connector_config_id) {
    const directConfig = data.connectorConfigs.find(
      (config) => config.id === item.connector_config_id,
    );
    if (directConfig) return directConfig;
  }
  const connector = data.connectors.find(
    (candidate) => candidate.id === item.connector_id,
  );
  if (connector?.tenant_config_id) {
    const connectorConfig = data.connectorConfigs.find(
      (config) => config.id === connector.tenant_config_id,
    );
    if (connectorConfig) return connectorConfig;
  }
  return data.connectorConfigs.find(
    (config) => config.connector_id === item.connector_id,
  );
}

type KnowledgeCreateSourceOption = {
  value: string;
  label: string;
  helper: string;
  defaultName: string;
  defaultSource: string;
  defaultDescription: string;
};

const KNOWLEDGE_UPLOAD_MAX_BYTES = 250 * 1024 * 1024;
const KNOWLEDGE_DOCUMENT_EXTENSIONS = [
  ".bmp",
  ".csv",
  ".docx",
  ".eml",
  ".gif",
  ".htm",
  ".html",
  ".jpeg",
  ".jpg",
  ".json",
  ".log",
  ".md",
  ".pdf",
  ".png",
  ".rtf",
  ".tif",
  ".tiff",
  ".txt",
  ".webp",
  ".xml",
] as const;
const KNOWLEDGE_UPLOAD_EXTENSIONS = [
  ...KNOWLEDGE_DOCUMENT_EXTENSIONS,
  ...MEDIA_UPLOAD_EXTENSIONS,
] as const;
const KNOWLEDGE_UPLOAD_ACCEPT = KNOWLEDGE_UPLOAD_EXTENSIONS.join(",");

const KNOWLEDGE_CREATE_SOURCES: KnowledgeCreateSourceOption[] = [
  {
    value: "upload",
    label: "Document uploads",
    helper: "Upload files from your computer, including audio and video.",
    defaultName: "Uploaded Document Knowledge Base",
    defaultSource: "Manual document uploads",
    defaultDescription:
      "Uploaded files indexed directly into the vector knowledge API.",
  },
  {
    value: "web",
    label: "Web links",
    helper: "Add pages by URL.",
    defaultName: "Web Source Knowledge Base",
    defaultSource: "Curated web sources",
    defaultDescription:
      "Web URLs and extracted notes indexed into the vector knowledge API.",
  },
  {
    value: "api",
    label: "API",
    helper: "Connect a structured data endpoint.",
    defaultName: "API Knowledge Base",
    defaultSource: "External API source",
    defaultDescription:
      "API source records with stored auth metadata and indexed descriptions.",
  },
];

function createDefaultKnowledgeCreateDraft(): KnowledgeCreateDraft {
  const source = KNOWLEDGE_CREATE_SOURCES[0];
  return {
    name: source.defaultName,
    sourceType: source.value,
    ownerGroupId: "",
  };
}

function isSupportedKnowledgeUpload(file: File): boolean {
  const lowerName = file.name.toLowerCase();
  const supportedType =
    KNOWLEDGE_UPLOAD_EXTENSIONS.some((extension) =>
      lowerName.endsWith(extension),
    ) || file.type.startsWith("text/");
  return supportedType && file.size <= KNOWLEDGE_UPLOAD_MAX_BYTES;
}

function formatKnowledgeFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** unitIndex;
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${
    units[unitIndex]
  }`;
}

function knowledgeDataTabForCreateSource(
  source: KnowledgeCreateSourceOption,
): KnowledgeDataTab {
  if (source.value === "web") return "web";
  if (source.value === "api") return "api";
  return "documents";
}

function knowledgeCreateActionSummary(
  source: KnowledgeCreateSourceOption,
): string {
  if (source.value === "upload") {
    return "The selected files and access settings will be saved together.";
  }
  if (source.value === "web") {
    return "The web link will be indexed as soon as the knowledge base is created.";
  }
  if (source.value === "api") {
    return "The connection will be stored securely with this knowledge base.";
  }
  return "The selected data source will be linked to this knowledge base.";
}

function knowledgeCreateSourceOption(
  sourceType: string,
): KnowledgeCreateSourceOption {
  return (
    KNOWLEDGE_CREATE_SOURCES.find((source) => source.value === sourceType) ??
    KNOWLEDGE_CREATE_SOURCES[0]
  );
}

function knowledgeAclLabel(data: BootstrapData, groupId: string): string {
  if (!groupId) return "Only me";
  const group = data.groups.find((item) => item.id === groupId);
  return group ? `Groups: ${group.name}` : `Groups: ${groupId}`;
}

const KNOWLEDGE_CONNECTOR_PROFILES: Record<string, KnowledgeConnectorProfile> =
  {
    "google-drive": {
      rootSettingKeys: [
        "folder_id",
        "drive_folder_id",
        "root_folder_id",
        "source_root_id",
      ],
      labelSettingKeys: ["root_folder", "drive_folder", "source_label"],
    },
    "microsoft-graph": {
      rootSettingKeys: [
        "drive_item_id",
        "folder_id",
        "site_id",
        "source_root_id",
      ],
      labelSettingKeys: ["library_label", "root_folder", "source_label"],
    },
    box: {
      rootSettingKeys: ["folder_id", "root_folder_id", "source_root_id"],
      labelSettingKeys: ["root_folder", "source_label"],
    },
    imanage: {
      rootSettingKeys: ["workspace_id", "cabinet_id", "source_root_id"],
      labelSettingKeys: ["workspace_label", "workspace_name", "source_label"],
    },
  };

function connectorSetting(
  config: ConnectorConfigRecord | undefined,
  key: string,
): string | undefined {
  const value = config?.settings[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function firstConnectorSetting(
  config: ConnectorConfigRecord | undefined,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = connectorSetting(config, key);
    if (value) return value;
  }
  return undefined;
}

function formatAppError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error.";
}

function apiCredentialLabel(authType: string) {
  if (authType === "bearer-token") return "Bearer token";
  if (authType === "api-key") return "API key";
  return "Credential";
}

function compactJson(value: unknown): string {
  if (typeof value !== "object" || value === null) return String(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  return Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => `${key}: ${String(entry)}`)
    .join(", ");
}
