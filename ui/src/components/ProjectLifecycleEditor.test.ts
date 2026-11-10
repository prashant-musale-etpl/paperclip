import { describe, expect, it } from "vitest";
import { lifecyclePhaseListSchema } from "@paperclipai/shared";
import { draftsFromLifecycle, phaseKeyFromName, phasesFromDrafts } from "./ProjectLifecycleEditor";

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
});
