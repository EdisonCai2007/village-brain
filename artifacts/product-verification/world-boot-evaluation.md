# World Boot Tutorial Verification

Date: 2026-08-30

## Automated evidence

- `npm run test:run`: 26 test files, 251 tests passed.
- `npm run typecheck`: passed.
- `npm run build`: passed; Vite emitted only the existing large-chunk advisory.
- The first in-sandbox full-suite attempt was blocked only because the sandbox denied the existing HTTP host tests' `127.0.0.1` bind with `listen EPERM`; the same serial command passed after the narrow permission escalation.

## Browser evidence

Verified against the running Vite app at `http://127.0.0.1:5173/`:

1. Fresh desktop load opens on an ocean-only world with no village or land and shows Welcome, step 1 of 9.
2. Next advances to Land; selecting the real Land button advances to Draw an island.
3. Painting on the real Pixi canvas enables Next; the real Totem button advances to Place the village.
4. Clicking a valid painted-land location creates the village and enables Next; the real Bandits button advances to Place the bandits.
5. Clicking a valid land location creates a bandit event and enables Next; Watch Village Brain work highlights the original floating notification board.
6. The notification board displays newest entries first with slide-down entry motion and a fading lower edge, so recent chief responses remain visible without a permanent side panel.
7. Finish removes the overlay; Replay tutorial returns to Welcome; Escape removes the overlay through the keyboard path.
8. A fresh 430×932 load keeps the tutorial card and spotlight inside the viewport and reports no horizontal overflow.
9. The final welcome card uses the existing brown toolkit surface (`rgba(93, 66, 46, 0.94)`) and gold text (`rgb(217, 184, 111)`), omits the visible `World Boot · ...` progress label, and reports `justify-content: flex-end` for the action row.
10. Browser health checks reported body content, no framework error overlay, and no console warnings/errors.

The desktop and mobile screenshots were recaptured after the final token and layout changes:

- Brown card background and gold copy are visible in both screenshots.
- `Next` and `Skip tutorial` sit together at the card's bottom-right edge at both viewport sizes.

Screenshots:

- `world-boot-desktop.png`
- `world-boot-mobile.png`

## CPU/process safety

The environment denied `ps` and `top` with `operation not permitted`, so live CPU counters were unavailable. Verification used one Vite process, one browser tab, serial test/build commands with one Vitest worker, no layout-property animation on spotlight resizing, and explicit server cleanup after the browser pass.
