import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildZip } from "../ooxmlZip";
import { BUILTIN_NUMBER_FORMATS } from "./numberFormat";
import { excelWidthToPx, pointsToPx } from "./palette";
import { MAX_FORMULA_CHARS, MAX_SHEETS, MAX_SHEET_ROWS, MAX_WORKBOOK_CELLS, type Sheet, parseWorkbook, workbookCellCount } from "./sheetModel";
import { buildXlsxWorkbook } from "./xlsxExport";
import { importXlsxWorkbook } from "./xlsxImport";

/* ------------------------------------------------------------------ package builder */

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const encoder = new TextEncoder();

type Rel = { id: string; type: string; target: string; external?: boolean };
type SheetSpec = { name: string; xml: string; state?: string; rels?: Rel[]; kind?: "worksheet" | "chartsheet" };
type PackageSpec = {
  sheets: SheetSpec[];
  styles?: string;
  strings?: string[];
  sharedStringsXml?: string;
  theme?: string;
  workbookPr?: string;
  definedNames?: string;
  workbookRels?: Rel[];
  parts?: Record<string, string | Uint8Array>;
};

function relsXml(rels: Rel[]): string {
  const items = rels.map((rel) => `<Relationship Id="${rel.id}" Type="${REL}/${rel.type}" Target="${rel.target}"${rel.external ? ' TargetMode="External"' : ""}/>`);
  return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}">${items.join("")}</Relationships>`;
}

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xlsx(spec: PackageSpec): Uint8Array {
  const entries: { name: string; bytes: Uint8Array }[] = [];
  const add = (name: string, content: string | Uint8Array) =>
    entries.push({ name, bytes: typeof content === "string" ? encoder.encode(content) : content });
  add("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`);
  add("_rels/.rels", relsXml([{ id: "rId1", type: "officeDocument", target: "xl/workbook.xml" }]));
  const workbookRels: Rel[] = [...(spec.workbookRels ?? [])];
  const sheetTags = spec.sheets.map((sheet, index) => {
    const kind = sheet.kind ?? "worksheet";
    const folder = kind === "worksheet" ? "worksheets" : "chartsheets";
    const path = `${folder}/sheet${index + 1}.xml`;
    workbookRels.push({ id: `rIdS${index + 1}`, type: kind, target: path });
    add(`xl/${path}`, sheet.xml);
    if (sheet.rels) add(`xl/${folder}/_rels/sheet${index + 1}.xml.rels`, relsXml(sheet.rels));
    const state = sheet.state ? ` state="${sheet.state}"` : "";
    return `<sheet name="${escapeText(sheet.name)}" sheetId="${index + 1}"${state} r:id="rIdS${index + 1}"/>`;
  });
  if (spec.styles) {
    workbookRels.push({ id: "rIdStyles", type: "styles", target: "styles.xml" });
    add("xl/styles.xml", spec.styles);
  }
  if (spec.strings || spec.sharedStringsXml) {
    workbookRels.push({ id: "rIdStrings", type: "sharedStrings", target: "sharedStrings.xml" });
    const items = (spec.strings ?? []).map((text) => `<si><t xml:space="preserve">${escapeText(text)}</t></si>`).join("");
    add("xl/sharedStrings.xml", spec.sharedStringsXml ?? `<sst xmlns="${MAIN}">${items}</sst>`);
  }
  if (spec.theme) {
    workbookRels.push({ id: "rIdTheme", type: "theme", target: "theme/theme1.xml" });
    add("xl/theme/theme1.xml", spec.theme);
  }
  const names = spec.definedNames ? `<definedNames>${spec.definedNames}</definedNames>` : "";
  add(
    "xl/workbook.xml",
    `<workbook xmlns="${MAIN}" xmlns:r="${REL}">${spec.workbookPr ?? ""}<sheets>${sheetTags.join("")}</sheets>${names}</workbook>`,
  );
  add("xl/_rels/workbook.xml.rels", relsXml(workbookRels));
  for (const [name, content] of Object.entries(spec.parts ?? {})) add(name, content);
  return buildZip(entries);
}

function ws(body: string): string {
  return `<worksheet xmlns="${MAIN}" xmlns:r="${REL}">${body}</worksheet>`;
}

function data(rows: string): string {
  return `<sheetData>${rows}</sheetData>`;
}

/** One sheet holding `rows`, plus anything after sheetData. */
function oneSheet(rows: string, after = "", extra: Partial<PackageSpec> = {}, rels?: Rel[]): Uint8Array {
  return xlsx({ sheets: [{ name: "Data", xml: ws(`${data(rows)}${after}`), rels }], ...extra });
}

async function firstSheet(bytes: Uint8Array): Promise<Sheet> {
  return (await importXlsxWorkbook(bytes)).workbook.sheets[0];
}

function styles(parts: { numFmts?: string; fonts?: string; fills?: string; borders?: string; cellXfs: string; dxfs?: string; colors?: string }): string {
  return `<styleSheet xmlns="${MAIN}">${parts.numFmts ?? ""}<fonts>${parts.fonts ?? '<font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>'}</fonts><fills>${
    parts.fills ?? '<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
  }</fills><borders>${parts.borders ?? "<border><left/><right/><top/><bottom/><diagonal/></border>"}</borders><cellXfs>${parts.cellXfs}</cellXfs>${
    parts.dxfs ? `<dxfs>${parts.dxfs}</dxfs>` : ""
  }${parts.colors ?? ""}</styleSheet>`;
}

const PLAIN_XF = '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>';

function channelDistance(a: string, b: string): number {
  const parse = (hex: string) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  const [x, y] = [parse(a), parse(b)];
  return Math.max(...x.map((value, index) => Math.abs(value - y[index])));
}

/* ------------------------------------------------------------------ package */

describe("importXlsxWorkbook: package checks", () => {
  it("rejects text that is not a workbook", async () => {
    await expect(importXlsxWorkbook(encoder.encode("name,qty\nA,1\n"))).rejects.toThrow(/not an Excel workbook/i);
  });

  it("explains that legacy .xls files need saving as .xlsx", async () => {
    const ole = new Uint8Array(1024);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    await expect(importXlsxWorkbook(ole)).rejects.toThrow(/\.xls\b.*\.xlsx/);
  });

  it("explains that password-protected workbooks must be unlocked first", async () => {
    const ole = new Uint8Array(2048);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const name = Array.from("EncryptedPackage").flatMap((ch) => [ch.charCodeAt(0), 0]);
    ole.set(name, 1200);
    await expect(importXlsxWorkbook(ole)).rejects.toThrow(/password/i);
  });

  it("rejects ZIP packages that hold no workbook, and binary .xlsb workbooks", async () => {
    const docx = buildZip([{ name: "word/document.xml", bytes: encoder.encode("<document/>") }]);
    await expect(importXlsxWorkbook(docx)).rejects.toThrow(/not an Excel workbook/i);
    const xlsb = buildZip([{ name: "xl/workbook.bin", bytes: new Uint8Array([1, 2, 3]) }]);
    await expect(importXlsxWorkbook(xlsb)).rejects.toThrow(/\.xlsb/);
  });
});

/* ------------------------------------------------------------------ workbook */

describe("importXlsxWorkbook: workbook", () => {
  it("keeps sheet order, names, and hidden state, and passes parseWorkbook", async () => {
    const bytes = xlsx({
      sheets: [
        { name: "Summary", xml: ws(data("")) },
        { name: "Raw data", xml: ws(data("")), state: "hidden" },
        { name: "Secret", xml: ws(data("")), state: "veryHidden" },
      ],
    });
    const { workbook, warnings } = await importXlsxWorkbook(bytes);
    expect(workbook.sheets.map((sheet) => [sheet.name, sheet.hidden ?? false])).toEqual([
      ["Summary", false],
      ["Raw data", true],
      ["Secret", true],
    ]);
    expect(workbook.sheets.map((sheet) => sheet.id)).toEqual(["sheet-1", "sheet-2", "sheet-3"]);
    expect(parseWorkbook(workbook)).toMatchObject({ ok: true, workbook });
    expect(warnings).toEqual([]);
  });

  it("imports range names and leaves out built-in, hidden, and formula names", async () => {
    const bytes = xlsx({
      sheets: [{ name: "Q1 Sales", xml: ws(data("")) }],
      definedNames: [
        `<definedName name="Regions">'Q1 Sales'!$A$2:$A$9</definedName>`,
        `<definedName name="Rate">Sheet9!$B$1</definedName>`,
        `<definedName name="_xlnm.Print_Area" localSheetId="0">'Q1 Sales'!$A$1:$D$9</definedName>`,
        `<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'Q1 Sales'!$A$1:$D$9</definedName>`,
        `<definedName name="Solver_opt" hidden="1">'Q1 Sales'!$A$1</definedName>`,
        `<definedName name="TaxRate">0.08</definedName>`,
        `<definedName name="Broken">#REF!</definedName>`,
      ].join(""),
    });
    const { workbook, warnings } = await importXlsxWorkbook(bytes);
    expect(workbook.names).toEqual([
      { name: "Regions", ref: "'Q1 Sales'!A2:A9" },
      { name: "Rate", ref: "Sheet9!B1" },
    ]);
    expect(warnings.join(" ")).toMatch(/2 named formulas or constants/);
  });

  it("skips chart sheets with a warning", async () => {
    const bytes = xlsx({
      sheets: [
        { name: "Data", xml: ws(data("")) },
        { name: "Chart1", xml: `<chartsheet xmlns="${MAIN}"/>`, kind: "chartsheet" },
      ],
    });
    const { workbook, warnings } = await importXlsxWorkbook(bytes);
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(["Data"]);
    expect(warnings.join(" ")).toMatch(/chart sheet "Chart1"/i);
  });

  it(`keeps the first ${MAX_SHEETS} sheets`, async () => {
    const sheets = Array.from({ length: MAX_SHEETS + 2 }, (_, index) => ({ name: `S${index + 1}`, xml: ws(data("")) }));
    const { workbook, warnings } = await importXlsxWorkbook(xlsx({ sheets }));
    expect(workbook.sheets).toHaveLength(MAX_SHEETS);
    expect(warnings.join(" ")).toMatch(/first 40 sheets/);
  });

  it("imports a sheet whose XML is broken as an empty sheet, with a warning", async () => {
    const bytes = xlsx({ sheets: [{ name: "Good", xml: ws(data('<row r="1"><c r="A1"><v>1</v></c></row>')) }, { name: "Broken", xml: "<worksheet><sheetData><row>" }] });
    const { workbook, warnings } = await importXlsxWorkbook(bytes);
    expect(workbook.sheets.map((sheet) => [sheet.name, Object.keys(sheet.cells).length])).toEqual([
      ["Good", 1],
      ["Broken", 0],
    ]);
    expect(warnings.join(" ")).toMatch(/"Broken" could not be read/);
  });

  it("warns about macros and links to other workbooks", async () => {
    const bytes = xlsx({
      sheets: [{ name: "Data", xml: ws(data("")) }],
      workbookRels: [{ id: "rIdX", type: "externalLink", target: "externalLinks/externalLink1.xml" }],
      parts: { "xl/vbaProject.bin": new Uint8Array([0, 1, 2]), "xl/externalLinks/externalLink1.xml": "<externalLink/>" },
    });
    const { warnings } = await importXlsxWorkbook(bytes);
    expect(warnings.join(" ")).toMatch(/macros/i);
    expect(warnings.join(" ")).toMatch(/other workbooks/i);
  });
});

/* ------------------------------------------------------------------ cells */

describe("importXlsxWorkbook: cell values", () => {
  it("reads every cell type; errors become text and rich text becomes plain", async () => {
    const strings = `<sst xmlns="${MAIN}"><si><t>Plain</t></si><si><r><rPr><b/></rPr><t>Rich </t></r><r><t>text</t></r><rPh sb="0" eb="1"><t>ignored</t></rPh></si><si><t>Line_x000D_
break</t></si></sst>`;
    const rows = `<row r="1">
      <c r="A1"><v>42.5</v></c><c r="B1" t="n"><v>-3</v></c><c r="C1" t="s"><v>0</v></c><c r="D1" t="s"><v>1</v></c>
      <c r="E1" t="inlineStr"><is><t>Inline</t></is></c><c r="F1" t="b"><v>1</v></c><c r="G1" t="b"><v>0</v></c>
      <c r="H1" t="e"><v>#N/A</v></c><c r="I1" t="str"><v>cached text</v></c><c r="J1" t="d"><v>2024-01-15T12:00:00</v></c>
      <c r="K1" t="s"><v>2</v></c><c r="L1"/></row>`;
    const sheet = await firstSheet(oneSheet(rows, "", { sharedStringsXml: strings }));
    expect(sheet.cells).toEqual({
      A1: { v: 42.5 },
      B1: { v: -3 },
      C1: { v: "Plain" },
      D1: { v: "Rich text" },
      E1: { v: "Inline" },
      F1: { v: true },
      G1: { v: false },
      H1: { v: "#N/A" },
      I1: { v: "cached text" },
      J1: { v: 45306.5 },
      K1: { v: "Line\r\nbreak" },
    });
  });

  it("reads ISO dates with or without a time, including seconds", async () => {
    const sheet = await firstSheet(oneSheet(`<row r="1"><c r="A1" t="d"><v>2024-03-01</v></c><c r="B1" t="d"><v>2024-01-15T00:00:30</v></c><c r="C1" t="d"><v>soon</v></c></row>`));
    expect(sheet.cells.A1.v).toBe(45352);
    expect(sheet.cells.B1.v).toBeCloseTo(45306 + 30 / 86_400, 9);
    expect(sheet.cells.C1).toBeUndefined();
  });

  it("places cells and rows that omit their r attribute in order", async () => {
    const sheet = await firstSheet(oneSheet(`<row><c><v>1</v></c><c><v>2</v></c></row><row r="4"><c r="C4"><v>3</v></c><c><v>4</v></c></row><row><c><v>5</v></c></row>`));
    expect(sheet.cells).toEqual({ A1: { v: 1 }, B1: { v: 2 }, C4: { v: 3 }, D4: { v: 4 }, A5: { v: 5 } });
  });
});

describe("importXlsxWorkbook: formulas", () => {
  it("keeps formula text and drops the cached value", async () => {
    const sheet = await firstSheet(oneSheet(`<row r="1"><c r="A1"><v>2</v></c><c r="B1"><f>A1*2</f><v>4</v></c><c r="C1" t="str"><f>UPPER("x")</f><v>X</v></c></row>`));
    expect(sheet.cells.B1).toEqual({ f: "A1*2" });
    expect(sheet.cells.C1).toEqual({ f: 'UPPER("x")' });
  });

  it("expands shared formulas into every follower, shifting relative references", async () => {
    const rows = `
      <row r="2"><c r="C2"><f t="shared" ref="C2:D4" si="0">A2*$B$1+B2</f><v>0</v></c><c r="D2"><f t="shared" si="0"/><v>0</v></c></row>
      <row r="3"><c r="C3"><f t="shared" si="0"/><v>0</v></c><c r="D3"><f t="shared" si="0"/><v>0</v></c></row>
      <row r="4"><c r="C4"><f t="shared" si="0"/><v>0</v></c><c r="E4"><f t="shared" ref="E4:E5" si="1">SUM($A$1:A4)</f></c></row>
      <row r="5"><c r="E5"><f t="shared" si="1"/></c></row>`;
    const sheet = await firstSheet(oneSheet(rows));
    expect(sheet.cells.C2.f).toBe("A2*$B$1+B2");
    expect(sheet.cells.D2.f).toBe("B2*$B$1+C2");
    expect(sheet.cells.C3.f).toBe("A3*$B$1+B3");
    expect(sheet.cells.D3.f).toBe("B3*$B$1+C3");
    expect(sheet.cells.C4.f).toBe("A4*$B$1+B4");
    expect(sheet.cells.E5.f).toBe("SUM($A$1:A5)");
  });

  it("keeps the cached value of a shared formula whose master is missing", async () => {
    const sheet = await firstSheet(oneSheet(`<row r="1"><c r="B1"><f t="shared" si="7"/><v>5</v></c></row>`));
    expect(sheet.cells.B1).toEqual({ v: 5 });
  });

  it("keeps formulas up to the length limit and the cached value of longer ones", async () => {
    const formula = (length: number) => `SUM(${"1,".repeat((length - 6) / 2)}1)`;
    const rows = `<row r="1"><c r="A1"><f>${formula(MAX_FORMULA_CHARS)}</f><v>1</v></c><c r="B1"><f>${formula(MAX_FORMULA_CHARS + 2)}</f><v>2</v></c></row>`;
    const { workbook, warnings } = await importXlsxWorkbook(oneSheet(rows));
    expect(workbook.sheets[0].cells.A1.f).toHaveLength(MAX_FORMULA_CHARS);
    expect(workbook.sheets[0].cells.B1).toEqual({ v: 2 });
    expect(warnings.join(" ")).toMatch(/1 formula on "Data".*Data!B1/);
  });

  it("keeps array formulas on their anchor and clears the cells they spill into", async () => {
    const rows = `<row r="1"><c r="A1"><v>1</v></c><c r="C1" s="1"><f t="array" ref="C1:C3">A1:A3*2</f><v>2</v></c></row>
      <row r="2"><c r="A2"><v>2</v></c><c r="C2" s="1"><v>4</v></c></row><row r="3"><c r="A3"><v>3</v></c><c r="C3"><v>6</v></c></row>`;
    const sheet = await firstSheet(oneSheet(rows, "", { styles: styles({ cellXfs: `${PLAIN_XF}<xf numFmtId="0" fontId="0" fillId="1" borderId="0" applyFill="1"/>`, fills: '<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill>' }) }));
    expect(sheet.cells.C1).toEqual({ f: "A1:A3*2", s: { fill: "#ffff00" } });
    expect(sheet.cells.C2).toEqual({ s: { fill: "#ffff00" } });
    expect(sheet.cells.C3).toBeUndefined();
  });

  it("keeps the values of what-if data tables", async () => {
    const rows = `<row r="2"><c r="B2"><f t="dataTable" ref="B2:B3" dt2D="0" dtr="0" r1="A1"/><v>10</v></c></row><row r="3"><c r="B3"><v>20</v></c></row>`;
    const { workbook, warnings } = await importXlsxWorkbook(oneSheet(rows));
    expect(workbook.sheets[0].cells).toEqual({ B2: { v: 10 }, B3: { v: 20 } });
    expect(warnings.join(" ")).toMatch(/data tables/i);
  });

  it("keeps the cached value of formulas it cannot read, and says where", async () => {
    const rows = `<row r="1"><c r="A1"><f>[1]Prices!B2*2</f><v>18</v></c><c r="B1" t="str"><f>A1 &amp;</f><v>x</v></c></row>`;
    const { workbook, warnings } = await importXlsxWorkbook(oneSheet(rows));
    expect(workbook.sheets[0].cells).toEqual({ A1: { v: 18 }, B1: { v: "x" } });
    expect(warnings.join(" ")).toMatch(/2 formulas.*Data!A1/);
  });

  it("drops the file prefixes Excel adds to newer functions and spells this-row references with @", async () => {
    const rows = `<row r="1"><c r="A1"><f>_xlfn.XLOOKUP(1,B1:B3,C1:C3)</f></c><c r="B1"><f>_xlfn._xlws.SORT(C1:C3)</f></c>
      <c r="C1"><f>_xlfn.ANCHORARRAY(B1)</f></c><c r="D1"><f>Sales[[#This Row],[Unit Price]]*Sales[[#This Row],[Qty]]</f></c>
      <c r="E1" t="str"><f>"_xlfn.XLOOKUP("</f></c></row>`;
    const sheet = await firstSheet(oneSheet(rows));
    expect(sheet.cells.A1.f).toBe("XLOOKUP(1,B1:B3,C1:C3)");
    expect(sheet.cells.B1.f).toBe("SORT(C1:C3)");
    expect(sheet.cells.C1.f).toBe("_xlfn.ANCHORARRAY(B1)");
    expect(sheet.cells.D1.f).toBe("Sales[@[Unit Price]]*Sales[@Qty]");
    expect(sheet.cells.E1.f).toBe('"_xlfn.XLOOKUP("');
  });
});

/* ------------------------------------------------------------------ styles */

const THEME = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Synthetic"><a:themeElements><a:clrScheme name="Synthetic">
  <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
  <a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
  <a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
  <a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="123456"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>
  <a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme></a:themeElements></a:theme>`;

describe("importXlsxWorkbook: styles", () => {
  it("maps fonts against the workbook default, solid fills, borders, and alignment", async () => {
    const book = styles({
      fonts: `<font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>
        <font><b/><i/><u/><strike/><sz val="14"/><color rgb="FFC00000"/><name val="Georgia"/></font>
        <font><b val="0"/><u val="none"/><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/></font>`,
      fills: `<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
        <fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill>
        <fill><patternFill patternType="lightGray"><fgColor rgb="FF00FF00"/></patternFill></fill>`,
      borders: `<border><left/><right/><top/><bottom/><diagonal/></border>
        <border><left style="hair"/><right style="mediumDashDot"><color rgb="FF0000FF"/></right><top style="double"><color auto="1"/></top><bottom style="thick"><color indexed="10"/></bottom></border>`,
      cellXfs: `${PLAIN_XF}
        <xf numFmtId="0" fontId="1" fillId="2" borderId="1"><alignment horizontal="center" vertical="center" wrapText="1" indent="2"/></xf>
        <xf numFmtId="0" fontId="2" fillId="3" borderId="0"><alignment horizontal="right" vertical="top"/></xf>
        <xf numFmtId="0" fontId="0" fillId="0" borderId="0"><alignment horizontal="general" vertical="bottom"/></xf>`,
    });
    const sheet = await firstSheet(oneSheet(`<row r="1"><c r="A1" s="1"><v>1</v></c><c r="B1" s="2"><v>2</v></c><c r="C1" s="3"><v>3</v></c><c r="D1" s="0"><v>4</v></c></row>`, "", { styles: book }));
    expect(sheet.cells.A1.s).toEqual({
      bold: true,
      italic: true,
      underline: true,
      strike: true,
      size: 14,
      color: "#c00000",
      font: "Georgia",
      fill: "#ddebf7",
      align: "center",
      valign: "middle",
      wrap: true,
      indent: 2,
      border: { left: { style: "thin" }, right: { style: "dashed", color: "#0000ff" }, top: { style: "double" }, bottom: { style: "thick", color: "#ff0000" } },
    });
    expect(sheet.cells.B1.s).toEqual({ align: "right", valign: "top" });
    expect(sheet.cells.C1).toEqual({ v: 3 });
    expect(sheet.cells.D1).toEqual({ v: 4 });
  });

  it("reads custom and built-in number formats, dropping General and locale tags", async () => {
    const book = styles({
      numFmts: `<numFmts><numFmt numFmtId="164" formatCode="General"/><numFmt numFmtId="165" formatCode="[$-409]#,##0.00"/><numFmt numFmtId="166" formatCode="0.0%"/></numFmts>`,
      cellXfs: `${PLAIN_XF}<xf numFmtId="164" fontId="0" fillId="0" borderId="0"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0"/><xf numFmtId="9" fontId="0" fillId="0" borderId="0"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0"/>`,
    });
    const cells = Array.from({ length: 5 }, (_, index) => `<c r="${"ABCDE"[index]}1" s="${index + 1}"><v>1</v></c>`).join("");
    const sheet = await firstSheet(oneSheet(`<row r="1">${cells}</row>`, "", { styles: book }));
    expect(sheet.cells.A1.s).toBeUndefined();
    expect(sheet.cells.B1.s).toEqual({ format: "#,##0.00" });
    expect(sheet.cells.C1.s).toEqual({ format: "0.0%" });
    expect(sheet.cells.D1.s?.format).toBe(BUILTIN_NUMBER_FORMATS[9]);
    expect(sheet.cells.E1.s?.format).toBe(BUILTIN_NUMBER_FORMATS[3]);
  });

  it("resolves theme colors with tint through the workbook theme", async () => {
    const book = styles({
      fonts: `<font><sz val="11"/><color theme="1"/><name val="Calibri"/></font><font><sz val="11"/><color theme="8"/><name val="Calibri"/></font>`,
      fills: `<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
        <fill><patternFill patternType="solid"><fgColor theme="0" tint="-0.0499893185216834"/></patternFill></fill>
        <fill><patternFill patternType="solid"><fgColor theme="4" tint="0.79998168889431442"/></patternFill></fill>
        <fill><patternFill patternType="solid"><fgColor theme="1" tint="0.499984740745262"/></patternFill></fill>
        <fill><patternFill patternType="solid"><fgColor theme="5" tint="-0.249977111117893"/></patternFill></fill>`,
      cellXfs: `${PLAIN_XF}<xf fontId="1" fillId="2"/><xf fontId="0" fillId="3"/><xf fontId="0" fillId="4"/><xf fontId="0" fillId="5"/>`,
    });
    const cells = [1, 2, 3, 4].map((s, index) => `<c r="${"ABCD"[index]}1" s="${s}"><v>1</v></c>`).join("");
    const sheet = await firstSheet(oneSheet(`<row r="1">${cells}</row>`, "", { styles: book, theme: THEME }));
    expect(sheet.cells.A1.s?.color).toBe("#123456");
    expect(sheet.cells.A1.s?.fill).toBe("#f2f2f2");
    expect(channelDistance(sheet.cells.B1.s!.fill!, "#d9e1f2")).toBeLessThanOrEqual(2);
    expect(sheet.cells.C1.s?.fill).toBe("#7f7f7f");
    expect(channelDistance(sheet.cells.D1.s!.fill!, "#c65911")).toBeLessThanOrEqual(2);
  });

  it("keeps every hue intact through the tint math and darkens green as Excel does", async () => {
    const hues = ["ED7D31", "70AD47", "2E8B57", "087D8B", "7A5AC8", "C2475A"];
    const fills = hues.map((hex) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${hex}" tint="0.000000001"/></patternFill></fill>`).join("");
    const book = styles({
      fills: `<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fills}<fill><patternFill patternType="solid"><fgColor theme="9" tint="-0.249977111117893"/></patternFill></fill>`,
      cellXfs: `${PLAIN_XF}${hues.map((_, index) => `<xf fillId="${index + 2}"/>`).join("")}<xf fillId="${hues.length + 2}"/>`,
    });
    const cells = [...hues, "green"].map((_, index) => `<c r="${"ABCDEFG"[index]}1" s="${index + 1}"><v>1</v></c>`).join("");
    const sheet = await firstSheet(oneSheet(`<row r="1">${cells}</row>`, "", { styles: book }));
    expect(hues.map((_, index) => sheet.cells[`${"ABCDEF"[index]}1`].s?.fill)).toEqual(hues.map((hex) => `#${hex.toLowerCase()}`));
    expect(sheet.cells.G1.s?.fill).toBe("#548235");
  });

  it("treats an automatic color as no color even when it carries an rgb", async () => {
    const book = styles({
      fonts: `<font><sz val="11"/><name val="Calibri"/></font><font><sz val="11"/><color auto="1" rgb="FF00FF00"/><name val="Calibri"/></font>`,
      cellXfs: `${PLAIN_XF}<xf fontId="1"/>`,
    });
    const sheet = await firstSheet(oneSheet(`<row r="1"><c r="A1" s="1"><v>1</v></c></row>`, "", { styles: book }));
    expect(sheet.cells.A1).toEqual({ v: 1 });
  });

  it("falls back to the Office theme without a theme part, and honours a custom indexed palette", async () => {
    const book = styles({
      fills: `<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
        <fill><patternFill patternType="solid"><fgColor theme="4"/></patternFill></fill>
        <fill><patternFill patternType="solid"><fgColor indexed="13"/></patternFill></fill>
        <fill><patternFill patternType="solid"><fgColor indexed="2"/></patternFill></fill>`,
      cellXfs: `${PLAIN_XF}<xf fillId="2"/><xf fillId="3"/><xf fillId="4"/>`,
      colors: `<colors><indexedColors>${Array.from({ length: 64 }, (_, index) => `<rgbColor rgb="${index === 2 ? "FF0A0B0C" : "FF000000"}"/>`).join("")}</indexedColors></colors>`,
    });
    const sheet = await firstSheet(oneSheet(`<row r="1"><c r="A1" s="1"><v>1</v></c><c r="B1" s="2"><v>1</v></c><c r="C1" s="3"><v>1</v></c></row>`, "", { styles: book }));
    expect(sheet.cells.A1.s?.fill).toBe("#4472c4");
    expect(sheet.cells.B1.s?.fill).toBe("#000000");
    expect(sheet.cells.C1.s?.fill).toBe("#0a0b0c");
  });

  it("uses the default indexed palette", async () => {
    const book = styles({
      fills: `<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor indexed="22"/></patternFill></fill>`,
      cellXfs: `${PLAIN_XF}<xf fillId="2"/>`,
    });
    const sheet = await firstSheet(oneSheet(`<row r="1"><c r="A1" s="1"><v>1</v></c></row>`, "", { styles: book }));
    expect(sheet.cells.A1.s?.fill).toBe("#c0c0c0");
  });

  it("shifts 1904-system dates to the 1900 system", async () => {
    const book = styles({ cellXfs: `${PLAIN_XF}<xf numFmtId="14"/>` });
    const bytes = oneSheet(`<row r="1"><c r="A1" s="1"><v>43000</v></c><c r="B1"><v>43000</v></c></row>`, "", { styles: book, workbookPr: '<workbookPr date1904="1"/>' });
    const sheet = await firstSheet(bytes);
    expect(sheet.cells.A1.v).toBe(44462);
    expect(sheet.cells.B1.v).toBe(43000);
  });

  it("turns off inherited column formatting a cell does not use", async () => {
    const book = styles({
      fonts: `<font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font>`,
      cellXfs: `${PLAIN_XF}<xf fontId="1"/><xf numFmtId="10"/>`,
    });
    const sheet = await firstSheet(xlsx({ sheets: [{ name: "Data", xml: ws(`<cols><col min="1" max="1" style="1"/></cols>${data('<row r="1"><c r="A1" s="2"><v>1</v></c></row>')}`) }], styles: book }));
    expect(sheet.cols?.A.s).toEqual({ bold: true });
    expect(sheet.cells.A1.s).toEqual({ bold: false, format: BUILTIN_NUMBER_FORMATS[10] });
  });
});


/* ------------------------------------------------------------------ layout */

describe("importXlsxWorkbook: layout", () => {
  it("reads column widths, hidden columns, row heights, merges, frozen panes, gridlines, and tab color", async () => {
    const xml = ws(`<sheetPr><tabColor theme="5"/></sheetPr>
      <sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane xSplit="2" ySplit="1" topLeftCell="C2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>
      <sheetFormatPr defaultRowHeight="15"/>
      <cols><col min="1" max="1" width="20.7109375" customWidth="1"/><col min="3" max="4" width="9.140625" hidden="1"/></cols>
      ${data('<row r="1" ht="30" customHeight="1"><c r="A1"><v>1</v></c></row><row r="2" ht="15"/><row r="3" ht="21"/><row r="4" hidden="1"/>')}
      <mergeCells count="2"><mergeCell ref="A1:B2"/><mergeCell ref="C5"/></mergeCells>`);
    const sheet = await firstSheet(xlsx({ sheets: [{ name: "Data", xml }] }));
    expect(sheet.cols).toEqual({ A: { w: excelWidthToPx(20.7109375) }, C: { w: excelWidthToPx(9.140625), hidden: true }, D: { w: excelWidthToPx(9.140625), hidden: true } });
    expect(sheet.rows).toEqual({ "1": { h: pointsToPx(30) }, "3": { h: pointsToPx(21) }, "4": { hidden: true } });
    expect(sheet.merges).toEqual(["A1:B2"]);
    expect(sheet.freeze).toEqual({ rows: 1, cols: 2 });
    expect(sheet.gridlines).toBe(false);
    expect(sheet.color).toBe("#ed7d31");
  });

  it("ignores split panes that are not frozen and keeps gridlines on by default", async () => {
    const xml = ws(`<sheetViews><sheetView workbookViewId="0"><pane xSplit="2400" ySplit="1600" state="split"/></sheetView></sheetViews>${data("")}`);
    const sheet = await firstSheet(xlsx({ sheets: [{ name: "Data", xml }] }));
    expect(sheet.freeze).toBeUndefined();
    expect(sheet.gridlines).toBeUndefined();
  });

  it("applies row formatting only when the row says it is custom", async () => {
    const book = styles({ fonts: `<font><sz val="11"/><name val="Calibri"/></font><font><i/><sz val="11"/><name val="Calibri"/></font>`, cellXfs: `${PLAIN_XF}<xf fontId="1"/>` });
    const sheet = await firstSheet(oneSheet(`<row r="1" s="1" customFormat="1"/><row r="2" s="1"/>`, "", { styles: book }));
    expect(sheet.rows).toEqual({ "1": { s: { italic: true } } });
  });
});

/* ------------------------------------------------------------------ filters */

describe("importXlsxWorkbook: filter", () => {
  it("imports value lists, simple comparisons, wildcard text tests, and the sort", async () => {
    const after = `<autoFilter ref="A1:F20">
      <filterColumn colId="1"><filters blank="1"><filter val="East"/><filter val="West"/></filters></filterColumn>
      <filterColumn colId="2"><customFilters><customFilter operator="greaterThan" val="100"/></customFilters></filterColumn>
      <filterColumn colId="3"><customFilters><customFilter val="*rush*"/></customFilters></filterColumn>
      <filterColumn colId="4"><customFilters><customFilter operator="notEqual" val="*void*"/></customFilters></filterColumn>
      <filterColumn colId="5"><customFilters><customFilter val="INV*"/></customFilters></filterColumn>
      <filterColumn colId="0"><top10 val="5"/></filterColumn>
      <sortState ref="A2:F20"><sortCondition descending="1" ref="C2:C20"/></sortState></autoFilter>`;
    const { workbook, warnings } = await importXlsxWorkbook(oneSheet("", after));
    expect(workbook.sheets[0].filter).toEqual({
      ref: "A1:F20",
      criteria: {
        B: { values: ["East", "West", ""] },
        C: { condition: { op: "gt", value: "100" } },
        D: { condition: { op: "contains", value: "rush" } },
        E: { condition: { op: "notContains", value: "void" } },
        F: { condition: { op: "begins", value: "INV" } },
      },
      sort: { col: "C", desc: true },
    });
    expect(warnings.join(" ")).toMatch(/filter conditions on "Data"/);
  });

  it("reads between and notBetween from inclusive and-pairs and exclusive or-pairs", async () => {
    const after = `<autoFilter ref="A1:D9">
      <filterColumn colId="0"><customFilters and="1"><customFilter operator="greaterThanOrEqual" val="10"/><customFilter operator="lessThanOrEqual" val="20"/></customFilters></filterColumn>
      <filterColumn colId="1"><customFilters><customFilter operator="lessThan" val="1"/><customFilter operator="greaterThan" val="5"/></customFilters></filterColumn>
      <filterColumn colId="2"><customFilters><customFilter operator="greaterThanOrEqual" val="1"/><customFilter operator="lessThanOrEqual" val="5"/></customFilters></filterColumn>
      <filterColumn colId="3"><customFilters and="1"><customFilter operator="lessThan" val="1"/><customFilter operator="greaterThan" val="5"/></customFilters></filterColumn></autoFilter>`;
    const { workbook, warnings } = await importXlsxWorkbook(oneSheet("", after));
    expect(workbook.sheets[0].filter?.criteria).toEqual({
      A: { condition: { op: "between", value: "10", value2: "20" } },
      B: { condition: { op: "notBetween", value: "1", value2: "5" } },
    });
    expect(warnings.join(" ")).toMatch(/filter conditions on "Data"/);
  });

  it("round-trips between filters through an exported file", async () => {
    const criteria = { B: { condition: { op: "between", value: "2", value2: "4" } }, C: { condition: { op: "notBetween", value: "x", value2: "y" } } };
    const parsed = parseWorkbook({ sheets: [{ name: "Data", cells: { A1: { v: "a" }, B1: { v: "b" }, C1: { v: "c" }, A2: { v: 1 } }, filter: { ref: "A1:C5", criteria } }] });
    if (!parsed.ok) throw new Error(parsed.error);
    const { workbook } = await importXlsxWorkbook(buildXlsxWorkbook(parsed.workbook, { title: "Round trip" }).bytes);
    expect(workbook.sheets[0].filter?.criteria).toEqual(criteria);
  });

  it("reads ends-with filters and leaves two-part custom filters out", async () => {
    const after = `<autoFilter ref="A1:B9"><filterColumn colId="0"><customFilters><customFilter val="*.pdf"/></customFilters></filterColumn>
      <filterColumn colId="1"><customFilters and="1"><customFilter operator="greaterThan" val="1"/><customFilter operator="lessThan" val="9"/></customFilters></filterColumn></autoFilter>`;
    const sheet = await firstSheet(oneSheet("", after));
    expect(sheet.filter).toEqual({ ref: "A1:B9", criteria: { A: { condition: { op: "ends", value: ".pdf" } } } });
  });
});

/* ------------------------------------------------------------------ conditional formatting */

describe("importXlsxWorkbook: conditional formatting", () => {
  it("maps every supported rule type and its differential style, in priority order", async () => {
    const dxfs = `<dxf><font><b/><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf>
      <dxf><fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/></patternFill></fill></dxf>`;
    const rules = `
      <conditionalFormatting sqref="B1:B10"><cfRule type="colorScale" priority="2"><colorScale><cfvo type="min"/><cfvo type="percentile" val="50"/><cfvo type="max"/><color rgb="FFF8696B"/><color rgb="FFFFEB84"/><color rgb="FF63BE7B"/></colorScale></cfRule></conditionalFormatting>
      <conditionalFormatting sqref="A1:A10"><cfRule type="colorScale" priority="1"><colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FFF8696B"/><color theme="9"/></colorScale></cfRule></conditionalFormatting>
      <conditionalFormatting sqref="C1:C10"><cfRule type="dataBar" priority="3"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF638EC6"/></dataBar></cfRule></conditionalFormatting>
      <conditionalFormatting sqref="D1:D10 F1:F10"><cfRule type="cellIs" dxfId="0" priority="4" operator="between"><formula>10</formula><formula>$Z$1</formula></cfRule></conditionalFormatting>
      <conditionalFormatting sqref="E1:E10"><cfRule type="cellIs" dxfId="1" priority="5" operator="equal"><formula>"Done ""ok"""</formula></cfRule></conditionalFormatting>
      <conditionalFormatting sqref="G1:G10">
        <cfRule type="containsText" dxfId="0" priority="6" operator="containsText" text="late"><formula>NOT(ISERROR(SEARCH("late",G1)))</formula></cfRule>
        <cfRule type="notContainsText" dxfId="0" priority="7" operator="notContains" text="ok"><formula>ISERROR(SEARCH("ok",G1))</formula></cfRule>
        <cfRule type="beginsWith" dxfId="0" priority="8" operator="beginsWith" text="A"><formula>LEFT(G1,1)="A"</formula></cfRule>
        <cfRule type="endsWith" dxfId="0" priority="9" operator="endsWith" text="z"><formula>RIGHT(G1,1)="z"</formula></cfRule></conditionalFormatting>
      <conditionalFormatting sqref="H1:H10">
        <cfRule type="top10" dxfId="0" priority="10" rank="3"/><cfRule type="top10" dxfId="0" priority="11" rank="10" percent="1" bottom="1"/>
        <cfRule type="duplicateValues" dxfId="0" priority="12"/><cfRule type="uniqueValues" dxfId="0" priority="13"/>
        <cfRule type="aboveAverage" dxfId="0" priority="14"/><cfRule type="aboveAverage" dxfId="0" priority="15" aboveAverage="0"/>
        <cfRule type="containsBlanks" dxfId="0" priority="16"><formula>LEN(TRIM(H1))=0</formula></cfRule>
        <cfRule type="notContainsBlanks" dxfId="0" priority="17"><formula>LEN(TRIM(H1))&gt;0</formula></cfRule></conditionalFormatting>
      <conditionalFormatting sqref="I1:I10">
        <cfRule type="expression" dxfId="1" priority="18"><formula>$I1&gt;_xlfn.XLOOKUP(1,$A:$A,$B:$B)</formula></cfRule>
        <cfRule type="timePeriod" dxfId="1" priority="19" timePeriod="yesterday"><formula>FLOOR(I1,1)=TODAY()-1</formula></cfRule>
        <cfRule type="iconSet" priority="20"><iconSet iconSet="3Arrows"><cfvo type="percent" val="0"/><cfvo type="percent" val="33"/><cfvo type="percent" val="67"/></iconSet></cfRule></conditionalFormatting>`;
    const { workbook, warnings } = await importXlsxWorkbook(oneSheet("", rules, { styles: styles({ cellXfs: PLAIN_XF, dxfs }) }));
    const red = { fill: "#ffc7ce", color: "#9c0006", bold: true };
    const green = { fill: "#c6efce" };
    expect(workbook.sheets[0].conditional).toEqual([
      { id: "cf-1", ref: "A1:A10", type: "scale", min: "#f8696b", max: "#70ad47" },
      { id: "cf-2", ref: "B1:B10", type: "scale", min: "#f8696b", mid: "#ffeb84", max: "#63be7b" },
      { id: "cf-3", ref: "C1:C10", type: "bar", color: "#638ec6" },
      { id: "cf-4", ref: "D1:D10", type: "cell", op: "between", value: "10", value2: "=$Z$1", style: red },
      { id: "cf-5", ref: "F1:F10", type: "cell", op: "between", value: "10", value2: "=$Z$1", style: red },
      { id: "cf-6", ref: "E1:E10", type: "cell", op: "eq", value: 'Done "ok"', style: green },
      { id: "cf-7", ref: "G1:G10", type: "text", op: "contains", text: "late", style: red },
      { id: "cf-8", ref: "G1:G10", type: "text", op: "notContains", text: "ok", style: red },
      { id: "cf-9", ref: "G1:G10", type: "text", op: "begins", text: "A", style: red },
      { id: "cf-10", ref: "G1:G10", type: "text", op: "ends", text: "z", style: red },
      { id: "cf-11", ref: "H1:H10", type: "top", count: 3, style: red },
      { id: "cf-12", ref: "H1:H10", type: "bottom", count: 10, percent: true, style: red },
      { id: "cf-13", ref: "H1:H10", type: "duplicate", style: red },
      { id: "cf-14", ref: "H1:H10", type: "unique", style: red },
      { id: "cf-15", ref: "H1:H10", type: "above", style: red },
      { id: "cf-16", ref: "H1:H10", type: "below", style: red },
      { id: "cf-17", ref: "H1:H10", type: "blank", style: red },
      { id: "cf-18", ref: "H1:H10", type: "notBlank", style: red },
      { id: "cf-19", ref: "I1:I10", type: "formula", formula: "$I1>XLOOKUP(1,$A:$A,$B:$B)", style: green },
      { id: "cf-20", ref: "I1:I10", type: "formula", formula: "FLOOR(I1,1)=TODAY()-1", style: green },
    ]);
    expect(warnings.join(" ")).toMatch(/1 conditional format on "Data"/);
  });
});

/* ------------------------------------------------------------------ data validation */

describe("importXlsxWorkbook: data validation", () => {
  it("imports lists, ranges, named lists, and numeric, date, and length rules", async () => {
    const after = `<dataValidations count="9">
      <dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="A2:A20" error="Pick one"><formula1>"Open,Closed,Blocked"</formula1></dataValidation>
      <dataValidation type="list" showErrorMessage="1" errorStyle="warning" sqref="B2:B20 D2:D5"><formula1>$Z$1:$Z$4</formula1></dataValidation>
      <dataValidation type="list" sqref="C2"><formula1>StatusList</formula1></dataValidation>
      <dataValidation type="whole" operator="between" showErrorMessage="1" sqref="E2:E20" prompt="1 to 10"><formula1>1</formula1><formula2>10</formula2></dataValidation>
      <dataValidation type="decimal" operator="greaterThan" showErrorMessage="1" sqref="F2:F20"><formula1>0.5</formula1></dataValidation>
      <dataValidation type="date" operator="lessThanOrEqual" showErrorMessage="1" sqref="G2:G20"><formula1>45658</formula1></dataValidation>
      <dataValidation type="textLength" operator="lessThan" sqref="H2:H20"><formula1>$Z$9</formula1></dataValidation>
      <dataValidation type="custom" sqref="I2:I20"><formula1>ISNUMBER(I2)</formula1></dataValidation>
      <dataValidation type="none" sqref="J2" prompt="Just a hint"/></dataValidations>
      <extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:dataValidations xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main" count="1"><x14:dataValidation type="list" allowBlank="1" showErrorMessage="1"><x14:formula1><xm:f>Lists!$A$1:$A$3</xm:f></x14:formula1><xm:sqref>K2:K9</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst>`;
    const bytes = xlsx({
      sheets: [{ name: "Data", xml: ws(`${data("")}${after}`) }, { name: "Lists", xml: ws(data("")) }],
      definedNames: `<definedName name="StatusList">Lists!$B$1:$B$4</definedName>`,
    });
    const { workbook, warnings } = await importXlsxWorkbook(bytes);
    expect(workbook.sheets[0].validations).toEqual([
      { id: "dv-1", ref: "A2:A20", kind: "list", items: ["Open", "Closed", "Blocked"], strict: true, message: "Pick one" },
      { id: "dv-2", ref: "B2:B20", kind: "list", source: "Z1:Z4", strict: false },
      { id: "dv-3", ref: "D2:D5", kind: "list", source: "Z1:Z4", strict: false },
      { id: "dv-4", ref: "C2", kind: "list", source: "Lists!B1:B4", strict: false },
      { id: "dv-5", ref: "E2:E20", kind: "whole", op: "between", value: "1", value2: "10", strict: true, message: "1 to 10" },
      { id: "dv-6", ref: "F2:F20", kind: "decimal", op: "gt", value: "0.5", strict: true },
      { id: "dv-7", ref: "G2:G20", kind: "date", op: "lte", value: "45658", strict: true },
      { id: "dv-8", ref: "H2:H20", kind: "textLength", op: "lt", value: "=$Z$9", strict: false },
      { id: "dv-9", ref: "K2:K9", kind: "list", source: "Lists!A1:A3", strict: true },
    ]);
    expect(warnings.join(" ")).toMatch(/1 data validation rule on "Data"/);
  });
});

/* ------------------------------------------------------------------ tables */

function tablePart(name: string, ref: string, style: string, extra = "", filter = true): string {
  const autoFilter = filter ? `<autoFilter ref="${ref}"/>` : "";
  return `<table xmlns="${MAIN}" id="1" name="${name}" displayName="${name}" ref="${ref}" ${extra}>${autoFilter}<tableColumns count="2"><tableColumn id="1" name="A"/><tableColumn id="2" name="B"/></tableColumns>${style}</table>`;
}

const styleInfo = (name: string, stripes = "1", first = "0") =>
  `<tableStyleInfo name="${name}" showFirstColumn="${first}" showLastColumn="0" showRowStripes="${stripes}" showColumnStripes="0"/>`;

describe("importXlsxWorkbook: tables", () => {
  it("maps table names, ranges, totals, stripes, filter buttons, and built-in styles", async () => {
    const tables = [
      tablePart("Sales", "A1:B5", styleInfo("TableStyleMedium4", "1", "1"), 'totalsRowCount="1"'),
      tablePart("Costs", "D1:E5", styleInfo("TableStyleLight12", "0")),
      tablePart("Plan", "G1:H5", styleInfo("TableStyleDark7"), "", false),
      tablePart("Custom", "J1:K5", styleInfo("Corporate Blue")),
      tablePart("Defaults", "M1:N5", styleInfo("TableStyleMedium2")),
      tablePart("Headless", "P1:Q5", "", 'headerRowCount="0"'),
    ];
    const rels = tables.map((_, index) => ({ id: `rIdT${index + 1}`, type: "table", target: `../tables/table${index + 1}.xml` }));
    const parts = Object.fromEntries(tables.map((xml, index) => [`xl/tables/table${index + 1}.xml`, xml]));
    const { workbook, warnings } = await importXlsxWorkbook(oneSheet("", "", { parts }, rels));
    expect(workbook.sheets[0].tables).toEqual([
      { id: "table-1", name: "Sales", ref: "A1:B5", accent: 3, tone: "medium", banded: true, totals: true, filterButtons: true, firstColumn: true },
      { id: "table-2", name: "Costs", ref: "D1:E5", accent: 4, tone: "light", banded: false, totals: false, filterButtons: true },
      { id: "table-3", name: "Plan", ref: "G1:H5", accent: 6, tone: "dark", banded: true, totals: false, filterButtons: false },
      { id: "table-4", name: "Custom", ref: "J1:K5", accent: 1, tone: "medium", banded: true, totals: false, filterButtons: true },
      { id: "table-5", name: "Defaults", ref: "M1:N5", accent: 1, tone: "medium", banded: true, totals: false, filterButtons: true },
    ]);
    expect(warnings.join(" ")).toMatch(/"Headless".*no header row/);
  });
});

/* ------------------------------------------------------------------ notes */

describe("importXlsxWorkbook: notes", () => {
  it("turns comments into notes without the author line, including threaded comments", async () => {
    const comments = `<comments xmlns="${MAIN}"><authors><author>Ana Synthetic</author><author>tc={0A1B}</author></authors><commentList>
      <comment ref="A1" authorId="0"><text><r><rPr><b/></rPr><t>Ana Synthetic:</t></r><r><t xml:space="preserve">
Check the totals</t></r></text></comment>
      <comment ref="C3" authorId="1"><text><t>[Threaded comment]

Your version of Excel allows you to read this threaded comment; however, any edits to it will get removed if the file is opened in a newer version of Excel. Learn more: https://go.microsoft.com/fwlink/?linkid=870924

Comment:
    Is this final?
Reply:
    Yes, approved.</t></text></comment>
      <comment ref="B2" authorId="0"><text><t>No prefix here</t></text></comment></commentList></comments>`;
    const bytes = oneSheet('<row r="1"><c r="A1"><v>5</v></c></row>', "", { parts: { "xl/comments1.xml": comments } }, [{ id: "rIdC", type: "comments", target: "../comments1.xml" }]);
    const sheet = await firstSheet(bytes);
    expect(sheet.cells).toEqual({
      A1: { v: 5, n: "Check the totals" },
      B2: { n: "No prefix here" },
      C3: { n: "Is this final?\nReply:\nYes, approved." },
    });
  });
});

/* ------------------------------------------------------------------ charts and drawings */

const CHART = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const DML = "http://schemas.openxmlformats.org/drawingml/2006/main";
const XDR = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";

function chartSpace(inner: string): string {
  return `<c:chartSpace xmlns:c="${CHART}" xmlns:a="${DML}" xmlns:r="${REL}"><c:chart>${inner}</c:chart></c:chartSpace>`;
}

function richTitle(text: string): string {
  return `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;
}

function ser(tx: string, cat: string, val: string, [catTag, valTag] = ["cat", "val"]): string {
  return `<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>${tx}</c:f></c:strRef></c:tx><c:${catTag}><c:strRef><c:f>${cat}</c:f></c:strRef></c:${catTag}><c:${valTag}><c:numRef><c:f>${val}</c:f></c:numRef></c:${valTag}></c:ser>`;
}

function axis(tag: string, position: string, title = ""): string {
  return `<c:${tag}><c:axId val="1"/><c:axPos val="${position}"/>${title ? richTitle(title) : ""}</c:${tag}>`;
}

function frame(rid: string, uri = CHART, prefix = "c"): string {
  return `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${uri}"><${prefix}:chart xmlns:${prefix}="${uri}" r:id="${rid}"/></a:graphicData></a:graphic></xdr:graphicFrame>`;
}

function twoCell(from: [number, number], to: [number, number], content: string): string {
  const point = (tag: string, [col, row]: [number, number]) => `<xdr:${tag}><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:${tag}>`;
  return `<xdr:twoCellAnchor>${point("from", from)}${point("to", to)}${content}<xdr:clientData/></xdr:twoCellAnchor>`;
}

function oneCell(from: [number, number], px: [number, number], content: string): string {
  return `<xdr:oneCellAnchor><xdr:from><xdr:col>${from[0]}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${from[1]}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="${px[0] * 9525}" cy="${px[1] * 9525}"/>${content}<xdr:clientData/></xdr:oneCellAnchor>`;
}

/** A "Data" sheet with one drawing holding `anchors`, and chart parts by number. */
function withDrawing(anchors: string[], charts: Record<number, string>, chartRels: Rel[] = []): Uint8Array {
  const rels = Object.keys(charts).map((n) => ({ id: `rIdC${n}`, type: "chart", target: `../charts/chart${n}.xml` }));
  const parts: Record<string, string> = {
    "xl/drawings/drawing1.xml": `<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${DML}" xmlns:r="${REL}">${anchors.join("")}</xdr:wsDr>`,
    "xl/drawings/_rels/drawing1.xml.rels": relsXml([...rels, ...chartRels]),
    ...Object.fromEntries(Object.entries(charts).map(([n, xml]) => [`xl/charts/chart${n}.xml`, xml])),
  };
  return oneSheet("", "", { parts }, [{ id: "rIdD", type: "drawing", target: "../drawings/drawing1.xml" }]);
}

describe("importXlsxWorkbook: charts", () => {
  it("imports a clustered column chart with titles, legend, anchor, and size", async () => {
    const plot = `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>${ser("Data!$B$1", "Data!$A$2:$A$4", "Data!$B$2:$B$4")}${ser("Data!$C$1", "Data!$A$2:$A$4", "Data!$C$2:$C$4")}</c:barChart>`;
    const chart = chartSpace(`${richTitle("Revenue")}<c:plotArea><c:layout/>${plot}${axis("catAx", "b", "Month")}${axis("valAx", "l", "USD")}</c:plotArea><c:legend><c:legendPos val="b"/></c:legend>`);
    const sheet = await firstSheet(withDrawing([twoCell([4, 1], [10, 16], frame("rIdC1"))], { 1: chart }));
    expect(sheet.charts).toEqual([
      { id: "chart-1", type: "column", title: "Revenue", source: "A1:C4", seriesBy: "columns", legend: "bottom", xTitle: "Month", yTitle: "USD", at: "E2", w: 384, h: 300 },
    ]);
  });

  it("reads stacked bars by rows with data labels and no legend, sized from a one-cell anchor", async () => {
    const plot = `<c:barChart><c:barDir val="bar"/><c:grouping val="stacked"/><c:dLbls><c:showVal val="1"/></c:dLbls>${ser("Data!$A$2", "Data!$B$1:$D$1", "Data!$B$2:$D$2")}${ser("Data!$A$3", "Data!$B$1:$D$1", "Data!$B$3:$D$3")}</c:barChart>`;
    const sheet = await firstSheet(withDrawing([oneCell([1, 5], [500, 320], frame("rIdC1"))], { 1: chartSpace(`<c:plotArea>${plot}</c:plotArea>`) }));
    expect(sheet.charts).toEqual([{ id: "chart-1", type: "bar", source: "A1:D3", seriesBy: "rows", stacked: true, legend: "none", showValues: true, at: "B6", w: 500, h: 320 }]);
  });

  it("reads line, area, pie, doughnut, and scatter charts", async () => {
    const one = ser("Data!$B$1", "Data!$A$2:$A$4", "Data!$B$2:$B$4");
    const legend = '<c:legend><c:legendPos val="r"/></c:legend>';
    const scatter = `<c:scatterChart>${ser("Data!$B$1", "Data!$A$2:$A$4", "Data!$B$2:$B$4", ["xVal", "yVal"])}</c:scatterChart>${axis("valAx", "b", "Hours")}${axis("valAx", "l", "Output")}`;
    const charts = {
      1: chartSpace(`<c:plotArea><c:lineChart><c:grouping val="standard"/>${one}</c:lineChart></c:plotArea>${legend}`),
      2: chartSpace(`<c:plotArea><c:areaChart><c:grouping val="percentStacked"/>${one}</c:areaChart></c:plotArea><c:legend><c:legendPos val="t"/></c:legend>`),
      3: chartSpace(`<c:plotArea><c:pie3DChart>${one}</c:pie3DChart></c:plotArea>${legend}`),
      4: chartSpace(`<c:plotArea><c:doughnutChart>${one}</c:doughnutChart></c:plotArea>${legend}`),
      5: chartSpace(`<c:plotArea>${scatter}</c:plotArea><c:legend/>`),
    };
    const anchors = [1, 2, 3, 4, 5].map((n) => oneCell([n, 0], [400, 300], frame(`rIdC${n}`)));
    const sheet = await firstSheet(withDrawing(anchors, charts));
    expect(sheet.charts?.map((chart) => [chart.type, chart.stacked ?? false, chart.legend])).toEqual([
      ["line", false, "right"],
      ["area", true, "top"],
      ["pie", false, "right"],
      ["doughnut", false, "right"],
      ["scatter", false, "right"],
    ]);
    expect(sheet.charts?.[4]).toMatchObject({ source: "A1:B4", xTitle: "Hours", yTitle: "Output" });
  });

  it("sizes two-cell anchors from column widths, row heights, and offsets", async () => {
    const chart = chartSpace(`<c:plotArea><c:lineChart>${ser("Data!$B$1", "Data!$A$2:$A$4", "Data!$B$2:$B$4")}</c:lineChart></c:plotArea>`);
    const point = (tag: string, col: number, colPx: number, row: number, rowPx: number) =>
      `<xdr:${tag}><xdr:col>${col}</xdr:col><xdr:colOff>${colPx * 9525}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${rowPx * 9525}</xdr:rowOff></xdr:${tag}>`;
    const anchor = `<xdr:twoCellAnchor>${point("from", 1, 10, 2, 5)}${point("to", 3, 20, 12, 0)}${frame("rIdC1")}<xdr:clientData/></xdr:twoCellAnchor>`;
    const parts = {
      "xl/drawings/drawing1.xml": `<xdr:wsDr xmlns:xdr="${XDR}" xmlns:a="${DML}" xmlns:r="${REL}">${anchor}</xdr:wsDr>`,
      "xl/drawings/_rels/drawing1.xml.rels": relsXml([{ id: "rIdC1", type: "chart", target: "../charts/chart1.xml" }]),
      "xl/charts/chart1.xml": chart,
    };
    const xml = ws(`<cols><col min="2" max="2" width="20" customWidth="1"/></cols>${data('<row r="5" ht="30" customHeight="1"/>')}<drawing r:id="rIdD"/>`);
    const bytes = xlsx({ sheets: [{ name: "Data", xml, rels: [{ id: "rIdD", type: "drawing", target: "../drawings/drawing1.xml" }] }], parts });
    const sheet = await firstSheet(bytes);
    expect(sheet.charts?.[0]).toMatchObject({ at: "B3", w: excelWidthToPx(20) + 64 + 10, h: 9 * 20 + pointsToPx(30) - 5 });
  });

  it("places absolute anchors at A1 with their own size, and reads single-value series as columns", async () => {
    const chart = chartSpace(`<c:plotArea><c:barChart><c:barDir val="col"/>${ser("Data!$B$1", "Data!$A$2", "Data!$B$2")}${ser("Data!$C$1", "Data!$A$2", "Data!$C$2")}</c:barChart></c:plotArea>`);
    const anchor = `<xdr:absoluteAnchor><xdr:pos x="0" y="0"/><xdr:ext cx="${420 * 9525}" cy="${260 * 9525}"/>${frame("rIdC1")}<xdr:clientData/></xdr:absoluteAnchor>`;
    const sheet = await firstSheet(withDrawing([anchor], { 1: chart }));
    expect(sheet.charts?.[0]).toMatchObject({ at: "A1", w: 420, h: 260, source: "A1:C2", seriesBy: "columns" });
  });

  it("leaves out charts anchored past the sheet's last row or column", async () => {
    const chart = chartSpace(`<c:plotArea><c:lineChart>${ser("Data!$B$1", "Data!$A$2:$A$4", "Data!$B$2:$B$4")}</c:lineChart></c:plotArea>`);
    const anchors = [oneCell([256, 0], [400, 300], frame("rIdC1")), oneCell([0, MAX_SHEET_ROWS], [400, 300], frame("rIdC1")), oneCell([255, MAX_SHEET_ROWS - 1], [400, 300], frame("rIdC1"))];
    const { workbook, warnings } = await importXlsxWorkbook(withDrawing(anchors, { 1: chart }));
    expect(workbook.sheets[0].charts?.map((item) => item.at)).toEqual([`IV${MAX_SHEET_ROWS}`]);
    expect(warnings.join(" ")).toMatch(/2 charts on "Data" \(placed past the sheet's last row or column\)/);
  });

  it("uses the frame's own size when it has one", async () => {
    const chart = chartSpace(`<c:plotArea><c:lineChart>${ser("Data!$B$1", "Data!$A$2:$A$4", "Data!$B$2:$B$4")}</c:lineChart></c:plotArea>`);
    const sized = frame("rIdC1").replace('<a:ext cx="0" cy="0"/>', '<a:ext cx="4319640" cy="2519640"/>');
    const sheet = await firstSheet(withDrawing([twoCell([0, 0], [2, 2], sized)], { 1: chart }));
    expect(sheet.charts?.[0]).toMatchObject({ at: "A1", w: 454, h: 265 });
  });

  it("leaves out charts with off-sheet data or unsupported types, pictures, and shapes, with warnings", async () => {
    const offSheet = chartSpace(`<c:plotArea><c:barChart><c:barDir val="col"/>${ser("Other!$B$1", "Other!$A$2:$A$4", "Other!$B$2:$B$4")}</c:barChart></c:plotArea>`);
    const radar = chartSpace(`<c:plotArea><c:radarChart>${ser("Data!$B$1", "Data!$A$2:$A$4", "Data!$B$2:$B$4")}</c:radarChart></c:plotArea>`);
    const literal = chartSpace(`<c:plotArea><c:lineChart><c:ser><c:val><c:numLit><c:pt idx="0"><c:v>1</c:v></c:pt></c:numLit></c:val></c:ser></c:lineChart></c:plotArea>`);
    const combo = chartSpace(`<c:plotArea><c:barChart><c:barDir val="col"/>${ser("Data!$B$1", "Data!$A$2:$A$4", "Data!$B$2:$B$4")}</c:barChart><c:lineChart>${ser("Data!$C$1", "Data!$A$2:$A$4", "Data!$C$2:$C$4")}</c:lineChart></c:plotArea>`);
    const picture = `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="3" name="Logo"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rIdImg"/></xdr:blipFill><xdr:spPr/></xdr:pic>`;
    const shape = `<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="4" name="Box"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr/></xdr:sp>`;
    const CHARTEX = "http://schemas.microsoft.com/office/drawing/2014/chartex";
    const anchors = [
      oneCell([0, 0], [400, 300], frame("rIdC1")),
      oneCell([0, 20], [400, 300], frame("rIdC2")),
      oneCell([0, 40], [400, 300], frame("rIdC3")),
      oneCell([0, 60], [400, 300], frame("rIdC4")),
      oneCell([0, 80], [400, 300], frame("rIdX", CHARTEX, "cx")),
      oneCell([0, 100], [100, 100], picture),
      oneCell([0, 120], [100, 100], shape),
    ];
    const { workbook, warnings } = await importXlsxWorkbook(
      withDrawing(anchors, { 1: offSheet, 2: radar, 3: literal, 4: combo }, [{ id: "rIdX", type: "chartEx", target: "../charts/chartEx1.xml" }]),
    );
    expect(workbook.sheets[0].charts?.map((chart) => chart.type)).toEqual(["column"]);
    const text = warnings.join(" ");
    expect(text).toMatch(/1 chart on "Data" \(its data is on another sheet\)/);
    expect(text).toMatch(/2 charts on "Data" \(a chart type Aperture can't draw yet\)/);
    expect(text).toMatch(/1 chart on "Data" \(no cell data\)/);
    expect(text).toMatch(/Combination charts/);
    expect(text).toMatch(/1 picture on "Data"/);
    expect(text).toMatch(/1 shape or drawing object on "Data"/);
  });

  it("says pivot tables come in as values", async () => {
    const bytes = oneSheet('<row r="1"><c r="A1"><v>3</v></c></row>', "", { parts: { "xl/pivotTables/pivotTable1.xml": "<pivotTableDefinition/>" } }, [
      { id: "rIdP", type: "pivotTable", target: "../pivotTables/pivotTable1.xml" },
    ]);
    const { workbook, warnings } = await importXlsxWorkbook(bytes);
    expect(workbook.sheets[0].cells.A1).toEqual({ v: 3 });
    expect(warnings.join(" ")).toMatch(/Pivot tables on "Data" were imported as values/);
  });
});

/* ------------------------------------------------------------------ limits */

describe("importXlsxWorkbook: limits", () => {
  it("keeps rows and columns inside the sheet limits and says so", async () => {
    const rows = `<row r="1"><c r="IV1"><v>1</v></c><c r="IW1"><v>2</v></c></row><row r="${MAX_SHEET_ROWS}"><c r="A${MAX_SHEET_ROWS}"><v>3</v></c></row><row r="${MAX_SHEET_ROWS + 1}"><c r="A${MAX_SHEET_ROWS + 1}"><v>4</v></c></row>`;
    const { workbook, warnings } = await importXlsxWorkbook(oneSheet(rows));
    expect(Object.keys(workbook.sheets[0].cells).sort()).toEqual([`A${MAX_SHEET_ROWS}`, "IV1"]);
    expect(warnings.join(" ")).toMatch(/first 20,000 rows of "Data"/);
    expect(warnings.join(" ")).toMatch(/columns A–IV of "Data"/);
  });

  it(`stops at ${MAX_WORKBOOK_CELLS.toLocaleString("en-US")} filled cells across the workbook`, async () => {
    const row = `<row>${'<c s="1"/>'.repeat(20)}</row>`;
    const big = ws(data(row.repeat(MAX_WORKBOOK_CELLS / 20)));
    const small = ws(data('<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row>'));
    const book = styles({ cellXfs: `${PLAIN_XF}<xf fillId="2"/>`, fills: '<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill>' });
    const { workbook, warnings } = await importXlsxWorkbook(xlsx({ sheets: [{ name: "Big", xml: big }, { name: "Small", xml: small }], styles: book }));
    expect(workbookCellCount(workbook)).toBe(MAX_WORKBOOK_CELLS);
    expect(workbook.sheets[1].cells).toEqual({});
    expect(warnings.join(" ")).toMatch(/more than 200,000 filled cells/);
  }, 60_000);
});

/* ------------------------------------------------------------------ real-world fixture */

describe("importXlsxWorkbook: LibreOffice fixture", () => {
  it("imports a synthetic budget saved by LibreOffice Calc", async () => {
    const bytes = new Uint8Array(readFileSync(resolve(__dirname, "__fixtures__/libreoffice-budget.xlsx")));
    const { workbook, warnings } = await importXlsxWorkbook(bytes);
    expect(parseWorkbook(workbook).ok).toBe(true);
    expect(workbook.sheets.map((sheet) => [sheet.name, sheet.hidden ?? false])).toEqual([
      ["Budget", false],
      ["Notes", false],
      ["Lookup", true],
    ]);
    const [budget, notes] = workbook.sheets;
    expect(budget.color).toBe("#087d8b");
    expect(budget.merges).toEqual(["A1:E1"]);
    expect(budget.cells.A1).toEqual({ v: "Team Budget", s: { bold: true, size: 14, color: "#1f4e79", align: "center" } });
    expect(budget.cells.B3.s).toEqual({ bold: true, fill: "#ddebf7", align: "right", border: { bottom: { style: "thin", color: "#1f4e79" } } });
    expect(budget.cells.A3.s).toMatchObject({ valign: "top" });
    expect(budget.cells.A4).toEqual({ v: "Laptops", s: { wrap: true, indent: 1 }, n: "Synthetic note for the laptops line" });
    expect(budget.cells.B4).toEqual({ v: 1200, s: { format: "#,##0.00" } });
    expect(budget.cells.C4.s).toEqual({ font: "Georgia", format: "#,##0.00" });
    expect(budget.cells.D4).toEqual({ f: "B4+C4", s: { format: "#,##0.00" } });
    expect(budget.cells.E4).toEqual({ f: "D4/$D$8", s: { format: "0.0%" } });
    expect(budget.cells.F4.s?.format).toBe("yyyy\\-mm\\-dd");
    expect(budget.cells.D8.f).toBe("SUM(D4:D7)");
    expect(budget.cells.A6.s).toMatchObject({ italic: true });
    expect(budget.cells.A7.s).toMatchObject({ underline: true });
    expect(budget.cells.B7.s).toMatchObject({ strike: true });
    expect(budget.cols?.A.w).toBe(excelWidthToPx(19.4));
    expect(budget.cols?.H).toMatchObject({ hidden: true });
    expect(budget.rows?.["2"]).toEqual({ h: pointsToPx(25.5) });
    expect(budget.conditional).toEqual([{ id: "cf-1", ref: "D4:D7", type: "cell", op: "gt", value: "1000", style: expect.objectContaining({ fill: expect.stringMatching(/^#/) }) }]);
    expect(budget.validations).toEqual([
      { id: "dv-1", ref: "G4:G7", kind: "list", source: "Lookup!A1:A3", strict: true, message: "Pick a listed status" },
      { id: "dv-2", ref: "B4:B7", kind: "decimal", op: "between", value: "0", value2: "5000", strict: true },
    ]);
    expect(budget.tables).toEqual([{ id: "table-1", name: "BudgetFilter", ref: "A3:G7", accent: 1, tone: "medium", banded: true, totals: false, filterButtons: true }]);
    expect(budget.charts).toEqual([
      expect.objectContaining({ type: "column", title: "Quarterly spend", source: "A3:C7", seriesBy: "columns", legend: "none", at: "A11" }),
      expect.objectContaining({ type: "pie", source: "A4:B7", legend: "right", at: "F11" }),
    ]);
    expect(notes.cells.A1.v).toBe("Synthetic notes — café ünïcode");
    expect(notes.cells.A2).toEqual({ f: "1/0" });
    expect(notes.cells.A3).toEqual({ f: 'UPPER("mixed")' });
    expect(notes.cells.A5).toEqual({ f: "Budget!D8*2" });
    expect(notes.cells.C2).toEqual({ f: "B2*10" });
    expect(warnings).toEqual([]);
  });
});
