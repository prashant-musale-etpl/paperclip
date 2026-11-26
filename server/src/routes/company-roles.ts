import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  assignCompanyRoleSchema,
  createCompanyRoleSchema,
  updateCompanyRoleSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { companyRoleService, type CompanyRoleActor } from "../services/company-roles.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * Company roles decide who may approve role-gated review and approval
 * stages, so every write is board-only. Anyone with company access may read
 * roles and their holders (agents need them to explain who must approve).
 */
export function companyRoleRoutes(db: Db) {
  const router = Router();
  const service = companyRoleService(db);

  function roleActor(req: Request): CompanyRoleActor {
    const actor = getActorInfo(req);
    return { actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId };
  }

  function companyIdParam(req: Request) {
    const companyId = z.string().guid().parse(req.params.companyId);
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  router.get("/companies/:companyId/roles", async (req, res) => {
    const companyId = companyIdParam(req);
    const includeArchived = req.query.includeArchived === "true";
    res.json(await service.listRoles(companyId, { includeArchived }));
  });

  router.post("/companies/:companyId/roles", validate(createCompanyRoleSchema), async (req, res) => {
    const companyId = companyIdParam(req);
    assertBoard(req);
    res.status(201).json(await service.createRole(companyId, roleActor(req), req.body));
  });

  router.get("/companies/:companyId/roles/:roleId", async (req, res) => {
    const companyId = companyIdParam(req);
    res.json(await service.getRole(companyId, z.string().guid().parse(req.params.roleId)));
  });

  router.patch("/companies/:companyId/roles/:roleId", validate(updateCompanyRoleSchema), async (req, res) => {
    const companyId = companyIdParam(req);
    assertBoard(req);
    const roleId = z.string().guid().parse(req.params.roleId);
    res.json(await service.updateRole(companyId, roleId, roleActor(req), req.body));
  });

  router.post("/companies/:companyId/roles/:roleId/holders", validate(assignCompanyRoleSchema), async (req, res) => {
    const companyId = companyIdParam(req);
    assertBoard(req);
    const roleId = z.string().guid().parse(req.params.roleId);
    res.json(await service.assignRole(companyId, roleId, roleActor(req), req.body.userId));
  });

  router.delete("/companies/:companyId/roles/:roleId/holders/:userId", async (req, res) => {
    const companyId = companyIdParam(req);
    assertBoard(req);
    const roleId = z.string().guid().parse(req.params.roleId);
    const userId = z.string().trim().min(1).max(200).parse(req.params.userId);
    res.json(await service.unassignRole(companyId, roleId, roleActor(req), userId));
  });

  return router;
}
