import { useQuery } from "@tanstack/react-query";
import {
  memoryQueryOptions,
  skillsQueryOptions,
  statusQueryOptions,
} from "../../lib/query";
import type { HermesRuntimeConfig } from "../../types/hermes";

type RuntimeQueryOptions = {
  statusEnabled?: boolean;
  profileDataEnabled?: boolean;
};

export function useIrisRuntimeQueries(
  runtimeConfig: HermesRuntimeConfig,
  selectedProfile: string,
  options: RuntimeQueryOptions = {},
) {
  const statusQuery = useQuery({
    ...statusQueryOptions(runtimeConfig, selectedProfile),
    enabled: options.statusEnabled ?? true,
    refetchInterval: () => document.visibilityState === "hidden" ? false : 5_000,
  });
  const profileDataEnabled = Boolean(
    options.profileDataEnabled ?? (selectedProfile && statusQuery.data?.connected),
  );
  const memoryQuery = useQuery({
    ...memoryQueryOptions(runtimeConfig, selectedProfile),
    enabled: profileDataEnabled,
  });
  const skillsQuery = useQuery({
    ...skillsQueryOptions(runtimeConfig, selectedProfile),
    enabled: profileDataEnabled,
  });

  return { statusQuery, memoryQuery, skillsQuery };
}
