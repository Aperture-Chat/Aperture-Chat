/** A hidden sheet for dropdown lists Excel cannot hold inline.
 *
 * An inline list ("East,West") is limited to 255 characters and cannot
 * contain commas. Longer lists are written one per column on a hidden sheet,
 * and the validation points at that column, which is how Excel users build
 * long dropdowns themselves. */

import { cellKey, columnLabel } from "../address";
import { uniqueSheetName, type Sheet } from "../sheetModel";
import { absoluteRef } from "./formulaText";
import type { SharedStrings } from "./sharedStrings";
import { NS, XML_HEADER } from "./xml";

export class DropdownLists {
  readonly sheetName: string;
  private readonly columns: string[][] = [];
  private readonly byKey = new Map<string, number>();

  constructor(sheets: Sheet[]) {
    this.sheetName = uniqueSheetName("Dropdown lists", sheets);
  }

  get used(): boolean {
    return this.columns.length > 0;
  }

  /** An absolute reference to a column holding the items. */
  reference(items: string[]): string {
    const key = JSON.stringify(items);
    let col = this.byKey.get(key);
    if (col === undefined) {
      col = this.columns.push(items) - 1;
      this.byKey.set(key, col);
    }
    const letter = columnLabel(col);
    return absoluteRef(this.sheetName, `${letter}1:${letter}${items.length}`);
  }

  sheetXml(strings: SharedStrings): string {
    const height = Math.max(...this.columns.map((items) => items.length));
    const rows: string[] = [];
    for (let row = 0; row < height; row += 1) {
      const cells = this.columns
        .map((items, col) => (row < items.length ? `<c r="${cellKey(row, col)}" t="s"><v>${strings.index(items[row])}</v></c>` : ""))
        .join("");
      rows.push(`<row r="${row + 1}">${cells}</row>`);
    }
    const last = cellKey(height - 1, this.columns.length - 1);
    return (
      XML_HEADER +
      `<worksheet xmlns="${NS.main}" xmlns:r="${NS.rel}">` +
      `<dimension ref="A1:${last}"/>` +
      `<sheetViews><sheetView workbookViewId="0"/></sheetViews>` +
      `<sheetFormatPr defaultRowHeight="15"/>` +
      `<sheetData>${rows.join("")}</sheetData>` +
      `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>` +
      `</worksheet>`
    );
  }
}
