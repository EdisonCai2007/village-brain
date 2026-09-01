import { useCallback, useEffect, useState, type ComponentType, type CSSProperties, type SVGProps } from "react";

import type { ToolId } from "./useSimulation";
import {
  BanditsIcon, BrushIcon, EarthquakeIcon, FireIcon, LandIcon,
  PanIcon, PauseIcon, PlagueIcon, PlayIcon, ResetIcon, TotemIcon, TsunamiIcon, WaterIcon,
} from "./icons";

interface ToolDefinition {
  readonly id: ToolId;
  readonly label: string;
  readonly shortcut: string;
  readonly icon: ComponentType<SVGProps<SVGSVGElement>>;
}

interface ToolGroup {
  readonly label: string;
  readonly tools: readonly ToolDefinition[];
}

const TOOL_GROUPS: readonly ToolGroup[] = [
  { label: "Terrain", tools: [
    { id: "land", label: "Land", shortcut: "1", icon: LandIcon },
    { id: "water", label: "Water", shortcut: "2", icon: WaterIcon },
  ] },
  { label: "Village", tools: [
    { id: "totem", label: "Totem", shortcut: "3", icon: TotemIcon },
  ] },
  { label: "Disasters", tools: [
    { id: "fire", label: "Fire", shortcut: "4", icon: FireIcon },
    { id: "tsunami", label: "Tsunami", shortcut: "5", icon: TsunamiIcon },
    { id: "bandits", label: "Bandits", shortcut: "6", icon: BanditsIcon },
    { id: "earthquake", label: "Earthquake", shortcut: "7", icon: EarthquakeIcon },
    { id: "plague", label: "Plague", shortcut: "8", icon: PlagueIcon },
  ] },
  { label: "Workspace", tools: [
    { id: "pan", label: "Pan", shortcut: "H", icon: PanIcon },
  ] },
] as const;

interface TooltipProps {
  readonly label: string;
  readonly shortcut?: string;
  readonly className: string;
}

function Tooltip({ label, shortcut, className }: TooltipProps) {
  return (
    <span className={className} role="tooltip">
      <span>{label}</span>
      {shortcut === undefined ? null : <kbd>{shortcut}</kbd>}
    </span>
  );
}

export interface ToolRailProps {
  readonly activeTool: ToolId;
  readonly brushSize: number;
  readonly disabled: boolean;
  readonly paused: boolean;
  readonly onToolSelect: (tool: ToolId) => void;
  readonly onBrushSizeChange: (size: number) => void;
  readonly onPauseToggle: () => void;
  readonly onReset: () => void;
  readonly onReplayTutorial?: () => void;
}

export type ResetAction =
  | { readonly kind: "arm"; readonly confirmUntil: number }
  | { readonly kind: "execute"; readonly confirmUntil: 0 };

export function nextResetAction(now: number, confirmUntil: number): ResetAction {
  return confirmUntil > now
    ? { kind: "execute", confirmUntil: 0 }
    : { kind: "arm", confirmUntil: now + 4_000 };
}

export function ToolRail({
  activeTool,
  brushSize,
  disabled,
  paused,
  onToolSelect,
  onBrushSizeChange,
  onPauseToggle,
  onReset,
  onReplayTutorial,
}: ToolRailProps) {
  const [resetConfirmUntil, setResetConfirmUntil] = useState(0);

  useEffect(() => {
    if (resetConfirmUntil === 0) return undefined;
    const remaining = Math.max(0, resetConfirmUntil - Date.now());
    const timer = window.setTimeout(() => setResetConfirmUntil(0), remaining);
    return () => window.clearTimeout(timer);
  }, [resetConfirmUntil]);

  const handleReset = useCallback(() => {
    const action = nextResetAction(Date.now(), resetConfirmUntil);
    setResetConfirmUntil(action.confirmUntil);
    if (action.kind === "execute") onReset();
  }, [onReset, resetConfirmUntil]);

  const handleBrushChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    onBrushSizeChange(Number(event.currentTarget.value));
  }, [onBrushSizeChange]);
  const brushPreviewStyle = { "--brush-preview": `${Math.max(3, Math.round(brushSize / 9))}px` } as CSSProperties;
  const PauseToggleIcon = paused ? PlayIcon : PauseIcon;
  const resetLabel = resetConfirmUntil > 0 ? "Confirm reset world" : "Reset world";

  return (
    <aside className="tool-rail" aria-label="Sandbox tools" data-tutorial-target="toolbar" tabIndex={-1}>
      <div className="tool-rail__scroll">
        {TOOL_GROUPS.map((group) => (
          <fieldset className="tool-group" key={group.label} disabled={disabled}>
            <legend className="visually-hidden">{group.label}</legend>
            <div className="tool-group__items">
              {group.tools.map((tool) => {
                const Icon = tool.icon;
                return (
                  <button
                    className="tool-button"
                    type="button"
                    aria-label={tool.label}
                    data-tutorial-target={tool.id}
                    aria-pressed={activeTool === tool.id}
                    key={tool.id}
                    onClick={() => onToolSelect(tool.id)}
                  >
                    <Icon className="tool-button__icon" />
                    <Tooltip className="tool-button__tooltip" label={tool.label} shortcut={tool.shortcut} />
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>

      <div className="tool-rail__settings">
        <label className="brush-control" style={brushPreviewStyle}>
          <span className="visually-hidden">Brush size</span>
          <BrushIcon className="brush-control__icon" aria-hidden="true" />
          <span className="brush-control__stroke" aria-hidden="true" />
          <Tooltip className="brush-control__tooltip" label="Brush size" />
          <input
            type="range"
            min={10}
            max={80}
            step={2}
            value={brushSize}
            disabled={disabled}
            onChange={handleBrushChange}
            aria-label="Brush size"
          />
        </label>
        <button
          className="utility-button"
          type="button"
          aria-label={paused ? "Resume" : "Pause"}
          disabled={disabled}
          onClick={onPauseToggle}
        >
          <PauseToggleIcon className="utility-button__icon" />
          <Tooltip className="utility-button__tooltip" label={paused ? "Resume" : "Pause"} shortcut="Space" />
        </button>
        <button
          className="utility-button utility-button--danger"
          type="button"
          aria-label={resetLabel}
          data-armed={resetConfirmUntil > 0}
          disabled={disabled}
          onClick={handleReset}
        >
          <ResetIcon className="utility-button__icon" />
          <Tooltip className="utility-button__tooltip" label={resetLabel} />
        </button>
        {onReplayTutorial === undefined ? null : (
          <button
            className="utility-button utility-button--tutorial"
            type="button"
            aria-label="Replay tutorial"
            onClick={onReplayTutorial}
          >
            <span className="tutorial-replay-mark" aria-hidden="true">?</span>
            <Tooltip className="utility-button__tooltip" label="Replay tutorial" />
          </button>
        )}
      </div>
    </aside>
  );
}
