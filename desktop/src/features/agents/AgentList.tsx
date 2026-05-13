import { useState } from "react";
import type { FormEvent } from "react";
import { Bot, Copy, Database, Ellipsis, FolderOpen, Plus, Sparkles, Trash2 } from "lucide-react";
import type { ProfileActionHandler } from "../../app/types";
import { formatBytes } from "../../shared/format";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../shared/ui/dropdown-menu";
import { Button } from "../../shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/dialog";
import { Input } from "../../shared/ui/input";
import type { HermesProfile } from "../../types/hermes";

type AgentListDialog =
  | { action: "create"; name: string }
  | { action: "clone"; source: string; name: string }
  | { action: "delete"; source: string; name: string };

type AgentListProps = {
  profiles: HermesProfile[];
  onOpenAgent: (profileName: string) => void;
  onProfileAction: ProfileActionHandler;
};

const dialogContentClassName = "border-menu-border bg-menu text-menu-foreground shadow-context-menu sm:max-w-[360px]";
const labelClassName = "grid gap-[7px] text-xs font-[750] text-menu-muted-foreground";
const inputClassName = "h-[38px] border-menu-border bg-secondary text-menu-hover-foreground placeholder:text-menu-muted-foreground";

export function AgentList({ profiles, onOpenAgent, onProfileAction }: AgentListProps) {
  const [dialog, setDialog] = useState<AgentListDialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  return (
    <div className="agent-list-workspace">
      <div className="agent-list-header">
        <div>
          <h1>Agent Profiles</h1>
        </div>
        <Button
          type="button"
          size="icon-md"
          aria-label="Create agent"
          title="Create agent"
          onClick={openCreateDialog}
        >
          <Plus data-icon="inline-start" />
        </Button>
      </div>

      <div className="agent-list-grid">
        {profiles.map((profile) => (
          <div
            key={profile.name}
            className="agent-list-row"
          >
            <Button
              type="button"
              variant="ghost"
              className="agent-list-row-open"
              onClick={() => onOpenAgent(profile.name)}
            >
              <span className="agent-avatar">
                <Bot size={18} />
              </span>
              <span className="agent-list-main">
                <strong>{profile.name}</strong>
                <small>{agentSubtitle(profile)}</small>
              </span>
              <span className="agent-list-stat">
                <FolderOpen size={15} />
                <strong>{profile.sessionCount}</strong>
                <small>Sessions</small>
              </span>
              <span className="agent-list-stat">
                <Database size={15} />
                <strong>{formatBytes(profile.memoryBytes)}</strong>
                <small>Memory</small>
              </span>
              <span className="agent-list-stat">
                <Sparkles size={15} />
                <strong>{profile.skillCount}</strong>
                <small>Skills</small>
              </span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="profile-row-action agent-list-menu-trigger"
                  aria-label={`More actions for ${profile.name}`}
                  title={`More actions for ${profile.name}`}
                  onClick={(event) => event.stopPropagation()}
                >
                  <Ellipsis size={18} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={6}>
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={() => openCloneDialog(profile.name)}>
                    <Copy data-icon="inline-start" />
                    Duplicate
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={profile.name === "default"}
                    title={profile.name === "default" ? "The default agent cannot be deleted" : undefined}
                    onSelect={() => openDeleteDialog(profile.name)}
                  >
                    <Trash2 data-icon="inline-start" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </div>
      {dialog ? renderDialog() : null}
    </div>
  );

  function openCreateDialog() {
    setError("");
    setDialog({ action: "create", name: nextProfileName("new-agent", profiles) });
  }

  function openCloneDialog(source: string) {
    setError("");
    setDialog({ action: "clone", source, name: nextProfileName(`${source}-copy`, profiles) });
  }

  function openDeleteDialog(source: string) {
    if (source === "default") return;
    setError("");
    setDialog({ action: "delete", source, name: "" });
  }

  function closeDialog() {
    if (busy) return;
    setDialog(null);
    setError("");
  }

  function renderDialog() {
    if (!dialog) return null;
    const isDelete = dialog.action === "delete";
    const isClone = dialog.action === "clone";
    const source = "source" in dialog ? dialog.source : "";
    const title = isDelete ? `Delete ${source}` : isClone ? `Duplicate ${source}` : "New agent";
    const label = isDelete ? "Confirm agent name" : "Agent name";
    const submitLabel = isDelete ? "Delete" : isClone ? "Duplicate" : "Create";
    const disabled = busy || (isDelete ? dialog.name.trim() !== source : !dialog.name.trim());

    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent className={dialogContentClassName} showCloseButton={false}>
          <form className="grid gap-4" onSubmit={submitDialog}>
            <DialogHeader>
              <DialogDescription className="text-xs font-[750] text-menu-muted-foreground">
                {isDelete ? "Agent deletion" : "Agent management"}
              </DialogDescription>
              <DialogTitle className="text-lg text-menu-hover-foreground">{title}</DialogTitle>
            </DialogHeader>
            <label className={labelClassName}>
              <span>{label}</span>
              <Input
                autoFocus
                className={inputClassName}
                value={dialog.name}
                placeholder={isDelete ? source : "agent-name"}
                onChange={(event) => setDialog({ ...dialog, name: event.target.value })}
              />
            </label>
            {error ? <p className="text-xs leading-[1.45] text-menu-danger">{error}</p> : null}
            <DialogFooter className="gap-2">
              <Button type="button" variant="appNeutral" size="appSmall" onClick={closeDialog}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant={isDelete ? "appDanger" : "appNeutral"}
                size="appSmall"
                disabled={disabled}
              >
                {busy ? "Working..." : submitLabel}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    );
  }

  async function submitDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dialog || busy) return;

    const name = dialog.name.trim();
    if (dialog.action !== "delete" && !name) {
      setError("Enter an agent name.");
      return;
    }
    if (dialog.action === "delete" && name !== dialog.source) {
      setError(`Type ${dialog.source} to delete this profile.`);
      return;
    }

    setBusy(true);
    setError("");
    const message =
      dialog.action === "clone"
        ? await onProfileAction("clone", name, dialog.source)
        : dialog.action === "delete"
          ? await onProfileAction("delete", dialog.source, dialog.source)
          : await onProfileAction("create", name);
    setBusy(false);

    if (isProfileActionFailure(message)) {
      setError(message);
      return;
    }
    setDialog(null);
  }
}

function nextProfileName(base: string, profiles: HermesProfile[]) {
  const names = new Set(profiles.map((profile) => profile.name));
  if (!names.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!names.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function agentSubtitle(profile: HermesProfile) {
  const provider = cleanAgentLabel(profile.provider) || "Iris Core";
  const model = cleanAgentLabel(profile.model);
  const summary = model ? `${provider} / ${model}` : provider;
  return profile.active ? `${summary} / active` : summary;
}

function cleanAgentLabel(value: unknown) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed === "not configured" || trimmed.startsWith("{") || trimmed.startsWith("[")) return "";
  return trimmed;
}

function isProfileActionFailure(message: string) {
  return /\b(error|failed|cannot|already exists|does not exist|enter|invalid)\b/i.test(message);
}
