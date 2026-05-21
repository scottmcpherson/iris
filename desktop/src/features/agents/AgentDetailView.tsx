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
import { SettingsView } from "../settings/SettingsView";
import { SkillsView } from "../skills/SkillsView";
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
  onRuntimeChange: (config: HermesRuntimeConfig) => void;
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
  onRuntimeChange,
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
      <div className="agent-subview">
        <MemoryView
          memory={memory}
          profile={selectedProfile}
          status={status}
          onResetMemory={onResetMemory}
          onSaveMemory={onSaveMemory}
        />
      </div>
    );
  }

  if (section === "skills") {
    return (
      <div className="agent-subview">
        <SkillsView
          profile={selectedProfile}
          runtimeConfig={runtimeConfig}
          skills={skills}
          onRefresh={onRefresh}
        />
      </div>
    );
  }

  return (
    <div className="agent-detail-workspace">
      <div className="agent-detail-grid agent-detail-grid-single">
        <div className="agent-detail-main">
          <SettingsView
            status={status}
            profile={profile}
            selectedProfile={profile.name}
            runtimeConfig={runtimeConfig}
            mode="profile"
            gatewayActionBusy={gatewayActionBusy}
            gatewayActionBusyAction={gatewayActionBusyAction}
            adapterInstallBusy={adapterInstallBusy}
            onRuntimeChange={onRuntimeChange}
            onRefresh={onRefresh}
            onProfileAction={onProfileAction}
            onGatewayAction={onGatewayAction}
            onInstallAdapter={onInstallAdapter}
            onOpenSettings={onOpenSettings}
          />
        </div>
      </div>
    </div>
  );
}
