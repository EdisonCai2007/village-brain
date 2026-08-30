import { createRandom } from "./random";
import type { House, Point } from "./types";

export const MIN_RESIDENTS_PER_HOUSE = 3;
export const MAX_RESIDENTS_PER_HOUSE = 4;

const hashText = (text: string): number => {
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
};

export const residentCountForHouse = (seed: number, houseId: string): number => {
  const random = createRandom((seed ^ hashText(houseId) ^ 0x85eb_ca6b) >>> 0);
  return MIN_RESIDENTS_PER_HOUSE + random.nextInt(MAX_RESIDENTS_PER_HOUSE - MIN_RESIDENTS_PER_HOUSE + 1);
};

export const residentPositionsForHouse = (house: House, count: number): Point[] => {
  if (!Number.isSafeInteger(count) || count < MIN_RESIDENTS_PER_HOUSE || count > MAX_RESIDENTS_PER_HOUSE) {
    throw new RangeError("resident count must be three or four");
  }
  const towardFrontage = Math.atan2(
    house.frontage.y - house.position.y,
    house.frontage.x - house.position.x,
  );
  const tangent = towardFrontage + Math.PI / 2;
  const lateralSpacing = count === 3 ? 7 : 6;
  const middle = (count - 1) / 2;
  return Array.from({ length: count }, (_item, index) => {
    const lateral = (index - middle) * lateralSpacing;
    const centerForwardBoost = count % 2 === 1 && index === Math.floor(middle) ? 4 : 0;
    const forward = 7 + centerForwardBoost;
    return {
      x: house.position.x + Math.cos(towardFrontage) * forward + Math.cos(tangent) * lateral,
      y: house.position.y + Math.sin(towardFrontage) * forward + Math.sin(tangent) * lateral,
    };
  });
};
