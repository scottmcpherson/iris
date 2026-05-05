import { ArrowLeft, Bot } from "lucide-react";
import type { HermesProfile } from "../../types/hermes";
import type { AgentDetailSection } from "./types";

type AgentTopbarProps = {
  detailProfile: string | null;
  profile: HermesProfile;
  rootPath: string;
  section: AgentDetailSection;
  onBack: () => void;
  onSectionChange: (section: AgentDetailSection) => void;
};

export function AgentTopbar({
  detailProfile,
  profile,
  rootPath,
  section,
  onBack,
  onSectionChange,
}: AgentTopbarProps) {
  if (!detailProfile) {
    return (
      <div className="agent-topbar agent-topbar-list">
        <div className="topbar-title">
          <p>Agents</p>
          <span>{rootPath}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-topbar agent-topbar-detail">
      <button type="button" className="icon-button" title="All agents" onClick={onBack}>
        <ArrowLeft size={16} />
      </button>
      <div className="agent-detail-title">
        <span className="agent-avatar">
          <Bot size={18} />
        </span>
        <div>
          <p className="eyebrow">Agents / {profile.name}</p>
          <h1>{profile.name}</h1>
        </div>
      </div>
      <div className="agent-topbar-actions">
        <div className="agent-section-tabs" role="tablist" aria-label={`${profile.name} sections`}>
          {(["overview", "memory", "skills"] as AgentDetailSection[]).map((item) => (
            <button
              type="button"
              key={item}
              className={section === item ? "active" : ""}
              onClick={() => onSectionChange(item)}
            >
              {item}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
