import { SUGGESTED_COMPANY_ROLES } from "@paperclipai/shared";
import type {
  CompanyRole,
  CreateCompanyRole,
  IssueExecutionPolicy,
  IssueExecutionStagePrincipal,
  IssueExecutionState,
} from "@paperclipai/shared";
import { ApiError } from "../api/client";

export type CompanyRoleMap = ReadonlyMap<string, Pick<CompanyRole, "id" | "name" | "archivedAt">>;

export function buildCompanyRoleMap(roles: readonly CompanyRole[] | null | undefined): Map<string, CompanyRole> {
  return new Map((roles ?? []).map((role) => [role.id, role]));
}

/** Roles that may be offered in pickers: archived roles are never offered. */
export function selectableCompanyRoles(roles: readonly CompanyRole[] | null | undefined): CompanyRole[] {
  return (roles ?? [])
    .filter((role) => !role.archivedAt)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Label for a role participant, e.g. "Role: QA". Archived roles stay readable
 * on policies that still name them; unknown ids (not loaded, or deleted) get a
 * neutral label instead of a blank.
 */
export function formatRoleParticipantLabel(roleId: string | null | undefined, roleMap: CompanyRoleMap | null | undefined): string {
  const role = roleId ? roleMap?.get(roleId) : undefined;
  if (!role) return "Role: unknown";
  return role.archivedAt ? `Role: ${role.name} (archived)` : `Role: ${role.name}`;
}

/** Generic label for any execution-stage principal (agent, user or role). */
export function formatStagePrincipalLabel(
  principal: IssueExecutionStagePrincipal | null | undefined,
  resolvers: {
    agentLabel: (agentId: string | null | undefined) => string | null | undefined;
    userLabel: (userId: string | null | undefined) => string | null | undefined;
    roleMap?: CompanyRoleMap | null;
  },
): string | null {
  if (!principal) return null;
  if (principal.type === "agent") return resolvers.agentLabel(principal.agentId) ?? "Agent";
  if (principal.type === "role") return formatRoleParticipantLabel(principal.roleId, resolvers.roleMap);
  return resolvers.userLabel(principal.userId) ?? "User";
}

/** Suggested starter roles whose keys do not exist yet (archived roles count as existing). */
export function missingSuggestedRoles(roles: readonly CompanyRole[] | null | undefined): CreateCompanyRole[] {
  const existing = new Set((roles ?? []).map((role) => role.key));
  return SUGGESTED_COMPANY_ROLES.filter((role) => !existing.has(role.key)).map((role) => ({ ...role }));
}

/** Lowercase slug for a role key derived from its name. */
export function roleKeyFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

export type StageDecisionEligibility =
  | { canDecide: false; reason: "no_pending_stage" | "not_signed_in" | "work_under_review" | "not_a_participant" }
  | { canDecide: true; via: "participant" }
  | { canDecide: true; via: "role"; roleIds: string[] };

/**
 * Whether `currentUserId` may approve or request changes on the issue's active
 * execution stage. Mirrors the server: the assigned participant may decide, and
 * so may any current holder of a (non-archived) role the active stage names —
 * except the person whose work is under review (`returnAssignee`).
 */
export function stageDecisionEligibility(input: {
  executionPolicy: IssueExecutionPolicy | null | undefined;
  executionState: IssueExecutionState | null | undefined;
  currentUserId: string | null | undefined;
  roles: readonly CompanyRole[] | null | undefined;
}): StageDecisionEligibility {
  const { executionPolicy, executionState, currentUserId } = input;
  if (!executionState || executionState.status !== "pending" || !executionState.currentStageId) {
    return { canDecide: false, reason: "no_pending_stage" };
  }
  if (!currentUserId) return { canDecide: false, reason: "not_signed_in" };

  const current = executionState.currentParticipant;
  if (current?.type === "user" && current.userId === currentUserId) {
    return { canDecide: true, via: "participant" };
  }
  const returnAssignee = executionState.returnAssignee;
  if (returnAssignee?.type === "user" && returnAssignee.userId === currentUserId) {
    return { canDecide: false, reason: "work_under_review" };
  }

  const stage = executionPolicy?.stages?.find((candidate) => candidate.id === executionState.currentStageId);
  const stageRoleIds = new Set(
    (stage?.participants ?? [])
      .filter((participant) => participant.type === "role" && participant.roleId)
      .map((participant) => participant.roleId as string),
  );
  if (stageRoleIds.size === 0) return { canDecide: false, reason: "not_a_participant" };

  const heldRoleIds = (input.roles ?? [])
    .filter((role) => stageRoleIds.has(role.id) && !role.archivedAt)
    .filter((role) => role.holders.some((holder) => holder.userId === currentUserId))
    .map((role) => role.id);
  if (heldRoleIds.length === 0) return { canDecide: false, reason: "not_a_participant" };
  return { canDecide: true, via: "role", roleIds: heldRoleIds };
}

/** True when the server refused a decision because the user already approved another gate under a different role. */
export function isSeparationOfDutiesError(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 422) return false;
  if (error.code === "separation_of_duties") return true;
  const body = error.body && typeof error.body === "object" ? (error.body as Record<string, unknown>) : null;
  const details = body?.details && typeof body.details === "object" ? (body.details as Record<string, unknown>) : null;
  return details?.code === "separation_of_duties";
}

/** Readable copy for a failed stage decision. */
export function stageDecisionErrorMessage(error: unknown): string {
  if (isSeparationOfDutiesError(error)) {
    const message = error instanceof Error ? error.message : "";
    return message && !/^separation_of_duties$/i.test(message)
      ? message
      : "Separation of duties: you already approved another gate on this task under a different role. Another holder of this role must approve.";
  }
  return error instanceof Error && error.message ? error.message : "The decision could not be recorded.";
}
