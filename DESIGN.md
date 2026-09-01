---
name: Village Brain
description: Flat cartoony top-down village world on a brown desk
colors:
  paper: "#f5f1df"
  paper-deep: "#e8dec2"
  paper-light: "#fffdf2"
  desk: "#74543a"
  desk-deep: "#4d3424"
  desk-warm: "#936c48"
  desk-highlight: "rgba(255, 236, 196, 0.08)"
  water: "#79afba"
  water-deep: "#5d9daa"
  tsunami: "rgba(94, 158, 181, 0.78)"
  tsunami-crest: "#d7f2ef"
  shore: "#d3c287"
  grass: "#8aaa6c"
  dirt: "#c89a68"
  bridge: "#a9a596"
  fire: "#cf493d"
  ember: "#f0a044"
  house: "#d7a15f"
  roof: "#a95b49"
  villager: "#9b6b4b"
  villager-head: "#d6a174"
  tree: "#6f9b5e"
  wall: "#6f513b"
  wall-highlight: "#9b714d"
  monument: "#8f6446"
  monument-base: "#7b573f"
  monument-inset: "#d9b86f"
  chrome: "#493d31"
  chrome-deep: "#30271f"
  toolkit: "rgba(77, 52, 36, 0.9)"
  toolkit-raised: "rgba(93, 66, 46, 0.94)"
  toolkit-ink: "#f8eed8"
  toolkit-active-ink: "#3b291d"
  toolkit-hover: "rgba(255, 244, 219, 0.13)"
  toolkit-separator: "rgba(248, 238, 216, 0.22)"
  toolkit-shadow: "rgba(36, 22, 13, 0.35)"
  toolkit-active-shadow: "rgba(24, 14, 8, 0.32)"
  tooltip-bg: "rgba(42, 27, 18, 0.96)"
  tooltip-shadow: "rgba(31, 18, 10, 0.32)"
  ink: "#382f25"
  ink-soft: "#6c5c4b"
  outline: "rgba(71, 57, 42, 0.72)"
  outline-soft: "rgba(71, 57, 42, 0.42)"
  shadow: "rgba(42, 26, 16, 0.28)"
  map-shadow: "rgba(39, 23, 14, 0.34)"
  map-inset-highlight: "rgba(255, 255, 255, 0.38)"
  focus: "#1b6575"
  danger: "#9f352d"
  danger-soft: "#f2b0a7"
  success: "#4f7242"
rounded:
  map-frame: "8px"
  icon-corner: "7px"
  terrain-corner: "organic"
components:
  game-scene:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.map-frame}"
    shadow: "0 18px 42px {colors.shadow}"
---

# Design System: Village Brain

## Overview

**Creative North Star: "Village World On A Desk"**

The sandbox is a clean 2D top-down game scene floating over a brown work desk. The player should read the world instantly: rounded terrain, front-facing houses, villagers, walls, trees, a central monument, and flat disaster states. The surrounding controls feel like a compact brown toolkit for shaping terrain and bringing disasters to the world, while empty space around the panned or zoomed world shows the desk instead of a white frame.

## Visual Rules

- Use a flat map with large, rounded, paintable terrain shapes.
- Draw interactive world objects as simple front-facing icons, never as isometric objects.
- Houses are square building bodies with triangular pitched roofs and no visible side walls.
- Villagers are small head-and-torso silhouettes with rounded shapes.
- Walls are top-down connected dark line segments with rounded ends and a subtle center highlight. They should read as long continuous boundaries, not front-facing palisade posts.
- Repeated objects of the same type use the same fill colors. Do not introduce random roof, path, wall, villager, tree, or house color variants unless they represent a real game state.
- Trees, stones, and the central monument stay icon-like, rounded, and recognizable at small sizes.
- The village center marker is a simple pillar or obelisk-like monument with opaque flat fills. It should read as a calm central marker, not a house, tower, totem pole, statue, or highly detailed cultural artifact.
- Fire is a rounded red spreading ground patch with subtle ember grain.
- Tsunami is a long curved moving wave front, not a blob patch. It uses a flat blue band with a light crest line and can include a faint trailing wash.
- Texture is nearly absent except minimal fiery grain inside fire patches.

## Color

The palette is natural and moderately colorful. Grass, water, path dirt, wood, roof, wall, villager, and fire colors should remain calm and readable, avoiding heavy saturation and soft pastel styling. The app shell uses warm desk browns and translucent dark-brown toolkit surfaces so the world remains the clear stage. Each repeated element type owns a single base color token. Outlines use dark brown-gray alpha strokes rather than black. Shadows use faint soft ellipses under icons and deeper desk shadows only around the toolkit.

## Layout

The interactive app uses a full-viewport transparent canvas over the desk. The floating toolbar sits over the desk and should stay compact, with icon-first controls and delayed custom tooltips. There are no visible labels or debug overlays inside the game scene; controls live in the toolkit layer.

The application keeps the world artwork full-viewport. The tool rail, notification board, and tutorial are HTML surfaces layered around the Pixi canvas, leaving the scene itself free of interface text.

## Shape And Depth

Terrain uses smooth organic blobs. Icon assets use circles, rounded rectangles, and simple triangles. Depth is limited to slight terrain overlap, outlines, and faint contact shadows; no perspective rendering, raised flames, smoke columns, 3D walls, or realistic lighting.

## Do's And Don'ts

### Do
- Keep every object legible at mobile scale.
- Maintain consistent icon scale across houses, villagers, walls, trees, and the central monument.
- Keep fire visually part of the ground plane, and keep tsunami as a flat moving front rather than a raised wave icon.

### Don't
- Don't add text or interface elements inside the world artwork.
- Don't use isometric angle, visible building side walls, or realistic perspective.
- Don't rely on texture, glow, atmospheric haze, or heavy shadows for polish.
