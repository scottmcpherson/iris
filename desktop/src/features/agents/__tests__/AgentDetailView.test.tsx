import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { AgentDetailView } from "../AgentDetailView";
import type {
  HermesMemory,
  HermesProfile,
  HermesRuntimeConfig,
  HermesStatus,
} from "../../../types/hermes";

describe("AgentDetailView", () => {
  it("keeps memory and skills previews out of the overview page", () => {
    const html = renderAgentDetailView({
      section: "overview",
      status: statusFixture(),
      profile: profileFixture(),
      selectedProfile: "default",
      runtimeConfig: runtimeConfigFixture(),
      memory: memoryFixture(),
      gatewayActionBusy: false,
      gatewayActionBusyAction: null,
      adapterInstallBusy: false,
      onRefresh: noop,
      onProfileSkillsChanged: noop,
      onProfileAction: async () => "",
      onGatewayAction: noop,
      onInstallAdapter: noop,
      onOpenSettings: noop,
      onSaveMemory: async () => "",
      onResetMemory: async () => "",
    });

    expect(html).toContain("Iris Core");
    expect(html).toContain("http://127.0.0.1:8765");
    expect(html).toContain("agent-content-frame");
    expect(html).toContain("data-layout=\"record\"");
    expect(html).toContain("grid content-start gap-3 min-w-0 min-h-0");
    expect(html).toContain("Profile metadata");
    expect(html).not.toContain("default ready");
    expect(html).not.toContain("Restart gateway");
    expect(html).toContain("Configure in Settings");
    expect(html).not.toContain("tool-view gap-4");
    expect(html).not.toContain("flex items-center justify-between gap-3 min-w-0");
    expect(html).not.toContain("Routes and credentials");
    expect(html).not.toContain("Connection details are shared across the app");
    expect(html).not.toContain("Memory overview");
    expect(html).not.toContain("Skills overview");
    expect(html).not.toContain("installed skills");
  });

  it("shows gateway recovery controls in the overview page", () => {
    const stoppedProfile = profileFixture({ gatewayRunning: false });
    const html = renderAgentDetailView({
      section: "overview",
      status: statusFixture(stoppedProfile),
      profile: stoppedProfile,
      selectedProfile: "default",
      runtimeConfig: runtimeConfigFixture(),
      memory: memoryFixture(),
      gatewayActionBusy: false,
      gatewayActionBusyAction: null,
      adapterInstallBusy: false,
      onRefresh: noop,
      onProfileSkillsChanged: noop,
      onProfileAction: async () => "",
      onGatewayAction: noop,
      onInstallAdapter: noop,
      onOpenSettings: noop,
      onSaveMemory: async () => "",
      onResetMemory: async () => "",
    });

    expect(html).toContain("Hermes gateway (default)");
    expect(html).toContain("Start gateway");
  });

  it("shows gateway recovery controls when the adapter is unreachable", () => {
    const html = renderAgentDetailView({
      section: "overview",
      status: { ...statusFixture(), activeApiStatus: { ok: false, profile: "default" } },
      profile: profileFixture(),
      selectedProfile: "default",
      runtimeConfig: runtimeConfigFixture(),
      memory: memoryFixture(),
      gatewayActionBusy: false,
      gatewayActionBusyAction: null,
      adapterInstallBusy: false,
      onRefresh: noop,
      onProfileSkillsChanged: noop,
      onProfileAction: async () => "",
      onGatewayAction: noop,
      onInstallAdapter: noop,
      onOpenSettings: noop,
      onSaveMemory: async () => "",
      onResetMemory: async () => "",
    });

    expect(html).toContain("Iris adapter");
    expect(html).toContain("Install adapter");
  });

  it("wraps memory in the shared workbench frame without a nested page shell", () => {
    const html = renderAgentDetailView({
      section: "memory",
      status: statusFixture(),
      profile: profileFixture(),
      selectedProfile: "default",
      runtimeConfig: runtimeConfigFixture(),
      memory: memoryFixture(),
      gatewayActionBusy: false,
      gatewayActionBusyAction: null,
      adapterInstallBusy: false,
      onRefresh: noop,
      onProfileSkillsChanged: noop,
      onProfileAction: async () => "",
      onGatewayAction: noop,
      onInstallAdapter: noop,
      onOpenSettings: noop,
      onSaveMemory: async () => "",
      onResetMemory: async () => "",
    });

    expect(html).toContain("agent-content-frame");
    expect(html).toContain("data-layout=\"workbench\"");
    expect(html).toContain("relative grid self-start content-start gap-3 min-w-0 min-h-0 pb-[30px]");
    expect(html).not.toContain("tool-view relative grid self-start content-start gap-3 min-w-0 min-h-0 pb-[30px]");
    expect(html).not.toContain("agent-subview");
  });

  it("does not render selected-profile memory while viewing another profile detail route", () => {
    const html = renderAgentDetailView({
      section: "memory",
      status: statusFixture(profileFixture({ name: "research" })),
      profile: profileFixture({ name: "research" }),
      selectedProfile: "research",
      runtimeConfig: runtimeConfigFixture(),
      memory: memoryFixture({ profile: "default" }),
      gatewayActionBusy: false,
      gatewayActionBusyAction: null,
      adapterInstallBusy: false,
      onRefresh: noop,
      onProfileSkillsChanged: noop,
      onProfileAction: async () => "",
      onGatewayAction: noop,
      onInstallAdapter: noop,
      onOpenSettings: noop,
      onSaveMemory: async () => "",
      onResetMemory: async () => "",
    });

    expect(html).toContain("relative grid self-start content-start gap-3 min-w-0 min-h-0 pb-[30px]");
    expect(html).not.toContain("Remember the overview should stay focused.");
    expect(html).not.toContain("User profile notes.");
  });

  it("wraps configuration in the shared workbench frame", () => {
    const html = renderAgentDetailView({
      section: "configuration",
      status: { ...statusFixture(), connected: false },
      profile: profileFixture(),
      selectedProfile: "default",
      runtimeConfig: runtimeConfigFixture(),
      memory: memoryFixture(),
      gatewayActionBusy: false,
      gatewayActionBusyAction: null,
      adapterInstallBusy: false,
      onRefresh: noop,
      onProfileSkillsChanged: noop,
      onProfileAction: async () => "",
      onGatewayAction: noop,
      onInstallAdapter: noop,
      onOpenSettings: noop,
      onSaveMemory: async () => "",
      onResetMemory: async () => "",
    });

    expect(html).toContain("agent-content-frame");
    expect(html).toContain("data-layout=\"workbench\"");
    expect(html).toContain("Iris Core is offline.");
  });
});

function noop() {}

type RenderAgentDetailViewProps =
  Omit<ComponentProps<typeof AgentDetailView>, "onOpenAgentProfile"> &
  Partial<Pick<ComponentProps<typeof AgentDetailView>, "onOpenAgentProfile">>;

function renderAgentDetailView(props: RenderAgentDetailViewProps) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(AgentDetailView, { onOpenAgentProfile: noop, ...props }),
    ),
  );
}

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
    activeApiStatus: { ok: true, profile: profile.name },
  };
}

function memoryFixture(overrides: Partial<HermesMemory> = {}): HermesMemory {
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
    ...overrides,
  };
}
