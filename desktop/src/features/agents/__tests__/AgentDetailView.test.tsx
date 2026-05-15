import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentDetailView } from "../AgentDetailView";
import type {
  HermesMemory,
  HermesProfile,
  HermesRuntimeConfig,
  HermesSkill,
  HermesStatus,
} from "../../../types/hermes";

describe("AgentDetailView", () => {
  it("keeps memory and skills previews out of the overview page", () => {
    const html = renderToStaticMarkup(
      createElement(AgentDetailView, {
        section: "overview",
        status: statusFixture(),
        profile: profileFixture(),
        selectedProfile: "default",
        runtimeConfig: runtimeConfigFixture(),
        memory: memoryFixture(),
        skills: skillsFixture(),
        onRuntimeChange: noop,
        onRefresh: noop,
        onProfileAction: async () => "",
        onOpenSettings: noop,
        onSaveMemory: async () => "",
        onResetMemory: async () => "",
      }),
    );

    expect(html).toContain("Iris Core status");
    expect(html).toContain("Configure in Settings");
    expect(html).not.toContain("Routes and credentials");
    expect(html).not.toContain("Connection details are shared across the app");
    expect(html).not.toContain("Memory overview");
    expect(html).not.toContain("Skills overview");
    expect(html).not.toContain("installed skills");
  });
});

function noop() {}

function runtimeConfigFixture(): HermesRuntimeConfig {
  return {
    connectionMode: "local",
    remoteUrl: "",
    coreApiUrl: "http://127.0.0.1:8765",
    provider: "",
    model: "",
  };
}

function profileFixture(): HermesProfile {
  return {
    name: "default",
    path: "/tmp/default",
    active: true,
    exists: true,
    model: "gpt-5.5",
    provider: "openai-codex",
    memoryBytes: 0,
    memoryUpdatedAt: null,
    skillCount: 2,
    sessionCount: 0,
    estimatedCostUsd: null,
    gatewayRunning: true,
  };
}

function statusFixture(): HermesStatus {
  return {
    ok: true,
    connected: true,
    root: "/tmp/hermes",
    hermesPath: "/tmp/hermes",
    version: "test",
    activeProfile: profileFixture(),
    coreApiUrl: "http://127.0.0.1:8765",
    checkedAt: 1_774_199_763,
    profiles: [profileFixture()],
    managementStatus: {
      ok: true,
      url: "http://127.0.0.1:8765",
    },
  };
}

function memoryFixture(): HermesMemory {
  return {
    ok: true,
    profile: "default",
    path: "/tmp/default",
    memory: {
      name: "MEMORY.md",
      path: "/tmp/default/MEMORY.md",
      exists: true,
      updatedAt: 1_774_199_763,
      bytes: 128,
      content: "Remember the overview should stay focused.",
    },
    user: {
      name: "USER.md",
      path: "/tmp/default/USER.md",
      exists: true,
      updatedAt: 1_774_199_763,
      bytes: 64,
      content: "User profile notes.",
    },
    history: [],
  };
}

function skillsFixture(): HermesSkill[] {
  return [
    {
      id: "apple-notes",
      name: "apple-notes",
      path: "/tmp/skills/apple-notes",
      category: "apple",
      source: "installed",
      description: "",
      updatedAt: null,
      version: null,
      tags: [],
      bytes: 0,
      metadata: {},
    },
    {
      id: "airtable",
      name: "airtable",
      path: "/tmp/skills/airtable",
      category: "productivity",
      source: "installed",
      description: "",
      updatedAt: null,
      version: null,
      tags: [],
      bytes: 0,
      metadata: {},
    },
  ];
}
