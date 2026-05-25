import { describe, expect, it } from "vitest";
import { nodeAddress, nodeKey, normalizePairingCode, type TailscaleNode } from "../useTailscaleConnectionManager";

function node(overrides: Partial<TailscaleNode> = {}): TailscaleNode {
  return {
    hostName: "mac-mini",
    dnsName: "mac-mini.tailnet.ts.net",
    os: "macOS",
    tailscaleIps: ["100.64.0.7", "fd7a:115c::7"],
    online: true,
    ...overrides,
  };
}

describe("useTailscaleConnectionManager helpers", () => {
  it("normalizes pairing codes (case + separators)", () => {
    expect(normalizePairingCode(" kjb3-sf5b ")).toBe("KJB3SF5B");
    expect(normalizePairingCode("ab cd ef")).toBe("ABCDEF");
  });

  it("prefers the MagicDNS name and an IPv4 Tailscale address", () => {
    expect(nodeAddress(node())).toEqual({
      magicDnsName: "mac-mini.tailnet.ts.net",
      tailscaleIp: "100.64.0.7",
    });
    expect(nodeAddress(node({ dnsName: "" })).magicDnsName).toBeUndefined();
    expect(nodeAddress(node({ tailscaleIps: ["fd7a:115c::7"] })).tailscaleIp).toBe("fd7a:115c::7");
  });

  it("keys nodes stably (dnsName, then IP, then hostname)", () => {
    expect(nodeKey(node())).toBe("mac-mini.tailnet.ts.net");
    expect(nodeKey(node({ dnsName: "" }))).toBe("100.64.0.7");
    expect(nodeKey(node({ dnsName: "", tailscaleIps: [] }))).toBe("mac-mini");
  });
});
