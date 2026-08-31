import { describe, expect, it } from "vitest";

import { updateDisasters } from "./disasters";
import { createWorld } from "./terrain";
import { updateVillagerTasks } from "./tasks";
import { generateVillage } from "./village";

describe("village recovery integration", () => {
  it("restores every generated structure after the whole village is destroyed", () => {
    const world = createWorld(42);
    const result = generateVillage(world, { x: 640, y: 560 }, 42);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const village = result.value;
    world.activeVillage = village;
    world.villagers = village.villagers;
    const initial = structuredClone(village);
    const expectedHouses = initial.houses.map((house) => ({
      ...house,
      health: 100,
      destroyed: false,
    }));
    const expectedRoads = initial.roads.map((road) => ({
      ...road,
      damaged: false,
    }));
    const expectedWall = {
      ...initial.wall,
      segments: initial.wall.segments.map((segment) => ({
        ...segment,
        destroyed: false,
      })),
    };

    for (const house of village.houses) {
      house.health = 0;
      house.destroyed = true;
      house.rebuildProgress = 0;
    }
    for (const road of village.roads) {
      road.damaged = true;
      road.rebuildProgress = 0;
    }
    for (const segment of village.wall.segments) {
      segment.destroyed = true;
      segment.rebuildProgress = 0;
    }
    village.anchorDestroyed = true;
    village.anchorRebuildProgress = 0;

    for (let tick = 0; tick < 500; tick += 1) {
      updateDisasters(world, 100);
      updateVillagerTasks(world, 100);
    }

    expect(village.houses).toEqual(expectedHouses);
    expect(village.roads).toEqual(expectedRoads);
    expect(village.wall).toEqual(expectedWall);
    expect(village.anchor).toEqual(initial.anchor);
    expect(village.anchorDestroyed).not.toBe(true);
    expect(world.villagers.map((villager) => ({
      id: villager.id,
      houseId: villager.houseId,
      health: villager.health,
      status: villager.status,
    }))).toEqual(initial.villagers.map((villager) => ({
      id: villager.id,
      houseId: villager.houseId,
      health: villager.health,
      status: villager.status,
    })));
    const rebuildTargetCount = initial.houses.length
      + initial.roads.length
      + initial.wall.segments.length
      + 1;
    expect(world.villagerTasks.filter((task) => task.type === "rebuild_structure"))
      .toHaveLength(rebuildTargetCount);
    expect(world.villagerTasks.filter((task) =>
      task.type === "rebuild_structure" && task.status === "completed"))
      .toHaveLength(rebuildTargetCount);
  });
});
