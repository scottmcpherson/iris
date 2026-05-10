import { offlineProfile } from "../../app/offlineProfile";
import type { ProfileActionHandler } from "../../app/types";
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
  selectedProfile: string;
  runtimeConfig: HermesRuntimeConfig;
  memory: HermesMemory | null;
  skills: HermesSkill[];
  section: AgentDetailSection;
  onDetailProfileChange: (profileName: string | null) => void;
  onSectionChange: (section: AgentDetailSection) => void;
  onSelectProfile: (profileName: string) => void;
  onRuntimeChange: (config: HermesRuntimeConfig) => void;
  onRefresh: () => void;
  onProfileAction: ProfileActionHandler;
  onSaveMemory: (file: "memory" | "user", content: string, expectedUpdatedAt?: number | null) => Promise<string>;
  onResetMemory: (file: "memory" | "user" | "all", confirm: string) => Promise<string>;
};

export function AgentsView({
  detailProfile,
  status,
  activeProfile,
  selectedProfile,
  runtimeConfig,
  memory,
  skills,
  section,
  onDetailProfileChange,
  onSectionChange,
  onSelectProfile,
  onRuntimeChange,
  onRefresh,
  onProfileAction,
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
          onProfileAction={onProfileAction}
          onOpenAgent={(profileName) => {
            onSelectProfile(profileName);
            onSectionChange("overview");
            onDetailProfileChange(profileName);
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
        selectedProfile={selectedProfile}
        runtimeConfig={runtimeConfig}
        memory={memory}
        skills={skills}
        onRuntimeChange={onRuntimeChange}
        onRefresh={onRefresh}
        onProfileAction={onProfileAction}
        onSaveMemory={onSaveMemory}
        onResetMemory={onResetMemory}
      />
    </div>
  );
}
