import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  createLifecycleTemplateSchema,
  listLifecycleTemplatesQuerySchema,
  putProjectLifecycleSchema,
  updateLifecycleTemplateSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { notFound } from "../errors.js";
import { accessService, projectService } from "../services/index.js";
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

  return router;
}
