import { Router, type Request } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import {
  createLifecycleTemplateSchema,
  issuePhaseTransitionRequestSchema,
  listLifecycleTemplatesQuerySchema,
  putProjectLifecycleSchema,
  updateLifecycleTemplateSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { forbidden, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { accessService, heartbeatService, issueService, projectService } from "../services/index.js";
import { describeIssuePhase, listIssuePhaseTransitions } from "../services/issue-phases.js";
import { projectLifecycleService, requireProjectLifecyclesEnabled, type LifecycleActor } from "../services/project-lifecycles.js";
import { assertBoard, assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";

/**
 * Lifecycle configuration decides which gates agents must pass, so every
 * write is board-only. Agents with access may read it.
 */
export function projectLifecycleRoutes(db: Db) {
  const router = Router();
  const service = projectLifecycleService(db);
  const projects = projectService(db);
  const access = accessService(db);
  const issueSvc = issueService(db);
  const heartbeat = heartbeatService(db);

  function lifecycleActor(req: Request): LifecycleActor {
    const actor = getActorInfo(req);
    return { actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId };
  }

  async function readableProject(req: Request) {
    const id = z.string().guid().parse(req.params.id);
    const project = await projects.getById(id);
    if (!project || !hasCompanyAccess(req, project.companyId)) throw notFound("Project not found");
    assertCompanyAccess(req, project.companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "project:read",
      resource: { type: "project", companyId: project.companyId, projectId: project.id },
    });
    if (!decision.allowed) throw notFound("Project not found");
    return project;
  }

  /** Same issue access decision as the issue routes; unreadable tasks are 404. */
  async function accessibleIssue(req: Request, action: "issue:read" | "issue:mutate") {
    const id = z.string().guid().parse(req.params.id);
    const [issue] = await db.select().from(issues).where(eq(issues.id, id));
    if (!issue || !hasCompanyAccess(req, issue.companyId)) throw notFound("Issue not found");
    assertCompanyAccess(req, issue.companyId);
    const scope = {
      issueId: issue.id,
      projectId: issue.projectId,
      parentIssueId: issue.parentId,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
    };
    for (const step of action === "issue:read" ? ["issue:read"] as const : ["issue:read", "issue:mutate"] as const) {
      const decision = await access.decide({
        actor: req.actor,
        action: step,
        resource: { type: "issue", companyId: issue.companyId, ...scope, status: issue.status },
        scope,
      });
      if (!decision.allowed) throw step === "issue:read" ? notFound("Issue not found") : forbidden(decision.explanation);
    }
    return issue;
  }

  router.get("/companies/:companyId/lifecycle-templates", async (req, res) => {
    await requireProjectLifecyclesEnabled(db);
    const companyId = z.string().guid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const query = listLifecycleTemplatesQuerySchema.parse(req.query);
    res.json(await service.listTemplates(companyId, { includeArchived: query.includeArchived }));
  });

  router.post("/companies/:companyId/lifecycle-templates", validate(createLifecycleTemplateSchema), async (req, res) => {
    await requireProjectLifecyclesEnabled(db);
    const companyId = z.string().guid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    res.status(201).json(await service.createTemplate(companyId, lifecycleActor(req), req.body));
  });

  router.get("/companies/:companyId/lifecycle-templates/:templateId", async (req, res) => {
    await requireProjectLifecyclesEnabled(db);
    const companyId = z.string().guid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    res.json(await service.getTemplate(companyId, z.string().guid().parse(req.params.templateId)));
  });

  router.patch("/companies/:companyId/lifecycle-templates/:templateId", validate(updateLifecycleTemplateSchema), async (req, res) => {
    await requireProjectLifecyclesEnabled(db);
    const companyId = z.string().guid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const templateId = z.string().guid().parse(req.params.templateId);
    res.json(await service.updateTemplate(companyId, templateId, lifecycleActor(req), req.body));
  });

  router.get("/projects/:id/lifecycle", async (req, res) => {
    await requireProjectLifecyclesEnabled(db);
    const project = await readableProject(req);
    const lifecycle = await service.getProjectLifecycle(project.companyId, project.id);
    if (!lifecycle) throw notFound("Project has no lifecycle");
    res.json(lifecycle);
  });

  router.put("/projects/:id/lifecycle", validate(putProjectLifecycleSchema), async (req, res) => {
    await requireProjectLifecyclesEnabled(db);
    const project = await readableProject(req);
    assertBoard(req);
    res.json(await service.putProjectLifecycle(project.companyId, project.id, lifecycleActor(req), req.body));
  });

  router.get("/issues/:id/phase", async (req, res) => {
    await requireProjectLifecyclesEnabled(db);
    const issue = await accessibleIssue(req, "issue:read");
    const phase = await describeIssuePhase(db, issue);
    if (!phase) throw notFound("Task has no lifecycle phase");
    res.json({ issueId: issue.id, phaseVersion: issue.phaseVersion, phaseEnteredAt: issue.phaseEnteredAt, ...phase });
  });

  router.get("/issues/:id/phase-transitions", async (req, res) => {
    await requireProjectLifecyclesEnabled(db);
    const issue = await accessibleIssue(req, "issue:read");
    res.json(await listIssuePhaseTransitions(db, issue.companyId, issue.id));
  });

  /**
   * Rework (board or the task's assigned agent) or board override. Forward
   * moves only happen by completing the task, so exit gates always run.
   */
  router.post("/issues/:id/phase-transitions", validate(issuePhaseTransitionRequestSchema), async (req, res) => {
    await requireProjectLifecyclesEnabled(db);
    const issue = await accessibleIssue(req, "issue:mutate");
    const actorIsBoard = req.actor.type === "board";
    if (req.body.kind === "override") assertBoard(req);
    if (!actorIsBoard && !(req.actor.type === "agent" && req.actor.agentId === issue.assigneeAgentId)) {
      throw forbidden("Only the board or the task's assigned agent can send it back for rework");
    }
    const actor = lifecycleActor(req);
    const updated = await issueSvc.update(issue.id, {
      phaseMove: { ...req.body, actorIsBoard },
      companyGuard: issue.companyId,
      actorAgentId: actor.actorType === "agent" ? actor.agentId : null,
      actorUserId: actor.actorType === "user" ? actor.actorId : null,
      actorRunId: actor.runId,
    });
    if (!updated) throw notFound("Issue not found");
    if (updated.assigneeAgentId && updated.status !== "backlog") {
      await heartbeat.wakeup(updated.assigneeAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: updated.id, mutation: "phase_transition", phaseKey: updated.phaseKey },
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        contextSnapshot: { issueId: updated.id, source: "issue.phase_transition" },
      }).catch(err => logger.warn({ err, issueId: updated.id }, "failed to wake phase owner after phase transition"));
    }
    const [row] = await db.select().from(issues).where(and(eq(issues.id, updated.id), eq(issues.companyId, issue.companyId)));
    res.json({ issueId: updated.id, phaseKey: row?.phaseKey ?? null, phaseVersion: row?.phaseVersion ?? null, status: updated.status,
      assigneeAgentId: updated.assigneeAgentId, assigneeUserId: updated.assigneeUserId });
  });

  return router;
}
