import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useGlobalTooltip } from "./useGlobalTooltip";

function TooltipHarness() {
  useGlobalTooltip();
  return (
    <form aria-label="Knowledge setup">
      <label>
        Name
        <input placeholder="Matter knowledge base" />
      </label>
      <label>
        Source type
        <select defaultValue="box">
          <option value="box">Box</option>
          <option value="sharepoint">SharePoint</option>
          <option value="website">Website</option>
        </select>
      </label>
      <label>
        Auth token
        <input type="password" />
      </label>
      <textarea
        aria-label="Draft instruction"
        data-tooltip="Write the exact instruction the drafting assistant should apply."
      />
    </form>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

test("builds contextual tooltips for unannotated form controls", () => {
  vi.useFakeTimers();
  render(<TooltipHarness />);

  fireEvent.mouseOver(screen.getByPlaceholderText("Matter knowledge base"));
  act(() => vi.advanceTimersByTime(350));
  expect(document.querySelector(".apx-tooltip-label")).toHaveTextContent(
    "Enter Name in Knowledge setup. Example: Matter knowledge base.",
  );

  fireEvent.mouseOut(screen.getByPlaceholderText("Matter knowledge base"));
  fireEvent.mouseOver(screen.getByRole("combobox"));
  act(() => vi.advanceTimersByTime(350));
  expect(document.querySelector(".apx-tooltip-label")).toHaveTextContent(
    "Choose Source type in Knowledge setup. Choices include Box, SharePoint, or Website.",
  );
});

test("keeps authored field tooltip text ahead of generated fallback copy", () => {
  vi.useFakeTimers();
  render(<TooltipHarness />);

  fireEvent.mouseOver(screen.getByLabelText("Draft instruction"));
  act(() => vi.advanceTimersByTime(350));

  expect(document.querySelector(".apx-tooltip-label")).toHaveTextContent(
    "Write the exact instruction the drafting assistant should apply.",
  );
});
