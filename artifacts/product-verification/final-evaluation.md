# Village Brain — Final Product Evaluation

Date: 2026-08-15

## Automated verification

The fresh integrated chain completed with exit code 0 after the final application, production-start, and responsive-control changes. GNU `timeout` is unavailable in this macOS shell, so the naturally bounded commands were run serially in the foreground; none approached its planned limit.

| Check | Result | Evidence |
| --- | --- | --- |
| Full Vitest suite | Pass | 18 files, 225 tests, 0 failures, 6.97 s |
| TypeScript | Pass | `tsc -b --pretty false`, exit 0 |
| Production build | Pass | Vite 8.2.1, 829 modules, exit 0; `dist/index.html` and production assets emitted |
| Original generator regression | Pass | 11 passed, 0 failed, 675.67 ms |

## Production server and full story

- Started exactly one `npm start` PTY. The production listener was Node PID 33651 on `127.0.0.1:8787`.
- `GET /api/health` returned HTTP 200 with `{"ok":true,"planner":{"configured":false,"model":"gemini-2.5-flash-lite"}}`.
- `GET /` returned HTTP 200, `text/html`, `cache-control: no-store`, and the built `dist/index.html`. The `start` script now explicitly selects production static serving.
- The standalone `agent-browser` binary was not installed, so the supported Codex in-app browser was used for one named session. It opened `/?verify=1`, loaded one canvas, produced an interactive DOM snapshot, showed no blank/error overlay, and logged no console errors or warnings.
- Live interactions painted land and water, established a seed-1 village with 8 houses and 16 villagers, and visibly rendered roads, a wall, the river crossing/bridge, the marker, villagers, and structures.
- Fire, tsunami, bandits, earthquake, and plague were triggered. Timeline evidence recorded `event-1` through `event-5`; the earthquake pulse resolved deterministically and the tsunami/plague later resolved.
- Pause changed the control to `Resume` and resume restored it. Pan and wheel zoom both changed the map camera. The guarded reset armed on the first click, executed on the second, retained seed 1, returned villagers to 0, and cleared the timeline.
- The range remained at its default 30 because the in-app browser driver could not synthesize a range-value change. The 10–80 brush boundary and React update behavior are covered by the passing UI suite; land/water strokes themselves were exercised live.

## Planner boundary and fallback

The live health response proved the server had no Gemini credential. Each quiet-window request reached `/api/plan`, failed safely at the provider boundary, and produced an explicitly labeled fallback rather than a false AI result. The browser observed the complete ordered chain:

1. hazard observation;
2. fallback plan after the bounded quiet window;
3. engine execution with actual assignment counts;
4. deterministic task/event outcomes.

Representative live entries included a tsunami fallback with `relocate actual 16/16` and a plague fallback with `isolate_sick actual 3/3`. Console errors/warnings remained empty after both disaster groups.

The browser controller did not expose raw network bodies. Payload privacy was therefore verified by the real `createPlannerRequest` regression in the 225-test suite: seeded task IDs, villager IDs, and path nodes are absent, active events are compact and bounded, and only the latest five outcomes are retained. The shared Zod contract rejects exact destinations in planner intents. Client/server tests verify AI responses are parsed and validated before `VillageEngine.executePlan`; engine transaction tests verify malformed plans cannot partially mutate state. The live timeline's fallback-before-execution ordering corroborated that boundary end to end.

## No-game-over continuation

The live disaster story reduced the status bar from 16 living villagers to 0 without showing a game-over state or disabling tools. A subsequent Totem action still reached authoritative placement validation and returned the ordinary shoreline-clearance message, proving the edit/placement command path remained active after depletion. The browser-selected point was not a valid replacement site, so a second live settlement was not established in that depleted state. Deterministic engine replacement and hazard-reconciliation tests cover successful valid replacement; the guarded reset/reseed was also completed live.

## Desktop visual audit

`artifacts/product-verification/desktop.png` is exactly 1440×1000 (SHA-256 `ca7b9f657ff5ac2a15f08e31140bdf3bde6a616cf4bccc70b62556591f0c0c92`). It was inspected at original resolution. The parchment/chrome shell, full island overview, houses, villagers, roads, continuous wall, bridge, monument, active fire, external tool rail, and readable timeline hierarchy are visible. Body and document widths were both 1440, so no horizontal page overflow was present. The canvas measured 912×613 before camera interaction; no error overlay appeared.

## Mobile visual audit

`artifacts/product-verification/mobile.png` is exactly 430×932 (SHA-256 `1ca4614b70c439c49fb850ba2f19cd55088a4451a46bd1c7d29624da252d508f`). It was inspected at original resolution. The rail becomes a horizontally scrollable, labeled tool strip; brush, Pause, and Reset remain visibly reachable; the canvas is a legible 406×305 overview; the notification board and timeline stack below it. Every measured tool/utility target was at least 44 px tall. Body and document widths were both 430, so no horizontal page overflow was present. No error overlay or console warning/error appeared.

## Requirement audit

| Requirement | Result | Evidence |
| --- | --- | --- |
| Terrain paint and brush sizing | Pass with noted browser-driver limit | Live land/water strokes; brush bounds/update in passing UI tests |
| Village marker, houses, villagers, roads, wall, and bridge | Pass | Live 16-villager placement and desktop screenshot |
| Fire, tsunami, bandits, earthquake, and plague | Pass | Five live observations and deterministic resolutions |
| AI-or-fallback plan followed by deterministic execution/outcome | Pass | Live configured-false API plus fallback/execution/outcome timeline |
| Pause/resume, pan, zoom, reset/reseed | Pass | Browser interaction |
| Editing remains available after depletion | Pass | 0-villager live state with enabled tools and active placement validation |
| Valid replacement village after depletion | Automated only | Live click was rejected for shoreline clearance; engine replacement suites pass |
| Desktop and narrow layouts remain usable without page overflow | Pass | Screenshots plus 1440=1440 and 430=430 DOM measurements |
| Planner request omits exact movement/path nodes | Pass | Real planner-request regression in the integrated suite; raw browser body unavailable |
| Engine does not mutate before validated intents execute | Pass | Client/server Zod tests, engine transaction tests, and live timeline ordering |

## Process and cleanup

No interaction or capture stalled, so CPU inspection/retry was unnecessary. The one browser session was finalized with no tab retained. The production PTY was interrupted, PID 33651 disappeared, `lsof -nP -iTCP:8787 -sTCP:LISTEN` returned no listener, and `pgrep -fl "server/index.ts|vitest"` returned no server or watcher.

## Remaining limits

- No live Gemini call was made because no credential was provided; transparent deterministic fallback is the supported credential-free behavior and was exercised end to end.
- The in-app browser could not change the range input or expose raw request bodies. Those two details rely on the passing real UI/planning boundary tests rather than browser-captured values.
- The post-depletion Totem click reached normal placement validation but selected shoreline terrain. Successful valid replacement is covered by the engine suite, not by this final browser trace.
- `src/engine/village.ts` and `src/engine/disasters.ts` remain large cohesive modules, as previously recorded. This is a maintainability concern, not an observed correctness or runtime failure.
