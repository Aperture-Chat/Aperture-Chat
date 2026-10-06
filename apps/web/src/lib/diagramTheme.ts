/** One visual language for every diagram Aperture draws.
 *
 * Mermaid figures, structure (card) charts, timelines, and the SVG fallbacks
 * all read their colors and type from here, so a reply that mixes a
 * flowchart, a bar chart, and a structure chart looks like one designed set.
 * Drafts rasterize the light palette (document pages are always white).
 */

export const DIAGRAM_FONT_FAMILY =
  '"Plus Jakarta Sans", "SF Pro Display", "Segoe UI", ui-sans-serif, system-ui, sans-serif';

export type DiagramTone = "neutral" | "accent" | "positive" | "warning" | "danger" | "info" | "violet";

export type DiagramBoxColors = { fill: string; border: string; text: string };

/** A soft box (fill/border/text) plus the saturated stroke for lines and
 * accents in the same hue. */
export type DiagramToneColors = DiagramBoxColors & { line: string };

export type DiagramPalette = {
  dark: boolean;
  canvas: string;
  /** Deep brand ink: principal nodes, card header bands, primary arrows. */
  ink: string;
  inkBorder: string;
  inkText: string;
  inkSubtext: string;
  text: string;
  muted: string;
  faint: string;
  edge: string;
  edgeStrong: string;
  node: DiagramBoxColors;
  cluster: DiagramBoxColors;
  grid: string;
  axis: string;
  tones: Record<DiagramTone, DiagramToneColors>;
  /** Categorical series, fixed order. Validated (lightness band, chroma,
   * adjacent CVD separation, normal-vision floor) against this palette's
   * canvas; slots 4–5 are under 3:1 in light mode, so charts label values. */
  series: string[];
  /** Contingent (conditional) and inactive edge strokes. */
  contingent: string;
  inactive: string;
};

const LIGHT: DiagramPalette = {
  dark: false,
  canvas: "#ffffff",
  ink: "#12384a",
  inkBorder: "#0b2a38",
  inkText: "#ffffff",
  inkSubtext: "#bcd5dd",
  text: "#11252f",
  muted: "#5b6d78",
  faint: "#8b9aa4",
  edge: "#7a8f99",
  edgeStrong: "#12384a",
  node: { fill: "#f4f8f9", border: "#c7d7dd", text: "#11252f" },
  cluster: { fill: "#f8fbfb", border: "#d8e3e7", text: "#3d5560" },
  grid: "#e8eef0",
  axis: "#b9c7cd",
  tones: {
    neutral: { fill: "#f4f8f9", border: "#c7d7dd", text: "#11252f", line: "#7a8f99" },
    accent: { fill: "#e4f3f5", border: "#9fd0d8", text: "#0b4d57", line: "#0b8fa0" },
    positive: { fill: "#e8f5ec", border: "#a8d5b8", text: "#15502e", line: "#2f8a4f" },
    warning: { fill: "#fdf4e2", border: "#ebca8c", text: "#6d4a0c", line: "#c08a1e" },
    danger: { fill: "#fdeded", border: "#f0b6b6", text: "#7f1f1f", line: "#c94040" },
    info: { fill: "#ebf2fd", border: "#b8cef5", text: "#1d3f7a", line: "#2a78d6" },
    violet: { fill: "#f1eefb", border: "#cdc4f0", text: "#3a2e85", line: "#5a4bb7" },
  },
  series: ["#0b8fa0", "#eb6834", "#2a78d6", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  contingent: "#c08a1e",
  inactive: "#98a6ae",
};

const DARK: DiagramPalette = {
  dark: true,
  canvas: "#0d1c27",
  ink: "#1b5266",
  inkBorder: "#2b6a80",
  inkText: "#ffffff",
  inkSubtext: "#b7d4de",
  text: "#e9f3f7",
  muted: "#9fb1bd",
  faint: "#74889a",
  edge: "#7f97a4",
  edgeStrong: "#cfe3ea",
  node: { fill: "#13293a", border: "#2f4c5e", text: "#e9f3f7" },
  cluster: { fill: "#0f2230", border: "#284556", text: "#a9bfca" },
  grid: "#1c3241",
  axis: "#3a5566",
  tones: {
    neutral: { fill: "#13293a", border: "#2f4c5e", text: "#e9f3f7", line: "#7f97a4" },
    accent: { fill: "#0f3640", border: "#1f6b78", text: "#bfeaf0", line: "#1aa5b5" },
    positive: { fill: "#12301f", border: "#2f6b45", text: "#bde8cb", line: "#4fb174" },
    warning: { fill: "#33280f", border: "#7a5a1c", text: "#f3daa4", line: "#d9a23a" },
    danger: { fill: "#3a1818", border: "#823838", text: "#f6c4c4", line: "#e66767" },
    info: { fill: "#142846", border: "#2f5594", text: "#cddcfb", line: "#5b9cf0" },
    violet: { fill: "#221d40", border: "#51468f", text: "#d9d2fb", line: "#9085e9" },
  },
  series: ["#1aa5b5", "#d95926", "#3987e5", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  contingent: "#d9a23a",
  inactive: "#6f8391",
};

export function diagramPalette(dark: boolean): DiagramPalette {
  return dark ? DARK : LIGHT;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = match[1].length === 3 ? match[1].replace(/./g, (char) => char + char) : match[1];
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16)) as [number, number, number];
}

function rgbToHsl([red, green, blue]: [number, number, number]): { h: number; s: number; l: number } {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

/** Which palette role a model-chosen fill color was reaching for. Models pick
 * arbitrary hexes (`fill:#e8f0fe`, `fill:#123a5c`); snapping them to a role
 * keeps every diagram in one palette and guarantees readable text on top. */
export function diagramToneForColor(color: string): DiagramTone | "ink" | null {
  const named: Record<string, string> = {
    white: "#ffffff", black: "#000000", red: "#ff0000", green: "#008000", blue: "#0000ff",
    yellow: "#ffff00", orange: "#ffa500", purple: "#800080", gray: "#808080", grey: "#808080",
    lightblue: "#add8e6", lightgreen: "#90ee90", lightyellow: "#ffffe0", pink: "#ffc0cb",
    gold: "#ffd700", navy: "#000080", teal: "#008080", lightgray: "#d3d3d3", lightgrey: "#d3d3d3",
  };
  const rgb = hexToRgb(named[color.trim().toLowerCase()] ?? color);
  if (!rgb) return null;
  const { h, s, l } = rgbToHsl(rgb);
  // Deep, saturated-enough fills are "principal" boxes: the brand ink.
  if (l < 0.42) return "ink";
  if (s < 0.18) return "neutral";
  if (h < 18 || h >= 330) return "danger";
  if (h < 65) return "warning";
  if (h < 165) return "positive";
  if (h < 200) return "accent";
  if (h < 250) return "info";
  return "violet";
}
