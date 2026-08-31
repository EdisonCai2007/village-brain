import { ChatGoogle, GoogleRequestRecorder } from "@langchain/google";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import {
  AIPlannerResponseSchema,
  PlannerRequestSchema,
  type PlannerIntent,
  type PlannerRequest,
  type PlannerResponse,
} from "../src/shared/planner-contract";
import { z } from "zod";
import type { SessionLogger } from "./session-log";

const MAX_REQUEST_BYTES = 64 * 1_024;

export interface PlannerProvider {
  plan(request: PlannerRequest): Promise<PlannerResponse>;
}

export class PlannerProviderError extends Error {
  readonly code = "provider_error";
  readonly failureType?: string;

  constructor(failureType?: string) {
    super("Planner provider failed.");
    this.name = "PlannerProviderError";
    this.failureType = failureType;
  }
}

type PlannerMessage = ["system" | "human", string];
type GeminiAttemptKind = "initial" | "repair";
type ToolAttemptKind = "initial" | "repair" | "tool_followup";

interface StructuredPlannerInvokeOptions {
  callbacks?: Callbacks;
}

export interface StructuredPlannerInvoker {
  invoke(messages: PlannerMessage[], options?: StructuredPlannerInvokeOptions): Promise<unknown>;
}

interface ToolPlannerInvokeOptions {
  callbacks?: Callbacks;
}

export interface ToolPlannerInvoker {
  invoke(messages: BaseMessage[], options?: ToolPlannerInvokeOptions): Promise<unknown>;
}

export interface ToolCapablePlannerModel {
  bindTools(tools: StructuredToolInterface[]): ToolPlannerInvoker;
}

export interface GeminiPlannerOptions {
  apiKey?: string;
  modelName?: string;
  logger?: SessionLogger;
  structuredInvoker?: StructuredPlannerInvoker;
  toolModel?: ToolCapablePlannerModel;
}

const intentVocabulary = [
  "fight_fire",
  "defend_event",
  "rescue_trapped",
  "isolate_sick",
  "relocate",
  "found_village",
  "split_villagers",
].join(", ");

const GeminiPlannerIntentSchema = z.object({
  type: z.enum([
    "fight_fire",
    "defend_event",
    "rescue_trapped",
    "isolate_sick",
    "relocate",
    "found_village",
    "split_villagers",
  ]),
  targetEventId: z.string().min(1).max(120).optional(),
  strategy: z.enum([
    "nearest_safe_area",
    "least_impacted_area",
    "new_village_site",
    "separate_groups",
  ]).optional(),
  villagerCount: z.number().int().min(1).max(100),
  priority: z.number().int().min(1).max(5),
  rationale: z.string().min(1).max(240),
}).strict();

const GeminiPlannerResponseSchema = z.object({
  planId: z.string().min(1).max(120),
  summary: z.string().min(1).max(480),
  intents: z.array(GeminiPlannerIntentSchema).max(5),
}).strict();

const targetedIntentTypes = new Set([
  "fight_fire",
  "defend_event",
  "rescue_trapped",
  "isolate_sick",
]);

const eventTypeByTargetedIntent = {
  fight_fire: "fire",
  defend_event: "bandits",
  rescue_trapped: "earthquake",
  isolate_sick: "plague",
} as const;

const actionToolNames = new Set([
  "send_villagers",
  "relocate_villagers",
  "split_villagers",
]);

const MAX_TOOL_LOOP_STEPS = 5;

const normalizeProviderOutput = (output: unknown): unknown => {
  const parsed = GeminiPlannerResponseSchema.safeParse(output);
  if (!parsed.success) return output;

  return {
    ...parsed.data,
    intents: parsed.data.intents.map((intent) => {
      if (targetedIntentTypes.has(intent.type)) {
        const { strategy: _strategy, ...targetedIntent } = intent;
        return targetedIntent;
      }
      return intent;
    }),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getStructuredParsedOutput = (output: unknown): unknown => {
  if (isRecord(output) && "raw" in output && "parsed" in output) return output.parsed;
  return output;
};

const collectUsageMetadata = (output: unknown, recorder: GoogleRequestRecorder | null): Record<string, unknown> => {
  const raw = isRecord(output) && isRecord(output.raw)
    ? output.raw
    : isRecord(output)
      ? output
      : null;
  const responseMetadata = raw !== null && isRecord(raw.response_metadata)
    ? raw.response_metadata
    : null;
  return {
    langChainUsageMetadata: raw !== null && "usage_metadata" in raw ? raw.usage_metadata : null,
    responseMetadataUsage: responseMetadata?.usageMetadata ?? responseMetadata?.usage_metadata ?? null,
    responseMetadataTokenUsage: responseMetadata?.tokenUsage ?? null,
    recordedGeminiUsageMetadata: isRecord(recorder?.response)
      ? recorder.response.usageMetadata ?? recorder.response.usage_metadata ?? null
      : null,
    creditAccounting: {
      available: false,
      reason: "Gemini responses expose token usage metadata, but not remaining account credits or billing balance.",
    },
  };
};

const validationIssues = (result: ReturnType<typeof AIPlannerResponseSchema.safeParse>): unknown =>
  result.success ? [] : result.error.issues;

class ProviderOutputValidationError extends Error {
  readonly failureType = "invalid_provider_output";

  constructor() {
    super("Planner provider output failed strict app validation.");
    this.name = "ProviderOutputValidationError";
  }
}

const classifyProviderFailure = (error: unknown): string => {
  if (error instanceof ProviderOutputValidationError) return error.failureType;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const text = `${name} ${message}`.toLowerCase();
  if (/quota|credit|billing|insufficient|free plan|exhausted/.test(text)) return "quota_or_credits";
  if (/rate.?limit|too many requests|resource_exhausted|429/.test(text)) return "rate_limited";
  if (/api key|permission|unauth|forbidden|401|403/.test(text)) return "authentication";
  if (/not found|no longer available|model/.test(text)) return "model_unavailable";
  if (/invalid json payload|function_declarations|schema|parameters/.test(text)) return "provider_schema_rejected";
  if (/network|fetch|econn|etimedout|timeout/.test(text)) return "network";
  return "provider_error";
};

const shouldRepairAfterFailure = (error: unknown): boolean => {
  if (error instanceof ProviderOutputValidationError) return true;
  const failureType = classifyProviderFailure(error);
  return failureType === "provider_error";
};

const toolPlannerMessages = (request: PlannerRequest): BaseMessage[] =>
  plannerMessages(request).map(([role, content]) =>
    role === "system" ? new SystemMessage(content) : new HumanMessage(content));

const eventById = (
  request: PlannerRequest,
  eventId: string,
): PlannerRequest["activeEvents"][number] | undefined =>
  request.activeEvents.find((event) => event.id === eventId);

const assertEventCompatible = (
  request: PlannerRequest,
  eventId: string,
  intentType: keyof typeof eventTypeByTargetedIntent,
): void => {
  const event = eventById(request, eventId);
  if (event === undefined || event.type !== eventTypeByTargetedIntent[intentType]) {
    throw new ProviderOutputValidationError();
  }
};

const planIdForRequest = (requestId: string): string =>
  `plan-${requestId.replace(/^request-/, "")}`.slice(0, 120);

const textFromMessageContent = (content: unknown): string => {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (isRecord(item) && typeof item.text === "string") return item.text;
      return "";
    })
    .join("")
    .trim();
};

const summaryFromOutput = (output: unknown, fallback: string): string => {
  const content = isRecord(output) ? output.content : undefined;
  const summary = textFromMessageContent(content);
  return summary.length > 0 ? summary.slice(0, 480) : fallback;
};

const toolCallsFromOutput = (output: unknown): Array<{
  id: string;
  name: string;
  args: unknown;
}> => {
  if (!isRecord(output) || !Array.isArray(output.tool_calls)) return [];
  return output.tool_calls.flatMap((call, index) => {
    if (!isRecord(call) || typeof call.name !== "string") return [];
    return [{
      id: typeof call.id === "string" && call.id.length > 0 ? call.id : `tool-call-${index}`,
      name: call.name,
      args: "args" in call ? call.args : {},
    }];
  });
};

const createPlannerTools = (
  request: PlannerRequest,
  pendingIntents: PlannerIntent[],
): StructuredToolInterface[] => {
  const addIntent = (intent: PlannerIntent): string => {
    if (pendingIntents.length >= 5) throw new ProviderOutputValidationError();
    pendingIntents.push(intent);
    return JSON.stringify({
      accepted: true,
      intent,
      pendingIntentCount: pendingIntents.length,
    });
  };

  return [
    tool(
      async () => JSON.stringify({
        disasters: request.activeEvents,
        count: request.activeEvents.length,
      }),
      {
        name: "list_active_disasters",
        description: "List all currently active simulation disasters from the frozen planner snapshot.",
        schema: z.object({}).strict(),
      },
    ),
    tool(
      async ({ eventId }) => {
        const event = eventById(request, eventId);
        if (event === undefined) throw new ProviderOutputValidationError();
        return JSON.stringify({ disaster: event });
      },
      {
        name: "get_disaster_details",
        description: "Get details for one active disaster by event id.",
        schema: z.object({ eventId: z.string().min(1).max(120) }).strict(),
      },
    ),
    tool(
      async () => JSON.stringify({
        availableVillagers: request.world.availableVillagers,
        maxDeployableVillagers: request.world.maxDeployableVillagers ?? request.world.availableVillagers,
        minimumReserveVillagers: request.world.minimumReserveVillagers ?? 0,
        livingVillagers: request.world.livingVillagers ?? request.world.availableVillagers,
        sickVillagers: request.world.sickVillagers ?? 0,
        trappedVillagers: request.world.trappedVillagers ?? 0,
        assignedVillagers: request.world.assignedVillagers ?? 0,
      }),
      {
        name: "list_available_villagers",
        description: "Summarize villager availability and deployment limits from the frozen planner snapshot.",
        schema: z.object({}).strict(),
      },
    ),
    tool(
      async ({ strategy }) => JSON.stringify({
        strategy: strategy ?? "least_impacted_area",
        safeAreas: request.world.safeAreas,
        count: request.world.safeAreas.length,
      }),
      {
        name: "list_safe_areas",
        description: "List safe area candidates already computed for the planner snapshot.",
        schema: z.object({
          strategy: z.enum(["nearest_safe_area", "least_impacted_area", "new_village_site", "separate_groups"]).optional(),
        }).strict(),
      },
    ),
    tool(
      async ({ targetEventId, responseType, villagerCount, priority, rationale }) => {
        assertEventCompatible(request, targetEventId, responseType);
        return addIntent({
          type: responseType,
          targetEventId,
          villagerCount,
          priority,
          rationale,
        });
      },
      {
        name: "send_villagers",
        description: "Commit a targeted disaster response. The engine still chooses exact villagers, routes, destinations, and gates.",
        schema: z.object({
          targetEventId: z.string().min(1).max(120),
          responseType: z.enum(["fight_fire", "defend_event", "rescue_trapped", "isolate_sick"]),
          villagerCount: z.number().int().min(1).max(100),
          priority: z.number().int().min(1).max(5),
          rationale: z.string().min(1).max(240),
        }).strict(),
      },
    ),
    tool(
      async ({ targetEventId, strategy, villagerCount, priority, rationale }) => {
        if (targetEventId !== undefined && eventById(request, targetEventId) === undefined) {
          throw new ProviderOutputValidationError();
        }
        return addIntent({
          type: "relocate",
          ...(targetEventId === undefined ? {} : { targetEventId }),
          strategy,
          villagerCount,
          priority,
          rationale,
        });
      },
      {
        name: "relocate_villagers",
        description: "Commit an evacuation or relocation response. The engine chooses exact villagers and safe destinations.",
        schema: z.object({
          targetEventId: z.string().min(1).max(120).optional(),
          strategy: z.enum(["nearest_safe_area", "least_impacted_area", "new_village_site"]),
          villagerCount: z.number().int().min(1).max(100),
          priority: z.number().int().min(1).max(5),
          rationale: z.string().min(1).max(240),
        }).strict(),
      },
    ),
    tool(
      async ({ villagerCount, priority, rationale }) => addIntent({
        type: "split_villagers",
        strategy: "separate_groups",
        villagerCount,
        priority,
        rationale,
      }),
      {
        name: "split_villagers",
        description: "Commit a strategic split of villagers into separated groups. The engine chooses the actual groups and destinations.",
        schema: z.object({
          villagerCount: z.number().int().min(1).max(100),
          priority: z.number().int().min(1).max(5),
          rationale: z.string().min(1).max(240),
        }).strict(),
      },
    ),
  ];
};

const plannerMessages = (request: PlannerRequest): PlannerMessage[] => [
  [
    "system",
    `You are the village chief. Choose only high-level strategic intents from: ${intentVocabulary}. `
      + "Treat the simulation snapshot as authoritative. Deterministic simulation code owns villager selection, exact destinations, pathing, movement, damage, and resolution. "
      + "Use only supplied event IDs where the schema requires targetEventId; never prescribe villager or structure IDs, coordinates, routes, path nodes, or low-level actions. "
      + "First triage active events by severity, proximity, and impact; active disasters are actionable threats by default, even when the best response is a small team. "
      + "Cover each active disaster with one concise intent when deployment limits allow it, then favor the highest-priority threats for any remaining responders. "
      + "Respect world.maxDeployableVillagers and every event.maxUsefulVillagers; never request more people than those limits. Keep a reserve for ordinary village life. "
      + "Use the event.recommendedIntent and event.recommendedVillagers as the default response unless the facts justify a different allowed intent. "
      + "Use found_village only when hasActiveVillage is false, villageCount is zero, and there are no active events. "
      + "If there is no actionable threat, no deployable villager, or no safe response, return an empty intents array with a concise explanation. "
      + "Return zero to five concise intents, ordered by priority, and do not duplicate the same event.",
  ],
  ["human", `Plan for this compact simulation snapshot:\n${JSON.stringify(request)}`],
];

export const createGeminiPlannerProvider = (
  options: GeminiPlannerOptions = {},
): PlannerProvider => {
  const apiKey = options.apiKey ?? process.env.GOOGLE_API_KEY;
  const modelName = options.modelName || process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  const logger = options.logger;
  let invoker = options.structuredInvoker;
  let toolModel = options.toolModel;

  return {
    async plan(request) {
      if (invoker !== undefined) {
        const structuredInvoker = invoker;
        const messages = plannerMessages(request);
        await logger?.log("gemini_plan_started", {
          provider: "google-gemini",
          modelName,
          requestId: request.requestId,
          plannerRequest: request,
          messages,
          schemas: {
            geminiStructuredOutput: "Gemini-compatible enum schema; strict Zod contract applied after normalization.",
            strictAppValidation: "AIPlannerResponseSchema",
            intentVocabulary,
          },
        });

        const invokeAndValidate = async (
          attempt: GeminiAttemptKind,
          attemptMessages: PlannerMessage[],
        ): Promise<PlannerResponse> => {
          const recorder = new GoogleRequestRecorder();
          const startedAt = Date.now();
          await logger?.log("gemini_attempt_started", {
            attempt,
            modelName,
            requestId: request.requestId,
            messages: attemptMessages,
          });
          try {
            const output = await structuredInvoker.invoke(attemptMessages, { callbacks: [recorder] });
            const parsedOutput = getStructuredParsedOutput(output);
            const normalizedOutput = normalizeProviderOutput(parsedOutput);
            const validated = AIPlannerResponseSchema.safeParse(normalizedOutput);
            await logger?.log("gemini_attempt_completed", {
              attempt,
              modelName,
              requestId: request.requestId,
              durationMs: Date.now() - startedAt,
              rawLangChainOutput: output,
              parsedStructuredOutput: parsedOutput,
              normalizedOutput,
              strictValidation: {
                success: validated.success,
                issues: validationIssues(validated),
              },
              usage: collectUsageMetadata(output, recorder),
              recordedGoogleRequest: recorder.request,
              recordedGoogleResponse: recorder.response,
              recordedGoogleChunks: recorder.chunk,
            });
            if (!validated.success) throw new ProviderOutputValidationError();
            return validated.data;
          } catch (error) {
            const failureType = classifyProviderFailure(error);
            await logger?.log("gemini_attempt_failed", {
              attempt,
              modelName,
              requestId: request.requestId,
              durationMs: Date.now() - startedAt,
              failureType,
              error,
              recordedGoogleRequest: recorder.request,
              recordedGoogleResponse: recorder.response,
              recordedGoogleChunks: recorder.chunk,
              usage: collectUsageMetadata(null, recorder),
            });
            throw error;
          }
        };

        try {
          const plan = await invokeAndValidate("initial", messages);
          await logger?.log("gemini_plan_completed", {
            modelName,
            requestId: request.requestId,
            plan,
            source: "ai",
          });
          return plan;
        } catch (error) {
          if (!shouldRepairAfterFailure(error)) {
            const failureType = classifyProviderFailure(error);
            await logger?.log("gemini_plan_failed", {
              modelName,
              requestId: request.requestId,
              failureType,
              error,
              repairAttempted: false,
            });
            throw new PlannerProviderError(failureType);
          }

          const repairMessages: PlannerMessage[] = [
            ...messages,
            [
              "human",
              "Repair the previous attempt: follow the schema exactly, use zero to five allowed high-level intents, respect the supplied deployment limits, and return no extra fields.",
            ],
          ];
          await logger?.log("gemini_repair_requested", {
            modelName,
            requestId: request.requestId,
            previousFailureType: classifyProviderFailure(error),
            previousError: error,
            repairMessages,
          });
          try {
            const repairedPlan = await invokeAndValidate("repair", repairMessages);
            await logger?.log("gemini_plan_completed", {
              modelName,
              requestId: request.requestId,
              plan: repairedPlan,
              source: "ai",
              repaired: true,
            });
            return repairedPlan;
          } catch (repairError) {
            const failureType = classifyProviderFailure(repairError);
            await logger?.log("gemini_plan_failed", {
              modelName,
              requestId: request.requestId,
              failureType,
              error: repairError,
              repairAttempted: true,
            });
            throw new PlannerProviderError(failureType);
          }
        }
      }

      const pendingIntents: PlannerIntent[] = [];
      const tools = createPlannerTools(request, pendingIntents);
      if (toolModel === undefined) {
        if (apiKey === undefined || apiKey.length === 0) throw new PlannerProviderError();
        toolModel = new ChatGoogle({ apiKey, model: modelName });
      }
      const activeInvoker = toolModel.bindTools(tools);
      const toolByName = new Map(tools.map((plannerTool) => [plannerTool.name, plannerTool]));

      const messages = toolPlannerMessages(request);
      await logger?.log("gemini_plan_started", {
        provider: "google-gemini",
        modelName,
        requestId: request.requestId,
        plannerRequest: request,
        messages,
        schemas: {
          langChainTools: tools.map((plannerTool) => plannerTool.name),
          strictAppValidation: "AIPlannerResponseSchema",
          intentVocabulary,
        },
      });

      const invokeToolPlanner = async (
        attempt: ToolAttemptKind,
        attemptMessages: BaseMessage[],
      ): Promise<unknown> => {
        const recorder = new GoogleRequestRecorder();
        const startedAt = Date.now();
        await logger?.log("gemini_tool_attempt_started", {
          attempt,
          modelName,
          requestId: request.requestId,
          messages: attemptMessages,
        });
        try {
          const output = await activeInvoker.invoke(attemptMessages, { callbacks: [recorder] });
          await logger?.log("gemini_tool_attempt_completed", {
            attempt,
            modelName,
            requestId: request.requestId,
            durationMs: Date.now() - startedAt,
            rawLangChainOutput: output,
            toolCalls: toolCallsFromOutput(output),
            usage: collectUsageMetadata(output, recorder),
            recordedGoogleRequest: recorder.request,
            recordedGoogleResponse: recorder.response,
            recordedGoogleChunks: recorder.chunk,
          });
          return output;
        } catch (error) {
          const failureType = classifyProviderFailure(error);
          await logger?.log("gemini_tool_attempt_failed", {
            attempt,
            modelName,
            requestId: request.requestId,
            durationMs: Date.now() - startedAt,
            failureType,
            error,
            recordedGoogleRequest: recorder.request,
            recordedGoogleResponse: recorder.response,
            recordedGoogleChunks: recorder.chunk,
            usage: collectUsageMetadata(null, recorder),
          });
          throw error;
        }
      };

      const runToolLoop = async (
        initialAttempt: ToolAttemptKind,
        initialMessages: BaseMessage[],
      ): Promise<PlannerResponse> => {
        let conversation = initialMessages;
        let finalOutput: unknown = null;
        let sawActionTool = false;
        for (let step = 0; step < MAX_TOOL_LOOP_STEPS; step += 1) {
          finalOutput = await invokeToolPlanner(step === 0 ? initialAttempt : "tool_followup", conversation);
          const toolCalls = toolCallsFromOutput(finalOutput);
          if (toolCalls.length === 0) {
            const plan = {
              planId: planIdForRequest(request.requestId),
              summary: summaryFromOutput(
                finalOutput,
                pendingIntents.length > 0
                  ? `Committed ${pendingIntents.length} planner action${pendingIntents.length === 1 ? "" : "s"}.`
                  : "No strategic action was selected.",
              ),
              intents: pendingIntents,
            };
            const validated = AIPlannerResponseSchema.safeParse(plan);
            if (!validated.success) throw new ProviderOutputValidationError();
            return validated.data;
          }

          if (AIMessage.isInstance(finalOutput)) conversation = [...conversation, finalOutput];
          else conversation = [...conversation, new AIMessage("")];

          const toolMessages: ToolMessage[] = [];
          for (const call of toolCalls) {
            const selectedTool = toolByName.get(call.name);
            if (selectedTool === undefined) throw new ProviderOutputValidationError();
            const beforeIntentCount = pendingIntents.length;
            const content = await selectedTool.invoke(call.args as never);
            if (actionToolNames.has(call.name)) sawActionTool = true;
            await logger?.log("gemini_tool_called", {
              modelName,
              requestId: request.requestId,
              toolName: call.name,
              toolCallId: call.id,
              args: call.args,
              result: content,
              pendingIntentCount: pendingIntents.length,
              committedIntent: pendingIntents.length > beforeIntentCount,
            });
            toolMessages.push(new ToolMessage({
              content: String(content),
              name: call.name,
              tool_call_id: call.id,
              status: "success",
            }));
          }
          conversation = [...conversation, ...toolMessages];
        }

        if (sawActionTool && pendingIntents.length > 0) {
          const plan = {
            planId: planIdForRequest(request.requestId),
            summary: summaryFromOutput(
              finalOutput,
              `Committed ${pendingIntents.length} planner action${pendingIntents.length === 1 ? "" : "s"}.`,
            ),
            intents: pendingIntents,
          };
          const validated = AIPlannerResponseSchema.safeParse(plan);
          if (!validated.success) throw new ProviderOutputValidationError();
          return validated.data;
        }
        throw new ProviderOutputValidationError();
      };

      try {
        const plan = await runToolLoop("initial", messages);
        await logger?.log("gemini_plan_completed", {
          modelName,
          requestId: request.requestId,
          plan,
          source: "ai",
        });
        return plan;
      } catch (error) {
        if (!shouldRepairAfterFailure(error)) {
          const failureType = classifyProviderFailure(error);
          await logger?.log("gemini_plan_failed", {
            modelName,
            requestId: request.requestId,
            failureType,
            error,
            repairAttempted: false,
          });
          throw new PlannerProviderError(failureType);
        }

        pendingIntents.length = 0;
        const repairMessages = [
          ...messages,
          new HumanMessage(
            "Repair the previous attempt: use the provided LangChain tools to inspect the snapshot if needed, then call one to five action tools or explain why no action is safe. Do not invent event IDs or exceed deployment limits.",
          ),
        ];
        await logger?.log("gemini_repair_requested", {
          modelName,
          requestId: request.requestId,
          previousFailureType: classifyProviderFailure(error),
          previousError: error,
          repairMessages,
        });
        try {
          const repairedPlan = await runToolLoop("repair", repairMessages);
          await logger?.log("gemini_plan_completed", {
            modelName,
            requestId: request.requestId,
            plan: repairedPlan,
            source: "ai",
            repaired: true,
          });
          return repairedPlan;
        } catch (repairError) {
          const failureType = classifyProviderFailure(repairError);
          await logger?.log("gemini_plan_failed", {
            modelName,
            requestId: request.requestId,
            failureType,
            error: repairError,
            repairAttempted: true,
          });
          throw new PlannerProviderError(failureType);
        }
      }
    },
  };
};

class BodyTooLargeError extends Error {}
class ProviderTimeoutError extends Error {}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...headers,
    },
  });

const safeError = (status: number, code: string, message: string): Response =>
  json(status, { error: { code, message } });

const readBoundedBody = async (request: Request): Promise<string> => {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > MAX_REQUEST_BYTES) throw new BodyTooLargeError();
  }
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    body += decoder.decode(value, { stream: true });
  }
  return body + decoder.decode();
};

export interface PlannerHandlerOptions {
  provider: PlannerProvider;
  timeoutMs: number;
}

export const createPlannerHandler = ({ provider, timeoutMs }: PlannerHandlerOptions) => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Planner provider timeout must be positive and finite.");
  }

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return json(
        405,
        { error: { code: "method_not_allowed", message: "Only POST is allowed." } },
        { Allow: "POST" },
      );
    }

    let body: string;
    try {
      body = await readBoundedBody(request);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return safeError(413, "body_too_large", "Request body exceeded 64 KiB.");
      }
      return safeError(400, "invalid_body", "Request body could not be read.");
    }

    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      return safeError(400, "malformed_json", "Request body was not valid JSON.");
    }
    const parsed = PlannerRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return safeError(400, "invalid_request", "Planner request failed validation.");
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProviderTimeoutError()), timeoutMs);
      });
      const output = await Promise.race([provider.plan(parsed.data), timeout]);
      const plan = AIPlannerResponseSchema.safeParse(output);
      if (!plan.success) {
        return safeError(502, "invalid_provider_output", "Planner provider returned an invalid plan.");
      }
      return json(200, plan.data);
    } catch (error) {
      if (error instanceof ProviderTimeoutError) {
        return safeError(504, "provider_timeout", "Planner provider timed out.");
      }
      return safeError(502, "provider_error", "Planner provider failed.");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
};
