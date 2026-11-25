import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

// Vitest empties `.css?raw` imports, so the real rules come from disk.
const css = (name: string) => readFileSync(resolve(process.cwd(), "src", name), "utf8");

type Rgb = [number, number, number];

function block(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, `${selector} rule`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf("}", start));
}

function hexIn(rule: string, property: string): string {
  const match = new RegExp(`(?:^|[\\s;{])${property}:\\s*(#[0-9a-f]{6})\\b`, "i").exec(rule);
  expect(match, `${property} as a six-digit hex`).not.toBeNull();
  return match![1].toLowerCase();
}

const rgb = (hex: string): Rgb => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as Rgb;

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((channel) => {
    const unit = channel / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(one: string, other: string): number {
  const [dark, light] = [luminance(one), luminance(other)].sort((a, b) => a - b);
  return (light + 0.05) / (dark + 0.05);
}

const light = block(css("workspace-refresh.css"), ":root");
const SURFACES = ["--bg", "--surface", "--surface-soft", "--surface-sunken", "--rail"];
const EDGES = ["--border", "--border-strong"];

test.each([...SURFACES, ...EDGES])("light mode %s is a pale green, with no yellow in it", (token) => {
  const [red, green, blue] = rgb(hexIn(light, token));
  expect(green).toBeGreaterThan(blue);
  expect(blue).toBeGreaterThan(red);
});

test("the light sidebar is the canvas tone a shade deeper", () => {
  const canvas = luminance(hexIn(light, "--bg"));
  const rail = luminance(hexIn(light, "--rail"));
  expect(rail).toBeLessThan(canvas);
  expect(canvas - rail).toBeLessThan(0.06);
});

test.each(SURFACES)("words stay readable on light mode %s", (token) => {
  const surface = hexIn(light, token);
  expect(contrast(hexIn(light, "--text"), surface)).toBeGreaterThanOrEqual(7);
  expect(contrast(hexIn(light, "--muted"), surface)).toBeGreaterThanOrEqual(4.5);
});

test("the branding preview's light rail shows the real light sidebar color", () => {
  const preview = block(css("branding.css"), ".branding-preview-rail.is-light");
  expect(hexIn(preview, "background")).toBe(hexIn(light, "--rail"));
});

test("the install preview tile is the light card color", () => {
  const tile = block(css("styles.css"), ".pwa-install-preview-icon");
  expect(hexIn(tile, "background")).toBe(hexIn(light, "--surface"));
});
