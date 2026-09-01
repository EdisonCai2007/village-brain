import type { SimulationTimelineEntry } from "./useSimulation";

const KIND_LABELS = {
  plan: "Chief's decision",
  execution: "Response sent",
  outcome: "Fire resolved",
} as const;

const TASK_ACTION_LABELS: Record<string, string> = {
  defend_event: "defend against bandits",
  fight_fire: "fight the fire",
  found_village: "found a new village",
  isolate_sick: "isolate sick villagers",
  relocate: "move villagers to safer ground",
  rescue_trapped: "rescue trapped villagers",
  split_villagers: "split villagers into safer groups",
};

const LIMIT_LABELS: Record<string, string> = {
  deployment_cap: "the response limit",
  founding_not_allowed: "founding a village was not available",
  no_actionable_target: "there was no reachable target",
  no_route: "there was no safe route",
  partial: "only some responders were available",
  reserve_policy: "some villagers stayed in reserve",
  stale_target: "the target was already gone",
  unavailable: "no villagers were available",
};

interface NotificationViewModel {
  readonly label: string;
  readonly message: string;
}

function formatTime(simulationTimeMs: number): string {
  const seconds = Math.max(0, Math.floor(simulationTimeMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

const stripPlannerPrefix = (summary: string): string =>
  summary.replace(/^(?:ai|fallback) plan [^:]+:\s*/i, "");

const taskActionLabel = (type: string): string =>
  TASK_ACTION_LABELS[type] ?? type.replaceAll("_", " ");

function formatExecution(summary: string): string | null {
  const execution = /^[^:]+ execution:\s*(.+)\.$/i.exec(summary);
  if (execution === null) return null;

  const assignments = [...execution[1]!.matchAll(/(\w+) requested (\d+), actual (\d+) \((\w+)\)/g)]
    .filter((match) => Number(match[3]) > 0);
  if (assignments.length === 0) return null;

  const messages = assignments.map((match) => {
    const type = match[1]!;
    const requested = Number(match[2]);
    const assigned = Number(match[3]);
    const reason = match[4]!;
    const action = taskActionLabel(type);
    const head = `Sent ${assigned} villager${assigned === 1 ? "" : "s"} to ${action}`;
    if (reason === "assigned" && assigned === requested) return `${head}.`;
    if (assigned !== requested) {
      return `${head}; ${requested} requested, limited by ${LIMIT_LABELS[reason] ?? reason.replaceAll("_", " ")}.`;
    }
    return `${head}.`;
  });

  return messages.join(" ");
}

const planIdFromSummary = (summary: string): string | null =>
  /^(?:ai|fallback) plan (.+?):\s*/i.exec(summary)?.[1] ?? null;

const hasActualAssignments = (summary: string): boolean =>
  [...summary.matchAll(/\w+ requested \d+, actual (\d+)/g)]
    .some((match) => Number(match[1]) > 0);

function hasMatchingExecution(
  entry: SimulationTimelineEntry,
  entries: readonly SimulationTimelineEntry[],
): boolean {
  const planId = planIdFromSummary(entry.summary);
  if (planId === null) return false;
  return entries.some((candidate) =>
    candidate.kind === "execution"
    && candidate.summary.startsWith(`${planId} execution:`)
    && hasActualAssignments(candidate.summary));
}

function formatNotification(
  entry: SimulationTimelineEntry,
  entries: readonly SimulationTimelineEntry[],
): NotificationViewModel | null {
  if (entry.kind === "plan") {
    if (!hasMatchingExecution(entry, entries)) return null;
    return { label: KIND_LABELS.plan, message: stripPlannerPrefix(entry.summary) };
  }

  if (entry.kind === "outcome" && /^fire \S+ resolved\.$/i.test(entry.summary)) {
    return { label: KIND_LABELS.outcome, message: "The fire was fully extinguished." };
  }

  if (entry.kind !== "execution") return null;
  const message = formatExecution(entry.summary);
  return message === null ? null : { label: KIND_LABELS.execution, message };
}

export interface DecisionNotificationsProps {
  readonly entries: readonly SimulationTimelineEntry[];
}

export function DecisionNotifications({ entries }: DecisionNotificationsProps) {
  const notificationEntries = entries
    .map((entry) => ({ entry, notification: formatNotification(entry, entries) }))
    .filter((item): item is { entry: SimulationTimelineEntry; notification: NotificationViewModel } =>
      item.notification !== null);
  if (notificationEntries.length === 0) return null;

  const visibleEntries = notificationEntries.slice().reverse();

  return (
    <aside className="decision-notifications" aria-label="Village notifications" role="region" tabIndex={0} data-tutorial-target="notifications">
      {visibleEntries.map(({ entry, notification }, index) => (
        <article
          className={`decision-notification decision-notification--${entry.kind}`}
          key={`${entry.id}:${index}`}
        >
          <div className="decision-notification__meta">
            <span>{notification.label}</span>
            <time>{formatTime(entry.simulationTimeMs)}</time>
          </div>
          <p>{notification.message}</p>
        </article>
      ))}
    </aside>
  );
}
