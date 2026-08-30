# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is a builder evaluating and shaping a 2D AI-responsive village sandbox. They need to see, edit, and reason about a simulated world where terrain, disasters, villagers, and planner decisions are visible at once.

## Product Purpose

Village Brain is an interactive sandbox where the player paints terrain, places a village totem, triggers disasters, and watches an AI village chief respond through high-level plans. Success means the player can understand what is happening in the world and why the AI chief chose a response.

## Positioning

The product is not a traditional city builder. Its distinct mechanism is the separation between an LLM planner that chooses strategic intents and a deterministic engine that executes exact movement, selection, safety scoring, and disaster resolution.

## Operating Context

The user paints land and water, places a village totem, triggers fire, tsunami, bandits, earthquake, or plague events, and inspects an AI timeline. The simulation should feel like a live canvas rather than a campaign or survival challenge.

## Capabilities and Constraints

The simulation uses React and TypeScript with Vite for UI, PixiJS for 2D rendering, a deterministic simulation loop outside React, and a small backend planner endpoint. The LLM provider is intended to start with Gemini through LangChain, hidden behind a provider adapter. The planner must return validated JSON intents and never own pathfinding or exact villager movement.

Open implementation details include deterministic seed behavior, terrain edit constraints, backend shape, exact Gemini model, and whether disaster defaults become visible controls.

Terrain semantics should stay simple for the player: land and water are the first paintable terrain types. River-like water and bridge crossings are derived by the deterministic engine from painted water width and path intersections rather than exposed as separate terrain brushes.

## Brand Commitments

The working visual direction for the first mockup is a cinematic top-down simulation map: legible like a tool, but composed like a live strategy-board snapshot.

## Evidence on Hand

Source planning file: `AI_SIMULATION_PROMPT.md`.

## Product Principles

- Keep the world readable before making it decorative.
- Make AI reasoning visible through timeline entries and planner status.
- Keep the player in a sandbox mindset: no hard game-over, no campaign framing.
- Preserve the planner-engine boundary in both UI labels and visual hierarchy.
- Show consequences clearly without turning the experience into a punishing survival game.
