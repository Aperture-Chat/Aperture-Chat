import katex from "katex";
import "katex/dist/katex.min.css";
import { Check, Code2, Copy, Download, Eye, LoaderCircle, Pencil, TriangleAlert, Workflow, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { copyCodeToClipboard, triggerBlobDownload } from "../lib/clipboard";
import {
  imageFallbackUrl,
  imageUrlWithFallback,
  isDedicatedStewardDiagramLanguage,
  isVisualDiagramBlock,
  isStewardDiagramBlock,
  mermaidDiagramSource,
  parseMarkdownBlocks,
} from "../lib/markdown";
import { diagramTypeLabel, renderMermaidSvgResult, svgToPngBlob } from "../lib/mermaidRender";
import { renderMermaidFallbackSvg } from "../lib/mermaidFallback";
import { DiagramEditorModal } from "./DiagramEditorModal";
import { StewardDiagramFigure } from "./StewardDiagram";
import { StableLabel } from "./Primitives";

const GENERATED_IMAGE_PREFIX = "/api/chat/generated-images/";
const PREVIEWABLE_HTML_LANGUAGES = new Set(["html", "htm"]);
const PREVIEW_PAGE_BUDGET = 2300;

type MarkdownBlock = ReturnType<typeof parseMarkdownBlocks>[number];

/** Keep hover previews honest and cheap: render complete Markdown blocks up
 * to roughly one reading page instead of mounting a long answer behind a CSS
 * clip. Visuals carry extra weight so a chart-heavy reply cannot initialize
 * every off-page image or Mermaid diagram. */
function previewPageBlocks(blocks: MarkdownBlock[]) {
  const visible: MarkdownBlock[] = [];
  let budgetUsed = 0;

  for (const block of blocks) {
    const weight = previewBlockWeight(block);
    if (visible.length > 0 && budgetUsed + weight > PREVIEW_PAGE_BUDGET) break;
    visible.push(block);
    budgetUsed += weight;
  }
  return visible;
}

function previewBlockWeight(block: MarkdownBlock) {
  switch (block.kind) {
    case "image":
      return 720;
    case "code":
      return isStewardDiagramBlock(block.language, block.text) ||
        isVisualDiagramBlock(block.language, block.text)
        ? 760
        : Math.min(block.text.length, 900);
    case "table":
      return 520 + block.headers.join(" ").length + block.rows.flat().join(" ").length;
    case "heading":
      return 60 + block.text.length;
    case "list":
      return 80 + block.items.join(" ").length;
    case "quote":
    case "paragraph":
      return block.lines.join(" ").length;
    case "math":
      return 160 + block.math.length;
    case "rule":
      return 40;
    default:
      return 120;
  }
}

function renderInline(text: string, preview = false): ReactNode[] {
  const nodes: ReactNode[] = [];
  // \(…\) is the only inline math delimiter — single-dollar text such as $5M
  // is finance prose and must never be parsed as math. [K#]/[U#] citation
  // tokens sit after the link alternative so a real [K1](url) link still wins.
  const regex =
    /(!\[([^\]]*)\]\((https?:\/\/[^)\s]+|\/api\/[^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/api\/[^)\s]+)\)|\\\((.+?)\\\)|\[(K[1-9][0-9]?|U[1-9])\]|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*|_([^_]+)_)/g;
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(<Fragment key={key++}>{text.slice(lastIndex, match.index)}</Fragment>);
    }
    if (match[3] !== undefined) {
      nodes.push(<InlineImage alt={match[2] ?? ""} key={`${key++}-${match[3]}`} url={match[3]} />);
    } else if (match[4] !== undefined) {
      nodes.push(
        preview ? (
          <span key={key++} className="md-link">{match[4]}</span>
        ) : (
          <a key={key++} className="md-link" href={match[5]} rel="noreferrer" target="_blank">
            {match[4]}
          </a>
        ),
      );
    } else if (match[6] !== undefined) {
      nodes.push(<InlineMath key={key++} math={match[6]} source={match[0]} />);
    } else if (match[7] !== undefined) {
      nodes.push(
        <sup
          key={key++}
          className="md-cite-marker"
          data-cite-index={match[7]}
          title={`Source ${match[7]}`}
        >
          {match[7]}
        </sup>,
      );
    } else if (match[8] !== undefined) nodes.push(<strong key={key++}>{match[8]}</strong>);
    else if (match[9] !== undefined) nodes.push(<code key={key++}>{match[9]}</code>);
    else if (match[10] !== undefined) nodes.push(<em key={key++}>{match[10]}</em>);
    else if (match[11] !== undefined) nodes.push(<em key={key++}>{match[11]}</em>);
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    nodes.push(<Fragment key={key++}>{text.slice(lastIndex)}</Fragment>);
  }
  return nodes;
}

/** KaTeX HTML for an expression, or null when it does not parse — callers
 * must fall back to the original source text, never an empty node. */
function renderKatexHtml(math: string, displayMode: boolean): string | null {
  try {
    return katex.renderToString(math, { displayMode, throwOnError: true });
  } catch {
    return null;
  }
}

function InlineMath({ math, source }: { math: string; source: string }) {
  const html = useMemo(() => renderKatexHtml(math, false), [math]);
  if (html === null) return <Fragment>{source}</Fragment>;
  return <span className="md-katex md-katex-inline" dangerouslySetInnerHTML={{ __html: html }} />;
}

function MathBlock({ math, source }: { math: string; source: string }) {
  const html = useMemo(() => renderKatexHtml(math, true), [math]);
  if (html === null) {
    return <p className="md-paragraph md-katex-source">{source}</p>;
  }
  return <div className="md-katex md-katex-block" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Markdown({
  content,
  deferDiagrams = false,
  onUpdateDiagram,
  preview = false,
  previewPageLimit = true,
}: {
  content: string;
  deferDiagrams?: boolean;
  onUpdateDiagram?: (previousSource: string, nextSource: string) => Promise<boolean> | boolean;
  preview?: boolean;
  previewPageLimit?: boolean;
}) {
  const blocks = parseMarkdownBlocks(content);
  const renderedBlocks = preview && previewPageLimit ? previewPageBlocks(blocks) : blocks;
  return (
    <div className="markdown">
      {renderedBlocks.map((block, index) => {
        if (block.kind === "heading") {
          const level = Math.min(block.level + 2, 6);
          const Tag = `h${level}` as "h3" | "h4" | "h5" | "h6";
          return (
            <Tag key={index} className="md-heading">
              {renderInline(block.text, preview)}
            </Tag>
          );
        }
        if (block.kind === "list") {
          if (block.ordered) {
            return (
              <ol key={index} className="md-list md-list-ordered">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{renderInline(item, preview)}</li>
                ))}
              </ol>
            );
          }
          return (
            <ul key={index} className="md-list">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInline(item, preview)}</li>
              ))}
            </ul>
          );
        }
        if (block.kind === "image") {
          return <MarkdownImage alt={block.alt} caption={block.title || block.alt} key={`${index}-${block.url}`} preview={preview} url={block.url} />;
        }
        if (block.kind === "table") {
          return (
            <div className="md-table-scroller" key={index}>
              <table className="md-table">
                <thead>
                  <tr>
                    {block.headers.map((header, cellIndex) => (
                      <th
                        key={cellIndex}
                        style={block.aligns[cellIndex] ? { textAlign: block.aligns[cellIndex]! } : undefined}
                      >
                        {renderInline(header, preview)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {block.headers.map((_, cellIndex) => (
                        <td
                          key={cellIndex}
                          style={block.aligns[cellIndex] ? { textAlign: block.aligns[cellIndex]! } : undefined}
                        >
                          {renderInline(row[cellIndex] ?? "", preview)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.kind === "rule") {
          return <hr key={index} className="md-rule" />;
        }
        if (block.kind === "code") {
          const language = block.language.trim().toLowerCase();
          if (language.startsWith("hermes-")) {
            return (
              <HermesArtifactCard key={index} kind={language.slice("hermes-".length)} text={block.text} />
            );
          }
          // Steward structure diagrams: JSON card charts with a dedicated
          // renderer and card-level editor. The fallback is the honest code
          // block so an invalid source never pretends to be a diagram.
          if (isStewardDiagramBlock(block.language, block.text)) {
            return (
              <StewardDiagramFigure
                fallback={<MarkdownCodeBlock language="json" preview={preview} text={block.text} />}
                forceVisual={isDedicatedStewardDiagramLanguage(block.language)}
                key={index}
                onUpdate={onUpdateDiagram}
                preview={preview}
                source={block.text}
              />
            );
          }
          // Diagram fences always mount as a visual figure. Mermaid, type
          // tags (` ```timeline `), untagged grammar, Graphviz, and PlantUML
          // all count. The fallback SVG is synchronous so a failed or slow
          // mermaid.js draw never leaves a Copy/Preview/Edit code panel.
          if (isVisualDiagramBlock(block.language, block.text)) {
            return (
              <MermaidDiagram
                defer={deferDiagrams}
                key={index}
                onUpdate={onUpdateDiagram}
                preview={preview}
                source={mermaidDiagramSource(block.text, block.language)}
              />
            );
          }
          return <MarkdownCodeBlock key={index} language={block.language} preview={preview} text={block.text} />;
        }
        if (block.kind === "math") {
          return <MathBlock key={index} math={block.math} source={block.source} />;
        }
        if (block.kind === "quote") {
          return (
            <blockquote key={index} className="md-quote">
              {block.lines.map((line, lineIndex) => (
                <Fragment key={lineIndex}>
                  {lineIndex > 0 && <br />}
                  {renderInline(line, preview)}
                </Fragment>
              ))}
            </blockquote>
          );
        }
        return (
          <p key={index} className="md-paragraph">
            {block.lines.map((line, lineIndex) => (
              <Fragment key={lineIndex}>
                {lineIndex > 0 && <br />}
                {renderInline(line, preview)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

const HERMES_ARTIFACT_LABELS: Record<string, string> = {
  memory: "Hermes memory saved for this agent profile",
  skill: "Hermes skill saved to the workspace skill library",
  automation: "Hermes automation proposed — review and enable it under Agents · Automations",
};

/** The API captures hermes-* fenced blocks into real stored records; the chat
 * surface renders the same block as an honest card instead of raw code. */
function HermesArtifactCard({ kind, text }: { kind: string; text: string }) {
  const label = HERMES_ARTIFACT_LABELS[kind] ?? "Hermes artifact";
  return (
    <aside className={`hermes-artifact is-${kind}`}>
      <strong>{label}</strong>
      <pre>{text}</pre>
    </aside>
  );
}

function MarkdownCodeBlock({ language, preview = false, text }: { language: string; preview?: boolean; text: string }) {
  const [code, setCode] = useState(text);
  const [editing, setEditing] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [previewOpen, setPreviewOpen] = useState(false);
  const lines = useMemo(() => code.split("\n"), [code]);
  const lineCount = Math.max(lines.length, 1);
  const displayLanguage = language.trim() || "code";

  async function copyCode() {
    try {
      await copyCodeToClipboard(code);
      setCopyStatus("copied");
      window.setTimeout(() => {
        setCopyStatus((current) => (current === "copied" ? "idle" : current));
      }, 1600);
    } catch {
      setCopyStatus("failed");
      window.setTimeout(() => {
        setCopyStatus((current) => (current === "failed" ? "idle" : current));
      }, 2200);
    }
  }

  return (
    <figure className={`md-code-panel${editing ? " is-editing" : ""}`}>
      <figcaption className="md-code-toolbar">
        <span className="md-code-toolbar-main">
          <Code2 size={15} />
          <strong>{displayLanguage}</strong>
          <span>{lineCountLabel(lineCount)}</span>
        </span>
        {!preview && <span className="md-code-actions">
          <button
            className="md-code-action"
            type="button"
            data-tooltip="Copy this code block"
            onClick={() => void copyCode()}
          >
            {copyStatus === "copied" ? <Check size={14} /> : <Copy size={14} />}
            <StableLabel
              label={copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Failed" : "Copy"}
              reserve={["Copied", "Failed", "Copy"]}
            />
          </button>
          <button
            className="md-code-action"
            type="button"
            data-tooltip="Open this code in an artifact preview"
            onClick={() => setPreviewOpen(true)}
          >
            <Eye size={14} />
            Preview
          </button>
          <button
            className="md-code-action"
            type="button"
            data-tooltip={editing ? "Return to the numbered code view" : "Edit this code inline"}
            onClick={() => setEditing((current) => !current)}
          >
            {editing ? <Check size={14} /> : <Pencil size={14} />}
            {editing ? "Done" : "Edit"}
          </button>
        </span>}
      </figcaption>

      {editing ? (
        <div className="md-code-editor-shell">
          <div className="md-code-editor-gutter" aria-hidden="true">
            {lines.map((_, lineIndex) => (
              <span key={lineIndex}>{lineIndex + 1}</span>
            ))}
          </div>
          <textarea
            aria-label={`Editable ${displayLanguage} code`}
            className="md-code-editor"
            spellCheck={false}
            rows={Math.max(lineCount, 4)}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
      ) : (
        <CodeLines lines={lines} preview={preview} />
      )}

      {previewOpen && (
        <CodePreviewModal
          code={code}
          copyStatus={copyStatus}
          language={displayLanguage}
          lineCount={lineCount}
          onClose={() => setPreviewOpen(false)}
          onCopy={() => void copyCode()}
        />
      )}
    </figure>
  );
}

function CodePreviewModal({
  code,
  copyStatus,
  language,
  lineCount,
  onClose,
  onCopy,
}: {
  code: string;
  copyStatus: "idle" | "copied" | "failed";
  language: string;
  lineCount: number;
  onClose: () => void;
  onCopy: () => void;
}) {
  const preview = useMemo(() => buildCodePreview(code, language), [code, language]);
  return (
    <div className="modal-backdrop code-preview-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal code-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Artifact preview"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-icon">
            <Eye size={20} />
          </span>
          <div>
            <h2>Artifact preview</h2>
            <p>
              {language} · {lineCountLabel(lineCount)} · {preview.label}
            </p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close artifact preview"
            data-tooltip="Close preview"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>
        <div className="modal-body code-preview-body">
          {preview.srcDoc ? (
            <iframe
              className="code-preview-frame"
              sandbox="allow-scripts"
              srcDoc={preview.srcDoc}
              title={`${language} artifact preview`}
            />
          ) : (
            <pre className="code-preview-source">
              <code>{code}</code>
            </pre>
          )}
        </div>
        <div className="modal-actions">
          <button className="secondary-button compact" type="button" data-tooltip="Copy this code" onClick={onCopy}>
            {copyStatus === "copied" ? <Check size={14} /> : <Copy size={14} />}
            {copyStatus === "copied" ? "Copied" : "Copy"}
          </button>
          <button className="primary-button compact" type="button" onClick={onClose}>
            Done
          </button>
        </div>
      </section>
    </div>
  );
}

function CodeLines({ lines, preview = false }: { lines: string[]; preview?: boolean }) {
  return (
    <pre className="md-code-block" tabIndex={preview ? undefined : 0}>
      <code className="md-code-lines">
        {lines.map((line, lineIndex) => (
          <span className="md-code-line" key={lineIndex}>
            <span className="md-code-line-number" aria-hidden="true">
              {lineIndex + 1}
            </span>
            <span className="md-code-line-text">{line}</span>
          </span>
        ))}
      </code>
    </pre>
  );
}

function isDarkTheme() {
  return document.documentElement.classList.contains("theme-dark");
}

function MermaidDiagram({
  defer = false,
  onUpdate,
  preview = false,
  source,
}: {
  defer?: boolean;
  onUpdate?: (previousSource: string, nextSource: string) => Promise<boolean> | boolean;
  preview?: boolean;
  source: string;
}) {
  const deferredRef = useRef<HTMLElement | null>(null);
  const [shouldRender, setShouldRender] = useState(!defer);
  const [dark, setDark] = useState(isDarkTheme);
  const fallbackSvg = useMemo(() => renderMermaidFallbackSvg(source, dark), [source, dark]);
  const [mermaidSvg, setMermaidSvg] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(true);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [pngStatus, setPngStatus] = useState<"idle" | "failed">("idle");
  const [editing, setEditing] = useState(false);
  const svg = mermaidSvg ?? fallbackSvg;
  const typeLabel = diagramTypeLabel(source);

  useEffect(() => {
    if (!defer || shouldRender) return;
    const node = deferredRef.current;
    if (!node || typeof IntersectionObserver !== "function") {
      setShouldRender(true);
      return;
    }
    const root = node.closest<HTMLElement>(".chat-hover-preview-scroll");
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setShouldRender(true);
        observer.disconnect();
      },
      { root, rootMargin: "180px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [defer, shouldRender]);

  useEffect(() => {
    const observer = new MutationObserver(() => setDark(isDarkTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  // Fallback SVG is synchronous so the figure is a visual on the first paint.
  // mermaid.js may replace it; a hang or throw keeps the fallback. Code view
  // is opt-in and this figure is never swapped for a code panel.
  useEffect(() => {
    if (!shouldRender) return;
    let cancelled = false;
    setMermaidSvg(null);
    setWaiting(true);
    setRenderError(null);
    const timer = window.setTimeout(() => {
      void (async () => {
        const rendered = await renderMermaidSvgResult(source, dark);
        if (cancelled) return;
        setWaiting(false);
        if (rendered.svg) {
          setMermaidSvg(rendered.svg);
          setRenderError(null);
        } else {
          setRenderError(rendered.error);
        }
      })();
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, dark, shouldRender]);

  async function copySource() {
    try {
      await copyCodeToClipboard(source);
      setCopyStatus("copied");
      window.setTimeout(() => {
        setCopyStatus((current) => (current === "copied" ? "idle" : current));
      }, 1600);
    } catch {
      setCopyStatus("failed");
      window.setTimeout(() => {
        setCopyStatus((current) => (current === "failed" ? "idle" : current));
      }, 2200);
    }
  }

  async function downloadPng() {
    if (!svg) return;
    try {
      const blob = await svgToPngBlob(svg, dark);
      triggerBlobDownload(blob, `aperture-${typeLabel}-diagram.png`);
    } catch {
      setPngStatus("failed");
      window.setTimeout(() => setPngStatus("idle"), 2200);
    }
  }

  function downloadSvg() {
    if (!svg) return;
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    triggerBlobDownload(blob, `aperture-${typeLabel}-diagram.svg`);
  }

  if (!shouldRender) {
    return (
      <figure className="md-diagram-panel is-deferred" data-diagram-type={typeLabel} ref={deferredRef}>
        <div className="md-diagram-loading">Diagram loads as you scroll</div>
      </figure>
    );
  }
  if (!svg && waiting) {
    return (
      <figure className="md-diagram-panel is-loading" data-diagram-type={typeLabel}>
        <div className="md-diagram-loading">
          <LoaderCircle className="is-spinning" size={14} />
          <span>Rendering diagram…</span>
        </div>
      </figure>
    );
  }
  return (
    <figure className="md-diagram-panel" data-diagram-type={typeLabel}>
      <figcaption className="md-code-toolbar">
        <span className="md-code-toolbar-main">
          <Workflow size={15} />
          <strong>{typeLabel}</strong>
          <span>diagram</span>
        </span>
        {!preview && <span className="md-code-actions">
          <button
            className="md-code-action"
            type="button"
            data-tooltip="Copy the diagram source"
            onClick={() => void copySource()}
          >
            {copyStatus === "copied" ? <Check size={14} /> : <Copy size={14} />}
            <StableLabel
              label={copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Failed" : "Copy"}
              reserve={["Copied", "Failed", "Copy"]}
            />
          </button>
          {svg && (
            <>
              <button
                className="md-code-action"
                type="button"
                data-tooltip="Download the diagram as a PNG image"
                onClick={() => void downloadPng()}
              >
                <Download size={14} />
                <StableLabel label={pngStatus === "failed" ? "Failed" : "PNG"} reserve={["Failed", "PNG"]} />
              </button>
              <button
                className="md-code-action"
                type="button"
                data-tooltip="Download the diagram as an SVG file"
                onClick={downloadSvg}
              >
                <Download size={14} />
                SVG
              </button>
            </>
          )}
          <button
            className="md-code-action"
            type="button"
            data-tooltip={showSource ? "Return to the rendered diagram" : "View the diagram source"}
            onClick={() => setShowSource((current) => !current)}
          >
            {showSource ? <Eye size={14} /> : <Code2 size={14} />}
            {showSource ? "Diagram" : "Code"}
          </button>
          {onUpdate && (
            <button
              className="md-code-action"
              type="button"
              data-tooltip="Edit the boxes and text in this diagram"
              onClick={() => setEditing(true)}
            >
              <Pencil size={14} />
              Edit
            </button>
          )}
        </span>}
      </figcaption>
      {editing && onUpdate && (
        <DiagramEditorModal
          source={source}
          onClose={() => setEditing(false)}
          onSave={(nextSource) => onUpdate(source, nextSource)}
        />
      )}
      {showSource ? (
        <CodeLines lines={source.split("\n")} preview={preview} />
      ) : svg ? (
        <div className="md-diagram-canvas" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <p className="md-diagram-notice">
          <TriangleAlert size={13} />
          <span>
            {renderError || "This diagram could not be rendered."} Open Code to inspect the source
            {onUpdate ? ", or Edit to fix it" : ""}.
          </span>
        </p>
      )}
    </figure>
  );
}


function InlineImage({ alt, url }: { alt: string; url: string }) {
  const [src, setSrc] = useState(() => imageUrlWithFallback(url, alt));
  const [broken, setBroken] = useState(false);
  // React reuses this component instance when the message content is swapped
  // in place (e.g. flipping between regenerated response versions), so the
  // pinned src must follow the incoming URL or the old image stays on screen.
  useEffect(() => {
    setSrc(imageUrlWithFallback(url, alt));
    setBroken(false);
  }, [alt, url]);
  // A dead image URL renders nothing at all: an empty "unavailable" box is
  // still a missing image to the reader, so the reply simply flows without it.
  if (broken) return null;
  return (
    <img
      className="md-inline-image"
      src={src}
      alt={alt || "Assistant image"}
      loading="lazy"
      onError={() => {
        const fallback = imageFallbackUrl(src, alt);
        if (fallback && fallback !== src) setSrc(fallback);
        else setBroken(true);
      }}
    />
  );
}

function MarkdownImage({ alt, caption, preview = false, url }: { alt: string; caption?: string; preview?: boolean; url: string }) {
  const [src, setSrc] = useState(() => imageUrlWithFallback(url, alt));
  const [broken, setBroken] = useState(false);
  // Same in-place reuse as InlineImage: response-version flips change the URL
  // without remounting, so the pinned src must re-sync with the prop.
  useEffect(() => {
    setSrc(imageUrlWithFallback(url, alt));
    setBroken(false);
  }, [alt, url]);
  const downloadable = url.startsWith(GENERATED_IMAGE_PREFIX);
  // A dead image URL renders nothing at all: an empty "unavailable" figure is
  // still a missing image to the reader, so the reply simply flows without it.
  if (broken) return null;
  return (
    <figure className="md-figure">
      <img
        className="md-image"
        src={src}
        alt={alt || caption || "Assistant image"}
        loading="lazy"
        onError={() => {
          const fallback = imageFallbackUrl(src, alt);
          if (fallback && fallback !== src) setSrc(fallback);
          else setBroken(true);
        }}
      />
      {(caption || downloadable) && (
        <figcaption>
          {caption && <span className="md-figure-caption">{caption}</span>}
          {downloadable && !preview && (
            <a
              className="md-image-download"
              href={`${url}${url.includes("?") ? "&" : "?"}download=1`}
              download
              aria-label={`Download ${alt || caption || "generated image"}`}
              data-tooltip="Download this image as a file"
            >
              <Download size={14} />
              <span>Download</span>
            </a>
          )}
        </figcaption>
      )}
    </figure>
  );
}


function lineCountLabel(lineCount: number) {
  return `${lineCount.toLocaleString()} line${lineCount === 1 ? "" : "s"}`;
}

function buildCodePreview(code: string, language: string): { label: string; srcDoc: string | null } {
  const normalizedLanguage = language.toLowerCase();
  const trimmed = code.trim();
  if (PREVIEWABLE_HTML_LANGUAGES.has(normalizedLanguage) || /^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
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
  const trimmed = code.trim();
  if (/^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) return code;
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
