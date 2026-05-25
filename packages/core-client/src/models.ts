import { coreRequest } from "./transport";
import type { IrisCoreClient, IrisCoreModelCatalog } from "./types";

export function getAgentModelCatalog(client: IrisCoreClient, agentId: string) {
  return coreRequest<IrisCoreModelCatalog>(client, "GET", `/agents/${encodeURIComponent(agentId)}/models`);
}
