/** The deck Themes gallery's presets. Each theme is a whole look: its design
 * (the shapes every layout draws and where the words sit, deckGeometry.ts),
 * its type, and its colors. No two share a design, so picking one changes
 * more than the colors.
 */

import { defaultDeckTheme, deckThemeDesign, type DeckDesign, type DeckTheme } from "./deckModel";

export type DeckThemePreset = {
  name: string;
  design: DeckDesign;
  look: string;
  colors: DeckTheme["colors"];
  fonts: DeckTheme["fonts"];
};

export const DECK_THEME_PRESETS: DeckThemePreset[] = [
  {
    name: "Aperture",
    design: "rule",
    look: "clean type with a slim accent rule",
    colors: defaultDeckTheme().colors,
    fonts: defaultDeckTheme().fonts,
  },
  {
    name: "Signal",
    design: "band",
    look: "bold color blocks with white type",
    colors: { background: "#ffffff", surface: "#f3efec", heading: "#1d1b22", body: "#3a3742", accent1: "#d9480f", accent2: "#ffb38a" },
    fonts: { major: "Plus Jakarta Sans", minor: "Plus Jakarta Sans" },
  },
  {
    name: "Violet",
    design: "split",
    look: "a solid side panel beside the words",
    colors: { background: "#f7f4ff", surface: "#ebe4fb", heading: "#2e1c4b", body: "#4b3c62", accent1: "#7952c8", accent2: "#b79cf0" },
    fonts: { major: "Plus Jakarta Sans", minor: "Plus Jakarta Sans" },
  },
  {
    name: "Editorial",
    design: "editorial",
    look: "serif type and hairline rules, like a magazine",
    colors: { background: "#faf4e8", surface: "#efe5d3", heading: "#38271f", body: "#514237", accent1: "#a44932", accent2: "#c98b5e" },
    fonts: { major: "Georgia", minor: "Georgia" },
  },
  {
    name: "Midnight",
    design: "orbit",
    look: "a dark slide with bright circles",
    colors: { background: "#122033", surface: "#1c2d44", heading: "#ffffff", body: "#dbe5f0", accent1: "#66d9ef", accent2: "#f2a65a" },
    fonts: { major: "Plus Jakarta Sans", minor: "Plus Jakarta Sans" },
  },
  {
    name: "Forest",
    design: "frame",
    look: "a fine border framing every slide",
    colors: { background: "#f1f6ef", surface: "#e1ecdc", heading: "#193823", body: "#35533d", accent1: "#397b52", accent2: "#8fbf73" },
    fonts: { major: "Trebuchet MS", minor: "Trebuchet MS" },
  },
  {
    name: "Swiss",
    design: "swiss",
    look: "oversized type and a single red square",
    colors: { background: "#ffffff", surface: "#f2f2f2", heading: "#111111", body: "#333333", accent1: "#e5322d", accent2: "#111111" },
    fonts: { major: "Arial", minor: "Arial" },
  },
];

/** A theme preset applied over the deck's own theme: the look changes, the
 * brand logo and pictures stay. The classic design is stored as none. */
export function deckThemeWithPreset(theme: DeckTheme, preset: DeckThemePreset): DeckTheme {
  const { design: _previous, ...rest } = theme;
  return {
    ...rest,
    ...(preset.design === "rule" ? {} : { design: preset.design }),
    colors: { ...preset.colors },
    fonts: { ...preset.fonts },
    sourceLabel: preset.name,
  };
}

/** Whether the deck currently wears this theme: its design and its colors. */
export function deckThemePresetActive(theme: DeckTheme, preset: DeckThemePreset): boolean {
  return (
    deckThemeDesign(theme) === preset.design &&
    theme.colors.accent1 === preset.colors.accent1 &&
    theme.colors.background === preset.colors.background
  );
}
