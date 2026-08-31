# Earthquake Rescue Priority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure villagers never route through active earthquake pits, rescue work takes precedence over deterministic repairs, and the final rescue clears the earthquake hazard immediately so recovery can resume.

**Architecture:** Keep earthquake state in `disasters.ts`, expose pit avoidance as an optional navigation constraint, and make task assignment/processing recognize active earthquake rescue as a higher-priority phase than rebuilding. Existing pit rescue semantics already remove each emptied pit and resolve the event when no trapped villagers remain; tests will lock that behavior down alongside the new scheduling rules.

**Tech Stack:** TypeScript, Vitest, deterministic fixed-step simulation engine.

**Spec:** `AI_SIMULATION_PROMPT.md` earthquake behavior and `docs/superpowers/specs/2026-08-15-village-brain-product-design.md` deterministic task boundary.

## Global Constraints

- Preserve deterministic ordering and fixed 100 ms simulation steps.
- Keep exact villager selection, paths, and outcomes inside `src/engine/`.
- Do not change unrelated working-tree files.
- Follow red-green-refactor: each production change must be preceded by a failing regression test.

---

### Task 1: Make navigation avoid earthquake pits

**Files:**
- Modify: `src/engine/navigation.ts`
- Modify: `src/engine/tasks.ts`
- Test: `src/engine/navigation.test.ts`
- Test: `src/engine/tasks.test.ts`

**Interfaces:**
- `findPath` accepts an optional list of circular blocked areas while preserving existing callers.
- `boundedPath` supplies active earthquake pits only for rescue routes.

- [x] **Step 1: Write the failing tests**

Add a navigation regression that creates a flat land world with a circular blocked area crossing the straight route and asserts the returned path does not contain a waypoint inside that area. Add a task regression with a rescuer approaching a trapped villager from the far side of the pit and assert the assigned rescue path does not enter the pit.

- [x] **Step 2: Run the focused tests and verify they fail**

Run: `npm run test:run -- src/engine/navigation.test.ts src/engine/tasks.test.ts`

Expected: the new assertions fail because `findPath` and rescue routing currently ignore pit geometry.

- [x] **Step 3: Implement the minimal routing constraint**

Add an optional `blockedAreas` argument to `findPath`; reject traversing cell centers inside a blocked circle, while allowing the caller’s valid start/destination cells. Thread the active earthquake pit circles through rescue-task `boundedPath` calls and its emergency-gate retry path.

- [x] **Step 4: Run the focused tests and verify they pass**

Run: `npm run test:run -- src/engine/navigation.test.ts src/engine/tasks.test.ts`

Expected: all navigation and task tests pass, including the new pit-avoidance regressions.

### Task 2: Give active earthquake rescue priority over repairs

**Files:**
- Modify: `src/engine/tasks.ts`
- Test: `src/engine/tasks.test.ts`

**Interfaces:**
- Recovery assignment is skipped while an earthquake event is active.
- Active rebuild tasks are deferred/abandoned when an earthquake becomes active, allowing rescue work to take precedence and recovery to be reassigned afterward.

- [x] **Step 1: Write the failing tests**

Add a test showing that an active earthquake with a trapped villager does not receive a deterministic `rebuild_structure` assignment for an idle worker. Add a test with a pre-existing active rebuild task, then activate an earthquake, and assert the rebuild task no longer remains active while the rescue task remains executable.

- [x] **Step 2: Run the focused tests and verify they fail**

Run: `npm run test:run -- src/engine/tasks.test.ts`

Expected: the new assertions fail because recovery currently assigns/continues repair work during an active earthquake.

- [x] **Step 3: Implement the minimal priority gate**

Add a helper for active earthquake detection. Return no recovery assignments while it is active, and finish existing rebuild tasks as deferred before normal task execution. Keep the event and pit lifecycle unchanged.

- [x] **Step 4: Run the focused tests and verify they pass**

Run: `npm run test:run -- src/engine/tasks.test.ts`

Expected: all task tests pass and repair work resumes after the earthquake resolves.

### Task 3: Verify immediate final-rescue cleanup and the full engine

**Files:**
- Test: `src/engine/tasks.test.ts`
- Test: `src/engine/engine.test.ts` if an engine-level ordering regression is required.

**Interfaces:**
- Final pit rescue leaves no event-owned pits, marks the earthquake resolved, and permits recovery assignment on the next fixed step.

- [x] **Step 1: Add the final-rescue regression assertion**

Extend the focused rescue scenario to assert that the final rescue removes the emptied pit and resolves the earthquake with zero severity/trapped villagers before recovery begins.

- [x] **Step 2: Run the focused test and verify it passes**

Run: `npm run test:run -- src/engine/tasks.test.ts`

Expected: the final-rescue lifecycle remains green with the new scheduling rules.

- [x] **Step 3: Run the complete verification suite**

Run: `npm run test:run && npm run typecheck && npm run build`

Expected: all Vitest tests, TypeScript checks, and the production build exit successfully.

- [x] **Step 4: Review the diff for scope**

Run: `git diff -- src/engine/navigation.ts src/engine/tasks.ts src/engine/navigation.test.ts src/engine/tasks.test.ts docs/superpowers/plans/2026-08-31-earthquake-rescue-priority.md`

Confirm only pit routing, earthquake-vs-repair priority, and their tests/plan changed.
