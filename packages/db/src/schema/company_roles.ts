import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Company-defined approval roles (for example "Business Analyst" or "QA").
 * Review and approval stages can name a role instead of a person; any user
 * who currently holds the role may then decide that stage.
 */
export const companyRoles = pgTable(
  "company_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUq: uniqueIndex("company_roles_company_key_uq").on(table.companyId, table.key),
    companyIdx: index("company_roles_company_idx").on(table.companyId),
  }),
);

/** Which users hold which role. One row per (role, user). */
export const companyRoleAssignments = pgTable(
  "company_role_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").notNull().references(() => companyRoles.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    assignedByUserId: text("assigned_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    roleUserUq: uniqueIndex("company_role_assignments_role_user_uq").on(table.roleId, table.userId),
    companyUserIdx: index("company_role_assignments_company_user_idx").on(table.companyId, table.userId),
  }),
);
