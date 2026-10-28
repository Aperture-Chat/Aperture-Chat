import { Check, Code2, Copy, Download, Eye, LoaderCircle, Network, Palette, Pencil, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { copyCodeToClipboard, triggerBlobDownload } from "../lib/clipboard";
import { svgToPngBlob } from "../lib/mermaidRender";
import {
  parseStewardDiagram,
  parseStewardDiagramTruncated,
  parseStructuredSummaryDiagram,
  renderStewardDiagramSvg,
  serializeStewardDiagram,
  type StewardDiagramModel,
} from "../lib/stewardDiagram";
import { StewardDiagramCanvas } from "./StewardDiagramCanvas";
import { StewardDiagramEditorModal } from "./StewardDiagramEditorModal";
import { StewardDiagramStyleTray } from "./StewardDiagramStyleTray";
import { StableLabel } from "./Primitives";

type CopyStatus = "idle" | "copied" | "failed";
type UpdateDiagram = (previousSource: string, nextSource: string) => Promise<boolean> | boolean;

function isDarkTheme() {
  return document.documentElement.classList.contains("theme-dark");
}

function useDarkTheme() {
  const [dark, setDark] = useState(isDarkTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(isDarkTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/** The chart a fence describes: native structure JSON/YAML, a structured
 * summary, or — once a source has stayed unparseable past the streaming
 * window — whatever a cut-off reply salvages. */
function useStructureModel(source: string) {
  const [exhausted, setExhausted] = useState(false);
  const exhaustTimer = useRef<number | null>(null);
  const nativeModel = useMemo(() => parseStewardDiagram(source), [source]);
  const summaryModel = useMemo(() => (nativeModel ? null : parseStructuredSummaryDiagram(source)), [nativeModel, source]);
  const strictModel = nativeModel ?? summaryModel;
  // A reply cut off mid-diagram (provider token limit) still carries most of
  // the chart; render the salvageable part behind an explicit notice instead
  // of dumping raw JSON on the reader. Recovery waits for the exhaustion
  // window so a still-streaming fence never flashes a partial chart.
  const recoveredModel = useMemo(
    () => (strictModel || !exhausted ? null : parseStewardDiagramTruncated(source)),
    [strictModel, exhausted, source],
  );

  // Mid-stream JSON is invalid until the fence completes; only a source that
  // stays unparseable becomes the code fallback.
  useEffect(() => {
    if (strictModel) {
      setExhausted(false);
      if (exhaustTimer.current !== null) window.clearTimeout(exhaustTimer.current);
      return;
    }
    exhaustTimer.current = window.setTimeout(() => setExhausted(true), 2400);
    return () => {
      if (exhaustTimer.current !== null) window.clearTimeout(exhaustTimer.current);
    };
  }, [strictModel, source]);

  return { model: strictModel ?? recoveredModel, summary: Boolean(summaryModel), recovered: Boolean(recoveredModel), exhausted };
}

function useCopySource(source: string) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  async function copy() {
    try {
      await copyCodeToClipboard(source);
      setStatus("copied");
      window.setTimeout(() => setStatus((current) => (current === "copied" ? "idle" : current)), 1600);
    } catch {
      setStatus("failed");
      window.setTimeout(() => setStatus((current) => (current === "failed" ? "idle" : current)), 2200);
    }
  }
  return { status, copy };
}

const COPY_LABELS: Record<CopyStatus, string> = { idle: "Copy", copied: "Copied", failed: "Failed" };

function CopyKey({ status, onCopy }: { status: CopyStatus; onCopy: () => void }) {
  return (
    <button className="md-code-action" type="button" data-tooltip="Copy the diagram source" onClick={onCopy}>
      {status === "copied" ? <Check size={14} /> : <Copy size={14} />}
      <StableLabel label={COPY_LABELS[status]} reserve={["Copied", "Failed", "Copy"]} />
    </button>
  );
}

/** PNG and SVG exports of the chart as drawn: theme, dragged boxes, bent
 * arrows, connector and corner style included. */
function DownloadKeys({ model, dark }: { model: StewardDiagramModel; dark: boolean }) {
  const [pngFailed, setPngFailed] = useState(false);
  async function downloadPng() {
    try {
      const blob = await svgToPngBlob(renderStewardDiagramSvg(model, dark), dark);
      triggerBlobDownload(blob, "aperture-structure-diagram.png");
    } catch {
      setPngFailed(true);
      window.setTimeout(() => setPngFailed(false), 2200);
    }
  }
  function downloadSvg() {
    const blob = new Blob([renderStewardDiagramSvg(model, dark)], { type: "image/svg+xml;charset=utf-8" });
    triggerBlobDownload(blob, "aperture-structure-diagram.svg");
  }
  return (
    <>
      <button className="md-code-action" type="button" data-tooltip="Download the diagram as a PNG image" onClick={() => void downloadPng()}>
        <Download size={14} />
        <StableLabel label={pngFailed ? "Failed" : "PNG"} reserve={["Failed", "PNG"]} />
      </button>
      <button className="md-code-action" type="button" data-tooltip="Download the diagram as an SVG file" onClick={downloadSvg}>
        <Download size={14} />
        SVG
      </button>
    </>
  );
}

function CodeKey({ showSource, onToggle }: { showSource: boolean; onToggle: () => void }) {
  return (
    <button
      className="md-code-action"
      type="button"
      data-tooltip={showSource ? "Return to the rendered diagram" : "View the diagram source"}
      onClick={onToggle}
    >
      {showSource ? <Eye size={14} /> : <Code2 size={14} />}
      {showSource ? "Diagram" : "Code"}
    </button>
  );
}

function StyleKey({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      className={`md-code-action${open ? " is-on" : ""}`}
      type="button"
      aria-expanded={open}
      data-tooltip={open ? "Hide the style options" : "Change the theme, arrow shape, and corners"}
      onClick={onToggle}
    >
      <Palette size={14} />
      Style
    </button>
  );
}

function EditKey({ onEdit }: { onEdit: () => void }) {
  return (
    <button className="md-code-action" type="button" data-tooltip="Edit the boxes, arrows, and text in this diagram" onClick={onEdit}>
      <Pencil size={14} />
      Edit
    </button>
  );
}

/** Style and Edit appear only where the chart can be saved; Style hides
 * while the source is showing. */
function EditingKeys({
  editable,
  showSource,
  styling,
  onStyle,
  onEdit,
}: {
  editable: boolean;
  showSource: boolean;
  styling: boolean;
  onStyle: () => void;
  onEdit: () => void;
}) {
  if (!editable) return null;
  return (
    <>
      {!showSource && <StyleKey open={styling} onToggle={onStyle} />}
      <EditKey onEdit={onEdit} />
    </>
  );
}

function RepairFigure({ copy }: { copy: ReturnType<typeof useCopySource> | null }) {
  return (
    <figure className="md-diagram-panel is-error" data-diagram-type="structure-error">
      <figcaption className="md-code-toolbar">
        <span className="md-code-toolbar-main">
          <Network size={15} />
          <strong>diagram</strong>
          <span>needs repair</span>
        </span>
        {copy && (
          <span className="md-code-actions">
            <CopyKey status={copy.status} onCopy={() => void copy.copy()} />
          </span>
        )}
      </figcaption>
      <div className="md-diagram-error-visual" role="img" aria-label="Diagram source needs repair">
        <TriangleAlert size={28} />
        <strong>Diagram source needs repair</strong>
        <span>The response was marked as a diagram, but its structure is incomplete.</span>
      </div>
    </figure>
  );
}

function LoadingFigure() {
  return (
    <figure className="md-diagram-panel is-loading">
      <div className="md-diagram-loading">
        <LoaderCircle className="is-spinning" size={14} />
        <span>Rendering diagram…</span>
      </div>
    </figure>
  );
}

function RecoveredNotice() {
  return (
    <p className="md-diagram-notice">
      <TriangleAlert size={13} />
      <span>
        The reply was cut off mid-diagram — showing everything that arrived. Use Edit to finish the chart, or
        regenerate the reply.
      </span>
    </p>
  );
}

/** Chat figure for ```steward-diagram fenced JSON: renders the structured
 * card chart with the same toolbar contract as Mermaid figures (copy, PNG,
 * SVG, code view, edit) plus a Style tray for themes, connectors, and
 * corners. While a streaming reply's JSON is still incomplete the figure
 * shows a loading state; a source that never becomes valid falls back to the
 * plain code view so nothing pretends to work. */
export function StewardDiagramFigure({
  fallback,
  forceVisual = false,
  onUpdate,
  preview = false,
  source,
}: {
  /** Rendered when the source never parses (honest code-block fallback). */
  fallback: React.ReactNode;
  /** Dedicated diagram fences never demote to a Copy/Preview/Edit code panel. */
  forceVisual?: boolean;
  onUpdate?: UpdateDiagram;
  preview?: boolean;
  source: string;
}) {
  const dark = useDarkTheme();
  const { model, summary, recovered, exhausted } = useStructureModel(source);
  const copy = useCopySource(source);

  if (!model && exhausted) return forceVisual ? <RepairFigure copy={preview ? null : copy} /> : <>{fallback}</>;
  if (!model) return <LoadingFigure />;
  return (
    <StructureFigure
      dark={dark}
      model={model}
      summary={summary}
      recovered={recovered}
      copy={copy}
      onUpdate={preview ? undefined : onUpdate}
      preview={preview}
      source={source}
    />
  );
}

function FigureTitle({ summary }: { summary: boolean }) {
  return (
    <span className="md-code-toolbar-main">
      <Network size={15} />
      <strong>{summary ? "summary" : "structure"}</strong>
      <span>{summary ? "visual" : "diagram"}</span>
    </span>
  );
}

/** The chart itself (editable when it can be saved), or its source. */
function FigureBody({
  dark,
  model,
  recovered,
  showSource,
  preview,
  source,
  save,
}: {
  dark: boolean;
  model: StewardDiagramModel;
  recovered: boolean;
  showSource: boolean;
  preview: boolean;
  source: string;
  save?: (next: StewardDiagramModel) => void;
}) {
  if (showSource) {
    return (
      <pre className="md-code-block" tabIndex={preview ? undefined : 0}>
        <code>{source}</code>
      </pre>
    );
  }
  return (
    <>
      {recovered && <RecoveredNotice />}
      <StewardDiagramCanvas dark={dark} model={model} onCommit={save} />
    </>
  );
}

function StructureFigure({
  dark,
  model,
  summary,
  recovered,
  copy,
  onUpdate,
  preview,
  source,
}: {
  dark: boolean;
  model: StewardDiagramModel;
  summary: boolean;
  recovered: boolean;
  copy: ReturnType<typeof useCopySource>;
  onUpdate?: UpdateDiagram;
  preview: boolean;
  source: string;
}) {
  const [showSource, setShowSource] = useState(false);
  const [editing, setEditing] = useState(false);
  const [styling, setStyling] = useState(false);
  const save = onUpdate ? (next: StewardDiagramModel) => void onUpdate(source, serializeStewardDiagram(next)) : undefined;
  const styleOpen = Boolean(save) && styling && !showSource;

  return (
    <figure className="md-diagram-panel" data-diagram-type={summary ? "structured-summary" : "structure"}>
      <figcaption className="md-code-toolbar">
        <FigureTitle summary={summary} />
        {!preview && (
          <span className="md-code-actions">
            <CopyKey status={copy.status} onCopy={() => void copy.copy()} />
            <DownloadKeys model={model} dark={dark} />
            <CodeKey showSource={showSource} onToggle={() => setShowSource((current) => !current)} />
            <EditingKeys
              editable={Boolean(save)}
              showSource={showSource}
              styling={styling}
              onStyle={() => setStyling((current) => !current)}
              onEdit={() => setEditing(true)}
            />
          </span>
        )}
      </figcaption>
      {editing && onUpdate && (
        <StewardDiagramEditorModal
          model={model}
          onClose={() => setEditing(false)}
          onSave={(nextSource) => onUpdate(source, nextSource)}
        />
      )}
      {styleOpen && <StewardDiagramStyleTray model={model} dark={dark} onChange={save!} />}
      <FigureBody dark={dark} model={model} recovered={recovered} showSource={showSource} preview={preview} source={source} save={save} />
    </figure>
  );
}
