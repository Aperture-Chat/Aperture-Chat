/**
 * Folders from a person's computer, as the Knowledge library uploads and syncs them.
 *
 * Glossary:
 * - folder path: where a file sits inside the chosen folder, starting with the
 *   folder's own name ("Matter 12/Pleadings/brief.pdf"). One document per path.
 * - folder: the path's first segment. Choosing a folder with the same name
 *   again syncs it: only new and changed files are sent.
 * - kept out: a file someone removed in Aperture. Syncs leave it out so a
 *   removal sticks even though the file is still on the computer.
 */
import type { KnowledgeDocument, KnowledgeFolderManifest } from "./types";

/** A file read from a folder, with its folder path. */
export type LocalFolderFile = { path: string; file: File };

export type FolderSkip = { path: string; reason: string };
export type FolderFailure = { path: string; message: string };
export type FolderUpload = LocalFolderFile & { change: "new" | "changed" };
export type FolderPlan = {
  uploads: FolderUpload[];
  unchanged: number;
  skipped: FolderSkip[];
  keptOut: number;
};

/** What one sync did, for the folder's status line. */
export type FolderSyncResult = {
  added: number;
  updated: number;
  unchanged: number;
  skipped: FolderSkip[];
  failed: FolderFailure[];
  keptOut: number;
  stopped: boolean;
};

/** Why a file cannot be added (unsupported, too large), or null when it can. */
export type SkipReason = (file: File) => string | null;

const SYSTEM_NAMES = new Set(["thumbs.db", "desktop.ini"]);

/** Dot files and folders, Office lock files, and OS clutter are never sent or reported. */
export function isHiddenOrSystemName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith(".") || lower.startsWith("~$") || SYSTEM_NAMES.has(lower);
}

export function relativeFolderPath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function folderNameOf(path: string): string {
  return path.split("/")[0];
}

/** Files chosen together, grouped by the folder each came from, folders sorted by name. */
export function groupFolderFiles(files: LocalFolderFile[]): Array<{ name: string; files: LocalFolderFile[] }> {
  const names = [...new Set(files.map((item) => folderNameOf(item.path)))].sort((left, right) => left.localeCompare(right));
  return names.map((name) => ({ name, files: files.filter((item) => folderNameOf(item.path) === name) }));
}

type KnownFile = KnowledgeFolderManifest["files"][number];
type Verdict =
  | { kind: "ignore" }
  | { kind: "keptOut" }
  | { kind: "skip"; reason: string }
  | { kind: "unchanged" }
  | { kind: "upload"; change: FolderUpload["change"] };

/** Which local files to send, given what the server already holds for the folder. */
export function planFolderSync(
  files: LocalFolderFile[],
  manifest: KnowledgeFolderManifest | undefined,
  skipReason: SkipReason,
): FolderPlan {
  const known = new Map(manifest ? manifest.files.map((entry) => [entry.path, entry]) : []);
  const removed = new Set(manifest ? manifest.removed : []);
  const plan: FolderPlan = { uploads: [], unchanged: 0, skipped: [], keptOut: 0 };
  for (const item of files) addToPlan(plan, item, verdictFor(item, known, removed, skipReason));
  plan.uploads.sort((left, right) => left.path.localeCompare(right.path));
  return plan;
}

function verdictFor(
  item: LocalFolderFile,
  known: Map<string, KnownFile>,
  removed: Set<string>,
  skipReason: SkipReason,
): Verdict {
  if (item.path.split("/").some(isHiddenOrSystemName)) return { kind: "ignore" };
  if (removed.has(item.path)) return { kind: "keptOut" };
  const reason = skipReason(item.file);
  if (reason) return { kind: "skip", reason };
  const entry = known.get(item.path);
  if (!entry) return { kind: "upload", change: "new" };
  return sameFile(entry, item.file) ? { kind: "unchanged" } : { kind: "upload", change: "changed" };
}

function sameFile(entry: KnownFile, file: File): boolean {
  return entry.size === file.size && entry.modified === Math.trunc(file.lastModified);
}

function addToPlan(plan: FolderPlan, item: LocalFolderFile, verdict: Verdict): void {
  if (verdict.kind === "keptOut") plan.keptOut += 1;
  else if (verdict.kind === "skip") plan.skipped.push({ path: item.path, reason: verdict.reason });
  else if (verdict.kind === "unchanged") plan.unchanged += 1;
  else if (verdict.kind === "upload") plan.uploads.push({ ...item, change: verdict.change });
}

/** The folders a knowledge base holds, by name, with how many files each has. */
export function foldersInDocuments(documents: KnowledgeDocument[]): Array<{ name: string; fileCount: number }> {
  const names = documents.flatMap((document) => (document.folder_file ? [folderNameOf(document.folder_file.path)] : []));
  return [...new Set(names)]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({ name, fileCount: names.filter((item) => item === name).length }));
}

/** Where a file sits inside its folder: "Matter 12/Pleadings/a.pdf" -> "Pleadings/a.pdf". */
export function pathWithinFolder(path: string): string {
  return path.slice(path.indexOf("/") + 1);
}

/** The files a sync could not add, by name and reason, at most `limit` of them. */
export function folderProblems(result: FolderSyncResult, limit = 3): string {
  const problems = [
    ...result.skipped.map((item) => `${pathWithinFolder(item.path)} (${item.reason})`),
    ...result.failed.map((item) => `${pathWithinFolder(item.path)} (${item.message})`),
  ];
  if (!problems.length) return "";
  const more = problems.length - limit;
  const tail = more > 0 ? `, and ${more.toLocaleString()} more` : "";
  return `Not added: ${problems.slice(0, limit).join(", ")}${tail}.`;
}

export function folderSyncSummary(result: FolderSyncResult): string {
  const changed = result.added + result.updated;
  const sentences: Array<[boolean, string]> = [
    [result.stopped, "Stopped."],
    [true, changesSentence(result)],
    [result.unchanged > 0 && changed > 0, `${wasWere(result.unchanged)} already up to date.`],
    [result.skipped.length > 0, `${wasWere(result.skipped.length)} skipped.`],
    [result.failed.length > 0, `${result.failed.length.toLocaleString()} could not be added.`],
    [result.keptOut > 0, `${result.keptOut.toLocaleString()} you removed in Aperture ${result.keptOut === 1 ? "was" : "were"} left out.`],
  ];
  return sentences
    .filter(([shown]) => shown)
    .map(([, sentence]) => sentence)
    .join(" ");
}

function wasWere(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "was" : "were"}`;
}

function changesSentence({ added, updated, stopped }: FolderSyncResult): string {
  if (stopped && !added && !updated) return "No files were added.";
  if (added && updated) return `Added ${filesLabel(added, "new file")} and updated ${updated.toLocaleString()}.`;
  if (added) return `Added ${filesLabel(added, "new file")}.`;
  if (updated) return `Updated ${filesLabel(updated, "file")}.`;
  return "Everything was already up to date.";
}

function filesLabel(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}
