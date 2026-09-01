# Village Brain Interactive Sandbox Design

> Status: Historical implementation brief. The final runtime is the React/PixiJS app in `src/` plus the Node server in `server/`; the prototype, entity inspector, status bar, and adaptive-generation pipeline referenced in this document are not part of the release source.

## Goal

Turn the existing static Canvas village-generation proof into the complete interactive Village Brain product described by `PRODUCT.md`, `DESIGN.md`, and `AI_SIMULATION_PROMPT.md`. The finished local web app lets a player paint land and water, place a deterministic village, trigger five disasters, pause and navigate the world, and understand an AI chief's strategic response through a transparent timeline. The AI chooses high-level intents only; deterministic code owns selection, pathing, movement, damage, and resolution.

## Source-of-Truth Reconciliation

The product brief defines the intended application. The visual design defines the art language. The simulation prompt defines mechanics and the planner/engine boundary. The 2026-08-13 static-mockup spec and 2026-08-15 organic-generation spec are completed prototypes whose proven geometry, palette, and visual lessons should be preserved, but their explicit non-goals no longer limit this full-product implementation.

The implementation resolves the prompt's remaining questions as follows:

- All simulation randomness and village generation derive from a visible integer seed.
- Terrain remains editable while the simulation is live. Painting water under an occupied object relocates that object to the nearest valid land cell when possible; otherwise the object is removed through a logged deterministic terrain consequence.
- A lightweight Node HTTP server serves the production app and the planner endpoint. Vite provides frontend development and proxies `/api` locally.
- Gemini is configured through `GEMINI_MODEL`, defaulting to `gemini-3.5-flash-lite`; the provider remains replaceable behind one interface.
- Disaster tools use fixed, documented defaults in the first version. The tool rail explains the active default instead of exposing tuning controls.
- No start button exists. The fixed-step engine is live immediately; placing a totem creates or replaces the active village.

## Considered Approaches

### 1. Extend the existing Canvas prototype directly

This was the smallest initial diff, but the former `mockup/village-scene.js` mixed scene setup, drawing primitives, URL state, and generated layout rendering. Adding live state, input, planner calls, and simulation logic there would have erased the module boundaries required by the product.

### 2. Build the full app and discard the prototype

This gives a clean TypeScript architecture but risks losing the seed-tested village geometry and approved painted art language. It also creates avoidable visual regression risk.

### 3. Progressive typed replacement (selected)

Build the complete React, TypeScript, PixiJS, and Node application alongside the former mockup as a temporary reference. Port the generator's structural rules and the scene's palette/drawing language into focused typed modules. Keep the original proof and evaluation artifacts as comparison evidence. This provides clean production boundaries while retaining the best existing work; the temporary mockup is removed after the production implementation is established.

## Runtime Architecture

The repository becomes a single npm project with two runtime entry points:

- `src/`: Vite React application.
- `server/`: Node planner/API server and production static host.

The frontend is divided into four dependency directions:

1. `engine` contains pure domain state, commands, deterministic updates, world queries, intent execution, and snapshot creation. It has no React, PixiJS, DOM, network, or LLM dependencies.
2. `planner` contains shared schemas plus the browser planner client and debounced coordinator. It depends on engine snapshot types but never mutates engine internals directly.
3. `renderer` owns PixiJS scene construction, camera transforms, interaction coordinate conversion, and drawing. It consumes read-only engine snapshots and emits player commands.
4. `ui` owns React controls, timeline, status surfaces, onboarding, and accessibility. It talks to one application controller rather than storing frame-by-frame simulation state.

The server imports only the shared planner contract. Its provider adapter calls Gemini through LangChain, validates structured output, retries one repair attempt, and returns a normalized result. Missing credentials, timeouts, invalid responses, or provider errors produce a typed failure; the frontend records the failure and executes the same deterministic emergency policy used for all planner failures.

## Deterministic World Model

The engine uses a logical 128 by 86 terrain grid mapped to a 1280 by 860 world. Each cell is `land` or `water`. The default seed creates the approved rounded island and narrow river so the first screen is meaningful, while either brush can edit any reachable cell. A fixed 100 ms simulation tick and seeded PRNG make the same seed plus the same ordered commands reproducible.

World state contains:

- terrain cells and derived narrow-water/river classifications;
- one active village anchor, houses, walls, roads, bridges, trees, and villagers;
- fires, tsunami fronts, bandit groups, earthquake pits, plague infections, and transient effects;
- villager assignments, deterministic routes, health/status, and task progress;
- simulation clock, pause state, speed, seed, event sequence, and timeline entries.

Placing a totem on land runs terrain-aware street-first village generation around the clicked point. The generated road tree, house frontages, bridge crossings, and occupied-core wall use the existing generator's tested invariants, scaled and translated into the chosen land area. If a full layout cannot fit, the command fails visibly and leaves the current village unchanged.

The simulation controller owns `requestAnimationFrame` accumulation, advances the engine in bounded fixed steps, and publishes throttled read models to React. React never drives movement. The renderer may animate between read models, but canonical positions advance only in engine ticks.

## Tools and Interaction

The persistent tool rail exposes land, water, totem, fire, tsunami, bandits, earthquake, plague, inspect, and pan. Brush size is a numeric/range control. Pause/resume and reset-world actions are explicit. Wheel/pinch zoom and drag-to-pan work independently of the active disaster tool; keyboard shortcuts expose common tools and pause.

Painting interpolates between pointer samples so fast drags do not leave gaps. Commands are clamped to world bounds. Placement validity is previewed under the pointer and invalid placements return a short, non-blocking explanation.

The interface opens into the live sandbox with a compact first-run hint rather than a modal walkthrough. Desktop uses a left tool rail, central world, and right AI timeline. Narrow screens move the timeline below the map and turn the tool rail into a horizontally scrollable control surface. Text and controls stay outside the artwork canvas in accordance with the approved art direction.

## Disaster Rules

All disasters are player-triggered and receive stable event IDs.

- **Fire:** A click ignites a land cell. On bounded seeded random ticks, fire spreads to a neighboring burnable cell; water blocks spread. Houses take damage. Assigned villagers route to safe adjacent cells and reduce intensity.
- **Tsunami:** A click must begin on water. The engine computes a direction toward the nearest land/village assets and advances a broad front. Each object is damaged at most once per wave. Land remains land.
- **Bandits:** A click creates four hostile units. They route toward the closest village asset, attack villagers or structures, and can be stopped by assigned defenders using deterministic combat rolls from the world PRNG.
- **Earthquake:** A click applies one radial damage pulse and creates a small bounded set of pits on land. Villagers intersecting pits become trapped; rescue tasks can free them.
- **Plague:** A click infects nearby villagers. Infection spreads through deterministic proximity checks and timed exposure. Isolation intents move selected villagers toward a computed low-density safe point.

There is no game-over state. Dead villagers and destroyed structures remain consequences in the timeline. The player can keep editing and place another totem to establish a new village.

## Planner Contract and Data Flow

The engine emits a `PlannerSnapshot` containing the current simulation time, seed, village counts, available villagers, active event summaries, relevant distances/estimated impact, derived safety zones, and a short recent-plan history. It omits per-frame geometry and internal path nodes.

The planner coordinator collects newly created or materially changed events for 1,000 ms. One request covers the whole window. While a request is in flight, later events form the next window rather than spawning parallel calls. Requests have a bounded timeout and can be aborted on reset.

The validated response contains one to five intents:

- `fight_fire`
- `defend_event`
- `rescue_trapped`
- `isolate_sick`
- `relocate`
- `found_village`
- `split_villagers`

Each intent includes a target event or area, requested villager count, priority, and plain-language rationale. The engine clamps counts, rejects stale targets, selects the closest available villagers with stable tie-breaking, computes exact destinations and routes, and records the actual assignment outcome.

The timeline has separate states for observation, planning, plan, execution, outcome, and error/fallback. The default deterministic emergency policy prioritizes imminent tsunami relocation, active fire response, bandit defense, trapped rescue, and plague isolation in that order. It is a resilience path, not a simulated LLM mode.

## Rendering and Visual System

PixiJS renders the world in layers: water/background, land/shore, derived paths and bridges, structures and wall, hazards, units, intent/route overlays, and transient feedback. Graphics are rebuilt only when their source revision changes; moving units update transforms per published frame.

The renderer ports the approved tokens and shapes from `DESIGN.md`: calm natural colors, brown-gray outlines, rounded terrain, upright front-facing houses, silhouette villagers, connected top-down walls, an opaque obelisk-like village marker, ground-plane fire, and a flat curved tsunami front. Repeated state uses consistent colors. Status changes use small rings, icons, or route lines rather than random asset recoloring.

The saved screenshots and product-verification evidence remain as visual reference. The former static `mockup/` is not part of the release tree, and the app does not depend on it at runtime.

## Error Handling and Safety

- Invalid tool placement never partially mutates the world.
- Malformed imported/runtime state is rejected by schema guards at module boundaries.
- Planner calls have one repair attempt on the server, a hard timeout, and structured errors without secrets.
- API keys are read only on the server and are never included in Vite-exposed environment variables or client bundles.
- The fixed-step controller caps catch-up work per animation frame to prevent a background tab from causing a CPU spike.
- Path searches, terrain classification, placement attempts, spread attempts, and event histories have explicit bounds.
- Development and verification use one server, serial tests, explicit command timeouts, and exact-process CPU inspection whenever a process fails to return promptly.

## Testing Strategy

Pure engine tests verify deterministic replay, painting, derived water classification, terrain-aware village placement, bridge/wall invariants, every disaster lifecycle, villager assignment, planner fallback, reset, pause, and no-game-over recovery. Planner contract tests cover valid/invalid intents, stale targets, over-allocation, debounce batching, and typed provider failures. UI component tests cover tool selection, keyboard access, planner states, timeline details, and responsive semantic structure.

A lightweight production build and static typecheck verify integration. Browser verification uses one local server and one browser session to exercise the core story: edit terrain, place a village, trigger each disaster, observe deterministic movement/outcomes, inspect planner/fallback transparency, pause, pan, zoom, and reset. Visual screenshots at desktop and narrow widths are compared against the design rules and the current final reference seeds.

## Implementation Phases

1. **Foundation and contracts:** Scaffold Vite/React/TypeScript, shared domain types, deterministic utilities, planner schemas, Node server, environment example, and bounded test tooling.
2. **World engine and generation:** Implement terrain, commands, derived water, terrain-aware village generation, structures, fixed-step updates, read models, and deterministic tests.
3. **Disasters and intent execution:** Implement all five hazards, bounded pathing/task assignment, consequence handling, safety scoring, fallback policy, and lifecycle tests.
4. **Planner pipeline:** Implement debounced snapshots, browser client, LangChain Gemini provider, strict validation/repair, status transitions, timeline records, and contract tests.
5. **Pixi renderer and interaction:** Port the approved visual language, world layers, camera, pointer gestures, placement previews, route overlays, and performance-conscious revision updates.
6. **React product shell:** Build the tool rail, brush controls, status bar, AI timeline, onboarding hints, inspector, empty/error states, responsive layout, and accessibility behavior.
7. **Integration and revision:** Exercise the full gameplay loop, repair discrepancies between docs and behavior, verify desktop/mobile visuals, harden CPU bounds, and record evidence.

## Completion Criteria

The work is complete when the app builds and runs locally; the full player toolset works; placing a totem generates a deterministic valid village; all five disasters evolve through bounded deterministic mechanics; planner requests are debounced, structured, server-side, and transparently logged; every low-level action remains engine-owned; pause/pan/zoom/reset and continued play after total loss work; automated checks pass; and a single-session browser audit finds no blocking errors or repeated high-impact visual failures.

## Non-Goals

- Campaigns, win conditions, economy, professions, inventory, or technology trees.
- Automatic disaster spawning.
- Multiplayer, authentication, persistence, or cloud deployment.
- Arbitrary map import/export.
- LangGraph or multi-agent planning.
- A separate bridge, river, wall, path, house, or villager placement tool.
