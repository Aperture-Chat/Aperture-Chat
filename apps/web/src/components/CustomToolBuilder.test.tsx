import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { CustomToolBuilder, type CustomToolBuilderApi } from "./CustomToolBuilder";

const api: CustomToolBuilderApi = {
  createTool: vi.fn(),
  updateTool: vi.fn(),
  previewScript: vi.fn(),
};

test("response action builder explains the script contract under the tenant brand name", () => {
  render(
    <CustomToolBuilder
      tool={null}
      groups={[]}
      api={api}
      onClose={() => {}}
      onSaved={() => {}}
      brandName="Example AI"
    />,
  );

  const summary = screen.getByText("How to write scripts for Example AI");
  const guide = summary.closest("details");
  expect(guide).not.toHaveAttribute("open");

  fireEvent.click(summary);
  expect(guide).toHaveAttribute("open");
  expect(screen.getAllByText(/sys\.stdin\.read/).length).toBeGreaterThanOrEqual(2);
  expect(screen.getAllByText(/APERTURE_ARTIFACT_DIR/).length).toBeGreaterThanOrEqual(2);
  expect(screen.getByText(/Remove Open WebUI imports/)).toBeInTheDocument();
  expect(screen.getByText(/50 MB limit per file/)).toBeInTheDocument();
});
