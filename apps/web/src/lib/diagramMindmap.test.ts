import { expect, test } from "vitest";
import { isMindmapSource, mindmapNodeText, parseMindmap, renderMindmapSvg } from "./diagramMindmap";

test("node text keeps words before parentheses; bare-id shapes are unwrapped", () => {
  expect(mindmapNodeText("root((Ottoman Society))")).toBe("Ottoman Society");
  expect(mindmapNodeText("a[Idea]")).toBe("Idea");
  expect(mindmapNodeText("Religious Communities (Millets)")).toBe("Religious Communities (Millets)");
  expect(mindmapNodeText("Guilds (Esnaf)")).toBe("Guilds (Esnaf)");
  expect(mindmapNodeText('b["`**Bold** idea`"]')).toBe("Bold idea");
});

test("indentation builds the tree", () => {
  const root = parseMindmap("mindmap\n  root((Topic))\n    One\n      One A\n    Two\n  ::icon(fa fa-book)")!;
  expect(root.text).toBe("Topic");
  expect(root.children.map((child) => child.text)).toEqual(["One", "Two"]);
  expect(root.children[0]!.children[0]!.text).toBe("One A");
});

test("renders every idea as SVG text in the shared palette", () => {
  const source = "mindmap\n  root((Plan))\n    Research\n      Interviews\n    Build";
  expect(isMindmapSource(source)).toBe(true);
  const svg = renderMindmapSvg(source, false, "sans-serif")!;
  for (const text of ["Plan", "Research", "Interviews", "Build"]) expect(svg).toContain(text);
  expect(svg).toContain('fill="#12384a"'); // root in brand ink
  expect(svg).not.toContain("foreignObject");
});
