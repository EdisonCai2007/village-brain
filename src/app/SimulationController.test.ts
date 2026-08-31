import { describe, expect, it, vi } from "vitest";

import type { PlanningEvent, WorldCommand, WorldReadModel } from "../engine/types";
import type { PlannerStatus } from "./PlannerCoordinator";
import {
  SimulationController,
  type SimulationDispatchResult,
} from "./SimulationController";

class FrameHarness {
  nowMs = 0;
  nextId = 1;
  readonly frames = new Map<number, FrameRequestCallback>();
  readonly cancelled: number[] = [];

  readonly now = () => this.nowMs;

  readonly requestFrame = (callback: FrameRequestCallback): number => {
    const id = this.nextId++;
    this.frames.set(id, callback);
    return id;
  };

  readonly cancelFrame = (id: number): void => {
    this.cancelled.push(id);
    this.frames.delete(id);
  };

  advanceTo(nowMs: number): number {
    this.nowMs = nowMs;
    const entry = this.frames.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (entry === undefined) throw new Error("No animation frame was scheduled.");
    const [id, callback] = entry;
    this.frames.delete(id);
    callback(nowMs);
    return id;
  }

  pendingId(): number {
    const id = this.frames.keys().next().value as number | undefined;
    if (id === undefined) throw new Error("No animation frame was scheduled.");
    return id;
  }
}

class VisibilityHarness {
  hidden = false;
  readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of this.listeners) listener();
  }
}

class EngineHarness {
  readonly tickSteps: number[] = [];
  planningEvents: PlanningEvent[] = [];
  snapshot = createWorldSnapshot();

  tick(stepMs: number): void {
    this.tickSteps.push(stepMs);
    this.snapshot = Object.freeze({
      ...this.snapshot,
      simulationTimeMs: this.snapshot.simulationTimeMs + stepMs,
      worldRevision: this.snapshot.worldRevision + 1,
    });
  }

  dispatch(command: WorldCommand): SimulationDispatchResult {
    if (command.type === "toggle_pause") {
      this.snapshot = Object.freeze({ ...this.snapshot, paused: !this.snapshot.paused });
    } else if (command.type === "reset") {
      this.snapshot = createWorldSnapshot(command.seed);
    }
    return { ok: true, value: undefined };
  }

  getSnapshot(): WorldReadModel {
    return this.snapshot;
  }

  drainPlanningEvents(): PlanningEvent[] {
    const events = this.planningEvents;
    this.planningEvents = [];
    return events;
  }
}

const createWorldSnapshot = (seed = 42): WorldReadModel => Object.freeze({
  seed,
  simulationTimeMs: 0,
  paused: false,
  terrain: Object.freeze([]),
  riverLike: Object.freeze([]),
  bridgeCells: Object.freeze([]),
  villagers: Object.freeze([]),
  hostiles: Object.freeze([]),
  trees: Object.freeze([]),
  activeVillage: null,
  events: Object.freeze([]),
  fires: Object.freeze([]),
  tsunamis: Object.freeze([]),
  pits: Object.freeze([]),
  plagueCases: Object.freeze([]),
  plagueExposures: Object.freeze([]),
  villagerTasks: Object.freeze([]),
  planHistory: Object.freeze([]),
  foundedAnchors: Object.freeze([]),
  timeline: Object.freeze([]),
  latestFeedback: null,
  worldRevision: 0,
  terrainRevision: 0,
  structureRevision: 0,
  hazardRevision: 0,
  unitRevision: 0,
});

const createPlanner = () => {
  let status: PlannerStatus = "idle";
  const listeners = new Set<(next: PlannerStatus) => void>();
  return {
    get status() {
      return status;
    },
    queued: [] as string[],
    reset: vi.fn(),
    queueEvent(eventId: string) {
      this.queued.push(eventId);
    },
    subscribeStatus(listener: (next: PlannerStatus) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(next: PlannerStatus) {
      status = next;
      for (const listener of listeners) listener(next);
    },
  };
};

const createHarness = () => {
  const frames = new FrameHarness();
  const visibility = new VisibilityHarness();
  const engine = new EngineHarness();
  const planner = createPlanner();
  const controller = new SimulationController({
    engine,
    planner,
    now: frames.now,
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
    visibility: {
      isHidden: () => visibility.hidden,
      subscribe: visibility.subscribe,
    },
  });
  return { controller, engine, frames, planner, visibility };
};

describe("SimulationController", () => {
  it("starts with pan as the default tool", () => {
    const { controller } = createHarness();

    expect(controller.getUiSnapshot().activeTool).toBe("pan");
  });

  it("advances only complete 100 ms fixed steps", () => {
    const { controller, engine, frames } = createHarness();
    controller.start();

    frames.advanceTo(99);
    expect(engine.tickSteps).toEqual([]);
    frames.advanceTo(100);
    expect(engine.tickSteps).toEqual([100]);
  });

  it("caps one frame at five ticks and drops the excess accumulation", () => {
    const { controller, engine, frames } = createHarness();
    controller.start();

    frames.advanceTo(2_000);
    expect(engine.tickSteps).toEqual([100, 100, 100, 100, 100]);
    frames.advanceTo(2_099);
    expect(engine.tickSteps).toHaveLength(5);
    frames.advanceTo(2_100);
    expect(engine.tickSteps).toHaveLength(6);
  });

  it("starts once and stops the exact pending frame plus planner work", () => {
    const { controller, frames, planner } = createHarness();
    controller.start();
    controller.start();
    expect(frames.frames).toHaveLength(1);
    const pendingId = frames.pendingId();

    controller.stop();

    expect(frames.cancelled).toEqual([pendingId]);
    expect(frames.frames).toHaveLength(0);
    expect(planner.reset).toHaveBeenCalledOnce();
  });

  it("resets elapsed time while hidden so resume cannot replay background time", () => {
    const { controller, engine, frames, visibility } = createHarness();
    controller.start();
    frames.advanceTo(40);

    frames.nowMs = 10_000;
    visibility.setHidden(true);
    frames.advanceTo(60_000);
    visibility.setHidden(false);
    frames.advanceTo(60_099);
    expect(engine.tickSteps).toEqual([]);

    frames.advanceTo(60_100);
    expect(engine.tickSteps).toEqual([100]);
  });

  it("publishes immutable, identity-stable world/UI snapshots at no more than 10 Hz", () => {
    const { controller, frames, planner } = createHarness();
    const published: unknown[] = [];
    controller.subscribeUi(() => published.push(controller.getUiSnapshot()));
    const initial = controller.getUiSnapshot();
    controller.start();

    controller.setTool("water");
    controller.setBrushSize(64);
    planner.publish("collecting");
    for (let time = 10; time <= 1_000; time += 10) frames.advanceTo(time);

    expect(published).toHaveLength(10);
    expect(controller.getUiSnapshot()).toMatchObject({
      tool: "water",
      brushRadius: 64,
      plannerStatus: "collecting",
    });
    expect(controller.getUiSnapshot()).not.toBe(initial);
    expect(Object.isFrozen(controller.getUiSnapshot())).toBe(true);
    expect(Object.isFrozen(controller.getUiSnapshot().world)).toBe(true);
    expect(controller.getUiSnapshot()).toBe(controller.getUiSnapshot());
  });

  it("drains planning events after mutations and aborts planner work on reset", () => {
    const { controller, engine, planner } = createHarness();
    engine.planningEvents = [
      { type: "terrain_changed", simulationTimeMs: 0 },
      { type: "hazard_changed", simulationTimeMs: 0, eventId: "event-7", change: "created" },
    ];

    controller.dispatch({ type: "toggle_pause" });

    expect(planner.queued).toEqual(["terrain_changed:0", "event-7"]);
    expect(engine.planningEvents).toEqual([]);

    controller.dispatch({ type: "reset", seed: 99 });
    expect(planner.reset).toHaveBeenCalledOnce();
  });
});
