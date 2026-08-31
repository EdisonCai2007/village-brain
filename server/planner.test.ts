import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlannerRequest, PlannerResponse } from "../src/shared/planner-contract";
import {
  PlannerProviderError,
  createGeminiPlannerProvider,
  createPlannerHandler,
  type PlannerProvider,
} from "./planner";
import { createSessionLogger } from "./session-log";

const validRequest: PlannerRequest = {
  requestId: "request-1",
  world: {
    simulationTimeMs: 12_000,
    seed: 42,
    villageCount: 1,
    availableVillagers: 7,
    safeAreas: [{ id: "safe-1", x: 128, y: 256, capacity: 12 }],
  },
  activeEvents: [{
    id: "event-1",
    type: "fire",
    x: 180,
    y: 220,
    severity: 3,
    likelyImpactCount: 2,
  }],
  recentPlans: [],
};

const validPlan: PlannerResponse = {
  planId: "plan-1",
  summary: "Contain the closest fire.",
  intents: [{
    type: "fight_fire",
    targetEventId: "event-1",
    villagerCount: 3,
    priority: 1,
    rationale: "It threatens two homes.",
  }],
};

const post = (body: string, headers: Record<string, string> = {}) => new Request("http://local/api/plan", {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body,
});

const providerWith = (implementation: PlannerProvider["plan"]): PlannerProvider => ({
  plan: implementation,
});

describe("createPlannerHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns validated JSON from an injected provider with no-store headers", async () => {
    const provider = providerWith(async () => structuredClone(validPlan));
    const handler = createPlannerHandler({ provider, timeoutMs: 7_000 });

    const response = await handler(post(JSON.stringify(validRequest)));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(validPlan);
  });

  it("accepts an intentional AI no-op when the provider has no safe action", async () => {
    const provider = providerWith(async () => ({
      planId: "plan-noop",
      summary: "No safe action is available.",
      intents: [],
    }));
    const handler = createPlannerHandler({ provider, timeoutMs: 7_000 });

    const response = await handler(post(JSON.stringify(validRequest)));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      planId: "plan-noop",
      summary: "No safe action is available.",
      intents: [],
    });
  });

  it("rejects non-POST methods without invoking the provider", async () => {
    const plan = vi.fn<PlannerProvider["plan"]>();
    const handler = createPlannerHandler({ provider: providerWith(plan), timeoutMs: 7_000 });

    const response = await handler(new Request("http://local/api/plan", { method: "GET" }));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(plan).not.toHaveBeenCalled();
  });

  it("rejects declared and streamed bodies over 64 KiB", async () => {
    const plan = vi.fn<PlannerProvider["plan"]>();
    const handler = createPlannerHandler({ provider: providerWith(plan), timeoutMs: 7_000 });

    const declared = await handler(post("{}", { "content-length": "65537" }));
    const streamed = await handler(post(`{"padding":"${"x".repeat(65_536)}"}`));

    expect(declared.status).toBe(413);
    expect(streamed.status).toBe(413);
    expect(plan).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{", 400],
    ["an invalid request", "{}", 400],
  ])("rejects %s before provider work", async (_case, body, status) => {
    const plan = vi.fn<PlannerProvider["plan"]>();
    const handler = createPlannerHandler({ provider: providerWith(plan), timeoutMs: 7_000 });

    const response = await handler(post(body));

    expect(response.status).toBe(status);
    expect(plan).not.toHaveBeenCalled();
  });

  it("times provider work out with a safe response", async () => {
    const provider = providerWith(() => new Promise<PlannerResponse>(() => undefined));
    const handler = createPlannerHandler({ provider, timeoutMs: 100 });

    const responsePromise = handler(post(JSON.stringify(validRequest)));
    await vi.advanceTimersByTimeAsync(100);
    const response = await responsePromise;

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error: { code: "provider_timeout", message: "Planner provider timed out." },
    });
  });

  it("does not let a provider error message impersonate the timeout sentinel", async () => {
    const handler = createPlannerHandler({
      provider: providerWith(() => Promise.reject(new Error("provider_timeout"))),
      timeoutMs: 7_000,
    });

    const response = await handler(post(JSON.stringify(validRequest)));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { code: "provider_error", message: "Planner provider failed." },
    });
  });

  it.each([
    ["provider rejection", () => Promise.reject(new Error("GOOGLE_API_KEY=secret raw-provider-text"))],
    ["invalid provider output", () => Promise.resolve({ raw: "secret raw-provider-text" } as never)],
  ])("does not expose secrets or raw output after %s", async (_case, implementation) => {
    const handler = createPlannerHandler({
      provider: providerWith(implementation),
      timeoutMs: 7_000,
    });

    const response = await handler(post(JSON.stringify(validRequest)));
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(body).not.toContain("secret");
    expect(body).not.toContain("raw-provider-text");
    expect(body).not.toContain("GOOGLE_API_KEY");
  });
});

describe("createGeminiPlannerProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("repairs one failed structured attempt and validates the retry", async () => {
    const invoke = vi.fn()
      .mockRejectedValueOnce(new Error("bad tool output"))
      .mockResolvedValueOnce(new AIMessage({
        content: "",
        tool_calls: [{
          id: "call-send",
          name: "send_villagers",
          args: {
            targetEventId: "event-1",
            responseType: "fight_fire",
            villagerCount: 3,
            priority: 1,
            rationale: "It threatens two homes.",
          },
          type: "tool_call",
        }],
      }))
      .mockResolvedValueOnce(new AIMessage("Contain the closest fire."));
    const bindTools = vi.fn(() => ({ invoke }));
    const provider = createGeminiPlannerProvider({
      apiKey: "test-key",
      modelName: "test-model",
      toolModel: { bindTools },
    });

    await expect(provider.plan(validRequest)).resolves.toEqual(validPlan);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(invoke.mock.calls[1]?.[0]).toLowerCase()).toContain("repair");
  });

  it("binds the selected LangChain tools and turns action calls into planner intents", async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce(new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "call-list",
            name: "list_active_disasters",
            args: {},
            type: "tool_call",
          },
          {
            id: "call-send",
            name: "send_villagers",
            args: {
              targetEventId: "event-1",
              responseType: "fight_fire",
              villagerCount: 3,
              priority: 1,
              rationale: "It threatens two homes.",
            },
            type: "tool_call",
          },
        ],
      }))
      .mockResolvedValueOnce(new AIMessage("Contain the closest fire."));
    const bindTools = vi.fn(() => ({ invoke }));
    const provider = createGeminiPlannerProvider({
      apiKey: "test-key",
      modelName: "test-model",
      toolModel: { bindTools },
    });

    await expect(provider.plan(validRequest)).resolves.toEqual(validPlan);

    expect(bindTools).toHaveBeenCalledOnce();
    const bindCalls = bindTools.mock.calls as unknown as [StructuredToolInterface[]][];
    const boundTools = bindCalls[0]?.[0] ?? [];
    expect(boundTools.map((boundTool) => boundTool.name)).toEqual([
      "list_active_disasters",
      "get_disaster_details",
      "list_available_villagers",
      "list_safe_areas",
      "send_villagers",
      "relocate_villagers",
      "split_villagers",
    ]);
    expect(invoke).toHaveBeenCalledTimes(2);
    const toolMessages = (invoke.mock.calls[1]?.[0] as BaseMessage[]).slice(-2);
    expect(toolMessages.map((message) => message.name)).toEqual(["list_active_disasters", "send_villagers"]);
    expect(toolMessages[0].content).toContain("\"id\":\"event-1\"");
    expect(toolMessages[1].content).toContain("\"accepted\":true");
  });

  it("exposes selected snapshot facts through information tools", async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce(new AIMessage({
        content: "",
        tool_calls: [
          { id: "call-event", name: "get_disaster_details", args: { eventId: "event-1" }, type: "tool_call" },
          { id: "call-villagers", name: "list_available_villagers", args: {}, type: "tool_call" },
          { id: "call-safe", name: "list_safe_areas", args: { strategy: "least_impacted_area" }, type: "tool_call" },
        ],
      }))
      .mockResolvedValueOnce(new AIMessage("No villagers need to move yet."));
    const bindTools = vi.fn(() => ({ invoke }));
    const provider = createGeminiPlannerProvider({
      apiKey: "test-key",
      modelName: "test-model",
      toolModel: { bindTools },
    });

    await expect(provider.plan(validRequest)).resolves.toEqual({
      planId: "plan-1",
      summary: "No villagers need to move yet.",
      intents: [],
    });

    const secondMessages = invoke.mock.calls[1]?.[0];
    expect(secondMessages.at(-3).content).toContain("\"id\":\"event-1\"");
    expect(secondMessages.at(-2).content).toContain("\"availableVillagers\":7");
    expect(secondMessages.at(-1).content).toContain("\"strategy\":\"least_impacted_area\"");
  });

  it("converts relocation and split action tools into planner intents", async () => {
    const disasterRequest: PlannerRequest = {
      ...validRequest,
      activeEvents: [{
        id: "event-wave",
        type: "tsunami",
        x: 40,
        y: 50,
        severity: 5,
        likelyImpactCount: 6,
      }],
    };
    const invoke = vi.fn()
      .mockResolvedValueOnce(new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "call-relocate",
            name: "relocate_villagers",
            args: {
              targetEventId: "event-wave",
              strategy: "least_impacted_area",
              villagerCount: 5,
              priority: 1,
              rationale: "The incoming wave threatens the village.",
            },
            type: "tool_call",
          },
          {
            id: "call-split",
            name: "split_villagers",
            args: {
              villagerCount: 2,
              priority: 2,
              rationale: "Keep part of the group separated as a reserve.",
            },
            type: "tool_call",
          },
        ],
      }))
      .mockResolvedValueOnce(new AIMessage("Move villagers out of the wave corridor."));
    const bindTools = vi.fn(() => ({ invoke }));
    const provider = createGeminiPlannerProvider({
      apiKey: "test-key",
      modelName: "test-model",
      toolModel: { bindTools },
    });

    await expect(provider.plan(disasterRequest)).resolves.toEqual({
      planId: "plan-1",
      summary: "Move villagers out of the wave corridor.",
      intents: [
        {
          type: "relocate",
          targetEventId: "event-wave",
          strategy: "least_impacted_area",
          villagerCount: 5,
          priority: 1,
          rationale: "The incoming wave threatens the village.",
        },
        {
          type: "split_villagers",
          strategy: "separate_groups",
          villagerCount: 2,
          priority: 2,
          rationale: "Keep part of the group separated as a reserve.",
        },
      ],
    });
  });

  it("binds fresh LangChain tools for each planner request snapshot", async () => {
    const secondRequest: PlannerRequest = {
      ...validRequest,
      requestId: "request-2",
      activeEvents: [{
        id: "event-2",
        type: "bandits",
        x: 320,
        y: 180,
        severity: 4,
        likelyImpactCount: 1,
      }],
    };
    const invoke = vi.fn()
      .mockResolvedValueOnce(new AIMessage({
        content: "",
        tool_calls: [{ id: "call-first", name: "list_active_disasters", args: {}, type: "tool_call" }],
      }))
      .mockResolvedValueOnce(new AIMessage("First snapshot checked."))
      .mockResolvedValueOnce(new AIMessage({
        content: "",
        tool_calls: [{ id: "call-second", name: "list_active_disasters", args: {}, type: "tool_call" }],
      }))
      .mockResolvedValueOnce(new AIMessage("Second snapshot checked."));
    const bindTools = vi.fn(() => ({ invoke }));
    const provider = createGeminiPlannerProvider({
      apiKey: "test-key",
      modelName: "test-model",
      toolModel: { bindTools },
    });

    await expect(provider.plan(validRequest)).resolves.toMatchObject({ summary: "First snapshot checked." });
    await expect(provider.plan(secondRequest)).resolves.toMatchObject({ summary: "Second snapshot checked." });

    expect(bindTools).toHaveBeenCalledTimes(2);
    const firstToolMessages = invoke.mock.calls[1]?.[0];
    const secondToolMessages = invoke.mock.calls[3]?.[0];
    expect(firstToolMessages.at(-1).content).toContain("\"id\":\"event-1\"");
    expect(secondToolMessages.at(-1).content).toContain("\"id\":\"event-2\"");
  });

  it("rejects stale or incompatible action tool calls before engine execution", async () => {
    const invoke = vi.fn()
      .mockResolvedValue(new AIMessage({
        content: "",
        tool_calls: [{
          id: "call-bad",
          name: "send_villagers",
          args: {
            targetEventId: "missing-event",
            responseType: "fight_fire",
            villagerCount: 3,
            priority: 1,
            rationale: "Try to fight a missing fire.",
          },
          type: "tool_call",
        }],
      }));
    const bindTools = vi.fn(() => ({ invoke }));
    const provider = createGeminiPlannerProvider({
      apiKey: "test-key",
      modelName: "test-model",
      toolModel: { bindTools },
    });

    await expect(provider.plan(validRequest)).rejects.toMatchObject({
      failureType: "invalid_provider_output",
    });
  });

  it("prompts the model to cover active disasters within the five-intent schema limit", async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce(new AIMessage({
        content: "",
        tool_calls: [{
          id: "call-send",
          name: "send_villagers",
          args: {
            targetEventId: "event-1",
            responseType: "fight_fire",
            villagerCount: 3,
            priority: 1,
            rationale: "It threatens two homes.",
          },
          type: "tool_call",
        }],
      }))
      .mockResolvedValueOnce(new AIMessage("Contain the closest fire."));
    const bindTools = vi.fn(() => ({ invoke }));
    const provider = createGeminiPlannerProvider({
      apiKey: "test-key",
      modelName: "test-model",
      toolModel: { bindTools },
    });

    await expect(provider.plan(validRequest)).resolves.toEqual(validPlan);

    const messages = invoke.mock.calls[0]?.[0] ?? [];
    const text = JSON.stringify(messages);
    expect(text).toContain("Cover each active disaster");
    expect(text).toContain("Return zero to five concise intents");
  });

  it("writes verbose session logs with raw outputs, usage metadata, and redacted secrets", async () => {
    const logRoot = await mkdtemp(join(tmpdir(), "village-brain-ai-logs-"));
    const logger = createSessionLogger({
      rootDir: logRoot,
      secrets: ["test-key"],
      now: () => new Date("2026-08-29T12:00:00.000Z"),
      pid: 123,
    });
    const invoke = vi.fn()
      .mockResolvedValueOnce({
        content: "",
        tool_calls: [{
          id: "call-send",
          name: "send_villagers",
          args: {
            targetEventId: "event-1",
            responseType: "fight_fire",
            villagerCount: 3,
            priority: 1,
            rationale: "It threatens two homes.",
          },
          type: "tool_call",
        }],
        usage_metadata: {
          input_tokens: 111,
          output_tokens: 22,
          total_tokens: 133,
        },
        response_metadata: {
          model: "gemini-test",
          tokenUsage: {
            promptTokens: 111,
            completionTokens: 22,
            totalTokens: 133,
          },
        },
        additional_kwargs: {
          apiKey: "test-key",
        },
      })
      .mockResolvedValueOnce(new AIMessage("Contain the closest fire."));
    const bindTools = vi.fn(() => ({ invoke }));
    const provider = createGeminiPlannerProvider({
      apiKey: "test-key",
      modelName: "gemini-test",
      toolModel: { bindTools },
      logger,
    });

    try {
      await expect(provider.plan(validRequest)).resolves.toEqual(validPlan);
      await logger.flush();
      const body = await readFile(logger.filePath, "utf8");

      expect(body).toContain("\"event\":\"session_started\"");
      expect(body).toContain("\"event\":\"gemini_plan_started\"");
      expect(body).toContain("\"event\":\"gemini_tool_attempt_completed\"");
      expect(body).toContain("\"event\":\"gemini_tool_called\"");
      expect(body).toContain("\"rawLangChainOutput\"");
      expect(body).toContain("\"plannerRequest\"");
      expect(body).toContain("\"langChainUsageMetadata\"");
      expect(body).toContain("\"total_tokens\":133");
      expect(body).toContain("Gemini responses expose token usage metadata");
      expect(body).not.toContain("test-key");
      expect(body).toContain("[REDACTED_SECRET_FIELD]");
    } finally {
      await rm(logRoot, { recursive: true, force: true });
    }
  });

  it("keeps usage metadata from AIMessage-like raw outputs", async () => {
    const logRoot = await mkdtemp(join(tmpdir(), "village-brain-ai-logs-"));
    const logger = createSessionLogger({
      rootDir: logRoot,
      secrets: ["test-key"],
      now: () => new Date("2026-08-29T12:00:00.000Z"),
      pid: 123,
    });
    const invoke = vi.fn()
      .mockResolvedValueOnce(new AIMessage({
        content: "",
        tool_calls: [{
          id: "call-send",
          name: "send_villagers",
          args: {
            targetEventId: "event-1",
            responseType: "fight_fire",
            villagerCount: 3,
            priority: 1,
            rationale: "It threatens two homes.",
          },
          type: "tool_call",
        }],
        usage_metadata: {
          input_tokens: 111,
          output_tokens: 22,
          total_tokens: 133,
        },
        response_metadata: {
          model: "gemini-test",
          tokenUsage: {
            promptTokens: 111,
            completionTokens: 22,
            totalTokens: 133,
          },
        },
        additional_kwargs: {
          apiKey: "test-key",
        },
      }))
      .mockResolvedValueOnce(new AIMessage("Contain the closest fire."));
    const bindTools = vi.fn(() => ({ invoke }));
    const provider = createGeminiPlannerProvider({
      apiKey: "test-key",
      modelName: "gemini-test",
      toolModel: { bindTools },
      logger,
    });

    try {
      await expect(provider.plan(validRequest)).resolves.toEqual(validPlan);
      await logger.flush();
      const body = await readFile(logger.filePath, "utf8");

      expect(body).toContain("\"total_tokens\":133");
      expect(body).not.toContain("test-key");
    } finally {
      await rm(logRoot, { recursive: true, force: true });
    }
  });

  it("normalizes harmless Gemini-only fields before strict app validation", async () => {
    const logRoot = await mkdtemp(join(tmpdir(), "village-brain-ai-logs-"));
    const logger = createSessionLogger({
      rootDir: logRoot,
      secrets: ["test-key"],
      now: () => new Date("2026-08-29T12:00:00.000Z"),
      pid: 123,
    });
    const invoke = vi.fn().mockResolvedValue({
      raw: {
        content: "",
        usage_metadata: {
          input_tokens: 111,
          output_tokens: 22,
          total_tokens: 133,
        },
        response_metadata: {
          model: "gemini-test",
          tokenUsage: {
            promptTokens: 111,
            completionTokens: 22,
            totalTokens: 133,
          },
        },
        additional_kwargs: {
          apiKey: "test-key",
        },
      },
      parsed: {
        ...validPlan,
        intents: [{
          type: "defend_event",
          targetEventId: "event-1",
          strategy: "least_impacted_area",
          villagerCount: 4,
          priority: 1,
          rationale: "Protect the village from the active threat.",
        }],
      },
    });
    const provider = createGeminiPlannerProvider({
      apiKey: "test-key",
      modelName: "gemini-test",
      structuredInvoker: { invoke },
      logger,
    });

    try {
      await expect(provider.plan(validRequest)).resolves.toEqual({
        ...validPlan,
        intents: [{
          type: "defend_event",
          targetEventId: "event-1",
          villagerCount: 4,
          priority: 1,
          rationale: "Protect the village from the active threat.",
        }],
      });
      await logger.flush();
      const body = await readFile(logger.filePath, "utf8");

      expect(body).toContain("\"event\":\"gemini_attempt_completed\"");
    } finally {
      await rm(logRoot, { recursive: true, force: true });
    }
  });

  it("classifies quota or credit failures without spending a repair attempt", async () => {
    const logRoot = await mkdtemp(join(tmpdir(), "village-brain-ai-logs-"));
    const logger = createSessionLogger({
      rootDir: logRoot,
      now: () => new Date("2026-08-29T12:00:00.000Z"),
      pid: 456,
    });
    const quotaError = Object.assign(new Error("Quota exhausted for the free plan."), {
      name: "RequestError",
      status: 429,
    });
    const invoke = vi.fn().mockRejectedValue(quotaError);
    const provider = createGeminiPlannerProvider({
      apiKey: "test-key",
      modelName: "gemini-test",
      structuredInvoker: { invoke },
      logger,
    });

    try {
      await expect(provider.plan(validRequest)).rejects.toMatchObject({
        failureType: "quota_or_credits",
      });
      await logger.flush();
      const body = await readFile(logger.filePath, "utf8");

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(body).toContain("\"failureType\":\"quota_or_credits\"");
      expect(body).toContain("\"repairAttempted\":false");
    } finally {
      await rm(logRoot, { recursive: true, force: true });
    }
  });

  it("returns a typed provider error after the single repair retry", async () => {
    const invoke = vi.fn().mockResolvedValue({ raw: "still invalid" });
    const provider = createGeminiPlannerProvider({
      apiKey: "test-key",
      modelName: "test-model",
      structuredInvoker: { invoke },
    });

    await expect(provider.plan(validRequest)).rejects.toBeInstanceOf(PlannerProviderError);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
