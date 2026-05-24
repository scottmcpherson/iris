import { describe, expect, it } from "vitest";
import { parsePairingPayload, profileFromPairingPayload } from "../connection/pairingPayload";

const payload = {
  kind: "iris-mobile-pairing",
  version: 1,
  hostId: "macbook-pro-scott",
  hostLabel: "Scott's MacBook Pro",
  core: {
    url: "http://100.110.38.56:8765/v1",
    apiBasePath: "/v1",
  },
  pairing: {
    code: "mp_test",
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

  it("creates a direct Core saved profile", () => {
    const profile = profileFromPairingPayload(payload, "dev_iphone");
    expect(profile).toMatchObject({
      transport: "direct-core",
      coreUrl: "http://100.110.38.56:8765/v1",
      apiBasePath: "/v1",
      deviceId: "dev_iphone",
    });
  });
});
