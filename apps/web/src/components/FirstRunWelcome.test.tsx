import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { sampleData } from "../data/sampleData";
import { FirstRunWelcome } from "./FirstRunWelcome";

test("a fresh owner is directed to provider setup without claiming any models work", () => {
  const data = structuredClone(sampleData);
  data.me.role = "PLATFORM_OWNER";
  data.providers = [];
  data.models = [];
  const navigate = vi.fn();
  const dismiss = vi.fn();
  render(<FirstRunWelcome data={data} onDismiss={dismiss} onGuide={vi.fn()} onNavigate={navigate} />);
  expect(screen.getByText("Connect your first model")).toBeInTheDocument();
  expect(dismiss).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Set up models/ }));
  expect(navigate).toHaveBeenCalledWith("platform");
});

test("regular users see their own access guidance and no management actions", () => {
  const data = structuredClone(sampleData);
  data.me.role = "USER";
  data.me.group_ids = [];
  const guide = vi.fn();
  render(<FirstRunWelcome data={data} onDismiss={vi.fn()} onGuide={guide} onNavigate={vi.fn()} />);
  expect(screen.getByText("Ask your workspace administrator to enable a model for your account.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Set up models|Manage access|Open owner guide/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open quick-start guide" }));
  expect(guide).toHaveBeenCalledOnce();
});

test("an administrator can reach the correct guide or explicitly dismiss onboarding", () => {
  const data = structuredClone(sampleData);
  data.me.role = "TENANT_ADMIN";
  const dismiss = vi.fn();
  const guide = vi.fn();
  render(<FirstRunWelcome data={data} onDismiss={dismiss} onGuide={guide} onNavigate={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Open admin guide" }));
  expect(guide).toHaveBeenCalledOnce();
  expect(dismiss).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "I'll explore on my own" }));
  expect(dismiss).toHaveBeenCalledOnce();
});
