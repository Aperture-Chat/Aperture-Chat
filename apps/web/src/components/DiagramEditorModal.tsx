import { Code2, LayoutList, LoaderCircle, Pencil, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  addDiagramNode,
  parseDiagramModel,
  removeDiagramNode,
  updateDiagramNodeText,
} from "../lib/diagramEdit";
import { renderMermaidSvg } from "../lib/mermaidRender";

function isDarkTheme() {
  return document.documentElement.classList.contains("theme-dark");
}

/** Attorney-friendly diagram editing: every box becomes a title + details
 * card with delete, plus an add-box row; the raw Mermaid source stays one
 * toggle away for anything the cards cannot express. Saving hands the new
 * source back to the caller, which persists it into the message. */
export function DiagramEditorModal({
  onClose,
  onSave,
  source,
}: {
  onClose: () => void;
  onSave: (nextSource: string) => Promise<boolean> | boolean;
  source: string;
}) {
  const model = useMemo(() => parseDiagramModel(source), [source]);
  const [working, setWorking] = useState(source);
  const [showSource, setShowSource] = useState(!model.editable);
  const [connectFromId, setConnectFromId] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [svg, setSvg] = useState<string | null>(null);
  const [renderFailed, setRenderFailed] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const workingModel = useMemo(() => parseDiagramModel(working), [working]);
  const dirty = working !== source;

  // Live preview keeps edits honest: the reader sees exactly what will land in
  // the reply. A source that stops parsing blocks Save instead of saving a
  // diagram that would fall back to a code block.
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const rendered = await renderMermaidSvg(working, isDarkTheme());
        if (cancelled) return;
        if (rendered) setSvg(rendered);
        setRenderFailed(!rendered);
      })();
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [working]);

  function applyNodeText(nodeId: string, title: string, detail: string) {
    setWorking((current) => updateDiagramNodeText(current, nodeId, title, detail) ?? current);
  }

  function deleteNode(nodeId: string) {
    setWorking((current) => removeDiagramNode(current, nodeId));
    setConnectFromId((current) => (current === nodeId ? "" : current));
  }

  function addBox() {
    setWorking((current) => {
      const added = addDiagramNode(current, "New box", "", connectFromId || undefined);
      return added.source;
    });
    window.setTimeout(() => {
      const list = listRef.current;
      if (list) list.scrollTop = list.scrollHeight;
    }, 0);
  }

  async function save() {
    if (saving || renderFailed) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      const saved = await onSave(working);
      if (saved) {
        onClose();
        return;
      }
      setSaveFailed(true);
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop diagram-editor-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal diagram-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Edit diagram"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-icon">
            <Pencil size={20} />
          </span>
          <div>
            <h2>Edit diagram</h2>
            <p>
              {model.editable
                ? "Change the text in any box, remove boxes, or add new ones. The preview updates as you type."
                : "This diagram type is edited as source. The preview updates as you type."}
            </p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close diagram editor"
            data-tooltip="Close without saving"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>
        <div className="modal-body diagram-editor-body">
          <div className="diagram-editor-pane">
            {model.editable && (
              <div className="diagram-editor-mode-row">
                <button
                  className="md-code-action"
                  type="button"
                  data-tooltip={showSource ? "Edit boxes as simple cards" : "Edit the Mermaid source directly"}
                  onClick={() => setShowSource((current) => !current)}
                >
                  {showSource ? <LayoutList size={14} /> : <Code2 size={14} />}
                  {showSource ? "Boxes" : "Source"}
                </button>
              </div>
            )}
            {showSource ? (
              <textarea
                className="diagram-editor-source"
                aria-label="Diagram source"
                spellCheck={false}
                value={working}
                onChange={(event) => setWorking(event.target.value)}
              />
            ) : (
              <>
                <div className="diagram-editor-list" ref={listRef}>
                  {workingModel.nodes.map((node) => (
                    <div className="diagram-editor-card" key={node.id}>
                      <div className="diagram-editor-card-head">
                        <input
                          type="text"
                          aria-label={`Title for box ${node.id}`}
                          placeholder="Box title"
                          value={node.title}
                          onChange={(event) => applyNodeText(node.id, event.target.value, node.detail)}
                        />
                        <button
                          className="icon-button diagram-editor-delete"
                          type="button"
                          aria-label={`Delete box ${node.title || node.id}`}
                          data-tooltip="Delete this box and its arrows"
                          onClick={() => deleteNode(node.id)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                      <textarea
                        aria-label={`Details for box ${node.id}`}
                        placeholder="Details — one line per row"
                        rows={Math.min(5, Math.max(2, node.detail.split("\n").length))}
                        value={node.detail}
                        onChange={(event) => applyNodeText(node.id, node.title, event.target.value)}
                      />
                    </div>
                  ))}
                  {workingModel.nodes.length === 0 && (
                    <p className="diagram-editor-empty">No editable boxes found. Switch to Source to edit directly.</p>
                  )}
                </div>
                <div className="diagram-editor-add-row">
                  <button className="secondary-button compact" type="button" onClick={addBox}>
                    <Plus size={14} /> Add box
                  </button>
                  <label>
                    connected from
                    <select
                      aria-label="Connect the new box from"
                      value={connectFromId}
                      onChange={(event) => setConnectFromId(event.target.value)}
                    >
                      <option value="">nothing</option>
                      {workingModel.nodes.map((node) => (
                        <option key={node.id} value={node.id}>
                          {node.title || node.id}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </>
            )}
          </div>
          <div className="diagram-editor-preview">
            {renderFailed && (
              <p className="diagram-editor-warning">
                <TriangleAlert size={14} />
                <span>The diagram no longer renders — undo the last change or fix the source before saving.</span>
              </p>
            )}
            {svg ? (
              <div className="md-diagram-canvas" dangerouslySetInnerHTML={{ __html: svg }} />
            ) : (
              !renderFailed && (
                <div className="md-diagram-loading">
                  <LoaderCircle className="is-spinning" size={14} />
                  <span>Rendering preview…</span>
                </div>
              )
            )}
          </div>
        </div>
        <div className="modal-actions">
          {saveFailed && <span className="diagram-editor-save-error">Saving failed — try again.</span>}
          <button className="secondary-button compact" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button compact"
            type="button"
            disabled={!dirty || renderFailed || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save diagram"}
          </button>
        </div>
      </section>
    </div>
  );
}
