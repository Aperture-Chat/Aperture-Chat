/** styles.xml: every distinct cell style becomes one deduplicated cellXfs
 * entry built from deduplicated fonts, fills, borders, and number formats;
 * conditional-format styles become dxfs. Index 0 of each list is Excel's
 * required default (fills also need gray125 at index 1). */

import { builtinNumberFormatId } from "../numberFormat";
import { SHEET_EXPORT_FONT } from "../palette";
import type { CellBorder, CellStyle, ConditionalStyle } from "../sheetModel";
import { argb, attrs, escapeXml, NS, XML_HEADER } from "./xml";

const FIRST_CUSTOM_FORMAT = 164;
const BORDER_SIDES = ["left", "right", "top", "bottom"] as const;

/** Assigns stable indexes to distinct XML fragments. */
class Registry {
  private readonly indexes = new Map<string, number>();
  readonly items: string[] = [];

  constructor(initial: string[] = []) {
    initial.forEach((item) => this.add(item));
  }

  add(xml: string): number {
    const known = this.indexes.get(xml);
    if (known !== undefined) return known;
    this.items.push(xml);
    this.indexes.set(xml, this.items.length - 1);
    return this.items.length - 1;
  }
}

function colorXml(color: string | undefined, fallback: string): string {
  return color ? `<color rgb="${argb(color)}"/>` : fallback;
}

/** The workbook default family keeps the theme's minor-font scheme. */
function fontNameXml(font: string): string {
  const scheme = font === SHEET_EXPORT_FONT.name ? `<scheme val="minor"/>` : "";
  return `<name val="${escapeXml(font)}"/><family val="2"/>${scheme}`;
}

function fontXml(style: CellStyle): string {
  const { font = SHEET_EXPORT_FONT.name, size = SHEET_EXPORT_FONT.size } = style;
  const flags = [style.bold && "<b/>", style.italic && "<i/>", style.strike && "<strike/>", style.underline && "<u/>"];
  return `<font>${flags.filter(Boolean).join("")}<sz val="${size}"/>${colorXml(style.color, `<color theme="1"/>`)}${fontNameXml(font)}</font>`;
}

function fillXml(color: string): string {
  return `<fill><patternFill patternType="solid"><fgColor rgb="${argb(color)}"/><bgColor indexed="64"/></patternFill></fill>`;
}

function borderSideXml(side: string, border: CellBorder | undefined): string {
  if (!border) return `<${side}/>`;
  return `<${side} style="${border.style}">${colorXml(border.color, `<color indexed="64"/>`)}</${side}>`;
}

function borderXml(style: CellStyle): string {
  const sides = BORDER_SIDES.map((side) => borderSideXml(side, style.border?.[side])).join("");
  return `<border>${sides}<diagonal/></border>`;
}

function alignmentXml(style: CellStyle): string {
  const indent = style.indent && style.align !== "center" ? style.indent : undefined;
  const { align: horizontal = indent ? "left" : undefined } = style;
  const values = {
    horizontal,
    vertical: style.valign === "middle" ? "center" : style.valign,
    wrapText: style.wrap || undefined,
    indent,
  };
  const body = attrs(values);
  return body ? `<alignment${body}/>` : "";
}

const DEFAULT_FONT = fontXml({});
const DEFAULT_BORDER = borderXml({});
const DEFAULT_FILLS = [
  `<fill><patternFill patternType="none"/></fill>`,
  `<fill><patternFill patternType="gray125"/></fill>`,
];
const DEFAULT_XF = `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`;

function list(tag: string, items: string[], extra = ""): string {
  return `<${tag} count="${items.length}"${extra}>${items.join("")}</${tag}>`;
}

export class StyleBook {
  private readonly fonts = new Registry([DEFAULT_FONT]);
  private readonly fills = new Registry(DEFAULT_FILLS);
  private readonly borders = new Registry([DEFAULT_BORDER]);
  private readonly formats = new Map<string, number>();
  private readonly xfs = new Registry([DEFAULT_XF]);
  private readonly dxfs = new Registry();
  /** Distinct styles seen so far, so a sheet of repeated formats builds each once. */
  private readonly seen = new Map<string, number>();

  private numFmtId(format: string | undefined): number {
    if (!format) return 0;
    const builtin = builtinNumberFormatId(format);
    if (builtin !== null) return builtin;
    const known = this.formats.get(format);
    if (known !== undefined) return known;
    const id = FIRST_CUSTOM_FORMAT + this.formats.size;
    this.formats.set(format, id);
    return id;
  }

  /** The cellXfs index for a style; 0 for no style. */
  cellXf(style: CellStyle | undefined): number {
    if (!style || !Object.keys(style).length) return 0;
    const key = JSON.stringify(style);
    let index = this.seen.get(key);
    if (index === undefined) {
      index = this.buildXf(style);
      this.seen.set(key, index);
    }
    return index;
  }

  private buildXf(style: CellStyle): number {
    const numFmtId = this.numFmtId(style.format);
    const fontId = this.fonts.add(fontXml(style));
    const fillId = style.fill ? this.fills.add(fillXml(style.fill)) : 0;
    const borderId = this.borders.add(borderXml(style));
    const alignment = alignmentXml(style);
    const head = `<xf${attrs({
      numFmtId,
      fontId,
      fillId,
      borderId,
      xfId: 0,
      applyNumberFormat: numFmtId !== 0,
      applyFont: fontId !== 0,
      applyFill: fillId !== 0,
      applyBorder: borderId !== 0,
      applyAlignment: Boolean(alignment),
    })}`;
    return this.xfs.add(alignment ? `${head}>${alignment}</xf>` : `${head}/>`);
  }

  /** The dxfs index for a conditional-format style. */
  dxf(style: ConditionalStyle): number {
    const font = style.bold || style.color ? `<font>${style.bold ? "<b/>" : ""}${colorXml(style.color, "")}</font>` : "";
    const fill = style.fill ? `<fill><patternFill><bgColor rgb="${argb(style.fill)}"/></patternFill></fill>` : "";
    return this.dxfs.add(`<dxf>${font}${fill}</dxf>`);
  }

  toXml(): string {
    const numFmts = Array.from(this.formats, ([code, id]) => `<numFmt numFmtId="${id}" formatCode="${escapeXml(code)}"/>`);
    return (
      XML_HEADER +
      `<styleSheet xmlns="${NS.main}">` +
      (numFmts.length ? list("numFmts", numFmts) : "") +
      list("fonts", this.fonts.items) +
      list("fills", this.fills.items) +
      list("borders", this.borders.items) +
      list("cellStyleXfs", [`<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>`]) +
      list("cellXfs", this.xfs.items) +
      list("cellStyles", [`<cellStyle name="Normal" xfId="0" builtinId="0"/>`]) +
      list("dxfs", this.dxfs.items) +
      `<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>` +
      `</styleSheet>`
    );
  }
}
