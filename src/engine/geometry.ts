import {
  CELL_SIZE,
  GRID_HEIGHT,
  GRID_WIDTH,
  MAX_INTERPOLATED_POINTS,
  MAX_SEARCH_CELLS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from "./constants";
import type { Cell, Point } from "./types";

const EPSILON = 1e-9;
const NEIGHBOR_OFFSETS: readonly Cell[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

export const isCellInBounds = (cell: Cell): boolean =>
  Number.isInteger(cell.x)
  && Number.isInteger(cell.y)
  && cell.x >= 0
  && cell.x < GRID_WIDTH
  && cell.y >= 0
  && cell.y < GRID_HEIGHT;

export const cellIndex = (cell: Cell): number => {
  if (!isCellInBounds(cell)) throw new RangeError("cell is outside the terrain grid");
  return cell.y * GRID_WIDTH + cell.x;
};

export const indexToCell = (index: number): Cell => {
  if (!Number.isInteger(index) || index < 0 || index >= GRID_WIDTH * GRID_HEIGHT) {
    throw new RangeError("index is outside the terrain grid");
  }
  return { x: index % GRID_WIDTH, y: Math.floor(index / GRID_WIDTH) };
};

export const worldToCell = (point: Point): Cell | null => {
  if (
    !Number.isFinite(point.x)
    || !Number.isFinite(point.y)
    || point.x < 0
    || point.x >= WORLD_WIDTH
    || point.y < 0
    || point.y >= WORLD_HEIGHT
  ) {
    return null;
  }
  return {
    x: Math.floor(point.x / CELL_SIZE),
    y: Math.floor(point.y / CELL_SIZE),
  };
};

export const cellToWorld = (cell: Cell): Point => {
  if (!isCellInBounds(cell)) throw new RangeError("cell is outside the terrain grid");
  return {
    x: cell.x * CELL_SIZE + CELL_SIZE / 2,
    y: cell.y * CELL_SIZE + CELL_SIZE / 2,
  };
};

export const fourWayNeighbors = (cell: Cell): Cell[] => {
  const neighbors: Cell[] = [];
  for (const offset of NEIGHBOR_OFFSETS) {
    const neighbor = { x: cell.x + offset.x, y: cell.y + offset.y };
    if (isCellInBounds(neighbor)) neighbors.push(neighbor);
  }
  return neighbors;
};

export const interpolateSegment = (
  from: Point,
  to: Point,
  maxSpacing: number,
): Point[] => {
  if (
    !Number.isFinite(from.x)
    || !Number.isFinite(from.y)
    || !Number.isFinite(to.x)
    || !Number.isFinite(to.y)
    || !Number.isFinite(maxSpacing)
    || maxSpacing <= 0
  ) {
    throw new RangeError("segment coordinates and spacing must be finite and spacing positive");
  }
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const segmentCount = Math.max(1, Math.ceil(distance / maxSpacing));
  if (segmentCount + 1 > MAX_INTERPOLATED_POINTS) {
    throw new RangeError("interpolated segment exceeds the point limit");
  }
  if (distance === 0) return [{ ...from }];

  const points: Point[] = [];
  for (let index = 0; index <= segmentCount; index += 1) {
    const ratio = index / segmentCount;
    points.push({
      x: from.x + (to.x - from.x) * ratio,
      y: from.y + (to.y - from.y) * ratio,
    });
  }
  return points;
};

export const boundedFloodFill = (
  start: Cell,
  canVisit: (cell: Cell) => boolean,
  maxCells: number,
): number[] => {
  if (!isCellInBounds(start) || !Number.isFinite(maxCells) || maxCells <= 0) return [];
  const limit = Math.min(Math.floor(maxCells), MAX_SEARCH_CELLS);
  if (!canVisit(start)) return [];

  const visited = new Uint8Array(GRID_WIDTH * GRID_HEIGHT);
  const queue = new Int32Array(limit);
  const result: number[] = [];
  const startIndex = cellIndex(start);
  let head = 0;
  let tail = 0;
  queue[tail] = startIndex;
  tail += 1;
  visited[startIndex] = 1;

  while (head < tail && result.length < limit) {
    const currentIndex = queue[head]!;
    head += 1;
    result.push(currentIndex);
    const current = indexToCell(currentIndex);
    for (const neighbor of fourWayNeighbors(current)) {
      const neighborIndex = cellIndex(neighbor);
      if (visited[neighborIndex] === 1 || !canVisit(neighbor)) continue;
      visited[neighborIndex] = 1;
      if (tail < limit) {
        queue[tail] = neighborIndex;
        tail += 1;
      }
    }
  }
  return result;
};

export const pointSegmentDistance = (point: Point, from: Point, to: Point): number => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - from.x, point.y - from.y);
  const projection = Math.max(0, Math.min(1,
    ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared,
  ));
  return Math.hypot(
    point.x - (from.x + projection * dx),
    point.y - (from.y + projection * dy),
  );
};

const cross = (a: Point, b: Point, c: Point): number =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

const pointOnSegment = (point: Point, from: Point, to: Point): boolean =>
  Math.abs(cross(from, to, point)) <= EPSILON
  && point.x >= Math.min(from.x, to.x) - EPSILON
  && point.x <= Math.max(from.x, to.x) + EPSILON
  && point.y >= Math.min(from.y, to.y) - EPSILON
  && point.y <= Math.max(from.y, to.y) + EPSILON;

export const pointInPolygon = (point: Point, polygon: readonly Point[]): boolean => {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let index = 0; index < polygon.length; index += 1) {
    const from = polygon[index]!;
    const to = polygon[(index + 1) % polygon.length]!;
    if (pointOnSegment(point, from, to)) return true;
    const crossesRay = (from.y > point.y) !== (to.y > point.y)
      && point.x < ((to.x - from.x) * (point.y - from.y)) / (to.y - from.y) + from.x;
    if (crossesRay) inside = !inside;
  }
  return inside;
};

export const segmentsIntersect = (
  firstStart: Point,
  firstEnd: Point,
  secondStart: Point,
  secondEnd: Point,
): boolean => {
  const firstSideStart = cross(firstStart, firstEnd, secondStart);
  const firstSideEnd = cross(firstStart, firstEnd, secondEnd);
  const secondSideStart = cross(secondStart, secondEnd, firstStart);
  const secondSideEnd = cross(secondStart, secondEnd, firstEnd);

  if (
    ((firstSideStart > EPSILON && firstSideEnd < -EPSILON)
      || (firstSideStart < -EPSILON && firstSideEnd > EPSILON))
    && ((secondSideStart > EPSILON && secondSideEnd < -EPSILON)
      || (secondSideStart < -EPSILON && secondSideEnd > EPSILON))
  ) {
    return true;
  }
  return pointOnSegment(secondStart, firstStart, firstEnd)
    || pointOnSegment(secondEnd, firstStart, firstEnd)
    || pointOnSegment(firstStart, secondStart, secondEnd)
    || pointOnSegment(firstEnd, secondStart, secondEnd);
};
