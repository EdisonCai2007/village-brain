import { MAX_SEARCH_CELLS } from "./constants";
import { findPath } from "./navigation";
import type { Point, Villager, WorldState } from "./types";

const FIXED_STEP_MS = 100;
const WANDER_START_DELAY_MS = 1_000;
const WANDER_SEGMENT_MS = 4_000;
const WANDER_SPEED_PER_SECOND = 14;
const WANDER_MOVE_PER_STEP = WANDER_SPEED_PER_SECOND * FIXED_STEP_MS / 1_000;
const WANDER_TARGET_REACHED_DISTANCE = 1.5;
const NEAR_CURRENT_TARGET_DISTANCE = 16;

const distance = (first: Point, second: Point): number =>
  Math.hypot(first.x - second.x, first.y - second.y);

const samePoint = (first: Point, second: Point): boolean =>
  distance(first, second) < 1e-9;

const isLivingIdleVillager = (villager: Villager): boolean =>
  (villager.health ?? 100) > 0
  && (villager.status ?? "idle") === "idle";

const moveToward = (from: Point, to: Point, maximum: number): Point => {
  const separation = distance(from, to);
  if (separation <= maximum || separation === 0) return { ...to };
  const ratio = maximum / separation;
  return {
    x: from.x + (to.x - from.x) * ratio,
    y: from.y + (to.y - from.y) * ratio,
  };
};

const hashText = (text: string): number => {
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
};

const collectWanderTargets = (world: WorldState): Point[] => {
  const village = world.activeVillage;
  if (village === null) return [];

  const targets: Point[] = [];
  const seen = new Set<string>();
  const add = (point: Point): void => {
    const key = `${Math.round(point.x * 10) / 10},${Math.round(point.y * 10) / 10}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ ...point });
  };

  for (const road of village.roads) {
    for (const point of road.points) add(point);
  }
  for (const house of village.houses) add(house.frontage);
  add(village.anchor);
  return targets;
};

const selectWanderTarget = (
  world: WorldState,
  villager: Villager,
  targets: readonly Point[],
): Point | null => {
  if (world.simulationTimeMs < WANDER_START_DELAY_MS || targets.length === 0) return null;
  const segment = Math.floor((world.simulationTimeMs - WANDER_START_DELAY_MS) / WANDER_SEGMENT_MS);
  const startIndex = hashText(`${world.seed}:${villager.id}:${segment}`) % targets.length;
  for (let offset = 0; offset < targets.length; offset += 1) {
    const target = targets[(startIndex + offset) % targets.length]!;
    if (distance(villager.position, target) > NEAR_CURRENT_TARGET_DISTANCE) return target;
  }
  return null;
};

const moveAlongPath = (villager: Villager, path: Point[]): boolean => {
  if (path.length === 0) return false;
  const initialIndex = path.length > 1
    && (
      samePoint(path[0]!, villager.position)
      || distance(villager.position, path[1]!) < distance(path[0]!, path[1]!)
    )
    ? 1
    : 0;
  const waypoint = path[initialIndex];
  if (waypoint === undefined) return false;
  const before = villager.position;
  villager.position = moveToward(villager.position, waypoint, WANDER_MOVE_PER_STEP);
  return !samePoint(before, villager.position);
};

export const updateIdleWandering = (world: WorldState, stepMs: number): boolean => {
  if (stepMs !== FIXED_STEP_MS || world.activeVillage === null) return false;
  const targets = collectWanderTargets(world);
  if (targets.length < 2) return false;

  const activeVillagerIds = new Set(
    world.villagerTasks
      .filter((task) => task.status === "active")
      .map((task) => task.villagerId),
  );
  let changed = false;
  for (const villager of world.villagers) {
    if (!isLivingIdleVillager(villager) || activeVillagerIds.has(villager.id)) continue;
    const target = selectWanderTarget(world, villager, targets);
    if (target === null || distance(villager.position, target) <= WANDER_TARGET_REACHED_DISTANCE) continue;
    const path = findPath(world, villager.position, target, MAX_SEARCH_CELLS);
    if (path === null) continue;
    if (!samePoint(path.at(-1)!, target)) path.push({ ...target });
    changed = moveAlongPath(villager, path) || changed;
  }
  return changed;
};

export const WANDERING_LIMITS = Object.freeze({
  fixedStepMs: FIXED_STEP_MS,
  startDelayMs: WANDER_START_DELAY_MS,
  segmentMs: WANDER_SEGMENT_MS,
  speedPerSecond: WANDER_SPEED_PER_SECOND,
});
