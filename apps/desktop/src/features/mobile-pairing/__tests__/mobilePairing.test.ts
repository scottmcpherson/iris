import { describe, expect, it } from "vitest";
import { coreUrlFromDraft, createMobilePairingPayload, pairingPayloadHasSecrets, validateMobilePairingPayload } from "../mobilePairing";

describe("mobile pairing payload", () => {
  it("generates a direct Core payload with a one-time pairing code", () => {
    const payload = createMobilePairingPayload({
      hostId: "local",
      hostLabel: "Local",
      coreHost: "100.110.38.56",
      corePort: "8765",
    }, { code: "mp_test", expiresAt: 1300 });

    expect(payload).toMatchObject({
      kind: "iris-mobile-pairing",
      version: 1,
      core: { url: "http://100.110.38.56:8765/v1", apiBasePath: "/v1" },
      pairing: { code: "mp_test", expiresAt: 1300 },
    });
    expect(validateMobilePairingPayload(payload, 1000)).toBe(true);
    expect(pairingPayloadHasSecrets(payload)).toBe(false);
  });

  it("rejects expired payloads", () => {
    const payload = createMobilePairingPayload({
      hostId: "local",
      hostLabel: "Local",
      coreHost: "100.110.38.56",
      corePort: "8765",
    }, { code: "mp_test", expiresAt: 1300 });

    expect(validateMobilePairingPayload(payload, 1301)).toBe(false);
  });

  it("rejects payloads without a Core host", () => {
    const payload = createMobilePairingPayload({
      hostId: "local",
      hostLabel: "Local",
      coreHost: "",
      corePort: "8765",
    }, { code: "mp_test", expiresAt: 1300 });

    expect(validateMobilePairingPayload(payload, 1000)).toBe(false);
  });

  it("accepts an explicit Core URL in the host field", () => {
    expect(coreUrlFromDraft({
      hostId: "local",
      hostLabel: "Local",
      coreHost: "https://agents-mac-mini.tailebda16.ts.net:8765",
      corePort: "8765",
    })).toBe("https://agents-mac-mini.tailebda16.ts.net:8765/v1");
  });
});
