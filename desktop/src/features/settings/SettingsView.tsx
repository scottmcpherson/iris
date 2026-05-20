import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ArrowRightLeft,
  ChevronDown,
  Copy,
  FileText,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  RotateCw,
  Server,
  Terminal,
  Trash2,
  Unplug,
  Wrench,
} from "lucide-react";
import {
  activeCoreConnection,
  connectionTransport,
  defaultCorePort,
  managedLocalConnectionId,
  removeCoreConnection,
  resolveCoreApiUrl,
  upsertCoreConnection,
} from "../../app/runtimeConfig";
import type { ProfileAction, ProfileActionHandler } from "../../app/types";
import { rawStringValue } from "../../shared/strings";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
  HermesProfile,
  HermesRuntimeConfig,
  HermesStatus,
  IrisCoreConnectionMode,
  IrisCoreConnectionProfile,
} from "../../types/hermes";
import { SshConnectionDialog } from "../iris/SshConnectionDialog";
import { sshTargetLabel } from "../iris/sshConnectionDraft";
import { useSshConnectionManager } from "../iris/useSshConnectionManager";

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
  const [localDraft, setLocalDraft] = useState(() => localDraftFromProfile(activeConnection));
  const [sshDialogOpen, setSshDialogOpen] = useState(false);
  const [sidecarStatus, setSidecarStatus] = useState<CoreSidecarStatus | null>(null);
  const [busyAction, setBusyAction] = useState("");
  const sshManager = useSshConnectionManager({ runtimeConfig, onRuntimeChange, onRefresh });
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
      if (result.ready) {
        toast.success("Managed Iris Core is running.");
      } else {
        toast.error(result.error || "Managed Iris Core is not ready.");
      }
      onRefresh();
    });
  }

  async function installHermesPlugin() {
    await withBusy("plugin-install", async () => {
      const result = await invoke<CoreCliResult>("core_install_hermes_plugin", { config: localCoreConfig(localDraft) });
      if (result.ok) {
        toast.success("Iris installed the Hermes plugin. Restart Hermes gateway.");
      } else {
        toast.error(result.error || result.stderr || "Plugin install failed.");
      }
    });
  }

  async function installCoreService() {
    await withBusy("service-install", async () => {
      const result = await invoke<CoreCliResult>("core_service_install", {
        config: localServiceConfig(localDraft),
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
      const result = await invoke<CoreCliResult>("core_service_uninstall", { config: localCoreConfig(localDraft) });
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

  async function runProfileAction(action: ProfileAction) {
    const message = await onProfileAction(action, profileName);
    if (isProfileActionFailure(message)) {
      toast.error(message);
    } else {
      toast.success(message);
    }
    if (action !== "switch") setProfileName("");
  }

  if (mode === "profile") {
    const coreHealthy = status?.managementStatus?.ok ?? false;
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

        <div className="core-status-strip" data-online={coreHealthy ? "true" : "false"}>
          <span className={coreHealthy ? "service-health-dot online" : "service-health-dot offline"} />
          <span className="core-status-strip-name">Iris Core</span>
          <span className="core-status-strip-sep" aria-hidden>·</span>
          <span className="core-status-strip-field">
            <strong>{status?.coreApiUrl || resolveCoreApiUrl(runtimeConfig)}</strong>
          </span>
          <span className="core-status-strip-sep" aria-hidden>·</span>
          <span className="core-status-strip-field">{transportLabel(activeConnection)}</span>
          <span className="core-status-strip-spacer" />
          <span className="core-status-strip-checked">
            {coreHealthy ? `Healthy · ${checkedAt}` : `Offline · ${checkedAt}`}
          </span>
          {onOpenSettings ? (
            <Button variant="appNeutral" size="appSmall" onClick={onOpenSettings}>
              <Wrench data-icon="inline-start" />
              Configure in Settings
            </Button>
          ) : null}
        </div>

        <section className="settings-section model-section">
          <div className="settings-section-header">
            <div>
              <h2>Runtime configuration</h2>
            </div>
          </div>
          <ModelCard summary={modelDisplay} rawModel={profile.model} provider={profile.provider} />
          <div className="core-status-strip profile-overview-meta">
            <span className="core-status-strip-field">
              Runtime <strong>{selectedProfile}</strong>
            </span>
            <span className="core-status-strip-sep" aria-hidden>·</span>
            <span className="core-status-strip-field">
              Estimated cost <strong>{profile.estimatedCostUsd == null ? "Unavailable" : `$${profile.estimatedCostUsd.toFixed(4)}`}</strong>
            </span>
          </div>
        </section>

        <ProfileWorkflows
          profileName={profileName}
          currentAgent={profile.name}
          onProfileNameChange={setProfileName}
          onProfileAction={runProfileAction}
          onDeleteAgent={() => onProfileAction("delete", profile.name, profile.name)}
        />
      </div>
    );
  }

  return (
    <div className="tool-view settings-view settings-view-general">
      <div className="settings-toolbar">
        <div>
          <h1>Settings</h1>
        </div>
      </div>

      <div className="core-status-strip" data-online={status?.connected ? "true" : "false"}>
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
        <span className="core-status-strip-spacer" />
        <span className="core-status-strip-checked">
          {status?.connected ? `Checked ${checkedAt}` : `Offline · ${checkedAt}`}
        </span>
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
            <CardContent className="settings-mode-content">
              <FieldSet className="settings-form-group">
                <h3 className="settings-form-group-title">Connection</h3>
                <FieldGroup className="settings-field-grid">
                  <TextField id="local-port" label="Core port" value={localDraft.port} onChange={(port) => setLocalDraft({ ...localDraft, port })} />
                  <TextField id="local-hermes-home" label="Hermes home" value={localDraft.hermesHome} placeholder="~/.hermes" onChange={(hermesHome) => setLocalDraft({ ...localDraft, hermesHome })} />
                </FieldGroup>
              </FieldSet>
              <FieldSet className="settings-form-group">
                <h3 className="settings-form-group-title">Startup</h3>
                <FieldGroup className="settings-switch-list">
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
                </FieldGroup>
              </FieldSet>
            </CardContent>
            <CardFooter className="settings-action-row">
              <Button size="appSmall" onClick={() => void saveLocalProfile()}>
                <Plug data-icon="inline-start" />
                Save
              </Button>
              <span className="settings-action-spacer" />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="appNeutral" size="appSmall">
                    <Wrench data-icon="inline-start" />
                    Service management
                    <ChevronDown data-icon="inline-end" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={6} className="min-w-[208px]">
                  <DropdownMenuItem disabled={busyAction === "core-restart"} onSelect={() => void startOrRestartCore(true)}>
                    <RotateCw />
                    Restart Core
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={busyAction === "plugin-install"} onSelect={() => void installHermesPlugin()}>
                    <Wrench />
                    Install Hermes plugin
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
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
                connectedId={status?.connected ? activeConnection.id : ""}
                busy={sshManager.busyAction === "ssh-connect" || sshManager.busyAction === "ssh-disconnect"}
                onActivate={(id) => {
                  const profile = runtimeConfig.coreConnections.find((connection) => connection.id === id);
                  if (profile) void sshManager.connectSsh(profile);
                }}
                onDelete={deleteProfile}
                onDisconnect={(id) => void sshManager.disconnectSsh(id)}
              />
            </CardContent>
          </Card>
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
        </TabsContent>
      </Tabs>
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
    <div className="connection-profile-list">
      {profiles.map((profile) => {
        const connected = profile.id === connectedId;
        const selected = profile.id === activeId;
        const switchId = `connection-${profile.id}`;
        return (
          <div className="connection-profile-row" key={profile.id} data-connected={connected ? "true" : "false"}>
            <div className="connection-profile-summary">
              <strong>{profile.name}</strong>
              <span>{profileSubtitle(profile)}</span>
            </div>
            <Field
              orientation="horizontal"
              className="connection-switch-field"
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
  onCheckedChange,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Field orientation="horizontal" className="settings-switch-field">
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {description ? <FieldDescription>{description}</FieldDescription> : null}
      </FieldContent>
    </Field>
  );
}

function ProfileWorkflows({
  profileName,
  currentAgent,
  onProfileNameChange,
  onProfileAction,
  onDeleteAgent,
}: {
  profileName: string;
  currentAgent: string;
  onProfileNameChange: (value: string) => void;
  onProfileAction: (action: ProfileAction) => Promise<void>;
  onDeleteAgent: () => Promise<string>;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const isDefault = currentAgent === "default";
  const canDelete = !isDefault && deleteConfirm.trim() === currentAgent;

  function closeDeleteDialog() {
    if (deleteBusy) return;
    setDeleteOpen(false);
    setDeleteConfirm("");
  }

  async function confirmDelete() {
    if (!canDelete) return;
    setDeleteBusy(true);
    try {
      const message = await onDeleteAgent();
      if (isProfileActionFailure(message)) {
        toast.error(message);
      } else {
        toast.success(message);
        setDeleteOpen(false);
        setDeleteConfirm("");
      }
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <>
      <Card className="profile-workflows">
        <CardHeader>
          <CardTitle>Agent management</CardTitle>
          <CardDescription>Create, clone, rename, or switch agents by name.</CardDescription>
        </CardHeader>
        <CardContent className="profile-workflows-content">
          <div className="profile-workflows-row">
            <Input
              className="profile-workflows-input"
              value={profileName}
              placeholder="new-agent-name"
              onChange={(event) => onProfileNameChange(event.target.value)}
            />
            <Button size="appSmall" onClick={() => void onProfileAction("create")}>
              <Plus data-icon="inline-start" />
              Create
            </Button>
          </div>
          <div className="profile-workflows-secondary">
            <Button variant="appNeutral" size="appSmall" onClick={() => void onProfileAction("clone")}>
              <Copy data-icon="inline-start" />
              Clone
            </Button>
            <Button variant="appNeutral" size="appSmall" onClick={() => void onProfileAction("rename")}>
              <Pencil data-icon="inline-start" />
              Rename
            </Button>
            <Button variant="appNeutral" size="appSmall" onClick={() => void onProfileAction("switch")}>
              <ArrowRightLeft data-icon="inline-start" />
              Switch
            </Button>
          </div>
        </CardContent>
        <CardFooter className="profile-workflows-danger">
          <div className="profile-workflows-danger-text">
            <strong>Delete this agent</strong>
            <span>
              {isDefault
                ? "The default agent can't be deleted."
                : "Removes the agent profile, its memory, and its sessions."}
            </span>
          </div>
          <Button
            variant="appDanger"
            size="appSmall"
            disabled={isDefault}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 data-icon="inline-start" />
            Delete agent
          </Button>
        </CardFooter>
      </Card>

      <Dialog open={deleteOpen} onOpenChange={(open) => (open ? setDeleteOpen(true) : closeDeleteDialog())}>
        <DialogContent>
          <DialogHeader>
            <DialogDescription>Agent deletion</DialogDescription>
            <DialogTitle>Delete {currentAgent}</DialogTitle>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="delete-agent-confirm">
              Type <strong>{currentAgent}</strong> to confirm
            </FieldLabel>
            <Input
              id="delete-agent-confirm"
              autoFocus
              value={deleteConfirm}
              placeholder={currentAgent}
              onChange={(event) => setDeleteConfirm(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="appNeutral" size="appSmall" disabled={deleteBusy}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="appDanger"
              size="appSmall"
              disabled={!canDelete || deleteBusy}
              onClick={() => void confirmDelete()}
            >
              {deleteBusy ? "Deleting…" : "Delete agent"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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

function isProfileActionFailure(message: string) {
  return /\b(error|failed|cannot|already exists|does not exist|enter|invalid)\b/i.test(message);
}

function transportLabel(connection: IrisCoreConnectionProfile) {
  const transport = connectionTransport(connection);
  if (transport === "ssh-tunnel") return "SSH tunnel";
  if (transport === "tailscale") return "SSH";
  return "Sidecar";
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
