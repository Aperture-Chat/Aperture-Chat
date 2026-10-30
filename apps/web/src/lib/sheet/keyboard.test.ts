import { describe, expect, it } from "vitest";
import { gridKeyCommand } from "./keyboard";

describe("grid keyboard map", () => {
  it("maps Excel's navigation keys", () => {
    expect(gridKeyCommand({ key: "ArrowDown" })).toEqual({ kind: "arrow", dRow: 1, dCol: 0, extend: false, jump: false });
    expect(gridKeyCommand({ key: "ArrowLeft", shiftKey: true, metaKey: true })).toEqual({ kind: "arrow", dRow: 0, dCol: -1, extend: true, jump: true });
    expect(gridKeyCommand({ key: "Enter", shiftKey: true })).toEqual({ kind: "enter", up: true });
    expect(gridKeyCommand({ key: "Home", ctrlKey: true })).toEqual({ kind: "home", toStart: true, extend: false });
    expect(gridKeyCommand({ key: "End" })).toBeNull();
    expect(gridKeyCommand({ key: "End", metaKey: true, shiftKey: true })).toEqual({ kind: "end", extend: true });
  });

  it("maps editing and formatting shortcuts", () => {
    expect(gridKeyCommand({ key: "z", metaKey: true })).toEqual({ kind: "undo" });
    expect(gridKeyCommand({ key: "Z", metaKey: true, shiftKey: true })).toEqual({ kind: "redo" });
    expect(gridKeyCommand({ key: "v", metaKey: true })).toBeNull();
    expect(gridKeyCommand({ key: "v", ctrlKey: true, shiftKey: true })).toEqual({ kind: "pasteValues" });
    expect(gridKeyCommand({ key: "5", metaKey: true })).toEqual({ kind: "style", key: "strike" });
    expect(gridKeyCommand({ key: "$", metaKey: true, shiftKey: true })).toEqual({ kind: "format", format: "$#,##0.00" });
    expect(gridKeyCommand({ key: "%", ctrlKey: true, shiftKey: true })).toEqual({ kind: "format", format: "0%" });
    expect(gridKeyCommand({ key: "L", metaKey: true, shiftKey: true })).toEqual({ kind: "filter" });
    expect(gridKeyCommand({ key: "=", altKey: true })).toEqual({ kind: "autoSum" });
    expect(gridKeyCommand({ key: "/", metaKey: true })).toEqual({ kind: "shortcuts" });
  });

  it("starts typing on printable keys and ignores the rest", () => {
    expect(gridKeyCommand({ key: "a" })).toEqual({ kind: "type", text: "a" });
    expect(gridKeyCommand({ key: "=" })).toEqual({ kind: "type", text: "=" });
    expect(gridKeyCommand({ key: " ", shiftKey: true })).toEqual({ kind: "selectRow" });
    expect(gridKeyCommand({ key: "Shift" })).toBeNull();
    expect(gridKeyCommand({ key: "F2" })).toEqual({ kind: "edit" });
    expect(gridKeyCommand({ key: "Backspace" })).toEqual({ kind: "backspace" });
  });
});
