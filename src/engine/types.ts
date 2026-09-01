export interface Point {
  x: number;
  y: number;
}

export interface Cell {
  x: number;
  y: number;
}

export type TerrainKind = "land" | "water";

export interface TerrainPaintCommand {
  type: "paint";
  terrain: TerrainKind;
  point: Point;
  radius: number;
}

export interface PlaceTotemCommand {
  type: "place_totem";
  point: Point;
}

export interface TogglePauseCommand {
  type: "toggle_pause";
}

export interface ResetWorldCommand {
  type: "reset";
  seed: number;
}

export type DisasterType = "fire" | "tsunami" | "bandits" | "earthquake" | "plague";

export interface TriggerFireCommand {
  type: "trigger_fire";
  point: Point;
}

export interface TriggerTsunamiCommand {
  type: "trigger_tsunami";
  point: Point;
}

export interface TriggerBanditsCommand {
  type: "trigger_bandits";
  point: Point;
}

export interface TriggerEarthquakeCommand {
  type: "trigger_earthquake";
  point: Point;
}

export interface TriggerPlagueCommand {
  type: "trigger_plague";
  point: Point;
}

export type DisasterCommand =
  | TriggerFireCommand
  | TriggerTsunamiCommand
  | TriggerBanditsCommand
  | TriggerEarthquakeCommand
  | TriggerPlagueCommand;

export type WorldCommand =
  | TerrainPaintCommand
  | PlaceTotemCommand
  | TogglePauseCommand
  | ResetWorldCommand
  | DisasterCommand;

export interface SeededRandom {
  readonly state: number;
  next(): number;
  nextInt(max: number): number;
}

export interface Villager {
  id: string;
  position: Point;
  houseId?: string;
  health?: number;
  status?: "idle" | "sick" | "trapped" | "dead";
  trappedByPitId?: string;
}

export type PlanSource = "ai" | "fallback";
export type TimelineSource = PlanSource | "deterministic";
export type TaskSource = PlanSource | "deterministic";

export type VillagerTaskType =
  | "fight_fire"
  | "defend_event"
  | "rescue_trapped"
  | "isolate_sick"
  | "relocate"
  | "found_village"
  | "split_villagers"
  | "rebuild_structure";

export type RebuildTargetKind = "house" | "road" | "wall" | "anchor";

export interface VillagerTask {
  id: string;
  villagerId: string;
  type: VillagerTaskType;
  targetEventId?: string;
  targetVillagerId?: string;
  targetHostileId?: string;
  targetStructureId?: string;
  targetStructureKind?: RebuildTargetKind;
  destination: Point;
  path: Point[];
  pathIndex: number;
  phase: "outbound" | "acting" | "returning";
  status: "active" | "completed" | "abandoned";
  sourcePlanId: string;
  source: TaskSource;
  createdAt: number;
  completedAt?: number;
}

export interface PlanHistoryEntry {
  planId: string;
  source: PlanSource;
  summary: string;
  outcome: string;
  simulationTimeMs: number;
  assignmentResults?: PlanAssignmentResult[];
}

export interface PlanAssignmentResult {
  intentIndex: number;
  type: VillagerTaskType;
  requestedCount: number;
  assignedCount: number;
  reason: string;
}

export interface Hostile {
  id: string;
  position: Point;
  eventId?: string;
  health?: number;
  targetId?: string;
  path?: Point[];
  pathIndex?: number;
  lastPathAt?: number;
  lastAttackAt?: number;
}

export interface Tree {
  id: string;
  position: Point;
}

export type RoadRole = "spine" | "entrance" | "branch";

export interface Road {
  id: string;
  role: RoadRole;
  parentId: string | null;
  points: Point[];
  health?: number;
  damaged?: boolean;
  rebuildProgress?: number;
}

export interface House {
  id: string;
  roadId: string;
  position: Point;
  frontage: Point;
  facing: number;
  health?: number;
  destroyed?: boolean;
  rebuildProgress?: number;
}

export interface WorldEvent {
  id: string;
  type: DisasterType;
  origin: Point;
  createdAt: number;
  updatedAt: number;
  status: "active" | "resolved";
  severity: number;
  facts: string[];
  nextFireCellSequence?: number;
}

export interface FireCell {
  id: string;
  eventId: string;
  cell: Cell;
  position: Point;
  intensity: number;
  createdAt: number;
  lastSpreadAt: number;
}

export interface TsunamiFront {
  id: string;
  eventId: string;
  origin: Point;
  position: Point;
  direction: Point;
  width: number;
  speed: number;
  ageMs: number;
  hitEntityIds: string[];
}

export interface EarthquakePit {
  id: string;
  eventId: string;
  position: Point;
  radius: number;
}

export interface PlagueExposure {
  eventId: string;
  exposedVillagerId: string;
  exposureMs: number;
}

export interface PlagueCase {
  eventId: string;
  villagerId: string;
  status: "susceptible" | "infected" | "recovered";
  infectedAt: number;
}

export interface Bridge {
  id: string;
  roadId: string;
  start: Point;
  end: Point;
  center: Point;
  angle: number;
  length: number;
  cells: Cell[];
}

export interface WallGate {
  id: string;
  roadId: string;
  point: Point;
  edgeIndex: number;
  width: number;
}

export interface WallSegment {
  start: Point;
  end: Point;
  health?: number;
  destroyed?: boolean;
  rebuildProgress?: number;
}

export interface VillageWall {
  polygon: Point[];
  segments: WallSegment[];
  gates: WallGate[];
}

export interface VillageState {
  seed: number;
  anchor: Point;
  roads: Road[];
  houses: House[];
  bridges: Bridge[];
  wall: VillageWall;
  villagers: Villager[];
  anchorDestroyed?: boolean;
  anchorRebuildProgress?: number;
}

export type TimelineKind =
  | "observation"
  | "planning"
  | "plan"
  | "execution"
  | "outcome"
  | "error"
  | "fallback";

export interface TimelineEntry {
  id: string;
  simulationTimeMs: number;
  kind: TimelineKind;
  summary: string;
  source?: TimelineSource;
}

export interface WorldFeedback {
  id: string;
  kind: "info" | "success" | "error";
  message: string;
}

export type PlanningEvent = {
  type: "village_changed" | "terrain_changed";
  simulationTimeMs: number;
} | {
  type: "hazard_changed";
  simulationTimeMs: number;
  eventId: string;
  change: "created" | "updated" | "resolved";
};

export interface WorldState {
  seed: number;
  simulationTimeMs: number;
  paused: boolean;
  random: SeededRandom;
  terrain: Uint8Array;
  riverLike: Uint8Array;
  terrainRevision: number;
  bridgeCells: Uint8Array;
  villagers: Villager[];
  hostiles: Hostile[];
  trees: Tree[];
  activeVillage: VillageState | null;
  events: WorldEvent[];
  fires: FireCell[];
  tsunamis: TsunamiFront[];
  pits: EarthquakePit[];
  plagueCases: PlagueCase[];
  plagueExposures: PlagueExposure[];
  villagerTasks: VillagerTask[];
  planHistory: PlanHistoryEntry[];
  foundedAnchors: Point[];
  timeline: TimelineEntry[];
  latestFeedback: WorldFeedback | null;
  worldRevision: number;
  structureRevision: number;
  hazardRevision: number;
  unitRevision: number;
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends Uint8Array
    ? readonly number[]
    : T extends readonly (infer Item)[]
      ? readonly DeepReadonly<Item>[]
      : T extends object
        ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
        : T;

export interface WorldReadModel {
  readonly seed: number;
  readonly simulationTimeMs: number;
  readonly paused: boolean;
  readonly terrain: readonly number[];
  readonly riverLike: readonly number[];
  readonly bridgeCells: readonly number[];
  readonly villagers: readonly DeepReadonly<Villager>[];
  readonly hostiles: readonly DeepReadonly<Hostile>[];
  readonly trees: readonly DeepReadonly<Tree>[];
  readonly activeVillage: DeepReadonly<VillageState> | null;
  readonly events: readonly DeepReadonly<WorldEvent>[];
  readonly fires: readonly DeepReadonly<FireCell>[];
  readonly tsunamis: readonly DeepReadonly<TsunamiFront>[];
  readonly pits: readonly DeepReadonly<EarthquakePit>[];
  readonly plagueCases: readonly DeepReadonly<PlagueCase>[];
  readonly plagueExposures: readonly DeepReadonly<PlagueExposure>[];
  readonly villagerTasks: readonly DeepReadonly<VillagerTask>[];
  readonly planHistory: readonly DeepReadonly<PlanHistoryEntry>[];
  readonly foundedAnchors: readonly DeepReadonly<Point>[];
  readonly timeline: readonly DeepReadonly<TimelineEntry>[];
  readonly latestFeedback: DeepReadonly<WorldFeedback> | null;
  readonly worldRevision: number;
  readonly terrainRevision: number;
  readonly structureRevision: number;
  readonly hazardRevision: number;
  readonly unitRevision: number;
}

export interface CommandError {
  code: "invalid_command" | "no_relocation";
  message: string;
}

export type CommandResult<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; error: CommandError };
