import {
  CELL_SIZE,
  MAX_RIVER_WIDTH_CELLS,
  MAX_SEARCH_CELLS,
  TERRAIN_LAND,
  TERRAIN_WATER,
} from "./constants";
import {
  cellIndex,
  cellToWorld,
  isCellInBounds,
  pointInPolygon,
  pointSegmentDistance,
  segmentsIntersect,
  worldToCell,
} from "./geometry";
import { replaceBridgeCells } from "./navigation";
import { createRandom } from "./random";
import {
  MAX_RESIDENTS_PER_HOUSE,
  MIN_RESIDENTS_PER_HOUSE,
  residentCountForHouse,
  residentPositionsForHouse,
} from "./house-residents";
import { hasLandClearance, isLandPoint } from "./terrain";
import { createTerrainFirstVillageAttempt } from "./adaptive-village";
import type {
  Bridge,
  Cell,
  CommandResult,
  House,
  Point,
  Road,
  SeededRandom,
  VillageState,
  VillageWall,
  Villager,
  WallGate,
  WallSegment,
  WorldState,
} from "./types";

const GENERATION_ATTEMPTS = 16;
const ANCHOR_CLEARANCE = 85;
const HOUSE_FRONTAGE_DISTANCE = 42;
const HOUSE_MINIMUM_SPACING = 42;
const HOUSE_ROAD_CLEARANCE = 30;
const WALL_CLEARANCE = 50;
const WALL_GATE_WIDTH = 34;
const EPSILON = 0.001;
const MAX_GEOMETRY_WORK = 4_096;

interface GeometryBudget {
  remaining: number;
  exhausted: boolean;
  roadCells: WeakMap<Road, Cell[]>;
}

const createGeometryBudget = (): GeometryBudget => ({
  remaining: MAX_GEOMETRY_WORK,
  exhausted: false,
  roadCells: new WeakMap<Road, Cell[]>(),
});

const consumeGeometryWork = (budget: GeometryBudget, amount = 1): boolean => {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > budget.remaining) {
    budget.remaining = 0;
    budget.exhausted = true;
    return false;
  }
  budget.remaining -= amount;
  return true;
};

interface Basis {
  along: Point;
  north: Point;
}

interface Crossing {
  roadId: string;
  start: Point;
  end: Point;
  center: Point;
  angle: number;
  length: number;
  cells: Cell[];
}

interface SegmentHit {
  point: Point;
  ratio: number;
}

const distance = (first: Point, second: Point): number =>
  Math.hypot(first.x - second.x, first.y - second.y);

const addBasis = (
  anchor: Point,
  basis: Basis,
  along: number,
  north: number,
): Point => ({
  x: anchor.x + basis.along.x * along + basis.north.x * north,
  y: anchor.y + basis.along.y * along + basis.north.y * north,
});

const pointAlong = (start: Point, end: Point, ratio: number): Point => ({
  x: start.x + (end.x - start.x) * ratio,
  y: start.y + (end.y - start.y) * ratio,
});

const walkSegmentCells = (
  from: Point,
  to: Point,
  visit: (cell: Cell) => boolean,
): boolean => {
  const start = worldToCell(from);
  const destination = worldToCell(to);
  if (start === null || destination === null) return false;
  let currentX = start.x;
  let currentY = start.y;
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  const stepX = Math.sign(deltaX);
  const stepY = Math.sign(deltaY);
  const startsOnVerticalBoundary = Number.isInteger(from.x / CELL_SIZE);
  const startsOnHorizontalBoundary = Number.isInteger(from.y / CELL_SIZE);
  const followsVerticalBoundary = stepX === 0 && Number.isInteger(from.x / CELL_SIZE);
  const followsHorizontalBoundary = stepY === 0 && Number.isInteger(from.y / CELL_SIZE);
  const emit = (cell: Cell): boolean => {
    const emitIfInBounds = (candidate: Cell): boolean =>
      !isCellInBounds(candidate) || visit(candidate);
    if (!emitIfInBounds(cell)) return false;
    if (followsVerticalBoundary
      && !emitIfInBounds({ x: cell.x - 1, y: cell.y })) return false;
    if (followsHorizontalBoundary
      && !emitIfInBounds({ x: cell.x, y: cell.y - 1 })) return false;
    if (followsVerticalBoundary && followsHorizontalBoundary
      && !emitIfInBounds({ x: cell.x - 1, y: cell.y - 1 })) return false;
    return true;
  };
  if (!emit({ x: currentX, y: currentY })) return false;
  if (startsOnVerticalBoundary && !followsVerticalBoundary
    && !emit({ x: currentX - 1, y: currentY })) return false;
  if (startsOnHorizontalBoundary && !followsHorizontalBoundary
    && !emit({ x: currentX, y: currentY - 1 })) return false;
  if (startsOnVerticalBoundary && startsOnHorizontalBoundary
    && !followsVerticalBoundary && !followsHorizontalBoundary
    && !emit({ x: currentX - 1, y: currentY - 1 })) return false;
  const tDeltaX = stepX === 0 ? Number.POSITIVE_INFINITY : CELL_SIZE / Math.abs(deltaX);
  const tDeltaY = stepY === 0 ? Number.POSITIVE_INFINITY : CELL_SIZE / Math.abs(deltaY);
  const nextBoundaryX = stepX > 0 ? (currentX + 1) * CELL_SIZE : currentX * CELL_SIZE;
  const nextBoundaryY = stepY > 0 ? (currentY + 1) * CELL_SIZE : currentY * CELL_SIZE;
  let tMaxX = stepX === 0
    ? Number.POSITIVE_INFINITY
    : (nextBoundaryX - from.x) / deltaX;
  let tMaxY = stepY === 0
    ? Number.POSITIVE_INFINITY
    : (nextBoundaryY - from.y) / deltaY;
  while (true) {
    const nextBoundary = Math.min(tMaxX, tMaxY);
    if (nextBoundary > 1 + 1e-12) break;
    const emitTransition = nextBoundary > 1e-12;
    if (Math.abs(tMaxX - tMaxY) <= 1e-12) {
      const sideX = { x: currentX + stepX, y: currentY };
      const sideY = { x: currentX, y: currentY + stepY };
      const diagonal = { x: currentX + stepX, y: currentY + stepY };
      if (emitTransition && (!emit(sideX) || !emit(sideY) || !emit(diagonal))) return false;
      currentX = diagonal.x;
      currentY = diagonal.y;
      tMaxX += tDeltaX;
      tMaxY += tDeltaY;
    } else if (tMaxX < tMaxY) {
      currentX += stepX;
      if (emitTransition && !emit({ x: currentX, y: currentY })) return false;
      tMaxX += tDeltaX;
    } else {
      currentY += stepY;
      if (emitTransition && !emit({ x: currentX, y: currentY })) return false;
      tMaxY += tDeltaY;
    }
  }
  return true;
};

const boundedSegmentCells = (
  from: Point,
  to: Point,
  budget: GeometryBudget,
): Cell[] | null => {
  let count = 0;
  const counted = walkSegmentCells(from, to, () => {
    count += 1;
    return consumeGeometryWork(budget);
  });
  if (!counted || !consumeGeometryWork(budget, count)) return null;
  const cells: Cell[] = [];
  if (!walkSegmentCells(from, to, (cell) => {
    cells.push(cell);
    return true;
  })) return null;
  return cells;
};

export const traceSegmentCells = (from: Point, to: Point): Cell[] => {
  const cells: Cell[] = [];
  if (!walkSegmentCells(from, to, (cell) => {
    cells.push(cell);
    return cells.length <= MAX_GEOMETRY_WORK;
  })) return [];
  return cells;
};

const distanceToRoad = (
  point: Point,
  road: Road,
  budget?: GeometryBudget,
): number => {
  let closest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < road.points.length; index += 1) {
    if (budget !== undefined && !consumeGeometryWork(budget)) return closest;
    closest = Math.min(
      closest,
      pointSegmentDistance(point, road.points[index - 1]!, road.points[index]!),
    );
  }
  return closest;
};

const uniqueCells = (cells: readonly Cell[]): Cell[] => {
  const seen = new Set<number>();
  const result: Cell[] = [];
  for (const cell of cells) {
    const index = cellIndex(cell);
    if (seen.has(index)) continue;
    seen.add(index);
    result.push(cell);
  }
  return result;
};

const scanToLand = (
  world: WorldState,
  cell: Cell,
  deltaX: number,
  deltaY: number,
  budget: GeometryBudget,
): number | null => {
  for (let step = 1; step <= MAX_RIVER_WIDTH_CELLS; step += 1) {
    if (!consumeGeometryWork(budget)) return null;
    const candidate = { x: cell.x + deltaX * step, y: cell.y + deltaY * step };
    if (!isCellInBounds(candidate)) return null;
    if (world.terrain[cellIndex(candidate)] === TERRAIN_LAND) return step;
  }
  return null;
};

const isRiverLikeCell = (
  world: WorldState,
  cell: Cell,
  budget: GeometryBudget,
): boolean => {
  if (!consumeGeometryWork(budget)) return false;
  if (world.terrain[cellIndex(cell)] !== TERRAIN_WATER) return false;
  const north = scanToLand(world, cell, 0, -1, budget);
  const south = scanToLand(world, cell, 0, 1, budget);
  const west = scanToLand(world, cell, -1, 0, budget);
  const east = scanToLand(world, cell, 1, 0, budget);
  return (north !== null && south !== null
      && north + south - 1 <= MAX_RIVER_WIDTH_CELLS)
    || (west !== null && east !== null
      && west + east - 1 <= MAX_RIVER_WIDTH_CELLS);
};

const crossesOppositeBanks = (
  world: WorldState,
  cells: readonly Cell[],
  before: Point,
  after: Point,
  budget: GeometryBudget,
): boolean => {
  const beforeCell = worldToCell(before);
  const afterCell = worldToCell(after);
  const middle = cells[Math.floor(cells.length / 2)];
  if (beforeCell === null || afterCell === null || middle === undefined) return false;
  const north = scanToLand(world, middle, 0, -1, budget);
  const south = scanToLand(world, middle, 0, 1, budget);
  const west = scanToLand(world, middle, -1, 0, budget);
  const east = scanToLand(world, middle, 1, 0, budget);
  const verticallyBounded = north !== null && south !== null
    && north + south - 1 <= MAX_RIVER_WIDTH_CELLS;
  const horizontallyBounded = west !== null && east !== null
    && west + east - 1 <= MAX_RIVER_WIDTH_CELLS;
  const roadIsMoreVertical = Math.abs(afterCell.y - beforeCell.y)
    >= Math.abs(afterCell.x - beforeCell.x);
  if (verticallyBounded && (!horizontallyBounded || roadIsMoreVertical)) {
    return (beforeCell.y - middle.y) * (afterCell.y - middle.y) < 0;
  }
  if (horizontallyBounded) {
    return (beforeCell.x - middle.x) * (afterCell.x - middle.x) < 0;
  }
  return false;
};

const roadCells = (road: Road, budget: GeometryBudget): Cell[] | null => {
  const cached = budget.roadCells.get(road);
  if (cached !== undefined) return cached;
  let count = 0;
  let previousX: number | undefined;
  let previousY: number | undefined;
  for (let index = 1; index < road.points.length; index += 1) {
    if (!walkSegmentCells(
      road.points[index - 1]!,
      road.points[index]!,
      (cell) => {
        if (!consumeGeometryWork(budget)) return false;
        if (previousX !== cell.x || previousY !== cell.y) count += 1;
        previousX = cell.x;
        previousY = cell.y;
        return true;
      },
    )) return null;
  }
  if (!consumeGeometryWork(budget, count)) return null;
  const cells: Cell[] = [];
  for (let index = 1; index < road.points.length; index += 1) {
    if (!walkSegmentCells(
      road.points[index - 1]!,
      road.points[index]!,
      (cell) => {
        const previous = cells.at(-1);
        if (previous?.x !== cell.x || previous.y !== cell.y) cells.push(cell);
        return true;
      },
    )) return null;
  }
  budget.roadCells.set(road, cells);
  return cells;
};

const detectSupportedCrossings = (
  world: WorldState,
  roads: readonly Road[],
  budget: GeometryBudget,
): Crossing[] | null => {
  const crossings: Crossing[] = [];

  for (const road of roads) {
    const traversed = roadCells(road, budget);
    if (traversed === null) return null;
    let waterStart = -1;
    for (let index = 0; index <= traversed.length; index += 1) {
      if (!consumeGeometryWork(budget)) return null;
      const cell = traversed[index];
      const inWater = cell !== undefined && world.terrain[cellIndex(cell)] === TERRAIN_WATER;
      if (inWater && waterStart === -1) waterStart = index;
      if (inWater || waterStart === -1) continue;

      const waterEnd = index - 1;
      const beforeCell = traversed[waterStart - 1];
      const afterCell = traversed[index];
      const waterSampleCount = waterEnd - waterStart + 1;
      if (!consumeGeometryWork(budget, waterSampleCount)) return null;
      const cells = uniqueCells(traversed.slice(waterStart, waterEnd + 1));
      const before = beforeCell === undefined ? undefined : cellToWorld(beforeCell);
      const after = afterCell === undefined ? undefined : cellToWorld(afterCell);
      const supported = beforeCell !== undefined
        && afterCell !== undefined
        && world.terrain[cellIndex(beforeCell)] === TERRAIN_LAND
        && world.terrain[cellIndex(afterCell)] === TERRAIN_LAND
        && cells.length > 0
        && cells.length <= MAX_RIVER_WIDTH_CELLS
        && cells.every((waterCell) => isRiverLikeCell(world, waterCell, budget))
        && crossesOppositeBanks(world, cells, before!, after!, budget);
      if (supported) {
        const center = cellToWorld(cells[Math.floor(cells.length / 2)]!);
        crossings.push({
          roadId: road.id,
          start: before!,
          end: after!,
          center,
          angle: Math.atan2(after!.y - before!.y, after!.x - before!.x),
          length: distance(before!, after!),
          cells,
        });
      }
      waterStart = -1;
    }
  }
  return crossings;
};

const allRoadWaterIsBridged = (
  world: WorldState,
  roads: readonly Road[],
  crossings: readonly Crossing[],
  budget: GeometryBudget,
): string[] | null => {
  const bridgedByRoad = new Map<string, Set<number>>();
  for (const crossing of crossings) {
    if (!consumeGeometryWork(budget, crossing.cells.length + 1)) return null;
    const cells = bridgedByRoad.get(crossing.roadId) ?? new Set<number>();
    for (const cell of crossing.cells) cells.add(cellIndex(cell));
    bridgedByRoad.set(crossing.roadId, cells);
  }
  const unsupported = new Set<string>();
  for (const road of roads) {
    const traversed = roadCells(road, budget);
    if (traversed === null) return null;
    const bridged = bridgedByRoad.get(road.id) ?? new Set<number>();
    for (const cell of traversed) {
      if (!consumeGeometryWork(budget)) return null;
      const index = cellIndex(cell);
      if (world.terrain[index] === TERRAIN_WATER && !bridged.has(index)) {
        unsupported.add(road.id);
      }
    }
  }
  const result = [...unsupported];
  return result;
};

const createRoads = (
  anchor: Point,
  basis: Basis,
  scale: number,
  random: SeededRandom,
): Road[] => {
  const halfSpine = (145 + random.next() * 12) * scale;
  const branchAttach = 68 * scale;
  const branchLength = (128 + random.next() * 12) * scale;
  const branchSpread = (30 + random.next() * 10) * scale;
  const entranceLength = (315 + random.next() * 18) * scale;
  const entranceLean = (random.next() - 0.5) * 22 * scale;
  const spine: Road = {
    id: "spine",
    role: "spine",
    parentId: null,
    points: [
      addBasis(anchor, basis, -halfSpine, 0),
      { ...anchor },
      addBasis(anchor, basis, halfSpine, 0),
    ],
  };
  return [
    spine,
    {
      id: "entrance",
      role: "entrance",
      parentId: "spine",
      points: [
        { ...anchor },
        addBasis(anchor, basis, entranceLean * 0.35, entranceLength * 0.52),
        addBasis(anchor, basis, entranceLean, entranceLength),
      ],
    },
    {
      id: "branch-west",
      role: "branch",
      parentId: "spine",
      points: [
        addBasis(anchor, basis, -branchAttach, 0),
        addBasis(anchor, basis, -branchAttach - branchSpread * 0.5, -branchLength * 0.52),
        addBasis(anchor, basis, -branchAttach - branchSpread, -branchLength),
      ],
    },
    {
      id: "branch-east",
      role: "branch",
      parentId: "spine",
      points: [
        addBasis(anchor, basis, branchAttach, 0),
        addBasis(anchor, basis, branchAttach + branchSpread * 0.5, -branchLength * 0.52),
        addBasis(anchor, basis, branchAttach + branchSpread, -branchLength),
      ],
    },
  ];
};

const houseCandidate = (
  road: Road,
  segmentIndex: number,
  ratio: number,
  side: number,
): Omit<House, "id"> => {
  const start = road.points[segmentIndex - 1]!;
  const end = road.points[segmentIndex]!;
  const frontage = pointAlong(start, end, ratio);
  const heading = Math.atan2(end.y - start.y, end.x - start.x);
  const normal = heading + side * Math.PI / 2;
  const position = {
    x: frontage.x + Math.cos(normal) * HOUSE_FRONTAGE_DISTANCE,
    y: frontage.y + Math.sin(normal) * HOUSE_FRONTAGE_DISTANCE,
  };
  return {
    roadId: road.id,
    position,
    frontage,
    facing: Math.atan2(frontage.y - position.y, frontage.x - position.x),
  };
};

const placeHouses = (
  world: WorldState,
  anchor: Point,
  roads: readonly Road[],
  random: SeededRandom,
  budget: GeometryBudget,
): House[] => {
  const houses: House[] = [];
  const orderedRoads = [
    ...roads.filter((road) => road.role === "branch"),
    ...roads.filter((road) => road.role === "spine"),
  ];
  for (const road of orderedRoads) {
    const target = road.role === "spine" ? 4 : 2;
    const sideFirst = random.next() < 0.5 ? -1 : 1;
    for (let segmentIndex = 1; segmentIndex < road.points.length; segmentIndex += 1) {
      for (const ratio of [0.3, 0.56, 0.78]) {
        for (const side of [sideFirst, -sideFirst]) {
          if (!consumeGeometryWork(budget)) return houses;
          if (houses.filter((house) => house.roadId === road.id).length >= target) {
            break;
          }
          const candidate = houseCandidate(road, segmentIndex, ratio, side);
          if (!isLandPoint(world, candidate.position)) continue;
          if (distance(candidate.position, anchor) < 62) continue;
          if (roads.some((other) =>
            other.id !== road.id
            && distanceToRoad(candidate.position, other, budget) < HOUSE_ROAD_CLEARANCE)) continue;
          if (houses.some((other) =>
            distance(candidate.position, other.position) < HOUSE_MINIMUM_SPACING)) continue;
          houses.push({ ...candidate, id: `house-${houses.length + 1}` });
        }
      }
    }
  }
  return houses;
};

const growthRoad = (
  id: string,
  parentPoint: Point,
  basis: Basis,
  direction: -1 | 1,
  scale: number,
): Road => ({
  id,
  role: "branch",
  parentId: "spine",
  points: [
    { ...parentPoint },
    {
      x: parentPoint.x + basis.along.x * direction * 50 * scale,
      y: parentPoint.y + basis.along.y * direction * 50 * scale,
    },
    {
      x: parentPoint.x + basis.along.x * direction * 100 * scale,
      y: parentPoint.y + basis.along.y * direction * 100 * scale,
    },
  ],
});

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

const wallRoadIntersections = (
  polygon: readonly Point[],
  roads: readonly Road[],
  budget: GeometryBudget,
): WallGate[] => {
  const gates: WallGate[] = [];
  for (let edgeIndex = 0; edgeIndex < polygon.length; edgeIndex += 1) {
    const start = polygon[edgeIndex]!;
    const end = polygon[(edgeIndex + 1) % polygon.length]!;
    for (const road of roads) {
      if (!consumeGeometryWork(budget, Math.max(1, road.points.length - 1))) return [];
      for (let pointIndex = 1; pointIndex < road.points.length; pointIndex += 1) {
        const hit = segmentHit(start, end, road.points[pointIndex - 1]!, road.points[pointIndex]!);
        if (hit === null) continue;
        let duplicate = false;
        for (const gate of gates) {
          if (!consumeGeometryWork(budget)) return [];
          if (gate.roadId === road.id && distance(gate.point, hit.point) < 2) {
            duplicate = true;
            break;
          }
        }
        if (duplicate) continue;
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

const createWall = (
  anchor: Point,
  houses: readonly House[],
  roads: readonly Road[],
  budget: GeometryBudget,
): VillageWall => {
  const footprint: Point[] = [];
  const footprintCount = (houses.length + 1) * 12;
  if (!consumeGeometryWork(budget, footprintCount)) {
    return { polygon: [], segments: [], gates: [] };
  }
  for (const center of [anchor, ...houses.map((house) => house.position)]) {
    for (let index = 0; index < 12; index += 1) {
      const angle = index / 12 * Math.PI * 2;
      footprint.push({
        x: center.x + Math.cos(angle) * WALL_CLEARANCE,
        y: center.y + Math.sin(angle) * WALL_CLEARANCE,
      });
    }
  }
  const polygon = convexHull(footprint);
  const gates = wallRoadIntersections(polygon, roads, budget);
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
      .map((gate) => ({ gate, ratio: distance(start, gate.point) / edgeLength }))
      .sort((first, second) => first.ratio - second.ratio);
    let cursor = 0;
    for (const { gate, ratio } of edgeGates) {
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
  return { polygon, segments, gates };
};

const wallIsLand = (
  world: WorldState,
  wall: VillageWall,
  budget: GeometryBudget,
): boolean => {
  for (const segment of wall.segments) {
    const traversed = boundedSegmentCells(segment.start, segment.end, budget);
    if (traversed === null || !consumeGeometryWork(budget, traversed.length)) return false;
    for (const cell of traversed) {
      if (world.terrain[cellIndex(cell)] !== TERRAIN_LAND) return false;
    }
  }
  return true;
};

const mergeIntervals = (values: Array<[number, number]>): Array<[number, number]> => {
  const sorted = values
    .map(([start, end]) => ([
      Math.max(0, Math.min(start, end)),
      Math.min(1, Math.max(start, end)),
    ] as [number, number]))
    .sort((first, second) => first[0] - second[0]);
  const merged: Array<[number, number]> = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || interval[0] > previous[1] + EPSILON) {
      merged.push([...interval]);
    } else {
      previous[1] = Math.max(previous[1], interval[1]);
    }
  }
  return merged;
};

const wallSegmentsMatchEnvelope = (
  wall: VillageWall,
  budget: GeometryBudget,
): boolean => {
  if (wall.polygon.length < 3 || wall.segments.length === 0) return false;
  const actualByEdge = new Map<number, Array<[number, number]>>();
  for (const segment of wall.segments) {
    let assigned = false;
    for (let edgeIndex = 0; edgeIndex < wall.polygon.length; edgeIndex += 1) {
      if (!consumeGeometryWork(budget)) return false;
      const start = wall.polygon[edgeIndex]!;
      const end = wall.polygon[(edgeIndex + 1) % wall.polygon.length]!;
      if (
        pointSegmentDistance(segment.start, start, end) > 0.01
        || pointSegmentDistance(segment.end, start, end) > 0.01
      ) continue;
      const lengthSquared = (end.x - start.x) ** 2 + (end.y - start.y) ** 2;
      const project = (point: Point): number =>
        ((point.x - start.x) * (end.x - start.x)
          + (point.y - start.y) * (end.y - start.y)) / lengthSquared;
      const intervals = actualByEdge.get(edgeIndex) ?? [];
      intervals.push([project(segment.start), project(segment.end)]);
      actualByEdge.set(edgeIndex, intervals);
      assigned = true;
      break;
    }
    if (!assigned) return false;
  }

  for (let edgeIndex = 0; edgeIndex < wall.polygon.length; edgeIndex += 1) {
    const start = wall.polygon[edgeIndex]!;
    const end = wall.polygon[(edgeIndex + 1) % wall.polygon.length]!;
    const edgeLength = distance(start, end);
    if (!consumeGeometryWork(budget, wall.gates.length + 1)) return false;
    const gaps = mergeIntervals(wall.gates
      .filter((gate) => gate.edgeIndex === edgeIndex)
      .map((gate) => {
        const ratio = distance(start, gate.point) / edgeLength;
        const halfGap = gate.width / 2 / edgeLength;
        return [ratio - halfGap, ratio + halfGap] as [number, number];
      }));
    const expected: Array<[number, number]> = [];
    let cursor = 0;
    for (const [gapStart, gapEnd] of gaps) {
      if (gapStart > cursor + EPSILON) expected.push([cursor, gapStart]);
      cursor = Math.max(cursor, gapEnd);
    }
    if (cursor < 1 - EPSILON) expected.push([cursor, 1]);
    const actual = mergeIntervals(actualByEdge.get(edgeIndex) ?? []);
    if (actual.length !== expected.length) return false;
    if (actual.some((interval, index) =>
      Math.abs(interval[0] - expected[index]![0]) > EPSILON
      || Math.abs(interval[1] - expected[index]![1]) > EPSILON)) return false;
  }
  return true;
};

const wallIsConvexWithClearance = (
  wall: VillageWall,
  occupied: readonly Point[],
  budget: GeometryBudget,
): boolean => {
  if (wall.polygon.length < 3) return false;
  let sign = 0;
  for (let index = 0; index < wall.polygon.length; index += 1) {
    if (!consumeGeometryWork(budget)) return false;
    const turn = cross(
      wall.polygon[index]!,
      wall.polygon[(index + 1) % wall.polygon.length]!,
      wall.polygon[(index + 2) % wall.polygon.length]!,
    );
    if (Math.abs(turn) <= EPSILON) continue;
    const nextSign = Math.sign(turn);
    if (sign !== 0 && nextSign !== sign) return false;
    sign = nextSign;
  }
  const minimumClearance = WALL_CLEARANCE * Math.cos(Math.PI / 12) - EPSILON;
  for (const point of occupied) {
    for (let index = 0; index < wall.polygon.length; index += 1) {
      if (!consumeGeometryWork(budget)) return false;
      if (pointSegmentDistance(
        point,
        wall.polygon[index]!,
        wall.polygon[(index + 1) % wall.polygon.length]!,
      ) < minimumClearance) return false;
    }
  }
  return true;
};

const createVillagers = (
  world: WorldState,
  houses: readonly House[],
  seed: number,
  budget: GeometryBudget,
): Villager[] | null => {
  const villagers: Villager[] = [];
  for (const house of houses) {
    const residentCount = residentCountForHouse(seed, house.id);
    for (const position of residentPositionsForHouse(house, residentCount)) {
      if (!consumeGeometryWork(budget)) return null;
      if (!isLandPoint(world, position)) return null;
      villagers.push({
        id: `villager-${villagers.length + 1}`,
        houseId: house.id,
        position,
      });
    }
  }
  return villagers;
};

const createCandidate = (
  world: WorldState,
  anchor: Point,
  seed: number,
  attempt: number,
  budget: GeometryBudget,
): VillageState | null => {
  const random = createRandom((seed ^ Math.imul(attempt + 1, 0x9e3779b1)) >>> 0);
  const angleOffsets = [0, 0.06, -0.06, 0.12, -0.12, 0.18, -0.18, Math.PI / 2];
  const angle = angleOffsets[attempt % angleOffsets.length]!
    + (random.next() - 0.5) * 0.04;
  const scale = attempt < 8 ? 1 : 0.88;
  const basis: Basis = {
    along: { x: Math.cos(angle), y: Math.sin(angle) },
    north: { x: Math.sin(angle), y: -Math.cos(angle) },
  };
  const roads = createRoads(anchor, basis, scale, random);
  let houses = placeHouses(world, anchor, roads, random, budget);
  const spine = roads[0]!;
  const growthSites = [
    growthRoad("branch-growth-west", spine.points[0]!, basis, -1, scale),
    growthRoad("branch-growth-east", spine.points.at(-1)!, basis, 1, scale),
  ];
  for (const road of growthSites) {
    if (houses.length >= 8) break;
    roads.push(road);
    houses = placeHouses(world, anchor, roads, random, budget);
  }
  const crossings = detectSupportedCrossings(world, roads, budget);
  if (crossings === null) return null;
  if (houses.length < 6) return null;
  const wall = createWall(anchor, houses, roads, budget);
  if (wall.polygon.length < 3 || wall.gates.length === 0) return null;
  const villagers = createVillagers(world, houses, seed, budget);
  if (villagers === null || villagers.length < 12) return null;
  const bridges: Bridge[] = crossings.map((crossing, index) => ({
    id: `bridge-${index + 1}`,
    ...crossing,
  }));
  return {
    seed: seed >>> 0,
    anchor: { ...anchor },
    roads,
    houses,
    bridges,
    wall,
    villagers,
  };
};

const failure = (message: string): CommandResult<VillageState> => ({
  ok: false,
  error: { code: "invalid_command", message },
});

export const generateVillage = (
  world: WorldState,
  anchor: Point,
  seed: number,
): CommandResult<VillageState> => {
  if (
    !Number.isFinite(anchor.x)
    || !Number.isFinite(anchor.y)
    || !Number.isSafeInteger(seed)
  ) {
    return failure("Village placement requires finite coordinates and an integer seed.");
  }
  if (!isLandPoint(world, anchor)) {
    return failure("The village totem must be placed on land.");
  }
  const attempt = createTerrainFirstVillageAttempt(world, anchor, seed >>> 0);
  const candidate = attempt.village;
  if (candidate === null) {
    const messages = {
      invalid_anchor: "The village totem must be placed on land.",
      not_enough_reachable_lots: "The requested land region does not have six reachable house lots.",
      wall_cannot_follow_terrain: "A complete wall cannot follow the terrain around this settlement footprint.",
      no_land_entrance: "The settlement footprint has no land route through its wall.",
      no_wall_gate: "The settlement could not align a wall gate with its entrance road.",
      resident_clearance: "The house lots do not leave land clearance for three to four residents each.",
    } as const;
    return failure(messages[attempt.failure ?? "not_enough_reachable_lots"]);
  }
  replaceBridgeCells(world, candidate.bridges.flatMap((bridge) => bridge.cells));
  world.villagers = candidate.villagers;
  world.activeVillage = candidate;
  return { ok: true, value: candidate };
};

const pointsMatch = (first: Point, second: Point): boolean => distance(first, second) < 0.01;

const bridgeMatches = (
  bridge: Bridge,
  crossing: Crossing,
  budget: GeometryBudget,
): boolean => {
  if (!consumeGeometryWork(budget, bridge.cells.length + crossing.cells.length + 1)) return false;
  const angleDelta = Math.abs(Math.atan2(
    Math.sin(bridge.angle - crossing.angle),
    Math.cos(bridge.angle - crossing.angle),
  ));
  if (
    bridge.roadId !== crossing.roadId
    || !pointsMatch(bridge.start, crossing.start)
    || !pointsMatch(bridge.end, crossing.end)
    || !pointsMatch(bridge.center, crossing.center)
    || Math.abs(bridge.length - crossing.length) >= 0.01
    || angleDelta >= 0.001
  ) return false;
  const bridgeCells = bridge.cells.map(cellIndex).sort((first, second) => first - second);
  const crossingCells = crossing.cells.map(cellIndex).sort((first, second) => first - second);
  return bridgeCells.length === crossingCells.length
    && bridgeCells.every((value, index) => value === crossingCells[index]);
};

const COLLECTION_LIMIT_VIOLATION = "village geometry exceeds the 4096-item limit";
const MALFORMED_GEOMETRY_VIOLATION = "village contains malformed geometry";
const EVALUATION_BUDGET_VIOLATION =
  "village evaluation exceeded the shared 4096-operation geometry budget";

const isWorldPoint = (value: unknown): value is Point => {
  if (typeof value !== "object" || value === null) return false;
  const point = value as Partial<Point>;
  return typeof point.x === "number"
    && typeof point.y === "number"
    && worldToCell({ x: point.x, y: point.y }) !== null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isDenseArray = (value: unknown): value is unknown[] => {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return false;
  }
  return true;
};

const isGridCell = (value: unknown): value is Cell =>
  isRecord(value)
  && typeof value.x === "number"
  && typeof value.y === "number"
  && isCellInBounds({ x: value.x, y: value.y });

const validateVillageInput = (
  village: VillageState,
  budget: GeometryBudget,
): string | null => {
  if (
    typeof village !== "object"
    || village === null
    || !Array.isArray(village.roads)
    || !Array.isArray(village.houses)
    || !Array.isArray(village.bridges)
    || !Array.isArray(village.villagers)
    || typeof village.wall !== "object"
    || village.wall === null
    || !Array.isArray(village.wall.polygon)
    || !Array.isArray(village.wall.segments)
    || !Array.isArray(village.wall.gates)
  ) return MALFORMED_GEOMETRY_VIOLATION;

  const topLevelCollections = [
    village.roads,
    village.houses,
    village.bridges,
    village.villagers,
    village.wall.polygon,
    village.wall.segments,
    village.wall.gates,
  ];
  if (topLevelCollections.some((collection) => collection.length > MAX_GEOMETRY_WORK)) {
    return COLLECTION_LIMIT_VIOLATION;
  }
  if (topLevelCollections.some((collection) => !isDenseArray(collection))) {
    return MALFORMED_GEOMETRY_VIOLATION;
  }
  let itemCount = topLevelCollections.reduce((total, collection) => total + collection.length, 0);
  if (itemCount > MAX_GEOMETRY_WORK) return COLLECTION_LIMIT_VIOLATION;
  for (const road of village.roads) {
    if (!isRecord(road) || !Array.isArray(road.points)) return MALFORMED_GEOMETRY_VIOLATION;
    if (road.points.length > MAX_GEOMETRY_WORK - itemCount) return COLLECTION_LIMIT_VIOLATION;
    if (!isDenseArray(road.points)) return MALFORMED_GEOMETRY_VIOLATION;
    itemCount += road.points.length;
  }
  for (const bridge of village.bridges) {
    if (!isRecord(bridge) || !Array.isArray(bridge.cells)) return MALFORMED_GEOMETRY_VIOLATION;
    if (bridge.cells.length > MAX_GEOMETRY_WORK - itemCount) {
      return COLLECTION_LIMIT_VIOLATION;
    }
    if (!isDenseArray(bridge.cells)) return MALFORMED_GEOMETRY_VIOLATION;
    itemCount += bridge.cells.length;
  }
  if (!consumeGeometryWork(budget, itemCount)) return EVALUATION_BUDGET_VIOLATION;

  if (!Number.isSafeInteger(village.seed) || !isWorldPoint(village.anchor)) {
    return MALFORMED_GEOMETRY_VIOLATION;
  }
  for (const road of village.roads) {
    if (!isRecord(road)) return MALFORMED_GEOMETRY_VIOLATION;
    if (
      typeof road.id !== "string"
      || road.id.length === 0
      || (road.role !== "spine" && road.role !== "entrance" && road.role !== "branch")
      || (road.parentId !== null && typeof road.parentId !== "string")
    ) return MALFORMED_GEOMETRY_VIOLATION;
    if (!road.points.every(isWorldPoint)) return MALFORMED_GEOMETRY_VIOLATION;
  }
  for (const house of village.houses) {
    if (!isRecord(house)) return MALFORMED_GEOMETRY_VIOLATION;
    if (
      typeof house.id !== "string"
      || typeof house.roadId !== "string"
      || !isWorldPoint(house.position)
      || !isWorldPoint(house.frontage)
      || !Number.isFinite(house.facing)
    ) return MALFORMED_GEOMETRY_VIOLATION;
  }
  for (const bridge of village.bridges) {
    if (!isRecord(bridge)) return MALFORMED_GEOMETRY_VIOLATION;
    if (
      typeof bridge.id !== "string"
      || typeof bridge.roadId !== "string"
      || !isWorldPoint(bridge.start)
      || !isWorldPoint(bridge.end)
      || !isWorldPoint(bridge.center)
      || !Number.isFinite(bridge.angle)
      || !Number.isFinite(bridge.length)
      || bridge.length <= 0
      || !bridge.cells.every(isGridCell)
    ) return MALFORMED_GEOMETRY_VIOLATION;
  }
  if (!village.wall.polygon.every(isWorldPoint)) return MALFORMED_GEOMETRY_VIOLATION;
  for (const segment of village.wall.segments) {
    if (!isRecord(segment)) return MALFORMED_GEOMETRY_VIOLATION;
    if (!isWorldPoint(segment.start) || !isWorldPoint(segment.end)) {
      return MALFORMED_GEOMETRY_VIOLATION;
    }
  }
  for (const gate of village.wall.gates) {
    if (!isRecord(gate)) return MALFORMED_GEOMETRY_VIOLATION;
    if (
      typeof gate.id !== "string"
      || typeof gate.roadId !== "string"
      || !isWorldPoint(gate.point)
      || !Number.isInteger(gate.edgeIndex)
      || gate.edgeIndex < 0
      || gate.edgeIndex >= village.wall.polygon.length
      || !Number.isFinite(gate.width)
      || gate.width <= 0
    ) return MALFORMED_GEOMETRY_VIOLATION;
  }
  for (const villager of village.villagers) {
    if (!isRecord(villager)) return MALFORMED_GEOMETRY_VIOLATION;
    if (
      typeof villager.id !== "string"
      || typeof villager.houseId !== "string"
      || !isWorldPoint(villager.position)
    ) {
      return MALFORMED_GEOMETRY_VIOLATION;
    }
  }
  return null;
};

const evaluateVillageWithBudget = (
  world: WorldState,
  village: VillageState,
  budget: GeometryBudget,
): string[] => {
  const invalidInput = validateVillageInput(village, budget);
  if (invalidInput !== null) return [invalidInput];
  const violations: string[] = [];
  if (!consumeGeometryWork(budget)) return [EVALUATION_BUDGET_VIOLATION];
  if (!isLandPoint(world, village.anchor)) {
    violations.push("village anchor is not on land");
  } else if (!hasLandClearance(
    world,
    village.anchor,
    ANCHOR_CLEARANCE,
    () => consumeGeometryWork(budget),
  )) {
    if (budget.exhausted) return [EVALUATION_BUDGET_VIOLATION];
    violations.push("village anchor clearance contains water");
  }
  const roadById = new Map<string, Road>();
  for (const road of village.roads) {
    if (!consumeGeometryWork(budget)) return [EVALUATION_BUDGET_VIOLATION];
    if (roadById.has(road.id)) violations.push(`duplicate road id ${road.id}`);
    roadById.set(road.id, road);
  }
  for (const road of village.roads) {
    if (!consumeGeometryWork(budget)) return [EVALUATION_BUDGET_VIOLATION];
    if (road.points.length < 2) violations.push(`${road.id} has too few points`);
    if (road.parentId !== null) {
      const parent = roadById.get(road.parentId);
      if (parent === undefined) violations.push(`${road.id} has missing parent ${road.parentId}`);
      else if (distanceToRoad(road.points[0]!, parent, budget) >= EPSILON) {
        violations.push(`${road.id} does not attach to parent ${road.parentId}`);
      }
    }
    const visited = new Set<string>();
    let cursor: Road | undefined = road;
    while (cursor?.parentId !== null) {
      if (!consumeGeometryWork(budget)) return [EVALUATION_BUDGET_VIOLATION];
      if (visited.has(cursor.id)) {
        violations.push(`${road.id} has a cyclic parent chain`);
        cursor = undefined;
        break;
      }
      visited.add(cursor.id);
      cursor = roadById.get(cursor.parentId);
      if (cursor === undefined) break;
    }
    if (cursor !== undefined && distanceToRoad(village.anchor, cursor, budget) >= EPSILON) {
      violations.push(`${road.id} parent chain misses the village anchor`);
    }
  }

  const crossings = detectSupportedCrossings(world, village.roads, budget);
  if (crossings === null || budget.exhausted) return [EVALUATION_BUDGET_VIOLATION];
  const unsupportedRoads = allRoadWaterIsBridged(world, village.roads, crossings, budget);
  if (unsupportedRoads === null || budget.exhausted) return [EVALUATION_BUDGET_VIOLATION];
  for (const roadId of unsupportedRoads) {
    violations.push(`${roadId} enters unsupported water without a bridge`);
  }
  if (crossings.length !== village.bridges.length) {
    violations.push("bridge count does not match supported crossings");
  }
  for (const bridge of village.bridges) {
    const crossing = crossings.find((candidate) => bridgeMatches(bridge, candidate, budget));
    if (budget.exhausted) return [EVALUATION_BUDGET_VIOLATION];
    if (crossing === undefined) violations.push(`${bridge.id} bridge geometry is unsupported`);
  }
  for (const crossing of crossings) {
    if (!village.bridges.some((bridge) => bridgeMatches(bridge, crossing, budget))) {
      violations.push(`crossing on ${crossing.roadId} has no matching bridge`);
    }
    if (budget.exhausted) return [EVALUATION_BUDGET_VIOLATION];
  }

  if (village.houses.length < 6) violations.push("village has fewer than six houses");
  for (let houseIndex = 0; houseIndex < village.houses.length; houseIndex += 1) {
    if (!consumeGeometryWork(budget)) return [EVALUATION_BUDGET_VIOLATION];
    const house = village.houses[houseIndex]!;
    const owningRoad = roadById.get(house.roadId);
    if (owningRoad === undefined) violations.push(`${house.id} has a missing owning road`);
    else if (distanceToRoad(house.frontage, owningRoad, budget) >= EPSILON) {
      violations.push(`${house.id} frontage misses ${house.roadId}`);
    }
    const expectedFacing = Math.atan2(
      house.frontage.y - house.position.y,
      house.frontage.x - house.position.x,
    );
    const facingDelta = Math.abs(Math.atan2(
      Math.sin(house.facing - expectedFacing),
      Math.cos(house.facing - expectedFacing),
    ));
    if (facingDelta >= 0.001) violations.push(`${house.id} faces away from its frontage`);
    if (!isLandPoint(world, house.position)) violations.push(`${house.id} is not on land`);
    for (const road of village.roads) {
      if (!consumeGeometryWork(budget)) return [EVALUATION_BUDGET_VIOLATION];
      if (road.id !== house.roadId
        && distanceToRoad(house.position, road, budget) < HOUSE_ROAD_CLEARANCE) {
        violations.push(`${house.id} intersects non-owning road ${road.id}`);
      }
    }
    for (let otherIndex = houseIndex + 1; otherIndex < village.houses.length; otherIndex += 1) {
      if (!consumeGeometryWork(budget)) return [EVALUATION_BUDGET_VIOLATION];
      if (distance(house.position, village.houses[otherIndex]!.position) < HOUSE_MINIMUM_SPACING) {
        violations.push(`${house.id} overlaps ${village.houses[otherIndex]!.id}`);
      }
    }
  }

  if (
    village.villagers.length < village.houses.length * MIN_RESIDENTS_PER_HOUSE
    || village.villagers.length > village.houses.length * MAX_RESIDENTS_PER_HOUSE
  ) {
    violations.push("villager count is not three to four per house");
  }
  const villagerIds = new Set<string>();
  if (!consumeGeometryWork(budget, village.houses.length)) {
    return [EVALUATION_BUDGET_VIOLATION];
  }
  const houseIds = new Set(village.houses.map((house) => house.id));
  const residentsByHouse = new Map<string, Villager[]>();
  for (const villager of village.villagers) {
    if (!consumeGeometryWork(budget)) return [EVALUATION_BUDGET_VIOLATION];
    if (villagerIds.has(villager.id)) violations.push(`duplicate villager id ${villager.id}`);
    villagerIds.add(villager.id);
    if (!isLandPoint(world, villager.position)) violations.push(`${villager.id} is not on land`);
    if (villager.houseId === undefined
      || !houseIds.has(villager.houseId)) {
      violations.push(`${villager.id} has no owning house`);
    } else {
      const residents = residentsByHouse.get(villager.houseId) ?? [];
      residents.push(villager);
      residentsByHouse.set(villager.houseId, residents);
    }
  }
  for (const house of village.houses) {
    if (!consumeGeometryWork(budget)) return [EVALUATION_BUDGET_VIOLATION];
    const residents = residentsByHouse.get(house.id) ?? [];
    const expectedCount = residentCountForHouse(village.seed, house.id);
    if (residents.length !== expectedCount) {
      violations.push(`${house.id} does not have exactly ${expectedCount} villagers`);
      continue;
    }
    const expected = residentPositionsForHouse(house, expectedCount);
    if (!expected.every((point) => residents.some((resident) => pointsMatch(resident.position, point)))) {
      violations.push(`${house.id} villagers are not at stable frontage offsets`);
    }
  }

  if (!consumeGeometryWork(budget, village.wall.polygon.length)) {
    return [EVALUATION_BUDGET_VIOLATION];
  }
  if (!pointInPolygon(village.anchor, village.wall.polygon)) {
    violations.push("wall excludes the village anchor");
  }
  for (const house of village.houses) {
    if (!consumeGeometryWork(budget, village.wall.polygon.length)) {
      return [EVALUATION_BUDGET_VIOLATION];
    }
    if (!pointInPolygon(house.position, village.wall.polygon)) {
      violations.push(`wall excludes ${house.id}`);
    }
  }
  if (!wallIsLand(world, village.wall, budget)) violations.push("wall intersects water");
  if (budget.exhausted) return [EVALUATION_BUDGET_VIOLATION];
  if (!wallIsConvexWithClearance(
    village.wall,
    [village.anchor, ...village.houses.map((house) => house.position)],
    budget,
  )) violations.push("wall is not a convex occupied-core envelope with fixed clearance");
  if (budget.exhausted) return [EVALUATION_BUDGET_VIOLATION];
  if (!wallSegmentsMatchEnvelope(village.wall, budget)) {
    violations.push("wall segments do not match the gated polygon envelope");
  }
  if (budget.exhausted) return [EVALUATION_BUDGET_VIOLATION];

  const expectedGates = wallRoadIntersections(village.wall.polygon, village.roads, budget);
  if (budget.exhausted) return [EVALUATION_BUDGET_VIOLATION];
  for (const expected of expectedGates) {
    if (!consumeGeometryWork(budget, village.wall.gates.length + 1)) {
      return [EVALUATION_BUDGET_VIOLATION];
    }
    if (!village.wall.gates.some((gate) =>
      gate.roadId === expected.roadId
      && gate.edgeIndex === expected.edgeIndex
      && pointsMatch(gate.point, expected.point)
      && gate.width > 0)) {
      violations.push(`missing gate for ${expected.roadId}`);
    }
  }
  for (const gate of village.wall.gates) {
    if (!consumeGeometryWork(budget, expectedGates.length + 1)) {
      return [EVALUATION_BUDGET_VIOLATION];
    }
    if (!expectedGates.some((expected) =>
      gate.roadId === expected.roadId
      && gate.edgeIndex === expected.edgeIndex
      && pointsMatch(gate.point, expected.point))) {
      violations.push(`${gate.id} is not at a wall-road intersection`);
    }
  }
  for (const segment of village.wall.segments) {
    for (const road of village.roads) {
      if (!consumeGeometryWork(budget, Math.max(1, road.points.length - 1))) {
        return [EVALUATION_BUDGET_VIOLATION];
      }
      for (let index = 1; index < road.points.length; index += 1) {
        if (segmentsIntersect(
          segment.start,
          segment.end,
          road.points[index - 1]!,
          road.points[index]!,
        )) violations.push(`wall closes road ${road.id} outside a gate`);
      }
    }
  }
  return [...new Set(violations)];
};

export const evaluateVillage = (world: WorldState, village: VillageState): string[] =>
  evaluateVillageWithBudget(world, village, createGeometryBudget());

export const villageAnchorIsValid = (
  world: WorldState,
  village: VillageState,
): boolean => isLandPoint(world, village.anchor);

export const rebuildVillageBridges = (
  world: WorldState,
  village: VillageState,
): CommandResult<Bridge[]> => {
  const budget = createGeometryBudget();
  const crossings = detectSupportedCrossings(world, village.roads, budget);
  if (crossings === null || budget.exhausted) {
    return {
      ok: false,
      error: {
        code: "invalid_command",
        message: "Terrain reconciliation exceeded the shared 4096-operation geometry budget.",
      },
    };
  }
  const bridges = crossings.map((crossing, index) => ({
    id: `bridge-${index + 1}`,
    ...crossing,
  }));
  village.bridges = bridges;
  replaceBridgeCells(world, bridges.flatMap((bridge) => bridge.cells));
  return { ok: true, value: bridges };
};

export const VILLAGE_GENERATION_LIMITS = Object.freeze({
  attempts: GENERATION_ATTEMPTS,
  maxGeometryWork: MAX_GEOMETRY_WORK,
  maxSearchCells: MAX_SEARCH_CELLS,
});
