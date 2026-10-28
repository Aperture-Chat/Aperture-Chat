/** Structure-chart themes: curated recolorings of the shared diagram palette.
 *
 * A theme only overrides the roles a structure chart paints with — header
 * ink, primary arrows, the accent tag/footer tone, and the bullet dot — so
 * status footers, warning notes, and contingent/inactive arrows keep their
 * meaning in every theme. "aperture" is the shared palette itself, and the
 * light canvas stays white everywhere (Drafts pages are white).
 */

import { diagramPalette, type DiagramBoxColors, type DiagramPalette, type DiagramToneColors } from "./diagramTheme";

export type StewardDiagramThemeId =
  | "aperture"
  | "graphite"
  | "forest"
  | "indigo"
  | "plum"
  | "ember"
  | "soft"
  | "blueprint";

export type StewardCardColor = "teal" | "blue" | "green" | "amber" | "red" | "violet" | "slate";

export type StewardHeaderColors = { fill: string; border: string; text: string; subtext: string };

type ThemeRoles = {
  ink: string;
  inkBorder: string;
  inkText: string;
  inkSubtext: string;
  edgeStrong: string;
  accent: DiagramToneColors;
  bullet: string;
  node?: Partial<DiagramBoxColors>;
};

type ThemeSpec = {
  id: StewardDiagramThemeId;
  name: string;
  /** "soft" headers are light bands with dark text instead of solid ink. */
  header: "solid" | "soft";
  light?: ThemeRoles;
  dark?: ThemeRoles;
};

const THEMES: ThemeSpec[] = [
  { id: "aperture", name: "Aperture", header: "solid" },
  {
    id: "graphite",
    name: "Graphite",
    header: "solid",
    light: {
      ink: "#2b3138",
      inkBorder: "#1d2227",
      inkText: "#ffffff",
      inkSubtext: "#c9d0d6",
      edgeStrong: "#2b3138",
      accent: { fill: "#eef1f4", border: "#cdd4da", text: "#2b3138", line: "#5b6670" },
      bullet: "#5b6670",
      node: { border: "#d3d9de" },
    },
    dark: {
      ink: "#3a424b",
      inkBorder: "#4f5963",
      inkText: "#ffffff",
      inkSubtext: "#d3d9de",
      edgeStrong: "#d5dbe0",
      accent: { fill: "#252b31", border: "#48525c", text: "#dde3e8", line: "#9aa6b1" },
      bullet: "#9aa6b1",
      node: { fill: "#1b2127", border: "#3a434c" },
    },
  },
  {
    id: "forest",
    name: "Forest",
    header: "solid",
    light: {
      ink: "#1f4a38",
      inkBorder: "#153527",
      inkText: "#ffffff",
      inkSubtext: "#c3dfd0",
      edgeStrong: "#1f4a38",
      accent: { fill: "#e6f3ec", border: "#a9d3bb", text: "#17402f", line: "#2f7d58" },
      bullet: "#2f7d58",
      node: { border: "#c6dccf" },
    },
    dark: {
      ink: "#24573f",
      inkBorder: "#347256",
      inkText: "#ffffff",
      inkSubtext: "#cfe9db",
      edgeStrong: "#cfe8da",
      accent: { fill: "#12301f", border: "#2f6b45", text: "#bde8cb", line: "#4fb174" },
      bullet: "#4fb174",
      node: { fill: "#11271d", border: "#2a4d3b" },
    },
  },
  {
    id: "indigo",
    name: "Indigo",
    header: "solid",
    light: {
      ink: "#2c3878",
      inkBorder: "#1f2959",
      inkText: "#ffffff",
      inkSubtext: "#cdd3f4",
      edgeStrong: "#2c3878",
      accent: { fill: "#ecefff", border: "#bcc5f3", text: "#26306a", line: "#4b5bd0" },
      bullet: "#4b5bd0",
      node: { border: "#cfd5f0" },
    },
    dark: {
      ink: "#33408a",
      inkBorder: "#4654a8",
      inkText: "#ffffff",
      inkSubtext: "#d6dbfa",
      edgeStrong: "#d3d9fb",
      accent: { fill: "#1b2147", border: "#3d4a96", text: "#d3d9fb", line: "#8090f0" },
      bullet: "#8090f0",
      node: { fill: "#151a36", border: "#323c78" },
    },
  },
  {
    id: "plum",
    name: "Plum",
    header: "solid",
    light: {
      ink: "#4b2a5c",
      inkBorder: "#361d43",
      inkText: "#ffffff",
      inkSubtext: "#e3cfec",
      edgeStrong: "#4b2a5c",
      accent: { fill: "#f5ecf8", border: "#dcc2e6", text: "#432553", line: "#8a4fa8" },
      bullet: "#8a4fa8",
      node: { border: "#e2d2e9" },
    },
    dark: {
      ink: "#55306a",
      inkBorder: "#6e4387",
      inkText: "#ffffff",
      inkSubtext: "#ead9f2",
      edgeStrong: "#ead9f2",
      accent: { fill: "#2a1934", border: "#5d3a73", text: "#ead9f2", line: "#b47fd0" },
      bullet: "#b47fd0",
      node: { fill: "#221629", border: "#4a3058" },
    },
  },
  {
    id: "ember",
    name: "Ember",
    header: "solid",
    light: {
      ink: "#7a3520",
      inkBorder: "#5c2717",
      inkText: "#ffffff",
      inkSubtext: "#f6dcd1",
      edgeStrong: "#7a3520",
      accent: { fill: "#fbeee8", border: "#efc6b5", text: "#6a2d1a", line: "#c4552f" },
      bullet: "#c4552f",
      node: { border: "#ecd5cb" },
    },
    dark: {
      ink: "#7d3822",
      inkBorder: "#9a4a30",
      inkText: "#ffffff",
      inkSubtext: "#f8e0d6",
      edgeStrong: "#f2d2c5",
      accent: { fill: "#3a1d14", border: "#7a3a25", text: "#f5d6ca", line: "#e07b55" },
      bullet: "#e07b55",
      node: { fill: "#281610", border: "#5a3022" },
    },
  },
  {
    id: "soft",
    name: "Soft",
    header: "soft",
    light: {
      ink: "#e6eff2",
      inkBorder: "#c7d7dd",
      inkText: "#12384a",
      inkSubtext: "#44606c",
      edgeStrong: "#44606c",
      accent: { fill: "#e4f3f5", border: "#9fd0d8", text: "#0b4d57", line: "#0b8fa0" },
      bullet: "#0b8fa0",
    },
    dark: {
      ink: "#1c3442",
      inkBorder: "#2f4c5e",
      inkText: "#e9f3f7",
      inkSubtext: "#b3c9d3",
      edgeStrong: "#a9c1cc",
      accent: { fill: "#0f3640", border: "#1f6b78", text: "#bfeaf0", line: "#1aa5b5" },
      bullet: "#1aa5b5",
    },
  },
  {
    id: "blueprint",
    name: "Blueprint",
    header: "solid",
    light: {
      ink: "#0f4c81",
      inkBorder: "#0b3a63",
      inkText: "#ffffff",
      inkSubtext: "#cfe2f5",
      edgeStrong: "#0f4c81",
      accent: { fill: "#e8f1fb", border: "#b5cfee", text: "#0d3f6b", line: "#1f6fc0" },
      bullet: "#1f6fc0",
      node: { border: "#bcd3ea" },
    },
    dark: {
      ink: "#154d7d",
      inkBorder: "#24639a",
      inkText: "#ffffff",
      inkSubtext: "#d3e5f6",
      edgeStrong: "#cfe2f5",
      accent: { fill: "#10283f", border: "#2a5a88", text: "#cfe2f5", line: "#5aa2e6" },
      bullet: "#5aa2e6",
      node: { fill: "#0e2236", border: "#24486c" },
    },
  },
];

export const STEWARD_DIAGRAM_THEMES: ReadonlyArray<{ id: StewardDiagramThemeId; name: string }> = THEMES.map(
  ({ id, name }) => ({ id, name }),
);

export const STEWARD_CARD_COLORS: ReadonlyArray<{ id: StewardCardColor; name: string }> = [
  { id: "teal", name: "Teal" },
  { id: "blue", name: "Blue" },
  { id: "green", name: "Green" },
  { id: "amber", name: "Amber" },
  { id: "red", name: "Red" },
  { id: "violet", name: "Violet" },
  { id: "slate", name: "Slate" },
];

/** Deep header bands for solid themes; white text clears AA on each. */
const SOLID_HEADERS: Record<"light" | "dark", Record<StewardCardColor, string>> = {
  light: {
    teal: "#0b5f6b",
    blue: "#1d4f91",
    green: "#1f6a43",
    amber: "#8a5a00",
    red: "#9b2c2c",
    violet: "#4a3a99",
    slate: "#3d4a55",
  },
  dark: {
    teal: "#136b78",
    blue: "#2a5ea8",
    green: "#24704a",
    amber: "#8d6210",
    red: "#a33a3a",
    violet: "#5547a8",
    slate: "#4a5763",
  },
};

/** Soft themes reuse the palette's light tone boxes for colored headers. */
const SOFT_TONES: Record<StewardCardColor, keyof DiagramPalette["tones"]> = {
  teal: "accent",
  blue: "info",
  green: "positive",
  amber: "warning",
  red: "danger",
  violet: "violet",
  slate: "neutral",
};

const THEME_IDS = new Set<string>(THEMES.map((theme) => theme.id));
const COLOR_IDS = new Set<string>(STEWARD_CARD_COLORS.map((color) => color.id));

export function isStewardDiagramThemeId(value: unknown): value is StewardDiagramThemeId {
  return typeof value === "string" && THEME_IDS.has(value);
}

export function isStewardCardColor(value: unknown): value is StewardCardColor {
  return typeof value === "string" && COLOR_IDS.has(value);
}

function themeSpec(themeId: StewardDiagramThemeId | undefined): ThemeSpec {
  return THEMES.find((theme) => theme.id === themeId) ?? THEMES[0]!;
}

function themedPalette(base: DiagramPalette, roles: ThemeRoles): DiagramPalette {
  const { accent, bullet, node, ...ink } = roles;
  return {
    ...base,
    ...ink,
    node: { ...base.node, ...node },
    tones: { ...base.tones, accent },
    series: [bullet, ...base.series.slice(1)],
  };
}

const paletteCache = new Map<string, DiagramPalette>();

/** The palette a structure chart paints with for a theme. Stable identity per
 * theme and mode, and exactly diagramPalette() for the default theme. */
export function stewardDiagramPalette(themeId: StewardDiagramThemeId | undefined, dark: boolean): DiagramPalette {
  const spec = themeSpec(themeId);
  const roles = dark ? spec.dark : spec.light;
  const base = diagramPalette(dark);
  if (!roles) return base;
  const key = `${spec.id}:${dark ? "dark" : "light"}`;
  let palette = paletteCache.get(key);
  if (!palette) {
    palette = themedPalette(base, roles);
    paletteCache.set(key, palette);
  }
  return palette;
}

/** Header band colors for a card: the theme's ink, or the card's own color. */
export function stewardHeaderColors(
  themeId: StewardDiagramThemeId | undefined,
  dark: boolean,
  color?: StewardCardColor,
): StewardHeaderColors {
  const palette = stewardDiagramPalette(themeId, dark);
  if (!color) {
    return { fill: palette.ink, border: palette.inkBorder, text: palette.inkText, subtext: palette.inkSubtext };
  }
  if (themeSpec(themeId).header === "soft") {
    const tone = palette.tones[SOFT_TONES[color]];
    return { fill: tone.fill, border: tone.border, text: tone.text, subtext: tone.text };
  }
  const fill = SOLID_HEADERS[dark ? "dark" : "light"][color];
  return { fill, border: fill, text: "#ffffff", subtext: "#e6eef1" };
}
