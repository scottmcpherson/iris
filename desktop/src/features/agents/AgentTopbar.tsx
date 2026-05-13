import { ArrowLeft } from "lucide-react";
import { Button } from "../../shared/ui/button";
import type { HermesProfile } from "../../types/hermes";
import type { AgentDetailSection } from "./types";

type AgentTopbarProps = {
  detailProfile: string | null;
  profile: HermesProfile;
  section: AgentDetailSection;
  onBack: () => void;
  onSectionChange: (section: AgentDetailSection) => void;
};

export function AgentTopbar({
  detailProfile,
  profile,
  section,
  onBack,
  onSectionChange,
}: AgentTopbarProps) {
  if (!detailProfile) {
    return <div className="agent-topbar agent-topbar-list" aria-hidden="true" />;
  }

  return (
    <div className="agent-topbar agent-topbar-detail">
      <Button type="button" variant="appIcon" size="icon-md" title="All agents" onClick={onBack}>
        <ArrowLeft size={16} />
      </Button>
      <div className="agent-detail-title">
        <div>
          <p className="eyebrow">Agents / {profile.name}</p>
          <h1>{profile.name}</h1>
        </div>
      </div>
      <div className="agent-topbar-actions">
        <div className="agent-section-tabs" role="tablist" aria-label={`${profile.name} sections`}>
          {(["overview", "memory", "skills"] as AgentDetailSection[]).map((item) => (
            <Button
              type="button"
              key={item}
              variant="ghost"
              size="sm"
              className={section === item ? "active" : ""}
              onClick={() => onSectionChange(item)}
            >
              {item}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
