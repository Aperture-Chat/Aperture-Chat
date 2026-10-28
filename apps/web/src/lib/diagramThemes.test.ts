import { expect, test } from "vitest";
import { diagramPalette } from "./diagramTheme";
import {
  STEWARD_CARD_COLORS,
  STEWARD_DIAGRAM_THEMES,
  isStewardCardColor,
  isStewardDiagramThemeId,
  stewardDiagramPalette,
  stewardHeaderColors,
} from "./diagramThemes";

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

test("the default theme is today's palette, untouched", () => {
  expect(STEWARD_DIAGRAM_THEMES[0]!.id).toBe("aperture");
  for (const dark of [false, true]) {
    expect(stewardDiagramPalette(undefined, dark)).toBe(diagramPalette(dark));
    expect(stewardDiagramPalette("aperture", dark)).toBe(diagramPalette(dark));
  }
});

test("every theme offers light and dark variants with a white light canvas", () => {
  expect(STEWARD_DIAGRAM_THEMES.length).toBeGreaterThanOrEqual(6);
  const ids = new Set(STEWARD_DIAGRAM_THEMES.map((theme) => theme.id));
  expect(ids.size).toBe(STEWARD_DIAGRAM_THEMES.length);
  for (const theme of STEWARD_DIAGRAM_THEMES) {
    expect(stewardDiagramPalette(theme.id, false).canvas).toBe("#ffffff");
    expect(stewardDiagramPalette(theme.id, true).dark).toBe(true);
    expect(theme.name.length).toBeGreaterThan(2);
  }
  // Non-default themes really change the header ink.
  expect(stewardDiagramPalette("forest", false).ink).not.toBe(diagramPalette(false).ink);
  expect(stewardDiagramPalette("forest", false).series[0]).not.toBe(diagramPalette(false).series[0]);
  expect(stewardDiagramPalette("forest", false).series.slice(1)).toEqual(diagramPalette(false).series.slice(1));
});

test("header text stays readable on every theme's header band (WCAG AA)", () => {
  for (const theme of STEWARD_DIAGRAM_THEMES) {
    for (const dark of [false, true]) {
      const palette = stewardDiagramPalette(theme.id, dark);
      expect(contrast(palette.inkText, palette.ink), `${theme.id} ${dark} title`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette.inkSubtext, palette.ink), `${theme.id} ${dark} subtitle`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette.tones.accent.text, palette.tones.accent.fill), `${theme.id} ${dark} tag`).toBeGreaterThanOrEqual(4.5);
      // Primary arrows must read against the canvas.
      expect(contrast(palette.edgeStrong, palette.canvas), `${theme.id} ${dark} arrows`).toBeGreaterThanOrEqual(3);
    }
  }
});

test("per-card header colors are readable in every theme and mode", () => {
  for (const theme of STEWARD_DIAGRAM_THEMES) {
    for (const dark of [false, true]) {
      for (const color of STEWARD_CARD_COLORS) {
        const header = stewardHeaderColors(theme.id, dark, color.id);
        expect(contrast(header.text, header.fill), `${theme.id} ${dark} ${color.id}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(header.subtext, header.fill), `${theme.id} ${dark} ${color.id} sub`).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});

test("a card without its own color uses the theme's header ink", () => {
  const palette = stewardDiagramPalette("plum", false);
  expect(stewardHeaderColors("plum", false)).toEqual({
    fill: palette.ink,
    border: palette.inkBorder,
    text: palette.inkText,
    subtext: palette.inkSubtext,
  });
  expect(stewardHeaderColors("plum", false, "green").fill).not.toBe(palette.ink);
  // The soft theme keeps colored headers light with dark text.
  expect(luminance(stewardHeaderColors("soft", false, "green").fill)).toBeGreaterThan(0.6);
  expect(luminance(stewardHeaderColors("aperture", false, "green").fill)).toBeLessThan(0.2);
});

test("theme and color ids are validated", () => {
  expect(isStewardDiagramThemeId("forest")).toBe(true);
  expect(isStewardDiagramThemeId("neon")).toBe(false);
  expect(isStewardDiagramThemeId(42)).toBe(false);
  expect(isStewardCardColor("amber")).toBe(true);
  expect(isStewardCardColor("ink")).toBe(false);
  expect(isStewardCardColor(undefined)).toBe(false);
});
