import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { sampleData } from "../data/sampleData";
import {
  createAutomation,
  deleteAutomation,
  previewAutomationSchedule,
  runAutomation,
  updateAutomation,
} from "../lib/api";
import { approvedWorkspaceModels } from "../lib/modelAccess";
import type { Automation, BootstrapData } from "../lib/types";
import { AutomationsConsole, describeCron, scheduleSummary } from "./AutomationsConsole";

vi.mock("../lib/api", () => ({
  createAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  runAutomation: vi.fn(),
  updateAutomation: vi.fn(),
  previewAutomationSchedule: vi.fn(async () => ({
    valid: true,
    error: null,
    next_runs: ["2026-09-28T14:00:00+00:00", "2026-10-05T14:00:00+00:00"],
  })),
}));

const modelId = approvedWorkspaceModels(sampleData)[0]?.id ?? "";

const openThread = vi.fn();
const openDraft = vi.fn();

function renderConsole(initialData: BootstrapData) {
  function Harness() {
    const [data, setData] = useState(initialData);
    return (
      <AutomationsConsole
        data={data}
        actorUserId="user-admin"
        onDataChange={(updater) => setData((current) => updater(current))}
        onOpenThread={openThread}
        onOpenDraft={openDraft}
      />
    );
  }

  return render(<Harness />);
}

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "automation-weekly-digest",
    tenant_id: "tenant-example",
    name: "Weekly digest",
    surface: "chat",
    trigger_type: "weekly",
    weekly_day: "monday",
    time_of_day: "09:00",
    prompt: "Summarize this week's client work.",
    steps: [{ model_id: modelId, instruction: "Draft a concise summary." }],
    enabled: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

test("validates and creates a paused weekly automation", async () => {
  const created = automation();
  vi.mocked(createAutomation).mockResolvedValue(created);
  renderConsole({ ...sampleData, automations: [] });

  fireEvent.click(screen.getByRole("button", { name: /New automation/ }));
  fireEvent.click(screen.getByRole("button", { name: /Save automation/ }));
  expect(screen.getByRole("status")).toHaveTextContent("Give the automation a name.");

  fireEvent.change(screen.getByLabelText("Name"), { target: { value: " Weekly digest " } });
  fireEvent.change(screen.getByLabelText("Prompt"), {
    target: { value: "Summarize this week's client work." },
  });
  fireEvent.change(screen.getByLabelText("Step 1 instruction"), {
    target: { value: "Draft a concise summary." },
  });
  fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "UTC" } });
  // New automations default to running; this one is saved paused.
  fireEvent.click(screen.getByRole("switch", { name: "Run on this schedule" }));
  fireEvent.click(screen.getByRole("button", { name: /Save automation/ }));

  await waitFor(() => expect(createAutomation).toHaveBeenCalledTimes(1));
  expect(createAutomation).toHaveBeenCalledWith(
    "user-admin",
    expect.objectContaining({
      name: "Weekly digest",
      surface: "chat",
      trigger_type: "weekly",
      weekly_day: "monday",
      time_of_day: "09:00",
      timezone: "UTC",
      enabled: false,
      steps: [{ model_id: modelId, instruction: "Draft a concise summary." }],
    }),
  );
  expect(
    await screen.findByText("Automation “Weekly digest” saved. It is paused until you turn it on."),
  ).toBeInTheDocument();
  expect(screen.getByText("Every Monday at 9:00 AM · UTC")).toBeInTheDocument();
  expect(screen.getByText("Paused")).toBeInTheDocument();
});

test("shows the scheduler's preview of upcoming runs and its validation errors", async () => {
  renderConsole({ ...sampleData, automations: [] });
  fireEvent.click(screen.getByRole("button", { name: /New automation/ }));
  expect(await screen.findByText("Next runs")).toBeInTheDocument();

  vi.mocked(previewAutomationSchedule).mockResolvedValueOnce({
    valid: false,
    error: "'nope' is not a valid five-field cron expression.",
    next_runs: [],
  });
  fireEvent.click(screen.getByRole("button", { name: "Custom" }));
  fireEvent.change(screen.getByLabelText("Cron expression"), { target: { value: "nope" } });
  expect(await screen.findByText(/is not a valid five-field cron expression/)).toBeInTheDocument();
  expect(previewAutomationSchedule).toHaveBeenLastCalledWith(
    "user-admin",
    expect.objectContaining({ trigger_type: "cron", cron_expression: "nope" }),
  );
});

test("a recipe pre-fills a two-step chain delivered to drafts", async () => {
  vi.mocked(createAutomation).mockImplementation(async (_user, payload) => automation({ ...payload, id: "automation-new" } as Partial<Automation>));
  renderConsole({ ...sampleData, automations: [] });
  fireEvent.click(screen.getByRole("button", { name: /Research, then polish/ }));
  expect(screen.getByLabelText("Name")).toHaveValue("Research, then polish");
  expect((screen.getByLabelText("Step 2 instruction") as HTMLInputElement).value).toContain(
    "executive summary",
  );
  expect(screen.getByRole("button", { name: /New draft/ })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: /Save automation/ }));
  await waitFor(() =>
    expect(createAutomation).toHaveBeenCalledWith(
      "user-admin",
      expect.objectContaining({ surface: "draft", trigger_type: "weekly", weekly_day: "friday", enabled: true }),
    ),
  );
});

test("enables, runs with delivery, links the result, and deletes an automation", async () => {
  const existing = automation();
  const enabled = { ...existing, enabled: true, next_run_at: "2026-09-28T09:00:00+00:00" };
  vi.mocked(updateAutomation).mockResolvedValue(enabled);
  vi.mocked(runAutomation).mockResolvedValue({
    automation: {
      ...enabled,
      last_run_status: "succeeded",
      last_run_at: "2026-08-23T12:00:00Z",
      run_history: [
        { at: "2026-08-23T12:00:00Z", status: "succeeded", trigger: "manual", duration_ms: 1800, steps: 1, thread_id: "thread-automation-1" },
      ],
    },
    transcript: [
      {
        step: 1,
        model_id: modelId,
        model_name: "Example Model",
        instruction: "Draft a concise summary.",
        output: "The weekly digest is ready.",
      },
    ],
    final_output: "The weekly digest is ready.",
    thread_id: "thread-automation-1",
    draft_id: null,
  });
  vi.mocked(deleteAutomation).mockResolvedValue(undefined);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  renderConsole({ ...sampleData, automations: [existing] });

  fireEvent.click(screen.getByRole("switch", { name: "Enable Weekly digest" }));
  await waitFor(() => expect(updateAutomation).toHaveBeenCalledWith("user-admin", existing.id, { enabled: true }));
  expect(await screen.findByText("Active")).toBeInTheDocument();
  expect(screen.getByText(/Next run/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /Run now/ }));
  expect(await screen.findByText("The weekly digest is ready.")).toBeInTheDocument();
  expect(runAutomation).toHaveBeenCalledWith("user-admin", existing.id, { deliver: true });
  expect(screen.getByRole("status")).toHaveTextContent(
    "“Weekly digest” ran 1 step(s) and saved the result to a new chat.",
  );
  fireEvent.click(screen.getAllByRole("button", { name: /Open chat/ })[0]);
  expect(openThread).toHaveBeenCalledWith("thread-automation-1");

  fireEvent.click(screen.getByRole("button", { name: "More actions for Weekly digest" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete Weekly digest" }));
  await waitFor(() => expect(deleteAutomation).toHaveBeenCalledWith("user-admin", existing.id));
  expect(await screen.findByText("Put recurring work on autopilot")).toBeInTheDocument();
});

test("a failed or auto-paused automation is flagged with its error", () => {
  renderConsole({
    ...sampleData,
    automations: [
      automation({
        enabled: false,
        last_run_at: "2026-08-23T12:00:00Z",
        last_run_status: "failed: upstream boom — paused after 3 failed scheduled runs in a row",
        run_history: [{ at: "2026-08-23T12:00:00Z", status: "failed", trigger: "scheduled", detail: "upstream boom" }],
      }),
    ],
  });
  expect(screen.getByText("Paused after failures")).toBeInTheDocument();
  expect(screen.getByText("upstream boom", { selector: ".automation-error" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Needs attention/ })).toBeInTheDocument();
});

test("common cron schedules read in plain words", () => {
  expect(describeCron("30 7 * * 1-5")).toBe("Weekdays at 7:30 AM");
  expect(describeCron("0 17 * * 5")).toBe("Every Friday at 5:00 PM");
  expect(describeCron("0 9 * * 1,3")).toBe("Every Monday and Wednesday at 9:00 AM");
  expect(describeCron("15 * * * *")).toBe("Every hour at :15");
  expect(describeCron("*/30 * * * *")).toBe("Every 30 minutes");
  expect(describeCron("0 8 1 * *")).toBe("Monthly on day 1 at 8:00 AM");
  expect(describeCron("0 9 1 1 *")).toBeNull();
  expect(
    scheduleSummary({ trigger_type: "cron", cron_expression: "0 9 1 1 *", timezone: "America/Chicago" }),
  ).toBe("Custom schedule (0 9 1 1 *) · America/Chicago");
});
