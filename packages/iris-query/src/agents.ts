import { queryOptions, useQuery } from "@tanstack/react-query";
import {
  getAgentForProfile,
  getAgents,
  type IrisCoreClient,
} from "@iris/core-client";
import { ensureOk } from "./ensureOk";

export const agentKeys = {
  all: (clientKey: string) => ["agents", clientKey] as const,
  list: (clientKey: string) => [...agentKeys.all(clientKey), "list"] as const,
  byProfile: (clientKey: string, profile: string) => [...agentKeys.all(clientKey), "profile", profile || "default"] as const,
};

export function agentsQueryOptions(client: IrisCoreClient | null, clientKey: string) {
  return queryOptions({
    queryKey: agentKeys.list(clientKey),
    queryFn: () => {
      if (!client) throw new Error("Iris Core is not connected.");
      return ensureOk(getAgents(client), "Could not load agents.");
    },
    enabled: Boolean(client),
  });
}

export function agentForProfileQueryOptions(
  client: IrisCoreClient | null,
  clientKey: string,
  profile = "default",
) {
  return queryOptions({
    queryKey: agentKeys.byProfile(clientKey, profile),
    queryFn: () => {
      if (!client) throw new Error("Iris Core is not connected.");
      return ensureOk(getAgentForProfile(client, profile), "Could not resolve Iris agent.");
    },
    enabled: Boolean(client && profile),
  });
}

export function useAgentsQuery(client: IrisCoreClient | null, clientKey: string) {
  return useQuery(agentsQueryOptions(client, clientKey));
}

export function useAgentForProfileQuery(
  client: IrisCoreClient | null,
  clientKey: string,
  profile = "default",
) {
  return useQuery(agentForProfileQueryOptions(client, clientKey, profile));
}
