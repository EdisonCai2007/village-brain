import { describe, expect, it } from "vitest";

import { findNewEarthquakeEventIds } from "./earthquakeRumble";

describe("findNewEarthquakeEventIds", () => {
  it("returns only earthquake events that have not already triggered a rumble", () => {
    const events = [
      { id: "event-fire", type: "fire" },
      { id: "event-quake-old", type: "earthquake" },
      { id: "event-quake-new", type: "earthquake" },
    ];

    expect(findNewEarthquakeEventIds(events, new Set(["event-quake-old"]))).toEqual([
      "event-quake-new",
    ]);
  });
});
