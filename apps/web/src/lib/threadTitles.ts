import { useEffect, useMemo, useState } from "react";

/** Matches the API's per-request limit, which keeps a lookup's URL short. */
const TITLES_PER_REQUEST = 100;

export type ThreadTitleLoader = (threadIds: string[]) => Promise<Record<string, string> | void> | Record<string, string> | void;

function batches<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let start = 0; start < items.length; start += size) groups.push(items.slice(start, start + size));
  return groups;
}

export async function loadThreadTitles(threadIds: string[], load: ThreadTitleLoader): Promise<Record<string, string>> {
  const pages = await Promise.all(batches(threadIds, TITLES_PER_REQUEST).map((group) => load(group)));
  return Object.assign({}, ...pages);
}

/** Names for the given conversations. Until a name arrives, or if the lookup
 * fails, a conversation simply has none, and the caller's generic label stands. */
export function useThreadTitles(threadIds: string[], load: ThreadTitleLoader | undefined): ReadonlyMap<string, string> {
  const [titles, setTitles] = useState<Record<string, string>>({});
  const missingKey = useMemo(() => JSON.stringify(threadIds.filter((id) => !(id in titles))), [threadIds, titles]);

  useEffect(() => {
    const missing = JSON.parse(missingKey) as string[];
    if (!load || missing.length === 0) return;
    loadThreadTitles(missing, load)
      .then((found) => {
        // A conversation with no answer gets an empty name so it is not asked for again.
        const answered = Object.fromEntries(missing.map((id) => [id, found[id] ?? ""]));
        setTitles((current) => ({ ...current, ...answered }));
      })
      .catch(() => undefined);
  }, [load, missingKey]);

  return useMemo(() => new Map(Object.entries(titles).filter(([, title]) => title)), [titles]);
}
