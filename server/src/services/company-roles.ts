import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  authUsers,
  companyMemberships,
  companyRoleAssignments,
  companyRoles,
  issueExecutionDecisions,
  type Db,
} from "@paperclipai/db";
import type {
  CompanyRole,
  CreateCompanyRole,
  IssueExecutionPolicy,
  UpdateCompanyRole,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { isUniqueViolation } from "../db-errors.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { policyRoleIds } from "./issue-execution-policy.js";

/** Who changed a role; mirrors the activity-log actor fields. */
export type CompanyRoleActor = {
  actorType: "agent" | "user";
  actorId: string;
  agentId: string | null;
  runId: string | null;
};

type RoleRow = typeof companyRoles.$inferSelect;

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

async function holdersByRole(db: Db, companyId: string, roleIds: string[]) {
  const byRole = new Map<string, CompanyRole["holders"]>();
  if (roleIds.length === 0) return byRole;
  const rows = await db
    .select({
      roleId: companyRoleAssignments.roleId,
      userId: companyRoleAssignments.userId,
      assignedByUserId: companyRoleAssignments.assignedByUserId,
      createdAt: companyRoleAssignments.createdAt,
      name: authUsers.name,
      email: authUsers.email,
    })
    .from(companyRoleAssignments)
    .leftJoin(authUsers, eq(authUsers.id, companyRoleAssignments.userId))
    .where(and(eq(companyRoleAssignments.companyId, companyId), inArray(companyRoleAssignments.roleId, roleIds)))
    .orderBy(asc(companyRoleAssignments.createdAt));
  for (const row of rows) {
    const list = byRole.get(row.roleId) ?? [];
    list.push({
      userId: row.userId,
      name: row.name ?? null,
      email: row.email ?? null,
      assignedAt: row.createdAt.toISOString(),
      assignedByUserId: row.assignedByUserId ?? null,
    });
    byRole.set(row.roleId, list);
  }
  return byRole;
}

function toRole(row: RoleRow, holders: CompanyRole["holders"]): CompanyRole {
  return {
    id: row.id,
    companyId: row.companyId,
    key: row.key,
    name: row.name,
    description: row.description ?? null,
    archivedAt: iso(row.archivedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    holders,
  };
}

async function assertActiveCompanyUser(db: Db, companyId: string, userId: string) {
  const [membership] = await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId),
      eq(companyMemberships.status, "active"),
    ));
  if (!membership) throw unprocessable("Only active members of this company can hold a role", { userId });
}

/**
 * Role participants must name roles of the same company. Archived roles are
 * refused for new configuration so a gate never silently resolves to nobody.
 */
export async function assertRolesInCompany(db: Db, companyId: string, roleIds: Iterable<string>) {
  const ids = [...new Set(roleIds)];
  if (ids.length === 0) return;
  const found = await db
    .select({ id: companyRoles.id })
    .from(companyRoles)
    .where(and(eq(companyRoles.companyId, companyId), inArray(companyRoles.id, ids), isNull(companyRoles.archivedAt)));
  const missing = ids.filter((id) => !found.some((row) => row.id === id));
  if (missing.length > 0) throw unprocessable("Stage roles must be active roles of this company", { roleIds: missing });
}

export type RoleApprovalContext = {
  roleHolders: Record<string, string[]>;
  actorApprovedRoleIds: string[];
};

/**
 * Everything the execution-stage engine needs to decide role-gated stages:
 * the current holders of each role the policy names, and the roles the actor
 * has already approved under on this issue (separation of duties). Returns
 * an empty context, with no queries, when the policy names no roles.
 */
export async function loadRoleApprovalContext(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    policy: IssueExecutionPolicy | null | undefined;
    actorUserId: string | null | undefined;
  },
): Promise<RoleApprovalContext> {
  const roleIds = policyRoleIds(input.policy);
  if (roleIds.length === 0) return { roleHolders: {}, actorApprovedRoleIds: [] };
  const assignments = await db
    .select({ roleId: companyRoleAssignments.roleId, userId: companyRoleAssignments.userId })
    .from(companyRoleAssignments)
    .innerJoin(companyRoles, eq(companyRoles.id, companyRoleAssignments.roleId))
    .innerJoin(companyMemberships, and(
      eq(companyMemberships.companyId, companyRoleAssignments.companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, companyRoleAssignments.userId),
      eq(companyMemberships.status, "active"),
    ))
    .where(and(
      eq(companyRoleAssignments.companyId, input.companyId),
      inArray(companyRoleAssignments.roleId, roleIds),
      isNull(companyRoles.archivedAt),
    ))
    .orderBy(asc(companyRoleAssignments.createdAt));
  const roleHolders: Record<string, string[]> = {};
  for (const row of assignments) {
    (roleHolders[row.roleId] ??= []).push(row.userId);
  }
  let actorApprovedRoleIds: string[] = [];
  if (input.actorUserId) {
    const approvals = await db
      .selectDistinct({ viaRoleId: issueExecutionDecisions.viaRoleId })
      .from(issueExecutionDecisions)
      .where(and(
        eq(issueExecutionDecisions.companyId, input.companyId),
        eq(issueExecutionDecisions.issueId, input.issueId),
        eq(issueExecutionDecisions.actorUserId, input.actorUserId),
        eq(issueExecutionDecisions.outcome, "approved"),
      ));
    actorApprovedRoleIds = approvals.flatMap((row) => (row.viaRoleId ? [row.viaRoleId] : []));
  }
  return { roleHolders, actorApprovedRoleIds };
}

export function companyRoleService(db: Db) {
  async function getRoleRow(companyId: string, roleId: string, runner: Db = db) {
    const [row] = await runner
      .select()
      .from(companyRoles)
      .where(and(eq(companyRoles.companyId, companyId), eq(companyRoles.id, roleId)));
    if (!row) throw notFound("Role not found");
    return row;
  }

  async function getRole(companyId: string, roleId: string, runner: Db = db): Promise<CompanyRole> {
    const row = await getRoleRow(companyId, roleId, runner);
    const holders = await holdersByRole(runner, companyId, [row.id]);
    return toRole(row, holders.get(row.id) ?? []);
  }

  return {
    getRole: (companyId: string, roleId: string) => getRole(companyId, roleId),

    async listRoles(companyId: string, options: { includeArchived?: boolean } = {}): Promise<CompanyRole[]> {
      const rows = await db
        .select()
        .from(companyRoles)
        .where(and(
          eq(companyRoles.companyId, companyId),
          options.includeArchived ? undefined : isNull(companyRoles.archivedAt),
        ))
        .orderBy(asc(companyRoles.name));
      const holders = await holdersByRole(db, companyId, rows.map((row) => row.id));
      return rows.map((row) => toRole(row, holders.get(row.id) ?? []));
    },

    async createRole(companyId: string, actor: CompanyRoleActor, input: CreateCompanyRole): Promise<CompanyRole> {
      const result = await db.transaction(async (transaction) => {
        const tx = transaction as unknown as Db;
        const [row] = await tx.insert(companyRoles).values({
          companyId,
          key: input.key,
          name: input.name,
          description: input.description ?? null,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        }).returning();
        const { publication } = await persistActivity(tx, {
          companyId, ...actor, action: "company_role.created", entityType: "company_role", entityId: row!.id,
          details: { key: row!.key, name: row!.name },
        });
        return { row: row!, publication };
      }).catch((error) => {
        if (isUniqueViolation(error)) throw conflict(`A role with key "${input.key}" already exists`);
        throw error;
      });
      publishActivity(result.publication);
      return toRole(result.row, []);
    },

    async updateRole(companyId: string, roleId: string, actor: CompanyRoleActor, input: UpdateCompanyRole): Promise<CompanyRole> {
      const publication = await db.transaction(async (transaction) => {
        const tx = transaction as unknown as Db;
        const existing = await getRoleRow(companyId, roleId, tx);
        const archivedAt = input.archived === undefined
          ? existing.archivedAt
          : input.archived ? existing.archivedAt ?? new Date() : null;
        await tx.update(companyRoles).set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          archivedAt,
          updatedAt: new Date(),
        }).where(and(eq(companyRoles.companyId, companyId), eq(companyRoles.id, roleId)));
        const { publication } = await persistActivity(tx, {
          companyId, ...actor, action: "company_role.updated", entityType: "company_role", entityId: roleId,
          details: { changedKeys: Object.keys(input).sort() },
        });
        return publication;
      });
      publishActivity(publication);
      return getRole(companyId, roleId);
    },

    async assignRole(companyId: string, roleId: string, actor: CompanyRoleActor, userId: string): Promise<CompanyRole> {
      const publication = await db.transaction(async (transaction) => {
        const tx = transaction as unknown as Db;
        const role = await getRoleRow(companyId, roleId, tx);
        if (role.archivedAt) throw unprocessable("Archived roles cannot be assigned");
        await assertActiveCompanyUser(tx, companyId, userId);
        const inserted = await tx.insert(companyRoleAssignments).values({
          companyId,
          roleId,
          userId,
          assignedByUserId: actor.actorType === "user" ? actor.actorId : null,
        }).onConflictDoNothing().returning({ id: companyRoleAssignments.id });
        if (inserted.length === 0) return null;
        const { publication } = await persistActivity(tx, {
          companyId, ...actor, action: "company_role.assigned", entityType: "company_role", entityId: roleId,
          details: { roleKey: role.key, userId },
        });
        return publication;
      });
      if (publication) publishActivity(publication);
      return getRole(companyId, roleId);
    },

    async unassignRole(companyId: string, roleId: string, actor: CompanyRoleActor, userId: string): Promise<CompanyRole> {
      const publication = await db.transaction(async (transaction) => {
        const tx = transaction as unknown as Db;
        const role = await getRoleRow(companyId, roleId, tx);
        const removed = await tx.delete(companyRoleAssignments).where(and(
          eq(companyRoleAssignments.companyId, companyId),
          eq(companyRoleAssignments.roleId, roleId),
          eq(companyRoleAssignments.userId, userId),
        )).returning({ id: companyRoleAssignments.id });
        if (removed.length === 0) throw notFound("That user does not hold this role");
        const { publication } = await persistActivity(tx, {
          companyId, ...actor, action: "company_role.unassigned", entityType: "company_role", entityId: roleId,
          details: { roleKey: role.key, userId },
        });
        return publication;
      });
      publishActivity(publication);
      return getRole(companyId, roleId);
    },
  };
}
