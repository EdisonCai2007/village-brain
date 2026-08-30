import { describe, expect, it } from "vitest";
import { createRandom } from "./random";

describe("createRandom", () => {
  it("replays the hand-checked Mulberry32 sequence for the same seed", () => {
    const first = createRandom(42);
    const replay = createRandom(42);
    const expected = [
      0.6011037519201636,
      0.44829055899754167,
      0.8524657934904099,
      0.6697340414393693,
      0.17481389874592423,
    ];

    expect(expected.map(() => first.next())).toEqual(expected);
    expect(expected.map(() => replay.next())).toEqual(expected);
  });

  it("resumes exactly from its serializable integer state", () => {
    const random = createRandom(42);
    random.next();
    random.next();
    const resumed = createRandom(random.state);

    expect(random.state).toBe(3_663_131_668);
    expect(resumed.next()).toBe(random.next());
  });

  it("returns bounded integers and rejects invalid bounds", () => {
    const random = createRandom(7);

    expect(Array.from({ length: 12 }, () => random.nextInt(3))).toEqual([
      0, 0, 2, 2, 1, 1, 1, 0, 1, 2, 0, 0,
    ]);
    expect(() => random.nextInt(0)).toThrow(RangeError);
    expect(() => random.nextInt(1.5)).toThrow(RangeError);
  });
});
