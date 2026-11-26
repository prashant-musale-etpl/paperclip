import { describe, expect, it } from "vitest";
import type { IssueExecutionState } from "@paperclipai/shared";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  policyRoleIds,
  resolveRoleParticipants,
} from "../services/issue-execution-policy.ts";

const coderAgentId = "11111111-1111-4111-8111-111111111111";
const baRoleId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const qaRoleId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const elRoleId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function rolePolicy(...stages: Array<{ type: "review" | "approval"; roleId: string }>) {
  return normalizeIssueExecutionPolicy({
    stages: stages.map((stage) => ({ type: stage.type, participants: [{ type: "role", roleId: stage.roleId }] })),
  })!;
}

/** Moves an agent-implemented issue into the first role-gated stage. */
function startReview(policy: ReturnType<typeof rolePolicy>, roleHolders: Record<string, string[]>) {
  const result = applyIssueExecutionPolicyTransition({
    issue: { status: "in_progress", assigneeAgentId: coderAgentId },
    policy,
    requestedStatus: "done",
    requestedAssigneePatch: {},
    actor: { agentId: coderAgentId },
    roleHolders,
  });
  return {
    status: result.patch.status as string,
    assigneeAgentId: (result.patch.assigneeAgentId ?? null) as string | null,
    assigneeUserId: (result.patch.assigneeUserId ?? null) as string | null,
    executionState: result.patch.executionState as IssueExecutionState,
  };
}

describe("role participants", () => {
  it("are kept by normalization and listed by policyRoleIds", () => {
    const policy = rolePolicy({ type: "approval", roleId: qaRoleId });
    expect(policy.stages[0]?.participants).toEqual([
      expect.objectContaining({ type: "role", roleId: qaRoleId, agentId: null, userId: null }),
    ]);
    expect(policyRoleIds(policy)).toEqual([qaRoleId]);
  });

  it("reject a role participant without a roleId", () => {
    expect(() => normalizeIssueExecutionPolicy({ stages: [{ type: "approval", participants: [{ type: "role" }] }] }))
      .toThrow();
  });

  it("resolve to one user participant per holder, merging holders of several roles", () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [{
        type: "approval",
        participants: [{ type: "role", roleId: baRoleId }, { type: "role", roleId: qaRoleId }],
      }],
    })!;
    const resolved = resolveRoleParticipants(policy, { [baRoleId]: ["ana", "sam"], [qaRoleId]: ["sam"] })!;
    expect(resolved.stages[0]?.participants.map((participant) => [participant.type, participant.userId])).toEqual([
      ["user", "ana"],
      ["user", "sam"],
    ]);
    // The stored policy is unchanged.
    expect(policy.stages[0]?.participants.every((participant) => participant.type === "role")).toBe(true);
  });

  it("assign a pending role stage to the first holder", () => {
    const pending = startReview(rolePolicy({ type: "approval", roleId: qaRoleId }), { [qaRoleId]: ["qa-1", "qa-2"] });
    expect(pending.status).toBe("in_review");
    expect(pending.assigneeUserId).toBe("qa-1");
    expect(pending.executionState.currentParticipant).toEqual({ type: "user", userId: "qa-1", agentId: null });
  });

  it("fail clearly when nobody holds the role", () => {
    expect(() => startReview(rolePolicy({ type: "approval", roleId: qaRoleId }), {}))
      .toThrow(/nobody else holds the required role/);
  });

  it("let any holder approve, not only the assigned one, and record the role", () => {
    const policy = rolePolicy({ type: "approval", roleId: qaRoleId });
    const roleHolders = { [qaRoleId]: ["qa-1", "qa-2"] };
    const pending = startReview(policy, roleHolders);
    const approved = applyIssueExecutionPolicyTransition({
      issue: { status: "in_review", assigneeUserId: pending.assigneeUserId, executionState: pending.executionState },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { userId: "qa-2" },
      commentBody: "Tested on QA, all green.",
      roleHolders,
    });
    expect(approved.decision).toMatchObject({ outcome: "approved", viaRoleId: qaRoleId });
    expect((approved.patch.executionState as IssueExecutionState).status).toBe("completed");
  });

  it("let any holder request changes", () => {
    const policy = rolePolicy({ type: "review", roleId: qaRoleId });
    const roleHolders = { [qaRoleId]: ["qa-1", "qa-2"] };
    const pending = startReview(policy, roleHolders);
    const result = applyIssueExecutionPolicyTransition({
      issue: { status: "in_review", assigneeUserId: pending.assigneeUserId, executionState: pending.executionState },
      policy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { userId: "qa-2" },
      commentBody: "Login fails for tenant B.",
      roleHolders,
    });
    expect(result.decision).toMatchObject({ outcome: "changes_requested", viaRoleId: qaRoleId });
    expect(result.patch.assigneeAgentId).toBe(coderAgentId);
  });

  it("refuse people who do not hold the role", () => {
    const policy = rolePolicy({ type: "approval", roleId: qaRoleId });
    const roleHolders = { [qaRoleId]: ["qa-1"] };
    const pending = startReview(policy, roleHolders);
    expect(() => applyIssueExecutionPolicyTransition({
      issue: { status: "in_review", assigneeUserId: pending.assigneeUserId, executionState: pending.executionState },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { userId: "someone-else" },
      commentBody: "LGTM",
      roleHolders,
    })).toThrow(/Only the active reviewer or approver/);
  });

  it("never auto-skip a role review stage when the author is the only holder", () => {
    const policy = rolePolicy({ type: "review", roleId: qaRoleId });
    expect(() => applyIssueExecutionPolicyTransition({
      issue: { status: "in_progress", assigneeUserId: "dev-1" },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { userId: "dev-1" },
      roleHolders: { [qaRoleId]: ["dev-1"] },
    })).toThrow(/nobody else holds the required role/);
  });

  it("do not let the author approve their own work through a role they hold", () => {
    const policy = rolePolicy({ type: "approval", roleId: qaRoleId });
    const roleHolders = { [qaRoleId]: ["qa-1", "dev-1"] };
    const pending = applyIssueExecutionPolicyTransition({
      issue: { status: "in_progress", assigneeUserId: "dev-1" },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { userId: "dev-1" },
      roleHolders,
    });
    const state = pending.patch.executionState as IssueExecutionState;
    expect(state.currentParticipant).toEqual({ type: "user", userId: "qa-1", agentId: null });
    expect(() => applyIssueExecutionPolicyTransition({
      issue: { status: "in_review", assigneeUserId: "qa-1", executionState: state },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { userId: "dev-1" },
      commentBody: "Approving my own change",
      roleHolders,
    })).toThrow(/Only the active reviewer or approver/);
  });
});

describe("separation of duties", () => {
  it("refuses a second approval on the same task under a different role", () => {
    const policy = rolePolicy({ type: "approval", roleId: baRoleId }, { type: "approval", roleId: qaRoleId });
    const roleHolders = { [baRoleId]: ["pat"], [qaRoleId]: ["pat", "qa-1"] };
    const pending = startReview(policy, roleHolders);
    const afterBa = applyIssueExecutionPolicyTransition({
      issue: { status: "in_review", assigneeUserId: "pat", executionState: pending.executionState },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { userId: "pat" },
      commentBody: "Requirements met.",
      roleHolders,
    });
    expect(afterBa.decision).toMatchObject({ outcome: "approved", viaRoleId: baRoleId });
    const qaState = afterBa.patch.executionState as IssueExecutionState;
    expect(() => applyIssueExecutionPolicyTransition({
      issue: { status: "in_review", assigneeUserId: afterBa.patch.assigneeUserId as string, executionState: qaState },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { userId: "pat" },
      commentBody: "QA ok too.",
      roleHolders,
      actorApprovedRoleIds: [baRoleId],
    })).toThrow(/Separation of duties/);
    // Another QA holder can still approve.
    const byQa = applyIssueExecutionPolicyTransition({
      issue: { status: "in_review", assigneeUserId: afterBa.patch.assigneeUserId as string, executionState: qaState },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { userId: "qa-1" },
      commentBody: "QA ok.",
      roleHolders,
    });
    expect(byQa.decision).toMatchObject({ outcome: "approved", viaRoleId: qaRoleId });
  });

  it("allows approving several gates under the same role", () => {
    const policy = rolePolicy({ type: "approval", roleId: elRoleId }, { type: "approval", roleId: elRoleId });
    const roleHolders = { [elRoleId]: ["lead"] };
    const pending = startReview(policy, roleHolders);
    const first = applyIssueExecutionPolicyTransition({
      issue: { status: "in_review", assigneeUserId: "lead", executionState: pending.executionState },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { userId: "lead" },
      commentBody: "Dev complete.",
      roleHolders,
    });
    const second = applyIssueExecutionPolicyTransition({
      issue: { status: "in_review", assigneeUserId: "lead", executionState: first.patch.executionState as IssueExecutionState },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { userId: "lead" },
      commentBody: "Release approved.",
      roleHolders,
      actorApprovedRoleIds: [elRoleId],
    });
    expect(second.decision).toMatchObject({ outcome: "approved", viaRoleId: elRoleId });
  });
});
