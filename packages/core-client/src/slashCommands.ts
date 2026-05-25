import { coreRequest } from "./transport";
import type {
  IrisCoreClient,
  IrisCoreSlashCommandsResult,
  IrisCoreSlashCompletionResult,
} from "./types";

export function getAgentSlashCommands(client: IrisCoreClient, agentId: string) {
  return coreRequest<IrisCoreSlashCommandsResult>(
    client,
    "GET",
    `/agents/${encodeURIComponent(agentId)}/slash-commands`,
  );
}

export function completeAgentSlashCommand(client: IrisCoreClient, agentId: string, text: string, limit = 30) {
  return coreRequest<IrisCoreSlashCompletionResult>(
    client,
    "POST",
    `/agents/${encodeURIComponent(agentId)}/slash-complete`,
    { text, limit },
  );
}
