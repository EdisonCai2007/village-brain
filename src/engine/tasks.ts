import type { PlannerIntent, PlannerResponse } from "../shared/planner-contract";
import {
  deploymentCapForIntent,
  maxDeployableVillagers,
} from "../shared/planner-policy";
import {
  CELL_SIZE,
  GRID_HEIGHT,
  GRID_WIDTH,
  MAX_SEARCH_CELLS,
} from "./constants";
import {
  applyBanditDefense,
  applyFireResponse,
  applyPitRescue,
} from "./disasters";
import {
  cellIndex,
  cellToWorld,
  fourWayNeighbors,
  pointSegmentDistance,
  worldToCell,
} from "./geometry";
import {
  residentCountForHouse,
  residentPositionsForHouse,
} from "./house-residents";
import { findPath, type BlockedArea } from "./navigation";
import { hasLandClearance, isLandPoint } from "./terrain";
import type {
  House,
  PlanSource,
  Point,
  RebuildTargetKind,
  Road,
  TaskSource,
  Villager,
  VillagerTask,
  VillagerTaskType,
  VillageState,
  WallSegment,
  WorldEvent,
  WorldState,
} from "./types";

const FIXED_STEP_MS = 100;
const TASK_SPEED_PER_SECOND = 40;
const TASK_MOVE_PER_STEP = TASK_SPEED_PER_SECOND * FIXED_STEP_MS / 1_000;
const ACTION_RANGE = 24;
const FIRE_RESPONSE_AMOUNT = 300;
const BANDIT_RESPONSE_DAMAGE = 25;
const MAX_TASK_HISTORY = 200;
const MAX_SAFE_AREAS = 20;
const MAX_SAFE_CANDIDATES = 256;
const SAFE_SAMPLE_STRIDE = 8;
const MAX_HAZARDS_FOR_SAFETY = 20;
const FOUNDING_CLEARANCE = 85;
const MIN_FOUNDING_SEPARATION = 160;
const MAX_SAFE_ROUTE_DISTANCE = 480;
const HOUSE_REBUILD_MS = 2_560;
const WALL_REBUILD_MS = 960;
const ROAD_REBUILD_MS = 960;
const ANCHOR_REBUILD_MS = 1_920;
const EMERGENCY_GATE_WIDTH = 34;
const EMERGENCY_GATE_MIN_WALL_REMAINDER = CELL_SIZE;
const EMERGENCY_GATE_ROAD_ID = "emergency";

export interface SafeAreaCandidate {
  id: string;
  point: Point;
  capacity: number;
  hazardDistance: number;
}

export interface IntentAssignmentResult {
  intentIndex: number;
  type: PlannerIntent["type"];
  requestedCount: number;
  assignedCount: number;
  reason:
    | "assigned"
    | "partial"
    | "stale_target"
    | "unavailable"
    | "no_route"
    | "no_actionable_target"
    | "deployment_cap"
    | "reserve_policy"
    | "founding_not_allowed";
}

export interface PlanTaskAssignmentOutcome {
  assignedCount: number;
  nextTaskSequence: number;
  intentResults: IntentAssignmentResult[];
  structureChanged: boolean;
}

export interface TaskOutcomeRecord {
  taskId: string;
  sourcePlanId: string;
  source: TaskSource;
  status: "completed" | "abandoned";
  summary: string;
}

export interface TaskTickOutcome {
  hazardChanged: boolean;
  unitChanged: boolean;
  structureChanged: boolean;
  resolvedEventIds: string[];
  updatedEventIds: string[];
  outcomes: TaskOutcomeRecord[];
}

const distance = (first: Point, second: Point): number =>
  Math.hypot(first.x - second.x, first.y - second.y);

const samePoint = (first: Point, second: Point): boolean =>
  distance(first, second) < 1e-9;

const pointAlong = (from: Point, to: Point, ratio: number): Point => ({
  x: from.x + (to.x - from.x) * ratio,
  y: from.y + (to.y - from.y) * ratio,
});

const segmentHit = (
  firstStart: Point,
  firstEnd: Point,
  secondStart: Point,
  secondEnd: Point,
): { point: Point; secondRatio: number } | null => {
  const firstX = firstEnd.x - firstStart.x;
  const firstY = firstEnd.y - firstStart.y;
  const secondX = secondEnd.x - secondStart.x;
  const secondY = secondEnd.y - secondStart.y;
  const denominator = firstX * secondY - firstY * secondX;
  if (Math.abs(denominator) < 1e-9) return null;
  const offsetX = secondStart.x - firstStart.x;
  const offsetY = secondStart.y - firstStart.y;
  const ratio = (offsetX * secondY - offsetY * secondX) / denominator;
  const otherRatio = (offsetX * firstY - offsetY * firstX) / denominator;
  if (ratio < 0 || ratio > 1 || otherRatio < 0 || otherRatio > 1) return null;
  return { point: pointAlong(firstStart, firstEnd, ratio), secondRatio: otherRatio };
};

const isLiving = (candidate: Villager): boolean =>
  (candidate.health ?? 100) > 0 && candidate.status !== "dead";

const isReserved = (world: WorldState, villagerId: string): boolean =>
  world.villagerTasks.some((task) =>
    task.villagerId === villagerId
    && task.status === "active");

const getActiveEvent = (world: WorldState, eventId: string | undefined): WorldEvent | undefined =>
  eventId === undefined
    ? undefined
    : world.events.find((event) => event.id === eventId && event.status === "active");

const expectedEventType = (type: PlannerIntent["type"]): WorldEvent["type"] | null => {
  if (type === "fight_fire") return "fire";
  if (type === "defend_event") return "bandits";
  if (type === "rescue_trapped") return "earthquake";
  if (type === "isolate_sick") return "plague";
  return null;
};

const availableVillagerCount = (world: WorldState): number => world.villagers.filter((villager) =>
  isLiving(villager)
  && villager.status !== "trapped"
  && !isReserved(world, villager.id)).length;

interface RouteResult {
  path: Point[];
  openedGate: boolean;
}

const activeEarthquakePits = (world: WorldState): BlockedArea[] => {
  const activeEarthquakeIds = new Set(world.events
    .filter((event) => event.type === "earthquake" && event.status === "active")
    .map((event) => event.id));
  return world.pits
    .filter((pit) => activeEarthquakeIds.has(pit.eventId))
    .map((pit) => ({ center: { ...pit.position }, radius: pit.radius }));
};

const boundedPath = (
  world: WorldState,
  from: Point,
  to: Point,
  blockedAreas: readonly BlockedArea[] = [],
): RouteResult | null => {
  const path = findPath(world, from, to, MAX_SEARCH_CELLS, blockedAreas);
  if (path !== null) {
    const normalized = normalizePath(from, to, path);
    return normalized === null ? null : { path: normalized, openedGate: false };
  }
  if (!openEmergencyGateForRoute(world, from, to, blockedAreas)) return null;
  const reachablePath = findPath(world, from, to, MAX_SEARCH_CELLS, blockedAreas);
  if (reachablePath === null) return null;
  const normalized = normalizePath(from, to, reachablePath);
  return normalized === null ? null : { path: normalized, openedGate: true };
};

const normalizePath = (from: Point, to: Point, path: Point[]): Point[] | null => {
  if (path.length === 0) return samePoint(from, to) ? [{ ...to }] : null;
  if (!samePoint(path.at(-1)!, to)) path.push({ ...to });
  return path;
};

const gateEdgeIndex = (village: VillageState, point: Point): number | null => {
  if (village.wall.polygon.length < 3) return null;
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < village.wall.polygon.length; index += 1) {
    const start = village.wall.polygon[index]!;
    const end = village.wall.polygon[(index + 1) % village.wall.polygon.length]!;
    const candidateDistance = pointSegmentDistance(point, start, end);
    if (candidateDistance >= nearestDistance) continue;
    nearestDistance = candidateDistance;
    nearestIndex = index;
  }
  return nearestIndex;
};

const nextEmergencyGateId = (village: VillageState): string => {
  const highest = village.wall.gates.reduce((max, gate) => {
    const match = /^emergency-gate-(\d+)$/.exec(gate.id);
    return match === null ? max : Math.max(max, Number.parseInt(match[1]!, 10));
  }, 0);
  return `emergency-gate-${highest + 1}`;
};

const openEmergencyGateAt = (
  world: WorldState,
  segmentIndex: number,
  ratio: number,
): boolean => {
  const village = world.activeVillage;
  if (village === null) return false;
  const segment = village.wall.segments[segmentIndex];
  if (segment === undefined || segment.destroyed === true) return false;
  const segmentLength = distance(segment.start, segment.end);
  if (segmentLength <= 0) return false;

  const clampedRatio = Math.max(0, Math.min(1, ratio));
  const gatePoint = pointAlong(segment.start, segment.end, clampedRatio);
  const halfGap = Math.min(EMERGENCY_GATE_WIDTH / 2, segmentLength / 2);
  const centerDistance = clampedRatio * segmentLength;
  const gapStartDistance = Math.max(0, centerDistance - halfGap);
  const gapEndDistance = Math.min(segmentLength, centerDistance + halfGap);
  const replacement: WallSegment[] = [];
  if (gapStartDistance > EMERGENCY_GATE_MIN_WALL_REMAINDER) {
    replacement.push({
      start: { ...segment.start },
      end: pointAlong(segment.start, segment.end, gapStartDistance / segmentLength),
    });
  }
  if (segmentLength - gapEndDistance > EMERGENCY_GATE_MIN_WALL_REMAINDER) {
    replacement.push({
      start: pointAlong(segment.start, segment.end, gapEndDistance / segmentLength),
      end: { ...segment.end },
    });
  }
  village.wall.segments.splice(segmentIndex, 1, ...replacement);

  const edgeIndex = gateEdgeIndex(village, gatePoint);
  if (edgeIndex !== null) {
    village.wall.gates.push({
      id: nextEmergencyGateId(village),
      roadId: EMERGENCY_GATE_ROAD_ID,
      point: gatePoint,
      edgeIndex,
      width: Math.min(EMERGENCY_GATE_WIDTH, segmentLength),
    });
  }
  return true;
};

const openEmergencyGateForRoute = (
  world: WorldState,
  from: Point,
  to: Point,
  blockedAreas: readonly BlockedArea[] = [],
): boolean => {
  const village = world.activeVillage;
  if (village === null) return false;
  const candidates = village.wall.segments
    .map((segment, segmentIndex) => {
      if (segment.destroyed === true) return null;
      const hit = segmentHit(from, to, segment.start, segment.end);
      if (hit === null) return null;
      return {
        segmentIndex,
        ratio: hit.secondRatio,
        score: distance(from, hit.point) + distance(hit.point, to),
      };
    })
    .filter((candidate): candidate is { segmentIndex: number; ratio: number; score: number } =>
      candidate !== null)
    .sort((first, second) =>
      first.score - second.score || first.segmentIndex - second.segmentIndex);

  for (const candidate of candidates) {
    const previousSegments = structuredClone(village.wall.segments);
    const previousGates = structuredClone(village.wall.gates);
    if (!openEmergencyGateAt(world, candidate.segmentIndex, candidate.ratio)) continue;
    if (findPath(world, from, to, MAX_SEARCH_CELLS, blockedAreas) !== null) return true;
    village.wall.segments = previousSegments;
    village.wall.gates = previousGates;
  }
  return false;
};

const pathIndexFor = (path: readonly Point[], position: Point): number => {
  if (path.length <= 1) return 0;
  const start = worldToCell(position);
  const firstWaypoint = worldToCell(path[0]!);
  return start !== null
    && firstWaypoint !== null
    && start.x === firstWaypoint.x
    && start.y === firstWaypoint.y
    ? 1
    : 0;
};

const safetyCandidates = (world: WorldState): SafeAreaCandidate[] => {
  const activeHazards = world.events
    .filter((event) => event.status === "active")
    .slice(0, MAX_HAZARDS_FOR_SAFETY);
  const candidates: SafeAreaCandidate[] = [];
  for (let y = 4; y < GRID_HEIGHT && candidates.length < MAX_SAFE_CANDIDATES; y += SAFE_SAMPLE_STRIDE) {
    for (let x = 4; x < GRID_WIDTH && candidates.length < MAX_SAFE_CANDIDATES; x += SAFE_SAMPLE_STRIDE) {
      if (world.terrain[cellIndex({ x, y })] !== 1) continue;
      const candidatePoint = cellToWorld({ x, y });
      const hazardDistance = activeHazards.length === 0
        ? Number.MAX_SAFE_INTEGER
        : Math.min(...activeHazards.map((event) => distance(candidatePoint, event.origin)));
      candidates.push({
        id: `safe-${x}-${y}`,
        point: candidatePoint,
        capacity: 12,
        hazardDistance,
      });
    }
  }
  return candidates;
};

export const findDeterministicSafeAreas = (
  world: WorldState,
  strategy: Extract<PlannerIntent, { strategy: string }>["strategy"] = "least_impacted_area",
  origin: Point = world.activeVillage?.anchor ?? { x: 640, y: 430 },
  limit = MAX_SAFE_AREAS,
): SafeAreaCandidate[] => {
  const candidates = safetyCandidates(world);
  const existingAnchors = [
    ...(world.activeVillage === null ? [] : [world.activeVillage.anchor]),
    ...world.foundedAnchors,
  ];
  let clearanceWork = MAX_SEARCH_CELLS;
  const withFoundingClearance = (candidate: SafeAreaCandidate): boolean => {
    if (strategy !== "new_village_site") return true;
    if (
      candidate.point.x < FOUNDING_CLEARANCE
      || candidate.point.y < FOUNDING_CLEARANCE
      || candidate.point.x > GRID_WIDTH * CELL_SIZE - FOUNDING_CLEARANCE
      || candidate.point.y > GRID_HEIGHT * CELL_SIZE - FOUNDING_CLEARANCE
      || existingAnchors.some((anchor) => distance(anchor, candidate.point) < MIN_FOUNDING_SEPARATION)
    ) return false;
    return hasLandClearance(world, candidate.point, FOUNDING_CLEARANCE, () => {
      if (clearanceWork <= 0) return false;
      clearanceWork -= 1;
      return true;
    });
  };
  const healthy = world.villagers.filter((villager) =>
    isLiving(villager) && villager.status !== "sick" && villager.status !== "trapped");
  const groupDistance = (candidate: SafeAreaCandidate): number => healthy.length === 0
    ? Number.MAX_SAFE_INTEGER
    : Math.min(...healthy.map((villager) => distance(candidate.point, villager.position)));
  return candidates
    .filter((candidate) =>
      distance(candidate.point, origin) <= MAX_SAFE_ROUTE_DISTANCE
      && withFoundingClearance(candidate))
    .sort((first, second) => {
      if (strategy === "nearest_safe_area") {
        const firstSafe = first.hazardDistance >= 120 ? 0 : 1;
        const secondSafe = second.hazardDistance >= 120 ? 0 : 1;
        return firstSafe - secondSafe
          || distance(first.point, origin) - distance(second.point, origin)
          || second.hazardDistance - first.hazardDistance
          || first.id.localeCompare(second.id);
      }
      if (strategy === "separate_groups") {
        return groupDistance(second) - groupDistance(first)
          || second.hazardDistance - first.hazardDistance
          || first.id.localeCompare(second.id);
      }
      if (strategy === "new_village_site") {
        const firstAnchorDistance = existingAnchors.length === 0
          ? Number.MAX_SAFE_INTEGER
          : Math.min(...existingAnchors.map((anchor) => distance(first.point, anchor)));
        const secondAnchorDistance = existingAnchors.length === 0
          ? Number.MAX_SAFE_INTEGER
          : Math.min(...existingAnchors.map((anchor) => distance(second.point, anchor)));
        return Math.min(second.hazardDistance, secondAnchorDistance)
          - Math.min(first.hazardDistance, firstAnchorDistance)
          || first.id.localeCompare(second.id);
      }
      return second.hazardDistance - first.hazardDistance
        || distance(first.point, origin) - distance(second.point, origin)
        || first.id.localeCompare(second.id);
    })
    .slice(0, Math.max(0, Math.min(Math.floor(limit), MAX_SAFE_AREAS)));
};

const rescueTarget = (world: WorldState, eventId: string, origin: Point): Villager | undefined => {
  const pitIds = new Set(
    world.pits.filter((pit) => pit.eventId === eventId).map((pit) => pit.id),
  );
  return world.villagers
    .filter((villager) =>
      villager.status === "trapped"
      && villager.trappedByPitId !== undefined
      && pitIds.has(villager.trappedByPitId))
    .sort((first, second) =>
      distance(first.position, origin) - distance(second.position, origin)
      || first.id.localeCompare(second.id))[0];
};

const rescueDestination = (world: WorldState, trapped: Villager): Point | null => {
  const pit = world.pits.find((candidate) => candidate.id === trapped.trappedByPitId);
  if (pit === undefined) return null;
  const offset = pit.radius + CELL_SIZE;
  const candidates = [
    { x: pit.position.x - offset, y: pit.position.y },
    { x: pit.position.x + offset, y: pit.position.y },
    { x: pit.position.x, y: pit.position.y - offset },
    { x: pit.position.x, y: pit.position.y + offset },
  ];
  return candidates.find((candidate) =>
    isLandPoint(world, candidate)
    && world.pits.every((other) => distance(candidate, other.position) > other.radius)) ?? null;
};

const rescueActionForVillager = (
  world: WorldState,
  eventId: string,
  rescuerPosition: Point,
): { targetVillagerId: string; point: Point } | null => {
  const trapped = rescueTarget(world, eventId, rescuerPosition);
  const destination = trapped === undefined ? null : rescueDestination(world, trapped);
  return trapped === undefined || destination === null
    ? null
    : { targetVillagerId: trapped.id, point: destination };
};

interface TaskActionPoint {
  point: Point;
  targetVillagerId?: string;
  targetHostileId?: string;
}

const fireAccessCandidates = (
  world: WorldState,
  eventId: string,
  origin: Point,
): Point[] => {
  const burning = new Set(
    world.fires
      .filter((fire) => fire.eventId === eventId && fire.intensity > 0)
      .map((fire) => cellIndex(fire.cell)),
  );
  const seen = new Set<number>();
  const candidates: { point: Point; fire: Point; fireId: string }[] = [];
  const fires = world.fires
    .filter((fire) => fire.eventId === eventId && fire.intensity > 0)
    .sort((first, second) =>
      distance(origin, first.position) - distance(origin, second.position)
      || first.id.localeCompare(second.id));
  for (const fire of fires) {
    for (const neighbor of fourWayNeighbors(fire.cell)) {
      const neighborIndex = cellIndex(neighbor);
      if (burning.has(neighborIndex) || seen.has(neighborIndex)) continue;
      seen.add(neighborIndex);
      const point = cellToWorld(neighbor);
      if (!isLandPoint(world, point) && world.bridgeCells[neighborIndex] !== 1) continue;
      candidates.push({ point, fire: fire.position, fireId: fire.id });
    }
  }
  return candidates
    .sort((first, second) =>
      distance(origin, first.point) - distance(origin, second.point)
      || distance(origin, first.fire) - distance(origin, second.fire)
      || first.fireId.localeCompare(second.fireId))
    .map((candidate) => candidate.point);
};

const fireActionForOrigin = (
  world: WorldState,
  eventId: string,
  origin: Point,
): TaskActionPoint | null => {
  const point = fireAccessCandidates(world, eventId, origin)[0];
  if (point !== undefined) return { point };
  const fire = world.fires
    .filter((candidate) => candidate.eventId === eventId && candidate.intensity > 0)
    .sort((first, second) =>
      distance(origin, first.position) - distance(origin, second.position)
      || first.id.localeCompare(second.id))[0];
  return fire === undefined ? null : { point: { ...fire.position } };
};

const fireActionForVillager = (
  world: WorldState,
  eventId: string,
  villager: Villager,
): { action: TaskActionPoint; path: Point[]; openedGate: boolean } | null => {
  const accessPoints = fireAccessCandidates(world, eventId, villager.position);
  for (const point of accessPoints) {
    const route = boundedPath(world, villager.position, point);
    if (route !== null) return { action: { point }, path: route.path, openedGate: route.openedGate };
  }
  const nearbyFire = world.fires
    .filter((fire) => fire.eventId === eventId && fire.intensity > 0)
    .sort((first, second) =>
      distance(villager.position, first.position) - distance(villager.position, second.position)
      || first.id.localeCompare(second.id))[0];
  if (
    accessPoints.length === 0
    && nearbyFire !== undefined
    && distance(villager.position, nearbyFire.position) <= ACTION_RANGE
  ) {
    return {
      action: { point: { ...villager.position } },
      path: [{ ...villager.position }],
      openedGate: false,
    };
  }
  return null;
};

const banditTargets = (world: WorldState, eventId: string) =>
  world.hostiles
    .filter((candidate) => candidate.eventId === eventId && (candidate.health ?? 100) > 0)
    .sort((first, second) => first.id.localeCompare(second.id));

const banditActionForOrigin = (
  world: WorldState,
  eventId: string,
  origin: Point,
): TaskActionPoint | null => {
  const hostile = banditTargets(world, eventId)
    .sort((first, second) =>
      distance(origin, first.position) - distance(origin, second.position)
      || first.id.localeCompare(second.id))[0];
  return hostile === undefined
    ? null
    : { point: hostile.position, targetHostileId: hostile.id };
};

const banditActionForVillager = (
  world: WorldState,
  eventId: string,
  villager: Villager,
  assignedCounts: ReadonlyMap<string, number> = new Map(),
  preferredHostileId?: string,
): { action: TaskActionPoint; path: Point[] | null; openedGate: boolean } | null => {
  const hostiles = banditTargets(world, eventId);
  const preferred = preferredHostileId === undefined
    ? undefined
    : hostiles.find((hostile) => hostile.id === preferredHostileId);
  const hostile = preferred ?? hostiles
    .sort((first, second) =>
      (assignedCounts.get(first.id) ?? 0) - (assignedCounts.get(second.id) ?? 0)
      || distance(villager.position, first.position) - distance(villager.position, second.position)
      || first.id.localeCompare(second.id))[0];
  if (hostile === undefined) return null;
  const route = boundedPath(world, villager.position, hostile.position);
  return {
    action: { point: hostile.position, targetHostileId: hostile.id },
    path: route?.path ?? null,
    openedGate: route?.openedGate ?? false,
  };
};

const actionPoint = (
  world: WorldState,
  intent: PlannerIntent,
  activeTarget: WorldEvent | undefined,
): TaskActionPoint | null => {
  if (intent.type === "fight_fire") {
    const origin = activeTarget?.origin ?? world.activeVillage?.anchor ?? { x: 640, y: 430 };
    return fireActionForOrigin(world, intent.targetEventId, origin);
  }
  if (intent.type === "defend_event") {
    const origin = activeTarget?.origin ?? world.activeVillage?.anchor ?? { x: 640, y: 430 };
    return banditActionForOrigin(world, intent.targetEventId, origin);
  }
  if (intent.type === "rescue_trapped") {
    const trapped = rescueTarget(world, intent.targetEventId, activeTarget!.origin);
    const destination = trapped === undefined ? null : rescueDestination(world, trapped);
    return trapped === undefined || destination === null
      ? null
      : { point: destination, targetVillagerId: trapped.id };
  }
  if (intent.type === "isolate_sick") {
    const safe = findDeterministicSafeAreas(
      world,
      "separate_groups",
      activeTarget!.origin,
      1,
    )[0];
    return safe === undefined ? null : { point: safe.point };
  }
  const origin = activeTarget?.origin ?? world.activeVillage?.anchor ?? { x: 640, y: 430 };
  const safe = findDeterministicSafeAreas(world, intent.strategy, origin, 1)[0];
  return safe === undefined ? null : { point: safe.point };
};

const eligibleVillagers = (
  world: WorldState,
  intent: PlannerIntent,
  target: Point,
  additionallyReserved: ReadonlySet<string>,
): Villager[] => {
  const infectedIds = intent.type === "isolate_sick"
    ? new Set(world.plagueCases
      .filter((plagueCase) =>
        plagueCase.eventId === intent.targetEventId && plagueCase.status === "infected")
      .map((plagueCase) => plagueCase.villagerId))
    : null;
  return world.villagers
    .filter((villager) =>
      isLiving(villager)
      && villager.status !== "trapped"
      && !isReserved(world, villager.id)
      && !additionallyReserved.has(villager.id)
      && (infectedIds === null || infectedIds.has(villager.id)))
    .sort((first, second) =>
      distance(first.position, target) - distance(second.position, target)
      || first.id.localeCompare(second.id));
};

type RecoveryTarget =
  | { id: string; kind: "house"; point: Point; house: House }
  | { id: string; kind: "road"; point: Point; road: Road }
  | { id: string; kind: "wall"; point: Point; segment: WallSegment; segmentIndex: number }
  | { id: string; kind: "anchor"; point: Point; village: VillageState };

const midpoint = (first: Point, second: Point): Point => ({
  x: (first.x + second.x) / 2,
  y: (first.y + second.y) / 2,
});

const houseHealth = (house: House): number => house.health ?? 100;

const needsHouseRebuild = (house: House): boolean =>
  house.destroyed === true || houseHealth(house) < 100;

const roadWorkPoint = (road: Road): Point => {
  const start = road.points[0];
  const end = road.points.at(-1);
  if (start === undefined || end === undefined) return { x: 640, y: 430 };
  return midpoint(start, end);
};

const recoveryTargets = (world: WorldState): RecoveryTarget[] => {
  const village = world.activeVillage;
  if (village === null) return [];
  const targets: RecoveryTarget[] = [];
  for (const house of village.houses) {
    if (needsHouseRebuild(house)) {
      targets.push({ id: `house:${house.id}`, kind: "house", point: house.position, house });
    }
  }
  for (const road of village.roads) {
    if (road.damaged === true) {
      targets.push({ id: `road:${road.id}`, kind: "road", point: roadWorkPoint(road), road });
    }
  }
  for (let index = 0; index < village.wall.segments.length; index += 1) {
    const segment = village.wall.segments[index]!;
    if (segment.destroyed === true) {
      targets.push({
        id: `wall:${index}`,
        kind: "wall",
        point: midpoint(segment.start, segment.end),
        segment,
        segmentIndex: index,
      });
    }
  }
  if (village.anchorDestroyed === true) {
    targets.push({ id: "anchor:village", kind: "anchor", point: village.anchor, village });
  }
  return targets;
};

const activeRebuildTargetIds = (world: WorldState): Set<string> =>
  new Set(world.villagerTasks
    .filter((task) => task.status === "active" && task.type === "rebuild_structure")
    .map((task) => task.targetStructureId)
    .filter((id): id is string => id !== undefined));

const idleRecoveryVillagers = (world: WorldState): Villager[] =>
  world.villagers
    .filter((villager) =>
      isLiving(villager)
      && villager.status !== "sick"
      && villager.status !== "trapped"
      && !isReserved(world, villager.id))
    .sort((first, second) => first.id.localeCompare(second.id));

const assignRecoveryTasks = (world: WorldState): { assigned: number; structureChanged: boolean } => {
  if (world.events.some((event) => event.type === "earthquake" && event.status === "active")) {
    return { assigned: 0, structureChanged: false };
  }
  const blockedTargets = activeRebuildTargetIds(world);
  const targets = recoveryTargets(world)
    .filter((target) => !blockedTargets.has(target.id));
  if (targets.length === 0) return { assigned: 0, structureChanged: false };

  let assigned = 0;
  let structureChanged = false;
  const reserved = new Set<string>();
  for (const target of targets) {
    const villager = idleRecoveryVillagers(world)
      .filter((candidate) => !reserved.has(candidate.id))
      .sort((first, second) =>
        distance(first.position, target.point) - distance(second.position, target.point)
        || first.id.localeCompare(second.id))[0];
    if (villager === undefined) break;
    const route = boundedPath(world, villager.position, target.point);
    if (route === null || !makeTaskHistorySlot(world)) continue;
    structureChanged = route.openedGate || structureChanged;
    world.villagerTasks.push({
      id: `rebuild-${world.simulationTimeMs}-${villager.id}-${target.id}`,
      villagerId: villager.id,
      type: "rebuild_structure",
      targetStructureId: target.id,
      targetStructureKind: target.kind,
      destination: { ...target.point },
      path: route.path,
      pathIndex: pathIndexFor(route.path, villager.position),
      phase: "outbound",
      status: "active",
      sourcePlanId: "deterministic-recovery",
      source: "deterministic",
      createdAt: world.simulationTimeMs,
    });
    reserved.add(villager.id);
    assigned += 1;
  }
  return { assigned, structureChanged };
};

const pruneTaskHistory = (world: WorldState): void => {
  if (world.villagerTasks.length <= MAX_TASK_HISTORY) return;
  const active = world.villagerTasks.filter((task) => task.status === "active");
  const retainedHistoryCount = Math.max(0, MAX_TASK_HISTORY - active.length);
  const history = world.villagerTasks
    .filter((task) => task.status !== "active")
    .slice(-retainedHistoryCount);
  world.villagerTasks = [...history, ...active].slice(-MAX_TASK_HISTORY);
};

const makeTaskHistorySlot = (world: WorldState): boolean => {
  if (world.villagerTasks.length < MAX_TASK_HISTORY) return true;
  const oldestFinished = world.villagerTasks.findIndex((task) => task.status !== "active");
  if (oldestFinished < 0) return false;
  world.villagerTasks.splice(oldestFinished, 1);
  return true;
};

export const assignPlanTasks = (
  world: WorldState,
  response: PlannerResponse,
  source: PlanSource,
  firstTaskSequence: number,
): PlanTaskAssignmentOutcome => {
  world.villagerTasks ??= [];
  world.foundedAnchors ??= [];
  const reserved = new Set<string>();
  const resultByIndex = new Map<number, IntentAssignmentResult>();
  let nextTaskSequence = firstTaskSequence;
  let assignedCount = 0;
  let structureChanged = false;
  let remainingDeployable = maxDeployableVillagers(availableVillagerCount(world));
  const ordered = response.intents
    .map((intent, intentIndex) => ({ intent, intentIndex }))
    .sort((first, second) =>
      first.intent.priority - second.intent.priority || first.intentIndex - second.intentIndex);

  for (const { intent, intentIndex } of ordered) {
    const targetEventId = "targetEventId" in intent ? intent.targetEventId : undefined;
    const targetEvent = getActiveEvent(world, targetEventId);
    const expectedType = expectedEventType(intent.type);
    const staleTarget = targetEventId !== undefined
      && (targetEvent === undefined || (expectedType !== null && targetEvent.type !== expectedType));
    if (staleTarget) {
      resultByIndex.set(intentIndex, {
        intentIndex,
        type: intent.type,
        requestedCount: intent.villagerCount,
        assignedCount: 0,
        reason: "stale_target",
      });
      continue;
    }
    if (
      intent.type === "found_village"
      && (
        world.activeVillage !== null
        || world.foundedAnchors.length > 0
        || world.events.some((event) => event.status === "active")
      )
    ) {
      resultByIndex.set(intentIndex, {
        intentIndex,
        type: intent.type,
        requestedCount: intent.villagerCount,
        assignedCount: 0,
        reason: "founding_not_allowed",
      });
      continue;
    }
    const action = actionPoint(world, intent, targetEvent);
    if (action === null) {
      resultByIndex.set(intentIndex, {
        intentIndex,
        type: intent.type,
        requestedCount: intent.villagerCount,
        assignedCount: 0,
        reason: "no_actionable_target",
      });
      continue;
    }
    const candidates = eligibleVillagers(world, intent, action.point, reserved);
    const deploymentCap = deploymentCapForIntent(intent.type);
    const limitReason = intent.villagerCount > deploymentCap
      ? "deployment_cap"
      : remainingDeployable < intent.villagerCount
        ? "reserve_policy"
        : undefined;
    const wanted = Math.min(
      intent.villagerCount,
      deploymentCap,
      remainingDeployable,
      candidates.length,
    );
    let assignedForIntent = 0;
    let routeFailures = 0;
    const assignedHostiles = new Map<string, number>();
    for (const candidate of candidates) {
      if (assignedForIntent >= wanted) break;
      const assignedAction = intent.type === "fight_fire" && targetEventId !== undefined
          ? fireActionForVillager(world, targetEventId, candidate)
          : intent.type === "defend_event" && targetEventId !== undefined
            ? banditActionForVillager(world, targetEventId, candidate, assignedHostiles)
            : (() => {
                const route = boundedPath(
                  world,
                  candidate.position,
                  action.point,
                  intent.type === "rescue_trapped" ? activeEarthquakePits(world) : [],
                );
                return {
                  action,
                  path: route?.path ?? null,
                  openedGate: route?.openedGate ?? false,
                };
              })();
      if (assignedAction === null || assignedAction.path === null) {
        routeFailures += 1;
        continue;
      }
      structureChanged = assignedAction.openedGate || structureChanged;
      const path = assignedAction.path;
      const taskAction = assignedAction.action;
      if (!makeTaskHistorySlot(world)) break;
      const task: VillagerTask = {
        id: `task-${nextTaskSequence}`,
        villagerId: candidate.id,
        type: intent.type as VillagerTaskType,
        ...(targetEventId === undefined ? {} : { targetEventId }),
        ...(taskAction.targetVillagerId === undefined ? {} : { targetVillagerId: taskAction.targetVillagerId }),
        ...(taskAction.targetHostileId === undefined ? {} : { targetHostileId: taskAction.targetHostileId }),
        destination: { ...taskAction.point },
        path,
        pathIndex: pathIndexFor(path, candidate.position),
        phase: "outbound",
        status: "active",
        sourcePlanId: response.planId,
        source,
        createdAt: world.simulationTimeMs,
      };
      world.villagerTasks.push(task);
      reserved.add(candidate.id);
      if (taskAction.targetHostileId !== undefined) {
        assignedHostiles.set(
          taskAction.targetHostileId,
          (assignedHostiles.get(taskAction.targetHostileId) ?? 0) + 1,
        );
      }
      assignedForIntent += 1;
      assignedCount += 1;
      nextTaskSequence += 1;
    }
    const reason = assignedForIntent === intent.villagerCount
      ? "assigned"
      : assignedForIntent === 0 && remainingDeployable === 0
        ? "reserve_policy"
        : assignedForIntent === 0 && routeFailures > 0
          ? "no_route"
          : limitReason !== undefined
            ? limitReason
      : assignedForIntent > 0
        ? "partial"
        : "unavailable";
    resultByIndex.set(intentIndex, {
      intentIndex,
      type: intent.type,
      requestedCount: intent.villagerCount,
      assignedCount: assignedForIntent,
      reason,
    });
    remainingDeployable -= assignedForIntent;
  }
  pruneTaskHistory(world);
  return {
    assignedCount,
    nextTaskSequence,
    intentResults: response.intents.map((_intent, index) => resultByIndex.get(index)!),
    structureChanged,
  };
};

const moveToward = (from: Point, to: Point, maximum: number): Point => {
  const separation = distance(from, to);
  if (separation <= maximum || separation === 0) return { ...to };
  const ratio = maximum / separation;
  return {
    x: from.x + (to.x - from.x) * ratio,
    y: from.y + (to.y - from.y) * ratio,
  };
};

const moveAlongTask = (villager: Villager, task: VillagerTask): boolean => {
  const waypoint = task.path[task.pathIndex];
  if (waypoint === undefined) return false;
  const before = villager.position;
  villager.position = moveToward(villager.position, waypoint, TASK_MOVE_PER_STEP);
  const changed = !samePoint(before, villager.position);
  if (samePoint(villager.position, waypoint) && task.pathIndex < task.path.length - 1) {
    task.pathIndex += 1;
  }
  return changed;
};

const atPathEnd = (villager: Villager, task: VillagerTask): boolean =>
  task.pathIndex >= task.path.length - 1
  && task.path[task.pathIndex] !== undefined
  && samePoint(villager.position, task.path[task.pathIndex]!);

const canActFromCurrentPosition = (villager: Villager, task: VillagerTask): boolean =>
  distance(villager.position, task.destination)
  <= (task.type === "fight_fire" ? TASK_MOVE_PER_STEP : ACTION_RANGE);

const hazardActionTask = (task: VillagerTask): boolean =>
  task.type === "fight_fire"
  || task.type === "defend_event"
  || task.type === "rescue_trapped";

const retargetHazardTask = (
  world: WorldState,
  task: VillagerTask,
  villager: Villager,
): { status: "ok" | "missing_target" | "no_route"; structureChanged: boolean } => {
  if (task.phase === "returning" || task.targetEventId === undefined) {
    return { status: "ok", structureChanged: false };
  }
  if (task.type === "fight_fire") {
    const next = fireActionForVillager(world, task.targetEventId, villager);
    if (next === null) return { status: "missing_target", structureChanged: false };
    const destinationChanged = !samePoint(task.destination, next.action.point);
    if (destinationChanged || task.phase === "acting") {
      task.destination = { ...next.action.point };
      task.path = next.path;
      task.pathIndex = pathIndexFor(next.path, villager.position);
      if (distance(villager.position, task.destination) > TASK_MOVE_PER_STEP) task.phase = "outbound";
    }
    return { status: "ok", structureChanged: next.openedGate };
  }
  if (task.type === "defend_event") {
    const next = banditActionForVillager(
      world,
      task.targetEventId,
      villager,
      new Map(),
      task.targetHostileId,
    );
    if (next === null) return { status: "missing_target", structureChanged: false };
    if (next.path === null && distance(villager.position, next.action.point) > ACTION_RANGE) {
      return { status: "no_route", structureChanged: next.openedGate };
    }
    const destinationChanged = !samePoint(task.destination, next.action.point)
      || task.targetHostileId !== next.action.targetHostileId;
    if (destinationChanged || task.phase === "acting") {
      task.targetHostileId = next.action.targetHostileId;
      task.destination = { ...next.action.point };
      if (next.path !== null) {
        task.path = next.path;
        task.pathIndex = pathIndexFor(next.path, villager.position);
      }
      if (distance(villager.position, task.destination) > ACTION_RANGE) task.phase = "outbound";
    }
    return { status: "ok", structureChanged: next.openedGate };
  }
  if (task.type === "rescue_trapped") {
    const next = rescueActionForVillager(world, task.targetEventId, villager.position);
    if (next === null) return { status: "missing_target", structureChanged: false };
    const destinationChanged = !samePoint(task.destination, next.point)
      || task.targetVillagerId !== next.targetVillagerId;
    if (!destinationChanged && task.phase !== "acting") {
      return { status: "ok", structureChanged: false };
    }
    const route = boundedPath(world, villager.position, next.point, activeEarthquakePits(world));
    if (route === null) return { status: "no_route", structureChanged: false };
    task.targetVillagerId = next.targetVillagerId;
    task.destination = { ...next.point };
    task.path = route.path;
    task.pathIndex = pathIndexFor(route.path, villager.position);
    task.phase = distance(villager.position, task.destination) > ACTION_RANGE
      ? "outbound"
      : "acting";
    return { status: "ok", structureChanged: route.openedGate };
  }
  return { status: "ok", structureChanged: false };
};

const transitionToReturn = (
  world: WorldState,
  task: VillagerTask,
  villager: Villager,
): { ok: boolean; structureChanged: boolean } => {
  const anchor = world.activeVillage?.anchor ?? world.foundedAnchors.at(-1);
  if (anchor === undefined || !isLandPoint(world, anchor)) {
    return { ok: false, structureChanged: false };
  }
  const route = boundedPath(world, villager.position, anchor);
  if (route === null) return { ok: false, structureChanged: false };
  task.destination = { ...anchor };
  task.path = route.path;
  task.pathIndex = pathIndexFor(route.path, villager.position);
  task.phase = "returning";
  return { ok: true, structureChanged: route.openedGate };
};

const finishTask = (
  world: WorldState,
  task: VillagerTask,
  status: "completed" | "abandoned",
  summary: string,
  outcomes: TaskOutcomeRecord[],
): void => {
  task.status = status;
  task.completedAt = world.simulationTimeMs;
  outcomes.push({
    taskId: task.id,
    sourcePlanId: task.sourcePlanId,
    source: task.source,
    status,
    summary,
  });
};

const refreshPlanOutcomes = (world: WorldState): void => {
  for (const history of world.planHistory) {
    const tasks = world.villagerTasks.filter((task) => task.sourcePlanId === history.planId);
    const completed = tasks.filter((task) => task.status === "completed").length;
    const abandoned = tasks.filter((task) => task.status === "abandoned").length;
    const active = tasks.filter((task) => task.status === "active").length;
    history.outcome = `${completed} completed, ${abandoned} abandoned, ${active} active.`;
  }
};

const recoveryTargetForTask = (
  world: WorldState,
  task: VillagerTask,
): RecoveryTarget | null => {
  const targetId = task.targetStructureId;
  if (targetId === undefined) return null;
  return recoveryTargets(world).find((target) => target.id === targetId) ?? null;
};

const progressStep = (
  current: number | undefined,
  stepMs: number,
  totalMs: number,
): number => Math.min(1, Math.max(0, current ?? 0) + stepMs / totalMs);

const nextVillagerId = (world: WorldState): string => {
  const highest = world.villagers.reduce((max, villager) => {
    const match = /^villager-(\d+)$/.exec(villager.id);
    return match === null ? max : Math.max(max, Number.parseInt(match[1]!, 10));
  }, 0);
  return `villager-${highest + 1}`;
};

const repopulateHouse = (world: WorldState, house: House): number => {
  const expectedCount = residentCountForHouse(world.seed, house.id);
  const livingResidents = world.villagers.filter((villager) =>
    villager.houseId === house.id && isLiving(villager)).length;
  const missing = Math.max(0, expectedCount - livingResidents);
  if (missing === 0) return 0;
  const positions = residentPositionsForHouse(house, expectedCount);
  for (let index = 0; index < missing; index += 1) {
    const position = positions[(livingResidents + index) % positions.length] ?? house.position;
    world.villagers.push({
      id: nextVillagerId(world),
      houseId: house.id,
      position: { ...position },
      health: 100,
      status: "idle",
    });
  }
  if (world.activeVillage !== null) world.activeVillage.villagers = world.villagers;
  return missing;
};

const applyRebuildWork = (
  world: WorldState,
  target: RecoveryTarget,
  stepMs: number,
): { completed: boolean; spawnedVillagers: number; label: string } => {
  if (target.kind === "house") {
    const baseline = target.house.rebuildProgress ?? houseHealth(target.house) / 100;
    target.house.rebuildProgress = progressStep(baseline, stepMs, HOUSE_REBUILD_MS);
    target.house.health = Math.round(target.house.rebuildProgress * 100);
    if (target.house.rebuildProgress < 1) {
      return { completed: false, spawnedVillagers: 0, label: target.house.id };
    }
    target.house.health = 100;
    target.house.destroyed = false;
    delete target.house.rebuildProgress;
    const spawnedVillagers = repopulateHouse(world, target.house);
    return { completed: true, spawnedVillagers, label: target.house.id };
  }
  if (target.kind === "road") {
    target.road.rebuildProgress = progressStep(target.road.rebuildProgress, stepMs, ROAD_REBUILD_MS);
    if (target.road.rebuildProgress < 1) {
      return { completed: false, spawnedVillagers: 0, label: target.road.id };
    }
    target.road.damaged = false;
    delete target.road.rebuildProgress;
    return { completed: true, spawnedVillagers: 0, label: target.road.id };
  }
  if (target.kind === "wall") {
    target.segment.rebuildProgress = progressStep(target.segment.rebuildProgress, stepMs, WALL_REBUILD_MS);
    if (target.segment.rebuildProgress < 1) {
      return { completed: false, spawnedVillagers: 0, label: `wall segment ${target.segmentIndex + 1}` };
    }
    target.segment.destroyed = false;
    delete target.segment.rebuildProgress;
    return { completed: true, spawnedVillagers: 0, label: `wall segment ${target.segmentIndex + 1}` };
  }
  target.village.anchorRebuildProgress = progressStep(
    target.village.anchorRebuildProgress,
    stepMs,
    ANCHOR_REBUILD_MS,
  );
  if (target.village.anchorRebuildProgress < 1) {
    return { completed: false, spawnedVillagers: 0, label: "village anchor" };
  }
  target.village.anchorDestroyed = false;
  delete target.village.anchorRebuildProgress;
  return { completed: true, spawnedVillagers: 0, label: "village anchor" };
};

export const updateVillagerTasks = (world: WorldState, stepMs: number): TaskTickOutcome => {
  const outcome: TaskTickOutcome = {
    hazardChanged: false,
    unitChanged: false,
    structureChanged: false,
    resolvedEventIds: [],
    updatedEventIds: [],
    outcomes: [],
  };
  if (stepMs !== FIXED_STEP_MS) return outcome;
  world.villagerTasks ??= [];
  world.planHistory ??= [];
  world.foundedAnchors ??= [];
  const recovery = assignRecoveryTasks(world);
  if (recovery.assigned > 0) outcome.unitChanged = true;
  outcome.structureChanged = recovery.structureChanged || outcome.structureChanged;
  const resolved = new Set<string>();
  const updated = new Set<string>();

  for (const task of world.villagerTasks.slice(0, MAX_TASK_HISTORY)) {
    if (task.status !== "active") continue;
    if (
      task.type === "rebuild_structure"
      && world.events.some((event) => event.type === "earthquake" && event.status === "active")
    ) {
      finishTask(world, task, "abandoned", `${task.id} deferred for earthquake rescue.`, outcome.outcomes);
      outcome.unitChanged = true;
      continue;
    }
    const villager = world.villagers.find((candidate) => candidate.id === task.villagerId);
    if (villager === undefined || !isLiving(villager) || villager.status === "trapped") {
      finishTask(world, task, "abandoned", `${task.id} lost its available villager.`, outcome.outcomes);
      outcome.unitChanged = true;
      continue;
    }

    const targetEvent = getActiveEvent(world, task.targetEventId);
    if (
      task.targetEventId !== undefined
      && targetEvent === undefined
      && hazardActionTask(task)
      && task.phase !== "returning"
    ) {
      const returned = transitionToReturn(world, task, villager);
      outcome.structureChanged = returned.structureChanged || outcome.structureChanged;
      if (!returned.ok) {
        finishTask(world, task, "abandoned", `${task.id} could not return safely.`, outcome.outcomes);
      }
      outcome.unitChanged = true;
    }

    if (task.status !== "active") continue;
    const retarget = retargetHazardTask(world, task, villager);
    outcome.structureChanged = retarget.structureChanged || outcome.structureChanged;
    if (retarget.status === "missing_target") {
      const returned = transitionToReturn(world, task, villager);
      outcome.structureChanged = returned.structureChanged || outcome.structureChanged;
      if (!returned.ok) {
        finishTask(world, task, "abandoned", `${task.id} lost its actionable target.`, outcome.outcomes);
      }
      outcome.unitChanged = true;
      continue;
    }
    if (retarget.status === "no_route") {
      finishTask(world, task, "abandoned", `${task.id} could not route to its moving target.`, outcome.outcomes);
      outcome.unitChanged = true;
      continue;
    }

    if (task.status !== "active") continue;
    if (task.phase === "outbound") {
      const closeEnough = hazardActionTask(task) && canActFromCurrentPosition(villager, task);
      if (closeEnough) {
        task.phase = "acting";
        outcome.unitChanged = true;
      } else {
        outcome.unitChanged = moveAlongTask(villager, task) || outcome.unitChanged;
        if (atPathEnd(villager, task)) {
          task.phase = "acting";
          outcome.unitChanged = true;
        }
      }
    }

    if (task.status !== "active") continue;
    if (task.phase === "acting") {
      if (task.type === "fight_fire" && task.targetEventId !== undefined) {
        const intervention = applyFireResponse(
          world,
          task.targetEventId,
          villager.position,
          FIRE_RESPONSE_AMOUNT,
        );
        outcome.hazardChanged = intervention.hazardChanged || outcome.hazardChanged;
        intervention.resolvedEventIds.forEach((id) => resolved.add(id));
        if (intervention.acted) updated.add(task.targetEventId);
        if (intervention.resolvedEventIds.length > 0) {
          const returned = transitionToReturn(world, task, villager);
          outcome.structureChanged = returned.structureChanged || outcome.structureChanged;
          if (!returned.ok) {
            finishTask(world, task, "abandoned", `${task.id} resolved its fire but could not return.`, outcome.outcomes);
          }
        }
      } else if (task.type === "defend_event" && task.targetEventId !== undefined) {
        const intervention = applyBanditDefense(
          world,
          task.targetEventId,
          villager.position,
          BANDIT_RESPONSE_DAMAGE,
          task.targetHostileId,
        );
        outcome.hazardChanged = intervention.hazardChanged || outcome.hazardChanged;
        outcome.unitChanged = intervention.unitChanged || outcome.unitChanged;
        intervention.resolvedEventIds.forEach((id) => resolved.add(id));
        if (intervention.acted) updated.add(task.targetEventId);
        if (intervention.resolvedEventIds.length > 0) {
          const returned = transitionToReturn(world, task, villager);
          outcome.structureChanged = returned.structureChanged || outcome.structureChanged;
          if (!returned.ok) {
            finishTask(world, task, "abandoned", `${task.id} resolved the bandits but could not return.`, outcome.outcomes);
          }
        }
      } else if (
        task.type === "rescue_trapped"
        && task.targetEventId !== undefined
        && task.targetVillagerId !== undefined
      ) {
        const intervention = applyPitRescue(
          world,
          task.targetEventId,
          villager.position,
          task.targetVillagerId,
        );
        outcome.hazardChanged = intervention.hazardChanged || outcome.hazardChanged;
        outcome.unitChanged = intervention.unitChanged || outcome.unitChanged;
        intervention.resolvedEventIds.forEach((id) => resolved.add(id));
        if (intervention.acted) updated.add(task.targetEventId);
        if (intervention.acted) {
          const next = retargetHazardTask(world, task, villager);
          outcome.structureChanged = next.structureChanged || outcome.structureChanged;
          if (next.status === "missing_target") {
            const returned = transitionToReturn(world, task, villager);
            outcome.structureChanged = returned.structureChanged || outcome.structureChanged;
            if (!returned.ok) {
              finishTask(world, task, "abandoned", `${task.id} rescued a villager but could not return.`, outcome.outcomes);
            }
          } else if (next.status === "no_route") {
            finishTask(world, task, "abandoned", `${task.id} could not reach the next trapped villager.`, outcome.outcomes);
          }
        }
      } else if (task.type === "rebuild_structure") {
        const target = recoveryTargetForTask(world, task);
        if (target === null) {
          finishTask(world, task, "completed", `${task.id} found no rebuild target.`, outcome.outcomes);
          outcome.unitChanged = true;
          continue;
        }
        const rebuild = applyRebuildWork(world, target, stepMs);
        outcome.structureChanged = true;
        outcome.unitChanged = rebuild.spawnedVillagers > 0 || outcome.unitChanged;
        if (rebuild.completed) {
          const repopulation = rebuild.spawnedVillagers > 0
            ? ` and welcomed ${rebuild.spawnedVillagers} villagers`
            : "";
          finishTask(
            world,
            task,
            "completed",
            `${task.id} rebuilt ${rebuild.label}${repopulation}.`,
            outcome.outcomes,
          );
          outcome.unitChanged = true;
        }
      } else {
        if (task.type === "found_village") {
          if (!world.foundedAnchors.some((anchor) => samePoint(anchor, task.destination))) {
            world.foundedAnchors.push({ ...task.destination });
            outcome.structureChanged = true;
          }
        }
        finishTask(world, task, "completed", `${task.id} completed ${task.type}.`, outcome.outcomes);
        outcome.unitChanged = true;
      }
    }

    if (task.status === "active" && task.phase === "returning") {
      outcome.unitChanged = moveAlongTask(villager, task) || outcome.unitChanged;
      if (atPathEnd(villager, task)) {
        finishTask(world, task, "completed", `${task.id} completed ${task.type} and returned.`, outcome.outcomes);
        outcome.unitChanged = true;
      }
    }
  }
  refreshPlanOutcomes(world);
  pruneTaskHistory(world);
  outcome.resolvedEventIds = [...resolved].sort((first, second) => first.localeCompare(second));
  outcome.updatedEventIds = [...updated]
    .filter((eventId) => !resolved.has(eventId))
    .sort((first, second) => first.localeCompare(second));
  return outcome;
};

export const TASK_LIMITS = Object.freeze({
  fixedStepMs: FIXED_STEP_MS,
  speedPerSecond: TASK_SPEED_PER_SECOND,
  maxTaskHistory: MAX_TASK_HISTORY,
  maxSafeAreas: MAX_SAFE_AREAS,
  maxSafeCandidates: MAX_SAFE_CANDIDATES,
});
