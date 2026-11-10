import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import {
  documents,
  issueDocuments,
  issuePhaseTransitions,
  issues,
  issueWorkProducts,
  type Db,
} from "@paperclipai/db";
import {
  evaluateLifecyclePhaseExitGate,
  type IssuePhaseSummary,
  type IssuePhaseTransition,
  type IssuePhaseTransitionKind,
  type IssuePhaseTransitionRequest,
  type LifecyclePhaseGateGap,
  type ProjectLifecycle,
  type ProjectLifecyclePhase,
} from "@paperclipai/shared";
import { conflict, HttpError, unprocessable } from "../errors.js";
import { clearExecutionStageProgress, normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import { instanceSettingsService } from "./instance-settings.js";
import { persistActivity } from "./activity-log.js";
import { projectLifecycleService } from "./project-lifecycles.js";

type IssueRow = typeof issues.$inferSelect;

/** Work products that no longer count as evidence for a gate. */
const INACTIVE_WORK_PRODUCT_STATUSES = ["closed", "failed", "archived"];

export type ActiveProjectLifecycle = ProjectLifecycle & { mode: "advisory" | "enforced" };

export type PlannedPhaseTransition = {
  projectId: string;
  fromPhaseKey: string | null;
  toPhaseKey: string;
  kind: IssuePhaseTransitionKind;
  lifecycleMode: ActiveProjectLifecycle["mode"];
  reason: string | null;
  gateGaps: LifecyclePhaseGateGap[];
};

export type PhasePlan = {
  /** Issue fields to apply in the same write as the transition. */
  issuePatch: Partial<typeof issues.$inferInsert>;
  transition: PlannedPhaseTransition;
};

/** Server-owned request for an explicit phase move; never read from HTTP input directly. */
export type IssuePhaseMove = IssuePhaseTransitionRequest & { actorIsBoard: boolean };

export type PhaseActor = { agentId: string | null; userId: string | null; runId: string | null };

/** Fields only phase transitions may write. */
export const SERVER_OWNED_PHASE_FIELDS = ["phaseKey", "phaseVersion", "phaseEnteredAt"] as const;

/** Lifecycle that currently governs the project, or null when off, absent or disabled. */
export async function loadActiveProjectLifecycle(
  db: Db,
  companyId: string,
  projectId: string | null | undefined,
): Promise<ActiveProjectLifecycle | null> {
  if (!projectId) return null;
  if (!(await instanceSettingsService(db).getExperimental()).enableProjectLifecycles) return null;
  const lifecycle = await projectLifecycleService(db).getProjectLifecycle(companyId, projectId);
  if (!lifecycle || lifecycle.mode === "off") return null;
  return lifecycle as ActiveProjectLifecycle;
}

/**
 * Fields for entering `phase`: the phase owner (when set) takes the task, its
 * review/approval stages replace the task's stages, and stage progress resets.
 * Other execution-policy settings and monitor state are kept.
 */
export function phaseEntryPatch(
  issue: Pick<IssueRow, "phaseVersion" | "executionPolicy" | "executionState">,
  phase: ProjectLifecyclePhase,
  now: Date,
): Partial<typeof issues.$inferInsert> {
  const currentPolicy = normalizeIssueExecutionPolicy(issue.executionPolicy ?? null);
  const nextPolicy = currentPolicy || phase.exitGate.stages.length > 0
    ? normalizeIssueExecutionPolicy({ ...(currentPolicy ?? {}), stages: phase.exitGate.stages })
    : null;
  return {
    phaseKey: phase.key,
    phaseVersion: issue.phaseVersion + 1,
    phaseEnteredAt: now,
    status: "todo",
    ...(phase.ownerAgentId
      ? { assigneeAgentId: phase.ownerAgentId, assigneeUserId: null }
      : phase.ownerUserId
        ? { assigneeAgentId: null, assigneeUserId: phase.ownerUserId }
        : {}),
    executionPolicy: nextPolicy as Record<string, unknown> | null,
    executionState: clearExecutionStageProgress(issue.executionState) as Record<string, unknown> | null,
  };
}

/** Top-level tasks created in a lifecycle project start in its first phase. */
export async function planInitialPhase(
  db: Db,
  companyId: string,
  input: { projectId?: string | null; parentId?: string | null; conversationAgentId?: string | null },
): Promise<{ phase: ProjectLifecyclePhase; lifecycle: ActiveProjectLifecycle } | null> {
  if (input.parentId || input.conversationAgentId) return null;
  const lifecycle = await loadActiveProjectLifecycle(db, companyId, input.projectId);
  const phase = lifecycle?.phases[0];
  return lifecycle && phase ? { phase, lifecycle } : null;
}

export async function readPhaseGateFacts(db: Db, issue: Pick<IssueRow, "id" | "companyId">) {
  const [documentRows, workProductRows, [openChildren]] = await Promise.all([
    db.select({ key: issueDocuments.key }).from(issueDocuments)
      .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
      .where(and(
        eq(issueDocuments.companyId, issue.companyId),
        eq(issueDocuments.issueId, issue.id),
        sql`length(trim(${documents.latestBody})) > 0`,
      )),
    db.select({ type: issueWorkProducts.type }).from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, issue.companyId),
        eq(issueWorkProducts.issueId, issue.id),
        notInArray(issueWorkProducts.status, INACTIVE_WORK_PRODUCT_STATUSES),
      )),
    db.select({ count: sql<number>`count(*)::int` }).from(issues)
      .where(and(
        eq(issues.companyId, issue.companyId),
        eq(issues.parentId, issue.id),
        notInArray(issues.status, ["done", "cancelled"]),
      )),
  ]);
  return {
    documentKeys: documentRows.map(row => row.key),
    workProductTypes: workProductRows.map(row => row.type),
    openChildCount: openChildren?.count ?? 0,
  };
}

/**
 * A `done` request in a phased task. Enforced lifecycles reject an unmet exit
 * gate; advisory ones record the gaps. Non-terminal phases advance instead of
 * closing the task. Returns null when no lifecycle applies.
 */
export async function planPhaseCompletion(db: Db, existing: IssueRow, now: Date): Promise<PhasePlan | null> {
  if (!existing.phaseKey) return null;
  const lifecycle = await loadActiveProjectLifecycle(db, existing.companyId, existing.projectId);
  if (!lifecycle) return null;
  const index = lifecycle.phases.findIndex(phase => phase.key === existing.phaseKey);
  if (index < 0) {
    if (lifecycle.mode === "advisory") return null;
    throw unprocessable("The task's phase is no longer part of the project lifecycle; ask the board to move it", {
      code: "phase_not_in_lifecycle", phaseKey: existing.phaseKey,
    });
  }
  const phase = lifecycle.phases[index]!;
  const gateGaps = evaluateLifecyclePhaseExitGate(phase.exitGate, await readPhaseGateFacts(db, existing));
  if (gateGaps.length > 0 && lifecycle.mode === "enforced") {
    throw unprocessable(`The "${phase.name}" phase exit gate is not met`, {
      code: "phase_gate_unmet", phaseKey: phase.key, gaps: gateGaps,
    });
  }
  const base = { projectId: lifecycle.projectId, fromPhaseKey: phase.key, lifecycleMode: lifecycle.mode, reason: null, gateGaps };
  const next = lifecycle.phases[index + 1];
  if (phase.kind === "terminal" || !next) {
    return { issuePatch: {}, transition: { ...base, toPhaseKey: phase.key, kind: "complete" } };
  }
  return { issuePatch: phaseEntryPatch(existing, next, now), transition: { ...base, toPhaseKey: next.key, kind: "advance" } };
}

/**
 * The reason an enforced lifecycle would reject completing this task, or null.
 * For callers that must not throw inside their own transaction.
 */
export async function blockedPhaseCompletion(db: Db, existing: IssueRow) {
  try {
    await planPhaseCompletion(db, existing, new Date());
    return null;
  } catch (error) {
    const details = error instanceof HttpError && error.status === 422
      ? error.details as { code?: string; phaseKey?: string; gaps?: LifecyclePhaseGateGap[] } | undefined
      : undefined;
    if (details?.code === "phase_gate_unmet" || details?.code === "phase_not_in_lifecycle") return details;
    throw error;
  }
}

/**
 * Rework sends a task back to one of its phase's configured rework targets.
 * Override (board only) moves to any phase, including placing an existing
 * task into the lifecycle. Both reopen closed tasks in the target phase.
 */
export async function planPhaseMove(db: Db, existing: IssueRow, move: IssuePhaseMove, now: Date): Promise<PhasePlan> {
  const lifecycle = await loadActiveProjectLifecycle(db, existing.companyId, existing.projectId);
  if (!lifecycle) throw unprocessable("This task is not in a project with an active lifecycle");
  if (move.expectedPhaseVersion !== undefined && move.expectedPhaseVersion !== existing.phaseVersion) {
    throw conflict("The task's phase changed; reload it and retry", { currentPhaseVersion: existing.phaseVersion });
  }
  const target = lifecycle.phases.find(phase => phase.key === move.toPhaseKey);
  if (!target) throw unprocessable(`Unknown phase "${move.toPhaseKey}"`);
  if (move.kind === "override" && !move.actorIsBoard) throw unprocessable("Only the board can override a task's phase");
  if (move.kind === "rework") {
    const current = lifecycle.phases.find(phase => phase.key === existing.phaseKey);
    if (!current?.reworkTo.includes(target.key)) {
      throw unprocessable(`Rework from "${existing.phaseKey ?? "no phase"}" to "${target.key}" is not allowed`, {
        code: "phase_rework_not_allowed", allowed: current?.reworkTo ?? [],
      });
    }
  }
  return {
    issuePatch: phaseEntryPatch(existing, target, now),
    transition: {
      projectId: lifecycle.projectId,
      fromPhaseKey: existing.phaseKey,
      toPhaseKey: target.key,
      kind: move.kind,
      lifecycleMode: lifecycle.mode,
      reason: move.reason,
      gateGaps: [],
    },
  };
}

/** Appends the history row and returns the activity publication for the caller's post-commit queue. */
export async function recordPhaseTransition(
  tx: Db,
  issue: Pick<IssueRow, "id" | "companyId" | "identifier">,
  transition: PlannedPhaseTransition,
  actor: PhaseActor,
) {
  const [row] = await tx.insert(issuePhaseTransitions).values({
    companyId: issue.companyId,
    issueId: issue.id,
    projectId: transition.projectId,
    fromPhaseKey: transition.fromPhaseKey,
    toPhaseKey: transition.toPhaseKey,
    kind: transition.kind,
    lifecycleMode: transition.lifecycleMode,
    reason: transition.reason,
    gateGaps: transition.gateGaps,
    actorAgentId: actor.agentId,
    actorUserId: actor.userId,
    runId: actor.runId,
  }).returning();
  const { publication } = await persistActivity(tx, {
    companyId: issue.companyId,
    actorType: actor.agentId ? "agent" : actor.userId ? "user" : "system",
    actorId: actor.agentId ?? actor.userId ?? "project-lifecycle",
    agentId: actor.agentId,
    runId: actor.runId,
    action: "issue.phase_changed",
    entityType: "issue",
    entityId: issue.id,
    details: {
      identifier: issue.identifier,
      kind: transition.kind,
      fromPhaseKey: transition.fromPhaseKey,
      toPhaseKey: transition.toPhaseKey,
      lifecycleMode: transition.lifecycleMode,
      gateGaps: transition.gateGaps,
      ...(transition.reason ? { reason: transition.reason } : {}),
    },
  });
  return { transition: row!, publication };
}

export async function listIssuePhaseTransitions(db: Db, companyId: string, issueId: string): Promise<IssuePhaseTransition[]> {
  const rows = await db.select().from(issuePhaseTransitions)
    .where(and(eq(issuePhaseTransitions.companyId, companyId), eq(issuePhaseTransitions.issueId, issueId)))
    .orderBy(asc(issuePhaseTransitions.createdAt), asc(issuePhaseTransitions.id));
  return rows as unknown as IssuePhaseTransition[];
}

/** Phase summary for agent run context: what the current phase expects before `done`. */
export async function describeIssuePhase(db: Db, issue: IssueRow): Promise<IssuePhaseSummary | null> {
  if (!issue.phaseKey) return null;
  const lifecycle = await loadActiveProjectLifecycle(db, issue.companyId, issue.projectId);
  const index = lifecycle?.phases.findIndex(phase => phase.key === issue.phaseKey) ?? -1;
  if (!lifecycle || index < 0) return null;
  const phase = lifecycle.phases[index]!;
  const gaps = evaluateLifecyclePhaseExitGate(phase.exitGate, await readPhaseGateFacts(db, issue));
  return {
    mode: lifecycle.mode,
    phase: { key: phase.key, name: phase.name, kind: phase.kind, instructions: phase.instructions },
    position: index + 1,
    phaseCount: lifecycle.phases.length,
    phases: lifecycle.phases.map(({ key, name, kind }) => ({ key, name, kind })),
    nextPhase: lifecycle.phases[index + 1] ? { key: lifecycle.phases[index + 1]!.key, name: lifecycle.phases[index + 1]!.name } : null,
    reworkTo: phase.reworkTo,
    reviewStageCount: phase.exitGate.stages.length,
    unmetGate: gaps,
  };
}


function describeGateGap(gap: LifecyclePhaseGateGap) {
  if (gap.kind === "document") return `a non-empty task document with key \`${gap.key}\``;
  if (gap.kind === "work_product") return `an active \`${gap.type}\` work product`;
  return `${gap.count} open sub-task(s) finished or cancelled`;
}

/**
 * Phase section for an agent's run: where the task is in the lifecycle, the
 * phase instructions, and what is still missing before `done` is accepted.
 */
export async function getIssuePhaseExecutionContext(db: Db, input: { companyId: string; issueId: string }) {
  const [issue] = await db.select().from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  const phase = issue ? await describeIssuePhase(db, issue) : null;
  if (!phase) return null;
  const lines = [
    `## Lifecycle phase: ${phase.phase.name} (${phase.position} of ${phase.phaseCount}, ${phase.mode})`,
    "",
    phase.nextPhase
      ? `Marking this task done completes this phase and hands it to the next phase, "${phase.nextPhase.name}". Do only this phase's work.`
      : "This is the final phase. Marking the task done closes it.",
  ];
  if (phase.phase.instructions) lines.push("", phase.phase.instructions.trim());
  if (phase.reviewStageCount > 0) lines.push("", `Completing this phase first goes through ${phase.reviewStageCount} review/approval stage(s).`);
  if (phase.unmetGate.length > 0) {
    lines.push("", phase.mode === "enforced"
      ? "Done will be rejected until the task has:"
      : "This phase expects (advisory, not blocking):");
    for (const gap of phase.unmetGate) lines.push(`- ${describeGateGap(gap)}`);
  }
  return { context: phase, markdown: `${lines.join("\n")}\n\n` };
}
