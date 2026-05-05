import { Database, Sparkles } from "lucide-react";
import { formatBytes } from "../../shared/format";
import type { HermesMemory, HermesSkill } from "../../types/hermes";

type AgentMemoryPanelProps = {
  memory: HermesMemory | null;
  onOpen: () => void;
};

type AgentSkillsPanelProps = {
  skills: HermesSkill[];
  onOpen: () => void;
};

export function AgentMemoryPanel({ memory, onOpen }: AgentMemoryPanelProps) {
  const files = [
    memory?.memory ?? emptyMemoryFile("MEMORY.md"),
    memory?.user ?? emptyMemoryFile("USER.md"),
  ];
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);

  return (
    <section className="agent-side-panel">
      <header>
        <div>
          <Database size={16} />
          <p>Memory</p>
        </div>
        <button type="button" className="small-button settings-button" onClick={onOpen}>
          Open
        </button>
      </header>
      <button type="button" className="agent-side-summary" onClick={onOpen}>
        <Database size={15} />
        <span>
          <strong>
            {files.length} files, {formatBytes(totalBytes)}
          </strong>
          <small>Open memory files</small>
        </span>
      </button>
    </section>
  );
}

export function AgentSkillsPanel({ skills, onOpen }: AgentSkillsPanelProps) {
  return (
    <section className="agent-side-panel agent-skills-panel">
      <header>
        <div>
          <Sparkles size={16} />
          <p>Skills</p>
        </div>
        <button type="button" className="small-button settings-button" onClick={onOpen}>
          Open
        </button>
      </header>
      <button type="button" className="agent-side-summary" onClick={onOpen}>
        <Sparkles size={15} />
        <span>
          <strong>
            {skills.length} {skills.length === 1 ? "installed skill" : "installed skills"}
          </strong>
          <small>Open skills library</small>
        </span>
      </button>
    </section>
  );
}

function emptyMemoryFile(name: string) {
  return {
    name,
    path: "",
    exists: false,
    updatedAt: null,
    bytes: 0,
    content: "",
  };
}
