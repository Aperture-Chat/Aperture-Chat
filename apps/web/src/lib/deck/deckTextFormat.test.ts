import { expect, test } from "vitest";
import {
  applyDeckTextSize,
  deckRangeFromOffsets,
  deckSizeFromStyle,
  deckTextOffsets,
  deckTextSizeOf,
  resetDeckTextColor,
  stepDeckTextSize,
  styleDeckTextPieces,
} from "./deckTextFormat";

/** A list box the way the stage renders one: per-level sizes (1px per slide
 * point) and colors as custom properties, bullets as nested lists. */
function listBox(html: string) {
  const block = document.createElement("div");
  block.style.setProperty("--l0-size", "18px");
  block.style.setProperty("--l1-size", "16px");
  block.style.setProperty("--l0-color", "#404040");
  block.style.setProperty("--l1-color", "#50748a");
  block.innerHTML = html;
  document.body.appendChild(block);
  return block;
}

function select(block: HTMLElement, text: string) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = (node as Text).data.indexOf(text);
    if (at >= 0) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      return range;
    }
  }
  throw new Error(`${text} not found`);
}

test("size steps follow PowerPoint's list and stop at the model's limits", () => {
  expect(stepDeckTextSize(18, 1)).toBe(20);
  expect(stepDeckTextSize(18, -1)).toBe(16);
  expect(stepDeckTextSize(19, 1)).toBe(20);
  expect(stepDeckTextSize(19, -1)).toBe(18);
  expect(stepDeckTextSize(96, 1)).toBe(96);
  expect(stepDeckTextSize(8, -1)).toBe(8);
});

test("offsets keep the end of one bullet apart from the start of the next", () => {
  const block = listBox("<ul><li>Alpha</li><li>Beta</li></ul>");
  const end = document.createRange();
  end.setStart(block.querySelectorAll("li")[0].firstChild!, 5);
  const start = document.createRange();
  start.setStart(block.querySelectorAll("li")[1].firstChild!, 0);
  const a = deckTextOffsets(block, end)!;
  const b = deckTextOffsets(block, start)!;
  expect(b.start).toBe(a.start + 1);
  // Re-rendered, each caret lands back on its own bullet.
  block.innerHTML = "<ul><li><b>Alpha</b></li><li>Beta</li></ul>";
  expect(deckRangeFromOffsets(block, b)!.startContainer.textContent).toBe("Beta");
  expect(deckRangeFromOffsets(block, a)!.startContainer.textContent).toBe("Alpha");
  block.remove();
});

test("a caret typed into loose lines lands in the same place once they become bullets", () => {
  const block = listBox("<div>R</div>");
  const caret = document.createRange();
  caret.setStart(block.querySelector("div")!.firstChild!, 1);
  const offsets = deckTextOffsets(block, caret)!;
  block.innerHTML = "<ul><li>R</li></ul>";
  const restored = deckRangeFromOffsets(block, offsets)!;
  expect(restored.startOffset).toBe(1);
  block.remove();
});

test("a selection over formatted text comes back over the same words", () => {
  const block = listBox("<ul><li>Quarterly results review</li></ul>");
  const offsets = deckTextOffsets(block, select(block, "review"))!;
  block.innerHTML = "<ul><li>Quarterly results <b><span>review</span></b></li></ul>";
  expect(deckRangeFromOffsets(block, offsets)!.toString()).toBe("review");
  block.remove();
});

test("sizing a selection across bullets sizes each piece without restructuring the list", () => {
  const block = listBox("<ul><li>One two</li><ul><li>Three</li></ul></ul>");
  const range = document.createRange();
  range.setStart(select(block, "two").startContainer, 4);
  range.setEnd(select(block, "Three").endContainer, 5);
  expect(applyDeckTextSize(block, range, { size: 24 })).toBe(2);
  expect(block.querySelectorAll("li")).toHaveLength(2);
  expect(block.innerHTML).toBe('<ul><li>One <span style="font-size: 24px;">two</span></li><ul><li><span style="font-size: 24px;">Three</span></li></ul></ul>');
});

test("a step moves each piece from its own size; reset returns it to its level's layout size", () => {
  const block = listBox('<ul><li><span style="font-size: 28px">Big</span> small</li><ul><li>Sub</li></ul></ul>');
  const whole = document.createRange();
  whole.selectNodeContents(block);
  expect(deckTextSizeOf(block, null)).toBeNull();
  applyDeckTextSize(block, whole, { step: 1 });
  expect(block.innerHTML).toContain('<span style="font-size: 32px;">Big</span>');
  expect(block.innerHTML).toContain('<span style="font-size: 20px;"> small</span>');
  expect(block.innerHTML).toContain('<span style="font-size: 18px;">Sub</span>');
  const sub = select(block, "Sub");
  applyDeckTextSize(block, sub, { reset: true });
  expect(deckTextSizeOf(block, select(block, "Sub"))).toBe(16);
});

test("color reset uses each level's theme color", () => {
  const block = listBox("<ul><li>Top</li><ul><li>Nested</li></ul></ul>");
  const whole = document.createRange();
  whole.selectNodeContents(block);
  styleDeckTextPieces(block, whole, () => ({ color: "#eb8b30" }));
  const again = document.createRange();
  again.selectNodeContents(block);
  resetDeckTextColor(block, again);
  const spans = Array.from(block.querySelectorAll<HTMLElement>("span")).map((span) => span.style.color);
  expect(spans).toContain("rgb(64, 64, 64)");
  expect(spans).toContain("rgb(80, 116, 138)");
});

test("a selection that only touches a neighbour's edge reads one size", () => {
  const block = listBox('<ul><li>Plain <span style="font-size: 32px">bold</span></li></ul>');
  const range = document.createRange();
  const plain = block.querySelector("li")!.firstChild as Text;
  range.setStart(plain, plain.length);
  range.setEnd(block.querySelector("span")!.firstChild!, 4);
  expect(deckTextSizeOf(block, range)).toBe(32);
});

test("pasted CSS points read as the slide points they show at", () => {
  expect(deckSizeFromStyle("24px")).toBe(24);
  expect(deckSizeFromStyle("18pt")).toBe(24);
  expect(deckSizeFromStyle("larger")).toBeNull();
});
