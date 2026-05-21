import { ArrowLeft } from "lucide-react";
import { Button } from "../../shared/ui/button";
import { Tabs, TabsList, TabsTrigger } from "../../shared/ui/tabs";
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
          <h1>
            <span>{profile.name}</span>
          </h1>
        </div>
      </div>
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
