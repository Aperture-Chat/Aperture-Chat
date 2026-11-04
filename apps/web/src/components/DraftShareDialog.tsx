import { createPortal } from "react-dom";
import { Check, Lock, Search, UserMinus, UserPlus, Users, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  getShareDirectory,
  type DraftSharing,
  type ShareDirectory,
  type SharePeopleScope,
  type SharePerson,
} from "../lib/api/draftCollab";
import {
  choiceFromSharing,
  shareChoiceProblem,
  sharePayload,
  sharingSentence,
  type ShareChoice,
  type ShareMode,
} from "../lib/draftShareChoice";
import { useModalFocus } from "../lib/useModalFocus";
import { RailSwitch, type RailSwitchOption } from "./RailSwitch";
import { Toggle } from "./Primitives";
import "./draft-share.css";

const MODE_OPTIONS: RailSwitchOption<ShareMode>[] = [
  { value: "private", label: "Only me", icon: <Lock size={15} /> },
  { value: "group", label: "My group", icon: <Users size={15} /> },
  { value: "people", label: "Specific people", icon: <UserPlus size={15} /> },
];

/** Everyone is listed (the list scrolls); typing narrows it. */
const MAX_MATCHES = 500;

const SCOPE_WORDS: Record<SharePeopleScope, { add: string; nobody: string; noMatch: string }> = {
  groups: {
    add: "Add a person from your groups",
    nobody: "Nobody else is in your groups yet.",
    noMatch: "Nobody in your groups matches that.",
  },
  organization: {
    add: "Add a person from your organization",
    nobody: "Nobody else is in your organization yet.",
    noMatch: "Nobody in your organization matches that.",
  },
  everyone: {
    add: "Add a person",
    nobody: "There is nobody else to add yet.",
    noMatch: "Nobody matches that.",
  },
};

type ChoiceProps = { choice: ShareChoice; onChange(choice: ShareChoice): void };

/** People in the directory not yet chosen whose name or email holds every typed word. */
export function matchingPeople(people: SharePerson[], chosen: string[], query: string): SharePerson[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const taken = new Set(chosen);
  return people
    .filter((person) => !taken.has(person.id))
    .filter((person) => words.every((word) => `${person.display_name} ${person.email}`.toLowerCase().includes(word)))
    .slice(0, MAX_MATCHES);
}

function GroupChoice({ choice, onChange, directory }: ChoiceProps & { directory: ShareDirectory }) {
  if (!directory.groups.length) {
    return <p className="draft-share-note">You are not in any groups yet. Ask an administrator to add you to one.</p>;
  }
  const toggle = (groupId: string, on: boolean) =>
    onChange({
      ...choice,
      groupIds: on ? [...choice.groupIds, groupId] : choice.groupIds.filter((id) => id !== groupId),
    });
  return (
    <div className="draft-share-groups" role="group" aria-label="Your groups">
      <p className="draft-share-note">Everyone in the groups you turn on can open and edit this draft.</p>
      {directory.groups.map((group) => (
        <div className="draft-share-row" key={group.id}>
          <span className="draft-share-row-text">
            <strong>Everyone in {group.name}</strong>
            <small>{group.member_count === 1 ? "1 person" : `${group.member_count} people`}</small>
          </span>
          <Toggle
            label={`Share with everyone in ${group.name}`}
            checked={choice.groupIds.includes(group.id)}
            onChange={(on) => toggle(group.id, on)}
          />
        </div>
      ))}
    </div>
  );
}

function PersonRow({ person, action, label, icon, onClick }: {
  person: SharePerson | undefined;
  action: string;
  label: string;
  icon: React.ReactNode;
  onClick(): void;
}) {
  return (
    <li className="draft-share-row">
      <span className="draft-share-row-text">
        <strong>{person?.display_name ?? "A former member"}</strong>
        {person?.email && <small>{person.email}</small>}
      </span>
      <button type="button" className={`secondary-button draft-share-${action}`} aria-label={label} onClick={onClick}>
        {icon}
        {action === "add" ? "Add" : "Remove"}
      </button>
    </li>
  );
}

function noMatchesText(directory: ShareDirectory, query: string): string {
  const words = SCOPE_WORDS[directory.people_scope] ?? SCOPE_WORDS.groups;
  if (!directory.people.length) return words.nobody;
  return query.trim() ? words.noMatch : "Everyone you can share with is already added.";
}

function PeopleChoice({ choice, onChange, directory, known }: ChoiceProps & {
  directory: ShareDirectory;
  known: Map<string, SharePerson>;
}) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const matches = matchingPeople(directory.people, choice.userIds, query);
  return (
    <div className="draft-share-people">
      {choice.userIds.length > 0 && (
        <ul className="draft-share-chosen" aria-label="People who can open this draft">
          {choice.userIds.map((id) => (
            <PersonRow
              key={id}
              person={known.get(id)}
              action="remove"
              label={`Remove ${known.get(id)?.display_name ?? "this person"}`}
              icon={<UserMinus size={16} />}
              onClick={() => onChange({ ...choice, userIds: choice.userIds.filter((other) => other !== id) })}
            />
          ))}
        </ul>
      )}
      <label className="draft-share-search" htmlFor={searchId}>
        <span>{(SCOPE_WORDS[directory.people_scope] ?? SCOPE_WORDS.groups).add}</span>
        <span className="draft-share-search-field">
          <Search size={16} aria-hidden="true" />
          <input
            id={searchId}
            type="search"
            value={query}
            placeholder="Type a name or email"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
        </span>
      </label>
      {matches.length === 0 ? (
        <p className="draft-share-note">{noMatchesText(directory, query)}</p>
      ) : (
        <ul className="draft-share-matches" aria-label="People you can add">
          {matches.map((person) => (
            <PersonRow
              key={person.id}
              person={person}
              action="add"
              label={`Add ${person.display_name}`}
              icon={<UserPlus size={16} />}
              onClick={() => {
                onChange({ ...choice, userIds: [...choice.userIds, person.id] });
                setQuery("");
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function OwnerChoices({ sharing, directory, choice, onChange }: ChoiceProps & {
  sharing: DraftSharing;
  directory: ShareDirectory;
}) {
  const known = useMemo(
    () => new Map([...directory.people, ...sharing.people].map((person) => [person.id, person])),
    [directory, sharing],
  );
  const shared = choice.mode !== "private";
  return (
    <>
      <RailSwitch
        options={MODE_OPTIONS}
        value={choice.mode}
        onChange={(mode) => onChange({ ...choice, mode })}
        ariaLabel="Who can open this draft"
        block
      />
      {choice.mode === "private" && (
        <p className="draft-share-sentence">Only you can open this draft. Nobody else can see it.</p>
      )}
      {choice.mode === "group" && <GroupChoice choice={choice} onChange={onChange} directory={directory} />}
      {choice.mode === "people" && (
        <PeopleChoice choice={choice} onChange={onChange} directory={directory} known={known} />
      )}
      {sharing.matter_bound && shared && (
        <p className="draft-share-note draft-share-matter">
          This draft belongs to a matter, so only people on that matter can open it.
        </p>
      )}
      {shared && (
        <p className="draft-share-note">
          Changes save automatically for everyone. Use Save version to mark a point you can go back to.
        </p>
      )}
    </>
  );
}

function StatusNote({ alert, children }: { alert?: boolean; children: string }) {
  return alert ? (
    <p className="composer-error" role="alert">{children}</p>
  ) : (
    <p className="draft-share-note" role="status">{children}</p>
  );
}

/** The owner's group directory, once; collaborators never need it. */
function useShareDirectory(userId: string, tenantSlug: string | undefined, needed: boolean) {
  const [directory, setDirectory] = useState<ShareDirectory | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!needed) return undefined;
    const controller = new AbortController();
    getShareDirectory(userId, { tenantSlug, signal: controller.signal })
      .then(setDirectory)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "Your groups could not be loaded.");
        }
      });
    return () => controller.abort();
  }, [needed, userId, tenantSlug]);
  return { directory, error };
}

function ShareBody({ sharing, waitingMessage, directory, directoryError, choice, onChange }: {
  sharing: DraftSharing | null;
  waitingMessage: string | null;
  directory: ShareDirectory | null;
  directoryError: string | null;
  choice: ShareChoice | null;
  onChange(choice: ShareChoice): void;
}) {
  if (!sharing) {
    return waitingMessage
      ? <StatusNote alert>{waitingMessage}</StatusNote>
      : <StatusNote>Saving this draft to your account so others can open it…</StatusNote>;
  }
  if (!sharing.can_manage) {
    return (
      <>
        <p className="draft-share-sentence">{sharingSentence(sharing)}</p>
        <p className="draft-share-note">Only {sharing.owner.display_name} can change who has access.</p>
      </>
    );
  }
  if (directoryError) return <StatusNote alert>{directoryError}</StatusNote>;
  if (!directory || !choice) return <StatusNote>Loading your groups…</StatusNote>;
  return <OwnerChoices sharing={sharing} directory={directory} choice={choice} onChange={onChange} />;
}

function useShareSave(
  onSave: (shares: { group_ids: string[]; user_ids: string[] }) => Promise<DraftSharing>,
  onClose: () => void,
) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  async function save(ready: ShareChoice) {
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(sharePayload(ready));
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Sharing could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  }
  return { saving, saveError, save };
}

/** Cancel / Save sharing for the owner; Done for a collaborator. */
function ShareActions({ canManage, choice, onSave, onClose }: {
  canManage: boolean;
  choice: ShareChoice | null;
  onSave(shares: { group_ids: string[]; user_ids: string[] }): Promise<DraftSharing>;
  onClose(): void;
}) {
  const { saving, saveError, save } = useShareSave(onSave, onClose);
  if (!canManage) {
    return (
      <div className="draft-share-actions">
        <button className="primary-button" type="button" onClick={onClose}>Done</button>
      </div>
    );
  }
  const problem = choice ? shareChoiceProblem(choice) : null;
  return (
    <>
      {saveError && <p className="composer-error" role="alert">{saveError}</p>}
      <div className="draft-share-actions">
        {problem && <span className="draft-share-problem" role="status">{problem}</span>}
        <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
        <button
          className="primary-button"
          type="button"
          disabled={!choice || Boolean(problem) || saving}
          onClick={() => choice && void save(choice)}
        >
          <Check size={16} />
          {saving ? "Saving…" : "Save sharing"}
        </button>
      </div>
    </>
  );
}

/**
 * Who may open a draft. The owner picks one of three plain choices; a
 * collaborator sees who has access and who decides it.
 */
export function DraftShareDialog({
  userId,
  tenantSlug,
  title,
  sharing,
  waitingMessage = null,
  onSave,
  onClose,
}: {
  userId: string;
  tenantSlug?: string;
  title: string;
  /** Null while the draft is still being saved to the account. */
  sharing: DraftSharing | null;
  /** Why the draft could not be saved for sharing, when it could not. */
  waitingMessage?: string | null;
  onSave(shares: { group_ids: string[]; user_ids: string[] }): Promise<DraftSharing>;
  onClose(): void;
}) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  useModalFocus(ref, true, onClose);
  const canManage = sharing?.can_manage ?? false;
  const { directory, error: directoryError } = useShareDirectory(userId, tenantSlug, canManage);
  const [choice, setChoice] = useState<ShareChoice | null>(null);
  useEffect(() => {
    if (sharing && directory && choice === null) setChoice(choiceFromSharing(sharing, directory));
  }, [sharing, directory, choice]);

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <section
        ref={ref}
        className="modal draft-share-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-icon"><Users size={20} /></span>
          <div>
            <h2 id={titleId}>Share “{title.trim() || "this draft"}”</h2>
            <p>{canManage ? "Choose who can open and edit this draft with you." : "Who can open this draft."}</p>
          </div>
          <button type="button" className="icon-button" aria-label="Close sharing" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <div className="draft-share-body">
          <ShareBody
            sharing={sharing}
            waitingMessage={waitingMessage}
            directory={directory}
            directoryError={directoryError}
            choice={choice}
            onChange={setChoice}
          />
        </div>
        <ShareActions canManage={canManage} choice={choice} onSave={onSave} onClose={onClose} />
      </section>
    </div>,
    document.body,
  );
}
