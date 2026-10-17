import { isCompactBrandImage } from "./brandIcon";

/* Owner-uploaded brand artwork is stored inline in tenant state and travels
 * with every page load, so it is normalized in the browser before Apply:
 * any supported format becomes a PNG data URL, transparent padding is trimmed
 * so the artwork fills its slot, icons become exact squares, and the result
 * is sized to stay well inside the API's per-image cap. */

export type BrandImageSlot = "logo" | "icon";
type BrandImageFormat = "png" | "jpeg" | "webp" | "svg";

export const BRAND_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/svg+xml,.png,.jpg,.jpeg,.webp,.svg";
export const BRAND_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
/** Mirrors BRANDING_IMAGE_URL_MAX_LENGTH in services/api/app/models/schemas.py. */
export const BRAND_IMAGE_URL_MAX_LENGTH = 400_000;
// Aim well under the cap: branding rides along with every session payload.
const BRAND_IMAGE_URL_BUDGET = 200_000;
// Without canvas support a raw file must already fit the cap; base64
// inflates ~4/3, so 250 KB is the safe ceiling.
const RAW_FALLBACK_MAX_BYTES = 250 * 1024;
// Logos can carry lettering and render up to ~280 CSS px wide; icons feed the
// 512 px home-screen icon.
const MAX_EDGE: Record<BrandImageSlot, number> = { logo: 1024, icon: 512 };
const MIN_EDGE = 128;
// Pixels at or below this alpha count as transparent padding.
const ALPHA_THRESHOLD = 8;
const ANALYSIS_EDGE = 512;

const MIME: Record<BrandImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
};

export type BrandImageProblem =
  | { kind: "format" }
  | { kind: "too-big" }
  | { kind: "unreadable" }
  | { kind: "empty" }
  | { kind: "wide"; width: number; height: number }
  | { kind: "no-canvas-svg" }
  | { kind: "no-canvas-too-big" }
  | { kind: "too-detailed" };

export type PreparedBrandImage = {
  dataUrl: string;
  /** Output size; 0 when this browser stored the file unprocessed. */
  width: number;
  height: number;
  trimmed: boolean;
};

export type BrandImageResult =
  | { ok: true; image: PreparedBrandImage }
  | { ok: false; problem: BrandImageProblem };

type Box = { x: number; y: number; width: number; height: number };

function brandImageFormat(file: File): BrandImageFormat | null {
  const type = file.type.toLowerCase();
  if (type === "image/png") return "png";
  if (type === "image/jpeg") return "jpeg";
  if (type === "image/webp") return "webp";
  if (type === "image/svg+xml") return "svg";
  if (type) return null;
  // Some systems report no type for SVG and other files; fall back to the name.
  const extension = file.name.toLowerCase().split(".").pop();
  if (extension === "png") return "png";
  if (extension === "jpg" || extension === "jpeg") return "jpeg";
  if (extension === "webp") return "webp";
  if (extension === "svg") return "svg";
  return null;
}

/** Bounding box of pixels whose alpha exceeds the threshold, or null when the
 * image is fully transparent. `data` is RGBA, row-major. */
export function opaqueBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  threshold = ALPHA_THRESHOLD,
): Box | null {
  let top = -1;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (data[row + x * 4 + 3] > threshold) {
        if (top < 0) top = y;
        bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (top < 0) return null;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

export type BrandCanvasPlan = {
  canvasWidth: number;
  canvasHeight: number;
  /** Where the cropped source is drawn on the canvas. */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
};

/** Output geometry for a cropped source: logos keep their proportions, icons
 * are centered on an exact square. Never upscales past the source pixels. */
export function planBrandCanvas(crop: Pick<Box, "width" | "height">, slot: BrandImageSlot, maxEdge: number): BrandCanvasPlan {
  const longEdge = Math.max(crop.width, crop.height, 1);
  const scale = Math.min(1, maxEdge / longEdge);
  const dw = Math.max(1, Math.round(crop.width * scale));
  const dh = Math.max(1, Math.round(crop.height * scale));
  if (slot === "logo") return { canvasWidth: dw, canvasHeight: dh, dx: 0, dy: 0, dw, dh };
  const side = Math.max(dw, dh);
  return {
    canvasWidth: side,
    canvasHeight: side,
    dx: Math.round((side - dw) / 2),
    dy: Math.round((side - dh) / 2),
    dw,
    dh,
  };
}

/** Give an SVG explicit pixel dimensions with its long edge at `maxEdge`, so
 * it rasterizes crisply and identically in every browser (an SVG sized only
 * by its viewBox reports 0×0 in some). Returns null for unusable markup. */
export function sizeSvgForRaster(markup: string, maxEdge: number): string | null {
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.nodeName.toLowerCase() !== "svg" || parsed.getElementsByTagName("parsererror").length) return null;
  const viewBox = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  let width: number;
  let height: number;
  if (viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    [, , width, height] = viewBox;
  } else {
    // Only absolute lengths can define a shape; "100%" cannot.
    width = parseFloat(root.getAttribute("width") ?? "");
    height = parseFloat(root.getAttribute("height") ?? "");
    if (!(width > 0 && height > 0) || /%/.test(`${root.getAttribute("width")}${root.getAttribute("height")}`)) return null;
    root.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }
  const scale = maxEdge / Math.max(width, height);
  root.setAttribute("width", String(Math.max(1, Math.round(width * scale))));
  root.setAttribute("height", String(Math.max(1, Math.round(height * scale))));
  return new XMLSerializer().serializeToString(root);
}

function readFileAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(typeof reader.result === "string" && reader.result ? reader.result : null);
    });
    reader.addEventListener("error", () => resolve(null));
    reader.readAsDataURL(file);
  });
}

type DecodedImage = { source: CanvasImageSource; width: number; height: number; close: () => void };

async function decodeImage(file: File, format: BrandImageFormat, maxEdge: number): Promise<DecodedImage | null> {
  if (format !== "svg") {
    const bitmap = await createImageBitmap(file);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  }
  // An SVG in an <img> cannot run script or fetch anything; rasterizing it
  // here means no SVG markup is ever stored.
  const sized = sizeSvgForRaster(await file.text(), maxEdge);
  if (!sized) return null;
  const url = URL.createObjectURL(new Blob([sized], { type: MIME.svg }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/** Opaque bounds in source pixels, measured on a downscaled copy for speed. */
function measureOpaqueBounds(decoded: DecodedImage): Box | null {
  const scale = Math.min(1, ANALYSIS_EDGE / Math.max(decoded.width, decoded.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(decoded.width * scale));
  canvas.height = Math.max(1, Math.round(decoded.height * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("No 2D canvas");
  context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
  const bounds = opaqueBounds(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
  if (!bounds) return null;
  // Map back conservatively so trimming never clips an antialiased edge.
  const x = Math.max(0, Math.floor(bounds.x / scale) - 1);
  const y = Math.max(0, Math.floor(bounds.y / scale) - 1);
  return {
    x,
    y,
    width: Math.min(decoded.width, Math.ceil((bounds.x + bounds.width) / scale) + 1) - x,
    height: Math.min(decoded.height, Math.ceil((bounds.y + bounds.height) / scale) + 1) - y,
  };
}

function render(decoded: DecodedImage, crop: Box, plan: BrandCanvasPlan): string {
  const canvas = document.createElement("canvas");
  canvas.width = plan.canvasWidth;
  canvas.height = plan.canvasHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2D canvas");
  context.imageSmoothingQuality = "high";
  context.drawImage(decoded.source, crop.x, crop.y, crop.width, crop.height, plan.dx, plan.dy, plan.dw, plan.dh);
  return canvas.toDataURL("image/png");
}

async function storeUnprocessed(file: File, format: BrandImageFormat): Promise<BrandImageResult> {
  if (format === "svg") return { ok: false, problem: { kind: "no-canvas-svg" } };
  if (file.size > RAW_FALLBACK_MAX_BYTES) return { ok: false, problem: { kind: "no-canvas-too-big" } };
  const raw = await readFileAsDataUrl(file);
  if (!raw) return { ok: false, problem: { kind: "unreadable" } };
  // Files with no reported type would read as application/octet-stream.
  const dataUrl = raw.replace(/^data:[^;,]*/, `data:${MIME[format]}`);
  return { ok: true, image: { dataUrl, width: 0, height: 0, trimmed: false } };
}

export async function prepareBrandImage(file: File, slot: BrandImageSlot): Promise<BrandImageResult> {
  const format = brandImageFormat(file);
  if (!format) return { ok: false, problem: { kind: "format" } };
  if (file.size > BRAND_UPLOAD_MAX_BYTES) return { ok: false, problem: { kind: "too-big" } };
  if (typeof createImageBitmap !== "function") return storeUnprocessed(file, format);

  let decoded: DecodedImage | null = null;
  try {
    decoded = await decodeImage(file, format, MAX_EDGE[slot]);
    if (!decoded || decoded.width <= 0 || decoded.height <= 0) return { ok: false, problem: { kind: "unreadable" } };
    if (slot === "icon" && !isCompactBrandImage(decoded.width, decoded.height)) {
      return { ok: false, problem: { kind: "wide", width: decoded.width, height: decoded.height } };
    }
    const full: Box = { x: 0, y: 0, width: decoded.width, height: decoded.height };
    const crop = format === "jpeg" ? full : measureOpaqueBounds(decoded);
    if (!crop) return { ok: false, problem: { kind: "empty" } };
    const trimmed = crop.width < full.width || crop.height < full.height;

    let fallback: PreparedBrandImage | null = null;
    for (let edge = MAX_EDGE[slot]; edge >= MIN_EDGE; edge = Math.floor(edge * 0.75)) {
      const plan = planBrandCanvas(crop, slot, edge);
      const dataUrl = render(decoded, crop, plan);
      const image = { dataUrl, width: plan.canvasWidth, height: plan.canvasHeight, trimmed };
      if (dataUrl.length <= BRAND_IMAGE_URL_BUDGET) return { ok: true, image };
      if (!fallback && dataUrl.length <= BRAND_IMAGE_URL_MAX_LENGTH) fallback = image;
    }
    return fallback ? { ok: true, image: fallback } : { ok: false, problem: { kind: "too-detailed" } };
  } catch {
    // Undecodable files, and canvases a browser taints, land here.
    return { ok: false, problem: { kind: "unreadable" } };
  } finally {
    decoded?.close();
  }
}

export function describeBrandImageProblem(problem: BrandImageProblem, fileName: string): string {
  switch (problem.kind) {
    case "format":
      return `${fileName} is not a PNG, JPEG, WebP, or SVG image.`;
    case "too-big":
      return `${fileName} is larger than 4 MB. Export a smaller version and try again.`;
    case "unreadable":
      return `${fileName} could not be read as an image.`;
    case "empty":
      return `${fileName} is fully transparent, so there is nothing to show.`;
    case "wide":
      return `${fileName} is ${problem.width} × ${problem.height}, too wide for an icon. Icons need a roughly square image; upload wordmarks as the logo.`;
    case "no-canvas-svg":
      return "This browser cannot convert SVG files. Upload a PNG instead.";
    case "no-canvas-too-big":
      return "This browser cannot resize images. Upload one under 250 KB instead.";
    case "too-detailed":
      return `${fileName} is too detailed to store, even when shrunk. Try a simpler PNG or SVG.`;
  }
}
