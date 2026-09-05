import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  DRAFT_PRINT_BODY_CLASS,
  DRAFT_PRINT_ROOT_ID,
  printSavedDraftVersion,
  removeDraftPrintSurface,
} from "./draftPrint";

const SAVED_VERSION_HTML = [
  '<section class="document-page" data-page-number="1">',
  '<span class="document-page-label" contenteditable="false">Page 1</span>',
  "<h1>Client Update Draft</h1>",
  "<p>The discovery deadline remains July 12, 2026.</p>",
  "<ul><li>Confirm the approval owner before sending.</li></ul>",
  '<table class="document-data-table"><thead><tr><th>Item</th></tr></thead>' +
    "<tbody><tr><td>Supplemental privilege log</td></tr></tbody></table>",
  "</section>",
  '<section class="document-page" data-page-number="2">',
  '<span class="document-page-label" contenteditable="false">Page 2</span>',
  "<p>Second page content for the saved version.</p>",
  "</section>",
].join("");

let printMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  printMock = vi.fn();
  Object.defineProperty(window, "print", { configurable: true, value: printMock });
});

afterEach(() => {
  removeDraftPrintSurface();
});

function printRoot() {
  return document.getElementById(DRAFT_PRINT_ROOT_ID);
}

test("builds the print surface from the exact saved version and cleans up after afterprint", async () => {
  const outcome = await printSavedDraftVersion({
    title: "Client Update Draft",
    contentHtml: SAVED_VERSION_HTML,
  });

  expect(outcome).toEqual({ ok: true });
  expect(printMock).toHaveBeenCalledTimes(1);

  const root = printRoot();
  expect(root).not.toBeNull();
  expect(document.body.classList.contains(DRAFT_PRINT_BODY_CLASS)).toBe(true);
  // Both saved pages, with structure, are present in the print surface.
  expect(root?.querySelectorAll(".document-page")).toHaveLength(2);
  expect(root?.textContent).toContain("The discovery deadline remains July 12, 2026.");
  expect(root?.textContent).toContain("Second page content for the saved version.");
  expect(root?.querySelector("table")?.textContent).toContain("Supplemental privilege log");
  expect(root?.querySelector("li")?.textContent).toContain("Confirm the approval owner");
  // The on-screen "Page N" pills are app chrome and never print.
  expect(root?.querySelector(".document-page-label")).toBeNull();
  // The document already opens with the title, so it is not duplicated.
  expect(root?.querySelectorAll("h1")).toHaveLength(1);

  window.dispatchEvent(new Event("afterprint"));
  expect(printRoot()).toBeNull();
  expect(document.body.classList.contains(DRAFT_PRINT_BODY_CLASS)).toBe(false);
});

test("adds a title heading when the saved version does not open with it", async () => {
  const outcome = await printSavedDraftVersion({
    title: "Untitled Draft",
    contentHtml: "<p>Body copy without a heading.</p>",
  });
  expect(outcome).toEqual({ ok: true });
  const heading = printRoot()?.querySelector(".draft-print-doc-title");
  expect(heading?.textContent).toBe("Untitled Draft");
});

test("repeated print actions never leave duplicate print roots", async () => {
  await printSavedDraftVersion({ title: "Draft", contentHtml: "<p>First print pass.</p>" });
  await printSavedDraftVersion({ title: "Draft", contentHtml: "<p>Second print pass.</p>" });

  expect(document.querySelectorAll(`#${DRAFT_PRINT_ROOT_ID}`)).toHaveLength(1);
  expect(printRoot()?.textContent).toContain("Second print pass.");
  expect(printMock).toHaveBeenCalledTimes(2);

  window.dispatchEvent(new Event("afterprint"));
  expect(document.querySelectorAll(`#${DRAFT_PRINT_ROOT_ID}`)).toHaveLength(0);
  expect(document.body.classList.contains(DRAFT_PRINT_BODY_CLASS)).toBe(false);
});

test("sanitizes stored HTML before it reaches the print surface", async () => {
  await printSavedDraftVersion({
    title: "Draft",
    contentHtml:
      '<p onclick="steal()" style="color:red; position: fixed">Safe text</p><script>window.hacked = true;</script>',
  });
  const root = printRoot();
  expect(root?.textContent).toContain("Safe text");
  expect(root?.innerHTML).not.toContain("<script");
  expect(root?.innerHTML).not.toContain("onclick");
  // Toolbar text color survives to print; non-formatting CSS does not.
  expect(root?.innerHTML).toContain('style="color: red"');
  expect(root?.innerHTML).not.toContain("position");
});

test("cleans up through the bounded timeout when afterprint never fires", async () => {
  const outcome = await printSavedDraftVersion({
    title: "Draft",
    contentHtml: "<p>Timeout cleanup path.</p>",
    cleanupTimeoutMs: 10,
  });
  expect(outcome).toEqual({ ok: true });
  expect(printRoot()).not.toBeNull();

  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(printRoot()).toBeNull();
  expect(document.body.classList.contains(DRAFT_PRINT_BODY_CLASS)).toBe(false);
});

test("a failed embedded image aborts the print with an explicit error and no leftover state", async () => {
  const outcomePromise = printSavedDraftVersion({
    title: "Draft",
    contentHtml: '<p>Text body.</p><img src="https://example.com/broken.png" alt="Broken">',
    imageWaitMs: 500,
  });

  // The surface is built synchronously; fail its image like a real 404 would.
  const image = printRoot()?.querySelector("img");
  expect(image).toBeTruthy();
  image?.dispatchEvent(new Event("error"));

  const outcome = await outcomePromise;
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.error).toMatch(/embedded image failed to load/i);
    expect(outcome.error).toMatch(/draft is unchanged/i);
  }
  expect(printMock).not.toHaveBeenCalled();
  expect(printRoot()).toBeNull();
  expect(document.body.classList.contains(DRAFT_PRINT_BODY_CLASS)).toBe(false);
});

test("a throwing print call cleans up and reports an explicit error", async () => {
  printMock.mockImplementation(() => {
    throw new Error("print blocked");
  });
  const outcome = await printSavedDraftVersion({
    title: "Draft",
    contentHtml: "<p>Throwing print dialog.</p>",
  });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error).toMatch(/print dialog/i);
  expect(printRoot()).toBeNull();
  expect(document.body.classList.contains(DRAFT_PRINT_BODY_CLASS)).toBe(false);
});

test("refuses to print an empty saved version instead of opening a blank dialog", async () => {
  const outcome = await printSavedDraftVersion({ title: "Draft", contentHtml: "" });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error).toMatch(/no printable content/i);
  expect(printMock).not.toHaveBeenCalled();
  expect(printRoot()).toBeNull();
});

test("restores focus to the previously focused element after afterprint", async () => {
  const button = document.createElement("button");
  button.textContent = "Export";
  document.body.appendChild(button);
  button.focus();
  expect(document.activeElement).toBe(button);

  await printSavedDraftVersion({ title: "Draft", contentHtml: "<p>Focus restore.</p>" });
  window.dispatchEvent(new Event("afterprint"));

  expect(document.activeElement).toBe(button);
  button.remove();
});

test('MLA print never prepends the file title ahead of the student heading', async () => {
  const { formatMlaDocument } = await import('./draftMla');
  await printSavedDraftVersion({ title: 'Internal filename', contentHtml: formatMlaDocument('<p>Alex Example</p><p>Taylor Example</p><p>History 101</p><p>5 September 2026</p><h2>Crossing the River</h2><p>Essay body.</p>', 'MLA') });
  const root = document.getElementById(DRAFT_PRINT_ROOT_ID)!;
  expect(root.textContent?.startsWith('Alex Example')).toBe(true);
  expect(root.textContent).not.toContain('Internal filename');
});
