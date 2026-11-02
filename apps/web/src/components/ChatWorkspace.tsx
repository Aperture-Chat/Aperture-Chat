import { SelectControl } from "./SelectControl";
import { ModelSelect } from "./ModelSelect";
import { useModalFocus } from "../lib/useModalFocus";
import {
  applyCommandText,
  detectComposerCommandToken,
  groupCommandSections,
  knowledgeCommandItems,
  rankCommandMatches,
  type ComposerCommandSymbol,
  type ComposerCommandToken,
  type KnowledgeCommandItem,
} from "../lib/composerCommands";
import { fileIconClass, fileKind } from "../lib/fileKinds";
import { useCommandMenuFit } from "../lib/useCommandMenuFit";
import { useComposerCommandToken } from "../lib/useComposerCommandToken";
import { useKnowledgeFiles } from "../lib/useKnowledgeFiles";
import { ComposerCommandMenu, KnowledgeMenuStatus } from "./ComposerCommandMenu";
import { ComposerFileBlock } from "./ComposerFileBlock";
import {
  ReasoningRail,
  reasoningHelp,
  REASONING_EFFORT_BY_LEVEL,
  loadReasoningLevel,
  storeReasoningLevel,
  type ReasoningLevel,
} from "./ReasoningSlider";
import {
  OptionCopy,
  ResourceListHeader,
  ResourceSearch,
  ResourceTiles,
  SEND_MENU_TABS,
  ShortcutGuide,
  StreamSwitch,
  ToolSwitch,
  agentOptionDetail,
  knowledgeOptionDetail,
  resourceListShows,
  resourceSectionIcon,
  resourceSectionLabel,
  resourceViewLoadsKnowledgeFiles,
  resourceViewTitle,
  webOptionDetail,
  type ResourceSection,
  type ResourceView,
  type SendMenuTab,
} from "./ComposerOptions";
import { RailSwitch } from "./RailSwitch";
import {
  ArrowUpRight,
  BookOpen,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FilePenLine,
  FileText,
  Globe2,
  Info,
  Link2,
  Loader2,
  Lock,
  Maximize2,
  MessageSquare,
  Minimize2,
  Paperclip,
  Pencil,
  Play,
  Plug,
  Presentation,
  Sheet as SheetIcon,
  RefreshCw,
  ScrollText,
  Send,
  ShieldCheck,
  Split,
  Sparkles,
  TerminalSquare,
  ThumbsDown,
  ThumbsUp,
  Undo2,
  Upload,
  Wrench,
  X,
} from "lucide-react";
import {
  BoxIcon,
  GoogleDriveIcon,
  IManageIcon,
  OneDriveIcon,
  SharePointIcon,
  type ConnectorIcon,
} from "./connectorIcons";
import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type {
  BootstrapData,
  ChatAttachment,
  ChatFeedbackRating,
  ChatMessage,
  ChatThread,
  CloudAttachmentItem,
  Automation,
  CustomScriptRunResult,
  KnowledgeBase,
  ModelConfig,
  PromptTemplate,
  SkillFile,
  ToolConfig,
} from "../lib/types";
import {
  activeResponseVersionIndex,
  messageWithActiveResponseVersion,
  responseVersionsForMessage,
  type ChatStore,
} from "../lib/chatStore";
import {
  approveMcpTool,
  attachKnowledge,
  ChatRequestError,
  hermesLocked,
  isHermesAgent,
  isHermesTool,
  toolUsableBy,
  getCloudAttachmentAuthorizeUrl,
  importCloudAttachments,
  listCloudAttachmentItems,
  deleteChatAttachment,
  loadChatAttachmentPreview,
  runCustomScriptTool,
  sendChat,
  sendChatStream,
  submitChatFeedback,
  uploadChatAttachment,
  type ChatRuntimeOptions,
} from "../lib/api";
import {
  approvedWorkspaceModels,
  supportsReasoningEffort,
  visibleAgentProfiles,
  webSearchSupportedForModel,
} from "../lib/modelAccess";
import {
  draftHandoffEditTarget,
  draftHandoffOffer,
  draftHandoffAttachments,
  draftHandoffChatContext,
  editableAttachment,
  threadEditableAttachment,
  type DraftHandoffOffer,
  type DraftHandoffRequest,
} from "../lib/draftHandoff";
import { connectorEnabled, connectorHidden, isMcpRuntimeTool } from "../lib/connectors";
import type { DocumentRequest } from "../lib/citationTargets";
import { formatTimeLabel, formatTimestamp } from "../lib/serverClock";
import { feedbackRatingForMessage, recordChatFeedback } from "../lib/chatFeedback";
import { markdownToPlainText } from "../lib/markdown";
import { splitAssistantThinking } from "../lib/assistantThinking";
import { loadLiveStreamPreference, storeLiveStreamPreference } from "../lib/streamPreference";
import { BREAKPOINTS, useViewportWidth } from "../lib/useViewport";
import { DictationControl } from "./DictationControl";
import { isMediaUploadFile } from "../lib/mediaUploads";
import { CitationMarkerContext } from "./CitationMarker";
import { useKnowledgeDocumentViewer } from "./KnowledgeDocumentViewerHost";
import { Markdown } from "./Markdown";
import { SessionSources } from "./SessionSources";
import { WorkTrace, WorkTraceStreamStatus } from "./WorkTrace";
import { TransferDraftMenu } from "./TransferDraftMenu";
import type { DraftTransferFormat } from "../lib/draftTransfer";
import type { MarkdownTable } from "../lib/markdown";
import { ArtifactCanvasProvider } from "./ArtifactCanvas";
import { CodeEditAssistProvider, type CodeEditAssist } from "./CodeAiEdit";
import { renderConcealed } from "./ConcealedText";
import { BrandArtwork, BrandIcon, Pill } from "./Primitives";
import { DEFAULT_BRAND_NAME, brandLockup, compactBrandSources, type BrandAssets } from "../lib/brandIcon";
import { UserAvatar } from "./UserAvatar";
import { PromptImproveIcon, PromptImproveRail } from "./PromptEditorField";
import { cleanImprovedPrompt, promptImproverSystemPrompt } from "../lib/promptImprover";

/* Composer menus open upward; when the composer sits mid-screen (empty-chat
   layout on short or zoomed viewports) the menu's top rows can land above the
   viewport even with the CSS max-height clamp. Nudge the window just enough
   to reveal them. In the docked state the clamp alone guarantees fit, so this
   never fires and cannot disturb the reader's scroll position. Module-scoped
   so the ref callback identity is stable across renders. */
function revealComposerMenu(node: HTMLDivElement | null) {
  if (!node) return;
  /* The menu mounts mid entrance animation (apx-rise starts at
     translateY(10px)), so remove the in-flight translation to measure where
     the menu will settle. */
  const rect = node.getBoundingClientRect();
  const transform = getComputedStyle(node).transform;
  const settledTop =
    transform === "none" || typeof DOMMatrixReadOnly === "undefined"
      ? rect.top
      : rect.top - new DOMMatrixReadOnly(transform).m42;
  if (settledTop < 8) window.scrollBy({ top: settledTop - 8 });
}

type ConnectorDef = {
  id: string;
  /** Catalog connector behind this source; admins can hide it per workspace. */
  connectorId: string;
  label: string;
  icon: ConnectorIcon;
  blurb: string;
};
type ComposerTools = { Knowledge: boolean; Web: boolean; Agent: boolean };
type ComposerToolSummary = {
  key: string;
  label: string;
  title: string;
  icon: typeof BookOpen;
};
type PendingToolApproval = {
  toolIds: string[];
  toolNames: string[];
  agentName: string | null;
};
type CloudPickerStatus = "loading" | "connect" | "ready" | "error" | "importing";
type CloudPickerState = {
  source: ConnectorDef;
  status: CloudPickerStatus;
  items: CloudAttachmentItem[];
  selectedIds: string[];
  error: string | null;
  /** Provider consent URL when the user still needs to connect their own account. */
  connectUrl: string | null;
  /** True while the consent popup is open and we poll for the account to connect. */
  connectPending: boolean;
};
type TokenUsageTotals = {
  reportedReplies: number;
  prompt: number;
  completion: number;
  total: number;
};
type ContextWindowTone = "safe" | "danger" | "full" | "unknown";
type ContextWindowStatus = {
  usageTotals: TokenUsageTotals;
  contextTokens: number;
  contextWindow: number | null;
  progressPercent: number;
  displayPercent: string;
  label: string;
  detail: string;
  tooltip: string;
  tone: ContextWindowTone;
  isMeasured: boolean;
  /** True when the value is derived from message length instead of a
   * provider-reported token count; the UI labels it accordingly. */
  isEstimated: boolean;
  isFull: boolean;
};

const CONNECTORS: ConnectorDef[] = [
  {
    id: "google-drive",
    connectorId: "google-drive",
    label: "Google Drive",
    icon: GoogleDriveIcon,
    blurb: "Attach and cite documents from Google Drive.",
  },
  {
    id: "onedrive",
    connectorId: "microsoft-graph",
    label: "OneDrive",
    icon: OneDriveIcon,
    blurb: "Bring in files from Microsoft OneDrive.",
  },
  {
    id: "sharepoint",
    connectorId: "microsoft-graph",
    label: "SharePoint",
    icon: SharePointIcon,
    blurb: "Pull from SharePoint document libraries.",
  },
  {
    id: "box",
    connectorId: "box",
    label: "Box",
    icon: BoxIcon,
    blurb: "Connect Box folders for matter files.",
  },
  {
    id: "imanage",
    connectorId: "imanage",
    label: "iManage",
    icon: IManageIcon,
    blurb: "Reference work product from iManage.",
  },
];

function supportsWebSearch(data: BootstrapData, model: ModelConfig | undefined) {
  return webSearchSupportedForModel(data, model);
}

type PendingAttachment = ChatAttachment & {
  localId: string;
  file?: File;
  uploadStatus?: "ready" | "uploading" | "error";
  uploadError?: string;
};

/** A document or deck request held unsent until the user picks Drafts or
 * chat. It keeps the composer settings it was sent with. */
type PendingDraftHandoff = {
  id: string;
  kind: DraftHandoffOffer;
  threadId: string;
  text: string;
  attachments: PendingAttachment[];
  composerTools: ComposerTools;
  knowledgeBaseId: string | null;
  createdAtIso: string;
  phase: "choosing" | "drafts" | "chat";
  error: string | null;
};

let attachSeq = 0;
function nextAttachmentId() {
  attachSeq += 1;
  return `att-${attachSeq}-${Date.now()}`;
}

function formatTokenCount(value: number) {
  return value.toLocaleString();
}

function contextWindowForModel(model: ModelConfig | undefined): number | null {
  return typeof model?.context_window === "number" && model.context_window > 0 ? model.context_window : null;
}

function summarizeProviderTokenUsage(messages: ChatMessage[]): TokenUsageTotals {
  return messages.reduce(
    (totals, message) => {
      const activeMessage = messageWithActiveResponseVersion(message);
      if (activeMessage.role !== "assistant" || !activeMessage.usage) return totals;
      const promptTokens = activeMessage.usage.prompt_tokens ?? 0;
      const completionTokens = activeMessage.usage.completion_tokens ?? 0;
      totals.reportedReplies += 1;
      totals.prompt += promptTokens;
      totals.completion += completionTokens;
      totals.total += activeMessage.usage.total_tokens ?? promptTokens + completionTokens;
      return totals;
    },
    { reportedReplies: 0, prompt: 0, completion: 0, total: 0 },
  );
}

/* Personalization should never be invisible: if a stored memory shaped an
 * answer, or the assistant just learned something new, the user sees it right
 * under the reply rather than having to go looking. */
function MemoryNotes({ message }: { message: ChatMessage }) {
  const used = message.memoryUsed ?? 0;
  const saved = message.memorySaved ?? [];
  if (used === 0 && saved.length === 0) return null;
  return (
    <div className="message-memory-notes">
      {used > 0 && (
        <Pill tone="info" icon={<Brain size={13} />}>
          Personalized from {used} {used === 1 ? "memory" : "memories"}
        </Pill>
      )}
      {saved.map((notice) => (
        <span className="message-memory-saved" key={notice.id}>
          <Brain size={13} /> Saved to memory: {notice.content}
        </span>
      ))}
    </div>
  );
}

function providerContextTokens(message: ChatMessage): number | null {
  const activeMessage = messageWithActiveResponseVersion(message);
  if (activeMessage.role !== "assistant" || !activeMessage.usage) return null;
  const promptTokens = activeMessage.usage.prompt_tokens ?? 0;
  const completionTokens = activeMessage.usage.completion_tokens ?? 0;
  return activeMessage.usage.total_tokens ?? promptTokens + completionTokens;
}

function latestProviderContextTokens(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const totalTokens = providerContextTokens(messages[index]);
    if (totalTokens !== null) return totalTokens;
  }
  return 0;
}

function formatContextPercent(progressPercent: number, usedTokens: number) {
  if (usedTokens <= 0) return "0%";
  if (progressPercent > 0 && progressPercent < 1) return "<1%";
  if (progressPercent >= 100) return "100%";
  return `${Math.max(1, Math.floor(progressPercent))}%`;
}

/** The element whose scrollTop moves the conversation. The chat page has no
 * inner overflow container — it scrolls on the document itself — so the walk
 * falls back to document.scrollingElement. Pinning that scroller to its true
 * maximum rests the sticky composer at its natural in-flow position with the
 * newest content directly above it; aligning to the viewport bottom instead
 * (scrollIntoView "end") leaves the composer overlaying the last ~180px of
 * the reply, hiding the streaming edge behind it. */
function conversationScrollerFrom(node: HTMLElement | null): HTMLElement | null {
  let candidate = node?.parentElement ?? null;
  while (candidate) {
    const style = window.getComputedStyle(candidate);
    if (
      candidate.scrollHeight > candidate.clientHeight + 1 &&
      (style.overflowY === "auto" || style.overflowY === "scroll")
    ) {
      return candidate;
    }
    candidate = candidate.parentElement;
  }
  const doc = document.scrollingElement;
  return doc instanceof HTMLElement && doc.scrollHeight > doc.clientHeight + 1 ? doc : null;
}

/** Rough token count from message length (~4 characters per token) for chats
 * whose stored replies predate provider usage reporting. Display-only and
 * always labeled as an estimate; exact counts replace it on the next reply. */
function estimatedContextTokens(messages: ChatMessage[]): number {
  const characters = messages.reduce((sum, message) => {
    const activeMessage = messageWithActiveResponseVersion(message);
    return sum + (activeMessage.content?.length ?? 0);
  }, 0);
  return Math.round(characters / 4);
}

function buildContextWindowStatus(messages: ChatMessage[], model: ModelConfig | undefined): ContextWindowStatus {
  const usageTotals = summarizeProviderTokenUsage(messages);
  const contextTokens = latestProviderContextTokens(messages);
  const contextWindow = contextWindowForModel(model);
  if (!contextWindow) {
    return {
      usageTotals,
      contextTokens,
      contextWindow,
      progressPercent: 0,
      displayPercent: "—",
      label: "Context window unavailable",
      detail: "This model has no configured context window.",
      tooltip: "This model does not report a context window size.",
      tone: "unknown",
      isMeasured: false,
      isEstimated: false,
      isFull: false,
    };
  }
  if (usageTotals.reportedReplies === 0) {
    const estimatedTokens = estimatedContextTokens(messages);
    if (estimatedTokens <= 0) {
      return {
        usageTotals,
        contextTokens,
        contextWindow,
        progressPercent: 0,
        displayPercent: "—",
        label: "Context window not reported",
        detail: "Usage appears after the provider reports token counts.",
        tooltip: "Context window usage appears after the provider reports token counts.",
        tone: "unknown",
        isMeasured: false,
        isEstimated: false,
        isFull: false,
      };
    }
    const rawPercent = (estimatedTokens / contextWindow) * 100;
    const progressPercent = Math.min(Math.max(rawPercent, 0), 100);
    const isFull = rawPercent >= 100;
    const tone: ContextWindowTone = isFull ? "full" : rawPercent >= 80 ? "danger" : "safe";
    const basePercent = formatContextPercent(progressPercent, estimatedTokens);
    const displayPercent =
      basePercent === "<1%" || basePercent === "0%" ? basePercent : `~${basePercent}`;
    const label = isFull
      ? "Context window full (estimated)"
      : rawPercent >= 80
        ? "Context window getting full (estimated)"
        : "Context window healthy (estimated)";
    return {
      usageTotals,
      contextTokens: estimatedTokens,
      contextWindow,
      progressPercent,
      displayPercent,
      label,
      detail:
        "Estimated from this chat's message length — exact provider counts arrive with the next reply.",
      tooltip: `Context window about ${basePercent} used (estimated from message length). Turns red at 80%.`,
      tone,
      isMeasured: true,
      isEstimated: true,
      isFull,
    };
  }

  const rawPercent = (contextTokens / contextWindow) * 100;
  const progressPercent = Math.min(Math.max(rawPercent, 0), 100);
  const isFull = rawPercent >= 100;
  const tone: ContextWindowTone = isFull ? "full" : rawPercent >= 80 ? "danger" : "safe";
  const label = isFull
    ? "Context window full"
    : rawPercent >= 80
      ? "Context window getting full"
      : "Context window healthy";
  const detail = isFull
    ? "This session may stop using earlier details reliably."
    : rawPercent >= 80
      ? "Older details may start to matter less as the session fills up."
      : "There is still room for this session to keep more chat context in view.";
  const displayPercent = formatContextPercent(progressPercent, contextTokens);
  return {
    usageTotals,
    contextTokens,
    contextWindow,
    progressPercent,
    displayPercent,
    label,
    detail,
    tooltip: `Context window ${displayPercent} used. Turns red at 80%.`,
    tone,
    isMeasured: true,
    isEstimated: false,
    isFull,
  };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${index === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function describeFile(file: File): PendingAttachment {
  return {
    localId: nextAttachmentId(),
    file,
    name: file.name,
    size: formatBytes(file.size),
    kind: fileKind(file.name),
    mime_type: file.type || null,
    size_bytes: file.size,
    uploadStatus: "ready",
  };
}

function describeUploadedAttachment(attachment: ChatAttachment): PendingAttachment {
  return {
    ...attachment,
    localId: nextAttachmentId(),
    uploadStatus: "ready",
  };
}

/** The line under a staged file's name. */
function stagedAttachmentDetail(file: PendingAttachment) {
  const uploading = isMediaUploadFile(file.file ?? { name: file.name, type: file.mime_type ?? "" })
    ? " · Uploading and transcribing"
    : " · Uploading";
  const facts = [file.size, file.kind].filter(Boolean).join(" · ");
  if (file.uploadStatus === "uploading") return `${facts}${uploading}`;
  return file.uploadStatus === "error" ? `${facts} · Upload failed` : facts;
}

/** A # pick the server has not answered yet, so it has no id to send. */
function isArrivingAttachment(attachment: PendingAttachment) {
  return attachment.uploadStatus === "uploading" && !attachment.file;
}

function toChatAttachment(attachment: PendingAttachment): ChatAttachment {
  const {
    localId: _localId,
    file: _file,
    uploadStatus: _uploadStatus,
    uploadError: _uploadError,
    ...chatAttachment
  } = attachment;
  return chatAttachment;
}

async function copyPlainTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Embedded or non-secure browser contexts can expose clipboard but deny writes.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "-999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) {
    throw new Error("Clipboard unavailable");
  }
}

function absoluteClipboardUrl(value: string) {
  try {
    return new URL(value, window.location.href).href;
  } catch {
    return value;
  }
}

function richClipboardHtmlFromElement(element: HTMLElement) {
  const clone = element.cloneNode(true) as HTMLElement;

  clone.querySelectorAll<HTMLElement>("[class]").forEach((node) => node.removeAttribute("class"));
  clone.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((link) => {
    link.href = absoluteClipboardUrl(link.getAttribute("href") ?? link.href);
    link.removeAttribute("target");
    link.removeAttribute("rel");
  });
  clone.querySelectorAll<HTMLImageElement>("img[src]").forEach((image) => {
    image.src = absoluteClipboardUrl(image.getAttribute("src") ?? image.src);
    image.removeAttribute("loading");
    image.style.maxWidth = "100%";
    image.style.height = "auto";
  });
  clone.querySelectorAll<HTMLElement>("figure").forEach((figure) => {
    figure.style.margin = "0 0 12px";
  });
  clone.querySelectorAll<HTMLTableElement>("table").forEach((table) => {
    table.style.borderCollapse = "collapse";
    table.style.width = "100%";
  });
  clone.querySelectorAll<HTMLTableCellElement>("th,td").forEach((cell) => {
    cell.style.border = "1px solid #cfd6dc";
    cell.style.padding = "6px 8px";
    cell.style.textAlign = "left";
  });
  clone.querySelectorAll<HTMLPreElement>("pre").forEach((pre) => {
    pre.style.background = "#f5f9fa";
    pre.style.border = "1px solid #e2e9ee";
    pre.style.borderRadius = "6px";
    pre.style.padding = "10px";
    pre.style.whiteSpace = "pre-wrap";
  });
  clone.querySelectorAll<HTMLElement>("code").forEach((code) => {
    code.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
  });

  return clone.innerHTML.trim();
}

function clipboardHtmlDocument(fragment: string) {
  return `<!doctype html><html><body><!--StartFragment-->${fragment}<!--EndFragment--></body></html>`;
}

function copyElementSelectionToClipboard(element: HTMLElement) {
  if (typeof document.execCommand !== "function") return false;
  const selection = window.getSelection();
  if (!selection) return false;

  const previousRanges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange());
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);

  try {
    return document.execCommand("copy");
  } finally {
    selection.removeAllRanges();
    previousRanges.forEach((previousRange) => selection.addRange(previousRange));
  }
}

async function copyRichContentToClipboard(element: HTMLElement | null, plainText: string) {
  const htmlFragment = element ? richClipboardHtmlFromElement(element) : "";
  if (htmlFragment && navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([clipboardHtmlDocument(htmlFragment)], { type: "text/html" }),
          "text/plain": new Blob([plainText], { type: "text/plain" }),
        }),
      ]);
      return;
    } catch {
      // Rich clipboard writes can be denied even when the API is present.
    }
  }

  if (element && copyElementSelectionToClipboard(element)) return;
  await copyPlainTextToClipboard(plainText);
}

function messagePlainText(message: ChatMessage) {
  return markdownToPlainText(message.content) || message.content.trim();
}

/* ---------- Composer symbol commands (# / $ @) ---------- */

type ComposerCommandItem =
  | KnowledgeCommandItem
  | ({
      id: string;
      section: string;
      name: string;
      detail: string;
    } & (
      | { kind: "prompt"; prompt: PromptTemplate }
      | { kind: "mcp-tool"; tool: ToolConfig }
      | { kind: "skill"; skill: SkillFile }
      | { kind: "agent"; agent: ModelConfig }
      | { kind: "automation"; automation: Automation }
    ));

const COMMAND_MENU_TITLES: Record<ComposerCommandSymbol, string> = {
  "#": "Knowledge",
  "/": "Prompts and tools",
  $: "Skill files",
  "@": "Agents",
  ">": "Automations",
};
/** The symbol reference shared by the Resources guide and Session details. */
const COMPOSER_SHORTCUTS: ReadonlyArray<{ symbol: ComposerCommandSymbol; label: string; detail: string }> = [
  { symbol: "/", label: "Prompts & MCP connections", detail: "Insert a saved prompt or connected tool" },
  { symbol: "@", label: "Agents", detail: "Route the reply through an agent profile" },
  { symbol: "#", label: "Knowledge bases & files", detail: "Ground the answer in your knowledge" },
  { symbol: "$", label: "Skill files", detail: "Add a saved skill file to the message" },
  { symbol: ">", label: "Automations", detail: "Run an automation when you send" },
];
const COMPOSER_TEXTAREA_MAX_HEIGHT = 172;
/** Mirrors the backend limit: ChatCompletionRequest.fetch_urls max_length=3. */
const MAX_FETCH_URLS = 3;

/** Chip label for an attached link: scheme dropped, full URL kept in tooltips. */
function displayFetchUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "");
}

function automationScheduleLabel(automation: Automation): string {
  if (automation.trigger_type === "daily") {
    return `daily${automation.time_of_day ? ` at ${automation.time_of_day}` : ""}`;
  }
  if (automation.trigger_type === "weekly") {
    return `weekly${automation.weekly_day ? ` on ${automation.weekly_day}` : ""}`;
  }
  if (automation.trigger_type === "cron") {
    return automation.cron_expression ? `cron ${automation.cron_expression}` : "cron schedule";
  }
  return "scheduled once";
}

/** Finds an in-progress symbol command at the caret: a #, /, $, or @ that
 * starts a word, plus whatever has been typed after it. */
function commandItemIcon(item: ComposerCommandItem) {
  if (item.kind === "knowledge-base") return BookOpen;
  if (item.kind === "knowledge-file") return FileText;
  if (item.kind === "prompt") return ScrollText;
  if (item.kind === "mcp-tool") return Plug;
  if (item.kind === "skill") return Sparkles;
  return item.kind === "automation" ? Play : Bot;
}

/** Why a symbol other than # has nothing to offer. */
function emptyCommandText(token: ComposerCommandToken, connectors: BootstrapData["connectors"]) {
  if (token.query.trim()) return "No matching commands. Try another name.";
  if (token.symbol === "/") {
    const prompts = connectorEnabled(connectors, "prompt-library");
    const mcp = connectorEnabled(connectors, "mcp");
    if (!prompts && !mcp) return "The Prompt Library and MCP servers are turned off for this workspace";
    if (!prompts) return "The Prompt Library is turned off for this workspace — no MCP connections are enabled yet";
    if (!mcp) return "MCP servers are turned off for this workspace — no saved prompts yet";
    return "No saved prompts or enabled MCP connections yet — add them under Tools";
  }
  if (token.symbol === "$") return "No skill files saved yet — create one under Tools";
  if (token.symbol === ">") return "No automations yet — create one under Automations";
  return "No agent profiles available yet — create one under Agents";
}

function skillAttachmentFile(skill: SkillFile): File {
  const safeName = skill.name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
  return new File([skill.content], `${safeName}.md`, { type: "text/markdown" });
}

function feedbackLabel(rating: ChatFeedbackRating) {
  return rating === "positive" ? "Positive" : "Negative";
}

function truncatePreview(value: string, limit = 220) {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 1).trimEnd()}…`;
}

function readableError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function messageTimestamp(message: ChatMessage) {
  const iso = message.completedAt || message.createdAtIso || message.executedAt;
  return {
    label: iso ? formatTimeLabel(iso) : message.createdAt,
    title: iso ? formatTimestamp(iso) : message.createdAt,
    dateTime: iso ?? undefined,
  };
}

function runtimeOptionsFromState(
  data: BootstrapData,
  composerTools: ComposerTools,
  attachments: ChatAttachment[],
  selectedAgentId: string | null,
  selectedKnowledgeBaseId: string | null,
  selectedToolIds: string[] = [],
  reasoningEffort: "minimal" | "high" | null = null,
): ChatRuntimeOptions {
  const knowledgeEnabled = composerTools.Knowledge;
  const selectedAgent =
    composerTools.Agent && selectedAgentId ? agentProfileOptions(data).find((model) => model.id === selectedAgentId) : undefined;
  const agentKnowledgeIds = selectedAgent ? modelKnowledgeIds(selectedAgent) : [];
  const agentToolIds = selectedAgent ? modelToolIds(selectedAgent) : [];
  const enabledKnowledgeBases = data.knowledgeBases.filter((knowledge) => knowledge.enabled);
  const selectedKnowledgeBase =
    enabledKnowledgeBases.find((knowledge) => knowledge.id === selectedKnowledgeBaseId) ?? enabledKnowledgeBases[0];
  const selectedKnowledgeIds = selectedKnowledgeBase ? [selectedKnowledgeBase.id] : [];
  // Only tools this user may actually run: turned on, shared with one of
  // their groups (or theirs), and not behind a switched-off MCP connector.
  // Sending anything else made the server refuse the whole Agent-mode turn.
  const lockHermes = hermesLocked(data);
  const usableTools = data.tools.filter((tool) => toolUsableBy(data.me, tool)
    && (!isMcpRuntimeTool(tool) || connectorEnabled(data.connectors, "mcp"))
    && !(lockHermes && isHermesTool(tool)));
  const usableToolIds = new Set(usableTools.map((tool) => tool.id));
  const requestedToolIds = selectedToolIds.filter((id) => usableToolIds.has(id));
  const agentEnabled = composerTools.Agent || requestedToolIds.length > 0;
  const baseToolIds =
    composerTools.Agent && selectedAgent
      ? agentToolIds.filter((id) => usableToolIds.has(id))
      : composerTools.Agent
        ? usableTools.map((tool) => tool.id)
        : [];
  return {
    agentProfileId: agentEnabled && selectedAgent ? selectedAgent.id : null,
    modelOverride: agentEnabled && selectedAgent ? selectedAgent.id : null,
    knowledgeConfigIds:
      agentEnabled && selectedAgent ? agentKnowledgeIds : knowledgeEnabled ? selectedKnowledgeIds : [],
    toolConfigIds: [...new Set([...baseToolIds, ...requestedToolIds])],
    webEnabled: composerTools.Web,
    agentEnabled,
    citationsEnabled: true,
    attachmentIds: attachments.map((file) => file.id).filter((id): id is string => Boolean(id)),
    attachmentNames: attachments.map((file) => file.name),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function pendingMcpApprovalFromState(
  data: BootstrapData,
  composerTools: ComposerTools,
  selectedAgentId: string | null,
  selectedKnowledgeBaseId: string | null,
  selectedToolIds: string[],
  activeModelId?: string | null,
): PendingToolApproval | null {
  // Deliberately not gated on the cached MCP connector flag. This bootstrap
  // copy goes stale the moment an admin enables MCP, and skipping the prompt
  // on stale state sent the request unapproved — the server then refused it
  // with a 403 the user could not act on. Always prompt; the server remains
  // the authority and answers an actually-disabled connector with its own
  // honest "MCP servers are turned off for this workspace" error.
  const runtime = runtimeOptionsFromState(
    data,
    composerTools,
    [],
    selectedAgentId,
    selectedKnowledgeBaseId,
    selectedToolIds,
  );
  // Mirror the server's profile resolution: with agent mode on and no explicit
  // agent picked, a model carrying its own tools IS the agent profile, so the
  // server attaches those tools and requires approval for them. Selecting such
  // an agent from the model dropdown left the client blind to them — it sent
  // the turn unapproved and the server refused with a 403 the user could not
  // act on.
  const activeModel = activeModelId ? data.models.find((model) => model.id === activeModelId) : undefined;
  const profileToolIds =
    !runtime.agentProfileId && runtime.agentEnabled && activeModel ? modelToolIds(activeModel) : [];
  const approvalTools = [...new Set([...(runtime.toolConfigIds ?? []), ...profileToolIds])]
    .map((id) => data.tools.find((tool) => tool.id === id))
    .filter((tool): tool is ToolConfig => Boolean(tool))
    .filter((tool) => toolUsableBy(data.me, tool) && tool.approval_required && isMcpRuntimeTool(tool));
  if (approvalTools.length === 0) return null;
  const selectedAgent =
    composerTools.Agent && selectedAgentId ? agentProfileOptions(data).find((model) => model.id === selectedAgentId) : undefined;
  return {
    toolIds: [...new Set(approvalTools.map((tool) => tool.id))],
    toolNames: approvalTools.map((tool) => tool.name),
    agentName: selectedAgent?.name ?? null,
  };
}

function chatTitleCollidesWithActions(
  titleWidth: number,
  rowWidth: number,
  actionsWidth: number,
  gap: number,
) {
  if (actionsWidth <= 0 || rowWidth <= 0) return false;
  return titleWidth > rowWidth - actionsWidth - gap;
}

function ChatTitleDisplay({
  title,
  showRename,
  showAiRename,
  renameDisabled,
  aiRenameDisabled,
  aiRenaming,
  onRename,
  onAiRename,
}: {
  title: string;
  showRename: boolean;
  showAiRename: boolean;
  renameDisabled: boolean;
  aiRenameDisabled: boolean;
  aiRenaming: boolean;
  onRename: () => void;
  onAiRename: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  const [collides, setCollides] = useState(false);

  useLayoutEffect(() => {
    const row = rowRef.current;
    const label = titleRef.current;
    if (!row || !label) {
      setCollides(false);
      return;
    }

    const update = () => {
      const actions = row.querySelector(".chat-title-actions");
      if (!(actions instanceof HTMLElement)) {
        setCollides(false);
        return;
      }
      const gap = Number.parseFloat(getComputedStyle(row).gap) || 0;
      setCollides(
        chatTitleCollidesWithActions(
          label.getBoundingClientRect().width,
          row.clientWidth,
          actions.offsetWidth,
          gap,
        ),
      );
    };

    update();
    if (typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(row);
    observer.observe(label);
    const actions = row.querySelector(".chat-title-actions");
    if (actions) observer.observe(actions);
    return () => observer.disconnect();
  }, [title, showRename, showAiRename]);

  return (
    <div
      ref={rowRef}
      className={`chat-title-display${collides ? " is-colliding" : ""}`}
    >
      <h1 data-tooltip={title}>
        <span ref={titleRef} className="chat-title-label">
          {title}
        </span>
      </h1>
      {showRename && (
        <div className="chat-title-actions">
          <button
            className="chat-title-rename-button"
            type="button"
            aria-label="Rename chat"
            data-tooltip="Rename this chat everywhere it appears"
            disabled={renameDisabled}
            onClick={onRename}
          >
            <Pencil size={14} />
          </button>
          {showAiRename && (
            <button
              className="chat-title-rename-button"
              type="button"
              aria-label="Rename chat with AI"
              data-tooltip="Let AI rename this chat from the latest conversation"
              disabled={aiRenameDisabled}
              onClick={onAiRename}
            >
              {aiRenaming ? (
                <Loader2 size={14} className="chat-title-ai-spinner" />
              ) : (
                <Sparkles size={14} />
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ChatWorkspace({
  data,
  chat,
  brandName,
  brand,
  requestedAgentId,
  onRequestedAgentConsumed,
  onTransferToDraft,
  onSendToDrafts,
  onExplainModelAccess,
}: {
  data: BootstrapData;
  chat: ChatStore;
  brandName?: string | null;
  /** Logo and icon; defaults to the current tenant's. */
  brand?: BrandAssets | null;
  requestedAgentId?: string | null;
  onRequestedAgentConsumed?: () => void;
  onTransferToDraft?: (message: ChatMessage, format: DraftTransferFormat) => void;
  /** Starts a held document or deck request in Drafts instead of chat. */
  onSendToDrafts?: (request: DraftHandoffRequest) => void;
  /** Opens "Models in your organization" (why a model is not listed). */
  onExplainModelAccess?: () => void;
}) {
  const { activeThread, isSending, composerFocusToken } = chat;
  const [draft, setDraft] = useState("");
  const [editingThreadTitle, setEditingThreadTitle] = useState(false);
  const [threadTitleDraft, setThreadTitleDraft] = useState("");
  const [threadTitleSaving, setThreadTitleSaving] = useState(false);
  const [threadTitleGenerating, setThreadTitleGenerating] = useState(false);
  const [threadTitleError, setThreadTitleError] = useState<string | null>(null);
  const [isInspectorOpen, setIsInspectorOpen] = useState(false);
  const [citationDetailsOpen, setCitationDetailsOpen] = useState(false);
  const [focusedCitationMessageId, setFocusedCitationMessageId] = useState<string | null>(null);
  const { openDocument, documentViewerLayer } = useKnowledgeDocumentViewer(data.me.id);
  // Web search defaults on whenever the selected model supports it; an
  // effect below turns it back off if the user routes to an unsupported model.
  const [composerTools, setComposerTools] = useState<ComposerTools>(() => ({
    Knowledge: false,
    Web: webSearchSupportedForModel(
      data,
      chat.enabledModels.find((model) => model.id === chat.model),
    ),
    Agent: false,
  }));
  const [selectedKnowledgeBaseId, setSelectedKnowledgeBaseId] = useState<string | null>(null);
  const [knowledgePickerOpen, setKnowledgePickerOpen] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  // Fast–Smart reasoning level for the composer; sticky per user.
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>(() => loadReasoningLevel(data.me.id));
  // Show replies as they stream in; sticky per user, display-only.
  const [streamResponses, setStreamResponses] = useState(() => loadLiveStreamPreference(data.me.id));
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const stagedAttachmentsRef = useRef(attachments);
  stagedAttachmentsRef.current = attachments;
  const [isUploadingAttachments, setIsUploadingAttachments] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Ad-hoc web pages (≤3) fetched server-side as [U#] sources for the next message.
  const [fetchUrls, setFetchUrls] = useState<string[]>([]);
  const [linkComposerOpen, setLinkComposerOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  // User message currently open in the inline prompt editor, if any.
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [dictationError, setDictationError] = useState<string | null>(null);
  const [isImproving, setIsImproving] = useState(false);
  const [improveRail, setImproveRail] = useState<"off" | "run" | "done">("off");
  const [improveProgress, setImproveProgress] = useState(0);
  const [improveError, setImproveError] = useState<string | null>(null);
  const [originalDraft, setOriginalDraft] = useState<string | null>(null);
  const [isComposerExpanded, setIsComposerExpanded] = useState(false);
  const [pendingToolApproval, setPendingToolApproval] = useState<PendingToolApproval | null>(null);
  const [toolApprovalNotice, setToolApprovalNotice] = useState<string | null>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  // Sources this workspace's admins hid never appear; the API refuses them too.
  const attachSources = useMemo(
    () => CONNECTORS.filter((source) => !connectorHidden(data.connectors, source.connectorId)),
    [data.connectors],
  );
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const [cloudPicker, setCloudPicker] = useState<CloudPickerState | null>(null);
  const [sendMenuTab, setSendMenuTab] = useState<SendMenuTab>("settings");
  const resourceBrowserOpen = sendMenuOpen && sendMenuTab === "resources";
  const [shortcutQuery, setShortcutQuery] = useState("");
  const [resourceView, setResourceView] = useState<ResourceView>("tiles");
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>([]);
  const [pendingAutomations, setPendingAutomations] = useState<Automation[]>([]);
  const commandListId = useId();
  const [customToolRun, setCustomToolRun] = useState<CustomToolRunState | null>(null);
  const [pendingHandoff, setPendingHandoff] = useState<PendingDraftHandoff | null>(null);
  const pendingHandoffRef = useRef<PendingDraftHandoff | null>(null);
  pendingHandoffRef.current = pendingHandoff;
  const [handoffNudged, setHandoffNudged] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const {
    token: commandToken,
    index: commandIndex,
    setIndex: setCommandIndex,
    update: updateCommandToken,
    clear: clearCommandToken,
    handleKey: handleCommandKey,
  } = useComposerCommandToken(textareaRef);
  const expandedComposerRef = useRef<HTMLFormElement | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);
  useModalFocus(expandedComposerRef, isComposerExpanded, () => { if (!isImproving) setIsComposerExpanded(false); });
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachRef = useRef<HTMLDivElement | null>(null);
  const sendRef = useRef<HTMLDivElement | null>(null);
  const sendMenuRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(sendMenuRef, sendMenuOpen, () => setSendMenuOpen(false));
  useLayoutEffect(() => {
    if (!sendMenuOpen) return;
    const viewport = window.visualViewport;
    const position = () => {
      const menu = sendMenuRef.current;
      const composer = textareaRef.current?.closest(".composer");
      if (!menu || !composer) return;
      // The on-screen keyboard shrinks the visual viewport on phones.
      const width = viewport?.width ?? innerWidth;
      const availableHeight = viewport?.height ?? innerHeight;
      const leftEdge = viewport?.offsetLeft ?? 0;
      const topEdge = viewport?.offsetTop ?? 0;
      menu.style.maxHeight = `${Math.max(0, availableHeight - 24)}px`;
      menu.style.maxWidth = `${Math.max(0, width - 24)}px`;
      const rect = composer.getBoundingClientRect();
      const height = menu.offsetHeight;
      const top = rect.top - topEdge >= height + 20 ? rect.top - height - 8
        : rect.bottom + height + 20 <= topEdge + availableHeight ? rect.bottom + 8
        : topEdge + Math.max(12, (availableHeight - height) / 2);
      menu.style.left = `${Math.max(leftEdge + 12, Math.min(rect.right - menu.offsetWidth, leftEdge + width - menu.offsetWidth - 12))}px`;
      menu.style.top = `${Math.max(topEdge + 12, Math.min(top, topEdge + availableHeight - height - 12))}px`;
    };
    position();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(position) : null;
    if (sendMenuRef.current) observer?.observe(sendMenuRef.current);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
    };
  }, [sendMenuOpen]);
  const cloudConnectPollRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (cloudConnectPollRef.current !== null) window.clearInterval(cloudConnectPollRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!isImproving) return;
    setImproveRail("run");
    setImproveProgress(7);
    const started = Date.now();
    const tick = window.setInterval(() => {
      const elapsed = Date.now() - started;
      setImproveProgress(7 + 83 * (1 - Math.exp(-elapsed / 4500)));
    }, 80);
    return () => window.clearInterval(tick);
  }, [isImproving]);

  useEffect(() => {
    if (isImproving || improveRail !== "run") return;
    setImproveProgress(100);
    setImproveRail("done");
    const hide = window.setTimeout(() => setImproveRail("off"), 4500);
    const reset = window.setTimeout(() => setImproveProgress(0), 5300);
    return () => {
      window.clearTimeout(hide);
      window.clearTimeout(reset);
    };
  }, [isImproving, improveRail]);

  useEffect(() => {
    if (!isComposerExpanded) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    textareaRef.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isComposerExpanded]);
  const width = useViewportWidth();
  const inspectorOverlay = width <= BREAKPOINTS.inspectorOverlay;

  const customScriptTools = useMemo(
    () => data.tools.filter((tool) => tool.type === "custom_script" && toolUsableBy(data.me, tool)),
    [data.me, data.tools],
  );

  useEffect(() => {
    setEditingThreadTitle(false);
    setThreadTitleDraft(activeThread?.title ?? "");
    setThreadTitleSaving(false);
    setThreadTitleError(null);
    setEditingPromptId(null);
    setOriginalDraft(null);
    setIsComposerExpanded(false);
  }, [activeThread?.id]);

  async function runCustomToolOnMessage(tool: ToolConfig, message: ChatMessage) {
    setCustomToolRun({ tool, status: "running", result: null, error: null });
    try {
      const result = await runCustomScriptTool(data.me.id, tool.id, message.content);
      setCustomToolRun({ tool, status: "done", result, error: null });
    } catch (error) {
      setCustomToolRun({
        tool,
        status: "error",
        result: null,
        error: error instanceof Error ? error.message : "The tool did not run.",
      });
    }
  }

  const messages = activeThread?.messages ?? [];
  const hasMessages = messages.length > 0;
  // A held Drafts offer shows as the first exchange of a new chat.
  const showConversation = hasMessages || Boolean(pendingHandoff);
  // The AI naming button appears only once the chat has a finalized exchange;
  // pending or errored replies never unlock it.
  const hasCompletedAssistantReply = messages.some(
    (message) => message.role === "assistant" && (message.status ?? "ok") === "ok",
  );
  const citations = messages.flatMap((message) => messageWithActiveResponseVersion(message).citations ?? []);
  const hasCitations = citations.length > 0;
  // Empty for image-only branding, where the logo already spells the name.
  const assistantBrandName = (brandName ?? data.currentTenant.chat_brand_name ?? DEFAULT_BRAND_NAME).trim();
  const assistantLabel = assistantBrandName || DEFAULT_BRAND_NAME;
  const assistantBrand = brand ?? data.currentTenant;
  const assistantLockup = brandLockup({ ...assistantBrand, chat_brand_name: assistantBrandName });
  const assistantIconSources = compactBrandSources(assistantBrand);
  const agentProfiles = agentProfileOptions(data);
  const lockedHermesAgents = lockedHermesAgentProfiles(data);
  const selectedAgent = selectedAgentId ? agentProfiles.find((agent) => agent.id === selectedAgentId) : undefined;
  const selectedModel = chat.enabledModels.find((model) => model.id === chat.model);
  // Code blocks in replies call the chat's selected model for AI edits, as
  // their own request: nothing is added to the thread.
  const codeEditAssist = useMemo<CodeEditAssist>(
    () => ({
      agentName: selectedModel?.name ?? "AI",
      unavailableReason: chat.model ? null : "Choose a model in the composer to edit code with AI.",
      request: async (wireMessages, { signal, onDelta }) => {
        const reply = await sendChatStream(data.me.id, {
          model: chat.model,
          messages: wireMessages,
          signal,
          onDelta,
          runtime: { surface: "chat", webEnabled: false, citationsEnabled: false, maxCompletionTokens: 6000 },
        });
        return reply.content;
      },
    }),
    [chat.model, data.me.id, selectedModel?.name],
  );
  const contextWindowStatus = buildContextWindowStatus(messages, selectedModel);
  const activeRouteModel = composerTools.Agent && selectedAgent ? selectedAgent : selectedModel;
  const webSearchAvailable = supportsWebSearch(data, activeRouteModel);
  const enabledKnowledgeBases = data.knowledgeBases.filter((knowledge) => knowledge.enabled);
  // MCP servers this workspace can actually run. The workspace connector is a
  // real kill switch, so an admin turning MCP off empties this and disables
  // the composer switch rather than offering a control that cannot work.
  const availableMcpServers = usableMcpTools(data);
  const selectedKnowledgeBase = selectedKnowledgeBaseId
    ? enabledKnowledgeBases.find((knowledge) => knowledge.id === selectedKnowledgeBaseId)
    : undefined;
  const selectedToolKey = selectedToolIds.join("|");
  const availableMcpKey = JSON.stringify(availableMcpServers.map((tool) => tool.id));
  useEffect(() => {
    const available = new Set<string>(JSON.parse(availableMcpKey));
    setSelectedToolIds((current) => current.every((id) => available.has(id)) ? current : current.filter((id) => available.has(id)));
  }, [availableMcpKey]);

  // Focus the composer when a new chat is started or a thread is opened.
  useEffect(() => {
    textareaRef.current?.focus();
  }, [composerFocusToken, activeThread?.id]);

  // Grow by up to one CSS inch with the draft, then keep longer prompts
  // reachable with an internal scrollbar. Layout effect avoids a one-frame
  // flash at the previous height after pasting or clearing a long prompt.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const contentHeight = textarea.scrollHeight;
    textarea.style.height = `${Math.min(contentHeight, COMPOSER_TEXTAREA_MAX_HEIGHT)}px`;
    textarea.style.overflowY = contentHeight > COMPOSER_TEXTAREA_MAX_HEIGHT ? "auto" : "hidden";
  }, [draft]);

  useEffect(() => {
    setPendingToolApproval(null);
    setToolApprovalNotice(null);
  }, [activeThread?.id, composerTools.Agent, draft, selectedAgentId, selectedToolKey]);

  // Keep the conversation pinned to the latest message. Scrolling the
  // resolved container to its true maximum (not scrollIntoView "end") keeps
  // the newest message above the sticky composer instead of behind it.
  useEffect(() => {
    if (!showConversation) return;
    const target = conversationScrollerFrom(bottomRef.current);
    if (target) target.scrollTo({ top: target.scrollHeight, behavior: "smooth" });
    else bottomRef.current?.scrollIntoView?.({ block: "end", behavior: "smooth" });
  }, [activeThread?.id, messages.length, showConversation, isSending, pendingHandoff?.id]);

  // Opening another chat, or starting a new one, returns a held request to
  // the composer instead of leaving it attached to the wrong conversation.
  const handoffFocusTokenRef = useRef(composerFocusToken);
  useEffect(() => {
    const newChatStarted = handoffFocusTokenRef.current !== composerFocusToken;
    handoffFocusTokenRef.current = composerFocusToken;
    const pending = pendingHandoffRef.current;
    if (!pending || (pending.threadId === chat.activeId && !newChatStarted)) return;
    setPendingHandoff(null);
    restoreHandoffToComposer(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.activeId, composerFocusToken]);

  useEffect(() => {
    if (!handoffNudged) return;
    const timer = window.setTimeout(() => setHandoffNudged(false), 900);
    return () => window.clearTimeout(timer);
  }, [handoffNudged]);

  // While a reply streams in, keep the reader hard-pinned to the bottom
  // every frame so the text never runs past their view. Pausing is driven
  // by reader intent — a scroll that lands above where the pin left it —
  // never by how far the content has grown: a distance-based opt-out
  // misread fast token bursts as "the user scrolled away" and stranded the
  // view mid-stream. Returning to the bottom resumes following.
  const lastMessage = messages[messages.length - 1];
  const followStreaming = streamResponses && lastMessage?.status === "pending";
  useEffect(() => {
    if (!followStreaming) return;
    let scroller: HTMLElement | null = null;
    const resolveScroller = () => {
      if (scroller?.isConnected) return scroller;
      scroller = conversationScrollerFrom(bottomRef.current);
      return scroller;
    };
    let paused = false;
    let lastPinnedTop = Number.POSITIVE_INFINITY;
    const handleScroll = () => {
      // Growth and the pin only ever move the scroll position down; a
      // position above the last pin is the reader scrolling up themselves.
      if (scroller && scroller.scrollTop < lastPinnedTop - 4) paused = true;
    };
    // The document scroller emits its scroll events on window, not on the
    // scrolling element itself; inner overflow containers emit their own.
    let listenerTarget: EventTarget | null = null;
    const listenerFor = (target: HTMLElement): EventTarget =>
      target === document.scrollingElement ? window : target;
    let frame = window.requestAnimationFrame(function follow() {
      const target = resolveScroller();
      if (target && listenerTarget !== listenerFor(target)) {
        listenerTarget?.removeEventListener("scroll", handleScroll);
        listenerTarget = listenerFor(target);
        listenerTarget.addEventListener("scroll", handleScroll, { passive: true });
      }
      if (target) {
        if (paused) {
          if (target.scrollHeight - target.scrollTop - target.clientHeight < 48) {
            paused = false;
          }
        } else if (target.scrollHeight - target.scrollTop - target.clientHeight > 1) {
          // Write scrollTop only when growth actually left a gap: a redundant
          // per-frame write forces layout/compositing work every frame, which
          // reads as jerky, flashing rendering on mobile GPUs.
          target.scrollTop = target.scrollHeight;
          lastPinnedTop = target.scrollTop;
        } else {
          lastPinnedTop = target.scrollTop;
        }
      } else if (!paused) {
        bottomRef.current?.scrollIntoView?.({ block: "end", behavior: "auto" });
      }
      frame = window.requestAnimationFrame(follow);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      listenerTarget?.removeEventListener("scroll", handleScroll);
    };
  }, [activeThread?.id, followStreaming]);

  useEffect(() => {
    if (hasCitations) return;
    setCitationDetailsOpen(false);
    setFocusedCitationMessageId(null);
  }, [hasCitations]);

  useEffect(() => {
    if (!focusedCitationMessageId) return;
    const hasFocusedMessage = messages.some(
      (message) =>
        message.id === focusedCitationMessageId &&
        (messageWithActiveResponseVersion(message).citations?.length ?? 0) > 0,
    );
    if (hasFocusedMessage) return;
    setFocusedCitationMessageId(null);
    setCitationDetailsOpen(false);
  }, [focusedCitationMessageId, messages]);

  useEffect(() => {
    if (!composerTools.Agent) return;
    if (selectedAgentId && agentProfiles.some((agent) => agent.id === selectedAgentId)) return;
    setSelectedAgentId(agentProfiles[0]?.id ?? null);
  }, [agentProfiles, composerTools.Agent, selectedAgentId]);

  useEffect(() => {
    if (!composerTools.Knowledge) return;
    if (
      selectedKnowledgeBaseId &&
      enabledKnowledgeBases.some((knowledge) => knowledge.id === selectedKnowledgeBaseId)
    ) {
      return;
    }
    setSelectedKnowledgeBaseId(enabledKnowledgeBases[0]?.id ?? null);
  }, [composerTools.Knowledge, enabledKnowledgeBases, selectedKnowledgeBaseId]);

  useEffect(() => {
    if (webSearchAvailable || !composerTools.Web) return;
    setComposerTools((current) => ({ ...current, Web: false }));
  }, [composerTools.Web, webSearchAvailable]);

  // Opening a fresh chat re-arms the web search default, so turning it off
  // only lasts for the chat where it was turned off.
  useEffect(() => {
    if (!activeThread || activeThread.messages.length > 0) return;
    setComposerTools((current) => ({
      ...current,
      Web: webSearchSupportedForModel(
        data,
        chat.enabledModels.find((model) => model.id === chat.model),
      ),
    }));
    // Deliberately narrow deps: only a new-chat signal should re-arm the
    // default, not mid-chat model or data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerFocusToken, activeThread?.id]);

  useEffect(() => {
    if (!requestedAgentId) return;
    if (agentProfiles.some((agent) => agent.id === requestedAgentId)) {
      setSelectedAgentId(requestedAgentId);
      setComposerTools((current) => ({ ...current, Agent: true }));
    }
    onRequestedAgentConsumed?.();
  }, [agentProfiles, onRequestedAgentConsumed, requestedAgentId]);

  // Close transient composer menus on outside click / Escape.
  useEffect(() => {
    if (!attachMenuOpen && !sendMenuOpen) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (attachMenuOpen && attachRef.current && !attachRef.current.contains(target)) {
        setAttachMenuOpen(false);
      }
      if (sendMenuOpen && sendRef.current && !sendRef.current.contains(target) && !sendMenuRef.current?.contains(target)) {
        setSendMenuOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setAttachMenuOpen(false);
        setSendMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [attachMenuOpen, sendMenuOpen]);

  const knowledgeCommandOpen = commandToken?.symbol === "#" || (resourceBrowserOpen && resourceViewLoadsKnowledgeFiles(resourceView));
  const knowledgeFiles = useKnowledgeFiles({
    userId: data.me.id,
    tenantId: data.currentTenant.id,
    open: knowledgeCommandOpen,
    bases: enabledKnowledgeBases,
  });

  const commandItems = useMemo<ComposerCommandItem[]>(() => {
    function itemsForToken(commandToken: Pick<ComposerCommandToken, "symbol" | "query">): ComposerCommandItem[] {
    const query = commandToken.query;
    if (commandToken.symbol === "#") return knowledgeCommandItems(enabledKnowledgeBases, knowledgeFiles.docs, query);
    if (commandToken.symbol === "/") {
      // Workspace kill switches: disabled connectors remove these sections
      // from the palette entirely — off is off, for View-as previews too.
      const prompts = connectorEnabled(data.connectors, "prompt-library")
        ? data.promptTemplates.filter((prompt) => prompt.enabled)
        : [];
      const mcpTools = usableMcpTools(data);
      return [
        ...rankCommandMatches(prompts, (prompt) => prompt.name, query).map((prompt) => ({
          kind: "prompt" as const,
          id: `prompt-${prompt.id}`,
          section: "Prompts",
          name: prompt.name,
          detail: prompt.description || prompt.category,
          prompt,
        })),
        ...rankCommandMatches(mcpTools, (tool) => tool.name, query).map((tool) => ({
          kind: "mcp-tool" as const,
          id: `tool-${tool.id}`,
          section: "MCP connections",
          name: tool.name,
          detail: tool.description || "MCP server",
          tool,
        })),
      ];
    }
    if (commandToken.symbol === "$") {
      const skills = data.skillFiles.filter((skill) => skill.enabled);
      return rankCommandMatches(skills, (skill) => skill.name, query).map((skill) => ({
        kind: "skill" as const,
        id: `skill-${skill.id}`,
        section: "Skill files",
        name: skill.name,
        detail: skill.description || skill.category,
        skill,
      }));
    }
    if (commandToken.symbol === ">") {
      // Paused automations are listed too — ">" is an explicit manual run,
      // same as the console's Run now button.
      return rankCommandMatches(data.automations, (automation) => automation.name, query).map((automation) => ({
        kind: "automation" as const,
        id: `automation-${automation.id}`,
        section: "Automations",
        name: automation.name,
        detail: `${automation.enabled ? automationScheduleLabel(automation) : "paused"} · runs your message when you send`,
        automation,
      }));
    }
    return rankCommandMatches(agentProfiles, (agent) => agent.name, query).map((agent) => ({
      kind: "agent" as const,
      id: `agent-${agent.id}`,
      section: "Agents",
      name: agent.name,
      detail: agent.notes?.trim() || agent.provider_name || "Agent profile",
      agent,
    }));
    }
    if (commandToken) return itemsForToken(commandToken);
    if (!resourceBrowserOpen) return [];
    const typed = detectComposerCommandToken(shortcutQuery, shortcutQuery.length);
    const symbols: ComposerCommandToken["symbol"][] = typed ? [typed.symbol] : ["/", "@", "#", "$", ">"];
    return symbols.flatMap((symbol) => itemsForToken({ symbol, query: typed?.query ?? shortcutQuery }))
      .filter((item) => resourceListShows(resourceView, item.section));
  }, [
    resourceBrowserOpen, shortcutQuery, resourceView, data.connectors,
    commandToken,
    enabledKnowledgeBases,
    knowledgeFiles.docs,
    data.promptTemplates,
    data.tools,
    data.skillFiles,
    data.automations,
    agentProfiles,
  ]);

  const commandSections = useMemo(() => groupCommandSections(commandItems), [commandItems]);

  // With a bare symbol (no query yet) the menu stays open even when the
  // library is empty, so the empty-state hint teaches what the symbol does.
  const commandMenuRef = useRef<HTMLDivElement>(null);
  const commandMenuVisible =
    commandToken !== null;

  useCommandMenuFit({
    open: commandMenuVisible,
    menuRef: commandMenuRef,
    textareaRef,
    composerSelector: "form.composer",
    ceilingSelector: ".workspace-header",
    ceilingEdge: "bottom",
    keepCaretInView: isComposerExpanded,
    contentKey: `${commandToken?.start}:${commandToken?.query}:${attachments.length}:${commandItems.length}`,
  });

  // Keep the highlight on a real row as filtering narrows the list.
  useEffect(() => {
    setCommandIndex((current) => Math.min(current, Math.max(commandItems.length - 1, 0)));
  }, [commandItems.length]);

  function applyCommandItem(item: ComposerCommandItem) {
    let replacement = "";
    if (item.kind === "knowledge-base" || item.kind === "knowledge-file") {
      void pullInKnowledge(item);
    } else if (item.kind === "prompt") {
      replacement = `${item.prompt.content.trimEnd()} `;
    } else if (item.kind === "mcp-tool") {
      setSelectedToolIds((current) => (current.includes(item.tool.id) ? current : [...current, item.tool.id]));
    } else if (item.kind === "skill") {
      setAttachments((prev) => [...prev, describeFile(skillAttachmentFile(item.skill))]);
    } else if (item.kind === "automation") {
      setPendingAutomations((current) =>
        current.some((entry) => entry.id === item.automation.id) ? current : [...current, item.automation],
      );
    } else {
      setComposerTools((current) => ({ ...current, Agent: true }));
      setSelectedAgentId(item.agent.id);
      replacement = `@${item.name} `;
    }
    const caret = textareaRef.current?.selectionStart ?? draft.length;
    const applied = applyCommandText(draft, commandToken?.start ?? null, caret, replacement);
    if (item.kind !== "mcp-tool" && item.kind !== "automation") setSendMenuOpen(false);
    setDraft(applied.text);
    clearCommandToken();
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      if (!resourceBrowserOpen || (item.kind !== "mcp-tool" && item.kind !== "automation")) textarea.focus();
      textarea.setSelectionRange(applied.caret, applied.caret);
    });
  }

  /** The file or base joins the message as a block that points at it. */
  async function pullInKnowledge(item: Extract<ComposerCommandItem, { kind: "knowledge-base" | "knowledge-file" }>) {
    const documentId = item.kind === "knowledge-file" ? item.doc.id : undefined;
    const localId = `knowledge:${item.base.id}:${documentId ?? ""}`;
    if (stagedAttachmentsRef.current.some((staged) => staged.localId === localId)) return;
    setUploadError(null);
    setAttachments((prev) => [
      ...prev,
      {
        localId,
        name: item.name,
        size: "",
        kind: documentId ? fileKind(item.name) : "Knowledge",
        uploadStatus: "uploading",
      },
    ]);
    try {
      const saved = await attachKnowledge(data.me.id, {
        knowledge_config_id: item.base.id,
        document_id: documentId,
      });
      if (!stagedAttachmentsRef.current.some((staged) => staged.localId === localId)) {
        if (saved.id) takeBackAttachment(saved.id);
        return;
      }
      setAttachments((prev) =>
        prev.map((staged) => (staged.localId === localId ? { ...saved, localId, uploadStatus: "ready" } : staged)),
      );
    } catch (error) {
      setAttachments((prev) => prev.filter((staged) => staged.localId !== localId));
      setUploadError(readableError(error, `Could not attach ${item.name}.`));
    }
  }

  // The model the next send targets: the agent profile when Agent mode is on,
  // otherwise the workspace-selected model. The reasoning slider only engages
  // for models with real reasoning control; the API enforces the same gate.
  const reasoningTargetModel =
    composerTools.Agent && selectedAgentId
      ? data.models.find((model) => model.id === selectedAgentId)
      : chat.enabledModels.find((model) => model.id === chat.model);
  const reasoningSupported = supportsReasoningEffort(reasoningTargetModel);
  const reasoningEffortForSend = reasoningSupported ? REASONING_EFFORT_BY_LEVEL[reasoningLevel] : null;

  function updateReasoningLevel(level: ReasoningLevel) {
    setReasoningLevel(level);
    storeReasoningLevel(data.me.id, level);
  }

  function toggleStreamResponses() {
    const next = !streamResponses;
    setStreamResponses(next);
    storeLiveStreamPreference(data.me.id, next);
  }

  async function submitDraft(toolOverrides?: Partial<ComposerTools>, approvedToolConfigIds: string[] = []) {
    const text = draft.trim();
    const queuedAutomations = pendingAutomations;
    // One request at a time: the held one needs an answer first.
    if (pendingHandoff) {
      setHandoffNudged(true);
      return;
    }
    if (
      (!text && attachments.length === 0 && queuedAutomations.length === 0) ||
      isSending ||
      isImproving ||
      isComposerExpanded ||
      isUploadingAttachments ||
      attachments.some(isArrivingAttachment)
    ) {
      return;
    }

    // Queued automations run immediately, one after another. The typed
    // message becomes each chain's first-step input (so the run answers the
    // actual question instead of the canned schedule prompt) and is consumed
    // here — it is never re-sent as a separate chat message. Attachments
    // cannot ride an automation run, so they stay staged in the composer.
    if (queuedAutomations.length > 0) {
      setPendingAutomations([]);
      clearCommandToken();
      for (const automation of queuedAutomations) {
        await chat.runAutomationNow(automation, text || undefined);
      }
      setDraft((current) => current === draft ? "" : current);
      setOriginalDraft(null);
      return;
    }
    // A document or deck request waits for the user to pick Drafts or chat.
    // Agent mode, tools, and fetched links only work in chat, so those stay.
    const handoffOffer =
      onSendToDrafts &&
      !toolOverrides &&
      approvedToolConfigIds.length === 0 &&
      !composerTools.Agent &&
      selectedToolIds.length === 0 &&
      fetchUrls.length === 0 &&
      approvedWorkspaceModels(data).length > 0
        ? draftHandoffOffer(text, attachments, messages)
        : null;
    if (handoffOffer) {
      const createdAtIso = new Date().toISOString();
      setPendingHandoff({
        id: `handoff-${Date.now()}`,
        kind: handoffOffer,
        threadId: chat.activeId,
        text,
        attachments,
        composerTools,
        knowledgeBaseId: selectedKnowledgeBaseId,
        createdAtIso,
        phase: "choosing",
        error: null,
      });
      setDraft("");
      setOriginalDraft(null);
      setAttachments([]);
      clearCommandToken();
      setSendMenuOpen(false);
      setUploadError(null);
      return;
    }
    setUploadError(null);
    setToolApprovalNotice(null);
    const nextComposerTools = toolOverrides ? { ...composerTools, ...toolOverrides } : composerTools;
    if (toolOverrides) {
      setComposerTools(nextComposerTools);
    }
    setSendMenuOpen(false);

    const approvalRequest = pendingMcpApprovalFromState(
      data,
      nextComposerTools,
      selectedAgentId,
      selectedKnowledgeBaseId,
      selectedToolIds,
      chat.model,
    );
    const approvedToolIds = new Set(approvedToolConfigIds);
    const missingApproval = approvalRequest?.toolIds.some((toolId) => !approvedToolIds.has(toolId)) ?? false;
    if (approvalRequest && missingApproval) {
      setPendingToolApproval(approvalRequest);
      return;
    }
    setPendingToolApproval(null);

    let uploadedAttachments: ChatAttachment[] = [];
    try {
      if (attachments.length > 0) {
        setIsUploadingAttachments(true);
        setAttachments((prev) =>
          prev.map((file) => ({
            ...file,
            uploadStatus: file.file ? "uploading" : "ready",
            uploadError: undefined,
          })),
        );
        uploadedAttachments = await uploadPendingAttachments(attachments);
      }
      const runtime = runtimeOptionsFromState(
        data,
        nextComposerTools,
        uploadedAttachments,
        selectedAgentId,
        selectedKnowledgeBaseId,
        selectedToolIds,
        reasoningEffortForSend,
      );
      if (fetchUrls.length > 0) {
        runtime.fetchUrls = [...fetchUrls];
      }
      const approvedRuntimeToolIds = (runtime.toolConfigIds ?? []).filter((toolId) => approvedToolIds.has(toolId));
      runtime.approvedToolConfigIds = approvedRuntimeToolIds;
      // Exchange each user approval for a signed token the backend trusts; the
      // plain id list above is ignored server-side.
      runtime.approvalTokens = (
        await Promise.all(approvedRuntimeToolIds.map((toolId) => approveMcpTool(data.me.id, toolId).catch(() => null)))
      ).filter((token): token is string => Boolean(token));
      chat.sendMessage(text, uploadedAttachments, runtime);
      // Uploading can take long enough for the user to stage the next turn.
      // Clear only the snapshot sent here, never edits or files added meanwhile.
      const sentAttachmentIds = new Set(attachments.map((attachment) => attachment.localId));
      const sentToolIds = new Set(selectedToolIds);
      const sentUrls = new Set(fetchUrls);
      setDraft((current) => current === draft ? "" : current);
      setOriginalDraft(null);
      setAttachments((current) => current.filter((attachment) => !sentAttachmentIds.has(attachment.localId)));
      setSelectedToolIds((current) => current.filter((id) => !sentToolIds.has(id)));
      clearCommandToken();
      setFetchUrls((current) => current.filter((url) => !sentUrls.has(url)));
      setLinkComposerOpen(false);
      setLinkDraft((current) => current === linkDraft ? "" : current);
      setLinkError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not upload the attachment.";
      setUploadError(message);
      const failedAttachmentIds = new Set(attachments.map((attachment) => attachment.localId));
      setAttachments((prev) =>
        prev.map((file) => failedAttachmentIds.has(file.localId) ? {
          ...file,
          uploadStatus: "error",
          uploadError: message,
        } : file),
      );
    } finally {
      setIsUploadingAttachments(false);
    }
  }

  /** Uploads staged local files; already-uploaded ones pass through. */
  async function uploadPendingAttachments(staged: PendingAttachment[]): Promise<ChatAttachment[]> {
    const localAttachments = staged.filter((pending) => pending.file);
    const existingAttachments = staged.filter((pending) => !pending.file);
    const newUploads = await Promise.all(
      localAttachments.map(async (pending) => {
        const uploaded = await uploadChatAttachment(data.me.id, pending.file!, {
          tenantId: data.currentTenant?.id,
        });
        return {
          ...uploaded,
          name: uploaded.name || pending.name,
          size: uploaded.size || pending.size,
          kind: uploaded.kind || pending.kind,
        };
      }),
    );
    return [...existingAttachments.map(toChatAttachment), ...newUploads];
  }

  /** Puts a held request back in the composer, ahead of anything typed since. */
  function restoreHandoffToComposer(pending: PendingDraftHandoff) {
    setDraft((current) => (current.trim() ? `${pending.text}\n\n${current}` : pending.text));
    setAttachments((current) => [...pending.attachments, ...current]);
  }

  function editPendingHandoff() {
    const pending = pendingHandoffRef.current;
    if (!pending || pending.phase !== "choosing") return;
    setPendingHandoff(null);
    restoreHandoffToComposer(pending);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  /** "Continue in chat": send the held request exactly as it was sent. */
  async function continuePendingHandoffInChat() {
    const pending = pendingHandoffRef.current;
    if (!pending || pending.phase !== "choosing" || isSending) return;
    setPendingHandoff({ ...pending, phase: "chat", error: null });
    try {
      const uploaded = await uploadPendingAttachments(pending.attachments);
      // The user opened another chat while files uploaded; the request went back to the composer.
      if (pendingHandoffRef.current?.id !== pending.id) return;
      const runtime = runtimeOptionsFromState(
        data,
        pending.composerTools,
        uploaded,
        selectedAgentId,
        pending.knowledgeBaseId,
        [],
        reasoningEffortForSend,
      );
      runtime.approvedToolConfigIds = [];
      runtime.approvalTokens = [];
      setPendingHandoff(null);
      chat.sendMessage(pending.text, uploaded, runtime);
    } catch (error) {
      if (pendingHandoffRef.current?.id !== pending.id) return;
      setPendingHandoff({ ...pending, phase: "choosing", error: readableError(error, "Could not upload the attachment.") });
    }
  }

  /** "Write in Drafts" / "Build in deck editor": hand the request, its files,
   * its settings, and the earlier conversation to Drafts, which starts it. */
  async function openPendingHandoffInDrafts() {
    const pending = pendingHandoffRef.current;
    if (!pending || pending.phase !== "choosing" || !onSendToDrafts) return;
    setPendingHandoff({ ...pending, phase: "drafts", error: null });
    try {
      const uploaded = await uploadPendingAttachments(pending.attachments);
      if (pendingHandoffRef.current?.id !== pending.id) return;
      const knowledgeBase = pending.composerTools.Knowledge
        ? enabledKnowledgeBases.find((knowledge) => knowledge.id === pending.knowledgeBaseId) ?? enabledKnowledgeBases[0]
        : undefined;
      const editTarget = pending.kind === "edit" ? draftHandoffEditTarget(pending.text, uploaded, messages) : null;
      const request: DraftHandoffRequest = {
        id: pending.id,
        kind: pending.kind,
        prompt: pending.text,
        webSearch: pending.composerTools.Web,
        modelId: chat.model || null,
        knowledgeIds: knowledgeBase ? [knowledgeBase.id] : [],
        // The file being changed is the document itself, not a source beside it.
        attachments: draftHandoffAttachments(uploaded, messages).filter(
          (file) => file.attachmentId !== editTarget?.attachmentId,
        ),
        chatContext: draftHandoffChatContext(messages),
        editTarget,
      };
      setPendingHandoff(null);
      onSendToDrafts(request);
    } catch (error) {
      if (pendingHandoffRef.current?.id !== pending.id) return;
      setPendingHandoff({ ...pending, phase: "choosing", error: readableError(error, "Could not upload the attachment.") });
    }
  }

  /** Real AI prompt improver: sends the typed draft to the selected model with
   * the composer's live context and replaces the draft with the clearer
   * rewrite. The selected knowledge base rides along as knowledgeConfigIds so
   * the server's retrieval grounds the rewrite in actual source content;
   * connected tools, MCP servers, staged files, and the web toggle are
   * described so the rewrite can lean on what will really run. The draft is
   * only replaced on success — a failed call changes nothing. */
  async function improveDraftPrompt() {
    const text = draft.trim();
    if (!text || isImproving || isSending) return;
    if (!chat.model || chat.enabledModels.length === 0) return;
    setImproveError(null);
    setIsImproving(true);
    try {
      const knowledgeBase = composerTools.Knowledge ? selectedKnowledgeBase : undefined;
      const pickedToolNames = selectedToolIds
        .map((id) => data.tools.find((tool) => tool.id === id && tool.enabled)?.name)
        .filter((name): name is string => Boolean(name));
      const toolNames = [...new Set(pickedToolNames)];
      const contextLines = [
        knowledgeBase
          ? `Knowledge base "${knowledgeBase.name}" is attached, and retrieved excerpts from it are part of this request — use them so the prompt references the right documents, names, and specifics.`
          : null,
        toolNames.length > 0
          ? `Connected tools/MCP servers available to the send: ${toolNames.join(", ")}. The prompt may direct how to use them.`
          : null,
        composerTools.Web ? "Web search will run for the send; the prompt may say what to look up." : null,
        attachments.length > 0
          ? `Files staged with the message: ${attachments.map((file) => file.name).join(", ")}.`
          : null,
      ].filter((line): line is string => Boolean(line));
      const reply = await sendChat(data.me.id, {
        model: chat.model,
        messages: [
          { role: "system", content: promptImproverSystemPrompt("chat") },
          {
            role: "user",
            content:
              `Draft prompt to improve:\n\n${text}` +
              (contextLines.length > 0
                ? `\n\nWorkspace context for grounding:\n${contextLines.map((line) => `- ${line}`).join("\n")}`
                : ""),
          },
        ],
        runtime: {
          surface: "chat",
          webEnabled: false,
          citationsEnabled: false,
          knowledgeConfigIds: knowledgeBase ? [knowledgeBase.id] : [],
          maxCompletionTokens: 2000,
        },
      });
      const improved = cleanImprovedPrompt(reply.content ?? "");
      if (!improved) {
        throw new ChatRequestError("The model did not return a usable rewrite.");
      }
      setOriginalDraft((current) => current ?? draft);
      setDraft(improved);
      textareaRef.current?.focus();
    } catch (error) {
      setImproveError(
        error instanceof ChatRequestError && error.message
          ? error.message
          : "Could not improve the prompt. Check your connection and try again.",
      );
    } finally {
      setIsImproving(false);
    }
  }

  function restoreOriginalDraft() {
    if (originalDraft === null || isImproving || isSending) return;
    setDraft(originalDraft);
    setOriginalDraft(null);
    setImproveError(null);
    textareaRef.current?.focus();
  }

  function approvePendingToolRun() {
    if (!pendingToolApproval) return;
    const approvedToolIds = pendingToolApproval.toolIds;
    setPendingToolApproval(null);
    setToolApprovalNotice(null);
    void submitDraft(undefined, approvedToolIds);
  }

  function denyPendingToolRun() {
    setPendingToolApproval(null);
    setToolApprovalNotice("MCP tool run denied. No message was sent.");
  }

  function onFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length) {
      setAttachments((prev) => [...prev, ...files.map(describeFile)]);
    }
    // Reset so selecting the same file again still fires onChange.
    event.target.value = "";
  }

  function removeAttachment(id: string) {
    const removed = stagedAttachmentsRef.current.find((item) => item.localId === id);
    setAttachments((prev) => prev.filter((item) => item.localId !== id));
    setUploadError(null);
    if (removed?.id) takeBackAttachment(removed.id);
  }

  /** A file uploaded to be viewed and never sent has no chat to go with, so
   * nothing else would ever remove it. Best effort: a saved copy is harmless
   * to the person, and the server refuses a file a chat holds. */
  function takeBackAttachment(attachmentId: string) {
    void deleteChatAttachment(data.me.id, attachmentId).catch(() => undefined);
  }

  /** A staged file opens like a sent one, which takes an uploaded copy. It stays
   * staged, and sending uses that copy instead of uploading again. */
  async function viewStagedAttachment(localId: string) {
    const staged = stagedAttachmentsRef.current.find((item) => item.localId === localId);
    if (!staged || staged.uploadStatus === "uploading") return;
    if (staged.id) {
      openDocument({ kind: "attachment", attachmentId: staged.id, chunkId: null });
      return;
    }
    setIsUploadingAttachments(true);
    setUploadError(null);
    const marked = (status: Partial<PendingAttachment>) =>
      setAttachments((prev) => prev.map((item) => (item.localId === localId ? { ...item, ...status } : item)));
    marked({ uploadStatus: "uploading", uploadError: undefined });
    try {
      const [uploaded] = await uploadPendingAttachments([staged]);
      if (!stagedAttachmentsRef.current.some((item) => item.localId === localId)) {
        if (uploaded.id) takeBackAttachment(uploaded.id);
        return;
      }
      marked({ ...uploaded, file: undefined, uploadStatus: "ready" });
      if (uploaded.id) openDocument({ kind: "attachment", attachmentId: uploaded.id, chunkId: null });
    } catch (error) {
      const message = readableError(error, "Could not upload the attachment.");
      setUploadError(message);
      marked({ uploadStatus: "error", uploadError: message });
    } finally {
      setIsUploadingAttachments(false);
    }
  }

  function openFilePicker() {
    setAttachMenuOpen(false);
    fileInputRef.current?.click();
  }

  function openLinkComposer() {
    setAttachMenuOpen(false);
    setLinkComposerOpen(true);
    setLinkError(null);
  }

  function closeLinkComposer() {
    setLinkComposerOpen(false);
    setLinkDraft("");
    setLinkError(null);
  }

  function addFetchUrl() {
    const value = linkDraft.trim();
    if (!value) {
      setLinkError("Enter a web address to attach.");
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      setLinkError("Enter a full web address starting with http:// or https://.");
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      setLinkError("Enter a full web address starting with http:// or https://.");
      return;
    }
    if (fetchUrls.includes(value)) {
      setLinkError("That link is already attached.");
      return;
    }
    if (fetchUrls.length >= MAX_FETCH_URLS) {
      setLinkError(`You can attach up to ${MAX_FETCH_URLS} web links per message.`);
      return;
    }
    setFetchUrls((current) => [...current, value]);
    setLinkDraft("");
    setLinkError(null);
  }

  function removeFetchUrl(url: string) {
    setFetchUrls((current) => current.filter((item) => item !== url));
    setLinkError(null);
  }

  async function openCloudPicker(source: ConnectorDef) {
    // The menu item unmounts when the picker opens; retain a stable return
    // target for the modal focus lifecycle.
    attachRef.current?.querySelector<HTMLButtonElement>(".attach-trigger")?.focus({ preventScroll: true });
    setAttachMenuOpen(false);
    setUploadError(null);
    stopCloudConnectPolling();
    setCloudPicker({
      source,
      status: "loading",
      items: [],
      selectedIds: [],
      error: null,
      connectUrl: null,
      connectPending: false,
    });
    try {
      const items = await listCloudAttachmentItems(data.me.id, source.id, {
        tenantId: data.currentTenant.id,
      });
      setCloudPicker((current) =>
        current?.source.id === source.id
          ? {
              ...current,
              status: "ready",
              items,
              selectedIds: [],
              error: null,
            }
          : current,
      );
    } catch (error) {
      // 428: the source is configured but this user has not connected their own
      // account yet — offer the provider consent flow instead of a dead error.
      if (error instanceof ChatRequestError && error.status === 428) {
        try {
          const authorize = await getCloudAttachmentAuthorizeUrl(data.me.id, source.id, {
            tenantId: data.currentTenant.id,
          });
          setCloudPicker((current) =>
            current?.source.id === source.id
              ? { ...current, status: "connect", connectUrl: authorize.url, error: null }
              : current,
          );
          return;
        } catch (authorizeError) {
          error = authorizeError;
        }
      }
      const message = readableError(error, `Could not load ${source.label} files.`);
      setCloudPicker((current) =>
        current?.source.id === source.id
          ? {
              ...current,
              status: "error",
              error: message,
            }
          : current,
      );
    }
  }

  function connectCloudPickerAccount() {
    const picker = cloudPicker;
    if (!picker || picker.status !== "connect" || !picker.connectUrl) return;
    window.open(picker.connectUrl, "aperture-connector-oauth", "popup=yes,width=560,height=720");
    setCloudPicker((current) =>
      current?.source.id === picker.source.id ? { ...current, connectPending: true } : current,
    );
    startCloudConnectPolling(picker.source);
  }

  function startCloudConnectPolling(source: ConnectorDef) {
    stopCloudConnectPolling();
    let attempts = 0;
    cloudConnectPollRef.current = window.setInterval(async () => {
      attempts += 1;
      if (attempts > 40) {
        stopCloudConnectPolling();
        setCloudPicker((current) =>
          current?.source.id === source.id && current.status === "connect"
            ? { ...current, connectPending: false }
            : current,
        );
        return;
      }
      try {
        const items = await listCloudAttachmentItems(data.me.id, source.id, {
          tenantId: data.currentTenant.id,
        });
        stopCloudConnectPolling();
        setCloudPicker((current) =>
          current?.source.id === source.id
            ? {
                ...current,
                status: "ready",
                items,
                selectedIds: [],
                error: null,
                connectPending: false,
              }
            : current,
        );
      } catch {
        // Still waiting for the user to finish the provider consent flow.
      }
    }, 3000);
  }

  function stopCloudConnectPolling() {
    if (cloudConnectPollRef.current !== null) {
      window.clearInterval(cloudConnectPollRef.current);
      cloudConnectPollRef.current = null;
    }
  }

  function closeCloudPicker() {
    stopCloudConnectPolling();
    setCloudPicker(null);
  }

  function toggleCloudPickerItem(itemId: string) {
    setCloudPicker((current) => {
      if (!current || current.status === "importing") return current;
      const selected = current.selectedIds.includes(itemId);
      return {
        ...current,
        selectedIds: selected ? current.selectedIds.filter((id) => id !== itemId) : [...current.selectedIds, itemId],
      };
    });
  }

  async function attachCloudPickerSelection() {
    if (!cloudPicker || cloudPicker.selectedIds.length === 0 || cloudPicker.status === "importing") return;
    const picker = cloudPicker;
    setCloudPicker({ ...picker, status: "importing", error: null });
    try {
      const imported = await importCloudAttachments(data.me.id, picker.source.id, {
        item_ids: picker.selectedIds,
        tenant_id: data.currentTenant.id,
      });
      setAttachments((prev) => [...prev, ...imported.map(describeUploadedAttachment)]);
      setUploadError(null);
      setCloudPicker(null);
    } catch (error) {
      const message = readableError(error, `Could not attach files from ${picker.source.label}.`);
      setCloudPicker((current) =>
        current?.source.id === picker.source.id
          ? {
              ...current,
              status: "ready",
              error: message,
            }
          : current,
      );
    }
  }

  const closeInspector = () => {
    setIsInspectorOpen(false);
    setCitationDetailsOpen(false);
    setFocusedCitationMessageId(null);
  };
  useModalFocus(inspectorRef, isInspectorOpen && inspectorOverlay, closeInspector);
  const toggleInspector = () => {
    setCitationDetailsOpen(false);
    setFocusedCitationMessageId(null);
    setIsInspectorOpen(!isInspectorOpen);
  };
  const toggleCitationDetails = (messageId: string) => {
    const isActiveMessage = citationDetailsOpen && focusedCitationMessageId === messageId;
    if (isActiveMessage) {
      setCitationDetailsOpen(false);
      setFocusedCitationMessageId(null);
      return;
    }
    setFocusedCitationMessageId(messageId);
    setCitationDetailsOpen(true);
    setIsInspectorOpen(true);
  };
  const stagePromptInNewChat = (message: ChatMessage) => {
    const text = message.content.trim();
    const stagedAttachments = (message.attachments ?? []).map(describeUploadedAttachment);
    if (!text && stagedAttachments.length === 0) return false;
    chat.newChat();
    setDraft(text);
    setAttachments(stagedAttachments);
    setUploadError(null);
    setSelectedToolIds([]);
    clearCommandToken();
    setPendingToolApproval(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
    return true;
  };
  const activeToolSummaries: ComposerToolSummary[] = [...composerToolSummaries(composerTools, {
    selectedKnowledgeBaseName: selectedKnowledgeBase?.name,
    selectedAgentName: selectedAgent?.name,
  }), ...availableMcpServers.filter((tool) => selectedToolIds.includes(tool.id)).map((tool) => ({
    key: tool.id, label: tool.name, title: tool.name, icon: Plug,
  })), ...pendingAutomations.map((automation) => ({ key: automation.id, label: automation.name, title: `${automation.name} runs when you send`, icon: Play }))];
  const activeToolCount = activeToolSummaries.length;
  const singleActiveTool = activeToolSummaries.length === 1 ? activeToolSummaries[0] : null;
  const SingleActiveToolIcon = singleActiveTool?.icon;
  const activeToolsTitle = activeToolSummaries.map((summary) => summary.title).join(" · ");
  const sessionToolNames = [...new Set(activeToolSummaries.map((summary) => summary.label))];
  const canSend =
    chat.enabledModels.length > 0 &&
    (draft.trim().length > 0 || attachments.length > 0 || pendingAutomations.length > 0) &&
    !isSending &&
    !isImproving &&
    !isComposerExpanded &&
    !isUploadingAttachments &&
    !attachments.some(isArrivingAttachment) &&
    !pendingHandoff;
  const canOpenSendOptions =
    chat.enabledModels.length > 0 && !isSending && !isUploadingAttachments && !isComposerExpanded;
  const hasDraftText = draft.trim().length > 0;

  /** Each tile reports what is switched on inside it, since its list is out of sight. */
  const knowledgeBlocks = attachments.filter((attachment) => attachment.source_type === "knowledge");
  const baseBlocks = knowledgeBlocks.filter((attachment) => attachment.kind === "Knowledge").length;
  const resourcesInUse: Partial<Record<ResourceSection, number>> = {
    "Knowledge bases": (composerTools.Knowledge && selectedKnowledgeBaseId ? 1 : 0) + baseBlocks,
    "Files in knowledge sources": knowledgeBlocks.length - baseBlocks,
    "MCP connections": selectedToolIds.length,
    Agents: composerTools.Agent && selectedAgentId ? 1 : 0,
    Automations: pendingAutomations.length,
  };

  function searchResources(query: string) {
    setShortcutQuery(query);
    setResourceView(query ? "all" : "tiles");
  }

  function showResourceTiles() {
    const leaving = resourceView;
    setShortcutQuery("");
    setResourceView("tiles");
    requestAnimationFrame(() => {
      sendMenuRef.current?.querySelector<HTMLElement>(`[data-resource-tile="${leaving}"]`)?.focus();
    });
  }

  function toggleComposerTool(tool: keyof ComposerTools) {
    setComposerTools((current) => {
      const next = { ...current, [tool]: !current[tool] };
      if (tool === "Agent" && next.Agent && !selectedAgentId) {
        setSelectedAgentId(agentProfiles[0]?.id ?? null);
      }
      return next;
    });
  }

  function toggleKnowledgeTool() {
    const nextEnabled = !composerTools.Knowledge;
    setComposerTools((current) => ({ ...current, Knowledge: nextEnabled }));
    setKnowledgePickerOpen(nextEnabled);
    if (nextEnabled && !selectedKnowledgeBaseId) {
      setSelectedKnowledgeBaseId(enabledKnowledgeBases[0]?.id ?? null);
    }
  }

  function clearComposerTools() {
    setComposerTools({ Knowledge: false, Web: false, Agent: false });
    setKnowledgePickerOpen(false);
    setSelectedToolIds([]);
    setPendingAutomations([]);
  }

  const composerForm = (
    <form
      ref={expandedComposerRef}
      tabIndex={isComposerExpanded ? -1 : undefined}
      className={`composer ${showConversation ? "" : "composer-empty"}${isImproving ? " is-improving" : ""}${isComposerExpanded ? " is-expanded" : ""}`}
      aria-busy={isImproving}
      role={isComposerExpanded ? "dialog" : undefined}
      aria-modal={isComposerExpanded ? "true" : undefined}
      aria-label={isComposerExpanded ? "Expanded prompt editor" : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        void submitDraft();
      }}
    >
      <PromptImproveRail state={improveRail} progress={improveProgress} />
      {isImproving && (
        <span className="sr-only" role="status">
          Improving prompt
        </span>
      )}
      {isComposerExpanded && (
        <header className="composer-expanded-head">
          <span>
            <strong>Expanded prompt</strong>
            <small>Collapse this editor before sending your message.</small>
          </span>
          <button
            type="button"
            className="composer-collapse-button"
            aria-label="Collapse prompt editor"
            data-tooltip="Return to the standard composer so this message can be sent"
            disabled={isImproving}
            onClick={() => setIsComposerExpanded(false)}
          >
            <Minimize2 size={17} />
            <span>Collapse to send</span>
          </button>
        </header>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        aria-label="Upload files from computer"
        style={{ display: "none" }}
        onChange={onFilesSelected}
      />

      {attachments.length > 0 && (
        <div className="attach-tray">
          {attachments.map((file) => (
            <ComposerFileBlock
              key={file.localId}
              name={file.name}
              kind={file.kind}
              detail={stagedAttachmentDetail(file)}
              status={file.uploadStatus}
              canOpen={file.uploadStatus !== "uploading"}
              openHint={`See ${file.name} as it opens from a citation`}
              removeHint={`Remove ${file.name} from this message before sending`}
              onOpen={() => void viewStagedAttachment(file.localId)}
              onRemove={() => removeAttachment(file.localId)}
            />
          ))}
        </div>
      )}

      {(fetchUrls.length > 0 || linkComposerOpen) && (
        <div className="attach-tray composer-link-tray">
          {fetchUrls.map((url) => (
            <span
              className="composer-mcp-chip"
              key={url}
              data-tooltip={`${url} is fetched as a cited web source when you send`}
            >
              <Link2 size={13} />
              <span
                style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {displayFetchUrl(url)}
              </span>
              <button
                type="button"
                aria-label={`Remove link ${url}`}
                data-tooltip="Remove this link from the next message"
                onClick={() => removeFetchUrl(url)}
              >
                <X size={12} />
              </button>
            </span>
          ))}
          {linkComposerOpen && (
            <span
              className="composer-link-editor"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "1 1 260px", minWidth: 0 }}
            >
              <input
                aria-label="Web page address"
                placeholder="https://example.com/page"
                autoFocus
                value={linkDraft}
                style={{
                  flex: "1 1 auto",
                  minWidth: 0,
                  minHeight: "var(--control-height)",
                  border: "1px solid var(--border-strong)",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--surface)",
                  color: "var(--text)",
                  padding: "0 var(--control-padding-x)",
                  fontSize: "var(--control-font-size)",
                }}
                onChange={(event) => {
                  setLinkDraft(event.target.value);
                  setLinkError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addFetchUrl();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeLinkComposer();
                  }
                }}
              />
              <button
                type="button"
                className="secondary-button"
                data-tooltip={`Attach this web page as a source (up to ${MAX_FETCH_URLS} per message)`}
                onClick={addFetchUrl}
              >
                Add link
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Close link input"
                data-tooltip="Close the link input; attached links stay on the message"
                onClick={closeLinkComposer}
              >
                <X size={14} />
              </button>
            </span>
          )}
        </div>
      )}

      {linkError && (
        <p className="composer-error" role="alert">
          {linkError}
        </p>
      )}
      {uploadError && <p className="composer-error">{uploadError}</p>}
      {dictationError && <p className="composer-error">{dictationError}</p>}
      {improveError && (
        <p className="composer-error" role="alert">
          {improveError}
        </p>
      )}
      {toolApprovalNotice && <p className="composer-approval-note">{toolApprovalNotice}</p>}
      {pendingToolApproval && (
        <div className="composer-approval-request" role="status" aria-live="polite">
          <div className="composer-approval-copy">
            <ShieldCheck size={18} />
            <span>
              <strong>Approve MCP tool run?</strong>
              <small>
                {pendingToolApproval.toolNames.join(", ")} will run
                {pendingToolApproval.agentName ? ` through ${pendingToolApproval.agentName}` : ""} before this message
                is sent.
              </small>
            </span>
          </div>
          <div className="composer-approval-actions">
            <button
              type="button"
              className="composer-approval-deny"
              data-tooltip="Deny this MCP tool run and keep the message unsent"
              onClick={denyPendingToolRun}
            >
              <X size={15} />
              Deny
            </button>
            <button
              type="button"
              className="composer-approval-approve"
              data-tooltip="Approve this MCP tool run and send the message now"
              onClick={approvePendingToolRun}
            >
              <Check size={15} />
              Approve
            </button>
          </div>
        </div>
      )}

      {commandMenuVisible && commandToken && (
        <ComposerCommandMenu
          menuRef={commandMenuRef}
          listId={commandListId}
          label={`${COMMAND_MENU_TITLES[commandToken.symbol]} commands`}
          items={commandItems}
          activeIndex={commandIndex}
          iconFor={commandItemIcon}
          onHighlight={setCommandIndex}
          onPick={applyCommandItem}
        >
          {commandToken.symbol === "#" ? (
            <KnowledgeMenuStatus files={knowledgeFiles} itemCount={commandItems.length} query={commandToken.query} />
          ) : (
            commandItems.length === 0 && (
              <span className="composer-command-loading">{emptyCommandText(commandToken, data.connectors)}</span>
            )
          )}
        </ComposerCommandMenu>
      )}
      <textarea
        ref={textareaRef}
        aria-label="Message"
        aria-autocomplete="list"
        aria-controls={commandMenuVisible ? commandListId : undefined}
        aria-activedescendant={commandMenuVisible && commandItems[commandIndex] ? `${commandListId}-${commandIndex}` : undefined}
        placeholder={chat.enabledModels.length ? "Ask anything..." : "Connect a model provider to start chatting..."}
        readOnly={isImproving}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          updateCommandToken(event.target);
        }}
        onSelect={(event) => updateCommandToken(event.currentTarget)}
        onBlur={() => clearCommandToken()}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "Escape") setSendMenuOpen(false);
          if (handleCommandKey(event, commandItems.length, (index) => {
            const item = commandItems[index];
            if (item) applyCommandItem(item);
          })) return;
          if (event.key === "Enter" && !event.shiftKey && !isComposerExpanded) {
            event.preventDefault();
            void submitDraft();
          }
        }}
      />
      <div className="composer-toolbar">
        <div className="composer-tools">
          <div className="attach" ref={attachRef}>
            <button
              type="button"
              className="attach-trigger"
              aria-label="Add attachment"
              data-tooltip="Attach files or connect a source to include in your message"
              aria-haspopup="menu"
              aria-expanded={attachMenuOpen}
              onClick={() => setAttachMenuOpen((open) => !open)}
            >
              <Paperclip size={17} />
            </button>
            {attachMenuOpen && (
              <div className="attach-menu" role="menu" aria-label="Add attachment" ref={revealComposerMenu}>
                <button
                  type="button"
                  role="menuitem"
                  className="attach-option"
                  data-tooltip="Pick files from this device to attach to your message. Audio is transcribed and video stills are described when you send, even if the video has no audio."
                  onClick={openFilePicker}
                >
                  <Upload size={16} />
                  <span>
                    <strong>Upload from computer</strong>
                    <small>Documents, images, audio, or video</small>
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="attach-option"
                  data-tooltip={`Fetch up to ${MAX_FETCH_URLS} public web pages as cited sources for this message`}
                  onClick={openLinkComposer}
                >
                  <Link2 size={16} />
                  <span>
                    <strong>Web page by link</strong>
                    <small>Fetch up to {MAX_FETCH_URLS} pages as sources</small>
                  </span>
                </button>
                {attachSources.length > 0 && (
                  <>
                    <div className="attach-menu-divider" />
                    <span className="attach-menu-label">Attach from source</span>
                  </>
                )}
                {attachSources.map((source) => {
                  const { id, label, icon: Icon } = source;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="menuitem"
                      className="attach-option"
                      data-tooltip={`Open ${label} files to attach to this message`}
                      onClick={() => void openCloudPicker(source)}
                    >
                      <Icon size={16} />
                      <span>
                        <strong>{label}</strong>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="composer-context-tools">
          {activeToolSummaries.length > 0 && (
            <div
              className={`composer-tools-status is-on ${singleActiveTool ? "is-single" : "is-multiple"}`}
              aria-label={`${activeToolCount} tool${activeToolCount === 1 ? "" : "s"} on`}
              data-tooltip={activeToolsTitle}
            >
              {singleActiveTool && SingleActiveToolIcon ? (
                <>
                  <SingleActiveToolIcon size={16} />
                  <span>{singleActiveTool.label}</span>
                </>
              ) : (
                <>
                  <Wrench size={16} />
                  <span>Tools</span>
                  <b>{activeToolSummaries.length}</b>
                </>
              )}
              <button
                type="button"
                className="composer-tools-clear"
                aria-label="Turn off active tools"
                data-tooltip="Clear the tools and resources selected for this message"
                onClick={clearComposerTools}
              >
                <X size={13} />
              </button>
            </div>
          )}
          </div>
        </div>
        <div className="send-actions" ref={sendRef}>
          <div className={`composer-draft-actions${hasDraftText ? " has-text" : ""}`}>
            <DictationControl
              userId={data.me.id}
              disabled={isSending || isImproving}
              onError={setDictationError}
              onTranscript={(text) => {
                setDraft((current) => {
                  if (!current.trim()) return text;
                  return `${current.replace(/\s+$/, "")} ${text}`;
                });
                textareaRef.current?.focus();
              }}
            />
            {hasDraftText && (
              <button
                type="button"
                className="composer-expand-button"
                hidden={isComposerExpanded}
                style={isComposerExpanded ? { display: "none" } : undefined}
                aria-label="Expand prompt editor"
                data-tooltip="Open this draft in a larger editor for review"
                disabled={isSending || isImproving}
                onClick={() => setIsComposerExpanded(true)}
              >
                <Maximize2 size={16} />
              </button>
            )}
            {originalDraft !== null && (
              <button
                type="button"
                className="prompt-restore-button"
                aria-label="Restore original prompt"
                data-tooltip="Restore the draft from before the last AI improvement"
                disabled={isSending || isImproving}
                onClick={restoreOriginalDraft}
              >
                <Undo2 size={16} />
              </button>
            )}
            <button
              type="button"
              className={`prompt-improve-button${isImproving ? " is-improving" : ""}`}
              aria-label="Improve prompt"
              aria-hidden={!hasDraftText}
              tabIndex={hasDraftText ? 0 : -1}
              data-tooltip={
                isImproving
                  ? "Improving your prompt..."
                  : "Rewrite your prompt with AI — clearer wording and more detail, grounded in any attached knowledge, tools, and files"
              }
              disabled={!hasDraftText || isImproving || isSending || chat.enabledModels.length === 0}
              onClick={() => void improveDraftPrompt()}
            >
              <PromptImproveIcon />
            </button>
          </div>
          {chat.enabledModels.length > 0 && (
            <ContextWindowIndicator status={contextWindowStatus} onOpenDetails={() => setIsInspectorOpen(true)} />
          )}
          {!isComposerExpanded && <>
          <button
            className="send-button"
            type="submit"
            aria-label="Send message"
            data-tooltip={
              isComposerExpanded
                ? "Collapse the prompt editor before sending"
                : pendingHandoff
                  ? "Choose Drafts or chat for the request above first"
                  : "Send your message to the selected model"
            }
            disabled={!canSend}
          >
            <Send size={18} />
          </button>
          <button
            className="send-options-button"
            type="button"
            aria-label="Send options"
            data-tooltip="Choose tools, resources, and reply settings"
            aria-haspopup="dialog"
            aria-expanded={sendMenuOpen}
            disabled={!canOpenSendOptions}
            onClick={() => { clearCommandToken(); setSendMenuOpen((open) => !open); }}
          >
            <ChevronDown size={16} />
          </button>
          </>}
          {!isComposerExpanded && sendMenuOpen && createPortal(
            <div className="send-options-menu composer-options-panel" role="dialog" aria-label="Send options" tabIndex={-1} ref={sendMenuRef}>
              <div className="composer-options-heading"><strong>Send options</strong>
                <button type="button" className="icon-button" aria-label="Close send options" onClick={() => setSendMenuOpen(false)}><X size={18} /></button></div>
              <RailSwitch block className="composer-options-rail" ariaLabel="Options sections" options={SEND_MENU_TABS} value={sendMenuTab} onChange={setSendMenuTab} />
              <div className="composer-options-body" key={sendMenuTab}>
              {sendMenuTab === "settings" ? <div role="menu" aria-label="Reply settings">
                <h3 className="composer-options-group-title">Use in this chat</h3>
                <div className="composer-option-group">
                  <ToolSwitch
                    icon={BookOpen}
                    label="Knowledge"
                    detail={knowledgeOptionDetail({ available: enabledKnowledgeBases.length > 0, on: composerTools.Knowledge, baseName: selectedKnowledgeBase?.name })}
                    checked={composerTools.Knowledge}
                    disabled={enabledKnowledgeBases.length === 0}
                    expanded={composerTools.Knowledge && knowledgePickerOpen}
                    onToggle={toggleKnowledgeTool}
                  />
                  {composerTools.Knowledge && knowledgePickerOpen && (
                    <KnowledgeSourcePicker
                      knowledgeBases={enabledKnowledgeBases}
                      selectedKnowledgeBaseId={selectedKnowledgeBase?.id ?? selectedKnowledgeBaseId}
                      onSelect={setSelectedKnowledgeBaseId}
                    />
                  )}
                  <ToolSwitch
                    icon={Globe2}
                    label="Web"
                    detail={webOptionDetail(webSearchAvailable)}
                    checked={composerTools.Web}
                    disabled={!webSearchAvailable}
                    onToggle={() => toggleComposerTool("Web")}
                  />
                  <ToolSwitch
                    icon={Bot}
                    label="Agent"
                    detail={agentOptionDetail(composerTools.Agent ? selectedAgent?.name : undefined)}
                    checked={composerTools.Agent}
                    onToggle={() => toggleComposerTool("Agent")}
                  />
                  {composerTools.Agent && (
                    <div className="agent-profile-picker" role="group" aria-label="Agent profile">
                      <label>
                        Agent profile
                        <SelectControl
                          value={selectedAgentId ?? ""}
                          data-tooltip="Choose which agent profile handles your next reply"
                          onChange={(event) => setSelectedAgentId(event.target.value || null)}
                        >
                          {agentProfiles.map((agent) => (
                            <option key={agent.id} value={agent.id}>
                              {agent.name}
                            </option>
                          ))}
                          {lockedHermesAgents.map((agent) => (
                            <option key={agent.id} value={agent.id} disabled>
                              {agent.name} (needs Hermes approval)
                            </option>
                          ))}
                        </SelectControl>
                      </label>
                      {selectedAgent ? (
                        <small>
                          {modelKnowledgeIds(selectedAgent).length} knowledge ·{" "}
                          {agentKnowledgeDocumentCount(data, selectedAgent)} files · {modelToolIds(selectedAgent).length}{" "}
                          {modelToolIds(selectedAgent).length === 1 ? "tool" : "tools"}
                          {selectedAgent.agentic_companion === "hermes" ? " · Hermes" : ""}
                        </small>
                      ) : (
                        <small>Create an agent profile in Agents to enable this mode.</small>
                      )}
                    </div>
                  )}
                </div>
                <h3 className="composer-options-group-title">Reply style</h3>
                <div className="composer-option-group">
                  <div className="composer-option-row is-stacked" role="group" aria-label="Reasoning level">
                    <OptionCopy
                      icon={Brain}
                      title="Reasoning"
                      detail={reasoningHelp(reasoningLevel, reasoningSupported, reasoningTargetModel?.name ?? "This model")}
                    />
                    <ReasoningRail level={reasoningLevel} supported={reasoningSupported} onChange={updateReasoningLevel} />
                  </div>
                  <StreamSwitch checked={streamResponses} onToggle={toggleStreamResponses} />
                </div>
              </div> : <div className="composer-options-resources">
                <ResourceSearch value={shortcutQuery} onChange={searchResources} />
                {resourceView === "tiles" ? <ResourceTiles inUse={resourcesInUse} onOpen={setResourceView} /> : <>
                  <ResourceListHeader title={resourceViewTitle(resourceView, shortcutQuery)} focusBack={!shortcutQuery} onBack={showResourceTiles} />
                  <div className="composer-resource-results">
                    {commandSections.map((section) => <section key={section.title} aria-label={resourceSectionLabel(section.title)}>
                      {resourceView === "all" && <h3 className="composer-command-section">{resourceSectionLabel(section.title)}</h3>}
                      {section.items.map((item) => {
                        const selected = item.kind === "mcp-tool" ? selectedToolIds.includes(item.tool.id)
                          : item.kind === "automation" ? pendingAutomations.some((entry) => entry.id === item.automation.id)
                          : item.kind === "agent" ? composerTools.Agent && selectedAgentId === item.agent.id
                          : item.kind === "knowledge-base" ? composerTools.Knowledge && selectedKnowledgeBaseId === item.base.id : false;
                        const toggleable = item.kind === "mcp-tool" || item.kind === "automation";
                        const ItemIcon = selected ? Check : resourceSectionIcon(item.section);
                        return <button type="button" className="composer-command-item" key={item.id}
                          aria-pressed={toggleable || item.kind === "agent" || item.kind === "knowledge-base" ? selected : undefined}
                          onClick={() => {
                            if (selected && item.kind === "mcp-tool") setSelectedToolIds((ids) => ids.filter((id) => id !== item.tool.id));
                            else if (selected && item.kind === "automation") setPendingAutomations((entries) => entries.filter((entry) => entry.id !== item.automation.id));
                            else applyCommandItem(item);
                          }}>
                          <ItemIcon size={18} />
                          <span><strong>{item.name}</strong><small>{item.detail}</small></span>
                        </button>;
                      })}
                    </section>)}
                    {knowledgeCommandOpen && knowledgeFiles.status === "loading" && <p role="status">Loading knowledge files…</p>}
                    {knowledgeCommandOpen && knowledgeFiles.failed && <button type="button" className="link-button" onClick={knowledgeFiles.retry}>Retry loading knowledge files</button>}
                    {commandItems.length === 0 && <p role="status">No matching resources available.</p>}
                  </div>
                </>}
                <ShortcutGuide shortcuts={COMPOSER_SHORTCUTS} />
              </div>}
              </div>
              <div className="composer-options-footer">
                <small>Enter sends · Shift + Enter adds a line</small>
                <button type="button" className="primary-button" disabled={!canSend} onClick={() => void submitDraft()}><Send size={16} /> Send now</button>
              </div>
            </div>, document.body
          )}
        </div>
      </div>
    </form>
  );

  const disclaimer = (
    <p className="disclaimer">
      Responses may contain mistakes. Verify important information.
      {data.dataProtection?.privacy_enabled && (
        <span
          className="disclaimer-privacy"
          data-tooltip="Your organization replaces Social Security numbers, account numbers, and other personal data with placeholders before chats are saved."
        >
          <Lock size={11} aria-hidden="true" /> Personal data is concealed.
        </span>
      )}
    </p>
  );

  function submitResponseFeedback(
    message: ChatMessage,
    rating: ChatFeedbackRating,
    comment?: string,
  ) {
    const thread = activeThread;
    if (!thread) return null;
    const preview = truncatePreview(messagePlainText(message));
    // The server record is what admins read; the local copy only keeps the
    // pressed state instant on this device. Never block the chat on it.
    void submitChatFeedback(data.me.id, {
      thread_id: thread.id,
      message_id: message.id,
      rating: rating === "positive" ? "positive" : "negative",
      ...(comment !== undefined ? { comment } : {}),
      message_preview: preview,
      thread_title: thread.title,
      model_id: thread.model_id,
    }).catch(() => {
      // Feedback capture must never interrupt chat usage.
    });
    return recordChatFeedback({
      thread_id: thread.id,
      thread_title: thread.title,
      message_id: message.id,
      rating,
      message_preview: preview,
      model_id: thread.model_id,
      user_id: data.me.id,
      user_name: data.me.display_name,
    });
  }

  async function saveThreadTitle() {
    if (!activeThread || threadTitleSaving) return;
    const title = threadTitleDraft.trim().replace(/\s+/g, " ").slice(0, 160);
    if (!title) {
      setThreadTitleError("Enter a chat name before saving.");
      return;
    }
    if (title === activeThread.title) {
      setEditingThreadTitle(false);
      setThreadTitleError(null);
      return;
    }

    setThreadTitleSaving(true);
    setThreadTitleError(null);
    try {
      await chat.renameThread(activeThread.id, title);
      setThreadTitleDraft(title);
      setEditingThreadTitle(false);
    } catch {
      setThreadTitleError("The chat name could not be saved. Try again.");
    } finally {
      setThreadTitleSaving(false);
    }
  }

  async function generateThreadTitle() {
    if (!activeThread || threadTitleGenerating) return;
    setThreadTitleGenerating(true);
    setThreadTitleError(null);
    try {
      await chat.generateThreadTitle(activeThread.id);
    } catch (error) {
      setThreadTitleError(
        error instanceof ChatRequestError && error.message
          ? error.message
          : "The AI could not rename this chat. Try again.",
      );
    } finally {
      setThreadTitleGenerating(false);
    }
  }

  return (
    <CodeEditAssistProvider value={codeEditAssist}>
    <ArtifactCanvasProvider
      anchorSelector=".chat-main"
      messages={messages}
      onUpdateCode={chat.updateAssistantCode}
      resetKey={activeThread?.id}
    >
    <div className={`chat-layout ${isInspectorOpen ? "inspector-expanded" : "inspector-collapsed"}`}>
      <section className="chat-main">
        <header className="workspace-header">
          <div className="workspace-heading">
            {editingThreadTitle && activeThread ? (
              <form
                className="chat-title-editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveThreadTitle();
                }}
              >
                <input
                  autoFocus
                  aria-label="Chat name"
                  data-tooltip="Edit the name shown everywhere this chat appears"
                  value={threadTitleDraft}
                  maxLength={160}
                  disabled={threadTitleSaving}
                  onChange={(event) => {
                    setThreadTitleDraft(event.target.value);
                    setThreadTitleError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    setThreadTitleDraft(activeThread.title);
                    setThreadTitleError(null);
                    setEditingThreadTitle(false);
                  }}
                />
                <button
                  className="chat-title-action is-save"
                  type="submit"
                  aria-label="Save chat name"
                  data-tooltip="Save this name everywhere the chat appears"
                  disabled={threadTitleSaving}
                >
                  <Check size={15} />
                </button>
                <button
                  className="chat-title-action"
                  type="button"
                  aria-label="Cancel renaming chat"
                  data-tooltip="Keep the current chat name"
                  disabled={threadTitleSaving}
                  onClick={() => {
                    setThreadTitleDraft(activeThread.title);
                    setThreadTitleError(null);
                    setEditingThreadTitle(false);
                  }}
                >
                  <X size={15} />
                </button>
              </form>
            ) : (
              <ChatTitleDisplay
                title={activeThread?.title ?? "New chat"}
                showRename={Boolean(activeThread && activeThread.messages.length > 0)}
                showAiRename={hasCompletedAssistantReply}
                renameDisabled={threadTitleGenerating}
                aiRenameDisabled={threadTitleGenerating || isSending}
                aiRenaming={threadTitleGenerating}
                onRename={() => {
                  if (!activeThread) return;
                  setThreadTitleDraft(activeThread.title);
                  setThreadTitleError(null);
                  setEditingThreadTitle(true);
                }}
                onAiRename={() => void generateThreadTitle()}
              />
            )}
            {threadTitleError && <p className="chat-title-error" role="alert">{threadTitleError}</p>}
          </div>
          <div className="header-actions">
            <ModelSelect chat={chat} onExplainAccess={onExplainModelAccess} />
            <button
              className="icon-button"
              type="button"
              aria-label="Session info"
              aria-expanded={isInspectorOpen}
              data-tooltip={
                isInspectorOpen
                  ? "Hide the session details panel"
                  : "See session details like model, tokens, and sources used"
              }
              onClick={toggleInspector}
            >
              <Info size={18} />
            </button>
          </div>
        </header>

        <div className={`conversation ${showConversation ? "" : "is-empty"}`}>
          {!showConversation && (
            <>
              <div className="empty-chat">
                <div
                  className={`empty-brand-identity${assistantLockup.source === "logo" ? " has-logo-image" : ""}`}
                  aria-label={assistantLabel}
                >
                  <div className="empty-mark">
                    <BrandArtwork lockup={assistantLockup} label={assistantLabel} className="empty-brand-logo" markSize={72} />
                  </div>
                  {assistantLockup.name && <span>{assistantLockup.name}</span>}
                </div>
                <h2>{timeOfDayGreeting(new Date().getHours(), data.me.display_name)}</h2>
                <p className="empty-tagline">
                  Your approved models, your sources, your guardrails — ask
                  {assistantBrandName ? ` ${assistantBrandName}` : ""} anything.
                </p>
              </div>
            </>
          )}

          {showConversation && (
            <div className="message-list">
              {messages.map((message, index) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  transferRequest={message.role === "assistant" ? requestBefore(messages, index) : null}
                  userId={data.me.id}
                  userName={data.me.display_name}
                  userAvatarUrl={data.me.avatar_url}
                  brandName={assistantBrandName}
                  brandIconSources={assistantIconSources}
                  onTransferToDraft={onTransferToDraft}
                  onBranchFromMessage={(targetMessage) => chat.branchFromMessage(targetMessage.id)}
                  onRegenerateResponse={(targetMessage) => chat.regenerateResponse(targetMessage.id)}
                  onStopResponse={() => void chat.stopResponse()}
                  onSelectResponseVersion={(targetMessage, versionIndex) =>
                    chat.selectResponseVersion(targetMessage.id, versionIndex)
                  }
                  onUpdateDiagram={(targetMessage, previousSource, nextSource) =>
                    chat.updateAssistantDiagram(targetMessage.id, previousSource, nextSource)
                  }
                  onUpdateCode={(targetMessage, previousSource, nextSource, occurrence) =>
                    chat.updateAssistantCode(targetMessage.id, previousSource, nextSource, occurrence)
                  }
                  onUpdateTable={(targetMessage, previous, next, occurrence) =>
                    chat.updateAssistantTable(targetMessage.id, previous, next, occurrence)
                  }
                  onStagePromptInNewSession={stagePromptInNewChat}
                  isEditingPrompt={editingPromptId === message.id}
                  promptEditDisabled={isSending}
                  onStartEditPrompt={(targetMessage) => setEditingPromptId(targetMessage.id)}
                  onCancelEditPrompt={() => setEditingPromptId(null)}
                  onSubmitEditPrompt={(targetMessage, text) => {
                    const sent = chat.editUserMessage(targetMessage.id, text);
                    if (sent) setEditingPromptId(null);
                    return sent;
                  }}
                  citationDetailsExpanded={citationDetailsOpen && focusedCitationMessageId === message.id}
                  onToggleCitations={(targetMessage) => toggleCitationDetails(targetMessage.id)}
                  onOpenDocument={openDocument}
                  onSubmitFeedback={submitResponseFeedback}
                  customTools={customScriptTools}
                  onRunCustomTool={(tool, targetMessage) => void runCustomToolOnMessage(tool, targetMessage)}
                  streamPreviewEnabled={streamResponses}
                  trainingCaptureEnabled={Boolean(data.dataProtection?.training_capture_enabled)}
                />
              ))}
              {pendingHandoff && (
                <>
                  <MessageBubble
                    key={pendingHandoff.id}
                    message={{
                      id: pendingHandoff.id,
                      role: "user",
                      content: pendingHandoff.text,
                      createdAt: formatTimeLabel(pendingHandoff.createdAtIso),
                      createdAtIso: pendingHandoff.createdAtIso,
                      status: "ok",
                      attachments: pendingHandoff.attachments.map(toChatAttachment),
                    }}
                    userId={data.me.id}
                    userName={data.me.display_name}
                    userAvatarUrl={data.me.avatar_url}
                    brandName={assistantBrandName}
                    brandIconSources={assistantIconSources}
                  />
                  <DraftHandoffCard
                    handoff={pendingHandoff}
                    brandName={assistantBrandName}
                    brandIconSources={assistantIconSources}
                    carriesConversation={hasMessages}
                    editFileName={
                      pendingHandoff.kind === "edit"
                        ? (editableAttachment(pendingHandoff.attachments, pendingHandoff.text) ?? threadEditableAttachment(messages))?.name ?? null
                        : null
                    }
                    nudged={handoffNudged}
                    chatDisabled={isSending}
                    onOpenDrafts={() => void openPendingHandoffInDrafts()}
                    onContinueInChat={() => void continuePendingHandoffInChat()}
                    onEdit={editPendingHandoff}
                  />
                </>
              )}
              {contextWindowStatus.isFull ? (
                <div className="context-window-chat-notice" role="status">
                  Context window full. This session may stop using earlier details reliably.
                </div>
              ) : contextWindowStatus.tone === "danger" ? (
                <div className="context-window-chat-notice" role="status">
                  {`Context window ${contextWindowStatus.displayPercent} used. You can keep chatting — start a new chat when you want a fresh window with full attention on the details.`}
                </div>
              ) : null}
              <div ref={bottomRef} className="conversation-anchor" aria-hidden="true" />
            </div>
          )}

          {isComposerExpanded &&
            createPortal(
              <div className="composer-expanded-backdrop" aria-hidden="true" />,
              document.body,
            )}
          {showConversation ? (
            <div className="composer-dock">
              {composerForm}
              {disclaimer}
            </div>
          ) : (
            <>
              {composerForm}
              {!hasDraftText && !isImproving && (
                <div className="chat-starters" role="group" aria-label="Start a conversation">
                  {[
                    { label: "Explore an idea", detail: "Think through a direction or a question.", prompt: "Help me explore this idea: ", Icon: Sparkles },
                    { label: "Compare options", detail: "Weigh the trade-offs and find a next step.", prompt: "Help me compare these options: ", Icon: Split },
                    { label: "Draft a message", detail: "Find the right words for your audience.", prompt: "Help me draft a message. Here is the audience, purpose, and context: ", Icon: Pencil },
                  ].map(({ label, detail, prompt, Icon }) => (
                    <button
                      key={label}
                      type="button"
                      aria-label={label}
                      onClick={() => {
                        setDraft(prompt);
                        setSendMenuOpen(false);
                        textareaRef.current?.focus();
                      }}
                    >
                      <Icon size={18} aria-hidden="true" />
                      <span className="chat-starter-copy"><strong>{label}</strong><small>{detail}</small></span>
                      <ArrowUpRight size={15} className="chat-starter-arrow" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              )}
              {disclaimer}
            </>
          )}
        </div>
      </section>

      {isInspectorOpen && inspectorOverlay && (
        <button
          type="button"
          className="inspector-backdrop"
          tabIndex={-1}
          aria-label="Close session details"
          data-tooltip="Close the session details panel and return to the chat"
          onClick={closeInspector}
        />
      )}

      {isInspectorOpen && (
        <aside
          className="session-panel is-open"
          ref={inspectorRef}
          tabIndex={inspectorOverlay ? -1 : undefined}
          role={inspectorOverlay ? "dialog" : undefined}
          aria-modal={inspectorOverlay ? true : undefined}
          aria-label="Session details"
        >
          <header>
            <h2>Session details</h2>
            <button
              className="icon-button"
              type="button"
              aria-label="Close session details"
              data-tooltip="Hide the session details panel"
              onClick={closeInspector}
            >
              <ChevronRight size={16} />
            </button>
          </header>
          <SessionSummary
            data={data}
            thread={activeThread}
            modelName={modelName(chat)}
            composerTools={composerTools}
            selectedAgentName={selectedAgent?.name ?? null}
            activeToolNames={sessionToolNames}
            showSources={citationDetailsOpen}
            focusedCitationMessageId={focusedCitationMessageId}
            contextWindowStatus={contextWindowStatus}
            onOpenDocument={openDocument}
          />
        </aside>
      )}
      {documentViewerLayer}

      {cloudPicker && (
        <CloudAttachmentPicker
          picker={cloudPicker}
          onToggle={toggleCloudPickerItem}
          onAttach={() => void attachCloudPickerSelection()}
          onConnect={connectCloudPickerAccount}
          onClose={closeCloudPicker}
        />
      )}

      {customToolRun && (
        <CustomToolRunModal run={customToolRun} onClose={() => setCustomToolRun(null)} />
      )}
    </div>
    </ArtifactCanvasProvider>
    </CodeEditAssistProvider>
  );
}

/** The inline "Drafts or chat?" offer that answers a held document or deck
 * request. It reads as the assistant's reply, not a dialog. */
/** What the handoff card says for each Drafts editor. */
const HANDOFF_COPY: Record<DraftHandoffOffer, {
  announce: string;
  heading: string;
  detail: string;
  open: string;
  opening: string;
  openTooltip: string;
  chat: string;
  chatTooltip: string;
}> = {
  document: {
    announce: "This looks like a document. Choose Drafts or chat.",
    heading: "Write this in Drafts?",
    detail: "Drafts writes it as a full document you can edit, format, and export to Word or PDF. Or keep it here in chat.",
    open: "Write in Drafts",
    opening: "Opening Drafts…",
    openTooltip: "Open Drafts and start writing this document",
    chat: "Continue in chat",
    chatTooltip: "Send this to the assistant here in chat",
  },
  deck: {
    announce: "This looks like a slide deck. Choose the deck editor in Drafts or chat.",
    heading: "Build this as a slide deck?",
    detail: "The deck editor in Drafts builds real slides with layouts, themes, and speaker notes that export to PowerPoint. Or draft the slide content here in chat.",
    open: "Build in deck editor",
    opening: "Opening the deck editor…",
    openTooltip: "Open the deck editor in Drafts and start building these slides",
    chat: "Draft slides in chat",
    chatTooltip: "Have the assistant write out the slides here in chat",
  },
  edit: {
    announce: "This looks like a change to a document. Choose Drafts or chat.",
    heading: "Edit this document in Drafts?",
    detail: "Drafts opens the file with its formatting and makes the change right in the document, so you can see each edit. Or have the assistant answer here in chat.",
    open: "Edit in Drafts",
    opening: "Opening the document…",
    openTooltip: "Open this file in Drafts and make the change there",
    chat: "Continue in chat",
    chatTooltip: "Send this to the assistant here in chat",
  },
  spreadsheet: {
    announce: "This looks like a spreadsheet. Choose the spreadsheet editor in Drafts or chat.",
    heading: "Build this as a spreadsheet?",
    detail: "The spreadsheet editor in Drafts builds a real workbook with formulas, tables, charts, and pivot tables that exports to Excel. Or keep it here in chat.",
    open: "Build in spreadsheet editor",
    opening: "Opening the spreadsheet editor…",
    openTooltip: "Open the spreadsheet editor in Drafts and start building this workbook",
    chat: "Continue in chat",
    chatTooltip: "Have the assistant answer here in chat instead",
  },
};

function DraftHandoffCard({
  handoff,
  brandName,
  brandIconSources,
  carriesConversation,
  editFileName,
  nudged,
  chatDisabled,
  onOpenDrafts,
  onContinueInChat,
  onEdit,
}: {
  handoff: PendingDraftHandoff;
  brandName: string;
  brandIconSources: readonly string[];
  carriesConversation: boolean;
  /** The file an edit opens, named so the person knows which one. */
  editFileName: string | null;
  nudged: boolean;
  chatDisabled: boolean;
  onOpenDrafts: () => void;
  onContinueInChat: () => void;
  onEdit: () => void;
}) {
  const headingId = useId();
  const detailId = useId();
  const deck = handoff.kind === "deck";
  const sheet = handoff.kind === "spreadsheet";
  const copy = HANDOFF_COPY[handoff.kind];
  const busy = handoff.phase !== "choosing";
  const edit = handoff.kind === "edit";
  const KindIcon = edit ? FilePenLine : deck ? Presentation : sheet ? SheetIcon : FileText;
  const fileCount = handoff.attachments.length;
  const carried = [
    fileCount ? `${fileCount === 1 ? "Your file" : `Your ${fileCount} files`}` : "",
    carriesConversation ? "this conversation" : "",
  ].filter(Boolean);
  const carriedNote = editFileName
    ? `${editFileName} opens in the editor${carriesConversation ? ", and this conversation comes along" : ""}.`
    : `${carried.join(" and ")} ${carried.length > 1 || fileCount > 1 ? "come" : "comes"} along if you pick Drafts.`.replace(/^./, (letter) => letter.toUpperCase());
  return (
    <article className={`message assistant-message draft-handoff${nudged ? " is-nudged" : ""}`} data-kind={handoff.kind}>
      <div className="avatar aperture">
        <BrandIcon sources={brandIconSources} size={36} title={brandName || "Assistant"} className="message-brand-logo" />
      </div>
      <div className="message-body">
        {brandName && (
          <div className="message-meta">
            <strong>{brandName}</strong>
          </div>
        )}
        <section className="draft-handoff-card" aria-labelledby={headingId} aria-describedby={detailId}>
          <span className="sr-only" role="status">
            {copy.announce}
          </span>
          <div className="draft-handoff-head">
            <span className="draft-handoff-icon" aria-hidden="true">
              <KindIcon size={20} />
            </span>
            <div className="draft-handoff-copy">
              <h3 id={headingId}>{copy.heading}</h3>
              <p id={detailId}>{copy.detail}</p>
            </div>
          </div>
          <div className="draft-handoff-actions">
            <button
              type="button"
              className="draft-handoff-choice is-primary"
              disabled={busy}
              aria-busy={handoff.phase === "drafts"}
              data-tooltip={copy.openTooltip}
              onClick={onOpenDrafts}
            >
              {handoff.phase === "drafts" ? <Loader2 size={17} className="is-spinning" aria-hidden="true" /> : <KindIcon size={17} aria-hidden="true" />}
              <span>
                {handoff.phase === "drafts" ? copy.opening : copy.open}
              </span>
            </button>
            <button
              type="button"
              className="draft-handoff-choice"
              disabled={busy || chatDisabled}
              aria-busy={handoff.phase === "chat"}
              data-tooltip={copy.chatTooltip}
              onClick={onContinueInChat}
            >
              {handoff.phase === "chat" ? <Loader2 size={17} className="is-spinning" aria-hidden="true" /> : <MessageSquare size={17} aria-hidden="true" />}
              <span>{copy.chat}</span>
            </button>
            <button
              type="button"
              className="draft-handoff-edit"
              disabled={busy}
              data-tooltip="Put this request back in the composer to change it"
              onClick={onEdit}
            >
              <Pencil size={14} aria-hidden="true" />
              <span>Edit request</span>
            </button>
          </div>
          {carried.length > 0 && !handoff.error && (
            <p className="draft-handoff-note">
              {carriedNote}
            </p>
          )}
          {handoff.error && (
            <p className="draft-handoff-error" role="alert">
              {handoff.error}
            </p>
          )}
        </section>
      </div>
    </article>
  );
}

type CustomToolRunState = {
  tool: ToolConfig;
  status: "running" | "done" | "error";
  result: CustomScriptRunResult | null;
  error: string | null;
};

function CustomToolRunModal({ run, onClose }: { run: CustomToolRunState; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  useModalFocus(dialogRef, true, onClose);
  const result = run.result;

  async function copyOutput() {
    if (!result?.output) return;
    try {
      await navigator.clipboard.writeText(result.output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  function downloadOutput() {
    if (!result?.output) return;
    const blob = new Blob([result.output], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${run.tool.name.replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase() || "tool-output"}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal tool-run-modal"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`${run.tool.name} result`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-icon">
            <TerminalSquare size={20} />
          </span>
          <div>
            <h2>{run.tool.name}</h2>
            <p>
              {run.status === "running"
                ? "Running against this response…"
                : run.status === "error"
                  ? "The tool did not run."
                  : result?.status === "ok"
                    ? `Finished in ${result.duration_ms} ms${result.truncated ? " (output truncated)" : ""}.`
                    : result?.status === "timeout"
                      ? "The tool timed out before finishing."
                      : `The tool exited with an error (code ${result?.exit_code ?? "?"}).`}
            </p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close tool result"
            data-tooltip="Close this result"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>
        <div className="modal-body tool-run-body">
          {run.status === "error" && <p className="message-error">{run.error}</p>}
          {result?.output && <pre className="tool-run-output">{result.output}</pre>}
          {result?.error && <pre className="tool-run-output tool-run-stderr">{result.error}</pre>}
          {run.status === "done" && !result?.output && !result?.error && (
            <p className="tool-run-empty">The tool produced no output.</p>
          )}
        </div>
        {run.status === "done" && result?.output && (
          <div className="modal-actions">
            <button
              className="secondary-button compact"
              type="button"
              data-tooltip="Copy the tool output"
              onClick={() => void copyOutput()}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              className="secondary-button compact"
              type="button"
              data-tooltip="Download the tool output as a text file"
              onClick={downloadOutput}
            >
              <FileText size={14} /> Download
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function KnowledgeSourcePicker({
  knowledgeBases,
  selectedKnowledgeBaseId,
  onSelect,
}: {
  knowledgeBases: KnowledgeBase[];
  selectedKnowledgeBaseId: string | null;
  onSelect: (id: string) => void;
}) {
  // Flat checkbox-style rows, one line per source: the "Knowledge" toggle
  // above already names the section, so no heading, panel, or second line —
  // the menu stays compact no matter how many sources exist.
  return (
    <div className="knowledge-source-picker" role="group" aria-label="Knowledge source">
      {knowledgeBases.map((knowledge) => {
        const selected = knowledge.id === selectedKnowledgeBaseId;
        return (
          <button
            key={knowledge.id}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            className={`knowledge-source-option ${selected ? "is-selected" : ""}`}
            data-tooltip={`${knowledge.name}: ${knowledge.document_count.toLocaleString()} files · ${knowledge.source}`}
            onClick={() => onSelect(knowledge.id)}
          >
            <span className="knowledge-source-check" aria-hidden="true">
              {selected && <Check size={12} />}
            </span>
            <span className="knowledge-source-name">{knowledge.name}</span>
            <small>{knowledge.document_count.toLocaleString()} files</small>
          </button>
        );
      })}
    </div>
  );
}

function CloudAttachmentPicker({
  picker,
  onToggle,
  onAttach,
  onConnect,
  onClose,
}: {
  picker: CloudPickerState;
  onToggle: (itemId: string) => void;
  onAttach: () => void;
  onConnect: () => void;
  onClose: () => void;
}) {
  const Icon = picker.source.icon;
  const attaching = picker.status === "importing";
  const attachDisabled = attaching || picker.status !== "ready" || picker.selectedIds.length === 0;
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null);
  const activeItemId = picker.items.some((item) => item.id === focusedItemId) ? focusedItemId : picker.items[0]?.id;

  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(dialogRef, true, onClose);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal cloud-picker-modal"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloud-picker-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-icon">
            <Icon size={22} />
          </span>
          <div>
            <h2 id="cloud-picker-title">Choose from {picker.source.label}</h2>
            <p>{picker.source.blurb}</p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close"
            data-tooltip={`Close ${picker.source.label} picker`}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>

        <div className="modal-body cloud-picker-body">
          {picker.status === "loading" ? (
            <div className="policy-callout">
              <RefreshCw size={15} />
              <span>
                <strong>Loading {picker.source.label} files.</strong>
              </span>
            </div>
          ) : picker.status === "connect" ? (
            <div className="cloud-picker-connect">
              <div className="policy-callout">
                <Lock size={15} />
                <span>
                  <strong>Connect your {picker.source.label} account.</strong> A {picker.source.label} sign-in
                  window will open; approve read access and your files will load here automatically. Only you
                  can see files from your account.
                </span>
              </div>
              <button
                className="primary-button"
                type="button"
                data-tooltip={`Open the ${picker.source.label} sign-in window`}
                onClick={onConnect}
              >
                {picker.connectPending ? <RefreshCw size={16} /> : <Plug size={16} />}
                {picker.connectPending ? "Waiting for sign-in..." : `Connect ${picker.source.label}`}
              </button>
              {picker.connectPending && (
                <p className="muted-note">
                  Finish signing in to {picker.source.label} in the popup window. This list refreshes on its
                  own once access is granted.
                </p>
              )}
            </div>
          ) : picker.status === "error" ? (
            <div className="policy-callout cloud-picker-error">
              <Lock size={15} />
              <span>
                <strong>{picker.source.label} is not ready.</strong> {picker.error}
              </span>
            </div>
          ) : picker.items.length === 0 ? (
            <p className="muted-note">
              No attachable files came back from {picker.source.label}. Only files at the top level of the
              drive or configured folder appear here.
            </p>
          ) : (
            <>
              {picker.error && (
                <div className="policy-callout cloud-picker-error">
                  <Info size={15} />
                  <span>{picker.error}</span>
                </div>
              )}
              <div
                className="cloud-picker-list"
                role="listbox"
                aria-multiselectable="true"
                aria-label={`${picker.source.label} files`}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || attaching) return;
                  const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
                  const index = options.indexOf(event.target as HTMLButtonElement);
                  if (index < 0) return;
                  let next: number | undefined;
                  if (event.key === "ArrowDown") next = (index + 1) % options.length;
                  else if (event.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
                  else if (event.key === "Home") next = 0;
                  else if (event.key === "End") next = options.length - 1;
                  else if (event.key === " " || event.key === "Enter") {
                    event.preventDefault();
                    options[index].click();
                  }
                  if (next !== undefined) {
                    event.preventDefault();
                    options[next].focus({ preventScroll: true });
                    options[next].scrollIntoView?.({ block: "nearest" });
                  }
                }}
              >
                {picker.items.map((item) => {
                  const selected = picker.selectedIds.includes(item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      tabIndex={item.id === activeItemId ? 0 : -1}
                      onFocus={() => setFocusedItemId(item.id)}
                      className={`cloud-picker-item ${selected ? "is-selected" : ""}`}
                      onClick={() => onToggle(item.id)}
                      disabled={attaching}
                    >
                      <span className="cloud-picker-check" aria-hidden="true">
                        {selected ? <Check size={14} /> : <FileText size={14} />}
                      </span>
                      <span className="cloud-picker-item-copy">
                        <strong>{item.name}</strong>
                        <small>
                          {item.kind} · {item.size}
                          {item.modified_at ? ` · ${item.modified_at}` : ""}
                        </small>
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div className="modal-actions">
          <button
            className="secondary-button"
            type="button"
            data-tooltip="Close this picker without attaching files"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="primary-button"
            type="button"
            data-tooltip={`Attach selected ${picker.source.label} files to this message`}
            disabled={attachDisabled}
            onClick={onAttach}
          >
            {attaching ? <RefreshCw size={16} /> : <Paperclip size={16} />}
            {attaching
              ? "Attaching..."
              : `Attach selected${picker.selectedIds.length ? ` (${picker.selectedIds.length})` : ""}`}
          </button>
        </div>

        <div className="modal-foot">
          <ShieldCheck size={14} /> Attached files stay scoped to this chat turn and your workspace connector policy.
        </div>
      </div>
    </div>
  );
}

function UserMessageAvatar({ name, avatarUrl }: { name: string; avatarUrl?: string | null }) {
  return (
    <UserAvatar
      user={{ display_name: name, avatar_url: avatarUrl }}
      className="avatar teal user-message-avatar"
    />
  );
}

type AttachmentPreviewPlacement = {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
};

function isImageAttachment(attachment: ChatAttachment) {
  const mimeType = attachment.mime_type?.split(";", 1)[0].trim().toLowerCase() ?? "";
  return Boolean(
    attachment.id &&
      (attachment.kind.trim().toLowerCase() === "image" || mimeType.startsWith("image/")),
  );
}

function AttachmentChip({
  attachment,
  userId,
  onOpen,
}: {
  attachment: ChatAttachment;
  userId: string;
  /** Opens the file in the document viewer; absent when it has no stored id. */
  onOpen?: () => void;
}) {
  const anchorRef = useRef<HTMLElement | null>(null);
  const previewId = useId();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewIntent, setPreviewIntent] = useState(false);
  const [placement, setPlacement] = useState<AttachmentPreviewPlacement | null>(null);
  const canRequestPreview = isImageAttachment(attachment);

  useEffect(() => {
    setPreviewUrl(null);
    if (!canRequestPreview || !attachment.id || typeof URL.createObjectURL !== "function") return;

    const controller = new AbortController();
    let objectUrl: string | null = null;
    void loadChatAttachmentPreview(userId, attachment.id, { signal: controller.signal })
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPreviewUrl(null);
      });

    return () => {
      controller.abort();
      if (objectUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, canRequestPreview, userId]);

  useLayoutEffect(() => {
    if (!previewIntent || !previewUrl) {
      setPlacement(null);
      return;
    }

    const positionPreview = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const viewportPadding = 16;
      const gap = 10;
      const width = Math.min(520, Math.max(240, window.innerWidth - viewportPadding * 2));
      const left = Math.min(
        Math.max(viewportPadding, rect.left),
        Math.max(viewportPadding, window.innerWidth - width - viewportPadding),
      );
      const roomBelow = window.innerHeight - rect.bottom - gap - viewportPadding;
      const roomAbove = rect.top - gap - viewportPadding;
      const placeBelow = roomBelow >= 260 || roomBelow >= roomAbove;
      const maxHeight = Math.min(420, Math.max(140, placeBelow ? roomBelow : roomAbove));
      setPlacement({
        left,
        width,
        maxHeight,
        ...(placeBelow
          ? { top: rect.bottom + gap }
          : { bottom: window.innerHeight - rect.top + gap }),
      });
    };

    positionPreview();
    window.addEventListener("resize", positionPreview);
    window.addEventListener("scroll", positionPreview, true);
    return () => {
      window.removeEventListener("resize", positionPreview);
      window.removeEventListener("scroll", positionPreview, true);
    };
  }, [previewIntent, previewUrl]);

  const previewStyle: CSSProperties | undefined = placement
    ? {
        left: placement.left,
        width: placement.width,
        maxHeight: placement.maxHeight,
        top: placement.top,
        bottom: placement.bottom,
      }
    : undefined;

  const chipClass = `file-chip ${previewUrl ? "has-image-preview" : ""} ${onOpen ? "is-openable" : ""}`;
  const chipEvents = {
    onPointerEnter: () => setPreviewIntent(true),
    onPointerLeave: () => setPreviewIntent(false),
    onFocus: () => setPreviewIntent(true),
    onBlur: () => setPreviewIntent(false),
    onKeyDown: (event: ReactKeyboardEvent) => {
      if (event.key === "Escape") setPreviewIntent(false);
    },
  };
  const chipBody = (
    <>
      {previewUrl ? (
        <span className="file-image-thumbnail" aria-hidden="true">
          <img src={previewUrl} alt="" onError={() => setPreviewUrl(null)} />
        </span>
      ) : (
        <span className={`file-icon ${fileIconClass(attachment.kind)}`}>
          {attachment.kind[0]?.toUpperCase() ?? "F"}
        </span>
      )}
      <span>
        <strong>{attachment.name}</strong>
        <small>{[attachment.size, attachment.kind].filter(Boolean).join(" · ")}</small>
      </span>
      <FileText size={16} />
    </>
  );

  return (
    <>
      {onOpen ? (
        <button
          ref={anchorRef as RefObject<HTMLButtonElement>}
          type="button"
          className={chipClass}
          aria-label={`Open ${attachment.name}`}
          aria-describedby={previewIntent && previewUrl ? previewId : undefined}
          data-tooltip={`See ${attachment.name} as it opens from a citation`}
          onClick={(event) => {
            // Safari leaves focus behind on click, and closing returns it here.
            event.currentTarget.focus();
            onOpen();
          }}
          {...chipEvents}
        >
          {chipBody}
        </button>
      ) : (
        <div
          ref={anchorRef as RefObject<HTMLDivElement>}
          className={chipClass}
          tabIndex={previewUrl ? 0 : undefined}
          aria-describedby={previewIntent && previewUrl ? previewId : undefined}
          {...chipEvents}
        >
          {chipBody}
        </div>
      )}
      {previewIntent && previewUrl && placement
        ? createPortal(
            <div
              id={previewId}
              className="attachment-image-preview"
              role="tooltip"
              style={previewStyle}
            >
              <img
                src={previewUrl}
                alt={`Preview of ${attachment.name}`}
                style={{ maxHeight: Math.max(96, placement.maxHeight - 38) }}
              />
              <span>{attachment.name}</span>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function MessageBubble({
  message,
  userId,
  userName,
  userAvatarUrl,
  brandName,
  brandIconSources,
  onTransferToDraft,
  onBranchFromMessage,
  onRegenerateResponse,
  onStopResponse,
  onSelectResponseVersion,
  onUpdateDiagram,
  onUpdateCode,
  onUpdateTable,
  transferRequest,
  onStagePromptInNewSession,
  isEditingPrompt,
  promptEditDisabled,
  onStartEditPrompt,
  onCancelEditPrompt,
  onSubmitEditPrompt,
  citationDetailsExpanded,
  onToggleCitations,
  onOpenDocument,
  onSubmitFeedback,
  customTools,
  onRunCustomTool,
  streamPreviewEnabled,
  trainingCaptureEnabled = false,
}: {
  message: ChatMessage;
  userId: string;
  userName: string;
  userAvatarUrl?: string | null;
  brandName: string;
  brandIconSources: readonly string[];
  onTransferToDraft?: (message: ChatMessage, format: DraftTransferFormat) => void;
  onBranchFromMessage?: (message: ChatMessage) => ChatThread | null;
  onRegenerateResponse?: (message: ChatMessage) => boolean;
  onStopResponse?: () => void;
  onSelectResponseVersion?: (message: ChatMessage, versionIndex: number) => boolean;
  onUpdateDiagram?: (message: ChatMessage, previousSource: string, nextSource: string) => boolean;
  onUpdateCode?: (message: ChatMessage, previousSource: string, nextSource: string, occurrence: number) => boolean;
  onUpdateTable?: (message: ChatMessage, previous: MarkdownTable, next: MarkdownTable, occurrence: number) => boolean;
  /** The user message this reply answered; it can name the Drafts format. */
  transferRequest?: string | null;
  onStagePromptInNewSession?: (message: ChatMessage) => boolean;
  isEditingPrompt?: boolean;
  promptEditDisabled?: boolean;
  onStartEditPrompt?: (message: ChatMessage) => void;
  onCancelEditPrompt?: () => void;
  onSubmitEditPrompt?: (message: ChatMessage, text: string) => boolean;
  citationDetailsExpanded?: boolean;
  onToggleCitations?: (message: ChatMessage) => void;
  onOpenDocument?: (request: DocumentRequest) => void;
  onSubmitFeedback?: (message: ChatMessage, rating: ChatFeedbackRating, comment?: string) => void;
  customTools?: ToolConfig[];
  onRunCustomTool?: (tool: ToolConfig, message: ChatMessage) => void;
  streamPreviewEnabled?: boolean;
  /** The organization keeps de-identified copies of rated answers for its own model training. */
  trainingCaptureEnabled?: boolean;
}) {
  const isUser = message.role === "user";
  const displayMessage = messageWithActiveResponseVersion(message);
  const assistantContent = isUser
    ? { visibleContent: displayMessage.content, thinkingTraces: [] as string[] }
    : splitAssistantThinking(displayMessage.content);
  const visibleMessage =
    assistantContent.visibleContent === displayMessage.content
      ? displayMessage
      : { ...displayMessage, content: assistantContent.visibleContent };
  // Text already streamed in for a still-pending reply. Hidden while the
  // model is inside an unfinished <think> block — the trace stays private
  // until it closes, exactly as it would in the finished message.
  const streamedPendingContent =
    !isUser && displayMessage.status === "pending" && !/^\s*<(think|thinking)>/i.test(assistantContent.visibleContent)
      ? assistantContent.visibleContent
      : "";
  const traceState = replyTraceState(displayMessage, assistantContent.thinkingTraces);
  // A failed reply that streamed real text keeps that text as the reply and
  // shows the failure as a compact note instead of one giant error block.
  const failureNotice =
    !isUser && displayMessage.status === "error" && typeof displayMessage.metadata?.failureNotice === "string"
      ? displayMessage.metadata.failureNotice
      : null;
  const responseVersions = responseVersionsForMessage(message);
  const activeVersionIndex = activeResponseVersionIndex(message);
  const hasResponseVersions = !isUser && responseVersions.length > 1;
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [feedbackRating, setFeedbackRating] = useState<ChatFeedbackRating | null>(() =>
    feedbackRatingForMessage(message.id),
  );
  const [feedbackNoteOpen, setFeedbackNoteOpen] = useState(false);
  const [feedbackNoteDraft, setFeedbackNoteDraft] = useState("");
  const [editDraft, setEditDraft] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const responseContentRef = useRef<HTMLDivElement | null>(null);
  const timestamp = messageTimestamp(displayMessage);
  const hasPromptAttachments = (message.attachments?.length ?? 0) > 0;
  const canSendPromptToNewSession =
    isUser && Boolean(onStagePromptInNewSession) && (message.content.trim().length > 0 || hasPromptAttachments);
  const canEditPrompt = isUser && message.status === "ok" && Boolean(onSubmitEditPrompt);

  // Seed the inline editor with the untouched message text each time editing
  // opens; cancelling leaves the thread and this seed untouched.
  useEffect(() => {
    if (!isEditingPrompt) return;
    setEditDraft(message.content);
    setEditError(null);
  }, [isEditingPrompt, message.content]);

  function submitPromptEdit() {
    if (!onSubmitEditPrompt) return;
    const sent = onSubmitEditPrompt(message, editDraft);
    if (!sent) {
      setEditError("The edited message could not be sent. Check the text and try again.");
    }
  }
  const citationCount = !isUser ? (displayMessage.citations?.length ?? 0) : 0;
  const canViewCitations = citationCount > 0 && Boolean(onToggleCitations);
  // Only a row the reply is on record as citing is a citation; a consulted web
  // result, an attachment, or a tool result is a source.
  const citationNoun = displayMessage.citations?.every((citation) => citation.cited === true) ? "citation" : "source";
  const citationLabel = `${citationCount} ${citationNoun}${citationCount === 1 ? "" : "s"}`;
  const citationScope = useMemo(
    () => (onOpenDocument ? { citations: displayMessage.citations ?? [], onOpen: onOpenDocument } : null),
    [displayMessage.citations, onOpenDocument],
  );

  function flashActionStatus(status: string) {
    setActionStatus(status);
    window.setTimeout(() => {
      setActionStatus((current) => (current === status ? null : current));
    }, 1800);
  }

  async function copyResponseText() {
    try {
      await copyRichContentToClipboard(responseContentRef.current, messagePlainText(visibleMessage));
      flashActionStatus("Copied");
    } catch {
      flashActionStatus("Copy unavailable");
    }
  }

  function branchResponse() {
    const branch = onBranchFromMessage?.(visibleMessage);
    flashActionStatus(branch ? "Branched" : "Could not branch");
  }

  function regenerateResponse() {
    const started = onRegenerateResponse?.(displayMessage);
    flashActionStatus(started ? "Regenerating" : "Could not regenerate");
  }

  function selectResponseVersion(versionIndex: number) {
    const selected = onSelectResponseVersion?.(message, versionIndex);
    if (!selected) flashActionStatus("Could not switch");
  }

  function sendPromptToNewSession() {
    const staged = onStagePromptInNewSession?.(message);
    flashActionStatus(staged ? "Loaded in new chat" : "Could not load");
  }

  function submitFeedback(rating: ChatFeedbackRating) {
    onSubmitFeedback?.(displayMessage, rating);
    setFeedbackRating(rating);
    // Every thumb click offers a "why" note; the rating itself has already
    // been recorded, so closing the composer loses nothing.
    setFeedbackNoteOpen(true);
    flashActionStatus(`${feedbackLabel(rating)} feedback sent`);
  }

  function sendFeedbackNote() {
    const note = feedbackNoteDraft.trim();
    if (!feedbackRating || !note) return;
    onSubmitFeedback?.(displayMessage, feedbackRating, note);
    setFeedbackNoteDraft("");
    setFeedbackNoteOpen(false);
    flashActionStatus("Note sent");
  }

  function closeFeedbackNote() {
    setFeedbackNoteOpen(false);
    setFeedbackNoteDraft("");
  }

  return (
    <article className={`message ${isUser ? "user-message" : "assistant-message"}`}>
      {isUser ? (
        <UserMessageAvatar name={userName} avatarUrl={userAvatarUrl} />
      ) : (
        <div className="avatar aperture">
          <BrandIcon sources={brandIconSources} size={36} title={brandName || "Assistant"} className="message-brand-logo" />
        </div>
      )}
      <div className="message-body">
        <div className="message-meta">
          {(isUser || brandName) && <strong>{isUser ? "You" : brandName}</strong>}
          <time dateTime={timestamp.dateTime} data-tooltip={timestamp.title}>
            {timestamp.label}
          </time>
        </div>

        {/* One trace element for the whole reply: it sits outside the
            pending/finished branches so the steps already on screen (and the
            reader's fold choice) carry over when the reply finishes. */}
        {traceState && (
          <WorkTrace
            message={displayMessage}
            brandName={brandName}
            state={traceState}
            onStop={traceState === "pending" ? onStopResponse : undefined}
            thinkingTraces={traceState === "complete" ? assistantContent.thinkingTraces : undefined}
          />
        )}
        {isUser && isEditingPrompt ? (
          <form
            className="prompt-edit-form"
            style={{ display: "grid", gap: 8 }}
            onSubmit={(event) => {
              event.preventDefault();
              submitPromptEdit();
            }}
          >
            <textarea
              aria-label="Edit message"
              autoFocus
              rows={Math.min(8, Math.max(2, editDraft.split("\n").length))}
              value={editDraft}
              style={{
                width: "100%",
                border: "1px solid var(--border-strong)",
                borderRadius: "var(--radius-sm)",
                background: "var(--surface)",
                color: "var(--text)",
                padding: "8px 10px",
                fontSize: "var(--control-font-size)",
                lineHeight: 1.5,
                resize: "vertical",
              }}
              onChange={(event) => {
                setEditDraft(event.target.value);
                setEditError(null);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submitPromptEdit();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  onCancelEditPrompt?.();
                }
              }}
            />
            <p className="muted-note" style={{ margin: 0 }}>
              Sending replaces this message, removes everything after it in this chat, and asks again with the
              edited text{hasPromptAttachments ? " and the original attachments" : ""}.
            </p>
            {editError && (
              <p className="composer-error" style={{ margin: 0 }} role="alert">
                {editError}
              </p>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                type="button"
                className="secondary-button"
                data-tooltip="Keep the conversation exactly as it is"
                onClick={() => onCancelEditPrompt?.()}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={(!editDraft.trim() && !hasPromptAttachments) || promptEditDisabled}
                data-tooltip="Remove the later replies and resend this message with the edited text"
              >
                Send edited message
              </button>
            </div>
          </form>
        ) : displayMessage.status === "pending" ? (
          <>
            {/* The trace (above) keeps working through its steps for the
                whole run; once real tokens arrive they stream in below it, so
                thinking and writing read as consecutive phases of one reply. */}
            {streamPreviewEnabled && streamedPendingContent && (
              <>
                <div className="message-rendered-response message-stream-live" ref={responseContentRef}>
                  <Markdown content={streamedPendingContent} streaming />
                </div>
                <WorkTraceStreamStatus message={displayMessage} />
              </>
            )}
          </>
        ) : displayMessage.status === "error" ? (
          failureNotice && assistantContent.visibleContent ? (
            <>
              <div className="message-rendered-response" ref={responseContentRef}>
                <CitationMarkerContext.Provider value={citationScope}>
                  <Markdown content={assistantContent.visibleContent} />
                </CitationMarkerContext.Provider>
              </div>
              <p className="message-error">{failureNotice}</p>
            </>
          ) : (
            <p className="message-error">{displayMessage.content}</p>
          )
        ) : displayMessage.content ? (
          <>
            {isUser ? (
              <PlainText content={displayMessage.content} />
            ) : assistantContent.visibleContent ? (
              <div className="message-rendered-response" ref={responseContentRef}>
                <CitationMarkerContext.Provider value={citationScope}>
                  <Markdown
                    content={assistantContent.visibleContent}
                    onUpdateCode={
                      onUpdateCode
                        ? (previousSource, nextSource, occurrence) =>
                            onUpdateCode(message, previousSource, nextSource, occurrence)
                        : undefined
                    }
                    onUpdateDiagram={
                      onUpdateDiagram
                        ? (previousSource, nextSource) => onUpdateDiagram(message, previousSource, nextSource)
                        : undefined
                    }
                    onUpdateTable={
                      onUpdateTable ? (previous, next, occurrence) => onUpdateTable(message, previous, next, occurrence) : undefined
                    }
                  />
                </CitationMarkerContext.Provider>
              </div>
            ) : null}
          </>
        ) : null}

        {!isUser && displayMessage.status === "ok" && <MemoryNotes message={displayMessage} />}

        {displayMessage.attachments?.map((attachment) => (
          <AttachmentChip
            attachment={attachment}
            userId={userId}
            onOpen={
              attachment.id && onOpenDocument
                ? () => onOpenDocument({ kind: "attachment", attachmentId: attachment.id as string, chunkId: null })
                : undefined
            }
            key={attachment.id ?? attachment.name}
          />
        ))}

        {isUser && message.status === "ok" && !isEditingPrompt && (canSendPromptToNewSession || canEditPrompt) && (
          <div className="message-actions prompt-message-actions">
            <div className="message-quick-actions">
              {actionStatus && (
                <span className="message-action-status" role="status">
                  {actionStatus}
                </span>
              )}
              {canEditPrompt && (
                <button
                  className="message-icon-action"
                  type="button"
                  aria-label="Edit message"
                  data-tooltip={
                    promptEditDisabled
                      ? "Wait for the current response to finish before editing"
                      : "Edit this message — sending the edit removes the later replies and asks again"
                  }
                  disabled={promptEditDisabled}
                  onClick={() => onStartEditPrompt?.(message)}
                >
                  <Pencil size={16} />
                </button>
              )}
              {canSendPromptToNewSession && (
                <button
                  className="message-icon-action"
                  type="button"
                  aria-label="Load prompt in new chat"
                  data-tooltip="Load this prompt and its attachments into a new chat composer"
                  onClick={sendPromptToNewSession}
                >
                  <Send size={16} />
                </button>
              )}
            </div>
          </div>
        )}

        {!isUser && displayMessage.status === "ok" && displayMessage.content && (
          <div className="message-actions">
            <div className="message-quick-actions">
              {hasResponseVersions && (
                <span className="message-version-controls" aria-label="Response versions">
                  <button
                    className="message-icon-action"
                    type="button"
                    aria-label="Previous response version"
                    data-tooltip="Show the previous version"
                    disabled={activeVersionIndex <= 0}
                    onClick={() => selectResponseVersion(activeVersionIndex - 1)}
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <span className="message-version-label">
                    {activeVersionIndex + 1} / {responseVersions.length}
                  </span>
                  <button
                    className="message-icon-action"
                    type="button"
                    aria-label="Next response version"
                    data-tooltip="Show the next version"
                    disabled={activeVersionIndex >= responseVersions.length - 1}
                    onClick={() => selectResponseVersion(activeVersionIndex + 1)}
                  >
                    <ChevronRight size={16} />
                  </button>
                </span>
              )}
              <button
                className="message-icon-action"
                type="button"
                aria-label="Copy response text"
                data-tooltip="Copy this response with formatting when supported"
                onClick={() => void copyResponseText()}
              >
                <Copy size={16} />
              </button>
              {onBranchFromMessage && (
                <button
                  className="message-icon-action branch-response-action"
                  type="button"
                  aria-label="Branch response into new chat"
                  data-tooltip="Start a new chat that continues from this response"
                  onClick={branchResponse}
                >
                  <Split size={16} />
                </button>
              )}
              {onRegenerateResponse && (
                <button
                  className="message-icon-action regenerate-response-action"
                  type="button"
                  aria-label="Regenerate response"
                  data-tooltip="Generate another version from the same prompt"
                  onClick={regenerateResponse}
                >
                  <RefreshCw size={16} />
                </button>
              )}
              {onRunCustomTool && (customTools?.length ?? 0) > 0 && (
                <span className="message-custom-tool-actions" aria-label="Response actions">
                  {customTools!.map((tool) => (
                    <button
                      key={tool.id}
                      className="message-icon-action"
                      type="button"
                      aria-label={`Use response action ${tool.name} on this response`}
                      data-tooltip={`Use response action "${tool.name}"${tool.description ? ` - ${tool.description}` : ""}`}
                      onClick={() => onRunCustomTool(tool, visibleMessage)}
                    >
                      <TerminalSquare size={16} />
                    </button>
                  ))}
                </span>
              )}
              {onSubmitFeedback && (
                <span className="message-feedback-actions" aria-label="Response feedback">
                  <button
                    className="message-icon-action"
                    type="button"
                    aria-label="Send positive feedback"
                    aria-pressed={feedbackRating === "positive"}
                    data-tooltip="Mark this response as helpful to improve future answers"
                    onClick={() => submitFeedback("positive")}
                  >
                    <ThumbsUp size={16} />
                  </button>
                  <button
                    className="message-icon-action"
                    type="button"
                    aria-label="Send negative feedback"
                    aria-pressed={feedbackRating === "negative"}
                    data-tooltip="Flag this response as unhelpful to improve future answers"
                    onClick={() => submitFeedback("negative")}
                  >
                    <ThumbsDown size={16} />
                  </button>
                </span>
              )}
              {canViewCitations && (
                <button
                  className="message-citation-action"
                  type="button"
                  aria-label={citationDetailsExpanded ? `Hide ${citationLabel}` : `View ${citationLabel}`}
                  data-tooltip={
                    citationDetailsExpanded
                      ? "Hide the source list in the session details panel"
                      : "Open session details and show the sources behind this response"
                  }
                  onClick={() => onToggleCitations?.(displayMessage)}
                >
                  {citationDetailsExpanded ? `Hide ${citationNoun}s` : `View ${citationLabel}`} →
                </button>
              )}
              {actionStatus && (
                <span className="message-action-status" role="status">
                  {actionStatus}
                </span>
              )}
            </div>
            {feedbackNoteOpen && feedbackRating && (
              <div className="feedback-note-composer" role="group" aria-label="Feedback note">
                <textarea
                  rows={2}
                  placeholder={
                    feedbackRating === "positive"
                      ? "What worked well? Add a note (optional)"
                      : "What went wrong? Add a note (optional)"
                  }
                  aria-label="Feedback note (optional)"
                  value={feedbackNoteDraft}
                  onChange={(event) => setFeedbackNoteDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      closeFeedbackNote();
                    }
                  }}
                  maxLength={2000}
                />
                {trainingCaptureEnabled && (
                  <p className="feedback-note-disclosure">
                    <Lock size={12} aria-hidden="true" /> Your organization keeps a de-identified copy of rated answers
                    and notes to improve its own models. It is never sent to a model provider.
                  </p>
                )}
                <div className="feedback-note-actions">
                  <button
                    className="secondary-button compact"
                    type="button"
                    disabled={!feedbackNoteDraft.trim()}
                    onClick={sendFeedbackNote}
                  >
                    Send note
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label="Close feedback note"
                    data-tooltip="Close without adding a note"
                    onClick={closeFeedbackNote}
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
            )}
            {onTransferToDraft && (
              <TransferDraftMenu message={visibleMessage} request={transferRequest} onTransfer={onTransferToDraft} />
            )}
          </div>
        )}
      </div>
    </article>
  );
}

/** The user message a reply at `index` answered (the nearest one above it). */
function requestBefore(messages: ChatMessage[], index: number): string | null {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor]!.role === "user") return messages[cursor]!.content;
  }
  return null;
}

/** Whether a reply shows its work trace, and in which phase: always while it
 * runs, and once finished when there is a trace or exposed thinking to show. */
function replyTraceState(message: ChatMessage, thinkingTraces: string[]): "pending" | "complete" | null {
  if (message.role === "user") return null;
  if (message.status === "pending") return "pending";
  if (message.status === "error" || !message.content) return null;
  return (message.activityTrace?.length ?? 0) > 0 || thinkingTraces.length > 0 ? "complete" : null;
}

function agentProfileOptions(data: BootstrapData): ModelConfig[] {
  const locked = hermesLocked(data);
  return visibleAgentProfiles(data).filter((agent) => !(locked && isHermesAgent(agent)));
}

/** MCP connections this user can actually run, mirroring the server's skip
 * rules, so the composer never offers a connection the send would drop. */
function usableMcpTools(data: BootstrapData): ToolConfig[] {
  if (!connectorEnabled(data.connectors, "mcp")) return [];
  const lockHermes = hermesLocked(data);
  return data.tools.filter(
    (tool) => isMcpRuntimeTool(tool) && toolUsableBy(data.me, tool) && !(lockHermes && isHermesTool(tool)),
  );
}

/** Hermes agents the viewer can see but not use until an admin grants Hermes. */
function lockedHermesAgentProfiles(data: BootstrapData): ModelConfig[] {
  return hermesLocked(data) ? visibleAgentProfiles(data).filter(isHermesAgent) : [];
}

function modelKnowledgeIds(model: ModelConfig): string[] {
  return model.knowledge_config_ids ?? model.knowledge_base_ids ?? [];
}

function modelToolIds(model: ModelConfig): string[] {
  return model.tool_config_ids ?? model.tool_ids ?? [];
}

function agentKnowledgeDocumentCount(data: BootstrapData, model: ModelConfig): number {
  const ids = new Set(modelKnowledgeIds(model));
  return data.knowledgeBases.reduce((total, item) => (ids.has(item.id) ? total + item.document_count : total), 0);
}

function composerToolSummaries(
  composerTools: ComposerTools,
  options: {
    selectedKnowledgeBaseName?: string;
    selectedAgentName?: string;
  },
): ComposerToolSummary[] {
  const summaries: ComposerToolSummary[] = [];
  if (composerTools.Knowledge) {
    summaries.push({
      key: "Knowledge",
      label: "Knowledge",
      title: options.selectedKnowledgeBaseName
        ? `Knowledge: ${options.selectedKnowledgeBaseName}`
        : "Knowledge sources enabled",
      icon: BookOpen,
    });
  }
  if (composerTools.Web) {
    summaries.push({
      key: "Web",
      label: "Web search",
      title: "Provider-hosted public web search enabled",
      icon: Globe2,
    });
  }
  if (composerTools.Agent) {
    summaries.push({
      key: "Agent",
      label: "Agent",
      title: options.selectedAgentName ? `Agent: ${options.selectedAgentName}` : "Agent tools enabled",
      icon: Bot,
    });
  }
  return summaries;
}

function PlainText({ content }: { content: string }) {
  const paragraphs = content.split(/\n{2,}/);
  return (
    <>
      {paragraphs.map((paragraph, index) => (
        <p key={index}>
          {paragraph.split("\n").map((line, lineIndex) => (
            <Fragment key={lineIndex}>
              {lineIndex > 0 && <br />}
              {renderConcealed(line, `l${index}-${lineIndex}`)}
            </Fragment>
          ))}
        </p>
      ))}
    </>
  );
}

function ContextWindowIndicator({ status, onOpenDetails }: { status: ContextWindowStatus; onOpenDetails: () => void }) {
  const style = {
    "--context-progress": `${status.progressPercent}%`,
  } as CSSProperties;
  const hasProgress = status.isMeasured && status.contextTokens > 0;
  return (
    <button
      type="button"
      className={`context-window-indicator is-${status.tone} ${hasProgress ? "has-context-progress" : "is-empty"}`}
      aria-label={`${status.label}: ${status.isMeasured ? `${status.displayPercent} used` : status.detail}`}
      data-tooltip={`${status.tooltip}\nOpen Session details for more context.`}
      style={style}
      onClick={onOpenDetails}
    >
      <span className="context-window-ring" aria-hidden="true">
        {hasProgress && <span>{status.displayPercent}</span>}
      </span>
    </button>
  );
}

function ContextWindowDetails({ status }: { status: ContextWindowStatus }) {
  const style = {
    "--context-progress": `${status.progressPercent}%`,
  } as CSSProperties;
  const usedLabel = status.isMeasured
    ? `${status.isEstimated ? "≈" : ""}${formatTokenCount(status.contextTokens)} of ${formatTokenCount(status.contextWindow ?? 0)} tokens used${status.isEstimated ? " (estimated)" : ""}`
    : status.contextWindow
      ? `Window size: ${formatTokenCount(status.contextWindow)} tokens`
      : "Window size not configured";
  return (
    <div className={`context-window-detail is-${status.tone}`} style={style}>
      <div className="context-window-detail-head">
        <span>
          <strong>Context window</strong>
          <small>{status.label}</small>
        </span>
        <b>{status.isMeasured ? status.displayPercent : "—"}</b>
      </div>
      <div
        className="context-window-meter"
        role="meter"
        aria-label={status.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(status.progressPercent)}
      >
        <span />
      </div>
      <p>{usedLabel}</p>
      <p>
        A context window is how much of this chat, attachments, and source text the model can keep in view when it
        answers. As it fills up, older details may matter less; at 100%, starting a new chat is usually more reliable.
      </p>
      <small>{status.detail}</small>
    </div>
  );
}

function SessionSummary({
  data,
  thread,
  modelName,
  composerTools,
  selectedAgentName,
  activeToolNames,
  showSources,
  focusedCitationMessageId,
  contextWindowStatus,
  onOpenDocument,
}: {
  data: BootstrapData;
  thread: ChatThread | null;
  modelName: string;
  composerTools: { Knowledge: boolean; Web: boolean; Agent: boolean };
  selectedAgentName?: string | null;
  activeToolNames: string[];
  showSources: boolean;
  focusedCitationMessageId?: string | null;
  contextWindowStatus: ContextWindowStatus;
  onOpenDocument: (request: DocumentRequest) => void;
}) {
  const messages = thread?.messages ?? [];
  const hasMessages = messages.length > 0;
  const userMessages = messages.filter((message) => message.role === "user").length;
  const assistantMessages = messages.filter(
    (message) => message.role === "assistant" && message.status === "ok",
  ).length;
  const enabledKnowledgeBases = data.knowledgeBases.filter((knowledge) => knowledge.enabled);
  const enabledConnectors = data.connectors.filter((connector) => connector.tenant_enabled);
  const toolsDetail = activeToolNames.length > 0 ? activeToolNames.join(", ") : "None on for this chat";
  const toolsStatus = activeToolNames.length > 0 ? `${activeToolNames.length} on` : "Off";
  const usageTotals = contextWindowStatus.usageTotals;

  const rows: Array<[string, string, string]> = hasMessages
    ? [
        [
          "Current chat",
          `${userMessages} user message${userMessages === 1 ? "" : "s"}`,
          `${assistantMessages} response${assistantMessages === 1 ? "" : "s"}`,
        ],
        [
          "Tokens used",
          usageTotals.reportedReplies > 0
            ? `${formatTokenCount(usageTotals.prompt)} in · ${formatTokenCount(usageTotals.completion)} out`
            : "Not reported by the provider",
          usageTotals.reportedReplies > 0 ? `${formatTokenCount(usageTotals.total)} total` : "—",
        ],
        ["Model", modelName, "Active"],
        [
          "Knowledge bases",
          `${enabledKnowledgeBases.length} enabled`,
          composerTools.Knowledge ? "In use" : "Available",
        ],
        ["Tools", toolsDetail, toolsStatus],
        ["Agent profile", selectedAgentName ?? "None selected", composerTools.Agent ? "Selected" : "Off"],
      ]
    : [
        ["Model", modelName, "Ready"],
        [
          "Knowledge bases",
          `${enabledKnowledgeBases.length} enabled`,
          composerTools.Knowledge ? "In use" : "Available",
        ],
        ["Tools", toolsDetail, toolsStatus],
        ["Agent profile", selectedAgentName ?? "None selected", composerTools.Agent ? "Selected" : "Off"],
        ["Connectors", `${enabledConnectors.length} enabled`, composerTools.Web ? "Web on" : "Workspace"],
      ];

  return (
    <section className="audit-list">
      <div className="session-section">
        <div className="audit-heading">
          <h3>Session summary</h3>
        </div>
        <div className="session-slab">
          {rows.map(([label, detail, time]) => (
            <div className="audit-row" key={label}>
              <span>
                <strong>{label}</strong>
                <small>{detail}</small>
              </span>
              <time>{time}</time>
            </div>
          ))}
        </div>
      </div>
      <ContextWindowDetails status={contextWindowStatus} />
      {showSources && (
        <SessionSources messages={messages} focusedMessageId={focusedCitationMessageId} onOpenDocument={onOpenDocument} />
      )}
      <div className="session-shortcuts" role="group" aria-label="Symbol shortcuts">
        <div className="audit-heading">
          <h3>Symbol shortcuts</h3>
        </div>
        <p>Start a word in the message box with a symbol to pick from a list.</p>
        <dl>
          {COMPOSER_SHORTCUTS.map(({ symbol, label, detail }) => (
            <div key={symbol}>
              <dt><kbd>{symbol}</kbd></dt>
              <dd>
                <strong>{label}</strong>
                <small>{detail}</small>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function modelName(chat: ChatStore) {
  return chat.enabledModels.find((model) => model.id === chat.model)?.name ?? "No connected model";
}

/** Time-of-day greeting for the empty chat, personal without being cute:
 * morning, afternoon, and evening get the classics; the small hours get a
 * knowing nod instead of "good night". */
export function timeOfDayGreeting(hour: number, displayName: string): string {
  const first = (displayName || "").trim().split(/\s+/)[0] || "there";
  if (hour >= 5 && hour < 12) return `Good morning, ${first}.`;
  if (hour >= 12 && hour < 17) return `Good afternoon, ${first}.`;
  if (hour >= 17 && hour < 21) return `Good evening, ${first}.`;
  return `Burning the midnight oil, ${first}?`;
}
