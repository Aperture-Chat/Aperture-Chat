import * as Tabs from "@radix-ui/react-tabs";
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  Cloud,
  FileText,
  Globe,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import { OverflowMenu } from "./AgentWorkspaceConsole";
import { StableLabel, Toggle } from "./Primitives";
import { SelectControl } from "./SelectControl";
import { MEDIA_UPLOAD_EXTENSIONS } from "../lib/mediaUploads";
import {
  addKnowledgeApiSource,
  addKnowledgeWebSource,
  createAdminKnowledgeConfig,
  deleteAdminKnowledgeConfig,
  deleteKnowledgeDocument,
  getKnowledgeIndexStatus,
  getKnowledgeLimits,
  getKnowledgeOAuthAuthorizeUrl,
  knowledgeApiSourceOAuthCallbackUrl,
  listKnowledgeDocuments,
  mapKnowledgeConfigRecordToKnowledgeBase,
  syncKnowledgeBase,
  updateAdminKnowledgeConfig,
  uploadKnowledgeFile,
  type KnowledgeApiSourcePayload,
  type KnowledgeLimits,
} from "../lib/api";
import type {
  BootstrapData,
  KnowledgeBase,
  KnowledgeDocument,
  KnowledgeIndexStatus,
  KnowledgeSyncResult,
} from "../lib/types";

type Notice = { tone: "success" | "warning" | "danger"; message: string };
type Filter = "all" | "ready" | "attention" | "off";
type DetailTab = "files" | "web" | "api" | "settings";
type StartWith = "files" | "web" | "api";
type UploadState = "queued" | "uploading" | "processing" | "done" | "error" | "cancelled";
type UploadItem = {
  id: string;
  knowledgeId: string;
  file: File;
  state: UploadState;
  progress: number;
  message?: string;
};
type Health = { label: string; tone: "ok" | "warn" | "danger" | "muted" };

const CONNECTOR_TYPES = new Set(["box", "microsoft-graph", "google-drive", "imanage"]);
/** Files the indexer can read; everything else would only be searchable by name. */
const KNOWLEDGE_FILE_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".eml",
  ".msg",
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".xml",
  ".log",
  ".rtf",
  ".htm",
  ".html",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
  ".webp",
  ...MEDIA_UPLOAD_EXTENSIONS,
] as const;
const KNOWLEDGE_FILE_ACCEPT = KNOWLEDGE_FILE_EXTENSIONS.join(",");
const LEGACY_OFFICE = new Set([".doc", ".xls", ".ppt"]);
const PARALLEL_UPLOADS = 2;
const INDEX_POLL_MS = 3000;

/** Library > Knowledge: knowledge bases as cards, each with a focused detail view. */
export function KnowledgeLibrary({
  data,
  onDataChange,
}: {
  data: BootstrapData;
  onDataChange: (updater: (current: BootstrapData) => BootstrapData) => void;
}) {
  const userId = data.me.id;
  const canConfigure = data.me.role === "TENANT_ADMIN" || data.me.role === "PLATFORM_OWNER";
  // Tenant policy grants let standard users author private, self-owned
  // knowledge bases; the server enforces the same grants and ownership.
  const canCreate = canConfigure || Boolean(data.authoringState?.knowledge_enabled);
  const canManage = useCallback(
    (item: KnowledgeBase) => canConfigure || (canCreate && item.owner_user_id === userId),
    [canConfigure, canCreate, userId],
  );
  const mappingContext = useMemo(
    () => ({
      connectors: data.connectors,
      connectorConfigs: data.connectorConfigs,
      groups: data.groups,
      users: data.visibleUsers ?? data.users,
    }),
    [data.connectorConfigs, data.connectors, data.groups, data.users, data.visibleUsers],
  );

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("files");
  const [creating, setCreating] = useState<StartWith | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [documents, setDocuments] = useState<Record<string, KnowledgeDocument[]>>({});
  const [documentErrors, setDocumentErrors] = useState<Record<string, string>>({});
  const [indexStatus, setIndexStatus] = useState<Record<string, KnowledgeIndexStatus>>({});
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [limits, setLimits] = useState<KnowledgeLimits | null>(null);
  const uploadControllers = useRef(new Map<string, AbortController>());

  const knowledgeBases = data.knowledgeBases;
  const openBase = knowledgeBases.find((item) => item.id === openId) ?? null;

  useEffect(() => {
    if (!notice || notice.tone === "danger") return;
    const timeout = window.setTimeout(() => setNotice(null), 12_000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    const controller = new AbortController();
    getKnowledgeLimits(userId, { signal: controller.signal })
      .then(setLimits)
      .catch(() => setLimits(null));
    return () => controller.abort();
  }, [userId]);

  // A knowledge base deleted elsewhere closes its detail view.
  useEffect(() => {
    if (openId && !openBase) setOpenId(null);
  }, [openBase, openId]);

  const replaceBase = useCallback(
    (id: string, next: Partial<KnowledgeBase>) =>
      onDataChange((current) => ({
        ...current,
        knowledgeBases: current.knowledgeBases.map((item) => (item.id === id ? { ...item, ...next } : item)),
      })),
    [onDataChange],
  );

  const applySyncResult = useCallback(
    (id: string, result: KnowledgeSyncResult) => {
      const saved = mapKnowledgeConfigRecordToKnowledgeBase(result.config, mappingContext);
      setDocuments((current) => ({ ...current, [id]: result.documents }));
      setDocumentErrors((current) => omitKey(current, id));
      onDataChange((current) => ({
        ...current,
        knowledgeBases: current.knowledgeBases.map((item) => (item.id === id ? saved : item)),
      }));
    },
    [mappingContext, onDataChange],
  );

  const refreshIndexStatus = useCallback(
    async (id: string) => {
      try {
        const status = await getKnowledgeIndexStatus(userId, id);
        setIndexStatus((current) => ({ ...current, [id]: status }));
      } catch {
        // Status is informational; a failed poll leaves the last known value.
      }
    },
    [userId],
  );

  const loadDocuments = useCallback(
    async (id: string) => {
      setDocumentErrors((current) => omitKey(current, id));
      try {
        const list = await listKnowledgeDocuments(userId, id);
        setDocuments((current) => ({ ...current, [id]: list }));
      } catch (error) {
        setDocumentErrors((current) => ({ ...current, [id]: errorText(error) }));
      }
    },
    [userId],
  );

  function openDetail(item: KnowledgeBase, tab?: DetailTab) {
    setOpenId(item.id);
    setDetailTab(tab ?? defaultTab(item));
    setOpenMenu(null);
    void loadDocuments(item.id);
    void refreshIndexStatus(item.id);
  }

  // Poll semantic indexing while the open knowledge base still has pending
  // passages; stop as soon as it is complete or the view closes.
  const openPending = openId ? indexStatus[openId]?.pending_chunks ?? 0 : 0;
  useEffect(() => {
    if (!openId || openPending <= 0) return;
    const interval = window.setInterval(() => void refreshIndexStatus(openId), INDEX_POLL_MS);
    return () => window.clearInterval(interval);
  }, [openId, openPending, refreshIndexStatus]);

  // ---------------------------------------------------------------- uploads

  const activeUploads = uploads.filter((item) => item.state === "uploading" || item.state === "processing");
  useEffect(() => {
    if (!activeUploads.length) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [activeUploads.length]);

  const patchUpload = useCallback((id: string, patch: Partial<UploadItem>) => {
    setUploads((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const runUpload = useCallback(
    async (item: UploadItem) => {
      const controller = new AbortController();
      uploadControllers.current.set(item.id, controller);
      patchUpload(item.id, { state: "uploading", progress: 0, message: undefined });
      try {
        const result = await uploadKnowledgeFile(userId, item.knowledgeId, item.file, {
          signal: controller.signal,
          onUploadProgress: (fraction) =>
            patchUpload(item.id, fraction >= 1 ? { progress: 1, state: "processing" } : { progress: fraction }),
        });
        applySyncResult(item.knowledgeId, result);
        patchUpload(item.id, {
          state: "done",
          progress: 1,
          message: singleUploadSummary(result.provider_message),
        });
        void refreshIndexStatus(item.knowledgeId);
      } catch (error) {
        patchUpload(item.id, {
          state: controller.signal.aborted ? "cancelled" : "error",
          message: controller.signal.aborted ? "Cancelled" : errorText(error),
        });
      } finally {
        uploadControllers.current.delete(item.id);
      }
    },
    [applySyncResult, patchUpload, refreshIndexStatus, userId],
  );

  // Start queued uploads, a couple at a time, as slots free up.
  useEffect(() => {
    const running = uploads.filter((item) => item.state === "uploading" || item.state === "processing").length;
    const slots = PARALLEL_UPLOADS - running;
    if (slots <= 0) return;
    uploads
      .filter((item) => item.state === "queued")
      .slice(0, slots)
      .forEach((item) => void runUpload(item));
  }, [runUpload, uploads]);

  function queueFiles(item: KnowledgeBase, files: File[]) {
    const skipped: string[] = [];
    const maxBytes = (limits?.upload_max_mb ?? Number.POSITIVE_INFINITY) * 1024 * 1024;
    const accepted = files.filter((file) => {
      const extension = extensionOf(file.name);
      if (LEGACY_OFFICE.has(extension)) {
        skipped.push(`${file.name} (save it as ${extension}x first)`);
        return false;
      }
      if (!isReadableKnowledgeFile(file)) {
        skipped.push(`${file.name} (unsupported type)`);
        return false;
      }
      if (file.size > maxBytes) {
        skipped.push(`${file.name} (larger than ${limits?.upload_max_mb} MB)`);
        return false;
      }
      return true;
    });
    if (accepted.length) {
      setUploads((current) => [
        ...current,
        ...accepted.map((file) => ({
          id: `${item.id}:${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`,
          knowledgeId: item.id,
          file,
          state: "queued" as const,
          progress: 0,
        })),
      ]);
    }
    if (skipped.length) {
      setNotice({
        tone: "warning",
        message: `Skipped ${skipped.length} file${skipped.length === 1 ? "" : "s"}: ${skipped.join(", ")}.`,
      });
    }
  }

  function cancelUpload(id: string) {
    const controller = uploadControllers.current.get(id);
    if (controller) {
      controller.abort();
      return;
    }
    patchUpload(id, { state: "cancelled", message: "Cancelled" });
  }

  function retryUpload(id: string) {
    patchUpload(id, { state: "queued", progress: 0, message: undefined });
  }

  function clearFinishedUploads(knowledgeId: string) {
    setUploads((current) =>
      current.filter(
        (item) => item.knowledgeId !== knowledgeId || item.state === "queued" || item.state === "uploading" || item.state === "processing",
      ),
    );
  }

  // --------------------------------------------------------------- actions

  async function setEnabled(item: KnowledgeBase, enabled: boolean) {
    setPending(`enable:${item.id}`);
    replaceBase(item.id, { enabled });
    try {
      // Only the switch changes; status and last-sync time stay as they are.
      const record = await updateAdminKnowledgeConfig(userId, item.id, { enabled });
      replaceBase(item.id, mapKnowledgeConfigRecordToKnowledgeBase(record, mappingContext));
      setNotice({
        tone: "success",
        message: enabled
          ? `${item.name} is on. Assistants can search it again.`
          : `${item.name} is off. Assistants won't search it until you turn it back on.`,
      });
    } catch (error) {
      replaceBase(item.id, { enabled: item.enabled });
      setNotice({ tone: "danger", message: `${item.name} was not changed: ${errorText(error)}` });
    } finally {
      setPending(null);
    }
  }

  async function syncBase(item: KnowledgeBase) {
    setPending(`sync:${item.id}`);
    try {
      const result = await syncKnowledgeBase(userId, item.id);
      applySyncResult(item.id, result);
      const failed = result.provider_status === "error" || result.status === "error";
      setNotice({
        tone: failed ? "warning" : "success",
        message: result.provider_message ?? `${item.name} is up to date.`,
      });
      void refreshIndexStatus(item.id);
    } catch (error) {
      setNotice({ tone: "danger", message: `${item.name} could not sync: ${errorText(error)}` });
    } finally {
      setPending(null);
    }
  }

  async function deleteBase(item: KnowledgeBase) {
    const confirmed = window.confirm(
      `Delete ${item.name}? Its documents and search index are removed, and agents stop using it.`,
    );
    if (!confirmed) return;
    setPending(`delete:${item.id}`);
    try {
      await deleteAdminKnowledgeConfig(userId, item.id);
      removeBasesFromData(onDataChange, new Set([item.id]));
      setDocuments((current) => omitKey(current, item.id));
      setUploads((current) => current.filter((upload) => upload.knowledgeId !== item.id));
      if (openId === item.id) setOpenId(null);
      setNotice({ tone: "success", message: `${item.name} was deleted.` });
    } catch (error) {
      setNotice({ tone: "danger", message: `${item.name} was not deleted: ${errorText(error)}` });
    } finally {
      setPending(null);
    }
  }

  async function deleteAllBases() {
    const count = knowledgeBases.length;
    if (!count) return;
    const confirmed = window.confirm(
      `Delete all ${count} knowledge base${count === 1 ? "" : "s"}? Every document and search index is removed, and agents stop using them. This can't be undone.`,
    );
    if (!confirmed) return;
    setPending("delete-all");
    const deleted = new Set<string>();
    const failures: string[] = [];
    for (const item of knowledgeBases) {
      try {
        await deleteAdminKnowledgeConfig(userId, item.id);
        deleted.add(item.id);
      } catch (error) {
        failures.push(`${item.name}: ${errorText(error)}`);
      }
    }
    removeBasesFromData(onDataChange, deleted);
    setOpenId(null);
    setPending(null);
    setNotice(
      failures.length
        ? { tone: "danger", message: `Deleted ${deleted.size}. Not deleted: ${failures.join("; ")}` }
        : { tone: "success", message: `Deleted ${deleted.size} knowledge base${deleted.size === 1 ? "" : "s"}.` },
    );
  }

  async function removeDocument(item: KnowledgeBase, document: KnowledgeDocument) {
    const confirmed = window.confirm(`Remove ${document.name} from ${item.name}? Its passages are deleted from search.`);
    if (!confirmed) return;
    setPending(`document:${document.id}`);
    try {
      const result = await deleteKnowledgeDocument(userId, item.id, document.id);
      applySyncResult(item.id, result);
      setNotice({ tone: "success", message: `${document.name} was removed from ${item.name}.` });
      void refreshIndexStatus(item.id);
    } catch (error) {
      setNotice({ tone: "danger", message: `${document.name} was not removed: ${errorText(error)}` });
    } finally {
      setPending(null);
    }
  }

  async function createBase(draft: CreateDraft): Promise<boolean> {
    const name = draft.name.trim();
    if (!name) {
      setNotice({ tone: "warning", message: "Give the knowledge base a name." });
      return false;
    }
    setPending("create");
    try {
      const record = await createAdminKnowledgeConfig(userId, {
        id: `knowledge-${draft.startWith}-${Date.now()}`,
        name,
        source_type: draft.startWith === "files" ? "upload" : draft.startWith,
        connector_config_id: null,
        enabled: true,
        acl_group_ids: draft.groupIds,
        owner_user_id: userId,
        settings: {
          description: draft.description.trim() || START_OPTIONS[draft.startWith].description,
          source: START_OPTIONS[draft.startWith].source,
          status: "draft",
          document_count: 0,
          last_sync: "Not synced",
        },
      });
      const saved = mapKnowledgeConfigRecordToKnowledgeBase(record, mappingContext);
      onDataChange((current) => ({ ...current, knowledgeBases: [...current.knowledgeBases, saved] }));
      setDocuments((current) => ({ ...current, [saved.id]: [] }));
      setCreating(null);
      setOpenId(saved.id);
      setDetailTab(draft.startWith);
      void refreshIndexStatus(saved.id);
      setNotice({
        tone: "success",
        message: `${saved.name} was created. ${START_OPTIONS[draft.startWith].next}`,
      });
      return true;
    } catch (error) {
      setNotice({ tone: "danger", message: `The knowledge base was not created: ${errorText(error)}` });
      return false;
    } finally {
      setPending(null);
    }
  }

  async function saveSettings(item: KnowledgeBase, patch: { name: string; groupIds: string[] }) {
    const name = patch.name.trim();
    if (!name) {
      setNotice({ tone: "warning", message: "The name can't be empty." });
      return;
    }
    setPending(`settings:${item.id}`);
    try {
      const record = await updateAdminKnowledgeConfig(userId, item.id, {
        name,
        ...(canConfigure ? { acl_group_ids: patch.groupIds } : {}),
      });
      replaceBase(item.id, mapKnowledgeConfigRecordToKnowledgeBase(record, mappingContext));
      setNotice({ tone: "success", message: `${name} settings saved.` });
    } catch (error) {
      setNotice({ tone: "danger", message: `Settings were not saved: ${errorText(error)}` });
    } finally {
      setPending(null);
    }
  }

  async function addWebPage(item: KnowledgeBase, draft: { url: string; name: string; text: string }) {
    if (!draft.url.trim()) {
      setNotice({ tone: "warning", message: "Enter the page address." });
      return false;
    }
    setPending(`web:${item.id}`);
    try {
      const result = await addKnowledgeWebSource(userId, item.id, {
        name: draft.name.trim() || draft.url.trim(),
        url: draft.url.trim(),
        text: draft.text.trim() || null,
      });
      applySyncResult(item.id, result);
      setNotice({ tone: "success", message: result.provider_message ?? "The page was added." });
      void refreshIndexStatus(item.id);
      return true;
    } catch (error) {
      setNotice({ tone: "danger", message: `The page was not added: ${errorText(error)}` });
      return false;
    } finally {
      setPending(null);
    }
  }

  async function addApi(item: KnowledgeBase, payload: KnowledgeApiSourcePayload) {
    if (!payload.base_url.trim()) {
      setNotice({ tone: "warning", message: "Enter the API address." });
      return false;
    }
    // Open the sign-in window while this click still counts as a user action;
    // browsers block pop-ups opened after a network round-trip.
    const popup = payload.auth_type === "oauth-client" ? openSignInWindow() : null;
    setPending(`api:${item.id}`);
    try {
      const result = await addKnowledgeApiSource(userId, item.id, payload);
      applySyncResult(item.id, result);
      const waiting = result.provider_status === "pending";
      setNotice({
        tone: waiting ? "warning" : "success",
        message: result.provider_message ?? "The API was connected.",
      });
      if (waiting) void authorizeApi(item, popup);
      else popup?.close();
      void refreshIndexStatus(item.id);
      return true;
    } catch (error) {
      popup?.close();
      setNotice({ tone: "danger", message: `The API was not connected: ${errorText(error)}` });
      return false;
    } finally {
      setPending(null);
    }
  }

  async function authorizeApi(item: KnowledgeBase, openedWindow?: Window | null) {
    const popup = openedWindow ?? openSignInWindow();
    if (!popup) {
      setNotice({
        tone: "warning",
        message: "Your browser blocked the sign-in window. Allow pop-ups for this site and try again.",
      });
      return;
    }
    setPending(`authorize:${item.id}`);
    try {
      const { authorize_url } = await getKnowledgeOAuthAuthorizeUrl(userId, item.id);
      popup.location.href = authorize_url;
      // The callback page indexes the API and closes itself; reload afterwards.
      const started = Date.now();
      const timer = window.setInterval(() => {
        if (popup.closed || Date.now() - started > 10 * 60_000) {
          window.clearInterval(timer);
          void loadDocuments(item.id);
          void refreshIndexStatus(item.id);
          void reloadBase(item.id);
        }
      }, 1000);
    } catch (error) {
      popup.close();
      setNotice({ tone: "danger", message: `Sign-in could not start: ${errorText(error)}` });
    } finally {
      setPending(null);
    }
  }

  async function reloadBase(id: string) {
    try {
      const list = await listKnowledgeDocuments(userId, id);
      setDocuments((current) => ({ ...current, [id]: list }));
      // Sync with nothing to refresh returns the current config unchanged,
      // which also picks up settings written by the OAuth callback.
      const result = await syncKnowledgeBase(userId, id);
      applySyncResult(id, result);
    } catch {
      // The next explicit action reports errors; this refresh is best-effort.
    }
  }

  // ------------------------------------------------------------------ views

  const noticeView = notice && (
    <div
      className={`ws-notice ${notice.tone === "success" ? "is-success" : notice.tone === "danger" ? "is-danger" : "is-warning"}`}
      role={notice.tone === "danger" ? "alert" : "status"}
    >
      {notice.tone === "success" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
      <span>{notice.message}</span>
      <button
        className="icon-button"
        type="button"
        aria-label="Dismiss notification"
        data-tooltip="Clear this message"
        onClick={() => setNotice(null)}
      >
        <X size={14} />
      </button>
    </div>
  );

  const createDialog = creating && (
    <CreateKnowledgeDialog
      data={data}
      canShare={canConfigure}
      initialStart={creating}
      saving={pending === "create"}
      onCancel={() => setCreating(null)}
      onCreate={createBase}
    />
  );

  if (openBase) {
    return (
      <>
        {noticeView}
        <KnowledgeDetail
          item={openBase}
          data={data}
          tab={detailTab}
          onTabChange={setDetailTab}
          canManage={canManage(openBase)}
          canShare={canConfigure}
          documents={documents[openBase.id]}
          documentError={documentErrors[openBase.id]}
          indexStatus={indexStatus[openBase.id]}
          limits={limits}
          uploads={uploads.filter((upload) => upload.knowledgeId === openBase.id)}
          pending={pending}
          openMenu={openMenu}
          setOpenMenu={setOpenMenu}
          onBack={() => setOpenId(null)}
          onEnable={(enabled) => void setEnabled(openBase, enabled)}
          onSync={() => void syncBase(openBase)}
          onDelete={() => void deleteBase(openBase)}
          onRetryDocuments={() => void loadDocuments(openBase.id)}
          onFiles={(files) => queueFiles(openBase, files)}
          onCancelUpload={cancelUpload}
          onRetryUpload={retryUpload}
          onClearUploads={() => clearFinishedUploads(openBase.id)}
          onRemoveDocument={(document) => void removeDocument(openBase, document)}
          onAddWebPage={(draft) => addWebPage(openBase, draft)}
          onAddApi={(payload) => addApi(openBase, payload)}
          onAuthorize={() => void authorizeApi(openBase)}
          onSaveSettings={(patch) => void saveSettings(openBase, patch)}
        />
        {createDialog}
      </>
    );
  }

  const counts = {
    ready: knowledgeBases.filter((item) => baseHealth(item).tone === "ok").length,
    attention: knowledgeBases.filter((item) => item.enabled && ["warn", "danger"].includes(baseHealth(item).tone)).length,
    off: knowledgeBases.filter((item) => !item.enabled).length,
  };
  const needle = query.trim().toLowerCase();
  const visible = knowledgeBases.filter((item) => {
    const health = baseHealth(item);
    if (filter === "ready" && health.tone !== "ok") return false;
    if (filter === "attention" && !(item.enabled && (health.tone === "warn" || health.tone === "danger"))) return false;
    if (filter === "off" && item.enabled) return false;
    if (!needle) return true;
    return [item.name, item.source, item.acl, item.description].some((value) => value?.toLowerCase().includes(needle));
  });

  return (
    <>
      {noticeView}
      {!canCreate && (
        <div className="ws-notice">
          <BookOpen size={15} />
          <span>
            You can use the knowledge bases shared with you in chat. Ask an administrator if you need to add your own.
          </span>
        </div>
      )}
      {knowledgeBases.length > 0 && (
        <div className="ws-toolbar">
          <label className="ws-search">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              value={query}
              placeholder="Search knowledge bases"
              aria-label="Search knowledge bases"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="ws-chips" role="group" aria-label="Filter knowledge bases">
            <button type="button" className="ws-chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
              All <span className="ws-chip-count">{knowledgeBases.length}</span>
            </button>
            {counts.ready > 0 && counts.ready < knowledgeBases.length && (
              <button type="button" className="ws-chip" aria-pressed={filter === "ready"} onClick={() => setFilter("ready")}>
                Ready <span className="ws-chip-count">{counts.ready}</span>
              </button>
            )}
            {counts.attention > 0 && (
              <button
                type="button"
                className="ws-chip"
                aria-pressed={filter === "attention"}
                onClick={() => setFilter("attention")}
              >
                <AlertTriangle size={13} /> Needs attention <span className="ws-chip-count">{counts.attention}</span>
              </button>
            )}
            {counts.off > 0 && (
              <button type="button" className="ws-chip" aria-pressed={filter === "off"} onClick={() => setFilter("off")}>
                Off <span className="ws-chip-count">{counts.off}</span>
              </button>
            )}
          </div>
          <div className="ws-toolbar-actions">
            {canCreate && (
              <button
                className="primary-button compact-button"
                type="button"
                data-tooltip="Create a searchable collection of files, web pages, or API data"
                onClick={() => setCreating("files")}
              >
                <Plus size={16} /> New knowledge base
              </button>
            )}
            {canConfigure && (
              <OverflowMenu id="toolbar" label="More knowledge actions" openMenu={openMenu} setOpenMenu={setOpenMenu}>
                <button
                  type="button"
                  role="menuitem"
                  className="is-danger"
                  disabled={pending === "delete-all"}
                  onClick={() => {
                    setOpenMenu(null);
                    void deleteAllBases();
                  }}
                >
                  <Trash2 size={15} /> {pending === "delete-all" ? "Deleting..." : "Delete all knowledge bases"}
                </button>
              </OverflowMenu>
            )}
          </div>
        </div>
      )}

      {knowledgeBases.length === 0 ? (
        <div className="ws-empty">
          <span className="ws-empty-icon">
            <BookOpen size={24} />
          </span>
          <h2>{canCreate ? "Add your first knowledge base" : "No knowledge bases are shared with you yet"}</h2>
          <p>
            {canCreate
              ? "A knowledge base is a searchable collection your assistants can cite: uploaded files, web pages, or data from an API. Access follows the sharing you choose."
              : "When an administrator shares a knowledge base with you, it appears here and assistants can search it."}
          </p>
          {canCreate && (
            <>
              <div className="ws-empty-actions">
                <button className="primary-button compact-button" type="button" onClick={() => setCreating("files")}>
                  <Plus size={16} /> New knowledge base
                </button>
              </div>
              <div className="ws-starters" role="group" aria-label="Ways to start">
                {(Object.keys(START_OPTIONS) as StartWith[]).map((key) => {
                  const option = START_OPTIONS[key];
                  return (
                    <button key={key} type="button" className="ws-starter" onClick={() => setCreating(key)}>
                      <span className="ws-starter-icon">{option.icon}</span>
                      <span>
                        <strong>{option.label}</strong>
                        <small>{option.helper}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      ) : visible.length === 0 ? (
        <p className="ws-no-results">No knowledge bases match your search.</p>
      ) : (
        <div className="ws-card-grid knowledge-card-grid">
          {visible.map((item) => (
            <KnowledgeCard
              key={item.id}
              item={item}
              viewerId={userId}
              canManage={canManage(item)}
              uploading={uploads.some(
                (upload) => upload.knowledgeId === item.id && (upload.state === "uploading" || upload.state === "processing" || upload.state === "queued"),
              )}
              pending={pending}
              openMenu={openMenu}
              setOpenMenu={setOpenMenu}
              onOpen={() => openDetail(item)}
              onEnable={(enabled) => void setEnabled(item, enabled)}
              onSync={() => void syncBase(item)}
              onDelete={() => void deleteBase(item)}
            />
          ))}
        </div>
      )}
      {createDialog}
    </>
  );
}

// ======================================================================= card

function KnowledgeCard({
  item,
  viewerId,
  canManage,
  uploading,
  pending,
  openMenu,
  setOpenMenu,
  onOpen,
  onEnable,
  onSync,
  onDelete,
}: {
  item: KnowledgeBase;
  viewerId: string;
  canManage: boolean;
  uploading: boolean;
  pending: string | null;
  openMenu: string | null;
  setOpenMenu: (value: string | null) => void;
  onOpen: () => void;
  onEnable: (enabled: boolean) => void;
  onSync: () => void;
  onDelete: () => void;
}) {
  const health = baseHealth(item);
  const syncing = pending === `sync:${item.id}`;
  const attention = item.enabled && (health.tone === "warn" || health.tone === "danger");
  return (
    <article
      className={`ws-card knowledge-card ${attention ? "is-attention" : ""} ${item.enabled ? "" : "is-muted"}`}
      aria-label={item.name}
    >
      <div className="ws-card-head">
        <span className="ws-card-icon" aria-hidden="true">
          <KindIcon item={item} />
        </span>
        <div>
          <h3 className="ws-card-title">
            <button type="button" className="knowledge-card-title-button" onClick={onOpen}>
              {item.name}
            </button>
          </h3>
          <p className="ws-card-meta">
            {kindLabel(item)} · {accessLabel(item, viewerId)}
          </p>
        </div>
        <span className={`ws-badge is-${health.tone}`}>{uploading ? "Adding files" : health.label}</span>
      </div>
      <div className="ws-card-body">
        <ul className="ws-facts" aria-label={`${item.name} contents`}>
          <li className="ws-fact">
            <FileText size={13} /> {item.document_count.toLocaleString()} {plural(item.document_count, "document")}
          </li>
          <li className="ws-fact">
            <RefreshCw size={13} /> {lastUpdatedLabel(item)}
          </li>
        </ul>
        {attention && item.provider_message && <p className="knowledge-card-issue">{item.provider_message}</p>}
      </div>
      <div className="ws-card-foot">
        <span className="knowledge-card-switch">
          <Toggle
            checked={item.enabled}
            disabled={!canManage || pending === `enable:${item.id}`}
            label={`Assistants can search ${item.name}`}
            tooltip={item.enabled ? "Turn off to pause this knowledge base without deleting it" : "Turn on so assistants can search it"}
            onChange={onEnable}
          />
          <span>{item.enabled ? "On" : "Off"}</span>
        </span>
        <span className="ws-spacer" />
        <button className="secondary-button compact-button" type="button" onClick={onOpen}>
          Open
        </button>
        {canManage && (
          <OverflowMenu
            id={`card:${item.id}`}
            label={`More actions for ${item.name}`}
            openMenu={openMenu}
            setOpenMenu={setOpenMenu}
            up
          >
            {canSync(item) && (
              <button
                type="button"
                role="menuitem"
                disabled={syncing}
                onClick={() => {
                  setOpenMenu(null);
                  onSync();
                }}
              >
                <RefreshCw size={15} /> {syncing ? "Syncing..." : "Sync now"}
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className="is-danger"
              disabled={pending === `delete:${item.id}`}
              onClick={() => {
                setOpenMenu(null);
                onDelete();
              }}
            >
              <Trash2 size={15} /> Delete
            </button>
          </OverflowMenu>
        )}
      </div>
    </article>
  );
}

// ===================================================================== detail

function KnowledgeDetail({
  item,
  data,
  tab,
  onTabChange,
  canManage,
  canShare,
  documents,
  documentError,
  indexStatus,
  limits,
  uploads,
  pending,
  openMenu,
  setOpenMenu,
  onBack,
  onEnable,
  onSync,
  onDelete,
  onRetryDocuments,
  onFiles,
  onCancelUpload,
  onRetryUpload,
  onClearUploads,
  onRemoveDocument,
  onAddWebPage,
  onAddApi,
  onAuthorize,
  onSaveSettings,
}: {
  item: KnowledgeBase;
  data: BootstrapData;
  tab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  canManage: boolean;
  canShare: boolean;
  documents: KnowledgeDocument[] | undefined;
  documentError: string | undefined;
  indexStatus: KnowledgeIndexStatus | undefined;
  limits: KnowledgeLimits | null;
  uploads: UploadItem[];
  pending: string | null;
  openMenu: string | null;
  setOpenMenu: (value: string | null) => void;
  onBack: () => void;
  onEnable: (enabled: boolean) => void;
  onSync: () => void;
  onDelete: () => void;
  onRetryDocuments: () => void;
  onFiles: (files: File[]) => void;
  onCancelUpload: (id: string) => void;
  onRetryUpload: (id: string) => void;
  onClearUploads: () => void;
  onRemoveDocument: (document: KnowledgeDocument) => void;
  onAddWebPage: (draft: { url: string; name: string; text: string }) => Promise<boolean>;
  onAddApi: (payload: KnowledgeApiSourcePayload) => Promise<boolean>;
  onAuthorize: () => void;
  onSaveSettings: (patch: { name: string; groupIds: string[] }) => void;
}) {
  const health = baseHealth(item);
  const viewerId = data.me.id;
  const connector = isConnectorBase(item);
  const syncing = pending === `sync:${item.id}`;
  const byKind = useMemo(() => {
    const list = documents ?? [];
    return {
      files: list.filter((document) => document.source_type !== "web" && document.source_type !== "api"),
      web: list.filter((document) => document.source_type === "web"),
      api: list.filter((document) => document.source_type === "api"),
    };
  }, [documents]);
  const waitingApi = (item.linked_sources ?? []).filter((source) => source.awaiting_authorization);
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
  }, [item.id]);
  const showWarning = item.enabled && (health.tone === "warn" || health.tone === "danger") && item.provider_message;

  return (
    <div className="agent-editor-view knowledge-detail-view">
      <div className="agent-editor-head">
        <button
          ref={backRef}
          className="agent-editor-back"
          type="button"
          data-tooltip="Return to all knowledge bases"
          onClick={onBack}
        >
          <ArrowLeft size={16} /> All knowledge bases
        </button>
        <div className="agent-editor-title">
          <span className="ws-card-icon" aria-hidden="true">
            <KindIcon item={item} />
          </span>
          <div>
            <h2>{item.name}</h2>
            <p>
              {kindLabel(item)} · {accessLabel(item, viewerId)} · {item.document_count.toLocaleString()}{" "}
              {plural(item.document_count, "document")} · {lastUpdatedLabel(item)}
            </p>
          </div>
        </div>
        <div className="agent-editor-head-actions">
          <span className={`ws-badge is-${health.tone}`}>{health.label}</span>
          <span className="knowledge-card-switch">
            <Toggle
              checked={item.enabled}
              disabled={!canManage || pending === `enable:${item.id}`}
              label={`Assistants can search ${item.name}`}
              tooltip={item.enabled ? "Turn off to pause this knowledge base without deleting it" : "Turn on so assistants can search it"}
              onChange={onEnable}
            />
            <span>{item.enabled ? "On" : "Off"}</span>
          </span>
          {canManage && canSync(item) && (
            <button
              className="secondary-button compact-button"
              type="button"
              data-tooltip={
                connector
                  ? "Pull the latest files from the connected source"
                  : "Fetch the latest content from this knowledge base's web pages and APIs"
              }
              disabled={syncing}
              onClick={onSync}
            >
              <RefreshCw size={15} className={syncing ? "is-spinning" : undefined} />{" "}
              <StableLabel label={syncing ? "Syncing..." : "Sync now"} reserve={["Syncing...", "Sync now"]} />
            </button>
          )}
          {canManage && (
            <OverflowMenu id="detail" label={`More actions for ${item.name}`} openMenu={openMenu} setOpenMenu={setOpenMenu}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpenMenu(null);
                  onTabChange("settings");
                }}
              >
                <Settings2 size={15} /> Settings
              </button>
              <hr />
              <button
                type="button"
                role="menuitem"
                className="is-danger"
                disabled={pending === `delete:${item.id}`}
                onClick={() => {
                  setOpenMenu(null);
                  onDelete();
                }}
              >
                <Trash2 size={15} /> Delete knowledge base
              </button>
            </OverflowMenu>
          )}
        </div>
      </div>

      {!item.enabled && (
        <div className="ws-notice">
          <AlertTriangle size={15} />
          <span>This knowledge base is off. Assistants and agents skip it until it's turned back on.</span>
        </div>
      )}
      {showWarning && (
        <div className={`ws-notice ${health.tone === "danger" ? "is-danger" : "is-warning"}`}>
          <AlertTriangle size={15} />
          <span>{item.provider_message}</span>
        </div>
      )}
      <SemanticIndexLine status={indexStatus} />

      <div className="agent-editor-card">
        <Tabs.Root className="tabs-root agent-editor-tabs" value={tab} onValueChange={(value) => onTabChange(value as DetailTab)}>
          <Tabs.List className="tabs-list agent-tabs-list" aria-label={`${item.name} sections`}>
            <Tabs.Trigger className="tab-trigger" value="files">
              <FileText size={15} /> {connector ? "Synced files" : "Files"}{" "}
              <span className="agent-tab-count">{byKind.files.length}</span>
            </Tabs.Trigger>
            {!connector && (
              <Tabs.Trigger className="tab-trigger" value="web">
                <Globe size={15} /> Web pages <span className="agent-tab-count">{byKind.web.length}</span>
              </Tabs.Trigger>
            )}
            {!connector && (
              <Tabs.Trigger className="tab-trigger" value="api">
                <KeyRound size={15} /> API <span className="agent-tab-count">{byKind.api.length + waitingApi.length}</span>
              </Tabs.Trigger>
            )}
            {canManage && (
              <Tabs.Trigger className="tab-trigger" value="settings">
                <Settings2 size={15} /> Settings
              </Tabs.Trigger>
            )}
          </Tabs.List>

          <Tabs.Content className="tab-content knowledge-tab" value="files">
            {connector ? (
              <p className="agent-tab-intro">
                Files come from {item.source}. Use Sync now to pull the latest versions; files are read, split into
                passages, and indexed for search.
              </p>
            ) : (
              canManage && (
                <>
                  <DropZone limits={limits} onFiles={onFiles} />
                  <UploadQueue
                    items={uploads}
                    onCancel={onCancelUpload}
                    onRetry={onRetryUpload}
                    onClear={onClearUploads}
                  />
                </>
              )
            )}
            <DocumentList
              label="files"
              documents={documents ? byKind.files : undefined}
              error={documentError}
              indexStatus={indexStatus}
              canManage={canManage && !connector}
              pending={pending}
              emptyText={
                connector
                  ? "Nothing has been synced yet. Use Sync now to pull files from the connected source."
                  : "No files yet. Drop files above to add them."
              }
              onRetry={onRetryDocuments}
              onRemove={onRemoveDocument}
            />
          </Tabs.Content>

          {!connector && (
            <Tabs.Content className="tab-content knowledge-tab" value="web">
              {canManage && <WebPageForm saving={pending === `web:${item.id}`} onSubmit={onAddWebPage} />}
              <DocumentList
                label="web pages"
                documents={documents ? byKind.web : undefined}
                error={documentError}
                indexStatus={indexStatus}
                canManage={canManage}
                pending={pending}
                describe={(document) => {
                  const source = item.linked_sources?.find((candidate) => candidate.document_id === document.id);
                  return source && !source.refresh ? "Pasted text · not re-fetched" : "Refreshed by Sync now";
                }}
                emptyText="No web pages yet. Add a page address above."
                onRetry={onRetryDocuments}
                onRemove={onRemoveDocument}
              />
            </Tabs.Content>
          )}

          {!connector && (
            <Tabs.Content className="tab-content knowledge-tab" value="api">
              {waitingApi.map((source) => (
                <div className="ws-notice is-warning knowledge-waiting-api" key={source.name}>
                  <KeyRound size={15} />
                  <span>
                    <strong>{source.name}</strong> is waiting for provider sign-in. Its data is indexed as soon as access
                    is granted.
                  </span>
                  {canManage && (
                    <button
                      className="secondary-button compact-button"
                      type="button"
                      disabled={pending === `authorize:${item.id}`}
                      onClick={onAuthorize}
                    >
                      Sign in with provider
                    </button>
                  )}
                </div>
              ))}
              {canManage && (
                <ApiSourceForm
                  knowledgeId={item.id}
                  callbackBase={limits?.oauth_callback_base}
                  saving={pending === `api:${item.id}`}
                  hasOAuthSource={(item.linked_sources ?? []).some((source) => source.auth_type === "oauth-client")}
                  onSubmit={onAddApi}
                />
              )}
              <DocumentList
                label="API sources"
                documents={documents ? byKind.api : undefined}
                error={documentError}
                indexStatus={indexStatus}
                canManage={canManage}
                pending={pending}
                describe={(document) => {
                  const source = item.linked_sources?.find((candidate) => candidate.document_id === document.id);
                  // Entries saved before API fetching existed hold only the
                  // connection description, never the API's data.
                  return source
                    ? `${source.method ?? "GET"} · ${authLabel(source.auth_type)} · refreshed by Sync now`
                    : "Connection details only, no API data. Remove it and connect the API again to fetch its data.";
                }}
                emptyText="No API data yet. Connect an endpoint above; its response is fetched and indexed."
                onRetry={onRetryDocuments}
                onRemove={onRemoveDocument}
              />
            </Tabs.Content>
          )}

          {canManage && (
            <Tabs.Content className="tab-content knowledge-tab" value="settings">
              <SettingsForm
                item={item}
                data={data}
                canShare={canShare}
                saving={pending === `settings:${item.id}`}
                onSave={onSaveSettings}
                onDelete={onDelete}
              />
            </Tabs.Content>
          )}
        </Tabs.Root>
      </div>
    </div>
  );
}

function SemanticIndexLine({ status }: { status: KnowledgeIndexStatus | undefined }) {
  if (!status || status.semantic_search !== "on" || status.pending_chunks <= 0 || status.total_chunks <= 0) {
    return null;
  }
  const done = status.total_chunks - status.pending_chunks;
  const fraction = Math.max(0, Math.min(1, done / status.total_chunks));
  return (
    <div className="knowledge-index-line" role="status">
      <Loader2 size={14} className="is-spinning" aria-hidden="true" />
      <span>
        Improving search in the background: {done.toLocaleString()} of {status.total_chunks.toLocaleString()} passages
        ready for meaning-based search. Keyword search already works.
      </span>
      <span className="knowledge-progress" aria-hidden="true">
        <span style={{ width: `${Math.round(fraction * 100)}%` }} />
      </span>
    </div>
  );
}

// ================================================================ uploading

function DropZone({ limits, onFiles }: { limits: KnowledgeLimits | null; onFiles: (files: File[]) => void }) {
  const [dragging, setDragging] = useState(false);
  const inputId = useId();
  const depth = useRef(0);
  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length) onFiles(files);
  }
  return (
    <div
      className={`knowledge-dropzone ${dragging ? "is-dragging" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        depth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      }}
      onDrop={handleDrop}
    >
      <span className="knowledge-dropzone-icon" aria-hidden="true">
        <Upload size={20} />
      </span>
      <div>
        <strong>Drag files here</strong> or{" "}
        <label className="knowledge-browse" htmlFor={inputId}>
          browse your computer
        </label>
        <input
          id={inputId}
          className="knowledge-file-input"
          type="file"
          multiple
          accept={KNOWLEDGE_FILE_ACCEPT}
          aria-label="Choose files to add"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (files.length) onFiles(files);
          }}
        />
        <small>
          PDF, Word, Excel, PowerPoint, email, images, text, audio, and video
          {limits ? ` · up to ${limits.upload_max_mb.toLocaleString()} MB each` : ""}. Files are searchable as soon as
          they finish.
          {limits?.ocr_enabled ? ` Scanned pages are read with OCR (first ${limits.ocr_max_pages.toLocaleString()} pages).` : ""}
        </small>
      </div>
    </div>
  );
}

function UploadQueue({
  items,
  onCancel,
  onRetry,
  onClear,
}: {
  items: UploadItem[];
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onClear: () => void;
}) {
  if (!items.length) return null;
  const finished = items.filter((item) => item.state === "done" || item.state === "error" || item.state === "cancelled");
  return (
    <section className="knowledge-upload-queue" aria-label="Uploads">
      <div className="knowledge-list-head">
        <span className="ws-section-label">Uploads</span>
        {finished.length > 0 && (
          <button className="link-button" type="button" onClick={onClear}>
            Clear finished
          </button>
        )}
      </div>
      <ul>
        {items.map((item) => (
          <li key={item.id} className={`knowledge-upload is-${item.state}`}>
            <span className="knowledge-row-icon" aria-hidden="true">
              {item.state === "done" ? (
                <CheckCircle2 size={16} />
              ) : item.state === "error" ? (
                <AlertTriangle size={16} />
              ) : item.state === "uploading" || item.state === "processing" ? (
                <Loader2 size={16} className="is-spinning" />
              ) : (
                <FileText size={16} />
              )}
            </span>
            <span className="knowledge-row-main">
              <strong title={item.file.name}>{item.file.name}</strong>
              <small>
                {formatFileSize(item.file.size)} · {uploadStateLabel(item)}
                {item.message && item.state !== "uploading" ? ` · ${item.message}` : ""}
              </small>
              {(item.state === "uploading" || item.state === "processing") && (
                <span
                  className={`knowledge-progress ${item.state === "processing" ? "is-indeterminate" : ""}`}
                  role="progressbar"
                  aria-label={`${item.file.name} upload progress`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={item.state === "processing" ? undefined : Math.round(item.progress * 100)}
                >
                  <span style={{ width: `${Math.round(item.progress * 100)}%` }} />
                </span>
              )}
            </span>
            <span className="knowledge-row-actions">
              {(item.state === "queued" || item.state === "uploading") && (
                <button
                  className="icon-button"
                  type="button"
                  aria-label={`Cancel ${item.file.name}`}
                  data-tooltip="Stop this upload"
                  onClick={() => onCancel(item.id)}
                >
                  <X size={15} />
                </button>
              )}
              {(item.state === "error" || item.state === "cancelled") && (
                <button className="secondary-button compact-button" type="button" onClick={() => onRetry(item.id)}>
                  <RotateCcw size={14} /> Retry
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DocumentList({
  label,
  documents,
  error,
  indexStatus,
  canManage,
  pending,
  emptyText,
  describe,
  onRetry,
  onRemove,
}: {
  label: string;
  documents: KnowledgeDocument[] | undefined;
  error: string | undefined;
  indexStatus: KnowledgeIndexStatus | undefined;
  canManage: boolean;
  pending: string | null;
  emptyText: string;
  describe?: (document: KnowledgeDocument) => string;
  onRetry: () => void;
  onRemove: (document: KnowledgeDocument) => void;
}) {
  const [query, setQuery] = useState("");
  if (error) {
    return (
      <div className="ws-notice is-danger">
        <AlertTriangle size={15} />
        <span>The {label} list could not load: {error}</span>
        <button className="secondary-button compact-button" type="button" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  if (!documents) {
    return (
      <p className="knowledge-loading">
        <Loader2 size={14} className="is-spinning" /> Loading {label}...
      </p>
    );
  }
  if (!documents.length) return <p className="knowledge-empty-list">{emptyText}</p>;
  const needle = query.trim().toLowerCase();
  const shown = needle ? documents.filter((document) => document.name.toLowerCase().includes(needle)) : documents;
  return (
    <section className="knowledge-documents" aria-label={`Indexed ${label}`}>
      <div className="knowledge-list-head">
        <span className="ws-section-label">
          {documents.length.toLocaleString()} indexed {documents.length === 1 ? label.replace(/s$/, "") : label}
        </span>
        {documents.length > 8 && (
          <label className="ws-search knowledge-document-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={query}
              placeholder={`Search ${label}`}
              aria-label={`Search ${label}`}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="ws-no-results">No {label} match your search.</p>
      ) : (
        <ul className="knowledge-document-rows">
          {shown.map((document) => {
            const unreadable = document.status === "metadata-only";
            const waiting = indexStatus?.pending_by_document?.[document.id] ?? 0;
            return (
              <li key={document.id} className="knowledge-document-row-item">
                <span className="knowledge-row-icon" aria-hidden="true">
                  {document.source_type === "web" ? <Globe size={16} /> : document.source_type === "api" ? <KeyRound size={16} /> : <FileText size={16} />}
                </span>
                <span className="knowledge-row-main">
                  <strong title={document.name}>{document.name}</strong>
                  <small title={document.source_uri}>
                    {unreadable
                      ? "No readable text — only the name is searchable"
                      : `${document.chunk_count.toLocaleString()} ${plural(document.chunk_count, "passage")}`}
                    {" · "}
                    {describe ? describe(document) : `${label === "files" && document.source_type !== "upload" ? "Updated" : "Added"} ${document.updated_at}`}
                    {waiting > 0 ? " · improving search" : ""}
                  </small>
                </span>
                <span className="knowledge-row-actions">
                  {unreadable && <span className="ws-badge is-warn">Not readable</span>}
                  {canManage && (
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`Remove ${document.name}`}
                      data-tooltip="Remove this item and its passages from search"
                      disabled={pending === `document:${document.id}`}
                      onClick={() => onRemove(document)}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ====================================================================== forms

function WebPageForm({
  saving,
  onSubmit,
}: {
  saving: boolean;
  onSubmit: (draft: { url: string; name: string; text: string }) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState({ url: "", name: "", text: "" });
  const [pasteText, setPasteText] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const saved = await onSubmit({ ...draft, text: pasteText ? draft.text : "" });
    if (saved) {
      setDraft({ url: "", name: "", text: "" });
      setPasteText(false);
    }
  }
  return (
    <form className="knowledge-source-form" onSubmit={(event) => void submit(event)} aria-label="Add a web page">
      <p className="agent-tab-intro">
        The page is fetched now and again whenever you choose Sync now. Only public pages can be fetched.
      </p>
      <div className="knowledge-form-grid">
        <label>
          Page address
          <input
            type="url"
            required
            value={draft.url}
            placeholder="https://example.com/policies/retention"
            onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))}
          />
        </label>
        <label>
          <span className="knowledge-label-text">Name <span className="knowledge-optional">Optional</span></span>
          <input
            value={draft.name}
            placeholder="Retention policy"
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          />
        </label>
        <label className="knowledge-inline-check knowledge-form-wide">
          <input type="checkbox" checked={pasteText} onChange={(event) => setPasteText(event.target.checked)} />
          <span>Paste the text instead of fetching the page (for pages behind a sign-in)</span>
        </label>
        {pasteText && (
          <label className="knowledge-form-wide">
            Page text
            <textarea
              value={draft.text}
              required
              placeholder="Paste the page's text here"
              onChange={(event) => setDraft((current) => ({ ...current, text: event.target.value }))}
            />
          </label>
        )}
      </div>
      <div className="knowledge-form-actions">
        <button className="primary-button compact-button" type="submit" disabled={saving}>
          <StableLabel label={saving ? "Adding..." : pasteText ? "Add text" : "Fetch and add page"} reserve={["Adding...", "Fetch and add page"]} />
        </button>
      </div>
    </form>
  );
}

type ApiDraft = {
  name: string;
  baseUrl: string;
  path: string;
  method: "GET" | "POST";
  authType: KnowledgeApiSourcePayload["auth_type"];
  secret: string;
  keyName: string;
  keyPlacement: "header" | "query";
  clientId: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string;
  headers: string;
  body: string;
};

const EMPTY_API_DRAFT: ApiDraft = {
  name: "",
  baseUrl: "",
  path: "",
  method: "GET",
  authType: "none",
  secret: "",
  keyName: "X-API-Key",
  keyPlacement: "header",
  clientId: "",
  authorizationUrl: "",
  tokenUrl: "",
  scopes: "",
  headers: "",
  body: "",
};

function ApiSourceForm({
  knowledgeId,
  callbackBase,
  saving,
  hasOAuthSource,
  onSubmit,
}: {
  knowledgeId: string;
  callbackBase?: string;
  saving: boolean;
  hasOAuthSource: boolean;
  onSubmit: (payload: KnowledgeApiSourcePayload) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<ApiDraft>(EMPTY_API_DRAFT);
  const update = (patch: Partial<ApiDraft>) => setDraft((current) => ({ ...current, ...patch }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    const saved = await onSubmit({
      name: draft.name.trim() || draft.baseUrl.trim(),
      base_url: draft.baseUrl.trim(),
      path: draft.path.trim() || null,
      method: draft.method,
      headers: draft.headers.trim() || null,
      body: draft.method === "POST" ? draft.body.trim() || null : null,
      auth_type: draft.authType,
      secret_value: draft.secret.trim() || null,
      ...(draft.authType === "api-key"
        ? { credential_name: draft.keyName.trim() || "X-API-Key", credential_location: draft.keyPlacement }
        : {}),
      ...(draft.authType === "oauth-client"
        ? {
            client_id: draft.clientId.trim(),
            authorization_url: draft.authorizationUrl.trim(),
            token_url: draft.tokenUrl.trim(),
            scopes: draft.scopes
              .split(/[\s,]+/)
              .map((scope) => scope.trim())
              .filter(Boolean),
          }
        : {}),
    });
    if (saved) setDraft(EMPTY_API_DRAFT);
  }
  const oauthBlocked = draft.authType === "oauth-client" && hasOAuthSource;
  return (
    <form className="knowledge-source-form" onSubmit={(event) => void submit(event)} aria-label="Connect an API">
      <p className="agent-tab-intro">
        Aperture calls the endpoint, turns the response (JSON or text) into searchable passages, and calls it again
        whenever you choose Sync now. Nothing is added unless the request succeeds.
      </p>
      <div className="knowledge-form-grid">
        <label>
          API address
          <input
            type="url"
            required
            value={draft.baseUrl}
            placeholder="https://api.example.com"
            onChange={(event) => update({ baseUrl: event.target.value })}
          />
        </label>
        <label>
          <span className="knowledge-label-text">Path <span className="knowledge-optional">Optional</span></span>
          <input value={draft.path} placeholder="/v1/matters?status=open" onChange={(event) => update({ path: event.target.value })} />
        </label>
        <label>
          <span className="knowledge-label-text">Name <span className="knowledge-optional">Optional</span></span>
          <input value={draft.name} placeholder="Open matters" onChange={(event) => update({ name: event.target.value })} />
        </label>
        <label>
          Sign-in
          <SelectControl
            value={draft.authType}
            onChange={(event) => update({ authType: event.target.value as ApiDraft["authType"] })}
          >
            <option value="none">None (public API)</option>
            <option value="api-key">API key</option>
            <option value="bearer-token">Bearer token</option>
            <option value="oauth-client">Sign in with provider (OAuth)</option>
          </SelectControl>
        </label>
        {draft.authType === "api-key" && (
          <>
            <label>
              API key
              <input
                type="password"
                autoComplete="new-password"
                required
                value={draft.secret}
                placeholder="Stored encrypted; never shown again"
                onChange={(event) => update({ secret: event.target.value })}
              />
            </label>
            <label>
              Send the key as
              <SelectControl
                value={draft.keyPlacement}
                onChange={(event) => update({ keyPlacement: event.target.value as ApiDraft["keyPlacement"] })}
              >
                <option value="header">Header</option>
                <option value="query">Query parameter</option>
              </SelectControl>
            </label>
            <label>
              {draft.keyPlacement === "header" ? "Header name" : "Parameter name"}
              <input value={draft.keyName} onChange={(event) => update({ keyName: event.target.value })} />
            </label>
          </>
        )}
        {draft.authType === "bearer-token" && (
          <label>
            Token
            <input
              type="password"
              autoComplete="new-password"
              required
              value={draft.secret}
              placeholder="Stored encrypted; sent as Authorization: Bearer"
              onChange={(event) => update({ secret: event.target.value })}
            />
          </label>
        )}
        {draft.authType === "oauth-client" && (
          <>
            {oauthBlocked && (
              <p className="knowledge-form-wide knowledge-form-warning">
                This knowledge base already has a provider-connected API. Remove it before connecting another.
              </p>
            )}
            <label>
              Client ID
              <input required value={draft.clientId} onChange={(event) => update({ clientId: event.target.value })} />
            </label>
            <label>
              <span className="knowledge-label-text">Client secret <span className="knowledge-optional">If the provider requires one</span></span>
              <input
                type="password"
                autoComplete="new-password"
                value={draft.secret}
                onChange={(event) => update({ secret: event.target.value })}
              />
            </label>
            <label>
              Authorization URL
              <input
                type="url"
                required
                value={draft.authorizationUrl}
                placeholder="https://login.example.com/oauth/authorize"
                onChange={(event) => update({ authorizationUrl: event.target.value })}
              />
            </label>
            <label>
              Token URL
              <input
                type="url"
                required
                value={draft.tokenUrl}
                placeholder="https://login.example.com/oauth/token"
                onChange={(event) => update({ tokenUrl: event.target.value })}
              />
            </label>
            <label>
              <span className="knowledge-label-text">Scopes <span className="knowledge-optional">Space or comma separated</span></span>
              <input value={draft.scopes} placeholder="read:matters" onChange={(event) => update({ scopes: event.target.value })} />
            </label>
            <label className="readonly-field knowledge-form-wide">
              Redirect URI to register with the provider
              <input
                readOnly
                value={
                  callbackBase
                    ? `${callbackBase}/${encodeURIComponent(knowledgeId)}/oauth/callback`
                    : knowledgeApiSourceOAuthCallbackUrl(knowledgeId)
                }
              />
            </label>
          </>
        )}
        <details className="knowledge-form-wide knowledge-advanced">
          <summary>Advanced request options</summary>
          <div className="knowledge-form-grid">
            <label>
              Method
              <SelectControl value={draft.method} onChange={(event) => update({ method: event.target.value as ApiDraft["method"] })}>
                <option value="GET">GET</option>
                <option value="POST">POST</option>
              </SelectControl>
            </label>
            <label className="knowledge-form-wide">
              <span className="knowledge-label-text">Extra headers <span className="knowledge-optional">One "Name: value" per line; don't put secrets here</span></span>
              <textarea
                value={draft.headers}
                placeholder={"Accept: application/json\nX-Tenant: example"}
                onChange={(event) => update({ headers: event.target.value })}
              />
            </label>
            {draft.method === "POST" && (
              <label className="knowledge-form-wide">
                <span className="knowledge-label-text">Request body <span className="knowledge-optional">Sent as JSON</span></span>
                <textarea
                  value={draft.body}
                  placeholder={'{"status": "open"}'}
                  onChange={(event) => update({ body: event.target.value })}
                />
              </label>
            )}
          </div>
        </details>
      </div>
      <div className="knowledge-form-actions">
        <button className="primary-button compact-button" type="submit" disabled={saving || oauthBlocked}>
          <StableLabel
            label={saving ? "Connecting..." : draft.authType === "oauth-client" ? "Save and sign in" : "Fetch and add"}
            reserve={["Connecting...", "Save and sign in", "Fetch and add"]}
          />
        </button>
      </div>
    </form>
  );
}

function SettingsForm({
  item,
  data,
  canShare,
  saving,
  onSave,
  onDelete,
}: {
  item: KnowledgeBase;
  data: BootstrapData;
  canShare: boolean;
  saving: boolean;
  onSave: (patch: { name: string; groupIds: string[] }) => void;
  onDelete: () => void;
}) {
  const initialGroups = useMemo(() => groupIdsFromBase(item, data), [item, data]);
  const [name, setName] = useState(item.name);
  const [groupIds, setGroupIds] = useState<string[]>(initialGroups);
  useEffect(() => {
    setName(item.name);
    setGroupIds(initialGroups);
  }, [initialGroups, item.name]);
  const dirty = name.trim() !== item.name || groupIds.join("|") !== initialGroups.join("|");
  return (
    <form
      className="knowledge-settings"
      aria-label={`${item.name} settings`}
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ name, groupIds });
      }}
    >
      <div className="knowledge-form-grid">
        <label>
          Name
          <input value={name} required onChange={(event) => setName(event.target.value)} />
        </label>
      </div>
      <fieldset className="knowledge-access">
        <legend>Who can search it</legend>
        {canShare ? (
          data.groups.length ? (
            <>
              <p className="agent-tab-intro">
                Leave every group unchecked to keep it private to its owner. Administrators can always manage it.
              </p>
              <div className="knowledge-group-grid">
                {data.groups.map((group) => (
                  <label key={group.id} className="knowledge-inline-check">
                    <input
                      type="checkbox"
                      checked={groupIds.includes(group.id)}
                      onChange={(event) =>
                        setGroupIds((current) =>
                          event.target.checked
                            ? [...current, group.id]
                            : current.filter((groupId) => groupId !== group.id),
                        )
                      }
                    />
                    <span>
                      {group.name} <small>{group.user_count} {plural(group.user_count, "member")}</small>
                    </span>
                  </label>
                ))}
              </div>
            </>
          ) : (
            <p className="agent-tab-intro">No groups exist yet, so this knowledge base is private to its owner.</p>
          )
        ) : (
          <p className="agent-tab-intro">
            {accessLabel(item, data.me.id)}. Sharing with groups is managed by administrators.
          </p>
        )}
      </fieldset>
      <div className="knowledge-form-actions">
        <button className="primary-button compact-button" type="submit" disabled={saving || !dirty}>
          <StableLabel label={saving ? "Saving..." : "Save changes"} reserve={["Saving...", "Save changes"]} />
        </button>
      </div>
      <div className="knowledge-danger-zone">
        <div>
          <strong>Delete this knowledge base</strong>
          <small>Removes its documents and search index. Agents that use it stop citing it.</small>
        </div>
        <button className="danger-button compact-button" type="button" onClick={onDelete}>
          <Trash2 size={15} /> Delete
        </button>
      </div>
    </form>
  );
}

// ===================================================================== create

type CreateDraft = { name: string; description: string; startWith: StartWith; groupIds: string[] };

const START_OPTIONS: Record<StartWith, { label: string; helper: string; icon: ReactNode; source: string; description: string; next: string }> = {
  files: {
    label: "Upload files",
    helper: "PDFs, Office files, email, images, audio, and video.",
    icon: <Upload size={16} />,
    source: "Uploaded files",
    description: "Uploaded files.",
    next: "Drop files into it to start indexing.",
  },
  web: {
    label: "Add web pages",
    helper: "Public pages, re-fetched whenever you sync.",
    icon: <Globe size={16} />,
    source: "Web pages",
    description: "Web pages.",
    next: "Add a page address to fetch it.",
  },
  api: {
    label: "Connect an API",
    helper: "JSON or text from an endpoint, with a key or sign-in.",
    icon: <KeyRound size={16} />,
    source: "API data",
    description: "API data.",
    next: "Connect an endpoint to fetch its data.",
  },
};

function CreateKnowledgeDialog({
  data,
  canShare,
  initialStart,
  saving,
  onCancel,
  onCreate,
}: {
  data: BootstrapData;
  canShare: boolean;
  initialStart: StartWith;
  saving: boolean;
  onCancel: () => void;
  onCreate: (draft: CreateDraft) => Promise<boolean>;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState<CreateDraft>({ name: "", description: "", startWith: initialStart, groupIds: [] });
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, saving]);
  return (
    <div className="modal-backdrop" role="presentation" onClick={() => !saving && onCancel()}>
      <section
        ref={dialogRef}
        className="modal knowledge-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-icon">
            <BookOpen size={20} />
          </span>
          <div>
            <h2 id={titleId}>New knowledge base</h2>
            <p>Name it, choose who can search it, then add content. You can mix files, pages, and APIs later.</p>
          </div>
          <button className="icon-button" type="button" aria-label="Close" disabled={saving} onClick={onCancel}>
            <X size={17} />
          </button>
        </div>
        <form
          className="knowledge-create-form"
          onSubmit={(event) => {
            event.preventDefault();
            void onCreate(draft);
          }}
        >
          <label>
            Name
            <input
              required
              value={draft.name}
              placeholder="e.g. Litigation playbook"
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </label>
          <fieldset className="knowledge-start-options">
            <legend>Start with</legend>
            <div className="ws-segmented" role="group" aria-label="Start with">
              {(Object.keys(START_OPTIONS) as StartWith[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={draft.startWith === key}
                  onClick={() => setDraft((current) => ({ ...current, startWith: key }))}
                >
                  {START_OPTIONS[key].icon} {START_OPTIONS[key].label}
                </button>
              ))}
            </div>
            <small>{START_OPTIONS[draft.startWith].helper}</small>
          </fieldset>
          <label>
            Who can search it
            {canShare ? (
              <SelectControl
                value={draft.groupIds[0] ?? ""}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, groupIds: event.target.value ? [event.target.value] : [] }))
                }
              >
                <option value="">Only me</option>
                {data.groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </SelectControl>
            ) : (
              <input readOnly value="Only me" aria-readonly="true" />
            )}
            <small className="knowledge-field-hint">
              {canShare ? "You can share it with more groups later in Settings." : "Administrators manage group sharing."}
            </small>
          </label>
          <div className="knowledge-form-actions">
            <button className="secondary-button compact-button" type="button" disabled={saving} onClick={onCancel}>
              Cancel
            </button>
            <button className="primary-button compact-button" type="submit" disabled={saving}>
              <StableLabel label={saving ? "Creating..." : "Create"} reserve={["Creating...", "Create"]} />
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

// ==================================================================== helpers

function KindIcon({ item }: { item: KnowledgeBase }) {
  const kind = baseKind(item);
  if (kind === "connector") return <Cloud size={18} />;
  if (kind === "web") return <Globe size={18} />;
  if (kind === "api") return <KeyRound size={18} />;
  return <FileText size={18} />;
}

function baseKind(item: KnowledgeBase): "upload" | "web" | "api" | "connector" {
  const type = item.source_type ?? item.connector_id;
  if (CONNECTOR_TYPES.has(type) || CONNECTOR_TYPES.has(item.connector_id)) return "connector";
  if (type === "web" || type === "api") return type;
  return "upload";
}

function isConnectorBase(item: KnowledgeBase): boolean {
  return baseKind(item) === "connector";
}

function kindLabel(item: KnowledgeBase): string {
  const kind = baseKind(item);
  if (kind === "connector") return item.source || "Connected source";
  if (kind === "web") return "Web pages";
  if (kind === "api") return "API data";
  return "Files";
}

function defaultTab(item: KnowledgeBase): DetailTab {
  const kind = baseKind(item);
  if (kind === "web") return "web";
  if (kind === "api") return "api";
  return "files";
}

/** Sync only does something for connectors and linked web pages or APIs. */
function canSync(item: KnowledgeBase): boolean {
  if (isConnectorBase(item)) return true;
  return (item.linked_sources ?? []).some((source) => source.refresh && !source.awaiting_authorization);
}

function accessLabel(item: KnowledgeBase, viewerId?: string): string {
  const acl = item.acl ?? "";
  if (!acl.startsWith("Groups: ") && viewerId && item.owner_user_id === viewerId) return "Private to you";
  if (acl.startsWith("Groups: ")) return `Shared with ${acl.slice("Groups: ".length)}`;
  if (acl.startsWith("Only ")) return `Private to ${acl.slice("Only ".length)}`;
  return acl || "Private";
}

function authLabel(authType: string | undefined): string {
  if (authType === "api-key") return "API key";
  if (authType === "bearer-token") return "Bearer token";
  if (authType === "oauth-client") return "Provider sign-in";
  return "No sign-in";
}

function lastUpdatedLabel(item: KnowledgeBase): string {
  const value = item.last_sync?.trim();
  if (!value || ["Not synced", "Never synced", "Loaded from API", "Syncing..."].includes(value)) {
    return item.document_count ? "Updated earlier" : "Nothing added yet";
  }
  return `Updated ${value}`;
}

function baseHealth(item: KnowledgeBase): Health {
  if (!item.enabled) return { label: "Off", tone: "muted" };
  if ((item.linked_sources ?? []).some((source) => source.awaiting_authorization)) {
    return { label: "Sign-in needed", tone: "warn" };
  }
  if (item.status === "syncing") return { label: "Syncing", tone: "muted" };
  if (item.status === "error") return { label: "Needs attention", tone: "danger" };
  if (item.status === "stale") return { label: "Needs attention", tone: "warn" };
  if (!item.document_count) return { label: "Empty", tone: "muted" };
  return { label: "Ready", tone: "ok" };
}

function groupIdsFromBase(item: KnowledgeBase, data: BootstrapData): string[] {
  const acl = item.acl ?? "";
  if (!acl.startsWith("Groups: ")) return [];
  const names = acl.slice("Groups: ".length).split(",").map((value) => value.trim());
  return names.map((name) => data.groups.find((group) => group.name === name)?.id ?? name).filter(Boolean);
}

function removeBasesFromData(
  onDataChange: (updater: (current: BootstrapData) => BootstrapData) => void,
  ids: Set<string>,
) {
  if (!ids.size) return;
  onDataChange((current) => ({
    ...current,
    knowledgeBases: current.knowledgeBases.filter((item) => !ids.has(item.id)),
    models: current.models.map((model) => ({
      ...model,
      knowledge_base_ids: model.knowledge_base_ids?.filter((id) => !ids.has(id)),
      knowledge_config_ids: model.knowledge_config_ids?.filter((id) => !ids.has(id)),
    })),
  }));
}

function openSignInWindow(): Window | null {
  const popup = window.open("", "aperture-knowledge-oauth", "width=560,height=720");
  if (popup) {
    try {
      popup.document.title = "Connecting…";
      popup.document.body.textContent = "Opening the provider's sign-in page…";
    } catch {
      // A reused window may already show another origin; navigation still works.
    }
  }
  return popup;
}

/** "Indexed 1 of 1 uploaded file (42 passages). Note." -> "42 passages · Note." */
function singleUploadSummary(message: string | null | undefined): string | undefined {
  if (!message) return undefined;
  const match = /^Indexed (\d+) of 1 uploaded file \(([\d,]+ passages?)\)\.\s*(.*)$/.exec(message);
  if (!match) return message;
  const [, readable, passages, notes] = match;
  if (readable === "0") return notes || "No readable text was found.";
  return notes ? `${passages} · ${notes}` : passages;
}

function uploadStateLabel(item: UploadItem): string {
  if (item.state === "queued") return "Waiting";
  if (item.state === "uploading") return `Uploading ${Math.round(item.progress * 100)}%`;
  if (item.state === "processing") return "Reading and indexing";
  if (item.state === "done") return "Added";
  if (item.state === "cancelled") return "Cancelled";
  return "Failed";
}

function isReadableKnowledgeFile(file: File): boolean {
  const extension = extensionOf(file.name);
  if ((KNOWLEDGE_FILE_EXTENSIONS as readonly string[]).includes(extension)) return true;
  const type = file.type.toLowerCase();
  return type.startsWith("text/") || type.startsWith("image/") || type.startsWith("audio/") || type.startsWith("video/");
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Unknown error.";
}

