import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../lib/types";
import { WorkTrace, WorkTraceStreamStatus } from "./WorkTrace";

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m1",
    role: "assistant",
    content: "",
    createdAt: "now",
    status: "pending",
    startedAtMs: Date.now() - 14_000,
    activityTrace: [{ id: "route:model", label: "Routed to GPT-6 Astra", detail: "With web search" }],
    ...overrides,
  };
}

const finished: ChatMessage["activityTrace"] = [
  { id: "route:model", label: "Routed to GPT-6 Astra" },
  { id: "web:search", label: "Searched the web · 5 results", detail: "Via SearXNG" },
  { id: "think:first-token", label: "Thought for 6s" },
  { id: "write:s1", label: "Drafted “Game layout”" },
  { id: "code:c1", label: "Wrote html", detail: "1,027 lines" },
  { id: "check:fences", label: "Code blocks are all closed", detail: "1 fenced block" },
  { id: "check:html-1", label: "HTML page is complete" },
  { id: "flag:citations", label: "Cites [K3] with no source", detail: "Those markers have nothing behind them in this reply." },
  { id: "done:reply", label: "Delivered the reply", detail: "≈ 240 words" },
];

describe("WorkTrace while the reply is running", () => {
  test("one quiet line: who is working, for how long, doing what, and a stop", () => {
    const onStop = vi.fn();
    render(<WorkTrace brandName="Aperture Chat" message={message({})} onStop={onStop} state="pending" />);

    const trace = screen.getByRole("status", { name: "Aperture Chat activity trace" });
    expect(within(trace).getByText("Aperture Chat is working")).toBeInTheDocument();
    expect(within(trace).getByText("14s")).toBeInTheDocument();
    expect(within(trace).getByText("Thinking")).toBeInTheDocument();
    expect(within(trace).getByText("Start writing the reply")).toBeInTheDocument();
    // Collapsed: the timeline stays folded away.
    expect(within(trace).queryByText("Routed to GPT-6 Astra")).not.toBeInTheDocument();

    fireEvent.click(within(trace).getByRole("button", { name: "Stop this response" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("the current action follows the reply as it streams", () => {
    render(
      <WorkTrace
        brandName="Aperture Chat"
        message={message({
          content: "## Build\n\n```html\n<!doctype html>\n<html>",
          activityTrace: [
            { id: "route:model", label: "Routed to GPT-6 Astra" },
            { id: "think:first-token", label: "Thought for 3s" },
            { id: "write:s1", label: "Drafted “Build”" },
            { id: "code:c1", label: "Writing html", detail: "2 lines" },
          ],
        })}
        state="pending"
      />,
    );

    const trace = screen.getByRole("status", { name: "Aperture Chat activity trace" });
    expect(within(trace).getByText("Writing html · 2 lines")).toBeInTheDocument();
    expect(within(trace).getByText("Check the work and finish")).toBeInTheDocument();
  });

  test("expanding shows every step so far, the one in progress, and what is next", () => {
    render(<WorkTrace brandName="Aperture Chat" message={message({})} state="pending" />);
    const trace = screen.getByRole("status", { name: "Aperture Chat activity trace" });

    fireEvent.click(within(trace).getByRole("button", { name: "Expand work trace" }));

    const steps = within(trace).getByRole("list", { name: "Steps so far" });
    const items = within(steps).getAllByRole("listitem");
    expect(items.map((item) => item.dataset.kind)).toEqual(["route", "think", "next"]);
    expect(items[0]).toHaveTextContent("Routed to GPT-6 Astra");
    expect(items[0]).toHaveTextContent("With web search");
    expect(items[1]).toHaveClass("is-active");
    expect(items[2]).toHaveTextContent("Next");
    expect(within(trace).getByRole("button", { name: "Collapse work trace" })).toHaveAttribute("aria-expanded", "true");
  });
});

describe("WorkTrace after the reply", () => {
  test("collapses to how long it worked, the step count, and the check results", () => {
    render(
      <WorkTrace
        brandName="Aperture Chat"
        message={message({ status: "ok", content: "Done", durationMs: 48_400, activityTrace: finished })}
        state="complete"
      />,
    );

    const trace = screen.getByRole("region", { name: "Aperture Chat activity trace" });
    expect(within(trace).getByText("Worked for 48s")).toBeInTheDocument();
    expect(within(trace).getByText("9 steps · 2 checks passed · 1 flag")).toBeInTheDocument();
    expect(within(trace).queryByText("Searched the web · 5 results")).not.toBeInTheDocument();
  });

  test("expanded, each step carries its kind and checks say whether they passed", () => {
    render(
      <WorkTrace
        brandName="Aperture Chat"
        message={message({ status: "ok", content: "Done", durationMs: 48_400, activityTrace: finished })}
        state="complete"
      />,
    );
    const trace = screen.getByRole("region", { name: "Aperture Chat activity trace" });
    fireEvent.click(within(trace).getByRole("button", { name: "Expand work trace" }));

    const items = within(within(trace).getByRole("list", { name: "Steps" })).getAllByRole("listitem");
    expect(items.map((item) => item.dataset.kind)).toEqual([
      "route",
      "web",
      "think",
      "write",
      "code",
      "check",
      "check",
      "flag",
      "done",
    ]);
    expect(items[5]).toHaveTextContent("Check passed: Code blocks are all closed");
    expect(items[7]).toHaveTextContent("Needs attention: Cites [K3] with no source");
    expect(items.some((item) => item.classList.contains("is-active"))).toBe(false);
  });

  test("an agent run, a clean run, and a run with no timing read accordingly", () => {
    const clean = finished!.filter((step) => !step.id.startsWith("flag:"));
    const { rerender } = render(
      <WorkTrace
        brandName="Aperture Chat"
        message={message({
          status: "ok",
          durationMs: 125_000,
          activityTrace: clean,
          metadata: { chatRuntime: { agentEnabled: true } },
        })}
        state="complete"
      />,
    );
    expect(screen.getByText("Agent worked for 2m 05s")).toBeInTheDocument();
    expect(screen.getByText("8 steps · 2 checks passed")).toBeInTheDocument();

    rerender(
      <WorkTrace
        brandName="Aperture Chat"
        message={message({ status: "ok", durationMs: null, activityTrace: [{ id: "route:model", label: "Routed" }] })}
        state="complete"
      />,
    );
    expect(screen.getByText("Work trace")).toBeInTheDocument();
    expect(screen.getByText("1 step")).toBeInTheDocument();
  });

  test("model-exposed thinking sits inside the expanded trace", () => {
    render(
      <WorkTrace
        brandName="Aperture Chat"
        message={message({ status: "ok", durationMs: 3000, activityTrace: finished })}
        state="complete"
        thinkingTraces={["I compared the routes first."]}
      />,
    );
    const trace = screen.getByRole("region", { name: "Aperture Chat activity trace" });
    expect(within(trace).getByText("9 steps · 2 checks passed · 1 flag · thinking")).toBeInTheDocument();
    fireEvent.click(within(trace).getByRole("button", { name: "Expand work trace" }));
    fireEvent.click(within(trace).getByText("Thinking the model exposed"));
    expect(within(trace).getByText("I compared the routes first.")).toBeInTheDocument();
  });

  test("an older preset trace still renders, without the validator step that never ran", () => {
    render(
      <WorkTrace
        brandName="Aperture Chat"
        message={message({
          status: "ok",
          durationMs: 9000,
          activityTrace: [
            { id: "route", label: "Routing request", detail: "Using M." },
            { id: "generate", label: "Generating answer" },
            { id: "validator", label: "Content validator loop" },
            { id: "finalize", label: "Finalizing response" },
          ],
        })}
        state="complete"
      />,
    );
    const trace = screen.getByRole("region", { name: "Aperture Chat activity trace" });
    expect(within(trace).getByText("3 steps")).toBeInTheDocument();
    fireEvent.click(within(trace).getByRole("button", { name: "Expand work trace" }));
    expect(within(trace).queryByText("Content validator loop")).not.toBeInTheDocument();
    expect(within(trace).getByText("Finalizing response")).toBeInTheDocument();
  });
});

describe("WorkTraceStreamStatus under the streaming reply", () => {
  test("echoes the trace's live action where the reader is looking", () => {
    render(
      <WorkTraceStreamStatus
        message={message({
          content: "## Build\n\n```html\n<!doctype html>\n<html>",
          activityTrace: [
            { id: "route:model", label: "Routed to GPT-6 Astra" },
            { id: "think:first-token", label: "Thought for 3s" },
            { id: "write:s1", label: "Drafted “Build”" },
            { id: "code:c1", label: "Writing html", detail: "2 lines" },
          ],
        })}
      />,
    );

    const status = screen.getByRole("status");
    // Screen readers hear one steady announcement, not a line counter.
    expect(within(status).getByText("Streaming reply…")).toHaveClass("sr-only");
    expect(within(status).getByText("Writing html · 2 lines")).toHaveAttribute("aria-hidden", "true");
  });
});
