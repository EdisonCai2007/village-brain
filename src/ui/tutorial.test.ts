import { describe, expect, it } from "vitest";

import {
  nextTutorialStep,
  tutorialStepCanAdvance,
  type TutorialFacts,
} from "./tutorial";

const emptyFacts: TutorialFacts = {
  activeTool: "pan",
  hasLand: false,
  hasVillage: false,
  hasBanditEvent: false,
};

describe("World Boot tutorial state", () => {
  it("keeps selection steps until the real tool is selected", () => {
    expect(nextTutorialStep("land-brush", emptyFacts)).toBe("land-brush");
    expect(nextTutorialStep("land-brush", { ...emptyFacts, activeTool: "land" })).toBe("draw-island");
  });

  it("gates map steps on the corresponding world fact", () => {
    expect(tutorialStepCanAdvance("draw-island", emptyFacts)).toBe(false);
    expect(tutorialStepCanAdvance("draw-island", { ...emptyFacts, hasLand: true })).toBe(true);
    expect(tutorialStepCanAdvance("place-village", { ...emptyFacts, hasVillage: true })).toBe(true);
    expect(tutorialStepCanAdvance("place-bandits", { ...emptyFacts, hasBanditEvent: true })).toBe(true);
  });

  it("walks the complete nine-step sequence and finishes after the final step", () => {
    const facts: TutorialFacts = { ...emptyFacts, activeTool: "land", hasLand: true };

    expect(nextTutorialStep("welcome", facts)).toBe("land-brush");
    expect(nextTutorialStep("land-brush", facts)).toBe("draw-island");
    expect(nextTutorialStep("draw-island", facts)).toBe("totem-brush");
    expect(nextTutorialStep("draw-island", { ...facts, activeTool: "totem", hasVillage: true })).toBe("totem-brush");
    expect(nextTutorialStep("totem-brush", { ...facts, activeTool: "totem" })).toBe("place-village");
    expect(nextTutorialStep("place-village", { ...facts, hasVillage: true })).toBe("bandit-brush");
    expect(nextTutorialStep("bandit-brush", { ...facts, activeTool: "bandits", hasVillage: true })).toBe("place-bandits");
    expect(nextTutorialStep("place-bandits", { ...facts, hasBanditEvent: true, hasVillage: true })).toBe("watch-chief");
    expect(nextTutorialStep("watch-chief", facts)).toBe("try-tools");
    expect(nextTutorialStep("try-tools", facts)).toBeNull();
  });
});
