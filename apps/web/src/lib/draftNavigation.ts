/** Gives Drafts a chance to preserve unsaved edits before external navigation. */
export type DraftNavigationGuard = (label: string, proceed: () => void) => void;
