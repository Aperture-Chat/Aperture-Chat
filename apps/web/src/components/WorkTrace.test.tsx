import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../lib/types";
import { STEP_REVEAL_MS, WorkTrace, WorkTraceStreamStatus } from "./WorkTrace";

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

const gathered: ChatMessage["activityTrace"] = [
  { id: "route:model", label: "Routed to GPT-6 Astra", detail: "With web search" },
  { id: "web:provider", label: "Handed web search to the model provider" },
  { id: "memory:recalled", label: "Recalled 5 memories" },
  { id: "plan:requirements", label: "Picked out 1 thing to verify" },
];

function kinds(list: HTMLElement) {
  return within(list).getAllByRole("listitem").map((item) => item.dataset.kind);
}

function nextStep() {
  act(() => {
    vi.advanceTimersByTime(STEP_REVEAL_MS);
  });
}

describe("WorkTrace while the reply is running", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("the timeline is open from the start and plays each step in one at a time", () => {
    const onStop = vi.fn();
    render(
      <WorkTrace brandName="Aperture Chat" message={message({ activityTrace: gathered })} onStop={onStop} state="pending" />,
    );

    const trace = screen.getByRole("status", { name: "Aperture Chat activity trace" });
    expect(within(trace).getByText("Aperture Chat is working")).toBeInTheDocument();
    // The run's clock, and the Thinking step's own wait so far.
    expect(within(trace).getAllByText("14s")).toHaveLength(2);
    expect(within(trace).getByRole("button", { name: "Collapse work trace" })).toHaveAttribute("aria-expanded", "true");
    const steps = within(trace).getByRole("list", { name: "Steps so far" });
    // Four facts arrived in one burst; the reader sees them land one by one
    // above the step in progress, the model thinking, which never blinks out.
    expect(kinds(steps)).toEqual(["route", "think", "next"]);
    expect(within(steps).getAllByRole("listitem")[1]).toHaveClass("is-active");

    nextStep();
    expect(kinds(steps)).toEqual(["route", "web", "think", "next"]);
    expect(within(steps).getAllByRole("listitem")[2]).toHaveClass("is-active");
    expect(within(steps).getAllByRole("listitem")[1]).not.toHaveClass("is-active");
    nextStep();
    expect(kinds(steps)).toEqual(["route", "web", "memory", "think", "next"]);
    nextStep();
    expect(kinds(steps)).toEqual(["route", "web", "memory", "plan", "think", "next"]);
    expect(within(steps).getAllByRole("listitem")[4]).toHaveClass("is-active");
    expect(within(steps).getByText("Thinking")).toBeInTheDocument();
    expect(within(steps).getByText("Start writing the reply")).toBeInTheDocument();
    nextStep();
    expect(kinds(steps)).toEqual(["route", "web", "memory", "plan", "think", "next"]);

    fireEvent.click(within(trace).getByRole("button", { name: "Stop this response" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("folded, one quiet line names the step on screen and what comes next", () => {
    render(<WorkTrace brandName="Aperture Chat" message={message({ activityTrace: gathered })} state="pending" />);
    const trace = screen.getByRole("status", { name: "Aperture Chat activity trace" });

    fireEvent.click(within(trace).getByRole("button", { name: "Collapse work trace" }));

    expect(within(trace).queryByRole("list")).not.toBeInTheDocument();
    expect(within(trace).getByText("Thinking")).toBeInTheDocument();
    nextStep();
    nextStep();
    nextStep();
    expect(within(trace).getByText("Thinking")).toBeInTheDocument();
    expect(within(trace).getByText("Start writing the reply")).toBeInTheDocument();
    expect(within(trace).getByRole("button", { name: "Expand work trace" })).toHaveAttribute("aria-expanded", "false");
  });

  test("steps arriving faster than the reveal never stall it", () => {
    const run = (count: number) => message({ startedAtMs: 1_000, activityTrace: gathered!.slice(0, count) });
    const { rerender } = render(<WorkTrace brandName="Aperture Chat" message={run(2)} state="pending" />);
    const steps = screen.getByRole("list", { name: "Steps so far" });
    act(() => {
      vi.advanceTimersByTime(STEP_REVEAL_MS / 2);
    });
    rerender(<WorkTrace brandName="Aperture Chat" message={run(3)} state="pending" />);
    act(() => {
      vi.advanceTimersByTime(STEP_REVEAL_MS / 2);
    });
    rerender(<WorkTrace brandName="Aperture Chat" message={run(4)} state="pending" />);
    expect(kinds(steps)).toEqual(["route", "web", "think", "next"]);
  });

  test("when the first words arrive, Thinking turns into how long it thought, in place", () => {
    const thinking = message({ startedAtMs: 1_000, activityTrace: gathered!.slice(0, 2) });
    const { rerender } = render(<WorkTrace brandName="Aperture Chat" message={thinking} state="pending" />);
    const steps = screen.getByRole("list", { name: "Steps so far" });
    nextStep();
    expect(kinds(steps)).toEqual(["route", "web", "think", "next"]);

    rerender(
      <WorkTrace
        brandName="Aperture Chat"
        message={message({
          startedAtMs: 1_000,
          content: "Oak trees",
          activityTrace: [...gathered!.slice(0, 2), { id: "think:first-token", label: "Thought for 4s" }],
        })}
        state="pending"
      />,
    );
    expect(kinds(steps)).toEqual(["route", "web", "think", "next"]);
    expect(within(steps).getByText("Thought for 4s")).toBeInTheDocument();
    expect(within(steps).getAllByRole("listitem")[2]).toHaveClass("is-active");
  });

  test("an idle trace still paces the next step that arrives", () => {
    const run = (count: number) => message({ startedAtMs: 1_000, activityTrace: gathered!.slice(0, count) });
    const { rerender } = render(<WorkTrace brandName="Aperture Chat" message={run(1)} state="pending" />);
    nextStep();
    nextStep();
    nextStep();
    rerender(<WorkTrace brandName="Aperture Chat" message={run(2)} state="pending" />);
    const steps = screen.getByRole("list", { name: "Steps so far" });
    expect(kinds(steps)).toEqual(["route", "think", "next"]);
    nextStep();
    expect(kinds(steps)).toEqual(["route", "web", "think", "next"]);
  });

  test("folding and opening a running trace keeps playing it in, and the clock ticks", () => {
    render(<WorkTrace brandName="Aperture Chat" message={message({ activityTrace: gathered })} state="pending" />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse work trace" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand work trace" }));
    expect(kinds(screen.getByRole("list", { name: "Steps so far" }))).toEqual(["route", "think", "next"]);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("status").querySelector(".work-trace-time")).toHaveTextContent("15s");
  });

  test("a new run in the same reply starts its reveal over", () => {
    const { rerender } = render(
      <WorkTrace brandName="Aperture Chat" message={message({ startedAtMs: 1_000, activityTrace: gathered })} state="pending" />,
    );
    nextStep();
    nextStep();
    rerender(
      <WorkTrace brandName="Aperture Chat" message={message({ startedAtMs: 9_000, activityTrace: gathered })} state="pending" />,
    );
    expect(kinds(screen.getByRole("list", { name: "Steps so far" }))).toEqual(["route", "think", "next"]);
  });

  test("once caught up, the step the reply is writing stays in progress even with steps after it", () => {
    render(
      <WorkTrace
        brandName="Aperture Chat"
        message={message({
          content: "## Plan\n\nOak trees",
          activityTrace: [
            { id: "route:model", label: "Routed to GPT-6 Astra" },
            { id: "think:first-token", label: "Thought for 3s" },
            { id: "write:s1", label: "Drafting “Plan”" },
            { id: "tools:servers", label: "Connected 1 tool server" },
          ],
        })}
        state="pending"
      />,
    );
    nextStep();
    nextStep();
    nextStep();
    const items = within(screen.getByRole("list", { name: "Steps so far" })).getAllByRole("listitem");
    expect(items.map((item) => item.dataset.kind)).toEqual(["route", "think", "write", "tools", "next"]);
    expect(items[2]).toHaveClass("is-active");
    expect(items[3]).not.toHaveClass("is-active");
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
    fireEvent.click(within(trace).getByRole("button", { name: "Collapse work trace" }));
    // While the reply streams and steps are still playing in, the newest one
    // on screen is the one in progress (the finished thinking comes with the
    // step before it).
    expect(within(trace).getByText("Thought for 3s")).toBeInTheDocument();
    nextStep();
    expect(within(trace).getByText("Drafted “Build”")).toBeInTheDocument();
    nextStep();
    expect(within(trace).getByText("Writing html · 2 lines")).toBeInTheDocument();
    expect(within(trace).getByText("Check the work and finish")).toBeInTheDocument();
  });
});

describe("WorkTrace for a reply the reader watched", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("finishing keeps the timeline open and plays in the steps that came at the end", () => {
    const { rerender } = render(
      <WorkTrace brandName="Aperture Chat" message={message({ activityTrace: finished!.slice(0, 1) })} state="pending" />,
    );
    rerender(
      <WorkTrace
        brandName="Aperture Chat"
        message={message({ status: "ok", content: "Done", durationMs: 48_400, activityTrace: finished })}
        state="complete"
      />,
    );

    const trace = screen.getByRole("region", { name: "Aperture Chat activity trace" });
    // The header is the settled truth at once; the timeline catches up step by step.
    expect(within(trace).getByText("Worked for 48s")).toBeInTheDocument();
    expect(within(trace).getByText("9 steps · 2 checks passed · 1 flag")).toBeInTheDocument();
    const steps = within(trace).getByRole("list", { name: "Steps" });
    expect(kinds(steps)).toEqual(["route"]);
    nextStep();
    expect(kinds(steps)).toEqual(["route", "web", "think"]);
    nextStep();
    expect(kinds(steps)).toEqual(["route", "web", "think", "write"]);
    for (let step = 0; step < 5; step += 1) nextStep();
    expect(kinds(steps)).toEqual(["route", "web", "think", "write", "code", "check", "check", "flag", "done"]);
    expect(within(steps).getAllByRole("listitem").some((item) => item.classList.contains("is-active"))).toBe(false);
  });

  test("reopening a finished trace by hand shows every step at once", () => {
    const { rerender } = render(
      <WorkTrace brandName="Aperture Chat" message={message({ activityTrace: finished!.slice(0, 1) })} state="pending" />,
    );
    rerender(
      <WorkTrace
        brandName="Aperture Chat"
        message={message({ status: "ok", content: "Done", durationMs: 48_400, activityTrace: finished })}
        state="complete"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse work trace" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand work trace" }));

    expect(kinds(screen.getByRole("list", { name: "Steps" }))).toHaveLength(9);
    // No exposed thinking, so no empty thinking section.
    expect(screen.queryByText("Thinking the model exposed")).not.toBeInTheDocument();
  });

  test("a trace folded while it ran stays folded once the reply is done", () => {
    const { rerender } = render(
      <WorkTrace brandName="Aperture Chat" message={message({ activityTrace: gathered })} state="pending" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse work trace" }));
    rerender(
      <WorkTrace
        brandName="Aperture Chat"
        message={message({ status: "ok", content: "Done", durationMs: 9000, activityTrace: finished })}
        state="complete"
      />,
    );

    const trace = screen.getByRole("region", { name: "Aperture Chat activity trace" });
    expect(within(trace).queryByRole("list")).not.toBeInTheDocument();
    // Opening it now lays out every step; there is nothing left to watch.
    fireEvent.click(within(trace).getByRole("button", { name: "Expand work trace" }));
    expect(kinds(within(trace).getByRole("list", { name: "Steps" }))).toHaveLength(9);
  });

  test("regenerating a finished reply opens a fresh timeline for the new run", () => {
    const { rerender } = render(
      <WorkTrace
        brandName="Aperture Chat"
        message={message({ status: "ok", content: "Done", durationMs: 9000, activityTrace: finished })}
        state="complete"
      />,
    );
    expect(screen.queryByRole("list")).not.toBeInTheDocument();

    rerender(
      <WorkTrace
        brandName="Aperture Chat"
        message={message({ startedAtMs: Date.now(), activityTrace: gathered })}
        state="pending"
      />,
    );

    const steps = screen.getByRole("list", { name: "Steps so far" });
    expect(kinds(steps)).toEqual(["route", "think", "next"]);
    nextStep();
    expect(kinds(steps)).toEqual(["route", "web", "think", "next"]);
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
