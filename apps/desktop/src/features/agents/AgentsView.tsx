import "./agents.css";
import { offlineProfile } from "../../app/offlineProfile";
import type { ProfileActionHandler } from "../../app/types";
import type { IrisCoreGatewayAction } from "../../lib/irisCore";
import type {
  HermesMemory,
  HermesMemoryResetExpectations,
  HermesProfile,
  HermesRuntimeConfig,
  HermesStatus,
} from "../../types/hermes";
import { AgentDetailView } from "./AgentDetailView";
import type { AgentDetailSection } from "./types";

type AgentsViewProps = {
  detailProfile: string | null;
  status: HermesStatus | null;
  activeProfile: HermesProfile;
  runtimeConfig: HermesRuntimeConfig;
  memory: HermesMemory | null;
  section: AgentDetailSection;
  gatewayActionBusy: boolean;
  gatewayActionBusyAction: IrisCoreGatewayAction | null;
  adapterInstallBusyProfile: string;
  onDetailProfileChange: (profileName: string | null) => void;
  onSectionChange: (section: AgentDetailSection) => void;
  onOpenAgent: (profileName: string) => void;
  onRefresh: () => void;
  onProfileSkillsChanged: (profileName: string) => void;
  onProfileAction: ProfileActionHandler;
  onGatewayAction: (action: IrisCoreGatewayAction, profileName: string) => void;
  onInstallAdapter: (profileName: string) => void;
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

export function AgentsView({
  detailProfile,
  status,
  activeProfile,
  runtimeConfig,
  memory,
  section,
  gatewayActionBusy,
  gatewayActionBusyAction,
  adapterInstallBusyProfile,
  onDetailProfileChange,
  onSectionChange,
  onOpenAgent,
  onRefresh,
  onProfileSkillsChanged,
  onProfileAction,
  onGatewayAction,
  onInstallAdapter,
  onOpenSettings,
  onSaveMemory,
  onResetMemory,
}: AgentsViewProps) {
  const profiles = status?.profiles?.length ? status.profiles : [offlineProfile];
  const detailAgentProfile =
    profiles.find((profile) => profile.name === detailProfile) ?? activeProfile;

  return (
    <div className="tool-view agents-workspace grid min-h-0 gap-[18px] overflow-auto">
      <AgentDetailView
        section={section}
        status={status}
        profile={detailAgentProfile}
        selectedProfile={detailAgentProfile.name}
        runtimeConfig={runtimeConfig}
        memory={memory}
        gatewayActionBusy={gatewayActionBusy}
        gatewayActionBusyAction={gatewayActionBusyAction}
        adapterInstallBusy={adapterInstallBusyProfile === detailAgentProfile.name}
        onRefresh={onRefresh}
        onOpenAgentProfile={(profileName) => {
          onDetailProfileChange(profileName);
          onOpenAgent(profileName);
          onSectionChange("overview");
        }}
        onProfileSkillsChanged={onProfileSkillsChanged}
        onProfileAction={onProfileAction}
        onGatewayAction={(action) => onGatewayAction(action, detailAgentProfile.name)}
        onInstallAdapter={() => onInstallAdapter(detailAgentProfile.name)}
        onOpenSettings={onOpenSettings}
        onSaveMemory={onSaveMemory}
        onResetMemory={onResetMemory}
      />
    </div>
  );
}
