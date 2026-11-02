import { Download } from "lucide-react";
import { useState } from "react";
import { triggerBlobDownload } from "../lib/clipboard";
import { csvBlob, exportRangeLabel, type ExportColumn, type ExportFormat } from "../lib/tabularExport";
import { XLSX_MIME_TYPE } from "../lib/sheet/xlsxMime";
import { RailSwitch, type RailSwitchOption } from "./RailSwitch";
import { timestampInDateRange } from "./SectionScopeFilter";

const FORMAT_OPTIONS: Array<RailSwitchOption<ExportFormat>> = [
  { value: "xlsx", label: "Excel workbook" },
  { value: "csv", label: "CSV file" },
];

function sentenceCase(label: string) {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

async function excelFile<T>(label: string, rows: T[], columns: Array<ExportColumn<T>>) {
  // The workbook writer is large and only an Excel download needs it.
  const { buildExportXlsx } = await import("../lib/tabularExcel");
  const { bytes, warnings } = buildExportXlsx({ sheetName: sentenceCase(label), rows, columns });
  return { blob: new Blob([bytes.slice().buffer], { type: XLSX_MIME_TYPE }), warnings };
}

/** Export button for a list of records: pick dates and a file type, then download. */
export function DataExportControl<T>({
  label,
  filenameBase,
  items,
  getTimestamp,
  columns,
}: {
  /** Names the records in lower case, such as "audit trail". */
  label: string;
  filenameBase: string;
  items: T[];
  getTimestamp: (item: T) => string;
  columns: Array<ExportColumn<T>>;
}) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<ExportFormat>("xlsx");
  const [fromDate, setFromDate] = useState("");
  const [throughDate, setThroughDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const filteredItems = items.filter((item) => timestampInDateRange(getTimestamp(item), fromDate, throughDate));
  const filename = `${filenameBase}-${exportRangeLabel(fromDate, throughDate)}.${format}`;

  async function download() {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      if (format === "csv") {
        triggerBlobDownload(csvBlob(filteredItems, columns), filename);
        setOpen(false);
        return;
      }
      const { blob, warnings } = await excelFile(label, filteredItems, columns);
      triggerBlobDownload(blob, filename);
      if (warnings.length > 0) setNotice(`${warnings.join(" ")} The CSV file keeps the full text.`);
      else setOpen(false);
    } catch {
      setProblem("The Excel file could not be built. Try again, or choose CSV file.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="data-export-control">
      <button
        className="secondary-button compact"
        type="button"
        aria-label={`Export ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tooltip={`Choose dates and a file type, then download ${label}`}
        onClick={() => setOpen((value) => !value)}
      >
        <Download size={14} /> Export
      </button>
      {open && (
        <div className="data-export-popover" role="dialog" aria-label={`Export ${label}`}>
          <div>
            <strong>Export {label}</strong>
            <small>{filteredItems.length.toLocaleString()} of {items.length.toLocaleString()} rows selected</small>
          </div>
          <RailSwitch options={FORMAT_OPTIONS} value={format} onChange={setFormat} ariaLabel="File type" block />
          <label>
            From
            <input
              type="date"
              aria-label={`${label} start date`}
              value={fromDate}
              onChange={(event) => setFromDate(event.target.value)}
            />
          </label>
          <label>
            Through
            <input
              type="date"
              aria-label={`${label} end date`}
              value={throughDate}
              onChange={(event) => setThroughDate(event.target.value)}
            />
          </label>
          {problem && <p className="data-export-message" role="alert">{problem}</p>}
          {notice && <p className="data-export-message" role="status">{notice}</p>}
          <div className="data-export-actions">
            <button
              className="secondary-button compact"
              type="button"
              onClick={() => {
                setFromDate("");
                setThroughDate("");
              }}
            >
              All dates
            </button>
            <button className="primary-button compact" type="button" disabled={busy || filteredItems.length === 0} onClick={download}>
              Download {filteredItems.length.toLocaleString()} row{filteredItems.length === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
