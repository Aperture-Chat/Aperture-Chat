export const DEFAULT_BRAND_NAME = "Aperture Chat";
/** Default favicon: the Aperture Chat icon. */
export const DEFAULT_BRAND_ICON = "/favicon.svg";
/** The Aperture Chat wordmark, shown in full-size brand slots until a tenant
 * sets its own logo. */
export const DEFAULT_BRAND_LOGO = "/brand/aperture-chat-logo.png";
/** The Aperture Chat icon, shown in compact slots until a tenant sets its own. */
export const DEFAULT_BRAND_MARK = "/brand/aperture-chat-icon.png";

/** Compact slots (browser tab, collapsed sidebar, reply avatar, home-screen
 * icon) need a roughly square image; a wordmark shrunk into one is
 * unreadable. Mirrors _COMPACT_ICON_MAX_RATIO in services/api/app/routes/pwa.py. */
export const COMPACT_BRAND_MAX_RATIO = 1.6;

export function isCompactBrandImage(width: number, height: number): boolean {
  // Some browsers report 0×0 for an SVG sized only by its viewBox, so a loaded
  // image with unknown dimensions is accepted rather than treated as wide.
  if (width <= 0 || height <= 0) return true;
  return width <= height * COMPACT_BRAND_MAX_RATIO && height <= width * COMPACT_BRAND_MAX_RATIO;
}

/** The tenant branding fields every brand slot reads. Tenant records, the
 * sign-in branding, and the owner console draft all satisfy it. */
export type BrandAssets = {
  chat_brand_name?: string | null;
  logo_url?: string | null;
  icon_url?: string | null;
};

/** The name used in text: browser tabs, replies, install labels. */
export function brandDisplayName(assets?: BrandAssets | null): string {
  return assets?.chat_brand_name?.trim() || DEFAULT_BRAND_NAME;
}

export type BrandLockup = {
  /** Artwork for the slot, or null for the default Aperture Chat icon. */
  imageUrl: string | null;
  /** Which field supplied the artwork: a logo keeps its own proportions,
   * an icon standing in for a missing logo keeps the square mark styling. */
  source: "logo" | "icon" | null;
  /** Name shown beside the artwork; empty for image-only branding. */
  name: string;
};

/** What a full-size brand slot (sidebar, sign-in, empty chat) shows: the logo,
 * or without one the icon, beside the platform name. The name is optional
 * beside artwork, so a logo that already spells it can stand alone. Without
 * any artwork the default wordmark spells the product name on its own, and a
 * custom name keeps the default icon beside it. */
export function brandLockup(assets?: BrandAssets | null): BrandLockup {
  const name = assets?.chat_brand_name?.trim() ?? "";
  const logo = assets?.logo_url?.trim();
  const icon = assets?.icon_url?.trim();
  // The earlier single upload stored one image as both; it keeps the square
  // mark styling it always had.
  if (logo) return { imageUrl: logo, source: logo === icon ? "icon" : "logo", name };
  if (icon) return { imageUrl: icon, source: "icon", name };
  if (!name || name === DEFAULT_BRAND_NAME) return { imageUrl: DEFAULT_BRAND_LOGO, source: "logo", name: "" };
  return { imageUrl: null, source: null, name };
}

/** Images a compact slot may use, best first: the separate icon, then the
 * logo, which qualifies only once it loads roughly square. */
export function compactBrandSources(assets?: BrandAssets | null): string[] {
  const sources: string[] = [];
  for (const url of [assets?.icon_url, assets?.logo_url]) {
    const candidate = url?.trim();
    if (candidate && !sources.includes(candidate)) sources.push(candidate);
  }
  return sources;
}

function setFavicon(link: HTMLLinkElement, href: string) {
  link.href = href;
  link.type = href.endsWith(".svg") || href.startsWith("data:image/svg+xml") ? "image/svg+xml" : "";
}

/** Point the favicon at the first compact source that loads roughly square,
 * or the Aperture mark. An already-verified icon stays up while re-checking,
 * so re-renders do not flash the default. The cleanup stops an old image
 * load from replacing newer tenant branding. */
export function applyBrandFavicon(
  sources: readonly string[],
  onApplied?: (href: string) => void,
): () => void {
  let active = true;
  let image: HTMLImageElement | null = null;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  const faviconLink = link;
  const apply = (href: string) => {
    if (!active) return;
    setFavicon(faviconLink, href);
    onApplied?.(href);
  };
  const candidates = sources.filter((source) => source && source !== DEFAULT_BRAND_ICON);
  const current = faviconLink.getAttribute("href") ?? "";
  apply(candidates.includes(current) ? current : DEFAULT_BRAND_ICON);

  const check = (index: number) => {
    if (!active) return;
    if (index >= candidates.length) {
      apply(DEFAULT_BRAND_ICON);
      return;
    }
    const candidate = candidates[index];
    const probe = new Image();
    image = probe;
    probe.onload = () => {
      if (isCompactBrandImage(probe.naturalWidth, probe.naturalHeight)) apply(candidate);
      else check(index + 1);
    };
    probe.onerror = () => check(index + 1);
    probe.src = candidate;
  };
  if (candidates.length) check(0);

  return () => {
    active = false;
    if (image) {
      image.onload = null;
      image.onerror = null;
    }
  };
}
