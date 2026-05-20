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
        runtimeReadiness: "ready",
        gatewayActionBusy: false,
        gatewayActionBusyAction: null,
        adapterInstallBusy: false,
        onRuntimeChange: noop,
        onRefresh: noop,
        onProfileAction: async () => "",
        onGatewayAction: noop,
        onInstallAdapter: noop,
        onOpenSettings: noop,
        onSaveMemory: async () => "",
        onResetMemory: async () => "",
      }),
    );

    expect(html).toContain("Iris Core");
    expect(html).toContain("http://127.0.0.1:8765");
    expect(html).not.toContain("default ready");
    expect(html).not.toContain("Restart gateway");
    expect(html).toContain("Configure in Settings");
    expect(html).not.toContain("Routes and credentials");
    expect(html).not.toContain("Connection details are shared across the app");
    expect(html).not.toContain("Memory overview");
    expect(html).not.toContain("Skills overview");
    expect(html).not.toContain("installed skills");
  });

  it("shows gateway recovery controls in the overview page", () => {
    const stoppedProfile = profileFixture({ gatewayRunning: false });
    const html = renderToStaticMarkup(
      createElement(AgentDetailView, {
        section: "overview",
        status: statusFixture(stoppedProfile),
        profile: stoppedProfile,
        selectedProfile: "default",
        runtimeConfig: runtimeConfigFixture(),
        memory: memoryFixture(),
        skills: skillsFixture(),
        runtimeReadiness: "gateway-stopped",
        gatewayActionBusy: false,
        gatewayActionBusyAction: null,
        adapterInstallBusy: false,
        onRuntimeChange: noop,
        onRefresh: noop,
        onProfileAction: async () => "",
        onGatewayAction: noop,
        onInstallAdapter: noop,
        onOpenSettings: noop,
        onSaveMemory: async () => "",
        onResetMemory: async () => "",
      }),
    );

    expect(html).toContain("default gateway is stopped");
    expect(html).toContain("Start gateway");
  });

  it("shows gateway recovery controls when the adapter is unreachable", () => {
    const html = renderToStaticMarkup(
      createElement(AgentDetailView, {
        section: "overview",
        status: statusFixture(),
        profile: profileFixture(),
        selectedProfile: "default",
        runtimeConfig: runtimeConfigFixture(),
        memory: memoryFixture(),
        skills: skillsFixture(),
        runtimeReadiness: "adapter-unavailable",
        gatewayActionBusy: false,
        gatewayActionBusyAction: null,
        adapterInstallBusy: false,
        onRuntimeChange: noop,
        onRefresh: noop,
        onProfileAction: async () => "",
        onGatewayAction: noop,
        onInstallAdapter: noop,
        onOpenSettings: noop,
        onSaveMemory: async () => "",
        onResetMemory: async () => "",
      }),
    );

    expect(html).toContain("Iris adapter is unreachable");
    expect(html).toContain("Restart gateway");
    expect(html).toContain("Install adapter");
  });
});

function noop() {}

function runtimeConfigFixture(): HermesRuntimeConfig {
  return {
    connectionMode: "managed-local",
    activeConnectionId: "core_local",
    coreConnections: [{
      id: "core_local",
      name: "Local",
      mode: "managed-local",
      effectiveCoreApiUrl: "http://127.0.0.1:8765",
      local: {
        port: 8765,
        autoStart: true,
        installLaunchAgent: false,
      },
    }],
    provider: "",
    model: "",
  };
}

function profileFixture(overrides: Partial<HermesProfile> = {}): HermesProfile {
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
    ...overrides,
  };
}

function statusFixture(profile = profileFixture()): HermesStatus {
  return {
    ok: true,
    connected: true,
    root: "/tmp/hermes",
    hermesPath: "/tmp/hermes",
    version: "test",
    activeProfile: profile,
    coreApiUrl: "http://127.0.0.1:8765",
    checkedAt: 1_774_199_763,
    profiles: [profile],
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
