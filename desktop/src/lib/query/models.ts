import { queryOptions, useQuery } from "@tanstack/react-query";
import { getIrisModelCatalog } from "../irisRuntime";
import type { HermesRuntimeConfig } from "../../types/hermes";
import { ensureOk } from "./ensureOk";
import { runtimeRouteQueryKey } from "./runtimeKey";

export const modelKeys = {
  all: (runtimeKey: string) => ["models", runtimeKey] as const,
  catalog: (runtimeKey: string, profile: string) => [...modelKeys.all(runtimeKey), "catalog", profile || "default"] as const,
};

export function modelCatalogQueryOptions(runtime: HermesRuntimeConfig, profile = "default", enabled = true) {
  const routeKey = runtimeRouteQueryKey(runtime);
  return queryOptions({
    queryKey: modelKeys.catalog(routeKey, profile),
    queryFn: () => ensureOk(getIrisModelCatalog(profile, runtime), "Could not load model catalog."),
    enabled: Boolean(enabled && profile),
  });
}

export function useModelCatalogQuery(runtime: HermesRuntimeConfig, profile = "default", enabled = true) {
  return useQuery(modelCatalogQueryOptions(runtime, profile, enabled));
}
