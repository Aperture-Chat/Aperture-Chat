import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import { changeResourceMatter } from "./api";
import { applyThreadMatter, withChosenMatter, withThreadMatterOutcome } from "./chatMatter";
import type { ChatThread } from "./types";

/**
 * The chat store's half of filing chats under matters (see lib/chatMatter.ts).
 *
 * Changes to one chat run one after another, so a quick second choice never
 * races the first. Each confirmed change is counted per chat, so the store can
 * tell when a save's reply was sent before the latest change and must not
 * undo it.
 */
export function useThreadMatterSync({
  persona,
  tenantSlug,
  threadsRef,
  setThreads,
  isUnsaved,
}: {
  persona: string;
  tenantSlug: string | undefined;
  threadsRef: MutableRefObject<ChatThread[]>;
  setThreads: Dispatch<SetStateAction<ChatThread[]>>;
  /** True for a chat the server has never stored. */
  isUnsaved: (thread: ChatThread) => boolean;
}) {
  const chains = useRef(new Map<string, Promise<void>>());
  const changes = useRef(new Map<string, number>());

  const syncThreadMatter = useCallback(
    (threadId: string, afterSave: boolean): Promise<void> => {
      const run = async () => {
        const thread = threadsRef.current.find((item) => item.id === threadId);
        if (!thread || thread.pendingMatterId === undefined) return;
        const requested = thread.pendingMatterId;
        const outcome = await applyThreadMatter(
          (current, next) => changeResourceMatter(persona, "chat-threads", threadId, current, next, { tenantSlug }),
          thread,
          // A save that just succeeded stored the chat, even if this snapshot
          // has not caught up with the messages that made it worth saving.
          { unsaved: !afterSave && isUnsaved(thread), afterSave },
        );
        if (outcome.kind === "linked") countChange(changes.current, threadId);
        const settle = (item: ChatThread) => (item.id === threadId ? withThreadMatterOutcome(item, outcome, requested) : item);
        threadsRef.current = threadsRef.current.map(settle);
        setThreads((current) => current.map(settle));
      };
      const queued = (chains.current.get(threadId) ?? Promise.resolve()).then(run, run);
      chains.current.set(threadId, queued);
      return queued;
    },
    [isUnsaved, persona, setThreads, tenantSlug, threadsRef],
  );

  const setThreadMatter = useCallback(
    (chatId: string, matterId: string | null): Promise<void> => {
      const choose = (item: ChatThread) => (item.id === chatId ? withChosenMatter(item, matterId) : item);
      threadsRef.current = threadsRef.current.map(choose);
      setThreads((current) => current.map(choose));
      return syncThreadMatter(chatId, false);
    },
    [setThreads, syncThreadMatter, threadsRef],
  );

  /** How many matter changes this chat has had confirmed in this session. */
  const matterChangeCount = useCallback((threadId: string) => changeCount(changes.current, threadId), []);

  return { syncThreadMatter, setThreadMatter, matterChangeCount };
}

function changeCount(changes: Map<string, number>, threadId: string): number {
  return changes.get(threadId) ?? 0;
}

function countChange(changes: Map<string, number>, threadId: string) {
  changes.set(threadId, changeCount(changes, threadId) + 1);
}
