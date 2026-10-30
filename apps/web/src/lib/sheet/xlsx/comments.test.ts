import { describe, expect, it } from "vitest";
import { commentsXml, notesVml, sheetNotes, vmlBlockCount } from "./comments";

const note = (ref: string, row: number, col: number) => ({ ref, row, col, text: `Note ${ref}` });

describe("note drawings", () => {
  it("anchors each note box beside its cell and binds it to the cell", () => {
    const vml = notesVml([note("A2", 1, 0), note("B5", 4, 1)], 1);
    expect(vml).toContain("<x:Anchor>1, 15, 0, 10, 3, 15, 4, 4</x:Anchor>");
    expect(vml).toContain("<x:Anchor>2, 15, 3, 10, 4, 15, 7, 4</x:Anchor>");
    expect(vml).toContain("<x:Row>4</x:Row><x:Column>1</x:Column>");
    expect(vml).toContain("z-index:1025");
  });

  it("numbers shapes from the sheet's own id blocks", () => {
    const vml = notesVml([note("A1", 0, 0), note("A2", 1, 0)], 3);
    expect(vml).toContain(`<o:idmap v:ext="edit" data="3"/>`);
    expect(Array.from(vml.matchAll(/id="_x0000_s(\d+)"/g), (match) => match[1])).toEqual(["3073", "3074"]);
  });

  it("claims another 1024-id block once a sheet holds 1024 notes", () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => note(`A${index + 1}`, index, 0));
    expect(vmlBlockCount(many(1023))).toBe(1);
    expect(vmlBlockCount(many(1024))).toBe(2);
    expect(notesVml(many(1024), 3)).toContain(`data="3,4"`);
  });

  it("keeps note text exact, including line breaks and markup characters", () => {
    const notes = sheetNotes({ id: "s", name: "S", cells: { B2: { v: 1, n: "Line one\nline <two> & three" }, C3: { v: 2 } } });
    expect(notes).toEqual([{ ref: "B2", row: 1, col: 1, text: "Line one\nline <two> & three" }]);
    const doc = new DOMParser().parseFromString(commentsXml(notes), "application/xml");
    expect(doc.getElementsByTagName("t")[0].textContent).toBe("Line one\nline <two> & three");
    expect(doc.getElementsByTagName("t")[0].getAttribute("xml:space")).toBe("preserve");
  });
});
