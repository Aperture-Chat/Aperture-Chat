import { describe, expect, it } from "vitest";
import { builtinNumberFormatId } from "../numberFormat";
import { StyleBook } from "./styles";

function parse(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
  return doc;
}

const tags = (doc: Document, name: string) => Array.from(doc.getElementsByTagName(name));

describe("StyleBook", () => {
  it("starts with Excel's required defaults: Calibri 11, none + gray125 fills", () => {
    const doc = parse(new StyleBook().toXml());
    const font = tags(doc, "font")[0];
    expect(font.getElementsByTagName("name")[0].getAttribute("val")).toBe("Calibri");
    expect(font.getElementsByTagName("sz")[0].getAttribute("val")).toBe("11");
    expect(tags(doc, "patternFill").map((fill) => fill.getAttribute("patternType"))).toEqual(["none", "gray125"]);
    expect(tags(doc, "cellXfs")[0].getAttribute("count")).toBe("1");
    expect(tags(doc, "cellStyle")[0].getAttribute("name")).toBe("Normal");
  });

  it("maps a cell style to font, fill, border, and alignment and dedupes it", () => {
    const book = new StyleBook();
    const style = {
      bold: true,
      italic: true,
      underline: true,
      strike: true,
      font: "Georgia",
      size: 14,
      color: "#213c3f",
      fill: "#fdeecf",
      align: "center" as const,
      valign: "middle" as const,
      wrap: true,
      border: { bottom: { style: "double" as const, color: "#087d8b" }, left: { style: "dashed" as const } },
    };
    const index = book.cellXf(style);
    expect(index).toBe(1);
    expect(book.cellXf({ ...style })).toBe(1);
    expect(book.cellXf(undefined)).toBe(0);
    expect(book.cellXf({})).toBe(0);
    const doc = parse(book.toXml());
    const xf = tags(doc, "cellXfs")[0].getElementsByTagName("xf")[1];
    const font = tags(doc, "font")[Number(xf.getAttribute("fontId"))];
    expect(Array.from(font.children, (child) => child.tagName)).toEqual(["b", "i", "strike", "u", "sz", "color", "name", "family"]);
    expect(font.getElementsByTagName("color")[0].getAttribute("rgb")).toBe("FF213C3F");
    const fill = tags(doc, "fill")[Number(xf.getAttribute("fillId"))];
    expect(fill.getElementsByTagName("patternFill")[0].getAttribute("patternType")).toBe("solid");
    expect(fill.getElementsByTagName("fgColor")[0].getAttribute("rgb")).toBe("FFFDEECF");
    const border = tags(doc, "border")[Number(xf.getAttribute("borderId"))];
    expect(Array.from(border.children, (child) => child.tagName)).toEqual(["left", "right", "top", "bottom", "diagonal"]);
    expect(border.getElementsByTagName("bottom")[0].getAttribute("style")).toBe("double");
    expect(border.getElementsByTagName("left")[0].getAttribute("style")).toBe("dashed");
    const alignment = xf.getElementsByTagName("alignment")[0];
    expect([alignment.getAttribute("horizontal"), alignment.getAttribute("vertical"), alignment.getAttribute("wrapText")]).toEqual(["center", "center", "1"]);
  });

  it("numbers custom formats from 164 and reuses built-in ids", () => {
    const book = new StyleBook();
    const custom = book.cellXf({ format: "\"$\"#,##0.0,\"K\"" });
    const percentId = builtinNumberFormatId("0%");
    const percent = book.cellXf({ format: "0%" });
    const doc = parse(book.toXml());
    const xfs = tags(doc, "cellXfs")[0].getElementsByTagName("xf");
    expect(xfs[custom].getAttribute("numFmtId")).toBe("164");
    expect(tags(doc, "numFmt")[0].getAttribute("formatCode")).toBe("\"$\"#,##0.0,\"K\"");
    expect(xfs[percent].getAttribute("numFmtId")).toBe(String(percentId ?? 165));
    expect(tags(doc, "numFmt")).toHaveLength(percentId === null ? 2 : 1);
  });

  it("points every format at the Normal style and applies only what it sets", () => {
    const book = new StyleBook();
    const bold = book.cellXf({ bold: true });
    const full = book.cellXf({ format: "0.0", fill: "#fdeecf", border: { top: { style: "thin" } }, wrap: true });
    const xfs = tags(parse(book.toXml()), "cellXfs")[0].getElementsByTagName("xf");
    const read = (index: number) => Object.fromEntries(Array.from(xfs[index].attributes, (item) => [item.name, item.value]));
    expect(read(bold)).toEqual({ numFmtId: "0", fontId: "1", fillId: "0", borderId: "0", xfId: "0", applyFont: "1" });
    expect(read(full)).toMatchObject({ fillId: "2", borderId: "1", xfId: "0", applyNumberFormat: "1", applyFill: "1", applyBorder: "1", applyAlignment: "1" });
    expect(read(full).applyFont).toBeUndefined();
  });

  it("numbers each new custom format one past the last", () => {
    const book = new StyleBook();
    book.cellXf({ format: "0.000\"u\"" });
    book.cellXf({ format: "0.0000\"v\"" });
    book.cellXf({ format: "0.000\"u\"" });
    expect(tags(parse(book.toXml()), "numFmt").map((item) => item.getAttribute("numFmtId"))).toEqual(["164", "165"]);
  });

  it("keeps the theme font scheme for Calibri, the workbook default", () => {
    const book = new StyleBook();
    const calibri = book.cellXf({ font: "Calibri", bold: true });
    const doc = parse(book.toXml());
    const font = tags(doc, "font")[Number(tags(doc, "cellXfs")[0].getElementsByTagName("xf")[calibri].getAttribute("fontId"))];
    expect(font.getElementsByTagName("scheme")[0]?.getAttribute("val")).toBe("minor");
  });

  it("indents only with a left or right alignment", () => {
    const book = new StyleBook();
    const indented = book.cellXf({ indent: 2 });
    const centered = book.cellXf({ indent: 2, align: "center" });
    const xfs = tags(parse(book.toXml()), "cellXfs")[0].getElementsByTagName("xf");
    const alignment = (index: number) => xfs[index].getElementsByTagName("alignment")[0];
    expect([alignment(indented).getAttribute("horizontal"), alignment(indented).getAttribute("indent")]).toEqual(["left", "2"]);
    expect(alignment(centered).getAttribute("indent")).toBeNull();
  });

  it("writes conditional styles as dxfs with the fill in bgColor", () => {
    const book = new StyleBook();
    expect(book.dxf({ fill: "#f8d7da", color: "#842029", bold: true })).toBe(0);
    expect(book.dxf({ fill: "#f8d7da", color: "#842029", bold: true })).toBe(0);
    expect(book.dxf({ fill: "#d1e7dd" })).toBe(1);
    const dxf = tags(parse(book.toXml()), "dxf")[0];
    expect(dxf.getElementsByTagName("b")).toHaveLength(1);
    expect(dxf.getElementsByTagName("color")[0].getAttribute("rgb")).toBe("FF842029");
    expect(dxf.getElementsByTagName("bgColor")[0].getAttribute("rgb")).toBe("FFF8D7DA");
  });

  it("writes a color-only conditional style as a font color", () => {
    const book = new StyleBook();
    book.dxf({ color: "#2f6eba" });
    const dxf = tags(parse(book.toXml()), "dxf")[0];
    expect(dxf.getElementsByTagName("color")[0].getAttribute("rgb")).toBe("FF2F6EBA");
    expect(dxf.getElementsByTagName("fill")).toHaveLength(0);
  });
});
