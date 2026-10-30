/** Cell notes as legacy comments: xl/commentsN.xml holds the text, and a VML
 * drawing holds the note boxes, which is what makes Excel show the red
 * indicator and the hover popup. */

import { parseCellKey } from "../address";
import type { Sheet } from "../sheetModel";
import { NS, plainText, textElement, XML_HEADER } from "./xml";

export type SheetNote = { ref: string; row: number; col: number; text: string };

export function sheetNotes(sheet: Sheet): SheetNote[] {
  return Object.entries(sheet.cells).flatMap(([ref, cell]) => {
    const point = parseCellKey(ref);
    return point && cell.n ? [{ ref, row: point.row, col: point.col, text: plainText(cell.n) }] : [];
  });
}

export function commentsXml(notes: SheetNote[]): string {
  const list = notes.map((note) => `<comment ref="${note.ref}" authorId="0"><text>${textElement("t", note.text)}</text></comment>`).join("");
  return `${XML_HEADER}<comments xmlns="${NS.main}"><authors><author>Aperture</author></authors><commentList>${list}</commentList></comments>`;
}

function noteShape(note: SheetNote, shapeId: number): string {
  const anchor = [note.col + 1, 15, Math.max(0, note.row - 1), 10, note.col + 3, 15, note.row + 3, 4].join(", ");
  return (
    `<v:shape id="_x0000_s${shapeId}" type="#_x0000_t202" style="position:absolute;margin-left:80pt;margin-top:2pt;width:120pt;height:60pt;z-index:${shapeId};visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto">` +
    `<v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/>` +
    `<v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox>` +
    `<x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>${anchor}</x:Anchor>` +
    `<x:AutoFill>False</x:AutoFill><x:Row>${note.row}</x:Row><x:Column>${note.col}</x:Column></x:ClientData>` +
    `</v:shape>`
  );
}

const SHAPES_PER_BLOCK = 1024;

/** How many 1024-id shape blocks a sheet's notes need. */
export function vmlBlockCount(notes: SheetNote[]): number {
  return Math.ceil((notes.length + 1) / SHAPES_PER_BLOCK);
}

/** One VML part per sheet. Shape ids come from the sheet's own id blocks
 * (starting at `firstBlock`), so they stay unique across the workbook. */
export function notesVml(notes: SheetNote[], firstBlock: number): string {
  const blocks = Array.from({ length: vmlBlockCount(notes) }, (_, index) => firstBlock + index).join(",");
  return (
    `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">` +
    `<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="${blocks}"/></o:shapelayout>` +
    `<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe">` +
    `<v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>` +
    notes.map((note, index) => noteShape(note, firstBlock * SHAPES_PER_BLOCK + index + 1)).join("") +
    `</xml>`
  );
}
