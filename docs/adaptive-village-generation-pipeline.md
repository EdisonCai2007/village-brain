# Adaptive Village Generation Pipeline Plan

## Purpose

The current village generator is too template-dependent. It succeeds only when the terrain happens to fit the generator's preferred construction shape. That is the wrong model for Village Brain because the user can draw arbitrary islands, rivers, shorelines, lakes, water pockets, and land shapes.

This plan defines a reproducible generation-and-AI-review pipeline. The pipeline should repeatedly generate varied terrain, attempt village placement, render every result through the existing app/mockup, and use AI visual review to drive code changes that make the village adapt to the environment.

The goal is not to add more one-off cases. The goal is to evolve the generator into a terrain-first construction system.

## Core Rule

The generator adapts to the terrain. The terrain is never modified, restricted, or massaged to fit the generator.

Any fix that only adds a narrow condition for one direction, one river shape, one bridge side, one anchor location, or one isolated failure should be treated as evidence that the approach is wrong. Fixes should improve the general construction model.

> **Very important: almost all code created for terrain-corpus generation, placement sampling, snapshot capture, AI evaluation, regression replay, and training/reporting is temporary development infrastructure. It must remain isolated and easy to delete. The adaptive village-generation improvements are the product; the pipeline that helps produce them is not.**

The final product does not generate training terrain. It receives terrain drawn by the user and runs the improved village generator against that terrain. Temporary pipeline code must never become a required part of the game runtime.

## Temporary Training Infrastructure Boundary

Keep the pipeline behind a strict one-way dependency boundary:

- temporary pipeline code may import and exercise the production village generator;
- production engine, renderer, UI, and shared types must not import pipeline code;
- do not add pipeline-only fields, modes, flags, or branches to `WorldState`, `VillageState`, `generateVillage`, or the normal application flow;
- do not bundle generated terrain corpora, snapshots, AI prompts, review records, or reporting tools with the final application;
- keep pipeline scripts, fixtures, captures, configuration, and pipeline-only dependencies together in an obviously temporary development-only location;
- prefer adapters in the temporary harness over changing production interfaces solely to make the pipeline easier to run;
- village-generator improvements discovered through the pipeline must stand on their own after the pipeline is removed.

The removal test is simple: deleting the temporary pipeline directory, its generated artifacts, and its dedicated commands or development dependencies must leave the application build and normal user-drawn-terrain workflow intact. Avoid scattering cleanup work across the codebase.

## Pipeline Overview

1. Generate the fixed terrain corpus once from deterministic seeds and parameters.
2. Select requested placement points from that corpus, including valid and invalid points.
3. Attempt to build a village at each exact requested point.
4. Render every result in the existing HTML/app visualization and capture a review snapshot.
5. Have the AI evaluator accept the layout or explain the visible problem.
6. Modify the generator code to address the general failure class.
7. Re-run the same terrain seed, parameters, and requested point.
8. Add the fixed failure to the development regression corpus for the lifetime of this improvement phase.
9. Repeat with other deterministic cases from the fixed terrain corpus.

Terrain generation and replay are deterministic so cases can be reproduced. Village-quality evaluation is exclusively visual and AI-based. The pipeline must not use `evaluateVillage` or any other deterministic post-generation validator as a pass/fail authority.

## What The Pipeline Should Generate

The terrain generator should create a broad, fixed distribution of maps, not just variations of the current default island.

It should cover:

- different island sizes;
- large single islands;
- small but valid islands;
- multiple land masses;
- thin peninsulas;
- narrow land bridges;
- noisy shorelines;
- interior lakes;
- water pockets near plausible anchors;
- rivers crossing land horizontally, vertically, diagonally, and irregularly;
- wide water that should not be bridgeable;
- narrow water that may be bridgeable from any direction;
- terrain with no bridge requirement;
- terrain visually sized for roughly six houses;
- terrain where a six-house village appears visually difficult to place.

Do not rely on a noise map alone. Build the terrain generator once from a combination of deterministic scenario patterns and seeded variation. Scenario patterns should deliberately create the shapes above; noise, blobs, shoreline perturbations, and carved channels can then add variation within each pattern. The terrain generator is frozen while village generation is being improved. Only change it if an actual terrain-generation bug is found, and version or regenerate the corpus deliberately in that case.

## Placement Sampling

For each terrain seed, the script should test many requested points rather than one ideal point.

Sampling should include:

- random land cells;
- land points near shoreline;
- land points deep inside land regions;
- points near rivers or lakes;
- points on narrow terrain;
- points on larger open areas;
- points near connected-region edges;
- points in every sufficiently large connected land region.

The requested point is the exact placement request and the village totem. Resolve it to the terrain cell under the cursor for cell lookup; do not search adjacent cells for a replacement anchor or silently relocate the village. If that cell is not on land, placement is invalid because the totem must be on land. The totem itself does not require road access.

Use the exact totem position as a soft layout reference rather than a fixed-radius constraint: prefer the village centre and house lots near it. If the only feasible settlement would clearly be too distant to read as belonging to that totem, reject the placement instead of silently building elsewhere. Define “too distant” as a map-relative quality rule or layout score, not as one rigid universal radius.

## AI Review Criteria

A generated village is accepted only when the AI evaluator reviews its rendered HTML/app snapshot and judges that it looks coherent and usable. These are visual review criteria, not deterministic geometry assertions.

The current village contract remains aligned with the application data model:

- at least six houses;
- exactly two villagers per house;
- a complete wall with visible gates;
- one active village anchored at the exact requested land point.

The AI evaluator should reject or flag a snapshot when it visibly appears that:

- a house, villager, anchor, road, or wall is incorrectly placed in water;
- houses overlap, collide with unrelated roads, or have no readable frontage;
- a house cannot visually be reached from the anchor through the road network;
- roads are disconnected, meet only approximately, or terminate without serving anything;
- a road crosses water without a believable bridge;
- a bridge does not visibly connect opposite banks or does not match the water span;
- the wall crosses water, blocks a road outside a gate, or fails to enclose the village coherently;
- fewer than six houses or fewer than two villagers per house are visible;
- the village is implausibly far from the requested totem;
- the layout is technically rendered but visually confusing, cramped, or unreadable.

Roads may be shorter, curved, rerouted, or sparse, and bridges may be absent when no crossing is needed. The wall remains required under the current contract, but its shape should adapt to the occupied terrain.

## AI Review Labels

The AI evaluator should label visible problems so repeated patterns become obvious. These labels are review outputs, not deterministic conclusions.

Suggested labels:

- `generation_error`: the attempt did not produce a reviewable app state or snapshot;
- `placement_rejected`: the app visibly rejected the exact requested anchor;
- `ai_accepted_layout`: the rendered village looks coherent and usable;
- `ai_rejected_layout`: the rendered village has one or more visible quality problems;
- `house_on_water`: a house landed on water;
- `villager_on_water`: a villager landed on water;
- `road_unbridged_water`: a road crossed water without a valid bridge;
- `bad_bridge`: bridge does not match a real crossing;
- `same_bank_bridge`: bridge does not connect opposite banks;
- `wall_invalid`: wall intersects water, closes roads, or has invalid gates;
- `not_enough_visible_lots`: the snapshot does not show six believable, reachable house lots;
- `suspected_over_rejection`: the app rejected placement even though the AI sees a plausible six-house arrangement.

`suspected_over_rejection` is deliberately an AI diagnosis, not a claim that feasibility has been proven.

## AI Visual Evaluation and Debugging

Use the existing HTML/app visualization instead of inventing a separate debug viewer. Every attempted placement must produce a captured app snapshot for AI review, including visibly rejected placements. The AI evaluator is the only village-quality validator in this pipeline.

For each failure worth investigating, the pipeline should make it easy to open the terrain and attempted placement in the current browser experience or mockup. The debug view should show:

- terrain seed;
- exact requested placement point;
- generated roads, houses, bridges, villagers, and wall when available;
- the app's placement feedback;
- highlighted areas that the AI previously identified as suspicious, when available.

The rendered snapshot is the evaluator's source of truth. It may also receive the terrain seed, parameters, exact requested point, and app feedback as context, but it must not receive or defer to deterministic validation results. It should answer:

- did a village generate;
- if not, does the rejection look reasonable or overly rigid;
- if it generated, does the village look coherent, reachable, connected, and readable;
- what visible construction decision caused the problem;
- what general generator capability should be improved.

The evaluator should use a small, versioned visual-review prompt. Save the snapshot, model/prompt version, verdict, confidence, labels, and explanation with the repro record so the judgment can be reviewed later. Do not build a deterministic feasibility solver or geometry validator alongside it.

## Regression Corpus

Every meaningful generator failure should become a retained regression case while this improvement pipeline is active. The corpus is temporary development data and should be removed with the pipeline after the adaptive generator is mature.

Each corpus entry should include:

- terrain seed;
- terrain generation parameters;
- placement point;
- expected visible improvement after the fix;
- original AI review labels;
- short explanation of the general bug it revealed.

The corpus should run before new terrain cases. Keep the original terrain and placement data intact; do not shrink or alter a failure merely to make it smaller. A fix is not accepted if it fixes a new failure but regresses an older corpus case.

Use the corpus to review a small number of deliberate improvement rounds, not to optimize endlessly against the same seeds. Stop when the AI verdicts and representative cases look healthy; the goal is confidence across terrain types, not overfitting to a test suite.

## Fix Quality Bar

A generator change is acceptable only if it improves a general capability.

Good fixes:

- derive house lots from valid terrain;
- route roads through land using pathfinding or terrain cost fields;
- discover bridge crossings independently from road template orientation;
- scale the village based on available land, but preserve the six-house contract;
- make walls terrain-aware while keeping them present under the current contract;
- reject placement when the exact requested anchor is not valid;
- improve the rendered debug state so the AI can explain bad layouts clearly.

Bad fixes:

- add another hardcoded bridge direction;
- add one more road rotation to cover a failing seed;
- special-case a specific shoreline shape;
- move or repaint terrain to make the village fit;
- weaken the AI review prompt to excuse visibly invalid construction;
- increase attempt counts without changing the construction model;
- add parameters that only expand the current template's lucky cases.

If a proposed fix feels like "handle this specific seed," stop and redesign the underlying step.

## Likely Generator Direction

The long-term generator should be terrain-first.

A likely direction:

1. Analyze the exact totem's land component and its nearby approved bridge candidates.
2. Compute buildability scores such as distance from water, local open area, and connectivity.
3. Select at least six promising house lots from terrain rather than from fixed road frontage.
4. Connect lots with terrain-aware paths.
5. Derive roads from those paths.
6. Roads remain on land within the settlement-accessible region. When a selected approved narrow river span is needed, replace that span with a bridge aligned to the road and add its opposite bank to the accessible region. Roads must never cross lakes, broad water, or unapproved water spans.
7. Attempt a village only when six lots and their connecting roads can be constructed by the generator.
8. Generate a complete terrain-aware wall with gates that follow the occupied settlement.
9. Render the result in the app and let the AI evaluator make the only quality verdict from the snapshot.

This does not need to be implemented all at once. The pipeline should reveal which step is the biggest blocker.

## Initial Implementation Scope

The first implementation pass should not rewrite the generator.

Implement this pass as removable development tooling, not as a new runtime subsystem. Give the temporary harness a clear ownership boundary and keep its entry points out of the production application graph.

It should add:

- deterministic random terrain generation for tests/scripts;
- placement sampling over generated terrain;
- repeated calls to `generateVillage`;
- removal of `evaluateVillage` as a pipeline or runtime quality gate, along with tests that treat it as the authority;
- automatic HTML/app snapshot capture for every attempt;
- AI verdicts and review labels;
- saved repro records;
- a way to open or reproduce failures in the existing HTML/app visualization.

The first pass must also preserve placement transactionality. This game supports exactly one active village. A failed placement must leave the existing village, villagers, bridge cells, and simulation time unchanged. A successful placement intentionally replaces the previous village and all associated village state atomically. Do not add multi-village support or test village-to-village overlap.

After that, generator changes should be driven by actual failures from the pipeline.

## Success Metrics

Track reporting signals across both the regression corpus and the remaining deterministic cases in the fixed terrain corpus. These summarize AI reviews; they are not deterministic feasibility or geometry metrics:

- number of terrain seeds tested;
- number of placement points tested;
- number of reviewable snapshots produced;
- AI acceptance rate by terrain category;
- AI review-label frequency;
- count of `suspected_over_rejection` reviews;
- average AI confidence, grouped by accepted and rejected verdicts;
- regression corpus AI acceptance rate using the versioned review prompt.

The main signal is whether the AI sees fewer visibly broken layouts and fewer overly rigid placement rejections across varied terrain. Do not report `false_impossible`, `true_impossible`, or any equivalent deterministic feasibility conclusion.

## Explicit Non-Goals

- Do not create a separate agent for deterministic terrain generation.
- Do not build a separate visualization unless the existing app/mockup cannot show a needed failure.
- Do not optimize for beautiful random terrain in the first pass.
- Do not add gameplay features while building the pipeline.
- Do not treat more rotations, more attempts, or more direction cases as a real solution.
- Do not turn corpus terrain generation, AI review, snapshot capture, regression replay, or reporting into final-product features.
- Do not make the production application depend on temporary pipeline files, artifacts, services, or dependencies.

## Handoff Summary

Build the reproducible, removable development pipeline first. Let it generate terrain, sample placements, run the generator, capture the existing visual app/mockup, and use AI review as the sole quality evaluation. Then use those visual diagnoses to make the production village generator terrain-first. Keep the resulting generator improvements and remove the training pipeline when this improvement phase is complete.

The guiding question for every code change is:

Does this make village construction adapt to arbitrary user-drawn terrain, or does it merely make the current template fit one more case?
