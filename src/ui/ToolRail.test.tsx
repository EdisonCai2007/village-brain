import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ToolRail, nextResetAction } from "./ToolRail";

describe("ToolRail", () => {
  it("exposes every sandbox tool as a named pressed-state button", () => {
    const markup = renderToStaticMarkup(
      <ToolRail
        activeTool="land"
        brushSize={28}
        disabled={false}
        paused={false}
        onBrushSizeChange={vi.fn()}
        onPauseToggle={vi.fn()}
        onReset={vi.fn()}
        onToolSelect={vi.fn()}
      />,
    );

    for (const name of [
      "Land", "Water", "Totem", "Fire", "Tsunami", "Bandits",
      "Earthquake", "Plague", "Pan",
    ]) {
      expect(markup).toMatch(new RegExp(`<button[^>]+aria-pressed="(?:true|false)"[^>]*>${name}|<button[^>]+aria-label="${name}"[^>]+aria-pressed="(?:true|false)"`));
    }
    expect(markup).not.toContain('aria-label="Inspect"');
    expect(markup).toContain('type="range"');
    expect(markup).toContain('min="10"');
    expect(markup).toContain('max="80"');
  });

  it("renders designed tooltip content instead of native title attributes", () => {
    const markup = renderToStaticMarkup(
      <ToolRail
        activeTool="pan"
        brushSize={28}
        disabled={false}
        paused={false}
        onBrushSizeChange={vi.fn()}
        onPauseToggle={vi.fn()}
        onReset={vi.fn()}
        onToolSelect={vi.fn()}
      />,
    );

    expect(markup).not.toContain("title=");
    expect(markup).toContain('class="tool-button__tooltip"');
    expect(markup).toContain("Pan");
    expect(markup).toContain("H");
    expect(markup).toContain('class="utility-button__tooltip"');
    expect(markup).toContain("Brush size");
  });

  it("requires a second reset request inside four seconds", () => {
    expect(nextResetAction(1_000, 0)).toEqual({ kind: "arm", confirmUntil: 5_000 });
    expect(nextResetAction(4_999, 5_000)).toEqual({ kind: "execute", confirmUntil: 0 });
    expect(nextResetAction(5_001, 5_000)).toEqual({ kind: "arm", confirmUntil: 9_001 });
  });
});
