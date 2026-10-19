import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_BRAND_LOGO, DEFAULT_BRAND_NAME, applyBrandFavicon, brandLockup, compactBrandSources } from "./brandIcon";
import { applyCachedBrandBoot, cacheBrandBoot, readBrandBoot } from "./brandTheme";

type FakeImage = {
  naturalWidth: number;
  naturalHeight: number;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  src: string;
};
let images: FakeImage[];

beforeEach(() => {
  images = [];
  localStorage.clear();
  document.querySelector('link[rel="icon"]')?.remove();
  vi.stubGlobal("Image", class {
    naturalWidth = 256;
    naturalHeight = 256;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    src = "";
    constructor() {
      images.push(this);
    }
  });
});
afterEach(() => vi.unstubAllGlobals());

const favicon = () => document.querySelector('link[rel="icon"]');

test("uses the Aperture mark when no icon or logo is set", () => {
  applyBrandFavicon([]);
  expect(favicon()).toHaveAttribute("href", "/favicon.svg");
  expect(images).toHaveLength(0);
});

test("applies and caches a custom icon only after it passes the square check", () => {
  applyBrandFavicon(["/square.png"], (href) => cacheBrandBoot({ favicon: href, faviconVerified: true }));
  expect(favicon()).toHaveAttribute("href", "/favicon.svg");
  expect(readBrandBoot()?.favicon).toBe("/favicon.svg");
  images[0].onload?.();
  expect(favicon()).toHaveAttribute("href", "/square.png");
  expect(readBrandBoot()?.favicon).toBe("/square.png");
});

test.each([[1024, 211], [211, 1024]])("skips %i x %i artwork and falls back to the next source", (width, height) => {
  applyBrandFavicon(["/wordmark.png", "/square-logo.png"]);
  images[0].naturalWidth = width;
  images[0].naturalHeight = height;
  images[0].onload?.();
  expect(favicon()).toHaveAttribute("href", "/favicon.svg");
  images[1].onload?.();
  expect(favicon()).toHaveAttribute("href", "/square-logo.png");
});

test("keeps the mark when every source is wide or broken", () => {
  applyBrandFavicon(["/missing.png", "/wordmark.png"]);
  images[0].onerror?.();
  images[1].naturalWidth = 1200;
  images[1].naturalHeight = 300;
  images[1].onload?.();
  expect(favicon()).toHaveAttribute("href", "/favicon.svg");
});

test("a verified icon stays up while it is re-checked, so re-renders do not flash the default", () => {
  applyBrandFavicon(["/square.png"]);
  images[0].onload?.();
  const hrefs: string[] = [];
  applyBrandFavicon(["/square.png"], (href) => hrefs.push(href));
  expect(hrefs).toEqual(["/square.png"]);
  expect(favicon()).toHaveAttribute("href", "/square.png");
});

test("a late load from older branding cannot replace newer branding", () => {
  const cancel = applyBrandFavicon(["/old.png"]);
  const oldLoad = images[0].onload;
  cancel();
  applyBrandFavicon(["/new.svg"]);
  images[1].onload?.();
  oldLoad?.();
  expect(favicon()).toHaveAttribute("href", "/new.svg");
  expect(favicon()).toHaveAttribute("type", "image/svg+xml");
});

test("accepts a loaded SVG that reports no intrinsic size", () => {
  applyBrandFavicon(["/viewbox-only.svg"]);
  images[0].naturalWidth = 0;
  images[0].naturalHeight = 0;
  images[0].onload?.();
  expect(favicon()).toHaveAttribute("href", "/viewbox-only.svg");
});

test("the boot cache never restores an unverified favicon", () => {
  // Caches written before the square check could hold a full wordmark.
  cacheBrandBoot({ name: "Example", favicon: "/wordmark.png" });
  applyCachedBrandBoot();
  expect(favicon()).toBeNull();
  cacheBrandBoot({ name: "Example", favicon: "/square.png", faviconVerified: true });
  applyCachedBrandBoot();
  expect(favicon()).toHaveAttribute("href", "/square.png");
});

test("full brand slots prefer the logo, and an empty name leaves artwork to stand alone", () => {
  // Without artwork the default wordmark spells the product name.
  const wordmark = { imageUrl: DEFAULT_BRAND_LOGO, source: "logo", name: "" };
  expect(brandLockup(null)).toEqual(wordmark);
  expect(brandLockup({ chat_brand_name: "  " })).toEqual(wordmark);
  expect(brandLockup({ chat_brand_name: DEFAULT_BRAND_NAME })).toEqual(wordmark);
  // A different name never sits under the Aperture Chat wordmark.
  expect(brandLockup({ chat_brand_name: "Litigation Desk" })).toEqual({ imageUrl: null, source: null, name: "Litigation Desk" });
  expect(brandLockup({ chat_brand_name: "Acme", icon_url: "/icon.png" })).toMatchObject({
    imageUrl: "/icon.png",
    source: "icon",
    name: "Acme",
  });
  expect(brandLockup({ chat_brand_name: "Acme", logo_url: " /logo.png ", icon_url: "/icon.png" })).toEqual({
    imageUrl: "/logo.png",
    source: "logo",
    name: "Acme",
  });
  expect(brandLockup({ chat_brand_name: " ", logo_url: "/logo.png" })).toEqual({
    imageUrl: "/logo.png",
    source: "logo",
    name: "",
  });
  // One image saved as both (the earlier single upload) keeps its mark styling.
  expect(brandLockup({ chat_brand_name: "Acme", logo_url: "/mark.png", icon_url: "/mark.png" })).toEqual({
    imageUrl: "/mark.png",
    source: "icon",
    name: "Acme",
  });
});

test("compact slots try the icon, then the logo, without duplicates", () => {
  expect(compactBrandSources({ icon_url: "/icon.png", logo_url: "/logo.png" })).toEqual(["/icon.png", "/logo.png"]);
  expect(compactBrandSources({ icon_url: " ", logo_url: "/logo.png" })).toEqual(["/logo.png"]);
  expect(compactBrandSources({ icon_url: "/same.png", logo_url: "/same.png" })).toEqual(["/same.png"]);
  expect(compactBrandSources(null)).toEqual([]);
});
