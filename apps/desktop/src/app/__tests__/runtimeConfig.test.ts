import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateCoreConnection,
  defaultRuntimeConfig,
  defaultSshPort,
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

  it("defaults saved SSH profiles without a port to port 22", () => {
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
            ssh: {
              user: "agent",
              host: "agents-mac-mini",
              remoteCorePort: 8765,
              localForwardPort: "auto",
            },
          },
        ],
      }),
    );

    const config = loadRuntimeConfig();
    const ssh = config.coreConnections.find((connection) => connection.id === "ssh_mac_mini");

    expect(ssh?.ssh?.port).toBe(defaultSshPort);
  });

  it("strips /v1 from SSH effective profile URLs", () => {
    const config = upsertCoreConnection(defaultRuntimeConfig, {
      id: "ssh_dev",
      name: "Dev SSH",
      mode: "ssh",
      effectiveCoreApiUrl: "http://127.0.0.1:8766/v1",
      ssh: {
        user: "agent",
        host: "dev-host",
        port: 22,
        remoteCoreHost: "127.0.0.1",
        remoteCorePort: 8765,
        localForwardPort: 8766,
        autoStartRemoteCore: false,
      },
    }, { activate: true });

    expect(resolveCoreApiUrl(config)).toBe("http://127.0.0.1:8766");
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

  it("sanitizes legacy tailscale configs back to managed local", () => {
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
            effectiveCoreApiUrl: "http://mac-mini.tailnet.ts.net:8765",
            tailscale: { host: "mac-mini.tailnet.ts.net", port: 8765, requiresToken: true },
          },
        ],
      }),
    );

    expect(loadRuntimeConfig()).toEqual(defaultRuntimeConfig);
  });

  it("activates saved SSH profiles by id", () => {
    const config = upsertCoreConnection(defaultRuntimeConfig, {
      id: "ssh_dev",
      name: "Dev SSH",
      mode: "ssh",
      effectiveCoreApiUrl: "http://127.0.0.1:8777",
      ssh: {
        user: "agent",
        host: "dev-host",
        port: 22,
        remoteCoreHost: "127.0.0.1",
        remoteCorePort: 8765,
        localForwardPort: 8777,
        autoStartRemoteCore: false,
      },
    });

    const active = activateCoreConnection(config, "ssh_dev");

    expect(active.connectionMode).toBe("ssh");
    expect(resolveCoreApiUrl(active)).toBe("http://127.0.0.1:8777");
  });

  it("keys session data by the selected Core route, not just the profile name", () => {
    const sshConfig = upsertCoreConnection(defaultRuntimeConfig, {
      id: "ssh_mac_mini",
      name: "Mac mini",
      mode: "ssh",
      effectiveCoreApiUrl: "http://127.0.0.1:52942",
      ssh: {
        user: "agent",
        host: "agents-mac-mini",
        port: 22,
        identityFile: "~/.ssh/id_ed25519",
        remoteCoreHost: "127.0.0.1",
        remoteCorePort: 8765,
        localForwardPort: "auto",
        autoStartRemoteCore: false,
      },
    }, { activate: true });

    const reopenedTunnelConfig = {
      ...sshConfig,
      coreConnections: sshConfig.coreConnections.map((connection) =>
        connection.id === "ssh_mac_mini"
          ? {
              ...connection,
              effectiveCoreApiUrl: "http://127.0.0.1:54116",
              ssh: connection.ssh
                ? { ...connection.ssh, localForwardPort: 54116 }
                : connection.ssh,
            }
          : connection,
      ),
    };

    expect(runtimeDataRouteKey(defaultRuntimeConfig)).not.toBe(runtimeDataRouteKey(sshConfig));
    expect(runtimeDataRouteKey(reopenedTunnelConfig)).toBe(runtimeDataRouteKey(sshConfig));
  });
});
