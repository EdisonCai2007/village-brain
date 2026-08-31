import { describe, expect, it, vi } from "vitest";
import { TSUNAMI_LIFETIME_MS } from "./constants";
import { cellIndex, worldToCell } from "./geometry";
import { VillageEngine } from "./engine";
import type { PlannerResponse } from "../shared/planner-contract";
import type { TimelineEntry, Tree, VillageState, Villager } from "./types";

const DEFAULT_ANCHOR = { x: 640, y: 560 } as const;

const attemptMutation = (mutate: () => void): void => {
  try {
    mutate();
  } catch {
    // A read-only publication may reject the write. Observable state is asserted below.
  }
};

describe("VillageEngine command surface", () => {
  it("does not ask the chief to plan terrain edits before a village exists", () => {
    const engine = new VillageEngine({ seed: 1, initialWorld: "ocean" });

    expect(engine.dispatch({
      type: "paint",
      terrain: "land",
      point: { x: 640, y: 430 },
      radius: 28,
    }).ok).toBe(true);

    expect(engine.drainPlanningEvents()).toEqual([]);
  });

  it("keeps reset in the engine's configured ocean mode", () => {
    const engine = new VillageEngine({ seed: 1, initialWorld: "ocean" });

    expect(engine.dispatch({
      type: "paint",
      terrain: "land",
      point: { x: 640, y: 430 },
      radius: 28,
    }).ok).toBe(true);

    engine.reset(2);

    expect(engine.getSnapshot().terrain.every((cell) => cell === 0)).toBe(true);
    expect(engine.getSnapshot().activeVillage).toBeNull();
  });

  it("transactionally executes a validated plan and logs actual clamped assignments", () => {
    const engine = new VillageEngine({ seed: 42 });
    expect(engine.dispatch({ type: "place_totem", point: DEFAULT_ANCHOR }).ok).toBe(true);
    const available = engine.getSnapshot().villagers.length;
    expect(engine.dispatch({ type: "trigger_fire", point: { x: 800, y: 560 } }).ok).toBe(true);
    const fire = engine.getSnapshot().events.find((event) => event.type === "fire")!;
    const plan: PlannerResponse = {
      planId: "plan-clamped",
      summary: "Commit every available responder.",
      intents: [{
        type: "fight_fire",
        targetEventId: fire.id,
        villagerCount: 100,
        priority: 1,
        rationale: "The fire is active.",
      }],
    };

    const result = engine.executePlan(plan, "ai");

    expect(result).toMatchObject({ ok: true, value: { assignedCount: 5 } });
    const snapshot = engine.getSnapshot();
    expect(snapshot.villagerTasks).toHaveLength(5);
    expect(snapshot.villagerTasks.every((task) =>
      task.source === "ai" && task.sourcePlanId === "plan-clamped")).toBe(true);
    expect(snapshot.timeline.slice(-2)).toEqual([
      expect.objectContaining({ kind: "plan", source: "ai", summary: expect.stringContaining("plan-clamped") }),
      expect.objectContaining({ kind: "execution", source: "ai", summary: expect.stringContaining("requested 100, actual 5 (deployment_cap)") }),
    ]);
    expect(snapshot.planHistory.at(-1)).toMatchObject({
      planId: "plan-clamped",
      outcome: "Assigned 5 of 100 requested villagers.",
      assignmentResults: [{
        intentIndex: 0,
        type: "fight_fire",
        requestedCount: 100,
        assignedCount: 5,
        reason: "deployment_cap",
      }],
    });
  });

  it("rejects malformed runtime plans without throwing or partially assigning", () => {
    const engine = new VillageEngine({ seed: 42 });
    expect(engine.dispatch({ type: "place_totem", point: DEFAULT_ANCHOR }).ok).toBe(true);
    const before = engine.getSnapshot();
    const executeRuntime = engine.executePlan.bind(engine) as (plan: unknown, source: unknown) => unknown;
    let result: unknown;

    expect(() => {
      result = executeRuntime({
        planId: "forged",
        summary: "Invalid low-level assignment.",
        intents: [{
          type: "fight_fire",
          targetEventId: "missing",
          villagerCount: Number.NaN,
          priority: 0,
          rationale: "",
          villagerIds: ["villager-1"],
          path: [{ x: 1, y: 2 }],
        }],
      }, "untrusted");
    }).not.toThrow();

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_command" } });
    const after = engine.getSnapshot();
    expect(after.villagerTasks).toEqual(before.villagerTasks);
    expect(after.villagers).toEqual(before.villagers);
    expect(after.hazardRevision).toBe(before.hazardRevision);
    expect(after.unitRevision).toBe(before.unitRevision);
    expect(after.timeline.at(-1)).toMatchObject({ kind: "error" });
  });

  it("publishes an immediate outcome when every valid intent target is stale", () => {
    const engine = new VillageEngine({ seed: 42 });
    expect(engine.dispatch({ type: "place_totem", point: DEFAULT_ANCHOR }).ok).toBe(true);

    expect(engine.executePlan({
      planId: "plan-stale",
      summary: "Attempt a response to an expired observation.",
      intents: [{
        type: "fight_fire",
        targetEventId: "event-expired",
        villagerCount: 2,
        priority: 1,
        rationale: "The observation reported fire.",
      }],
    }, "ai")).toMatchObject({
      ok: true,
      value: {
        assignedCount: 0,
        intentResults: [{ reason: "stale_target", assignedCount: 0 }],
      },
    });

    expect(engine.getSnapshot().timeline.slice(-3).map((entry) => entry.kind))
      .toEqual(["plan", "execution", "outcome"]);
    expect(engine.getSnapshot().timeline.slice(-3).map((entry) => entry.source))
      .toEqual(["ai", "ai", "ai"]);
  });

  it("publishes deeply read-only task routes and bounded planner history", () => {
    const engine = new VillageEngine({ seed: 42 });
    expect(engine.dispatch({ type: "place_totem", point: DEFAULT_ANCHOR }).ok).toBe(true);
    expect(engine.dispatch({ type: "trigger_fire", point: { x: 800, y: 560 } }).ok).toBe(true);
    const eventId = engine.getSnapshot().events.find((event) => event.type === "fire")!.id;
    expect(engine.executePlan({
      planId: "plan-route",
      summary: "Route one responder.",
      intents: [{
        type: "fight_fire",
        targetEventId: eventId,
        villagerCount: 1,
        priority: 1,
        rationale: "Contain it.",
      }],
    }, "fallback").ok).toBe(true);
    const published = engine.getSnapshot();
    const original = structuredClone(published.villagerTasks[0]);

    attemptMutation(() => {
      (published.villagerTasks as unknown as Array<{ path: Array<{ x: number }> }>)[0]!
        .path[0]!.x = -999;
    });
    for (let index = 0; index < 7; index += 1) {
      expect(engine.executePlan({
        planId: `empty-${index}`,
        summary: "No actionable work.",
        intents: [],
      }, "fallback").ok).toBe(true);
    }

    expect(engine.getSnapshot().villagerTasks[0]).toEqual(original);
    expect(engine.getSnapshot().planHistory).toHaveLength(5);
    expect(engine.getSnapshot().planHistory.map((plan) => plan.planId)).toEqual([
      "empty-2", "empty-3", "empty-4", "empty-5", "empty-6",
    ]);
  });

  it("advances assigned work on fixed ticks with scoped hazard notifications and one outcome", () => {
    const engine = new VillageEngine({ seed: 42 });
    expect(engine.dispatch({ type: "place_totem", point: DEFAULT_ANCHOR }).ok).toBe(true);
    const target = engine.getSnapshot().villagers[0]!.position;
    expect(engine.dispatch({ type: "trigger_fire", point: target }).ok).toBe(true);
    const fireId = engine.getSnapshot().events.find((event) => event.type === "fire")!.id;
    expect(engine.executePlan({
      planId: "plan-fire",
      summary: "Extinguish the nearby fire.",
      intents: [{
        type: "fight_fire",
        targetEventId: fireId,
        villagerCount: 1,
        priority: 1,
        rationale: "It is within reach.",
      }],
    }, "ai").ok).toBe(true);
    engine.drainPlanningEvents();
    const before = engine.getSnapshot();

    for (let tick = 0; tick < 100; tick += 1) engine.tick();

    const after = engine.getSnapshot();
    expect(after.events.find((event) => event.id === fireId)).toMatchObject({ status: "resolved" });
    expect(after.hazardRevision).toBeGreaterThan(before.hazardRevision);
    expect(after.unitRevision).toBeGreaterThan(before.unitRevision);
    expect(engine.drainPlanningEvents()).toContainEqual({
      type: "hazard_changed",
      simulationTimeMs: expect.any(Number),
      eventId: fireId,
      change: "resolved",
    });
    expect(after.timeline.filter((entry) =>
      entry.kind === "outcome" && entry.summary.includes("task-")).length).toBe(1);
  });

  it("eventually resolves a distant fire after responders arrive", () => {
    const engine = new VillageEngine({ seed: 1 });
    const anchor = { x: 640, y: 430 };
    expect(engine.dispatch({ type: "place_totem", point: anchor }).ok).toBe(true);
    expect(engine.dispatch({ type: "trigger_fire", point: { x: 85, y: 375 } }).ok).toBe(true);
    const fire = engine.getSnapshot().events.find((event) => event.type === "fire")!;

    for (let tick = 0; tick < 10; tick += 1) engine.tick();
    expect(engine.executePlan({
      planId: "plan-distant-fire",
      summary: "Contain the distant fire.",
      intents: [{
        type: "fight_fire",
        targetEventId: fire.id,
        villagerCount: 5,
        priority: 1,
        rationale: "Stop the fire before it overruns the island.",
      }],
    }, "fallback")).toMatchObject({ ok: true, value: { assignedCount: 5 } });

    for (let tick = 0; tick < 600; tick += 1) engine.tick();

    expect(engine.getSnapshot().events.find((event) => event.id === fire.id))
      .toMatchObject({ status: "resolved" });
    expect(engine.getSnapshot().fires.filter((candidate) => candidate.eventId === fire.id))
      .toEqual([]);
  });

  it("lets deterministic recovery finish after disaster updates run", () => {
    const engine = new VillageEngine({ seed: 42 });
    expect(engine.dispatch({ type: "place_totem", point: DEFAULT_ANCHOR }).ok).toBe(true);

    expect(engine.dispatch({
      type: "trigger_earthquake",
      point: DEFAULT_ANCHOR,
    }).ok).toBe(true);
    const earthquake = engine.getSnapshot().events.at(-1)!;
    expect(engine.executePlan(
      engine.createFallbackPlan(engine.createPlannerRequest([earthquake.id])),
      "fallback",
    )).toMatchObject({ ok: true, value: { assignedCount: 2 } });

    const damaged = engine.getSnapshot().activeVillage!;
    expect(damaged.roads.every((road) => road.damaged === true)).toBe(true);
    expect(damaged.anchorDestroyed).toBe(true);

    for (let tick = 0; tick < 500; tick += 1) engine.tick();

    const repaired = engine.getSnapshot().activeVillage!;
    expect(repaired.roads.every((road) => road.damaged !== true)).toBe(true);
    expect(repaired.roads.every((road) => road.rebuildProgress === undefined)).toBe(true);
    expect(repaired.anchorDestroyed).not.toBe(true);
    expect(repaired.anchorRebuildProgress).toBeUndefined();
  });

  it("validates disaster placement before consuming a monotonic event ID", () => {
    const engine = new VillageEngine({ seed: 42 });

    expect(engine.dispatch({
      type: "trigger_fire",
      point: { x: 5, y: 5 },
    })).toMatchObject({ ok: false });
    expect(engine.dispatch({
      type: "trigger_tsunami",
      point: { x: 5, y: 5 },
    })).toMatchObject({ ok: true, value: { id: "event-1", type: "tsunami" } });
    expect(engine.dispatch({
      type: "trigger_fire",
      point: DEFAULT_ANCHOR,
    })).toMatchObject({ ok: true, value: { id: "event-2", type: "fire" } });

    const snapshot = engine.getSnapshot();
    expect(snapshot.events.map((event) => event.id)).toEqual(["event-1", "event-2"]);
    expect(snapshot.hazardRevision).toBe(2);
    expect(engine.drainPlanningEvents()).toEqual([
      { type: "hazard_changed", simulationTimeMs: 0, eventId: "event-1", change: "created" },
      { type: "hazard_changed", simulationTimeMs: 0, eventId: "event-2", change: "created" },
    ]);
  });

  it("publishes deeply immutable disaster entities and lifecycle outcomes", () => {
    const engine = new VillageEngine({ seed: 7 });
    expect(engine.dispatch({
      type: "trigger_tsunami",
      point: { x: 5, y: 5 },
    }).ok).toBe(true);
    const published = engine.getSnapshot();

    attemptMutation(() => {
      (published.events as unknown as Array<{ severity: number }>)[0]!.severity = -1;
    });
    attemptMutation(() => {
      (published.tsunamis as unknown as Array<{ hitEntityIds: string[] }>)[0]!
        .hitEntityIds.push("forged");
    });
    expect(engine.getSnapshot().events[0]!.severity).not.toBe(-1);
    expect(engine.getSnapshot().tsunamis[0]!.hitEntityIds).not.toContain("forged");

    for (let tick = 0; tick < TSUNAMI_LIFETIME_MS / 100; tick += 1) engine.tick();
    const resolved = engine.getSnapshot();
    expect(resolved.events[0]).toMatchObject({ status: "resolved", updatedAt: TSUNAMI_LIFETIME_MS });
    expect(resolved.timeline.at(-1)).toMatchObject({ kind: "outcome" });
    expect(engine.drainPlanningEvents().at(-1)).toEqual({
      type: "hazard_changed",
      simulationTimeMs: TSUNAMI_LIFETIME_MS,
      eventId: "event-1",
      change: "resolved",
    });
  });

  it("keeps trapped earthquakes active for planning and resolves them after terrain removes the pit", () => {
    const engine = new VillageEngine({ seed: 42 });
    expect(engine.dispatch({ type: "place_totem", point: DEFAULT_ANCHOR }).ok).toBe(true);
    engine.drainPlanningEvents();
    const target = [...engine.getSnapshot().villagers].sort((first, second) =>
      Math.hypot(second.position.x - DEFAULT_ANCHOR.x, second.position.y - DEFAULT_ANCHOR.y)
      - Math.hypot(first.position.x - DEFAULT_ANCHOR.x, first.position.y - DEFAULT_ANCHOR.y))[0]!;
    expect(engine.dispatch({ type: "trigger_earthquake", point: target.position }).ok).toBe(true);
    let snapshot = engine.getSnapshot();
    const event = snapshot.events.at(-1)!;
    expect(event).toMatchObject({ type: "earthquake", status: "active" });
    expect(snapshot.timeline.at(-1)).toMatchObject({ kind: "observation" });
    expect(engine.drainPlanningEvents()).toEqual([{
      type: "hazard_changed",
      simulationTimeMs: 0,
      eventId: event.id,
      change: "created",
    }]);

    const eventPits = snapshot.pits.filter((pit) => pit.eventId === event.id);
    expect(eventPits.every((pit) =>
      Math.hypot(pit.position.x - DEFAULT_ANCHOR.x, pit.position.y - DEFAULT_ANCHOR.y) > 85))
      .toBe(true);
    for (const pit of eventPits) {
      expect(engine.dispatch({
        type: "paint",
        terrain: "water",
        point: pit.position,
        radius: 6,
      }).ok).toBe(true);
    }
    snapshot = engine.getSnapshot();
    expect(snapshot.events.find((candidate) => candidate.id === event.id)!.status).toBe("resolved");
    expect(snapshot.villagers.every((villager) =>
      villager.status !== "trapped" && villager.trappedByPitId === undefined)).toBe(true);
    expect(snapshot.timeline.some((entry) =>
      entry.kind === "outcome" && entry.summary.includes(event.id))).toBe(true);
    expect(engine.drainPlanningEvents()).toEqual(expect.arrayContaining([{
      type: "hazard_changed",
      simulationTimeMs: 0,
      eventId: event.id,
      change: "resolved",
    }]));
  });

  it("publishes distinct created and resolved planning changes for an immediate earthquake", () => {
    const engine = new VillageEngine({ seed: 314 });

    expect(engine.dispatch({
      type: "trigger_earthquake",
      point: DEFAULT_ANCHOR,
    })).toMatchObject({ ok: true, value: { id: "event-1" } });

    expect(engine.getSnapshot().events[0]).toMatchObject({ status: "resolved" });
    expect(engine.getSnapshot().pits).toEqual([]);
    expect(engine.drainPlanningEvents()).toEqual([
      {
        type: "hazard_changed",
        simulationTimeMs: 0,
        eventId: "event-1",
        change: "created",
      },
      {
        type: "hazard_changed",
        simulationTimeMs: 0,
        eventId: "event-1",
        change: "resolved",
      },
    ]);
  });

  it("keeps a village-center earthquake actionable for the chief", () => {
    const engine = new VillageEngine({ seed: 42 });
    expect(engine.dispatch({ type: "place_totem", point: DEFAULT_ANCHOR }).ok).toBe(true);
    engine.drainPlanningEvents();

    expect(engine.dispatch({
      type: "trigger_earthquake",
      point: DEFAULT_ANCHOR,
    }).ok).toBe(true);

    const event = engine.getSnapshot().events.at(-1)!;
    const request = engine.createPlannerRequest([event.id]);
    expect(request.activeEvents).toEqual([expect.objectContaining({
      id: event.id,
      type: "earthquake",
      recommendedIntent: "rescue_trapped",
    })]);

    const plan = engine.createFallbackPlan(request);
    expect(plan.intents[0]).toMatchObject({
      type: "rescue_trapped",
      targetEventId: event.id,
    });
    expect(engine.executePlan(plan, "fallback")).toMatchObject({
      ok: true,
      value: { assignedCount: expect.any(Number) },
    });
    expect(engine.getSnapshot().villagerTasks.some((task) =>
      task.type === "rescue_trapped" && task.source === "fallback")).toBe(true);
  });

  it("extinguishes flooded fires and invalidates bandit paths in one terrain consequence", () => {
    const engine = new VillageEngine({ seed: 42 });
    const point = { x: 800, y: 560 };
    expect(engine.dispatch({ type: "trigger_fire", point }).ok).toBe(true);
    expect(engine.dispatch({ type: "place_totem", point: DEFAULT_ANCHOR }).ok).toBe(true);
    const villager = engine.getSnapshot().villagers[0]!;
    expect(engine.dispatch({ type: "trigger_bandits", point: { x: 900, y: 560 } }).ok).toBe(true);
    engine.tick();
    expect(engine.getSnapshot().hostiles.some((hostile) => (hostile.path?.length ?? 0) > 0)).toBe(true);
    engine.drainPlanningEvents();
    const before = engine.getSnapshot();
    const firePosition = before.fires[0]!.position;

    expect(engine.dispatch({ type: "paint", terrain: "water", point: firePosition, radius: 6 }).ok)
      .toBe(true);

    const after = engine.getSnapshot();
    expect(after.fires).toEqual([]);
    expect(after.events.find((event) => event.type === "fire")!.status).toBe("resolved");
    expect(after.hostiles.every((hostile) => hostile.path?.length === 0)).toBe(true);
    expect(after.hazardRevision).toBeGreaterThan(before.hazardRevision);
    expect(after.timeline.at(-1)!.summary).toContain("Terrain");
    expect(after.timeline.some((entry) => entry.kind === "outcome" && entry.summary.includes("fire")))
      .toBe(true);
    expect(engine.drainPlanningEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "terrain_changed" }),
      expect.objectContaining({ type: "hazard_changed" }),
    ]));
    expect(villager.id).toBeTruthy();
  });

  it("increments hazard revision when a blocked due fire attempt changes its published timer", () => {
    const engine = new VillageEngine({ seed: 42 });
    const point = { x: 800, y: 560 };
    expect(engine.dispatch({ type: "trigger_fire", point }).ok).toBe(true);
    const firePosition = engine.getSnapshot().fires[0]!.position;
    for (const neighbor of [
      { x: firePosition.x - 10, y: firePosition.y },
      { x: firePosition.x + 10, y: firePosition.y },
      { x: firePosition.x, y: firePosition.y - 10 },
      { x: firePosition.x, y: firePosition.y + 10 },
    ]) {
      expect(engine.dispatch({ type: "paint", terrain: "water", point: neighbor, radius: 6 }).ok)
        .toBe(true);
    }
    const before = engine.getSnapshot();
    for (let tick = 0; tick < 15; tick += 1) engine.tick();
    const after = engine.getSnapshot();

    expect(after.fires[0]!.lastSpreadAt).toBeGreaterThan(before.fires[0]!.lastSpreadAt);
    expect(after.hazardRevision).toBeGreaterThan(before.hazardRevision);
  });

  it.each([
    { terrain: "land" as const, point: DEFAULT_ANCHOR },
    { terrain: "water" as const, point: { x: 5, y: 5 } },
  ])("does not reconcile live bandits for a $terrain-on-$terrain no-op paint", ({ terrain, point }) => {
    const engine = new VillageEngine({ seed: 42 });
    expect(engine.dispatch({ type: "place_totem", point: DEFAULT_ANCHOR }).ok).toBe(true);
    expect(engine.dispatch({ type: "trigger_bandits", point: { x: 900, y: 560 } }).ok).toBe(true);
    engine.tick();
    const before = engine.getSnapshot();
    expect(before.hostiles.some((hostile) => Number.isFinite(hostile.lastPathAt))).toBe(true);

    expect(engine.dispatch({ type: "paint", terrain, point, radius: 6 }).ok).toBe(true);

    const after = engine.getSnapshot();
    expect(after.worldRevision).toBe(before.worldRevision + 1);
    expect(after.terrainRevision).toBe(before.terrainRevision);
    expect(after.structureRevision).toBe(before.structureRevision);
    expect(after.hazardRevision).toBe(before.hazardRevision);
    expect(after.unitRevision).toBe(before.unitRevision);
    expect(after.hostiles).toEqual(before.hostiles);
    expect(after.timeline).toEqual(before.timeline);
    expect(after.latestFeedback).toMatchObject({ kind: "success" });
  });

  it("clears replacement plague identity and bandit routes with truthful notifications", () => {
    const engine = new VillageEngine({ seed: 42 });
    expect(engine.dispatch({ type: "place_totem", point: DEFAULT_ANCHOR }).ok).toBe(true);
    const oldVillager = engine.getSnapshot().villagers[0]!;
    expect(engine.dispatch({ type: "trigger_plague", point: oldVillager.position }).ok).toBe(true);
    expect(engine.dispatch({ type: "trigger_bandits", point: { x: 900, y: 560 } }).ok).toBe(true);
    engine.tick();
    expect(engine.getSnapshot().hostiles.some((hostile) => hostile.targetId !== undefined)).toBe(true);
    engine.drainPlanningEvents();
    const before = engine.getSnapshot();

    expect(engine.dispatch({ type: "place_totem", point: DEFAULT_ANCHOR }).ok).toBe(true);

    const after = engine.getSnapshot();
    const plague = after.events.find((event) => event.type === "plague")!;
    expect(plague.status).toBe("resolved");
    expect(after.plagueCases).toEqual([]);
    expect(after.plagueExposures).toEqual([]);
    expect(after.villagers.every((villager) => villager.status !== "sick")).toBe(true);
    expect(after.hostiles.every((hostile) =>
      hostile.targetId === undefined
      && hostile.path?.length === 0
      && hostile.lastPathAt === Number.NEGATIVE_INFINITY)).toBe(true);
    expect(after.hazardRevision).toBe(before.hazardRevision + 1);
    expect(after.unitRevision).toBe(before.unitRevision + 1);
    expect(after.timeline.some((entry) =>
      entry.kind === "outcome" && entry.summary.includes(plague.id))).toBe(true);
    expect(engine.drainPlanningEvents()).toEqual(expect.arrayContaining([
      { type: "village_changed", simulationTimeMs: 100 },
      {
        type: "hazard_changed",
        simulationTimeMs: 100,
        eventId: plague.id,
        change: "resolved",
      },
      expect.objectContaining({
        type: "hazard_changed",
        simulationTimeMs: 100,
        change: "updated",
      }),
    ]));
    engine.tick();
    expect(engine.getSnapshot().hostiles.some((hostile) => hostile.targetId !== undefined)).toBe(true);
  });

  it("routes paint, totem, pause, and reset through deterministic commands", () => {
    const engine = new VillageEngine({ seed: 42 });

    expect(engine.dispatch({
      type: "paint",
      terrain: "water",
      point: { x: 645, y: 655 },
      radius: 6,
    }).ok).toBe(true);
    let snapshot = engine.getSnapshot();
    const paintedCell = cellIndex(worldToCell({ x: 645, y: 655 })!);
    expect(snapshot.terrain[paintedCell]).toBe(0);
    expect(snapshot.riverLike[paintedCell]).toBe(1);
    expect(snapshot.worldRevision).toBe(1);
    expect(snapshot.terrainRevision).toBe(1);
    expect(snapshot.structureRevision).toBe(0);
    expect(snapshot.hazardRevision).toBe(0);
    expect(snapshot.unitRevision).toBe(0);

    expect(engine.dispatch({ type: "place_totem", point: DEFAULT_ANCHOR }).ok).toBe(true);
    snapshot = engine.getSnapshot();
    expect(snapshot.activeVillage?.anchor).toEqual(DEFAULT_ANCHOR);
    expect(snapshot.activeVillage?.villagers.length).toBeGreaterThanOrEqual(12);
    expect(snapshot.structureRevision).toBe(1);
    expect(snapshot.unitRevision).toBe(1);
    expect(snapshot.terrainRevision).toBe(1);

    expect(engine.dispatch({ type: "toggle_pause" }).ok).toBe(true);
    expect(engine.getSnapshot().paused).toBe(true);

    expect(engine.dispatch({ type: "reset", seed: 42 }).ok).toBe(true);
    expect(engine.getSnapshot()).toEqual(new VillageEngine({ seed: 42 }).getSnapshot());
  });

  it("advances only unpaused exact 100 ms ticks", () => {
    const engine = new VillageEngine({ seed: 7 });
    const listener = vi.fn();
    const unsubscribe = engine.subscribe(listener);

    engine.tick(99);
    engine.tick(101);
    engine.tick(Number.NaN);
    expect(engine.getSnapshot().simulationTimeMs).toBe(0);
    expect(listener).not.toHaveBeenCalled();

    engine.tick();
    expect(engine.getSnapshot().simulationTimeMs).toBe(100);
    expect(engine.getSnapshot().worldRevision).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);

    expect(engine.dispatch({ type: "toggle_pause" }).ok).toBe(true);
    engine.tick(100);
    expect(engine.getSnapshot().simulationTimeMs).toBe(100);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    expect(engine.dispatch({ type: "toggle_pause" }).ok).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("publishes invalid-command feedback without partially applying the command", () => {
    const engine = new VillageEngine({ seed: 19 });
    const before = engine.getSnapshot();

    const result = engine.dispatch({
      type: "paint",
      terrain: "water",
      point: { x: Number.NaN, y: 400 },
      radius: 20,
    });

    expect(result.ok).toBe(false);
    const after = engine.getSnapshot();
    expect(after.terrain).toEqual(before.terrain);
    expect(after.terrainRevision).toBe(before.terrainRevision);
    expect(after.structureRevision).toBe(before.structureRevision);
    expect(after.hazardRevision).toBe(before.hazardRevision);
    expect(after.unitRevision).toBe(before.unitRevision);
    expect(after.timeline).toEqual(before.timeline);
    expect(after.latestFeedback).toMatchObject({ kind: "error" });
  });

  it.each([
    { type: "paint", terrain: "water", radius: 10 },
    { type: "place_totem", point: null },
    { type: "reset", seed: 1.5 },
    { type: "trigger_fire", point: null },
    { type: "trigger_tsunami", point: { x: Number.NaN, y: 10 } },
    { type: "trigger_bandits" },
    { type: "trigger_earthquake", point: "invalid" },
    { type: "trigger_plague", point: { x: 10 } },
    { type: "unknown_command" },
  ])("rejects malformed runtime command $type without throwing", (command) => {
    const engine = new VillageEngine({ seed: 19 });
    const before = engine.getSnapshot();
    const dispatchRuntime = engine.dispatch.bind(engine) as (value: unknown) => unknown;
    let result: unknown;

    expect(() => {
      result = dispatchRuntime(command);
    }).not.toThrow();
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_command" },
    });
    const after = engine.getSnapshot();
    expect(after.terrain).toEqual(before.terrain);
    expect(after.activeVillage).toEqual(before.activeVillage);
    expect(after.terrainRevision).toBe(before.terrainRevision);
    expect(after.latestFeedback).toMatchObject({ kind: "error" });
  });

  it("does not expose canonical terrain, entity, or nested village references", () => {
    const engine = new VillageEngine({ seed: 42 });
    expect(engine.dispatch({ type: "place_totem", point: DEFAULT_ANCHOR }).ok).toBe(true);
    expect(engine.getSnapshot()).toBe(engine.getSnapshot());
    const published = engine.getSnapshot();
    const originalTerrain = published.terrain[0];
    const originalX = published.villagers[0]!.position.x;
    const originalAnchorX = published.activeVillage!.anchor.x;

    attemptMutation(() => {
      (published.terrain as unknown as Uint8Array)[0] = originalTerrain === 0 ? 1 : 0;
    });
    attemptMutation(() => {
      (published.villagers as unknown as Villager[])[0]!.position.x = -999;
    });
    attemptMutation(() => {
      (published.activeVillage as unknown as VillageState).anchor.x = -999;
    });

    engine.tick(100);
    const fresh = engine.getSnapshot();
    expect(fresh).not.toBe(published);
    expect(fresh.terrain[0]).toBe(originalTerrain);
    expect(fresh.villagers[0]!.position.x).toBe(originalX);
    expect(fresh.activeVillage!.anchor.x).toBe(originalAnchorX);
  });

  it("cannot be corrupted before the next publication through bytes or nested values", () => {
    const engine = new VillageEngine({ seed: 42 });
    expect(engine.dispatch({ type: "place_totem", point: DEFAULT_ANCHOR }).ok).toBe(true);
    const published = engine.getSnapshot();
    const originalTerrain = [...published.terrain.slice(0, 3)];
    const originalVillager = structuredClone(published.villagers[0]);
    const originalRoadPoint = structuredClone(published.activeVillage!.roads[0]!.points[0]);
    const originalTimeline = structuredClone(published.timeline);
    const replacement = published.terrain[0] === 0 ? 1 : 0;

    attemptMutation(() => {
      (published.terrain as unknown as Uint8Array)[0] = replacement;
    });
    attemptMutation(() => {
      (published.terrain as unknown as Uint8Array).fill(replacement, 0, 3);
    });
    attemptMutation(() => {
      (published.terrain as unknown as Uint8Array).set(Uint8Array.of(replacement), 1);
    });
    attemptMutation(() => {
      (published.villagers as unknown as Villager[])[0]!.position.x = -999;
    });
    attemptMutation(() => {
      (published.activeVillage as unknown as VillageState).roads[0]!.points[0]!.y = -999;
    });
    attemptMutation(() => {
      (published.timeline as unknown as TimelineEntry[]).push({
        id: "forged",
        simulationTimeMs: 0,
        kind: "error",
        summary: "forged",
      });
    });

    const immediate = engine.getSnapshot();
    expect(immediate).toBe(published);
    expect([...immediate.terrain.slice(0, 3)]).toEqual(originalTerrain);
    expect(immediate.villagers[0]).toEqual(originalVillager);
    expect(immediate.activeVillage!.roads[0]!.points[0]).toEqual(originalRoadPoint);
    expect(immediate.timeline).toEqual(originalTimeline);
  });

  it("prevents one subscriber from corrupting the snapshot observed by a sibling", () => {
    const engine = new VillageEngine({ seed: 42 });
    expect(engine.dispatch({ type: "place_totem", point: DEFAULT_ANCHOR }).ok).toBe(true);
    const before = engine.getSnapshot();
    const originalTerrain = before.terrain[0];
    const originalTree = structuredClone(before.trees[0]);
    const originalSummary = before.timeline[0]!.summary;
    let siblingSnapshot = before;

    engine.subscribe(() => {
      const snapshot = engine.getSnapshot();
      attemptMutation(() => {
        (snapshot.terrain as unknown as Uint8Array).fill(originalTerrain === 0 ? 1 : 0);
      });
      attemptMutation(() => {
        (snapshot.trees as unknown as Tree[])[0]!.position.x = -999;
      });
      attemptMutation(() => {
        (snapshot.timeline as unknown as TimelineEntry[])[0]!.summary = "forged";
      });
    });
    engine.subscribe(() => {
      siblingSnapshot = engine.getSnapshot();
    });

    expect(engine.dispatch({ type: "toggle_pause" }).ok).toBe(true);
    expect(siblingSnapshot.terrain[0]).toBe(originalTerrain);
    expect(siblingSnapshot.trees[0]).toEqual(originalTree);
    expect(siblingSnapshot.timeline[0]!.summary).toBe(originalSummary);
  });

  it("does not expose the committed village through a successful command result", () => {
    const engine = new VillageEngine({ seed: 42 });
    const result = engine.dispatch({ type: "place_totem", point: DEFAULT_ANCHOR });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value === undefined) return;

    result.value.anchor.x = -999;
    result.value.villagers[0]!.position.x = -999;

    expect(engine.getSnapshot().activeVillage!.anchor).toEqual(DEFAULT_ANCHOR);
    expect(engine.getSnapshot().villagers[0]!.position.x).not.toBe(-999);
  });

  it("rejects a water stroke that would invalidate the active anchor atomically", () => {
    const engine = new VillageEngine({ seed: 42 });
    expect(engine.dispatch({ type: "place_totem", point: DEFAULT_ANCHOR }).ok).toBe(true);
    const before = engine.getSnapshot();

    const result = engine.dispatch({
      type: "paint",
      terrain: "water",
      point: DEFAULT_ANCHOR,
      radius: 20,
    });

    expect(result.ok).toBe(false);
    const after = engine.getSnapshot();
    expect(after.terrain).toEqual(before.terrain);
    expect(after.activeVillage).toEqual(before.activeVillage);
    expect(after.terrainRevision).toBe(before.terrainRevision);
    expect(after.structureRevision).toBe(before.structureRevision);
    expect(after.unitRevision).toBe(before.unitRevision);
    expect(after.latestFeedback?.message).toContain("anchor");
  });

  it("reconciles a water edit once and rebuilds derived terrain and bridges", () => {
    const engine = new VillageEngine({ seed: 42 });
    expect(engine.dispatch({ type: "place_totem", point: DEFAULT_ANCHOR }).ok).toBe(true);
    const before = engine.getSnapshot();
    const villager = before.villagers.find((candidate) =>
      Math.hypot(candidate.position.x - DEFAULT_ANCHOR.x, candidate.position.y - DEFAULT_ANCHOR.y)
        > 100,
    )!;

    expect(engine.dispatch({
      type: "paint",
      terrain: "water",
      point: villager.position,
      radius: 6,
    }).ok).toBe(true);

    const after = engine.getSnapshot();
    expect(after.villagers.find((candidate) => candidate.id === villager.id)?.position)
      .not.toEqual(villager.position);
    expect(after.riverLike).toEqual(expect.any(Array));
    expect(after.bridgeCells).toEqual(expect.any(Array));
    expect(after.terrainRevision).toBe(before.terrainRevision + 1);
    expect(after.unitRevision).toBe(before.unitRevision + 1);
    expect(after.timeline).toHaveLength(before.timeline.length + 1);
    expect(after.timeline.at(-1)?.summary).toContain("Terrain");
  });

  it("removes flooded tree decor as one bounded terrain consequence", () => {
    const engine = new VillageEngine({ seed: 42 });
    const before = engine.getSnapshot();
    expect(before.trees.length).toBeGreaterThan(0);
    const tree = before.trees[0]!;

    expect(engine.dispatch({
      type: "paint",
      terrain: "water",
      point: tree.position,
      radius: 6,
    }).ok).toBe(true);

    const after = engine.getSnapshot();
    expect(after.trees.some((candidate) => candidate.id === tree.id)).toBe(false);
    expect(after.structureRevision).toBe(1);
    expect(after.unitRevision).toBe(0);
    expect(after.timeline).toHaveLength(1);
    expect(after.timeline[0]!.summary).toContain("1 decor removed");
  });

  it("derives and clears bridge traversal cells when terrain creates a narrow road crossing", () => {
    const engine = new VillageEngine({ seed: 42 });
    expect(engine.dispatch({ type: "place_totem", point: DEFAULT_ANCHOR }).ok).toBe(true);
    const before = engine.getSnapshot();
    expect(before.activeVillage!.bridges).toHaveLength(0);
    const entrance = before.activeVillage!.roads.find((road) => road.role === "entrance")!;
    const start = entrance.points.at(-2)!;
    const end = entrance.points.at(-1)!;
    const crossingPoint = {
      x: (start.x + end.x) / 2,
      y: (start.y + end.y) / 2,
    };

    expect(engine.dispatch({
      type: "paint",
      terrain: "water",
      point: crossingPoint,
      radius: 6,
    }).ok).toBe(true);

    const bridged = engine.getSnapshot();
    expect(bridged.activeVillage!.bridges.length).toBeGreaterThan(0);
    const bridgeCells = bridged.activeVillage!.bridges.flatMap((bridge) => bridge.cells);
    expect(bridgeCells.length).toBeGreaterThan(0);
    for (const cell of bridgeCells) expect(bridged.bridgeCells[cellIndex(cell)]).toBe(1);

    expect(engine.dispatch({
      type: "paint",
      terrain: "land",
      point: crossingPoint,
      radius: 12,
    }).ok).toBe(true);

    const cleared = engine.getSnapshot();
    expect(cleared.activeVillage!.bridges).toHaveLength(0);
    for (const cell of bridgeCells) expect(cleared.bridgeCells[cellIndex(cell)]).toBe(0);
    expect(cleared.structureRevision).toBeGreaterThan(before.structureRevision);
    expect(cleared.timeline).toHaveLength(before.timeline.length + 2);
  });

  it("keeps only the latest feedback and the newest 200 timeline entries", () => {
    const engine = new VillageEngine({ seed: 314 });
    for (let index = 0; index < 205; index += 1) {
      expect(engine.dispatch({
        type: "paint",
        terrain: index % 2 === 0 ? "water" : "land",
        point: { x: 645, y: 655 },
        radius: 6,
      }).ok).toBe(true);
    }

    const snapshot = engine.getSnapshot();
    expect(snapshot.timeline).toHaveLength(200);
    expect(snapshot.timeline[0]!.id).toBe("timeline-6");
    expect(snapshot.timeline.at(-1)!.id).toBe("timeline-205");

    engine.dispatch({ type: "place_totem", point: { x: -5, y: -5 } });
    const firstFeedback = engine.getSnapshot().latestFeedback;
    engine.dispatch({
      type: "paint",
      terrain: "water",
      point: { x: Number.NaN, y: 0 },
      radius: 10,
    });
    expect(engine.getSnapshot().latestFeedback).not.toEqual(firstFeedback);
  });

  it("drains planning notifications without exposing the engine queue", () => {
    const engine = new VillageEngine({ seed: 42 });
    expect(engine.dispatch({ type: "place_totem", point: DEFAULT_ANCHOR }).ok).toBe(true);

    const events = engine.drainPlanningEvents();
    expect(events).toEqual([{ type: "village_changed", simulationTimeMs: 0 }]);
    events[0]!.simulationTimeMs = 999;
    expect(engine.drainPlanningEvents()).toEqual([]);
  });
});
