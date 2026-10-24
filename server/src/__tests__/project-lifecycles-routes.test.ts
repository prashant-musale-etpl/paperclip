import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { expect, it } from "vitest";
import { activityLog, agents, instanceSettings, lifecycleTemplates, projectLifecycles, projects } from "@paperclipai/db";
import { projectLifecycleRoutes } from "../routes/project-lifecycles.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
  type BoardActor,
} from "./helpers/route-test-harness.js";

const sdlcPhases = [
  { key: "requirements", name: "Requirements", exitGate: { requiredDocuments: ["requirements"] } },
  { key: "design", name: "Design", exitGate: { requiredDocuments: ["design"] } },
  { key: "development", name: "Development", exitGate: { requiredWorkProductTypes: ["pull_request"] } },
  { key: "testing", name: "Testing", reworkTo: ["development"] },
  { key: "uat", name: "UAT", reworkTo: ["development"] },
  { key: "deploy", name: "Deploy" },
  { key: "release", name: "Release", kind: "terminal" },
];

describeEmbeddedPostgres("project lifecycle routes", () => {
  const ctx = useEmbeddedPostgres("paperclip-project-lifecycles-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(projectLifecycles);
      await db.delete(lifecycleTemplates);
      await db.delete(projects);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
      await db.delete(instanceSettings);
    },
  });

  async function seed(name = "Lifecycle") {
    const company = await seedCompanyWithBoardAccess(ctx.db, name);
    const projectId = randomUUID(), agentId = randomUUID();
    await ctx.db.insert(projects).values({ id: projectId, companyId: company.companyId, name: `${name} project` });
    await ctx.db.insert(agents).values({
      id: agentId, companyId: company.companyId, name: "Architect", role: "engineer", status: "idle", adapterType: "codex_local",
    });
    const agentActor = { type: "agent", source: "agent_key", agentId, companyId: company.companyId } as unknown as BoardActor;
    return { ...company, projectId, agentId, agentActor, app: routeApp(ctx.db, company.actor, projectLifecycleRoutes) };
  }

  async function enable() {
    await instanceSettingsService(ctx.db).updateExperimental({ enableProjectLifecycles: true });
  }

  it("is unavailable until the experimental flag is enabled", async () => {
    const { app, companyId, projectId } = await seed();
    await request(app).get(`/api/companies/${companyId}/lifecycle-templates`).expect(403);
    await request(app).put(`/api/projects/${projectId}/lifecycle`).send({ mode: "enforced", phases: sdlcPhases }).expect(403);
  });

  it("adopts a template by copying its phases and logs each change", async () => {
    await enable();
    const { app, companyId, projectId, agentId } = await seed();
    const phases = sdlcPhases.map(phase => phase.key === "design" ? { ...phase, ownerAgentId: agentId } : phase);
    const created = await request(app).post(`/api/companies/${companyId}/lifecycle-templates`)
      .send({ key: "sdlc", name: "SDLC", phases }).expect(201);
    expect(created.body.phases).toHaveLength(7);
    await request(app).post(`/api/companies/${companyId}/lifecycle-templates`)
      .send({ key: "sdlc", name: "Duplicate", phases }).expect(409);

    const adopted = await request(app).put(`/api/projects/${projectId}/lifecycle`)
      .send({ mode: "enforced", templateId: created.body.id }).expect(200);
    expect(adopted.body).toMatchObject({ projectId, mode: "enforced", version: 1, templateId: created.body.id });
    expect(adopted.body.phases.map((phase: { key: string }) => phase.key)).toEqual(sdlcPhases.map(phase => phase.key));
    expect(adopted.body.phases[1]).toMatchObject({ ownerAgentId: agentId, position: 1, exitGate: { requiredDocuments: ["design"] } });

    // Editing the template later does not rewrite the project's copy.
    await request(app).patch(`/api/companies/${companyId}/lifecycle-templates/${created.body.id}`)
      .send({ phases: [{ key: "ship", name: "Ship", kind: "terminal" }] }).expect(200);
    const read = await request(app).get(`/api/projects/${projectId}/lifecycle`).expect(200);
    expect(read.body.phases).toHaveLength(7);

    const actions = await ctx.db.select({ action: activityLog.action }).from(activityLog)
      .where(eq(activityLog.companyId, companyId));
    expect(actions.map(row => row.action).sort()).toEqual([
      "lifecycle_template.created", "lifecycle_template.updated", "project.lifecycle_updated",
    ]);
  });

  it("changes mode without replacing phases and rejects stale versions", async () => {
    await enable();
    const { app, projectId } = await seed();
    await request(app).get(`/api/projects/${projectId}/lifecycle`).expect(404);
    await request(app).put(`/api/projects/${projectId}/lifecycle`).send({ mode: "advisory" }).expect(422);
    const first = await request(app).put(`/api/projects/${projectId}/lifecycle`)
      .send({ mode: "advisory", phases: sdlcPhases, expectedVersion: undefined }).expect(200);
    const phaseIds = first.body.phases.map((phase: { id: string }) => phase.id);

    const second = await request(app).put(`/api/projects/${projectId}/lifecycle`)
      .send({ mode: "enforced", expectedVersion: 1 }).expect(200);
    expect(second.body).toMatchObject({ mode: "enforced", version: 2 });
    expect(second.body.phases.map((phase: { id: string }) => phase.id)).toEqual(phaseIds);

    const stale = await request(app).put(`/api/projects/${projectId}/lifecycle`)
      .send({ mode: "off", expectedVersion: 1 }).expect(409);
    expect(stale.body.details).toEqual({ currentVersion: 2 });

    const replaced = await request(app).put(`/api/projects/${projectId}/lifecycle`)
      .send({ mode: "enforced", phases: [{ key: "fix", name: "Fix" }, { key: "ship", name: "Ship", kind: "terminal" }] }).expect(200);
    expect(replaced.body.phases.map((phase: { key: string }) => phase.key)).toEqual(["fix", "ship"]);
  });

  it("rejects invalid phase lists", async () => {
    await enable();
    const { app, projectId } = await seed();
    await request(app).put(`/api/projects/${projectId}/lifecycle`)
      .send({ mode: "enforced", phases: sdlcPhases.slice(0, 3) }).expect(400);
    await request(app).put(`/api/projects/${projectId}/lifecycle`)
      .send({ mode: "enforced", phases: [{ key: "a", name: "A", reworkTo: ["b"] }, { key: "b", name: "B", kind: "terminal" }] })
      .expect(400);
  });

  it("lets agents read but not change lifecycle configuration", async () => {
    await enable();
    const { app, companyId, projectId, agentActor } = await seed();
    await request(app).put(`/api/projects/${projectId}/lifecycle`).send({ mode: "enforced", phases: sdlcPhases }).expect(200);
    const agentApp = routeApp(ctx.db, agentActor, projectLifecycleRoutes);
    await request(agentApp).get(`/api/projects/${projectId}/lifecycle`).expect(200);
    await request(agentApp).get(`/api/companies/${companyId}/lifecycle-templates`).expect(200);
    await request(agentApp).put(`/api/projects/${projectId}/lifecycle`).send({ mode: "off" }).expect(403);
    await request(agentApp).post(`/api/companies/${companyId}/lifecycle-templates`)
      .send({ key: "agent-made", name: "Agent made", phases: sdlcPhases }).expect(403);
    const [lifecycle] = await ctx.db.select().from(projectLifecycles)
      .where(and(eq(projectLifecycles.companyId, companyId), eq(projectLifecycles.projectId, projectId)));
    expect(lifecycle?.mode).toBe("enforced");
  });

  it("keeps lifecycles inside company boundaries", async () => {
    await enable();
    const own = await seed("Own");
    const other = await seed("Other");
    const foreignTemplate = await request(other.app).post(`/api/companies/${other.companyId}/lifecycle-templates`)
      .send({ key: "sdlc", name: "SDLC", phases: sdlcPhases }).expect(201);

    await request(own.app).get(`/api/projects/${other.projectId}/lifecycle`).expect(404);
    await request(own.app).put(`/api/projects/${other.projectId}/lifecycle`).send({ mode: "enforced", phases: sdlcPhases }).expect(404);
    await request(own.app).get(`/api/companies/${own.companyId}/lifecycle-templates/${foreignTemplate.body.id}`).expect(404);
    await request(own.app).put(`/api/projects/${own.projectId}/lifecycle`)
      .send({ mode: "enforced", templateId: foreignTemplate.body.id }).expect(422);

    const foreignOwner = sdlcPhases.map(phase => phase.key === "design" ? { ...phase, ownerAgentId: other.agentId } : phase);
    const rejected = await request(own.app).put(`/api/projects/${own.projectId}/lifecycle`)
      .send({ mode: "enforced", phases: foreignOwner }).expect(422);
    expect(rejected.body.details).toEqual({ agentIds: [other.agentId] });
    const foreignReviewer = sdlcPhases.map(phase => phase.key === "uat"
      ? { ...phase, exitGate: { stages: [{ type: "approval", participants: [{ type: "user", userId: other.userId }] }] } }
      : phase);
    await request(own.app).put(`/api/projects/${own.projectId}/lifecycle`)
      .send({ mode: "enforced", phases: foreignReviewer }).expect(422);
  });
});
