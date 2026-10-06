import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import {
  createTrainingDataset,
  getTrainingOverview,
  getTrainingPolicy,
  getTrainingTaxonomy,
  listTrainingExamples,
  reviewTrainingExamples,
  updateTrainingPolicy,
} from "../lib/api/dataProtection";
import type { Group, TrainingCapturePolicy, TrainingExample, TrainingOverview } from "../lib/types";
import { TrainingDatasetsConsole } from "./TrainingDatasetsConsole";

vi.mock("../lib/api/dataProtection", () => ({
  getTrainingPolicy: vi.fn(),
  getTrainingTaxonomy: vi.fn(),
  getTrainingOverview: vi.fn(),
  listTrainingExamples: vi.fn(),
  reviewTrainingExamples: vi.fn(),
  updateTrainingPolicy: vi.fn(),
  createTrainingDataset: vi.fn(),
  updateTrainingDataset: vi.fn(),
  deleteTrainingDataset: vi.fn(),
  scanTrainingChats: vi.fn(),
  downloadTrainingDataset: vi.fn(),
}));

const policy: TrainingCapturePolicy = {
  tenant_id: "synthetic",
  enabled: true,
  capture_positive: true,
  capture_negative: true,
  capture_corrections: true,
  require_review: true,
  exclude_sensitive_chats: true,
  conceal_names: true,
  excluded_group_ids: [],
  context_messages: 6,
};

const example: TrainingExample = {
  id: "example-1",
  thread_id: "thread-1",
  message_id: "a1",
  signal: "correction",
  status: "pending",
  user_id: "user-1",
  user_name: "Synthetic Person",
  model_id: "model-1",
  practice_area: "legal/litigation",
  practice_source: "keywords",
  task_type: "drafting",
  group_ids: ["group-lit"],
  prompt: [{ role: "user", content: "Draft a motion for ⟦CLIENT⟧, SSN ⟦SSN⟧." }],
  completion: "Responses are due in 14 days.",
  correction: "No, that's wrong, it should be 30 days.",
  revision: "Responses are due in 30 days.",
  revision_accepted: true,
  correction_kind: "follow_up",
  comment: "",
  redaction_count: 2,
  captured_at: "2026-10-04T12:00:00Z",
  updated_at: "2026-10-04T12:00:00Z",
  dataset_ids: [],
};

const overview: TrainingOverview = {
  total: 1,
  pending: 1,
  approved: 0,
  excluded: 0,
  redactions: 2,
  unrouted: 1,
  by_signal: { correction: 1 },
  by_practice_area: [{ key: "legal/litigation", label: "Legal · Litigation", count: 1 }],
  by_task_type: [{ key: "drafting", label: "Drafting", count: 1 }],
  by_group: [{ key: "group-lit", label: "Litigation", count: 1 }],
  suggestions: [
    {
      key: "practice:legal/litigation",
      name: "Legal · Litigation — corrections",
      reason: "3 captured examples are labeled Legal · Litigation.",
      format: "preference",
      rules: { signals: [], practice_areas: ["legal/litigation"], task_types: [], group_ids: [], model_ids: [] },
    },
  ],
  datasets: [],
};

const groups: Group[] = [
  { id: "group-lit", tenant_id: "synthetic", name: "Litigation", distinguished_name: "", entra_object_id: "", synced: true, user_count: 1 } as Group,
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTrainingPolicy).mockResolvedValue(policy);
  vi.mocked(getTrainingTaxonomy).mockResolvedValue({
    practice_areas: [
      { key: "legal", label: "Legal" },
      { key: "legal/litigation", label: "Legal · Litigation" },
    ],
    task_types: [{ key: "drafting", label: "Drafting" }],
    signals: [{ key: "correction", label: "Corrected" }],
    formats: [{ key: "preference", label: "Preference pairs (DPO)" }],
  });
  vi.mocked(getTrainingOverview).mockResolvedValue(overview);
  vi.mocked(listTrainingExamples).mockResolvedValue({ total: 1, items: [example] });
  vi.mocked(reviewTrainingExamples).mockResolvedValue({ reviewed: 1 });
  vi.mocked(updateTrainingPolicy).mockImplementation(async (_user, patch) => ({ ...policy, ...patch }));
  vi.mocked(createTrainingDataset).mockImplementation(async (_user, payload) => ({
    ...payload,
    id: "dataset-1",
    tenant_id: "synthetic",
    created_at: "",
    updated_at: "",
    example_count: 1,
    approved_count: 0,
    pending_count: 1,
  }));
});

test("shows captured corrections de-identified and approves one", async () => {
  render(<TrainingDatasetsConsole actorUserId="synthetic" groups={groups} models={[]} />);
  expect(await screen.findByText("Responses are due in 14 days.")).toBeInTheDocument();
  expect(screen.getByText("Responses are due in 30 days.")).toBeInTheDocument();
  expect(screen.getByText("Preferred")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "SSN hidden" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^Approve$/ }));
  await waitFor(() => expect(reviewTrainingExamples).toHaveBeenCalledWith("synthetic", ["example-1"], "approved"));
});

test("a suggestion opens a prefilled editor that creates the dataset", async () => {
  render(<TrainingDatasetsConsole actorUserId="synthetic" groups={groups} models={[]} />);
  fireEvent.click(await screen.findByRole("button", { name: /Create$/ }));
  expect(screen.getByRole("dialog", { name: "New dataset" })).toBeInTheDocument();
  expect(screen.getByDisplayValue("Legal · Litigation — corrections")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Create dataset/ }));
  await waitFor(() =>
    expect(createTrainingDataset).toHaveBeenCalledWith(
      "synthetic",
      expect.objectContaining({ format: "preference", rules: expect.objectContaining({ practice_areas: ["legal/litigation"] }) }),
    ),
  );
});

test("excluding a department saves the capture policy", async () => {
  render(<TrainingDatasetsConsole actorUserId="synthetic" groups={groups} models={[]} />);
  const group = await screen.findByRole("group", { name: "Groups never captured" });
  fireEvent.click(group.querySelector("button") as HTMLButtonElement);
  await waitFor(() => expect(updateTrainingPolicy).toHaveBeenCalledWith("synthetic", { excluded_group_ids: ["group-lit"] }));
});
