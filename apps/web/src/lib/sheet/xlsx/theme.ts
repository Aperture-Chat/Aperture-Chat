/** xl/theme/theme1.xml: a complete Office theme whose six accents are the
 * workbook palette, so Excel's built-in table and chart styles render in the
 * editor's colors. Excel rejects a theme without a full font and format
 * scheme, so both are written out in full. */

import { SHEET_ACCENTS, SHEET_THEME_BASE } from "../palette";
import type { AccentSlot } from "../sheetModel";
import { NS, rgb, XML_HEADER } from "./xml";

const ACCENT_SLOTS: AccentSlot[] = [1, 2, 3, 4, 5, 6];

function slot(name: string, color: string): string {
  return `<a:${name}><a:srgbClr val="${rgb(color)}"/></a:${name}>`;
}

function colorScheme(): string {
  return (
    `<a:clrScheme name="Aperture">` +
    slot("dk1", SHEET_THEME_BASE.dark1) +
    slot("lt1", SHEET_THEME_BASE.light1) +
    slot("dk2", SHEET_THEME_BASE.dark2) +
    slot("lt2", SHEET_THEME_BASE.light2) +
    ACCENT_SLOTS.map((accent) => slot(`accent${accent}`, SHEET_ACCENTS[accent])).join("") +
    slot("hlink", SHEET_THEME_BASE.hyperlink) +
    slot("folHlink", SHEET_THEME_BASE.followedHyperlink) +
    `</a:clrScheme>`
  );
}

const FONT_SCHEME =
  `<a:fontScheme name="Office">` +
  `<a:majorFont><a:latin typeface="Calibri Light" panose="020F0302020204030204"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
  `<a:minorFont><a:latin typeface="Calibri" panose="020F0502020204030204"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>` +
  `</a:fontScheme>`;

function gradient(stops: string[]): string {
  const positions = [0, 50000, 100000];
  const gs = stops.map((mods, index) => `<a:gs pos="${positions[index]}"><a:schemeClr val="phClr">${mods}</a:schemeClr></a:gs>`).join("");
  return `<a:gradFill rotWithShape="1"><a:gsLst>${gs}</a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>`;
}

const mods = (values: Record<string, number>) => Object.entries(values).map(([name, val]) => `<a:${name} val="${val}"/>`).join("");
const PLACEHOLDER_FILL = `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>`;

function line(width: number): string {
  return `<a:ln w="${width}" cap="flat" cmpd="sng" algn="ctr">${PLACEHOLDER_FILL}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
}

const FORMAT_SCHEME =
  `<a:fmtScheme name="Office">` +
  `<a:fillStyleLst>` +
  PLACEHOLDER_FILL +
  gradient([
    mods({ lumMod: 110000, satMod: 105000, tint: 67000 }),
    mods({ lumMod: 105000, satMod: 103000, tint: 73000 }),
    mods({ lumMod: 105000, satMod: 109000, tint: 81000 }),
  ]) +
  gradient([
    mods({ satMod: 103000, lumMod: 102000, tint: 94000 }),
    mods({ satMod: 110000, lumMod: 100000, shade: 100000 }),
    mods({ lumMod: 99000, satMod: 120000, shade: 78000 }),
  ]) +
  `</a:fillStyleLst>` +
  `<a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst>` +
  `<a:effectStyleLst>` +
  `<a:effectStyle><a:effectLst/></a:effectStyle>` +
  `<a:effectStyle><a:effectLst/></a:effectStyle>` +
  `<a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0">` +
  `<a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle>` +
  `</a:effectStyleLst>` +
  `<a:bgFillStyleLst>` +
  PLACEHOLDER_FILL +
  `<a:solidFill><a:schemeClr val="phClr">${mods({ tint: 95000, satMod: 170000 })}</a:schemeClr></a:solidFill>` +
  gradient([
    mods({ tint: 93000, satMod: 150000, shade: 98000, lumMod: 102000 }),
    mods({ tint: 98000, satMod: 130000, shade: 90000, lumMod: 103000 }),
    mods({ shade: 63000, satMod: 120000 }),
  ]) +
  `</a:bgFillStyleLst>` +
  `</a:fmtScheme>`;

export function themeXml(): string {
  return (
    XML_HEADER +
    `<a:theme xmlns:a="${NS.drawingMain}" name="Aperture">` +
    `<a:themeElements>${colorScheme()}${FONT_SCHEME}${FORMAT_SCHEME}</a:themeElements>` +
    `<a:objectDefaults/><a:extraClrSchemeLst/>` +
    `</a:theme>`
  );
}
