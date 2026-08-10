#!/usr/bin/env node
/**
 * Rasterize the Aperture mark (apps/web/public/favicon.svg) into the default
 * PWA install icons served by the API (services/api/app/static/pwa/).
 *
 * The mark is centered on a white tile at 62% of the canvas so the same set
 * works as both `any` and `maskable` manifest purposes and as the iOS
 * apple-touch-icon (iOS composites transparency onto black, so the tile is
 * intentionally opaque).
 *
 * Uses the Playwright CLI via npx, so Playwright does not need to be a
 * package dependency — only an available browser install.
 *
 * Usage: node scripts/generate-pwa-icons.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(repoRoot, "apps/web/public/favicon.svg"), "utf8");
const outDir = join(repoRoot, "services/api/app/static/pwa");
mkdirSync(outDir, { recursive: true });

const SIZES = [180, 192, 512];
const MARK_RATIO = 0.62;

const workDir = mkdtempSync(join(tmpdir(), "aperture-pwa-icons-"));
try {
  for (const size of SIZES) {
    const mark = Math.round(size * MARK_RATIO);
    const page = join(workDir, `icon-${size}.html`);
    writeFileSync(
      page,
      `<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;background:#ffffff;display:grid;place-items:center;">` +
        `<div style="width:${mark}px;height:${mark}px;">${svg.replace("<svg ", `<svg width="${mark}" height="${mark}" `)}</div>` +
        `</body></html>`,
    );
    const file = join(outDir, `aperture-icon-${size}.png`);
    execFileSync(
      "npx",
      ["playwright", "screenshot", `--viewport-size=${size},${size}`, `file://${page}`, file],
      { stdio: "inherit" },
    );
    console.log(`wrote ${file}`);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
