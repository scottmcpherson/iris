import { describe, expect, it } from "vitest";
import type { IrisCoreSession, IrisProject } from "@iris/core-client";
import {
  buildMobileSidebarModel,
  loadMobileSidebarCollapsedSections,
  loadMobileSidebarCollapsedProjects,
  loadMobileSidebarPinnedSessions,
  MOBILE_SIDEBAR_COLLAPSED_PROJECTS_STORAGE_KEY,
  MOBILE_SIDEBAR_COLLAPSED_SECTIONS_STORAGE_KEY,
  MOBILE_SIDEBAR_PINNED_STORAGE_KEY,
  projectSessionPinKey,
  saveMobileSidebarCollapsedSections,
  saveMobileSidebarCollapsedProjects,
  unprojectedSessionPinKey,
} from "../components/mobileSidebarModel";

function project(overrides: Partial<IrisProject> = {}): IrisProject {
  return {
    archivedAt: null,
    createdAt: 1,
    defaultAgentId: "agent_default",
    id: "project_alpha",
    metadata: {},
    name: "Alpha",
    slug: "alpha",
    systemPrompt: "",
    updatedAt: 1,
    ...overrides,
  };
}

function session(overrides: Partial<IrisCoreSession> = {}): IrisCoreSession {
  return {
    agentId: "agent_default",
    createdAt: 1,
    externalChatId: "",
    externalSessionId: "",
    id: "session_loose",
    metadata: {},
    origin: {},
    readState: undefined,
    runtimeId: "runtime_default",
    runtimeProfile: "default",
    summary: "",
    title: "Loose",
    updatedAt: 1,
    ...overrides,
  };
}

describe("mobile sidebar model", () => {
  it("orders the mobile sidebar as new chat, pinned, projects, then unprojected sessions", () => {
    const alpha = project({ id: "project_alpha", name: "Alpha" });
    const beta = project({ id: "project_beta", name: "Beta" });
    const pinnedProject = session({
      id: "session_project_pinned",
      metadata: { projectId: alpha.id },
      title: "Pinned project",
      updatedAt: 40,
    });
    const projectSession = session({
      id: "session_project",
      metadata: { projectId: alpha.id },
      title: "Project session",
      updatedAt: 30,
    });
    const pinnedLoose = session({
      id: "session_loose_pinned",
      title: "Pinned loose",
      updatedAt: 50,
    });
    const loose = session({
      id: "session_loose",
      title: "Loose",
      updatedAt: 20,
    });

    const model = buildMobileSidebarModel({
      pinnedSessions: {
        [projectSessionPinKey(alpha.id, pinnedProject.id)]: true,
        [unprojectedSessionPinKey("default", pinnedLoose.id)]: true,
      },
      projects: [alpha, beta],
      sessions: [loose, pinnedLoose, projectSession],
      sessionsByProject: {
        [alpha.id]: [pinnedProject],
      },
    });

    expect(model.pinnedSessions.map((item) => item.session.title)).toEqual([
      "Pinned loose",
      "Pinned project",
    ]);
    expect(model.projectNodes.map((node) => node.project.name)).toEqual(["Alpha", "Beta"]);
    expect(model.projectNodes[0].sessions.map((item) => item.title)).toEqual(["Project session"]);
    expect(model.projectNodes[1].sessions).toEqual([]);
    expect(model.unprojectedSessions.map((item) => item.title)).toEqual(["Loose"]);
  });

  it("loads desktop-compatible pinned session keys when browser storage is available", () => {
    const storage = {
      getItem: (key: string) =>
        key === MOBILE_SIDEBAR_PINNED_STORAGE_KEY
          ? JSON.stringify({ "agent:default:session_1": true, malformed: true, "chat:default:session_2": false })
          : null,
    };

    expect(loadMobileSidebarPinnedSessions(storage)).toEqual({
      "agent:default:session_1": true,
      "chat:default:session_2": false,
    });
  });

  it("loads and saves desktop-compatible collapsed project state", () => {
    let storageValue = JSON.stringify({ project_alpha: true, project_beta: false });
    const storage = {
      getItem(key: string) {
        return key === MOBILE_SIDEBAR_COLLAPSED_PROJECTS_STORAGE_KEY ? storageValue : null;
      },
      setItem(key: string, newValue: string) {
        if (key === MOBILE_SIDEBAR_COLLAPSED_PROJECTS_STORAGE_KEY) {
          storageValue = newValue;
        }
      },
    };

    expect(loadMobileSidebarCollapsedProjects(storage)).toEqual({
      project_alpha: true,
      project_beta: false,
    });

    saveMobileSidebarCollapsedProjects({ project_alpha: false, project_gamma: true }, storage);

    expect(JSON.parse(storageValue)).toEqual({
      project_alpha: false,
      project_gamma: true,
    });
  });

  it("loads and saves desktop-compatible collapsed top-level sections", () => {
    let storageValue = JSON.stringify({ pinned: true, projects: false, chats: true, agents: true });
    const storage = {
      getItem(key: string) {
        return key === MOBILE_SIDEBAR_COLLAPSED_SECTIONS_STORAGE_KEY ? storageValue : null;
      },
      setItem(key: string, newValue: string) {
        if (key === MOBILE_SIDEBAR_COLLAPSED_SECTIONS_STORAGE_KEY) {
          storageValue = newValue;
        }
      },
    };

    expect(loadMobileSidebarCollapsedSections(storage)).toEqual({
      pinned: true,
      projects: false,
      chats: true,
      agents: true,
    });

    saveMobileSidebarCollapsedSections({ pinned: false, projects: true, chats: false, agents: true }, storage);

    expect(JSON.parse(storageValue)).toEqual({
      pinned: false,
      projects: true,
      chats: false,
      agents: true,
    });
  });

  it("keeps collapsed state in memory when browser storage is unavailable", () => {
    saveMobileSidebarCollapsedProjects({ project_native: true });
    expect(loadMobileSidebarCollapsedProjects()).toEqual({
      project_native: true,
    });

    saveMobileSidebarCollapsedSections({ pinned: false, projects: true, chats: true, agents: false });
    expect(loadMobileSidebarCollapsedSections()).toEqual({
      pinned: false,
      projects: true,
      chats: true,
      agents: false,
    });
  });
});
