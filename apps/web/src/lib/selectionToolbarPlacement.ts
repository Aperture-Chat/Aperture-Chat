export type SelectionRect = { top: number; bottom: number; left: number; right: number };
export type Size = { width: number; height: number };
export type SelectionToolbarPlacement = { top: number; left: number; below: boolean };

const EDGE = 8;
const POINTER_GAP = 10;
/** Room the app header needs above a toolbar placed over the selection. */
const TOP_CLEARANCE = 64;
/** On touch screens the selection's drag handles hang below the text. */
const TOUCH_GAP = 28;

/**
 * Where the floating selection toolbar goes. With a mouse it sits above the
 * highlight, like Word's mini toolbar. On touch screens it sits below: iOS and
 * Android draw their own copy/paste menu above a selection, and the two would
 * cover each other. Either way it flips when the preferred side has no room,
 * and it never leaves the screen horizontally.
 */
export function placeSelectionToolbar(
  anchor: SelectionRect,
  toolbar: Size,
  viewport: Size,
  touch: boolean,
): SelectionToolbarPlacement {
  const center = (anchor.left + anchor.right) / 2;
  const left = Math.max(EDGE, Math.min(center - toolbar.width / 2, viewport.width - toolbar.width - EDGE));
  const gap = touch ? TOUCH_GAP : POINTER_GAP;
  const aboveTop = anchor.top - toolbar.height - gap;
  const belowTop = anchor.bottom + gap;
  const below = touch
    ? belowTop + toolbar.height <= viewport.height - EDGE || aboveTop < TOP_CLEARANCE
    : aboveTop < TOP_CLEARANCE;
  return { top: below ? belowTop : aboveTop, left, below };
}
