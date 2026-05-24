import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  activateCoreConnection,
  activeCoreConnection,
  managedLocalConnectionId,
  upsertCoreConnection,
} from "../../app/runtimeConfig";
import type { HermesRuntimeConfig, IrisCoreConnectionProfile } from "../../types/hermes";
import {
  sshDraftFromConfig,
  sshProfileFromDraft,
  sshTunnelConfigFromDraft,
} from "./sshConnectionDraft";
import type { SshTunnelStatus } from "./sshRuntime";

export type SshConnectionResult = {
  ok: boolean;
  profile?: IrisCoreConnectionProfile;
  status?: SshTunnelStatus;
  error?: string;
  errorKind?: string;
};

type UseSshConnectionManagerOptions = {
  runtimeConfig: HermesRuntimeConfig;
  onRuntimeChange: (config: HermesRuntimeConfig) => void;
  onRefresh?: () => void;
  toastResults?: boolean;
  invokeCommand?: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
};

export function useSshConnectionManager({
  runtimeConfig,
  onRuntimeChange,
  onRefresh,
  toastResults = true,
  invokeCommand = invoke,
}: UseSshConnectionManagerOptions) {
  const activeConnection = activeCoreConnection(runtimeConfig);
  const [draft, setDraft] = useState(() => sshDraftFromConfig(runtimeConfig));
  const [busyAction, setBusyAction] = useState("");
  const [lastResult, setLastResult] = useState<SshConnectionResult | null>(null);

  useEffect(() => {
    setDraft(sshDraftFromConfig(runtimeConfig));
  }, [runtimeConfig]);

  async function connectSsh(savedProfile?: IrisCoreConnectionProfile, draftOverride = draft) {
    setBusyAction("ssh-connect");
    try {
      const tunnelConfig = sshTunnelConfigFromDraft(draftOverride, savedProfile);
      if (!tunnelConfig) {
        const result = {
          ok: false,
          error: "Enter an SSH host, like remote-host.local or user@remote-host.local.",
          errorKind: "missing-host",
        };
        setLastResult(result);
        if (toastResults) toast.error(result.error);
        return result;
      }

      const status = await invokeCommand<SshTunnelStatus>("ssh_tunnel_start", { config: tunnelConfig });
      if (!status.ok) {
        const result = {
          ok: false,
          status,
          error: status.error || sshErrorCopy(status.errorKind),
          errorKind: status.errorKind,
        };
        setLastResult(result);
        if (toastResults) toast.error(result.error);
        return result;
      }

      const profile = sshProfileFromDraft(draftOverride, status, savedProfile);
      if (!profile) {
        const result = { ok: false, status, error: "SSH connection details are missing.", errorKind: "missing-host" };
        setLastResult(result);
        if (toastResults) toast.error(result.error);
        return result;
      }

      onRuntimeChange(upsertCoreConnection(runtimeConfig, profile, { activate: true }));
      const result = { ok: true, profile, status };
      setLastResult(result);
      if (toastResults) toast.success(`${profile.name} connected through a local SSH tunnel.`);
      return result;
    } catch (error) {
      const result = {
        ok: false,
        error: error instanceof Error ? error.message : "SSH tunnel connection failed.",
        errorKind: "invoke-failed",
      };
      setLastResult(result);
      if (toastResults) toast.error(result.error);
      return result;
    } finally {
      setBusyAction("");
    }
  }

  async function disconnectSsh(connectionId = draft.id) {
    setBusyAction("ssh-disconnect");
    try {
      const target = connectionId || activeConnection.id;
      const status = await invokeCommand<SshTunnelStatus>("ssh_tunnel_stop", { connectionId: target });
      if (!status.ok) {
        const result = {
          ok: false,
          status,
          error: status.error || "SSH tunnel disconnect failed.",
          errorKind: status.errorKind,
        };
        setLastResult(result);
        if (toastResults) toast.error(result.error);
        return result;
      }
      if (target === activeConnection.id) {
        onRuntimeChange(activateCoreConnection(runtimeConfig, managedLocalConnectionId));
      } else {
        onRefresh?.();
      }
      const result = { ok: true, status };
      setLastResult(result);
      if (toastResults) toast.success("SSH tunnel disconnected.");
      return result;
    } catch (error) {
      const result = {
        ok: false,
        error: error instanceof Error ? error.message : "SSH tunnel disconnect failed.",
        errorKind: "invoke-failed",
      };
      setLastResult(result);
      if (toastResults) toast.error(result.error);
      return result;
    } finally {
      setBusyAction("");
    }
  }

  return {
    busyAction,
    connectSsh,
    disconnectSsh,
    draft,
    lastResult,
    setDraft,
  };
}

function sshErrorCopy(errorKind?: string) {
  if (errorKind === "core-offline") {
    return "SSH connected, but Iris Core is not reachable on the remote host. Start Iris Core on that machine, then retry.";
  }
  if (errorKind === "unknown-host-key") {
    return "This SSH host is not trusted yet. Connect once in Terminal with ssh user@host, then retry.";
  }
  if (errorKind === "auth-failed") {
    return "SSH authentication failed. Add a key to ssh-agent or update your SSH config.";
  }
  return "Iris could not open the SSH tunnel.";
}
