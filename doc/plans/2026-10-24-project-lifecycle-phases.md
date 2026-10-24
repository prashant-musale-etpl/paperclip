# Project lifecycles: configurable, enforced phases per project

Status: step 1 implemented (configuration layer behind
`experimental.enableProjectLifecycles`). Decision 2026-10-24: build per-task
phases first; a waterfall project can be approximated by one top-level
"Project delivery" task with sub-tasks. A project-level phase mode may follow.

## Problem

Projects and tasks (issues) have no notion of a delivery process. A user wants
each project to declare an ordered set of phases that work must move through,
for example:

- Project A: Requirements → Design → Development → Testing → UAT → Deploy → Release
- Project B: Triage → Fix → Verify → Ship

The process must be configurable per project and **enforced**: work cannot skip
a phase, and a phase cannot be left until its exit criteria are met.

## What exists today (and why it is not enough)

| Existing piece | Where | Relevance |
| --- | --- | --- |
| Fixed issue statuses `backlog/todo/in_progress/in_review/done/blocked/cancelled` | `packages/shared/src/constants.ts` | Execution state of one task. Hard-coded, used by partial indexes and ~13k lines of `server/src/services/issues.ts`. Not safe to make per-project. |
| Execution policy stages (`review`, `approval`) with agent/user participants | `issueExecutionPolicySchema` in `packages/shared/src/validators/issue.ts`, `server/src/services/issue-execution-policy.ts` | Already intercepts a `done` request, routes to reviewers/approvers, and only lets `done` land once they sign off. **This is the gate primitive we reuse.** |
| Reusable `workflows` (name + Markdown prompt) for Cases | `packages/db/src/schema/workflows.ts`, SPEC-implementation §6 | Prose-only guidance; the spec explicitly says there is no server-configured phase graph. Advisory, not enforced. |
| Pipelines (stages, transitions, `projectId`, `enforceTransitions`) | `packages/db/src/schema/pipelines.ts`, `pipeline_cases.ts` | **Retired 2026-10-19.** Tables remain only for data preservation. It modelled a parallel "case" object with its own leases and automation beside issues. |

Lesson from Pipelines: a second work object running parallel to issues
duplicates assignment, checkout, wakeups and review, and ends up retired.
This design therefore **decorates issues** with a phase and reuses the existing
execution-policy gates, rather than introducing a new work entity or engine.

Note: SPEC-implementation currently states workflow routing has no
server-configured phase graph (for Cases). This proposal adds one at the
project level, so it needs explicit maintainer sign-off and a SPEC update.

## Options considered

1. **Advisory only (smallest).** Add `projects.workflowId` pointing at an
   existing `workflows` prompt and inject it into agent context; track phase
   via labels. Cheap and consistent with current philosophy, but nothing is
   enforced, which fails the "must be followed" requirement.
2. **Project lifecycle with phase gates on issues (recommended).** Described
   below.
3. **General state-machine / BPMN engine.** Arbitrary graphs, guards, timers.
   This is roughly what Pipelines attempted; too much surface for V1.

## Recommended design

### Concepts

- **Lifecycle template**: company-scoped, reusable ordered list of phases
  (e.g. "SDLC", "Bugfix"). Editing a template affects only future adoptions,
  matching how case `workflows` already behave.
- **Project lifecycle**: a project's own copy of the phases plus an
  enforcement mode. Projects without one behave exactly as today.
- **Phase**: key, name, position, kind (`work` | `terminal`), owner, agent
  instructions, and an **exit gate**.
- **Issue phase**: tracked work items (top-level issues in the project by
  default) carry `phaseKey`. Status stays orthogonal: it describes execution
  *within* the current phase.

```
phase:  Requirements ──► Design ──► Development ──► Testing ──► UAT ──► Deploy ──► Release
status:  todo → in_progress → in_review → (gate passes) ──► next phase, status reset to todo
```

### Exit gates

A phase's `exitGate` is a declarative checklist, evaluated by the server:

```jsonc
{
  "requiredDocuments": ["requirements"],      // issue_documents keys that must exist and be non-empty
  "requireChildrenTerminal": true,            // sub-issues done/cancelled
  "stages": [                                 // reuses IssueExecutionStage (review | approval)
    { "type": "review",   "participants": [{ "type": "agent", "agentId": "<architect>" }] },
    { "type": "approval", "participants": [{ "type": "user",  "userId": "<product owner>" }] }
  ],
  "requireWorkProducts": ["pull_request"]     // optional, e.g. Development needs a PR
}
```

Mechanics, reusing existing code:

1. On **phase entry**, the server writes the phase's gate `stages` into the
   issue's `executionPolicy.stages`, sets `status = todo`, and assigns the
   phase owner (agent or user), then wakes the assignee through the ordinary
   wake queue.
2. The assignee works normally and requests `done`. The existing
   `applyIssueExecutionPolicyTransition` routes it through review/approval
   participants exactly as today.
3. When the transition would land `done`, a new lifecycle step runs inside the
   same transaction: it checks the non-stage gate items (documents, children,
   work products). If unmet → `422 phase_gate_unmet` with a structured list of
   missing items. If met and the phase is not terminal → advance `phaseKey`,
   reset status/assignee for the next phase instead of closing the issue.
   Only the terminal phase lets the issue actually become `done`.

This keeps the single-assignee model, atomic checkout, and approval gates
intact (AGENTS.md §5.3) and adds no new execution service.

### Transitions and enforcement

- `lifecycleMode` per project: `off` | `advisory` | `enforced`.
  - `advisory`: gates are evaluated and shown, violations are logged, not blocked.
  - `enforced`: only forward-by-one moves (via the gate) are allowed;
    `done` outside the terminal phase is impossible.
- **Rework** (e.g. Testing → Development when tests fail): each phase may list
  `reworkTo: ["development"]`. Moving back requires a reason, clears pending
  stage state, and reassigns to that phase's owner.
- **Board override**: board actors may force a move with a mandatory reason.
  Logged as an override in activity and the transition ledger. Agents cannot override.
- Optimistic concurrency via `phaseVersion` (409 on mismatch), like `statusVersion`.

### Data model (`packages/db`)

New tables, all company-scoped (names avoid the existing `workflows` table):

```ts
lifecycle_templates        // id, company_id, key, name, description, phases jsonb,
                           // created_by_*, archived_at, timestamps; unique(company_id, key)

project_lifecycles         // project_id PK/FK, company_id, template_id (nullable, provenance),
                           // template_snapshot_at, mode ('off'|'advisory'|'enforced'),
                           // scope ('top_level'|'all_issues'), version int, timestamps

project_lifecycle_phases   // id, project_id, company_id, key, name, position, kind ('work'|'terminal'),
                           // owner_agent_id, owner_user_id, instructions text,
                           // exit_gate jsonb, rework_to text[], timestamps
                           // unique(project_id, key), unique(project_id, position)

issue_phase_transitions    // id, company_id, issue_id, project_id, from_phase_key, to_phase_key,
                           // kind ('advance'|'rework'|'override'|'initial'),
                           // reason, gate_evidence jsonb, actor_agent_id, actor_user_id,
                           // run_id, created_at
```

Columns added to `issues`: `phase_key text null`, `phase_version bigint default 0`,
`phase_entered_at timestamptz null`, plus index `(company_id, project_id, phase_key)`.

Phases are stored as rows (not only jsonb) on the project so issues can be
queried/grouped per phase and keys validated with constraints. Template phases
stay jsonb because they are copied, not referenced.

### Shared contracts (`packages/shared`)

- Constants: `LIFECYCLE_MODES`, `LIFECYCLE_PHASE_KINDS`, `PHASE_TRANSITION_KINDS`.
- Zod validators: `lifecyclePhaseSchema`, `phaseExitGateSchema` (stages reuse
  `issueExecutionStageSchema`), `projectLifecycleSchema`, `issuePhaseTransitionRequestSchema`.
- Types for issue `phase` summary (current phase, gate status, next phase).

### Server (`server`)

- `services/project-lifecycles.ts`: template CRUD, apply template to project
  (copy), edit phases (reject removing a phase that has issues in it unless a
  `moveIssuesTo` key is given), gate evaluation (pure, unit-testable).
- Hook in `services/issues.ts` at the `done` landing point and at issue creation
  (new issues in a lifecycle project start in phase 1).
- Agent context: include current phase name, instructions, and unmet gate
  items in the run's execution context so the agent knows what "done" means
  for this phase. Follow `rules/heartbeat-execution-boundaries.mdc` for any
  heartbeat touch; keep the logic in the new service and call it from there.
- Native agent tools: `read_issue_phase`, `request_phase_rework`.
  Advancing happens through the normal "mark done" path, so agents need no new
  habit.

REST (all with company access checks, actor checks, and activity logging):

```
GET/POST   /api/companies/:companyId/lifecycle-templates
GET/PATCH  /api/lifecycle-templates/:id
GET/PUT    /api/projects/:projectId/lifecycle            # apply template / edit phases / mode
POST       /api/issues/:issueId/phase-transitions        # { toPhaseKey, kind, reason, expectedPhaseVersion }
GET        /api/issues/:issueId/phase-transitions        # history
```

Errors: `404` unknown phase, `409 phase_version_conflict`,
`422 phase_gate_unmet` (with missing items), `403` override by a non-board actor.

### UI (`ui`)

- Project settings → **Lifecycle** tab: pick a template or start blank, ordered
  phase editor (name, owner, instructions, gate checklist, rework targets),
  mode toggle.
- Project board: optional "group by phase" columns.
- Issue detail: phase stepper with the current gate checklist, history, and
  a board-only override/rework action with required reason.
- Phase filter on issue lists.
- Token-only styling per `DESIGN.md`; run `pnpm check:token-gates`.

### Example: Project A

| Phase | Owner | Exit gate |
| --- | --- | --- |
| Requirements | PM agent | doc `requirements`; approval by product owner (user) |
| Design | Architect agent | doc `design`; review by Tech Lead agent |
| Development | Engineer agent | work product `pull_request`; review by Reviewer agent; children terminal |
| Testing | QA agent | doc `test-report`; rework → Development |
| UAT | Product owner (user) | approval by user; rework → Development |
| Deploy | DevOps agent | doc `deploy-log`; rework → Development |
| Release (terminal) | Board | approval by board user |

Project B uses its own shorter phase list; the two never interact.

## Rollout

Behind `experimental.enableProjectLifecycles`. Projects without a lifecycle
are unaffected, so no data backfill is needed.

1. PR 1 – schema, migration, shared contracts, service + gate evaluation, REST,
   unit and real-database tests. **Done.** Adjustments from the proposal:
   `issues.phase_key`, `issue_phase_transitions` and the transition endpoint
   move to PR 2, because advancing a task must go through the issues service
   (assignment, wakeups, checkout) rather than a direct table write; template
   routes are nested under the company (`/companies/:companyId/lifecycle-templates/:templateId`).
2. PR 2 – issues `done` hook, agent execution context, native tools,
   `skills/paperclip` guidance.
3. PR 3 – UI (lifecycle editor, issue stepper, board grouping).
4. PR 4 – seeded templates (SDLC, Bugfix), docs (SPEC-implementation, maps),
   CLI support.

## Open questions

- Should sub-issues inherit their parent's phase (read-only) or be ungated?
  Proposed default: only top-level issues are gated (`scope: top_level`).
- Project-level phase for waterfall projects: deferred (see decision above).
- Are phase owners concrete agents or roles resolved at entry time?
  Proposed: concrete agent/user, with role resolution as a follow-up.
- Phase-level budgets or SLAs (time-in-phase alerts) — follow-up.
