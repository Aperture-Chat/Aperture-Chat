import { SelectControl } from "./SelectControl";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bot,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Copy,
  FileText,
  Globe2,
  History,
  MessageSquare,
  Newspaper,
  PenLine,
  Play,
  Plus,
  Search,
  Trash2,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import type { Automation, AutomationRunRecord, AutomationRunResult, BootstrapData, ModelConfig } from "../lib/types";
import {
  createAutomation,
  deleteAutomation,
  previewAutomationSchedule,
  runAutomation,
  updateAutomation,
  type AutomationSavePayload,
} from "../lib/api";
import { approvedWorkspaceModels, isAgentProfile, visibleAgentProfiles } from "../lib/modelAccess";
import { StableLabel, Toggle } from "./Primitives";
import { OverflowMenu } from "./AgentWorkspaceConsole";

type StepDraft = { model_id: string; instruction: string };

type FormState = {
  name: string;
  surface: "chat" | "draft";
  trigger_type: "once" | "daily" | "weekly" | "cron";
  run_at: string;
  weekly_day: string;
  time_of_day: string;
  cron_expression: string;
  timezone: string;
  prompt: string;
  steps: StepDraft[];
  enabled: boolean;
};

type StepOption = { id: string; label: string; agent: boolean };

type Filter = "all" | "active" | "paused" | "attention";

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

type Recipe = {
  key: string;
  name: string;
  summary: string;
  icon: LucideIcon;
  form: Partial<FormState>;
  instructions: string[];
};

/** Starting points for the empty state. They only pre-fill the editor. */
const RECIPES: Recipe[] = [
  {
    key: "news",
    name: "Morning news brief",
    summary: "Every weekday morning, the five developments that matter in your field, with sources.",
    icon: Newspaper,
    form: {
      name: "Morning news brief",
      trigger_type: "cron",
      cron_expression: "30 7 * * 1-5",
      surface: "chat",
      prompt:
        "Summarize the five most important developments from the last 24 hours in [your industry]. One bullet each, with why it matters and a source link.",
    },
    instructions: [""],
  },
  {
    key: "watch",
    name: "Weekly competitor watch",
    summary: "Monday recap of public news about the companies you track.",
    icon: Search,
    form: {
      name: "Weekly competitor watch",
      trigger_type: "weekly",
      weekly_day: "monday",
      time_of_day: "08:00",
      surface: "chat",
      prompt:
        "Report notable public news from the past week about [company names]: product launches, pricing, leadership, partnerships. Group by company and cite sources.",
    },
    instructions: [""],
  },
  {
    key: "research",
    name: "Research, then polish",
    summary: "A two-step chain: gather facts with one model, then rewrite as an executive summary.",
    icon: Workflow,
    form: {
      name: "Research, then polish",
      trigger_type: "weekly",
      weekly_day: "friday",
      time_of_day: "15:00",
      surface: "draft",
      prompt: "[Your research question]",
    },
    instructions: [
      "Research the question thoroughly. List the key facts, figures, and open questions, each with a source.",
      "Rewrite the research as a polished executive summary under 300 words with a title, a one-line takeaway, and three recommendations.",
    ],
  },
  {
    key: "agent",
    name: "Weekly digest from an agent",
    summary: "Pick one of your agents as the step so its instructions and knowledge shape the result.",
    icon: Bot,
    form: {
      name: "Weekly knowledge digest",
      trigger_type: "weekly",
      weekly_day: "friday",
      time_of_day: "16:00",
      surface: "draft",
      prompt: "Summarize what matters most in our knowledge sources for [team] this week, with citations.",
    },
    instructions: [""],
  },
];

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function timeZoneOptions(current: string): string[] {
  let zones: string[] = [];
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    zones = supported ? supported("timeZone") : [];
  } catch {
    zones = [];
  }
  return Array.from(new Set(["UTC", browserTimeZone(), current, ...zones].filter(Boolean)));
}

function cap(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function clockLabel(time: string | null | undefined): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec((time ?? "").trim());
  if (!match) return time ?? "";
  const hour = Number(match[1]);
  const minute = match[2];
  const suffix = hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${minute} ${suffix}`;
}

function zoneLabel(zone: string | null | undefined): string {
  if (!zone || zone === "UTC") return "UTC";
  return zone.replace(/_/g, " ");
}

/** Plain-language schedule, e.g. "Every Monday at 9:00 AM · America/Chicago". */
export function scheduleSummary(automation: Pick<Automation, "trigger_type" | "time_of_day" | "weekly_day" | "run_at" | "cron_expression" | "timezone">): string {
  const zone = zoneLabel(automation.timezone);
  if (automation.trigger_type === "daily") {
    return `Every day at ${clockLabel(automation.time_of_day) || "a chosen time"} · ${zone}`;
  }
  if (automation.trigger_type === "weekly") {
    const day = automation.weekly_day ? cap(automation.weekly_day) : "week";
    return `Every ${day} at ${clockLabel(automation.time_of_day) || "a chosen time"} · ${zone}`;
  }
  if (automation.trigger_type === "once") {
    if (!automation.run_at) return "Once · time not set";
    const [date, time] = automation.run_at.split("T");
    return `Once on ${date}${time ? ` at ${clockLabel(time.slice(0, 5))}` : ""} · ${zone}`;
  }
  if (!automation.cron_expression) return "Custom schedule · expression not set";
  const described = describeCron(automation.cron_expression);
  return `${described ?? `Custom schedule (${automation.cron_expression})`} · ${zone}`;
}

const CRON_DAYS: Record<string, string> = {
  "0": "Sunday", "1": "Monday", "2": "Tuesday", "3": "Wednesday", "4": "Thursday", "5": "Friday", "6": "Saturday", "7": "Sunday",
  sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday",
};

/** Plain words for the common cron shapes; null means "show the expression". */
export function describeCron(expression: string): string | null {
  const parts = expression.trim().toLowerCase().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const everyMinutes = /^\*\/(\d+)$/.exec(minute);
  if (everyMinutes && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Every ${everyMinutes[1]} minutes`;
  }
  if (!/^\d{1,2}$/.test(minute) || month !== "*") return null;
  if (hour === "*" && dayOfMonth === "*" && dayOfWeek === "*") return `Every hour at :${minute.padStart(2, "0")}`;
  if (!/^\d{1,2}$/.test(hour)) return null;
  const at = clockLabel(`${hour}:${minute.padStart(2, "0")}`);
  if (dayOfMonth === "*") {
    if (dayOfWeek === "*") return `Every day at ${at}`;
    if (dayOfWeek === "1-5" || dayOfWeek === "mon-fri") return `Weekdays at ${at}`;
    if (["0,6", "6,0", "sat,sun", "sun,sat", "6,7"].includes(dayOfWeek)) return `Weekends at ${at}`;
    const days = dayOfWeek.split(",").map((day) => CRON_DAYS[day]);
    if (days.every(Boolean)) {
      const names = days.join(days.length === 2 ? " and " : ", ");
      return `Every ${names} at ${at}`;
    }
    return null;
  }
  if (/^\d{1,2}$/.test(dayOfMonth) && dayOfWeek === "*") return `Monthly on day ${dayOfMonth} at ${at}`;
  return null;
}

function formatInstant(iso: string, timeZone?: string | null): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timeZone || undefined,
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

function relativeTime(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 60) return format.format(Math.round(seconds), "second");
  if (abs < 3600) return format.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return format.format(Math.round(seconds / 3600), "hour");
  return format.format(Math.round(seconds / 86400), "day");
}

function emptyForm(defaultModelId: string): FormState {
  return {
    name: "",
    surface: "chat",
    trigger_type: "weekly",
    run_at: "",
    weekly_day: "monday",
    time_of_day: "09:00",
    cron_expression: "",
    timezone: browserTimeZone(),
    prompt: "",
    steps: [{ model_id: defaultModelId, instruction: "" }],
    enabled: true,
  };
}

/** Shared fields for both create and edit; `enabled` is handled per-caller. */
function formToFields(form: FormState): Omit<AutomationSavePayload, "enabled"> {
  return {
    name: form.name.trim(),
    surface: form.surface,
    trigger_type: form.trigger_type,
    run_at: form.trigger_type === "once" ? form.run_at || null : null,
    weekly_day: form.trigger_type === "weekly" ? form.weekly_day : null,
    time_of_day:
      form.trigger_type === "weekly" || form.trigger_type === "daily" ? form.time_of_day : null,
    cron_expression: form.trigger_type === "cron" ? form.cron_expression.trim() || null : null,
    timezone: form.timezone || null,
    prompt: form.prompt,
    steps: form.steps.map((step) => ({ model_id: step.model_id, instruction: step.instruction })),
  };
}

function formFromAutomation(automation: Automation, fallbackModelId: string): FormState {
  return {
    name: automation.name,
    surface: automation.surface,
    trigger_type: automation.trigger_type,
    run_at: (automation.run_at ?? "").slice(0, 16),
    weekly_day: automation.weekly_day ?? "monday",
    time_of_day: automation.time_of_day ?? "09:00",
    cron_expression: automation.cron_expression ?? "",
    // A record saved before time zones existed runs in UTC; keep it there
    // until someone deliberately picks another zone.
    timezone: automation.timezone ?? "UTC",
    prompt: automation.prompt,
    steps:
      automation.steps.length > 0
        ? automation.steps.map((step) => ({ model_id: step.model_id, instruction: step.instruction }))
        : [{ model_id: fallbackModelId, instruction: "" }],
    enabled: automation.enabled,
  };
}

function automationState(automation: Automation): { label: string; tone: "ok" | "warn" | "danger" | "muted" } {
  const status = automation.last_run_status ?? "";
  if (!automation.enabled && /paused after/.test(status)) return { label: "Paused after failures", tone: "danger" };
  if (status.startsWith("failed")) return { label: automation.enabled ? "Last run failed" : "Paused · last run failed", tone: "warn" };
  if (!automation.enabled) return { label: "Paused", tone: "muted" };
  return { label: "Active", tone: "ok" };
}

export function AutomationsConsole({
  data,
  actorUserId,
  onDataChange,
  sectionTabs,
  onOpenThread,
  onOpenDraft,
}: {
  data: BootstrapData;
  actorUserId: string;
  onDataChange: (updater: (current: BootstrapData) => BootstrapData) => void;
  sectionTabs?: ReactNode;
  onOpenThread?: (threadId: string) => void;
  onOpenDraft?: (draftId: string) => void;
}) {
  const stepOptions = useMemo(() => automationStepOptions(data), [data]);
  const defaultModelId = stepOptions.find((option) => !option.agent)?.id ?? stepOptions[0]?.id ?? "";
  const automations = data.automations ?? [];
  const [showForm, setShowForm] = useState(false);
  // null while creating; an automation id while editing an existing one.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => emptyForm(defaultModelId));
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "warning" | "danger"; message: string } | null>(null);
  const [runResults, setRunResults] = useState<Record<string, AutomationRunResult>>({});
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [preview, setPreview] = useState<{ state: "idle" | "loading" | "ready" | "error"; error?: string | null; runs?: string[] }>({ state: "idle" });

  const noModels = stepOptions.length === 0;
  const zones = useMemo(() => timeZoneOptions(form.timezone), [form.timezone]);

  // Live schedule preview from the scheduler's own math (debounced).
  useEffect(() => {
    if (!showForm) return;
    const schedule = {
      trigger_type: form.trigger_type,
      run_at: form.trigger_type === "once" ? form.run_at || null : null,
      weekly_day: form.trigger_type === "weekly" ? form.weekly_day : null,
      time_of_day: form.trigger_type === "weekly" || form.trigger_type === "daily" ? form.time_of_day : null,
      cron_expression: form.trigger_type === "cron" ? form.cron_expression.trim() || null : null,
      timezone: form.timezone || null,
    };
    let cancelled = false;
    setPreview((current) => ({ ...current, state: "loading" }));
    const timer = window.setTimeout(() => {
      previewAutomationSchedule(actorUserId, schedule)
        .then((result) => {
          if (cancelled || !result) return;
          setPreview(
            result.valid
              ? { state: "ready", runs: result.next_runs, error: null }
              : { state: "error", error: result.error, runs: [] },
          );
        })
        .catch(() => {
          if (!cancelled) setPreview({ state: "idle" });
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [actorUserId, form.cron_expression, form.run_at, form.time_of_day, form.timezone, form.trigger_type, form.weekly_day, showForm]);

  function patchAutomations(updater: (list: Automation[]) => Automation[]) {
    onDataChange((current) => ({ ...current, automations: updater(current.automations ?? []) }));
  }

  function updateStep(index: number, patch: Partial<StepDraft>) {
    setForm((current) => ({
      ...current,
      steps: current.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    }));
  }

  function moveStep(index: number, delta: number) {
    setForm((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.steps.length) return current;
      const steps = [...current.steps];
      [steps[index], steps[target]] = [steps[target], steps[index]];
      return { ...current, steps };
    });
  }

  function openCreate(recipe?: Recipe) {
    setEditingId(null);
    const base = emptyForm(defaultModelId);
    const agentId = stepOptions.find((option) => option.agent)?.id;
    setForm(
      recipe
        ? {
            ...base,
            ...recipe.form,
            steps: recipe.instructions.map((instruction) => ({
              model_id: recipe.key === "agent" && agentId ? agentId : defaultModelId,
              instruction,
            })),
          }
        : base,
    );
    setNotice(null);
    setOpenMenu(null);
    setShowForm(true);
  }

  function openEdit(automation: Automation) {
    setEditingId(automation.id);
    setForm(formFromAutomation(automation, defaultModelId));
    setNotice(null);
    setOpenMenu(null);
    setShowForm(true);
  }

  function openDuplicate(automation: Automation) {
    setEditingId(null);
    setForm({ ...formFromAutomation(automation, defaultModelId), name: `${automation.name} (copy)`, enabled: false });
    setNotice({ tone: "success", message: `Editing a copy of “${automation.name}”. It is not saved until you save it.` });
    setOpenMenu(null);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
  }

  async function handleSave() {
    if (!form.name.trim()) {
      setNotice({ tone: "warning", message: "Give the automation a name." });
      return;
    }
    if (form.steps.some((step) => !step.model_id)) {
      setNotice({ tone: "warning", message: "Every step needs a model or agent." });
      return;
    }
    if (form.trigger_type === "once" && !form.run_at) {
      setNotice({ tone: "warning", message: "Choose a date and time for the one-time run." });
      return;
    }
    setPending("save");
    try {
      if (editingId) {
        // Partial update: `enabled` is sent only when the switch changed, so
        // editing never silently pauses or resumes a running automation.
        const original = automations.find((item) => item.id === editingId);
        const payload = original && original.enabled !== form.enabled
          ? { ...formToFields(form), enabled: form.enabled }
          : formToFields(form);
        const updated = await updateAutomation(actorUserId, editingId, payload);
        patchAutomations((list) => list.map((item) => (item.id === editingId ? updated : item)));
        setNotice({ tone: "success", message: `Automation “${updated.name}” updated.` });
      } else {
        const created = await createAutomation(actorUserId, { ...formToFields(form), enabled: form.enabled });
        patchAutomations((list) => [created, ...list]);
        setNotice({
          tone: "success",
          message: created.enabled
            ? `Automation “${created.name}” saved and scheduled.`
            : `Automation “${created.name}” saved. It is paused until you turn it on.`,
        });
      }
      closeForm();
    } catch (error) {
      setNotice({ tone: "danger", message: `Could not save: ${errorText(error)}` });
    } finally {
      setPending(null);
    }
  }

  async function handleToggle(automation: Automation, enabled: boolean) {
    setPending(`toggle-${automation.id}`);
    try {
      const updated = await updateAutomation(actorUserId, automation.id, { enabled });
      patchAutomations((list) => list.map((item) => (item.id === automation.id ? updated : item)));
    } catch (error) {
      setNotice({ tone: "danger", message: `Could not update “${automation.name}”: ${errorText(error)}` });
    } finally {
      setPending(null);
    }
  }

  async function handleDelete(automation: Automation) {
    setOpenMenu(null);
    if (!window.confirm(`Delete “${automation.name}”? Its schedule stops and its run history is removed.`)) return;
    setPending(`delete-${automation.id}`);
    try {
      await deleteAutomation(actorUserId, automation.id);
      patchAutomations((list) => list.filter((item) => item.id !== automation.id));
      setRunResults((current) => {
        const next = { ...current };
        delete next[automation.id];
        return next;
      });
      setNotice({ tone: "success", message: `“${automation.name}” was deleted.` });
    } catch (error) {
      setNotice({ tone: "danger", message: `Could not delete: ${errorText(error)}` });
    } finally {
      setPending(null);
    }
  }

  async function handleRun(automation: Automation) {
    setPending(`run-${automation.id}`);
    setNotice(null);
    try {
      const result = await runAutomation(actorUserId, automation.id, { deliver: true });
      setRunResults((current) => ({ ...current, [automation.id]: result }));
      patchAutomations((list) => list.map((item) => (item.id === automation.id ? result.automation : item)));
      const where = result.draft_id ? "a new draft" : result.thread_id ? "a new chat" : null;
      setNotice({
        tone: "success",
        message: `“${automation.name}” ran ${result.transcript.length} step(s)${where ? ` and saved the result to ${where}` : ""}.`,
      });
    } catch (error) {
      setNotice({ tone: "danger", message: `Run failed: ${errorText(error)}` });
    } finally {
      setPending(null);
    }
  }

  const counts = {
    active: automations.filter((item) => item.enabled).length,
    paused: automations.filter((item) => !item.enabled).length,
    attention: automations.filter((item) => ["warn", "danger"].includes(automationState(item).tone)).length,
  };
  useEffect(() => {
    if (filter !== "all" && counts[filter] === 0) setFilter("all");
  }, [counts, filter]);
  const normalizedQuery = query.trim().toLowerCase();
  const visible = automations.filter((item) => {
    if (filter === "active" && !item.enabled) return false;
    if (filter === "paused" && item.enabled) return false;
    if (filter === "attention" && !["warn", "danger"].includes(automationState(item).tone)) return false;
    if (!normalizedQuery) return true;
    return `${item.name} ${item.prompt}`.toLowerCase().includes(normalizedQuery);
  });

  const noticeBanner = notice && (
    <div className={`ws-notice is-${notice.tone}`} role="status">
      {notice.tone === "success" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
      <span>{notice.message}</span>
      <button className="icon-button" type="button" aria-label="Dismiss notification" onClick={() => setNotice(null)}>
        <X size={14} />
      </button>
    </div>
  );

  return (
    <div className="console-page automations-page">
      <header className="console-header">
        <div>
          <h1>Automations</h1>
          <p>
            Run a prompt through one or more models or agents on a schedule. Each run's result arrives as a new
            chat or draft, and every run is recorded.
          </p>
        </div>
        {sectionTabs}
      </header>

      {noticeBanner}

      {noModels && (
        <div className="ws-notice is-warning">
          <AlertTriangle size={16} />
          <span>
            No approved models are available yet. An administrator must enable at least one available model before
            automations can run.
          </span>
        </div>
      )}

      {showForm ? (
        <AutomationEditor
          form={form}
          setForm={setForm}
          editing={Boolean(editingId)}
          stepOptions={stepOptions}
          zones={zones}
          preview={preview}
          pending={pending === "save"}
          onUpdateStep={updateStep}
          onMoveStep={moveStep}
          onSave={() => void handleSave()}
          onCancel={closeForm}
        />
      ) : automations.length === 0 ? (
        <div className="ws-empty">
          <span className="ws-empty-icon"><CalendarClock size={24} /></span>
          <h2>Put recurring work on autopilot</h2>
          <p>
            An automation runs your prompt through one or more models or agents on a schedule, then saves the
            result as a new chat or draft. Start from a recipe or from scratch.
          </p>
          <div className="ws-empty-actions">
            <button className="primary-button compact-button" type="button" disabled={noModels} onClick={() => openCreate()}>
              <Plus size={16} /> New automation
            </button>
          </div>
          {!noModels && (
            <div className="ws-starters" role="group" aria-label="Automation recipes">
              {RECIPES.map((recipe) => (
                <button key={recipe.key} type="button" className="ws-starter" onClick={() => openCreate(recipe)}>
                  <span className="ws-starter-icon"><recipe.icon size={16} /></span>
                  <span>
                    <strong>{recipe.name}</strong>
                    <small>{recipe.summary}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="ws-toolbar">
            <label className="ws-search">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                value={query}
                placeholder="Search automations"
                aria-label="Search automations"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="ws-chips" role="group" aria-label="Filter automations">
              <button type="button" className="ws-chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
                All <span className="ws-chip-count">{automations.length}</span>
              </button>
              {counts.active > 0 && counts.paused > 0 && (
                <>
                  <button type="button" className="ws-chip" aria-pressed={filter === "active"} onClick={() => setFilter("active")}>
                    Active <span className="ws-chip-count">{counts.active}</span>
                  </button>
                  <button type="button" className="ws-chip" aria-pressed={filter === "paused"} onClick={() => setFilter("paused")}>
                    Paused <span className="ws-chip-count">{counts.paused}</span>
                  </button>
                </>
              )}
              {counts.attention > 0 && (
                <button type="button" className="ws-chip" aria-pressed={filter === "attention"} onClick={() => setFilter("attention")}>
                  <AlertTriangle size={13} /> Needs attention <span className="ws-chip-count">{counts.attention}</span>
                </button>
              )}
            </div>
            <div className="ws-toolbar-actions">
              <button
                className="primary-button compact-button"
                type="button"
                disabled={noModels}
                data-tooltip="Create a scheduled run with one or more model or agent steps"
                onClick={() => openCreate()}
              >
                <Plus size={16} /> New automation
              </button>
            </div>
          </div>
          {visible.length === 0 ? (
            <p className="ws-no-results">No automations match your search.</p>
          ) : (
            <div className="automation-stack">
              {visible.map((automation) => (
                <AutomationCard
                  key={automation.id}
                  automation={automation}
                  data={data}
                  result={runResults[automation.id]}
                  pending={pending}
                  openMenu={openMenu}
                  setOpenMenu={setOpenMenu}
                  onToggle={(next) => void handleToggle(automation, next)}
                  onRun={() => void handleRun(automation)}
                  onEdit={() => openEdit(automation)}
                  onDuplicate={() => openDuplicate(automation)}
                  onDelete={() => void handleDelete(automation)}
                  onOpenThread={onOpenThread}
                  onOpenDraft={onOpenDraft}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AutomationCard({
  automation,
  data,
  result,
  pending,
  openMenu,
  setOpenMenu,
  onToggle,
  onRun,
  onEdit,
  onDuplicate,
  onDelete,
  onOpenThread,
  onOpenDraft,
}: {
  automation: Automation;
  data: BootstrapData;
  result?: AutomationRunResult;
  pending: string | null;
  openMenu: string | null;
  setOpenMenu: (value: string | null) => void;
  onToggle: (next: boolean) => void;
  onRun: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onOpenThread?: (threadId: string) => void;
  onOpenDraft?: (draftId: string) => void;
}) {
  const state = automationState(automation);
  const history = automation.run_history ?? [];
  const lastRun = history[0];
  const running = pending === `run-${automation.id}`;
  const lastError = lastRun?.status === "failed" ? lastRun.detail : automation.last_run_status?.startsWith("failed")
    ? automation.last_run_status.replace(/^failed:\s*/, "")
    : null;
  return (
    <article className={`ws-card automation-card-2 ${state.tone === "warn" || state.tone === "danger" ? "is-attention" : ""} ${!automation.enabled ? "is-muted" : ""}`} aria-label={automation.name}>
      <div className="ws-card-head">
        <span className="ws-card-icon" aria-hidden="true">
          {automation.surface === "draft" ? <FileText size={18} /> : <MessageSquare size={18} />}
        </span>
        <div>
          <h3 className="ws-card-title">{automation.name}</h3>
          <p className="ws-card-meta">
            <span className={`ws-badge is-${state.tone}`}>{state.label}</span>
            {" · "}Delivers to {automation.surface === "draft" ? "a new draft" : "a new chat"}
          </p>
        </div>
        <div className="automation-card-controls">
          <Toggle
            checked={automation.enabled}
            disabled={pending === `toggle-${automation.id}`}
            label={`Enable ${automation.name}`}
            tooltip={
              automation.enabled
                ? `Pause ${automation.name} so its schedule stops running`
                : `Turn on ${automation.name} so it runs on its schedule`
            }
            onChange={onToggle}
          />
        </div>
      </div>
      <div className="ws-card-body">
        <div className="automation-when">
          <span><CalendarClock size={14} /> {scheduleSummary(automation)}</span>
          {automation.enabled && automation.next_run_at && (
            <span className="is-next" title={automation.next_run_at}>
              <ChevronRight size={14} /> Next run {relativeTime(automation.next_run_at)} ·{" "}
              {formatInstant(automation.next_run_at, automation.timezone)}
            </span>
          )}
        </div>
        <ol className="automation-chain" aria-label={`${automation.name} steps`}>
          {automation.steps.map((step, index) => {
            const model = data.models.find((item) => item.id === step.model_id);
            const agent = model ? isAgentProfile(model) : false;
            return (
              <li key={`${step.model_id}-${index}`}>
                {index > 0 && <ArrowRight size={14} className="automation-chain-arrow" aria-hidden="true" />}
                <span className={`automation-chain-step ${agent ? "is-agent" : ""}`} title={step.instruction || undefined}>
                  <span className="automation-chain-num">{index + 1}</span>
                  {agent && <Bot size={13} aria-label="Agent" />}
                  <span>{model?.name ?? step.model_id}</span>
                </span>
              </li>
            );
          })}
        </ol>
        {(lastRun || automation.last_run_at) && (
          <div className="automation-lastrun">
            <span>
              Last run{" "}
              {(lastRun?.status ?? (automation.last_run_status?.startsWith("failed") ? "failed" : "succeeded")) === "succeeded"
                ? "succeeded"
                : lastRun?.status === "skipped"
                  ? "was skipped"
                  : "failed"}{" "}
              {relativeTime(lastRun?.at ?? automation.last_run_at ?? "")}
              {lastRun ? ` · ${triggerLabel(lastRun.trigger)}` : ""}
            </span>
            <ResultLink record={lastRun} onOpenThread={onOpenThread} onOpenDraft={onOpenDraft} />
          </div>
        )}
        {lastError && <p className="automation-error">{lastError}</p>}
        {result && (
          <details className="automation-disclosure" open>
            <summary><ChevronRight size={14} /> Output from this run</summary>
            <div className="automation-output">
              {result.transcript.map((entry) => (
                <div className="automation-output-step" key={entry.step}>
                  <strong>
                    Step {entry.step} · {entry.model_name}
                    {entry.agent ? " (agent)" : ""}
                    {entry.knowledge_sources?.length ? ` · ${entry.knowledge_sources.length} knowledge source${entry.knowledge_sources.length === 1 ? "" : "s"}` : ""}
                    {entry.truncated ? " · cut off at its token limit" : ""}
                  </strong>
                  <p>{entry.output}</p>
                </div>
              ))}
            </div>
          </details>
        )}
        {history.length > 0 && (
          <details className="automation-disclosure">
            <summary><History size={14} /> Run history ({history.length})</summary>
            <ul className="automation-history">
              {history.map((record, index) => (
                <li key={`${record.at}-${index}`}>
                  <time dateTime={record.at} title={record.at}>{formatInstant(record.at)}</time>
                  <span className="detail">
                    <span className={`ws-badge ${record.status === "succeeded" ? "is-ok" : record.status === "skipped" ? "is-muted" : "is-danger"}`}>
                      {cap(record.status)}
                    </span>{" "}
                    · {triggerLabel(record.trigger)}
                    {record.duration_ms != null ? ` · ${formatDuration(record.duration_ms)}` : ""}
                    {record.detail ? ` · ${record.detail}` : ""}
                  </span>
                  <ResultLink record={record} onOpenThread={onOpenThread} onOpenDraft={onOpenDraft} />
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <div className="ws-card-foot">
        <button
          className="secondary-button compact-button"
          type="button"
          disabled={running}
          data-tooltip={`Run ${automation.name} now and save the result, without waiting for its schedule`}
          onClick={onRun}
        >
          <Play size={14} /> {running ? "Running…" : "Run now"}
        </button>
        <button
          className="secondary-button compact-button"
          type="button"
          aria-label={`Edit ${automation.name}`}
          data-tooltip={`Change ${automation.name}'s schedule, prompt, or steps`}
          onClick={onEdit}
        >
          <PenLine size={14} /> Edit
        </button>
        <span className="ws-spacer" />
        <OverflowMenu
          id={`automation:${automation.id}`}
          label={`More actions for ${automation.name}`}
          openMenu={openMenu}
          setOpenMenu={setOpenMenu}
          up
        >
          <button type="button" role="menuitem" onClick={onDuplicate}>
            <Copy size={15} /> Duplicate
          </button>
          <button
            type="button"
            role="menuitem"
            className="is-danger"
            aria-label={`Delete ${automation.name}`}
            disabled={pending === `delete-${automation.id}`}
            onClick={onDelete}
          >
            <Trash2 size={15} /> Delete
          </button>
        </OverflowMenu>
      </div>
    </article>
  );
}

function ResultLink({
  record,
  onOpenThread,
  onOpenDraft,
}: {
  record?: AutomationRunRecord;
  onOpenThread?: (threadId: string) => void;
  onOpenDraft?: (draftId: string) => void;
}) {
  if (record?.thread_id && onOpenThread) {
    const threadId = record.thread_id;
    return (
      <button type="button" className="link-button" onClick={() => onOpenThread(threadId)}>
        <MessageSquare size={13} /> Open chat
      </button>
    );
  }
  if (record?.draft_id && onOpenDraft) {
    const draftId = record.draft_id;
    return (
      <button type="button" className="link-button" onClick={() => onOpenDraft(draftId)}>
        <FileText size={13} /> Open draft
      </button>
    );
  }
  return <span />;
}

function AutomationEditor({
  form,
  setForm,
  editing,
  stepOptions,
  zones,
  preview,
  pending,
  onUpdateStep,
  onMoveStep,
  onSave,
  onCancel,
}: {
  form: FormState;
  setForm: (updater: (current: FormState) => FormState) => void;
  editing: boolean;
  stepOptions: StepOption[];
  zones: string[];
  preview: { state: "idle" | "loading" | "ready" | "error"; error?: string | null; runs?: string[] };
  pending: boolean;
  onUpdateStep: (index: number, patch: Partial<StepDraft>) => void;
  onMoveStep: (index: number, delta: number) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const hasAgentStep = form.steps.some((step) => stepOptions.find((option) => option.id === step.model_id)?.agent);
  return (
    <section className="automation-editor" aria-label={editing ? "Edit automation" : "New automation"}>
      <div className="automation-editor-head">
        <h2>{editing ? "Edit automation" : "New automation"}</h2>
        <button className="icon-button" type="button" aria-label="Close editor" onClick={onCancel}>
          <X size={16} />
        </button>
      </div>

      <div className="automation-editor-section">
        <header>
          <strong>What it does</strong>
          <p>The prompt is the first step's input. Later steps receive the previous step's output.</p>
        </header>
        <div className="automation-editor-fields">
          <label className="automation-field">
            Name
            <input
              value={form.name}
              placeholder="Monday client digest"
              onChange={(event) => setForm((c) => ({ ...c, name: event.target.value }))}
            />
          </label>
          <label className="automation-field">
            Prompt
            <textarea
              value={form.prompt}
              rows={3}
              placeholder="What should the first step work on?"
              onChange={(event) => setForm((c) => ({ ...c, prompt: event.target.value }))}
            />
          </label>
        </div>
      </div>

      <div className="automation-editor-section">
        <header>
          <strong>Steps</strong>
          <p>Choose a model or one of your agents for each step. Steps run in order.</p>
        </header>
        <div className="chain-editor">
          {form.steps.map((step, index) => (
            <div className="chain-editor-step" key={index}>
              <span className="chain-editor-num">{index + 1}</span>
              <div className="chain-editor-fields">
                <SelectControl
                  aria-label={`Step ${index + 1} model or agent`}
                  value={step.model_id}
                  onChange={(event) => onUpdateStep(index, { model_id: event.target.value })}
                >
                  {!stepOptions.some((option) => option.id === step.model_id) && (
                    <option value={step.model_id}>{step.model_id ? `${step.model_id} (unavailable)` : "Choose a model or agent"}</option>
                  )}
                  {stepOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.agent ? `${option.label} (agent)` : option.label}
                    </option>
                  ))}
                </SelectControl>
                <input
                  value={step.instruction}
                  aria-label={`Step ${index + 1} instruction`}
                  placeholder="Instruction for this step (optional)"
                  onChange={(event) => onUpdateStep(index, { instruction: event.target.value })}
                />
              </div>
              <div className="chain-editor-actions">
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Move step ${index + 1} up`}
                  disabled={index === 0}
                  onClick={() => onMoveStep(index, -1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Move step ${index + 1} down`}
                  disabled={index === form.steps.length - 1}
                  onClick={() => onMoveStep(index, 1)}
                >
                  <ArrowDown size={14} />
                </button>
                {form.steps.length > 1 && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove step ${index + 1}`}
                    data-tooltip={`Remove step ${index + 1} from the chain`}
                    onClick={() => setForm((c) => ({ ...c, steps: c.steps.filter((_, i) => i !== index) }))}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>
          ))}
          <div>
            <button
              type="button"
              className="secondary-button compact-button"
              data-tooltip="Add another step that receives the previous step's output"
              onClick={() =>
                setForm((c) => ({
                  ...c,
                  steps: [...c.steps, { model_id: c.steps[c.steps.length - 1]?.model_id ?? stepOptions[0]?.id ?? "", instruction: "" }],
                }))
              }
            >
              <Plus size={14} /> Add step
            </button>
          </div>
          {hasAgentStep && (
            <p className="chain-editor-note">
              Agent steps bring the agent's instructions, skills, and knowledge. Tools and MCP servers need a person to
              approve them, so they run only in chat.
            </p>
          )}
        </div>
      </div>

      <div className="automation-editor-section">
        <header>
          <strong>Schedule</strong>
          <p>Times are in the time zone you choose, including daylight-saving changes.</p>
        </header>
        <div className="automation-editor-fields">
          <div className="ws-segmented" role="group" aria-label="How often">
            {(
              [
                ["daily", "Daily"],
                ["weekly", "Weekly"],
                ["once", "Once"],
                ["cron", "Custom"],
              ] as Array<[FormState["trigger_type"], string]>
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={form.trigger_type === value}
                onClick={() => setForm((c) => ({ ...c, trigger_type: value }))}
              >
                {label}
              </button>
            ))}
          </div>
          {form.trigger_type === "weekly" && (
            <div className="weekday-picker" role="group" aria-label="Day of the week">
              {WEEKDAYS.map((day) => (
                <button
                  key={day}
                  type="button"
                  aria-pressed={form.weekly_day === day}
                  aria-label={cap(day)}
                  onClick={() => setForm((c) => ({ ...c, weekly_day: day }))}
                >
                  <span className="weekday-long" aria-hidden="true">{cap(day).slice(0, 3)}</span>
                  <span className="weekday-short" aria-hidden="true">{cap(day).slice(0, 1)}</span>
                </button>
              ))}
            </div>
          )}
          <div className="automation-field-row">
            {(form.trigger_type === "weekly" || form.trigger_type === "daily") && (
              <label className="automation-field">
                Time
                <input
                  type="time"
                  value={form.time_of_day}
                  onChange={(event) => setForm((c) => ({ ...c, time_of_day: event.target.value }))}
                />
              </label>
            )}
            {form.trigger_type === "once" && (
              <label className="automation-field">
                Run at
                <input
                  type="datetime-local"
                  value={form.run_at}
                  onChange={(event) => setForm((c) => ({ ...c, run_at: event.target.value }))}
                />
              </label>
            )}
            {form.trigger_type === "cron" && (
              <label className="automation-field">
                Cron expression
                <input
                  value={form.cron_expression}
                  placeholder="30 7 * * 1-5"
                  spellCheck={false}
                  onChange={(event) => setForm((c) => ({ ...c, cron_expression: event.target.value }))}
                />
              </label>
            )}
            <label className="automation-field">
              Time zone
              <SelectControl
                aria-label="Time zone"
                value={form.timezone}
                onChange={(event) => setForm((c) => ({ ...c, timezone: event.target.value }))}
              >
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zoneLabel(zone)}
                  </option>
                ))}
              </SelectControl>
            </label>
          </div>
          {form.trigger_type === "cron" && (
            <p className="chain-editor-note">
              Five fields: minute, hour, day of month, month, day of week. “30 7 * * 1-5” is 7:30 AM on weekdays.
            </p>
          )}
          <SchedulePreview preview={preview} timeZone={form.timezone} />
        </div>
      </div>

      <div className="automation-editor-section">
        <header>
          <strong>Deliver results to</strong>
          <p>Every run, scheduled or run now, saves its final output here and links it from the run history.</p>
        </header>
        <div className="automation-editor-fields">
          <div className="ws-segmented" role="group" aria-label="Deliver results to">
            <button type="button" aria-pressed={form.surface === "chat"} onClick={() => setForm((c) => ({ ...c, surface: "chat" }))}>
              <MessageSquare size={14} /> New chat
            </button>
            <button type="button" aria-pressed={form.surface === "draft"} onClick={() => setForm((c) => ({ ...c, surface: "draft" }))}>
              <FileText size={14} /> New draft
            </button>
          </div>
          <p className="chain-editor-note">
            {form.surface === "draft"
              ? "The last step is asked for a complete document, which is saved as a new draft you can edit and export."
              : "Each run appears as a new conversation in your chat list, ready for follow-up questions."}
          </p>
        </div>
      </div>

      <div className="automation-editor-foot">
        <span className="automation-activate">
          <Toggle
            checked={form.enabled}
            label="Run on this schedule"
            onChange={(enabled) => setForm((c) => ({ ...c, enabled }))}
          />
          {form.enabled ? "On — runs on this schedule" : "Paused — saved without running"}
        </span>
        <span className="ws-spacer" />
        <button className="secondary-button compact-button" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="primary-button compact-button"
          type="button"
          disabled={pending}
          onClick={onSave}
        >
          <StableLabel
            label={pending ? "Saving…" : editing ? "Save changes" : "Save automation"}
            reserve={["Saving…", "Save changes", "Save automation"]}
          />
        </button>
      </div>
    </section>
  );
}

function SchedulePreview({
  preview,
  timeZone,
}: {
  preview: { state: "idle" | "loading" | "ready" | "error"; error?: string | null; runs?: string[] };
  timeZone: string;
}) {
  if (preview.state === "error") {
    return (
      <div className="schedule-preview is-error" role="status">
        <span><AlertTriangle size={13} /> {preview.error}</span>
      </div>
    );
  }
  if (preview.state === "ready") {
    return (
      <div className="schedule-preview" role="status">
        <span><Globe2 size={13} /> {preview.runs?.length ? "Next runs" : "No upcoming runs — this time has passed."}</span>
        {preview.runs && preview.runs.length > 0 && (
          <ol>
            {preview.runs.map((run) => (
              <li key={run}>{formatInstant(run, timeZone)}</li>
            ))}
          </ol>
        )}
      </div>
    );
  }
  return null;
}

/** Steps can be any approved base model or any agent the viewer can use.
 * Agent visibility follows agent rules, not base-model group grants. */
function automationStepOptions(data: BootstrapData): StepOption[] {
  const connected = (model: ModelConfig) =>
    Boolean(data.providers.find((provider) => provider.id === model.provider_id)?.connected);
  const models = approvedWorkspaceModels(data)
    .filter((model) => !isAgentProfile(model))
    .map((model) => ({ id: model.id, label: model.name, agent: false }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const agents = visibleAgentProfiles(data)
    .filter(connected)
    .map((model) => ({ id: model.id, label: model.name, agent: true }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...agents, ...models];
}

function triggerLabel(trigger: string): string {
  if (trigger === "scheduled") return "on schedule";
  if (trigger === "chat") return "from chat";
  return "run now";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error.";
}
