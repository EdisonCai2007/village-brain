import { z } from "zod";

const IdentifierSchema = z.string().min(1).max(120);
const CoordinateSchema = z.number().finite();

const AreaSchema = z.object({
  id: IdentifierSchema,
  x: CoordinateSchema,
  y: CoordinateSchema,
  capacity: z.number().int().min(0).max(100_000),
}).strict();

const IntentFields = {
  villagerCount: z.number().int().min(1).max(100),
  priority: z.number().int().min(1).max(5),
  rationale: z.string().min(1).max(240),
};

const targetedIntent = <T extends string>(type: T) => z.object({
  type: z.literal(type),
  targetEventId: IdentifierSchema,
  ...IntentFields,
}).strict();

const AreaStrategySchema = z.enum([
  "nearest_safe_area",
  "least_impacted_area",
  "new_village_site",
  "separate_groups",
]);

const areaIntent = <T extends string>(type: T) => z.object({
  type: z.literal(type),
  strategy: AreaStrategySchema,
  targetEventId: IdentifierSchema.optional(),
  ...IntentFields,
}).strict();

export const PlannerIntentSchema = z.discriminatedUnion("type", [
  targetedIntent("fight_fire"),
  targetedIntent("defend_event"),
  targetedIntent("rescue_trapped"),
  targetedIntent("isolate_sick"),
  areaIntent("relocate"),
  areaIntent("found_village"),
  areaIntent("split_villagers"),
]);

export const PlannerResponseSchema = z.object({
  planId: IdentifierSchema,
  summary: z.string().min(1).max(480),
  intents: z.array(PlannerIntentSchema).max(5),
}).strict();

// A provider may return a deliberate no-op when no safe action is available.
export const AIPlannerResponseSchema = PlannerResponseSchema.extend({
  intents: z.array(PlannerIntentSchema).max(5),
}).strict();

const WorldSnapshotSchema = z.object({
  simulationTimeMs: z.number().int().min(0),
  seed: z.number().int(),
  villageCount: z.number().int().min(0),
  availableVillagers: z.number().int().min(0),
  hasActiveVillage: z.boolean().optional(),
  minimumReserveVillagers: z.number().int().min(0).optional(),
  maxDeployableVillagers: z.number().int().min(0).optional(),
  livingVillagers: z.number().int().min(0).optional(),
  sickVillagers: z.number().int().min(0).optional(),
  trappedVillagers: z.number().int().min(0).optional(),
  assignedVillagers: z.number().int().min(0).optional(),
  safeAreas: z.array(AreaSchema).max(20),
}).strict();

const ActiveEventSchema = z.object({
  id: IdentifierSchema,
  type: z.enum(["fire", "tsunami", "bandits", "earthquake", "plague"]),
  x: CoordinateSchema,
  y: CoordinateSchema,
  severity: z.number().int().min(1).max(5),
  likelyImpactCount: z.number().int().min(0),
  distanceToVillage: z.number().int().min(0).optional(),
  etaMs: z.number().int().min(0).nullable().optional(),
  facts: z.array(z.string().min(1).max(120)).max(4).optional(),
  recommendedIntent: z.enum([
    "fight_fire",
    "defend_event",
    "rescue_trapped",
    "isolate_sick",
    "relocate",
  ]).optional(),
  recommendedVillagers: z.number().int().min(0).max(100).optional(),
  maxUsefulVillagers: z.number().int().min(0).max(100).optional(),
  threatensVillage: z.boolean().optional(),
}).strict();

const RecentPlanSchema = z.object({
  planId: IdentifierSchema,
  source: z.enum(["ai", "fallback"]),
  summary: z.string().min(1).max(480),
  outcome: z.string().min(1).max(480),
}).strict();

export const PlannerRequestSchema = z.object({
  requestId: IdentifierSchema,
  world: WorldSnapshotSchema,
  activeEvents: z.array(ActiveEventSchema).max(20),
  recentPlans: z.array(RecentPlanSchema).max(5),
}).strict();

export type PlannerIntent = z.infer<typeof PlannerIntentSchema>;
export type PlannerRequest = z.infer<typeof PlannerRequestSchema>;
export type PlannerResponse = z.infer<typeof PlannerResponseSchema>;
export type AIPlannerResponse = z.infer<typeof AIPlannerResponseSchema>;
