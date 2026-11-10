import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PhaseStepperPhase {
  key: string;
  name: string;
  kind?: "work" | "terminal";
}

export interface PhaseStepperProps {
  phases: PhaseStepperPhase[];
  /** Key of the phase the task is in; earlier phases render as completed. */
  currentKey: string | null;
  /** Marks the current phase as finished (the task is done in its final phase). */
  completed?: boolean;
  className?: string;
}

/**
 * Vertical list of a project lifecycle's phases with the task's position:
 * completed phases are checked, the current phase is emphasized, later
 * phases are muted.
 */
export function PhaseStepper({ phases, currentKey, completed = false, className }: PhaseStepperProps) {
  const currentIndex = phases.findIndex((phase) => phase.key === currentKey);
  return (
    <ol className={cn("space-y-1", className)} aria-label="Lifecycle phases">
      {phases.map((phase, index) => {
        const state = index < currentIndex || (completed && index === currentIndex)
          ? "done"
          : index === currentIndex
            ? "current"
            : "upcoming";
        return (
          <li
            key={phase.key}
            className="flex items-center gap-2"
            aria-current={state === "current" ? "step" : undefined}
            data-state={state}
          >
            <span
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded-full border",
                state === "done" && "border-(--status-task-icon-done) text-(--status-task-icon-done)",
                state === "current" && "border-(--status-task-icon-in_progress) bg-(--status-task-icon-in_progress)",
                state === "upcoming" && "border-border",
              )}
            >
              {state === "done" ? <Check className="size-3" aria-hidden /> : null}
            </span>
            <span
              className={cn(
                "min-w-0 truncate text-sm",
                state === "current" ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {phase.name}
            </span>
            {state === "current" && !completed ? <span className="sr-only">(current phase)</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
