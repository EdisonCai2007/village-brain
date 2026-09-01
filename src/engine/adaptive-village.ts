import {
  CELL_SIZE,
  GRID_CELL_COUNT,
  GRID_HEIGHT,
  GRID_WIDTH,
  TERRAIN_LAND,
} from "./constants";
import {
  cellIndex,
  cellToWorld,
  indexToCell,
  isCellInBounds,
  pointInPolygon,
  pointSegmentDistance,
  worldToCell,
} from "./geometry";
import { createRandom } from "./random";
import {
  residentCountForHouse,
  residentPositionsForHouse,
} from "./house-residents";
import { isLandPoint } from "./terrain";
import type {
  Cell,
  House,
  Point,
  Road,
  VillageState,
  VillageWall,
  Villager,
  WallGate,
  WallSegment,
  WorldState,
} from "./types";

const MINIMUM_HOUSES = 6;
const TARGET_HOUSES = 8;
const SEARCH_RADIUS_CELLS = 27;
const HOUSE_FRONTAGE_CELLS = 4;
const HOUSE_CLEARANCE_CELLS = 2;
const HOUSE_SPACING = 62;
const NON_OWNING_ROAD_CLEARANCE = 32;
const WALL_GATE_WIDTH = 34;
const MAX_LOT_ROUTE_ATTEMPTS = 160;
const EPSILON = 0.001;

const CARDINAL_DIRECTIONS: readonly Cell[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

const PATH_DIRECTIONS: readonly Cell[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

interface LotCandidate {
  lot: Cell;
  frontage: Cell;
  score: number;
}

const distance = (first: Point, second: Point): number =>
  Math.hypot(first.x - second.x, first.y - second.y);

const pointAlong = (start: Point, end: Point, ratio: number): Point => ({
  x: start.x + (end.x - start.x) * ratio,
  y: start.y + (end.y - start.y) * ratio,
});

const isLandCell = (world: WorldState, cell: Cell): boolean =>
  isCellInBounds(cell) && world.terrain[cellIndex(cell)] === TERRAIN_LAND;

const landComponent = (world: WorldState, start: Cell): Uint8Array => {
  const included = new Uint8Array(GRID_CELL_COUNT);
  const queue = new Int32Array(GRID_CELL_COUNT);
  let head = 0;
  let tail = 0;
  const startIndex = cellIndex(start);
  queue[tail] = startIndex;
  tail += 1;
  included[startIndex] = 1;
  while (head < tail) {
    const current = indexToCell(queue[head]!);
    head += 1;
    for (const direction of PATH_DIRECTIONS) {
      const neighbor = { x: current.x + direction.x, y: current.y + direction.y };
      if (!isLandCell(world, neighbor)) continue;
      const index = cellIndex(neighbor);
      if (included[index] === 1) continue;
      included[index] = 1;
      queue[tail] = index;
      tail += 1;
    }
  }
  return included;
};

const landClearanceField = (world: WorldState): Uint16Array => {
  const clearance = new Uint16Array(GRID_CELL_COUNT);
  clearance.fill(0xffff);
  const queue = new Int32Array(GRID_CELL_COUNT);
  let head = 0;
  let tail = 0;
  for (let index = 0; index < GRID_CELL_COUNT; index += 1) {
    const cell = indexToCell(index);
    if (world.terrain[index] !== TERRAIN_LAND) {
      clearance[index] = 0;
    } else if (
      cell.x === 0 || cell.x === GRID_WIDTH - 1
      || cell.y === 0 || cell.y === GRID_HEIGHT - 1
    ) {
      clearance[index] = 0;
    } else {
      continue;
    }
    queue[tail] = index;
    tail += 1;
  }
  while (head < tail) {
    const currentIndex = queue[head]!;
    const current = indexToCell(currentIndex);
    const nextDistance = clearance[currentIndex]! + 1;
    head += 1;
    for (const direction of PATH_DIRECTIONS) {
      const neighbor = { x: current.x + direction.x, y: current.y + direction.y };
      if (!isCellInBounds(neighbor)) continue;
      const neighborIndex = cellIndex(neighbor);
      if (clearance[neighborIndex] !== 0xffff) continue;
      clearance[neighborIndex] = nextDistance;
      queue[tail] = neighborIndex;
      tail += 1;
    }
  }
  return clearance;
};

const lineOfLand = (world: WorldState, from: Cell, direction: Cell, steps: number): boolean => {
  for (let step = 0; step <= steps; step += 1) {
    if (!isLandCell(world, {
      x: from.x + direction.x * step,
      y: from.y + direction.y * step,
    })) return false;
  }
  return true;
};

const createLotCandidates = (
  world: WorldState,
  anchorCell: Cell,
  component: Uint8Array,
  clearance: Uint16Array,
  seed: number,
): LotCandidate[] => {
  const random = createRandom((seed ^ 0x7f4a7c15) >>> 0);
  const candidates: LotCandidate[] = [];
  for (
    let y = Math.max(0, anchorCell.y - SEARCH_RADIUS_CELLS);
    y <= Math.min(GRID_HEIGHT - 1, anchorCell.y + SEARCH_RADIUS_CELLS);
    y += 1
  ) {
    for (
      let x = Math.max(0, anchorCell.x - SEARCH_RADIUS_CELLS);
      x <= Math.min(GRID_WIDTH - 1, anchorCell.x + SEARCH_RADIUS_CELLS);
      x += 1
    ) {
      const lot = { x, y };
      const lotIndex = cellIndex(lot);
      if (component[lotIndex] !== 1 || clearance[lotIndex]! <= HOUSE_CLEARANCE_CELLS) {
        continue;
      }
      const anchorDistance = Math.hypot(x - anchorCell.x, y - anchorCell.y);
      if (anchorDistance < 7 || anchorDistance > SEARCH_RADIUS_CELLS) continue;
      const towardAnchor = { x: anchorCell.x - x, y: anchorCell.y - y };
      const directions = [...CARDINAL_DIRECTIONS].sort((first, second) =>
        second.x * towardAnchor.x + second.y * towardAnchor.y
        - (first.x * towardAnchor.x + first.y * towardAnchor.y));
      for (const direction of directions) {
        if (!lineOfLand(world, lot, direction, HOUSE_FRONTAGE_CELLS)) continue;
        const frontage = {
          x: lot.x + direction.x * HOUSE_FRONTAGE_CELLS,
          y: lot.y + direction.y * HOUSE_FRONTAGE_CELLS,
        };
        if (component[cellIndex(frontage)] !== 1) continue;
        const openness = Math.min(8, clearance[lotIndex]! - 1);
        candidates.push({
          lot,
          frontage,
          score: Math.abs(anchorDistance - 14) * 8 - openness * 15 + random.next() * 4,
        });
        break;
      }
    }
  }
  return candidates.sort((first, second) => first.score - second.score);
};

const distanceToRoad = (point: Point, road: Road): number => {
  let closest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < road.points.length; index += 1) {
    closest = Math.min(
      closest,
      pointSegmentDistance(point, road.points[index - 1]!, road.points[index]!),
    );
  }
  return closest;
};

const isBlockedByHouses = (
  cell: Cell,
  houses: readonly House[],
  target: Cell,
): boolean => {
  if (cell.x === target.x && cell.y === target.y) return false;
  const point = cellToWorld(cell);
  return houses.some((house) => distance(point, house.position) < NON_OWNING_ROAD_CLEARANCE);
};

const routeToNetwork = (
  world: WorldState,
  component: Uint8Array,
  networkOwner: readonly (string | null | undefined)[],
  target: Cell,
  houses: readonly House[],
): { path: Cell[]; parentId: string | null } | null => {
  const parents = new Int32Array(GRID_CELL_COUNT);
  parents.fill(-2);
  const queue = new Int32Array(GRID_CELL_COUNT);
  let head = 0;
  let tail = 0;
  for (let index = 0; index < networkOwner.length; index += 1) {
    if (networkOwner[index] === undefined) continue;
    parents[index] = -1;
    queue[tail] = index;
    tail += 1;
  }
  const targetIndex = cellIndex(target);
  while (head < tail && parents[targetIndex] === -2) {
    const currentIndex = queue[head]!;
    const current = indexToCell(currentIndex);
    head += 1;
    for (const direction of PATH_DIRECTIONS) {
      const neighbor = { x: current.x + direction.x, y: current.y + direction.y };
      if (!isCellInBounds(neighbor)) continue;
      const neighborIndex = cellIndex(neighbor);
      if (
        parents[neighborIndex] !== -2
        || component[neighborIndex] !== 1
        || isBlockedByHouses(neighbor, houses, target)
      ) continue;
      parents[neighborIndex] = currentIndex;
      queue[tail] = neighborIndex;
      tail += 1;
    }
  }
  if (parents[targetIndex] === -2) return null;
  const reversed: Cell[] = [];
  let cursor = targetIndex;
  while (parents[cursor] !== -1) {
    reversed.push(indexToCell(cursor));
    cursor = parents[cursor]!;
  }
  reversed.push(indexToCell(cursor));
  reversed.reverse();
  return { path: reversed, parentId: networkOwner[cursor] ?? null };
};

const compressPath = (path: readonly Cell[], exactStart?: Point): Point[] => {
  const points = path.map(cellToWorld);
  if (
    exactStart !== undefined
    && points.length > 0
    && distance(exactStart, points[0]!) > EPSILON
  ) points.unshift({ ...exactStart });
  if (points.length <= 2) return points;
  const compressed: Point[] = [points[0]!];
  let previousDirection = {
    x: Math.sign(points[1]!.x - points[0]!.x),
    y: Math.sign(points[1]!.y - points[0]!.y),
  };
  for (let index = 2; index < points.length; index += 1) {
    const direction = {
      x: Math.sign(points[index]!.x - points[index - 1]!.x),
      y: Math.sign(points[index]!.y - points[index - 1]!.y),
    };
    if (direction.x !== previousDirection.x || direction.y !== previousDirection.y) {
      compressed.push(points[index - 1]!);
      previousDirection = direction;
    }
  }
  compressed.push(points.at(-1)!);
  return compressed;
};

const cross = (origin: Point, first: Point, second: Point): number =>
  (first.x - origin.x) * (second.y - origin.y)
  - (first.y - origin.y) * (second.x - origin.x);

const convexHull = (points: readonly Point[]): Point[] => {
  const sorted = [...points]
    .sort((first, second) => first.x - second.x || first.y - second.y)
    .filter((point, index, values) =>
      index === 0 || point.x !== values[index - 1]!.x || point.y !== values[index - 1]!.y);
  if (sorted.length <= 2) return sorted;
  const lower: Point[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Point[] = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index]!;
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
};

const segmentIsLand = (world: WorldState, start: Point, end: Point): boolean => {
  const steps = Math.max(1, Math.ceil(distance(start, end) / (CELL_SIZE / 2)));
  for (let step = 0; step <= steps; step += 1) {
    if (!isLandPoint(world, pointAlong(start, end, step / steps))) return false;
  }
  return true;
};

const polygonIsLand = (world: WorldState, polygon: readonly Point[]): boolean =>
  polygon.every((start, index) =>
    segmentIsLand(world, start, polygon[(index + 1) % polygon.length]!));

const normalizedAngleDelta = (first: number, second: number): number =>
  Math.abs(Math.atan2(Math.sin(first - second), Math.cos(first - second)));

const createRadialEnvelope = (
  world: WorldState,
  occupied: readonly Point[],
): Point[] | null => {
  const average = {
    x: occupied.reduce((sum, point) => sum + point.x, 0) / occupied.length,
    y: occupied.reduce((sum, point) => sum + point.y, 0) / occupied.length,
  };
  const sampleCount = 32;
  for (const center of [occupied[0]!, average]) {
    const polar = occupied.map((point) => ({
      radius: distance(center, point),
      angle: Math.atan2(point.y - center.y, point.x - center.x),
    }));
    for (const clearance of [34, 26, 18, 12]) {
      const minimumRadii: number[] = [];
      const radii: number[] = [];
      for (let index = 0; index < sampleCount; index += 1) {
        const angle = index / sampleCount * Math.PI * 2;
        const support = Math.max(...polar.map((point) =>
          point.radius * Math.cos(normalizedAngleDelta(angle, point.angle))));
        minimumRadii.push(Math.max(10, support + 6));
        radii.push(Math.max(18, support + clearance));
      }
      const pointAt = (index: number): Point => {
        const angle = index / sampleCount * Math.PI * 2;
        return {
          x: center.x + Math.cos(angle) * radii[index]!,
          y: center.y + Math.sin(angle) * radii[index]!,
        };
      };
      for (let iteration = 0; iteration < 64; iteration += 1) {
        const polygon = Array.from({ length: sampleCount }, (_, index) => pointAt(index));
        if (
          occupied.every((point) => pointInPolygon(point, polygon))
          && polygonIsLand(world, polygon)
        ) return polygon;
        let changed = false;
        for (let index = 0; index < sampleCount; index += 1) {
          const previous = (index + sampleCount - 1) % sampleCount;
          const next = (index + 1) % sampleCount;
          const point = polygon[index]!;
          const touchesWater = !isLandPoint(world, point)
            || !segmentIsLand(world, polygon[previous]!, point)
            || !segmentIsLand(world, point, polygon[next]!);
          if (!touchesWater || radii[index]! <= minimumRadii[index]! + 1) continue;
          radii[index] = Math.max(minimumRadii[index]!, radii[index]! - 5);
          changed = true;
        }
        if (!changed) break;
      }
    }
  }
  return null;
};

const MOORE_DIRECTIONS: readonly Cell[] = [
  { x: -1, y: -1 },
  { x: 0, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
];

const sameCell = (first: Cell, second: Cell): boolean =>
  first.x === second.x && first.y === second.y;

const contourBoundary = (mask: Uint8Array): Cell[] | null => {
  let start: Cell | null = null;
  for (let y = 0; y < GRID_HEIGHT && start === null; y += 1) {
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      const cell = { x, y };
      if (mask[cellIndex(cell)] !== 1) continue;
      if (x === 0 || mask[cellIndex({ x: x - 1, y })] === 0) {
        start = cell;
        break;
      }
    }
  }
  if (start === null) return null;
  const boundary: Cell[] = [{ ...start }];
  let current = { ...start };
  let backtrack = { x: start.x - 1, y: start.y };
  let second: Cell | null = null;
  for (let iteration = 0; iteration < GRID_CELL_COUNT * 8; iteration += 1) {
    const relative = { x: backtrack.x - current.x, y: backtrack.y - current.y };
    const backtrackIndex = MOORE_DIRECTIONS.findIndex((direction) => sameCell(direction, relative));
    let next: Cell | null = null;
    let predecessor: Cell | null = null;
    for (let step = 1; step <= MOORE_DIRECTIONS.length; step += 1) {
      const directionIndex = (Math.max(0, backtrackIndex) + step) % MOORE_DIRECTIONS.length;
      const direction = MOORE_DIRECTIONS[directionIndex]!;
      const candidate = { x: current.x + direction.x, y: current.y + direction.y };
      if (!isCellInBounds(candidate) || mask[cellIndex(candidate)] !== 1) continue;
      const previousDirection = MOORE_DIRECTIONS[
        (directionIndex + MOORE_DIRECTIONS.length - 1) % MOORE_DIRECTIONS.length
      ]!;
      predecessor = {
        x: current.x + previousDirection.x,
        y: current.y + previousDirection.y,
      };
      next = candidate;
      break;
    }
    if (next === null || predecessor === null) return null;
    if (second === null) second = { ...next };
    else if (sameCell(current, start) && sameCell(next, second)) break;
    boundary.push(next);
    backtrack = predecessor;
    current = next;
  }
  if (boundary.length < 4 || boundary.length >= GRID_CELL_COUNT * 8) return null;
  return boundary;
};

const orthogonalizeBoundary = (world: WorldState, boundary: readonly Cell[]): Cell[] | null => {
  const result: Cell[] = [];
  for (let index = 0; index < boundary.length; index += 1) {
    const current = boundary[index]!;
    const next = boundary[(index + 1) % boundary.length]!;
    result.push(current);
    if (current.x === next.x || current.y === next.y) continue;
    const horizontal = { x: next.x, y: current.y };
    const vertical = { x: current.x, y: next.y };
    if (isLandCell(world, horizontal)) result.push(horizontal);
    else if (isLandCell(world, vertical)) result.push(vertical);
    else return null;
  }
  return result;
};

const simplifyBoundary = (cells: readonly Cell[]): Point[] => {
  const points = cells.map(cellToWorld);
  if (points.length < 3) return points;
  let changed = true;
  while (changed && points.length >= 3) {
    changed = false;
    for (let index = 0; index < points.length; index += 1) {
      const previous = points[(index + points.length - 1) % points.length]!;
      const current = points[index]!;
      const next = points[(index + 1) % points.length]!;
      if (Math.abs(cross(previous, current, next)) > EPSILON) continue;
      points.splice(index, 1);
      changed = true;
      break;
    }
  }
  return points;
};

const simplifyLandBoundary = (
  world: WorldState,
  polygon: readonly Point[],
  occupied: readonly Point[],
): Point[] => {
  const simplified = [...polygon];
  let changed = true;
  while (changed && simplified.length > 3) {
    changed = false;
    for (let index = 0; index < simplified.length; index += 1) {
      const previous = simplified[(index + simplified.length - 1) % simplified.length]!;
      const current = simplified[index]!;
      const next = simplified[(index + 1) % simplified.length]!;
      if (pointSegmentDistance(current, previous, next) > CELL_SIZE * 1.25) continue;
      if (!segmentIsLand(world, previous, next)) continue;
      const candidate = simplified.filter((_, candidateIndex) => candidateIndex !== index);
      if (!occupied.every((point) => pointInPolygon(point, candidate))) continue;
      simplified.splice(index, 1);
      changed = true;
      break;
    }
  }
  return simplified;
};

const createTerrainContourEnvelope = (
  world: WorldState,
  occupied: readonly Point[],
  support: readonly Point[],
): Point[] | null => {
  for (const radiusCells of [6, 5, 4, 3, 2]) {
    const mask = new Uint8Array(GRID_CELL_COUNT);
    const radius = radiusCells * CELL_SIZE;
    for (let index = 0; index < GRID_CELL_COUNT; index += 1) {
      if (world.terrain[index] !== TERRAIN_LAND) continue;
      const point = cellToWorld(indexToCell(index));
      if (support.some((center) => distance(point, center) <= radius)) mask[index] = 1;
    }
    const traced = contourBoundary(mask);
    if (traced === null) continue;
    const orthogonal = orthogonalizeBoundary(world, traced);
    if (orthogonal === null) continue;
    const polygon = simplifyLandBoundary(world, simplifyBoundary(orthogonal), occupied);
    if (
      polygon.length >= 3
      && occupied.every((point) => pointInPolygon(point, polygon))
      && polygonIsLand(world, polygon)
    ) return polygon;
  }
  return null;
};

const createEnvelope = (
  world: WorldState,
  occupied: readonly Point[],
  support: readonly Point[] = occupied,
): Point[] | null => {
  for (const clearance of [42, 34, 26, 18, 12]) {
    const footprint: Point[] = [];
    for (const center of occupied) {
      for (let index = 0; index < 12; index += 1) {
        const angle = index / 12 * Math.PI * 2;
        footprint.push({
          x: center.x + Math.cos(angle) * clearance,
          y: center.y + Math.sin(angle) * clearance,
        });
      }
    }
    const polygon = convexHull(footprint);
    if (
      polygon.length >= 3
      && occupied.every((point) => pointInPolygon(point, polygon))
      && polygonIsLand(world, polygon)
    ) return polygon;
  }
  return createRadialEnvelope(world, occupied)
    ?? createTerrainContourEnvelope(world, occupied, support);
};

const findEntranceRoute = (
  world: WorldState,
  anchor: Point,
  anchorCell: Cell,
  component: Uint8Array,
  polygon: readonly Point[],
  houses: readonly House[],
): Cell[] | null => {
  const parents = new Int32Array(GRID_CELL_COUNT);
  parents.fill(-2);
  const queue = new Int32Array(GRID_CELL_COUNT);
  let head = 0;
  let tail = 0;
  const startIndex = cellIndex(anchorCell);
  parents[startIndex] = -1;
  queue[tail] = startIndex;
  tail += 1;
  let targetIndex = -1;
  while (head < tail) {
    const currentIndex = queue[head]!;
    const current = indexToCell(currentIndex);
    head += 1;
    const currentPoint = cellToWorld(current);
    if (
      !pointInPolygon(currentPoint, polygon)
      && distance(currentPoint, anchor) >= 90
      && !isBlockedByHouses(current, houses, current)
    ) {
      targetIndex = currentIndex;
      break;
    }
    for (const direction of PATH_DIRECTIONS) {
      const neighbor = { x: current.x + direction.x, y: current.y + direction.y };
      if (!isCellInBounds(neighbor)) continue;
      const neighborIndex = cellIndex(neighbor);
      if (
        parents[neighborIndex] !== -2
        || component[neighborIndex] !== 1
        || isBlockedByHouses(neighbor, houses, anchorCell)
      ) continue;
      parents[neighborIndex] = currentIndex;
      queue[tail] = neighborIndex;
      tail += 1;
    }
  }
  if (targetIndex < 0) return null;
  const reversed: Cell[] = [];
  for (let cursor = targetIndex; cursor !== -1; cursor = parents[cursor]!) {
    reversed.push(indexToCell(cursor));
  }
  return reversed.reverse();
};

interface SegmentHit {
  point: Point;
  ratio: number;
}

const segmentHit = (
  firstStart: Point,
  firstEnd: Point,
  secondStart: Point,
  secondEnd: Point,
): SegmentHit | null => {
  const firstX = firstEnd.x - firstStart.x;
  const firstY = firstEnd.y - firstStart.y;
  const secondX = secondEnd.x - secondStart.x;
  const secondY = secondEnd.y - secondStart.y;
  const denominator = firstX * secondY - firstY * secondX;
  if (Math.abs(denominator) < 1e-9) return null;
  const offsetX = secondStart.x - firstStart.x;
  const offsetY = secondStart.y - firstStart.y;
  const ratio = (offsetX * secondY - offsetY * secondX) / denominator;
  const otherRatio = (offsetX * firstY - offsetY * firstX) / denominator;
  if (ratio < 0 || ratio > 1 || otherRatio < 0 || otherRatio > 1) return null;
  return { point: pointAlong(firstStart, firstEnd, ratio), ratio };
};

const wallRoadIntersections = (polygon: readonly Point[], roads: readonly Road[]): WallGate[] => {
  const gates: WallGate[] = [];
  for (let edgeIndex = 0; edgeIndex < polygon.length; edgeIndex += 1) {
    const start = polygon[edgeIndex]!;
    const end = polygon[(edgeIndex + 1) % polygon.length]!;
    for (const road of roads) {
      for (let pointIndex = 1; pointIndex < road.points.length; pointIndex += 1) {
        const hit = segmentHit(start, end, road.points[pointIndex - 1]!, road.points[pointIndex]!);
        if (hit === null) continue;
        if (gates.some((gate) => gate.roadId === road.id && distance(gate.point, hit.point) < 2)) {
          continue;
        }
        gates.push({
          id: `gate-${gates.length + 1}`,
          roadId: road.id,
          point: hit.point,
          edgeIndex,
          width: WALL_GATE_WIDTH,
        });
      }
    }
  }
  return gates;
};

const createWall = (polygon: Point[], roads: readonly Road[]): VillageWall => {
  const gates = wallRoadIntersections(polygon, roads);
  const gatesByEdge = new Map<number, WallGate[]>();
  for (const gate of gates) {
    const values = gatesByEdge.get(gate.edgeIndex) ?? [];
    values.push(gate);
    gatesByEdge.set(gate.edgeIndex, values);
  }
  const segments: WallSegment[] = [];
  for (let edgeIndex = 0; edgeIndex < polygon.length; edgeIndex += 1) {
    const start = polygon[edgeIndex]!;
    const end = polygon[(edgeIndex + 1) % polygon.length]!;
    const edgeLength = distance(start, end);
    const edgeGates = (gatesByEdge.get(edgeIndex) ?? [])
      .map((gate) => ({ ratio: distance(start, gate.point) / edgeLength, gate }))
      .sort((first, second) => first.ratio - second.ratio);
    let cursor = 0;
    for (const { ratio, gate } of edgeGates) {
      const halfGap = gate.width / 2 / edgeLength;
      const gapStart = Math.max(cursor, ratio - halfGap);
      if (gapStart - cursor > EPSILON) {
        segments.push({ start: pointAlong(start, end, cursor), end: pointAlong(start, end, gapStart) });
      }
      cursor = Math.min(1, ratio + halfGap);
    }
    if (1 - cursor > EPSILON) {
      segments.push({ start: pointAlong(start, end, cursor), end: { ...end } });
    }
  }
  return { polygon, gates, segments };
};

const createVillagers = (
  world: WorldState,
  houses: readonly House[],
  seed: number,
): Villager[] | null => {
  const villagers: Villager[] = [];
  for (const house of houses) {
    const residentCount = residentCountForHouse(seed, house.id);
    for (const position of residentPositionsForHouse(house, residentCount)) {
      if (!isLandPoint(world, position)) return null;
      villagers.push({ id: `villager-${villagers.length + 1}`, houseId: house.id, position });
    }
  }
  return villagers;
};

export type TerrainFirstFailure =
  | "invalid_anchor"
  | "not_enough_reachable_lots"
  | "wall_cannot_follow_terrain"
  | "no_land_entrance"
  | "no_wall_gate"
  | "resident_clearance";

export interface TerrainFirstAttempt {
  village: VillageState | null;
  failure: TerrainFirstFailure | null;
}

export const createTerrainFirstVillageAttempt = (
  world: WorldState,
  anchor: Point,
  seed: number,
): TerrainFirstAttempt => {
  const anchorCell = worldToCell(anchor);
  if (anchorCell === null || !isLandCell(world, anchorCell)) {
    return { village: null, failure: "invalid_anchor" };
  }
  const component = landComponent(world, anchorCell);
  const clearance = landClearanceField(world);
  const candidates = createLotCandidates(world, anchorCell, component, clearance, seed);
  const roads: Road[] = [];
  const houses: House[] = [];
  const networkOwner: Array<string | null | undefined> = Array(GRID_CELL_COUNT);
  networkOwner[cellIndex(anchorCell)] = null;

  let routeAttempts = 0;
  for (const lot of candidates) {
    if (houses.length >= TARGET_HOUSES) break;
    const lotPoint = cellToWorld(lot.lot);
    if (houses.some((house) => distance(house.position, lotPoint) < HOUSE_SPACING)) continue;
    if (roads.some((road) => distanceToRoad(lotPoint, road) < NON_OWNING_ROAD_CLEARANCE)) continue;
    routeAttempts += 1;
    if (routeAttempts > MAX_LOT_ROUTE_ATTEMPTS) break;
    const routed = routeToNetwork(world, component, networkOwner, lot.frontage, houses);
    if (routed === null || routed.path.length < 2) continue;
    const roadId = roads.length === 0 ? "spine" : `branch-${roads.length}`;
    const road: Road = {
      id: roadId,
      role: roads.length === 0 ? "spine" : "branch",
      parentId: roads.length === 0 ? null : routed.parentId ?? "spine",
      points: compressPath(routed.path, roads.length === 0 ? anchor : undefined),
    };
    const frontage = cellToWorld(lot.frontage);
    const house: House = {
      id: `house-${houses.length + 1}`,
      roadId,
      position: lotPoint,
      frontage,
      facing: Math.atan2(frontage.y - lotPoint.y, frontage.x - lotPoint.x),
    };
    roads.push(road);
    houses.push(house);
    for (const cell of routed.path) {
      const index = cellIndex(cell);
      if (networkOwner[index] === undefined) networkOwner[index] = roadId;
    }
  }

  if (houses.length < MINIMUM_HOUSES) {
    return { village: null, failure: "not_enough_reachable_lots" };
  }
  let occupied = [anchor, ...houses.map((house) => house.position)];
  let polygon = createEnvelope(world, occupied, [
    ...occupied,
    ...roads.flatMap((road) => road.points),
  ]);
  while (polygon === null && houses.length > MINIMUM_HOUSES) {
    houses.pop();
    roads.pop();
    occupied = [anchor, ...houses.map((house) => house.position)];
    polygon = createEnvelope(world, occupied, [
      ...occupied,
      ...roads.flatMap((road) => road.points),
    ]);
  }
  if (polygon === null) return { village: null, failure: "wall_cannot_follow_terrain" };
  const entrancePath = findEntranceRoute(
    world,
    anchor,
    anchorCell,
    component,
    polygon,
    houses,
  );
  if (entrancePath === null || entrancePath.length < 2) {
    return { village: null, failure: "no_land_entrance" };
  }
  roads.push({
    id: "entrance",
    role: "entrance",
    parentId: "spine",
    points: compressPath(entrancePath, anchor),
  });
  const wall = createWall(polygon, roads);
  if (wall.gates.length === 0) return { village: null, failure: "no_wall_gate" };
  const villagers = createVillagers(world, houses, seed);
  if (villagers === null) return { village: null, failure: "resident_clearance" };
  return {
    village: {
      seed: seed >>> 0,
      anchor: { ...anchor },
      roads,
      houses,
      bridges: [],
      wall,
      villagers,
    },
    failure: null,
  };
};
