import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WorldBootTutorial } from "./WorldBootTutorial";

describe("WorldBootTutorial", () => {
  it("dims the full screen for the welcome step while keeping the card standalone",
    () => {
      const markup = renderToStaticMarkup(
        <WorldBootTutorial
          step="welcome"
          canAdvance
          onNext={vi.fn()}
          onSkip={vi.fn()}
        />,
      );

      expect(markup).toContain('class="tutorial-overlay tutorial-overlay--welcome"');
      expect(markup).toContain('class="tutorial-dim"');
      expect(markup).toContain('class="tutorial-card tutorial-card--standalone"');
      expect(markup).not.toContain('class="tutorial-spotlight"');
      expect(markup).not.toContain('class="tutorial-connector"');
    },
  );

  it.each(["draw-island", "place-village", "place-bandits"] as const)(
    "keeps the %s world step un-dimmed",
    (step) => {
      const markup = renderToStaticMarkup(
        <WorldBootTutorial
          step={step}
          canAdvance
          onNext={vi.fn()}
          onSkip={vi.fn()}
        />,
      );

      expect(markup).toContain('class="tutorial-card tutorial-card--standalone"');
      expect(markup).not.toContain('class="tutorial-overlay tutorial-overlay--welcome"');
      expect(markup).not.toContain('class="tutorial-dim"');
      expect(markup).not.toContain('class="tutorial-spotlight"');
      expect(markup).not.toContain('class="tutorial-connector"');
    },
  );

  it("keeps the watch-chief card anchored when notifications have not rendered yet", () => {
    const markup = renderToStaticMarkup(
      <WorldBootTutorial
        step="watch-chief"
        canAdvance
        onNext={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    expect(markup).toContain('class="tutorial-card tutorial-card--standalone"');
    expect(markup).not.toContain('class="tutorial-spotlight"');
    expect(markup).not.toContain('class="tutorial-connector"');
  });

  it("renders the current step with an action-gated Next button", () => {
    const markup = renderToStaticMarkup(
      <WorldBootTutorial
        step="draw-island"
        canAdvance={false}
        onNext={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    expect(markup).toContain("Draw an island");
    expect(markup).toContain('aria-label="World Boot tutorial"');
    expect(markup).toContain('data-tutorial-action="next"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("Skip tutorial");
  });

  it("renders a finish action on the final step", () => {
    const markup = renderToStaticMarkup(
      <WorldBootTutorial
        step="try-tools"
        canAdvance
        onNext={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    expect(markup).toContain("Shape the story");
    expect(markup).toContain("Finish");
    expect(markup).not.toContain("World Boot ·");
  });

  it("keeps the welcome card focused on its message and actions", () => {
    const markup = renderToStaticMarkup(
      <WorldBootTutorial
        step="welcome"
        canAdvance
        onNext={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    expect(markup).toContain("Welcome to Village Brain");
    expect(markup).toContain("Shape an island, start a village, and see how its chief responds to a threat.");
    expect(markup).not.toContain("World Boot ·");
  });
});
