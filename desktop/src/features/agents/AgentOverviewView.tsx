import { useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowRightLeft,
  Copy,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Wrench,
} from "lucide-react";
import {
  activeCoreConnection,
  connectionTransport,
  resolveCoreApiUrl,
} from "../../app/runtimeConfig";
import {
  agentRuntimeReadinessForStatus,
  runtimeReadinessDetail,
  runtimeReadinessGatewayAction,
  runtimeReadinessLabel,
  runtimeReadinessTone,
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
import { Field, FieldLabel } from "../../shared/ui/field";
import { Input } from "../../shared/ui/input";
import { StatusBanner } from "../../shared/ui/status-banner";
import type {
  HermesProfile,
  HermesRuntimeConfig,
  HermesStatus,
  IrisCoreConnectionProfile,
} from "../../types/hermes";

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
  const checkedAt = status?.checkedAt ? formatTimestamp(status.checkedAt) : "Not checked";
  const modelDisplay = modelSummary(profile.provider, profile.model);
  const runtimeReadiness = agentRuntimeReadinessForStatus(status, profile);
  const runtimeLabel = runtimeReadinessLabel(runtimeReadiness, selectedProfile);
  const runtimeDetail = runtimeReadinessDetail(runtimeReadiness, selectedProfile, runtimeConfig.connectionMode);
  const runtimeGatewayAction = runtimeReadinessGatewayAction(runtimeReadiness);
  const runtimeGatewayActionLabel = gatewayActionLabel(runtimeGatewayAction, gatewayActionBusy, gatewayActionBusyAction);
  const coreHealthy = status?.managementStatus?.ok ?? false;

  async function runProfileAction(action: ProfileAction) {
    const message = await onProfileAction(action, profileName);
    if (isProfileActionFailure(message)) {
      toast.error(message);
    } else {
      toast.success(message);
    }
    if (action !== "switch") setProfileName("");
  }

  return (
    <div className="agent-overview-view">
      <div className="agent-overview-toolbar">
        <div>
          <h2>Runtime health</h2>
          <span>{profile.name}</span>
        </div>
        <Button variant="appNeutral" size="appSmall" onClick={onRefresh}>
          <RefreshCw data-icon="inline-start" />
          Refresh
        </Button>
      </div>

      <div className="core-status-strip agent-overview-core-strip" data-online={coreHealthy ? "true" : "false"}>
        <span className={coreHealthy ? "service-health-dot online" : "service-health-dot offline"} />
        <span className="core-status-strip-name">Iris Core</span>
        <span className="core-status-strip-sep" aria-hidden>/</span>
        <span className="core-status-strip-field">
          <strong>{status?.coreApiUrl || resolveCoreApiUrl(runtimeConfig)}</strong>
        </span>
        <span className="core-status-strip-sep" aria-hidden>/</span>
        <span className="core-status-strip-field">{transportLabel(activeConnection)}</span>
        <span className="core-status-strip-spacer" />
        <span className="core-status-strip-checked">
          {coreHealthy ? `Healthy / ${checkedAt}` : `Offline / ${checkedAt}`}
        </span>
        <Button variant="appNeutral" size="appSmall" onClick={onOpenSettings}>
          <Wrench data-icon="inline-start" />
          Configure in Settings
        </Button>
      </div>

      {runtimeReadinessTone(runtimeReadiness) !== "ready" ? (
        <StatusBanner
          tone="degraded"
          density="comfortable"
          icon={AlertCircle}
          action={
            runtimeGatewayAction || runtimeReadiness === "adapter-unavailable" ? (
              <span className="flex items-center gap-2">
                {runtimeGatewayAction ? (
                  <Button
                    type="button"
                    variant="appNeutral"
                    size="appSmall"
                    disabled={gatewayActionBusy}
                    onClick={() => onGatewayAction(runtimeGatewayAction)}
                  >
                    {runtimeGatewayActionLabel}
                  </Button>
                ) : null}
                {runtimeReadiness === "adapter-unavailable" ? (
                  <Button
                    type="button"
                    variant="appNeutral"
                    size="appSmall"
                    disabled={adapterInstallBusy}
                    onClick={onInstallAdapter}
                  >
                    {adapterInstallBusy ? "Installing adapter..." : "Install adapter"}
                  </Button>
                ) : null}
              </span>
            ) : null
          }
        >
          {runtimeDetail || runtimeLabel}
        </StatusBanner>
      ) : null}

      <div className="agent-overview-grid">
        <div className="agent-overview-primary">
          <section className="settings-section model-section agent-overview-runtime">
            <div className="settings-section-header">
              <div>
                <h2>Runtime configuration</h2>
              </div>
            </div>
            <ModelCard summary={modelDisplay} rawModel={profile.model} provider={profile.provider} />
          </section>

          <ProfileWorkflows
            profileName={profileName}
            currentAgent={profile.name}
            onProfileNameChange={setProfileName}
            onProfileAction={runProfileAction}
            onDeleteAgent={() => onProfileAction("delete", profile.name, profile.name)}
          />
        </div>

        <Card className="agent-profile-summary-card">
          <CardHeader>
            <CardTitle>Profile metadata</CardTitle>
            <CardDescription>{profile.path || "Profile path unavailable"}</CardDescription>
          </CardHeader>
          <CardContent className="agent-profile-summary-grid">
            <ProfileStat label="Runtime" value={selectedProfile} />
            <ProfileStat label="Sessions" value={`${profile.sessionCount}`} />
            <ProfileStat label="Memory" value={formatBytes(profile.memoryBytes)} />
            <ProfileStat label="Skills" value={`${profile.skillCount}`} />
            <ProfileStat
              label="Estimated cost"
              value={profile.estimatedCostUsd == null ? "Unavailable" : `$${profile.estimatedCostUsd.toFixed(4)}`}
            />
            <ProfileStat label="Status" value={profile.active ? "Active" : "Available"} />
          </CardContent>
        </Card>
      </div>
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

function transportLabel(connection: IrisCoreConnectionProfile) {
  const transport = connectionTransport(connection);
  if (transport === "ssh-tunnel") return "SSH tunnel";
  return "Sidecar";
}

function gatewayActionLabel(
  action: "start" | "restart" | null,
  busy: boolean,
  busyAction: IrisCoreGatewayAction | null,
) {
  if (action === "start") return busy && busyAction === "start" ? "Starting gateway..." : "Start gateway";
  if (action === "restart") return busy && busyAction === "restart" ? "Restarting gateway..." : "Restart gateway";
  return "";
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
