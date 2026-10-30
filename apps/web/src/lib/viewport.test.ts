import { afterEach, describe, expect, it } from "vitest";
import { preventIosFocusZoom } from "./viewport";

const BASE = "width=device-width, initial-scale=1.0";
const IPHONE = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1", platform: "iPhone", maxTouchPoints: 5 };
const IPAD_AS_MAC = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15", platform: "MacIntel", maxTouchPoints: 5 };
const MAC = { userAgent: IPAD_AS_MAC.userAgent, platform: "MacIntel", maxTouchPoints: 0 };
const ANDROID = { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36", platform: "Linux armv8l", maxTouchPoints: 5 };

function viewport(content = BASE): HTMLMetaElement {
  document.head.innerHTML = "";
  const meta = document.createElement("meta");
  meta.name = "viewport";
  meta.content = content;
  document.head.append(meta);
  return meta;
}

afterEach(() => {
  document.head.innerHTML = "";
});

describe("preventIosFocusZoom", () => {
  it("stops iPhone Safari from zooming into a focused field", () => {
    const meta = viewport();
    preventIosFocusZoom(document, IPHONE);
    expect(meta.content).toBe(`${BASE}, maximum-scale=1`);
  });

  it("treats iPadOS, which reports a Mac with a touch screen, as iOS", () => {
    const meta = viewport();
    preventIosFocusZoom(document, IPAD_AS_MAC);
    expect(meta.content).toBe(`${BASE}, maximum-scale=1`);
  });

  it("leaves Android and desktop alone, where maximum-scale would block pinch zoom", () => {
    for (const nav of [ANDROID, MAC]) {
      const meta = viewport();
      preventIosFocusZoom(document, nav);
      expect(meta.content).toBe(BASE);
    }
  });

  it("adds the limit once however many times it runs", () => {
    const meta = viewport();
    preventIosFocusZoom(document, IPHONE);
    preventIosFocusZoom(document, IPHONE);
    expect(meta.content.match(/maximum-scale/g)).toHaveLength(1);
  });

  it("keeps a maximum-scale the page already declares", () => {
    const meta = viewport(`${BASE}, maximum-scale=5`);
    preventIosFocusZoom(document, IPHONE);
    expect(meta.content).toBe(`${BASE}, maximum-scale=5`);
  });

  it("does nothing when the page has no viewport tag", () => {
    document.head.innerHTML = "";
    expect(() => preventIosFocusZoom(document, IPHONE)).not.toThrow();
  });
});
