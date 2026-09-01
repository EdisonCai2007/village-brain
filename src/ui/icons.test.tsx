import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BanditsIcon, PlagueIcon, ResetIcon } from "./icons";

const tagCount = (markup: string, tagName: string): number =>
  (markup.match(new RegExp(`<${tagName}\\b`, "g")) ?? []).length;

describe("toolbar icons", () => {
  it("renders reset as a single reset arrow without extra menu strokes", () => {
    const markup = renderToStaticMarkup(<ResetIcon />);

    expect(tagCount(markup, "path")).toBe(1);
    expect(markup).not.toContain("h8");
    expect(markup).not.toContain("h4");
  });

  it("renders bandits as a person silhouette with a distinct head", () => {
    const markup = renderToStaticMarkup(<BanditsIcon />);

    expect(tagCount(markup, "circle")).toBeGreaterThanOrEqual(1);
    expect(tagCount(markup, "path")).toBeGreaterThanOrEqual(2);
  });

  it("renders plague as a biohazard badge with an outer ring and center hub", () => {
    const markup = renderToStaticMarkup(<PlagueIcon />);

    expect(tagCount(markup, "circle")).toBe(2);
    expect(tagCount(markup, "path")).toBeGreaterThanOrEqual(4);
  });
});
