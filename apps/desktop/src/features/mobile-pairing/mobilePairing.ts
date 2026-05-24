import type { HermesRuntimeConfig } from "../../types/hermes";
import { activeCoreConnection, defaultCorePort, resolveCoreApiUrl } from "../../app/runtimeConfig";

export type IrisMobilePairingPayloadV1 = {
  kind: "iris-mobile-pairing";
  version: 1;
  hostId: string;
  hostLabel: string;
  core: {
    url: string;
    apiBasePath: "/v1";
  };
  pairing: {
    code: string;
    expiresAt: number;
  };
};

export type MobilePairingDraft = {
  hostId: string;
  hostLabel: string;
  coreHost: string;
  corePort: string;
};

export type MobilePairingCode = {
  code: string;
  expiresAt: number;
};

export function defaultMobilePairingDraft(runtimeConfig: HermesRuntimeConfig): MobilePairingDraft {
  const activeConnection = activeCoreConnection(runtimeConfig);
  const ssh = activeConnection.mode === "ssh" ? activeConnection.ssh : null;
  const coreUrl = resolveCoreApiUrl(runtimeConfig);
  const remoteCorePort = ssh?.remoteCorePort || portFromUrl(coreUrl) || defaultCorePort;
  return {
    hostId: sanitizeHostId(activeConnection.id || "iris-desktop"),
    hostLabel: activeConnection.name || "Iris Desktop",
    coreHost: ssh?.host || nonLoopbackHostFromUrl(coreUrl),
    corePort: String(remoteCorePort),
  };
}

export function createMobilePairingPayload(
  draft: MobilePairingDraft,
  pairingCode: MobilePairingCode | null,
): IrisMobilePairingPayloadV1 {
  return {
    kind: "iris-mobile-pairing",
    version: 1,
    hostId: draft.hostId.trim() || "iris-desktop",
    hostLabel: draft.hostLabel.trim() || "Iris Desktop",
    core: {
      url: coreUrlFromDraft(draft),
      apiBasePath: "/v1",
    },
    pairing: {
      code: pairingCode?.code || "",
      expiresAt: pairingCode?.expiresAt || 0,
    },
  };
}

export function validateMobilePairingPayload(payload: IrisMobilePairingPayloadV1, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (payload.kind !== "iris-mobile-pairing" || payload.version !== 1) return false;
  if (!payload.hostId || !payload.hostLabel || !payload.core.url) return false;
  if (!normalizeServerUrl(payload.core.url) || payload.core.apiBasePath !== "/v1") return false;
  if (!payload.pairing.code || payload.pairing.expiresAt <= nowSeconds) return false;
  return true;
}

export function pairingPayloadHasSecrets(payload: IrisMobilePairingPayloadV1) {
  const serialized = JSON.stringify(payload).toLowerCase();
  return ["password", "privatekey", "private_key", "token", "secret"].some((needle) => serialized.includes(needle));
}

function sanitizeHostId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "") || "iris-desktop";
}

function portFromUrl(value: string) {
  try {
    const url = new URL(value);
    return url.port ? Number.parseInt(url.port, 10) : 0;
  } catch {
    return 0;
  }
}

export function coreUrlFromDraft(draft: MobilePairingDraft) {
  const host = draft.coreHost.trim();
  if (!host) return "";
  const explicit = normalizeServerUrl(host);
  if (explicit) return `${explicit}/v1`;
  const port = parsePort(draft.corePort, defaultCorePort);
  const bracketedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${bracketedHost}:${port}/v1`;
}

function normalizeServerUrl(value: string) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || !url.port) return "";
    const path = url.pathname.replace(/\/+$/u, "") || "/";
    if (path !== "/" && path !== "/v1") return "";
    return url.origin;
  } catch {
    return "";
  }
}

function nonLoopbackHostFromUrl(value: string) {
  try {
    const url = new URL(value);
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname) ? "" : url.hostname;
  } catch {
    return "";
  }
}

function parsePort(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  return validPort(parsed) ? parsed : fallback;
}

function validPort(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535;
}
