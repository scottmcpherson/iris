import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppShell,
  SIDEBAR_AUTO_COLLAPSE_WIDTH,
  buildSessionSearchItems,
  sidebarConnectionStatusLabel,
  sidebarResponsiveResizeDecision,
  sessionSearchCommandValue,
  unpinnedProfileSessions,
  widthBandForWindow,
} from "../AppShell";
import { storageKeys } from "../../app/storage";
import type { IrisCoreAgent, IrisProject } from "../../lib/irisCore";
import type { HermesSession, HermesProfile, HermesStatus } from "../../types/hermes";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AppShell connection status", () => {
  it("shows the active connection name without agent readiness", () => {
    expect(
      sidebarConnectionStatusLabel(true, {
        ...statusFixture(),
        activeConnectionName: "Mac mini",
        connectionMode: "tailscale",
      }),
    ).toBe("Mac mini");
  });

  it("falls back to transport-aware labels without a connection name", () => {
    expect(
      sidebarConnectionStatusLabel(true, {
        ...statusFixture(),
        activeConnectionName: "",
        connectionMode: "tailscale",
      }),
    ).toBe("Tailscale");
    expect(
      sidebarConnectionStatusLabel(true, {
        ...statusFixture(),
        activeConnectionName: "",
        connectionMode: "managed-local",
      }),
    ).toBe("Local");
  });

  it("does not append selected-agent readiness to the connection label", () => {
    expect(
      sidebarConnectionStatusLabel(true, {
        ...statusFixture(),
        activeConnectionName: "Mac mini",
        connectionMode: "tailscale",
        gatewayStatus: { ok: false },
        activeApiStatus: { ok: false },
        activeProfile: { ...profileFixture(), gatewayRunning: false },
        profiles: [{ ...profileFixture(), gatewayRunning: false }],
      }),
    ).toBe("Mac mini");
    expect(
      sidebarConnectionStatusLabel(true, {
        ...statusFixture(),
        activeConnectionName: "Mac mini",
        connectionMode: "tailscale",
        activeApiStatus: { ok: false },
      }),
    ).toBe("Mac mini");
  });

  it("keeps the active connection in the offline label", () => {
    expect(sidebarConnectionStatusLabel(false, { ...statusFixture(), activeConnectionName: "Local" })).toBe(
      "Local · Core offline",
    );
  });
});

describe("AppShell pinned sessions", () => {
  it("keeps pinned sessions out of the agent session branch", () => {
    const sessions = [
      { id: "session-1", title: "Pinned chat" },
      { id: "session-2", title: "Normal chat" },
      { id: "session-3", title: "Other profile chat" },
    ];

    expect(
      unpinnedProfileSessions("default", sessions, {
        "default:session-1": true,
        "health:session-3": true,
      }),
    ).toEqual([
      { id: "session-2", title: "Normal chat" },
      { id: "session-3", title: "Other profile chat" },
    ]);
  });

  it("shows the streaming status for a project-scoped chat in the project branch", () => {
    const project = projectFixture();
    const projectChat = sessionFixture({
      id: "session_project",
      title: "Project stream",
      metadata: { projectId: project.id },
    });

    const html = renderToStaticMarkup(
      createElement(AppShell, {
        activeView: "chat",
        connected: true,
        isRefreshing: false,
        primaryPane: null,
        selectedProfile: "default",
        status: statusFixture(),
        sessions: [],
        sessionsByProfile: {},
        sessionReadStates: {},
        projects: [project],
        projectAgents: [agentFixture()],
        sessionsByProject: { [project.id]: [projectChat] },
        projectSessionsLoading: {},
        projectSessionsLoaded: { [project.id]: true },
        projectErrors: {},
        collapsedProjects: { [project.id]: false },
        unprojectedSessions: [],
        sessionsLoadedByProfile: {},
        sessionsLoading: false,
        sessionsLoadingByProfile: {},
        historyError: null,
        historyErrorsByProfile: {},
        selectedSessionId: projectChat.id,
        selectedProjectId: project.id,
        activeSessionIds: [projectChat.id],
        onNewSession: noop,
        onCreateProject: async () => project,
        onUpdateProject: async () => project,
        onToggleProjectCollapsed: noop,
        onRefreshProjectSessions: noop,
        onEditProfile: noop,
        onProfileAction: async () => "",
        onRefresh: noop,
        onRefreshSessions: noop,
        onDeleteSession: async () => "",
        onRenameSession: async () => "",
        onSelectSession: noop,
        onSelectProjectSession: noop,
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
    const projectChat = sessionFixture({
      id: "session_project",
      title: "Project complete",
      metadata: { projectId: project.id },
    });

    const html = renderToStaticMarkup(
      createElement(AppShell, {
        activeView: "chat",
        connected: true,
        isRefreshing: false,
        primaryPane: null,
        selectedProfile: "default",
        status: statusFixture(),
        sessions: [],
        sessionsByProfile: {},
        sessionReadStates: { [projectChat.id]: "unread" },
        projects: [project],
        projectAgents: [agentFixture()],
        sessionsByProject: { [project.id]: [projectChat] },
        projectSessionsLoading: {},
        projectSessionsLoaded: { [project.id]: true },
        projectErrors: {},
        collapsedProjects: { [project.id]: false },
        unprojectedSessions: [],
        sessionsLoadedByProfile: {},
        sessionsLoading: false,
        sessionsLoadingByProfile: {},
        historyError: null,
        historyErrorsByProfile: {},
        selectedSessionId: "session_other",
        selectedProjectId: project.id,
        activeSessionIds: [],
        onNewSession: noop,
        onCreateProject: async () => project,
        onUpdateProject: async () => project,
        onToggleProjectCollapsed: noop,
        onRefreshProjectSessions: noop,
        onEditProfile: noop,
        onProfileAction: async () => "",
        onRefresh: noop,
        onRefreshSessions: noop,
        onDeleteSession: async () => "",
        onRenameSession: async () => "",
        onSelectSession: noop,
        onSelectProjectSession: noop,
        onSelectProfile: noop,
        onSelectView: noop,
      }),
    );

    expect(html).toContain("Project complete");
    expect(html).toContain("sidebar-session-status unread");
    expect(html).toContain("aria-label=\"Unread response\"");
  });

  it("only shows a selected session as active while the chat view is active", () => {
    const looseChat = sessionFixture({ id: "session_loose", title: "Loose chat" });

    const html = renderToStaticMarkup(
      createElement(AppShell, {
        activeView: "jobs",
        connected: true,
        isRefreshing: false,
        primaryPane: null,
        selectedProfile: "default",
        status: statusFixture(),
        sessions: [looseChat],
        sessionsByProfile: {},
        sessionReadStates: {},
        projects: [],
        projectAgents: [],
        sessionsByProject: {},
        projectSessionsLoading: {},
        projectSessionsLoaded: {},
        projectErrors: {},
        collapsedProjects: {},
        unprojectedSessions: [looseChat],
        sessionsLoadedByProfile: {},
        sessionsLoading: false,
        sessionsLoadingByProfile: {},
        historyError: null,
        historyErrorsByProfile: {},
        selectedSessionId: looseChat.id,
        selectedProjectId: "",
        activeSessionIds: [],
        onNewSession: noop,
        onCreateProject: async () => projectFixture(),
        onUpdateProject: async () => projectFixture(),
        onToggleProjectCollapsed: noop,
        onRefreshProjectSessions: noop,
        onEditProfile: noop,
        onProfileAction: async () => "",
        onRefresh: noop,
        onRefreshSessions: noop,
        onDeleteSession: async () => "",
        onRenameSession: async () => "",
        onSelectSession: noop,
        onSelectProjectSession: noop,
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

  it("keeps loose session pin controls inside the full row hover target", () => {
    const looseChat = sessionFixture({ id: "session_loose", title: "Loose chat" });

    const html = renderToStaticMarkup(
      createElement(AppShell, {
        activeView: "chat",
        connected: true,
        isRefreshing: false,
        primaryPane: null,
        selectedProfile: "default",
        status: statusFixture(),
        sessions: [looseChat],
        sessionsByProfile: {},
        sessionReadStates: {},
        projects: [],
        projectAgents: [],
        sessionsByProject: {},
        projectSessionsLoading: {},
        projectSessionsLoaded: {},
        projectErrors: {},
        collapsedProjects: {},
        unprojectedSessions: [looseChat],
        sessionsLoadedByProfile: {},
        sessionsLoading: false,
        sessionsLoadingByProfile: {},
        historyError: null,
        historyErrorsByProfile: {},
        selectedSessionId: looseChat.id,
        selectedProjectId: "",
        activeSessionIds: [],
        onNewSession: noop,
        onCreateProject: async () => projectFixture(),
        onUpdateProject: async () => projectFixture(),
        onToggleProjectCollapsed: noop,
        onRefreshProjectSessions: noop,
        onEditProfile: noop,
        onProfileAction: async () => "",
        onRefresh: noop,
        onRefreshSessions: noop,
        onDeleteSession: async () => "",
        onRenameSession: async () => "",
        onSelectSession: noop,
        onSelectProjectSession: noop,
        onSelectProfile: noop,
        onSelectView: noop,
      }),
    );

    expect(html).toContain("sidebar-session-row relative rounded-[8px] active");
    expect(html).toContain("sidebar-session rounded-[8px] text-left");
    expect(html).toContain("sidebar-session-pin");
    expect(html).toContain("!size-[18px] !p-0 hover:bg-transparent hover:text-menu-hover-foreground");
    expect(html).toContain("size-[13px]");
    expect(html).not.toContain("ml-[9px]");
    expect(html).not.toContain("!-left-[24px]");
    expect(html).not.toContain("!pl-0");
  });

  it("honors persisted top-level sidebar section collapse state", () => {
    const project = projectFixture();
    const projectChat = sessionFixture({
      id: "session_project",
      title: "Project stream",
      metadata: { projectId: project.id },
    });
    const looseChat = sessionFixture({ id: "session_loose", title: "Loose chat" });

    vi.stubGlobal("localStorage", {
      getItem: (key: string) => {
        if (key === storageKeys.collapsedSidebarSections) {
          return JSON.stringify({ pinned: true, projects: true, chats: true, agents: true });
        }
        if (key === storageKeys.pinnedSessions) {
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
        primaryPane: null,
        selectedProfile: "default",
        status: statusFixture(),
        sessions: [looseChat],
        sessionsByProfile: {},
        sessionReadStates: {},
        projects: [project],
        projectAgents: [agentFixture()],
        sessionsByProject: { [project.id]: [projectChat] },
        projectSessionsLoading: {},
        projectSessionsLoaded: { [project.id]: true },
        projectErrors: {},
        collapsedProjects: { [project.id]: false },
        unprojectedSessions: [looseChat],
        sessionsLoadedByProfile: {},
        sessionsLoading: false,
        sessionsLoadingByProfile: {},
        historyError: null,
        historyErrorsByProfile: {},
        selectedSessionId: null,
        selectedProjectId: "",
        activeSessionIds: [],
        onNewSession: noop,
        onCreateProject: async () => project,
        onUpdateProject: async () => project,
        onToggleProjectCollapsed: noop,
        onRefreshProjectSessions: noop,
        onEditProfile: noop,
        onProfileAction: async () => "",
        onRefresh: noop,
        onRefreshSessions: noop,
        onDeleteSession: async () => "",
        onRenameSession: async () => "",
        onSelectSession: noop,
        onSelectProjectSession: noop,
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
    const projectChat = sessionFixture({
      id: "session_project",
      title: "Project stream",
      metadata: { projectId: project.id },
    });
    const looseChat = sessionFixture({ id: "session_loose", title: "Loose chat" });

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
        primaryPane: null,
        selectedProfile: "default",
        status: statusFixture(),
        sessions: [projectChat, looseChat],
        sessionsByProfile: {},
        sessionReadStates: {},
        projects: [project],
        projectAgents: [agentFixture()],
        sessionsByProject: { [project.id]: [projectChat] },
        projectSessionsLoading: {},
        projectSessionsLoaded: { [project.id]: true },
        projectErrors: {},
        collapsedProjects: { [project.id]: false },
        unprojectedSessions: [looseChat],
        sessionsLoadedByProfile: { default: true },
        sessionsLoading: false,
        sessionsLoadingByProfile: {},
        historyError: null,
        historyErrorsByProfile: {},
        selectedSessionId: null,
        selectedProjectId: "",
        activeSessionIds: [],
        onNewSession: noop,
        onCreateProject: async () => project,
        onUpdateProject: async () => project,
        onToggleProjectCollapsed: noop,
        onRefreshProjectSessions: noop,
        onEditProfile: noop,
        onProfileAction: async () => "",
        onRefresh: noop,
        onRefreshSessions: noop,
        onDeleteSession: async () => "",
        onRenameSession: async () => "",
        onSelectSession: noop,
        onSelectProjectSession: noop,
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

  it("shows sessions pinned from the agent organization in the pinned section", () => {
    const looseChat = sessionFixture({ id: "session_loose", title: "Loose chat" });

    vi.stubGlobal("localStorage", {
      getItem: (key: string) => {
        if (key === storageKeys.sidebarOrganization) return JSON.stringify("agents");
        if (key === storageKeys.pinnedSessions) {
          return JSON.stringify({ "agent:default:session_loose": true });
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
        primaryPane: null,
        selectedProfile: "default",
        status: statusFixture(),
        sessions: [looseChat],
        sessionsByProfile: {},
        sessionReadStates: {},
        projects: [],
        projectAgents: [],
        sessionsByProject: {},
        projectSessionsLoading: {},
        projectSessionsLoaded: {},
        projectErrors: {},
        collapsedProjects: {},
        unprojectedSessions: [looseChat],
        sessionsLoadedByProfile: { default: true },
        sessionsLoading: false,
        sessionsLoadingByProfile: {},
        historyError: null,
        historyErrorsByProfile: {},
        selectedSessionId: null,
        selectedProjectId: "",
        activeSessionIds: [],
        onNewSession: noop,
        onCreateProject: async () => projectFixture(),
        onUpdateProject: async () => projectFixture(),
        onToggleProjectCollapsed: noop,
        onRefreshProjectSessions: noop,
        onEditProfile: noop,
        onProfileAction: async () => "",
        onRefresh: noop,
        onRefreshSessions: noop,
        onDeleteSession: async () => "",
        onRenameSession: async () => "",
        onSelectSession: noop,
        onSelectProjectSession: noop,
        onSelectProfile: noop,
        onSelectView: noop,
      }),
    );

    expect(html).toContain('<span class="sidebar-label">Pinned</span>');
    expect(html).toContain('aria-label="Unpin Loose chat"');
    expect(html).not.toContain('aria-label="Pin Loose chat"');
  });

  it("deduplicates the selected profile session in sidebar search results", () => {
    const sharedSession = sessionFixture({
      id: "session_3782123ec7792ff6f4fa59",
      title: "Shared session",
      lastActiveAt: 10,
    });
    const project = projectFixture();
    const projectSession = sessionFixture({
      id: "session_project",
      title: "Project session",
      metadata: { projectId: project.id },
      lastActiveAt: 20,
    });

    const items = buildSessionSearchItems({
      sessions: [sharedSession, projectSession],
      sessionsByProfile: {},
      sessionsByProject: { [project.id]: [projectSession] },
      profiles: [profileFixture()],
      projects: [project],
      selectedProfile: "default",
      unprojectedSessions: [sharedSession],
      onSelectSession: noop,
      onSelectProjectSession: noop,
    });

    expect(items.map((item) => `${item.profileName}:${item.session.id}`)).toEqual([
      "default:session_project",
      "default:session_3782123ec7792ff6f4fa59",
    ]);
    expect(items.map((item) => item.sourceLabel)).toEqual([
      "Pirate / default",
      "Sessions / default",
    ]);
  });

  it("keeps duplicate session titles as unique command values", () => {
    const items = buildSessionSearchItems({
      sessions: [],
      sessionsByProfile: {},
      sessionsByProject: {},
      profiles: [profileFixture()],
      projects: [],
      selectedProfile: "default",
      unprojectedSessions: [
        sessionFixture({ id: "session_first", title: "Untitled session", lastActiveAt: 20 }),
        sessionFixture({ id: "session_second", title: "Untitled session", lastActiveAt: 10 }),
      ],
      onSelectSession: noop,
      onSelectProjectSession: noop,
    });

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.session.title)).toEqual(["Untitled session", "Untitled session"]);
    expect(new Set(items.map(sessionSearchCommandValue)).size).toBe(2);
  });
});

describe("AppShell responsive sidebar", () => {
  it("only auto-collapses the sidebar at the 820px breakpoint", () => {
    expect(SIDEBAR_AUTO_COLLAPSE_WIDTH).toBe(820);

    vi.stubGlobal("window", { innerWidth: 821 });
    expect(widthBandForWindow()).toBe("regular");

    vi.stubGlobal("window", { innerWidth: 820 });
    expect(widthBandForWindow()).toBe("compact");
  });

  it("does not re-collapse a manually opened sidebar while resizing within compact widths", () => {
    expect(
      sidebarResponsiveResizeDecision({
        previousBand: "regular",
        nextBand: "compact",
        sidebarCollapsed: false,
        expandedBeforeResponsiveCollapse: true,
      }),
    ).toEqual({
      nextCollapsed: true,
      expandedBeforeResponsiveCollapse: true,
    });

    expect(
      sidebarResponsiveResizeDecision({
        previousBand: "compact",
        nextBand: "compact",
        sidebarCollapsed: false,
        expandedBeforeResponsiveCollapse: true,
      }),
    ).toEqual({
      nextCollapsed: null,
      expandedBeforeResponsiveCollapse: true,
    });
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
    gatewayStatus: { ok: true },
    activeApiStatus: { ok: true },
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

function agentFixture(): IrisCoreAgent {
  return {
    id: "agent_1",
    runtimeId: "default",
    runtimeKind: "hermes",
    displayName: "default",
    runtimeProfile: "default",
    isDefault: true,
  };
}

function sessionFixture(overrides: Partial<HermesSession> = {}): HermesSession {
  return {
    id: "session_1",
    source: "iris-core",
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
