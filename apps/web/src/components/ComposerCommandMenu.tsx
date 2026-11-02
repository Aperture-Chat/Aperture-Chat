import type { LucideIcon } from "lucide-react";
import { Fragment, type ReactNode, type RefObject } from "react";
import { groupCommandSections, type CommandMenuEntry } from "../lib/composerCommands";
import type { KnowledgeFiles } from "../lib/useKnowledgeFiles";

/** A symbol's list of choices, opening from the composer. The text box keeps
 * focus, so the rows must not take it when pressed. */
export function ComposerCommandMenu<T extends CommandMenuEntry>({
  menuRef,
  listId,
  label,
  items,
  activeIndex,
  iconFor,
  onHighlight,
  onPick,
  children,
}: {
  menuRef: RefObject<HTMLDivElement | null>;
  listId: string;
  label: string;
  items: T[];
  activeIndex: number;
  iconFor: (item: T) => LucideIcon;
  onHighlight: (index: number) => void;
  onPick: (item: T) => void;
  children?: ReactNode;
}) {
  return (
    <div ref={menuRef} className="composer-command-menu" id={listId} role="listbox" aria-label={label}>
      {groupCommandSections(items).map((section) => (
        <Fragment key={section.title}>
          <span className="composer-command-section">{section.title}</span>
          {section.items.map((item) => {
            const index = items.indexOf(item);
            const Icon = iconFor(item);
            return (
              <button
                key={item.id}
                id={`${listId}-${index}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={`composer-command-item ${index === activeIndex ? "is-active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onHighlight(index)}
                onClick={() => onPick(item)}
              >
                <Icon size={15} />
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.detail}</small>
                </span>
              </button>
            );
          })}
        </Fragment>
      ))}
      {children}
      <span className="composer-command-hint" aria-hidden="true">
        ↑↓ navigate · Enter insert
        {items.length === 1 ? " · Tab complete" : ""} · Esc dismiss
      </span>
    </div>
  );
}

/** What the # menu has to say about its files: how to use them, that they are on
 * their way, that some failed, or that there are none. */
export function KnowledgeMenuStatus({
  files,
  itemCount,
  query,
}: {
  files: KnowledgeFiles;
  itemCount: number;
  query: string;
}) {
  return (
    <>
      {itemCount > 0 && (
        <span className="composer-command-hint">Choose a file to attach it, or a knowledge base to bring in all of it.</span>
      )}
      {files.status === "loading" && <span className="composer-command-loading">Loading files…</span>}
      {files.failed && (
        <span className="composer-command-loading" role="status">
          Some files could not be loaded.{" "}
          <button
            className="link-button"
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={files.retry}
          >
            Retry
          </button>
        </span>
      )}
      {itemCount === 0 && files.status !== "loading" && !files.failed && (
        <span className="composer-command-loading">
          {query.trim()
            ? "No matching commands. Try another name."
            : "No knowledge bases are enabled yet — add one under Knowledge"}
        </span>
      )}
    </>
  );
}
