import { useEffect, useRef, useState, type CSSProperties } from "react";

import {
  getTutorialStep,
  type TutorialStepId,
} from "./tutorial";

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly right: number;
  readonly bottom: number;
}

interface TutorialLayout {
  readonly target: Rect;
  readonly card: { readonly left: number; readonly top: number; readonly width: number };
  readonly connector: { readonly left: number; readonly top: number; readonly width: number; readonly angle: number };
}

export interface WorldBootTutorialProps {
  readonly step: TutorialStepId;
  readonly canAdvance: boolean;
  readonly onNext: () => void;
  readonly onSkip: () => void;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), Math.max(minimum, maximum));

function centeredWorldTarget(viewportWidth: number, viewportHeight: number): Rect {
  const width = Math.min(520, Math.max(260, viewportWidth * 0.42));
  const height = Math.min(360, Math.max(220, viewportHeight * 0.42));
  const left = clamp((viewportWidth - width) * 0.44, 24, viewportWidth - width - 24);
  const top = clamp((viewportHeight - height) * 0.48, 76, viewportHeight - height - 24);
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function measureTarget(targetName: string): Rect | null {
  if (typeof window === "undefined") return null;
  const target = document.querySelector<HTMLElement>(`[data-tutorial-target="${targetName}"]`);
  if (target === null) return null;
  if (targetName === "world") return centeredWorldTarget(window.innerWidth, window.innerHeight);
  const bounds = target.getBoundingClientRect();
  if (bounds.width === 0 || bounds.height === 0) return null;
  const padding = targetName === "toolbar" || targetName === "notifications" ? 8 : 7;
  const left = Math.max(8, bounds.left - padding);
  const top = Math.max(8, bounds.top - padding);
  const right = Math.min(window.innerWidth - 8, bounds.right + padding);
  const bottom = Math.min(window.innerHeight - 8, bounds.bottom + padding);
  return { left, top, width: right - left, height: bottom - top, right, bottom };
}

function createLayout(target: Rect, viewportWidth: number, viewportHeight: number): TutorialLayout {
  const cardWidth = Math.min(348, viewportWidth - 32);
  const gap = 24;
  const fitsRight = target.right + gap + cardWidth <= viewportWidth - 16;
  const fitsLeft = target.left - gap - cardWidth >= 16;
  const cardLeft = fitsRight
    ? target.right + gap
    : fitsLeft
      ? target.left - gap - cardWidth
      : clamp(target.left, 16, viewportWidth - cardWidth - 16);
  const cardTop = fitsRight || fitsLeft
    ? clamp(target.top + Math.min(8, (target.height - 220) / 2), 16, viewportHeight - 236)
    : clamp(target.bottom + gap, 16, viewportHeight - 236);
  const targetX = fitsRight ? target.right : fitsLeft ? target.left : target.left + target.width / 2;
  const targetY = fitsRight || fitsLeft ? target.top + target.height / 2 : target.bottom;
  const cardX = fitsRight ? cardLeft : fitsLeft ? cardLeft + cardWidth : cardLeft + cardWidth / 2;
  const cardY = fitsRight || fitsLeft ? cardTop + 46 : cardTop;
  const deltaX = cardX - targetX;
  const deltaY = cardY - targetY;
  return {
    target,
    card: { left: cardLeft, top: cardTop, width: cardWidth },
    connector: {
      left: targetX,
      top: targetY,
      width: Math.max(14, Math.hypot(deltaX, deltaY)),
      angle: Math.atan2(deltaY, deltaX) * 180 / Math.PI,
    },
  };
}

function focusStepTarget(stepId: TutorialStepId): void {
  if (typeof window === "undefined") return;
  const step = getTutorialStep(stepId);
  const target = step.target === "world"
    ? null
    : document.querySelector<HTMLElement>(`[data-tutorial-target="${step.target}"]`);
  const focusTarget = target ?? document.querySelector<HTMLElement>(".tutorial-card__title");
  focusTarget?.focus({ preventScroll: true });
}

export function WorldBootTutorial({ step: stepId, canAdvance, onNext, onSkip }: WorldBootTutorialProps) {
  const step = getTutorialStep(stepId);
  const isWorldStep = step.target === "world";
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [layout, setLayout] = useState<TutorialLayout | null>(null);

  useEffect(() => {
    const updateLayout = () => {
      if (typeof window === "undefined") return;
      const target = isWorldStep ? null : measureTarget(step.target);
      setLayout(target === null ? null : createLayout(target, window.innerWidth, window.innerHeight));
    };
    updateLayout();
    window.addEventListener("resize", updateLayout);
    window.visualViewport?.addEventListener("resize", updateLayout);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateLayout);
    const target = isWorldStep ? null : document.querySelector<HTMLElement>(`[data-tutorial-target="${step.target}"]`);
    if (target !== null) observer?.observe(target);
    let mutationObserver: MutationObserver | null = null;
    if (!isWorldStep && target === null && typeof MutationObserver !== "undefined") {
      mutationObserver = new MutationObserver(() => {
        updateLayout();
        if (document.querySelector<HTMLElement>(`[data-tutorial-target="${step.target}"]`) !== null) {
          mutationObserver?.disconnect();
          mutationObserver = null;
        }
      });
      const mutationRoot = document.querySelector<HTMLElement>(".workspace") ?? document.body;
      if (mutationRoot !== null) mutationObserver.observe(mutationRoot, { childList: true, subtree: true });
    }
    return () => {
      window.removeEventListener("resize", updateLayout);
      window.visualViewport?.removeEventListener("resize", updateLayout);
      observer?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [step.target]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      focusStepTarget(stepId);
      if (document.activeElement === document.body) titleRef.current?.focus();
    }, 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onSkip();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onSkip, stepId]);

  const activeLayout = isWorldStep ? null : layout;
  const isStandalone = activeLayout === null;
  const targetStyle: CSSProperties | undefined = activeLayout === null ? undefined : {
    left: activeLayout.target.left,
    top: activeLayout.target.top,
    width: activeLayout.target.width,
    height: activeLayout.target.height,
  };
  const cardStyle: CSSProperties | undefined = activeLayout === null ? undefined : {
    left: activeLayout.card.left,
    top: activeLayout.card.top,
    width: activeLayout.card.width,
  };
  const connectorStyle: CSSProperties | undefined = activeLayout === null ? undefined : {
    left: activeLayout.connector.left,
    top: activeLayout.connector.top,
    width: activeLayout.connector.width,
    transform: `rotate(${activeLayout.connector.angle}deg)`,
  };
  const isFinalStep = stepId === "try-tools";

  return (
    <div className={`tutorial-overlay${stepId === "welcome" ? " tutorial-overlay--welcome" : ""}`} aria-label="World Boot tutorial">
      {stepId === "welcome" ? <div className="tutorial-dim" aria-hidden="true" /> : null}
      {activeLayout === null ? null : <div className="tutorial-spotlight" style={targetStyle} aria-hidden="true" />}
      {activeLayout === null ? null : <div className="tutorial-connector" style={connectorStyle} aria-hidden="true" />}
      <section
        className={`tutorial-card${isStandalone ? " tutorial-card--standalone" : ""}`}
        style={cardStyle}
        role="dialog"
        aria-modal="false"
        aria-labelledby="world-boot-tutorial-title"
        aria-describedby="world-boot-tutorial-description"
      >
        <h2 className="tutorial-card__title" id="world-boot-tutorial-title" ref={titleRef} tabIndex={-1}>{step.title}</h2>
        <p className="tutorial-card__description" id="world-boot-tutorial-description">{step.description}</p>
        <div className="tutorial-card__actions">
          <button
            className="tutorial-card__next"
            type="button"
            data-tutorial-action="next"
            disabled={!canAdvance}
            onClick={onNext}
          >
            {isFinalStep ? "Finish" : "Next"}
          </button>
          <button className="tutorial-card__skip" type="button" onClick={onSkip}>Skip tutorial</button>
        </div>
      </section>
    </div>
  );
}
