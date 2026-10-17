import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  documentSheetGeometry,
  headerFooterHtmlForPage,
  pageChromeHtml,
  type DocumentPageSetup,
} from "../lib/documentPageSetup";
import { relayoutDocumentTabs } from "../lib/documentTabs";
import { sanitizeDocumentHtml } from "../lib/draftRedline";

type SheetBox = { top: number; left: number; width: number; height: number };

type Props = {
  editorRef: RefObject<HTMLElement | null>;
  scrollerRef: RefObject<HTMLElement | null>;
  setup: DocumentPageSetup;
  /** Any value that changes when the sheets may have moved (content edits). */
  layoutKey: unknown;
  zoom: number;
};

function sameBoxes(a: SheetBox[], b: SheetBox[]) {
  return (
    a.length === b.length &&
    a.every(
      (box, index) =>
        Math.abs(box.top - b[index].top) < 0.5 &&
        Math.abs(box.left - b[index].left) < 0.5 &&
        Math.abs(box.width - b[index].width) < 0.5 &&
        Math.abs(box.height - b[index].height) < 0.5,
    )
  );
}

/** Running headers and footers of an imported document, drawn in each
 * sheet's top and bottom margins. They live outside the editable body (a
 * read-only overlay in the scroll area), so typing, selection, find, undo,
 * and saving only ever see the document text, while the page still looks
 * like the Word or PDF original, page numbers included. */
export function DocumentPageChrome({ editorRef, scrollerRef, setup, layoutKey, zoom }: Props) {
  const [sheets, setSheets] = useState<SheetBox[]>([]);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const geometry = useMemo(() => documentSheetGeometry(setup), [setup]);
  const safe = useMemo(
    () => ({
      header: sanitizeDocumentHtml(setup.headerHtml),
      footer: sanitizeDocumentHtml(setup.footerHtml),
      firstHeader: setup.firstHeaderHtml === null ? null : sanitizeDocumentHtml(setup.firstHeaderHtml),
      firstFooter: setup.firstFooterHtml === null ? null : sanitizeDocumentHtml(setup.firstFooterHtml),
    }),
    [setup],
  );

  useLayoutEffect(() => {
    const editor = editorRef.current;
    const scroller = scrollerRef.current;
    if (!editor || !scroller) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const origin = scroller.getBoundingClientRect();
      const next = Array.from(editor.querySelectorAll<HTMLElement>(":scope > section.document-page")).map(
        (sheet) => {
          const rect = sheet.getBoundingClientRect();
          return {
            top: rect.top - origin.top + scroller.scrollTop,
            left: rect.left - origin.left + scroller.scrollLeft,
            width: rect.width,
            height: rect.height,
          };
        },
      );
      setSheets((current) => (sameBoxes(current, next) ? current : next));
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    measure();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(editor);
    resize?.observe(scroller);
    const mutation = new MutationObserver(schedule);
    mutation.observe(editor, { childList: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resize?.disconnect();
      mutation.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [editorRef, scrollerRef, layoutKey, zoom]);

  // Header/footer tab stops are re-measured once their copies are on screen.
  useLayoutEffect(() => {
    layerRef.current
      ?.querySelectorAll<HTMLElement>(".document-page-chrome-content")
      .forEach((content) => relayoutDocumentTabs(content));
  }, [sheets, safe, zoom]);

  if (!sheets.length || (!safe.header && !safe.footer && !safe.firstHeader && !safe.firstFooter)) {
    return null;
  }
  const textStyle = {
    fontFamily: setup.fontFamily,
    fontSize: `${setup.fontSizePx}px`,
    lineHeight: String(setup.lineHeight),
    color: setup.color,
  };
  return (
    <div ref={layerRef} className="document-page-chrome" aria-hidden="true">
      {sheets.map((sheet, index) => {
        const chrome = pageChromeHtml(
          {
            ...setup,
            headerHtml: safe.header,
            footerHtml: safe.footer,
            firstHeaderHtml: safe.firstHeader,
            firstFooterHtml: safe.firstFooter,
          },
          index,
        );
        const left = sheet.left + geometry.padLeftPx * zoom;
        const visualWidth = Math.max(40, sheet.width - (geometry.padLeftPx + geometry.padRightPx) * zoom);
        const inner = { ...textStyle, width: `${visualWidth / zoom}px`, zoom: zoom !== 1 ? zoom : undefined };
        return (
          <div key={index}>
            {chrome.header.trim() ? (
              <div
                className="document-page-chrome-box is-header"
                style={{ top: sheet.top + geometry.headerTopPx * zoom, left, width: visualWidth }}
              >
                <div
                  className="document-page-chrome-content"
                  style={inner}
                  dangerouslySetInnerHTML={{ __html: headerFooterHtmlForPage(chrome.header, index + 1, sheets.length) }}
                />
              </div>
            ) : null}
            {chrome.footer.trim() ? (
              <div
                className="document-page-chrome-box is-footer"
                style={{ top: sheet.top + sheet.height - geometry.footerBottomPx * zoom, left, width: visualWidth }}
              >
                <div
                  className="document-page-chrome-content"
                  style={inner}
                  dangerouslySetInnerHTML={{ __html: headerFooterHtmlForPage(chrome.footer, index + 1, sheets.length) }}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
