import { describe, expect, it } from "vitest";
import {
  sessionProjectId,
  isProjectSession,
  mergeProjectSessionsForSidebar,
} from "../projectSessions";
import type { HermesSession } from "../../types/hermes";

function session(overrides: Partial<HermesSession> = {}): HermesSession {
  return {
    id: "session_1",
    source: "agentui-core",
    model: "",
    title: "Project chat",
    preview: "",
    chatId: "core-chat-1",
    origin: {},
    startedAt: 1,
    endedAt: null,
    lastActiveAt: 1,
    messageCount: 1,
    ...overrides,
  };
}

describe("project session classification", () => {
  it("treats local project metadata as projected before project lists refresh", () => {
    const item = session({ metadata: { projectId: "project_1" } });

    expect(sessionProjectId(item)).toBe("project_1");
    expect(isProjectSession(item, new Set())).toBe(true);
  });

  it("treats project-list membership as projected even without metadata", () => {
    const item = session();

    expect(isProjectSession(item, new Set(["session_1"]))).toBe(true);
  });

  it("adds local project chats to the project sidebar before project lists refresh", () => {
    const activeProjectChat = session({
      id: "optimistic-1",
      title: "Streaming project chat",
      lastActiveAt: 10,
      metadata: { projectId: "project_1" },
    });

    const merged = mergeProjectSessionsForSidebar(
      ["project_1"],
      {
        project_1: [
          session({ id: "session_old", chatId: "old-chat", title: "Older chat", lastActiveAt: 1 }),
        ],
      },
      [activeProjectChat],
    );

    expect(merged.project_1.map((item) => item.id)).toEqual(["optimistic-1", "session_old"]);
  });

  it("uses the local project chat row when it matches an endpoint row", () => {
    const endpointChat = session({
      id: "session_1",
      title: "Endpoint title",
      metadata: {},
    });
    const localChat = session({
      id: "session_1",
      title: "Local streaming title",
      metadata: { projectId: "project_1" },
    });

    const merged = mergeProjectSessionsForSidebar(
      ["project_1"],
      { project_1: [endpointChat] },
      [localChat],
    );

    expect(merged.project_1).toEqual([localChat]);
  });
});
