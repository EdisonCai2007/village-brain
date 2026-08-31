import {
  GRID_CELL_COUNT,
  GRID_WIDTH,
  MAX_SEARCH_CELLS,
  TERRAIN_LAND,
} from "./constants";
import {
  cellIndex,
  cellToWorld,
  fourWayNeighbors,
  indexToCell,
  segmentsIntersect,
  worldToCell,
} from "./geometry";
import type { Cell, Point, WorldState } from "./types";

export interface BlockedArea {
  center: Point;
  radius: number;
}

export const replaceBridgeCells = (world: WorldState, cells: readonly Cell[]): void => {
  const replacement = new Uint8Array(GRID_CELL_COUNT);
  for (const cell of cells.slice(0, MAX_SEARCH_CELLS)) {
    const index = cellIndex(cell);
    replacement[index] = 1;
  }
  world.bridgeCells = replacement;
};

interface HeapNode {
  index: number;
  score: number;
}

const compareNodes = (first: HeapNode, second: HeapNode): number => {
  if (first.score !== second.score) return first.score - second.score;
  const firstY = Math.floor(first.index / GRID_WIDTH);
  const secondY = Math.floor(second.index / GRID_WIDTH);
  if (firstY !== secondY) return firstY - secondY;
  return first.index % GRID_WIDTH - second.index % GRID_WIDTH;
};

class MinHeap {
  readonly #nodes: HeapNode[] = [];

  get size(): number {
    return this.#nodes.length;
  }

  push(node: HeapNode): void {
    this.#nodes.push(node);
    let index = this.#nodes.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareNodes(this.#nodes[parent]!, node) <= 0) break;
      this.#nodes[index] = this.#nodes[parent]!;
      index = parent;
    }
    this.#nodes[index] = node;
  }

  pop(): HeapNode | null {
    const root = this.#nodes[0];
    if (root === undefined) return null;
    const last = this.#nodes.pop()!;
    if (this.#nodes.length === 0) return root;

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.#nodes.length) break;
      let child = left;
      if (
        right < this.#nodes.length
        && compareNodes(this.#nodes[right]!, this.#nodes[left]!) < 0
      ) {
        child = right;
      }
      if (compareNodes(last, this.#nodes[child]!) <= 0) break;
      this.#nodes[index] = this.#nodes[child]!;
      index = child;
    }
    this.#nodes[index] = last;
    return root;
  }
}

const manhattan = (from: Cell, to: Cell): number =>
  Math.abs(from.x - to.x) + Math.abs(from.y - to.y);

const isTraversable = (
  world: WorldState,
  index: number,
  blockedAreas: readonly BlockedArea[],
): boolean => {
  if (world.terrain[index] !== TERRAIN_LAND && world.bridgeCells[index] !== 1) return false;
  const point = cellToWorld(indexToCell(index));
  return !blockedAreas.some((area) =>
    Number.isFinite(area.radius)
    && area.radius >= 0
    && Math.hypot(point.x - area.center.x, point.y - area.center.y) <= area.radius);
};

const crossesActiveWall = (world: WorldState, from: Cell, to: Cell): boolean => {
  const wall = world.activeVillage?.wall;
  if (wall === undefined || wall.segments.length === 0) return false;
  const fromPoint = cellToWorld(from);
  const toPoint = cellToWorld(to);
  return wall.segments.some((segment) =>
    segment.destroyed !== true
    && segmentsIntersect(fromPoint, toPoint, segment.start, segment.end));
};

const simplify = (cells: Cell[]): Point[] => {
  if (cells.length <= 2) return cells.map(cellToWorld);
  const waypoints: Cell[] = [cells[0]!];
  for (let index = 1; index < cells.length - 1; index += 1) {
    const previous = cells[index - 1]!;
    const current = cells[index]!;
    const next = cells[index + 1]!;
    const firstDirection = { x: current.x - previous.x, y: current.y - previous.y };
    const secondDirection = { x: next.x - current.x, y: next.y - current.y };
    if (firstDirection.x !== secondDirection.x || firstDirection.y !== secondDirection.y) {
      waypoints.push(current);
    }
  }
  waypoints.push(cells.at(-1)!);
  return waypoints.map(cellToWorld);
};

const reconstructPath = (cameFrom: Int32Array, destinationIndex: number): Point[] => {
  const reversed: Cell[] = [];
  let current = destinationIndex;
  while (current !== -1) {
    reversed.push(indexToCell(current));
    current = cameFrom[current]!;
  }
  reversed.reverse();
  return simplify(reversed);
};

export const findPath = (
  world: WorldState,
  from: Point,
  to: Point,
  maxVisited: number,
  blockedAreas: readonly BlockedArea[] = [],
): Point[] | null => {
  const start = worldToCell(from);
  const destination = worldToCell(to);
  if (
    start === null
    || destination === null
    || !Number.isFinite(maxVisited)
    || maxVisited <= 0
  ) {
    return null;
  }
  const visitLimit = Math.min(Math.floor(maxVisited), MAX_SEARCH_CELLS);
  const startIndex = cellIndex(start);
  const destinationIndex = cellIndex(destination);
  if (
    !isTraversable(world, startIndex, blockedAreas)
    || !isTraversable(world, destinationIndex, blockedAreas)
  ) return null;

  const frontier = new MinHeap();
  const costs = new Float64Array(GRID_CELL_COUNT);
  costs.fill(Number.POSITIVE_INFINITY);
  costs[startIndex] = 0;
  const cameFrom = new Int32Array(GRID_CELL_COUNT);
  cameFrom.fill(-1);
  const closed = new Uint8Array(GRID_CELL_COUNT);
  frontier.push({ index: startIndex, score: manhattan(start, destination) });
  let visitedCount = 0;

  while (frontier.size > 0 && visitedCount < visitLimit) {
    const currentNode = frontier.pop()!;
    if (closed[currentNode.index] === 1) continue;
    closed[currentNode.index] = 1;
    visitedCount += 1;
    if (currentNode.index === destinationIndex) {
      return reconstructPath(cameFrom, destinationIndex);
    }

    const current = indexToCell(currentNode.index);
    for (const neighbor of fourWayNeighbors(current)) {
      const neighborIndex = cellIndex(neighbor);
      if (
        closed[neighborIndex] === 1
        || !isTraversable(world, neighborIndex, blockedAreas)
        || crossesActiveWall(world, current, neighbor)
      ) {
        continue;
      }
      const nextCost = costs[currentNode.index]! + 1;
      if (nextCost >= costs[neighborIndex]!) continue;
      costs[neighborIndex] = nextCost;
      cameFrom[neighborIndex] = currentNode.index;
      frontier.push({
        index: neighborIndex,
        score: nextCost + manhattan(neighbor, destination),
      });
    }
  }
  return null;
};
