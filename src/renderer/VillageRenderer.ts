import {
  Application,
  Container,
  type FederatedPointerEvent,
  Graphics,
  Rectangle,
} from "pixi.js";

import {
  CELL_SIZE,
  GRID_WIDTH,
  PLAGUE_INITIAL_RADIUS,
  TERRAIN_LAND,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from "../engine/constants";
import type { Point, WorldCommand, WorldReadModel } from "../engine/types";
import {
  createBanditGraphic,
  createVillagerGraphic,
  drawHazards,
  drawPreview,
  drawRoads,
  drawStructures,
  drawTerrain,
} from "./draw";
import { findNewEarthquakeEventIds } from "./earthquakeRumble";
import {
  beginCommandGesture,
  clampCamera,
  endCommandGesture,
  fitCameraToWorld,
  LayerRevisionCache,
  moveCommandGesture,
  shouldStartViewportPan,
  type CameraState,
  type CommandGesture,
  type RendererTool,
  zoomCameraAt,
} from "./interaction";
import { palette } from "./palette";
import {
  getVillagerDeathAnimationFrame,
} from "./villagerDeathAnimation";

export interface RendererUiReadModel {
  readonly tool?: RendererTool | string;
  readonly activeTool?: RendererTool | string;
  readonly selectedTool?: RendererTool | string;
  readonly brushRadius?: number;
  readonly brushSize?: number;
  readonly panOverride?: boolean;
  readonly placementValid?: boolean | null;
}

export interface PlacementPreview {
  readonly tool: RendererTool;
  readonly point: Point;
  readonly valid: boolean;
}

export interface VillageRendererCallbacks {
  readonly onCommand: (command: WorldCommand) => void;
  readonly onPreview?: (preview: PlacementPreview | null) => void;
  readonly validatePlacement?: (
    tool: RendererTool,
    point: Point,
    world: WorldReadModel,
  ) => boolean;
}

type CommandSink = (command: WorldCommand) => void;

interface PanGesture {
  readonly pointerId: number;
  readonly startScreen: Point;
  readonly startCamera: CameraState;
}

interface ToolGesture {
  readonly pointerId: number;
  readonly command: CommandGesture;
}

type ActiveGesture = { readonly kind: "pan"; readonly value: PanGesture }
  | { readonly kind: "tool"; readonly value: ToolGesture };

interface UnitNode {
  readonly graphic: Graphics;
  readonly appearance: string;
  readonly deathOrigin: Point | null;
  readonly deathStartedAt: number | null;
}

interface EarthquakeBurst {
  readonly id: string;
  readonly origin: Point;
  readonly startedAt: number;
}

const EARTHQUAKE_RUMBLE_MS = 560;
const EARTHQUAKE_SHAKE_PX = 5;
const EARTHQUAKE_PARTICLE_COUNT = 14;

export class VillageRenderer {
  readonly #host: HTMLElement;
  readonly #callbacks: VillageRendererCallbacks;
  readonly #app = new Application();
  readonly #cameraRoot = new Container();
  readonly #worldRoot = new Container();
  readonly #terrainLayer = new Container();
  readonly #roadsLayer = new Container();
  readonly #structuresLayer = new Container();
  readonly #hazardsLayer = new Container();
  readonly #effectsLayer = new Container();
  readonly #unitsLayer = new Container();
  readonly #previewLayer = new Container();
  readonly #terrainGraphics = new Graphics();
  readonly #roadsGraphics = new Graphics();
  readonly #structuresGraphics = new Graphics();
  readonly #hazardsGraphics = new Graphics();
  readonly #effectsGraphics = new Graphics();
  readonly #previewGraphics = new Graphics();
  readonly #cache = new LayerRevisionCache();
  readonly #villagerNodes = new Map<string, UnitNode>();
  readonly #hostileNodes = new Map<string, UnitNode>();
  readonly #completedVillagerDeaths = new Set<string>();

  #camera: CameraState = { x: 0, y: 0, scale: 1 };
  #world: WorldReadModel | null = null;
  #ui: RendererUiReadModel = {};
  #gesture: ActiveGesture | null = null;
  #hoverPoint: Point | null = null;
  #hoverValid = false;
  #spacePressed = false;
  #initialized = false;
  #destroyed = false;
  #resizeObserver: ResizeObserver | null = null;
  #seenEarthquakeSeed: number | null = null;
  #seenEarthquakeEventIds = new Set<string>();
  #earthquakeBursts: EarthquakeBurst[] = [];
  #shakeOffset: Point = { x: 0, y: 0 };

  constructor(host: HTMLElement, callbacks: VillageRendererCallbacks | CommandSink) {
    this.#host = host;
    this.#callbacks = typeof callbacks === "function" ? { onCommand: callbacks } : callbacks;
  }

  async init(): Promise<void> {
    if (this.#initialized) return;
    if (this.#destroyed) throw new Error("Cannot initialize a destroyed VillageRenderer.");

    await this.#app.init({
      resizeTo: this.#host,
      antialias: true,
      autoDensity: true,
      backgroundAlpha: 0,
      powerPreference: "low-power",
    });
    if (this.#destroyed) {
      this.#app.destroy(true, { children: true });
      return;
    }

    this.#app.canvas.setAttribute("aria-hidden", "true");
    this.#app.canvas.style.touchAction = "none";
    this.#host.appendChild(this.#app.canvas);

    this.#terrainLayer.addChild(this.#terrainGraphics);
    this.#roadsLayer.addChild(this.#roadsGraphics);
    this.#structuresLayer.addChild(this.#structuresGraphics);
    this.#hazardsLayer.addChild(this.#hazardsGraphics);
    this.#effectsLayer.addChild(this.#effectsGraphics);
    this.#previewLayer.addChild(this.#previewGraphics);
    this.#worldRoot.addChild(
      this.#terrainLayer,
      this.#roadsLayer,
      this.#structuresLayer,
      this.#hazardsLayer,
      this.#effectsLayer,
      this.#unitsLayer,
      this.#previewLayer,
    );
    this.#worldRoot.eventMode = "static";
    this.#worldRoot.hitArea = new Rectangle(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.#cameraRoot.addChild(this.#worldRoot);
    this.#app.stage.addChild(this.#cameraRoot);

    this.#worldRoot.on("pointerdown", this.#onPointerDown);
    this.#worldRoot.on("globalpointermove", this.#onPointerMove);
    this.#worldRoot.on("pointerup", this.#onPointerUp);
    this.#worldRoot.on("pointerupoutside", this.#onPointerUp);
    this.#worldRoot.on("pointercancel", this.#onPointerUp);
    this.#app.ticker.add(this.#onAnimationTick);
    this.#app.canvas.addEventListener("wheel", this.#onWheel, { passive: false });
    window.addEventListener("pointerdown", this.#onViewportPointerDown);
    window.addEventListener("pointermove", this.#onViewportPointerMove);
    window.addEventListener("pointerup", this.#onViewportPointerUp);
    window.addEventListener("pointercancel", this.#onViewportPointerUp);
    window.addEventListener("keydown", this.#onKeyDown);
    window.addEventListener("keyup", this.#onKeyUp);
    window.addEventListener("blur", this.#onWindowBlur);
    if (typeof ResizeObserver !== "undefined") {
      this.#resizeObserver = new ResizeObserver(this.#onResize);
      this.#resizeObserver.observe(this.#host);
    }

    this.#initialized = true;
    this.#fitInitialCamera();
    if (this.#world) this.#renderLayers(this.#world, this.#ui);
  }

  render(world: WorldReadModel, ui: RendererUiReadModel): void {
    this.#world = world;
    this.#ui = ui;
    if (!this.#initialized || this.#destroyed) return;
    this.#renderLayers(world, ui);
  }

  screenToWorld(point: Point): Point {
    return {
      x: (point.x - this.#camera.x - this.#shakeOffset.x) / this.#camera.scale,
      y: (point.y - this.#camera.y - this.#shakeOffset.y) / this.#camera.scale,
    };
  }

  focus(point: Point): void {
    const viewport = this.#viewportSize();
    this.#setCamera(clampCamera({
      x: viewport.width / 2 - point.x * this.#camera.scale,
      y: viewport.height / 2 - point.y * this.#camera.scale,
      scale: this.#camera.scale,
    }, viewport, { width: WORLD_WIDTH, height: WORLD_HEIGHT }));
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    window.removeEventListener("keydown", this.#onKeyDown);
    window.removeEventListener("keyup", this.#onKeyUp);
    window.removeEventListener("blur", this.#onWindowBlur);
    if (this.#initialized) {
      this.#worldRoot.off("pointerdown", this.#onPointerDown);
      this.#worldRoot.off("globalpointermove", this.#onPointerMove);
      this.#worldRoot.off("pointerup", this.#onPointerUp);
      this.#worldRoot.off("pointerupoutside", this.#onPointerUp);
      this.#worldRoot.off("pointercancel", this.#onPointerUp);
      this.#app.ticker.remove(this.#onAnimationTick);
      this.#app.canvas.removeEventListener("wheel", this.#onWheel);
      window.removeEventListener("pointerdown", this.#onViewportPointerDown);
      window.removeEventListener("pointermove", this.#onViewportPointerMove);
      window.removeEventListener("pointerup", this.#onViewportPointerUp);
      window.removeEventListener("pointercancel", this.#onViewportPointerUp);
      this.#app.destroy(true, { children: true });
    }
    this.#cache.clear();
    this.#villagerNodes.clear();
    this.#hostileNodes.clear();
    this.#completedVillagerDeaths.clear();
    this.#callbacks.onPreview?.(null);
  }

  #renderLayers(world: WorldReadModel, ui: RendererUiReadModel): void {
    if (this.#cache.changed("terrain", world.seed, world.terrainRevision)) {
      drawTerrain(this.#terrainGraphics, world.terrain);
    }
    const roadStructuresChanged = this.#cache.changed("roads-structure", world.seed, world.structureRevision);
    const roadTerrainChanged = this.#cache.changed("roads-terrain", world.seed, world.terrainRevision);
    const roadsChanged = roadStructuresChanged || roadTerrainChanged;
    if (roadsChanged) drawRoads(this.#roadsGraphics, world.activeVillage);

    const decorStructuresChanged = this.#cache.changed("decor", world.seed, world.structureRevision);
    const decorTerrainChanged = this.#cache.changed("decor-terrain", world.seed, world.terrainRevision);
    const structuresChanged = decorStructuresChanged || decorTerrainChanged;
    if (structuresChanged) drawStructures(this.#structuresGraphics, world);

    if (this.#cache.changed("hazards", world.seed, world.hazardRevision)) {
      drawHazards(this.#hazardsGraphics, world);
    }
    this.#trackEarthquakeBursts(world);
    if (this.#cache.changed("units", world.seed, world.unitRevision)) this.#syncUnits(world);

    this.#refreshPreview();
    this.#setCamera(clampCamera(this.#camera, this.#viewportSize(), {
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT,
    }));
    this.#app.canvas.style.cursor = this.#cursorFor(normalizeTool(ui));
  }

  #syncUnits(world: WorldReadModel): void {
    const villagerIds = new Set(world.villagers.map((villager) => villager.id));
    for (const [id, node] of this.#villagerNodes) {
      if (villagerIds.has(id)) continue;
      this.#unitsLayer.removeChild(node.graphic);
      node.graphic.destroy();
      this.#villagerNodes.delete(id);
      this.#completedVillagerDeaths.delete(id);
    }
    for (const villager of world.villagers) {
      const appearance = `${villager.status ?? "idle"}`;
      let node = this.#villagerNodes.get(villager.id);
      if (appearance !== "dead") this.#completedVillagerDeaths.delete(villager.id);
      if (appearance === "dead" && this.#completedVillagerDeaths.has(villager.id)) {
        if (node) {
          this.#unitsLayer.removeChild(node.graphic);
          node.graphic.destroy();
          this.#villagerNodes.delete(villager.id);
        }
        continue;
      }
      if (!node || node.appearance !== appearance) {
        if (node) {
          this.#unitsLayer.removeChild(node.graphic);
          node.graphic.destroy();
        }
        const startsDeathAnimation = villager.status === "dead"
          && node !== undefined
          && node.appearance !== "dead";
        node = {
          graphic: createVillagerGraphic(villager),
          appearance,
          deathOrigin: startsDeathAnimation ? { ...villager.position } : null,
          deathStartedAt: startsDeathAnimation ? performance.now() : null,
        };
        this.#villagerNodes.set(villager.id, node);
        this.#unitsLayer.addChild(node.graphic);
      }
      node.graphic.position.set(villager.position.x, villager.position.y);
    }

    const hostileIds = new Set(world.hostiles.map((hostile) => hostile.id));
    for (const [id, node] of this.#hostileNodes) {
      if (hostileIds.has(id)) continue;
      this.#unitsLayer.removeChild(node.graphic);
      node.graphic.destroy();
      this.#hostileNodes.delete(id);
    }
    for (const hostile of world.hostiles) {
      let node = this.#hostileNodes.get(hostile.id);
      if (!node) {
        node = {
          graphic: createBanditGraphic(hostile),
          appearance: "bandit",
          deathOrigin: null,
          deathStartedAt: null,
        };
        this.#hostileNodes.set(hostile.id, node);
        this.#unitsLayer.addChild(node.graphic);
      }
      node.graphic.position.set(hostile.position.x, hostile.position.y);
    }
  }

  #fitInitialCamera(): void {
    this.#setCamera(fitCameraToWorld(this.#viewportSize(), {
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT,
    }));
  }

  #setCamera(camera: CameraState): void {
    this.#camera = camera;
    this.#applyCameraTransform();
  }

  #applyCameraTransform(): void {
    this.#cameraRoot.position.set(this.#camera.x + this.#shakeOffset.x, this.#camera.y + this.#shakeOffset.y);
    this.#cameraRoot.scale.set(this.#camera.scale);
  }

  #viewportSize(): { width: number; height: number } {
    if (this.#initialized) {
      return { width: this.#app.renderer.screen.width, height: this.#app.renderer.screen.height };
    }
    return { width: Math.max(1, this.#host.clientWidth), height: Math.max(1, this.#host.clientHeight) };
  }

  #dispatch(commands: readonly WorldCommand[]): void {
    for (const command of commands) this.#callbacks.onCommand(command);
  }

  #worldPoint(event: FederatedPointerEvent): Point {
    return clampWorldPoint(this.screenToWorld({ x: event.global.x, y: event.global.y }));
  }

  #onPointerDown = (event: FederatedPointerEvent): void => {
    if (!this.#world || this.#gesture) return;
    const screen = { x: event.global.x, y: event.global.y };
    const tool = normalizeTool(this.#ui);
    this.#capturePointer(event.pointerId);

    if (shouldStartViewportPan({
      tool,
      button: event.button,
      spacePressed: this.#spacePressed,
      panOverride: this.#ui.panOverride === true,
    })) {
      this.#gesture = {
        kind: "pan",
        value: { pointerId: event.pointerId, startScreen: screen, startCamera: this.#camera },
      };
      return;
    }

    const started = beginCommandGesture(tool, this.#worldPoint(event), normalizeBrushRadius(this.#ui));
    this.#dispatch(started.commands);
    this.#gesture = { kind: "tool", value: { pointerId: event.pointerId, command: started.session } };
  };

  #onPointerMove = (event: FederatedPointerEvent): void => {
    const rawPoint = this.screenToWorld({ x: event.global.x, y: event.global.y });
    this.#hoverPoint = clampWorldPoint(rawPoint);
    this.#hoverValid = this.#placementIsValid(normalizeTool(this.#ui), rawPoint);
    this.#refreshPreview();

    if (!this.#gesture || this.#gesture.value.pointerId !== event.pointerId) return;
    if (this.#gesture.kind === "pan") {
      const pan = this.#gesture.value;
      this.#setCamera(clampCamera({
        x: pan.startCamera.x + event.global.x - pan.startScreen.x,
        y: pan.startCamera.y + event.global.y - pan.startScreen.y,
        scale: pan.startCamera.scale,
      }, this.#viewportSize(), { width: WORLD_WIDTH, height: WORLD_HEIGHT }));
      return;
    }

    const moved = moveCommandGesture(this.#gesture.value.command, this.#worldPoint(event));
    this.#dispatch(moved.commands);
    this.#gesture = {
      kind: "tool",
      value: { pointerId: event.pointerId, command: moved.session },
    };
  };

  #onPointerUp = (event: FederatedPointerEvent): void => {
    if (!this.#gesture || this.#gesture.value.pointerId !== event.pointerId) return;
    if (this.#gesture.kind === "tool") {
      this.#dispatch(endCommandGesture(this.#gesture.value.command, this.#worldPoint(event)).commands);
    }
    this.#gesture = null;
    this.#releasePointer(event.pointerId);
  };

  #onViewportPointerDown = (event: PointerEvent): void => {
    if (!this.#world || this.#gesture) return;
    if (isInteractiveControl(event.target)) return;
    const tool = normalizeTool(this.#ui);
    if (!shouldStartViewportPan({
      tool,
      button: event.button,
      spacePressed: this.#spacePressed,
      panOverride: this.#ui.panOverride === true,
    })) return;

    this.#gesture = {
      kind: "pan",
      value: {
        pointerId: event.pointerId,
        startScreen: this.#viewportPoint(event),
        startCamera: this.#camera,
      },
    };
    this.#captureHostPointer(event.pointerId);
  };

  #onViewportPointerMove = (event: PointerEvent): void => {
    if (!this.#gesture || this.#gesture.kind !== "pan" || this.#gesture.value.pointerId !== event.pointerId) return;
    const point = this.#viewportPoint(event);
    const pan = this.#gesture.value;
    this.#setCamera(clampCamera({
      x: pan.startCamera.x + point.x - pan.startScreen.x,
      y: pan.startCamera.y + point.y - pan.startScreen.y,
      scale: pan.startCamera.scale,
    }, this.#viewportSize(), { width: WORLD_WIDTH, height: WORLD_HEIGHT }));
  };

  #onViewportPointerUp = (event: PointerEvent): void => {
    if (!this.#gesture || this.#gesture.kind !== "pan" || this.#gesture.value.pointerId !== event.pointerId) return;
    this.#gesture = null;
    this.#releaseHostPointer(event.pointerId);
  };

  #onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const bounds = this.#app.canvas.getBoundingClientRect();
    const viewport = this.#viewportSize();
    const cursor = {
      x: (event.clientX - bounds.left) * viewport.width / Math.max(1, bounds.width),
      y: (event.clientY - bounds.top) * viewport.height / Math.max(1, bounds.height),
    };
    const zoomed = zoomCameraAt(this.#camera, cursor, this.#camera.scale * Math.exp(-event.deltaY * 0.0015));
    this.#setCamera(clampCamera(zoomed, viewport, { width: WORLD_WIDTH, height: WORLD_HEIGHT }));
    this.#refreshPreview();
  };

  #viewportPoint(event: PointerEvent): Point {
    const bounds = this.#app.canvas.getBoundingClientRect();
    const viewport = this.#viewportSize();
    return {
      x: (event.clientX - bounds.left) * viewport.width / Math.max(1, bounds.width),
      y: (event.clientY - bounds.top) * viewport.height / Math.max(1, bounds.height),
    };
  }

  #onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === "Space" && !isFormControl(event.target)) this.#spacePressed = true;
  };

  #onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === "Space") this.#spacePressed = false;
  };

  #onWindowBlur = (): void => {
    this.#spacePressed = false;
    this.#gesture = null;
  };

  #onResize = (): void => {
    if (!this.#initialized) return;
    this.#setCamera(clampCamera(this.#camera, this.#viewportSize(), {
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT,
    }));
  };

  #trackEarthquakeBursts(world: WorldReadModel): void {
    if (this.#seenEarthquakeSeed !== world.seed) {
      this.#seenEarthquakeSeed = world.seed;
      this.#seenEarthquakeEventIds = new Set<string>();
      this.#earthquakeBursts = [];
      this.#effectsGraphics.clear();
      this.#shakeOffset = { x: 0, y: 0 };
      this.#applyCameraTransform();
    }

    const newEventIds = findNewEarthquakeEventIds(world.events, this.#seenEarthquakeEventIds);
    for (const event of world.events) {
      if (event.type === "earthquake") this.#seenEarthquakeEventIds.add(event.id);
    }
    if (newEventIds.length === 0) return;

    const now = performance.now();
    const eventsById = new Map(world.events.map((event) => [event.id, event]));
    for (const id of newEventIds) {
      const event = eventsById.get(id);
      if (event?.type !== "earthquake") continue;
      this.#earthquakeBursts.push({ id, origin: event.origin, startedAt: now });
    }
  }

  #onAnimationTick = (): void => {
    const now = performance.now();
    this.#animateVillagerDeaths(now);
    if (this.#earthquakeBursts.length === 0) return;

    const activeBursts: EarthquakeBurst[] = [];
    let strongestShake = 0;
    this.#effectsGraphics.clear();

    for (const burst of this.#earthquakeBursts) {
      const progress = Math.max(0, Math.min(1, (now - burst.startedAt) / EARTHQUAKE_RUMBLE_MS));
      if (progress < 1) {
        activeBursts.push(burst);
        strongestShake = Math.max(strongestShake, 1 - progress);
      }
      drawEarthquakeBurst(this.#effectsGraphics, burst, progress);
    }

    this.#earthquakeBursts = activeBursts;
    if (activeBursts.length === 0) {
      this.#effectsGraphics.clear();
      this.#shakeOffset = { x: 0, y: 0 };
      this.#applyCameraTransform();
      return;
    }

    const amplitude = EARTHQUAKE_SHAKE_PX * strongestShake;
    this.#shakeOffset = {
      x: Math.sin(now * 0.086) * amplitude,
      y: Math.cos(now * 0.12) * amplitude * 0.55,
    };
    this.#applyCameraTransform();
  };

  #animateVillagerDeaths(now: number): void {
    for (const [id, node] of this.#villagerNodes) {
      if (node.deathStartedAt === null || node.deathOrigin === null) continue;
      const frame = getVillagerDeathAnimationFrame(node.deathStartedAt, now);
      node.graphic.position.set(node.deathOrigin.x, node.deathOrigin.y + frame.offsetY);
      node.graphic.alpha = frame.alpha;
      if (!frame.complete) continue;
      this.#unitsLayer.removeChild(node.graphic);
      node.graphic.destroy();
      this.#villagerNodes.delete(id);
      this.#completedVillagerDeaths.add(id);
    }
  }

  #capturePointer(pointerId: number): void {
    try {
      this.#app.canvas.setPointerCapture(pointerId);
    } catch {
      // Pixi's global events still preserve the gesture in older embedded webviews.
    }
  }

  #releasePointer(pointerId: number): void {
    try {
      if (this.#app.canvas.hasPointerCapture(pointerId)) this.#app.canvas.releasePointerCapture(pointerId);
    } catch {
      // The browser may already have released capture after pointercancel.
    }
  }

  #captureHostPointer(pointerId: number): void {
    try {
      this.#host.setPointerCapture(pointerId);
    } catch {
      // Pointer capture is best-effort; normal viewport events still update the pan.
    }
  }

  #releaseHostPointer(pointerId: number): void {
    try {
      if (this.#host.hasPointerCapture(pointerId)) this.#host.releasePointerCapture(pointerId);
    } catch {
      // The browser may already have released capture after pointercancel.
    }
  }

  #placementIsValid(tool: RendererTool, point: Point): boolean {
    const world = this.#world;
    if (!world || !pointInWorld(point)) return false;
    if (typeof this.#ui.placementValid === "boolean") return this.#ui.placementValid;
    if (this.#callbacks.validatePlacement) return this.#callbacks.validatePlacement(tool, point, world);
    if (tool === "land" || tool === "water" || tool === "pan") return true;
    const cellX = Math.floor(point.x / CELL_SIZE);
    const cellY = Math.floor(point.y / CELL_SIZE);
    const land = world.terrain[cellY * GRID_WIDTH + cellX] === TERRAIN_LAND;
    if (tool === "tsunami") return !land;
    if (!land) return false;
    if (tool === "plague") {
      return world.villagers.some((villager) =>
        villager.status !== "dead"
        && Math.hypot(villager.position.x - point.x, villager.position.y - point.y) <= PLAGUE_INITIAL_RADIUS);
    }
    return true;
  }

  #refreshPreview(): void {
    const tool = normalizeTool(this.#ui);
    drawPreview(this.#previewGraphics, tool, this.#hoverPoint, normalizeBrushRadius(this.#ui), this.#hoverValid);
    this.#callbacks.onPreview?.(this.#hoverPoint ? {
      tool,
      point: this.#hoverPoint,
      valid: this.#hoverValid,
    } : null);
  }

  #cursorFor(tool: RendererTool): string {
    if (this.#spacePressed || this.#ui.panOverride || tool === "pan") return this.#gesture ? "grabbing" : "grab";
    return "crosshair";
  }
}

function normalizeTool(ui: RendererUiReadModel): RendererTool {
  const raw = ui.tool ?? ui.activeTool ?? ui.selectedTool ?? "pan";
  const aliases: Record<string, RendererTool> = {
    paint_land: "land",
    paint_water: "water",
    place_totem: "totem",
    trigger_fire: "fire",
    trigger_tsunami: "tsunami",
    trigger_bandits: "bandits",
    trigger_earthquake: "earthquake",
    trigger_plague: "plague",
  };
  const normalized = aliases[raw] ?? raw;
  return isRendererTool(normalized) ? normalized : "pan";
}

function isRendererTool(value: string): value is RendererTool {
  return ["land", "water", "totem", "fire", "tsunami", "bandits", "earthquake", "plague", "pan"].includes(value);
}

function normalizeBrushRadius(ui: RendererUiReadModel): number {
  const value = ui.brushRadius ?? ui.brushSize ?? 30;
  return Math.max(1, Math.min(160, Number.isFinite(value) ? value : 30));
}

function pointInWorld(point: Point): boolean {
  return point.x >= 0 && point.y >= 0 && point.x < WORLD_WIDTH && point.y < WORLD_HEIGHT;
}

function clampWorldPoint(point: Point): Point {
  return {
    x: Math.min(WORLD_WIDTH - Number.EPSILON, Math.max(0, point.x)),
    y: Math.min(WORLD_HEIGHT - Number.EPSILON, Math.max(0, point.y)),
  };
}

function isFormControl(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

function isInteractiveControl(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest("button,input,select,textarea,[contenteditable='true']") !== null;
}

function drawEarthquakeBurst(graphics: Graphics, burst: EarthquakeBurst, progress: number): void {
  const eased = easeOutCubic(progress);
  const alpha = Math.max(0, 1 - progress);
  const ringRadius = 20 + eased * 90;

  graphics.circle(burst.origin.x, burst.origin.y, ringRadius).stroke({
    color: palette.outline,
    width: 2.5,
    alpha: alpha * 0.46,
  });

  for (let index = 0; index < 5; index += 1) {
    const angle = seededAngle(burst.id, index);
    const inner = 10 + index * 4;
    const outer = 36 + eased * (34 + index * 3);
    const start = offsetPoint(burst.origin, angle, inner);
    const end = offsetPoint(burst.origin, angle + Math.sin(index) * 0.16, outer);
    graphics
      .moveTo(start.x, start.y)
      .lineTo(end.x, end.y)
      .stroke({ color: palette.pit, width: 2, alpha: alpha * 0.62, cap: "round" });
  }

  for (let index = 0; index < EARTHQUAKE_PARTICLE_COUNT; index += 1) {
    const angle = seededAngle(burst.id, index + 11);
    const distance = 14 + eased * (34 + seededUnit(burst.id, index + 29) * 58);
    const point = offsetPoint(burst.origin, angle, distance);
    const size = 2.4 + seededUnit(burst.id, index + 47) * 3.8;
    graphics.circle(point.x, point.y, size).fill({ color: palette.ruin, alpha: alpha * 0.72 });
  }
}

function easeOutCubic(value: number): number {
  return 1 - Math.pow(1 - value, 3);
}

function offsetPoint(origin: Point, angle: number, distance: number): Point {
  return {
    x: origin.x + Math.cos(angle) * distance,
    y: origin.y + Math.sin(angle) * distance,
  };
}

function seededAngle(seed: string, salt: number): number {
  return seededUnit(seed, salt) * Math.PI * 2;
}

function seededUnit(seed: string, salt: number): number {
  let hash = Math.imul(salt + 1, 0x45d9f3b);
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 0x45d9f3b);
  }
  return ((hash >>> 0) % 10_000) / 10_000;
}
