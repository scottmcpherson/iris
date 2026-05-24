import type { HermesRuntimeConfig } from "../../types/hermes";
import { activeCoreConnection, defaultCorePort, resolveCoreApiUrl } from "../../app/runtimeConfig";

export type IrisMobilePairingPayloadV1 = {
  kind: "iris-mobile-pairing";
  version: 1;
  hostId: string;
  hostLabel: string;
  ssh: {
    host: string;
    port: number;
    userHint?: string;
  };
  core: {
    remoteHost: "127.0.0.1";
    remotePort: number;
    apiBasePath: "/v1";
  };
  pairing: {
    nonce: string;
    expiresAt: number;
    desktopPublicKey?: string;
  };
};

export type MobilePairingDraft = {
  hostId: string;
  hostLabel: string;
  sshHost: string;
  sshPort: string;
  userHint: string;
  remoteCorePort: string;
};

export function defaultMobilePairingDraft(runtimeConfig: HermesRuntimeConfig): MobilePairingDraft {
  const activeConnection = activeCoreConnection(runtimeConfig);
  const ssh = activeConnection.mode === "ssh" ? activeConnection.ssh : null;
  const remoteCorePort = ssh?.remoteCorePort || portFromUrl(resolveCoreApiUrl(runtimeConfig)) || defaultCorePort;
  return {
    hostId: sanitizeHostId(activeConnection.id || "iris-desktop"),
    hostLabel: activeConnection.name || "Iris Desktop",
    sshHost: ssh?.host || "",
    sshPort: String(ssh?.port || 22),
    userHint: ssh?.user || "",
    remoteCorePort: String(remoteCorePort),
  };
}

export function createMobilePairingPayload(
  draft: MobilePairingDraft,
  nowSeconds = Math.floor(Date.now() / 1000),
): IrisMobilePairingPayloadV1 {
  return {
    kind: "iris-mobile-pairing",
    version: 1,
    hostId: draft.hostId.trim() || "iris-desktop",
    hostLabel: draft.hostLabel.trim() || "Iris Desktop",
    ssh: {
      host: draft.sshHost.trim(),
      port: parsePort(draft.sshPort, 22),
      ...(draft.userHint.trim() ? { userHint: draft.userHint.trim() } : {}),
    },
    core: {
      remoteHost: "127.0.0.1",
      remotePort: parsePort(draft.remoteCorePort, defaultCorePort),
      apiBasePath: "/v1",
    },
    pairing: {
      nonce: randomBase64Url(18),
      expiresAt: nowSeconds + 5 * 60,
    },
  };
}

export function validateMobilePairingPayload(payload: IrisMobilePairingPayloadV1, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (payload.kind !== "iris-mobile-pairing" || payload.version !== 1) return false;
  if (!payload.hostId || !payload.hostLabel || !payload.ssh.host) return false;
  if (!validPort(payload.ssh.port) || !validPort(payload.core.remotePort)) return false;
  if (payload.core.remoteHost !== "127.0.0.1" || payload.core.apiBasePath !== "/v1") return false;
  if (!payload.pairing.nonce || payload.pairing.expiresAt <= nowSeconds) return false;
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

function parsePort(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  return validPort(parsed) ? parsed : fallback;
}

function validPort(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535;
}

function randomBase64Url(byteLength: number) {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
