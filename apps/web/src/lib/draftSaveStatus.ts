/** Honest server persistence state for the current document. "saved" is set
 * only after a 2xx server response; anything else must never claim "Saved". */
export type DraftServerSaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; revision: number }
  | { kind: "local-only"; message: string }
  // The browser refused to store this draft (quota); nothing was written.
  | { kind: "not-stored"; message: string }
  | { kind: "conflict"; serverId: string; message: string };

export type DraftSaveTone = "editing" | "saving" | "saved" | "local-only" | "not-stored" | "conflict";

export type DraftSaveAction = { kind: "retry" } | { kind: "reload"; serverId: string };

/** What the one save status beside Insert shows: a word, its full reason,
 * and the recovery action when the account copy is behind. */
export type DraftSaveStatus = {
  tone: DraftSaveTone;
  label: string;
  detail: string;
  action: DraftSaveAction | null;
};

/** Autosave of a shared draft's live copy (lib/draftLiveSession.ts). */
export type DraftLiveSaveState =
  | { kind: "synced"; seq: number }
  | { kind: "saving" }
  | { kind: "offline"; message: string; retryInMs: number };

function liveSaveStatus(live: DraftLiveSaveState): DraftSaveStatus {
  if (live.kind === "saving") {
    return { tone: "saving", label: "Saving…", detail: "Saving your changes for everyone sharing this draft.", action: null };
  }
  if (live.kind === "offline") {
    const seconds = Math.max(1, Math.round(live.retryInMs / 1000));
    return {
      tone: "local-only",
      label: "Not saved yet",
      detail: `${live.message} Your changes are kept in this window and save again in ${seconds} seconds.`,
      action: { kind: "retry" },
    };
  }
  return {
    tone: "saved",
    label: "Saved",
    detail: "Every change is saved to your account for everyone sharing this draft. Save a version to mark a point you can go back to.",
    action: null,
  };
}

/** An account copy that is behind outranks local edits: its warning and
 * recovery action stay visible while the user keeps typing. A shared draft
 * autosaves, so its live state replaces "Editing". */
export function draftSaveStatus(
  hasUnsavedEdits: boolean,
  server: DraftServerSaveState,
  live: DraftLiveSaveState | null = null,
): DraftSaveStatus {
  if (server.kind === "not-stored") {
    return { tone: "not-stored", label: "Not saved", detail: server.message, action: { kind: "retry" } };
  }
  if (server.kind === "conflict") {
    return {
      tone: "conflict",
      label: "Draft changed elsewhere",
      detail: server.message,
      action: { kind: "reload", serverId: server.serverId },
    };
  }
  if (server.kind === "local-only") {
    return { tone: "local-only", label: "Local only", detail: server.message, action: { kind: "retry" } };
  }
  if (live) return liveSaveStatus(live);
  if (hasUnsavedEdits) {
    return {
      tone: "editing",
      label: "Editing",
      detail: "Editing in progress. Save a version when the draft is ready.",
      action: null,
    };
  }
  if (server.kind === "saving") {
    return { tone: "saving", label: "Saving…", detail: "Saving this version to your account.", action: null };
  }
  return {
    tone: "saved",
    label: "Saved",
    detail: server.kind === "saved" ? `Saved to your account (revision ${server.revision}).` : "Current version is saved.",
    action: null,
  };
}
