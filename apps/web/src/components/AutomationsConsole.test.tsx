import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { sampleData } from "../data/sampleData";
import {
  createAutomation,
  deleteAutomation,
  runAutomation,
  updateAutomation,
} from "../lib/api";
import { approvedWorkspaceModels } from "../lib/modelAccess";
import type { Automation, BootstrapData } from "../lib/types";
import { AutomationsConsole } from "./AutomationsConsole";

vi.mock("../lib/api", () => ({
  createAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  runAutomation: vi.fn(),
  updateAutomation: vi.fn(),
}));

const modelId = approvedWorkspaceModels(sampleData)[0]?.id ?? "";

function renderConsole(initialData: BootstrapData) {
  function Harness() {
    const [data, setData] = useState(initialData);
    return (
      <AutomationsConsole
        data={data}
        actorUserId="user-admin"
        onDataChange={(updater) => setData((current) => updater(current))}
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
  fireEvent.change(screen.getByLabelText("Initial input"), {
    target: { value: "Summarize this week's client work." },
  });
  fireEvent.change(screen.getByPlaceholderText("Instruction for this step (optional)"), {
    target: { value: "Draft a concise summary." },
  });
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
      enabled: false,
      steps: [{ model_id: modelId, instruction: "Draft a concise summary." }],
    }),
  );
  expect(await screen.findByText("Automation “Weekly digest” saved.")).toBeInTheDocument();
  expect(screen.getByText("Weekly · Monday at 09:00")).toBeInTheDocument();
  expect(screen.getByText("Paused")).toBeInTheDocument();
});

test("enables, runs, and deletes an existing automation through the API", async () => {
  const existing = automation();
  const enabled = { ...existing, enabled: true };
  vi.mocked(updateAutomation).mockResolvedValue(enabled);
  vi.mocked(runAutomation).mockResolvedValue({
    automation: { ...enabled, last_run_status: "ok", last_run_at: "2026-08-23T12:00:00Z" },
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
  });
  vi.mocked(deleteAutomation).mockResolvedValue(undefined);
  renderConsole({ ...sampleData, automations: [existing] });

  fireEvent.click(screen.getByRole("switch", { name: "Enable Weekly digest" }));
  await waitFor(() => expect(updateAutomation).toHaveBeenCalledWith("user-admin", existing.id, { enabled: true }));
  expect(await screen.findByText("Active")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /Run now/ }));
  expect(await screen.findByText("The weekly digest is ready.")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("“Weekly digest” ran 1 step(s).");

  fireEvent.click(screen.getByRole("button", { name: "Delete Weekly digest" }));
  await waitFor(() => expect(deleteAutomation).toHaveBeenCalledWith("user-admin", existing.id));
  expect(screen.getByText("No automations yet. Create one to schedule a recurring chat or drafting run.")).toBeInTheDocument();
});
