import { describe, expect, it } from "vitest";
import {
  AIPlannerResponseSchema,
  PlannerRequestSchema,
  PlannerResponseSchema,
} from "./planner-contract";

const validIntent = {
  type: "fight_fire",
  targetEventId: "event-1",
  villagerCount: 3,
  priority: 1,
  rationale: "It threatens two homes.",
};

const validRequest = {
  requestId: "request-1",
  world: {
    simulationTimeMs: 12_000,
    seed: 42,
    villageCount: 1,
    availableVillagers: 7,
    safeAreas: [{ id: "safe-1", x: 128, y: 256, capacity: 12 }],
  },
  activeEvents: [{
    id: "event-1",
    type: "fire",
    x: 180,
    y: 220,
    severity: 3,
    likelyImpactCount: 2,
  }],
  recentPlans: [],
};

describe("PlannerResponseSchema", () => {
  it("accepts a valid fight-fire plan", () => {
    expect(PlannerResponseSchema.safeParse({
      planId: "plan-1",
      summary: "Contain the closest fire.",
      intents: [validIntent],
    }).success).toBe(true);
  });

  it.each([
    ["an unknown intent", { ...validIntent, type: "invent_response" }],
    ["a zero villager count", { ...validIntent, villagerCount: 0 }],
    ["a missing rationale", (() => {
      const { rationale: _rationale, ...intent } = validIntent;
      return intent;
    })()],
  ])("rejects %s", (_description, intent) => {
    expect(PlannerResponseSchema.safeParse({
      planId: "plan-1",
      summary: "Contain the closest fire.",
      intents: [intent],
    }).success).toBe(false);
  });

  it("rejects plans with six intents", () => {
    expect(PlannerResponseSchema.safeParse({
      planId: "plan-1",
      summary: "Contain the closest fire.",
      intents: Array.from({ length: 6 }, () => validIntent),
    }).success).toBe(false);
  });

  it("allows an empty plan when the chief has no safe action", () => {
    const emptyPlan = {
      planId: "fallback-request-1",
      summary: "No actionable active event remains.",
      intents: [],
    };

    expect(PlannerResponseSchema.safeParse(emptyPlan).success).toBe(true);
    expect(AIPlannerResponseSchema.safeParse(emptyPlan).success).toBe(true);
    expect(AIPlannerResponseSchema.safeParse({
      ...emptyPlan,
      planId: "plan-ai",
      intents: [validIntent],
    }).success).toBe(true);
  });

  it("rejects area intents that prescribe exact destinations", () => {
    expect(PlannerResponseSchema.safeParse({
      planId: "plan-1",
      summary: "Move villagers away from the tsunami.",
      intents: [{
        type: "relocate",
        targetArea: { id: "safe-1", x: 128, y: 256, capacity: 12 },
        villagerCount: 3,
        priority: 1,
        rationale: "The current location is in the incoming wave path.",
      }],
    }).success).toBe(false);
  });

  it.each(["relocate", "found_village", "split_villagers"])(
    "accepts the %s intent with a high-level area strategy",
    (type) => {
      expect(PlannerResponseSchema.safeParse({
        planId: "plan-1",
        summary: "Keep the village safe.",
        intents: [{
          type,
          strategy: "nearest_safe_area",
          villagerCount: 3,
          priority: 1,
          rationale: "The engine should select the exact destination.",
        }],
      }).success).toBe(true);
    },
  );
});

describe("PlannerRequestSchema", () => {
  it.each([1, 20])("accepts %i compact active events", (eventCount) => {
    expect(PlannerRequestSchema.safeParse({
      ...validRequest,
      activeEvents: Array.from({ length: eventCount }, (_, index) => ({
        ...validRequest.activeEvents[0],
        id: `event-${index + 1}`,
      })),
    }).success).toBe(true);
  });

  it("accepts an empty active-event list for a safe no-op fallback", () => {
    expect(PlannerRequestSchema.safeParse({
      ...validRequest,
      activeEvents: [],
    }).success).toBe(true);
  });
});
