import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanyRole } from "@paperclipai/shared";
import { Archive, ArchiveRestore, BadgeCheck, Pencil, Plus, Sparkles, X } from "lucide-react";
import { accessApi, type CompanyMember } from "@/api/access";
import { companyRolesApi } from "@/api/companyRoles";
import { QueryErrorState } from "@/components/QueryView";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { missingSuggestedRoles, roleKeyFromName } from "@/lib/company-roles";
import { queryKeys } from "@/lib/queryKeys";

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function memberLabel(member: Pick<CompanyMember, "principalId" | "user">): string {
  return member.user?.name?.trim() || member.user?.email?.trim() || member.principalId;
}

export function CompanyRoles() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Organization", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Roles" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const rolesQuery = useQuery({
    queryKey: queryKeys.companyRoles.list(selectedCompanyId ?? "", { includeArchived: true }),
    queryFn: () => companyRolesApi.list(selectedCompanyId!, { includeArchived: true }),
    enabled: !!selectedCompanyId,
  });
  const membersQuery = useQuery({
    queryKey: queryKeys.access.companyMembers(selectedCompanyId ?? ""),
    queryFn: () => accessApi.listMembers(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const activeMembers = useMemo(
    () => (membersQuery.data?.members ?? [])
      .filter((member) => member.status === "active" && member.principalType === "user")
      .sort((a, b) => memberLabel(a).localeCompare(memberLabel(b))),
    [membersQuery.data?.members],
  );

  const invalidateRoles = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.companyRoles.all(selectedCompanyId ?? "") });

  const roles = rolesQuery.data ?? [];
  const suggestions = missingSuggestedRoles(roles);

  const addSuggested = useMutation({
    mutationFn: async () => {
      // Sequential so a failure part-way leaves the created roles visible and the rest retryable.
      for (const role of missingSuggestedRoles(rolesQuery.data)) {
        await companyRolesApi.create(selectedCompanyId!, role);
      }
    },
    onSettled: () => void invalidateRoles(),
  });

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">Select an organization to manage roles.</div>;
  }

  const visibleRoles = roles
    .filter((role) => showArchived || !role.archivedAt)
    .sort((a, b) => Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) || a.name.localeCompare(b.name));
  const archivedCount = roles.filter((role) => role.archivedAt).length;

  return (
    <div className="max-w-4xl space-y-8">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <BadgeCheck className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Roles</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Name a job instead of a person on review and approval stages. Any current holder of a role can decide a
          stage that names it, except the person whose work is under review.
        </p>
      </div>

      <CreateRoleForm
        companyId={selectedCompanyId}
        existingKeys={roles.map((role) => role.key)}
        onCreated={() => void invalidateRoles()}
      />

      {suggestions.length > 0 && !rolesQuery.isLoading && !rolesQuery.error ? (
        <div className="space-y-2 rounded-lg border border-dashed border-border p-4">
          <p className="text-sm font-medium">Suggested roles</p>
          <p className="text-xs text-muted-foreground">
            {suggestions.map((role) => role.name).join(", ")}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={addSuggested.isPending}
            onClick={() => addSuggested.mutate()}
          >
            <Sparkles className="size-3.5" />
            {addSuggested.isPending ? "Adding…" : "Add suggested roles"}
          </Button>
          {addSuggested.error ? (
            <p role="alert" className="text-sm text-destructive">
              {errorText(addSuggested.error, "Could not add the suggested roles.")}
            </p>
          ) : null}
        </div>
      ) : null}

      <section className="space-y-3" aria-label="Company roles">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Company roles</h2>
          {archivedCount > 0 ? (
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Checkbox checked={showArchived} onCheckedChange={(checked) => setShowArchived(checked === true)} />
              Show archived ({archivedCount})
            </label>
          ) : null}
        </div>

        {rolesQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading roles…</p>
        ) : rolesQuery.error ? (
          <QueryErrorState
            error={rolesQuery.error}
            action="load company roles"
            onRetry={() => void rolesQuery.refetch()}
            retrying={rolesQuery.isFetching}
          />
        ) : visibleRoles.length === 0 ? (
          <p className="text-sm text-muted-foreground">No roles yet.</p>
        ) : (
          <ul className="space-y-3">
            {visibleRoles.map((role) => (
              <li key={role.id}>
                <RoleCard
                  companyId={selectedCompanyId}
                  role={role}
                  members={activeMembers}
                  membersLoading={membersQuery.isLoading}
                  membersError={membersQuery.error}
                  onChanged={() => void invalidateRoles()}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CreateRoleForm({
  companyId,
  existingKeys,
  onCreated,
}: {
  companyId: string;
  existingKeys: string[];
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [description, setDescription] = useState("");
  const effectiveKey = keyEdited ? key : roleKeyFromName(name);
  const keyTaken = existingKeys.includes(effectiveKey.trim());

  const create = useMutation({
    mutationFn: () => companyRolesApi.create(companyId, {
      key: effectiveKey.trim(),
      name: name.trim(),
      description: description.trim() || null,
    }),
    onSuccess: () => {
      setName("");
      setKey("");
      setKeyEdited(false);
      setDescription("");
      onCreated();
    },
  });

  return (
    <form
      className="space-y-3 rounded-lg border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim() || !effectiveKey.trim() || keyTaken) return;
        create.mutate();
      }}
    >
      <p className="text-sm font-medium">New role</p>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1">
          <span className="block text-xs text-muted-foreground">Name</span>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="QA" aria-label="Role name" />
        </label>
        <label className="space-y-1">
          <span className="block text-xs text-muted-foreground">Key</span>
          <Input
            value={effectiveKey}
            onChange={(event) => {
              setKey(event.target.value);
              setKeyEdited(true);
            }}
            placeholder="qa"
            className="font-mono"
            aria-label="Role key"
          />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="block text-xs text-muted-foreground">Description (optional)</span>
        <Textarea value={description} onChange={(event) => setDescription(event.target.value)} aria-label="Role description" />
      </label>
      {keyTaken ? <p className="text-sm text-destructive">A role with the key “{effectiveKey.trim()}” already exists.</p> : null}
      {create.error ? (
        <p role="alert" className="text-sm text-destructive">{errorText(create.error, "Could not create the role.")}</p>
      ) : null}
      <Button type="submit" size="sm" disabled={!name.trim() || !effectiveKey.trim() || keyTaken || create.isPending}>
        <Plus className="size-3.5" />
        {create.isPending ? "Creating…" : "Create role"}
      </Button>
    </form>
  );
}

function RoleCard({
  companyId,
  role,
  members,
  membersLoading,
  membersError,
  onChanged,
}: {
  companyId: string;
  role: CompanyRole;
  members: CompanyMember[];
  membersLoading: boolean;
  membersError: unknown;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(role.name);
  const [draftDescription, setDraftDescription] = useState(role.description ?? "");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const archived = Boolean(role.archivedAt);

  const applyRole = (next: CompanyRole) => {
    queryClient.setQueryData<CompanyRole[]>(
      queryKeys.companyRoles.list(companyId, { includeArchived: true }),
      (current) => current?.map((entry) => (entry.id === next.id ? next : entry)),
    );
    setErrorMessage(null);
    onChanged();
  };
  const onError = (fallback: string) => (error: unknown) => setErrorMessage(errorText(error, fallback));

  const save = useMutation({
    mutationFn: () => companyRolesApi.update(companyId, role.id, {
      name: draftName.trim(),
      description: draftDescription.trim() || null,
    }),
    onSuccess: (next) => {
      setEditing(false);
      applyRole(next);
    },
    onError: onError("Could not save the role."),
  });
  const setArchived = useMutation({
    mutationFn: (nextArchived: boolean) => companyRolesApi.update(companyId, role.id, { archived: nextArchived }),
    onSuccess: applyRole,
    onError: onError("Could not change the role."),
  });
  const assign = useMutation({
    mutationFn: (userId: string) => companyRolesApi.assignHolder(companyId, role.id, { userId }),
    onSuccess: applyRole,
    onError: onError("Could not assign the member."),
  });
  const unassign = useMutation({
    mutationFn: (userId: string) => companyRolesApi.removeHolder(companyId, role.id, userId),
    onSuccess: applyRole,
    onError: onError("Could not remove the holder."),
  });

  const holderIds = new Set(role.holders.map((holder) => holder.userId));
  const assignable = members.filter((member) => !holderIds.has(member.principalId));
  const busy = save.isPending || setArchived.isPending || assign.isPending || unassign.isPending;

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        {editing ? (
          <div className="min-w-0 flex-1 space-y-2">
            <Input value={draftName} onChange={(event) => setDraftName(event.target.value)} aria-label={`Name for ${role.name}`} />
            <Textarea
              value={draftDescription}
              onChange={(event) => setDraftDescription(event.target.value)}
              placeholder="Description"
              aria-label={`Description for ${role.name}`}
            />
            <div className="flex gap-2">
              <Button size="sm" disabled={!draftName.trim() || busy} onClick={() => save.mutate()}>
                {save.isPending ? "Saving…" : "Save"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setDraftName(role.name);
                  setDraftDescription(role.description ?? "");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">{role.name}</h3>
              <span className="font-mono text-xs text-muted-foreground">{role.key}</span>
              {archived ? <Badge variant="outline">Archived</Badge> : null}
            </div>
            {role.description ? <p className="text-sm text-muted-foreground">{role.description}</p> : null}
          </div>
        )}
        {!editing ? (
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || archived}
              onClick={() => {
                setDraftName(role.name);
                setDraftDescription(role.description ?? "");
                setEditing(true);
              }}
            >
              <Pencil className="size-3.5" /> Edit
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setArchived.mutate(!archived)}>
              {archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
              {archived ? "Unarchive" : "Archive"}
            </Button>
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">Holders</p>
        {role.holders.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nobody holds this role yet. Stages that name it cannot be decided.</p>
        ) : (
          <ul className="flex flex-wrap gap-2" aria-label={`${role.name} holders`}>
            {role.holders.map((holder) => {
              const label = holder.name?.trim() || holder.email?.trim() || holder.userId;
              return (
                <li
                  key={holder.userId}
                  className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs"
                  title={holder.email ?? undefined}
                >
                  {label}
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                    disabled={busy}
                    onClick={() => unassign.mutate(holder.userId)}
                    aria-label={`Remove ${label} from ${role.name}`}
                  >
                    <X className="size-3" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {!archived ? (
          membersError ? (
            <p className="text-sm text-destructive">
              Could not load company members: {errorText(membersError, "unknown error")}
            </p>
          ) : (
            <NativeSelect
              value=""
              disabled={busy || membersLoading || assignable.length === 0}
              onChange={(event) => {
                const userId = event.target.value;
                if (userId) assign.mutate(userId);
              }}
              aria-label={`Assign a member to ${role.name}`}
            >
              <option value="">
                {membersLoading
                  ? "Loading members…"
                  : assignable.length === 0
                    ? "Every active member holds this role"
                    : "Assign a member…"}
              </option>
              {assignable.map((member) => (
                <option key={member.principalId} value={member.principalId}>
                  {memberLabel(member)}
                  {member.user?.email && member.user.name ? ` (${member.user.email})` : ""}
                </option>
              ))}
            </NativeSelect>
          )
        ) : null}
      </div>

      {errorMessage ? <p role="alert" className="text-sm text-destructive">{errorMessage}</p> : null}
    </div>
  );
}
