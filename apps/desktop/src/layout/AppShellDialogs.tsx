import type { FormEvent } from "react";
import { CodeEditor } from "../shared/CodeEditor";
import type { IrisCoreAgent } from "../lib/irisCore";
import { Button } from "../shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../shared/ui/dialog";
import { Input } from "../shared/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../shared/ui/select";
import type { HermesSession } from "../types/hermes";

export type ProfileDialog =
  | { action: "create"; name: string }
  | { action: "clone"; source: string; name: string }
  | { action: "delete"; source: string; name: string };

export type ProjectDialog =
  | { action: "create"; name: string; defaultAgentId: string; systemPrompt: string }
  | { action: "edit"; projectId: string; name: string; defaultAgentId: string; systemPrompt: string };

export type SessionDialog = {
  session: HermesSession;
  profileName: string;
  name: string;
};

type ProfileActionDialogProps = {
  dialog: ProfileDialog;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onChange: (dialog: ProfileDialog) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

type ProjectActionDialogProps = {
  dialog: ProjectDialog;
  busy: boolean;
  error: string;
  projectAgents: IrisCoreAgent[];
  onCancel: () => void;
  onChange: (dialog: ProjectDialog) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

type SessionActionDialogProps = {
  dialog: SessionDialog;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onChange: (dialog: SessionDialog) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

const dialogContentClassName = "border-menu-border bg-menu text-menu-foreground shadow-context-menu sm:max-w-[360px]";
const projectDialogContentClassName = "border-menu-border bg-menu text-menu-foreground shadow-context-menu sm:max-w-[560px]";
const labelClassName = "grid gap-[7px] text-xs font-[750] text-menu-muted-foreground";

export function ProjectActionDialog({
  dialog,
  busy,
  error,
  projectAgents,
  onCancel,
  onChange,
  onSubmit,
}: ProjectActionDialogProps) {
  const isCreate = dialog.action === "create";
  const submitDisabled = busy || !dialog.name.trim() || !dialog.defaultAgentId;
  const agentOptions = projectAgentOptions(projectAgents, dialog.defaultAgentId);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className={projectDialogContentClassName} showCloseButton={false}>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle className="text-lg text-menu-hover-foreground">
              {isCreate ? "New project" : "Edit project"}
            </DialogTitle>
          </DialogHeader>
          <label className={labelClassName}>
            <span>Project name</span>
            <Input
              autoFocus
              value={dialog.name}
              placeholder="new-project"
              onChange={(event) => onChange({ ...dialog, name: event.target.value })}
            />
          </label>
          <label className={labelClassName}>
            <span>Default agent</span>
            <Select
              value={dialog.defaultAgentId}
              onValueChange={(value) => onChange({ ...dialog, defaultAgentId: value })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {agentOptions.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.displayName || agent.runtimeProfile || agent.id}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </label>
          <div className="grid gap-[7px]">
            <span className="text-xs font-[750] text-menu-muted-foreground">System prompt</span>
            <CodeEditor
              className="min-h-[190px] overflow-hidden rounded-[10px] border border-menu-border bg-background/20"
              value={dialog.systemPrompt}
              onChange={(value) => onChange({ ...dialog, systemPrompt: value })}
              metadata={[
                { label: "lines", value: `${dialog.systemPrompt.split("\n").length} lines` },
                { label: "scope", value: "project only" },
              ]}
            />
          </div>
          {error ? <p className="text-xs leading-[1.45] text-menu-danger">{error}</p> : null}
          <DialogFooter className="gap-2">
            <Button type="button" variant="appNeutral" size="appSmall" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" variant={isCreate ? "default" : "appNeutral"} size="appSmall" disabled={submitDisabled}>
              {busy ? "Working..." : isCreate ? "Create" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SessionActionDialog({
  dialog,
  busy,
  error,
  onCancel,
  onChange,
  onSubmit,
}: SessionActionDialogProps) {
  const inputValue = dialog.name;
  const submitDisabled = busy || !inputValue.trim();

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className={dialogContentClassName} showCloseButton={false}>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <DialogHeader>
            <DialogDescription className="text-xs font-[750] text-menu-muted-foreground">
              Session
            </DialogDescription>
            <DialogTitle className="text-lg text-menu-hover-foreground">Rename session</DialogTitle>
          </DialogHeader>
          <label className={labelClassName}>
            <span>Session name</span>
            <Input
              autoFocus
              value={inputValue}
              placeholder="Session name"
              onChange={(event) => onChange({ ...dialog, name: event.target.value })}
            />
          </label>
          {error ? <p className="text-xs leading-[1.45] text-menu-danger">{error}</p> : null}
          <DialogFooter className="gap-2">
            <Button type="button" variant="appNeutral" size="appSmall" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" variant="default" size="appSmall" disabled={submitDisabled}>
              {busy ? "Working..." : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ProfileActionDialog({
  dialog,
  busy,
  error,
  onCancel,
  onChange,
  onSubmit,
}: ProfileActionDialogProps) {
  const isDelete = dialog.action === "delete";
  const isClone = dialog.action === "clone";
  const source = "source" in dialog ? dialog.source : "";
  const title = isDelete
    ? `Delete ${source}`
    : isClone
      ? `Duplicate ${source}`
      : "New agent";
  const label = isDelete ? "Confirm agent name" : "Agent name";
  const submitLabel = isDelete ? "Delete" : isClone ? "Duplicate" : "Create";
  const submitVariant = isDelete ? "appDanger" : isClone ? "appNeutral" : "default";
  const inputValue = dialog.name;
  const submitDisabled = busy || (isDelete ? inputValue.trim() !== source : !inputValue.trim());

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className={dialogContentClassName} showCloseButton={false}>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <DialogHeader>
            {isDelete ? (
              <DialogDescription className="text-xs font-[750] text-menu-muted-foreground">
                Agent deletion
              </DialogDescription>
            ) : null}
            <DialogTitle className="text-lg text-menu-hover-foreground">{title}</DialogTitle>
          </DialogHeader>
          <label className={labelClassName}>
            <span>{label}</span>
            <Input
              autoFocus
              value={inputValue}
              placeholder={isDelete ? source : "agent-name"}
              onChange={(event) => onChange({ ...dialog, name: event.target.value })}
            />
          </label>
          {error ? <p className="text-xs leading-[1.45] text-menu-danger">{error}</p> : null}
          <DialogFooter className="gap-2">
            <Button type="button" variant="appNeutral" size="appSmall" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={submitVariant}
              size="appSmall"
              disabled={submitDisabled}
            >
              {busy ? "Working..." : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function projectAgentOptions(agents: IrisCoreAgent[], selectedAgentId: string) {
  if (!selectedAgentId || agents.some((agent) => agent.id === selectedAgentId)) return agents;
  return [
    {
      id: selectedAgentId,
      runtimeProfile: selectedAgentId,
      displayName: selectedAgentId,
      runtimeId: "runtime_local_hermes",
      isDefault: false,
      metadata: {},
    },
    ...agents,
  ];
}
