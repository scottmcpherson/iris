import { useState } from "react";
import { toast } from "sonner";
import {
  Activity,
  ArrowRightLeft,
  Copy,
  Cpu,
  Info,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  Trash2,
  Wrench,
} from "lucide-react";
import {
  activeCoreConnection,
  resolveCoreApiUrl,
} from "../../app/runtimeConfig";
import {
  runtimeGatewayIsReachable,
} from "../../app/runtimeReadiness";
import type { ProfileAction, ProfileActionHandler } from "../../app/types";
import type { IrisCoreGatewayAction } from "../../lib/irisCore";
import { formatBytes } from "../../shared/format";
import { rawStringValue } from "../../shared/strings";
import { Button } from "../../shared/ui/button";
import {
  Card,
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
import { DiagnosticRow, type DiagnosticRowAction } from "../../shared/ui/diagnostic-row";
import { Field, FieldLabel } from "../../shared/ui/field";
import { Input } from "../../shared/ui/input";
import type {
  HermesProfile,
  HermesRuntimeConfig,
  HermesStatus,
} from "../../types/hermes";
import { normalizeProfileName, profileNameError } from "./profileNames";

type AgentOverviewViewProps = {
  status: HermesStatus | null;
  profile: HermesProfile;
  selectedProfile: string;
  runtimeConfig: HermesRuntimeConfig;
  gatewayActionBusy: boolean;
  gatewayActionBusyAction: IrisCoreGatewayAction | null;
  adapterInstallBusy: boolean;
  onRefresh: () => void;
  onProfileAction: ProfileActionHandler;
  onGatewayAction: (action: IrisCoreGatewayAction) => void;
  onInstallAdapter: () => void;
  onOpenSettings: () => void;
};

export function AgentOverviewView({
  status,
  profile,
  selectedProfile,
  runtimeConfig,
  gatewayActionBusy,
  gatewayActionBusyAction,
  adapterInstallBusy,
  onRefresh,
  onProfileAction,
  onGatewayAction,
  onInstallAdapter,
  onOpenSettings,
}: AgentOverviewViewProps) {
  const activeConnection = activeCoreConnection(runtimeConfig);
  const [profileName, setProfileName] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const checkedAt = status?.checkedAt ? formatTimestamp(status.checkedAt) : "";
  const modelDisplay = modelSummary(profile.provider, profile.model);
  const coreOk = Boolean(status?.connected && status?.managementStatus?.ok);
  const gatewayOk = runtimeGatewayIsReachable(status, profile);
  const adapterOk = Boolean(status?.activeApiStatus?.ok);
  const coreUrl = status?.coreApiUrl || resolveCoreApiUrl(runtimeConfig);
  const coreTransportShort = activeConnection.mode === "ssh" ? "SSH" : "Local";
  const coreSublabel = coreUrl ? `${coreTransportShort} · ${coreUrl}` : coreTransportShort;
  const gatewayActionBusyForStart = gatewayActionBusy && gatewayActionBusyAction === "start";
  const gatewayActionBusyForRestart = gatewayActionBusy && gatewayActionBusyAction === "restart";

  const coreDiagnosticAction: DiagnosticRowAction | null = !coreOk
    ? {
        label: "Open Settings",
        icon: Wrench,
        onClick: onOpenSettings,
      }
    : null;

  const gatewayDiagnosticAction: DiagnosticRowAction | null = coreOk && !gatewayOk
    ? {
        label: gatewayActionBusyForStart ? "Starting…" : "Start gateway",
        icon: Plug,
        disabled: gatewayActionBusy,
        onClick: () => onGatewayAction("start"),
      }
    : null;

  const adapterDiagnosticAction: DiagnosticRowAction | null = coreOk && gatewayOk && !adapterOk
    ? {
        label: adapterInstallBusy
          ? "Installing…"
          : gatewayActionBusyForRestart
            ? "Restarting gateway…"
            : "Install adapter",
        icon: Wrench,
        disabled: adapterInstallBusy || gatewayActionBusyForRestart,
        onClick: onInstallAdapter,
      }
    : null;

  async function runProfileAction(action: ProfileAction) {
    const target = action === "switch" ? normalizeProfileName(profileName || selectedProfile) : normalizeProfileName(profileName);
    const validationError = ["create", "clone", "rename"].includes(action) ? profileNameError(target) : "";
    if (validationError) {
      setActionNotice(validationError);
      toast.error(validationError);
      return;
    }
    const message = await onProfileAction(action, target);
    setActionNotice(message);
    if (isProfileActionFailure(message)) {
      toast.error(message);
    } else {
      toast.success(message);
    }
    if (action !== "switch") setProfileName("");
  }

  return (
    <div className="agent-overview-view">
      <div className="agent-overview-top">
        <Card className="agent-overview-card agent-overview-card-health">
          <CardHeader>
            <CardTitle>
              <Activity className="agent-overview-card-icon" />
              <span>Runtime health</span>
            </CardTitle>
            <div className="agent-overview-card-header-actions">
              <Button
                variant="appIcon"
                size="icon-sm"
                onClick={onRefresh}
                title="Refresh"
                aria-label="Refresh runtime health"
              >
                <RefreshCw />
              </Button>
              <Button
                variant="appIcon"
                size="icon-sm"
                onClick={onOpenSettings}
                title="Configure in Settings"
                aria-label="Configure in Settings"
              >
                <Wrench />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="agent-overview-card-body">
            <div className="diagnostics-rows">
              <DiagnosticRow
                label="Iris Core"
                sublabel={coreSublabel}
                ok={coreOk}
                tone={coreOk ? "ready" : "offline"}
                action={coreDiagnosticAction}
              />
              <DiagnosticRow
                label={`Hermes gateway (${selectedProfile})`}
                ok={gatewayOk}
                tone={gatewayOk ? "ready" : "degraded"}
                action={gatewayDiagnosticAction}
              />
              <DiagnosticRow
                label="Iris adapter"
                ok={adapterOk}
                tone={adapterOk ? "ready" : "degraded"}
                action={adapterDiagnosticAction}
              />
            </div>
            {checkedAt ? (
              <span className="agent-overview-card-foot">Last checked {checkedAt}</span>
            ) : null}
          </CardContent>
        </Card>

        <Card className="agent-overview-card agent-overview-card-metadata">
          <CardHeader>
            <CardTitle>
              <Info className="agent-overview-card-icon" />
              <span>Profile metadata</span>
            </CardTitle>
            <CardDescription>{profile.path || "Profile path unavailable"}</CardDescription>
          </CardHeader>
          <CardContent className="agent-overview-card-body">
            <div className="agent-overview-stats">
              <ProfileStat label="Runtime" value={selectedProfile} />
              <ProfileStat label="Sessions" value={`${profile.sessionCount}`} />
              <ProfileStat label="Memory" value={formatBytes(profile.memoryBytes)} />
              <ProfileStat label="Skills" value={`${profile.skillCount}`} />
              <ProfileStat
                label="Estimated cost"
                value={profile.estimatedCostUsd == null ? "Unavailable" : `$${profile.estimatedCostUsd.toFixed(4)}`}
              />
              <ProfileStat label="Status" value={profile.active ? "Active" : "Available"} />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="agent-overview-card agent-overview-card-runtime">
        <CardHeader>
          <CardTitle>
            <Cpu className="agent-overview-card-icon" />
            <span>Runtime configuration</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="agent-overview-card-body">
          <ModelCard summary={modelDisplay} rawModel={profile.model} provider={profile.provider} />
        </CardContent>
      </Card>

        <ProfileWorkflows
          profileName={profileName}
          currentAgent={profile.name}
          actionNotice={actionNotice}
          onProfileNameChange={setProfileName}
          onProfileAction={runProfileAction}
          onDeleteAgent={() => onProfileAction("delete", profile.name, profile.name)}
      />
    </div>
  );
}

function ProfileStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="agent-profile-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ProfileWorkflows({
  profileName,
  currentAgent,
  actionNotice,
  onProfileNameChange,
  onProfileAction,
  onDeleteAgent,
}: {
  profileName: string;
  currentAgent: string;
  actionNotice: string;
  onProfileNameChange: (value: string) => void;
  onProfileAction: (action: ProfileAction) => Promise<void>;
  onDeleteAgent: () => Promise<string>;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const isDefault = currentAgent === "default";
  const canDelete = !isDefault && deleteConfirm.trim() === currentAgent;
  const validationError = profileName.trim() ? profileNameError(profileName) : "";

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
      <Card className="profile-workflows agent-overview-card">
        <CardHeader>
          <CardTitle>
            <Settings2 className="agent-overview-card-icon" />
            <span>Agent management</span>
          </CardTitle>
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
          {validationError || actionNotice ? (
            <p className={`profile-workflows-notice ${validationError || isProfileActionFailure(actionNotice) ? "error" : ""}`}>
              {validationError || actionNotice}
            </p>
          ) : null}
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
              {deleteBusy ? "Deleting..." : "Delete agent"}
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
