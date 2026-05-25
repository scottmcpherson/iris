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

type SavedConnectionProfileBase = {
  id: string;
  hostId: string;
  hostLabel: string;
  createdAt: number;
  updatedAt: number;
};

export type DirectCoreConnectionProfile = SavedConnectionProfileBase & {
  transport: "direct-core";
  coreUrl: string;
  apiBasePath: "/v1";
  deviceId?: string;
};

export type SavedConnectionProfile = DirectCoreConnectionProfile;

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
  if (!candidate.core || candidate.core.apiBasePath !== "/v1" || typeof candidate.core.url !== "string") {
    return { ok: false, error: "Pairing payload has an unsupported Core target." };
  }
  if (!normalizeCoreUrl(candidate.core.url)) {
    return { ok: false, error: "Pairing payload has an invalid Core URL." };
  }
  if (!candidate.pairing?.code || typeof candidate.pairing.expiresAt !== "number") {
    return { ok: false, error: "Pairing payload is missing expiration metadata." };
  }
  if (candidate.pairing.expiresAt <= nowSeconds) {
    return { ok: false, error: "This pairing code has expired. Regenerate it on desktop." };
  }

  return { ok: true, payload: candidate as IrisMobilePairingPayloadV1 };
}

export function profileFromPairingPayload(
  payload: IrisMobilePairingPayloadV1,
  deviceId = "",
): SavedConnectionProfile {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `${payload.hostId}:direct-core`,
    hostId: payload.hostId,
    hostLabel: payload.hostLabel,
    transport: "direct-core",
    coreUrl: normalizeCoreUrl(payload.core.url),
    apiBasePath: payload.core.apiBasePath,
    deviceId,
    createdAt: now,
    updatedAt: now,
  };
}

export function isDirectCoreConnectionProfile(profile: SavedConnectionProfile): profile is DirectCoreConnectionProfile {
  return profile.transport === "direct-core";
}

function normalizeCoreUrl(value: string) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || !url.port) return "";
    const path = url.pathname.replace(/\/+$/u, "") || "/v1";
    if (path !== "/v1") return "";
    return `${url.origin}/v1`;
  } catch {
    return "";
  }
}
