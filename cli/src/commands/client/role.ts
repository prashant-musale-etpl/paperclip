import { Command } from "commander";
import type { CompanyRole } from "@paperclipai/shared";
import {
  assignCompanyRoleSchema,
  createCompanyRoleSchema,
  SUGGESTED_COMPANY_ROLES,
  updateCompanyRoleSchema,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface RoleListOptions extends BaseClientOptions {
  companyId?: string;
  includeArchived?: boolean;
}

interface RoleCreateOptions extends BaseClientOptions {
  companyId?: string;
  key?: string;
  name?: string;
  description?: string;
  suggested?: boolean;
}

interface RoleUpdateOptions extends BaseClientOptions {
  companyId?: string;
  name?: string;
  description?: string;
  archive?: boolean;
  unarchive?: boolean;
}

interface RoleHolderOptions extends BaseClientOptions {
  companyId?: string;
  user: string;
}

type DirectoryEntry = { principalId: string; user: { id?: string; email?: string | null; name?: string | null } | null };

function printRole(role: CompanyRole) {
  console.log(formatInlineRecord({
    id: role.id,
    key: role.key,
    name: role.name,
    archived: role.archivedAt ? "yes" : null,
    holders: role.holders.map((holder) => holder.email ?? holder.name ?? holder.userId).join(", ") || "(none)",
  }));
}

/** Accepts a role id or key; keys are looked up in the company's roles. */
export async function resolveRoleId(
  api: { get<T>(path: string): Promise<T | null> },
  companyId: string,
  roleRef: string,
): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(roleRef)) return roleRef;
  const roles = (await api.get<CompanyRole[]>(apiPath`/api/companies/${companyId}/roles?includeArchived=true`)) ?? [];
  const match = roles.find((role) => role.key === roleRef);
  if (!match) throw new Error(`No role with key "${roleRef}". Run "paperclipai role list" to see the company's roles.`);
  return match.id;
}

/** Accepts a user id or an email address of an active company member. */
export async function resolveUserId(
  api: { get<T>(path: string): Promise<T | null> },
  companyId: string,
  userRef: string,
): Promise<string> {
  if (!userRef.includes("@")) return userRef;
  const directory = await api.get<{ users: DirectoryEntry[] }>(apiPath`/api/companies/${companyId}/user-directory`);
  const wanted = userRef.trim().toLowerCase();
  const match = directory?.users.find((entry) => entry.user?.email?.toLowerCase() === wanted);
  if (!match) throw new Error(`No active member of this company has the email ${userRef}.`);
  return match.principalId;
}

export function registerRoleCommands(program: Command): void {
  const role = program
    .command("role")
    .description("Company approval roles: review and approval stages can name a role instead of a person");

  addCommonClientOptions(
    role
      .command("list")
      .description("List the company's roles and who holds each")
      .option("-C, --company-id <id>", "Company ID")
      .option("--include-archived", "Include archived roles")
      .action(async (opts: RoleListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const query = opts.includeArchived ? "?includeArchived=true" : "";
          const rows = (await ctx.api.get<CompanyRole[]>(`${apiPath`/api/companies/${ctx.companyId}/roles`}${query}`)) ?? [];
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          if (rows.length === 0) console.log("No roles yet. Create one with \"paperclipai role create\" or add the suggested set with --suggested.");
          rows.forEach(printRole);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    role
      .command("create")
      .description("Create a role, or the suggested delivery roles with --suggested (board only)")
      .option("-C, --company-id <id>", "Company ID")
      .option("--key <key>", "Role key, e.g. qa")
      .option("--name <name>", "Role name, e.g. QA")
      .option("--description <text>", "What the role approves")
      .option("--suggested", `Create the suggested roles that do not exist yet (${SUGGESTED_COMPANY_ROLES.map((entry) => entry.key).join(", ")})`)
      .action(async (opts: RoleCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          if (opts.suggested) {
            if (opts.key || opts.name) throw new Error("Use --suggested or --key/--name, not both.");
            const existing = (await ctx.api.get<CompanyRole[]>(`${apiPath`/api/companies/${ctx.companyId}/roles`}?includeArchived=true`)) ?? [];
            const created: CompanyRole[] = [];
            for (const suggestion of SUGGESTED_COMPANY_ROLES) {
              if (existing.some((row) => row.key === suggestion.key)) continue;
              const row = await ctx.api.post<CompanyRole>(apiPath`/api/companies/${ctx.companyId}/roles`, suggestion);
              if (row) created.push(row);
            }
            if (ctx.json) {
              printOutput(created, { json: true });
              return;
            }
            if (created.length === 0) console.log("All suggested roles already exist.");
            created.forEach(printRole);
            return;
          }
          if (!opts.key || !opts.name) throw new Error("Provide --key and --name, or --suggested.");
          const payload = createCompanyRoleSchema.parse({ key: opts.key, name: opts.name, description: opts.description });
          const created = await ctx.api.post<CompanyRole>(apiPath`/api/companies/${ctx.companyId}/roles`, payload);
          if (ctx.json || !created) {
            printOutput(created, { json: ctx.json });
            return;
          }
          printRole(created);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    role
      .command("update")
      .description("Rename, describe, archive or unarchive a role (board only)")
      .argument("<role>", "Role id or key")
      .option("-C, --company-id <id>", "Company ID")
      .option("--name <name>", "New name")
      .option("--description <text>", "New description")
      .option("--archive", "Archive the role (stages naming it then resolve to nobody)")
      .option("--unarchive", "Restore an archived role")
      .action(async (roleRef: string, opts: RoleUpdateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          if (opts.archive && opts.unarchive) throw new Error("Use --archive or --unarchive, not both.");
          const roleId = await resolveRoleId(ctx.api, ctx.companyId!, roleRef);
          const payload = updateCompanyRoleSchema.parse({
            name: opts.name,
            description: opts.description,
            archived: opts.archive ? true : opts.unarchive ? false : undefined,
          });
          const saved = await ctx.api.patch<CompanyRole>(apiPath`/api/companies/${ctx.companyId}/roles/${roleId}`, payload);
          if (ctx.json || !saved) {
            printOutput(saved, { json: ctx.json });
            return;
          }
          printRole(saved);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    role
      .command("assign")
      .description("Give a company member a role (board only)")
      .argument("<role>", "Role id or key")
      .requiredOption("--user <user>", "User id or email of an active company member")
      .option("-C, --company-id <id>", "Company ID")
      .action(async (roleRef: string, opts: RoleHolderOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const roleId = await resolveRoleId(ctx.api, ctx.companyId!, roleRef);
          const userId = await resolveUserId(ctx.api, ctx.companyId!, opts.user);
          const saved = await ctx.api.post<CompanyRole>(
            apiPath`/api/companies/${ctx.companyId}/roles/${roleId}/holders`,
            assignCompanyRoleSchema.parse({ userId }),
          );
          if (ctx.json || !saved) {
            printOutput(saved, { json: ctx.json });
            return;
          }
          printRole(saved);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    role
      .command("unassign")
      .description("Take a role away from a company member (board only)")
      .argument("<role>", "Role id or key")
      .requiredOption("--user <user>", "User id or email")
      .option("-C, --company-id <id>", "Company ID")
      .action(async (roleRef: string, opts: RoleHolderOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const roleId = await resolveRoleId(ctx.api, ctx.companyId!, roleRef);
          const userId = await resolveUserId(ctx.api, ctx.companyId!, opts.user);
          const saved = await ctx.api.delete<CompanyRole>(apiPath`/api/companies/${ctx.companyId}/roles/${roleId}/holders/${userId}`);
          if (ctx.json || !saved) {
            printOutput(saved, { json: ctx.json });
            return;
          }
          printRole(saved);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
