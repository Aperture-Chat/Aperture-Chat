/** A synthetic "Regional sales" workbook that exercises every feature the
 * .xlsx export writes. Tests assert against it and the QA scripts export it
 * for openpyxl, LibreOffice, and Excel to open. All data is made up. */

import { parseWorkbook, type SheetCell, type Workbook } from "../sheetModel";

type Input = string | number | boolean;

function cells(entries: Record<string, Input | SheetCell>): Record<string, SheetCell> {
  return Object.fromEntries(Object.entries(entries).map(([address, input]) => {
    if (typeof input === "object") return [address, input];
    if (typeof input === "string" && input.startsWith("=")) return [address, { f: input.slice(1) }];
    return [address, { v: input }];
  }));
}

const SALES_ROWS: [string, string, string, number, number][] = [
  ["East", "Avery", "Widget", 120, 12.5],
  ["West", "Blake", "Gadget", 80, 24],
  ["North", "Casey", "Widget", 150, 12.5],
  ["South", "Devon", "Gizmo", 60, 31.75],
  ["East", "Emery", "Gadget", 95, 24],
  ["West", "Finley", "Gizmo", 40, 31.75],
  ["North", "Gray", "Gadget", 110, 24],
  ["South", "Harper", "Widget", 75, 12.5],
];

function salesCells(): Record<string, SheetCell> {
  const header = { bold: true, color: "#ffffff" };
  const out: Record<string, SheetCell> = {
    A1: { v: "Region", s: header },
    B1: { v: "Rep", s: header },
    C1: { v: "Product", s: header },
    D1: { v: "Units", s: header },
    E1: { v: "Unit Price", s: header },
    F1: { v: "Revenue", s: header },
    H1: { v: "Notes", s: { bold: true, align: "center" } },
    A10: { v: "Total", s: { bold: true } },
    D10: { f: "SUBTOTAL(109,Sales[Units])", s: { bold: true, format: "#,##0" } },
    F10: { f: "SUBTOTAL(109,Sales[Revenue])", s: { bold: true, format: "#,##0.00" } },
  };
  SALES_ROWS.forEach(([region, rep, product, units, price], index) => {
    const row = index + 2;
    out[`A${row}`] = { v: region };
    out[`B${row}`] = { v: rep };
    out[`C${row}`] = { v: product };
    out[`D${row}`] = { v: units, s: { format: "#,##0" } };
    out[`E${row}`] = { v: price, s: { format: "\"$\"#,##0.00" } };
    out[`F${row}`] = { f: "Sales[@Units]*Sales[@Unit Price]", s: { format: "#,##0.00" } };
  });
  out.A2 = { ...out.A2, n: "Top region this quarter." };
  out.H2 = { v: "Bad\u0001char" };
  return out;
}

const COUNTRIES = [
  "Argentina", "Australia", "Austria", "Belgium", "Brazil", "Canada", "Chile", "Colombia", "Denmark", "Egypt",
  "Finland", "France", "Germany", "Greece", "Iceland", "India", "Indonesia", "Ireland", "Italy", "Japan",
  "Kenya", "Mexico", "Morocco", "Netherlands", "New Zealand", "Norway", "Peru", "Poland", "Portugal", "Spain",
  "Sweden", "Switzerland", "Thailand", "Turkey", "Uganda", "Ukraine", "United Kingdom", "Uruguay", "Vietnam", "Zambia",
];

export function regionalSalesWorkbook(): Workbook {
  const parsed = parseWorkbook({
    names: [
      { name: "Regions", ref: "Summary!A2:A5" },
      { name: "TaxRate", ref: "Summary!B12" },
    ],
    sheets: [
      {
        id: "sales",
        name: "Regional sales",
        color: "#087d8b",
        cells: salesCells(),
        cols: { A: { w: 110 }, B: { w: 120 }, C: { w: 140 }, G: { hidden: true }, I: { w: 160 } },
        rows: { 1: { h: 30 } },
        freeze: { rows: 1, cols: 1 },
        merges: ["H1:I1"],
        tables: [{ id: "t-sales", name: "Sales", ref: "A1:F10", accent: 1, tone: "medium", banded: true, totals: true, filterButtons: true }],
        conditional: [
          { id: "cf-scale", ref: "D2:D9", type: "scale", min: "#f8696b", mid: "#ffeb84", max: "#63be7b" },
          { id: "cf-bar", ref: "F2:F9", type: "bar", color: "#2f6eba" },
          { id: "cf-cell", ref: "E2:E9", type: "cell", op: "gt", value: "20", style: { fill: "#fdeecf", color: "#7a4a00" } },
          { id: "cf-between", ref: "D2:D9", type: "cell", op: "between", value: "50", value2: "100", style: { bold: true } },
          { id: "cf-text", ref: "C2:C9", type: "text", op: "contains", text: "Widget", style: { fill: "#d1e7dd" } },
          { id: "cf-begins", ref: "B2:B9", type: "text", op: "begins", text: "B", style: { color: "#2f6eba" } },
          { id: "cf-top", ref: "F2:F9", type: "top", count: 3, style: { bold: true } },
          { id: "cf-bottom", ref: "F2:F9", type: "bottom", count: 10, percent: true, style: { fill: "#f8d7da" } },
          { id: "cf-dup", ref: "A2:A9", type: "duplicate", style: { fill: "#e2e3e5" } },
          { id: "cf-unique", ref: "B2:B9", type: "unique", style: { fill: "#cfe2ff" } },
          { id: "cf-above", ref: "D2:D9", type: "above", style: { color: "#3d8b5a" } },
          { id: "cf-below", ref: "D2:D9", type: "below", style: { color: "#c2475a" } },
          { id: "cf-blank", ref: "H2:H9", type: "blank", style: { fill: "#efece5" } },
          { id: "cf-notblank", ref: "H2:H9", type: "notBlank", style: { fill: "#fff3cd" } },
          { id: "cf-formula", ref: "A2:F9", type: "formula", formula: "AND($D2>100,$E2<20)", style: { bold: true, color: "#087d8b" } },
        ],
        validations: [
          { id: "dv-region", ref: "A2:A9", kind: "list", items: ["East", "West", "North", "South"], strict: true, message: "Pick a region from the list." },
          { id: "dv-units", ref: "D2:D9", kind: "whole", op: "between", value: "0", value2: "1000", strict: false, message: "Units are 0 to 1,000." },
          { id: "dv-country", ref: "I2:I9", kind: "list", items: COUNTRIES, strict: true },
          { id: "dv-price", ref: "E2:E9", kind: "decimal", op: "gte", value: "0", strict: true },
        ],
      },
      {
        id: "summary",
        name: "Summary",
        color: "#c9821a",
        gridlines: false,
        cells: cells({
          A1: { v: "Region", s: { bold: true, font: "Georgia", size: 14, color: "#213c3f", align: "center", border: { bottom: { style: "double", color: "#087d8b" } } } },
          B1: { v: "Revenue", s: { bold: true, border: { bottom: { style: "double", color: "#087d8b" } } } },
          C1: { v: "Units", s: { bold: true, border: { bottom: { style: "double", color: "#087d8b" } } } },
          D1: { v: "Share", s: { bold: true, border: { bottom: { style: "double", color: "#087d8b" } } } },
          A2: "East", A3: "West", A4: "North", A5: "South",
          B2: { v: 3780, s: { format: "#,##0", border: { top: { style: "thin" }, bottom: { style: "thin" } } } },
          B3: { v: 3190, s: { format: "#,##0" } },
          B4: { v: 4515, s: { format: "#,##0" } },
          B5: { v: 2842.5, s: { format: "#,##0" } },
          C2: 215, C3: 120, C4: 260, C5: 135,
          D2: { f: "B2/SUM($B$2:$B$5)", s: { format: "0%" } },
          D3: { f: "B3/SUM($B$2:$B$5)", s: { format: "0%" } },
          D4: { f: "B4/SUM($B$2:$B$5)", s: { format: "0%" } },
          D5: { f: "B5/SUM($B$2:$B$5)", s: { format: "0%" } },
          F1: { v: "Doubled units", s: { bold: true } },
          F2: "=C2:C5*2",
          A7: "Lookup", B7: "=XLOOKUP(\"North\",A2:A5,B2:B5)",
          A8: "Band", B8: "=IFS(B7>4000,\"High\",B7>3000,\"Mid\",TRUE,\"Low\")",
          A9: "Over 3,000", B9: "=FILTER(A2:A5,B2:B5>3000)",
          D9: "=IFERROR(1/0,\"n/a\")",
          A10: { v: "Hidden helper row" },
          A12: "Tax rate", B12: { v: 0.08, s: { format: "0.0%" } },
          A13: "Taxed total", B13: { f: "SUM(B2:B5)*(1+TaxRate)", s: { format: "#,##0.00", italic: true, underline: true, strike: true } },
          A14: "Is big", B14: "=B13>10000",
        }),
        cols: { A: { w: 120, s: { fill: "#efece5" } }, F: { w: 110 } },
        rows: { 10: { hidden: true }, 12: { s: { italic: true } } },
        charts: [
          { id: "c-col", type: "column", title: "Revenue and units by region", source: "A1:C5", seriesBy: "columns", legend: "bottom", showValues: true, xTitle: "Region", yTitle: "Amount", at: "H2", w: 480, h: 300 },
          { id: "c-pie", type: "pie", title: "Revenue share", source: "A1:B5", seriesBy: "columns", legend: "right", at: "H20", w: 360, h: 280 },
        ],
      },
      {
        id: "pivot",
        name: "Pivot",
        cells: cells({ A1: { v: "Units and revenue by region", s: { bold: true, size: 13 } } }),
        pivots: [{ id: "p-region", name: "RegionPivot", source: "'Regional sales'!A1:F9", at: "A3", rows: ["Region"], values: [{ field: "Units", agg: "sum" }, { field: "Revenue", agg: "sum" }] }],
        charts: [
          { id: "c-line", type: "line", title: "Units per order", source: "'Regional sales'!D1:D9", seriesBy: "columns", legend: "none", at: "E3", w: 420, h: 260 },
        ],
      },
      {
        id: "leads",
        name: "Leads",
        cells: cells({
          A1: "Company", B1: "Stage", C1: "Opened", D1: "Value",
          A2: "Northwind", B2: "Open", C2: { v: 46000, s: { format: "m/d/yyyy" } }, D2: 1200,
          A3: "Contoso", B3: "Won", C3: { v: 46010, s: { format: "m/d/yyyy" } }, D3: 5400,
          A4: "Fabrikam", B4: "Open", C4: { v: 46020, s: { format: "m/d/yyyy" } }, D4: 860,
          A5: "Tailspin", B5: "Lost", C5: { v: 46030, s: { format: "m/d/yyyy" } }, D5: 3100,
          A6: "Litware", B6: "Open", C6: { v: 46040, s: { format: "m/d/yyyy" } }, D6: 2750,
          F1: "Big deals", F2: "=D2:D6>2000",
        }),
        filter: { ref: "A1:D6", criteria: { B: { values: ["Open"] }, D: { condition: { op: "gt", value: "1000" } } } },
        charts: [
          { id: "c-scatter", type: "scatter", title: "Value over time", source: "C1:D6", seriesBy: "columns", legend: "none", xTitle: "Opened", yTitle: "Value", at: "H2", w: 400, h: 260 },
        ],
      },
      {
        id: "archive",
        name: "Archive",
        hidden: true,
        color: "#7a5ac8",
        cells: cells({ A1: "Archived", A2: 2024, B2: true }),
      },
    ],
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.workbook;
}
