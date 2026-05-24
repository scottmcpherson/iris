import {
  activeCoreConnection,
  connectionIdFromParts,
  defaultCorePort,
  defaultSshPort,
} from "../../app/runtimeConfig";
import type { HermesRuntimeConfig, IrisCoreConnectionProfile } from "../../types/hermes";

export type SshAuthMode = "none" | "identity";

export type SshDraft = {
  id: string;
  name: string;
  hostname: string;
  port: string;
  authMode: SshAuthMode;
  identityFile: string;
};

export function emptySshDraft(): SshDraft {
  return {
    id: "",
    name: "",
    hostname: "",
    port: "",
    authMode: "none",
    identityFile: "",
  };
}

export function sshDraftFromConfig(config: HermesRuntimeConfig): SshDraft {
  const active = activeCoreConnection(config);
  const profile = active.mode === "ssh"
    ? active
    : config.coreConnections.find((connection) => connection.mode === "ssh");
  const ssh = profile?.ssh;
  const authMode: SshAuthMode = ssh?.identityFile ? "identity" : "none";
  return {
    id: profile?.id || "",
    name: profile?.name || "",
    hostname: sshTargetLabel(ssh?.user || "", ssh?.host || ""),
    port: ssh?.port && ssh.port !== defaultSshPort ? String(ssh.port) : "",
    authMode,
    identityFile: ssh?.identityFile || "",
  };
}

export function sshProfileFromDraft(
  draft: SshDraft,
  tunnel: { localPort: number; effectiveCoreApiUrl: string },
  savedProfile?: IrisCoreConnectionProfile,
): IrisCoreConnectionProfile | null {
  const endpoint = savedProfile?.ssh
    ? { user: savedProfile.ssh.user, host: savedProfile.ssh.host }
    : parseSshHostname(draft.hostname);
  if (!endpoint.host) return null;
  const sshPort = savedProfile?.ssh?.port || parsePort(draft.port, defaultSshPort);
  const identityFile = savedProfile?.ssh?.identityFile || (draft.authMode === "identity" ? draft.identityFile.trim() : "");
  const id = savedProfile?.id || draft.id || connectionIdFromParts("ssh", [endpoint.user, endpoint.host, sshPort]);
  return {
    id,
    name: savedProfile?.name || draft.name.trim() || endpoint.host || "Remote host",
    mode: "ssh",
    effectiveCoreApiUrl: tunnel.effectiveCoreApiUrl,
    ssh: {
      user: endpoint.user,
      host: endpoint.host,
      port: sshPort,
      identityFile: identityFile || undefined,
      remoteCoreHost: "127.0.0.1",
      remoteCorePort: defaultCorePort,
      localForwardPort: tunnel.localPort || "auto",
      autoStartRemoteCore: false,
    },
  };
}

export function sshTunnelConfigFromDraft(draft: SshDraft, savedProfile?: IrisCoreConnectionProfile) {
  const endpoint = savedProfile?.ssh
    ? { user: savedProfile.ssh.user, host: savedProfile.ssh.host }
    : parseSshHostname(draft.hostname);
  if (!endpoint.host) return null;
  const sshPort = savedProfile?.ssh?.port || parsePort(draft.port, defaultSshPort);
  const identityFile = savedProfile?.ssh?.identityFile || (draft.authMode === "identity" ? draft.identityFile.trim() : "");
  return {
    connectionId: savedProfile?.id || draft.id || connectionIdFromParts("ssh", [endpoint.user, endpoint.host, sshPort]),
    user: endpoint.user,
    host: endpoint.host,
    port: sshPort,
    identityFile: identityFile || undefined,
    remoteCoreHost: "127.0.0.1",
    remoteCorePort: defaultCorePort,
    autoStartRemoteCore: false,
  };
}

export function parsePort(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

export function parseSshHostname(value: string) {
  const trimmed = value.trim();
  const at = trimmed.lastIndexOf("@");
  if (at > 0 && at < trimmed.length - 1) {
    return {
      user: trimmed.slice(0, at).trim(),
      host: trimmed.slice(at + 1).trim(),
    };
  }
  return { user: "", host: trimmed };
}

export function sshTargetLabel(user: string, host: string) {
  const cleanUser = user.trim();
  const cleanHost = host.trim();
  if (!cleanHost) return "";
  return cleanUser ? `${cleanUser}@${cleanHost}` : cleanHost;
}
