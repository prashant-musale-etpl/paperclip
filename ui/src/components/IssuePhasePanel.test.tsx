// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssuePhaseResponse } from "@paperclipai/shared";
import { IssuePhasePanel } from "./IssuePhasePanel";

const mockLifecycleApi = vi.hoisted(() => ({
  getIssuePhase: vi.fn(),
  listIssuePhaseTransitions: vi.fn(),
  transitionIssuePhase: vi.fn(),
}));
const mockInstanceApi = vi.hoisted(() => ({ getExperimental: vi.fn() }));

vi.mock("@/api/projectLifecycles", () => ({ projectLifecyclesApi: mockLifecycleApi }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceApi }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
  flushSync(() => {});
}

const phase: IssuePhaseResponse = {
  issueId: "issue-1",
  phaseVersion: 2,
  phaseEnteredAt: "2026-11-10T00:00:00.000Z",
  mode: "enforced",
  phase: { key: "requirements", name: "Requirements", kind: "work", instructions: "Write the requirements." },
  position: 1,
  phaseCount: 3,
  phases: [
    { key: "requirements", name: "Requirements", kind: "work" },
    { key: "design", name: "Design", kind: "work" },
    { key: "release", name: "Release", kind: "terminal" },
  ],
  nextPhase: { key: "design", name: "Design" },
  reworkTo: [],
  reviewStageCount: 1,
  unmetGate: [{ kind: "document", key: "requirements" }, { kind: "open_children", count: 2 }],
};

describe("IssuePhasePanel", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    Object.values(mockLifecycleApi).forEach((mock) => mock.mockReset());
    mockInstanceApi.getExperimental.mockReset();
  });
  afterEach(() => container.remove());

  async function render(status = "todo") {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssuePhasePanel issueId="issue-1" issueStatus={status} />
        </QueryClientProvider>,
      );
    });
    await flush();
    return root;
  }

  it("renders nothing while project lifecycles are disabled", async () => {
    mockInstanceApi.getExperimental.mockResolvedValue({ enableProjectLifecycles: false });
    const root = await render();
    expect(container.textContent).toBe("");
    expect(mockLifecycleApi.getIssuePhase).not.toHaveBeenCalled();
    root.unmount();
  });

  it("renders nothing for a task without a phase", async () => {
    mockInstanceApi.getExperimental.mockResolvedValue({ enableProjectLifecycles: true });
    mockLifecycleApi.getIssuePhase.mockResolvedValue(null);
    const root = await render();
    expect(container.textContent).toBe("");
    root.unmount();
  });

  it("shows the phases, the gate items still missing and the phase instructions", async () => {
    mockInstanceApi.getExperimental.mockResolvedValue({ enableProjectLifecycles: true });
    mockLifecycleApi.getIssuePhase.mockResolvedValue(phase);
    const root = await render();
    const text = container.textContent ?? "";
    expect(text).toContain("Enforced");
    expect(text).toContain("Before moving to Design (after 1 review stage)");
    expect([...container.querySelectorAll('[aria-label="Unmet exit gate items"] li')].map((li) => li.textContent)).toEqual([
      'Document "requirements"', "2 open sub-tasks to finish",
    ]);
    expect(text).toContain("Write the requirements.");
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Requirements");
    root.unmount();
  });

  it("hides the gate once the task is closed in its final phase", async () => {
    mockInstanceApi.getExperimental.mockResolvedValue({ enableProjectLifecycles: true });
    mockLifecycleApi.getIssuePhase.mockResolvedValue({ ...phase, phase: { ...phase.phase, key: "release", name: "Release", kind: "terminal" }, nextPhase: null, unmetGate: [] });
    const root = await render("done");
    expect(container.querySelector('[aria-label="Unmet exit gate items"]')).toBeNull();
    expect(container.textContent).not.toContain("Before closing");
    root.unmount();
  });

  it("surfaces a failed phase load", async () => {
    mockInstanceApi.getExperimental.mockResolvedValue({ enableProjectLifecycles: true });
    mockLifecycleApi.getIssuePhase.mockRejectedValue(new Error("boom"));
    const root = await render();
    expect(container.textContent).toContain("Could not load the task's phase: boom");
    root.unmount();
  });
});
