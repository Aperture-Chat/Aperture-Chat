import { useEffect, useState } from "react";
import { listKnowledgeDocuments } from "./api";
import type { KnowledgeBase, KnowledgeDocument } from "./types";

export type KnowledgeFiles = {
  docs: Record<string, KnowledgeDocument[]>;
  status: "idle" | "loading" | "loaded";
  failed: boolean;
  retry: () => void;
};

/** The files in each base, loaded while ``open``. Stable scope values keep ordinary
 * rerenders from cancelling their own request. Reopening refreshes the list, and
 * closing it or switching workspace aborts a stale response before it can replace
 * results. */
export function useKnowledgeFiles({
  userId,
  tenantId,
  open,
  bases,
}: {
  userId: string;
  tenantId: string | undefined;
  open: boolean;
  bases: KnowledgeBase[];
}): KnowledgeFiles {
  const [docs, setDocs] = useState<Record<string, KnowledgeDocument[]>>({});
  const [status, setStatus] = useState<KnowledgeFiles["status"]>("idle");
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const baseIdsKey = JSON.stringify(bases.map((base) => base.id));

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const baseIds = JSON.parse(baseIdsKey) as string[];
    setDocs({});
    setFailed(false);
    setStatus("loading");
    void Promise.allSettled(
      baseIds.map(async (baseId) => {
        const listed = await listKnowledgeDocuments(userId, baseId, { signal: controller.signal });
        return [baseId, listed] as const;
      }),
    ).then((results) => {
      if (controller.signal.aborted) return;
      setDocs(Object.fromEntries(results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))));
      setFailed(results.some((result) => result.status === "rejected"));
      setStatus("loaded");
    });
    return () => controller.abort();
  }, [open, baseIdsKey, userId, tenantId, reload]);

  return { docs, status, failed, retry: () => setReload((current) => current + 1) };
}
