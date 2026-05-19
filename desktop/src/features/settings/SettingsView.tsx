import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Database,
  FileText,
  LayoutPanelLeft,
  Plug,
  RefreshCw,
  RotateCw,
  Server,
  Terminal,
  Unplug,
  Wrench,
} from "lucide-react";
import {
  activeCoreConnection,
  connectionIdFromParts,
  connectionTransport,
  defaultCorePort,
  hermesOwner,
  managedLocalConnectionId,
  removeCoreConnection,
  resolveCoreApiUrl,
  upsertCoreConnection,
} from "../../app/runtimeConfig";
import type { ProfileAction, ProfileActionHandler } from "../../app/types";
import { endpointLabel } from "../../shared/format";
import { rawStringValue } from "../../shared/strings";
import { Alert, AlertDescription } from "../../shared/ui/alert";
import { Badge } from "../../shared/ui/badge";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../shared/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/dialog";
import {
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "../../shared/ui/field";
import { Input } from "../../shared/ui/input";
import { Switch } from "../../shared/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../shared/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "../../shared/ui/toggle-group";
import type {
  HermesProfile,
  HermesRuntimeConfig,
  HermesStatus,
  IrisCoreConnectionMode,
  IrisCoreConnectionProfile,
} from "../../types/hermes";

type SettingsViewProps = {
  status: HermesStatus | null;
  profile: HermesProfile;
  selectedProfile: string;
  runtimeConfig: HermesRuntimeConfig;
  mode: "settings" | "profile";
  onRuntimeChange: (config: HermesRuntimeConfig) => void;
  onRefresh: () => void;
  onProfileAction: ProfileActionHandler;
  onOpenSettings?: () => void;
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

type SshTunnelStatus = {
  ok: boolean;
  connectionId: string;
  running: boolean;
  localPort: number;
  effectiveCoreApiUrl: string;
  errorKind: string;
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
  allowSshTunnel: boolean;
};

type SshAuthMode = "none" | "identity";

type SshDraft = {
  id: string;
  name: string;
  hostname: string;
  port: string;
  authMode: SshAuthMode;
  identityFile: string;
};

type SettingsConnectionTab = "managed-local" | "ssh";

export function SettingsView({
  status,
  profile,
  selectedProfile,
  runtimeConfig,
  mode,
  onRuntimeChange,
  onRefresh,
  onProfileAction,
  onOpenSettings,
}: SettingsViewProps) {
  const activeConnection = activeCoreConnection(runtimeConfig);
  const [modeTab, setModeTab] = useState<SettingsConnectionTab>(() => settingsTabFromMode(runtimeConfig.connectionMode));
  const [profileName, setProfileName] = useState("");
  const [notice, setNotice] = useState("");
  const [localDraft, setLocalDraft] = useState(() => localDraftFromProfile(activeConnection));
  const [sshDraft, setSshDraft] = useState(() => sshDraftFromConfig(runtimeConfig));
  const [sshDialogOpen, setSshDialogOpen] = useState(false);
  const [sidecarStatus, setSidecarStatus] = useState<CoreSidecarStatus | null>(null);
  const [busyAction, setBusyAction] = useState("");
  const checkedAt = status?.checkedAt ? formatTimestamp(status.checkedAt) : "Not checked";
  const modelDisplay = modelSummary(profile.provider, profile.model);
  const statusConnection = status?.activeConnectionName || activeConnection.name;
  const profilesByMode = useMemo(
    () => ({
      ssh: runtimeConfig.coreConnections.filter((connection) => connection.mode === "ssh"),
    }),
    [runtimeConfig.coreConnections],
  );

  useEffect(() => {
    const connection = activeCoreConnection(runtimeConfig);
    setModeTab(settingsTabFromMode(runtimeConfig.connectionMode));
    setLocalDraft(localDraftFromProfile(connection.mode === "managed-local" ? connection : managedProfile(runtimeConfig)));
    setSshDraft(sshDraftFromConfig(runtimeConfig));
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

  async function withBusy(action: string, run: () => Promise<void>) {
    setBusyAction(action);
    setNotice("");
    try {
      await run();
    } finally {
      setBusyAction("");
    }
  }

  function commitProfile(profile: IrisCoreConnectionProfile, activate = true) {
    const nextConfig = upsertCoreConnection(runtimeConfig, profile, { activate });
    onRuntimeChange(nextConfig);
    setNotice(`${profile.name} saved.`);
    return nextConfig;
  }

  function deleteProfile(connectionId: string) {
    const nextConfig = removeCoreConnection(runtimeConfig, connectionId);
    onRuntimeChange(nextConfig);
    setNotice("Connection profile removed.");
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
        allowSshTunnel: localDraft.allowSshTunnel,
      },
    };
    commitProfile(profile);
  }

  async function startOrRestartCore(restart = false) {
    await withBusy(restart ? "core-restart" : "core-start", async () => {
      const config = localCoreConfig(localDraft);
      const result = await invoke<CoreSidecarStatus>(restart ? "core_sidecar_restart" : "core_sidecar_start", { config });
      setSidecarStatus(result);
      setNotice(result.ready ? "Managed Iris Core is running." : result.error || "Managed Iris Core is not ready.");
      onRefresh();
    });
  }

  async function installHermesPlugin() {
    await withBusy("plugin-install", async () => {
      const result = await invoke<CoreCliResult>("core_install_hermes_plugin", { config: localCoreConfig(localDraft) });
      setNotice(result.ok ? "Iris installed the Hermes plugin. Restart Hermes gateway." : result.error || result.stderr || "Plugin install failed.");
    });
  }

  async function installCoreService() {
    await withBusy("service-install", async () => {
      const result = await invoke<CoreCliResult>("core_service_install", {
        config: localServiceConfig(localDraft),
        replace: true,
      });
      setNotice(result.ok ? "Iris Core will run at login locally." : result.error || result.stderr || "Core service install failed.");
    });
  }

  async function uninstallCoreService() {
    await withBusy("service-uninstall", async () => {
      const result = await invoke<CoreCliResult>("core_service_uninstall", { config: localCoreConfig(localDraft) });
      setNotice(result.ok ? "Iris Core login service removed." : result.error || result.stderr || "Core service uninstall failed.");
    });
  }

  async function openLogs() {
    await withBusy("open-logs", async () => {
      await invoke("open_core_logs");
      setNotice("Opened the Iris Core log location.");
    });
  }

  async function connectSsh(savedProfile?: IrisCoreConnectionProfile) {
    await withBusy("ssh-connect", async () => {
      const endpoint = savedProfile?.ssh
        ? { user: savedProfile.ssh.user, host: savedProfile.ssh.host }
        : parseSshHostname(sshDraft.hostname);
      if (!endpoint.host) {
        setNotice("Enter an SSH hostname, like mac-mini.local or scott@mac-mini.local.");
        return;
      }
      const sshPort = savedProfile?.ssh?.port || parsePort(sshDraft.port, 22);
      const identityFile = savedProfile?.ssh?.identityFile || (sshDraft.authMode === "identity" ? sshDraft.identityFile.trim() : "");
      const baseId = savedProfile?.id || sshDraft.id || connectionIdFromParts("ssh", [endpoint.user, endpoint.host, sshPort]);
      const result = await invoke<SshTunnelStatus>("ssh_tunnel_start", {
        config: {
          connectionId: baseId,
          user: endpoint.user,
          host: endpoint.host,
          port: sshPort,
          identityFile: identityFile || undefined,
          remoteCoreHost: "127.0.0.1",
          remoteCorePort: defaultCorePort,
          autoStartRemoteCore: true,
        },
      });
      if (!result.ok) {
        setNotice(result.error);
        return;
      }
      const nextProfile: IrisCoreConnectionProfile = {
        id: baseId,
        name: savedProfile?.name || sshDraft.name.trim() || endpoint.host || "Remote Mac",
        mode: "ssh",
        effectiveCoreApiUrl: result.effectiveCoreApiUrl,
        ssh: {
          user: endpoint.user,
          host: endpoint.host,
          port: sshPort,
          identityFile: identityFile || undefined,
          remoteCoreHost: "127.0.0.1",
          remoteCorePort: defaultCorePort,
          localForwardPort: result.localPort || "auto",
          autoStartRemoteCore: true,
        },
      };
      commitProfile(nextProfile);
      setSshDialogOpen(false);
      setNotice(`${nextProfile.name} connected through a local SSH tunnel.`);
      onRefresh();
    });
  }

  async function disconnectSsh(connectionId = sshDraft.id) {
    await withBusy("ssh-disconnect", async () => {
      const target = connectionId || activeConnection.id;
      const result = await invoke<SshTunnelStatus>("ssh_tunnel_stop", { connectionId: target });
      setNotice(result.error || "SSH tunnel disconnected.");
    });
  }

  async function runProfileAction(action: ProfileAction) {
    const message = await onProfileAction(action, profileName);
    setNotice(message);
    if (action !== "switch") setProfileName("");
  }

  if (mode === "profile") {
    return (
      <div className="tool-view settings-view">
        <div className="settings-toolbar">
          <div>
            <h1>{profile.name}</h1>
            <span>Agent overview</span>
          </div>
          <Button variant="appNeutral" size="appSmall" onClick={onRefresh}>
            <RefreshCw data-icon="inline-start" />
            Refresh
          </Button>
        </div>

        <SettingsSection title="Iris Core status" variant="plain">
          <Card className="core-connection-form core-status-card">
            <CardHeader className="core-connection-heading">
              <CardTitle className="core-connection-title">
                <span className={status?.managementStatus?.ok ? "service-health-dot online" : "service-health-dot offline"} />
                Iris Core
              </CardTitle>
              <CardAction>
                <Badge variant={status?.managementStatus?.ok ? "secondary" : "outline"} title={endpointLabel(status?.managementStatus)}>
                  {healthLabel(status?.managementStatus)} · {checkedAt}
                </Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="settings-list compact">
              <SettingsRow icon={<LayoutPanelLeft />} label="Endpoint" value={status?.coreApiUrl || resolveCoreApiUrl(runtimeConfig)} />
              <SettingsRow icon={<Database />} label="Transport" value={transportLabel(activeConnection)} />
            </CardContent>
            {onOpenSettings ? (
              <CardFooter className="core-connection-actions">
                <Button size="appSmall" onClick={onOpenSettings}>
                  <Wrench data-icon="inline-start" />
                  Configure in Settings
                </Button>
              </CardFooter>
            ) : null}
          </Card>
        </SettingsSection>

        <section className="settings-section model-section">
          <div className="settings-section-header">
            <div>
              <h2>Runtime configuration</h2>
            </div>
          </div>
          <ModelCard summary={modelDisplay} rawModel={profile.model} provider={profile.provider} />
        </section>

        <div className="agent-metadata-strip">
          <SettingsRow icon={<LayoutPanelLeft />} label="Runtime" value={selectedProfile} />
          <SettingsRow icon={<Database />} label="Estimated cost" value={profile.estimatedCostUsd == null ? "Unavailable" : `$${profile.estimatedCostUsd.toFixed(4)}`} />
        </div>
        <ProfileWorkflows profileName={profileName} onProfileNameChange={setProfileName} onProfileAction={runProfileAction} />
        {notice ? <Notice message={notice} /> : null}
      </div>
    );
  }

  return (
    <div className="tool-view settings-view settings-view-general">
      <div className="settings-toolbar">
        <div>
          <h1>Settings</h1>
        </div>
        <Button variant="appNeutral" size="appSmall" onClick={onRefresh}>
          <RefreshCw data-icon="inline-start" />
          Refresh
        </Button>
      </div>

      <SettingsSection title="Iris Core" variant="plain">
        <Card className="core-connection-form">
          <CardHeader className="core-connection-heading">
            <div>
              <CardTitle className="core-connection-title">
                <span className={status?.connected ? "service-health-dot online" : "service-health-dot offline"} />
                {statusConnection}
              </CardTitle>
              <CardDescription>{modeStatusCopy(activeConnection)}</CardDescription>
            </div>
            <CardAction>
              <Badge variant={status?.connected ? "secondary" : "outline"}>
                {status?.connected ? "Connected" : "Offline"} · {checkedAt}
              </Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="core-status-grid">
            <StatusMetric label="Core version" value={status?.version || "Unknown"} />
            <StatusMetric label="Hermes host" value={ownerLabel(status?.hermesOwner || hermesOwner(activeConnection))} />
            <StatusMetric label="Transport" value={transportLabel(activeConnection)} />
            <StatusMetric label="Endpoint" value={status?.coreApiUrl || resolveCoreApiUrl(runtimeConfig)} />
          </CardContent>
        </Card>
      </SettingsSection>

      {status?.coreVersionStatus && !status.coreVersionStatus.ok ? (
        <Alert className="settings-notice">
          <AlertDescription>{status.error || "Version mismatch. Update the other Mac so Iris Desktop and Iris Core match."}</AlertDescription>
        </Alert>
      ) : null}

      <Tabs value={modeTab} onValueChange={(value) => setModeTab(value as SettingsConnectionTab)} className="core-mode-tabs">
        <TabsList>
          <TabsTrigger value="managed-local">
            <Server data-icon="inline-start" />
            Local
          </TabsTrigger>
          <TabsTrigger value="ssh">
            <Terminal data-icon="inline-start" />
            SSH
          </TabsTrigger>
        </TabsList>

        <TabsContent value="managed-local">
          <Card className="settings-mode-card">
            <CardHeader>
              <CardTitle>Local</CardTitle>
              <CardDescription>Iris Core runs locally and uses local Hermes.</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldSet>
                <FieldGroup className="settings-field-grid">
                  <TextField id="local-port" label="Core port" value={localDraft.port} onChange={(port) => setLocalDraft({ ...localDraft, port })} />
                  <TextField id="local-hermes-home" label="Hermes home" value={localDraft.hermesHome} placeholder="~/.hermes" onChange={(hermesHome) => setLocalDraft({ ...localDraft, hermesHome })} />
                </FieldGroup>
                <FieldGroup className="settings-switch-list">
                  <SwitchField id="local-autostart" label="Start managed Core when Iris opens" checked={localDraft.autoStart} onCheckedChange={(autoStart) => setLocalDraft({ ...localDraft, autoStart })} />
                  <SwitchField id="local-login" label="Run Core at login" checked={localDraft.installLaunchAgent} onCheckedChange={(installLaunchAgent) => setLocalDraft({ ...localDraft, installLaunchAgent })} />
                </FieldGroup>
              </FieldSet>
            </CardContent>
            <CardFooter className="settings-action-row">
              <Button size="appSmall" onClick={() => void saveLocalProfile()}>
                <Plug data-icon="inline-start" />
                Save
              </Button>
              <Button variant="appNeutral" size="appSmall" disabled={busyAction === "core-restart"} onClick={() => void startOrRestartCore(true)}>
                <RotateCw data-icon="inline-start" />
                Restart Core
              </Button>
              <Button variant="appNeutral" size="appSmall" disabled={busyAction === "plugin-install"} onClick={() => void installHermesPlugin()}>
                <Wrench data-icon="inline-start" />
                Install plugin
              </Button>
              <Button variant="appNeutral" size="appSmall" disabled={busyAction === "service-install"} onClick={() => void installCoreService()}>
                <Server data-icon="inline-start" />
                Install service
              </Button>
              <Button variant="appNeutral" size="appSmall" disabled={busyAction === "service-uninstall"} onClick={() => void uninstallCoreService()}>
                <Unplug data-icon="inline-start" />
                Remove service
              </Button>
              <Button variant="appNeutral" size="appSmall" disabled={busyAction === "open-logs"} onClick={() => void openLogs()}>
                <FileText data-icon="inline-start" />
                Logs
              </Button>
            </CardFooter>
            {sidecarStatus ? (
              <CardContent className="settings-substatus">
                <StatusMetric label="Managed Core" value={sidecarStatus.ready ? "Running" : sidecarStatus.error || "Offline"} />
                <StatusMetric label="Sidecar version" value={sidecarStatus.version || "Unknown"} />
              </CardContent>
            ) : null}
          </Card>
        </TabsContent>

        <TabsContent value="ssh">
          <Card className="settings-mode-card">
            <CardHeader>
              <div>
                <CardTitle>SSH connections</CardTitle>
                <CardDescription>Use any SSH hostname, including a Tailscale MagicDNS name.</CardDescription>
              </div>
              <CardAction>
                <Button size="appSmall" onClick={() => setSshDialogOpen(true)}>
                  <Terminal data-icon="inline-start" />
                  Add SSH connection
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="settings-mode-content">
              <ConnectionList
                profiles={profilesByMode.ssh}
                activeId={activeConnection.id}
                onActivate={(id) => {
                  const profile = runtimeConfig.coreConnections.find((connection) => connection.id === id);
                  if (profile) void connectSsh(profile);
                }}
                onDelete={deleteProfile}
                onDisconnect={(id) => void disconnectSsh(id)}
              />
            </CardContent>
          </Card>
          <SshConnectionDialog
            open={sshDialogOpen}
            draft={sshDraft}
            busy={busyAction === "ssh-connect"}
            onOpenChange={setSshDialogOpen}
            onDraftChange={setSshDraft}
            onSave={() => void connectSsh()}
          />
        </TabsContent>
      </Tabs>

      {notice ? <Notice message={notice} /> : null}
    </div>
  );
}

function ConnectionList({
  profiles,
  activeId,
  onActivate,
  onDelete,
  onDisconnect,
}: {
  profiles: IrisCoreConnectionProfile[];
  activeId: string;
  onActivate: (connectionId: string) => void;
  onDelete: (connectionId: string) => void;
  onDisconnect?: (connectionId: string) => void;
}) {
  if (!profiles.length) {
    return <p className="settings-empty-text">No saved profiles.</p>;
  }
  return (
    <div className="connection-profile-list">
      {profiles.map((profile) => (
        <div className="connection-profile-row" key={profile.id}>
          <div>
            <strong>{profile.name}</strong>
            <span>{profileSubtitle(profile)}</span>
          </div>
          <Badge variant={profile.id === activeId ? "secondary" : "outline"}>{profile.id === activeId ? "Active" : profile.mode}</Badge>
          <Button size="appSmall" onClick={() => onActivate(profile.id)}>
            <Plug data-icon="inline-start" />
            Connect
          </Button>
          {onDisconnect ? (
            <Button variant="appNeutral" size="appSmall" onClick={() => onDisconnect(profile.id)}>
              <Unplug data-icon="inline-start" />
              Disconnect
            </Button>
          ) : null}
          <Button variant="appDanger" size="appSmall" onClick={() => onDelete(profile.id)}>
            Delete
          </Button>
        </div>
      ))}
    </div>
  );
}

function SshConnectionDialog({
  open,
  draft,
  busy,
  onOpenChange,
  onDraftChange,
  onSave,
}: {
  open: boolean;
  draft: SshDraft;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onDraftChange: (draft: SshDraft) => void;
  onSave: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="ssh-connection-dialog">
        <DialogHeader>
          <DialogTitle>Add SSH connection</DialogTitle>
          <DialogDescription>Connect to another Mac using an SSH hostname and optional identity file.</DialogDescription>
        </DialogHeader>
        <FieldSet className="ssh-dialog-fieldset">
          <FieldGroup className="ssh-dialog-fields">
            <Field className="ssh-auth-field">
              <ToggleGroup
                type="single"
                className="ssh-auth-toggle"
                value={draft.authMode}
                onValueChange={(value) => {
                  if (value === "none" || value === "identity") onDraftChange({ ...draft, authMode: value });
                }}
              >
                <ToggleGroupItem value="none">No Auth</ToggleGroupItem>
                <ToggleGroupItem value="identity">Identity</ToggleGroupItem>
              </ToggleGroup>
            </Field>
            <TextField id="ssh-name" label="Display name" value={draft.name} onChange={(name) => onDraftChange({ ...draft, name })} />
            <TextField
              id="ssh-hostname"
              label="Hostname"
              value={draft.hostname}
              placeholder="host.com or user@host.com"
              onChange={(hostname) => onDraftChange({ ...draft, hostname })}
            />
            <TextField
              id="ssh-port"
              label="SSH port"
              optional
              value={draft.port}
              onChange={(port) => onDraftChange({ ...draft, port })}
            />
            {draft.authMode === "identity" ? (
              <TextField
                id="ssh-identity"
                label="Identity file path"
                value={draft.identityFile}
                onChange={(identityFile) => onDraftChange({ ...draft, identityFile })}
              />
            ) : null}
          </FieldGroup>
        </FieldSet>
        <DialogFooter className="ssh-dialog-actions">
          <DialogClose asChild>
            <Button variant="appLink">Cancel</Button>
          </DialogClose>
          <Button disabled={busy} onClick={onSave}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  checked,
  onCheckedChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Field orientation="horizontal" className="settings-switch-field">
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
      </FieldContent>
    </Field>
  );
}

function ProfileWorkflows({
  profileName,
  onProfileNameChange,
  onProfileAction,
}: {
  profileName: string;
  onProfileNameChange: (value: string) => void;
  onProfileAction: (action: ProfileAction) => Promise<void>;
}) {
  return (
    <Card className="profile-workflows">
      <CardHeader>
        <CardTitle>Agent management</CardTitle>
      </CardHeader>
      <CardContent>
        <Input value={profileName} placeholder="new-agent-name" onChange={(event) => onProfileNameChange(event.target.value)} />
      </CardContent>
      <CardFooter className="profile-actions">
        <Button variant="appNeutral" size="appSmall" onClick={() => void onProfileAction("create")}>Create</Button>
        <Button variant="appNeutral" size="appSmall" onClick={() => void onProfileAction("clone")}>Clone</Button>
        <Button variant="appNeutral" size="appSmall" onClick={() => void onProfileAction("rename")}>Rename</Button>
        <Button variant="appNeutral" size="appSmall" onClick={() => void onProfileAction("switch")}>Switch</Button>
        <Button variant="appDanger" size="appSmall" onClick={() => void onProfileAction("delete")}>Delete current</Button>
      </CardFooter>
    </Card>
  );
}

function ModelCard({
  summary,
  rawModel,
  provider,
}: {
  summary: { model: string; provider: string; config: string };
  rawModel: string;
  provider: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="model-card">
      <CollapsibleTrigger className="model-card-summary">
        <Server />
        <span>
          <strong>{summary.model}</strong>
          <small>{summary.provider}</small>
        </span>
        <em>Configuration</em>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre>{summary.config || prettyModelConfig(rawModel, provider)}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function SettingsSection({
  title,
  detail,
  variant = "panel",
  children,
}: {
  title: string;
  detail?: string;
  variant?: "panel" | "plain";
  children: ReactNode;
}) {
  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <div>
          <h2>{title}</h2>
          {detail ? <span>{detail}</span> : null}
        </div>
      </div>
      {variant === "panel" ? <Card className="runtime-panel">{children}</Card> : children}
    </section>
  );
}

function SettingsRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="settings-row">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="status-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Notice({ message }: { message: string }) {
  return (
    <Alert className="settings-notice">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function healthLabel(status: HermesStatus["activeApiStatus"]) {
  if (!status) return "Not checked";
  if (status.ok) return "Healthy";
  return "Offline";
}

function modeStatusCopy(connection: IrisCoreConnectionProfile) {
  if (connection.mode === "ssh") return `SSH: Iris is connected to Core on ${connection.name} through a local SSH tunnel.`;
  if (connection.mode === "tailscale") return `SSH: Iris can use a Tailscale hostname for ${connection.name}.`;
  return "Local: Iris Core runs locally and uses local Hermes.";
}

function transportLabel(connection: IrisCoreConnectionProfile) {
  const transport = connectionTransport(connection);
  if (transport === "ssh-tunnel") return "SSH tunnel";
  if (transport === "tailscale") return "SSH";
  return "Sidecar";
}

function ownerLabel(owner: ReturnType<typeof hermesOwner>) {
  if (owner === "remote-mac") return "Remote Mac";
  if (owner === "custom") return "Custom";
  return "Local";
}

function profileSubtitle(profile: IrisCoreConnectionProfile) {
  if (profile.mode === "ssh") {
    const target = sshTargetLabel(profile.ssh?.user || "", profile.ssh?.host || "");
    return target || profile.effectiveCoreApiUrl;
  }
  return profile.effectiveCoreApiUrl;
}

function modelSummary(provider: string, model: string) {
  const parsed = parseModelConfig(model);
  const resolvedProvider = rawStringValue(parsed?.provider) || provider || "Provider unavailable";
  const resolvedModel = rawStringValue(parsed?.default) || rawStringValue(parsed?.model) || model || "Model unavailable";
  return {
    model: resolvedModel,
    provider: resolvedProvider,
    config: parsed ? JSON.stringify(parsed, null, 2) : prettyModelConfig(model, provider),
  };
}

function parseModelConfig(model: string): Record<string, unknown> | null {
  const trimmed = model.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    try {
      return JSON.parse(trimmed.replace(/'/g, "\""));
    } catch {
      return null;
    }
  }
}

function prettyModelConfig(model: string, provider: string) {
  return JSON.stringify({ provider, model }, null, 2);
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
  return mode === "managed-local" ? "managed-local" : "ssh";
}

function localDraftFromProfile(profile: IrisCoreConnectionProfile): LocalDraft {
  const local = profile.local;
  return {
    port: String(local?.port || defaultCorePort),
    hermesHome: local?.hermesHome || "",
    autoStart: local?.autoStart !== false,
    installLaunchAgent: Boolean(local?.installLaunchAgent),
    allowSshTunnel: local?.allowSshTunnel !== false,
  };
}

function sshDraftFromConfig(config: HermesRuntimeConfig): SshDraft {
  const profile = activeCoreConnection(config).mode === "ssh"
    ? activeCoreConnection(config)
    : config.coreConnections.find((connection) => connection.mode === "ssh");
  const ssh = profile?.ssh;
  const authMode: SshAuthMode = ssh?.identityFile ? "identity" : "none";
  return {
    id: profile?.id || "",
    name: profile?.name || "",
    hostname: sshTargetLabel(ssh?.user || "", ssh?.host || ""),
    port: ssh?.port && ssh.port !== 22 ? String(ssh.port) : "",
    authMode,
    identityFile: ssh?.identityFile || "",
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

function localServiceConfig(draft: LocalDraft) {
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

function parseSshHostname(value: string) {
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

function sshTargetLabel(user: string, host: string) {
  const cleanUser = user.trim();
  const cleanHost = host.trim();
  if (!cleanHost) return "";
  return cleanUser ? `${cleanUser}@${cleanHost}` : cleanHost;
}
