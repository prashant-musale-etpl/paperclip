import { z } from "zod";

/**
 * Company roles let a review or approval stage name a job ("QA",
 * "Business Analyst") instead of a person. Users are assigned to roles; any
 * current holder may decide a stage that names the role.
 */

export const companyRoleKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Key must be lowercase letters, numbers, _ or -");

export const createCompanyRoleSchema = z.object({
  key: companyRoleKeySchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).nullable().optional(),
}).strict();
export type CreateCompanyRole = z.infer<typeof createCompanyRoleSchema>;

export const updateCompanyRoleSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2_000).nullable().optional(),
  archived: z.boolean().optional(),
}).strict();
export type UpdateCompanyRole = z.infer<typeof updateCompanyRoleSchema>;

export const assignCompanyRoleSchema = z.object({
  userId: z.string().trim().min(1).max(200),
}).strict();
export type AssignCompanyRole = z.infer<typeof assignCompanyRoleSchema>;

export interface CompanyRoleHolder {
  userId: string;
  name: string | null;
  email: string | null;
  assignedAt: string;
  assignedByUserId: string | null;
}

export interface CompanyRole {
  id: string;
  companyId: string;
  key: string;
  name: string;
  description: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  holders: CompanyRoleHolder[];
}

/** Starter roles for a delivery team; offered by the UI and CLI, never auto-created. */
export const SUGGESTED_COMPANY_ROLES: ReadonlyArray<CreateCompanyRole> = [
  { key: "ba", name: "Business Analyst", description: "Approves requirements and joins UAT sign-off." },
  { key: "architect", name: "Architect", description: "Approves designs and technical approach." },
  { key: "engineering-lead", name: "Engineering Lead", description: "Approves development and releases." },
  { key: "qa", name: "QA", description: "Approves test reports and joins UAT sign-off." },
  { key: "devops", name: "DevOps", description: "Approves deployments." },
];
