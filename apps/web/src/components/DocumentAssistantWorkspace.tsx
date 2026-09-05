import { DocumentToolbarPanel } from "./DocumentToolbarPanel";
import { DraftHistoryCard } from "./DraftHistoryCard";
import { formatMlaDocument } from "../lib/draftMla";
import { DictationControl } from "./DictationControl";
import { DraftModelMenu } from "./DraftModelMenu";
import type { DraftNavigationGuard } from "../lib/draftNavigation";
import { SelectControl } from "./SelectControl";
import {
  ALargeSmall,
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  BarChart3,
  Bold,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Clipboard,
  Clock3,
  Copy,
  Download,
  FileDiff,
  FileText,
  Globe2,
  Highlighter,
  History,
  Home,
  ImagePlus,
  Image as ImageIcon,
  Italic,
  LayoutTemplate,
  LibraryBig,
  Link,
  List,
  ListOrdered,
  LoaderCircle,
  MessageSquareText,
  Minus,
  MonitorPlay,
  Paperclip,
  PenLine,
  Plus,
  Presentation,
  Printer,
  Quote,
  Redo2,
  RemoveFormatting,
  Save,
  Send,
  Settings2,
  Sparkles,
  Strikethrough,
  Subscript,
  Superscript,
  Table2,
  Trash2,
  Underline,
  Undo2,
  Upload,
  X,
  type LucideIcon,
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
  useMemo,
  useCallback,
  useRef,
  useEffect,
  useLayoutEffect,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import mammoth from "mammoth";
import { ChatRequestError, apiBase, fetchExportImageDataUrl, sendChat } from "../lib/api";
import { splitAssistantThinking } from "../lib/assistantThinking";
import {
  buildDocxExportDocument,
  DOCX_MIME_TYPE,
  isAutomatedTestMode,
  mergeSplitContinuationBlocks,
  type ExportImageProxy,
} from "../lib/docxExport";
import type { BootstrapData, ChatCitation } from "../lib/types";
import { printSavedDraftVersion } from "../lib/draftPrint";
import {
  computeDraftRedline,
  sanitizeDocumentHtml,
  type RedlineBlock,
  type RedlineRow,
} from "../lib/draftRedline";
import {
  archiveDraft,
  deleteDraft,
  createDraft,
  getDraft,
  isDraftConflictError,
  listDrafts,
  updateDraft,
  MAX_DRAFT_CONTENT_BYTES,
  type DraftDocument as ServerDraftDocument,
} from "../lib/api/drafts";
import {
  loadLegacyDraftHistory,
  loadScopedDraftCache,
  limitDraftCacheEntries,
  mergeServerDraftsIntoCache,
  removeLegacyDraftHistoryEntry,
  saveScopedDraftCache,
  scopedDraftCacheKey,
  utf8ByteLength,
  type DraftCacheScope,
  type DraftSyncFields,
} from "../lib/draftServerSync";
import {
  DECK_LAYOUT_LABELS,
  DECK_SCHEMA_VERSION,
  MAX_DECK_BULLETS_PER_SLIDE,
  MAX_DECK_CONTENT_BYTES,
  MAX_DECK_SLIDES,
  MAX_SLIDE_BACKGROUND_CHARS,
  SUPPORTED_DECK_LAYOUTS,
  blankSlideDeck,
  contentLooksLikeDeck,
  createDeckSlide,
  deckBackgroundKey,
  deckRichText,
  deckRichTextParagraphs,
  deckRunsText,
  deckSlideBackgroundSource,
  deckSlideOutline,
  defaultDeckTheme,
  isDeckBulletList,
  nextDeckSlideId,
  parseSlideDeck,
  pruneDeckBackgroundLibrary,
  serializeSlideDeck,
  withDeckBackground,
  type DeckBullet,
  type DeckRichText,
  type DeckSlide,
  DECK_BOX_MIN_H,
  DECK_BOX_MIN_W,
  type DeckSlideBackground,
  type DeckSlideBox,
  type DeckSlideLayout,
  type DeckTextRun,
  type DeckTheme,
  type SlideDeck,
} from "../lib/deck/deckModel";
import {
  DECK_LOGO_BOX,
  DECK_PREVIEW_HEIGHT_PX,
  DECK_PREVIEW_WIDTH_PX,
  resolvedMediaBox,
  resolvedTextRegions,
  slideDecorations,
  slideTextRegions,
  type DeckBox,
  type DeckTextRegionSpec,
} from "../lib/deck/deckGeometry";
import { deckFromDocumentHtml, textRunsFromElement } from "../lib/deck/deckFromDocument";
import { BUILT_IN_DECK_TEMPLATES, builtInDeckTemplate } from "../lib/deck/deckTemplates";
import { parseDeckTemplate, type DeckTemplateParseResponse } from "../lib/api/deckTemplates";
import { markdownOutlineFromDeck } from "../lib/deck/deckToDocument";
import { PPTX_MIME_TYPE, buildPptxExportDocument } from "../lib/pptxExport";
import { markdownToDocumentHtml } from "../lib/markdown";
import { hasUnrenderedDocumentDiagram, hydrateDocumentDiagramFigures } from "../lib/documentDiagrams";
import { approvedWorkspaceModels, isModelUsable, modelsForTextDefault, supportsReasoningEffort, webSearchSupportedForModel } from "../lib/modelAccess";
import {
  ReasoningSlider,
  REASONING_EFFORT_BY_LEVEL,
  loadReasoningLevel,
  storeReasoningLevel,
  type ReasoningLevel,
} from "./ReasoningSlider";
import { fetchServerTime, formatTimeLabel, formatTimestamp } from "../lib/serverClock";
import { useViewportWidth } from "../lib/useViewport";
import { useModalFocus } from "../lib/useModalFocus";

/** Below this width the assistant rail becomes a slide-out drawer so the
 * document gets the full screen instead of being pushed down a vertical stack. */
const DRAFT_RAIL_DRAWER_WIDTH = 1180;

/** How long a fresh AI edit stays highlighted before it settles into the page.
 * The edit itself is still recorded — the AI edit trail brings the highlight
 * back on demand. */
const AI_EDIT_GLOW_MS = 10_000;
/** How long a trail entry flashes after the reader jumps to it. */
const AI_EDIT_FLASH_MS = 2_000;

/** Ruler indent markers, Word-style: first-line, left (both), and right. */
type RulerMarker = "first" | "left" | "right";

/** Cap indents so text keeps a readable column even on narrow pages. */
const RULER_INDENT_MAX = 260;
const RULER_KEYBOARD_STEP = 8;

type DraftVersion = {
  id: string;
  label: string;
  time: string;
  executedAt?: string;
  content: string;
  summary: string;
  /** Deck versions store canonical deck JSON in `content`; absent means a
   * document (HTML) version, keeping older stored versions valid. */
  format?: "document" | "deck";
};

type RevisionAsset = {
  kind: "image" | "link";
  token: string;
  value: string;
};

type RevisionDocumentSnapshot = {
  assets: RevisionAsset[];
  markdown: string;
};

type DraftDocumentHistoryItem = DraftSyncFields & {
  id: string;
  title: string;
  summary: string;
  updatedAt: string;
  content: string;
  sourceLabel: string;
  status?: "running" | "complete" | "failed";
  createdAt?: string;
  completedAt?: string;
  request?: string;
  events?: AssistantEvent[];
};

/** Honest server persistence state for the current document. "saved" is set
 * only after a 2xx server response; anything else must never claim "Saved". */
type DraftServerSaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; revision: number }
  | { kind: "local-only"; message: string }
  // The browser refused to store this draft (quota); nothing was written.
  | { kind: "not-stored"; message: string }
  | { kind: "conflict"; serverId: string; message: string };

/** Snapshot handed to the server-sync queue; retained for explicit retries. */
type DraftServerSyncSnapshot = {
  historyId: string;
  title: string;
  content: string;
  summary: string;
  sourceLabel: string;
  storedLocally?: boolean;
};

type DraftServerBinding = {
  id: string | null;
  revision: number | null;
  historyId: string;
  lastSnapshot?: DraftServerSyncSnapshot;
  chain?: Promise<void>;
};

// Background saves survive workspace remounts. Share only within the exact
// tenant/user/history scope so reopening that draft joins its existing queue.
const draftServerBindings = new Map<string, DraftServerBinding>();
const draftCacheWriterId = crypto.randomUUID();

type AssistantEvent = {
  id: string;
  kind: "system" | "user" | "assistant";
  text: string;
  createdAt?: string;
  executedAt?: string;
  durationMs?: number | null;
};

type AssistantTool = "templates" | "sources" | "settings" | "history";

type ExportFormat = "word" | "markdown" | "code" | "pptx";
/** Every action offered by the export panel. "print" opens the browser print
 * dialog (the user chooses "Save as PDF" there); it never builds a file. */
type ExportAction = ExportFormat | "print";
type ExportDelivery = "download" | "picker";

type ExportFile = {
  filename: string;
  label: string;
  blob: Blob;
  pickerTypes: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
};

/** Everything about an export except its bytes, so the save dialog can open
 * on the click's fresh user activation before the (possibly slow) file build. */
type ExportDescriptor = Omit<ExportFile, "blob">;

type ExportReceipt = {
  filename: string;
  label: string;
  delivery: ExportDelivery;
  href?: string;
};

type FileSystemWritableFileStreamLike = {
  write: (data: Blob) => Promise<void>;
  close: () => Promise<void>;
};

type FileSystemFileHandleLike = {
  createWritable: () => Promise<FileSystemWritableFileStreamLike>;
};

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: ExportFile["pickerTypes"];
  }) => Promise<FileSystemFileHandleLike>;
};

type DraftSourceFile = {
  id: string;
  name: string;
  size: string;
};

type DraftConnectorOption = {
  id: string;
  label: string;
  icon: ConnectorIcon;
  blurb: string;
  connectorIds: string[];
};

type DraftTemplate = {
  id: string;
  name: string;
  category: "Legal" | "Finance" | "Business" | "Code" | "Writing" | "Library" | "Uploaded";
  description: string;
  defaultTitle: string;
  promptHint: string;
  body: string;
  keywords: string[];
  requiresCitations: boolean;
  requiresApproval: boolean;
  sourceHtml?: string;
  sourceFilename?: string;
};

type UploadedWordTemplate = {
  filename: string;
  title: string;
  html: string;
  text: string;
  warnings: string[];
};

type PersistedWordTemplate = {
  id: string;
  name: string;
  filename: string;
  description: string;
  html: string;
  text: string;
  uploadedAt: string;
};

type DraftAgentOption = {
  id: string;
  name: string;
  providerName: string;
  description: string;
};

type CodeArtifact = {
  language: string;
  extension: string;
  filename: string;
  content: string;
};

type DraftComposition = {
  content: string;
  html?: string;
  summary: string;
  title?: string;
  requiresCitations?: boolean;
  requiresApproval?: boolean;
  codeArtifact?: CodeArtifact | null;
};

export type DraftImportPayload = {
  id: string;
  title: string;
  content: string;
  sourceLabel: string;
  createdAt: string;
  createdAtIso?: string | null;
};

type DraftContextOptions = {
  primarySourceName: string;
  agentName: string;
  useWebSearch: boolean;
  useWorkspaceSources: boolean;
  useTemplateContext: boolean;
};

type InlineAiEditState = {
  open: boolean;
  message: string | null;
  instruction: string;
  selectedText: string;
  working: boolean;
};

type InlineAiSelectionOffer = {
  text: string;
  top: number;
  left: number;
};

type ProgressiveDraftTiming = {
  routingDelayMs: number;
  contextDelayMs: number;
  resourceDelayMs: number;
  pageDelayMs: number;
  validationDelayMs: number;
};

type DraftTraceStep = {
  id: string;
  label: string;
  detail: string;
};

type DraftTraceState = {
  steps: DraftTraceStep[];
  activeIndex: number;
  complete: boolean;
  startedAt: number;
};

const TEXT_COLOR_SWATCHES = ["#111827", "#0f766e", "#1d4ed8", "#b91c1c", "#7c3aed"];

const HIGHLIGHT_SWATCHES: Array<{ color: string; label: string }> = [
  { color: "#fde68a", label: "amber" },
  { color: "#bbf7d0", label: "green" },
  { color: "#bfdbfe", label: "blue" },
  { color: "#fbcfe8", label: "pink" },
];

/** Document sizes are labeled in Word points — the exported truth — and the
 * px value is the on-screen equivalent via WORD_PT_PER_PREVIEW_PX, so the
 * editor, print, and the DOCX export all agree. "default" clears the
 * override and the text follows its block style again. */
const DOCUMENT_FONT_SIZES = [
  { value: "default", label: "Default size", px: "" },
  { value: "9", label: "9 pt", px: "13.3px" },
  { value: "10", label: "10 pt", px: "14.7px" },
  { value: "11", label: "11 pt", px: "16.2px" },
  { value: "12", label: "12 pt", px: "17.7px" },
  { value: "14", label: "14 pt", px: "20.6px" },
  { value: "16", label: "16 pt", px: "23.6px" },
  { value: "18", label: "18 pt", px: "26.5px" },
  { value: "20", label: "20 pt", px: "29.5px" },
  { value: "24", label: "24 pt", px: "35.4px" },
  { value: "28", label: "28 pt", px: "41.3px" },
  { value: "36", label: "36 pt", px: "53.1px" },
] as const;

/** One list serves both drafting surfaces. Families render in the editor and
 * carry into DOCX (per-run rFonts) and PPTX (per-run latin typeface); a
 * machine without the font falls back per the host application's rules —
 * never silently substituted by us. "default" removes the override. */
const DRAFT_FONT_FAMILIES = [
  { value: "default", label: "Default font", css: "" },
  { value: "arial", label: "Arial", css: "Arial" },
  { value: "calibri", label: "Calibri", css: "Calibri" },
  { value: "georgia", label: "Georgia", css: "Georgia" },
  { value: "garamond", label: "Garamond", css: "Garamond" },
  { value: "times", label: "Times New Roman", css: "'Times New Roman'" },
  { value: "poppins", label: "Poppins", css: "Poppins" },
  { value: "courier", label: "Courier New", css: "'Courier New'" },
] as const;

/** Slide sizes are true PowerPoint points (the deck canvas renders 1pt as
 * 1px), matching what the PPTX export writes. "default" returns the text to
 * the layout's own size for that region. */
const DECK_FONT_SIZES = [
  { value: "default", label: "Default size", px: "" },
  { value: "12", label: "12 pt", px: "12px" },
  { value: "14", label: "14 pt", px: "14px" },
  { value: "16", label: "16 pt", px: "16px" },
  { value: "18", label: "18 pt", px: "18px" },
  { value: "20", label: "20 pt", px: "20px" },
  { value: "24", label: "24 pt", px: "24px" },
  { value: "28", label: "28 pt", px: "28px" },
  { value: "32", label: "32 pt", px: "32px" },
  { value: "40", label: "40 pt", px: "40px" },
  { value: "48", label: "48 pt", px: "48px" },
  { value: "60", label: "60 pt", px: "60px" },
] as const;

/** First family name of a CSS font-family value, unquoted and lowercased,
 * for loose matching across browser quoting differences. */
function normalizedFontFamily(value: string) {
  return (value.split(",")[0] ?? "").replace(/["']/g, "").trim().toLowerCase();
}

const DOCUMENT_BLOCK_STYLE_LABELS: Record<string, string> = {
  p: "Paragraph",
  h1: "Title",
  h2: "Heading",
  h3: "Subheading",
  blockquote: "Quote",
};

const LEGACY_FONT_SIZE_PX: Record<string, string> = {
  "1": "10px",
  "2": "12px",
  "3": "",
  "4": "18px",
  "5": "19px",
  "6": "24px",
  "7": "24px",
};

type DocumentAlignment = "left" | "center" | "right" | "justify";

const ALIGNMENT_CONTROLS: Array<{
  value: DocumentAlignment;
  command: string;
  label: string;
  icon: LucideIcon;
}> = [
  { value: "left", command: "justifyLeft", label: "Align left", icon: AlignLeft },
  { value: "center", command: "justifyCenter", label: "Align center", icon: AlignCenter },
  { value: "right", command: "justifyRight", label: "Align right", icon: AlignRight },
  { value: "justify", command: "justifyFull", label: "Justify", icon: AlignJustify },
];

type EditorFormatState = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  superscript: boolean;
  subscript: boolean;
  align: DocumentAlignment;
  blockStyle: string;
  /** Raw inline font-size at the caret ("" = no override). Each surface maps
   * this to its own preset list, since document px and deck pt differ. */
  fontSizePx: string;
  /** Normalized first font-family at the caret ("" = no override). */
  fontFamily: string;
};

const DEFAULT_EDITOR_FORMAT_STATE: EditorFormatState = {
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  superscript: false,
  subscript: false,
  align: "left",
  blockStyle: "p",
  fontSizePx: "",
  fontFamily: "",
};

type LinkEditState = {
  open: boolean;
  url: string;
  message: string | null;
  error: string | null;
  hasExistingLink: boolean;
};

const EMPTY_LINK_EDIT_STATE: LinkEditState = {
  open: false,
  url: "",
  message: null,
  error: null,
  hasExistingLink: false,
};

const DOCUMENT_HISTORY_UPDATED_EVENT = "aperture-document-history-updated";
/** History ids of provider runs alive in THIS page session. Cached entries
 * marked "running" without a live run here are interrupted leftovers from a
 * previous session and must not claim that drafting continues. */
const liveDraftRunIds = new Set<string>();
const DRAFT_MODEL_STORAGE_KEY = "aperture-document-draft-model-v1";
const WORD_TEMPLATE_STORAGE_KEY = "aperture-document-word-templates-v1";
const EMPTY_DOCUMENT_TITLE = "Untitled Draft";
// AI naming for drafts and decks, mirroring the chat header's sparkles rename.
const AI_DRAFT_TITLE_SYSTEM_PROMPT =
  "You name draft documents and slide decks for an enterprise workspace. " +
  "Reply with only the new name: 3 to 8 plain-text words, no quotes, no " +
  "markdown, no trailing punctuation, at most 60 characters. Name what the " +
  "draft is about.";
const AI_DRAFT_TITLE_EXCERPT_CHARS = 2_000;

function cleanAiDraftTitle(raw: string): string {
  const { visibleContent } = splitAssistantThinking(raw);
  const line =
    visibleContent
      .split("\n")
      .map((part) => part.trim())
      .find(Boolean) ?? "";
  return line
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.。;:,!]+$/, "")
    .trim()
    .slice(0, 160);
}
const NO_WORKSPACE_SOURCE_LABEL = "No selected workspace source";
const EMPTY_INLINE_AI_EDIT_STATE: InlineAiEditState = {
  open: false,
  message: null,
  instruction: "",
  selectedText: "",
  working: false,
};

const DOCUMENT_EXPORT_OPTIONS: Array<{
  format: Exclude<ExportFormat, "code">;
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  {
    format: "word",
    label: "Word document",
    description: "Editable Word file with preview page breaks and embedded images.",
    icon: FileText,
  },
  {
    format: "markdown",
    label: "Markdown",
    description: "Best for plain text or web publishing.",
    icon: FileText,
  },
];

/** Deck-mode export menu. Only formats that genuinely work for decks appear:
 * a real .pptx and a real markdown outline. Word/code stay document-only. */
const DECK_EXPORT_OPTIONS: Array<{
  format: Exclude<ExportFormat, "code" | "word">;
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  {
    format: "pptx",
    label: "PowerPoint deck",
    description: "Editable .pptx that mirrors the slides on screen.",
    icon: Presentation,
  },
  {
    format: "markdown",
    label: "Markdown outline",
    description: "Slide titles, bullets, and speaker notes as text.",
    icon: FileText,
  },
];

const DRAFT_ATTACHMENT_CONNECTORS: DraftConnectorOption[] = [
  {
    id: "google-drive",
    label: "Google Drive",
    icon: GoogleDriveIcon,
    blurb: "Attach and cite documents from Google Drive.",
    connectorIds: ["google-drive"],
  },
  {
    id: "onedrive",
    label: "OneDrive",
    icon: OneDriveIcon,
    blurb: "Bring in files from Microsoft OneDrive.",
    connectorIds: ["microsoft-graph"],
  },
  {
    id: "sharepoint",
    label: "SharePoint",
    icon: SharePointIcon,
    blurb: "Pull from SharePoint document libraries.",
    connectorIds: ["microsoft-graph"],
  },
  {
    id: "box",
    label: "Box",
    icon: BoxIcon,
    blurb: "Connect Box folders for matter files.",
    connectorIds: ["box"],
  },
  {
    id: "imanage",
    label: "iManage",
    icon: IManageIcon,
    blurb: "Reference work product from iManage.",
    connectorIds: ["imanage"],
  },
];

const INITIAL_DOCUMENT = `Client Update Draft

Matter: Anderson v. Northstar Logistics
Status as of June 28, 2026

We reviewed the currently connected matter files and prepared this client-facing update for attorney review.

Key points:
- The discovery deadline remains July 12, 2026.
- Opposing counsel produced a supplemental privilege log that needs a source check before it is described externally.
- The draft motion should not be filed until the Litigation Playbook source check is complete.

Next steps:
- Confirm the approval owner before sending.
- Keep citations attached to each factual statement.
- Remove any leftover internal notes before export.`;

const BUILT_IN_DRAFT_TEMPLATES: DraftTemplate[] = [
  {
    id: "legal-client-update",
    name: "Client Update",
    category: "Legal",
    description: "Client-facing matter update with source checks and approval gates.",
    defaultTitle: "Client Update Draft",
    promptHint: "Draft a client update for Anderson v. Northstar Logistics.",
    body: INITIAL_DOCUMENT,
    keywords: ["legal", "client", "matter", "update", "attorney", "approval"],
    requiresCitations: true,
    requiresApproval: true,
  },
  {
    id: "legal-approval-email",
    name: "Approval Email",
    category: "Legal",
    description: "Internal approval note before sending external client work product.",
    defaultTitle: "Approval Email Draft",
    promptHint: "Draft an approval email for an external client update.",
    body: `Approval Email Draft

To: [Approver]
Subject: Approval requested: [Client / Matter]

Summary:
- [Describe what is ready for review.]
- [List source materials checked.]
- [Identify the exact client-facing artifact.]

Approval request:
Please review the attached draft and confirm whether it is approved for external delivery.

Open items:
- [Decision needed]
- [Citation or source check needed]`,
    keywords: ["approval", "email", "client", "review", "send"],
    requiresCitations: true,
    requiresApproval: true,
  },
  {
    id: "finance-investment-memo",
    name: "Investment Memo",
    category: "Finance",
    description: "Investment thesis, financial snapshot, risks, and next steps.",
    defaultTitle: "Investment Memo Draft",
    promptHint: "Draft an investment memo for a software services acquisition.",
    body: `Investment Memo Draft

Opportunity: [Company / Asset]
Prepared for: [Committee / Sponsor]

Executive summary:
- [One-paragraph investment recommendation.]

Investment thesis:
- [Market or strategic rationale]
- [Financial rationale]
- [Operational value creation angle]

Financial snapshot:
- Revenue: [amount / period]
- EBITDA or margin: [amount / percentage]
- Growth profile: [trend]
- Key assumptions: [drivers]

Risks and diligence:
- [Commercial risk]
- [Financial risk]
- [Legal / regulatory risk]

Decision needed:
- [Approve diligence, proceed to LOI, pause, or decline]`,
    keywords: ["finance", "investment", "memo", "deal", "acquisition", "ebitda", "model"],
    requiresCitations: false,
    requiresApproval: false,
  },
  {
    id: "finance-board-update",
    name: "Board Update",
    category: "Finance",
    description: "Operating and finance update for executives or board review.",
    defaultTitle: "Board Update Draft",
    promptHint: "Draft a board update for Q2 performance and cash runway.",
    body: `Board Update Draft

Reporting period: [Period]
Audience: [Board / Executive team]

Highlights:
- [Business performance highlight]
- [Financial performance highlight]
- [Operational progress]

Metrics:
- Revenue: [amount]
- Gross margin: [percentage]
- Cash balance / runway: [amount / months]
- Pipeline or backlog: [amount]

Risks:
- [Risk]
- [Mitigation]

Asks:
- [Decision, approval, or guidance requested]`,
    keywords: ["finance", "board", "update", "performance", "runway", "cfo"],
    requiresCitations: false,
    requiresApproval: false,
  },
  {
    id: "business-project-brief",
    name: "Project Brief",
    category: "Business",
    description: "General-purpose business brief for initiatives, launches, and operations.",
    defaultTitle: "Project Brief Draft",
    promptHint: "Draft a project brief for a new AI onboarding workflow.",
    body: `Project Brief Draft

Project: [Name]
Owner: [Owner]

Objective:
[State the outcome this project should achieve.]

Background:
[Explain the current problem or opportunity.]

Scope:
- In scope: [items]
- Out of scope: [items]

Milestones:
- [Milestone and date]
- [Milestone and date]

Risks:
- [Risk and mitigation]

Next actions:
- [Action owner and deadline]`,
    keywords: ["business", "project", "brief", "initiative", "launch", "operations"],
    requiresCitations: false,
    requiresApproval: false,
  },
  {
    id: "writing-research-paper",
    name: "Research Paper",
    category: "Writing",
    description: "Long-form paper or essay with sections, thesis, analysis, and conclusion.",
    defaultTitle: "Research Paper Draft",
    promptHint: "Draft a research paper or essay on the requested topic.",
    body: `Research Paper Draft

Title: [Topic]

Introduction:
[Introduce the topic and thesis.]

Background:
[Explain the context the reader needs.]

Analysis:
[Develop the argument with evidence and examples.]

Conclusion:
[Close with the final takeaway.]`,
    keywords: ["writing", "research", "paper", "essay", "article", "mla", "apa", "report"],
    requiresCitations: false,
    requiresApproval: false,
  },
  {
    id: "writing-screenplay",
    name: "Screenplay",
    category: "Writing",
    description: "Film or video script with scene headings, action, character names, and transitions.",
    defaultTitle: "Screenplay Draft",
    promptHint: "Draft a screenplay scene in standard script formatting.",
    body: `Screenplay Draft

SCENE: INT. LOCATION - DAY

Action line describing what the audience sees.

CHARACTER: CHARACTER NAME

DIALOGUE: Dialogue goes here.

TRANSITION: FADE OUT.`,
    keywords: ["screenplay", "script", "film", "scene", "character", "dialogue", "fade"],
    requiresCitations: false,
    requiresApproval: false,
  },
  {
    id: "legal-contract",
    name: "Legal Contract",
    category: "Legal",
    description: "Contract draft with parties, obligations, payment, term, confidentiality, and signatures.",
    defaultTitle: "Legal Contract Draft",
    promptHint: "Draft a legal contract for the requested transaction or relationship.",
    body: `Legal Contract Draft

Agreement:
[Describe the agreement.]

Parties:
- [Party 1]
- [Party 2]

Terms:
- [Obligation]
- [Payment]
- [Term]

Signatures:
[Signature blocks]`,
    keywords: ["legal", "contract", "agreement", "terms", "party", "parties", "clause"],
    requiresCitations: false,
    requiresApproval: true,
  },
  {
    id: "code-implementation-plan",
    name: "Implementation Plan",
    category: "Code",
    description: "Engineering plan with requirements, files, tests, and rollout steps.",
    defaultTitle: "Implementation Plan Draft",
    promptHint: "Draft an implementation plan for a document editor feature.",
    body: `Implementation Plan Draft

Feature: [Name]

Goal:
[Describe what the shipped behavior must do.]

Requirements:
- [User-facing behavior]
- [Data or API requirement]
- [Accessibility / responsive requirement]

Implementation notes:
- Files to change: [paths]
- State model: [state shape]
- Edge cases: [cases]

Verification:
- Unit tests: [tests]
- Browser QA: [flows]
- Build / typecheck: [commands]

Rollout:
- [Deployment or migration note]`,
    keywords: ["code", "implementation", "plan", "engineering", "feature", "tests"],
    requiresCitations: false,
    requiresApproval: false,
  },
];

function blankDraftVersion(): DraftVersion {
  const executedAt = new Date().toISOString();
  return {
    id: "version-1",
    label: "Version 1",
    time: currentTimeLabel(executedAt),
    executedAt,
    content: "",
    summary: "Blank draft",
  };
}

function buildImportedDraftState(initialDraft: DraftImportPayload) {
  const importedAt = initialDraft.createdAtIso || new Date().toISOString();
  const title = initialDraft.title.trim() || "Transferred Chat Draft";
  const content = paginateTransferredDocumentHtml(
    documentHtmlFromMarkdown(initialDraft.content),
    `${title}\n\n${initialDraft.content}`,
  );
  const summary = `Transferred from chat${initialDraft.createdAt ? ` at ${initialDraft.createdAt}` : ""}`;
  const version: DraftVersion = {
    id: "version-1",
    label: "Version 1",
    time: initialDraft.createdAt || currentTimeLabel(importedAt),
    executedAt: importedAt,
    content,
    summary,
  };
  return {
    title,
    content,
    version,
    requiresCitations: /\b(citations?|references?|works cited|sources?)\b/i.test(initialDraft.content),
    requiresApproval: false,
    status: "Transferred from chat into Drafts.",
    events: [
      {
        id: `event-import-${initialDraft.id}`,
        kind: "assistant" as const,
        text: `Transferred the chat response into an editable draft from ${initialDraft.sourceLabel}.`,
        createdAt: importedAt,
        executedAt: importedAt,
      },
    ],
  };
}

function supportsDraftWebSearch(data: BootstrapData, modelId: string) {
  return webSearchSupportedForModel(data, data.models.find((item) => item.id === modelId));
}

export function DocumentAssistantWorkspace({
  data,
  brandName,
  onCloseDraft,
  onNavigationGuardChange,
  initialDraft,
  initialServerDraftId,
  actorUserId,
}: {
  data: BootstrapData;
  brandName?: string | null;
  onCloseDraft?: () => void;
  onNavigationGuardChange?: (guard: DraftNavigationGuard | null) => void;
  initialDraft?: DraftImportPayload | null;
  /** Server draft to open fully loaded on mount (e.g. from a search hit). */
  initialServerDraftId?: string | null;
  actorUserId?: string;
}) {
  const workspaceName = brandName?.trim() || "Aperture Chat";
  const completionUserId = actorUserId ?? data.me.id;
  // Draft persistence is server-first; localStorage is a working cache keyed
  // by BOTH tenant and user so no other signed-in identity can see it.
  const draftScope = useMemo<DraftCacheScope>(
    () => ({ tenantId: data.currentTenant.id, userId: completionUserId }),
    [data.currentTenant.id, completionUserId],
  );
  // Platform owners have no tenant of their own; the backend requires an
  // explicit X-Aperture-Tenant for their drafts, scoped to the tenant
  // workspace they are currently viewing.
  const draftTenantSlug =
    data.me.role === "PLATFORM_OWNER" ? data.currentTenant.slug : undefined;
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState(0);
  const [activeSourceIds, setActiveSourceIds] = useState<string[]>([]);
  const sourceSummary = useMemo(
    () => documentSourceSummary(data, activeSourceIds),
    [activeSourceIds, data],
  );
  const [uploadedWordTemplates, setUploadedWordTemplates] = useState<PersistedWordTemplate[]>(
    () => loadPersistedWordTemplates(),
  );
  const draftTemplates = useMemo(
    () => [
      ...draftTemplatesFromData(data),
      ...uploadedWordTemplates.map(persistedWordTemplateToDraftTemplate),
    ],
    [data, uploadedWordTemplates],
  );
  const draftAgents = useMemo(() => draftingAgentsFromData(data), [data]);
  const defaultDraftAgentId = useMemo(() => {
    const candidates = modelsForTextDefault(approvedWorkspaceModels(data));
    return candidates.find((model) => model.is_custom)?.id ?? candidates[0]?.id ?? "";
  }, [data]);
  const importedDraftState = useMemo(
    () => (initialDraft ? buildImportedDraftState(initialDraft) : null),
    [initialDraft?.id],
  );
  const [selectedAgentId, setSelectedAgentId] = useState(() =>
    loadDraftModelSelection(draftAgents, defaultDraftAgentId),
  );
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(() =>
    loadStoredDraftModelId(),
  );
  // Once the user picks a model this session, the starred default stops
  // auto-applying so their explicit choice is respected.
  const userPickedAgentRef = useRef(false);
  const selectedAgent: DraftAgentOption | undefined =
    draftAgents.find((agent) => agent.id === selectedAgentId) ??
    draftAgents.find((agent) => agent.id === defaultDraftAgentId);
  const draftAiAvailable = Boolean(selectedAgent);
  const draftAiUnavailableReason = data.me.role === "PLATFORM_OWNER"
    ? "Connect a provider and enable a model in the Platform Owner Console to use AI drafting."
    : "Ask your administrator to connect a model and grant your group access to use AI drafting.";
  const webSearchAvailable = selectedAgent ? supportsDraftWebSearch(data, selectedAgent.id) : false;
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    BUILT_IN_DRAFT_TEMPLATES[0].id,
  );
  const [templateCategory, setTemplateCategory] = useState<string>("All");
  const selectedTemplate =
    draftTemplates.find((template) => template.id === selectedTemplateId) ??
    draftTemplates[0];
  const templateCategories = useMemo(
    () => ["All", ...Array.from(new Set(draftTemplates.map((template) => template.category)))],
    [draftTemplates],
  );
  const visibleTemplates =
    templateCategory === "All"
      ? draftTemplates
      : draftTemplates.filter((template) => template.category === templateCategory);
  const [documentTitle, setDocumentTitle] = useState(importedDraftState?.title ?? EMPTY_DOCUMENT_TITLE);
  const [savedDocumentTitle, setSavedDocumentTitle] = useState(importedDraftState?.title ?? EMPTY_DOCUMENT_TITLE);
  const [pendingDraftNavigation, setPendingDraftNavigation] = useState<{ label: string; run: () => void } | null>(null);
  const [draftNavigationError, setDraftNavigationError] = useState<string | null>(null);
  const draftNavigationDialogRef = useRef<HTMLElement | null>(null);
  const draftOpenRequestRef = useRef(0);
  const hasUnsavedEditsRef = useRef(false);
  useModalFocus(draftNavigationDialogRef, pendingDraftNavigation !== null, () => setPendingDraftNavigation(null));
  const [draftTitleGenerating, setDraftTitleGenerating] = useState(false);
  const [content, setContent] = useState(importedDraftState?.content ?? "");
  const [instruction, setInstruction] = useState("");
  const [showEdits, setShowEdits] = useState(false);
  /** A just-landed AI edit glows for AI_EDIT_GLOW_MS and then settles into the
   * page. Freshness lives on the editor element, never in the saved HTML, so
   * reopening a draft does not re-glow edits made days ago. */
  const [aiEditsFresh, setAiEditsFresh] = useState(false);
  /** The AI edit trail: highlights every recorded AI edit still in the
   * document, however long ago it landed. */
  const [aiTrailOpen, setAiTrailOpen] = useState(false);
  const aiEditGlowTimerRef = useRef<number | null>(null);
  const [activeAssistantTool, setActiveAssistantTool] = useState<AssistantTool | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exportDelivery, setExportDelivery] = useState<ExportDelivery>("picker");
  const [pendingSaveExportFormat, setPendingSaveExportFormat] = useState<ExportAction | null>(null);
  const [exportingFormat, setExportingFormat] = useState<ExportFormat | null>(null);
  const [lastExport, setLastExport] = useState<ExportReceipt | null>(null);
  const [printPreparing, setPrintPreparing] = useState(false);
  const [printNotice, setPrintNotice] = useState<{ kind: "status" | "error"; text: string } | null>(
    null,
  );
  // Visual redline (read-only version comparison). Nothing in this state ever
  // writes back into `content` or `versions`.
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareBaseId, setCompareBaseId] = useState<string | null>(null);
  const [compareComparisonId, setCompareComparisonId] = useState<string | null>(null);
  const [redlineChangeCursor, setRedlineChangeCursor] = useState(-1);
  const compareReturnFocusRef = useRef<HTMLElement | null>(null);
  const redlineChangeRefs = useRef(new Map<number, HTMLElement>());
  const [insertMenuOpen, setInsertMenuOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [templateContextEnabled, setTemplateContextEnabled] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const [textColor, setTextColor] = useState(TEXT_COLOR_SWATCHES[0]);
  const [citationsOpen, setCitationsOpen] = useState(false);
  const [requireCitations, setRequireCitations] = useState(importedDraftState?.requiresCitations ?? false);
  // Fast–Smart reasoning level for drafting; shares the sticky per-user
  // preference with the chat composer's slider.
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>(() =>
    loadReasoningLevel(completionUserId),
  );
  // The slider only engages for models with real reasoning control; the API
  // enforces the same gate before anything reaches the provider.
  const reasoningTargetModel = data.models.find((model) => model.id === selectedAgent?.id);
  const reasoningSupported = supportsReasoningEffort(reasoningTargetModel);
  const reasoningEffortForSend = reasoningSupported ? REASONING_EFFORT_BY_LEVEL[reasoningLevel] : null;

  function updateReasoningLevel(level: ReasoningLevel) {
    setReasoningLevel(level);
    storeReasoningLevel(completionUserId, level);
  }
  const [codeArtifact, setCodeArtifact] = useState<CodeArtifact | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<DraftSourceFile[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState(importedDraftState?.version.id ?? "version-1");
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const [documentHistory, setDocumentHistory] = useState<DraftDocumentHistoryItem[]>(
    () => markInterruptedDraftRuns(loadDraftDocumentHistory(draftScope)),
  );
  const historyMutationGenerationRef = useRef(0);
  const modeDragStartRef = useRef<number | null>(null);
  const [showArchivedDrafts, setShowArchivedDrafts] = useState(false);
  const [historyBusyId, setHistoryBusyId] = useState<string | null>(null);
  const [historyDeleteTarget, setHistoryDeleteTarget] = useState<DraftDocumentHistoryItem | null>(null);
  const historyDeleteRef = useRef<HTMLElement | null>(null);
  useModalFocus(historyDeleteRef, historyDeleteTarget !== null, () => setHistoryDeleteTarget(null));
  // Quarantined read-only view of the pre-scoping browser history. These
  // entries may belong to someone else who used this browser; they are shown
  // separately and NEVER uploaded without an explicit per-entry confirmation.
  const [legacyDraftHistory, setLegacyDraftHistory] = useState<DraftDocumentHistoryItem[]>(
    () => loadLegacyDraftHistory(isDraftDocumentHistoryItem),
  );
  const [legacyImportConfirmId, setLegacyImportConfirmId] = useState<string | null>(null);
  const [legacyImportBusyId, setLegacyImportBusyId] = useState<string | null>(null);
  const [serverSaveState, setServerSaveState] = useState<DraftServerSaveState>({ kind: "idle" });
  const [serverListNotice, setServerListNotice] = useState<string | null>(null);
  const [activeHistoryItemId, setActiveHistoryItemId] = useState<string | null>(null);
  const [inlineEditState, setInlineEditState] = useState<InlineAiEditState>(
    EMPTY_INLINE_AI_EDIT_STATE,
  );
  const [linkEditState, setLinkEditState] = useState<LinkEditState>(EMPTY_LINK_EDIT_STATE);
  const [formatState, setFormatState] = useState<EditorFormatState>(DEFAULT_EDITOR_FORMAT_STATE);
  // Each surface maps the raw caret formatting onto its own preset list.
  const documentFontSizeValue =
    DOCUMENT_FONT_SIZES.find((size) => size.px && size.px === formatState.fontSizePx)?.value ??
    "default";
  const deckFontSizeValue =
    DECK_FONT_SIZES.find((size) => size.px && size.px === formatState.fontSizePx)?.value ??
    "default";
  const fontFamilyValue = formatState.fontFamily
    ? DRAFT_FONT_FAMILIES.find(
        (family) => family.css && normalizedFontFamily(family.css) === formatState.fontFamily,
      )?.value ?? "default"
    : "default";
  // Deck (PowerPoint) mode. One draft can hold both a document and a deck;
  // the mode switch toggles which is rendered and never destroys either.
  const [draftKind, setDraftKind] = useState<"document" | "deck">("document");
  const [deckState, setDeckState] = useState<SlideDeck | null>(null);
  const [selectedSlideId, setSelectedSlideId] = useState<string | null>(null);
  const [deckUndoStack, setDeckUndoStack] = useState<string[]>([]);
  const [deckRedoStack, setDeckRedoStack] = useState<string[]>([]);
  const [deckModeDialogOpen, setDeckModeDialogOpen] = useState(false);
  const [deckLayoutMenuOpen, setDeckLayoutMenuOpen] = useState<"add" | "switch" | null>(null);
  const [deckNotesOpen, setDeckNotesOpen] = useState(false);
  const [deckPresentation, setDeckPresentation] = useState<{ index: number; notesOpen: boolean } | null>(null);
  const [deckDropIndex, setDeckDropIndex] = useState<number | null>(null);
  const [deckImageDialog, setDeckImageDialog] = useState<{
    open: boolean;
    slideId: string | null;
    prompt: string;
    working: false | "generate" | "web";
    error: string | null;
  }>({ open: false, slideId: null, prompt: "", working: false, error: null });
  const [selectedDeckTemplateId, setSelectedDeckTemplateId] = useState<string>(
    BUILT_IN_DECK_TEMPLATES[0].id,
  );
  const [deckBrandTheme, setDeckBrandTheme] = useState<PersistedDeckBrandTheme | null>(() =>
    loadPersistedDeckBrandTheme(),
  );
  const [deckBrandUploadState, setDeckBrandUploadState] = useState<
    { kind: "idle" } | { kind: "working"; filename: string } | { kind: "error"; message: string }
  >({ kind: "idle" });
  const deckBrandInputRef = useRef<HTMLInputElement | null>(null);
  // Selection-based AI edit for slide text: the saved range survives the
  // click into the popover, so Apply can put the rewrite exactly where the
  // highlight was.
  const [deckAiEditState, setDeckAiEditState] = useState<{
    open: boolean;
    slideId: string | null;
    region: string | null;
    selectionText: string;
    instruction: string;
    working: boolean;
    error: string | null;
  }>({
    open: false,
    slideId: null,
    region: null,
    selectionText: "",
    instruction: "",
    working: false,
    error: null,
  });
  const deckAiEditRangeRef = useRef<Range | null>(null);
  // Floating "Ask AI" pill over highlighted slide text — the same selection
  // affordance the document editor offers, scoped to one slide block.
  const [deckAiSelectionOffer, setDeckAiSelectionOffer] = useState<InlineAiSelectionOffer | null>(
    null,
  );
  // A slide or mode switch replaces the canvas; any measured pill is stale.
  useEffect(() => {
    setDeckAiSelectionOffer(null);
  }, [selectedSlideId, draftKind]);
  const [deckAiImageDialog, setDeckAiImageDialog] = useState<{
    open: boolean;
    prompt: string;
    working: boolean;
    error: string | null;
  }>({ open: false, prompt: "", working: false, error: null });
  // Deck assistant option: also generate one AI image per drafted slide.
  const [deckImagesEnabled, setDeckImagesEnabled] = useState(false);
  // True while the post-draft image pass runs (the work trace has already
  // completed by then, so the glow needs its own signal).
  const [deckImagesWorking, setDeckImagesWorking] = useState(false);
  const [deckBackgroundMenuOpen, setDeckBackgroundMenuOpen] = useState(false);
  const [deckBackgroundWorking, setDeckBackgroundWorking] = useState(false);
  const deckBackgroundInputRef = useRef<HTMLInputElement | null>(null);
  const [inlineAiSelectionOffer, setInlineAiSelectionOffer] =
    useState<InlineAiSelectionOffer | null>(null);
  const [dismissedChangeSummaryVersionId, setDismissedChangeSummaryVersionId] = useState<
    string | null
  >(null);
  const [versions, setVersions] = useState<DraftVersion[]>(
    importedDraftState ? [importedDraftState.version] : [blankDraftVersion()],
  );
  const [events, setEvents] = useState<AssistantEvent[]>(importedDraftState?.events ?? []);
  const [draftTrace, setDraftTrace] = useState<DraftTraceState | null>(null);
  const [status, setStatus] = useState(importedDraftState?.status ?? "Blank draft ready");
  const [indentLeft, setIndentLeft] = useState(0);
  const [indentRight, setIndentRight] = useState(0);
  const [indentFirstLine, setIndentFirstLine] = useState(0);
  const viewportWidth = useViewportWidth();
  const railIsDrawer = viewportWidth <= DRAFT_RAIL_DRAWER_WIDTH;
  const [railOpen, setRailOpen] = useState(false);
  const assistantRailRef = useRef<HTMLElement | null>(null);
  useModalFocus(assistantRailRef, railIsDrawer && railOpen, () => setRailOpen(false));
  const [mobileFormattingExpanded, setMobileFormattingExpanded] = useState(false);
  const [documentToolPanel, setDocumentToolPanel] = useState<"text" | "paragraph" | "more" | null>(null);
  const assistantWorking = draftTrace !== null && !draftTrace.complete;
  const documentAiEditing = assistantWorking || inlineEditState.working;
  // Any deck AI at work — assistant drafting, the image pass, a selection
  // rewrite, or either image dialog — lights the slide's green working edge.
  const deckAiWorking =
    assistantWorking ||
    deckImagesWorking ||
    deckAiEditState.working ||
    deckAiImageDialog.working ||
    Boolean(deckImageDialog.working);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef(content);
  contentRef.current = content;
  const revisionInFlightRef = useRef(false);
  // Server binding for the document currently in the editor. `revision` is the
  // CAS token for the next PUT; a null id means the next save creates a draft.
  const serverDraftRef = useRef<DraftServerBinding>({
    id: null,
    revision: null,
    historyId: createDraftHistoryId(),
  });
  const deckHistoryIdRef = useRef(createDraftHistoryId());
  const lastDraftHistoryWriteSucceededRef = useRef(true);
  const documentHistoryRef = useRef(documentHistory);
  documentHistoryRef.current = documentHistory;
  const sheetHealRunRef = useRef(0);
  const diagramHydrationRunRef = useRef(0);
  const pageScrollRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const wordTemplateInputRef = useRef<HTMLInputElement | null>(null);
  const exportObjectUrlRef = useRef<string | null>(null);
  const exportInFlightRef = useRef(false);
  const exportImageCacheRef = useRef(new Map<string, Promise<string | null>>());
  const normalizedLayoutHtmlRef = useRef<string | null>(null);
  const draftTimersRef = useRef<number[]>([]);
  const skipNextEditorSyncRef = useRef(false);
  const inlineEditRangeRef = useRef<Range | null>(null);
  const linkEditRangeRef = useRef<Range | null>(null);
  // Editable slide blocks are uncontrolled DOM (like the document canvas);
  // this registry lets the model↔DOM sync effect and toolbar find them.
  const deckBlockRefs = useRef(
    new Map<string, { element: HTMLElement; slideId: string; region: string }>(),
  );
  // Serialized deck captured when a text-edit session starts (block focus);
  // pushed onto the undo stack once when the session commits.
  const deckEditSessionUndoRef = useRef<string | null>(null);
  const deckDragRef = useRef<{ slideId: string; pointerId: number } | null>(null);
  const deckStageViewportRef = useRef<HTMLDivElement | null>(null);
  const deckFilmstripRef = useRef<HTMLDivElement | null>(null);
  const [deckStageBox, setDeckStageBox] = useState({ scale: 1, left: 0, top: 0 });
  // Block showing its resize frame; any slide element (text or image) can be
  // adjusted from its four corners so nothing has to stay clipped.
  const [deckActiveBlock, setDeckActiveBlock] = useState<{ slideId: string; region: string } | null>(
    null,
  );
  const deckResizeRef = useRef<{
    pointerId: number;
    slideId: string;
    region: string;
    corner: DeckResizeCorner;
    startX: number;
    startY: number;
    startBox: DeckBox;
    undoSnapshot: string;
  } | null>(null);
  useEffect(() => {
    setDeckActiveBlock(null);
    deckResizeRef.current = null;
  }, [selectedSlideId, draftKind]);
  const indentDragRef = useRef<{
    kind: RulerMarker;
    startX: number;
    left: number;
    first: number;
    right: number;
  } | null>(null);

  // Toolbar toggle states mirror the real formatting at the caret so a
  // control never claims a state the document does not have.
  const refreshFormatState = useCallback(() => {
    setFormatState((current) => {
      // The toggle states mirror whichever editable surface holds the
      // selection: the document canvas, or an individual slide text block.
      const selection = window.getSelection?.();
      const node = selection?.focusNode ?? selection?.anchorNode ?? null;
      const container = node instanceof HTMLElement ? node : node?.parentElement ?? null;
      const deckBlock = container?.closest<HTMLElement>("[data-deck-block]") ?? null;
      const surface = deckBlock ?? editorRef.current;
      // Focus moving onto the toolbar (opening the size select, clicking a
      // button) must not wipe the displayed formatting back to defaults:
      // keep the last known state until the caret is somewhere readable.
      if (!surface || !node || !surface.contains(node)) return current;
      const next = computeEditorFormatState(surface);
      return editorFormatStatesEqual(current, next) ? current : next;
    });
  }, []);

  useEffect(() => {
    if (typeof document.addEventListener !== "function") return undefined;
    const handleSelectionChange = () => refreshFormatState();
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [refreshFormatState]);

  const wordCount = useMemo(() => {
    const text = documentHtmlToText(content).trim();
    const words = text ? text.split(/\s+/).length : 0;
    return { words, characters: text.replace(/\s+/g, " ").length };
  }, [content]);

  /** First image-output model the user can genuinely invoke (enabled,
   * connected provider, group access) — the AI image button only claims to
   * work when this exists. */
  const imageGenerationAgent = useMemo(
    () =>
      data.models.find(
        (model) =>
          isModelUsable(data, model) &&
          model.capabilities?.output_modalities?.includes("image"),
      ) ?? null,
    [data],
  );
  const draftNowIso = useCallback(
    () => new Date(Date.now() + serverClockOffsetMs).toISOString(),
    [serverClockOffsetMs],
  );
  const draftTimeLabel = useCallback(
    (iso?: string | null) => currentTimeLabel(iso ?? draftNowIso()),
    [draftNowIso],
  );
  const draftEvent = useCallback(
    (
      kind: AssistantEvent["kind"],
      prefix: string,
      text: string,
      options: Pick<AssistantEvent, "executedAt" | "durationMs"> & { createdAt?: string | null } = {},
    ): AssistantEvent => {
      const createdAt = options.createdAt ?? draftNowIso();
      return {
        id: `event-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind,
        text,
        createdAt,
        executedAt: options.executedAt,
        durationMs: options.durationMs,
      };
    },
    [draftNowIso],
  );
  const [currentPage, setCurrentPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  // Set while a navigator-initiated smooth scroll is in flight.
  const pendingPageScrollRef = useRef<{ target: number; expiresAt: number } | null>(null);
  const pageScrollAnimationRef = useRef<number | null>(null);
  const selectedVersion = versions.find((version) => version.id === selectedVersionId);
  const latestSavedVersion = versions[versions.length - 1];
  const canChooseExportLocation = canUseFileSavePicker();
  const serializedDeck = useMemo(
    () => (deckState ? serializeSlideDeck(deckState) : null),
    [deckState],
  );
  const selectedSlide =
    deckState?.slides.find((slide) => slide.id === selectedSlideId) ??
    deckState?.slides[0] ??
    null;
  const selectedSlideHasOwnBackground = Boolean(
    selectedSlide?.backgroundId || selectedSlide?.background,
  );
  const selectedSlideBackgroundSource =
    selectedSlide && deckState ? deckSlideBackgroundSource(selectedSlide, deckState.theme) : null;
  const deckHasAnyBackground = Boolean(
    deckState?.theme.backgroundImage || deckState?.slides.some((slide) => slide.background),
  );
  const hasUnsavedEdits = Boolean(
    selectedVersion &&
      (documentTitle.trim() !== savedDocumentTitle.trim() || (draftKind === "deck"
        ? serializedDeck !== null && selectedVersion.content !== serializedDeck
        : selectedVersion.content !== content)),
  );
  hasUnsavedEditsRef.current = hasUnsavedEdits || serverSaveState.kind === "not-stored";
  useEffect(() => {
    const protectUnsavedWork = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedEditsRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectUnsavedWork);
    return () => window.removeEventListener("beforeunload", protectUnsavedWork);
  }, []);
  const shouldShowChangeSummary =
    showEdits &&
    versions.length > 1 &&
    Boolean(latestSavedVersion) &&
    dismissedChangeSummaryVersionId !== latestSavedVersion.id;
  // "Saved" is only honest while the server copy is not known to be behind;
  // a failed or conflicted server save downgrades the label to "Local only".
  const serverSaveDegraded =
    serverSaveState.kind === "local-only" ||
    serverSaveState.kind === "not-stored" ||
    serverSaveState.kind === "conflict";
  const reviewModeLabel = hasUnsavedEdits
    ? "Editing"
    : serverSaveState.kind === "not-stored"
      ? "Not saved"
      : serverSaveDegraded
        ? "Local only"
        : "Saved";
  // Compare versions is honest only with two genuinely different saved
  // snapshots; identical restore copies do not count.
  const canCompareVersions = useMemo(
    () => new Set(versions.map((version) => version.content)).size >= 2,
    [versions],
  );
  const compareBaseVersion = versions.find((version) => version.id === compareBaseId) ?? null;
  const compareComparisonVersion =
    versions.find((version) => version.id === compareComparisonId) ?? null;
  const redlineDiff = useMemo(() => {
    if (!compareOpen || !compareBaseVersion || !compareComparisonVersion) return null;
    return computeDraftRedline(compareBaseVersion.content, compareComparisonVersion.content);
  }, [compareOpen, compareBaseVersion, compareComparisonVersion]);
  const redlineChangeCount = redlineDiff
    ? redlineDiff.rows.filter((row) => row.type !== "unchanged").length
    : 0;
  const annotatedRedlineRows = useMemo(() => {
    if (!redlineDiff) return [];
    let changeIndex = -1;
    return redlineDiff.rows.map((row) => ({
      row,
      changeIndex: row.type === "unchanged" ? -1 : (changeIndex += 1),
    }));
  }, [redlineDiff]);

  useEffect(() => {
    let active = true;
    fetchServerTime(completionUserId)
      .then((serverTime) => {
        if (!active) return;
        setServerClockOffsetMs(serverTime.unix * 1000 - Date.now());
      })
      .catch(() => {
        if (active) setServerClockOffsetMs(0);
      });
    return () => {
      active = false;
    };
  }, [completionUserId]);

  useEffect(() => {
    function handleHistoryUpdate(event: Event) {
      const detail = (event as CustomEvent<{ scope?: DraftCacheScope; items?: unknown }>).detail;
      if (detail?.scope && (detail.scope.tenantId !== draftScope.tenantId || detail.scope.userId !== draftScope.userId)) return;
      const nextHistory = Array.isArray(detail?.items)
        ? limitDraftCacheEntries(detail.items.filter(isDraftDocumentHistoryItem))
        : loadDraftDocumentHistory(draftScope);
      setDocumentHistory(nextHistory);
      if (!activeHistoryItemId) return;
      const activeItem = nextHistory.find((item) => item.id === activeHistoryItemId);
      if (!activeItem || activeItem.status === "running" || activeItem.content === content) return;
      hydrateDocumentHistoryItem(activeItem, { fromLiveUpdate: true });
    }

    window.addEventListener(DOCUMENT_HISTORY_UPDATED_EVENT, handleHistoryUpdate);
    return () => {
      window.removeEventListener(DOCUMENT_HISTORY_UPDATED_EVENT, handleHistoryUpdate);
    };
  }, [activeHistoryItemId, content, draftScope]);

  // Server-first load: merge the account's server drafts into the scoped
  // cache. The server copy wins whenever its revision is ahead of the cached
  // one; cache-only entries stay visible and are labelled "Local only".
  useEffect(() => {
    let active = true;
    const generation = historyMutationGenerationRef.current;
    listDrafts(completionUserId, { tenantSlug: draftTenantSlug })
      .then((serverDrafts) => {
        if (!active || generation !== historyMutationGenerationRef.current) return;
        const merged = mergeServerDraftsIntoCache(
          documentHistoryRef.current,
          serverDrafts,
          serverDraftHistoryStub,
        );
        saveDraftDocumentHistory(draftScope, merged);
        setDocumentHistory(markInterruptedDraftRuns(merged));
        setServerListNotice(null);
      })
      .catch((error) => {
        if (!active) return;
        setServerListNotice(
          `Account drafts could not be loaded (${draftErrorText(error)}). Showing drafts stored on this device only.`,
        );
      });
    return () => {
      active = false;
    };
  }, [completionUserId, draftScope, draftTenantSlug]);
  const aiEditTrail = useMemo(() => aiEditTrailFromHtml(content), [content]);
  const reviewModeStatus = hasUnsavedEdits
    ? "Editing in progress. Save a version when the document is ready."
    : serverSaveDegraded
      ? "Current version is kept on this device only — the server save did not complete."
      : "Current version is saved.";
  const documentPageCount = countDocumentPages(content);
  const isPaginatedDocument = documentPageCount > 0;
  const renderedPageCount = Math.max(pageCount, documentPageCount || 1);
  const activeSourceLabel =
    sourceSummary.activeKnowledge.length === 1
      ? sourceSummary.activeKnowledge[0].name
      : sourceSummary.activeKnowledge.length > 1
        ? `${sourceSummary.activeKnowledge.length} workspace sources`
        : NO_WORKSPACE_SOURCE_LABEL;
  const contextStripTitle =
    sourceSummary.activeKnowledge.length > 0
      ? `${sourceSummary.activeKnowledge.length} workspace source${
          sourceSummary.activeKnowledge.length === 1 ? "" : "s"
        }`
      : "Context sources off";
  const contextStripDetail =
    sourceSummary.activeKnowledge.length > 0
      ? `${sourceSummary.documentCount} indexed file${
          sourceSummary.documentCount === 1 ? "" : "s"
        }`
      : `${sourceSummary.enabledKnowledge.length} available sources`;

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (skipNextEditorSyncRef.current) {
      skipNextEditorSyncRef.current = false;
      return;
    }
    if (editor.innerHTML !== content) {
      editor.innerHTML = content;
      scheduleSheetOverflowHeal(content);
    }
  }, [content]);

  // Warm the authenticated image cache after the document settles. Export can
  // then package already-fetched pictures instead of making the user wait for
  // the first network request after clicking Download.
  useEffect(() => {
    if (isAutomatedTestMode() || !content.includes("<img")) return;
    const timer = window.setTimeout(() => {
      documentImageSources(content).forEach((src) => {
        void cachedExportImageDataUrl(src);
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [content, completionUserId]);

  function applyRebalancedLayout(
    sourceHtml: string,
    healedHtml: string,
    versionId = selectedVersionId,
  ) {
    const editor = editorRef.current;
    if (!editor || editor.innerHTML !== sourceHtml) return false;
    normalizedLayoutHtmlRef.current = healedHtml;
    setContent(healedHtml);
    // Reflow is a layout normalization, not a new user edit. If the source
    // was the selected saved version, update that version in lockstep so
    // Export does not incorrectly demand another save.
    setVersions((current) =>
      current.map((version) =>
        version.id === versionId && version.content === sourceHtml
          ? { ...version, content: healedHtml }
          : version,
      ),
    );
    return true;
  }

  /** Rebalances generated/restored content after the browser has real font
   * and image measurements. Manual typing is left alone until editor blur so
   * the caret never jumps in the middle of a sentence. */
  function scheduleSheetOverflowHeal(sourceHtml: string) {
    if (isAutomatedTestMode() || !countDocumentPages(sourceHtml)) return;
    const runId = ++sheetHealRunRef.current;
    const versionIdAtSchedule = selectedVersionId;
    window.setTimeout(() => {
      void (async () => {
        if (sheetHealRunRef.current !== runId) return;
        const healed = await repaginateOverfullDocumentPages(sourceHtml);
        if (sheetHealRunRef.current !== runId) return;
        if (!healed) {
          if (editorRef.current?.innerHTML === sourceHtml) {
            normalizedLayoutHtmlRef.current = sourceHtml;
          }
          return;
        }
        // The user may have edited while we measured; never clobber newer content.
        if (!applyRebalancedLayout(sourceHtml, healed, versionIdAtSchedule)) return;
        setStatus("Pages rebalanced to match the Word layout.");
      })();
    }, 250);
  }

  /** Rasterizes diagram figures into PNG data-URL images so the canvas, DOCX
   * export, and AI revisions all carry the real diagram. Runs off-DOM and
   * applies like a layout normalization, never a user edit. Figures whose
   * source cannot render keep a visual error, not mermaid source text. */
  function scheduleDocumentDiagramHydration(sourceHtml: string) {
    if (isAutomatedTestMode() || !hasUnrenderedDocumentDiagram(sourceHtml)) return;
    const runId = ++diagramHydrationRunRef.current;
    window.setTimeout(() => {
      void (async () => {
        if (diagramHydrationRunRef.current !== runId) return;
        const hydration = await hydrateDocumentDiagramFigures(sourceHtml);
        if (diagramHydrationRunRef.current !== runId || !hydration) return;
        if (!applyRebalancedLayout(sourceHtml, hydration.html)) return;
        if (hydration.rendered > 0) {
          setStatus(
            hydration.rendered === 1
              ? "Diagram rendered onto the document page."
              : `${hydration.rendered} diagrams rendered onto the document pages.`,
          );
          scheduleSheetOverflowHeal(hydration.html);
        }
      })();
    }, 200);
  }

  // Transferred chat replies and generated drafts can carry ```mermaid
  // figures; render them once the editor has committed the new content.
  useEffect(() => {
    if (isAutomatedTestMode() || !content.includes("data-diagram-source")) return;
    const frame = window.requestAnimationFrame(() => {
      const editorHtml = editorRef.current?.innerHTML;
      if (editorHtml) scheduleDocumentDiagramHydration(editorHtml);
    });
    return () => window.cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  function cachedExportImageDataUrl(src: string) {
    const existing = exportImageCacheRef.current.get(src);
    if (existing) return existing;
    const pending = fetchExportImageDataUrl(completionUserId, src)
      .catch(() => null)
      .then((result) => {
        if (!result) exportImageCacheRef.current.delete(src);
        return result;
      });
    exportImageCacheRef.current.set(src, pending);
    return pending;
  }

  useEffect(() => {
    const frame = window.requestAnimationFrame(updatePageMetrics);
    return () => window.cancelAnimationFrame(frame);
  }, [content, citationsOpen]);

  // Keep the page navigator vertically centered in the visible scroll area so
  // it reads as balanced against the page instead of hugging the toolbar.
  useEffect(() => {
    const scroller = pageScrollRef.current;
    if (!scroller) return;
    const applyNavigatorCenter = () => {
      const centered = Math.max(64, Math.round((scroller.clientHeight - 92) / 2));
      scroller.style.setProperty("--page-nav-center", `${centered}px`);
    };
    applyNavigatorCenter();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(applyNavigatorCenter);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  // A widened viewport shows the rail inline; drop any open-drawer state so it
  // never lingers as a stray overlay.
  useEffect(() => {
    if (!railIsDrawer && railOpen) setRailOpen(false);
  }, [railIsDrawer, railOpen]);

  // Never leave the fresh-edit glow timer running past this workspace.
  useEffect(
    () => () => {
      if (aiEditGlowTimerRef.current !== null) window.clearTimeout(aiEditGlowTimerRef.current);
    },
    [],
  );

  // Surface the work trace automatically when a draft starts generating in
  // drawer mode, so the user still sees progress after collapsing the panel.
  useEffect(() => {
    if (railIsDrawer && assistantWorking) setRailOpen(true);
  }, [railIsDrawer, assistantWorking]);

  useEffect(() => {
    // The starred default wins whenever its model is usable and the user has
    // not picked a model this session. The agent list is transient (the
    // workspace can mount before bootstrap data arrives, and role previews
    // filter it), so a temporarily missing id only means "not applicable
    // right now" — the starred default is never overwritten.
    const storedAgentId = loadStoredDraftModelId();
    const storedUsable = Boolean(
      storedAgentId && draftAgents.some((agent) => agent.id === storedAgentId),
    );
    if (storedUsable && !userPickedAgentRef.current && selectedAgentId !== storedAgentId) {
      setSelectedAgentId(storedAgentId as string);
      return;
    }
    if (draftAgents.some((agent) => agent.id === selectedAgentId)) return;
    // Display fallback only; deliberately not saved, so the star survives.
    setSelectedAgentId(storedUsable ? (storedAgentId as string) : defaultDraftAgentId);
  }, [defaultDraftAgentId, draftAgents, selectedAgentId]);

  useEffect(() => {
    if (webSearchAvailable || !webSearchEnabled) return;
    setWebSearchEnabled(false);
    if (selectedAgent) setStatus("Web search is turned off for this model by your workspace configuration.");
  }, [selectedAgent?.id, webSearchAvailable, webSearchEnabled]);

  useEffect(() => () => clearDraftTimers(), []);

  useEffect(
    () => () => {
      revokeRetainedExportUrl(exportObjectUrlRef.current);
      exportObjectUrlRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!initialDraft) return;
    clearDraftTimers();
    // A transferred chat draft is a new document owned by the signed-in user;
    // its first save creates a fresh server draft.
    serverDraftRef.current = { id: null, revision: null, historyId: createDraftHistoryId() };
    setServerSaveState({ kind: "idle" });
    const nextImport = buildImportedDraftState(initialDraft);
    setDocumentTitle(nextImport.title);
    setContent(nextImport.content);
    clearEditHistory();
    if (editorRef.current && editorRef.current.innerHTML !== nextImport.content) {
      editorRef.current.innerHTML = nextImport.content;
    }
    setVersions([nextImport.version]);
    setSelectedVersionId(nextImport.version.id);
    setCodeArtifact(null);
    setShowEdits(false);
    setActiveAssistantTool(null);
    setRequireCitations(nextImport.requiresCitations);
    setStatus(nextImport.status);
    rememberDocumentSnapshot(nextImport.title, nextImport.content, nextImport.version.summary);
    setEvents(nextImport.events);
    setDraftTrace(null);
    window.setTimeout(() => {
      pageScrollRef.current?.scrollTo?.({ top: 0, behavior: "auto" });
      editorRef.current?.focus();
      updatePageMetrics();
    }, 0);
  }, [initialDraft?.id]);

  function clearDraftTimers() {
    draftTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    draftTimersRef.current = [];
  }

  function scheduleDraftTimer(callback: () => void, delayMs: number) {
    const timerId = window.setTimeout(() => {
      draftTimersRef.current = draftTimersRef.current.filter((id) => id !== timerId);
      callback();
    }, delayMs);
    draftTimersRef.current.push(timerId);
  }

  function advanceDraftTrace(stepId: string, complete = false) {
    setDraftTrace((current) => {
      if (!current) return current;
      const stepIndex = current.steps.findIndex((step) => step.id === stepId);
      if (stepIndex < 0) return current;
      return {
        ...current,
        activeIndex: complete
          ? current.steps.length
          : Math.max(current.activeIndex, stepIndex),
        complete: complete || current.complete,
      };
    });
  }

  function selectDraftingModel(agentId: string) {
    const nextAgent = draftAgents.find((agent) => agent.id === agentId);
    if (!nextAgent) return;
    userPickedAgentRef.current = true;
    setSelectedAgentId(nextAgent.id);
    setStatus(`${nextAgent.name} selected for drafting.`);
  }

  function setDefaultDraftingModel(agentId: string) {
    const nextAgent = draftAgents.find((agent) => agent.id === agentId);
    if (!nextAgent) return;
    userPickedAgentRef.current = true;
    saveDraftModelSelection(nextAgent.id);
    setDefaultAgentId(nextAgent.id);
    setSelectedAgentId(nextAgent.id);
    setStatus(`${nextAgent.name} is now your default drafting model.`);
  }

  function toggleWebSearch() {
    if (!webSearchAvailable) {
      setStatus("Web search is turned off for this model by your workspace configuration.");
      return;
    }
    setWebSearchEnabled((current) => {
      const next = !current;
      setStatus(
        next
          ? "Web search enabled for this draft. Workspace knowledge remains off unless selected."
          : "Web search disabled for this draft.",
      );
      return next;
    });
  }

  function toggleTemplateContext(checked: boolean) {
    setTemplateContextEnabled(checked);
    setStatus(
      checked
        ? "Templates enabled for draft requests."
        : "Templates disabled for draft requests.",
    );
  }

  /** Page tops measured against the scroller's content, so the math holds no
   * matter which ancestor happens to be the offset parent. */
  function measuredPageTops(scroller: HTMLElement, pages: HTMLElement[]) {
    const scrollerTop = scroller.getBoundingClientRect().top;
    return pages.map((page) => page.getBoundingClientRect().top - scrollerTop + scroller.scrollTop);
  }

  function updatePageMetrics() {
    const scroller = pageScrollRef.current;
    const editor = editorRef.current;
    if (!scroller || !editor) return;
    const pages = Array.from(editor.querySelectorAll<HTMLElement>(".document-page"));
    const nextPageCount = pages.length || 1;
    setPageCount(nextPageCount);
    if (!pages.length) {
      setCurrentPage(1);
      return;
    }
    const pageTops = measuredPageTops(scroller, pages);
    const hasMeasuredPageOffsets = pageTops.some((top, index) => index > 0 && top > pageTops[0]);
    if (!hasMeasuredPageOffsets) {
      setCurrentPage(1);
      return;
    }
    // While a navigator click is animating, the clicked page stays
    // authoritative; intermediate scroll positions must not fight the buttons.
    const pending = pendingPageScrollRef.current;
    if (pending) {
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      const settled = Math.abs(scroller.scrollTop - pending.target) < 6 || atBottom;
      if (!settled && Date.now() < pending.expiresAt) return;
      pendingPageScrollRef.current = null;
    }
    const probe = scroller.scrollTop + Math.min(scroller.clientHeight * 0.45, 320);
    let nextPage = 1;
    pageTops.forEach((top, index) => {
      if (top <= probe) {
        nextPage = index + 1;
      }
    });
    setCurrentPage(Math.min(nextPageCount, Math.max(1, nextPage)));
  }

  /** Timestamp-driven easing instead of native smooth scrolling: embedded and
   * throttled browsers silently drop `behavior: "smooth"` scrolls, which left
   * the navigator buttons updating the label without moving the document. */
  function animatePageScroll(scroller: HTMLElement, target: number) {
    if (pageScrollAnimationRef.current !== null) {
      window.cancelAnimationFrame(pageScrollAnimationRef.current);
      pageScrollAnimationRef.current = null;
    }
    const start = scroller.scrollTop;
    const distance = target - start;
    if (Math.abs(distance) < 1 || typeof window.requestAnimationFrame !== "function") {
      scroller.scrollTop = target;
      return;
    }
    const duration = Math.min(520, Math.max(240, Math.abs(distance) * 0.35));
    const startedAt = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - (1 - progress) ** 3;
      scroller.scrollTop = start + distance * eased;
      pageScrollAnimationRef.current = progress < 1 ? window.requestAnimationFrame(step) : null;
    };
    pageScrollAnimationRef.current = window.requestAnimationFrame(step);
    // Backgrounded tabs pause animation frames entirely; the timer still runs
    // there, so the document always lands on the requested page.
    window.setTimeout(() => {
      if (pageScrollAnimationRef.current !== null && pendingPageScrollRef.current?.target === target) {
        window.cancelAnimationFrame(pageScrollAnimationRef.current);
        pageScrollAnimationRef.current = null;
        scroller.scrollTop = target;
      }
    }, duration + 350);
  }

  function goToDocumentPage(pageNumber: number) {
    const scroller = pageScrollRef.current;
    const editor = editorRef.current;
    if (!scroller || !editor) return;
    const pages = Array.from(editor.querySelectorAll<HTMLElement>(".document-page"));
    const targetPage = Math.min(pages.length, Math.max(1, pageNumber));
    const page = pages[targetPage - 1];
    if (!page) return;
    const pageTop = measuredPageTops(scroller, [page])[0];
    const target = Math.max(0, pageTop - 28);
    pendingPageScrollRef.current = { target, expiresAt: Date.now() + 1200 };
    setCurrentPage(targetPage);
    animatePageScroll(scroller, target);
  }

  function selectVersion(version: DraftVersion) {
    clearDraftTimers();
    if (version.format === "deck" || contentLooksLikeDeck(version.content)) {
      const parsed = parseSlideDeck(version.content);
      if (!parsed.ok) {
        setStatus(`This deck version could not be restored: ${parsed.error}`);
        return;
      }
      setSelectedVersionId(version.id);
      setDeckState(parsed.deck);
      setSelectedSlideId(parsed.deck.slides[0]?.id ?? null);
      setDeckUndoStack([]);
      setDeckRedoStack([]);
      deckEditSessionUndoRef.current = null;
      setDraftKind("deck");
      setStatus(`${version.label} restored in the deck editor.`);
      return;
    }
    setSelectedVersionId(version.id);
    setContent(version.content);
    clearEditHistory();
    setDraftKind("document");
    setStatus(`${version.label} restored in the editor.`);
    window.setTimeout(() => editorRef.current?.focus(), 0);
  }

  const requestDraftNavigation = useCallback<DraftNavigationGuard>((label, run) => {
    // A later navigation wins over any history request still loading.
    draftOpenRequestRef.current += 1;
    if (!hasUnsavedEditsRef.current) {
      run();
      return;
    }
    setDraftNavigationError(null);
    setPendingDraftNavigation({ label, run });
  }, []);

  useLayoutEffect(() => {
    onNavigationGuardChange?.(requestDraftNavigation);
    return () => onNavigationGuardChange?.(null);
  }, [onNavigationGuardChange, requestDraftNavigation]);

  function continueDraftNavigation(preserveCopy: boolean) {
    const pending = pendingDraftNavigation;
    if (!pending) return;
    if (preserveCopy) {
      const deck = draftKind === "deck" ? flushDeckTextEdits() : null;
      const nextHistory = persistDraftDocumentHistorySnapshot(draftScope, {
        id: createDraftHistoryId(),
        title: `${documentTitle.trim() || EMPTY_DOCUMENT_TITLE} (unsaved copy)`,
        content: deck ? serializeSlideDeck(deck) : contentRef.current,
        summary: "Unsaved edits preserved before leaving this version",
        sourceLabel: activeSourceLabel,
        serverId: null,
        serverRevision: null,
      });
      setDocumentHistory(nextHistory);
      if (!lastDraftHistoryWriteSucceededRef.current) {
        setDraftNavigationError("Browser storage could not keep a recovery copy. Keep editing and export your work, or explicitly discard these edits to continue.");
        return;
      }
    }
    setPendingDraftNavigation(null);
    setDraftNavigationError(null);
    pending.run();
  }

  /* ------------------------------ deck mode ------------------------------ */

  function registerDeckBlock(element: HTMLElement | null, slideId: string, region: string) {
    const key = `${slideId}:${region}`;
    if (element) deckBlockRefs.current.set(key, { element, slideId, region });
    else deckBlockRefs.current.delete(key);
  }

  /** Model → DOM sync for editable slide blocks. Uncontrolled blocks are only
   * rewritten when their parsed content genuinely differs from the model, so
   * typing never loses the caret (same idea as the document canvas sync). */
  useEffect(() => {
    if (draftKind !== "deck" || !deckState) return;
    for (const { element, slideId, region } of deckBlockRefs.current.values()) {
      const slide = deckState.slides.find((item) => item.id === slideId);
      if (!slide) continue;
      // Normalized comparison: parse the DOM through the same reader the
      // commit path uses; rewrite only when the model genuinely differs.
      const currentSlide = deckSlideWithRegionFromElement(slide, region, element, deckState.theme);
      if (JSON.stringify(currentSlide) !== JSON.stringify(slide)) {
        element.innerHTML = deckRegionHtml(slide, region);
      }
    }
  }, [draftKind, deckState]);

  /** The document canvas unmounts while deck mode is active; on return the
   * fresh element must be re-seeded with the current content (the normal
   * sync effect only fires when `content` changes). */
  useEffect(() => {
    if (draftKind !== "document") return;
    const editor = editorRef.current;
    if (editor && editor.innerHTML !== content) {
      editor.innerHTML = content;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKind]);

  /** Measures the stage viewport so the fixed 960x540 slide canvas scales to
   * fit while keeping export-exact geometry. Height counts as much as width:
   * the slide has to stay wholly visible in the frame instead of running past
   * the bottom and forcing the editor to scroll it out of sight. */
  useEffect(() => {
    if (draftKind !== "deck") return undefined;
    const viewport = deckStageViewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") {
      setDeckStageBox({ scale: 1, left: 0, top: 0 });
      return undefined;
    }
    // Height comes from the column, not the viewport: measuring the element
    // being resized would feed back on itself. The viewport is then sized to
    // the slide exactly, so the layout control and notes sit right beneath it
    // instead of a band of empty space.
    const applyScale = () => {
      const column = viewport.parentElement;
      const width = viewport.clientWidth;
      if (!column || width <= 0) return;
      const columnStyle = window.getComputedStyle(column);
      const paddingY =
        parseFloat(columnStyle.paddingTop || "0") + parseFloat(columnStyle.paddingBottom || "0");
      const gap = parseFloat(columnStyle.rowGap || "0") || 0;
      let inFlow = 0;
      let siblingHeight = 0;
      for (const child of Array.from(column.children)) {
        if (!(child instanceof HTMLElement)) continue;
        if (window.getComputedStyle(child).position === "absolute") continue;
        inFlow += 1;
        if (child !== viewport) siblingHeight += child.offsetHeight;
      }
      const available =
        column.clientHeight - paddingY - siblingHeight - gap * Math.max(0, inFlow - 1);
      if (available <= 0) return;
      const scale = Math.min(
        width / DECK_PREVIEW_WIDTH_PX,
        available / DECK_PREVIEW_HEIGHT_PX,
      );
      setDeckStageBox({
        scale,
        left: Math.max(0, (width - DECK_PREVIEW_WIDTH_PX * scale) / 2),
        top: 0,
      });
    };
    applyScale();
    const observer = new ResizeObserver(applyScale);
    const column = viewport.parentElement;
    if (column) {
      observer.observe(column);
      for (const child of Array.from(column.children)) {
        if (child instanceof HTMLElement && child !== viewport) observer.observe(child);
      }
    }
    return () => observer.disconnect();
  }, [draftKind, deckState !== null]);

  /** Keeps the open slide's thumbnail centred in the filmstrip as the
   * selection moves, so the strip scrolls under its own header rather than
   * the editor scrolling the slide away. */
  useEffect(() => {
    if (draftKind !== "deck" || !selectedSlideId) return;
    const strip = deckFilmstripRef.current;
    const thumb = strip?.querySelector<HTMLElement>(
      `[data-slide-thumb="${selectedSlideId.replace(/["\\]/g, "\\$&")}"]`,
    );
    if (!strip || !thumb) return;
    const horizontal = strip.scrollWidth - strip.clientWidth > strip.scrollHeight - strip.clientHeight;
    const target = Math.max(
      0,
      horizontal
        ? thumb.offsetLeft - (strip.clientWidth - thumb.offsetWidth) / 2
        : thumb.offsetTop - (strip.clientHeight - thumb.offsetHeight) / 2,
    );
    // scrollTo is absent in some runtimes (jsdom); plain assignment still works.
    if (typeof strip.scrollTo === "function") {
      strip.scrollTo(horizontal ? { left: target, behavior: "smooth" } : { top: target, behavior: "smooth" });
    } else if (horizontal) {
      strip.scrollLeft = target;
    } else {
      strip.scrollTop = target;
    }
  }, [draftKind, selectedSlideId, deckState?.slides.length]);

  function recordDeckUndo(serialized: string) {
    setDeckUndoStack((current) => {
      if (current[current.length - 1] === serialized) return current;
      return [...current.slice(-79), serialized];
    });
    setDeckRedoStack([]);
  }

  /** Commits a new deck state with an undo snapshot of the previous state. */
  function commitDeck(next: SlideDeck, label: string, undoSnapshot?: string | null) {
    const snapshot = undoSnapshot === undefined ? serializedDeck : undoSnapshot;
    if (snapshot) recordDeckUndo(snapshot);
    setDeckState(next);
    setStatus(label);
  }

  /** Reads any in-progress text edit out of the focused block so operations
   * (save, export, slide ops) always act on what the user sees. */
  function flushDeckTextEdits(): SlideDeck | null {
    if (!deckState) return null;
    let next = deckState;
    let changed = false;
    for (const { element, slideId, region } of deckBlockRefs.current.values()) {
      const slide = next.slides.find((item) => item.id === slideId);
      if (!slide) continue;
      const updated = deckSlideWithRegionFromElement(slide, region, element, next.theme);
      if (JSON.stringify(updated) !== JSON.stringify(slide)) {
        next = {
          ...next,
          slides: next.slides.map((item) => (item.id === slideId ? updated : item)),
        };
        changed = true;
      }
    }
    if (changed) setDeckState(next);
    return next;
  }

  function beginDeckEditSession() {
    if (deckEditSessionUndoRef.current === null && serializedDeck) {
      deckEditSessionUndoRef.current = serializedDeck;
    }
  }

  function endDeckEditSession() {
    const pending = deckEditSessionUndoRef.current;
    deckEditSessionUndoRef.current = null;
    const next = flushDeckTextEdits();
    if (!next || !pending) return;
    if (serializeSlideDeck(next) !== pending) recordDeckUndo(pending);
  }

  function handleDeckBlockInput(slideId: string, region: string, element: HTMLElement) {
    // Typing invalidates the measured selection rect; drop the stale pill.
    setDeckAiSelectionOffer(null);
    if (!deckState) return;
    const slide = deckState.slides.find((item) => item.id === slideId);
    if (!slide) return;
    const updated = deckSlideWithRegionFromElement(slide, region, element, deckState.theme);
    if (JSON.stringify(updated) === JSON.stringify(slide)) return;
    setDeckState({
      ...deckState,
      slides: deckState.slides.map((item) => (item.id === slideId ? updated : item)),
    });
  }

  function handleDeckBulletsKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "Tab") return;
    event.preventDefault();
    if (typeof document.execCommand === "function") {
      try {
        document.execCommand(event.shiftKey ? "outdent" : "indent");
      } catch {
        // Indentation is a nicety; the bullet keeps its level.
      }
    }
  }

  function undoDeckChange() {
    endDeckEditSession();
    setDeckUndoStack((currentStack) => {
      const previous = currentStack[currentStack.length - 1];
      if (!previous || !deckState) {
        setStatus("No deck edit to undo.");
        return currentStack;
      }
      const parsed = parseSlideDeck(previous);
      if (!parsed.ok) return currentStack.slice(0, -1);
      setDeckRedoStack((redo) => [serializeSlideDeck(deckState), ...redo].slice(0, 80));
      setDeckState(parsed.deck);
      if (!parsed.deck.slides.some((slide) => slide.id === selectedSlideId)) {
        setSelectedSlideId(parsed.deck.slides[0]?.id ?? null);
      }
      setStatus("Deck undo applied.");
      return currentStack.slice(0, -1);
    });
  }

  function redoDeckChange() {
    setDeckRedoStack((currentStack) => {
      const next = currentStack[0];
      if (!next || !deckState) {
        setStatus("No deck edit to redo.");
        return currentStack;
      }
      const parsed = parseSlideDeck(next);
      if (!parsed.ok) return currentStack.slice(1);
      setDeckUndoStack((undo) => [...undo.slice(-79), serializeSlideDeck(deckState)]);
      setDeckState(parsed.deck);
      if (!parsed.deck.slides.some((slide) => slide.id === selectedSlideId)) {
        setSelectedSlideId(parsed.deck.slides[0]?.id ?? null);
      }
      setStatus("Deck redo applied.");
      return currentStack.slice(1);
    });
  }

  function addDeckSlide(layout: DeckSlideLayout) {
    const deck = flushDeckTextEdits();
    if (!deck) return;
    const slide = createDeckSlide(layout, nextDeckSlideId(deck));
    const insertAt = selectedSlide
      ? deck.slides.findIndex((item) => item.id === selectedSlide.id) + 1
      : deck.slides.length;
    const slides = [...deck.slides];
    slides.splice(insertAt, 0, slide);
    commitDeck(
      { ...deck, slides },
      `${DECK_LAYOUT_LABELS[layout]} slide added.`,
      serializeSlideDeck(deck),
    );
    setSelectedSlideId(slide.id);
    setDeckLayoutMenuOpen(null);
  }

  function duplicateDeckSlide(slideId: string) {
    const deck = flushDeckTextEdits();
    if (!deck) return;
    const index = deck.slides.findIndex((item) => item.id === slideId);
    if (index === -1) return;
    const copy = { ...deck.slides[index], id: nextDeckSlideId(deck) } as DeckSlide;
    const slides = [...deck.slides];
    slides.splice(index + 1, 0, copy);
    commitDeck({ ...deck, slides }, `Slide ${index + 1} duplicated.`, serializeSlideDeck(deck));
    setSelectedSlideId(copy.id);
  }

  function deleteDeckSlide(slideId: string) {
    const deck = flushDeckTextEdits();
    if (!deck) return;
    const index = deck.slides.findIndex((item) => item.id === slideId);
    if (index === -1) return;
    if (deck.slides.length === 1) {
      setStatus("A deck keeps at least one slide. Change its layout instead.");
      return;
    }
    const slides = deck.slides.filter((item) => item.id !== slideId);
    commitDeck(
      pruneDeckBackgroundLibrary({ ...deck, slides }),
      `Slide ${index + 1} deleted. Undo restores it.`,
      serializeSlideDeck(deck),
    );
    if (selectedSlideId === slideId) {
      setSelectedSlideId(slides[Math.min(index, slides.length - 1)]?.id ?? null);
    }
  }

  function moveDeckSlide(slideId: string, targetIndex: number) {
    const deck = flushDeckTextEdits();
    if (!deck) return;
    const index = deck.slides.findIndex((item) => item.id === slideId);
    if (index === -1) return;
    const bounded = Math.max(0, Math.min(deck.slides.length - 1, targetIndex));
    if (bounded === index) return;
    const slides = [...deck.slides];
    const [slide] = slides.splice(index, 1);
    slides.splice(bounded, 0, slide);
    commitDeck(
      { ...deck, slides },
      `Slide moved to position ${bounded + 1}.`,
      serializeSlideDeck(deck),
    );
  }

  function switchDeckSlideLayout(layout: DeckSlideLayout) {
    const deck = flushDeckTextEdits();
    if (!deck || !selectedSlide) return;
    const current = deck.slides.find((item) => item.id === selectedSlide.id);
    if (!current) return;
    const { slide: remapped, hiddenCount } = remapDeckSlideLayout(current, layout);
    commitDeck(
      {
        ...deck,
        slides: deck.slides.map((item) => (item.id === current.id ? remapped : item)),
      },
      hiddenCount > 0
        ? `${DECK_LAYOUT_LABELS[layout]} layout applied. ${hiddenCount} item${
            hiddenCount === 1 ? "" : "s"
          } had no slot in this layout — undo restores them.`
        : `${DECK_LAYOUT_LABELS[layout]} layout applied.`,
      serializeSlideDeck(deck),
    );
    setDeckLayoutMenuOpen(null);
  }

  function updateDeckSlideNotes(slideId: string, notes: string) {
    if (!deckState) return;
    setDeckState({
      ...deckState,
      slides: deckState.slides.map((slide) =>
        slide.id === slideId ? ({ ...slide, notes } as DeckSlide) : slide,
      ),
    });
  }

  /** Formatting for slide text. Only bullet regions carry per-run formatting;
   * headings and captions are styled by the layout, and the toolbar says so
   * instead of pretending. */
  function runDeckTextCommand(command: string, label: string, value?: string) {
    const selection = window.getSelection?.();
    const node = selection?.focusNode ?? selection?.anchorNode ?? null;
    const container = node instanceof HTMLElement ? node : node?.parentElement ?? null;
    const blockElement = container?.closest<HTMLElement>("[data-deck-block]") ?? null;
    const entry = blockElement
      ? Array.from(deckBlockRefs.current.values()).find((item) => item.element === blockElement)
      : null;
    if (!entry || !deckState) {
      setStatus("Click into slide text before formatting.");
      return;
    }
    const slide = deckState.slides.find((item) => item.id === entry.slideId);
    if (!slide) return;
    const undoSnapshot = deckEditSessionUndoRef.current ?? serializedDeck;
    deckEditSessionUndoRef.current = null;
    focusEditorPreservingSelection(entry.element);
    let applied = false;
    if (typeof document.execCommand === "function") {
      try {
        // CSS styling keeps colour and size on spans the run parser reads back;
        // the legacy <font> path is handled too, but this is the clean one.
        document.execCommand("styleWithCSS", false, "true");
      } catch {
        // Older engines ignore the mode switch; the <font> fallback still parses.
      }
      try {
        applied = document.execCommand(command, false, value);
      } catch {
        applied = false;
      }
    }
    if (!applied) applyEditorCommandFallback(entry.element, command, value);
    const updated = deckSlideWithRegionFromElement(
      slide,
      entry.region,
      entry.element,
      deckState.theme,
    );
    commitDeck(
      {
        ...deckState,
        slides: deckState.slides.map((item) => (item.id === slide.id ? updated : item)),
      },
      label,
      undoSnapshot,
    );
  }

  function openDeckImageDialog(slideId: string) {
    const slide = deckState?.slides.find((item) => item.id === slideId);
    const suggestion =
      slide && slide.layout === "image-caption"
        ? deckRunsText(slide.caption).trim() ||
          deckRunsText(slide.title).trim() ||
          documentTitle.trim()
        : documentTitle.trim();
    setDeckImageDialog({ open: true, slideId, prompt: suggestion, working: false, error: null });
  }

  function closeDeckImageDialog() {
    setDeckImageDialog({ open: false, slideId: null, prompt: "", working: false, error: null });
  }

  function applyDeckSlideImage(slideId: string, src: string, alt: string, caption?: string) {
    const deck = flushDeckTextEdits();
    if (!deck) return;
    const slides = deck.slides.map((slide) => {
      if (slide.id !== slideId || slide.layout !== "image-caption") return slide;
      return {
        ...slide,
        image: { src, alt },
        caption: deckRunsText(slide.caption).trim()
          ? slide.caption
          : caption
            ? deckRichText(caption)
            : slide.caption,
      };
    });
    commitDeck({ ...deck, slides }, "Slide image updated.", serializeSlideDeck(deck));
  }

  function removeDeckSlideImage(slideId: string) {
    const deck = flushDeckTextEdits();
    if (!deck) return;
    const slides = deck.slides.map((slide) =>
      slide.id === slideId && slide.layout === "image-caption"
        ? { ...slide, image: { src: "", alt: "" } }
        : slide,
    );
    commitDeck({ ...deck, slides }, "Slide image removed.", serializeSlideDeck(deck));
  }

  /* --------------------------- slide backgrounds --------------------------- */

  function triggerDeckBackgroundUpload() {
    deckBackgroundInputRef.current?.click();
  }

  /** Reads an uploaded picture, downscales it to a bounded JPEG, and puts it
   * behind the selected slide. Oversized decks are refused with a real
   * message rather than saved and broken later. */
  async function handleDeckBackgroundUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const slideId = selectedSlide?.id;
    if (!slideId) {
      setStatus("Select a slide before uploading a background.");
      return;
    }
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
      setStatus("Slide backgrounds accept PNG, JPEG, or WebP images.");
      return;
    }
    setDeckBackgroundWorking(true);
    setDeckBackgroundMenuOpen(false);
    try {
      const original = await readFileAsDataUrl(file);
      if (!original) {
        setStatus(`${file.name} could not be read from your device.`);
        return;
      }
      const dataUrl = await boundedSlideBackgroundDataUrl(original);
      if (!dataUrl) {
        setStatus(
          `${file.name} is too large for a slide background. Try a smaller image or a lower resolution.`,
        );
        return;
      }
      applyDeckSlideBackground(slideId, dataUrl, file.name);
    } finally {
      setDeckBackgroundWorking(false);
    }
  }

  function applyDeckSlideBackground(slideId: string, dataUrl: string, label: string) {
    const deck = flushDeckTextEdits();
    if (!deck) return;
    const { library, key } = withDeckBackground(deck.theme, dataUrl);
    const next: SlideDeck = pruneDeckBackgroundLibrary({
      ...deck,
      theme: { ...deck.theme, backgroundLibrary: library },
      slides: deck.slides.map((slide) =>
        slide.id === slideId ? ({ ...slide, backgroundId: key } as DeckSlide) : slide,
      ),
    });
    if (utf8ByteLength(serializeSlideDeck(next)) > MAX_DECK_CONTENT_BYTES) {
      setStatus(
        `That background would push the deck past its ${Math.round(
          MAX_DECK_CONTENT_BYTES / 1_000_000,
        )} MB limit. Use “Use on every slide” for a shared background, or upload a smaller image.`,
      );
      return;
    }
    commitDeck(next, `${label} set as this slide's background.`, serializeSlideDeck(deck));
  }

  /** Deck-wide backgrounds live on the theme, so every slide shares one stored
   * picture instead of carrying its own copy. */
  function applyDeckBackgroundToEverySlide() {
    const deck = flushDeckTextEdits();
    if (!deck || !selectedSlide) return;
    const current = deck.slides.find((slide) => slide.id === selectedSlide.id);
    const source = current ? deckSlideBackgroundSource(current, deck.theme) : null;
    if (!source) {
      setStatus("Upload a background for this slide first.");
      return;
    }
    // One deck-wide picture replaces every per-slide reference, so the stored
    // library empties out instead of keeping the template's other designs.
    const next: SlideDeck = {
      ...deck,
      theme: { ...deck.theme, backgroundImage: { dataUrl: source }, backgroundLibrary: {} },
      slides: deck.slides.map(deckSlideWithoutBackground),
    };
    commitDeck(
      next,
      `Background applied to all ${next.slides.length} slide${next.slides.length === 1 ? "" : "s"}.`,
      serializeSlideDeck(deck),
    );
    setDeckBackgroundMenuOpen(false);
  }

  function removeDeckSlideBackground() {
    const deck = flushDeckTextEdits();
    if (!deck || !selectedSlide) return;
    const slide = deck.slides.find((item) => item.id === selectedSlide.id);
    if (!slide?.backgroundId && !slide?.background) {
      setStatus("This slide has no background picture of its own.");
      return;
    }
    const next: SlideDeck = pruneDeckBackgroundLibrary({
      ...deck,
      slides: deck.slides.map((item) =>
        item.id === slide.id ? deckSlideWithoutBackground(item) : item,
      ),
    });
    commitDeck(
      next,
      deck.theme.backgroundImage
        ? "Slide background removed; the deck background shows again."
        : "Slide background removed.",
      serializeSlideDeck(deck),
    );
    setDeckBackgroundMenuOpen(false);
  }

  function removeDeckBackgroundEverywhere() {
    const deck = flushDeckTextEdits();
    if (!deck) return;
    const hasSlideBackground = deck.slides.some((slide) => slide.backgroundId || slide.background);
    if (!deck.theme.backgroundImage && !hasSlideBackground) {
      setStatus("This deck has no background images.");
      return;
    }
    const next: SlideDeck = {
      ...deck,
      theme: { ...deck.theme, backgroundImage: null, backgroundLibrary: {} },
      slides: deck.slides.map(deckSlideWithoutBackground),
    };
    commitDeck(next, "Background images cleared from every slide.", serializeSlideDeck(deck));
    setDeckBackgroundMenuOpen(false);
  }

  /** One real image generation through the provider gateway: prompt in,
   * bounded JPEG data URL out. Throws with an honest message on any miss. */
  async function generateSlideImageDataUrl(
    request: string,
    kind: "photo" | "background" = "photo",
  ): Promise<string> {
    if (!imageGenerationAgent) {
      throw new ChatRequestError("No image-generation model is enabled for your workspace.");
    }
    // Backgrounds must never contain text or slide-like layouts: given slide
    // wording as a subject, image models happily paint a duplicate slide,
    // which then collides with the real text rendered on top.
    const imagePrompt =
      kind === "background"
        ? `Generate one wide 16:9 image of pure atmosphere and scenery evoking this topic: ${request}. Muted, soft, low-detail. This will be used as a BACKDROP with text layered on top later, so the image itself must contain zero typography of any kind — no text, letters, words, numbers, titles, captions, watermarks, charts, diagrams, logos, or slide layouts. If any lettering would naturally appear in the scene, replace it with empty surface.`
        : `Generate one wide 16:9 presentation slide image: ${request}. Photographic or clean illustration, no embedded text.`;
    const reply = await sendChat(completionUserId, {
      model: imageGenerationAgent.id,
      messages: [
        {
          role: "user",
          content: imagePrompt,
        },
      ],
      runtime: {
        surface: "draft",
        clientStartedAt: draftNowIso(),
        webEnabled: false,
        citationsEnabled: false,
        maxCompletionTokens: 2000,
      },
    });
    const url = extractGeneratedImageUrl(reply.content ?? "");
    if (!url) {
      throw new ChatRequestError("The image model returned no image for this prompt.");
    }
    let dataUrl = await imageUrlToJpegDataUrl(`${apiBase}${url}`);
    if (dataUrl && dataUrl.length > 900_000) {
      dataUrl = await imageUrlToJpegDataUrl(`${apiBase}${url}`, 800);
    }
    if (!dataUrl || dataUrl.length > 900_000) {
      throw new ChatRequestError(
        "The generated image could not be stored in this deck (too large to keep).",
      );
    }
    return dataUrl;
  }

  /** AI naming for the draft header, mirroring the chat rename button: the
   * selected drafting model reads the current document or deck content and
   * returns a short title. Failures land in the status line — no fake
   * success states. */
  async function generateDraftTitleWithAi() {
    if (!selectedAgent) { setStatus(draftAiUnavailableReason); return; }
    if (draftTitleGenerating) return;
    const deck = draftKind === "deck" ? flushDeckTextEdits() ?? deckState : null;
    const body =
      draftKind === "deck"
        ? deck
          ? markdownOutlineFromDeck(deck)
          : ""
        : documentHtmlToText(content);
    const excerpt = body.replace(/\s+/g, " ").trim().slice(0, AI_DRAFT_TITLE_EXCERPT_CHARS);
    if (!excerpt) {
      setStatus(
        draftKind === "deck"
          ? "AI naming needs some slide content first."
          : "AI naming needs some document content first.",
      );
      return;
    }
    setDraftTitleGenerating(true);
    try {
      const reply = await sendChat(completionUserId, {
        model: selectedAgent.id,
        messages: [
          { role: "system", content: AI_DRAFT_TITLE_SYSTEM_PROMPT },
          {
            role: "user",
            content: `${draftKind === "deck" ? "Slide deck outline" : "Document body"} to name:\n\n${excerpt}`,
          },
        ],
        runtime: {
          surface: "draft",
          clientStartedAt: draftNowIso(),
          webEnabled: false,
          citationsEnabled: false,
          // The API floor for max_completion_tokens is 256; the title itself
          // is short, but reasoning models may spend some budget thinking.
          maxCompletionTokens: 256,
        },
      });
      const title = cleanAiDraftTitle(reply.content ?? "");
      if (!title) {
        throw new ChatRequestError(`${selectedAgent.name} did not return a usable name.`);
      }
      setDocumentTitle(title);
      setStatus(`AI named this ${draftKind === "deck" ? "deck" : "draft"} "${title}".`);
    } catch (error) {
      setStatus(
        error instanceof ChatRequestError && error.message
          ? error.message
          : "The AI could not name this draft. Try again.",
      );
    } finally {
      setDraftTitleGenerating(false);
    }
  }

  /** Real AI image generation through the provider gateway (image-output
   * model). The signed image link is re-encoded into a data URL so the slide
   * keeps its picture after the link expires. */
  async function generateDeckSlideImage() {
    const { slideId, prompt } = deckImageDialog;
    const request = prompt.trim();
    if (!slideId || !request) return;
    if (!imageGenerationAgent) {
      setDeckImageDialog((current) => ({
        ...current,
        error: "No image-generation model is enabled for your workspace.",
      }));
      return;
    }
    setDeckImageDialog((current) => ({ ...current, working: "generate", error: null }));
    try {
      const dataUrl = await generateSlideImageDataUrl(request);
      applyDeckSlideImage(slideId, dataUrl, request);
      setEvents((current) => [
        ...current,
        draftEvent(
          "assistant",
          "deck-image",
          `Generated a slide image with ${imageGenerationAgent.name} for "${request}".`,
        ),
      ]);
      closeDeckImageDialog();
      setStatus("Generated image added to the slide.");
    } catch (error) {
      const message =
        error instanceof ChatRequestError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Image generation failed before an image was returned.";
      setDeckImageDialog((current) => ({ ...current, working: false, error: message }));
      setStatus(`Slide image generation failed: ${message}`);
    }
  }

  /** Web image lookup (same real source as the document editor's web images). */
  async function findDeckWebImage() {
    const { slideId, prompt } = deckImageDialog;
    const request = prompt.trim();
    if (!slideId || !request) return;
    setDeckImageDialog((current) => ({ ...current, working: "web", error: null }));
    try {
      const result = await resolveWebImageResult(request);
      applyDeckSlideImage(slideId, result.url, request, `${result.caption} (${result.source})`);
      closeDeckImageDialog();
      setStatus(`Web image for "${request}" added to the slide.`);
    } catch {
      setDeckImageDialog((current) => ({
        ...current,
        working: false,
        error: "No web image could be found for this description.",
      }));
    }
  }

  /* --------------------------- deck AI editing --------------------------- */

  function closeDeckAiEdit() {
    deckAiEditRangeRef.current = null;
    setDeckAiSelectionOffer(null);
    setDeckAiEditState({
      open: false,
      slideId: null,
      region: null,
      selectionText: "",
      instruction: "",
      working: false,
      error: null,
    });
  }

  /** Resolves the deck-block registry entry that owns a DOM node, or null. */
  function deckBlockEntryForNode(node: Node | null) {
    const container = node instanceof HTMLElement ? node : node?.parentElement ?? null;
    const blockElement = container?.closest<HTMLElement>("[data-deck-block]") ?? null;
    if (!blockElement) return null;
    return (
      Array.from(deckBlockRefs.current.values()).find((item) => item.element === blockElement) ??
      null
    );
  }

  /** Mirrors the document editor's selection pill: highlighting text inside a
   * slide block floats an "Ask AI" trigger beside the selection. Deferred a
   * tick so the browser has committed the selection before it is measured. */
  function captureDeckAiSelection() {
    window.setTimeout(() => {
      const selection = window.getSelection?.();
      const text = selection?.toString().replace(/\s+/g, " ").trim() ?? "";
      const entry =
        selection && !selection.isCollapsed && text
          ? deckBlockEntryForNode(selection.focusNode ?? selection.anchorNode)
          : null;
      if (!selection || !entry) {
        setDeckAiSelectionOffer(null);
        return;
      }
      const range = selection.getRangeAt(0).cloneRange();
      deckAiEditRangeRef.current = range;
      const rect = range.getBoundingClientRect?.() ?? null;
      const left = Math.max(12, Math.min(rect?.left ?? 24, Math.max(12, window.innerWidth - 132)));
      const top = Math.max(12, Math.min((rect?.bottom ?? 64) + 8, window.innerHeight - 48));
      setDeckAiSelectionOffer({ text: text.slice(0, 2000), top, left });
    }, 0);
  }

  /** Opens the selection AI editor for the text currently highlighted inside
   * a slide block. Falls back to the floating-pill capture when the live
   * selection was consumed by the click. Honest gate: no selection, no dialog. */
  function openDeckAiEdit() {
    if (!selectedAgent) { setStatus(draftAiUnavailableReason); return; }
    if (deckAiEditState.open) {
      closeDeckAiEdit();
      return;
    }
    const selection = window.getSelection?.();
    const text = selection?.toString().replace(/\s+/g, " ").trim() ?? "";
    const liveEntry =
      selection && !selection.isCollapsed && text
        ? deckBlockEntryForNode(selection.focusNode ?? selection.anchorNode)
        : null;
    if (liveEntry && selection) {
      deckAiEditRangeRef.current = selection.getRangeAt(0).cloneRange();
      setDeckAiSelectionOffer(null);
      setDeckAiEditState({
        open: true,
        slideId: liveEntry.slideId,
        region: liveEntry.region,
        selectionText: text.slice(0, 2000),
        instruction: "",
        working: false,
        error: null,
      });
      return;
    }
    const savedRange = deckAiEditRangeRef.current;
    const savedEntry = savedRange
      ? deckBlockEntryForNode(savedRange.commonAncestorContainer)
      : null;
    if (deckAiSelectionOffer && savedRange && savedEntry) {
      setDeckAiSelectionOffer(null);
      setDeckAiEditState({
        open: true,
        slideId: savedEntry.slideId,
        region: savedEntry.region,
        selectionText: deckAiSelectionOffer.text.slice(0, 2000),
        instruction: "",
        working: false,
        error: null,
      });
      return;
    }
    setStatus("Highlight slide text first, then ask the AI to change it.");
  }

  /** Sends the highlighted slide text plus the instruction to the selected
   * model and swaps the selection for the reply — the same interaction as the
   * document editor's inline AI edit, scoped to one slide region. */
  async function runDeckAiEdit() {
    if (!selectedAgent) {
      setDeckAiEditState((current) => ({ ...current, error: draftAiUnavailableReason }));
      return;
    }
    const { slideId, region, selectionText, instruction } = deckAiEditState;
    const ask = instruction.trim();
    if (!slideId || !region || !ask) return;
    const entry = deckBlockRefs.current.get(`${slideId}:${region}`);
    const range = deckAiEditRangeRef.current;
    if (!entry || !range || !entry.element.isConnected) {
      setDeckAiEditState((current) => ({
        ...current,
        error: "The highlighted text is no longer on screen. Reselect it and try again.",
      }));
      return;
    }
    setDeckAiEditState((current) => ({ ...current, working: true, error: null }));
    try {
      // Prompt and runtime context mirror the document editor's inline AI
      // edit: same title framing and workspace knowledge sources.
      const deckTitle = documentTitle.trim() || deckState?.title || EMPTY_DOCUMENT_TITLE;
      const reply = await sendChat(completionUserId, {
        model: selectedAgent.id,
        messages: [
          {
            role: "user",
            content: inlineRewritePrompt({
              documentTitle: deckTitle,
              instruction: ask,
              selectedText: selectionText,
              surface: "slide",
            }),
          },
        ],
        runtime: {
          surface: "draft",
          draftTitle: deckTitle,
          clientStartedAt: draftNowIso(),
          webEnabled: false,
          citationsEnabled: false,
          knowledgeConfigIds: activeSourceIds,
          maxCompletionTokens: 2000,
        },
      });
      const replacement = cleanAiReplacementText(reply.content ?? "");
      if (!replacement) {
        throw new ChatRequestError("The model returned no replacement text.");
      }
      const undoSnapshot = deckEditSessionUndoRef.current ?? serializedDeck;
      deckEditSessionUndoRef.current = null;
      entry.element.focus();
      const liveSelection = window.getSelection?.();
      liveSelection?.removeAllRanges();
      liveSelection?.addRange(range);
      let applied = false;
      if (typeof document.execCommand === "function") {
        try {
          applied = document.execCommand("insertText", false, replacement);
        } catch {
          applied = false;
        }
      }
      if (!applied) {
        range.deleteContents();
        range.insertNode(document.createTextNode(replacement));
      }
      const slide = deckState?.slides.find((item) => item.id === slideId);
      if (slide && deckState) {
        const updated = deckSlideWithRegionFromElement(
          slide,
          region,
          entry.element,
          deckState.theme,
        );
        commitDeck(
          {
            ...deckState,
            slides: deckState.slides.map((item) => (item.id === slide.id ? updated : item)),
          },
          "AI edit applied to the highlighted slide text.",
          undoSnapshot,
        );
      }
      setEvents((current) => [
        ...current,
        draftEvent(
          "assistant",
          "deck-ai-edit",
          `Rewrote highlighted slide text with ${selectedAgent.name}: ${ask.slice(0, 80)}`,
        ),
      ]);
      closeDeckAiEdit();
    } catch (error) {
      const message =
        error instanceof ChatRequestError
          ? error.message
          : error instanceof Error
            ? error.message
            : "The AI edit failed before a replacement was returned.";
      setDeckAiEditState((current) => ({ ...current, working: false, error: message }));
      setStatus(`AI edit failed: ${message}`);
    }
  }

  function closeDeckAiImageDialog() {
    setDeckAiImageDialog({ open: false, prompt: "", working: false, error: null });
  }

  /** Opens the AI background generator prefilled from the slide's own content
   * — the one-click "auto" path — while leaving the prompt editable. */
  function openDeckAiImageDialog() {
    if (deckAiImageDialog.open) {
      closeDeckAiImageDialog();
      return;
    }
    if (!selectedSlide) return;
    const outline = deckSlideOutline(selectedSlide).replace(/\n+/g, ". ").trim();
    const fallback =
      (documentTitle.trim() !== EMPTY_DOCUMENT_TITLE ? documentTitle.trim() : "") ||
      deckState?.title ||
      "";
    setDeckAiImageDialog({
      open: true,
      prompt: (outline || fallback).slice(0, 300),
      working: false,
      error: null,
    });
  }

  /** Generates a real AI image and sets it as the current slide's background,
   * flipping the slide to light text when the picture is dark. */
  async function generateDeckAiBackground() {
    const prompt = deckAiImageDialog.prompt.trim();
    const slideId = selectedSlide?.id;
    if (!prompt || !slideId) return;
    if (!imageGenerationAgent) {
      setDeckAiImageDialog((current) => ({
        ...current,
        error: "No image-generation model is enabled for your workspace.",
      }));
      return;
    }
    setDeckAiImageDialog((current) => ({ ...current, working: true, error: null }));
    try {
      const dataUrl = await generateSlideImageDataUrl(prompt, "background");
      const dark = await dataUrlIsDark(dataUrl);
      applyDeckAiSlideBackground(slideId, dataUrl, dark === true);
      setEvents((current) => [
        ...current,
        draftEvent(
          "assistant",
          "deck-ai-image",
          `Generated a slide background with ${imageGenerationAgent.name} for "${prompt.slice(0, 80)}".`,
        ),
      ]);
      closeDeckAiImageDialog();
    } catch (error) {
      const message =
        error instanceof ChatRequestError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Image generation failed before an image was returned.";
      setDeckAiImageDialog((current) => ({ ...current, working: false, error: message }));
      setStatus(`Slide image generation failed: ${message}`);
    }
  }

  /** Background + readable text in one undoable step. Light artwork clears a
   * stale white override instead of leaving invisible text behind. */
  function applyDeckAiSlideBackground(slideId: string, dataUrl: string, isDark: boolean) {
    const deck = flushDeckTextEdits();
    if (!deck) return;
    const { library, key } = withDeckBackground(deck.theme, dataUrl);
    const next: SlideDeck = pruneDeckBackgroundLibrary({
      ...deck,
      theme: { ...deck.theme, backgroundLibrary: library },
      slides: deck.slides.map((slide) => {
        if (slide.id !== slideId) return slide;
        const updated = { ...slide, backgroundId: key } as DeckSlide & { textColor?: string };
        if (isDark) updated.textColor = "#ffffff";
        else delete updated.textColor;
        return updated as DeckSlide;
      }),
    });
    if (utf8ByteLength(serializeSlideDeck(next)) > MAX_DECK_CONTENT_BYTES) {
      setStatus(
        `That image would push the deck past its ${Math.round(
          MAX_DECK_CONTENT_BYTES / 1_000_000,
        )} MB limit. Remove other backgrounds first.`,
      );
      return;
    }
    commitDeck(next, "AI image set as this slide's background.", serializeSlideDeck(deck));
  }

  /** After the assistant drafts a deck, optionally give every slide that has
   * no design its own AI image. Sequential and honest: progress in the status
   * line, every failure reported, the deck committed once as one undo step. */
  async function generateImagesForDeck(deck: SlideDeck) {
    if (!imageGenerationAgent) return;
    // Picture slides get their actual photo; every other slide gets text-free
    // background art washed for readability. Backgrounds never target picture
    // slides — the photo is that slide's visual, an art backdrop behind an
    // empty frame reads as a mistake.
    const captionTargets = deck.slides
      .filter((slide) => slide.layout === "image-caption" && !slide.image?.src)
      .slice(0, 6);
    const backgroundTargets = deck.slides
      .filter((slide) => !slide.backgroundId && slide.layout !== "image-caption")
      .slice(0, 12);
    const skipped =
      deck.slides.filter((slide) => !slide.backgroundId && slide.layout !== "image-caption").length -
      backgroundTargets.length;
    const totalTargets = captionTargets.length + backgroundTargets.length;
    if (!totalTargets) return;
    setDeckImagesWorking(true);
    let working: SlideDeck = deck;
    let generated = 0;
    let step = 0;
    const failures: string[] = [];
    for (const slide of captionTargets) {
      step += 1;
      setStatus(
        `Generating slide picture ${step} of ${totalTargets} with ${imageGenerationAgent.name}…`,
      );
      const subject =
        (slide.layout === "image-caption" &&
          (slide.image?.alt?.trim() || deckRunsText(slide.caption ?? []).trim())) ||
        deckSlideOutline(slide).split("\n")[0]?.trim() ||
        working.title;
      try {
        const dataUrl = await generateSlideImageDataUrl(subject.slice(0, 240), "photo");
        const candidate: SlideDeck = {
          ...working,
          slides: working.slides.map((item) =>
            item.id === slide.id && item.layout === "image-caption"
              ? { ...item, image: { ...item.image, src: dataUrl } }
              : item,
          ),
        };
        if (utf8ByteLength(serializeSlideDeck(candidate)) > MAX_DECK_CONTENT_BYTES) {
          failures.push(`slide picture: the deck reached its size limit`);
          break;
        }
        working = candidate;
        generated += 1;
        setDeckState(working);
      } catch (error) {
        failures.push(
          `slide picture: ${error instanceof Error ? error.message : "generation failed"}`,
        );
      }
    }
    for (const slide of backgroundTargets) {
      step += 1;
      setStatus(
        `Generating slide background ${step} of ${totalTargets} with ${imageGenerationAgent.name}…`,
      );
      // Art direction only — never the slide's own wording, which image
      // models render as a duplicate slide colliding with the real text.
      const titleLine = deckSlideOutline(slide).split("\n")[0]?.trim().slice(0, 80) ?? "";
      const subject = [working.title, titleLine].filter(Boolean).join(" — ");
      try {
        const rawDataUrl = await generateSlideImageDataUrl(subject, "background");
        const washed = await washSlideBackground(rawDataUrl, backgroundWashStrength(slide.layout));
        const dataUrl = washed?.dataUrl ?? rawDataUrl;
        const textColor = washed ? washed.textColor : (await dataUrlIsDark(rawDataUrl)) === true ? "#ffffff" : null;
        const { library, key } = withDeckBackground(working.theme, dataUrl);
        const candidate: SlideDeck = {
          ...working,
          theme: { ...working.theme, backgroundLibrary: library },
          slides: working.slides.map((item) => {
            if (item.id !== slide.id) return item;
            const updated = { ...item, backgroundId: key } as DeckSlide & { textColor?: string };
            if (textColor) updated.textColor = textColor;
            return updated as DeckSlide;
          }),
        };
        if (utf8ByteLength(serializeSlideDeck(candidate)) > MAX_DECK_CONTENT_BYTES) {
          failures.push(
            `slide background: the deck reached its size limit, so remaining slides were skipped`,
          );
          break;
        }
        working = candidate;
        generated += 1;
        // Live progress: each finished image appears on the stage right away.
        setDeckState(working);
      } catch (error) {
        failures.push(
          `slide background: ${error instanceof Error ? error.message : "generation failed"}`,
        );
      }
    }
    if (generated) {
      commitDeck(
        working,
        `${generated} AI slide image${generated === 1 ? "" : "s"} generated.`,
        serializeSlideDeck(deck),
      );
      rememberDeckSnapshot(
        documentTitle.trim() || working.title,
        serializeSlideDeck(working),
        `AI images for ${generated} slide${generated === 1 ? "" : "s"}`,
      );
    }
    const notes = [
      `Generated AI artwork for ${generated} of ${totalTargets} slides with ${imageGenerationAgent.name}.`,
      skipped > 0 ? `${skipped} slides past the 12-image cap kept their layout colors.` : "",
      ...failures.map((failure) => `Image skipped — ${failure}`),
    ].filter(Boolean);
    setEvents((current) => [
      ...current,
      ...notes.map((note) => draftEvent("assistant", "deck-ai-images", note)),
    ]);
    setStatus(
      generated
        ? `${generated} slide image${generated === 1 ? "" : "s"} generated${
            failures.length ? `; ${failures.length} failed (see draft chat)` : ""
          }.`
        : `Slide image generation failed: ${failures[0] ?? "no images were returned"}`,
    );
    setDeckImagesWorking(false);
  }

  /** Fills empty image-caption slides with a real public web image matched
   * from the slide's own picture description. Slides with no usable match
   * keep their empty frame — never a placeholder pretending to be art. */
  async function fillDeckCaptionImages(deck: SlideDeck): Promise<SlideDeck> {
    const targets = deck.slides
      .filter(
        (slide): slide is DeckSlide & { layout: "image-caption"; image: { src: string; alt: string } } =>
          slide.layout === "image-caption" && !slide.image?.src && Boolean(slide.image?.alt?.trim()),
      )
      .slice(0, 6);
    if (!targets.length) return deck;
    let working: SlideDeck = deck;
    let filled = 0;
    for (const slide of targets) {
      setStatus(`Finding a web image for "${slide.image.alt.slice(0, 60)}"…`);
      const result = await resolveWebImageResult(slide.image.alt.trim());
      if (result.source === "Aperture local fallback") continue;
      working = {
        ...working,
        slides: working.slides.map((item) =>
          item.id === slide.id && item.layout === "image-caption"
            ? { ...item, image: { ...item.image, src: result.url } }
            : item,
        ),
      };
      filled += 1;
      setDeckState(working);
    }
    if (filled) {
      commitDeck(
        working,
        `${filled} slide picture${filled === 1 ? "" : "s"} added from web image search.`,
        serializeSlideDeck(deck),
      );
      rememberDeckSnapshot(
        documentTitle.trim() || working.title,
        serializeSlideDeck(working),
        `Web pictures for ${filled} slide${filled === 1 ? "" : "s"}`,
      );
      setEvents((current) => [
        ...current,
        draftEvent(
          "assistant",
          "deck-web-images",
          `Attached ${filled} of ${targets.length} requested slide picture${
            targets.length === 1 ? "" : "s"
          } from public web image search.`,
        ),
      ]);
    }
    return working;
  }

  /** Background artwork without an image-generation model: a real public web
   * image per slide, proxied server-side and bounded to the background size
   * budget. Slides with no usable result keep their theme colors. */
  async function applyWebBackgroundsForDeck(deck: SlideDeck) {
    const targets = deck.slides
      .filter((slide) => !slide.backgroundId && slide.layout !== "image-caption")
      .slice(0, 8);
    if (!targets.length) return;
    setDeckImagesWorking(true);
    let working: SlideDeck = deck;
    let applied = 0;
    const failures: string[] = [];
    for (const [index, slide] of targets.entries()) {
      const subject =
        deckSlideOutline(slide).split("\n")[0]?.trim().slice(0, 80) || working.title;
      setStatus(`Finding background artwork ${index + 1} of ${targets.length}…`);
      try {
        const result = await resolveWebImageResult(subject);
        if (result.source === "Aperture local fallback") {
          failures.push(`slide ${index + 1}: no public web image matched "${subject}"`);
          continue;
        }
        const proxied = await fetchExportImageDataUrl(completionUserId, result.url);
        if (!proxied) {
          failures.push(`slide ${index + 1}: the image could not be fetched`);
          continue;
        }
        // The measured re-encode needs real image decoding; test runtimes
        // accept already-bounded png/jpeg bytes as-is.
        const bounded = isAutomatedTestMode()
          ? /^data:image\/(png|jpe?g);/i.test(proxied) && proxied.length <= MAX_SLIDE_BACKGROUND_CHARS
            ? proxied
            : null
          : await boundedSlideBackgroundDataUrl(proxied);
        if (!bounded) {
          failures.push(`slide ${index + 1}: the image was too large to store`);
          continue;
        }
        const washed = await washSlideBackground(bounded, backgroundWashStrength(slide.layout));
        const background = washed?.dataUrl ?? bounded;
        const textColor = washed ? washed.textColor : null;
        const { library, key } = withDeckBackground(working.theme, background);
        const candidate: SlideDeck = {
          ...working,
          theme: { ...working.theme, backgroundLibrary: library },
          slides: working.slides.map((item) => {
            if (item.id !== slide.id) return item;
            const updated = { ...item, backgroundId: key } as DeckSlide & { textColor?: string };
            if (textColor) updated.textColor = textColor;
            return updated as DeckSlide;
          }),
        };
        if (utf8ByteLength(serializeSlideDeck(candidate)) > MAX_DECK_CONTENT_BYTES) {
          failures.push(
            `slide ${index + 1}: the deck reached its size limit, so remaining slides were skipped`,
          );
          break;
        }
        working = candidate;
        applied += 1;
        setDeckState(working);
      } catch (error) {
        failures.push(
          `slide ${index + 1}: ${error instanceof Error ? error.message : "image lookup failed"}`,
        );
      }
    }
    if (applied) {
      commitDeck(
        working,
        `${applied} web background image${applied === 1 ? "" : "s"} applied.`,
        serializeSlideDeck(deck),
      );
      rememberDeckSnapshot(
        documentTitle.trim() || working.title,
        serializeSlideDeck(working),
        `Web backgrounds for ${applied} slide${applied === 1 ? "" : "s"}`,
      );
    }
    const notes = [
      `Applied public web background images to ${applied} of ${targets.length} slides.`,
      applied === 0 && failures.length
        ? "No AI image model is enabled, so backgrounds come from public web image search; nothing matched this time."
        : "",
      ...failures.map((failure) => `Background skipped — ${failure}`),
    ].filter(Boolean);
    setEvents((current) => [
      ...current,
      ...notes.map((note) => draftEvent("assistant", "deck-web-images", note)),
    ]);
    setStatus(
      applied
        ? `${applied} slide background${applied === 1 ? "" : "s"} added from web image search.`
        : "No usable web background images were found for this deck.",
    );
    setDeckImagesWorking(false);
  }

  /** Structural guidance for the deck assistant when templates are enabled. */
  function selectedDeckTemplateOutline(): string | null {
    if (!templateContextEnabled) return null;
    return builtInDeckTemplate(selectedDeckTemplateId)?.outline ?? null;
  }

  function startDeckFromTemplate(templateId: string) {
    const template = builtInDeckTemplate(templateId);
    if (!template) return;
    const title = documentTitle.trim() && documentTitle !== EMPTY_DOCUMENT_TITLE
      ? documentTitle
      : template.name;
    const built = template.build(title);
    const themed = deckState?.theme ? { ...built, theme: deckState.theme } : built;
    setDeckState(themed);
    setSelectedSlideId(themed.slides[0]?.id ?? null);
    setDeckUndoStack(deckState ? [serializeSlideDeck(deckState)] : []);
    setDeckRedoStack([]);
    deckEditSessionUndoRef.current = null;
    setDraftKind("deck");
    const version = appendDeckVersion(themed, `${template.name} template started`);
    rememberDeckSnapshot(title, version.content, version.summary);
    setStatus(
      `${template.name} template started with ${themed.slides.length} slides. Replace the scaffold text with your content.`,
    );
  }

  function triggerDeckBrandUpload() {
    deckBrandInputRef.current?.click();
  }

  async function handleDeckBrandUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setDeckBrandUploadState({ kind: "working", filename: file.name });
    try {
      const parsed = await parseDeckTemplate(completionUserId, file);
      const persisted = await persistedBrandThemeFromParse(parsed);
      const stored = savePersistedDeckBrandTheme(persisted);
      setDeckBrandTheme(persisted);
      setDeckBrandUploadState({ kind: "idle" });
      const notes = [...parsed.warnings];
      if (!stored) {
        notes.push(
          "This template was too large for this device's storage, so it is available for this session only.",
        );
      }
      if (notes.length) {
        setEvents((current) => [
          ...current,
          ...notes.map((warning) =>
            draftEvent("system", "deck-brand-warning", `Brand template note: ${warning}`),
          ),
        ]);
      }
      // An uploaded deck carries slides, not just a palette: when the current
      // deck is still blank, load every template slide instead of leaving the
      // author with one empty slide and a theme.
      const deckIsEmpty =
        !deckState ||
        (deckState.slides.length === 1 && !deckSlideOutline(deckState.slides[0]).trim());
      if (persisted.slides.length > 0 && deckIsEmpty) {
        startDeckFromBrandTemplateSlides(persisted);
      } else if (draftKind === "deck" && deckState) {
        applyDeckBrandTheme(persisted);
        if (persisted.slides.length > 0) {
          setStatus(
            `${persisted.name} brand theme applied. Its ${persisted.slides.length} template slides are ready — choose “Load all ${persisted.slides.length} slides” to replace the current deck.`,
          );
        }
      } else {
        setStatus(
          `${file.name} brand theme extracted. Switch to Deck mode and apply it from the templates panel.`,
        );
      }
    } catch (error) {
      const message =
        error instanceof ChatRequestError
          ? error.message
          : "The brand template could not be read.";
      setDeckBrandUploadState({ kind: "error", message });
      setStatus(`Brand template upload failed: ${message}`);
    }
  }

  /** Colors, fonts, logo, and deck background come from the brand; the slides'
   * own background pictures stay put, so swapping themes never silently wipes
   * artwork the author can still see. */
  function applyDeckBrandTheme(brand: PersistedDeckBrandTheme) {
    const deck = flushDeckTextEdits();
    if (!deck) return;
    commitDeck(
      {
        ...deck,
        theme: { ...brand.theme, backgroundLibrary: deck.theme.backgroundLibrary },
      },
      `${brand.name} brand theme applied to the deck.`,
      serializeSlideDeck(deck),
    );
  }

  function removeDeckThemeFromDeck() {
    const deck = flushDeckTextEdits();
    if (!deck) return;
    commitDeck(
      {
        ...deck,
        theme: { ...defaultDeckTheme(), backgroundLibrary: deck.theme.backgroundLibrary },
      },
      deck.slides.some((slide) => slide.backgroundId)
        ? "Brand theme removed. Slide background pictures stay — clear them from the background menu."
        : "Brand theme removed; slides use the neutral Aperture theme.",
      serializeSlideDeck(deck),
    );
  }

  function deleteStoredDeckBrandTheme() {
    savePersistedDeckBrandTheme(null);
    setDeckBrandTheme(null);
    setStatus("Stored brand theme deleted from this device.");
  }

  /** Lifts every slide the uploaded template carried — not a sample — with its
   * brand applied. Text that has no slot in a layout is reported, never
   * dropped silently. */
  function startDeckFromBrandTemplateSlides(brand: PersistedDeckBrandTheme) {
    if (!brand.slides.length) return;
    const title = documentTitle.trim() && documentTitle !== EMPTY_DOCUMENT_TITLE
      ? documentTitle
      : brand.name;
    const templateSlides = brand.slides.slice(0, MAX_DECK_SLIDES);
    let hiddenBlocks = 0;
    // Each slide keeps its own layout's artwork; identical designs share one
    // stored picture through the library key.
    const library: Record<string, string> = {};
    const designFor = (
      designIndex: number | null,
    ): { backgroundId?: string; textColor?: string } => {
      if (designIndex === null) return {};
      const design = brand.designs[designIndex];
      if (!design) return {};
      const key = deckBackgroundKey(design.dataUrl);
      library[key] = design.dataUrl;
      // Dark artwork gets light type, so imported slides are readable rather
      // than the brand's dark heading colour on a photograph.
      return { backgroundId: key, ...(design.isDark ? { textColor: "#ffffff" } : {}) };
    };
    const slides: DeckSlide[] = templateSlides.map((slide, index) => {
      const blocks = slide.blocks.filter((block) => block.trim());
      hiddenBlocks += Math.max(0, blocks.length - MAX_DECK_BULLETS_PER_SLIDE);
      const bulletsFromBlocks = blocks
        .slice(0, MAX_DECK_BULLETS_PER_SLIDE)
        .map((block) => ({ runs: [{ text: block.slice(0, 300) }], level: 0 as const }));
      const base = {
        id: `brand-${index + 1}`,
        notes: slide.layoutName ? `Template layout: ${slide.layoutName}` : "",
        ...designFor(slide.designIndex),
      };
      if (index === 0) {
        return {
          ...base,
          layout: "title" as const,
          title: deckRichText(slide.title?.trim() || title),
          subtitle: deckRichText(
            bulletsFromBlocks[0] ? deckRunsText(bulletsFromBlocks[0].runs) : "",
          ),
        };
      }
      // A template slide with a heading and no body text is a divider.
      if (!bulletsFromBlocks.length && slide.title?.trim()) {
        return {
          ...base,
          layout: "section" as const,
          title: deckRichText(slide.title.trim()),
          subtitle: [],
        };
      }
      // Design-only slides (no lifted text) keep an empty bullets frame the
      // author types into, rather than inventing a title.
      return {
        ...base,
        layout: "title-bullets" as const,
        title: deckRichText(slide.title?.trim() ?? ""),
        bullets: bulletsFromBlocks.length ? bulletsFromBlocks : [{ runs: [{ text: "" }], level: 0 as const }],
      };
    });
    const deck: SlideDeck = {
      schema: DECK_SCHEMA_VERSION,
      title,
      theme: { ...brand.theme, backgroundLibrary: library },
      slides,
    };
    setDeckState(deck);
    setSelectedSlideId(deck.slides[0]?.id ?? null);
    setDeckUndoStack(deckState ? [serializeSlideDeck(deckState)] : []);
    setDeckRedoStack([]);
    deckEditSessionUndoRef.current = null;
    setDraftKind("deck");
    const version = appendDeckVersion(deck, `Started from ${brand.name} template slides`);
    rememberDeckSnapshot(title, version.content, version.summary);
    const skipped = brand.slides.length - templateSlides.length;
    setStatus(
      [
        `${deck.slides.length} slide${deck.slides.length === 1 ? "" : "s"} loaded from ${brand.name}, with its brand applied.`,
        skipped > 0 ? `${skipped} slides past the ${MAX_DECK_SLIDES}-slide limit were left out.` : "",
        hiddenBlocks > 0
          ? `${hiddenBlocks} text block${hiddenBlocks === 1 ? "" : "s"} had no bullet slot and were left out.`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  /** Composer entry point for deck mode: generate a new deck or revise the
   * current one through the provider, with strict validation, one retry, and
   * a deterministic fallback — invalid AI JSON never renders. */
  async function runDeckAssistantRequest(request: string) {
    if (!selectedAgent) { setStatus(draftAiUnavailableReason); return; }
    if (revisionInFlightRef.current) {
      setStatus("The deck assistant is already working on the current request.");
      return;
    }
    revisionInFlightRef.current = true;
    endDeckEditSession();
    const currentDeck = flushDeckTextEdits();
    const hasSlideContent = Boolean(
      currentDeck &&
        currentDeck.slides.some((slide) => deckSlideOutline(slide).trim().length > 0),
    );
    const revising = Boolean(currentDeck && hasSlideContent && !isDraftCreationRequest(request));
    const theme = currentDeck?.theme ?? defaultDeckTheme();
    const useWebSearch = webSearchEnabled && webSearchAvailable && !revising;
    const contextOptions = draftContextOptions(sourceSummary, {
      useTemplateContext: false,
      useWebSearch,
    });
    const requestStartedAt = draftNowIso();
    setInstruction("");
    setEvents((current) => [
      ...current,
      draftEvent("user", "deck-request", request, { createdAt: requestStartedAt }),
    ]);
    const wantsImagery = deckWantsImagery(request);
    const artPassPlanned =
      wantsImagery || (!revising && deckImagesEnabled && Boolean(imageGenerationAgent));
    const traceSteps = deckAgentTraceSteps({
      agentName: selectedAgent.name,
      request,
      revising,
      useWebSearch,
      withArtwork: artPassPlanned,
    });
    setDraftTrace({ steps: traceSteps, activeIndex: 0, complete: false, startedAt: Date.now() });
    setStatus(revising ? "Revising the deck..." : "Drafting the deck...");

    const askProvider = async (prompt: string) => {
      const reply = await sendChat(completionUserId, {
        model: selectedAgent.id,
        messages: [{ role: "user", content: prompt }],
        runtime: {
          surface: "draft",
          draftTitle: documentTitle.trim() || EMPTY_DOCUMENT_TITLE,
          clientStartedAt: requestStartedAt,
          webEnabled: useWebSearch,
          citationsEnabled: false,
          maxCompletionTokens: 12000,
          reasoningEffort: reasoningEffortForSend,
        },
      });
      return reply.content ?? "";
    };

    try {
      advanceDraftTrace("context");
      const fallbackTitle = documentTitle.trim() || EMPTY_DOCUMENT_TITLE;
      const basePrompt = revising
        ? providerDeckRevisionPrompt(serializeSlideDeck(currentDeck as SlideDeck), request)
        : providerDeckPrompt(selectedDeckTemplateOutline(), request, contextOptions);
      advanceDraftTrace("generate");
      const keptBackgrounds = new Map<string, string>(
        (currentDeck?.slides ?? [])
          .filter((slide): slide is DeckSlide & { backgroundId: string } => Boolean(slide.backgroundId))
          .map((slide) => [slide.id, slide.backgroundId]),
      );
      let replyText = await askProvider(basePrompt);
      let parsed = parseAiDeckReply(replyText, theme, fallbackTitle, keptBackgrounds);
      if (!parsed.ok) {
        const retryPrompt =
          `${basePrompt}\n\nYour previous output failed validation: ${parsed.error}\n` +
          "Return the corrected JSON object only.";
        replyText = await askProvider(retryPrompt);
        parsed = parseAiDeckReply(replyText, theme, fallbackTitle, keptBackgrounds);
      }
      advanceDraftTrace("apply");
      let nextDeck: SlideDeck;
      let summary: string;
      let fallbackNotice: string | null = null;
      if (parsed.ok) {
        nextDeck = parsed.deck;
        summary = revising ? `Deck revised: ${request.slice(0, 80)}` : `Deck drafted: ${request.slice(0, 80)}`;
      } else if (!revising) {
        // Deterministic fallback: turn the prose reply into an outline deck.
        const { deck: fallbackDeck } = deckFromDocumentHtml(
          fallbackTitle,
          markdownToDocumentHtml(replyText),
        );
        nextDeck = { ...fallbackDeck, theme };
        summary = `Deck drafted from outline (validation fallback): ${request.slice(0, 60)}`;
        fallbackNotice =
          "The model's structured output failed validation twice, so the deck was built from its outline instead.";
      } else {
        setDraftTrace((current) => (current ? { ...current, complete: true } : current));
        setStatus(
          `The deck revision failed validation twice and was not applied: ${parsed.error}`,
        );
        setEvents((current) => [
          ...current,
          draftEvent(
            "system",
            "deck-revision-failed",
            `Deck revision was not applied: ${parsed.error}`,
          ),
        ]);
        return;
      }
      if (!nextDeck.title.trim()) nextDeck = { ...nextDeck, title: fallbackTitle };
      setDeckState(nextDeck);
      setSelectedSlideId(nextDeck.slides[0]?.id ?? null);
      // Any replacement of real slide content is undoable — including a fresh
      // build over an existing deck (a topic pivot, or a creation request that
      // read broader than intended). Only a build over an empty deck starts
      // with clean undo history.
      if (currentDeck && hasSlideContent) {
        recordDeckUndo(serializeSlideDeck(currentDeck));
      } else {
        setDeckUndoStack([]);
        setDeckRedoStack([]);
      }
      deckEditSessionUndoRef.current = null;
      if (!revising && nextDeck.title.trim() && documentTitle === EMPTY_DOCUMENT_TITLE) {
        setDocumentTitle(nextDeck.title);
      }
      const version = appendDeckVersion(nextDeck, summary);
      rememberDeckSnapshot(documentTitle.trim() || nextDeck.title, version.content, summary);
      const completedAt = draftNowIso();
      setEvents((current) => [
        ...current,
        draftEvent(
          "assistant",
          "deck-draft",
          `${revising ? "Revised" : "Drafted"} ${nextDeck.slides.length} slide${
            nextDeck.slides.length === 1 ? "" : "s"
          } with ${selectedAgent.name}.${fallbackNotice ? ` ${fallbackNotice}` : ""}`,
          {
            createdAt: completedAt,
            executedAt: requestStartedAt,
            durationMs: timestampDifferenceMs(requestStartedAt, completedAt),
          },
        ),
      ]);
      // The assistant stays visibly working through the artwork step: the
      // trace only completes after the images are attached, so "done" never
      // shows while slides are still receiving art.
      if (artPassPlanned) {
        advanceDraftTrace("artwork");
      } else {
        setDraftTrace((current) => (current ? { ...current, complete: true, activeIndex: traceSteps.length } : current));
      }
      setStatus(
        fallbackNotice
          ? `${nextDeck.slides.length} slides drafted from the model's outline (structured output failed validation).`
          : `${nextDeck.slides.length} slide${nextDeck.slides.length === 1 ? "" : "s"} ${
              revising ? "revised" : "drafted"
            }${artPassPlanned ? "; adding slide artwork…" : " and ready to edit."}`,
      );
      // Image passes run after the text lands so a slow image source never
      // blocks the slides themselves. Asking for imagery in the request works
      // on both new decks and revisions; the toolbar toggle keeps forcing the
      // AI pass for every new deck. Without an image-generation model, real
      // public web images stand in for backgrounds instead of doing nothing.
      let artDeck = nextDeck;
      if (wantsImagery) {
        artDeck = await fillDeckCaptionImages(artDeck);
      }
      if (imageGenerationAgent && (wantsImagery || (!revising && deckImagesEnabled))) {
        await generateImagesForDeck(artDeck);
      } else if (wantsImagery) {
        await applyWebBackgroundsForDeck(artDeck);
      }
      if (artPassPlanned) {
        setDraftTrace((current) =>
          current ? { ...current, complete: true, activeIndex: current.steps.length } : current,
        );
      }
    } catch (error) {
      const message =
        error instanceof ChatRequestError
          ? error.message
          : error instanceof Error
            ? error.message
            : "The deck request failed before slides were returned.";
      setDraftTrace((current) => (current ? { ...current, complete: true } : current));
      setEvents((current) => [
        ...current,
        draftEvent("system", "deck-draft-failed", `Deck request failed: ${message}`),
      ]);
      setStatus(`Deck request failed: ${message}`);
    } finally {
      revisionInFlightRef.current = false;
    }
  }

  function copyDeckOutline() {
    const deck = flushDeckTextEdits();
    if (!deck) return;
    void copyToClipboard(markdownOutlineFromDeck(deck), "Deck outline");
  }

  function appendDeckVersion(deck: SlideDeck, summary: string) {
    const nextVersionNumber = versions.length + 1;
    const executedAt = draftNowIso();
    const nextVersion: DraftVersion = {
      id: `version-${nextVersionNumber}`,
      label: `Version ${nextVersionNumber}`,
      time: draftTimeLabel(executedAt),
      executedAt,
      content: serializeSlideDeck(deck),
      summary,
      format: "deck",
    };
    setVersions((current) => [...current, nextVersion]);
    setSelectedVersionId(nextVersion.id);
    return nextVersion;
  }

  /** Local history persistence for decks. Server sync is deliberately not
   * attempted: the drafts API validates canonical HTML, so decks stay on this
   * device with an explicit Local-only badge until deck sync ships. */
  function rememberDeckSnapshot(title: string, serialized: string, summary: string) {
    const nextHistory = persistDraftDocumentHistorySnapshot(draftScope, {
      id: deckHistoryIdRef.current,
      title,
      content: serialized,
      summary,
      sourceLabel: activeSourceLabel,
    });
    setSavedDocumentTitle(title);
    setDocumentHistory(nextHistory);
    // A successful device save is the expected outcome for decks — announcing
    // it added a badge that reflowed the topbar. Only failures get a badge.
    setServerSaveState(
      lastDraftHistoryWriteSucceededRef.current
        ? { kind: "idle" }
        : {
            kind: "not-stored",
            message:
              "This deck is too large for this browser's storage, so it was not saved on this device. Export it to keep a copy.",
          },
    );
  }

  function switchDraftMode(mode: "document" | "deck") {
    if (mode === draftKind || assistantWorking) return;
    setMobileFormattingExpanded(false);
    setDocumentToolPanel(null);
    if (mode === "document") {
      endDeckEditSession();
      setDraftKind("document");
      const latestDocumentVersion = [...versions]
        .reverse()
        .find((version) => version.format !== "deck" && !contentLooksLikeDeck(version.content));
      if (latestDocumentVersion && latestDocumentVersion.id !== selectedVersionId) {
        setSelectedVersionId(latestDocumentVersion.id);
        // Deck mode never changes the document buffer. Preserve unsaved edits
        // instead of replacing them with the latest saved document version.
      }
      setStatus("Document editor active. Your deck is kept — switch back anytime.");
      return;
    }
    if (deckState) {
      setDraftKind("deck");
      const latestDeckVersion = [...versions]
        .reverse()
        .find((version) => version.format === "deck" || contentLooksLikeDeck(version.content));
      if (latestDeckVersion && latestDeckVersion.id !== selectedVersionId) {
        setSelectedVersionId(latestDeckVersion.id);
      }
      setStatus("Deck editor active.");
      return;
    }
    if (documentHtmlToText(content).trim()) {
      setDeckModeDialogOpen(true);
      return;
    }
    startBlankDeck();
  }

  function startBlankDeck() {
    deckHistoryIdRef.current = createDraftHistoryId();
    const deck = blankSlideDeck(documentTitle.trim() || EMPTY_DOCUMENT_TITLE);
    setDeckState(deck);
    setSelectedSlideId(deck.slides[0]?.id ?? null);
    setDeckUndoStack([]);
    setDeckRedoStack([]);
    deckEditSessionUndoRef.current = null;
    setDraftKind("deck");
    setMobileFormattingExpanded(false);
    setDeckModeDialogOpen(false);
    // Opening a blank deck is not an edit: reuse the pristine Version 1
    // instead of stacking a second version before the user has done anything.
    const pristine =
      versions.length === 1 && versions[0].id === "version-1" && !versions[0].content;
    if (pristine) {
      setVersions([
        {
          ...versions[0],
          content: serializeSlideDeck(deck),
          summary: "Blank deck",
          format: "deck",
        },
      ]);
      setSelectedVersionId("version-1");
    } else {
      appendDeckVersion(deck, "Blank deck started");
    }
    setStatus("Blank deck started. Add slides from the filmstrip.");
  }

  function convertDocumentToDeckNow() {
    deckHistoryIdRef.current = createDraftHistoryId();
    const sourceLabel =
      versions.find((version) => version.id === selectedVersionId)?.label ?? "the document";
    const { deck, warnings } = deckFromDocumentHtml(
      documentTitle.trim() || EMPTY_DOCUMENT_TITLE,
      content,
    );
    setDeckState(deck);
    setSelectedSlideId(deck.slides[0]?.id ?? null);
    setDeckUndoStack([]);
    setDeckRedoStack([]);
    deckEditSessionUndoRef.current = null;
    setDraftKind("deck");
    setDeckModeDialogOpen(false);
    const version = appendDeckVersion(deck, `Converted from Document · ${sourceLabel}`);
    rememberDeckSnapshot(documentTitle, version.content, version.summary);
    if (warnings.length) {
      setEvents((current) => [
        ...current,
        ...warnings.map((warning) =>
          draftEvent("system", "deck-conversion-warning", `Deck conversion note: ${warning}`),
        ),
      ]);
    }
    setStatus(
      `${deck.slides.length} slide${deck.slides.length === 1 ? "" : "s"} created from ${sourceLabel}.${
        warnings.length
          ? ` ${warnings.length} item${warnings.length === 1 ? "" : "s"} need attention — see the assistant events.`
          : ""
      }`,
    );
  }

  function handleDeckThumbPointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    slideId: string,
  ) {
    // Primary button drag-to-reorder; buttons inside the thumb still click.
    if (event.button !== 0) return;
    deckDragRef.current = { slideId, pointerId: event.pointerId };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is a nicety; drag still tracks via move events.
    }
  }

  function handleDeckThumbPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = deckDragRef.current;
    if (!drag || !deckState) return;
    const strip = event.currentTarget.closest(".deck-filmstrip");
    if (!strip) return;
    const thumbs = Array.from(strip.querySelectorAll<HTMLElement>(".deck-slide-thumb"));
    // The narrow layout flips the filmstrip horizontal; detect by geometry.
    const horizontal =
      thumbs.length >= 2
        ? Math.abs(thumbs[1].getBoundingClientRect().left - thumbs[0].getBoundingClientRect().left) >
          Math.abs(thumbs[1].getBoundingClientRect().top - thumbs[0].getBoundingClientRect().top)
        : false;
    const pointerPosition = horizontal ? event.clientX : event.clientY;
    let dropIndex = thumbs.length;
    for (let index = 0; index < thumbs.length; index += 1) {
      const rect = thumbs[index].getBoundingClientRect();
      const middle = horizontal ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
      if (pointerPosition < middle) {
        dropIndex = index;
        break;
      }
    }
    setDeckDropIndex(dropIndex);
  }

  function handleDeckThumbPointerUp() {
    const drag = deckDragRef.current;
    deckDragRef.current = null;
    if (!drag || deckDropIndex === null || !deckState) {
      setDeckDropIndex(null);
      return;
    }
    const fromIndex = deckState.slides.findIndex((slide) => slide.id === drag.slideId);
    let targetIndex = deckDropIndex;
    if (fromIndex !== -1 && targetIndex > fromIndex) targetIndex -= 1;
    setDeckDropIndex(null);
    if (fromIndex === -1 || targetIndex === fromIndex) return;
    moveDeckSlide(drag.slideId, targetIndex);
  }

  /** Resolved box for the active block, reading any prior user override. */
  function deckBlockBoxCurrent(slideId: string, region: string): DeckBox | null {
    const slide = deckState?.slides.find((item) => item.id === slideId) ?? null;
    if (!slide) return null;
    return deckBlockBoxForRegion(slide, region);
  }

  function applyDeckBlockBox(
    slideId: string,
    region: string,
    box: DeckBox,
    commit: boolean,
    undoSnapshot?: string,
  ) {
    const applyTo = (deck: SlideDeck): SlideDeck => ({
      ...deck,
      slides: deck.slides.map((slide) =>
        slide.id === slideId
          ? { ...slide, boxes: { ...(slide.boxes ?? {}), [region]: box } }
          : slide,
      ),
    });
    if (commit) {
      if (!deckState) return;
      commitDeck(applyTo(deckState), "Slide block resized.", undoSnapshot);
    } else {
      setDeckState((current) => (current ? applyTo(current) : current));
    }
  }

  function beginDeckBlockResize(
    event: ReactPointerEvent<HTMLButtonElement>,
    corner: DeckResizeCorner,
  ) {
    if (event.button !== 0 || !deckActiveBlock) return;
    const deck = flushDeckTextEdits();
    if (!deck) return;
    const startBox = deckBlockBoxCurrent(deckActiveBlock.slideId, deckActiveBlock.region);
    if (!startBox) return;
    deckResizeRef.current = {
      pointerId: event.pointerId,
      slideId: deckActiveBlock.slideId,
      region: deckActiveBlock.region,
      corner,
      startX: event.clientX,
      startY: event.clientY,
      startBox,
      undoSnapshot: serializeSlideDeck(deck),
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is a nicety; the drag still works without it.
    }
    event.preventDefault();
  }

  function deckResizeDragBox(event: ReactPointerEvent<HTMLButtonElement>): DeckBox | null {
    const drag = deckResizeRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return null;
    // Pointer deltas are screen pixels; the stage renders scaled, so divide
    // to keep one pointer pixel equal to one slide pixel visually.
    const scale = deckStageBox.scale || 1;
    return resizeBoxFromCorner(
      drag.startBox,
      drag.corner,
      (event.clientX - drag.startX) / scale,
      (event.clientY - drag.startY) / scale,
    );
  }

  function moveDeckBlockResize(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = deckResizeRef.current;
    const next = deckResizeDragBox(event);
    if (!drag || !next) return;
    applyDeckBlockBox(drag.slideId, drag.region, next, false);
  }

  function endDeckBlockResize(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = deckResizeRef.current;
    const next = deckResizeDragBox(event);
    deckResizeRef.current = null;
    if (!drag || !next) return;
    applyDeckBlockBox(drag.slideId, drag.region, next, true, drag.undoSnapshot);
  }

  function nudgeDeckBlockCorner(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    corner: DeckResizeCorner,
  ) {
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const delta = deltas[event.key];
    if (!delta || !deckActiveBlock) return;
    event.preventDefault();
    const deck = flushDeckTextEdits();
    if (!deck) return;
    const startBox = deckBlockBoxCurrent(deckActiveBlock.slideId, deckActiveBlock.region);
    if (!startBox) return;
    const step = event.shiftKey ? 16 : 4;
    const next = resizeBoxFromCorner(startBox, corner, delta[0] * step, delta[1] * step);
    applyDeckBlockBox(
      deckActiveBlock.slideId,
      deckActiveBlock.region,
      next,
      true,
      serializeSlideDeck(deck),
    );
  }

  function resetDeckBlockBox() {
    const active = deckActiveBlock;
    if (!active) return;
    const deck = flushDeckTextEdits();
    if (!deck?.slides.some((slide) => slide.id === active.slideId && slide.boxes?.[active.region])) {
      return;
    }
    const next: SlideDeck = {
      ...deck,
      slides: deck.slides.map((slide) => {
        if (slide.id !== active.slideId || !slide.boxes) return slide;
        const remaining = { ...slide.boxes };
        delete remaining[active.region];
        if (Object.keys(remaining).length) return { ...slide, boxes: remaining };
        const { boxes: _boxes, ...withoutBoxes } = slide;
        return withoutBoxes as DeckSlide;
      }),
    };
    commitDeck(next, "Block restored to the layout size.", serializeSlideDeck(deck));
  }

  function rememberDocumentSnapshot(title: string, html: string, summary: string) {
    const nextHistory = persistDraftDocumentHistorySnapshot(draftScope, {
      id: serverDraftRef.current.historyId,
      title,
      content: html,
      summary,
      sourceLabel: activeSourceLabel,
      serverId: serverDraftRef.current.id,
      serverRevision: serverDraftRef.current.revision,
      serverSavePending: true,
    });
    setSavedDocumentTitle(title);
    setDocumentHistory(nextHistory);
    queueDraftServerSync({
      historyId: nextHistory[0].id,
      title,
      content: html,
      summary,
      sourceLabel: activeSourceLabel,
    });
  }

  /** Server-first save. Creates the draft on first save (storing the
   * server-assigned id) and CAS-updates afterwards. Saves are chained so they
   * settle in order; every failure keeps the scoped local cache intact and is
   * reported as "Local only", never "Saved". */
  function queueDraftServerSync(
    snapshot: DraftServerSyncSnapshot,
    binding = serverDraftRef.current,
  ) {
    const queued = {
      ...snapshot,
      storedLocally: snapshot.storedLocally ?? lastDraftHistoryWriteSucceededRef.current,
    };
    binding.lastSnapshot = queued;
    draftServerBindings.set(`${scopedDraftCacheKey(draftScope)}:${binding.historyId}`, binding);
    binding.chain = (binding.chain ?? Promise.resolve())
      .then(() => syncDraftSnapshotToServer(queued, binding))
      .catch(() => {})
      .finally(() => {
        if (binding.lastSnapshot === queued) {
          draftServerBindings.delete(`${scopedDraftCacheKey(draftScope)}:${binding.historyId}`);
        }
      });
  }

  async function syncDraftSnapshotToServer(
    snapshot: DraftServerSyncSnapshot,
    binding: DraftServerBinding,
  ) {
    // A save owns the document binding captured when it was queued. Switching
    // the editor must never retarget a pending PUT or adopt its response.
    const reportSaveState = (state: DraftServerSaveState) => {
      if (serverDraftRef.current === binding && binding.lastSnapshot === snapshot) {
        setServerSaveState(state);
      }
    };
    const reportUnstored = (reason: string) => reportSaveState({
      kind: snapshot.storedLocally ? "local-only" : "not-stored",
      message: snapshot.storedLocally
        ? `Local only — ${reason}. Your changes are kept on this device.`
        : `Not saved — ${reason}, and browser storage could not keep a copy. Keep this workspace open and retry or export your changes.`,
    });
    const title = snapshot.title.trim() || EMPTY_DOCUMENT_TITLE;
    if (utf8ByteLength(snapshot.content) > MAX_DRAFT_CONTENT_BYTES) {
      reportUnstored("this draft exceeds the 2 MB server draft limit");
      return;
    }
    if (binding.id && binding.revision === null) {
      // The server copy has revisions this device has not fetched; updating
      // blind would overwrite them. Ask for an explicit reload instead.
      reportSaveState({
        kind: "conflict",
        serverId: binding.id,
        message:
          "The server copy of this draft has revisions this device has not seen. Reload it before saving.",
      });
      return;
    }
    reportSaveState({ kind: "saving" });
    try {
      // matter_id is deliberately never sent from this workspace: omitting the
      // field preserves any existing matter assignment on the server, and only
      // an explicit user action may ever send null to clear it.
      const result =
        binding.id && binding.revision !== null
          ? await updateDraft(
              completionUserId,
              binding.id,
              { expected_revision: binding.revision, title, content: snapshot.content },
              { tenantSlug: draftTenantSlug },
            )
          : await createDraft(
              completionUserId,
              { title, content: snapshot.content },
              { tenantSlug: draftTenantSlug },
            );
      binding.id = result.document.id;
      binding.revision = result.document.current_revision;
      // If another version is already queued, retain that newest local content
      // while recording the acknowledged revision for the next serialized PUT.
      const latest = binding.lastSnapshot ?? snapshot;
      const diskHistory = loadDraftDocumentHistory(draftScope);
      const foreignPending = diskHistory.find((item) =>
        item.id === snapshot.historyId && item.serverSavePending &&
        item.cacheWriterId && item.cacheWriterId !== draftCacheWriterId,
      );
      if (foreignPending) {
        // CAS protects the server, but localStorage is shared by browser tabs.
        // Another tab's unsent work keeps its original revision token and copy.
        setDocumentHistory(diskHistory);
        reportSaveState({ kind: "saved", revision: result.document.current_revision });
        return;
      }
      const nextHistory = persistDraftDocumentHistorySnapshot(draftScope, {
        id: snapshot.historyId,
        title: latest.title,
        content: latest.content,
        summary: latest.summary,
        sourceLabel: latest.sourceLabel,
        serverId: result.document.id,
        serverRevision: result.document.current_revision,
        serverContentStale: false,
        serverSavePending: latest !== snapshot,
      });
      latest.storedLocally = lastDraftHistoryWriteSucceededRef.current;
      setDocumentHistory(nextHistory);
      reportSaveState({ kind: "saved", revision: result.document.current_revision });
    } catch (error) {
      if (isDraftConflictError(error) && binding.id) {
        reportSaveState({
          kind: "conflict",
          serverId: binding.id,
          message:
            "This draft changed somewhere else (another tab or device) before this save. Reload the server copy to continue from it — nothing was overwritten.",
        });
      } else {
        reportUnstored(`server save failed (${draftErrorText(error)})`);
      }
    }
  }

  function retryDraftServerSync() {
    const snapshot = serverDraftRef.current.lastSnapshot;
    if (snapshot) queueDraftServerSync(snapshot);
  }

  function persistDraftDocumentHistorySnapshot(scope: DraftCacheScope, snapshot: DraftHistorySnapshot) {
    // A save can finish after this workspace unmounts. Merge the newest disk
    // entries before writing so that response cannot erase a newer workspace's
    // drafts, while failed in-memory writes remain available for recovery.
    const merged = new Map(loadDraftDocumentHistory(scope).map((item) => [item.id, item]));
    for (const item of documentHistoryRef.current) {
      const stored = merged.get(item.id);
      if (!stored || Date.parse(item.updatedAt) > Date.parse(stored.updatedAt)) merged.set(item.id, item);
    }
    const previous = merged.get(snapshot.id ?? "");
    if (snapshot.serverSavePending && previous?.serverSavePending && previous.cacheWriterId &&
      previous.cacheWriterId !== draftCacheWriterId) {
      // Keep a recoverable copy before this tab explicitly saves new edits
      // over an entry another tab still owns.
      const recovery: DraftDocumentHistoryItem = {
        ...previous,
        id: `recovery-${previous.id}-${previous.updatedAt}`,
        title: `${previous.title} (local copy)`,
        summary: "Local edits preserved from another draft session",
        serverId: null,
        serverRevision: null,
        serverContentStale: false,
        serverSavePending: false,
      };
      merged.set(recovery.id, recovery);
    }
    if (snapshot.serverSavePending) snapshot = { ...snapshot, cacheWriterId: draftCacheWriterId };
    const nextHistory = upsertDraftDocumentHistory([...merged.values()], snapshot);
    // Retain failed writes in this mounted workspace so retries and exports
    // still have the content even when browser storage is unavailable.
    documentHistoryRef.current = nextHistory;
    lastDraftHistoryWriteSucceededRef.current = saveDraftDocumentHistory(scope, nextHistory);
    return nextHistory;
  }

  /** Explicit conflict resolution: load the server copy into the editor. The
   * unsent local content is first preserved as its own "Local only" history
   * entry so nothing is silently lost. */
  /** Opens one saved account draft fully loaded — the search-hit pathway.
   * Fetches the canonical server copy, persists it into the history cache,
   * and hydrates the editor; a failed fetch reports honestly via status. */
  async function openServerDraftById(serverId: string) {
    const requestId = ++draftOpenRequestRef.current;
    setStatus("Loading your saved draft…");
    try {
      const snapshot = await getDraft(completionUserId, serverId, { tenantSlug: draftTenantSlug });
      if (requestId !== draftOpenRequestRef.current) return;
      const opened: DraftDocumentHistoryItem = {
        id: `server-${snapshot.document.id}`,
        title: snapshot.document.title,
        summary: "Opened from search",
        sourceLabel: "Account draft",
        content: snapshot.revision.content,
        updatedAt: snapshot.document.updated_at,
        status: "complete",
        serverId: snapshot.document.id,
        serverRevision: snapshot.document.current_revision,
        serverContentStale: false,
      };
      const nextHistory = persistDraftDocumentHistorySnapshot(draftScope, opened);
      setDocumentHistory(nextHistory);
      requestDraftNavigation(`open ${opened.title}`, () => {
        hydrateDocumentHistoryItem(opened);
        window.setTimeout(() => editorRef.current?.focus(), 0);
      });
    } catch (error) {
      setStatus(
        `This draft could not be loaded from your account (${draftErrorText(error)}). Try again once the connection recovers.`,
      );
    }
  }

  // Search-hit navigation: the workspace mounts fresh (keyed remount) with
  // the requested server draft id and loads that document immediately.
  useEffect(() => {
    if (!initialServerDraftId) return;
    void openServerDraftById(initialServerDraftId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-scoped open request
  }, [initialServerDraftId]);

  async function reloadServerDraftCopy(serverId: string) {
    const requestId = ++draftOpenRequestRef.current;
    const binding = serverDraftRef.current;
    try {
      const snapshot = await getDraft(completionUserId, serverId, { tenantSlug: draftTenantSlug });
      if (requestId !== draftOpenRequestRef.current || serverDraftRef.current !== binding) return;
      const localContent = contentRef.current;
      if (localContent && localContent !== snapshot.revision.content) {
        persistDraftDocumentHistorySnapshot(draftScope, {
          id: `${slugify(documentTitle)}-local-${Date.now()}`,
          title: `${documentTitle.trim() || EMPTY_DOCUMENT_TITLE} (local copy)`,
          content: localContent,
          summary: "Local copy preserved before reloading the server draft",
          sourceLabel: activeSourceLabel,
          serverId: null,
          serverRevision: null,
        });
        if (!lastDraftHistoryWriteSucceededRef.current) {
          setServerSaveState({
            kind: "conflict",
            serverId,
            message: "The server copy was not opened because browser storage could not preserve your local edits. Export your changes before reloading.",
          });
          return;
        }
      }
      const restoredItem: DraftDocumentHistoryItem = {
        id: `server-${snapshot.document.id}`,
        title: snapshot.document.title,
        summary: "Reloaded from your account",
        sourceLabel: "Account draft",
        content: snapshot.revision.content,
        updatedAt: snapshot.document.updated_at,
        status: "complete",
        serverId: snapshot.document.id,
        serverRevision: snapshot.document.current_revision,
        serverContentStale: false,
      };
      const nextHistory = persistDraftDocumentHistorySnapshot(draftScope, restoredItem);
      setDocumentHistory(nextHistory);
      hydrateDocumentHistoryItem(restoredItem);
      setServerSaveState({ kind: "idle" });
    } catch (error) {
      if (requestId !== draftOpenRequestRef.current || serverDraftRef.current !== binding) return;
      setServerSaveState({
        kind: "conflict",
        serverId,
        message: `Could not reload the server copy (${draftErrorText(error)}).`,
      });
    }
  }

  async function previewHistoryItem(item: DraftDocumentHistoryItem) {
    const html = item.serverId && (!item.content || item.serverContentStale)
      ? (await getDraft(completionUserId, item.serverId, { tenantSlug: draftTenantSlug })).revision.content
      : item.content;
    const parsed = parseSlideDeck(html);
    return parsed.ok ? markdownOutlineFromDeck(parsed.deck).slice(0, 700) : documentHtmlToText(sanitizeDocumentHtml(html)).slice(0, 700) || "This draft has no content yet.";
  }

  async function changeHistoryItem(item: DraftDocumentHistoryItem, remove: boolean) {
    if (historyBusyId || item.status === "running" || item.serverSavePending || assistantWorking) return;
    setHistoryBusyId(item.id);
    try {
      if (item.serverId) {
        const revision = item.serverRevision ?? item.serverListedRevision;
        if (!revision) throw new Error("Reopen the draft before changing history.");
        if (remove) await deleteDraft(completionUserId, item.serverId, revision, { tenantSlug: draftTenantSlug });
        else await archiveDraft(completionUserId, item.serverId, revision, !item.archived, { tenantSlug: draftTenantSlug });
      }
      const next = remove
        ? documentHistoryRef.current.filter(entry => entry.id !== item.id && (!item.serverId || entry.serverId !== item.serverId))
        : documentHistoryRef.current.map(entry => entry.id === item.id || (item.serverId && entry.serverId === item.serverId) ? { ...entry, archived: !item.archived } : entry);
      if (!item.serverId && !saveScopedDraftCache(draftScope, next)) {
        setStatus("Browser storage could not save the history change. Please retry.");
        return;
      }
      historyMutationGenerationRef.current += 1;
      if (!saveDraftDocumentHistory(draftScope, next)) {
        setStatus(item.serverId ? "Account updated, but browser history could not be updated. Reload to refresh it." : "Browser storage could not save the history change. Please retry.");
        return;
      }
      documentHistoryRef.current = next;
      setDocumentHistory(next);
      if (remove && serverDraftRef.current.historyId === item.id) {
        serverDraftRef.current = { id: null, revision: null, historyId: createDraftHistoryId() };
        setActiveHistoryItemId(null);
        setSavedDocumentTitle("");
        setServerSaveState({ kind: "local-only", message: "The account draft was deleted. Save a version to keep this working copy as a new draft." });
      }
      if (remove && deckHistoryIdRef.current === item.id) {
        deckHistoryIdRef.current = createDraftHistoryId();
        setSavedDocumentTitle("");
      }
      setHistoryDeleteTarget(null);
      setStatus(remove ? "Draft deleted from history. The open editor remains available as a working copy." : item.archived ? "Draft returned to history." : "Draft archived. Open Archived to restore it.");
    } catch (error) {
      setStatus(isDraftConflictError(error) ? "This draft changed elsewhere. Reopen it before changing its history." : "Could not update draft history. Your draft was kept; please retry.");
    } finally { setHistoryBusyId(null); }
  }

  /** Explicit, per-entry legacy import. Runs only after the user has seen the
   * quarantine scope copy and confirmed the exact account it uploads into. */
  async function importLegacyDraftToAccount(item: DraftDocumentHistoryItem) {
    setLegacyImportBusyId(item.id);
    try {
      const snapshot = await createDraft(
        completionUserId,
        { title: item.title.trim() || EMPTY_DOCUMENT_TITLE, content: item.content },
        { tenantSlug: draftTenantSlug },
      );
      const imported: DraftDocumentHistoryItem = {
        ...item,
        id: `server-${snapshot.document.id}`,
        summary: `Imported from this browser's legacy drafts`,
        sourceLabel: "Imported legacy draft",
        updatedAt: snapshot.document.updated_at,
        status: "complete",
        serverId: snapshot.document.id,
        serverRevision: snapshot.document.current_revision,
        serverContentStale: false,
      };
      const nextHistory = persistDraftDocumentHistorySnapshot(draftScope, imported);
      setDocumentHistory(nextHistory);
      removeLegacyDraftHistoryEntry(item.id);
      setLegacyDraftHistory(loadLegacyDraftHistory(isDraftDocumentHistoryItem));
      setStatus(`${imported.title} imported into your account drafts.`);
    } catch (error) {
      setStatus(
        `Legacy import failed (${draftErrorText(error)}). The draft stays on this device only.`,
      );
    } finally {
      setLegacyImportBusyId(null);
      setLegacyImportConfirmId(null);
    }
  }

  function hydrateDocumentHistoryItem(
    item: DraftDocumentHistoryItem,
    options?: { fromLiveUpdate?: boolean },
  ) {
    clearDraftTimers();
    const status = item.status ?? "complete";
    const executedAt = item.completedAt || item.updatedAt || draftNowIso();
    // Deck snapshots restore through the deck validator, never innerHTML.
    if (contentLooksLikeDeck(item.content)) {
      const parsed = parseSlideDeck(item.content);
      if (!parsed.ok) {
        setStatus(`This saved deck could not be restored: ${parsed.error}`);
        return;
      }
      serverDraftRef.current = { id: null, revision: null, historyId: createDraftHistoryId() };
      deckHistoryIdRef.current = item.id;
      setServerSaveState({ kind: "idle" });
      const restoredVersion: DraftVersion = {
        id: "version-1",
        label: "Version 1",
        time: draftTimeLabel(executedAt),
        executedAt,
        content: serializeSlideDeck(parsed.deck),
        summary: `Restored from history: ${item.summary}`,
        format: "deck",
      };
      setActiveHistoryItemId(null);
      setDocumentTitle(item.title);
      setSavedDocumentTitle(item.title);
      setContent("");
      clearEditHistory();
      setDeckState(parsed.deck);
      setSelectedSlideId(parsed.deck.slides[0]?.id ?? null);
      setDeckUndoStack([]);
      setDeckRedoStack([]);
      deckEditSessionUndoRef.current = null;
      setDraftKind("deck");
      setVersions([restoredVersion]);
      setSelectedVersionId(restoredVersion.id);
      setEvents(item.events ?? []);
      setCodeArtifact(null);
      setShowEdits(false);
      setActiveAssistantTool((current) => (options?.fromLiveUpdate ? current : null));
      setStatus(`${item.title} restored from history in the deck editor.`);
      return;
    }
    // Stored HTML (scoped cache, legacy history, or a server revision) is
    // never reinstated through innerHTML without the same allowlist
    // sanitization the print/redline surfaces already enforce.
    const safeContent = sanitizeDocumentHtml(item.content);
    const bindingKey = `${scopedDraftCacheKey(draftScope)}:${item.id}`;
    const existingBinding = draftServerBindings.get(bindingKey);
    serverDraftRef.current = existingBinding ?? {
      id: item.serverId ?? null,
      revision: item.serverRevision ?? null,
      historyId: item.id,
    };
    if (existingBinding && !item.serverSavePending) {
      existingBinding.id = item.serverId ?? existingBinding.id;
      existingBinding.revision = item.serverRevision ?? existingBinding.revision;
    }
    draftServerBindings.set(bindingKey, serverDraftRef.current);
    if (item.serverSavePending && !serverDraftRef.current.lastSnapshot) {
      serverDraftRef.current.lastSnapshot = {
        historyId: item.id,
        title: item.title,
        content: item.content,
        summary: item.summary,
        sourceLabel: item.sourceLabel,
        storedLocally: true,
      };
    }
    setServerSaveState(item.serverSavePending
      ? { kind: "local-only", message: "This version is kept on this device; its account save has not completed." }
      : { kind: "idle" });
    const restoredVersion: DraftVersion = {
      id: "version-1",
      label: "Version 1",
      time: draftTimeLabel(executedAt),
      executedAt,
      content: safeContent,
      summary:
        status === "running"
          ? `In-progress draft: ${item.summary}`
          : status === "failed"
            ? `Draft run needs attention: ${item.summary}`
            : `Restored from history: ${item.summary}`,
    };
    setActiveHistoryItemId(status === "running" ? item.id : null);
    setDocumentTitle(item.title);
    setSavedDocumentTitle(item.title);
    setContent(safeContent);
    clearEditHistory();
    setDraftKind("document");
    setDeckState(null);
    setSelectedSlideId(null);
    setDeckUndoStack([]);
    setDeckRedoStack([]);
    deckEditSessionUndoRef.current = null;
    setVersions([restoredVersion]);
    setSelectedVersionId(restoredVersion.id);
    setEvents(item.events ?? []);
    setCodeArtifact(null);
    setShowEdits(false);
    setActiveAssistantTool((current) => (options?.fromLiveUpdate ? current : null));
    setStatus(
      options?.fromLiveUpdate
        ? `${item.title} finished in the background and is now loaded.`
        : status === "running"
          ? `${item.title} is still drafting in the background. You can keep working or open another draft.`
          : status === "failed"
            ? `${item.title} did not finish. Reopen the request details or start a new draft.`
            : `${item.title} restored from document history.`,
    );
  }

  async function restoreDocumentHistoryItem(item: DraftDocumentHistoryItem) {
    const requestId = ++draftOpenRequestRef.current;
    // Server wins at a higher revision: entries whose server copy advanced
    // (or that only exist as server stubs) fetch the recoverable HTML first.
    if (item.serverId && !item.serverSavePending && (item.serverContentStale || !item.content)) {
      try {
        const snapshot = await getDraft(completionUserId, item.serverId, {
          tenantSlug: draftTenantSlug,
        });
        if (requestId !== draftOpenRequestRef.current) return;
        const refreshed: DraftDocumentHistoryItem = {
          ...item,
          title: snapshot.document.title,
          content: snapshot.revision.content,
          updatedAt: snapshot.document.updated_at,
          status: "complete",
          serverRevision: snapshot.document.current_revision,
          serverContentStale: false,
        };
        const nextHistory = persistDraftDocumentHistorySnapshot(draftScope, refreshed);
        setDocumentHistory(nextHistory);
        requestDraftNavigation(`open ${refreshed.title}`, () => {
          hydrateDocumentHistoryItem(refreshed);
          window.setTimeout(() => editorRef.current?.focus(), 0);
        });
        return;
      } catch (error) {
        if (requestId !== draftOpenRequestRef.current) return;
        if (!item.content) {
          setStatus(
            `This draft is stored in your account but could not be loaded (${draftErrorText(error)}). Try again once the connection recovers.`,
          );
          return;
        }
        setStatus(
          "Showing the copy stored on this device — the newer server copy could not be loaded.",
        );
      }
    }
    requestDraftNavigation(`open ${item.title}`, () => {
      hydrateDocumentHistoryItem(item);
      window.setTimeout(() => editorRef.current?.focus(), 0);
    });
  }

  function draftContextOptions(
    sourceSummaryForDraft = sourceSummary,
    options?: Partial<Pick<DraftContextOptions, "useTemplateContext" | "useWebSearch">>,
  ): DraftContextOptions {
    return {
      primarySourceName: sourceSummaryForDraft.primarySourceName,
      agentName: selectedAgent?.name ?? "Manual editing",
      useWebSearch: options?.useWebSearch ?? webSearchEnabled,
      useWorkspaceSources: sourceSummaryForDraft.activeKnowledge.length > 0,
      useTemplateContext: options?.useTemplateContext ?? templateContextEnabled,
    };
  }

  async function startDraftFromTemplate(
    template: DraftTemplate,
    request?: string,
    sourceSummaryForDraft = sourceSummary,
    sourceIdsForDraft: string[] = activeSourceIds,
    options?: Partial<Pick<DraftContextOptions, "useTemplateContext" | "useWebSearch">>,
  ) {
    if (!selectedAgent) { setStatus(draftAiUnavailableReason); return; }
    const useWebSearch = options?.useWebSearch ?? webSearchEnabled;
    if (useWebSearch && !webSearchAvailable) {
      setStatus("Web search is turned off for this model by your workspace configuration.");
      return;
    }
    await startProviderDraftFromTemplate(
      template,
      request,
      sourceSummaryForDraft,
      sourceIdsForDraft,
      {
        useTemplateContext: options?.useTemplateContext ?? true,
        useWebSearch,
      },
    );
  }

  function applyTemplateToCurrentDraft(template: DraftTemplate) {
    clearDraftTimers();
    if (template.sourceHtml) {
      applyUploadedWordTemplate(
        {
          filename: template.sourceFilename ?? `${template.name}.docx`,
          title: template.name,
          html: template.sourceHtml,
          text: template.body,
          warnings: [],
        },
        { persist: false, templateId: template.id },
      );
      return;
    }
    const currentDraftText = documentHtmlToText(content);
    setSelectedTemplateId(template.id);
    setTemplateContextEnabled(true);
    if (!currentDraftText.trim()) {
      setStatus(`${template.name} selected. Create a draft or add content to apply this template.`);
      return;
    }

    const formattedDraft = formatExistingDraftWithTemplate(
      template,
      documentTitle,
      currentDraftText,
      draftContextOptions(sourceSummary, { useTemplateContext: true }),
    );
    const nextContentHtml = formattedDraft.html ?? textToDocumentHtml(formattedDraft.content);
    const nextVersionNumber = versions.length + 1;
    const executedAt = draftNowIso();
    const nextVersion: DraftVersion = {
      id: `version-${nextVersionNumber}`,
      label: `Version ${nextVersionNumber}`,
      time: draftTimeLabel(executedAt),
      executedAt,
      content: nextContentHtml,
      summary: formattedDraft.summary,
    };
    setDocumentTitle(formattedDraft.title ?? documentTitle);
    recordUndoSnapshot();
    setContent(nextContentHtml);
    setVersions((current) => [...current, nextVersion]);
    setSelectedVersionId(nextVersion.id);
    setRequireCitations(formattedDraft.requiresCitations ?? template.requiresCitations);
    setCodeArtifact(null);
    setShowEdits(true);
    setStatus(`${template.name} applied to the current draft.`);
    rememberDocumentSnapshot(
      formattedDraft.title ?? documentTitle,
      nextContentHtml,
      formattedDraft.summary,
    );
    setEvents((current) => [
      ...current,
      draftEvent(
        "assistant",
        "template-format",
        `Applied the ${template.name} template to the current document without replacing the draft content.`,
        { createdAt: executedAt, executedAt },
      ),
    ]);
    setAttachMenuOpen(false);
    setExportMenuOpen(false);
    setInsertMenuOpen(false);
    window.setTimeout(() => editorRef.current?.focus(), 0);
  }

  async function startProviderDraftFromTemplate(
    template: DraftTemplate,
    request?: string,
    sourceSummaryForDraft = sourceSummary,
    sourceIdsForDraft: string[] = activeSourceIds,
    options?: Partial<Pick<DraftContextOptions, "useTemplateContext" | "useWebSearch">>,
  ) {
    if (!selectedAgent) { setStatus(draftAiUnavailableReason); return; }
    clearDraftTimers();
    // Stage provider-created documents transactionally. Keep the current
    // editor, versions, and server binding visible until the replacement has
    // completed successfully; a slow or failed request must never blank a
    // populated draft merely because the user asked for a new artifact.
    const sourceHtmlBeforeDraft = contentRef.current;
    const contextOptions = draftContextOptions(sourceSummaryForDraft, options);
    const liveWebSearch = contextOptions.useWebSearch;
    const requestText = request?.trim() || `Create a complete ${template.name} draft from the selected template.`;
    const requestSubject = request ? extractDraftSubject(request) : null;
    const nextTitle = requestSubject ? providerWebDraftTitle(template, requestSubject) : template.defaultTitle;
    const requestedPages = Math.max(1, parseRequestedPageCount(requestText));
    const pageTotal = requestedPages > 1 ? requestedPages : 1;
    const visualRequested = hasVisualRequest(requestText);
    const traceSteps = draftAgentTraceSteps({
      agentName: selectedAgent.name,
      pageTotal,
      primarySourceName: sourceSummaryForDraft.primarySourceName,
      request: requestText,
      useWebSearch: liveWebSearch,
      useWorkspaceSources: contextOptions.useWorkspaceSources,
      visualRequested,
      workspaceSourceCount: sourceSummaryForDraft.activeKnowledge.length,
    });
    const requestStartedAt = draftNowIso();
    const historyItemId = createDraftHistoryRunId(nextTitle, requestStartedAt);
    const historySourceLabel =
      sourceSummaryForDraft.activeKnowledge.length === 1
        ? sourceSummaryForDraft.activeKnowledge[0].name
        : sourceSummaryForDraft.activeKnowledge.length > 1
          ? `${sourceSummaryForDraft.activeKnowledge.length} workspace sources`
          : NO_WORKSPACE_SOURCE_LABEL;
    const userEvent = draftEvent("user", "user", requestText, {
      createdAt: requestStartedAt,
    });
    const runningSummary = liveWebSearch
      ? `Drafting with provider web search through ${selectedAgent.name}`
      : `Drafting with ${selectedAgent.name}`;
    // Running placeholders stay cache-only — the server never stores a fake
    // "drafting" state it cannot honestly resume. The current document keeps
    // its server binding until the new draft has passed every response check.
    liveDraftRunIds.add(historyItemId);
    const runningHistory = persistDraftDocumentHistorySnapshot(draftScope, {
      id: historyItemId,
      title: nextTitle,
      content: "",
      summary: runningSummary,
      sourceLabel: historySourceLabel,
      status: "running",
      createdAt: requestStartedAt,
      updatedAt: requestStartedAt,
      request: requestText,
      events: [userEvent],
    });

    setActiveHistoryItemId(historyItemId);
    setDocumentHistory(runningHistory);
    setSelectedTemplateId(template.id);
    setRequireCitations(liveWebSearch || template.requiresCitations);
    setCodeArtifact(null);
    setShowEdits(false);
    setStatus(
      liveWebSearch
        ? `Routing live web-search draft to ${selectedAgent.name}.`
        : `Routing live draft to ${selectedAgent.name}.`,
    );
    setInstruction("");
    setActiveAssistantTool(null);
    setAttachMenuOpen(false);
    setExportMenuOpen(false);
    setInsertMenuOpen(false);
    setEvents([userEvent]);
    setDraftTrace({
      steps: traceSteps,
      activeIndex: 0,
      complete: false,
      startedAt: Date.now(),
    });
    pageScrollRef.current?.scrollTo?.({ top: 0, behavior: "auto" });

    try {
      advanceDraftTrace("context");
      setStatus(
        liveWebSearch
          ? "Calling provider-hosted public web search before drafting."
          : "Calling the selected drafting model before writing.",
      );
      const reply = await sendChat(completionUserId, {
        model: selectedAgent.id,
        messages: [
          {
            role: "user",
            content: providerDraftPrompt(template, requestText, contextOptions),
          },
        ],
        runtime: {
          surface: "draft",
          draftTitle: nextTitle,
          clientStartedAt: requestStartedAt,
          webEnabled: liveWebSearch,
          citationsEnabled: true,
          knowledgeConfigIds: sourceIdsForDraft,
          maxCompletionTokens: pageTotal > 1 ? 24000 : 12000,
          reasoningEffort: reasoningEffortForSend,
        },
      });
      advanceDraftTrace("generate");
      const markdownWithSources = appendWebCitationList(reply.content, reply.citations);
      if (contentRef.current !== sourceHtmlBeforeDraft) {
        throw new Error(
          "The document changed while the assistant was working, so the new draft was not substituted. Submit the request again from the current version.",
        );
      }
      let nextContentHtml = paginateTransferredDocumentHtml(
        formatMlaDocument(documentHtmlFromMarkdown(markdownWithSources), requestText),
        `${requestText}\n\n${reply.content}`,
      );
      if (!isAutomatedTestMode()) {
        nextContentHtml =
          (await repaginateOverfullDocumentPages(nextContentHtml)) ?? nextContentHtml;
      }
      const completedAt = draftNowIso();
      const durationMs = timestampDifferenceMs(requestStartedAt, completedAt);
      const finalVersion: DraftVersion = {
        id: "version-1",
        label: "Version 1",
        time: draftTimeLabel(completedAt),
        executedAt: completedAt,
        content: nextContentHtml,
        summary: `${liveWebSearch ? "Drafted with provider web search" : "Drafted with selected model"}${
          reply.citations.length
            ? ` and ${reply.citations.length} citation${reply.citations.length === 1 ? "" : "s"}`
          : ""
        }`,
      };
      const assistantCompletionEvent = assistantEvent(
        liveWebSearch ? "provider-web-draft" : "provider-draft",
        `${liveWebSearch ? "Provider web search" : "Provider drafting"} completed through ${selectedAgent.name}; ${reply.citations.length} citation${
          reply.citations.length === 1 ? "" : "s"
        } returned.`,
        { createdAt: completedAt, executedAt: requestStartedAt, durationMs },
      );
      liveDraftRunIds.delete(historyItemId);
      const completedHistory = persistDraftDocumentHistorySnapshot(draftScope, {
        id: historyItemId,
        title: nextTitle,
        content: nextContentHtml,
        summary: finalVersion.summary,
        sourceLabel: historySourceLabel,
        status: "complete",
        createdAt: requestStartedAt,
        completedAt,
        updatedAt: completedAt,
        request: requestText,
        events: [userEvent, assistantCompletionEvent],
      });
      // Establish the new identity before enqueuing; older saves retain their
      // own binding even if they finish after this replacement is displayed.
      serverDraftRef.current = { id: null, revision: null, historyId: historyItemId };
      queueDraftServerSync({
        historyId: historyItemId,
        title: nextTitle,
        content: nextContentHtml,
        summary: finalVersion.summary,
        sourceLabel: historySourceLabel,
      });
      // The staged draft is now complete. Only at this point does it become a
      // new document with a new server identity and version chain.
      setServerSaveState({ kind: "idle" });
      setDocumentTitle(nextTitle);
      setSavedDocumentTitle(nextTitle);
      clearEditHistory();
      setContent(nextContentHtml);
      setVersions([finalVersion]);
      setSelectedVersionId(finalVersion.id);
      setPageCount(Math.max(1, countDocumentPages(nextContentHtml) || pageTotal));
      setCurrentPage(1);
      setStatus(
        liveWebSearch
          ? `${nextTitle} drafted with provider-hosted web search.`
          : `${nextTitle} drafted with the selected model.`,
      );
      setDocumentHistory(completedHistory);
      setActiveHistoryItemId(null);
      setEvents([userEvent, assistantCompletionEvent]);
      setDraftTrace({
        steps: traceSteps,
        activeIndex: traceSteps.length,
        complete: true,
        startedAt: Date.now(),
      });
      window.setTimeout(() => {
        editorRef.current?.focus();
        updatePageMetrics();
      }, 0);
    } catch (error) {
      const message =
        error instanceof ChatRequestError
          ? error.message
          : liveWebSearch
            ? "The provider web-search request failed before a draft was returned."
            : "The provider drafting request failed before a draft was returned.";
      const failedAt = draftNowIso();
      const failureEvent = draftEvent("system", "provider-draft-error", `No local draft was substituted. ${message}`, {
        createdAt: failedAt,
        executedAt: requestStartedAt,
        durationMs: timestampDifferenceMs(requestStartedAt, failedAt),
      });
      liveDraftRunIds.delete(historyItemId);
      const failedHistory = persistDraftDocumentHistorySnapshot(draftScope, {
        id: historyItemId,
        title: nextTitle,
        content: "",
        summary: message,
        sourceLabel: historySourceLabel,
        status: "failed",
        createdAt: requestStartedAt,
        completedAt: failedAt,
        updatedAt: failedAt,
        request: requestText,
        events: [userEvent, failureEvent],
      });
      setStatus(`${liveWebSearch ? "Provider web search" : "Provider drafting"} could not complete: ${message}`);
      setDocumentHistory(failedHistory);
      setActiveHistoryItemId(null);
      setEvents([userEvent, failureEvent]);
      setDraftTrace(null);
    }
  }

  function saveManualVersion() {
    if (draftKind === "deck") {
      endDeckEditSession();
      const editedDeck = flushDeckTextEdits();
      if (!editedDeck) return;
      const deck = { ...editedDeck, title: documentTitle.trim() || EMPTY_DOCUMENT_TITLE };
      const serialized = serializeSlideDeck(deck);
      if (selectedVersion && selectedVersion.content === serialized && documentTitle.trim() === savedDocumentTitle.trim()) {
        setStatus("Current version already matches the deck.");
        return;
      }
      const nextVersion = appendDeckVersion(deck, "Manual deck edit snapshot");
      setDeckState(deck);
      setStatus(`${nextVersion.label} saved from deck edits.`);
      rememberDeckSnapshot(documentTitle, serialized, nextVersion.summary);
      return;
    }
    if (!hasUnsavedEdits) {
      setStatus("Current version already matches the editor.");
      return;
    }
    const nextVersionNumber = versions.length + 1;
    const executedAt = draftNowIso();
    const nextVersion: DraftVersion = {
      id: `version-${nextVersionNumber}`,
      label: `Version ${nextVersionNumber}`,
      time: draftTimeLabel(executedAt),
      executedAt,
      content,
      summary: "Manual edit snapshot",
    };
    setVersions((current) => [...current, nextVersion]);
    setSelectedVersionId(nextVersion.id);
    setStatus(`${nextVersion.label} saved from manual edits.`);
    rememberDocumentSnapshot(documentTitle, content, nextVersion.summary);
  }

  async function applyProviderRevision(
    request: string,
    sourceSummaryForRevision = sourceSummary,
    sourceIdsForRevision: string[] = activeSourceIds,
  ) {
    if (!selectedAgent) { setStatus(draftAiUnavailableReason); return; }
    if (revisionInFlightRef.current) {
      setStatus("The document assistant is already revising this draft.");
      return;
    }
    const useWebSearch = webSearchEnabled && revisionNeedsWebSearch(request);
    if (useWebSearch && !webSearchAvailable) {
      setStatus("Web search is turned off for this model by your workspace configuration.");
      return;
    }
    const sourceHtml = contentRef.current;
    const revisionSnapshot = documentHtmlToRevisionSnapshot(sourceHtml);
    const currentDraftText = revisionSnapshot.markdown;
    const requestedAdditionalPages = parseRequestedAdditionalPageCount(request);
    const originalPageCount = Math.max(1, countDocumentPages(sourceHtml) || pageCount);
    // A revision follows the selected template only when the user asks for
    // it; routine edits must not be steered by a template in the background.
    const revisionTemplate =
      templateContextEnabled && selectedTemplate && revisionReferencesTemplate(request, selectedTemplate)
        ? selectedTemplate
        : undefined;
    const contextOptions = draftContextOptions(sourceSummaryForRevision, {
      useTemplateContext: Boolean(revisionTemplate),
      useWebSearch,
    });
    const requestStartedAt = draftNowIso();
    const revisionBinding = serverDraftRef.current;
    const historyItemId = revisionBinding.historyId;
    const userEvent = draftEvent("user", "user", request, { createdAt: requestStartedAt });
    const pendingEvent = assistantEvent(
      "provider-revision-working",
      requestedAdditionalPages
        ? `Expanding the current document by ${requestedAdditionalPages} page${requestedAdditionalPages === 1 ? "" : "s"} through ${selectedAgent.name}.`
        : `Revising the current document through ${selectedAgent.name}.`,
      { createdAt: requestStartedAt, executedAt: requestStartedAt },
    );
    const priorEvents = events;
    const runningEvents = [...priorEvents, userEvent, pendingEvent];
    const traceSteps: DraftTraceStep[] = [
      {
        id: "revise",
        label: requestedAdditionalPages ? "Expanding current document" : "Revising current document",
        detail: requestedAdditionalPages
          ? `Adding at least ${requestedAdditionalPages} complete page${requestedAdditionalPages === 1 ? "" : "s"} without replacing the existing draft.`
          : "Applying the requested change to the existing draft.",
      },
      {
        id: "protect",
        label: "Preserving document structure",
        detail: `Protecting ${revisionSnapshot.assets.filter((asset) => asset.kind === "image").length} image${revisionSnapshot.assets.filter((asset) => asset.kind === "image").length === 1 ? "" : "s"} and ${revisionSnapshot.assets.filter((asset) => asset.kind === "link").length} hyperlink${revisionSnapshot.assets.filter((asset) => asset.kind === "link").length === 1 ? "" : "s"}.`,
      },
      {
        id: "finalize",
        label: "Finalizing revised version",
        detail: "Checking requested scope, repaginating the document, and preparing the next saved version.",
      },
    ];

    revisionInFlightRef.current = true;
    setInstruction("");
    setDraftTrace({ steps: traceSteps, activeIndex: 0, complete: false, startedAt: Date.now() });
    setStatus(
      contextOptions.useWebSearch
        ? `Calling provider-hosted public web search to revise ${documentTitle}.`
        : `Calling ${selectedAgent.name} to revise ${documentTitle}.`,
    );
    setEvents(runningEvents);
    liveDraftRunIds.add(historyItemId);
    const runningHistory = persistDraftDocumentHistorySnapshot(draftScope, {
      id: historyItemId,
      title: documentTitle,
      content: sourceHtml,
      summary: `Revising with ${selectedAgent.name}`,
      sourceLabel: activeSourceLabel,
      status: "running",
      createdAt: requestStartedAt,
      updatedAt: requestStartedAt,
      request,
      events: runningEvents,
    });
    setDocumentHistory(runningHistory);
    try {
      const reply = await sendChat(completionUserId, {
        model: selectedAgent.id,
        messages: [
          {
            role: "user",
            content: providerRevisionPrompt(
              documentTitle,
              currentDraftText,
              request,
              contextOptions,
              revisionTemplate,
            ),
          },
        ],
        runtime: {
          surface: "draft",
          draftTitle: documentTitle,
          clientStartedAt: requestStartedAt,
          webEnabled: contextOptions.useWebSearch,
          citationsEnabled: true,
          knowledgeConfigIds: sourceIdsForRevision,
          maxCompletionTokens: revisionCompletionTokenBudget(
            currentDraftText,
            requestedAdditionalPages,
          ),
          reasoningEffort: reasoningEffortForSend,
        },
      });
      if (contentRef.current !== sourceHtml || serverDraftRef.current !== revisionBinding) {
        throw new Error(
          "The document changed while the assistant was working, so the returned revision was not applied. Submit the instruction again from the current version.",
        );
      }
      advanceDraftTrace("protect");
      const revisedMarkdown = appendWebCitationList(reply.content, reply.citations);
      const missingAssets = missingProtectedRevisionAssets(
        revisionSnapshot.assets,
        revisedMarkdown,
        request,
      );
      if (missingAssets.length > 0) {
        throw new Error(
          `The drafting agent removed ${missingAssets.length} protected image or hyperlink reference${
            missingAssets.length === 1 ? "" : "s"
          }. The current document was left unchanged.`,
        );
      }
      const preservationIssue = revisionContentPreservationIssue(
        currentDraftText,
        revisedMarkdown,
        request,
      );
      if (preservationIssue) {
        throw new Error(`${preservationIssue} The current document was left unchanged.`);
      }
      const restoredRevisionHtml = restoreRevisionAssetsInHtml(
        documentHtmlFromMarkdown(revisedMarkdown),
        revisionSnapshot.assets,
      );
      let revisedHtml = paginateTransferredDocumentHtml(
        formatMlaDocument(restoredRevisionHtml, `${request} ${sourceHtml.includes("document-mla-text") ? "MLA" : ""}`),
        `${documentTitle}\n\n${reply.content}`,
      );
      if (!isAutomatedTestMode()) {
        revisedHtml = (await repaginateOverfullDocumentPages(revisedHtml)) ?? revisedHtml;
      }
      const revisedPageCount = Math.max(1, countDocumentPages(revisedHtml));
      if (
        requestedAdditionalPages > 0 &&
        revisedPageCount < originalPageCount + requestedAdditionalPages
      ) {
        throw new Error(
          `The drafting agent returned ${revisedPageCount} pages, but this request requires at least ${originalPageCount + requestedAdditionalPages}. The current document was left unchanged.`,
        );
      }
      advanceDraftTrace("finalize");
      const nextVersionNumber = versions.length + 1;
      const completedAt = draftNowIso();
      const durationMs = timestampDifferenceMs(requestStartedAt, completedAt);
      const nextVersion: DraftVersion = {
        id: `version-${nextVersionNumber}`,
        label: `Version ${nextVersionNumber}`,
        time: draftTimeLabel(completedAt),
        executedAt: completedAt,
        content: revisedHtml,
        summary: `Provider revision through ${selectedAgent.name}`,
      };
      const completionEvent = assistantEvent(
        "provider-revision",
        requestedAdditionalPages
          ? `Expanded the document by ${revisedPageCount - originalPageCount} page${revisedPageCount - originalPageCount === 1 ? "" : "s"} through ${selectedAgent.name}.`
          : `Provider revision completed through ${selectedAgent.name}; ${reply.citations.length} citation${reply.citations.length === 1 ? "" : "s"} returned.`,
        { createdAt: completedAt, executedAt: requestStartedAt, durationMs },
      );
      const completedEvents = [...priorEvents, userEvent, completionEvent];
      const completedHistory = persistDraftDocumentHistorySnapshot(draftScope, {
        id: historyItemId,
        title: documentTitle,
        content: revisedHtml,
        summary: nextVersion.summary,
        sourceLabel: activeSourceLabel,
        status: "complete",
        createdAt: requestStartedAt,
        completedAt,
        updatedAt: completedAt,
        request,
        events: completedEvents,
        serverId: revisionBinding.id,
        serverRevision: revisionBinding.revision,
        serverSavePending: true,
      });
      queueDraftServerSync({
        historyId: historyItemId,
        title: documentTitle,
        content: revisedHtml,
        summary: nextVersion.summary,
        sourceLabel: activeSourceLabel,
      }, revisionBinding);
      recordUndoSnapshot();
      setSavedDocumentTitle(documentTitle);
      setContent(revisedHtml);
      setCodeArtifact(null);
      setVersions((current) => [...current, nextVersion]);
      setSelectedVersionId(nextVersion.id);
      setShowEdits(true);
      setStatus(`${nextVersion.label} applied from provider revision.`);
      setDocumentHistory(completedHistory);
      setEvents(completedEvents);
      setDraftTrace({
        steps: traceSteps,
        activeIndex: traceSteps.length,
        complete: true,
        startedAt: Date.now(),
      });
      window.setTimeout(() => editorRef.current?.focus(), 0);
    } catch (error) {
      const message =
        error instanceof ChatRequestError || error instanceof Error
          ? error.message
          : "The provider revision request failed before revised text was returned.";
      const failedAt = draftNowIso();
      const failureEvent = draftEvent(
        "system",
        "provider-revision-error",
        `No revision was applied. ${message}`,
        {
          createdAt: failedAt,
          executedAt: requestStartedAt,
          durationMs: timestampDifferenceMs(requestStartedAt, failedAt),
        },
      );
      const failedEvents = [...priorEvents, userEvent, failureEvent];
      const failedHistory = persistDraftDocumentHistorySnapshot(draftScope, {
        id: historyItemId,
        title: documentTitle,
        content: serverDraftRef.current === revisionBinding
          ? contentRef.current
          : documentHistoryRef.current.find((item) => item.id === historyItemId)?.content ?? sourceHtml,
        summary: message,
        sourceLabel: activeSourceLabel,
        status: "failed",
        createdAt: requestStartedAt,
        completedAt: failedAt,
        updatedAt: failedAt,
        request,
        events: failedEvents,
      });
      setStatus(`Provider revision could not complete: ${message}`);
      setDocumentHistory(failedHistory);
      setEvents(failedEvents);
      setDraftTrace(null);
    } finally {
      liveDraftRunIds.delete(historyItemId);
      revisionInFlightRef.current = false;
    }
  }

  async function submitInstruction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Keep the prompt intact if model access disappears while it is being composed.
    if (!selectedAgent) { setStatus(draftAiUnavailableReason); return; }
    const request = instruction.trim();
    if (!request) return;
    if (draftKind === "deck") {
      if (assistantWorking || revisionInFlightRef.current) {
        setStatus("The deck assistant is already working on the current request.");
        return;
      }
      await runDeckAssistantRequest(request);
      return;
    }
    if (assistantWorking || revisionInFlightRef.current) {
      setStatus("The document assistant is already working on the current request.");
      return;
    }
    if (isImageInsertRequest(request) && !isDraftCreationRequest(request)) {
      const requestStartedAt = draftNowIso();
      setInstruction("");
      setEvents((current) => [
        ...current,
        draftEvent("user", "user", request, { createdAt: requestStartedAt }),
      ]);
      await insertWebImageForRequest(request, requestStartedAt);
      return;
    }
    const explicitlyRequestedSourceIds = requestedKnowledgeSourceIds(data, request);
    const sourceIdsForRequest =
      activeSourceIds.length > 0 ? activeSourceIds : explicitlyRequestedSourceIds;
    const sourceSummaryForRequest = documentSourceSummary(data, sourceIdsForRequest);
    if (explicitlyRequestedSourceIds.length > 0 && activeSourceIds.length === 0) {
      setActiveSourceIds(explicitlyRequestedSourceIds);
    }
    const templatesForRequest = templateContextEnabled
      ? draftTemplates
      : BUILT_IN_DRAFT_TEMPLATES;
    const fallbackTemplate = templateContextEnabled
      ? selectedTemplate
      : BUILT_IN_DRAFT_TEMPLATES.find((template) => template.id === "writing-research-paper") ??
        BUILT_IN_DRAFT_TEMPLATES[0];
    const requestedTemplate = templateForInstruction(
      templatesForRequest,
      request,
      fallbackTemplate,
    );
    const hasExistingDocument = documentHasSubstantiveContent(contentRef.current);
    if (
      isDraftCreationRequest(request) &&
      requestedTemplate &&
      (!hasExistingDocument || isExplicitDraftReplacementRequest(request))
    ) {
      if (webSearchEnabled) {
        if (!webSearchAvailable) {
          setStatus("Web search is turned off for this model by your workspace configuration.");
          return;
        }
      }
      await startProviderDraftFromTemplate(
        requestedTemplate,
        request,
        sourceSummaryForRequest,
        sourceIdsForRequest,
        {
          useTemplateContext: templateContextEnabled,
          useWebSearch: webSearchEnabled,
        },
      );
      return;
    }
    await applyProviderRevision(request, sourceSummaryForRequest, sourceIdsForRequest);
  }

  /** Entry point for the export panel buttons. An export or print must
   * contain what the editor shows; with unsaved manual edits it stops and
   * says so instead of silently proceeding, and the notice offers a
   * one-click save + export. */
  function requestExport(action: ExportAction) {
    if (exportInFlightRef.current) return;
    if (hasUnsavedEdits) {
      setPendingSaveExportFormat(action);
      setStatus("Save a version first so the export matches your latest edits.");
      return;
    }
    setPendingSaveExportFormat(null);
    if (action === "print") {
      // The gate above guarantees `content` equals the selected saved
      // version, so the print surface renders the exact saved snapshot.
      void handlePrintExport(content);
      return;
    }
    void handleExport(action);
  }

  function saveVersionAndExport() {
    const action = pendingSaveExportFormat;
    if (!action || exportInFlightRef.current) return;
    if (hasUnsavedEdits) saveManualVersion();
    setPendingSaveExportFormat(null);
    if (action === "print") {
      // saveManualVersion snapshots the current `content`, so this prints the
      // version that was just saved.
      void handlePrintExport(content);
      return;
    }
    void handleExport(action);
  }

  /** Opens the browser print dialog on a print-only render of the saved
   * version. The user chooses "Save as PDF" in that dialog; the app never
   * claims to have produced a PDF file itself. */
  async function handlePrintExport(printHtml: string) {
    if (exportInFlightRef.current) return;
    exportInFlightRef.current = true;
    setPrintPreparing(true);
    setPrintNotice(null);
    setStatus("Preparing the print view of the saved version...");
    try {
      const outcome = await printSavedDraftVersion({
        title: documentTitle.trim() || "Draft",
        contentHtml: printHtml,
      });
      if (outcome.ok) {
        const text =
          'Print dialog opened. Choose "Save as PDF" in the browser dialog to keep a PDF copy.';
        setPrintNotice({ kind: "status", text });
        setStatus(text);
      } else {
        setPrintNotice({ kind: "error", text: outcome.error });
        setStatus(outcome.error);
      }
    } catch {
      const text = "Could not prepare the print view. The draft is unchanged.";
      setPrintNotice({ kind: "error", text });
      setStatus(text);
    } finally {
      exportInFlightRef.current = false;
      setPrintPreparing(false);
    }
  }

  /** Opens the read-only Visual redline. Defaults to the two most recent
   * saved versions; the base/comparison choice is the user's, with no legal
   * original/revised implication. */
  function openVersionCompare() {
    if (!canCompareVersions || versions.length < 2) return;
    compareReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCompareBaseId(versions[versions.length - 2].id);
    setCompareComparisonId(versions[versions.length - 1].id);
    setRedlineChangeCursor(-1);
    redlineChangeRefs.current = new Map();
    setCompareOpen(true);
  }

  /** Closing the comparison changes nothing in the draft and returns focus to
   * the control that opened it. */
  function closeVersionCompare() {
    setCompareOpen(false);
    setRedlineChangeCursor(-1);
    redlineChangeRefs.current = new Map();
    const returnTarget = compareReturnFocusRef.current;
    compareReturnFocusRef.current = null;
    if (returnTarget && document.contains(returnTarget)) returnTarget.focus();
  }

  function selectCompareVersion(kind: "base" | "comparison", versionId: string) {
    if (kind === "base") setCompareBaseId(versionId);
    else setCompareComparisonId(versionId);
    setRedlineChangeCursor(-1);
    redlineChangeRefs.current = new Map();
  }

  function stepRedlineChange(direction: 1 | -1) {
    if (!redlineChangeCount) return;
    const next =
      redlineChangeCursor < 0
        ? direction === 1
          ? 0
          : redlineChangeCount - 1
        : (redlineChangeCursor + direction + redlineChangeCount) % redlineChangeCount;
    setRedlineChangeCursor(next);
    const target = redlineChangeRefs.current.get(next);
    if (target) {
      if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "center" });
      target.focus();
    }
  }

  async function handleExport(format: ExportFormat, delivery?: ExportDelivery) {
    if (exportInFlightRef.current) return;
    const exportDeck = draftKind === "deck" ? flushDeckTextEdits() : null;
    if (draftKind === "deck" && !exportDeck) {
      setStatus("There is no deck to export yet.");
      return;
    }
    const plainText = exportDeck
      ? markdownOutlineFromDeck(exportDeck)
      : exportDocumentBody(content.includes("document-mla-text") ? "" : documentTitle, documentHtmlToText(content));
    const normalizedTitle = documentTitle.trim() || "Draft";
    const descriptor = exportFileDescriptor(format, { codeArtifact, normalizedTitle });
    if (!descriptor) {
      setStatus("No generated code file is available to export.");
      return;
    }
    const preferredDelivery = delivery ?? (canUseFileSavePicker() ? exportDelivery : "download");
    const versionIdAtExport = selectedVersionId;
    const buildCurrentExport = async () => {
      let exportHtml = content;
      if (
        format === "word" &&
        !isAutomatedTestMode() &&
        countDocumentPages(content) &&
        normalizedLayoutHtmlRef.current !== content
      ) {
        const rebalanced = await repaginateOverfullDocumentPages(content);
        if (rebalanced) {
          exportHtml = rebalanced;
          applyRebalancedLayout(content, rebalanced, versionIdAtExport);
        } else {
          normalizedLayoutHtmlRef.current = content;
        }
      }
      return buildExportBlob(format, {
        codeArtifact,
        contentHtml: exportHtml,
        normalizedTitle,
        plainText,
        deck: exportDeck,
        imageProxy: cachedExportImageDataUrl,
        onExportWarnings: (exportWarnings) =>
          setEvents((current) => [
            ...current,
            ...exportWarnings.map((warning) =>
              draftEvent("system", "deck-export-warning", `Export note: ${warning}`),
            ),
          ]),
      });
    };

    exportInFlightRef.current = true;
    setExportingFormat(format);
    try {
      if (preferredDelivery === "picker" && canUseFileSavePicker()) {
        // Open the save dialog immediately, while the click's user activation
        // is still fresh. Embedding images can take several seconds, and a
        // dialog requested after that wait is silently blocked by the browser
        // — which used to look like the download simply not working.
        let handle: ExportSaveHandle | null = null;
        try {
          handle = await openExportSaveHandle(descriptor);
        } catch (error) {
          if (isFilePickerAbort(error)) {
            setStatus("Export canceled.");
            return;
          }
          handle = null;
        }
        if (handle) {
          setStatus(`Preparing ${descriptor.filename}...`);
          const blob = await buildCurrentExport();
          if (!blob) {
            setStatus("No generated code file is available to export.");
            return;
          }
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          setStatus(`Saved ${descriptor.filename} to your selected location.`);
          rememberExportReceipt({ ...descriptor, blob }, "picker");
          return;
        }
      }

      setStatus(`Preparing ${descriptor.filename}...`);
      const blob = await buildCurrentExport();
      if (!blob) {
        setStatus("No generated code file is available to export.");
        return;
      }
      const exportFile: ExportFile = { ...descriptor, blob };
      const retainedHref = downloadBlob(exportFile, setStatus);
      rememberExportReceipt(exportFile, "download", retainedHref);
    } catch {
      setStatus(`Could not export ${descriptor.filename}. Try again from the export menu.`);
    } finally {
      exportInFlightRef.current = false;
      setExportingFormat(null);
    }
  }

  function rememberExportReceipt(exportFile: ExportFile, delivery: ExportDelivery, href?: string) {
    if (exportObjectUrlRef.current && exportObjectUrlRef.current !== href) {
      revokeRetainedExportUrl(exportObjectUrlRef.current);
    }
    exportObjectUrlRef.current = href ?? null;
    setLastExport({
      filename: exportFile.filename,
      label: exportFile.label,
      delivery,
      href,
    });
  }

  function copyDocument() {
    void copyToClipboard(
      exportDocumentBody(content.includes("document-mla-text") ? "" : documentTitle, documentHtmlToText(content)),
      "Document",
    );
  }

  async function copyToClipboard(text: string, label: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setStatus(`${label} copied to clipboard.`);
    } catch {
      setStatus("Could not access the clipboard. Allow clipboard access or export the content instead.");
    }
  }

  function triggerAttachFiles() {
    setAttachMenuOpen(false);
    fileInputRef.current?.click();
  }

  function triggerWordTemplateUpload() {
    setAttachMenuOpen(false);
    wordTemplateInputRef.current?.click();
  }

  function handleAttachFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    setAttachMenuOpen(false);
    setAttachedFiles((current) => [
      ...current,
      ...files.map((file) => ({
        id: `${file.name}-${file.lastModified}-${file.size}`,
        name: file.name,
        size: formatBytes(file.size),
      })),
    ]);
    setActiveAssistantTool("sources");
    setStatus(
      `Attached ${files.length} draft source${files.length === 1 ? "" : "s"} for this document.`,
    );
    event.target.value = "";
  }

  async function handleWordTemplateUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setActiveAssistantTool("templates");
    setTemplateContextEnabled(true);
    setStatus(`Reading ${file.name} as a Word template...`);
    try {
      const uploadedTemplate = await readUploadedWordTemplate(file);
      applyUploadedWordTemplate(uploadedTemplate);
    } catch {
      setStatus(`Could not read ${file.name}. Upload a .docx, .doc, .html, or .txt template.`);
    } finally {
      event.target.value = "";
    }
  }

  function rememberUploadedWordTemplate(uploadedTemplate: UploadedWordTemplate) {
    const persistedTemplate = persistedWordTemplateFromUpload(uploadedTemplate);
    setUploadedWordTemplates((current) => {
      const nextTemplates = upsertPersistedWordTemplate(current, persistedTemplate);
      if (!savePersistedWordTemplates(nextTemplates)) {
        // The template still works for this session; say so rather than let the
        // user discover on reload that it was never kept.
        setStatus(
          `${persistedTemplate.name} is available for this session, but browser storage is full so it will not be remembered after a reload.`,
        );
      }
      return nextTemplates;
    });
    return persistedTemplate.id;
  }

  function applyUploadedWordTemplate(
    uploadedTemplate: UploadedWordTemplate,
    options?: { persist?: boolean; templateId?: string },
  ) {
    clearDraftTimers();
    const shouldPersistTemplate = options?.persist !== false;
    const selectedUploadedTemplateId =
      options?.templateId ?? (shouldPersistTemplate ? rememberUploadedWordTemplate(uploadedTemplate) : undefined);
    const currentDraftText = documentHtmlToText(content);
    const hasCurrentDraft = Boolean(currentDraftText.trim());
    // Imported templates go through the same pagination pipeline as
    // generated drafts so the canvas shows real Word-style pages and the
    // DOCX/print round trip keeps the template's explicit page breaks.
    const nextContentHtml = paginateTransferredDocumentHtml(
      hasCurrentDraft
        ? conformCurrentDocumentToUploadedTemplate(
            uploadedTemplate.html,
            currentDraftText,
          )
        : uploadedTemplate.html,
      "",
      { forceMarkerPages: true },
    );
    const nextTitle = hasCurrentDraft
      ? `${documentTitle.trim() || "Draft"} - ${uploadedTemplate.title}`
      : uploadedTemplate.title;
    const nextVersionNumber = hasCurrentDraft ? versions.length + 1 : 1;
    const nextSummary = hasCurrentDraft
      ? `${uploadedTemplate.filename} uploaded template applied to current draft`
      : `${uploadedTemplate.filename} uploaded template added to canvas`;
    const executedAt = draftNowIso();
    const nextVersion: DraftVersion = {
      id: `version-${nextVersionNumber}`,
      label: `Version ${nextVersionNumber}`,
      time: draftTimeLabel(executedAt),
      executedAt,
      content: nextContentHtml,
      summary: nextSummary,
    };

    if (selectedUploadedTemplateId) {
      setSelectedTemplateId(selectedUploadedTemplateId);
      setTemplateCategory("Uploaded");
    }
    setTemplateContextEnabled(true);
    setDocumentTitle(nextTitle);
    if (hasCurrentDraft) {
      recordUndoSnapshot();
    } else {
      clearEditHistory();
    }
    setContent(nextContentHtml);
    setVersions((current) => (hasCurrentDraft ? [...current, nextVersion] : [nextVersion]));
    setSelectedVersionId(nextVersion.id);
    setRequireCitations(false);
    setCodeArtifact(null);
    setShowEdits(hasCurrentDraft);
    setStatus(
      hasCurrentDraft
        ? `${uploadedTemplate.filename}${
            shouldPersistTemplate ? " saved to templates and" : ""
          } applied to the current draft.`
        : `${uploadedTemplate.filename}${
            shouldPersistTemplate ? " saved to templates and" : ""
          } added to the canvas.`,
    );
    rememberDocumentSnapshot(nextTitle, nextContentHtml, nextSummary);
    setEvents((current) => [
      ...current,
      draftEvent(
        "assistant",
        "word-template",
        hasCurrentDraft
          ? `${shouldPersistTemplate ? "Saved and applied" : "Applied"} ${uploadedTemplate.filename} as a Word template without removing the current draft content.`
          : `${shouldPersistTemplate ? "Saved and added" : "Added"} ${uploadedTemplate.filename} as a Word template on the blank canvas.`,
        { createdAt: executedAt, executedAt },
      ),
    ]);
    if (uploadedTemplate.warnings.length > 0) {
      const notedWarnings = uploadedTemplate.warnings.slice(0, 3).join(" | ");
      const extraWarningCount = uploadedTemplate.warnings.length - 3;
      setEvents((current) => [
        ...current,
        draftEvent(
          "system",
          "word-template-warning",
          `Template import note${uploadedTemplate.warnings.length === 1 ? "" : "s"}: ${notedWarnings}${
            extraWarningCount > 0 ? ` (+${extraWarningCount} more)` : ""
          }`,
        ),
      ]);
    }
    window.setTimeout(() => editorRef.current?.focus(), 0);
  }

  function attachConnectorSource(connector: DraftConnectorOption) {
    const matchingSources = data.knowledgeBases.filter(
      (source) =>
        source.enabled && connector.connectorIds.includes(source.connector_id),
    );
    setAttachMenuOpen(false);
    setActiveAssistantTool("sources");

    if (matchingSources.length > 0) {
      setActiveSourceIds((current) =>
        Array.from(
          new Set([...current, ...matchingSources.map((source) => source.id)]),
        ),
      );
      setStatus(
        `${connector.label} source${matchingSources.length === 1 ? "" : "s"} added to this draft context.`,
      );
      return;
    }

    const enabledConnector = data.connectors.some(
      (item) =>
        item.tenant_enabled && connector.connectorIds.includes(item.id),
    );
    setStatus(
      enabledConnector
        ? `${connector.label} is connected. Add an indexed knowledge source to use it in this draft.`
        : `${connector.label} needs connector setup before it can be used for drafting.`,
    );
  }

  function toggleSource(sourceId: string, checked: boolean) {
    setActiveSourceIds((current) =>
      checked
        ? Array.from(new Set([...current, sourceId]))
        : current.filter((id) => id !== sourceId),
    );
    const sourceName =
      data.knowledgeBases.find((source) => source.id === sourceId)?.name ?? "Source";
    setStatus(`${sourceName} ${checked ? "included in" : "removed from"} this draft context.`);
  }

  function clearEditHistory() {
    setUndoStack([]);
    setRedoStack([]);
  }

  function recordUndoSnapshot(snapshot = editorRef.current?.innerHTML ?? content) {
    setUndoStack((current) => {
      if (current[current.length - 1] === snapshot) return current;
      return [...current.slice(-79), snapshot];
    });
    setRedoStack([]);
  }

  function undoDocumentChange() {
    if (!undoStack.length) {
      setStatus("No document edit to undo.");
      return;
    }
    const previousHtml = undoStack[undoStack.length - 1];
    const currentHtml = editorRef.current?.innerHTML ?? content;
    setUndoStack(undoStack.slice(0, -1));
    setRedoStack((current) =>
      current[0] === currentHtml ? current : [currentHtml, ...current].slice(0, 80),
    );
    setContent(previousHtml);
    setShowEdits(true);
    setStatus("Undo applied.");
    window.setTimeout(() => editorRef.current?.focus(), 0);
  }

  function redoDocumentChange() {
    if (!redoStack.length) {
      setStatus("No document edit to redo.");
      return;
    }
    const nextHtml = redoStack[0];
    const currentHtml = editorRef.current?.innerHTML ?? content;
    setRedoStack(redoStack.slice(1));
    setUndoStack((current) =>
      current[current.length - 1] === currentHtml
        ? current
        : [...current.slice(-79), currentHtml],
    );
    setContent(nextHtml);
    setShowEdits(true);
    setStatus("Redo applied.");
    window.setTimeout(() => editorRef.current?.focus(), 0);
  }

  function applyMlaLayout() {
    const original = editorRef.current?.innerHTML ?? content;
    const root = document.createElement("template");
    root.innerHTML = original;
    mergeSplitContinuationBlocks(root.content);
    root.content.querySelectorAll(".document-page-label").forEach(node => node.remove());
    root.content.querySelectorAll("section.document-page").forEach(node => node.replaceWith(...Array.from(node.childNodes)));
    recordUndoSnapshot(original);
    setContent(paginateTransferredDocumentHtml(formatMlaDocument(sanitizeDocumentHtml(root.innerHTML), "MLA"), "MLA"));
    setStatus("MLA layout applied: double spacing, 12-point Times New Roman, and a centered title. Save a version to keep it.");
  }

  function commitEditorHtml(label: string) {
    const editor = editorRef.current;
    if (!editor) return;
    // Convert legacy execCommand output (font tags, transparent highlight
    // wrappers) into the inline markup the sanitizer and exports preserve.
    normalizeEditorInlineMarkup(editor);
    skipNextEditorSyncRef.current = true;
    setContent(editor.innerHTML);
    setStatus(label);
    refreshFormatState();
  }

  function runEditorCommand(command: string, label: string, value?: string) {
    const editor = editorRef.current;
    if (!editor) return;
    focusEditorPreservingSelection(editor);
    recordUndoSnapshot(editor.innerHTML);
    if (command === "insertHTML" && value) {
      insertHtmlAtSelection(editor, value);
      commitEditorHtml(label);
      return;
    }
    if (typeof document.execCommand === "function") {
      try {
        const applied = document.execCommand(command, false, value);
        if (applied) {
          commitEditorHtml(label);
          return;
        }
      } catch {
        // Fall through to the direct DOM fallback used by non-browser test runtimes.
      }
    }
    applyEditorCommandFallback(editor, command, value);
    commitEditorHtml(label);
  }

  function applyTextColor(color: string) {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return;
    setTextColor(color);
    if (draftKind === "deck") {
      runDeckTextCommand("foreColor", "Text color applied.", color);
      return;
    }
    runEditorCommand("foreColor", "Text color applied.", color);
  }

  function applyBlockStyle(style: string) {
    const labels: Record<string, string> = {
      p: "Paragraph",
      h1: "Title",
      h2: "Heading",
      h3: "Subheading",
      blockquote: "Quote",
    };
    const tagName = labels[style] ? style : "p";
    runEditorCommand("formatBlock", `${labels[tagName]} formatting applied.`, tagName);
  }

  function applyAlignment(align: DocumentAlignment) {
    const control = ALIGNMENT_CONTROLS.find((item) => item.value === align);
    if (!control) return;
    runEditorCommand(control.command, `${control.label} applied.`);
  }

  function applyHighlight(color: string | null) {
    runEditorCommand(
      "hiliteColor",
      color ? "Highlight applied to the selected text." : "Highlight removed from the selected text.",
      color ?? "transparent",
    );
  }

  function applyFontSize(value: string) {
    const size = DOCUMENT_FONT_SIZES.find((item) => item.value === value);
    const editor = editorRef.current;
    if (!size || !editor) return;
    focusEditorPreservingSelection(editor);
    recordUndoSnapshot(editor.innerHTML);
    if (!applySelectionInlineStyle(editor, "font-size", size.px || null)) {
      setStatus("Select text in the document before changing its size.");
      return;
    }
    commitEditorHtml(
      size.px ? `Text size set to ${size.label}.` : "Text size reset to the block default.",
    );
  }

  function applyFontFamily(value: string) {
    const family = DRAFT_FONT_FAMILIES.find((item) => item.value === value);
    if (!family) return;
    if (draftKind === "deck") {
      applyDeckSelectionStyle(
        "font-family",
        family.css || null,
        family.css
          ? `Slide text font set to ${family.label}.`
          : "Slide text font reset to the theme default.",
      );
      return;
    }
    const editor = editorRef.current;
    if (!editor) return;
    focusEditorPreservingSelection(editor);
    recordUndoSnapshot(editor.innerHTML);
    if (!applySelectionInlineStyle(editor, "font-family", family.css || null)) {
      setStatus("Select text in the document before changing its font.");
      return;
    }
    commitEditorHtml(
      family.css ? `Text font set to ${family.label}.` : "Text font reset to the default.",
    );
  }

  function applyDeckFontSize(value: string) {
    const size = DECK_FONT_SIZES.find((item) => item.value === value);
    if (!size) return;
    applyDeckSelectionStyle(
      "font-size",
      size.px || null,
      size.px
        ? `Slide text size set to ${size.label}.`
        : "Slide text size reset to the layout default.",
    );
  }

  /** Applies one inline style to the highlighted slide text and round-trips
   * it through the deck model, exactly like runDeckTextCommand. */
  function applyDeckSelectionStyle(
    property: "font-size" | "font-family",
    cssValue: string | null,
    label: string,
  ) {
    const selection = window.getSelection?.();
    const entry = deckBlockEntryForNode(selection?.focusNode ?? selection?.anchorNode ?? null);
    if (!entry || !deckState) {
      setStatus("Click into slide text before formatting.");
      return;
    }
    const undoSnapshot = deckEditSessionUndoRef.current ?? serializedDeck;
    if (!applySelectionInlineStyle(entry.element, property, cssValue)) {
      setStatus("Highlight slide text first, then change its formatting.");
      return;
    }
    deckEditSessionUndoRef.current = null;
    const slide = deckState.slides.find((item) => item.id === entry.slideId);
    if (!slide) return;
    const updated = deckSlideWithRegionFromElement(slide, entry.region, entry.element, deckState.theme);
    commitDeck(
      {
        ...deckState,
        slides: deckState.slides.map((item) => (item.id === slide.id ? updated : item)),
      },
      label,
      undoSnapshot,
    );
  }

  function clearInlineFormatting() {
    runEditorCommand("removeFormat", "Formatting cleared from the selected text.");
  }

  function openLinkEditor() {
    closeInlineAiEdit();
    const editor = editorRef.current;
    const liveSelection = getEditorSelection(editor);
    const caret = getCollapsedEditorRange(editor);
    const anchorElement = closestEditorAnchor(
      liveSelection?.range.commonAncestorContainer ?? caret?.commonAncestorContainer ?? null,
      editor,
    );
    if (!liveSelection && !anchorElement) {
      linkEditRangeRef.current = null;
      setLinkEditState({
        ...EMPTY_LINK_EDIT_STATE,
        open: true,
        message: "Highlight the text you want to link, then choose Link again.",
      });
      setStatus("Highlight text before adding a link.");
      return;
    }
    if (liveSelection) {
      linkEditRangeRef.current = liveSelection.range;
    } else if (anchorElement) {
      const range = document.createRange();
      range.selectNodeContents(anchorElement);
      linkEditRangeRef.current = range;
    }
    setLinkEditState({
      open: true,
      url: anchorElement?.getAttribute("href") ?? "",
      message: null,
      error: null,
      hasExistingLink: Boolean(anchorElement),
    });
    setStatus(
      anchorElement
        ? "Editing the link under your cursor."
        : "Enter a web address for the highlighted text.",
    );
  }

  function closeLinkEditor() {
    linkEditRangeRef.current = null;
    setLinkEditState(EMPTY_LINK_EDIT_STATE);
  }

  function restoreLinkSelection() {
    const editor = editorRef.current;
    const range = linkEditRangeRef.current;
    if (!editor || !range || !isRangeInsideEditor(editor, range)) return false;
    const selection = window.getSelection?.();
    if (!selection) return false;
    editor.focus();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function applyLinkEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = normalizeLinkUrl(linkEditState.url);
    if (!url) {
      setLinkEditState((current) => ({
        ...current,
        error: "Enter a web address like https://example.com.",
      }));
      return;
    }
    if (!restoreLinkSelection()) {
      closeLinkEditor();
      setStatus("The linked text changed before the link could be applied. Highlight it again.");
      return;
    }
    runEditorCommand("createLink", "Link applied to the selected text.", url);
    closeLinkEditor();
  }

  function removeLinkEdit() {
    if (!restoreLinkSelection()) {
      closeLinkEditor();
      setStatus("The linked text changed before the link could be removed.");
      return;
    }
    runEditorCommand("unlink", "Link removed from the selected text.");
    closeLinkEditor();
  }

  function insertCitation() {
    const currentHtml = editorRef.current?.innerHTML ?? content;
    const citationIndex = countExistingCitations(currentHtml) + 1;
    const sourceName = sourceSummary.primarySourceName;
    const citationHtml = `<sup class="document-citation" contenteditable="false" data-source="${escapeHtml(sourceName)}">[${citationIndex}]</sup>`;
    runEditorCommand(
      "insertHTML",
      `Citation ${citationIndex} inserted from ${sourceName}.`,
      citationHtml,
    );
    setCitationsOpen(true);
  }

  function captureInlineAiSelection() {
    window.setTimeout(() => {
      const selection = getEditorSelection(editorRef.current);
      if (!selection) {
        setInlineAiSelectionOffer(null);
        return;
      }
      inlineEditRangeRef.current = selection.range;
      const rect =
        typeof selection.range.getBoundingClientRect === "function"
          ? selection.range.getBoundingClientRect()
          : null;
      const left = Math.max(
        12,
        Math.min(rect?.left ?? 24, Math.max(12, window.innerWidth - 132)),
      );
      const top = Math.max(12, Math.min((rect?.bottom ?? 64) + 8, window.innerHeight - 48));
      setInlineAiSelectionOffer({ text: selection.text, top, left });
    }, 0);
  }

  function handleEditorKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === "k"
    ) {
      // Word/Gmail-style shortcut for the link editor.
      event.preventDefault();
      openLinkEditor();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (!["Backspace", "Delete", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const editor = editorRef.current;
    const caret = getCollapsedEditorRange(editor);
    if (!editor || !caret) return;
    const page = closestDocumentPage(caret.startContainer, editor);
    if (!page) return;
    const blocks = editablePageBlocks(page);
    const currentBlock = closestPageBlock(caret.startContainer, page);
    if (!currentBlock || !blocks.length) return;

    const movingBackward = event.key === "Backspace" || event.key === "ArrowLeft";
    const boundaryBlock = movingBackward ? blocks[0] : blocks[blocks.length - 1];
    if (currentBlock !== boundaryBlock) return;
    const atBoundary = movingBackward
      ? isCaretAtBlockStart(currentBlock, caret)
      : isCaretAtBlockEnd(currentBlock, caret);
    if (!atBoundary) return;

    const siblingPage = movingBackward
      ? page.previousElementSibling
      : page.nextElementSibling;
    if (!(siblingPage instanceof HTMLElement) || !siblingPage.matches("section.document-page")) {
      return;
    }
    const siblingBlocks = editablePageBlocks(siblingPage);
    const siblingBlock = movingBackward
      ? siblingBlocks[siblingBlocks.length - 1]
      : siblingBlocks[0];
    if (!siblingBlock) return;

    event.preventDefault();
    setInlineAiSelectionOffer(null);
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      placeCaretAtEdge(siblingBlock, event.key === "ArrowRight");
      return;
    }

    recordUndoSnapshot(editor.innerHTML);
    normalizedLayoutHtmlRef.current = null;
    const destination = movingBackward ? siblingBlock : currentBlock;
    const source = movingBackward ? currentBlock : siblingBlock;
    const boundaryOffset = destination.childNodes.length;
    if (canMergeEditableBlocks(destination, source)) {
      while (source.firstChild) destination.appendChild(source.firstChild);
      source.remove();
      placeCaretAtChildOffset(destination, boundaryOffset);
    } else {
      if (movingBackward) siblingPage.appendChild(source);
      else page.appendChild(source);
      placeCaretAtEdge(source, movingBackward);
    }
    removeEmptyDocumentPage(page, editor);
    removeEmptyDocumentPage(siblingPage, editor);
    renumberDocumentPages(editor);
    commitEditorHtml("Page boundary removed. Continue editing normally.");
  }

  function openInlineAiEdit() {
    if (!selectedAgent) { setStatus(draftAiUnavailableReason); return; }
    closeLinkEditor();
    const liveSelection = getEditorSelection(editorRef.current);
    const savedRange = inlineEditRangeRef.current;
    const selection =
      liveSelection ??
      (inlineAiSelectionOffer && savedRange && editorRef.current && isRangeInsideEditor(editorRef.current, savedRange)
        ? { range: savedRange, text: inlineAiSelectionOffer.text }
        : null);
    if (!selection) {
      inlineEditRangeRef.current = null;
      setInlineEditState({
        open: true,
        message: "Highlight text in the document before using inline AI edit.",
        instruction: "",
        selectedText: "",
        working: false,
      });
      setStatus("Highlight text before using inline AI edit.");
      return;
    }

    inlineEditRangeRef.current = selection.range;
    setInlineAiSelectionOffer(null);
    setInlineEditState({
      open: true,
      message: null,
      instruction: "",
      selectedText: selection.text,
      working: false,
    });
    setStatus("Inline AI edit ready for the highlighted text.");
  }

  function closeInlineAiEdit() {
    inlineEditRangeRef.current = null;
    setInlineAiSelectionOffer(null);
    setInlineEditState(EMPTY_INLINE_AI_EDIT_STATE);
  }

  /** Glows the edits that just landed, then lets them settle. A second edit
   * inside the window restarts the clock so the whole batch fades together. */
  function glowFreshAiEdits() {
    if (aiEditGlowTimerRef.current !== null) window.clearTimeout(aiEditGlowTimerRef.current);
    setAiEditsFresh(true);
    aiEditGlowTimerRef.current = window.setTimeout(() => {
      aiEditGlowTimerRef.current = null;
      setAiEditsFresh(false);
    }, AI_EDIT_GLOW_MS);
  }

  /** Scrolls to a recorded edit and flashes it, so a trail entry points at
   * real text in the page rather than just describing it. */
  function revealAiEdit(entry: AiEditTrailEntry) {
    const editor = editorRef.current;
    const run = editor?.querySelectorAll<HTMLElement>("[data-ai-edit-at]")[entry.index];
    if (!run) {
      setStatus("That AI edit is no longer in the document.");
      return;
    }
    setAiTrailOpen(true);
    run.scrollIntoView({ block: "center", behavior: "smooth" });
    run.classList.add("is-ai-edit-flash");
    window.setTimeout(() => run.classList.remove("is-ai-edit-flash"), AI_EDIT_FLASH_MS);
  }

  /** Accepts every recorded AI edit: the text stays, the marks and their
   * provenance go. */
  function clearAiEditTrail() {
    const editor = editorRef.current;
    if (!editor) return;
    const runs = Array.from(editor.querySelectorAll<HTMLElement>("[data-ai-edit-at]"));
    if (!runs.length) return;
    recordUndoSnapshot(editor.innerHTML);
    runs.forEach((run) => {
      run.removeAttribute("data-ai-edit-at");
      run.removeAttribute("data-ai-edit-by");
      run.classList.remove("document-ai-suggestion");
      if (!run.classList.length) run.removeAttribute("class");
      // A bare span that only carried the mark is no longer doing anything.
      if (run.tagName === "SPAN" && !run.attributes.length) {
        const fragment = document.createDocumentFragment();
        while (run.firstChild) fragment.appendChild(run.firstChild);
        run.replaceWith(fragment);
      }
    });
    setAiTrailOpen(false);
    commitEditorHtml(
      `${runs.length} AI edit mark${runs.length === 1 ? "" : "s"} cleared. The text is unchanged.`,
    );
  }

  async function applyInlineAiEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedAgent) { setStatus(draftAiUnavailableReason); return; }
    const editor = editorRef.current;
    const range = inlineEditRangeRef.current;
    const instructionText = inlineEditState.instruction.trim();
    if (!editor || !range || !isRangeInsideEditor(editor, range)) {
      setInlineEditState({
        open: true,
        message: "Highlight text in the document before using inline AI edit.",
        instruction: "",
        selectedText: "",
        working: false,
      });
      setStatus("Highlight text before using inline AI edit.");
      return;
    }
    if (!instructionText) return;

    const requestStartedAt = draftNowIso();
    setInlineEditState((current) => ({ ...current, working: true }));
    setStatus(`Calling ${selectedAgent.name} to rewrite the highlighted text.`);

    try {
      const reply = await sendChat(completionUserId, {
        model: selectedAgent.id,
        messages: [
          {
            role: "user",
            content: inlineRewritePrompt({
              documentTitle,
              instruction: instructionText,
              selectedText: inlineEditState.selectedText,
              selectedHtml: inlineAiSelectionHtml(range),
              structureHint: inlineAiStructureHint(editor, range),
            }),
          },
        ],
        runtime: {
          surface: "draft",
          draftTitle: documentTitle,
          clientStartedAt: requestStartedAt,
          webEnabled: false,
          citationsEnabled: false,
          knowledgeConfigIds: activeSourceIds,
          maxCompletionTokens: 2000,
        },
      });
      const replacementHtml = inlineAiReplacementHtmlFromReply(reply.content);
      if (!replacementHtml) {
        throw new Error("The selected model did not return replacement text.");
      }
      if (!isRangeInsideEditor(editor, range)) {
        throw new Error("The highlighted text changed before the inline edit finished.");
      }

      recordUndoSnapshot(editor.innerHTML);
      const inserted = insertInlineAiSuggestion(editor, range, replacementHtml, {
        at: draftNowIso(),
        by: selectedAgent.name,
      });
      if (!inserted) {
        throw new Error("The selected model did not return replacement text.");
      }

      const selection = window.getSelection?.();
      if (selection) {
        const nextRange = document.createRange();
        nextRange.setStartAfter(inserted);
        nextRange.collapse(true);
        selection.removeAllRanges();
        selection.addRange(nextRange);
      }

      commitEditorHtml(`Inline AI edit applied through ${selectedAgent.name}.`);
      rememberDocumentSnapshot(documentTitle, editor.innerHTML, "Inline AI edit applied");
      setShowEdits(true);
      glowFreshAiEdits();
      closeInlineAiEdit();
      window.setTimeout(() => editorRef.current?.focus(), 0);
    } catch (error) {
      const message =
        error instanceof ChatRequestError
          ? error.message
          : error instanceof Error
            ? error.message
            : "The inline AI edit failed before a replacement was returned.";
      setInlineEditState((current) => ({
        ...current,
        open: true,
        message: `Inline AI edit could not complete: ${message}`,
        working: false,
      }));
      setStatus(`Inline AI edit could not complete: ${message}`);
    }
  }

  async function insertWebImageForRequest(request: string, requestStartedAt = draftNowIso()) {
    const subject = extractVisualSubject(request, documentTitle);
    const result = await resolveWebImageResult(subject);
    const imageHtml = webImageHtml(result, subject);
    runEditorCommand(
      "insertHTML",
      `Inserted web image for ${subject}.`,
      imageHtml,
    );
    const completedAt = draftNowIso();
    setEvents((current) => [
      ...current,
      draftEvent("assistant", "image", `Found and inserted a web image for ${subject}.`, {
        createdAt: completedAt,
        executedAt: requestStartedAt,
        durationMs: timestampDifferenceMs(requestStartedAt, completedAt),
      }),
    ]);
  }

  async function insertVisual(kind: "web-image" | "chart" | "table" | "divider" | "page-break") {
    setInsertMenuOpen(false);
    if (kind === "web-image") {
      await insertWebImageForRequest(`Add a picture about ${documentTitle}`);
      return;
    }
    if (kind === "chart") {
      runEditorCommand("insertHTML", "Chart inserted.", sampleChartHtml());
      return;
    }
    if (kind === "table") {
      runEditorCommand("insertHTML", "Table inserted.", sampleTableHtml());
      return;
    }
    if (kind === "divider") {
      runEditorCommand("insertHTML", "Divider inserted.", "<hr>");
      return;
    }
    insertPageBreak();
  }

  function insertPageBreak() {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    recordUndoSnapshot(editor.innerHTML);
    insertHtmlAtSelection(editor, '<hr class="document-page-break">');
    const splitIntoPages = normalizeManualPageBreaks(editor);
    commitEditorHtml(
      splitIntoPages
        ? "Page break inserted. The content after the break now starts on a new page."
        : "Page break inserted.",
    );
  }

  function applyIndentChange(kind: RulerMarker, left: number, first: number, right: number) {
    if (kind === "right") {
      setIndentRight(Math.min(Math.max(right, 0), RULER_INDENT_MAX));
      return;
    }
    const nextLeft = Math.min(Math.max(left, 0), RULER_INDENT_MAX);
    // First-line offset is relative to the left indent; keep the marker on the page.
    const nextFirst = Math.min(Math.max(first, -nextLeft), RULER_INDENT_MAX);
    setIndentLeft(nextLeft);
    setIndentFirstLine(nextFirst);
  }

  function beginIndentDrag(event: ReactPointerEvent<HTMLButtonElement>, kind: RulerMarker) {
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is a nicety; dragging still works without it.
    }
    indentDragRef.current = {
      kind,
      startX: event.clientX,
      left: indentLeft,
      first: indentFirstLine,
      right: indentRight,
    };
  }

  function moveIndentDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = indentDragRef.current;
    if (!drag) return;
    const delta = event.clientX - drag.startX;
    if (drag.kind === "left") {
      applyIndentChange("left", drag.left + delta, drag.first, drag.right);
    } else if (drag.kind === "first") {
      applyIndentChange("first", drag.left, drag.first + delta, drag.right);
    } else {
      applyIndentChange("right", drag.left, drag.first, drag.right - delta);
    }
  }

  function endIndentDrag() {
    indentDragRef.current = null;
  }

  function nudgeIndent(event: ReactKeyboardEvent<HTMLButtonElement>, kind: RulerMarker) {
    let delta: number;
    if (event.key === "ArrowLeft") delta = -RULER_KEYBOARD_STEP;
    else if (event.key === "ArrowRight") delta = RULER_KEYBOARD_STEP;
    else if (event.key === "Home") delta = Number.NEGATIVE_INFINITY;
    else return;
    event.preventDefault();
    if (kind === "left") {
      applyIndentChange("left", delta === Number.NEGATIVE_INFINITY ? 0 : indentLeft + delta, indentFirstLine, indentRight);
    } else if (kind === "first") {
      applyIndentChange("first", indentLeft, delta === Number.NEGATIVE_INFINITY ? 0 : indentFirstLine + delta, indentRight);
    } else {
      applyIndentChange("right", indentLeft, indentFirstLine, delta === Number.NEGATIVE_INFINITY ? 0 : indentRight - delta);
    }
  }

  function selectTemplateCategory(category: string) {
    setTemplateCategory(category);
    const nextVisibleTemplates =
      category === "All"
        ? draftTemplates
        : draftTemplates.filter((template) => template.category === category);
    if (
      nextVisibleTemplates.length > 0 &&
      !nextVisibleTemplates.some((template) => template.id === selectedTemplateId)
    ) {
      setSelectedTemplateId(nextVisibleTemplates[0].id);
      setStatus(`${nextVisibleTemplates[0].name} selected for the next draft.`);
    }
  }

  return (
    <div
      className={`document-assistant-page ${railIsDrawer ? "rail-drawer-mode" : ""} ${
        railIsDrawer && railOpen ? "rail-drawer-open" : ""
      } ${draftKind === "deck" ? "is-deck-mode" : ""}`}
    >
      {historyDeleteTarget && (
        <div className="modal-backdrop">
          <section className="modal confirm-dialog" tabIndex={-1} ref={historyDeleteRef} role="dialog" aria-modal="true" aria-label="Delete draft">
            <h2>Delete {historyDeleteTarget.title}?</h2>
            <p>This removes this draft and its saved revisions from {historyDeleteTarget.serverId ? "your account and this browser" : "this browser"}. This cannot be undone. Archive it to keep it for later.</p>
            <button type="button" disabled={Boolean(historyBusyId)} onClick={() => setHistoryDeleteTarget(null)}>Cancel</button>
            <button type="button" disabled={Boolean(historyBusyId)} onClick={() => void changeHistoryItem(historyDeleteTarget, true)}>Delete draft</button>
          </section>
        </div>
      )}
      {pendingDraftNavigation && createPortal(
        <div className="modal-backdrop" role="presentation" onClick={() => setPendingDraftNavigation(null)}>
          <section
            ref={draftNavigationDialogRef}
            tabIndex={-1}
            className="modal confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Unsaved draft edits"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.altKey) return;
              if ((event.metaKey || event.ctrlKey) && (event.key === "k" || event.key === "K")) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
          >
            <h2>Keep your unsaved edits?</h2>
            <p>Before you {pendingDraftNavigation.label}, save a recovery copy in document history or discard these edits.</p>
            {draftNavigationError && <p role="alert">{draftNavigationError}</p>}
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setPendingDraftNavigation(null)}>Keep editing</button>
              <button type="button" className="secondary-button" onClick={() => continueDraftNavigation(false)}>Discard and continue</button>
              <button type="button" className="primary-button" onClick={() => continueDraftNavigation(true)}>Save copy and continue</button>
            </div>
          </section>
        </div>,
        document.body,
      )}
      {railIsDrawer && railOpen && (
        <button
          type="button"
          className="draft-rail-backdrop"
          aria-label="Close the document assistant"
          tabIndex={-1}
          inert={pendingDraftNavigation !== null}
          data-tooltip="Close the assistant panel and return to the document"
          onClick={() => setRailOpen(false)}
        />
      )}
      <section className="document-assistant-shell" aria-label="Draft editor">
        <aside
          ref={assistantRailRef}
          className={`document-assistant-rail ${railIsDrawer ? "is-drawer" : ""} ${
            railIsDrawer && railOpen ? "is-open" : ""
          }`}
          aria-label="Assistant workflow"
          role={railIsDrawer ? "dialog" : undefined}
          aria-modal={railIsDrawer && railOpen ? true : undefined}
          aria-hidden={(railIsDrawer && !railOpen) || pendingDraftNavigation !== null}
          inert={(railIsDrawer && !railOpen) || pendingDraftNavigation !== null}
          tabIndex={railIsDrawer ? -1 : undefined}
        >
          <header className="draft-assistant-header">
            <button
              className="icon-button"
              type="button"
              aria-label="Back to chat"
              data-tooltip="Leave the drafting workspace and go back to your chat"
              onClick={() => { if (onCloseDraft) requestDraftNavigation("return to chat", onCloseDraft); }}
            >
              <Home size={18} />
            </button>
            {railIsDrawer && (
              <button
                className="icon-button draft-rail-close"
                type="button"
                aria-label="Close the document assistant"
                data-tooltip="Collapse the assistant drawer to give the document full width"
                onClick={() => setRailOpen(false)}
              >
                <X size={18} />
              </button>
            )}
            <div className="draft-assistant-title">
              <span className="draft-agent-icon">
                {draftKind === "deck" ? <Presentation size={18} /> : <FileText size={18} />}
              </span>
              <div>
                <h1>{draftKind === "deck" ? "Deck Assistant" : "Document Assistant"}</h1>
                <small>
                  {workspaceName} {draftKind === "deck" ? "slide workspace" : "drafting workspace"}
                </small>
              </div>
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label="Document history"
              data-tooltip="Browse saved documents and versions you can restore"
              aria-pressed={activeAssistantTool === "history"}
              onClick={() => {
                setActiveAssistantTool((current) =>
                  current === "history" ? null : "history",
                );
                setStatus("Document history opened.");
              }}
            >
              <History size={18} />
            </button>
          </header>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="sr-only"
            aria-label="Attach draft source files"
            onChange={handleAttachFiles}
          />
          <input
            ref={wordTemplateInputRef}
            type="file"
            className="sr-only"
            accept=".docx,.doc,.dotx,.html,.htm,.txt,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword,text/html,text/plain"
            aria-label="Upload Word document template"
            onChange={(event) => void handleWordTemplateUpload(event)}
          />
          <input
            ref={deckBrandInputRef}
            type="file"
            className="sr-only"
            accept=".pptx,.potx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
            aria-label="Upload PowerPoint brand template"
            onChange={(event) => void handleDeckBrandUpload(event)}
          />
          <input
            ref={deckBackgroundInputRef}
            type="file"
            className="sr-only"
            accept="image/png,image/jpeg,image/webp"
            aria-label="Upload slide background image"
            onChange={(event) => void handleDeckBackgroundUpload(event)}
          />

          <section className="draft-context-strip" aria-label="Draft context">
            <BookOpen size={18} />
            <div>
              <strong>{contextStripTitle}</strong>
              <span>
                {contextStripDetail}
                {attachedFiles.length > 0
                  ? ` · ${attachedFiles.length} upload${attachedFiles.length === 1 ? "" : "s"}`
                  : ""}
                {` · ${webSearchEnabled ? "web on" : "web off"} · ${
                  templateContextEnabled ? "templates on" : "templates off"
                }`}
              </span>
            </div>
          </section>

          <section className="draft-activity-panel" aria-label="Draft assistant activity">
            <div className="draft-panel-heading">
              <strong>Draft chat</strong>
            </div>
            <div
              className={`draft-event-list ${events.length === 0 && !draftTrace ? "is-empty" : ""}`}
              aria-label="Assistant events"
            >
              {draftTrace && (
                <DraftWorkTrace trace={draftTrace} workspaceName={workspaceName} />
              )}
              {events.map((event) => (
                <DraftEventRow event={event} key={event.id} />
              ))}
            </div>
          </section>

          {activeAssistantTool && (
            <section
              className={`draft-tool-drawer is-${activeAssistantTool}`}
              aria-label="Draft tool drawer"
            >
              <div className="draft-tool-drawer-header">
                <strong>
                  {activeAssistantTool === "templates"
                    ? "Templates"
                    : activeAssistantTool === "sources"
                      ? "Sources"
                      : activeAssistantTool === "settings"
                        ? "Agent settings"
                        : "Document history"}
                </strong>
                <button
                  type="button"
                  aria-label="Close draft tool drawer"
                  data-tooltip="Close this tool panel and return to the draft chat"
                  onClick={() => setActiveAssistantTool(null)}
                >
                  <X size={16} />
                </button>
              </div>

              {activeAssistantTool === "templates" && draftKind === "deck" && (
                <div className="draft-template-panel" aria-label="Deck templates">
                  <label className="draft-context-toggle">
                    <input
                      type="checkbox"
                      checked={templateContextEnabled}
                      onChange={(event) => toggleTemplateContext(event.target.checked)}
                    />
                    <span>
                      <strong>Use templates in chat</strong>
                      <small>
                        Off by default. Turn on to let the selected deck template guide the deck
                        assistant.
                      </small>
                    </span>
                  </label>
                  <div className="deck-theme-card" aria-label="Deck brand theme">
                    <div className="draft-panel-heading">
                      <strong>Brand theme</strong>
                      <small>
                        {deckBrandTheme
                          ? `Extracted from ${deckBrandTheme.filename}${
                              deckBrandTheme.slides.length
                                ? ` · ${deckBrandTheme.slides.length} slide${
                                    deckBrandTheme.slides.length === 1 ? "" : "s"
                                  } available`
                                : ""
                            }. Fonts render when installed.`
                          : "No brand theme. Slides use the neutral Aperture theme."}
                      </small>
                    </div>
                    {deckBrandTheme && (
                      <>
                        <div className="deck-theme-swatches" aria-label="Extracted brand colors">
                          {Object.values(deckBrandTheme.theme.colors).map((color, index) => (
                            <span
                              key={`${color}-${index}`}
                              className="deck-theme-dot"
                              style={{ background: color }}
                              title={color}
                            />
                          ))}
                          {deckBrandTheme.theme.logo && (
                            <img
                              className="deck-theme-logo"
                              src={deckBrandTheme.theme.logo.dataUrl}
                              alt={`${deckBrandTheme.name} logo`}
                            />
                          )}
                        </div>
                        <small className="deck-theme-fonts">
                          {deckBrandTheme.theme.fonts.major}
                          {deckBrandTheme.theme.fonts.minor !== deckBrandTheme.theme.fonts.major
                            ? ` · ${deckBrandTheme.theme.fonts.minor}`
                            : ""}
                          {deckBrandTheme.theme.backgroundImage ? " · background image" : ""}
                        </small>
                        <div className="deck-theme-actions">
                          <button
                            type="button"
                            aria-pressed={deckState?.theme.sourceLabel === deckBrandTheme.filename}
                            data-tooltip="Apply this brand's colors, fonts, logo, and background to the deck"
                            onClick={() =>
                              deckState?.theme.sourceLabel === deckBrandTheme.filename
                                ? removeDeckThemeFromDeck()
                                : applyDeckBrandTheme(deckBrandTheme)
                            }
                          >
                            {deckState?.theme.sourceLabel === deckBrandTheme.filename
                              ? "Applied — remove"
                              : "Apply to deck"}
                          </button>
                          {deckBrandTheme.slides.length > 0 && (
                            <button
                              type="button"
                              data-tooltip="Replace the current deck with every slide from the uploaded template, with its brand applied"
                              onClick={() => startDeckFromBrandTemplateSlides(deckBrandTheme)}
                            >
                              Load all {deckBrandTheme.slides.length} slides
                            </button>
                          )}
                          <button
                            type="button"
                            aria-label="Delete stored brand theme"
                            data-tooltip="Delete this stored brand theme from this device"
                            onClick={deleteStoredDeckBrandTheme}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                  <button
                    className="draft-template-upload-button"
                    type="button"
                    data-tooltip="Upload a .pptx or .potx brand template; colors, fonts, logo, and background are extracted on the server and stored only on this device"
                    disabled={deckBrandUploadState.kind === "working"}
                    onClick={triggerDeckBrandUpload}
                  >
                    <Upload size={16} />
                    <span>
                      <strong>
                        {deckBrandUploadState.kind === "working"
                          ? `Reading ${deckBrandUploadState.filename}…`
                          : "Upload brand template"}
                      </strong>
                      <small>
                        {deckBrandUploadState.kind === "error"
                          ? deckBrandUploadState.message
                          : ".pptx or .potx — brand colors, fonts, logo, and every slide's text are extracted."}
                      </small>
                    </span>
                  </button>
                  <div className="draft-template-list" aria-label="Deck starter templates">
                    {BUILT_IN_DECK_TEMPLATES.map((template) => (
                      <button
                        key={template.id}
                        type="button"
                        data-tooltip={`Select the ${template.name} structure`}
                        className={`draft-template-card ${
                          selectedDeckTemplateId === template.id ? "is-selected" : ""
                        }`}
                        aria-pressed={selectedDeckTemplateId === template.id}
                        onClick={() => setSelectedDeckTemplateId(template.id)}
                      >
                        <span>
                          <strong>{template.name}</strong>
                          <small>
                            {template.category} · {template.description}
                          </small>
                        </span>
                        <CheckCircle2 size={15} className="draft-template-check" aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                  <button
                    className="draft-template-start-button"
                    type="button"
                    data-tooltip={`Start a ${
                      builtInDeckTemplate(selectedDeckTemplateId)?.name ?? "deck"
                    } with scaffold slides you replace`}
                    onClick={() => startDeckFromTemplate(selectedDeckTemplateId)}
                  >
                    <Presentation size={16} />
                    Start {builtInDeckTemplate(selectedDeckTemplateId)?.name ?? "deck"}
                  </button>
                </div>
              )}

              {activeAssistantTool === "templates" && draftKind === "document" && (
                <div className="draft-template-panel" aria-label="Draft templates">
                  <label className="draft-context-toggle">
                    <input
                      type="checkbox"
                      checked={templateContextEnabled}
                      onChange={(event) => toggleTemplateContext(event.target.checked)}
                    />
                    <span>
                      <strong>Use templates in chat</strong>
                      <small>Off by default. Turn on to let saved templates guide new drafts.</small>
                    </span>
                  </label>
                  <button
                    className="draft-template-upload-button"
                    type="button"
                    data-tooltip="Upload a .docx file to reuse its layout as a drafting template"
                    onClick={triggerWordTemplateUpload}
                  >
                    <Upload size={16} />
                    <span>
                      <strong>Upload Word template</strong>
                      <small>Add a .docx or Word-openable template to this canvas.</small>
                    </span>
                  </button>
                  <div className="draft-template-tabs" aria-label="Template categories">
                    {templateCategories.map((category) => (
                      <button
                        key={category}
                        type="button"
                        data-template-category={category}
                        data-tooltip={
                          category === "All"
                            ? "Show every available template"
                            : `Show only ${category} templates in this list`
                        }
                        className={templateCategory === category ? "is-active" : ""}
                        aria-pressed={templateCategory === category}
                        onClick={() => selectTemplateCategory(category)}
                      >
                        {category}
                      </button>
                    ))}
                  </div>
                  <div className="draft-template-list" aria-label="Available draft templates">
                    {visibleTemplates.map((template) => (
                      <button
                        key={template.id}
                        type="button"
                        data-template-id={template.id}
                        data-tooltip={`Apply the ${template.name} template to your current draft`}
                        className={`draft-template-card ${
                          selectedTemplate.id === template.id ? "is-selected" : ""
                        }`}
                        aria-pressed={selectedTemplate.id === template.id}
                        onClick={() => applyTemplateToCurrentDraft(template)}
                      >
                        <span>
                          <strong>{template.name}</strong>
                          <small>
                            {template.category} · {template.description}
                          </small>
                        </span>
                        <CheckCircle2 size={15} className="draft-template-check" aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                  <button
                    className="draft-template-start-button"
                    type="button"
                    disabled={!draftAiAvailable}
                    data-tooltip={draftAiAvailable ? `Create a new draft using the selected ${selectedTemplate.name} template` : draftAiUnavailableReason}
                    onClick={() => {
                      setTemplateContextEnabled(true);
                      void startDraftFromTemplate(
                        selectedTemplate,
                        instruction.trim() || undefined,
                        sourceSummary,
                        activeSourceIds,
                        { useTemplateContext: true },
                      );
                    }}
                  >
                    <Sparkles size={16} />
                    Create {selectedTemplate.name} draft
                  </button>
                </div>
              )}

              {activeAssistantTool === "sources" && (
                <div className="draft-source-details" aria-label="Workspace sources for this draft">
                  <div className="draft-panel-heading">
                    <strong>Workspace knowledge</strong>
                    <small>Off by default. Select a source only when this draft should use it.</small>
                  </div>
                  <div className="draft-source-list">
                    {data.knowledgeBases.map((source) => (
                      <label
                        className={`draft-source-row ${
                          activeSourceIds.includes(source.id) ? "is-selected" : ""
                        } ${source.enabled ? "" : "is-disabled"}`}
                        key={source.id}
                      >
                        <input
                          type="checkbox"
                          checked={activeSourceIds.includes(source.id)}
                          disabled={!source.enabled}
                          onChange={(event) => toggleSource(source.id, event.target.checked)}
                        />
                        <span>
                          <strong>{source.name}</strong>
                          {" "}
                          <small>
                            {source.source} · {source.document_count} files · {source.status}
                            {source.last_sync ? ` · ${source.last_sync}` : ""}
                          </small>
                        </span>
                      </label>
                    ))}
                  </div>
                  {attachedFiles.length > 0 && (
                    <div className="draft-attached-source-list">
                      <strong>Draft uploads</strong>
                      {attachedFiles.map((file) => (
                        <span key={file.id}>
                          {file.name} · {file.size}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {activeAssistantTool === "settings" && (
                <div className="draft-settings-panel" aria-label="Assistant drafting settings">
                  {draftKind === "document" && (
                    <button type="button" disabled={assistantWorking || !content.trim()} onClick={applyMlaLayout}
                      data-tooltip="Apply MLA spacing and typography to this paper; keep its text and make the change undoable">
                      Apply MLA layout
                    </button>
                  )}
                  <label className="draft-setting-field">
                    <span>Drafting agent</span>
                    <SelectControl
                      aria-label="Drafting agent"
                      value={selectedAgent?.id ?? ""}
                      disabled={!draftAiAvailable}
                      onChange={(event) => selectDraftingModel(event.target.value)}
                    >
                      {!draftAiAvailable && <option value="">No models connected</option>}
                      {draftAgents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name} · {agent.providerName}
                        </option>
                      ))}
                    </SelectControl>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={requireCitations}
                      onChange={(event) => setRequireCitations(event.target.checked)}
                    />
                    Require source citations
                  </label>
                  <div className="draft-setting-field">
                    <span>Reasoning</span>
                    <ReasoningSlider
                      level={reasoningLevel}
                      supported={reasoningSupported}
                      modelName={selectedAgent?.name ?? "No model available"}
                      onChange={updateReasoningLevel}
                    />
                  </div>
                </div>
              )}

              {activeAssistantTool === "history" && (
                <div className="draft-history-panel" aria-label="Draft history">
                  <div className="draft-history-section">
                    <strong className="draft-history-section-title">Document history</strong>
                    <div className="draft-history-filter" role="group" aria-label="History filter">
                      <button type="button" aria-pressed={!showArchivedDrafts} onClick={() => setShowArchivedDrafts(false)}>Active</button>
                      <button type="button" aria-pressed={showArchivedDrafts} onClick={() => setShowArchivedDrafts(true)}>Archived</button>
                    </div>
                    {serverListNotice && (
                      <p className="draft-history-empty" role="status">
                        {serverListNotice}
                      </p>
                    )}
                    {documentHistory.filter(item => Boolean(item.archived) === showArchivedDrafts).length === 0 ? (
                      <p className="draft-history-empty">
                        {showArchivedDrafts ? "No archived drafts." : "Saved documents will appear here after you draft or save them."}
                      </p>
                    ) : (
                      <div className="draft-document-history-list">
                        {documentHistory.filter(item => Boolean(item.archived) === showArchivedDrafts).map((item) => (
                          <DraftHistoryCard key={`${item.id}:${item.updatedAt}:${item.serverContentStale}`}
                            title={item.title} summary={item.summary} source={item.sourceLabel}
                            time={formatHistoryTimestamp(item.updatedAt)} status={draftHistoryStatusLabel(item)}
                            archived={Boolean(item.archived)}
                            disabled={Boolean(historyBusyId) || item.status === "running" || Boolean(item.serverSavePending) || assistantWorking}
                            onRestore={() => void restoreDocumentHistoryItem(item)}
                            onArchive={() => void changeHistoryItem(item, false)}
                            onDelete={() => setHistoryDeleteTarget(item)}
                            loadPreview={() => previewHistoryItem(item)} />
                        ))}
                      </div>
                    )}
                  </div>
                  {legacyDraftHistory.length > 0 && (
                    <div className="draft-history-section" aria-label="Legacy local drafts">
                      <strong className="draft-history-section-title">Legacy local drafts</strong>
                      <p className="draft-history-empty">
                        These drafts were stored in this browser before drafts were scoped to
                        individual accounts, so they may belong to someone else who used this
                        device. They stay on this device and are never uploaded unless you
                        explicitly import one below.
                      </p>
                      <div className="draft-document-history-list">
                        {legacyDraftHistory.map((item) => (
                          <div className="draft-history-document-card is-complete" key={item.id}>
                            <span>
                              <strong>{item.title}</strong>
                              <small>{item.summary}</small>
                              {legacyImportConfirmId === item.id ? (
                                <span className="draft-legacy-import-confirm">
                                  <small>
                                    Import this draft into {data.me.email} on{" "}
                                    {data.currentTenant.name}?
                                  </small>
                                  <button
                                    type="button"
                                    disabled={legacyImportBusyId === item.id}
                                    onClick={() => void importLegacyDraftToAccount(item)}
                                  >
                                    {legacyImportBusyId === item.id
                                      ? "Importing…"
                                      : "Confirm import"}
                                  </button>
                                  <button
                                    type="button"
                                    disabled={legacyImportBusyId === item.id}
                                    onClick={() => setLegacyImportConfirmId(null)}
                                  >
                                    Cancel
                                  </button>
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  aria-label={`Import ${item.title} to my account`}
                                  disabled={legacyImportBusyId !== null}
                                  onClick={() => setLegacyImportConfirmId(item.id)}
                                >
                                  Import to my account
                                </button>
                              )}
                            </span>
                            <time>{formatHistoryTimestamp(item.updatedAt)}</time>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="draft-history-section">
                    <strong className="draft-history-section-title">Current document versions</strong>
                    {versions.length === 1 ? (
                      <p className="draft-history-empty">
                        New revisions will appear after you save or ask the assistant to revise.
                      </p>
                    ) : (
                      <div className="draft-version-list">
                        {versions.map((version) => (
                          <button
                            key={version.id}
                            type="button"
                            className={`draft-version-card ${
                              selectedVersionId === version.id && !hasUnsavedEdits ? "is-active" : ""
                            }`}
                            aria-pressed={selectedVersionId === version.id && !hasUnsavedEdits}
                            data-tooltip={
                              version.format === "deck"
                                ? `Restore ${version.label} in the deck editor`
                                : `Restore the document to ${version.label} so you can review or edit it`
                            }
                            onClick={() => requestDraftNavigation(`restore ${version.label}`, () => selectVersion(version))}
                          >
                            <span>
                              <strong>
                                {version.format === "deck" ? (
                                  <Presentation size={13} aria-label="Deck version" />
                                ) : null}
                                {version.label}
                              </strong>
                              <small>{version.summary}</small>
                            </span>
                            <time>{version.time}</time>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}

          <form
            className="draft-command-box"
            onSubmit={submitInstruction}
            aria-busy={assistantWorking}
          >
            <label className="sr-only" htmlFor="draft-assistant-command">
              {draftKind === "deck" ? "Ask the deck assistant" : "Ask the document assistant"}
            </label>
            <textarea
              id="draft-assistant-command"
              aria-describedby={!draftAiAvailable ? "draft-ai-unavailable" : undefined}
              data-tooltip={
                draftKind === "deck"
                  ? "Describe the deck you want the assistant to build, or ask for changes to the current slides."
                  : "Describe the draft you want, paste revision instructions, or ask the assistant to edit the current document using the selected templates and sources."
              }
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              disabled={assistantWorking}
              placeholder={
                assistantWorking
                  ? draftKind === "deck"
                    ? "The deck assistant is working on your slides..."
                    : "The document assistant is revising this draft..."
                  : draftKind === "deck"
                    ? "Ask the deck assistant what to build"
                    : templateContextEnabled
                      ? `Ask for a ${selectedTemplate.name.toLowerCase()} or describe edits`
                      : "Ask the document assistant"
              }
            />
            <div className="draft-command-toolbar">
              <div className="draft-attach-control">
                <button
                  type="button"
                  aria-label="Attach file"
                  data-tooltip="Attach files or connect cloud sources to ground this draft"
                  aria-expanded={attachMenuOpen}
                  aria-haspopup="menu"
                  onClick={() => setAttachMenuOpen((value) => !value)}
                >
                  <Paperclip size={18} />
                </button>
                {attachMenuOpen && (
                  <div
                    className="attach-menu draft-attach-menu"
                    role="menu"
                    aria-label="Add draft attachment"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      className="attach-option"
                      data-tooltip="Pick files from this device to use as draft sources"
                      onClick={triggerAttachFiles}
                    >
                      <Upload size={16} />
                      <span>
                        <strong>Upload from computer</strong>
                        <small>Choose files on this device</small>
                      </span>
                    </button>
                    <div className="attach-menu-divider" />
                    <span className="attach-menu-label">Connect a source</span>
                    {DRAFT_ATTACHMENT_CONNECTORS.map((connector) => {
                      const Icon = connector.icon;
                      const sourceCount = draftConnectorSourceCount(data, connector);
                      return (
                        <button
                          type="button"
                          role="menuitem"
                          className="attach-option"
                          key={connector.id}
                          data-tooltip={`Pull files from ${connector.label} into this draft's context`}
                          onClick={() => attachConnectorSource(connector)}
                        >
                          <Icon size={16} />
                          <span>
                            <strong>{connector.label}</strong>
                            <small>
                              {sourceCount > 0
                                ? `${sourceCount} indexed source${sourceCount === 1 ? "" : "s"}`
                                : connector.blurb}
                            </small>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <button
                type="button"
                aria-label="Choose template"
                data-tooltip={
                  draftKind === "deck"
                    ? "Browse deck templates and your uploaded brand template"
                    : "Browse templates that shape the structure of your next draft"
                }
                aria-pressed={activeAssistantTool === "templates"}
                onClick={() =>
                  setActiveAssistantTool((current) =>
                    current === "templates" ? null : "templates",
                  )
                }
              >
                {draftKind === "deck" ? <Presentation size={18} /> : <FileText size={18} />}
              </button>
              <button
                type="button"
                aria-label="Sources and files"
                data-tooltip="Choose which workspace sources the assistant can draw on and cite"
                aria-pressed={activeAssistantTool === "sources"}
                onClick={() => {
                  setActiveAssistantTool((current) =>
                    current === "sources" ? null : "sources",
                  );
                  setStatus("Sources opened for this draft.");
                }}
              >
                <LibraryBig size={18} />
              </button>
              <button
                className="draft-web-toggle"
                type="button"
                aria-label={
                  webSearchAvailable
                    ? webSearchEnabled
                      ? "Disable web search"
                      : "Enable web search"
                    : "Web search unavailable"
                }
                aria-pressed={webSearchEnabled}
                disabled={!webSearchAvailable}
                data-tooltip={
                  webSearchAvailable
                    ? "Turn web search on or off to ground this draft in current facts"
                    : "Web search is turned off for this model by your workspace"
                }
                onClick={toggleWebSearch}
              >
                <Globe2 size={18} />
              </button>
              {draftKind === "deck" && (
                <button
                  type="button"
                  aria-label="Toggle AI slide images"
                  aria-pressed={deckImagesEnabled}
                  disabled={!imageGenerationAgent}
                  data-tooltip={
                    imageGenerationAgent
                      ? "Also generate an AI image for every slide when the assistant drafts a deck"
                      : "No image-generation model is enabled for your workspace"
                  }
                  onClick={() => {
                    setDeckImagesEnabled((value) => {
                      setStatus(
                        value
                          ? "AI slide images off. New decks keep their layout colors."
                          : "AI slide images on. The assistant will generate an image for each drafted slide.",
                      );
                      return !value;
                    });
                  }}
                >
                  <ImagePlus size={18} />
                </button>
              )}
              <button
                type="button"
                aria-label="Assistant settings"
                data-tooltip="Pick the drafting model, set citation requirements, and choose the reasoning level"
                aria-pressed={activeAssistantTool === "settings"}
                onClick={() => {
                  setActiveAssistantTool((current) =>
                    current === "settings" ? null : "settings",
                  );
                  setStatus("Assistant drafting controls toggled.");
                }}
              >
                <Settings2 size={18} />
              </button>
              <button
                type="button"
                aria-label="Draft history"
                data-tooltip="Review earlier documents and saved versions of this draft"
                aria-pressed={activeAssistantTool === "history"}
                onClick={() =>
                  setActiveAssistantTool((current) =>
                    current === "history" ? null : "history",
                  )
                }
              >
                <History size={18} />
              </button>
              <DictationControl
                userId={completionUserId}
                disabled={assistantWorking}
                subjectLabel="instruction"
                onError={(message) => {
                  if (message) setStatus(message);
                }}
                onTranscript={(text) => {
                  setInstruction((current) => [current.trim(), text].filter(Boolean).join(" "));
                  setStatus("Dictation added to the instruction box.");
                }}
              />
              <button
                className="draft-send-button"
                type="submit"
                aria-label="Apply instruction"
                data-tooltip={draftAiAvailable ? "Send this instruction so the assistant drafts or revises the document" : draftAiUnavailableReason}
                disabled={!draftAiAvailable || !instruction.trim() || assistantWorking}
              >
                {assistantWorking ? (
                  <LoaderCircle className="is-spinning" size={18} />
                ) : (
                  <Send size={18} />
                )}
              </button>
            </div>
          </form>
        </aside>

        <main className="document-editor-workspace" inert={(railIsDrawer && railOpen) || pendingDraftNavigation !== null}>
          <header className="document-editor-topbar">
            <div className="document-title-cluster">
              {railIsDrawer && (
                <button
                  type="button"
                  className={`draft-rail-trigger ${assistantWorking ? "is-working" : ""}`}
                  aria-label={`Open the ${draftKind === "deck" ? "deck" : "document"} assistant${
                    assistantWorking ? " (drafting…)" : ""
                  }`}
                  aria-expanded={railOpen}
                  data-tooltip={`Open the assistant panel to chat about and revise this ${
                    draftKind === "deck" ? "deck" : "draft"
                  }`}
                  onClick={() => setRailOpen(true)}
                >
                  {/* Pencil + AI spark: this button edits documents AND decks
                      and opens the AI assistant. */}
                  <AiPenIcon size={18} />
                  {assistantWorking && <span className="draft-rail-trigger-dot" aria-hidden="true" />}
                </button>
              )}
              <div
                className="segmented-control deck-mode-switch"
                data-mode={draftKind}
                onPointerDown={event => { modeDragStartRef.current = event.clientX; }}
                onPointerUp={event => {
                  const start = modeDragStartRef.current;
                  modeDragStartRef.current = null;
                  if (start !== null && Math.abs(event.clientX - start) > 24) switchDraftMode(event.clientX > start ? "deck" : "document");
                }}
                onPointerCancel={() => { modeDragStartRef.current = null; }}
                onKeyDown={event => {
                  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                    event.preventDefault(); switchDraftMode(event.key === "ArrowRight" ? "deck" : "document");
                  }
                }}
                role="group"
                aria-label="Draft format"
              >
                <button
                  type="button"
                  className={draftKind === "document" ? "is-active" : ""}
                  disabled={assistantWorking}
                  aria-pressed={draftKind === "document"}
                  data-tooltip="Edit this draft as a written document"
                  onClick={() => switchDraftMode("document")}
                >
                  <FileText size={15} />
                  Document
                </button>
                <button
                  type="button"
                  className={draftKind === "deck" ? "is-active" : ""}
                  disabled={assistantWorking}
                  aria-pressed={draftKind === "deck"}
                  data-tooltip="Edit this draft as PowerPoint slides"
                  onClick={() => switchDraftMode("deck")}
                >
                  <Presentation size={15} />
                  Deck
                </button>
              </div>
              <div className="draft-title-edit">
                <div className="draft-title-input-wrap">
                  <span className="draft-title-measure" data-title={documentTitle || " "} aria-hidden="true" />
                  <input
                    aria-label="Document title"
                    value={documentTitle}
                    onChange={(event) => setDocumentTitle(event.target.value)}
                  />
                </div>
                <button
                  type="button"
                  className="draft-title-ai-button"
                  aria-label={draftKind === "deck" ? "Rename deck with AI" : "Rename document with AI"}
                  data-tooltip={draftAiAvailable ? `Let AI name this ${draftKind === "deck" ? "deck" : "draft"} from its content` : draftAiUnavailableReason}
                  disabled={!draftAiAvailable || draftTitleGenerating || assistantWorking}
                  onClick={() => void generateDraftTitleWithAi()}
                >
                  {draftTitleGenerating ? (
                    <LoaderCircle size={15} className="chat-title-ai-spinner" />
                  ) : (
                    <Sparkles size={15} />
                  )}
                </button>
              </div>
              {deckModeDialogOpen && (
                <div
                  className="inline-ai-popover deck-mode-dialog"
                  role="dialog"
                  aria-label="Switch to deck mode"
                >
                  <div className="inline-ai-popover-header">
                    <strong>Turn this draft into slides?</strong>
                    <button
                      type="button"
                      aria-label="Close deck mode dialog"
                      data-tooltip="Stay in the document editor"
                      onClick={() => setDeckModeDialogOpen(false)}
                    >
                      <X size={15} />
                    </button>
                  </div>
                  <p>
                    This draft has document content. A deck is a separate structured format —
                    convert the document into slides, or start blank. Your document versions are
                    kept either way.
                  </p>
                  <div className="inline-ai-actions">
                    <button
                      type="button"
                      data-tooltip="Start an empty deck; the document stays untouched"
                      onClick={startBlankDeck}
                    >
                      Start a blank deck
                    </button>
                    <button
                      type="button"
                      className="is-primary"
                      data-tooltip="Split the document's headings and text into slides"
                      onClick={convertDocumentToDeckNow}
                    >
                      Convert into slides
                    </button>
                  </div>
                </div>
              )}
            </div>
            <span className="document-version-label">
              <History size={17} />
              {versions.find((version) => version.id === selectedVersionId)?.label ??
                "Version"}
              {hasUnsavedEdits ? " + unsaved edits" : ""}
            </span>
            <div className="document-top-actions">
              <DraftModelMenu
                agents={draftAgents}
                selectedAgent={selectedAgent}
                defaultAgentId={defaultAgentId}
                onSelect={selectDraftingModel}
                onSetDefault={setDefaultDraftingModel}
                unavailableReason={draftAiUnavailableReason}
              />
              {serverSaveState.kind !== "idle" && (
                <span
                  className={`document-server-save-state is-${serverSaveState.kind}`}
                  role="status"
                  aria-label="Server save state"
                  data-tooltip={
                    serverSaveState.kind === "saved"
                      ? `Saved to your account (revision ${serverSaveState.revision})`
                      : serverSaveState.kind === "saving"
                        ? "Saving this version to your account"
                        : serverSaveState.message
                  }
                >
                  {serverSaveState.kind === "saving" ? (
                    <>
                      <LoaderCircle size={14} aria-hidden="true" /> Saving…
                    </>
                  ) : serverSaveState.kind === "saved" ? (
                    <>
                      <CheckCircle2 size={14} aria-hidden="true" /> Saved
                    </>
                  ) : serverSaveState.kind === "not-stored" ? (
                    serverSaveState.message
                  ) : serverSaveState.kind === "local-only" ? (
                    draftKind === "deck" ? "Local only — decks save on this device" : "Local only — server save failed"
                  ) : (
                    "Draft changed elsewhere"
                  )}
                  {(serverSaveState.kind === "local-only" || serverSaveState.kind === "not-stored") && draftKind !== "deck" && (
                    <button type="button" onClick={retryDraftServerSync}>
                      Retry
                    </button>
                  )}
                  {serverSaveState.kind === "conflict" && (
                    <button
                      type="button"
                      onClick={() => void reloadServerDraftCopy(serverSaveState.serverId)}
                    >
                      Reload server copy
                    </button>
                  )}
                </span>
              )}
              <button
                className="document-save-version-button"
                type="button"
                aria-label="Save version"
                data-tooltip={
                  draftKind === "deck"
                    ? "Save a version on this device — decks stay local until you export them"
                    : "Snapshot the current draft so you can compare or restore it later"
                }
                onClick={saveManualVersion}
                disabled={!hasUnsavedEdits || assistantWorking}
              >
                <Save size={17} />
                <span className="draft-action-label-full">Save version</span>
                <span className="draft-action-label-mobile" aria-hidden="true">Save</span>
              </button>
              <button
                className="document-compare-button"
                type="button"
                aria-label="Compare versions"
                data-tooltip={
                  canCompareVersions
                    ? "Open a read-only visual redline of two saved versions"
                    : "Save two different versions of this draft to compare them"
                }
                aria-haspopup="dialog"
                aria-expanded={compareOpen}
                onClick={openVersionCompare}
                disabled={!canCompareVersions}
              >
                <FileDiff size={17} />
                <span className="draft-action-label-full">Compare versions</span>
                <span className="draft-action-label-mobile" aria-hidden="true">Compare</span>
              </button>
              <button
                className="document-export-button"
                type="button"
                data-tooltip={
                  draftKind === "deck"
                    ? "Download this deck as a PowerPoint file or a Markdown outline"
                    : "Download this document as Word or Markdown, or print / save as PDF"
                }
                aria-label={exportingFormat ? "Export in progress" : "Export"}
                aria-busy={Boolean(exportingFormat)}
                aria-expanded={exportMenuOpen}
                aria-haspopup="dialog"
                aria-controls="document-export-panel"
                disabled={Boolean(exportingFormat)}
                onClick={() => {
                  setPendingSaveExportFormat(null);
                  setExportMenuOpen((value) => !value);
                }}
              >
                {exportingFormat ? (
                  <LoaderCircle className="document-export-spinner" size={18} />
                ) : (
                  <Download size={18} />
                )}
                {exportingFormat ? "Preparing" : "Export"}
                <ChevronDown size={15} />
              </button>
              {exportMenuOpen && (
                <div
                  className="document-export-panel"
                  id="document-export-panel"
                  role="dialog"
                  aria-label="Export document"
                >
                  <div className="document-export-panel-header">
                    <span>
                      <strong>{draftKind === "deck" ? "Export deck" : "Export document"}</strong>
                      <small>
                        {canChooseExportLocation
                          ? "Choose a file type and save it where you want."
                          : "Choose a file type to download."}
                      </small>
                    </span>
                    <button
                      type="button"
                      aria-label="Close export options"
                      data-tooltip="Close the export panel without saving a file"
                      onClick={() => {
                        setPendingSaveExportFormat(null);
                        setExportMenuOpen(false);
                      }}
                    >
                      <X size={15} />
                    </button>
                  </div>
                  {canChooseExportLocation && (
                    <label className="document-export-destination">Save to
                      <select aria-label="Export destination" value={exportDelivery}
                        disabled={Boolean(exportingFormat)}
                        onChange={event => setExportDelivery(event.target.value as ExportDelivery)}>
                        <option value="picker">Choose a location</option>
                        <option value="download">Browser downloads</option>
                      </select>
                    </label>
                  )}
                  <div
                    className="document-export-options"
                    aria-label="Export formats"
                    aria-busy={Boolean(exportingFormat)}
                  >
                    {(draftKind === "deck" ? DECK_EXPORT_OPTIONS : DOCUMENT_EXPORT_OPTIONS).map(
                      (option) => {
                        const Icon = option.icon;
                        return (
                          <button
                            key={option.format}
                            className="document-export-choice"
                            type="button"
                            data-tooltip={`Save a ${option.label} copy of this draft to your device`}
                            disabled={Boolean(exportingFormat)}
                            onClick={() => requestExport(option.format)}
                          >
                            <Icon size={17} />
                            <span>
                              <strong>{option.label}</strong>
                              <small>{option.description}</small>
                            </span>
                          </button>
                        );
                      },
                    )}
                    {draftKind === "document" && (
                      <button
                        className="document-export-choice"
                        type="button"
                        data-tooltip="Open the browser print dialog with the saved version of this draft"
                        disabled={Boolean(exportingFormat) || printPreparing}
                        onClick={() => requestExport("print")}
                      >
                        <Printer size={17} />
                        <span>
                          <strong>Print / Save as PDF</strong>
                          <small>
                            Opens the browser print dialog with the saved version. Choose "Save as
                            PDF" in that dialog to keep a PDF copy.
                          </small>
                        </span>
                      </button>
                    )}
                  </div>
                  {printPreparing && (
                    <div className="document-export-progress" role="status">
                      <LoaderCircle className="document-export-spinner" size={17} />
                      <span>
                        <strong>Preparing the print view</strong>
                        <small>Rendering the saved version for the browser print dialog.</small>
                      </span>
                    </div>
                  )}
                  {printNotice && (
                    <div
                      className={`document-export-print-notice is-${printNotice.kind}`}
                      role={printNotice.kind === "error" ? "alert" : "status"}
                    >
                      {printNotice.kind === "error" ? <X size={16} /> : <CheckCircle2 size={16} />}
                      <span>{printNotice.text}</span>
                    </div>
                  )}
                  {exportingFormat && (
                    <div className="document-export-progress" role="status">
                      <LoaderCircle className="document-export-spinner" size={17} />
                      <span>
                        <strong>
                          Preparing {exportingFormat === "word" ? "Word document" : "download"}
                        </strong>
                        <small>
                          {exportingFormat === "word"
                            ? "Packaging saved pages and embedding images in parallel."
                            : "Packaging the latest saved version."}
                        </small>
                      </span>
                    </div>
                  )}
                  {pendingSaveExportFormat && hasUnsavedEdits && (
                    <div className="document-export-save-notice" role="alert">
                      <span>
                        <strong>Save your edits first</strong>
                        <small>
                          {pendingSaveExportFormat === "print"
                            ? "This draft has unsaved edits, and printing uses only a saved version. Save to continue."
                            : "This draft has unsaved edits, and downloads only run from a saved version. Save to continue."}
                        </small>
                      </span>
                      <button
                        type="button"
                        data-tooltip={
                          pendingSaveExportFormat === "print"
                            ? "Save a version of your edits, then open the print dialog"
                            : "Save a version of your edits, then download the file"
                        }
                        onClick={saveVersionAndExport}
                      >
                        <Save size={15} />
                        {pendingSaveExportFormat === "print"
                          ? "Save version and print"
                          : "Save version and export"}
                      </button>
                    </div>
                  )}
                  {lastExport && (
                    <div className="document-export-receipt" role="status">
                      <CheckCircle2 size={16} />
                      <span>
                        <strong>{lastExport.filename}</strong>
                        <small>
                          {lastExport.delivery === "picker"
                            ? "Saved to your selected location."
                            : "Sent to your browser downloads."}
                        </small>
                        {lastExport.href && (
                          <a
                            className="document-export-retained-link"
                            href={lastExport.href}
                            download={lastExport.filename}
                            data-tooltip={`Download ${lastExport.filename} again without re-exporting`}
                          >
                            Download again
                          </a>
                        )}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
            {!draftAiAvailable && (
              <p className="draft-ai-unavailable" id="draft-ai-unavailable" role="status">
                <strong>AI drafting is unavailable.</strong> {draftAiUnavailableReason}{" "}
                You can still edit, import, save, and export documents and decks.
              </p>
            )}
          </header>

          {draftKind === "document" && (
          <div
            className={`document-toolbar document-toolbar-compact ${mobileFormattingExpanded ? "is-mobile-expanded" : ""}`}
            aria-label="Document formatting"
          >
            <button
              className="document-mobile-toolbar-toggle"
              type="button"
              aria-label={`${mobileFormattingExpanded ? "Collapse" : "Expand"} document formatting`}
              aria-controls="document-formatting-controls"
              aria-expanded={mobileFormattingExpanded}
              onClick={() => setMobileFormattingExpanded((value) => !value)}
            >
              <span className="document-mobile-toolbar-copy">
                <Settings2 size={17} aria-hidden="true" />
                <span>
                  <strong>Document formatting</strong>
                  <small>
                    {DOCUMENT_BLOCK_STYLE_LABELS[formatState.blockStyle] ?? "Paragraph"}
                    {" · "}
                    {DOCUMENT_FONT_SIZES.find((size) => size.value === documentFontSizeValue)
                      ?.label ?? "Default"}
                  </small>
                </span>
              </span>
              <ChevronDown className="document-mobile-toolbar-chevron" size={17} aria-hidden="true" />
            </button>
            <div className="document-toolbar-content" id="document-formatting-controls">
            <div className="document-toolbar-group document-toolbar-main">
              <button
                type="button"
                aria-label="Undo document edit"
                data-tooltip="Undo the last change made in this document"
                onClick={undoDocumentChange}
                disabled={!undoStack.length}
              >
                <Undo2 size={18} />
              </button>
              <button
                type="button"
                aria-label="Redo document edit"
                data-tooltip="Redo the last document change you undid"
                onClick={redoDocumentChange}
                disabled={!redoStack.length}
              >
                <Redo2 size={18} />
              </button>
              <span className="document-toolbar-divider" aria-hidden="true" />
              <SelectControl
                aria-label="Block style"
                value={formatState.blockStyle}
                onChange={(event) => applyBlockStyle(event.currentTarget.value)}
              >
                <option value="p">Paragraph</option>
                <option value="h1">Title</option>
                <option value="h2">Heading</option>
                <option value="h3">Subheading</option>
                <option value="blockquote">Quote</option>
              </SelectControl>
              <button
                type="button"
                aria-label="Bold"
                aria-pressed={formatState.bold}
                data-tooltip="Make the selected text bold for emphasis"
                onClick={() => runEditorCommand("bold", "Bold formatting applied.")}
              >
                <Bold size={18} />
              </button>
              <button
                type="button"
                aria-label="Italic"
                aria-pressed={formatState.italic}
                data-tooltip="Set the selected text in italics for subtle emphasis"
                onClick={() => runEditorCommand("italic", "Italic formatting applied.")}
              >
                <Italic size={18} />
              </button>
              <button
                type="button"
                aria-label="Underline"
                aria-pressed={formatState.underline}
                data-tooltip="Underline the selected text to call attention to it"
                onClick={() => runEditorCommand("underline", "Underline formatting applied.")}
              >
                <Underline size={18} />
              </button>
              <DocumentToolbarPanel label="Text" title="Text formatting" open={documentToolPanel === "text"}
                onToggle={() => { setInsertMenuOpen(false); setDocumentToolPanel(current => current === "text" ? null : "text"); }}
                onClose={() => setDocumentToolPanel(null)}>
                <section className="document-tool-section " aria-label="Font and size"><span className="document-tool-section-label">Font and size</span><div className="document-tool-section-controls">
              <SelectControl
                className="document-font-select"
                aria-label="Text font"
                data-tooltip="Change the font of the selected text"
                value={fontFamilyValue}
                onChange={(event) => applyFontFamily(event.currentTarget.value)}
              >
                {DRAFT_FONT_FAMILIES.map((family) => (
                  <option key={family.value} value={family.value}>
                    {family.label}
                  </option>
                ))}
              </SelectControl>
              <span
                className="document-size-control"
                data-tooltip="Change the size of the selected text (Word points)"
              >
                <ALargeSmall size={17} aria-hidden="true" />
                <SelectControl
                  className="document-size-select"
                  aria-label="Text size"
                  value={documentFontSizeValue}
                  onChange={(event) => applyFontSize(event.currentTarget.value)}
                >
                  {DOCUMENT_FONT_SIZES.map((size) => (
                    <option key={size.value} value={size.value}>
                      {size.label}
                    </option>
                  ))}
                </SelectControl>
              </span>
                </div></section>
                <section className="document-tool-section " aria-label="Advanced styles"><span className="document-tool-section-label">Advanced styles</span><div className="document-tool-section-controls">
              <button
                type="button"
                aria-label="Strikethrough"
                aria-pressed={formatState.strikethrough}
                data-tooltip="Cross out the selected text"
                onClick={() => runEditorCommand("strikeThrough", "Strikethrough formatting applied.")}
              >
                <Strikethrough size={18} />
              </button>
              <button
                type="button"
                aria-label="Superscript"
                aria-pressed={formatState.superscript}
                data-tooltip="Raise the selected text above the line, as in exponents"
                onClick={() => runEditorCommand("superscript", "Superscript formatting applied.")}
              >
                <Superscript size={18} />
              </button>
              <button
                type="button"
                aria-label="Subscript"
                aria-pressed={formatState.subscript}
                data-tooltip="Lower the selected text below the line, as in chemical formulas"
                onClick={() => runEditorCommand("subscript", "Subscript formatting applied.")}
              >
                <Subscript size={18} />
              </button>
              <button
                type="button"
                aria-label="Clear formatting"
                data-tooltip="Remove bold, color, size, and other styling from the selected text"
                onClick={clearInlineFormatting}
              >
                <RemoveFormatting size={18} />
              </button>
                </div></section>
                <section className="document-tool-section " aria-label="Color and highlight"><span className="document-tool-section-label">Color and highlight</span><div className="document-tool-section-controls">
              <div className="document-color-control" aria-label="Text color control">
                <input
                  type="color"
                  aria-label="Text color"
                  value={textColor}
                  onChange={(event) => applyTextColor(event.target.value)}
                />
                <div className="document-color-swatches" aria-label="Text color presets">
                  {TEXT_COLOR_SWATCHES.map((color) => (
                    <button
                      key={color}
                      type="button"
                      aria-label={`Apply text color ${color}`}
                      data-tooltip={`Recolor the selected text to ${color}`}
                      aria-pressed={textColor === color}
                      onClick={() => applyTextColor(color)}
                      style={{ "--swatch-color": color } as CSSProperties}
                    />
                  ))}
                </div>
              </div>
              <div className="document-color-control document-highlight-control" aria-label="Text highlight control">
                <button
                  type="button"
                  aria-label="Highlight"
                  data-tooltip="Highlight the selected text in amber"
                  onClick={() => applyHighlight(HIGHLIGHT_SWATCHES[0].color)}
                >
                  <Highlighter size={18} />
                </button>
                <div className="document-color-swatches" aria-label="Highlight color presets">
                  {HIGHLIGHT_SWATCHES.map((swatch) => (
                    <button
                      key={swatch.color}
                      type="button"
                      aria-label={`Highlight in ${swatch.label}`}
                      data-tooltip={`Highlight the selected text in ${swatch.label}`}
                      onClick={() => applyHighlight(swatch.color)}
                      style={{ "--swatch-color": swatch.color } as CSSProperties}
                    />
                  ))}
                  <button
                    type="button"
                    className="document-swatch-clear"
                    aria-label="Remove highlight"
                    data-tooltip="Remove the highlight from the selected text"
                    onClick={() => applyHighlight(null)}
                  >
                    <X size={9} />
                  </button>
                </div>
              </div>
                </div></section>

              </DocumentToolbarPanel>
              <DocumentToolbarPanel label="Paragraph" title="Paragraph formatting" open={documentToolPanel === "paragraph"}
                onToggle={() => { setInsertMenuOpen(false); setDocumentToolPanel(current => current === "paragraph" ? null : "paragraph"); }}
                onClose={() => setDocumentToolPanel(null)}>
                <section className="document-tool-section " aria-label="Alignment and lists"><span className="document-tool-section-label">Alignment and lists</span><div className="document-tool-section-controls">
              {ALIGNMENT_CONTROLS.map((control) => (
                <button
                  key={control.value}
                  type="button"
                  aria-label={control.label}
                  aria-pressed={formatState.align === control.value}
                  data-tooltip={`${control.label === "Justify" ? "Justify" : control.label.replace("Align", "Align the")} selected paragraphs`}
                  onClick={() => applyAlignment(control.value)}
                >
                  <control.icon size={18} />
                </button>
              ))}
              <button
                type="button"
                aria-label="Bulleted list"
                data-tooltip="Turn the selected lines into a bulleted list"
                onClick={() => runEditorCommand("insertUnorderedList", "Bulleted list formatting applied.")}
              >
                <List size={18} />
              </button>
              <button
                type="button"
                aria-label="Numbered list"
                data-tooltip="Turn the selected lines into a numbered list"
                onClick={() => runEditorCommand("insertOrderedList", "Numbered list formatting applied.")}
              >
                <ListOrdered size={18} />
              </button>
              <button
                type="button"
                aria-label="Quote"
                data-tooltip="Format the current paragraph as an indented block quote"
                onClick={() => applyBlockStyle("blockquote")}
              >
                <Quote size={18} />
              </button>
                </div></section>

              </DocumentToolbarPanel>
              <button
                type="button"
                aria-label="Inline AI edit"
                data-tooltip={draftAiAvailable ? "Rewrite the highlighted text with AI using your own instruction" : draftAiUnavailableReason}
                disabled={!draftAiAvailable}
                onMouseDown={(event) => event.preventDefault()}
                onClick={openInlineAiEdit}
              >
                <Sparkles size={18} />
              </button>
              <DocumentToolbarPanel label="More" title="Document tools" open={documentToolPanel === "more"}
                onToggle={() => { setInsertMenuOpen(false); setDocumentToolPanel(current => current === "more" ? null : "more"); }}
                onClose={() => setDocumentToolPanel(null)}>
                <section className="document-tool-section document-tool-actions" aria-label="Tools"><span className="document-tool-section-label">Tools</span><div className="document-tool-section-controls">
              <button
                type="button"
                aria-label="Copy document"
                data-tooltip="Copy the whole document to your clipboard for pasting elsewhere"
                onClick={copyDocument}
              >
                <Copy size={18} /><span>Copy document</span>
              </button>
              <button
                type="button"
                className={`document-ai-trail-toggle ${aiTrailOpen ? "is-on" : ""}`}
                aria-label="AI edit trail"
                aria-pressed={aiTrailOpen}
                disabled={!aiEditTrail.length}
                data-tooltip={
                  aiEditTrail.length
                    ? "Show every AI edit still in this document, newest first"
                    : "No AI edits have been recorded in this document yet"
                }
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setDocumentToolPanel(null);
                  const next = !aiTrailOpen;
                  setAiTrailOpen(next);
                  setStatus(
                    next
                      ? `${aiEditTrail.length} AI edit${aiEditTrail.length === 1 ? "" : "s"} highlighted in this document.`
                      : "AI edit highlights hidden.",
                  );
                }}
              >
                <History size={18} /><span>AI edit trail</span>
                {aiEditTrail.length > 0 && (
                  <span className="document-ai-trail-count">{aiEditTrail.length}</span>
                )}
              </button>
                </div></section>
              <span
                className="document-word-count"
                data-tooltip={`${wordCount.words.toLocaleString()} words, ${wordCount.characters.toLocaleString()} characters`}
                aria-label={`${wordCount.words.toLocaleString()} words, ${wordCount.characters.toLocaleString()} characters`}
              >
                {wordCount.words.toLocaleString()} {wordCount.words === 1 ? "word" : "words"}
              </span>

              </DocumentToolbarPanel>
              {aiTrailOpen && aiEditTrail.length > 0 && (
                <div
                  className="inline-ai-popover document-ai-trail-popover"
                  role="dialog"
                  aria-label="AI edit trail"
                >
                  <div className="inline-ai-popover-header">
                    <strong>AI edit trail</strong>
                    <button
                      type="button"
                      aria-label="Close AI edit trail"
                      data-tooltip="Hide the AI edit highlights and close this list"
                      onClick={() => setAiTrailOpen(false)}
                    >
                      <X size={15} />
                    </button>
                  </div>
                  <p className="document-ai-trail-intro">
                    Every AI edit still in this document, newest first. The text is yours to
                    keep or change — clearing only removes the marks.
                  </p>
                  <ul className="document-ai-trail-list" aria-label="Recorded AI edits">
                    {aiEditTrail.map((entry) => (
                      <li key={`${entry.at}-${entry.index}`}>
                        <button
                          type="button"
                          data-tooltip="Jump to this edit in the document"
                          onClick={() => revealAiEdit(entry)}
                        >
                          <span className="document-ai-trail-meta">
                            <Clock3 size={13} />
                            {formatTimestamp(entry.at)}
                            <em>{entry.by}</em>
                            {entry.runs > 1 && <span>{entry.runs} blocks</span>}
                          </span>
                          <span className="document-ai-trail-text">{entry.text || "(no text)"}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <div className="inline-ai-actions">
                    <button
                      type="button"
                      data-tooltip="Keep every AI edit and remove its highlight from the document"
                      onClick={clearAiEditTrail}
                    >
                      Clear marks
                    </button>
                  </div>
                </div>
              )}
              {linkEditState.open && (
                <form
                  className="inline-ai-popover document-link-popover"
                  role="dialog"
                  aria-label="Link editor"
                  onSubmit={applyLinkEdit}
                >
                  <div className="inline-ai-popover-header">
                    <strong>{linkEditState.hasExistingLink ? "Edit link" : "Add link"}</strong>
                    <button
                      type="button"
                      aria-label="Close link editor"
                      data-tooltip="Close the link editor without changing the text"
                      onClick={closeLinkEditor}
                    >
                      <X size={15} />
                    </button>
                  </div>
                  {linkEditState.message ? (
                    <p>{linkEditState.message}</p>
                  ) : (
                    <>
                      <label>
                        <span>Web address</span>
                        <input
                          type="text"
                          aria-label="Link address"
                          value={linkEditState.url}
                          placeholder="https://example.com"
                          autoFocus
                          onChange={(event) =>
                            setLinkEditState((current) => ({
                              ...current,
                              url: event.target.value,
                              error: null,
                            }))
                          }
                        />
                      </label>
                      {linkEditState.error && (
                        <p className="document-link-error" role="alert">
                          {linkEditState.error}
                        </p>
                      )}
                      <div className="inline-ai-actions">
                        {linkEditState.hasExistingLink ? (
                          <button
                            type="button"
                            data-tooltip="Remove this link but keep the text"
                            onClick={removeLinkEdit}
                          >
                            Remove link
                          </button>
                        ) : (
                          <button
                            type="button"
                            data-tooltip="Close the link editor without changing the text"
                            onClick={closeLinkEditor}
                          >
                            Cancel
                          </button>
                        )}
                        <button
                          type="submit"
                          data-tooltip="Link the highlighted text to this address"
                          disabled={!linkEditState.url.trim()}
                        >
                          {linkEditState.hasExistingLink ? "Update link" : "Apply link"}
                        </button>
                      </div>
                    </>
                  )}
                </form>
              )}
              {inlineEditState.open && (
                <form
                  className={`inline-ai-popover ${inlineEditState.message ? "is-message" : ""}`}
                  role="dialog"
                  aria-label="Inline AI edit panel"
                  onSubmit={applyInlineAiEdit}
                >
                  <div className="inline-ai-popover-header">
                    <strong>Inline AI edit</strong>
                    <button
                      type="button"
                      aria-label="Close inline AI edit"
                      data-tooltip="Close the inline edit panel without changing your text"
                      onClick={closeInlineAiEdit}
                    >
                      <X size={15} />
                    </button>
                  </div>
                  {inlineEditState.message ? (
                    <p>{inlineEditState.message}</p>
                  ) : (
                    <>
                      <div className="inline-ai-selected-text">
                        <span>Selected text</span>
                        <blockquote>{inlineEditState.selectedText}</blockquote>
                      </div>
                      <label>
                        <span>How should this highlighted text change?</span>
                        <textarea
                          aria-label="Inline edit instruction"
                          value={inlineEditState.instruction}
                          disabled={inlineEditState.working}
                          onChange={(event) =>
                            setInlineEditState((current) => ({
                              ...current,
                              instruction: event.target.value,
                            }))
                          }
                          placeholder="Make it clearer, shorter, more formal, client-ready..."
                        />
                      </label>
                      <div className="inline-ai-prompts" aria-label="Suggested edit instructions">
                        {["Make it clearer", "Shorten it", "More formal"].map((prompt) => (
                          <button
                            key={prompt}
                            type="button"
                            disabled={inlineEditState.working}
                            onClick={() =>
                              setInlineEditState((current) => ({
                                ...current,
                                instruction: prompt,
                              }))
                            }
                          >
                            {prompt}
                          </button>
                        ))}
                      </div>
                      <div className="inline-ai-actions">
                        <button
                          type="button"
                          data-tooltip="Discard this inline edit and keep the original text"
                          onClick={closeInlineAiEdit}
                          disabled={inlineEditState.working}
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          data-tooltip="Replace the highlighted text with the AI rewrite"
                          disabled={!draftAiAvailable || !inlineEditState.instruction.trim() || inlineEditState.working}
                        >
                          {inlineEditState.working ? "Rewriting..." : "Replace highlight"}
                        </button>
                      </div>
                    </>
                  )}
                </form>
              )}
            </div>
            <div className="document-toolbar-group document-toolbar-actions">
              <div className="document-insert-control">
                <button
                  type="button"
                  aria-label="Insert content"
                  data-tooltip="Insert an image, chart, table, or page break into the document"
                  aria-expanded={insertMenuOpen}
                  aria-haspopup="menu"
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => { setDocumentToolPanel(null); setInsertMenuOpen((value) => !value); }}
                >
                  <Plus size={16} /><span>Insert</span>
                </button>
                {insertMenuOpen && (
                  <div className="document-insert-menu" role="menu" aria-label="Insert options">
              <button
                type="button"
                role="menuitem"
                aria-label="Link"
                aria-expanded={linkEditState.open}
                data-tooltip="Link the selected text to a web address"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => { setInsertMenuOpen(false); openLinkEditor(); }}
              >
                <Link size={18} /><span>Link</span>
              </button>
              <button
                type="button"
                role="menuitem"
                aria-label="Add citation"
                data-tooltip="Insert a numbered citation backed by your selected source"
                onClick={() => { setInsertMenuOpen(false); insertCitation(); }}
              >
                <BookOpen size={18} /><span>Citation</span>
              </button>

                    <button
                      type="button"
                      role="menuitem"
                      data-tooltip="Find a web image and place it at your cursor"
                      onClick={() => void insertVisual("web-image")}
                    >
                      <ImageIcon size={16} />
                      Web image
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      data-tooltip="Drop an editable chart into the document at your cursor"
                      onClick={() => void insertVisual("chart")}
                    >
                      <BarChart3 size={16} />
                      Chart
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      data-tooltip="Insert a table you can fill in at your cursor"
                      onClick={() => void insertVisual("table")}
                    >
                      <Table2 size={16} />
                      Table
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      data-tooltip="Insert a horizontal divider line at your cursor"
                      onClick={() => void insertVisual("divider")}
                    >
                      <Minus size={16} />
                      Divider
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      data-tooltip="Start a new page at the cursor position"
                      onClick={() => void insertVisual("page-break")}
                    >
                      <FileText size={16} />
                      Page break
                    </button>
                  </div>
                )}
              </div>
              <button
                className={`document-edits-toggle ${showEdits ? "is-on" : ""} ${
                  hasUnsavedEdits ? "is-editing" : "is-saved"
                }`}
                type="button"
                aria-pressed={showEdits}
                onClick={() => {
                  setShowEdits((value) => !value);
                  setStatus(reviewModeStatus);
                }}
                aria-label={reviewModeStatus}
                data-tooltip="Show or hide the AI edit highlights in the document"
              >
                <CheckCircle2 size={18} />
                {reviewModeLabel}
              </button>
            </div>
            </div>
          </div>
          )}

          {draftKind === "deck" && deckState && (
            <div
              className={`document-toolbar ${mobileFormattingExpanded ? "is-mobile-expanded" : ""}`}
              aria-label="Deck formatting"
            >
              <button
                className="document-mobile-toolbar-toggle"
                type="button"
                aria-label={`${mobileFormattingExpanded ? "Collapse" : "Expand"} deck formatting`}
                aria-controls="deck-formatting-controls"
                aria-expanded={mobileFormattingExpanded}
                onClick={() => setMobileFormattingExpanded((value) => !value)}
              >
                <span className="document-mobile-toolbar-copy">
                  <Settings2 size={17} aria-hidden="true" />
                  <span>
                    <strong>Deck formatting</strong>
                    <small>
                      {selectedSlide
                        ? deckState.slides.findIndex((slide) => slide.id === selectedSlide.id) + 1
                        : 0}
                      {" of "}
                      {deckState.slides.length} selected
                    </small>
                  </span>
                </span>
                <ChevronDown className="document-mobile-toolbar-chevron" size={17} aria-hidden="true" />
              </button>
              <div className="document-toolbar-content" id="deck-formatting-controls">
              <div className="document-toolbar-group document-toolbar-main">
                <button
                  type="button"
                  aria-label="Undo deck edit"
                  data-tooltip="Undo the last change made in this deck"
                  onClick={undoDeckChange}
                  disabled={!deckUndoStack.length}
                >
                  <Undo2 size={18} />
                </button>
                <button
                  type="button"
                  aria-label="Redo deck edit"
                  data-tooltip="Redo the last deck change you undid"
                  onClick={redoDeckChange}
                  disabled={!deckRedoStack.length}
                >
                  <Redo2 size={18} />
                </button>
                <span className="document-toolbar-divider" aria-hidden="true" />
                <SelectControl
                  className="document-font-select"
                  aria-label="Slide text font"
                  data-tooltip="Change the font of the highlighted slide text"
                  value={fontFamilyValue}
                  onChange={(event) => applyFontFamily(event.currentTarget.value)}
                >
                  {DRAFT_FONT_FAMILIES.map((family) => (
                    <option key={family.value} value={family.value}>
                      {family.label}
                    </option>
                  ))}
                </SelectControl>
                <span
                  className="document-size-control"
                  data-tooltip="Change the size of the highlighted slide text (PowerPoint points)"
                >
                  <ALargeSmall size={17} aria-hidden="true" />
                  <SelectControl
                    className="document-size-select"
                    aria-label="Slide text size"
                    value={deckFontSizeValue}
                    onChange={(event) => applyDeckFontSize(event.currentTarget.value)}
                  >
                    {DECK_FONT_SIZES.map((size) => (
                      <option key={size.value} value={size.value}>
                        {size.label}
                      </option>
                    ))}
                  </SelectControl>
                </span>
                <span className="document-toolbar-divider" aria-hidden="true" />
                <button
                  type="button"
                  aria-label="Bold"
                  aria-pressed={formatState.bold}
                  data-tooltip="Make the selected bullet text bold"
                  onClick={() => runDeckTextCommand("bold", "Bold formatting applied.")}
                >
                  <Bold size={18} />
                </button>
                <button
                  type="button"
                  aria-label="Italic"
                  aria-pressed={formatState.italic}
                  data-tooltip="Set the selected bullet text in italics"
                  onClick={() => runDeckTextCommand("italic", "Italic formatting applied.")}
                >
                  <Italic size={18} />
                </button>
                <button
                  type="button"
                  aria-label="Underline"
                  aria-pressed={formatState.underline}
                  data-tooltip="Underline the selected bullet text"
                  onClick={() => runDeckTextCommand("underline", "Underline formatting applied.")}
                >
                  <Underline size={18} />
                </button>
                <button
                  type="button"
                  aria-label="Strikethrough"
                  aria-pressed={formatState.strikethrough}
                  data-tooltip="Cross out the selected bullet text"
                  onClick={() => runDeckTextCommand("strikeThrough", "Strikethrough formatting applied.")}
                >
                  <Strikethrough size={18} />
                </button>
                <span className="document-toolbar-divider" aria-hidden="true" />
                <div className="document-color-control" aria-label="Text color control">
                  <input
                    type="color"
                    aria-label="Text color"
                    value={textColor}
                    onChange={(event) => applyTextColor(event.target.value)}
                  />
                  <div className="document-color-swatches" aria-label="Text color presets">
                    {TEXT_COLOR_SWATCHES.map((color) => (
                      <button
                        key={color}
                        type="button"
                        aria-label={`Apply text color ${color}`}
                        data-tooltip={`Recolor the selected bullet text to ${color}`}
                        aria-pressed={textColor === color}
                        onClick={() => applyTextColor(color)}
                        style={{ "--swatch-color": color } as CSSProperties}
                      />
                    ))}
                  </div>
                </div>
                <span className="document-toolbar-divider" aria-hidden="true" />
                <button
                  type="button"
                  aria-label="Clear formatting"
                  data-tooltip="Remove bold, color, and other styling from the selected bullet text"
                  onClick={() => runDeckTextCommand("removeFormat", "Formatting cleared from the selected text.")}
                >
                  <RemoveFormatting size={18} />
                </button>
                <button
                  type="button"
                  aria-label="Copy deck outline"
                  data-tooltip="Copy the whole deck as a text outline for pasting elsewhere"
                  onClick={copyDeckOutline}
                >
                  <Copy size={18} />
                </button>
                <span className="document-toolbar-divider" aria-hidden="true" />
                <div className="document-insert-control">
                  <button
                    type="button"
                    aria-label="Edit selection with AI"
                    aria-expanded={deckAiEditState.open}
                    data-tooltip={draftAiAvailable ? "Highlight slide text, then tell the AI how to change it" : draftAiUnavailableReason}
                    disabled={!draftAiAvailable}
                    onClick={openDeckAiEdit}
                  >
                    <AiPenIcon size={18} />
                  </button>
                  {deckAiEditState.open && (
                    <form
                      className="inline-ai-popover deck-toolbar-popover"
                      role="dialog"
                      aria-label="Edit selection with AI"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void runDeckAiEdit();
                      }}
                    >
                      <div className="inline-ai-popover-header">
                        <strong>Edit selection with AI</strong>
                        <button
                          type="button"
                          aria-label="Close AI edit"
                          data-tooltip="Close without changing the slide"
                          onClick={closeDeckAiEdit}
                        >
                          <X size={15} />
                        </button>
                      </div>
                      <div className="inline-ai-selected-text">
                        <span>Selected text</span>
                        <blockquote>{deckAiEditState.selectionText}</blockquote>
                      </div>
                      <label>
                        <span>What should change?</span>
                        <textarea
                          rows={2}
                          aria-label="AI edit instruction"
                          value={deckAiEditState.instruction}
                          disabled={deckAiEditState.working}
                          placeholder="Make this punchier"
                          onChange={(event) =>
                            setDeckAiEditState((current) => ({
                              ...current,
                              instruction: event.target.value,
                              error: null,
                            }))
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey) {
                              event.preventDefault();
                              void runDeckAiEdit();
                            }
                          }}
                        />
                      </label>
                      <div className="inline-ai-prompts">
                        {["Make it clearer", "Shorten it", "More formal"].map((suggestion) => (
                          <button
                            key={suggestion}
                            type="button"
                            disabled={deckAiEditState.working}
                            data-tooltip={`Use "${suggestion}" as the instruction`}
                            onClick={() =>
                              setDeckAiEditState((current) => ({
                                ...current,
                                instruction: suggestion,
                                error: null,
                              }))
                            }
                          >
                            {suggestion}
                          </button>
                        ))}
                      </div>
                      {deckAiEditState.error && (
                        <p className="document-link-error" role="alert">
                          {deckAiEditState.error}
                        </p>
                      )}
                      <div className="inline-ai-actions">
                        <button
                          type="button"
                          disabled={deckAiEditState.working}
                          data-tooltip="Close without changing the slide"
                          onClick={closeDeckAiEdit}
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          data-tooltip={selectedAgent ? `Rewrite the highlighted text with ${selectedAgent.name}` : draftAiUnavailableReason}
                          disabled={!draftAiAvailable || deckAiEditState.working || !deckAiEditState.instruction.trim()}
                        >
                          {deckAiEditState.working ? "Rewriting…" : "Replace highlight"}
                        </button>
                      </div>
                    </form>
                  )}
                </div>
                <div className="document-insert-control">
                  <button
                    type="button"
                    aria-label="Generate AI slide image"
                    aria-expanded={deckAiImageDialog.open}
                    disabled={!selectedSlide || !imageGenerationAgent}
                    data-tooltip={
                      imageGenerationAgent
                        ? "Generate an AI image from this slide's content and set it as the background"
                        : "No image-generation model is enabled for your workspace"
                    }
                    onClick={openDeckAiImageDialog}
                  >
                    <ImagePlus size={18} />
                  </button>
                  {deckAiImageDialog.open && (
                    <form
                      className="inline-ai-popover deck-toolbar-popover"
                      role="dialog"
                      aria-label="Generate AI slide image"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void generateDeckAiBackground();
                      }}
                    >
                      <div className="inline-ai-popover-header">
                        <strong>AI slide image</strong>
                        <button
                          type="button"
                          aria-label="Close AI image dialog"
                          data-tooltip="Close without changing the slide"
                          onClick={closeDeckAiImageDialog}
                        >
                          <X size={15} />
                        </button>
                      </div>
                      <label>
                        <span>Describe the image (prefilled from this slide)</span>
                        <textarea
                          rows={3}
                          aria-label="AI image description"
                          value={deckAiImageDialog.prompt}
                          disabled={deckAiImageDialog.working}
                          placeholder="A calm harbor at sunrise"
                          onChange={(event) =>
                            setDeckAiImageDialog((current) => ({
                              ...current,
                              prompt: event.target.value,
                              error: null,
                            }))
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey) {
                              event.preventDefault();
                              void generateDeckAiBackground();
                            }
                          }}
                        />
                      </label>
                      {deckAiImageDialog.error && (
                        <p className="document-link-error" role="alert">
                          {deckAiImageDialog.error}
                        </p>
                      )}
                      <div className="inline-ai-actions">
                        <button
                          type="submit"
                          data-tooltip={
                            imageGenerationAgent
                              ? `Generate with ${imageGenerationAgent.name} and set as this slide's background`
                              : "No image-generation model is enabled for your workspace"
                          }
                          disabled={deckAiImageDialog.working || !deckAiImageDialog.prompt.trim()}
                        >
                          {deckAiImageDialog.working ? "Generating…" : "Generate image"}
                        </button>
                      </div>
                    </form>
                  )}
                </div>
                <button
                  type="button"
                  aria-label="Present deck"
                  disabled={deckState.slides.length === 0}
                  data-tooltip={
                    deckState.slides.length === 0
                      ? "Add a slide before presenting"
                      : "Present full screen — click or use the arrow keys to advance, Escape exits"
                  }
                  onClick={() => {
                    const index = selectedSlide
                      ? Math.max(
                          0,
                          deckState.slides.findIndex((slide) => slide.id === selectedSlide.id),
                        )
                      : 0;
                    setDeckPresentation({
                      index,
                      notesOpen: deckState.slides.some((slide) => slide.notes.trim().length > 0),
                    });
                  }}
                >
                  <MonitorPlay size={18} />
                </button>
              </div>
              <div className="document-toolbar-group document-toolbar-actions">
                <span
                  className="document-word-count deck-slide-count"
                  aria-label={`Slide ${
                    selectedSlide
                      ? deckState.slides.findIndex((slide) => slide.id === selectedSlide.id) + 1
                      : 0
                  } of ${deckState.slides.length}`}
                >
                  Slide{" "}
                  {selectedSlide
                    ? deckState.slides.findIndex((slide) => slide.id === selectedSlide.id) + 1
                    : 0}{" "}
                  of {deckState.slides.length}
                </span>
                <div className="document-insert-control">
                  <button
                    type="button"
                    aria-label="Slide background"
                    aria-haspopup="menu"
                    aria-expanded={deckBackgroundMenuOpen}
                    data-tooltip="Put an uploaded image behind this slide, or behind every slide"
                    disabled={!selectedSlide || deckBackgroundWorking}
                    onClick={() => setDeckBackgroundMenuOpen((value) => !value)}
                  >
                    <ImageIcon size={18} />
                  </button>
                  {deckBackgroundMenuOpen && (
                    <div
                      className="document-insert-menu deck-background-menu"
                      role="menu"
                      aria-label="Slide background options"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        data-tooltip="Upload a PNG, JPEG, or WebP from this device as this slide's background"
                        onClick={triggerDeckBackgroundUpload}
                      >
                        <Upload size={16} />
                        {deckBackgroundWorking ? "Reading image…" : "Upload background…"}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        data-tooltip="Use this background on every slide in the deck"
                        disabled={!selectedSlideBackgroundSource}
                        onClick={applyDeckBackgroundToEverySlide}
                      >
                        <Presentation size={16} />
                        Use on every slide
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        data-tooltip="Remove the background uploaded for this slide"
                        disabled={!selectedSlideHasOwnBackground}
                        onClick={removeDeckSlideBackground}
                      >
                        <Trash2 size={16} />
                        Remove from this slide
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        data-tooltip="Clear background images from the whole deck"
                        disabled={!deckHasAnyBackground}
                        onClick={removeDeckBackgroundEverywhere}
                      >
                        <RemoveFormatting size={16} />
                        Clear from all slides
                      </button>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  aria-label="Slide layout"
                  aria-haspopup="menu"
                  aria-expanded={deckLayoutMenuOpen === "switch"}
                  data-tooltip="Change the selected slide's layout"
                  disabled={!selectedSlide}
                  onClick={() =>
                    setDeckLayoutMenuOpen((value) => (value === "switch" ? null : "switch"))
                  }
                >
                  <LayoutTemplate size={18} />
                </button>
              </div>
              </div>
            </div>
          )}

          <span className="sr-only" role="status">
            {status}
          </span>

          {shouldShowChangeSummary && latestSavedVersion && (
            <div className="document-change-summary">
              <strong>Latest saved revision</strong>
              <span>{latestSavedVersion.summary}</span>
              <button
                type="button"
                aria-label="Dismiss saved revision banner"
                data-tooltip="Hide this saved revision summary until the next save"
                onClick={() => setDismissedChangeSummaryVersionId(latestSavedVersion.id)}
              >
                <X size={16} />
              </button>
            </div>
          )}

          {draftKind === "deck" && deckState && (
            <div className="deck-editor-body">
              <div className="deck-filmstrip" aria-label="Slides" ref={deckFilmstripRef}>
                {deckState.slides.map((slide, index) => (
                  <div className="deck-thumb" key={slide.id} data-slide-thumb={slide.id}>
                    {deckDropIndex === index && (
                      <span className="deck-drop-indicator" aria-hidden="true" />
                    )}
                    <button
                      type="button"
                      className={`deck-slide-thumb ${
                        selectedSlide?.id === slide.id ? "is-selected" : ""
                      }`}
                      aria-label={`Slide ${index + 1}: ${DECK_LAYOUT_LABELS[slide.layout]}`}
                      aria-current={selectedSlide?.id === slide.id}
                      data-tooltip="Select this slide; drag to reorder"
                      onClick={() => {
                        endDeckEditSession();
                        setSelectedSlideId(slide.id);
                      }}
                      onPointerDown={(event) => handleDeckThumbPointerDown(event, slide.id)}
                      onPointerMove={handleDeckThumbPointerMove}
                      onPointerUp={handleDeckThumbPointerUp}
                      onPointerCancel={() => {
                        deckDragRef.current = null;
                        setDeckDropIndex(null);
                      }}
                    >
                      <span className="deck-thumb-scale" aria-hidden="true">
                        <DeckSlideStatic slide={slide} theme={deckState.theme} />
                      </span>
                      <span className="deck-thumb-number" aria-hidden="true">
                        {index + 1}
                      </span>
                    </button>
                    <span className="deck-thumb-actions">
                      <button
                        type="button"
                        aria-label={`Move slide ${index + 1} up`}
                        data-tooltip="Move this slide earlier"
                        disabled={index === 0}
                        onClick={() => moveDeckSlide(slide.id, index - 1)}
                      >
                        <ArrowUp size={13} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move slide ${index + 1} down`}
                        data-tooltip="Move this slide later"
                        disabled={index === deckState.slides.length - 1}
                        onClick={() => moveDeckSlide(slide.id, index + 1)}
                      >
                        <ArrowDown size={13} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Duplicate slide ${index + 1}`}
                        data-tooltip="Duplicate this slide"
                        onClick={() => duplicateDeckSlide(slide.id)}
                      >
                        <Copy size={13} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete slide ${index + 1}`}
                        data-tooltip="Delete this slide (undo restores it)"
                        onClick={() => deleteDeckSlide(slide.id)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </span>
                  </div>
                ))}
                {deckDropIndex === deckState.slides.length && (
                  <span className="deck-drop-indicator" aria-hidden="true" />
                )}
                <button
                  type="button"
                  className="deck-add-slide"
                  aria-haspopup="menu"
                  aria-expanded={deckLayoutMenuOpen === "add"}
                  data-tooltip="Add a slide from a layout"
                  onClick={() =>
                    setDeckLayoutMenuOpen((value) => (value === "add" ? null : "add"))
                  }
                >
                  <Plus size={16} />
                  Add slide
                </button>
              </div>
              <div className="deck-stage-column">
                {selectedSlide ? (
                  <>
                    {/* Fixed-position pill; must live OUTSIDE the scaled
                        .deck-stage or the transform would re-anchor it. */}
                    {deckAiSelectionOffer && !deckAiEditState.open && (
                      <button
                        className="inline-ai-selection-trigger"
                        type="button"
                        style={{ top: deckAiSelectionOffer.top, left: deckAiSelectionOffer.left }}
                        aria-label="Ask AI to edit highlighted slide text"
                        data-tooltip={draftAiAvailable ? "Rewrite the highlighted slide text with AI" : draftAiUnavailableReason}
                        disabled={!draftAiAvailable}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={openDeckAiEdit}
                      >
                        <Sparkles size={14} />
                        Ask AI
                      </button>
                    )}
                    <div
                      className="deck-stage-viewport"
                      ref={deckStageViewportRef}
                      style={{ height: DECK_PREVIEW_HEIGHT_PX * deckStageBox.scale }}
                      onScroll={() => setDeckAiSelectionOffer(null)}
                    >
                      <div
                        className={`deck-stage deck-slide-canvas ${
                          deckAiWorking ? "is-ai-editing" : ""
                        }`}
                        aria-busy={deckAiWorking}
                        onPointerDown={(event) => {
                          const target = event.target as HTMLElement;
                          if (!target.closest("[data-deck-block], [data-deck-handle], .deck-media-slot")) {
                            setDeckActiveBlock(null);
                          }
                        }}
                        style={{
                          width: DECK_PREVIEW_WIDTH_PX,
                          height: DECK_PREVIEW_HEIGHT_PX,
                          left: deckStageBox.left,
                          top: deckStageBox.top,
                          transform: `scale(${deckStageBox.scale})`,
                          ...deckCanvasBackground(selectedSlide, deckState.theme),
                        }}
                      >
                        <DeckSlideMedia slide={selectedSlide} theme={deckState.theme} />
                        {selectedSlide.layout === "image-caption" && (
                          <div
                            className={`deck-media-slot ${
                              selectedSlide.image.src ? "has-image" : "is-empty"
                            }`}
                            onClick={() =>
                              setDeckActiveBlock({ slideId: selectedSlide.id, region: "image" })
                            }
                            style={{
                              left: resolvedMediaBox(selectedSlide)?.x,
                              top: resolvedMediaBox(selectedSlide)?.y,
                              width: resolvedMediaBox(selectedSlide)?.w,
                              height: resolvedMediaBox(selectedSlide)?.h,
                            }}
                          >
                            {!selectedSlide.image.src && (
                              <>
                                <ImageIcon size={26} />
                                <span>No image yet</span>
                              </>
                            )}
                            <span className="deck-media-slot-actions">
                              <button
                                type="button"
                                data-tooltip="Generate an AI image or find a web image for this slide"
                                onClick={() => openDeckImageDialog(selectedSlide.id)}
                              >
                                {selectedSlide.image.src ? "Replace image" : "Add image"}
                              </button>
                              {selectedSlide.image.src && (
                                <button
                                  type="button"
                                  data-tooltip="Remove this slide's image"
                                  onClick={() => removeDeckSlideImage(selectedSlide.id)}
                                >
                                  Remove
                                </button>
                              )}
                            </span>
                          </div>
                        )}
                        {slideDecorations(selectedSlide.layout).map((decoration, index) => (
                          <span
                            key={`decoration-${index}`}
                            className="deck-decoration"
                            style={{
                              left: decoration.box.x,
                              top: decoration.box.y,
                              width: decoration.box.w,
                              height: decoration.box.h,
                              background: deckDecorationColor(
                                deckState.theme,
                                decoration.colorRole,
                              ),
                            }}
                          />
                        ))}
                        {Object.entries(resolvedTextRegions(selectedSlide)).map(
                          ([region, spec]) => {
                            if (deckRegionContent(selectedSlide, region) === null) return null;
                            const isBullets = deckRegionIsBullets(selectedSlide, region);
                            return (
                              <div
                                key={`${selectedSlide.id}:${region}`}
                                data-deck-block=""
                                role="textbox"
                                aria-multiline="true"
                                aria-label={`${DECK_LAYOUT_LABELS[selectedSlide.layout]} slide ${region}`}
                                className={`deck-block deck-block--${region} ${
                                  isBullets ? "is-bullets" : ""
                                }`}
                                style={deckRegionStyle(spec, deckState.theme, selectedSlide)}
                                contentEditable
                                suppressContentEditableWarning
                                spellCheck
                                data-placeholder={deckRegionPlaceholder(selectedSlide, region)}
                                ref={(element) => {
                                  registerDeckBlock(element, selectedSlide.id, region);
                                  if (element && !element.innerHTML) {
                                    element.innerHTML = deckRegionHtml(selectedSlide, region);
                                  }
                                }}
                                onFocus={() => {
                                  beginDeckEditSession();
                                  setDeckActiveBlock({ slideId: selectedSlide.id, region });
                                }}
                                onInput={(event) =>
                                  handleDeckBlockInput(
                                    selectedSlide.id,
                                    region,
                                    event.currentTarget,
                                  )
                                }
                                onBlur={endDeckEditSession}
                                onKeyDown={isBullets ? handleDeckBulletsKeyDown : undefined}
                                onKeyUp={captureDeckAiSelection}
                                onMouseUp={captureDeckAiSelection}
                                onSelect={captureDeckAiSelection}
                              />
                            );
                          },
                        )}
                        {deckActiveBlock &&
                          deckActiveBlock.slideId === selectedSlide.id &&
                          (() => {
                            const frameBox = deckBlockBoxForRegion(
                              selectedSlide,
                              deckActiveBlock.region,
                            );
                            if (!frameBox) return null;
                            return (
                              <div
                                className="deck-block-frame"
                                style={{
                                  left: frameBox.x,
                                  top: frameBox.y,
                                  width: frameBox.w,
                                  height: frameBox.h,
                                }}
                              >
                                {DECK_RESIZE_CORNERS.map((corner) => (
                                  <button
                                    key={corner}
                                    type="button"
                                    data-deck-handle=""
                                    className={`deck-block-handle deck-block-handle--${corner}`}
                                    aria-label={`Resize the ${deckActiveBlock.region} block from the ${DECK_CORNER_LABELS[corner]} corner`}
                                    data-tooltip="Drag to resize this block. Arrow keys nudge; double-click restores the layout size."
                                    onPointerDown={(event) => beginDeckBlockResize(event, corner)}
                                    onPointerMove={moveDeckBlockResize}
                                    onPointerUp={endDeckBlockResize}
                                    onPointerCancel={endDeckBlockResize}
                                    onDoubleClick={resetDeckBlockBox}
                                    onKeyDown={(event) => nudgeDeckBlockCorner(event, corner)}
                                  />
                                ))}
                              </div>
                            );
                          })()}
                      </div>
                      <button
                        type="button"
                        className="deck-layout-control"
                        aria-haspopup="menu"
                        aria-expanded={deckLayoutMenuOpen === "switch"}
                        data-tooltip="Change this slide's layout"
                        onClick={() =>
                          setDeckLayoutMenuOpen((value) => (value === "switch" ? null : "switch"))
                        }
                      >
                        <LayoutTemplate size={14} />
                        {DECK_LAYOUT_LABELS[selectedSlide.layout]}
                      </button>
                      {deckLayoutMenuOpen && (
                        <div
                          className="document-insert-menu deck-layout-menu"
                          role="menu"
                          aria-label={
                            deckLayoutMenuOpen === "add"
                              ? "Add a slide with this layout"
                              : "Switch this slide's layout"
                          }
                        >
                          {SUPPORTED_DECK_LAYOUTS.map((layout) => (
                            <button
                              key={layout}
                              type="button"
                              role="menuitem"
                              data-tooltip={
                                deckLayoutMenuOpen === "add"
                                  ? `Add a ${DECK_LAYOUT_LABELS[layout]} slide`
                                  : `Use the ${DECK_LAYOUT_LABELS[layout]} layout`
                              }
                              onClick={() =>
                                deckLayoutMenuOpen === "add"
                                  ? addDeckSlide(layout)
                                  : switchDeckSlideLayout(layout)
                              }
                            >
                              <span
                                className={`deck-layout-glyph is-${layout}`}
                                aria-hidden="true"
                              />
                              {DECK_LAYOUT_LABELS[layout]}
                            </button>
                          ))}
                        </div>
                      )}
                      {deckImageDialog.open && (
                        <form
                          className="inline-ai-popover deck-image-dialog"
                          role="dialog"
                          aria-label="Slide image"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void generateDeckSlideImage();
                          }}
                        >
                          <div className="inline-ai-popover-header">
                            <strong>Slide image</strong>
                            <button
                              type="button"
                              aria-label="Close slide image dialog"
                              data-tooltip="Close without changing the slide"
                              onClick={closeDeckImageDialog}
                            >
                              <X size={15} />
                            </button>
                          </div>
                          <label>
                            <span>Describe the image</span>
                            <input
                              type="text"
                              aria-label="Image description"
                              value={deckImageDialog.prompt}
                              disabled={Boolean(deckImageDialog.working)}
                              placeholder="Boston skyline at dusk"
                              onChange={(event) =>
                                setDeckImageDialog((current) => ({
                                  ...current,
                                  prompt: event.target.value,
                                  error: null,
                                }))
                              }
                            />
                          </label>
                          {deckImageDialog.error && (
                            <p className="document-link-error" role="alert">
                              {deckImageDialog.error}
                            </p>
                          )}
                          <div className="inline-ai-actions">
                            <button
                              type="button"
                              data-tooltip="Find a real web image matching this description"
                              disabled={
                                Boolean(deckImageDialog.working) || !deckImageDialog.prompt.trim()
                              }
                              onClick={() => void findDeckWebImage()}
                            >
                              {deckImageDialog.working === "web" ? "Searching…" : "Find web image"}
                            </button>
                            <button
                              type="submit"
                              data-tooltip={
                                imageGenerationAgent
                                  ? `Generate an image with ${imageGenerationAgent.name}`
                                  : "No image-generation model is enabled for your workspace"
                              }
                              disabled={
                                Boolean(deckImageDialog.working) ||
                                !deckImageDialog.prompt.trim() ||
                                !imageGenerationAgent
                              }
                            >
                              {deckImageDialog.working === "generate"
                                ? "Generating…"
                                : "Generate AI image"}
                            </button>
                          </div>
                        </form>
                      )}
                    </div>
                    <div className={`deck-notes-strip ${deckNotesOpen ? "is-open" : ""}`}>
                      <button
                        type="button"
                        aria-expanded={deckNotesOpen}
                        data-tooltip="Speaker notes for this slide. They export with the PowerPoint file and the Markdown outline, and they follow you in presentation mode."
                        onClick={() => setDeckNotesOpen((value) => !value)}
                      >
                        <ChevronDown size={14} />
                        Speaker notes
                        <small>included in exports</small>
                      </button>
                      {deckNotesOpen && (
                        <textarea
                          className="deck-notes-input"
                          aria-label="Speaker notes"
                          placeholder="No notes for this slide yet."
                          value={selectedSlide.notes}
                          onFocus={beginDeckEditSession}
                          onChange={(event) =>
                            updateDeckSlideNotes(selectedSlide.id, event.target.value)
                          }
                          onBlur={endDeckEditSession}
                        />
                      )}
                    </div>
                    {deckPresentation && (
                      <DeckPresentationOverlay
                        slides={deckState.slides}
                        theme={deckState.theme}
                        index={Math.min(deckPresentation.index, deckState.slides.length - 1)}
                        notesOpen={deckPresentation.notesOpen}
                        onIndexChange={(index) =>
                          setDeckPresentation((value) => (value ? { ...value, index } : value))
                        }
                        onToggleNotes={() =>
                          setDeckPresentation((value) =>
                            value ? { ...value, notesOpen: !value.notesOpen } : value,
                          )
                        }
                        onExit={() => setDeckPresentation(null)}
                      />
                    )}
                  </>
                ) : (
                  <div className="deck-empty-state">
                    <Presentation size={28} />
                    <strong>No slides yet</strong>
                    <p>Add a slide to start from a layout.</p>
                    <button type="button" onClick={() => setDeckLayoutMenuOpen("add")}>
                      <Plus size={16} />
                      Add slide
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {draftKind === "document" && (
          <div className={`document-editor-body ${citationsOpen ? "has-citation-panel" : ""}`}>
            <div
              ref={pageScrollRef}
              className="document-page-scroll"
              onScroll={() => {
                updatePageMetrics();
                setInlineAiSelectionOffer(null);
              }}
            >
              {inlineAiSelectionOffer && !inlineEditState.open && (
                <button
                  className="inline-ai-selection-trigger"
                  type="button"
                  style={{ top: inlineAiSelectionOffer.top, left: inlineAiSelectionOffer.left }}
                  aria-label="Ask AI to edit highlighted text"
                  data-tooltip={!draftAiAvailable ? draftAiUnavailableReason : undefined}
                  disabled={!draftAiAvailable}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={openInlineAiEdit}
                >
                  <Sparkles size={14} />
                  Ask AI
                </button>
              )}
              <div className="document-ruler">
                <div className="document-ruler-track">
                  <button
                    type="button"
                    className="document-ruler-handle is-first"
                    style={{ left: indentLeft + indentFirstLine }}
                    role="slider"
                    aria-orientation="horizontal"
                    aria-label="First line indent"
                    aria-valuemin={-RULER_INDENT_MAX}
                    aria-valuemax={RULER_INDENT_MAX}
                    aria-valuenow={indentFirstLine}
                    aria-valuetext={`First line indent ${indentFirstLine} pixels`}
                    data-tooltip="Drag to indent only the first line of each paragraph"
                    onPointerDown={(event) => beginIndentDrag(event, "first")}
                    onPointerMove={moveIndentDrag}
                    onPointerUp={endIndentDrag}
                    onPointerCancel={endIndentDrag}
                    onKeyDown={(event) => nudgeIndent(event, "first")}
                  />
                  <button
                    type="button"
                    className="document-ruler-handle is-left"
                    style={{ left: indentLeft }}
                    role="slider"
                    aria-orientation="horizontal"
                    aria-label="Left indent"
                    aria-valuemin={0}
                    aria-valuemax={RULER_INDENT_MAX}
                    aria-valuenow={indentLeft}
                    aria-valuetext={`Left indent ${indentLeft} pixels`}
                    data-tooltip="Drag to move the whole text block in from the left edge"
                    onPointerDown={(event) => beginIndentDrag(event, "left")}
                    onPointerMove={moveIndentDrag}
                    onPointerUp={endIndentDrag}
                    onPointerCancel={endIndentDrag}
                    onKeyDown={(event) => nudgeIndent(event, "left")}
                  />
                  <button
                    type="button"
                    className="document-ruler-handle is-right-top"
                    style={{ right: indentRight }}
                    aria-hidden="true"
                    tabIndex={-1}
                    data-tooltip="Drag to pull the text in from the right edge"
                    onPointerDown={(event) => beginIndentDrag(event, "right")}
                    onPointerMove={moveIndentDrag}
                    onPointerUp={endIndentDrag}
                    onPointerCancel={endIndentDrag}
                  />
                  <button
                    type="button"
                    className="document-ruler-handle is-right"
                    style={{ right: indentRight }}
                    role="slider"
                    aria-orientation="horizontal"
                    aria-label="Right indent"
                    aria-valuemin={0}
                    aria-valuemax={RULER_INDENT_MAX}
                    aria-valuenow={indentRight}
                    aria-valuetext={`Right indent ${indentRight} pixels`}
                    data-tooltip="Drag to pull the text in from the right edge"
                    onPointerDown={(event) => beginIndentDrag(event, "right")}
                    onPointerMove={moveIndentDrag}
                    onPointerUp={endIndentDrag}
                    onPointerCancel={endIndentDrag}
                    onKeyDown={(event) => nudgeIndent(event, "right")}
                  />
                </div>
              </div>
              {renderedPageCount > 1 && (
                <div
                  className="document-page-navigator"
                  role="navigation"
                  aria-label={`Page navigation. Page ${currentPage} of ${renderedPageCount}`}
                >
                  <button
                    className="is-previous"
                    type="button"
                    aria-label="Previous page"
                    data-tooltip="Jump back to the previous page of the document"
                    onClick={() => goToDocumentPage(currentPage - 1)}
                    disabled={currentPage <= 1}
                  >
                    <ChevronDown size={16} />
                  </button>
                  <span className="document-page-count" aria-hidden="true">
                    <span>Page</span>
                    <strong>
                      {currentPage}/{renderedPageCount}
                    </strong>
                  </span>
                  <button
                    type="button"
                    aria-label="Next page"
                    data-tooltip="Jump ahead to the next page of the document"
                    onClick={() => goToDocumentPage(currentPage + 1)}
                    disabled={currentPage >= renderedPageCount}
                  >
                    <ChevronDown size={16} />
                  </button>
                </div>
              )}
              <article
                ref={editorRef}
                className={`document-canvas document-rich-editor ${
                  isPaginatedDocument ? "is-paginated" : ""
                } ${showEdits ? "show-edits" : ""} ${
                  documentAiEditing ? "is-ai-editing" : ""
                } ${aiEditsFresh ? "has-fresh-ai-edits" : ""} ${
                  aiTrailOpen ? "show-ai-edits" : ""
                }`}
                aria-label="Document body"
                aria-busy={documentAiEditing}
                aria-multiline="true"
                contentEditable
                role="textbox"
                spellCheck
                suppressContentEditableWarning
                style={
                  {
                    "--doc-indent-left": `${indentLeft}px`,
                    "--doc-indent-right": `${indentRight}px`,
                    "--doc-indent-first": `${indentFirstLine}px`,
                  } as CSSProperties
                }
                onInput={(event) => {
                  skipNextEditorSyncRef.current = true;
                  normalizedLayoutHtmlRef.current = null;
                  setInlineAiSelectionOffer(null);
                  if (content !== event.currentTarget.innerHTML) {
                    recordUndoSnapshot(content);
                  }
                  setContent(event.currentTarget.innerHTML);
                  setStatus("Draft edited manually.");
                }}
                onKeyDown={handleEditorKeyDown}
                onKeyUp={captureInlineAiSelection}
                onMouseUp={captureInlineAiSelection}
                onSelect={captureInlineAiSelection}
                onBlur={(event) => scheduleSheetOverflowHeal(event.currentTarget.innerHTML)}
              />
            </div>
            {citationsOpen && (
              <aside className="document-citation-panel" aria-label="Citation workspace">
                <div className="citation-panel-header">
                  <div>
                    <strong>Citations</strong>
                    <span>{sourceSummary.documentCount} indexed files available</span>
                  </div>
                  <button
                    type="button"
                    aria-label="Close citation workspace"
                    data-tooltip="Close the citations panel and give the document more room"
                    onClick={() => setCitationsOpen(false)}
                  >
                    <X size={16} />
                  </button>
                </div>
                <div className="citation-panel-list">
                  {sourceSummary.activeKnowledge.map((source, index) => (
                    <button
                      key={source.id}
                      type="button"
                      className="citation-source-row"
                      data-tooltip={`Insert a citation from ${source.name} at your cursor`}
                      onClick={() => insertCitation()}
                    >
                      <span>[{index + 1}]</span>
                      <strong>{source.name}</strong>
                      <small>
                        {source.source} · {source.document_count} files
                      </small>
                    </button>
                  ))}
                  {attachedFiles.map((file, index) => (
                    <button
                      key={file.id}
                      type="button"
                      className="citation-source-row"
                      data-tooltip={`Insert a citation from ${file.name} at your cursor`}
                      onClick={() => insertCitation()}
                    >
                      <span>[U{index + 1}]</span>
                      <strong>{file.name}</strong>
                      <small>{file.size} upload</small>
                    </button>
                  ))}
                </div>
              </aside>
            )}
          </div>
          )}
        </main>
        {compareOpen && redlineDiff && compareBaseVersion && compareComparisonVersion && (
          <div className="modal-backdrop" role="presentation" onClick={closeVersionCompare}>
            <section
              className="modal draft-redline-modal"
              role="dialog"
              aria-modal="true"
              aria-label="Visual redline"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Escape") closeVersionCompare();
              }}
            >
              <header className="draft-redline-header">
                <div className="draft-redline-heading">
                  <strong>Visual redline</strong>
                  <span className="draft-redline-qualifier">Not DOCX tracked changes</span>
                </div>
                <button
                  type="button"
                  aria-label="Close visual redline"
                  data-tooltip="Close the comparison without changing either version"
                  onClick={closeVersionCompare}
                >
                  <X size={16} />
                </button>
              </header>
              <p className="draft-redline-note">
                Read-only comparison of two saved versions. Pick any two snapshots; comparing
                never alters, merges, or saves either one.
              </p>
              <div className="draft-redline-selectors">
                <label>
                  <span>Base version</span>
                  <SelectControl
                    aria-label="Base version"
                    value={compareBaseVersion.id}
                    onChange={(event) => selectCompareVersion("base", event.target.value)}
                  >
                    {versions.map((version) => (
                      <option key={version.id} value={version.id}>
                        {version.label} · {version.time}
                      </option>
                    ))}
                  </SelectControl>
                </label>
                <label>
                  <span>Comparison version</span>
                  <SelectControl
                    aria-label="Comparison version"
                    value={compareComparisonVersion.id}
                    onChange={(event) => selectCompareVersion("comparison", event.target.value)}
                  >
                    {versions.map((version) => (
                      <option key={version.id} value={version.id}>
                        {version.label} · {version.time}
                      </option>
                    ))}
                  </SelectControl>
                </label>
              </div>
              <p className="sr-only">{redlineDiff.summary}</p>
              {redlineDiff.fallbackReason && (
                <p className="draft-redline-fallback" role="status">
                  {redlineDiff.fallbackReason}
                </p>
              )}
              <div className="draft-redline-toolbar">
                <span className="draft-redline-stats">
                  {redlineDiff.stats.changed} changed · {redlineDiff.stats.inserted} inserted ·{" "}
                  {redlineDiff.stats.removed} removed · {redlineDiff.stats.unchanged} unchanged
                </span>
                <div className="draft-redline-nav">
                  <button
                    type="button"
                    aria-label="Previous change"
                    data-tooltip="Jump to the previous change"
                    onClick={() => stepRedlineChange(-1)}
                    disabled={!redlineChangeCount}
                  >
                    <ArrowUp size={15} />
                  </button>
                  <button
                    type="button"
                    aria-label="Next change"
                    data-tooltip="Jump to the next change"
                    onClick={() => stepRedlineChange(1)}
                    disabled={!redlineChangeCount}
                  >
                    <ArrowDown size={15} />
                  </button>
                  <span className="draft-redline-nav-status" aria-live="polite">
                    {redlineChangeCount === 0
                      ? "No changes"
                      : redlineChangeCursor < 0
                        ? `${redlineChangeCount} change${redlineChangeCount === 1 ? "" : "s"}`
                        : `Change ${redlineChangeCursor + 1} of ${redlineChangeCount}`}
                  </span>
                </div>
              </div>
              <div className="draft-redline-body" aria-label="Version differences">
                {annotatedRedlineRows.map(({ row, changeIndex }, index) => (
                  <div
                    key={index}
                    className={`redline-row is-${row.type}`}
                    tabIndex={changeIndex >= 0 ? -1 : undefined}
                    aria-current={
                      changeIndex >= 0 && changeIndex === redlineChangeCursor ? "true" : undefined
                    }
                    ref={
                      changeIndex >= 0
                        ? (element) => {
                            if (element) redlineChangeRefs.current.set(changeIndex, element);
                          }
                        : undefined
                    }
                  >
                    <span className="redline-row-label">{redlineRowLabel(row)}</span>
                    <p className="redline-text">{renderRedlineRowContent(row)}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </section>
    </div>
  );
}

function redlineRowLabel(row: RedlineRow) {
  if (row.type === "changed") return `${row.base.label} · changed`;
  return `${row.block.label} · ${row.type}`;
}

function redlineBlockBody(block: RedlineBlock) {
  if (block.kind === "media") {
    return block.detail ? `${block.label}: ${block.detail}` : block.label;
  }
  return block.text;
}

/** Diff tokens render as plain text inside semantic ins/del elements — stored
 * HTML is never reinstated through innerHTML here. */
function renderRedlineRowContent(row: RedlineRow) {
  if (row.type === "changed") {
    return row.tokens.map((token, index) => {
      const spacer = index > 0 ? " " : "";
      if (token.type === "ins") {
        return (
          <Fragment key={index}>
            {spacer}
            <ins className="redline-ins">{token.text}</ins>
          </Fragment>
        );
      }
      if (token.type === "del") {
        return (
          <Fragment key={index}>
            {spacer}
            <del className="redline-del">{token.text}</del>
          </Fragment>
        );
      }
      return <Fragment key={index}>{`${spacer}${token.text}`}</Fragment>;
    });
  }
  const body = redlineBlockBody(row.block);
  if (row.type === "inserted") return <ins className="redline-ins">{body}</ins>;
  if (row.type === "removed") return <del className="redline-del">{body}</del>;
  return body;
}

function draftTemplatesFromData(data: BootstrapData): DraftTemplate[] {
  const libraryTemplates = data.promptTemplates
    .filter((template) => template.enabled)
    .map<DraftTemplate>((template) => ({
      id: `library-${template.id}`,
      name: template.name,
      category: "Library",
      description: template.description,
      defaultTitle: `${template.name} Draft`,
      promptHint: template.content,
      body: libraryPromptTemplateBody(template.name, template.description, template.content),
      keywords: [
        template.name,
        template.category,
        template.description,
        ...template.variables,
      ],
      requiresCitations: /cite|source|matter|client/i.test(template.content),
      requiresApproval: /approval|approver|external|send/i.test(template.content),
    }));
  return [...BUILT_IN_DRAFT_TEMPLATES, ...libraryTemplates];
}

function persistedWordTemplateToDraftTemplate(template: PersistedWordTemplate): DraftTemplate {
  return {
    id: template.id,
    name: template.name,
    category: "Uploaded",
    description: template.description,
    defaultTitle: template.name,
    promptHint: `Use the uploaded Word template from ${template.filename}.`,
    body: template.text,
    keywords: [
      template.name,
      template.filename,
      "uploaded",
      "word",
      "docx",
      "template",
    ],
    requiresCitations: false,
    requiresApproval: false,
    sourceHtml: template.html,
    sourceFilename: template.filename,
  };
}

function draftingAgentsFromData(data: BootstrapData): DraftAgentOption[] {
  const enabledModels = approvedWorkspaceModels(data);
  const orderedModels = [
    ...enabledModels.filter((model) => model.is_custom),
    ...enabledModels.filter((model) => !model.is_custom),
  ];
  const agents = orderedModels.map<DraftAgentOption>((model) => ({
    id: model.id,
    name: model.name,
    providerName: model.provider_name,
    description:
      model.notes ??
      `${model.provider_name} drafting model with ${model.context_window?.toLocaleString() ?? "configured"} context.`,
  }));
  return agents;
}

/** Upper bound on template text sent to the drafting model. Large uploaded
 * agreements are truncated at a line boundary instead of silently dropped. */
const TEMPLATE_CONTEXT_CHAR_LIMIT = 20000;

function templateStructureContext(template: DraftTemplate) {
  const body = template.body.trim();
  if (!body) {
    return `Apply the selected ${template.name} template structure without exposing prompt metadata.`;
  }
  let excerpt = body;
  let truncated = false;
  if (excerpt.length > TEMPLATE_CONTEXT_CHAR_LIMIT) {
    const lineBoundary = excerpt.lastIndexOf("\n", TEMPLATE_CONTEXT_CHAR_LIMIT);
    excerpt = excerpt.slice(0, lineBoundary > TEMPLATE_CONTEXT_CHAR_LIMIT / 2 ? lineBoundary : TEMPLATE_CONTEXT_CHAR_LIMIT);
    truncated = true;
  }
  return [
    `Follow the selected "${template.name}" template. The template content between the markers is the authoritative structure: keep its section order, headings, clause numbering, and boilerplate wording. Replace bracketed placeholders and blank underscore lines with specifics from the user request, and keep underscore blanks where the request does not supply the detail. Do not mention the template or these instructions inside the document.`,
    "--- TEMPLATE START ---",
    `${excerpt}${truncated ? "\n[Template excerpt truncated for length; continue the same structure and conventions through the end of the document.]" : ""}`,
    "--- TEMPLATE END ---",
  ].join("\n");
}

/** Words that identify the genre of document being asked for. A drafting
 * model writes a far more realistic instrument when it is told the conventions
 * of that genre, so the request (and the chosen template, when there is one)
 * picks the craft rules below. */
const LEGAL_INSTRUMENT_PATTERN =
  /\b(contract|agreement|nda|non-?disclosure|msa|sow|statement of work|engagement letter|retainer|lease|sublease|amendment|addendum|assignment|waiver|release|indemnit|term sheet|letter of intent|loi|bylaws|operating agreement|partnership|promissory note|deed|easement|will|codicil|trust|power of attorney|settlement|licen[cs]e agreement|terms of service|privacy policy|employment offer|severance|consulting agreement|purchase agreement|bill of sale|memorandum of understanding|mou|stipulation|affidavit|declaration|pleading|motion|complaint|brief)\b/i;

const FISCAL_DOCUMENT_PATTERN =
  /\b(invoice|statement of account|remittance|quote|quotation|estimate|purchase order|expense report|budget|forecast|p&l|profit and loss|income statement|balance sheet|cash flow|financial statement|fee schedule|rate card|capitalization table|cap table|payroll|reimbursement)\b/i;

/** Shared craft rules: what separates a real deliverable from AI-shaped prose,
 * in the terms the editor can actually render. */
const DOCUMENT_CRAFT_BASE = [
  "Write the finished deliverable itself. No preamble, no closing commentary, no notes about what you did, and no headings such as \"Draft\" or \"Document\" wrapped around the real title.",
  "Where a fact is not supplied, leave a bracketed placeholder such as [Party Legal Name], [Effective Date], or [Address] — never invent parties, addresses, dollar amounts, dates, statutes, or case citations.",
  "Where the reader is meant to write or sign on the page, put a run of underscores (________________); the editor renders those as true ruled lines.",
  "Match the length and density the document type actually has. A real instrument is complete, not a summary of itself.",
  "Include a code block only when the request actually asks for code or the document is an engineering deliverable that needs it. A business, legal, or financial document carries prose, tables, and lists — never a script.",
];

const LEGAL_INSTRUMENT_CRAFT = [
  "This is a legal instrument. Draft it the way a practicing attorney would, in this order:",
  "1. Title in capitals on its own line, then a preamble identifying the instrument, its effective date, and each party by full legal name, entity type, jurisdiction of formation, and address — giving each a short defined term in quotes and parentheses, e.g. (\"Provider\").",
  "2. Recitals as WHEREAS paragraphs when the instrument type conventionally uses them, closing with the NOW, THEREFORE consideration clause.",
  "3. Operative provisions as numbered Articles or Sections. Give every one a real Markdown heading that carries its number and title (## ARTICLE 1. SERVICES, then ### 1.1 Scope of Services) — never a bold paragraph standing in for a heading — and number subsections hierarchically (1., 1.1, 1.1(a)). Keep one obligation per clause.",
  "4. Include the provisions this deal actually needs, in conventional order — scope, term and termination, fees and payment terms, taxes, intellectual property, confidentiality, representations and warranties, indemnification, limitation of liability, insurance, assignment, notices with addresses, governing law and venue, dispute resolution, force majeure, entire agreement, amendment, waiver, severability, and counterparts/electronic signature — and leave out the ones that do not fit.",
  "5. Define a term once, capitalize it consistently after that, and never use a defined term before it is defined.",
  "6. Write amounts, periods, and deadlines the way instruments do: Thirty (30) days, $50,000 (Fifty Thousand and 00/100 Dollars), \"within ten (10) business days after receipt\".",
  "7. Close with an IN WITNESS WHEREOF paragraph and a signature block for each party: entity name, then By, Name, Title, and Date lines with underscore rules.",
  "8. Put any exhibit, schedule, or annex after the signature block under its own heading, and reference it from the clause that uses it.",
  "9. An executed instrument carries no research apparatus: never annotate clauses with [Source: ...] notes, statute lookups, or verification brackets. Cite authority only where the instrument itself would — a governing-law clause, a statutory definition it adopts, a regulation it requires compliance with.",
];

const FISCAL_DOCUMENT_CRAFT = [
  "This is a financial document. Draft it the way an accounting or finance team would:",
  "1. Open with the issuing organization and the recipient, then the document's identifying details — number, issue date, period covered, payment due date — as short labelled lines. Use real Markdown headings for each section of the document rather than bold paragraphs.",
  "2. Put every figure in a Markdown pipe table with a separator row. Right-align numeric columns using the ---: form in that separator so the editor renders them as real numeric columns.",
  "3. Itemize before you total: description, quantity, rate, and amount per line, then subtotal, adjustments (discount, tax, retainer draw), and the final total as its own bolded row.",
  "4. Do the arithmetic and make it consistent — every total must equal its lines. Format currency with the symbol and thousands separators ($12,450.00) and use the same currency throughout.",
  "5. State payment terms, accepted methods, and remittance instructions explicitly (Net 30, late-fee terms, account details as bracketed placeholders — never invent bank or tax identifiers).",
  "6. Finish with the notes, assumptions, or approval lines the document type carries.",
];

const GENERAL_DOCUMENT_CRAFT = [
  "Structure the document the way this kind of document is actually structured in professional practice: a real title, then the sections a reader of this document expects, in their conventional order. Section titles are Markdown headings (## / ###), not bold paragraphs, so the document keeps a real outline.",
  "Lead each section with its conclusion, then support it. Use tables for anything tabular, and lists only for genuinely parallel items.",
  "Close the way the document type closes — next steps, approvals, signature lines, or appendices — rather than trailing off.",
];

/** Stand-in when a revision has no template: genre detection then rests on the
 * document's own title and the request. */
const BLANK_CRAFT_TEMPLATE = {
  name: "",
  description: "",
  keywords: [] as string[],
};

type DocumentGenre = "legal" | "fiscal" | "general";

function documentGenre(
  request: string,
  template: Pick<DraftTemplate, "name" | "description" | "keywords">,
): DocumentGenre {
  const haystack = `${request} ${template.name} ${template.description} ${template.keywords.join(" ")}`;
  if (LEGAL_INSTRUMENT_PATTERN.test(haystack)) return "legal";
  if (FISCAL_DOCUMENT_PATTERN.test(haystack)) return "fiscal";
  return "general";
}

/** Template categories that would fight the detected genre. A request for a
 * master services agreement can keyword-match the "Implementation Plan"
 * starter on the word "implementation"; naming that as the draft type invites
 * an engineering deliverable, code listings and all. */
const GENRE_TEMPLATE_CATEGORIES: Record<DocumentGenre, string[] | null> = {
  legal: ["Legal", "Business", "Uploaded", "Library"],
  fiscal: ["Finance", "Business", "Uploaded", "Library"],
  general: null,
};

function templateSuitsGenre(template: Pick<DraftTemplate, "category">, genre: DocumentGenre) {
  const allowed = GENRE_TEMPLATE_CATEGORIES[genre];
  return !allowed || allowed.includes(template.category);
}

/** True for documents that are executed or issued as-is. Research apparatus —
 * inline source notes, verification brackets — belongs in a memo, never in the
 * body of an agreement or an invoice. */
function genreRejectsResearchNotes(genre: DocumentGenre) {
  return genre === "legal" || genre === "fiscal";
}

/** Craft rules for the requested document, whether or not a template is in
 * play. This is what makes a from-scratch contract read like a contract. */
function documentCraftGuidance(genre: DocumentGenre) {
  const craft =
    genre === "legal"
      ? LEGAL_INSTRUMENT_CRAFT
      : genre === "fiscal"
        ? FISCAL_DOCUMENT_CRAFT
        : GENERAL_DOCUMENT_CRAFT;
  return [...craft, ...DOCUMENT_CRAFT_BASE].join("\n");
}

function providerDraftPrompt(
  template: DraftTemplate,
  request: string,
  context: DraftContextOptions,
) {
  const genre = documentGenre(request, template);
  const contextLines = [
    `User request: ${request}`,
    templateSuitsGenre(template, genre)
      ? `Draft type: ${template.name}`
      : `Draft type: taken from the user request, not from a starter template. Ignore any unrelated document type you might infer from the workspace.`,
    `Drafting agent: ${context.agentName}`,
    ...( /\bMLA\b/i.test(request) ? ["MLA format: start with the student name, instructor, course, and date on four lines. Use placeholders for missing details. Then a centered plain title, essay body, and Works Cited. No prefatory commentary or separate title page. Use author-page citations; do not add a second Sources appendix."] : []),
    "Write the complete requested document, not an outline or plan.",
    "Return only editable Markdown for the document body.",
    "Do not wrap the document in a code fence (```); output the Markdown directly.",
    "When the request calls for tabular content, use editable Markdown pipe tables with a separator row so the editor renders real document tables.",
    documentCraftGuidance(genre),
  ];
  if (parseRequestedPageCount(request) > 1) {
    contextLines.push(
      "Write enough substantive content for the requested length, but do not insert horizontal rules just to imitate page boundaries. The editor paginates the rendered document to real page capacity. Use a horizontal rule only when the document itself needs an intentional hard page break.",
    );
  }
  if (context.useWebSearch) {
    contextLines.push(
      "Use provider-hosted public web search for current public facts, names, dates, and source-backed claims.",
      genreRejectsResearchNotes(genre)
        ? "Let research inform the drafting, but keep the document clean: no inline source annotations in an executed or issued document. An unverified detail stays a bracketed placeholder."
        : "Include source links or source names inline where they support factual claims.",
    );
  } else {
    contextLines.push(
      "Use the selected model directly. Do not claim live web research unless web search is enabled.",
      genreRejectsResearchNotes(genre)
        ? "If a fact is not supplied, leave a bracketed placeholder in the document itself. Never add [Source: ...] notes, verification brackets, or research commentary to the body of a document that is meant to be executed or issued."
        : "If a claim depends on an external source that is not in context, mark it for verification instead of inventing a citation.",
    );
  }
  if (context.useWorkspaceSources) {
    contextLines.push(
      `Selected workspace source context is available from ${context.primarySourceName}; use it only for claims it supports.`,
    );
  }
  if (context.useTemplateContext) {
    contextLines.push(templateStructureContext(template));
  }
  if (template.requiresApproval) {
    contextLines.push("Mark any external-delivery approval or attorney-review checkpoints clearly.");
  }
  if (template.requiresCitations) {
    contextLines.push("Keep factual claims citation-ready and identify sources that should be checked before export.");
  }
  return contextLines.join("\n\n");
}

function providerRevisionPrompt(
  documentTitle: string,
  currentDraftText: string,
  request: string,
  context: DraftContextOptions,
  template?: DraftTemplate,
) {
  const contextLines = [
    `Document title: ${documentTitle}`,
    `Revision request: ${request}`,
    `Drafting agent: ${context.agentName}`,
    ...( /\bMLA\b/i.test(request) ? ["MLA format: start with the student name, instructor, course, and date on four lines. Use placeholders for missing details. Then a centered plain title, essay body, and Works Cited. No prefatory commentary or separate title page. Use author-page citations; do not add a second Sources appendix."] : []),
    "Revise the current document as the deliverable. Return only editable Markdown for the revised document body.",
    "Do not describe what should be changed; make the changes directly.",
    "This is an in-place transformation of a populated document, not permission to draft a substitute. Preserve every factual claim, supporting detail, quotation, citation, footnote, note, table, list, image, and hyperlink unless the user's request explicitly changes or removes that content.",
    "A formatting, style, tone, citation-style, or template request changes presentation across the document while retaining the document's substantive information. Return the complete transformed document from beginning to end.",
    "Treat every /api/drafts/preserved-assets/ token as immutable document content. Keep each token exactly once unless the user explicitly asks to remove that image or hyperlink.",
    "Preserve existing tables as Markdown pipe tables unless the user explicitly asks to remove or convert them.",
    "When adding or editing table content, include a Markdown separator row such as |---|---| so the editor renders a native table.",
    "Keep the prose in natural document flow. Do not add horizontal rules merely to preserve the old page count; the editor repaginates the revised content to real page capacity.",
    documentCraftGuidance(documentGenre(`${documentTitle} ${request}`, template ?? BLANK_CRAFT_TEMPLATE)),
  ];
  if (context.useWebSearch) {
    contextLines.push(
      "Use provider-hosted public web search only for factual updates that need current public support.",
      "Include source links or source names inline where they support factual changes.",
    );
  } else {
    contextLines.push(
      "Do not claim live web research unless web search is enabled.",
      "If a requested factual update depends on unavailable external information, mark it for verification instead of inventing it.",
    );
  }
  if (context.useWorkspaceSources) {
    contextLines.push(
      `Selected workspace source context is available from ${context.primarySourceName}; use it only for claims it supports.`,
    );
  }
  if (context.useTemplateContext && template) {
    contextLines.push(
      templateStructureContext(template),
      "Restructure the current document to follow the template while keeping the document's substantive content.",
    );
  }
  contextLines.push("Current document:", currentDraftText || "[Blank document]");
  return contextLines.join("\n\n");
}

function revisionReferencesTemplate(request: string, template: DraftTemplate) {
  if (/\btemplate\b/i.test(request)) return true;
  const templateName = template.name.trim().toLowerCase();
  return templateName.length > 2 && request.toLowerCase().includes(templateName);
}

function revisionNeedsWebSearch(request: string) {
  if (
    /\b(remove|delete|strip|drop|omit)\b.{0,60}\b(sources?|citations?|links?|hyperlinks?|urls?)\b/i.test(
      request,
    )
  ) {
    return false;
  }
  return /\b(research|look\s*up|search(?:\s+the)?\s+web|current|latest|recent|today|updated?|verify|fact[- ]?check|source|citation)\b/i.test(
    request,
  );
}

function providerWebDraftTitle(template: DraftTemplate, subject: string) {
  if (template.sourceHtml) return subject ? `${paperTitle(subject)} - ${template.name}` : template.defaultTitle;
  if (template.id === "writing-research-paper") return titleWithSuffix(paperTitle(subject), "Draft");
  if (template.id === "writing-screenplay") return titleWithSuffix(paperTitle(subject), "Screenplay Draft");
  return titleForTemplate(template, subject);
}

function titleWithSuffix(title: string, suffix: string) {
  const cleanTitle = title.trim() || "Requested Document";
  const cleanSuffix = suffix.trim();
  if (!cleanSuffix) return cleanTitle;
  const suffixPattern = new RegExp(`\\s+${escapeRegExp(cleanSuffix)}$`, "i");
  return suffixPattern.test(cleanTitle) ? cleanTitle : `${cleanTitle} ${cleanSuffix}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function appendWebCitationList(content: string, citations: ChatCitation[]) {
  if (/^#{0,3}\s*Works? Cited\s*$/im.test(content)) return content;
  const webCitations = citations.filter(
    (citation) => citation.source_type === "web" && citation.source_uri,
  );
  if (!webCitations.length) return content;
  const sourceList = webCitations
    .slice(0, 10)
    .map((citation, index) => {
      const sourceName = (citation.source_name || citation.source_uri || "Source").replace(/[|\[\]]/g, " ");
      const snippet = citation.snippet ? ` - ${citation.snippet.replace(/\|/g, " ")}` : "";
      return `${index + 1}. [${sourceName}](${citation.source_uri})${snippet}`;
    })
    .join("\n");
  return `${content.trim()}\n\n## Sources\n${sourceList}`;
}

function libraryPromptTemplateBody(name: string, description: string, prompt: string) {
  return `${name} Draft

Summary
This reusable prompt is ready to guide a document draft. Ask the assistant what to write and it will apply this template without pasting prompt metadata into the document.

Drafting Guidance
${description || prompt}`;
}

function textToDocumentHtml(value: string) {
  const blocks = value
    .trim()
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks
    .map((block, index) => {
      const lines = block.split("\n").map((line) => line.trimEnd());
      if (lines.length === 1) {
        const formatted = renderFormattedLine(lines[0]);
        if (formatted) return formatted;
      }
      if (lines.every((line) => line.trim().startsWith("- "))) {
        return `<ul>${lines
          .map((line) => `<li>${escapeHtml(line.replace(/^-\s*/, ""))}</li>`)
          .join("")}</ul>`;
      }
      if (index === 0 && lines.length === 4) {
        return `<p class="document-mla-heading">${lines
          .map((line) => escapeHtml(line))
          .join("<br>")}</p>`;
      }
      if (index === 0 && lines.length === 1) {
        return `<h1>${escapeHtml(lines[0])}</h1>`;
      }
      return `<p>${lines.map((line) => escapeHtml(line)).join("<br>")}</p>`;
    })
    .join("");
}

function renderFormattedLine(line: string) {
  const trimmed = line.trim();
  const formattedPatterns = [
    {
      pattern: /^CENTER:\s*(.+)$/i,
      render: (value: string) => `<p class="document-centered">${escapeHtml(value)}</p>`,
    },
    {
      pattern: /^SCENE:\s*(.+)$/i,
      render: (value: string) => `<p class="screenplay-scene">${escapeHtml(value)}</p>`,
    },
    {
      pattern: /^CHARACTER:\s*(.+)$/i,
      render: (value: string) => `<p class="screenplay-character">${escapeHtml(value)}</p>`,
    },
    {
      pattern: /^DIALOGUE:\s*(.+)$/i,
      render: (value: string) => `<p class="screenplay-dialogue">${escapeHtml(value)}</p>`,
    },
    {
      pattern: /^ACTION:\s*(.+)$/i,
      render: (value: string) => `<p class="screenplay-action">${escapeHtml(value)}</p>`,
    },
    {
      pattern: /^TRANSITION:\s*(.+)$/i,
      render: (value: string) => `<p class="screenplay-transition">${escapeHtml(value)}</p>`,
    },
    {
      pattern: /^SECTION:\s*(.+)$/i,
      render: (value: string) => `<h2 class="contract-section">${escapeHtml(value)}</h2>`,
    },
  ];
  for (const item of formattedPatterns) {
    const match = trimmed.match(item.pattern);
    if (match?.[1]) return item.render(match[1]);
  }
  return null;
}

function documentHtmlToText(value: string) {
  const withBreaks = value
    .replace(/<span[^>]*class="[^"]*document-page-label[^"]*"[^>]*>.*?<\/span>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/(p|h1|h2|h3|blockquote|ul|ol)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (typeof document === "undefined") {
    return withBreaks;
  }
  const decoder = document.createElement("textarea");
  decoder.innerHTML = withBreaks;
  return decoder.value;
}

function documentHasSubstantiveContent(value: string) {
  const words = revisionWordTokens(documentHtmlToText(value));
  if (words.length >= 3) return true;
  return /<(?:img|table|figure|pre)\b/i.test(value);
}

function revisionCompletionTokenBudget(currentDraftText: string, additionalPages: number) {
  if (additionalPages > 0) return 24000;
  const sourceWords = revisionWordTokens(currentDraftText).length;
  if (sourceWords >= 5_000) return 24000;
  // A complete transformed document must fit in the response. Prose commonly
  // consumes 1.3-1.8 tokens per word, with headings, tables, citations, and
  // Markdown adding overhead.
  return Math.max(12000, Math.min(24000, Math.ceil(sourceWords * 1.8) + 2_000));
}

function revisionContentPreservationIssue(
  currentDraftText: string,
  revisedMarkdown: string,
  request: string,
) {
  if (
    isExplicitDraftReplacementRequest(request) ||
    revisionRequestAllowsContentReduction(request)
  ) {
    return null;
  }
  const sourceWords = revisionWordTokens(currentDraftText);
  const revisedWords = revisionWordTokens(revisedMarkdown);
  if (sourceWords.length < 80) return null;

  const minimumWords = Math.ceil(sourceWords.length * 0.82);
  if (revisedWords.length < minimumWords) {
    return `The drafting agent returned only ${revisedWords.length.toLocaleString()} words for a ${sourceWords.length.toLocaleString()}-word document; an in-place transformation must retain at least ${minimumWords.toLocaleString()} words unless shortening is explicitly requested.`;
  }

  // Length alone cannot stop a generic substitute padded to the same size.
  // Require the transformed draft to retain the document's distinctive
  // vocabulary. Translation is the one legitimate transformation that
  // intentionally changes that vocabulary.
  if (!/\btranslate|translation\b/i.test(request)) {
    const sourceTerms = significantRevisionTerms(sourceWords);
    if (sourceTerms.length >= 20) {
      const revisedTerms = new Set(significantRevisionTerms(revisedWords));
      const retainedTerms = sourceTerms.filter((term) => revisedTerms.has(term)).length;
      const minimumTerms = Math.ceil(sourceTerms.length * 0.55);
      if (retainedTerms < minimumTerms) {
        return `The drafting agent retained only ${retainedTerms} of ${sourceTerms.length} distinctive source terms; the response appears to substitute new material instead of transforming the existing document.`;
      }
    }
  }
  return null;
}

function revisionWordTokens(value: string) {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
}

function significantRevisionTerms(words: string[]) {
  return Array.from(new Set(words.filter((word) => word.length >= 6))).sort();
}

function revisionRequestAllowsContentReduction(request: string) {
  return /\b(?:summari[sz]e|condense|shorten|abridge|compress)\b|\b(?:cut|reduce)\b.{0,40}\b(?:length|words?|pages?|content)\b/i.test(
    request,
  );
}

function documentHtmlToRevisionSnapshot(value: string): RevisionDocumentSnapshot {
  if (typeof document === "undefined") {
    return { assets: [], markdown: documentHtmlToText(value) };
  }
  const template = document.createElement("template");
  template.innerHTML = value;
  template.content.querySelectorAll(".document-page-label").forEach((node) => node.remove());
  mergeSplitContinuationBlocks(template.content);
  const assets: RevisionAsset[] = [];
  const markdown = Array.from(template.content.childNodes)
    .map((node) => documentNodeToRevisionMarkdown(node, assets))
    .join("\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    assets,
    markdown: markdown || documentHtmlToText(value),
  };
}

function documentNodeToRevisionMarkdown(node: Node, assets: RevisionAsset[]): string {
  if (node.nodeType === Node.TEXT_NODE) return normalizeDocumentText(node.textContent ?? "");
  if (!(node instanceof HTMLElement)) return "";
  if (node.matches(".document-page-label")) return "";

  const tag = node.tagName.toLowerCase();
  if (tag === "table") return documentTableToMarkdown(node as HTMLTableElement, assets);
  if (tag === "figure") return documentFigureToRevisionMarkdown(node, assets);
  if (tag === "img") return documentImageToRevisionMarkdown(node as HTMLImageElement, assets);
  if (tag === "hr") return "---";
  if (tag === "pre") {
    return `\`\`\`\n${node.textContent ?? ""}\n\`\`\``;
  }
  if (tag === "h1" || tag === "h2" || tag === "h3") {
    const level = tag === "h1" ? "#" : tag === "h2" ? "##" : "###";
    return `${level} ${documentInlineChildrenToRevisionMarkdown(node, assets)}`.trim();
  }
  if (tag === "p") return documentInlineChildrenToRevisionMarkdown(node, assets);
  if (tag === "ul" || tag === "ol") {
    return Array.from(node.children)
      .map((child, index) => {
        const text = documentInlineChildrenToRevisionMarkdown(child, assets);
        return tag === "ol" ? `${index + 1}. ${text}` : `- ${text}`;
      })
      .join("\n");
  }
  if (tag === "blockquote") {
    return documentInlineChildrenToRevisionMarkdown(node, assets)
      .split(/\n+/)
      .map((line) => `> ${line}`)
      .join("\n");
  }

  const childMarkdown = Array.from(node.childNodes)
    .map((child) => documentNodeToRevisionMarkdown(child, assets))
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return childMarkdown || normalizeDocumentText(node.textContent ?? "");
}

function documentInlineChildrenToRevisionMarkdown(
  element: Element,
  assets: RevisionAsset[],
) {
  return Array.from(element.childNodes)
    .map((child) => documentInlineNodeToRevisionMarkdown(child, assets))
    .join("")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

function documentInlineNodeToRevisionMarkdown(node: Node, assets: RevisionAsset[]): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\s+/g, " ");
  if (!(node instanceof HTMLElement)) return "";
  const tag = node.tagName.toLowerCase();
  if (tag === "br") return "\n";
  // A ruled line is blank text; the model needs to see that a fill-in rule is
  // there, and the underscores it reads back become a rule again on the way in.
  if (node.classList.contains(SIGNATURE_LINE_CLASS)) return "__________";
  if (tag === "img") return documentImageToRevisionMarkdown(node as HTMLImageElement, assets);
  if (tag === "a") {
    const href = node.getAttribute("href")?.trim();
    const label = normalizeDocumentText(node.textContent ?? "Link").replace(/[\[\]]/g, "");
    if (!href) return label;
    return `[${label || "Link"}](${protectRevisionAsset("link", href, assets)})`;
  }
  const content = Array.from(node.childNodes)
    .map((child) => documentInlineNodeToRevisionMarkdown(child, assets))
    .join("");
  if (tag === "strong" || tag === "b") return `**${content}**`;
  if (tag === "em" || tag === "i") return `*${content}*`;
  if (tag === "code") return `\`${content.replace(/`/g, "'")}\``;
  return content;
}

function documentFigureToRevisionMarkdown(figure: HTMLElement, assets: RevisionAsset[]) {
  const image = figure.querySelector<HTMLImageElement>("img[src]");
  if (!image) return normalizeDocumentText(figure.textContent ?? "");
  const caption = normalizeDocumentText(
    figure.querySelector("figcaption")?.textContent ?? image.alt ?? "Document image",
  );
  return documentImageToRevisionMarkdown(image, assets, caption);
}

function documentImageToRevisionMarkdown(
  image: HTMLImageElement,
  assets: RevisionAsset[],
  caption?: string,
) {
  const source = image.getAttribute("src")?.trim();
  if (!source) return "";
  const alt = normalizeDocumentText(image.getAttribute("alt") ?? caption ?? "Document image")
    .replace(/[\[\]]/g, "") || "Document image";
  const title = normalizeDocumentText(caption ?? image.getAttribute("title") ?? alt)
    .replace(/"/g, "'");
  const token = protectRevisionAsset("image", source, assets);
  return `![${alt}](${token}${title ? ` "${title}"` : ""})`;
}

function protectRevisionAsset(
  kind: RevisionAsset["kind"],
  value: string,
  assets: RevisionAsset[],
) {
  const token = `/api/drafts/preserved-assets/${kind}-${assets.length + 1}`;
  assets.push({ kind, token, value });
  return token;
}

function missingProtectedRevisionAssets(
  assets: RevisionAsset[],
  revisedMarkdown: string,
  request: string,
) {
  return assets.filter(
    (asset) =>
      !revisionRequestAllowsAssetRemoval(request, asset.kind) &&
      !revisedMarkdown.includes(asset.token),
  );
}

function revisionRequestAllowsAssetRemoval(request: string, kind: RevisionAsset["kind"]) {
  const normalized = request.toLowerCase().replace(/\s+/g, " ");
  const target = kind === "image" ? "(?:images?|pictures?|photos?|graphics?)" : "(?:links?|hyperlinks?|urls?)";
  const action = "(?:remove|delete|strip|drop|omit|unlink)";
  return new RegExp(
    `\\b${action}\\b.{0,60}\\b${target}\\b|\\b${target}\\b.{0,60}\\b${action}\\b`,
  ).test(normalized);
}

function restoreRevisionAssetsInHtml(html: string, assets: RevisionAsset[]) {
  if (typeof document === "undefined" || assets.length === 0) return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  const byToken = new Map(assets.map((asset) => [asset.token, asset]));
  template.content.querySelectorAll<HTMLElement>("img[src], a[href]").forEach((element) => {
    const attribute = element instanceof HTMLImageElement ? "src" : "href";
    const token = element.getAttribute(attribute) ?? "";
    const asset = byToken.get(token);
    if (asset) element.setAttribute(attribute, asset.value);
  });
  return template.innerHTML;
}

function documentTableToMarkdown(table: HTMLTableElement, assets: RevisionAsset[]): string {
  const rows = Array.from(table.querySelectorAll("tr"))
    .map((row) => Array.from(row.querySelectorAll("th,td")).map((cell) => tableCellMarkdown(
      documentInlineChildrenToRevisionMarkdown(cell, assets),
    )))
    .filter((row) => row.length > 0);
  if (rows.length === 0) return normalizeDocumentText(table.textContent ?? "");

  const columnCount = Math.max(...rows.map((row) => row.length));
  const firstRow = rows[0] ?? [];
  const hasExplicitHeader = Boolean(table.querySelector("thead th, tr:first-child th"));
  const headers = hasExplicitHeader
    ? normalizeTableRow(firstRow, columnCount).map((cell, index) => cell || `Column ${index + 1}`)
    : Array.from({ length: columnCount }, (_, index) => `Column ${index + 1}`);
  const bodyRows = hasExplicitHeader ? rows.slice(1) : rows;
  return [
    markdownTableLine(headers),
    markdownTableLine(headers.map(() => "---")),
    ...bodyRows.map((row) => markdownTableLine(normalizeTableRow(row, columnCount))),
  ].join("\n");
}

function normalizeTableRow(row: string[], columnCount: number) {
  return Array.from({ length: columnCount }, (_, index) => row[index] ?? "");
}

function markdownTableLine(cells: string[]) {
  return `| ${cells.join(" | ")} |`;
}

function tableCellMarkdown(value: string) {
  return normalizeDocumentText(value).replace(/\|/g, "\\|");
}

function normalizeDocumentText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

/** Word constructs that mammoth's default style map drops but the editor,
 * DOCX export, and print pipeline all understand: underline/strike runs,
 * hard page breaks, alignment (via the synthetic style names attached by
 * tagWordParagraphAlignment), and Word's List Paragraph style. */
const UPLOADED_WORD_TEMPLATE_STYLE_MAP = [
  "u => u",
  "strike => s",
  "br[type='page'] => hr.document-page-break",
  "p[style-name='Aperture Align Center'] => p.doc-align-center:fresh",
  "p[style-name='Aperture Align Right'] => p.doc-align-right:fresh",
  "p[style-name='Aperture Align Justify'] => p.doc-align-justify:fresh",
  "p[style-name='List Paragraph']:ordered-list(1) => ol > li:fresh",
  "p[style-name='List Paragraph']:ordered-list(2) => ol > li:fresh",
  "p[style-name='List Paragraph']:unordered-list(1) => ul > li:fresh",
  "p[style-name='List Paragraph']:unordered-list(2) => ul > li:fresh",
  "p[style-name='List Paragraph'] => p:fresh",
];

type MammothDocumentElement = {
  type?: string;
  children?: MammothDocumentElement[];
  styleId?: string | null;
  styleName?: string | null;
  alignment?: string | null;
};

const WORD_ALIGNMENT_SYNTHETIC_STYLES: Record<string, { styleId: string; styleName: string }> = {
  center: { styleId: "ApertureAlignCenter", styleName: "Aperture Align Center" },
  right: { styleId: "ApertureAlignRight", styleName: "Aperture Align Right" },
  both: { styleId: "ApertureAlignJustify", styleName: "Aperture Align Justify" },
  distribute: { styleId: "ApertureAlignJustify", styleName: "Aperture Align Justify" },
  justify: { styleId: "ApertureAlignJustify", styleName: "Aperture Align Justify" },
};

/** Mammoth cannot express paragraph alignment in a style map, so unnamed
 * aligned paragraphs get a synthetic style name here that the style map
 * above turns into doc-align-* classes. Named styles (headings, lists) keep
 * their own mapping and lose only alignment. */
function tagWordParagraphAlignment(element: MammothDocumentElement): MammothDocumentElement {
  const next = element.children
    ? { ...element, children: element.children.map(tagWordParagraphAlignment) }
    : element;
  if (next.type !== "paragraph" || next.styleId || next.styleName) return next;
  const syntheticStyle = WORD_ALIGNMENT_SYNTHETIC_STYLES[next.alignment ?? ""];
  return syntheticStyle ? { ...next, ...syntheticStyle } : next;
}

async function readUploadedWordTemplate(file: File): Promise<UploadedWordTemplate> {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const warnings: string[] = [];
  let html = "";

  if (extension === "docx" || extension === "dotx") {
    const result = await mammoth.convertToHtml(
      { arrayBuffer: await file.arrayBuffer() },
      {
        convertImage: mammoth.images.dataUri,
        includeDefaultStyleMap: true,
        styleMap: UPLOADED_WORD_TEMPLATE_STYLE_MAP,
        transformDocument: tagWordParagraphAlignment,
      },
    );
    html = sanitizeUploadedTemplateHtml(result.value);
    warnings.push(...Array.from(new Set(result.messages.map((message) => message.message))));
  } else {
    const rawText = await readFileAsText(file);
    html = looksLikeHtml(rawText)
      ? sanitizeUploadedTemplateHtml(rawText)
      : textToDocumentHtml(rawText);
    if (extension === "doc") {
      warnings.push(
        "Legacy .doc files are imported from readable text or Word-saved HTML. Use .docx for higher fidelity.",
      );
    }
  }

  const text = documentHtmlToText(html);
  if (!text.trim()) {
    throw new Error("Uploaded template did not contain readable document content.");
  }

  return {
    filename: file.name,
    html,
    text,
    title: titleFromUploadedTemplate(file.name, text),
    warnings,
  };
}

function readFileAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);
  });
}

/** Re-encodes an uploaded picture as a JPEG that fits the per-slide budget,
 * stepping the resolution down until it does. Falls back to the original bytes
 * when canvas encoding is unavailable and they already fit. */
async function boundedSlideBackgroundDataUrl(src: string): Promise<string | null> {
  for (const dimension of [1600, 1280, 1024]) {
    const encoded = await imageUrlToJpegDataUrl(src, dimension);
    if (encoded && encoded.length <= MAX_SLIDE_BACKGROUND_CHARS) return encoded;
  }
  if (/^data:image\/(png|jpe?g);/i.test(src) && src.length <= MAX_SLIDE_BACKGROUND_CHARS) {
    return src;
  }
  return null;
}

function deckSlideWithoutBackground(slide: DeckSlide): DeckSlide {
  if (!slide.background && !slide.backgroundId) return slide;
  const next = { ...slide } as DeckSlide & {
    background?: DeckSlideBackground;
    backgroundId?: string;
  };
  delete next.background;
  delete next.backgroundId;
  return next;
}

function readFileAsText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file."));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsText(file);
  });
}

function looksLikeHtml(value: string) {
  return /<\s*(html|body|h[1-6]|p|table|ul|ol|div|section|article)\b/i.test(value);
}

function sanitizeUploadedTemplateHtml(value: string) {
  if (typeof document === "undefined") {
    return textToDocumentHtml(documentHtmlToText(value));
  }
  const source = document.createElement("template");
  source.innerHTML = value;
  const body = source.content.querySelector("body");
  const sanitized = document.createElement("template");
  sanitized.innerHTML = body?.innerHTML ?? value;
  sanitized.content
    .querySelectorAll("script, style, iframe, object, embed, link, meta")
    .forEach((node) => node.remove());

  const allowedTags = new Set([
    "A",
    "B",
    "BLOCKQUOTE",
    "BR",
    "CODE",
    "EM",
    "FIGCAPTION",
    "FIGURE",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HR",
    "I",
    "IMG",
    "LI",
    "OL",
    "P",
    "PRE",
    "S",
    "STRONG",
    "SUB",
    "SUP",
    "TABLE",
    "TBODY",
    "TD",
    "TH",
    "THEAD",
    "TR",
    "U",
    "UL",
  ]);

  Array.from(sanitized.content.querySelectorAll("*")).forEach((element) => {
    if (!allowedTags.has(element.tagName)) {
      element.replaceWith(...Array.from(element.childNodes));
      return;
    }
    // Alignment is template formatting the editor and exports both honor;
    // capture it (from Word HTML inline styles or the doc-align-* classes
    // the mammoth style map emits) before every other style is stripped.
    const inlineAlignment = /(?:^|;)\s*text-align\s*:\s*(center|right|justify)\b/i.exec(
      element.getAttribute("style") ?? "",
    )?.[1];
    Array.from(element.attributes).forEach((attribute) => {
      const attrName = attribute.name.toLowerCase();
      if (attrName.startsWith("on") || attrName === "style") {
        element.removeAttribute(attribute.name);
      }
    });
    if (element instanceof HTMLImageElement) {
      const src = element.getAttribute("src") ?? "";
      if (!/^data:image\/|^https?:\/\//i.test(src)) {
        element.remove();
        return;
      }
      element.removeAttribute("srcset");
      return;
    }
    if (element instanceof HTMLAnchorElement) {
      element.removeAttribute("href");
    } else {
      Array.from(element.attributes).forEach((attribute) => {
        if (attribute.name !== "class") element.removeAttribute(attribute.name);
      });
    }
    const classAlignment = element.classList.contains("doc-align-center")
      ? "center"
      : element.classList.contains("doc-align-right")
        ? "right"
        : element.classList.contains("doc-align-justify")
          ? "justify"
          : null;
    element.classList.remove("doc-align-center", "doc-align-right", "doc-align-justify");
    if (!element.classList.length) element.removeAttribute("class");
    const alignment = classAlignment ?? inlineAlignment?.toLowerCase();
    if (alignment) element.setAttribute("style", `text-align: ${alignment};`);
  });

  const html = Array.from(sanitized.content.childNodes)
    .map((node) => {
      if (node instanceof Element) return node.outerHTML;
      return node.textContent?.trim() ? `<p>${escapeHtml(node.textContent)}</p>` : "";
    })
    .join("")
    .trim();
  return html || textToDocumentHtml(documentHtmlToText(value));
}

function conformCurrentDocumentToUploadedTemplate(templateHtml: string, currentDraftText: string) {
  const currentDraftHtml = existingDraftContentHtml(currentDraftText);
  if (typeof document === "undefined") {
    return `${templateHtml}<h2>Current draft content</h2>${currentDraftHtml}`;
  }
  const template = document.createElement("template");
  template.innerHTML = templateHtml;
  const placeholder = Array.from(template.content.querySelectorAll<HTMLElement>("p, li, td, th, div")).find(
    (element) => templatePlaceholderPattern().test(element.textContent ?? ""),
  );
  if (placeholder) {
    const replacement = document.createElement("template");
    replacement.innerHTML = currentDraftHtml;
    placeholder.replaceWith(replacement.content.cloneNode(true));
  } else {
    const replacement = document.createElement("template");
    replacement.innerHTML = `<h2>Source draft content</h2>${currentDraftHtml}`;
    template.content.appendChild(replacement.content.cloneNode(true));
  }
  return Array.from(template.content.childNodes)
    .map((node) => {
      if (node instanceof Element) return node.outerHTML;
      return node.textContent?.trim() ? `<p>${escapeHtml(node.textContent)}</p>` : "";
    })
    .join("");
}

function templatePlaceholderPattern() {
  return /\{\{\s*(content|body|draft|document)\s*\}\}|\[(draft|document|body|content|insert text|main text|current draft)(?:\s+content)?\]/i;
}

function titleFromUploadedTemplate(filename: string, text: string) {
  const firstHeading = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length >= 3 && line.length <= 90);
  return firstHeading ? paperTitle(firstHeading) : paperTitle(filename.replace(/\.[^.]+$/, ""));
}

const DOCUMENT_PAGE_SECTION_PATTERN = /<section\b[^>]*class=["'](?:[^"']*\s)?document-page(?:\s[^"']*)?["'][^>]*>/gi;

function countDocumentPages(value: string) {
  return (value.match(DOCUMENT_PAGE_SECTION_PATTERN) ?? []).length;
}

function splitDocumentPageHtml(value: string) {
  if (!countDocumentPages(value)) return [];
  if (typeof document === "undefined") {
    return value.match(/<section\b[^>]*class="document-page"[\s\S]*?<\/section>/g) ?? [];
  }
  const template = document.createElement("template");
  template.innerHTML = value;
  return Array.from(template.content.querySelectorAll<HTMLElement>(".document-page")).map(
    (page) => page.outerHTML,
  );
}

const FILL_IN_BLANK_PATTERN = /_{3,}/;

/** Wraps runs of 3+ underscores (fill-in blanks in legal templates) so CSS
 * can render them as one continuous signature/blank line. The text stays
 * literal underscores, so exports, prompts, and copy/paste are unchanged. */
function wrapFillInBlanks(html: string) {
  if (typeof document === "undefined" || !FILL_IN_BLANK_PATTERN.test(html)) return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    if (!FILL_IN_BLANK_PATTERN.test(text.data)) continue;
    if (text.parentElement?.closest("span.document-blank, pre, code")) continue;
    targets.push(text);
  }
  if (!targets.length) return html;
  targets.forEach((text) => {
    const fragment = document.createDocumentFragment();
    let consumed = 0;
    for (const match of text.data.matchAll(/_{3,}/g)) {
      const start = match.index ?? 0;
      if (start > consumed) fragment.appendChild(document.createTextNode(text.data.slice(consumed, start)));
      const blank = document.createElement("span");
      blank.className = "document-blank";
      blank.textContent = match[0];
      fragment.appendChild(blank);
      consumed = start + match[0].length;
    }
    if (consumed < text.data.length) fragment.appendChild(document.createTextNode(text.data.slice(consumed)));
    text.replaceWith(fragment);
  });
  return template.innerHTML;
}

function paginateTransferredDocumentHtml(
  html: string,
  requestContext: string,
  options?: { forceMarkerPages?: boolean },
) {
  if (countDocumentPages(html)) return html;
  html = wrapFillInBlanks(html);
  const requestedPages = parseRequestedPageCount(requestContext);
  const estimatedPages = Math.ceil(Math.max(1, documentHtmlToText(html).split(/\s+/).filter(Boolean).length) / 520);

  const nodes = topLevelHtmlBlocks(html);
  if (!nodes.length) return html;

  // Markdown "---" rules arrive as hr.document-page-break markers. In a
  // multi-page draft they are the author's own page boundaries and must
  // become real page splits here — leaving them inside a weight-paginated
  // section makes the preview and the exports disagree about where pages
  // end. In a short single-page draft, a lone rule is a thematic divider
  // and stays inline. forceMarkerPages skips that leniency for content
  // whose markers were explicit Word page breaks, never thematic rules.
  const segments = splitNodesAtPageBreakMarkers(nodes);
  const structuralMarkers =
    segments.length > 1 &&
    (options?.forceMarkerPages === true ||
      html.includes("document-mla-text") ||
      segments.length > 2 ||
      requestedPages > 1 ||
      estimatedPages > 1);

  let pages: string[][];
  if (structuralMarkers) {
    const contentNodes = segments.flat();
    if (!contentNodes.length) return html;
    const pageTotal = Math.min(40, Math.max(requestedPages, estimatedPages, segments.length, 1));
    const totalWeight = contentNodes.reduce((sum, node) => sum + htmlBlockWeight(node), 0);
    const targetWeight = Math.max(1, totalWeight / pageTotal);
    pages = [];
    segments.forEach((segment) => {
      if (!segment.length) return;
      const segmentWeight = segment.reduce((sum, node) => sum + htmlBlockWeight(node), 0);
      // A marker-delimited segment is an authored page. Only clearly
      // oversized segments flow onto extra pages; everything else stays one
      // page even if it is lighter or heavier than the average.
      if (segmentWeight <= targetWeight * 1.75) {
        pages.push(segment);
        return;
      }
      pages.push(
        ...weightPaginatedPages(segment, targetWeight, Math.max(1, Math.round(segmentWeight / targetWeight))),
      );
    });
  } else {
    // A requested length guides the model, not the renderer. Forcing a short
    // response across (for example) 25 quota pages creates sparse sheets and
    // the same large blank gaps in Word. Natural content density determines
    // the initial sheets; the measured rebalancer below then corrects them.
    const pageTotal = Math.min(40, Math.max(estimatedPages, 1));
    const totalWeight = nodes.reduce((sum, node) => sum + htmlBlockWeight(node), 0);
    const targetWeight = Math.max(1, totalWeight / pageTotal);
    pages = weightPaginatedPages(nodes, targetWeight, pageTotal);
  }
  if (!pages.length) return html;

  return pages
    .map(
      (page, index) =>
        `<section class="document-page" data-page-number="${index + 1}"><span class="document-page-label" contenteditable="false">Page ${
          index + 1
        }</span>${page.join("")}</section>`,
    )
    .join("");
}

function isPageBreakMarkerNode(node: string) {
  return /^<hr\b[^>]*\bdocument-page-break\b/i.test(node.trim());
}

function splitNodesAtPageBreakMarkers(nodes: string[]) {
  const segments: string[][] = [];
  let current: string[] = [];
  nodes.forEach((node) => {
    if (isPageBreakMarkerNode(node)) {
      if (current.length) segments.push(current);
      current = [];
      return;
    }
    current.push(node);
  });
  if (current.length) segments.push(current);
  return segments;
}

function weightPaginatedPages(nodes: string[], targetWeight: number, pageBudget: number) {
  const pages: string[][] = [];
  let current: string[] = [];
  let currentWeight = 0;
  nodes.forEach((node) => {
    const weight = htmlBlockWeight(node);
    const shouldBreak =
      current.length > 0 &&
      pages.length < pageBudget - 1 &&
      currentWeight + weight > targetWeight * 1.08 &&
      !/^<h[1-3][\s>]/i.test(node.trim());
    if (shouldBreak) {
      const trailingHeading = current[current.length - 1];
      const carryHeading =
        current.length > 1 && /^<h[1-3][\s>]/i.test(trailingHeading.trim());
      if (carryHeading) {
        current.pop();
        pages.push(current);
        current = [trailingHeading];
        currentWeight = htmlBlockWeight(trailingHeading);
      } else {
        pages.push(current);
        current = [];
        currentWeight = 0;
      }
    }
    current.push(node);
    currentWeight += weight;
  });
  if (current.length) pages.push(current);
  return pages;
}

function topLevelHtmlBlocks(html: string) {
  if (typeof document === "undefined") return html.split(/(?=<h[1-3]\b|<p\b|<figure\b|<table\b|<ul\b|<ol\b|<blockquote\b|<pre\b|<hr\b)/i).filter(Boolean);
  const template = document.createElement("template");
  template.innerHTML = html;
  return Array.from(template.content.childNodes)
    .map((node) => {
      if (node instanceof Element) return node.outerHTML;
      return node.textContent?.trim() ? escapeHtml(node.textContent) : "";
    })
    .filter(Boolean);
}

function htmlBlockWeight(html: string) {
  const text = html.replace(/<[^>]+>/g, " ");
  const words = text.split(/\s+/).filter(Boolean).length;
  if (/<figure\b|<img\b/i.test(html)) return 95;
  if (/<h1\b/i.test(html)) return 70;
  if (/<h[2-3]\b/i.test(html)) return 45;
  if (/<table\b/i.test(html)) return Math.max(90, words * 3);
  return Math.max(25, words);
}

/** Turns manual break markers inside paginated drafts into real page splits so
 * the preview shows an actual new sheet instead of a dashed divider. Returns
 * true when at least one page was split or created. */
function normalizeManualPageBreaks(editor: HTMLElement) {
  if (!editor.querySelector("section.document-page")) return false;
  let changed = false;

  editor.querySelectorAll<HTMLElement>("hr.document-page-break").forEach((marker) => {
    const page = marker.closest<HTMLElement>("section.document-page");
    if (page && editor.contains(page)) {
      const nextPage = document.createElement("section");
      nextPage.className = "document-page";
      nextPage.dataset.pageBreakBefore = "manual";
      if (marker !== page.lastChild) {
        const range = document.createRange();
        range.setStartAfter(marker);
        range.setEndAfter(page.lastChild as Node);
        nextPage.appendChild(range.extractContents());
      }
      if (!nextPage.querySelector("p,h1,h2,h3,ul,ol,table,figure,blockquote,pre,div")) {
        const filler = document.createElement("p");
        filler.appendChild(document.createElement("br"));
        nextPage.appendChild(filler);
      }
      page.after(nextPage);
      marker.remove();
      changed = true;
      return;
    }
    // Marker landed outside every page (e.g. appended after the last sheet):
    // wrap whatever follows it into a fresh page.
    if (marker.parentElement === editor) {
      const trailing: Node[] = [];
      let sibling = marker.nextSibling;
      while (sibling) {
        const next = sibling.nextSibling;
        if (sibling instanceof HTMLElement && sibling.matches("section.document-page")) break;
        trailing.push(sibling);
        sibling = next;
      }
      const nextExistingPage =
        sibling instanceof HTMLElement && sibling.matches("section.document-page")
          ? sibling
          : null;
      const meaningfulTrailing = trailing.filter((node) => node.textContent?.trim() || node instanceof HTMLElement);
      if (nextExistingPage && meaningfulTrailing.length === 0) {
        // A selection at the very start/between sheets can put the marker next
        // to a page instead of inside it. Keep the blank leading sheet when
        // needed, and attach the hard-boundary metadata to the page after the
        // break so later reflow cannot merge it away.
        if (!(marker.previousElementSibling instanceof HTMLElement)) {
          const blankPage = document.createElement("section");
          blankPage.className = "document-page";
          const filler = document.createElement("p");
          filler.appendChild(document.createElement("br"));
          blankPage.appendChild(filler);
          marker.replaceWith(blankPage);
        } else {
          marker.remove();
        }
        nextExistingPage.dataset.pageBreakBefore = "manual";
        changed = true;
        return;
      }
      const nextPage = document.createElement("section");
      nextPage.className = "document-page";
      nextPage.dataset.pageBreakBefore = "manual";
      trailing.forEach((node) => nextPage.appendChild(node));
      if (!nextPage.querySelector("p,h1,h2,h3,ul,ol,table,figure,blockquote,pre,div")) {
        const filler = document.createElement("p");
        filler.appendChild(document.createElement("br"));
        nextPage.appendChild(filler);
      }
      marker.replaceWith(nextPage);
      changed = true;
    }
  });

  if (changed) renumberDocumentPages(editor);
  return changed;
}

function renumberDocumentPages(editor: HTMLElement) {
  const pages = Array.from(editor.querySelectorAll<HTMLElement>("section.document-page"));
  pages.forEach((page, index) => {
    page.setAttribute("data-page-number", String(index + 1));
    let label = page.querySelector<HTMLElement>(":scope > .document-page-label");
    if (!label) {
      label = document.createElement("span");
      label.className = "document-page-label";
      label.setAttribute("contenteditable", "false");
      page.insertBefore(label, page.firstChild);
    }
    label.textContent = `Page ${index + 1}`;
  });
}

/** True Letter-sheet geometry shared by the preview and the exports: an 860px
 * sheet at 11/8.5 aspect with 60px/66px padding gives a 728px × 993px content
 * region. Exports map the 728px column onto 6.86in of printed width, so 993px
 * sits just inside the 9.5in printed page height — a preview sheet that fits
 * this region fits one exported page. */
const DOCUMENT_SHEET_WIDTH_PX = 860;
const DOCUMENT_SHEET_PAD_X_PX = 66;
const DOCUMENT_SHEET_PAD_Y_PX = 60;
const DOCUMENT_SHEET_CONTENT_HEIGHT_PX =
  Math.round((DOCUMENT_SHEET_WIDTH_PX * 11) / 8.5) - DOCUMENT_SHEET_PAD_Y_PX * 2;
const SHEET_OVERFLOW_TOLERANCE_PX = 26;
const SHEET_IMAGE_SETTLE_TIMEOUT_MS = 6000;
/* Splitting a text block across sheets only pays off when the page being
 * left behind still has a few lines of room and both halves keep real
 * content; below these sizes the block moves whole, like before. */
const SHEET_SPLIT_MIN_ROOM_PX = 64;
const SHEET_SPLIT_MIN_WORDS = 8;
/* A trailing h1-h3 taller than this is clause text imported from a Word
 * heading style, not a heading that must stay with what follows it. */
const SHEET_HEADING_CARRY_MAX_PX = 96;

function whenSheetImagesSettled(root: HTMLElement) {
  const pending = Array.from(root.querySelectorAll("img"))
    .filter((image) => !(image.complete && image.naturalWidth))
    .map(
      (image) =>
        new Promise<void>((resolve) => {
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }),
    );
  if (!pending.length) return Promise.resolve();
  return Promise.race([
    Promise.all(pending).then(() => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, SHEET_IMAGE_SETTLE_TIMEOUT_MS)),
  ]);
}

function documentPageDistribution(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(":scope > section.document-page"))
    .map((page) => {
      const manualBoundary = page.dataset.pageBreakBefore === "manual" ? "manual" : "flow";
      const blocks = Array.from(page.children)
        .filter(
          (child): child is HTMLElement =>
            child instanceof HTMLElement && !child.classList.contains("document-page-label"),
        )
        .map((child) => child.outerHTML)
        .join("");
      return `${manualBoundary}:${blocks}`;
    })
    .join("\n\f\n");
}

function renderedSheetContentHeight(sheet: HTMLElement) {
  const blocks = Array.from(sheet.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && !child.classList.contains("document-page-label"),
  );
  if (!blocks.length) return 0;
  const topBlock = blocks[0];
  const topStyle = window.getComputedStyle(topBlock);
  const contentTop =
    topBlock.getBoundingClientRect().top - (Number.parseFloat(topStyle.marginTop) || 0);
  const contentBottom = Math.max(
    ...blocks.map((block) => {
      const style = window.getComputedStyle(block);
      return block.getBoundingClientRect().bottom + (Number.parseFloat(style.marginBottom) || 0);
    }),
  );
  return contentBottom - contentTop;
}

/** Whether a block may be divided across sheets: plain text paragraphs and
 * the Word clause styles that import as h3-h6, with no replaced content. */
function sheetBlockIsSplittable(block: HTMLElement) {
  return /^(P|H3|H4|H5|H6)$/.test(block.tagName) && !block.querySelector("img, figure, table");
}

/** Divides the sheet's overflowing last block at the last word whose line
 * still fits, Word-style. The fitted prefix keeps the block's tag and
 * attributes; the remainder is returned (marked data-split-continuation so
 * exports and snapshots can re-join it) for placement on the next sheet.
 * Returns null when no worthwhile split point exists. */
function splitOverflowingSheetBlock(
  sheet: HTMLElement,
  block: HTMLElement,
  capacityPx: number,
): HTMLElement | null {
  const blocks = Array.from(sheet.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && !child.classList.contains("document-page-label"),
  );
  if (!blocks.length || blocks[blocks.length - 1] !== block) return null;
  const topBlock = blocks[0];
  const topStyle = window.getComputedStyle(topBlock);
  const contentTop =
    topBlock.getBoundingClientRect().top - (Number.parseFloat(topStyle.marginTop) || 0);
  // The sheet-overflow metric counts the block's bottom margin, so the last
  // fitting line must leave room for it too; otherwise a block that misses
  // by only its margin is bounced whole and leaves a block-sized gap.
  const blockMarginBottom = Number.parseFloat(window.getComputedStyle(block).marginBottom) || 0;
  const allowedBottom = contentTop + capacityPx - blockMarginBottom;
  if (allowedBottom - block.getBoundingClientRect().top < SHEET_SPLIT_MIN_ROOM_PX) return null;

  const boundaries: Array<{ node: Text; offset: number }> = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let textNode: Node | null;
  while ((textNode = walker.nextNode())) {
    const text = textNode as Text;
    for (const match of text.data.matchAll(/\S+/g)) {
      boundaries.push({ node: text, offset: (match.index ?? 0) + match[0].length });
    }
  }
  if (boundaries.length < SHEET_SPLIT_MIN_WORDS) return null;

  const range = document.createRange();
  range.setStart(block, 0);
  const fitsThroughWord = (index: number) => {
    const boundary = boundaries[index];
    range.setEnd(boundary.node, boundary.offset);
    return range.getBoundingClientRect().bottom <= allowedBottom;
  };
  if (!fitsThroughWord(0) || fitsThroughWord(boundaries.length - 1)) return null;
  let low = 0;
  let high = boundaries.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fitsThroughWord(mid)) low = mid;
    else high = mid - 1;
  }
  // Keep a few words on each side so the split never strands a fragment.
  if (low < 3 || boundaries.length - 1 - low < 3) return null;

  const cut = boundaries[low];
  range.setEnd(cut.node, cut.offset);
  const prefix = block.cloneNode(false) as HTMLElement;
  prefix.appendChild(range.extractContents());
  block.before(prefix);
  block.remove();
  block.setAttribute("data-split-continuation", "true");
  return block;
}

/** Reflows every programmatic preview into canonical Letter-sized sheets.
 * Unlike the old one-way overflow splitter, this packs blocks from all flow
 * pages again, so sparse quota pages merge and overfull pages split. Only a
 * page created by the user's Page break control remains a hard boundary. */
async function repaginateOverfullDocumentPages(contentHtml: string): Promise<string | null> {
  if (typeof document === "undefined") return null;
  const host = document.createElement("article");
  host.className = "document-canvas is-paginated";
  host.setAttribute("aria-hidden", "true");
  host.setAttribute(
    "style",
    `position:fixed;left:-11000px;top:0;width:${DOCUMENT_SHEET_WIDTH_PX}px;visibility:hidden;pointer-events:none;`,
  );
  host.innerHTML = contentHtml;
  const sourceSheets = Array.from(
    host.querySelectorAll<HTMLElement>(":scope > section.document-page"),
  );
  if (!sourceSheets.length) return null;
  const beforeDistribution = documentPageDistribution(host);
  // Re-join blocks a previous heal split across sheets so repacking works
  // with whole logical paragraphs and re-splits them only where they still
  // overflow. Without this, edits above an old split leave stale fragments.
  mergeSplitContinuationBlocks(host);
  document.body.appendChild(host);
  try {
    try {
      await document.fonts?.ready;
    } catch {
      // Font readiness is best-effort; measurement proceeds with fallbacks.
    }
    await whenSheetImagesSettled(host);

    const units: Array<{ block: HTMLElement; hardBreakBefore: boolean }> = [];
    let hardBreakBefore = false;
    Array.from(host.childNodes).forEach((node) => {
      if (node instanceof HTMLElement && node.matches("section.document-page")) {
        let pageBoundary = hardBreakBefore || node.dataset.pageBreakBefore === "manual";
        const blocks = Array.from(node.children).filter(
          (child): child is HTMLElement =>
            child instanceof HTMLElement && !child.classList.contains("document-page-label"),
        );
        blocks.forEach((block) => {
          if (block.matches("hr.document-page-break")) {
            pageBoundary = true;
            return;
          }
          units.push({ block, hardBreakBefore: pageBoundary });
          pageBoundary = false;
        });
        if (!blocks.length && pageBoundary) {
          const filler = document.createElement("p");
          filler.appendChild(document.createElement("br"));
          units.push({ block: filler, hardBreakBefore: true });
          pageBoundary = false;
        }
        hardBreakBefore = pageBoundary;
        return;
      }
      if (node instanceof HTMLElement) {
        if (node.matches("hr.document-page-break")) {
          hardBreakBefore = true;
        } else if (!node.classList.contains("document-page-label")) {
          units.push({ block: node, hardBreakBefore });
          hardBreakBefore = false;
        }
        return;
      }
      if (node.textContent?.trim()) {
        const paragraph = document.createElement("p");
        paragraph.textContent = node.textContent;
        units.push({ block: paragraph, hardBreakBefore });
        hardBreakBefore = false;
      }
    });
    if (!units.length) return null;

    host.replaceChildren();
    const createSheet = (manualBoundary = false) => {
      const sheet = document.createElement("section");
      sheet.className = "document-page";
      if (manualBoundary) sheet.dataset.pageBreakBefore = "manual";
      // Preview padding uses responsive clamps; pin the hidden measuring sheet
      // to the exact geometry shared with the DOCX export.
      sheet.style.padding = `${DOCUMENT_SHEET_PAD_Y_PX}px ${DOCUMENT_SHEET_PAD_X_PX}px`;
      host.appendChild(sheet);
      return sheet;
    };

    let currentSheet = createSheet();
    const sheetCapacityPx = DOCUMENT_SHEET_CONTENT_HEIGHT_PX + SHEET_OVERFLOW_TOLERANCE_PX;
    const sheetOverflows = () => renderedSheetContentHeight(currentSheet) > sheetCapacityPx;
    units.forEach(({ block, hardBreakBefore: startsNewPage }) => {
      if (startsNewPage && currentSheet.childElementCount) {
        currentSheet = createSheet(true);
      } else if (startsNewPage) {
        currentSheet.dataset.pageBreakBefore = "manual";
      }

      let pending: HTMLElement | null = block;
      let movedToFreshSheet = false;
      while (pending) {
        const hadContent = currentSheet.childElementCount > 0;
        currentSheet.appendChild(pending);
        if (!sheetOverflows()) break;

        // Word-style fill: divide the block at the last fitting line so the
        // page stays full instead of leaving a block-sized white gap.
        const continuation: HTMLElement | null = sheetBlockIsSplittable(pending)
          ? splitOverflowingSheetBlock(currentSheet, pending, sheetCapacityPx)
          : null;
        if (continuation) {
          currentSheet = createSheet();
          pending = continuation;
          movedToFreshSheet = false;
          continue;
        }
        // An unsplittable block larger than a whole sheet keeps its page;
        // likewise after one relocation there is nothing better to try.
        if (!hadContent || movedToFreshSheet) break;

        currentSheet.removeChild(pending);
        const trailing = currentSheet.lastElementChild;
        const carriedHeading =
          currentSheet.childElementCount > 1 &&
          trailing instanceof HTMLElement &&
          /^H[1-3]$/.test(trailing.tagName) &&
          trailing.getBoundingClientRect().height <= SHEET_HEADING_CARRY_MAX_PX
            ? trailing
            : null;
        if (carriedHeading) carriedHeading.remove();
        currentSheet = createSheet();
        if (carriedHeading) currentSheet.appendChild(carriedHeading);
        movedToFreshSheet = true;
      }
    });

    host.querySelectorAll<HTMLElement>("section.document-page").forEach((sheet) => {
      sheet.style.removeProperty("padding");
      if (!sheet.getAttribute("style")) sheet.removeAttribute("style");
    });
    renumberDocumentPages(host);
    if (documentPageDistribution(host) === beforeDistribution) return null;
    return host.innerHTML;
  } finally {
    host.remove();
  }
}

function progressiveDraftTiming({
  pageTotal,
  useWebSearch,
  useWorkspaceSources,
  visualRequested,
}: {
  pageTotal: number;
  useWebSearch: boolean;
  useWorkspaceSources: boolean;
  visualRequested: boolean;
}): ProgressiveDraftTiming {
  if (isAutomatedTestMode()) {
    return {
      routingDelayMs: 0,
      contextDelayMs: 0,
      resourceDelayMs: 0,
      pageDelayMs: 0,
      validationDelayMs: 0,
    };
  }
  const longFormScale = Math.min(pageTotal, 50);
  const contextDelayMs = 1100 + (useWorkspaceSources ? 500 : 0) + (useWebSearch ? 650 : 0);
  const resourceDelayMs =
    1500 + longFormScale * 70 + (visualRequested ? 1100 : 0) + (useWebSearch ? 600 : 0);

  return {
    routingDelayMs: 650,
    contextDelayMs,
    resourceDelayMs: Math.min(resourceDelayMs, 6400),
    pageDelayMs: Math.min(700, Math.max(420, 300 + longFormScale * 8)),
    validationDelayMs: pageTotal > 1 || visualRequested ? 1400 : 650,
  };
}

function assistantEvent(
  prefix: string,
  text: string,
  options: Pick<AssistantEvent, "createdAt" | "executedAt" | "durationMs"> = {},
): AssistantEvent {
  return {
    id: `event-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: "assistant",
    text,
    createdAt: options.createdAt,
    executedAt: options.executedAt,
    durationMs: options.durationMs,
  };
}

function draftAgentTraceSteps({
  agentName,
  pageTotal,
  primarySourceName,
  request,
  useWebSearch,
  useWorkspaceSources,
  visualRequested,
  workspaceSourceCount,
}: {
  agentName: string;
  pageTotal: number;
  primarySourceName: string;
  request: string;
  useWebSearch: boolean;
  useWorkspaceSources: boolean;
  visualRequested: boolean;
  workspaceSourceCount: number;
}) {
  const steps: DraftTraceStep[] = [
    {
      id: "route",
      label: "Routing request",
      detail: `Using ${agentName} for document drafting.`,
    },
    {
      id: "context",
      label: "Preparing context",
      detail: useWorkspaceSources
        ? `Checking ${workspaceSourceCount} selected workspace source${
            workspaceSourceCount === 1 ? "" : "s"
          } from ${primarySourceName}.`
        : useWebSearch
          ? "Workspace sources are off; public web research mode is available."
          : "Workspace sources and public web research are off for this draft.",
    },
  ];
  if (pageTotal > 1) {
    steps.push({
      id: "scope",
      label: "Sizing long-form deliverable",
      detail: `Detected a ${pageTotal}-page request; the response must be drafted as the deliverable, not an outline.`,
    });
  } else if (isDraftCreationRequest(request)) {
    steps.push({
      id: "scope",
      label: "Sizing document deliverable",
      detail: "Drafting the requested document top to bottom.",
    });
  }
  if (visualRequested) {
    steps.push({
      id: "visuals",
      label: "Preparing visual evidence",
      detail: "Images requested; the document can include editable image blocks.",
    });
  }
  steps.push({
    id: "generate",
    label: pageTotal > 1 ? "Generating long-form answer" : "Generating answer",
    detail:
      pageTotal > 1
        ? "Writing each requested page into the document canvas."
        : "Writing the requested document into the canvas.",
  });
  if (pageTotal > 1 || visualRequested) {
    steps.push({
      id: "validator",
      label: "Content validator loop",
      detail: "Checking requested length, page structure, and visuals before finalizing.",
    });
  }
  steps.push({
    id: "finalize",
    label: "Finalizing response",
    detail: "Formatting the document, citations, images, and export-ready state.",
  });
  return steps;
}

function DraftWorkTrace({
  trace,
  workspaceName,
}: {
  trace: DraftTraceState;
  workspaceName: string;
}) {
  const [now, setNow] = useState(Date.now());
  const [expanded, setExpanded] = useState(false);
  const isPending = !trace.complete;
  const elapsedSeconds = Math.floor(Math.max(0, now - trace.startedAt) / 1000);
  const currentIndex = Math.min(trace.activeIndex, trace.steps.length - 1);
  const visibleSteps = expanded
    ? trace.steps
    : isPending && trace.steps[currentIndex]
      ? [trace.steps[currentIndex]]
      : [];

  useEffect(() => {
    if (!isPending) return undefined;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [isPending]);

  return (
    <div
      className={`pending-trace draft-work-trace ${trace.complete ? "is-complete" : ""} ${
        expanded ? "is-expanded" : "is-collapsed"
      }`}
      role={isPending ? "status" : "region"}
      aria-live={isPending ? "polite" : undefined}
      aria-label={`${workspaceName} document work trace`}
    >
      <div className="pending-trace-header">
        <button
          className="pending-trace-toggle"
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse work trace" : "Expand work trace"}
          data-tooltip={
            expanded
              ? "Collapse the trace to show only the current document step"
              : "Expand the trace to see every step in this document edit"
          }
          onClick={() => setExpanded((value) => !value)}
        >
          <Sparkles size={15} />
          <span>{trace.complete ? "Document work trace" : `${workspaceName} is drafting`}</span>
          <small>
            {isPending
              ? `${elapsedSeconds}s · step ${currentIndex + 1} of ${trace.steps.length}`
              : `complete · ${trace.steps.length} ${trace.steps.length === 1 ? "step" : "steps"}`}
          </small>
        </button>
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
          The current draft stays intact while this revision is assembled and checked.
        </p>
      )}
      {visibleSteps.length > 0 && (
        <ol>
          {visibleSteps.map((step) => {
            const index = trace.steps.indexOf(step);
            const stepState =
              trace.complete || index < trace.activeIndex
                ? "done"
                : index === trace.activeIndex
                  ? "active"
                  : "queued";
            return (
              <li className={`pending-trace-step is-${stepState}`} key={step.id}>
                <span className="pending-trace-icon" aria-hidden="true">
                  {stepState === "done" ? <CheckCircle2 size={12} /> : <Clock3 size={12} />}
                </span>
                <span>
                  <strong>{step.label}</strong>
                  <small>{step.detail}</small>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function DraftEventRow({ event }: { event: AssistantEvent }) {
  const timestamp = draftEventTimestamp(event);
  const duration = typeof event.durationMs === "number" ? formatDuration(event.durationMs) : null;
  return (
    <div className={`draft-event is-${event.kind}`}>
      {event.kind === "system" ? (
        <Clipboard size={16} />
      ) : event.kind === "assistant" ? (
        <Sparkles size={16} />
      ) : (
        <MessageSquareText size={16} />
      )}
      <span>
        <span>{event.text}</span>
        <time dateTime={timestamp.dateTime} data-tooltip={timestamp.title}>
          {timestamp.label}
          {duration ? ` · ${duration}` : ""}
        </time>
      </span>
    </div>
  );
}

/** The raw saved favorite, unvalidated: a saved id whose model is not usable
 * right now is kept, never deleted, exactly like chat's default model. */
function loadStoredDraftModelId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(DRAFT_MODEL_STORAGE_KEY);
  } catch {
    return null;
  }
}

function loadDraftModelSelection(agents: DraftAgentOption[], fallbackAgentId: string) {
  const storedAgentId = loadStoredDraftModelId();
  if (storedAgentId && agents.some((agent) => agent.id === storedAgentId)) {
    return storedAgentId;
  }
  return fallbackAgentId;
}

function saveDraftModelSelection(agentId: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DRAFT_MODEL_STORAGE_KEY, agentId);
  } catch {
    // Model persistence is a convenience layer; drafting should continue without it.
  }
}

/** Reads the tenant+user scoped working cache only. The legacy unscoped
 * `aperture-document-history-v1` key is never read here — it stays
 * quarantined behind an explicit per-entry import. */
function loadDraftDocumentHistory(scope: DraftCacheScope): DraftDocumentHistoryItem[] {
  return loadScopedDraftCache(scope, isDraftDocumentHistoryItem);
}

function saveDraftDocumentHistory(scope: DraftCacheScope, items: DraftDocumentHistoryItem[]) {
  if (typeof window === "undefined") return false;
  const nextItems = limitDraftCacheEntries(items);
  const stored = saveScopedDraftCache(scope, nextItems);
  try {
    window.dispatchEvent(
      new CustomEvent<{ scope: DraftCacheScope; items: DraftDocumentHistoryItem[] }>(DOCUMENT_HISTORY_UPDATED_EVENT, {
        detail: { scope, items: nextItems },
      }),
    );
  } catch {
    // History is a convenience layer; editing should continue if storage is unavailable.
  }
  return stored;
}

/** Cached entries still marked "running" after a reload are interrupted — no
 * server job exists, so the interface must not claim drafting continues.
 * Applied in-memory only, so a genuinely live run in another mounted instance
 * can still overwrite the stored entry when it finishes. */
function markInterruptedDraftRuns(items: DraftDocumentHistoryItem[]): DraftDocumentHistoryItem[] {
  return items.map((item) =>
    item.status === "running" && !liveDraftRunIds.has(item.id)
      ? {
          ...item,
          status: "failed",
          summary: "Interrupted — this draft was still generating when the session ended.",
        }
      : item,
  );
}

/** History stub for a server draft with no cached copy on this device; the
 * bounded recoverable HTML is fetched on restore, never invented locally. */
function serverDraftHistoryStub(doc: ServerDraftDocument): DraftDocumentHistoryItem {
  return {
    id: `server-${doc.id}`,
    title: doc.title,
    summary: "Stored in your account",
    sourceLabel: "Account draft",
    content: "",
    updatedAt: doc.updated_at,
    createdAt: doc.created_at,
    status: "complete",
    archived: doc.archived ?? false,
    serverId: doc.id,
    serverRevision: null,
    serverListedRevision: doc.current_revision,
    serverContentStale: true,
  };
}

function loadPersistedWordTemplates(): PersistedWordTemplate[] {
  if (typeof window === "undefined") return [];
  try {
    const rawTemplates = window.localStorage.getItem(WORD_TEMPLATE_STORAGE_KEY);
    if (!rawTemplates) return [];
    const parsed = JSON.parse(rawTemplates) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPersistedWordTemplate).slice(0, 24);
  } catch {
    return [];
  }
}

/** Persist templates, dropping the oldest if the browser is out of room.
 *
 * Templates are browser-local and a single .docx can be hundreds of kilobytes,
 * so a workspace with drafts and chat history cached alongside them reaches the
 * ~5 MB origin quota in normal use. Swallowing the failure meant an upload
 * looked saved, survived until reload, and then vanished. Returns whether the
 * newest template is actually stored so the caller can say so.
 */
function savePersistedWordTemplates(items: PersistedWordTemplate[]): boolean {
  if (typeof window === "undefined") return false;
  const bounded = items.slice(0, 24);
  for (let keep = bounded.length; keep > 0; keep -= 1) {
    try {
      window.localStorage.setItem(WORD_TEMPLATE_STORAGE_KEY, JSON.stringify(bounded.slice(0, keep)));
      return true;
    } catch {
      // Out of room: retry with fewer remembered templates. `bounded` is
      // newest-first, so the template just uploaded is the last one dropped.
    }
  }
  try {
    window.localStorage.removeItem(WORD_TEMPLATE_STORAGE_KEY);
  } catch {
    // Nothing further to do; report the failure to the caller instead.
  }
  return false;
}

function isDraftDocumentHistoryItem(value: unknown): value is DraftDocumentHistoryItem {
  if (!value || typeof value !== "object") return false;
  const item = value as DraftDocumentHistoryItem;
  const validStatus =
    item.status === undefined ||
    item.status === "running" ||
    item.status === "complete" ||
    item.status === "failed";
  const validEvents =
    item.events === undefined ||
    (Array.isArray(item.events) &&
      item.events.every(
        (event) =>
          event &&
          typeof event === "object" &&
          typeof (event as AssistantEvent).id === "string" &&
          typeof (event as AssistantEvent).text === "string",
      ));
  return Boolean(
    item.id &&
      item.title &&
      typeof item.content === "string" &&
      item.updatedAt &&
      validStatus &&
      validEvents,
  );
}

function isPersistedWordTemplate(value: unknown): value is PersistedWordTemplate {
  if (!value || typeof value !== "object") return false;
  const template = value as PersistedWordTemplate;
  return Boolean(
    template.id &&
      template.name &&
      template.filename &&
      template.html &&
      template.text &&
      template.uploadedAt,
  );
}

type DraftHistorySnapshot = DraftSyncFields & {
  id?: string;
  title: string;
  content: string;
  summary: string;
  sourceLabel: string;
  status?: DraftDocumentHistoryItem["status"];
  updatedAt?: string;
  createdAt?: string;
  completedAt?: string;
  request?: string;
  events?: AssistantEvent[];
};

function upsertDraftDocumentHistory(
  current: DraftDocumentHistoryItem[],
  snapshot: DraftHistorySnapshot,
) {
  const title = snapshot.title.trim() || "Untitled Draft";
  const id = snapshot.id ?? createDraftHistoryId();
  const updatedAt = snapshot.updatedAt ?? new Date().toISOString();
  const existing = current.find((item) => item.id === id);
  const nextItem: DraftDocumentHistoryItem = {
    id,
    title,
    archived: existing?.archived ?? false,
    summary: snapshot.summary,
    sourceLabel: snapshot.sourceLabel,
    content: snapshot.content,
    updatedAt,
    status: snapshot.status ?? "complete",
    createdAt: snapshot.createdAt,
    completedAt: snapshot.completedAt,
    request: snapshot.request,
    events: snapshot.events,
    // Server-sync bookkeeping survives snapshots that do not mention it, so a
    // provider revision never silently unbinds a draft from its server copy.
    serverId: snapshot.serverId !== undefined ? snapshot.serverId : existing?.serverId,
    serverRevision:
      snapshot.serverRevision !== undefined ? snapshot.serverRevision : existing?.serverRevision,
    serverContentStale:
      snapshot.serverContentStale !== undefined
        ? snapshot.serverContentStale
        : existing?.serverContentStale,
    serverSavePending: snapshot.serverSavePending ?? existing?.serverSavePending,
    cacheWriterId: snapshot.cacheWriterId ?? existing?.cacheWriterId,
  };
  return limitDraftCacheEntries([
    nextItem,
    ...current.filter((item) => item.id !== id),
  ]);
}

function createDraftHistoryId() {
  return `draft-${crypto.randomUUID()}`;
}

function createDraftHistoryRunId(title: string, startedAt: string) {
  return `draft-run-${slugify(title) || "untitled"}-${Date.parse(startedAt) || Date.now()}`;
}

/** "Saved" is reserved for entries with a confirmed server copy; cache-only
 * entries are honestly labelled "Local only". */
function draftHistoryStatusLabel(item: Pick<DraftDocumentHistoryItem, "status" | "serverId" | "serverSavePending">) {
  if (item.status === "running") return "Drafting";
  if (item.serverId && item.serverSavePending) return "Local changes";
  if (item.status === "failed") return "Needs attention";
  return item.serverId ? "Saved" : "Local only";
}

function persistedWordTemplateFromUpload(template: UploadedWordTemplate): PersistedWordTemplate {
  const name = template.title.trim() || paperTitle(template.filename.replace(/\.[^.]+$/, ""));
  const id = `uploaded-${slugify(name) || slugify(template.filename) || Date.now()}`;
  return {
    id,
    name,
    filename: template.filename,
    description: `Reusable Word template from ${template.filename}`,
    html: template.html,
    text: template.text,
    uploadedAt: new Date().toISOString(),
  };
}

function upsertPersistedWordTemplate(
  current: PersistedWordTemplate[],
  template: PersistedWordTemplate,
) {
  return [
    template,
    ...current.filter((item) => item.id !== template.id),
  ].slice(0, 24);
}

function formatHistoryTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Saved";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function getEditorSelection(editor: HTMLElement | null) {
  const selection = window.getSelection?.();
  if (!editor || !selection || selection.rangeCount === 0) return null;
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode) return null;
  if (!editor.contains(anchorNode) || !editor.contains(focusNode)) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const selectedText = selection.toString().replace(/\s+/g, " ").trim();
  if (range.collapsed || !selectedText) return null;
  return { range: range.cloneRange(), text: selectedText };
}

function getCollapsedEditorRange(editor: HTMLElement | null) {
  const selection = window.getSelection?.();
  if (!editor || !selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  return isRangeInsideEditor(editor, range) ? range.cloneRange() : null;
}

function closestDocumentPage(node: Node, editor: HTMLElement) {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  const page = element?.closest<HTMLElement>("section.document-page") ?? null;
  return page && editor.contains(page) ? page : null;
}

function editablePageBlocks(page: HTMLElement) {
  return Array.from(page.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && !child.classList.contains("document-page-label"),
  );
}

function closestPageBlock(node: Node, page: HTMLElement) {
  let element = node instanceof HTMLElement ? node : node.parentElement;
  while (element && element.parentElement !== page) element = element.parentElement;
  return element?.parentElement === page ? element : null;
}

function isCaretAtBlockStart(block: HTMLElement, caret: Range) {
  try {
    const probe = document.createRange();
    probe.selectNodeContents(block);
    probe.setEnd(caret.startContainer, caret.startOffset);
    return probe.toString().length === 0;
  } catch {
    return false;
  }
}

function isCaretAtBlockEnd(block: HTMLElement, caret: Range) {
  try {
    const probe = document.createRange();
    probe.selectNodeContents(block);
    probe.setStart(caret.startContainer, caret.startOffset);
    return probe.toString().length === 0;
  } catch {
    return false;
  }
}

function placeCaretAtChildOffset(element: HTMLElement, offset: number) {
  const selection = window.getSelection?.();
  if (!selection) return;
  const range = document.createRange();
  range.setStart(element, Math.min(offset, element.childNodes.length));
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function placeCaretAtEdge(element: HTMLElement, atStart: boolean) {
  const selection = window.getSelection?.();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(atStart);
  selection.removeAllRanges();
  selection.addRange(range);
}

function canMergeEditableBlocks(destination: HTMLElement, source: HTMLElement) {
  const nonTextBlocks = new Set(["TABLE", "FIGURE", "PRE", "UL", "OL"]);
  return !nonTextBlocks.has(destination.tagName) && !nonTextBlocks.has(source.tagName);
}

function removeEmptyDocumentPage(page: HTMLElement, editor: HTMLElement) {
  if (editablePageBlocks(page).length || page.parentElement !== editor) return;
  page.remove();
}

function isRangeInsideEditor(editor: HTMLElement, range: Range) {
  const ancestor = range.commonAncestorContainer;
  return ancestor === editor || editor.contains(ancestor);
}

/** Fill-in rules — signature, printed name, date — render as a real ruled
 * line. A run of underscores is not one: it wraps mid-rule, changes length
 * with the font, and exports as literal characters instead of a line. The
 * element carries non-breaking spaces so the rule survives plain-text and
 * DOCX round-trips, while CSS gives it its consistent on-screen width. */
const SIGNATURE_LINE_CLASS = "document-signature-line";
const SIGNATURE_LINE_FILL = "\u00a0".repeat(24);
/** What the model writes when it ignores the markup instruction, and what a
 * pasted or transferred document carries. Four is past any `snake_case` or
 * `__dunder__` name. */
const SIGNATURE_UNDERSCORE_RUN = /_{4,}/;

function signatureLineElement() {
  const line = document.createElement("span");
  line.className = SIGNATURE_LINE_CLASS;
  line.textContent = SIGNATURE_LINE_FILL;
  return line;
}

/**
 * Makes every fill-in blank in AI-authored document HTML a real ruled line:
 * underscore runs become rules, an empty rule the model returned gets the
 * spaces it needs to draw, and a signature-block label left dangling gets the
 * rule it was asking for. Code blocks are left alone — underscores there are
 * content.
 */
function normalizeSignatureLines(root: ParentNode & Node) {
  root.querySelectorAll(`.${SIGNATURE_LINE_CLASS}`).forEach((line) => {
    if (!/[^\s_\u00a0]/.test(line.textContent ?? "")) line.textContent = SIGNATURE_LINE_FILL;
  });
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!SIGNATURE_UNDERSCORE_RUN.test(text.data)) continue;
    // `.document-blank` is an imported template's own blank, whose underscore
    // width came from the source document and is left as the author wrote it.
    if (text.parentElement?.closest(`pre, code, span.document-blank, .${SIGNATURE_LINE_CLASS}`)) {
      continue;
    }
    targets.push(text);
  }
  targets.forEach((text) => {
    const fragment = document.createDocumentFragment();
    // Split keeps the separators, so odd indexes are the underscore runs.
    text.data.split(/(_{4,})/).forEach((part, index) => {
      if (index % 2 === 1) fragment.appendChild(signatureLineElement());
      else if (part) fragment.appendChild(document.createTextNode(part));
    });
    text.replaceWith(fragment);
  });
  appendMissingSignatureRules(root);
}

/** Signature-block fields a model writes as a bare label. Asked not to draw
 * the blank with underscores, models routinely write "Signature:" and stop,
 * which leaves a form nobody can sign — so the rule the label is asking for is
 * added. Only these known fill-in fields qualify, and only when nothing at all
 * follows the colon. */
const FILL_IN_LABEL =
  /(?:signature|signed|printed name|print name|name|date|dated|by|title|witness|notary|attest|address)\s*:\s*$/i;

/** The node the rule should follow: the label's own text node, or the inline
 * wrapper it closes (`<strong>Signature:</strong>`), so the rule lands outside
 * the bold rather than inside it. Returns null when anything else follows the
 * label on that line — "Name: Jane Doe" is filled in already. */
function lineEndAfterLabel(text: Text): ChildNode | null {
  let node: ChildNode = text;
  while (!node.nextSibling) {
    const parent = node.parentElement;
    if (!parent || !INLINE_AI_INLINE_TAGS.has(parent.tagName.toLowerCase())) return node;
    node = parent;
  }
  const next = node.nextSibling;
  return next instanceof HTMLElement && next.tagName === "BR" ? node : null;
}

function appendMissingSignatureRules(root: ParentNode & Node) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: ChildNode[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!FILL_IN_LABEL.test(text.data)) continue;
    if (text.parentElement?.closest(`pre, code, a, .${SIGNATURE_LINE_CLASS}`)) continue;
    const anchor = lineEndAfterLabel(text);
    if (anchor) targets.push(anchor);
  }
  targets.forEach((anchor) => {
    anchor.after(document.createTextNode(" "), signatureLineElement());
  });
}

function applyDocumentSignatureLines(html: string) {
  if (typeof document === "undefined") return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  normalizeSignatureLines(template.content);
  return template.innerHTML;
}

/** Every AI-authored draft body enters the editor through here, so a fill-in
 * rule is a real line no matter which surface produced it. */
function documentHtmlFromMarkdown(markdown: string) {
  return applyDocumentSignatureLines(markdownToDocumentHtml(markdown));
}

function documentImageSources(contentHtml: string) {
  if (typeof document === "undefined") return [];
  const template = document.createElement("template");
  template.innerHTML = contentHtml;
  return Array.from(template.content.querySelectorAll<HTMLImageElement>("img[src]"))
    .map((image) => image.getAttribute("src")?.trim() ?? "")
    .filter((src, index, sources) => Boolean(src) && sources.indexOf(src) === index);
}

/** Formatting the document surface can actually render, so the model is told
 * what it may return instead of guessing and falling back to markdown syntax
 * that would land in the page as literal characters. */
const INLINE_AI_FORMAT_RULES = [
  "Formatting rules:",
  "- Return an HTML fragment whenever the instruction needs structure or formatting, and plain text when it does not.",
  "- Allowed tags: p, h1, h2, h3, ul, ol, li, table, thead, tbody, tr, th, td, blockquote, pre, code, strong, em, u, s, sup, sub, a, br, hr, span.",
  '- Never write markdown syntax such as "-", "*", "#", or "**" as literal characters. Express that structure with the tags above.',
  "- Match the highlighted passage: return <li> elements when the highlight is in a list, and inline content only when the highlight is part of a sentence.",
  `- Draw a fill-in rule (signature, printed name, date, blank to complete) with <span class="${SIGNATURE_LINE_CLASS}"></span> — for example <p>Signature: <span class="${SIGNATURE_LINE_CLASS}"></span></p>. Never draw one with underscores, hyphens, or dots, and never leave the label with nothing after it.`,
  '- Inline styles are limited to color, background-color, text-align, font-size, and font-family on <span style="…">.',
].join("\n");

function inlineRewritePrompt({
  documentTitle,
  instruction,
  selectedText,
  selectedHtml = "",
  structureHint = "",
  surface = "document",
}: {
  documentTitle: string;
  instruction: string;
  selectedText: string;
  /** Markup of the highlight itself, so a reply can mirror the structure it
   * replaces. Empty when the highlight is plain text. */
  selectedHtml?: string;
  /** One sentence describing where the highlight sits in the document. */
  structureHint?: string;
  /** Same rewrite contract on both drafting surfaces; only the framing noun
   * changes, and slides additionally forbid markup (regions are plain runs). */
  surface?: "document" | "slide";
}) {
  return [
    surface === "slide"
      ? `You are editing a highlighted passage on one slide of the presentation titled "${documentTitle}".`
      : `You are editing a highlighted passage in the draft titled "${documentTitle}".`,
    "Rewrite only the highlighted passage according to the user's instruction.",
    surface === "slide"
      ? "Return only the replacement text as plain text — no quotes, no markdown, no headings, no explanations, and no surrounding slide content."
      : "Return only the replacement text. Do not add labels, explanations, or any surrounding document section.",
    ...(surface === "slide" ? [] : ["", INLINE_AI_FORMAT_RULES]),
    "",
    "User instruction:",
    instruction,
    ...(structureHint ? ["", "Where the highlight sits:", structureHint] : []),
    ...(selectedHtml ? ["", "Highlighted passage (HTML):", selectedHtml] : []),
    "",
    "Highlighted passage:",
    selectedText,
  ].join("\n");
}

/** Tags the reply may use inside a sentence. Anything else it returns is
 * block-level and has to be spliced in as a real block. */
const INLINE_AI_INLINE_TAGS = new Set([
  "span",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "del",
  "ins",
  "mark",
  "code",
  "sup",
  "sub",
  "a",
  "br",
  "small",
  "cite",
  "q",
  "time",
]);

/** Blocks the inline edit can split or replace outright. */
const INLINE_AI_BLOCK_SELECTOR =
  "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,dt,dd,figcaption,td,th";

const INLINE_AI_BLOCK_LABELS: Record<string, string> = {
  p: "paragraph",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  blockquote: "block quote",
  pre: "code block",
  td: "table cell",
  th: "table header cell",
  dt: "term",
  dd: "definition",
  figcaption: "figure caption",
};

/**
 * Turns the model's reply into document HTML the editor can render. Markdown
 * replies are converted rather than pasted, so bullets and headings arrive as
 * real elements instead of literal "-" and "#" characters, and everything is
 * sanitized before it can reach the page. A reply that is a single paragraph of
 * running text is unwrapped to inline content so a one-sentence rewrite stays
 * inside the sentence it replaces.
 */
const INLINE_AI_REPLY_LABEL = /^(?:replacement|rewrite|revised(?: text)?|edited(?: text)?):\s*/i;

function inlineAiReplacementHtmlFromReply(value: string) {
  const unfenced = value
    .trim()
    .replace(/^```(?:html|markdown|md|text)?\s*\n([\s\S]*?)\n```$/i, "$1")
    .trim();
  if (!unfenced) return "";
  const looksLikeHtml = /<\/?[a-z][\s\S]*>/i.test(unfenced);
  const rawHtml = looksLikeHtml
    ? unfenced
    : markdownToDocumentHtml(
        unfenced.replace(INLINE_AI_REPLY_LABEL, "").replace(/^["“]|["”]$/g, "").trim(),
      );
  const sanitized = sanitizeDocumentHtml(rawHtml).trim();
  if (typeof document === "undefined") return sanitized;
  const template = document.createElement("template");
  template.innerHTML = sanitized;
  stripInlineAiReplyLabel(template.content);
  normalizeSignatureLines(template.content);
  return unwrapSoleInlineParagraph(template.content);
}

/** Drops a "Replacement:" style preamble the model sometimes writes ahead of
 * the rewrite, including when it sits inside the first block it returned. */
function stripInlineAiReplyLabel(root: DocumentFragment) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const text = node.textContent ?? "";
    if (text.trim()) {
      node.textContent = text.replace(/^\s+/, "").replace(INLINE_AI_REPLY_LABEL, "");
      return;
    }
    node = walker.nextNode();
  }
}

/** `<p>one sentence</p>` is what a plain-text reply becomes after the markdown
 * pass; inside running text that paragraph wrapper is noise, so it is dropped
 * when it carries nothing but inline content. */
function unwrapSoleInlineParagraph(root: DocumentFragment) {
  const html = (root.firstChild ? containerHtml(root) : "").trim();
  const nodes = Array.from(root.childNodes).filter(
    (node) => node.nodeType !== Node.TEXT_NODE || (node.textContent ?? "").trim(),
  );
  const only = nodes[0];
  if (nodes.length !== 1 || !(only instanceof HTMLElement) || only.tagName !== "P") return html;
  if (only.getAttribute("style") || only.getAttribute("class")) return html;
  const hasBlockChild = Array.from(only.children).some(
    (child) => !INLINE_AI_INLINE_TAGS.has(child.tagName.toLowerCase()),
  );
  return hasBlockChild ? html : only.innerHTML.trim();
}

function containerHtml(root: DocumentFragment) {
  const holder = document.createElement("div");
  holder.appendChild(root.cloneNode(true));
  return holder.innerHTML;
}

function inlineAiBlockAncestor(node: Node, editor: HTMLElement) {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  const block = element?.closest<HTMLElement>(INLINE_AI_BLOCK_SELECTOR) ?? null;
  return block && block !== editor && editor.contains(block) ? block : null;
}

/** True when the highlight spans everything inside its block, which means a
 * structural reply can replace the block instead of splitting it. */
function rangeCoversBlock(block: HTMLElement, range: Range) {
  try {
    const before = document.createRange();
    before.selectNodeContents(block);
    before.setEnd(range.startContainer, range.startOffset);
    const after = document.createRange();
    after.selectNodeContents(block);
    after.setStart(range.endContainer, range.endOffset);
    return !before.toString().trim() && !after.toString().trim();
  } catch {
    return false;
  }
}

/** Describes the highlight's surroundings for the prompt so the model returns
 * markup that fits where it lands. */
function inlineAiStructureHint(editor: HTMLElement, range: Range) {
  const block = inlineAiBlockAncestor(range.startContainer, editor);
  if (!block) return "The highlight sits directly in the document body.";
  const tag = block.tagName.toLowerCase();
  const scope = rangeCoversBlock(block, range) ? "covers the whole" : "covers part of a";
  if (tag === "li") {
    const listTag = block.parentElement?.tagName.toLowerCase() === "ol" ? "ol" : "ul";
    const listLabel = listTag === "ol" ? "numbered" : "bulleted";
    return `The highlight ${scope} list item inside a ${listLabel} list (<${listTag}> > <li>). Return <li> elements so new items join that list.`;
  }
  const label = INLINE_AI_BLOCK_LABELS[tag] ?? "block";
  return `The highlight ${scope} ${label} (<${tag}>). Return inline content unless the instruction asks for new blocks.`;
}

/** Markup of the highlight itself, capped so a large selection cannot dominate
 * the prompt. Returns "" when the highlight carries no markup worth showing. */
function inlineAiSelectionHtml(range: Range) {
  try {
    const holder = document.createElement("div");
    holder.appendChild(range.cloneContents());
    const html = sanitizeDocumentHtml(holder.innerHTML).trim();
    if (!html.includes("<")) return "";
    return html.length > 4000 ? `${html.slice(0, 4000)}…` : html;
  } catch {
    return "";
  }
}

function isInlineAiNode(node: Node) {
  if (node.nodeType === Node.TEXT_NODE) return true;
  return node instanceof HTMLElement && INLINE_AI_INLINE_TAGS.has(node.tagName.toLowerCase());
}

/** When an AI edit landed and which model made it. Stamped on every inserted
 * run so the AI edit trail reports real provenance instead of a guess. */
type AiEditStamp = { at: string; by: string };

function markInlineAiSuggestion<T extends HTMLElement>(element: T, stamp?: AiEditStamp) {
  element.classList.add("document-ai-suggestion");
  if (stamp) {
    element.setAttribute("data-ai-edit-at", stamp.at);
    element.setAttribute("data-ai-edit-by", stamp.by);
  }
  return element;
}

export type AiEditTrailEntry = {
  /** Index of this edit's first run among the document's stamped runs, which
   * is how the trail scrolls back to it. */
  index: number;
  at: string;
  by: string;
  text: string;
  runs: number;
};

/** Reads the AI edit trail out of stored document HTML. Runs that share a
 * timestamp and model are one edit — a single inline edit can leave several
 * paragraphs or list items behind. Newest first. */
export function aiEditTrailFromHtml(html: string): AiEditTrailEntry[] {
  if (typeof document === "undefined" || !html.includes("data-ai-edit-at")) return [];
  const template = document.createElement("template");
  template.innerHTML = html;
  const entries = new Map<string, AiEditTrailEntry>();
  Array.from(template.content.querySelectorAll<HTMLElement>("[data-ai-edit-at]")).forEach(
    (run, index) => {
      const at = run.getAttribute("data-ai-edit-at") ?? "";
      const by = run.getAttribute("data-ai-edit-by") ?? "";
      const text = (run.textContent ?? "").replace(/\s+/g, " ").trim();
      const key = `${at}|${by}`;
      const existing = entries.get(key);
      if (!existing) {
        entries.set(key, { index, at, by, text, runs: 1 });
        return;
      }
      existing.runs += 1;
      if (text) existing.text = existing.text ? `${existing.text} ${text}` : text;
    },
  );
  return Array.from(entries.values()).sort((a, b) => b.at.localeCompare(a.at));
}

/** Whether a node still carries something a reader would see. A lone `<br>`
 * does not count: contenteditable leaves those behind in emptied blocks. */
function hasRenderableContent(node: ParentNode & Node) {
  return Boolean((node.textContent ?? "").trim() || node.querySelector("img,table,figure,hr"));
}

/** Flattens a list-shaped reply into the `<li>` elements it is made of, or
 * returns null when the reply is not purely list content. */
function inlineAiListItems(nodes: Node[]) {
  const items: HTMLElement[] = [];
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.textContent ?? "").trim()) return null;
      continue;
    }
    if (!(node instanceof HTMLElement)) return null;
    const tag = node.tagName.toLowerCase();
    if (tag === "li") {
      items.push(node);
      continue;
    }
    if (tag !== "ul" && tag !== "ol") return null;
    Array.from(node.children).forEach((child) => {
      if (child instanceof HTMLElement && child.tagName.toLowerCase() === "li") items.push(child);
    });
  }
  return items.length ? items : null;
}

/** A model editing a bullet often answers with plain lines rather than `<li>`
 * elements. Inside a list that intent is unambiguous, so simple paragraphs
 * become items instead of breaking the list apart. Returns null when the reply
 * carries real structure (a heading, table, or quote) that belongs outside the
 * list. */
function paragraphsAsListItems(blocks: HTMLElement[]) {
  const items: HTMLElement[] = [];
  for (const block of blocks) {
    if (block.tagName !== "P" || block.getAttribute("style")) return null;
    const hasBlockChild = Array.from(block.children).some(
      (child) => !INLINE_AI_INLINE_TAGS.has(child.tagName.toLowerCase()),
    );
    if (hasBlockChild) return null;
    const item = document.createElement("li");
    while (block.firstChild) item.appendChild(block.firstChild);
    items.push(item);
  }
  return items.length ? items : null;
}

/** Groups a structural reply into top-level blocks, wrapping any loose inline
 * runs in a paragraph so nothing is inserted as a bare text node between
 * blocks. */
function inlineAiBlockNodes(nodes: Node[]) {
  const blocks: HTMLElement[] = [];
  let pending: Node[] = [];
  const flush = () => {
    const carried = pending;
    pending = [];
    if (!carried.some((node) => (node.textContent ?? "").trim())) return;
    const paragraph = document.createElement("p");
    carried.forEach((node) => paragraph.appendChild(node));
    blocks.push(paragraph);
  };
  nodes.forEach((node) => {
    if (isInlineAiNode(node)) {
      pending.push(node);
      return;
    }
    flush();
    if (node instanceof HTMLElement) blocks.push(node);
  });
  flush();
  return blocks;
}

/** Moves whatever follows the caret in `block` into a copy of that block placed
 * right after it, so replacement blocks can sit between the two halves. Returns
 * null when nothing followed the caret. */
function splitInlineAiBlock(block: HTMLElement, caret: Range) {
  let tailContents: DocumentFragment;
  try {
    const tailRange = document.createRange();
    tailRange.selectNodeContents(block);
    tailRange.setStart(caret.startContainer, caret.startOffset);
    tailContents = tailRange.extractContents();
  } catch {
    return null;
  }
  if (!hasRenderableContent(tailContents)) return null;
  const tail = block.cloneNode(false) as HTMLElement;
  tail.classList.remove("document-ai-suggestion");
  tail.appendChild(tailContents);
  block.after(tail);
  return tail;
}

/** Places blocks after the list that `item` belongs to, carrying the items that
 * followed it into a second list, so a paragraph or table never ends up as an
 * invalid child of `<ul>`. */
function insertBlocksAroundListItem(item: HTMLElement, blocks: HTMLElement[]) {
  const list = item.parentElement;
  if (!list || !/^(ul|ol)$/i.test(list.tagName)) return false;
  const trailing: Element[] = [];
  let sibling = item.nextElementSibling;
  while (sibling) {
    trailing.push(sibling);
    sibling = sibling.nextElementSibling;
  }
  const fragment = document.createDocumentFragment();
  blocks.forEach((block) => fragment.appendChild(block));
  list.after(fragment);
  if (trailing.length) {
    const nextList = list.cloneNode(false) as HTMLElement;
    trailing.forEach((node) => nextList.appendChild(node));
    blocks[blocks.length - 1].after(nextList);
  }
  return true;
}

/** Removes a list the edit emptied, so no bare `<ul></ul>` is left behind. */
function removeEmptiedList(list: Element | null | undefined) {
  if (!list?.isConnected || !/^(ul|ol)$/i.test(list.tagName)) return;
  if (!list.querySelector("li")) list.remove();
}

/**
 * Replaces the highlighted range with the model's reply, keeping the reply's
 * own structure. Inline replies stay inside the sentence they replace; list,
 * heading, and table replies are spliced in as real blocks — including out of a
 * list when the reply is not list content. Returns the last inserted node so
 * the caret can be parked after the edit, or null when the reply was empty.
 */
function insertInlineAiSuggestion(
  editor: HTMLElement,
  range: Range,
  html: string,
  stamp: AiEditStamp,
): Node | null {
  const template = document.createElement("template");
  template.innerHTML = html;
  const nodes = Array.from(template.content.childNodes);
  if (!nodes.length) return null;

  const block = inlineAiBlockAncestor(range.startContainer, editor);
  const blockTag = block?.tagName.toLowerCase() ?? "";

  if (nodes.every(isInlineAiNode)) {
    const marker = markInlineAiSuggestion(document.createElement("span"), stamp);
    nodes.forEach((node) => marker.appendChild(node));
    range.deleteContents();
    range.insertNode(marker);
    return marker;
  }

  const endBlock = inlineAiBlockAncestor(range.endContainer, editor);
  const blocks = inlineAiBlockNodes(nodes);
  if (!blocks.length) return null;
  const listItems =
    blockTag === "li" ? (inlineAiListItems(nodes) ?? paragraphsAsListItems(blocks)) : null;
  if (block && listItems) {
    listItems.forEach((item) => markInlineAiSuggestion(item, stamp));
    if (endBlock === block && !rangeCoversBlock(block, range)) {
      // Only part of one item was highlighted: the first new item takes the
      // highlighted words' place and the rest follow as their own bullets.
      const [first, ...rest] = listItems;
      const marker = markInlineAiSuggestion(document.createElement("span"), stamp);
      while (first.firstChild) marker.appendChild(first.firstChild);
      range.deleteContents();
      range.insertNode(marker);
      if (rest.length) block.after(...rest);
      return rest.length ? rest[rest.length - 1] : marker;
    }
    // Whole items — possibly several — were highlighted, so the new items take
    // their place and any item the highlight emptied is dropped.
    range.deleteContents();
    block.after(...listItems);
    [block, endBlock].forEach((item) => {
      if (item?.isConnected && item.tagName === "LI" && !hasRenderableContent(item)) item.remove();
    });
    return listItems[listItems.length - 1];
  }

  blocks.forEach((node) => markInlineAiSuggestion(node, stamp));

  // Table cells and the page body already hold blocks, so the reply can drop in
  // where the highlight was.
  if (!block || blockTag === "td" || blockTag === "th") {
    range.deleteContents();
    const fragment = document.createDocumentFragment();
    blocks.forEach((node) => fragment.appendChild(node));
    range.insertNode(fragment);
    return blocks[blocks.length - 1];
  }

  const list = blockTag === "li" ? block.parentElement : null;
  range.deleteContents();
  splitInlineAiBlock(block, range);
  if (blockTag !== "li" || !insertBlocksAroundListItem(block, blocks)) {
    const fragment = document.createDocumentFragment();
    blocks.forEach((node) => fragment.appendChild(node));
    block.after(fragment);
  }
  if (!hasRenderableContent(block)) block.remove();
  removeEmptiedList(list);
  return blocks[blocks.length - 1];
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function countExistingCitations(value: string) {
  return (value.match(/class="document-citation"/g) ?? []).length;
}

function insertHtmlAtSelection(editor: HTMLElement, html: string) {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) {
    editor.insertAdjacentHTML("beforeend", html);
    return;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  const template = document.createElement("template");
  template.innerHTML = html;
  const fragment = template.content;
  const lastNode = fragment.lastChild;
  range.insertNode(fragment);
  if (!lastNode) return;
  range.setStartAfter(lastNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function applyColorFallback(editor: HTMLElement, color: string) {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) {
    editor.insertAdjacentHTML(
      "beforeend",
      `<span style="color: ${escapeHtml(color)}">colored text</span>`,
    );
    return;
  }

  const range = selection.getRangeAt(0);
  if (range.collapsed) {
    range.insertNode(document.createTextNode(""));
    editor.insertAdjacentHTML(
      "beforeend",
      `<span style="color: ${escapeHtml(color)}">colored text</span>`,
    );
    return;
  }

  const wrapper = document.createElement("span");
  wrapper.style.color = color;
  wrapper.appendChild(range.extractContents());
  range.insertNode(wrapper);
  selection.removeAllRanges();
  const nextRange = document.createRange();
  nextRange.selectNodeContents(wrapper);
  nextRange.collapse(false);
  selection.addRange(nextRange);
}

function editorFormatStatesEqual(a: EditorFormatState, b: EditorFormatState) {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strikethrough === b.strikethrough &&
    a.superscript === b.superscript &&
    a.subscript === b.subscript &&
    a.align === b.align &&
    a.blockStyle === b.blockStyle &&
    a.fontSizePx === b.fontSizePx &&
    a.fontFamily === b.fontFamily
  );
}

/** Reads the real formatting at the caret from the DOM so toolbar toggles
 * reflect the document instead of an assumed state. Works without
 * queryCommandState, which non-browser test runtimes do not implement. */
function computeEditorFormatState(editor: HTMLElement | null): EditorFormatState {
  const state = { ...DEFAULT_EDITOR_FORMAT_STATE };
  const selection = window.getSelection?.();
  if (!editor || !selection || selection.rangeCount === 0) return state;
  const node = selection.focusNode ?? selection.anchorNode;
  if (!node || !editor.contains(node)) return state;
  let element = node instanceof HTMLElement ? node : node.parentElement;
  let blockCaptured = false;
  while (element && element !== editor) {
    const tag = element.tagName;
    if (tag === "B" || tag === "STRONG") state.bold = true;
    if (tag === "I" || tag === "EM") state.italic = true;
    if (tag === "U") state.underline = true;
    if (tag === "S" || tag === "STRIKE" || tag === "DEL") state.strikethrough = true;
    if (tag === "SUP") state.superscript = true;
    if (tag === "SUB") state.subscript = true;
    const inline = element.style;
    if (inline) {
      if (/^(bold|[6-9]00)$/.test(inline.fontWeight)) state.bold = true;
      if (inline.fontStyle === "italic") state.italic = true;
      const decoration = `${inline.textDecoration} ${inline.textDecorationLine ?? ""}`;
      if (decoration.includes("underline")) state.underline = true;
      if (decoration.includes("line-through")) state.strikethrough = true;
      // The innermost override wins, so only the first value found while
      // walking outward is kept.
      if (inline.fontSize && !state.fontSizePx) state.fontSizePx = inline.fontSize;
      if (inline.fontFamily && !state.fontFamily) {
        state.fontFamily = normalizedFontFamily(inline.fontFamily);
      }
    }
    if (!blockCaptured && /^(P|H1|H2|H3|BLOCKQUOTE)$/.test(tag)) {
      blockCaptured = true;
      state.blockStyle = tag.toLowerCase();
      const align = element.style.textAlign;
      if (align === "center" || align === "right" || align === "justify") {
        state.align = align;
      }
    }
    element = element.parentElement;
  }
  return state;
}

/** Rewrites legacy execCommand output (font tags) into span-based inline
 * styles, and drops no-op wrappers, so the stored draft round-trips through
 * the sanitizer, print, and DOCX export without losing formatting. */
function normalizeEditorInlineMarkup(editor: HTMLElement) {
  editor.querySelectorAll("font").forEach((font) => {
    const color = font.getAttribute("color") ?? "";
    const hasSizeAttr = font.hasAttribute("size");
    const sizePx = LEGACY_FONT_SIZE_PX[font.getAttribute("size") ?? ""] ?? "";
    // The font wrapper is the newest formatting for this text; older spans it
    // now wraps must not keep competing values, so "Normal" genuinely resets.
    font.querySelectorAll<HTMLElement>("span[style]").forEach((inner) => {
      if (hasSizeAttr) inner.style.removeProperty("font-size");
      if (color) inner.style.removeProperty("color");
      if (!inner.getAttribute("style")) inner.removeAttribute("style");
    });
    const span = document.createElement("span");
    if (color) span.style.color = color;
    if (sizePx) span.style.fontSize = sizePx;
    while (font.firstChild) span.appendChild(font.firstChild);
    if (span.getAttribute("style")) {
      font.replaceWith(span);
    } else {
      const fragment = document.createDocumentFragment();
      while (span.firstChild) fragment.appendChild(span.firstChild);
      font.replaceWith(fragment);
    }
  });
  editor.querySelectorAll<HTMLElement>("span[style]").forEach((span) => {
    const background = span.style.backgroundColor;
    if (background === "transparent" || background === "rgba(0, 0, 0, 0)") {
      span.style.removeProperty("background-color");
    }
    if (!span.getAttribute("style")) span.removeAttribute("style");
  });
  editor.querySelectorAll("span").forEach((span) => {
    if (span.attributes.length > 0) return;
    const fragment = document.createDocumentFragment();
    while (span.firstChild) fragment.appendChild(span.firstChild);
    span.replaceWith(fragment);
  });
}

/** Focuses the editor without losing the user's text selection: some
 * environments collapse the document selection when focus moves, which would
 * make a formatting click silently target nothing. */
function focusEditorPreservingSelection(editor: HTMLElement) {
  const selection = window.getSelection?.();
  const savedRange =
    selection && selection.rangeCount > 0 && isRangeInsideEditor(editor, selection.getRangeAt(0))
      ? selection.getRangeAt(0).cloneRange()
      : null;
  editor.focus();
  if (selection && savedRange) {
    selection.removeAllRanges();
    selection.addRange(savedRange);
  }
}

/** Wraps the current selection in a span carrying one inline style, first
 * stripping the same property from any nested spans (and legacy font tags)
 * so the new value genuinely wins. `value === null` clears the property —
 * the un-styled wrapper is unwrapped by the next normalize pass. Returns
 * false when there is no usable selection inside `root`. */
function applySelectionInlineStyle(
  root: HTMLElement,
  property: "font-size" | "font-family",
  value: string | null,
) {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0 || !root.contains(selection.anchorNode)) {
    return false;
  }
  const range = selection.getRangeAt(0);
  if (range.collapsed) return false;
  const span = document.createElement("span");
  if (value) span.style.setProperty(property, value);
  try {
    const fragment = range.extractContents();
    fragment.querySelectorAll?.("span[style], font").forEach((element) => {
      if (element instanceof HTMLElement) {
        element.style.removeProperty(property);
        if (!element.getAttribute("style")?.trim()) element.removeAttribute("style");
      }
      if (property === "font-family") element.removeAttribute("face");
      if (property === "font-size" && element.tagName === "FONT") {
        element.removeAttribute("size");
      }
    });
    span.appendChild(fragment);
    range.insertNode(span);
  } catch {
    return false;
  }
  // The wrapper lands INSIDE any styled ancestor the selection was part of,
  // so a reset (or a new value on font-size, where inner wins anyway) must
  // also clear ancestors the selection fully covers — otherwise their value
  // keeps cascading onto the now-unstyled text.
  let ancestor = span.parentElement;
  while (ancestor && ancestor !== root) {
    if (
      ancestor.style?.getPropertyValue(property) &&
      ancestor.textContent === span.textContent
    ) {
      ancestor.style.removeProperty(property);
      if (!ancestor.getAttribute("style")?.trim()) ancestor.removeAttribute("style");
    }
    ancestor = ancestor.parentElement;
  }
  selection.removeAllRanges();
  const nextRange = document.createRange();
  nextRange.selectNodeContents(span);
  selection.addRange(nextRange);
  return true;
}

/** Wraps the current selection in a freshly built element. Returns false when
 * there is no usable selection or the range cannot be wrapped cleanly. */
function wrapSelectionFallback(editor: HTMLElement, build: () => HTMLElement) {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) {
    return false;
  }
  const range = selection.getRangeAt(0);
  if (range.collapsed) return false;
  const wrapper = build();
  try {
    wrapper.appendChild(range.extractContents());
    range.insertNode(wrapper);
  } catch {
    return false;
  }
  selection.removeAllRanges();
  const nextRange = document.createRange();
  nextRange.selectNodeContents(wrapper);
  selection.addRange(nextRange);
  return true;
}

function selectionBlockElement(editor: HTMLElement) {
  const selection = window.getSelection?.();
  const node = selection?.focusNode ?? selection?.anchorNode ?? null;
  let element = node instanceof HTMLElement ? node : node?.parentElement ?? null;
  while (element && element !== editor && !/^(P|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|LI|PRE|DIV)$/.test(element.tagName)) {
    element = element.parentElement;
  }
  if (element && element !== editor && editor.contains(element)) return element;
  return editor.querySelector<HTMLElement>("p,h1,h2,h3,blockquote,li");
}

function unwrapElement(element: HTMLElement) {
  const fragment = element.ownerDocument.createDocumentFragment();
  while (element.firstChild) fragment.appendChild(element.firstChild);
  element.replaceWith(fragment);
}

/** Direct DOM equivalents for the editor commands, used where execCommand is
 * unavailable (non-browser test runtimes) or reports failure. */
function applyEditorCommandFallback(editor: HTMLElement, command: string, value?: string) {
  if (command === "foreColor" && value) {
    applyColorFallback(editor, value);
    return;
  }
  if (command === "hiliteColor" && value) {
    wrapSelectionFallback(editor, () => {
      const span = document.createElement("span");
      span.style.backgroundColor = value;
      return span;
    });
    return;
  }
  if (command === "strikeThrough") {
    wrapSelectionFallback(editor, () => document.createElement("s"));
    return;
  }
  if (command === "superscript") {
    wrapSelectionFallback(editor, () => document.createElement("sup"));
    return;
  }
  if (command === "subscript") {
    wrapSelectionFallback(editor, () => document.createElement("sub"));
    return;
  }
  if (command === "createLink" && value) {
    wrapSelectionFallback(editor, () => {
      const anchor = document.createElement("a");
      anchor.setAttribute("href", value);
      anchor.setAttribute("rel", "noreferrer");
      return anchor;
    });
    return;
  }
  if (command === "unlink") {
    const selection = window.getSelection?.();
    const node = selection?.focusNode ?? selection?.anchorNode ?? null;
    const anchor = closestEditorAnchor(node, editor);
    if (anchor) unwrapElement(anchor);
    return;
  }
  if (command === "removeFormat") {
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (range.collapsed || !editor.contains(range.commonAncestorContainer)) return;
    const scope =
      range.commonAncestorContainer instanceof HTMLElement
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    scope
      ?.querySelectorAll<HTMLElement>("b,strong,i,em,u,s,strike,del,sup,sub,mark,span,font")
      .forEach((element) => {
        if (typeof range.intersectsNode === "function" && !range.intersectsNode(element)) return;
        unwrapElement(element);
      });
    return;
  }
  if (command.startsWith("justify")) {
    const align =
      command === "justifyCenter"
        ? "center"
        : command === "justifyRight"
          ? "right"
          : command === "justifyFull"
            ? "justify"
            : "left";
    const block = selectionBlockElement(editor);
    if (!block) return;
    if (align === "left") block.style.removeProperty("text-align");
    else block.style.textAlign = align;
    if (!block.getAttribute("style")) block.removeAttribute("style");
    return;
  }
  if (command === "formatBlock" && value) {
    const block = selectionBlockElement(editor);
    if (!block || block.tagName === "LI") return;
    const replacement = document.createElement(value);
    while (block.firstChild) replacement.appendChild(block.firstChild);
    block.replaceWith(replacement);
  }
}

function closestEditorAnchor(node: Node | null, editor: HTMLElement | null) {
  if (!node || !editor) return null;
  const element = node instanceof HTMLElement ? node : node.parentElement;
  const anchor = element?.closest("a") ?? null;
  return anchor && editor.contains(anchor) ? anchor : null;
}

/** Accepts http(s) URLs, in-document anchors, and bare domains (upgraded to
 * https). Anything else — including schemes the stored-draft sanitizer would
 * strip on reload — is rejected instead of silently kept. */
function normalizeLinkUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("#")) return trimmed;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(trimmed)) return `https://${trimmed}`;
  return null;
}

function isImageInsertRequest(instruction: string) {
  return /\b(add|insert|include|place|find|grab|search)\b/i.test(instruction)
    && hasVisualRequest(instruction);
}

function hasVisualRequest(instruction: string) {
  return /\b(images?|pictures?|photos?|graphics?|visuals?|charts?)\b/i.test(instruction);
}

/** Deck requests name imagery more broadly than document image inserts —
 * backgrounds, artwork, and illustrations all count as "make it visual". */
function deckWantsImagery(instruction: string) {
  return /\b(images?|pictures?|photos?|graphics?|visuals?|illustrations?|artwork|backgrounds?|backdrops?|imagery)\b/i.test(
    instruction,
  );
}

function extractVisualSubject(request: string, fallbackTitle: string) {
  const cleaned = request.replace(/\s+/g, " ").trim().replace(/[.?!]+$/, "");
  const match =
    cleaned.match(/\b(?:of|about|for|showing)\s+(?:an?\s+|the\s+)?(.+)$/i) ??
    cleaned.match(/\b(?:image|picture|photo|graphic|visual|chart)\s+(?:of|about|for)?\s*(.+)$/i);
  const subject = cleanDraftSubject(match?.[1] ?? fallbackTitle);
  return subject || "the current document";
}

type WebImageResult = {
  url: string;
  caption: string;
  source: string;
};

async function resolveWebImageResult(subject: string): Promise<WebImageResult> {
  if (typeof fetch === "function") {
    try {
      const endpoint = new URL("https://en.wikipedia.org/w/api.php");
      endpoint.searchParams.set("action", "query");
      endpoint.searchParams.set("generator", "search");
      endpoint.searchParams.set("gsrsearch", subject);
      endpoint.searchParams.set("gsrlimit", "5");
      endpoint.searchParams.set("prop", "pageimages");
      endpoint.searchParams.set("pithumbsize", "1200");
      endpoint.searchParams.set("origin", "*");
      endpoint.searchParams.set("format", "json");
      const response = await fetch(endpoint.toString());
      const payload = (await response.json()) as {
        query?: { pages?: Record<string, { title?: string; thumbnail?: { source?: string } }> };
      };
      const page = Object.values(payload.query?.pages ?? {}).find(
        (item) => item.thumbnail?.source,
      );
      if (page?.thumbnail?.source) {
        return {
          url: page.thumbnail.source,
          caption: page.title ? `${page.title} image result` : `Web image result for ${subject}`,
          source: "Wikipedia",
        };
      }
    } catch {
      // Use the offline-safe generated placeholder below when the image search endpoint is unreachable.
    }
  }

  return {
    url: inlineImageDataUrl(subject),
    caption: `Visual result for ${subject}`,
    source: "Aperture local fallback",
  };
}

function webImageHtml(result: WebImageResult, subject: string) {
  return `<figure class="document-media-block" contenteditable="false"><img src="${escapeHtml(
    result.url,
  )}" alt="${escapeHtml(subject)}"><figcaption>${escapeHtml(result.caption)} · ${escapeHtml(
    result.source,
  )}</figcaption></figure>`;
}

function inlineImageDataUrl(subject: string) {
  const label = escapeHtml(paperTitle(subject)).slice(0, 80);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="700" viewBox="0 0 1200 700"><defs><linearGradient id="sky" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#092238"/><stop offset="1" stop-color="#0b8c95"/></linearGradient></defs><rect width="1200" height="700" fill="url(#sky)"/><circle cx="960" cy="142" r="88" fill="#f5fbff" opacity=".9"/><circle cx="980" cy="120" r="18" fill="#c8d9e5" opacity=".8"/><circle cx="920" cy="164" r="12" fill="#c8d9e5" opacity=".7"/><path d="M110 565 344 354 492 470 624 342 1090 565Z" fill="#dbeef3" opacity=".42"/><path d="M650 480c92-76 180-166 264-270" fill="none" stroke="#8ee6ef" stroke-width="8" stroke-linecap="round" stroke-dasharray="18 18"/><path d="M452 330l94-36 48 132-72 26z" fill="#ffffff"/><path d="M534 294l172-66-92 142z" fill="#c8edf0"/><path d="M536 390l104 34-94 48z" fill="#74c8d0"/><circle cx="468" cy="392" r="28" fill="#173247"/><text x="86" y="102" font-family="Arial, sans-serif" font-size="28" font-weight="700" fill="#ffffff">Aperture Drafts visual</text><text x="86" y="148" font-family="Arial, sans-serif" font-size="42" font-weight="800" fill="#ffffff">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function sampleChartHtml() {
  return `<figure class="document-chart-block" contenteditable="false"><figcaption>Inserted chart</figcaption><div class="document-chart-bars"><span style="height: 42%"></span><span style="height: 70%"></span><span style="height: 54%"></span><span style="height: 86%"></span><span style="height: 62%"></span></div></figure>`;
}

function sampleTableHtml() {
  return `<table class="document-data-table"><thead><tr><th>Item</th><th>Owner</th><th>Status</th></tr></thead><tbody><tr><td>Draft section</td><td>Assistant</td><td>In review</td></tr><tr><td>Source check</td><td>Reviewer</td><td>Open</td></tr></tbody></table>`;
}

/** Whole-artifact nouns the "make me a …" verb family can target. Bare
 * "slide"/"slides" is deliberately absent — "make me a slide about pricing"
 * is an edit to the current deck; the counted form below covers "a 20 page
 * slide deck" and "a ten-slide presentation". */
const DRAFT_ARTIFACT_NOUN =
  "deck|presentation|slide ?show|slide ?deck|document|memo|report|paper|brief(?:ing)?|letter|essay|proposal|outline|plan|article|summary|agreement|contract|white ?paper|one[- ]pager|deliverable|update(?!s?\\s+to\\b)|note(?!s?\\s+(?:to|in)\\b)";
/** "twenty page", "10-page slide", "fifteen-slide" — a count followed by a
 * page/slide noun (optionally doubled: "20 page slide"). */
const DRAFT_COUNTED_SLIDES =
  "(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|twenty[- ]five|thirty|forty|fifty)[- ]?(?:page|slide)s?(?:[- ]?(?:page|slide)s?)?";
const DRAFT_START_OVER_PATTERN =
  /\b(?:start over|start again|start fresh|from scratch|changed? (?:my|our) mind|scrap (?:it|this|that|the)|forget (?:it|this|that|the)|new topic|different topic)\b/i;
const DRAFT_EXPLICIT_REPLACEMENT_PATTERN = new RegExp(
  `\\b(?:new|another|fresh|replacement)\\s+(?:${DRAFT_ARTIFACT_NOUN})\\b|` +
    `\\b(?:replace|discard)\\b.{0,30}\\b(?:this|entire|whole|current)\\b.{0,40}\\b(?:with|instead)\\b|` +
    `\\b(?:clear|delete|remove)\\b.{0,30}\\b(?:all content|everything|entire document|whole document)\\b`,
  "i",
);
/** "make me a 20 page slide on Y", "give me a new proposal", "redo the deck
 * as…" — verbs outside the classic creation set count as creation only when
 * aimed at a whole artifact. The counted form must be followed by a subject
 * ("…slides ON wolves") or an artifact noun so length adjustments ("make
 * this two pages longer") stay revisions. */
const DRAFT_WHOLE_ARTIFACT_PATTERN = new RegExp(
  `\\b(?:make|compose|produce|redo|rebuild|give me|put together)\\b[^.!?]{0,40}?` +
    `\\b(?:(?:${DRAFT_ARTIFACT_NOUN})\\b|(?:${DRAFT_COUNTED_SLIDES})\\s+(?:(?:${DRAFT_ARTIFACT_NOUN})\\b|(?:on|about|covering|for)\\b))`,
  "i",
);

/** True when the instruction asks for a whole new deliverable. The classic
 * creation verbs keep their long-standing behavior; explicit start-over
 * language and whole-artifact "make me a …" phrasings also start fresh, so a
 * pivot ("I changed my mind — make me a twenty page slide deck on Y")
 * replaces the current work instead of being treated as a focused edit. */
function isDraftCreationRequest(instruction: string) {
  if (/\b(draft|write|create|prepare|generate|start|build)\b/i.test(instruction)) return true;
  return (
    DRAFT_START_OVER_PATTERN.test(instruction) || DRAFT_WHOLE_ARTIFACT_PATTERN.test(instruction)
  );
}

/** A populated editor is an iteration surface by default. Creation verbs such
 * as "write" or "draft" are not destructive authority on their own; only an
 * explicit new/start-over/discard instruction may replace the current work. */
function isExplicitDraftReplacementRequest(instruction: string) {
  return (
    DRAFT_START_OVER_PATTERN.test(instruction) ||
    DRAFT_EXPLICIT_REPLACEMENT_PATTERN.test(instruction)
  );
}

function templateForInstruction(
  templates: DraftTemplate[],
  instruction: string,
  fallback: DraftTemplate,
) {
  const normalized = normalizeForMatch(instruction);
  const libraryIntent = /\b(library|package|prompt|template)\b/i.test(normalized);
  const scoredTemplates = templates
    .map((template) => {
      const normalizedName = normalizeForMatch(template.name);
      const exactNameScore = normalized.includes(normalizedName) ? 8 : 0;
      const nameScore = normalizedName
        .split(" ")
        .filter((word) => word.length > 2 && normalized.includes(word)).length * 3;
      const categoryScore = normalized.includes(template.category.toLowerCase()) ? 4 : 0;
      const keywordWords = new Set(
        template.keywords.flatMap((keyword) =>
          normalizeForMatch(keyword)
            .split(" ")
            .filter((word) => word.length > 2),
        ),
      );
      const keywordScore = Math.min(
        4,
        Array.from(keywordWords).filter((word) => normalized.includes(word)).length,
      );
      const libraryPenalty =
        template.category === "Library" && !libraryIntent && !exactNameScore ? -4 : 0;
      return {
        template,
        score: exactNameScore + nameScore + categoryScore + keywordScore + libraryPenalty,
      };
    })
    .sort((left, right) => right.score - left.score);
  return scoredTemplates[0]?.score ? scoredTemplates[0].template : fallback;
}

function formatExistingDraftWithTemplate(
  template: DraftTemplate,
  currentTitle: string,
  plainText: string,
  context: DraftContextOptions,
): DraftComposition {
  const sourceText = normalizeExistingDraftText(plainText);
  const subject = existingDraftSubject(currentTitle, sourceText);
  const title = titleForAppliedTemplate(template, currentTitle, subject);
  const lead = firstMeaningfulDraftParagraph(sourceText);
  const bullets = draftContentBullets(sourceText);
  const contentHtml = existingDraftContentHtml(sourceText);
  const sourceLine = context.useWorkspaceSources
    ? `Selected workspace source: ${context.primarySourceName}.`
    : context.useWebSearch
      ? "Public web search is available for source checks."
      : "No external source context is selected.";
  const agentLine = "Template formatting applied locally; no model call was made for this reformat.";

  const sections = appliedTemplateSections(template, {
    agentLine,
    bullets,
    contentHtml,
    lead,
    sourceLine,
    subject,
  });
  const html = sections.join("");
  return {
    content: documentHtmlToText(html),
    html,
    summary: `${template.name} template applied to the current draft`,
    title,
    requiresCitations: template.requiresCitations,
    requiresApproval: template.requiresApproval,
  };
}

function appliedTemplateSections(
  template: DraftTemplate,
  context: {
    agentLine: string;
    bullets: string[];
    contentHtml: string;
    lead: string;
    sourceLine: string;
    subject: string;
  },
) {
  const { agentLine, bullets, contentHtml, lead, sourceLine, subject } = context;
  const bulletHtml = listHtml(bullets);
  const sourceParagraph = `<p>${escapeHtml(sourceLine)}</p>`;
  const agentParagraph = `<p>${escapeHtml(agentLine)}</p>`;

  if (template.id === "legal-client-update") {
    return [
      `<h1>${escapeHtml(template.defaultTitle)}</h1>`,
      `<p><strong>Matter:</strong> ${escapeHtml(subject)}</p>`,
      "<h2>Client-facing summary</h2>",
      `<p>${escapeHtml(lead)}</p>`,
      "<h2>Key developments</h2>",
      bulletHtml,
      "<h2>Recommended next steps</h2>",
      listHtml([
        "Confirm the final source set before sending.",
        "Assign the attorney reviewer and approval owner.",
        "Remove internal notes before external delivery.",
      ]),
      "<h2>Source check notes</h2>",
      sourceParagraph,
      "<h2>Reformatted draft content</h2>",
      contentHtml,
      agentParagraph,
    ];
  }

  if (template.id === "legal-approval-email") {
    return [
      `<h1>${escapeHtml(template.defaultTitle)}</h1>`,
      `<p><strong>Subject:</strong> Approval requested: ${escapeHtml(subject)}</p>`,
      "<h2>Summary for reviewer</h2>",
      `<p>${escapeHtml(lead)}</p>`,
      "<h2>Items for approval</h2>",
      bulletHtml,
      "<h2>Open questions</h2>",
      listHtml([
        "Confirm whether the draft is ready for external delivery.",
        "Confirm citations and privileged material have been reviewed.",
      ]),
      "<h2>Source draft content</h2>",
      contentHtml,
      agentParagraph,
    ];
  }

  if (template.id === "finance-investment-memo") {
    return [
      `<h1>${escapeHtml(template.defaultTitle)}</h1>`,
      `<p><strong>Opportunity:</strong> ${escapeHtml(subject)}</p>`,
      "<h2>Executive summary</h2>",
      `<p>${escapeHtml(lead)}</p>`,
      "<h2>Investment thesis</h2>",
      bulletHtml,
      "<h2>Financial snapshot</h2>",
      listHtml([
        "Revenue: [Add amount and period]",
        "Margin / EBITDA: [Add amount or percentage]",
        "Growth profile: [Add trend]",
      ]),
      "<h2>Risks and diligence</h2>",
      listHtml([
        "Commercial risk: [Add diligence finding]",
        "Financial risk: [Add diligence finding]",
        "Legal / regulatory risk: [Add diligence finding]",
      ]),
      "<h2>Source draft content</h2>",
      contentHtml,
      agentParagraph,
    ];
  }

  if (template.id === "finance-board-update") {
    return [
      `<h1>${escapeHtml(template.defaultTitle)}</h1>`,
      `<p><strong>Reporting topic:</strong> ${escapeHtml(subject)}</p>`,
      "<h2>Highlights</h2>",
      bulletHtml,
      "<h2>Metrics</h2>",
      listHtml([
        "Revenue: [Add amount]",
        "Gross margin: [Add percentage]",
        "Cash balance / runway: [Add amount or months]",
      ]),
      "<h2>Risks</h2>",
      `<p>${escapeHtml(lead)}</p>`,
      "<h2>Asks</h2>",
      listHtml(["[Decision, approval, or guidance requested]"]),
      "<h2>Source draft content</h2>",
      contentHtml,
      agentParagraph,
    ];
  }

  if (template.id === "business-project-brief") {
    return [
      `<h1>${escapeHtml(template.defaultTitle)}</h1>`,
      `<p><strong>Project:</strong> ${escapeHtml(subject)}</p>`,
      "<h2>Objective</h2>",
      `<p>${escapeHtml(lead)}</p>`,
      "<h2>Scope</h2>",
      listHtml(["In scope: [Confirm included work]", "Out of scope: [Confirm exclusions]"]),
      "<h2>Milestones</h2>",
      bulletHtml,
      "<h2>Risks</h2>",
      listHtml(["[Risk and mitigation]"]),
      "<h2>Source draft content</h2>",
      contentHtml,
      agentParagraph,
    ];
  }

  if (template.id === "code-implementation-plan") {
    return [
      `<h1>${escapeHtml(template.defaultTitle)}</h1>`,
      `<p><strong>Feature:</strong> ${escapeHtml(subject)}</p>`,
      "<h2>Goal</h2>",
      `<p>${escapeHtml(lead)}</p>`,
      "<h2>Requirements</h2>",
      bulletHtml,
      "<h2>Implementation notes</h2>",
      listHtml([
        "Files to change: [Add paths]",
        "State model: [Add state shape]",
        "Edge cases: [Add cases]",
      ]),
      "<h2>Verification</h2>",
      listHtml(["Unit tests: [Add tests]", "Browser QA: [Add flows]"]),
      "<h2>Source draft content</h2>",
      contentHtml,
      agentParagraph,
    ];
  }

  if (template.category === "Library") {
    return [
      `<h1>${escapeHtml(template.name)} Applied Draft</h1>`,
      "<h2>Purpose</h2>",
      `<p>${escapeHtml(template.description)}</p>`,
      "<h2>Template instruction</h2>",
      `<p>${escapeHtml(template.promptHint)}</p>`,
      "<h2>Current draft content</h2>",
      contentHtml,
      agentParagraph,
    ];
  }

  return [
    `<h1>${escapeHtml(template.defaultTitle)}</h1>`,
    `<p><strong>Topic:</strong> ${escapeHtml(subject)}</p>`,
    "<h2>Introduction</h2>",
    `<p>${escapeHtml(lead)}</p>`,
    "<h2>Key sections</h2>",
    bulletHtml,
    "<h2>Source and verification plan</h2>",
    sourceParagraph,
    "<h2>Reformatted draft content</h2>",
    contentHtml,
    agentParagraph,
  ];
}

function normalizeExistingDraftText(value: string) {
  return value
    .replace(/^Page\s+\d+\s*/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function existingDraftSubject(currentTitle: string, sourceText: string) {
  const cleanTitle = currentTitle.trim();
  if (cleanTitle && cleanTitle !== EMPTY_DOCUMENT_TITLE) return cleanTitle;
  const firstLine = sourceText
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ? paperTitle(firstLine).slice(0, 90) : "Current Draft";
}

function titleForAppliedTemplate(
  template: DraftTemplate,
  currentTitle: string,
  subject: string,
) {
  const cleanTitle = currentTitle.trim();
  if (!cleanTitle || cleanTitle === EMPTY_DOCUMENT_TITLE) return template.defaultTitle;
  if (cleanTitle.includes(` - ${template.name}`)) return cleanTitle;
  return `${subject} - ${template.name}`;
}

function firstMeaningfulDraftParagraph(sourceText: string) {
  return (
    sourceText
      .split(/\n{2,}/)
      .map((block) =>
        block
          .split("\n")
          .map((line) => line.replace(/^-\s*/, "").trim())
          .filter(Boolean)
          .join(" "),
      )
      .find((block) => block.split(/\s+/).filter(Boolean).length > 4) ??
    "Use the current draft content as the source material for this template."
  );
}

function draftContentBullets(sourceText: string) {
  const explicitBullets = sourceText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^-\s+/.test(line))
    .map((line) => line.replace(/^-\s+/, "").trim())
    .filter(Boolean);
  if (explicitBullets.length >= 2) return explicitBullets.slice(0, 5);

  const sentences = sourceText
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.split(/\s+/).filter(Boolean).length > 4);
  if (sentences.length > 0) return sentences.slice(0, 5);

  return ["Review and refine the source draft content under this template."];
}

function existingDraftContentHtml(sourceText: string) {
  const blocks = sourceText
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  return blocks
    .map((block) => {
      const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
      if (lines.every((line) => line.startsWith("- "))) {
        return listHtml(lines.map((line) => line.replace(/^-\s+/, "")));
      }
      return `<p>${lines.map((line) => escapeHtml(line)).join("<br>")}</p>`;
    })
    .join("");
}

function listHtml(items: string[]) {
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function parseRequestedPageCount(request: string) {
  const normalized = request.toLowerCase().replace(/-/g, " ");
  const digitMatch = normalized.match(/\b(\d{1,3})\s*(?:page|pages)\b/);
  if (digitMatch?.[1]) return Math.min(150, Math.max(1, Number(digitMatch[1])));
  const numberWords: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
    hundred: 100,
  };
  const phraseMatch = normalized.match(
    /\b((?:(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\s*){1,3})\s*(?:page|pages)\b/,
  );
  if (!phraseMatch?.[1]) return 1;
  const words = phraseMatch[1].trim().split(/\s+/);
  let value = 0;
  const hundredIndex = words.indexOf("hundred");
  if (hundredIndex >= 0) {
    const multiplier = words
      .slice(0, hundredIndex)
      .reduce((total, word) => total + (numberWords[word] ?? 0), 0);
    const remainder = words
      .slice(hundredIndex + 1)
      .reduce((total, word) => total + (numberWords[word] ?? 0), 0);
    value = Math.max(1, multiplier || 1) * 100 + remainder;
  } else {
    value = words.reduce((total, word) => total + (numberWords[word] ?? 0), 0);
  }
  return Math.min(150, Math.max(1, value || 1));
}

function parseRequestedAdditionalPageCount(request: string) {
  const normalized = request.toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ");
  const numberWords: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
  };
  const numberPattern = "(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)";
  const directMatch = normalized.match(
    new RegExp(`\\b${numberPattern}\\s+pages?\\s+(?:longer|more)\\b`, "i"),
  );
  const actionMatch = normalized.match(
    new RegExp(
      `\\b(?:add|expand|extend|increase|grow)\\b.{0,48}?\\b${numberPattern}\\s+(?:(?:additional|extra|more)\\s+)?pages?\\b`,
      "i",
    ),
  );
  const token = directMatch?.[1] ?? actionMatch?.[1];
  if (!token) return 0;
  const value = /^\d+$/.test(token) ? Number(token) : numberWords[token] ?? 0;
  return Math.min(20, Math.max(0, value));
}

function extractDraftSubject(request: string | undefined) {
  if (!request) return null;
  const cleaned = request.replace(/\s+/g, " ").trim().replace(/[.?!]+$/, "");
  const patterns = [
    /\bon\s+(?:an?\s+|the\s+)?(.+?)(?:\s+(?:using|with|from|based on|in mla|in apa|as a|as an)\b|$)/i,
    /\babout\s+(?:an?\s+|the\s+)?(.+?)(?:\s+(?:using|with|from|based on)\b|$)/i,
    /\bfor\s+(?:an?\s+|the\s+)?(.+?)(?:\s+(?:using|with|from|based on)\b|$)/i,
    /\bregarding\s+(?:an?\s+|the\s+)?(.+?)(?:\s+(?:using|with|from|based on)\b|$)/i,
  ];
  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match?.[1]) {
      return cleanDraftSubject(match[1]);
    }
  }
  return null;
}

function paperTitle(topic: string) {
  if (/george lucas/i.test(topic) && /star wars/i.test(topic)) {
    return "George Lucas, Star Wars, and the Merchandising Rights Opportunity";
  }
  const title = topic
    .replace(/^how\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) return "Requested Document";
  return title
    .split(" ")
    .map((word) =>
      /^(and|or|the|a|an|of|to|for|in|on|with|from)$/i.test(word)
        ? word.toLowerCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

function titleForTemplate(template: DraftTemplate, subject: string) {
  if (template.id === "legal-client-update") return "Client Update Draft";
  if (template.id === "legal-approval-email") return "Approval Email Draft";
  if (template.id === "finance-investment-memo") return "Investment Memo Draft";
  if (template.id === "finance-board-update") return "Board Update Draft";
  if (template.id === "business-project-brief") return "Project Brief Draft";
  if (template.id === "code-implementation-plan") return "Implementation Plan Draft";
  if (template.id === "legal-contract") {
    const title = paperTitle(subject).replace(/\s+(agreement|contract)$/i, "");
    return `${title || "Agreement"} Agreement Draft`;
  }
  return template.defaultTitle;
}

function cleanDraftSubject(value: string) {
  return value
    .replace(/\.\s+(?=(list|include|add|show|explain|cite|use|find)\b).+$/i, "")
    .replace(/\s+and\s+i\s+want\s+you\s+to\b.+$/i, "")
    .replace(/\s+and\s+(?:add|include|list|show|explain|cite|use|find)\b.+$/i, "")
    .replace(/\s+(please|thanks)$/i, "")
    .replace(/^(a|an|the)\s+/i, "")
    .trim();
}

function exportDocumentBody(documentTitle: string, content: string) {
  const title = documentTitle.trim();
  const body = content.trim();
  if (!title) return body;
  if (body.toLowerCase().startsWith(title.toLowerCase())) {
    return body;
  }
  return `${title}\n\n${body}`;
}

function buildMarkdownExport(documentTitle: string, content: string) {
  const title = documentTitle.trim();
  const body = content.trim();
  if (!title || body.toLowerCase().startsWith(title.toLowerCase())) return body;
  return `# ${title}\n\n${body}`;
}

function exportFileDescriptor(
  format: ExportFormat,
  { codeArtifact, normalizedTitle }: { codeArtifact: CodeArtifact | null; normalizedTitle: string },
): ExportDescriptor | null {
  if (format === "code") {
    if (!codeArtifact) return null;
    const mimeType = codeMimeType(codeArtifact.extension);
    return {
      filename: codeArtifact.filename,
      label: `${codeArtifact.language} code`,
      pickerTypes: [
        {
          description: `${codeArtifact.language} file`,
          accept: { [mimeType]: [`.${codeArtifact.extension}`] },
        },
      ],
    };
  }
  if (format === "word") {
    return {
      filename: `${slugify(normalizedTitle)}.docx`,
      label: "Word document",
      pickerTypes: [
        {
          description: "Microsoft Word document",
          accept: { [DOCX_MIME_TYPE]: [".docx"] },
        },
      ],
    };
  }
  if (format === "pptx") {
    return {
      filename: `${slugify(normalizedTitle)}.pptx`,
      label: "PowerPoint deck",
      pickerTypes: [
        {
          description: "PowerPoint presentation",
          accept: { [PPTX_MIME_TYPE]: [".pptx"] },
        },
      ],
    };
  }
  return {
    filename: `${slugify(normalizedTitle)}.md`,
    label: "Markdown",
    pickerTypes: [
      {
        description: "Markdown",
        accept: { "text/markdown": [".md"] },
      },
    ],
  };
}

async function buildExportBlob(
  format: ExportFormat,
  {
    codeArtifact,
    contentHtml,
    normalizedTitle,
    plainText,
    deck,
    imageProxy,
    onExportWarnings,
  }: {
    codeArtifact: CodeArtifact | null;
    contentHtml: string;
    normalizedTitle: string;
    plainText: string;
    deck?: SlideDeck | null;
    imageProxy?: ExportImageProxy;
    onExportWarnings?: (warnings: string[]) => void;
  },
): Promise<Blob | null> {
  if (format === "code") {
    if (!codeArtifact) return null;
    return new Blob([codeArtifact.content], { type: codeMimeType(codeArtifact.extension) });
  }
  if (format === "pptx") {
    if (!deck) return null;
    // A real PresentationML .pptx mirroring the on-screen slides; media that
    // fails to embed is reported, never faked.
    const pptx = await buildPptxExportDocument(deck, imageProxy);
    if (pptx.warnings.length) onExportWarnings?.(pptx.warnings);
    return new Blob([pptx.bytes.slice().buffer], { type: PPTX_MIME_TYPE });
  }
  if (format === "word") {
    // A real OOXML .docx: Word for macOS opens the previous HTML/MHTML
    // ".doc" approach as an empty document, so only genuine OOXML is honest.
    const docx = await buildDocxExportDocument(normalizedTitle, contentHtml, imageProxy);
    return new Blob([docx.slice().buffer], { type: DOCX_MIME_TYPE });
  }
  if (deck) {
    // The deck outline already opens with the deck title.
    return new Blob([plainText], { type: "text/markdown;charset=utf-8" });
  }
  return new Blob([buildMarkdownExport(contentHtml.includes("document-mla-text") ? "" : normalizedTitle, plainText)], {
    type: "text/markdown;charset=utf-8",
  });
}

type ExportSaveHandle = FileSystemFileHandleLike;

/** Opens the OS save dialog for an export. Called before the file is built so
 * the dialog rides the click's user activation instead of expiring behind a
 * slow build. */
async function openExportSaveHandle(descriptor: ExportDescriptor): Promise<ExportSaveHandle> {
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
  if (!picker) {
    throw new Error("File save picker is unavailable.");
  }
  return picker({
    suggestedName: descriptor.filename,
    types: descriptor.pickerTypes,
  });
}

function canUseFileSavePicker() {
  return (
    typeof window !== "undefined" &&
    typeof (window as SaveFilePickerWindow).showSaveFilePicker === "function"
  );
}

function isFilePickerAbort(error: unknown) {
  return typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError";
}

function downloadBlob(
  exportFile: ExportFile,
  setStatus: (status: string) => void,
) {
  if (
    typeof document === "undefined" ||
    typeof Blob === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    setStatus(`Export prepared for ${exportFile.filename}.`);
    return;
  }
  const url = URL.createObjectURL(exportFile.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = exportFile.filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  window.setTimeout(() => {
    anchor.remove();
  }, 0);
  setStatus(`Downloaded ${exportFile.filename}.`);
  return url;
}

function revokeRetainedExportUrl(url: string | null) {
  if (!url || typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") return;
  URL.revokeObjectURL(url);
}

function codeMimeType(extension: string) {
  const mimeTypes: Record<string, string> = {
    py: "text/x-python;charset=utf-8",
    ps1: "text/plain;charset=utf-8",
    ts: "text/typescript;charset=utf-8",
    js: "text/javascript;charset=utf-8",
    html: "text/html;charset=utf-8",
    css: "text/css;charset=utf-8",
    sql: "application/sql;charset=utf-8",
    json: "application/json;charset=utf-8",
    sh: "text/x-shellscript;charset=utf-8",
  };
  return mimeTypes[extension] ?? "text/plain;charset=utf-8";
}

function normalizeForMatch(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function documentSourceSummary(data: BootstrapData, activeSourceIds: string[]) {
  const enabledKnowledge = data.knowledgeBases.filter((item) => item.enabled);
  const activeKnowledge = enabledKnowledge.filter((item) =>
    activeSourceIds.includes(item.id),
  );
  const documentCount = activeKnowledge.reduce(
    (total, item) => total + item.document_count,
    0,
  );
  const primarySourceName = activeKnowledge[0]?.name ?? NO_WORKSPACE_SOURCE_LABEL;
  return {
    documentCount,
    primarySourceName,
    enabledKnowledge,
    activeKnowledge,
  };
}

function requestedKnowledgeSourceIds(data: BootstrapData, request: string) {
  const normalizedRequest = normalizeForMatch(request);
  if (!normalizedRequest) return [];
  return data.knowledgeBases
    .filter((source) => {
      if (!source.enabled) return false;
      const normalizedName = normalizeForMatch(source.name);
      const normalizedSource = normalizeForMatch(source.source);
      return (
        (normalizedName.length > 3 && normalizedRequest.includes(normalizedName)) ||
        (normalizedSource.length > 5 && normalizedRequest.includes(normalizedSource))
      );
    })
    .map((source) => source.id);
}

function draftConnectorSourceCount(data: BootstrapData, connector: DraftConnectorOption) {
  return data.knowledgeBases.filter(
    (source) =>
      source.enabled && connector.connectorIds.includes(source.connector_id),
  ).length;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${index === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function currentTimeLabel(iso?: string | null) {
  return formatTimeLabel(iso ?? new Date().toISOString());
}

function timestampDifferenceMs(startIso: string | null | undefined, endIso: string | null | undefined) {
  if (!startIso || !endIso) return null;
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(0, endMs - startMs);
}

function formatDuration(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs < 1000) return "<1s";
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function draftEventTimestamp(event: AssistantEvent) {
  const iso = event.createdAt || event.executedAt;
  return {
    label: iso ? currentTimeLabel(iso) : "Just now",
    title: iso ? formatTimestamp(iso) : "Just now",
    dateTime: iso ?? undefined,
  };
}

function draftErrorText(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : "the API did not respond";
}

function slugify(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "draft"
  );
}

/* ------------------------------ deck editing ------------------------------ */

function deckEscapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function deckRunsToHtml(runs: DeckTextRun[]): string {
  return runs
    .map((run) => {
      let html = deckEscapeHtml(run.text);
      const styles: string[] = [];
      if (run.color) styles.push(`color: ${run.color}`);
      if (run.sizePt) styles.push(`font-size: ${run.sizePt}px`);
      // Multi-word family names need quotes; single quotes survive the
      // double-quoted style attribute. parseRun forbids quotes in the name.
      if (run.font) styles.push(`font-family: '${run.font}'`);
      // Explicit "off" has to render as a style, because the region itself is
      // bold or italic by layout.
      if (run.bold === false) styles.push("font-weight: normal");
      if (run.italic === false) styles.push("font-style: normal");
      if (styles.length) html = `<span style="${styles.join("; ")}">${html}</span>`;
      if (run.strike) html = `<s>${html}</s>`;
      if (run.underline) html = `<u>${html}</u>`;
      if (run.italic) html = `<i>${html}</i>`;
      if (run.bold) html = `<b>${html}</b>`;
      return html;
    })
    .join("");
}

/** Rich-text region HTML. Authored line breaks round-trip as <br>. */
function deckRichTextToHtml(runs: DeckRichText): string {
  return deckRichTextParagraphs(runs).map(deckRunsToHtml).join("<br>");
}

/** Nested-list HTML for a bullets region. Lists nest as ul>ul, which both
 * browsers' indent behavior and the level parser handle. */
function deckBulletsToHtml(bullets: DeckBullet[]): string {
  let html = "<ul>";
  let level = 0;
  bullets.forEach((bullet) => {
    while (level < bullet.level) {
      html += "<ul>";
      level += 1;
    }
    while (level > bullet.level) {
      html += "</ul>";
      level -= 1;
    }
    html += `<li>${deckRunsToHtml(bullet.runs)}</li>`;
  });
  while (level > 0) {
    html += "</ul>";
    level -= 1;
  }
  return `${html}</ul>`;
}

function deckBulletsFromElement(root: HTMLElement): DeckBullet[] {
  const bullets: DeckBullet[] = [];
  root.querySelectorAll("li").forEach((item) => {
    let level = -1;
    let ancestor: HTMLElement | null = item.parentElement;
    while (ancestor && ancestor !== root) {
      if (ancestor.tagName === "UL" || ancestor.tagName === "OL") level += 1;
      ancestor = ancestor.parentElement;
    }
    const clone = item.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("ul,ol").forEach((nested) => nested.remove());
    const runs = textRunsFromElement(clone);
    if (runs.length) {
      bullets.push({ runs, level: Math.max(0, Math.min(2, level)) as 0 | 1 | 2 });
    }
  });
  // A bullets block edited down to loose text (no li) still keeps its words.
  if (!bullets.length) {
    const runs = textRunsFromElement(root);
    if (runs.length) bullets.push({ runs, level: 0 });
  }
  return bullets.slice(0, 8);
}

function deckPlainTextToHtml(text: string): string {
  return text
    .split("\n")
    .map((line) => deckEscapeHtml(line))
    .join("<br>");
}

function deckPlainTextFromElement(root: HTMLElement): string {
  const lines: string[] = [];
  let current = "";
  const flush = () => {
    lines.push(current);
    current = "";
  };
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      current += node.textContent ?? "";
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === "BR") {
      flush();
      return;
    }
    const isBlock = /^(DIV|P|LI)$/.test(node.tagName);
    if (isBlock && current.trim()) flush();
    node.childNodes.forEach(walk);
    if (isBlock && current.trim()) flush();
  };
  root.childNodes.forEach(walk);
  if (current.trim() || !lines.length) lines.push(current);
  return lines
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line, index, all) => line.length > 0 || (index > 0 && index < all.length - 1))
    .join("\n")
    .slice(0, 2000);
}

/** Content of one editable region as HTML, from the model. */
function deckRegionHtml(slide: DeckSlide, region: string): string {
  const content = deckRegionContent(slide, region);
  if (content === null) return "";
  if (isDeckBulletList(content)) return deckBulletsToHtml(content);
  return deckRichTextToHtml(content);
}

function deckRegionContent(
  slide: DeckSlide,
  region: string,
): DeckRichText | DeckBullet[] | null {
  switch (slide.layout) {
    case "title":
    case "section":
      return region === "title" ? slide.title : region === "subtitle" ? slide.subtitle : null;
    case "title-bullets":
      return region === "title" ? slide.title : region === "bullets" ? slide.bullets : null;
    case "two-column":
      return region === "title"
        ? slide.title
        : region === "left"
          ? slide.left
          : region === "right"
            ? slide.right
            : null;
    case "image-caption":
      return region === "title" ? slide.title : region === "caption" ? slide.caption : null;
    case "quote":
      return region === "quote" ? slide.quote : region === "attribution" ? slide.attribution : null;
    case "chart":
      return region === "title" ? slide.title : null;
    case "closing":
      return region === "title" ? slide.title : region === "body" ? slide.body : null;
  }
}

/** Bullet regions are the only ones that carry list structure; every other
 * region is flat rich text. Derived from the layout, not from the current
 * content, so an emptied region keeps its kind. */
function deckRegionIsBullets(slide: DeckSlide, region: string): boolean {
  if (slide.layout === "title-bullets") return region === "bullets";
  if (slide.layout === "two-column") return region === "left" || region === "right";
  return false;
}

/** Browsers copy the surrounding computed styles onto the spans they create,
 * so a run can come back carrying the layout's own colour, size, and weight.
 * Dropping the values that merely restate the region default keeps runs
 * minimal and keeps text following the theme when the brand changes. */
function normalizeDeckRuns(
  runs: DeckTextRun[],
  slide: DeckSlide,
  region: string,
  theme: DeckTheme | undefined,
): DeckTextRun[] {
  const spec = slideTextRegions(slide.layout)[region];
  if (!spec || !theme) return runs;
  const roleColor =
    spec.colorRole === "heading"
      ? theme.colors.heading
      : spec.colorRole === "accent1"
        ? theme.colors.accent1
        : theme.colors.body;
  const defaultColor = (slide.textColor ?? roleColor).toLowerCase();
  const defaultFont = theme.fonts[spec.font]?.toLowerCase() ?? "";
  return runs.map((run) => {
    const next = { ...run };
    if (next.color && next.color.toLowerCase() === defaultColor) delete next.color;
    if (next.sizePt !== undefined && next.sizePt === Math.round(spec.sizePt)) delete next.sizePt;
    if (next.bold !== undefined && next.bold === Boolean(spec.bold)) delete next.bold;
    if (next.italic !== undefined && next.italic === Boolean(spec.italic)) delete next.italic;
    // A font equal to the region's theme font is no override at all.
    if (next.font && next.font.toLowerCase() === defaultFont) delete next.font;
    return next;
  });
}

/** Reads one edited region's DOM back into a new slide object. */
function deckSlideWithRegionFromElement(
  slide: DeckSlide,
  region: string,
  element: HTMLElement,
  theme?: DeckTheme,
): DeckSlide {
  if (deckRegionIsBullets(slide, region)) {
    const bullets = deckBulletsFromElement(element).map((bullet) => ({
      ...bullet,
      runs: normalizeDeckRuns(bullet.runs, slide, region, theme),
    }));
    if (slide.layout === "title-bullets" && region === "bullets") return { ...slide, bullets };
    if (slide.layout === "two-column" && region === "left") return { ...slide, left: bullets };
    if (slide.layout === "two-column" && region === "right") return { ...slide, right: bullets };
    return slide;
  }
  const text = normalizeDeckRuns(textRunsFromElement(element), slide, region, theme);
  switch (slide.layout) {
    case "title":
    case "section":
      return region === "title"
        ? { ...slide, title: text }
        : region === "subtitle"
          ? { ...slide, subtitle: text }
          : slide;
    case "title-bullets":
      return region === "title" ? { ...slide, title: text } : slide;
    case "two-column":
      return region === "title" ? { ...slide, title: text } : slide;
    case "image-caption":
      return region === "title"
        ? { ...slide, title: text }
        : region === "caption"
          ? { ...slide, caption: text }
          : slide;
    case "quote":
      return region === "quote"
        ? { ...slide, quote: text }
        : region === "attribution"
          ? { ...slide, attribution: text }
          : slide;
    case "chart":
      return region === "title" ? { ...slide, title: text } : slide;
    case "closing":
      return region === "title"
        ? { ...slide, title: text }
        : region === "body"
          ? { ...slide, body: text }
          : slide;
  }
}

/** Switches a slide's layout, remapping content by role. Content without a
 * slot in the new layout is dropped from the new slide but counted so the
 * caller can tell the user (the old slide stays reachable via undo). */
function remapDeckSlideLayout(
  slide: DeckSlide,
  layout: DeckSlideLayout,
): { slide: DeckSlide; hiddenCount: number } {
  if (slide.layout === layout) return { slide, hiddenCount: 0 };
  // Formatting survives the layout switch: regions move as runs, not strings.
  const title: DeckRichText =
    slide.layout === "quote" ? slide.quote : "title" in slide ? slide.title : [];
  const lines: DeckBullet[] = [];
  const pushLine = (runs: DeckRichText) => {
    if (deckRunsText(runs).trim()) lines.push({ runs, level: 0 });
  };
  switch (slide.layout) {
    case "title":
    case "section":
      pushLine(slide.subtitle);
      break;
    case "title-bullets":
      lines.push(...slide.bullets);
      break;
    case "two-column":
      lines.push(...slide.left, ...slide.right);
      break;
    case "image-caption":
      pushLine(slide.caption);
      break;
    case "quote":
      pushLine(slide.attribution);
      break;
    case "chart":
      break;
    case "closing":
      pushLine(slide.body);
      break;
  }
  const base = {
    ...createDeckSlide(layout, slide.id),
    notes: slide.notes,
    // The background picture belongs to the slide, not to its layout.
    ...(slide.backgroundId ? { backgroundId: slide.backgroundId } : {}),
    ...(slide.background ? { background: slide.background } : {}),
  } as DeckSlide;
  const lineRuns = (index: number): DeckRichText => lines[index]?.runs ?? [];
  const hasTitle = deckRunsText(title).trim().length > 0;
  let next: DeckSlide = base;
  let used = 0;
  switch (layout) {
    case "title":
    case "section":
      next = { ...base, layout, title, subtitle: lineRuns(0) } as DeckSlide;
      used = lines[0] ? 1 : 0;
      break;
    case "title-bullets":
      next = { ...base, layout, title, bullets: lines.slice(0, 8).length ? lines.slice(0, 8) : (base as DeckSlide & { bullets: DeckBullet[] }).bullets } as DeckSlide;
      used = Math.min(8, lines.length);
      break;
    case "two-column": {
      const midpoint = Math.ceil(Math.min(lines.length, 16) / 2);
      const left = lines.slice(0, midpoint);
      const right = lines.slice(midpoint, 16);
      next = {
        ...base,
        layout,
        title,
        left: left.length ? left : [{ runs: [{ text: "" }], level: 0 }],
        right: right.length ? right : [{ runs: [{ text: "" }], level: 0 }],
      } as DeckSlide;
      used = Math.min(16, lines.length);
      break;
    }
    case "quote":
      next = {
        ...base,
        layout,
        quote: hasTitle ? title : lineRuns(0),
        attribution: hasTitle ? lineRuns(0) : lineRuns(1),
      } as DeckSlide;
      used = hasTitle ? (lines[0] ? 1 : 0) : Math.min(2, lines.length);
      break;
    case "closing":
      next = { ...base, layout, title, body: lineRuns(0) } as DeckSlide;
      used = lines[0] ? 1 : 0;
      break;
    case "image-caption":
      next = { ...base, layout, title, caption: lineRuns(0) } as DeckSlide;
      used = lines[0] ? 1 : 0;
      break;
    case "chart":
      next = { ...base, layout, title } as DeckSlide;
      used = 0;
      break;
  }
  return { slide: next, hiddenCount: Math.max(0, lines.length - used) };
}

function deckRegionPlaceholder(slide: DeckSlide, region: string): string {
  if (region === "title") return slide.layout === "section" ? "Section title" : "Slide title";
  if (region === "subtitle") return "Subtitle";
  if (region === "bullets" || region === "left" || region === "right") return "Add a bullet…";
  if (region === "quote") return "Quote";
  if (region === "attribution") return "Attribution";
  if (region === "body") return "Closing message";
  if (region === "caption") return "Caption";
  return "";
}

type DeckResizeCorner = "nw" | "ne" | "sw" | "se";

const DECK_RESIZE_CORNERS: DeckResizeCorner[] = ["nw", "ne", "sw", "se"];

const DECK_CORNER_LABELS: Record<DeckResizeCorner, string> = {
  nw: "top left",
  ne: "top right",
  sw: "bottom left",
  se: "bottom right",
};

/** The on-screen box for any adjustable slide element, override-aware. */
function deckBlockBoxForRegion(slide: DeckSlide, region: string): DeckBox | null {
  if (region === "image") return resolvedMediaBox(slide);
  return resolvedTextRegions(slide)[region]?.box ?? null;
}

/** Applies a corner drag to a box, clamped to the 960×540 canvas with the
 * model's minimum block size so a block can never vanish or escape. */
function resizeBoxFromCorner(
  box: DeckBox,
  corner: DeckResizeCorner,
  dx: number,
  dy: number,
): DeckBox {
  let { x, y, w, h } = box;
  const right = x + w;
  const bottom = y + h;
  if (corner === "nw" || corner === "sw") {
    const nextX = Math.min(Math.max(x + dx, 0), right - DECK_BOX_MIN_W);
    w = right - nextX;
    x = nextX;
  } else {
    w = Math.min(Math.max(w + dx, DECK_BOX_MIN_W), DECK_PREVIEW_WIDTH_PX - x);
  }
  if (corner === "nw" || corner === "ne") {
    const nextY = Math.min(Math.max(y + dy, 0), bottom - DECK_BOX_MIN_H);
    h = bottom - nextY;
    y = nextY;
  } else {
    h = Math.min(Math.max(h + dy, DECK_BOX_MIN_H), DECK_PREVIEW_HEIGHT_PX - y);
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

function deckRegionStyle(
  spec: DeckTextRegionSpec,
  theme: DeckTheme,
  slide?: DeckSlide,
): CSSProperties {
  const color =
    slide?.textColor ??
    (spec.colorRole === "heading"
      ? theme.colors.heading
      : spec.colorRole === "accent1"
        ? theme.colors.accent1
        : theme.colors.body);
  // Middle-anchored regions centre by positioning the block's own middle at
  // the region's middle. Flex centring put the placeholder mid-box while the
  // browser drew the caret at the top; with the block sized to its content
  // the caret and the text always share the same line.
  const middle = spec.anchor === "middle";
  return {
    left: spec.box.x,
    top: middle ? spec.box.y + spec.box.h / 2 : spec.box.y,
    width: spec.box.w,
    height: middle ? undefined : spec.box.h,
    maxHeight: spec.box.h,
    transform: middle ? "translateY(-50%)" : undefined,
    fontSize: `${spec.sizePt}px`,
    fontWeight: spec.bold ? 700 : 400,
    fontStyle: spec.italic ? "italic" : undefined,
    textAlign: spec.align === "center" ? "center" : "left",
    color,
    fontFamily: `"${theme.fonts[spec.font]}", "Plus Jakarta Sans", ui-sans-serif, sans-serif`,
  };
}

function deckDecorationColor(theme: DeckTheme, role: string): string {
  switch (role) {
    case "accent1":
      return theme.colors.accent1;
    case "accent2":
      return theme.colors.accent2;
    case "surface":
      return theme.colors.surface;
    case "heading":
      return theme.colors.heading;
    case "body":
      return theme.colors.body;
    default:
      return theme.colors.background;
  }
}

/** Bottom-right contain-fit box for the brand logo — identical math to the
 * PPTX exporter's placement, so preview and file agree. */
function deckLogoRenderBox(theme: DeckTheme) {
  if (!theme.logo) return null;
  const scale = Math.min(
    DECK_LOGO_BOX.w / theme.logo.widthPx,
    DECK_LOGO_BOX.h / theme.logo.heightPx,
    1,
  );
  const w = Math.max(1, theme.logo.widthPx * scale);
  const h = Math.max(1, theme.logo.heightPx * scale);
  return { x: DECK_LOGO_BOX.x + DECK_LOGO_BOX.w - w, y: DECK_LOGO_BOX.y + DECK_LOGO_BOX.h - h, w, h };
}

/** Canvas fill for one slide: its own uploaded background wins over the
 * theme's brand background, which covers every slide that has none. */
function deckCanvasBackground(slide: DeckSlide, theme: DeckTheme): CSSProperties {
  const source = deckSlideBackgroundSource(slide, theme);
  if (source) {
    return {
      backgroundColor: theme.colors.background,
      backgroundImage: `url(${source})`,
      backgroundSize: "cover",
      backgroundPosition: "center",
    };
  }
  return { backgroundColor: theme.colors.background };
}

/** Pencil with an AI spark — the visual for "AI helps you write here",
 * shared by the assistant trigger and the deck's selection editor. */
function AiPenIcon({ size = 18 }: { size?: number }) {
  return (
    <span className="ai-pen-icon" aria-hidden="true">
      <PenLine size={size} />
      <Sparkles size={Math.max(9, Math.round(size * 0.62))} className="ai-pen-icon-spark" />
    </span>
  );
}

/** Shared media overlays (slide image, brand logo) for canvas renderers. */
function DeckSlideMedia({ slide, theme }: { slide: DeckSlide; theme: DeckTheme }) {
  const mediaBox = resolvedMediaBox(slide);
  const logoBox = deckLogoRenderBox(theme);
  return (
    <>
      {slide.layout === "image-caption" && slide.image.src && mediaBox && (
        <img
          className="deck-media-image"
          src={slide.image.src}
          alt={slide.image.alt}
          style={{
            left: mediaBox.x,
            top: mediaBox.y,
            width: mediaBox.w,
            height: mediaBox.h,
          }}
        />
      )}
      {theme.logo && logoBox && !slide.backgroundId && (
        <img
          className="deck-logo-image"
          src={theme.logo.dataUrl}
          alt="Brand logo"
          style={{ left: logoBox.x, top: logoBox.y, width: logoBox.w, height: logoBox.h }}
        />
      )}
    </>
  );
}

/** Full-screen presentation of the deck: click or arrow keys advance, Escape
 * exits, and the presenter can keep the current slide's speaker notes open
 * underneath the stage. Rendered through a portal so the workspace layout
 * cannot clip it; browser fullscreen is requested best-effort on entry. */
function DeckPresentationOverlay({
  slides,
  theme,
  index,
  notesOpen,
  onIndexChange,
  onToggleNotes,
  onExit,
}: {
  slides: DeckSlide[];
  theme: DeckTheme;
  index: number;
  notesOpen: boolean;
  onIndexChange: (index: number) => void;
  onToggleNotes: () => void;
  onExit: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));
  const indexRef = useRef(index);
  indexRef.current = index;

  useEffect(() => {
    const root = rootRef.current;
    if (root && !document.fullscreenElement) {
      root.requestFullscreen?.().catch(() => {
        /* Blocked fullscreen is fine — the fixed overlay already fills the window. */
      });
    }
    const handleResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const current = indexRef.current;
      if (event.key === "Escape") {
        event.stopPropagation();
        onExit();
        return;
      }
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        onIndexChange(Math.min(current + 1, slides.length - 1));
        return;
      }
      if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        onIndexChange(Math.max(current - 1, 0));
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        onIndexChange(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        onIndexChange(slides.length - 1);
        return;
      }
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        onToggleNotes();
      }
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [slides.length, onIndexChange, onToggleNotes, onExit]);

  const slide = slides[index];
  if (!slide) return null;
  const notesText = slide.notes.trim();
  const topBarPx = 52;
  const notesPx = notesOpen ? Math.max(120, Math.round(viewport.h * 0.2)) : 0;
  const stageH = Math.max(160, viewport.h - topBarPx - notesPx);
  const scale = Math.max(
    0.05,
    Math.min((viewport.w - 128) / DECK_PREVIEW_WIDTH_PX, stageH / DECK_PREVIEW_HEIGHT_PX),
  );

  return createPortal(
    <div className="deck-present-overlay" role="dialog" aria-modal="true" aria-label="Deck presentation" ref={rootRef}>
      <div className="deck-present-topbar">
        <span aria-live="polite">
          Slide {index + 1} of {slides.length}
        </span>
        <span className="deck-present-topbar-actions">
          <button
            type="button"
            aria-pressed={notesOpen}
            data-tooltip="Show or hide this slide's speaker notes (N)"
            onClick={onToggleNotes}
          >
            Notes
          </button>
          <button
            type="button"
            aria-label="Exit presentation"
            data-tooltip="Leave the presentation (Escape)"
            onClick={onExit}
          >
            <X size={15} /> Exit
          </button>
        </span>
      </div>
      <div
        className="deck-present-stage"
        style={{ height: stageH }}
        onClick={() => onIndexChange(Math.min(index + 1, slides.length - 1))}
      >
        <button
          type="button"
          className="deck-present-nav is-prev"
          aria-label="Previous slide"
          disabled={index === 0}
          onClick={(event) => {
            event.stopPropagation();
            onIndexChange(Math.max(index - 1, 0));
          }}
        >
          <ChevronLeft size={26} />
        </button>
        <div
          className="deck-present-scale"
          style={{
            width: DECK_PREVIEW_WIDTH_PX,
            height: DECK_PREVIEW_HEIGHT_PX,
            transform: `translate(-50%, -50%) scale(${scale})`,
          }}
        >
          <DeckSlideStatic slide={slide} theme={theme} />
        </div>
        <button
          type="button"
          className="deck-present-nav is-next"
          aria-label="Next slide"
          disabled={index === slides.length - 1}
          onClick={(event) => {
            event.stopPropagation();
            onIndexChange(Math.min(index + 1, slides.length - 1));
          }}
        >
          <ChevronRight size={26} />
        </button>
      </div>
      {notesOpen && (
        <div className="deck-present-notes" style={{ height: notesPx }} aria-label="Speaker notes">
          <strong>Notes</strong>
          <p>{notesText || "No notes for this slide."}</p>
        </div>
      )}
    </div>,
    document.body,
  );
}

/** Read-only slide render used by filmstrip thumbnails (and any other
 * non-editing preview). Absolute layout on the shared 960x540 canvas. */
function DeckSlideStatic({ slide, theme }: { slide: DeckSlide; theme: DeckTheme }) {
  const regions = resolvedTextRegions(slide);
  return (
    <div
      className="deck-slide-canvas is-static"
      style={{
        width: DECK_PREVIEW_WIDTH_PX,
        height: DECK_PREVIEW_HEIGHT_PX,
        ...deckCanvasBackground(slide, theme),
      }}
      aria-hidden="true"
    >
      {slideDecorations(slide.layout).map((decoration, index) => (
        <span
          key={`decoration-${index}`}
          className="deck-decoration"
          style={{
            left: decoration.box.x,
            top: decoration.box.y,
            width: decoration.box.w,
            height: decoration.box.h,
            background: deckDecorationColor(theme, decoration.colorRole),
          }}
        />
      ))}
      <DeckSlideMedia slide={slide} theme={theme} />
      {Object.entries(regions).map(([region, spec]) => {
        const html = deckRegionHtml(slide, region);
        if (!html) return null;
        return (
          <div
            key={region}
            className={`deck-block deck-block--${region} is-static`}
            style={deckRegionStyle(spec, theme, slide)}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      })}
    </div>
  );
}

/** Normalizes an AI rewrite reply into plain replacement text: strips code
 * fences and wrapping quotes the models add despite instructions. */
function cleanAiReplacementText(reply: string): string {
  let text = reply.trim();
  const fenced = /^```[a-z]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("\u201c") && text.endsWith("\u201d"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text.slice(0, 2000);
}

/** Mean luminance of the picture's text band — dark artwork needs light slide
 * text. Null when the environment cannot rasterize (never guesses). */
function dataUrlIsDark(dataUrl: string): Promise<boolean | null> {
  if (typeof Image === "undefined" || typeof document === "undefined") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const element = new Image();
    const timer = window.setTimeout(() => resolve(null), 8000);
    element.onload = () => {
      window.clearTimeout(timer);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 18;
        const context = canvas.getContext("2d");
        if (!context) {
          resolve(null);
          return;
        }
        context.drawImage(element, 0, 0, 32, 18);
        const data = context.getImageData(0, 3, 32, 12).data;
        let total = 0;
        for (let index = 0; index < data.length; index += 4) {
          total += 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
        }
        resolve(total / (data.length / 4) < 128);
      } catch {
        resolve(null);
      }
    };
    element.onerror = () => {
      window.clearTimeout(timer);
      resolve(null);
    };
    element.src = dataUrl;
  });
}

/** Bakes a readability scrim into background artwork: dark art gets a dark
 * wash with white text, light art a white wash — so slide text stays legible
 * over any image, identically in the preview, PPTX export, and print (the
 * wash lives in the stored bytes, not in CSS). "strong" is for text-dense
 * layouts; "light" keeps display slides (title/section/quote) more vivid.
 * Returns null when the runtime cannot decode images (tests, no DOM). */
function washSlideBackground(
  dataUrl: string,
  strength: "light" | "strong",
): Promise<{ dataUrl: string; textColor: "#ffffff" | null } | null> {
  if (typeof Image === "undefined" || typeof document === "undefined" || isAutomatedTestMode()) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const element = new Image();
    const timer = window.setTimeout(() => resolve(null), 15000);
    element.onload = () => {
      window.clearTimeout(timer);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, element.naturalWidth);
        canvas.height = Math.max(1, element.naturalHeight);
        const context = canvas.getContext("2d");
        if (!context) {
          resolve(null);
          return;
        }
        context.drawImage(element, 0, 0, canvas.width, canvas.height);
        const sample = context.getImageData(
          0,
          Math.round(canvas.height * 0.15),
          canvas.width,
          Math.max(1, Math.round(canvas.height * 0.7)),
        ).data;
        let total = 0;
        for (let index = 0; index < sample.length; index += 4) {
          total += 0.2126 * sample[index] + 0.7152 * sample[index + 1] + 0.0722 * sample[index + 2];
        }
        const dark = total / (sample.length / 4) < 128;
        context.fillStyle = dark
          ? `rgba(8, 15, 22, ${strength === "strong" ? 0.62 : 0.44})`
          : `rgba(255, 255, 255, ${strength === "strong" ? 0.68 : 0.48})`;
        context.fillRect(0, 0, canvas.width, canvas.height);
        const washed = canvas.toDataURL("image/jpeg", 0.85);
        if (!washed.startsWith("data:image/jpeg") || washed.length > MAX_SLIDE_BACKGROUND_CHARS) {
          resolve(null);
          return;
        }
        resolve({ dataUrl: washed, textColor: dark ? "#ffffff" : null });
      } catch {
        resolve(null);
      }
    };
    element.onerror = () => {
      window.clearTimeout(timer);
      resolve(null);
    };
    element.src = dataUrl;
  });
}

/** Display slides can carry more vivid art; text-dense layouts need a heavy
 * wash behind their body copy. */
function backgroundWashStrength(layout: DeckSlide["layout"]): "light" | "strong" {
  return layout === "title" || layout === "section" || layout === "quote" || layout === "closing"
    ? "light"
    : "strong";
}

/** Extracts the first generated-image URL from an image-model chat reply. */
function extractGeneratedImageUrl(markdown: string): string | null {
  const match = /!\[[^\]]*\]\((\/api\/chat\/generated-images\/[^\s)]+)\)/.exec(markdown);
  return match ? match[1] : null;
}

/** Loads an image URL and re-encodes it as a bounded JPEG data URL so slide
 * images persist inside the deck instead of expiring with signed links. */
function imageUrlToJpegDataUrl(src: string, maxDimension = 1280): Promise<string | null> {
  if (typeof Image === "undefined" || typeof document === "undefined") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const element = new Image();
    const timer = window.setTimeout(() => resolve(null), 15000);
    element.onload = () => {
      window.clearTimeout(timer);
      try {
        const scale = Math.min(
          1,
          maxDimension / Math.max(element.naturalWidth, element.naturalHeight, 1),
        );
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(element.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(element.naturalHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) {
          resolve(null);
          return;
        }
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(element, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        resolve(dataUrl.startsWith("data:image/jpeg") ? dataUrl : null);
      } catch {
        resolve(null);
      }
    };
    element.onerror = () => {
      window.clearTimeout(timer);
      resolve(null);
    };
    element.src = src;
  });
}

/* ------------------------------ deck assistant ------------------------------ */

/** The strict JSON contract for AI deck output, embedded in prompts and
 * enforced by parseSlideDeck — nothing renders without passing the validator. */
const DECK_JSON_CONTRACT = [
  'Return ONLY a fenced ```json code block containing one JSON object, no prose before or after.',
  "The object shape:",
  '{"schema":"aperture-deck-v1","title":"<deck title>","slides":[...]}',
  "Each slide has: \"id\" (short unique string), \"notes\" (1-3 sentence speaker notes), \"layout\", and the layout's fields:",
  '- {"layout":"title","title":"...","subtitle":"..."} — opening slide.',
  '- {"layout":"section","title":"...","subtitle":"..."} — section divider.',
  '- {"layout":"title-bullets","title":"...","bullets":[{"runs":[{"text":"..."}],"level":0}]} — at most 6 bullets; level is 0, 1, or 2; a run may set "bold":true.',
  '- {"layout":"two-column","title":"...","left":[bullets],"right":[bullets]}.',
  '- {"layout":"image-caption","title":"...","image":{"src":"","alt":"<describe the picture to add>"},"caption":"..."} — always leave src empty; images attach in the editor.',
  '- {"layout":"quote","quote":"...","attribution":"..."}.',
  '- {"layout":"closing","title":"...","body":"..."}.',
  'Do NOT include a "theme" field. Keep slide text tight: bullets are short phrases of at most ~12 words, never paragraphs. Prefer more focused slides over dense ones.',
].join("\n");

function providerDeckPrompt(
  templateOutline: string | null,
  request: string,
  contextOptions: DraftContextOptions,
): string {
  const contextLines = [
    `Drafting agent: ${contextOptions.agentName}.`,
    contextOptions.useWebSearch
      ? "Use provider-hosted public web search for current public facts; keep slide claims source-backed."
      : "Use the selected model directly. Do not claim live web research.",
  ];
  return [
    "You are a presentation writer producing a slide deck as structured JSON.",
    ...contextLines,
    templateOutline
      ? `Follow this deck template structure, adapting slide count as needed:\n${templateOutline}`
      : "Choose a clear structure: title slide, an agenda or sections as needed, and a closing slide.",
    "If the request names a slide or page count (\"a 10 page slide deck\", \"20 slides\"), produce exactly that many slides — that count overrides the template structure.",
    ...(deckWantsImagery(request)
      ? [
          'The request asks for imagery: include one or two "image-caption" slides where a picture genuinely helps, describe the ideal photo in image.alt with a few concrete searchable words (still leave src empty), and keep every slide title concrete — the editor attaches real artwork by matching those descriptions.',
        ]
      : []),
    "",
    "User request:",
    request,
    "",
    DECK_JSON_CONTRACT,
  ].join("\n");
}

function providerDeckRevisionPrompt(deckJson: string, request: string): string {
  return [
    "You are revising an existing slide deck. Apply the user's instruction and return the COMPLETE revised deck.",
    "Keep slide ids stable for slides you keep; give new slides new ids. Keep text you were not asked to change.",
    "Exception: if the instruction asks for a different topic, a whole new deck, or to start over, discard the current slides entirely and build the newly requested deck from scratch — all-new slides with new ids, matching any requested slide count, carrying nothing over from the old deck.",
    "",
    "Current deck JSON:",
    "```json",
    deckJson,
    "```",
    "",
    "User instruction:",
    request,
    "",
    DECK_JSON_CONTRACT,
  ].join("\n");
}

/** Pulls the first JSON object out of a model reply (fenced or bare). */
function extractDeckJsonBlock(reply: string): string | null {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(reply);
  if (fenced) return fenced[1].trim();
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start !== -1 && end > start) return reply.slice(start, end + 1).trim();
  return null;
}

/** Validates an AI deck reply. The model never controls the theme, the schema
 * tag, or slide artwork; all three are normalized before the single validation
 * gate runs. Slides the model kept (same id) keep their background picture —
 * a text revision must not strip the deck's design. */
function parseAiDeckReply(
  reply: string,
  theme: DeckTheme,
  fallbackTitle: string,
  backgroundsBySlideId: Map<string, string> = new Map(),
): ReturnType<typeof parseSlideDeck> {
  const block = extractDeckJsonBlock(reply);
  if (!block) return { ok: false, error: "The reply contained no JSON deck object." };
  let candidate: unknown;
  try {
    candidate = JSON.parse(block);
  } catch {
    return { ok: false, error: "The reply's JSON could not be parsed." };
  }
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const record = candidate as Record<string, unknown>;
    record.schema = DECK_SCHEMA_VERSION;
    record.theme = theme;
    if (typeof record.title !== "string" || !record.title.trim()) {
      record.title = fallbackTitle;
    }
    if (backgroundsBySlideId.size && Array.isArray(record.slides)) {
      record.slides = record.slides.map((slide) => {
        if (!slide || typeof slide !== "object" || Array.isArray(slide)) return slide;
        const entry = slide as Record<string, unknown>;
        const kept = typeof entry.id === "string" ? backgroundsBySlideId.get(entry.id) : undefined;
        return kept ? { ...entry, backgroundId: kept } : entry;
      });
    }
  }
  return parseSlideDeck(candidate);
}

function deckAgentTraceSteps({
  agentName,
  request,
  revising,
  useWebSearch,
  withArtwork = false,
}: {
  agentName: string;
  request: string;
  revising: boolean;
  useWebSearch: boolean;
  withArtwork?: boolean;
}): DraftTraceStep[] {
  const artworkStep: DraftTraceStep[] = withArtwork
    ? [
        {
          id: "artwork",
          label: "Adding slide artwork",
          detail: "Generating and attaching images after the text lands; slides stay editable meanwhile.",
        },
      ]
    : [];
  return [
    {
      id: "route",
      label: "Routing request",
      detail: `Using ${agentName} for slide drafting.`,
    },
    {
      id: "context",
      label: revising ? "Reading the current deck" : "Outlining slides",
      detail: revising
        ? "Sending the current slides so edits keep your content."
        : useWebSearch
          ? "Structuring the deck; public web research mode is available."
          : `Structuring the deck for: ${request.slice(0, 80)}`,
    },
    {
      id: "generate",
      label: revising ? "Revising slide content" : "Writing slide content and speaker notes",
      detail: "Slides return as structured JSON and pass validation before anything renders.",
    },
    {
      id: "apply",
      label: "Applying layouts and theme",
      detail: "Validated slides land in the deck editor as a new version.",
    },
    ...artworkStep,
  ];
}

/* ------------------------------ deck brand theme ------------------------------ */

type PersistedDeckBrandTheme = {
  id: string;
  name: string;
  filename: string;
  theme: DeckTheme;
  slides: Array<{
    title: string | null;
    blocks: string[];
    /** Index into `designs` — this slide's own flattened layout artwork. */
    designIndex: number | null;
    layoutName: string | null;
  }>;
  /** One picture per distinct layout the template uses, in server order. */
  designs: Array<{ dataUrl: string; isDark: boolean }>;
  uploadedAt: string;
};

const DECK_BRAND_THEME_STORAGE_KEY = "aperture-deck-brand-theme-v1";

function loadPersistedDeckBrandTheme(): PersistedDeckBrandTheme | null {
  try {
    const raw = window.localStorage.getItem(DECK_BRAND_THEME_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedDeckBrandTheme;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.name !== "string" ||
      typeof parsed.filename !== "string" ||
      !parsed.theme ||
      !Array.isArray(parsed.slides)
    ) {
      return null;
    }
    // Round the stored theme through the validator so a stale or tampered
    // entry can never inject unsafe values into decks or exports.
    const checked = parseSlideDeck({
      schema: DECK_SCHEMA_VERSION,
      title: "check",
      theme: parsed.theme,
      slides: [],
    });
    if (!checked.ok) return null;
    // Stored designs pass the same bounded data-URL rule as any slide picture.
    const designs = Array.isArray(parsed.designs)
      ? parsed.designs.filter(
          (design): design is { dataUrl: string; isDark: boolean } =>
            Boolean(design) &&
            typeof design === "object" &&
            typeof (design as { dataUrl?: unknown }).dataUrl === "string" &&
            /^data:image\/(png|jpe?g);/i.test((design as { dataUrl: string }).dataUrl) &&
            (design as { dataUrl: string }).dataUrl.length <= MAX_SLIDE_BACKGROUND_CHARS,
        )
      : [];
    const slides = parsed.slides.map((slide) => ({
      title: typeof slide?.title === "string" ? slide.title : null,
      blocks: Array.isArray(slide?.blocks)
        ? slide.blocks.filter((block): block is string => typeof block === "string")
        : [],
      designIndex:
        typeof slide?.designIndex === "number" && designs[slide.designIndex] !== undefined
          ? slide.designIndex
          : null,
      layoutName: typeof slide?.layoutName === "string" ? slide.layoutName : null,
    }));
    return { ...parsed, theme: checked.deck.theme, designs, slides };
  } catch {
    return null;
  }
}

/** Returns false when the browser refused the write, so the caller can say the
 * theme lives in this session only instead of implying it was stored. */
function savePersistedDeckBrandTheme(value: PersistedDeckBrandTheme | null): boolean {
  try {
    if (value) {
      window.localStorage.setItem(DECK_BRAND_THEME_STORAGE_KEY, JSON.stringify(value));
    } else {
      window.localStorage.removeItem(DECK_BRAND_THEME_STORAGE_KEY);
    }
    return true;
  } catch {
    // Private-browsing and quota failures keep the theme in memory only.
    return false;
  }
}

/** Maps the server's parsed template into a bounded, validated DeckTheme. */
async function persistedBrandThemeFromParse(
  parsed: DeckTemplateParseResponse,
): Promise<PersistedDeckBrandTheme> {
  const base = defaultDeckTheme();
  const roles = parsed.theme.colors ?? {};
  const roleColor = (role: string, fallback: string) => {
    const value = roles[role];
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
      ? value.toLowerCase()
      : fallback;
  };
  const colors = {
    background: roleColor("lt1", base.colors.background),
    surface: roleColor("lt2", base.colors.surface),
    heading: roleColor("dk2", base.colors.heading),
    body: roleColor("dk1", base.colors.body),
    accent1: roleColor("accent1", base.colors.accent1),
    accent2: roleColor("accent2", base.colors.accent2),
  };
  const fonts = {
    major: parsed.theme.major_font?.trim() || base.fonts.major,
    minor: parsed.theme.minor_font?.trim() || base.fonts.minor,
  };

  let logo: DeckTheme["logo"] = null;
  const logoCandidate = parsed.logo_candidates[0];
  if (logoCandidate) {
    if (logoCandidate.data_url.length <= 400_000) {
      logo = {
        dataUrl: logoCandidate.data_url,
        widthPx: Math.max(1, logoCandidate.width_px),
        heightPx: Math.max(1, logoCandidate.height_px),
      };
    } else {
      const downscaled = await imageUrlToJpegDataUrl(logoCandidate.data_url, 256);
      if (downscaled) {
        const ratio = logoCandidate.height_px / Math.max(1, logoCandidate.width_px);
        logo = {
          dataUrl: downscaled,
          widthPx: 256,
          heightPx: Math.max(1, Math.round(256 * ratio)),
        };
      }
    }
  }

  let backgroundImage: DeckTheme["backgroundImage"] = null;
  const backgroundCandidate = parsed.background_candidates[0];
  if (backgroundCandidate) {
    if (backgroundCandidate.data_url.length <= 1_000_000) {
      backgroundImage = { dataUrl: backgroundCandidate.data_url };
    } else {
      const downscaled = await imageUrlToJpegDataUrl(backgroundCandidate.data_url, 1280);
      if (downscaled && downscaled.length <= 1_200_000) {
        backgroundImage = { dataUrl: downscaled };
      }
    }
  }

  // Per-layout designs are the template's real look; only keep the ones that
  // pass the same bounded data-URL rule as any other slide picture.
  const designs = parsed.designs
    .filter(
      (design) =>
        /^data:image\/(png|jpe?g);/i.test(design.data_url) &&
        design.data_url.length <= MAX_SLIDE_BACKGROUND_CHARS,
    )
    .map((design) => ({ dataUrl: design.data_url, isDark: Boolean(design.is_dark) }));

  const name = parsed.filename.replace(/\.(pptx|potx)$/i, "");
  return {
    id: `brand-${parsed.filename}-${parsed.slide_count}`,
    name,
    filename: parsed.filename,
    theme: {
      colors,
      fonts,
      logo,
      backgroundImage,
      backgroundLibrary: {},
      sourceLabel: parsed.filename,
    },
    slides: parsed.slides.map((slide) => ({
      title: slide.title,
      blocks: slide.blocks.slice(0, 12),
      designIndex:
        typeof slide.design_index === "number" && designs[slide.design_index] !== undefined
          ? slide.design_index
          : null,
      layoutName: slide.layout_name ?? null,
    })),
    designs,
    uploadedAt: new Date().toISOString(),
  };
}
