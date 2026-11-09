import clsx from "clsx";
import {
  BookOpen,
  Bot,
  Briefcase,
  CalendarClock,
  ChevronLeft,
  FileText,
  LayoutGrid,
  MessageCircleQuestion,
  MessageSquare,
  PenLine,
  Plug,
  ScrollText,
  Search,
  type LucideIcon,
} from "lucide-react";

import type { RailSwitchOption } from "./RailSwitch";

export type SendMenuTab = "settings" | "resources";

export const SEND_MENU_TABS: RailSwitchOption<SendMenuTab>[] = [
  { value: "settings", label: "Reply settings" },
  { value: "resources", label: "Resources" },
];

/**
 * The Resources tab's categories. `section` is the heading the composer's
 * symbol menus group by; `label` is the plainer name this panel shows.
 */
export const RESOURCE_CATEGORIES = [
  { section: "Knowledge bases", label: "Knowledge bases", detail: "Document collections", icon: BookOpen },
  { section: "Files in knowledge sources", label: "Knowledge files", detail: "One saved document", icon: FileText },
  { section: "MCP connections", label: "Connections", detail: "Outside tools and apps", icon: Plug },
  { section: "Prompts", label: "Prompts", detail: "Saved wording to reuse", icon: MessageSquare },
  { section: "Agents", label: "Agents", detail: "Assistants for set tasks", icon: Bot },
  { section: "Skill files", label: "Skill files", detail: "Saved instructions", icon: ScrollText },
  { section: "Automations", label: "Automations", detail: "Run a saved routine", icon: CalendarClock },
] as const;

const ALL_RESOURCES_LABEL = "All resources";

export type ResourceSection = (typeof RESOURCE_CATEGORIES)[number]["section"];

/** What the Resources tab shows: the category tiles, everything, or one category. */
export type ResourceView = "tiles" | "all" | ResourceSection;

export function resourceListShows(view: ResourceView, section: string) {
  return view === "all" || view === section;
}

export function resourceViewLoadsKnowledgeFiles(view: ResourceView) {
  return view === "all" || view === "Knowledge bases" || view === "Files in knowledge sources";
}

export function resourceSectionLabel(section: string) {
  return RESOURCE_CATEGORIES.find((category) => category.section === section)?.label ?? section;
}

export function resourceSectionIcon(section: string): LucideIcon {
  return RESOURCE_CATEGORIES.find((category) => category.section === section)?.icon ?? BookOpen;
}

export function resourceViewTitle(view: Exclude<ResourceView, "tiles">, query: string) {
  if (query.trim()) return "Search results";
  return view === "all" ? ALL_RESOURCES_LABEL : resourceSectionLabel(view);
}

export function knowledgeOptionDetail({ available, on, baseName }: { available: boolean; on: boolean; baseName?: string }) {
  if (!available) return "No knowledge bases are set up yet.";
  return on && baseName ? `Using ${baseName}.` : "Answer from your knowledge bases.";
}

export function webOptionDetail(available: boolean) {
  return available ? "Look up current information online." : "Not available for this model.";
}

export function agentOptionDetail(agentName?: string) {
  return agentName ? `Using ${agentName}.` : "Let a specialized assistant answer.";
}

/** Where the chat is filed, in words. `waiting`: a new chat, linked once it is sent. */
export function matterOptionDetail({
  matterId,
  label,
  waiting = false,
  loading = false,
  error,
}: {
  matterId: string | null;
  label: string | null;
  waiting?: boolean;
  loading?: boolean;
  error?: string;
}) {
  if (error) return `Not filed: ${error}`;
  if (!matterId) return "Add a client-matter number.";
  if (!label) return loading ? "Filed under a matter." : "Filed under a matter you can no longer open.";
  return waiting ? `Filed under ${label} when you send.` : `Filed under ${label}.`;
}

/** Icon well, title, and one plain line: the anatomy every row and tile shares. */
export function OptionCopy({ icon: Icon, title, detail }: { icon: LucideIcon; title: string; detail: string }) {
  return (
    <>
      <span className="composer-option-well" aria-hidden="true"><Icon size={18} /></span>
      <span className="composer-option-copy"><strong>{title}</strong><small>{detail}</small></span>
    </>
  );
}

/** The state in words as well as color, so nobody has to judge a tint. */
function SwitchFace({ on }: { on: boolean }) {
  return <span className={clsx("composer-switch", on && "is-on")} aria-hidden="true"><b>{on ? "On" : "Off"}</b></span>;
}

export function ToolSwitch({
  icon,
  label,
  detail,
  checked,
  disabled = false,
  expanded,
  onToggle,
}: {
  icon: LucideIcon;
  label: string;
  detail: string;
  checked: boolean;
  disabled?: boolean;
  /** Set only for a tool that reveals a picker under its row. */
  expanded?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      aria-haspopup={expanded === undefined ? undefined : "true"}
      aria-expanded={expanded}
      className="composer-option-row"
      disabled={disabled}
      onClick={onToggle}
    >
      <OptionCopy icon={icon} title={label} detail={detail} />
      <SwitchFace on={checked} />
    </button>
  );
}

/** The Matter row: opens its chooser underneath, like Knowledge opens its list. */
export function MatterOptionRow({
  detail,
  filed,
  expanded,
  onToggle,
}: {
  detail: string;
  filed: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-haspopup="true"
      aria-expanded={expanded}
      className="composer-option-row composer-matter-row"
      onClick={onToggle}
    >
      <OptionCopy icon={Briefcase} title="Matter" detail={detail} />
      <span className="composer-option-action" aria-hidden="true">{filed ? "Change" : "Add"}</span>
    </button>
  );
}

/** A Reply settings switch: a real checkbox with a short name, explained beside it. */
function SettingSwitch({
  icon,
  title,
  detail,
  checked,
  onToggle,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="composer-option-row">
      <OptionCopy icon={icon} title={title} detail={detail} />
      <input className="composer-switch-input" type="checkbox" aria-label={title} checked={checked} onChange={onToggle} />
      <SwitchFace on={checked} />
    </label>
  );
}

export function StreamSwitch({ checked, onToggle }: { checked: boolean; onToggle: () => void }) {
  return (
    <SettingSwitch icon={PenLine} title="Stream replies" detail="Show the words as they are written." checked={checked} onToggle={onToggle} />
  );
}

/** Whether the assistant may stop to ask when a request could go several ways. */
export function AskSwitch({ checked, onToggle }: { checked: boolean; onToggle: () => void }) {
  return (
    <SettingSwitch
      icon={MessageCircleQuestion}
      title="Ask me when unclear"
      detail={checked ? "Ask first when a request is unclear." : "Decide, then say what was assumed."}
      checked={checked}
      onToggle={onToggle}
    />
  );
}

function ResourceTile({
  view,
  icon,
  label,
  detail,
  used = 0,
  onOpen,
}: {
  view: ResourceView;
  icon: LucideIcon;
  label: string;
  detail: string;
  used?: number;
  onOpen: (view: ResourceView) => void;
}) {
  return (
    <button
      type="button"
      className={clsx("composer-resource-tile", used > 0 && "is-active")}
      data-resource-tile={view}
      onClick={() => onOpen(view)}
    >
      <OptionCopy icon={icon} title={label} detail={used > 0 ? `${used} in use` : detail} />
    </button>
  );
}

/** One decision at a time: pick a category first, then pick from its list. */
export function ResourceTiles({
  inUse,
  onOpen,
}: {
  inUse: Partial<Record<ResourceSection, number>>;
  onOpen: (view: ResourceView) => void;
}) {
  return (
    <div className="composer-resource-tiles" role="group" aria-label="Resource categories">
      {RESOURCE_CATEGORIES.map(({ section, label, detail, icon }) => (
        <ResourceTile key={section} view={section} icon={icon} label={label} detail={detail} used={inUse[section]} onOpen={onOpen} />
      ))}
      <ResourceTile view="all" icon={LayoutGrid} label={ALL_RESOURCES_LABEL} detail="Everything in one list" onOpen={onOpen} />
    </div>
  );
}

export function ResourceSearch({ value, onChange }: { value: string; onChange: (query: string) => void }) {
  return (
    <div className="composer-resource-search">
      <Search size={18} aria-hidden="true" />
      <input
        aria-label="Find a resource"
        placeholder="Search by name…"
        value={value}
        onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function ShortcutGuide({ shortcuts }: { shortcuts: ReadonlyArray<{ symbol: string; label: string }> }) {
  return (
    <details
      className="composer-shortcut-guide"
      aria-label="Type shortcuts in chat"
      onToggle={(event) => { if (event.currentTarget.open) event.currentTarget.scrollIntoView({ block: "nearest" }); }}
    >
      <summary>Typing shortcuts</summary>
      <p>Type a symbol directly in the chat message box, then choose a resource. Add its name to narrow the list.</p>
      <dl>
        {shortcuts.map(({ symbol, label }) => (
          <div key={symbol}><dt><code>{symbol}</code></dt><dd>{label}</dd></div>
        ))}
      </dl>
      <p className="composer-shortcut-example">For example, type <code>@</code> in chat to find an agent.</p>
    </details>
  );
}

export function ResourceListHeader({ title, focusBack, onBack }: { title: string; focusBack: boolean; onBack: () => void }) {
  return (
    <div className="composer-resource-header">
      <button type="button" className="secondary-button" autoFocus={focusBack} onClick={onBack}>
        <ChevronLeft size={18} aria-hidden="true" />
        Back
      </button>
      <h3>{title}</h3>
    </div>
  );
}
