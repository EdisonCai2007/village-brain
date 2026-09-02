export const VILLAGER_DEATH_ANIMATION_MS = 900;
export const VILLAGER_DEATH_RISE_PX = 28;

export interface VillagerDeathAnimationFrame {
  readonly offsetY: number;
  readonly alpha: number;
  readonly complete: boolean;
}

export function getVillagerDeathAnimationFrame(
  startedAt: number,
  now: number,
): VillagerDeathAnimationFrame {
  const progress = Math.max(0, Math.min(1, (now - startedAt) / VILLAGER_DEATH_ANIMATION_MS));
  return {
    offsetY: VILLAGER_DEATH_RISE_PX * easeOutCubic(progress),
    alpha: 1 - progress,
    complete: progress >= 1,
  };
}

function easeOutCubic(value: number): number {
  return 1 - Math.pow(1 - value, 3);
}
