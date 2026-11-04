import { useEffect, useState } from "react";

import { changeResourceMatter, matterTenantSlug } from "../lib/api/matters";
import { cleanMatterLabel } from "../lib/matters";
import type { BootstrapData, KnowledgeBase } from "../lib/types";
import { useSavedMatters } from "../lib/useSavedMatters";

/**
 * Filing knowledge bases under client-matter numbers. A base's matter encloses
 * every file, page, and API result in it, so records staff can find and clear
 * a matter's bases by number.
 */
export function useKnowledgeMatterFiling(userId: string, data: BootstrapData, enabled: boolean) {
  const tenantSlug = matterTenantSlug(data);
  // Saved numbers, offered in the create dialog and in Settings.
  const savedMatters = useSavedMatters(userId, tenantSlug, enabled);

  /** Files a base under the matter a label names; a blank label removes the tag. */
  async function fileUnderMatter(item: KnowledgeBase, label: string): Promise<KnowledgeBase> {
    const matter = cleanMatterLabel(label) ? await savedMatters.resolve(label) : null;
    await changeResourceMatter(userId, "knowledge-configs", item.id, item.matter_id ?? null, matter?.id ?? null, { tenantSlug });
    return { ...item, matter_id: matter?.id ?? null, matter_label: matter?.name ?? null };
  }

  return {
    savedMatters,
    fileUnderMatter,
    fileNewBase: (created: KnowledgeBase, label: string) => fileNewBase(fileUnderMatter, created, label),
  };
}

/** Files a just-created base when a number was typed. A refusal leaves it unfiled and says why. */
async function fileNewBase(
  file: (item: KnowledgeBase, label: string) => Promise<KnowledgeBase>,
  created: KnowledgeBase,
  label: string,
): Promise<{ base: KnowledgeBase; refusal: unknown }> {
  if (!cleanMatterLabel(label)) return { base: created, refusal: null };
  try {
    return { base: await file(created, label), refusal: null };
  } catch (error) {
    return { base: created, refusal: error };
  }
}

/** Settings' copy of a base's client-matter number, sent only when it changed. */
export function useMatterDraft(initial: string) {
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);
  const changed = cleanMatterLabel(value) !== cleanMatterLabel(initial);
  return { value, setValue, changed, patch: changed ? { matterLabel: value } : {} };
}
