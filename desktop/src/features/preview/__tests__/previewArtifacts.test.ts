import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPreviewArtifact,
  createSkillArtifact,
  defaultPreviewPermissions,
  duplicatePreviewArtifact,
  extensionForMode,
  loadPreviewArtifacts,
} from "../previewArtifacts";

function installStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
  vi.stubGlobal("crypto", { randomUUID: () => "preview-id" });
}

describe("preview artifact behavior", () => {
  beforeEach(() => {
    installStorage();
  });

  it("creates artifacts with default sandbox permissions", () => {
    const artifact = createPreviewArtifact("html");

    expect(artifact.name).toBe("Untitled page.html");
    expect(artifact.permissions).toEqual(defaultPreviewPermissions);
  });

  it("normalizes stored artifacts that predate permission controls", () => {
    localStorage.setItem(
      "hermes.preview.artifacts.v1",
      JSON.stringify([{ id: "old", name: "Old.html", mode: "html", source: "<p>Old</p>", createdAt: 1, updatedAt: 1 }]),
    );

    expect(loadPreviewArtifacts()[0].permissions).toEqual(defaultPreviewPermissions);
  });

  it("duplicates artifacts without mutating the original", () => {
    const artifact = createPreviewArtifact("markdown", "Plan.md");
    const copy = duplicatePreviewArtifact(artifact);

    expect(copy.name).toBe("Plan copy.md");
    expect(copy.source).toBe(artifact.source);
    expect(artifact.name).toBe("Plan.md");
  });

  it("converts an active artifact into a markdown skill draft", () => {
    const artifact = createPreviewArtifact("diagram", "Agent Flow.mmd");
    const skill = createSkillArtifact(artifact);

    expect(skill.mode).toBe("markdown");
    expect(skill.permissions.scripts).toBe(false);
    expect(skill.source).toContain("```mermaid");
    expect(skill.name).toBe("agent-flow-skill.md");
  });

  it("maps preview modes to export extensions", () => {
    expect(extensionForMode("react")).toBe("jsx");
    expect(extensionForMode("markdown")).toBe("md");
    expect(extensionForMode("diagram")).toBe("mmd");
    expect(extensionForMode("html")).toBe("html");
  });
});
