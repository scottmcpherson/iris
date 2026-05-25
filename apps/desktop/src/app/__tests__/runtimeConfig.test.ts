import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateCoreConnection,
  defaultRuntimeConfig,
  loadRuntimeConfig,
  managedLocalConnectionId,
  resolveCoreApiUrl,
  runtimeDataRouteKey,
  upsertCoreConnection,
} from "../runtimeConfig";

function installStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
}

describe("runtimeConfig", () => {
  beforeEach(() => {
    installStorage();
  });

  it("creates a managed-local profile for empty storage", () => {
    const config = loadRuntimeConfig();
    expect(config).toEqual(defaultRuntimeConfig);
    expect(config.connectionMode).toBe("managed-local");
    expect(config.activeConnectionId).toBe(managedLocalConnectionId);
    expect(resolveCoreApiUrl(config)).toBe("http://127.0.0.1:8765");
  });

  it("ignores old hermes.desktop.runtime values", () => {
    localStorage.setItem(
      "hermes.desktop.runtime",
      JSON.stringify({ connectionMode: "remote", coreApiUrl: "http://agent.example.com:8765" }),
    );

    expect(loadRuntimeConfig()).toEqual(defaultRuntimeConfig);
  });

  it("falls back to fresh managed-local config for invalid v2 modes", () => {
    localStorage.setItem(
      "iris.desktop.runtime.v2",
      JSON.stringify({
        connectionMode: "browser",
        activeConnectionId: "bad",
        coreConnections: [{ id: "bad", name: "Bad", mode: "browser", effectiveCoreApiUrl: "http://127.0.0.1:9999" }],
      }),
    );

    expect(loadRuntimeConfig()).toEqual(defaultRuntimeConfig);
  });

  it("loads a saved Tailscale profile and computes its Core URL from MagicDNS + port", () => {
    localStorage.setItem(
      "iris.desktop.runtime.v2",
      JSON.stringify({
        connectionMode: "tailscale",
        activeConnectionId: "tailscale_mac_mini",
        coreConnections: [
          {
            id: "tailscale_mac_mini",
            name: "Mac mini",
            mode: "tailscale",
            effectiveCoreApiUrl: "http://mac-mini.tailnet.ts.net:8765/v1",
            tailscale: {
              hostId: "tailscale_mac_mini",
              hostLabel: "Mac mini",
              magicDnsName: "mac-mini.tailnet.ts.net",
              tailscaleIp: "100.64.0.7",
              corePort: 8765,
              deviceToken: "iris_mobile_abc",
            },
          },
        ],
      }),
    );

    const config = loadRuntimeConfig();
    const ts = config.coreConnections.find((connection) => connection.id === "tailscale_mac_mini");

    expect(config.connectionMode).toBe("tailscale");
    expect(ts?.tailscale?.magicDnsName).toBe("mac-mini.tailnet.ts.net");
    expect(ts?.tailscale?.deviceToken).toBe("iris_mobile_abc");
    // The /v1 suffix is dropped and the URL is rebuilt from the host + Core port.
    expect(resolveCoreApiUrl(config)).toBe("http://mac-mini.tailnet.ts.net:8765");
  });

  it("prefers the Tailscale IP when no MagicDNS name is present", () => {
    const config = upsertCoreConnection(
      defaultRuntimeConfig,
      {
        id: "tailscale_ip",
        name: "IP host",
        mode: "tailscale",
        effectiveCoreApiUrl: "",
        tailscale: {
          hostId: "tailscale_ip",
          hostLabel: "IP host",
          tailscaleIp: "100.64.0.9",
          corePort: 8765,
        },
      },
      { activate: true },
    );

    expect(resolveCoreApiUrl(config)).toBe("http://100.64.0.9:8765");
  });

  it("drops legacy SSH profiles back to managed local", () => {
    localStorage.setItem(
      "iris.desktop.runtime.v2",
      JSON.stringify({
        connectionMode: "ssh",
        activeConnectionId: "ssh_mac_mini",
        coreConnections: [
          {
            id: "ssh_mac_mini",
            name: "Mac mini",
            mode: "ssh",
            effectiveCoreApiUrl: "http://127.0.0.1:52942",
            ssh: { user: "agent", host: "agents-mac-mini", remoteCorePort: 8765, localForwardPort: "auto" },
          },
        ],
      }),
    );

    expect(loadRuntimeConfig()).toEqual(defaultRuntimeConfig);
  });

  it("sanitizes legacy manual-url configs back to managed local", () => {
    localStorage.setItem(
      "iris.desktop.runtime.v2",
      JSON.stringify({
        connectionMode: "manual-url",
        activeConnectionId: "manual_dev",
        coreConnections: [
          {
            id: "manual_dev",
            name: "Dev Core",
            mode: "manual-url",
            effectiveCoreApiUrl: "http://127.0.0.1:8777",
            manual: { url: "http://127.0.0.1:8777", requiresToken: false },
          },
        ],
      }),
    );

    expect(loadRuntimeConfig()).toEqual(defaultRuntimeConfig);
  });

  it("drops Tailscale profiles that have no reachable host", () => {
    localStorage.setItem(
      "iris.desktop.runtime.v2",
      JSON.stringify({
        connectionMode: "tailscale",
        activeConnectionId: "tailscale_broken",
        coreConnections: [
          {
            id: "tailscale_broken",
            name: "Broken",
            mode: "tailscale",
            effectiveCoreApiUrl: "http://mac-mini.tailnet.ts.net:8765",
            tailscale: { hostId: "tailscale_broken", hostLabel: "Broken", corePort: 8765 },
          },
        ],
      }),
    );

    expect(loadRuntimeConfig()).toEqual(defaultRuntimeConfig);
  });

  it("activates saved Tailscale profiles by id", () => {
    const config = upsertCoreConnection(defaultRuntimeConfig, {
      id: "tailscale_dev",
      name: "Dev host",
      mode: "tailscale",
      effectiveCoreApiUrl: "http://dev-host.tailnet.ts.net:8765",
      tailscale: {
        hostId: "tailscale_dev",
        hostLabel: "Dev host",
        magicDnsName: "dev-host.tailnet.ts.net",
        corePort: 8765,
      },
    });

    const active = activateCoreConnection(config, "tailscale_dev");

    expect(active.connectionMode).toBe("tailscale");
    expect(resolveCoreApiUrl(active)).toBe("http://dev-host.tailnet.ts.net:8765");
  });

  it("keys session data by the selected Core route, not just the profile name", () => {
    const tailscaleConfig = upsertCoreConnection(
      defaultRuntimeConfig,
      {
        id: "tailscale_mac_mini",
        name: "Mac mini",
        mode: "tailscale",
        effectiveCoreApiUrl: "http://mac-mini.tailnet.ts.net:8765",
        tailscale: {
          hostId: "tailscale_mac_mini",
          hostLabel: "Mac mini",
          magicDnsName: "mac-mini.tailnet.ts.net",
          corePort: 8765,
        },
      },
      { activate: true },
    );

    const otherHostConfig = upsertCoreConnection(
      defaultRuntimeConfig,
      {
        id: "tailscale_mac_mini",
        name: "Mac mini",
        mode: "tailscale",
        effectiveCoreApiUrl: "http://other-host.tailnet.ts.net:8765",
        tailscale: {
          hostId: "tailscale_mac_mini",
          hostLabel: "Mac mini",
          magicDnsName: "other-host.tailnet.ts.net",
          corePort: 8765,
        },
      },
      { activate: true },
    );

    expect(runtimeDataRouteKey(defaultRuntimeConfig)).not.toBe(runtimeDataRouteKey(tailscaleConfig));
    expect(runtimeDataRouteKey(otherHostConfig)).not.toBe(runtimeDataRouteKey(tailscaleConfig));
  });
});
