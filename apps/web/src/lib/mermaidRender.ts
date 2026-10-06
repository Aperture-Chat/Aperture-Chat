/** Shared Mermaid rendering for chat replies and Drafts documents.
 *
 * Mermaid stays a lazy Vite chunk (dynamic import) so the main bundle never
 * pays for it. Chat renders live SVG per theme; Drafts rasterizes to a PNG
 * data URL on the light palette because document pages are always white and
 * inline SVG does not survive the DOCX export or AI-revision round-trips.
 *
 * Every figure goes through the same pipeline: normalize (shared palette, no
 * theme overrides) → render → on a parse failure, repair common model slips
 * and render again → polish the SVG (rounded bars, line markers, donut pies)
 * → only if all of that fails, a drawn fallback. Timelines always use
 * Aperture's own renderer, which reads far better than Mermaid's at chat
 * widths.
 */

import { DIAGRAM_FONT_FAMILY, diagramPalette, type DiagramPalette } from "./diagramTheme";
import { isMindmapSource, renderMindmapSvg } from "./diagramMindmap";
import { measureDiagramText } from "./diagramText";
import { renderMermaidFallbackSvg } from "./mermaidFallback";
import { normalizeMermaidSource, repairMermaidSyntax } from "./mermaidRepair";
import { isMermaidTimelineSource, renderTimelineFallbackSvg, repairMermaidTimelineSource } from "./mermaidTimeline";

export const MERMAID_FONT_FAMILY = DIAGRAM_FONT_FAMILY;

function mermaidThemeCss(palette: DiagramPalette) {
  return `
    .node rect, .node .label-container, rect.basic { rx: 10px; ry: 10px; }
    .node rect, .node polygon, .node circle, .node ellipse, .node path.label-container { stroke-width: 1.3px; }
    .cluster rect { rx: 12px; ry: 12px; stroke-width: 1px; }
    .cluster-label text, .cluster-label tspan { font-weight: 600; fill: ${palette.cluster.text}; }
    .flowchart-link, .edgePath .path { stroke-width: 1.7px; stroke-linecap: round; stroke-linejoin: round; }
    .edgeLabel rect, .labelBkg { rx: 5px; ry: 5px; }
    .edgeLabel text, .edgeLabel tspan { fill: ${palette.muted}; font-size: 13px; }
    .marker, marker path { stroke-linejoin: round; }
    rect.actor { rx: 9px; ry: 9px; stroke-width: 1px; }
    text.actor, text.actor tspan { font-weight: 600; }
    .note, rect.note { rx: 7px; ry: 7px; }
    .messageText { font-size: 14px; }
    .labelBox { rx: 4px; }
    rect.task, rect.task0, rect.task1, rect.task2, rect.task3 { rx: 4px; ry: 4px; }
    .grid .tick line { stroke: ${palette.grid}; }
    .grid path { stroke-width: 0; }
    .grid .tick text { fill: ${palette.muted}; }
    .sectionTitle, .sectionTitle0, .sectionTitle1, .sectionTitle2, .sectionTitle3 { fill: ${palette.text}; font-weight: 600; }
    .titleText { font-weight: 700; fill: ${palette.text}; }
    .pieTitleText { font-weight: 700; fill: ${palette.text}; }
    .slice { font-weight: 600; paint-order: stroke; stroke: rgba(0, 0, 0, 0.28); stroke-width: 2px; }
    .legend text { fill: ${palette.text}; }
    .statediagram-state rect, .stateGroup rect { rx: 10px; ry: 10px; }
    .relationshipLabelBox { rx: 4px; }
    .mindmap-node rect { rx: 10px; ry: 10px; }
  `;
}

function mermaidConfig(dark: boolean) {
  const palette = diagramPalette(dark);
  const { series, tones } = palette;
  const pieSlots = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [`pie${index + 1}`, series[index % series.length]]),
  );
  // Timeline / mindmap / journey sections cycle through soft tone fills; the
  // first slot (mindmap root) is the brand ink.
  const scaleTones = [tones.accent, tones.info, tones.positive, tones.warning, tones.violet, tones.danger, tones.neutral];
  const scale = Object.fromEntries([
    ["cScale0", palette.ink],
    ["cScaleLabel0", palette.inkText],
    ["cScalePeer0", palette.inkBorder],
    ...Array.from({ length: 11 }, (_, index) => {
      const tone = scaleTones[index % scaleTones.length]!;
      return [
        [`cScale${index + 1}`, tone.fill],
        [`cScaleLabel${index + 1}`, tone.text],
        [`cScalePeer${index + 1}`, tone.border],
      ];
    }).flat(),
  ]);
  const git = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [
      [`git${index}`, series[index % series.length]],
      [`gitBranchLabel${index}`, "#ffffff"],
      [`gitInv${index}`, palette.canvas],
    ]).flat(),
  );
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    theme: "base" as const,
    look: "classic" as const,
    fontFamily: DIAGRAM_FONT_FAMILY,
    // A render-time failure must throw so the caller can repair or fall back
    // instead of drawing Mermaid's "Syntax error in text" bomb.
    suppressErrorRendering: true,
    // HTML (foreignObject) labels taint the canvas during SVG→PNG
    // rasterization (chat PNG download, Drafts document raster). The
    // top-level htmlLabels flag is the one that actually removes them —
    // flowchart.htmlLabels alone leaves foreignObject edge labels behind.
    htmlLabels: false,
    // Markdown-string labels ("`**Title**`") are the only rich-label syntax
    // that renders under strict security with SVG text — raw <b>/<i> tags come
    // out as literal text. Auto-wrap keeps long detail lines inside the box.
    markdownAutoWrap: true,
    fontSize: 15,
    themeCSS: mermaidThemeCss(palette),
    flowchart: {
      htmlLabels: false,
      curve: "rounded" as const,
      nodeSpacing: 44,
      rankSpacing: 58,
      padding: 14,
      wrappingWidth: 240,
      diagramPadding: 14,
    },
    sequence: {
      mirrorActors: false,
      actorMargin: 56,
      messageMargin: 38,
      boxMargin: 8,
      noteMargin: 12,
      actorFontFamily: DIAGRAM_FONT_FAMILY,
      noteFontFamily: DIAGRAM_FONT_FAMILY,
      messageFontFamily: DIAGRAM_FONT_FAMILY,
    },
    gantt: {
      // Lay out at chat-column width so labels are not shrunk to fit.
      useWidth: 820,
      barHeight: 22,
      barGap: 6,
      topPadding: 56,
      fontSize: 12,
      sectionFontSize: 12,
      numberSectionStyles: 2,
    },
    pie: { textPosition: 0.78 },
    quadrantChart: { pointRadius: 6, pointLabelFontSize: 12, titleFontSize: 18 },
    mindmap: { padding: 14, maxNodeWidth: 220 },
    xyChart: { titleFontSize: 18, plotReservedSpacePercent: 55 },
    class: { htmlLabels: false },
    themeVariables: {
      darkMode: dark,
      fontFamily: DIAGRAM_FONT_FAMILY,
      fontSize: "15px",
      background: palette.canvas,
      primaryColor: palette.node.fill,
      primaryTextColor: palette.node.text,
      primaryBorderColor: palette.node.border,
      secondaryColor: tones.accent.fill,
      secondaryTextColor: tones.accent.text,
      secondaryBorderColor: tones.accent.border,
      tertiaryColor: palette.cluster.fill,
      tertiaryTextColor: palette.text,
      tertiaryBorderColor: palette.cluster.border,
      mainBkg: palette.node.fill,
      nodeBorder: palette.node.border,
      nodeTextColor: palette.node.text,
      lineColor: palette.edge,
      textColor: palette.text,
      titleColor: palette.text,
      edgeLabelBackground: palette.canvas,
      clusterBkg: palette.cluster.fill,
      clusterBorder: palette.cluster.border,
      noteBkgColor: tones.warning.fill,
      noteTextColor: tones.warning.text,
      noteBorderColor: tones.warning.border,
      actorBkg: palette.ink,
      actorBorder: palette.inkBorder,
      actorTextColor: palette.inkText,
      actorLineColor: palette.axis,
      signalColor: palette.edgeStrong,
      signalTextColor: palette.text,
      labelBoxBkgColor: tones.accent.fill,
      labelBoxBorderColor: tones.accent.border,
      labelTextColor: tones.accent.text,
      loopTextColor: palette.text,
      activationBkgColor: tones.accent.fill,
      activationBorderColor: tones.accent.line,
      // Step numbers sit on a signal-colored disc: light ink on dark discs
      // (light theme), canvas-dark digits on light discs (dark theme).
      sequenceNumberColor: dark ? palette.canvas : palette.inkText,
      labelColor: palette.text,
      altBackground: palette.cluster.fill,
      compositeBackground: palette.cluster.fill,
      compositeTitleBackground: palette.node.fill,
      stateBkg: palette.node.fill,
      stateLabelColor: palette.node.text,
      specialStateColor: palette.ink,
      innerEndBackground: palette.ink,
      classText: palette.text,
      attributeBackgroundColorOdd: palette.canvas,
      attributeBackgroundColorEven: palette.node.fill,
      sectionBkgColor: palette.node.fill,
      altSectionBkgColor: palette.canvas,
      sectionBkgColor2: palette.node.fill,
      taskBkgColor: series[0],
      taskBorderColor: series[0],
      taskTextColor: "#ffffff",
      taskTextLightColor: "#ffffff",
      taskTextDarkColor: palette.text,
      taskTextOutsideColor: palette.text,
      taskTextClickableColor: tones.accent.text,
      activeTaskBkgColor: tones.accent.fill,
      activeTaskBorderColor: tones.accent.line,
      doneTaskBkgColor: palette.axis,
      doneTaskBorderColor: palette.edge,
      critBkgColor: tones.danger.line,
      critBorderColor: tones.danger.line,
      gridColor: palette.grid,
      todayLineColor: tones.danger.line,
      excludeBkgColor: palette.cluster.fill,
      ...pieSlots,
      pieTitleTextSize: "18px",
      pieTitleTextColor: palette.text,
      pieSectionTextSize: "13px",
      pieSectionTextColor: "#ffffff",
      pieLegendTextSize: "14px",
      pieLegendTextColor: palette.text,
      pieStrokeColor: palette.canvas,
      pieStrokeWidth: "2px",
      pieOuterStrokeWidth: "0px",
      pieOuterStrokeColor: palette.canvas,
      pieOpacity: "1",
      quadrant1Fill: tones.accent.fill,
      quadrant2Fill: tones.info.fill,
      quadrant3Fill: palette.node.fill,
      quadrant4Fill: tones.warning.fill,
      quadrant1TextFill: tones.accent.text,
      quadrant2TextFill: tones.info.text,
      quadrant3TextFill: palette.muted,
      quadrant4TextFill: tones.warning.text,
      quadrantPointFill: dark ? tones.accent.line : palette.ink,
      quadrantPointTextFill: palette.text,
      quadrantXAxisTextFill: palette.muted,
      quadrantYAxisTextFill: palette.muted,
      quadrantInternalBorderStrokeFill: palette.canvas,
      quadrantExternalBorderStrokeFill: palette.cluster.border,
      quadrantTitleFill: palette.text,
      ...scale,
      ...git,
      commitLabelColor: palette.text,
      commitLabelBackground: palette.node.fill,
      fillType0: tones.accent.fill,
      fillType1: tones.info.fill,
      fillType2: tones.positive.fill,
      fillType3: tones.warning.fill,
      fillType4: tones.violet.fill,
      fillType5: tones.danger.fill,
      fillType6: palette.node.fill,
      fillType7: tones.accent.fill,
      xyChart: {
        backgroundColor: palette.canvas,
        titleColor: palette.text,
        xAxisLabelColor: palette.muted,
        xAxisTitleColor: palette.muted,
        xAxisTickColor: palette.axis,
        xAxisLineColor: palette.axis,
        yAxisLabelColor: palette.muted,
        yAxisTitleColor: palette.muted,
        yAxisTickColor: palette.axis,
        yAxisLineColor: palette.axis,
        plotColorPalette: series.join(","),
      },
    },
  };
}

let mermaidModule: Promise<typeof import("mermaid").default> | null = null;
let mermaidActiveTheme: string | null = null;
let mermaidRenderId = 0;

function loadMermaid() {
  if (!mermaidModule) {
    mermaidModule = import("mermaid").then((module) => module.default);
  }
  return mermaidModule;
}

export function diagramTypeLabel(source: string) {
  const firstToken = source.trim().split(/\s+/)[0] ?? "";
  if (!firstToken || firstToken.startsWith("%%")) return "diagram";
  return firstToken
    .replace(/Diagram(-v\d+)?$/i, "")
    .replace(/-(beta|v\d+)$/i, "")
    .toLowerCase();
}

/** The single most common model slip that kills an otherwise-good flowchart:
 * a literal double quote inside a markdown-string label ("`…"uncrossing"…`")
 * terminates Mermaid's string early and the whole diagram falls back to a
 * code block. Swapping interior quotes for apostrophes inside backtick spans
 * keeps the reader's diagram rendering; the stored source stays untouched. */
export function repairMermaidLabelQuotes(source: string): string {
  return source.replace(/`[^`]*`/g, (span) => span.replace(/"/g, "'"));
}

export function prepareMermaidSource(source: string, dark = false): string {
  return repairMermaidTimelineSource(repairMermaidLabelQuotes(normalizeMermaidSource(source, dark))).trim();
}

export type MermaidRenderResult = {
  svg: string | null;
  error: string | null;
  /** True when Mermaid could not draw the source and the SVG is Aperture's
   * simplified drawing of the same data. */
  fallback?: boolean;
};

/** Renders Mermaid source to an SVG string, or null when the source does not
 * parse (partial streaming input, model mistakes). Never throws. */
export async function renderMermaidSvg(rawSource: string, dark: boolean): Promise<string | null> {
  return (await renderMermaidSvgResult(rawSource, dark)).svg;
}

/** Same as renderMermaidSvg, but keeps a readable error when drawing fails so
 * the chat figure can explain itself instead of silently becoming a code panel. */
export async function renderMermaidSvgResult(rawSource: string, dark: boolean): Promise<MermaidRenderResult> {
  const source = prepareMermaidSource(rawSource, dark);
  if (!source) return { svg: null, error: "The diagram source is empty." };
  // Timelines and mind maps use Aperture's own renderers: they read the
  // outlines models actually write and stay legible at chat widths.
  if (isMermaidTimelineSource(source)) {
    const timeline = renderTimelineFallbackSvg(source, dark, MERMAID_FONT_FAMILY);
    if (timeline) return { svg: timeline, error: null };
  }
  if (isMindmapSource(source)) {
    const mindmap = renderMindmapSvg(source, dark, MERMAID_FONT_FAMILY);
    if (mindmap) return { svg: mindmap, error: null };
  }
  let mermaid: typeof import("mermaid").default;
  try {
    mermaid = await loadMermaid();
    const themeKey = dark ? "dark" : "light";
    if (mermaidActiveTheme !== themeKey) {
      mermaid.initialize(mermaidConfig(dark));
      mermaidActiveTheme = themeKey;
    }
  } catch (error) {
    return fallbackMermaidSvg(source, dark, mermaidErrorMessage(error));
  }
  const attempt = await renderWithMermaid(mermaid, source, dark);
  if (attempt.svg) return attempt;
  const repaired = repairMermaidSyntax(source);
  if (repaired !== source) {
    const second = await renderWithMermaid(mermaid, repaired, dark);
    if (second.svg) return second;
  }
  return fallbackMermaidSvg(source, dark, attempt.error ?? "Mermaid could not render this diagram.");
}

async function renderWithMermaid(
  mermaid: typeof import("mermaid").default,
  source: string,
  dark: boolean,
): Promise<MermaidRenderResult> {
  const renderNodeId = `aperture-diagram-${++mermaidRenderId}`;
  try {
    const rendered = await mermaid.render(renderNodeId, source);
    // Sources can pass parse yet still fail at render; if mermaid returns
    // its error diagram instead of throwing, treat that as no render at all.
    if (
      !rendered.svg ||
      rendered.svg.includes('aria-roledescription="error"') ||
      rendered.svg.includes("Syntax error in text")
    ) {
      return { svg: null, error: "Mermaid could not parse this diagram." };
    }
    return { svg: polishMermaidSvg(rendered.svg, diagramPalette(dark)), error: null };
  } catch (error) {
    return { svg: null, error: mermaidErrorMessage(error) };
  } finally {
    // Mermaid parks a measuring container (id "d<render id>") in
    // document.body and leaves it behind when render fails — without this
    // cleanup a failed render strands an error SVG at the end of the page.
    document.getElementById(`d${renderNodeId}`)?.remove();
  }
}

function fallbackMermaidSvg(source: string, dark: boolean, error: string): MermaidRenderResult {
  const svg = renderMermaidFallbackSvg(source, dark, MERMAID_FONT_FAMILY);
  return svg ? { svg, error: null, fallback: true } : { svg: null, error, fallback: true };
}

function mermaidErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error.trim().slice(0, 240);
  if (error instanceof Error && error.message.trim()) {
    const first = error.message.split("\n")[0]?.trim() ?? error.message;
    return first.slice(0, 240);
  }
  return "Mermaid could not render this diagram.";
}

/* ------------------------------------------------------------------ */
/* SVG polish                                                          */
/* ------------------------------------------------------------------ */

const SVG_NS = "http://www.w3.org/2000/svg";

function numberAttr(element: Element, name: string) {
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) ? value : 0;
}

/** Two-decimal path coordinates: exact enough, and free of float noise. */
function n(value: number) {
  return Math.round(value * 100) / 100;
}

function mostCommon(values: number[]) {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(Math.round(value), (counts.get(Math.round(value)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
}

/** Bars get 4px rounded data ends, square where they meet the baseline. A bar
 * that starts at the baseline and runs the other way (a negative value)
 * rounds its far end instead. Horizontal bar charts round their right end. */
function axisLabelY(root: Element, value: number): number | null {
  for (const label of Array.from(root.querySelectorAll("g.left-axis g.label text"))) {
    const numeric = Number((label.textContent ?? "").replace(/[^\d.-]/g, ""));
    if (numeric !== value || !(label.textContent ?? "").trim()) continue;
    const y = Number(/translate\(\s*[-\d.]+\s*,\s*([-\d.]+)/.exec(label.getAttribute("transform") ?? "")?.[1]);
    if (Number.isFinite(y)) return y;
  }
  return null;
}

function roundBars(root: Element) {
  const rects = Array.from(root.querySelectorAll('g[class*="bar-plot"] rect'));
  if (!rects.length) return;
  const lefts = rects.map((rect) => numberAttr(rect, "x"));
  const bottoms = rects.map((rect) => numberAttr(rect, "y") + numberAttr(rect, "height"));
  const [sharedLeft, leftCount] = mostCommon(lefts);
  const [baseline, bottomCount] = mostCommon(bottoms);
  const horizontal = rects.length > 1 && leftCount > bottomCount;
  // Mermaid grows every vertical bar from the bottom of the axis, so with a
  // negative axis minimum a −13 bar reads as a positive one. Bars re-anchor
  // on the zero line: positive values rise from it, negative values hang.
  const zeroY = horizontal ? null : axisLabelY(root, 0);
  const anchorOnZero = zeroY !== null && zeroY < baseline - 1;
  for (const rect of rects) {
    let x = numberAttr(rect, "x");
    let y = numberAttr(rect, "y");
    let width = numberAttr(rect, "width");
    let height = numberAttr(rect, "height");
    if (width <= 0 || height <= 0) continue;
    // Slim each bar to about two thirds of Mermaid's band so the plot breathes.
    if (horizontal && height > 6) {
      y += height * 0.16;
      height *= 0.68;
    } else if (!horizontal && width > 6) {
      x += width * 0.16;
      width *= 0.68;
    }
    let d: string;
    if (horizontal) {
      const right = x + width;
      const bottom = y + height;
      const radius = Math.min(4, height / 2, width);
      const leftward = Math.abs(right - sharedLeft) < 1 && Math.abs(x - sharedLeft) >= 1;
      d = leftward
        ? `M${n(right)},${n(y)}H${n(x + radius)}Q${n(x)},${n(y)} ${n(x)},${n(y + radius)}V${n(bottom - radius)}Q${n(x)},${n(bottom)} ${n(x + radius)},${n(bottom)}H${n(right)}Z`
        : `M${n(x)},${n(y)}H${n(right - radius)}Q${n(right)},${n(y)} ${n(right)},${n(y + radius)}V${n(bottom - radius)}Q${n(right)},${n(bottom)} ${n(right - radius)},${n(bottom)}H${n(x)}Z`;
    } else {
      // valueY is the data end; startY the baseline the bar grows from.
      const valueY = y;
      const startY = anchorOnZero ? zeroY! : y + height;
      const top = Math.min(valueY, startY);
      const bottom = Math.max(valueY, startY);
      const right = x + width;
      const radius = Math.min(4, width / 2, Math.max(0, bottom - top));
      if (bottom - top < 0.5) {
        rect.remove();
        continue;
      }
      d =
        valueY > startY
          ? `M${n(x)},${n(top)}H${n(right)}V${n(bottom - radius)}Q${n(right)},${n(bottom)} ${n(right - radius)},${n(bottom)}H${n(x + radius)}Q${n(x)},${n(bottom)} ${n(x)},${n(bottom - radius)}Z`
          : `M${n(x)},${n(bottom)}V${n(top + radius)}Q${n(x)},${n(top)} ${n(x + radius)},${n(top)}H${n(right - radius)}Q${n(right)},${n(top)} ${n(right)},${n(top + radius)}V${n(bottom)}Z`;
    }
    const path = rect.ownerDocument.createElementNS(SVG_NS, "path");
    for (const attribute of Array.from(rect.attributes)) {
      if (!["x", "y", "width", "height", "rx", "ry"].includes(attribute.name)) {
        path.setAttribute(attribute.name, attribute.value);
      }
    }
    path.setAttribute("d", d);
    rect.replaceWith(path);
  }
  if (anchorOnZero) {
    const plot = root.querySelector("g.plot");
    const bottomLine = root.querySelector("g.bottom-axis g.axis-line path");
    const xs = pathPoints(bottomLine?.getAttribute("d") ?? "").map((point) => point[0]!);
    if (plot && xs.length) {
      const zeroLine = root.ownerDocument.createElementNS(SVG_NS, "line");
      zeroLine.setAttribute("class", "aperture-zero-line");
      zeroLine.setAttribute("x1", String(Math.min(...xs)));
      zeroLine.setAttribute("x2", String(Math.max(...xs)));
      zeroLine.setAttribute("y1", String(zeroY));
      zeroLine.setAttribute("y2", String(zeroY));
      zeroLine.setAttribute("stroke", bottomLine?.getAttribute("stroke") ?? "#b9c7cd");
      zeroLine.setAttribute("stroke-width", "1.2");
      plot.appendChild(zeroLine);
    }
  }
}

/** Line series: 2.5px strokes with round joins and ringed point markers so
 * each data point reads on its own (only when the series is short enough
 * that markers will not crowd). */
function polishLines(root: Element, palette: DiagramPalette) {
  for (const path of Array.from(root.querySelectorAll('g[class*="line-plot"] path'))) {
    path.setAttribute("stroke-width", "2.5");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-linecap", "round");
    const d = path.getAttribute("d") ?? "";
    const points = Array.from(d.matchAll(/[ML]\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/g)).map((match) => [
      Number(match[1]),
      Number(match[2]),
    ]);
    if (points.length < 2 || points.length > 24) continue;
    const color = path.getAttribute("stroke") ?? palette.series[0]!;
    for (const [cx, cy] of points) {
      const dot = path.ownerDocument.createElementNS(SVG_NS, "circle");
      dot.setAttribute("cx", String(cx));
      dot.setAttribute("cy", String(cy));
      dot.setAttribute("r", "4.5");
      dot.setAttribute("fill", color!);
      dot.setAttribute("stroke", palette.canvas);
      dot.setAttribute("stroke-width", "2");
      path.parentNode?.appendChild(dot);
    }
  }
}

function pathPoints(d: string) {
  return Array.from(d.matchAll(/(-?[\d.]+)[\s,]+(-?[\d.]+)/g)).map((match) => [Number(match[1]), Number(match[2])]);
}

/** Recessive horizontal gridlines at each value tick, and hairline axes. */
function addGridlines(root: Element, palette: DiagramPalette) {
  const plot = root.querySelector("g.plot");
  const leftLine = root.querySelector("g.left-axis g.axisl-line path, g.left-axis g.axis-line path");
  const bottomLine = root.querySelector("g.bottom-axis g.axis-line path");
  if (!plot || !leftLine || !bottomLine) return;
  const labels = Array.from(root.querySelectorAll("g.left-axis g.label text"));
  if (!labels.length || !labels.every((label) => /^-?[\d.,]+[%kKmMbB$]*$/.test((label.textContent ?? "").replace(/[$\s]/g, "")))) return;
  const bottomPoints = pathPoints(bottomLine.getAttribute("d") ?? "");
  const leftPoints = pathPoints(leftLine.getAttribute("d") ?? "");
  if (bottomPoints.length < 2 || leftPoints.length < 1) return;
  const left = leftPoints[0]![0]!;
  const right = Math.max(...bottomPoints.map((point) => point[0]!));
  const baseline = bottomPoints[0]![1]!;
  const group = root.ownerDocument.createElementNS(SVG_NS, "g");
  group.setAttribute("class", "aperture-gridlines");
  for (const label of labels) {
    const y = Number(/translate\(\s*[-\d.]+\s*,\s*([-\d.]+)/.exec(label.getAttribute("transform") ?? "")?.[1]);
    if (!Number.isFinite(y) || Math.abs(y - baseline) < 1) continue;
    const line = root.ownerDocument.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(left));
    line.setAttribute("x2", String(right));
    line.setAttribute("y1", String(y));
    line.setAttribute("y2", String(y));
    line.setAttribute("stroke", palette.grid);
    line.setAttribute("stroke-width", "1");
    group.appendChild(line);
  }
  plot.insertBefore(group, plot.firstChild);
  // The value axis line and its tick marks give way to the gridlines.
  root.querySelector("g.left-axis g.axisl-line, g.left-axis g.axis-line")?.remove();
  root.querySelector("g.left-axis g.ticks")?.remove();
  for (const path of Array.from(root.querySelectorAll("g.bottom-axis path"))) path.setAttribute("stroke-width", "1.2");
}

/** Quadrant points get a canvas ring; labels near an edge anchor inward so
 * they are never clipped by the chart frame. */
function polishQuadrant(root: Element, palette: DiagramPalette) {
  const viewBox = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  const width = viewBox[2] ?? 500;
  for (const point of Array.from(root.querySelectorAll("g.data-point"))) {
    const circle = point.querySelector("circle");
    const label = point.querySelector("text");
    if (circle) {
      circle.setAttribute("stroke", palette.canvas);
      circle.setAttribute("stroke-width", "2");
    }
    if (!circle || !label) continue;
    const cx = numberAttr(circle, "cx");
    const size = Number(label.getAttribute("font-size")) || 12;
    const half = measureDiagramText(label.textContent ?? "", size) / 2;
    const transform = label.getAttribute("transform") ?? "";
    const ty = /translate\(\s*[-\d.]+\s*,\s*([-\d.]+)/.exec(transform)?.[1] ?? "0";
    if (cx + half > width - 6) {
      label.setAttribute("text-anchor", "end");
      label.setAttribute("transform", `translate(${Math.min(cx + 8, width - 4)}, ${ty})`);
    } else if (cx - half < 6) {
      label.setAttribute("text-anchor", "start");
      label.setAttribute("transform", `translate(${Math.max(cx - 8, 4)}, ${ty})`);
    }
  }
}

/** HTML labels (foreignObject) taint canvas rasterization and some diagram
 * types emit them regardless of htmlLabels. Each one becomes SVG text
 * centered in its box, so PNG export and Drafts always get a picture. */
function replaceForeignObjects(root: Element, palette: DiagramPalette) {
  for (const foreign of Array.from(root.querySelectorAll("foreignObject"))) {
    const text = (foreign.textContent ?? "").replace(/\s+/g, " ").trim();
    const x = numberAttr(foreign, "x");
    const y = numberAttr(foreign, "y");
    const width = numberAttr(foreign, "width");
    const height = numberAttr(foreign, "height");
    if (!text) {
      foreign.remove();
      continue;
    }
    const size = 13;
    const lines = wrapForeign(text, Math.max(40, width - 8), size);
    const node = root.ownerDocument.createElementNS(SVG_NS, "text");
    node.setAttribute("font-size", String(size));
    node.setAttribute("fill", palette.text);
    node.setAttribute("text-anchor", "middle");
    const top = y + height / 2 - ((lines.length - 1) * 16) / 2 + size * 0.35;
    lines.forEach((line, index) => {
      const span = root.ownerDocument.createElementNS(SVG_NS, "tspan");
      span.setAttribute("x", String(x + width / 2));
      span.setAttribute("y", String(top + index * 16));
      span.textContent = line;
      node.appendChild(span);
    });
    const transform = foreign.getAttribute("transform");
    if (transform) node.setAttribute("transform", transform);
    foreign.replaceWith(node);
  }
}

function wrapForeign(text: string, width: number, size: number) {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && measureDiagramText(next, size) > width) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 4);
}

/** Pies become donuts: a canvas-colored core, and section labels for slices
 * too thin to hold them are dropped (the legend still carries every value). */
function polishPie(root: Element, palette: DiagramPalette) {
  const slices = Array.from(root.querySelectorAll("path.pieCircle"));
  if (!slices.length) return;
  const group = slices[0]!.parentElement;
  const outer = root.querySelector("circle.pieOuterCircle");
  const radius = outer ? numberAttr(outer, "r") : 0;
  for (const label of Array.from(root.querySelectorAll("text.slice"))) {
    const percent = Number((label.textContent ?? "").replace(/[^\d.]/g, ""));
    if (Number.isFinite(percent) && percent < 4) label.remove();
  }
  if (group && radius > 0) {
    const core = root.ownerDocument.createElementNS(SVG_NS, "circle");
    core.setAttribute("cx", outer?.getAttribute("cx") ?? "0");
    core.setAttribute("cy", outer?.getAttribute("cy") ?? "0");
    core.setAttribute("r", String(Math.round(radius * 0.5)));
    core.setAttribute("fill", palette.canvas);
    const firstLabel = group.querySelector("text.slice");
    group.insertBefore(core, firstLabel);
  }
}

/** Mermaid's output with the finishing touches Mermaid's theme variables
 * cannot express. Pure DOM work on an off-document parse; never throws. */
export function polishMermaidSvg(svg: string, palette: DiagramPalette): string {
  if (typeof DOMParser === "undefined") return svg;
  try {
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
    const root = parsed.documentElement;
    if (!root || root.nodeName.toLowerCase() !== "svg" || parsed.querySelector("parsererror")) return svg;
    const role = root.getAttribute("aria-roledescription") ?? "";
    if (role === "xychart" || root.querySelector('g[class*="bar-plot"], g[class*="line-plot"]')) {
      roundBars(root);
      polishLines(root, palette);
      addGridlines(root, palette);
    }
    if (role === "pie" || root.querySelector("path.pieCircle")) polishPie(root, palette);
    if (role === "quadrantChart" || root.querySelector("g.data-point")) polishQuadrant(root, palette);
    if (root.querySelector("foreignObject")) replaceForeignObjects(root, palette);
    return new XMLSerializer().serializeToString(root);
  } catch {
    return svg;
  }
}

/* ------------------------------------------------------------------ */
/* Rasterization                                                       */
/* ------------------------------------------------------------------ */

function svgDimensions(svgMarkup: string) {
  const viewBox = /viewBox="([^"]+)"/
    .exec(svgMarkup)?.[1]
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    return { width: viewBox[2], height: viewBox[3] };
  }
  return { width: 900, height: 540 };
}

async function rasterizeSvgToCanvas(svgMarkup: string, background: string): Promise<HTMLCanvasElement> {
  const { width, height } = svgDimensions(svgMarkup);
  // Mermaid emits width="100%" and sizes via CSS; rasterization needs explicit
  // pixel dimensions on the root element or the Image decodes at 300×150.
  const openTagEnd = svgMarkup.indexOf(">");
  const sized =
    openTagEnd > 0
      ? `${svgMarkup
          .slice(0, openTagEnd)
          .replace(/\s(?:width|height)="[^"]*"/g, "")
          .replace(/\sstyle="[^"]*"/, "")} width="${width}" height="${height}"${svgMarkup.slice(openTagEnd)}`
      : svgMarkup;
  const url = URL.createObjectURL(new Blob([sized], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Diagram rasterization failed"));
      image.src = url;
    });
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function svgToPngBlob(svgMarkup: string, dark: boolean): Promise<Blob> {
  const canvas = await rasterizeSvgToCanvas(svgMarkup, diagramPalette(dark).canvas);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG export failed"))), "image/png");
  });
}

/** Rasterizes any SVG markup to a PNG data URL (2× scale). Shared by the
 * Mermaid and structure-diagram document pipelines. Returns null when the
 * browser cannot rasterize. */
export async function rasterizeSvgToPngDataUrl(svgMarkup: string, background: string): Promise<string | null> {
  try {
    const canvas = await rasterizeSvgToCanvas(svgMarkup, background);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/** Renders Mermaid source straight to a light-theme PNG data URL for document
 * surfaces (Drafts pages are always white). If the browser cannot rasterize
 * Mermaid's SVG, the drawn fallback is rasterized instead so the document
 * still carries a picture of the data. Returns null only when nothing draws. */
export async function renderMermaidPngDataUrl(source: string): Promise<string | null> {
  const svg = await renderMermaidSvg(source, false);
  const background = diagramPalette(false).canvas;
  if (svg) {
    const png = await rasterizeSvgToPngDataUrl(svg, background);
    if (png) return png;
  }
  const fallback = renderMermaidFallbackSvg(prepareMermaidSource(source), false, MERMAID_FONT_FAMILY);
  return fallback ? rasterizeSvgToPngDataUrl(fallback, background) : null;
}
