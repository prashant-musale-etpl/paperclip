import fs from "node:fs";
import { Command } from "commander";
import type {
  IssuePhaseResponse,
  IssuePhaseTransition,
  LifecycleTemplate,
  ProjectLifecycle,
} from "@paperclipai/shared";
import {
  createLifecycleTemplateSchema,
  issuePhaseTransitionRequestSchema,
  LIFECYCLE_TEMPLATE_PRESETS,
  putProjectLifecycleSchema,
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

interface TemplateListOptions extends BaseClientOptions {
  companyId?: string;
}

interface TemplateCreateOptions extends BaseClientOptions {
  companyId?: string;
  key: string;
  name: string;
  description?: string;
  preset?: string;
  phasesFile?: string;
}

interface LifecycleSetOptions extends BaseClientOptions {
  mode: string;
  templateId?: string;
  preset?: string;
  phasesFile?: string;
  expectedVersion?: string;
}

interface PhaseMoveOptions extends BaseClientOptions {
  kind: string;
  to: string;
  reason: string;
  expectedPhaseVersion?: string;
}

/** Phases from `--preset` or a JSON file holding an array or `{ "phases": [...] }`. */
export function readPhasesSource(opts: { preset?: string; phasesFile?: string }): unknown[] | undefined {
  if (opts.preset && opts.phasesFile) throw new Error("Use --preset or --phases-file, not both.");
  if (opts.preset) {
    const preset = LIFECYCLE_TEMPLATE_PRESETS.find((entry) => entry.key === opts.preset);
    if (!preset) {
      throw new Error(`Unknown preset "${opts.preset}". Available: ${LIFECYCLE_TEMPLATE_PRESETS.map((entry) => entry.key).join(", ")}.`);
    }
    return preset.phases;
  }
  if (opts.phasesFile) {
    const parsed: unknown = JSON.parse(fs.readFileSync(opts.phasesFile, "utf8"));
    const phases = Array.isArray(parsed) ? parsed : (parsed as { phases?: unknown })?.phases;
    if (!Array.isArray(phases)) throw new Error("The phases file must contain a JSON array or an object with a \"phases\" array.");
    return phases;
  }
  return undefined;
}

function parseOptionalInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${flag} must be an integer.`);
  return parsed;
}

function printLifecycle(lifecycle: ProjectLifecycle) {
  console.log(formatInlineRecord({ projectId: lifecycle.projectId, mode: lifecycle.mode, version: lifecycle.version, templateId: lifecycle.templateId }));
  lifecycle.phases.forEach((phase, index) => {
    console.log(formatInlineRecord({
      position: index + 1,
      key: phase.key,
      name: phase.name,
      kind: phase.kind,
      ownerAgentId: phase.ownerAgentId,
      ownerUserId: phase.ownerUserId,
      requiredDocuments: phase.exitGate.requiredDocuments.join(",") || null,
      requiredWorkProducts: phase.exitGate.requiredWorkProductTypes.join(",") || null,
      reviewStages: phase.exitGate.stages.length,
      reworkTo: phase.reworkTo.join(",") || null,
    }));
  });
}

export function registerLifecycleCommands(program: Command): void {
  const lifecycle = program.command("lifecycle").description("Project lifecycle phases (experimental)");
  const templates = lifecycle.command("templates").description("Company lifecycle templates and built-in presets");

  templates
    .command("presets")
    .description("List built-in presets usable with --preset")
    .option("--json", "Output raw JSON")
    .action((opts: { json?: boolean }) => {
      if (opts.json) {
        printOutput(LIFECYCLE_TEMPLATE_PRESETS, { json: true });
        return;
      }
      for (const preset of LIFECYCLE_TEMPLATE_PRESETS) {
        console.log(formatInlineRecord({ key: preset.key, name: preset.name, phases: preset.phases.map((phase) => phase.key).join(" > ") }));
      }
    });

  addCommonClientOptions(
    templates
      .command("list")
      .description("List a company's lifecycle templates")
      .option("-C, --company-id <id>", "Company ID")
      .action(async (opts: TemplateListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<LifecycleTemplate[]>(apiPath`/api/companies/${ctx.companyId}/lifecycle-templates`)) ?? [];
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          for (const row of rows) {
            console.log(formatInlineRecord({ id: row.id, key: row.key, name: row.name, phases: row.phases.map((phase) => phase.key).join(" > ") }));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    templates
      .command("create")
      .description("Create a company template from a preset or a phases JSON file (board only)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--key <key>", "Template key")
      .requiredOption("--name <name>", "Template name")
      .option("--description <text>", "Template description")
      .option("--preset <key>", "Built-in preset to copy")
      .option("--phases-file <path>", "JSON file with the phases")
      .action(async (opts: TemplateCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const phases = readPhasesSource(opts);
          if (!phases) throw new Error("Provide --preset or --phases-file.");
          const payload = createLifecycleTemplateSchema.parse({ key: opts.key, name: opts.name, description: opts.description, phases });
          const created = await ctx.api.post<LifecycleTemplate>(apiPath`/api/companies/${ctx.companyId}/lifecycle-templates`, payload);
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    lifecycle
      .command("get")
      .description("Show a project's lifecycle")
      .argument("<projectId>", "Project ID")
      .action(async (projectId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<ProjectLifecycle>(apiPath`/api/projects/${projectId}/lifecycle`);
          if (ctx.json || !row) {
            printOutput(row, { json: ctx.json });
            return;
          }
          printLifecycle(row);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    lifecycle
      .command("set")
      .description("Replace a project's lifecycle, or change only its mode (board only)")
      .argument("<projectId>", "Project ID")
      .requiredOption("--mode <mode>", "off | advisory | enforced")
      .option("--template-id <id>", "Copy the phases of a company template")
      .option("--preset <key>", "Copy the phases of a built-in preset")
      .option("--phases-file <path>", "JSON file with the phases")
      .option("--expected-version <n>", "Reject the change if the lifecycle changed since this version")
      .action(async (projectId: string, opts: LifecycleSetOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const phases = readPhasesSource(opts);
          if (phases && opts.templateId) throw new Error("Use --template-id, --preset or --phases-file, not several.");
          const payload = putProjectLifecycleSchema.parse({
            mode: opts.mode,
            templateId: opts.templateId,
            phases,
            expectedVersion: parseOptionalInt(opts.expectedVersion, "--expected-version"),
          });
          const saved = await ctx.api.put<ProjectLifecycle>(apiPath`/api/projects/${projectId}/lifecycle`, payload);
          if (ctx.json || !saved) {
            printOutput(saved, { json: ctx.json });
            return;
          }
          printLifecycle(saved);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    lifecycle
      .command("phase")
      .description("Show a task's current phase and what its exit gate still needs")
      .argument("<issueId>", "Task ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<IssuePhaseResponse>(apiPath`/api/issues/${issueId}/phase`);
          if (ctx.json || !row) {
            printOutput(row, { json: ctx.json });
            return;
          }
          console.log(formatInlineRecord({
            phase: row.phase.key,
            name: row.phase.name,
            position: `${row.position}/${row.phaseCount}`,
            mode: row.mode,
            next: row.nextPhase?.key ?? null,
            phaseVersion: row.phaseVersion,
            reworkTo: row.reworkTo.join(",") || null,
          }));
          for (const { kind, ...detail } of row.unmetGate) console.log(formatInlineRecord({ unmet: kind, ...detail }));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    lifecycle
      .command("history")
      .description("List a task's phase changes")
      .argument("<issueId>", "Task ID")
      .action(async (issueId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<IssuePhaseTransition[]>(apiPath`/api/issues/${issueId}/phase-transitions`)) ?? [];
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          for (const row of rows) {
            console.log(formatInlineRecord({
              at: String(row.createdAt),
              kind: row.kind,
              from: row.fromPhaseKey,
              to: row.toPhaseKey,
              reason: row.reason,
              unmet: row.gateGaps.length || null,
            }));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    lifecycle
      .command("move")
      .description("Send a task back for rework, or override its phase (board only)")
      .argument("<issueId>", "Task ID")
      .requiredOption("--kind <kind>", "rework | override")
      .requiredOption("--to <phaseKey>", "Target phase key")
      .requiredOption("--reason <text>", "Why the phase is changing")
      .option("--expected-phase-version <n>", "Reject the move if the task's phase changed since this version")
      .action(async (issueId: string, opts: PhaseMoveOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const payload = issuePhaseTransitionRequestSchema.parse({
            kind: opts.kind,
            toPhaseKey: opts.to,
            reason: opts.reason,
            expectedPhaseVersion: parseOptionalInt(opts.expectedPhaseVersion, "--expected-phase-version"),
          });
          const result = await ctx.api.post(apiPath`/api/issues/${issueId}/phase-transitions`, payload);
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}
