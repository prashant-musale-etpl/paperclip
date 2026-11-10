import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type {
  LifecycleMode,
  LifecyclePhaseExitGate,
  LifecyclePhaseInput,
  ProjectLifecycle,
  ProjectLifecyclePhase,
} from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { projectLifecyclesApi } from "@/api/projectLifecycles";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type Stage = ProjectLifecyclePhase["exitGate"]["stages"][number];

/** Editable phase; rework targets reference other drafts by `draftId` so key edits keep them. */
export interface PhaseDraft {
  draftId: string;
  key: string;
  keyEdited: boolean;
  name: string;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  instructions: string;
  requiredDocuments: string;
  requiredWorkProductTypes: LifecyclePhaseExitGate["requiredWorkProductTypes"];
  requireChildrenTerminal: boolean;
  reviewerAgentId: string | null;
  otherStages: Stage[];
  reworkTo: string[];
}

const WORK_PRODUCT_TYPES = [
  ["pull_request", "Pull request"],
  ["branch", "Branch"],
  ["commit", "Commit"],
  ["preview_url", "Preview URL"],
  ["artifact", "Artifact"],
  ["document", "Document"],
  ["runtime_service", "Runtime service"],
] as const;

const SDLC_EXAMPLE = ["Requirements", "Design", "Development", "Testing", "UAT", "Deploy", "Release"];

let draftCounter = 0;
const nextDraftId = () => `draft-${++draftCounter}`;

export function phaseKeyFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "phase";
}

function reviewerOf(stages: Stage[]) {
  const index = stages.findIndex((stage) =>
    stage.type === "review" && stage.participants.length === 1 && stage.participants[0]?.type === "agent");
  return index < 0
    ? { reviewerAgentId: null, otherStages: stages }
    : { reviewerAgentId: stages[index]!.participants[0]!.agentId ?? null, otherStages: stages.filter((_, i) => i !== index) };
}

export function draftsFromLifecycle(phases: Array<Omit<ProjectLifecyclePhase, "id" | "position">>): PhaseDraft[] {
  const drafts = phases.map((phase) => ({
    draftId: nextDraftId(),
    key: phase.key,
    keyEdited: true,
    name: phase.name,
    ownerAgentId: phase.ownerAgentId,
    ownerUserId: phase.ownerUserId,
    instructions: phase.instructions ?? "",
    requiredDocuments: phase.exitGate.requiredDocuments.join(", "),
    requiredWorkProductTypes: [...phase.exitGate.requiredWorkProductTypes],
    requireChildrenTerminal: phase.exitGate.requireChildrenTerminal,
    ...reviewerOf(phase.exitGate.stages),
    reworkTo: [] as string[],
  }));
  phases.forEach((phase, index) => {
    drafts[index]!.reworkTo = phase.reworkTo.flatMap((key) => {
      const target = drafts.find((draft) => draft.key === key);
      return target ? [target.draftId] : [];
    });
  });
  return drafts;
}

function blankDraft(name: string): PhaseDraft {
  return {
    draftId: nextDraftId(),
    key: phaseKeyFromName(name),
    keyEdited: false,
    name,
    ownerAgentId: null,
    ownerUserId: null,
    instructions: "",
    requiredDocuments: "",
    requiredWorkProductTypes: [],
    requireChildrenTerminal: false,
    reviewerAgentId: null,
    otherStages: [],
    reworkTo: [],
  };
}

/** API payload for the drafts; the last phase is the terminal one. */
export function phasesFromDrafts(drafts: PhaseDraft[]): LifecyclePhaseInput[] {
  return drafts.map((draft, index) => ({
    key: draft.key.trim(),
    name: draft.name.trim(),
    kind: index === drafts.length - 1 ? "terminal" : "work",
    ownerAgentId: draft.ownerAgentId,
    ownerUserId: draft.ownerAgentId ? null : draft.ownerUserId,
    instructions: draft.instructions.trim() || null,
    exitGate: {
      requiredDocuments: draft.requiredDocuments.split(",").map((key) => key.trim()).filter(Boolean),
      requiredWorkProductTypes: draft.requiredWorkProductTypes,
      requireChildrenTerminal: draft.requireChildrenTerminal,
      stages: [
        ...(draft.reviewerAgentId
          ? [{ type: "review" as const, participants: [{ type: "agent" as const, agentId: draft.reviewerAgentId }] }]
          : []),
        ...draft.otherStages,
      ],
    },
    reworkTo: draft.reworkTo.flatMap((draftId) => {
      const target = drafts.find((entry) => entry.draftId === draftId);
      return target ? [target.key.trim()] : [];
    }),
  }));
}

export function ProjectLifecycleEditor({ projectId, companyId }: { projectId: string; companyId: string }) {
  const queryClient = useQueryClient();
  const lifecycleQuery = useQuery({
    queryKey: queryKeys.projects.lifecycle(projectId),
    queryFn: () => projectLifecyclesApi.getProjectLifecycle(projectId),
  });
  const templatesQuery = useQuery({
    queryKey: queryKeys.lifecycleTemplates.list(companyId),
    queryFn: () => projectLifecyclesApi.listTemplates(companyId),
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const agents = useMemo(
    () => (agentsQuery.data ?? []).filter((agent) => agent.status !== "terminated"),
    [agentsQuery.data],
  );

  const lifecycle = lifecycleQuery.data ?? null;
  const [mode, setMode] = useState<LifecycleMode>("off");
  const [drafts, setDrafts] = useState<PhaseDraft[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [loadedVersion, setLoadedVersion] = useState<number | null | undefined>(undefined);

  // Reset the form whenever a different saved version arrives.
  useEffect(() => {
    if (lifecycleQuery.isLoading) return;
    const version = lifecycle?.version ?? null;
    if (version === loadedVersion) return;
    setLoadedVersion(version);
    setMode(lifecycle?.mode ?? "off");
    setDrafts(lifecycle ? draftsFromLifecycle(lifecycle.phases) : []);
  }, [lifecycle, lifecycleQuery.isLoading, loadedVersion]);

  const onSaved = (saved: ProjectLifecycle) => {
    queryClient.setQueryData(queryKeys.projects.lifecycle(projectId), saved);
    void queryClient.invalidateQueries({ queryKey: ["issue-phases"] });
  };
  const save = useMutation({
    mutationFn: () => projectLifecyclesApi.putProjectLifecycle(projectId, {
      mode,
      phases: phasesFromDrafts(drafts),
      ...(lifecycle ? { expectedVersion: lifecycle.version } : {}),
    }),
    onSuccess: onSaved,
  });
  const applyTemplate = useMutation({
    mutationFn: () => projectLifecyclesApi.putProjectLifecycle(projectId, {
      mode: mode === "off" ? "advisory" : mode,
      templateId,
      ...(lifecycle ? { expectedVersion: lifecycle.version } : {}),
    }),
    onSuccess: onSaved,
  });

  const update = (draftId: string, patch: Partial<PhaseDraft>) =>
    setDrafts((current) => current.map((draft) => {
      if (draft.draftId !== draftId) return draft;
      const next = { ...draft, ...patch };
      if (patch.name !== undefined && !draft.keyEdited) next.key = phaseKeyFromName(patch.name);
      return next;
    }));
  const move = (index: number, offset: -1 | 1) =>
    setDrafts((current) => {
      const next = [...current];
      const [entry] = next.splice(index, 1);
      next.splice(index + offset, 0, entry!);
      // Rework may only target earlier phases; drop targets that are now later.
      return next.map((draft, position) => ({
        ...draft,
        reworkTo: draft.reworkTo.filter((id) => next.findIndex((other) => other.draftId === id) < position),
      }));
    });
  const remove = (draftId: string) =>
    setDrafts((current) => current
      .filter((draft) => draft.draftId !== draftId)
      .map((draft) => ({ ...draft, reworkTo: draft.reworkTo.filter((id) => id !== draftId) })));

  if (lifecycleQuery.isLoading) return <p className="text-sm text-muted-foreground">Loading lifecycle…</p>;
  if (lifecycleQuery.error) {
    return <p className="text-sm text-destructive">Could not load the lifecycle: {(lifecycleQuery.error as Error).message}</p>;
  }

  const saveError = (save.error ?? applyTemplate.error) as Error | null;
  const templates = templatesQuery.data ?? [];

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Lifecycle</h2>
        <p className="text-sm text-muted-foreground">
          Ordered phases every top-level task in this project moves through. A task advances when it is marked done
          and its phase's exit gate is met; only the last phase closes it.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="space-y-1">
          <span className="block text-xs text-muted-foreground">Mode</span>
          <NativeSelect value={mode} onChange={(event) => setMode(event.target.value as LifecycleMode)} aria-label="Lifecycle mode">
            <option value="off">Off</option>
            <option value="advisory">Advisory (record unmet gates)</option>
            <option value="enforced">Enforced (block unmet gates)</option>
          </NativeSelect>
        </label>
        {templates.length > 0 ? (
          <div className="flex items-end gap-2">
            <label className="space-y-1">
              <span className="block text-xs text-muted-foreground">Start from template</span>
              <NativeSelect value={templateId} onChange={(event) => setTemplateId(event.target.value)} aria-label="Lifecycle template">
                <option value="">Choose a template</option>
                {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
              </NativeSelect>
            </label>
            <Button variant="outline" disabled={!templateId || applyTemplate.isPending} onClick={() => applyTemplate.mutate()}>
              Apply
            </Button>
          </div>
        ) : null}
      </div>

      {drafts.length === 0 ? (
        <div className="space-y-2 rounded-lg border border-dashed border-border p-4">
          <p className="text-sm text-muted-foreground">No phases yet.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setDrafts(SDLC_EXAMPLE.map(blankDraft))}>Use SDLC example</Button>
            <Button variant="outline" size="sm" onClick={() => setDrafts([blankDraft("Release")])}>Start empty</Button>
          </div>
        </div>
      ) : (
        <ol className="space-y-3" aria-label="Phases">
          {drafts.map((draft, index) => {
            const isLast = index === drafts.length - 1;
            const earlier = drafts.slice(0, index);
            return (
              <li key={draft.draftId} className="space-y-3 rounded-lg border border-border p-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-muted-foreground">{index + 1}</span>
                  <Input
                    value={draft.name}
                    onChange={(event) => update(draft.draftId, { name: event.target.value })}
                    aria-label={`Phase ${index + 1} name`}
                    className="flex-1"
                  />
                  {isLast ? <span className="text-xs text-muted-foreground">Final phase</span> : null}
                  <Button variant="ghost" size="icon" disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move ${draft.name} up`}>
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" disabled={isLast} onClick={() => move(index, 1)} aria-label={`Move ${draft.name} down`}>
                    <ArrowDown className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" disabled={drafts.length === 1} onClick={() => remove(draft.draftId)} aria-label={`Remove ${draft.name}`}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <label className="space-y-1">
                    <span className="block text-xs text-muted-foreground">Key</span>
                    <Input
                      value={draft.key}
                      onChange={(event) => update(draft.draftId, { key: event.target.value, keyEdited: true })}
                      className="font-mono"
                      aria-label={`Phase ${index + 1} key`}
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="block text-xs text-muted-foreground">Owner</span>
                    <NativeSelect
                      value={draft.ownerAgentId ?? (draft.ownerUserId ? `user:${draft.ownerUserId}` : "")}
                      onChange={(event) => {
                        const value = event.target.value;
                        update(draft.draftId, value.startsWith("user:")
                          ? { ownerAgentId: null }
                          : { ownerAgentId: value || null, ownerUserId: null });
                      }}
                      aria-label={`Phase ${index + 1} owner`}
                    >
                      <option value="">Keep current assignee</option>
                      {draft.ownerUserId ? <option value={`user:${draft.ownerUserId}`}>Current user owner</option> : null}
                      {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                    </NativeSelect>
                  </label>
                  <label className="space-y-1">
                    <span className="block text-xs text-muted-foreground">Reviewed by</span>
                    <NativeSelect
                      value={draft.reviewerAgentId ?? ""}
                      onChange={(event) => update(draft.draftId, { reviewerAgentId: event.target.value || null })}
                      aria-label={`Phase ${index + 1} reviewer`}
                    >
                      <option value="">No review</option>
                      {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                    </NativeSelect>
                  </label>
                  <label className="space-y-1">
                    <span className="block text-xs text-muted-foreground">Required documents (keys, comma separated)</span>
                    <Input
                      value={draft.requiredDocuments}
                      onChange={(event) => update(draft.draftId, { requiredDocuments: event.target.value })}
                      placeholder="requirements, design"
                      className="font-mono"
                      aria-label={`Phase ${index + 1} required documents`}
                    />
                  </label>
                </div>

                <div className="space-y-1">
                  <span className="block text-xs text-muted-foreground">Required work products</span>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {WORK_PRODUCT_TYPES.map(([type, label]) => (
                      <label key={type} className="flex items-center gap-1.5 text-sm">
                        <Checkbox
                          checked={draft.requiredWorkProductTypes.includes(type)}
                          onCheckedChange={(checked) => update(draft.draftId, {
                            requiredWorkProductTypes: checked
                              ? [...draft.requiredWorkProductTypes, type]
                              : draft.requiredWorkProductTypes.filter((entry) => entry !== type),
                          })}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>

                <label className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={draft.requireChildrenTerminal}
                    onCheckedChange={(checked) => update(draft.draftId, { requireChildrenTerminal: checked === true })}
                  />
                  Sub-tasks must be finished
                </label>

                {earlier.length > 0 ? (
                  <div className="space-y-1">
                    <span className="block text-xs text-muted-foreground">Can send work back to</span>
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {earlier.map((target) => (
                        <label key={target.draftId} className="flex items-center gap-1.5 text-sm">
                          <Checkbox
                            checked={draft.reworkTo.includes(target.draftId)}
                            onCheckedChange={(checked) => update(draft.draftId, {
                              reworkTo: checked
                                ? [...draft.reworkTo, target.draftId]
                                : draft.reworkTo.filter((id) => id !== target.draftId),
                            })}
                          />
                          {target.name || target.key}
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}

                <label className="block space-y-1">
                  <span className="block text-xs text-muted-foreground">Instructions for the phase owner</span>
                  <Textarea
                    value={draft.instructions}
                    onChange={(event) => update(draft.draftId, { instructions: event.target.value })}
                    aria-label={`Phase ${index + 1} instructions`}
                  />
                </label>
                {draft.otherStages.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {draft.otherStages.length} more review or approval stage{draft.otherStages.length === 1 ? "" : "s"} configured through the API are kept.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      {drafts.length > 0 ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDrafts((current) => [...current.slice(0, -1), blankDraft(`Phase ${current.length}`), current.at(-1)!])}
        >
          <Plus className="size-3.5" /> Add phase
        </Button>
      ) : null}

      {saveError ? <p className="text-sm text-destructive">{saveError.message}</p> : null}

      <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          disabled={save.isPending}
          onClick={() => {
            setMode(lifecycle?.mode ?? "off");
            setDrafts(lifecycle ? draftsFromLifecycle(lifecycle.phases) : []);
            save.reset();
            applyTemplate.reset();
          }}
        >
          Discard changes
        </Button>
        <Button disabled={drafts.length === 0 || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save lifecycle"}
        </Button>
      </div>
    </div>
  );
}
