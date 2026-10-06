/** Diagrams that arrive in some other notation, converted to Mermaid so they
 * render as real figures in Aperture's palette instead of code panels.
 *
 * - Graphviz DOT (```dot / ```graphviz, or an untagged `digraph {…}`)
 * - PlantUML sequence and simple activity diagrams (```plantuml, @startuml)
 * - Text diagrams models draw inside ```text or untagged fences: arrow chains
 *   ("Core → Vessel → Heat exchanger"), numbered step / layer lists
 *   ("Layer 5: Containment"), and box-drawing art (┌──┐ / +--+ boxes joined
 *   by arrows).
 *
 * Every converter is conservative: it returns null unless the text is
 * clearly a diagram, so ordinary code and prose keep their code panels.
 */

export type ConvertedDiagram = {
  source: string;
  /** Prose lines that accompanied the drawing; shown under the figure so no
   * information is lost in the conversion. */
  notes?: string[];
};

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function mermaidLabel(text: string): string {
  return `"${text.replace(/"/g, "'").replace(/\s+/g, " ").trim()}"`;
}

class NodeIds {
  private ids = new Map<string, string>();
  get(key: string): string {
    const existing = this.ids.get(key);
    if (existing) return existing;
    const id = `n${this.ids.size + 1}`;
    this.ids.set(key, id);
    return id;
  }
  has(key: string) {
    return this.ids.has(key);
  }
}

/* ------------------------------------------------------------------ */
/* Graphviz DOT                                                        */
/* ------------------------------------------------------------------ */

const DOT_HEADER = /^\s*(?:strict\s+)?(di)?graph\b\s*("[^"]*"|[\w.-]+)?\s*\{/i;

export function looksLikeDot(text: string): boolean {
  return DOT_HEADER.test(stripDotComments(text)) && /}\s*$/.test(text.trim());
}

function stripDotComments(text: string) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*(?:\/\/|#).*$/gm, "")
    .replace(/([^:"])\/\/.*$/gm, "$1");
}

function parseDotAttributes(raw: string | undefined): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (!raw) return attributes;
  for (const match of raw.matchAll(/([\w-]+)\s*=\s*("(?:[^"\\]|\\.)*"|<[^>]*>|[^,;\]\s]+)/g)) {
    const key = match[1]!.toLowerCase();
    let value = match[2]!;
    if (value.startsWith('"')) value = value.slice(1, -1).replace(/\\"/g, '"');
    if (value.startsWith("<")) value = value.slice(1, -1).replace(/<[^>]+>/g, " ");
    attributes[key] = value.replace(/\\n|\\l|\\r/g, " ").replace(/\s+/g, " ").trim();
  }
  return attributes;
}

/** Splits DOT body text into statements, respecting quotes and brackets. */
function dotStatements(body: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quoted = false;
  let bracket = 0;
  for (const char of body) {
    if (char === '"' && !current.endsWith("\\")) quoted = !quoted;
    if (!quoted) {
      if (char === "[") bracket += 1;
      if (char === "]") bracket = Math.max(0, bracket - 1);
      if ((char === ";" || char === "\n") && bracket === 0) {
        if (current.trim()) statements.push(current.trim());
        current = "";
        continue;
      }
      if ((char === "{" || char === "}") && bracket === 0) {
        if (current.trim()) statements.push(current.trim());
        statements.push(char);
        current = "";
        continue;
      }
    }
    current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

const DOT_SHAPES: Record<string, [string, string]> = {
  diamond: ["{", "}"],
  ellipse: ["([", "])"],
  oval: ["([", "])"],
  circle: ["((", "))"],
  doublecircle: ["(((", ")))"],
  cylinder: ["[(", ")]"],
  hexagon: ["{{", "}}"],
  parallelogram: ["[/", "/]"],
};

export function convertDotToMermaid(text: string): ConvertedDiagram | null {
  const cleaned = stripDotComments(text);
  const header = DOT_HEADER.exec(cleaned);
  if (!header) return null;
  const directed = Boolean(header[1]);
  const body = cleaned.slice(header.index + header[0].length).replace(/}\s*$/, "");
  const ids = new NodeIds();
  const labels = new Map<string, string>();
  const shapes = new Map<string, [string, string]>();
  const fills = new Map<string, string>();
  const order: string[] = [];
  const lines: string[] = [];
  let direction = "TD";
  let title = "";
  const subgraphStack: string[] = [];
  let pendingSubgraph: string | null = null;
  let subgraphCount = 0;

  const nodeName = (raw: string) => raw.trim().replace(/^"|"$/g, "").replace(/:\w+$/, "");
  const touch = (name: string) => {
    if (!ids.has(name)) order.push(name);
    return ids.get(name);
  };

  for (const statement of dotStatements(body)) {
    if (statement === "{") {
      if (pendingSubgraph !== null) {
        subgraphCount += 1;
        const id = `sg${subgraphCount}`;
        lines.push(`  subgraph ${id}[${mermaidLabel(pendingSubgraph || " ")}]`);
        subgraphStack.push(id);
        pendingSubgraph = null;
      } else {
        subgraphStack.push("");
      }
      continue;
    }
    if (statement === "}") {
      if (subgraphStack.pop()) lines.push("  end");
      continue;
    }
    const subgraph = /^subgraph\s*("[^"]*"|[\w.-]+)?\s*$/i.exec(statement);
    if (subgraph) {
      pendingSubgraph = (subgraph[1] ?? "").replace(/^"|"$/g, "").replace(/^cluster_?/i, "").replace(/_/g, " ");
      continue;
    }
    const graphAttr = /^(?:graph\s*)?\[?\s*([\w-]+)\s*=\s*("[^"]*"|[^\]]+)\s*\]?$/i.exec(statement);
    if (graphAttr && !/->|--/.test(statement)) {
      const key = graphAttr[1]!.toLowerCase();
      const value = graphAttr[2]!.replace(/^"|"$/g, "").trim();
      if (key === "rankdir") direction = /^(LR|RL)$/i.test(value) ? "LR" : "TD";
      if (key === "label") {
        const current = subgraphStack[subgraphStack.length - 1];
        if (current) {
          const index = lines.lastIndexOf(lines.filter((line) => line.includes(`subgraph ${current}[`)).pop() ?? "");
          if (index >= 0) lines[index] = `  subgraph ${current}[${mermaidLabel(value)}]`;
        } else {
          title = value;
        }
      }
      continue;
    }
    if (/^(?:graph|node|edge)\s*\[/i.test(statement)) {
      const attributes = parseDotAttributes(/\[([\s\S]*)\]/.exec(statement)?.[1]);
      if (/^graph/i.test(statement) && attributes.rankdir) direction = /^(LR|RL)$/i.test(attributes.rankdir) ? "LR" : "TD";
      if (/^graph/i.test(statement) && attributes.label && !subgraphStack.some(Boolean)) title = attributes.label;
      continue;
    }
    const attributeText = /\[([\s\S]*)\]\s*$/.exec(statement)?.[1];
    const attributes = parseDotAttributes(attributeText);
    const core = attributeText !== undefined ? statement.slice(0, statement.lastIndexOf("[")).trim() : statement;
    const edgeParts = core.split(/\s*(->|--)\s*/);
    if (edgeParts.length >= 3) {
      const dashed = /dash|dot/.test(attributes.style ?? "");
      const bold = /bold/.test(attributes.style ?? "") || Number(attributes.penwidth ?? 0) >= 2;
      const arrow = !directed || attributes.dir === "none" ? "---" : dashed ? "-.->" : bold ? "==>" : "-->";
      for (let index = 0; index + 2 < edgeParts.length; index += 2) {
        const fromNames = edgeParts[index]!.replace(/^\{|\}$/g, "").split(/[\s,]+/).filter(Boolean).map(nodeName);
        const toNames = edgeParts[index + 2]!.replace(/^\{|\}$/g, "").split(/[\s,]+/).filter(Boolean).map(nodeName);
        for (const from of fromNames) {
          for (const to of toNames) {
            const label = attributes.label ? `|${mermaidLabel(attributes.label)}|` : "";
            lines.push(`  ${touch(from)} ${arrow}${label} ${touch(to)}`);
          }
        }
      }
      continue;
    }
    const name = nodeName(core);
    if (!name || /\s/.test(core.replace(/"[^"]*"/g, "x"))) continue;
    touch(name);
    if (attributes.label) labels.set(name, attributes.label);
    if (attributes.shape && DOT_SHAPES[attributes.shape.toLowerCase()]) {
      shapes.set(name, DOT_SHAPES[attributes.shape.toLowerCase()]!);
    }
    const fill = attributes.fillcolor ?? (attributes.style?.includes("filled") ? attributes.color : undefined);
    if (fill && /^#?[0-9a-f]{3,6}$|^[a-z]+$/i.test(fill)) fills.set(name, fill.startsWith("#") || /^[a-z]+$/i.test(fill) ? fill : `#${fill}`);
    if (subgraphStack.some(Boolean)) lines.push(`  ${ids.get(name)}`);
  }
  if (!order.length) return null;
  const declarations = order.map((name) => {
    const [open, close] = shapes.get(name) ?? ["[", "]"];
    return `  ${ids.get(name)}${open}${mermaidLabel(labels.get(name) ?? name)}${close}`;
  });
  const styles = [...fills.entries()].map(([name, fill]) => `  style ${ids.get(name)} fill:${fill}`);
  const header_ = title ? `---\ntitle: ${title.replace(/\n/g, " ")}\n---\n` : "";
  return { source: `${header_}flowchart ${direction}\n${[...declarations, ...lines, ...styles].join("\n")}` };
}

/* ------------------------------------------------------------------ */
/* PlantUML                                                            */
/* ------------------------------------------------------------------ */

export function looksLikePlantUml(text: string): boolean {
  return /^\s*@start(?:uml|activity|sequence)\b/i.test(text);
}

export function convertPlantUmlToMermaid(text: string): ConvertedDiagram | null {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^@(?:start|end)\w*/i.test(line) && !line.startsWith("'") && !/^skinparam\b/i.test(line) && !/^!/.test(line));
  if (!lines.length) return null;
  const sequenceArrow = /^("?[\w .]+"?)\s*(-+>{1,2}|<-+|-+\\\\?|\.+>)\s*("?[\w .]+"?)\s*(?::\s*(.*))?$/;
  const isActivity = lines.some((line) => /^(?:start|stop|end)$/i.test(line) || /^:.*;$/.test(line));
  if (isActivity) return convertPlantUmlActivity(lines);
  if (!lines.some((line) => sequenceArrow.test(line))) return null;

  const out: string[] = ["sequenceDiagram"];
  const alias = new Map<string, string>();
  const nameOf = (raw: string) => {
    const clean = raw.trim().replace(/^"|"$/g, "");
    const known = alias.get(clean);
    if (known) return known;
    const id = clean.replace(/[^\w]+/g, "_") || "P";
    if (id !== clean) {
      alias.set(clean, id);
      out.splice(1, 0, `  participant ${id} as ${clean}`);
    }
    return id;
  };
  for (const line of lines) {
    const title = /^title\s+(.+)$/i.exec(line);
    if (title) {
      out.splice(1, 0, `  title ${title[1]}`);
      continue;
    }
    const participant = /^(participant|actor|boundary|control|entity|database|collections|queue)\s+("?[^"]+?"?)(?:\s+as\s+(\w+))?(?:\s+#\w+)?$/i.exec(line);
    if (participant) {
      const label = participant[2]!.replace(/^"|"$/g, "");
      const id = participant[3] ?? label.replace(/[^\w]+/g, "_");
      alias.set(label, id);
      alias.set(id, id);
      out.push(`  ${participant[1]!.toLowerCase() === "actor" ? "actor" : "participant"} ${id}${id !== label ? ` as ${label}` : ""}`);
      continue;
    }
    const note = /^note\s+(left|right|over)\s+(?:of\s+)?([\w, ]+?)\s*:\s*(.+)$/i.exec(line);
    if (note) {
      const side = note[1]!.toLowerCase();
      out.push(`  Note ${side === "over" ? "over" : `${side} of`} ${note[2]!.split(",").map((part) => nameOf(part)).join(",")}: ${note[3]}`);
      continue;
    }
    const block = /^(alt|else|opt|loop|par|critical|break)\b\s*(.*)$/i.exec(line);
    if (block) {
      out.push(`  ${block[1]!.toLowerCase()} ${block[2] ?? ""}`.trimEnd());
      continue;
    }
    if (/^end$/i.test(line)) {
      out.push("  end");
      continue;
    }
    if (/^(?:activate|deactivate)\s+/i.test(line)) {
      const [keyword, who] = line.split(/\s+/);
      out.push(`  ${keyword!.toLowerCase()} ${nameOf(who ?? "")}`);
      continue;
    }
    const arrow = sequenceArrow.exec(line);
    if (arrow) {
      const reversed = arrow[2]!.startsWith("<");
      const dashed = /^-{2,}|\.+/.test(arrow[2]!.replace(/^<|>+$/g, "")) && arrow[2]!.replace(/[<>]/g, "").length >= 2;
      const from = nameOf(reversed ? arrow[3]! : arrow[1]!);
      const to = nameOf(reversed ? arrow[1]! : arrow[3]!);
      out.push(`  ${from}${dashed ? "-->>" : "->>"}${to}: ${arrow[4]?.trim() || " "}`);
    }
  }
  return out.length > 1 ? { source: out.join("\n") } : null;
}

function convertPlantUmlActivity(lines: string[]): ConvertedDiagram | null {
  const out: string[] = ["flowchart TD"];
  let counter = 0;
  let previous: string[] = [];
  const stack: { decision: string; branchEnds: string[]; label: string }[] = [];
  let pendingLabel = "";
  const link = (targets: string[], node: string) => {
    for (const from of targets) out.push(`  ${from} -->${pendingLabel ? `|${mermaidLabel(pendingLabel)}|` : ""} ${node}`);
    pendingLabel = "";
  };
  for (const line of lines) {
    if (/^start$/i.test(line)) {
      out.push(`  start(["Start"])`);
      previous = ["start"];
      continue;
    }
    if (/^(?:stop|end)$/i.test(line)) {
      out.push(`  stop(["End"])`);
      link(previous, "stop");
      previous = [];
      continue;
    }
    const action = /^:(.*);$/.exec(line);
    if (action) {
      const id = `a${++counter}`;
      out.push(`  ${id}[${mermaidLabel(action[1]!)}]`);
      link(previous, id);
      previous = [id];
      continue;
    }
    const ifMatch = /^if\s*\((.*)\)\s*then\s*(?:\((.*)\))?$/i.exec(line);
    if (ifMatch) {
      const id = `d${++counter}`;
      out.push(`  ${id}{${mermaidLabel(ifMatch[1]!)}}`);
      link(previous, id);
      stack.push({ decision: id, branchEnds: [], label: ifMatch[2] ?? "" });
      previous = [id];
      pendingLabel = ifMatch[2] ?? "";
      continue;
    }
    const elseMatch = /^else\s*(?:\((.*)\))?$/i.exec(line);
    if (elseMatch && stack.length) {
      const frame = stack[stack.length - 1]!;
      frame.branchEnds.push(...previous);
      previous = [frame.decision];
      pendingLabel = elseMatch[1] ?? "";
      continue;
    }
    if (/^endif$/i.test(line) && stack.length) {
      const frame = stack.pop()!;
      previous = [...frame.branchEnds, ...previous];
      continue;
    }
  }
  return counter > 0 ? { source: out.join("\n") } : null;
}

/* ------------------------------------------------------------------ */
/* Text diagrams: arrow chains, numbered lists, box art                */
/* ------------------------------------------------------------------ */

const ARROW_SPLIT = /\s*(?:→|⟶|➔|➜|➝|➞|⇒|⟹|-{1,2}>|=>)\s*/;
const UNICODE_ARROW = /→|⟶|➔|➜|➝|➞|⇒|⟹/;
const DOWN_ARROW_LINE = /^(?:↓|⬇|⇓|v|V|\||│|▼)(?:\s+(.{1,40}))?$/;
// Strong signals that a line is source code, not a drawing or prose.
const CODE_LIKE =
  /[{}]\s*$|;\s*$|^\s*(?:const|let|var|def|function|return|import|class|public|private|SELECT|INSERT|if|for|while|echo)\b|\w\([^)]*\)\s*(?:;|\{|$)|^\s*(?:\/\/|#!)|\$\w|==|!=|&&|\|\|/;

/** A step name, not a log field or a path: starts with a letter (or a
 * bracket/quote), no URL paths, clock times, or key=value pairs. */
function labelLike(segment: string) {
  return /^[\p{L}[("'“]/u.test(segment) && !/(?:^|\s)\/[\w/]|\b\d{1,2}:\d{2}\b|\w=\S/.test(segment);
}

function chainSegments(line: string): string[] | null {
  const trimmed = line.trim();
  if (!ARROW_SPLIT.test(trimmed)) return null;
  const unicode = UNICODE_ARROW.test(trimmed);
  // ASCII arrows must be spaced (` -> `) so code like `obj->value` never matches.
  if (!unicode && !/\s(?:-{1,2}>|=>)\s/.test(trimmed)) return null;
  if (CODE_LIKE.test(trimmed)) return null;
  const segments = trimmed.split(ARROW_SPLIT).map((segment) => segment.trim());
  if (segments.length < 2 || segments.some((segment) => !segment || segment.length > 80)) return null;
  // ASCII arrows also appear in logs and shell output; every step must read
  // like a name. Unicode arrows are a drawing choice and are trusted more.
  if (!unicode && !segments.every(labelLike)) return null;
  return segments;
}

function isHeadingLine(line: string) {
  const trimmed = line.trim();
  return /:$/.test(trimmed) && trimmed.length <= 70 && !ARROW_SPLIT.test(trimmed);
}

function stripNodeDecor(text: string) {
  return text.replace(/^\[|\]$/g, "").replace(/^\*\*|\*\*$/g, "").trim();
}

/** Arrow-chain notes: "A → B → C" lines (with optional "Heading:" lines that
 * group the chains) become a flowchart; identical step names are the same
 * node, so a loop drawn as text closes into a real cycle. */
function convertArrowChains(text: string): ConvertedDiagram | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  type Section = { title: string; chains: string[][]; prose: string[] };
  const sections: Section[] = [{ title: "", chains: [], prose: [] }];
  const notes: string[] = [];
  let chainCount = 0;
  let segmentCount = 0;
  let vertical: string[] = [];
  let sawDownArrow = false;

  const flushVertical = () => {
    if (vertical.length >= 2 && sawDownArrow) {
      sections[sections.length - 1]!.chains.push(vertical);
      chainCount += 1;
      segmentCount += vertical.length;
    } else if (vertical.length) {
      sections[sections.length - 1]!.prose.push(...vertical);
    }
    vertical = [];
    sawDownArrow = false;
  };

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    if (CODE_LIKE.test(trimmed) && !UNICODE_ARROW.test(trimmed)) return null;
    const down = DOWN_ARROW_LINE.exec(trimmed);
    if (down && vertical.length) {
      sawDownArrow = true;
      continue;
    }
    const segments = chainSegments(trimmed);
    if (segments) {
      flushVertical();
      sections[sections.length - 1]!.chains.push(segments);
      chainCount += 1;
      segmentCount += segments.length;
      continue;
    }
    if (isHeadingLine(trimmed)) {
      flushVertical();
      sections.push({ title: trimmed.replace(/:$/, ""), chains: [], prose: [] });
      continue;
    }
    if (trimmed.length <= 60 && !/[.!?]$/.test(trimmed)) {
      // Possible node of a vertical (↓) chain.
      if (vertical.length && !sawDownArrow) {
        sections[sections.length - 1]!.prose.push(...vertical);
        vertical = [];
      }
      vertical.push(trimmed);
      continue;
    }
    flushVertical();
    sections[sections.length - 1]!.prose.push(trimmed);
  }
  flushVertical();

  if (chainCount === 0 || segmentCount < 3) return null;
  let used = sections.filter((section) => section.chains.length || section.prose.length || section.title);
  // A heading with nothing under it, ahead of the drawing, is its title.
  let title = "";
  while (used.length > 1 && used[0]!.title && !used[0]!.chains.length && !used[0]!.prose.length) {
    title = title || used[0]!.title;
    used = used.slice(1);
  }
  const ids = new NodeIds();
  const out: string[] = [];
  const grouped = used.filter((section) => section.title).length >= 2;
  const longest = Math.max(...used.flatMap((section) => section.chains.map((chain) => chain.length)));
  const anyVertical = text.split("\n").some((line) => DOWN_ARROW_LINE.test(line.trim()));
  const direction = grouped || anyVertical || longest > 5 ? "TD" : "LR";
  out.push(`flowchart ${direction}`);
  used.forEach((section, index) => {
    const inGroup = grouped && Boolean(section.title);
    if (!inGroup && section.title && !title) title = section.title;
    if (inGroup) {
      out.push(`  subgraph s${index + 1}[${mermaidLabel(section.title)}]`);
      out.push("    direction LR");
    }
    const indent = inGroup ? "    " : "  ";
    const scope = inGroup ? `${index}:` : "";
    for (const chain of section.chains) {
      const labels = chain.map(stripNodeDecor);
      // Across chains the same name is the same node (chains join up); within
      // one chain a repeat is a new node unless it closes the loop back to
      // the chain's first step ("Vessel → Pipe → Pump → Vessel").
      const seen = new Map<string, number>();
      const keys = labels.map((label, position) => {
        const base = `${scope}${label.toLowerCase()}`;
        if (position > 0 && label.toLowerCase() === labels[0]!.toLowerCase()) return base;
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        return count === 0 ? base : `${base}#${count}`;
      });
      for (let step = 0; step + 1 < labels.length; step += 1) {
        const from = ids.get(keys[step]!);
        const to = ids.get(keys[step + 1]!);
        out.push(`${indent}${from}[${mermaidLabel(labels[step]!)}] --> ${to}[${mermaidLabel(labels[step + 1]!)}]`);
      }
    }
    if (inGroup && !section.chains.length && section.prose.length) {
      const id = ids.get(`${scope}prose`);
      out.push(`${indent}${id}[${mermaidLabel(section.prose.map(stripNodeDecor).join(" "))}]`);
    } else {
      notes.push(...section.prose);
    }
    if (inGroup) out.push("  end");
  });
  // Stack the groups top to bottom in the order written (Mermaid would
  // otherwise set unconnected groups side by side and shrink them).
  const groupIds = used.map((section, index) => (grouped && section.title ? `s${index + 1}` : null)).filter(Boolean);
  for (let index = 0; index + 1 < groupIds.length; index += 1) out.push(`  ${groupIds[index]} ~~~ ${groupIds[index + 1]}`);
  const source = (title ? `---\ntitle: ${title}\n---\n` : "") + out.join("\n");
  return { source, notes: notes.length ? notes : undefined };
}

const NUMBERED_LINE =
  /^(?:[-*]\s+)?(Layer|Level|Tier|Barrier|Ring|Shell|Step|Stage|Phase)\s+(\d+|[IVX]+)\s*[:.)—–-]\s*(.+)$/i;

/** "Step 1: …" lists become a flow; "Layer 5: …" lists become a stacked
 * block diagram in list order (outermost first, as written). */
function convertNumberedList(text: string): ConvertedDiagram | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
  const items: { kind: string; number: string; text: string }[] = [];
  let title = "";
  for (const [index, line] of lines.entries()) {
    const match = NUMBERED_LINE.exec(line);
    if (match) {
      items.push({ kind: match[1]!, number: match[2]!, text: match[3]!.trim() });
      continue;
    }
    if (index === 0 && isHeadingLine(line)) {
      title = line.replace(/:$/, "");
      continue;
    }
    return null;
  }
  if (items.length < 3) return null;
  const kind = items[0]!.kind.toLowerCase();
  if (!items.every((item) => item.kind.toLowerCase() === kind)) return null;
  const front = title ? `---\ntitle: ${title}\n---\n` : "";
  if (["step", "stage", "phase"].includes(kind)) {
    const horizontal = items.length <= 4 && items.every((item) => item.text.length <= 36);
    const out = [`flowchart ${horizontal ? "LR" : "TD"}`];
    items.forEach((item, index) => {
      out.push(`  s${index + 1}["\`**${item.kind} ${item.number}**\n${item.text.replace(/["`]/g, "'")}\`"]`);
      if (index > 0) out.push(`  s${index} --> s${index + 1}`);
    });
    return { source: front + out.join("\n") };
  }
  const out = ["block-beta", "  columns 1"];
  items.forEach((item, index) => {
    out.push(`  l${index + 1}["${item.kind} ${item.number} — ${item.text.replace(/["`]/g, "'")}"]`);
  });
  // Alternate soft bands from the outside in; the innermost layer is the
  // deep core in brand ink. (Hexes snap to palette roles at render time.)
  items.forEach((_, index) => {
    const tone = index === items.length - 1 ? "#12384a" : index % 2 === 0 ? "#e4f3f5" : "#f4f8f9";
    out.push(`  style l${index + 1} fill:${tone}`);
  });
  return { source: front + out.join("\n") };
}

const BOX_CORNERS_TL = new Set(["┌", "╭", "╔", "+"]);
const BOX_CORNERS_TR = new Set(["┐", "╮", "╗", "+"]);
const BOX_CORNERS_BL = new Set(["└", "╰", "╚", "+"]);
const BOX_CORNERS_BR = new Set(["┘", "╯", "╝", "+"]);
const BOX_H = new Set(["─", "━", "═", "-", "=", "┬", "┴", "╤", "╧", "+", "┼"]);
const BOX_V = new Set(["│", "┃", "║", "|", "├", "┤", "╟", "╢", "+", "┼"]);
const H_CONNECT = /^[\s─━═\-=~.·>▶►→<◀←]*$/;
const V_CONNECT = new Set(["│", "┃", "|", "v", "V", "▼", "↓", "^", "▲", "↑", ":", "┊", " "]);

type Box = { top: number; left: number; bottom: number; right: number; label: string };

export function looksLikeBoxArt(text: string): boolean {
  return (text.match(/[┌┐└┘╭╮╰╯╔╗╚╝]/g)?.length ?? 0) >= 4 || /\+-{2,}\+/.test(text);
}

function findBoxes(grid: string[][]): Box[] {
  const boxes: Box[] = [];
  const at = (row: number, col: number) => grid[row]?.[col] ?? " ";
  for (let top = 0; top < grid.length; top += 1) {
    for (let left = 0; left < (grid[top]?.length ?? 0); left += 1) {
      if (!BOX_CORNERS_TL.has(at(top, left))) continue;
      let right = left + 1;
      while (BOX_H.has(at(top, right)) && !BOX_CORNERS_TR.has(at(top, right))) right += 1;
      if (!BOX_CORNERS_TR.has(at(top, right)) || right - left < 3) {
        // "+" boxes: the run of "-" ends at the closing "+".
        if (at(top, left) !== "+" || at(top, right) !== "+" || right - left < 3) continue;
      }
      let bottom = top + 1;
      while (bottom < grid.length && BOX_V.has(at(bottom, left)) && !BOX_CORNERS_BL.has(at(bottom, left))) bottom += 1;
      if (!BOX_CORNERS_BL.has(at(bottom, left)) || bottom - top < 2) continue;
      if (!BOX_CORNERS_BR.has(at(bottom, right))) continue;
      let sides = true;
      for (let row = top + 1; row < bottom; row += 1) {
        if (!BOX_V.has(at(row, right))) sides = false;
      }
      if (!sides) continue;
      const label = Array.from({ length: bottom - top - 1 }, (_, offset) =>
        (grid[top + 1 + offset] ?? []).slice(left + 1, right).join("").trim(),
      )
        .filter(Boolean)
        .join("\n");
      boxes.push({ top, left, bottom, right, label });
    }
  }
  // Drop containers that wrap other boxes; keep the leaves.
  return boxes.filter(
    (box) =>
      !boxes.some(
        (other) =>
          other !== box && other.top > box.top && other.bottom < box.bottom && other.left > box.left && other.right < box.right,
      ),
  );
}

function convertBoxArt(text: string): ConvertedDiagram | null {
  if (!looksLikeBoxArt(text)) return null;
  const rows = text.replace(/\r\n/g, "\n").split("\n");
  const grid = rows.map((row) => Array.from(row));
  const boxes = findBoxes(grid).filter((box) => box.label);
  if (boxes.length < 2) return null;
  const edges: { from: number; to: number; label: string; both: boolean; undirected: boolean }[] = [];
  let horizontalEdges = 0;
  let verticalEdges = 0;

  boxes.forEach((a, ai) => {
    boxes.forEach((b, bi) => {
      if (ai === bi) return;
      // Horizontal: a to the left of b with a shared row.
      if (a.right < b.left) {
        for (let row = Math.max(a.top, b.top); row <= Math.min(a.bottom, b.bottom); row += 1) {
          const between = (grid[row] ?? []).slice(a.right + 1, b.left).join("");
          if (!between.trim()) continue;
          const lettersStripped = between.replace(/[A-Za-z0-9][\w\s'/&-]*[A-Za-z0-9]|[A-Za-z0-9]/, "");
          if (!H_CONNECT.test(lettersStripped)) continue;
          if (!/[─━═\-=~>▶►→<◀←]/.test(between)) continue;
          const right = /[>▶►→]\s*$/.test(between.trimEnd()) || /[>▶►→]/.test(between.slice(-3));
          const left = /^\s*[<◀←]/.test(between);
          const label = (/[A-Za-z0-9][\w\s'/&-]*[A-Za-z0-9]|[A-Za-z0-9]/.exec(between)?.[0] ?? "").trim();
          if (left && !right) edges.push({ from: bi, to: ai, label, both: false, undirected: false });
          else edges.push({ from: ai, to: bi, label, both: left && right, undirected: !left && !right });
          horizontalEdges += 1;
          return;
        }
      }
      // Vertical: a above b with a shared column.
      if (a.bottom < b.top) {
        for (let col = Math.max(a.left + 1, b.left + 1); col < Math.min(a.right, b.right); col += 1) {
          const cells = Array.from({ length: b.top - a.bottom - 1 }, (_, offset) => grid[a.bottom + 1 + offset]?.[col] ?? " ");
          if (!cells.length || cells.every((cell) => cell === " ")) continue;
          if (!cells.every((cell) => V_CONNECT.has(cell))) continue;
          const down = cells.some((cell) => /[vV▼↓]/.test(cell));
          const up = cells.some((cell) => /[\^▲↑]/.test(cell));
          if (up && !down) edges.push({ from: bi, to: ai, label: "", both: false, undirected: false });
          else edges.push({ from: ai, to: bi, label: "", both: up && down, undirected: !up && !down });
          verticalEdges += 1;
          return;
        }
      }
    });
  });

  const outside = rows
    .map((row, index) => ({ row, index }))
    .filter(({ index }) => !boxes.some((box) => index >= box.top && index <= box.bottom))
    .map(({ row }) => row.trim())
    .filter((row) => row && /[A-Za-z]{3}/.test(row) && !/[┌┐└┘│─]/.test(row));
  const out = [`flowchart ${horizontalEdges >= verticalEdges ? "LR" : "TD"}`];
  boxes.forEach((box, index) => {
    const lines = box.label.split("\n").map((line) => line.replace(/["`]/g, "'"));
    const label = lines.length > 1 ? `"\`**${lines[0]}**\n${lines.slice(1).join("\n")}\`"` : mermaidLabel(lines[0] ?? "");
    out.push(`  b${index + 1}[${label}]`);
  });
  for (const edge of edges) {
    const arrow = edge.undirected ? "---" : edge.both ? "<-->" : "-->";
    out.push(`  b${edge.from + 1} ${arrow}${edge.label ? `|${mermaidLabel(edge.label)}|` : ""} b${edge.to + 1}`);
  }
  return { source: out.join("\n"), notes: outside.length ? outside : undefined };
}

/** Converts a text-fence drawing into Mermaid, or null when the text is not
 * clearly a diagram. Order matters: box art first (it also contains arrows),
 * then numbered lists, then arrow chains. */
export function convertTextDiagram(text: string): ConvertedDiagram | null {
  if (!text.trim()) return null;
  return convertBoxArt(text) ?? convertNumberedList(text) ?? convertArrowChains(text);
}
