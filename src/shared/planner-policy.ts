import type { PlannerIntent } from "./planner-contract";

export const PLANNER_DEPLOYMENT_CAPS = Object.freeze({
  fight_fire: 5,
  defend_event: 4,
  rescue_trapped: 2,
  isolate_sick: 3,
  relocate: 4,
  found_village: 4,
  split_villagers: 4,
} satisfies Record<PlannerIntent["type"], number>);

export const RESERVE_FRACTION = 0.25;

export const minimumReserveVillagers = (availableVillagers: number): number => {
  if (availableVillagers <= 1) return 0;
  return Math.max(1, Math.ceil(availableVillagers * RESERVE_FRACTION));
};

export const maxDeployableVillagers = (availableVillagers: number): number =>
  Math.max(0, availableVillagers - minimumReserveVillagers(availableVillagers));

export const deploymentCapForIntent = (type: PlannerIntent["type"]): number =>
  PLANNER_DEPLOYMENT_CAPS[type];
