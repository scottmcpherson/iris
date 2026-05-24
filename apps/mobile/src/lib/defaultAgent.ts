import { getAgentForProfile, type IrisCoreClient } from "@iris/core-client";

export async function resolveDefaultAgentId(client: IrisCoreClient, profile = "default") {
  const result = await getAgentForProfile(client, profile);
  if (!result.ok || !result.agent) {
    throw new Error(("error" in result && result.error) || "Could not resolve the default Iris agent.");
  }
  return result.agent.id;
}
