import type { ToolId } from "./useSimulation";

export type TutorialTarget = "world" | "land" | "totem" | "bandits" | "notifications" | "toolbar";

export type TutorialStepId =
  | "welcome"
  | "land-brush"
  | "draw-island"
  | "totem-brush"
  | "place-village"
  | "bandit-brush"
  | "place-bandits"
  | "watch-chief"
  | "try-tools";

export interface TutorialStep {
  readonly id: TutorialStepId;
  readonly title: string;
  readonly description: string;
  readonly target: TutorialTarget;
  readonly action: "next" | "select-land" | "draw-land" | "select-totem" | "place-village" | "select-bandits" | "place-bandits";
}

export interface TutorialFacts {
  readonly activeTool: ToolId;
  readonly hasLand: boolean;
  readonly hasVillage: boolean;
  readonly hasBanditEvent: boolean;
}

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    id: "welcome",
    title: "Welcome to Village Brain",
    description: "Shape an island, start a village, and see how its chief responds to a threat.",
    target: "world",
    action: "next",
  },
  {
    id: "land-brush",
    title: "Choose the land brush",
    description: "The land brush paints solid ground into the ocean world.",
    target: "land",
    action: "select-land",
  },
  {
    id: "draw-island",
    title: "Draw an island",
    description: "Paint any island shape in the middle of the water. A small patch is enough to begin.",
    target: "world",
    action: "draw-land",
  },
  {
    id: "totem-brush",
    title: "Choose the village totem",
    description: "The totem marks where the deterministic village generator will build its first settlement.",
    target: "totem",
    action: "select-totem",
  },
  {
    id: "place-village",
    title: "Place the village",
    description: "Click a clear spot on your island. Houses, roads, a wall, and villagers will gather around it.",
    target: "world",
    action: "place-village",
  },
  {
    id: "bandit-brush",
    title: "Choose the bandit tool",
    description: "Bandits create a live threat that gives the village chief something to solve.",
    target: "bandits",
    action: "select-bandits",
  },
  {
    id: "place-bandits",
    title: "Place the bandits",
    description: "Click a valid land location near the village to start the bandit event.",
    target: "world",
    action: "place-bandits",
  },
  {
    id: "watch-chief",
    title: "Watch Village Brain work",
    description: "The chief will explain a strategy in the notification board while the deterministic engine carries it out.",
    target: "notifications",
    action: "next",
  },
  {
    id: "try-tools",
    title: "Shape the story",
    description: "Try the other terrain and disaster tools whenever you like. Have fun building a world that reacts.",
    target: "toolbar",
    action: "next",
  },
] as const;

const STEP_BY_ID = new Map(TUTORIAL_STEPS.map((step) => [step.id, step]));

export function getTutorialStep(id: TutorialStepId): TutorialStep {
  const step = STEP_BY_ID.get(id);
  if (step === undefined) throw new Error(`Unknown tutorial step: ${id}`);
  return step;
}

export function tutorialStepCanAdvance(stepId: TutorialStepId, facts: TutorialFacts): boolean {
  switch (getTutorialStep(stepId).action) {
    case "next":
      return true;
    case "select-land":
      return facts.activeTool === "land";
    case "draw-land":
      return facts.hasLand;
    case "select-totem":
      return facts.activeTool === "totem";
    case "place-village":
      return facts.hasVillage;
    case "select-bandits":
      return facts.activeTool === "bandits";
    case "place-bandits":
      return facts.hasBanditEvent;
  }
}

export function nextTutorialStep(stepId: TutorialStepId, facts: TutorialFacts): TutorialStepId | null {
  const step = getTutorialStep(stepId);
  if (step.action === "select-land" && facts.activeTool === "land") return "draw-island";
  if (step.action === "select-totem" && facts.activeTool === "totem") return "place-village";
  if (step.action === "select-bandits" && facts.activeTool === "bandits") return "place-bandits";
  if (!tutorialStepCanAdvance(stepId, facts)) return stepId;
  const index = TUTORIAL_STEPS.findIndex((candidate) => candidate.id === stepId);
  return TUTORIAL_STEPS[index + 1]?.id ?? null;
}
