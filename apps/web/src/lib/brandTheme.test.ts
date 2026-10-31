import { describe, expect, it } from "vitest";
import { applyBrandTheme, brandThemeCss, DEFAULT_ACCENT_COLOR } from "./brandTheme";

describe("brandThemeCss", () => {
  it("returns no CSS for default or empty branding", () => {
    expect(brandThemeCss(null)).toBe("");
    expect(brandThemeCss({})).toBe("");
    expect(brandThemeCss({ primary_color: DEFAULT_ACCENT_COLOR })).toBe("");
    expect(brandThemeCss({ primary_color: "not-a-color", text_color: "#12" })).toBe("");
  });

  it("derives the full accent token family from a custom accent", () => {
    const css = brandThemeCss({ primary_color: "#7c3aed" });
    expect(css).toContain("--teal: #7c3aed;");
    expect(css).toContain("--teal-strong:");
    expect(css).toContain("--teal-2:");
    expect(css).toContain("--teal-soft:");
    expect(css).toContain("--teal-ring: rgba(124, 58, 237, 0.32);");
    // Dark mode gets translucent soft/ring variants so panels stay legible.
    expect(css).toContain(".theme-dark {");
    expect(css).toContain("rgba(124, 58, 237, 0.18)");
  });

  it("darkens a bright accent's lit keys until white text reads, and leaves a dark one alone", () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
        .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const litBase = (accent: string) => brandThemeCss({ primary_color: accent }).match(/--tactile-lit-base: (#[0-9a-f]{6});/)?.[1];

    for (const accent of ["#d97706", "#ffeb3b", "#ffffff", "#22c55e"]) {
      const base = litBase(accent);
      expect(base).toBeDefined();
      expect(1.05 / (luminance(base as string) + 0.05)).toBeGreaterThanOrEqual(4.5);
      expect(1.05 / (luminance(base as string) + 0.05)).toBeLessThan(5.2);
    }
    expect(litBase("#7c3aed")).toBeUndefined();
    expect(litBase("#000000")).toBeUndefined();
    expect(brandThemeCss({ primary_color: "#d97706" })).toContain("--teal: #d97706;");
  });

  it("builds the sidebar gradient and derived rail tokens", () => {
    const css = brandThemeCss({ gradient_start: "#1E1B4B", gradient_end: "#7C3AED" });
    expect(css).toContain("--sidebar-gradient: linear-gradient(165deg, #1e1b4b 0%, #7c3aed 100%);");
    expect(css).toContain("--rail-dark:");
    expect(css).toContain("--rail-dark-2:");
  });

  it("requires both gradient stops before overriding the sidebar", () => {
    expect(brandThemeCss({ gradient_start: "#1e1b4b" })).toBe("");
    expect(brandThemeCss({ gradient_end: "#7c3aed" })).toBe("");
  });

  it("scopes text color overrides to the light theme only", () => {
    const css = brandThemeCss({ text_color: "#1f2937" });
    expect(css).toContain(":root:not(.theme-dark) {");
    expect(css).toContain("--text: #1f2937;");
    expect(css).toContain("--text-strong:");
    expect(css).toContain("--muted:");
    expect(css).not.toContain("--sidebar-gradient");
  });
});

describe("applyBrandTheme", () => {
  it("injects a style element for custom themes and removes it for defaults", () => {
    applyBrandTheme({ primary_color: "#7c3aed" });
    const styleEl = document.getElementById("brand-theme-style");
    expect(styleEl).not.toBeNull();
    expect(styleEl?.textContent).toContain("--teal: #7c3aed;");

    applyBrandTheme({ primary_color: DEFAULT_ACCENT_COLOR });
    expect(document.getElementById("brand-theme-style")).toBeNull();
  });
});
