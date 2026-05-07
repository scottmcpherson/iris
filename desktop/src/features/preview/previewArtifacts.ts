import type { PreviewArtifact, PreviewMode, PreviewPermissions } from "../../app/types";
import { loadJsonValue, saveJsonValue, storageKeys } from "../../app/storage";
import { defaultPreviewSource } from "./previewSamples";

export const defaultPreviewPermissions: PreviewPermissions = {
  scripts: true,
  forms: false,
  modals: false,
  downloads: false,
};

export function createPreviewArtifact(mode: PreviewMode, name?: string): PreviewArtifact {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: name || defaultArtifactName(mode),
    mode,
    source: defaultPreviewSource(mode),
    createdAt: now,
    updatedAt: now,
    permissions: {
      ...defaultPreviewPermissions,
    },
  };
}

export function createInitialPreviewArtifacts() {
  return [
    createPreviewArtifact("html", "Welcome card.html"),
    createPreviewArtifact("react", "HermesPreview.jsx"),
    createPreviewArtifact("markdown", "Skill draft.md"),
    createPreviewArtifact("diagram", "Agent flow.mmd"),
  ];
}

export function loadPreviewArtifacts() {
  const parsed = loadJsonValue<PreviewArtifact[]>(storageKeys.previewArtifacts, []);
  if (!Array.isArray(parsed) || parsed.length === 0) return createInitialPreviewArtifacts();
  return parsed.map(normalizeArtifact);
}

export function savePreviewArtifacts(artifacts: PreviewArtifact[]) {
  saveJsonValue(storageKeys.previewArtifacts, artifacts);
}

export function duplicatePreviewArtifact(artifact: PreviewArtifact): PreviewArtifact {
  return {
    ...artifact,
    id: crypto.randomUUID(),
    name: nextCopyName(artifact.name),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function createSkillArtifact(artifact: PreviewArtifact): PreviewArtifact {
  const now = Date.now();
  const title = artifact.name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ").trim() || "Preview Artifact";
  const fence = fenceForMode(artifact.mode);
  return {
    id: crypto.randomUUID(),
    name: `${slugify(title)}-skill.md`,
    mode: "markdown",
    source: `# ${title} Skill

Use this skill when Iris should recreate, extend, or explain the ${artifact.mode} artifact named "${artifact.name}".

## Trigger

The user asks for this artifact, a related preview, or a reusable implementation pattern based on it.

## Instructions

- Preserve the artifact intent and interaction model.
- Keep changes scoped to the requested artifact.
- Verify the preview renders before presenting the result.

## Source

\`\`\`${fence}
${artifact.source}
\`\`\`
`,
    createdAt: now,
    updatedAt: now,
    permissions: {
      ...defaultPreviewPermissions,
      scripts: false,
    },
  };
}

export function extensionForMode(mode: PreviewMode) {
  if (mode === "react") return "jsx";
  if (mode === "markdown") return "md";
  if (mode === "diagram") return "mmd";
  return "html";
}

export function mimeForMode(mode: PreviewMode) {
  if (mode === "react") return "text/jsx";
  if (mode === "markdown") return "text/markdown";
  if (mode === "diagram") return "text/plain";
  return "text/html";
}

function normalizeArtifact(artifact: PreviewArtifact): PreviewArtifact {
  return {
    ...artifact,
    permissions: {
      ...defaultPreviewPermissions,
      ...(artifact.permissions || {}),
    },
  };
}

function defaultArtifactName(mode: PreviewMode) {
  if (mode === "react") return "Untitled preview.jsx";
  if (mode === "markdown") return "Untitled note.md";
  if (mode === "diagram") return "Untitled diagram.mmd";
  return "Untitled page.html";
}

function fenceForMode(mode: PreviewMode) {
  if (mode === "react") return "tsx";
  if (mode === "markdown") return "md";
  if (mode === "diagram") return "mermaid";
  return "html";
}

function nextCopyName(name: string) {
  const match = name.match(/^(.*?)(\.[^.]+)?$/);
  const base = match?.[1] || name;
  const extension = match?.[2] || "";
  return `${base} copy${extension}`;
}

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "preview"
  );
}
