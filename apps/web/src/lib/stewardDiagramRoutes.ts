/** Arrow geometry for structure charts.
 *
 * Every arrow is first a skeleton — two points (a straight run) or four
 * points (out, a middle run, in) — then drawn in the chart's connector style.
 * The middle run is what a reader drags: `bend` offsets it along its axis,
 * and the handle records how a pointer position maps back to a bend.
 */

export type Point = [number, number];

export type StewardDiagramConnector = "elbow" | "curved" | "straight";

/** A card as the router sees it; anchors sit on the header's midline. */
export type RouteBox = { x: number; y: number; width: number; height: number; headerHeight: number };

/** Drag handle on an arrow's middle run: coordinate = origin + gain × bend. */
export type StewardEdgeHandle = { x: number; y: number; axis: "x" | "y"; origin: number; gain: number };

export type EdgeSkeleton = {
  points: Point[];
  /** Label anchor for runs without a movable middle. */
  label?: Point;
  /** The axis the middle run moves along (four-point skeletons only). */
  axis?: "x" | "y";
};

export type EdgeRoute = {
  d: string;
  label: Point;
  handle?: StewardEdgeHandle;
  ends: { from: Point; to: Point };
};

/** Clearance between boxes before an arrow prefers that axis. */
const FACING_GAP = 12;
/** Arrowheads stop short of the target so the marker tip meets the border. */
const ARROW_GAP = 4;
/** Share of the curve's midpoint that follows its control run. */
const CURVE_GAIN = 0.75;

/** Orthogonal connector with softly rounded elbows. */
export function elbowPath(points: Point[], radius = 9): string {
  let d = `M ${points[0]![0]} ${points[0]![1]}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const [px, py] = points[index - 1]!;
    const [cx, cy] = points[index]!;
    const [nx, ny] = points[index + 1]!;
    const inLength = Math.hypot(cx - px, cy - py);
    const outLength = Math.hypot(nx - cx, ny - cy);
    const r = Math.min(radius, inLength / 2, outLength / 2);
    if (r < 1) {
      d += ` L ${cx} ${cy}`;
      continue;
    }
    const ax = cx - ((cx - px) / inLength) * r;
    const ay = cy - ((cy - py) / inLength) * r;
    const bx = cx + ((nx - cx) / outLength) * r;
    const by = cy + ((ny - cy) / outLength) * r;
    d += ` L ${ax} ${ay} Q ${cx} ${cy} ${bx} ${by}`;
  }
  const last = points[points.length - 1]!;
  return `${d} L ${last[0]} ${last[1]}`;
}

/** A four-point skeleton whose middle run sits at `run` along `axis`. */
export function runSkeleton(start: Point, end: Point, axis: "x" | "y", run: number): EdgeSkeleton {
  const points: Point[] =
    axis === "y"
      ? [start, [start[0], run], [end[0], run], end]
      : [start, [run, start[1]], [run, end[1]], end];
  return { points, axis };
}

function center(box: RouteBox): Point {
  return [box.x + box.width / 2, box.y + box.height / 2];
}

function separatedVertically(from: RouteBox, to: RouteBox): boolean {
  return to.y >= from.y + from.height + FACING_GAP || to.y + to.height <= from.y - FACING_GAP;
}

function separatedHorizontally(from: RouteBox, to: RouteBox): boolean {
  return to.x >= from.x + from.width + FACING_GAP || to.x + to.width <= from.x - FACING_GAP;
}

/** Where a ray from the box center toward `toward` leaves the box. */
function borderPoint(box: RouteBox, toward: Point): Point {
  const [cx, cy] = center(box);
  const dx = toward[0] - cx;
  const dy = toward[1] - cy;
  const scaleX = dx === 0 ? Infinity : box.width / 2 / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : box.height / 2 / Math.abs(dy);
  const t = Math.min(scaleX, scaleY, 1);
  return [cx + dx * t, cy + dy * t];
}

/** Center-to-center segment cut at both borders, the end pulled back for
 * the arrowhead. */
export function clippedCenterLine(from: RouteBox, to: RouteBox): Point[] {
  const start = borderPoint(from, center(to));
  const entry = borderPoint(to, center(from));
  const length = Math.hypot(entry[0] - start[0], entry[1] - start[1]);
  if (length <= ARROW_GAP) return [start, entry];
  const pull = ARROW_GAP / length;
  return [start, [entry[0] - (entry[0] - start[0]) * pull, entry[1] - (entry[1] - start[1]) * pull]];
}

function verticalSkeleton(from: RouteBox, to: RouteBox, bend: number): EdgeSkeleton {
  const down = to.y > from.y;
  const start: Point = [from.x + from.width / 2, down ? from.y + from.height : from.y];
  const end: Point = [to.x + to.width / 2, down ? to.y - ARROW_GAP : to.y + to.height + ARROW_GAP];
  const base = (start[1] + end[1]) / 2;
  if (Math.abs(start[0] - end[0]) < 1) return { points: [start, end], label: [start[0], base - 13] };
  return runSkeleton(start, end, "y", base + bend);
}

function horizontalSkeleton(from: RouteBox, to: RouteBox, bend: number): EdgeSkeleton {
  const right = to.x > from.x;
  const start: Point = [right ? from.x + from.width : from.x, from.y + from.headerHeight / 2];
  const end: Point = [right ? to.x - ARROW_GAP : to.x + to.width + ARROW_GAP, to.y + to.headerHeight / 2];
  const base = (start[0] + end[0]) / 2;
  if (Math.abs(start[1] - end[1]) < 1) return { points: [start, end], label: [base, start[1] - 16] };
  return runSkeleton(start, end, "x", base + bend);
}

/** Skeleton between two freely placed boxes: leave and enter through the
 * facing sides, preferring a vertical run when the boxes clear each other
 * vertically. Overlapping boxes get a direct line. */
export function freeEdgeSkeleton(from: RouteBox, to: RouteBox, bend: number): EdgeSkeleton {
  if (separatedVertically(from, to)) return verticalSkeleton(from, to, bend);
  if (separatedHorizontally(from, to)) return horizontalSkeleton(from, to, bend);
  const points = clippedCenterLine(from, to);
  return { points, label: midLabel(points) };
}

function midLabel(points: Point[]): Point {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2 - 7];
}

function ends(points: Point[]): EdgeRoute["ends"] {
  return { from: points[0]!, to: points[points.length - 1]! };
}

function lineRoute(points: Point[], label: Point): EdgeRoute {
  return { d: elbowPath(points), label, ends: ends(points) };
}

function runRoute(points: Point[], axis: "x" | "y", connector: "elbow" | "curved", bend: number): EdgeRoute {
  const [p0, p1, p2, p3] = points as [Point, Point, Point, Point];
  const curved = connector === "curved";
  const gain = curved ? CURVE_GAIN : 1;
  const hx = curved ? (p0[0] + 3 * p1[0] + 3 * p2[0] + p3[0]) / 8 : (p1[0] + p2[0]) / 2;
  const hy = curved ? (p0[1] + 3 * p1[1] + 3 * p2[1] + p3[1]) / 8 : (p1[1] + p2[1]) / 2;
  const coordinate = axis === "y" ? hy : hx;
  const d = curved
    ? `M ${p0[0]} ${p0[1]} C ${p1[0]} ${p1[1]} ${p2[0]} ${p2[1]} ${p3[0]} ${p3[1]}`
    : elbowPath(points);
  return {
    d,
    label: axis === "y" ? [hx, hy - 13] : [hx, hy - 7],
    handle: { x: hx, y: hy, axis, origin: coordinate - gain * bend, gain },
    ends: ends(points),
  };
}

/** Draws a skeleton in the chart's connector style. Straight connectors
 * ignore the skeleton and run center to center. */
export function drawEdgeRoute(
  skeleton: EdgeSkeleton,
  connector: StewardDiagramConnector,
  from: RouteBox,
  to: RouteBox,
  bend: number,
): EdgeRoute {
  if (connector === "straight") {
    const points = clippedCenterLine(from, to);
    return lineRoute(points, midLabel(points));
  }
  if (skeleton.axis && skeleton.points.length === 4) {
    return runRoute(skeleton.points, skeleton.axis, connector, bend);
  }
  return lineRoute(skeleton.points, skeleton.label ?? midLabel(skeleton.points));
}

/** The bend that puts an arrow's handle under the pointer. */
export function stewardBendFromPointer(handle: StewardEdgeHandle, point: { x: number; y: number }): number {
  const coordinate = handle.axis === "y" ? point.y : point.x;
  return Math.round((coordinate - handle.origin) / handle.gain);
}
