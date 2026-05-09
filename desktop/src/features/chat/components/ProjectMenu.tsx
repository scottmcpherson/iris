import { Check, ChevronDown, Folder } from "lucide-react";
import type { IrisProject } from "../../../lib/agentuiCore";

type ProjectMenuProps = {
  projects: IrisProject[];
  selectedProjectId: string | null;
  open: boolean;
  disabled: boolean;
  title: string;
  locked: boolean;
  connected: boolean;
  onToggle: () => void;
  onSelect: (projectId: string | null) => void;
};

export function ProjectMenu({
  projects,
  selectedProjectId,
  open,
  disabled,
  title,
  locked,
  connected,
  onToggle,
  onSelect,
}: ProjectMenuProps) {
  const selectedProject = projects.find((project) => project.id === selectedProjectId) || null;
  const label = selectedProject?.name || "No project";

  return (
    <>
      <button
        type="button"
        className="composer-access-button"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={
          locked
            ? `Conversation project ${label}`
            : `Project ${connected ? label : "Offline"}`
        }
        disabled={disabled}
        onClick={onToggle}
      >
        <Folder size={15} />
        <span>{connected ? label : "Offline"}</span>
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div className="composer-project-menu" role="menu" aria-label="Choose project">
          <div className="composer-menu-header" role="presentation">Projects</div>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!selectedProjectId}
            onClick={() => onSelect(null)}
          >
            <span>No project</span>
            {!selectedProjectId ? <Check size={14} /> : null}
          </button>
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              role="menuitemradio"
              aria-checked={project.id === selectedProjectId}
              onClick={() => onSelect(project.id)}
            >
              <span>{project.name}</span>
              {project.id === selectedProjectId ? <Check size={14} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
