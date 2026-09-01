import { Graphics } from "pixi.js";

import {
  CELL_SIZE,
  GRID_HEIGHT,
  GRID_WIDTH,
  TERRAIN_LAND,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from "../engine/constants";
import type {
  Cell,
  DeepReadonly,
  FireCell,
  Hostile,
  Point,
  VillageState,
  Villager,
  WorldReadModel,
} from "../engine/types";
import type { RendererTool } from "./interaction";
import { palette } from "./palette";

const outline = { color: palette.outline, width: 2, cap: "round", join: "round" } as const;
const softOutline = { color: palette.outlineSoft, width: 1.5, cap: "round", join: "round" } as const;
const FIRE_MESH_RADIUS_CELLS = 2;
const FIRE_MESH_MIN_INTENSITY_SCALE = 0.46;
const STONE_DECOR_COUNT = 22;
const STONE_DECOR_ATTEMPTS = 64;
const TREE_DECOR_COUNT = 12;
const TREE_DECOR_ATTEMPTS = 128;
const TREE_DECOR_SEED_SALT = 0x9e3779b9;
const TREE_DECOR_MIN_DISTANCE = 42;

export function drawTerrain(graphics: Graphics, terrain: readonly number[]): void {
  graphics.clear().rect(0, 0, WORLD_WIDTH, WORLD_HEIGHT).fill(palette.water);

  for (let y = 0; y < GRID_HEIGHT; y += 1) {
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      if (!isLandCell(terrain, x, y)) continue;
      graphics
        .rect(x * CELL_SIZE - 2.5, y * CELL_SIZE - 2.5, CELL_SIZE + 5, CELL_SIZE + 5)
        .fill(palette.shore);
    }
  }

  for (let y = 0; y < GRID_HEIGHT; y += 1) {
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      if (!isLandCell(terrain, x, y)) continue;
      const left = x * CELL_SIZE;
      const top = y * CELL_SIZE;
      graphics
        .rect(left - 0.65, top - 0.65, CELL_SIZE + 1.3, CELL_SIZE + 1.3)
        .fill(palette.grass);

      const variant = terrainFacetVariant(x, y);
      if (variant === 0) {
        graphics
          .poly([
            left - 0.65, top - 0.65,
            left + CELL_SIZE + 0.65, top - 0.65,
            left - 0.65, top + CELL_SIZE + 0.65,
          ], true)
          .fill({ color: palette.grassLight, alpha: 0.13 });
      } else if (variant === 1) {
        graphics
          .poly([
            left + CELL_SIZE + 0.65, top - 0.65,
            left + CELL_SIZE + 0.65, top + CELL_SIZE + 0.65,
            left - 0.65, top + CELL_SIZE + 0.65,
          ], true)
          .fill({ color: palette.grassDark, alpha: 0.1 });
      }
    }
  }

  for (let y = 0; y < GRID_HEIGHT; y += 1) {
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      if (!isLandCell(terrain, x, y)) continue;
      drawShoreEdge(graphics, terrain, x, y);
    }
  }
}

function isLandCell(terrain: readonly number[], x: number, y: number): boolean {
  return x >= 0
    && y >= 0
    && x < GRID_WIDTH
    && y < GRID_HEIGHT
    && terrain[y * GRID_WIDTH + x] === TERRAIN_LAND;
}

function terrainFacetVariant(x: number, y: number): 0 | 1 | 2 {
  const hash = Math.imul(x + 17, 73_856_093) ^ Math.imul(y + 31, 19_349_663);
  return (hash >>> 0) % 5 === 0 ? 0 : (hash >>> 0) % 7 === 0 ? 1 : 2;
}

function drawShoreEdge(graphics: Graphics, terrain: readonly number[], x: number, y: number): void {
  const left = x * CELL_SIZE;
  const right = left + CELL_SIZE;
  const top = y * CELL_SIZE;
  const bottom = top + CELL_SIZE;
  const edges: readonly [Point, Point][] = [
    [{ x: left, y: top }, { x: right, y: top }],
    [{ x: right, y: top }, { x: right, y: bottom }],
    [{ x: right, y: bottom }, { x: left, y: bottom }],
    [{ x: left, y: bottom }, { x: left, y: top }],
  ];
  const neighbors: readonly [number, number][] = [
    [x, y - 1],
    [x + 1, y],
    [x, y + 1],
    [x - 1, y],
  ];

  for (let index = 0; index < edges.length; index += 1) {
    const [neighborX, neighborY] = neighbors[index]!;
    if (isLandCell(terrain, neighborX, neighborY)) continue;
    const [start, end] = edges[index]!;
    strokePath(graphics, [start, end], { color: palette.shore, width: 3.5, alpha: 0.82 });
    strokePath(graphics, [start, end], { color: palette.outlineSoft, width: 1.25, alpha: 0.72 });
  }
}

export function drawRoads(graphics: Graphics, village: DeepReadonly<VillageState> | null): void {
  graphics.clear();
  if (!village) return;

  for (const road of village.roads) {
    strokePath(graphics, road.points, {
      color: road.damaged ? palette.outlineSoft : palette.dirt,
      width: road.role === "spine" ? 18 : road.role === "entrance" ? 15 : 12,
    });
  }
  for (const bridge of village.bridges) drawBridge(graphics, bridge.start, bridge.end);
}

export function drawStructures(
  graphics: Graphics,
  world: Pick<WorldReadModel, "seed" | "terrain" | "trees" | "activeVillage">,
): void {
  graphics.clear();

  const stones = stoneDecor(world.seed, world.terrain);
  const occupiedByTrees = world.trees.map((tree) => tree.position);
  const trees = treeDecor(world.seed, world.terrain, [...stones, ...occupiedByTrees]);

  for (const point of stones) drawStone(graphics, point);
  for (const point of trees) drawTree(graphics, point);
  for (const tree of world.trees) drawTree(graphics, tree.position);

  const village = world.activeVillage;
  if (!village) return;
  drawWall(graphics, village);
  if (village.anchorDestroyed !== true) drawMonument(graphics, village.anchor);
  else drawMonumentRuin(graphics, village.anchor, village.anchorRebuildProgress ?? 0);
  for (const house of village.houses) drawHouse(graphics, house);
}

export function drawHazards(
  graphics: Graphics,
  world: Pick<WorldReadModel, "fires" | "tsunamis" | "pits" | "terrain">,
): void {
  graphics.clear();
  for (const fires of groupActiveFires(world.fires)) drawFireMesh(graphics, fires, world.terrain);
  for (const tsunami of world.tsunamis) {
    const angle = Math.atan2(tsunami.direction.y, tsunami.direction.x) + Math.PI / 2;
    drawTsunami(graphics, tsunami.position, tsunami.width, angle);
  }
  for (const pit of world.pits) drawPit(graphics, pit.position, pit.radius);
}

export function createVillagerGraphic(villager: DeepReadonly<Villager>): Graphics {
  const graphics = new Graphics();
  const dead = villager.status === "dead";
  graphics.ellipse(1, 11, 10, 3.5).fill(palette.shadow);
  graphics.roundRect(-8, -1, 16, 18, 8).fill(dead ? palette.outlineSoft : palette.villager).stroke(softOutline);
  graphics.circle(0, -7, 7).fill(dead ? palette.stone : palette.villagerHead).stroke(softOutline);
  if (villager.status === "sick") {
    graphics.circle(0, 2, 15).stroke({ color: palette.plague, width: 2, alpha: 0.9 });
  }
  if (villager.status === "trapped") {
    graphics.circle(0, 4, 13).stroke({ color: palette.invalid, width: 2, alpha: 0.9 });
  }
  return graphics;
}

export function createBanditGraphic(_hostile: DeepReadonly<Hostile>): Graphics {
  return new Graphics()
    .ellipse(1, 10, 10, 3.5)
    .fill(palette.shadow)
    .roundRect(-9, -2, 18, 18, 6)
    .fill(palette.bandit)
    .stroke(outline)
    .poly([-10, -5, -4, -15, 0, -8, 5, -15, 10, -5], true)
    .fill(palette.bandit)
    .stroke(outline);
}

export function drawPreview(
  graphics: Graphics,
  tool: RendererTool,
  point: Point | null,
  radius: number,
  valid: boolean,
): void {
  graphics.clear();
  if (!point || tool === "pan") return;
  const color = valid ? palette.valid : palette.invalid;
  const previewRadius = tool === "land" || tool === "water" ? radius : tool === "earthquake" ? 120 : 24;
  graphics.circle(point.x, point.y, previewRadius).fill({ color, alpha: 0.16 }).stroke({ color, width: 2, alpha: 0.9 });
  if (tool === "totem") drawMonument(graphics, point, 0.55);
}

function strokePath(
  graphics: Graphics,
  points: readonly Point[],
  style: { color: string; width: number; alpha?: number },
): void {
  if (points.length < 2) return;
  graphics.moveTo(points[0]!.x, points[0]!.y);
  for (let index = 1; index < points.length; index += 1) {
    graphics.lineTo(points[index]!.x, points[index]!.y);
  }
  graphics.stroke({ ...style, cap: "round", join: "round" });
}

function drawBridge(graphics: Graphics, start: Point, end: Point): void {
  strokePath(graphics, [start, end], { color: palette.bridge, width: 20 });
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const nx = -dy / length;
  const ny = dx / length;
  for (const ratio of [0.2, 0.4, 0.6, 0.8]) {
    const x = start.x + dx * ratio;
    const y = start.y + dy * ratio;
    strokePath(graphics, [{ x: x - nx * 9, y: y - ny * 9 }, { x: x + nx * 9, y: y + ny * 9 }], {
      color: palette.outlineSoft,
      width: 2,
    });
  }
}

function drawWall(graphics: Graphics, village: DeepReadonly<VillageState>): void {
  for (const segment of village.wall.segments) {
    const points = [segment.start, segment.end];
    if (segment.destroyed === true) {
      strokePath(graphics, points, { color: palette.shadow, width: 17, alpha: 0.5 });
      strokePath(graphics, points, { color: palette.ruin, width: 6, alpha: 0.72 });
      const center = midpoint(segment.start, segment.end);
      drawRebuildProgress(graphics, center, segment.rebuildProgress ?? 0);
      continue;
    }
    strokePath(graphics, points, { color: palette.shadow, width: 21 });
    strokePath(graphics, points, { color: palette.wall, width: 15 });
    strokePath(graphics, points, { color: palette.wallHighlight, width: 4 });
  }
}

function drawHouse(graphics: Graphics, house: DeepReadonly<VillageState["houses"][number]>): void {
  const point = house.position;
  if (house.destroyed === true || (house.health ?? 100) < 100) {
    drawHouseRuin(graphics, point, house.rebuildProgress ?? (house.health ?? 0) / 100);
    return;
  }
  const x = point.x;
  const y = point.y;
  graphics.ellipse(x + 3, y + 26, 30, 7).fill(palette.shadow);
  graphics.roundRect(x - 22, y - 7, 44, 40, 7).fill(palette.house).stroke(outline);
  graphics.roundRect(x - 7, y + 12, 14, 21, 4).fill(palette.houseLight).stroke(softOutline);
  graphics.poly([x - 29, y - 7, x, y - 35, x + 29, y - 7], true).fill(palette.roof).stroke(outline);
  graphics.circle(x + 14, y - 13, 3.5).fill(palette.roofDark);
}

function drawHouseRuin(graphics: Graphics, point: Point, progress: number): void {
  const x = point.x;
  const y = point.y;
  graphics.ellipse(x + 3, y + 23, 29, 6).fill(palette.shadow);
  graphics.poly([
    x - 23, y + 21,
    x - 10, y - 1,
    x + 3, y + 16,
    x + 18, y - 5,
    x + 25, y + 21,
  ]).fill(palette.ruin).stroke(softOutline);
  graphics.rect(x - 18, y + 13, 36 * Math.max(0, Math.min(1, progress)), 5)
    .fill(palette.rebuild);
}

function drawRebuildProgress(graphics: Graphics, point: Point, progress: number): void {
  const clamped = Math.max(0, Math.min(1, progress));
  graphics.circle(point.x, point.y, 8).fill({ color: palette.paper, alpha: 0.75 }).stroke(softOutline);
  graphics.rect(point.x - 5, point.y - 2, 10 * clamped, 4).fill(palette.rebuild);
}

function drawMonumentRuin(graphics: Graphics, point: Point, progress: number): void {
  const x = point.x;
  const y = point.y;
  graphics.ellipse(x + 1, y + 29, 19, 5).fill(palette.shadow);
  graphics.poly([
    x - 16, y + 26,
    x - 8, y + 4,
    x + 2, y + 17,
    x + 11, y - 7,
    x + 18, y + 26,
  ]).fill(palette.ruin).stroke(outline);
  drawRebuildProgress(graphics, { x, y: y + 18 }, progress);
}

function drawMonument(graphics: Graphics, point: Point, scale = 1): void {
  const x = point.x;
  const y = point.y;
  graphics.ellipse(x + scale, y + 30 * scale, 20 * scale, 5 * scale).fill(palette.shadow);
  graphics.roundRect(x - 19 * scale, y + 16 * scale, 38 * scale, 15 * scale, 7 * scale).fill(palette.monumentBase).stroke(outline);
  graphics
    .poly([
      x - 11 * scale, y + 17 * scale,
      x - 8 * scale, y - 35 * scale,
      x, y - 49 * scale,
      x + 8 * scale, y - 35 * scale,
      x + 11 * scale, y + 17 * scale,
    ], true)
    .fill(palette.monument)
    .stroke(outline);
  graphics.roundRect(x - 5 * scale, y - 21 * scale, 10 * scale, 20 * scale, 4 * scale).fill(palette.monumentInset);
}

function drawTree(graphics: Graphics, point: Point): void {
  const { x, y } = point;
  graphics.ellipse(x + 1, y + 22, 20, 6).fill(palette.shadow);
  graphics.roundRect(x - 5, y + 6, 10, 23, 4).fill(palette.trunk).stroke(softOutline);
  for (const [dx, dy, radius] of [[-12, -1, 15], [9, -6, 17], [0, -21, 18], [2, 5, 17]] as const) {
    graphics.circle(x + dx, y + dy, radius).fill(palette.tree);
  }
  graphics.circle(x - 7, y - 13, 6).fill(palette.treeLight);
}

function drawStone(graphics: Graphics, point: Point): void {
  graphics.ellipse(point.x + 1, point.y + 8, 14, 4).fill(palette.shadow);
  graphics
    .poly([
      point.x - 14, point.y + 6,
      point.x - 10, point.y - 7,
      point.x + 2, point.y - 11,
      point.x + 14, point.y - 4,
      point.x + 12, point.y + 7,
      point.x - 2, point.y + 10,
    ], true)
    .fill(palette.stone)
    .stroke(softOutline);
}

function groupActiveFires(fires: readonly DeepReadonly<FireCell>[]): DeepReadonly<FireCell>[][] {
  const groups = new Map<string, DeepReadonly<FireCell>[]>();
  for (const fire of fires) {
    if (fire.intensity <= 0) continue;
    const group = groups.get(fire.eventId);
    if (group) group.push(fire);
    else groups.set(fire.eventId, [fire]);
  }
  return [...groups.values()].map((group) =>
    group.sort((first, second) =>
      first.cell.y - second.cell.y
      || first.cell.x - second.cell.x
      || first.id.localeCompare(second.id)));
}

function drawFireMesh(
  graphics: Graphics,
  fires: readonly DeepReadonly<FireCell>[],
  terrain: readonly number[],
): void {
  const polygons = fireMeshPolygons(fires, terrain);
  for (const polygon of polygons) {
    if (polygon.length < 3) continue;
    const organic = organicFireBoundary(polygon);
    drawClosedSoftPath(graphics, organic);
  }
}

function fireMeshPolygons(
  fires: readonly DeepReadonly<FireCell>[],
  terrain: readonly number[],
): Point[][] {
  const meshCells = fireMeshCells(fires, terrain);
  return traceCellPolygons(meshCells);
}

function fireMeshCells(fires: readonly DeepReadonly<FireCell>[], terrain: readonly number[]): Set<string> {
  const cells = new Set<string>();
  for (const fire of fires) {
    const intensityScale = Math.max(FIRE_MESH_MIN_INTENSITY_SCALE, Math.min(1, fire.intensity / 100));
    const radiusCells = Math.max(1, Math.ceil(FIRE_MESH_RADIUS_CELLS * intensityScale));
    for (let dy = -radiusCells; dy <= radiusCells; dy += 1) {
      for (let dx = -radiusCells; dx <= radiusCells; dx += 1) {
        if (Math.hypot(dx, dy) > radiusCells + 0.2) continue;
        const cell = { x: fire.cell.x + dx, y: fire.cell.y + dy };
        if (isLandCell(terrain, cell.x, cell.y)) cells.add(cellKey(cell));
      }
    }
  }
  if (cells.size === 0) {
    for (const fire of fires) cells.add(cellKey(fire.cell));
  }
  return cells;
}

function traceCellPolygons(cells: ReadonlySet<string>): Point[][] {
  const edges = new Map<string, { start: Point; end: Point }[]>();
  const addEdge = (start: Point, end: Point): void => {
    const key = pointKey(start);
    const bucket = edges.get(key);
    if (bucket) bucket.push({ start, end });
    else edges.set(key, [{ start, end }]);
  };

  for (const key of [...cells].sort()) {
    const cell = parseCellKey(key);
    const left = cell.x * CELL_SIZE;
    const right = left + CELL_SIZE;
    const top = cell.y * CELL_SIZE;
    const bottom = top + CELL_SIZE;
    if (!cells.has(cellKey({ x: cell.x, y: cell.y - 1 }))) addEdge({ x: left, y: top }, { x: right, y: top });
    if (!cells.has(cellKey({ x: cell.x + 1, y: cell.y }))) addEdge({ x: right, y: top }, { x: right, y: bottom });
    if (!cells.has(cellKey({ x: cell.x, y: cell.y + 1 }))) addEdge({ x: right, y: bottom }, { x: left, y: bottom });
    if (!cells.has(cellKey({ x: cell.x - 1, y: cell.y }))) addEdge({ x: left, y: bottom }, { x: left, y: top });
  }

  const polygons: Point[][] = [];
  while (edges.size > 0) {
    const firstEntry = edges.entries().next().value as [string, { start: Point; end: Point }[]] | undefined;
    if (!firstEntry) break;
    const [firstKey, firstBucket] = firstEntry;
    const first = firstBucket?.shift();
    if (!first) break;
    if (firstBucket.length === 0) edges.delete(firstKey);

    const polygon = [first.start, first.end];
    let current = first.end;
    while (pointKey(current) !== pointKey(first.start)) {
      const currentKey = pointKey(current);
      const bucket = edges.get(currentKey);
      if (!bucket) break;
      const edge = bucket.shift();
      if (!edge) break;
      if (bucket.length === 0) edges.delete(currentKey);
      current = edge.end;
      polygon.push(current);
    }
    if (polygon.length > 3) polygons.push(removeDuplicateClosingPoint(polygon));
  }

  return polygons.sort((first, second) => polygonArea(second) - polygonArea(first));
}

function organicFireBoundary(points: readonly Point[]): Point[] {
  const center = points.reduce(
    (total, point) => ({ x: total.x + point.x / points.length, y: total.y + point.y / points.length }),
    { x: 0, y: 0 },
  );
  return points.map((point) => {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const wobble = deterministicWobble(point.x, point.y) * 2.6;
    return {
      x: point.x + (dx / length) * wobble,
      y: point.y + (dy / length) * wobble,
    };
  });
}

function drawClosedSoftPath(graphics: Graphics, points: readonly Point[]): void {
  const first = midpoint(points[points.length - 1]!, points[0]!);
  graphics.moveTo(first.x, first.y);
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    const next = points[(index + 1) % points.length]!;
    const mid = midpoint(point, next);
    graphics.quadraticCurveTo(point.x, point.y, mid.x, mid.y);
  }
  graphics
    .fill({ color: palette.fire, alpha: 0.34 })
    .stroke({ color: palette.fire, width: 3.5, alpha: 0.94, cap: "round", join: "round" });
}

function midpoint(first: Point, second: Point): Point {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function removeDuplicateClosingPoint(points: readonly Point[]): Point[] {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return pointKey(first) === pointKey(last) ? points.slice(0, -1) : [...points];
}

function polygonArea(points: readonly Point[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area) / 2;
}

function deterministicWobble(x: number, y: number): number {
  const hash = Math.imul(Math.round(x) + 23, 73_856_093) ^ Math.imul(Math.round(y) + 41, 19_349_663);
  return ((hash >>> 0) % 1_000) / 500 - 1;
}

function cellKey(cell: Cell): string {
  return `${cell.x},${cell.y}`;
}

function parseCellKey(key: string): Cell {
  const [x, y] = key.split(",").map(Number);
  return { x: x ?? 0, y: y ?? 0 };
}

function pointKey(point: Point): string {
  return `${point.x},${point.y}`;
}

function drawTsunami(graphics: Graphics, point: Point, width: number, rotation: number): void {
  const half = width / 2;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const transform = (x: number, y: number): Point => ({
    x: point.x + x * cosine - y * sine,
    y: point.y + x * sine + y * cosine,
  });
  const start = transform(-half, 18);
  const cp1 = transform(-half * 0.45, -18);
  const cp2 = transform(half * 0.25, -22);
  const end = transform(half, 14);
  graphics.moveTo(start.x, start.y).bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, end.x, end.y).stroke({
    color: palette.waterWash,
    width: 48,
    cap: "round",
  });
  graphics.moveTo(start.x, start.y - 8).bezierCurveTo(cp1.x, cp1.y - 8, cp2.x, cp2.y - 8, end.x, end.y - 8).stroke({
    color: palette.tsunami,
    width: 32,
    cap: "round",
  });
  graphics.moveTo(start.x, start.y - 18).bezierCurveTo(cp1.x, cp1.y - 18, cp2.x, cp2.y - 18, end.x, end.y - 18).stroke({
    color: palette.tsunamiCrest,
    width: 5,
    cap: "round",
  });
}

function drawPit(graphics: Graphics, point: Point, radius: number): void {
  graphics.ellipse(point.x, point.y, radius, radius * 0.62).fill({ color: palette.pit, alpha: 0.65 }).stroke({
    color: palette.outline,
    width: 2,
  });
  graphics.ellipse(point.x - radius * 0.16, point.y - radius * 0.12, radius * 0.42, radius * 0.18).stroke({
    color: palette.outlineSoft,
    width: 2,
  });
}

export function stoneDecor(seed: number, terrain: ArrayLike<number>): Point[] {
  return seededDecorPoints(seed, terrain, STONE_DECOR_COUNT, STONE_DECOR_ATTEMPTS);
}

export function treeDecor(
  seed: number,
  terrain: ArrayLike<number>,
  blockedPoints: readonly Point[],
): Point[] {
  return seededDecorPoints(
    (seed ^ TREE_DECOR_SEED_SALT) >>> 0,
    terrain,
    TREE_DECOR_COUNT,
    TREE_DECOR_ATTEMPTS,
    blockedPoints,
    TREE_DECOR_MIN_DISTANCE,
  );
}

function seededDecorPoints(
  seed: number,
  terrain: ArrayLike<number>,
  maximumPoints: number,
  maximumAttempts: number,
  blockedPoints: readonly Point[] = [],
  minimumDistance = 0,
): Point[] {
  let state = seed >>> 0;
  const points: Point[] = [];
  for (let attempt = 0; attempt < maximumAttempts && points.length < maximumPoints; attempt += 1) {
    state = (Math.imul(state ^ (state >>> 15), 1 | state) + 0x6d2b79f5) >>> 0;
    const x = 20 + (state % (WORLD_WIDTH - 40));
    state = (Math.imul(state ^ (state >>> 13), 1 | state) + 0x6d2b79f5) >>> 0;
    const y = 20 + (state % (WORLD_HEIGHT - 40));
    const cellX = Math.floor(x / CELL_SIZE);
    const cellY = Math.floor(y / CELL_SIZE);
    if (terrain[cellY * GRID_WIDTH + cellX] !== TERRAIN_LAND) continue;
    const point = { x, y };
    if (blockedPoints.some((blocked) => Math.hypot(point.x - blocked.x, point.y - blocked.y) < minimumDistance)) continue;
    if (points.some((existing) => Math.hypot(point.x - existing.x, point.y - existing.y) < minimumDistance)) continue;
    points.push(point);
  }
  return points;
}
