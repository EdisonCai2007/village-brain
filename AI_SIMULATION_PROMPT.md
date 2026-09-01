# AI-Responsive Village Sandbox Prompt

## Original Prompt

Build a 2D web-based AI simulation where the user first paints an island terrain and an ocean. Once they hit start simulation, a simple rural village is generated. The player can then trigger disasters like fire, flood, bandits, and further terrain edits. The AI acts as the village chief. It never pathfinds or moves units. It outputs high-level structured intents like "relocate," "defend event ID," or "split villagers." The deterministic engine handles all the low-level logic: villager selection, positioning, movement, safe zone calculation. Implement debounced planning, collect events for a short window, say one second, then send a concise snapshot of active events to the planner. Use LangChain to orchestrate the planning pipeline. Prompt the LLM with a strict JSON schema, validate outputs, and execute intents. No LangGraph initially. Keep it linear, but keep the modules clear: engine, planner, renderer, UI. Tech stack: React plus TypeScript with Vite for UI, PixiJS for 2D render, and a separate deterministic simulation loop outside of React. Add an AI timeline panel that logs each plan in plain language for transparency and debugging. The goal is an interactive AI-responsive sandbox, rather than a traditional city builder.

## Working Interpretation

This project should be an interactive sandbox where the player shapes the environment first, then observes how a village responds to changing threats. The AI should make strategic, chief-like decisions, while the deterministic simulation remains responsible for all exact mechanics.

The main boundary is:

- AI planner decides high-level intent.
- Simulation engine executes deterministic behavior.
- Renderer displays the world.
- React UI manages tools, controls, panels, and user input.



## Proposed Module Boundaries

- `engine`: Deterministic simulation loop, world state, villagers, events, disasters, movement, safety scoring, and intent execution.
- `planner`: LangChain pipeline, model-provider adapter, event snapshot generation, JSON schema prompt, output validation, retry or fallback behavior.
- `renderer`: PixiJS scene rendering, terrain painting display, villagers, structures, disasters, overlays, and animations.
- `ui`: React controls for terrain and disaster tools, the world-boot tutorial, notification board, and planner status.



## Resolved Product Decisions

- The app should use a real LLM API. There should not be a mock planner mode as the main implementation target.
- The model provider should be replaceable through a small provider adapter, so changing the LLM does not change the simulation engine or planner interface.
- Start with Gemini as the initial provider because planner calls should be small, structured, and cost-sensitive.
- The exact Gemini model can be selected later through configuration. A cheap, fast Gemini model is the expected starting point.
- The browser should not call the LLM provider directly. Planner calls should go through a small local backend endpoint so API keys stay private.
- Terrain starts with only two paintable types: land and ocean.
- Rivers should be derived from painted water, not created by a separate river brush. A narrow connected water shape can be classified by the deterministic engine as river-like based on local water width and continuity.
- Bridges should be derived from path crossings. When a path crosses river-like water, the renderer can show that crossing as a gray stone or bridge segment, but the player still only painted water and path.
- The player should always be able to edit terrain. There is no separate terrain setup phase that locks once simulation begins.
- There should not be a separate `Start Simulation` button. The simulation runs live, and the village begins once the player places the village totem.
- Villagers are individual units, but they do not have fixed roles or professions.
- Any villager can be assigned to any action. For example, the AI can send three villagers to extinguish a fire or send another set to defend against bandits, but those villagers are not permanently classified as firefighters, guards, farmers, or builders.
- Disasters are player-triggered only. The engine should not spawn new disasters automatically.
- Disaster effects can still evolve after being triggered. For example, a player-triggered fire can spread according to deterministic simulation rules.
- The experience should be a toy sandbox, not a survival challenge.
- There should be no hard game-over state.
- Villagers can all die and a village can be destroyed, but the player should be able to continue editing the world and place a new village totem afterward.
- UI layout should be designed later by the implementation/design process rather than tightly prescribed upfront.



## Simulation Feel And Failure State

The project should feel like a live AI-response sandbox. The purpose is to observe how an AI chief reacts to changing world conditions, not to beat a survival scenario.

The simulation may still have serious consequences:

- Villagers can die.
- Buildings can be damaged or destroyed.
- A whole village can collapse.
- Disasters can make an area unsafe.

These outcomes should not end the session. There is no hard game-over screen. The player can keep painting terrain, trigger more events, and place another village totem to create a new village after the previous one is gone or no longer useful.

The UI should support this sandbox feel by making world editing, event triggering, and AI timeline inspection available without forcing the player through a fixed campaign or challenge structure.

## Core Gameplay Loop

The simulation should feel like a live canvas. The player can paint terrain at any time, place a village totem, trigger disasters, and watch the AI chief respond through deterministic villagers.

The core loop is:

1. The player paints land and water using brush tools.
2. The player can adjust brush size with a numeric control.
3. The player places a village totem on land.
4. Placing the totem starts village generation and live simulation behavior.
5. The deterministic engine creates the initial village around the totem, starting with houses and villagers.
6. The village exists as deterministic state. It can later expand or build additional structures, but the initial target is a simple generated cluster of houses.
7. The player triggers disasters such as fire, tsunami, or bandits.
8. The engine collects active events for a short debounce window, then sends a concise world snapshot to the AI planner.
9. The AI chief returns high-level intents.
10. The deterministic engine translates those intents into concrete villager tasks.
11. Villagers move to task locations, act, resolve or fail tasks, and return to the village when their task is complete.
12. The AI timeline logs the plan and outcome so the player can understand what the chief tried to do.
13. The loop repeats while the player continues editing terrain and triggering events.



## Player Tools

- Land brush: paints land onto the canvas.
- Water brush: paints water onto the canvas. This can represent ocean, lakes, or river-like shapes, but the underlying terrain type remains water.
- Brush size control: numeric control that changes the radius or width of terrain painting.
- Village totem placement: places the village origin marker. This is the anchor for generating houses and villagers.
- Fire disaster tool: places or triggers a fire event on the map.
- Tsunami disaster tool: triggered from a clicked water location. The tsunami should move toward the closest reachable land and damage affected terrain, buildings, or villagers according to deterministic rules.
- Bandit disaster tool: spawns a fixed-size group of bandits at the clicked location. The initial default should be four bandits per trigger.
- Earthquake disaster tool: triggers an instant shock around the clicked point.
- Plague disaster tool: introduces sickness into villagers near the clicked point.
- Pause control: pauses and resumes simulation time.
- Camera controls: pan and zoom should be supported so the player can inspect and edit the island comfortably.



## Derived Terrain Classifications

The player-facing terrain model should remain simple: land and water are the only paintable terrain types at first. The engine may derive extra classifications from those painted shapes when that helps simulation or rendering.

### River-Like Water

A river is not a separate placed object or terrain brush. It is an inferred classification of painted water.

The engine should classify local water as river-like when it forms a narrow connected band through or along land. A practical first-pass heuristic is:

- Build a binary terrain mask for land and water.
- For each water cell or sampled point, estimate distance to the nearest land edge.
- Treat local water width as approximately `distanceToNearestLand * 2`.
- Mark water as river-like when local width is below a configurable `maxRiverWidth`.
- Require enough connected narrow-water samples to avoid classifying tiny puddles as rivers.
- Optionally require a minimum river-like segment length before bridge rendering or planner summaries use the river classification.

This classification should remain deterministic and should not create a third editable terrain type. If the player widens the water shape beyond the threshold, the same painted region should behave more like lake or ocean water.

### Bridge Crossings

Bridges should be inferred from path geometry crossing river-like water. The player should not need a separate bridge tool for the first implementation.

The first bridge rule should be:

- If a path segment intersects water classified as river-like, render the intersecting path span as a gray stone or bridge segment.
- If a path crosses broad water that is not river-like, do not automatically render a bridge unless a future feature explicitly supports larger bridge construction.
- Pathfinding may treat inferred bridge crossings as valid traversal points if the path already exists across the river-like water.

The visual purpose is to make narrow painted water read as a river without adding a new player-facing tool. The player mental model should be: "I painted water, and because it is narrow, the engine understands it as river-like; where my path crosses it, the renderer shows a bridge."

## Disaster Behavior

The initial disaster set should include five player-triggered disasters:

- Fire
- Tsunami
- Bandits
- Earthquake
- Plague or sickness

The engine owns all deterministic disaster behavior: spread, movement, damage, target selection, collision, status changes, and resolution. The AI chief only receives summarized active events and returns high-level response intents.

### Fire

Fire starts where the player clicks with the fire tool. It can burn land and buildings.

Fire should spread at random intervals, similar in spirit to random tick updates in Minecraft. Each active fire cell or fire entity can periodically attempt to spread to nearby valid land or building targets. Water blocks fire spread.

Villagers can be assigned to extinguish fire. The AI may decide how many villagers to send, but the engine chooses exact villagers, positions them, moves them, and applies extinguishing progress.

### Tsunami

Tsunami starts from a clicked water location or water-side target. It should be represented as an active moving wave front, not as a static patch painted onto the ground.

The first visual model should be a long flat curved blue band, similar to a rounded rectangle or bowed line, with a lighter crest line at the leading edge. It should move toward land along a deterministic direction vector. A faint trailing wash is acceptable, but the tsunami should not look like a raised icon or irregular puddle.

The tsunami entity should include:

- Front curve or front bounds.
- Direction vector.
- Speed.
- Width.
- Depth or hit band thickness.
- Lifetime or maximum travel distance.
- Damage rules.

As it moves inland, the wave checks collision against map objects and terrain features. The first deterministic damage rules should be simple:

- Villager hit: removed, killed, or marked swept away.
- House hit: destroyed.
- Tree hit: removed.
- Path hit: erased or marked damaged.
- Wall hit: destroyed or broken at the impacted segment.
- Village monument hit: destroyed if directly overlapped.
- Land remains land initially unless erosion becomes an explicit future feature.

The AI can respond by relocating villagers, prioritizing rescue, or moving villagers away from the impact zone, but it does not control the wave path. Planner snapshots should describe the tsunami as an incoming moving hazard with direction, front bounds, speed, estimated time to relevant assets, and likely impacted objects.

### Bandits

Bandits spawn at the clicked location as a group of four. Each click creates one bandit group.

Bandits can attack villagers, steal from the village, and damage or break buildings. They are hostile deterministic units controlled by the engine.

The AI can send villagers to defend against a bandit event. Evacuation may be valid in rare cases, but defense should usually be the more useful response because bandits can continue pursuing or damaging the village if left alone.

### Earthquake

Earthquake triggers an instant shock around the clicked point. The shock can damage nearby houses and other village structures.

Earthquakes can also create pits as temporary or persistent hazard entities. Pits are not a third paintable terrain type; they are disaster-created hazards layered on top of land/water terrain.

Villagers can fall into pits if they move through or near them according to deterministic engine rules. Other villagers can be assigned to rescue trapped villagers.

### Plague Or Sickness

Plague starts near the clicked point and spreads between nearby villagers over time.

The AI can respond by isolating sick villagers, moving healthy villagers away, splitting the village, or relocating villagers to deterministic safe areas. The engine is responsible for calculating safe zones and deciding exactly which villagers move where.

Planner snapshots should include enough health and proximity information for the AI to reason about isolation and relocation without exposing low-level movement or pathfinding decisions.

## Village And Villager Behavior

The village starts when the player places the village totem. The totem can be represented visually as a hut, statue, or central village marker. The first implementation should generate houses around the totem rather than requiring gradual construction from nothing. The village may also include simple wall structures around the village center. Visually, walls should be top-down connected line boundaries rather than front-facing palisade posts.

Villagers are deterministic units. They do not make independent AI decisions and do not have fixed jobs. The engine assigns them tasks based on validated AI intents.

When the AI creates an intent, it should specify the task to perform, the relevant event or target area, and how many villagers should be assigned. The AI should not choose exact villager IDs unless a future feature explicitly requires that. The deterministic engine should select the villagers, usually by choosing the closest available villagers to the task target.

Each assigned villager receives a deterministic task package:

- Task type, such as `extinguish_fire`, `rescue_trapped_villager`, `defend_against_bandits`, `relocate`, or `found_village`.
- Target event ID or target position.
- Optional destination position or destination area, especially for relocation or founding a new village.
- Task metadata required by the engine, such as desired villager count, priority, or source plan ID.

Once assigned, villagers behave according to the engine rules for that task:

- Fire task: move to valid positions near the fire and apply extinguishing progress.
- Earthquake rescue task: move to a pit or trapped villager and attempt to pull the trapped villager out.
- Bandit defense task: move toward the bandit event and fight hostile units.
- Plague isolation task: move sick villagers away from healthy villagers, or move healthy villagers to a safer area.
- Relocation or split-village task: move selected villagers to a deterministic safe zone or planner-requested destination and optionally create a new village anchor there.

Villagers should return to the village, a village anchor, or an idle safe position after their assigned task is complete, unless the task itself moves them into a new village or relocation area.

Example task flow:

1. Fire starts.
2. The planner decides to send three villagers to fight the fire.
3. The engine selects the three closest available villagers to the fire.
4. The engine moves them to valid positions near the fire.
5. The villagers perform the extinguish action.
6. When the fire is resolved or the task is abandoned, the villagers return to the village and become available again.



## LLM Planner Design

The AI acts as the village chief. It receives concise snapshots of active world events and returns high-level structured intents. It does not select exact pathing, positions, animation steps, or low-level villager movement.

The planner should expose a stable interface, independent of the provider:

- Input: compact world snapshot, active event summary, available villager count, relevant terrain/safety summary, and recent plan history.
- Output: validated strategic intents such as `relocate`, `defend_event`, `fight_fire`, `rescue_trapped`, `isolate_sick`, `found_village`, or `split_villagers`.
- Provider implementation: Gemini through LangChain initially.
- Configuration: provider name, model name, and API key should live outside application code.

Each planner intent should include enough structure for deterministic execution:

- Intent type.
- Target event ID or target area.
- Requested villager count.
- Optional destination area for relocation, isolation, or founding a new village.
- Plain-language rationale for the AI timeline.

The engine should treat villager count as a request, not an absolute guarantee. If fewer villagers are available, it should assign the best available subset and log that outcome.

The backend planner endpoint should call the LangChain planner pipeline, validate the JSON response, and return only safe, executable intents to the deterministic engine.

Invalid planner output should be handled explicitly:

- Retry once with a concise repair prompt.
- If the second response is invalid, create an AI timeline entry explaining the failure.
- Execute a deterministic emergency fallback rather than letting the simulation stall.



## Clarification Questions

1. Should village generation be fully deterministic from a seed, or can it vary randomly each run?
2. Should terrain edits during simulation be constrained so the player cannot directly delete villagers or buildings?
3. Should the local planner backend be a lightweight Express server, Vite middleware, or another backend shape?
4. Which exact Gemini model should be used once implementation begins?
5. Should disaster tools use fixed defaults only, or should the UI expose controls such as tsunami speed, fire spread rate, earthquake radius, or plague contagiousness?



## Initial Implementation Notes

- Keep the simulation loop outside React state to avoid tying frame updates to component rendering.
- Use React state for tool selection, panels, timeline entries, and high-level snapshots of simulation state.
- Debounce planner requests by collecting active events over a short window, initially `1000ms`.
- Validate every planner response before execution. Invalid responses should produce a timeline entry and fall back to a deterministic safe behavior.
- Log each AI plan in plain language alongside the raw validated intent for debugging.
- Avoid LangGraph for the first version; a linear planner chain is enough until branching or long-running workflows are needed.
- Keep the planner linear and debounced: collect events briefly, send one concise request, validate, execute, and log.
