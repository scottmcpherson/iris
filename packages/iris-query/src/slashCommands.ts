import { queryOptions, useQuery } from "@tanstack/react-query";
import {
  getAgentSlashCommands,
  type IrisCoreClient,
  type IrisCoreSlashCommand,
  type IrisCoreSlashCommandsResult,
  type IrisCoreSlashCommandSource,
} from "@iris/core-client";
import { ensureOk } from "./ensureOk";

export const slashCommandKeys = {
  all: (clientKey: string) => ["slashCommands", clientKey] as const,
  catalog: (clientKey: string, agentId: string) => [...slashCommandKeys.all(clientKey), "catalog", agentId] as const,
};

export function slashCommandsQueryOptions(
  client: IrisCoreClient | null,
  clientKey: string,
  agentId: string,
) {
  return queryOptions({
    queryKey: slashCommandKeys.catalog(clientKey, agentId),
    queryFn: async () => {
      if (!client) throw new Error("Iris Core is not connected.");
      const result = await ensureOk(getAgentSlashCommands(client, agentId), "Could not load slash commands.");
      return normalizeSlashCommandsResult(result);
    },
    enabled: Boolean(client && agentId),
  });
}

export function useSlashCommandsQuery(
  client: IrisCoreClient | null,
  clientKey: string,
  agentId: string,
) {
  return useQuery(slashCommandsQueryOptions(client, clientKey, agentId));
}

function normalizeSlashCommandsResult(result: IrisCoreSlashCommandsResult): IrisCoreSlashCommandsResult {
  const commandsByText = new Map<string, IrisCoreSlashCommand>();
  for (const command of result.commands || []) {
    const normalized = normalizeSlashCommand(command);
    if (!normalized.text) continue;
    const key = normalized.text.toLowerCase();
    if (!commandsByText.has(key)) commandsByText.set(key, normalized);
  }
  return {
    ...result,
    commands: [...commandsByText.values()].sort((left, right) => left.text.localeCompare(right.text)),
  };
}

function normalizeSlashCommand(command: Partial<IrisCoreSlashCommand>): IrisCoreSlashCommand {
  const source = command.source || "hermes";
  return {
    id: command.id || command.text || command.name || "",
    name: command.name || command.text?.replace(/^\//u, "") || "",
    text: command.text || (command.name ? `/${command.name}` : ""),
    label: command.label || command.text || command.name || "",
    description: command.description || "",
    category: command.category || "Commands",
    source: validSource(source) ? source : "hermes",
    aliases: Array.isArray(command.aliases) ? command.aliases : [],
    argsHint: command.argsHint || "",
    subcommands: Array.isArray(command.subcommands) ? command.subcommands : [],
    requiresArgument: Boolean(command.requiresArgument),
  };
}

function validSource(value: string): value is IrisCoreSlashCommandSource {
  return value === "hermes" || value === "skill" || value === "quick-command" || value === "plugin";
}
