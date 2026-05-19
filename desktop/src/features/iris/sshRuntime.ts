import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  activeCoreConnection,
  defaultCorePort,
  defaultSshPort,
  upsertCoreConnection,
} from "../../app/runtimeConfig";
import type { HermesRuntimeConfig, IrisCoreConnectionProfile } from "../../types/hermes";

export type SshTunnelStatus = {
  ok: boolean;
  connectionId: string;
  running: boolean;
  localPort: number;
  effectiveCoreApiUrl: string;
  pid?: number | null;
  reconnecting?: boolean;
  restartAttempt?: number;
  errorKind?: string;
  error?: string;
};

export type InvokeSshTunnelCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

type EnsureSshTunnelOptions = {
  invokeCommand?: InvokeSshTunnelCommand;
  isDesktop?: boolean;
};

const startingTunnels = new Map<string, Promise<SshTunnelStatus>>();

export async function ensureActiveSshTunnel(
  config: HermesRuntimeConfig,
  options: EnsureSshTunnelOptions = {},
): Promise<HermesRuntimeConfig> {
  const desktop = options.isDesktop ?? isTauri();
  if (!desktop) return config;

  const connection = activeCoreConnection(config);
  if (connection.mode !== "ssh" || !connection.ssh) return config;

  const invokeCommand = options.invokeCommand ?? invoke;
  const status = await invokeCommand<SshTunnelStatus>("ssh_tunnel_status", {
    connectionId: connection.id,
  }).catch(() => null);

  if (isUsableTunnelStatus(status)) {
    return applySshTunnelStatus(config, connection, status);
  }

  const result = await startSshTunnel(connection, invokeCommand);
  if (!isUsableTunnelStatus(result)) {
    throw new Error(result.error || "Iris could not open the SSH tunnel.");
  }

  return applySshTunnelStatus(config, connection, result);
}

export function applySshTunnelStatus(
  config: HermesRuntimeConfig,
  connection: IrisCoreConnectionProfile,
  status: SshTunnelStatus,
): HermesRuntimeConfig {
  if (!connection.ssh || !status.localPort || !status.effectiveCoreApiUrl) return config;
  if (
    connection.effectiveCoreApiUrl === status.effectiveCoreApiUrl &&
    connection.ssh.localForwardPort === status.localPort
  ) {
    return config;
  }

  return upsertCoreConnection(
    config,
    {
      ...connection,
      effectiveCoreApiUrl: status.effectiveCoreApiUrl,
      ssh: {
        ...connection.ssh,
        localForwardPort: status.localPort,
      },
    },
    { activate: true },
  );
}

function startSshTunnel(
  connection: IrisCoreConnectionProfile,
  invokeCommand: InvokeSshTunnelCommand,
) {
  const existing = startingTunnels.get(connection.id);
  if (existing) return existing;

  const ssh = connection.ssh;
  if (!ssh) {
    return Promise.resolve({
      ok: false,
      connectionId: connection.id,
      running: false,
      localPort: 0,
      effectiveCoreApiUrl: "",
      error: "SSH connection details are missing.",
    });
  }

  const start = invokeCommand<SshTunnelStatus>("ssh_tunnel_start", {
    config: {
      connectionId: connection.id,
      user: ssh.user,
      host: ssh.host,
      port: ssh.port || defaultSshPort,
      identityFile: ssh.identityFile || undefined,
      remoteCoreHost: ssh.remoteCoreHost || "127.0.0.1",
      remoteCorePort: ssh.remoteCorePort || defaultCorePort,
      autoStartRemoteCore: ssh.autoStartRemoteCore,
    },
  }).finally(() => {
    startingTunnels.delete(connection.id);
  });

  startingTunnels.set(connection.id, start);
  return start;
}

function isUsableTunnelStatus(status: SshTunnelStatus | null): status is SshTunnelStatus {
  return Boolean(status?.ok && status.running && status.localPort && status.effectiveCoreApiUrl);
}
