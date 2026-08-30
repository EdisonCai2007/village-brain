# Organic Village Generation Design

## Goal

Replace the fixed village arrangement in the local canvas mockup with a deterministic, seeded generator whose roads grow with the settlement, whose houses face and connect to those roads, whose bridges exist only at narrow river crossings, and whose wall follows the occupied core. Preserve the current flat painted art direction and keep the implementation dependency-free.

## Scope

This work changes village layout generation and the small amount of rendering needed to consume generated geometry. It does not build the larger React, PixiJS, planner, disaster, or terrain-painting product described in `PRODUCT.md` and `AI_SIMULATION_PROMPT.md`. The current island and river remain the terrain context so the work can focus on village-generation quality.

The demo accepts `?seed=<integer>` and produces the same layout for the same seed. Seed variation changes growth decisions, not colors or asset styling.

## Chosen Approach: Street-First Organic Growth

The generator starts at a village center below the existing river. It grows a connected road tree in short, directionally persistent segments. Each new house is placed from a road frontage after that road exists. This makes connectivity structural rather than something repaired after random scattering.

Growth uses a deterministic pseudo-random number generator only to choose among bounded, meaningful options: left or right frontage, modest road curvature, branch timing, and house spacing. The rules establish the shape; the seed selects among valid growth decisions. Independent random coordinates are not used.

An entrance road grows from the village center toward the north edge. It crosses the fixed narrow river once, producing a useful connection and a single derived bridge. Residential branches grow from the core without entering the river.

## Geometry Model

`generateVillage(seed)` returns a plain-data `VillageLayout` containing:

- `seed`: normalized unsigned integer.
- `center`: village monument position.
- `roads`: connected polylines with stable IDs, a role (`entrance`, `spine`, or `branch`), and a parent-road relationship.
- `houses`: position, facing angle, frontage point, and owning road ID.
- `bridges`: the road ID, crossing point, angle, and length derived from road/river intersection geometry.
- `wall`: ordered wall segments plus explicit gate intervals at road crossings.
- `trees` and `stones`: deterministic decoration placed outside roads, structures, and the wall core.

The generator does not call canvas APIs. `village-scene.js` remains responsible for drawing the terrain and assets from this layout.

## Generation Rules

### Roads and Houses

1. Create a main residential spine through the center with a gentle seeded bend.
2. Create a northbound entrance road attached to the center. Its heading persists toward the northern island edge rather than taking unconstrained random turns.
3. Grow two or three residential branches from occupied spine nodes. A branch inherits its parent heading and turns within a bounded range.
4. Place houses along completed road segments at controlled frontage distances, alternating sides when space allows.
5. Reject a house if its footprint overlaps another house, the monument, a road, the river, or the shoreline margin. Try the next frontage position instead of scattering it elsewhere.
6. Stop a branch when it reaches its house capacity or cannot place a valid next segment. Remove any final segment that serves neither a house nor an entrance/exit role.

Every road attaches to an earlier road or the center. Every house records the road and frontage point that caused it to be placed.

### Bridges

The river is represented by a sampled centerline and width matching the rendered curve. A road needs a bridge only when a segment enters one river bank and exits the other across water no wider than the supported bridge limit.

For each qualifying road crossing, create exactly one bridge centered on the crossing and aligned with the road. Do not create bridge geometry for roads that stay on land, touch only the bank, run along the water, or attempt to cross broad unsupported water.

### Wall and Gates

The wall is generated after the houses. It follows a low-resolution envelope around the core houses and monument with a consistent safety margin, then smooths abrupt radial changes. This makes the settlement determine the wall rather than drawing an arbitrary ring first.

Only the contiguous core below the river is enclosed. When a connected road crosses the envelope, the wall is split into a gate centered on the crossing. Wall segments must not pass through houses, the monument, the river band, or a road outside a declared gate.

## Seed and Demo Behavior

The browser reads an integer `seed` query parameter, defaulting to `1`. Invalid values also fall back to `1`. The selected seed is available through a small text label outside the artwork and may be changed with previous, next, and regenerate controls. Regenerate advances to a different integer seed rather than adding nondeterministic entropy, so every shown layout remains reproducible.

## Automated Evaluation

The geometry evaluator reports invariant violations and useful metrics for a layout. Tests cover these requirements across a fixed seed corpus (`1`, `2`, `7`, `19`, `42`, `99`, `314`, and `2026`):

- Same seed produces deeply equal geometry; at least two different seeds produce different geometry.
- Every house has a valid owning road and its frontage point lies on that road.
- Every road is connected through parent roads to the center.
- Non-entrance leaf roads serve at least one house.
- Every river-crossing road has exactly one bridge and every bridge belongs to a true supported crossing.
- All core houses and the monument lie inside the wall envelope.
- Wall segments avoid houses and river water.
- Every road/wall intersection falls inside an explicit gate.
- House footprints do not overlap one another.

Tests use Node's built-in test runner and real generation code. No mocks or new package dependencies are needed.

## Visual Evaluation Checklist

Each visual iteration captures at least four reproducible seeds at the same viewport and scores them against this checklist:

### Roads connect to houses

- Each house visibly faces a nearby road.
- Road branches end near served houses rather than in empty land.
- The network reads as one connected settlement, not separate strokes.

### Bridges only where needed

- A bridge covers each road's actual water span.
- No bridge sits wholly on land or extends far beyond the banks.
- No residential branch accidentally crosses water.

### Walls make sense

- The wall encloses the dense village core with useful clearance.
- Gates align with roads, and roads do not visually run through closed wall segments.
- The wall avoids houses, the monument, and the river.
- The wall shape responds to the occupied footprint rather than remaining identical across seeds.

### Layout feels organic

- Roads show gentle directional persistence and limited branching, without a rigid grid.
- Houses have varied but controlled spacing and orientation.
- Seed variation changes recognizable growth decisions without producing noisy scatter.
- The scene remains legible at the existing desktop and mobile canvas sizes.

A failed structural item triggers another implementation iteration. A repeated visual weakness across multiple seeds triggers the next highest-impact simple rule change. The loop stops when all structural checks pass and no repeated high-impact visual issue remains.

## CPU Safety

All automated test and screenshot commands use bounded shell timeouts. If a command fails to return normally or the demo becomes unresponsive, inspect the process CPU percentage immediately. Terminate the process if it sustains unexpectedly high CPU rather than repeatedly waiting or launching duplicates. Run the dependency-free test corpus serially; do not use watch mode or parallel browser sessions.

## Error Handling

- Normalize non-integer or missing seeds to `1`.
- Return evaluator violations instead of throwing for aesthetic-quality failures.
- Throw only for programmer-contract errors such as malformed terrain geometry.
- If a requested branch cannot place valid geometry within its bounded attempts, stop that branch cleanly and continue the rest of the village.

## Non-Goals

- General-purpose procedural terrain generation.
- Large bridges across ocean-scale water.
- Pathfinding or moving villagers.
- Gradual in-simulation construction.
- A stochastic simulation whose layout cannot be reproduced.
- Heavy optimization, spatial indexing, or external geometry libraries.
