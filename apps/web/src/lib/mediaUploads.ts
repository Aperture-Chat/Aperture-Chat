/** Audio and video extensions the API can transcribe after upload. */

export const MEDIA_AUDIO_EXTENSIONS = [
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".wav",
] as const;

export const MEDIA_VIDEO_EXTENSIONS = [
  ".avi",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".webm",
] as const;

export const MEDIA_UPLOAD_EXTENSIONS = [...MEDIA_AUDIO_EXTENSIONS, ...MEDIA_VIDEO_EXTENSIONS] as const;

function extensionOf(name: string): string {
  const trimmed = name.trim().toLowerCase();
  const dot = trimmed.lastIndexOf(".");
  return dot >= 0 ? trimmed.slice(dot) : "";
}

export function isMediaUploadFile(file: Pick<File, "name" | "type">): boolean {
  const mime = file.type.split(";")[0].trim().toLowerCase();
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return true;
  return (MEDIA_UPLOAD_EXTENSIONS as readonly string[]).includes(extensionOf(file.name));
}
