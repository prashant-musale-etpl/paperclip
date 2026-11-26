import { describe, expect, it } from "vitest";
import type { CompanyRole, IssueExecutionPolicy, IssueExecutionState } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import {
  buildCompanyRoleMap,
  formatRoleParticipantLabel,
  formatStagePrincipalLabel,
  isSeparationOfDutiesError,
  missingSuggestedRoles,
  selectableCompanyRoles,
  stageDecisionEligibility,
  stageDecisionErrorMessage,
} from "./company-roles";

const QA_ID = "00000000-0000-4000-8000-0000000000a1";
const BA_ID = "00000000-0000-4000-8000-0000000000a2";
const STAGE_ID = "00000000-0000-4000-8000-0000000000b1";

function role(overrides: Partial<CompanyRole> & Pick<CompanyRole, "id" | "key" | "name">): CompanyRole {
  return {
    companyId: "company-1",
    description: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    holders: [],
    ...overrides,
  };
}

function holder(userId: string) {
  return { userId, name: userId, email: null, assignedAt: "2026-01-01T00:00:00.000Z", assignedByUserId: null };
}

const qa = role({ id: QA_ID, key: "qa", name: "QA", holders: [holder("user-qa"), holder("user-dev")] });
const ba = role({
  id: BA_ID,
  key: "ba",
  name: "Business Analyst",
  archivedAt: "2026-02-01T00:00:00.000Z",
  holders: [holder("user-ba")],
});

const policy: IssueExecutionPolicy = {
  mode: "normal",
  commentRequired: true,
  stages: [{
    id: STAGE_ID,
    type: "approval",
    approvalsNeeded: 1,
    participants: [{ id: "00000000-0000-4000-8000-0000000000c1", type: "role", roleId: QA_ID, agentId: null, userId: null }],
  }],
};

function pendingState(overrides: Partial<IssueExecutionState> = {}): IssueExecutionState {
  return {
    status: "pending",
    currentStageId: STAGE_ID,
    currentStageIndex: 0,
    currentStageType: "approval",
    currentParticipant: { type: "user", userId: "user-qa" },
    returnAssignee: { type: "user", userId: "user-dev" },
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    ...overrides,
  };
}

describe("role labels", () => {
  const roleMap = buildCompanyRoleMap([qa, ba]);

  it("labels role participants by name, marks archived roles, and never returns a blank", () => {
    expect(formatRoleParticipantLabel(QA_ID, roleMap)).toBe("Role: QA");
    expect(formatRoleParticipantLabel(BA_ID, roleMap)).toBe("Role: Business Analyst (archived)");
    expect(formatRoleParticipantLabel("missing", roleMap)).toBe("Role: unknown");
    expect(formatRoleParticipantLabel(null, undefined)).toBe("Role: unknown");
  });

  it("labels any stage principal type", () => {
    const resolvers = { agentLabel: () => "Builder", userLabel: () => "Ada", roleMap };
    expect(formatStagePrincipalLabel({ type: "agent", agentId: "a" }, resolvers)).toBe("Builder");
    expect(formatStagePrincipalLabel({ type: "user", userId: "u" }, resolvers)).toBe("Ada");
    expect(formatStagePrincipalLabel({ type: "role", roleId: QA_ID }, resolvers)).toBe("Role: QA");
    expect(formatStagePrincipalLabel(null, resolvers)).toBeNull();
  });

  it("never offers archived roles", () => {
    expect(selectableCompanyRoles([qa, ba]).map((entry) => entry.id)).toEqual([QA_ID]);
  });

  it("suggests only starter roles whose keys do not exist yet, archived included", () => {
    expect(missingSuggestedRoles([qa, ba]).map((entry) => entry.key)).toEqual(["architect", "engineering-lead", "devops"]);
  });
});

describe("stageDecisionEligibility", () => {
  it("lets the assigned participant decide", () => {
    expect(stageDecisionEligibility({
      executionPolicy: policy, executionState: pendingState(), currentUserId: "user-qa", roles: [qa],
    })).toEqual({ canDecide: true, via: "participant" });
  });

  it("lets another holder of a role named by the active stage decide", () => {
    const withSecondHolder = { ...qa, holders: [...qa.holders, holder("user-qa2")] };
    expect(stageDecisionEligibility({
      executionPolicy: policy, executionState: pendingState(), currentUserId: "user-qa2", roles: [withSecondHolder],
    })).toEqual({ canDecide: true, via: "role", roleIds: [QA_ID] });
  });

  it("refuses the person whose work is under review even when they hold the role", () => {
    expect(stageDecisionEligibility({
      executionPolicy: policy, executionState: pendingState(), currentUserId: "user-dev", roles: [qa],
    })).toEqual({ canDecide: false, reason: "work_under_review" });
  });

  it("refuses non-holders, archived roles, signed-out users and stages that are not pending", () => {
    expect(stageDecisionEligibility({
      executionPolicy: policy, executionState: pendingState(), currentUserId: "user-other", roles: [qa],
    })).toEqual({ canDecide: false, reason: "not_a_participant" });
    const archivedQa = { ...qa, archivedAt: "2026-03-01T00:00:00.000Z", holders: [holder("user-qa2")] };
    expect(stageDecisionEligibility({
      executionPolicy: policy, executionState: pendingState(), currentUserId: "user-qa2", roles: [archivedQa],
    })).toEqual({ canDecide: false, reason: "not_a_participant" });
    expect(stageDecisionEligibility({
      executionPolicy: policy,
      executionState: pendingState({ status: "changes_requested" }),
      currentUserId: "user-qa",
      roles: [qa],
    })).toEqual({ canDecide: false, reason: "no_pending_stage" });
    expect(stageDecisionEligibility({
      executionPolicy: policy, executionState: pendingState(), currentUserId: null, roles: [qa],
    })).toEqual({ canDecide: false, reason: "not_signed_in" });
  });

  it("only considers roles named by the active stage", () => {
    const otherStagePolicy: IssueExecutionPolicy = {
      ...policy,
      stages: [{ ...policy.stages[0]!, id: "00000000-0000-4000-8000-0000000000b2" }],
    };
    expect(stageDecisionEligibility({
      executionPolicy: otherStagePolicy,
      executionState: pendingState(),
      currentUserId: "user-qa2",
      roles: [{ ...qa, holders: [holder("user-qa2")] }],
    })).toEqual({ canDecide: false, reason: "not_a_participant" });
  });
});

describe("separation of duties errors", () => {
  const message =
    "Separation of duties: you already approved another gate on this task under a different role. Another holder of this role must approve.";

  it("recognises the 422 code in error details and keeps the server message", () => {
    const error = new ApiError(message, 422, { error: message, details: { code: "separation_of_duties" } });
    expect(isSeparationOfDutiesError(error)).toBe(true);
    expect(stageDecisionErrorMessage(error)).toBe(message);
  });

  it("does not flag other failures", () => {
    const error = new ApiError("Approving a review or approval stage requires a comment.", 422, { error: "x" });
    expect(isSeparationOfDutiesError(error)).toBe(false);
    expect(stageDecisionErrorMessage(error)).toBe("Approving a review or approval stage requires a comment.");
    expect(isSeparationOfDutiesError(new Error("boom"))).toBe(false);
  });
});
