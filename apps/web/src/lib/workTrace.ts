/** The chat work trace: what Aperture actually did for one reply.
 *
 * Nothing here is a preset script. A trace starts with the route the user
 * chose, grows with the facts the API streams (knowledge found, web results,
 * tool calls, continuation rounds, screening), discovers steps from the reply
 * as it streams (sections being drafted, code with live line counts,
 * diagrams, tables, images), and ends with checks run on the finished reply.
 *
 * Steps persist through the API's strict {id, label, detail} schema, so a
 * step's kind travels in its id as `<kind>:<slug>`. readTrace parses that once
 * into a typed step; ids from the older preset trace map onto kinds so saved
 * chats keep rendering.
 */

import { parseMarkdownBlocks, resolveDiagramBlock, type MarkdownBlock } from "./markdown";
import { parseStewardDiagram, parseStructuredSummaryDiagram } from "./stewardDiagram";
import type { ChatStreamActivity } from "./streamActivity";
import type { ChatActivityTraceStep, ChatCitation } from "./types";

export type TraceKind =
  | "route"
  | "agent"
  | "context"
  | "knowledge"
  | "web"
  | "fetch"
  | "attachments"
  | "memory"
  | "tools"
  | "skills"
  | "plan"
  | "privacy"
  | "screen"
  | "think"
  | "write"
  | "code"
  | "diagram"
  | "table"
  | "image"
  | "continue"
  | "resume"
  | "check"
  | "flag"
  | "save"
  | "done";

export type TraceStep = { id: string; kind: TraceKind; label: string; detail?: string };

const TRACE_KINDS = new Set<string>([
  "route", "agent", "context", "knowledge", "web", "fetch", "attachments", "memory", "tools", "skills",
  "plan", "privacy", "screen", "think", "write", "code", "diagram", "table", "image", "continue",
  "resume", "check", "flag", "save", "done",
]);

/** Ids from the preset trace saved before this one. `validator` claimed a
 * quality gate that never ran on a streamed chat reply, so it is dropped. */
const LEGACY_KINDS: Record<string, TraceKind | null> = {
  route: "route",
  context: "context",
  web: "web",
  knowledge: "knowledge",
  tools: "tools",
  attachments: "attachments",
  scope: "plan",
  visuals: "image",
  generate: "write",
  validator: null,
  finalize: "done",
};

/** Steps that can legitimately happen more than once in one reply. */
const REPEATABLE_KINDS = new Set<TraceKind>(["continue", "resume"]);

const CONTENT_KINDS = new Set<TraceKind>(["write", "code", "diagram", "table", "image"]);

/* ------------------------------------------------------------------ */
/* Small text helpers                                                  */
/* ------------------------------------------------------------------ */

function plural(count: number, singular: string, many = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : many}`;
}

function sentenceList(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

function stepOf(id: string, label: string, detail?: string): ChatActivityTraceStep {
  return detail ? { id, label, detail } : { id, label };
}

function kindOf(id: string): TraceKind | null {
  if (!id.includes(":")) return id in LEGACY_KINDS ? LEGACY_KINDS[id]! : "context";
  const prefix = id.split(":")[0]!;
  return TRACE_KINDS.has(prefix) ? (prefix as TraceKind) : "context";
}

function wholeSeconds(ms: number): number {
  return Math.max(0, Math.floor(ms / 1000));
}

/* ------------------------------------------------------------------ */
/* Reading and merging stored steps                                    */
/* ------------------------------------------------------------------ */

/** Stored steps → typed steps (the boundary for persisted traces). */
export function readTrace(steps: ChatActivityTraceStep[] = []): TraceStep[] {
  const read: TraceStep[] = [];
  for (const step of steps) {
    const kind = kindOf(step.id);
    if (kind === null) continue;
    read.push(step.detail ? { id: step.id, kind, label: step.label, detail: step.detail } : { id: step.id, kind, label: step.label });
  }
  return read;
}

/** Updates steps that already exist in place and appends new ones. */
function mergeSteps(trace: ChatActivityTraceStep[], steps: ChatActivityTraceStep[]): ChatActivityTraceStep[] {
  const byId = new Map(trace.map((step) => [step.id, step]));
  for (const step of steps) byId.set(step.id, step);
  return [...byId.values()];
}

function uniqueId(trace: ChatActivityTraceStep[], id: string): string {
  if (!trace.some((step) => step.id === id)) return id;
  let suffix = 2;
  while (trace.some((step) => step.id === `${id}-${suffix}`)) suffix += 1;
  return `${id}-${suffix}`;
}

/* ------------------------------------------------------------------ */
/* Route (send time)                                                   */
/* ------------------------------------------------------------------ */

export type TraceStart = {
  modelLabel: string;
  knowledge: number;
  tools: number;
  web: boolean;
  attachments: number;
};

/** The one thing known for certain at send time: where the request went,
 * with what the user switched on. Everything else is reported as it happens. */
export function startTrace(start: TraceStart): ChatActivityTraceStep[] {
  const parts = [
    start.knowledge > 0 ? plural(start.knowledge, "knowledge source") : "",
    start.web ? "web search" : "",
    start.tools > 0 ? plural(start.tools, "tool") : "",
    start.attachments > 0 ? plural(start.attachments, "attachment") : "",
  ].filter(Boolean);
  return [stepOf("route:model", `Routed to ${start.modelLabel}`, parts.length ? `With ${sentenceList(parts)}` : undefined)];
}

/* ------------------------------------------------------------------ */
/* Server-reported activity                                            */
/* ------------------------------------------------------------------ */

const ENGINE_LABELS: Record<string, string> = {
  searxng: "SearXNG",
  duckduckgo: "DuckDuckGo",
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
};

function webSteps(results: number, engine: string): ChatActivityTraceStep[] {
  if (results === 0) return [stepOf("web:search", "Searched the web", "No results came back.")];
  const via = engine ? `Via ${ENGINE_LABELS[engine] ?? engine}` : undefined;
  return [stepOf("web:search", `Searched the web · ${plural(results, "result")}`, via)];
}

function knowledgeSteps(passages: number, sources: number): ChatActivityTraceStep[] {
  if (passages === 0) return [stepOf("knowledge:hits", "Searched workspace knowledge", "No passages matched this request.")];
  return [
    stepOf("knowledge:hits", `Found ${plural(passages, "passage")} in workspace knowledge`, `From ${plural(sources, "source")}`),
  ];
}

function toolSteps(servers: number, calls: Array<{ name: string; ok: boolean }>): ChatActivityTraceStep[] {
  if (calls.length === 0) return [stepOf("tools:servers", `Connected ${plural(servers, "tool server")}`)];
  return calls.map((call, index) =>
    call.ok
      ? stepOf(`tools:call-${index + 1}`, `Ran ${call.name}`, "Its result was added to the context.")
      : stepOf(`flag:tool-${index + 1}`, `${call.name} returned an error`, "The reply was written without that result."),
  );
}

function skillSteps(skills: number, templates: number): ChatActivityTraceStep[] {
  const parts = [skills ? plural(skills, "skill") : "", templates ? plural(templates, "prompt template") : ""];
  return [stepOf("skills:loaded", `Loaded ${sentenceList(parts.filter(Boolean))}`)];
}

function requirementSteps(checks: Array<{ label: string; met: boolean }>): ChatActivityTraceStep[] {
  return checks.map((check, index) =>
    check.met
      ? stepOf(`check:req-${index + 1}`, `Verified: ${check.label}`)
      : stepOf(`flag:req-${index + 1}`, `Not met: ${check.label}`, "Regenerate or ask a follow-up to cover it."),
  );
}

function hermesSteps(memories: number, skills: string[], automations: string[]): ChatActivityTraceStep[] {
  const parts = [
    memories ? plural(memories, "memory", "memories") : "",
    ...skills.map((name) => `skill “${name}”`),
    ...automations.map((name) => `automation “${name}” proposed`),
  ].filter(Boolean);
  return [stepOf("save:hermes", "Hermes saved what it learned", parts.join(" · ") || undefined)];
}

type ActivityKind = ChatStreamActivity["kind"];
type StepBuilders = {
  [K in ActivityKind]: (activity: Extract<ChatStreamActivity, { kind: K }>) => ChatActivityTraceStep[];
};

const ACTIVITY_STEPS: StepBuilders = {
  agent: ({ name }) => [stepOf("agent:profile", `Working as ${name}`, "Its instructions, knowledge, and tools apply.")],
  privacy: () => [
    stepOf("privacy:prompt", "Concealed personal data in your message", "The model saw placeholders, not the original values."),
  ],
  knowledge: ({ passages, sources }) => knowledgeSteps(passages, sources),
  web: ({ results, engine }) => webSteps(results, engine),
  "web-provider": () => [
    stepOf("web:provider", "Handed web search to the model provider", "Its results arrive with the reply's citations."),
  ],
  fetch: ({ pages }) => [stepOf("fetch:pages", `Read ${plural(pages, "linked page")}`)],
  tools: ({ servers, calls }) => toolSteps(servers, calls),
  attachments: ({ files, images }) => [
    stepOf("attachments:files", `Read ${plural(files, "attachment")}`, images ? `Including ${plural(images, "image")}` : undefined),
  ],
  memory: ({ recalled, companion }) => [
    stepOf(
      "memory:recall",
      `Recalled ${plural(recalled + companion, "memory", "memories")}`,
      companion ? `${companion} from the agent's companion` : undefined,
    ),
  ],
  skills: ({ skills, templates }) => skillSteps(skills, templates),
  "requirements-noted": ({ count }) => [
    stepOf("plan:requirements", `Picked out ${plural(count, "thing")} to verify`, "Checked against the finished reply"),
  ],
  "requirements-checked": ({ checks }) => requirementSteps(checks),
  "screen-hold": () => [
    stepOf("screen:hold", "Holding the reply for content-rule screening", "It appears once screening finishes."),
  ],
  "screen-done": () => [stepOf("screen:done", "Screened the reply against content rules")],
  continue: ({ round }) => [stepOf(`continue:r${round}`, "Reached the output limit and kept writing", `Continuation ${round}`)],
  hermes: ({ memories, skills, automations }) => hermesSteps(memories, skills, automations),
  resume: ({ attempt }) => [
    stepOf(`resume:a${attempt}`, "Connection dropped — resumed where it left off", `Reconnect ${attempt}`),
  ],
};

function activitySteps(activity: ChatStreamActivity): ChatActivityTraceStep[] {
  const build = ACTIVITY_STEPS[activity.kind] as (activity: ChatStreamActivity) => ChatActivityTraceStep[];
  return build(activity);
}

/** Adds what the API reported. A repeated fact replaces its step; continuation
 * rounds and reconnects always add a new one. */
export function recordActivity(trace: ChatActivityTraceStep[], activity: ChatStreamActivity): ChatActivityTraceStep[] {
  let next = trace;
  for (const step of activitySteps(activity)) {
    const repeatable = REPEATABLE_KINDS.has(kindOf(step.id) as TraceKind);
    next = repeatable ? [...next, { ...step, id: uniqueId(next, step.id) }] : mergeSteps(next, [step]);
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* Steps discovered from the streamed reply                            */
/* ------------------------------------------------------------------ */

type ContentEvent =
  | { type: "intro" }
  | { type: "section"; title: string }
  | { type: "code"; language: string; lines: number; open: boolean }
  | { type: "diagram"; detail: string }
  | { type: "table"; rows: number }
  | { type: "image"; alt: string };

type EventType = ContentEvent["type"];

const MAX_TITLE = 60;

function cleanTitle(text: string): string {
  const plain = text.replace(/[*_`]/g, "").replace(/\s+#+\s*$/, "").trim();
  return plain.length > MAX_TITLE ? `${plain.slice(0, MAX_TITLE - 1).trimEnd()}…` : plain;
}

function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

/** Only the last fence can still be open: the reply ends inside it unless its
 * final line is a bare closing fence. */
function endsInsideFence(content: string, blocks: MarkdownBlock[]): boolean {
  if (blocks.at(-1)?.kind !== "code") return false;
  const lastLine = content.trimEnd().split("\n").at(-1)!;
  return !/^\s*(`{3,}|~{3,})\s*$/.test(lastLine);
}

function isHermesBlock(block: MarkdownBlock): boolean {
  return block.kind === "code" && block.language.trim().toLowerCase().startsWith("hermes-");
}

function diagramDetail(language: string, text: string): string | null {
  const diagram = resolveDiagramBlock(language, text);
  if (!diagram) return null;
  if (diagram.kind === "structure") return "Structure chart";
  return diagram.converted ? "Converted to Mermaid" : "Mermaid";
}

const INLINE_IMAGE = /!\[([^\]]*)\]\([^)\s]+\)/g;

function proseLines(block: MarkdownBlock): string[] {
  if (block.kind === "paragraph" || block.kind === "quote") return block.lines;
  if (block.kind === "list") return block.items;
  return [];
}

function codeEvent(block: Extract<MarkdownBlock, { kind: "code" }>, open: boolean): ContentEvent {
  const detail = diagramDetail(block.language, block.text);
  if (detail) return { type: "diagram", detail };
  return { type: "code", language: block.language.trim(), lines: lineCount(block.text), open };
}

function blockEvents(block: MarkdownBlock, open: boolean): ContentEvent[] {
  switch (block.kind) {
    case "heading":
      return block.level <= 3 ? [{ type: "section", title: cleanTitle(block.text) }] : [];
    case "code":
      return isHermesBlock(block) ? [] : [codeEvent(block, open)];
    case "table":
      return [{ type: "table", rows: block.rows.length }];
    case "image":
      return [{ type: "image", alt: cleanTitle(block.alt) }];
    default:
      return [...proseLines(block).join("\n").matchAll(INLINE_IMAGE)].map((match) => ({ type: "image", alt: cleanTitle(match[1]!) }));
  }
}

type Discovered = { events: ContentEvent[]; activeIndex: number };

function lastIndexWhere<T>(items: T[], test: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) if (test(items[index]!)) return index;
  return -1;
}

/** Prose under a heading belongs to that section; anything else is in
 * progress only while it is the last block of the reply. */
function activeEventIndex(blocks: MarkdownBlock[], events: Array<ContentEvent & { block: number }>): number {
  const lastBlock = blocks.length - 1;
  const last = blocks.at(-1);
  if (last && proseLines(last).length > 0) {
    const writing = lastIndexWhere(events, (event) => event.type === "section" || event.type === "intro");
    if (writing >= 0) return writing;
  }
  return lastIndexWhere(events, (event) => event.block === lastBlock);
}

/** The reply ends partway through an opening fence's info line ("```aperture-"
 * before "diagram" arrives): that fence is not a block yet. */
function endsInFenceOpener(content: string): boolean {
  const lastLine = content.split("\n").at(-1)!;
  return /^\s*(`{3,}|~{3,})[^`~]*$/.test(lastLine) && !/^\s*(`{3,}|~{3,})\s*$/.test(lastLine);
}

/** The reply's blocks, minus a fence whose opening line is still arriving,
 * and whether the last of them is a fence still being written. */
function settledBlocks(content: string): { blocks: MarkdownBlock[]; open: boolean } {
  const blocks = parseMarkdownBlocks(content);
  if (endsInFenceOpener(content)) return { blocks: blocks.slice(0, -1), open: false };
  return { blocks, open: endsInsideFence(content, blocks) };
}

function contentEvents(content: string): Discovered {
  const { blocks, open } = settledBlocks(content);
  const events: Array<ContentEvent & { block: number }> = [];
  let sawSection = false;
  blocks.forEach((block, index) => {
    if (!sawSection && proseLines(block).length > 0) events.push({ type: "intro", block: index });
    const found = blockEvents(block, open && index === blocks.length - 1);
    if (found.some((event) => event.type === "section")) sawSection = true;
    events.push(...found.map((event) => ({ ...event, block: index })));
  });
  return { events, activeIndex: activeEventIndex(blocks, events) };
}

type Grouping = { prefix: TraceKind; slug: string; cap: number; noun: string; nouns: string; doing: string; done: string };

const GROUPS: Record<Exclude<EventType, "intro">, Grouping> = {
  section: { prefix: "write", slug: "s", cap: 6, noun: "section", nouns: "sections", doing: "Drafting", done: "Drafted" },
  code: { prefix: "code", slug: "c", cap: 6, noun: "code block", nouns: "code blocks", doing: "Writing", done: "Wrote" },
  diagram: { prefix: "diagram", slug: "d", cap: 4, noun: "diagram", nouns: "diagrams", doing: "Drawing", done: "Drew" },
  table: { prefix: "table", slug: "t", cap: 4, noun: "table", nouns: "tables", doing: "Building", done: "Built" },
  image: { prefix: "image", slug: "i", cap: 4, noun: "image", nouns: "images", doing: "Placing", done: "Placed" },
};

function eventName(event: ContentEvent): string {
  switch (event.type) {
    case "section":
      return `“${event.title}”`;
    case "code":
      return event.language || "code";
    case "image":
      return event.alt ? `“${event.alt}”` : "an image";
    default:
      return `a ${event.type}`;
  }
}

/** What each kind of discovered block says about itself, besides its verb. */
function eventText(event: Exclude<ContentEvent, { type: "intro" }>): { what: string; detail?: string } {
  switch (event.type) {
    case "section":
      return { what: eventName(event) };
    case "code":
      return { what: eventName(event), detail: plural(event.lines, "line") };
    case "diagram":
      return { what: "a diagram", detail: event.detail };
    case "table":
      return { what: "a table", detail: plural(event.rows, "row") };
    case "image":
      return { what: "an image", detail: event.alt || undefined };
  }
}

function eventStep(event: Exclude<ContentEvent, { type: "intro" }>, id: string, active: boolean): ChatActivityTraceStep {
  const group = GROUPS[event.type];
  // Code is in progress only while its fence is still open.
  const inProgress = active && (event.type !== "code" || event.open);
  const { what, detail } = eventText(event);
  return stepOf(id, `${inProgress ? group.doing : group.done} ${what}`, detail);
}

function overflowStep(group: Grouping, extra: number, latest: string, active: boolean): ChatActivityTraceStep {
  const label = active
    ? `${group.doing} more ${group.nouns}`
    : `${group.done} ${extra.toLocaleString()} more ${extra === 1 ? group.noun : group.nouns}`;
  return stepOf(`${group.prefix}:more`, label, `${extra} more · latest ${latest}`);
}

type DiscoveredSteps = { steps: ChatActivityTraceStep[]; activeId: string | null };

function contentSteps(content: string, final: boolean): DiscoveredSteps {
  const { events, activeIndex } = contentEvents(content);
  const hasSections = events.some((event) => event.type === "section");
  const seen: Record<keyof typeof GROUPS, number> = { section: 0, code: 0, diagram: 0, table: 0, image: 0 };
  const steps = new Map<string, ChatActivityTraceStep>();
  let activeId: string | null = null;
  events.forEach((event, index) => {
    const active = !final && index === activeIndex;
    let step: ChatActivityTraceStep;
    if (event.type === "intro") {
      step = stepOf("write:intro", `${active ? "Writing" : "Wrote"} ${hasSections ? "the opening" : "the reply"}`);
    } else {
      const group = GROUPS[event.type];
      seen[event.type] += 1;
      const nth = seen[event.type];
      step =
        nth <= group.cap
          ? eventStep(event, `${group.prefix}:${group.slug}${nth}`, active)
          : overflowStep(group, nth - group.cap, eventName(event), active);
    }
    if (active) activeId = step.id;
    steps.set(step.id, step);
  });
  return { steps: [...steps.values()], activeId };
}

function hasStep(trace: ChatActivityTraceStep[], test: (kind: TraceKind | null, id: string) => boolean): boolean {
  return trace.some((step) => test(kindOf(step.id), step.id));
}

export type TraceProgress = {
  content: string;
  startedAtMs: number;
  nowMs: number;
  /** The reply is complete: every discovered step settles into the past tense. */
  final: boolean;
};

/** Folds the streamed reply into the trace: the first words record how long
 * the model thought, then each section, code block, diagram, table, and image
 * becomes a step the moment it appears. Idempotent for the same content. */
export function advanceTrace(trace: ChatActivityTraceStep[], progress: TraceProgress): ChatActivityTraceStep[] {
  if (!progress.content.trim()) return trace;
  let next = trace;
  const started = hasStep(trace, (kind, id) => kind === "think" || id === "screen:hold" || CONTENT_KINDS.has(kind as TraceKind));
  if (!started) {
    const seconds = Math.max(1, Math.round((progress.nowMs - progress.startedAtMs) / 1000));
    next = [...next, stepOf("think:first-token", `Thought for ${seconds}s`, "Time until the first words arrived")];
  }
  // Steps discovered from the reply always mirror it as it stands now, so a
  // step the stream outgrew (a fence that turned out to be a diagram) never
  // survives; steps the API reported stay where they happened.
  const discovered = contentSteps(progress.content, progress.final).steps;
  const current = new Set(discovered.map((step) => step.id));
  const kept = next.filter((step) => !CONTENT_KINDS.has(kindOf(step.id) as TraceKind) || current.has(step.id));
  return mergeSteps(kept, discovered);
}

/* ------------------------------------------------------------------ */
/* Checks on the finished reply                                        */
/* ------------------------------------------------------------------ */

const MAX_CHECKED_BLOCKS = 3;

type CodeBlock = Extract<MarkdownBlock, { kind: "code" }>;

function fenceChecks(content: string, blocks: MarkdownBlock[], code: CodeBlock[]): ChatActivityTraceStep[] {
  if (code.length === 0) return [];
  if (endsInsideFence(content, blocks)) {
    const language = (blocks.at(-1) as CodeBlock).language || "code";
    return [stepOf("flag:fences", "A code block was left open", `The reply ends inside a ${language} block, so it may be cut off.`)];
  }
  return [stepOf("check:fences", "Code blocks are all closed", plural(code.length, "fenced block"))];
}

function isHtmlPage(block: CodeBlock): boolean {
  return /<html[\s>]/i.test(block.text);
}

function htmlChecks(code: CodeBlock[]): ChatActivityTraceStep[] {
  return code
    .filter(isHtmlPage)
    .slice(0, MAX_CHECKED_BLOCKS)
    .map((block, index) =>
      /<\/html>/i.test(block.text)
        ? stepOf(`check:html-${index + 1}`, "HTML page is complete", `${plural(lineCount(block.text), "line")}, ending with </html>`)
        : stepOf(`flag:html-${index + 1}`, "HTML page ends early", "There's no closing </html> tag, so the page may be cut off."),
    );
}

function diagramCheck(block: CodeBlock, index: number): ChatActivityTraceStep[] {
  const diagram = resolveDiagramBlock(block.language, block.text);
  if (!diagram) return [];
  const id = `diagram-${index}`;
  if (diagram.kind === "mermaid") return [stepOf(`check:${id}`, "Diagram recognized", "Drawn from Mermaid source")];
  const model = parseStewardDiagram(diagram.source) ?? parseStructuredSummaryDiagram(diagram.source);
  if (!model) return [stepOf(`flag:${id}`, "Diagram needs repair", "Its structure didn't parse; use Edit or regenerate the reply.")];
  const boxes = model.rows.reduce((sum, row) => sum + row.length, 0);
  return [stepOf(`check:${id}`, "Structure diagram is valid", `${plural(boxes, "box", "boxes")} · ${plural(model.edges.length, "arrow")}`)];
}

function diagramChecks(code: CodeBlock[]): ChatActivityTraceStep[] {
  const checks: ChatActivityTraceStep[] = [];
  for (const block of code) {
    if (checks.length >= MAX_CHECKED_BLOCKS) break;
    checks.push(...diagramCheck(block, checks.length + 1));
  }
  return checks;
}

const CITATION_MARKER = /\[(K|U)([1-9][0-9]?)\]/g;
const MAX_LISTED_MARKERS = 4;

function proseText(blocks: MarkdownBlock[]): string {
  return blocks
    .map((block) => {
      if (block.kind === "heading") return block.text;
      if (block.kind === "table") return [...block.headers, ...block.rows.flat()].join(" ");
      return proseLines(block).join("\n");
    })
    .join("\n");
}

function markerHasSource(marker: string, citations: ChatCitation[]): boolean {
  const index = Number(marker.slice(1));
  return marker.startsWith("K")
    ? citations.some((citation) => citation.k_index === index)
    : citations.some((citation) => citation.id === `cite-fetch-${index}`);
}

function citationChecks(blocks: MarkdownBlock[], citations: ChatCitation[]): ChatActivityTraceStep[] {
  const markers = [...new Set([...proseText(blocks).matchAll(CITATION_MARKER)].map((match) => `${match[1]}${match[2]}`))];
  if (markers.length === 0) return [];
  const missing = markers.filter((marker) => !markerHasSource(marker, citations));
  if (missing.length === 0) {
    return [stepOf("check:citations", "Every citation links to a source", `${plural(markers.length, "marker")} matched`)];
  }
  const listed = missing.slice(0, MAX_LISTED_MARKERS).map((marker) => `[${marker}]`).join(", ");
  const more = missing.length > MAX_LISTED_MARKERS ? ", …" : "";
  return [stepOf("flag:citations", `Cites ${listed}${more} with no source`, "Those markers have nothing behind them in this reply.")];
}

/** Checks Aperture runs on the finished reply itself. A pass is a `check`
 * step, a problem a `flag` step that says what to do about it. */
export function selfChecks(content: string, citations: ChatCitation[]): ChatActivityTraceStep[] {
  const blocks = parseMarkdownBlocks(content);
  const code = blocks.filter((block): block is CodeBlock => block.kind === "code");
  return [
    ...fenceChecks(content, blocks, code),
    ...htmlChecks(code),
    ...diagramChecks(code),
    ...citationChecks(blocks, citations),
  ];
}

function proseWords(content: string): number {
  return proseText(parseMarkdownBlocks(content)).split(/\s+/).filter(Boolean).length;
}

/** Settles a finished reply's trace: every step in the past tense, the
 * checks on the reply, and the delivery. Finishing twice changes nothing. */
export function finishTrace(
  trace: ChatActivityTraceStep[],
  finish: { content: string; citations: ChatCitation[]; startedAtMs: number; nowMs: number },
): ChatActivityTraceStep[] {
  const settled = advanceTrace(trace, { ...finish, final: true });
  const words = proseWords(finish.content);
  const delivered = stepOf("done:reply", "Delivered the reply", words ? `≈ ${plural(words, "word")}` : undefined);
  return mergeSteps(settled, [...selfChecks(finish.content, finish.citations), delivered]);
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

export type LiveTraceView = {
  steps: TraceStep[];
  activeIndex: number;
  current: TraceStep;
  /** An honest hint at the next phase, never a promised step. */
  upNext: string;
};

/** The running trace: before the first words the model is thinking (or the
 * reply is held for screening); after that the step the reply is working on
 * right now is current — the section being drafted, the code being written. */
export function liveTraceView(
  trace: ChatActivityTraceStep[],
  live: { content: string; startedAtMs: number; nowMs: number },
): LiveTraceView {
  const steps = readTrace(trace);
  const hasContent = Boolean(live.content.trim());
  const held = steps.some((step) => step.id === "screen:hold") && !steps.some((step) => step.id === "screen:done");
  if (!hasContent) {
    const waited = `${wholeSeconds(live.nowMs - live.startedAtMs)}s`;
    steps.push(
      held
        ? { id: "screen:live", kind: "screen", label: "Writing behind the content screen", detail: waited }
        : { id: "think:live", kind: "think", label: "Thinking", detail: waited },
    );
  }
  const activeId = hasContent ? contentSteps(live.content, false).activeId : null;
  const found = activeId ? steps.findIndex((step) => step.id === activeId) : -1;
  const activeIndex = found >= 0 ? found : steps.length - 1;
  const upNext = hasContent
    ? "Check the work and finish"
    : held
      ? "Show the reply once it clears screening"
      : "Start writing the reply";
  return { steps, activeIndex, current: steps[activeIndex]!, upNext };
}

export type TraceSummary = { steps: number; checks: number; flags: number };

export function traceSummary(steps: TraceStep[]): TraceSummary {
  return {
    steps: steps.length,
    checks: steps.filter((step) => step.kind === "check").length,
    flags: steps.filter((step) => step.kind === "flag").length,
  };
}

/** "48s", "2m 05s", "1h 02m": a run's length at the precision a reader uses. */
export function formatTraceDuration(ms: number): string {
  const seconds = wholeSeconds(ms);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
