import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { PlannerCoordinator } from "./app/PlannerCoordinator";
import { SimulationController as ApplicationController } from "./app/SimulationController";
import { VillageEngine } from "./engine/engine";
import { VillageRenderer } from "./renderer/VillageRenderer";
import { adaptSimulationController } from "./ui/useSimulation";
import type { WorldRendererAdapter } from "./ui/WorldViewport";
import "./styles/reset.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/controls.css";
import "./styles/decision-notifications.css";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("Village Brain requires a #root element.");
}

const engine = new VillageEngine({ seed: 1, initialWorld: "ocean" });
const planner = new PlannerCoordinator({
  port: {
    createRequest: (eventIds) => engine.createPlannerRequest(eventIds),
    createFallback: (request) => engine.createFallbackPlan(request),
    executePlan: ({ response, source }) => { engine.executePlan(response, source); },
  },
});
const applicationController = new ApplicationController({ engine, planner });
const controller = adaptSimulationController(applicationController);
const renderer: WorldRendererAdapter = {
  mount(host) {
    const villageRenderer = new VillageRenderer(host, (command) => {
      applicationController.dispatch(command);
    });
    const render = () => {
      const snapshot = applicationController.getUiSnapshot();
      villageRenderer.render(snapshot.world, snapshot);
    };
    const unsubscribe = applicationController.subscribeUi(render);
    render();
    void villageRenderer.init().catch(() => undefined);
    return () => {
      unsubscribe();
      villageRenderer.destroy();
    };
  },
};

createRoot(rootElement).render(
  <StrictMode>
    <App controller={controller} renderer={renderer} />
  </StrictMode>,
);
