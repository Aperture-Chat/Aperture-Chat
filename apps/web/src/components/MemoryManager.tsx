import { Brain, Check, Pin, PinOff, Plus, Trash2, X } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { Pill, Toggle } from "./Primitives";
import { SelectControl } from "./SelectControl";
import type { MemoryCollection, MemoryKind, UserMemory, UserMemorySettings } from "../lib/types";

/* Everything a person can do with what the assistant has learned about them:
 * read it, correct it, pin what matters, delete what does not, and switch the
 * whole thing off. This modal is the only surface anywhere in the platform that
 * displays memory content, and it only ever shows the signed-in user's own. */

const KIND_LABELS: Record<MemoryKind, string> = {
  preference: "Preferences",
  directive: "Standing instructions",
  profile: "About you",
  project: "Your work",
  fact: "Other details",
};

const KIND_HINTS: Record<MemoryKind, string> = {
  preference: "How you like answers written and formatted.",
  directive: "Rules the assistant follows on every reply.",
  profile: "Your role, expertise, and working context.",
  project: "Matters and workstreams you keep coming back to.",
  fact: "Anything else durable you have mentioned.",
};

const KIND_ORDER: MemoryKind[] = ["directive", "preference", "profile", "project", "fact"];

export type MemoryManagerApi = {
  list: () => Promise<MemoryCollection>;
  create: (payload: { content: string; kind: MemoryKind }) => Promise<UserMemory>;
  update: (memoryId: string, patch: { content?: string; pinned?: boolean }) => Promise<UserMemory>;
  remove: (memoryId: string) => Promise<void>;
  purge: () => Promise<{ removed: number }>;
  updateSettings: (patch: Partial<Omit<UserMemorySettings, "user_id">>) => Promise<UserMemorySettings>;
};

export function MemoryManager({ api, onClose }: { api: MemoryManagerApi; onClose: () => void }) {
  const [collection, setCollection] = useState<MemoryCollection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftKind, setDraftKind] = useState<MemoryKind>("preference");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [confirmingPurge, setConfirmingPurge] = useState(false);
  const titleId = useId();
  const draftId = useId();

  useEffect(() => {
    let active = true;
    api
      .list()
      .then((next) => {
        if (active) setCollection(next);
      })
      .catch((loadError: unknown) => {
        if (active) setError(messageFor(loadError, "Your memories could not be loaded."));
      });
    return () => {
      active = false;
    };
  }, [api]);

  const grouped = useMemo(() => {
    const buckets = new Map<MemoryKind, UserMemory[]>();
    for (const memory of collection?.memories ?? []) {
      const bucket = buckets.get(memory.kind) ?? [];
      bucket.push(memory);
      buckets.set(memory.kind, bucket);
    }
    return KIND_ORDER.filter((kind) => (buckets.get(kind)?.length ?? 0) > 0).map((kind) => ({
      kind,
      memories: [...(buckets.get(kind) ?? [])].sort(
        (left, right) => Number(right.pinned) - Number(left.pinned),
      ),
    }));
  }, [collection]);

  const state = collection?.state;
  const settings = collection?.settings;
  const total = collection?.memories.length ?? 0;

  async function run(key: string, action: () => Promise<void>) {
    setPending(key);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(messageFor(actionError, "That change was not saved."));
    } finally {
      setPending((current) => (current === key ? null : current));
    }
  }

  function addMemory() {
    const content = draft.trim();
    if (content.length < 4) return;
    void run("create", async () => {
      const created = await api.create({ content, kind: draftKind });
      setCollection((current) =>
        current ? { ...current, memories: [...current.memories, created] } : current,
      );
      setDraft("");
    });
  }

  function saveEdit(memory: UserMemory) {
    const content = editingText.trim();
    if (content.length < 4 || content === memory.content) {
      setEditingId(null);
      return;
    }
    void run(`edit-${memory.id}`, async () => {
      const saved = await api.update(memory.id, { content });
      replaceMemory(saved);
      setEditingId(null);
    });
  }

  function togglePin(memory: UserMemory) {
    void run(`pin-${memory.id}`, async () => {
      const saved = await api.update(memory.id, { pinned: !memory.pinned });
      replaceMemory(saved);
    });
  }

  function removeMemory(memory: UserMemory) {
    void run(`delete-${memory.id}`, async () => {
      await api.remove(memory.id);
      setCollection((current) =>
        current
          ? { ...current, memories: current.memories.filter((item) => item.id !== memory.id) }
          : current,
      );
    });
  }

  function forgetEverything() {
    void run("purge", async () => {
      await api.purge();
      setCollection((current) => (current ? { ...current, memories: [] } : current));
      setConfirmingPurge(false);
    });
  }

  function changeSetting(patch: Partial<Omit<UserMemorySettings, "user_id">>) {
    void run("settings", async () => {
      const saved = await api.updateSettings(patch);
      setCollection((current) => (current ? { ...current, settings: saved } : current));
    });
  }

  function replaceMemory(saved: UserMemory) {
    setCollection((current) =>
      current
        ? { ...current, memories: current.memories.map((item) => (item.id === saved.id ? saved : item)) }
        : current,
    );
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal memory-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-icon">
            <Brain size={20} />
          </span>
          <div>
            <h2 id={titleId}>What the assistant remembers about you</h2>
            <p>
              Only you can see this. Administrators can see how many memories you have and delete them, but never read
              them.
            </p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close memory manager"
            data-tooltip="Close this panel"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>

        {state && !state.enabled && (
          <p className="memory-disabled-note" role="status">
            {state.reason ?? "Memory is not available for your account."}{" "}
            {state.user_enabled
              ? "Anything already saved stays here and is not used until it is turned back on."
              : ""}
          </p>
        )}

        {settings && state?.platform_enabled && state.tenant_enabled && state.group_allowed && (
          <div className="memory-settings">
            <div className="permission-row">
              <span>
                <strong>Use memory in my chats</strong>
                <small>Apply what you have saved here to every answer.</small>
              </span>
              <Toggle
                checked={settings.enabled}
                disabled={pending === "settings"}
                label="Use memory in my chats"
                tooltip="Turn personalization on or off for your account only"
                onChange={(next) => changeSetting({ enabled: next })}
              />
            </div>
            <div className="permission-row">
              <span>
                <strong>Learn from my conversations</strong>
                <small>Notice durable preferences on its own instead of only what you ask it to remember.</small>
              </span>
              <Toggle
                checked={settings.auto_capture_enabled}
                disabled={pending === "settings" || !settings.enabled}
                label="Learn from my conversations"
                tooltip="Allow new memories to be created automatically from what you write"
                onChange={(next) => changeSetting({ auto_capture_enabled: next })}
              />
            </div>
          </div>
        )}

        <div className="memory-add-row">
          <label className="memory-add-field" htmlFor={draftId}>
            <span>Add something you want remembered</span>
            <input
              id={draftId}
              type="text"
              value={draft}
              placeholder="Prefers a short summary before the detail"
              maxLength={400}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && state?.enabled) addMemory();
              }}
            />
          </label>
          <SelectControl
            className="memory-kind-select"
            value={draftKind}
            aria-label="Memory type"
            onChange={(event) => setDraftKind(event.target.value as MemoryKind)}
          >
            {KIND_ORDER.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABELS[kind]}
              </option>
            ))}
          </SelectControl>
          <button
            className="primary-button compact"
            type="button"
            disabled={draft.trim().length < 4 || pending === "create" || !state?.enabled}
            data-tooltip="Save this so the assistant applies it from now on"
            onClick={addMemory}
          >
            <Plus size={14} /> Add
          </button>
        </div>

        {error && <p className="connector-config-error">{error}</p>}

        <div className="memory-list">
          {collection === null ? (
            <p className="muted-note">Loading your memories…</p>
          ) : total === 0 ? (
            <div className="audit-empty-state">
              <Brain size={20} />
              <span>
                <strong>Nothing remembered yet</strong>
                <small>
                  Tell the assistant "remember that…" in a chat, or add something above. It will apply from your next
                  message on.
                </small>
              </span>
            </div>
          ) : (
            grouped.map((group) => (
              <div className="memory-group" key={group.kind}>
                <div className="memory-group-head">
                  <h3>{KIND_LABELS[group.kind]}</h3>
                  <small>{KIND_HINTS[group.kind]}</small>
                </div>
                {group.memories.map((memory) => (
                  <div className="memory-row" key={memory.id}>
                    {editingId === memory.id ? (
                      <input
                        className="memory-edit-input"
                        type="text"
                        value={editingText}
                        maxLength={400}
                        autoFocus
                        aria-label={`Edit memory: ${memory.content}`}
                        onChange={(event) => setEditingText(event.target.value)}
                        onBlur={() => saveEdit(memory)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") saveEdit(memory);
                          if (event.key === "Escape") setEditingId(null);
                        }}
                      />
                    ) : (
                      <button
                        className="memory-content"
                        type="button"
                        data-tooltip="Click to correct the wording"
                        onClick={() => {
                          setEditingId(memory.id);
                          setEditingText(memory.content);
                        }}
                      >
                        {memory.content}
                      </button>
                    )}
                    {memory.source === "inferred" && <Pill tone="neutral">Learned</Pill>}
                    <button
                      className="icon-button"
                      type="button"
                      disabled={pending === `pin-${memory.id}`}
                      aria-label={memory.pinned ? `Unpin: ${memory.content}` : `Pin: ${memory.content}`}
                      data-tooltip={
                        memory.pinned
                          ? "Unpin so this can age out like any other memory"
                          : "Pin so this is always applied and never retired automatically"
                      }
                      onClick={() => togglePin(memory)}
                    >
                      {memory.pinned ? <Pin size={15} /> : <PinOff size={15} />}
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      disabled={pending === `delete-${memory.id}`}
                      aria-label={`Forget: ${memory.content}`}
                      data-tooltip="Forget this permanently"
                      onClick={() => removeMemory(memory)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>

        <div className="memory-footer">
          <small>
            {total} {total === 1 ? "memory" : "memories"} saved
          </small>
          {confirmingPurge ? (
            <span className="memory-purge-confirm">
              <span>Forget all {total}? This cannot be undone.</span>
              <button
                className="secondary-button compact"
                type="button"
                disabled={pending === "purge"}
                onClick={forgetEverything}
              >
                <Check size={14} /> Yes, forget everything
              </button>
              <button className="secondary-button compact" type="button" onClick={() => setConfirmingPurge(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button
              className="secondary-button compact"
              type="button"
              disabled={total === 0}
              data-tooltip="Delete every memory the assistant has about you"
              onClick={() => setConfirmingPurge(true)}
            >
              <Trash2 size={14} /> Forget everything
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
