import { useEffect, useRef } from "react";

import type { SimulationController, SimulationSnapshot } from "./useSimulation";

export interface WorldRendererAdapter {
  mount(host: HTMLElement, controller: SimulationController): void | (() => void);
}

export interface WorldViewportProps {
  readonly controller: SimulationController;
  readonly snapshot: SimulationSnapshot;
  readonly renderer?: WorldRendererAdapter;
}

export function WorldViewport({ controller, snapshot, renderer }: WorldViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null || renderer === undefined) return undefined;
    return renderer.mount(host, controller);
  }, [controller, renderer]);

  return (
    <section className="world-panel" aria-label="Interactive top-down village world">
      <div className="world-frame" aria-busy={snapshot.loading}>
        <div
          ref={hostRef}
          className="world-canvas-host"
          role="img"
          aria-label="Interactive top-down village world"
          tabIndex={0}
          data-tutorial-target="world"
        />
        {snapshot.loading ? (
          <div className="world-state" role="status" aria-label="Preparing the village board">
            <span className="world-state__spinner" aria-hidden="true" />
          </div>
        ) : null}
        {!snapshot.loading && snapshot.world === null ? (
          <div
            className="world-state world-state--error"
            role="alert"
            aria-label={snapshot.error ?? "No world loaded"}
          >
            <span className="world-state__error-mark" aria-hidden="true" />
          </div>
        ) : null}
      </div>
    </section>
  );
}
