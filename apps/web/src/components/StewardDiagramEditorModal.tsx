import { Code2, LayoutList, Pencil, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  parseStewardDiagram,
  renderStewardDiagramSvg,
  serializeStewardDiagram,
  type StewardDiagramCard,
  type StewardDiagramEdgeKind,
  type StewardDiagramModel,
  type StewardDiagramTone,
} from "../lib/stewardDiagram";

function isDarkTheme() {
  return document.documentElement.classList.contains("theme-dark");
}

const EDGE_KIND_LABELS: Record<StewardDiagramEdgeKind, string> = {
  primary: "solid — completed / funded",
  contingent: "dashed gold — contingent / at-death",
  inactive: "dashed gray — executed, not active",
};

const TONE_LABELS: Record<StewardDiagramTone, string> = {
  neutral: "blue — neutral",
  positive: "green — favorable",
  warning: "amber — warning",
};

let addCounter = 0;

/** Structured editor for steward-diagram charts. Every card is a form —
 * title, subtitle, bullet lines, status band, warning note — plus arrow
 * management with plain-language styles. The JSON source stays one toggle
 * away; Save hands the serialized model back to the caller to persist. */
export function StewardDiagramEditorModal({
  model,
  onClose,
  onSave,
}: {
  model: StewardDiagramModel;
  onClose: () => void;
  onSave: (nextSource: string) => Promise<boolean> | boolean;
}) {
  const [working, setWorking] = useState<StewardDiagramModel>(() => JSON.parse(JSON.stringify(model)));
  const [showSource, setShowSource] = useState(false);
  const [sourceText, setSourceText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  // In source view the textarea is authoritative; in card view the model is.
  const sourceModel = sourceText !== null ? parseStewardDiagram(sourceText) : working;
  const effective = sourceModel ?? working;
  const svg = useMemo(() => renderStewardDiagramSvg(effective, isDarkTheme()), [effective]);
  const sourceBroken = sourceText !== null && sourceModel === null;

  const allCards = effective.rows.flat();
  const cardTitle = (id: string) => allCards.find((card) => card.id === id)?.title ?? id;

  function update(mutate: (draft: StewardDiagramModel) => void) {
    setWorking((current) => {
      const draft: StewardDiagramModel = JSON.parse(JSON.stringify(current));
      mutate(draft);
      return draft;
    });
  }

  function updateCard(id: string, mutate: (card: StewardDiagramCard) => void) {
    update((draft) => {
      for (const row of draft.rows) {
        const card = row.find((item) => item.id === id);
        if (card) mutate(card);
      }
    });
  }

  function deleteCard(id: string) {
    update((draft) => {
      draft.rows = draft.rows.map((row) => row.filter((card) => card.id !== id)).filter((row) => row.length > 0);
      draft.edges = draft.edges.filter((edge) => edge.from !== id && edge.to !== id);
    });
  }

  function addCard(rowIndex: number) {
    update((draft) => {
      let id = `box-${++addCounter}`;
      const ids = new Set(draft.rows.flat().map((card) => card.id));
      while (ids.has(id)) id = `box-${++addCounter}`;
      const card: StewardDiagramCard = { id, title: "New box", variant: "card" };
      if (draft.rows[rowIndex]) draft.rows[rowIndex].push(card);
      else draft.rows.push([card]);
    });
  }

  function switchView() {
    if (showSource) {
      // Returning to cards keeps the source edits only when they parse.
      if (sourceText !== null && sourceModel) setWorking(sourceModel);
      setSourceText(null);
      setShowSource(false);
    } else {
      setSourceText(serializeStewardDiagram(working));
      setShowSource(true);
    }
  }

  async function save() {
    if (saving || sourceBroken) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      const next = serializeStewardDiagram(effective);
      const saved = await onSave(next);
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
            <p>Change any box's text, remove or add boxes and arrows. The preview updates as you type.</p>
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
            <div className="diagram-editor-mode-row">
              <button
                className="md-code-action"
                type="button"
                data-tooltip={showSource ? "Edit boxes as simple cards" : "Edit the diagram source directly"}
                onClick={switchView}
              >
                {showSource ? <LayoutList size={14} /> : <Code2 size={14} />}
                {showSource ? "Boxes" : "Source"}
              </button>
            </div>
            {showSource ? (
              <textarea
                className="diagram-editor-source"
                aria-label="Diagram source"
                spellCheck={false}
                value={sourceText ?? ""}
                onChange={(event) => setSourceText(event.target.value)}
              />
            ) : (
              <div className="diagram-editor-list">
                <div className="diagram-editor-card">
                  <div className="diagram-editor-field-grid">
                    <label>
                      Chart title
                      <input
                        type="text"
                        value={working.title ?? ""}
                        onChange={(event) => update((draft) => (draft.title = event.target.value || undefined))}
                      />
                    </label>
                    <label>
                      Subtitle
                      <input
                        type="text"
                        value={working.subtitle ?? ""}
                        onChange={(event) => update((draft) => (draft.subtitle = event.target.value || undefined))}
                      />
                    </label>
                    <label>
                      Footnote
                      <input
                        type="text"
                        value={working.footnote ?? ""}
                        onChange={(event) => update((draft) => (draft.footnote = event.target.value || undefined))}
                      />
                    </label>
                  </div>
                </div>
                {working.rows.map((row, rowIndex) => (
                  <div key={rowIndex} className="diagram-editor-row-group">
                    <div className="diagram-editor-row-head">
                      <span>Row {rowIndex + 1}</span>
                      <button
                        className="md-code-action"
                        type="button"
                        data-tooltip="Add a box to this row"
                        onClick={() => addCard(rowIndex)}
                      >
                        <Plus size={13} /> Box
                      </button>
                    </div>
                    {row.map((card) => (
                      <div className="diagram-editor-card" key={card.id}>
                        <div className="diagram-editor-card-head">
                          <input
                            type="text"
                            aria-label={`Title for box ${card.id}`}
                            placeholder="Box title"
                            value={card.title}
                            onChange={(event) => updateCard(card.id, (draft) => (draft.title = event.target.value))}
                          />
                          <button
                            className="icon-button diagram-editor-delete"
                            type="button"
                            aria-label={`Delete box ${card.title || card.id}`}
                            data-tooltip="Delete this box and its arrows"
                            onClick={() => deleteCard(card.id)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                        <input
                          type="text"
                          aria-label={`Subtitle for box ${card.id}`}
                          placeholder="Subtitle (dates, governing law…)"
                          value={card.subtitle ?? ""}
                          onChange={(event) =>
                            updateCard(card.id, (draft) => (draft.subtitle = event.target.value || undefined))
                          }
                        />
                        {card.variant !== "banner" && (
                          <>
                            <textarea
                              aria-label={`Details for box ${card.id}`}
                              placeholder="Details — one line per row"
                              rows={Math.min(6, Math.max(2, (card.bullets ?? []).length))}
                              value={(card.bullets ?? []).join("\n")}
                              onChange={(event) =>
                                updateCard(card.id, (draft) => {
                                  const bullets = event.target.value.split("\n").filter((line) => line.trim() !== "");
                                  draft.bullets = bullets.length > 0 ? bullets : undefined;
                                })
                              }
                            />
                            <div className="diagram-editor-inline">
                              <input
                                type="text"
                                aria-label={`Status band for box ${card.id}`}
                                placeholder="Status band (e.g. NOT SUBJECT TO ESTATE TAX)"
                                value={card.footer?.text ?? ""}
                                onChange={(event) =>
                                  updateCard(card.id, (draft) => {
                                    const text = event.target.value;
                                    draft.footer = text ? { text, tone: draft.footer?.tone ?? "neutral" } : undefined;
                                  })
                                }
                              />
                              <select
                                aria-label={`Status color for box ${card.id}`}
                                value={card.footer?.tone ?? "neutral"}
                                onChange={(event) =>
                                  updateCard(card.id, (draft) => {
                                    if (draft.footer) draft.footer.tone = event.target.value as StewardDiagramTone;
                                  })
                                }
                              >
                                {(Object.keys(TONE_LABELS) as StewardDiagramTone[]).map((tone) => (
                                  <option key={tone} value={tone}>
                                    {TONE_LABELS[tone]}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <input
                              type="text"
                              aria-label={`Warning note for box ${card.id}`}
                              placeholder="Warning note (amber callout, optional)"
                              value={card.note ?? ""}
                              onChange={(event) =>
                                updateCard(card.id, (draft) => (draft.note = event.target.value || undefined))
                              }
                            />
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
                <div className="diagram-editor-row-group">
                  <div className="diagram-editor-row-head">
                    <span>Arrows</span>
                    <button
                      className="md-code-action"
                      type="button"
                      data-tooltip="Add an arrow between two boxes"
                      onClick={() =>
                        update((draft) => {
                          const cards = draft.rows.flat();
                          if (cards.length >= 2) {
                            draft.edges.push({ from: cards[0].id, to: cards[1].id, kind: "primary" });
                          }
                        })
                      }
                    >
                      <Plus size={13} /> Arrow
                    </button>
                  </div>
                  {working.edges.map((edge, edgeIndex) => (
                    <div className="diagram-editor-edge-row" key={edgeIndex}>
                      <select
                        aria-label={`Arrow ${edgeIndex + 1} from`}
                        value={edge.from}
                        onChange={(event) => update((draft) => (draft.edges[edgeIndex].from = event.target.value))}
                      >
                        {allCards.map((card) => (
                          <option key={card.id} value={card.id}>
                            {card.title}
                          </option>
                        ))}
                      </select>
                      <span aria-hidden="true">→</span>
                      <select
                        aria-label={`Arrow ${edgeIndex + 1} to`}
                        value={edge.to}
                        onChange={(event) => update((draft) => (draft.edges[edgeIndex].to = event.target.value))}
                      >
                        {allCards.map((card) => (
                          <option key={card.id} value={card.id}>
                            {card.title}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label={`Arrow ${edgeIndex + 1} style`}
                        value={edge.kind ?? "primary"}
                        onChange={(event) =>
                          update((draft) => (draft.edges[edgeIndex].kind = event.target.value as StewardDiagramEdgeKind))
                        }
                      >
                        {(Object.keys(EDGE_KIND_LABELS) as StewardDiagramEdgeKind[]).map((kind) => (
                          <option key={kind} value={kind}>
                            {EDGE_KIND_LABELS[kind]}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        aria-label={`Arrow ${edgeIndex + 1} label`}
                        placeholder="Label"
                        value={edge.label ?? ""}
                        onChange={(event) =>
                          update((draft) => (draft.edges[edgeIndex].label = event.target.value || undefined))
                        }
                      />
                      <button
                        className="icon-button diagram-editor-delete"
                        type="button"
                        aria-label={`Delete arrow from ${cardTitle(edge.from)} to ${cardTitle(edge.to)}`}
                        data-tooltip="Delete this arrow"
                        onClick={() => update((draft) => draft.edges.splice(edgeIndex, 1))}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="diagram-editor-preview">
            {sourceBroken && (
              <p className="diagram-editor-warning">
                <TriangleAlert size={14} />
                <span>The source is not valid diagram JSON — fix it or switch back to Boxes to discard.</span>
              </p>
            )}
            <div className="md-diagram-canvas" dangerouslySetInnerHTML={{ __html: svg }} />
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
            disabled={sourceBroken || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save diagram"}
          </button>
        </div>
      </section>
    </div>
  );
}
