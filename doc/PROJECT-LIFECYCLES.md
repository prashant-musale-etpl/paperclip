# Project lifecycles

Status: experimental. Enable **Project lifecycles** in Instance settings →
Experimental. The implementation contract is in
[SPEC-implementation.md](SPEC-implementation.md) ("Experimental project
lifecycles"); the design history is in
[plans/2026-10-24-project-lifecycle-phases.md](plans/2026-10-24-project-lifecycle-phases.md).

A project lifecycle is an ordered list of phases that every top-level task in the
project moves through, for example:

```
Requirements → Design → Development → Testing → UAT → Deploy → Release
```

Each project has its own lifecycle, so Project A can follow a full delivery
process while Project B uses Triage → Fix → Verify → Ship.

## Concepts

| Term | Meaning |
| --- | --- |
| Phase | A step with a name, key, optional owner (agent or person), instructions for the owner and an exit gate. The last phase is the final one. |
| Exit gate | What must be true before a task leaves the phase: required task documents (by key, non-empty), required active work products (for example a pull request), finished sub-tasks, and review/approval stages. |
| Mode | `off` (ignored), `advisory` (unmet gates are recorded, the task still moves on) or `enforced` (unmet gates block). |
| Rework | Sending a task back to an earlier phase the current phase allows, for example Testing → Development. |
| Override | A board move to any phase, with a reason. |
| Template | A reusable company phase list. Built-in presets (Software delivery, Bug fix) are always available. Adopting a template copies it; later template edits do not change existing projects. |

## How tasks move

1. A new top-level task in the project starts in the first phase. If no assignee
   was given, the phase owner takes it.
2. The owner does the phase's work and marks the task **done**.
3. The phase's review/approval stages run first, as for any task.
4. The rest of the gate is checked. In `enforced` mode a missing item is rejected
   with `422 phase_gate_unmet` and a list of what is missing.
5. If the phase is not the last one, the task enters the next phase instead of
   closing: status returns to `todo`, the next owner is assigned and woken, and
   that phase's reviewers apply. Only the final phase closes the task.

Every change is recorded in the task's phase history and the activity log.

Sub-tasks, agent conversations and tasks that existed before the lifecycle was
configured have no phase. The board can place an existing task into the lifecycle
with an override.

## Setting it up

**Board UI.** Open a project's **Lifecycle** tab. Choose a mode, pick a preset or
company template under **Start from** (or build the phases by hand), assign owners
and reviewers, and **Save lifecycle**. **Save as company template** stores the
current phases for other projects.

**CLI.**

```sh
npx paperclipai lifecycle set <project-id> --mode enforced --preset sdlc
npx paperclipai lifecycle get <project-id>
```

See [CLI.md](CLI.md#lifecycle-commands) for all commands.

**API.** `PUT /api/projects/:id/lifecycle` with `mode` and either `templateId`
or `phases`. Company templates live under
`/api/companies/:companyId/lifecycle-templates`.

## Working with phased tasks

- Task detail shows a **Lifecycle** section: where the task is, what the gate
  still needs, the phase instructions and history. **Move phase** sends work back
  or, for the board, overrides the phase.
- The project's **Tasks** tab can group by **Phase**.
- Agents see the current phase, its instructions and the unmet gate items in
  their run context. They complete a phase by marking the task done and can send
  their own task back with `POST /api/issues/:id/phase-transitions`
  (`kind: "rework"`).

## Permissions

| Action | Board | Assigned agent | Other agents |
| --- | --- | --- | --- |
| Read lifecycles, templates, task phase and history | Yes | Yes | Yes, with task access |
| Change lifecycles and templates | Yes | No | No |
| Complete a phase (mark done) | Yes | Yes | Per normal task rules |
| Rework to an allowed phase | Yes | Yes | No |
| Override to any phase | Yes | No | No |

## Limits

- One lifecycle per project; phases are per task, so different tasks can be in
  different phases. A waterfall-style project can use one top-level delivery task
  with sub-tasks.
- The board view stays grouped by status; phase grouping is a list option.
- Owners are concrete agents or people, not roles.
