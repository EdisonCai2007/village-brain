import type { Point, WorldCommand } from "../engine/types";

export const MIN_CAMERA_SCALE = 0.55;
export const MAX_CAMERA_SCALE = 2.4;
export const MIN_WORLD_VISIBLE = 0.15;
export const DEFAULT_WORLD_FIT_PADDING_RATIO = 0.08;

export type RendererTool =
  | "land"
  | "water"
  | "totem"
  | "fire"
  | "tsunami"
  | "bandits"
  | "earthquake"
  | "plague"
  | "pan";

export interface CameraState {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface CommandGesture {
  readonly tool: RendererTool;
  readonly brushRadius: number;
  readonly lastPoint: Point;
}

export interface GestureUpdate {
  readonly session: CommandGesture;
  readonly commands: readonly WorldCommand[];
}

export interface ViewportPanStartInput {
  readonly tool: RendererTool;
  readonly button: number;
  readonly spacePressed: boolean;
  readonly panOverride: boolean;
}

export function clampScale(scale: number): number {
  return Math.min(MAX_CAMERA_SCALE, Math.max(MIN_CAMERA_SCALE, scale));
}

export function interpolateBrushPoints(from: Point, to: Point, radius: number): Point[] {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (distance === 0) return [{ ...from }];
  const maximumStep = Math.max(0.5, radius * 0.5);
  const steps = Math.max(1, Math.ceil(distance / maximumStep));
  const points: Point[] = [];

  for (let step = 0; step <= steps; step += 1) {
    const ratio = step / steps;
    points.push({
      x: from.x + (to.x - from.x) * ratio,
      y: from.y + (to.y - from.y) * ratio,
    });
  }

  return points;
}

export function zoomCameraAt(camera: CameraState, cursor: Point, requestedScale: number): CameraState {
  const scale = clampScale(requestedScale);
  const worldX = (cursor.x - camera.x) / camera.scale;
  const worldY = (cursor.y - camera.y) / camera.scale;
  return {
    x: cursor.x - worldX * scale,
    y: cursor.y - worldY * scale,
    scale,
  };
}

export function clampCamera(camera: CameraState, viewport: Size, world: Size): CameraState {
  const scaledWidth = world.width * camera.scale;
  const scaledHeight = world.height * camera.scale;
  const minimumX = -scaledWidth * (1 - MIN_WORLD_VISIBLE);
  const maximumX = viewport.width - scaledWidth * MIN_WORLD_VISIBLE;
  const minimumY = -scaledHeight * (1 - MIN_WORLD_VISIBLE);
  const maximumY = viewport.height - scaledHeight * MIN_WORLD_VISIBLE;

  return {
    x: Math.min(Math.max(camera.x, Math.min(minimumX, maximumX)), Math.max(minimumX, maximumX)),
    y: Math.min(Math.max(camera.y, Math.min(minimumY, maximumY)), Math.max(minimumY, maximumY)),
    scale: clampScale(camera.scale),
  };
}

export function fitCameraToWorld(
  viewport: Size,
  world: Size,
  padding = Math.min(96, Math.max(36, Math.min(viewport.width, viewport.height) * DEFAULT_WORLD_FIT_PADDING_RATIO)),
): CameraState {
  const horizontalSpace = Math.max(1, viewport.width - padding * 2);
  const verticalSpace = Math.max(1, viewport.height - padding * 2);
  const scale = clampScale(Math.min(horizontalSpace / world.width, verticalSpace / world.height));
  return {
    x: (viewport.width - world.width * scale) / 2,
    y: (viewport.height - world.height * scale) / 2,
    scale,
  };
}

export function shouldStartViewportPan({
  tool,
  button,
  spacePressed,
  panOverride,
}: ViewportPanStartInput): boolean {
  return tool === "pan" || button === 1 || spacePressed || panOverride;
}

export function revisionKey(seed: number, revision: number): string {
  return `${seed}:${revision}`;
}

export class LayerRevisionCache {
  readonly #keys = new Map<string, string>();

  changed(layer: string, seed: number, revision: number): boolean {
    const next = revisionKey(seed, revision);
    if (this.#keys.get(layer) === next) return false;
    this.#keys.set(layer, next);
    return true;
  }

  clear(): void {
    this.#keys.clear();
  }
}

export function beginCommandGesture(
  tool: RendererTool,
  point: Point,
  brushRadius: number,
): GestureUpdate {
  const session = { tool, brushRadius, lastPoint: point } satisfies CommandGesture;
  const commands = isPaintTool(tool) ? [paintCommand(tool, point, brushRadius)] : [];
  return { session, commands };
}

export function moveCommandGesture(session: CommandGesture, point: Point): GestureUpdate {
  const commands = isPaintTool(session.tool)
    ? interpolateBrushPoints(session.lastPoint, point, session.brushRadius)
        .slice(1)
        .map((sample) => paintCommand(session.tool as "land" | "water", sample, session.brushRadius))
    : [];

  return {
    session: { ...session, lastPoint: point },
    commands,
  };
}

export function endCommandGesture(session: CommandGesture, point: Point): GestureUpdate {
  if (isPaintTool(session.tool)) return moveCommandGesture(session, point);

  const command = releaseCommand(session.tool, point);
  return {
    session: { ...session, lastPoint: point },
    commands: command ? [command] : [],
  };
}

function isPaintTool(tool: RendererTool): tool is "land" | "water" {
  return tool === "land" || tool === "water";
}

function paintCommand(tool: "land" | "water", point: Point, radius: number): WorldCommand {
  return { type: "paint", terrain: tool, point, radius };
}

function releaseCommand(tool: RendererTool, point: Point): WorldCommand | null {
  switch (tool) {
    case "totem":
      return { type: "place_totem", point };
    case "fire":
      return { type: "trigger_fire", point };
    case "tsunami":
      return { type: "trigger_tsunami", point };
    case "bandits":
      return { type: "trigger_bandits", point };
    case "earthquake":
      return { type: "trigger_earthquake", point };
    case "plague":
      return { type: "trigger_plague", point };
    default:
      return null;
  }
}
