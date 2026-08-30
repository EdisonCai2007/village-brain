import type { SeededRandom } from "./types";

const MULBERRY_INCREMENT = 0x6d2b79f5;
const UINT32_RANGE = 0x1_0000_0000;

export const createRandom = (seed: number): SeededRandom => {
  let state = seed >>> 0;

  return {
    get state(): number {
      return state;
    },

    next(): number {
      state = (state + MULBERRY_INCREMENT) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / UINT32_RANGE;
    },

    nextInt(max: number): number {
      if (!Number.isSafeInteger(max) || max <= 0) {
        throw new RangeError("max must be a positive safe integer");
      }
      return Math.floor(this.next() * max);
    },
  };
};
