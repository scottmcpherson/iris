import "./runtime.css";
import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  Copy,
  Plug,
  RefreshCw,
  Wrench,
} from "lucide-react";
import { DiagnosticRow, type DiagnosticRowAction } from "../../shared/ui/diagnostic-row";
import {
  activeCoreConnection,
  defaultCorePort,
} from "../../app/runtimeConfig";
import {
  runtimeAdapterIsReachable,
  runtimeGatewayIsReachable,
  runtimeReadinessForStatus,
  runtimeReadinessShortLabel,
  type RuntimeReadiness,
} from "../../app/runtimeReadiness";
import {
  getIrisCoreAgentForProfile,
  installIrisCoreAgentHermesPlugin,
  type IrisCoreInstallPluginResult,
} from "../../lib/irisCore";
import { Button } from "../../shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/dialog";
import type {
  HermesRuntimeConfig,
  HermesStatus,
  IrisCoreConnectionProfile,
} from "../../types/hermes";
import type { IrisCoreGatewayAction } from "../../lib/irisCore";

type RuntimeDiagnosticsDialogProps = {
  open: boolean;
  status: HermesStatus | null;
  selectedProfile: string;
  runtimeConfig: HermesRuntimeConfig;
  gatewayActionBusy: boolean;
  onOpenChange: (open: boolean) => void;
  onGatewayAction: (action: IrisCoreGatewayAction) => Promise<void> | void;
  onRefresh: () => void;
  onOpenSettings: () => void;
};

type CoreSidecarStatus = {
  ok: boolean;
  running: boolean;
  ready: boolean;
  startedByApp: boolean;
  error: string;
};

export function RuntimeDiagnosticsDialog({
  open,
  status,
  selectedProfile,
  runtimeConfig,
  gatewayActionBusy,
  onOpenChange,
  onGatewayAction,
  onRefresh,
  onOpenSettings,
}: RuntimeDiagnosticsDialogProps) {
  const connection = activeCoreConnection(runtimeConfig);
  const profile = useMemo(
    () =>
      status?.profiles.find((item) => item.name === selectedProfile) ||
      status?.activeProfile ||
      null,
    [status, selectedProfile],
  );
  const readiness: RuntimeReadiness = runtimeReadinessForStatus(status, profile);
  const coreOk = Boolean(status?.connected && status?.managementStatus?.ok);
  const adapterOk = runtimeAdapterIsReachable(status, profile);
  const gatewayOk = runtimeGatewayIsReachable(status, profile);
  const [busyAction, setBusyAction] = useState("");

  async function withBusy<T>(action: string, run: () => Promise<T>) {
    if (busyAction) return;
    setBusyAction(action);
    try {
      await run();
    } finally {
      setBusyAction("");
    }
  }

  async function startLocalCore(restart = false) {
    if (connection.mode !== "managed-local") return;
    await withBusy(restart ? "core-restart" : "core-start", async () => {
      try {
        const result = await invoke<CoreSidecarStatus>(restart ? "core_sidecar_restart" : "core_sidecar_start", {
          config: localCoreInvokeConfig(connection),
        });
        if (result.ready) {
          toast.success("Managed Iris Core is running.");
        } else {
          toast.error(result.error || "Managed Iris Core is not ready.");
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not start Iris Core.");
      }
      onRefresh();
    });
  }

  async function installPlugin({ restart }: { restart: boolean }) {
    await withBusy("plugin-install", async () => {
      let installedOk = false;
      try {
        if (!profile) throw new Error("Could not resolve Iris agent.");
        const agentResult = await getIrisCoreAgentForProfile(profile.name, runtimeConfig);
        if (!agentResult.ok || !agentResult.agent) {
          throw new Error(("error" in agentResult ? agentResult.error : "") || "Could not resolve Iris agent.");
        }
        const result = await installIrisCoreAgentHermesPlugin(agentResult.agent.id, runtimeConfig);
        const detail = pluginInstallSummary(result);
        installedOk = result.ok && detail.ok;
        if (installedOk) {
          toast.success(detail.message);
        } else {
          toast.error(detail.message);
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Iris could not install the Iris adapter.");
      }
      if (installedOk && restart) {
        try {
          await onGatewayAction("restart");
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Iris adapter installed, but the gateway could not be restarted.");
        }
      }
      onRefresh();
    });
  }

  async function runGateway(action: IrisCoreGatewayAction) {
    await withBusy(`gateway-${action}`, async () => {
      await onGatewayAction(action);
    });
  }

  function refreshAndClose() {
    onRefresh();
  }

  const installCommandHint = remoteInstallCommandHint(connection);
  const restartGatewayBusy = busyAction === "gateway-restart" || gatewayActionBusy;
  const startGatewayBusy = busyAction === "gateway-start" || gatewayActionBusy;

  const coreAction: DiagnosticRowAction | null = !coreOk
    ? connection.mode === "tailscale"
      ? {
          label: "Recheck connection",
          icon: RefreshCw,
          disabled: false,
          onClick: () => onRefresh(),
        }
      : {
          label: busyAction === "core-start" ? "Starting Core…" : "Start Iris Core",
          icon: Plug,
          disabled: busyAction === "core-start",
          onClick: () => void startLocalCore(false),
        }
    : null;

  const gatewayAction: DiagnosticRowAction | null = coreOk && !gatewayOk
    ? {
        label: busyAction === "gateway-start" ? "Starting gateway…" : "Start gateway",
        icon: Plug,
        disabled: startGatewayBusy,
        onClick: () => void runGateway("start"),
      }
    : null;

  const adapterAction: DiagnosticRowAction | null = coreOk && !adapterOk
    ? {
        label: busyAction === "plugin-install"
          ? gatewayOk
            ? "Installing & restarting..."
            : "Installing..."
          : "Install adapter",
        icon: Wrench,
        disabled: busyAction === "plugin-install" || (gatewayOk && restartGatewayBusy),
        onClick: () => void installPlugin({ restart: gatewayOk }),
      }
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(520px,calc(100vw-56px))] grid gap-[14px]">
        <DialogHeader>
          <DialogDescription>Runtime diagnostics</DialogDescription>
          <DialogTitle>{runtimeReadinessShortLabel(readiness)}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-2">
          <DiagnosticRow
            label="Iris Core"
            sublabel={connectionSummary(connection, status)}
            ok={coreOk}
            tone={coreOk ? "ready" : "offline"}
            action={coreAction}
          />
          <DiagnosticRow
            label={`Hermes gateway (${selectedProfile})`}
            ok={gatewayOk}
            tone={gatewayOk ? "ready" : "degraded"}
            action={gatewayAction}
          />
          <DiagnosticRow
            label="Iris adapter"
            ok={adapterOk}
            tone={adapterOk ? "ready" : "degraded"}
            action={adapterAction}
          />
        </div>

        {installCommandHint && !adapterOk ? (
          <RemoteCommandHint
            label="If automatic install fails, run on the remote host:"
            command={installCommandHint}
          />
        ) : null}
        {!coreOk && connection.mode === "tailscale" ? (
          <RemoteCommandHint
            label="Make sure Tailscale is connected and Iris Core is running on the host:"
            command={remoteCoreStartHint(connection)}
          />
        ) : null}

        <DialogFooter className="flex justify-end gap-2">
          <Button
            variant="appNeutral"
            size="appSmall"
            onClick={() => {
              onOpenSettings();
              onOpenChange(false);
            }}
          >
            Open Settings
          </Button>
          <Button variant="appNeutral" size="appSmall" onClick={refreshAndClose}>
            <RefreshCw data-icon="inline-start" />
            Refresh
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RemoteCommandHint({ label, command }: { label: string; command: string }) {
  if (!command) return null;
  return (
    <div className="diagnostics-remote-hint">
      <p>{label}</p>
      <div className="flex items-center gap-2 flex-wrap">
        <code>{command}</code>
        <Button
          variant="appNeutral"
          size="appSmall"
          onClick={() => {
            void navigator.clipboard?.writeText(command);
            toast.success("Command copied.");
          }}
        >
          <Copy data-icon="inline-start" />
          Copy
        </Button>
      </div>
    </div>
  );
}

function localCoreInvokeConfig(connection: IrisCoreConnectionProfile) {
  const local = connection.local;
  return {
    host: "127.0.0.1",
    port: local?.port || defaultCorePort,
    hermesHome: local?.hermesHome?.trim() || undefined,
    autoStart: local?.autoStart !== false,
  };
}

function pluginInstallSummary(result: IrisCoreInstallPluginResult) {
  if (!result?.ok) {
    return {
      ok: false,
      message: result?.error || "Iris adapter install failed.",
    };
  }
  if (result.enabled === false) {
    return {
      ok: false,
      message:
        result.enableError ||
        "Iris adapter files were copied, but Hermes did not enable them. Run `hermes plugins enable iris-platform` on the host.",
    };
  }
  return {
    ok: true,
    message: result.restartRequired
      ? "Iris adapter installed. Restart the gateway to load it."
      : "Iris adapter installed.",
  };
}

function connectionSummary(connection: IrisCoreConnectionProfile, status: HermesStatus | null) {
  const url = status?.coreApiUrl || connection.effectiveCoreApiUrl;
  const transport = connection.mode === "tailscale" ? "Tailscale" : "Local";
  return url ? `${transport} · ${url}` : transport;
}

function remoteInstallCommandHint(connection: IrisCoreConnectionProfile) {
  if (connection.mode !== "tailscale") return "";
  return "iris-core install-hermes-plugin";
}

function remoteCoreStartHint(connection: IrisCoreConnectionProfile) {
  if (connection.mode !== "tailscale") return "";
  return "iris-core";
}
