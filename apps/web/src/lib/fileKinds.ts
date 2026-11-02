/** What a file is, from its name. Shared by every composer so a block reads the same. */
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

export function fileKind(name: string): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return KIND_BY_EXT[ext] ?? (ext ? ext.toUpperCase() : "File");
}

export function fileIconClass(kind: string): string {
  const value = kind.toLowerCase();
  if (value.includes("pdf")) return "pdf";
  if (value.includes("word") || value.includes("doc")) return "word";
  if (value.includes("email") || value === "eml") return "eml";
  return "file-generic";
}
