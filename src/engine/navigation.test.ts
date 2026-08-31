import { describe, expect, it } from "vitest";
import { GRID_HEIGHT, GRID_WIDTH, TERRAIN_LAND, TERRAIN_WATER } from "./constants";
import { cellIndex, cellToWorld, worldToCell } from "./geometry";
import { findPath } from "./navigation";
import { createWorld } from "./terrain";
import type { Point, WorldState } from "./types";

const allLandWorld = (): WorldState => {
  const world = createWorld(42);
  world.terrain.fill(TERRAIN_LAND);
  world.bridgeCells.fill(0);
  return world;
};

const expectPathOnTraversableCells = (world: WorldState, path: Point[]): void => {
  for (let segment = 1; segment < path.length; segment += 1) {
    const from = worldToCell(path[segment - 1]!);
    const to = worldToCell(path[segment]!);
    expect(from).not.toBeNull();
    expect(to).not.toBeNull();
    expect(from!.x === to!.x || from!.y === to!.y).toBe(true);
    const dx = Math.sign(to!.x - from!.x);
    const dy = Math.sign(to!.y - from!.y);
    let current = from!;
    while (true) {
      const index = cellIndex(current);
      expect(
        world.terrain[index] === TERRAIN_LAND || world.bridgeCells[index] === 1,
      ).toBe(true);
      if (current.x === to!.x && current.y === to!.y) break;
      current = { x: current.x + dx, y: current.y + dy };
    }
  }
};

describe("findPath", () => {
  it("routes around active wall segments through the nearest gate gap", () => {
    const world = allLandWorld();
    world.activeVillage = {
      seed: world.seed,
      anchor: cellToWorld({ x: 6, y: 4 }),
      roads: [],
      houses: [],
      bridges: [],
      wall: {
        polygon: [],
        gates: [],
        segments: [
          { start: { x: 45, y: 0 }, end: { x: 45, y: 30 } },
          { start: { x: 45, y: 40 }, end: { x: 45, y: 850 } },
        ],
      },
      villagers: [],
    };

    expect(findPath(
      world,
      cellToWorld({ x: 1, y: 4 }),
      cellToWorld({ x: 8, y: 4 }),
      512,
    )).toEqual([
      { x: 15, y: 45 },
      { x: 35, y: 45 },
      { x: 35, y: 35 },
      { x: 85, y: 35 },
      { x: 85, y: 45 },
    ]);
  });

  it("routes through destroyed wall segments", () => {
    const world = allLandWorld();
    world.activeVillage = {
      seed: world.seed,
      anchor: cellToWorld({ x: 6, y: 4 }),
      roads: [],
      houses: [],
      bridges: [],
      wall: {
        polygon: [],
        gates: [],
        segments: [
          { start: { x: 45, y: 0 }, end: { x: 45, y: 850 }, destroyed: true },
        ],
      },
      villagers: [],
    };

    expect(findPath(
      world,
      cellToWorld({ x: 1, y: 4 }),
      cellToWorld({ x: 8, y: 4 }),
      512,
    )).toEqual([
      { x: 15, y: 45 },
      { x: 85, y: 45 },
    ]);
  });

  it("returns the same simplified land-only route for the same query", () => {
    const world = allLandWorld();
    for (let y = 0; y < 6; y += 1) {
      if (y !== 4) world.terrain[cellIndex({ x: 4, y })] = TERRAIN_WATER;
    }
    const from = cellToWorld({ x: 1, y: 1 });
    const to = cellToWorld({ x: 8, y: 1 });

    const first = findPath(world, from, to, 512);
    const replay = findPath(world, from, to, 512);

    expect(first).toEqual(replay);
    expect(first).not.toBeNull();
    expect(first!.at(0)).toEqual({ x: 15, y: 15 });
    expect(first!.at(-1)).toEqual({ x: 85, y: 15 });
    expectPathOnTraversableCells(world, first!);
  });

  it("returns null when two land destinations have no traversable connection", () => {
    const world = allLandWorld();
    world.terrain.fill(TERRAIN_WATER);
    world.terrain[cellIndex({ x: 1, y: 1 })] = TERRAIN_LAND;
    world.terrain[cellIndex({ x: 3, y: 1 })] = TERRAIN_LAND;

    expect(findPath(
      world,
      cellToWorld({ x: 1, y: 1 }),
      cellToWorld({ x: 3, y: 1 }),
      512,
    )).toBeNull();
  });

  it("crosses water only when the generated bridge mask marks that cell", () => {
    const world = allLandWorld();
    for (let y = 0; y < GRID_HEIGHT; y += 1) {
      world.terrain[cellIndex({ x: 4, y })] = TERRAIN_WATER;
    }
    const from = cellToWorld({ x: 3, y: 1 });
    const to = cellToWorld({ x: 5, y: 1 });

    expect(findPath(world, from, to, 512)).toBeNull();
    world.bridgeCells[cellIndex({ x: 4, y: 1 })] = 1;
    expect(findPath(world, from, to, 512)).toEqual([
      { x: 35, y: 15 },
      { x: 55, y: 15 },
    ]);
  });

  it("routes around circular blocked areas", () => {
    const world = allLandWorld();
    const path = findPath(
      world,
      cellToWorld({ x: 1, y: 10 }),
      cellToWorld({ x: 9, y: 10 }),
      512,
      [{ center: { x: 55, y: 105 }, radius: 14 }],
    );

    expect(path).not.toBeNull();
    expect(path).not.toEqual([
      cellToWorld({ x: 1, y: 10 }),
      cellToWorld({ x: 9, y: 10 }),
    ]);
    expect(path!.some((point) => Math.hypot(point.x - 55, point.y - 105) <= 14)).toBe(false);
  });

  it("hard-caps an oversized search request at 4096 visited cells", () => {
    const world = allLandWorld();
    world.terrain.fill(TERRAIN_WATER);
    const corridorRows = Math.ceil(GRID_HEIGHT / 2);
    for (let corridor = 0; corridor < corridorRows; corridor += 1) {
      const y = corridor * 2;
      for (let x = 0; x < GRID_WIDTH; x += 1) {
        world.terrain[cellIndex({ x, y })] = TERRAIN_LAND;
      }
      if (corridor < corridorRows - 1) {
        const connectorX = corridor % 2 === 0 ? GRID_WIDTH - 1 : 0;
        world.terrain[cellIndex({ x: connectorX, y: y + 1 })] = TERRAIN_LAND;
      }
    }

    expect(findPath(
      world,
      cellToWorld({ x: 0, y: 0 }),
      cellToWorld({ x: GRID_WIDTH - 1, y: GRID_HEIGHT - 2 }),
      10_000,
    )).toBeNull();
  });

  it("rejects water endpoints, out-of-world endpoints, and non-positive limits", () => {
    const world = allLandWorld();
    world.terrain[cellIndex({ x: 2, y: 2 })] = TERRAIN_WATER;

    expect(findPath(
      world,
      cellToWorld({ x: 1, y: 1 }),
      cellToWorld({ x: 2, y: 2 }),
      50,
    )).toBeNull();
    expect(findPath(world, { x: -1, y: 10 }, { x: 15, y: 15 }, 50)).toBeNull();
    expect(findPath(world, { x: 15, y: 15 }, { x: 25, y: 15 }, 0)).toBeNull();
  });
});
