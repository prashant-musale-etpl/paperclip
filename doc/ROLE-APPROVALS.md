# Role-based approvals

Review and approval stages can name a **company role**, such as QA or Business
Analyst, instead of a particular person. Anyone who holds the role when the stage
is decided may approve it or request changes. This includes stages on a single
task and lifecycle exit gates.

## Concepts

| Term | Meaning |
| --- | --- |
| Role | A company-defined job with a key (`qa`), a name (`QA`) and an optional description. Roles can be archived. |
| Holder | An active company member assigned to a role. A person can hold several roles. |
| Role participant | A stage participant `{ "type": "role", "roleId": "<id>" }`. It can sit next to agent and user participants in the same stage. |

## How a role stage runs

1. When the stage opens, the role resolves to its current holders. The task is
   assigned to one holder, so it lands in that person's inbox.
2. **Any** current holder may decide, not only the assigned one. A comment is
   required, as for every stage decision.
3. The decision records who decided and the role they decided under
   (`viaRoleId` on the execution decision).
4. Holders are read at decision time. Adding or removing a holder takes effect
   for stages that are already pending.

Rules that keep approvals independent:

- **No self-approval.** The person whose work is under review (the stage's
  return assignee) cannot decide a role stage, even if they hold the role. A role
  review stage is never skipped automatically just because the author is the only
  holder. Instead it fails with `422 role_has_no_eligible_holder`.
- **Separation of duties.** On one task, a person who approved a gate under one
  role cannot approve another gate under a *different* role. The attempt
  returns `422 separation_of_duties`, and another holder must approve. Approving
  several gates under the *same* role is allowed. For example, an Engineering
  Lead can approve both Development and Release.
- Archived roles cannot be assigned or used in new stages. A stage that names a
  role nobody holds cannot start (`422 role_has_no_eligible_holder`).
- Board override works as before.

## Setting it up

**Board UI.** Company settings → **Roles**. Create roles (or **Add suggested
roles**) and assign members. Then pick a role as a reviewer or approver on a
task, or on a lifecycle phase's exit gate.

**CLI.**

```sh
npx paperclipai role create --suggested            # BA, Architect, Engineering Lead, QA, DevOps
npx paperclipai role assign qa --user qa.lead@example.com
npx paperclipai role list
npx paperclipai role unassign qa --user qa.lead@example.com
npx paperclipai role update qa --archive
```

**API.**

| Method and path | Purpose |
| --- | --- |
| `GET /api/companies/:companyId/roles[?includeArchived=true]` | Roles with holders |
| `POST /api/companies/:companyId/roles` | Create (`key`, `name`, `description`) |
| `GET`, `PATCH /api/companies/:companyId/roles/:roleId` | Read, rename, describe, archive (`archived: true`) |
| `POST /api/companies/:companyId/roles/:roleId/holders` | Assign (`userId`) |
| `DELETE /api/companies/:companyId/roles/:roleId/holders/:userId` | Unassign |

Every write is board-only and recorded in the activity log
(`company_role.created`, `.updated`, `.assigned`, `.unassigned`).

To use a role in a stage, put it in `executionPolicy.stages[].participants` on a
task, or in `exitGate.stages[].participants` on a lifecycle phase:

```json
{ "type": "approval", "participants": [{ "type": "role", "roleId": "<qa role id>" }] }
```

A stage needs one approval. To require two roles, for example BA and QA for UAT,
use two approval stages in a row.

## Permissions

| Action | Board | Agents | Role holders |
| --- | --- | --- | --- |
| Read roles and holders | Yes | Yes, with company access | Yes |
| Create, change and archive roles, assign holders | Yes | No | No |
| Decide a role stage | Through board override | Only if named directly as a participant | Yes, subject to the rules above |
