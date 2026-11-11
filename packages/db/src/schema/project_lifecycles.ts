import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";

/**
 * Stored phase/gate shapes. The validated contract lives in
 * `@paperclipai/shared` (`lifecyclePhaseSchema`); these types only describe
 * persisted JSON so the schema package stays dependency-free.
 */
export type StoredLifecyclePhaseExitGate = {
  requiredDocuments?: string[];
  requireChildrenTerminal?: boolean;
  requiredWorkProductTypes?: string[];
  stages?: Record<string, unknown>[];
};

export type StoredLifecyclePhase = {
  key: string;
  name: string;
  kind: string;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
  instructions?: string | null;
  exitGate?: StoredLifecyclePhaseExitGate;
  reworkTo?: string[];
};

export const lifecycleTemplates = pgTable(
  "lifecycle_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    phases: jsonb("phases").$type<StoredLifecyclePhase[]>().notNull(),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUq: uniqueIndex("lifecycle_templates_company_key_uq").on(table.companyId, table.key),
  }),
);

export const projectLifecycles = pgTable(
  "project_lifecycles",
  {
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull(),
    templateId: uuid("template_id").references(() => lifecycleTemplates.id, { onDelete: "set null" }),
    mode: text("mode").notNull().default("off"),
    version: integer("version").notNull().default(1),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // The composite key doubles as the target of the phases' company-scoped
    // foreign key; the projects FK keeps one lifecycle per project.
    pk: primaryKey({ columns: [table.companyId, table.projectId] }),
    project: foreignKey({ columns: [table.companyId, table.projectId], foreignColumns: [projects.companyId, projects.id] })
      .onDelete("cascade"),
    modeCheck: check("project_lifecycles_mode_check", sql`${table.mode} in ('off', 'advisory', 'enforced')`),
  }),
);

export const projectLifecyclePhases = pgTable(
  "project_lifecycle_phases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    projectId: uuid("project_id").notNull(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    kind: text("kind").notNull(),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    ownerUserId: text("owner_user_id"),
    instructions: text("instructions"),
    exitGate: jsonb("exit_gate").$type<StoredLifecyclePhaseExitGate>().notNull().default({}),
    reworkTo: jsonb("rework_to").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    lifecycle: foreignKey({
      columns: [table.companyId, table.projectId],
      foreignColumns: [projectLifecycles.companyId, projectLifecycles.projectId],
    }).onDelete("cascade"),
    projectKeyUq: uniqueIndex("project_lifecycle_phases_project_key_uq").on(table.projectId, table.key),
    projectPositionUq: uniqueIndex("project_lifecycle_phases_project_position_uq").on(table.projectId, table.position),
    companyIdx: index("project_lifecycle_phases_company_idx").on(table.companyId),
    kindCheck: check("project_lifecycle_phases_kind_check", sql`${table.kind} in ('work', 'terminal')`),
  }),
);

/** Append-only history of an issue's phase changes. */
export const issuePhaseTransitions = pgTable(
  "issue_phase_transitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull(),
    fromPhaseKey: text("from_phase_key"),
    toPhaseKey: text("to_phase_key").notNull(),
    kind: text("kind").notNull(),
    lifecycleMode: text("lifecycle_mode").notNull(),
    reason: text("reason"),
    gateGaps: jsonb("gate_gaps").$type<Record<string, unknown>[]>().notNull().default([]),
    actorAgentId: uuid("actor_agent_id").references(() => agents.id, { onDelete: "set null" }),
    actorUserId: text("actor_user_id"),
    runId: uuid("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueCreatedIdx: index("issue_phase_transitions_issue_created_idx").on(table.companyId, table.issueId, table.createdAt),
    kindCheck: check(
      "issue_phase_transitions_kind_check",
      sql`${table.kind} in ('initial', 'advance', 'complete', 'rework', 'override')`,
    ),
  }),
);
