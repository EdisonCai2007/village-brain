import { describe, expect, it } from "vitest";
import {
  BANDIT_COUNT,
  EARTHQUAKE_RADIUS,
  FIRE_INITIAL_INTENSITY,
  FIRE_SPREAD_INTERVAL_MS,
  MAX_ACTIVE_BANDIT_EVENTS,
  MAX_BANDIT_PATHFINDS_PER_TICK,
  MAX_WORLD_EVENTS,
  MAX_FIRE_CELLS,
  MAX_PLAGUE_PARTICIPANTS,
  MAX_TSUNAMI_HITS,
  PLAGUE_EXPOSURE_MS,
  PLAGUE_INITIAL_RADIUS,
  TSUNAMI_LIFETIME_MS,
  TSUNAMI_SPEED,
  TSUNAMI_WIDTH,
} from "./constants";
import {
  ensureDisasterState,
  reconcileDisastersAfterVillageReplacement,
  reconcileDisastersAfterTerrain,
  resetTsunamiVillageHits,
  triggerDisaster,
  updateDisasters,
} from "./disasters";
import { cellIndex, cellToWorld, worldToCell } from "./geometry";
import { findPath } from "./navigation";
import { createWorld } from "./terrain";
import type {
  DisasterCommand,
  House,
  Villager,
  WorldState,
} from "./types";

const livingVillager = (id: string, x: number, y: number): Villager => ({
  id,
  position: { x, y },
  health: 100,
  status: "idle",
});

const house = (id: string, x: number, y: number): House => ({
  id,
  roadId: "road-1",
  position: { x, y },
  frontage: { x, y: y + 20 },
  facing: 0,
  health: 100,
  destroyed: false,
});

const flatWorld = (terrain: "land" | "water" = "land", seed = 7): WorldState => {
  const world = createWorld(seed);
  world.terrain.fill(terrain === "land" ? 1 : 0);
  world.riverLike.fill(0);
  world.trees = [];
  ensureDisasterState(world);
  return world;
};

const trigger = (
  world: WorldState,
  command: DisasterCommand,
  eventId = "event-1",
) => triggerDisaster(world, command, eventId);

describe("disaster placement", () => {
  it("limits tsunami lifetime to eight seconds", () => {
    expect(TSUNAMI_LIFETIME_MS).toBe(8_000);
  });

  it("bounds retained status records by pruning the oldest resolved event", () => {
    const world = flatWorld("land");
    world.events = Array.from({ length: MAX_WORLD_EVENTS }, (_, index) => ({
      id: `event-${index + 1}`,
      type: "earthquake" as const,
      origin: { x: 100, y: 100 },
      createdAt: index,
      updatedAt: index,
      status: "resolved" as const,
      severity: 0,
      facts: ["pulse:applied"],
    }));
    world.pits = world.events.map((event) => ({
      id: `${event.id}-pit-1`,
      eventId: event.id,
      position: { x: 100, y: 100 },
      radius: 14,
    }));
    world.villagers = [{
      ...livingVillager("trapped", 100, 100),
      status: "trapped",
      trappedByPitId: "event-1-pit-1",
    }];
    world.hostiles = [{
      id: "event-1-bandit-1",
      eventId: "event-1",
      position: { x: 100, y: 100 },
    }];
    world.plagueCases = [{
      eventId: "event-1",
      villagerId: "trapped",
      status: "recovered",
      infectedAt: 0,
    }];
    world.plagueExposures = [{
      eventId: "event-1",
      exposedVillagerId: "trapped",
      exposureMs: 500,
    }];

    const result = trigger(world, {
      type: "trigger_fire",
      point: { x: 205, y: 205 },
    }, "event-201");
    expect(result.ok).toBe(true);
    expect(world.events).toHaveLength(MAX_WORLD_EVENTS);
    expect(world.events[0]!.id).toBe("event-2");
    expect(world.events.at(-1)!.id).toBe("event-201");
    expect(world.pits.some((pit) => pit.eventId === "event-1")).toBe(false);
    expect(world.villagers[0]).toMatchObject({ status: "idle", trappedByPitId: undefined });
    expect(world.hostiles).toEqual([]);
    expect(world.plagueCases).toEqual([]);
    expect(world.plagueExposures).toEqual([]);
    if (result.ok) expect(result.value.unitChanged).toBe(true);
  });

  it("rejects ignition when the finite world fire-cell collection is full", () => {
    const world = flatWorld("land");
    world.fires = Array.from({ length: MAX_FIRE_CELLS }, (_, index) => ({
      id: `existing-fire-${index}`,
      eventId: "event-existing",
      cell: { x: index % 128, y: 1 },
      position: { x: index * 10 + 5, y: 15 },
      intensity: 100,
      createdAt: 0,
      lastSpreadAt: 0,
    }));

    expect(trigger(world, {
      type: "trigger_fire",
      point: { x: 205, y: 205 },
    }).ok).toBe(false);
    expect(world.fires).toHaveLength(MAX_FIRE_CELLS);
    expect(world.events).toEqual([]);
  });

  it("ignites land with the fixed initial intensity and rejects water atomically", () => {
    const land = flatWorld("land");
    const result = trigger(land, { type: "trigger_fire", point: { x: 205, y: 205 } });

    expect(result.ok).toBe(true);
    expect(land.fires).toEqual([expect.objectContaining({
      eventId: "event-1",
      intensity: FIRE_INITIAL_INTENSITY,
      createdAt: 0,
      lastSpreadAt: 0,
    })]);
    expect(land.events).toEqual([expect.objectContaining({
      id: "event-1",
      type: "fire",
      createdAt: 0,
      updatedAt: 0,
      status: "active",
      severity: 100,
    })]);

    const water = flatWorld("water");
    const before = structuredClone(water.events);
    expect(trigger(water, { type: "trigger_fire", point: { x: 205, y: 205 } }).ok)
      .toBe(false);
    expect(water.events).toEqual(before);
    expect(water.fires).toEqual([]);
  });

  it("starts a fixed-width, fixed-speed tsunami only on water and aims toward land", () => {
    const world = flatWorld("water");
    world.terrain[cellIndex(worldToCell({ x: 305, y: 205 })!)] = 1;

    const result = trigger(world, {
      type: "trigger_tsunami",
      point: { x: 105, y: 205 },
    });

    expect(result.ok).toBe(true);
    expect(world.tsunamis).toEqual([expect.objectContaining({
      eventId: "event-1",
      width: TSUNAMI_WIDTH,
      speed: TSUNAMI_SPEED,
      direction: { x: 1, y: 0 },
      ageMs: 0,
      hitEntityIds: [],
    })]);
    expect(trigger(world, {
      type: "trigger_tsunami",
      point: { x: 305, y: 205 },
    }, "event-2").ok).toBe(false);
    expect(world.events).toHaveLength(1);
  });

  it("spawns exactly four event-owned bandits on land", () => {
    const world = flatWorld("land");

    expect(trigger(world, {
      type: "trigger_bandits",
      point: { x: 405, y: 405 },
    }).ok).toBe(true);

    expect(world.hostiles).toHaveLength(BANDIT_COUNT);
    expect(world.hostiles.map((bandit) => bandit.id)).toEqual([
      "event-1-bandit-1",
      "event-1-bandit-2",
      "event-1-bandit-3",
      "event-1-bandit-4",
    ]);
    expect(world.hostiles.every((bandit) => bandit.eventId === "event-1")).toBe(true);
    expect(trigger(flatWorld("water"), {
      type: "trigger_bandits",
      point: { x: 405, y: 405 },
    }).ok).toBe(false);
  });

  it("applies one earthquake pulse in the fixed radius and creates no more than three land pits", () => {
    const world = flatWorld("land", 19);
    world.villagers = [livingVillager("villager-1", 405, 405)];
    world.activeVillage = {
      seed: 19,
      anchor: { x: 405, y: 405 },
      roads: [],
      houses: [house("house-near", 455, 405), house("house-far", 605, 405)],
      bridges: [],
      wall: { polygon: [], segments: [], gates: [] },
      villagers: world.villagers,
    };

    expect(trigger(world, {
      type: "trigger_earthquake",
      point: { x: 405, y: 405 },
    }).ok).toBe(true);

    expect(EARTHQUAKE_RADIUS).toBe(120);
    expect(world.activeVillage.houses[0]!.health).toBeLessThan(100);
    expect(world.activeVillage.houses[1]!.health).toBe(100);
    expect(world.pits.length).toBeGreaterThan(0);
    expect(world.pits.length).toBeLessThanOrEqual(3);
    expect(world.events[0]).toMatchObject({
      type: "earthquake",
      status: "active",
      facts: expect.arrayContaining(["pulse:applied"]),
    });
    const damageAfterPulse = world.activeVillage.houses[0]!.health;
    updateDisasters(world, 100);
    expect(world.activeVillage.houses[0]!.health).toBe(damageAfterPulse);
  });

  it("starts plague only when a living villager is in the fixed initial radius", () => {
    const world = flatWorld("land");
    world.villagers = [
      livingVillager("near", 190, 100),
      { ...livingVillager("dead", 100, 100), health: 0, status: "dead" },
    ];

    expect(trigger(world, {
      type: "trigger_plague",
      point: { x: 100, y: 100 },
    }).ok).toBe(true);
    expect(PLAGUE_INITIAL_RADIUS).toBe(90);
    expect(world.villagers[0]).toMatchObject({ status: "sick" });
    expect(world.villagers[1]).toMatchObject({ status: "dead" });

    const noLivingTarget = flatWorld("land");
    noLivingTarget.villagers = [{
      ...livingVillager("dead", 100, 100),
      health: 0,
      status: "dead",
    }];
    expect(trigger(noLivingTarget, {
      type: "trigger_plague",
      point: { x: 100, y: 100 },
    }).ok).toBe(false);
    expect(noLivingTarget.events).toEqual([]);
  });
});

describe("deterministic disaster lifecycles", () => {
  it("attempts fire spread only at 1500 ms boundaries and never creates fire on water", () => {
    const world = flatWorld("land", 42);
    const origin = { x: 205, y: 205 };
    expect(trigger(world, { type: "trigger_fire", point: origin }).ok).toBe(true);

    for (let tick = 0; tick < FIRE_SPREAD_INTERVAL_MS / 100 - 1; tick += 1) {
      updateDisasters(world, 100);
    }
    expect(world.fires).toHaveLength(1);
    updateDisasters(world, 100);
    expect(world.fires).toHaveLength(2);

    const originCell = worldToCell(origin)!;
    const waterCells = [
      { x: originCell.x + 1, y: originCell.y },
      { x: originCell.x - 1, y: originCell.y },
      { x: originCell.x, y: originCell.y + 1 },
      { x: originCell.x, y: originCell.y - 1 },
    ];
    const blocked = flatWorld("land", 42);
    for (const cell of waterCells) blocked.terrain[cellIndex(cell)] = 0;
    expect(trigger(blocked, { type: "trigger_fire", point: origin }).ok).toBe(true);
    for (let tick = 0; tick < 90; tick += 1) updateDisasters(blocked, 100);
    expect(blocked.fires).toHaveLength(1);
    expect(blocked.fires.every((fire) =>
      blocked.terrain[cellIndex(fire.cell)] === 1)).toBe(true);
  });

  it("damages nearby houses, roads, and wall segments from active fire cells", () => {
    const world = flatWorld("land", 42);
    world.activeVillage = {
      seed: 42,
      anchor: { x: 405, y: 405 },
      roads: [{
        id: "road-near",
        role: "spine",
        parentId: null,
        points: [{ x: 205, y: 205 }, { x: 305, y: 205 }],
      }, {
        id: "road-far",
        role: "branch",
        parentId: "road-near",
        points: [{ x: 405, y: 405 }, { x: 505, y: 405 }],
      }],
      houses: [house("house-near", 205, 205), house("house-far", 405, 405)],
      bridges: [],
      wall: {
        polygon: [],
        gates: [],
        segments: [{ start: { x: 205, y: 195 }, end: { x: 205, y: 215 } }],
      },
      villagers: [],
    };

    expect(trigger(world, { type: "trigger_fire", point: { x: 205, y: 205 } }).ok).toBe(true);
    const outcome = updateDisasters(world, 100);

    expect(world.activeVillage.houses[0]).toMatchObject({ health: 95, destroyed: false });
    expect(world.activeVillage.houses[1]).toMatchObject({ health: 100, destroyed: false });
    expect(world.activeVillage.roads[0]).toMatchObject({
      health: 95,
      damaged: true,
      rebuildProgress: expect.closeTo(0.95, 5),
    });
    expect(world.activeVillage.roads[1]!.damaged).not.toBe(true);
    expect(world.activeVillage.wall.segments[0]).toMatchObject({
      health: 95,
      rebuildProgress: expect.closeTo(0.95, 5),
    });
    expect(world.activeVillage.wall.segments[0]!.destroyed).not.toBe(true);
    expect(outcome.structureChanged).toBe(true);

    for (let tick = 0; tick < 19; tick += 1) updateDisasters(world, 100);

    expect(world.activeVillage.houses[0]).toMatchObject({ health: 0, destroyed: true });
    expect(world.activeVillage.roads[0]).toMatchObject({ health: 0, damaged: true });
    expect(world.activeVillage.wall.segments[0]).toMatchObject({
      health: 0,
      destroyed: true,
      rebuildProgress: 0,
    });
  });

  it("never lets a zero-intensity fire spread or damage and resolves without positive cells", () => {
    const world = flatWorld("land", 42);
    world.activeVillage = {
      seed: 42,
      anchor: { x: 405, y: 405 },
      roads: [],
      houses: [house("house-1", 205, 205)],
      bridges: [],
      wall: { polygon: [], segments: [], gates: [] },
      villagers: [],
    };
    expect(trigger(world, { type: "trigger_fire", point: { x: 205, y: 205 } }).ok).toBe(true);
    world.fires[0]!.intensity = 0;

    for (let tick = 0; tick < 15; tick += 1) updateDisasters(world, 100);

    expect(world.fires).toEqual([]);
    expect(world.activeVillage.houses[0]).toMatchObject({ health: 100, destroyed: false });
    expect(world.events[0]).toMatchObject({ status: "resolved", severity: 0 });
  });

  it("keeps fire-cell IDs lifetime-unique after a middle cell is extinguished", () => {
    const world = flatWorld("land", 42);
    expect(trigger(world, { type: "trigger_fire", point: { x: 205, y: 205 } }).ok).toBe(true);
    for (let tick = 0; tick < 60 && world.fires.length < 3; tick += 1) {
      updateDisasters(world, 100);
    }
    expect(world.fires.length).toBeGreaterThanOrEqual(3);
    const originalIds = new Set(world.fires.map((fire) => fire.id));
    const maximumOriginalSequence = Math.max(...world.fires.map((fire) =>
      Number(fire.id.match(/-fire-(\d+)$/)![1])));
    world.fires[1]!.intensity = 0;
    for (let tick = 0; tick < 30 && world.fires.length <= originalIds.size; tick += 1) {
      updateDisasters(world, 100);
    }

    const ids = world.fires.map((fire) => fire.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => Number(id.match(/-fire-(\d+)$/)![1]) > maximumOriginalSequence))
      .toBe(true);
  });

  it("continues spreading beyond the previous small fire-cell cap", () => {
    const world = flatWorld("land", 42);
    expect(trigger(world, { type: "trigger_fire", point: { x: 205, y: 205 } }).ok).toBe(true);

    for (let tick = 0; tick < 220 && world.fires.length <= 96; tick += 1) {
      updateDisasters(world, 100);
    }

    expect(world.fires.length).toBeGreaterThan(96);
  });

  it("reconciles water fire/pits and invalidates bandit routes with truthful flags", () => {
    const world = flatWorld("land", 314);
    world.villagers = [livingVillager("trapped", 405, 405)];
    expect(trigger(world, { type: "trigger_fire", point: { x: 205, y: 205 } }, "event-1").ok)
      .toBe(true);
    expect(trigger(world, {
      type: "trigger_earthquake",
      point: { x: 405, y: 405 },
    }, "event-2").ok).toBe(true);
    world.hostiles = [{
      id: "event-3-bandit-1",
      eventId: "event-3",
      position: { x: 105, y: 105 },
      path: [{ x: 105, y: 105 }, { x: 905, y: 105 }],
      pathIndex: 1,
      lastPathAt: 0,
    }];
    world.terrain[cellIndex(world.fires[0]!.cell)] = 0;
    for (const pit of world.pits) world.terrain[cellIndex(worldToCell(pit.position)!)] = 0;

    const outcome = reconcileDisastersAfterTerrain(world);

    expect(world.fires).toEqual([]);
    expect(world.pits).toEqual([]);
    expect(world.villagers[0]).toMatchObject({ status: "idle", trappedByPitId: undefined });
    expect(world.hostiles[0]).toMatchObject({ path: [], pathIndex: 0 });
    expect(outcome).toMatchObject({ hazardChanged: true, unitChanged: true });
    expect(outcome.resolvedEventIds.sort()).toEqual(["event-1", "event-2"]);
  });

  it("moves a tsunami at 42 units per second, damages each object once, and despawns when resolved", () => {
    const world = flatWorld("water");
    world.terrain[cellIndex(worldToCell({ x: 305, y: 205 })!)] = 1;
    world.villagers = [livingVillager("villager-1", 135, 205)];
    world.trees = [{ id: "tree-1", position: { x: 135, y: 210 } }];
    world.activeVillage = {
      seed: 7,
      anchor: { x: 305, y: 205 },
      roads: [],
      houses: [house("house-1", 135, 195)],
      bridges: [],
      wall: { polygon: [], segments: [], gates: [] },
      villagers: world.villagers,
    };
    expect(trigger(world, {
      type: "trigger_tsunami",
      point: { x: 105, y: 205 },
    }).ok).toBe(true);

    for (let tick = 0; tick < 10; tick += 1) updateDisasters(world, 100);
    expect(world.tsunamis[0]!.position.x).toBeCloseTo(147, 8);
    expect(world.villagers[0]).toMatchObject({ health: 0, status: "dead" });
    expect(world.activeVillage.houses[0]).toMatchObject({
      id: "house-1",
      health: 0,
      destroyed: true,
      rebuildProgress: 0,
    });
    expect(world.trees).toEqual([]);
    const hits = [...world.tsunamis[0]!.hitEntityIds];
    for (let tick = 0; tick < 10; tick += 1) updateDisasters(world, 100);
    expect(world.tsunamis[0]!.hitEntityIds).toEqual(hits);
    expect(new Set(hits).size).toBe(hits.length);
    expect(world.activeVillage.houses[0]).toMatchObject({ destroyed: true });

    while (world.simulationTimeMs < TSUNAMI_LIFETIME_MS) {
      updateDisasters(world, 100);
    }
    expect(world.events[0]).toMatchObject({ status: "resolved", updatedAt: TSUNAMI_LIFETIME_MS });
    expect(world.tsunamis).toEqual([]);
  });

  it("washes out fires swept by the tsunami front", () => {
    const world = flatWorld("water");
    world.terrain[cellIndex(worldToCell({ x: 205, y: 205 })!)] = 1;
    world.terrain[cellIndex(worldToCell({ x: 305, y: 205 })!)] = 1;
    expect(trigger(world, { type: "trigger_fire", point: { x: 205, y: 205 } }, "event-1").ok).toBe(true);
    world.fires[0]!.lastSpreadAt = Number.POSITIVE_INFINITY;
    expect(trigger(world, { type: "trigger_tsunami", point: { x: 105, y: 205 } }, "event-2").ok).toBe(true);

    for (let tick = 0; tick < 25; tick += 1) updateDisasters(world, 100);

    expect(world.fires).toEqual([]);
    expect(world.events.find((event) => event.id === "event-1")).toMatchObject({
      status: "resolved",
      severity: 0,
    });
  });

  it("names tsunami hits by entity kind so equal raw IDs are each damaged once", () => {
    const world = flatWorld("water");
    world.terrain[cellIndex(worldToCell({ x: 305, y: 205 })!)] = 1;
    world.villagers = [livingVillager("dup", 125, 205)];
    world.trees = [{ id: "dup", position: { x: 125, y: 205 } }];
    expect(trigger(world, {
      type: "trigger_tsunami",
      point: { x: 105, y: 205 },
    }).ok).toBe(true);

    for (let tick = 0; tick < 10; tick += 1) updateDisasters(world, 100);

    expect(world.villagers[0]!.status).toBe("dead");
    expect(world.trees).toEqual([]);
    expect(world.tsunamis[0]!.hitEntityIds).toEqual(expect.arrayContaining([
      "villager:dup",
      "tree:dup",
    ]));
  });

  it("hits road and wall segments crossing the swept band even when endpoints are outside", () => {
    const world = flatWorld("water");
    world.terrain[cellIndex(worldToCell({ x: 305, y: 205 })!)] = 1;
    world.activeVillage = {
      seed: 7,
      anchor: { x: 305, y: 205 },
      roads: [{
        id: "road-crossing",
        role: "spine",
        parentId: null,
        points: [{ x: 125, y: 50 }, { x: 125, y: 350 }],
      }],
      houses: [],
      bridges: [{
        id: "bridge-road-crossing-1",
        roadId: "road-crossing",
        start: { x: 125, y: 190 },
        end: { x: 125, y: 210 },
        center: { x: 125, y: 200 },
        angle: Math.PI / 2,
        length: 20,
        cells: [{ x: 12, y: 20 }],
      }],
      wall: {
        polygon: [],
        gates: [],
        segments: [{ start: { x: 130, y: 50 }, end: { x: 130, y: 350 } }],
      },
      villagers: [],
    };
    expect(trigger(world, {
      type: "trigger_tsunami",
      point: { x: 105, y: 205 },
    }).ok).toBe(true);
    world.bridgeCells[cellIndex({ x: 12, y: 20 })] = 1;

    for (let tick = 0; tick < 10; tick += 1) updateDisasters(world, 100);

    expect(world.activeVillage.roads[0]).toMatchObject({
      id: "road-crossing",
      damaged: true,
      rebuildProgress: 0,
    });
    expect(world.activeVillage.bridges).toHaveLength(1);
    expect(world.bridgeCells[cellIndex({ x: 12, y: 20 })]).toBe(1);
    expect(world.activeVillage.wall.segments[0]).toMatchObject({
      destroyed: true,
      rebuildProgress: 0,
    });
  });

  it("stores destroyed wall segments while removing them from the pathfinding map", () => {
    const world = flatWorld("land");
    world.activeVillage = {
      seed: 7,
      anchor: cellToWorld({ x: 6, y: 4 }),
      roads: [],
      houses: [],
      bridges: [],
      wall: {
        polygon: [],
        gates: [],
        segments: [{ start: { x: 45, y: 0 }, end: { x: 45, y: 850 } }],
      },
      villagers: [],
    };

    expect(findPath(
      world,
      cellToWorld({ x: 1, y: 4 }),
      cellToWorld({ x: 8, y: 4 }),
      512,
    )).not.toEqual([
      { x: 15, y: 45 },
      { x: 85, y: 45 },
    ]);
    expect(trigger(world, {
      type: "trigger_earthquake",
      point: { x: 45, y: 45 },
    }).ok).toBe(true);

    expect(world.activeVillage.wall.segments).toEqual([{
      start: { x: 45, y: 0 },
      end: { x: 45, y: 850 },
      destroyed: true,
      rebuildProgress: 0,
    }]);
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

  it("resets village-bound hit identities for replacement objects without forgetting other hits", () => {
    const world = flatWorld("water");
    world.terrain[cellIndex(worldToCell({ x: 305, y: 205 })!)] = 1;
    world.activeVillage = {
      seed: 7,
      anchor: { x: 305, y: 205 },
      roads: [],
      houses: [house("house-1", 125, 205)],
      bridges: [],
      wall: { polygon: [], segments: [], gates: [] },
      villagers: [],
    };
    expect(trigger(world, {
      type: "trigger_tsunami",
      point: { x: 105, y: 205 },
    }).ok).toBe(true);
    for (let tick = 0; tick < 10; tick += 1) updateDisasters(world, 100);
    world.tsunamis[0]!.hitEntityIds.push("tree:persistent");
    world.activeVillage.houses = [house("house-1", 145, 205)];

    expect(resetTsunamiVillageHits(world)).toBe(true);
    expect(world.tsunamis[0]!.hitEntityIds).toEqual(["tree:persistent"]);
    for (let tick = 0; tick < 10; tick += 1) updateDisasters(world, 100);
    expect(world.activeVillage.houses[0]).toMatchObject({
      id: "house-1",
      health: 0,
      destroyed: true,
      rebuildProgress: 0,
    });
  });

  it("rejects a tsunami whose accepted collision population exceeds its fixed hit cap", () => {
    const world = flatWorld("water");
    world.terrain[cellIndex(worldToCell({ x: 305, y: 205 })!)] = 1;
    world.trees = Array.from({ length: MAX_TSUNAMI_HITS + 1 }, (_, index) => ({
      id: `tree-${index}`,
      position: { x: 125, y: 205 },
    }));

    expect(trigger(world, {
      type: "trigger_tsunami",
      point: { x: 105, y: 205 },
    }).ok).toBe(false);
    expect(world.events).toEqual([]);
  });

  it("recomputes bandit paths no more than once a second while pursuing and attacking", () => {
    const world = flatWorld("land");
    world.villagers = [livingVillager("target", 205, 105)];
    expect(trigger(world, {
      type: "trigger_bandits",
      point: { x: 105, y: 105 },
    }).ok).toBe(true);

    updateDisasters(world, 100);
    const firstPathAt = world.hostiles[0]!.lastPathAt!;
    const firstX = world.hostiles[0]!.position.x;
    for (let tick = 0; tick < 8; tick += 1) updateDisasters(world, 100);
    expect(world.hostiles[0]!.lastPathAt).toBe(firstPathAt);
    expect(world.hostiles[0]!.position.x).toBeGreaterThan(firstX);
    while (world.hostiles[0]!.lastPathAt === firstPathAt) updateDisasters(world, 100);
    expect(world.hostiles[0]!.lastPathAt! - firstPathAt).toBeGreaterThanOrEqual(1_000);

    for (let tick = 0; tick < 50; tick += 1) updateDisasters(world, 100);
    expect(world.villagers[0]!.health).toBeLessThan(100);
  });

  it("does not direct-move bandits when bounded navigation finds no route", () => {
    const world = flatWorld("land");
    for (let y = 0; y < 86; y += 1) world.terrain[cellIndex({ x: 15, y })] = 0;
    world.villagers = [livingVillager("target", 205, 105)];
    expect(trigger(world, {
      type: "trigger_bandits",
      point: { x: 105, y: 105 },
    }).ok).toBe(true);
    const starts = world.hostiles.map((hostile) => structuredClone(hostile.position));

    const beforeHostiles = structuredClone(world.hostiles);
    const first = updateDisasters(world, 100);
    expect(first.unitChanged).toBe(true);
    expect(world.hostiles).not.toEqual(beforeHostiles);
    expect(world.hostiles.map((hostile) => hostile.position)).toEqual(starts);
    for (let tick = 1; tick < 30; tick += 1) updateDisasters(world, 100);

    expect(world.hostiles.map((hostile) => hostile.position)).toEqual(starts);
    expect(world.hostiles.every((hostile) => hostile.path?.length === 0)).toBe(true);
  });

  it("reports hostile attack-timer mutations as unit changes even for structure targets", () => {
    const world = flatWorld("land");
    world.activeVillage = {
      seed: 7,
      anchor: { x: 405, y: 405 },
      roads: [],
      houses: [house("target-house", 105, 105)],
      bridges: [],
      wall: { polygon: [], segments: [], gates: [] },
      villagers: [],
    };
    world.events = [{
      id: "event-1",
      type: "bandits",
      origin: { x: 105, y: 105 },
      createdAt: 0,
      updatedAt: 0,
      status: "active",
      severity: 60,
      facts: ["hostiles:1", "pathIntervalMs:1000"],
    }];
    world.hostiles = [{
      id: "event-1-bandit-1",
      eventId: "event-1",
      position: { x: 105, y: 105 },
      targetId: "target-house",
      path: [],
      pathIndex: 0,
      lastPathAt: 0,
      lastAttackAt: Number.NEGATIVE_INFINITY,
    }];
    const beforeHostile = structuredClone(world.hostiles[0]);

    const outcome = updateDisasters(world, 100);

    expect(world.hostiles[0]).not.toEqual(beforeHostile);
    expect(world.activeVillage.houses[0]!.health).toBeLessThan(100);
    expect(outcome).toMatchObject({ unitChanged: true, structureChanged: true });
  });

  it("resolves no-target bandit events and removes event-owned hostiles", () => {
    const world = flatWorld("land");
    expect(trigger(world, {
      type: "trigger_bandits",
      point: { x: 105, y: 105 },
    }).ok).toBe(true);

    const outcome = updateDisasters(world, 100);

    expect(world.events[0]!.status).toBe("resolved");
    expect(world.hostiles).toEqual([]);
    expect(outcome).toMatchObject({ hazardChanged: true, unitChanged: true });
    expect(outcome.resolvedEventIds).toEqual(["event-1"]);
  });

  it("caps active groups and shares a fair structural pathfinding budget per tick", () => {
    const world = flatWorld("land");
    world.villagers = [livingVillager("target", 905, 405)];
    for (let index = 0; index < MAX_ACTIVE_BANDIT_EVENTS; index += 1) {
      expect(trigger(world, {
        type: "trigger_bandits",
        point: { x: 105 + index * 10, y: 405 },
      }, `event-${index + 1}`).ok).toBe(true);
    }
    expect(trigger(world, {
      type: "trigger_bandits",
      point: { x: 305, y: 405 },
    }, `event-${MAX_ACTIVE_BANDIT_EVENTS + 1}`).ok).toBe(false);

    const stableIds = world.hostiles.map((hostile) => hostile.id).sort((a, b) => a.localeCompare(b));
    const first = updateDisasters(world, 100);
    expect(first.banditPathfinds).toBe(MAX_BANDIT_PATHFINDS_PER_TICK);
    expect(world.hostiles
      .filter((hostile) => Number.isFinite(hostile.lastPathAt))
      .map((hostile) => hostile.id).sort())
      .toEqual(stableIds.slice(0, MAX_BANDIT_PATHFINDS_PER_TICK).sort());
    let totalPathfinds = first.banditPathfinds;
    for (
      let tick = 1;
      tick < Math.ceil(world.hostiles.length / MAX_BANDIT_PATHFINDS_PER_TICK);
      tick += 1
    ) {
      const outcome = updateDisasters(world, 100);
      expect(outcome.banditPathfinds).toBeLessThanOrEqual(MAX_BANDIT_PATHFINDS_PER_TICK);
      totalPathfinds += outcome.banditPathfinds;
    }
    expect(totalPathfinds).toBe(world.hostiles.length);
    expect(world.hostiles.every((hostile) => Number.isFinite(hostile.lastPathAt))).toBe(true);
  });

  it("traps living villagers intersecting earthquake pits", () => {
    const world = flatWorld("land", 314);
    world.villagers = [livingVillager("at-epicenter", 405, 405)];

    expect(trigger(world, {
      type: "trigger_earthquake",
      point: { x: 405, y: 405 },
    }).ok).toBe(true);
    const containingPit = world.pits.find((pit) =>
      Math.hypot(pit.position.x - 405, pit.position.y - 405) <= pit.radius);
    expect(containingPit).toBeDefined();
    expect(world.villagers[0]).toMatchObject({
      status: "trapped",
      trappedByPitId: containingPit!.id,
    });
    expect(world.events[0]!.status).toBe("active");
    world.villagers[0]!.status = "idle";
    world.villagers[0]!.trappedByPitId = undefined;
    const retrap = updateDisasters(world, 100);
    expect(world.villagers[0]).toMatchObject({
      status: "trapped",
      trappedByPitId: containingPit!.id,
    });
    expect(world.events[0]!.status).toBe("active");
    expect(retrap.resolvedEventIds).toEqual([]);

    world.villagers[0]!.position = { x: 800, y: 800 };
    world.villagers[0]!.status = "idle";
    world.villagers[0]!.trappedByPitId = undefined;
    const outcome = updateDisasters(world, 100);
    expect(world.events[0]!.status).toBe("resolved");
    expect(outcome.resolvedEventIds).toEqual(["event-1"]);
    expect(world.pits.filter((pit) => pit.eventId === "event-1")).toEqual([]);
  });

  it("clears pits for an earthquake that resolves immediately without trapping anyone", () => {
    const world = flatWorld("land", 314);

    const result = trigger(world, {
      type: "trigger_earthquake",
      point: { x: 405, y: 405 },
    });

    expect(result.ok).toBe(true);
    expect(world.events[0]).toMatchObject({ status: "resolved", severity: 0 });
    expect(world.pits.filter((pit) => pit.eventId === "event-1")).toEqual([]);
  });

  it("reconciles replacement villagers with quake pits and clears old plague and bandit identity", () => {
    const world = flatWorld("land", 314);
    world.events = [
      {
        id: "quake",
        type: "earthquake",
        origin: { x: 405, y: 405 },
        createdAt: 0,
        updatedAt: 0,
        status: "active",
        severity: 85,
        facts: ["pulse:applied"],
      },
      {
        id: "plague",
        type: "plague",
        origin: { x: 405, y: 405 },
        createdAt: 0,
        updatedAt: 0,
        status: "active",
        severity: 70,
        facts: ["infected:1"],
      },
      {
        id: "bandits",
        type: "bandits",
        origin: { x: 105, y: 105 },
        createdAt: 0,
        updatedAt: 0,
        status: "active",
        severity: 60,
        facts: ["bandits:1"],
      },
    ];
    world.pits = [{
      id: "quake-pit-1",
      eventId: "quake",
      position: { x: 405, y: 405 },
      radius: 14,
    }];
    world.villagers = [livingVillager("villager-1", 405, 405)];
    world.plagueCases = [{
      eventId: "plague",
      villagerId: "villager-1",
      infectedAt: 0,
      status: "infected",
    }];
    world.plagueExposures = [{
      eventId: "plague",
      exposedVillagerId: "villager-1",
      exposureMs: 500,
    }];
    world.hostiles = [{
      id: "bandits-bandit-1",
      eventId: "bandits",
      position: { x: 105, y: 105 },
      targetId: "villager-1",
      path: [{ x: 105, y: 105 }, { x: 405, y: 405 }],
      pathIndex: 1,
      lastPathAt: 0,
    }];

    const outcome = reconcileDisastersAfterVillageReplacement(world);

    expect(world.villagers[0]).toMatchObject({
      id: "villager-1",
      status: "trapped",
      trappedByPitId: "quake-pit-1",
    });
    expect(world.events.find((event) => event.id === "quake")!.status).toBe("active");
    expect(world.events.find((event) => event.id === "plague")!.status).toBe("resolved");
    expect(world.plagueCases).toEqual([]);
    expect(world.plagueExposures).toEqual([]);
    expect(world.hostiles[0]).toMatchObject({
      targetId: undefined,
      path: [],
      pathIndex: 0,
      lastPathAt: Number.NEGATIVE_INFINITY,
    });
    expect(outcome).toMatchObject({ hazardChanged: true, unitChanged: true });
    expect(outcome.resolvedEventIds).toContain("plague");
    expect(outcome.updatedEventIds).toEqual(expect.arrayContaining(["quake", "bandits"]));
  });

  it("resolves replacement earthquakes with no traps and removes their pits", () => {
    const world = flatWorld("land", 314);
    world.events = [{
      id: "quake",
      type: "earthquake",
      origin: { x: 405, y: 405 },
      createdAt: 0,
      updatedAt: 0,
      status: "active",
      severity: 85,
      facts: ["pulse:applied"],
    }];
    world.pits = [{
      id: "quake-pit-1",
      eventId: "quake",
      position: { x: 405, y: 405 },
      radius: 14,
    }];
    world.villagers = [livingVillager("new-villager", 800, 800)];

    const outcome = reconcileDisastersAfterVillageReplacement(world);

    expect(world.events[0]!.status).toBe("resolved");
    expect(world.pits).toEqual([]);
    expect(outcome.resolvedEventIds).toEqual(["quake"]);
  });

  it("requires continuous plague proximity exposure, excludes far villagers, and resolves after recovery", () => {
    const world = flatWorld("land", 19);
    world.villagers = [
      livingVillager("source", 100, 100),
      livingVillager("near", 130, 100),
      livingVillager("far", 300, 100),
    ];
    expect(trigger(world, {
      type: "trigger_plague",
      point: { x: 10, y: 100 },
    }).ok).toBe(true);

    for (let tick = 0; tick < PLAGUE_EXPOSURE_MS / 100 - 1; tick += 1) {
      updateDisasters(world, 100);
    }
    expect(world.villagers[1]!.status).toBe("idle");
    updateDisasters(world, 100);
    expect(world.villagers[1]).toMatchObject({ status: "sick" });
    expect(world.villagers[2]!.status).toBe("idle");

    for (let tick = 0; tick < 70; tick += 1) updateDisasters(world, 100);
    expect(world.villagers.every((villager) => villager.status !== "sick")).toBe(true);
    expect(world.events[0]!.status).toBe("resolved");
  });

  it("keeps concurrent plague infections event-scoped so one can resolve while another remains", () => {
    const world = flatWorld("land", 19);
    world.villagers = [livingVillager("shared", 100, 100)];
    expect(trigger(world, {
      type: "trigger_plague",
      point: { x: 100, y: 100 },
    }, "event-1").ok).toBe(true);
    for (let tick = 0; tick < 10; tick += 1) updateDisasters(world, 100);
    expect(trigger(world, {
      type: "trigger_plague",
      point: { x: 100, y: 100 },
    }, "event-2").ok).toBe(true);

    for (let tick = 0; tick < 40; tick += 1) updateDisasters(world, 100);

    expect(world.events.find((event) => event.id === "event-1")!.status).toBe("resolved");
    expect(world.events.find((event) => event.id === "event-2")!.status).toBe("active");
    expect(world.villagers[0]!.status).toBe("sick");
    expect(world.plagueCases.filter((plagueCase) => plagueCase.villagerId === "shared"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ eventId: "event-1", status: "recovered" }),
        expect.objectContaining({ eventId: "event-2", status: "infected" }),
      ]));
  });

  it("continues exposure when proximity switches between infectious sources for one event", () => {
    const world = flatWorld("land", 7);
    world.villagers = [
      livingVillager("source-a", 100, 100),
      livingVillager("source-b", 300, 100),
      livingVillager("target", 130, 100),
    ];
    expect(trigger(world, {
      type: "trigger_plague",
      point: { x: 10, y: 100 },
    }).ok).toBe(true);
    const secondSource = world.plagueCases.find((plagueCase) =>
      plagueCase.villagerId === "source-b")!;
    secondSource.status = "infected";
    secondSource.infectedAt = 0;
    for (let tick = 0; tick < 5; tick += 1) updateDisasters(world, 100);
    world.villagers.find((villager) => villager.id === "target")!.position = { x: 270, y: 100 };

    for (let tick = 0; tick < 5; tick += 1) updateDisasters(world, 100);

    expect(world.plagueCases.find((plagueCase) => plagueCase.villagerId === "target"))
      .toMatchObject({ status: "infected", infectedAt: 1_000 });
  });

  it("uses a closest stable bounded cohort so every accepted pair fits the explicit budget", () => {
    const world = flatWorld("land", 7);
    world.villagers = [livingVillager("source", 100, 100)];
    for (let index = 0; index < MAX_PLAGUE_PARTICIPANTS; index += 1) {
      world.villagers.push(livingVillager(`candidate-${String(index).padStart(2, "0")}`, 130, 100));
    }
    expect(trigger(world, {
      type: "trigger_plague",
      point: { x: 10, y: 100 },
    }).ok).toBe(true);
    expect(world.plagueCases.filter((plagueCase) => plagueCase.eventId === "event-1"))
      .toHaveLength(MAX_PLAGUE_PARTICIPANTS);

    const outcome = updateDisasters(world, 100);

    expect(outcome.plaguePairChecks).toBeLessThanOrEqual(4_096);
    expect(outcome.hazardChanged).toBe(true);
    expect(world.plagueExposures.filter((exposure) => exposure.eventId === "event-1"))
      .toHaveLength(MAX_PLAGUE_PARTICIPANTS - 1);
  });

  it("reports exposure-only plague progress as hazard state without a unit revision", () => {
    const world = flatWorld("land", 7);
    world.villagers = [
      livingVillager("source", 100, 100),
      livingVillager("target", 130, 100),
    ];
    expect(trigger(world, {
      type: "trigger_plague",
      point: { x: 10, y: 100 },
    }).ok).toBe(true);
    const beforeVillagers = structuredClone(world.villagers);
    const beforeExposures = structuredClone(world.plagueExposures);

    const outcome = updateDisasters(world, 100);

    expect(world.villagers).toEqual(beforeVillagers);
    expect(world.plagueExposures).not.toEqual(beforeExposures);
    expect(outcome).toMatchObject({ hazardChanged: true, unitChanged: false });
  });

  it("replays the same seed and ordered triggers into identical event and damage snapshots", () => {
    const replay = (): unknown => {
      const world = flatWorld("land", 42);
      world.villagers = [livingVillager("villager-1", 405, 405)];
      world.activeVillage = {
        seed: 42,
        anchor: { x: 405, y: 405 },
        roads: [],
        houses: [house("house-1", 455, 405)],
        bridges: [],
        wall: { polygon: [], segments: [], gates: [] },
        villagers: world.villagers,
      };
      trigger(world, { type: "trigger_fire", point: { x: 205, y: 205 } }, "event-1");
      trigger(world, { type: "trigger_bandits", point: { x: 305, y: 405 } }, "event-2");
      trigger(world, { type: "trigger_earthquake", point: { x: 405, y: 405 } }, "event-3");
      for (let tick = 0; tick < 30; tick += 1) updateDisasters(world, 100);
      return {
        randomState: world.random.state,
        events: world.events,
        fires: world.fires,
        hostiles: world.hostiles,
        pits: world.pits,
        villagers: world.villagers,
        houses: world.activeVillage?.houses,
      };
    };

    expect(replay()).toEqual(replay());
  });
});
