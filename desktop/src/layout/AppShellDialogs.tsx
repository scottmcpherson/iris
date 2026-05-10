import type { FormEvent } from "react";
import { CodeEditor } from "../shared/CodeEditor";
import type { AgentUICoreAgent } from "../lib/agentuiCore";
import type { HermesConversation } from "../types/hermes";

export type ProfileDialog =
  | { action: "create"; name: string }
  | { action: "clone"; source: string; name: string }
  | { action: "delete"; source: string; name: string };

export type ProjectDialog =
  | { action: "create"; name: string; defaultAgentId: string; systemPrompt: string }
  | { action: "edit"; projectId: string; name: string; defaultAgentId: string; systemPrompt: string };

export type ConversationDialog = {
  conversation: HermesConversation;
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
  projectAgents: AgentUICoreAgent[];
  onCancel: () => void;
  onChange: (dialog: ProjectDialog) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

type ConversationActionDialogProps = {
  dialog: ConversationDialog;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onChange: (dialog: ConversationDialog) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

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
    <div className="profile-action-modal project-action-modal" role="dialog" aria-modal="true" aria-labelledby="project-action-title">
      <form onSubmit={onSubmit}>
        <div>
          <p className="eyebrow">{isCreate ? "Project management" : "Project"}</p>
          <h2 id="project-action-title">{isCreate ? "New project" : "Edit project"}</h2>
        </div>
        <label>
          <span>Project name</span>
          <input
            autoFocus
            value={dialog.name}
            placeholder="new-project"
            onChange={(event) => onChange({ ...dialog, name: event.target.value })}
          />
        </label>
        <label>
          <span>Default agent</span>
          <select
            value={dialog.defaultAgentId}
            onChange={(event) => onChange({ ...dialog, defaultAgentId: event.target.value })}
          >
            {agentOptions.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.displayName || agent.runtimeProfile || agent.id}
              </option>
            ))}
          </select>
        </label>
        <div className="project-prompt-editor">
          <span>System prompt</span>
          <CodeEditor
            value={dialog.systemPrompt}
            onChange={(value) => onChange({ ...dialog, systemPrompt: value })}
            metadata={[
              { label: "lines", value: `${dialog.systemPrompt.split("\n").length} lines` },
              { label: "scope", value: "project only" },
            ]}
          />
        </div>
        {error ? <p className="profile-action-error">{error}</p> : null}
        <div className="profile-action-modal-actions">
          <button type="button" className="small-button settings-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="small-button settings-button" disabled={submitDisabled}>
            {busy ? "Working..." : isCreate ? "Create" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function ConversationActionDialog({
  dialog,
  busy,
  error,
  onCancel,
  onChange,
  onSubmit,
}: ConversationActionDialogProps) {
  const inputValue = dialog.name;
  const submitDisabled = busy || !inputValue.trim();

  return (
    <div className="profile-action-modal" role="dialog" aria-modal="true" aria-labelledby="conversation-action-title">
      <form onSubmit={onSubmit}>
        <div>
          <p className="eyebrow">Session</p>
          <h2 id="conversation-action-title">Rename session</h2>
        </div>
        <label>
          <span>Session name</span>
          <input
            autoFocus
            value={inputValue}
            placeholder="Session name"
            onChange={(event) => onChange({ ...dialog, name: event.target.value })}
          />
        </label>
        {error ? <p className="profile-action-error">{error}</p> : null}
        <div className="profile-action-modal-actions">
          <button type="button" className="small-button settings-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="small-button settings-button" disabled={submitDisabled}>
            {busy ? "Working..." : "Rename"}
          </button>
        </div>
      </form>
    </div>
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
  const inputValue = dialog.name;
  const submitDisabled = busy || (isDelete ? inputValue.trim() !== source : !inputValue.trim());

  return (
    <div className="profile-action-modal" role="dialog" aria-modal="true" aria-labelledby="profile-action-title">
      <form onSubmit={onSubmit}>
        <div>
          <p className="eyebrow">{isDelete ? "Agent deletion" : "Agent management"}</p>
          <h2 id="profile-action-title">{title}</h2>
        </div>
        <label>
          <span>{label}</span>
          <input
            autoFocus
            value={inputValue}
            placeholder={isDelete ? source : "agent-name"}
            onChange={(event) => onChange({ ...dialog, name: event.target.value })}
          />
        </label>
        {error ? <p className="profile-action-error">{error}</p> : null}
        <div className="profile-action-modal-actions">
          <button type="button" className="small-button settings-button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className={isDelete ? "small-button settings-button danger" : "small-button settings-button"}
            disabled={submitDisabled}
          >
            {busy ? "Working..." : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

function projectAgentOptions(agents: AgentUICoreAgent[], selectedAgentId: string) {
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
