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

function RunningTrace({
  message,
  assistantName,
  onStop,
}: {
  message: ChatMessage;
  assistantName: string;
  onStop?: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [expanded, setExpanded] = useState(false);
  const startedAt = message.startedAtMs ?? now;
  const view = liveTraceView(message.activityTrace ?? [], { content: message.content, startedAtMs: startedAt, nowMs: now });

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <div
      className={`work-trace is-running${expanded ? " is-expanded" : ""}`}
      role="status"
      aria-live="polite"
      aria-label={`${assistantName} activity trace`}
    >
      <div className="work-trace-bar">
        <ToggleButton expanded={expanded} onToggle={() => setExpanded((value) => !value)}>
          <TraceGlyph kind={view.current.kind} active />
          <span className="work-trace-title">{assistantName} is working</span>
          <span className="work-trace-time">{formatTraceDuration(now - startedAt)}</span>
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
      {expanded ? (
        <ol className="work-trace-steps" aria-label="Steps so far">
          {view.steps.map((step, index) => (
            <TraceStepItem key={step.id} step={step} active={index === view.activeIndex} />
          ))}
          <li className="work-trace-step is-next" data-kind="next">
            <TraceGlyph kind="next" />
            <span className="work-trace-step-text">
              <strong>Next</strong>
              <small>{view.upNext}</small>
            </span>
          </li>
        </ol>
      ) : (
        <p className="work-trace-next">
          <span className="work-trace-next-label">Next</span>
          <span>{view.upNext}</span>
        </p>
      )}
    </div>
  );
}

function FinishedTrace({
  message,
  assistantName,
  thinkingTraces,
}: {
  message: ChatMessage;
  assistantName: string;
  thinkingTraces: string[];
}) {
  const [expanded, setExpanded] = useState(false);
  const steps = readTrace(message.activityTrace);
  const summary = traceSummary(steps);
  const hasThinking = thinkingTraces.length > 0;

  return (
    <div
      className={`work-trace is-complete${summary.flags ? " has-flags" : ""}${expanded ? " is-expanded" : ""}`}
      role="region"
      aria-label={`${assistantName} activity trace`}
    >
      <div className="work-trace-bar">
        <ToggleButton expanded={expanded} onToggle={() => setExpanded((value) => !value)}>
          <TraceGlyph kind={summary.flags ? "flag" : "done"} />
          <span className="work-trace-title">{completeTitle(message, isAgentRun(message, steps))}</span>
          <span className="work-trace-summary">{summaryText(summary, hasThinking)}</span>
        </ToggleButton>
      </div>
      {expanded && (
        <ol className="work-trace-steps" aria-label="Steps">
          {steps.map((step) => (
            <TraceStepItem key={step.id} step={step} />
          ))}
        </ol>
      )}
      {expanded && hasThinking && <ThinkingTraces traces={thinkingTraces} />}
    </div>
  );
}

/** What the assistant did for one reply, drawn on the page itself rather than
 * in a card: a single quiet line while it works (what it is doing now, what
 * comes next, and a stop), and afterwards how long it worked and what its
 * checks found. Expanding either shows the full timeline. */
export function WorkTrace({
  message,
  brandName,
  state,
  onStop,
  thinkingTraces = [],
}: {
  message: ChatMessage;
  brandName: string;
  state: "pending" | "complete";
  onStop?: () => void;
  thinkingTraces?: string[];
}) {
  const assistantName = brandName || "The assistant";
  return state === "pending" ? (
    <RunningTrace message={message} assistantName={assistantName} onStop={onStop} />
  ) : (
    <FinishedTrace message={message} assistantName={assistantName} thinkingTraces={thinkingTraces} />
  );
}
