import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, createDb, issueExecutionDecisions, issues } from "@paperclipai/db";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { assertRolesInCompany, companyRoleService, loadRoleApprovalContext } from "../services/company-roles.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const actor = { actorType: "user" as const, actorId: "board-user", agentId: null, runId: null };

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("company roles", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-company-roles-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => { await temporary?.cleanup(); });

  async function company(members: string[]) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Roles fixture", issuePrefix: `R${companyId.slice(0, 6)}` });
    for (const userId of members) {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active" });
    }
    return companyId;
  }

  it("creates roles, assigns active members only, and rejects duplicate keys", async () => {
    const companyId = await company(["qa-1"]);
    const service = companyRoleService(db);
    const qa = await service.createRole(companyId, actor, { key: "qa", name: "QA" });
    await expect(service.createRole(companyId, actor, { key: "qa", name: "QA again" })).rejects.toThrow(/already exists/);
    await expect(service.assignRole(companyId, qa.id, actor, "stranger")).rejects.toThrow(/active members/);
    const assigned = await service.assignRole(companyId, qa.id, actor, "qa-1");
    expect(assigned.holders.map((holder) => holder.userId)).toEqual(["qa-1"]);
    // Assigning twice is a no-op.
    expect((await service.assignRole(companyId, qa.id, actor, "qa-1")).holders).toHaveLength(1);
    const removed = await service.unassignRole(companyId, qa.id, actor, "qa-1");
    expect(removed.holders).toEqual([]);
  });

  it("keeps roles company-scoped and refuses archived roles in new stages", async () => {
    const companyA = await company([]);
    const companyB = await company([]);
    const service = companyRoleService(db);
    const roleA = await service.createRole(companyA, actor, { key: "ba", name: "BA" });
    await expect(assertRolesInCompany(db, companyB, [roleA.id])).rejects.toThrow(/active roles of this company/);
    await assertRolesInCompany(db, companyA, [roleA.id]);
    await service.updateRole(companyA, roleA.id, actor, { archived: true });
    await expect(assertRolesInCompany(db, companyA, [roleA.id])).rejects.toThrow(/active roles of this company/);
    await expect(service.getRole(companyB, roleA.id)).rejects.toThrow(/not found/i);
  });

  it("loads current holders and the actor's earlier role approvals on the issue", async () => {
    const companyId = await company(["pat", "qa-1"]);
    const service = companyRoleService(db);
    const ba = await service.createRole(companyId, actor, { key: "ba", name: "BA" });
    const qa = await service.createRole(companyId, actor, { key: "qa", name: "QA" });
    await service.assignRole(companyId, ba.id, actor, "pat");
    await service.assignRole(companyId, qa.id, actor, "pat");
    await service.assignRole(companyId, qa.id, actor, "qa-1");
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Role context fixture" });
    await db.insert(issueExecutionDecisions).values({
      companyId, issueId, stageId: randomUUID(), stageType: "approval", actorUserId: "pat",
      viaRoleId: ba.id, outcome: "approved", body: "Requirements ok",
    });
    const policy = normalizeIssueExecutionPolicy({
      stages: [{ type: "approval", participants: [{ type: "role", roleId: qa.id }] }],
    });
    const context = await loadRoleApprovalContext(db, { companyId, issueId, policy, actorUserId: "pat" });
    expect(context.roleHolders).toEqual({ [qa.id]: ["pat", "qa-1"] });
    expect(context.actorApprovedRoleIds).toEqual([ba.id]);

    // Policies without roles need no queries and return an empty context.
    expect(await loadRoleApprovalContext(db, { companyId, issueId, policy: null, actorUserId: "pat" }))
      .toEqual({ roleHolders: {}, actorApprovedRoleIds: [] });
  });
});
