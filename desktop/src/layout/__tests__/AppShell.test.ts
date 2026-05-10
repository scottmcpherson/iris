import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell, unpinnedProfileConversations } from "../AppShell";
import { storageKeys } from "../../app/storage";
import type { AgentUICoreAgent, IrisProject } from "../../lib/agentuiCore";
import type { HermesConversation, HermesProfile, HermesStatus } from "../../types/hermes";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AppShell pinned conversations", () => {
  it("keeps pinned conversations out of the agent conversation branch", () => {
    const conversations = [
      { id: "conv-1", title: "Pinned chat" },
      { id: "conv-2", title: "Normal chat" },
      { id: "conv-3", title: "Other profile chat" },
    ];

    expect(
      unpinnedProfileConversations("default", conversations, {
        "default:conv-1": true,
        "health:conv-3": true,
      }),
    ).toEqual([
      { id: "conv-2", title: "Normal chat" },
      { id: "conv-3", title: "Other profile chat" },
    ]);
  });

  it("shows the streaming status for a project-scoped chat in the project branch", () => {
    const project = projectFixture();
    const projectChat = conversationFixture({
      id: "conv_project",
      title: "Project stream",
      metadata: { projectId: project.id },
    });

    const html = renderToStaticMarkup(
      createElement(AppShell, {
        activeView: "chat",
        connected: true,
        isRefreshing: false,
        previewOpen: false,
        primaryPane: null,
        previewPane: null,
        selectedProfile: "default",
        status: statusFixture(),
        conversations: [],
        conversationsByProfile: {},
        conversationReadStates: {},
        projects: [project],
        projectAgents: [agentFixture()],
        conversationsByProject: { [project.id]: [projectChat] },
        projectConversationsLoading: {},
        projectConversationsLoaded: { [project.id]: true },
        projectErrors: {},
        collapsedProjects: { [project.id]: false },
        unprojectedConversations: [],
        conversationsLoadedByProfile: {},
        conversationsLoading: false,
        conversationsLoadingByProfile: {},
        historyError: null,
        historyErrorsByProfile: {},
        selectedConversationId: projectChat.id,
        selectedProjectId: project.id,
        activeConversationIds: [projectChat.id],
        coreApiUrl: "http://127.0.0.1:8765",
        onNewConversation: noop,
        onCreateProject: async () => project,
        onUpdateProject: async () => project,
        onToggleProjectCollapsed: noop,
        onRefreshProjects: noop,
        onRefreshProjectConversations: noop,
        onPreviewToggle: noop,
        onEditProfile: noop,
        onProfileAction: async () => "",
        onRefresh: noop,
        onRefreshConversations: noop,
        onDeleteConversation: async () => "",
        onRenameConversation: async () => "",
        onSelectConversation: noop,
        onSelectProjectConversation: noop,
        onSelectProfile: noop,
        onSelectView: noop,
      }),
    );

    expect(html).toContain("Project stream");
    expect(html).toContain("sidebar-session-status streaming");
    expect(html).toContain("aria-label=\"Streaming response\"");
  });

  it("shows the unread status for a background completed project chat", () => {
    const project = projectFixture();
    const projectChat = conversationFixture({
      id: "conv_project",
      title: "Project complete",
      metadata: { projectId: project.id },
    });

    const html = renderToStaticMarkup(
      createElement(AppShell, {
        activeView: "chat",
        connected: true,
        isRefreshing: false,
        previewOpen: false,
        primaryPane: null,
        previewPane: null,
        selectedProfile: "default",
        status: statusFixture(),
        conversations: [],
        conversationsByProfile: {},
        conversationReadStates: { [projectChat.id]: "unread" },
        projects: [project],
        projectAgents: [agentFixture()],
        conversationsByProject: { [project.id]: [projectChat] },
        projectConversationsLoading: {},
        projectConversationsLoaded: { [project.id]: true },
        projectErrors: {},
        collapsedProjects: { [project.id]: false },
        unprojectedConversations: [],
        conversationsLoadedByProfile: {},
        conversationsLoading: false,
        conversationsLoadingByProfile: {},
        historyError: null,
        historyErrorsByProfile: {},
        selectedConversationId: "conv_other",
        selectedProjectId: project.id,
        activeConversationIds: [],
        coreApiUrl: "http://127.0.0.1:8765",
        onNewConversation: noop,
        onCreateProject: async () => project,
        onUpdateProject: async () => project,
        onToggleProjectCollapsed: noop,
        onRefreshProjects: noop,
        onRefreshProjectConversations: noop,
        onPreviewToggle: noop,
        onEditProfile: noop,
        onProfileAction: async () => "",
        onRefresh: noop,
        onRefreshConversations: noop,
        onDeleteConversation: async () => "",
        onRenameConversation: async () => "",
        onSelectConversation: noop,
        onSelectProjectConversation: noop,
        onSelectProfile: noop,
        onSelectView: noop,
      }),
    );

    expect(html).toContain("Project complete");
    expect(html).toContain("sidebar-session-status unread");
    expect(html).toContain("aria-label=\"Unread response\"");
  });

  it("only shows a selected conversation as active while the chat view is active", () => {
    const looseChat = conversationFixture({ id: "conv_loose", title: "Loose chat" });

    const html = renderToStaticMarkup(
      createElement(AppShell, {
        activeView: "jobs",
        connected: true,
        isRefreshing: false,
        previewOpen: false,
        primaryPane: null,
        previewPane: null,
        selectedProfile: "default",
        status: statusFixture(),
        conversations: [looseChat],
        conversationsByProfile: {},
        conversationReadStates: {},
        projects: [],
        projectAgents: [],
        conversationsByProject: {},
        projectConversationsLoading: {},
        projectConversationsLoaded: {},
        projectErrors: {},
        collapsedProjects: {},
        unprojectedConversations: [looseChat],
        conversationsLoadedByProfile: {},
        conversationsLoading: false,
        conversationsLoadingByProfile: {},
        historyError: null,
        historyErrorsByProfile: {},
        selectedConversationId: looseChat.id,
        selectedProjectId: "",
        activeConversationIds: [],
        coreApiUrl: "http://127.0.0.1:8765",
        onNewConversation: noop,
        onCreateProject: async () => projectFixture(),
        onUpdateProject: async () => projectFixture(),
        onToggleProjectCollapsed: noop,
        onRefreshProjects: noop,
        onRefreshProjectConversations: noop,
        onPreviewToggle: noop,
        onEditProfile: noop,
        onProfileAction: async () => "",
        onRefresh: noop,
        onRefreshConversations: noop,
        onDeleteConversation: async () => "",
        onRenameConversation: async () => "",
        onSelectConversation: noop,
        onSelectProjectConversation: noop,
        onSelectProfile: noop,
        onSelectView: noop,
      }),
    );

    expect(html).toContain("Loose chat");
    expect(html).toContain("nav-item active");
    expect(html).not.toContain("sidebar-session-row active");
    expect(html).not.toContain("<p>Automations</p>");
    expect(html).not.toContain("http://127.0.0.1:8765");
  });

  it("honors persisted top-level sidebar section collapse state", () => {
    const project = projectFixture();
    const projectChat = conversationFixture({
      id: "conv_project",
      title: "Project stream",
      metadata: { projectId: project.id },
    });
    const looseChat = conversationFixture({ id: "conv_loose", title: "Loose chat" });

    vi.stubGlobal("localStorage", {
      getItem: (key: string) => {
        if (key === storageKeys.collapsedSidebarSections) {
          return JSON.stringify({ pinned: true, projects: true, chats: true, agents: true });
        }
        if (key === storageKeys.pinnedConversations) {
          return JSON.stringify({ [`project:${project.id}:${projectChat.id}`]: true });
        }
        return null;
      },
      setItem: vi.fn(),
    });

    const html = renderToStaticMarkup(
      createElement(AppShell, {
        activeView: "chat",
        connected: true,
        isRefreshing: false,
        previewOpen: false,
        primaryPane: null,
        previewPane: null,
        selectedProfile: "default",
        status: statusFixture(),
        conversations: [looseChat],
        conversationsByProfile: {},
        conversationReadStates: {},
        projects: [project],
        projectAgents: [agentFixture()],
        conversationsByProject: { [project.id]: [projectChat] },
        projectConversationsLoading: {},
        projectConversationsLoaded: { [project.id]: true },
        projectErrors: {},
        collapsedProjects: { [project.id]: false },
        unprojectedConversations: [looseChat],
        conversationsLoadedByProfile: {},
        conversationsLoading: false,
        conversationsLoadingByProfile: {},
        historyError: null,
        historyErrorsByProfile: {},
        selectedConversationId: null,
        selectedProjectId: "",
        activeConversationIds: [],
        coreApiUrl: "http://127.0.0.1:8765",
        onNewConversation: noop,
        onCreateProject: async () => project,
        onUpdateProject: async () => project,
        onToggleProjectCollapsed: noop,
        onRefreshProjects: noop,
        onRefreshProjectConversations: noop,
        onPreviewToggle: noop,
        onEditProfile: noop,
        onProfileAction: async () => "",
        onRefresh: noop,
        onRefreshConversations: noop,
        onDeleteConversation: async () => "",
        onRenameConversation: async () => "",
        onSelectConversation: noop,
        onSelectProjectConversation: noop,
        onSelectProfile: noop,
        onSelectView: noop,
      }),
    );

    expect(html).toContain('aria-expanded="false" aria-controls="sidebar-pinned-section"');
    expect(html).toContain('<span class="sidebar-label">Pinned</span>');
    expect(html).toContain('aria-expanded="false" aria-controls="sidebar-projects-section"');
    expect(html).toContain('aria-expanded="false" aria-controls="sidebar-chats-section"');
    expect(html).not.toContain("Pirate");
    expect(html).not.toContain("Project stream");
    expect(html).not.toContain("Loose chat");
    expect(html).not.toContain("<span>default</span>");
  });

  it("uses the persisted agents organization without rendering project buckets", () => {
    const project = projectFixture();
    const projectChat = conversationFixture({
      id: "conv_project",
      title: "Project stream",
      metadata: { projectId: project.id },
    });
    const looseChat = conversationFixture({ id: "conv_loose", title: "Loose chat" });

    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === storageKeys.sidebarOrganization ? JSON.stringify("agents") : null,
      setItem: vi.fn(),
    });

    const html = renderToStaticMarkup(
      createElement(AppShell, {
        activeView: "chat",
        connected: true,
        isRefreshing: false,
        previewOpen: false,
        primaryPane: null,
        previewPane: null,
        selectedProfile: "default",
        status: statusFixture(),
        conversations: [projectChat, looseChat],
        conversationsByProfile: {},
        conversationReadStates: {},
        projects: [project],
        projectAgents: [agentFixture()],
        conversationsByProject: { [project.id]: [projectChat] },
        projectConversationsLoading: {},
        projectConversationsLoaded: { [project.id]: true },
        projectErrors: {},
        collapsedProjects: { [project.id]: false },
        unprojectedConversations: [looseChat],
        conversationsLoadedByProfile: { default: true },
        conversationsLoading: false,
        conversationsLoadingByProfile: {},
        historyError: null,
        historyErrorsByProfile: {},
        selectedConversationId: null,
        selectedProjectId: "",
        activeConversationIds: [],
        coreApiUrl: "http://127.0.0.1:8765",
        onNewConversation: noop,
        onCreateProject: async () => project,
        onUpdateProject: async () => project,
        onToggleProjectCollapsed: noop,
        onRefreshProjects: noop,
        onRefreshProjectConversations: noop,
        onPreviewToggle: noop,
        onEditProfile: noop,
        onProfileAction: async () => "",
        onRefresh: noop,
        onRefreshConversations: noop,
        onDeleteConversation: async () => "",
        onRenameConversation: async () => "",
        onSelectConversation: noop,
        onSelectProjectConversation: noop,
        onSelectProfile: noop,
        onSelectView: noop,
      }),
    );

    expect(html).toContain('aria-controls="sidebar-agents-section"');
    expect(html).toContain("<span>default</span>");
    expect(html).toContain("Project stream");
    expect(html).toContain("Loose chat");
    expect(html).not.toContain('aria-controls="sidebar-projects-section"');
    expect(html).not.toContain('aria-controls="sidebar-chats-section"');
    expect(html).not.toContain("Pirate");
  });
});

function noop() {}

function profileFixture(): HermesProfile {
  return {
    name: "default",
    path: "/tmp/default",
    active: true,
    exists: true,
    model: "gpt-5.5",
    provider: "openai",
    memoryBytes: 0,
    memoryUpdatedAt: null,
    skillCount: 0,
    sessionCount: 0,
    estimatedCostUsd: null,
    gatewayRunning: true,
  };
}

function statusFixture(): HermesStatus {
  const activeProfile = profileFixture();
  return {
    ok: true,
    connected: true,
    root: "/tmp",
    hermesPath: "/tmp/.hermes",
    version: "test",
    activeProfile,
    profiles: [activeProfile],
    checkedAt: 1,
  };
}

function projectFixture(): IrisProject {
  return {
    id: "project_1",
    name: "Pirate",
    slug: "pirate",
    defaultAgentId: "agent_1",
    systemPrompt: "Talk like a pirate",
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    metadata: {},
  };
}

function agentFixture(): AgentUICoreAgent {
  return {
    id: "agent_1",
    runtimeId: "default",
    runtimeKind: "hermes",
    displayName: "default",
    runtimeProfile: "default",
    isDefault: true,
  };
}

function conversationFixture(overrides: Partial<HermesConversation> = {}): HermesConversation {
  return {
    id: "conv_1",
    source: "agentui-core",
    model: "gpt-5.5",
    title: "Chat",
    preview: "",
    chatId: "chat_1",
    origin: { runtimeProfile: "default" },
    metadata: {},
    startedAt: 1,
    endedAt: null,
    lastActiveAt: 1,
    messageCount: 1,
    ...overrides,
  };
}
