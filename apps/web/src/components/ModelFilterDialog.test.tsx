import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { ContentFilter, ModelConfig } from "../lib/types";
import { ModelFilterDialog, type ModelFilterDialogApi } from "./ModelFilterDialog";

const model: ModelConfig = {
  id: "model-openrouter-example",
  provider_id: "provider-openrouter",
  provider_name: "OpenRouter",
  name: "Example Model",
  platform_enabled: true,
  tenant_restricted: false,
  group_ids: [],
  content_filter_ids: [],
};

const preset: ContentFilter = {
  id: "filter-confidential",
  name: "Confidential terms",
  description: "Redacts protected matter names.",
  builtin: true,
  rules: [
    {
      id: "matter-name",
      label: "Matter name",
      pattern: "Project Atlas",
      action: "redact",
      applies_to: "both",
    },
  ],
  updated_at: "2026-08-23T00:00:00Z",
};

function dialogApi(overrides: Partial<ModelFilterDialogApi> = {}): ModelFilterDialogApi {
  return {
    listFilters: vi.fn(async () => [preset]),
    createFilter: vi.fn(),
    updateFilter: vi.fn(),
    deleteFilter: vi.fn(),
    previewFilter: vi.fn(),
    setModelFilters: vi.fn(),
    ...overrides,
  };
}

test("assigns a loaded filter and reports the model returned by the server", async () => {
  const updated = { ...model, content_filter_ids: [preset.id] };
  const api = dialogApi({ setModelFilters: vi.fn(async () => updated) });
  const onModelUpdated = vi.fn();

  render(
    <ModelFilterDialog model={model} api={api} onClose={() => {}} onModelUpdated={onModelUpdated} />,
  );

  expect(await screen.findByText("Confidential terms")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("switch", { name: "Enforce Confidential terms on Example Model" }));

  expect(api.setModelFilters).toHaveBeenCalledWith(model.id, [preset.id]);
  expect(await screen.findByText("Confidential terms is now enforced on Example Model.")).toBeInTheDocument();
  expect(onModelUpdated).toHaveBeenCalledWith(updated);
  expect(screen.getByRole("switch", { name: "Enforce Confidential terms on Example Model" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("previews and creates a custom filter with a stable rule id", async () => {
  const saved: ContentFilter = {
    ...preset,
    id: "filter-client-codenames",
    name: "Client codenames",
    description: "Protects client aliases.",
    builtin: false,
  };
  const api = dialogApi({
    previewFilter: vi.fn(async () => ({
      matches: [{ rule_id: "client-codename", label: "Client codename", action: "redact", match_count: 1 }],
      redacted_sample: "Discuss [REDACTED · Client codename] tomorrow.",
      would_block: false,
    })),
    createFilter: vi.fn(async () => saved),
  });

  render(<ModelFilterDialog model={model} api={api} onClose={() => {}} onModelUpdated={() => {}} />);

  await screen.findByText("Confidential terms");
  fireEvent.click(screen.getByRole("button", { name: /New custom filter/ }));
  fireEvent.change(screen.getByLabelText("Filter name"), { target: { value: "Client codenames" } });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Protects client aliases." } });
  fireEvent.change(screen.getByLabelText("Rule label"), { target: { value: "Client codename" } });
  fireEvent.change(screen.getByLabelText("Rule pattern"), { target: { value: "Project [A-Z]+" } });
  fireEvent.change(screen.getByLabelText("Sample text for rule testing"), {
    target: { value: "Discuss Project ATLAS tomorrow." },
  });
  fireEvent.click(screen.getByRole("button", { name: /Test rules/ }));

  expect(await screen.findByText("This sample would be redacted.")).toBeInTheDocument();
  expect(api.previewFilter).toHaveBeenCalledWith(
    [
      {
        id: "client-codename",
        label: "Client codename",
        pattern: "Project [A-Z]+",
        action: "redact",
        applies_to: "input",
      },
    ],
    "Discuss Project ATLAS tomorrow.",
  );

  fireEvent.click(screen.getByRole("button", { name: /Create filter/ }));
  expect(api.createFilter).toHaveBeenCalledWith({
    name: "Client codenames",
    description: "Protects client aliases.",
    rules: [
      {
        id: "client-codename",
        label: "Client codename",
        pattern: "Project [A-Z]+",
        action: "redact",
        applies_to: "input",
      },
    ],
  });
  expect(await screen.findByText("Client codenames saved.")).toBeInTheDocument();
});
