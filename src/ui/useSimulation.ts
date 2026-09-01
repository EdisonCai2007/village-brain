import { useSyncExternalStore } from "react";

import type { TimelineKind, TimelineSource, WorldCommand, WorldReadModel } from "../engine/types";

export type ToolId =
  | "land"
  | "water"
  | "totem"
  | "fire"
  | "tsunami"
  | "bandits"
  | "earthquake"
  | "plague"
  | "pan";

export type PlannerStatus = "idle" | "collecting" | "planning" | "executing" | "unavailable";
export interface SimulationTimelineEntry {
  readonly id: string;
  readonly simulationTimeMs: number;
  readonly kind: TimelineKind;
  readonly summary: string;
  readonly details?: string;
  readonly source?: TimelineSource;
}

export interface SimulationSnapshot {
  readonly world: WorldReadModel | null;
  readonly plannerStatus: PlannerStatus;
  readonly activeTool: ToolId;
  readonly brushSize: number;
  readonly loading: boolean;
  readonly error: string | null;
  readonly latestFeedback: WorldReadModel["latestFeedback"];
  readonly timeline: readonly SimulationTimelineEntry[];
}

export interface SimulationController {
  getSnapshot(): SimulationSnapshot;
  getServerSnapshot?(): SimulationSnapshot;
  subscribe(listener: () => void): () => void;
  start(): void;
  stop(): void;
  selectTool(tool: ToolId): void;
  setBrushSize(size: number): void;
  togglePause(): void;
  reset(): void;
}

const DISCONNECTED_FEEDBACK = Object.freeze({
  id: "controller-unavailable",
  kind: "error",
  message: "The simulation could not start. Reload after the controller is connected.",
});

const DISCONNECTED_SNAPSHOT: SimulationSnapshot = Object.freeze({
  world: null,
  plannerStatus: "unavailable",
  activeTool: "land",
  brushSize: 28,
  loading: false,
  error: "Simulation unavailable",
  latestFeedback: DISCONNECTED_FEEDBACK,
  timeline: Object.freeze([]),
});

/** A safe shell adapter used until the application controller is injected. */
export function createDisconnectedController(): SimulationController {
  return {
    getSnapshot: () => DISCONNECTED_SNAPSHOT,
    getServerSnapshot: () => DISCONNECTED_SNAPSHOT,
    subscribe: () => () => undefined,
    start: () => undefined,
    stop: () => undefined,
    selectTool: () => undefined,
    setBrushSize: () => undefined,
    togglePause: () => undefined,
    reset: () => undefined,
  };
}

export interface SimulationApplicationSnapshot {
  readonly world: WorldReadModel;
  readonly activeTool: ToolId;
  readonly brushSize: number;
  readonly plannerStatus: Exclude<PlannerStatus, "unavailable">;
}

export interface SimulationApplicationPort {
  getUiSnapshot(): SimulationApplicationSnapshot;
  subscribeUi(listener: () => void): () => void;
  start(): void;
  stop(): void;
  setTool(tool: ToolId): void;
  setBrushSize(size: number): void;
  dispatch(command: WorldCommand): unknown;
}

/** Bridges the application-owned controller without coupling the UI to its class. */
export function adaptSimulationController(application: SimulationApplicationPort): SimulationController {
  let previousApplicationSnapshot: SimulationApplicationSnapshot | null = null;
  let previousSnapshot: SimulationSnapshot | null = null;

  const getSnapshot = (): SimulationSnapshot => {
    const current = application.getUiSnapshot();
    if (current === previousApplicationSnapshot && previousSnapshot !== null) return previousSnapshot;
    previousApplicationSnapshot = current;
    previousSnapshot = Object.freeze({
      world: current.world,
      plannerStatus: current.plannerStatus,
      activeTool: current.activeTool,
      brushSize: current.brushSize,
      loading: false,
      error: null,
      latestFeedback: current.world.latestFeedback,
      timeline: current.world.timeline,
    });
    return previousSnapshot;
  };

  return {
    getSnapshot,
    getServerSnapshot: getSnapshot,
    subscribe: (listener) => application.subscribeUi(listener),
    start: () => application.start(),
    stop: () => application.stop(),
    selectTool: (tool) => application.setTool(tool),
    setBrushSize: (size) => application.setBrushSize(size),
    togglePause: () => { application.dispatch({ type: "toggle_pause" }); },
    reset: () => { application.dispatch({ type: "reset", seed: application.getUiSnapshot().world.seed }); },
  };
}

export function useSimulation(controller: SimulationController): SimulationSnapshot {
  return useSyncExternalStore(
    controller.subscribe.bind(controller),
    controller.getSnapshot.bind(controller),
    (controller.getServerSnapshot ?? controller.getSnapshot).bind(controller),
  );
}
