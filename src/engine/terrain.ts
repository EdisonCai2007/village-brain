import {
  CELL_SIZE,
  GRID_CELL_COUNT,
  GRID_HEIGHT,
  GRID_WIDTH,
  MAX_RIVER_WIDTH_CELLS,
  MAX_SEARCH_CELLS,
  TERRAIN_LAND,
  TERRAIN_WATER,
} from "./constants";
import {
  cellIndex,
  cellToWorld,
  fourWayNeighbors,
  indexToCell,
  isCellInBounds,
  worldToCell,
} from "./geometry";
import { createRandom } from "./random";
import type {
  Cell,
  CommandResult,
  Point,
  TerrainPaintCommand,
  Tree,
  WorldState,
} from "./types";

const ISLAND_CENTER_X = 63.5;
const ISLAND_CENTER_Y = 43;
const ISLAND_RADIUS_X = 56;
const ISLAND_RADIUS_Y = 37;
const BOUNDARY_SAMPLE_COUNT = 16;
const MAX_TERRAIN_RELOCATION_CELLS = 256;
const MAX_TERRAIN_RELOCATION_SEARCHES = Math.floor(
  MAX_SEARCH_CELLS / MAX_TERRAIN_RELOCATION_CELLS,
);
const TREE_COUNT = 64;
const TREE_PLACEMENT_ATTEMPTS = 1_024;

export type WorldTerrainMode = "generated" | "ocean";

const createDefaultTrees = (world: WorldState): Tree[] => {
  const random = createRandom((world.seed ^ 0xa511e9b3) >>> 0);
  const occupied = new Uint8Array(GRID_CELL_COUNT);
  const trees: Tree[] = [];
  for (
    let attempt = 0;
    attempt < TREE_PLACEMENT_ATTEMPTS && trees.length < TREE_COUNT;
    attempt += 1
  ) {
    const cell = { x: random.nextInt(GRID_WIDTH), y: random.nextInt(GRID_HEIGHT) };
    const index = cellIndex(cell);
    if (occupied[index] === 1 || world.terrain[index] !== TERRAIN_LAND) continue;
    const position = cellToWorld(cell);
    if (Math.hypot(position.x - 640, position.y - 560) < 180) continue;
    occupied[index] = 1;
    trees.push({ id: `tree-${trees.length + 1}`, position });
  }
  return trees;
};

const createDefaultTerrain = (world: WorldState): void => {
  const boundaryOffsets = Array.from(
    { length: BOUNDARY_SAMPLE_COUNT },
    () => (world.random.next() - 0.5) * 0.12,
  );
  const riverPhase = world.random.next() * Math.PI * 2;
  const riverVerticalOffset = world.random.nextInt(5) - 2;

  for (let y = 0; y < GRID_HEIGHT; y += 1) {
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      const normalizedX = (x - ISLAND_CENTER_X) / ISLAND_RADIUS_X;
      const normalizedY = (y - ISLAND_CENTER_Y) / ISLAND_RADIUS_Y;
      const angle = (Math.atan2(normalizedY, normalizedX) + Math.PI * 2) % (Math.PI * 2);
      const samplePosition = angle / (Math.PI * 2) * BOUNDARY_SAMPLE_COUNT;
      const sampleIndex = Math.floor(samplePosition) % BOUNDARY_SAMPLE_COUNT;
      const nextSampleIndex = (sampleIndex + 1) % BOUNDARY_SAMPLE_COUNT;
      const fraction = samplePosition - Math.floor(samplePosition);
      const perturbation = boundaryOffsets[sampleIndex]!
        + (boundaryOffsets[nextSampleIndex]! - boundaryOffsets[sampleIndex]!) * fraction;
      const radialDistance = normalizedX * normalizedX + normalizedY * normalizedY;
      if (radialDistance <= 1 + perturbation) {
        world.terrain[cellIndex({ x, y })] = TERRAIN_LAND;
      }
    }
  }

  const riverEndX = 93;
  for (let x = 0; x <= riverEndX; x += 1) {
    const centerY = Math.round(
      34 + riverVerticalOffset
      + Math.sin(x * 0.105 + riverPhase) * 2
      + Math.sin(x * 0.035 + riverPhase * 0.5),
    );
    for (let offset = -2; offset <= 2; offset += 1) {
      const cell = { x, y: centerY + offset };
      if (isCellInBounds(cell)) world.terrain[cellIndex(cell)] = TERRAIN_WATER;
    }
  }
};

export const createWorld = (seed: number, terrainMode: WorldTerrainMode = "generated"): WorldState => {
  const normalizedSeed = seed >>> 0;
  const world: WorldState = {
    seed: normalizedSeed,
    simulationTimeMs: 0,
    paused: false,
    random: createRandom(normalizedSeed),
    terrain: new Uint8Array(GRID_CELL_COUNT),
    riverLike: new Uint8Array(GRID_CELL_COUNT),
    terrainRevision: 0,
    bridgeCells: new Uint8Array(GRID_CELL_COUNT),
    villagers: [],
    hostiles: [],
    trees: [],
    activeVillage: null,
    events: [],
    fires: [],
    tsunamis: [],
    pits: [],
    plagueCases: [],
    plagueExposures: [],
    villagerTasks: [],
    planHistory: [],
    foundedAnchors: [],
    timeline: [],
    latestFeedback: null,
    worldRevision: 0,
    structureRevision: 0,
    hazardRevision: 0,
    unitRevision: 0,
  };
  if (terrainMode === "generated") {
    createDefaultTerrain(world);
    world.riverLike = classifyRiverLike(world);
    world.trees = createDefaultTrees(world);
  }
  return world;
};

export const isLandPoint = (world: WorldState, point: Point): boolean => {
  const cell = worldToCell(point);
  return cell !== null && world.terrain[cellIndex(cell)] === TERRAIN_LAND;
};

export const hasLandClearance = (
  world: WorldState,
  point: Point,
  radius: number,
  consumeWork: () => boolean = () => true,
): boolean => {
  if (!Number.isFinite(radius) || radius < 0 || !isLandPoint(world, point)) return false;
  const minimumX = Math.floor((point.x - radius) / CELL_SIZE);
  const maximumX = Math.floor((point.x + radius) / CELL_SIZE);
  const minimumY = Math.floor((point.y - radius) / CELL_SIZE);
  const maximumY = Math.floor((point.y + radius) / CELL_SIZE);
  const radiusSquared = radius * radius;
  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) {
      const cell = { x, y };
      const deltaX = x * CELL_SIZE + CELL_SIZE / 2 - point.x;
      const deltaY = y * CELL_SIZE + CELL_SIZE / 2 - point.y;
      if (deltaX * deltaX + deltaY * deltaY > radiusSquared) continue;
      if (!consumeWork()) return false;
      if (!isCellInBounds(cell)) return false;
      if (world.terrain[cellIndex(cell)] !== TERRAIN_LAND) return false;
    }
  }
  return true;
};

const scanForLand = (
  world: WorldState,
  cell: Cell,
  dx: number,
  dy: number,
): number | null => {
  for (let distance = 1; distance <= MAX_RIVER_WIDTH_CELLS; distance += 1) {
    const candidate = { x: cell.x + dx * distance, y: cell.y + dy * distance };
    if (!isCellInBounds(candidate)) return null;
    if (world.terrain[cellIndex(candidate)] === TERRAIN_LAND) return distance;
  }
  return null;
};

export const classifyRiverLike = (world: WorldState): Uint8Array => {
  const riverLike = new Uint8Array(GRID_CELL_COUNT);
  for (let index = 0; index < GRID_CELL_COUNT; index += 1) {
    if (world.terrain[index] !== TERRAIN_WATER) continue;
    const cell = indexToCell(index);
    const north = scanForLand(world, cell, 0, -1);
    const south = scanForLand(world, cell, 0, 1);
    const west = scanForLand(world, cell, -1, 0);
    const east = scanForLand(world, cell, 1, 0);
    const boundedVertically = north !== null
      && south !== null
      && north + south - 1 <= MAX_RIVER_WIDTH_CELLS;
    const boundedHorizontally = west !== null
      && east !== null
      && west + east - 1 <= MAX_RIVER_WIDTH_CELLS;
    if (boundedVertically || boundedHorizontally) riverLike[index] = 1;
  }
  return riverLike;
};

export const findNearestLand = (
  world: WorldState,
  point: Point,
  maxCells: number,
): Point | null => {
  const start = worldToCell(point);
  if (start === null || !Number.isFinite(maxCells) || maxCells <= 0) return null;
  const limit = Math.min(Math.floor(maxCells), MAX_SEARCH_CELLS, GRID_CELL_COUNT);
  const visited = new Uint8Array(GRID_CELL_COUNT);
  const queue = new Int32Array(limit);
  let head = 0;
  let tail = 0;
  const startIndex = cellIndex(start);
  queue[tail] = startIndex;
  tail += 1;
  visited[startIndex] = 1;

  while (head < tail && head < limit) {
    const currentIndex = queue[head]!;
    head += 1;
    if (world.terrain[currentIndex] === TERRAIN_LAND) {
      return cellToWorld(indexToCell(currentIndex));
    }
    for (const neighbor of fourWayNeighbors(indexToCell(currentIndex))) {
      const neighborIndex = cellIndex(neighbor);
      if (visited[neighborIndex] === 1 || tail >= limit) continue;
      visited[neighborIndex] = 1;
      queue[tail] = neighborIndex;
      tail += 1;
    }
  }
  return null;
};

const failure = <T = undefined>(
  code: "invalid_command" | "no_relocation",
  message: string,
): CommandResult<T> => ({
  ok: false,
  error: { code, message },
});

export const paintTerrain = (
  world: WorldState,
  command: TerrainPaintCommand,
): CommandResult => {
  if (
    command.type !== "paint"
    || (command.terrain !== "land" && command.terrain !== "water")
    || !Number.isFinite(command.point.x)
    || !Number.isFinite(command.point.y)
    || !Number.isFinite(command.radius)
    || command.radius <= 0
  ) {
    return failure("invalid_command", "Paint commands require finite coordinates and a positive radius.");
  }
  if (world.villagers.length > MAX_SEARCH_CELLS) {
    return failure("invalid_command", "Terrain entity collections cannot exceed 4096 items.");
  }

  const minCellX = Math.max(0, Math.floor((command.point.x - command.radius) / CELL_SIZE));
  const maxCellX = Math.min(GRID_WIDTH - 1, Math.floor((command.point.x + command.radius) / CELL_SIZE));
  const minCellY = Math.max(0, Math.floor((command.point.y - command.radius) / CELL_SIZE));
  const maxCellY = Math.min(GRID_HEIGHT - 1, Math.floor((command.point.y + command.radius) / CELL_SIZE));
  if (minCellX > maxCellX || minCellY > maxCellY) {
    return failure("invalid_command", "The paint brush does not overlap the world.");
  }

  const replacement = command.terrain === "land" ? TERRAIN_LAND : TERRAIN_WATER;
  const changedIndices: number[] = [];
  const previousValues: number[] = [];
  const radiusSquared = command.radius * command.radius;
  for (let y = minCellY; y <= maxCellY; y += 1) {
    for (let x = minCellX; x <= maxCellX; x += 1) {
      const center = cellToWorld({ x, y });
      const dx = center.x - command.point.x;
      const dy = center.y - command.point.y;
      if (dx * dx + dy * dy > radiusSquared) continue;
      const index = cellIndex({ x, y });
      if (world.terrain[index] === replacement) continue;
      changedIndices.push(index);
      previousValues.push(world.terrain[index]!);
      world.terrain[index] = replacement;
    }
  }

  const relocations: Point[] = [];
  let relocationSearches = 0;
  if (replacement === TERRAIN_WATER) {
    for (const villager of world.villagers) {
      const occupiedCell = worldToCell(villager.position);
      if (occupiedCell === null || world.terrain[cellIndex(occupiedCell)] === TERRAIN_LAND) {
        relocations.push(villager.position);
        continue;
      }
      relocationSearches += 1;
      if (relocationSearches > MAX_TERRAIN_RELOCATION_SEARCHES) {
        for (let changed = 0; changed < changedIndices.length; changed += 1) {
          world.terrain[changedIndices[changed]!] = previousValues[changed]!;
        }
        return failure("no_relocation", "Terrain relocation exceeded the shared 4096-cell work budget.");
      }
      const destination = findNearestLand(
        world,
        villager.position,
        MAX_TERRAIN_RELOCATION_CELLS,
      );
      if (destination === null) {
        for (let changed = 0; changed < changedIndices.length; changed += 1) {
          world.terrain[changedIndices[changed]!] = previousValues[changed]!;
        }
        return failure("no_relocation", `No land cell is available for ${villager.id}.`);
      }
      relocations.push(destination);
    }
  }

  for (let index = 0; index < relocations.length; index += 1) {
    world.villagers[index]!.position = relocations[index]!;
  }
  if (changedIndices.length > 0) world.terrainRevision += 1;
  return { ok: true, value: undefined };
};

export interface TerrainEntityConsequence {
  relocatedHostiles: number;
  removedTrees: number;
}

export const reconcileTerrainEntities = (
  world: WorldState,
  usedRelocationSearches: number,
): CommandResult<TerrainEntityConsequence> => {
  if (
    !Number.isSafeInteger(usedRelocationSearches)
    || usedRelocationSearches < 0
    || usedRelocationSearches > MAX_TERRAIN_RELOCATION_SEARCHES
    || world.hostiles.length > MAX_SEARCH_CELLS
    || world.trees.length > MAX_SEARCH_CELLS
  ) {
    return failure("invalid_command", "Terrain entity collections cannot exceed 4096 items.");
  }

  const hostiles = structuredClone(world.hostiles);
  let relocationSearches = usedRelocationSearches;
  let relocatedHostiles = 0;
  for (const hostile of hostiles) {
    if (isLandPoint(world, hostile.position)) continue;
    relocationSearches += 1;
    if (relocationSearches > MAX_TERRAIN_RELOCATION_SEARCHES) {
      return failure("no_relocation", "Terrain relocation exceeded the shared 4096-cell work budget.");
    }
    const destination = findNearestLand(
      world,
      hostile.position,
      MAX_TERRAIN_RELOCATION_CELLS,
    );
    if (destination === null) {
      return failure("no_relocation", `No land cell is available for ${hostile.id}.`);
    }
    hostile.position = destination;
    relocatedHostiles += 1;
  }

  const trees = world.trees.filter((tree) => isLandPoint(world, tree.position));
  const removedTrees = world.trees.length - trees.length;
  world.hostiles = hostiles;
  world.trees = trees;
  return { ok: true, value: { relocatedHostiles, removedTrees } };
};
