import {
  BadgeCheck,
  BookOpen,
  BookmarkCheck,
  Bot,
  Brain,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  Code2,
  EyeOff,
  Globe2,
  Image,
  Layers,
  Link2,
  ListChecks,
  Paperclip,
  PenLine,
  Puzzle,
  RefreshCw,
  Repeat,
  Route,
  ShieldCheck,
  Sparkles,
  Table2,
  TriangleAlert,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ChatRuntimeOptions } from "../lib/api";
import type { ChatMessage } from "../lib/types";
import {
  formatTraceDuration,
  liveTraceView,
  readTrace,
  traceSummary,
  type TraceKind,
  type TraceStep,
  type TraceSummary,
} from "../lib/workTrace";
import { Markdown } from "./Markdown";

const KIND_ICONS: Record<TraceKind | "next", LucideIcon> = {
  route: Route,
  agent: Bot,
  context: Layers,
  knowledge: BookOpen,
  web: Globe2,
  fetch: Link2,
  attachments: Paperclip,
  memory: Brain,
  tools: Wrench,
  skills: Puzzle,
  plan: ListChecks,
  privacy: EyeOff,
  screen: ShieldCheck,
  think: Sparkles,
  write: PenLine,
  code: Code2,
  diagram: Workflow,
  table: Table2,
  image: Image,
  continue: Repeat,
  resume: RefreshCw,
  check: BadgeCheck,
  flag: TriangleAlert,
  save: BookmarkCheck,
  done: CircleCheck,
  next: CircleDashed,
};

/** Read aloud before a step whose meaning its glyph carries. */
const KIND_PREFIX: Partial<Record<TraceKind, string>> = {
  check: "Check passed: ",
  flag: "Needs attention: ",
};

function TraceGlyph({ kind, active = false }: { kind: TraceKind | "next"; active?: boolean }) {
  const Icon = KIND_ICONS[kind];
  return (
    <span className={`work-trace-glyph${active ? " is-active" : ""}`} data-kind={kind} aria-hidden="true">
      <Icon size={12} strokeWidth={2.2} />
    </span>
  );
}

function TraceStepItem({ step, active = false }: { step: TraceStep; active?: boolean }) {
  const prefix = KIND_PREFIX[step.kind];
  return (
    <li className={`work-trace-step${active ? " is-active" : ""}`} data-kind={step.kind}>
      <TraceGlyph kind={step.kind} active={active} />
      <span className="work-trace-step-text">
        <strong>
          {prefix && <span className="sr-only">{prefix}</span>}
          {step.label}
        </strong>
        {step.detail && <small>{step.detail}</small>}
      </span>
    </li>
  );
}

function ThinkingTraces({ traces }: { traces: string[] }) {
  return (
    <details className="work-trace-thinking">
      <summary>
        <Bot size={13} aria-hidden="true" />
        <span>Thinking the model exposed</span>
        <ChevronDown size={13} className="work-trace-thinking-caret" aria-hidden="true" />
      </summary>
      <div className="work-trace-thinking-body">
        {traces.map((trace, index) => (
          <div className="work-trace-thinking-entry" key={`${index}-${trace.slice(0, 32)}`}>
            <Markdown content={trace} />
          </div>
        ))}
      </div>
    </details>
  );
}

function ToggleButton({
  expanded,
  onToggle,
  children,
}: {
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className="work-trace-toggle"
      type="button"
      aria-expanded={expanded}
      aria-label={expanded ? "Collapse work trace" : "Expand work trace"}
      data-tooltip={expanded ? "Fold the trace back to one line" : "Show every step of this run"}
      onClick={onToggle}
    >
      {children}
      <ChevronDown size={14} className="work-trace-caret" aria-hidden="true" />
    </button>
  );
}

function pluralize(count: number, singular: string, many = `${singular}s`) {
  return `${count.toLocaleString()} ${count === 1 ? singular : many}`;
}

function summaryText(summary: TraceSummary, thinking: boolean): string {
  return [
    pluralize(summary.steps, "step"),
    summary.checks ? `${pluralize(summary.checks, "check")} passed` : "",
    summary.flags ? pluralize(summary.flags, "flag") : "",
    thinking ? "thinking" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function isAgentRun(message: ChatMessage, steps: TraceStep[]): boolean {
  const runtime = message.metadata?.chatRuntime as ChatRuntimeOptions | undefined;
  return Boolean(runtime?.agentEnabled) || steps.some((step) => step.kind === "agent");
}

function completeTitle(message: ChatMessage, agent: boolean): string {
  if (typeof message.durationMs !== "number") return agent ? "Agent work trace" : "Work trace";
  return `${agent ? "Agent worked" : "Worked"} for ${formatTraceDuration(message.durationMs)}`;
}

/** The running line names the step in progress; a live "Thinking" step's
 * own seconds would only repeat the timer beside it. */
function currentText(step: TraceStep): string {
  return step.detail && !step.id.endsWith(":live") ? `${step.label} · ${step.detail}` : step.label;
}

/** The status line under a streaming reply. A long code block scrolls the
 * trace out of view, so this line carries its live action ("Writing html ·
 * 412 lines") to where the reader is looking. Screen readers hear one steady
 * "Streaming reply…" instead of a ticking line counter. */
export function WorkTraceStreamStatus({ message }: { message: ChatMessage }) {
  const startedAt = message.startedAtMs ?? Date.now();
  const view = liveTraceView(message.activityTrace ?? [], {
    content: message.content,
    startedAtMs: startedAt,
    nowMs: Date.now(),
  });
  return (
    <div className="message-stream-status" role="status" aria-live="polite">
      <span className="message-stream-dot" aria-hidden="true" />
      <span className="sr-only">Streaming reply…</span>
      <span aria-hidden="true">{currentText(view.current)}</span>
    </div>
  );
}

/** How long each step holds the reader's eye before the next one lands.
 * Steps arrive in bursts (everything gathered before the model starts, then
 * the checks once it ends), so the timeline plays them in one at a time
 * instead of showing a single line and then everything at once. */
export const STEP_REVEAL_MS = 600;

type Reveal = {
  /** The run this reveal belongs to; a regenerated reply starts a new one. */
  runStartedAt: number | undefined;
  /** Seen while it ran, so its steps play in (a trace from history does not). */
  live: boolean;
  expanded: boolean;
  shown: number;
};

function freshReveal(pending: boolean, runStartedAt: number | undefined, total: number): Reveal {
  return { runStartedAt, live: pending, expanded: pending, shown: pending ? Math.min(total, 1) : total };
}

/** "Thought for 4s" is the Thinking row finishing, not a new step: when
 * every step before it is on screen it shows at once, in that row's place. */
function throughThinking(shown: number, steps: TraceStep[]): number {
  return steps[shown]?.kind === "think" ? shown + 1 : shown;
}

/** Which steps are on screen. A run the reader is watching opens its
 * timeline and adds one step every STEP_REVEAL_MS, carrying on after the
 * reply finishes; the reveal survives that hand-off because it lives here,
 * above both the running and the finished views. */
function useTraceReveal(pending: boolean, runStartedAt: number | undefined, steps: TraceStep[]) {
  const total = steps.length;
  const [reveal, setReveal] = useState(() => freshReveal(pending, runStartedAt, total));
  let current = reveal;
  if (pending && (!reveal.live || reveal.runStartedAt !== runStartedAt)) {
    current = freshReveal(true, runStartedAt, total);
    setReveal(current);
  }
  const shown = current.live ? Math.min(throughThinking(current.shown, steps), total) : total;
  // The pace is set by steps shown, not steps arriving: a new arrival must
  // not restart the wait, or a fast stream of steps would stall the reveal.
  const behind = shown < total;
  useEffect(() => {
    if (!behind) return;
    const timer = window.setTimeout(() => setReveal((value) => ({ ...value, shown: shown + 1 })), STEP_REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [shown, behind]);

  // The steps play in only while the trace opened itself for a run the reader
  // is watching. Opening a finished reply's trace by hand shows all of it.
  const toggle = () =>
    setReveal((value) => ({
      ...value,
      expanded: !value.expanded,
      shown: !pending && !value.expanded ? total : value.shown,
    }));
  return { expanded: current.expanded, shown, toggle };
}

/** A clock that ticks once a second while the reply runs. */
function useRunningClock(running: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [running]);
  return now;
}

type RunningView = { steps: TraceStep[]; activeIndex: number; current: TraceStep; upNext: string };

/** The running timeline cut to the steps on screen. Facts still playing in
 * land above the live "Thinking" step, which stays last and in progress so
 * it never blinks out; once the reply streams (no live step), the newest
 * step on screen is the one in progress until the reveal catches up. */
function visibleRunningView(message: ChatMessage, startedAt: number, now: number, shown: number): RunningView {
  const view = liveTraceView(message.activityTrace ?? [], { content: message.content, startedAtMs: startedAt, nowMs: now });
  const recorded = readTrace(message.activityTrace).length;
  if (shown >= recorded) return view;
  const steps = [...view.steps.slice(0, Math.max(shown, 1)), ...view.steps.slice(recorded)];
  const activeIndex = steps.length - 1;
  return { steps, activeIndex, current: steps[activeIndex]!, upNext: view.upNext };
}

function RunningBar({
  assistantName,
  view,
  elapsedMs,
  expanded,
  onToggle,
  onStop,
}: {
  assistantName: string;
  view: RunningView;
  elapsedMs: number;
  expanded: boolean;
  onToggle: () => void;
  onStop?: () => void;
}) {
  return (
    <div className="work-trace-bar">
      <ToggleButton expanded={expanded} onToggle={onToggle}>
        <TraceGlyph kind={view.current.kind} active />
        <span className="work-trace-title">{assistantName} is working</span>
        <span className="work-trace-time">{formatTraceDuration(elapsedMs)}</span>
        {!expanded && (
          <span className="work-trace-now" key={`${view.current.id}|${view.current.label}`}>
            {currentText(view.current)}
          </span>
        )}
      </ToggleButton>
      {onStop && (
        <button
          className="work-trace-stop"
          type="button"
          aria-label="Stop this response"
          data-tooltip="Stop this response; the conversation is kept"
          onClick={onStop}
        >
          · stop
        </button>
      )}
    </div>
  );
}

function FinishedBar({
  title,
  summary,
  expanded,
  onToggle,
}: {
  title: string;
  summary: TraceSummary & { thinking: boolean };
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="work-trace-bar">
      <ToggleButton expanded={expanded} onToggle={onToggle}>
        <TraceGlyph kind={summary.flags ? "flag" : "done"} />
        <span className="work-trace-title">{title}</span>
        <span className="work-trace-summary">{summaryText(summary, summary.thinking)}</span>
      </ToggleButton>
    </div>
  );
}

function traceClassName(pending: boolean, flags: number, expanded: boolean): string {
  const phase = pending ? "is-running" : `is-complete${flags ? " has-flags" : ""}`;
  return `work-trace ${phase}${expanded ? " is-expanded" : ""}`;
}

/** The timeline: the steps on screen, the one in progress, and (while the
 * reply runs) what comes next. */
function TraceSteps({ steps, running }: { steps: TraceStep[]; running: RunningView | null }) {
  return (
    <ol className="work-trace-steps" aria-label={running ? "Steps so far" : "Steps"}>
      {steps.map((step, index) => (
        <TraceStepItem key={step.id} step={step} active={index === running?.activeIndex} />
      ))}
      {running && (
        <li className="work-trace-step is-next" data-kind="next">
          <TraceGlyph kind="next" />
          <span className="work-trace-step-text">
            <strong>Next</strong>
            <small>{running.upNext}</small>
          </span>
        </li>
      )}
    </ol>
  );
}

/** What sits under the bar: the timeline when open; folded, the next step
 * while running; and, once finished and open, the model's exposed thinking. */
function TraceBody({
  steps,
  running,
  expanded,
  thinkingTraces,
}: {
  steps: TraceStep[];
  running: RunningView | null;
  expanded: boolean;
  thinkingTraces: string[];
}) {
  if (!expanded) {
    return running ? (
      <p className="work-trace-next">
        <span className="work-trace-next-label">Next</span>
        <span>{running.upNext}</span>
      </p>
    ) : null;
  }
  return (
    <>
      <TraceSteps steps={steps} running={running} />
      {!running && thinkingTraces.length > 0 && <ThinkingTraces traces={thinkingTraces} />}
    </>
  );
}

/** What the assistant did for one reply, drawn on the page itself rather than
 * in a card. While it works the timeline is open and each step lands as the
 * run reaches it (with a stop, and what comes next); afterwards the header
 * says how long it worked and what its checks found. Either can fold to one
 * line. One list element serves both phases, so the steps already on screen
 * stay put when the reply finishes. */
export function WorkTrace({
  message,
  brandName,
  state,
  onStop,
  thinkingTraces = [],
  upNext,
}: {
  message: ChatMessage;
  brandName: string;
  state: "pending" | "complete";
  onStop?: () => void;
  thinkingTraces?: string[];
  /** A run with a planned path says what comes next instead of the reply's default. */
  upNext?: string;
}) {
  const assistantName = brandName || "The assistant";
  const pending = state === "pending";
  const now = useRunningClock(pending);
  const steps = readTrace(message.activityTrace);
  const reveal = useTraceReveal(pending, message.startedAtMs, steps);
  const startedAt = message.startedAtMs ?? now;
  const view = pending ? visibleRunningView(message, startedAt, now, reveal.shown) : null;
  const running = view && upNext ? { ...view, upNext } : view;
  const summary = traceSummary(steps);

  return (
    <div
      className={traceClassName(pending, summary.flags, reveal.expanded)}
      role={pending ? "status" : "region"}
      aria-live={pending ? "polite" : undefined}
      aria-label={`${assistantName} activity trace`}
    >
      {running ? (
        <RunningBar
          assistantName={assistantName}
          view={running}
          elapsedMs={now - startedAt}
          expanded={reveal.expanded}
          onToggle={reveal.toggle}
          onStop={onStop}
        />
      ) : (
        <FinishedBar
          title={completeTitle(message, isAgentRun(message, steps))}
          summary={{ ...summary, thinking: thinkingTraces.length > 0 }}
          expanded={reveal.expanded}
          onToggle={reveal.toggle}
        />
      )}
      <TraceBody
        steps={running ? running.steps : steps.slice(0, reveal.shown)}
        running={running}
        expanded={reveal.expanded}
        thinkingTraces={thinkingTraces}
      />
    </div>
  );
}
