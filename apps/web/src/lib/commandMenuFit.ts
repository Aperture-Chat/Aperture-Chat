const FULL_HEIGHT = 340;
/** A section heading and two rows. */
const SHORTEST_USABLE = 148;
/** The menu's own 8px offset from the composer, and 8px clear of the header. */
const GAP = 16;

export type CommandMenuFit = { folded: false; room: number } | { folded: true };

/** Where the symbol menu goes. It opens upward from the composer and takes only
 * the room there is, because past the header no scrolling reaches the choices at
 * its top. With too little room to be useful, it folds down into the composer. */
export function commandMenuFit(composerTop: number, headerBottom: number): CommandMenuFit {
  const room = composerTop - headerBottom - GAP;
  return room < SHORTEST_USABLE ? { folded: true } : { folded: false, room: Math.min(FULL_HEIGHT, room) };
}

/** The scroll that keeps the typed line in view when the expanded editor gives up
 * room to the folded menu. A textarea reports no caret position, so the caret is
 * placed by its share of the text: exact at the end of a draft, close elsewhere. */
export function scrollTopShowingCaret(
  scrollTop: number,
  viewHeight: number,
  fullHeight: number,
  caretShare: number,
): number {
  const caretY = fullHeight * caretShare;
  if (caretY > scrollTop + viewHeight) return caretY - viewHeight;
  if (caretY < scrollTop) return caretY;
  return scrollTop;
}
