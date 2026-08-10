import { SelectControl } from "./SelectControl";
import { useMemo, useState, type ReactNode } from "react";
import {
  CalendarClock,
  Check,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type { Automation, AutomationRunResult, BootstrapData } from "../lib/types";
import {
  createAutomation,
  deleteAutomation,
  runAutomation,
  updateAutomation,
  type AutomationSavePayload,
} from "../lib/api";
import { formatTimestamp } from "../lib/serverClock";
import { approvedWorkspaceModels } from "../lib/modelAccess";
import { Panel, Pill, StableLabel, Toggle } from "./Primitives";

type StepDraft = { model_id: string; instruction: string };

type FormState = {
  name: string;
  surface: "chat" | "draft";
  trigger_type: "once" | "daily" | "weekly" | "cron";
  run_at: string;
  weekly_day: string;
  time_of_day: string;
  cron_expression: string;
  prompt: string;
  steps: StepDraft[];
};

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function scheduleSummary(automation: Automation): string {
  if (automation.trigger_type === "daily") {
    return `Daily${automation.time_of_day ? ` at ${automation.time_of_day}` : ""}`;
  }
  if (automation.trigger_type === "weekly") {
    const day = automation.weekly_day ? cap(automation.weekly_day) : "a chosen day";
    return `Weekly · ${day}${automation.time_of_day ? ` at ${automation.time_of_day}` : ""}`;
  }
  if (automation.trigger_type === "once") {
    return automation.run_at ? `Once · ${automation.run_at}` : "Once · time not set";
  }
  return automation.cron_expression ? `Cron · ${automation.cron_expression}` : "Cron · expression not set";
}

function cap(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
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
    prompt: "",
    steps: [{ model_id: defaultModelId, instruction: "" }],
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
    prompt: form.prompt,
    steps: form.steps.map((step) => ({ model_id: step.model_id, instruction: step.instruction })),
  };
}

function formFromAutomation(automation: Automation, fallbackModelId: string): FormState {
  return {
    name: automation.name,
    surface: automation.surface,
    trigger_type: automation.trigger_type,
    run_at: automation.run_at ?? "",
    weekly_day: automation.weekly_day ?? "monday",
    time_of_day: automation.time_of_day ?? "09:00",
    cron_expression: automation.cron_expression ?? "",
    prompt: automation.prompt,
    steps:
      automation.steps.length > 0
        ? automation.steps.map((step) => ({ model_id: step.model_id, instruction: step.instruction }))
        : [{ model_id: fallbackModelId, instruction: "" }],
  };
}

export function AutomationsConsole({
  data,
  actorUserId,
  onDataChange,
  sectionTabs,
}: {
  data: BootstrapData;
  actorUserId: string;
  onDataChange: (updater: (current: BootstrapData) => BootstrapData) => void;
  sectionTabs?: ReactNode;
}) {
  const approvedModels = useMemo(() => approvedWorkspaceModels(data), [data]);
  const automations = data.automations ?? [];
  const [showForm, setShowForm] = useState(false);
  // null while creating; an automation id while editing an existing one.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => emptyForm(approvedModels[0]?.id ?? ""));
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "warning" | "danger"; message: string } | null>(null);
  const [runResults, setRunResults] = useState<Record<string, AutomationRunResult>>({});

  const noModels = approvedModels.length === 0;

  function patchAutomations(updater: (list: Automation[]) => Automation[]) {
    onDataChange((current) => ({ ...current, automations: updater(current.automations ?? []) }));
  }

  function updateStep(index: number, patch: Partial<StepDraft>) {
    setForm((current) => ({
      ...current,
      steps: current.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    }));
  }

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm(approvedModels[0]?.id ?? ""));
    setShowForm(true);
  }

  function openEdit(automation: Automation) {
    setEditingId(automation.id);
    setForm(formFromAutomation(automation, approvedModels[0]?.id ?? ""));
    setShowForm(true);
  }

  async function handleSave() {
    if (!form.name.trim()) {
      setNotice({ tone: "warning", message: "Give the automation a name." });
      return;
    }
    if (form.steps.some((step) => !step.model_id)) {
      setNotice({ tone: "warning", message: "Every step needs an approved model." });
      return;
    }
    setPending("save");
    try {
      if (editingId) {
        // Partial update: `enabled` is left untouched so editing never silently
        // pauses or resumes a running automation.
        const updated = await updateAutomation(actorUserId, editingId, formToFields(form));
        patchAutomations((list) => list.map((item) => (item.id === editingId ? updated : item)));
        setNotice({ tone: "success", message: `Automation “${updated.name}” updated.` });
      } else {
        const created = await createAutomation(actorUserId, { ...formToFields(form), enabled: false });
        patchAutomations((list) => [created, ...list]);
        setNotice({ tone: "success", message: `Automation “${created.name}” saved.` });
      }
      setShowForm(false);
      setEditingId(null);
      setForm(emptyForm(approvedModels[0]?.id ?? ""));
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
      setNotice({ tone: "danger", message: `Could not update: ${errorText(error)}` });
    } finally {
      setPending(null);
    }
  }

  async function handleDelete(automation: Automation) {
    setPending(`delete-${automation.id}`);
    try {
      await deleteAutomation(actorUserId, automation.id);
      patchAutomations((list) => list.filter((item) => item.id !== automation.id));
      setRunResults((current) => {
        const next = { ...current };
        delete next[automation.id];
        return next;
      });
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
      const result = await runAutomation(actorUserId, automation.id);
      setRunResults((current) => ({ ...current, [automation.id]: result }));
      patchAutomations((list) => list.map((item) => (item.id === automation.id ? result.automation : item)));
      setNotice({ tone: "success", message: `“${automation.name}” ran ${result.transcript.length} step(s).` });
    } catch (error) {
      setNotice({ tone: "danger", message: `Run failed: ${errorText(error)}` });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="console-page automations-page">
      <header className="console-header">
        <div>
          <h1>Agents</h1>
          <p>
            Schedule chat or drafting runs — single model or a multi-step chain — using models available to your
            organization.
          </p>
        </div>
        {sectionTabs}
        <button
          className="primary-button"
          type="button"
          disabled={noModels}
          data-tooltip="Create a scheduled chat or drafting run with one or more model steps"
          onClick={openCreate}
        >
          <Plus size={16} /> New automation
        </button>
      </header>

      <div className="automations-groundwork-note">
        <CalendarClock size={16} />
        <span>
          Enabled schedules run automatically in the background (times are UTC), and each scheduled run delivers
          its output as a new chat thread. Use <strong>Run now</strong> to execute a chain immediately.
        </span>
      </div>

      {noModels && (
        <p className="empty-hint">
          No approved models are available yet. An administrator must enable at least one available model before
          automations can run.
        </p>
      )}

      {notice && (
        <p className={`inline-notice inline-notice-${notice.tone}`} role="status">
          {notice.message}
        </p>
      )}

      {showForm && (
        <Panel
          title={editingId ? "Edit automation" : "New automation"}
          collapsible={false}
          className="automation-form-panel"
        >
          <div className="automation-form">
            <label>
              Name
              <input
                value={form.name}
                placeholder="Monday client digest"
                onChange={(event) => setForm((c) => ({ ...c, name: event.target.value }))}
              />
            </label>
            <div className="automation-form-grid">
              <label>
                Run against
                <SelectControl
                  value={form.surface}
                  onChange={(event) => setForm((c) => ({ ...c, surface: event.target.value as "chat" | "draft" }))}
                >
                  <option value="chat">Chat</option>
                  <option value="draft">Draft</option>
                </SelectControl>
              </label>
              <label>
                Trigger
                <SelectControl
                  value={form.trigger_type}
                  onChange={(event) =>
                    setForm((c) => ({ ...c, trigger_type: event.target.value as FormState["trigger_type"] }))
                  }
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="once">Once</option>
                  <option value="cron">Cron expression</option>
                </SelectControl>
              </label>
              {form.trigger_type === "weekly" && (
                <label>
                  Day
                  <SelectControl
                    value={form.weekly_day}
                    onChange={(event) => setForm((c) => ({ ...c, weekly_day: event.target.value }))}
                  >
                    {WEEKDAYS.map((day) => (
                      <option key={day} value={day}>
                        {cap(day)}
                      </option>
                    ))}
                  </SelectControl>
                </label>
              )}
              {(form.trigger_type === "weekly" || form.trigger_type === "daily") && (
                <label>
                  Time
                  <input
                    type="time"
                    value={form.time_of_day}
                    onChange={(event) => setForm((c) => ({ ...c, time_of_day: event.target.value }))}
                  />
                </label>
              )}
              {form.trigger_type === "once" && (
                <label>
                  Run at
                  <input
                    type="datetime-local"
                    value={form.run_at}
                    onChange={(event) => setForm((c) => ({ ...c, run_at: event.target.value }))}
                  />
                </label>
              )}
              {form.trigger_type === "cron" && (
                <label>
                  Cron expression
                  <input
                    value={form.cron_expression}
                    placeholder="0 9 * * 1"
                    onChange={(event) => setForm((c) => ({ ...c, cron_expression: event.target.value }))}
                  />
                </label>
              )}
            </div>
            <label>
              Initial input
              <textarea
                value={form.prompt}
                rows={2}
                placeholder="What should the first step work on?"
                onChange={(event) => setForm((c) => ({ ...c, prompt: event.target.value }))}
              />
            </label>

            <div className="automation-steps">
              <div className="automation-steps-head">
                <strong>Model chain</strong>
                <small>Each step's output feeds the next.</small>
              </div>
              {form.steps.map((step, index) => (
                <div className="automation-step-row" key={index}>
                  <span className="automation-step-index">{index + 1}</span>
                  <SelectControl value={step.model_id} onChange={(event) => updateStep(index, { model_id: event.target.value })}>
                    {approvedModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </SelectControl>
                  <input
                    value={step.instruction}
                    placeholder="Instruction for this step (optional)"
                    onChange={(event) => updateStep(index, { instruction: event.target.value })}
                  />
                  {form.steps.length > 1 && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Remove step ${index + 1}`}
                      data-tooltip={`Remove step ${index + 1} from the model chain`}
                      onClick={() => setForm((c) => ({ ...c, steps: c.steps.filter((_, i) => i !== index) }))}
                    >
                      <X size={15} />
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                className="secondary-button compact"
                data-tooltip="Add another model step that receives the previous step's output"
                onClick={() =>
                  setForm((c) => ({ ...c, steps: [...c.steps, { model_id: approvedModels[0]?.id ?? "", instruction: "" }] }))
                }
              >
                <Plus size={14} /> Add step
              </button>
            </div>

            <div className="automation-form-actions">
              <button
                className="primary-button"
                type="button"
                disabled={pending === "save"}
                data-tooltip={
                  editingId
                    ? "Save your changes without pausing or resuming this automation"
                    : "Save this automation to your list, paused until you enable it"
                }
                onClick={() => void handleSave()}
              >
                <Check size={16} />{" "}
                <StableLabel
                  label={pending === "save" ? "Saving…" : editingId ? "Save changes" : "Save automation"}
                  reserve={["Saving…", "Save changes", "Save automation"]}
                />
              </button>
              <button
                className="secondary-button compact"
                type="button"
                data-tooltip="Close the form and discard any unsaved changes"
                onClick={() => {
                  setShowForm(false);
                  setEditingId(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </Panel>
      )}

      <div className="automation-list">
        {automations.length === 0 && !showForm && (
          <p className="empty-hint">No automations yet. Create one to schedule a recurring chat or drafting run.</p>
        )}
        {automations.map((automation) => {
          const result = runResults[automation.id];
          return (
            <Panel
              key={automation.id}
              collapsible={false}
              className="automation-card"
              title={
                <span className="automation-card-title">
                  {automation.name}
                  <Pill tone={automation.surface === "draft" ? "info" : "neutral"}>{cap(automation.surface)}</Pill>
                  {automation.enabled ? (
                    <Pill tone="success">Active</Pill>
                  ) : (
                    <Pill tone="warning">Paused</Pill>
                  )}
                </span>
              }
              actions={
                <span className="automation-card-actions">
                  <Toggle
                    checked={automation.enabled}
                    disabled={pending === `toggle-${automation.id}`}
                    label={`Enable ${automation.name}`}
                    tooltip={
                      automation.enabled
                        ? `Pause ${automation.name} so its schedule stops running`
                        : `Enable ${automation.name} so it runs on its schedule`
                    }
                    onChange={(next) => void handleToggle(automation, next)}
                  />
                  <button
                    className="secondary-button compact"
                    type="button"
                    disabled={pending === `run-${automation.id}`}
                    data-tooltip={`Run ${automation.name} immediately without waiting for its schedule`}
                    onClick={() => void handleRun(automation)}
                  >
                    <Play size={14} /> {pending === `run-${automation.id}` ? "Running…" : "Run now"}
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={`Edit ${automation.name}`}
                    data-tooltip={`Open ${automation.name} to change its schedule, prompt, or model chain`}
                    onClick={() => openEdit(automation)}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={`Delete ${automation.name}`}
                    data-tooltip={`Permanently remove ${automation.name} and its schedule`}
                    disabled={pending === `delete-${automation.id}`}
                    onClick={() => void handleDelete(automation)}
                  >
                    <Trash2 size={15} />
                  </button>
                </span>
              }
            >
              <div className="automation-card-body">
                <p className="automation-schedule">
                  <CalendarClock size={14} /> {scheduleSummary(automation)}
                </p>
                <p className="automation-chain-summary">
                  {automation.steps.length} step{automation.steps.length === 1 ? "" : "s"}:{" "}
                  {automation.steps
                    .map((step) => modelName(data, step.model_id))
                    .join(" → ")}
                </p>
                {automation.last_run_at && (
                  <p className="automation-last-run">
                    Last run: {automation.last_run_status} · {formatTimestamp(automation.last_run_at)}
                  </p>
                )}
                {result && (
                  <div className="automation-run-output">
                    {result.transcript.map((entry) => (
                      <div className="automation-run-step" key={entry.step}>
                        <strong>
                          Step {entry.step} · {entry.model_name}
                        </strong>
                        <p>{entry.output}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Panel>
          );
        })}
      </div>
    </div>
  );
}

function modelName(data: BootstrapData, modelId: string): string {
  return data.models.find((model) => model.id === modelId)?.name ?? modelId;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error.";
}
