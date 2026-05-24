import { coreRequest } from "./transport";
import type { IrisCoreAgent, IrisCoreAgentListResponse, IrisCoreClient } from "./types";

export function getAgents(client: IrisCoreClient) {
  return coreRequest<IrisCoreAgentListResponse>(client, "GET", "/agents");
}

export async function getAgentForProfile(client: IrisCoreClient, profile = "default") {
  const result = await getAgents(client);
  if (!result.ok) return { ...result, agent: null as IrisCoreAgent | null };
  const targetProfile = profile || "default";
  const exact = result.agents.find((agent) => agent.runtimeProfile === targetProfile) || null;
  return {
    ok: true,
    agent:
      exact ||
      (targetProfile === "default"
        ? result.agents.find((agent) => agent.isDefault) || result.agents[0] || null
        : null),
  };
}
