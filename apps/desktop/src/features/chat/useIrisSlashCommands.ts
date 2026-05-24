import { useEffect } from "react";
import { useSlashCommandsQuery } from "../../lib/query";
import type {
  HermesRuntimeConfig,
  HermesSlashCommand,
  HermesSlashCommandsResult,
} from "../../types/hermes";

type UseIrisSlashCommandsOptions = {
  profile: string;
  runtimeConfig: HermesRuntimeConfig;
  connected: boolean;
  refreshKey?: string | number | null;
};

export function useIrisSlashCommands({
  profile,
  runtimeConfig,
  connected,
  refreshKey,
}: UseIrisSlashCommandsOptions) {
  const query = useSlashCommandsQuery(runtimeConfig, profile, connected);
  const catalog = query.data ? normalizeSlashCommandsResult(profile, query.data) : null;
  const queryError = query.error instanceof Error ? query.error.message : null;
  const loading = Boolean(connected && query.isFetching);
  const error = queryError || catalog?.error || null;
  const warning = catalog?.warning || null;
  const commands = connected ? catalog?.commands || [] : [];

  useEffect(() => {
    if (!connected || !profile || refreshKey == null) return;
    void query.refetch();
  }, [connected, profile, refreshKey]);

  return {
    commands,
    loading,
    error,
    warning,
    refreshSlashCommands: query.refetch,
  };
}

function normalizeSlashCommandsResult(
  profile: string,
  result: HermesSlashCommandsResult,
): HermesSlashCommandsResult {
  const commandsByText = new Map<string, HermesSlashCommand>();
  for (const command of result.commands || []) {
    if (!command.text) continue;
    const key = command.text.toLowerCase();
    if (!commandsByText.has(key)) commandsByText.set(key, command);
  }
  return {
    ...result,
    profile: result.profile || profile,
    commands: [...commandsByText.values()].sort((left, right) => left.text.localeCompare(right.text)),
  };
}
