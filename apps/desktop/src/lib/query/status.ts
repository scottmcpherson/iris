import { queryOptions, useQuery } from "@tanstack/react-query";
import { getIrisStatus } from "../irisRuntime";
import type { HermesRuntimeConfig } from "../../types/hermes";
import { ensureOk } from "./ensureOk";
import { runtimeRouteQueryKey } from "./runtimeKey";

export const statusKeys = {
  all: (runtimeKey: string) => ["status", runtimeKey] as const,
  detail: (runtimeKey: string, profile: string) => [...statusKeys.all(runtimeKey), profile || "default"] as const,
};

export function statusQueryOptions(runtime: HermesRuntimeConfig, profile = "default") {
  const routeKey = runtimeRouteQueryKey(runtime);
  return queryOptions({
    queryKey: statusKeys.detail(routeKey, profile),
    queryFn: () => ensureOk(getIrisStatus(runtime, profile), "Could not load Iris status."),
  });
}

export function useStatusQuery(runtime: HermesRuntimeConfig, profile = "default") {
  return useQuery({
    ...statusQueryOptions(runtime, profile),
    refetchInterval: () =>
      typeof document !== "undefined" && document.visibilityState === "hidden" ? false : 5_000,
  });
}
