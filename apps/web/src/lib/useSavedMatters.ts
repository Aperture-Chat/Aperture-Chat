import { useCallback, useEffect, useRef, useState } from "react";

import { createMatter, listMatters } from "./api/matters";
import { resolveMatterLabel, type Matter } from "./matters";

export type SavedMattersStatus = "loading" | "ready" | "failed";

export type SavedMatters = {
  /** This person's matters, most recent first. */
  matters: Matter[];
  status: SavedMattersStatus;
  /** The matter a typed label names, saving it the first time it is used. */
  resolve: (label: string) => Promise<Matter>;
  retry: () => void;
};

// One list per person and tenant for the whole session, so a number typed in
// the Library is already offered in Send options.
const savedLists = new Map<string, Matter[]>();

/** Forgets every cached list (tests, sign-out). */
export function clearSavedMatters() {
  savedLists.clear();
}

export function useSavedMatters(userId: string, tenantSlug?: string, enabled = true): SavedMatters {
  const key = `${userId}\u0000${tenantSlug ?? ""}`;
  const [matters, setMatters] = useState<Matter[]>(() => savedLists.get(key) ?? []);
  const [status, setStatus] = useState<SavedMattersStatus>(() => (savedLists.has(key) ? "ready" : "loading"));
  const [attempt, setAttempt] = useState(0);
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    if (!savedLists.has(key)) setStatus("loading");
    listMatters(userId, { tenantSlug, signal: controller.signal })
      .then((loaded) => {
        savedLists.set(key, loaded);
        setMatters(loaded);
        setStatus("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("failed");
      });
    return () => controller.abort();
  }, [attempt, enabled, key, tenantSlug, userId]);

  const resolve = useCallback(
    async (label: string) => {
      const result = await resolveMatterLabel(savedLists.get(key) ?? [], label, (name) =>
        createMatter(userId, name, { tenantSlug }),
      );
      savedLists.set(key, result.matters);
      if (keyRef.current === key) {
        setMatters(result.matters);
        setStatus("ready");
      }
      return result.matter;
    },
    [key, tenantSlug, userId],
  );

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { matters, status, resolve, retry };
}
