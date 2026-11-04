/**
 * Filing one chat under a matter.
 *
 * The person's choice shows at once (`pendingMatterId`) and the server link
 * follows. The matters API can only link a chat the server already stores, so
 * a new chat keeps its choice until its first save, and the store applies it
 * then. Changes to one chat run one after another, so a quick second choice
 * never races the first.
 */

import type { ChatThread } from "./types";
import { ChatRequestError } from "./api/http";

export type ThreadMatterOutcome =
  | { kind: "linked"; matterId: string | null }
  /** The chat is not stored yet; the link waits for its first save. */
  | { kind: "waiting" }
  | { kind: "failed"; message: string };

type ThreadMatterFields = Pick<ChatThread, "matter_id" | "pendingMatterId" | "matterError">;

/** The matter a chat shows: the one just chosen, else the one the server has. */
export function threadMatterId(thread: ThreadMatterFields): string | null {
  return thread.pendingMatterId !== undefined ? thread.pendingMatterId : (thread.matter_id ?? null);
}

/** Records a new choice. It replaces any earlier refusal. */
export function withChosenMatter<T extends ThreadMatterFields>(thread: T, matterId: string | null): T {
  return { ...thread, pendingMatterId: matterId, matterError: undefined };
}

/**
 * Sends a chat's pending choice to the server.
 *
 * `unsaved` says the chat has never been stored. `afterSave` says it was just
 * saved, so a "not found" is a real refusal rather than a save still on its way.
 */
export async function applyThreadMatter(
  change: (current: string | null, next: string | null) => Promise<void>,
  thread: ThreadMatterFields,
  { unsaved, afterSave }: { unsaved: boolean; afterSave: boolean },
): Promise<ThreadMatterOutcome> {
  const next = thread.pendingMatterId;
  if (next === undefined) return { kind: "linked", matterId: thread.matter_id ?? null };
  if (unsaved) return { kind: "waiting" };
  try {
    await change(thread.matter_id ?? null, next);
    return { kind: "linked", matterId: next };
  } catch (error) {
    if (!afterSave && isNotStoredYet(error)) return { kind: "waiting" };
    return { kind: "failed", message: refusalMessage(error) };
  }
}

/** The server does not have the chat yet: its first save has not landed. */
function isNotStoredYet(error: unknown): boolean {
  return error instanceof ChatRequestError && error.status === 404;
}

function refusalMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "The matter was not saved.";
}

/**
 * Folds an outcome back into the chat. `requested` is the choice that was
 * sent: when the person has chosen again since, the newer choice stays pending.
 */
export function withThreadMatterOutcome<T extends ThreadMatterFields>(
  thread: T,
  outcome: ThreadMatterOutcome,
  requested: string | null,
): T {
  if (outcome.kind === "waiting") return thread;
  const superseded = thread.pendingMatterId !== requested;
  if (outcome.kind === "failed") {
    return superseded ? thread : { ...thread, pendingMatterId: undefined, matterError: outcome.message };
  }
  return {
    ...thread,
    matter_id: outcome.matterId,
    pendingMatterId: superseded ? thread.pendingMatterId : undefined,
    matterError: undefined,
  };
}
