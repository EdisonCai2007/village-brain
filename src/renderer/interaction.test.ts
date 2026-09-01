import { describe, expect, it } from "vitest";

import {
  beginCommandGesture,
  clampCamera,
  clampScale,
  endCommandGesture,
  fitCameraToWorld,
  interpolateBrushPoints,
  LayerRevisionCache,
  shouldStartViewportPan,
  moveCommandGesture,
  revisionKey,
  zoomCameraAt,
} from "./interaction";

describe("brush interpolation", () => {
  it("fills a fast drag with samples no farther apart than half the radius", () => {
    const points = interpolateBrushPoints({ x: 10, y: 20 }, { x: 110, y: 20 }, 20);

    expect(points[0]).toEqual({ x: 10, y: 20 });
    expect(points.at(-1)).toEqual({ x: 110, y: 20 });
    for (let index = 1; index < points.length; index += 1) {
      expect(Math.hypot(points[index]!.x - points[index - 1]!.x, points[index]!.y - points[index - 1]!.y)).toBeLessThanOrEqual(10);
    }
  });
});

describe("camera helpers", () => {
  it("clamps zoom to the supported range", () => {
    expect(clampScale(0.2)).toBe(0.55);
    expect(clampScale(1.4)).toBe(1.4);
    expect(clampScale(9)).toBe(2.4);
  });

  it("keeps the world point beneath the cursor fixed while zooming", () => {
    const cursor = { x: 410, y: 270 };
    const before = { x: -120, y: -60, scale: 1 };
    const worldBefore = {
      x: (cursor.x - before.x) / before.scale,
      y: (cursor.y - before.y) / before.scale,
    };

    const after = zoomCameraAt(before, cursor, 1.8);
    const worldAfter = {
      x: (cursor.x - after.x) / after.scale,
      y: (cursor.y - after.y) / after.scale,
    };

    expect(worldAfter.x).toBeCloseTo(worldBefore.x);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y);
  });

  it("clamps panning so at least fifteen percent of the world remains visible", () => {
    const clamped = clampCamera(
      { x: 20_000, y: -20_000, scale: 1 },
      { width: 500, height: 300 },
      { width: 1_280, height: 860 },
    );

    expect(clamped.x).toBe(500 - 1_280 * 0.15);
    expect(clamped.y).toBe(-860 * 0.85);
  });

  it("fits the initial world camera with table space below the map", () => {
    const viewport = { width: 2_048, height: 886 };
    const world = { width: 1_280, height: 860 };
    const camera = fitCameraToWorld(viewport, world, 64);

    expect(camera.x).toBeCloseTo((viewport.width - world.width * camera.scale) / 2);
    expect(camera.y).toBeCloseTo((viewport.height - world.height * camera.scale) / 2);
    expect(camera.y).toBeGreaterThanOrEqual(64);
    expect(camera.y + world.height * camera.scale).toBeLessThanOrEqual(viewport.height - 64);
  });

  it("starts viewport panning only for pan-like gestures", () => {
    expect(shouldStartViewportPan({ tool: "pan", button: 0, spacePressed: false, panOverride: false })).toBe(true);
    expect(shouldStartViewportPan({ tool: "fire", button: 1, spacePressed: false, panOverride: false })).toBe(true);
    expect(shouldStartViewportPan({ tool: "fire", button: 0, spacePressed: true, panOverride: false })).toBe(true);
    expect(shouldStartViewportPan({ tool: "fire", button: 0, spacePressed: false, panOverride: true })).toBe(true);
    expect(shouldStartViewportPan({ tool: "fire", button: 0, spacePressed: false, panOverride: false })).toBe(false);
  });
});

describe("command gestures", () => {
  it("emits one disaster command on release and none while dragging", () => {
    const started = beginCommandGesture("fire", { x: 30, y: 40 }, 24);
    const moved = moveCommandGesture(started.session, { x: 80, y: 90 });
    const released = endCommandGesture(moved.session, { x: 100, y: 110 });

    expect(started.commands).toEqual([]);
    expect(moved.commands).toEqual([]);
    expect(released.commands).toEqual([
      { type: "trigger_fire", point: { x: 100, y: 110 } },
    ]);
  });

  it("emits interpolated paint commands during a drag", () => {
    const started = beginCommandGesture("land", { x: 0, y: 0 }, 20);
    const moved = moveCommandGesture(started.session, { x: 25, y: 0 });

    expect(started.commands).toEqual([
      { type: "paint", terrain: "land", point: { x: 0, y: 0 }, radius: 20 },
    ]);
    expect(moved.commands).toHaveLength(3);
    expect(moved.commands.at(-1)).toEqual({
      type: "paint",
      terrain: "land",
      point: { x: 25, y: 0 },
      radius: 20,
    });
  });

  it("does not duplicate the last paint sample when the pointer releases in place", () => {
    const started = beginCommandGesture("water", { x: 45, y: 55 }, 20);

    expect(endCommandGesture(started.session, { x: 45, y: 55 }).commands).toEqual([]);
  });
});

describe("revision keys", () => {
  it("invalidates repeated revision counters when the world is reseeded", () => {
    const cache = new LayerRevisionCache();

    expect(cache.changed("terrain", 42, 0)).toBe(true);
    expect(cache.changed("terrain", 42, 0)).toBe(false);
    expect(cache.changed("terrain", 43, 0)).toBe(true);
    expect(cache.changed("decor", 42, 0)).toBe(true);
    expect(cache.changed("decor", 42, 0)).toBe(false);
    expect(cache.changed("decor", 43, 0)).toBe(true);
    expect(revisionKey(42, 0)).not.toBe(revisionKey(43, 0));
  });
});
