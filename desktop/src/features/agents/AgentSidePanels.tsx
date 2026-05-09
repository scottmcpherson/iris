import { Database, Sparkles } from "lucide-react";
import { formatBytes } from "../../shared/format";
import type { HermesMemory, HermesMemoryFile, HermesSkill } from "../../types/hermes";

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
          <small>Memory overview</small>
        </span>
      </button>
      <div className="agent-side-list">
        {files.map((file) => (
          <button key={file.name} type="button" className="agent-side-row" onClick={onOpen}>
            <Database size={14} />
            <span>
              <strong>{file.name}</strong>
              <small>{memoryFileMeta(file)}</small>
            </span>
            <em>{file.exists ? formatBytes(file.bytes) : "Not created"}</em>
          </button>
        ))}
      </div>
    </section>
  );
}

export function AgentSkillsPanel({ skills, onOpen }: AgentSkillsPanelProps) {
  const previewSkills = [...skills]
    .sort((left, right) => skillSortLabel(left).localeCompare(skillSortLabel(right)))
    .slice(0, 5);

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
          <small>Skills overview</small>
        </span>
      </button>
      <div className="agent-side-list">
        {previewSkills.length ? (
          previewSkills.map((skill) => (
            <button key={skill.path || skill.id || skill.name} type="button" className="agent-side-row" onClick={onOpen}>
              <Sparkles size={14} />
              <span>
                <strong>{skill.name}</strong>
                <small>{skill.category || skill.source}</small>
              </span>
              <em>{skill.source}</em>
            </button>
          ))
        ) : (
          <p className="agent-empty-note">No installed skills.</p>
        )}
      </div>
    </section>
  );
}

function memoryFileMeta(file: HermesMemoryFile) {
  if (!file.exists) return "Not created";
  const updated = file.updatedAt ? formatPanelTime(file.updatedAt) : "Not updated";
  return `${updated} · ${formatBytes(file.bytes)}`;
}

function formatPanelTime(value: number) {
  return new Date(value * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function skillSortLabel(skill: HermesSkill) {
  return `${skill.name || skill.id || skill.path}`.toLowerCase();
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
