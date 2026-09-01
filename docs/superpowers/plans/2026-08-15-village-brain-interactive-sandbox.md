# Village Brain Interactive Sandbox Implementation Plan

> Status: Completed historical plan. The final release keeps the typed React/PixiJS runtime and Node planner server; the preserved mockup, temporary pipeline, status bar, entity inspector, and onboarding hint mentioned in earlier steps were not retained.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete local Village Brain sandbox with live terrain editing, deterministic village simulation, five player-triggered disasters, PixiJS rendering, and a transparent server-side Gemini planner.

**Architecture:** Use the former `mockup/` as the visual and geometry reference while building a typed Vite/React application in `src/` and a lightweight Node planner server in `server/`. A pure fixed-step engine owns world mechanics; PixiJS renders immutable read models; React owns controls and panels; LangChain Gemini returns only Zod-validated strategic intents.

**Tech Stack:** Node 24, npm, React 19, TypeScript 7, Vite 8, PixiJS 8, Vitest 4, Zod 4, LangChain `@langchain/google`, Node HTTP server.

## Global Constraints

- Keep reference artifacts intact during development; the standalone `mockup/` is not part of the final release tree.
- Use a logical 128×86 terrain grid mapped to a 1280×860 world.
- Advance canonical simulation state in deterministic 100 ms ticks outside React.
- Cap animation catch-up at five ticks per frame and cap every search/placement loop explicitly.
- Use one seeded PRNG for all simulation randomness; the same seed plus ordered commands must replay identically.
- Keep land and water as the only paintable terrain types; derive narrow river-like water and bridges.
- Never expose `GOOGLE_API_KEY` or `GEMINI_MODEL` in client code or `VITE_*` variables.
- Debounce planner event batches for 1,000 ms and allow only one planner request in flight.
- The planner returns strategic intents only; engine code owns IDs, selection, routing, movement, damage, and resolution.
- Do not add game-over, campaign, economy, roles/professions, persistence, authentication, or automatic disasters.
- Verification is serial and bounded. Use shell `timeout` when available; otherwise poll within the stated bound. If anything stalls, inspect the exact process with `ps -p <pid> -o pid,pcpu,pmem,etime,command` and terminate only that process before switching approaches.
- This workspace has no Git metadata. Mark plan checkpoints and preserve filesystem changes; do not initialize a repository solely to manufacture commits.

---

## File Structure

### Project and runtime configuration

- `package.json`: scripts and pinned dependency ranges.
- `package-lock.json`: reproducible dependency graph.
- `index.html`: Vite application entry.
- `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`: strict browser/server TypeScript projects.
- `vite.config.ts`: React plugin, test environment, and `/api` development proxy.
- `.env.example`: server-only planner configuration.
- `.gitignore`: dependencies, builds, local env, and browser artifacts.

### Shared contracts

- `src/shared/planner-contract.ts`: Zod schemas and inferred planner request/response types shared by browser and server.
- `src/shared/result.ts`: small typed success/failure result used at runtime boundaries.

### Deterministic engine

- `src/engine/types.ts`: canonical world, command, entity, event, task, and read-model types.
- `src/engine/constants.ts`: world/tick/default-disaster limits.
- `src/engine/random.ts`: serializable seeded PRNG.
- `src/engine/geometry.ts`: bounded spatial helpers and polygon/segment predicates.
- `src/engine/terrain.ts`: default island, paint commands, river classification, safe-cell queries, and revision tracking.
- `src/engine/navigation.ts`: bounded deterministic A* over terrain cells.
- `src/engine/village.ts`: terrain-aware street-first generation and validation.
- `src/engine/disasters.ts`: fire, tsunami, bandit, earthquake, and plague lifecycle updates.
- `src/engine/tasks.ts`: intent validation, villager selection, task routing, actions, and return-to-village behavior.
- `src/engine/planning.ts`: compact snapshot creation and deterministic fallback policy.
- `src/engine/engine.ts`: `VillageEngine` command dispatch, fixed tick, subscriptions, reset, and read-model publication.
- `src/engine/*.test.ts`: adjacent pure tests for each module.

### Application orchestration and planner client

- `src/app/SimulationController.ts`: bounded `requestAnimationFrame` loop, UI state, commands, planner coordination, and throttled subscriptions.
- `src/app/PlannerCoordinator.ts`: one-second event batching, one in-flight request, abort/reset, fallback execution, and planner status.
- `src/app/planner-client.ts`: typed `/api/plan` fetch with timeout and Zod response validation.
- `src/app/*.test.ts`: fake-clock planner and fixed-step controller tests.

### PixiJS renderer

- `src/renderer/palette.ts`: exact `DESIGN.md` tokens.
- `src/renderer/draw.ts`: focused PixiJS drawing primitives for terrain, structures, hazards, villagers, and overlays.
- `src/renderer/VillageRenderer.ts`: asynchronous PixiJS 8 application, revision-based layers, camera, hit conversion, and teardown.
- `src/renderer/interaction.ts`: pointer-paint interpolation, pan/zoom gestures, hover preview, and keyboard-neutral command emission.

### React product UI

- `src/main.tsx`: React mount.
- `src/App.tsx`: controller lifetime and responsive shell composition.
- `src/ui/useSimulation.ts`: `useSyncExternalStore` adapters for engine and UI read models.
- `src/ui/ToolRail.tsx`: tools, shortcuts, brush size, pause, and reset.
- `src/ui/WorldViewport.tsx`: Pixi canvas host, placement hint, and accessible live feedback.
- `src/ui/StatusBar.tsx`: seed, clock, population, active events, planner state, and camera hint.
- `src/ui/Timeline.tsx`: observation/plan/execution/outcome/fallback entries and structured intent details.
- `src/ui/Inspector.tsx`: selected event/entity facts without debug noise.
- `src/ui/OnboardingHint.tsx`: dismissible first-run guidance.
- `src/ui/icons.tsx`: dependency-free SVG icons.
- `src/styles/*.css`: reset, tokens, shell, controls, timeline, and responsive states.
- `src/ui/*.test.tsx`: semantic UI and interaction tests.

### Planner server

- `server/index.ts`: Node HTTP API, dev entry, production static serving, body limit, timeout, and structured errors.
- `server/planner.ts`: provider interface, system prompt, Gemini LangChain adapter, structured output, and repair attempt.
- `server/planner.test.ts`: provider injection tests with no network calls.

### Evidence

- `README.md`: setup, scripts, controls, planner configuration, architecture boundary, and CPU-safe verification.
- `artifacts/product-verification/final-evaluation.md`: final requirement-by-requirement evidence.
- `artifacts/product-verification/desktop.png`: final desktop screenshot.
- `artifacts/product-verification/mobile.png`: final narrow-layout screenshot.

---

### Task 1: Project Foundation and Shared Planner Contract

**Files:**
- Create: `package.json`, `index.html`, `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`, `vite.config.ts`, `.gitignore`, `.env.example`
- Create: `src/shared/result.ts`, `src/shared/planner-contract.ts`, `src/shared/planner-contract.test.ts`

**Interfaces:**
- Consumes: Node 24 and the planner intent vocabulary from the design spec.
- Produces: `PlannerRequestSchema`, `PlannerResponseSchema`, `PlannerIntentSchema`, `PlannerRequest`, `PlannerResponse`, `Result<T, E>`.

- [x] **Step 1: Add the strict project scaffold and bounded scripts**

Use React 19, Vite 8, PixiJS 8, Vitest 4, Zod 4, `@langchain/google`, and `@langchain/core`. Define scripts exactly as `dev`, `dev:server`, `build`, `start`, `typecheck`, `test`, and `test:run`; `test:run` must use `vitest run --no-file-parallelism --maxWorkers=1`.

```json
{
  "type": "module",
  "scripts": {
    "dev": "vite",
    "dev:server": "tsx watch server/index.ts",
    "build": "tsc -b && vite build",
    "start": "tsx server/index.ts",
    "typecheck": "tsc -b --pretty false",
    "test": "vitest",
    "test:run": "vitest run --no-file-parallelism --maxWorkers=1"
  }
}
```

- [x] **Step 2: Write failing shared-contract tests**

Test that one valid `fight_fire` response parses; a response with an unknown intent, zero villagers, six intents, or a missing rationale fails; and a request accepts one to twenty compact active events.

```ts
expect(PlannerResponseSchema.safeParse({
  planId: "plan-1",
  summary: "Contain the closest fire.",
  intents: [{ type: "fight_fire", targetEventId: "event-1", villagerCount: 3, priority: 1, rationale: "It threatens two homes." }],
}).success).toBe(true);
```

- [x] **Step 3: Run the contract test and verify failure**

Run: `timeout 30 npm run test:run -- src/shared/planner-contract.test.ts`

Expected: FAIL because the shared schemas do not exist.

- [x] **Step 4: Implement strict Zod contracts and typed results**

Use `z.discriminatedUnion("type", ...)` for all seven intent shapes. Require `villagerCount` from 1 through 100, `priority` from 1 through 5, nonempty rationale up to 240 characters, one through five intents, and `.strict()` objects. Planner requests include `requestId`, `world`, `activeEvents`, and `recentPlans` only.

```ts
export const PlannerIntentSchema = z.discriminatedUnion("type", [
  targetedIntent("fight_fire"), targetedIntent("defend_event"), targetedIntent("rescue_trapped"),
  targetedIntent("isolate_sick"), areaIntent("relocate"), areaIntent("found_village"), areaIntent("split_villagers"),
]);
```

- [x] **Step 5: Install dependencies and run the focused test**

Run: `timeout 120 npm install`

Run: `timeout 30 npm run test:run -- src/shared/planner-contract.test.ts`

Expected: dependency install exits `0`; focused tests pass with one worker.

- [x] **Step 6: Record the checkpoint**

Mark Task 1 checked and record installed versions in the plan footer if npm resolves newer compatible patch releases.

### Task 2: Deterministic Terrain, Geometry, and Navigation

**Files:**
- Create: `src/engine/constants.ts`, `src/engine/types.ts`, `src/engine/random.ts`, `src/engine/geometry.ts`, `src/engine/terrain.ts`, `src/engine/navigation.ts`
- Create: `src/engine/random.test.ts`, `src/engine/terrain.test.ts`, `src/engine/navigation.test.ts`

**Interfaces:**
- Consumes: `{ seed: number }` and `TerrainPaintCommand { terrain, point, radius }`.
- Produces: `createWorld(seed): WorldState`, `paintTerrain(world, command): CommandResult`, `classifyRiverLike(world): Uint8Array`, `findNearestLand(world, point, maxCells): Point | null`, `findPath(world, from, to, maxVisited): Point[] | null`.

- [x] **Step 1: Write failing deterministic terrain tests**

Assert identical seeds create identical terrain/PRNG sequences, the default map contains a large landmass and one connected narrow-water band, painting is interpolatable and increments `terrainRevision`, water painting relocates an occupying villager to the same deterministic cell on replay, and all loops stay within world bounds.

```ts
const first = createWorld(42);
const replay = createWorld(42);
expect([...first.terrain]).toEqual([...replay.terrain]);
expect(paintTerrain(first, { type: "paint", terrain: "water", point: { x: 620, y: 500 }, radius: 20 }).ok).toBe(true);
expect(first.terrainRevision).toBe(1);
```

- [x] **Step 2: Write failing navigation tests**

Assert land-to-land paths never include water cells, the same query is stable, unreachable destinations return `null`, bridge cells are traversable only when a generated bridge marks them, and `maxVisited` aborts a deliberately oversized search.

- [x] **Step 3: Run focused tests and verify failure**

Run: `timeout 30 npm run test:run -- src/engine/random.test.ts src/engine/terrain.test.ts src/engine/navigation.test.ts`

Expected: FAIL on missing engine modules.

- [x] **Step 4: Implement serializable PRNG, terrain grid, and geometry helpers**

Use a Mulberry32-compatible `{ state, next(), nextInt(max) }`; row-major `Uint8Array` terrain; integer-safe cell/world conversion; bounded flood fill; point/segment distance; polygon containment; and segment intersection. Generate the default island from a seeded ellipse perturbation and carve a continuous narrow curved water band.

- [x] **Step 5: Implement deterministic A* with explicit limits**

Use four-way grid neighbors, Manhattan heuristic, stable neighbor order `north,east,south,west`, a binary min-heap with coordinate tie-break, and hard `maxVisited <= 4096`. Return simplified world-space waypoints, never engine entity IDs.

- [x] **Step 6: Run focused tests and typecheck**

Run: `timeout 30 npm run test:run -- src/engine/random.test.ts src/engine/terrain.test.ts src/engine/navigation.test.ts`

Run: `timeout 30 npm run typecheck`

Expected: focused tests and typecheck pass.

### Task 3: Terrain-Aware Village Generation

**Files:**
- Create: `src/engine/village.ts`, `src/engine/village.test.ts`
- Modify: `src/engine/types.ts`, `src/engine/terrain.ts`, `src/engine/navigation.ts`

**Interfaces:**
- Consumes: `generateVillage(world, anchor, seed): CommandResult<VillageState>`.
- Produces: roads with parent IDs, houses with owning-road frontage, bridges derived from narrow-water crossings, an occupied-core wall with explicit gates, villagers, and `evaluateVillage(world, village): string[]`.

- [x] **Step 1: Write failing generation and invariant tests**

Across seeds `1, 7, 19, 42, 314`, place anchors at valid default-island points and assert deterministic deep equality, at least six houses and twelve villagers, connected road parent chains, exact frontage ownership, bridge/crossing parity, land-only structures, a wall enclosing houses and anchor, and no closed wall/road intersection.

```ts
const result = generateVillage(createWorld(seed), { x: 640, y: 560 }, seed);
expect(result.ok).toBe(true);
expect(evaluateVillage(world, result.value)).toEqual([]);
```

- [x] **Step 2: Add invalid-placement tests**

Assert water anchors, shore-edge anchors, and deliberately cramped painted islands return a reason without changing the existing village. Assert placing a second valid totem replaces the active village but keeps terrain and simulation time.

- [x] **Step 3: Run the focused test and verify failure**

Run: `timeout 30 npm run test:run -- src/engine/village.test.ts`

Expected: FAIL because village generation is absent.

- [x] **Step 4: Port the street-first structural rules into typed, translated geometry**

Generate a seeded spine, entrance, two bounded branches, frontage houses, and fallback growth around the clicked anchor. Try at most 16 orientation/scale variants. Validate every candidate against current land and occupied footprints before committing. Derive river crossings from terrain samples and allow crossings only where the local water width is at most nine cells.

- [x] **Step 5: Generate the wall, villagers, and independent evaluator**

Build a convex occupied-core envelope with fixed clearance, split wall segments at real road crossings, and reject river-intersecting walls. Spawn two villagers per house at stable frontage offsets. Implement evaluator predicates independently of generator branch decisions so mutations are detected.

- [x] **Step 6: Run generation tests and the original generator regression**

Run: `timeout 30 npm run test:run -- src/engine/village.test.ts`

Run: `timeout 20 node --test mockup/village-generation.test.mjs`

Expected: new tests pass; all 11 existing prototype tests still pass.

### Task 4: Engine Command Surface and Fixed-Step Lifecycle

**Files:**
- Create: `src/engine/engine.ts`, `src/engine/engine.test.ts`
- Modify: `src/engine/types.ts`, `src/engine/terrain.ts`, `src/engine/village.ts`

**Interfaces:**
- Produces: `new VillageEngine({ seed })`, `dispatch(command): CommandResult`, `tick(stepMs = 100): void`, `getSnapshot(): WorldReadModel`, `subscribe(listener): () => void`, `drainPlanningEvents(): PlanningEvent[]`, `reset(seed): void`.

- [x] **Step 1: Write failing command and lifecycle tests**

Assert paint/totem/pause/reset commands mutate through `dispatch`, paused ticks do not advance time, invalid commands append nonblocking feedback without partial state, resetting reproduces the original snapshot, published snapshots are not mutable references into engine state, and no tick executes when passed a non-100 ms step.

- [x] **Step 2: Run the engine test and verify failure**

Run: `timeout 30 npm run test:run -- src/engine/engine.test.ts`

Expected: FAIL because `VillageEngine` is missing.

- [x] **Step 3: Implement command dispatch and read-model publication**

Keep canonical mutable state private. Increment `worldRevision`, `terrainRevision`, `structureRevision`, `hazardRevision`, and `unitRevision` only for relevant changes. Bound timeline history to 200 entries and feedback to the latest item.

```ts
dispatch(command: WorldCommand): CommandResult {
  if (command.type === "toggle_pause") return this.setPaused(!this.state.paused);
  if (command.type === "reset") return this.reset(command.seed);
  return this.applyValidatedWorldCommand(command);
}
```

- [x] **Step 4: Implement terrain-consequence reconciliation**

After painting, relocate villagers/hostiles via `findNearestLand(..., 256)`, remove unrecoverable trees, reject paint strokes that would invalidate the active anchor, rebuild derived river flags/bridges, and append one summarized terrain consequence rather than one entry per cell.

- [x] **Step 5: Run lifecycle tests and typecheck**

Run: `timeout 30 npm run test:run -- src/engine/engine.test.ts src/engine/terrain.test.ts src/engine/village.test.ts`

Run: `timeout 30 npm run typecheck`

Expected: all focused tests and typecheck pass.

### Task 5: Five Deterministic Disaster Lifecycles

**Files:**
- Create: `src/engine/disasters.ts`, `src/engine/disasters.test.ts`
- Modify: `src/engine/types.ts`, `src/engine/constants.ts`, `src/engine/engine.ts`

**Interfaces:**
- Consumes: `trigger_fire`, `trigger_tsunami`, `trigger_bandits`, `trigger_earthquake`, and `trigger_plague` commands.
- Produces: active `WorldEvent` entities, planning-event notifications, deterministic tick updates, damage/destruction, and resolution/outcome timeline entries.

- [x] **Step 1: Write one failing placement test per disaster**

Fire requires land, tsunami requires water, bandits require land and spawn exactly four, earthquake applies exactly one radial pulse plus at most three pits, and plague requires at least one living villager within its initial radius. Invalid triggers must not consume an event ID.

- [x] **Step 2: Write failing lifecycle tests**

Use small bounded tick counts: fire spreads but never through water; a tsunami moves toward land and damages each object once; bandits pursue and attack; earthquake pits trap intersecting villagers; plague spreads only within the configured proximity/exposure window. Replaying the same seed and commands yields identical event and damage snapshots.

- [x] **Step 3: Run the disaster test and verify failure**

Run: `timeout 30 npm run test:run -- src/engine/disasters.test.ts`

Expected: FAIL because disaster rules are absent.

- [x] **Step 4: Implement bounded trigger validation and event creation**

Use constants: fire intensity `100`, spread attempt every `1,500 ms`, tsunami width `220`, speed `28 world units/s`, four bandits, earthquake radius `120`, and plague radius `90`. Assign monotonic `event-N` IDs only after validation succeeds.

- [x] **Step 5: Implement tick updates and consequence records**

Cap fire cells at 96 and one spread attempt per active cell per interval; cap a tsunami lifetime at 24 seconds; cap bandit path recomputation at once per second; cap pits at three; cap plague pair checks to living villagers and resolve an event when no infected villagers remain. Each event stores `createdAt`, `updatedAt`, `status`, `severity`, and compact facts for the planner.

- [x] **Step 6: Run disaster and determinism tests**

Run: `timeout 40 npm run test:run -- src/engine/disasters.test.ts src/engine/engine.test.ts`

Expected: tests pass in under 10 seconds on one worker. If the command exceeds 20 seconds, inspect its PID/CPU before waiting again.

### Task 6: Strategic Intent Execution and Deterministic Fallback

**Files:**
- Create: `src/engine/tasks.ts`, `src/engine/planning.ts`, `src/engine/tasks.test.ts`, `src/engine/planning.test.ts`
- Modify: `src/engine/types.ts`, `src/engine/disasters.ts`, `src/engine/engine.ts`

**Interfaces:**
- Consumes: `executePlan(response: PlannerResponse, source: "ai" | "fallback")`.
- Produces: assigned `VillagerTask`s, exact deterministic paths/destinations, plan/execution/outcome timeline entries, `createPlannerRequest(state, events)`, and `createFallbackPlan(request)`.

- [x] **Step 1: Write failing selection and allocation tests**

Assert stale targets are rejected, requested counts clamp to available villagers, closest-idle selection uses distance then villager ID, already assigned/trapped/dead villagers are excluded, one villager belongs to at most one intent, and actual assignment counts are logged.

- [x] **Step 2: Write failing action tests**

Assert fire tasks reduce fire intensity, defenders damage bandits, rescuers free trapped villagers, isolation increases sick/healthy separation, relocate moves selected villagers to an engine-computed safe zone, and all completed survivors return to the anchor or become idle at a new founded anchor.

- [x] **Step 3: Write failing snapshot and fallback tests**

Assert requests omit exact villager IDs/path nodes, include counts and compact events, cap recent plans at five, and fallback priority is tsunami → fire → bandits → rescue → plague. With no actionable event, fallback returns an empty safe plan rather than inventing work.

- [x] **Step 4: Run focused tests and verify failure**

Run: `timeout 40 npm run test:run -- src/engine/tasks.test.ts src/engine/planning.test.ts`

Expected: FAIL because task execution and planning modules are missing.

- [x] **Step 5: Implement intent translation, movement, and task actions**

Resolve each intent to valid engine targets, calculate destinations, call bounded navigation, reserve villagers, advance movement by at most `36 world units/s`, and resolve/abandon tasks with one outcome entry. Store source plan ID and source (`ai` or `fallback`) on every assignment.

- [x] **Step 6: Implement compact snapshots and emergency policy**

Summarize active events with distances, ETA when meaningful, likely impacted counts, available villagers, safe-area centroids, village counts, and five recent outcomes. Fallback uses the same `PlannerResponseSchema` and engine execution path as AI plans.

- [x] **Step 7: Run engine suites**

Run: `timeout 50 npm run test:run -- src/engine`

Expected: all engine tests pass serially with no open handles.

### Task 7: Debounced Planner Client and Gemini Server

**Files:**
- Create: `src/app/planner-client.ts`, `src/app/PlannerCoordinator.ts`, `src/app/PlannerCoordinator.test.ts`
- Create: `server/planner.ts`, `server/index.ts`, `server/planner.test.ts`
- Modify: `vite.config.ts`, `src/engine/engine.ts`, `.env.example`

**Interfaces:**
- Produces: `requestPlan(request, signal): Promise<Result<PlannerResponse, PlannerClientError>>`, `PlannerCoordinator`, `PlannerProvider.plan(request): Promise<PlannerResponse>`, `createPlannerHandler({ provider, timeoutMs })`.

- [x] **Step 1: Write failing coordinator tests with fake timers**

Queue two events 600 ms apart and assert one request after the 1,000 ms quiet window. While it is in flight, queue another event and assert a second request starts only after the first settles. Assert reset aborts the request, HTTP/validation/timeout errors execute one fallback, and planner status traverses `collecting → planning → executing → idle`.

- [x] **Step 2: Write failing injected-provider server tests**

POST a valid body to the handler and assert normalized JSON; reject methods other than POST, bodies over 64 KiB, malformed JSON, invalid requests, provider timeout, and invalid provider output. Verify error bodies never include the API key or raw provider response.

- [x] **Step 3: Run planner tests and verify failure**

Run: `timeout 40 npm run test:run -- src/app/PlannerCoordinator.test.ts server/planner.test.ts`

Expected: FAIL because coordinator and server modules are absent.

- [x] **Step 4: Implement the client and coordinator**

Use `AbortSignal.timeout(8_000)` combined with reset abort, `fetch("/api/plan")`, response size checking, and Zod parse. Keep exactly one debounce timer and one in-flight promise; never poll.

- [x] **Step 5: Implement the LangChain Gemini adapter**

Use the current `@langchain/google` `ChatGoogle` class and `withStructuredOutput(PlannerResponseSchema)`. Configure `GOOGLE_API_KEY` and `GEMINI_MODEL || "gemini-2.5-flash-lite"`. Prompt the chief with the strategic boundary, available intent vocabulary, compact request JSON, and no exact ID/pathing instructions. On invalid output or provider failure, retry once with a concise repair message; then return a typed provider error.

```ts
const model = new ChatGoogle({ apiKey, model: modelName });
const structured = model.withStructuredOutput(PlannerResponseSchema);
const response = await structured.invoke(messages);
return PlannerResponseSchema.parse(response);
```

- [x] **Step 6: Implement the Node HTTP endpoint and production host**

Expose `GET /api/health` and `POST /api/plan`, set JSON/no-store headers, enforce a 64 KiB body limit, and time out provider work after 7 seconds. In production, serve `dist/` with SPA fallback; in development, the Vite proxy targets port `8787`.

- [x] **Step 7: Run planner tests and a credential-free HTTP smoke check**

Run: `timeout 40 npm run test:run -- src/app/PlannerCoordinator.test.ts server/planner.test.ts`

Start one server process, record its PID, run `curl --max-time 3 http://127.0.0.1:8787/api/health`, then terminate that PID.

Expected: tests pass; health reports planner configuration without exposing secrets; no server remains.

### Task 8: Bounded Simulation Controller

**Files:**
- Create: `src/app/SimulationController.ts`, `src/app/SimulationController.test.ts`
- Modify: `src/app/PlannerCoordinator.ts`, `src/engine/engine.ts`

**Interfaces:**
- Produces: `SimulationController.start()`, `.stop()`, `.dispatch(command)`, `.setTool(tool)`, `.setBrushSize(radius)`, `.subscribeUi(listener)`, `.getUiSnapshot()`.

- [x] **Step 1: Write failing frame-loop tests**

With injected clock/frame functions, assert 99 ms advances zero ticks, 100 ms advances one, a 2,000 ms frame advances at most five and drops excess accumulation, stop cancels the frame and planner, hidden/resumed timing cannot spike work, and read-model publication is throttled to at most ten per second.

- [x] **Step 2: Run the focused test and verify failure**

Run: `timeout 30 npm run test:run -- src/app/SimulationController.test.ts`

Expected: FAIL because the controller is absent.

- [x] **Step 3: Implement the controller with dependency injection**

Inject `now`, `requestFrame`, `cancelFrame`, engine, and planner coordinator for tests. Keep `MAX_CATCH_UP_TICKS = 5`, reset the accumulator after the cap, and call `engine.tick(100)` only from the controller.

- [x] **Step 4: Run controller and planner tests**

Run: `timeout 40 npm run test:run -- src/app`

Expected: all application orchestration tests pass serially.

### Task 9: PixiJS Scene, Camera, and Player Interaction

**Files:**
- Create: `src/renderer/palette.ts`, `src/renderer/draw.ts`, `src/renderer/VillageRenderer.ts`, `src/renderer/interaction.ts`, `src/renderer/interaction.test.ts`
- Modify: `src/engine/types.ts`

**Interfaces:**
- Consumes: `WorldReadModel`, `UiReadModel`, and `(command: WorldCommand) => void`.
- Produces: `new VillageRenderer(host, callbacks)`, `.init()`, `.render(world, ui)`, `.screenToWorld(point)`, `.focus(point)`, `.destroy()`.

- [x] **Step 1: Write failing pure interaction tests**

Test pointer interpolation emits circles no farther apart than half the brush radius; camera scale clamps to `0.55..2.4`; zoom preserves the world point under the cursor; panning clamps the world so at least 15% remains visible; disaster tools emit one command on pointer release rather than per move.

- [x] **Step 2: Run interaction tests and verify failure**

Run: `timeout 30 npm run test:run -- src/renderer/interaction.test.ts`

Expected: FAIL because interaction helpers are absent.

- [x] **Step 3: Implement PixiJS 8 application and revision layers**

Construct `Application`, await `app.init({ resizeTo: host, antialias: true, autoDensity: true, background: palette.paper, powerPreference: "low-power" })`, append `app.canvas`, and create ordered containers for terrain, roads, structures, hazards, units, overlays, and preview. Rebuild static graphics only when the `(seed, corresponding revision)` cache key changes; update unit transforms only when `(seed, unitRevision)` changes. Add a reseed regression proving a new world's terrain and decor redraw even when its revision counters repeat the prior world's values.

- [x] **Step 4: Port the approved drawing language**

Use PixiJS 8 `Graphics` chaining (`rect/circle/poly/moveTo/lineTo`, then `fill` and `stroke`) for rounded land/shore runs, dirt paths, stone bridges, top-down wall segments, upright houses, monument, villagers, tree/stone decor, flat fire patches, curved tsunami fronts, bandits, pits, sickness rings, routes, and selection/placement feedback. Keep text outside the artwork.

- [x] **Step 5: Implement camera and pointer gesture lifecycle**

Set a full-world `Rectangle` hit area and `eventMode = "static"`. Use pointer capture semantics across `pointerdown`, `globalpointermove`, `pointerup`, and `pointerupoutside`; wheel zoom uses `{ passive: false }`; space/middle-button pans regardless of tool; paint commands interpolate; hover preview reports validity.

- [x] **Step 6: Run interaction tests and typecheck**

Run: `timeout 30 npm run test:run -- src/renderer/interaction.test.ts`

Run: `timeout 40 npm run typecheck`

Expected: tests and PixiJS types pass without deprecated v7 APIs.

### Task 10: React Product Shell and Accessible Controls

**Files:**
- Create: `src/main.tsx`, `src/App.tsx`, `src/ui/useSimulation.ts`, `src/ui/ToolRail.tsx`, `src/ui/WorldViewport.tsx`, `src/ui/StatusBar.tsx`, `src/ui/Timeline.tsx`, `src/ui/Inspector.tsx`, `src/ui/OnboardingHint.tsx`, `src/ui/icons.tsx`
- Create: `src/ui/ToolRail.test.tsx`, `src/ui/Timeline.test.tsx`, `src/ui/App.test.tsx`
- Create: `src/styles/reset.css`, `src/styles/tokens.css`, `src/styles/app.css`, `src/styles/controls.css`, `src/styles/timeline.css`

**Interfaces:**
- Consumes: one `SimulationController` and its immutable snapshots.
- Produces: responsive desktop/mobile product shell with fully labeled controls and no per-frame React state.

- [x] **Step 1: Write failing semantic UI tests**

Assert every tool is a named button with `aria-pressed`; shortcuts `1..8`, `I`, `H`, and space select tools/pause when focus is not in a form control; brush input has bounds `10..80`; reset requires a second click within four seconds; planner states and latest feedback are live regions; timeline details expand without losing summary text.

- [x] **Step 2: Run UI tests and verify failure**

Run: `timeout 40 npm run test:run -- src/ui`

Expected: FAIL because React UI modules are missing.

- [x] **Step 3: Implement the shell and controller subscriptions**

Create the controller once, start/stop it in an effect, use `useSyncExternalStore`, and compose header/status, tool rail, world viewport, timeline, and optional inspector. Do not copy entity arrays into component-local state.

- [x] **Step 4: Implement controls, timeline, and onboarding copy**

Group tools as `Terrain`, `Village`, and `Disasters`; show exact fixed defaults in tool hints; use compact icons plus visible labels; make timeline categories visually distinct; label AI, fallback, and deterministic outcome sources explicitly; show the first-run sequence “Paint → place the marker → trigger a disaster → inspect the chief’s plan.”

- [x] **Step 5: Implement responsive visual system**

Use `DESIGN.md` tokens, a parchment/chrome shell, a dense but readable 148 px desktop rail, flexible world center, 340 px timeline, and no gradients. At `max-width: 900px`, stack timeline below the map and make the rail horizontal; at `max-width: 620px`, retain 44 px touch targets, hide secondary hint prose, and keep canvas aspect ratio readable.

- [x] **Step 6: Run UI tests, full typecheck, and build**

Run: `timeout 50 npm run test:run -- src/ui`

Run: `timeout 40 npm run typecheck`

Run: `timeout 60 npm run build`

Expected: UI tests, typecheck, and production build pass.

### Task 11: Full Integration, Documentation, and Browser Verification

**Files:**
- Create: `README.md`
- Create: `artifacts/product-verification/final-evaluation.md`
- Create: `artifacts/product-verification/desktop.png`, `artifacts/product-verification/mobile.png`
- Modify as evidence requires: `src/**`, `server/**`, tests, styles, and this plan

**Interfaces:**
- Consumes: completed application, all docs, automated tests, and one local server/browser session.
- Produces: verified product behavior, visual evidence, setup documentation, and a requirement audit.

- [x] **Step 1: Run the fresh bounded automated suite**

Run: `timeout 90 npm run test:run`

Run: `timeout 45 npm run typecheck`

Run: `timeout 60 npm run build`

Run: `timeout 20 node --test mockup/village-generation.test.mjs`

Expected: every command exits `0`, no open-handle warning, and original 11 prototype tests still pass.

- [x] **Step 2: Start exactly one production server**

Run `npm start` in one PTY, capture the session/PID, verify `http://127.0.0.1:8787/api/health` with `curl --max-time 3`, and confirm the production HTML responds. Do not start Vite simultaneously.

- [x] **Step 3: Exercise the complete story in one browser session**

At desktop width: paint land and water, adjust brush size, place a totem, verify houses/villagers/roads/wall/bridge, trigger fire/tsunami/bandits/earthquake/plague, wait only for bounded visible state changes, inspect AI-or-fallback timeline entries and deterministic outcomes, pause/resume, pan/zoom, and reset/reseed. Check console errors after each disaster group.

Verified with the full live story; the browser driver could not synthesize a range-value change, so the brush's `10..80` update boundary is covered by the integrated UI tests instead.

- [x] **Step 4: Verify no-game-over and planner boundary behavior**

Use deterministic destructive triggers until the first village is depleted or use a test-only browser command exposed only under `?verify=1`; confirm editing remains enabled and a new totem can establish a village. Inspect the `/api/plan` request payload and confirm it contains no exact movement/path nodes; inspect the response and confirm no engine mutation occurs until validated intents are executed.

Verified through combined live and automated evidence: the browser reached zero villagers with editing and placement validation still active; valid replacement, compact request privacy, and pre-validation transaction boundaries pass the integrated engine/planner suites. The in-app driver did not expose raw request bodies and its post-depletion click landed on invalid shoreline terrain.

- [x] **Step 5: Capture and inspect desktop/mobile screenshots**

Save a 1440×1000 desktop screenshot and a 430×932 narrow screenshot. Confirm controls remain outside artwork, all key controls are reachable, map objects remain legible, timeline has readable hierarchy, no horizontal page overflow occurs, and no repeated high-impact weakness conflicts with `DESIGN.md` or the final mockup references.

- [x] **Step 6: Monitor cleanup and CPU safety**

If navigation or screenshots stall, inspect the exact browser/server PID CPU before retrying. Stop the known production server, confirm no duplicate Village Brain server or Vitest watcher remains, and record process cleanup in the evaluation.

- [x] **Step 7: Write setup and final evidence**

Document Node requirements, `npm install`, `npm run dev` plus `npm run dev:server`, `npm run build && npm start`, server-only environment variables, controls/shortcuts, deterministic seed behavior, planner fallback semantics, architecture boundary, and test commands. In `final-evaluation.md`, audit every completion criterion with command output, browser observations, screenshot paths, remaining low-impact limits, and CPU/process evidence.

- [x] **Step 8: Self-review and mark plan completion**

Search for unchecked steps, compare the final product against every section of the design spec and `AI_SIMULATION_PROMPT.md`, fix any genuine gap, rerun the smallest relevant bounded check, then mark only verified work complete.

---

**Task 1 checkpoint (2026-08-15):** installed `@langchain/core@1.2.8`, `@langchain/google@0.2.2`, `@pixi/react@8.0.5`, `pixi.js@8.19.0`, `react@19.2.8`, `react-dom@19.2.8`, `zod@4.4.3`, `@types/node@24.13.3`, `@types/react@19.2.18`, `@types/react-dom@19.2.4`, `@vitejs/plugin-react@5.2.0`, `tsx@4.23.12`, `typescript@5.9.3`, `vite@8.2.1`, and `vitest@4.1.10`; focused planner-contract test and typecheck pass.

## Plan Self-Review

- **Spec coverage:** Tasks 1–8 cover contracts, deterministic engine, generation, hazards, intent execution, fallback, Gemini, debouncing, and CPU bounds. Tasks 9–10 cover Pixi rendering, tools, camera, React shell, transparency, responsiveness, and accessibility. Task 11 covers full-loop, no-game-over, docs, visual, process, and product verification.
- **Placeholder scan:** The plan contains no deferred implementation placeholders. Each behavior has an exact module, interface, bound, and verification command.
- **Type consistency:** `PlannerRequest`/`PlannerResponse` originate only in `src/shared/planner-contract.ts`; `VillageEngine` is the sole canonical-state owner; `SimulationController` is the sole engine loop owner; `WorldReadModel` is the renderer/UI boundary; all planner outputs enter through `executePlan`.
- **Repository constraint:** Git commits are intentionally omitted because `/Users/edisoncai/Documents/GitHub/village-brain` has no `.git` metadata.
