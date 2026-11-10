import { useQuery } from "@tanstack/react-query";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";

export function useProjectLifecyclesEnabled() {
  const query = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  return {
    enabled: query.data?.enableProjectLifecycles === true,
    loaded: query.isFetched,
  };
}
