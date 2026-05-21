import { offlineProfile } from "../../app/offlineProfile";
import type { ProfileActionHandler } from "../../app/types";
import type { IrisCoreGatewayAction } from "../../lib/irisCore";
import type {
  HermesMemory,
  HermesProfile,
  HermesRuntimeConfig,
  HermesSkill,
  HermesStatus,
} from "../../types/hermes";
import { AgentDetailView } from "./AgentDetailView";
import { AgentList } from "./AgentList";
import type { AgentDetailSection } from "./types";

type AgentsViewProps = {
  detailProfile: string | null;
  status: HermesStatus | null;
  activeProfile: HermesProfile;
  runtimeConfig: HermesRuntimeConfig;
  memory: HermesMemory | null;
  skills: HermesSkill[];
  section: AgentDetailSection;
  gatewayActionBusy: boolean;
  gatewayActionBusyAction: IrisCoreGatewayAction | null;
  gatewayActionBusyProfile: string;
  adapterInstallBusyProfile: string;
  onDetailProfileChange: (profileName: string | null) => void;
  onSectionChange: (section: AgentDetailSection) => void;
  onOpenAgent: (profileName: string) => void;
  onRefresh: () => void;
  onProfileAction: ProfileActionHandler;
  onGatewayAction: (action: IrisCoreGatewayAction, profileName: string) => void;
  onInstallAdapter: (profileName: string) => void;
  onOpenSettings: () => void;
  onSaveMemory: (file: "memory" | "user", content: string, expectedUpdatedAt?: number | null) => Promise<string>;
  onResetMemory: (file: "memory" | "user" | "all", confirm: string) => Promise<string>;
};

export function AgentsView({
  detailProfile,
  status,
  activeProfile,
  runtimeConfig,
  memory,
  skills,
  section,
  gatewayActionBusy,
  gatewayActionBusyAction,
  gatewayActionBusyProfile,
  adapterInstallBusyProfile,
  onDetailProfileChange,
  onSectionChange,
  onOpenAgent,
  onRefresh,
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

  if (!detailProfile) {
    return (
      <div className="tool-view agents-workspace">
        <AgentList
          profiles={profiles}
          status={status}
          gatewayActionBusy={gatewayActionBusy}
          gatewayActionBusyAction={gatewayActionBusyAction}
          gatewayActionBusyProfile={gatewayActionBusyProfile}
          adapterInstallBusyProfile={adapterInstallBusyProfile}
          onProfileAction={onProfileAction}
          onGatewayAction={onGatewayAction}
          onInstallAdapter={onInstallAdapter}
          onOpenAgent={(profileName) => {
            onSectionChange("overview");
            onDetailProfileChange(profileName);
            onOpenAgent(profileName);
          }}
        />
      </div>
    );
  }

  return (
    <div className="tool-view agents-workspace">
      <AgentDetailView
        section={section}
        status={status}
        profile={detailAgentProfile}
        selectedProfile={detailAgentProfile.name}
        runtimeConfig={runtimeConfig}
        memory={memory}
        skills={skills}
        gatewayActionBusy={gatewayActionBusy}
        gatewayActionBusyAction={gatewayActionBusyAction}
        adapterInstallBusy={adapterInstallBusyProfile === detailAgentProfile.name}
        onRefresh={onRefresh}
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
