/** Code artifacts: the fenced code blocks a reply produces, named and typed so
 * they can be downloaded under a meaningful file name and opened in the
 * artifact canvas. Pure functions only; the components own the side effects. */

import { parseMarkdownBlocks, resolveDiagramBlock, type MarkdownBlock } from "./markdown";

export type FenceInfo = { language: string; filename: string | null };

export type CodeArtifact = {
  /** `${prefix}:${n}` — stable across streaming updates and response versions. */
  key: string;
  code: string;
  language: string;
  filename: string;
  lineCount: number;
};

export type CodePreview = { label: string; srcDoc: string | null };

type NameCase = "snake" | "kebab" | "pascal";

type LanguageSpec = {
  /** Extension without the dot; "" for conventional extensionless files. */
  ext: string;
  /** Extensionless conventional file name (Dockerfile, Makefile). */
  fixedName?: string;
  nameCase: NameCase;
  /** Ordered declaration patterns; capture group 1 is the symbol. */
  symbols?: RegExp[];
};

const MAX_STEM = 56;

const PY_SYMBOLS = [/^class\s+([A-Za-z_]\w*)/m, /^(?:async\s+)?def\s+([A-Za-z_]\w*)/m];
const JS_SYMBOLS = [
  /^export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/m,
  /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/m,
  /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/m,
  /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|function|[A-Za-z_$][\w$]*\s*=>)/m,
];
const C_SYMBOLS = [
  /^(?:class|struct)\s+([A-Za-z_]\w*)/m,
  /^[A-Za-z_][\w\s*&:<>]*?\b([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/m,
];
const JVM_SYMBOLS = [
  /^(?:(?:public|private|protected|internal|final|abstract|sealed|static|partial|open|data|enum|inner|value|readonly)\s+)*(?:class|interface|enum|record|struct|object)\s+([A-Za-z_]\w*)/m,
];
const SQL_SYMBOLS = [
  /\bcreate\s+(?:or\s+replace\s+)?(?:temporary\s+|temp\s+)?(?:table|view|materialized\s+view|function|procedure|index)\s+(?:if\s+not\s+exists\s+)?["`[]?([A-Za-z_][\w$]*)/i,
];
const SHELL_SYMBOLS = [/^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/m, /^function\s+([A-Za-z_][\w-]*)/m];

const spec = (ext: string, nameCase: NameCase = "kebab", symbols?: RegExp[]): LanguageSpec => ({ ext, nameCase, symbols });

const LANGUAGES: Record<string, LanguageSpec> = {
  html: spec("html"),
  css: spec("css"),
  scss: spec("scss"),
  sass: spec("sass"),
  less: spec("less"),
  js: spec("js", "kebab", JS_SYMBOLS),
  mjs: spec("mjs", "kebab", JS_SYMBOLS),
  cjs: spec("cjs", "kebab", JS_SYMBOLS),
  jsx: spec("jsx", "kebab", JS_SYMBOLS),
  ts: spec("ts", "kebab", JS_SYMBOLS),
  tsx: spec("tsx", "kebab", JS_SYMBOLS),
  vue: spec("vue"),
  svelte: spec("svelte"),
  py: spec("py", "snake", PY_SYMBOLS),
  rb: spec("rb", "snake", [/^class\s+([A-Z]\w*)/m, /^module\s+([A-Z]\w*)/m, /^def\s+([a-z_]\w*[?!]?)/m]),
  go: spec("go", "snake", [/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/m, /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/m]),
  rs: spec("rs", "snake", [/^(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/m, /^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/m]),
  java: spec("java", "pascal", JVM_SYMBOLS),
  kt: spec("kt", "pascal", JVM_SYMBOLS),
  cs: spec("cs", "pascal", JVM_SYMBOLS),
  scala: spec("scala", "pascal", JVM_SYMBOLS),
  swift: spec("swift", "pascal", [/^(?:(?:public|private|internal|final|open)\s+)*(?:struct|class|enum|protocol|actor)\s+([A-Za-z_]\w*)/m]),
  php: spec("php", "pascal", JVM_SYMBOLS),
  dart: spec("dart", "snake", JVM_SYMBOLS),
  c: spec("c", "snake", C_SYMBOLS),
  h: spec("h", "snake", C_SYMBOLS),
  cpp: spec("cpp", "snake", C_SYMBOLS),
  hpp: spec("hpp", "snake", C_SYMBOLS),
  m: spec("m"),
  sh: spec("sh", "kebab", SHELL_SYMBOLS),
  zsh: spec("zsh", "kebab", SHELL_SYMBOLS),
  fish: spec("fish"),
  ps1: spec("ps1", "kebab", [/^function\s+([A-Za-z][\w-]*)/im]),
  bat: spec("bat"),
  sql: spec("sql", "snake", SQL_SYMBOLS),
  json: spec("json"),
  yaml: spec("yaml"),
  toml: spec("toml"),
  ini: spec("ini"),
  xml: spec("xml"),
  svg: spec("svg"),
  md: spec("md"),
  txt: spec("txt"),
  csv: spec("csv"),
  tsv: spec("tsv"),
  r: spec("r", "snake"),
  lua: spec("lua", "snake"),
  pl: spec("pl", "snake"),
  ex: spec("ex", "snake"),
  erl: spec("erl", "snake"),
  hs: spec("hs", "pascal"),
  clj: spec("clj", "kebab"),
  jl: spec("jl", "snake"),
  graphql: spec("graphql"),
  proto: spec("proto", "snake"),
  tf: spec("tf", "snake"),
  sol: spec("sol", "pascal", [/^contract\s+([A-Za-z_]\w*)/m]),
  tex: spec("tex"),
  diff: spec("diff"),
  conf: spec("conf"),
  env: spec("env"),
  zig: spec("zig", "snake"),
  dockerfile: { ext: "", fixedName: "Dockerfile", nameCase: "kebab" },
  makefile: { ext: "", fixedName: "Makefile", nameCase: "kebab" },
};

const ALIASES: Record<string, string> = {
  htm: "html", xhtml: "html", javascript: "js", node: "js", typescript: "ts", python: "py", py3: "py",
  python3: "py", ruby: "rb", golang: "go", rust: "rs", kotlin: "kt", kts: "kt", csharp: "cs", "c#": "cs",
  "c++": "cpp", cxx: "cpp", cc: "cpp", objc: "m", "objective-c": "m", matlab: "m", shell: "sh", bash: "sh",
  console: "sh", powershell: "ps1", pwsh: "ps1", ps: "ps1", cmd: "bat", batch: "bat", yml: "yaml",
  markdown: "md", text: "txt", plaintext: "txt", plain: "txt", postgresql: "sql", postgres: "sql",
  mysql: "sql", sqlite: "sql", plsql: "sql", tsql: "sql", jsonc: "json", json5: "json", perl: "pl",
  elixir: "ex", erlang: "erl", haskell: "hs", clojure: "clj", julia: "jl", gql: "graphql", protobuf: "proto",
  terraform: "tf", hcl: "tf", solidity: "sol", latex: "tex", patch: "diff", nginx: "conf", dotenv: "env",
  docker: "dockerfile", make: "makefile", mk: "makefile",
};

/** The extensionless or extension token of a plausible file name. */
const FILENAME_PATTERN = /^[\w.\-/\\]*[\w-]\.[A-Za-z0-9]{1,10}$/;
const EXTENSIONLESS_NAMES = new Set(["dockerfile", "makefile", "procfile", "gemfile", "rakefile"]);

function languageKey(language: string): string {
  const token = language.trim().toLowerCase();
  return ALIASES[token] ?? token;
}

function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

function looksLikeFilename(token: string): boolean {
  return FILENAME_PATTERN.test(token) || EXTENSIONLESS_NAMES.has(basename(token).toLowerCase());
}

/** File name in an info string: `title="main.py"`, `js:server.js`,
 * ```main.py```, or a second token ```python build.py```. */
export function parseFenceInfo(info: string): FenceInfo {
  const trimmed = info.trim();
  const [first = "", second = ""] = trimmed.split(/\s+/);
  const candidates: Array<[string, string]> = [
    [first, attributeFilename(trimmed)],
    splitColon(first),
    [extensionOf(first), first],
    [first, second],
  ];
  const found = candidates.find(([language, candidate]) => language && candidate && looksLikeFilename(candidate));
  return found ? { language: found[0], filename: basename(found[1]) } : { language: first, filename: null };
}

const ATTRIBUTE_FILENAME = /\b(?:title|file(?:name)?|name|path)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/i;

function attributeFilename(info: string): string {
  return ATTRIBUTE_FILENAME.exec(info)?.slice(1).find((value) => value !== undefined) ?? "";
}

/** `js:server.js` → ["js", "server.js"]; no colon → no file name. */
function splitColon(token: string): [string, string] {
  const [language = "", filename = ""] = token.split(":", 2);
  return [language, filename];
}

function extensionOf(token: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(token);
  return match ? match[1]!.toLowerCase() : "";
}

const COMMENT_FILENAME =
  /^\s*(?:\/\/+|#|--|;+|\/\*+|<!--|%)\s*(?:(?:file(?:name)?|path)\s*:\s*)?([\w.\-/\\]+)\s*(?:\*+\/|-->)?\s*$/i;

function commentFilename(code: string): string | null {
  const firstLine = code.split("\n").find((line) => line.trim() !== "") ?? "";
  const match = COMMENT_FILENAME.exec(firstLine);
  return match && looksLikeFilename(match[1]!) ? basename(match[1]!) : null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };

function markupText(fragment: string): string {
  return fragment.replace(/<[^>]*>/g, " ").replace(/&(#39|[a-z]+);/gi, (entity, code: string) => ENTITIES[code.toLowerCase()] ?? entity);
}

function documentTitle(code: string, key: string): string | null {
  if (key !== "html" && key !== "svg") return null;
  const title = /<title[^>]*>[\s\S]*?<\/title>/i.exec(code) ?? (key === "html" ? /<h1[^>]*>[\s\S]*?<\/h1>/i.exec(code) : null);
  return title ? markupText(title[0]) : null;
}

function primarySymbol(code: string, langSpec: LanguageSpec): string | null {
  for (const pattern of langSpec.symbols ?? []) {
    const symbol = pattern.exec(code)?.[1];
    if (symbol) return symbol;
  }
  return null;
}

/** Lowercase ASCII words. Identifiers also split at camel humps (and a
 * digit before a capitalized word); prose keeps "3D" and "iPhone" whole. */
function words(text: string, identifier = false): string[] {
  const folded = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const split = identifier
    ? folded
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/([0-9])([A-Z][a-z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    : folded;
  return split
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function capStem(parts: string[], joiner: string): string {
  let stem = "";
  for (const part of parts) {
    const next = stem ? `${stem}${joiner}${part}` : part;
    if (next.length > MAX_STEM) break;
    stem = next;
  }
  return stem || (parts[0] ?? "").slice(0, MAX_STEM);
}

function symbolStem(symbol: string, nameCase: NameCase): string {
  if (nameCase === "pascal") return symbol.slice(0, MAX_STEM);
  return capStem(words(symbol, true), nameCase === "snake" ? "_" : "-");
}

const GENERIC_HEADING_WORDS = new Set([
  "a", "an", "the", "code", "example", "examples", "usage", "full", "complete", "final", "solution",
  "implementation", "snippet", "source", "file", "here", "is", "your", "updated", "script", "program",
  "demo", "output", "result", "answer",
]);

function headingStem(headingHint: string | undefined): string {
  const parts = words((headingHint ?? "").replace(/[*_`~]/g, ""));
  return parts.some((part) => !GENERIC_HEADING_WORDS.has(part)) ? capStem(parts, "-") : "";
}

function hasFileShape(name: string): boolean {
  return /^[A-Za-z0-9]/.test(name) && (extensionOf(name) !== "" || EXTENSIONLESS_NAMES.has(name.toLowerCase()));
}

function safeExplicitName(filename: string): string {
  const cleaned = basename(filename).replace(/[^A-Za-z0-9._-]+/g, "").replace(/^[.-]+/, "");
  if (!hasFileShape(cleaned)) return "";
  if (cleaned.length <= MAX_STEM + 8) return cleaned;
  return `${cleaned.slice(0, MAX_STEM).replace(/[.-]+$/, "")}.${extensionOf(cleaned)}`;
}

function explicitName(code: string, info: string | undefined): string {
  const fromInfo = info ? parseFenceInfo(info).filename : null;
  if (fromInfo) {
    // An unsafe info filename is dropped, not salvaged into a near miss.
    return /\s/.test(fromInfo) ? "" : safeExplicitName(fromInfo);
  }
  const fromComment = commentFilename(code);
  return fromComment ? safeExplicitName(fromComment) : "";
}

function titleStem(code: string, key: string): string {
  const title = documentTitle(code, key);
  return title ? capStem(words(title), "-") : "";
}

/** React components keep PascalCase; everything else follows the language. */
function symbolCase(key: string, symbol: string, langSpec: LanguageSpec): NameCase {
  if ((key === "jsx" || key === "tsx") && /^[A-Z]/.test(symbol)) return "pascal";
  return langSpec.nameCase;
}

function contentStem(code: string, key: string, langSpec: LanguageSpec | undefined, headingHint?: string): string {
  const symbol = langSpec ? primarySymbol(code, langSpec) : null;
  const fromSymbol = symbol && langSpec ? symbolStem(symbol, symbolCase(key, symbol, langSpec)) : "";
  return titleStem(code, key) || fromSymbol || headingStem(headingHint);
}

function fallbackName(language: string, ext: string): string {
  return `aperture-${words(language).join("-") || "code"}-snippet.${ext}`;
}

/** A meaningful download name for a code block: an explicit fence or comment
 * file name, else the document title, the primary symbol in the language's
 * file-naming convention, the nearest heading, or `aperture-<lang>-snippet`. */
export function codeArtifactFilename(input: {
  code: string;
  language: string;
  info?: string;
  headingHint?: string;
}): string {
  const explicit = explicitName(input.code, input.info);
  if (explicit) return explicit;
  const key = languageKey(parseFenceInfo(input.info ?? input.language).language || input.language);
  const langSpec = LANGUAGES[key];
  if (langSpec?.fixedName) return langSpec.fixedName;
  const ext = langSpec?.ext ?? "txt";
  const stem = contentStem(input.code, key, langSpec, input.headingHint);
  return stem ? `${stem}.${ext}` : fallbackName(input.language, ext);
}

const MIME_TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  svg: "image/svg+xml",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  json: "application/json",
  xml: "application/xml",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
};

export function codeArtifactMimeType(filename: string): string {
  return `${MIME_TYPES[extensionOf(filename)] ?? "text/plain"};charset=utf-8`;
}

/** Display language for a fence: `js:server.js` shows "js", ```main.py``` "py". */
export function codeArtifactLanguage(language: string, info?: string): string {
  return parseFenceInfo(info ?? language).language || language;
}

/* ------------------------------------------------------------------ */
/* Live preview documents (sandboxed iframe srcDoc)                    */
/* ------------------------------------------------------------------ */

const PREVIEWABLE_HTML_LANGUAGES = new Set(["html", "htm", "xhtml"]);

function isFullHtmlDocument(trimmed: string): boolean {
  return /^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed);
}

export function buildCodePreview(code: string, language: string): CodePreview {
  const normalizedLanguage = language.trim().toLowerCase();
  const trimmed = code.trim();
  if (PREVIEWABLE_HTML_LANGUAGES.has(normalizedLanguage) || isFullHtmlDocument(trimmed)) {
    return { label: "HTML", srcDoc: htmlPreviewDocument(code) };
  }
  if (normalizedLanguage === "svg" || /^<svg[\s>]/i.test(trimmed)) {
    return { label: "SVG", srcDoc: svgPreviewDocument(code) };
  }
  if (normalizedLanguage === "css") {
    return { label: "CSS sample", srcDoc: cssPreviewDocument(code) };
  }
  return { label: "Source", srcDoc: null };
}

function htmlPreviewDocument(code: string) {
  if (isFullHtmlDocument(code.trim())) return code;
  return `<!doctype html>
<html>
<head>
  <base target="_blank">
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
${code}
</body>
</html>`;
}

function svgPreviewDocument(code: string) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    html, body { margin: 0; min-height: 100%; background: #f6f8f9; }
    body { display: grid; place-items: center; padding: 24px; box-sizing: border-box; }
    svg { max-width: 100%; max-height: calc(100vh - 48px); }
  </style>
</head>
<body>
${code}
</body>
</html>`;
}

function cssPreviewDocument(code: string) {
  return `<!doctype html>
<html>
<head>
  <base target="_blank">
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${code}</style>
</head>
<body>
  <main class="preview-sample">
    <h1>Preview sample</h1>
    <p>Use this sample surface to inspect the stylesheet.</p>
    <button type="button">Primary action</button>
  </main>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* Collecting artifacts from replies                                   */
/* ------------------------------------------------------------------ */

function isArtifactBlock(language: string, text: string): boolean {
  return !language.trim().toLowerCase().startsWith("hermes-") && resolveDiagramBlock(language, text) === null;
}

/** For each block, the text of the nearest heading above it: the naming
 * hint for that block's download. */
export function precedingHeadings(blocks: MarkdownBlock[]): Array<string | undefined> {
  let heading: string | undefined;
  return blocks.map((block) => {
    const hint = heading;
    if (block.kind === "heading") heading = block.text;
    return hint;
  });
}

/** Every non-diagram code fence in a reply, in order, with the nearest
 * preceding heading as its naming hint. */
export function codeArtifactsFromMarkdown(content: string, keyPrefix: string): CodeArtifact[] {
  const blocks = parseMarkdownBlocks(content);
  const hints = precedingHeadings(blocks);
  const artifacts: CodeArtifact[] = [];
  blocks.forEach((block, index) => {
    if (block.kind !== "code" || !isArtifactBlock(block.language, block.text)) return;
    artifacts.push({
      key: `${keyPrefix}:${artifacts.length}`,
      code: block.text,
      language: codeArtifactLanguage(block.language, block.info),
      filename: codeArtifactFilename({ code: block.text, language: block.language, info: block.info, headingHint: hints[index] }),
      lineCount: block.text.split("\n").length,
    });
  });
  return artifacts;
}

/** True while the text ends inside an unclosed fence (a block still streaming). */
export function hasOpenCodeFence(content: string): boolean {
  // Markers are runs of one character, so a closer is any bare run that
  // starts with the opener (same character, at least as long).
  let open: string | null = null;
  for (const line of content.split("\n")) {
    const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    if (open === null) open = match[1]!;
    else if (match[1]!.startsWith(open) && match[2]!.trim() === "") open = null;
  }
  return open !== null;
}
