import { MEDIA_UPLOAD_EXTENSIONS } from "./mediaUploads";

/** Files the indexer can read; everything else would only be searchable by name. */
export const KNOWLEDGE_FILE_EXTENSIONS = [
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
export const KNOWLEDGE_FILE_ACCEPT = KNOWLEDGE_FILE_EXTENSIONS.join(",");
const LEGACY_OFFICE = new Set([".doc", ".xls", ".ppt"]);

/**
 * Why a file cannot be added to a knowledge base, in words for the skipped
 * list ("unsupported type"), or null when it can. `maxMb` is the server's
 * per-file limit; null means it is not known yet.
 */
export function knowledgeFileSkipReason(file: File, maxMb: number | null): string | null {
  const extension = extensionOf(file.name);
  if (LEGACY_OFFICE.has(extension)) return `save it as ${extension}x first`;
  if (!isReadableKnowledgeFile(file, extension)) return "unsupported type";
  if (maxMb !== null && file.size > maxMb * 1024 * 1024) return `larger than ${maxMb} MB`;
  return null;
}

function isReadableKnowledgeFile(file: File, extension: string): boolean {
  if ((KNOWLEDGE_FILE_EXTENSIONS as readonly string[]).includes(extension)) return true;
  const type = file.type.toLowerCase();
  return type.startsWith("text/") || type.startsWith("image/") || type.startsWith("audio/") || type.startsWith("video/");
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}
