import { describe, expect, it } from "vitest";
import { readZip, type ZipParts } from "../ooxmlZipRead";
import { SHEET_ACCENTS, pxToExcelWidth } from "./palette";
import { parseWorkbook, type Workbook } from "./sheetModel";
import { regionalSalesWorkbook } from "./xlsx/sampleWorkbook";
import { buildXlsxWorkbook, xlsxExportFilename } from "./xlsxExport";

const NOW = new Date(Date.UTC(2026, 9, 29, 12, 0, 0));

type Package = {
  warnings: string[];
  parts: ZipParts;
  text: (name: string) => string;
  doc: (name: string) => Document;
};

async function exportPackage(workbook: Workbook = regionalSalesWorkbook()): Promise<Package> {
  const result = buildXlsxWorkbook(workbook, { title: "Regional sales", now: NOW });
  const parts = await readZip(result.bytes);
  const text = (name: string) => {
    const bytes = parts.get(name);
    if (!bytes) throw new Error(`Missing part ${name}`);
    return new TextDecoder().decode(bytes);
  };
  const doc = (name: string) => {
    const parsed = new DOMParser().parseFromString(text(name), "application/xml");
    expect(parsed.getElementsByTagName("parsererror"), name).toHaveLength(0);
    return parsed;
  };
  return { warnings: result.warnings, parts, text, doc };
}

function book(raw: unknown): Workbook {
  const parsed = parseWorkbook(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.workbook;
}

const all = (node: Document | Element, tag: string) => Array.from(node.getElementsByTagName(tag));
const one = (node: Document | Element, tag: string) => {
  const found = node.getElementsByTagName(tag)[0];
  if (!found) throw new Error(`No <${tag}>`);
  return found;
};
const attr = (node: Element, name: string) => node.getAttribute(name);

function cell(doc: Document, ref: string): Element {
  const found = all(doc, "c").find((item) => attr(item, "r") === ref);
  if (!found) throw new Error(`No cell ${ref}`);
  return found;
}

function sharedStrings(pkg: Package): string[] {
  return all(pkg.doc("xl/sharedStrings.xml"), "si").map((si) => si.textContent ?? "");
}

function cellValue(pkg: Package, sheet: string, ref: string): string | number | boolean | null {
  const c = cell(pkg.doc(sheet), ref);
  const v = c.getElementsByTagName("v")[0]?.textContent ?? null;
  if (v === null) return null;
  switch (attr(c, "t")) {
    case "s":
      return sharedStrings(pkg)[Number(v)];
    case "b":
      return v === "1";
    case "str":
    case "e":
      return v;
    default:
      return Number(v);
  }
}

const formulaOf = (pkg: Package, sheet: string, ref: string) => cell(pkg.doc(sheet), ref).getElementsByTagName("f")[0]?.textContent ?? null;

function sheetRels(pkg: Package, index: number): Map<string, { type: string; target: string }> {
  const rels = pkg.doc(`xl/worksheets/_rels/sheet${index}.xml.rels`);
  return new Map(all(rels, "Relationship").map((rel) => [attr(rel, "Id")!, { type: attr(rel, "Type")!.split("/").pop()!, target: attr(rel, "Target")! }]));
}

const SALES = "xl/worksheets/sheet1.xml";
const SUMMARY = "xl/worksheets/sheet2.xml";
const PIVOT = "xl/worksheets/sheet3.xml";
const LEADS = "xl/worksheets/sheet4.xml";

describe("xlsx package", () => {
  it("writes every part well-formed and declares each in [Content_Types].xml", async () => {
    const pkg = await exportPackage();
    const names = Array.from(pkg.parts.keys());
    for (const name of names) if (name.endsWith(".xml") || name.endsWith(".rels")) pkg.doc(name);
    const types = pkg.doc("[Content_Types].xml");
    const overrides = new Set(all(types, "Override").map((item) => attr(item, "PartName")));
    const defaults = new Set(all(types, "Default").map((item) => attr(item, "Extension")));
    for (const name of names) {
      const extension = name.split(".").pop()!;
      expect(overrides.has(`/${name}`) || defaults.has(extension), name).toBe(true);
    }
    for (const part of overrides) expect(pkg.parts.has(part!.slice(1)), part!).toBe(true);
    expect(names).toEqual(expect.arrayContaining([
      "_rels/.rels", "docProps/core.xml", "docProps/app.xml", "xl/workbook.xml", "xl/_rels/workbook.xml.rels",
      "xl/styles.xml", "xl/theme/theme1.xml", "xl/sharedStrings.xml", "xl/metadata.xml", "xl/tables/table1.xml",
      "xl/drawings/drawing1.xml", "xl/charts/chart1.xml", "xl/comments1.xml", "xl/drawings/vmlDrawing1.vml",
    ]));
  });

  it("resolves every relationship target to a part in the package", async () => {
    const pkg = await exportPackage();
    for (const name of Array.from(pkg.parts.keys()).filter((item) => item.endsWith(".rels"))) {
      const base = name.replace(/_rels\/[^/]*\.rels$/, "");
      for (const rel of all(pkg.doc(name), "Relationship")) {
        const target = new URL(attr(rel, "Target")!, `file:///${base}`).pathname.slice(1);
        expect(pkg.parts.has(target), `${name} -> ${target}`).toBe(true);
      }
    }
  });

  it("records the title and a W3C timestamp in the core properties", async () => {
    const core = (await exportPackage()).text("docProps/core.xml");
    expect(core).toContain("<dc:title>Regional sales</dc:title>");
    expect(core).toContain(`<dcterms:created xsi:type="dcterms:W3CDTF">2026-10-29T12:00:00Z</dcterms:created>`);
  });

  it("writes a complete Office theme whose accents are the workbook palette", async () => {
    const theme = (await exportPackage()).doc("xl/theme/theme1.xml");
    const accents = [1, 2, 3, 4, 5, 6].map((slot) => attr(one(one(theme, `a:accent${slot}`), "a:srgbClr"), "val"));
    expect(accents).toEqual(Object.values(SHEET_ACCENTS).map((color) => color.slice(1).toUpperCase()));
    for (const tag of ["a:dk1", "a:lt1", "a:dk2", "a:lt2", "a:hlink", "a:folHlink", "a:majorFont", "a:minorFont"]) one(theme, tag);
    expect(one(theme, "a:fillStyleLst").children).toHaveLength(3);
    expect(one(theme, "a:lnStyleLst").children).toHaveLength(3);
    expect(one(theme, "a:effectStyleLst").children).toHaveLength(3);
    expect(one(theme, "a:bgFillStyleLst").children).toHaveLength(3);
  });

  it("names the download after the title", () => {
    expect(xlsxExportFilename("  Q3: Regional / sales  ")).toBe("Q3 Regional sales.xlsx");
    expect(xlsxExportFilename("")).toBe("workbook.xlsx");
  });
});

describe("workbook.xml", () => {
  it("lists sheets with hidden states, a visible active tab, and recalculation on open", async () => {
    const wb = (await exportPackage()).doc("xl/workbook.xml");
    const sheets = all(wb, "sheet").map((sheet) => [attr(sheet, "name"), attr(sheet, "state")]);
    expect(sheets.slice(0, 5)).toEqual([["Regional sales", null], ["Summary", null], ["Pivot", null], ["Leads", null], ["Archive", "hidden"]]);
    expect(attr(one(wb, "workbookView"), "activeTab")).toBe("0");
    expect(attr(one(wb, "calcPr"), "fullCalcOnLoad")).toBe("1");
    expect(attr(one(wb, "calcPr"), "calcId")).toBe("191029");
  });

  it("writes defined names with absolute references and a hidden filter database", async () => {
    const wb = (await exportPackage()).doc("xl/workbook.xml");
    const names = Object.fromEntries(all(wb, "definedName").map((name) => [attr(name, "name"), name]));
    expect(names.Regions.textContent).toBe("Summary!$A$2:$A$5");
    expect(names.TaxRate.textContent).toBe("Summary!$B$12");
    const database = names["_xlnm._FilterDatabase"];
    expect([attr(database, "localSheetId"), attr(database, "hidden"), database.textContent]).toEqual(["3", "1", "Leads!$A$1:$D$6"]);
  });

  it("makes the first visible sheet active when the first sheet is hidden", async () => {
    const pkg = await exportPackage(book({ sheets: [{ name: "Hidden", hidden: true, cells: {} }, { name: "Shown", cells: { A1: { v: 1 } } }] }));
    expect(attr(one(pkg.doc("xl/workbook.xml"), "workbookView"), "activeTab")).toBe("1");
    expect(attr(one(pkg.doc("xl/worksheets/sheet2.xml"), "sheetView"), "tabSelected")).toBe("1");
    expect(attr(one(pkg.doc("xl/worksheets/sheet1.xml"), "sheetView"), "tabSelected")).toBeNull();
  });
});

describe("cells", () => {
  it("stores text as shared strings and numbers and booleans by type", async () => {
    const pkg = await exportPackage();
    expect(cellValue(pkg, SALES, "A2")).toBe("East");
    expect(attr(cell(pkg.doc(SALES), "A2"), "t")).toBe("s");
    expect(cellValue(pkg, SALES, "D2")).toBe(120);
    expect(cellValue(pkg, SALES, "E4")).toBe(12.5);
    expect(cellValue(pkg, "xl/worksheets/sheet5.xml", "B2")).toBe(true);
    const sst = one(pkg.doc("xl/sharedStrings.xml"), "sst");
    expect(Number(attr(sst, "count"))).toBeGreaterThan(Number(attr(sst, "uniqueCount")));
  });

  it("writes formulas without '=' and with the file prefixes newer functions need", async () => {
    const pkg = await exportPackage();
    expect(formulaOf(pkg, SUMMARY, "B7")).toBe("_xlfn.XLOOKUP(\"North\",A2:A5,B2:B5)");
    expect(formulaOf(pkg, SUMMARY, "B8")).toBe("_xlfn.IFS(B7>4000,\"High\",B7>3000,\"Mid\",TRUE,\"Low\")");
    expect(formulaOf(pkg, SUMMARY, "B9")).toBe("_xlfn._xlws.FILTER(A2:A5,B2:B5>3000)");
    expect(formulaOf(pkg, SALES, "F2")).toBe("Sales[[#This Row],[Units]]*Sales[[#This Row],[Unit Price]]");
    expect(formulaOf(pkg, SALES, "F10")).toBe("SUBTOTAL(109,Sales[Revenue])");
  });

  it("caches the engine's results by type", async () => {
    const pkg = await exportPackage();
    expect(cellValue(pkg, SUMMARY, "D2")).toBeCloseTo(3780 / 14327.5, 10);
    expect(cellValue(pkg, SALES, "F2")).toBe(1500);
    expect(cellValue(pkg, SUMMARY, "D9")).toBe("n/a");
    expect(attr(cell(pkg.doc(SUMMARY), "D9"), "t")).toBe("str");
    expect(cellValue(pkg, SUMMARY, "B14")).toBe(true);
    expect(attr(cell(pkg.doc(SUMMARY), "B14"), "t")).toBe("b");
  });

  it("writes errors with t=\"e\" and new error kinds as #VALUE!", async () => {
    const pkg = await exportPackage(book({ sheets: [{ name: "S", cells: { A1: { f: "1/0" }, B1: { v: 1 }, C1: { f: "A1:A3" }, C2: { v: "x" } } }] }));
    const sheet = "xl/worksheets/sheet1.xml";
    expect([attr(cell(pkg.doc(sheet), "A1"), "t"), cellValue(pkg, sheet, "A1")]).toEqual(["e", "#DIV/0!"]);
    expect([attr(cell(pkg.doc(sheet), "C1"), "t"), cellValue(pkg, sheet, "C1")]).toEqual(["e", "#VALUE!"]);
  });

  it("exports a formula Excel could not read as its text, with a warning", async () => {
    const pkg = await exportPackage(book({ sheets: [{ name: "S", cells: { A1: { f: "SUM(A2:" } } }] }));
    expect(formulaOf(pkg, "xl/worksheets/sheet1.xml", "A1")).toBeNull();
    expect(cellValue(pkg, "xl/worksheets/sheet1.xml", "A1")).toBe("=SUM(A2:");
    expect(pkg.warnings).toContain("Exported 1 formula Excel cannot read as text.");
  });

  it("writes each row's cells in column order with their styles, whatever order they were entered in", async () => {
    const pkg = await exportPackage(book({ sheets: [{ name: "S", cells: { C1: { f: "A1*2", s: { bold: true } }, A1: { v: 1 }, B1: { f: "Z99" }, E1: { v: false }, D1: { v: 0 } } }] }));
    const sheet = "xl/worksheets/sheet1.xml";
    expect(all(pkg.doc(sheet), "c").map((item) => attr(item, "r"))).toEqual(["A1", "B1", "C1", "D1", "E1"]);
    expect([cellValue(pkg, sheet, "D1"), cellValue(pkg, sheet, "E1")]).toEqual([0, false]);
    expect(Number(attr(cell(pkg.doc(sheet), "C1"), "s"))).toBeGreaterThan(0);
    expect(attr(cell(pkg.doc(sheet), "A1"), "s")).toBeNull();
    expect(formulaOf(pkg, sheet, "B1")).toBe("Z99");
    expect(cell(pkg.doc(sheet), "B1").getElementsByTagName("v")).toHaveLength(0);
  });

  it("strips characters XML cannot hold from formulas too", async () => {
    const pkg = await exportPackage(book({ sheets: [{ name: "S", cells: { A1: { f: "\"a\u0002b\"&\"c\"" } } }] }));
    expect(formulaOf(pkg, "xl/worksheets/sheet1.xml", "A1")).toBe("\"ab\"&\"c\"");
    expect(pkg.warnings).toContain("Removed characters Excel cannot store from 1 cell.");
  });

  it("strips characters XML cannot hold and warns", async () => {
    const pkg = await exportPackage();
    expect(cellValue(pkg, SALES, "H2")).toBe("Badchar");
    expect(pkg.warnings).toContain("Removed characters Excel cannot store from 1 cell.");
  });
});

describe("dynamic arrays", () => {
  it("writes a spilled formula as a dynamic array with its spill range and cached values", async () => {
    const pkg = await exportPackage();
    const anchor = cell(pkg.doc(SUMMARY), "F2");
    const f = one(anchor, "f");
    expect([attr(f, "t"), attr(f, "ref"), f.textContent, attr(anchor, "cm")]).toEqual(["array", "F2:F5", "C2:C5*2", "1"]);
    expect(["F2", "F3", "F4", "F5"].map((ref) => cellValue(pkg, SUMMARY, ref))).toEqual([430, 240, 520, 270]);
    expect(cell(pkg.doc(SUMMARY), "F3").getElementsByTagName("f")).toHaveLength(0);
  });

  it("caches spilled text as formula results, not shared strings", async () => {
    const pkg = await exportPackage(book({ sheets: [{ name: "S", cells: { A1: { v: "x" }, A2: { v: "y" }, C1: { f: "A1:A2" } } }] }));
    const sheet = "xl/worksheets/sheet1.xml";
    expect([attr(cell(pkg.doc(sheet), "C2"), "t"), cellValue(pkg, sheet, "C2")]).toEqual(["str", "y"]);
  });

  it("marks array-capable formulas as dynamic even when they return one value", async () => {
    const pkg = await exportPackage(book({ sheets: [{ name: "S", cells: { A1: { v: 5 }, B1: { f: "A1:A1*2" }, C1: { f: "A1*2" } } }] }));
    const sheet = "xl/worksheets/sheet1.xml";
    const f = one(cell(pkg.doc(sheet), "B1"), "f");
    expect([attr(f, "t"), attr(f, "ref"), attr(cell(pkg.doc(sheet), "B1"), "cm")]).toEqual(["array", "B1", "1"]);
    expect(cellValue(pkg, sheet, "B1")).toBe(10);
    expect(attr(one(cell(pkg.doc(sheet), "C1"), "f"), "t")).toBeNull();
    expect(cell(pkg.doc(sheet), "C1").hasAttribute("cm")).toBe(false);
  });

  it("declares the XLDAPR dynamic-array metadata Excel 365 writes", async () => {
    const pkg = await exportPackage();
    const metadata = pkg.doc("xl/metadata.xml");
    expect(attr(one(metadata, "metadataType"), "name")).toBe("XLDAPR");
    expect(attr(one(metadata, "futureMetadata"), "name")).toBe("XLDAPR");
    expect(attr(one(metadata, "xda:dynamicArrayProperties"), "fDynamic")).toBe("1");
    expect([attr(one(metadata, "rc"), "t"), attr(one(metadata, "rc"), "v")]).toEqual(["1", "0"]);
    const rels = all(pkg.doc("xl/_rels/workbook.xml.rels"), "Relationship").map((rel) => attr(rel, "Target"));
    expect(rels).toContain("metadata.xml");
  });

  it("leaves metadata out when no formula is a dynamic array", async () => {
    const pkg = await exportPackage(book({ sheets: [{ name: "S", cells: { A1: { v: 1 }, A2: { f: "A1+1" } } }] }));
    expect(pkg.parts.has("xl/metadata.xml")).toBe(false);
  });

  it("keeps formulas inside tables plain and spills that would overlap a table as values", async () => {
    const pkg = await exportPackage(book({
      sheets: [{
        name: "S",
        cells: { A1: { v: "N" }, A2: { v: 1 }, A3: { v: 2 }, B1: { v: "Twice" }, B2: { f: "T[@N]*2" }, B3: { f: "T[@N]*2" }, D3: { f: "A2:A3" } },
        tables: [{ id: "t", name: "T", ref: "A1:B3" }, { id: "u", name: "U", ref: "D2:E4" }],
      }],
    }));
    const sheet = "xl/worksheets/sheet1.xml";
    expect(attr(one(cell(pkg.doc(sheet), "B2"), "f"), "t")).toBeNull();
    expect(attr(one(cell(pkg.doc(sheet), "D3"), "f"), "t")).toBeNull();
    expect(cellValue(pkg, sheet, "D4")).toBe(2);
    expect(pkg.warnings.some((warning) => warning.includes("S!D3") && warning.includes("spill"))).toBe(true);
  });
});

describe("styles and layout", () => {
  it("maps fonts, borders, and number formats onto deduplicated cell formats", async () => {
    const pkg = await exportPackage();
    const styles = pkg.doc("xl/styles.xml");
    const xfs = all(one(styles, "cellXfs"), "xf");
    const xfOf = (sheet: string, ref: string) => xfs[Number(attr(cell(pkg.doc(sheet), ref), "s") ?? 0)];
    const a1 = xfOf(SUMMARY, "A1");
    const font = all(one(styles, "fonts"), "font")[Number(attr(a1, "fontId"))];
    expect(attr(one(font, "name"), "val")).toBe("Georgia");
    expect(attr(one(font, "sz"), "val")).toBe("14");
    expect(font.getElementsByTagName("b")).toHaveLength(1);
    const border = all(one(styles, "borders"), "border")[Number(attr(a1, "borderId"))];
    expect(attr(one(border, "bottom"), "style")).toBe("double");
    const fill = all(one(styles, "fills"), "fill")[Number(attr(a1, "fillId"))];
    expect(attr(one(fill, "fgColor"), "rgb")).toBe("FFEFECE5");
    const formats = Object.fromEntries(all(styles, "numFmt").map((item) => [attr(item, "numFmtId"), attr(item, "formatCode")]));
    const formatOf = (sheet: string, ref: string) => {
      const id = attr(xfOf(sheet, ref), "numFmtId")!;
      return Number(id) >= 164 ? formats[id] : id;
    };
    expect(formatOf(SALES, "E2")).toBe("\"$\"#,##0.00");
    expect(attr(xfOf(SALES, "E2"), "numFmtId")).toBe(attr(xfOf(SALES, "E3"), "numFmtId"));
    expect(attr(cell(pkg.doc(SALES), "E2"), "s")).toBe(attr(cell(pkg.doc(SALES), "E3"), "s"));
    expect(["14", "m/d/yyyy"]).toContain(formatOf(LEADS, "C2"));
  });

  it("merges column, row, and cell styles, including empty cells where a styled row crosses a styled column", async () => {
    const pkg = await exportPackage(book({
      sheets: [{ name: "S", cells: { B1: { v: 1, s: { bold: true } } }, cols: { B: { s: { fill: "#efece5" } } }, rows: { 1: { s: { italic: true } }, 3: { s: { italic: true } } } }],
    }));
    const sheet = "xl/worksheets/sheet1.xml";
    const styles = pkg.doc("xl/styles.xml");
    const xfs = all(one(styles, "cellXfs"), "xf");
    const look = (ref: string) => {
      const xf = xfs[Number(attr(cell(pkg.doc(sheet), ref), "s"))];
      const font = all(one(styles, "fonts"), "font")[Number(attr(xf, "fontId"))];
      const fill = all(one(styles, "fills"), "fill")[Number(attr(xf, "fillId"))];
      return { bold: font.getElementsByTagName("b").length, italic: font.getElementsByTagName("i").length, fill: attr(one(fill, "patternFill"), "patternType") };
    };
    expect(look("B1")).toEqual({ bold: 1, italic: 1, fill: "solid" });
    expect(look("B3")).toEqual({ bold: 0, italic: 1, fill: "solid" });
    expect(all(pkg.doc(sheet), "c").map((item) => attr(item, "r"))).toEqual(["B1", "B3"]);
    expect(cell(pkg.doc(sheet), "B3").getElementsByTagName("v")).toHaveLength(0);
  });

  it("writes column widths, row heights, hidden rows and columns, and row and column styles", async () => {
    const pkg = await exportPackage();
    const cols = all(pkg.doc(SALES), "col").map((col) => [attr(col, "min"), attr(col, "width"), attr(col, "customWidth"), attr(col, "hidden")]);
    // 110px is 15 characters in Excel's UI; the file adds the 5px cell padding.
    expect(pxToExcelWidth(110)).toBe(15);
    expect(cols).toContainEqual(["1", "15.7109375", "1", null]);
    expect(cols).toContainEqual(["7", "14.28125", null, "1"]);
    const row1 = all(pkg.doc(SALES), "row")[0];
    expect([attr(row1, "r"), attr(row1, "ht"), attr(row1, "customHeight")]).toEqual(["1", "22.5", "1"]);
    const summaryRows = new Map(all(pkg.doc(SUMMARY), "row").map((row) => [attr(row, "r"), row]));
    expect(attr(summaryRows.get("10")!, "hidden")).toBe("1");
    expect(attr(summaryRows.get("12")!, "customFormat")).toBe("1");
    expect(Number(attr(summaryRows.get("12")!, "s"))).toBeGreaterThan(0);
    expect(Number(attr(all(pkg.doc(SUMMARY), "col")[0], "style"))).toBeGreaterThan(0);
    expect(attr(one(pkg.doc(SALES), "sheetFormatPr"), "defaultRowHeight")).toBe("15");
  });

  it("writes tab colors, frozen panes, hidden gridlines, merges, and the used range", async () => {
    const pkg = await exportPackage();
    const sales = pkg.doc(SALES);
    expect(attr(one(sales, "tabColor"), "rgb")).toBe("FF087D8B");
    const pane = one(sales, "pane");
    expect([attr(pane, "xSplit"), attr(pane, "ySplit"), attr(pane, "topLeftCell"), attr(pane, "state"), attr(pane, "activePane")]).toEqual(["1", "1", "B2", "frozen", "bottomRight"]);
    expect(attr(one(sales, "sheetView"), "showGridLines")).toBeNull();
    expect(attr(one(pkg.doc(SUMMARY), "sheetView"), "showGridLines")).toBe("0");
    expect(attr(one(sales, "mergeCell"), "ref")).toBe("H1:I1");
    expect(attr(one(sales, "dimension"), "ref")).toBe("A1:H10");
  });

  it("orders worksheet children as CT_Worksheet requires", async () => {
    const pkg = await exportPackage();
    const order = ["sheetPr", "dimension", "sheetViews", "sheetFormatPr", "cols", "sheetData", "autoFilter", "mergeCells", "conditionalFormatting", "dataValidations", "pageMargins", "drawing", "legacyDrawing", "tableParts"];
    for (const name of [SALES, SUMMARY, PIVOT, LEADS]) {
      const children = Array.from(pkg.doc(name).documentElement.children, (child) => child.tagName);
      const positions = children.map((tag) => order.indexOf(tag));
      expect(positions.every((position) => position >= 0), `${name}: ${children.join(",")}`).toBe(true);
      expect(positions, name).toEqual([...positions].sort((a, b) => a - b));
    }
  });
});

describe("conditional formats", () => {
  it("maps every rule type with unique priorities and dxf styles", async () => {
    const pkg = await exportPackage();
    const rules = all(pkg.doc(SALES), "cfRule");
    const types = rules.map((rule) => attr(rule, "type"));
    expect(types).toEqual([
      "colorScale", "dataBar", "cellIs", "cellIs", "containsText", "beginsWith", "top10", "top10",
      "duplicateValues", "uniqueValues", "aboveAverage", "aboveAverage", "containsBlanks", "notContainsBlanks", "expression",
    ]);
    expect(new Set(rules.map((rule) => attr(rule, "priority"))).size).toBe(rules.length);
    const byType = (type: string, index = 0) => rules.filter((rule) => attr(rule, "type") === type)[index];
    expect(all(byType("colorScale"), "cfvo").map((cfvo) => attr(cfvo, "type"))).toEqual(["min", "percentile", "max"]);
    expect(all(byType("colorScale"), "color").map((color) => attr(color, "rgb"))).toEqual(["FFF8696B", "FFFFEB84", "FF63BE7B"]);
    expect(attr(one(byType("dataBar"), "color"), "rgb")).toBe("FF2F6EBA");
    expect([attr(byType("cellIs"), "operator"), one(byType("cellIs"), "formula").textContent]).toEqual(["greaterThan", "20"]);
    expect(all(byType("cellIs", 1), "formula").map((item) => item.textContent)).toEqual(["50", "100"]);
    expect([attr(byType("containsText"), "operator"), attr(byType("containsText"), "text"), one(byType("containsText"), "formula").textContent])
      .toEqual(["containsText", "Widget", "NOT(ISERROR(SEARCH(\"Widget\",C2)))"]);
    expect(one(byType("beginsWith"), "formula").textContent).toBe("LEFT(B2,LEN(\"B\"))=\"B\"");
    expect([attr(byType("top10"), "rank"), attr(byType("top10"), "bottom")]).toEqual(["3", null]);
    expect([attr(byType("top10", 1), "rank"), attr(byType("top10", 1), "bottom"), attr(byType("top10", 1), "percent")]).toEqual(["10", "1", "1"]);
    expect(attr(byType("aboveAverage", 1), "aboveAverage")).toBe("0");
    expect(one(byType("containsBlanks"), "formula").textContent).toBe("LEN(TRIM(H2))=0");
    expect(one(byType("expression"), "formula").textContent).toBe("AND($D2>100,$E2<20)");
    const dxfs = all(pkg.doc("xl/styles.xml"), "dxf");
    expect(attr(one(dxfs[Number(attr(byType("cellIs"), "dxfId"))], "bgColor"), "rgb")).toBe("FFFDEECF");
    expect(byType("colorScale").hasAttribute("dxfId")).toBe(false);
  });
});

describe("data validations", () => {
  it("writes inline lists, numeric rules, error styles, and keeps the dropdown arrow", async () => {
    const pkg = await exportPackage();
    const rules = Object.fromEntries(all(pkg.doc(SALES), "dataValidation").map((rule) => [attr(rule, "sqref"), rule]));
    const region = rules["A2:A9"];
    expect([attr(region, "type"), attr(region, "errorStyle"), attr(region, "showErrorMessage"), attr(region, "showDropDown")]).toEqual(["list", null, "1", null]);
    expect(one(region, "formula1").textContent).toBe("\"East,West,North,South\"");
    expect(attr(region, "error")).toBe("Pick a region from the list.");
    const units = rules["D2:D9"];
    expect([attr(units, "type"), attr(units, "operator"), attr(units, "errorStyle")]).toEqual(["whole", "between", "warning"]);
    expect([one(units, "formula1").textContent, one(units, "formula2").textContent]).toEqual(["0", "1000"]);
    expect([attr(rules["E2:E9"], "type"), attr(rules["E2:E9"], "operator")]).toEqual(["decimal", "greaterThanOrEqual"]);
  });

  it("moves lists longer than Excel's 255-character limit onto a hidden sheet", async () => {
    const pkg = await exportPackage();
    const country = all(pkg.doc(SALES), "dataValidation").find((rule) => attr(rule, "sqref") === "I2:I9")!;
    expect(one(country, "formula1").textContent).toBe("'Dropdown lists'!$A$1:$A$40");
    const sheets = all(pkg.doc("xl/workbook.xml"), "sheet");
    expect([attr(sheets[5], "name"), attr(sheets[5], "state")]).toEqual(["Dropdown lists", "hidden"]);
    expect(cellValue(pkg, "xl/worksheets/sheet6.xml", "A30")).toBe("Spain");
  });
});

describe("tables", () => {
  it("writes the table part with columns from the header row, totals, and the accent style", async () => {
    const pkg = await exportPackage();
    const table = one(pkg.doc("xl/tables/table1.xml"), "table");
    expect([attr(table, "id"), attr(table, "name"), attr(table, "displayName"), attr(table, "ref"), attr(table, "totalsRowCount")]).toEqual(["1", "Sales", "Sales", "A1:F10", "1"]);
    expect(attr(one(table, "autoFilter"), "ref")).toBe("A1:F9");
    const columns = all(table, "tableColumn");
    expect(columns.map((column) => attr(column, "name"))).toEqual(["Region", "Rep", "Product", "Units", "Unit Price", "Revenue"]);
    expect(columns.map((column) => attr(column, "id"))).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(attr(columns[0], "totalsRowLabel")).toBe("Total");
    expect(attr(columns[5], "totalsRowFunction")).toBe("custom");
    expect(one(columns[5], "totalsRowFormula").textContent).toBe("SUBTOTAL(109,Sales[Revenue])");
    const style = one(table, "tableStyleInfo");
    expect([attr(style, "name"), attr(style, "showRowStripes"), attr(style, "showFirstColumn")]).toEqual(["TableStyleMedium2", "1", "0"]);
    const rels = sheetRels(pkg, 1);
    expect(Array.from(rels.values())).toContainEqual({ type: "table", target: "../tables/table1.xml" });
  });

  it("maps tone and accent to Excel's built-in table styles", async () => {
    const tones = { light: "TableStyleLight11", medium: "TableStyleMedium4", dark: "TableStyleDark4" };
    for (const [tone, expected] of Object.entries(tones)) {
      const pkg = await exportPackage(book({ sheets: [{ name: "S", cells: { A1: { v: "A" }, A2: { v: 1 } }, tables: [{ id: "t", name: "T", ref: "A1:A2", accent: 3, tone, banded: false, filterButtons: false }] }] }));
      const table = one(pkg.doc("xl/tables/table1.xml"), "table");
      expect(attr(one(table, "tableStyleInfo"), "name")).toBe(expected);
      expect(attr(one(table, "tableStyleInfo"), "showRowStripes")).toBe("0");
      expect(table.getElementsByTagName("autoFilter")).toHaveLength(0);
      expect(attr(table, "totalsRowShown")).toBe("0");
    }
  });

  it("names blank and duplicate header cells uniquely and writes the names into the header row", async () => {
    const pkg = await exportPackage(book({
      sheets: [{ name: "S", cells: { A1: { v: "Amount" }, B1: { v: "amount" }, D1: { v: 2024 }, A2: { v: 1 } }, tables: [{ id: "t", name: "T", ref: "A1:D2" }] }],
    }));
    const names = all(pkg.doc("xl/tables/table1.xml"), "tableColumn").map((column) => attr(column, "name"));
    expect(names).toEqual(["Amount", "amount2", "Column3", "2024"]);
    const sheet = "xl/worksheets/sheet1.xml";
    expect(["A1", "B1", "C1", "D1"].map((ref) => cellValue(pkg, sheet, ref))).toEqual(names);
  });

  it("drops a table that overlaps another and merges inside a table, with warnings", async () => {
    const pkg = await exportPackage(book({
      sheets: [{
        name: "S",
        cells: { A1: { v: "A" }, B1: { v: "B" }, A2: { v: 1 } },
        merges: ["A2:B2"],
        tables: [{ id: "t", name: "T", ref: "A1:B3" }, { id: "u", name: "U", ref: "B2:C4" }],
      }],
    }));
    expect(pkg.parts.has("xl/tables/table2.xml")).toBe(false);
    expect(pkg.doc("xl/worksheets/sheet1.xml").getElementsByTagName("mergeCell")).toHaveLength(0);
    expect(pkg.warnings).toEqual(expect.arrayContaining([
      "Table \"U\" on S overlaps another table and was left out.",
      "Merged cells A2:B2 on S overlap a table and were unmerged.",
    ]));
  });
});

describe("charts", () => {
  it("anchors one drawing per sheet with a frame for each chart", async () => {
    const pkg = await exportPackage();
    const drawing = pkg.doc("xl/drawings/drawing1.xml");
    const anchors = all(drawing, "xdr:oneCellAnchor");
    expect(anchors).toHaveLength(2);
    const from = one(anchors[0], "xdr:from");
    expect([one(from, "xdr:col").textContent, one(from, "xdr:row").textContent]).toEqual(["7", "1"]);
    expect([attr(one(anchors[0], "xdr:ext"), "cx"), attr(one(anchors[0], "xdr:ext"), "cy")]).toEqual([String(480 * 9525), String(300 * 9525)]);
    const rels = Array.from(sheetRels(pkg, 2).values());
    expect(rels).toContainEqual({ type: "drawing", target: "../drawings/drawing1.xml" });
    const drawingRels = all(pkg.doc("xl/drawings/_rels/drawing1.xml.rels"), "Relationship").map((rel) => attr(rel, "Target"));
    expect(drawingRels).toEqual(["../charts/chart1.xml", "../charts/chart2.xml"]);
  });

  it("writes a clustered column chart with series, caches, colors, labels, and axis titles", async () => {
    const chart = (await exportPackage()).doc("xl/charts/chart1.xml");
    const bar = one(chart, "c:barChart");
    expect(attr(one(bar, "c:barDir"), "val")).toBe("col");
    expect(attr(one(bar, "c:grouping"), "val")).toBe("clustered");
    const series = all(bar, "c:ser");
    expect(series).toHaveLength(2);
    expect(one(one(series[0], "c:tx"), "c:f").textContent).toBe("Summary!$B$1");
    expect(one(one(series[0], "c:cat"), "c:f").textContent).toBe("Summary!$A$2:$A$5");
    expect(one(one(series[0], "c:val"), "c:f").textContent).toBe("Summary!$B$2:$B$5");
    expect(all(one(series[0], "c:numCache"), "c:v").map((v) => v.textContent)).toEqual(["3780", "3190", "4515", "2842.5"]);
    expect(all(one(series[0], "c:strCache"), "c:v").map((v) => v.textContent)).toEqual(["Revenue"]);
    expect(all(one(one(series[0], "c:cat"), "c:strCache"), "c:v").map((v) => v.textContent)).toEqual(["East", "West", "North", "South"]);
    expect(attr(one(one(series[0], "c:spPr"), "a:srgbClr"), "val")).toBe("087D8B");
    expect(attr(one(one(series[1], "c:spPr"), "a:srgbClr"), "val")).toBe("2F6EBA");
    expect(attr(one(one(bar, "c:dLbls"), "c:showVal"), "val")).toBe("1");
    expect(one(one(chart, "c:title"), "a:t").textContent).toBe("Revenue and units by region");
    expect(attr(one(one(chart, "c:legend"), "c:legendPos"), "val")).toBe("b");
    expect(one(one(chart, "c:catAx"), "a:t").textContent).toBe("Region");
    expect(one(one(chart, "c:valAx"), "a:t").textContent).toBe("Amount");
    // Category labels stay at the plot's edge even when values go negative.
    expect(attr(one(one(chart, "c:catAx"), "c:tickLblPos"), "val")).toBe("low");
    expect(attr(one(one(chart, "c:valAx"), "c:tickLblPos"), "val")).toBe("nextTo");
  });

  it("writes pie, line, and scatter charts with their own structure", async () => {
    const pkg = await exportPackage();
    const pie = pkg.doc("xl/charts/chart2.xml");
    expect(all(one(pie, "c:pieChart"), "c:ser")).toHaveLength(1);
    expect(all(pie, "c:dPt")).toHaveLength(4);
    expect(attr(one(one(pie, "c:legend"), "c:legendPos"), "val")).toBe("r");
    expect(pie.getElementsByTagName("c:catAx")).toHaveLength(0);
    const line = pkg.doc("xl/charts/chart3.xml");
    expect(one(one(one(line, "c:lineChart"), "c:val"), "c:f").textContent).toBe("'Regional sales'!$D$2:$D$9");
    expect(line.getElementsByTagName("c:cat")).toHaveLength(0);
    expect(line.getElementsByTagName("c:legend")).toHaveLength(0);
    const scatter = pkg.doc("xl/charts/chart4.xml");
    const ser = one(one(scatter, "c:scatterChart"), "c:ser");
    expect(one(one(ser, "c:xVal"), "c:f").textContent).toBe("Leads!$C$2:$C$6");
    expect(one(one(ser, "c:yVal"), "c:f").textContent).toBe("Leads!$D$2:$D$6");
    expect(all(scatter, "c:valAx")).toHaveLength(2);
  });

  it("stacks, rows-as-series, doughnut holes, and areas", async () => {
    const pkg = await exportPackage(book({
      sheets: [{
        name: "Data",
        cells: { A1: { v: "" }, B1: { v: "Q1" }, C1: { v: "Q2" }, A2: { v: "East" }, B2: { v: 1 }, C2: { v: 2 }, A3: { v: "West" }, B3: { v: 3 }, C3: { v: 4 } },
        charts: [
          { id: "a", type: "bar", source: "A1:C3", seriesBy: "rows", stacked: true, legend: "top", at: "E1", w: 300, h: 200 },
          { id: "b", type: "doughnut", source: "A1:B3", seriesBy: "columns", legend: "bottom", at: "E20", w: 300, h: 200 },
          { id: "c", type: "area", source: "A1:C3", seriesBy: "columns", stacked: true, legend: "bottom", at: "E40", w: 300, h: 200 },
        ],
      }],
    }));
    const bar = pkg.doc("xl/charts/chart1.xml");
    expect(attr(one(bar, "c:barDir"), "val")).toBe("bar");
    expect(attr(one(bar, "c:grouping"), "val")).toBe("stacked");
    expect(attr(one(bar, "c:overlap"), "val")).toBe("100");
    const series = all(bar, "c:ser");
    expect(one(one(series[0], "c:tx"), "c:f").textContent).toBe("Data!$A$2");
    expect(one(one(series[0], "c:val"), "c:f").textContent).toBe("Data!$B$2:$C$2");
    expect(one(one(series[0], "c:cat"), "c:f").textContent).toBe("Data!$B$1:$C$1");
    expect(attr(one(pkg.doc("xl/charts/chart2.xml"), "c:holeSize"), "val")).toBe("50");
    expect(attr(one(pkg.doc("xl/charts/chart3.xml"), "c:grouping"), "val")).toBe("stacked");
  });
});

describe("notes", () => {
  it("writes comments by Aperture plus the VML that shows Excel's red indicator", async () => {
    const pkg = await exportPackage();
    const comments = pkg.doc("xl/comments1.xml");
    expect(one(comments, "author").textContent).toBe("Aperture");
    expect([attr(one(comments, "comment"), "ref"), one(comments, "comment").textContent]).toEqual(["A2", "Top region this quarter."]);
    const vml = pkg.text("xl/drawings/vmlDrawing1.vml");
    expect(vml).toContain("<x:Row>1</x:Row>");
    expect(vml).toContain("<x:Column>0</x:Column>");
    expect(vml).toContain(`ObjectType="Note"`);
    expect(vml).toContain(`<o:idmap v:ext="edit" data="1"/>`);
    expect(vml).toContain(`id="_x0000_s1025"`);
    const rels = Array.from(sheetRels(pkg, 1).values());
    expect(rels).toContainEqual({ type: "comments", target: "../comments1.xml" });
    expect(rels).toContainEqual({ type: "vmlDrawing", target: "../drawings/vmlDrawing1.vml" });
    one(pkg.doc(SALES), "legacyDrawing");
  });
});

describe("pivots", () => {
  it("writes pivot output as styled values and warns that it is static", async () => {
    const pkg = await exportPackage();
    expect(["A3", "B3", "C3"].map((ref) => cellValue(pkg, PIVOT, ref))).toEqual(["Region", "Sum of Units", "Sum of Revenue"]);
    expect(cellValue(pkg, PIVOT, "A4")).toBe("East");
    expect(cellValue(pkg, PIVOT, "B4")).toBe(215);
    expect(cellValue(pkg, PIVOT, "A8")).toBe("Grand Total");
    expect(cellValue(pkg, PIVOT, "B8")).toBe(730);
    expect(formulaOf(pkg, PIVOT, "B4")).toBeNull();
    const styles = pkg.doc("xl/styles.xml");
    const xfs = all(one(styles, "cellXfs"), "xf");
    const fontOf = (ref: string) => all(one(styles, "fonts"), "font")[Number(attr(xfs[Number(attr(cell(pkg.doc(PIVOT), ref), "s") ?? 0)], "fontId"))];
    expect(fontOf("A3").getElementsByTagName("b")).toHaveLength(1);
    expect(fontOf("B8").getElementsByTagName("b")).toHaveLength(1);
    expect(fontOf("B4").getElementsByTagName("b")).toHaveLength(0);
    const headerFill = all(one(styles, "fills"), "fill")[Number(attr(xfs[Number(attr(cell(pkg.doc(PIVOT), "B3"), "s"))], "fillId"))];
    expect(attr(one(headerFill, "patternFill"), "patternType")).toBe("solid");
    // Accent 1 (#087d8b) lightened 80% toward white, as the editor shows it.
    expect(attr(one(headerFill, "fgColor"), "rgb")).toBe("FFCEE5E8");
    const totalBorder = all(one(styles, "borders"), "border")[Number(attr(xfs[Number(attr(cell(pkg.doc(PIVOT), "B8"), "s"))], "borderId"))];
    expect([attr(one(totalBorder, "top"), "style"), attr(one(one(totalBorder, "top"), "color"), "rgb")]).toEqual(["thin", "FF087D8B"]);
    expect(pkg.warnings).toContain("Pivot tables export as values.");
  });
});

describe("pivots that cannot be computed", () => {
  it("leaves the pivot out with a warning", async () => {
    const pkg = await exportPackage(book({
      sheets: [{ name: "S", cells: { A1: { v: "Region" }, A2: { v: "East" } }, pivots: [{ id: "p", name: "Broken", source: "A1:A2", at: "D1", rows: ["Missing"], values: [] }] }],
    }));
    expect(pkg.warnings).toContain("Pivot table \"Broken\" on S could not be computed and was left out.");
    expect(all(pkg.doc("xl/worksheets/sheet1.xml"), "c").map((item) => attr(item, "r"))).toEqual(["A1", "A2"]);
  });
});

describe("sheet filter", () => {
  it("writes the autoFilter with its criteria and hides the rows the filter hides", async () => {
    const pkg = await exportPackage();
    const leads = pkg.doc(LEADS);
    const filter = one(leads, "autoFilter");
    expect(attr(filter, "ref")).toBe("A1:D6");
    const columns = all(filter, "filterColumn");
    expect(columns.map((column) => attr(column, "colId"))).toEqual(["1", "3"]);
    expect(all(columns[0], "filter").map((item) => attr(item, "val"))).toEqual(["Open"]);
    expect([attr(one(columns[1], "customFilter"), "operator"), attr(one(columns[1], "customFilter"), "val")]).toEqual(["greaterThan", "1000"]);
    const hidden = all(leads, "row").filter((row) => attr(row, "hidden") === "1").map((row) => attr(row, "r"));
    expect(hidden).toEqual(["3", "4", "5"]);
    expect(attr(one(leads, "sheetPr"), "filterMode")).toBe("1");
  });
});

describe("sheet filter matching", () => {
  const LEAGUE = {
    A1: { v: "Name" }, B1: { v: "Team" }, C1: { v: "Score" },
    A2: { v: "Ana" }, B2: { v: "Red" }, C2: { v: 91 },
    A3: { v: "Ben" }, B3: { v: "Blue" }, C3: { v: 78 },
    A4: { v: "Cy" }, B4: { v: "Red" }, C4: { v: "n/a" },
    A5: { v: "Di" }, C5: { v: 88 },
    A6: { v: "Eve" }, B6: { v: "green" }, C6: { v: 100 },
  };
  const filtered = async (criteria: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const pkg = await exportPackage(book({ sheets: [{ name: "S", cells: LEAGUE, filter: { ref: "B1:C6", criteria, ...extra }, ...extra }] }));
    const sheet = pkg.doc("xl/worksheets/sheet1.xml");
    return {
      pkg,
      sheet,
      hidden: all(sheet, "row").filter((row) => attr(row, "hidden") === "1").map((row) => Number(attr(row, "r"))),
    };
  };
  const condition = (col: string, op: string, value: string) => ({ [col]: { condition: { op, value } } });

  it("compares numbers the way Excel does, hiding text against a number", async () => {
    const cases: [string, number[]][] = [["gt", [3, 4, 5]], ["gte", [3, 4]], ["lt", [2, 4, 5, 6]], ["lte", [2, 4, 6]], ["eq", [2, 3, 4, 6]], ["neq", [5]]];
    for (const [op, hidden] of cases) expect((await filtered(condition("C", op, "88"))).hidden, op).toEqual(hidden);
  });

  it("compares text operands with the shown text, ignoring case", async () => {
    expect((await filtered(condition("B", "eq", "red"))).hidden).toEqual([3, 5, 6]);
    expect((await filtered(condition("B", "lt", "c"))).hidden).toEqual([2, 4, 6]);
  });

  it("matches text conditions and writes them as wildcard custom filters", async () => {
    const cases: [string, number[], string, string][] = [
      ["contains", [5], "equal", "*e*"],
      ["notContains", [2, 3, 4, 6], "notEqual", "*e*"],
      ["begins", [3, 5, 6], "equal", "r*"],
      ["ends", [2, 4, 5, 6], "equal", "*e"],
    ];
    for (const [op, hidden, operator, val] of cases) {
      const needle = op === "begins" ? "r" : "e";
      const result = await filtered(condition("B", op, needle));
      expect(result.hidden, op).toEqual(hidden);
      expect([attr(one(result.sheet, "customFilter"), "operator"), attr(one(result.sheet, "customFilter"), "val")], op).toEqual([operator, val]);
    }
    expect(attr(one((await filtered(condition("B", "contains", "a*b"))).sheet, "customFilter"), "val")).toBe("*a~*b*");
  });

  it("keeps listed values, blanks included, and numbers columns from the filter's left edge", async () => {
    const { sheet, hidden } = await filtered({ B: { values: ["Red", ""] } });
    expect(hidden).toEqual([3, 6]);
    const column = one(sheet, "filterColumn");
    expect([attr(column, "colId"), attr(one(column, "filters"), "blank")]).toEqual(["0", "1"]);
    expect(all(column, "filter").map((item) => attr(item, "val"))).toEqual(["Red"]);
  });

  it("writes between as an and-pair and notBetween as an or-pair of custom filters", async () => {
    const pairs = (sheet: Document) => all(sheet, "customFilter").map((item) => [attr(item, "operator"), attr(item, "val")]);
    const inside = await filtered({ C: { condition: { op: "between", value: "80", value2: "95" } } });
    expect(inside.hidden).toEqual([3, 4, 6]);
    expect(attr(one(inside.sheet, "customFilters"), "and")).toBe("1");
    expect(pairs(inside.sheet)).toEqual([["greaterThanOrEqual", "80"], ["lessThanOrEqual", "95"]]);
    const outside = await filtered({ C: { condition: { op: "notBetween", value: "80", value2: "95" } } });
    expect(outside.hidden).toEqual([2, 4, 5]);
    expect(attr(one(outside.sheet, "customFilters"), "and")).toBeNull();
    expect(pairs(outside.sheet)).toEqual([["lessThan", "80"], ["greaterThan", "95"]]);
  });

  it("skips criteria outside the range and warns about ones Excel cannot hold", async () => {
    const workbook = book({ sheets: [{ name: "S", cells: LEAGUE, filter: { ref: "B1:C6", criteria: { A: { values: ["Ana"] } } } }] });
    // Parsing drops a between without its upper bound; one built in memory is left out with a warning.
    workbook.sheets[0].filter!.criteria.C = { condition: { op: "between", value: "80" } };
    const pkg = await exportPackage(workbook);
    const sheet = pkg.doc("xl/worksheets/sheet1.xml");
    expect(all(sheet, "row").filter((row) => attr(row, "hidden") === "1")).toEqual([]);
    expect(all(sheet, "filterColumn")).toHaveLength(0);
    expect(pkg.warnings).toContain("The filter on column C of S could not be exported.");
  });

  it("writes filter columns left to right whatever order they were set in", async () => {
    const { sheet } = await filtered({ C: { condition: { op: "gt", value: "1" } }, B: { values: ["Red"] } });
    expect(all(sheet, "filterColumn").map((column) => attr(column, "colId"))).toEqual(["0", "1"]);
    expect(one((await filtered({}, { sort: { col: "B", desc: false } })).sheet, "sortCondition").getAttribute("ref")).toBe("B2:B6");
  });

  it("records the sort inside the filter range only", async () => {
    const sorted = await filtered({}, { sort: { col: "C", desc: false } });
    const state = one(sorted.sheet, "sortState");
    expect([attr(state, "ref"), attr(one(state, "sortCondition"), "ref"), attr(one(state, "sortCondition"), "descending")]).toEqual(["B2:C6", "C2:C6", null]);
    expect(attr(one((await filtered({}, { sort: { col: "C", desc: true } })).sheet, "sortCondition"), "descending")).toBe("1");
    expect((await filtered({}, { sort: { col: "A", desc: true } })).sheet.getElementsByTagName("sortState")).toHaveLength(0);
  });

  it("leaves out a sort on a header-only filter and a filter that overlaps a table", async () => {
    const headerOnly = await exportPackage(book({ sheets: [{ name: "S", cells: LEAGUE, filter: { ref: "B1:C1", criteria: {}, sort: { col: "B", desc: false } } }] }));
    expect(pkg_has(headerOnly, "sortState")).toBe(false);
    const overTable = await exportPackage(book({ sheets: [{ name: "S", cells: LEAGUE, filter: { ref: "A1:C6", criteria: {} }, tables: [{ id: "t", name: "T", ref: "A1:C6" }] }] }));
    expect(pkg_has(overTable, "autoFilter", "xl/worksheets/sheet1.xml")).toBe(false);
    expect(overTable.warnings).toContain("The filter on S overlaps a table, which has its own filter, so it was left out.");
  });
});

function pkg_has(pkg: Package, tag: string, part = "xl/worksheets/sheet1.xml"): boolean {
  return pkg.doc(part).getElementsByTagName(tag).length > 0;
}

describe("chart structure", () => {
  const children = (node: Element) => Array.from(node.children, (child) => child.tagName);

  it("writes axes in schema order, crossing each other, with titles rotated on the vertical axis", async () => {
    const chart = (await exportPackage()).doc("xl/charts/chart1.xml");
    const cat = one(chart, "c:catAx");
    const val = one(chart, "c:valAx");
    expect(children(cat)).toEqual(["c:axId", "c:scaling", "c:delete", "c:axPos", "c:title", "c:numFmt", "c:majorTickMark", "c:minorTickMark", "c:tickLblPos", "c:crossAx", "c:crosses", "c:auto", "c:lblAlgn", "c:lblOffset", "c:noMultiLvlLbl"]);
    expect(children(val)).toEqual(["c:axId", "c:scaling", "c:delete", "c:axPos", "c:majorGridlines", "c:title", "c:numFmt", "c:majorTickMark", "c:minorTickMark", "c:tickLblPos", "c:crossAx", "c:crosses", "c:crossBetween"]);
    expect(attr(one(cat, "c:crossAx"), "val")).toBe(attr(one(val, "c:axId"), "val"));
    expect(attr(one(val, "c:crossAx"), "val")).toBe(attr(one(cat, "c:axId"), "val"));
    expect(attr(one(val, "c:crossBetween"), "val")).toBe("between");
    expect(attr(one(one(val, "c:title"), "a:bodyPr"), "rot")).toBe("-5400000");
    expect(attr(one(one(cat, "c:title"), "a:bodyPr"), "rot")).toBeNull();
    expect(children(one(chart, "c:barChart")).slice(-4)).toEqual(["c:dLbls", "c:gapWidth", "c:axId", "c:axId"]);
  });

  it("caches number formats from the source and leaves text out of value caches", async () => {
    const chart = (await exportPackage()).doc("xl/charts/chart1.xml");
    const [revenue, units] = all(chart, "c:ser");
    expect(one(one(revenue, "c:val"), "c:formatCode").textContent).toBe("#,##0");
    expect(one(one(units, "c:val"), "c:formatCode").textContent).toBe("General");
    const pkg = await exportPackage(book({
      sheets: [{ name: "D", cells: { B2: { v: "Q" }, C2: { v: "Sales" }, B3: { v: 1 }, C3: { v: 5 }, B4: { v: 3 }, C4: { v: "x" }, B5: { v: 4 }, C5: { v: 7 } }, charts: [{ id: "c", type: "column", source: "B2:C5", seriesBy: "columns", legend: "none", at: "E2", w: 300, h: 200 }] }],
    }));
    const ser = one(pkg.doc("xl/charts/chart1.xml"), "c:ser");
    expect(one(one(ser, "c:tx"), "c:f").textContent).toBe("D!$C$2");
    expect(one(one(ser, "c:val"), "c:f").textContent).toBe("D!$C$3:$C$5");
    expect(attr(one(one(ser, "c:val"), "c:ptCount"), "val")).toBe("3");
    expect(all(one(ser, "c:val"), "c:pt").map((pt) => attr(pt, "idx"))).toEqual(["0", "2"]);
    expect(one(ser, "c:cat").getElementsByTagName("c:numRef")).toHaveLength(1);
  });

  it("keeps blank categories numeric when the rest are numbers", async () => {
    const pkg = await exportPackage(book({
      sheets: [{ name: "D", cells: { A1: { v: "Year" }, B1: { v: "Units" }, A2: { v: 2024 }, B2: { v: 5 }, B3: { v: 6 }, A4: { v: 2026 }, B4: { v: 7 } }, charts: [{ id: "c", type: "line", source: "A1:B4", seriesBy: "columns", legend: "none", at: "D2", w: 300, h: 200 }] }],
    }));
    expect(one(pkg.doc("xl/charts/chart1.xml"), "c:cat").getElementsByTagName("c:numRef")).toHaveLength(1);
  });

  it("treats a one-row source as unnamed series and colors pie slices by rows", async () => {
    const pkg = await exportPackage(book({
      sheets: [{
        name: "D",
        cells: { B2: { v: 1 }, C2: { v: 2 }, D2: { v: 3 }, A5: { v: "" }, B5: { v: "Q1" }, C5: { v: "Q2" }, D5: { v: "Q3" }, A6: { v: "Plan" }, B6: { v: 4 }, C6: { v: 5 }, D6: { v: 6 } },
        charts: [
          { id: "one", type: "column", source: "B2:D2", seriesBy: "columns", legend: "none", at: "F2", w: 300, h: 200 },
          { id: "pie", type: "pie", source: "A5:D6", seriesBy: "rows", legend: "right", at: "F20", w: 300, h: 200 },
        ],
      }],
    }));
    const single = pkg.doc("xl/charts/chart1.xml");
    expect(single.getElementsByTagName("c:tx")).toHaveLength(0);
    expect(all(single, "c:ser").map((ser) => one(one(ser, "c:val"), "c:f").textContent)).toEqual(["D!$C$2", "D!$D$2"]);
    expect(one(one(single, "c:cat"), "c:f").textContent).toBe("D!$B$2");
    const pie = pkg.doc("xl/charts/chart2.xml");
    expect(all(pie, "c:dPt")).toHaveLength(3);
    expect(one(one(one(pie, "c:ser"), "c:val"), "c:f").textContent).toBe("D!$B$6:$D$6");
  });

  it("numbers chart frames, keeps gridlines on the vertical axis, and drops charts with a missing source", async () => {
    const pkg = await exportPackage();
    const frames = all(pkg.doc("xl/drawings/drawing1.xml"), "xdr:cNvPr").map((item) => [attr(item, "id"), attr(item, "name")]);
    expect(frames).toEqual([["2", "Chart 1"], ["3", "Chart 2"]]);
    const scatterAxes = all(pkg.doc("xl/charts/chart4.xml"), "c:valAx");
    expect(scatterAxes.map((axis) => axis.getElementsByTagName("c:majorGridlines").length)).toEqual([0, 1]);
    expect(scatterAxes.map((axis) => attr(one(axis, "c:crossBetween"), "val"))).toEqual(["midCat", "midCat"]);
    const missing = await exportPackage(book({ sheets: [{ name: "S", cells: { A1: { v: 1 } }, charts: [{ id: "c", type: "line", source: "Gone!A1:B4", seriesBy: "columns", legend: "none", at: "D2", w: 300, h: 200 }] }] }));
    expect(missing.parts.has("xl/charts/chart1.xml")).toBe(false);
    expect(missing.parts.has("xl/drawings/drawing1.xml")).toBe(false);
    expect(missing.warnings).toContain("A chart on S points at a missing range (Gone!A1:B4) and was left out.");
  });

  it("finds series, names, and categories in a source away from A1, by rows or columns", async () => {
    const pkg = await exportPackage(book({
      sheets: [{
        name: "D",
        cells: { C5: { v: "Q1" }, D5: { v: "Q2" }, B6: { v: "Plan" }, C6: { v: 1 }, D6: { v: 2 }, B7: { v: "Actual" }, C7: { v: 3 }, D7: { v: 4 }, F2: { v: "Notes" }, F3: { v: "n/a" }, G2: { v: "Count" }, G3: { v: 5 } },
        charts: [
          { id: "rows", type: "column", source: "B5:D7", seriesBy: "rows", legend: "none", at: "J2", w: 300, h: 200 },
          { id: "two", type: "column", source: "F2:G3", seriesBy: "columns", legend: "none", at: "J20", w: 300, h: 200 },
        ],
      }],
    }));
    const rows = all(pkg.doc("xl/charts/chart1.xml"), "c:ser");
    expect(rows.map((ser) => [one(one(ser, "c:tx"), "c:f").textContent, one(one(ser, "c:val"), "c:f").textContent])).toEqual([["D!$B$6", "D!$C$6:$D$6"], ["D!$B$7", "D!$C$7:$D$7"]]);
    expect(one(one(rows[0], "c:cat"), "c:f").textContent).toBe("D!$C$5:$D$5");
    const narrow = await exportPackage(book({ sheets: [{ name: "D", cells: { C2: { v: 1 }, C3: { v: 2 } }, charts: [{ id: "n", type: "column", source: "C2:C3", seriesBy: "rows", legend: "none", at: "E2", w: 300, h: 200 }] }] }));
    expect(narrow.doc("xl/charts/chart1.xml").getElementsByTagName("c:tx")).toHaveLength(0);
    const two = all(pkg.doc("xl/charts/chart2.xml"), "c:ser");
    expect(two.map((ser) => one(one(ser, "c:tx"), "c:f").textContent)).toEqual(["D!$G$2"]);
    const textOnly = await exportPackage(book({ sheets: [{ name: "D", cells: { A1: { v: "K" }, B1: { v: "V" }, A2: { v: "a" }, B2: { v: "x" } }, charts: [{ id: "c", type: "column", source: "A1:B2", seriesBy: "columns", legend: "none", at: "D2", w: 300, h: 200 }] }] }));
    expect(one(one(textOnly.doc("xl/charts/chart1.xml"), "c:val"), "c:formatCode").textContent).toBe("General");
  });
});

describe("worksheet details", () => {
  const sheetOf = async (raw: Record<string, unknown>) => (await exportPackage(book({ sheets: [{ name: "S", cells: { A3: { v: 1 } }, ...raw }] }))).doc("xl/worksheets/sheet1.xml");

  it("freezes rows only or columns only with the matching active pane", async () => {
    const rows = one(await sheetOf({ freeze: { rows: 2, cols: 0 } }), "pane");
    expect([attr(rows, "xSplit"), attr(rows, "ySplit"), attr(rows, "topLeftCell"), attr(rows, "activePane")]).toEqual([null, "2", "A3", "bottomLeft"]);
    const cols = one(await sheetOf({ freeze: { rows: 0, cols: 2 } }), "pane");
    expect([attr(cols, "xSplit"), attr(cols, "ySplit"), attr(cols, "topLeftCell"), attr(cols, "activePane")]).toEqual(["2", null, "C1", "topRight"]);
    expect(attr(one(await sheetOf({}), "sheetView"), "workbookViewId")).toBe("0");
  });

  it("orders columns and rows, sizes rows without styles, and keeps row-only settings", async () => {
    const sheet = await sheetOf({ cols: { C: { w: 50 }, A: { w: 80 } }, rows: { 1: { h: 40 } } });
    expect(all(sheet, "col").map((col) => [attr(col, "min"), attr(col, "max")])).toEqual([["1", "1"], ["3", "3"]]);
    const rows = all(sheet, "row");
    expect(rows.map((row) => attr(row, "r"))).toEqual(["1", "3"]);
    expect([attr(rows[0], "ht"), attr(rows[0], "customHeight"), attr(rows[0], "customFormat"), attr(rows[0], "s")]).toEqual(["30", "1", null, null]);
  });
});

describe("package details", () => {
  it("numbers relationships and sheets from 1", async () => {
    const pkg = await exportPackage();
    const ids = all(pkg.doc("xl/_rels/workbook.xml.rels"), "Relationship").map((rel) => attr(rel, "Id"));
    expect(ids).toEqual(ids.map((_, index) => `rId${index + 1}`));
    expect(all(pkg.doc("xl/workbook.xml"), "sheet").map((sheet) => attr(sheet, "sheetId"))).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("anchors unqualified names to the first sheet, marks missing sheets #REF!, and skips reserved names", async () => {
    const pkg = await exportPackage(book({
      names: [{ name: "Loose", ref: "B2" }, { name: "Lost", ref: "Gone!A1" }, { name: "_xlnm.Print_Area", ref: "S!A1:B2" }],
      sheets: [{ name: "S", cells: { A1: { v: 1 } } }, { name: "T", cells: {} }],
    }));
    const names = Object.fromEntries(all(pkg.doc("xl/workbook.xml"), "definedName").map((name) => [attr(name, "name"), name.textContent]));
    expect(names).toEqual({ Loose: "S!$B$2", Lost: "#REF!" });
    expect(pkg.warnings).toEqual([
      "The name \"Lost\" points at a missing sheet and exports as #REF!.",
      "The name \"_xlnm.Print_Area\" is reserved by Excel and was left out.",
    ]);
  });

  it("titles an untitled workbook and adds no list sheet when every list fits inline", async () => {
    const result = buildXlsxWorkbook(book({ sheets: [{ name: "S", cells: {}, validations: [{ id: "v", ref: "A1", kind: "list", items: ["a", "b"] }] }] }), { now: NOW });
    const parts = await readZip(result.bytes);
    expect(new TextDecoder().decode(parts.get("docProps/core.xml"))).toContain("<dc:title>Workbook</dc:title>");
    expect(new TextDecoder().decode(parts.get("xl/workbook.xml")).match(/<sheet /g)).toHaveLength(1);
  });

  it("writes the theme's gradient stops at 0, 50, and 100 percent", async () => {
    const theme = (await exportPackage()).doc("xl/theme/theme1.xml");
    const fills = all(one(theme, "a:fillStyleLst"), "a:gs").map((stop) => attr(stop, "pos"));
    expect(fills).toEqual(["0", "50000", "100000", "0", "50000", "100000"]);
  });
});

describe("rule details", () => {
  it("gives conditional rules priorities 1..n and comparison rules one operand", async () => {
    const rules = all((await exportPackage()).doc(SALES), "cfRule");
    expect(rules.map((rule) => attr(rule, "priority"))).toEqual(rules.map((_, index) => String(index + 1)));
    expect(all(rules.find((rule) => attr(rule, "operator") === "greaterThan")!, "formula")).toHaveLength(1);
  });

  it("keeps a list of exactly 255 characters inline and moves a longer one", async () => {
    const items = (total: number) => [`${"x".repeat(total - 2)}`, "y"];
    const pkg = await exportPackage(book({
      sheets: [{ name: "S", cells: {}, validations: [{ id: "a", ref: "A1", kind: "list", items: items(255) }, { id: "b", ref: "B1", kind: "list", items: items(256) }] }],
    }));
    const formulas = all(pkg.doc("xl/worksheets/sheet1.xml"), "formula1").map((item) => item.textContent!);
    expect(formulas[0]).toBe(`"${"x".repeat(253)},y"`);
    expect(formulas[1]).toBe("'Dropdown lists'!$A$1:$A$2");
  });

  it("writes date limits as serials, single-operand rules with one formula, and blank-friendly prompts", async () => {
    const pkg = await exportPackage(book({
      sheets: [{
        name: "S",
        cells: {},
        validations: [
          { id: "d", ref: "A1", kind: "date", op: "between", value: "2026-01-01", value2: "2026-12-31", strict: true },
          { id: "w", ref: "B1", kind: "whole", op: "gte", value: "2026-01-01", strict: true },
        ],
      }],
    }));
    const [dates, whole] = all(pkg.doc("xl/worksheets/sheet1.xml"), "dataValidation");
    expect([one(dates, "formula1").textContent, one(dates, "formula2").textContent]).toEqual(["46023", "46387"]);
    expect([one(whole, "formula1").textContent, whole.getElementsByTagName("formula2").length]).toEqual(["\"2026-01-01\"", 0]);
    expect([attr(whole, "allowBlank"), attr(whole, "showInputMessage")]).toEqual(["1", "1"]);
  });
});

describe("table details", () => {
  it("numbers a repeated header past names already taken and shows the first column when asked", async () => {
    const pkg = await exportPackage(book({
      sheets: [{ name: "S", cells: { A1: { v: "Amount" }, B1: { v: "Amount2" }, C1: { v: "amount" }, A2: { v: 1 } }, tables: [{ id: "t", name: "T", ref: "A1:C2", firstColumn: true }] }],
    }));
    const table = pkg.doc("xl/tables/table1.xml");
    expect(all(table, "tableColumn").map((column) => attr(column, "name"))).toEqual(["Amount", "Amount2", "amount3"]);
    const style = one(table, "tableStyleInfo");
    expect([attr(style, "showFirstColumn"), attr(style, "showLastColumn"), attr(style, "showColumnStripes")]).toEqual(["1", "0", "0"]);
  });
});
