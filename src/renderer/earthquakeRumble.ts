export interface RumbleEventLike {
  readonly id: string;
  readonly type: string;
}

export function findNewEarthquakeEventIds(
  events: readonly RumbleEventLike[],
  seenEventIds: ReadonlySet<string>,
): string[] {
  return events
    .filter((event) => event.type === "earthquake" && !seenEventIds.has(event.id))
    .map((event) => event.id);
}
