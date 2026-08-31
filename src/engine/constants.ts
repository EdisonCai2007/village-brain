export const WORLD_WIDTH = 1_280;
export const WORLD_HEIGHT = 860;
export const CELL_SIZE = 10;
export const GRID_WIDTH = 128;
export const GRID_HEIGHT = 86;
export const GRID_CELL_COUNT = GRID_WIDTH * GRID_HEIGHT;

export const TERRAIN_WATER = 0;
export const TERRAIN_LAND = 1;

export const MAX_SEARCH_CELLS = 4_096;
export const MAX_INTERPOLATED_POINTS = 4_096;
export const MAX_RIVER_WIDTH_CELLS = 9;

export const FIRE_INITIAL_INTENSITY = 100;
export const FIRE_SPREAD_INTERVAL_MS = 1_500;
export const MAX_FIRE_SPREADS_PER_UPDATE = 8;
export const MAX_FIRE_CELLS = GRID_CELL_COUNT;

export const TSUNAMI_WIDTH = 220;
export const TSUNAMI_SPEED = 42;
export const TSUNAMI_LIFETIME_MS = 8_000;

export const BANDIT_COUNT = 4;
export const BANDIT_PATH_INTERVAL_MS = 1_000;
export const MAX_ACTIVE_BANDIT_EVENTS = 12;
export const MAX_BANDIT_PATHFINDS_PER_TICK = 6;

export const EARTHQUAKE_RADIUS = 120;
export const MAX_EARTHQUAKE_PITS = 3;

export const PLAGUE_INITIAL_RADIUS = 90;
export const PLAGUE_PROXIMITY = 32;
export const PLAGUE_EXPOSURE_MS = 1_000;
export const PLAGUE_RECOVERY_MS = 5_000;
export const MAX_PLAGUE_PAIR_CHECKS = 4_096;
export const MAX_PLAGUE_PARTICIPANTS = 32;
export const MAX_ACTIVE_PLAGUE_EVENTS = 4;
export const MAX_PLAGUE_EXPOSURES = MAX_PLAGUE_PARTICIPANTS * MAX_ACTIVE_PLAGUE_EVENTS;

export const MAX_TSUNAMI_HITS = 256;

export const MAX_WORLD_EVENTS = 200;
