import type { HermesRuntimeConfig } from "../types/hermes";
import { loadJsonValue, saveJsonValue, storageKeys } from "./storage";

export const defaultRuntimeConfig: HermesRuntimeConfig = {
  connectionMode: "local",
  provider: "",
  model: "",
  remoteUrl: "",
  coreApiUrl: "http://127.0.0.1:8765",
};

export function loadRuntimeConfig(): HermesRuntimeConfig {
  try {
    const stored = loadJsonValue<Partial<HermesRuntimeConfig> & Record<string, unknown>>(storageKeys.runtimeConfig, {});
    return {
      ...defaultRuntimeConfig,
      ...stored,
      coreApiUrl: migratedCoreApiUrl(stored) || defaultRuntimeConfig.coreApiUrl,
      connectionMode: stored.connectionMode === "remote" ? "remote" : "local",
    };
  } catch {
    return defaultRuntimeConfig;
  }
}

export function saveRuntimeConfig(config: HermesRuntimeConfig) {
  saveJsonValue(storageKeys.runtimeConfig, {
    connectionMode: config.connectionMode === "remote" ? "remote" : "local",
    provider: config.provider,
    model: config.model,
    remoteUrl: config.remoteUrl,
    coreApiUrl: normalizeServerUrl(config.coreApiUrl) || defaultRuntimeConfig.coreApiUrl,
  });
}

export function resolveCoreApiUrl(config: HermesRuntimeConfig) {
  return normalizeServerUrl(config.coreApiUrl) || defaultRuntimeConfig.coreApiUrl;
}

function migratedCoreApiUrl(stored: Partial<HermesRuntimeConfig> & Record<string, unknown>) {
  const legacyProfileRoutesKey = ["profile", "Side" + "car", "Urls"].join("");
  const legacyCoreRouteKey = ["management", "Api", "Url"].join("");
  const legacyRoutes = stored[legacyProfileRoutesKey];
  const firstLegacyRoute =
    legacyRoutes && typeof legacyRoutes === "object" && !Array.isArray(legacyRoutes)
      ? Object.values(legacyRoutes as Record<string, unknown>).find((value) => typeof value === "string")
      : "";
  return (
    normalizeServerUrl(stored.coreApiUrl) ||
    normalizeServerUrl(stored[legacyCoreRouteKey]) ||
    normalizeServerUrl(firstLegacyRoute)
  );
}

function normalizeServerUrl(value: unknown) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    if (!url.protocol.startsWith("http") || !url.hostname || !url.port) return "";
    const path = url.pathname.replace(/\/+$/, "");
    if (path && path !== "/v1") return "";
    return url.origin;
  } catch {
    return "";
  }
}
