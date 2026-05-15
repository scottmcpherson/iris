import type { ProfileActionHandler } from "../../app/types";
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
  onRuntimeChange: (config: HermesRuntimeConfig) => void;
  onRefresh: () => void;
  onProfileAction: ProfileActionHandler;
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
  onRuntimeChange,
  onRefresh,
  onProfileAction,
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
            selectedProfile={selectedProfile}
            runtimeConfig={runtimeConfig}
            mode="profile"
            onRuntimeChange={onRuntimeChange}
            onRefresh={onRefresh}
            onProfileAction={onProfileAction}
            onOpenSettings={onOpenSettings}
          />
        </div>
      </div>
    </div>
  );
}
