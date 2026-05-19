import { useEffect, useRef, useState } from "react";
import { resolveCoreApiUrl } from "../../app/runtimeConfig";
import { getIrisSlashCommands } from "../../lib/irisRuntime";
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
  const [catalogs, setCatalogs] = useState<Record<string, HermesSlashCommandsResult>>({});
  const [loadingByKey, setLoadingByKey] = useState<Record<string, boolean>>({});
  const [errorsByKey, setErrorsByKey] = useState<Record<string, string | null>>({});
  const requestSeqRef = useRef(0);
  const routeKey = slashCommandRouteKey(runtimeConfig, profile);
  const cacheKey = `${profile}|${routeKey}`;
  const catalog = catalogs[cacheKey] || null;
  const loading = Boolean(loadingByKey[cacheKey]);
  const error = errorsByKey[cacheKey] || catalog?.error || null;
  const warning = catalog?.warning || null;
  const commands = connected ? catalog?.commands || [] : [];

  useEffect(() => {
    if (!connected || !profile) {
      setLoadingByKey((current) => ({ ...current, [cacheKey]: false }));
      return undefined;
    }
    void refreshSlashCommands();
    return undefined;
  }, [connected, profile, routeKey, refreshKey]);

  async function refreshSlashCommands() {
    if (!connected || !profile) return;
    const requestId = ++requestSeqRef.current;
    setLoadingByKey((current) => ({ ...current, [cacheKey]: true }));
    setErrorsByKey((current) => ({ ...current, [cacheKey]: null }));
    try {
      const result = await getIrisSlashCommands(profile, runtimeConfig);
      if (requestSeqRef.current !== requestId) return;
      setCatalogs((current) => ({ ...current, [cacheKey]: normalizeSlashCommandsResult(profile, result) }));
      setErrorsByKey((current) => ({
        ...current,
        [cacheKey]: result.ok ? null : result.error || "Could not load slash commands.",
      }));
    } catch (error) {
      if (requestSeqRef.current !== requestId) return;
      setErrorsByKey((current) => ({
        ...current,
        [cacheKey]: error instanceof Error ? error.message : "Could not load slash commands.",
      }));
    } finally {
      if (requestSeqRef.current === requestId) {
        setLoadingByKey((current) => ({ ...current, [cacheKey]: false }));
      }
    }
  }

  return {
    commands,
    loading,
    error,
    warning,
    refreshSlashCommands,
  };
}

function slashCommandRouteKey(runtimeConfig: HermesRuntimeConfig, profile: string) {
  return [resolveCoreApiUrl(runtimeConfig), profile].join("|");
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
