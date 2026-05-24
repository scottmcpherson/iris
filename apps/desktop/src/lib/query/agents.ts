import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cloneIrisAgent,
  createIrisAgent,
  deleteIrisAgent,
  renameIrisAgent,
  switchIrisAgent,
} from "../irisRuntime";
import { getIrisCoreAgentForProfile, getIrisCoreAgents } from "../irisCore";
import type { HermesRuntimeConfig } from "../../types/hermes";
import { ensureOk } from "./ensureOk";
import { runtimeRouteQueryKey } from "./runtimeKey";
import { statusKeys } from "./status";

export const agentKeys = {
  all: (runtimeKey: string) => ["agents", runtimeKey] as const,
  lists: (runtimeKey: string) => [...agentKeys.all(runtimeKey), "list"] as const,
  list: (runtimeKey: string) => [...agentKeys.lists(runtimeKey)] as const,
  detail: (runtimeKey: string, agentId: string) => [...agentKeys.all(runtimeKey), "detail", agentId] as const,
  byProfile: (runtimeKey: string, profile: string) => [...agentKeys.all(runtimeKey), "profile", profile || "default"] as const,
};

export function agentsQueryOptions(runtime: HermesRuntimeConfig) {
  const routeKey = runtimeRouteQueryKey(runtime);
  return queryOptions({
    queryKey: agentKeys.list(routeKey),
    queryFn: () => ensureOk(getIrisCoreAgents(runtime), "Could not load agents."),
  });
}

export function agentForProfileQueryOptions(runtime: HermesRuntimeConfig, profile = "default") {
  const routeKey = runtimeRouteQueryKey(runtime);
  return queryOptions({
    queryKey: agentKeys.byProfile(routeKey, profile),
    queryFn: () => ensureOk(getIrisCoreAgentForProfile(profile, runtime), "Could not resolve Iris agent."),
  });
}

export function useAgentsQuery(runtime: HermesRuntimeConfig) {
  return useQuery(agentsQueryOptions(runtime));
}

export function useAgentForProfileQuery(runtime: HermesRuntimeConfig, profile = "default") {
  return useQuery(agentForProfileQueryOptions(runtime, profile));
}

export function useCreateAgentMutation(runtime: HermesRuntimeConfig) {
  const queryClient = useQueryClient();
  const routeKey = runtimeRouteQueryKey(runtime);
  return useMutation({
    mutationFn: (name: string) => ensureOk(createIrisAgent(name, runtime), "Could not create agent."),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentKeys.all(routeKey) });
      queryClient.invalidateQueries({ queryKey: statusKeys.all(routeKey) });
    },
  });
}

export function useCloneAgentMutation(runtime: HermesRuntimeConfig) {
  const queryClient = useQueryClient();
  const routeKey = runtimeRouteQueryKey(runtime);
  return useMutation({
    mutationFn: ({ source, name }: { source: string; name: string }) =>
      ensureOk(cloneIrisAgent(source, name, runtime), "Could not clone agent."),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentKeys.all(routeKey) });
      queryClient.invalidateQueries({ queryKey: statusKeys.all(routeKey) });
    },
  });
}

export function useRenameAgentMutation(runtime: HermesRuntimeConfig) {
  const queryClient = useQueryClient();
  const routeKey = runtimeRouteQueryKey(runtime);
  return useMutation({
    mutationFn: ({ source, name }: { source: string; name: string }) =>
      ensureOk(renameIrisAgent(source, name, runtime), "Could not rename agent."),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentKeys.all(routeKey) });
      queryClient.invalidateQueries({ queryKey: statusKeys.all(routeKey) });
    },
  });
}

export function useSwitchAgentMutation(runtime: HermesRuntimeConfig) {
  const queryClient = useQueryClient();
  const routeKey = runtimeRouteQueryKey(runtime);
  return useMutation({
    mutationFn: (name: string) => ensureOk(switchIrisAgent(name, runtime), "Could not switch agent."),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentKeys.all(routeKey) });
      queryClient.invalidateQueries({ queryKey: statusKeys.all(routeKey) });
    },
  });
}

export function useDeleteAgentMutation(runtime: HermesRuntimeConfig) {
  const queryClient = useQueryClient();
  const routeKey = runtimeRouteQueryKey(runtime);
  return useMutation({
    mutationFn: (name: string) => ensureOk(deleteIrisAgent(name, runtime), "Could not delete agent."),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentKeys.all(routeKey) });
      queryClient.invalidateQueries({ queryKey: statusKeys.all(routeKey) });
    },
  });
}
