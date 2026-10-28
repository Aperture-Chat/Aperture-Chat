import { useCallback, useRef } from "react";

const HISTORY_LIMIT = 50;

/** Undo/redo for direct edits on one figure. Every step still persists
 * through onCommit, so undoing is itself a saved edit. `current` is the
 * model the figure shows right now. */
export function useDiagramHistory<T>(current: T, onCommit?: (next: T) => void) {
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const currentRef = useRef(current);
  currentRef.current = current;

  const commit = useCallback(
    (next: T) => {
      if (!onCommit) return;
      past.current = [...past.current.slice(1 - HISTORY_LIMIT), currentRef.current];
      future.current = [];
      onCommit(next);
    },
    [onCommit],
  );

  const step = useCallback(
    (from: { current: T[] }, to: { current: T[] }) => {
      const target = from.current.pop();
      if (target === undefined || !onCommit) return false;
      to.current.push(currentRef.current);
      onCommit(target);
      return true;
    },
    [onCommit],
  );

  const undo = useCallback(() => step(past, future), [step]);
  const redo = useCallback(() => step(future, past), [step]);

  return { commit, undo, redo };
}
