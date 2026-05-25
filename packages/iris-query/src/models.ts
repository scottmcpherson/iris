import { queryOptions, useQuery } from "@tanstack/react-query";
import {
  getAgentModelCatalog,
  type IrisCoreClient,
} from "@iris/core-client";
import { ensureOk } from "./ensureOk";

export const modelKeys = {
  all: (clientKey: string) => ["models", clientKey] as const,
  catalog: (clientKey: string, agentId: string) => [...modelKeys.all(clientKey), "catalog", agentId] as const,
};

export function modelCatalogQueryOptions(
  client: IrisCoreClient | null,
  clientKey: string,
  agentId: string,
) {
  return queryOptions({
    queryKey: modelKeys.catalog(clientKey, agentId),
    queryFn: () => {
      if (!client) throw new Error("Iris Core is not connected.");
      return ensureOk(getAgentModelCatalog(client, agentId), "Could not load model catalog.");
    },
    enabled: Boolean(client && agentId),
  });
}

export function useModelCatalogQuery(
  client: IrisCoreClient | null,
  clientKey: string,
  agentId: string,
) {
  return useQuery(modelCatalogQueryOptions(client, clientKey, agentId));
}
