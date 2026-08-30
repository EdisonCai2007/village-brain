# Element Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a static element library to the Village Brain mockup so each simulation object can be reviewed and tuned individually.

**Architecture:** Keep the existing one-page mockup. Add a second canvas for the library and reuse the current canvas drawing primitives by switching the active canvas context during render.

**Tech Stack:** Static HTML, CSS, and browser Canvas 2D.

## Global Constraints

- The element library remains static and local.
- No external image assets or dependencies.
- Use the same visual language as the current cinematic map mockup.
- Include terrain, structures, villagers, threats, disaster states, and planner overlays from `AI_SIMULATION_PROMPT.md`.

---

### Task 1: Add Library Surface

**Files:**
- Modify: `mockup/index.html`
- Modify: `mockup/styles.css`
- Modify: `mockup/village-scene.js`

**Interfaces:**
- Consumes: existing `#village-scene` canvas.
- Produces: new `#element-library` canvas rendered by `drawElementLibrary(width, height)`.

- [x] **Step 1: Add a library section below the board**

Add a section with a short heading, category summary, and `<canvas id="element-library">`.

- [x] **Step 2: Add responsive styling**

Style the library as a full-width parchment-backed review surface with a fixed minimum canvas height and responsive resizing.

- [x] **Step 3: Render all specimens**

Draw the following categories: terrain, village, villagers, disasters, and planner overlays.

- [x] **Step 4: Verify**

Run JavaScript syntax checking, the design detector, and an HTTP response check against the local mockup.
