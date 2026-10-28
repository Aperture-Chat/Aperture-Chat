/**
 * Syntax highlighting for code blocks, as per-line tokens.
 *
 * highlight.js returns escaped HTML. Instead of injecting that markup, it is
 * read back into plain-text tokens tagged with their highlight.js scope, so
 * React renders every character as text and a token that spans lines (a block
 * comment, a template string) still lands on the right numbered line.
 */
import { useEffect, useMemo, useState } from "react";
import type { HLJSApi } from "highlight.js";

export type CodeHighlighter = HLJSApi;
/** A run of characters and the highlight.js class that colors it, if any. */
export type CodeToken = { text: string; scope?: string };
export type HighlightedLine = CodeToken[];

/** Past this size a block renders plain: coloring it would stall the page. */
const MAX_HIGHLIGHT_CHARS = 200_000;
/** Detection runs every language over the source, so it gets a tighter cap. */
const MAX_DETECT_CHARS = 20_000;
/** Untagged fences are matched against the languages chat answers use most;
 * the full set mistakes short Python for CSS. Prose scores 2 or less. */
const DETECT_LANGUAGES = [
  "python", "javascript", "typescript", "java", "csharp", "cpp", "go", "rust",
  "ruby", "php", "bash", "sql", "json", "yaml", "xml", "css",
];
const MIN_DETECT_RELEVANCE = 4;

const PLAIN_TAGS = new Set(["text", "txt", "plain", "plaintext", "output", "log", "none", "nohighlight"]);

let engine: CodeHighlighter | null = null;
let loading: Promise<CodeHighlighter> | null = null;

export function loadCodeHighlighter(): Promise<CodeHighlighter> {
  loading ??= import("./codeHighlightEngine").then((module) => {
    engine = module.default;
    return engine;
  });
  return loading;
}

/** The highlighter, once a block has loaded it; null before then. */
export function readyCodeHighlighter(): CodeHighlighter | null {
  return engine;
}

function grammarFor(hljs: CodeHighlighter, language: string): string | null {
  const tag = language.trim().toLowerCase().replace(/^language-/, "");
  if (!tag || PLAIN_TAGS.has(tag)) return null;
  return hljs.getLanguage(tag) ? tag : null;
}

function highlightedHtml(hljs: CodeHighlighter, code: string, language: string): string | null {
  if (!language.trim()) {
    if (code.length > MAX_DETECT_CHARS) return null;
    const detected = hljs.highlightAuto(code, DETECT_LANGUAGES);
    return detected.language && detected.relevance >= MIN_DETECT_RELEVANCE ? detected.value : null;
  }
  const grammar = grammarFor(hljs, language);
  // Model-written code often has a slip (JSON with a bare key); color the
  // rest of it rather than dropping the whole block to plain text.
  return grammar ? hljs.highlight(code, { language: grammar, ignoreIllegals: true }).value : null;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#x27);/g, (entity) => ENTITIES[entity]!);
}

/** highlight.js emits only `<span class="…">`, `</span>`, and escaped text,
 * so a scanner over those three shapes reads its output exactly. */
function tokensToLines(html: string): HighlightedLine[] {
  const lines: HighlightedLine[] = [[]];
  const scopes: string[] = [];
  for (const match of html.matchAll(/<span class="([^"]*)">|<\/span>|[^<]+/g)) {
    const [whole, openedScope] = match;
    if (openedScope !== undefined) scopes.push(openedScope);
    else if (whole === "</span>") scopes.pop();
    else {
      const scope = scopes.at(-1);
      decodeEntities(whole).split("\n").forEach((text, index) => {
        if (index > 0) lines.push([]);
        if (text) lines.at(-1)!.push({ text, scope });
      });
    }
  }
  return lines;
}

/** Token lines for `code`, or null when it should render as plain text: no
 * known language, a plain-text fence, or a source too large to color. */
export function highlightCodeLines(hljs: CodeHighlighter, code: string, language: string): HighlightedLine[] | null {
  if (code.length > MAX_HIGHLIGHT_CHARS) return null;
  const html = highlightedHtml(hljs, code, language);
  return html === null ? null : tokensToLines(html);
}

/** Highlighted lines for a block, loading the highlighter on first use. Until
 * it arrives (or when the block stays plain) this returns null. */
export function useCodeHighlight(code: string, language: string | undefined): HighlightedLine[] | null {
  const [hljs, setHljs] = useState(readyCodeHighlighter);
  useEffect(() => {
    // A failed load leaves the code plain; there is nothing else to show.
    if (!hljs) loadCodeHighlighter().then((loaded) => setHljs(() => loaded), () => undefined);
  }, [hljs]);
  return useMemo(
    () => (hljs && language !== undefined ? highlightCodeLines(hljs, code, language) : null),
    [hljs, code, language],
  );
}
