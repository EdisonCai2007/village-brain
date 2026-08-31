import {
  BANDIT_COUNT,
  BANDIT_PATH_INTERVAL_MS,
  CELL_SIZE,
  EARTHQUAKE_RADIUS,
  FIRE_INITIAL_INTENSITY,
  FIRE_SPREAD_INTERVAL_MS,
  MAX_FIRE_SPREADS_PER_UPDATE,
  MAX_EARTHQUAKE_PITS,
  MAX_ACTIVE_BANDIT_EVENTS,
  MAX_BANDIT_PATHFINDS_PER_TICK,
  MAX_FIRE_CELLS,
  MAX_PLAGUE_PAIR_CHECKS,
  MAX_PLAGUE_EXPOSURES,
  MAX_PLAGUE_PARTICIPANTS,
  MAX_ACTIVE_PLAGUE_EVENTS,
  MAX_SEARCH_CELLS,
  MAX_WORLD_EVENTS,
  MAX_TSUNAMI_HITS,
  PLAGUE_EXPOSURE_MS,
  PLAGUE_INITIAL_RADIUS,
  PLAGUE_PROXIMITY,
  PLAGUE_RECOVERY_MS,
  TERRAIN_LAND,
  TSUNAMI_LIFETIME_MS,
  TSUNAMI_SPEED,
  TSUNAMI_WIDTH,
} from "./constants";
import {
  cellIndex,
  cellToWorld,
  fourWayNeighbors,
  isCellInBounds,
  pointSegmentDistance,
  worldToCell,
} from "./geometry";
import { findPath } from "./navigation";
import { findNearestLand, isLandPoint } from "./terrain";
import type {
  CommandResult,
  DisasterCommand,
  EarthquakePit,
  FireCell,
  Hostile,
  House,
  PlagueExposure,
  PlagueCase,
  Point,
  TsunamiFront,
  Villager,
  WorldEvent,
  WorldState,
} from "./types";

const FIXED_STEP_MS = 100;
const FIRE_DAMAGE_PER_TICK = 5;
const TSUNAMI_CREST_DEPTH = 10;
const BANDIT_SPEED_PER_SECOND = 36;
const BANDIT_ATTACK_RANGE = 14;
const BANDIT_ATTACK_INTERVAL_MS = 500;
const BANDIT_DAMAGE = 10;
const BANDIT_HOUSE_DAMAGE = BANDIT_DAMAGE / 1.5;
const PIT_RADIUS = 14;
const EARTHQUAKE_PIT_TARGET_RADIUS = EARTHQUAKE_RADIUS + PIT_RADIUS;
const EARTHQUAKE_DAMAGE = 45;
const MAX_PIT_PLACEMENT_ATTEMPTS = 24;

export interface DisasterTriggerOutcome {
  event: WorldEvent;
  unitChanged: boolean;
  structureChanged: boolean;
  resolvedImmediately: boolean;
}

export interface DisasterTickOutcome {
  hazardChanged: boolean;
  unitChanged: boolean;
  structureChanged: boolean;
  resolvedEventIds: string[];
  banditPathfinds: number;
  plaguePairChecks: number;
}

export interface DisasterTerrainOutcome {
  hazardChanged: boolean;
  unitChanged: boolean;
  resolvedEventIds: string[];
  removedFires: number;
  removedPits: number;
  invalidatedBanditPaths: number;
}

export interface DisasterVillageReplacementOutcome {
  hazardChanged: boolean;
  unitChanged: boolean;
  resolvedEventIds: string[];
  updatedEventIds: string[];
}

export interface DisasterInterventionOutcome {
  acted: boolean;
  hazardChanged: boolean;
  unitChanged: boolean;
  resolvedEventIds: string[];
}

const failure = <T>(message: string): CommandResult<T> => ({
  ok: false,
  error: { code: "invalid_command", message },
});

const finitePoint = (point: Point): boolean =>
  Number.isFinite(point.x) && Number.isFinite(point.y) && worldToCell(point) !== null;

const distance = (first: Point, second: Point): number =>
  Math.hypot(first.x - second.x, first.y - second.y);

const villagerHealth = (villager: Villager): number => villager.health ?? 100;
const isLivingVillager = (villager: Villager): boolean =>
  villagerHealth(villager) > 0 && villager.status !== "dead";
const houseHealth = (house: House): number => house.health ?? 100;
const isStandingHouse = (house: House): boolean =>
  houseHealth(house) > 0 && house.destroyed !== true;

const activeEvent = (world: WorldState, eventId: string): WorldEvent | undefined =>
  world.events.find((event) => event.id === eventId && event.status === "active");

const pruneDestroyedVillageStructures = (world: WorldState): boolean => {
  const village = world.activeVillage;
  if (village === null) return false;
  let changed = false;

  for (const house of village.houses) {
    if (house.destroyed === true || houseHealth(house) <= 0) {
      if (house.health !== 0) {
        house.health = 0;
        changed = true;
      }
      if (house.destroyed !== true) {
        house.destroyed = true;
        changed = true;
      }
      if (house.rebuildProgress !== 0) {
        house.rebuildProgress = 0;
        changed = true;
      }
    } else if (houseHealth(house) < 100 && house.rebuildProgress === undefined) {
      house.rebuildProgress = houseHealth(house) / 100;
      changed = true;
    }
  }

  for (const road of village.roads) {
    if (road.damaged === true && road.rebuildProgress !== 0) {
      road.rebuildProgress = 0;
      changed = true;
    }
  }

  for (const segment of village.wall.segments) {
    if (segment.destroyed === true && segment.rebuildProgress !== 0) {
      segment.rebuildProgress = 0;
      changed = true;
    }
  }

  if (village.anchorDestroyed === true && village.anchorRebuildProgress !== 0) {
    village.anchorRebuildProgress = 0;
    changed = true;
  }

  return changed;
};

export const ensureDisasterState = (world: WorldState): WorldState => {
  // These fallbacks also make imported pre-Task-5 state safe at the module boundary.
  world.events ??= [];
  world.fires ??= [];
  world.tsunamis ??= [];
  world.pits ??= [];
  world.plagueCases ??= [];
  world.plagueExposures ??= [];
  return world;
};

const hasEventCapacity = (world: WorldState): boolean =>
  world.events.length < MAX_WORLD_EVENTS
  || world.events.some((event) => event.status === "resolved");

const pointTerrain = (world: WorldState, point: Point): number | null => {
  const cell = worldToCell(point);
  return cell === null ? null : world.terrain[cellIndex(cell)] ?? null;
};

const activeBanditEventCount = (world: WorldState): number =>
  world.events.filter((event) => event.type === "bandits" && event.status === "active").length;

const tsunamiCollisionPopulation = (world: WorldState): number =>
  world.villagers.length
  + world.trees.length
  + (world.activeVillage === null ? 0
    : world.activeVillage.houses.length
      + world.activeVillage.roads.length
      + world.activeVillage.wall.segments.length
      + 1);

export const validateDisasterTrigger = (
  world: WorldState,
  command: DisasterCommand,
): CommandResult => {
  ensureDisasterState(world);
  if (!finitePoint(command.point)) return failure("Disaster placement requires finite in-world coordinates.");
  if (!hasEventCapacity(world)) return failure("The active event limit has been reached.");
  const terrain = pointTerrain(world, command.point);
  if (command.type === "trigger_fire" && world.fires.length >= MAX_FIRE_CELLS) {
    return failure("The world fire-cell limit has been reached.");
  }
  if (
    command.type === "trigger_bandits"
    && activeBanditEventCount(world) >= MAX_ACTIVE_BANDIT_EVENTS
  ) return failure("The active bandit-event limit has been reached.");
  if (
    command.type === "trigger_plague"
    && world.events.filter((event) => event.type === "plague" && event.status === "active").length
      >= MAX_ACTIVE_PLAGUE_EVENTS
  ) return failure("The active plague-event limit has been reached.");
  if (command.type === "trigger_tsunami") {
    if (terrain === TERRAIN_LAND) return failure("Tsunamis must start on water.");
    if (findNearestLand(world, command.point, MAX_SEARCH_CELLS) === null) {
      return failure("A tsunami requires reachable land.");
    }
    if (tsunamiCollisionPopulation(world) > MAX_TSUNAMI_HITS) {
      return failure("The tsunami collision population exceeds the fixed hit budget.");
    }
    return { ok: true, value: undefined };
  }
  if (terrain !== TERRAIN_LAND) {
    return failure(`${command.type.replace("trigger_", "")} must start on land.`);
  }
  if (command.type === "trigger_plague") {
    const hasTarget = world.villagers.some((villager) =>
      isLivingVillager(villager)
      && distance(villager.position, command.point) <= PLAGUE_INITIAL_RADIUS);
    if (!hasTarget) return failure("Plague requires a living villager within 90 world units.");
  }
  return { ok: true, value: undefined };
};

const pruneResolvedEventHistory = (world: WorldState): boolean => {
  let unitChanged = false;
  while (world.events.length >= MAX_WORLD_EVENTS) {
    const resolvedIndex = world.events.findIndex((event) => event.status === "resolved");
    if (resolvedIndex < 0) return unitChanged;
    const removedEventId = world.events[resolvedIndex]!.id;
    const removedPitIds = new Set(
      world.pits.filter((pit) => pit.eventId === removedEventId).map((pit) => pit.id),
    );
    world.events.splice(resolvedIndex, 1);
    world.fires = world.fires.filter((fire) => fire.eventId !== removedEventId);
    world.tsunamis = world.tsunamis.filter((front) => front.eventId !== removedEventId);
    const hostilesBefore = world.hostiles.length;
    world.hostiles = world.hostiles.filter((hostile) => hostile.eventId !== removedEventId);
    unitChanged = world.hostiles.length !== hostilesBefore || unitChanged;
    world.pits = world.pits.filter((pit) => pit.eventId !== removedEventId);
    for (const villager of world.villagers) {
      if (villager.trappedByPitId === undefined || !removedPitIds.has(villager.trappedByPitId)) continue;
      villager.trappedByPitId = undefined;
      if (villager.status === "trapped") villager.status = "idle";
      unitChanged = true;
    }
    world.plagueCases = world.plagueCases.filter((plagueCase) =>
      plagueCase.eventId !== removedEventId);
    world.plagueExposures = world.plagueExposures.filter(
      (exposure) => exposure.eventId !== removedEventId,
    );
  }
  unitChanged = syncVillagerSickness(world) || unitChanged;
  return unitChanged;
};

const disasterType = (command: DisasterCommand): WorldEvent["type"] =>
  command.type.replace("trigger_", "") as WorldEvent["type"];

const eventFacts = (type: WorldEvent["type"]): string[] => {
  switch (type) {
    case "fire": return ["cells:1", "maxIntensity:100"];
    case "tsunami": return [`width:${TSUNAMI_WIDTH}`, `speed:${TSUNAMI_SPEED}`, `etaBoundMs:${TSUNAMI_LIFETIME_MS}`];
    case "bandits": return ["hostiles:4", "pathIntervalMs:1000"];
    case "earthquake": return ["radius:120", "pulse:pending"];
    case "plague": return ["infected:0", "radius:90"];
  }
};

const createEvent = (
  world: WorldState,
  command: DisasterCommand,
  eventId: string,
): WorldEvent => ({
  id: eventId,
  type: disasterType(command),
  origin: { ...command.point },
  createdAt: world.simulationTimeMs,
  updatedAt: world.simulationTimeMs,
  status: "active",
  severity: command.type === "trigger_earthquake" ? 85 : FIRE_INITIAL_INTENSITY,
  facts: eventFacts(disasterType(command)),
});

const normalize = (vector: Point): Point => {
  const magnitude = Math.hypot(vector.x, vector.y);
  return magnitude === 0 ? { x: 1, y: 0 } : {
    x: vector.x / magnitude,
    y: vector.y / magnitude,
  };
};

const spawnBandits = (world: WorldState, eventId: string, origin: Point): Hostile[] => {
  const offsets = [
    { x: -CELL_SIZE, y: 0 },
    { x: CELL_SIZE, y: 0 },
    { x: 0, y: -CELL_SIZE },
    { x: 0, y: CELL_SIZE },
  ];
  return offsets.slice(0, BANDIT_COUNT).map((offset, index) => {
    const candidate = { x: origin.x + offset.x, y: origin.y + offset.y };
    return {
      id: `${eventId}-bandit-${index + 1}`,
      eventId,
      position: isLandPoint(world, candidate) ? candidate : { ...origin },
      health: 100,
      path: [],
      pathIndex: 0,
      lastPathAt: Number.NEGATIVE_INFINITY,
      lastAttackAt: Number.NEGATIVE_INFINITY,
    };
  });
};

const withinRadius = (point: Point, origin: Point, radius: number): boolean =>
  distance(point, origin) <= radius;

const damageHouse = (house: House, damage: number): boolean => {
  if (!isStandingHouse(house)) return false;
  house.health = Math.max(0, houseHealth(house) - damage);
  house.rebuildProgress = house.health / 100;
  if (house.health === 0) house.destroyed = true;
  return true;
};

const damageEarthquakeStructures = (world: WorldState, origin: Point): boolean => {
  const village = world.activeVillage;
  if (village === null) return false;
  let changed = false;
  for (const house of village.houses) {
    if (withinRadius(house.position, origin, EARTHQUAKE_RADIUS)) {
      changed = damageHouse(house, EARTHQUAKE_DAMAGE) || changed;
    }
  }
  for (const road of village.roads) {
    if (road.points.some((point) => withinRadius(point, origin, EARTHQUAKE_RADIUS))) {
      road.damaged = true;
      road.rebuildProgress = 0;
      changed = true;
    }
  }
  for (const segment of village.wall.segments) {
    if (pointSegmentDistance(origin, segment.start, segment.end) <= EARTHQUAKE_RADIUS) {
      segment.destroyed = true;
      segment.rebuildProgress = 0;
      changed = true;
    }
  }
  if (withinRadius(village.anchor, origin, EARTHQUAKE_RADIUS)) {
    village.anchorDestroyed = true;
    village.anchorRebuildProgress = 0;
    changed = true;
  }
  changed = pruneDestroyedVillageStructures(world) || changed;
  return changed;
};

const pitPositionKey = (point: Point): string => `${point.x},${point.y}`;

const createPits = (world: WorldState, eventId: string, origin: Point): EarthquakePit[] => {
  const positions: Point[] = [];
  const seen = new Set<string>();
  const add = (point: Point, radius = EARTHQUAKE_RADIUS): void => {
    if (positions.length >= MAX_EARTHQUAKE_PITS || !isLandPoint(world, point)) return;
    const key = pitPositionKey(point);
    if (seen.has(key) || !withinRadius(point, origin, radius)) return;
    seen.add(key);
    positions.push({ ...point });
  };
  const nearbyVillagers = [...world.villagers]
    .filter(isLivingVillager)
    .filter((villager) => withinRadius(villager.position, origin, EARTHQUAKE_PIT_TARGET_RADIUS))
    .sort((first, second) =>
      distance(first.position, origin) - distance(second.position, origin)
      || first.id.localeCompare(second.id));
  const villagersInShockRadius = nearbyVillagers
    .filter((villager) => withinRadius(villager.position, origin, EARTHQUAKE_RADIUS));
  const targetVillagers = villagersInShockRadius.length > 0
    ? villagersInShockRadius
    : nearbyVillagers.slice(0, 1);
  targetVillagers.forEach((villager) => add(
    villager.position,
    villagersInShockRadius.length > 0 ? EARTHQUAKE_RADIUS : EARTHQUAKE_PIT_TARGET_RADIUS,
  ));
  add(origin);
  for (
    let attempt = 0;
    attempt < MAX_PIT_PLACEMENT_ATTEMPTS && positions.length < MAX_EARTHQUAKE_PITS;
    attempt += 1
  ) {
    const angle = world.random.next() * Math.PI * 2;
    const radius = 24 + world.random.next() * (EARTHQUAKE_RADIUS - 24);
    const candidate = {
      x: Math.round((origin.x + Math.cos(angle) * radius) / CELL_SIZE) * CELL_SIZE + CELL_SIZE / 2,
      y: Math.round((origin.y + Math.sin(angle) * radius) / CELL_SIZE) * CELL_SIZE + CELL_SIZE / 2,
    };
    add(candidate);
  }
  return positions.map((position, index) => ({
    id: `${eventId}-pit-${index + 1}`,
    eventId,
    position,
    radius: PIT_RADIUS,
  }));
};

const trapIntersectingVillagers = (world: WorldState, pits: readonly EarthquakePit[]): boolean => {
  let changed = false;
  for (const villager of world.villagers) {
    if (!isLivingVillager(villager) || villager.status === "trapped") continue;
    const pit = pits.find((candidate) => distance(candidate.position, villager.position) <= candidate.radius);
    if (pit === undefined) continue;
    villager.health ??= 100;
    villager.status = "trapped";
    villager.trappedByPitId = pit.id;
    changed = true;
  }
  return changed;
};

const syncVillagerSickness = (world: WorldState): boolean => {
  const infectedIds = new Set(
    world.plagueCases
      .filter((plagueCase) => plagueCase.status === "infected")
      .map((plagueCase) => plagueCase.villagerId),
  );
  let changed = false;
  for (const villager of world.villagers) {
    if (!isLivingVillager(villager) || villager.status === "trapped") continue;
    const nextStatus = infectedIds.has(villager.id) ? "sick" : "idle";
    if ((villager.status ?? "idle") === nextStatus) continue;
    villager.status = nextStatus;
    changed = true;
  }
  return changed;
};

export const triggerDisaster = (
  world: WorldState,
  command: DisasterCommand,
  eventId: string,
): CommandResult<DisasterTriggerOutcome> => {
  ensureDisasterState(world);
  const valid = validateDisasterTrigger(world, command);
  if (!valid.ok) return valid;
  if (!/^event-[1-9]\d*$/.test(eventId) || world.events.some((event) => event.id === eventId)) {
    return failure("Disaster event IDs must be unique monotonic event-N identifiers.");
  }
  const prunedUnits = pruneResolvedEventHistory(world);
  const event = createEvent(world, command, eventId);
  let unitChanged = prunedUnits;
  let structureChanged = false;
  let resolvedImmediately = false;

  if (command.type === "trigger_fire") {
    event.nextFireCellSequence = 2;
    const cell = worldToCell(command.point)!;
    world.fires.push({
      id: `${eventId}-fire-1`,
      eventId,
      cell,
      position: cellToWorld(cell),
      intensity: FIRE_INITIAL_INTENSITY,
      createdAt: world.simulationTimeMs,
      lastSpreadAt: world.simulationTimeMs,
    });
  } else if (command.type === "trigger_tsunami") {
    const target = findNearestLand(world, command.point, MAX_SEARCH_CELLS)!;
    world.tsunamis.push({
      id: `${eventId}-front`,
      eventId,
      origin: { ...command.point },
      position: { ...command.point },
      direction: normalize({ x: target.x - command.point.x, y: target.y - command.point.y }),
      width: TSUNAMI_WIDTH,
      speed: TSUNAMI_SPEED,
      ageMs: 0,
      hitEntityIds: [],
    });
  } else if (command.type === "trigger_bandits") {
    world.hostiles.push(...spawnBandits(world, eventId, command.point));
    unitChanged = true;
  } else if (command.type === "trigger_earthquake") {
    structureChanged = damageEarthquakeStructures(world, command.point);
    const pits = createPits(world, eventId, command.point);
    world.pits.push(...pits);
    const trapped = trapIntersectingVillagers(world, pits);
    unitChanged = trapped || unitChanged;
    event.status = trapped ? "active" : "resolved";
    event.facts = ["radius:120", "pulse:applied", `pits:${pits.length}`];
    resolvedImmediately = event.status === "resolved";
    if (resolvedImmediately) {
      event.severity = 0;
      event.facts = ["radius:120", "pulse:applied", "pits:0", "trapped:0"];
      world.pits = world.pits.filter((pit) => pit.eventId !== eventId);
    }
  } else {
    const cohort = world.villagers
      .filter(isLivingVillager)
      .sort((first, second) =>
        distance(first.position, command.point) - distance(second.position, command.point)
        || first.id.localeCompare(second.id))
      .slice(0, MAX_PLAGUE_PARTICIPANTS);
    let infected = 0;
    const cases: PlagueCase[] = cohort.map((villager) => {
      const initiallyInfected = withinRadius(
        villager.position,
        command.point,
        PLAGUE_INITIAL_RADIUS,
      );
      if (initiallyInfected) infected += 1;
      return {
        eventId,
        villagerId: villager.id,
        status: initiallyInfected ? "infected" : "susceptible",
        infectedAt: initiallyInfected ? world.simulationTimeMs : -1,
      };
    });
    world.plagueCases.push(...cases);
    event.facts = [`infected:${infected}`, "radius:90", "exposureMs:1000"];
    event.severity = Math.min(100, 35 + infected * 10);
    unitChanged = syncVillagerSickness(world) || unitChanged;
  }
  world.events.push(event);
  return { ok: true, value: { event, unitChanged, structureChanged, resolvedImmediately } };
};

const updateFire = (world: WorldState, event: WorldEvent): boolean => {
  const eventFires = world.fires.filter((fire) => fire.eventId === event.id);
  const positiveFires = eventFires.filter((fire) => fire.intensity > 0);
  let changed = positiveFires.length !== eventFires.length;
  if (changed) world.fires = world.fires.filter((fire) =>
    fire.eventId !== event.id || fire.intensity > 0);
  if (positiveFires.length === 0) {
    event.status = "resolved";
    event.severity = 0;
    event.updatedAt = world.simulationTimeMs;
    event.facts = ["cells:0", "maxIntensity:0"];
    return true;
  }
  const occupied = new Set(world.fires.map((fire) => cellIndex(fire.cell)));
  const spreadCycle = Math.floor(world.simulationTimeMs / FIRE_SPREAD_INTERVAL_MS);
  const spreadStart = positiveFires.length === 0
    ? 0
    : (spreadCycle * MAX_FIRE_SPREADS_PER_UPDATE) % positiveFires.length;
  let spreadChecks = 0;
  for (let offset = 0; offset < positiveFires.length; offset += 1) {
    if (spreadChecks >= MAX_FIRE_SPREADS_PER_UPDATE) break;
    const fire = positiveFires[(spreadStart + offset) % positiveFires.length]!;
    if (world.simulationTimeMs - fire.lastSpreadAt < FIRE_SPREAD_INTERVAL_MS) continue;
    spreadChecks += 1;
    fire.lastSpreadAt = world.simulationTimeMs;
    changed = true;
    if (world.fires.length >= MAX_FIRE_CELLS) continue;
    const neighbors = fourWayNeighbors(fire.cell);
    if (neighbors.length === 0) continue;
    const target = neighbors[world.random.nextInt(neighbors.length)]!;
    const targetIndex = cellIndex(target);
    if (world.terrain[targetIndex] !== TERRAIN_LAND || occupied.has(targetIndex)) continue;
    occupied.add(targetIndex);
    const sequence = event.nextFireCellSequence
      ?? Math.max(0, ...world.fires
        .filter((candidate) => candidate.eventId === event.id)
        .map((candidate) => Number(candidate.id.match(/-fire-(\d+)$/)?.[1] ?? 0))) + 1;
    world.fires.push({
      id: `${event.id}-fire-${sequence}`,
      eventId: event.id,
      cell: target,
      position: cellToWorld(target),
      intensity: FIRE_INITIAL_INTENSITY,
      createdAt: world.simulationTimeMs,
      lastSpreadAt: world.simulationTimeMs,
    });
    event.nextFireCellSequence = sequence + 1;
  }
  if (changed) {
    const count = world.fires.filter((fire) => fire.eventId === event.id).length;
    event.updatedAt = world.simulationTimeMs;
    event.severity = Math.min(100, 45 + count * 5);
    event.facts = [`cells:${count}`, "maxIntensity:100"];
  }
  return changed;
};

const frontHitsPoint = (
  previous: Point,
  front: TsunamiFront,
  point: Point,
): boolean => {
  const relative = { x: point.x - previous.x, y: point.y - previous.y };
  const forward = relative.x * front.direction.x + relative.y * front.direction.y;
  const perpendicular = Math.abs(relative.x * -front.direction.y + relative.y * front.direction.x);
  const travel = distance(previous, front.position);
  return forward >= -TSUNAMI_CREST_DEPTH
    && forward <= travel + TSUNAMI_CREST_DEPTH
    && perpendicular <= front.width / 2;
};

const markTsunamiHit = (front: TsunamiFront, id: string): boolean => {
  if (front.hitEntityIds.includes(id)) return false;
  if (front.hitEntityIds.length >= MAX_TSUNAMI_HITS) return false;
  front.hitEntityIds.push(id);
  return true;
};

const frontLocalPoint = (previous: Point, front: TsunamiFront, point: Point): Point => {
  const relative = { x: point.x - previous.x, y: point.y - previous.y };
  return {
    x: relative.x * front.direction.x + relative.y * front.direction.y,
    y: relative.x * -front.direction.y + relative.y * front.direction.x,
  };
};

const segmentIntersectsRectangle = (
  start: Point,
  end: Point,
  minimumX: number,
  maximumX: number,
  minimumY: number,
  maximumY: number,
): boolean => {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const p = [-deltaX, deltaX, -deltaY, deltaY];
  const q = [
    start.x - minimumX,
    maximumX - start.x,
    start.y - minimumY,
    maximumY - start.y,
  ];
  let entry = 0;
  let exit = 1;
  for (let index = 0; index < 4; index += 1) {
    if (p[index] === 0) {
      if (q[index]! < 0) return false;
      continue;
    }
    const ratio = q[index]! / p[index]!;
    if (p[index]! < 0) entry = Math.max(entry, ratio);
    else exit = Math.min(exit, ratio);
    if (entry > exit) return false;
  }
  return true;
};

const frontHitsSegment = (
  previous: Point,
  front: TsunamiFront,
  start: Point,
  end: Point,
): boolean => {
  const localStart = frontLocalPoint(previous, front, start);
  const localEnd = frontLocalPoint(previous, front, end);
  const travel = distance(previous, front.position);
  return segmentIntersectsRectangle(
    localStart,
    localEnd,
    -TSUNAMI_CREST_DEPTH,
    travel + TSUNAMI_CREST_DEPTH,
    -front.width / 2,
    front.width / 2,
  );
};

const washOutTsunamiFires = (
  world: WorldState,
  front: TsunamiFront,
  previous: Point,
): boolean => {
  const hitFireEventIds = new Set<string>();
  let changed = false;
  world.fires = world.fires.filter((fire) => {
    if (
      fire.intensity <= 0
      || !frontHitsPoint(previous, front, fire.position)
      || !markTsunamiHit(front, `fire:${fire.id}`)
    ) return true;
    hitFireEventIds.add(fire.eventId);
    changed = true;
    return false;
  });

  if (!changed) return false;
  for (const event of world.events) {
    if (
      event.status === "active"
      && event.type === "fire"
      && hitFireEventIds.has(event.id)
      && !world.fires.some((fire) => fire.eventId === event.id && fire.intensity > 0)
    ) {
      event.status = "resolved";
      event.severity = 0;
      event.updatedAt = world.simulationTimeMs;
      event.facts = ["cells:0", "maxIntensity:0"];
    }
  }
  return true;
};

const VILLAGE_HIT_PREFIXES = [
  "villager:",
  "house:",
  "road:",
  "wall:",
  "anchor:",
] as const;

export const resetTsunamiVillageHits = (world: WorldState): boolean => {
  let changed = false;
  for (const front of world.tsunamis) {
    if (activeEvent(world, front.eventId) === undefined) continue;
    const retained = front.hitEntityIds.filter((id) =>
      !VILLAGE_HIT_PREFIXES.some((prefix) => id.startsWith(prefix)));
    if (retained.length === front.hitEntityIds.length) continue;
    front.hitEntityIds = retained;
    changed = true;
  }
  return changed;
};

const damageTsunamiVillage = (
  world: WorldState,
  front: TsunamiFront,
  previous: Point,
): boolean => {
  const village = world.activeVillage;
  if (village === null) return false;
  let changed = false;
  for (const house of village.houses) {
    if (
      isStandingHouse(house)
      && frontHitsPoint(previous, front, house.position)
      && markTsunamiHit(front, `house:${house.id}`)
    ) {
      house.health = 0;
      house.destroyed = true;
      house.rebuildProgress = 0;
      changed = true;
    }
  }
  for (const road of village.roads) {
    if (
      road.damaged !== true
      && road.points.slice(1).some((point, index) =>
        frontHitsSegment(previous, front, road.points[index]!, point))
      && markTsunamiHit(front, `road:${road.id}`)
    ) {
      road.damaged = true;
      road.rebuildProgress = 0;
      changed = true;
    }
  }
  for (let index = 0; index < village.wall.segments.length; index += 1) {
    const segment = village.wall.segments[index]!;
    const id = `wall:${index + 1}`;
    if (
      segment.destroyed !== true
      && frontHitsSegment(previous, front, segment.start, segment.end)
      && markTsunamiHit(front, id)
    ) {
      segment.destroyed = true;
      segment.rebuildProgress = 0;
      changed = true;
    }
  }
  const anchorId = "anchor:village";
  if (
    village.anchorDestroyed !== true
    && frontHitsPoint(previous, front, village.anchor)
    && markTsunamiHit(front, anchorId)
  ) {
    village.anchorDestroyed = true;
    village.anchorRebuildProgress = 0;
    changed = true;
  }
  changed = pruneDestroyedVillageStructures(world) || changed;
  return changed;
};

const updateTsunami = (
  world: WorldState,
  front: TsunamiFront,
): { changed: boolean; units: boolean; structures: boolean } => {
  const event = activeEvent(world, front.eventId);
  if (event === undefined) return { changed: false, units: false, structures: false };
  const previous = { ...front.position };
  const delta = front.speed * (FIXED_STEP_MS / 1_000);
  front.position.x += front.direction.x * delta;
  front.position.y += front.direction.y * delta;
  front.ageMs += FIXED_STEP_MS;
  let units = false;
  for (const villager of world.villagers) {
    if (
      isLivingVillager(villager)
      && frontHitsPoint(previous, front, villager.position)
      && markTsunamiHit(front, `villager:${villager.id}`)
    ) {
      villager.health = 0;
      villager.status = "dead";
      units = true;
    }
  }
  const hitTrees = new Set<string>();
  for (const tree of world.trees) {
    if (
      frontHitsPoint(previous, front, tree.position)
      && markTsunamiHit(front, `tree:${tree.id}`)
    ) hitTrees.add(tree.id);
  }
  if (hitTrees.size > 0) world.trees = world.trees.filter((tree) => !hitTrees.has(tree.id));
  washOutTsunamiFires(world, front, previous);
  const structures = damageTsunamiVillage(world, front, previous) || hitTrees.size > 0;
  event.updatedAt = world.simulationTimeMs;
  event.facts = [
    `width:${TSUNAMI_WIDTH}`,
    `speed:${TSUNAMI_SPEED}`,
    `ageMs:${front.ageMs}`,
    `objectsHit:${front.hitEntityIds.length}`,
  ];
  if (front.ageMs >= TSUNAMI_LIFETIME_MS) {
    event.status = "resolved";
    event.severity = 0;
    world.tsunamis = world.tsunamis.filter((candidate) => candidate.id !== front.id);
  }
  return { changed: true, units, structures };
};

const closestTarget = (
  world: WorldState,
  bandit: Hostile,
): { id: string; position: Point; kind: "villager" | "house" } | null => {
  const candidates = [
    ...world.villagers.filter(isLivingVillager).map((villager) => ({
      id: villager.id,
      position: villager.position,
      kind: "villager" as const,
    })),
    ...(world.activeVillage?.houses ?? []).filter(isStandingHouse).map((targetHouse) => ({
      id: targetHouse.id,
      position: targetHouse.position,
      kind: "house" as const,
    })),
  ];
  candidates.sort((first, second) =>
    distance(bandit.position, first.position) - distance(bandit.position, second.position)
    || first.id.localeCompare(second.id));
  return candidates[0] ?? null;
};

const moveToward = (from: Point, to: Point, maximumDistance: number): Point => {
  const separation = distance(from, to);
  if (separation <= maximumDistance || separation === 0) return { ...to };
  const ratio = maximumDistance / separation;
  return {
    x: from.x + (to.x - from.x) * ratio,
    y: from.y + (to.y - from.y) * ratio,
  };
};

const attackBanditTarget = (world: WorldState, bandit: Hostile, targetId: string): boolean => {
  const villager = world.villagers.find((candidate) => candidate.id === targetId);
  if (villager !== undefined && isLivingVillager(villager)) {
    villager.health = Math.max(0, villagerHealth(villager) - BANDIT_DAMAGE);
    if (villager.health === 0) villager.status = "dead";
    return true;
  }
  const targetHouse = world.activeVillage?.houses.find((candidate) => candidate.id === targetId);
  return targetHouse === undefined ? false : damageHouse(targetHouse, BANDIT_HOUSE_DAMAGE);
};

const findCurrentTarget = (
  world: WorldState,
  targetId: string | undefined,
): { id: string; position: Point; kind: "villager" | "house" } | null => {
  if (targetId === undefined) return null;
  const villager = world.villagers.find((candidate) =>
    candidate.id === targetId && isLivingVillager(candidate));
  if (villager !== undefined) {
    return { id: villager.id, position: villager.position, kind: "villager" };
  }
  const targetHouse = world.activeVillage?.houses.find((candidate) =>
    candidate.id === targetId && isStandingHouse(candidate));
  return targetHouse === undefined
    ? null
    : { id: targetHouse.id, position: targetHouse.position, kind: "house" };
};

const updateBandits = (
  world: WorldState,
  events: readonly WorldEvent[],
): { changed: boolean; units: boolean; structures: boolean; pathfinds: number } => {
  let changed = false;
  let units = false;
  let structures = false;
  let pathfinds = 0;
  const eventIds = new Set(events.map((event) => event.id));
  let bandits = world.hostiles.filter((hostile) =>
    hostile.eventId !== undefined
    && eventIds.has(hostile.eventId)
    && (hostile.health ?? 100) > 0);
  const hasAnyTarget = world.villagers.some(isLivingVillager)
    || (world.activeVillage?.houses.some(isStandingHouse) ?? false);
  if (!hasAnyTarget) {
    world.hostiles = world.hostiles.filter((hostile) =>
      hostile.eventId === undefined || !eventIds.has(hostile.eventId));
    for (const event of events) {
      event.status = "resolved";
      event.severity = 0;
      event.updatedAt = world.simulationTimeMs;
      event.facts = ["hostiles:0", "pathIntervalMs:1000"];
    }
    return {
      changed: events.length > 0,
      units: bandits.length > 0,
      structures: false,
      pathfinds: 0,
    };
  }

  const due = bandits
    .filter((bandit) => world.simulationTimeMs - (bandit.lastPathAt ?? Number.NEGATIVE_INFINITY)
      >= BANDIT_PATH_INTERVAL_MS)
    .sort((first, second) => {
      const firstAt = first.lastPathAt ?? Number.NEGATIVE_INFINITY;
      const secondAt = second.lastPathAt ?? Number.NEGATIVE_INFINITY;
      return firstAt - secondAt || first.id.localeCompare(second.id);
    })
    .slice(0, MAX_BANDIT_PATHFINDS_PER_TICK);
  for (const bandit of due) {
    const target = closestTarget(world, bandit);
    if (target === null) continue;
    bandit.targetId = target.id;
    bandit.path = findPath(world, bandit.position, target.position, MAX_SEARCH_CELLS) ?? [];
    bandit.pathIndex = bandit.path.length > 1 ? 1 : 0;
    bandit.lastPathAt = world.simulationTimeMs;
    changed = true;
    units = true;
    pathfinds += 1;
  }

  for (const bandit of bandits) {
    const target = findCurrentTarget(world, bandit.targetId);
    if (target === null) continue;
    if ((bandit.path?.length ?? 0) > 1) {
      const pathTarget = bandit.path![bandit.pathIndex ?? 1];
      if (pathTarget !== undefined) {
        const previousPosition = bandit.position;
        bandit.position = moveToward(
          bandit.position,
          pathTarget,
          BANDIT_SPEED_PER_SECOND * FIXED_STEP_MS / 1_000,
        );
        if (distance(bandit.position, pathTarget) < 0.001
          && (bandit.pathIndex ?? 0) < bandit.path!.length - 1) {
          bandit.pathIndex = (bandit.pathIndex ?? 0) + 1;
        }
        if (distance(previousPosition, bandit.position) > 0) {
          units = true;
          changed = true;
        }
      }
    }
    if (
      distance(bandit.position, target.position) <= BANDIT_ATTACK_RANGE
      && world.simulationTimeMs - (bandit.lastAttackAt ?? Number.NEGATIVE_INFINITY)
        >= BANDIT_ATTACK_INTERVAL_MS
    ) {
      bandit.lastAttackAt = world.simulationTimeMs;
      units = true;
      const attacked = attackBanditTarget(world, bandit, target.id);
      if (attacked) {
        changed = true;
        if (target.kind === "villager") units = true;
        else structures = true;
      }
    }
  }
  bandits = world.hostiles.filter((hostile) =>
    hostile.eventId !== undefined
    && eventIds.has(hostile.eventId)
    && (hostile.health ?? 100) > 0);
  for (const event of events) {
    const eventBandits = bandits.filter((bandit) => bandit.eventId === event.id);
    if (eventBandits.length === 0) {
      event.status = "resolved";
      event.severity = 0;
      event.updatedAt = world.simulationTimeMs;
      changed = true;
    } else if (changed) {
      event.updatedAt = world.simulationTimeMs;
      event.facts = [`hostiles:${eventBandits.length}`, "pathIntervalMs:1000"];
    }
  }
  return { changed, units, structures, pathfinds };
};

const updatePlague = (
  world: WorldState,
  event: WorldEvent,
): { changed: boolean; units: boolean; pairChecks: number } => {
  let changed = false;
  const cases = world.plagueCases.filter((plagueCase) => plagueCase.eventId === event.id);
  for (const plagueCase of cases) {
    if (
      plagueCase.status !== "infected"
      || world.simulationTimeMs - plagueCase.infectedAt < PLAGUE_RECOVERY_MS
    ) continue;
    plagueCase.status = "recovered";
    changed = true;
  }
  const infected = cases.filter((plagueCase) => plagueCase.status === "infected");
  const susceptible = cases.filter((plagueCase) => plagueCase.status === "susceptible");
  const villagersById = new Map(world.villagers.map((villager) => [villager.id, villager]));
  const existing = new Map(world.plagueExposures
    .filter((exposure) => exposure.eventId === event.id)
    .map((exposure) => [exposure.exposedVillagerId, exposure]));
  const retained = world.plagueExposures.filter((exposure) => exposure.eventId !== event.id);
  const previousExposureCount = world.plagueExposures.length - retained.length;
  const nextExposures: PlagueExposure[] = [];
  let pairChecks = 0;
  for (const candidateCase of susceptible) {
    const candidate = villagersById.get(candidateCase.villagerId);
    if (candidate === undefined || !isLivingVillager(candidate)) continue;
    let nearInfectiousVillager = false;
    for (const sourceCase of infected) {
      pairChecks += 1;
      if (pairChecks > MAX_PLAGUE_PAIR_CHECKS) break;
      const source = villagersById.get(sourceCase.villagerId);
      if (
        source !== undefined
        && isLivingVillager(source)
        && distance(source.position, candidate.position) <= PLAGUE_PROXIMITY
      ) {
        nearInfectiousVillager = true;
        break;
      }
    }
    if (!nearInfectiousVillager) continue;
    const exposure = existing.get(candidate.id) ?? {
      eventId: event.id,
      exposedVillagerId: candidate.id,
      exposureMs: 0,
    };
    exposure.exposureMs += FIXED_STEP_MS;
    changed = true;
    if (exposure.exposureMs >= PLAGUE_EXPOSURE_MS) {
      candidateCase.status = "infected";
      candidateCase.infectedAt = world.simulationTimeMs;
    } else nextExposures.push(exposure);
  }
  world.plagueExposures = [...retained, ...nextExposures].slice(0, MAX_PLAGUE_EXPOSURES);
  if (previousExposureCount !== nextExposures.length) changed = true;
  const infectedCount = cases.filter((plagueCase) => plagueCase.status === "infected").length;
  if (infectedCount === 0) {
    event.status = "resolved";
    event.severity = 0;
    world.plagueExposures = world.plagueExposures.filter((exposure) => exposure.eventId !== event.id);
    changed = true;
  }
  if (changed) {
    event.updatedAt = world.simulationTimeMs;
    event.facts = [`infected:${infectedCount}`, "radius:90", "exposureMs:1000"];
  }
  const sicknessChanged = syncVillagerSickness(world);
  return { changed: changed || sicknessChanged, units: sicknessChanged, pairChecks };
};

const damageBurningHouses = (world: WorldState): boolean => {
  const village = world.activeVillage;
  if (village === null) return false;
  let changed = false;
  for (const targetHouse of village.houses) {
    if (!isStandingHouse(targetHouse)) continue;
    const burning = world.fires.some((fire) =>
      fire.intensity > 0 && distance(fire.position, targetHouse.position) <= CELL_SIZE);
    if (burning) changed = damageHouse(targetHouse, FIRE_DAMAGE_PER_TICK) || changed;
  }
  return changed;
};

const resolveUntrappedEarthquakes = (world: WorldState): boolean => {
  let changed = false;
  for (const event of world.events) {
    if (event.type !== "earthquake" || event.status !== "active") continue;
    const pitIds = new Set(
      world.pits.filter((pit) => pit.eventId === event.id).map((pit) => pit.id),
    );
    const hasTrappedVillager = world.villagers.some((villager) =>
      villager.status === "trapped"
      && villager.trappedByPitId !== undefined
      && pitIds.has(villager.trappedByPitId));
    if (hasTrappedVillager) continue;
    event.status = "resolved";
    event.severity = 0;
    event.updatedAt = world.simulationTimeMs;
    event.facts = [
      ...event.facts.filter((fact) => !fact.startsWith("trapped:")),
      "trapped:0",
    ].slice(0, 4);
    world.pits = world.pits.filter((pit) => pit.eventId !== event.id);
    changed = true;
  }
  return changed;
};

const noIntervention = (): DisasterInterventionOutcome => ({
  acted: false,
  hazardChanged: false,
  unitChanged: false,
  resolvedEventIds: [],
});

export const applyFireResponse = (
  world: WorldState,
  eventId: string,
  actorPosition: Point,
  amount: number,
): DisasterInterventionOutcome => {
  const event = activeEvent(world, eventId);
  if (event?.type !== "fire" || !Number.isFinite(amount) || amount <= 0) return noIntervention();
  let remainingAmount = amount;
  const targets = world.fires
    .filter((fire) => fire.eventId === eventId && fire.intensity > 0)
    .sort((first, second) =>
      distance(actorPosition, first.position) - distance(actorPosition, second.position)
      || first.id.localeCompare(second.id));
  let acted = false;
  for (const target of targets) {
    if (remainingAmount <= 0 || distance(actorPosition, target.position) > 24) break;
    const appliedAmount = Math.min(target.intensity, remainingAmount);
    target.intensity = Math.max(0, target.intensity - appliedAmount);
    remainingAmount -= appliedAmount;
    acted = true;
  }
  if (!acted) return noIntervention();
  world.fires = world.fires.filter((fire) => fire.eventId !== eventId || fire.intensity > 0);
  const remaining = world.fires.filter((fire) => fire.eventId === eventId);
  const resolved = remaining.length === 0;
  event.updatedAt = world.simulationTimeMs;
  event.severity = resolved ? 0 : Math.max(...remaining.map((fire) => fire.intensity));
  event.facts = [
    `cells:${remaining.length}`,
    `maxIntensity:${resolved ? 0 : event.severity}`,
  ];
  if (resolved) event.status = "resolved";
  return {
    acted: true,
    hazardChanged: true,
    unitChanged: false,
    resolvedEventIds: resolved ? [eventId] : [],
  };
};

export const applyBanditDefense = (
  world: WorldState,
  eventId: string,
  actorPosition: Point,
  amount: number,
  targetHostileId?: string,
): DisasterInterventionOutcome => {
  const event = activeEvent(world, eventId);
  if (event?.type !== "bandits" || !Number.isFinite(amount) || amount <= 0) return noIntervention();
  const candidates = world.hostiles
    .filter((hostile) => hostile.eventId === eventId && (hostile.health ?? 100) > 0);
  const target = targetHostileId === undefined
    ? candidates.sort((first, second) =>
      distance(actorPosition, first.position) - distance(actorPosition, second.position)
      || first.id.localeCompare(second.id))[0]
    : candidates.find((hostile) => hostile.id === targetHostileId);
  if (target === undefined || distance(actorPosition, target.position) > 24) return noIntervention();
  target.health = Math.max(0, (target.health ?? 100) - amount);
  world.hostiles = world.hostiles.filter((hostile) =>
    hostile.eventId !== eventId || (hostile.health ?? 100) > 0);
  const remaining = world.hostiles.filter((hostile) => hostile.eventId === eventId);
  const resolved = remaining.length === 0;
  event.updatedAt = world.simulationTimeMs;
  event.severity = resolved ? 0 : Math.min(100, remaining.length * 25);
  event.facts = [`hostiles:${remaining.length}`, "pathIntervalMs:1000"];
  if (resolved) event.status = "resolved";
  return {
    acted: true,
    hazardChanged: true,
    unitChanged: true,
    resolvedEventIds: resolved ? [eventId] : [],
  };
};

export const applyPitRescue = (
  world: WorldState,
  eventId: string,
  rescuerPosition: Point,
  trappedVillagerId: string,
): DisasterInterventionOutcome => {
  const event = activeEvent(world, eventId);
  const trapped = world.villagers.find((villager) => villager.id === trappedVillagerId);
  const pit = trapped?.trappedByPitId === undefined
    ? undefined
    : world.pits.find((candidate) =>
      candidate.id === trapped.trappedByPitId && candidate.eventId === eventId);
  if (
    event?.type !== "earthquake"
    || trapped === undefined
    || trapped.status !== "trapped"
    || pit === undefined
    || distance(rescuerPosition, trapped.position) > 32
    || distance(rescuerPosition, pit.position) <= pit.radius
  ) return noIntervention();

  trapped.trappedByPitId = undefined;
  trapped.status = "idle";
  const trappedInPit = world.villagers.some((villager) =>
    villager.status === "trapped" && villager.trappedByPitId === pit.id);
  if (!trappedInPit) {
    world.pits = world.pits.filter((candidate) => candidate.id !== pit.id);
  }
  const remainingPitIds = new Set(
    world.pits.filter((candidate) => candidate.eventId === eventId).map((candidate) => candidate.id),
  );
  const trappedCount = world.villagers.filter((villager) =>
    villager.status === "trapped"
    && villager.trappedByPitId !== undefined
    && remainingPitIds.has(villager.trappedByPitId)).length;
  const resolved = trappedCount === 0;
  if (resolved) {
    world.pits = world.pits.filter((candidate) => candidate.eventId !== eventId);
    event.status = "resolved";
    event.severity = 0;
  }
  event.updatedAt = world.simulationTimeMs;
  event.facts = [
    ...event.facts.filter((fact) => !fact.startsWith("pits:") && !fact.startsWith("trapped:")),
    `pits:${world.pits.filter((candidate) => candidate.eventId === eventId).length}`,
    `trapped:${trappedCount}`,
  ].slice(0, 4);
  return {
    acted: true,
    hazardChanged: true,
    unitChanged: true,
    resolvedEventIds: resolved ? [eventId] : [],
  };
};

export const reconcileDisastersAfterTerrain = (world: WorldState): DisasterTerrainOutcome => {
  ensureDisasterState(world);
  const statusesBefore = new Map(world.events.map((event) => [event.id, event.status]));
  const firesBefore = world.fires.length;
  world.fires = world.fires.filter((fire) =>
    fire.intensity > 0 && world.terrain[cellIndex(fire.cell)] === TERRAIN_LAND);
  const removedFires = firesBefore - world.fires.length;
  const pitsBefore = world.pits.length;
  world.pits = world.pits.filter((pit) => isLandPoint(world, pit.position));
  const removedPits = pitsBefore - world.pits.length;
  const pitsById = new Map(world.pits.map((pit) => [pit.id, pit]));
  let unitChanged = false;
  for (const villager of world.villagers) {
    if (villager.trappedByPitId === undefined) continue;
    const pit = pitsById.get(villager.trappedByPitId);
    if (
      pit !== undefined
      && distance(pit.position, villager.position) <= pit.radius
    ) continue;
    villager.trappedByPitId = undefined;
    if (villager.status === "trapped") villager.status = "idle";
    unitChanged = true;
  }
  let invalidatedBanditPaths = 0;
  for (const hostile of world.hostiles) {
    if ((hostile.path?.length ?? 0) === 0 && hostile.targetId === undefined) continue;
    hostile.path = [];
    hostile.pathIndex = 0;
    hostile.targetId = undefined;
    hostile.lastPathAt = Number.NEGATIVE_INFINITY;
    invalidatedBanditPaths += 1;
    unitChanged = true;
  }
  for (const event of world.events) {
    if (event.status !== "active" || event.type !== "fire") continue;
    const positiveCount = world.fires.filter((fire) =>
      fire.eventId === event.id && fire.intensity > 0).length;
    if (positiveCount > 0) continue;
    event.status = "resolved";
    event.severity = 0;
    event.updatedAt = world.simulationTimeMs;
    event.facts = ["cells:0", "maxIntensity:0"];
  }
  const earthquakeChanged = resolveUntrappedEarthquakes(world);
  const resolvedEventIds = world.events
    .filter((event) => statusesBefore.get(event.id) === "active" && event.status === "resolved")
    .map((event) => event.id);
  return {
    hazardChanged: removedFires > 0
      || removedPits > 0
      || invalidatedBanditPaths > 0
      || earthquakeChanged
      || resolvedEventIds.length > 0,
    unitChanged,
    resolvedEventIds,
    removedFires,
    removedPits,
    invalidatedBanditPaths,
  };
};

export const reconcileDisastersAfterVillageReplacement = (
  world: WorldState,
): DisasterVillageReplacementOutcome => {
  ensureDisasterState(world);
  const resolvedEventIds: string[] = [];
  const updatedEventIds = new Set<string>();
  let hazardChanged = resetTsunamiVillageHits(world);
  let unitChanged = false;

  if (world.plagueCases.length > 0 || world.plagueExposures.length > 0) hazardChanged = true;
  world.plagueCases = [];
  world.plagueExposures = [];
  unitChanged = syncVillagerSickness(world) || unitChanged;
  for (const event of world.events) {
    if (event.type !== "plague" || event.status !== "active") {
      continue;
    }
    event.status = "resolved";
    event.severity = 0;
    event.updatedAt = world.simulationTimeMs;
    event.facts = ["infected:0", "radius:90", "exposureMs:1000"];
    resolvedEventIds.push(event.id);
    hazardChanged = true;
  }

  for (const hostile of world.hostiles) {
    if (hostile.eventId === undefined || activeEvent(world, hostile.eventId)?.type !== "bandits") {
      continue;
    }
    const routeChanged = hostile.targetId !== undefined
      || (hostile.path?.length ?? 0) > 0
      || (hostile.pathIndex ?? 0) !== 0
      || hostile.lastPathAt !== Number.NEGATIVE_INFINITY;
    if (!routeChanged) continue;
    hostile.targetId = undefined;
    hostile.path = [];
    hostile.pathIndex = 0;
    hostile.lastPathAt = Number.NEGATIVE_INFINITY;
    unitChanged = true;
    updatedEventIds.add(hostile.eventId);
  }

  const activeEarthquakes = world.events.filter((event) =>
    event.type === "earthquake" && event.status === "active");
  for (const event of activeEarthquakes) {
    const eventPits = world.pits.filter((pit) => pit.eventId === event.id);
    const trappedChanged = trapIntersectingVillagers(world, eventPits);
    unitChanged = trappedChanged || unitChanged;
    const trapped = world.villagers.filter((villager) =>
      villager.status === "trapped"
      && villager.trappedByPitId !== undefined
      && eventPits.some((pit) => pit.id === villager.trappedByPitId)).length;
    if (trapped > 0) {
      event.updatedAt = world.simulationTimeMs;
      event.facts = [
        ...event.facts.filter((fact) => !fact.startsWith("trapped:")),
        `trapped:${trapped}`,
      ].slice(0, 4);
      updatedEventIds.add(event.id);
      hazardChanged = true;
      continue;
    }
    event.status = "resolved";
    event.severity = 0;
    event.updatedAt = world.simulationTimeMs;
    event.facts = [
      ...event.facts.filter((fact) => !fact.startsWith("trapped:") && !fact.startsWith("pits:")),
      "pits:0",
      "trapped:0",
    ].slice(0, 4);
    world.pits = world.pits.filter((pit) => pit.eventId !== event.id);
    resolvedEventIds.push(event.id);
    hazardChanged = true;
  }

  return {
    hazardChanged,
    unitChanged,
    resolvedEventIds,
    updatedEventIds: [...updatedEventIds].sort((first, second) => first.localeCompare(second)),
  };
};

export const updateDisasters = (
  world: WorldState,
  stepMs: number,
): DisasterTickOutcome => {
  ensureDisasterState(world);
  const outcome: DisasterTickOutcome = {
    hazardChanged: false,
    unitChanged: false,
    structureChanged: false,
    resolvedEventIds: [],
    banditPathfinds: 0,
    plaguePairChecks: 0,
  };
  if (stepMs !== FIXED_STEP_MS) return outcome;
  world.simulationTimeMs += FIXED_STEP_MS;
  const statusesBefore = new Map(world.events.map((event) => [event.id, event.status]));
  const activeBanditEvents = world.events.filter((event) =>
    event.type === "bandits" && event.status === "active");
  if (activeBanditEvents.length > 0) {
    const update = updateBandits(world, activeBanditEvents);
    outcome.hazardChanged = update.changed || outcome.hazardChanged;
    outcome.unitChanged = update.units || outcome.unitChanged;
    outcome.structureChanged = update.structures || outcome.structureChanged;
    outcome.banditPathfinds = update.pathfinds;
  }
  for (const event of world.events.slice(0, MAX_WORLD_EVENTS)) {
    if (event.status !== "active") continue;
    if (event.type === "fire") {
      outcome.hazardChanged = updateFire(world, event) || outcome.hazardChanged;
    } else if (event.type === "tsunami") {
      const front = world.tsunamis.find((candidate) => candidate.eventId === event.id);
      if (front !== undefined) {
        const update = updateTsunami(world, front);
        outcome.hazardChanged = update.changed || outcome.hazardChanged;
        outcome.unitChanged = update.units || outcome.unitChanged;
        outcome.structureChanged = update.structures || outcome.structureChanged;
      }
    } else if (event.type === "bandits") {
      continue;
    } else if (event.type === "plague") {
      const update = updatePlague(world, event);
      outcome.hazardChanged = update.changed || outcome.hazardChanged;
      outcome.unitChanged = update.units || outcome.unitChanged;
      outcome.plaguePairChecks += update.pairChecks;
    }
  }
  const activeEarthquakeIds = new Set(world.events
    .filter((event) => event.type === "earthquake" && event.status === "active")
    .map((event) => event.id));
  outcome.unitChanged = trapIntersectingVillagers(
    world,
    world.pits.filter((pit) => activeEarthquakeIds.has(pit.eventId)),
  ) || outcome.unitChanged;
  outcome.structureChanged = damageBurningHouses(world) || outcome.structureChanged;
  outcome.hazardChanged = resolveUntrappedEarthquakes(world) || outcome.hazardChanged;
  for (const event of world.events) {
    if (statusesBefore.get(event.id) === "active" && event.status === "resolved") {
      outcome.resolvedEventIds.push(event.id);
      outcome.hazardChanged = true;
    }
  }
  return outcome;
};
