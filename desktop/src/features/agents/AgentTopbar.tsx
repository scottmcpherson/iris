import { Bot, Check, ChevronDown, Settings2 } from "lucide-react";
import {
  agentRuntimeReadinessForStatus,
  runtimeReadinessShortLabel,
  runtimeReadinessTone,
} from "../../app/runtimeReadiness";
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
import type { HermesProfile, HermesStatus } from "../../types/hermes";
import type { AgentDetailSection } from "./types";

type AgentTopbarProps = {
  detailProfile: string | null;
  profile: HermesProfile;
  profiles: HermesProfile[];
  status: HermesStatus | null;
  section: AgentDetailSection;
  onSwitchAgent: (profileName: string) => void;
  onManageAgents: () => void;
  onSectionChange: (section: AgentDetailSection) => void;
};

export function AgentTopbar({
  detailProfile,
  profile,
  profiles,
  status,
  section,
  onSwitchAgent,
  onManageAgents,
  onSectionChange,
}: AgentTopbarProps) {
  if (!detailProfile) {
    return <div className="agent-topbar agent-topbar-list" aria-hidden="true" />;
  }

  return (
    <div className="agent-topbar agent-topbar-detail">
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
            <span className="agent-switcher-trigger-name">{profile.name}</span>
            <ChevronDown size={14} className="agent-switcher-trigger-chevron" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={6} className="agent-switcher-menu">
          <DropdownMenuGroup>
            {profiles.map((item) => {
              const readiness = agentRuntimeReadinessForStatus(status, item);
              const tone = runtimeReadinessTone(readiness);
              const isCurrent = item.name === profile.name;
              return (
                <DropdownMenuItem
                  key={item.name}
                  className="agent-switcher-item"
                  onSelect={() => {
                    if (!isCurrent) onSwitchAgent(item.name);
                  }}
                >
                  <span className="agent-switcher-item-avatar" aria-hidden="true">
                    <Bot size={14} />
                  </span>
                  <span className="agent-switcher-item-main">
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
          <DropdownMenuItem className="agent-switcher-manage" onSelect={onManageAgents}>
            <Settings2 data-icon="inline-start" size={14} />
            Manage agents…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="agent-topbar-spacer" aria-hidden="true" />
      <div className="agent-topbar-actions">
        <Tabs value={section} onValueChange={(value) => onSectionChange(value as AgentDetailSection)}>
          <TabsList
            aria-label={`${profile.name} sections`}
            className="h-[var(--agent-topbar-control-height,34px)] min-w-max border border-menu-border bg-secondary p-0"
          >
            {(["overview", "memory", "skills", "configuration"] as AgentDetailSection[]).map((item) => (
              <TabsTrigger
                key={item}
                value={item}
                className="min-w-[76px] rounded-[7px] px-3 capitalize"
              >
                {item === "configuration" ? "Config" : item}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
    </div>
  );
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
