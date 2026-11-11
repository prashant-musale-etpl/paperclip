import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  agents,
  companyMemberships,
  lifecycleTemplates,
  projectLifecyclePhases,
  projectLifecycles,
  type Db,
} from "@paperclipai/db";
import {
  lifecyclePhaseListSchema,
  type CreateLifecycleTemplate,
  type LifecycleMode,
  type LifecyclePhaseDefinition,
  type LifecycleTemplate,
  type ProjectLifecycle,
  type PutProjectLifecycle,
  type UpdateLifecycleTemplate,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { instanceSettingsService } from "./instance-settings.js";
import { persistActivity, publishActivity } from "./activity-log.js";

/** Who made a lifecycle change; mirrors the activity-log actor fields. */
export type LifecycleActor = {
  actorType: "agent" | "user";
  actorId: string;
  agentId: string | null;
  runId: string | null;
};

export async function requireProjectLifecyclesEnabled(db: Db) {
  if (!(await instanceSettingsService(db).getExperimental()).enableProjectLifecycles) {
    throw forbidden("Project lifecycles are disabled");
  }
}

function isUniqueViolation(error: unknown) {
  const candidate = error as { code?: string; cause?: { code?: string } } | null;
  return candidate?.code === "23505" || candidate?.cause?.code === "23505";
}

/** Stored JSON is re-parsed so callers always see the current contract with defaults applied. */
function parseStoredPhases(value: unknown): LifecyclePhaseDefinition[] {
  return lifecyclePhaseListSchema.parse(value);
}

function toTemplate(row: typeof lifecycleTemplates.$inferSelect): LifecycleTemplate {
  return {
    id: row.id,
    companyId: row.companyId,
    key: row.key,
    name: row.name,
    description: row.description,
    phases: parseStoredPhases(row.phases),
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Owners and stage participants must be principals of the same company. */
async function assertPhasePrincipalsInCompany(db: Db, companyId: string, phases: LifecyclePhaseDefinition[]) {
  const agentIds = new Set<string>();
  const userIds = new Set<string>();
  for (const phase of phases) {
    if (phase.ownerAgentId) agentIds.add(phase.ownerAgentId);
    if (phase.ownerUserId) userIds.add(phase.ownerUserId);
    for (const stage of phase.exitGate.stages) {
      for (const participant of stage.participants) {
        if (participant.agentId) agentIds.add(participant.agentId);
        if (participant.userId) userIds.add(participant.userId);
      }
    }
  }
  if (agentIds.size > 0) {
    const found = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, [...agentIds])));
    const missing = [...agentIds].filter(id => !found.some(row => row.id === id));
    if (missing.length > 0) throw unprocessable("Phase agents must belong to this company", { agentIds: missing });
  }
  if (userIds.size > 0) {
    const found = await db.select({ id: companyMemberships.principalId }).from(companyMemberships)
      .where(and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
        inArray(companyMemberships.principalId, [...userIds]),
      ));
    const missing = [...userIds].filter(id => !found.some(row => row.id === id));
    if (missing.length > 0) throw unprocessable("Phase users must be active members of this company", { userIds: missing });
  }
}

async function selectTemplateRow(runner: Db, companyId: string, id: string, options: { forUpdate?: boolean } = {}) {
  const query = runner.select().from(lifecycleTemplates)
    .where(and(eq(lifecycleTemplates.companyId, companyId), eq(lifecycleTemplates.id, id)));
  const [row] = options.forUpdate ? await query.for("update") : await query;
  return row ?? null;
}

export function projectLifecycleService(db: Db) {
  async function getProjectLifecycle(companyId: string, projectId: string, runner: Db = db): Promise<ProjectLifecycle | null> {
    const [lifecycle] = await runner.select().from(projectLifecycles)
      .where(and(eq(projectLifecycles.companyId, companyId), eq(projectLifecycles.projectId, projectId)));
    if (!lifecycle) return null;
    const phaseRows = await runner.select().from(projectLifecyclePhases)
      .where(and(eq(projectLifecyclePhases.companyId, companyId), eq(projectLifecyclePhases.projectId, projectId)))
      .orderBy(asc(projectLifecyclePhases.position));
    const definitions = parseStoredPhases(phaseRows.map(row => ({
      key: row.key,
      name: row.name,
      kind: row.kind,
      ownerAgentId: row.ownerAgentId,
      ownerUserId: row.ownerUserId,
      instructions: row.instructions,
      exitGate: row.exitGate,
      reworkTo: row.reworkTo,
    })));
    return {
      companyId: lifecycle.companyId,
      projectId: lifecycle.projectId,
      templateId: lifecycle.templateId,
      mode: lifecycle.mode as LifecycleMode,
      version: lifecycle.version,
      phases: definitions.map((definition, index) => ({ ...definition, id: phaseRows[index]!.id, position: phaseRows[index]!.position })),
      updatedAt: lifecycle.updatedAt,
    };
  }

  return {
    async listTemplates(companyId: string, options: { includeArchived?: boolean } = {}) {
      const rows = await db.select().from(lifecycleTemplates)
        .where(and(
          eq(lifecycleTemplates.companyId, companyId),
          options.includeArchived ? undefined : isNull(lifecycleTemplates.archivedAt),
        ))
        .orderBy(asc(lifecycleTemplates.name), asc(lifecycleTemplates.id));
      return rows.map(toTemplate);
    },

    async getTemplate(companyId: string, id: string) {
      const row = await selectTemplateRow(db, companyId, id);
      if (!row) throw notFound("Lifecycle template not found");
      return toTemplate(row);
    },

    async createTemplate(companyId: string, actor: LifecycleActor, input: CreateLifecycleTemplate) {
      const result = await db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        await requireProjectLifecyclesEnabled(tx);
        await assertPhasePrincipalsInCompany(tx, companyId, input.phases);
        const [row] = await tx.insert(lifecycleTemplates).values({
          companyId,
          key: input.key,
          name: input.name,
          description: input.description ?? null,
          phases: input.phases,
          createdByAgentId: actor.actorType === "agent" ? actor.agentId : null,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        }).returning();
        const { publication } = await persistActivity(tx, {
          companyId, ...actor, action: "lifecycle_template.created", entityType: "lifecycle_template", entityId: row!.id,
          details: { key: row!.key, name: row!.name, phaseKeys: input.phases.map(phase => phase.key) },
        });
        return { row: row!, publication };
      }).catch(error => {
        if (isUniqueViolation(error)) throw conflict(`A lifecycle template with key "${input.key}" already exists`);
        throw error;
      });
      publishActivity(result.publication);
      return toTemplate(result.row);
    },

    async updateTemplate(companyId: string, id: string, actor: LifecycleActor, input: UpdateLifecycleTemplate) {
      const result = await db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        await requireProjectLifecyclesEnabled(tx);
        const existing = await selectTemplateRow(tx, companyId, id, { forUpdate: true });
        if (!existing) throw notFound("Lifecycle template not found");
        if (input.phases) await assertPhasePrincipalsInCompany(tx, companyId, input.phases);
        const archivedAt = input.archived === undefined ? existing.archivedAt : input.archived ? existing.archivedAt ?? new Date() : null;
        const [row] = await tx.update(lifecycleTemplates).set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.phases !== undefined ? { phases: input.phases } : {}),
          archivedAt,
          updatedAt: new Date(),
        }).where(and(eq(lifecycleTemplates.companyId, companyId), eq(lifecycleTemplates.id, id))).returning();
        const { publication } = await persistActivity(tx, {
          companyId, ...actor, action: "lifecycle_template.updated", entityType: "lifecycle_template", entityId: id,
          details: { changedKeys: Object.keys(input).sort() },
        });
        return { row: row!, publication };
      });
      publishActivity(result.publication);
      return toTemplate(result.row);
    },

    getProjectLifecycle: (companyId: string, projectId: string) => getProjectLifecycle(companyId, projectId),

    /**
     * Replaces a project's lifecycle. Template phases are copied, so later
     * template edits do not change projects that already adopted it.
     */
    async putProjectLifecycle(companyId: string, projectId: string, actor: LifecycleActor, input: PutProjectLifecycle) {
      const result = await db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        await requireProjectLifecyclesEnabled(tx);
        const [existing] = await tx.select().from(projectLifecycles)
          .where(and(eq(projectLifecycles.companyId, companyId), eq(projectLifecycles.projectId, projectId)))
          .for("update");
        if (input.expectedVersion !== undefined && input.expectedVersion !== (existing?.version ?? 0)) {
          throw conflict("Project lifecycle changed; reload it and retry", { currentVersion: existing?.version ?? null });
        }

        let phases: LifecyclePhaseDefinition[] | null = input.phases ?? null;
        let templateId = existing?.templateId ?? null;
        if (input.templateId) {
          const template = await selectTemplateRow(tx, companyId, input.templateId);
          if (!template) throw unprocessable("Lifecycle template not found in this company");
          if (template.archivedAt) throw unprocessable("Archived lifecycle templates cannot be adopted");
          phases = parseStoredPhases(template.phases);
          templateId = template.id;
        } else if (input.phases) {
          templateId = null;
        }
        if (!phases && !existing) throw unprocessable("A new project lifecycle needs templateId or phases");
        if (phases) await assertPhasePrincipalsInCompany(tx, companyId, phases);

        const now = new Date();
        const actorColumns = {
          updatedByAgentId: actor.actorType === "agent" ? actor.agentId : null,
          updatedByUserId: actor.actorType === "user" ? actor.actorId : null,
        };
        if (existing) {
          await tx.update(projectLifecycles).set({
            mode: input.mode, templateId, version: existing.version + 1, updatedAt: now, ...actorColumns,
          }).where(and(eq(projectLifecycles.companyId, companyId), eq(projectLifecycles.projectId, projectId)));
        } else {
          await tx.insert(projectLifecycles).values({ companyId, projectId, mode: input.mode, templateId, ...actorColumns });
        }
        if (phases) {
          await tx.delete(projectLifecyclePhases)
            .where(and(eq(projectLifecyclePhases.companyId, companyId), eq(projectLifecyclePhases.projectId, projectId)));
          await tx.insert(projectLifecyclePhases).values(phases.map((phase, position) => ({
            companyId,
            projectId,
            position,
            key: phase.key,
            name: phase.name,
            kind: phase.kind,
            ownerAgentId: phase.ownerAgentId,
            ownerUserId: phase.ownerUserId,
            instructions: phase.instructions,
            exitGate: phase.exitGate,
            reworkTo: phase.reworkTo,
          })));
        }
        const lifecycle = (await getProjectLifecycle(companyId, projectId, tx))!;
        const { publication } = await persistActivity(tx, {
          companyId, ...actor, action: "project.lifecycle_updated", entityType: "project", entityId: projectId,
          details: {
            mode: lifecycle.mode,
            previousMode: existing?.mode ?? null,
            version: lifecycle.version,
            templateId: lifecycle.templateId,
            phasesReplaced: phases !== null,
            phaseKeys: lifecycle.phases.map(phase => phase.key),
          },
        });
        return { lifecycle, publication };
      });
      publishActivity(result.publication);
      return result.lifecycle;
    },
  };
}
