import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type RefObject } from "react";
import { loadKnowledgeDocumentBytes } from "../lib/api/knowledge";
import { layerPieces, type MarkLevel } from "../lib/documentPassage";
import { fileFailure, type ViewerFailure } from "../lib/documentViewerFailures";
import {
  PAGE_GAP,
  anchorAt,
  anchorTop,
  currentPage,
  markLevel,
  paperSheets,
  pageNoun,
  passageNote,
  placeLabel,
  sheetMarks,
  sheetPositionLabel,
  targetSheetIndex,
  viewNoticeText,
  type PageAnchor,
  type PageLayout,
  type PaperSheet,
  type SegmentMarks,
} from "../lib/documentViewerModel";
import {
  PassageCallout,
  PassageMissingNotice,
  ViewerFailureState,
  ViewerNotice,
  ViewerProblem,
  ViewerStatus,
  ViewerToolbar,
  ViewerToolbarDownload,
  passageMarkTop,
  useFocusOnReady,
  usePageKeys,
  type ViewerPaneProps,
} from "./KnowledgeDocumentViewerChrome";

const NO_MARKS: ReadonlyMap<string, SegmentMarks> = new Map();
const NO_RANGES: SegmentMarks = { tint: [], solid: [] };

function zoomStyle(zoom: number) {
  return { "--dv-zoom": String(zoom) } as CSSProperties;
}

function SheetText({ text, marks }: { text: string; marks: SegmentMarks }) {
  return (
    <p className="dv-paper-text">
      {layerPieces(text, marks.tint, marks.solid).map((piece, index) =>
        piece.level === "none" ? (
          piece.text
        ) : (
          <mark className={piece.level === "solid" ? "dv-mark" : "dv-mark is-tint"} key={index}>{piece.text}</mark>
        ),
      )}
    </p>
  );
}

function Sheet({ sheet, marks }: { sheet: PaperSheet; marks: ReadonlyMap<string, SegmentMarks> }) {
  return (
    <article className="dv-paper" data-sheet={sheet.key}>
      {sheet.heading && <h3>{sheet.heading}</h3>}
      {sheet.segments.map((segment) => (
        <SheetText key={segment.id} text={segment.text} marks={marks.get(segment.id) ?? NO_RANGES} />
      ))}
    </article>
  );
}

function sheetTop(sheet: HTMLElement | undefined): number {
  return Math.max((sheet?.offsetTop ?? 0) - PAGE_GAP, 0);
}

function sheetMarkLevel(marks: ReadonlyMap<string, SegmentMarks>): MarkLevel {
  const all = [...marks.values()];
  return markLevel(all.reduce((total, mark) => total + mark.tint.length, 0), all.reduce((total, mark) => total + mark.solid.length, 0));
}

function sheetElements(scroller: HTMLElement) {
  return Array.from(scroller.querySelectorAll<HTMLElement>(".dv-paper"));
}

function sheetLayout(scroller: HTMLElement): PageLayout {
  const sheets = sheetElements(scroller);
  return {
    tops: sheets.map((sheet) => sheet.offsetTop),
    heights: sheets.map((sheet) => sheet.offsetHeight),
    widths: [],
    total: scroller.scrollHeight,
    widest: 0,
  };
}

/** The sheet on screen, and the moves between sheets. Zooming reflows the text,
 * so the middle of the view is held in place through it. */
function useSheetScroll(ref: RefObject<HTMLElement | null>, targetIndex: number, zoom: number) {
  const [current, setCurrent] = useState(targetIndex);
  const anchor = useRef<PageAnchor | null>(null);

  const goToSheet = useCallback(
    (index: number) => {
      const scroller = ref.current;
      if (!scroller) return;
      scroller.scrollTop = sheetTop(sheetElements(scroller)[index]);
      setCurrent(index);
    },
    [ref],
  );

  const showPassage = useCallback(() => {
    const scroller = ref.current;
    if (!scroller) return;
    goToSheet(targetIndex);
    scroller.scrollTop = passageMarkTop(scroller) ?? scroller.scrollTop;
  }, [goToSheet, ref, targetIndex]);

  useLayoutEffect(showPassage, [showPassage]);

  useLayoutEffect(() => {
    const scroller = ref.current;
    if (scroller && anchor.current) scroller.scrollTop = anchorTop(sheetLayout(scroller), anchor.current);
  }, [ref, zoom]);

  const onScroll = useCallback(() => {
    const scroller = ref.current;
    if (!scroller) return;
    const layout = sheetLayout(scroller);
    anchor.current = anchorAt(layout, scroller.scrollTop, scroller.clientHeight / 2);
    setCurrent(currentPage(layout, scroller.scrollTop, scroller.clientHeight) - 1);
  }, [ref]);

  return { current, goToSheet, showPassage, onScroll };
}

function ReadableSheets({ userId, view, passage, passageMissing, onClose, sheets }: ViewerPaneProps & { sheets: PaperSheet[] }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const targetIndex = targetSheetIndex(sheets, view.target);
  const [zoom, setZoom] = useState(1);
  const { current, goToSheet, showPassage, onScroll } = useSheetScroll(scrollerRef, targetIndex, zoom);
  const marks = useMemo(() => sheetMarks(sheets[targetIndex], view.target, passage), [passage, sheets, targetIndex, view.target]);

  const position = {
    label: sheetPositionLabel(sheets[current], current, sheets.length, view.page_count),
    canPrevious: current > 0,
    canNext: current < sheets.length - 1,
    onPrevious: () => goToSheet(current - 1),
    onNext: () => goToSheet(current + 1),
  };
  usePageKeys(position, scrollerRef);
  useFocusOnReady(scrollerRef, true);

  return (
    <>
      <ViewerToolbar
        name={view.name}
        position={position}
        zoom={{ value: zoom, onChange: setZoom }}
        onJump={view.target ? showPassage : undefined}
        download={<ViewerToolbarDownload userId={userId} view={view} />}
        onClose={onClose}
      />
      <PassageMissingNotice missing={passageMissing} atCitedPage={view.target !== null} />
      <ViewerNotice text={viewNoticeText(view.notice)} />
      <PassageCallout
        target={view.target}
        place={view.target && placeLabel(view.target, null, pageNoun(view.content_type))}
        lead={passage}
        note={passageNote(sheetMarkLevel(marks), passage !== null)}
      />
      <div
        className="dv-scroll dv-paper-stack"
        ref={scrollerRef}
        role="region"
        aria-label="Document pages"
        tabIndex={0}
        style={zoomStyle(zoom)}
        onScroll={onScroll}
      >
        {sheets.map((sheet, index) => (
          <Sheet key={sheet.key} sheet={sheet} marks={index === targetIndex ? marks : NO_MARKS} />
        ))}
      </div>
    </>
  );
}

/** Nothing to lay out: a file the server could not read, or one with no text. */
function NothingReadable({ userId, view, onClose }: ViewerPaneProps) {
  return (
    <>
      <ViewerToolbar name={view.name} download={<ViewerToolbarDownload userId={userId} view={view} />} onClose={onClose} />
      {view.original_available ? (
        <ViewerProblem
          alert={false}
          title="This file cannot be shown here"
          detail="It is protected or damaged, or holds no readable text. Download the original to open it."
        >
          <ViewerToolbarDownload userId={userId} view={view} labelled />
        </ViewerProblem>
      ) : (
        <ViewerProblem alert={false} title="Nothing to show" detail="This document has no readable text." />
      )}
    </>
  );
}

/** The document's indexed text, laid out as pages. */
export function KnowledgeDocumentViewerText(props: ViewerPaneProps) {
  const sheets = useMemo(() => paperSheets(props.view.segments), [props.view.segments]);
  return sheets.length === 0 ? <NothingReadable {...props} /> : <ReadableSheets {...props} sheets={sheets} />;
}

type ImageLoad = { status: "loading" } | { status: "failed"; failure: ViewerFailure } | { status: "ready"; url: string };

function useImageFile(userId: string, view: ViewerPaneProps["view"], attempt: number): ImageLoad {
  const [load, setLoad] = useState<ImageLoad>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let url: string | null = null;
    setLoad({ status: "loading" });
    loadKnowledgeDocumentBytes(userId, view.knowledge_config_id, view.document_id, { signal }).then(
      (blob) => {
        if (signal.aborted) return;
        url = URL.createObjectURL(blob);
        setLoad({ status: "ready", url });
      },
      (error: unknown) => {
        if (!signal.aborted) setLoad({ status: "failed", failure: fileFailure(error, "image") });
      },
    );
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [attempt, userId, view]);
  return load;
}

export function KnowledgeDocumentViewerImage({ userId, view, passage, passageMissing, onClose }: ViewerPaneProps) {
  const [attempt, retry] = useReducer((count: number) => count + 1, 0);
  const load = useImageFile(userId, view, attempt);
  const [zoom, setZoom] = useState(1);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  useFocusOnReady(scrollerRef, load.status === "ready");
  if (load.status !== "ready") {
    return (
      <>
        <ViewerToolbar name={view.name} onClose={onClose} />
        {load.status === "loading" ? (
          <ViewerStatus text="Loading image…" />
        ) : (
          <ViewerFailureState
            failure={load.failure}
            onRetry={retry}
            download={<ViewerToolbarDownload userId={userId} view={view} labelled />}
          />
        )}
      </>
    );
  }
  return (
    <>
      <ViewerToolbar
        name={view.name}
        zoom={{ value: zoom, onChange: setZoom }}
        download={<ViewerToolbarDownload userId={userId} view={view} />}
        onClose={onClose}
      />
      <PassageMissingNotice missing={passageMissing} atCitedPage={false} />
      <PassageCallout target={view.target} place={view.target && placeLabel(view.target, null, "Page")} lead={passage} />
      <div
        className="dv-scroll dv-image-stage"
        ref={scrollerRef}
        role="region"
        aria-label="Document pages"
        tabIndex={0}
        style={zoomStyle(zoom)}
      >
        <img src={load.url} alt={view.name} />
      </div>
    </>
  );
}
