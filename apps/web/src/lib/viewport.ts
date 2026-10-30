import { detectMobilePlatform } from "./pwa";

type NavigatorLike = Parameters<typeof detectMobilePlatform>[0];

/**
 * iOS Safari zooms the whole page when a field whose text is under 16px takes
 * focus, and it stays zoomed after the keyboard closes, so the layout spills
 * past the screen edge. A maximum-scale of 1 stops that focus zoom, and iOS
 * (since iOS 10) ignores the limit for pinch-to-zoom, so people can still
 * zoom by hand. Android and desktop browsers honor maximum-scale as a pinch
 * limit, so only iOS gets it. Call once at startup.
 */
export function preventIosFocusZoom(doc: Document = document, nav: NavigatorLike = window.navigator): void {
  if (detectMobilePlatform(nav) !== "ios") return;
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta || /maximum-scale\s*=/.test(meta.content)) return;
  meta.content = `${meta.content.replace(/[\s,]+$/, "")}, maximum-scale=1`;
}
