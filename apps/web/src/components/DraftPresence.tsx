import type { DraftParticipant } from "../lib/api/draftCollab";
import "./draft-share.css";

const SHOWN = 4;

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = words[0][0] ?? "";
  const last = words.length > 1 ? words[words.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase();
}

/** Other people with this draft open now, once each (their tabs merged). */
export function otherParticipants(participants: DraftParticipant[], meId: string): DraftParticipant[] {
  const seen = new Set<string>();
  return participants.filter((person) => {
    if (person.user_id === meId || seen.has(person.user_id)) return false;
    seen.add(person.user_id);
    return true;
  });
}

export function presenceSentence(people: DraftParticipant[]): string {
  const names = people.map((person) => person.display_name);
  if (!names.length) return "";
  if (names.length === 1) return `${names[0]} is here`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are here`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more are here`;
}

/** Colored initials for everyone else in the draft, like a sign-in sheet. */
export function DraftPresence({ participants, meId }: { participants: DraftParticipant[]; meId: string }) {
  const others = otherParticipants(participants, meId);
  if (!others.length) return null;
  const sentence = presenceSentence(others);
  return (
    <div className="draft-presence" role="group" aria-label={sentence} data-tooltip={sentence}>
      {others.slice(0, SHOWN).map((person) => (
        <span
          key={person.user_id}
          className="draft-presence-chip"
          data-presence-color={person.color}
          aria-hidden="true"
        >
          {initialsOf(person.display_name)}
        </span>
      ))}
      {others.length > SHOWN && (
        <span className="draft-presence-chip draft-presence-more" aria-hidden="true">+{others.length - SHOWN}</span>
      )}
    </div>
  );
}
