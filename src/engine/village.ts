import {
  CELL_SIZE,
  MAX_RIVER_WIDTH_CELLS,
  TERRAIN_LAND,
  TERRAIN_WATER,
} from "./constants";
import {
  cellIndex,
  cellToWorld,
  isCellInBounds,
  worldToCell,
} from "./geometry";
import { replaceBridgeCells } from "./navigation";
import { isLandPoint } from "./terrain";
import { createTerrainFirstVillageAttempt } from "./adaptive-village";
import type {
  Bridge,
  Cell,
  CommandResult,
  Point,
  Road,
  VillageState,
  WorldState,
} from "./types";

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

interface Crossing {
  roadId: string;
  start: Point;
  end: Point;
  center: Point;
  angle: number;
  length: number;
  cells: Cell[];
}

const distance = (first: Point, second: Point): number =>
  Math.hypot(first.x - second.x, first.y - second.y);

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
