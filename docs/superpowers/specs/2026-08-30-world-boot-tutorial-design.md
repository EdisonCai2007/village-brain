# World Boot Tutorial Design Notes

## Purpose

Capture the planned changes to the way Village Brain starts, teaches the player, and introduces the live world before implementation begins.

This document is intentionally a planning brief, not an implementation plan. The implementation plan should be created after the tutorial flow is specified.

## Current Context

Village Brain now boots into an ocean-only live sandbox and presents the implemented World Boot tutorial overlay from `src/ui/WorldBootTutorial.tsx`. The compact onboarding hint below records the pre-implementation state that this work replaced:

> Shape the story: Paint -> place the marker -> trigger a disaster -> inspect the chief's plan.

The product direction still favors a live canvas over a campaign, landing page, or modal-heavy walkthrough. Any startup tutorial should teach the player how to shape the world while preserving the feeling that the simulation is already alive.

## Working Goal

Change the startup sequence so the first experience teaches the user how to interact with the world before they are expected to freely play.

The tutorial should explain the essential loop:

- Paint land and water.
- Place the village marker.
- Trigger or observe a disaster.
- Inspect the chief's plan in the floating notification board.
- Continue shaping the simulation after the tutorial ends.

The tutorial is an overlay on top of the existing interface, not a separate route or landing page.

## Design Boundaries

- This is not a marketing landing page.
- The tutorial should belong to the product experience, not sit outside it.
- The world should remain the primary visual focus.
- Tutorial UI should sit above the current UI as an instructional layer.
- Tutorial UI can highlight either controls or map regions, but it should not permanently add labels inside the artwork canvas.
- The player should be able to skip or complete the tutorial without losing access to the sandbox.
- The planner-engine boundary should remain clear: the chief explains strategy, while deterministic systems perform exact movement and outcomes.

## Startup World

The world should boot as ocean only. There should be no starting landmass and no generated village before the player acts.

The first land appears because the player selects the land brush and paints an island. The village appears only after the player selects the village marker/totem tool and places it on land.

## Overlay Model

The tutorial should use a full-screen dimming overlay above the current user interface.

- The dimming layer should read as a semi-transparent gray-black sheet covering the whole viewport.
- The active tutorial target should remain visible in original color through a spotlight/cutout area.
- The spotlight may be rectangular or square, sized to the highlighted control or map region.
- The spotlight should have a visible outline so the user knows exactly what area is being referenced.
- A simple text box should attach to the spotlight with a connector line.
- The text box should contain a short title, a short description, a `Next` button, and a `Skip` button.
- The spotlight should move between UI controls and map areas as the tutorial progresses.
- The overlay should not replace the real controls. The user should still interact with the actual tool rail and map where the step requires it.

## Tutorial Flow

1. **Welcome**
   - Target: no specific control, or the central map area.
   - Copy direction: "Welcome to Village Brain."
   - Action: user clicks `Next`.

2. **Land brush selection**
   - Target: land brush button in the tool rail.
   - Copy direction: explain that the land brush paints land into the ocean world.
   - Action: user selects the land brush.
   - Progression: continue after the real land brush tool is selected, or after `Next` if manual advancement remains enabled.

3. **Draw an island**
   - Target: the map/canvas area.
   - Copy direction: ask the user to draw an island or blob of any size and shape.
   - Action: user paints land on the water-only map.
   - Progression: user clicks `Next` after drawing, with implementation allowed to enable `Next` only after land exists.

4. **Village totem selection**
   - Target: village totem or marker button in the tool rail.
   - Copy direction: explain that the totem places the village starting point.
   - Action: user selects the totem tool.
   - Progression: continue after the real totem tool is selected, or after `Next` if manual advancement remains enabled.

5. **Place the village**
   - Target: the painted island/map area.
   - Copy direction: ask the user to place the village totem on the island.
   - Action: user clicks a valid land location.
   - Result: the village is generated around the totem.
   - Progression: continue after the village exists.

6. **Bandit tool selection**
   - Target: bandit tool button in the tool rail.
   - Copy direction: explain that bandits create a threat for the village to respond to.
   - Action: user selects the bandit tool.
   - Progression: continue after the real bandit tool is selected, or after `Next` if manual advancement remains enabled.

7. **Place bandits**
   - Target: the map/canvas area near or outside the village.
   - Copy direction: ask the user to place bandits in the world.
   - Action: user clicks a valid location for bandits.
   - Result: a bandit event is created.
   - Progression: continue after the bandit event exists.

8. **Watch Village Brain work**
   - Target: floating chief notification board.
   - Copy direction: tell the user to watch Village Brain plan and respond.
   - Action: user clicks `Next`.

9. **Try the rest of the tools**
   - Target: the entire toolbar.
   - Copy direction: explain that there are different tools available, invite the user to try them out, and close with a simple "have fun" tone.
   - Action: user clicks finish.
   - Result: tutorial ends and normal sandbox play continues.

## Additional Tutorial Targets

The initial flow should prioritize the essential first-play path. Later steps can teach secondary controls:

- Water brush: paint water back into land.
- Pause/resume: stop or continue simulation time.
- Brush size: change terrain painting radius.
- Notification inspection: read why the chief chose a plan.
- Reset: return to a new ocean-only start.

## Questions To Resolve

- Should the tutorial appear every time, only on first launch, or when explicitly restarted?
- Should tutorial completion be remembered locally?
- What should happen if the player edits terrain or triggers disasters out of the suggested order?
- Should the chief/timeline participate in the tutorial as a narrator, or should tutorial copy stay separate from planner output?
- Should `Next` always be available, or should action-based steps require the real action before advancing?

## Implementation Planning Notes

Once the desired flow is specified, create an implementation plan under `docs/superpowers/plans/` that covers:

- Ocean-only startup state and tutorial persistence.
- Tutorial step model and progression rules.
- Full-screen dimming overlay, spotlight/cutout positioning, outline, connector line, and text box placement.
- Single-control, map-area, notification-board, and entire-toolbar spotlight targets.
- UI surfaces, highlights, keyboard behavior, focus management, and accessibility behavior.
- Integration with existing controls, world commands, and notifications.
- Tests for first-run behavior, step progression, skip/finish behavior, and non-regression of normal sandbox startup.
