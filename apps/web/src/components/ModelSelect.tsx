import { Check, ChevronDown, Sparkles, Star } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { ChatStore } from "../lib/chatStore";
import "./model-select.css";

type ModelSelection = Pick<ChatStore, "enabledModels" | "model" | "defaultModelId" | "setModel" | "setDefaultModel">;

/** Focus previews a choice; selection happens only on click or Enter/Space.
 * The default action is separate from the listbox so it remains a real button
 * instead of an interactive descendant flattened by an option's ARIA role. */
export function ModelSelect({ chat }: { chat: ModelSelection }) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const typeaheadRef = useRef({ text: "", at: 0 });
  const listId = useId();
  const hasModels = chat.enabledModels.length > 0;
  const selected = chat.enabledModels.find((model) => model.id === chat.model);
  const label = selected?.name ?? chat.enabledModels[0]?.name;
  const active = chat.enabledModels.find((model) => model.id === activeId) ?? selected ?? chat.enabledModels[0];

  function close(restoreFocus = true) {
    setOpen(false);
    typeaheadRef.current = { text: "", at: 0 };
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }

  function focusOption(index: number) {
    const model = chat.enabledModels[index];
    if (!model) return;
    setActiveId(model.id);
    optionRefs.current.get(model.id)?.focus({ preventScroll: true });
    optionRefs.current.get(model.id)?.scrollIntoView?.({ block: "nearest" });
  }

  function openPicker(index = Math.max(0, chat.enabledModels.findIndex((model) => model.id === chat.model))) {
    if (!hasModels) return;
    setActiveId(chat.enabledModels[index]?.id ?? chat.enabledModels[0].id);
    setOpen(true);
  }

  useEffect(() => {
    if (!hasModels) { setOpen(false); return; }
    if (!open) return;
    optionRefs.current.get(activeId ?? chat.model)?.focus({ preventScroll: true });
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close(false);
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
    // Moving between options must not reinstall listeners or refocus the list
    // when the user tabs to the separate default action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasModels]);

  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.altKey || event.metaKey || event.ctrlKey) return;
    const index = Math.max(0, chat.enabledModels.findIndex((model) => model.id === active?.id));
    let next: number | undefined;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (active) chat.setModel(active.id);
      close();
      return;
    }
    if (event.key === "ArrowDown") next = (index + 1) % chat.enabledModels.length;
    else if (event.key === "ArrowUp") next = (index - 1 + chat.enabledModels.length) % chat.enabledModels.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = chat.enabledModels.length - 1;
    else if (event.key.length === 1 && event.key !== " ") {
      const now = Date.now();
      const prior = now - typeaheadRef.current.at < 700 ? typeaheadRef.current.text : "";
      const typed = event.key.toLocaleLowerCase();
      // Repeating one letter cycles all matching names, like a native select.
      const text = prior && [...prior].every((character) => character === typed) ? typed : prior + typed;
      typeaheadRef.current = { text, at: now };
      for (let offset = 1; offset <= chat.enabledModels.length; offset += 1) {
        const candidate = (index + offset) % chat.enabledModels.length;
        if (chat.enabledModels[candidate].name.toLocaleLowerCase().startsWith(text)) {
          next = candidate;
          break;
        }
      }
      event.preventDefault();
    }
    if (next !== undefined) {
      event.preventDefault();
      focusOption(next);
    }
  }

  return (
    <div
      className="model-select"
      ref={rootRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close(false);
      }}
    >
      <button
        ref={triggerRef}
        className={`select-button ${hasModels ? "" : "is-unavailable"}`}
        type="button"
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        aria-label={hasModels ? "Select model" : "No connected models"}
        data-tooltip={hasModels ? "Choose which AI model answers your messages" : "Ask your admin to connect a model provider to start chatting"}
        disabled={!hasModels}
        onClick={() => open ? close() : openPicker()}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            openPicker(event.key === "Home" ? 0 : event.key === "End" ? chat.enabledModels.length - 1 : undefined);
          }
        }}
      >
        <Sparkles size={17} aria-hidden="true" />
        <span className="model-select-label">
          {hasModels ? <>Model: <strong>{label}</strong></> : <strong>No models connected</strong>}
        </span>
        {hasModels && <ChevronDown size={16} aria-hidden="true" />}
      </button>
      {open && hasModels && (
        <div className="model-menu">
          <div id={listId} role="listbox" aria-label="Select model" onKeyDown={onListKeyDown}>
            {chat.enabledModels.map((model) => (
              <button
                ref={(node) => { if (node) optionRefs.current.set(model.id, node); else optionRefs.current.delete(model.id); }}
                key={model.id}
                id={`${listId}-${model.id}`}
                type="button"
                role="option"
                tabIndex={model.id === active?.id ? 0 : -1}
                aria-selected={model.id === chat.model}
                className={`model-option ${model.id === chat.model ? "is-selected" : ""}`}
                onFocus={() => setActiveId(model.id)}
                onMouseEnter={() => setActiveId(model.id)}
                onClick={() => { chat.setModel(model.id); close(); }}
              >
                <span><strong>{model.name}</strong><small>{model.provider_name}</small></span>
                <span className="model-option-indicators" aria-hidden="true">
                  {model.id === chat.defaultModelId && <Star size={13} fill="currentColor" />}
                  {model.id === chat.model && <Check size={16} />}
                </span>
              </button>
            ))}
          </div>
          {active && (
            <button
              type="button"
              className={`model-default-action ${active.id === chat.defaultModelId ? "is-default" : ""}`}
              aria-label={`Set ${active.name} as default model`}
              aria-pressed={active.id === chat.defaultModelId}
              onClick={() => { chat.setDefaultModel(active.id); close(); }}
            >
              <Star size={14} fill={active.id === chat.defaultModelId ? "currentColor" : "none"} aria-hidden="true" />
              <span>{active.id === chat.defaultModelId ? "Default for new chats" : "Use as default for new chats"}<small>{active.name}</small></span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
