import type { ProfileActionHandler } from "../../app/types";
import type { IrisCoreGatewayAction } from "../../lib/irisCore";
import type {
  HermesMemory,
  HermesProfile,
  HermesRuntimeConfig,
  HermesSkill,
  HermesStatus,
} from "../../types/hermes";
import { MemoryView } from "../memory/MemoryView";
import { SkillsView } from "../skills/SkillsView";
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
  skills: HermesSkill[];
  gatewayActionBusy: boolean;
  gatewayActionBusyAction: IrisCoreGatewayAction | null;
  adapterInstallBusy: boolean;
  onRefresh: () => void;
  onProfileAction: ProfileActionHandler;
  onGatewayAction: (action: IrisCoreGatewayAction) => void;
  onInstallAdapter: () => void;
  onOpenSettings: () => void;
  onSaveMemory: (file: "memory" | "user", content: string, expectedUpdatedAt?: number | null) => Promise<string>;
  onResetMemory: (file: "memory" | "user" | "all", confirm: string) => Promise<string>;
};

export function AgentDetailView({
  section,
  status,
  profile,
  selectedProfile,
  runtimeConfig,
  memory,
  skills,
  gatewayActionBusy,
  gatewayActionBusyAction,
  adapterInstallBusy,
  onRefresh,
  onProfileAction,
  onGatewayAction,
  onInstallAdapter,
  onOpenSettings,
  onSaveMemory,
  onResetMemory,
}: AgentDetailViewProps) {
  if (section === "memory") {
    return (
      <AgentContentFrame layout="workbench">
        <MemoryView
          memory={memory}
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
      <AgentContentFrame layout="workbench">
        <SkillsView
          profile={selectedProfile}
          runtimeConfig={runtimeConfig}
          skills={skills}
          onRefresh={onRefresh}
        />
      </AgentContentFrame>
    );
  }

  return (
    <AgentContentFrame layout="record" className="agent-detail-workspace">
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
