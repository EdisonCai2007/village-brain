import { describe, expect, it } from "vitest";

import { GRID_HEIGHT, GRID_WIDTH, TERRAIN_LAND, TERRAIN_WATER } from "./constants";
import {
  cellIndex,
  cellToWorld,
  pointInPolygon,
  pointSegmentDistance,
  worldToCell,
} from "./geometry";
import { createWorld, paintTerrain } from "./terrain";
import type { Point, Road, VillageState, WorldState } from "./types";
import {
  MAX_RESIDENTS_PER_HOUSE,
  MIN_RESIDENTS_PER_HOUSE,
} from "./house-residents";
import { generateVillage, traceSegmentCells } from "./village";

const DEFAULT_ANCHOR = { x: 640, y: 560 } as const;
const SEEDS = [1, 7, 19, 42, 314] as const;

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

const expectLandPoint = (world: WorldState, point: Point): void => {
  const cell = worldToCell(point);
  expect(cell).not.toBeNull();
  expect(world.terrain[cellIndex(cell!)]).toBe(TERRAIN_LAND);
};

const expectLandSegment = (world: WorldState, start: Point, end: Point): void => {
  const cells = traceSegmentCells(start, end);
  expect(cells.length).toBeGreaterThan(0);
  for (const cell of cells) expect(world.terrain[cellIndex(cell)]).toBe(TERRAIN_LAND);
};

const expectConstructionContract = (world: WorldState, village: VillageState): void => {
  expect(village.houses.length).toBeGreaterThanOrEqual(6);
  expect(village.villagers.length).toBeGreaterThanOrEqual(village.houses.length * MIN_RESIDENTS_PER_HOUSE);
  expect(village.villagers.length).toBeLessThanOrEqual(village.houses.length * MAX_RESIDENTS_PER_HOUSE);
  expect(village.wall.polygon.length).toBeGreaterThanOrEqual(3);
  expect(village.wall.segments.length).toBeGreaterThan(0);
  expect(village.wall.gates.length).toBeGreaterThan(0);
  expectLandPoint(world, village.anchor);
  expect(pointInPolygon(village.anchor, village.wall.polygon)).toBe(true);

  const roadById = new Map(village.roads.map((road) => [road.id, road]));
  expect(roadById.size).toBe(village.roads.length);
  for (const road of village.roads) {
    expect(road.points.length).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < road.points.length; index += 1) {
      expectLandSegment(world, road.points[index - 1]!, road.points[index]!);
    }
    if (road.parentId === null) {
      expect(distanceToRoad(village.anchor, road)).toBeLessThan(0.001);
    } else {
      const parent = roadById.get(road.parentId);
      expect(parent).toBeDefined();
      expect(distanceToRoad(road.points[0]!, parent!)).toBeLessThan(0.001);
    }
  }

  for (const house of village.houses) {
    const road = roadById.get(house.roadId);
    expect(road).toBeDefined();
    expect(distanceToRoad(house.frontage, road!)).toBeLessThan(0.001);
    expectLandPoint(world, house.position);
    expect(pointInPolygon(house.position, village.wall.polygon)).toBe(true);
    const residentCount = village.villagers.filter((villager) => villager.houseId === house.id).length;
    expect(residentCount).toBeGreaterThanOrEqual(MIN_RESIDENTS_PER_HOUSE);
    expect(residentCount).toBeLessThanOrEqual(MAX_RESIDENTS_PER_HOUSE);
  }
  for (const villager of village.villagers) expectLandPoint(world, villager.position);
  for (const segment of village.wall.segments) expectLandSegment(world, segment.start, segment.end);
};

const findWaterPoint = (world: WorldState): Point => {
  const index = world.terrain.findIndex((value) => value === TERRAIN_WATER);
  return cellToWorld({ x: index % GRID_WIDTH, y: Math.floor(index / GRID_WIDTH) });
};

describe("terrain-first village generation", () => {
  it.each(SEEDS)("is deterministic and satisfies the construction contract for seed %i", (seed) => {
    const world = createWorld(seed);
    const replayWorld = createWorld(seed);
    const result = generateVillage(world, DEFAULT_ANCHOR, seed);
    const replay = generateVillage(replayWorld, DEFAULT_ANCHOR, seed);

    expect(result.ok).toBe(true);
    expect(replay).toEqual(result);
    if (!result.ok) return;
    expect(world.activeVillage).toEqual(result.value);
    expect(world.villagers).toEqual(result.value.villagers);
    expectConstructionContract(world, result.value);
  });

  it("uses the exact requested point and grows inward from a nearby shoreline", () => {
    const world = createWorld(77);
    world.terrain.fill(TERRAIN_WATER);
    expect(paintTerrain(world, {
      type: "paint",
      terrain: "land",
      point: { x: 640, y: 430 },
      radius: 285,
    }).ok).toBe(true);
    const requested = { x: 850, y: 430 };

    const result = generateVillage(world, requested, 77);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.anchor).toEqual(requested);
    expectConstructionContract(world, result.value);
  });

  it("routes construction around an interior lake without modifying terrain", () => {
    const world = createWorld(91);
    world.terrain.fill(TERRAIN_LAND);
    expect(paintTerrain(world, {
      type: "paint",
      terrain: "water",
      point: { x: 720, y: 430 },
      radius: 72,
    }).ok).toBe(true);
    const terrain = world.terrain.slice();

    const result = generateVillage(world, { x: 560, y: 430 }, 91);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(world.terrain).toEqual(terrain);
    expectConstructionContract(world, result.value);
  });

  it("rejects water and truly cramped land without relocating the totem", () => {
    const waterWorld = createWorld(42);
    const waterResult = generateVillage(waterWorld, findWaterPoint(waterWorld), 42);
    expect(waterResult.ok).toBe(false);
    expect(waterWorld.activeVillage).toBeNull();

    const cramped = createWorld(42);
    cramped.terrain.fill(TERRAIN_WATER);
    expect(paintTerrain(cramped, {
      type: "paint",
      terrain: "land",
      point: DEFAULT_ANCHOR,
      radius: 58,
    }).ok).toBe(true);
    const crampedResult = generateVillage(cramped, DEFAULT_ANCHOR, 42);
    expect(crampedResult.ok).toBe(false);
    expect(cramped.activeVillage).toBeNull();
    expect(cramped.villagers).toEqual([]);
  });

  it("keeps all prior state after a failed replacement", () => {
    const world = createWorld(42);
    const placed = generateVillage(world, DEFAULT_ANCHOR, 42);
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    world.simulationTimeMs = 12_345;
    const previousVillage = structuredClone(world.activeVillage);
    const previousVillagers = structuredClone(world.villagers);
    const previousBridges = world.bridgeCells.slice();
    const previousTerrain = world.terrain.slice();

    const rejected = generateVillage(world, findWaterPoint(world), 7);

    expect(rejected.ok).toBe(false);
    expect(world.activeVillage).toEqual(previousVillage);
    expect(world.villagers).toEqual(previousVillagers);
    expect(world.bridgeCells).toEqual(previousBridges);
    expect(world.terrain).toEqual(previousTerrain);
    expect(world.simulationTimeMs).toBe(12_345);
  });

  it("atomically replaces a successful village while preserving terrain and time", () => {
    const world = createWorld(42);
    const first = generateVillage(world, DEFAULT_ANCHOR, 42);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    world.simulationTimeMs = 54_321;
    const terrain = world.terrain.slice();

    const second = generateVillage(world, { x: 790, y: 570 }, 314);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).not.toEqual(first.value);
    expect(world.activeVillage).toEqual(second.value);
    expect(world.villagers).toEqual(second.value.villagers);
    expect(world.terrain).toEqual(terrain);
    expect(world.simulationTimeMs).toBe(54_321);
  });

  it("traces every crossed grid cell for terrain-safe construction", () => {
    const cells = traceSegmentCells({ x: 15, y: 15 }, { x: 55, y: 55 });
    expect(cells).toContainEqual({ x: 2, y: 1 });
    expect(cells).toContainEqual({ x: 1, y: 2 });
    expect(cells.at(-1)).toEqual({ x: 5, y: 5 });
  });

  it("keeps generated roads within the world grid", () => {
    const world = createWorld(5);
    world.terrain.fill(TERRAIN_LAND);
    const result = generateVillage(world, { x: 220, y: 220 }, 5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const road of result.value.roads) {
      for (const point of road.points) {
        const cell = worldToCell(point);
        expect(cell).not.toBeNull();
        expect(cell!.x).toBeGreaterThanOrEqual(0);
        expect(cell!.x).toBeLessThan(GRID_WIDTH);
        expect(cell!.y).toBeGreaterThanOrEqual(0);
        expect(cell!.y).toBeLessThan(GRID_HEIGHT);
      }
    }
  });
});
