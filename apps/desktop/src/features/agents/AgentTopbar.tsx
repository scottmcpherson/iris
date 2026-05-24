import { useState } from "react";
import type { FormEvent } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  Copy,
  Ellipsis,
  Plug,
  RotateCw,
  Settings2,
  Trash2,
  Unplug,
  Wrench,
} from "lucide-react";
import {
  agentRuntimeReadinessForStatus,
  runtimeReadinessShortLabel,
  runtimeReadinessTone,
} from "../../app/runtimeReadiness";
import type { ProfileActionHandler } from "../../app/types";
import type { IrisCoreGatewayAction } from "../../lib/irisCore";
import { Button } from "../../shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../shared/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "../../shared/ui/tabs";
import { ProfileActionDialog, type ProfileDialog } from "../../layout/AppShellDialogs";
import type { HermesProfile, HermesStatus } from "../../types/hermes";
import { normalizeProfileName, profileNameError } from "./profileNames";
import type { AgentDetailSection } from "./types";

const SECTION_ORDER: AgentDetailSection[] = ["overview", "configuration", "memory", "skills"];

function sectionLabel(section: AgentDetailSection): string {
  return section === "configuration" ? "Config" : section.charAt(0).toUpperCase() + section.slice(1);
}

type AgentTopbarProps = {
  detailProfile: string | null;
  profile: HermesProfile;
  profiles: HermesProfile[];
  status: HermesStatus | null;
  section: AgentDetailSection;
  gatewayActionBusy: boolean;
  adapterInstallBusyProfile: string;
  onSwitchAgent: (profileName: string) => void;
  onManageAgents: () => void;
  onSectionChange: (section: AgentDetailSection) => void;
  onGatewayAction: (action: IrisCoreGatewayAction, profileName: string) => void;
  onInstallAdapter: (profileName: string) => void;
  onProfileAction: ProfileActionHandler;
};

export function AgentTopbar({
  detailProfile,
  profile,
  profiles,
  status,
  section,
  gatewayActionBusy,
  adapterInstallBusyProfile,
  onSwitchAgent,
  onManageAgents,
  onSectionChange,
  onGatewayAction,
  onInstallAdapter,
  onProfileAction,
}: AgentTopbarProps) {
  const [dialog, setDialog] = useState<ProfileDialog | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");

  if (!detailProfile) {
    return (
      <div
        className="grid items-center w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-[14px] min-h-[44px]"
        aria-hidden="true"
      />
    );
  }

  const installingAdapter = adapterInstallBusyProfile === profile.name;
  const isDefaultProfile = profile.name === "default";

  return (
    <div className="grid items-center w-full min-w-0 agent-topbar-detail">
      <div className="flex items-center gap-0.5 min-w-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="agent-switcher-trigger"
              aria-label={`Current agent: ${profile.name}. Switch agents.`}
              title="Switch agent"
            >
              <span className="agent-switcher-trigger-avatar" aria-hidden="true">
                <Bot size={16} />
              </span>
              <span className="font-bold tracking-[-0.01em] whitespace-nowrap overflow-hidden text-ellipsis max-w-[240px]">
                {profile.name}
              </span>
              <ChevronDown size={14} className="agent-switcher-trigger-chevron opacity-60 -ml-px flex-none" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={6} className="w-[320px] p-1">
            <DropdownMenuGroup>
              {profiles.map((item) => {
                const readiness = agentRuntimeReadinessForStatus(status, item);
                const tone = runtimeReadinessTone(readiness);
                const isCurrent = item.name === profile.name;
                return (
                  <DropdownMenuItem
                    key={item.name}
                    className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2.5 px-[9px] py-[7px] cursor-pointer"
                    onSelect={() => {
                      if (!isCurrent) onSwitchAgent(item.name);
                    }}
                  >
                    <span className="agent-switcher-item-avatar" aria-hidden="true">
                      <Bot size={14} />
                    </span>
                    <span className="grid gap-0.5 min-w-0">
                      <strong>{item.name}</strong>
                      <small>{agentSubtitle(item)}</small>
                    </span>
                    <span className={`agent-switcher-status ${tone}`}>
                      <span
                        className={`service-health-dot ${
                          tone === "ready" ? "online" : tone === "offline" ? "" : "degraded"
                        }`}
                      />
                      <span>{runtimeReadinessShortLabel(readiness)}</span>
                    </span>
                    <span className="agent-switcher-item-check" aria-hidden={!isCurrent}>
                      {isCurrent ? <Check size={14} /> : null}
                    </span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="font-semibold" onSelect={onManageAgents}>
              <Settings2 data-icon="inline-start" size={14} />
              Manage agents…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="agent-topbar-more-trigger"
              aria-label={`More actions for ${profile.name}`}
              title={`More actions for ${profile.name}`}
            >
              <Ellipsis size={16} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={6}>
            <DropdownMenuGroup>
              <DropdownMenuItem
                disabled={gatewayActionBusy}
                onSelect={() => onGatewayAction("start", profile.name)}
              >
                <Plug data-icon="inline-start" />
                Start gateway
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={gatewayActionBusy}
                onSelect={() => onGatewayAction("stop", profile.name)}
              >
                <Unplug data-icon="inline-start" />
                Stop gateway
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={gatewayActionBusy}
                onSelect={() => onGatewayAction("restart", profile.name)}
              >
                <RotateCw data-icon="inline-start" />
                Restart gateway
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={installingAdapter}
                onSelect={() => onInstallAdapter(profile.name)}
              >
                <Wrench data-icon="inline-start" />
                {installingAdapter ? "Installing adapter..." : "Install adapter"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => openCloneDialog(profile.name)}>
                <Copy data-icon="inline-start" />
                Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                disabled={isDefaultProfile}
                title={isDefaultProfile ? "The default agent cannot be deleted" : undefined}
                onSelect={() => openDeleteDialog(profile.name)}
              >
                <Trash2 data-icon="inline-start" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="min-w-0" aria-hidden="true" />
      <div className="agent-topbar-actions">
        <Tabs
          value={section}
          onValueChange={(value) => onSectionChange(value as AgentDetailSection)}
          className="max-[760px]:hidden"
        >
          <TabsList
            aria-label={`${profile.name} sections`}
            className="h-[var(--agent-topbar-control-height,34px)] min-w-max border border-menu-border bg-secondary p-0"
          >
            {SECTION_ORDER.map((item) => (
              <TabsTrigger
                key={item}
                value={item}
                className="min-w-[76px] rounded-[7px] px-3"
              >
                {sectionLabel(item)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="appGhost"
              className="agent-topbar-section-trigger min-[761px]:hidden h-[var(--agent-topbar-control-height,28px)] gap-1.5 rounded-[8px] px-3 leading-none text-menu-hover-foreground data-[state=open]:bg-menu-hover"
              aria-label={`Section: ${sectionLabel(section)}. Switch sections.`}
              title="Switch section"
            >
              <span>{sectionLabel(section)}</span>
              <ChevronDown size={14} className="opacity-60" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="min-w-[160px]">
            {SECTION_ORDER.map((item) => (
              <DropdownMenuItem
                key={item}
                onSelect={() => onSectionChange(item)}
              >
                <span className="flex-1">{sectionLabel(item)}</span>
                {item === section ? <Check size={14} /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {dialog ? (
        <ProfileActionDialog
          dialog={dialog}
          busy={dialogBusy}
          error={dialogError}
          onCancel={closeDialog}
          onChange={setDialog}
          onSubmit={submitDialog}
        />
      ) : null}
    </div>
  );

  function openCloneDialog(source: string) {
    setDialogError("");
    setDialog({ action: "clone", source, name: nextProfileName(`${source}-copy`, profiles) });
  }

  function openDeleteDialog(source: string) {
    if (source === "default") return;
    setDialogError("");
    setDialog({ action: "delete", source, name: "" });
  }

  function closeDialog() {
    if (dialogBusy) return;
    setDialog(null);
    setDialogError("");
  }

  async function submitDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dialog || dialogBusy) return;

    const name = dialog.action === "delete" ? dialog.name.trim() : normalizeProfileName(dialog.name);
    const validationError = dialog.action === "delete" ? "" : profileNameError(name);
    if (validationError) {
      setDialogError(validationError);
      return;
    }
    if (dialog.action === "delete" && name !== dialog.source) {
      setDialogError(`Type ${dialog.source} to delete this profile.`);
      return;
    }

    setDialogBusy(true);
    setDialogError("");
    const message =
      dialog.action === "clone"
        ? await onProfileAction("clone", name, dialog.source)
        : dialog.action === "delete"
          ? await onProfileAction("delete", dialog.source, dialog.source)
          : await onProfileAction("create", name);
    setDialogBusy(false);

    if (isProfileActionFailure(message)) {
      setDialogError(message);
      return;
    }
    setDialog(null);
  }
}

function agentSubtitle(profile: HermesProfile) {
  const provider = cleanAgentLabel(profile.provider) || "Iris Core";
  const model = cleanAgentLabel(profile.model);
  const summary = model ? `${provider} / ${model}` : provider;
  return profile.active ? `${summary} · active` : summary;
}

function cleanAgentLabel(value: unknown) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed === "not configured" || trimmed.startsWith("{") || trimmed.startsWith("[")) return "";
  return trimmed;
}

function nextProfileName(base: string, profiles: HermesProfile[]) {
  const names = new Set(profiles.map((profile) => profile.name));
  if (!names.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!names.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function isProfileActionFailure(message: string) {
  return /\b(error|failed|cannot|already exists|does not exist|enter|invalid)\b/i.test(message);
}
