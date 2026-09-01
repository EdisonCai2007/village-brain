import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DecisionNotifications } from "./DecisionNotifications";

const entries = [
  { id: "observation-1", simulationTimeMs: 1_000, kind: "observation" as const, summary: "Smoke appeared beside the storehouse." },
  { id: "planning-1", simulationTimeMs: 2_000, kind: "planning" as const, summary: "The chief checked nearby water access." },
  { id: "plan-1", simulationTimeMs: 3_000, kind: "plan" as const, summary: "ai plan plan-1: Send two villagers to contain the fire." },
  { id: "execution-1", simulationTimeMs: 4_000, kind: "execution" as const, summary: "plan-1 execution: fight_fire requested 2, actual 2 (assigned)." },
];

describe("DecisionNotifications", () => {
  it("renders no overlay when there are no decisions", () => {
    const markup = renderToStaticMarkup(<DecisionNotifications entries={[]} />);

    expect(markup).toBe("");
  });

  it("shows only chief decisions and actual dispatches, newest first", () => {
    const markup = renderToStaticMarkup(<DecisionNotifications entries={entries} />);

    expect(markup.indexOf("Sent 2 villagers to fight the fire.")).toBeLessThan(
      markup.indexOf("Send two villagers to contain the fire."),
    );
    expect(markup).not.toContain("Smoke appeared beside the storehouse.");
    expect(markup).not.toContain("The chief is choosing a response.");
  });

  it("labels the notification history without becoming a live announcement stream", () => {
    const markup = renderToStaticMarkup(<DecisionNotifications entries={entries} />);

    expect(markup).toContain('aria-label="Village notifications"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).not.toContain("aria-live");
    expect(markup).toContain("Chief&#x27;s decision");
    expect(markup).toContain("0:04");
  });

  it("removes backend details from plan and execution notifications", () => {
    const markup = renderToStaticMarkup(<DecisionNotifications entries={[
      {
        id: "plan-1",
        simulationTimeMs: 3_000,
        kind: "plan",
        summary: "ai plan plan-ai: Defend against approaching bandits.",
        source: "ai",
      },
      {
        id: "execution-1",
        simulationTimeMs: 4_000,
        kind: "execution",
        summary: "plan-ai execution: defend_event requested 8, actual 8 (assigned).",
        source: "ai",
      },
      {
        id: "outcome-1",
        simulationTimeMs: 5_000,
        kind: "outcome",
        summary: "plan-ai completed with no executable assignments.",
        source: "ai",
      },
    ]} />);

    expect(markup).toContain("Defend against approaching bandits.");
    expect(markup).toContain("Sent 8 villagers to defend against bandits.");
    expect(markup).not.toContain("plan-ai");
    expect(markup).not.toContain("defend_event");
    expect(markup).not.toContain("actual 8");
    expect(markup).not.toContain("AI chief");
    expect(markup).not.toContain("plan-ai execution");
    expect(markup).not.toContain("completed with no executable assignments");
    expect(markup).not.toContain("Fallback policy");
    expect(markup).not.toContain("Village engine");
  });

  it("shows a clear fire-resolution outcome while suppressing unrelated lifecycle updates", () => {
    const markup = renderToStaticMarkup(<DecisionNotifications entries={[
      {
        id: "village-1",
        simulationTimeMs: 1_000,
        kind: "observation",
        summary: "Village established with 6 houses and 12 villagers.",
      },
      {
        id: "fire-1",
        simulationTimeMs: 2_000,
        kind: "observation",
        summary: "fire event-1 created.",
      },
      {
        id: "planning-1",
        simulationTimeMs: 3_000,
        kind: "planning",
        summary: "The chief is choosing a response.",
      },
      {
        id: "fallback-1",
        simulationTimeMs: 4_000,
        kind: "fallback",
        summary: "fallback plan fallback-1: Deterministic emergency response for 1 active disaster.",
      },
      {
        id: "execution-1",
        simulationTimeMs: 5_000,
        kind: "execution",
        summary: "fallback-1 execution: defend_event requested 4, actual 0 (stale_target).",
      },
      {
        id: "fire-2",
        simulationTimeMs: 6_000,
        kind: "outcome",
        summary: "fire event-1 resolved.",
      },
    ]} />);

    expect(markup).toContain('Fire resolved');
    expect(markup).toContain('The fire was fully extinguished.');
    expect(markup).not.toContain("Smoke appeared");
    expect(markup).not.toContain("The chief is choosing a response");
    expect(markup).not.toContain("completed with no executable assignments");
  });

  it("does not show a fallback explanation when it does dispatch villagers", () => {
    const markup = renderToStaticMarkup(<DecisionNotifications entries={[
      {
        id: "fallback-1",
        simulationTimeMs: 4_000,
        kind: "fallback",
        summary: "fallback plan fallback-1: Deterministic emergency response for 1 active disaster.",
      },
      {
        id: "execution-1",
        simulationTimeMs: 5_000,
        kind: "execution",
        summary: "fallback-1 execution: defend_event requested 4, actual 4 (assigned).",
      },
    ]} />);

    expect(markup).toContain("Sent 4 villagers to defend against bandits.");
    expect(markup).not.toContain("Deterministic emergency response");
  });
});
