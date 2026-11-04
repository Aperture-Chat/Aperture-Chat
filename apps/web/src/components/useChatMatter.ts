import { useState } from "react";

import { matterTenantSlug } from "../lib/api/matters";
import { threadMatterId } from "../lib/chatMatter";
import { isBlankNewChat, type ChatStore } from "../lib/chatStore";
import { matterLabelFor } from "../lib/matters";
import type { BootstrapData } from "../lib/types";
import { useSavedMatters } from "../lib/useSavedMatters";
import { matterOptionDetail } from "./ComposerOptions";

/** Send options' Matter row for the open chat: what it is filed under, and changing it. */
export function useChatMatter(chat: Pick<ChatStore, "activeThread" | "setThreadMatter">, data: BootstrapData, panelOpen: boolean) {
  const [open, setOpen] = useState(false);
  // Saved client-matter numbers load the first time Send options opens.
  const saved = useSavedMatters(data.me.id, matterTenantSlug(data), panelOpen);
  const thread = chat.activeThread;
  const currentId = thread ? threadMatterId(thread) : null;
  const detail = matterOptionDetail({
    matterId: currentId,
    label: matterLabelFor(saved.matters, currentId),
    waiting: Boolean(thread && thread.pendingMatterId !== undefined && isBlankNewChat(thread)),
    loading: saved.status === "loading",
    error: thread?.matterError,
  });

  function choose(matterId: string | null) {
    if (!thread) return;
    setOpen(false);
    void chat.setThreadMatter(thread.id, matterId);
  }

  return { saved, currentId, detail, open, toggle: () => setOpen((current) => !current), choose };
}
