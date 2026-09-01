import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { App, handleSandboxShortcut } from "../App";
import { createDisconnectedController, type SimulationController, type SimulationSnapshot } from "./useSimulation";

const snapshotWithTimeline: SimulationSnapshot = {
  world: null,
  plannerStatus: "idle",
  activeTool: "land",
  brushSize: 28,
  loading: false,
  error: null,
  latestFeedback: null,
  timeline: [{
    id: "plan-1",
    simulationTimeMs: 5_000,
    kind: "plan",
    summary: "ai plan plan-1: Send builders to reinforce the bridge.",
  }, {
    id: "execution-1",
    simulationTimeMs: 5_100,
    kind: "execution",
    summary: "plan-1 execution: rebuild_structure requested 2, actual 2 (assigned).",
  }],
};

const timelineController: SimulationController = {
  getSnapshot: () => snapshotWithTimeline,
  getServerSnapshot: () => snapshotWithTimeline,
  subscribe: () => () => undefined,
  start: () => undefined,
  stop: () => undefined,
  selectTool: () => undefined,
  setBrushSize: () => undefined,
  togglePause: () => undefined,
  reset: () => undefined,
};

describe("App", () => {
  it("keeps planner feedback and status accessible", () => {
    const markup = renderToStaticMarkup(<App controller={createDisconnectedController()} />);

    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('role="alert"');
  });

  it("shows the tutorial on startup even when an old completion flag exists", () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: () => "true",
          setItem: () => undefined,
          removeItem: () => undefined,
        },
      },
    });

    try {
      const markup = renderToStaticMarkup(<App controller={createDisconnectedController()} />);
      expect(markup).toContain("Welcome to Village Brain");
    } finally {
      if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else Object.defineProperty(globalThis, "window", originalWindow);
    }
  });

  it("keeps the original notifications over the sandbox without a separate timeline panel", () => {
    const markup = renderToStaticMarkup(<App controller={timelineController} />);

    expect(markup).toContain('class="decision-notifications"');
    expect(markup).toContain('data-tutorial-target="notifications"');
    expect(markup).not.toContain('class="timeline-panel"');
    expect(markup).not.toContain("Chief’s timeline");
    expect(markup).toContain("Send builders to reinforce the bridge.");
  });

  it("marks real sandbox surfaces as tutorial spotlight targets", () => {
    const markup = renderToStaticMarkup(<App controller={timelineController} />);

    expect(markup).toContain('data-tutorial-target="toolbar"');
    expect(markup).toContain('data-tutorial-target="land"');
    expect(markup).toContain('data-tutorial-target="totem"');
    expect(markup).toContain('data-tutorial-target="bandits"');
    expect(markup).toContain('data-tutorial-target="notifications"');
  });

  it.each([
    ["1", "land"], ["2", "water"], ["3", "totem"], ["4", "fire"],
    ["5", "tsunami"], ["6", "bandits"], ["7", "earthquake"], ["8", "plague"],
    ["H", "pan"],
  ] as const)("maps %s to the %s tool", (key, tool) => {
    const selectTool = vi.fn();
    const togglePause = vi.fn();
    const preventDefault = vi.fn();

    handleSandboxShortcut({ key, target: { tagName: "DIV" }, preventDefault }, { selectTool, togglePause });

    expect(selectTool).toHaveBeenCalledWith(tool);
    expect(togglePause).not.toHaveBeenCalled();
  });

  it("does not map the removed inspect shortcut", () => {
    const selectTool = vi.fn();
    const togglePause = vi.fn();
    const preventDefault = vi.fn();

    handleSandboxShortcut({ key: "i", target: { tagName: "DIV" }, preventDefault }, { selectTool, togglePause });

    expect(selectTool).not.toHaveBeenCalled();
    expect(togglePause).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("toggles pause with space and ignores shortcuts from form controls", () => {
    const selectTool = vi.fn();
    const togglePause = vi.fn();
    const preventDefault = vi.fn();

    handleSandboxShortcut({ key: " ", target: { tagName: "DIV" }, preventDefault }, { selectTool, togglePause });
    expect(togglePause).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();

    handleSandboxShortcut({ key: "1", target: { tagName: "INPUT" }, preventDefault }, { selectTool, togglePause });
    expect(selectTool).not.toHaveBeenCalled();
  });
});
