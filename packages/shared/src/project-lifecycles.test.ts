import { describe, expect, it } from "vitest";
import {
  evaluateLifecyclePhaseExitGate,
  lifecyclePhaseExitGateSchema,
  lifecyclePhaseListSchema,
  putProjectLifecycleSchema,
} from "./project-lifecycles.js";

const sdlc = [
  { key: "requirements", name: "Requirements", exitGate: { requiredDocuments: ["requirements"] } },
  { key: "development", name: "Development", exitGate: { requiredWorkProductTypes: ["pull_request"] } },
  { key: "testing", name: "Testing", reworkTo: ["development"] },
  { key: "release", name: "Release", kind: "terminal" },
];

describe("lifecyclePhaseListSchema", () => {
  it("fills defaults for an ordered phase list", () => {
    const phases = lifecyclePhaseListSchema.parse(sdlc);
    expect(phases.map(phase => phase.kind)).toEqual(["work", "work", "work", "terminal"]);
    expect(phases[2]).toMatchObject({ ownerAgentId: null, ownerUserId: null, instructions: null, reworkTo: ["development"] });
    expect(phases[3]!.exitGate).toEqual({ requiredDocuments: [], requireChildrenTerminal: false, requiredWorkProductTypes: [], stages: [] });
  });

  it("requires exactly one terminal phase in last position", () => {
    expect(lifecyclePhaseListSchema.safeParse(sdlc.slice(0, 3)).success).toBe(false);
    expect(lifecyclePhaseListSchema.safeParse([sdlc[3], ...sdlc.slice(0, 3)]).success).toBe(false);
    expect(lifecyclePhaseListSchema.safeParse([...sdlc.slice(0, 3), { ...sdlc[3], key: "ship" }, sdlc[3]]).success).toBe(false);
  });

  it("rejects duplicate keys and forward or unknown rework targets", () => {
    expect(lifecyclePhaseListSchema.safeParse([sdlc[0], sdlc[0], sdlc[3]]).success).toBe(false);
    expect(lifecyclePhaseListSchema.safeParse([{ ...sdlc[0], reworkTo: ["release"] }, sdlc[3]]).success).toBe(false);
    expect(lifecyclePhaseListSchema.safeParse([{ ...sdlc[0], reworkTo: ["requirements"] }, sdlc[3]]).success).toBe(false);
    expect(lifecyclePhaseListSchema.safeParse([{ ...sdlc[0], reworkTo: ["missing"] }, sdlc[3]]).success).toBe(false);
  });

  it("rejects a phase with both an agent and a user owner", () => {
    const phase = { key: "uat", name: "UAT", kind: "terminal", ownerAgentId: "4c0f1f69-62a3-4c4b-9b8e-7f1f0f1c2d3e", ownerUserId: "user-1" };
    expect(lifecyclePhaseListSchema.safeParse([phase]).success).toBe(false);
  });
});

describe("putProjectLifecycleSchema", () => {
  it("accepts a template, explicit phases, or a mode-only change but not both sources", () => {
    expect(putProjectLifecycleSchema.safeParse({ mode: "enforced" }).success).toBe(true);
    expect(putProjectLifecycleSchema.safeParse({ mode: "advisory", phases: sdlc }).success).toBe(true);
    expect(putProjectLifecycleSchema.safeParse({
      mode: "advisory", phases: sdlc, templateId: "4c0f1f69-62a3-4c4b-9b8e-7f1f0f1c2d3e",
    }).success).toBe(false);
  });
});

describe("evaluateLifecyclePhaseExitGate", () => {
  const gate = lifecyclePhaseExitGateSchema.parse({
    requiredDocuments: ["requirements", "design"],
    requiredWorkProductTypes: ["pull_request"],
    requireChildrenTerminal: true,
  });

  it("lists every unmet item", () => {
    expect(evaluateLifecyclePhaseExitGate(gate, { documentKeys: ["design"], workProductTypes: [], openChildCount: 2 })).toEqual([
      { kind: "document", key: "requirements" },
      { kind: "work_product", type: "pull_request" },
      { kind: "open_children", count: 2 },
    ]);
  });

  it("passes when all items are met", () => {
    expect(evaluateLifecyclePhaseExitGate(gate, {
      documentKeys: ["requirements", "design"], workProductTypes: ["pull_request"], openChildCount: 0,
    })).toEqual([]);
  });
});
