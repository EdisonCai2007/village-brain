import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

describe("sandbox surface layout", () => {
  it("lets the world canvas sit directly on the desk instead of inside a white frame", () => {
    const appCss = source("src/styles/app.css");
    const renderer = source("src/renderer/VillageRenderer.ts");

    expect(appCss).toContain(".world-frame");
    expect(appCss).not.toContain("border: 10px solid");
    expect(appCss).not.toContain("background: var(--paper);");
    expect(appCss).not.toContain("background: var(--paper-deep);");
    expect(renderer).toContain("backgroundAlpha: 0");
  });

  it("keeps the app shell desk as a flat brown surface", () => {
    const appCss = source("src/styles/app.css");

    expect(appCss).toContain("background: var(--desk);");
    expect(appCss).not.toContain("linear-gradient");
    expect(appCss).not.toContain("radial-gradient");
  });

  it("keeps the brush-size slider inside the rail without a rotated overflow hack", () => {
    const controlsCss = source("src/styles/controls.css");

    expect(controlsCss).toContain("writing-mode: vertical-lr");
    expect(controlsCss).not.toContain("transform: rotate(-90deg)");
  });

  it("gives the tutorial card a brown-and-gold surface with right-aligned actions", () => {
    const appCss = source("src/styles/app.css");
    const tokensCss = source("src/styles/tokens.css");

    expect(appCss).toContain(".tutorial-card");
    expect(appCss).toContain("color: var(--monument-inset);");
    expect(appCss).toContain("background: var(--toolkit-raised);");
    expect(appCss).toContain("justify-content: flex-end;");
    expect(tokensCss).toContain("--monument-inset: #d9b86f;");
    expect(tokensCss).toContain("--radius-card: 12px;");
  });

  it("keeps the original notification stack over the world instead of reserving a side panel", () => {
    const notificationsCss = source("src/styles/decision-notifications.css");

    expect(notificationsCss).toContain("right: max(12px, env(safe-area-inset-right));");
    expect(notificationsCss).toContain("animation: decision-notification-shift-down");
  });
});
