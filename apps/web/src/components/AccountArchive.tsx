import { Archive, ArchiveRestore, Bot, MessageSquare, Trash2 } from "lucide-react";
import { useId, useRef, useState, type RefObject } from "react";
import { archivedChatsLabel } from "../lib/accountDrawer";
import type { ChatThread } from "../lib/types";
import { AccountConfirm, AccountRowBody, AccountSection, useAnnounce, useReturnFocus } from "./AccountRow";
import { ChatPreview } from "./ChatPreview";

type ArchivedRowProps = {
  thread: ChatThread;
  confirming: boolean;
  deleting: boolean;
  failure: string | null;
  deleteKeyRef: (element: HTMLElement | null) => void;
  onAsk: () => void;
  onKeep: () => void;
  onDelete: () => void;
  onRestore: () => void;
};

function ArchivedRow({ thread, confirming, deleting, failure, deleteKeyRef, onAsk, onKeep, onDelete, onRestore }: ArchivedRowProps) {
  return (
    <li className="account-archived-row">
      {confirming ? (
        <AccountConfirm
          message={`Permanently delete "${thread.title}"? This removes the full conversation and cannot be undone.`}
          confirmLabel="Delete forever"
          confirmName={`Delete ${thread.title} forever`}
          cancelLabel="Keep"
          cancelName={`Keep ${thread.title}`}
          destructive
          busy={deleting}
          onConfirm={onDelete}
          onCancel={onKeep}
        />
      ) : (
        <>
          <span className="account-archived-icon" aria-hidden="true">
            {thread.used_agent ? <Bot size={15} /> : <MessageSquare size={15} />}
          </span>
          <ChatPreview thread={thread}>
            <span className="account-archived-summary" tabIndex={0}>
              <strong>{thread.title}</strong>
              <small>Archived · {thread.updated_at}</small>
            </span>
          </ChatPreview>
          <span className="account-archived-actions">
            <button
              className="message-icon-action"
              type="button"
              aria-label={`Restore ${thread.title}`}
              data-tooltip={`Return "${thread.title}" to your sidebar`}
              onClick={onRestore}
            >
              <ArchiveRestore size={15} />
            </button>
            <button
              ref={deleteKeyRef}
              className="message-icon-action account-delete-action"
              type="button"
              aria-label={`Permanently delete ${thread.title}`}
              data-tooltip={`Permanently delete "${thread.title}". This cannot be undone.`}
              onClick={onAsk}
            >
              <Trash2 size={15} />
            </button>
          </span>
        </>
      )}
      {failure && (
        <small className="drawer-error" role="alert">
          {failure}
        </small>
      )}
    </li>
  );
}

/** Restoring is immediate. Deleting waits for the server, which can refuse. */
function useArchiveActions(
  onRestoreThread: (chatId: string) => void,
  onDeleteThread: (chatId: string) => unknown,
  toggleRef: RefObject<HTMLButtonElement | null>,
  onMutationChange: (running: boolean) => void,
) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [failure, setFailure] = useState<{ chatId: string; message: string } | null>(null);
  const { returnTo, target } = useReturnFocus();
  const announce = useAnnounce();

  const ask = (chatId: string) => {
    setFailure(null);
    setConfirmingId(chatId);
  };

  const keep = (chatId: string) => {
    returnTo(chatId);
    setConfirmingId(null);
  };

  const reset = () => {
    setConfirmingId(null);
    setFailure(null);
  };

  // The row a person acted on disappears, so focus returns to a key that stays.
  const restore = (chatId: string) => {
    setFailure(null);
    onRestoreThread(chatId);
    announce("Chat restored to your sidebar.");
    toggleRef.current?.focus();
  };

  const deleteForever = async (chatId: string) => {
    setDeleting(true);
    onMutationChange(true);
    setFailure(null);
    try {
      await onDeleteThread(chatId);
      announce("Chat permanently deleted.");
      toggleRef.current?.focus();
    } catch (error) {
      returnTo(chatId);
      setFailure({ chatId, message: error instanceof Error ? error.message : "Could not delete this chat." });
    } finally {
      setDeleting(false);
      setConfirmingId(null);
      onMutationChange(false);
    }
  };

  return { confirmingId, deleting, failure, target, ask, keep, reset, restore, deleteForever };
}

export function AccountArchive({
  threads,
  onRestoreThread,
  onDeleteThread,
  onMutationChange,
}: {
  threads: ChatThread[];
  onRestoreThread: (chatId: string) => void;
  onDeleteThread: (chatId: string) => unknown;
  /** Holds the drawer open until the server's answer is on screen. */
  onMutationChange: (running: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const actions = useArchiveActions(onRestoreThread, onDeleteThread, toggleRef, onMutationChange);
  const archived = threads.filter((thread) => thread.archived);

  return (
    <AccountSection title="Data">
      <div className="account-slab">
        <div className="account-row">
          <AccountRowBody icon={Archive} title="Archived chats" detail={archivedChatsLabel(archived.length)} />
          <button
            ref={toggleRef}
            className="secondary-button"
            type="button"
            aria-label={open ? "Hide archived chats" : "View archived chats"}
            aria-expanded={open}
            aria-controls={panelId}
            data-tooltip={open ? "Collapse your archived chats" : "Review archived chats to restore or permanently delete them"}
            onClick={() => {
              setOpen((current) => !current);
              actions.reset();
            }}
          >
            {open ? "Hide" : "View"}
          </button>
        </div>
        {open && (
          <div id={panelId} className="account-row-panel">
            {archived.length > 0 ? (
              <ul className="account-well account-archived-list" aria-label="Archived chats">
                {archived.map((thread) => (
                  <ArchivedRow
                    key={thread.id}
                    thread={thread}
                    confirming={actions.confirmingId === thread.id}
                    deleting={actions.deleting}
                    failure={actions.failure?.chatId === thread.id ? actions.failure.message : null}
                    deleteKeyRef={actions.target(thread.id)}
                    onAsk={() => actions.ask(thread.id)}
                    onKeep={() => actions.keep(thread.id)}
                    onDelete={() => void actions.deleteForever(thread.id)}
                    onRestore={() => actions.restore(thread.id)}
                  />
                ))}
              </ul>
            ) : (
              <p className="account-well account-archived-empty">
                No archived chats. Archive a chat from the sidebar to keep it here without deleting it.
              </p>
            )}
          </div>
        )}
      </div>
    </AccountSection>
  );
}
