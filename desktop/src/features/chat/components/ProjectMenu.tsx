import { ChevronDown, Folder } from "lucide-react";
import type { IrisProject } from "../../../lib/irisCore";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../shared/ui/dropdown-menu";
import { Button } from "../../../shared/ui/button";

const NO_PROJECT_VALUE = "__no-project__";

type ProjectMenuProps = {
  projects: IrisProject[];
  selectedProjectId: string | null;
  open: boolean;
  disabled: boolean;
  title: string;
  locked: boolean;
  connected: boolean;
  side?: "top" | "bottom";
  onOpenChange: (open: boolean) => void;
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
  side = "top",
  onOpenChange,
  onSelect,
}: ProjectMenuProps) {
  const selectedProject = projects.find((project) => project.id === selectedProjectId) || null;
  const label = selectedProject?.name || "No project";

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="composerAccess"
          size="composerAccess"
          title={title}
          aria-label={
            locked
              ? `Session project ${label}`
              : `Project ${connected ? label : "Offline"}`
          }
          disabled={disabled}
        >
          <Folder data-icon="inline-start" />
          <span className="flex-1 text-left">{connected ? label : "Offline"}</span>
          <ChevronDown data-icon="inline-end" className="ml-auto" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side={side}
        sideOffset={side === "top" ? 10 : 8}
        className="max-w-[min(280px,62vw)] min-w-[178px]"
      >
        <DropdownMenuLabel>Projects</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={selectedProjectId || NO_PROJECT_VALUE}
          onValueChange={(value) => onSelect(value === NO_PROJECT_VALUE ? null : value)}
        >
          {projects.map((project) => (
            <DropdownMenuRadioItem key={project.id} value={project.id}>
              {project.name}
            </DropdownMenuRadioItem>
          ))}
          {projects.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuRadioItem value={NO_PROJECT_VALUE}>No project</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
