import { describe, expect, it } from "vitest";
import { PlannerResponseSchema } from "../shared/planner-contract";
import { ensureDisasterState } from "./disasters";
import {
  createFallbackPlan,
  createPlannerRequest,
} from "./planning";
import { createWorld } from "./terrain";
import type { PlanHistoryEntry, Villager, WorldEvent, WorldState } from "./types";

const villager = (id: string, x: number, y: number): Villager => ({
  id,
  position: { x, y },
  health: 100,
  status: "idle",
});

const event = (
  id: string,
  type: WorldEvent["type"],
  status: WorldEvent["status"] = "active",
): WorldEvent => ({
  id,
  type,
  origin: { x: 405, y: 405 },
  createdAt: 0,
  updatedAt: 0,
  status,
  severity: status === "active" ? 80 : 0,
  facts: ["compact:yes", "count:2", "bounded:true", "fourth:fact", "omit:this"],
});

const world = (): WorldState => {
  const state = createWorld(42);
  state.terrain.fill(1);
  state.riverLike.fill(0);
  state.trees = [];
  ensureDisasterState(state);
  state.villagerTasks = [];
  state.planHistory = [];
  state.foundedAnchors = [];
  state.villagers = [villager("secret-villager-id", 405, 405)];
  state.activeVillage = {
    seed: 42,
    anchor: { x: 405, y: 405 },
    roads: [],
    houses: [],
    bridges: [],
    wall: { polygon: [], segments: [], gates: [] },
    villagers: state.villagers,
  };
  return state;
};

describe("compact planner requests", () => {
  it("includes only active compact events with counts, distance, ETA, impact, facts, and safe areas", () => {
    const state = world();
    state.events = [event("event-wave", "tsunami"), event("event-old", "fire", "resolved")];
    state.tsunamis = [{
      id: "event-wave-front",
      eventId: "event-wave",
      origin: { x: 205, y: 405 },
      position: { x: 205, y: 405 },
      direction: { x: 1, y: 0 },
      width: 220,
      speed: 28,
      ageMs: 1_000,
      hitEntityIds: [],
    }];
    const request = createPlannerRequest(state, state.events, "request-1");

    expect(request.activeEvents).toEqual([expect.objectContaining({
      id: "event-wave",
      type: "tsunami",
      distanceToVillage: 200,
      etaMs: expect.any(Number),
      likelyImpactCount: expect.any(Number),
      facts: ["compact:yes", "count:2", "bounded:true", "fourth:fact"],
      recommendedIntent: "relocate",
      recommendedVillagers: 1,
      maxUsefulVillagers: 1,
      threatensVillage: true,
    })]);
    expect(request.world).toMatchObject({
      villageCount: 1,
      availableVillagers: 1,
      livingVillagers: 1,
      sickVillagers: 0,
      trappedVillagers: 0,
      assignedVillagers: 0,
      hasActiveVillage: true,
      minimumReserveVillagers: 0,
      maxDeployableVillagers: 1,
      safeAreas: expect.any(Array),
    });
    expect(request.world.safeAreas.length).toBeGreaterThan(0);
    expect(request.world.safeAreas.length).toBeLessThanOrEqual(20);
  });

  it("omits exact villager IDs and task path nodes", () => {
    const state = world();
    state.events = [event("event-fire", "fire")];
    state.villagerTasks = [{
      id: "task-secret",
      villagerId: "secret-villager-id",
      type: "fight_fire",
      targetEventId: "event-fire",
      destination: { x: 999, y: 777 },
      path: [{ x: 123, y: 456 }, { x: 999, y: 777 }],
      pathIndex: 1,
      phase: "outbound",
      status: "active",
      sourcePlanId: "plan-1",
      source: "ai",
      createdAt: 0,
    }];

    const serialized = JSON.stringify(createPlannerRequest(state, state.events, "request-1"));

    expect(serialized).not.toContain("secret-villager-id");
    expect(serialized).not.toContain("task-secret");
    expect(serialized).not.toContain("\"x\":123");
    expect(serialized).not.toContain("\"x\":999");
  });

  it("keeps only the five most recent plan outcomes", () => {
    const state = world();
    state.events = [event("event-fire", "fire")];
    state.planHistory = Array.from({ length: 8 }, (_, index): PlanHistoryEntry => ({
      planId: `plan-${index + 1}`,
      source: index % 2 === 0 ? "ai" : "fallback",
      summary: `Plan ${index + 1}`,
      outcome: `Outcome ${index + 1}`,
      simulationTimeMs: index,
    }));

    expect(createPlannerRequest(state, state.events, "request-1").recentPlans.map((plan) => plan.planId))
      .toEqual(["plan-4", "plan-5", "plan-6", "plan-7", "plan-8"]);
  });
});

describe("deterministic fallback", () => {
  it.each([
    [["plague", "earthquake", "bandits", "fire", "tsunami"], "relocate", "event-tsunami"],
    [["plague", "earthquake", "bandits", "fire"], "fight_fire", "event-fire"],
    [["plague", "earthquake", "bandits"], "defend_event", "event-bandits"],
    [["plague", "earthquake"], "rescue_trapped", "event-earthquake"],
    [["plague"], "isolate_sick", "event-plague"],
  ] as const)("uses the fixed priority for %j", (types, expectedType, expectedEventId) => {
    const state = world();
    const includesEarthquake = (types as readonly string[]).includes("earthquake");
    state.villagers.push(villager("trapped", 415, 405));
    state.events = types.map((type) => event(`event-${type}`, type));
    state.pits = includesEarthquake ? [{
      id: "event-earthquake-pit-1",
      eventId: "event-earthquake",
      position: { x: 415, y: 405 },
      radius: 14,
    }] : [];
    if (includesEarthquake) {
      state.villagers[1]!.status = "trapped";
      state.villagers[1]!.trappedByPitId = "event-earthquake-pit-1";
    }
    const request = createPlannerRequest(state, state.events, "request-1");

    const fallback = createFallbackPlan(request);

    expect(PlannerResponseSchema.safeParse(fallback).success).toBe(true);
    expect(fallback.intents).toHaveLength(1);
    expect(fallback.intents[0]).toMatchObject({
      type: expectedType,
      targetEventId: expectedEventId,
      priority: 1,
    });
  });

  it("covers each active disaster with bounded teams before adding extra responders", () => {
    const state = world();
    state.villagers = Array.from({ length: 16 }, (_, index) =>
      villager(`villager-${index + 1}`, 405 + index * 2, 405));
    state.activeVillage = {
      ...state.activeVillage!,
      villagers: state.villagers,
    };
    state.events = (["plague", "earthquake", "bandits", "fire", "tsunami"] as const)
      .map((type) => event(`event-${type}`, type));
    const request = createPlannerRequest(state, state.events, "request-all");

    const fallback = createFallbackPlan(request);

    expect(PlannerResponseSchema.safeParse(fallback).success).toBe(true);
    expect(fallback.intents).toEqual([
      expect.objectContaining({
        type: "relocate",
        targetEventId: "event-tsunami",
        villagerCount: 4,
        priority: 1,
      }),
      expect.objectContaining({
        type: "fight_fire",
        targetEventId: "event-fire",
        villagerCount: 5,
        priority: 2,
      }),
      expect.objectContaining({
        type: "defend_event",
        targetEventId: "event-bandits",
        villagerCount: 1,
        priority: 3,
      }),
      expect.objectContaining({
        type: "rescue_trapped",
        targetEventId: "event-earthquake",
        villagerCount: 1,
        priority: 4,
      }),
      expect.objectContaining({
        type: "isolate_sick",
        targetEventId: "event-plague",
        villagerCount: 1,
        priority: 5,
      }),
    ]);
    expect(fallback.intents.reduce((total, intent) => total + intent.villagerCount, 0))
      .toBe(request.world.maxDeployableVillagers);
    expect(request.activeEvents.find((activeEvent) => activeEvent.type === "tsunami"))
      .toMatchObject({ recommendedVillagers: 4, maxUsefulVillagers: 4 });
  });

  it("returns a schema-valid empty safe plan when nothing is actionable", () => {
    const state = world();
    state.events = [event("event-old", "fire", "resolved")];
    const request = createPlannerRequest(state, state.events, "request-none");

    const fallback = createFallbackPlan(request);

    expect(fallback.intents).toEqual([]);
    expect(fallback.summary).toContain("No actionable");
    expect(PlannerResponseSchema.safeParse(fallback).success).toBe(true);
  });
});
