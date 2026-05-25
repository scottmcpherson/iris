import type {
  HermesRuntimeConfig,
  IrisCoreConnectionMode,
  IrisCoreConnectionProfile,
} from "../types/hermes";
import { loadJsonValue, saveJsonValue, storageKeys } from "./storage";

export const managedLocalConnectionId = "core_local";
export const defaultCorePort = 8765;
export const defaultCoreApiUrl = `http://127.0.0.1:${defaultCorePort}`;

export const defaultManagedLocalProfile: IrisCoreConnectionProfile = {
  id: managedLocalConnectionId,
  name: "Local",
  mode: "managed-local",
  effectiveCoreApiUrl: defaultCoreApiUrl,
  local: {
    port: defaultCorePort,
    autoStart: true,
    installLaunchAgent: false,
  },
};

export const defaultRuntimeConfig: HermesRuntimeConfig = {
  connectionMode: "managed-local",
  activeConnectionId: managedLocalConnectionId,
  coreConnections: [defaultManagedLocalProfile],
  provider: "",
  model: "",
};

const validModes = new Set<IrisCoreConnectionMode>(["managed-local", "tailscale"]);
const legacyUnsupportedModes = new Set(["ssh", "manual-url"]);

export function loadRuntimeConfig(): HermesRuntimeConfig {
  try {
    const stored = loadJsonValue<Record<string, unknown>>(storageKeys.runtimeConfig, {});
    const parsed = parseRuntimeConfig(stored);
    return parsed || cloneDefaultRuntimeConfig();
  } catch {
    return cloneDefaultRuntimeConfig();
  }
}

export function saveRuntimeConfig(config: HermesRuntimeConfig) {
  saveJsonValue(storageKeys.runtimeConfig, serializeRuntimeConfig(config));
}

export function resolveCoreApiUrl(config: HermesRuntimeConfig | undefined) {
  return activeCoreConnection(config)?.effectiveCoreApiUrl || defaultCoreApiUrl;
}

export function activeCoreConnection(config: HermesRuntimeConfig | undefined) {
  if (!config?.coreConnections?.length) return defaultManagedLocalProfile;
  const active =
    config.coreConnections.find((connection) => connection.id === config.activeConnectionId) ||
    config.coreConnections.find((connection) => connection.mode === config.connectionMode) ||
    config.coreConnections[0];
  return active || defaultManagedLocalProfile;
}

export function runtimeDataRouteKey(config: HermesRuntimeConfig | undefined) {
  const active = activeCoreConnection(config);
  if (active.mode === "tailscale") {
    const ts = active.tailscale;
    return [
      "tailscale",
      active.id,
      ts?.magicDnsName || ts?.tailscaleIp || "",
      ts?.corePort || defaultCorePort,
    ].join("|");
  }
  return [active.mode, active.id, resolveCoreApiUrl(config)].join("|");
}

export function connectionTransport(profile: IrisCoreConnectionProfile | undefined) {
  if (profile?.mode === "tailscale") return "tailscale" as const;
  return "sidecar" as const;
}

export function hermesOwner(profile: IrisCoreConnectionProfile | undefined) {
  if (profile?.mode === "tailscale") return "remote-host" as const;
  return "this-mac" as const;
}

export function upsertCoreConnection(
  config: HermesRuntimeConfig,
  profile: IrisCoreConnectionProfile,
  options: { activate?: boolean } = {},
): HermesRuntimeConfig {
  const normalized = normalizeProfile(profile);
  if (!normalized) return config;
  const existing = config.coreConnections.filter((connection) => connection.id !== normalized.id);
  const coreConnections = [normalized, ...existing];
  return {
    ...config,
    connectionMode: options.activate ? normalized.mode : config.connectionMode,
    activeConnectionId: options.activate ? normalized.id : config.activeConnectionId,
    coreConnections: ensureManagedLocalProfile(coreConnections),
  };
}

export function activateCoreConnection(
  config: HermesRuntimeConfig,
  connectionId: string,
): HermesRuntimeConfig {
  const connection = config.coreConnections.find((item) => item.id === connectionId);
  if (!connection) return config;
  return {
    ...config,
    activeConnectionId: connection.id,
    connectionMode: connection.mode,
  };
}

export function removeCoreConnection(
  config: HermesRuntimeConfig,
  connectionId: string,
): HermesRuntimeConfig {
  if (connectionId === managedLocalConnectionId) return config;
  const coreConnections = ensureManagedLocalProfile(
    config.coreConnections.filter((connection) => connection.id !== connectionId),
  );
  const active =
    coreConnections.find((connection) => connection.id === config.activeConnectionId) ||
    coreConnections[0] ||
    defaultManagedLocalProfile;
  return {
    ...config,
    activeConnectionId: active.id,
    connectionMode: active.mode,
    coreConnections,
  };
}

export function normalizeServerUrl(value: unknown) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || !url.port) return "";
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path !== "/" && path !== "/v1") return "";
    return url.origin;
  } catch {
    return "";
  }
}

export function connectionIdFromParts(prefix: string, parts: Array<string | number | undefined>) {
  const slug = parts
    .map((part) => String(part ?? "").trim().toLowerCase())
    .filter(Boolean)
    .join("-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${prefix}_${slug || Math.random().toString(36).slice(2, 10)}`;
}

function parseRuntimeConfig(value: Record<string, unknown>): HermesRuntimeConfig | null {
  if (!value || typeof value !== "object") return null;
  const mode = value.connectionMode;
  const modeIsSupported = isConnectionMode(mode);
  const requestedMode = modeIsSupported ? mode : "managed-local";
  if (!modeIsSupported && !legacyUnsupportedModes.has(String(mode))) return null;
  const rawConnections = Array.isArray(value.coreConnections) ? value.coreConnections : [];
  const coreConnections = rawConnections
    .map((connection) => normalizeProfile(connection))
    .filter((connection): connection is IrisCoreConnectionProfile => Boolean(connection));
  if (!coreConnections.length) return null;
  const withManagedLocal = ensureManagedLocalProfile(coreConnections);
  const activeConnectionId =
    modeIsSupported &&
    typeof value.activeConnectionId === "string" &&
    withManagedLocal.some((connection) => connection.id === value.activeConnectionId)
      ? value.activeConnectionId
      : withManagedLocal.find((connection) => connection.mode === requestedMode)?.id || managedLocalConnectionId;
  const active = withManagedLocal.find((connection) => connection.id === activeConnectionId);
  if (!active) return null;
  return {
    connectionMode: active.mode,
    activeConnectionId,
    coreConnections: withManagedLocal,
    provider: typeof value.provider === "string" ? value.provider : "",
    model: typeof value.model === "string" ? value.model : "",
  };
}

function serializeRuntimeConfig(config: HermesRuntimeConfig): HermesRuntimeConfig {
  const parsed = parseRuntimeConfig({
    connectionMode: config.connectionMode,
    activeConnectionId: config.activeConnectionId,
    coreConnections: config.coreConnections,
    provider: config.provider,
    model: config.model,
  });
  return parsed || cloneDefaultRuntimeConfig();
}

function normalizeProfile(value: unknown): IrisCoreConnectionProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const mode = record.mode;
  if (!isConnectionMode(mode)) return null;
  const id = cleanId(record.id) || connectionIdFromParts(`core_${mode}`, [stringValue(record.name), stringValue(record.effectiveCoreApiUrl)]);
  const name = cleanName(record.name) || defaultNameForMode(mode);
  const effectiveCoreApiUrl = effectiveUrlForProfile(record) || defaultCoreApiUrl;
  const profile: IrisCoreConnectionProfile = {
    id,
    name,
    mode,
    effectiveCoreApiUrl,
  };

  if (mode === "managed-local") {
    const local = objectValue(record.local);
    const port = validPort(local?.port) || portFromUrl(effectiveCoreApiUrl) || defaultCorePort;
    profile.local = {
      port,
      hermesHome: stringValue(local?.hermesHome),
      autoStart: booleanValue(local?.autoStart, true),
      installLaunchAgent: booleanValue(local?.installLaunchAgent, false),
    };
    profile.effectiveCoreApiUrl = `http://127.0.0.1:${port}`;
  } else if (mode === "tailscale") {
    const ts = objectValue(record.tailscale);
    const magicDnsName = stringValue(ts?.magicDnsName);
    const tailscaleIp = stringValue(ts?.tailscaleIp);
    const host = magicDnsName || tailscaleIp;
    // Drop records without a reachable Tailscale host (e.g. legacy manual-URL profiles).
    if (!host) return null;
    const corePort = validPort(ts?.corePort) || portFromUrl(effectiveCoreApiUrl) || defaultCorePort;
    const deviceToken = stringValue(ts?.deviceToken);
    profile.tailscale = {
      hostId: stringValue(ts?.hostId) || id,
      hostLabel: stringValue(ts?.hostLabel) || name,
      magicDnsName: magicDnsName || undefined,
      tailscaleIp: tailscaleIp || undefined,
      corePort,
      deviceToken: deviceToken || undefined,
    };
    const bracketedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    profile.effectiveCoreApiUrl = `http://${bracketedHost}:${corePort}`;
  }

  return profile;
}

function ensureManagedLocalProfile(profiles: IrisCoreConnectionProfile[]) {
  const managed = profiles.find((profile) => profile.id === managedLocalConnectionId || profile.mode === "managed-local");
  const normalizedManaged = managed
    ? { ...defaultManagedLocalProfile, ...managed, id: managedLocalConnectionId, name: "Local", mode: "managed-local" as const }
    : defaultManagedLocalProfile;
  return [
    normalizedManaged,
    ...profiles.filter((profile) => profile.id !== normalizedManaged.id && profile.mode !== "managed-local"),
  ];
}

function effectiveUrlForProfile(record: Record<string, unknown>) {
  const explicit = normalizeServerUrl(record.effectiveCoreApiUrl);
  if (explicit) return explicit;
  return "";
}

function cloneDefaultRuntimeConfig(): HermesRuntimeConfig {
  return {
    ...defaultRuntimeConfig,
    coreConnections: [{ ...defaultManagedLocalProfile, local: { ...defaultManagedLocalProfile.local! } }],
  };
}

function isConnectionMode(value: unknown): value is IrisCoreConnectionMode {
  return typeof value === "string" && validModes.has(value as IrisCoreConnectionMode);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanId(value: unknown) {
  return stringValue(value).replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 96);
}

function cleanName(value: unknown) {
  return stringValue(value).slice(0, 80);
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function validPort(value: unknown) {
  const port = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

function portFromUrl(value: string) {
  try {
    return validPort(new URL(value).port);
  } catch {
    return 0;
  }
}

function defaultNameForMode(mode: IrisCoreConnectionMode) {
  if (mode === "tailscale") return "Tailscale host";
  return "Local";
}
