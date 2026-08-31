import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlannerRequest, PlannerResponse } from "../shared/planner-contract";
import { requestPlan } from "./planner-client";

const request: PlannerRequest = {
  requestId: "request-1",
  world: {
    simulationTimeMs: 0,
    seed: 42,
    villageCount: 1,
    availableVillagers: 3,
    safeAreas: [],
  },
  activeEvents: [{
    id: "event-1",
    type: "fire",
    x: 1,
    y: 2,
    severity: 2,
    likelyImpactCount: 1,
  }],
  recentPlans: [],
};

const plan: PlannerResponse = {
  planId: "plan-1",
  summary: "Contain the fire.",
  intents: [{
    type: "fight_fire",
    targetEventId: "event-1",
    villagerCount: 1,
    priority: 1,
    rationale: "It is the nearest active threat.",
  }],
};

describe("requestPlan", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the request and validates the response", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(plan));
    vi.stubGlobal("fetch", fetch);
    const resetSignal = new AbortController().signal;

    await expect(requestPlan(request, resetSignal)).resolves.toEqual({ ok: true, value: plan });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/plan");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify(request));
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns typed HTTP and schema errors", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ raw: "not a plan" })));
    const signal = new AbortController().signal;

    await expect(requestPlan(request, signal)).resolves.toMatchObject({
      ok: false,
      error: { kind: "http", status: 503 },
    });
    await expect(requestPlan(request, signal)).resolves.toMatchObject({
      ok: false,
      error: { kind: "invalid-response" },
    });
  });

  it("accepts an intentional empty AI plan", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      planId: "empty-fallback",
      summary: "No deterministic response is available.",
      intents: [],
    })));

    await expect(requestPlan(request, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: {
        planId: "empty-fallback",
        summary: "No deterministic response is available.",
        intents: [],
      },
    });
  });

  it("rejects oversized response headers and streamed bodies", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response("{}", { headers: { "content-length": "65537" } }))
      .mockResolvedValueOnce(new Response("x".repeat(65_537))));
    const signal = new AbortController().signal;

    await expect(requestPlan(request, signal)).resolves.toMatchObject({
      ok: false,
      error: { kind: "response-too-large" },
    });
    await expect(requestPlan(request, signal)).resolves.toMatchObject({
      ok: false,
      error: { kind: "response-too-large" },
    });
  });

  it("uses an 8 second timeout and distinguishes it from reset aborts", async () => {
    const timeoutSignal = AbortSignal.abort(new DOMException("timed out", "TimeoutError"));
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      throw signal.reason;
    }));

    await expect(requestPlan(request, new AbortController().signal)).resolves.toMatchObject({
      ok: false,
      error: { kind: "timeout" },
    });
    expect(timeout).toHaveBeenCalledWith(8_000);

    const reset = new AbortController();
    reset.abort();
    await expect(requestPlan(request, reset.signal)).resolves.toMatchObject({
      ok: false,
      error: { kind: "aborted" },
    });
  });
});
