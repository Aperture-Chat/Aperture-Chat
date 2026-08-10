// Runtime white-label theming: turns tenant branding colors into CSS custom
// property overrides so the accent, sidebar gradient, and text palette follow
// the tenant instead of the built-in teal. Injected as a <style> block (not
// inline element styles) so the .theme-dark overrides keep their cascade
// position for tokens the dark theme redefines.

export type BrandThemeInput = {
  primary_color?: string | null;
  gradient_start?: string | null;
  gradient_end?: string | null;
  text_color?: string | null;
};

export type BrandBootCache = BrandThemeInput & {
  name?: string | null;
  favicon?: string | null;
};

export const DEFAULT_ACCENT_COLOR = "#087d8b";
const STYLE_ELEMENT_ID = "brand-theme-style";
const BOOT_CACHE_KEY = "aperture-brand-boot";
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function parseHex(value: string): [number, number, number] {
  return [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Mix `color` toward `target` by `amount` (0 keeps color, 1 becomes target). */
function mix(color: string, target: string, amount: number): string {
  const from = parseHex(color);
  const to = parseHex(target);
  return toHex([
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ]);
}

function alpha(color: string, opacity: number): string {
  const [r, g, b] = parseHex(color);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

export function normalizeHexColor(value: string | null | undefined): string | null {
  const candidate = value?.trim().toLowerCase() ?? "";
  return HEX_COLOR_RE.test(candidate) ? candidate : null;
}

export function brandThemeCss(theme: BrandThemeInput | null | undefined): string {
  if (!theme) return "";
  const accent = normalizeHexColor(theme.primary_color);
  const gradientStart = normalizeHexColor(theme.gradient_start);
  const gradientEnd = normalizeHexColor(theme.gradient_end);
  const textColor = normalizeHexColor(theme.text_color);

  const rootLines: string[] = [];
  const darkLines: string[] = [];
  const lightLines: string[] = [];

  if (accent && accent !== DEFAULT_ACCENT_COLOR) {
    rootLines.push(
      `--teal: ${accent};`,
      `--teal-strong: ${mix(accent, "#000000", 0.22)};`,
      `--teal-2: ${mix(accent, "#ffffff", 0.16)};`,
      `--teal-soft: ${mix(accent, "#ffffff", 0.92)};`,
      `--teal-border: ${mix(accent, "#ffffff", 0.68)};`,
      `--teal-ring: ${alpha(accent, 0.32)};`,
      // The default logo mark's SVG gradient reads these stops.
      `--brand-mark-1: ${mix(accent, "#ffffff", 0.38)};`,
      `--brand-mark-2: ${mix(accent, "#ffffff", 0.16)};`,
      `--brand-mark-3: ${mix(accent, "#000000", 0.35)};`,
    );
    darkLines.push(`--teal-soft: ${alpha(accent, 0.18)};`, `--teal-ring: ${alpha(accent, 0.4)};`);
  }

  if (gradientStart && gradientEnd) {
    rootLines.push(
      `--sidebar-gradient: linear-gradient(165deg, ${gradientStart} 0%, ${gradientEnd} 100%);`,
      // Rail tokens back tooltips and dark chrome; keep them readably dark even
      // when the chosen gradient stops are light.
      `--rail-dark: ${mix(gradientEnd, "#000000", 0.55)};`,
      `--rail-dark-2: ${mix(gradientStart, "#000000", 0.45)};`,
    );
  }

  if (textColor) {
    // Text overrides stay light-theme only: forcing them into .theme-dark would
    // put a color tuned for white surfaces onto near-black ones.
    lightLines.push(
      `--text: ${textColor};`,
      `--text-strong: ${mix(textColor, "#000000", 0.3)};`,
      `--muted: ${mix(textColor, "#ffffff", 0.38)};`,
      `--faint: ${mix(textColor, "#ffffff", 0.54)};`,
    );
  }

  const blocks: string[] = [];
  if (rootLines.length) blocks.push(`:root {\n  ${rootLines.join("\n  ")}\n}`);
  if (lightLines.length) blocks.push(`:root:not(.theme-dark) {\n  ${lightLines.join("\n  ")}\n}`);
  if (darkLines.length) blocks.push(`.theme-dark {\n  ${darkLines.join("\n  ")}\n}`);
  return blocks.join("\n");
}

export function applyBrandTheme(theme: BrandThemeInput | null | undefined): void {
  const css = brandThemeCss(theme);
  let element = document.getElementById(STYLE_ELEMENT_ID);
  if (!css) {
    element?.remove();
    return;
  }
  if (!element) {
    element = document.createElement("style");
    element.id = STYLE_ELEMENT_ID;
    document.head.appendChild(element);
  }
  if (element.textContent !== css) element.textContent = css;
}

/** Persist the last-known branding so the next page load can paint it before
 * the bootstrap request returns (no default-brand flash on white-labeled
 * installs). */
export function cacheBrandBoot(cache: BrandBootCache): void {
  try {
    localStorage.setItem(BOOT_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Storage may be unavailable (private mode, quota); the runtime effects
    // still brand the page after bootstrap.
  }
}

/** Last-known tenant branding from the previous page load, or null when none
 * is cached (first visit, cleared storage, private mode). */
export function readBrandBoot(): BrandBootCache | null {
  try {
    const cache = JSON.parse(localStorage.getItem(BOOT_CACHE_KEY) ?? "null") as BrandBootCache | null;
    return cache && typeof cache === "object" ? cache : null;
  } catch {
    return null;
  }
}

export function applyCachedBrandBoot(): void {
  const cache = readBrandBoot();
  if (!cache) return;
  const name = typeof cache.name === "string" ? cache.name.trim() : "";
  if (name) document.title = name;
  const favicon = typeof cache.favicon === "string" ? cache.favicon.trim() : "";
  if (favicon) {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = favicon;
    link.type = favicon.endsWith(".svg") ? "image/svg+xml" : "";
  }
  applyBrandTheme(cache);
}
