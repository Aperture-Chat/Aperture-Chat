import { describe, expect, it } from "vitest";
import { detectMobilePlatform, isRunningStandalone } from "./pwa";

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

describe("detectMobilePlatform", () => {
  it("detects Android phones", () => {
    expect(detectMobilePlatform({ userAgent: ANDROID_UA })).toBe("android");
  });

  it("detects iPhones", () => {
    expect(detectMobilePlatform({ userAgent: IPHONE_UA })).toBe("ios");
  });

  it("detects iPadOS masquerading as a Mac via its touch screen", () => {
    expect(
      detectMobilePlatform({ userAgent: MAC_UA, platform: "MacIntel", maxTouchPoints: 5 }),
    ).toBe("ios");
  });

  it("returns null for desktop browsers", () => {
    expect(
      detectMobilePlatform({ userAgent: MAC_UA, platform: "MacIntel", maxTouchPoints: 0 }),
    ).toBeNull();
    expect(detectMobilePlatform({ userAgent: WINDOWS_UA, platform: "Win32" })).toBeNull();
  });
});

describe("isRunningStandalone", () => {
  it("reports standalone display mode", () => {
    expect(
      isRunningStandalone({
        matchMedia: () => ({ matches: true }),
        navigator: { userAgent: ANDROID_UA },
      }),
    ).toBe(true);
  });

  it("reports iOS home-screen launches via navigator.standalone", () => {
    expect(
      isRunningStandalone({
        matchMedia: () => ({ matches: false }),
        navigator: { userAgent: IPHONE_UA, standalone: true },
      }),
    ).toBe(true);
  });

  it("reports browser-tab sessions as not standalone", () => {
    expect(
      isRunningStandalone({
        matchMedia: () => ({ matches: false }),
        navigator: { userAgent: IPHONE_UA },
      }),
    ).toBe(false);
  });

  it("tolerates environments without matchMedia", () => {
    expect(isRunningStandalone({ navigator: { userAgent: ANDROID_UA } })).toBe(false);
  });
});
