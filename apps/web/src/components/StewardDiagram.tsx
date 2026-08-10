import { Check, Code2, Copy, Download, Eye, LoaderCircle, Network, Pencil, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { copyCodeToClipboard, triggerBlobDownload } from "../lib/clipboard";
import { svgToPngBlob } from "../lib/mermaidRender";
import {
  parseStewardDiagram,
  parseStewardDiagramTruncated,
  renderStewardDiagramSvg,
  serializeStewardDiagram,
  type StewardDiagramModel,
} from "../lib/stewardDiagram";
import { StewardDiagramCanvas } from "./StewardDiagramCanvas";
import { StewardDiagramEditorModal } from "./StewardDiagramEditorModal";
import { StableLabel } from "./Primitives";

function isDarkTheme() {
  return document.documentElement.classList.contains("theme-dark");
}

/** Chat figure for ```steward-diagram fenced JSON: renders the structured
 * card chart with the same toolbar contract as Mermaid figures (copy, PNG,
 * SVG, code view, edit). While a streaming reply's JSON is still incomplete
 * the figure shows a loading state; a source that never becomes valid falls
 * back to the plain code view so nothing pretends to work. */
export function StewardDiagramFigure({
  fallback,
  onUpdate,
  preview = false,
  source,
}: {
  /** Rendered when the source never parses (honest code-block fallback). */
  fallback: React.ReactNode;
  onUpdate?: (previousSource: string, nextSource: string) => Promise<boolean> | boolean;
  preview?: boolean;
  source: string;
}) {
  const [dark, setDark] = useState(isDarkTheme);
  const [showSource, setShowSource] = useState(false);
  const [editing, setEditing] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [pngStatus, setPngStatus] = useState<"idle" | "failed">("idle");
  const [exhausted, setExhausted] = useState(false);
  const exhaustTimer = useRef<number | null>(null);

  useEffect(() => {
    const observer = new MutationObserver(() => setDark(isDarkTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  const strictModel = useMemo(() => parseStewardDiagram(source), [source]);
  // A reply cut off mid-diagram (provider token limit) still carries most of
  // the chart; render the salvageable part behind an explicit notice instead
  // of dumping raw JSON on the reader. Recovery waits for the exhaustion
  // window so a still-streaming fence never flashes a partial chart.
  const recoveredModel = useMemo(
    () => (strictModel || !exhausted ? null : parseStewardDiagramTruncated(source)),
    [strictModel, exhausted, source],
  );
  const model = strictModel ?? recoveredModel;

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

  async function copySource() {
    try {
      await copyCodeToClipboard(source);
      setCopyStatus("copied");
      window.setTimeout(() => setCopyStatus((current) => (current === "copied" ? "idle" : current)), 1600);
    } catch {
      setCopyStatus("failed");
      window.setTimeout(() => setCopyStatus((current) => (current === "failed" ? "idle" : current)), 2200);
    }
  }

  async function downloadPng() {
    if (!model) return;
    try {
      const blob = await svgToPngBlob(renderStewardDiagramSvg(model, dark), dark);
      triggerBlobDownload(blob, "aperture-structure-diagram.png");
    } catch {
      setPngStatus("failed");
      window.setTimeout(() => setPngStatus("idle"), 2200);
    }
  }

  function downloadSvg() {
    if (!model) return;
    const blob = new Blob([renderStewardDiagramSvg(model, dark)], { type: "image/svg+xml;charset=utf-8" });
    triggerBlobDownload(blob, "aperture-structure-diagram.svg");
  }

  if (!model) {
    if (exhausted) return <>{fallback}</>;
    return (
      <figure className="md-diagram-panel is-loading">
        <div className="md-diagram-loading">
          <LoaderCircle className="is-spinning" size={14} />
          <span>Rendering diagram…</span>
        </div>
      </figure>
    );
  }

  return (
    <figure className="md-diagram-panel">
      <figcaption className="md-code-toolbar">
        <span className="md-code-toolbar-main">
          <Network size={15} />
          <strong>structure</strong>
          <span>diagram</span>
        </span>
        {!preview && (
          <span className="md-code-actions">
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
                data-tooltip="Edit the boxes, arrows, and text in this diagram"
                onClick={() => setEditing(true)}
              >
                <Pencil size={14} />
                Edit
              </button>
            )}
          </span>
        )}
      </figcaption>
      {editing && onUpdate && model && (
        <StewardDiagramEditorModal
          model={model}
          onClose={() => setEditing(false)}
          onSave={(nextSource) => onUpdate(source, nextSource)}
        />
      )}
      {recoveredModel && !showSource && (
        <p className="md-diagram-notice">
          <TriangleAlert size={13} />
          <span>
            The reply was cut off mid-diagram — showing everything that arrived. Use Edit to finish the chart, or
            regenerate the reply.
          </span>
        </p>
      )}
      {showSource ? (
        <pre className="md-code-block" tabIndex={preview ? undefined : 0}>
          <code>{source}</code>
        </pre>
      ) : (
        <StewardDiagramCanvas
          dark={dark}
          model={model}
          onCommit={
            onUpdate && !preview
              ? (next: StewardDiagramModel) => {
                  void onUpdate(source, serializeStewardDiagram(next));
                }
              : undefined
          }
        />
      )}
    </figure>
  );
}
