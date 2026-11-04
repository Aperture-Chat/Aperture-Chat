/**
 * The Share dialog's one decision: who besides the owner may open a draft.
 * Private is the default; a draft can go to the owner's whole group, or to
 * specific people in the owner's groups.
 */
import type { DraftSharing, ShareDirectory } from "./api/draftCollab";

export type ShareMode = "private" | "group" | "people";

export type ShareChoice = { mode: ShareMode; groupIds: string[]; userIds: string[] };

export function choiceFromSharing(sharing: DraftSharing, directory: ShareDirectory): ShareChoice {
  const groupIds = sharing.groups.map((group) => group.id);
  const userIds = sharing.people.map((person) => person.id);
  if (groupIds.length) return { mode: "group", groupIds, userIds: [] };
  if (userIds.length) return { mode: "people", groupIds: [], userIds };
  // Someone in one group is one click from "everyone in it".
  const onlyGroup = directory.groups.length === 1 ? [directory.groups[0].id] : [];
  return { mode: "private", groupIds: onlyGroup, userIds: [] };
}

export function sharePayload(choice: ShareChoice): { group_ids: string[]; user_ids: string[] } {
  if (choice.mode === "group") return { group_ids: [...choice.groupIds], user_ids: [] };
  if (choice.mode === "people") return { group_ids: [], user_ids: [...choice.userIds] };
  return { group_ids: [], user_ids: [] };
}

export function shareChoiceProblem(choice: ShareChoice): string | null {
  if (choice.mode === "group" && !choice.groupIds.length) return "Choose at least one group.";
  if (choice.mode === "people" && !choice.userIds.length) return "Add at least one person.";
  return null;
}

function listInWords(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Who can open the draft, as one plain sentence. */
export function sharingSentence(sharing: DraftSharing): string {
  const who = [
    ...sharing.groups.map((group) => `everyone in ${group.name}`),
    ...sharing.people.map((person) => person.display_name),
  ];
  const audience = listInWords(who);
  const capitalized = audience.charAt(0).toUpperCase() + audience.slice(1);
  if (sharing.role === "collaborator") {
    const opener = `${sharing.owner.display_name} shared this draft with you.`;
    return who.length ? `${opener} ${capitalized} can open and edit it.` : opener;
  }
  return who.length ? `${capitalized} can open and edit this draft.` : "Only you can open this draft.";
}
