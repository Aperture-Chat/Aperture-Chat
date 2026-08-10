/* Progressive-web-app install support: mobile platform detection and capture
 * of the browser install prompt. Chromium on Android fires
 * `beforeinstallprompt` once its install criteria pass — sometimes before
 * React mounts — so capture is initialized from main.tsx and the App
 * subscribes afterwards. iOS exposes no install API at all; detection lets
 * the UI show honest Add-to-Home-Screen guidance instead of an install
 * button that could not work. */

export type MobilePlatform = "ios" | "android";

/* Chromium's BeforeInstallPromptEvent; not in the standard DOM lib types. */
export type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

type NavigatorLike = {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
};

type WindowLike = {
  matchMedia?: (query: string) => { matches: boolean };
  navigator: NavigatorLike;
};

let capturedPrompt: InstallPromptEvent | null = null;
const promptSubscribers = new Set<() => void>();

/** Call once before render so an early beforeinstallprompt is not missed. */
export function initPwaInstallCapture(): void {
  window.addEventListener("beforeinstallprompt", (event) => {
    /* Chrome would otherwise show its own mini-infobar at an arbitrary
     * moment; the App surfaces the prompt after sign-in instead. */
    event.preventDefault();
    capturedPrompt = event as InstallPromptEvent;
    promptSubscribers.forEach((notify) => notify());
  });
  window.addEventListener("appinstalled", () => {
    capturedPrompt = null;
    promptSubscribers.forEach((notify) => notify());
  });
}

export function getCapturedInstallPrompt(): InstallPromptEvent | null {
  return capturedPrompt;
}

/** Notifies when installability changes (prompt captured or app installed). */
export function subscribeToInstallPrompt(notify: () => void): () => void {
  promptSubscribers.add(notify);
  return () => {
    promptSubscribers.delete(notify);
  };
}

export function detectMobilePlatform(
  nav: NavigatorLike = window.navigator,
): MobilePlatform | null {
  if (/android/i.test(nav.userAgent)) return "android";
  if (/iphone|ipad|ipod/i.test(nav.userAgent)) return "ios";
  // iPadOS 13+ reports itself as a Mac; the touch screen gives it away.
  if (nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1) return "ios";
  return null;
}

/** True when already launched from a home-screen install, where offering an
 * install again would be meaningless. */
export function isRunningStandalone(win: WindowLike = window): boolean {
  try {
    if (win.matchMedia?.("(display-mode: standalone)").matches) return true;
  } catch {
    // matchMedia is unavailable in some test environments; fall through.
  }
  return win.navigator.standalone === true;
}
