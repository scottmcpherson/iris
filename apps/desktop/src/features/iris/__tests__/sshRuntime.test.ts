import { describe, expect, it, vi } from "vitest";
import {
  activeCoreConnection,
  defaultCorePort,
  defaultRuntimeConfig,
  defaultSshPort,
  upsertCoreConnection,
} from "../../../app/runtimeConfig";
import type { HermesRuntimeConfig, IrisCoreConnectionProfile } from "../../../types/hermes";
import { ensureActiveSshTunnel, type InvokeSshTunnelCommand, type SshTunnelStatus } from "../sshRuntime";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));

describe("sshRuntime", () => {
  it("does nothing outside the desktop runtime", async () => {
    const config = sshRuntimeConfig();
    const invokeCommand = vi.fn() as unknown as InvokeSshTunnelCommand;

    const result = await ensureActiveSshTunnel(config, { isDesktop: false, invokeCommand });

    expect(result).toBe(config);
    expect(invokeCommand).not.toHaveBeenCalled();
  });

  it("reopens stale SSH tunnels without reusing the saved local forward port", async () => {
    const config = sshRuntimeConfig();
    const invokeCommand = vi.fn(async (command: string) => {
      if (command === "ssh_tunnel_status") return tunnelStatus({ ok: false, running: false });
      return tunnelStatus({ localPort: 55555, effectiveCoreApiUrl: "http://127.0.0.1:55555" });
    }) as unknown as InvokeSshTunnelCommand;

    const result = await ensureActiveSshTunnel(config, { isDesktop: true, invokeCommand });
    const active = activeCoreConnection(result);
    const startPayload = vi.mocked(invokeCommand).mock.calls[1]?.[1] as { config: Record<string, unknown> };

    expect(active.effectiveCoreApiUrl).toBe("http://127.0.0.1:55555");
    expect(active.ssh?.localForwardPort).toBe(55555);
    expect(startPayload.config).toMatchObject({
      connectionId: "ssh_mac_mini",
      user: "agent",
      host: "agents-mac-mini",
      port: defaultSshPort,
      identityFile: "~/.ssh/id_ed25519",
      remoteCoreHost: "127.0.0.1",
      remoteCorePort: defaultCorePort,
      autoStartRemoteCore: false,
    });
    expect(startPayload.config).not.toHaveProperty("localForwardPort");
  });

  it("uses an already running tunnel status to refresh the effective Core URL", async () => {
    const config = sshRuntimeConfig();
    const invokeCommand = vi.fn(async () =>
      tunnelStatus({ localPort: 54431, effectiveCoreApiUrl: "http://127.0.0.1:54431" })
    ) as unknown as InvokeSshTunnelCommand;

    const result = await ensureActiveSshTunnel(config, { isDesktop: true, invokeCommand });
    const active = activeCoreConnection(result);

    expect(active.effectiveCoreApiUrl).toBe("http://127.0.0.1:54431");
    expect(active.ssh?.localForwardPort).toBe(54431);
    expect(vi.mocked(invokeCommand)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invokeCommand)).toHaveBeenCalledWith("ssh_tunnel_status", {
      connectionId: "ssh_mac_mini",
    });
  });

  it("surfaces SSH start failures before Core status fetches run", async () => {
    const config = sshRuntimeConfig();
    const invokeCommand = vi.fn(async (command: string) => {
      if (command === "ssh_tunnel_status") return tunnelStatus({ ok: false, running: false });
      return tunnelStatus({ ok: false, running: false, error: "Connection refused" });
    }) as unknown as InvokeSshTunnelCommand;

    await expect(ensureActiveSshTunnel(config, { isDesktop: true, invokeCommand })).rejects.toThrow(
      "Connection refused",
    );
  });
});

function sshRuntimeConfig(): HermesRuntimeConfig {
  return upsertCoreConnection(defaultRuntimeConfig, sshProfile(), { activate: true });
}

function sshProfile(): IrisCoreConnectionProfile {
  return {
    id: "ssh_mac_mini",
    name: "Iris Mac mini",
    mode: "ssh",
    effectiveCoreApiUrl: "http://127.0.0.1:54116",
    ssh: {
      user: "agent",
      host: "agents-mac-mini",
      port: defaultSshPort,
      identityFile: "~/.ssh/id_ed25519",
      remoteCoreHost: "127.0.0.1",
      remoteCorePort: defaultCorePort,
      localForwardPort: 54116,
      autoStartRemoteCore: true,
    },
  };
}

function tunnelStatus(overrides: Partial<SshTunnelStatus> = {}): SshTunnelStatus {
  return {
    ok: true,
    connectionId: "ssh_mac_mini",
    running: true,
    localPort: 54116,
    effectiveCoreApiUrl: "http://127.0.0.1:54116",
    pid: 1234,
    reconnecting: false,
    restartAttempt: 0,
    errorKind: "",
    error: "",
    ...overrides,
  };
}
