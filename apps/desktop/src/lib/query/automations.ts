import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createIrisCoreAutomation,
  deleteIrisCoreAutomation,
  getIrisCoreAutomations,
  pauseIrisCoreAutomation,
  resumeIrisCoreAutomation,
  runIrisCoreAutomation,
  updateIrisCoreAutomation,
} from "../irisCore";
import type { HermesRuntimeConfig } from "../../types/hermes";
import { ensureOk } from "./ensureOk";
import { runtimeRouteQueryKey } from "./runtimeKey";
import { eventKeys } from "./events";

export const automationKeys = {
  all: (runtimeKey: string) => ["automations", runtimeKey] as const,
  list: (runtimeKey: string, agentId: string) => [...automationKeys.all(runtimeKey), "list", agentId] as const,
};

export function automationsQueryOptions(runtime: HermesRuntimeConfig, agentId: string, enabled = true) {
  const routeKey = runtimeRouteQueryKey(runtime);
  return queryOptions({
    queryKey: automationKeys.list(routeKey, agentId),
    queryFn: () => ensureOk(getIrisCoreAutomations(agentId, runtime), "Could not load automations."),
    enabled: Boolean(enabled && agentId),
    refetchInterval: enabled ? 6_000 : false,
  });
}

export function useAutomationsQuery(runtime: HermesRuntimeConfig, agentId: string, enabled = true) {
  return useQuery(automationsQueryOptions(runtime, agentId, enabled));
}

export function useCreateAutomationMutation(runtime: HermesRuntimeConfig, agentId: string) {
  const queryClient = useQueryClient();
  const routeKey = runtimeRouteQueryKey(runtime);
  return useMutation({
    mutationFn: (payload: Parameters<typeof createIrisCoreAutomation>[0]) =>
      ensureOk(createIrisCoreAutomation(payload, runtime), "Could not create automation."),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: automationKeys.list(routeKey, agentId) }),
  });
}

export function useUpdateAutomationMutation(runtime: HermesRuntimeConfig, agentId: string) {
  const queryClient = useQueryClient();
  const routeKey = runtimeRouteQueryKey(runtime);
  return useMutation({
    mutationFn: ({ automationId, payload }: {
      automationId: string;
      payload: Parameters<typeof updateIrisCoreAutomation>[1];
    }) => ensureOk(updateIrisCoreAutomation(automationId, payload, runtime), "Could not update automation."),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: automationKeys.list(routeKey, agentId) }),
  });
}

export function useAutomationActionMutation(runtime: HermesRuntimeConfig, agentId: string) {
  const queryClient = useQueryClient();
  const routeKey = runtimeRouteQueryKey(runtime);
  return useMutation({
    mutationFn: async ({ automationId, action }: { automationId: string; action: "pause" | "resume" | "run" | "delete" }) => {
      if (action === "pause") {
        return ensureOk(pauseIrisCoreAutomation(automationId, runtime), "Could not pause automation.");
      }
      if (action === "resume") {
        return ensureOk(resumeIrisCoreAutomation(automationId, runtime), "Could not resume automation.");
      }
      if (action === "run") {
        return ensureOk(runIrisCoreAutomation(automationId, runtime), "Could not run automation.");
      }
      return ensureOk(deleteIrisCoreAutomation(automationId, runtime), "Could not delete automation.");
    },
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: automationKeys.list(routeKey, agentId) });
      if (variables.action === "run") {
        queryClient.invalidateQueries({ queryKey: eventKeys.automationDeliveries(routeKey, agentId) });
      }
    },
  });
}
