/**
 * Table editing for the Drafts document canvas: insert and delete rows and
 * columns around the cell holding the caret, the way Word's Layout tab does.
 * Tables here are simple grids (no merged cells are produced by the editor),
 * so a column is "the cell at the same index in every row".
 */

function emptyCell(tag: "td" | "th") {
  const cell = document.createElement(tag);
  cell.appendChild(document.createElement("br"));
  return cell;
}

function rowsOf(table: HTMLTableElement) {
  return Array.from(table.querySelectorAll<HTMLTableRowElement>("tr")).filter(
    (row) => row.closest("table") === table,
  );
}

function isHeaderRow(row: HTMLTableRowElement) {
  return row.parentElement?.tagName === "THEAD" || Array.from(row.cells).every((cell) => cell.tagName === "TH");
}

export type TableCellContext = {
  table: HTMLTableElement;
  row: HTMLTableRowElement;
  cell: HTMLTableCellElement;
  rowIndex: number;
  columnIndex: number;
};

/** The table cell holding `node`, with its row and column position. */
export function tableCellContext(node: Node | null, root: HTMLElement): TableCellContext | null {
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  const cell = element?.closest<HTMLTableCellElement>("td,th") ?? null;
  const table = cell?.closest<HTMLTableElement>("table") ?? null;
  const row = cell?.parentElement instanceof HTMLTableRowElement ? cell.parentElement : null;
  if (!cell || !table || !row || !root.contains(table)) return null;
  return { table, row, cell, rowIndex: rowsOf(table).indexOf(row), columnIndex: cell.cellIndex };
}

/** Adds a blank row above or below the caret's row; returns its first cell.
 * A row added below the header row starts the body, not a second header. */
export function insertTableRow({ table, row }: TableCellContext, where: "above" | "below") {
  const header = isHeaderRow(row);
  const next = document.createElement("tr");
  const tag = header && where === "above" ? "th" : "td";
  Array.from(row.cells).forEach(() => next.appendChild(emptyCell(tag)));
  if (header && where === "below" && row.parentElement?.tagName === "THEAD") {
    let body = table.tBodies[0];
    if (!body) {
      body = document.createElement("tbody");
      table.appendChild(body);
    }
    body.insertBefore(next, body.firstChild);
  } else if (where === "above") {
    row.before(next);
  } else {
    row.after(next);
  }
  return next.cells[0] ?? null;
}

/** Adds a blank column left or right of the caret's column in every row. */
export function insertTableColumn({ table, columnIndex }: TableCellContext, where: "left" | "right") {
  let focus: HTMLTableCellElement | null = null;
  rowsOf(table).forEach((row) => {
    const reference = row.cells[Math.min(columnIndex, row.cells.length - 1)];
    const cell = emptyCell(isHeaderRow(row) ? "th" : "td");
    if (!reference) row.appendChild(cell);
    else if (where === "left") reference.before(cell);
    else reference.after(cell);
    if (row === rowsOf(table)[0]) focus = cell;
  });
  return focus as HTMLTableCellElement | null;
}

/** Removes the caret's row; removes the whole table when it was the last
 * row. Returns a cell to move the caret to, or null when the table is gone. */
export function deleteTableRow(context: TableCellContext) {
  const rows = rowsOf(context.table);
  if (rows.length <= 1) {
    deleteTable(context.table);
    return null;
  }
  const neighbor = rows[context.rowIndex + 1] ?? rows[context.rowIndex - 1];
  const section = context.row.parentElement;
  context.row.remove();
  if (section && section !== context.table && !section.querySelector("tr")) section.remove();
  return neighbor?.cells[Math.min(context.columnIndex, neighbor.cells.length - 1)] ?? null;
}

/** Removes the caret's column from every row; removes the table when it was
 * the last column. */
export function deleteTableColumn(context: TableCellContext) {
  const rows = rowsOf(context.table);
  const width = Math.max(...rows.map((row) => row.cells.length));
  if (width <= 1) {
    deleteTable(context.table);
    return null;
  }
  rows.forEach((row) => row.cells[Math.min(context.columnIndex, row.cells.length - 1)]?.remove());
  const row = context.row.isConnected ? context.row : rows[0];
  return row.cells[Math.min(context.columnIndex, row.cells.length - 1)] ?? null;
}

/** Replaces the table with an empty paragraph so the caret has somewhere to go. */
export function deleteTable(table: HTMLTableElement) {
  const paragraph = document.createElement("p");
  paragraph.appendChild(document.createElement("br"));
  table.replaceWith(paragraph);
  return paragraph;
}

/** Turns the first row into a header row, or back into an ordinary row. */
export function toggleTableHeaderRow(table: HTMLTableElement) {
  const rows = rowsOf(table);
  const first = rows[0];
  if (!first) return false;
  const makeHeader = !isHeaderRow(first);
  Array.from(first.cells).forEach((cell) => {
    const replacement = document.createElement(makeHeader ? "th" : "td");
    while (cell.firstChild) replacement.appendChild(cell.firstChild);
    cell.replaceWith(replacement);
  });
  if (makeHeader && first.parentElement?.tagName !== "THEAD") {
    const head = table.tHead ?? table.createTHead();
    head.appendChild(first);
  } else if (!makeHeader && first.parentElement?.tagName === "THEAD") {
    let body = table.tBodies[0];
    if (!body) {
      body = document.createElement("tbody");
      table.appendChild(body);
    }
    body.insertBefore(first, body.firstChild);
    if (!table.tHead?.querySelector("tr")) table.tHead?.remove();
  }
  return makeHeader;
}
