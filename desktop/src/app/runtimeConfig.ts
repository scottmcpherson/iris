import type { HermesRuntimeConfig } from "../types/hermes";

const runtimeConfigKey = "hermes.desktop.runtime";

export const defaultRuntimeConfig: HermesRuntimeConfig = {
  connectionMode: "local",
  customHermesPath: "",
  provider: "",
  model: "",
  remoteUrl: "",
  gatewayUrl: "http://127.0.0.1:8642",
  managementApiUrl: "http://127.0.0.1:8765",
  profileApiUrls: {},
  profileSidecarUrls: {},
};

export function loadRuntimeConfig(): HermesRuntimeConfig {
  try {
    const stored = JSON.parse(localStorage.getItem(runtimeConfigKey) || "{}") as Partial<HermesRuntimeConfig>;
    return {
      ...defaultRuntimeConfig,
      ...stored,
      gatewayUrl: normalizeServerUrl(stored.gatewayUrl) || defaultRuntimeConfig.gatewayUrl,
      managementApiUrl: normalizeServerUrl(stored.managementApiUrl) || defaultRuntimeConfig.managementApiUrl,
      profileApiUrls: normalizeProfileApiUrls(stored.profileApiUrls),
      profileSidecarUrls: normalizeProfileApiUrls(stored.profileSidecarUrls),
      connectionMode: stored.connectionMode === "remote" ? "remote" : "local",
    };
  } catch {
    return defaultRuntimeConfig;
  }
}

export function saveRuntimeConfig(config: HermesRuntimeConfig) {
  localStorage.setItem(
    runtimeConfigKey,
    JSON.stringify({
      ...config,
      gatewayUrl: normalizeServerUrl(config.gatewayUrl) || defaultRuntimeConfig.gatewayUrl,
      managementApiUrl: normalizeServerUrl(config.managementApiUrl) || defaultRuntimeConfig.managementApiUrl,
      profileApiUrls: normalizeProfileApiUrls(config.profileApiUrls),
      profileSidecarUrls: normalizeProfileApiUrls(config.profileSidecarUrls),
    }),
  );
}

export function resolveRuntimeApiUrl(config: HermesRuntimeConfig, profile: string) {
  return (config.profileApiUrls?.[profile] || "").trim();
}

export function resolveManagementApiUrl(config: HermesRuntimeConfig, profile?: string) {
  return (
    (profile ? config.profileSidecarUrls?.[profile] : "") ||
    config.managementApiUrl ||
    defaultRuntimeConfig.managementApiUrl
  ).trim();
}

function normalizeProfileApiUrls(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([profile, url]) => [profile.trim(), typeof url === "string" ? normalizeServerUrl(url) : ""])
      .filter(([profile, url]) => profile && url),
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
