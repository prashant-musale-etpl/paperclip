import type {
  CreateLifecycleTemplateInput,
  IssuePhaseResponse,
  IssuePhaseTransition,
  IssuePhaseTransitionRequest,
  LifecycleTemplate,
  ProjectLifecycle,
  PutProjectLifecycleInput,
  UpdateLifecycleTemplate,
} from "@paperclipai/shared";
import { api } from "./client";

export type PhaseTransitionResult = {
  issueId: string;
  phaseKey: string | null;
  phaseVersion: number | null;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

export const projectLifecyclesApi = {
  listTemplates: (companyId: string) =>
    api.get<LifecycleTemplate[]>(`/companies/${companyId}/lifecycle-templates`),
  createTemplate: (companyId: string, data: CreateLifecycleTemplateInput) =>
    api.post<LifecycleTemplate>(`/companies/${companyId}/lifecycle-templates`, data),
  updateTemplate: (companyId: string, templateId: string, data: UpdateLifecycleTemplate) =>
    api.patch<LifecycleTemplate>(`/companies/${companyId}/lifecycle-templates/${templateId}`, data),
  /** Resolves to null when the project has no lifecycle (404). */
  getProjectLifecycle: (projectId: string) =>
    api.get<ProjectLifecycle>(`/projects/${projectId}/lifecycle`).catch(nullOnNotFound),
  putProjectLifecycle: (projectId: string, data: PutProjectLifecycleInput) =>
    api.put<ProjectLifecycle>(`/projects/${projectId}/lifecycle`, data),
  /** Resolves to null when the task has no phase (404). */
  getIssuePhase: (issueId: string) =>
    api.get<IssuePhaseResponse>(`/issues/${issueId}/phase`).catch(nullOnNotFound),
  listIssuePhaseTransitions: (issueId: string) =>
    api.get<IssuePhaseTransition[]>(`/issues/${issueId}/phase-transitions`),
  transitionIssuePhase: (issueId: string, data: IssuePhaseTransitionRequest) =>
    api.post<PhaseTransitionResult>(`/issues/${issueId}/phase-transitions`, data),
};

function nullOnNotFound(error: unknown): null {
  if (error && typeof error === "object" && (error as { status?: number }).status === 404) return null;
  throw error;
}
