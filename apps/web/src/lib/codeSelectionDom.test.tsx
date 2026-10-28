import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { CodeLines } from "../components/CodeLines";
import { codeSelectionFromDom } from "./codeSelectionDom";

const CODE = "def greet(name):\n    return name\nprint(greet('x'))";

function select(startNode: Node, startOffset: number, endNode: Node, endOffset: number) {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function setup(language?: string) {
  const { container } = render(
    <div>
      <p>Before</p>
      <CodeLines language={language} lines={CODE.split("\n")} />
      <p>After</p>
    </div>,
  );
  const root = container.querySelector<HTMLElement>(".md-code-lines")!;
  const texts = [...container.querySelectorAll(".md-code-line-text")];
  return { container, root, texts };
}

test("maps a selection across plain lines to code offsets", () => {
  const { root, texts } = setup();
  const selection = select(texts[1]!.firstChild!, 4, texts[2]!.firstChild!, 5);
  const offsets = codeSelectionFromDom(root, selection, CODE);
  expect(CODE.slice(offsets!.start, offsets!.end)).toBe("return name\nprint");
});

test("maps a selection that starts and ends inside highlighted tokens", async () => {
  const { root } = setup("python");
  const keyword = await screen.findByText("return");
  const selection = select(keyword.firstChild!, 2, keyword.firstChild!, 6);
  const offsets = codeSelectionFromDom(root, selection, CODE);
  expect(CODE.slice(offsets!.start, offsets!.end)).toBe("turn");
});

test("clamps a selection that runs past the block to its edges", () => {
  const { container, root, texts } = setup();
  const paragraphs = container.querySelectorAll("p");
  const selection = select(paragraphs[0]!.firstChild!, 2, texts[0]!.firstChild!, 3);
  expect(codeSelectionFromDom(root, selection, CODE)).toEqual({ start: 0, end: 3 });
  const tail = select(texts[2]!.firstChild!, 0, paragraphs[1]!.firstChild!, 1);
  expect(codeSelectionFromDom(root, tail, CODE)).toEqual({ start: CODE.lastIndexOf("print"), end: CODE.length });
});

test("treats a boundary on a line number as the start of that line", () => {
  const { container, root, texts } = setup();
  const numbers = container.querySelectorAll(".md-code-line-number");
  const selection = select(numbers[1]!.firstChild!, 0, texts[1]!.firstChild!, 10);
  const offsets = codeSelectionFromDom(root, selection, CODE);
  expect(CODE.slice(offsets!.start, offsets!.end)).toBe("    return");
});

test("reads boundaries on a row or between rows", () => {
  const { container, root } = setup();
  const rows = container.querySelectorAll(".md-code-line");
  // Row offsets count its cells: 1 is before the text, 2 after it.
  const lineTwo = codeSelectionFromDom(root, select(rows[1]!, 1, rows[1]!, 2), CODE);
  expect(CODE.slice(lineTwo!.start, lineTwo!.end)).toBe("    return name");
  expect(codeSelectionFromDom(root, select(rows[2]!, 1, rows[2]!, 2), CODE)).toEqual({
    start: CODE.lastIndexOf("print"),
    end: CODE.length,
  });
  expect(codeSelectionFromDom(root, select(root, 0, root, 1), CODE)).toEqual({ start: 0, end: CODE.indexOf("    return") });
  expect(codeSelectionFromDom(root, select(root, 1, root, 3), CODE)).toEqual({ start: CODE.indexOf("    return"), end: CODE.length });
});

test("a selection of line numbers alone selects no code", () => {
  const { container, root } = setup();
  const number = container.querySelectorAll(".md-code-line-number")[1]!.firstChild!;
  expect(codeSelectionFromDom(root, select(number, 0, number, 1), CODE)).toBeNull();
});

test("no selection at all selects no code", () => {
  const { root } = setup();
  window.getSelection()!.removeAllRanges();
  expect(codeSelectionFromDom(root, window.getSelection(), CODE)).toBeNull();
  expect(codeSelectionFromDom(root, null, CODE)).toBeNull();
});

test("ignores collapsed selections and selections outside the block", () => {
  const { container, root, texts } = setup();
  expect(codeSelectionFromDom(root, select(texts[0]!.firstChild!, 2, texts[0]!.firstChild!, 2), CODE)).toBeNull();
  const paragraph = container.querySelector("p")!.firstChild!;
  expect(codeSelectionFromDom(root, select(paragraph, 0, paragraph, 3), CODE)).toBeNull();
});
