import { createPortal } from "react-dom";
import { useRef, useState } from "react";
import { Archive, ArchiveRestore, Trash2 } from "lucide-react";

type Props = {
  title: string; summary: string; source: string; time: string; status: string;
  archived: boolean; disabled: boolean;
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
      <button type="button" className="draft-history-document-card" onClick={props.onRestore}
        aria-label={`Restore ${props.title} from document history (${props.status})`}>
        <span><strong>{props.title}</strong><small>{props.status}</small><small>{props.summary}</small><small>{props.source}</small></span>
        <time>{props.time}</time>
      </button>
      <div className="draft-history-actions">
        <button type="button" disabled={props.disabled} onClick={props.onArchive}
          aria-label={`${props.archived ? "Unarchive" : "Archive"} ${props.title}`}>
          {props.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          {props.archived ? "Unarchive" : "Archive"}
        </button>
        <button type="button" disabled={props.disabled} onClick={props.onDelete} aria-label={`Delete ${props.title}`}>
          <Trash2 size={14} />Delete
        </button>
      </div>
      {expanded && createPortal(<div style={position} className="draft-history-preview" role="status" aria-label={`Preview of ${props.title}`}>
        <span className="eyebrow">Preview</span><p>{preview ?? "Loading preview…"}</p>
      </div>, document.body)}
    </div>
  );
}
