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

export type SavedConnectionProfile = {
  id: string;
  hostId: string;
  hostLabel: string;
  sshHost: string;
  sshPort: number;
  username: string;
  remoteCoreHost: "127.0.0.1";
  remoteCorePort: number;
  apiBasePath: "/v1";
  hostKeyFingerprint?: string;
  createdAt: number;
  updatedAt: number;
};

export type PairingParseResult =
  | { ok: true; payload: IrisMobilePairingPayloadV1 }
  | { ok: false; error: string };

export function parsePairingPayload(raw: string, nowSeconds = Math.floor(Date.now() / 1000)): PairingParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "QR payload is not valid JSON." };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "QR payload is not an object." };
  }

  const candidate = parsed as Partial<IrisMobilePairingPayloadV1>;
  if (candidate.kind !== "iris-mobile-pairing" || candidate.version !== 1) {
    return { ok: false, error: "This QR code is not an Iris mobile pairing code." };
  }
  if (!candidate.hostId || !candidate.hostLabel) {
    return { ok: false, error: "Pairing payload is missing host identity fields." };
  }
  if (!candidate.ssh || typeof candidate.ssh.host !== "string" || !candidate.ssh.host.trim()) {
    return { ok: false, error: "Pairing payload is missing an SSH host." };
  }
  if (!validPort(candidate.ssh.port)) {
    return { ok: false, error: "Pairing payload has an invalid SSH port." };
  }
  if (!candidate.core || candidate.core.remoteHost !== "127.0.0.1" || candidate.core.apiBasePath !== "/v1") {
    return { ok: false, error: "Pairing payload has an unsupported Core target." };
  }
  if (!validPort(candidate.core.remotePort)) {
    return { ok: false, error: "Pairing payload has an invalid Core port." };
  }
  if (!candidate.pairing?.nonce || typeof candidate.pairing.expiresAt !== "number") {
    return { ok: false, error: "Pairing payload is missing expiration metadata." };
  }
  if (candidate.pairing.expiresAt <= nowSeconds) {
    return { ok: false, error: "This pairing code has expired. Regenerate it on desktop." };
  }

  return { ok: true, payload: candidate as IrisMobilePairingPayloadV1 };
}

export function profileFromPairingPayload(
  payload: IrisMobilePairingPayloadV1,
  username: string,
  sshHost = payload.ssh.host,
): SavedConnectionProfile {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `${payload.hostId}:${payload.ssh.port}`,
    hostId: payload.hostId,
    hostLabel: payload.hostLabel,
    sshHost: sshHost.trim(),
    sshPort: payload.ssh.port,
    username: username.trim() || payload.ssh.userHint || "",
    remoteCoreHost: payload.core.remoteHost,
    remoteCorePort: payload.core.remotePort,
    apiBasePath: payload.core.apiBasePath,
    createdAt: now,
    updatedAt: now,
  };
}

function validPort(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535;
}
