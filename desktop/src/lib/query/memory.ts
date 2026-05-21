import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getIrisMemory, resetIrisMemoryFile, saveIrisMemoryFile } from "../irisRuntime";
import type { HermesMemoryResetExpectations, HermesRuntimeConfig } from "../../types/hermes";
import { ensureOk } from "./ensureOk";
import { runtimeRouteQueryKey } from "./runtimeKey";
import { agentKeys } from "./agents";
import { statusKeys } from "./status";

export const memoryKeys = {
  all: (runtimeKey: string) => ["memory", runtimeKey] as const,
  agent: (runtimeKey: string, profile: string) => [...memoryKeys.all(runtimeKey), profile || "default"] as const,
};

export function memoryQueryOptions(runtime: HermesRuntimeConfig, profile = "default") {
  const routeKey = runtimeRouteQueryKey(runtime);
  return queryOptions({
    queryKey: memoryKeys.agent(routeKey, profile),
    queryFn: () => ensureOk(getIrisMemory(profile, runtime), "Could not load memory."),
  });
}

export function useMemoryQuery(runtime: HermesRuntimeConfig, profile = "default", enabled = true) {
  return useQuery({ ...memoryQueryOptions(runtime, profile), enabled });
}

export function useSaveMemoryMutation(runtime: HermesRuntimeConfig) {
  const queryClient = useQueryClient();
  const routeKey = runtimeRouteQueryKey(runtime);
  return useMutation({
    mutationFn: (payload: {
      profile?: string;
      file: "memory" | "user";
      content: string;
      expectedUpdatedAt?: number | null;
      expectedContentHash?: string | null;
    }) => ensureOk(saveIrisMemoryFile({ ...payload, runtime }), "Could not save memory."),
    onSuccess: (result, payload) => {
      queryClient.setQueryData(memoryKeys.agent(routeKey, payload.profile || "default"), result.memory);
      queryClient.invalidateQueries({ queryKey: memoryKeys.agent(routeKey, payload.profile || "default") });
      queryClient.invalidateQueries({ queryKey: agentKeys.all(routeKey) });
      queryClient.invalidateQueries({ queryKey: statusKeys.all(routeKey) });
    },
  });
}

export function useResetMemoryMutation(runtime: HermesRuntimeConfig) {
  const queryClient = useQueryClient();
  const routeKey = runtimeRouteQueryKey(runtime);
  return useMutation({
    mutationFn: (payload: { profile?: string; file: "memory" | "user" | "all"; confirm: string } & HermesMemoryResetExpectations) =>
      ensureOk(resetIrisMemoryFile({ ...payload, runtime }), "Could not reset memory."),
    onSuccess: (result, payload) => {
      queryClient.setQueryData(memoryKeys.agent(routeKey, payload.profile || "default"), result.memory);
      queryClient.invalidateQueries({ queryKey: memoryKeys.agent(routeKey, payload.profile || "default") });
      queryClient.invalidateQueries({ queryKey: agentKeys.all(routeKey) });
      queryClient.invalidateQueries({ queryKey: statusKeys.all(routeKey) });
    },
  });
}
