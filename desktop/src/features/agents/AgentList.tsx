import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Bot, Copy, Database, Ellipsis, FolderOpen, Plus, Sparkles, Trash2 } from "lucide-react";
import type { ProfileActionHandler } from "../../app/types";
import { formatBytes } from "../../shared/format";
import type { HermesProfile } from "../../types/hermes";

type AgentListDialog =
  | { action: "create"; name: string }
  | { action: "clone"; source: string; name: string }
  | { action: "delete"; source: string; name: string };

type AgentListMenu = {
  profile: string;
  top: number;
  left: number;
};

type AgentListProps = {
  profiles: HermesProfile[];
  onOpenAgent: (profileName: string) => void;
  onProfileAction: ProfileActionHandler;
};

export function AgentList({ profiles, onOpenAgent, onProfileAction }: AgentListProps) {
  const [menu, setMenu] = useState<AgentListMenu | null>(null);
  const [dialog, setDialog] = useState<AgentListDialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!menu) return undefined;

    const closeMenu = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".agent-list-menu-trigger, .profile-context-menu")) return;
      setMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    const closeOnLayoutChange = () => setMenu(null);

    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnLayoutChange);
    window.addEventListener("scroll", closeOnLayoutChange, true);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnLayoutChange);
      window.removeEventListener("scroll", closeOnLayoutChange, true);
    };
  }, [menu]);

  return (
    <div className="agent-list-workspace">
      <div className="agent-list-header">
        <div>
          <p className="eyebrow">Agents</p>
          <h1>{profiles.length} {profiles.length === 1 ? "agent" : "agents"}</h1>
        </div>
        <button
          type="button"
          className="icon-button agent-list-add-button"
          aria-label="Create agent"
          title="Create agent"
          onClick={openCreateDialog}
        >
          <Plus size={17} />
        </button>
      </div>

      <div className="agent-list-grid">
        {profiles.map((profile) => (
          <div
            key={profile.name}
            className="agent-list-row"
          >
            <button
              type="button"
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
            </button>
            <button
              type="button"
              className="profile-row-action agent-list-menu-trigger"
              aria-label={`More actions for ${profile.name}`}
              aria-haspopup="menu"
              aria-expanded={menu?.profile === profile.name}
              title={`More actions for ${profile.name}`}
              onClick={(event) => toggleMenu(profile.name, event.currentTarget)}
            >
              <Ellipsis size={18} />
            </button>
          </div>
        ))}
      </div>
      {menu ? renderMenu() : null}
      {dialog ? renderDialog() : null}
    </div>
  );

  function openCreateDialog() {
    setError("");
    setMenu(null);
    setDialog({ action: "create", name: nextProfileName("new-agent", profiles) });
  }

  function openCloneDialog(source: string) {
    setError("");
    setMenu(null);
    setDialog({ action: "clone", source, name: nextProfileName(`${source}-copy`, profiles) });
  }

  function openDeleteDialog(source: string) {
    if (source === "default") return;
    setError("");
    setMenu(null);
    setDialog({ action: "delete", source, name: "" });
  }

  function closeDialog() {
    if (busy) return;
    setDialog(null);
    setError("");
  }

  function toggleMenu(profileName: string, trigger: HTMLElement) {
    setMenu((current) => {
      if (current?.profile === profileName) return null;
      const rect = trigger.getBoundingClientRect();
      const menuWidth = 166;
      const menuHeight = 82;
      const left = clamp(rect.right - menuWidth, 8, window.innerWidth - menuWidth - 8);
      const below = rect.bottom + 6;
      const top = below + menuHeight > window.innerHeight - 8
        ? Math.max(8, rect.top - menuHeight - 6)
        : below;
      return { profile: profileName, top, left };
    });
  }

  function renderMenu() {
    if (!menu) return null;
    const profile = profiles.find((item) => item.name === menu.profile);
    if (!profile) return null;

    return (
      <div className="profile-context-menu agent-list-context-menu" role="menu" style={{ top: menu.top, left: menu.left }}>
        <button
          type="button"
          role="menuitem"
          onClick={() => openCloneDialog(profile.name)}
        >
          <Copy size={14} />
          Duplicate
        </button>
        <button
          type="button"
          role="menuitem"
          className="danger-menu-item"
          disabled={profile.name === "default"}
          title={profile.name === "default" ? "The default agent cannot be deleted" : undefined}
          onClick={() => openDeleteDialog(profile.name)}
        >
          <Trash2 size={14} />
          Delete
        </button>
      </div>
    );
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
      <div className="profile-action-modal" role="dialog" aria-modal="true" aria-labelledby="agent-list-action-title">
        <form onSubmit={submitDialog}>
          <div>
            <p className="eyebrow">{isDelete ? "Agent deletion" : "Agent management"}</p>
            <h2 id="agent-list-action-title">{title}</h2>
          </div>
          <label>
            <span>{label}</span>
            <input
              autoFocus
              value={dialog.name}
              placeholder={isDelete ? source : "agent-name"}
              onChange={(event) => setDialog({ ...dialog, name: event.target.value })}
            />
          </label>
          {error ? <p className="profile-action-error">{error}</p> : null}
          <div className="profile-action-modal-actions">
            <button type="button" className="small-button settings-button" onClick={closeDialog}>
              Cancel
            </button>
            <button
              type="submit"
              className={isDelete ? "small-button settings-button danger" : "small-button settings-button"}
              disabled={disabled}
            >
              {busy ? "Working..." : submitLabel}
            </button>
          </div>
        </form>
      </div>
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

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, maximum));
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
