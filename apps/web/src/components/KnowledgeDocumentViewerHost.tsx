import { LoaderCircle, X } from "lucide-react";
import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DocumentRequest } from "../lib/citationTargets";
import { LazyChunkBoundary, lazyWithReload } from "../lib/lazyChunk";
import { useModalFocus } from "../lib/useModalFocus";

const LazyViewer = lazyWithReload("KnowledgeDocumentViewer", () => import("./KnowledgeDocumentViewer"));

/** Everything behind an open viewer is out of reach: screen readers, Tab, and
 * the shell's Cmd+K, which would open search unseen beneath it. Declare this
 * before `useModalFocus`, so the app is live again when focus returns to it. */
export function useAppBehindViewer() {
  useEffect(() => {
    const app = document.getElementById("root");
    if (app) app.inert = true;
    const holdSearchKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") event.preventDefault();
    };
    window.addEventListener("keydown", holdSearchKey, true);
    return () => {
      if (app) app.inert = false;
      window.removeEventListener("keydown", holdSearchKey, true);
    };
  }, []);
}

/** The blade before the viewer's own code exists: while it arrives, and if it
 * never does. Here, not in the viewer's chunk, so it can always be drawn. */
function ViewerShell({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const panelRef = useRef<HTMLElement | null>(null);
  useAppBehindViewer();
  useModalFocus(panelRef, true, onClose);
  return createPortal(
    <div className="dv-layer">
      <button type="button" className="dv-backdrop" aria-label="Close the document" tabIndex={-1} onClick={onClose} />
      <section className="dv-panel" ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Document">
        <header className="dv-toolbar">
          <div className="dv-title"><strong>Document</strong></div>
          <button className="icon-button" type="button" aria-label="Close document" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        {children}
      </section>
    </div>,
    document.body,
  );
}

function ViewerArriving({ onClose }: { onClose: () => void }) {
  return (
    <ViewerShell onClose={onClose}>
      <div className="dv-state" role="status">
        <LoaderCircle className="is-spinning" size={20} />
        <span>Opening document…</span>
      </div>
    </ViewerShell>
  );
}

/** A browser keeps a failed import, so trying again cannot work: only a reload
 * can fetch the code. */
function ViewerUnavailable({ reload, onClose }: { reload: () => void; onClose: () => void }) {
  return (
    <ViewerShell onClose={onClose}>
      <div className="dv-state" role="alert">
        <strong>The document viewer could not load</strong>
        <span>This can happen after an update or a lost connection. Reload the page to fetch it again.</span>
        <div className="dv-state-actions">
          <button className="secondary-button" type="button" onClick={reload}>
            Reload page
          </button>
        </div>
      </div>
    </ViewerShell>
  );
}

/** Opens knowledge documents over any surface. Render `documentViewerLayer`
 * once; the pdf.js-heavy viewer loads the first time someone opens a document. */
export function useKnowledgeDocumentViewer(userId: string) {
  const [request, setRequest] = useState<DocumentRequest | null>(null);
  const close = useCallback(() => setRequest(null), []);
  const documentViewerLayer = request ? (
    <LazyChunkBoundary
      label="The document viewer"
      renderFailure={({ reload }) => <ViewerUnavailable reload={reload} onClose={close} />}
    >
      <Suspense fallback={<ViewerArriving onClose={close} />}>
        <LazyViewer userId={userId} request={request} onClose={close} />
      </Suspense>
    </LazyChunkBoundary>
  ) : null;
  return { openDocument: setRequest, documentViewerLayer };
}
