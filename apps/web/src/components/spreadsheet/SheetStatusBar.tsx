import { Keyboard, Minus, Plus, TextSearch } from "lucide-react";
import { useMemo } from "react";
import type { CellRange } from "../../lib/sheet/address";
import { formatCellValue } from "../../lib/sheet/numberFormat";
import type { WorkbookEngine } from "../../lib/sheet/recalc";
import { selectionStats } from "../../lib/sheet/selectionStats";
import type { Sheet, Workbook } from "../../lib/sheet/sheetModel";
import { effectiveStyle } from "../../lib/sheet/sheetOps";
import { DOCUMENT_ZOOM_STEPS } from "../DocumentStatusBar";

type Props = {
  engine: WorkbookEngine;
  workbook: Workbook;
  sheet: Sheet;
  range: CellRange;
  zoom: number;
  onZoom: (value: number) => void;
  onOpenFind: () => void;
  onShowShortcuts: () => void;
};

/** The document status bar, read for a workbook: which sheet, Excel's Sum,
 * Average, and Count of the selection, then find, shortcuts, and zoom. */
export function SheetStatusBar({ engine, workbook, sheet, range, zoom, onZoom, onOpenFind, onShowShortcuts }: Props) {
  const stats = useMemo(() => selectionStats(engine, sheet.id, range), [engine, sheet.id, range]);
  const format = effectiveStyle(sheet, range.r1, range.c1)?.format;
  const show = (value: number) => formatCellValue(Number(value.toPrecision(15)), format).text;
  const single = range.r1 === range.r2 && range.c1 === range.c2;
  const visible = workbook.sheets.filter((item) => !item.hidden);
  const position = Math.max(0, visible.findIndex((item) => item.id === sheet.id)) + 1;
  // Zoom only ever takes a stop's exact value (or 100%), so stops compare directly.
  const stepDown = DOCUMENT_ZOOM_STEPS.filter((step) => step < zoom).pop();
  const stepUp = DOCUMENT_ZOOM_STEPS.find((step) => step > zoom);
  return (
    <footer className="document-status-bar sheet-statusbar" aria-label="Spreadsheet status">
      <div className="document-status-facts sheet-stats" role="status" aria-live="polite">
        <span>Sheet {position} of {visible.length}</span>
        {!single && stats.numbers > 0 && (
          <>
            <span>Sum <strong>{show(stats.sum)}</strong></span>
            <span>Average <strong>{show(stats.sum / stats.numbers)}</strong></span>
            <span className="document-status-optional">Min <strong>{show(stats.min)}</strong></span>
            <span className="document-status-optional">Max <strong>{show(stats.max)}</strong></span>
          </>
        )}
        {!single && stats.count > 0 && <span>Count <strong>{stats.count.toLocaleString("en-US")}</strong></span>}
      </div>
      <div className="document-status-tools">
        <button type="button" aria-label="Find and replace" data-tooltip="Find and replace (⌘F)" onClick={onOpenFind}>
          <TextSearch size={14} />
          <span>Find</span>
        </button>
        <button type="button" aria-label="Keyboard shortcuts" data-tooltip="Keyboard shortcuts (⌘/)" onClick={onShowShortcuts}>
          <Keyboard size={14} />
        </button>
        <div className="document-zoom" role="group" aria-label="Zoom">
          <button type="button" aria-label="Zoom out" disabled={stepDown === undefined} onClick={() => stepDown !== undefined && onZoom(stepDown)}>
            <Minus size={13} />
          </button>
          <button
            type="button"
            className="document-zoom-value"
            aria-label={`Zoom ${Math.round(zoom * 100)} percent. Reset to 100 percent`}
            data-tooltip="Reset zoom to 100%"
            onClick={() => onZoom(1)}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" aria-label="Zoom in" disabled={stepUp === undefined} onClick={() => stepUp !== undefined && onZoom(stepUp)}>
            <Plus size={13} />
          </button>
        </div>
      </div>
    </footer>
  );
}
