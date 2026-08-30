import { describe, expect, it } from "vitest";
import { createWorld } from "./terrain";
import type { House, Road, Villager, VillagerTask, WorldState } from "./types";
import { updateIdleWandering, WANDERING_LIMITS } from "./wandering";

const point = (x: number, y: number) => ({ x, y });

const road = (): Road => ({
  id: "road-1",
  role: "spine",
  parentId: null,
  points: [point(105, 105), point(205, 105), point(205, 205)],
});

const house = (): House => ({
  id: "house-1",
  roadId: "road-1",
  position: point(105, 125),
  frontage: point(105, 105),
  facing: -Math.PI / 2,
  health: 100,
});

const villager = (
  id: string,
  x: number,
  y: number,
  status: Villager["status"] = "idle",
): Villager => ({
  id,
  position: point(x, y),
  health: status === "dead" ? 0 : 100,
  status,
});

const activeTask = (villagerId: string): VillagerTask => ({
  id: `task-${villagerId}`,
  villagerId,
  type: "relocate",
  destination: point(305, 105),
  path: [point(105, 105), point(305, 105)],
  pathIndex: 1,
  phase: "outbound",
  status: "active",
  sourcePlanId: "plan-1",
  source: "ai",
  createdAt: 0,
});

const flatVillageWorld = (): WorldState => {
  const world = createWorld(42);
  world.terrain.fill(1);
  world.riverLike.fill(0);
  world.trees = [];
  world.villagers = [
    villager("idle", 105, 105),
    villager("assigned", 115, 105),
    villager("sick", 125, 105, "sick"),
    villager("trapped", 135, 105, "trapped"),
    villager("dead", 145, 105, "dead"),
  ];
  world.villagerTasks = [activeTask("assigned")];
  world.activeVillage = {
    seed: 42,
    anchor: point(205, 105),
    roads: [road()],
    houses: [house()],
    bridges: [],
    wall: { polygon: [], segments: [], gates: [] },
    villagers: world.villagers,
  };
  return world;
};

describe("idle villager wandering", () => {
  it("moves only unassigned idle villagers after the deterministic start delay", () => {
    const world = flatVillageWorld();
    world.simulationTimeMs = WANDERING_LIMITS.startDelayMs;
    const before = structuredClone(world.villagers);

    expect(updateIdleWandering(world, WANDERING_LIMITS.fixedStepMs)).toBe(true);

    expect(world.villagers.find((candidate) => candidate.id === "idle")!.position)
      .not.toEqual(before.find((candidate) => candidate.id === "idle")!.position);
    for (const id of ["assigned", "sick", "trapped", "dead"]) {
      expect(world.villagers.find((candidate) => candidate.id === id)!.position)
        .toEqual(before.find((candidate) => candidate.id === id)!.position);
    }
  });

  it("replays the same seed, ids, and time into identical idle movement", () => {
    const first = flatVillageWorld();
    const second = flatVillageWorld();

    for (let tick = 0; tick < 30; tick += 1) {
      first.simulationTimeMs += WANDERING_LIMITS.fixedStepMs;
      second.simulationTimeMs += WANDERING_LIMITS.fixedStepMs;
      updateIdleWandering(first, WANDERING_LIMITS.fixedStepMs);
      updateIdleWandering(second, WANDERING_LIMITS.fixedStepMs);
    }

    expect(second.villagers).toEqual(first.villagers);
  });

  it("continues away from the starting cell instead of oscillating around its center", () => {
    const world = flatVillageWorld();
    const start = { ...world.villagers.find((candidate) => candidate.id === "idle")!.position };

    for (let tick = 0; tick < 5; tick += 1) {
      world.simulationTimeMs = WANDERING_LIMITS.startDelayMs + tick * WANDERING_LIMITS.fixedStepMs;
      updateIdleWandering(world, WANDERING_LIMITS.fixedStepMs);
    }

    const position = world.villagers.find((candidate) => candidate.id === "idle")!.position;
    expect(Math.hypot(position.x - start.x, position.y - start.y)).toBeGreaterThan(4);
  });
});
