import { z } from "zod";
import { issueDocumentKeySchema, issueExecutionStageSchema } from "./validators/issue.js";
import { issueWorkProductTypeSchema } from "./validators/work-product.js";

export const LIFECYCLE_MODES = ["off", "advisory", "enforced"] as const;
export type LifecycleMode = (typeof LIFECYCLE_MODES)[number];

export const LIFECYCLE_PHASE_KINDS = ["work", "terminal"] as const;
export type LifecyclePhaseKind = (typeof LIFECYCLE_PHASE_KINDS)[number];

export const MAX_LIFECYCLE_PHASES = 30;

export const lifecycleKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Key must be lowercase letters, numbers, _ or -");

/**
 * What must be true before an issue may leave a phase. `stages` reuse the
 * issue execution-policy review/approval stages, which already gate `done`;
 * the remaining items are checked by `evaluateLifecyclePhaseExitGate`.
 */
export const lifecyclePhaseExitGateSchema = z.object({
  requiredDocuments: z.array(issueDocumentKeySchema).max(20).default([]),
  requireChildrenTerminal: z.boolean().default(false),
  requiredWorkProductTypes: z.array(issueWorkProductTypeSchema).max(7).default([]),
  stages: z.array(issueExecutionStageSchema).max(5).default([]),
}).strict();

export const lifecyclePhaseSchema = z.object({
  key: lifecycleKeySchema,
  name: z.string().trim().min(1).max(120),
  kind: z.enum(LIFECYCLE_PHASE_KINDS).default("work"),
  ownerAgentId: z.string().uuid().nullable().default(null),
  ownerUserId: z.string().trim().min(1).max(200).nullable().default(null),
  instructions: z.string().max(20_000).nullable().default(null),
  exitGate: lifecyclePhaseExitGateSchema.prefault({}),
  reworkTo: z.array(lifecycleKeySchema).max(MAX_LIFECYCLE_PHASES).default([]),
}).strict().superRefine((phase, ctx) => {
  if (phase.ownerAgentId && phase.ownerUserId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A phase has at most one owner", path: ["ownerUserId"] });
  }
});

/**
 * Ordered phases: unique keys, exactly one terminal phase in last position,
 * and rework only back to an earlier phase.
 */
export const lifecyclePhaseListSchema = z.array(lifecyclePhaseSchema).min(1).max(MAX_LIFECYCLE_PHASES)
  .superRefine((phases, ctx) => {
    const positions = new Map<string, number>();
    phases.forEach((phase, index) => {
      if (positions.has(phase.key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate phase key "${phase.key}"`, path: [index, "key"] });
      }
      positions.set(phase.key, index);
    });
    const terminal = phases.flatMap((phase, index) => phase.kind === "terminal" ? [index] : []);
    if (terminal.length !== 1 || terminal[0] !== phases.length - 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Exactly one terminal phase is required, and it must be last" });
    }
    phases.forEach((phase, index) => {
      phase.reworkTo.forEach((target, targetIndex) => {
        const targetPosition = positions.get(target);
        if (targetPosition === undefined || targetPosition >= index) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Rework target "${target}" must be an earlier phase`,
            path: [index, "reworkTo", targetIndex],
          });
        }
      });
    });
  });

export const createLifecycleTemplateSchema = z.object({
  key: lifecycleKeySchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).nullable().optional(),
  phases: lifecyclePhaseListSchema,
}).strict();

export const updateLifecycleTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2_000).nullable().optional(),
  phases: lifecyclePhaseListSchema.optional(),
  archived: z.boolean().optional(),
}).strict().refine(value => Object.values(value).some(entry => entry !== undefined), "Provide at least one field");

export const listLifecycleTemplatesQuerySchema = z.object({
  includeArchived: z.enum(["true", "false"]).transform(value => value === "true").optional(),
}).strict();

/**
 * Replace a project's lifecycle. Supply `templateId` to copy a template's
 * phases, `phases` to set them directly, or neither to change only `mode` of
 * an existing lifecycle. `expectedVersion` rejects a stale edit with 409.
 */
export const putProjectLifecycleSchema = z.object({
  mode: z.enum(LIFECYCLE_MODES),
  templateId: z.string().uuid().optional(),
  phases: lifecyclePhaseListSchema.optional(),
  expectedVersion: z.number().int().positive().optional(),
}).strict().refine(value => !(value.templateId && value.phases), "Provide templateId or phases, not both");

export const ISSUE_PHASE_TRANSITION_KINDS = ["initial", "advance", "complete", "rework", "override"] as const;
export type IssuePhaseTransitionKind = (typeof ISSUE_PHASE_TRANSITION_KINDS)[number];

/**
 * Explicit phase moves. `rework` sends a task back to one of the current
 * phase's `reworkTo` phases; `override` (board only) moves to any phase.
 * Forward moves happen by completing the task, so the exit gate always runs.
 */
export const issuePhaseTransitionRequestSchema = z.object({
  kind: z.enum(["rework", "override"]),
  toPhaseKey: lifecycleKeySchema,
  reason: z.string().trim().min(1).max(2_000),
  expectedPhaseVersion: z.number().int().nonnegative().optional(),
}).strict();

export type IssuePhaseTransitionRequest = z.infer<typeof issuePhaseTransitionRequestSchema>;

export type LifecyclePhaseExitGate = z.infer<typeof lifecyclePhaseExitGateSchema>;
export type LifecyclePhaseInput = z.input<typeof lifecyclePhaseSchema>;
export type LifecyclePhaseDefinition = z.infer<typeof lifecyclePhaseSchema>;
export type CreateLifecycleTemplate = z.infer<typeof createLifecycleTemplateSchema>;
export type UpdateLifecycleTemplate = z.infer<typeof updateLifecycleTemplateSchema>;
export type PutProjectLifecycle = z.infer<typeof putProjectLifecycleSchema>;

export interface LifecycleTemplate {
  id: string;
  companyId: string;
  key: string;
  name: string;
  description: string | null;
  phases: LifecyclePhaseDefinition[];
  archivedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface ProjectLifecyclePhase extends LifecyclePhaseDefinition {
  id: string;
  position: number;
}

export interface ProjectLifecycle {
  companyId: string;
  projectId: string;
  templateId: string | null;
  mode: LifecycleMode;
  version: number;
  phases: ProjectLifecyclePhase[];
  updatedAt: Date | string;
}

export interface IssuePhaseTransition {
  id: string;
  companyId: string;
  issueId: string;
  projectId: string;
  fromPhaseKey: string | null;
  toPhaseKey: string;
  kind: IssuePhaseTransitionKind;
  lifecycleMode: LifecycleMode;
  reason: string | null;
  gateGaps: LifecyclePhaseGateGap[];
  actorAgentId: string | null;
  actorUserId: string | null;
  runId: string | null;
  createdAt: Date | string;
}

/** Observable facts about an issue, gathered by the server when a phase exit is requested. */
export interface LifecyclePhaseGateFacts {
  documentKeys: readonly string[];
  workProductTypes: readonly string[];
  openChildCount: number;
}

export type LifecyclePhaseGateGap =
  | { kind: "document"; key: string }
  | { kind: "work_product"; type: string }
  | { kind: "open_children"; count: number };

/**
 * Lists unmet non-stage exit-gate items. Review/approval `stages` are not
 * evaluated here: the issue execution policy enforces them before `done`.
 */
export function evaluateLifecyclePhaseExitGate(
  gate: LifecyclePhaseExitGate,
  facts: LifecyclePhaseGateFacts,
): LifecyclePhaseGateGap[] {
  const documents = new Set(facts.documentKeys);
  const workProducts = new Set(facts.workProductTypes);
  return [
    ...gate.requiredDocuments.filter(key => !documents.has(key)).map(key => ({ kind: "document" as const, key })),
    ...gate.requiredWorkProductTypes.filter(type => !workProducts.has(type)).map(type => ({ kind: "work_product" as const, type })),
    ...(gate.requireChildrenTerminal && facts.openChildCount > 0
      ? [{ kind: "open_children" as const, count: facts.openChildCount }]
      : []),
  ];
}
