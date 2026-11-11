import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IssuePhaseResponse, IssuePhaseTransitionRequest, LifecyclePhaseGateGap } from "@paperclipai/shared";
import { projectLifecyclesApi } from "@/api/projectLifecycles";
import { useProjectLifecyclesEnabled } from "@/hooks/useProjectLifecyclesEnabled";
import { queryKeys } from "@/lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PhaseStepper } from "@/components/PhaseStepper";

export function describePhaseGateGap(gap: LifecyclePhaseGateGap): string {
  if (gap.kind === "document") return `Document "${gap.key}"`;
  if (gap.kind === "work_product") return `Active ${gap.type.replaceAll("_", " ")}`;
  return `${gap.count} open sub-task${gap.count === 1 ? "" : "s"} to finish`;
}

const TRANSITION_LABEL: Record<string, string> = {
  initial: "Started in",
  advance: "Advanced to",
  complete: "Completed",
  rework: "Sent back to",
  override: "Moved to",
};

/**
 * Task right-rail section for project lifecycles: the phase stepper, what the
 * current phase still needs before done, history, and board phase moves.
 * Self-gates on the experimental flag and renders nothing for unphased tasks.
 */
export function IssuePhasePanel({ issueId, issueStatus }: { issueId: string; issueStatus: string }) {
  const { enabled } = useProjectLifecyclesEnabled();
  const [moveOpen, setMoveOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const phaseQuery = useQuery({
    queryKey: queryKeys.issuePhases.detail(issueId),
    queryFn: () => projectLifecyclesApi.getIssuePhase(issueId),
    enabled: enabled && !!issueId,
  });
  const historyQuery = useQuery({
    queryKey: queryKeys.issuePhases.transitions(issueId),
    queryFn: () => projectLifecyclesApi.listIssuePhaseTransitions(issueId),
    enabled: enabled && historyOpen,
  });

  const phase = phaseQuery.data;
  if (!enabled) return null;
  if (phaseQuery.error) {
    return (
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lifecycle</h3>
        <p className="text-xs text-destructive">Could not load the task's phase: {(phaseQuery.error as Error).message}</p>
      </section>
    );
  }
  if (!phase) return null;
  const phaseName = (key: string | null) => phase.phases.find((entry) => entry.key === key)?.name ?? key ?? "—";
  const closed = issueStatus === "done";

  return (
    <section className="space-y-3" aria-label="Lifecycle phase">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Lifecycle</h3>
        <Badge variant="secondary">{phase.mode === "enforced" ? "Enforced" : "Advisory"}</Badge>
      </div>
      <PhaseStepper phases={phase.phases} currentKey={phase.phase.key} completed={closed} />

      {!closed ? (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {phase.nextPhase ? `Before moving to ${phase.nextPhase.name}` : "Before closing"}
            {phase.reviewStageCount > 0 ? ` (after ${phase.reviewStageCount} review stage${phase.reviewStageCount === 1 ? "" : "s"})` : ""}
          </p>
          {phase.unmetGate.length === 0 ? (
            <p className="text-sm text-(--status-task-icon-done)">Exit gate met</p>
          ) : (
            <ul className="space-y-0.5" aria-label="Unmet exit gate items">
              {phase.unmetGate.map((gap) => (
                <li key={`${gap.kind}:${"key" in gap ? gap.key : "type" in gap ? gap.type : gap.count}`} className="text-sm text-(--status-task-icon-blocked)">
                  {describePhaseGateGap(gap)}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {phase.phase.instructions ? (
        <p className="whitespace-pre-wrap text-xs text-muted-foreground">{phase.phase.instructions}</p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setMoveOpen(true)}>Move phase</Button>
        <Button variant="ghost" size="sm" onClick={() => setHistoryOpen((open) => !open)} aria-expanded={historyOpen}>
          {historyOpen ? "Hide history" : "History"}
        </Button>
      </div>

      {historyOpen ? (
        historyQuery.error ? (
          <p className="text-xs text-destructive">Could not load phase history: {(historyQuery.error as Error).message}</p>
        ) : (
          <ol className="space-y-1" aria-label="Phase history">
            {(historyQuery.data ?? []).map((row) => (
              <li key={row.id} className="text-xs text-muted-foreground">
                <span className="text-foreground">{TRANSITION_LABEL[row.kind] ?? row.kind} {phaseName(row.toPhaseKey)}</span>
                {" · "}{new Date(row.createdAt).toLocaleString()}
                {row.reason ? <span className="block">{row.reason}</span> : null}
                {row.gateGaps.length > 0 ? <span className="block">Unmet: {row.gateGaps.map(describePhaseGateGap).join(", ")}</span> : null}
              </li>
            ))}
          </ol>
        )
      ) : null}

      <MovePhaseDialog open={moveOpen} onOpenChange={setMoveOpen} issueId={issueId} phase={phase} />
    </section>
  );
}

function MovePhaseDialog({
  open,
  onOpenChange,
  issueId,
  phase,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  issueId: string;
  phase: IssuePhaseResponse;
}) {
  const queryClient = useQueryClient();
  const reworkTargets = phase.phases.filter((entry) => phase.reworkTo.includes(entry.key));
  const [kind, setKind] = useState<IssuePhaseTransitionRequest["kind"]>(reworkTargets.length > 0 ? "rework" : "override");
  const targets = kind === "rework" ? reworkTargets : phase.phases.filter((entry) => entry.key !== phase.phase.key);
  const [toPhaseKey, setToPhaseKey] = useState("");
  const [reason, setReason] = useState("");
  const selectedTarget = targets.some((entry) => entry.key === toPhaseKey) ? toPhaseKey : targets[0]?.key ?? "";

  const move = useMutation({
    mutationFn: () => projectLifecyclesApi.transitionIssuePhase(issueId, {
      kind,
      toPhaseKey: selectedTarget,
      reason: reason.trim(),
      expectedPhaseVersion: phase.phaseVersion,
    }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.issuePhases.detail(issueId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issuePhases.transitions(issueId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) }),
      ]);
      setReason("");
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move phase</DialogTitle>
          <DialogDescription>
            Tasks move forward by being marked done, so each phase's exit gate runs. Use this to send work back or,
            as the board, to override the phase.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Kind</span>
            <NativeSelect value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
              {reworkTargets.length > 0 ? <option value="rework">Send back for rework</option> : null}
              <option value="override">Override (board)</option>
            </NativeSelect>
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Phase</span>
            <NativeSelect value={selectedTarget} onChange={(event) => setToPhaseKey(event.target.value)}>
              {targets.map((entry) => <option key={entry.key} value={entry.key}>{entry.name}</option>)}
            </NativeSelect>
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Reason</span>
            <Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why is the phase changing?" />
          </label>
          {move.error ? <p className="text-sm text-destructive">{(move.error as Error).message}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => move.mutate()} disabled={!selectedTarget || !reason.trim() || move.isPending}>
            {move.isPending ? "Moving…" : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
