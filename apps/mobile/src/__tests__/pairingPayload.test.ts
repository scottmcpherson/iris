import { describe, expect, it } from "vitest";
import { parsePairingPayload, profileFromPairingPayload } from "../connection/pairingPayload";

const payload = {
  kind: "iris-mobile-pairing",
  version: 1,
  hostId: "macbook-pro-scott",
  hostLabel: "Scott's MacBook Pro",
  ssh: {
    host: "macbook-pro.local",
    port: 22,
    userHint: "scott",
  },
  core: {
    remoteHost: "127.0.0.1",
    remotePort: 8765,
    apiBasePath: "/v1",
  },
  pairing: {
    nonce: "nonce",
    expiresAt: 1780000000,
  },
} as const;

describe("mobile pairing payload", () => {
  it("validates payload shape and expiration", () => {
    const result = parsePairingPayload(JSON.stringify(payload), 1779999900);
    expect(result.ok).toBe(true);
  });

  it("rejects expired payloads", () => {
    const result = parsePairingPayload(JSON.stringify(payload), 1780000001);
    expect(result).toMatchObject({ ok: false });
  });

  it("creates an SSH-only saved profile", () => {
    const profile = profileFromPairingPayload(payload, "scott", "192.168.1.20");
    expect(profile).toMatchObject({
      sshHost: "192.168.1.20",
      sshPort: 22,
      remoteCoreHost: "127.0.0.1",
      remoteCorePort: 8765,
      apiBasePath: "/v1",
    });
  });
});
