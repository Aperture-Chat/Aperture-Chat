import { Check, ChevronDown, Star } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import "./model-select.css";

type DraftModelOption = { id: string; name: string; providerName: string };

/** Focus previews a model; only explicit selection changes the draft's model.
 * Keep the default action outside the listbox so it is a real keyboard target. */
export function DraftModelMenu({
  agents,
  selectedAgent,
  defaultAgentId,
  unavailableReason = "Ask your admin to connect a model provider and grant access.",
  onSelect,
  onSetDefault,
}: {
  agents: DraftModelOption[];
  selectedAgent: DraftModelOption | undefined;
  defaultAgentId: string | null;
  unavailableReason?: string;
  onSelect: (agentId: string) => void;
  onSetDefault: (agentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const typeaheadRef = useRef({ text: "", at: 0 });
  const listId = useId();
  const hasAgents = agents.length > 0;
  // An unavailable saved favorite is not a current selection.
  const selected = agents.find((agent) => agent.id === selectedAgent?.id);
  const active = agents.find((agent) => agent.id === activeId) ?? selected ?? agents[0];
  const isOpen = open && hasAgents;

  function close(restoreFocus = true) {
    setOpen(false);
    typeaheadRef.current = { text: "", at: 0 };
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }

  function openPicker(index = Math.max(0, agents.findIndex((agent) => agent.id === selected?.id))) {
    if (!hasAgents) return;
    setActiveId(agents[index]?.id ?? agents[0].id);
    setOpen(true);
  }

  function focusOption(index: number) {
    const agent = agents[index];
    if (!agent) return;
    setActiveId(agent.id);
    optionRefs.current.get(agent.id)?.focus({ preventScroll: true });
    optionRefs.current.get(agent.id)?.scrollIntoView?.({ block: "nearest" });
  }

  useEffect(() => {
    if (!isOpen || !active) return;
    optionRefs.current.get(active.id)?.focus({ preventScroll: true });
  }, [isOpen, active?.id]);

  useEffect(() => {
    if (!hasAgents) setOpen(false);
    if (!isOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [isOpen, hasAgents]);

  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.altKey || event.metaKey || event.ctrlKey) return;
    const index = Math.max(0, agents.findIndex((agent) => agent.id === active?.id));
    let next: number | undefined;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (active) onSelect(active.id);
      close();
      return;
    }
    if (event.key === "ArrowDown") next = (index + 1) % agents.length;
    else if (event.key === "ArrowUp") next = (index - 1 + agents.length) % agents.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = agents.length - 1;
    else if (event.key.length === 1 && event.key !== " ") {
      const now = Date.now();
      const prior = now - typeaheadRef.current.at < 700 ? typeaheadRef.current.text : "";
      const typed = event.key.toLocaleLowerCase();
      const text = prior && [...prior].every((character) => character === typed) ? typed : prior + typed;
      typeaheadRef.current = { text, at: now };
      for (let offset = 1; offset <= agents.length; offset += 1) {
        const candidate = (index + offset) % agents.length;
        if (agents[candidate].name.toLocaleLowerCase().startsWith(text)) {
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
      className="model-select document-model-menu"
      ref={rootRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close(false);
      }}
      onKeyDown={(event) => {
        if (!isOpen || event.key !== "Escape" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        // Close the picker before Escape reaches any enclosing drawer or modal.
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <button
        ref={triggerRef}
        className={`select-button${hasAgents ? "" : " is-unavailable"}`}
        type="button"
        aria-haspopup="listbox"
        aria-controls={isOpen ? listId : undefined}
        aria-expanded={isOpen}
        aria-label="Document drafting model"
        aria-describedby={!hasAgents ? `${listId}-unavailable` : undefined}
        data-tooltip={hasAgents ? "Choose which AI model drafts and revises this document" : unavailableReason}
        disabled={!hasAgents}
        onClick={() => isOpen ? close() : openPicker()}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.altKey || event.metaKey || event.ctrlKey) return;
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            openPicker(event.key === "Home" ? 0 : event.key === "End" ? agents.length - 1 : undefined);
          }
        }}
      >
        <span className="model-select-label">
          {hasAgents ? <>Model: <strong>{selected?.name ?? "Choose a model"}</strong></> : <strong>No models connected</strong>}
        </span>
        {selected && selected.id === defaultAgentId && <Star size={13} fill="currentColor" aria-hidden="true" />}
        {hasAgents && <ChevronDown size={16} aria-hidden="true" />}
      </button>
      {!hasAgents && <span className="sr-only" id={`${listId}-unavailable`}>{unavailableReason}</span>}
      {isOpen && (
        <div className="model-menu">
          <div id={listId} role="listbox" aria-label="Select drafting model" onKeyDown={onListKeyDown}>
            {agents.map((agent) => (
              <button
                ref={(node) => { if (node) optionRefs.current.set(agent.id, node); else optionRefs.current.delete(agent.id); }}
                key={agent.id}
                type="button"
                role="option"
                tabIndex={agent.id === active?.id ? 0 : -1}
                aria-selected={agent.id === selected?.id}
                className={`model-option ${agent.id === selected?.id ? "is-selected" : ""}`}
                data-tooltip={`Draft and revise this document with ${agent.name}`}
                onFocus={() => setActiveId(agent.id)}
                onClick={() => { onSelect(agent.id); close(); }}
              >
                <span><strong>{agent.name}</strong><small>{agent.providerName}</small></span>
                <span className="model-option-indicators" aria-hidden="true">
                  {agent.id === defaultAgentId && <Star size={13} fill="currentColor" />}
                  {agent.id === selected?.id && <Check size={16} />}
                </span>
              </button>
            ))}
          </div>
          {active && (
            <button
              type="button"
              className={`model-default-action ${active.id === defaultAgentId ? "is-default" : ""}`}
              aria-label={`Set ${active.name} as default drafting model`}
              aria-pressed={active.id === defaultAgentId}
              onClick={() => { onSetDefault(active.id); close(); }}
            >
              <Star size={14} fill={active.id === defaultAgentId ? "currentColor" : "none"} aria-hidden="true" />
              <span>{active.id === defaultAgentId ? "Default for new drafts" : "Use as default for new drafts"}<small>{active.name}</small></span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
