import { forwardRef, useImperativeHandle, useState } from "react";
import type { FormEvent } from "react";
import { Bot, Copy, Ellipsis, Play, Plug, Plus, RotateCw, Trash2, Unplug, Wrench } from "lucide-react";
import type { ProfileActionHandler } from "../../app/types";
import { agentRuntimeReadinessForStatus } from "../../app/runtimeReadiness";
import type { IrisCoreGatewayAction } from "../../lib/irisCore";
import { formatBytes } from "../../shared/format";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../shared/ui/dropdown-menu";
import { Button } from "../../shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/dialog";
import { Input } from "../../shared/ui/input";
import type { HermesProfile, HermesStatus } from "../../types/hermes";
import { AgentContentFrame } from "./AgentContentFrame";
import { normalizeProfileName, profileNameError } from "./profileNames";

type AgentListDialog =
  | { action: "create"; name: string }
  | { action: "clone"; source: string; name: string }
  | { action: "delete"; source: string; name: string };

export type AgentListVariant = "page" | "dialog";

export type AgentListHandle = {
  openCreateDialog: () => void;
};

type AgentListProps = {
  profiles: HermesProfile[];
  status: HermesStatus | null;
  gatewayActionBusy: boolean;
  gatewayActionBusyAction: IrisCoreGatewayAction | null;
  gatewayActionBusyProfile: string;
  adapterInstallBusyProfile: string;
  variant?: AgentListVariant;
  onOpenAgent: (profileName: string) => void;
  onProfileAction: ProfileActionHandler;
  onGatewayAction: (action: IrisCoreGatewayAction, profileName: string) => void;
  onInstallAdapter: (profileName: string) => void;
};

const dialogContentClassName = "border-menu-border bg-menu text-menu-foreground shadow-context-menu sm:max-w-[360px]";
const labelClassName = "grid gap-[7px] text-xs font-[750] text-menu-muted-foreground";
const inputClassName = "h-[38px] border-menu-border bg-secondary text-menu-hover-foreground placeholder:text-menu-muted-foreground";

export const AgentList = forwardRef<AgentListHandle, AgentListProps>(function AgentList({
  profiles,
  status,
  gatewayActionBusy,
  gatewayActionBusyAction,
  gatewayActionBusyProfile,
  adapterInstallBusyProfile,
  variant = "page",
  onOpenAgent,
  onProfileAction,
  onGatewayAction,
  onInstallAdapter,
}, ref) {
  const [dialog, setDialog] = useState<AgentListDialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isDialog = variant === "dialog";

  useImperativeHandle(ref, () => ({ openCreateDialog }), []);

  const content = (
    <>
      {isDialog ? null : (
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1>Agent Profiles</h1>
          </div>
          <Button
            type="button"
            size="icon-md"
            aria-label="Create agent"
            title="Create agent"
            onClick={openCreateDialog}
          >
            <Plus data-icon="inline-start" />
          </Button>
        </div>
      )}

      <div className="agent-list-grid grid content-start gap-2 min-h-0">
        {profiles.map((profile) => {
          const gateway = gatewaySummary(agentRuntimeReadinessForStatus(status, profile));
          const pillAction = gateway.action;
          const pillBusy = Boolean(
            pillAction &&
              gatewayActionBusy &&
              gatewayActionBusyProfile === profile.name &&
              gatewayActionBusyAction === pillAction,
          );
          const pillActionLabel = pillAction === "start"
            ? pillBusy
              ? "Starting gateway..."
              : "Start gateway"
            : pillAction === "restart"
              ? pillBusy
                ? "Restarting gateway..."
                : "Restart gateway"
              : null;
          const PillActionIcon = pillAction === "start" ? Play : RotateCw;
          return (
            <div
              key={profile.name}
              role="button"
              tabIndex={0}
              aria-label={`Open ${profile.name}`}
              className="agent-list-row"
              data-actionable={pillAction ? "true" : undefined}
              onClick={() => onOpenAgent(profile.name)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onOpenAgent(profile.name);
                }
              }}
            >
              <span className="agent-list-row-primary flex items-center gap-[13px] min-w-0">
                <span className="agent-avatar">
                  <Bot size={18} />
                </span>
                <span className="agent-list-main grid min-w-0 gap-1">
                  <strong>{profile.name}</strong>
                  <small>{agentSubtitle(profile)}</small>
                </span>
              </span>
              {pillAction && pillActionLabel ? (
                <button
                  type="button"
                  className={`agent-gateway-pill agent-gateway-pill-action ${gateway.tone}`}
                  disabled={gatewayActionBusy}
                  onClick={(event) => {
                    event.stopPropagation();
                    onGatewayAction(pillAction, profile.name);
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
                  aria-label={pillActionLabel}
                  title={pillActionLabel}
                >
                  <span className="service-health-dot degraded" />
                  <strong>{pillBusy ? pillActionLabel : gateway.label}</strong>
                  <span className="agent-gateway-pill-hint">
                    <PillActionIcon size={11} aria-hidden />
                  </span>
                </button>
              ) : (
                <span className={`agent-gateway-pill ${gateway.tone}`}>
                  <span className={`service-health-dot ${gateway.tone === "ready" ? "online" : "degraded"}`} />
                  <strong>{gateway.label}</strong>
                </span>
              )}
              <span className="agent-list-row-stats flex items-center gap-5 min-w-0 justify-end">
                <span className="agent-list-stat flex flex-col items-center gap-y-0.5 min-w-0 opacity-[0.86]">
                  <strong>{profile.sessionCount}</strong>
                  <small>Sessions</small>
                </span>
                <span className="agent-list-stat flex flex-col items-center gap-y-0.5 min-w-0 opacity-[0.86]">
                  <strong>{formatBytes(profile.memoryBytes)}</strong>
                  <small>Memory</small>
                </span>
                <span className="agent-list-stat flex flex-col items-center gap-y-0.5 min-w-0 opacity-[0.86]">
                  <strong>{profile.skillCount}</strong>
                  <small>Skills</small>
                </span>
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    className="profile-row-action agent-list-menu-trigger flex-none"
                    aria-label={`More actions for ${profile.name}`}
                    title={`More actions for ${profile.name}`}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <Ellipsis size={18} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  sideOffset={6}
                  onClick={(event) => event.stopPropagation()}
                >
                  <DropdownMenuGroup>
                    <DropdownMenuItem disabled={gatewayActionBusy} onSelect={() => onGatewayAction("start", profile.name)}>
                      <Plug data-icon="inline-start" />
                      Start gateway
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={gatewayActionBusy} onSelect={() => onGatewayAction("stop", profile.name)}>
                      <Unplug data-icon="inline-start" />
                      Stop gateway
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={gatewayActionBusy} onSelect={() => onGatewayAction("restart", profile.name)}>
                      <RotateCw data-icon="inline-start" />
                      Restart gateway
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={adapterInstallBusyProfile === profile.name}
                      onSelect={() => onInstallAdapter(profile.name)}
                    >
                      <Wrench data-icon="inline-start" />
                      {adapterInstallBusyProfile === profile.name ? "Installing adapter..." : "Install adapter"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => openCloneDialog(profile.name)}>
                      <Copy data-icon="inline-start" />
                      Duplicate
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={profile.name === "default"}
                      title={profile.name === "default" ? "The default agent cannot be deleted" : undefined}
                      onSelect={() => openDeleteDialog(profile.name)}
                    >
                      <Trash2 data-icon="inline-start" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
      </div>
      {dialog ? renderDialog() : null}
    </>
  );

  return isDialog ? (
    <div className="agent-list-dialog-body grid gap-3 min-w-0 max-h-[min(560px,calc(100vh-220px))] overflow-y-auto -mx-1 px-1 pb-1">{content}</div>
  ) : (
    <AgentContentFrame layout="index" className="content-start gap-[18px]">
      {content}
    </AgentContentFrame>
  );

  function openCreateDialog() {
    setError("");
    setDialog({ action: "create", name: "" });
  }

  function openCloneDialog(source: string) {
    setError("");
    setDialog({ action: "clone", source, name: nextProfileName(`${source}-copy`, profiles) });
  }

  function openDeleteDialog(source: string) {
    if (source === "default") return;
    setError("");
    setDialog({ action: "delete", source, name: "" });
  }

  function closeDialog() {
    if (busy) return;
    setDialog(null);
    setError("");
  }

  function renderDialog() {
    if (!dialog) return null;
    const isDelete = dialog.action === "delete";
    const isClone = dialog.action === "clone";
    const source = "source" in dialog ? dialog.source : "";
    const title = isDelete ? `Delete ${source}` : isClone ? `Duplicate ${source}` : "New agent";
    const label = isDelete ? "Confirm agent name" : "Agent name";
    const submitLabel = isDelete ? "Delete" : isClone ? "Duplicate" : "Create";
    const submitVariant = isDelete ? "appDanger" : isClone ? "appNeutral" : "default";
    const validationError = isDelete ? "" : profileNameError(dialog.name);
    const disabled = busy || (isDelete ? dialog.name.trim() !== source : Boolean(validationError));

    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent className={dialogContentClassName} showCloseButton={false}>
          <form className="grid gap-4" onSubmit={submitDialog}>
            <DialogHeader>
              {isDelete ? (
                <DialogDescription className="text-xs font-[750] text-menu-muted-foreground">
                  Agent deletion
                </DialogDescription>
              ) : null}
              <DialogTitle className="text-lg text-menu-hover-foreground">{title}</DialogTitle>
            </DialogHeader>
            <label className={labelClassName}>
              <span>{label}</span>
              <Input
                autoFocus
                className={inputClassName}
                value={dialog.name}
                placeholder={isDelete ? source : "agent-name"}
                onChange={(event) => setDialog({ ...dialog, name: event.target.value })}
              />
            </label>
            {error || validationError ? (
              <p className="text-xs leading-[1.45] text-menu-danger">{error || validationError}</p>
            ) : null}
            <DialogFooter className="gap-2">
              <Button type="button" variant="appNeutral" size="appSmall" onClick={closeDialog}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant={submitVariant}
                size="appSmall"
                disabled={disabled}
              >
                {busy ? "Working..." : submitLabel}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    );
  }

  async function submitDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dialog || busy) return;

    const name = dialog.action === "delete" ? dialog.name.trim() : normalizeProfileName(dialog.name);
    const validationError = dialog.action === "delete" ? "" : profileNameError(name);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (dialog.action === "delete" && name !== dialog.source) {
      setError(`Type ${dialog.source} to delete this profile.`);
      return;
    }

    setBusy(true);
    setError("");
    const message =
      dialog.action === "clone"
        ? await onProfileAction("clone", name, dialog.source)
        : dialog.action === "delete"
          ? await onProfileAction("delete", dialog.source, dialog.source)
          : await onProfileAction("create", name);
    setBusy(false);

    if (isProfileActionFailure(message)) {
      setError(message);
      return;
    }
    setDialog(null);
  }
});

function nextProfileName(base: string, profiles: HermesProfile[]) {
  const names = new Set(profiles.map((profile) => profile.name));
  if (!names.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!names.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function agentSubtitle(profile: HermesProfile) {
  const provider = cleanAgentLabel(profile.provider) || "Iris Core";
  const model = cleanAgentLabel(profile.model);
  const summary = model ? `${provider} / ${model}` : provider;
  return profile.active ? `${summary} / active` : summary;
}

function gatewaySummary(runtimeReadiness: ReturnType<typeof agentRuntimeReadinessForStatus>) {
  if (runtimeReadiness === "offline") {
    return {
      label: "Core offline",
      tone: "stopped" as const,
      action: null,
    };
  }
  if (runtimeReadiness === "gateway-stopped") {
    return {
      label: "Gateway stopped",
      tone: "stopped" as const,
      action: "start" as const,
    };
  }
  if (runtimeReadiness === "adapter-unavailable") {
    return {
      label: "Adapter unavailable",
      tone: "degraded" as const,
      action: "restart" as const,
    };
  }
  return {
    label: "Running",
    tone: "ready" as const,
    action: null,
  };
}

function cleanAgentLabel(value: unknown) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed === "not configured" || trimmed.startsWith("{") || trimmed.startsWith("[")) return "";
  return trimmed;
}

function isProfileActionFailure(message: string) {
  return /\b(error|failed|cannot|already exists|does not exist|enter|invalid)\b/i.test(message);
}
