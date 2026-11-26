import type {
  AssignCompanyRole,
  CompanyRole,
  CreateCompanyRole,
  UpdateCompanyRole,
} from "@paperclipai/shared";
import { api } from "./client";

const rolesPath = (companyId: string, suffix = "") =>
  `/companies/${encodeURIComponent(companyId)}/roles${suffix}`;

export const companyRolesApi = {
  list: (companyId: string, options: { includeArchived?: boolean } = {}) =>
    api.get<CompanyRole[]>(rolesPath(companyId, options.includeArchived ? "?includeArchived=true" : "")),
  get: (companyId: string, roleId: string) =>
    api.get<CompanyRole>(rolesPath(companyId, `/${encodeURIComponent(roleId)}`)),
  create: (companyId: string, data: CreateCompanyRole) =>
    api.post<CompanyRole>(rolesPath(companyId), data),
  update: (companyId: string, roleId: string, data: UpdateCompanyRole) =>
    api.patch<CompanyRole>(rolesPath(companyId, `/${encodeURIComponent(roleId)}`), data),
  assignHolder: (companyId: string, roleId: string, data: AssignCompanyRole) =>
    api.post<CompanyRole>(rolesPath(companyId, `/${encodeURIComponent(roleId)}/holders`), data),
  removeHolder: (companyId: string, roleId: string, userId: string) =>
    api.delete<CompanyRole>(
      rolesPath(companyId, `/${encodeURIComponent(roleId)}/holders/${encodeURIComponent(userId)}`),
    ),
};
