import {
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  Download,
  Eye,
  FileCode2,
  Maximize2,
  Minimize2,
  RotateCcw,
  X,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { splitAssistantThinking } from "../lib/assistantThinking";
import { messageWithActiveResponseVersion } from "../lib/chatStore";
import { triggerBlobDownload } from "../lib/clipboard";
import {
  buildCodePreview,
  codeArtifactMimeType,
  codeArtifactsFromMarkdown,
  hasOpenCodeFence,
  type CodeArtifact,
} from "../lib/codeArtifacts";
import type { ChatMessage } from "../lib/types";
import { useCopyFeedback } from "../lib/useCopyFeedback";
import { useModalFocus } from "../lib/useModalFocus";
import { CodeLines } from "./CodeLines";
import { CodeBlockEditor, CodeEditButtons, CodeSaveNotice } from "./CodeBlockEditor";
import { useCodeAiEdit, useCodeEditAssist } from "./CodeAiEdit";
import { StableLabel } from "./Primitives";
import { RailSwitch } from "./RailSwitch";
import { useCodeBlockEditing, type CodeSave } from "./useCodeBlockEditing";

/** What the canvas shows: a thread artifact (has a key) or an edited copy. */
export type CanvasArtifact = Omit<CodeArtifact, "key" | "lineCount"> & { key?: string };

type CanvasView = "preview" | "code";
type Selection = { key: string } | { snapshot: CanvasArtifact };
type AnchorBounds = { left: number; rightInset: number };

/** Streaming replies settle before the live preview reloads, so a game is
 * not restarted on every token. */
const PREVIEW_SETTLE_MS = 600;

type ArtifactCanvasApi = { open: (artifact: CanvasArtifact) => void };

/** Saves an edited code block into reply `messageId` (chat's updateAssistantCode). */
export type MessageCodeSave = (messageId: string, previousSource: string, nextSource: string, occurrence: number) => boolean;

/** How the open artifact's edits are saved: into its reply, counting the
 * identical code blocks above it there. */
type ArtifactSave = { onSave: CodeSave; occurrence: number };

const ArtifactCanvasContext = createContext<ArtifactCanvasApi | null>(null);

/** The surrounding canvas, when a surface provides one (chat does). */
export function useArtifactCanvas(): ArtifactCanvasApi | null {
  return useContext(ArtifactCanvasContext);
}

export function downloadCode(code: string, filename: string) {
  triggerBlobDownload(new Blob([code], { type: codeArtifactMimeType(filename) }), filename);
}

const artifactCache = new WeakMap<ChatMessage, CodeArtifact[]>();

/** The code a thread's assistant replies produced, newest last. Cached per
 * message object: a streaming update replaces only the message it touches. */
export function threadCodeArtifacts(messages: ChatMessage[]): CodeArtifact[] {
  return messages.flatMap((message) => {
    if (message.role === "user") return [];
    const cached = artifactCache.get(message);
    if (cached) return cached;
    const content = splitAssistantThinking(messageWithActiveResponseVersion(message).content).visibleContent;
    const artifacts = codeArtifactsFromMarkdown(content, message.id);
    artifactCache.set(message, artifacts);
    return artifacts;
  });
}

/** A reply is still writing a code block. */
export function threadArtifactWorking(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role === "user") return false;
  const display = messageWithActiveResponseVersion(last);
  return display.status === "pending" && hasOpenCodeFence(splitAssistantThinking(display.content).visibleContent);
}

/** Where edits to artifact `key` are saved: its reply, unless that reply is
 * still being written. Keys read `${messageId}:${n}` (codeArtifactsFromMarkdown). */
export function artifactSave(
  messages: ChatMessage[],
  artifacts: CodeArtifact[],
  key: string,
  onUpdateCode: MessageCodeSave,
): ArtifactSave | undefined {
  const messageId = key.slice(0, key.lastIndexOf(":"));
  const message = messages.find((item) => item.id === messageId);
  if (!message || message.status === "pending") return undefined;
  const index = artifacts.findIndex((item) => item.key === key);
  const code = artifacts[index]!.code;
  const occurrence = artifacts
    .slice(0, index)
    .filter((item) => item.key.startsWith(`${messageId}:`) && item.code === code).length;
  return { onSave: (previous, next, at) => onUpdateCode(messageId, previous, next, at), occurrence };
}

function useAnchorBounds(selector: string | undefined, active: boolean): AnchorBounds | null {
  const [bounds, setBounds] = useState<AnchorBounds | null>(null);
  useLayoutEffect(() => {
    if (!selector || !active) return undefined;
    const anchor = document.querySelector<HTMLElement>(selector);
    if (!anchor) return undefined;
    const measure = () => {
      const rect = anchor.getBoundingClientRect();
      setBounds({
        left: Math.round(rect.left),
        rightInset: Math.max(0, Math.round(document.documentElement.clientWidth - rect.right)),
      });
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(anchor);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [selector, active]);
  return bounds;
}

/** The previous value until `value` holds still for `delayMs`; a new
 * `resetToken` (another artifact) applies immediately. */
function useSettledValue<T>(value: T, delayMs: number, resetToken: unknown): T {
  const [settled, setSettled] = useState(value);
  const tokenRef = useRef(resetToken);
  useEffect(() => {
    if (tokenRef.current !== resetToken) {
      tokenRef.current = resetToken;
      setSettled(value);
      return undefined;
    }
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs, resetToken]);
  return tokenRef.current === resetToken ? settled : value;
}

function selectedArtifact(selection: Selection | null, artifacts: CodeArtifact[]): CanvasArtifact | null {
  if (!selection) return null;
  if ("snapshot" in selection) return selection.snapshot;
  return artifacts.find((item) => item.key === selection.key) ?? null;
}

/** Which artifact the canvas shows. A thread artifact is held by key, so it
 * follows its reply as it streams or flips response versions; an edited copy
 * is held as a snapshot. A new resetKey, or a key that vanishes, closes it. */
function useCanvasSelection(artifacts: CodeArtifact[], resetKey: string | undefined) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const artifactsRef = useRef(artifacts);
  artifactsRef.current = artifacts;
  const current = selectedArtifact(selection, artifacts);

  useEffect(() => setSelection(null), [resetKey]);
  useEffect(() => {
    if (selection && !current) setSelection(null);
  }, [selection, current]);

  const api = useMemo<ArtifactCanvasApi>(
    () => ({
      open(artifact) {
        const match = artifactsRef.current.find((item) => item.code === artifact.code);
        setSelection(match ? { key: match.key } : { snapshot: artifact });
      },
    }),
    [],
  );
  return {
    api,
    current,
    select: (key: string) => setSelection({ key }),
    close: () => setSelection(null),
  };
}

/** Chat's artifact canvas: a right-edge pull tab whenever the thread holds
 * code, and the blade that Preview and the tab open. */
export function ArtifactCanvasProvider({
  messages,
  resetKey,
  anchorSelector,
  onUpdateCode,
  children,
}: {
  messages: ChatMessage[];
  /** A new value (another chat) closes the canvas. */
  resetKey?: string;
  /** Element the blade and tab align to (the chat column). */
  anchorSelector?: string;
  /** Saves canvas edits into the reply; without it the canvas is read-only. */
  onUpdateCode?: MessageCodeSave;
  children: ReactNode;
}) {
  const artifacts = useMemo(() => threadCodeArtifacts(messages), [messages]);
  const working = useMemo(() => threadArtifactWorking(messages), [messages]);
  const { api, current, select, close } = useCanvasSelection(artifacts, resetKey);
  const bounds = useAnchorBounds(anchorSelector, artifacts.length > 0 || current !== null);
  const newest = artifacts[artifacts.length - 1];

  return (
    <ArtifactCanvasContext.Provider value={api}>
      {children}
      {newest &&
        createPortal(
          <ArtifactCanvasTab
            count={artifacts.length}
            covered={current !== null}
            rightInset={bounds?.rightInset ?? 0}
            working={working}
            onOpen={() => select(newest.key)}
          />,
          document.body,
        )}
      {current && (
        <ArtifactCanvasBlade
          anchorLeft={bounds?.left}
          artifact={current}
          artifacts={artifacts}
          save={current.key && onUpdateCode ? artifactSave(messages, artifacts, current.key, onUpdateCode) : undefined}
          onClose={close}
          onSelect={select}
        />
      )}
    </ArtifactCanvasContext.Provider>
  );
}

function ArtifactCanvasTab({
  count,
  covered,
  rightInset,
  working,
  onOpen,
}: {
  count: number;
  covered: boolean;
  rightInset: number;
  working: boolean;
  onOpen: () => void;
}) {
  const noun = count === 1 ? "artifact" : "artifacts";
  return (
    <div
      className={`artifact-canvas-edge${covered ? " is-covered" : ""}${working ? " is-working" : ""}`}
      inert={covered}
      style={{ "--artifact-canvas-edge-right": `${rightInset}px` } as CSSProperties}
    >
      <button
        type="button"
        className="artifact-canvas-tab"
        aria-label={`Open the artifact canvas (${count} ${noun}${working ? ", writing" : ""})`}
        data-tooltip={`Open the code from this chat in the artifact canvas (${count} ${noun})`}
        onClick={onOpen}
      >
        <Code2 size={16} />
        {count > 1 && <span className="artifact-canvas-tab-count">{count}</span>}
        {working && <span className="artifact-canvas-tab-dot" aria-hidden="true" />}
      </button>
    </div>
  );
}

/** Neighbours in the chat's artifact list; an edited copy (not in the list)
 * steps to the newest or the first. */
function artifactNeighbours(artifacts: CodeArtifact[], index: number) {
  if (index < 0) return { previous: artifacts[artifacts.length - 1], next: artifacts[0] };
  return { previous: artifacts[index - 1], next: artifacts[index + 1] };
}

function ArtifactSwitcher({
  artifacts,
  index,
  onSelect,
}: {
  artifacts: CodeArtifact[];
  index: number;
  onSelect: (key: string) => void;
}) {
  const { previous, next } = artifactNeighbours(artifacts, index);
  return (
    <div className="artifact-canvas-switcher" role="group" aria-label="Artifacts in this chat">
      <button
        type="button"
        className="icon-button"
        aria-label="Previous artifact"
        data-tooltip={previous ? `Show ${previous.filename}` : "This is the first artifact"}
        disabled={!previous}
        onClick={() => previous && onSelect(previous.key)}
      >
        <ChevronLeft size={15} />
      </button>
      <span className="artifact-canvas-position">
        {index >= 0 ? index + 1 : "–"} / {artifacts.length}
      </span>
      <button
        type="button"
        className="icon-button"
        aria-label="Next artifact"
        data-tooltip={next ? `Show ${next.filename}` : "This is the latest artifact"}
        disabled={!next}
        onClick={() => next && onSelect(next.key)}
      >
        <ChevronRight size={15} />
      </button>
    </div>
  );
}

function lineCountLabel(lineCount: number) {
  return `${lineCount.toLocaleString()} line${lineCount === 1 ? "" : "s"}`;
}

function ArtifactTitle({ artifact, lineCount, previewLabel }: { artifact: CanvasArtifact; lineCount: number; previewLabel: string }) {
  return (
    <div className="artifact-canvas-title">
      <span className="artifact-canvas-icon" aria-hidden="true">
        <FileCode2 size={17} />
      </span>
      <span className="artifact-canvas-name">
        <strong title={artifact.filename}>{artifact.filename}</strong>
        <small>
          {artifact.language || "code"} · {lineCountLabel(lineCount)} · {previewLabel}
        </small>
      </span>
    </div>
  );
}

function CopyAction({ code }: { code: string }) {
  const { status, copy } = useCopyFeedback();
  return (
    <button type="button" className="md-code-action" data-tooltip="Copy this code" onClick={() => void copy(code)}>
      {status === "copied" ? <Check size={14} /> : <Copy size={14} />}
      <StableLabel label={status === "copied" ? "Copied" : status === "failed" ? "Failed" : "Copy"} reserve={["Copied", "Failed", "Copy"]} />
    </button>
  );
}

function ArtifactActions({
  artifact,
  expanded,
  leading,
  showPreview,
  onClose,
  onReload,
  onToggleExpanded,
}: {
  artifact: CanvasArtifact;
  expanded: boolean;
  /** Code-view controls (Edit/Done, Undo) placed before Copy. */
  leading?: ReactNode;
  showPreview: boolean;
  onClose: () => void;
  onReload: () => void;
  onToggleExpanded: () => void;
}) {
  return (
    <div className="artifact-canvas-actions">
      {leading}
      {showPreview && (
        <button type="button" className="md-code-action" data-tooltip="Restart the preview from the beginning" onClick={onReload}>
          <RotateCcw size={14} />
          Reload
        </button>
      )}
      <CopyAction code={artifact.code} />
      <button
        type="button"
        className="md-code-action"
        data-tooltip={`Download as ${artifact.filename}`}
        onClick={() => downloadCode(artifact.code, artifact.filename)}
      >
        <Download size={14} />
        Download
      </button>
      <button
        type="button"
        className="icon-button artifact-canvas-expand"
        aria-label={expanded ? "Restore the canvas beside the chat" : "Expand the canvas to the full window"}
        aria-pressed={expanded}
        data-tooltip={expanded ? "Restore beside the chat" : "Expand to the full window"}
        onClick={onToggleExpanded}
      >
        {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </button>
      <button
        type="button"
        className="icon-button artifact-canvas-close"
        aria-label="Close the artifact canvas"
        data-tooltip="Close the canvas (Esc)"
        onClick={onClose}
      >
        <X size={17} />
      </button>
    </div>
  );
}

/** The running preview (focused on every open, switch, and reload so
 * keyboard games respond at once), or the source: numbered, or in the editor. */
function ArtifactBody({
  codeRef,
  codeView,
  filename,
  frameDoc,
  frameKey,
}: {
  codeRef: RefObject<HTMLDivElement | null>;
  codeView: ReactNode;
  filename: string;
  frameDoc: string | null;
  frameKey: string;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const live = frameDoc !== null;
  useEffect(() => {
    if (!live) return undefined;
    const frame = window.requestAnimationFrame(() => frameRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [live, frameKey]);

  if (frameDoc === null) {
    return (
      <div className="artifact-canvas-body is-code" ref={codeRef}>
        {codeView}
      </div>
    );
  }
  return (
    <div className="artifact-canvas-body is-preview">
      <iframe
        key={frameKey}
        ref={frameRef}
        className="artifact-canvas-frame"
        sandbox="allow-scripts"
        srcDoc={frameDoc}
        title={`${filename} preview`}
      />
    </div>
  );
}

const VIEW_OPTIONS = [
  { value: "preview" as const, label: "Preview", icon: <Eye size={14} />, tooltip: "Run the artifact" },
  { value: "code" as const, label: "Code", icon: <Code2 size={14} />, tooltip: "Read the numbered source" },
];

const NO_SAVE = { occurrence: 0 };

/** Everything the canvas shows for one artifact. Edits happen in place and
 * save into the reply when `save` exists; Preview, Copy, and Download read
 * the code as edited, so the chat and the canvas never disagree. */
function useArtifactWork(artifact: CanvasArtifact, save: ArtifactSave | undefined, codeRef: RefObject<HTMLDivElement | null>) {
  const [view, setView] = useState<CanvasView>("preview");
  const edit = useCodeBlockEditing(artifact.code, save ?? NO_SAVE, Boolean(save));
  const code = edit.code;
  const lines = useMemo(() => code.split("\n"), [code]);
  const preview = useMemo(() => buildCodePreview(code, artifact.language), [code, artifact.language]);
  const identity = artifact.key ?? `snapshot:${artifact.filename}`;
  // A finished edit applies at once; only streaming replies settle first.
  const frameDoc = useSettledValue(preview.srcDoc, PREVIEW_SETTLE_MS, `${identity}:${edit.editing}`);
  const showPreview = view === "preview" && frameDoc !== null;
  const assist = useCodeEditAssist();
  const ai = useCodeAiEdit({
    assist: save && !showPreview ? assist : null,
    blockRef: codeRef,
    code,
    embedded: true,
    language: artifact.language,
    onApply: edit.commit,
  });

  /** Leaving the editor for Preview saves first, so the preview runs it. */
  function changeView(next: CanvasView) {
    if (edit.editing) edit.finish();
    setView(next);
  }

  return { ai, changeView, code, edit, frameDoc: showPreview ? frameDoc : null, identity, lines, preview, showPreview, view };
}

type ArtifactWork = ReturnType<typeof useArtifactWork>;

/** The save notice, plus Undo and Edit/Done while the code is showing. */
function ArtifactEditControls({ work }: { work: ArtifactWork }) {
  const { edit, showPreview } = work;
  return (
    <>
      <CodeSaveNotice status={edit.status} />
      {!showPreview && <CodeEditButtons editing={edit.editing} onToggleEditing={edit.toggle} onUndo={edit.undo} />}
    </>
  );
}

/** The numbered, colored source, or the editor while editing. */
function ArtifactCodeView({ language, work }: { language: string; work: ArtifactWork }) {
  const { ai, code, edit, lines } = work;
  if (edit.editing) {
    return <CodeBlockEditor language={language} marked={ai.marked} value={code} onChange={edit.setCode} onDone={edit.finish} />;
  }
  return <CodeLines language={language} lines={lines} marked={ai.marked} />;
}

function ArtifactHeader({
  artifact,
  artifacts,
  expanded,
  work,
  onClose,
  onReload,
  onSelect,
  onToggleExpanded,
}: {
  artifact: CanvasArtifact;
  artifacts: CodeArtifact[];
  expanded: boolean;
  work: ArtifactWork;
  onClose: () => void;
  onReload: () => void;
  onSelect?: (key: string) => void;
  onToggleExpanded: () => void;
}) {
  const index = artifacts.findIndex((item) => item.key === artifact.key);
  return (
    <header className="artifact-canvas-header">
      <ArtifactTitle artifact={artifact} lineCount={work.lines.length} previewLabel={work.preview.label} />
      {artifacts.length > 1 && onSelect && <ArtifactSwitcher artifacts={artifacts} index={index} onSelect={onSelect} />}
      {work.preview.srcDoc !== null && (
        <RailSwitch<CanvasView>
          ariaLabel="Artifact view"
          className="artifact-canvas-view"
          value={work.view}
          onChange={work.changeView}
          options={VIEW_OPTIONS}
        />
      )}
      <ArtifactActions
        artifact={{ ...artifact, code: work.code }}
        expanded={expanded}
        leading={<ArtifactEditControls work={work} />}
        showPreview={work.showPreview}
        onClose={onClose}
        onReload={onReload}
        onToggleExpanded={onToggleExpanded}
      />
    </header>
  );
}

/** The blade: slides in from the right over the chat column, a sliver of
 * the conversation dimmed at its left. Expand takes the whole window. */
export function ArtifactCanvasBlade({
  anchorLeft,
  artifact,
  artifacts = [],
  save,
  onClose,
  onSelect,
}: {
  anchorLeft?: number;
  artifact: CanvasArtifact;
  artifacts?: CodeArtifact[];
  /** Present when edits can be saved into the artifact's reply. */
  save?: ArtifactSave;
  onClose: () => void;
  onSelect?: (key: string) => void;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const codeRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [reloads, setReloads] = useState(0);
  useModalFocus(panelRef, true, onClose);
  const work = useArtifactWork(artifact, save, codeRef);

  const style = anchorLeft === undefined ? undefined : ({ "--artifact-canvas-left": `${anchorLeft}px` } as CSSProperties);

  return createPortal(
    <div className={`artifact-canvas-layer${expanded ? " is-expanded" : ""}`} style={style}>
      <button
        type="button"
        className="artifact-canvas-backdrop"
        aria-label="Close the artifact canvas"
        tabIndex={-1}
        onClick={onClose}
      />
      <section
        className="artifact-canvas"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Artifact canvas"
      >
        <ArtifactHeader
          artifact={artifact}
          artifacts={artifacts}
          expanded={expanded}
          work={work}
          onClose={onClose}
          onReload={() => setReloads((count) => count + 1)}
          onSelect={onSelect}
          onToggleExpanded={() => setExpanded((value) => !value)}
        />
        <ArtifactBody
          codeRef={codeRef}
          codeView={<ArtifactCodeView language={artifact.language} work={work} />}
          filename={artifact.filename}
          frameDoc={work.frameDoc}
          frameKey={`${work.identity}:${reloads}`}
        />
        <div className="artifact-canvas-ai">{work.ai.layer}</div>
      </section>
    </div>,
    document.body,
  );
}
