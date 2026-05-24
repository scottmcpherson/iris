import { queryOptions, useQuery } from "@tanstack/react-query";
import { getIrisCoreAutomationEvents, getIrisCoreEvents } from "../irisCore";
import type { HermesRuntimeConfig } from "../../types/hermes";
import { ensureOk } from "./ensureOk";
import { runtimeRouteQueryKey } from "./runtimeKey";

export const eventKeys = {
  all: (runtimeKey: string) => ["events", runtimeKey] as const,
  recent: (runtimeKey: string, agentId: string) => [...eventKeys.all(runtimeKey), "recent", agentId] as const,
  automationDeliveries: (runtimeKey: string, agentId: string) =>
    [...eventKeys.all(runtimeKey), "automationDeliveries", agentId] as const,
};

export function recentEventsQueryOptions(runtime: HermesRuntimeConfig, agentId: string, after = 0, limit = 50) {
  const routeKey = runtimeRouteQueryKey(runtime);
  return queryOptions({
    queryKey: eventKeys.recent(routeKey, agentId),
    queryFn: () => ensureOk(getIrisCoreEvents(after, limit, runtime, agentId), "Could not load events."),
    enabled: Boolean(agentId),
  });
}

export function automationDeliveriesQueryOptions(runtime: HermesRuntimeConfig, agentId: string, limit = 50) {
  const routeKey = runtimeRouteQueryKey(runtime);
  return queryOptions({
    queryKey: eventKeys.automationDeliveries(routeKey, agentId),
    queryFn: () => ensureOk(getIrisCoreAutomationEvents(limit, runtime, agentId), "Could not load automation deliveries."),
    enabled: Boolean(agentId),
  });
}

export function useRecentEventsQuery(runtime: HermesRuntimeConfig, agentId: string, after = 0, limit = 50) {
  return useQuery(recentEventsQueryOptions(runtime, agentId, after, limit));
}

export function useAutomationDeliveriesQuery(runtime: HermesRuntimeConfig, agentId: string, limit = 50) {
  return useQuery(automationDeliveriesQueryOptions(runtime, agentId, limit));
}
