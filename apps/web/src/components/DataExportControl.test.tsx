import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { importXlsxWorkbook } from "../lib/sheet/xlsxImport";
import type { ExportColumn } from "../lib/tabularExport";
import { DataExportControl } from "./DataExportControl";

const excelFailure = vi.hoisted(() => ({ active: false }));

vi.mock("../lib/tabularExcel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tabularExcel")>();
  return {
    ...actual,
    buildExportXlsx: (request: Parameters<typeof actual.buildExportXlsx>[0]) => {
      if (excelFailure.active) throw new Error("writer failed");
      return actual.buildExportXlsx(request);
    },
  };
});

type Row = { id: string; at: string; note: string };

const ROWS: Row[] = [
  { id: "new", at: "2026-07-01T12:00:00Z", note: "kept" },
  { id: "old", at: "2026-06-01T12:00:00Z", note: "dropped" },
];
const COLUMNS: Array<ExportColumn<Row>> = [
  { header: "id", value: (row) => row.id },
  { header: "at", kind: "datetime", value: (row) => row.at },
  { header: "note", value: (row) => row.note },
];

let downloads: Array<{ blob: Blob; filename: string }>;
let pending: Blob[];

beforeEach(() => {
  downloads = [];
  pending = [];
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn((blob: Blob) => {
      pending.push(blob);
      return "blob:export";
    }),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function record(this: HTMLAnchorElement) {
    downloads.push({ blob: pending[pending.length - 1], filename: this.download });
  });
});

afterEach(() => {
  excelFailure.active = false;
  vi.restoreAllMocks();
});

function renderControl(rows: Row[] = ROWS) {
  render(
    <DataExportControl
      label="runtime analytics"
      filenameBase="aperture-runtime"
      items={rows}
      getTimestamp={(row) => row.at}
      columns={COLUMNS}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Export runtime analytics" }));
}

async function blobBytes(blob: Blob) {
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

async function blobText(blob: Blob) {
  return new TextDecoder().decode(await blobBytes(blob));
}

test("Excel is the first choice and downloads a real workbook", async () => {
  renderControl();
  expect(screen.getByRole("radio", { name: "Excel workbook" })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Download 2 rows" }));
  await waitFor(() => expect(downloads).toHaveLength(1));
  expect(downloads[0].filename).toBe("aperture-runtime-all-dates.xlsx");
  const { workbook } = await importXlsxWorkbook(await blobBytes(downloads[0].blob));
  expect(workbook.sheets[0].name).toBe("Runtime analytics");
  expect(workbook.sheets[0].cells.A2?.v).toBe("new");
  expect(workbook.sheets[0].tables?.[0]?.ref).toBe("A1:C3");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

test("CSV stays available for anyone who wants it", async () => {
  renderControl();
  fireEvent.click(screen.getByRole("radio", { name: "CSV file" }));
  fireEvent.click(screen.getByRole("button", { name: "Download 2 rows" }));
  await waitFor(() => expect(downloads).toHaveLength(1));
  expect(downloads[0].filename).toBe("aperture-runtime-all-dates.csv");
  expect(await blobText(downloads[0].blob)).toContain("id,at,note");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("a workbook that cannot be built says so and offers CSV, and nothing downloads", async () => {
  excelFailure.active = true;
  renderControl();
  fireEvent.click(screen.getByRole("button", { name: "Download 2 rows" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("The Excel file could not be built. Try again, or choose CSV file.");
  expect(downloads).toHaveLength(0);
  expect(screen.getByRole("button", { name: "Download 2 rows" })).toBeEnabled();
});

test("a good download clears an earlier failure message", async () => {
  excelFailure.active = true;
  renderControl();
  fireEvent.click(screen.getByRole("button", { name: "Download 2 rows" }));
  await screen.findByRole("alert");
  excelFailure.active = false;
  fireEvent.click(screen.getByRole("radio", { name: "CSV file" }));
  fireEvent.click(screen.getByRole("button", { name: "Download 2 rows" }));
  await waitFor(() => expect(downloads).toHaveLength(1));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("no rows means nothing to download", () => {
  renderControl();
  fireEvent.change(screen.getByLabelText("runtime analytics start date"), { target: { value: "2030-01-01" } });
  expect(screen.getByRole("button", { name: "Download 0 rows" })).toBeDisabled();
});

test("the button stays pressed-out while the workbook is being built", async () => {
  renderControl();
  const download = screen.getByRole("button", { name: "Download 2 rows" });
  fireEvent.click(download);
  expect(download).toBeDisabled();
  await waitFor(() => expect(downloads).toHaveLength(1));
});

test("dates narrow the rows, the count, and the file name", async () => {
  renderControl();
  fireEvent.change(screen.getByLabelText("runtime analytics start date"), { target: { value: "2026-06-15" } });
  expect(screen.getByText("1 of 2 rows selected")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "CSV file" }));
  fireEvent.click(screen.getByRole("button", { name: "Download 1 row" }));
  await waitFor(() => expect(downloads).toHaveLength(1));
  expect(downloads[0].filename).toBe("aperture-runtime-from_2026-06-15.csv");
  const csv = await blobText(downloads[0].blob);
  expect(csv).toContain("kept");
  expect(csv).not.toContain("dropped");
});

test("All dates clears a narrowed range", () => {
  renderControl();
  fireEvent.change(screen.getByLabelText("runtime analytics start date"), { target: { value: "2026-06-15" } });
  fireEvent.click(screen.getByRole("button", { name: "All dates" }));
  expect(screen.getByText("2 of 2 rows selected")).toBeInTheDocument();
});

test("a shortened Excel cell is said out loud and the panel stays open", async () => {
  renderControl([{ id: "long", at: "2026-07-01T12:00:00Z", note: "x".repeat(40_000) }]);
  fireEvent.click(screen.getByRole("button", { name: "Download 1 row" }));
  await waitFor(() => expect(downloads).toHaveLength(1));
  expect(await screen.findByRole("status")).toHaveTextContent(/32,767-character limit/);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Download 1 row" })).toBeEnabled();
});
