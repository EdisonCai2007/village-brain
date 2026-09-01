import { useCallback, useEffect, useState } from "react";

import { DecisionNotifications } from "./ui/DecisionNotifications";
import { ToolRail } from "./ui/ToolRail";
import { WorldBootTutorial } from "./ui/WorldBootTutorial";
import { WorldViewport, type WorldRendererAdapter } from "./ui/WorldViewport";
import {
  createDisconnectedController,
  useSimulation,
  type SimulationController,
  type ToolId,
} from "./ui/useSimulation";
import {
  getTutorialStep,
  nextTutorialStep,
  tutorialStepCanAdvance,
  type TutorialStepId,
} from "./ui/tutorial";

const SHORTCUT_TO_TOOL: Readonly<Record<string, ToolId>> = Object.freeze({
  "1": "land",
  "2": "water",
  "3": "totem",
  "4": "fire",
  "5": "tsunami",
  "6": "bandits",
  "7": "earthquake",
  "8": "plague",
  h: "pan",
});

interface ShortcutEvent {
  readonly key: string;
  readonly target: EventTarget | { readonly tagName?: string } | null;
  preventDefault(): void;
}

interface ShortcutActions {
  readonly selectTool: (tool: ToolId) => void;
  readonly togglePause: () => void;
}

function isFormTarget(target: ShortcutEvent["target"]): boolean {
  if (target === null || !("tagName" in target)) return false;
  const tagName = target.tagName?.toUpperCase();
  return tagName === "INPUT" || tagName === "SELECT" || tagName === "TEXTAREA" || tagName === "BUTTON";
}

export function handleSandboxShortcut(event: ShortcutEvent, actions: ShortcutActions): void {
  if (isFormTarget(event.target)) return;
  if (event.key === " " || event.key === "Spacebar") {
    event.preventDefault();
    actions.togglePause();
    return;
  }
  const tool = SHORTCUT_TO_TOOL[event.key.toLowerCase()];
  if (tool !== undefined) {
    event.preventDefault();
    actions.selectTool(tool);
  }
}

export interface AppProps {
  readonly controller?: SimulationController;
  readonly createController?: () => SimulationController;
  readonly renderer?: WorldRendererAdapter;
}

export function App({ controller, createController, renderer }: AppProps) {
  const [simulationController] = useState<SimulationController>(() => (
    controller ?? createController?.() ?? createDisconnectedController()
  ));
  const snapshot = useSimulation(simulationController);
  const [tutorialStep, setTutorialStep] = useState<TutorialStepId | null>("welcome");

  useEffect(() => {
    simulationController.start();
    return () => simulationController.stop();
  }, [simulationController]);

  const selectTool = useCallback((tool: ToolId) => simulationController.selectTool(tool), [simulationController]);
  const setBrushSize = useCallback((size: number) => simulationController.setBrushSize(size), [simulationController]);
  const togglePause = useCallback(() => simulationController.togglePause(), [simulationController]);
  const reset = useCallback(() => simulationController.reset(), [simulationController]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => handleSandboxShortcut(event, { selectTool, togglePause });
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectTool, togglePause]);

  const world = snapshot.world;
  const controlsDisabled = snapshot.loading || snapshot.error !== null;
  const plannerStatus = snapshot.error ?? snapshot.latestFeedback?.message ?? snapshot.plannerStatus;
  const tutorialFacts = {
    activeTool: snapshot.activeTool,
    hasLand: world?.terrain.some((cell) => cell === 1) ?? false,
    hasVillage: world?.activeVillage !== null && world?.activeVillage !== undefined,
    hasBanditEvent: world?.events.some((event) => event.type === "bandits") ?? false,
  } as const;
  const tutorialCanAdvance = tutorialStep === null
    ? false
    : tutorialStepCanAdvance(tutorialStep, tutorialFacts);
  const finishTutorial = useCallback(() => {
    setTutorialStep(null);
  }, []);
  const handleTutorialNext = useCallback(() => {
    if (tutorialStep === null || !tutorialCanAdvance) return;
    const next = nextTutorialStep(tutorialStep, tutorialFacts);
    if (next === null) finishTutorial();
    else setTutorialStep(next);
  }, [finishTutorial, tutorialCanAdvance, tutorialFacts, tutorialStep]);
  const replayTutorial = useCallback(() => {
    setTutorialStep("welcome");
  }, []);

  useEffect(() => {
    if (tutorialStep === null) return;
    const action = getTutorialStep(tutorialStep).action;
    if (action !== "select-land" && action !== "select-totem" && action !== "select-bandits") return;
    const next = nextTutorialStep(tutorialStep, tutorialFacts);
    if (next !== tutorialStep) setTutorialStep(next);
  }, [tutorialFacts, tutorialStep]);

  return (
    <div className="app-shell">
      <main className="workspace" aria-label="Village sandbox">
        <WorldViewport controller={simulationController} snapshot={snapshot} renderer={renderer} />
        <ToolRail
          activeTool={snapshot.activeTool}
          brushSize={snapshot.brushSize}
          disabled={controlsDisabled}
          paused={world?.paused ?? false}
          onToolSelect={selectTool}
          onBrushSizeChange={setBrushSize}
          onPauseToggle={togglePause}
          onReset={reset}
          onReplayTutorial={replayTutorial}
        />
        <DecisionNotifications entries={snapshot.timeline} />
        <div className="visually-hidden" aria-live="polite" role="status">{plannerStatus}</div>
        {snapshot.error === null ? null : (
          <div className="visually-hidden" role="alert">{snapshot.error}</div>
        )}
      </main>
      {tutorialStep === null ? null : (
        <WorldBootTutorial
          step={tutorialStep}
          canAdvance={tutorialCanAdvance && !controlsDisabled}
          onNext={handleTutorialNext}
          onSkip={finishTutorial}
        />
      )}
    </div>
  );
}

export default App;
