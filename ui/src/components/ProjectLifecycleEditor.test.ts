import { describe, expect, it } from "vitest";
import { LIFECYCLE_TEMPLATE_PRESETS, lifecyclePhaseListSchema } from "@paperclipai/shared";
import { draftsFromLifecycle, draftsFromPhaseInputs, phaseKeyFromName, phasesFromDrafts } from "./ProjectLifecycleEditor";

describe("lifecycle editor drafts", () => {
  it("derives phase keys from names", () => {
    expect(phaseKeyFromName("User Acceptance (UAT)")).toBe("user-acceptance-uat");
    expect(phaseKeyFromName("  ")).toBe("phase");
  });

  it("round-trips phases, keeps extra stages and user owners, and makes the last phase final", () => {
    const stored = lifecyclePhaseListSchema.parse([
      { key: "requirements", name: "Requirements", ownerUserId: "user-1", exitGate: { requiredDocuments: ["requirements"] } },
      { key: "development", name: "Development", ownerAgentId: "4c0f1f69-62a3-4c4b-9b8e-7f1f0f1c2d3e", exitGate: {
        requiredWorkProductTypes: ["pull_request"],
        stages: [
          { type: "review", participants: [{ type: "agent", agentId: "8b9c6f6c-3c1a-4f3e-9a4e-2d4c0b9f1a11" }] },
          { type: "approval", participants: [{ type: "user", userId: "user-2" }] },
        ],
      } },
      { key: "testing", name: "Testing", reworkTo: ["development"] },
      { key: "release", name: "Release", kind: "terminal" },
    ]);
    const drafts = draftsFromLifecycle(stored);
    expect(drafts[1]).toMatchObject({ reviewerAgentId: "8b9c6f6c-3c1a-4f3e-9a4e-2d4c0b9f1a11", otherStages: [{ type: "approval" }] });
    const phases = lifecyclePhaseListSchema.parse(phasesFromDrafts(drafts));
    expect(phases.map(({ key, kind, reworkTo }) => [key, kind, reworkTo])).toEqual([
      ["requirements", "work", []], ["development", "work", []], ["testing", "work", ["development"]], ["release", "terminal", []],
    ]);
    expect(phases[0]).toMatchObject({ ownerUserId: "user-1", exitGate: { requiredDocuments: ["requirements"] } });
    expect(phases[1]!.exitGate.stages.map((stage) => stage.type)).toEqual(["review", "approval"]);
  });

  it("keeps rework targets attached to a phase after its key changes", () => {
    const drafts = draftsFromLifecycle(lifecyclePhaseListSchema.parse([
      { key: "dev", name: "Development" },
      { key: "qa", name: "Testing", reworkTo: ["dev"] },
      { key: "release", name: "Release", kind: "terminal" },
    ]));
    drafts[0]!.key = "development";
    expect(phasesFromDrafts(drafts)[1]!.reworkTo).toEqual(["development"]);
  });

  it("round-trips role approval gates, keeping their stage ids and order", () => {
    const qaRole = "11111111-1111-4111-8111-111111111111";
    const baRole = "22222222-2222-4222-8222-222222222222";
    const stageId = "33333333-3333-4333-8333-333333333333";
    const stored = lifecyclePhaseListSchema.parse([
      { key: "uat", name: "UAT", exitGate: { stages: [
        { id: stageId, type: "approval", participants: [{ type: "role", roleId: qaRole }] },
        { type: "approval", participants: [{ type: "role", roleId: baRole }] },
        { type: "approval", participants: [{ type: "user", userId: "user-2" }] },
      ] } },
      { key: "release", name: "Release", kind: "terminal" },
    ]);
    const drafts = draftsFromLifecycle(stored);
    expect(drafts[0]!.approvalRoles).toEqual([{ roleId: qaRole, stageId }, { roleId: baRole }]);
    expect(drafts[0]!.otherStages).toHaveLength(1);

    drafts[1]!.approvalRoles = [{ roleId: qaRole }];
    const phases = lifecyclePhaseListSchema.parse(phasesFromDrafts(drafts));
    expect(phases[0]!.exitGate.stages.map((stage) => [stage.id ?? null, stage.participants[0]?.type, stage.participants[0]?.roleId ?? null]))
      .toEqual([[stageId, "role", qaRole], [null, "role", baRole], [null, "user", null]]);
    expect(phases[1]!.exitGate.stages).toMatchObject([{ type: "approval", participants: [{ type: "role", roleId: qaRole }] }]);
  });

  it("loads each built-in preset into the form without changing it", () => {
    for (const preset of LIFECYCLE_TEMPLATE_PRESETS) {
      const expected = lifecyclePhaseListSchema.parse(preset.phases);
      expect(lifecyclePhaseListSchema.parse(phasesFromDrafts(draftsFromPhaseInputs(preset.phases))), preset.key).toEqual(expected);
    }
  });
});
