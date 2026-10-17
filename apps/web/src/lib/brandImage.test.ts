import { expect, test } from "vitest";
import { describeBrandImageProblem, opaqueBounds, planBrandCanvas, prepareBrandImage, sizeSvgForRaster } from "./brandImage";

function rgba(width: number, height: number, opaque: Array<[number, number]>) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (const [x, y] of opaque) data[(y * width + x) * 4 + 3] = 255;
  return data;
}

test("opaque bounds find the artwork inside transparent padding", () => {
  expect(opaqueBounds(rgba(10, 6, [[2, 1], [7, 4]]), 10, 6)).toEqual({ x: 2, y: 1, width: 6, height: 4 });
  expect(opaqueBounds(rgba(4, 4, []), 4, 4)).toBeNull();
  // Near-invisible pixels count as padding.
  const faint = rgba(4, 4, [[1, 1]]);
  faint[(0 * 4 + 3) * 4 + 3] = 5;
  expect(opaqueBounds(faint, 4, 4)).toEqual({ x: 1, y: 1, width: 1, height: 1 });
});

test("logos keep their proportions and icons are centered on a square", () => {
  expect(planBrandCanvas({ width: 2048, height: 512 }, "logo", 1024)).toEqual({
    canvasWidth: 1024,
    canvasHeight: 256,
    dx: 0,
    dy: 0,
    dw: 1024,
    dh: 256,
  });
  expect(planBrandCanvas({ width: 300, height: 200 }, "icon", 512)).toEqual({
    canvasWidth: 300,
    canvasHeight: 300,
    dx: 0,
    dy: 50,
    dw: 300,
    dh: 200,
  });
  // Small artwork is never upscaled.
  expect(planBrandCanvas({ width: 64, height: 64 }, "icon", 512).canvasWidth).toBe(64);
});

test("SVGs get explicit pixel sizes from their viewBox or absolute dimensions", () => {
  const fromViewBox = sizeSvgForRaster('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"/>', 1024);
  expect(fromViewBox).toContain('width="1024"');
  expect(fromViewBox).toContain('height="256"');
  const fromSize = sizeSvgForRaster('<svg xmlns="http://www.w3.org/2000/svg" width="50px" height="100"/>', 512);
  expect(fromSize).toContain('viewBox="0 0 50 100"');
  expect(fromSize).toContain('width="256"');
  expect(fromSize).toContain('height="512"');
  expect(sizeSvgForRaster('<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"/>', 512)).toBeNull();
  expect(sizeSvgForRaster("<html></html>", 512)).toBeNull();
  expect(sizeSvgForRaster("<svg", 512)).toBeNull();
});

test("uploads are checked for format and size before any processing", async () => {
  expect(await prepareBrandImage(new File(["x"], "anim.gif", { type: "image/gif" }), "logo")).toEqual({
    ok: false,
    problem: { kind: "format" },
  });
  const huge = new File([new Uint8Array(4 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" });
  expect(await prepareBrandImage(huge, "logo")).toEqual({ ok: false, problem: { kind: "too-big" } });
});

test("without canvas support small raster files are stored as typed data URLs", async () => {
  // Some systems report no MIME type; the extension decides.
  const result = await prepareBrandImage(new File(["png"], "logo.PNG"), "logo");
  expect(result.ok && result.image.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  const svg = await prepareBrandImage(new File(["<svg/>"], "mark.svg", { type: "image/svg+xml" }), "icon");
  expect(svg).toEqual({ ok: false, problem: { kind: "no-canvas-svg" } });
  const big = await prepareBrandImage(new File([new Uint8Array(300 * 1024)], "big.jpg", { type: "image/jpeg" }), "logo");
  expect(big).toEqual({ ok: false, problem: { kind: "no-canvas-too-big" } });
});

test("problems read as plain guidance", () => {
  expect(describeBrandImageProblem({ kind: "wide", width: 1024, height: 211 }, "wordmark.png")).toBe(
    "wordmark.png is 1024 × 211, too wide for an icon. Icons need a roughly square image; upload wordmarks as the logo.",
  );
});
