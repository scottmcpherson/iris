import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, Plug, RefreshCw, Server, Terminal, Wrench, X } from "lucide-react";
import {
  activeCoreConnection,
  defaultCorePort,
  managedLocalConnectionId,
  upsertCoreConnection,
} from "../../app/runtimeConfig";
import type { HermesRuntimeConfig, HermesStatus, IrisCoreConnectionProfile } from "../../types/hermes";
import { Alert, AlertDescription } from "../../shared/ui/alert";
import { Button } from "../../shared/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../shared/ui/card";
import { Field, FieldGroup, FieldLabel } from "../../shared/ui/field";
import { Input } from "../../shared/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/dialog";
import { SshConnectionDialog } from "../iris/SshConnectionDialog";
import { useSshConnectionManager } from "../iris/useSshConnectionManager";

type OnboardingOverlayProps = {
  connected: boolean;
  status: HermesStatus | null;
  runtimeConfig: HermesRuntimeConfig;
  onClose: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  onRuntimeChange: (config: HermesRuntimeConfig) => void;
};

type CoreSidecarStatus = {
  ready: boolean;
  version: string;
  port: number;
  error: string;
};

type CoreCliResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  error: string;
};

type LocalDraft = {
  port: string;
  hermesHome: string;
  autoStart: boolean;
};

type SetupPath = "choose" | "local" | "ssh";

type StepStatus = "done" | "pending" | "action";

type SetupRow = {
  label: string;
  detail: string;
  status: StepStatus;
};

export function OnboardingOverlay({
  connected,
  status,
  runtimeConfig,
  onClose,
  onOpenSettings,
  onRefresh,
  onRuntimeChange,
}: OnboardingOverlayProps) {
  const [path, setPath] = useState<SetupPath>("choose");
  const [sshDialogOpen, setSshDialogOpen] = useState(false);
  const [localBusy, setLocalBusy] = useState("");
  const [localMessage, setLocalMessage] = useState("");
  const [localDraft, setLocalDraft] = useState(() => localDraftFromConfig(runtimeConfig));
  const sshManager = useSshConnectionManager({
    runtimeConfig,
    onRuntimeChange,
    onRefresh,
    toastResults: false,
  });
  const activeConnection = activeCoreConnection(runtimeConfig);
  const localRows = useMemo(() => localStatusRows(status, connected), [status, connected]);
  const sshRows = useMemo(() => sshStatusRows(status, activeConnection), [status, activeConnection]);

  useEffect(() => {
    setLocalDraft(localDraftFromConfig(runtimeConfig));
  }, [runtimeConfig]);

  async function saveLocalProfile() {
    const profile: IrisCoreConnectionProfile = {
      id: managedLocalConnectionId,
      name: "Local",
      mode: "managed-local",
      effectiveCoreApiUrl: `http://127.0.0.1:${parsePort(localDraft.port, defaultCorePort)}`,
      local: {
        port: parsePort(localDraft.port, defaultCorePort),
        hermesHome: localDraft.hermesHome.trim() || undefined,
        autoStart: localDraft.autoStart,
        installLaunchAgent: false,
        allowSshTunnel: true,
      },
    };
    onRuntimeChange(upsertCoreConnection(runtimeConfig, profile, { activate: true }));
  }

  async function startLocalCore(restart = false) {
    setLocalBusy(restart ? "core-restart" : "core-start");
    setLocalMessage("");
    try {
      await saveLocalProfile();
      const result = await invoke<CoreSidecarStatus>(restart ? "core_sidecar_restart" : "core_sidecar_start", {
        config: localCoreConfig(localDraft),
      });
      setLocalMessage(result.ready ? "Managed Iris Core is running." : result.error || "Managed Iris Core is not ready.");
      onRefresh();
    } catch (error) {
      setLocalMessage(error instanceof Error ? error.message : "Could not start managed Iris Core.");
    } finally {
      setLocalBusy("");
    }
  }

  async function installHermesPlugin() {
    setLocalBusy("plugin-install");
    setLocalMessage("");
    try {
      const result = await invoke<CoreCliResult>("core_install_hermes_plugin", { config: localCoreConfig(localDraft) });
      setLocalMessage(
        result.ok
          ? "Iris adapter installed. Restart Hermes gateway, then retry readiness."
          : result.error || result.stderr || "Iris adapter install failed.",
      );
    } catch (error) {
      setLocalMessage(error instanceof Error ? error.message : "Iris adapter install failed.");
    } finally {
      setLocalBusy("");
    }
  }

  const sshError = sshManager.lastResult?.ok === false ? sshManager.lastResult.error : "";
  const isChoose = path === "choose";
  const rows = path === "ssh" ? sshRows : localRows;
  const readyCount = rows.filter((row) => row.status === "done").length;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="onboarding-card" showCloseButton={false}>
        <Button variant="appIcon" size="icon-md" className="onboarding-close" title="Close onboarding" onClick={onClose}>
          <X size={15} />
        </Button>

        {isChoose ? (
          <DialogHeader className="onboarding-heading">
            <p className="eyebrow">First run</p>
            <DialogTitle>Connect Iris to Hermes</DialogTitle>
            <DialogDescription className="onboarding-copy">
              Choose where Iris Core and Hermes are running.
            </DialogDescription>
          </DialogHeader>
        ) : (
          <DialogHeader className="onboarding-heading compact">
            <button
              type="button"
              className="onboarding-back-link"
              onClick={() => setPath("choose")}
            >
              <ChevronLeft size={14} />
              Back
            </button>
            <div className="onboarding-compact-row">
              <DialogTitle>{path === "local" ? "Local Hermes" : "Hermes via SSH"}</DialogTitle>
              <span className="onboarding-progress">{readyCount} of {rows.length} ready</span>
            </div>
            <DialogDescription className="sr-only">
              {path === "local" ? "Set up Iris Core and Hermes on this machine." : "Connect to a remote host that runs Iris Core and Hermes."}
            </DialogDescription>
          </DialogHeader>
        )}

        {isChoose ? (
          <div className="onboarding-path-grid">
            <Card className="onboarding-path-card" onClick={() => setPath("local")}>
              <CardHeader>
                <Server />
                <CardTitle>Local Hermes</CardTitle>
                <CardDescription>Iris Core and Hermes run on this machine.</CardDescription>
              </CardHeader>
              <CardContent>
                <Button size="appSmall">
                  <Plug data-icon="inline-start" />
                  Set up local
                </Button>
              </CardContent>
            </Card>
            <Card className="onboarding-path-card" onClick={() => setPath("ssh")}>
              <CardHeader>
                <Terminal />
                <CardTitle>Hermes via SSH</CardTitle>
                <CardDescription>Connect to a remote host that runs Iris Core and Hermes.</CardDescription>
              </CardHeader>
              <CardContent>
                <Button size="appSmall">
                  <Terminal data-icon="inline-start" />
                  Set up SSH
                </Button>
              </CardContent>
            </Card>
          </div>
        ) : null}

        {path === "local" ? (
          <div className="onboarding-setup-panel">
            <FieldGroup className="onboarding-local-fields">
              <Field>
                <FieldLabel htmlFor="onboarding-hermes-home">Hermes home</FieldLabel>
                <Input
                  id="onboarding-hermes-home"
                  value={localDraft.hermesHome}
                  placeholder="~/.hermes"
                  onChange={(event) => setLocalDraft({ ...localDraft, hermesHome: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="onboarding-core-port">Core port</FieldLabel>
                <Input
                  id="onboarding-core-port"
                  value={localDraft.port}
                  placeholder={String(defaultCorePort)}
                  onChange={(event) => setLocalDraft({ ...localDraft, port: event.target.value })}
                />
              </Field>
            </FieldGroup>
            <ol className="setup-steps">
              {localRows.map((row, index) => (
                <SetupStep key={row.label} index={index + 1} {...row} />
              ))}
            </ol>
            {localMessage ? (
              <Alert className="onboarding-inline-alert">
                <AlertDescription>{localMessage}</AlertDescription>
              </Alert>
            ) : null}
            <div className="onboarding-actions">
              <button type="button" className="onboarding-footer-link" onClick={onOpenSettings}>
                Open Settings
              </button>
              <div className="onboarding-actions-group">
                <Button variant="appGhost" size="appSmall" onClick={onRefresh}>
                  <RefreshCw data-icon="inline-start" />
                  Check again
                </Button>
                <Button variant="appNeutral" size="appSmall" disabled={Boolean(localBusy)} onClick={() => void installHermesPlugin()}>
                  <Wrench data-icon="inline-start" />
                  Install Iris adapter
                </Button>
                <Button size="appSmall" disabled={Boolean(localBusy)} onClick={() => void startLocalCore()}>
                  <Server data-icon="inline-start" />
                  Start Core
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {path === "ssh" ? (
          <div className="onboarding-setup-panel">
            <ol className="setup-steps">
              {sshRows.map((row, index) => (
                <SetupStep key={row.label} index={index + 1} {...row} />
              ))}
            </ol>
            {sshError ? (
              <Alert className="onboarding-inline-alert">
                <AlertDescription>{sshError}</AlertDescription>
              </Alert>
            ) : null}
            <p className="onboarding-remediation">
              If Iris Core is offline, start it on the remote host, keep it bound to 127.0.0.1, then retry the tunnel.
            </p>
            <div className="onboarding-actions">
              <button type="button" className="onboarding-footer-link" onClick={onOpenSettings}>
                Open Settings
              </button>
              <div className="onboarding-actions-group">
                <Button
                  variant="appNeutral"
                  size="appSmall"
                  disabled={sshManager.busyAction === "ssh-connect" || activeConnection.mode !== "ssh"}
                  onClick={() => {
                    if (activeConnection.mode === "ssh") void sshManager.connectSsh(activeConnection);
                  }}
                >
                  <RefreshCw data-icon="inline-start" />
                  Retry tunnel
                </Button>
                <Button size="appSmall" onClick={() => setSshDialogOpen(true)}>
                  <Terminal data-icon="inline-start" />
                  Add SSH connection
                </Button>
              </div>
            </div>
            <SshConnectionDialog
              open={sshDialogOpen}
              draft={sshManager.draft}
              busy={sshManager.busyAction === "ssh-connect"}
              onOpenChange={setSshDialogOpen}
              onDraftChange={sshManager.setDraft}
              onSave={() => {
                void sshManager.connectSsh().then((result) => {
                  if (result.ok) setSshDialogOpen(false);
                });
              }}
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SetupStep({ index, label, detail, status }: { index: number; label: string; detail: string; status: StepStatus }) {
  return (
    <li className={`setup-step status-${status}`}>
      <span className="setup-step-marker" aria-hidden="true">
        {status === "done" ? "✓" : index}
      </span>
      <span className="setup-step-copy">
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
    </li>
  );
}

function stepStatus(complete: boolean, actionable: boolean): StepStatus {
  if (complete) return "done";
  return actionable ? "action" : "pending";
}

function safeModelLabel(model: string | undefined): string {
  if (!model) return "";
  const trimmed = model.trim();
  if (!trimmed || trimmed === "not configured") return "";
  if (trimmed.startsWith("{") || trimmed.includes("'provider'") || trimmed.includes('"provider"')) {
    return "Ready.";
  }
  return trimmed;
}

function localStatusRows(status: HermesStatus | null, connected: boolean): SetupRow[] {
  const coreReady = Boolean(status?.managementStatus?.ok || connected);
  const hermesHome = status?.hermesPath || status?.activeProfile?.path || "";
  const gatewayReady = Boolean(status?.gatewayStatus?.ok || status?.activeProfile?.gatewayRunning);
  const adapterReady = Boolean(status?.activeApiStatus?.ok);
  const modelLabel = safeModelLabel(status?.activeProfile?.model);
  const modelReady = Boolean(modelLabel);
  return [
    {
      label: "Iris Core",
      status: stepStatus(coreReady, true),
      detail: coreReady ? "Core is reachable." : "Start managed Core.",
    },
    {
      label: "Hermes home",
      status: stepStatus(Boolean(hermesHome), false),
      detail: hermesHome || "Choose the Hermes home path above.",
    },
    {
      label: "Hermes gateway",
      status: stepStatus(gatewayReady, false),
      detail: gatewayReady ? "Gateway responded." : "Restart Hermes gateway after changes.",
    },
    {
      label: "Iris adapter",
      status: stepStatus(adapterReady, true),
      detail: adapterReady ? "Adapter is reachable." : "Install or update the adapter.",
    },
    {
      label: "Model readiness",
      status: stepStatus(modelReady, false),
      detail: modelReady ? modelLabel : "Refresh after Hermes is ready.",
    },
  ];
}

function sshStatusRows(status: HermesStatus | null, activeConnection: IrisCoreConnectionProfile): SetupRow[] {
  const usingSsh = activeConnection.mode === "ssh";
  const tunnelReady = usingSsh && Boolean(status?.connected);
  const coreReady = usingSsh && Boolean(status?.managementStatus?.ok || status?.connected);
  const versionReady = usingSsh && status?.coreVersionStatus?.ok !== false;
  const gatewayReady = usingSsh && Boolean(status?.gatewayStatus?.ok || status?.activeProfile?.gatewayRunning);
  const adapterReady = usingSsh && Boolean(status?.activeApiStatus?.ok);
  return [
    {
      label: "SSH tunnel",
      status: stepStatus(tunnelReady, true),
      detail: usingSsh ? activeConnection.name : "Add an SSH connection.",
    },
    {
      label: "Remote Core",
      status: stepStatus(coreReady, false),
      detail: coreReady ? "Core is reachable through the tunnel." : "Start Iris Core on the remote host.",
    },
    {
      label: "Version match",
      status: stepStatus(versionReady, false),
      detail: versionReady ? "Desktop and Core versions match." : status?.error || "Update Iris on the remote host.",
    },
    {
      label: "Hermes gateway",
      status: stepStatus(gatewayReady, false),
      detail: gatewayReady ? "Gateway responded." : "Restart Hermes gateway on the remote host.",
    },
    {
      label: "Iris adapter",
      status: stepStatus(adapterReady, false),
      detail: adapterReady ? "Adapter is reachable." : "Install the adapter from the remote Core setup.",
    },
  ];
}

function localDraftFromConfig(config: HermesRuntimeConfig): LocalDraft {
  const profile = config.coreConnections.find((connection) => connection.mode === "managed-local");
  return {
    port: String(profile?.local?.port || defaultCorePort),
    hermesHome: profile?.local?.hermesHome || "",
    autoStart: profile?.local?.autoStart !== false,
  };
}

function localCoreConfig(draft: LocalDraft) {
  return {
    host: "127.0.0.1",
    port: parsePort(draft.port, defaultCorePort),
    hermesHome: draft.hermesHome.trim() || undefined,
    autoStart: draft.autoStart,
  };
}

function parsePort(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}
