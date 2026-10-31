import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type RefObject } from "react";
import { loadKnowledgeDocumentBytes } from "../lib/api/knowledge";
import {
  layerPieces,
  locatePassage,
  passageWithin,
  readableMarks,
  type MarkLevel,
  type PassageRange,
} from "../lib/documentPassage";
import { fileFailure, type ViewerFailure } from "../lib/documentViewerFailures";
import {
  anchorAt,
  anchorTop,
  canvasPixelRatio,
  clampPage,
  currentPage,
  fitScale,
  markLevel,
  PAGE_GAP,
  pageLayout,
  pageNoun,
  pagePosition,
  passageExcerpt,
  passageNote,
  passagePages,
  placeLabel,
  resolvePageInput,
  strongerMark,
  viewNoticeText,
  visiblePages,
  type PageAnchor,
  type PageBox,
  type PageLayout,
} from "../lib/documentViewerModel";
import { loadPdfEngine, type PdfDocumentHandle, type PdfEngine, type PdfPageHandle, type PdfTask } from "../lib/pdfEngine";
import {
  PassageCallout,
  PassageMissingNotice,
  ViewerFailureState,
  ViewerNotice,
  ViewerStatus,
  ViewerToolbar,
  ViewerToolbarDownload,
  passageMarkTop,
  useFocusOnReady,
  usePageKeys,
  type ViewerPaneProps,
} from "./KnowledgeDocumentViewerChrome";

const OVERSCAN_PAGES = 1;

type PdfLoad =
  | { status: "loading" }
  | { status: "failed"; failure: ViewerFailure }
  | { status: "ready"; document: PdfDocumentHandle; startPage: number; startBox: PageBox };

function usePdfDocument(userId: string, view: ViewerPaneProps["view"], attempt: number): PdfLoad {
  const [load, setLoad] = useState<PdfLoad>({ status: "loading" });
  useEffect(() => {
    if (!view.file_url) {
      setLoad({ status: "failed", failure: fileFailure(null, "pages") });
      return;
    }
    setLoad({ status: "loading" });
    const controller = new AbortController();
    const { signal } = controller;
    let task: ReturnType<PdfEngine["open"]> | null = null;
    const open = async () => {
      const blob = await loadKnowledgeDocumentBytes(userId, view.knowledge_config_id, view.document_id, { signal });
      const [bytes, engine] = await Promise.all([blob.arrayBuffer(), loadPdfEngine()]);
      if (signal.aborted) return;
      task = engine.open(bytes);
      const document = await task.promise;
      const startPage = clampPage(view.target?.page ?? 1, document.pageCount);
      const { box: startBox } = await document.page(startPage);
      if (!signal.aborted) setLoad({ status: "ready", document, startPage, startBox });
    };
    open().catch((error: unknown) => {
      if (!signal.aborted) setLoad({ status: "failed", failure: fileFailure(error, "pages") });
    });
    return () => {
      controller.abort();
      task?.destroy();
    };
  }, [attempt, userId, view]);
  return load;
}

function appendPassageMarks(span: HTMLElement, tint: PassageRange[], solid: PassageRange[]) {
  const pieces = layerPieces(span.textContent ?? "", tint, solid).map((piece) => {
    if (piece.level === "none") return document.createTextNode(piece.text);
    const mark = document.createElement("mark");
    mark.className = piece.level === "solid" ? "dv-mark" : "dv-mark is-tint";
    mark.textContent = piece.text;
    return mark;
  });
  span.replaceChildren(...pieces);
}

type PageReading = { level: MarkLevel; text: string };

/** Highlights a page's text layer: the cited sentence solid, and its chunk tinted.
 * Nothing is solid unless the reply singled out a sentence and it is here. */
function markPassage(spans: HTMLElement[], excerpt: string, passage: string | null): PageReading {
  const texts = spans.map((span) => span.textContent ?? "");
  const { chunk, passage: solid } = locatePassage(texts, excerpt, passage);
  for (const part of new Set([...solid, ...chunk].map((range) => range.part))) {
    const inPart = (range: PassageRange) => range.part === part;
    appendPassageMarks(spans[part], chunk.filter(inPart), solid.filter(inPart));
  }
  return {
    level: markLevel(chunk.length, solid.length),
    text: readableMarks(solid.map(({ part, start, end }) => texts[part].slice(start, end))),
  };
}

type PageJob = {
  document: PdfDocumentHandle;
  number: number;
  scale: number;
  excerpt: string | null;
  passage: string | null;
  canvasSlot: HTMLElement;
  textSlot: HTMLElement;
  onMeasured: (page: number, box: PageBox) => void;
  onPassage: (page: number, reading: PageReading) => void;
  onFailed: () => void;
};

/** Draws one page and its text layer. The returned function stops it. A new
 * canvas replaces the old one only once it is finished, so zooming never
 * flashes an empty page. */
function runPageJob(job: PageJob): () => void {
  let stopped = false;
  let page: PdfPageHandle | null = null;
  const tasks: Array<PdfTask<unknown>> = [];
  const track = <T,>(task: PdfTask<T>) => {
    tasks.push(task);
    return task.promise;
  };

  const paint = async (handle: PdfPageHandle) => {
    const canvas = document.createElement("canvas");
    const ratio = canvasPixelRatio(handle.box.width * job.scale, handle.box.height * job.scale, window.devicePixelRatio);
    await track(handle.paint(canvas, job.scale, ratio));
    if (!stopped) job.canvasSlot.replaceChildren(canvas);
  };

  const writeText = async (handle: PdfPageHandle) => {
    job.textSlot.replaceChildren();
    const spans = await track(handle.writeText(job.textSlot, job.scale));
    if (stopped || job.excerpt === null) return;
    job.onPassage(job.number, markPassage(spans, job.excerpt, job.passage));
  };

  const run = async () => {
    const handle = await job.document.page(job.number);
    if (stopped) {
      handle.release();
      return;
    }
    page = handle;
    job.onMeasured(job.number, handle.box);
    await Promise.all([paint(handle), writeText(handle)]);
  };
  run().catch(() => {
    if (!stopped) job.onFailed();
  });

  return () => {
    stopped = true;
    tasks.forEach((task) => task.cancel());
    page?.release();
  };
}

const PdfPageView = memo(function PdfPageView({
  document,
  number,
  scale,
  top,
  width,
  height,
  excerpt,
  passage,
  onMeasured,
  onPassage,
}: {
  document: PdfDocumentHandle;
  number: number;
  scale: number;
  top: number;
  width: number;
  height: number;
  excerpt: string | null;
  passage: string | null;
  onMeasured: PageJob["onMeasured"];
  onPassage: PageJob["onPassage"];
}) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvasSlot = canvasRef.current;
    const textSlot = textRef.current;
    if (!canvasSlot || !textSlot) return;
    return runPageJob({
      document,
      number,
      scale,
      excerpt,
      passage,
      canvasSlot,
      textSlot,
      onMeasured,
      onPassage,
      onFailed: () => setFailed(true),
    });
  }, [document, excerpt, number, onMeasured, onPassage, passage, scale]);

  return (
    <div className="dv-page" data-page={number} style={{ top, width, height }}>
      <div className="dv-page-canvas" ref={canvasRef} />
      <div className="textLayer" ref={textRef} />
      {failed && <p className="dv-page-failed" role="alert">This page could not be shown.</p>}
    </div>
  );
});

/** Pages wait for `known`: a page drawn before the view is measured would be
 * drawn at the wrong scale. */
function useViewportSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0, known: false });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight, known: true });
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [ref]);
  return size;
}

/** Pages are sized from one page until each is read, so only the ones that turn
 * out different are remembered. */
function useMeasuredPages(estimate: PageBox) {
  const [measured, setMeasured] = useState<ReadonlyMap<number, PageBox>>(new Map());
  const onMeasured = useCallback(
    (page: number, box: PageBox) => {
      setMeasured((known) => {
        const sized = known.get(page) ?? estimate;
        if (sized.width === box.width && sized.height === box.height) return known;
        return new Map(known).set(page, box);
      });
    },
    [estimate],
  );
  return { measured, onMeasured };
}

/** Scrolling that survives the layout changing underneath it: every change
 * (zoom, resize, a page measuring differently) keeps what the reader was
 * looking at where it was, and a page wider than the view stays centered. */
function useAnchoredScroll(ref: RefObject<HTMLElement | null>, layout: PageLayout, startPage: number) {
  // A page opens with its margin showing above it.
  const anchor = useRef<PageAnchor>({ page: startPage, fraction: 0, viewOffset: PAGE_GAP });
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [, noteMove] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.scrollTop = anchorTop(layout, anchor.current);
    element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2;
  }, [layout, ref]);

  const moveTo = useCallback(
    (top: number) => {
      const element = ref.current;
      if (!element) return;
      element.scrollTop = top;
      anchor.current = anchorAt(layoutRef.current, top);
      noteMove(top);
    },
    [ref],
  );

  const onScroll = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    anchor.current = anchorAt(layoutRef.current, element.scrollTop, element.clientHeight / 2);
    noteMove(element.scrollTop);
  }, [ref]);

  // Read from the anchor, never from a remembered offset: when the first
  // measurement rescales the pages, an old offset points at the wrong ones.
  return { scrollTop: anchorTop(layout, anchor.current), moveTo, onScroll };
}

/** Takes the reader to the passage once its page has been read, once. */
function usePassageSeek(
  ref: RefObject<HTMLElement | null>,
  moveTo: (top: number) => void,
  hasTarget: boolean,
  hasSentence: boolean,
) {
  const seeking = useRef(hasTarget);
  const [readings, setReadings] = useState<ReadonlyMap<number, PageReading>>(new Map());

  const showMark = useCallback(() => {
    const top = ref.current ? passageMarkTop(ref.current) : null;
    if (top !== null) moveTo(top);
    return top !== null;
  }, [moveTo, ref]);

  const onPassage = useCallback(
    (page: number, reading: PageReading) => {
      setReadings((known) => new Map(known).set(page, reading));
      if (reading.level === "none" || !seeking.current) return;
      // Keep looking while only the tint is marked: the sentence may be on the
      // passage's next page. With no sentence, the tint is all there will be.
      const arrived = showMark();
      seeking.current = !(arrived && (!hasSentence || reading.level === "solid"));
    },
    [hasSentence, showMark],
  );

  const seekNow = useCallback(() => {
    seeking.current = !showMark();
  }, [showMark]);

  const stopSeeking = useCallback(() => {
    seeking.current = false;
  }, []);

  const read = [...readings.entries()].sort(([a], [b]) => a - b).map(([, reading]) => reading);
  return {
    found: read.reduce<MarkLevel | null>((level, reading) => strongerMark(level, reading.level), null),
    markedWords: readableMarks(read.map((reading) => reading.text)),
    onPassage,
    seekNow,
    stopSeeking,
  };
}

/** The page's own words once all of the sentence has been found on it:
 * extraction can leave "Sta ff ord" where the page says "Stafford". */
function pageWordsOrPassage(markedWords: string, passage: string): string {
  return passageWithin(markedWords, passage) ? markedWords : passage;
}

function pdfPosition(noun: string, page: number, document: PdfDocumentHandle, goToPage: (page: number) => void) {
  const { pageCount, labels } = document;
  const { printed, suffix, compactSuffix, label } = pagePosition(noun, page, pageCount, labels);
  return {
    label,
    canPrevious: page > 1,
    canNext: page < pageCount,
    onPrevious: () => goToPage(page - 1),
    onNext: () => goToPage(page + 1),
    field: {
      noun,
      value: printed,
      suffix,
      compactSuffix,
      onSubmit: (raw: string) => {
        const wanted = resolvePageInput(raw, pageCount, labels);
        if (wanted !== null) goToPage(wanted);
      },
    },
  };
}

function PdfPages({
  document,
  startPage,
  startBox,
  userId,
  view,
  passage: citedPassage,
  passageMissing,
  onClose,
}: ViewerPaneProps & { document: PdfDocumentHandle; startPage: number; startBox: PageBox }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const { pageCount, labels } = document;
  const [zoom, setZoom] = useState(1);
  const viewport = useViewportSize(scrollerRef);
  const { measured, onMeasured } = useMeasuredPages(startBox);
  const scale = fitScale(viewport.width, startBox.width) * zoom;
  const layout = useMemo(() => pageLayout(pageCount, measured, startBox, scale), [measured, pageCount, scale, startBox]);
  const { scrollTop, moveTo, onScroll } = useAnchoredScroll(scrollerRef, layout, startPage);
  const passage = passagePages(view.target, pageCount);
  const { found, markedWords, onPassage, seekNow, stopSeeking } = usePassageSeek(
    scrollerRef,
    moveTo,
    passage !== null,
    citedPassage !== null,
  );

  const goToPage = (page: number) => {
    stopSeeking();
    moveTo(Math.max(layout.tops[clampPage(page, pageCount) - 1] - PAGE_GAP, 0));
  };
  const jumpToPassage = (first: number) => {
    goToPage(first);
    seekNow();
  };

  const noun = pageNoun(view.content_type);
  const page = currentPage(layout, scrollTop, viewport.height);
  const position = pdfPosition(noun, page, document, goToPage);
  usePageKeys(position, scrollerRef);
  useFocusOnReady(scrollerRef, true);

  return (
    <>
      <ViewerToolbar
        name={view.name}
        position={position}
        zoom={{ value: zoom, onChange: setZoom }}
        onJump={passage ? () => jumpToPassage(passage.first) : undefined}
        download={<ViewerToolbarDownload userId={userId} view={view} />}
        onClose={onClose}
      />
      <PassageMissingNotice missing={passageMissing} atCitedPage={passage !== null} />
      <ViewerNotice text={viewNoticeText(view.notice)} />
      <PassageCallout
        target={view.target}
        place={view.target && placeLabel(view.target, labels, noun)}
        lead={citedPassage && pageWordsOrPassage(markedWords, citedPassage)}
        note={passageNote(found, citedPassage !== null)}
      />
      <div
        className="dv-scroll"
        ref={scrollerRef}
        role="region"
        aria-label="Document pages"
        tabIndex={0}
        onScroll={onScroll}
      >
        <div className="dv-pages" style={{ height: layout.total, width: layout.widest }}>
          {viewport.known &&
            visiblePages(layout, scrollTop, viewport.height, OVERSCAN_PAGES).map((number) => (
              <PdfPageView
                key={number}
                document={document}
                number={number}
                scale={scale}
                top={layout.tops[number - 1]}
                width={layout.widths[number - 1]}
                height={layout.heights[number - 1]}
                excerpt={passageExcerpt(number, passage, view.target)}
                passage={citedPassage}
                onMeasured={onMeasured}
                onPassage={onPassage}
              />
            ))}
        </div>
      </div>
    </>
  );
}

export function KnowledgeDocumentViewerPdf(props: ViewerPaneProps) {
  const { userId, view, onClose } = props;
  const [attempt, retry] = useReducer((count: number) => count + 1, 0);
  const load = usePdfDocument(userId, view, attempt);
  if (load.status === "ready") {
    return <PdfPages {...props} document={load.document} startPage={load.startPage} startBox={load.startBox} />;
  }
  return (
    <>
      <ViewerToolbar name={view.name} onClose={onClose} />
      {load.status === "loading" ? (
        <ViewerStatus text="Loading pages…" />
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
