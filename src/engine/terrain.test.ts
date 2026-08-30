import { describe, expect, it } from "vitest";
import {
  CELL_SIZE,
  GRID_HEIGHT,
  GRID_WIDTH,
  TERRAIN_LAND,
  TERRAIN_WATER,
} from "./constants";
import {
  boundedFloodFill,
  cellIndex,
  cellToWorld,
  interpolateSegment,
  pointInPolygon,
  pointSegmentDistance,
  segmentsIntersect,
  worldToCell,
} from "./geometry";
import {
  classifyRiverLike,
  createWorld,
  findNearestLand,
  paintTerrain,
  reconcileTerrainEntities,
} from "./terrain";

const countCells = (cells: Uint8Array, value: number): number => {
  let count = 0;
  for (const cell of cells) {
    if (cell === value) count += 1;
  }
  return count;
};

const countLandComponents = (terrain: Uint8Array): number => {
  const parents = new Int32Array(GRID_WIDTH * GRID_HEIGHT);
  parents.fill(-1);
  const findRoot = (start: number): number => {
    let root = start;
    while (parents[root] !== root) root = parents[root]!;
    let current = start;
    while (current !== root) {
      const parent = parents[current]!;
      parents[current] = root;
      current = parent;
    }
    return root;
  };
  const connect = (first: number, second: number): void => {
    const firstRoot = findRoot(first);
    const secondRoot = findRoot(second);
    if (firstRoot !== secondRoot) parents[secondRoot] = firstRoot;
  };

  for (let y = 0; y < GRID_HEIGHT; y += 1) {
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      const index = y * GRID_WIDTH + x;
      if (terrain[index] !== TERRAIN_LAND) continue;
      parents[index] = index;
      if (x > 0 && terrain[index - 1] === TERRAIN_LAND) connect(index, index - 1);
      if (y > 0 && terrain[index - GRID_WIDTH] === TERRAIN_LAND) {
        connect(index, index - GRID_WIDTH);
      }
    }
  }

  const roots = new Set<number>();
  for (let index = 0; index < parents.length; index += 1) {
    if (parents[index] !== -1) roots.add(findRoot(index));
  }
  return roots.size;
};

describe("geometry helpers", () => {
  it("converts only in-bounds world coordinates to integer grid cells", () => {
    expect(worldToCell({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(worldToCell({ x: 1_279.999, y: 859.999 })).toEqual({ x: 127, y: 85 });
    expect(worldToCell({ x: -0.001, y: 20 })).toBeNull();
    expect(worldToCell({ x: 1_280, y: 20 })).toBeNull();
    expect(cellToWorld({ x: 0, y: 0 })).toEqual({ x: 5, y: 5 });
    expect(cellToWorld({ x: 127, y: 85 })).toEqual({ x: 1_275, y: 855 });
  });

  it("interpolates a segment at a bounded spacing including both endpoints", () => {
    expect(interpolateSegment({ x: 0, y: 0 }, { x: 30, y: 0 }, 10)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 30, y: 0 },
    ]);
    expect(interpolateSegment({ x: 4, y: 7 }, { x: 4, y: 7 }, 10)).toEqual([
      { x: 4, y: 7 },
    ]);
  });

  it("computes independent point, polygon, and segment predicates", () => {
    expect(pointSegmentDistance(
      { x: 3, y: 4 },
      { x: 0, y: 0 },
      { x: 6, y: 0 },
    )).toBe(4);
    const square = [
      { x: 0, y: 0 }, { x: 10, y: 0 },
      { x: 10, y: 10 }, { x: 0, y: 10 },
    ];
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, square)).toBe(false);
    expect(segmentsIntersect(
      { x: 0, y: 0 }, { x: 10, y: 10 },
      { x: 0, y: 10 }, { x: 10, y: 0 },
    )).toBe(true);
    expect(segmentsIntersect(
      { x: 0, y: 0 }, { x: 3, y: 0 },
      { x: 4, y: 0 }, { x: 8, y: 0 },
    )).toBe(false);
  });

  it("stops flood fill at the explicit cell limit and world edges", () => {
    expect(boundedFloodFill(
      { x: 0, y: 0 },
      () => true,
      3,
    )).toEqual([0, 1, GRID_WIDTH]);
  });

  it("hard-caps flood fill requests above 4096 visited cells", () => {
    expect(boundedFloodFill(
      { x: 0, y: 0 },
      () => true,
      GRID_WIDTH * GRID_HEIGHT,
    )).toHaveLength(4_096);
  });
});

describe("world startup modes", () => {
  it("creates a water-only world when ocean mode is requested", () => {
    const world = createWorld(1, "ocean");

    expect(world.terrain.every((cell) => cell === TERRAIN_WATER)).toBe(true);
    expect(world.activeVillage).toBeNull();
    expect(world.trees).toEqual([]);
  });
});

describe("default terrain", () => {
  it("replays identical terrain and PRNG continuation for identical seeds", () => {
    const first = createWorld(42);
    const replay = createWorld(42);

    expect([...first.terrain]).toEqual([...replay.terrain]);
    expect(first.random.state).toBe(replay.random.state);
    expect(first.random.next()).toBe(replay.random.next());
  });

  it("contains a large connected island and one connected narrow river-like band", () => {
    const world = createWorld(42);
    const riverLike = classifyRiverLike(world);
    const riverStart = riverLike.findIndex((cell) => cell === 1);
    const riverCell = { x: riverStart % GRID_WIDTH, y: Math.floor(riverStart / GRID_WIDTH) };
    const connectedRiver = boundedFloodFill(
      riverCell,
      (cell) => riverLike[cellIndex(cell)] === 1,
      GRID_WIDTH * GRID_HEIGHT,
    );

    expect(countCells(world.terrain, TERRAIN_LAND)).toBeGreaterThan(4_500);
    expect(countLandComponents(world.terrain)).toBe(1);
    expect(countCells(riverLike, 1)).toBeGreaterThan(150);
    expect(connectedRiver.length).toBe(countCells(riverLike, 1));
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      const rows: number[] = [];
      for (let y = 0; y < GRID_HEIGHT; y += 1) {
        if (riverLike[cellIndex({ x, y })] === 1) rows.push(y);
      }
      if (rows.length > 0) {
        expect(rows.at(-1)! - rows[0]! + 1).toBeLessThanOrEqual(9);
      }
    }
  });
});

describe("terrain editing", () => {
  it("paints interpolated brush samples and increments one revision per command", () => {
    const world = createWorld(42);
    const points = interpolateSegment({ x: 605, y: 505 }, { x: 645, y: 505 }, 10);

    for (const point of points) {
      expect(paintTerrain(world, {
        type: "paint",
        terrain: "water",
        point,
        radius: 6,
      }).ok).toBe(true);
    }

    expect(world.terrainRevision).toBe(5);
    for (const x of [605, 615, 625, 635]) {
      const cell = worldToCell({ x, y: 505 });
      expect(cell).not.toBeNull();
      expect(world.terrain[cellIndex(cell!)]).toBe(TERRAIN_WATER);
    }
    expect(paintTerrain(world, {
      type: "paint",
      terrain: "water",
      point: { x: 620, y: 500 },
      radius: 20,
    }).ok).toBe(true);
    expect(world.terrainRevision).toBe(6);
  });

  it("relocates an occupying villager to the same nearest northern land cell on replay", () => {
    const first = createWorld(42);
    const replay = createWorld(42);
    first.villagers.push({ id: "villager-1", position: { x: 645, y: 605 } });
    replay.villagers.push({ id: "villager-1", position: { x: 645, y: 605 } });
    const command = {
      type: "paint" as const,
      terrain: "water" as const,
      point: { x: 645, y: 605 },
      radius: CELL_SIZE,
    };

    expect(paintTerrain(first, command).ok).toBe(true);
    expect(paintTerrain(replay, command).ok).toBe(true);
    expect(first.villagers[0]?.position).toEqual({ x: 645, y: 585 });
    expect(replay.villagers[0]?.position).toEqual(first.villagers[0]?.position);
  });

  it("keeps failed all-water edits atomic when no bounded relocation exists", () => {
    const world = createWorld(42);
    world.villagers.push({ id: "villager-1", position: { x: 645, y: 605 } });
    const before = world.terrain.slice();

    const result = paintTerrain(world, {
      type: "paint",
      terrain: "water",
      point: { x: 640, y: 430 },
      radius: 2_000,
    });

    expect(result.ok).toBe(false);
    expect(world.terrain).toEqual(before);
    expect(world.terrainRevision).toBe(0);
    expect(world.villagers[0]?.position).toEqual({ x: 645, y: 605 });
  });

  it("finds nearest land in stable north-east-south-west order and rejects out-of-world starts", () => {
    const world = createWorld(42);
    world.terrain.fill(TERRAIN_WATER);
    world.terrain[cellIndex({ x: 4, y: 3 })] = TERRAIN_LAND;
    world.terrain[cellIndex({ x: 5, y: 2 })] = TERRAIN_LAND;

    expect(findNearestLand(world, { x: 55, y: 35 }, 20)).toEqual({ x: 55, y: 25 });
    expect(findNearestLand(world, { x: -1, y: 10 }, 20)).toBeNull();
    expect(findNearestLand(world, { x: 55, y: 35 }, 1)).toBeNull();
  });

  it("caps each terrain relocation search at exactly 256 visited cells", () => {
    const world = createWorld(42);
    world.terrain.fill(TERRAIN_WATER);
    const start = cellToWorld({ x: 64, y: 43 });
    const distantLand = cellToWorld({ x: 84, y: 43 });
    world.terrain[cellIndex({ x: 84, y: 43 })] = TERRAIN_LAND;
    world.villagers = [{ id: "villager-1", position: start }];

    expect(findNearestLand(world, start, 256)).toBeNull();
    expect(findNearestLand(world, start, 4_096)).toEqual(distantLand);
    expect(paintTerrain(world, {
      type: "paint",
      terrain: "water",
      point: start,
      radius: 6,
    })).toMatchObject({ ok: false, error: { code: "no_relocation" } });
    expect(world.villagers[0]!.position).toEqual(start);
  });

  it("relocates flooded hostiles and removes flooded decor with one shared work budget", () => {
    const world = createWorld(42);
    world.terrain.fill(TERRAIN_WATER);
    world.terrain[cellIndex({ x: 5, y: 4 })] = TERRAIN_LAND;
    world.hostiles = [{ id: "hostile-1", position: cellToWorld({ x: 5, y: 5 }) }];
    world.trees = [{ id: "tree-1", position: cellToWorld({ x: 6, y: 5 }) }];

    expect(reconcileTerrainEntities(world, 0)).toEqual({
      ok: true,
      value: { relocatedHostiles: 1, removedTrees: 1 },
    });
    expect(world.hostiles[0]!.position).toEqual(cellToWorld({ x: 5, y: 4 }));
    expect(world.trees).toEqual([]);
  });

  it("rejects oversized terrain entity collections without truncating them", () => {
    const world = createWorld(42);
    world.hostiles = Array.from({ length: 4_097 }, (_, index) => ({
      id: `hostile-${index}`,
      position: cellToWorld({ x: 64, y: 60 }),
    }));
    const before = structuredClone(world.hostiles);

    expect(reconcileTerrainEntities(world, 0)).toMatchObject({
      ok: false,
      error: { code: "invalid_command" },
    });
    expect(world.hostiles).toEqual(before);
  });
});
