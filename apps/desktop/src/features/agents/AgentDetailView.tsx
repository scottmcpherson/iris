import type { ProfileActionHandler } from "../../app/types";
import type { IrisCoreGatewayAction } from "../../lib/irisCore";
import { useMemoryQuery } from "../../lib/query";
import type {
  HermesMemory,
  HermesMemoryResetExpectations,
  HermesProfile,
  HermesRuntimeConfig,
  HermesStatus,
} from "../../types/hermes";
import { MemoryView } from "../memory/MemoryView";
import { SkillsView } from "../skills/SkillsView";
import { AgentConfigurationView } from "./AgentConfigurationView";
import { AgentContentFrame } from "./AgentContentFrame";
import { AgentOverviewView } from "./AgentOverviewView";
import type { AgentDetailSection } from "./types";

type AgentDetailViewProps = {
  section: AgentDetailSection;
  status: HermesStatus | null;
  profile: HermesProfile;
  selectedProfile: string;
  runtimeConfig: HermesRuntimeConfig;
  memory: HermesMemory | null;
  gatewayActionBusy: boolean;
  gatewayActionBusyAction: IrisCoreGatewayAction | null;
  adapterInstallBusy: boolean;
  onRefresh: () => void | Promise<void>;
  onOpenAgentProfile: (profileName: string) => void;
  onProfileSkillsChanged: (profileName: string) => void;
  onProfileAction: ProfileActionHandler;
  onGatewayAction: (action: IrisCoreGatewayAction) => void;
  onInstallAdapter: () => void;
  onOpenSettings: () => void;
  onSaveMemory: (
    file: "memory" | "user",
    content: string,
    expectedUpdatedAt?: number | null,
    expectedContentHash?: string | null,
  ) => Promise<string>;
  onResetMemory: (
    file: "memory" | "user" | "all",
    confirm: string,
    expectations?: HermesMemoryResetExpectations,
  ) => Promise<string>;
};

export function AgentDetailView({
  section,
  status,
  profile,
  selectedProfile,
  runtimeConfig,
  memory,
  gatewayActionBusy,
  gatewayActionBusyAction,
  adapterInstallBusy,
  onRefresh,
  onOpenAgentProfile,
  onProfileSkillsChanged,
  onProfileAction,
  onGatewayAction,
  onInstallAdapter,
  onOpenSettings,
  onSaveMemory,
  onResetMemory,
}: AgentDetailViewProps) {
  const detailMemoryQuery = useMemoryQuery(
    runtimeConfig,
    selectedProfile,
    Boolean(status?.connected && selectedProfile && section === "memory"),
  );
  const detailMemory =
    detailMemoryQuery.data ?? (memory?.profile === selectedProfile ? memory : null);

  if (section === "memory") {
    return (
      <AgentContentFrame layout="workbench">
        <MemoryView
          memory={detailMemory}
          profile={selectedProfile}
          status={status}
          onResetMemory={onResetMemory}
          onSaveMemory={onSaveMemory}
        />
      </AgentContentFrame>
    );
  }

  if (section === "skills") {
    return (
      <AgentContentFrame layout="workbench" fillsHeight>
        <SkillsView
          profile={selectedProfile}
          runtimeConfig={runtimeConfig}
          connected={Boolean(status?.connected)}
          onProfileSkillsChanged={onProfileSkillsChanged}
        />
      </AgentContentFrame>
    );
  }

  if (section === "configuration") {
    return (
      <AgentContentFrame layout="workbench">
        <AgentConfigurationView
          profile={selectedProfile}
          runtimeConfig={runtimeConfig}
          connected={Boolean(status?.connected)}
          onRefresh={onRefresh}
          onOpenProfile={onOpenAgentProfile}
        />
      </AgentContentFrame>
    );
  }

  return (
    <AgentContentFrame layout="record" className="content-start">
      <AgentOverviewView
        status={status}
        profile={profile}
        selectedProfile={profile.name}
        runtimeConfig={runtimeConfig}
        gatewayActionBusy={gatewayActionBusy}
        gatewayActionBusyAction={gatewayActionBusyAction}
        adapterInstallBusy={adapterInstallBusy}
        onRefresh={onRefresh}
        onProfileAction={onProfileAction}
        onGatewayAction={onGatewayAction}
        onInstallAdapter={onInstallAdapter}
        onOpenSettings={onOpenSettings}
      />
    </AgentContentFrame>
  );
}
