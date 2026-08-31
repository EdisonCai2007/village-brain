import {
  PlannerResponseSchema,
  type PlannerRequest,
  type PlannerResponse,
} from "../shared/planner-contract";
import { GRID_CELL_COUNT, MAX_SEARCH_CELLS } from "./constants";
import { createRandom } from "./random";
import {
  reconcileDisastersAfterVillageReplacement,
  reconcileDisastersAfterTerrain,
  triggerDisaster,
  updateDisasters,
} from "./disasters";
import {
  classifyRiverLike,
  createWorld,
  paintTerrain,
  reconcileTerrainEntities,
  type WorldTerrainMode,
} from "./terrain";
import type {
  CommandResult,
  DisasterCommand,
  PlanSource,
  PlaceTotemCommand,
  PlanningEvent,
  TimelineEntry,
  VillageState,
  WorldEvent,
  WorldCommand,
  WorldFeedback,
  WorldReadModel,
  WorldState,
} from "./types";
import {
  generateVillage,
  rebuildVillageBridges,
  villageAnchorIsValid,
} from "./village";
import { createFallbackPlan, createPlannerRequest } from "./planning";
import {
  assignPlanTasks,
  type IntentAssignmentResult,
  updateVillagerTasks,
} from "./tasks";
import { updateIdleWandering } from "./wandering";

const FIXED_STEP_MS = 100;
const MAX_TIMELINE_ENTRIES = 200;
const MAX_PLANNING_EVENTS = MAX_SEARCH_CELLS;
const MAX_TERRAIN_RELOCATION_CELLS = 256;

export interface VillageEngineOptions {
  seed: number;
  initialWorld?: WorldTerrainMode;
}

export interface PlanExecutionSummary {
  assignedCount: number;
  intentResults: IntentAssignmentResult[];
}

type EngineCommandResult = CommandResult<undefined | VillageState | WorldEvent>;
type Listener = () => void;

const isSeed = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

const isPoint = (value: unknown): value is { x: number; y: number } =>
  typeof value === "object"
  && value !== null
  && "x" in value
  && "y" in value
  && typeof value.x === "number"
  && Number.isFinite(value.x)
  && typeof value.y === "number"
  && Number.isFinite(value.y);

const cloneVillage = (village: VillageState | null): VillageState | null =>
  village === null ? null : structuredClone(village);

const cloneState = (state: WorldState): WorldState => {
  const activeVillage = cloneVillage(state.activeVillage);
  const villagers = activeVillage === null
    ? structuredClone(state.villagers)
    : activeVillage.villagers;
  return {
    ...state,
    random: createRandom(state.random.state),
    terrain: state.terrain.slice(),
    riverLike: state.riverLike.slice(),
    bridgeCells: state.bridgeCells.slice(),
    villagers,
    hostiles: structuredClone(state.hostiles),
    trees: structuredClone(state.trees),
    activeVillage,
    events: structuredClone(state.events),
    fires: structuredClone(state.fires),
    tsunamis: structuredClone(state.tsunamis),
    pits: structuredClone(state.pits),
    plagueCases: structuredClone(state.plagueCases),
    plagueExposures: structuredClone(state.plagueExposures),
    villagerTasks: structuredClone(state.villagerTasks),
    planHistory: structuredClone(state.planHistory),
    foundedAnchors: structuredClone(state.foundedAnchors),
    timeline: structuredClone(state.timeline),
    latestFeedback: state.latestFeedback === null
      ? null
      : structuredClone(state.latestFeedback),
  };
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
  }
  return value;
};

const createReadModel = (canonical: WorldState): WorldReadModel => {
  const state = cloneState(canonical);
  return deepFreeze({
    seed: state.seed,
    simulationTimeMs: state.simulationTimeMs,
    paused: state.paused,
    terrain: Array.from(state.terrain),
    riverLike: Array.from(state.riverLike),
    bridgeCells: Array.from(state.bridgeCells),
    villagers: state.villagers,
    hostiles: state.hostiles,
    trees: state.trees,
    activeVillage: state.activeVillage,
    events: state.events,
    fires: state.fires,
    tsunamis: state.tsunamis,
    pits: state.pits,
    plagueCases: state.plagueCases,
    plagueExposures: state.plagueExposures,
    villagerTasks: state.villagerTasks,
    planHistory: state.planHistory,
    foundedAnchors: state.foundedAnchors,
    timeline: state.timeline,
    latestFeedback: state.latestFeedback,
    worldRevision: state.worldRevision,
    terrainRevision: state.terrainRevision,
    structureRevision: state.structureRevision,
    hazardRevision: state.hazardRevision,
    unitRevision: state.unitRevision,
  });
};

const positionKey = (entities: readonly { id: string; position: { x: number; y: number } }[]): string =>
  entities.map((entity) => `${entity.id}:${entity.position.x},${entity.position.y}`)
    .join("|");

const countPositionChanges = (
  before: readonly { id: string; position: { x: number; y: number } }[],
  after: readonly { id: string; position: { x: number; y: number } }[],
): number => after.reduce((count, entity, index) => {
  const previous = before[index];
  return count + (previous?.id !== entity.id
    || previous.position.x !== entity.position.x
    || previous.position.y !== entity.position.y ? 1 : 0);
}, 0);

const bridgesKey = (village: VillageState | null): string =>
  village?.bridges.map((bridge) =>
    `${bridge.roadId}:${bridge.cells.map((cell) => `${cell.x},${cell.y}`).join(";")}`,
  ).join("|") ?? "";

export class VillageEngine {
  #state: WorldState;
  #snapshot: WorldReadModel;
  readonly #initialWorld: WorldTerrainMode;
  readonly #listeners = new Set<Listener>();
  #planningEvents: PlanningEvent[] = [];
  #timelineSequence = 0;
  #feedbackSequence = 0;
  #eventSequence = 0;
  #taskSequence = 0;

  constructor(options: VillageEngineOptions) {
    if (!isSeed(options?.seed)) {
      throw new TypeError("VillageEngine requires a safe integer seed.");
    }
    this.#initialWorld = options.initialWorld ?? "generated";
    this.#state = createWorld(options.seed, this.#initialWorld);
    this.#snapshot = createReadModel(this.#state);
  }

  dispatch(command: PlaceTotemCommand): CommandResult<VillageState>;
  dispatch(command: DisasterCommand): CommandResult<WorldEvent>;
  dispatch(command: WorldCommand): EngineCommandResult;
  dispatch(command: WorldCommand): EngineCommandResult {
    if (typeof command !== "object" || command === null || !("type" in command)) {
      return this.#reject("Commands require a recognized type.");
    }
    if (command.type === "toggle_pause") return this.#setPaused(!this.#state.paused);
    if (command.type === "reset") {
      if (!isSeed(command.seed)) return this.#reject("Reset commands require a safe integer seed.");
      this.reset(command.seed);
      return { ok: true, value: undefined };
    }
    if (command.type === "paint") {
      if (!isPoint(command.point)) {
        return this.#reject("Paint commands require finite coordinates and a positive radius.");
      }
      return this.#paint(command);
    }
    if (command.type === "place_totem") {
      if (!isPoint(command.point)) {
        return this.#reject("Village placement requires finite coordinates.");
      }
      return this.#placeTotem(command.point);
    }
    if (
      command.type === "trigger_fire"
      || command.type === "trigger_tsunami"
      || command.type === "trigger_bandits"
      || command.type === "trigger_earthquake"
      || command.type === "trigger_plague"
    ) {
      if (!isPoint(command.point)) {
        return this.#reject("Disaster placement requires finite coordinates.");
      }
      return this.#triggerDisaster(command);
    }
    return this.#reject("Commands require a recognized type.");
  }

  tick(stepMs = FIXED_STEP_MS): void {
    if (stepMs !== FIXED_STEP_MS || this.#state.paused) return;
    const disasterOutcome = updateDisasters(this.#state, FIXED_STEP_MS);
    const taskOutcome = updateVillagerTasks(this.#state, FIXED_STEP_MS);
    const wanderingChanged = updateIdleWandering(this.#state, FIXED_STEP_MS);
    if (disasterOutcome.hazardChanged || taskOutcome.hazardChanged) {
      this.#state.hazardRevision += 1;
    }
    if (disasterOutcome.unitChanged || taskOutcome.unitChanged || wanderingChanged) {
      this.#state.unitRevision += 1;
    }
    if (disasterOutcome.structureChanged || taskOutcome.structureChanged) {
      this.#state.structureRevision += 1;
    }
    const resolvedEventIds = new Set([
      ...disasterOutcome.resolvedEventIds,
      ...taskOutcome.resolvedEventIds,
    ]);
    for (const eventId of resolvedEventIds) {
      const event = this.#state.events.find((candidate) => candidate.id === eventId);
      if (event === undefined) continue;
      this.#appendTimeline(
        this.#state,
        "outcome",
        `${event.type} ${event.id} resolved.`,
      );
      this.#queuePlanningEvent({
        type: "hazard_changed",
        simulationTimeMs: this.#state.simulationTimeMs,
        eventId,
        change: "resolved",
      });
    }
    for (const eventId of taskOutcome.updatedEventIds) {
      if (resolvedEventIds.has(eventId)) continue;
      this.#queuePlanningEvent({
        type: "hazard_changed",
        simulationTimeMs: this.#state.simulationTimeMs,
        eventId,
        change: "updated",
      });
    }
    for (const record of taskOutcome.outcomes) {
      this.#appendTimeline(this.#state, "outcome", record.summary);
    }
    this.#state.worldRevision += 1;
    this.#publish();
  }

  createPlannerRequest(eventIds?: readonly string[]): PlannerRequest {
    const selectedEvents = eventIds === undefined
      ? this.#state.events
      : this.#state.events.filter((event) => eventIds.includes(event.id));
    return createPlannerRequest(this.#state, selectedEvents);
  }

  createFallbackPlan(request: PlannerRequest): PlannerResponse {
    return createFallbackPlan(request);
  }

  executePlan(
    response: PlannerResponse,
    source: PlanSource,
  ): CommandResult<PlanExecutionSummary>;
  executePlan(response: unknown, source: unknown): CommandResult<PlanExecutionSummary>;
  executePlan(response: unknown, source: unknown): CommandResult<PlanExecutionSummary> {
    let parsed: ReturnType<typeof PlannerResponseSchema.safeParse>;
    try {
      parsed = PlannerResponseSchema.safeParse(response);
    } catch {
      return this.#rejectPlan("Planner responses must match the strategic intent contract.");
    }
    if (!parsed.success || (source !== "ai" && source !== "fallback")) {
      return this.#rejectPlan("Planner responses must match the strategic intent contract.");
    }

    const draft = cloneState(this.#state);
    let assignment: ReturnType<typeof assignPlanTasks>;
    try {
      assignment = assignPlanTasks(
        draft,
        parsed.data,
        source,
        this.#taskSequence + 1,
      );
    } catch {
      return this.#rejectPlan("The validated plan could not be translated safely.");
    }
    const requestedCount = parsed.data.intents.reduce(
      (total, intent) => total + intent.villagerCount,
      0,
    );
    const actualDetails = assignment.intentResults.length === 0
      ? "no assignments requested"
      : assignment.intentResults
        .map((result) => `${result.type} requested ${result.requestedCount}, actual ${result.assignedCount} (${result.reason})`)
        .join(", ");
    this.#appendTimeline(
      draft,
      source === "fallback" ? "fallback" : "plan",
      `${source} plan ${parsed.data.planId}: ${parsed.data.summary}`,
      source,
    );
    this.#appendTimeline(
      draft,
      "execution",
      `${parsed.data.planId} execution: ${actualDetails}.`,
      source,
    );
    if (assignment.assignedCount === 0) {
      this.#appendTimeline(
        draft,
        "outcome",
        `${parsed.data.planId} completed with no executable assignments.`,
        source,
      );
    }
    draft.planHistory.push({
      planId: parsed.data.planId,
      source,
      summary: parsed.data.summary,
      outcome: `Assigned ${assignment.assignedCount} of ${requestedCount} requested villagers.`,
      simulationTimeMs: draft.simulationTimeMs,
      assignmentResults: assignment.intentResults.map((result) => ({ ...result })),
    });
    if (draft.planHistory.length > 5) {
      draft.planHistory.splice(0, draft.planHistory.length - 5);
    }
    if (assignment.assignedCount > 0) draft.unitRevision += 1;
    if (assignment.structureChanged) draft.structureRevision += 1;
    draft.worldRevision += 1;
    this.#setFeedback(
      draft,
      "success",
      `Plan ${parsed.data.planId} assigned ${assignment.assignedCount} villagers.`,
    );
    this.#state = draft;
    this.#taskSequence = assignment.nextTaskSequence - 1;
    this.#publish();
    return {
      ok: true,
      value: {
        assignedCount: assignment.assignedCount,
        intentResults: structuredClone(assignment.intentResults),
      },
    };
  }

  getSnapshot(): WorldReadModel {
    return this.#snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  drainPlanningEvents(): PlanningEvent[] {
    const drained = structuredClone(this.#planningEvents);
    this.#planningEvents = [];
    return drained;
  }

  reset(seed: number): void {
    if (!isSeed(seed)) throw new TypeError("Reset requires a safe integer seed.");
    this.#state = createWorld(seed, this.#initialWorld);
    this.#planningEvents = [];
    this.#timelineSequence = 0;
    this.#feedbackSequence = 0;
    this.#eventSequence = 0;
    this.#taskSequence = 0;
    this.#publish();
  }

  #paint(command: Extract<WorldCommand, { type: "paint" }>): EngineCommandResult {
    if (
      this.#state.villagers.length > MAX_SEARCH_CELLS
      || this.#state.hostiles.length > MAX_SEARCH_CELLS
      || this.#state.trees.length > MAX_SEARCH_CELLS
    ) {
      return this.#reject("Terrain entity collections cannot exceed 4096 items.");
    }
    const draft = cloneState(this.#state);
    const villagersBefore = structuredClone(draft.villagers);
    const hostilesBefore = positionKey(draft.hostiles);
    const bridgesBefore = bridgesKey(draft.activeVillage);
    const terrainRevisionBefore = draft.terrainRevision;
    const result = paintTerrain(draft, command);
    if (!result.ok) return this.#reject(result.error.message, result.error.code);

    const terrainChanged = draft.terrainRevision !== terrainRevisionBefore;
    if (!terrainChanged) {
      draft.worldRevision += 1;
      this.#setFeedback(draft, "success", "The terrain already matched the selected brush.");
      this.#state = draft;
      this.#publish();
      return { ok: true, value: undefined };
    }

    if (draft.activeVillage !== null && !villageAnchorIsValid(draft, draft.activeVillage)) {
      return this.#reject(
        "Terrain painting cannot invalidate the active village anchor.",
      );
    }

    const relocatedVillagers = countPositionChanges(villagersBefore, draft.villagers);
    const entityResult = reconcileTerrainEntities(draft, relocatedVillagers);
    if (!entityResult.ok) {
      return this.#reject(entityResult.error.message, entityResult.error.code);
    }
    const { relocatedHostiles, removedTrees } = entityResult.value;
    const hazardResult = reconcileDisastersAfterTerrain(draft);
    draft.riverLike = classifyRiverLike(draft);

    if (draft.activeVillage !== null) {
      draft.activeVillage.villagers = draft.villagers;
      const bridgeResult = rebuildVillageBridges(draft, draft.activeVillage);
      if (!bridgeResult.ok) {
        return this.#reject(bridgeResult.error.message, bridgeResult.error.code);
      }
    } else {
      draft.bridgeCells = new Uint8Array(GRID_CELL_COUNT);
    }

    const unitsChanged = relocatedVillagers > 0
      || relocatedHostiles > 0
      || hostilesBefore !== positionKey(draft.hostiles)
      || hazardResult.unitChanged;
    const bridgesChanged = bridgesBefore !== bridgesKey(draft.activeVillage);
    const structuresChanged = removedTrees > 0 || bridgesChanged;
    if (unitsChanged) draft.unitRevision += 1;
    if (structuresChanged) draft.structureRevision += 1;
    if (hazardResult.hazardChanged) draft.hazardRevision += 1;
    draft.worldRevision += 1;
    const hasVillageContext = draft.activeVillage !== null || draft.foundedAnchors.length > 0;

    if (terrainChanged || unitsChanged || structuresChanged || hazardResult.hazardChanged) {
      for (const eventId of hazardResult.resolvedEventIds) {
        const event = draft.events.find((candidate) => candidate.id === eventId);
        if (event === undefined) continue;
        this.#appendTimeline(draft, "outcome", `${event.type} ${event.id} resolved.`);
        if (hasVillageContext) {
          this.#queuePlanningEvent({
            type: "hazard_changed",
            simulationTimeMs: draft.simulationTimeMs,
            eventId,
            change: "resolved",
          });
        }
      }
      const details = [
        unitsChanged ? "units relocated" : "no unit relocations",
        removedTrees > 0 ? `${removedTrees} decor removed` : "decor preserved",
        bridgesChanged ? "derived bridges rebuilt" : "derived bridges unchanged",
        hazardResult.removedFires > 0
          ? `${hazardResult.removedFires} fires extinguished`
          : "fires unchanged",
        hazardResult.removedPits > 0
          ? `${hazardResult.removedPits} pits removed`
          : "pits unchanged",
        hazardResult.invalidatedBanditPaths > 0
          ? `${hazardResult.invalidatedBanditPaths} hostile routes invalidated`
          : "hostile routes unchanged",
      ].join(", ");
      this.#appendTimeline(draft, "outcome", `Terrain updated: ${details}.`);
      if (hasVillageContext) {
        this.#queuePlanningEvent({
          type: "terrain_changed",
          simulationTimeMs: draft.simulationTimeMs,
        });
      }
    }
    this.#setFeedback(draft, "success", terrainChanged
      ? "Terrain updated."
      : "The terrain already matched the selected brush.");
    this.#state = draft;
    this.#publish();
    return { ok: true, value: undefined };
  }

  #placeTotem(point: { x: number; y: number }): EngineCommandResult {
    const draft = cloneState(this.#state);
    const result = generateVillage(draft, point, draft.seed);
    if (!result.ok) return this.#reject(result.error.message, result.error.code);

    const hazardResult = reconcileDisastersAfterVillageReplacement(draft);
    for (const task of draft.villagerTasks) {
      if (task.status !== "active") continue;
      task.status = "abandoned";
      task.completedAt = draft.simulationTimeMs;
      this.#appendTimeline(draft, "outcome", `${task.id} was abandoned when the village changed.`);
    }
    draft.structureRevision += 1;
    draft.unitRevision += 1;
    if (hazardResult.hazardChanged) draft.hazardRevision += 1;
    draft.worldRevision += 1;
    this.#appendTimeline(
      draft,
      "observation",
      `Village established with ${result.value.houses.length} houses and ${result.value.villagers.length} villagers.`,
    );
    for (const eventId of hazardResult.resolvedEventIds) {
      const event = draft.events.find((candidate) => candidate.id === eventId);
      if (event === undefined) continue;
      this.#appendTimeline(draft, "outcome", `${event.type} ${event.id} resolved.`);
      this.#queuePlanningEvent({
        type: "hazard_changed",
        simulationTimeMs: draft.simulationTimeMs,
        eventId,
        change: "resolved",
      });
    }
    for (const eventId of hazardResult.updatedEventIds) {
      this.#queuePlanningEvent({
        type: "hazard_changed",
        simulationTimeMs: draft.simulationTimeMs,
        eventId,
        change: "updated",
      });
    }
    this.#setFeedback(draft, "success", "Village established.");
    this.#state = draft;
    this.#queuePlanningEvent({
      type: "village_changed",
      simulationTimeMs: draft.simulationTimeMs,
    });
    this.#publish();
    return { ok: true, value: structuredClone(result.value) };
  }

  #triggerDisaster(
    command: Extract<WorldCommand, { type: `trigger_${string}` }>,
  ): EngineCommandResult {
    const draft = cloneState(this.#state);
    const nextEventSequence = this.#eventSequence + 1;
    const result = triggerDisaster(draft, command, `event-${nextEventSequence}`);
    if (!result.ok) return this.#reject(result.error.message, result.error.code);

    this.#eventSequence = nextEventSequence;
    draft.hazardRevision += 1;
    if (result.value.unitChanged) draft.unitRevision += 1;
    if (result.value.structureChanged) draft.structureRevision += 1;
    draft.worldRevision += 1;
    this.#appendTimeline(
      draft,
      "observation",
      `${result.value.event.type} ${result.value.event.id} created.`,
    );
    if (result.value.resolvedImmediately) {
      this.#appendTimeline(
        draft,
        "outcome",
        `${result.value.event.type} ${result.value.event.id} pulse resolved.`,
      );
    }
    this.#setFeedback(draft, "success", `${result.value.event.type} triggered.`);
    this.#state = draft;
    this.#queuePlanningEvent({
      type: "hazard_changed",
      simulationTimeMs: draft.simulationTimeMs,
      eventId: result.value.event.id,
      change: "created",
    });
    if (result.value.resolvedImmediately) {
      this.#queuePlanningEvent({
        type: "hazard_changed",
        simulationTimeMs: draft.simulationTimeMs,
        eventId: result.value.event.id,
        change: "resolved",
      });
    }
    this.#publish();
    return { ok: true, value: structuredClone(result.value.event) };
  }

  #setPaused(paused: boolean): EngineCommandResult {
    this.#state.paused = paused;
    this.#state.worldRevision += 1;
    this.#setFeedback(this.#state, "info", paused ? "Simulation paused." : "Simulation resumed.");
    this.#publish();
    return { ok: true, value: undefined };
  }

  #reject(
    message: string,
    code: "invalid_command" | "no_relocation" = "invalid_command",
  ): EngineCommandResult {
    this.#state.worldRevision += 1;
    this.#setFeedback(this.#state, "error", message);
    this.#publish();
    return { ok: false, error: { code, message } };
  }

  #rejectPlan(message: string): CommandResult<PlanExecutionSummary> {
    this.#state.worldRevision += 1;
    this.#appendTimeline(this.#state, "error", message);
    this.#setFeedback(this.#state, "error", message);
    this.#publish();
    return { ok: false, error: { code: "invalid_command", message } };
  }

  #appendTimeline(
    state: WorldState,
    kind: TimelineEntry["kind"],
    summary: string,
    source?: TimelineEntry["source"],
  ): void {
    this.#timelineSequence += 1;
    state.timeline.push({
      id: `timeline-${this.#timelineSequence}`,
      simulationTimeMs: state.simulationTimeMs,
      kind,
      summary,
      ...(source === undefined ? {} : { source }),
    });
    if (state.timeline.length > MAX_TIMELINE_ENTRIES) {
      state.timeline.splice(0, state.timeline.length - MAX_TIMELINE_ENTRIES);
    }
  }

  #setFeedback(state: WorldState, kind: WorldFeedback["kind"], message: string): void {
    this.#feedbackSequence += 1;
    state.latestFeedback = {
      id: `feedback-${this.#feedbackSequence}`,
      kind,
      message,
    };
  }

  #queuePlanningEvent(event: PlanningEvent): void {
    this.#planningEvents.push(event);
    if (this.#planningEvents.length > MAX_PLANNING_EVENTS) {
      this.#planningEvents.splice(0, this.#planningEvents.length - MAX_PLANNING_EVENTS);
    }
  }

  #publish(): void {
    this.#snapshot = createReadModel(this.#state);
    for (const listener of [...this.#listeners]) listener();
  }
}

export const ENGINE_LIMITS = Object.freeze({
  fixedStepMs: FIXED_STEP_MS,
  maxTimelineEntries: MAX_TIMELINE_ENTRIES,
  maxPlanningEvents: MAX_PLANNING_EVENTS,
  maxTerrainRelocationCells: MAX_TERRAIN_RELOCATION_CELLS,
});
