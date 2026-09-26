import { createPortal } from "react-dom";
import { useRef, useState } from "react";
import { Archive, ArchiveRestore, FileText, LoaderCircle, Presentation, Trash2 } from "lucide-react";

type Props = {
  title: string; summary: string; source: string; time: string; status: string;
  archived: boolean; disabled: boolean; opening?: boolean; archiveDisabled?: boolean;
  /** Decks and documents can share a title; the icon tells them apart. */
  kind?: "document" | "deck";
  onRestore: () => void; onArchive: () => void; onDelete: () => void;
  loadPreview: () => Promise<string>;
};

export function DraftHistoryCard(props: Props) {
  const [preview, setPreview] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const loading = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 20, top: 100 });
  async function showPreview() {
    const rect = cardRef.current?.getBoundingClientRect();
    if (rect) setPosition({ left: Math.max(20, Math.min(rect.right + 12, window.innerWidth - 320)), top: Math.max(20, Math.min(rect.top, window.innerHeight - 230)) });
    setExpanded(true);
    if (preview !== null || loading.current) return;
    loading.current = true;
    try { setPreview(await props.loadPreview()); }
    catch { setPreview("Preview unavailable. Reopen the draft to retry."); }
    finally { loading.current = false; }
  }
  return (
    <div ref={cardRef} className="draft-history-entry" onMouseEnter={() => void showPreview()}
      onMouseLeave={() => setExpanded(false)} onFocus={() => void showPreview()}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false); }}>
      <button type="button" className="draft-history-document-card" disabled={props.opening} aria-busy={props.opening} onClick={() => { setExpanded(false); props.onRestore(); }}
        aria-label={`Restore ${props.title} from document history (${props.status})`}
        data-tooltip={props.archived ? "Open this archived draft" : "Open this draft"}>
        <span className="draft-history-doc-icon" aria-hidden="true">
          {props.opening ? (
            <LoaderCircle className="is-spinning" size={15} />
          ) : props.kind === "deck" ? (
            <Presentation size={15} />
          ) : (
            <FileText size={15} />
          )}
        </span>
        <span className="draft-history-doc-text">
          <strong>{props.title}</strong>
          <small>
            <span className={`draft-history-state is-${historyStatusTone(props.status)}`}>
              {props.opening ? "Opening…" : props.status}
            </span>
            <time>{props.time}</time>
          </small>
          <span className="sr-only">{[props.summary, props.source].filter(Boolean).join(". ")}</span>
        </span>
      </button>
      <div className="draft-history-actions">
        <button type="button" disabled={props.archiveDisabled ?? props.disabled} onClick={props.onArchive}
          aria-label={`${props.archived ? "Unarchive" : "Archive"} ${props.title}`}
          data-tooltip={props.archived ? "Move back to active drafts" : "Archive this draft"}>
          {props.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        </button>
        <button type="button" className="is-danger" disabled={props.disabled} onClick={props.onDelete} aria-label={`Delete ${props.title}`}
          data-tooltip="Delete this draft">
          <Trash2 size={14} />
        </button>
      </div>
      {expanded && createPortal(<div style={position} className="draft-history-preview" role="status" aria-label={`Preview of ${props.title}`}>
        <span className="eyebrow">Preview</span>
        {(props.summary || props.source) && <small className="draft-history-preview-meta">{[props.summary, props.source].filter(Boolean).join(" · ")}</small>}
        <p>{preview ?? "Loading preview…"}</p>
      </div>, document.body)}
    </div>
  );
}

function historyStatusTone(status: string) {
  if (status === "Saved") return "saved";
  if (status === "Drafting") return "running";
  if (status === "Needs attention") return "failed";
  return "local";
}
