import { describe, expect, it, vi } from "vitest";
import { createMobilePairingPayload, pairingPayloadHasSecrets, validateMobilePairingPayload } from "../mobilePairing";

describe("mobile pairing payload", () => {
  it("generates a short-lived SSH-only payload", () => {
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
      if (array) {
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(1);
      }
      return array;
    });
    const payload = createMobilePairingPayload({
      hostId: "local",
      hostLabel: "Local",
      sshHost: "macbook-pro.local",
      sshPort: "22",
      userHint: "scott",
      remoteCorePort: "8765",
    }, 1000);

    expect(payload).toMatchObject({
      kind: "iris-mobile-pairing",
      version: 1,
      ssh: { host: "macbook-pro.local", port: 22, userHint: "scott" },
      core: { remoteHost: "127.0.0.1", remotePort: 8765, apiBasePath: "/v1" },
      pairing: { expiresAt: 1300 },
    });
    expect(validateMobilePairingPayload(payload, 1000)).toBe(true);
    expect(pairingPayloadHasSecrets(payload)).toBe(false);
  });

  it("rejects expired payloads", () => {
    const payload = createMobilePairingPayload({
      hostId: "local",
      hostLabel: "Local",
      sshHost: "macbook-pro.local",
      sshPort: "22",
      userHint: "",
      remoteCorePort: "8765",
    }, 1000);

    expect(validateMobilePairingPayload(payload, 1301)).toBe(false);
  });

  it("rejects payloads without an SSH host", () => {
    const payload = createMobilePairingPayload({
      hostId: "local",
      hostLabel: "Local",
      sshHost: "",
      sshPort: "22",
      userHint: "",
      remoteCorePort: "8765",
    }, 1000);

    expect(validateMobilePairingPayload(payload, 1000)).toBe(false);
  });
});
