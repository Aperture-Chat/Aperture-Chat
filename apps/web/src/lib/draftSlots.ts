/**
 * Which Drafts workspaces the app keeps mounted.
 *
 * A workspace owns the request it sent to the model: unmounting it throws the
 * reply away. So a workspace the person leaves while the assistant is still
 * working is held, out of sight, until that work is done and they are back in
 * Drafts. One left idle is unmounted, as before.
 */

/** One mounted Drafts workspace. */
export type DraftSlot = {
  /** Identifies the workspace instance. */
  key: string;
  /** The saved draft it was opened on, if any. */
  draftId: string | null;
  /** The request for a fresh workspace it belongs to (a transfer from chat
   * or a new draft starts the next one). */
  session: number;
  /** It was left while the assistant was working, so it is kept until the
   * person opens a different draft. */
  held: boolean;
};

function newestHeld(kept: readonly DraftSlot[], session: number): DraftSlot | null {
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    const slot = kept[index];
    if (slot.held && slot.session === session) return slot;
  }
  return null;
}

/** Whether opening Drafts goes back to a held workspace instead of a fresh one. */
export function returnsToHeldDraft(kept: readonly DraftSlot[], session: number, draftId: string | null): boolean {
  return draftId === null && newestHeld(kept, session) !== null;
}

/**
 * The workspace a Drafts route shows. Opening Drafts without naming a draft
 * returns to the one the assistant was writing in; a named draft, or a newer
 * session, gets its own workspace.
 */
export function slotOnScreen(kept: readonly DraftSlot[], session: number, draftId: string | null): DraftSlot {
  if (returnsToHeldDraft(kept, session, draftId)) return newestHeld(kept, session)!;
  const key = `${session}:${draftId === null ? "" : draftId}`;
  const open = kept.find((slot) => slot.key === key);
  return open === undefined ? { key, draftId, session, held: false } : open;
}

/**
 * The workspaces to keep mounted, in a stable order: the one on screen, every
 * one still working, and, while the person is outside Drafts, the ones held
 * for their return.
 */
export function keptDraftSlots(
  kept: readonly DraftSlot[],
  onScreen: DraftSlot | null,
  working: ReadonlySet<string>,
): DraftSlot[] {
  const next = kept.flatMap((slot) => {
    if (slot.key === onScreen?.key) return [slot];
    if (working.has(slot.key)) return [slot.held ? slot : { ...slot, held: true }];
    return slot.held && !onScreen ? [slot] : [];
  });
  return onScreen && !next.some((slot) => slot.key === onScreen.key) ? [...next, onScreen] : next;
}

/** Whether two lists keep the same workspaces in the same state. */
export function sameDraftSlots(a: readonly DraftSlot[], b: readonly DraftSlot[]): boolean {
  return a.length === b.length && a.every((slot, index) => slot.key === b[index].key && slot.held === b[index].held);
}
