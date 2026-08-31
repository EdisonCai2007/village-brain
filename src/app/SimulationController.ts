import type {
  CommandResult,
  PlanningEvent,
  VillageState,
  WorldCommand,
  WorldEvent,
  WorldReadModel,
} from "../engine/types";
import type { PlannerStatus } from "./PlannerCoordinator";

const FIXED_STEP_MS = 100;
const MAX_CATCH_UP_TICKS = 5;
const UI_PUBLICATION_INTERVAL_MS = 100;

export type SimulationTool =
  | "land"
  | "water"
  | "totem"
  | "fire"
  | "tsunami"
  | "bandits"
  | "earthquake"
  | "plague"
  | "pan";

const SIMULATION_TOOLS: readonly SimulationTool[] = [
  "land",
  "water",
  "totem",
  "fire",
  "tsunami",
  "bandits",
  "earthquake",
  "plague",
  "pan",
];

export interface UiReadModel {
  readonly world: WorldReadModel;
  readonly tool: SimulationTool;
  readonly activeTool: SimulationTool;
  readonly brushRadius: number;
  readonly brushSize: number;
  readonly plannerStatus: PlannerStatus;
  readonly paused: boolean;
  readonly latestFeedback: WorldReadModel["latestFeedback"];
  readonly feedback: WorldReadModel["latestFeedback"];
}

export interface SimulationEnginePort {
  tick(stepMs: number): void;
  dispatch(command: WorldCommand): SimulationDispatchResult;
  getSnapshot(): WorldReadModel;
  drainPlanningEvents(): PlanningEvent[];
}

export type SimulationDispatchResult = CommandResult<undefined | VillageState | WorldEvent>;

export interface SimulationPlannerPort {
  readonly status: PlannerStatus;
  queueEvent(eventId: string): void;
  reset(): void;
  subscribeStatus(listener: (status: PlannerStatus) => void): () => void;
}

export interface VisibilityPort {
  isHidden(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface SimulationControllerOptions {
  engine: SimulationEnginePort;
  planner: SimulationPlannerPort;
  now?: () => number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (frameId: number) => void;
  visibility?: VisibilityPort;
}

type UiListener = () => void;

const defaultNow = (): number => performance.now();
const defaultRequestFrame = (callback: FrameRequestCallback): number =>
  requestAnimationFrame(callback);
const defaultCancelFrame = (frameId: number): void => cancelAnimationFrame(frameId);

const browserVisibility = (): VisibilityPort => ({
  isHidden: () => typeof document !== "undefined" && document.hidden,
  subscribe(listener) {
    if (typeof document === "undefined") return () => undefined;
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
});

const plannerEventId = (event: PlanningEvent): string =>
  event.type === "hazard_changed"
    ? event.eventId
    : `${event.type}:${event.simulationTimeMs}`;

export class SimulationController {
  readonly #engine: SimulationEnginePort;
  readonly #planner: SimulationPlannerPort;
  readonly #now: () => number;
  readonly #requestFrame: (callback: FrameRequestCallback) => number;
  readonly #cancelFrame: (frameId: number) => void;
  readonly #visibility: VisibilityPort;
  readonly #listeners = new Set<UiListener>();
  #tool: SimulationTool = "pan";
  #brushRadius = 30;
  #plannerStatus: PlannerStatus;
  #snapshot: UiReadModel;
  #running = false;
  #frameId: number | null = null;
  #lastFrameMs: number;
  #accumulatorMs = 0;
  #lastPublicationMs: number;
  #dirty = false;
  #unsubscribeVisibility: (() => void) | null = null;

  constructor({
    engine,
    planner,
    now = defaultNow,
    requestFrame = defaultRequestFrame,
    cancelFrame = defaultCancelFrame,
    visibility = browserVisibility(),
  }: SimulationControllerOptions) {
    this.#engine = engine;
    this.#planner = planner;
    this.#now = now;
    this.#requestFrame = requestFrame;
    this.#cancelFrame = cancelFrame;
    this.#visibility = visibility;
    this.#plannerStatus = planner.status;
    this.#lastFrameMs = now();
    this.#lastPublicationMs = this.#lastFrameMs;
    this.#snapshot = this.#createSnapshot();
    planner.subscribeStatus((status) => {
      this.#plannerStatus = status;
      this.#dirty = true;
    });
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#accumulatorMs = 0;
    this.#lastFrameMs = this.#now();
    this.#unsubscribeVisibility = this.#visibility.subscribe(this.#handleVisibilityChange);
    this.#scheduleFrame();
  }

  stop(): void {
    if (this.#frameId !== null) {
      this.#cancelFrame(this.#frameId);
      this.#frameId = null;
    }
    this.#running = false;
    this.#accumulatorMs = 0;
    this.#lastFrameMs = this.#now();
    this.#unsubscribeVisibility?.();
    this.#unsubscribeVisibility = null;
    this.#planner.reset();
  }

  dispatch(command: WorldCommand): SimulationDispatchResult {
    if (command.type === "reset") this.#planner.reset();
    const result = this.#engine.dispatch(command);
    this.#drainPlanningEvents();
    this.#dirty = true;
    return result;
  }

  setTool(tool: SimulationTool): void {
    if (!SIMULATION_TOOLS.includes(tool)) {
      throw new TypeError("Simulation tool is not recognized.");
    }
    if (this.#tool === tool) return;
    this.#tool = tool;
    this.#dirty = true;
  }

  setBrushSize(radius: number): void {
    if (!Number.isFinite(radius)) {
      throw new TypeError("Brush radius must be finite.");
    }
    const nextRadius = Math.max(10, Math.min(80, radius));
    if (this.#brushRadius === nextRadius) return;
    this.#brushRadius = nextRadius;
    this.#dirty = true;
  }

  subscribeUi(listener: UiListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getUiSnapshot(): UiReadModel {
    return this.#snapshot;
  }

  readonly #handleVisibilityChange = (): void => {
    this.#accumulatorMs = 0;
    this.#lastFrameMs = this.#now();
  };

  readonly #onFrame = (): void => {
    if (!this.#running) return;
    this.#frameId = null;
    const currentTime = this.#now();

    if (this.#visibility.isHidden()) {
      this.#accumulatorMs = 0;
      this.#lastFrameMs = currentTime;
      this.#scheduleFrame();
      return;
    }

    const elapsed = currentTime - this.#lastFrameMs;
    this.#lastFrameMs = currentTime;
    if (Number.isFinite(elapsed) && elapsed > 0) this.#accumulatorMs += elapsed;

    let tickCount = 0;
    while (this.#accumulatorMs >= FIXED_STEP_MS && tickCount < MAX_CATCH_UP_TICKS) {
      this.#engine.tick(FIXED_STEP_MS);
      this.#accumulatorMs -= FIXED_STEP_MS;
      tickCount += 1;
      this.#drainPlanningEvents();
    }
    if (tickCount === MAX_CATCH_UP_TICKS) this.#accumulatorMs = 0;
    if (tickCount > 0) this.#dirty = true;

    this.#publishIfReady(currentTime);
    this.#scheduleFrame();
  };

  #scheduleFrame(): void {
    if (!this.#running || this.#frameId !== null) return;
    this.#frameId = this.#requestFrame(this.#onFrame);
  }

  #drainPlanningEvents(): void {
    for (const event of this.#engine.drainPlanningEvents()) {
      this.#planner.queueEvent(plannerEventId(event));
    }
  }

  #publishIfReady(currentTime: number): void {
    if (!this.#dirty || currentTime - this.#lastPublicationMs < UI_PUBLICATION_INTERVAL_MS) return;
    this.#snapshot = this.#createSnapshot();
    this.#lastPublicationMs = currentTime;
    this.#dirty = false;
    for (const listener of this.#listeners) listener();
  }

  #createSnapshot(): UiReadModel {
    const world = this.#engine.getSnapshot();
    return Object.freeze({
      world,
      tool: this.#tool,
      activeTool: this.#tool,
      brushRadius: this.#brushRadius,
      brushSize: this.#brushRadius,
      plannerStatus: this.#plannerStatus,
      paused: world.paused,
      latestFeedback: world.latestFeedback,
      feedback: world.latestFeedback,
    });
  }
}
