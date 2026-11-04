import { AlertTriangle, CheckCircle2, Folder, Loader2, RefreshCw, Square, Upload } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type ReactNode,
} from "react";
import type { KnowledgeLimits } from "../lib/api";
import {
  canKeepFolders,
  folderReadable,
  foldersFromInput,
  pickKeptFolder,
  readDrop,
  MAX_FOLDER_FILES,
  type FolderHandle,
  type FolderSource,
} from "../lib/folderAccess";
import { folderProblems, foldersInDocuments, folderSyncSummary, pathWithinFolder } from "../lib/folderFiles";
import { runKey, type FolderRun, type FolderSync, type FolderSyncState } from "../lib/folderSync";
import { sharedFolderSync } from "../lib/folderSyncBrowser";
import { KNOWLEDGE_FILE_ACCEPT } from "../lib/knowledgeFiles";
import type { KnowledgeDocument, KnowledgeFolderFileResult } from "../lib/types";
import { Toggle } from "./Primitives";
import "./knowledge-folders.css";

/** Tests supply their own engine; the app uses the shared one. */
export const FolderSyncContext = createContext<FolderSync | null>(null);

export function useFolderSyncService(): FolderSync {
  return useContext(FolderSyncContext) || sharedFolderSync();
}

const CHECK_EVERY_MS = 3 * 60_000;
const MIN_CHECK_GAP_MS = 60_000;

type WatchedSync = Pick<FolderSync, "load" | "syncKept">;

/**
 * Re-check the signed-in person's kept folders while Aperture is open: once
 * they are loaded, every few minutes, and when the tab comes back into view,
 * but never twice within a minute.
 */
export function useFolderSyncWatcher(userId: string | null, service: WatchedSync = sharedFolderSync()): void {
  useEffect(() => {
    if (!userId) return;
    let lastCheck = Date.now();
    const check = (force: boolean) => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (!force && now - lastCheck < MIN_CHECK_GAP_MS) return;
      lastCheck = now;
      void service.syncKept(userId);
    };
    void service.load(userId).then(() => check(true), () => undefined);
    const interval = window.setInterval(() => check(false), CHECK_EVERY_MS);
    const onVisible = () => check(false);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [service, userId]);
}

/** Hear each folder file the engine sends and each finished run, for the open library. */
export function useFolderSyncEvents(
  onDocument: (knowledgeId: string, result: KnowledgeFolderFileResult) => void,
  onFinished: (knowledgeId: string) => void,
): void {
  const service = useFolderSyncService();
  useEffect(
    () =>
      service.onEvent((event) => {
        if (event.type === "document") onDocument(event.knowledgeId, event.result);
        else onFinished(event.knowledgeId);
      }),
    [onDocument, onFinished, service],
  );
}

/** Ask before a very large folder goes up; folders over 500 new files come here. */
export function confirmLargeFolder(name: string) {
  return (count: number, bytes: number) =>
    window.confirm(
      `Add ${count.toLocaleString()} files (${sizeLabel(bytes)}) from “${name}”? Large folders can take a while, and you can stop at any time.`,
    );
}

// ============================================================== drop zone

type FolderHandlers = { onFolders: (folders: FolderSource[]) => void; onNotice: (message: string) => void };

export function KnowledgeDropZone({
  limits,
  onFiles,
  onFolders,
  onNotice,
}: FolderHandlers & { limits: KnowledgeLimits | null; onFiles: (files: File[]) => void }) {
  const inputId = useId();
  const folderInput = useFolderInput("Choose a folder to add", onFolders);
  const drag = useDragDepth((event) => {
    void readDrop(event.dataTransfer).then(({ files, folders }) => {
      if (files.length) onFiles(files);
      if (folders.length) onFolders(folders);
    });
  });
  return (
    <div className={`knowledge-dropzone ${drag.dragging ? "is-dragging" : ""}`} {...drag.handlers}>
      <span className="knowledge-dropzone-icon" aria-hidden="true">
        <Upload size={20} />
      </span>
      <div>
        <strong>Drag files or folders here</strong>, or{" "}
        <label className="knowledge-browse" htmlFor={inputId}>
          choose files
        </label>{" "}
        or{" "}
        <button
          className="knowledge-browse knowledge-browse-button"
          type="button"
          onClick={() => void chooseFolder(folderInput.open, { onFolders, onNotice })}
        >
          choose a folder
        </button>
        <input
          id={inputId}
          className="knowledge-file-input"
          type="file"
          multiple
          accept={KNOWLEDGE_FILE_ACCEPT}
          aria-label="Choose files to add"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files || []);
            event.currentTarget.value = "";
            if (files.length) onFiles(files);
          }}
        />
        {folderInput.input}
        <DropZoneHelp limits={limits} />
      </div>
    </div>
  );
}

function DropZoneHelp({ limits }: { limits: KnowledgeLimits | null }) {
  const sizeLimit = limits ? ` · up to ${limits.upload_max_mb.toLocaleString()} MB each` : "";
  const ocr = limits?.ocr_enabled ? ` Scanned pages are read with OCR (first ${limits.ocr_max_pages.toLocaleString()} pages).` : "";
  const vision = limits?.vision_ocr?.available
    ? ` Handwriting, stamps, and pictures are read by ${limits.vision_ocr.model_name}.`
    : "";
  return (
    <small>
      PDF, Word, Excel, PowerPoint, email, images, text, audio, and video{sizeLimit}. Files are searchable as soon as
      they finish.{ocr}
      {vision} File properties such as author, dates, labels, and custom fields are kept and searchable. Drop several
      folders at once to add a whole project; each folder keeps its subfolders and can stay in sync.
    </small>
  );
}

/** Drag state that survives the enter/leave pairs fired by child elements. */
function useDragDepth(onDrop: (event: DragEvent<HTMLDivElement>) => void) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const handlers = {
    onDragEnter: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (event: DragEvent<HTMLDivElement>) => event.preventDefault(),
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      onDrop(event);
    },
  };
  return { dragging, handlers };
}

/**
 * Pick a folder Aperture can sync later; where the browser cannot keep one,
 * fall back to the plain folder input (it reads the files once).
 */
async function chooseFolder(openInput: () => void, { onFolders, onNotice }: FolderHandlers) {
  if (!canKeepFolders()) {
    openInput();
    return;
  }
  try {
    const picked = await pickKeptFolder();
    if (picked) onFolders([picked]);
  } catch {
    // The picker opened but reading was refused. The plain input needs a
    // fresh click when the browser no longer counts this one.
    if (navigator.userActivation?.isActive === false) {
      onNotice("This browser reads folders another way. Choose “choose a folder” again to pick it.");
    } else {
      openInput();
    }
  }
}

/**
 * A hidden `<input webkitdirectory>` the page opens itself: the way to read a
 * folder in browsers that cannot keep one. Hidden from assistive technology,
 * which reaches the visible button that opens it instead.
 */
function useFolderInput(label: string, onFolders: (folders: FolderSource[]) => void) {
  const ref = useRef<HTMLInputElement | null>(null);
  const input = (
    <input
      ref={(node) => {
        ref.current = node;
        // React does not pass webkitdirectory through as a known attribute.
        node?.setAttribute("webkitdirectory", "");
      }}
      className="knowledge-file-input"
      type="file"
      multiple
      tabIndex={-1}
      aria-hidden="true"
      aria-label={label}
      onChange={(event) => {
        const folders = foldersFromInput(Array.from(event.currentTarget.files || []));
        event.currentTarget.value = "";
        if (folders.length) onFolders(folders);
      }}
    />
  );
  // The input is always mounted beside the control that opens it, so the
  // optional call never skips a click (mutation testing marks it equivalent).
  return { input, open: () => ref.current?.click() };
}

// ================================================================ folders

/** Folder names to list, with file counts: folders with files, plus ones running or kept with none yet. */
export function listedFolders(
  documents: KnowledgeDocument[],
  state: FolderSyncState,
  userId: string,
  knowledgeId: string,
): Array<[string, number]> {
  const counts = new Map(foldersInDocuments(documents).map((folder) => [folder.name, folder.fileCount]));
  const running = [...state.runs.keys()]
    .map((key) => JSON.parse(key) as [string, string])
    .filter(([runBase]) => runBase === knowledgeId)
    .map(([, name]) => name);
  const kept = state.kept
    .filter((folder) => folder.userId === userId && folder.knowledgeId === knowledgeId)
    .map((folder) => folder.name);
  for (const name of [...running, ...kept]) {
    if (!counts.has(name)) counts.set(name, 0);
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
}

type FolderActions = {
  service: FolderSync;
  userId: string;
  knowledgeId: string;
  canKeep: boolean;
  say: (name: string, message: string) => void;
  reselect: (name: string) => void;
};

function startSync(actions: FolderActions, source: FolderSource) {
  actions.say(source.name, "");
  void actions.service.sync({
    userId: actions.userId,
    knowledgeId: actions.knowledgeId,
    source,
    confirmLarge: confirmLargeFolder(source.name),
  });
}

function wrongFolderMessage(name: string, chosen: string): string {
  return `You chose “${chosen}”. Choose the folder named “${name}” to sync it. Nothing was added.`;
}

/** Ask for the folder named `name`; null (with a message) when it is cancelled, refused, or another folder. */
async function pickFolderNamed(actions: FolderActions, name: string): Promise<FolderHandle | null> {
  try {
    const picked = await pickKeptFolder();
    if (picked && "handle" in picked && picked.name === name) return picked.handle;
    if (picked) actions.say(name, wrongFolderMessage(name, picked.name));
  } catch {
    actions.say(name, "This browser did not allow Aperture to read the folder. Use Sync now to choose it another way.");
  }
  return null;
}

/** The handle this browser keeps for a folder, once it may be read; null (with a message) otherwise. */
async function readableKeptHandle(actions: FolderActions, name: string, refusal: string): Promise<FolderHandle | null> {
  const kept = actions.service.keptFolder(actions.userId, actions.knowledgeId, name);
  if (!kept) return null;
  if (await folderReadable(kept.handle, true)) return kept.handle;
  actions.say(name, refusal);
  return null;
}

async function syncFolderNow(actions: FolderActions, name: string) {
  if (actions.service.keptFolder(actions.userId, actions.knowledgeId, name)) {
    const handle = await readableKeptHandle(actions, name, "Aperture was not allowed to read this folder. Choose Sync now again and allow it.");
    if (handle) startSync(actions, { name, handle });
    return;
  }
  if (!actions.canKeep) {
    actions.reselect(name);
    return;
  }
  const handle = await pickFolderNamed(actions, name);
  if (handle) startSync(actions, { name, handle });
}

async function keepFolderInSync(actions: FolderActions, name: string, on: boolean) {
  const { service, userId, knowledgeId } = actions;
  if (!on) {
    await service.setKeepInSync(userId, knowledgeId, name, false);
    return;
  }
  const handle = service.keptFolder(userId, knowledgeId, name)
    ? await readableKeptHandle(actions, name, "Aperture was not allowed to read this folder, so it can't stay in sync.")
    : await pickFolderNamed(actions, name);
  if (!handle) return;
  await service.setKeepInSync(userId, knowledgeId, name, true, handle);
  startSync(actions, { name, handle });
}

/** Every folder in a knowledge base, with its sync state and controls. */
export function KnowledgeFolderList({
  userId,
  knowledgeId,
  documents,
}: {
  userId: string;
  knowledgeId: string;
  documents: KnowledgeDocument[];
}) {
  const service = useFolderSyncService();
  const state = useSyncExternalStore(service.subscribe, service.getState);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const expected = useRef<string | null>(null);
  const reselectInput = useFolderInput("Choose the folder again to sync it", (chosen) => {
    const name = expected.current;
    expected.current = null;
    if (!name) return;
    const match = chosen.find((folder) => folder.name === name);
    if (match) startSync(actions, match);
    else actions.say(name, wrongFolderMessage(name, chosen[0].name));
  });

  useEffect(() => {
    void service.load(userId).catch(() => undefined);
  }, [service, userId]);

  const folders = listedFolders(documents, state, userId, knowledgeId);
  if (!folders.length) return null;
  const actions: FolderActions = {
    service,
    userId,
    knowledgeId,
    canKeep: canKeepFolders(),
    say: (name, message) => setMessages((current) => ({ ...current, [name]: message })),
    reselect: (name) => {
      expected.current = name;
      reselectInput.open();
    },
  };

  return (
    <section className="knowledge-folders" aria-label="Folders">
      <div className="knowledge-list-head">
        <span className="ws-section-label">Folders</span>
      </div>
      {reselectInput.input}
      <ul className="knowledge-folder-rows">
        {folders.map(([name, fileCount]) => (
          <FolderRow
            key={name}
            name={name}
            fileCount={fileCount}
            run={state.runs.get(runKey(knowledgeId, name))}
            keepInSync={Boolean(service.keptFolder(userId, knowledgeId, name)?.keepInSync)}
            canKeep={actions.canKeep}
            message={messages[name]}
            onSyncNow={() => void syncFolderNow(actions, name)}
            onStop={() => service.stop(knowledgeId, name)}
            onKeepInSync={(on) => void keepFolderInSync(actions, name, on)}
          />
        ))}
      </ul>
    </section>
  );
}

type FolderRowProps = {
  name: string;
  fileCount: number;
  run: FolderRun | undefined;
  keepInSync: boolean;
  canKeep: boolean;
  message: string | undefined;
  onSyncNow: () => void;
  onStop: () => void;
  onKeepInSync: (on: boolean) => void;
};

const BUSY_PHASES = new Set<FolderRun["phase"]>(["waiting", "reading", "sending"]);
const ROW_TONES: Record<FolderRun["phase"], string> = {
  waiting: "is-busy",
  reading: "is-busy",
  sending: "is-busy",
  done: "",
  failed: "is-error",
  "needs-permission": "is-paused",
};

function isBusy(run: FolderRun | undefined): boolean {
  return Boolean(run && BUSY_PHASES.has(run.phase));
}

function FolderRow(props: FolderRowProps) {
  const { name, fileCount, run, keepInSync, message } = props;
  return (
    <li className={`knowledge-folder-row ${run ? ROW_TONES[run.phase] : ""}`}>
      <span className="knowledge-row-icon" aria-hidden="true">
        <FolderRowIcon run={run} />
      </span>
      <span className="knowledge-row-main">
        <strong title={name}>{name}</strong>
        <small>{folderFacts(fileCount, keepInSync)}</small>
        {run && (
          <small className="knowledge-folder-status" role="status">
            {runStatusText(run)}
          </small>
        )}
        {run?.phase === "sending" && <FolderProgress run={run} name={name} />}
        {run?.phase === "done" && folderProblems(run.result) ? (
          <small className="knowledge-folder-problems">{folderProblems(run.result)}</small>
        ) : null}
        {message ? <small className="knowledge-folder-message">{message}</small> : null}
        <small className="knowledge-folder-help">{folderHelpText(props.canKeep, keepInSync)}</small>
      </span>
      <span className="knowledge-row-actions knowledge-folder-actions">
        {props.canKeep && <KeepInSyncSwitch name={name} on={keepInSync} onChange={props.onKeepInSync} />}
        <FolderRunButton name={name} run={run} onSyncNow={props.onSyncNow} onStop={props.onStop} />
      </span>
    </li>
  );
}

function folderFacts(fileCount: number, keepInSync: boolean): string {
  const files = `${fileCount.toLocaleString()} ${fileCount === 1 ? "file" : "files"} in Aperture`;
  return keepInSync ? `${files} · Kept in sync on this computer` : files;
}

export function folderHelpText(canKeep: boolean, keepInSync: boolean): string {
  if (!canKeep) return "To add new files later, choose Sync now and pick this folder again.";
  if (!keepInSync) return "Turn on Keep in sync to add new and changed files automatically.";
  return "New and changed files are added every few minutes while Aperture is open in this browser. Files you delete from the folder stay here until you remove them below.";
}

function KeepInSyncSwitch({ name, on, onChange }: { name: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <span className="knowledge-card-switch">
      <Toggle
        checked={on}
        label={`Keep ${name} in sync`}
        tooltip={on ? "Stop adding new files from this folder" : "Add new and changed files from this folder automatically"}
        onChange={onChange}
      />
      <span>Keep in sync: {on ? "On" : "Off"}</span>
    </span>
  );
}

function FolderRunButton({
  name,
  run,
  onSyncNow,
  onStop,
}: {
  name: string;
  run: FolderRun | undefined;
  onSyncNow: () => void;
  onStop: () => void;
}) {
  if (isBusy(run)) {
    return (
      <button className="secondary-button compact-button" type="button" aria-label={`Stop syncing ${name}`} onClick={onStop}>
        <Square size={13} /> Stop
      </button>
    );
  }
  const paused = run?.phase === "needs-permission";
  return (
    <button
      className="secondary-button compact-button"
      type="button"
      aria-label={paused ? `Allow and sync ${name}` : `Sync ${name} now`}
      onClick={onSyncNow}
    >
      <RefreshCw size={14} /> {paused ? "Allow and sync" : "Sync now"}
    </button>
  );
}

const PHASE_ICONS: Record<FolderRun["phase"], ReactNode> = {
  waiting: <Loader2 size={16} className="is-spinning" />,
  reading: <Loader2 size={16} className="is-spinning" />,
  sending: <Loader2 size={16} className="is-spinning" />,
  done: <CheckCircle2 size={16} />,
  failed: <AlertTriangle size={16} />,
  "needs-permission": <AlertTriangle size={16} />,
};

function FolderRowIcon({ run }: { run: FolderRun | undefined }) {
  return run ? PHASE_ICONS[run.phase] : <Folder size={16} />;
}

export function runStatusText(run: FolderRun): string {
  switch (run.phase) {
    case "waiting":
      return "Waiting for another folder to finish…";
    case "reading":
      return "Checking the folder for new and changed files…";
    case "sending":
      return `Adding ${Math.min(run.done + 1, run.total).toLocaleString()} of ${run.total.toLocaleString()}: ${pathWithinFolder(run.current)}`;
    case "done":
      return doneText(run);
    case "failed":
      return `Could not sync: ${run.message}`;
    case "needs-permission":
      return "Paused. This browser needs your OK to read the folder again. Choose Allow and sync.";
  }
}

function doneText(run: Extract<FolderRun, { phase: "done" }>): string {
  const cut = run.truncated ? ` Only the first ${MAX_FOLDER_FILES.toLocaleString()} files were read.` : "";
  return `${folderSyncSummary(run.result)}${cut} Checked at ${timeLabel(run.at)}.`;
}

function FolderProgress({ run, name }: { run: Extract<FolderRun, { phase: "sending" }>; name: string }) {
  const percent = Math.round((run.done / run.total) * 100);
  return (
    <span
      className="knowledge-progress"
      role="progressbar"
      aria-label={`${name} sync progress`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <span style={{ width: `${percent}%` }} />
    </span>
  );
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString()} KB`;
}
