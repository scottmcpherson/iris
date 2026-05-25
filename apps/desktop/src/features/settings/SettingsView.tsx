import "./settings.css";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ChevronDown,
  FileText,
  Network,
  Plug,
  RotateCw,
  Server,
  Smartphone,
  Unplug,
  Wrench,
} from "lucide-react";
import {
  activateCoreConnection,
  activeCoreConnection,
  connectionTransport,
  defaultCorePort,
  managedLocalConnectionId,
  removeCoreConnection,
  resolveCoreApiUrl,
  upsertCoreConnection,
} from "../../app/runtimeConfig";
import { Alert, AlertDescription } from "../../shared/ui/alert";
import { Button } from "../../shared/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../shared/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../shared/ui/dropdown-menu";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "../../shared/ui/field";
import { Input } from "../../shared/ui/input";
import { Switch } from "../../shared/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../shared/ui/tabs";
import type {
  HermesRuntimeConfig,
  HermesStatus,
  IrisCoreConnectionMode,
  IrisCoreConnectionProfile,
} from "../../types/hermes";
import { TailscaleConnectDialog } from "../iris/TailscaleConnectDialog";
import { MobilePairingDialog } from "../mobile-pairing/MobilePairingDialog";

type SettingsViewProps = {
  status: HermesStatus | null;
  runtimeConfig: HermesRuntimeConfig;
  onRuntimeChange: (config: HermesRuntimeConfig) => void;
  onRefresh: () => void;
};

type CoreSidecarStatus = {
  ok: boolean;
  running: boolean;
  ready: boolean;
  startedByApp: boolean;
  version: string;
  clientVersion: string;
  bindHost: string;
  port: number;
  pid?: number;
  url: string;
  logPath: string;
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
  installLaunchAgent: boolean;
};

type SettingsConnectionTab = "managed-local" | "tailscale";

export function SettingsView({
  status,
  runtimeConfig,
  onRuntimeChange,
  onRefresh,
}: SettingsViewProps) {
  const activeConnection = activeCoreConnection(runtimeConfig);
  const [modeTab, setModeTab] = useState<SettingsConnectionTab>(() => settingsTabFromMode(runtimeConfig.connectionMode));
  const [localDraft, setLocalDraft] = useState(() => localDraftFromProfile(activeConnection));
  const [tailscaleDialogOpen, setTailscaleDialogOpen] = useState(false);
  const [mobilePairingOpen, setMobilePairingOpen] = useState(false);
  const [sidecarStatus, setSidecarStatus] = useState<CoreSidecarStatus | null>(null);
  const [busyAction, setBusyAction] = useState("");
  const checkedAt = status?.checkedAt ? formatTimestamp(status.checkedAt) : "Not checked";
  const statusConnection = status?.activeConnectionName || activeConnection.name;
  const tailscaleProfiles = useMemo(
    () => runtimeConfig.coreConnections.filter((connection) => connection.mode === "tailscale"),
    [runtimeConfig.coreConnections],
  );
  const remoteAccessOn = Boolean(sidecarStatus && !isLoopbackBind(sidecarStatus.bindHost));
  const coreManagedByApp = Boolean(sidecarStatus?.startedByApp);
  const coreHost = remoteAccessOn ? "0.0.0.0" : "127.0.0.1";

  useEffect(() => {
    const connection = activeCoreConnection(runtimeConfig);
    setModeTab(settingsTabFromMode(runtimeConfig.connectionMode));
    setLocalDraft(localDraftFromProfile(connection.mode === "managed-local" ? connection : managedProfile(runtimeConfig)));
  }, [runtimeConfig]);

  useEffect(() => {
    void refreshSidecarStatus();
  }, []);

  async function refreshSidecarStatus() {
    try {
      const result = await invoke<CoreSidecarStatus>("core_sidecar_status");
      setSidecarStatus(result);
    } catch {
      setSidecarStatus(null);
    }
  }

  async function setRemoteAccess(next: boolean) {
    await withBusy("remote-access", async () => {
      try {
        await invoke("core_set_remote_access", { allow: next });
        const result = await invoke<CoreSidecarStatus>("core_sidecar_restart", {
          config: {
            host: next ? "0.0.0.0" : "127.0.0.1",
            port: parsePort(localDraft.port, defaultCorePort),
            hermesHome: localDraft.hermesHome.trim() || undefined,
            autoStart: true,
          },
        });
        setSidecarStatus(result);
        if (result.ready) {
          toast.success(next ? "Other devices can now reach this Mac over Tailscale." : "Iris Core is now local-only.");
        } else {
          toast.error(result.error || "Could not update the Iris Core binding.");
        }
        onRefresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not update remote access.");
      }
    });
  }

  async function withBusy(action: string, run: () => Promise<void>) {
    setBusyAction(action);
    try {
      await run();
    } finally {
      setBusyAction("");
    }
  }

  function commitProfile(profile: IrisCoreConnectionProfile, activate = true) {
    const nextConfig = upsertCoreConnection(runtimeConfig, profile, { activate });
    onRuntimeChange(nextConfig);
    toast.success(`${profile.name} saved.`);
    return nextConfig;
  }

  function deleteProfile(connectionId: string) {
    const nextConfig = removeCoreConnection(runtimeConfig, connectionId);
    onRuntimeChange(nextConfig);
    toast.success("Connection profile removed.");
  }

  async function saveLocalProfile() {
    const port = parsePort(localDraft.port, defaultCorePort);
    const profile: IrisCoreConnectionProfile = {
      id: managedLocalConnectionId,
      name: "Local",
      mode: "managed-local",
      effectiveCoreApiUrl: `http://127.0.0.1:${port}`,
      local: {
        port,
        hermesHome: localDraft.hermesHome.trim() || undefined,
        autoStart: localDraft.autoStart,
        installLaunchAgent: localDraft.installLaunchAgent,
      },
    };
    commitProfile(profile);
  }

  async function startOrRestartCore(restart = false) {
    await withBusy(restart ? "core-restart" : "core-start", async () => {
      const config = localCoreConfig(localDraft, coreHost);
      const result = await invoke<CoreSidecarStatus>(restart ? "core_sidecar_restart" : "core_sidecar_start", { config });
      setSidecarStatus(result);
      if (result.ready) {
        toast.success("Managed Iris Core is running.");
      } else {
        toast.error(result.error || "Managed Iris Core is not ready.");
      }
      onRefresh();
    });
  }

  async function installCoreService() {
    await withBusy("service-install", async () => {
      const result = await invoke<CoreCliResult>("core_service_install", {
        config: localServiceConfig(localDraft, coreHost),
        replace: true,
      });
      if (result.ok) {
        toast.success("Iris Core will run at login locally.");
      } else {
        toast.error(result.error || result.stderr || "Core service install failed.");
      }
    });
  }

  async function uninstallCoreService() {
    await withBusy("service-uninstall", async () => {
      const result = await invoke<CoreCliResult>("core_service_uninstall", { config: localCoreConfig(localDraft, coreHost) });
      if (result.ok) {
        toast.success("Iris Core login service removed.");
      } else {
        toast.error(result.error || result.stderr || "Core service uninstall failed.");
      }
    });
  }

  async function openLogs() {
    await withBusy("open-logs", async () => {
      await invoke("open_core_logs");
      toast.success("Opened the Iris Core log location.");
    });
  }

  return (
    <div className="tool-view grid min-h-0 overflow-auto">
      <div className="settings-view-general grid gap-4 content-start w-[min(calc(100%-96px),var(--surface-reading-max))] mx-auto py-[30px]">
      <header className="grid gap-1.5 min-w-0">
        <h1 className="text-[28px] font-bold tracking-[-0.01em] leading-tight">Settings</h1>
        <p className="text-[13px] text-muted-foreground m-0">Configure connections, runtime, and service preferences.</p>
      </header>

      <div className="core-status-strip flex flex-wrap items-center gap-2.5 min-w-0 py-0.5" data-online={status?.connected ? "true" : "false"}>
        <span className={status?.connected ? "service-health-dot online" : "service-health-dot offline"} />
        <span className="core-status-strip-name">{statusConnection}</span>
        <span className="core-status-strip-sep" aria-hidden>·</span>
        <span className="core-status-strip-field">
          <strong>{status?.coreApiUrl || resolveCoreApiUrl(runtimeConfig)}</strong>
        </span>
        <span className="core-status-strip-sep" aria-hidden>·</span>
        <span className="core-status-strip-field">{transportLabel(activeConnection)}</span>
        <span className="core-status-strip-sep" aria-hidden>·</span>
        <span className="core-status-strip-field">
          Core <strong>{status?.version || "Unknown"}</strong>
        </span>
        <span className="flex-auto" />
        <span className="core-status-strip-checked">
          {status?.connected ? `Checked ${checkedAt}` : `Offline · ${checkedAt}`}
        </span>
        <Button
          variant="appNeutral"
          size="appSmall"
          onClick={() => setMobilePairingOpen(true)}
        >
          <Smartphone data-icon="inline-start" />
          Pair a device
        </Button>
        <Button
          variant="appNeutral"
          size="appSmall"
          disabled={busyAction === "open-logs"}
          onClick={() => void openLogs()}
        >
          <FileText data-icon="inline-start" />
          Logs
        </Button>
      </div>

      {status?.coreVersionStatus && !status.coreVersionStatus.ok ? (
        <Alert className="settings-notice">
          <AlertDescription>{status.error || "Version mismatch. Update the remote host so Iris Desktop and Iris Core match."}</AlertDescription>
        </Alert>
      ) : null}

      <Tabs value={modeTab} onValueChange={(value) => setModeTab(value as SettingsConnectionTab)} className="min-w-0">
        <TabsList>
          <TabsTrigger value="managed-local">
            <Server data-icon="inline-start" />
            Local
          </TabsTrigger>
          <TabsTrigger value="tailscale">
            <Network data-icon="inline-start" />
            Tailscale
          </TabsTrigger>
        </TabsList>

        <TabsContent value="managed-local">
          <Card className="settings-mode-card">
            <CardHeader>
              <CardTitle>Local</CardTitle>
              <CardDescription>Iris Core runs locally and uses local Hermes.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3.5">
              <FieldSet className="grid gap-2.5 min-w-0 p-0 border-0">
                <h3 className="settings-form-group-title">Connection</h3>
                <FieldGroup className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-2 min-w-0">
                  <TextField id="local-port" label="Core port" value={localDraft.port} onChange={(port) => setLocalDraft({ ...localDraft, port })} />
                  <TextField id="local-hermes-home" label="Hermes home" value={localDraft.hermesHome} placeholder="~/.hermes" onChange={(hermesHome) => setLocalDraft({ ...localDraft, hermesHome })} />
                </FieldGroup>
              </FieldSet>
              <FieldSet className="grid gap-2.5 min-w-0 p-0 border-0">
                <h3 className="settings-form-group-title">Startup</h3>
                <FieldGroup className="gap-2.5">
                  <SwitchField
                    id="local-autostart"
                    label="Start managed Core when Iris opens"
                    description="Spawns the Iris Core sidecar as soon as the desktop app launches."
                    checked={localDraft.autoStart}
                    onCheckedChange={(autoStart) => setLocalDraft({ ...localDraft, autoStart })}
                  />
                  <SwitchField
                    id="local-login"
                    label="Run Core at login"
                    description="Installs a LaunchAgent so Core stays available even when Iris isn't open."
                    checked={localDraft.installLaunchAgent}
                    onCheckedChange={(installLaunchAgent) => setLocalDraft({ ...localDraft, installLaunchAgent })}
                  />
                  <SwitchField
                    id="local-remote-access"
                    label="Allow other devices to connect over Tailscale"
                    description={
                      coreManagedByApp
                        ? "Binds Iris Core to your tailnet so paired phones and desktops can reach this Mac. Off keeps Core on this Mac only."
                        : "In development, Core is started by the dev server — run `npm run dev:mobile-pairing` to host over Tailscale. The packaged app uses this switch."
                    }
                    checked={remoteAccessOn}
                    disabled={!coreManagedByApp || busyAction === "remote-access"}
                    onCheckedChange={(next) => void setRemoteAccess(next)}
                  />
                </FieldGroup>
              </FieldSet>
            </CardContent>
            <CardFooter className="flex-wrap items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="appNeutral" size="appSmall">
                    <Wrench data-icon="inline-start" />
                    Service management
                    <ChevronDown data-icon="inline-end" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" sideOffset={6} className="min-w-[208px]">
                  <DropdownMenuItem disabled={busyAction === "core-restart"} onSelect={() => void startOrRestartCore(true)}>
                    <RotateCw />
                    Restart Core
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={busyAction === "service-install"} onSelect={() => void installCoreService()}>
                    <Server />
                    Install login service
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" disabled={busyAction === "service-uninstall"} onSelect={() => void uninstallCoreService()}>
                    <Unplug />
                    Remove login service
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <span className="flex-auto" />
              <Button size="appSmall" onClick={() => void saveLocalProfile()}>
                <Plug data-icon="inline-start" />
                Save
              </Button>
            </CardFooter>
            {sidecarStatus ? (
              <div className="settings-runtime-row">
                <span className={`settings-runtime-pill ${sidecarStatus.ready ? "online" : "offline"}`}>
                  <span className={`service-health-dot ${sidecarStatus.ready ? "online" : "offline"}`} />
                  {sidecarStatus.ready ? "Managed Core running" : sidecarStatus.error || "Managed Core offline"}
                </span>
                <span className="settings-runtime-field">
                  Sidecar <strong>{sidecarStatus.version || "Unknown"}</strong>
                </span>
                {sidecarStatus.pid ? (
                  <span className="settings-runtime-field">
                    PID <strong>{sidecarStatus.pid}</strong>
                  </span>
                ) : null}
              </div>
            ) : null}
          </Card>
        </TabsContent>

        <TabsContent value="tailscale">
          <Card className="settings-mode-card">
            <CardHeader>
              <div>
                <CardTitle>Tailscale connections</CardTitle>
                <CardDescription>Connect to another machine running Iris Core on your tailnet.</CardDescription>
              </div>
              <CardAction>
                <Button size="appSmall" onClick={() => setTailscaleDialogOpen(true)}>
                  <Network data-icon="inline-start" />
                  Connect a host
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="grid gap-3.5">
              <ConnectionList
                profiles={tailscaleProfiles}
                activeId={activeConnection.id}
                connectedId={status?.connected ? activeConnection.id : ""}
                busy={false}
                onActivate={(id) => {
                  onRuntimeChange(activateCoreConnection(runtimeConfig, id));
                  onRefresh();
                }}
                onDelete={deleteProfile}
                onDisconnect={() => {
                  onRuntimeChange(activateCoreConnection(runtimeConfig, managedLocalConnectionId));
                  onRefresh();
                }}
              />
            </CardContent>
          </Card>
          <TailscaleConnectDialog
            open={tailscaleDialogOpen}
            runtimeConfig={runtimeConfig}
            onOpenChange={setTailscaleDialogOpen}
            onRuntimeChange={onRuntimeChange}
            onRefresh={onRefresh}
          />
        </TabsContent>
      </Tabs>
      <MobilePairingDialog
        open={mobilePairingOpen}
        runtimeConfig={runtimeConfig}
        onOpenChange={setMobilePairingOpen}
      />
      </div>
    </div>
  );
}

function ConnectionList({
  profiles,
  activeId,
  connectedId,
  busy,
  onActivate,
  onDelete,
  onDisconnect,
}: {
  profiles: IrisCoreConnectionProfile[];
  activeId: string;
  connectedId: string;
  busy: boolean;
  onActivate: (connectionId: string) => void;
  onDelete: (connectionId: string) => void;
  onDisconnect?: (connectionId: string) => void;
}) {
  if (!profiles.length) {
    return <p className="settings-empty-text">No saved profiles.</p>;
  }
  return (
    <div className="grid gap-2">
      {profiles.map((profile) => {
        const connected = profile.id === connectedId;
        const selected = profile.id === activeId;
        const switchId = `connection-${profile.id}`;
        return (
          <div className="connection-profile-row" key={profile.id} data-connected={connected ? "true" : "false"}>
            <div className="connection-profile-summary grid gap-[3px] min-w-0">
              <strong>{profile.name}</strong>
              <span>{profileSubtitle(profile)}</span>
            </div>
            <Field
              orientation="horizontal"
              className="connection-switch-field items-center justify-end gap-2.5 min-w-[142px]"
              data-disabled={busy ? "true" : undefined}
            >
              <FieldLabel htmlFor={switchId}>
                {connected ? "Connected" : selected ? "Offline" : "Disconnected"}
              </FieldLabel>
              <Switch
                id={switchId}
                checked={connected}
                disabled={busy}
                onCheckedChange={(checked) => {
                  if (checked) {
                    onActivate(profile.id);
                  } else {
                    onDisconnect?.(profile.id);
                  }
                }}
              />
            </Field>
            <Button variant="appDanger" size="appSmall" onClick={() => onDelete(profile.id)}>
              Delete
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  placeholder = "",
  type = "text",
  optional = false,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  type?: "text" | "password";
  optional?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>
        {label}
        {optional ? <span className="field-label-muted"> optional</span> : null}
      </FieldLabel>
      <Input id={id} type={type} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

function SwitchField({
  id,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Field orientation="horizontal" className="min-h-8 items-center">
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {description ? <FieldDescription>{description}</FieldDescription> : null}
      </FieldContent>
    </Field>
  );
}

function transportLabel(connection: IrisCoreConnectionProfile) {
  const transport = connectionTransport(connection);
  if (transport === "tailscale") return "Tailscale";
  return "Sidecar";
}

function profileSubtitle(profile: IrisCoreConnectionProfile) {
  if (profile.mode === "tailscale") {
    return profile.tailscale?.magicDnsName || profile.tailscale?.tailscaleIp || profile.effectiveCoreApiUrl;
  }
  return profile.effectiveCoreApiUrl;
}

function formatTimestamp(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value * 1000));
}

function managedProfile(config: HermesRuntimeConfig) {
  return config.coreConnections.find((connection) => connection.mode === "managed-local") || activeCoreConnection(config);
}

function settingsTabFromMode(mode: IrisCoreConnectionMode): SettingsConnectionTab {
  return mode === "managed-local" ? "managed-local" : "tailscale";
}

function localDraftFromProfile(profile: IrisCoreConnectionProfile): LocalDraft {
  const local = profile.local;
  return {
    port: String(local?.port || defaultCorePort),
    hermesHome: local?.hermesHome || "",
    autoStart: local?.autoStart !== false,
    installLaunchAgent: Boolean(local?.installLaunchAgent),
  };
}

function localCoreConfig(draft: LocalDraft, host: string) {
  return {
    host,
    port: parsePort(draft.port, defaultCorePort),
    hermesHome: draft.hermesHome.trim() || undefined,
    autoStart: draft.autoStart,
  };
}

function localServiceConfig(draft: LocalDraft, host: string) {
  return {
    host,
    port: parsePort(draft.port, defaultCorePort),
    hermesHome: draft.hermesHome.trim() || undefined,
    autoStart: draft.autoStart,
  };
}

function isLoopbackBind(host: string) {
  return ["", "localhost", "127.0.0.1", "::1", "[::1]"].includes(host.trim().toLowerCase());
}

function parsePort(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}
