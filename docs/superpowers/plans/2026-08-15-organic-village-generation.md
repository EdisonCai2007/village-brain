# Organic Village Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed village arrangement with a deterministic street-first generator and verify road, bridge, wall, and organic-layout quality across multiple seeds.

**Architecture:** A dependency-free ES module generates plain geometry from a seed and exposes an evaluator. The existing canvas renderer imports that geometry, draws it with the current asset functions, and reads the active seed from the URL. Node's built-in test runner verifies geometry; a bounded local server plus one browser session provides multi-seed visual evidence.

**Tech Stack:** Browser Canvas 2D, JavaScript ES modules, Node.js built-in `node:test`, local Node HTTP server, agent-browser.

## Global Constraints

- Preserve the current flat painted art direction.
- Keep the implementation dependency-free.
- The current island and river remain the terrain context.
- Growth rules establish the shape; the seed only selects among valid bounded decisions.
- All test and screenshot commands must use bounded timeouts and serial execution.
- If a command hangs or the demo becomes unresponsive, inspect CPU use and terminate unexpectedly high-CPU processes before retrying.

---

### Task 1: Deterministic Road-Growth Core

**Files:**
- Create: `mockup/village-generation.mjs`
- Create: `mockup/village-generation.test.mjs`

**Interfaces:**
- Consumes: integer-like seed values.
- Produces: `generateVillage(seed)` returning `{ seed, center, roads, houses, bridges, wall, trees, stones }`; `pointToSegmentDistance(point, a, b)` for geometry checks.

- [x] **Step 1: Write failing determinism and connectivity tests**

Create tests using `node:test` and `node:assert/strict` that assert `generateVillage(42)` equals a second call with `42`, differs from seed `43`, every road's `parentId` resolves back to the center, every house has a valid `roadId`, and each house frontage has distance below `0.001` from one segment of that road.

- [x] **Step 2: Run the focused test with CPU safeguards**

Run: `timeout 20 node --test mockup/village-generation.test.mjs`

Expected: FAIL because `mockup/village-generation.mjs` does not exist.

If `timeout` is unavailable, use a foreground run and inspect it within 20 seconds; on abnormal behavior run `ps -Ao pid,pcpu,comm | sort -k2 -nr | head` and terminate only the identified test process if its CPU is unexpectedly high.

- [x] **Step 3: Implement the minimal seeded street-first generator**

Implement a small integer PRNG, vector helpers, a connected center spine, a northbound entrance, bounded-curvature residential branches, and frontage-driven house placement. Store parent-road IDs and exact frontage points. Keep all attempts bounded by constants and return plain serializable objects.

- [x] **Step 4: Re-run the focused test**

Run: `timeout 20 node --test mockup/village-generation.test.mjs`

Expected: PASS with zero failures and no warnings.

- [x] **Step 5: Record the checkpoint**

Git is unavailable in this workspace. Record completion by checking the task boxes in this plan and preserve a focused filesystem diff for final review.

### Task 2: Derived Bridges and Settlement-Shaped Wall

**Files:**
- Modify: `mockup/village-generation.mjs`
- Modify: `mockup/village-generation.test.mjs`

**Interfaces:**
- Consumes: connected road geometry and the exported fixed river descriptor.
- Produces: `classifyRoadCrossings(layout)`, derived `layout.bridges`, derived `layout.wall`, and `evaluateVillage(layout)` returning `{ violations, metrics }`.

- [x] **Step 1: Write failing crossing and enclosure tests**

Across seeds `1`, `2`, `7`, `19`, `42`, `99`, `314`, and `2026`, assert that every supported bank-to-bank road crossing has exactly one bridge, every bridge maps to a crossing, core houses and the monument are inside the wall polygon, wall segments avoid house footprints and river water, and every road/wall intersection is covered by a declared gate.

- [x] **Step 2: Verify the new tests fail for missing derived geometry**

Run: `timeout 20 node --test --test-name-pattern='bridge|wall|gate' mockup/village-generation.test.mjs`

Expected: FAIL because bridge and wall derivation is absent or incomplete.

- [x] **Step 3: Implement crossings, walls, gates, and evaluation**

Sample the existing river Bezier into a centerline band. Detect only road segments whose endpoints lie on opposite sides of the narrow band, create one aligned bridge per crossing, and ignore tangencies. Build an eight-to-twelve point radial envelope from the occupied core plus clearance, smooth adjacent radii, find road-envelope crossings, and split the rendered wall around explicit gate intervals. Implement evaluator violations from independent geometric predicates.

- [x] **Step 4: Re-run bridge and wall tests, then the full corpus**

Run: `timeout 20 node --test --test-name-pattern='bridge|wall|gate' mockup/village-generation.test.mjs`

Expected: focused tests PASS.

Run: `timeout 20 node --test mockup/village-generation.test.mjs`

Expected: all tests PASS with zero failures and no warnings.

- [x] **Step 5: Record the checkpoint**

Check the task boxes and inspect `git diff --no-index /dev/null mockup/village-generation.mjs` only if a textual patch view is needed; do not initialize a repository solely for this task.

### Task 3: Render Generated Seeds in the Demo

**Files:**
- Modify: `mockup/village-scene.js`
- Modify: `mockup/index.html`
- Modify: `mockup/styles.css`

**Interfaces:**
- Consumes: `generateVillage(seed)` and `evaluateVillage(layout)` from `mockup/village-generation.mjs`.
- Produces: canvas rendering for generated roads, bridges, wall segments, houses, monument, villagers, and collision-aware decoration; URL-driven seed controls outside the artwork.

- [x] **Step 1: Write a failing browser-contract test**

Add a Node test that imports a small exported `normalizeSeed(value)` helper and asserts missing, nonnumeric, and fractional inputs normalize to `1`, while `"42"` normalizes to `42`. This catches invalid URL seed handling without testing browser framework behavior.

- [x] **Step 2: Verify the URL-seed contract fails**

Run: `timeout 20 node --test --test-name-pattern='seed input' mockup/village-generation.test.mjs`

Expected: FAIL because `normalizeSeed` is not implemented.

- [x] **Step 3: Integrate generated geometry**

Switch the scene script to an ES module, parse `?seed=`, generate once per seed, and replace hard-coded village roads, bridge, wall, houses, and village decoration with layout-driven drawing. Add compact previous/next controls and a seed label below the canvas without placing UI inside the artwork.

- [x] **Step 4: Verify tests and syntax**

Run: `timeout 20 node --test mockup/village-generation.test.mjs`

Expected: all tests PASS.

Run: `timeout 20 node --check mockup/village-scene.js && timeout 20 node --check mockup/village-generation.mjs`

Expected: both syntax checks exit `0`.

- [x] **Step 5: Record the checkpoint**

Check the task boxes and preserve the updated files for visual iteration.

### Task 4: Iterative Multi-Seed Visual Evaluation

**Files:**
- Create: `artifacts/village-generation/iteration-1/seed-1.png`
- Create: `artifacts/village-generation/iteration-1/seed-7.png`
- Create: `artifacts/village-generation/iteration-1/seed-42.png`
- Create: `artifacts/village-generation/iteration-1/seed-314.png`
- Create: `artifacts/village-generation/iteration-1/evaluation.md`
- Modify as needed: `mockup/village-generation.mjs`, `mockup/village-generation.test.mjs`, `mockup/village-scene.js`

**Interfaces:**
- Consumes: URL-addressable deterministic seeds and the design checklist.
- Produces: four comparable screenshots and an evidence-based pass/fail evaluation for every checklist category.

- [x] **Step 1: Start one bounded local demo process**

Run `node mockup/server.mjs` in a PTY, capture its session ID, and verify it reports `http://127.0.0.1:5173/`. Do not start duplicates. If startup or requests stall, inspect the exact server PID's CPU before deciding whether to terminate it.

- [x] **Step 2: Verify the page before evaluating layouts**

Use agent-browser to open `http://127.0.0.1:5173/?seed=1`, wait for network idle, check for a nonblank body and framework error overlays, inspect the interactive snapshot, and capture the first screenshot.

- [x] **Step 3: Capture a fixed seed set serially**

In the same browser session, navigate to seeds `7`, `42`, and `314`, waiting for the canvas to render before each screenshot. Save all four screenshots under `artifacts/village-generation/iteration-1/`.

- [x] **Step 4: Score the checklist from screenshots and metrics**

Write `evaluation.md` with one row per seed and explicit findings for roads, bridges, walls, and organic layout. Record common failures separately from isolated aesthetic preferences. Treat any structural invariant failure as a required next iteration.

- [x] **Step 5: Apply the next highest-impact simple improvement if needed**

For the most frequent or severe observed weakness, add one failing regression test when the weakness is geometric, implement the smallest growth-rule change, create `iteration-2/` screenshots for the same seeds, and repeat evaluation. Do not bundle unrelated aesthetic tweaks.

- [x] **Step 6: Stop cleanly**

Close agent-browser and terminate the known local server session. Confirm no duplicate demo or test processes remain.

### Task 5: Completion Audit

**Files:**
- Modify: `artifacts/village-generation/final-evaluation.md`
- Modify: `docs/superpowers/plans/2026-08-15-organic-village-generation.md`

**Interfaces:**
- Consumes: final code, tests, evaluator output, screenshots, and every explicit objective requirement.
- Produces: a final requirement-by-requirement evidence record.

- [x] **Step 1: Run fresh full verification**

Run: `timeout 20 node --test mockup/village-generation.test.mjs`

Run: `timeout 20 node --check mockup/village-scene.js && timeout 20 node --check mockup/village-generation.mjs && timeout 20 node --check mockup/server.mjs`

Expected: every command exits `0`, with zero test failures.

- [x] **Step 2: Re-run the evaluator across the full seed corpus**

Use a bounded Node command to generate seeds `1`, `2`, `7`, `19`, `42`, `99`, `314`, and `2026`, print each violation count, and require every count to be zero.

- [x] **Step 3: Audit visual requirements**

Inspect the final four screenshots and confirm each line of the design checklist with direct evidence. If a repeated high-impact weakness remains, return to Task 4 instead of claiming completion.

- [x] **Step 4: Write final evidence**

Summarize test output, seed corpus metrics, screenshot paths, iterations performed, remaining low-impact limitations, and CPU/process cleanup in `artifacts/village-generation/final-evaluation.md`.

- [x] **Step 5: Mark checked work in this plan**

Update all completed checkboxes and leave any genuinely unmet item unchecked. Because this directory has no Git metadata, report that commits were unavailable rather than creating a repository.

### Task 6: Independent Review Remediation

**Files:**
- Modify: `mockup/village-generation.mjs`
- Modify: `mockup/village-generation.test.mjs`
- Modify: `artifacts/village-generation/final-evaluation.md`

**Interfaces:**
- Consumes: independent reviewer findings about same-bank crossings, evaluator mutation gaps, and low topology diversity.
- Produces: signed-bank crossing classification, mutation-resistant evaluation, and recognizable seed-driven topology choices.

- [x] **Step 1: Add failing same-bank, evaluator-mutation, and topology-diversity tests**

- [x] **Step 2: Require crossings to enter and exit opposite signed river banks**

- [x] **Step 3: Validate exact bridge geometry, explicit gates, parent chains, frontage, and collisions**

- [x] **Step 4: Vary bounded branch sites and branch count through seeded frontier choices**

- [x] **Step 5: Re-run full tests, corpus metrics, and final visual screenshots**

- [x] **Step 6: Obtain final read-only review and update completion evidence**
