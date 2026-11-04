import { Check, ChevronDown } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";

import {
  MAX_MATTER_LABEL_CHARS,
  cleanMatterLabel,
  findMatterByLabel,
  matchingMatters,
  matterLabelProblem,
  type Matter,
} from "../lib/matters";
import type { SavedMatters } from "../lib/useSavedMatters";

/** Saved numbers shown at once; the rest are a keystroke away. */
const FIELD_OPTION_LIMIT = 6;

type SavedList = Pick<SavedMatters, "matters" | "status">;

/** What the field says under itself, so the outcome is clear before saving. */
export function matterFieldHint(value: string, saved: SavedList, emptyHint: string): string {
  const label = cleanMatterLabel(value);
  if (!label) {
    if (saved.status === "failed") return `${emptyHint} Your saved numbers could not load; you can still type one.`;
    return saved.matters.length ? `${emptyHint} Pick a saved number or type a new one.` : emptyHint;
  }
  if (label.length > MAX_MATTER_LABEL_CHARS) return `Use ${MAX_MATTER_LABEL_CHARS} characters or fewer.`;
  if (findMatterByLabel(saved.matters, label)) return "One of your saved numbers.";
  return "A new number. It is saved for next time.";
}

/** The saved numbers a field offers: all of them once one is chosen, so it can be swapped. */
export function fieldOptions(matters: readonly Matter[], value: string): Matter[] {
  const options = findMatterByLabel(matters, value) ? [...matters] : matchingMatters(matters, value);
  return options.slice(0, FIELD_OPTION_LIMIT);
}

export type ListKeyAction = { kind: "move"; active: number } | { kind: "pick"; index: number } | { kind: "close" } | null;

/** What one key does to the list of saved numbers. */
export function listKeyAction(key: string, { open, active, count }: { open: boolean; active: number; count: number }): ListKeyAction {
  if (key === "ArrowDown" || key === "ArrowUp") {
    if (!count) return null;
    return { kind: "move", active: stepThrough(active, key === "ArrowDown" ? 1 : -1, count) };
  }
  if (!open) return null;
  if (key === "Enter") return active >= 0 ? { kind: "pick", index: active } : null;
  return key === "Escape" ? { kind: "close" } : null;
}

/** The next highlighted option, wrapping at both ends. With none highlighted, Down starts at the top and Up at the bottom. */
function stepThrough(active: number, step: 1 | -1, count: number): number {
  if (active < 0) return step === 1 ? 0 : count - 1;
  return (active + step + count) % count;
}

/** Open state and keyboard for a field's list of saved numbers. */
function useSavedNumberList(options: Matter[], disabled: boolean, onPick: (matter: Matter) => void) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const showList = open && !disabled && options.length > 0;

  function close() {
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const action = listKeyAction(event.key, { open: showList, active, count: options.length });
    if (!action) return;
    event.preventDefault();
    if (action.kind === "move") {
      setOpen(true);
      setActive(action.active);
    } else if (action.kind === "pick") {
      onPick(options[action.index]);
      close();
    } else {
      // Close the list, not the dialog around it.
      event.stopPropagation();
      close();
    }
  }

  return { showList, active, close, onKeyDown, reopen: () => setOpen(true), toggle: () => setOpen((current) => !current), setActive };
}

function SavedNumberOptions({
  id,
  options,
  active,
  chosenId,
  onPick,
}: {
  id: string;
  options: Matter[];
  active: number;
  chosenId: string | undefined;
  onPick: (matter: Matter) => void;
}) {
  return (
    <ul id={id} role="listbox" aria-label="Saved numbers" className="matter-field-list">
      {options.map((matter, index) => (
        <li
          key={matter.id}
          id={`${id}-${index}`}
          role="option"
          aria-selected={matter.id === chosenId}
          className={index === active ? "is-active" : undefined}
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(matter);
          }}
        >
          <span className="matter-option-check" aria-hidden="true">{matter.id === chosenId && <Check size={13} />}</span>
          <span className="matter-option-name">{matter.name}</span>
        </li>
      ))}
    </ul>
  );
}

function SavedNumberToggle({
  open,
  disabled,
  inputRef,
  onToggle,
}: {
  open: boolean;
  disabled: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="matter-field-toggle"
      aria-label={open ? "Hide saved numbers" : "Show saved numbers"}
      tabIndex={-1}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        onToggle();
        inputRef.current?.focus();
      }}
    >
      <ChevronDown size={16} aria-hidden="true" />
    </button>
  );
}

/**
 * A client-matter number in a form: type one, or pick one saved before. The
 * form keeps the text and resolves it to a matter when it is submitted.
 */
export function MatterField({
  value,
  onChange,
  saved,
  disabled = false,
  emptyHint,
}: {
  value: string;
  onChange: (value: string) => void;
  saved: SavedList;
  disabled?: boolean;
  emptyHint: string;
}) {
  const inputId = useId();
  const listId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const options = fieldOptions(saved.matters, value);
  const list = useSavedNumberList(options, disabled, (matter) => onChange(matter.name));
  const activeId = list.showList && list.active >= 0 ? `${listId}-${list.active}` : undefined;

  return (
    <div className="matter-field">
      <label htmlFor={inputId}>
        Client-matter number <span className="knowledge-optional">Optional</span>
      </label>
      <div className="matter-field-control">
        <input
          ref={inputRef}
          id={inputId}
          role="combobox"
          aria-expanded={list.showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-describedby={hintId}
          value={value}
          placeholder="e.g. 100234-0001"
          maxLength={MAX_MATTER_LABEL_CHARS}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.target.value);
            list.reopen();
            list.setActive(-1);
          }}
          onFocus={list.reopen}
          onBlur={list.close}
          onKeyDown={list.onKeyDown}
        />
        {saved.matters.length > 0 && (
          <SavedNumberToggle open={list.showList} disabled={disabled} inputRef={inputRef} onToggle={list.toggle} />
        )}
        {list.showList && (
          <SavedNumberOptions
            id={listId}
            options={options}
            active={list.active}
            chosenId={findMatterByLabel(saved.matters, value)?.id}
            onPick={(matter) => {
              onChange(matter.name);
              list.close();
            }}
          />
        )}
      </div>
      <small id={hintId} className="knowledge-field-hint">
        {matterFieldHint(value, saved, emptyHint)}
      </small>
    </div>
  );
}

/** Typing a number in the chooser, then saving it or using the saved one it names. */
function useMatterEntry(saved: SavedMatters, onChoose: (matterId: string) => void) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit() {
    const reason = matterLabelProblem(text);
    if (reason) {
      setProblem(reason);
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      const matter = await saved.resolve(text);
      setText("");
      onChoose(matter.id);
    } catch (error) {
      setProblem(error instanceof Error && error.message ? error.message : "The number was not saved.");
    } finally {
      setSaving(false);
    }
  }

  function change(value: string) {
    setText(value);
    setProblem(null);
  }

  return { text, saving, problem, submit, change };
}

function SavedMatterChoices({
  options,
  currentId,
  onChoose,
}: {
  options: Matter[];
  currentId: string | null;
  onChoose: (matterId: string) => void;
}) {
  return (
    <div className="knowledge-source-picker matter-chooser-list" role="group" aria-label="Your saved numbers">
      {options.map((matter) => {
        const selected = matter.id === currentId;
        return (
          <button
            key={matter.id}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            className={`knowledge-source-option ${selected ? "is-selected" : ""}`}
            onClick={() => onChoose(matter.id)}
          >
            <span className="knowledge-source-check" aria-hidden="true">{selected && <Check size={12} />}</span>
            <span className="knowledge-source-name">{matter.name}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The chooser's text box and its button: Use for a saved number, Save for a new one. */
function ChooserEntry({ entry, known }: { entry: ReturnType<typeof useMatterEntry>; known: boolean }) {
  const typed = cleanMatterLabel(entry.text);
  return (
    <div className="matter-chooser-entry">
      <input
        aria-label="Client-matter number"
        placeholder="Type or find a number"
        value={entry.text}
        maxLength={MAX_MATTER_LABEL_CHARS}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => entry.change(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          void entry.submit();
        }}
      />
      <button type="button" className="secondary-button" disabled={!typed || entry.saving} onClick={() => void entry.submit()}>
        {entry.saving ? "Saving…" : known ? "Use" : "Save"}
      </button>
    </div>
  );
}

/** One line on where the saved list stands, or none when the list speaks for itself. */
export function chooserNote(saved: SavedList, typed: string, matches: number): string | null {
  if (saved.status === "loading") return saved.matters.length ? null : "Loading your saved numbers…";
  if (saved.status !== "ready") return null;
  if (typed) return matches ? null : "No saved number matches. Save it to use it now and next time.";
  return saved.matters.length ? null : "Type the number you file this work under, such as 100234-0001.";
}

/**
 * Chooses the matter for one chat inside Send options: pick a saved number,
 * or type a new one and save it. A choice applies at once.
 */
export function MatterChooser({
  saved,
  currentId,
  onChoose,
}: {
  saved: SavedMatters;
  currentId: string | null;
  onChoose: (matterId: string | null) => void;
}) {
  const entry = useMatterEntry(saved, onChoose);
  const options = matchingMatters(saved.matters, entry.text);
  const typed = cleanMatterLabel(entry.text);
  const note = chooserNote(saved, typed, options.length);

  return (
    <div className="matter-chooser" role="group" aria-label="Matter for this chat">
      <ChooserEntry entry={entry} known={Boolean(findMatterByLabel(saved.matters, typed))} />
      {options.length > 0 && <SavedMatterChoices options={options} currentId={currentId} onChoose={onChoose} />}
      {note && <small role={saved.status === "loading" ? "status" : undefined}>{note}</small>}
      {saved.status === "failed" && (
        <button type="button" className="link-button" onClick={saved.retry}>
          Your saved numbers did not load. Try again
        </button>
      )}
      {entry.problem && <small role="alert" className="matter-chooser-problem">{entry.problem}</small>}
      {currentId && (
        <button type="button" className="link-button" onClick={() => onChoose(null)}>
          Remove the tag from this chat
        </button>
      )}
    </div>
  );
}
