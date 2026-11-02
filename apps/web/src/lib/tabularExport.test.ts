import { expect, test } from "vitest";
import { importXlsxWorkbook } from "./sheet/xlsxImport";
import { buildExportWorkbook, buildExportXlsx } from "./tabularExcel";
import {
  exportFilenamePart,
  exportHeaderLabel,
  exportRangeLabel,
  rowsToCsv,
  type ExportColumn,
} from "./tabularExport";

type Row = { id: string; when: string | null; prompt: string; tokens: number | null; redacted: boolean };

const COLUMNS: Array<ExportColumn<Row>> = [
  { header: "id", value: (row) => row.id },
  { header: "created_at", kind: "datetime", value: (row) => row.when },
  { header: "prompt", value: (row) => row.prompt },
  { header: "total_tokens", value: (row) => row.tokens },
  { header: "redacted", value: (row) => row.redacted },
];

const ROWS: Row[] = [
  { id: "r1", when: "2026-07-01T12:00:00Z", prompt: 'Say "hi", then stop', tokens: 1200, redacted: false },
  { id: "r2", when: null, prompt: "=HYPERLINK(\"http://example.test\")", tokens: null, redacted: true },
];

function cell(address: string, workbook = buildExportWorkbook({ sheetName: "Runtime", rows: ROWS, columns: COLUMNS })) {
  return workbook.sheets[0].cells[address];
}

test("CSV keeps raw field names and quotes what needs quoting", () => {
  expect(rowsToCsv(ROWS, COLUMNS).split("\r\n")).toEqual([
    "id,created_at,prompt,total_tokens,redacted",
    'r1,2026-07-01T12:00:00Z,"Say ""hi"", then stop",1200,false',
    'r2,,"=HYPERLINK(""http://example.test"")",,true',
  ]);
});

test("Excel headers read as words people use", () => {
  expect(exportHeaderLabel("actor_name")).toBe("Actor name");
  expect(exportHeaderLabel("thread_id")).toBe("Thread ID");
  expect(exportHeaderLabel("id")).toBe("ID");
  expect(exportHeaderLabel("metadata_json")).toBe("Metadata JSON");
  expect(cell("B1")?.v).toBe("Created at");
});

test("numbers and yes/no values stay real values, and blanks stay blank", () => {
  expect(cell("D2")?.v).toBe(1200);
  expect(cell("E3")?.v).toBe(true);
  expect(cell("D3")).toBeUndefined();
  expect(cell("B3")).toBeUndefined();
});

test("timestamps become real dates that Excel can sort and filter", () => {
  const when = "2026-07-01T12:34:56Z";
  const rows: Row[] = [{ id: "r1", when, prompt: "", tokens: 0, redacted: false }];
  const stamp = buildExportWorkbook({ sheetName: "Runtime", rows, columns: COLUMNS }).sheets[0].cells.B2;
  expect(stamp?.s?.format).toBe("mmm d, yyyy h:mm:ss AM/PM");
  const expected = new Date(when);
  const local = Date.UTC(
    expected.getFullYear(),
    expected.getMonth(),
    expected.getDate(),
    expected.getHours(),
    expected.getMinutes(),
    expected.getSeconds(),
  );
  expect(stamp?.v).toBeCloseTo(local / 86_400_000 + 25569, 6);
});

test("text that only looks like a date stays text outside a date column", () => {
  const rows: Row[] = [{ id: "r1", when: null, prompt: "2026-07-01T12:00:00Z", tokens: 0, redacted: false }];
  const sheet = buildExportWorkbook({ sheetName: "Runtime", rows, columns: COLUMNS }).sheets[0];
  expect(sheet.cells.C2?.v).toBe("2026-07-01T12:00:00Z");
});

test("an empty value leaves an empty cell", () => {
  const rows: Row[] = [{ id: "r1", when: null, prompt: "", tokens: null, redacted: false }];
  const sheet = buildExportWorkbook({ sheetName: "Runtime", rows, columns: COLUMNS }).sheets[0];
  expect(sheet.cells.C2).toBeUndefined();
});

test("a timestamp that cannot be read stays as the text it was", () => {
  const rows: Row[] = [{ id: "r3", when: "just now", prompt: "", tokens: 0, redacted: false }];
  const workbook = buildExportWorkbook({ sheetName: "Runtime", rows, columns: COLUMNS });
  expect(workbook.sheets[0].cells.B2?.v).toBe("just now");
});

test("text that looks like a formula stays text", () => {
  const prompt = cell("C3");
  expect(prompt?.v).toBe('=HYPERLINK("http://example.test")');
  expect(prompt?.f).toBeUndefined();
});

test("the rows form a filterable Excel table under a frozen header", () => {
  const sheet = buildExportWorkbook({ sheetName: "Runtime", rows: ROWS, columns: COLUMNS }).sheets[0];
  expect(sheet.tables).toHaveLength(1);
  expect(sheet.tables?.[0]).toMatchObject({ ref: "A1:E3", accent: 1, banded: true, filterButtons: true, totals: false });
  expect(sheet.freeze).toEqual({ rows: 1, cols: 0 });
});

test("a single row is still a table", () => {
  const sheet = buildExportWorkbook({ sheetName: "Runtime", rows: ROWS.slice(0, 1), columns: COLUMNS }).sheets[0];
  expect(sheet.tables?.[0]?.ref).toBe("A1:E2");
});

test("no rows still gives a header row, without a table Excel would have to repair", () => {
  const sheet = buildExportWorkbook({ sheetName: "Runtime", rows: [], columns: COLUMNS }).sheets[0];
  expect(sheet.cells.A1?.v).toBe("ID");
  expect(sheet.tables ?? []).toHaveLength(0);
});

test("columns fit their header and values, within sensible limits", () => {
  const rows: Row[] = [
    { id: "a-thirty-character-identifier!", when: null, prompt: "x".repeat(5000), tokens: 1, redacted: false },
    { id: "short", when: null, prompt: "", tokens: 2, redacted: false },
  ];
  const cols = buildExportWorkbook({ sheetName: "Runtime", rows, columns: COLUMNS }).sheets[0].cols;
  expect(cols?.A?.w).toBe(240);
  expect(cols?.B?.w).toBe(116);
  expect(cols?.C?.w).toBe(420);
  expect(cols?.E?.w).toBe(100);
});

test("a very short column still has room for its filter button", () => {
  const columns: Array<ExportColumn<Row>> = [{ header: "n", value: () => 1 }];
  const cols = buildExportWorkbook({ sheetName: "Runtime", rows: ROWS, columns }).sheets[0].cols;
  expect(cols?.A?.w).toBe(80);
});

test("a sheet name Excel would refuse is cleaned", () => {
  const workbook = buildExportWorkbook({ sheetName: "Jane's: usage/records? and a very long tail of words", rows: ROWS, columns: COLUMNS });
  expect(workbook.sheets[0].name).toBe("Jane's usagerecords and a very");
  expect(workbook.sheets[0].name.length).toBeLessThanOrEqual(31);
});

test("the downloaded file opens as the same table", async () => {
  const { bytes, warnings } = buildExportXlsx({ sheetName: "Runtime", rows: ROWS, columns: COLUMNS });
  expect(warnings).toEqual([]);
  const { workbook } = await importXlsxWorkbook(bytes);
  const sheet = workbook.sheets[0];
  expect(sheet.name).toBe("Runtime");
  expect(sheet.cells.A1?.v).toBe("ID");
  expect(sheet.cells.D2?.v).toBe(1200);
  expect(sheet.cells.C3?.v).toBe('=HYPERLINK("http://example.test")');
  expect(sheet.cells.C3?.f).toBeUndefined();
  expect(sheet.tables?.[0]?.ref).toBe("A1:E3");
  expect(sheet.freeze).toEqual({ rows: 1, cols: 0 });
});

test("a cell past Excel's limit is reported, not silently cut", () => {
  const rows: Row[] = [{ id: "r1", when: null, prompt: "y".repeat(40_000), tokens: 1, redacted: false }];
  const { warnings } = buildExportXlsx({ sheetName: "Runtime", rows, columns: COLUMNS });
  expect(warnings.join(" ")).toMatch(/shortened|limit|cut/i);
});

test("range labels name the dates in the file name", () => {
  expect(exportRangeLabel("", "")).toBe("all-dates");
  expect(exportRangeLabel("2026-07-01", "")).toBe("from_2026-07-01");
  expect(exportRangeLabel("", "2026-07-02")).toBe("through_2026-07-02");
  expect(exportRangeLabel("2026-07-01", "2026-07-02")).toBe("2026-07-01_to_2026-07-02");
});

test("names become safe file name parts", () => {
  expect(exportFilenamePart("Jane O'Neil / Admin")).toBe("jane-o-neil-admin");
  expect(exportFilenamePart("***")).toBe("selected-user");
});
