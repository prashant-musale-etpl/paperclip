import { randomUUID } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  documents,
  heartbeatRuns,
  instanceSettings,
  issueDocuments,
  issuePhaseTransitions,
  issues,
  issueWorkProducts,
  lifecycleTemplates,
  projectLifecycles,
  projects,
} from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { projectLifecycleRoutes } from "../routes/project-lifecycles.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { blockedPhaseCompletion } from "../services/issue-phases.js";
import { projectLifecycleService } from "../services/project-lifecycles.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
  type BoardActor,
} from "./helpers/route-test-harness.js";

// Record wake requests instead of launching agents; everything else is real.
const wakeups = vi.hoisted(() => [] as Array<{ agentId: string; request: { reason?: string; payload?: Record<string, unknown> } }>);
vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
      ...actual.heartbeatService(...args),
      wakeup: async (agentId: string, request: { reason?: string; payload?: Record<string, unknown> }) => {
        wakeups.push({ agentId, request });
        return null;
      },
    }),
  };
});

describeEmbeddedPostgres("project lifecycle phases on tasks", () => {
  beforeEach(() => { wakeups.length = 0; });

  const ctx = useEmbeddedPostgres("paperclip-issue-phases-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(heartbeatRuns);
      await db.delete(agentWakeupRequests);
      await db.delete(issueWorkProducts);
      await db.delete(issueDocuments);
      await db.delete(documents);
      await db.delete(issuePhaseTransitions);
      await db.delete(projectLifecycles);
      await db.delete(lifecycleTemplates);
      await db.delete(issues).where(isNotNull(issues.parentId));
      await db.delete(issues);
      await db.delete(projects);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
      await db.delete(instanceSettings);
    },
  });

  async function seed(mode: "advisory" | "enforced" = "enforced") {
    await instanceSettingsService(ctx.db).updateExperimental({ enableProjectLifecycles: true });
    const company = await seedCompanyWithBoardAccess(ctx.db, "Phases");
    const { companyId } = company;
    const [pm, architect, engineer, qa, reviewer] = ["PM", "Architect", "Engineer", "QA", "Reviewer"].map(() => randomUUID());
    await ctx.db.insert(agents).values([pm, architect, engineer, qa, reviewer].map((id, index) => ({
      id, companyId, name: ["PM", "Architect", "Engineer", "QA", "Reviewer"][index]!, role: "engineer", status: "idle", adapterType: "codex_local",
    })));
    const projectId = randomUUID();
    await ctx.db.insert(projects).values({ id: projectId, companyId, name: "Shop" });
    await projectLifecycleService(ctx.db).putProjectLifecycle(companyId, projectId,
      { actorType: "user", actorId: company.userId, agentId: null, runId: null }, {
        mode,
        phases: [
          { key: "requirements", name: "Requirements", kind: "work", ownerAgentId: pm, ownerUserId: null, instructions: "Write the requirements document.",
            exitGate: { requiredDocuments: ["requirements"], requireChildrenTerminal: false, requiredWorkProductTypes: [], stages: [] }, reworkTo: [] },
          { key: "design", name: "Design", kind: "work", ownerAgentId: architect, ownerUserId: null, instructions: null,
            exitGate: { requiredDocuments: [], requireChildrenTerminal: false, requiredWorkProductTypes: [],
              stages: [{ type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: reviewer }] }] }, reworkTo: [] },
          { key: "development", name: "Development", kind: "work", ownerAgentId: engineer, ownerUserId: null, instructions: null,
            exitGate: { requiredDocuments: [], requireChildrenTerminal: true, requiredWorkProductTypes: ["pull_request"], stages: [] }, reworkTo: [] },
          { key: "testing", name: "Testing", kind: "work", ownerAgentId: qa, ownerUserId: null, instructions: null,
            exitGate: { requiredDocuments: [], requireChildrenTerminal: false, requiredWorkProductTypes: [], stages: [] }, reworkTo: ["development"] },
          { key: "release", name: "Release", kind: "terminal", ownerAgentId: null, ownerUserId: company.userId, instructions: null,
            exitGate: { requiredDocuments: [], requireChildrenTerminal: false, requiredWorkProductTypes: [], stages: [] }, reworkTo: [] },
        ],
      });
    const agent = (agentId: string) => ({ type: "agent", source: "agent_key", agentId, companyId } as unknown as BoardActor);
    return { ...company, projectId, pm, architect, engineer, qa, reviewer, agent };
  }

  async function addDocument(companyId: string, issueId: string, key: string, body = "Body") {
    const [document] = await ctx.db.insert(documents).values({ companyId, latestBody: body }).returning();
    await ctx.db.insert(issueDocuments).values({ companyId, issueId, documentId: document!.id, key });
  }

  async function transitions(issueId: string) {
    return ctx.db.select().from(issuePhaseTransitions).where(eq(issuePhaseTransitions.issueId, issueId))
      .orderBy(issuePhaseTransitions.createdAt);
  }

  it("starts top-level tasks in the first phase with its owner, and leaves sub-tasks unphased", async () => {
    const { companyId, projectId, pm, userId } = await seed();
    const svc = issueService(ctx.db);
    const task = await svc.create(companyId, { projectId, title: "Login page", status: "todo", createdByUserId: userId });
    expect(task).toMatchObject({ phaseKey: "requirements", phaseVersion: 1, assigneeAgentId: pm });
    expect(await transitions(task.id)).toMatchObject([{ kind: "initial", fromPhaseKey: null, toPhaseKey: "requirements" }]);

    const child = await svc.create(companyId, { projectId, parentId: task.id, title: "Sub-task", createdByUserId: userId });
    expect(child.phaseKey).toBeNull();

    const outside = await svc.create(companyId, { title: "No project", createdByUserId: userId });
    expect(outside.phaseKey).toBeNull();
  });

  it("rejects done until the exit gate is met, then advances to the next phase and owner", async () => {
    const { companyId, projectId, architect, reviewer, userId } = await seed();
    const svc = issueService(ctx.db);
    const task = await svc.create(companyId, { projectId, title: "Login page", status: "todo", createdByUserId: userId });

    await expect(svc.update(task.id, { status: "done" })).rejects.toMatchObject({
      status: 422, details: { code: "phase_gate_unmet", phaseKey: "requirements", gaps: [{ kind: "document", key: "requirements" }] },
    });
    // A blank document does not satisfy the gate.
    await addDocument(companyId, task.id, "requirements", "   ");
    await expect(svc.update(task.id, { status: "done" })).rejects.toMatchObject({ status: 422 });
    await ctx.db.update(documents).set({ latestBody: "Users sign in with email." });

    const advanced = await svc.update(task.id, { status: "done", actorUserId: userId });
    expect(advanced).toMatchObject({ status: "todo", phaseKey: "design", phaseVersion: 2, assigneeAgentId: architect, completedAt: null });
    expect(advanced!.executionPolicy).toMatchObject({ stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewer }] }] });
    expect((await transitions(task.id)).map(row => [row.kind, row.fromPhaseKey, row.toPhaseKey])).toEqual([
      ["initial", null, "requirements"], ["advance", "requirements", "design"],
    ]);
    const activity = await ctx.db.select().from(activityLog)
      .where(and(eq(activityLog.entityId, task.id), eq(activityLog.action, "issue.phase_changed")));
    expect(activity.find(row => (row.details as Record<string, unknown>).kind === "advance")).toMatchObject({
      actorId: userId, details: { fromPhaseKey: "requirements", toPhaseKey: "design" },
    });
  });

  it("checks work products and sub-tasks, and only the final phase closes the task", async () => {
    const { companyId, projectId, userId } = await seed();
    const svc = issueService(ctx.db);
    const task = await svc.create(companyId, { projectId, title: "Checkout", status: "todo", createdByUserId: userId });
    await ctx.db.update(issues).set({ phaseKey: "development", phaseVersion: 3, executionPolicy: null }).where(eq(issues.id, task.id));
    const child = await svc.create(companyId, { projectId, parentId: task.id, title: "Child", status: "todo", createdByUserId: userId });

    await expect(svc.update(task.id, { status: "done" })).rejects.toMatchObject({
      details: { gaps: [{ kind: "work_product", type: "pull_request" }, { kind: "open_children", count: 1 }] },
    });
    await ctx.db.insert(issueWorkProducts).values({ companyId, issueId: task.id, type: "pull_request", provider: "github", title: "PR", status: "closed" });
    await svc.update(child.id, { status: "done" });
    await expect(svc.update(task.id, { status: "done" })).rejects.toMatchObject({
      details: { gaps: [{ kind: "work_product", type: "pull_request" }] },
    });
    await ctx.db.insert(issueWorkProducts).values({ companyId, issueId: task.id, type: "pull_request", provider: "github", title: "PR 2", status: "active" });
    expect(await svc.update(task.id, { status: "done" })).toMatchObject({ status: "todo", phaseKey: "testing" });
    expect(await svc.update(task.id, { status: "done" })).toMatchObject({ status: "todo", phaseKey: "release", assigneeUserId: userId, assigneeAgentId: null });

    const closed = await svc.update(task.id, { status: "done" });
    expect(closed).toMatchObject({ status: "done", phaseKey: "release" });
    expect((await transitions(task.id)).at(-1)).toMatchObject({ kind: "complete", fromPhaseKey: "release", toPhaseKey: "release" });
  });

  it("records unmet gates without blocking in advisory mode", async () => {
    const { companyId, projectId, userId } = await seed("advisory");
    const svc = issueService(ctx.db);
    const task = await svc.create(companyId, { projectId, title: "Advisory", status: "todo", createdByUserId: userId });
    expect(await svc.update(task.id, { status: "done" })).toMatchObject({ status: "todo", phaseKey: "design" });
    expect((await transitions(task.id)).at(-1)).toMatchObject({
      kind: "advance", lifecycleMode: "advisory", gateGaps: [{ kind: "document", key: "requirements" }],
    });
  });

  it("reports an enforced gate block without throwing, for callers inside their own transaction", async () => {
    const { companyId, projectId, userId } = await seed();
    const task = await issueService(ctx.db).create(companyId, { projectId, title: "Native", status: "todo", createdByUserId: userId });
    const [row] = await ctx.db.select().from(issues).where(eq(issues.id, task.id));
    expect(await blockedPhaseCompletion(ctx.db, row!)).toMatchObject({
      code: "phase_gate_unmet", phaseKey: "requirements", gaps: [{ kind: "document", key: "requirements" }],
    });
    await addDocument(companyId, task.id, "requirements");
    expect(await blockedPhaseCompletion(ctx.db, row!)).toBeNull();
  });

  it("ignores phase fields supplied by callers and leaves tasks alone when lifecycles are off", async () => {
    const { companyId, projectId, userId } = await seed();
    const svc = issueService(ctx.db);
    const task = await svc.create(companyId, { projectId, title: "Guarded", status: "todo", createdByUserId: userId });
    const edited = await svc.update(task.id, { phaseKey: "release", phaseVersion: 99, title: "Renamed" } as never);
    expect(edited).toMatchObject({ phaseKey: "requirements", phaseVersion: 1, title: "Renamed" });

    await instanceSettingsService(ctx.db).updateExperimental({ enableProjectLifecycles: false });
    const plain = await svc.create(companyId, { projectId, title: "Plain", status: "todo", createdByUserId: userId });
    expect(plain.phaseKey).toBeNull();
    expect(await svc.update(task.id, { status: "done" })).toMatchObject({ status: "done" });
  });

  it("lets the assigned agent rework to an allowed phase and the board override", async () => {
    const { companyId, projectId, qa, engineer, pm, userId, actor, agent } = await seed();
    const svc = issueService(ctx.db);
    const task = await svc.create(companyId, { projectId, title: "Search", status: "todo", createdByUserId: userId });
    await ctx.db.update(issues).set({ phaseKey: "testing", phaseVersion: 4, assigneeAgentId: qa }).where(eq(issues.id, task.id));
    const path = `/api/issues/${task.id}/phase-transitions`;

    const outsider = routeApp(ctx.db, agent(pm), projectLifecycleRoutes);
    await request(outsider).post(path).send({ kind: "rework", toPhaseKey: "development", reason: "Bugs" }).expect(403);
    const qaApp = routeApp(ctx.db, agent(qa), projectLifecycleRoutes);
    await request(qaApp).post(path).send({ kind: "rework", toPhaseKey: "requirements", reason: "Bugs" }).expect(422);
    await request(qaApp).post(path).send({ kind: "override", toPhaseKey: "release", reason: "Skip" }).expect(403);
    await request(qaApp).post(path).send({ kind: "rework", toPhaseKey: "development", reason: "Bugs", expectedPhaseVersion: 3 }).expect(409);

    const reworked = await request(qaApp).post(path)
      .send({ kind: "rework", toPhaseKey: "development", reason: "Login fails on Safari", expectedPhaseVersion: 4 }).expect(200);
    expect(reworked.body).toMatchObject({ phaseKey: "development", phaseVersion: 5, status: "todo", assigneeAgentId: engineer });
    expect(wakeups).toMatchObject([{ agentId: engineer, request: { reason: "issue_assigned", payload: { phaseKey: "development" } } }]);

    const board = routeApp(ctx.db, actor, projectLifecycleRoutes);
    await request(board).post(path).send({ kind: "override", toPhaseKey: "release", reason: "Hotfix shipped manually" }).expect(200);
    const phase = await request(board).get(`/api/issues/${task.id}/phase`).expect(200);
    expect(phase.body).toMatchObject({ phase: { key: "release" }, position: 5, phaseCount: 5, nextPhase: null, mode: "enforced" });
    const history = await request(board).get(path).expect(200);
    expect(history.body.map((row: { kind: string; reason: string | null }) => [row.kind, row.reason])).toEqual([
      ["initial", null], ["rework", "Login fails on Safari"], ["override", "Hotfix shipped manually"],
    ]);
  });

  it("reports the phase and unmet gate to readers", async () => {
    const { companyId, projectId, userId, actor } = await seed();
    const task = await issueService(ctx.db).create(companyId, { projectId, title: "Phase read", status: "todo", createdByUserId: userId });
    const board = routeApp(ctx.db, actor, projectLifecycleRoutes);
    const phase = await request(board).get(`/api/issues/${task.id}/phase`).expect(200);
    expect(phase.body).toMatchObject({
      phase: { key: "requirements", name: "Requirements", instructions: "Write the requirements document." },
      position: 1, nextPhase: { key: "design" }, unmetGate: [{ kind: "document", key: "requirements" }],
    });
  });

  it("wakes the owner when completing through the task API enters a phase they also own", async () => {
    const { companyId, projectId, pm, userId, actor } = await seed();
    // Same owner for the first two phases: the assignee does not change, so the
    // phase entry alone must wake them.
    const lifecycle = await projectLifecycleService(ctx.db).getProjectLifecycle(companyId, projectId);
    await projectLifecycleService(ctx.db).putProjectLifecycle(companyId, projectId,
      { actorType: "user", actorId: userId, agentId: null, runId: null },
      { mode: "enforced", phases: lifecycle!.phases.map(({ id: _id, position: _position, ...phase }) =>
        phase.key === "design" ? { ...phase, ownerAgentId: pm, exitGate: { ...phase.exitGate, stages: [] } } : phase) });
    const task = await issueService(ctx.db).create(companyId, { projectId, title: "Wake", status: "todo", createdByUserId: userId });
    await addDocument(companyId, task.id, "requirements");

    const app = routeApp(ctx.db, actor, issueRoutes);
    const response = await request(app).patch(`/api/issues/${task.id}`).send({ status: "done" }).expect(200);
    expect(response.body).toMatchObject({ status: "todo", phaseKey: "design", assigneeAgentId: pm });
    expect(wakeups).toMatchObject([{ agentId: pm, request: { reason: "issue_assigned", payload: { phaseKey: "design" } } }]);
  });
});
