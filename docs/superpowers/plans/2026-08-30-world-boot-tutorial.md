# World Boot Tutorial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing direct-to-sandbox startup into a complete, persistent nine-step World Boot tutorial that teaches the live terrain, village, bandit, and chief-notification loop without replacing the real controls.

**Architecture:** Keep tutorial progression in a small pure state-machine module driven by the existing `SimulationSnapshot`; React owns only the current step and local persistence. Render a fixed instructional overlay with a DOM-measured spotlight and connector, while leaving the actual tool rail, Pixi canvas, and floating notification board mounted and interactive beneath it. Make ocean-only startup an explicit `VillageEngine` mode so the browser experience changes without weakening the generated-world engine fixtures and deterministic tests.

**Tech Stack:** React 19, TypeScript, Vite, PixiJS 8, Vitest, browser-client/agent-browser for live verification.

**Spec:** `docs/superpowers/specs/2026-08-30-world-boot-tutorial-design.md`

## Global Constraints

- Startup browser world is ocean-only; no landmass, village, or generated decor exists before the player acts.
- Tutorial is an overlay on the live sandbox, not a route, landing page, or replacement canvas.
- Active spotlight preserves the original target while the rest of the viewport is dimmed.
- Actual controls remain the interaction surface for tool selection and map actions.
- Action-gated steps cannot advance until the corresponding real world fact exists.
- Tutorial completion is remembered locally; skip and finish both return to normal sandbox play.
- Replay is available after completion and starts the tutorial from Welcome without resetting the world.
- Keyboard users can reach the target control/canvas, use Escape to skip, and retain visible focus.
- Browser validation must exercise the full flow and inspect screenshots; deterministic tests alone are insufficient.
- Keep simulation work bounded and run test/build commands serially with one worker.

---

### Task 1: Model ocean-only startup and tutorial facts

**Files:**
- Modify: `src/engine/terrain.ts`
- Modify: `src/engine/engine.ts`
- Modify: `src/main.tsx`
- Create: `src/ui/tutorial.ts`
- Test: `src/engine/terrain.test.ts`
- Test: `src/engine/engine.test.ts`
- Test: `src/ui/tutorial.test.ts`

**Interfaces:**
- `createWorld(seed, terrainMode?)` accepts `"generated" | "ocean"`, defaulting to the existing generated mode for engine tests and tools.
- `VillageEngineOptions.initialWorld?: "generated" | "ocean"` selects the mode used by construction and reset.
- `TutorialStepId`, `TutorialFacts`, `TUTORIAL_STEPS`, `tutorialStepCanAdvance`, and `nextTutorialStep` are exported from `src/ui/tutorial.ts`.

- [ ] **Step 1: Write the failing engine and state-machine tests.**

```ts
it("creates a water-only world when ocean mode is requested", () => {
  const world = createWorld(1, "ocean");
  expect(world.terrain.every((cell) => cell === TERRAIN_WATER)).toBe(true);
  expect(world.activeVillage).toBeNull();
  expect(world.trees).toEqual([]);
});

it("keeps reset in the engine's configured ocean mode", () => {
  const engine = new VillageEngine({ seed: 1, initialWorld: "ocean" });
  engine.dispatch({ type: "paint", terrain: "land", point: { x: 640, y: 430 }, radius: 28 });
  engine.reset(2);
  expect(engine.getSnapshot().terrain.every((cell) => cell === TERRAIN_WATER)).toBe(true);
});

it("advances only when the real action for a tutorial step is complete", () => {
  expect(nextTutorialStep("land-brush", { activeTool: "pan", hasLand: false, hasVillage: false, hasBanditEvent: false })).toBe("land-brush");
  expect(nextTutorialStep("land-brush", { activeTool: "land", hasLand: false, hasVillage: false, hasBanditEvent: false })).toBe("draw-island");
  expect(tutorialStepCanAdvance("draw-island", { activeTool: "land", hasLand: false, hasVillage: false, hasBanditEvent: false })).toBe(false);
});
```

- [ ] **Step 2: Run the focused tests and verify they fail for the missing mode/state machine.**

Run: `npm test -- --run src/engine/terrain.test.ts src/engine/engine.test.ts src/ui/tutorial.test.ts --no-file-parallelism --maxWorkers=1`

Expected: FAIL because ocean mode and tutorial exports do not exist.

- [ ] **Step 3: Implement the minimal ocean mode.**

Keep `createDefaultTerrain`, river classification, and tree placement unchanged for generated mode. In ocean mode leave the initialized terrain and river arrays as zeros and skip tree placement. Store `initialWorld` on `VillageEngine` and pass it to `createWorld` in both the constructor and `reset`. Change only `src/main.tsx` to construct `new VillageEngine({ seed: 1, initialWorld: "ocean" })`.

- [ ] **Step 4: Implement the pure nine-step tutorial model.**

Use these exact IDs and order:

```ts
export type TutorialStepId =
  | "welcome" | "land-brush" | "draw-island" | "totem-brush"
  | "place-village" | "bandit-brush" | "place-bandits"
  | "watch-chief" | "try-tools";
```

Each step contains a title, concise description, `target` (`"world" | "land" | "totem" | "bandits" | "notifications" | "toolbar"`), and action kind. `welcome`, `watch-chief`, and `try-tools` advance on Next; selection steps advance when `activeTool` matches; map steps advance only when `hasLand`, `hasVillage`, or `hasBanditEvent` is true. `nextTutorialStep` must return the same step when its action is incomplete and `null` after `try-tools`.

- [ ] **Step 5: Run the focused tests and verify they pass.**

Run: `npm test -- --run src/engine/terrain.test.ts src/engine/engine.test.ts src/ui/tutorial.test.ts --no-file-parallelism --maxWorkers=1`

Expected: PASS, with the pre-existing generated-world assertions still green.

---

### Task 2: Build the tutorial overlay and connect real UI targets

**Files:**
- Create: `src/ui/WorldBootTutorial.tsx`
- Modify: `src/App.tsx`
- Modify: `src/ui/ToolRail.tsx`
- Modify: `src/ui/WorldViewport.tsx`
- Modify: `src/ui/DecisionNotifications.tsx`
- Modify: `src/ui/App.test.tsx`
- Create: `src/ui/WorldBootTutorial.test.tsx`
- Modify: `src/styles/app.css`
- Modify: `src/styles/controls.css`
- Modify: `src/styles/decision-notifications.css`

**Interfaces:**
- `WorldBootTutorial` receives `step`, `canAdvance`, `onNext`, and `onSkip`, and renders the instructional dialog/spotlight.
- `ToolRail` accepts optional `onReplayTutorial?: () => void` and exposes `data-tutorial-target="toolbar"` plus per-tool target attributes.
- `WorldViewport` exposes `data-tutorial-target="world"` and a keyboard-focusable map host.
- `DecisionNotifications` exposes `data-tutorial-target="notifications"`.

- [ ] **Step 1: Write failing semantic UI tests.**

```tsx
it("renders the current step with an action-gated Next button", () => {
  const markup = renderToStaticMarkup(
    <WorldBootTutorial step="draw-island" canAdvance={false} onNext={() => undefined} onSkip={() => undefined} />,
  );
  expect(markup).toContain("Draw an island");
  expect(markup).toContain('aria-label="World Boot tutorial"');
  expect(markup).toContain('data-tutorial-action="next"');
  expect(markup).toContain('disabled=""');
  expect(markup).toContain("Skip tutorial");
});

it("marks the actual controls and notification board as spotlight targets", () => {
  const markup = renderToStaticMarkup(<App controller={createDisconnectedController()} />);
  expect(markup).toContain('data-tutorial-target="toolbar"');
  expect(markup).toContain('data-tutorial-target="land"');
  expect(markup).toContain('data-tutorial-target="totem"');
  expect(markup).toContain('data-tutorial-target="bandits"');
  expect(markup).toContain('data-tutorial-target="notifications"');
});
```

- [ ] **Step 2: Run the focused UI tests and verify the new assertions fail.**

Run: `npm test -- --run src/ui/WorldBootTutorial.test.tsx src/ui/App.test.tsx --no-file-parallelism --maxWorkers=1`

Expected: FAIL because the overlay, target attributes, and mounted notification board are missing.

- [ ] **Step 3: Implement target attributes and retain the existing chief notification board.**

Add the target attributes to the actual rail, tool buttons, world frame/host, and `DecisionNotifications` aside. Keep the existing floating notification board as the tutorial’s chief target; do not add a second full-height timeline panel. Add an unobtrusive `Replay tutorial` button to the rail settings or workspace chrome and keep it outside the Pixi artwork.

- [ ] **Step 4: Implement the overlay’s geometry and interaction behavior.**

`WorldBootTutorial` must:

1. Render a fixed, full-viewport instructional layer with `pointer-events: none` so underlying real controls remain usable.
2. Render a `pointer-events: auto` dialog containing the step title, description, Next/Finish button, and Skip button.
3. Measure `[data-tutorial-target="..."]` with `getBoundingClientRect()` on mount, step changes, resize, and visual viewport resize.
4. Use a derived centered inset rectangle for the world target rather than spotlighting the entire viewport.
5. Dim with a box-shadow cutout, outline the target, and draw a connector line from target edge toward the dialog.
6. Place the dialog beside the target when space permits and below it otherwise, clamped to the viewport.
7. Focus the heading on informational steps and focus the actual button/map/notification target on action steps; add Escape-to-skip and respect `prefers-reduced-motion` in CSS.
8. Mark the layer as a dialog with labelled/described content, keep Next disabled when `canAdvance` is false, and label the current progress for assistive technology.

- [ ] **Step 5: Connect App progression, persistence, and replay.**

Initialize the tutorial in a browser only when `localStorage` does not contain `village-brain.world-boot.completed=true`; keep SSR/static markup safe. Derive facts from the real snapshot (`terrain` contains land, `activeVillage !== null`, and an event with `type === "bandits"`). Auto-advance selection steps when the controller’s real `activeTool` changes. Gate map-step Next buttons with the pure model. On Skip or Finish write the completion flag and remove the overlay. Replay clears the flag and starts at `welcome` without resetting the world.

- [ ] **Step 6: Style the overlay and avoid desktop/mobile collisions.**

Use existing brown/cream tokens, no gradients, and a high-contrast paper tutorial card. Keep the rail and floating notifications above the world but below the tutorial overlay. On narrow screens clamp the card to viewport width and keep action buttons at least 44px high. Add only tutorial-specific CSS to the existing style files.

- [ ] **Step 7: Run the focused UI tests and typecheck.**

Run: `npm test -- --run src/ui/WorldBootTutorial.test.tsx src/ui/App.test.tsx src/ui/ToolRail.test.tsx src/ui/DecisionNotifications.test.tsx --no-file-parallelism --maxWorkers=1`

Run: `npm run typecheck`

Expected: PASS with no TypeScript errors.

---

### Task 3: Verify the complete product, then iterate from browser evidence

**Files:**
- Modify: any tutorial/engine/UI files identified by the browser evidence
- Create: `artifacts/product-verification/world-boot-desktop.png`
- Create: `artifacts/product-verification/world-boot-mobile.png`
- Create: `artifacts/product-verification/world-boot-evaluation.md`

**Interfaces:**
- Uses the built Vite app at `http://localhost:5173` and the browser’s real DOM/canvas interactions.
- Uses the same visible flow as the user: Next → select Land → paint → select Totem → place → select Bandits → place → Next → Finish.

- [ ] **Step 1: Run the full serial test suite and production build.**

Run: `npm run test:run`

Run: `npm run build`

Expected: both commands exit 0. If either fails, investigate the first root cause, add a regression test, make one fix, and rerun the smallest failing command before continuing.

- [ ] **Step 2: Start one low-impact dev server and verify CPU/process state.**

Run: `npm run dev -- --host 127.0.0.1`

Use the browser verification skill immediately after the server starts: open the page, wait for network idle, inspect the interactive snapshot, check for an error overlay and console errors, and capture a screenshot. Keep only one server process and terminate it after verification.

- [ ] **Step 3: Exercise the entire tutorial in the real browser.**

Verify each visible title/description and target alignment. Click the real Land, Totem, and Bandits buttons; paint a clearly visible island in the central map; place the totem on the island; place bandits on valid land; verify the village/event/notification DOM state changes; then finish. Confirm Skip and replay independently, and confirm local completion prevents the overlay on reload.

- [ ] **Step 4: Capture desktop and mobile evidence.**

Save a desktop screenshot with the map target and one with the toolbar/notification target, plus a narrow screenshot showing the card remains inside the viewport. Inspect the images rather than relying on DOM assertions. Record any overlap, misplaced spotlight, clipped copy, console error, or invalid action state in `world-boot-evaluation.md`.

- [ ] **Step 5: Fix each observed issue with a failing regression test first.**

For every issue found, reproduce it in a focused test or browser assertion, verify the failure, make the smallest root-cause fix, rerun the focused check, and repeat the browser screenshot check. Do not accept a test-only result when the issue is visual or interaction-based.

- [ ] **Step 6: Re-run the full audit before completion.**

Run `npm run test:run`, `npm run typecheck`, and `npm run build` fresh. Reopen the browser, replay the complete tutorial once, inspect final desktop/mobile screenshots, confirm no orphaned dev server remains, and check CPU/process state. Compare the evidence line by line with every numbered step and boundary in `docs/superpowers/specs/2026-08-30-world-boot-tutorial-design.md`.
