import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PlannerRequest,
  PlannerResponse,
} from "../shared/planner-contract";
import type { Result } from "../shared/result";
import {
  PlannerCoordinator,
  type PlannerCoordinatorPort,
  type PlannerExecution,
} from "./PlannerCoordinator";
import type { PlannerClientError } from "./planner-client";

const request: PlannerRequest = {
  requestId: "request-1",
  world: {
    simulationTimeMs: 1_000,
    seed: 42,
    villageCount: 1,
    availableVillagers: 4,
    safeAreas: [],
  },
  activeEvents: [{
    id: "event-1",
    type: "fire",
    x: 10,
    y: 20,
    severity: 2,
    likelyImpactCount: 1,
  }],
  recentPlans: [],
};

const aiPlan: PlannerResponse = {
  planId: "plan-ai",
  summary: "Contain the fire.",
  intents: [{
    type: "fight_fire",
    targetEventId: "event-1",
    villagerCount: 2,
    priority: 1,
    rationale: "The fire is close to a home.",
  }],
};

const fallbackPlan: PlannerResponse = {
  planId: "plan-fallback",
  summary: "Use the deterministic emergency response.",
  intents: [{
    type: "fight_fire",
    targetEventId: "event-1",
    villagerCount: 1,
    priority: 1,
    rationale: "Active fires are the highest available fallback priority.",
  }],
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
};

const createPort = () => {
  const batches: string[][] = [];
  const executions: PlannerExecution[] = [];
  const port: PlannerCoordinatorPort = {
    createRequest(eventIds) {
      batches.push([...eventIds]);
      return { ...request, requestId: `request-${batches.length}` };
    },
    createFallback() {
      return fallbackPlan;
    },
    async executePlan(execution) {
      executions.push(execution);
    },
  };
  return { port, batches, executions };
};

describe("PlannerCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("batches one 1,000 ms quiet window and queues later work behind the in-flight plan", async () => {
    const first = deferred<Result<PlannerResponse, PlannerClientError>>();
    const second = deferred<Result<PlannerResponse, PlannerClientError>>();
    const client = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { port, batches } = createPort();
    const coordinator = new PlannerCoordinator({ port, client });

    coordinator.queueEvent("event-1");
    await vi.advanceTimersByTimeAsync(600);
    coordinator.queueEvent("event-2");

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(client).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(client).toHaveBeenCalledTimes(1);
    expect(batches).toEqual([["event-1", "event-2"]]);

    coordinator.queueEvent("event-3");
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client).toHaveBeenCalledTimes(1);

    first.resolve({ ok: true, value: aiPlan });
    await vi.waitFor(() => expect(client).toHaveBeenCalledTimes(2));
    expect(batches).toEqual([
      ["event-1", "event-2"],
      ["event-3"],
    ]);

    second.resolve({ ok: true, value: aiPlan });
    await vi.waitFor(() => expect(coordinator.status).toBe("idle"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts reset work without executing a fallback", async () => {
    const { port, executions } = createPort();
    const observedSignals: AbortSignal[] = [];
    const client = vi.fn(async (_request: PlannerRequest, signal: AbortSignal) => {
      observedSignals.push(signal);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return {
        ok: false as const,
        error: { kind: "aborted" as const, message: "Planner request was aborted." },
      };
    });
    const coordinator = new PlannerCoordinator({ port, client });
    coordinator.queueEvent("event-1");
    await vi.advanceTimersByTimeAsync(1_000);

    coordinator.reset();
    await vi.waitFor(() => expect(coordinator.status).toBe("idle"));

    expect(observedSignals).toHaveLength(1);
    expect(observedSignals[0]?.aborted).toBe(true);
    expect(executions).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each<PlannerClientError>([
    { kind: "http", status: 503, message: "Planner endpoint returned HTTP 503." },
    { kind: "invalid-response", message: "Planner response was invalid." },
    { kind: "timeout", message: "Planner request timed out." },
  ])("executes exactly one fallback for a $kind failure", async (error) => {
    const { port, executions } = createPort();
    const createFallback = vi.spyOn(port, "createFallback");
    const client = vi.fn().mockResolvedValue({ ok: false, error });
    const coordinator = new PlannerCoordinator({ port, client });

    coordinator.queueEvent("event-1");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(coordinator.status).toBe("idle"));

    expect(createFallback).toHaveBeenCalledTimes(1);
    expect(executions).toEqual([{
      request,
      response: fallbackPlan,
      source: "fallback",
      error,
    }]);
  });

  it("publishes collecting, planning, executing, then idle", async () => {
    const statuses: string[] = [];
    const { port } = createPort();
    const coordinator = new PlannerCoordinator({
      port,
      client: vi.fn().mockResolvedValue({ ok: true, value: aiPlan }),
    });
    coordinator.subscribeStatus((status) => statuses.push(status));

    coordinator.queueEvent("event-1");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(coordinator.status).toBe("idle"));

    expect(statuses).toEqual(["collecting", "planning", "executing", "idle"]);
  });
});
