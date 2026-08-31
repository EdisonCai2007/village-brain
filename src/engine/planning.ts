import type {
  PlannerIntent,
  PlannerRequest,
  PlannerResponse,
} from "../shared/planner-contract";
import { pointSegmentDistance } from "./geometry";
import { findDeterministicSafeAreas } from "./tasks";
import {
  deploymentCapForIntent,
  maxDeployableVillagers,
  minimumReserveVillagers,
} from "../shared/planner-policy";
import type {
  Point,
  Villager,
  WorldEvent,
  WorldState,
} from "./types";

const MAX_ACTIVE_EVENTS = 20;
const MAX_RECENT_PLANS = 5;
const MAX_EVENT_FACTS = 4;
const TSUNAMI_RELEVANCE_DISTANCE = 600;

const distance = (first: Point, second: Point): number =>
  Math.hypot(first.x - second.x, first.y - second.y);

const isLiving = (villager: Villager): boolean =>
  (villager.health ?? 100) > 0 && villager.status !== "dead";

const impactRadius = (event: WorldEvent): number => {
  if (event.type === "fire") return 80;
  if (event.type === "bandits") return 160;
  if (event.type === "earthquake") return 120;
  if (event.type === "plague") return 90;
  return 110;
};

type EventResponseIntent = Extract<
  PlannerIntent["type"],
  "fight_fire" | "defend_event" | "rescue_trapped" | "isolate_sick" | "relocate"
>;

const recommendedIntentFor = (type: WorldEvent["type"]): EventResponseIntent => {
  if (type === "fire") return "fight_fire";
  if (type === "bandits") return "defend_event";
  if (type === "earthquake") return "rescue_trapped";
  if (type === "plague") return "isolate_sick";
  return "relocate";
};

const maxUsefulVillagersFor = (
  event: WorldEvent,
  maxDeployable: number,
): number => {
  return Math.min(deploymentCapForIntent(recommendedIntentFor(event.type)), maxDeployable);
};

const threatensVillage = (
  world: WorldState,
  event: WorldEvent,
  impactCount: number,
): boolean => impactCount > 0 || (
  (world.activeVillage !== null || world.foundedAnchors.length > 0)
  && eventDistance(world, event) <= impactRadius(event) + 120
);

const tsunamiHitsPoint = (world: WorldState, event: WorldEvent, point: Point): boolean => {
  const front = world.tsunamis.find((candidate) => candidate.eventId === event.id);
  if (front === undefined) return distance(event.origin, point) <= TSUNAMI_RELEVANCE_DISTANCE;
  const destination = {
    x: front.position.x + front.direction.x * TSUNAMI_RELEVANCE_DISTANCE,
    y: front.position.y + front.direction.y * TSUNAMI_RELEVANCE_DISTANCE,
  };
  return pointSegmentDistance(point, front.position, destination) <= front.width / 2;
};

const likelyImpactCount = (world: WorldState, event: WorldEvent): number => {
  const points = [
    ...world.villagers.filter(isLiving).map((villager) => villager.position),
    ...(world.activeVillage?.houses ?? [])
      .filter((house) => (house.health ?? 100) > 0 && house.destroyed !== true)
      .map((house) => house.position),
  ];
  if (event.type === "tsunami") {
    return points.reduce((count, point) => count + (tsunamiHitsPoint(world, event, point) ? 1 : 0), 0);
  }
  const radius = impactRadius(event);
  return points.reduce((count, point) =>
    count + (distance(point, event.origin) <= radius ? 1 : 0), 0);
};

const eventDistance = (world: WorldState, event: WorldEvent): number => {
  const anchor = world.activeVillage?.anchor ?? world.foundedAnchors.at(-1);
  if (anchor === undefined) return 0;
  if (event.type === "tsunami") {
    const front = world.tsunamis.find((candidate) => candidate.eventId === event.id);
    if (front !== undefined) return Math.round(distance(front.position, anchor));
  }
  return Math.round(distance(event.origin, anchor));
};

const eventEta = (world: WorldState, event: WorldEvent): number | null => {
  if (event.type !== "tsunami") return null;
  const anchor = world.activeVillage?.anchor ?? world.foundedAnchors.at(-1);
  const front = world.tsunamis.find((candidate) => candidate.eventId === event.id);
  if (anchor === undefined || front === undefined || front.speed <= 0) return null;
  const relative = {
    x: anchor.x - front.position.x,
    y: anchor.y - front.position.y,
  };
  const forward = Math.max(0, relative.x * front.direction.x + relative.y * front.direction.y);
  return Math.max(0, Math.round(forward / front.speed * 1_000));
};

export const createPlannerRequest = (
  world: WorldState,
  events: readonly WorldEvent[] = world.events,
  requestId = `request-${world.worldRevision}-${world.simulationTimeMs}`,
): PlannerRequest => {
  const activeTaskIds = new Set(world.villagerTasks
    .filter((task) => task.status === "active")
    .map((task) => task.villagerId));
  const living = world.villagers.filter(isLiving);
  const availableVillagers = living.filter((villager) =>
    villager.status !== "trapped" && !activeTaskIds.has(villager.id)).length;
  const minimumReserve = minimumReserveVillagers(availableVillagers);
  const maxDeployable = maxDeployableVillagers(availableVillagers);
  const safeAreas = findDeterministicSafeAreas(
    world,
    "least_impacted_area",
    world.activeVillage?.anchor,
    20,
  ).map((area) => ({
    id: area.id,
    x: area.point.x,
    y: area.point.y,
    capacity: area.capacity,
  }));
  const activeEvents = events
    .filter((event) => event.status === "active")
    .slice(0, MAX_ACTIVE_EVENTS)
    .map((event) => {
      const impactCount = likelyImpactCount(world, event);
      const maxUsefulVillagers = maxUsefulVillagersFor(event, maxDeployable);
      return {
        id: event.id,
        type: event.type,
        x: event.origin.x,
        y: event.origin.y,
        severity: Math.max(1, Math.min(5, Math.ceil(event.severity / 20))),
        likelyImpactCount: impactCount,
        distanceToVillage: eventDistance(world, event),
        etaMs: eventEta(world, event),
        facts: event.facts.slice(0, MAX_EVENT_FACTS),
        recommendedIntent: recommendedIntentFor(event.type),
        recommendedVillagers: maxUsefulVillagers,
        maxUsefulVillagers,
        threatensVillage: threatensVillage(world, event, impactCount),
      };
    });
  return {
    requestId,
    world: {
      simulationTimeMs: world.simulationTimeMs,
      seed: world.seed,
      villageCount: (world.activeVillage === null ? 0 : 1) + world.foundedAnchors.length,
      availableVillagers,
      hasActiveVillage: world.activeVillage !== null,
      minimumReserveVillagers: minimumReserve,
      maxDeployableVillagers: maxDeployable,
      livingVillagers: living.length,
      sickVillagers: living.filter((villager) => villager.status === "sick").length,
      trappedVillagers: living.filter((villager) => villager.status === "trapped").length,
      assignedVillagers: activeTaskIds.size,
      safeAreas,
    },
    activeEvents,
    recentPlans: world.planHistory.slice(-MAX_RECENT_PLANS).map((plan) => ({
      planId: plan.planId,
      source: plan.source,
      summary: plan.summary,
      outcome: plan.outcome,
    })),
  };
};

const fallbackIntent = (
  event: PlannerRequest["activeEvents"][number],
  count: number,
): PlannerIntent => {
  if (event.type === "tsunami") return {
    type: "relocate",
    strategy: "least_impacted_area",
    targetEventId: event.id,
    villagerCount: count,
    priority: 1,
    rationale: "Move available villagers away from the incoming tsunami corridor.",
  };
  if (event.type === "fire") return {
    type: "fight_fire",
    targetEventId: event.id,
    villagerCount: Math.min(deploymentCapForIntent("fight_fire"), count),
    priority: 1,
    rationale: "Contain the active fire before it spreads farther.",
  };
  if (event.type === "bandits") return {
    type: "defend_event",
    targetEventId: event.id,
    villagerCount: Math.min(4, count),
    priority: 1,
    rationale: "Defend villagers and structures from active bandits.",
  };
  if (event.type === "earthquake") return {
    type: "rescue_trapped",
    targetEventId: event.id,
    villagerCount: Math.min(2, count),
    priority: 1,
    rationale: "Free villagers who remain trapped by earthquake pits.",
  };
  return {
    type: "isolate_sick",
    targetEventId: event.id,
    villagerCount: Math.min(3, count),
    priority: 1,
    rationale: "Separate infected villagers from the healthy population.",
  };
};

const fallbackPlanId = (requestId: string): string =>
  `fallback-${requestId}`.slice(0, 120);

const eventPriority = (type: WorldEvent["type"]): number => {
  if (type === "tsunami") return 1;
  if (type === "fire") return 2;
  if (type === "bandits") return 3;
  if (type === "earthquake") return 4;
  return 5;
};

const fallbackEventCap = (event: PlannerRequest["activeEvents"][number]): number => {
  const intent = recommendedIntentFor(event.type);
  return Math.max(0, Math.min(
    event.maxUsefulVillagers ?? deploymentCapForIntent(intent),
    deploymentCapForIntent(intent),
  ));
};

export const createFallbackPlan = (request: PlannerRequest): PlannerResponse => {
  const deployable = request.world.maxDeployableVillagers
    ?? maxDeployableVillagers(request.world.availableVillagers);
  const targets = request.activeEvents
    .map((event, index) => ({ event, index, cap: fallbackEventCap(event) }))
    .filter((target) => target.cap > 0)
    .sort((first, second) =>
      eventPriority(first.event.type) - eventPriority(second.event.type)
      || first.index - second.index)
    .slice(0, 5);
  if (targets.length === 0 || deployable <= 0) {
    return {
      planId: fallbackPlanId(request.requestId),
      summary: "No actionable active event has an available safe response.",
      intents: [],
    };
  }
  const counts = new Map<string, number>();
  let remaining = deployable;
  for (const target of targets) {
    if (remaining <= 0) break;
    counts.set(target.event.id, 1);
    remaining -= 1;
  }
  for (const target of targets) {
    if (remaining <= 0) break;
    const current = counts.get(target.event.id) ?? 0;
    if (current === 0) continue;
    const extra = Math.min(target.cap - current, remaining);
    if (extra <= 0) continue;
    counts.set(target.event.id, current + extra);
    remaining -= extra;
  }
  const intents = targets.flatMap((target, index) => {
    const count = counts.get(target.event.id) ?? 0;
    if (count <= 0) return [];
    return [{
      ...fallbackIntent(target.event, count),
      priority: Math.min(5, index + 1),
    }];
  });
  return {
    planId: fallbackPlanId(request.requestId),
    summary: `Deterministic emergency response for ${intents.length} active disaster${intents.length === 1 ? "" : "s"}.`,
    intents,
  };
};

export const PLANNING_LIMITS = Object.freeze({
  maxActiveEvents: MAX_ACTIVE_EVENTS,
  maxRecentPlans: MAX_RECENT_PLANS,
  maxEventFacts: MAX_EVENT_FACTS,
});
