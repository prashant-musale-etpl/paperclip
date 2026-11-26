import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { companyRolesApi } from "../api/companyRoles";
import { buildCompanyRoleMap, selectableCompanyRoles } from "../lib/company-roles";
import { queryKeys } from "../lib/queryKeys";

/**
 * Company roles including archived ones, so policies that still name an
 * archived role can label it. Pickers should offer `selectableRoles` only.
 */
export function useCompanyRoles(companyId: string | null | undefined, options: { enabled?: boolean } = {}) {
  const enabled = Boolean(companyId) && options.enabled !== false;
  const query = useQuery({
    queryKey: queryKeys.companyRoles.list(companyId ?? "__none__", { includeArchived: true }),
    queryFn: () => companyRolesApi.list(companyId!, { includeArchived: true }),
    enabled,
    staleTime: 30_000,
  });
  const roles = query.data;
  const roleMap = useMemo(() => buildCompanyRoleMap(roles), [roles]);
  const selectableRoles = useMemo(() => selectableCompanyRoles(roles), [roles]);
  return { ...query, roles: roles ?? [], roleMap, selectableRoles };
}
