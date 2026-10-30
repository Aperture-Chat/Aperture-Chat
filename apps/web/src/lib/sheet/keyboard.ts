/** The spreadsheet grid's keyboard map, as a pure function from a key press
 * to a command, so Excel's shortcuts are testable without a DOM. The editor
 * runs the command; typing a printable key starts editing the cell. */

export type KeyPress = { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean };

export type GridKeyCommand =
  | { kind: "arrow"; dRow: number; dCol: number; extend: boolean; jump: boolean }
  | { kind: "enter"; up: boolean }
  | { kind: "tab"; left: boolean }
  | { kind: "home"; toStart: boolean; extend: boolean }
  | { kind: "end"; extend: boolean }
  | { kind: "page"; down: boolean; extend: boolean }
  | { kind: "escape" }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "copy" }
  | { kind: "cut" }
  | { kind: "pasteValues" }
  | { kind: "selectAll" }
  | { kind: "style"; key: "bold" | "italic" | "underline" | "strike" }
  | { kind: "fill"; axis: "down" | "right" }
  | { kind: "find"; replace: boolean }
  | { kind: "ai" }
  | { kind: "shortcuts" }
  | { kind: "today" }
  | { kind: "format"; format: string }
  | { kind: "filter" }
  | { kind: "selectColumn" }
  | { kind: "selectRow" }
  | { kind: "autoSum" }
  | { kind: "clear" }
  | { kind: "backspace" }
  | { kind: "edit" }
  | { kind: "type"; text: string };

const ARROWS: Record<string, [number, number]> = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] };

const MOD_KEYS: Record<string, (shift: boolean) => GridKeyCommand | null> = {
  z: (shift) => ({ kind: shift ? "redo" : "undo" }),
  y: () => ({ kind: "redo" }),
  c: () => ({ kind: "copy" }),
  x: () => ({ kind: "cut" }),
  v: (shift) => (shift ? { kind: "pasteValues" } : null),
  a: () => ({ kind: "selectAll" }),
  b: () => ({ kind: "style", key: "bold" }),
  i: () => ({ kind: "style", key: "italic" }),
  u: () => ({ kind: "style", key: "underline" }),
  d: () => ({ kind: "fill", axis: "down" }),
  r: () => ({ kind: "fill", axis: "right" }),
  f: () => ({ kind: "find", replace: false }),
  h: () => ({ kind: "find", replace: true }),
  j: () => ({ kind: "ai" }),
  k: () => ({ kind: "ai" }),
  ";": () => ({ kind: "today" }),
  l: (shift) => (shift ? { kind: "filter" } : null),
  " ": () => ({ kind: "selectColumn" }),
  "/": () => ({ kind: "shortcuts" }),
};

function modifierCommand(press: KeyPress): GridKeyCommand | null {
  const lower = press.key.toLowerCase();
  const shift = Boolean(press.shiftKey);
  // ⌘⇧$ and ⌘⇧% arrive as "$"/"%" or, on some layouts, as shifted digits.
  if (press.key === "$" || (shift && lower === "4")) return { kind: "format", format: "$#,##0.00" };
  if (press.key === "%" || (shift && lower === "5")) return { kind: "format", format: "0%" };
  if (lower === "5") return { kind: "style", key: "strike" };
  return MOD_KEYS[lower]?.(shift) ?? null;
}

const PLAIN_KEYS: Record<string, (press: KeyPress) => GridKeyCommand | null> = {
  Enter: (press) => (press.metaKey || press.ctrlKey ? null : { kind: "enter", up: Boolean(press.shiftKey) }),
  Tab: (press) => ({ kind: "tab", left: Boolean(press.shiftKey) }),
  Home: (press) => ({ kind: "home", toStart: Boolean(press.metaKey || press.ctrlKey), extend: Boolean(press.shiftKey) }),
  End: (press) => (press.metaKey || press.ctrlKey ? { kind: "end", extend: Boolean(press.shiftKey) } : null),
  PageDown: (press) => ({ kind: "page", down: true, extend: Boolean(press.shiftKey) }),
  PageUp: (press) => ({ kind: "page", down: false, extend: Boolean(press.shiftKey) }),
  Escape: () => ({ kind: "escape" }),
  Delete: () => ({ kind: "clear" }),
  Backspace: () => ({ kind: "backspace" }),
  F2: () => ({ kind: "edit" }),
};

export function gridKeyCommand(press: KeyPress): GridKeyCommand | null {
  const mod = Boolean(press.metaKey || press.ctrlKey);
  const arrow = ARROWS[press.key];
  if (arrow) return { kind: "arrow", dRow: arrow[0], dCol: arrow[1], extend: Boolean(press.shiftKey), jump: mod };
  const plain = PLAIN_KEYS[press.key];
  if (plain) return plain(press);
  if (mod) return modifierCommand(press);
  if (press.altKey && (press.key === "=" || press.key === "≠")) return { kind: "autoSum" };
  if (press.key === " " && press.shiftKey) return { kind: "selectRow" };
  if (press.key.length === 1 && !press.altKey) return { kind: "type", text: press.key };
  return null;
}
