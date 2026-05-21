import { queryOptions, useQuery } from "@tanstack/react-query";
import { getIrisSlashCommands } from "../irisRuntime";
import type { HermesRuntimeConfig } from "../../types/hermes";
import { ensureOk } from "./ensureOk";
import { runtimeRouteQueryKey } from "./runtimeKey";

export const slashCommandKeys = {
  all: (runtimeKey: string) => ["slashCommands", runtimeKey] as const,
  catalog: (runtimeKey: string, profile: string) =>
    [...slashCommandKeys.all(runtimeKey), "catalog", profile || "default"] as const,
};

export function slashCommandsQueryOptions(runtime: HermesRuntimeConfig, profile = "default", enabled = true) {
  const routeKey = runtimeRouteQueryKey(runtime);
  return queryOptions({
    queryKey: slashCommandKeys.catalog(routeKey, profile),
    queryFn: () => ensureOk(getIrisSlashCommands(profile, runtime), "Could not load slash commands."),
    enabled: Boolean(enabled && profile),
  });
}

export function useSlashCommandsQuery(runtime: HermesRuntimeConfig, profile = "default", enabled = true) {
  return useQuery(slashCommandsQueryOptions(runtime, profile, enabled));
}
