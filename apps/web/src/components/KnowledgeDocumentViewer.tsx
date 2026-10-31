import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getKnowledgeDocumentView, locateKnowledgeChunk } from "../lib/api/knowledge";
import type { DocumentRequest } from "../lib/citationTargets";
import { passageWithin } from "../lib/documentPassage";
import { requestFailure, type ViewerFailure } from "../lib/documentViewerFailures";
import { viewWithPageHint } from "../lib/documentViewerModel";
import type { KnowledgeDocumentTarget, KnowledgeDocumentView } from "../lib/types";
import { useModalFocus } from "../lib/useModalFocus";
import {
  DownloadOriginal,
  ViewerFailureState,
  ViewerStatus,
  ViewerToolbar,
  type ViewerPaneProps,
} from "./KnowledgeDocumentViewerChrome";
import { useAppBehindViewer } from "./KnowledgeDocumentViewerHost";
import { KnowledgeDocumentViewerPdf } from "./KnowledgeDocumentViewerPdf";
import { KnowledgeDocumentViewerImage, KnowledgeDocumentViewerText } from "./KnowledgeDocumentViewerPaper";

/** A first view of an Office file converts it on the server. Past this wait,
 * the person is told why it is slow. */
const PREPARING_AFTER_MS = 900;

type DocumentIds = { configId: string; documentId: string };

type ViewerSession =
  | { phase: "opening"; slow: boolean }
  | { phase: "ready"; view: KnowledgeDocumentView }
  | { phase: "failed"; failure: ViewerFailure; ids: DocumentIds | null };

async function resolveIds(userId: string, request: DocumentRequest, signal: AbortSignal): Promise<DocumentIds> {
  if (request.kind === "document") return request;
  const location = await locateKnowledgeChunk(userId, request.chunkId, { signal });
  return { configId: location.knowledge_config_id, documentId: location.document_id };
}

function useDocumentSession(userId: string, request: DocumentRequest) {
  const [session, setSession] = useState<ViewerSession>({ phase: "opening", slow: false });
  const [attempt, retry] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let ids: DocumentIds | null = null;
    const settle = (next: ViewerSession) => {
      if (!signal.aborted) setSession(next);
    };
    setSession({ phase: "opening", slow: false });
    const slowTimer = window.setTimeout(() => {
      setSession((current) => (current.phase === "opening" ? { phase: "opening", slow: true } : current));
    }, PREPARING_AFTER_MS);
    const open = async () => {
      ids = await resolveIds(userId, request, signal);
      return getKnowledgeDocumentView(userId, ids.configId, ids.documentId, { chunkId: request.chunkId, signal });
    };
    open()
      .then(
        (view) => settle({ phase: "ready", view: viewWithPageHint(view, request.chunkId ? request.pageHint ?? null : null) }),
        (error: unknown) => settle({ phase: "failed", failure: requestFailure(error, request.kind), ids }),
      )
      .finally(() => window.clearTimeout(slowTimer));
    return () => {
      controller.abort();
      window.clearTimeout(slowTimer);
    };
  }, [attempt, request, userId]);
  return { session, retry };
}

/** The citation's sentence, only if the server's own excerpt really holds it. */
function checkedPassage(target: KnowledgeDocumentTarget | null, passage: string | null | undefined): string | null {
  if (!target || !passage || !passageWithin(target.excerpt, passage)) return null;
  return passage.replace(/\s+/g, " ").trim();
}

function ReadyDocument(props: ViewerPaneProps) {
  if (props.view.mode === "pdf") return <KnowledgeDocumentViewerPdf {...props} />;
  if (props.view.mode === "image") return <KnowledgeDocumentViewerImage {...props} />;
  return <KnowledgeDocumentViewerText {...props} />;
}

function SessionBody({
  session,
  userId,
  onRetry,
}: {
  session: Exclude<ViewerSession, { phase: "ready" }>;
  userId: string;
  onRetry: () => void;
}) {
  if (session.phase === "opening") {
    return <ViewerStatus text={session.slow ? "Preparing document… a first view can take a minute." : "Opening document…"} />;
  }
  return (
    <ViewerFailureState
      failure={session.failure}
      onRetry={onRetry}
      download={session.ids && <DownloadOriginal userId={userId} {...session.ids} labelled />}
    />
  );
}

function ViewerDialog({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const panelRef = useRef<HTMLElement | null>(null);
  useAppBehindViewer();
  useModalFocus(panelRef, true, onClose);
  return createPortal(
    <div className="dv-layer">
      <button type="button" className="dv-backdrop" aria-label="Close the document" tabIndex={-1} onClick={onClose} />
      <section className="dv-panel" ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </section>
    </div>,
    document.body,
  );
}

/** A knowledge document, shown as the document it is, opened where it was cited. */
export default function KnowledgeDocumentViewer({
  userId,
  request,
  onClose,
}: {
  userId: string;
  request: DocumentRequest;
  onClose: () => void;
}) {
  const { session, retry } = useDocumentSession(userId, request);
  if (session.phase === "ready") {
    const { view } = session;
    return (
      <ViewerDialog label={view.name} onClose={onClose}>
        <ReadyDocument
          userId={userId}
          view={view}
          passage={checkedPassage(view.target, request.passage)}
          passageMissing={Boolean(request.chunkId) && !view.target?.excerpt}
          onClose={onClose}
        />
      </ViewerDialog>
    );
  }
  return (
    <ViewerDialog label="Document" onClose={onClose}>
      <ViewerToolbar name="Document" onClose={onClose} />
      <SessionBody session={session} userId={userId} onRetry={retry} />
    </ViewerDialog>
  );
}
