import { describe, expect, it } from "vitest";

import { GRID_CELL_COUNT } from "../engine/constants";
import { stoneDecor, treeDecor } from "./draw";

describe("world decor generation", () => {
  it("generates deterministic tree decor on land without overlapping rocks", () => {
    const terrain = new Uint8Array(GRID_CELL_COUNT).fill(1);
    const stones = stoneDecor(42, terrain);
    const first = treeDecor(42, terrain, stones);
    const replay = treeDecor(42, terrain, stones);

    expect(first).toEqual(replay);
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(stones.length);
    for (const tree of first) {
      for (const stone of stones) {
        expect(Math.hypot(tree.x - stone.x, tree.y - stone.y)).toBeGreaterThanOrEqual(42);
      }
    }
  });

  it("only places tree decor on land cells", () => {
    const terrain = new Uint8Array(GRID_CELL_COUNT);
    terrain.fill(1);
    terrain.fill(0, 0, 2_000);

    const trees = treeDecor(7, terrain, []);

    expect(trees.length).toBeGreaterThan(0);
    for (const tree of trees) {
      const cellX = Math.floor(tree.x / 10);
      const cellY = Math.floor(tree.y / 10);
      expect(terrain[cellY * 128 + cellX]).toBe(1);
    }
  });
});
