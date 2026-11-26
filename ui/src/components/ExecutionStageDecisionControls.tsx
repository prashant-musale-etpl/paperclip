import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CompanyRole, Issue } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import {
  formatRoleParticipantLabel,
  isSeparationOfDutiesError,
  stageDecisionEligibility,
  stageDecisionErrorMessage,
  type CompanyRoleMap,
} from "../lib/company-roles";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type Decision = "approve" | "request_changes";

interface ExecutionStageDecisionControlsProps {
  issue: Issue;
  currentUserId: string | null | undefined;
  roles: readonly CompanyRole[];
  roleMap: CompanyRoleMap;
}

/**
 * Approve / request-changes controls for the active review or approval stage.
 * Shown to the assigned participant and to any holder of a role the stage
 * names (except the person whose work is under review). The decision is a
 * status change with a required comment, exactly as the API expects.
 */
export function ExecutionStageDecisionControls({ issue, currentUserId, roles, roleMap }: ExecutionStageDecisionControlsProps) {
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [separationOfDuties, setSeparationOfDuties] = useState(false);

  const eligibility = stageDecisionEligibility({
    executionPolicy: issue.executionPolicy,
    executionState: issue.executionState,
    currentUserId,
    roles,
  });

  const decide = useMutation({
    mutationFn: (decision: Decision) => issuesApi.update(issue.id, {
      status: decision === "approve" ? "done" : "in_progress",
      comment: comment.trim(),
    }),
    onMutate: () => {
      setErrorMessage(null);
      setSeparationOfDuties(false);
    },
    onSuccess: () => {
      setComment("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issue.id) });
    },
    onError: (error) => {
      setSeparationOfDuties(isSeparationOfDutiesError(error));
      setErrorMessage(stageDecisionErrorMessage(error));
    },
  });

  if (!eligibility.canDecide) return null;

  const stageLabel = issue.executionState?.currentStageType === "approval" ? "approval" : "review";
  const viaLabel = eligibility.via === "role"
    ? eligibility.roleIds.map((roleId) => formatRoleParticipantLabel(roleId, roleMap)).join(", ")
    : null;
  const hasComment = comment.trim().length > 0;

  return (
    <div className="w-full space-y-2" data-slot="execution-stage-decision">
      <p className="text-xs text-muted-foreground">
        {viaLabel
          ? `You can decide this ${stageLabel} as a holder of ${viaLabel}.`
          : `This ${stageLabel} is waiting on you.`}
      </p>
      <Textarea
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        placeholder="Decision comment (required)"
        aria-label={`Comment for the ${stageLabel} decision`}
        className="min-h-16 text-sm"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={!hasComment || decide.isPending}
          onClick={() => decide.mutate("approve")}
        >
          {decide.isPending && decide.variables === "approve" ? "Approving…" : "Approve"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!hasComment || decide.isPending}
          onClick={() => decide.mutate("request_changes")}
        >
          {decide.isPending && decide.variables === "request_changes" ? "Sending…" : "Request changes"}
        </Button>
      </div>
      {errorMessage ? (
        <p
          role="alert"
          data-error-code={separationOfDuties ? "separation_of_duties" : undefined}
          className="text-xs text-destructive"
        >
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
