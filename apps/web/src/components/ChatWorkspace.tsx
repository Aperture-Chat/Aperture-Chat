import { SelectControl } from "./SelectControl";
import {
  ReasoningSlider,
  REASONING_EFFORT_BY_LEVEL,
  loadReasoningLevel,
  storeReasoningLevel,
  type ReasoningLevel,
} from "./ReasoningSlider";
import {
  BookOpen,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  FileText,
  Globe2,
  Info,
  Link2,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  Paperclip,
  Pencil,
  Play,
  Plug,
  Quote,
  RefreshCw,
  ScrollText,
  Send,
  ShieldCheck,
  Split,
  Sparkles,
  Star,
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
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type {
  BootstrapData,
  ChatAttachment,
  ChatCitation,
  ChatFeedbackRating,
  ChatMessage,
  ChatThread,
  CloudAttachmentItem,
  Automation,
  CustomScriptRunResult,
  KnowledgeBase,
  KnowledgeDocument,
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
  ChatRequestError,
  getCloudAttachmentAuthorizeUrl,
  importCloudAttachments,
  listCloudAttachmentItems,
  listKnowledgeDocuments,
  loadChatAttachmentPreview,
  runCustomScriptTool,
  sendChat,
  submitChatFeedback,
  uploadChatAttachment,
  type ChatRuntimeOptions,
} from "../lib/api";
import { supportsReasoningEffort, visibleAgentProfiles, webSearchSupportedForModel } from "../lib/modelAccess";
import { connectorEnabled, isMcpRuntimeTool } from "../lib/connectors";
import { formatTimeLabel, formatTimestamp } from "../lib/serverClock";
import { feedbackRatingForMessage, recordChatFeedback } from "../lib/chatFeedback";
import { markdownToPlainText } from "../lib/markdown";
import { splitAssistantThinking } from "../lib/assistantThinking";
import { loadLiveStreamPreference, storeLiveStreamPreference } from "../lib/streamPreference";
import { BREAKPOINTS, useViewportWidth } from "../lib/useViewport";
import { DictationControl } from "./DictationControl";
import { isMediaUploadFile } from "../lib/mediaUploads";
import { Markdown } from "./Markdown";
import { ApertureMark, Pill } from "./Primitives";
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
  label: string;
  icon: ConnectorIcon;
  blurb: string;
};
type ComposerTools = { Knowledge: boolean; Web: boolean; Agent: boolean; Mcp: boolean };
type ComposerToolSummary = {
  key: keyof ComposerTools;
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
    label: "Google Drive",
    icon: GoogleDriveIcon,
    blurb: "Attach and cite documents from Google Drive.",
  },
  {
    id: "onedrive",
    label: "OneDrive",
    icon: OneDriveIcon,
    blurb: "Bring in files from Microsoft OneDrive.",
  },
  {
    id: "sharepoint",
    label: "SharePoint",
    icon: SharePointIcon,
    blurb: "Pull from SharePoint document libraries.",
  },
  {
    id: "box",
    label: "Box",
    icon: BoxIcon,
    blurb: "Connect Box folders for matter files.",
  },
  {
    id: "imanage",
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

const KIND_BY_EXT: Record<string, string> = {
  pdf: "PDF",
  doc: "Word",
  docx: "Word",
  rtf: "Word",
  xls: "Excel",
  xlsx: "Excel",
  csv: "CSV",
  ppt: "PPT",
  pptx: "PPT",
  png: "Image",
  jpg: "Image",
  jpeg: "Image",
  gif: "Image",
  webp: "Image",
  svg: "Image",
  txt: "Text",
  md: "Text",
  eml: "Email",
  zip: "Archive",
  mp3: "Audio",
  wav: "Audio",
  m4a: "Audio",
  aac: "Audio",
  ogg: "Audio",
  oga: "Audio",
  flac: "Audio",
  mp4: "Video",
  mov: "Video",
  m4v: "Video",
  webm: "Video",
  mkv: "Video",
  avi: "Video",
  mpeg: "Video",
  mpg: "Video",
};

function fileKind(name: string): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return KIND_BY_EXT[ext] ?? (ext ? ext.toUpperCase() : "File");
}

function fileIconClass(kind: string): string {
  const value = kind.toLowerCase();
  if (value.includes("pdf")) return "pdf";
  if (value.includes("word") || value.includes("doc")) return "word";
  if (value.includes("email") || value === "eml") return "eml";
  return "file-generic";
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

type ComposerCommandSymbol = "#" | "/" | "$" | "@" | ">";

type ComposerCommandToken = {
  symbol: ComposerCommandSymbol;
  query: string;
  /** Index of the symbol character in the draft. */
  start: number;
};

type ComposerCommandItem = {
  id: string;
  section: string;
  name: string;
  detail: string;
} & (
  | { kind: "knowledge-base"; base: KnowledgeBase }
  | { kind: "knowledge-file"; doc: KnowledgeDocument; base: KnowledgeBase }
  | { kind: "prompt"; prompt: PromptTemplate }
  | { kind: "mcp-tool"; tool: ToolConfig }
  | { kind: "skill"; skill: SkillFile }
  | { kind: "agent"; agent: ModelConfig }
  | { kind: "automation"; automation: Automation }
);

const COMMAND_MENU_TITLES: Record<ComposerCommandSymbol, string> = {
  "#": "Knowledge",
  "/": "Prompts and tools",
  $: "Skill files",
  "@": "Agents",
  ">": "Automations",
};
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
function detectComposerCommandToken(value: string, caret: number | null): ComposerCommandToken | null {
  if (caret === null) return null;
  const before = value.slice(0, caret);
  const match = /(?:^|\s)([#/$@>])([\w .()&-]{0,60})$/.exec(before);
  if (!match) return null;
  return {
    symbol: match[1] as ComposerCommandSymbol,
    query: match[2],
    start: before.length - match[2].length - 1,
  };
}

/** Sorts command matches so name-prefix hits rank above substring hits. */
function rankCommandMatches<T>(entries: T[], nameOf: (entry: T) => string, query: string): T[] {
  const q = query.trim().toLowerCase();
  return entries
    .filter((entry) => nameOf(entry).toLowerCase().includes(q))
    .sort((a, b) => {
      const aPrefix = nameOf(a).toLowerCase().startsWith(q) ? 0 : 1;
      const bPrefix = nameOf(b).toLowerCase().startsWith(q) ? 0 : 1;
      return aPrefix - bPrefix || nameOf(a).localeCompare(nameOf(b));
    });
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
  const selectedAgent = selectedAgentId ? data.models.find((model) => model.id === selectedAgentId) : undefined;
  const agentKnowledgeIds = selectedAgent ? modelKnowledgeIds(selectedAgent) : [];
  const agentToolIds = selectedAgent ? modelToolIds(selectedAgent) : [];
  const enabledKnowledgeBases = data.knowledgeBases.filter((knowledge) => knowledge.enabled);
  const selectedKnowledgeBase =
    enabledKnowledgeBases.find((knowledge) => knowledge.id === selectedKnowledgeBaseId) ?? enabledKnowledgeBases[0];
  const selectedKnowledgeIds = selectedKnowledgeBase ? [selectedKnowledgeBase.id] : [];
  const requestedToolIds = selectedToolIds.filter((id) => data.tools.some((tool) => tool.id === id && tool.enabled));
  // The MCP switch attaches every enabled MCP server for this reply. MCP tools
  // only run inside the agent runtime, so turning it on turns that on too —
  // otherwise the server would silently drop them and the model would report
  // having no MCP connection.
  const mcpToolIds = composerTools.Mcp
    ? data.tools.filter((tool) => tool.enabled && isMcpRuntimeTool(tool)).map((tool) => tool.id)
    : [];
  const agentEnabled = composerTools.Agent || requestedToolIds.length > 0 || mcpToolIds.length > 0;
  const baseToolIds =
    composerTools.Agent && selectedAgent
      ? agentToolIds
      : composerTools.Agent
        ? data.tools.filter((tool) => tool.enabled).map((tool) => tool.id)
        : [];
  return {
    agentProfileId: agentEnabled && selectedAgent ? selectedAgent.id : null,
    modelOverride: agentEnabled && selectedAgent ? selectedAgent.id : null,
    knowledgeConfigIds:
      agentEnabled && selectedAgent ? agentKnowledgeIds : knowledgeEnabled ? selectedKnowledgeIds : [],
    toolConfigIds: [...new Set([...baseToolIds, ...requestedToolIds, ...mcpToolIds])],
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
    !selectedAgentId && runtime.agentEnabled && activeModel ? modelToolIds(activeModel) : [];
  const approvalTools = [...new Set([...(runtime.toolConfigIds ?? []), ...profileToolIds])]
    .map((id) => data.tools.find((tool) => tool.id === id))
    .filter((tool): tool is ToolConfig => Boolean(tool))
    .filter((tool) => tool.enabled && tool.approval_required && isMcpRuntimeTool(tool));
  if (approvalTools.length === 0) return null;
  const selectedAgent = selectedAgentId ? data.models.find((model) => model.id === selectedAgentId) : undefined;
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
  brandLogoUrl,
  requestedAgentId,
  onRequestedAgentConsumed,
  onTransferToDraft,
}: {
  data: BootstrapData;
  chat: ChatStore;
  brandName?: string | null;
  brandLogoUrl?: string | null;
  requestedAgentId?: string | null;
  onRequestedAgentConsumed?: () => void;
  onTransferToDraft?: (message: ChatMessage) => void;
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
  // Web search defaults on whenever the selected model supports it; an
  // effect below turns it back off if the user routes to an unsupported model.
  const [composerTools, setComposerTools] = useState<ComposerTools>(() => ({
    Knowledge: false,
    Web: webSearchSupportedForModel(
      data,
      chat.enabledModels.find((model) => model.id === chat.model),
    ),
    Agent: false,
    Mcp: false,
  }));
  const [selectedKnowledgeBaseId, setSelectedKnowledgeBaseId] = useState<string | null>(null);
  const [knowledgePickerOpen, setKnowledgePickerOpen] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  // Fast–Smart reasoning level for the composer; sticky per user.
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>(() => loadReasoningLevel(data.me.id));
  // Show replies as they stream in; sticky per user, display-only.
  const [streamResponses, setStreamResponses] = useState(() => loadLiveStreamPreference(data.me.id));
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
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
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const [cloudPicker, setCloudPicker] = useState<CloudPickerState | null>(null);
  const [commandToken, setCommandToken] = useState<ComposerCommandToken | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>([]);
  const [pendingAutomations, setPendingAutomations] = useState<Automation[]>([]);
  const [knowledgeDocs, setKnowledgeDocs] = useState<Record<string, KnowledgeDocument[]>>({});
  const [knowledgeDocsStatus, setKnowledgeDocsStatus] = useState<"idle" | "loading" | "loaded">("idle");
  const [customToolRun, setCustomToolRun] = useState<CustomToolRunState | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachRef = useRef<HTMLDivElement | null>(null);
  const sendRef = useRef<HTMLDivElement | null>(null);
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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isImproving) setIsComposerExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isComposerExpanded, isImproving]);
  const width = useViewportWidth();
  const inspectorOverlay = width <= BREAKPOINTS.inspectorOverlay;

  const customScriptTools = useMemo(
    () => data.tools.filter((tool) => tool.type === "custom_script" && tool.enabled),
    [data.tools],
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
  // The AI naming button appears only once the chat has a finalized exchange;
  // pending or errored replies never unlock it.
  const hasCompletedAssistantReply = messages.some(
    (message) => message.role === "assistant" && (message.status ?? "ok") === "ok",
  );
  const citations = messages.flatMap((message) => messageWithActiveResponseVersion(message).citations ?? []);
  const hasCitations = citations.length > 0;
  const assistantBrandName = brandName?.trim() || "Aperture Chat";
  const assistantLogoUrl = brandLogoUrl?.trim() || "";
  const agentProfiles = agentProfileOptions(data);
  const selectedAgent = selectedAgentId ? agentProfiles.find((agent) => agent.id === selectedAgentId) : undefined;
  const selectedModel = chat.enabledModels.find((model) => model.id === chat.model);
  const contextWindowStatus = buildContextWindowStatus(messages, selectedModel);
  const activeRouteModel = composerTools.Agent && selectedAgent ? selectedAgent : selectedModel;
  const webSearchAvailable = supportsWebSearch(data, activeRouteModel);
  const enabledKnowledgeBases = data.knowledgeBases.filter((knowledge) => knowledge.enabled);
  // MCP servers this workspace can actually run. The workspace connector is a
  // real kill switch, so an admin turning MCP off empties this and disables
  // the composer switch rather than offering a control that cannot work.
  const availableMcpServers = connectorEnabled(data.connectors, "mcp")
    ? data.tools.filter((tool) => tool.enabled && isMcpRuntimeTool(tool))
    : [];
  const selectedKnowledgeBase = selectedKnowledgeBaseId
    ? enabledKnowledgeBases.find((knowledge) => knowledge.id === selectedKnowledgeBaseId)
    : undefined;
  const selectedToolKey = selectedToolIds.join("|");

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
    if (!hasMessages) return;
    const target = conversationScrollerFrom(bottomRef.current);
    if (target) target.scrollTo({ top: target.scrollHeight, behavior: "smooth" });
    else bottomRef.current?.scrollIntoView?.({ block: "end", behavior: "smooth" });
  }, [messages.length, hasMessages, isSending]);

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
  }, [followStreaming]);

  useEffect(() => {
    if (hasCitations) return;
    setCitationDetailsOpen(false);
    setFocusedCitationMessageId(null);
  }, [hasCitations]);

  useEffect(() => {
    if (!focusedCitationMessageId) return;
    const hasFocusedMessage = messages.some(
      (message) => message.id === focusedCitationMessageId && (message.citations?.length ?? 0) > 0,
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
      if (sendMenuOpen && sendRef.current && !sendRef.current.contains(target)) {
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

  // Lazily load knowledge-base files the first time a "#" command opens, so
  // the Files section lists real indexed documents.
  useEffect(() => {
    if (commandToken?.symbol !== "#" || knowledgeDocsStatus !== "idle") return;
    let cancelled = false;
    setKnowledgeDocsStatus("loading");
    void Promise.all(
      enabledKnowledgeBases.map(async (base) => {
        const docs = await listKnowledgeDocuments(data.me.id, base.id).catch(() => [] as KnowledgeDocument[]);
        return [base.id, docs] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      setKnowledgeDocs(Object.fromEntries(entries));
      setKnowledgeDocsStatus("loaded");
    });
    return () => {
      cancelled = true;
    };
  }, [commandToken?.symbol, knowledgeDocsStatus, enabledKnowledgeBases, data.me.id]);

  const commandItems = useMemo<ComposerCommandItem[]>(() => {
    if (!commandToken) return [];
    const query = commandToken.query;
    if (commandToken.symbol === "#") {
      const files = enabledKnowledgeBases.flatMap((base) =>
        (knowledgeDocs[base.id] ?? []).map((doc) => ({ base, doc })),
      );
      return [
        ...rankCommandMatches(enabledKnowledgeBases, (base) => base.name, query).map((base) => ({
          kind: "knowledge-base" as const,
          id: `kb-${base.id}`,
          section: "Knowledge bases",
          name: base.name,
          detail: `${base.document_count} files · ${base.source}`,
          base,
        })),
        ...rankCommandMatches(files, (entry) => entry.doc.name, query).map((entry) => ({
          kind: "knowledge-file" as const,
          id: `file-${entry.doc.id}`,
          section: "Files",
          name: entry.doc.name,
          detail: entry.base.name,
          doc: entry.doc,
          base: entry.base,
        })),
      ];
    }
    if (commandToken.symbol === "/") {
      // Workspace kill switches: disabled connectors remove these sections
      // from the palette entirely — off is off, for View-as previews too.
      const prompts = connectorEnabled(data.connectors, "prompt-library")
        ? data.promptTemplates.filter((prompt) => prompt.enabled)
        : [];
      const mcpTools = connectorEnabled(data.connectors, "mcp")
        ? data.tools.filter((tool) => tool.type === "mcp" && tool.enabled)
        : [];
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
  }, [
    commandToken,
    enabledKnowledgeBases,
    knowledgeDocs,
    data.promptTemplates,
    data.tools,
    data.skillFiles,
    data.automations,
    agentProfiles,
  ]);

  const commandSections = useMemo(() => {
    const sections: { title: string; items: ComposerCommandItem[] }[] = [];
    for (const item of commandItems) {
      const section = sections.find((entry) => entry.title === item.section);
      if (section) section.items.push(item);
      else sections.push({ title: item.section, items: [item] });
    }
    return sections;
  }, [commandItems]);

  // With a bare symbol (no query yet) the menu stays open even when the
  // library is empty, so the empty-state hint teaches what the symbol does.
  const commandMenuVisible =
    commandToken !== null &&
    (commandItems.length > 0 ||
      commandToken.query.trim() === "" ||
      (commandToken.symbol === "#" && knowledgeDocsStatus === "loading"));

  // Keep the highlight on a real row as filtering narrows the list.
  useEffect(() => {
    setCommandIndex((current) => Math.min(current, Math.max(commandItems.length - 1, 0)));
  }, [commandItems.length]);

  function updateCommandTokenFromTextarea(target: HTMLTextAreaElement) {
    const token = detectComposerCommandToken(target.value, target.selectionStart);
    setCommandToken((current) => {
      if (current?.symbol !== token?.symbol || current?.start !== token?.start || current?.query !== token?.query) {
        if (current?.symbol !== token?.symbol || current?.start !== token?.start) {
          setCommandIndex(0);
        }
        return token;
      }
      return current;
    });
  }

  function applyCommandItem(item: ComposerCommandItem) {
    if (!commandToken) return;
    let replacement = "";
    if (item.kind === "knowledge-base") {
      setComposerTools((current) => ({ ...current, Knowledge: true }));
      setSelectedKnowledgeBaseId(item.base.id);
      replacement = `#${item.name} `;
    } else if (item.kind === "knowledge-file") {
      setComposerTools((current) => ({ ...current, Knowledge: true }));
      setSelectedKnowledgeBaseId(item.base.id);
      replacement = `#${item.name} `;
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
    const nextDraft = draft.slice(0, commandToken.start) + replacement + draft.slice(caret);
    const nextCaret = commandToken.start + replacement.length;
    setDraft(nextDraft);
    setCommandToken(null);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
  }

  /** Handles menu navigation while a symbol command is open. Returns true when
   * the key was consumed so send-on-Enter doesn't also fire. */
  function handleCommandMenuKey(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!commandMenuVisible) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCommandIndex((current) => Math.min(current + 1, commandItems.length - 1));
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setCommandIndex((current) => Math.max(current - 1, 0));
      return true;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const item = commandItems[commandIndex];
      if (item) applyCommandItem(item);
      return true;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      if (commandItems.length === 1) applyCommandItem(commandItems[0]);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setCommandToken(null);
      return true;
    }
    return false;
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
    if (
      (!text && attachments.length === 0 && queuedAutomations.length === 0) ||
      isSending ||
      isImproving ||
      isComposerExpanded ||
      isUploadingAttachments
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
      setCommandToken(null);
      for (const automation of queuedAutomations) {
        await chat.runAutomationNow(automation, text || undefined);
      }
      setDraft("");
      setOriginalDraft(null);
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
        const localAttachments = attachments.filter((pending) => pending.file);
        const existingAttachments = attachments.filter((pending) => !pending.file);
        setIsUploadingAttachments(true);
        setAttachments((prev) =>
          prev.map((file) => ({
            ...file,
            uploadStatus: file.file ? "uploading" : "ready",
            uploadError: undefined,
          })),
        );
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
        uploadedAttachments = [...existingAttachments.map(toChatAttachment), ...newUploads];
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
      setDraft("");
      setOriginalDraft(null);
      setAttachments([]);
      setSelectedToolIds([]);
      setCommandToken(null);
      setFetchUrls([]);
      setLinkComposerOpen(false);
      setLinkDraft("");
      setLinkError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not upload the attachment.";
      setUploadError(message);
      setAttachments((prev) =>
        prev.map((file) => ({
          ...file,
          uploadStatus: "error",
          uploadError: message,
        })),
      );
    } finally {
      setIsUploadingAttachments(false);
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
      const mcpNames = composerTools.Mcp ? availableMcpServers.map((tool) => tool.name) : [];
      const pickedToolNames = selectedToolIds
        .map((id) => data.tools.find((tool) => tool.id === id && tool.enabled)?.name)
        .filter((name): name is string => Boolean(name));
      const toolNames = [...new Set([...pickedToolNames, ...mcpNames])];
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
    setAttachments((prev) => prev.filter((item) => item.localId !== id));
    setUploadError(null);
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
    setCommandToken(null);
    setPendingToolApproval(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
    return true;
  };
  const activeToolSummaries = composerToolSummaries(composerTools, {
    selectedKnowledgeBaseName: selectedKnowledgeBase?.name,
    selectedAgentName: selectedAgent?.name,
    mcpServerNames: availableMcpServers.map((tool) => tool.name),
  });
  const activeToolCount = Object.values(composerTools).filter(Boolean).length;
  const singleActiveTool = activeToolSummaries.length === 1 ? activeToolSummaries[0] : null;
  const SingleActiveToolIcon = singleActiveTool?.icon;
  const activeToolsTitle = singleActiveTool?.title ?? `${activeToolCount} tools on`;
  // Everything acting as a tool for the next message: composer toggles plus
  // any automations and MCP connections chipped into the composer.
  const sessionToolNames = [
    ...activeToolSummaries.map((summary) => summary.label),
    ...pendingAutomations.map((automation) => automation.name),
    ...selectedToolIds
      .map((id) => data.tools.find((tool) => tool.id === id)?.name)
      .filter((name): name is string => Boolean(name)),
  ];
  const canSend =
    chat.enabledModels.length > 0 &&
    (draft.trim().length > 0 || attachments.length > 0 || pendingAutomations.length > 0) &&
    !isSending &&
    !isImproving &&
    !isComposerExpanded &&
    !isUploadingAttachments;
  const canOpenSendOptions =
    chat.enabledModels.length > 0 && !isSending && !isUploadingAttachments && !isComposerExpanded;
  const hasDraftText = draft.trim().length > 0;

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
    setComposerTools({ Knowledge: false, Web: false, Agent: false, Mcp: false });
    setKnowledgePickerOpen(false);
  }

  const composerForm = (
    <form
      className={`composer ${hasMessages ? "" : "composer-empty"}${isImproving ? " is-improving" : ""}${isComposerExpanded ? " is-expanded" : ""}`}
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
            <span className={`attach-chip ${file.uploadStatus ? `is-${file.uploadStatus}` : ""}`} key={file.localId}>
              <span className={`file-icon ${fileIconClass(file.kind)}`}>{file.kind[0]?.toUpperCase() ?? "F"}</span>
              <span className="attach-chip-text">
                <strong>{file.name}</strong>
                <small>
                  {file.size} · {file.kind}
                  {file.uploadStatus === "uploading"
                    ? isMediaUploadFile(file.file ?? { name: file.name, type: file.mime_type ?? "" })
                      ? " · Uploading and transcribing"
                      : " · Uploading"
                    : ""}
                  {file.uploadStatus === "error" ? " · Upload failed" : ""}
                </small>
              </span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                data-tooltip={`Remove ${file.name} from this message before sending`}
                onClick={() => removeAttachment(file.localId)}
              >
                <X size={14} />
              </button>
            </span>
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
        <div
          className="composer-command-menu"
          role="listbox"
          aria-label={`${COMMAND_MENU_TITLES[commandToken.symbol]} commands`}
        >
          {commandSections.map((section) => (
            <Fragment key={section.title}>
              <span className="composer-command-section">{section.title}</span>
              {section.items.map((item) => {
                const index = commandItems.indexOf(item);
                const Icon =
                  item.kind === "knowledge-base"
                    ? BookOpen
                    : item.kind === "knowledge-file"
                      ? FileText
                      : item.kind === "prompt"
                        ? ScrollText
                        : item.kind === "mcp-tool"
                          ? Plug
                          : item.kind === "skill"
                            ? Sparkles
                            : item.kind === "automation"
                              ? Play
                              : Bot;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={index === commandIndex}
                    className={`composer-command-item ${index === commandIndex ? "is-active" : ""}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setCommandIndex(index)}
                    onClick={() => applyCommandItem(item)}
                  >
                    <Icon size={15} />
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.detail}</small>
                    </span>
                  </button>
                );
              })}
            </Fragment>
          ))}
          {commandToken.symbol === "#" && knowledgeDocsStatus === "loading" && (
            <span className="composer-command-loading">Loading files…</span>
          )}
          {commandItems.length === 0 && knowledgeDocsStatus !== "loading" && (
            <span className="composer-command-loading">
              {commandToken.symbol === "#"
                ? "No knowledge bases are enabled yet — add one under Knowledge"
                : commandToken.symbol === "/"
                  ? !connectorEnabled(data.connectors, "prompt-library") && !connectorEnabled(data.connectors, "mcp")
                    ? "The Prompt Library and MCP servers are turned off for this workspace"
                    : !connectorEnabled(data.connectors, "prompt-library")
                      ? "The Prompt Library is turned off for this workspace — no MCP connections are enabled yet"
                      : !connectorEnabled(data.connectors, "mcp")
                        ? "MCP servers are turned off for this workspace — no saved prompts yet"
                        : "No saved prompts or enabled MCP connections yet — add them under Tools"
                  : commandToken.symbol === "$"
                    ? "No skill files saved yet — create one under Tools"
                    : commandToken.symbol === ">"
                      ? "No automations yet — create one under Automations"
                      : "No agent profiles available yet — create one under Agents"}
            </span>
          )}
          <span className="composer-command-hint" aria-hidden="true">
            ↑↓ navigate · Enter insert
            {commandItems.length === 1 ? " · Tab complete" : ""} · Esc dismiss
          </span>
        </div>
      )}
      <textarea
        ref={textareaRef}
        aria-label="Message"
        data-tooltip={
          "Symbol shortcuts — start a word with:\n" +
          "/ prompts and MCP tools\n" +
          "@ agent profiles\n" +
          "# knowledge bases and files\n" +
          "$ skill files\n" +
          "> automations"
        }
        placeholder={chat.enabledModels.length ? "Ask anything..." : "Connect a model provider to start chatting..."}
        readOnly={isImproving}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          updateCommandTokenFromTextarea(event.target);
        }}
        onSelect={(event) => updateCommandTokenFromTextarea(event.currentTarget)}
        onBlur={() => setCommandToken(null)}
        onKeyDown={(event) => {
          if (handleCommandMenuKey(event)) return;
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
                <div className="attach-menu-divider" />
                <span className="attach-menu-label">Attach from source</span>
                {CONNECTORS.map((source) => {
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
                data-tooltip="Turn off Knowledge, Web, and Agent for your next message"
                onClick={clearComposerTools}
              >
                <X size={13} />
              </button>
            </div>
          )}
          {pendingAutomations.map((automation) => (
            <span
              key={automation.id}
              className="composer-mcp-chip is-automation"
              data-tooltip={`“${automation.name}” runs immediately when you press send`}
            >
              <Play size={13} />
              {automation.name}
              <button
                type="button"
                aria-label={`Remove ${automation.name}`}
                data-tooltip={`Remove ${automation.name} so it stays on its normal schedule`}
                onClick={() =>
                  setPendingAutomations((current) => current.filter((entry) => entry.id !== automation.id))
                }
              >
                <X size={12} />
              </button>
            </span>
          ))}
          {selectedToolIds
            .map((id) => data.tools.find((tool) => tool.id === id))
            .filter((tool): tool is ToolConfig => Boolean(tool))
            .map((tool) => (
              <span
                key={tool.id}
                className="composer-mcp-chip"
                data-tooltip={
                  tool.approval_required
                    ? `${tool.name} requires approval before it can run for this message`
                    : `${tool.name} will be available to the model for this message`
                }
              >
                <Plug size={13} />
                {tool.name}
                <button
                  type="button"
                  aria-label={`Remove ${tool.name}`}
                  data-tooltip={`Remove ${tool.name} from this message`}
                  onClick={() => setSelectedToolIds((current) => current.filter((id) => id !== tool.id))}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
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
            {hasDraftText && !isComposerExpanded && (
              <button
                type="button"
                className="composer-expand-button"
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
          <button
            className="send-button"
            type="submit"
            aria-label="Send message"
            data-tooltip={
              isComposerExpanded
                ? "Collapse the prompt editor before sending"
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
            data-tooltip="Open sending options like Knowledge, Web search, Agent mode, and reasoning level"
            aria-haspopup="menu"
            aria-expanded={sendMenuOpen}
            disabled={!canOpenSendOptions}
            onClick={() => setSendMenuOpen((open) => !open)}
          >
            <ChevronDown size={16} />
          </button>
          {sendMenuOpen && (
            <div className="send-options-menu" role="menu" aria-label="Send options" ref={revealComposerMenu}>
              <button
                type="button"
                role="menuitem"
                className="send-option"
                data-tooltip="Send your message now with the current composer settings"
                disabled={!canSend}
                onClick={() => void submitDraft()}
              >
                <Send size={16} />
                <span>
                  <strong>Send now</strong>
                  <small>Use the current composer settings.</small>
                </span>
              </button>
              <div className="attach-menu-divider" />
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={composerTools.Knowledge}
                aria-haspopup="true"
                aria-expanded={composerTools.Knowledge && knowledgePickerOpen}
                className="send-option"
                data-tooltip={
                  composerTools.Knowledge
                    ? "Stop using workspace knowledge sources for this reply"
                    : "Ground this reply in your connected workspace knowledge"
                }
                disabled={enabledKnowledgeBases.length === 0}
                onClick={toggleKnowledgeTool}
              >
                {composerTools.Knowledge ? <Check size={16} /> : <BookOpen size={16} />}
                <span>
                  <strong>Knowledge</strong>
                  <small>
                    {composerTools.Knowledge && selectedKnowledgeBase
                      ? `${selectedKnowledgeBase.name} selected.`
                      : "Use connected workspace sources."}
                  </small>
                </span>
              </button>
              {composerTools.Knowledge && knowledgePickerOpen && (
                <KnowledgeSourcePicker
                  knowledgeBases={enabledKnowledgeBases}
                  selectedKnowledgeBaseId={selectedKnowledgeBase?.id ?? selectedKnowledgeBaseId}
                  onSelect={setSelectedKnowledgeBaseId}
                />
              )}
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={composerTools.Web}
                className="send-option"
                disabled={!webSearchAvailable}
                data-tooltip={
                  webSearchAvailable
                    ? composerTools.Web
                      ? "Turn off public web search for this reply"
                      : "Let the model search the public web for current information"
                    : "Web search is turned off for this model by your workspace configuration"
                }
                onClick={() => toggleComposerTool("Web")}
              >
                {composerTools.Web ? <Check size={16} /> : <Globe2 size={16} />}
                <span>
                  <strong>Web</strong>
                  <small>
                    {composerTools.Web ? "Use public web search for this reply." : "Search current public web sources."}
                  </small>
                </span>
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={composerTools.Agent}
                className="send-option"
                data-tooltip={
                  composerTools.Agent
                    ? "Turn off agent mode and reply with the base model"
                    : "Let an agent profile use its tools to answer this reply"
                }
                onClick={() => toggleComposerTool("Agent")}
              >
                {composerTools.Agent ? <Check size={16} /> : <Bot size={16} />}
                <span>
                  <strong>Agent</strong>
                  <small>{selectedAgent ? selectedAgent.name : "Use enabled tools for this reply."}</small>
                </span>
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={composerTools.Mcp}
                className="send-option"
                disabled={availableMcpServers.length === 0}
                data-tooltip={
                  availableMcpServers.length === 0
                    ? "No MCP servers are available for this workspace"
                    : composerTools.Mcp
                      ? "Stop using MCP servers for this reply"
                      : "Use the workspace's MCP servers for this reply"
                }
                onClick={() => toggleComposerTool("Mcp")}
              >
                {composerTools.Mcp ? <Check size={16} /> : <Plug size={16} />}
                <span>
                  <strong>MCP</strong>
                  <small>
                    {availableMcpServers.length === 0
                      ? "No MCP servers available."
                      : `${availableMcpServers.length} server${availableMcpServers.length === 1 ? "" : "s"}: ${availableMcpServers
                          .map((tool) => tool.name)
                          .join(", ")}`}
                  </small>
                </span>
              </button>
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
                    </SelectControl>
                  </label>
                  {selectedAgent ? (
                    <small>
                      {modelKnowledgeIds(selectedAgent).length} knowledge ·{" "}
                      {agentKnowledgeDocumentCount(data, selectedAgent)} files · {modelToolIds(selectedAgent).length}{" "}
                      tools
                      {selectedAgent.agentic_companion === "hermes" ? " · Hermes" : ""}
                    </small>
                  ) : (
                    <small>Create an agent profile in Agents to enable this mode.</small>
                  )}
                </div>
              )}
              <div className="attach-menu-divider" />
              <div className="send-menu-reasoning" role="group" aria-label="Reasoning level">
                <span className="send-menu-reasoning-label">Reasoning</span>
                <ReasoningSlider
                  level={reasoningLevel}
                  supported={reasoningSupported}
                  modelName={reasoningTargetModel?.name ?? "This model"}
                  onChange={updateReasoningLevel}
                />
              </div>
              <label
                className="send-menu-stream"
                data-tooltip={
                  streamResponses
                    ? "Show each reply only after it finishes"
                    : "Write replies onto the page live as the model streams them"
                }
              >
                <input
                  type="checkbox"
                  checked={streamResponses}
                  onChange={toggleStreamResponses}
                />
                <span>Stream replies</span>
              </label>
            </div>
          )}
        </div>
      </div>
    </form>
  );

  const disclaimer = <p className="disclaimer">Responses may contain mistakes. Verify important information.</p>;

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
            <ModelSelect chat={chat} />
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

        <div className={`conversation ${hasMessages ? "" : "is-empty"}`}>
          {!hasMessages && (
            <>
              <div className="empty-chat">
                <div className="empty-mark">
                  {assistantLogoUrl ? (
                    <img className="empty-brand-logo" src={assistantLogoUrl} alt="" />
                  ) : (
                    <ApertureMark size={72} />
                  )}
                </div>
                <h2>{timeOfDayGreeting(new Date().getHours(), data.me.display_name)}</h2>
                <p className="empty-tagline">
                  Your approved models, your sources, your guardrails — ask {assistantBrandName}{" "}
                  anything.
                </p>
              </div>
            </>
          )}

          {hasMessages && (
            <div className="message-list">
              {messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  userId={data.me.id}
                  userName={data.me.display_name}
                  userAvatarUrl={data.me.avatar_url}
                  brandName={assistantBrandName}
                  brandLogoUrl={assistantLogoUrl}
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
                  onSubmitFeedback={submitResponseFeedback}
                  customTools={customScriptTools}
                  onRunCustomTool={(tool, targetMessage) => void runCustomToolOnMessage(tool, targetMessage)}
                  streamPreviewEnabled={streamResponses}
                />
              ))}
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
          {hasMessages ? (
            <div className="composer-dock">
              {composerForm}
              {disclaimer}
            </div>
          ) : (
            <>
              {composerForm}
              {disclaimer}
            </>
          )}
        </div>
      </section>

      {isInspectorOpen && inspectorOverlay && (
        <button
          type="button"
          className="inspector-backdrop"
          aria-label="Close session details"
          data-tooltip="Close the session details panel and return to the chat"
          onClick={closeInspector}
        />
      )}

      {isInspectorOpen && (
        <aside className="session-panel is-open">
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
          />
        </aside>
      )}

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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal cloud-picker-modal"
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
              <div className="cloud-picker-list" role="listbox" aria-label={`${picker.source.label} files`}>
                {picker.items.map((item) => {
                  const selected = picker.selectedIds.includes(item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
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

function AttachmentChip({ attachment, userId }: { attachment: ChatAttachment; userId: string }) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
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

  return (
    <>
      <div
        ref={anchorRef}
        className={`file-chip ${previewUrl ? "has-image-preview" : ""}`}
        tabIndex={previewUrl ? 0 : undefined}
        aria-describedby={previewIntent && previewUrl ? previewId : undefined}
        onPointerEnter={() => setPreviewIntent(true)}
        onPointerLeave={() => setPreviewIntent(false)}
        onFocus={() => setPreviewIntent(true)}
        onBlur={() => setPreviewIntent(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setPreviewIntent(false);
        }}
      >
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
          <small>
            {attachment.size} · {attachment.kind}
          </small>
        </span>
        <FileText size={16} />
      </div>
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
  brandLogoUrl,
  onTransferToDraft,
  onBranchFromMessage,
  onRegenerateResponse,
  onStopResponse,
  onSelectResponseVersion,
  onUpdateDiagram,
  onStagePromptInNewSession,
  isEditingPrompt,
  promptEditDisabled,
  onStartEditPrompt,
  onCancelEditPrompt,
  onSubmitEditPrompt,
  citationDetailsExpanded,
  onToggleCitations,
  onSubmitFeedback,
  customTools,
  onRunCustomTool,
  streamPreviewEnabled,
}: {
  message: ChatMessage;
  userId: string;
  userName: string;
  userAvatarUrl?: string | null;
  brandName: string;
  brandLogoUrl: string;
  onTransferToDraft?: (message: ChatMessage) => void;
  onBranchFromMessage?: (message: ChatMessage) => ChatThread | null;
  onRegenerateResponse?: (message: ChatMessage) => boolean;
  onStopResponse?: () => void;
  onSelectResponseVersion?: (message: ChatMessage, versionIndex: number) => boolean;
  onUpdateDiagram?: (message: ChatMessage, previousSource: string, nextSource: string) => boolean;
  onStagePromptInNewSession?: (message: ChatMessage) => boolean;
  isEditingPrompt?: boolean;
  promptEditDisabled?: boolean;
  onStartEditPrompt?: (message: ChatMessage) => void;
  onCancelEditPrompt?: () => void;
  onSubmitEditPrompt?: (message: ChatMessage, text: string) => boolean;
  citationDetailsExpanded?: boolean;
  onToggleCitations?: (message: ChatMessage) => void;
  onSubmitFeedback?: (message: ChatMessage, rating: ChatFeedbackRating, comment?: string) => void;
  customTools?: ToolConfig[];
  onRunCustomTool?: (tool: ToolConfig, message: ChatMessage) => void;
  streamPreviewEnabled?: boolean;
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
  const citationLabel = `${citationCount} citation${citationCount === 1 ? "" : "s"}`;

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
          {brandLogoUrl ? <img className="message-brand-logo" src={brandLogoUrl} alt="" /> : <ApertureMark size={36} />}
        </div>
      )}
      <div className="message-body">
        <div className="message-meta">
          <strong>{isUser ? "You" : brandName}</strong>
          <time dateTime={timestamp.dateTime} data-tooltip={timestamp.title}>
            {timestamp.label}
          </time>
        </div>

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
            {/* The trace keeps working through its steps for the whole run;
                once real tokens arrive they stream in below it, so thinking
                and writing read as consecutive phases of one reply. */}
            <ActivityTrace message={displayMessage} brandName={brandName} state="pending" onStop={onStopResponse} />
            {streamPreviewEnabled && streamedPendingContent && (
              <>
                <div className="message-rendered-response message-stream-live" ref={responseContentRef}>
                  <Markdown content={streamedPendingContent} />
                </div>
                <div className="message-stream-status" role="status" aria-live="polite">
                  <span className="message-stream-dot" aria-hidden="true" />
                  <span>Streaming reply…</span>
                </div>
              </>
            )}
          </>
        ) : displayMessage.status === "error" ? (
          failureNotice && assistantContent.visibleContent ? (
            <>
              <div className="message-rendered-response" ref={responseContentRef}>
                <Markdown content={assistantContent.visibleContent} />
              </div>
              <p className="message-error">{failureNotice}</p>
            </>
          ) : (
            <p className="message-error">{displayMessage.content}</p>
          )
        ) : displayMessage.content ? (
          <>
            {!isUser &&
              ((displayMessage.activityTrace?.length ?? 0) > 0 || assistantContent.thinkingTraces.length > 0) && (
              <ActivityTrace
                message={displayMessage}
                brandName={brandName}
                state="complete"
                thinkingTraces={assistantContent.thinkingTraces}
              />
            )}
            {isUser ? (
              <PlainText content={displayMessage.content} />
            ) : assistantContent.visibleContent ? (
              <div className="message-rendered-response" ref={responseContentRef}>
                <Markdown
                  content={assistantContent.visibleContent}
                  onUpdateDiagram={
                    onUpdateDiagram
                      ? (previousSource, nextSource) => onUpdateDiagram(message, previousSource, nextSource)
                      : undefined
                  }
                />
              </div>
            ) : null}
          </>
        ) : null}

        {!isUser && displayMessage.status === "ok" && <MemoryNotes message={displayMessage} />}

        {displayMessage.attachments?.map((attachment) => (
          <AttachmentChip
            attachment={attachment}
            userId={userId}
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
                      ? "Hide the cited-source list in the session details panel"
                      : "Open session details and show every source cited by this response"
                  }
                  onClick={() => onToggleCitations?.(displayMessage)}
                >
                  {citationDetailsExpanded ? "Hide citations" : `View ${citationLabel}`} →
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
              <button
                className="transfer-draft-button"
                type="button"
                aria-label="Transfer response to Drafts"
                data-tooltip="Turn this response into an editable document in Drafts"
                onClick={() => onTransferToDraft(visibleMessage)}
              >
                <FileText size={14} />
                <span>Transfer to Drafts</span>
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function ActivityTrace({
  message,
  brandName,
  state,
  onStop,
  thinkingTraces = [],
}: {
  message: ChatMessage;
  brandName: string;
  state: "pending" | "complete";
  onStop?: () => void;
  thinkingTraces?: string[];
}) {
  const [now, setNow] = useState(Date.now());
  const [expanded, setExpanded] = useState(false);
  const startedAt = message.startedAtMs ?? now;
  const elapsedMs = Math.max(0, now - startedAt);
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const isPending = state === "pending";
  const steps =
    message.activityTrace && message.activityTrace.length > 0
      ? message.activityTrace
      : [
          {
            id: "generate",
            label: "Generating answer",
            detail: "Waiting for the model response.",
          },
        ];
  const activeIndex = isPending ? Math.min(steps.length - 1, Math.floor(elapsedMs / 8000)) : steps.length;
  const currentIndex = Math.min(activeIndex, steps.length - 1);
  const visibleSteps = expanded ? steps : isPending ? [steps[currentIndex]] : [];
  const runtime = message.metadata?.chatRuntime as ChatRuntimeOptions | undefined;
  const isAgentWorkflow =
    Boolean(runtime?.agentEnabled) ||
    steps.some((step) => step.id === "tools" && /agent/i.test(`${step.label} ${step.detail ?? ""}`));
  const traceLabel = isPending ? `${brandName} is working` : isAgentWorkflow ? "Agent work trace" : "Work trace";
  const hasThinkingTraces = thinkingTraces.length > 0;

  useEffect(() => {
    if (!isPending) return undefined;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [isPending]);

  return (
    <div
      className={`pending-trace ${isPending ? "" : "is-complete"} ${expanded ? "is-expanded" : "is-collapsed"}`}
      role={isPending ? "status" : "region"}
      aria-live={isPending ? "polite" : undefined}
      aria-label={`${brandName} activity trace`}
    >
      <div className="pending-trace-header">
        <button
          className="pending-trace-toggle"
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse work trace" : "Expand work trace"}
          data-tooltip={
            expanded
              ? "Collapse the trace to show only the current step"
              : "Expand the trace to see every step in this run"
          }
          onClick={() => setExpanded((value) => !value)}
        >
          <Sparkles size={15} />
          <span>{traceLabel}</span>
          <small>
            {isPending
              ? `${elapsedSeconds}s · step ${currentIndex + 1} of ${steps.length}`
              : `complete · ${steps.length} ${steps.length === 1 ? "step" : "steps"}${
                  hasThinkingTraces ? " · thinking" : ""
                }`}
          </small>
        </button>
        {isPending && onStop && (
          <button
            className="pending-trace-stop"
            type="button"
            aria-label="Stop this response"
            data-tooltip="Stop this response; the conversation is kept"
            onClick={onStop}
          >
            · stop
          </button>
        )}
        <button
          className="pending-trace-caret-button"
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronDown size={14} className="pending-trace-caret" />
        </button>
      </div>
      {isPending && (
        <p className="pending-trace-note">
          Complex requests can take longer. {brandName} keeps working while long-form answers are assembled and checked.
        </p>
      )}
      {visibleSteps.length > 0 && (
        <ol>
          {visibleSteps.map((step) => {
            const index = steps.indexOf(step);
            const stepState = index < activeIndex ? "done" : index === activeIndex ? "active" : "queued";
            return (
              <li className={`pending-trace-step is-${stepState}`} key={step.id}>
                <span className="pending-trace-icon" aria-hidden="true">
                  {stepState === "done" ? <Check size={12} /> : <Clock3 size={12} />}
                </span>
                <span>
                  <strong>{step.label}</strong>
                  {step.detail && <small>{step.detail}</small>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {expanded && hasThinkingTraces && (
        <details className="thinking-trace">
          <summary>
            <span className="thinking-trace-title">
              <Bot size={14} aria-hidden="true" />
              <strong>Thinking traces</strong>
            </span>
            <small>Exposed by the model</small>
            <ChevronDown size={14} className="thinking-trace-caret" aria-hidden="true" />
          </summary>
          <div className="thinking-trace-body">
            {thinkingTraces.map((trace, index) => (
              <div className="thinking-trace-content" key={`${index}-${trace.slice(0, 32)}`}>
                <Markdown content={trace} />
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function agentProfileOptions(data: BootstrapData): ModelConfig[] {
  return visibleAgentProfiles(data);
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
    mcpServerNames?: string[];
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
  if (composerTools.Mcp) {
    summaries.push({
      key: "Mcp",
      label: "MCP",
      title: options.mcpServerNames?.length
        ? `MCP servers: ${options.mcpServerNames.join(", ")}`
        : "MCP servers enabled",
      icon: Plug,
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
              {line}
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

  const allSources: ChatCitation[] = [];
  const seenSources = new Set<string>();
  for (const message of messages) {
    for (const citation of message.citations ?? []) {
      const key = citationKey(citation);
      if (seenSources.has(key)) continue;
      seenSources.add(key);
      allSources.push(citation);
    }
  }
  const focusedMessage = focusedCitationMessageId
    ? messages.find((message) => message.id === focusedCitationMessageId)
    : undefined;
  const focusedSources = uniqueCitations(focusedMessage?.citations ?? []);
  const focusedSourceKeys = new Set(focusedSources.map(citationKey));
  const remainingSources = focusedSources.length
    ? allSources.filter((citation) => !focusedSourceKeys.has(citationKey(citation)))
    : allSources;
  const webSources = remainingSources.filter((citation) => citation.source_type === "web");
  const workspaceSources = remainingSources.filter((citation) => citation.source_type !== "web");

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
      <div className="audit-heading">
        <h3>Session summary</h3>
      </div>
      {rows.map(([label, detail, time]) => (
        <div className="audit-row" key={label}>
          <span>
            <strong>{label}</strong>
            <small>{detail}</small>
          </span>
          <time>{time}</time>
        </div>
      ))}
      <ContextWindowDetails status={contextWindowStatus} />
      {showSources && (focusedSources.length > 0 || webSources.length > 0 || workspaceSources.length > 0) && (
        <div className="session-sources">
          <div className="audit-heading">
            <h3>Sources gathered</h3>
          </div>
          {focusedSources.length > 0 && (
            <SessionSourceGroup
              key={`selected-${focusedCitationMessageId}`}
              icon={<Quote size={12} />}
              label={`Selected response · ${focusedSources.length}`}
              sources={focusedSources}
              moreScope="response"
            />
          )}
          {focusedSources.length > 0 && (webSources.length > 0 || workspaceSources.length > 0) && (
            <span className="session-source-divider">Other citations in this chat</span>
          )}
          {webSources.length > 0 && (
            <SessionSourceGroup
              icon={<Globe2 size={12} />}
              label={`Web · ${webSources.length}`}
              sources={webSources}
              moreScope="chat"
            />
          )}
          {workspaceSources.length > 0 && (
            <SessionSourceGroup
              icon={<FileText size={12} />}
              label={`Workspace · ${workspaceSources.length}`}
              sources={workspaceSources}
              moreScope="chat"
            />
          )}
        </div>
      )}
    </section>
  );
}

const SESSION_SOURCE_DISPLAY_LIMIT = 6;

function citationKey(citation: ChatCitation): string {
  const base = `${citation.source_type}|${citation.source_uri || citation.source_name}`;
  // Distinct chunks from the same source stay distinct entries; legacy
  // citations without a chunk id keep the historical source-level key.
  return citation.chunk_id ? `${base}|chunk:${citation.chunk_id}` : base;
}

/** Page pill text built only from reported fields — never fabricated. */
function citationPageLabel(citation: ChatCitation): string | null {
  const start = citation.page_start ?? citation.page_end;
  if (start === null || start === undefined) return null;
  const end = citation.page_end ?? start;
  return end !== start ? `p. ${start}–${end}` : `p. ${start}`;
}

const CITATION_PILL_STYLE: CSSProperties = {
  minHeight: 20,
  padding: "0 7px",
  fontSize: 10.5,
};

function uniqueCitations(citations: ChatCitation[]): ChatCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = citationKey(citation);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function citationHost(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function SessionSourceGroup({
  icon,
  label,
  sources,
  moreScope,
}: {
  icon: ReactNode;
  label: string;
  sources: ChatCitation[];
  moreScope: "chat" | "response";
}) {
  const [expanded, setExpanded] = useState(false);
  const hiddenCount = Math.max(sources.length - SESSION_SOURCE_DISPLAY_LIMIT, 0);
  const visible = expanded ? sources : sources.slice(0, SESSION_SOURCE_DISPLAY_LIMIT);
  return (
    <div className="session-source-group">
      <span className="session-source-label">
        {icon}
        {label}
      </span>
      <ul>
        {visible.map((citation) => {
          const host = citationHost(citation.source_uri);
          const pageLabel = citationPageLabel(citation);
          const hasKIndex = citation.k_index !== null && citation.k_index !== undefined;
          return (
            <li key={citationKey(citation)}>
              {host ? (
                <a
                  href={citation.source_uri}
                  target="_blank"
                  rel="noreferrer"
                  data-tooltip={`Open ${citation.source_name} in a new browser tab`}
                >
                  {citation.source_name}
                </a>
              ) : (
                <strong>{citation.source_name}</strong>
              )}
              <small>{host ?? citation.source_type}</small>
              {(hasKIndex || pageLabel || citation.locator) && (
                <span
                  className="session-source-location"
                  style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2 }}
                >
                  {hasKIndex && (
                    <span
                      className="pill"
                      style={CITATION_PILL_STYLE}
                      data-tooltip={`Cited inline as [K${citation.k_index}]`}
                    >
                      K{citation.k_index}
                    </span>
                  )}
                  {pageLabel && (
                    <span className="pill" style={CITATION_PILL_STYLE}>
                      {pageLabel}
                    </span>
                  )}
                  {citation.locator && (
                    <span className="pill" style={CITATION_PILL_STYLE}>
                      {citation.locator}
                    </span>
                  )}
                </span>
              )}
              {citation.snippet && <span className="session-source-snippet">{citation.snippet}</span>}
            </li>
          );
        })}
      </ul>
      {hiddenCount > 0 && (
        <button
          type="button"
          className="session-source-more"
          data-tooltip={
            expanded
              ? `Hide the extra citations from this ${moreScope}`
              : `Show the remaining citations from this ${moreScope}`
          }
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? `Hide ${hiddenCount} cited source${hiddenCount === 1 ? "" : "s"}`
            : `Show ${hiddenCount} more cited in this ${moreScope}`}
        </button>
      )}
    </div>
  );
}

function ModelSelect({ chat }: { chat: ChatStore }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hasModels = chat.enabledModels.length > 0;

  useEffect(() => {
    if (!open || !hasModels) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [hasModels, open]);

  const selected = chat.enabledModels.find((model) => model.id === chat.model);
  const label = selected?.name ?? chat.enabledModels[0]?.name;

  return (
    <div className="model-select" ref={rootRef}>
      <button
        className={`select-button ${hasModels ? "" : "is-unavailable"}`}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={hasModels ? "Select model" : "No connected models"}
        data-tooltip={
          hasModels
            ? "Choose which AI model answers your messages"
            : "Ask your admin to connect a model provider to start chatting"
        }
        disabled={!hasModels}
        onClick={() => hasModels && setOpen((value) => !value)}
      >
        <Sparkles size={17} />
        <span className="model-select-label">
          {hasModels ? (
            <>
              Model: <strong>{label}</strong>
            </>
          ) : (
            <strong>No models connected</strong>
          )}
        </span>
        {hasModels && <ChevronDown size={16} />}
      </button>
      {open && hasModels && (
        <div className="model-menu" role="listbox" aria-label="Select model">
          {chat.enabledModels.map((model) => (
            <div className="model-option-row" key={model.id}>
              <button
                type="button"
                role="option"
                aria-selected={model.id === chat.model}
                className={`model-option ${model.id === chat.model ? "is-selected" : ""}`}
                data-tooltip={`Switch this chat to ${model.name} for new responses`}
                onClick={() => {
                  chat.setModel(model.id);
                  setOpen(false);
                }}
              >
                <span>
                  <strong>{model.name}</strong>
                  <small>{model.provider_name}</small>
                </span>
                {model.id === chat.model && <Check size={16} />}
              </button>
              <button
                type="button"
                className={`model-default-button ${model.id === chat.defaultModelId ? "is-default" : ""}`}
                aria-label={`Set ${model.name} as default model`}
                aria-pressed={model.id === chat.defaultModelId}
                data-tooltip={
                  model.id === chat.defaultModelId
                    ? `${model.name} is your default model for new chats`
                    : `Make ${model.name} the default model for your new chats`
                }
                onClick={() => {
                  chat.setDefaultModel(model.id);
                  setOpen(false);
                }}
              >
                <Star size={15} fill={model.id === chat.defaultModelId ? "currentColor" : "none"} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
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
