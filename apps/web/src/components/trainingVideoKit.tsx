import type { Caption } from "@remotion/captions";
import { FileDown } from "lucide-react";
import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

/* Shared engine for the training walkthrough videos (user guide and owner
 * documentation). Every scene focuses one region of a real captured platform
 * screen; the callout corner, arrow, caption band, and pointer are all derived
 * from the region rect, so adding a focus only needs a frame path and a
 * rectangle. */

export const TRAINING_FPS = 30;
export const TRAINING_WIDTH = 1185;
export const TRAINING_HEIGHT = 855;

export type FocusRect = { x: number; y: number; w: number; h: number };

export type FocusRegion = { frame: string; rect: FocusRect; zoom?: number };

export type TrainingScene = {
  title: string;
  caption: string;
  narration: string;
  durationSeconds: number;
  focus: string;
  calloutPlacement?: CalloutPlacement;
};

export type TrainingVideoBase = {
  id: string;
  title: string;
  description: string;
  audioSrc?: string;
  scenes: TrainingScene[];
  outcomes: string[];
  setupSteps?: string[];
};

export type TimedScene = TrainingScene & { startSeconds: number; endSeconds: number };

export type CalloutPlacement =
  | "lower-left"
  | "lower-right"
  | "upper-left"
  | "upper-right"
  | "left-rail"
  | "right-mid";

type Vec = { x: number; y: number };

/* Mirror of the .training-title-card placement CSS. Height varies with the
 * caption length, so it is deliberately UNDER-estimated: the arrow root is
 * pulled inside this rect and the card (higher z-index) hides it, so an
 * under-estimate keeps the root tucked under the real card no matter how the
 * text wraps. */
const CARD_ESTIMATED_HEIGHT = 118;
const CARD_RECTS: Record<CalloutPlacement, FocusRect> = {
  "upper-left": { x: 292, y: 112, w: 470, h: CARD_ESTIMATED_HEIGHT },
  "upper-right": { x: TRAINING_WIDTH - 68 - 470, y: 112, w: 470, h: CARD_ESTIMATED_HEIGHT },
  "lower-left": { x: 292, y: TRAINING_HEIGHT - 96 - CARD_ESTIMATED_HEIGHT, w: 740, h: CARD_ESTIMATED_HEIGHT },
  "lower-right": { x: TRAINING_WIDTH - 72 - 520, y: TRAINING_HEIGHT - 96 - CARD_ESTIMATED_HEIGHT, w: 520, h: CARD_ESTIMATED_HEIGHT },
  "left-rail": { x: 34, y: 392, w: 236, h: CARD_ESTIMATED_HEIGHT },
  "right-mid": { x: TRAINING_WIDTH - 58 - 360, y: 362, w: 360, h: CARD_ESTIMATED_HEIGHT },
};

const ARROW_ROOT_INSET = 12;
const ARROW_STANDOFF = 14;
const MIN_ARROW_LENGTH = 64;

type SceneLayout = {
  placement: CalloutPlacement;
  caption: "bottom" | "top";
  arrowStart: Vec | null;
  arrowEnd: Vec | null;
  /** Unit direction the arrowhead points in (toward the focus rect center). */
  arrowAim: Vec | null;
  /** Outward normal of the card edge the arrow leaves through. */
  arrowLeave: Vec | null;
};

function normalize(v: Vec): Vec | null {
  const length = Math.hypot(v.x, v.y);
  return length > 0.0001 ? { x: v.x / length, y: v.y / length } : null;
}

/** Point where the ray from the rect center toward `target` crosses the rect
 * boundary, plus the outward normal of the crossed edge. */
function rectExitPoint(rect: FocusRect, target: Vec): { point: Vec; normal: Vec } | null {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = target.x - cx;
  const dy = target.y - cy;
  if (dx === 0 && dy === 0) {
    return null;
  }
  const tx = dx !== 0 ? rect.w / 2 / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const ty = dy !== 0 ? rect.h / 2 / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const t = Math.min(tx, ty);
  return {
    point: { x: cx + dx * t, y: cy + dy * t },
    normal: tx <= ty ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) },
  };
}

/** First point where the segment from `from` toward the center of `rect`
 * (expanded by `pad`) crosses the expanded boundary. Null when `from` is
 * already inside the expanded rect. */
function rectEntryPoint(from: Vec, rect: FocusRect, pad: number): Vec | null {
  const x0 = rect.x - pad;
  const y0 = rect.y - pad;
  const x1 = rect.x + rect.w + pad;
  const y1 = rect.y + rect.h + pad;
  if (from.x >= x0 && from.x <= x1 && from.y >= y0 && from.y <= y1) {
    return null;
  }
  const dx = (x0 + x1) / 2 - from.x;
  const dy = (y0 + y1) / 2 - from.y;
  let tMin = 0;
  let tMax = 1;
  if (dx !== 0) {
    const lo = Math.min((x0 - from.x) / dx, (x1 - from.x) / dx);
    const hi = Math.max((x0 - from.x) / dx, (x1 - from.x) / dx);
    tMin = Math.max(tMin, lo);
    tMax = Math.min(tMax, hi);
  }
  if (dy !== 0) {
    const lo = Math.min((y0 - from.y) / dy, (y1 - from.y) / dy);
    const hi = Math.max((y0 - from.y) / dy, (y1 - from.y) / dy);
    tMin = Math.max(tMin, lo);
    tMax = Math.min(tMax, hi);
  }
  if (tMin > tMax || tMin <= 0) {
    return null;
  }
  return { x: from.x + dx * tMin, y: from.y + dy * tMin };
}

/** Places the callout in the quadrant opposite the focused rect and aims the
 * arrow from the card's facing edge to just short of the rect, pointing at
 * its center. */
export function layoutForRect(rect: FocusRect, preferredPlacement?: CalloutPlacement): SceneLayout {
  const target: Vec = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  const horizontal = target.x >= TRAINING_WIDTH / 2 ? "left" : "right";
  const vertical = target.y >= TRAINING_HEIGHT / 2 ? "upper" : "lower";
  const placement = preferredPlacement ?? (`${vertical}-${horizontal}` as CalloutPlacement);
  const caption = rect.y + rect.h > 620 && placement.startsWith("upper") ? "top" : "bottom";
  const noArrow: SceneLayout = { placement, caption, arrowStart: null, arrowEnd: null, arrowAim: null, arrowLeave: null };

  const card = CARD_RECTS[placement];
  const exit = rectExitPoint(card, target);
  if (!exit) {
    return noArrow;
  }
  const rayDir = normalize({ x: target.x - (card.x + card.w / 2), y: target.y - (card.y + card.h / 2) });
  if (!rayDir) {
    return noArrow;
  }
  const start: Vec = {
    x: exit.point.x - rayDir.x * ARROW_ROOT_INSET,
    y: exit.point.y - rayDir.y * ARROW_ROOT_INSET,
  };
  const end = rectEntryPoint(start, rect, ARROW_STANDOFF);
  if (!end || Math.hypot(end.x - start.x, end.y - start.y) < MIN_ARROW_LENGTH) {
    // The focus rect is under or right next to the card — the highlight alone
    // reads better than a stub arrow.
    return noArrow;
  }
  const aim = normalize({ x: target.x - end.x, y: target.y - end.y });
  if (!aim) {
    return noArrow;
  }
  return { placement, caption, arrowStart: start, arrowEnd: end, arrowAim: aim, arrowLeave: exit.normal };
}

function lerpRect(from: FocusRect, to: FocusRect, t: number): FocusRect {
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    w: from.w + (to.w - from.w) * t,
    h: from.h + (to.h - from.h) * t,
  };
}

export function TrainingComposition({
  video,
  regions,
  badge,
}: {
  video: TrainingVideoBase;
  regions: Record<string, FocusRegion>;
  badge: string;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentSeconds = frame / fps;
  const timeline = getSceneTimeline(video);
  const activeScene = getActiveScene(timeline, currentSeconds);
  const activeIndex = timeline.indexOf(activeScene);
  const previousScene = activeIndex > 0 ? timeline[activeIndex - 1] : null;
  const captions = buildCaptions(video);
  const activeRegion = regions[activeScene.focus];
  const previousRegion = previousScene ? regions[previousScene.focus] : null;
  const activeLayout = layoutForRect(activeRegion.rect, activeScene.calloutPlacement);

  /* Scene hand-off: when consecutive scenes share a frame the highlight
   * glides between the two rects; when the frame changes the screenshots
   * crossfade and the highlight settles in fresh. */
  const sceneLocalFrame = frame - Math.floor(activeScene.startSeconds * fps);
  const transition = interpolate(sceneLocalFrame, [0, 14], [0, 1], {
    easing: Easing.bezier(0.22, 1, 0.36, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const sameImage = previousRegion !== null && previousRegion.frame === activeRegion.frame;
  const crossfading = previousRegion !== null && !sameImage && transition < 1;
  const highlightRect =
    sameImage && previousRegion && transition < 1
      ? lerpRect(previousRegion.rect, activeRegion.rect, transition)
      : activeRegion.rect;
  const highlightOpacity = sameImage ? 1 : transition;
  const highlightScale = sameImage ? 1 : 1.05 - 0.05 * transition;

  /* Ambient pulse ring so the focused control keeps drawing the eye. */
  const pulseCycle = (currentSeconds % 2.4) / 2.4;
  const pulseGrow = interpolate(pulseCycle, [0, 0.6], [0, 1], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const pulsePad = 5 + 11 * pulseGrow;
  const pulseOpacity =
    interpolate(pulseCycle, [0, 0.12, 0.6], [0, 0.38, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }) * highlightOpacity;

  return (
    <AbsoluteFill className="owner-training-composition">
      {video.audioSrc ? <Audio src={staticFile(video.audioSrc)} /> : null}
      <div className="training-recorded-frame">
        {crossfading && previousRegion ? (
          <Img
            className="training-recorded-image"
            src={staticFile(previousRegion.frame)}
            style={{ transform: `scale(${previousRegion.zoom ?? 1})`, transformOrigin: "top left" }}
            alt=""
          />
        ) : null}
        <Img
          className="training-recorded-image"
          src={staticFile(activeRegion.frame)}
          style={{
            opacity: crossfading ? transition : 1,
            transform: `scale(${activeRegion.zoom ?? 1})`,
            transformOrigin: "top left",
          }}
          alt=""
        />
        <div
          className="training-highlight-pulse"
          style={{
            left: highlightRect.x - pulsePad,
            top: highlightRect.y - pulsePad,
            width: highlightRect.w + pulsePad * 2,
            height: highlightRect.h + pulsePad * 2,
            opacity: pulseOpacity,
          }}
        />
        <div
          className="training-highlight"
          style={{
            left: highlightRect.x,
            top: highlightRect.y,
            width: highlightRect.w,
            height: highlightRect.h,
            opacity: highlightOpacity,
            transform: `scale(${highlightScale})`,
          }}
        />
      </div>
      {timeline.map((scene) => (
        <Sequence
          key={scene.title}
          from={Math.floor(scene.startSeconds * fps)}
          durationInFrames={Math.floor((scene.endSeconds - scene.startSeconds) * fps)}
          premountFor={fps}
        >
          <TrainingSceneCallout scene={scene} regions={regions} badge={badge} />
        </Sequence>
      ))}
      <TrainingCaptionTrack captions={captions} placement={activeLayout.caption} />
    </AbsoluteFill>
  );
}

function TrainingSceneCallout({
  scene,
  regions,
  badge,
}: {
  scene: TimedScene;
  regions: Record<string, FocusRegion>;
  badge: string;
}) {
  const frame = useCurrentFrame();
  const layout = layoutForRect(regions[scene.focus].rect, scene.calloutPlacement);
  const enter = interpolate(frame, [0, 12], [0.92, 1], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const exit = interpolate(
    frame,
    [Math.max(24, scene.durationSeconds * TRAINING_FPS - 18), scene.durationSeconds * TRAINING_FPS],
    [1, 0],
    { easing: Easing.in(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const opacity = enter * exit;
  const translateY = interpolate(enter, [0.92, 1], [8, 0]);

  return (
    <>
      {layout.arrowStart && layout.arrowEnd && layout.arrowAim && layout.arrowLeave && (
        <TrainingSceneArrow
          start={layout.arrowStart}
          end={layout.arrowEnd}
          aim={layout.arrowAim}
          leave={layout.arrowLeave}
          opacity={opacity}
        />
      )}
      <div
        className={`training-title-card placement-${layout.placement}`}
        style={{ opacity, transform: `translateY(${translateY}px)` }}
      >
        <span>{badge}</span>
        <strong>{scene.title}</strong>
        <p>{scene.caption}</p>
      </div>
    </>
  );
}

function cubicPoint(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

function cubicLength(p0: Vec, p1: Vec, p2: Vec, p3: Vec): number {
  let length = 0;
  let prev = p0;
  for (let i = 1; i <= 16; i += 1) {
    const point = cubicPoint(p0, p1, p2, p3, i / 16);
    length += Math.hypot(point.x - prev.x, point.y - prev.y);
    prev = point;
  }
  return length;
}

function TrainingSceneArrow({
  start,
  end,
  aim,
  leave,
  opacity,
}: {
  start: Vec;
  end: Vec;
  aim: Vec;
  leave: Vec;
  opacity: number;
}) {
  const frame = useCurrentFrame();
  /* The stroke stops short of the tip so the head, not the line cap, defines
   * the point. The head is a separate polygon rotated onto the aim direction,
   * and the curve's end tangent runs along that same direction, so the arrow
   * always lands pointing at the focused control. */
  const headLength = 17;
  const lineEnd: Vec = { x: end.x - aim.x * (headLength * 0.55), y: end.y - aim.y * (headLength * 0.55) };
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const leaveReach = Math.min(Math.max(distance * 0.32, 36), 120);
  const aimReach = Math.min(Math.max(distance * 0.38, 42), 140);
  const c1: Vec = { x: start.x + leave.x * leaveReach, y: start.y + leave.y * leaveReach };
  const c2: Vec = { x: lineEnd.x - aim.x * aimReach, y: lineEnd.y - aim.y * aimReach };
  const path = `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${lineEnd.x} ${lineEnd.y}`;

  const pathLength = cubicLength(start, c1, c2, lineEnd);
  const draw = interpolate(frame, [3, 24], [0, 1], {
    easing: Easing.bezier(0.33, 1, 0.68, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const dashOffset = pathLength * (1 - draw);
  const headOpacity = interpolate(draw, [0.72, 0.95], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const headScale = 0.6 + 0.4 * headOpacity;
  const headAngle = (Math.atan2(aim.y, aim.x) * 180) / Math.PI;

  return (
    <svg
      className="training-callout-arrow-layer"
      viewBox={`0 0 ${TRAINING_WIDTH} ${TRAINING_HEIGHT}`}
      style={{ opacity }}
      aria-hidden="true"
    >
      <path
        className="training-callout-arrow-casing"
        d={path}
        strokeDasharray={pathLength}
        strokeDashoffset={dashOffset}
      />
      <path
        className="training-callout-arrow-path"
        d={path}
        strokeDasharray={pathLength}
        strokeDashoffset={dashOffset}
      />
      <path
        className="training-callout-arrow-head"
        d={`M 0 0 L ${-headLength} -8 L ${-headLength + 4.5} 0 L ${-headLength} 8 Z`}
        transform={`translate(${end.x} ${end.y}) rotate(${headAngle}) scale(${headScale})`}
        opacity={headOpacity}
      />
    </svg>
  );
}

export function TrainingCaptionTrack({
  captions,
  placement,
}: {
  captions: Caption[];
  placement: "bottom" | "top";
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentMs = (frame / fps) * 1000;
  const activeCaption = captions.find((caption) => currentMs >= caption.startMs && currentMs < caption.endMs);

  if (!activeCaption) {
    return null;
  }

  return <div className={`training-caption placement-${placement}`}>{activeCaption.text}</div>;
}

export function buildCaptions(video: TrainingVideoBase): Caption[] {
  let cursor = 0;
  return video.scenes.map((scene) => {
    const startMs = cursor * 1000;
    cursor += scene.durationSeconds;
    const endMs = cursor * 1000;
    return { text: scene.caption, startMs, endMs, timestampMs: startMs, confidence: 1 };
  });
}

export function getSceneTimeline(video: TrainingVideoBase): TimedScene[] {
  let cursor = 0;
  return video.scenes.map((scene) => {
    const startSeconds = cursor;
    cursor += scene.durationSeconds;
    return { ...scene, startSeconds, endSeconds: cursor };
  });
}

export function getActiveScene(timeline: TimedScene[], currentSeconds: number): TimedScene {
  return (
    timeline.find((scene) => currentSeconds >= scene.startSeconds && currentSeconds < scene.endSeconds) ??
    timeline[timeline.length - 1]
  );
}

export function getVideoDuration(video: TrainingVideoBase): number {
  return video.scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
}

export function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/* Download row for the role guides generated by scripts/guide-pdfs/generate.cjs
 * into public/docs. Shared by the Help drawer and both console documentation
 * modals so the three surfaces stay consistent. */
export function GuidePdfDownload({
  href,
  title,
  description,
  tooltip,
}: {
  href: string;
  title: string;
  description: string;
  tooltip: string;
}) {
  return (
    <a className="guide-pdf-download" href={href} download data-tooltip={tooltip}>
      <span className="guide-pdf-icon">
        <FileDown size={17} />
      </span>
      <span className="guide-pdf-copy">
        <strong>{title}</strong>
        <span>{description}</span>
      </span>
      <span className="guide-pdf-badge">PDF</span>
    </a>
  );
}
