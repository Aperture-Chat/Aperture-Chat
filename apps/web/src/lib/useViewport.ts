import { useEffect, useState } from "react";

/** Tracks the viewport width so layout can adapt (auto-collapse rails, drawers, etc.). */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));

  useEffect(() => {
    if (typeof window === "undefined") return;
    let frame = 0;
    function onResize() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(window.innerWidth));
    }
    window.addEventListener("resize", onResize);
    setWidth(window.innerWidth);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return width;
}

export const BREAKPOINTS = {
  /** Sidebar becomes an off-canvas drawer below this width. */
  drawer: 900,
  /** Chat inspector panel overlays instead of taking a column below this width. */
  inspectorOverlay: 1180,
} as const;
