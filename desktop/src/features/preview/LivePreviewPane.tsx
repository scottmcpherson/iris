import { Copy, Download, FilePlus2, Play, Shield, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { PreviewArtifact, PreviewMode, PreviewPermissions } from "../../app/types";

type LivePreviewPaneProps = {
  artifact: PreviewArtifact;
  artifacts: PreviewArtifact[];
  document: string;
  onArtifactSelect: (artifactId: string) => void;
  onArtifactNameChange: (name: string) => void;
  onDeleteArtifact: () => void;
  onDuplicateArtifact: () => void;
  onExportArtifact: () => void;
  onModeChange: (mode: PreviewMode) => void;
  onNewArtifact: () => void;
  onPermissionChange: (permissions: PreviewPermissions) => void;
  onSaveAsSkill: () => void;
  onSourceChange: (source: string) => void;
};

const previewModes: PreviewMode[] = ["html", "react", "markdown", "diagram"];

export function LivePreviewPane({
  artifact,
  artifacts,
  document,
  onArtifactSelect,
  onArtifactNameChange,
  onDeleteArtifact,
  onDuplicateArtifact,
  onExportArtifact,
  onModeChange,
  onNewArtifact,
  onPermissionChange,
  onSaveAsSkill,
  onSourceChange,
}: LivePreviewPaneProps) {
  const [runtimeState, setRuntimeState] = useState<{
    status: "idle" | "ready" | "error" | "blocked";
    message: string;
  }>({ status: "idle", message: "Rendering preview..." });

  const sandbox = useMemo(() => buildSandbox(artifact.permissions), [artifact.permissions]);

  useEffect(() => {
    if (!artifact.permissions.scripts && (artifact.mode === "react" || artifact.mode === "diagram")) {
      setRuntimeState({
        status: "blocked",
        message: "Scripts are disabled for this artifact.",
      });
      return;
    }

    setRuntimeState({ status: "idle", message: "Rendering preview..." });
    const timeout = window.setTimeout(() => {
      setRuntimeState((current) =>
        current.status === "idle"
          ? { status: "ready", message: artifact.permissions.scripts ? "Preview rendered." : "Static preview." }
          : current,
      );
    }, 700);

    function handleMessage(event: MessageEvent) {
      const payload = event.data as {
        source?: string;
        artifactId?: string;
        type?: string;
        message?: string;
      };
      if (payload?.source !== "hermes-preview" || payload.artifactId !== artifact.id) return;
      if (payload.type === "ready") {
        setRuntimeState({ status: "ready", message: "Preview rendered." });
      }
      if (payload.type === "error") {
        setRuntimeState({
          status: "error",
          message: payload.message || "Preview runtime failed.",
        });
      }
    }

    window.addEventListener("message", handleMessage);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", handleMessage);
    };
  }, [artifact.id, artifact.mode, artifact.permissions.scripts, document]);

  return (
    <aside className="preview-pane">
      <div className="preview-header">
        <div>
          <p>Live Preview</p>
          <span>{artifacts.length} artifacts in this session workspace</span>
        </div>
        <button className="small-button" onClick={onSaveAsSkill}>
          <Play size={14} />
          Save as skill
        </button>
      </div>

      <div className="artifact-toolbar">
        <label className="artifact-name">
          <span>Name</span>
          <input value={artifact.name} onChange={(event) => onArtifactNameChange(event.target.value)} />
        </label>
        <button className="icon-button" title="New artifact" onClick={onNewArtifact}>
          <FilePlus2 size={16} />
        </button>
        <button className="icon-button" title="Duplicate artifact" onClick={onDuplicateArtifact}>
          <Copy size={16} />
        </button>
        <button className="icon-button" title="Export artifact" onClick={onExportArtifact}>
          <Download size={16} />
        </button>
        <button
          className="icon-button danger-icon"
          title="Delete artifact"
          onClick={onDeleteArtifact}
          disabled={artifacts.length < 2}
        >
          <Trash2 size={16} />
        </button>
      </div>

      <div className="artifact-list" aria-label="Artifacts">
        {artifacts.map((item) => (
          <button
            key={item.id}
            className={item.id === artifact.id ? "artifact-chip active" : "artifact-chip"}
            onClick={() => onArtifactSelect(item.id)}
          >
            <span>{item.name}</span>
            <small>{item.mode}</small>
          </button>
        ))}
      </div>

      <div className="preview-tabs">
        {previewModes.map((previewMode) => (
          <button
            key={previewMode}
            className={artifact.mode === previewMode ? "preview-tab active" : "preview-tab"}
            onClick={() => onModeChange(previewMode)}
          >
            {previewMode}
          </button>
        ))}
      </div>

      <div className="preview-permissions" aria-label="Preview permissions">
        <span>
          <Shield size={13} />
          Sandbox
        </span>
        <PermissionToggle
          label="Scripts"
          checked={artifact.permissions.scripts}
          onChange={(scripts) => onPermissionChange({ ...artifact.permissions, scripts })}
        />
        <PermissionToggle
          label="Forms"
          checked={artifact.permissions.forms}
          onChange={(forms) => onPermissionChange({ ...artifact.permissions, forms })}
        />
        <PermissionToggle
          label="Modals"
          checked={artifact.permissions.modals}
          onChange={(modals) => onPermissionChange({ ...artifact.permissions, modals })}
        />
        <PermissionToggle
          label="Downloads"
          checked={artifact.permissions.downloads}
          onChange={(downloads) => onPermissionChange({ ...artifact.permissions, downloads })}
        />
      </div>

      <div className="preview-frame-shell">
        <iframe
          key={`${artifact.id}-${artifact.updatedAt}-${sandbox}`}
          title="Iris live preview"
          sandbox={sandbox}
          srcDoc={document}
        />
        {runtimeState.status === "error" || runtimeState.status === "blocked" ? (
          <div className="preview-error-overlay">
            <strong>{runtimeState.status === "blocked" ? "Permission blocked" : "Preview error"}</strong>
            <span>{runtimeState.message}</span>
          </div>
        ) : null}
      </div>

      <div className={`preview-runtime ${runtimeState.status}`}>
        <span />
        {runtimeState.message}
      </div>

      <label className="editor-label" htmlFor="preview-source">
        Source
      </label>
      <textarea
        id="preview-source"
        className="preview-editor"
        value={artifact.source}
        spellCheck={false}
        onChange={(event) => onSourceChange(event.target.value)}
      />
    </aside>
  );
}

function PermissionToggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="permission-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function buildSandbox(permissions: PreviewPermissions) {
  return [
    permissions.scripts ? "allow-scripts" : "",
    permissions.forms ? "allow-forms" : "",
    permissions.modals ? "allow-modals" : "",
    permissions.downloads ? "allow-downloads" : "",
  ]
    .filter(Boolean)
    .join(" ");
}
