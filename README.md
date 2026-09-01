# Village Brain

Village Brain is a local, interactive village sandbox. Paint land and water, place a village marker, trigger five deterministic disasters, and watch a strategic AI chief propose high-level responses while the simulation engine owns every exact selection, route, movement, and outcome.

## Requirements

- Node.js 24
- npm
- A browser with WebGL support
- Optional: a Gemini API key for AI-authored plans

## Install

```sh
npm install
```

Planner credentials are optional. If you use Gemini, set the variables only in the server process; Vite does not need or receive them:

```sh
export GOOGLE_API_KEY="your-key"
export GEMINI_MODEL="gemini-3.5-flash-lite" # optional default
export PORT=8787                         # optional default
export AI_SESSION_LOG_DIR="logs/ai-sessions" # optional default
```

Do not expose the key through a `VITE_` variable. `.env.example` lists the server configuration, and the Node server loads `.env` automatically while still letting shell environment variables take precedence.

Each server process writes verbose AI session logs to `logs/ai-sessions/` by default. Set `AI_SESSION_LOG_DIR` to redirect them. The logs are JSONL files containing planner snapshots, Gemini-bound messages, recorded Google request/response payloads when exposed by LangChain, raw model messages, parsed and normalized plans, token usage metadata, and classified failure details. API keys and token-like credential fields are redacted.

## Development

Run the planner/API server and Vite client in separate terminals:

```sh
npm run dev:server
```

```sh
npm run dev
```

Vite proxies `/api` requests to `http://127.0.0.1:8787`.

## Production

Build the client and start the single server that serves both `dist/` and the planner API:

```sh
npm run build && npm start
```

Open `http://127.0.0.1:8787`. Health status is available at `http://127.0.0.1:8787/api/health`; it reports whether the planner is configured without exposing credentials.
The current `start` script runs the TypeScript server through `tsx`, so a deployment that uses `npm start` must install devDependencies (or compile `server/index.ts` as part of its release process).

## Controls

| Action | Pointer / keyboard |
| --- | --- |
| Paint land | Choose **Land** or press `1`, then drag on the map |
| Paint water | Choose **Water** or press `2`, then drag on the map |
| Place or replace village | Choose **Totem** or press `3`, then click valid land |
| Trigger fire | Choose **Fire** or press `4`, then click land |
| Trigger tsunami | Choose **Tsunami** or press `5`, then click water |
| Trigger bandits | Choose **Bandits** or press `6`, then click land |
| Trigger earthquake | Choose **Earthquake** or press `7`, then click land |
| Trigger plague | Choose **Plague** or press `8`, then click near living villagers |
| Pan | Choose **Pan** or press `H`; Space-drag or middle-drag also pans |
| Zoom | Mouse wheel over the map |
| Pause / resume | Pause control or `Space` when focus is not in a form control |
| Reset | Select **Reset world**, then confirm with a second click within four seconds |

The brush slider is available for terrain tools and ranges from 10 to 80 world units.

## Determinism and planner fallback

The world uses a seeded PRNG and a 100 ms fixed simulation step. The same seed plus the same ordered commands reproduces the same terrain and deterministic outcomes. Reset rebuilds the current seed and clears planner work; the sandbox has no hard game-over, so terrain editing and village replacement remain available after destructive events.

Planner events are batched after a one-second quiet window with at most one request in flight. The browser posts a compact, validated snapshot to `/api/plan`; it contains high-level event and population facts, never exact villager IDs, destinations, or path nodes. Valid Gemini output supplies strategic intents only. Zod validation gates every response before the engine executes it.

When Gemini is unconfigured, unavailable, times out, or returns invalid data, the same engine execution boundary receives one deterministic emergency fallback plan. Timeline entries label AI plans, fallback policy, and deterministic outcomes separately, so credential-free behavior stays visible rather than masquerading as AI output.

## Architecture boundary

- `src/engine/` owns canonical world state, seeded randomness, terrain and village generation, navigation, disasters, exact villager tasks, and deterministic intent execution.
- `src/app/` owns the bounded animation loop, planner-event batching, browser API client, reset cancellation, and immutable UI publication.
- `src/renderer/` draws immutable world read models with PixiJS and emits typed player commands; it owns no simulation state.
- `src/ui/` and `src/App.tsx` own React controls, status, accessibility, timeline, and responsive layout without running the simulation loop in React.
- `server/` owns the server-only Gemini/LangChain adapter, request/response limits, schema validation, and production static hosting.
- `src/shared/planner-contract.ts` is the sole browser/server planner contract.

The critical rule is one-way: the planner chooses strategy; the deterministic engine chooses exact entities, destinations, paths, movement, damage, and resolution.

## Verification

```sh
npm run test:run
npm run typecheck
npm run build
```

The final browser and process audit is recorded in `artifacts/product-verification/final-evaluation.md`.
