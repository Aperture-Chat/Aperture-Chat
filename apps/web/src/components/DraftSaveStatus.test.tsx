import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { DraftSaveStatus } from "./DraftSaveStatus";

test("Retry on a shared draft's autosave retries the live copy, not a version save", () => {
  const onRetry = vi.fn();
  const onRetryLive = vi.fn();
  render(
    <DraftSaveStatus
      status={{ tone: "local-only", label: "Not saved yet", detail: "Offline.", action: { kind: "retry-live" } }}
      onRetry={onRetry}
      onRetryLive={onRetryLive}
      onReload={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(onRetryLive).toHaveBeenCalledTimes(1);
  expect(onRetry).not.toHaveBeenCalled();
});

test("Retry on a failed version save retries the version save", () => {
  const onRetry = vi.fn();
  const onRetryLive = vi.fn();
  render(
    <DraftSaveStatus
      status={{ tone: "local-only", label: "Local only", detail: "Failed.", action: { kind: "retry" } }}
      onRetry={onRetry}
      onRetryLive={onRetryLive}
      onReload={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(onRetryLive).not.toHaveBeenCalled();
});
