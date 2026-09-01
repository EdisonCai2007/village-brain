import { describe, expect, it } from "vitest";
import type { PlannerResponse } from "../shared/planner-contract";
import { CELL_SIZE } from "./constants";
import { ensureDisasterState } from "./disasters";
import { cellIndex, cellToWorld } from "./geometry";
import { residentCountForHouse } from "./house-residents";
import { findPath } from "./navigation";
import { createWorld } from "./terrain";
import {
  assignPlanTasks,
  TASK_LIMITS,
  updateVillagerTasks,
} from "./tasks";
import type {
  House,
  Road,
  Villager,
  WallSegment,
  WorldEvent,
  WorldState,
} from "./types";

const point = (x: number, y: number) => ({ x, y });

const villager = (
  id: string,
  x: number,
  y: number,
  status: Villager["status"] = "idle",
): Villager => ({ id, position: point(x, y), health: status === "dead" ? 0 : 100, status });

const house = (id: string, x: number, y: number): House => ({
  id,
  roadId: "road-1",
  position: point(x, y),
  frontage: point(x, y + 20),
  facing: 0,
  health: 100,
});

const event = (
  id: string,
  type: WorldEvent["type"],
  origin = point(405, 405),
): WorldEvent => ({
  id,
  type,
  origin,
  createdAt: 0,
  updatedAt: 0,
  status: "active",
  severity: 100,
  facts: [],
});

const flatWorld = (): WorldState => {
  const world = createWorld(42);
  world.terrain.fill(1);
  world.riverLike.fill(0);
  world.trees = [];
  ensureDisasterState(world);
  world.villagerTasks = [];
  world.planHistory = [];
  world.foundedAnchors = [];
  return world;
};

const establish = (world: WorldState, villagers: Villager[], anchor = point(205, 205)): void => {
  world.villagers = villagers;
  world.activeVillage = {
    seed: world.seed,
    anchor,
    roads: [],
    houses: [house("house-1", anchor.x, anchor.y)],
    bridges: [],
    wall: { polygon: [], segments: [], gates: [] },
    villagers,
  };
};

const response = (intents: PlannerResponse["intents"]): PlannerResponse => ({
  planId: "plan-1",
  summary: "Respond deterministically.",
  intents,
});

describe("strategic intent allocation", () => {
  it("rejects stale targets without reserving villagers", () => {
    const world = flatWorld();
    establish(world, [villager("villager-1", 300, 400)]);
    world.events = [{ ...event("event-old", "fire"), status: "resolved" }];

    const result = assignPlanTasks(world, response([{
      type: "fight_fire",
      targetEventId: "event-old",
      villagerCount: 1,
      priority: 1,
      rationale: "Contain it.",
    }]), "ai", 1);

    expect(result.assignedCount).toBe(0);
    expect(result.intentResults).toEqual([expect.objectContaining({
      requestedCount: 1,
      assignedCount: 0,
      reason: "stale_target",
    })]);
    expect(world.villagerTasks).toEqual([]);
  });

  it("clamps allocation, selects by distance then ID, and excludes unavailable villagers", () => {
    const world = flatWorld();
    establish(world, [
      villager("villager-b", 395, 405),
      villager("villager-a", 415, 405),
      villager("assigned", 405, 395),
      villager("trapped", 405, 415, "trapped"),
      villager("dead", 405, 425, "dead"),
    ]);
    world.events = [event("event-1", "fire")];
    world.fires = [{
      id: "event-1-fire-1",
      eventId: "event-1",
      cell: { x: 40, y: 40 },
      position: point(405, 405),
      intensity: 100,
      createdAt: 0,
      lastSpreadAt: 0,
    }];
    world.villagerTasks.push({
      id: "task-existing",
      villagerId: "assigned",
      type: "fight_fire",
      targetEventId: "event-1",
      destination: point(405, 405),
      path: [point(405, 395), point(405, 405)],
      pathIndex: 1,
      phase: "outbound",
      status: "active",
      sourcePlanId: "older-plan",
      source: "ai",
      createdAt: 0,
    });

    const result = assignPlanTasks(world, response([{
      type: "fight_fire",
      targetEventId: "event-1",
      villagerCount: 99,
      priority: 1,
      rationale: "Contain it.",
    }]), "fallback", 2);

    expect(result.assignedCount).toBe(1);
    expect(result.intentResults[0]).toMatchObject({ requestedCount: 99, assignedCount: 1, reason: "deployment_cap" });
    expect(world.villagerTasks.slice(1).map((task) => task.villagerId)).toEqual([
      "villager-a",
    ]);
    expect(world.villagerTasks.slice(1).every((task) =>
      task.source === "fallback" && task.sourcePlanId === "plan-1")).toBe(true);
  });

  it("never assigns one villager to two intents in the same plan", () => {
    const world = flatWorld();
    establish(world, [villager("villager-1", 390, 405), villager("villager-2", 380, 405)]);
    world.events = [event("event-fire", "fire"), event("event-bandits", "bandits")];
    world.fires = [{
      id: "event-fire-fire-1",
      eventId: "event-fire",
      cell: { x: 40, y: 40 },
      position: point(405, 405),
      intensity: 100,
      createdAt: 0,
      lastSpreadAt: 0,
    }];
    world.hostiles = [{
      id: "bandit-1",
      eventId: "event-bandits",
      position: point(425, 405),
      health: 100,
    }];

    const result = assignPlanTasks(world, response([{
      type: "fight_fire",
      targetEventId: "event-fire",
      villagerCount: 2,
      priority: 1,
      rationale: "Contain it.",
    }, {
      type: "defend_event",
      targetEventId: "event-bandits",
      villagerCount: 2,
      priority: 2,
      rationale: "Protect the village.",
    }]), "ai", 1);

    expect(result.assignedCount).toBe(1);
    expect(new Set(world.villagerTasks.map((task) => task.villagerId)).size)
      .toBe(world.villagerTasks.length);
    expect(result.intentResults.map((item) => item.assignedCount)).toEqual([1, 0]);
    expect(result.intentResults[1]).toMatchObject({ reason: "reserve_policy" });
  });

  it("evicts completed history at the cap so later plans can still assign work", () => {
    const world = flatWorld();
    establish(world, [villager("villager-1", 395, 405)]);
    world.events = [event("event-1", "fire")];
    world.fires = [{
      id: "event-1-fire-1",
      eventId: "event-1",
      cell: { x: 40, y: 40 },
      position: point(405, 405),
      intensity: 100,
      createdAt: 0,
      lastSpreadAt: 0,
    }];
    world.villagerTasks = Array.from({ length: TASK_LIMITS.maxTaskHistory }, (_, index) => ({
      id: `old-task-${index}`,
      villagerId: `old-villager-${index}`,
      type: "relocate" as const,
      destination: point(205, 205),
      path: [point(205, 205)],
      pathIndex: 0,
      phase: "acting" as const,
      status: "completed" as const,
      sourcePlanId: "old-plan",
      source: "ai" as const,
      createdAt: 0,
      completedAt: 0,
    }));

    const result = assignPlanTasks(world, response([{
      type: "fight_fire",
      targetEventId: "event-1",
      villagerCount: 1,
      priority: 1,
      rationale: "Keep the sandbox responding.",
    }]), "ai", 201);

    expect(result.assignedCount).toBe(1);
    expect(world.villagerTasks).toHaveLength(TASK_LIMITS.maxTaskHistory);
    expect(world.villagerTasks.at(-1)).toMatchObject({
      id: "task-201",
      villagerId: "villager-1",
      status: "active",
    });
  });
});

describe("deterministic task actions", () => {
  it("moves by no more than 40 units/s on the fixed 100 ms step", () => {
    const world = flatWorld();
    establish(world, [villager("villager-1", 205, 205)]);
    world.events = [event("event-1", "fire", point(405, 205))];
    world.fires = [{
      id: "event-1-fire-1",
      eventId: "event-1",
      cell: { x: 40, y: 20 },
      position: point(405, 205),
      intensity: 100,
      createdAt: 0,
      lastSpreadAt: 0,
    }];
    assignPlanTasks(world, response([{
      type: "fight_fire",
      targetEventId: "event-1",
      villagerCount: 1,
      priority: 1,
      rationale: "Contain it.",
    }]), "ai", 1);
    const before = { ...world.villagers[0]!.position };

    updateVillagerTasks(world, 100);

    expect(Math.hypot(
      world.villagers[0]!.position.x - before.x,
      world.villagers[0]!.position.y - before.y,
    )).toBeLessThanOrEqual(4 + 1e-9);
    expect(TASK_LIMITS.speedPerSecond).toBe(40);
  });

  it("reduces positive fire intensity, resolves the fire, and returns the survivor", () => {
    const world = flatWorld();
    establish(world, [villager("villager-1", 205, 205)]);
    world.events = [event("event-1", "fire", point(215, 205))];
    world.fires = [{
      id: "event-1-fire-1",
      eventId: "event-1",
      cell: { x: 21, y: 20 },
      position: point(215, 205),
      intensity: 100,
      createdAt: 0,
      lastSpreadAt: 0,
    }];
    assignPlanTasks(world, response([{
      type: "fight_fire",
      targetEventId: "event-1",
      villagerCount: 1,
      priority: 1,
      rationale: "Contain it.",
    }]), "ai", 1);

    updateVillagerTasks(world, 100);
    expect(world.events[0]).toMatchObject({ status: "resolved", severity: 0 });
    expect(world.fires).toEqual([]);
    expect(world.villagerTasks[0]).toMatchObject({ status: "completed" });
    expect(world.villagers[0]!.position).toEqual(point(205, 205));
  });

  it("extinguishes three nearby full-strength fire cells in one action", () => {
    const world = flatWorld();
    establish(world, [villager("villager-1", 205, 205)]);
    world.events = [event("event-1", "fire", point(205, 205))];
    world.fires = [
      {
        id: "event-1-fire-1",
        eventId: "event-1",
        cell: { x: 21, y: 20 },
        position: point(215, 205),
        intensity: 100,
        createdAt: 0,
        lastSpreadAt: 0,
      },
      {
        id: "event-1-fire-2",
        eventId: "event-1",
        cell: { x: 20, y: 21 },
        position: point(205, 215),
        intensity: 100,
        createdAt: 0,
        lastSpreadAt: 0,
      },
      {
        id: "event-1-fire-3",
        eventId: "event-1",
        cell: { x: 19, y: 20 },
        position: point(195, 205),
        intensity: 100,
        createdAt: 0,
        lastSpreadAt: 0,
      },
    ];
    assignPlanTasks(world, response([{
      type: "fight_fire",
      targetEventId: "event-1",
      villagerCount: 1,
      priority: 1,
      rationale: "Contain it.",
    }]), "ai", 1);

    updateVillagerTasks(world, 100);

    expect(world.fires).toEqual([]);
    expect(world.events[0]).toMatchObject({ status: "resolved", severity: 0 });
  });

  it("routes fire responders to a reachable edge cell instead of the fire center", () => {
    const world = flatWorld();
    establish(world, [villager("villager-1", 205, 405)]);
    world.events = [event("event-1", "fire", point(405, 405))];
    world.fires = [{
      id: "event-1-fire-1",
      eventId: "event-1",
      cell: { x: 40, y: 40 },
      position: point(405, 405),
      intensity: 100,
      createdAt: 0,
      lastSpreadAt: 0,
    }];

    assignPlanTasks(world, response([{
      type: "fight_fire",
      targetEventId: "event-1",
      villagerCount: 1,
      priority: 1,
      rationale: "Contain it from the edge.",
    }]), "ai", 1);

    expect(world.villagerTasks[0]!.destination).not.toEqual(point(405, 405));
    expect(Math.hypot(
      world.villagerTasks[0]!.destination.x - world.fires[0]!.position.x,
      world.villagerTasks[0]!.destination.y - world.fires[0]!.position.y,
    )).toBe(CELL_SIZE);

    for (let tick = 0; tick < 100; tick += 1) updateVillagerTasks(world, 100);
    expect(world.fires).toEqual([]);
    expect(world.events[0]).toMatchObject({ status: "resolved" });
  });

  it("lets a nearby responder act on a fire with no traversable edge cell", () => {
    const world = flatWorld();
    world.terrain.fill(0);
    establish(world, [villager("villager-1", 395, 395)]);
    world.terrain[cellIndex({ x: 40, y: 40 })] = 1;
    world.terrain[cellIndex({ x: 39, y: 39 })] = 1;
    world.events = [event("event-1", "fire", point(405, 405))];
    world.fires = [{
      id: "event-1-fire-1",
      eventId: "event-1",
      cell: { x: 40, y: 40 },
      position: point(405, 405),
      intensity: 100,
      createdAt: 0,
      lastSpreadAt: 0,
    }];

    const result = assignPlanTasks(world, response([{
      type: "fight_fire",
      targetEventId: "event-1",
      villagerCount: 1,
      priority: 1,
      rationale: "Fight the isolated fire from nearby land.",
    }]), "fallback", 1);

    expect(result.assignedCount).toBe(1);
    updateVillagerTasks(world, 100);
    expect(world.events[0]).toMatchObject({ status: "resolved", severity: 0 });
    expect(world.fires).toEqual([]);
  });

  it("moves an acting responder when its next fire edge is within range but not at its feet", () => {
    const world = flatWorld();
    establish(world, [villager("villager-1", 205, 205)], point(205, 205));
    world.events = [event("event-1", "fire", point(235, 205))];
    world.fires = [{
      id: "event-1-fire-1",
      eventId: "event-1",
      cell: { x: 23, y: 20 },
      position: point(235, 205),
      intensity: 100,
      createdAt: 0,
      lastSpreadAt: 0,
    }];
    world.villagerTasks.push({
      id: "task-1",
      villagerId: "villager-1",
      type: "fight_fire",
      targetEventId: "event-1",
      destination: point(205, 205),
      path: [point(205, 205)],
      pathIndex: 0,
      phase: "acting",
      status: "active",
      sourcePlanId: "plan-1",
      source: "fallback",
      createdAt: 0,
    });

    updateVillagerTasks(world, 100);

    expect(world.villagers[0]!.position).toEqual(point(209, 205));
    expect(world.villagerTasks[0]).toMatchObject({
      destination: point(225, 205),
      phase: "outbound",
    });
    expect(world.fires).toHaveLength(1);
  });

  it("opens a permanent emergency gate when a fire response is sealed behind a wall", () => {
    const world = flatWorld();
    establish(world, [villager("villager-1", 15, 45)]);
    world.activeVillage!.wall = {
      polygon: [
        point(45, 0),
        point(120, 0),
        point(120, 859),
        point(45, 859),
      ],
      gates: [],
      segments: [
        { start: point(45, 0), end: point(45, 859) },
      ],
    };
    world.events = [event("event-1", "fire", point(85, 45))];
    world.fires = [{
      id: "event-1-fire-1",
      eventId: "event-1",
      cell: { x: 8, y: 4 },
      position: point(85, 45),
      intensity: 100,
      createdAt: 0,
      lastSpreadAt: 0,
    }];

    expect(findPath(world, point(15, 45), point(75, 45), 512)).toBeNull();

    const result = assignPlanTasks(world, response([{
      type: "fight_fire",
      targetEventId: "event-1",
      villagerCount: 1,
      priority: 1,
      rationale: "Break through to reach the fire.",
    }]), "ai", 1);

    expect(result.assignedCount).toBe(1);
    expect(result.structureChanged).toBe(true);
    expect(world.activeVillage!.wall.gates).toEqual([
      expect.objectContaining({
        id: "emergency-gate-1",
        roadId: "emergency",
        point: point(45, 45),
        edgeIndex: 3,
      }),
    ]);
    expect(world.activeVillage!.wall.segments).toHaveLength(2);
    expect(world.activeVillage!.wall.segments[0]!.start).toEqual(point(45, 0));
    expect(world.activeVillage!.wall.segments[0]!.end.x).toBeCloseTo(45);
    expect(world.activeVillage!.wall.segments[0]!.end.y).toBeCloseTo(28);
    expect(world.activeVillage!.wall.segments[1]!.start.x).toBeCloseTo(45);
    expect(world.activeVillage!.wall.segments[1]!.start.y).toBeCloseTo(62);
    expect(world.activeVillage!.wall.segments[1]!.end).toEqual(point(45, 859));
    expect(findPath(world, point(15, 45), point(75, 45), 512)).toEqual([
      point(15, 45),
      point(75, 45),
    ]);
  });

  it("lets defenders damage and resolve event-owned bandits", () => {
    const world = flatWorld();
    establish(world, [villager("villager-1", 205, 205)]);
    world.events = [event("event-1", "bandits", point(215, 205))];
    world.hostiles = [{
      id: "event-1-bandit-1",
      eventId: "event-1",
      position: point(215, 205),
      health: 100,
    }];
    assignPlanTasks(world, response([{
      type: "defend_event",
      targetEventId: "event-1",
      villagerCount: 1,
      priority: 1,
      rationale: "Defend the village.",
    }]), "ai", 1);

    updateVillagerTasks(world, 100);
    expect(world.hostiles[0]!.health).toBeLessThan(100);
    for (let tick = 0; tick < 30; tick += 1) updateVillagerTasks(world, 100);

    expect(world.hostiles).toEqual([]);
    expect(world.events[0]).toMatchObject({ status: "resolved" });
  });

  it("keeps defenders pursuing their assigned moving bandit", () => {
    const world = flatWorld();
    establish(world, [villager("villager-1", 205, 205)]);
    world.events = [event("event-1", "bandits", point(245, 205))];
    world.hostiles = [{
      id: "event-1-bandit-1",
      eventId: "event-1",
      position: point(245, 205),
      health: 100,
    }];
    assignPlanTasks(world, response([{
      type: "defend_event",
      targetEventId: "event-1",
      villagerCount: 1,
      priority: 1,
      rationale: "Defend the village.",
    }]), "ai", 1);
    expect(world.villagerTasks[0]).toMatchObject({ targetHostileId: "event-1-bandit-1" });

    world.hostiles[0]!.position = point(305, 205);
    world.hostiles.push({
      id: "event-1-bandit-2",
      eventId: "event-1",
      position: point(215, 205),
      health: 100,
    });
    updateVillagerTasks(world, 100);

    expect(world.villagerTasks[0]).toMatchObject({
      targetHostileId: "event-1-bandit-1",
      destination: point(305, 205),
    });
    expect(world.hostiles.find((hostile) => hostile.id === "event-1-bandit-2")!.health).toBe(100);

    for (let tick = 0; tick < 40; tick += 1) updateVillagerTasks(world, 100);

    expect(world.hostiles.find((hostile) => hostile.id === "event-1-bandit-1")?.health ?? 0)
      .toBeLessThan(100);
  });

  it("does not retarget defenders backward to their current cell center", () => {
    const world = flatWorld();
    establish(world, [villager("villager-1", 206, 205)]);
    world.events = [event("event-1", "bandits", point(405, 205))];
    world.hostiles = [{
      id: "event-1-bandit-1",
      eventId: "event-1",
      position: point(405, 205),
      health: 100,
    }];
    assignPlanTasks(world, response([{
      type: "defend_event",
      targetEventId: "event-1",
      villagerCount: 1,
      priority: 1,
      rationale: "Defend the village.",
    }]), "ai", 1);

    updateVillagerTasks(world, 100);

    expect(world.villagers[0]!.position.x).toBeGreaterThan(206);
  });

  it("removes the event pit before resolving rescue without teleporting the trapped villager", () => {
    const world = flatWorld();
    const trapped = {
      ...villager("trapped", 215, 205, "trapped"),
      trappedByPitId: "event-1-pit-1",
    };
    establish(world, [villager("rescuer", 185, 205), trapped]);
    world.events = [event("event-1", "earthquake", point(215, 205))];
    world.pits = [{
      id: "event-1-pit-1",
      eventId: "event-1",
      position: point(215, 205),
      radius: 14,
    }];
    assignPlanTasks(world, response([{
      type: "rescue_trapped",
      targetEventId: "event-1",
      villagerCount: 1,
      priority: 1,
      rationale: "Free the trapped villager.",
    }]), "ai", 1);

    const trappedBefore = { ...trapped.position };
    updateVillagerTasks(world, 100);
    const afterRescue = world.villagers.find((candidate) => candidate.id === "trapped")!;
    expect(Math.hypot(
      afterRescue.position.x - trappedBefore.x,
      afterRescue.position.y - trappedBefore.y,
    )).toBeLessThanOrEqual(4 + 1e-9);
    expect(world.pits).toEqual([]);
    expect(world.events[0]).toMatchObject({ status: "resolved", severity: 0 });
    for (let tick = 1; tick < 20; tick += 1) updateVillagerTasks(world, 100);

    const rescued = world.villagers.find((candidate) => candidate.id === "trapped")!;
    expect(rescued).toMatchObject({ status: "idle", trappedByPitId: undefined });
    expect(world.pits).toEqual([]);
    expect(world.events[0]).toMatchObject({ status: "resolved" });
  });

  it("routes rescuers around the pit instead of sending them through it", () => {
    const world = flatWorld();
    const trapped = {
      ...villager("trapped", 215, 205, "trapped"),
      trappedByPitId: "event-1-pit-1",
    };
    establish(world, [villager("rescuer", 275, 205), trapped]);
    world.events = [event("event-1", "earthquake", point(215, 205))];
    world.pits = [{
      id: "event-1-pit-1",
      eventId: "event-1",
      position: point(215, 205),
      radius: 14,
    }];

    const result = assignPlanTasks(world, response([{
      type: "rescue_trapped",
      targetEventId: "event-1",
      villagerCount: 1,
      priority: 1,
      rationale: "Free the trapped villager without entering the pit.",
    }]), "ai", 1);

    expect(result.assignedCount).toBe(1);
    expect(world.villagerTasks[0]!.path.some((pathPoint) =>
      Math.hypot(pathPoint.x - 215, pathPoint.y - 205) <= 14)).toBe(false);
  });

  it("keeps rescuing villagers from the same hole until it is empty", () => {
    const world = flatWorld();
    const trappedA = {
      ...villager("trapped-a", 215, 205, "trapped"),
      trappedByPitId: "event-1-pit-1",
    };
    const trappedB = {
      ...villager("trapped-b", 215, 205, "trapped"),
      trappedByPitId: "event-1-pit-1",
    };
    establish(world, [villager("rescuer", 185, 205), trappedA, trappedB]);
    world.events = [event("event-1", "earthquake", point(215, 205))];
    world.pits = [{
      id: "event-1-pit-1",
      eventId: "event-1",
      position: point(215, 205),
      radius: 14,
    }];
    assignPlanTasks(world, response([{
      type: "rescue_trapped",
      targetEventId: "event-1",
      villagerCount: 1,
      priority: 1,
      rationale: "Empty the hole before repairing it.",
    }]), "ai", 1);

    for (let tick = 0; tick < 20; tick += 1) updateVillagerTasks(world, 100);

    expect(world.villagers.filter((candidate) => candidate.status === "trapped")).toEqual([]);
    expect(world.pits).toEqual([]);
    expect(world.events[0]).toMatchObject({ status: "resolved", severity: 0 });
  });

  it("does not assign repairs while an earthquake rescue is active", () => {
    const world = flatWorld();
    const worker = villager("worker", 205, 205);
    const trapped = {
      ...villager("trapped", 215, 205, "trapped"),
      trappedByPitId: "event-1-pit-1",
    };
    establish(world, [worker, trapped]);
    world.activeVillage!.houses[0] = {
      ...world.activeVillage!.houses[0]!,
      health: 0,
      destroyed: true,
      rebuildProgress: 0,
    };
    world.events = [event("event-1", "earthquake", point(215, 205))];
    world.pits = [{
      id: "event-1-pit-1",
      eventId: "event-1",
      position: point(215, 205),
      radius: 14,
    }];

    updateVillagerTasks(world, 100);

    expect(world.villagerTasks.filter((task) =>
      task.type === "rebuild_structure" && task.status === "active")).toEqual([]);
  });

  it("defers an existing repair task when an earthquake becomes active", () => {
    const world = flatWorld();
    const worker = villager("worker", 205, 205);
    const rescuer = villager("rescuer", 275, 205);
    const trapped = {
      ...villager("trapped", 215, 205, "trapped"),
      trappedByPitId: "event-1-pit-1",
    };
    establish(world, [worker, rescuer, trapped]);
    world.activeVillage!.houses[0] = {
      ...world.activeVillage!.houses[0]!,
      health: 0,
      destroyed: true,
      rebuildProgress: 0,
    };

    updateVillagerTasks(world, 100);
    const repair = world.villagerTasks.find((task) => task.type === "rebuild_structure")!;
    expect(repair.status).toBe("active");

    world.events = [event("event-1", "earthquake", point(215, 205))];
    world.pits = [{
      id: "event-1-pit-1",
      eventId: "event-1",
      position: point(215, 205),
      radius: 14,
    }];
    const rescueResult = assignPlanTasks(world, response([{
      type: "rescue_trapped",
      targetEventId: "event-1",
      villagerCount: 1,
      priority: 1,
      rationale: "Rescue before repairing structures.",
    }]), "ai", 1);

    expect(rescueResult.assignedCount).toBe(1);
    updateVillagerTasks(world, 100);

    expect(repair.status).toBe("abandoned");
    expect(world.villagerTasks.some((task) =>
      task.type === "rescue_trapped" && task.status === "active")).toBe(true);
  });

  it("isolates infected villagers farther from healthy villagers", () => {
    const world = flatWorld();
    establish(world, [
      villager("sick", 205, 205, "sick"),
      villager("healthy", 215, 205),
    ]);
    world.events = [event("event-1", "plague", point(205, 205))];
    world.plagueCases = [
      { eventId: "event-1", villagerId: "sick", status: "infected", infectedAt: 0 },
      { eventId: "event-1", villagerId: "healthy", status: "susceptible", infectedAt: -1 },
    ];
    const before = 10;
    assignPlanTasks(world, response([{
      type: "isolate_sick",
      targetEventId: "event-1",
      villagerCount: 1,
      priority: 1,
      rationale: "Separate the infected villager.",
    }]), "ai", 1);

    for (let tick = 0; tick < 400; tick += 1) updateVillagerTasks(world, 100);

    const sick = world.villagers.find((candidate) => candidate.id === "sick")!;
    const healthy = world.villagers.find((candidate) => candidate.id === "healthy")!;
    expect(Math.hypot(sick.position.x - healthy.position.x, sick.position.y - healthy.position.y))
      .toBeGreaterThan(before);
  });

  it("relocates to an engine-computed safe zone and blocks founding during an active hazard", () => {
    const world = flatWorld();
    establish(world, [villager("relocator", 205, 205), villager("founder", 215, 205)]);
    world.events = [event("event-wave", "tsunami", point(205, 205))];

    assignPlanTasks(world, response([{
      type: "relocate",
      strategy: "least_impacted_area",
      targetEventId: "event-wave",
      villagerCount: 1,
      priority: 1,
      rationale: "Move away from the wave.",
    }, {
      type: "found_village",
      strategy: "new_village_site",
      villagerCount: 1,
      priority: 2,
      rationale: "Establish a safe anchor.",
    }]), "ai", 1);

    const destinations = world.villagerTasks.map((task) => task.destination);
    expect(destinations.every((destination) =>
      destination.x !== world.events[0]!.origin.x || destination.y !== world.events[0]!.origin.y))
      .toBe(true);
    for (let tick = 0; tick < 1_000; tick += 1) updateVillagerTasks(world, 100);

    expect(world.villagerTasks.every((task) => task.status === "completed")).toBe(true);
    expect(world.foundedAnchors).toEqual([]);
  });

  it("limits quiet-state founding to a small group and preserves a reserve", () => {
    const world = flatWorld();
    world.villagers = [
      villager("founder-a", 205, 205),
      villager("founder-b", 215, 205),
      villager("founder-c", 225, 205),
      villager("founder-d", 235, 205),
      villager("founder-e", 245, 205),
      villager("founder-f", 255, 205),
    ];

    const result = assignPlanTasks(world, response([{
      type: "found_village",
      strategy: "new_village_site",
      villagerCount: 99,
      priority: 1,
      rationale: "Establish a quiet starting settlement.",
    }]), "ai", 1);

    expect(result.assignedCount).toBe(4);
    expect(result.intentResults[0]).toMatchObject({
      requestedCount: 99,
      assignedCount: 4,
      reason: "deployment_cap",
    });
  });

  it("automatically rebuilds ruined houses and repopulates restored capacity", () => {
    const world = flatWorld();
    const worker = villager("worker", 205, 205);
    establish(world, [worker], point(205, 205));
    world.activeVillage!.houses[0] = {
      ...world.activeVillage!.houses[0]!,
      health: 0,
      destroyed: true,
      rebuildProgress: 0,
    };

    for (let tick = 0; tick < 40; tick += 1) updateVillagerTasks(world, 100);

    expect(world.activeVillage!.houses[0]).toMatchObject({
      health: 100,
      destroyed: false,
    });
    expect(world.activeVillage!.houses[0]!.rebuildProgress).toBeUndefined();
    expect(world.villagers.filter((candidate) =>
      candidate.houseId === "house-1" && candidate.status !== "dead")).toHaveLength(
      residentCountForHouse(world.seed, "house-1"),
    );
    expect(world.villagerTasks.some((task) =>
      task.type === "rebuild_structure" && task.status === "completed")).toBe(true);
  });

  it("restores damaged paths within one second of focused rebuild work", () => {
    const world = flatWorld();
    const worker = villager("worker", 45, 45);
    const damagedRoad: Road = {
      id: "road-1",
      role: "spine" as const,
      parentId: null,
      points: [point(5, 45), point(85, 45)],
      health: 95,
      damaged: true,
    };
    world.activeVillage = {
      seed: world.seed,
      anchor: point(45, 45),
      roads: [damagedRoad],
      houses: [],
      bridges: [],
      wall: { polygon: [], segments: [], gates: [] },
      villagers: [worker],
    };
    world.villagers = [worker];
    world.villagerTasks.push({
      id: "rebuild-road",
      villagerId: "worker",
      type: "rebuild_structure",
      targetStructureId: "road:road-1",
      targetStructureKind: "road",
      destination: point(45, 45),
      path: [point(45, 45)],
      pathIndex: 0,
      phase: "acting",
      status: "active",
      sourcePlanId: "deterministic-recovery",
      source: "deterministic",
      createdAt: 0,
    });

    updateVillagerTasks(world, 100);

    expect(damagedRoad).toMatchObject({ damaged: false });
    expect(damagedRoad.health).toBeUndefined();
    expect(damagedRoad).not.toHaveProperty("rebuildProgress");
  });

  it("restores destroyed wall segments within one second of focused rebuild work", () => {
    const world = flatWorld();
    const worker = villager("worker", 45, 425);
    const destroyedSegment: WallSegment = {
      start: { x: 45, y: 0 },
      end: { x: 45, y: 850 },
      health: 95,
      destroyed: true,
    };
    world.activeVillage = {
      seed: world.seed,
      anchor: cellToWorld({ x: 6, y: 4 }),
      roads: [],
      houses: [],
      bridges: [],
      wall: {
        polygon: [],
        gates: [],
        segments: [destroyedSegment],
      },
      villagers: [worker],
    };
    world.villagers = [worker];
    world.villagerTasks.push({
      id: "rebuild-wall",
      villagerId: "worker",
      type: "rebuild_structure",
      targetStructureId: "wall:0",
      targetStructureKind: "wall",
      destination: point(45, 425),
      path: [point(45, 425)],
      pathIndex: 0,
      phase: "acting",
      status: "active",
      sourcePlanId: "deterministic-recovery",
      source: "deterministic",
      createdAt: 0,
    });

    updateVillagerTasks(world, 100);

    expect(destroyedSegment).toMatchObject({ destroyed: false });
    expect(destroyedSegment.health).toBeUndefined();
    expect(destroyedSegment).not.toHaveProperty("rebuildProgress");
  });

  it("rebuilds stored wall gaps so the wall blocks paths again", () => {
    const world = flatWorld();
    world.activeVillage = {
      seed: world.seed,
      anchor: cellToWorld({ x: 6, y: 4 }),
      roads: [],
      houses: [],
      bridges: [],
      wall: {
        polygon: [],
        gates: [],
        segments: [{
          start: { x: 45, y: 0 },
          end: { x: 45, y: 850 },
          destroyed: true,
          rebuildProgress: 0,
        }],
      },
      villagers: [],
    };
    world.villagers = [villager("worker", 45, 425)];
    world.activeVillage.villagers = world.villagers;

    expect(findPath(
      world,
      cellToWorld({ x: 1, y: 4 }),
      cellToWorld({ x: 8, y: 4 }),
      512,
    )).toEqual([
      { x: 15, y: 45 },
      { x: 85, y: 45 },
    ]);

    for (let tick = 0; tick < 25; tick += 1) updateVillagerTasks(world, 100);

    expect(world.activeVillage.wall.segments[0]).toMatchObject({ destroyed: false });
    expect(findPath(
      world,
      cellToWorld({ x: 1, y: 4 }),
      cellToWorld({ x: 8, y: 4 }),
      512,
    )).not.toEqual([
      { x: 15, y: 45 },
      { x: 85, y: 45 },
    ]);
  });
});
