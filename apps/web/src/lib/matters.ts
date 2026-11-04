/**
 * Client-matter tags: the plain-language layer over the server's matters.
 *
 * A matter is whatever number or name a person files work under, such as an
 * iManage client-matter number ("100234-0001"). Each one is a server matter
 * (services/api/app/routes/matters.py); chats and knowledge bases are linked
 * to it through that router's membership gate. Once someone has typed a
 * number it is one of their matters, so they pick it next time instead of
 * typing it again.
 */

/** Server matter record (app/models/matters.py `Matter`). */
export type Matter = {
  id: string;
  tenant_id: string;
  name: string;
  retention_days?: number | null;
  created_by_user_id: string;
  version: number;
  created_at: string;
  updated_at: string;
};

/** The resources a matter can enclose from this workspace. */
export type MatterResourceType = "chat-threads" | "knowledge-configs";

/** Mirrors MAX_MATTER_NAME_CHARS on the server. */
export const MAX_MATTER_LABEL_CHARS = 200;

/** A label as the server stores it: spacing collapsed, ends trimmed. */
export function cleanMatterLabel(text: string): string {
  return text.replace(/\u0000/g, "").split(/\s+/).filter(Boolean).join(" ");
}

/** Two labels name the same matter when they read the same, ignoring case and spacing. */
function matterKey(text: string): string {
  return cleanMatterLabel(text.normalize("NFKC")).toLocaleLowerCase();
}

/** Why a typed label can't be saved, in words; null when it can. */
export function matterLabelProblem(text: string): string | null {
  const label = cleanMatterLabel(text);
  if (!label) return "Type a client-matter number first.";
  if (label.length > MAX_MATTER_LABEL_CHARS) return `Use ${MAX_MATTER_LABEL_CHARS} characters or fewer.`;
  return null;
}

/** The saved matter a typed label names, if there is one. */
export function findMatterByLabel(matters: readonly Matter[], text: string): Matter | undefined {
  const key = matterKey(text);
  if (!key) return undefined;
  return matters.find((matter) => matterKey(matter.name) === key);
}

/** Saved matters whose label contains what was typed, keeping their order. */
export function matchingMatters(matters: readonly Matter[], text: string): Matter[] {
  const key = matterKey(text);
  if (!key) return [...matters];
  return matters.filter((matter) => matterKey(matter.name).includes(key));
}

/** The label to show for a linked matter, or null when this person can't name it. */
export function matterLabelFor(matters: readonly Matter[], matterId: string | null | undefined): string | null {
  if (!matterId) return null;
  return matters.find((matter) => matter.id === matterId)?.name ?? null;
}

export type MatterChangeStep = { op: "clear" | "assign"; matterId: string };

/**
 * The calls that move a resource from one matter to another. The server only
 * lets a resource join a matter while it belongs to none, so a change is an
 * unlink from the old matter followed by a link to the new one.
 */
export function matterChangeSteps(current: string | null, next: string | null): MatterChangeStep[] {
  if (current === next) return [];
  const steps: MatterChangeStep[] = [];
  if (current) steps.push({ op: "clear", matterId: current });
  if (next) steps.push({ op: "assign", matterId: next });
  return steps;
}

/**
 * The matter a typed label stands for: the saved one when the label matches,
 * otherwise a new matter created under that label. Returns the matter and the
 * list with any new matter first, as the server orders recent matters.
 */
export async function resolveMatterLabel(
  matters: readonly Matter[],
  text: string,
  create: (label: string) => Promise<Matter>,
): Promise<{ matter: Matter; matters: Matter[] }> {
  const problem = matterLabelProblem(text);
  if (problem) throw new Error(problem);
  const existing = findMatterByLabel(matters, text);
  if (existing) return { matter: existing, matters: [...matters] };
  const created = await create(cleanMatterLabel(text));
  return { matter: created, matters: [created, ...matters.filter((matter) => matter.id !== created.id)] };
}
