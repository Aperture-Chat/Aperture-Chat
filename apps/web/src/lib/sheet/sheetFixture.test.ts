import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as model from "./sheetModel";

/* The server mirrors parseWorkbook + serializeWorkbook in
 * services/api/app/models/sheet_document.py and must write the same bytes.
 * Both sides read this fixture, so a change on either side fails here first. */
const FIXTURE = resolve(__dirname, "../../../../../services/api/tests/fixtures/sheet-v1");

type FixtureCase = { name: string; input: string; output: string | null };

function readFixture<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURE, file), "utf8")) as T;
}

const cases = readFixture<FixtureCase[]>("cases.json");

describe("shared sheet-v1 fixture", () => {
  it("pins the limits the server enforces", () => {
    expect(readFixture("limits.json")).toEqual({
      schema: model.SHEET_SCHEMA_VERSION,
      sanitizer_version: model.SHEET_SANITIZER_VERSION,
      max_content_bytes: model.MAX_SHEET_CONTENT_BYTES,
      max_sheets: model.MAX_SHEETS,
      max_workbook_cells: model.MAX_WORKBOOK_CELLS,
      max_cell_text_chars: model.MAX_CELL_TEXT_CHARS,
      max_formula_chars: model.MAX_FORMULA_CHARS,
      max_note_chars: model.MAX_NOTE_CHARS,
      max_sheet_name_chars: model.MAX_SHEET_NAME_CHARS,
      max_merges_per_sheet: model.MAX_MERGES_PER_SHEET,
      max_objects_per_sheet: model.MAX_OBJECTS_PER_SHEET,
      max_rules_per_sheet: model.MAX_RULES_PER_SHEET,
      max_defined_names: model.MAX_DEFINED_NAMES,
      max_list_items: model.MAX_LIST_ITEMS,
      max_source_chars: model.MAX_SOURCE_CHARS,
      max_sheet_rows: model.MAX_SHEET_ROWS,
      max_sheet_cols: model.MAX_SHEET_COLS,
      min_col_width: model.MIN_COL_WIDTH,
      max_col_width: model.MAX_COL_WIDTH,
      min_row_height: model.MIN_ROW_HEIGHT,
      max_row_height: model.MAX_ROW_HEIGHT,
      border_styles: model.BORDER_STYLES,
      table_tones: model.TABLE_TONES,
      chart_types: model.CHART_TYPES,
      chart_legends: model.CHART_LEGENDS,
      pivot_aggregates: model.PIVOT_AGGREGATES,
      cell_operators: model.CELL_OPERATORS,
      text_operators: model.TEXT_OPERATORS,
      validation_kinds: model.VALIDATION_KINDS,
    });
  });

  it.each(cases.map((item) => [item.name, item] as const))("%s", (_name, item) => {
    const parsed = model.parseWorkbook(item.input);
    if (item.output === null) {
      expect(parsed.ok).toBe(false);
      return;
    }
    if (!parsed.ok) throw new Error(parsed.error);
    const text = model.serializeWorkbook(parsed.workbook);
    expect(text).toBe(item.output);
    // Stored revisions must parse back to themselves.
    const again = model.parseWorkbook(text);
    expect(again.ok && model.serializeWorkbook(again.workbook)).toBe(text);
  });
});
