import { describe, expect, it } from "vitest";

import {
  VILLAGER_DEATH_ANIMATION_MS,
  VILLAGER_DEATH_RISE_PX,
  getVillagerDeathAnimationFrame,
} from "./villagerDeathAnimation";

describe("villager death animation", () => {
  it("starts at the ghost's original position and full opacity", () => {
    expect(getVillagerDeathAnimationFrame(1_000, 1_000)).toEqual({
      offsetY: 0,
      alpha: 1,
      complete: false,
    });
  });

  it("eases the ghost upward while fading it out", () => {
    const frame = getVillagerDeathAnimationFrame(1_000, 1_000 + VILLAGER_DEATH_ANIMATION_MS / 2);

    expect(frame.offsetY).toBeGreaterThan(VILLAGER_DEATH_RISE_PX / 2);
    expect(frame.offsetY).toBeLessThan(VILLAGER_DEATH_RISE_PX);
    expect(frame.alpha).toBeCloseTo(0.5);
    expect(frame.complete).toBe(false);
  });

  it("marks the ghost complete at the end of its lifetime", () => {
    expect(getVillagerDeathAnimationFrame(1_000, 1_000 + VILLAGER_DEATH_ANIMATION_MS)).toEqual({
      offsetY: VILLAGER_DEATH_RISE_PX,
      alpha: 0,
      complete: true,
    });
  });
});
