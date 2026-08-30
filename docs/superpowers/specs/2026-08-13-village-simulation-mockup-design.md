# Village Simulation Mockup Design

## Goal

Create a static local web mockup that shows what the Village Brain project could look like once the simulation is running. The mockup should feel like a paused frame from the actual sandbox rather than a marketing page or final game screen.

## Approved Direction

Cinematic Map: a polished top-down scene with land, walls, river, fires, bandits, villagers, and AI-planning UI visible in one composed viewport.

## Composition

The page opens directly into the simulation board. A large canvas-like island map dominates the viewport. A compact tool rail sits on the left with land, water, village totem, fire, tsunami, bandit, earthquake, plague, brush size, pause, and camera controls. A right panel shows the AI chief timeline with current plan, rationale, and deterministic outcome. Small status chips above the map summarize planner debounce, live events, villagers available, and simulation speed.

## Map Content

The map should include a hand-shaped landmass surrounded by ocean, a river crossing the island, a palisade wall around a central village, clustered huts, villagers, a totem, a spreading fire, a bandit group, a tsunami front, earthquake pits, plague isolation marks, and dashed route overlays from the AI response.

## Implementation Surface

Use a static HTML/CSS/JavaScript page in `mockup/`. The mockup is not interactive beyond browser resizing. Rendering the village scene on a canvas is acceptable because the requested deliverable is a flat image-like web view.

## Success Criteria

- The village, wall, river, land, bandits, fire, and AI timeline are visible without scrolling on desktop.
- The UI clearly communicates this is an AI-responsive sandbox with brush tools and planner output.
- The page can be served locally and iterated visually after user feedback.
- The design does not require external image assets or network dependencies.

## Element Library Extension

Add a static element library below the primary mockup so each simulation asset can be evaluated by itself. The library should include terrain, village structures, villager states, hostile/disaster objects, and planner overlays. Each element appears as a small drawn specimen with a label and category, using the same canvas style as the main map.
